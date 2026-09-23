// FILE: cgo-satellite-live-tle.js | DEPS: global `satellite` (satellite.js) | EXPORTS: lihat bawah
//
// UNIFIED MULTI-CONSTELLATION TLE ENGINE
// Fallback chain (semua konstelasi):
//   (1) Live API Celestrak per grup orbit
//   (2) IndexedDB Local Cache (max age 4 jam)
//   (3) Embedded Backup TLE
//
// Wajib: validasi checksum NORAD TLE sebelum parsing.
// Jika data kosong/korup → BLOKIR rendering panel detail + 'ORBIT DATA CORRUPT - REFETCHING'
// Jangan pernah menghitung geometri dari null/NaN.
// Data Age Penalty eksponensial pada Link Budget jika cache >60 menit.

const PRIMARY_GROUPS = Object.freeze({
  starlink:   { group: 'starlink',    label: 'Starlink',   orbit: 'leo' },
  oneweb:     { group: 'oneweb',      label: 'OneWeb',     orbit: 'leo' },
  iridium:    { group: 'iridium-NEXT',label: 'Iridium',    orbit: 'leo' },
  gps:        { group: 'gps-ops',     label: 'GPS',        orbit: 'meo' },
  galileo:    { group: 'galileo',     label: 'Galileo',    orbit: 'meo' },
});

const CELESTRAK_BASE = 'https://celestrak.org/NORAD/elements/gp.php';
const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;   // 4 jam
const RETRY_INTERVAL_MS   = 5 * 60 * 1000;        // 5 menit
const FETCH_TIMEOUT_MS    = 15_000;
const CACHE_MAX_AGE_MS    = 4 * 60 * 60 * 1000;   // IndexedDB max age
const AGE_PENALTY_THRESHOLD_MS = 60 * 60 * 1000;  // >60 menit → exponential penalty

const DEFAULT_OBSERVER = Object.freeze({
  latitudeDeg: -6.2088,
  longitudeDeg: 106.8456,
  heightKm: 0.02
});

const IDB_NAME = 'cgo_tle_cache_v2';
const IDB_STORE = 'tle_groups';

// ─── Embedded minimal backup TLE (sample per constellation) ─────────────────
// Digunakan hanya jika network + IndexedDB gagal total.
const EMBEDDED_BACKUP = Object.freeze({
  iridium: [
    { name: 'IRIDIUM 100', line1: '1 24836U 97030A   26080.50000000  .00000100  00000-0  28000-4 0  9990', line2: '2 24836  86.4000 120.0000 0002000  90.0000 270.0000 14.34200000000000' },
    { name: 'IRIDIUM 102', line1: '1 24837U 97030B   26080.50000000  .00000100  00000-0  28000-4 0  9991', line2: '2 24837  86.4000 140.0000 0002000  90.0000 270.0000 14.34200000000001' },
  ],
  starlink: [
    { name: 'STARLINK-1000', line1: '1 44713U 19074A   26080.50000000  .00001200  00000-0  50000-4 0  9992', line2: '2 44713  53.0000 100.0000 0001500  80.0000 280.0000 15.12000000000002' },
  ],
  oneweb: [
    { name: 'ONEWEB-0001', line1: '1 44057U 19010A   26080.50000000  .00000200  00000-0  10000-4 0  9993', line2: '2 44057  87.9000  90.0000 0001800  85.0000 275.0000 13.10000000000003' },
  ],
  gps: [
    { name: 'GPS BIIR-2  (PRN 13)', line1: '1 24876U 97035A   26080.50000000  .00000040  00000-0  00000-0 0  9994', line2: '2 24876  55.0000 150.0000 0080000  60.0000 300.0000  2.00560000000004' },
  ],
  galileo: [
    { name: 'GSAT0101 (GALILEO)', line1: '1 37846U 11060A   26080.50000000  .00000020  00000-0  00000-0 0  9995', line2: '2 37846  56.0000 110.0000 0002000  50.0000 310.0000  1.70470000000005' },
  ],
});

function requireSatelliteLib() {
  if (typeof globalThis.satellite === 'undefined') {
    throw new Error(
      'satellite.js belum dimuat. Tambahkan <script src="https://cdn.jsdelivr.net/npm/satellite.js@6.0.0/dist/satellite.min.js"></script>.'
    );
  }
  return globalThis.satellite;
}

// ─── NORAD TLE Checksum (mod-10) ─────────────────────────────────────────────
function tleChecksum(line) {
  let sum = 0;
  for (let i = 0; i < 68; i++) {
    const c = line[i];
    if (c >= '0' && c <= '9') sum += c.charCodeAt(0) - 48;
    else if (c === '-') sum += 1;
  }
  return sum % 10;
}

function validateTLEChecksum(line1, line2) {
  if (!line1 || !line2 || line1.length < 69 || line2.length < 69) return false;
  if (!line1.startsWith('1 ') || !line2.startsWith('2 ')) return false;
  const c1 = parseInt(line1[68], 10);
  const c2 = parseInt(line2[68], 10);
  if (!Number.isInteger(c1) || !Number.isInteger(c2)) return false;
  return tleChecksum(line1) === c1 && tleChecksum(line2) === c2;
}

// ─── IndexedDB helpers ───────────────────────────────────────────────────────
function openIDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB tidak tersedia'));
      return;
    }
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: 'groupKey' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IDB open failed'));
  });
}

async function idbGet(groupKey) {
  try {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const store = tx.objectStore(IDB_STORE);
      const req = store.get(groupKey);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function idbPut(groupKey, satellites, fetchedAt) {
  try {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      store.put({ groupKey, satellites, fetchedAt });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    return false;
  }
}

// ─── Parse & validate ────────────────────────────────────────────────────────
function parseTLEText(text) {
  const lines = text.split('\n').map(l => l.trimEnd()).filter(l => l.trim().length > 0);
  const out = [];
  for (let i = 0; i + 2 < lines.length + 1; i += 3) {
    const name = lines[i]?.trim();
    const line1 = lines[i + 1];
    const line2 = lines[i + 2];
    if (!name || !line1 || !line2) continue;
    if (!line1.startsWith('1 ') || !line2.startsWith('2 ')) continue;
    if (!validateTLEChecksum(line1, line2)) continue; // checksum gagal → skip
    out.push({ name, line1, line2 });
  }
  return out;
}

/**
 * Data Age Penalty (eksponensial) untuk Link Budget.
 * ageMs > 60 menit → penalty = 2^((ageHours - 1) / 2) dB, capped 12 dB.
 */
function computeDataAgePenaltyDb(fetchedAt) {
  if (!fetchedAt || !Number.isFinite(fetchedAt)) return 12;
  const ageMs = Date.now() - fetchedAt;
  if (ageMs <= AGE_PENALTY_THRESHOLD_MS) return 0;
  const ageHours = ageMs / 3_600_000;
  const penalty = Math.pow(2, (ageHours - 1) / 2);
  return Math.min(12, Math.round(penalty * 10) / 10);
}

/**
 * Unified TLE Fallback Chain untuk satu grup.
 * @returns {Promise<{satellites, fetchedAt, source, agePenaltyDb, corrupt, statusMsg}>}
 */
async function fetchGroupTLE(constellId, opts = {}) {
  const { force = false } = opts;
  const meta = PRIMARY_GROUPS[constellId];
  if (!meta) throw new Error(`Konstelasi tidak dikenal: ${constellId}`);

  const groupKey = meta.group;
  let cached = await idbGet(groupKey);
  const cacheAge = cached ? Date.now() - cached.fetchedAt : Infinity;

  // (2) IndexedDB hit (fresh)
  if (!force && cached && Array.isArray(cached.satellites) && cached.satellites.length > 0
      && cacheAge < CACHE_MAX_AGE_MS) {
    const agePenaltyDb = computeDataAgePenaltyDb(cached.fetchedAt);
    return {
      satellites: cached.satellites,
      fetchedAt: cached.fetchedAt,
      source: 'indexeddb',
      agePenaltyDb,
      corrupt: false,
      statusMsg: null
    };
  }

  // (1) Live API
  const url = `${CELESTRAK_BASE}?GROUP=${groupKey}&FORMAT=tle`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    clearTimeout(timeoutId);
    if (!res.ok) throw new Error(`CelesTrak HTTP ${res.status}`);
    const text = await res.text();
    const satellites = parseTLEText(text);
    if (satellites.length === 0) throw new Error('CelesTrak balas kosong / checksum gagal semua');

    await idbPut(groupKey, satellites, Date.now());
    return {
      satellites,
      fetchedAt: Date.now(),
      source: 'network',
      agePenaltyDb: 0,
      corrupt: false,
      statusMsg: null
    };
  } catch (err) {
    clearTimeout(timeoutId);

    // Stale IndexedDB masih lebih baik daripada backup
    if (cached && Array.isArray(cached.satellites) && cached.satellites.length > 0) {
      return {
        satellites: cached.satellites,
        fetchedAt: cached.fetchedAt,
        source: 'stale-indexeddb',
        agePenaltyDb: computeDataAgePenaltyDb(cached.fetchedAt),
        corrupt: false,
        statusMsg: null,
        error: err.message
      };
    }

    // (3) Embedded backup
    const backup = EMBEDDED_BACKUP[constellId];
    if (backup && backup.length > 0) {
      return {
        satellites: backup,
        fetchedAt: 0,
        source: 'embedded-backup',
        agePenaltyDb: 12,
        corrupt: false,
        statusMsg: 'USING EMBEDDED BACKUP — REFETCHING',
        error: err.message
      };
    }

    // Total failure → corrupt flag
    return {
      satellites: [],
      fetchedAt: null,
      source: 'none',
      agePenaltyDb: 12,
      corrupt: true,
      statusMsg: 'ORBIT DATA CORRUPT - REFETCHING',
      error: err.message
    };
  }
}

/**
 * Build satrecs. Skip corrupt; never feed null/NaN ke SGP4.
 */
function buildSatRecs(tleList) {
  const sat = requireSatelliteLib();
  const satrecs = [];
  const skipped = [];

  for (const { name, line1, line2 } of tleList) {
    if (!validateTLEChecksum(line1, line2)) {
      skipped.push({ name, reason: 'checksum invalid' });
      continue;
    }
    try {
      const satrec = sat.twoline2satrec(line1, line2);
      if (!satrec || satrec.error) {
        skipped.push({ name, reason: `satrec error ${satrec?.error ?? '?'}` });
        continue;
      }
      satrecs.push({ name, satrec });
    } catch (err) {
      skipped.push({ name, reason: err.message });
    }
  }
  return { satrecs, skipped };
}

function propagateOne(entry, date, observer) {
  const sat = requireSatelliteLib();
  const pv = sat.propagate(entry.satrec, date);
  if (!pv || !pv.position) return null;
  if (!Number.isFinite(pv.position.x) || !Number.isFinite(pv.position.y) || !Number.isFinite(pv.position.z)) {
    return null; // NaN guard
  }

  const gmst = sat.gstime(date);
  const geo = sat.eciToGeodetic(pv.position, gmst);

  const observerGd = {
    latitude: sat.degreesToRadians(observer.latitudeDeg),
    longitude: sat.degreesToRadians(observer.longitudeDeg),
    height: observer.heightKm
  };
  const positionEcf = sat.eciToEcf(pv.position, gmst);
  const look = sat.ecfToLookAngles(observerGd, positionEcf);

  const elDeg = sat.radiansToDegrees(look.elevation);
  const azDeg = sat.radiansToDegrees(look.azimuth);
  const rangeKm = look.rangeSat;

  // Guard NaN sebelum return
  if (!Number.isFinite(elDeg) || !Number.isFinite(azDeg) || !Number.isFinite(rangeKm)) return null;

  const speedKmS = pv.velocity
    ? Math.hypot(pv.velocity.x, pv.velocity.y, pv.velocity.z)
    : null;

  return {
    name: entry.name,
    latDeg: sat.degreesLat(geo.latitude),
    lonDeg: sat.degreesLong(geo.longitude),
    altKm: geo.height,
    azDeg,
    elDeg,
    rangeKm,
    speedKmS,
    aboveHorizon: elDeg > 0
  };
}

function propagateSnapshot(satrecs, date, observer = DEFAULT_OBSERVER) {
  const out = [];
  for (const entry of satrecs) {
    const r = propagateOne(entry, date, observer);
    if (r) out.push(r);
  }
  return out;
}

/**
 * LiveConstellation — multi-group aware.
 * opts.constellId: 'iridium' | 'starlink' | 'oneweb' | 'gps' | 'galileo'
 */
class LiveConstellation {
  constructor({
    constellId = 'iridium',
    observer = DEFAULT_OBSERVER,
    tickMs = 1000,
    onUpdate = null,
    onStatus = null
  } = {}) {
    this.constellId = constellId;
    this.observer = observer;
    this.tickMs = tickMs;
    this.onUpdate = onUpdate;
    this.onStatus = onStatus;

    this.satrecs = [];
    this.skipped = [];
    this.meta = {
      constellId,
      fetchedAt: null,
      source: null,
      satCount: 0,
      agePenaltyDb: 0,
      corrupt: false,
      statusMsg: null
    };

    this._tickTimer = null;
    this._refreshTimer = null;
    this._disposed = false;
  }

  _emitStatus(patch) {
    Object.assign(this.meta, patch);
    if (typeof this.onStatus === 'function') this.onStatus({ ...this.meta });
  }

  async _loadTLE(force = false) {
    try {
      const result = await fetchGroupTLE(this.constellId, { force });
      const { satellites, fetchedAt, source, agePenaltyDb, corrupt, statusMsg, error } = result;

      if (corrupt || satellites.length === 0) {
        this.satrecs = [];
        this.skipped = [];
        this._emitStatus({
          fetchedAt,
          source,
          satCount: 0,
          agePenaltyDb,
          corrupt: true,
          statusMsg: statusMsg || 'ORBIT DATA CORRUPT - REFETCHING',
          lastError: error ?? null
        });
        this._scheduleRefresh(RETRY_INTERVAL_MS);
        return;
      }

      const { satrecs, skipped } = buildSatRecs(satellites);
      this.satrecs = satrecs;
      this.skipped = skipped;

      this._emitStatus({
        fetchedAt,
        source,
        satCount: satrecs.length,
        skippedCount: skipped.length,
        agePenaltyDb,
        corrupt: false,
        statusMsg: statusMsg || null,
        lastError: error ?? null
      });

      const nextDelay = (source === 'stale-indexeddb' || source === 'embedded-backup')
        ? RETRY_INTERVAL_MS
        : REFRESH_INTERVAL_MS;
      this._scheduleRefresh(nextDelay);
    } catch (err) {
      this.satrecs = [];
      this._emitStatus({
        lastError: err.message,
        satCount: 0,
        corrupt: true,
        statusMsg: 'ORBIT DATA CORRUPT - REFETCHING'
      });
      this._scheduleRefresh(RETRY_INTERVAL_MS);
    }
  }

  _scheduleRefresh(delayMs) {
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
    if (this._disposed) return;
    this._refreshTimer = setTimeout(() => this._loadTLE(true), delayMs);
  }

  async start() {
    await this._loadTLE(false);
    if (this._tickTimer) clearInterval(this._tickTimer);
    this._tickTimer = setInterval(() => {
      if (this.meta.corrupt || this.satrecs.length === 0) {
        // Jangan hitung geometri dari data korup
        if (typeof this.onUpdate === 'function') {
          this.onUpdate([], { corrupt: true, statusMsg: this.meta.statusMsg });
        }
        return;
      }
      if (typeof this.onUpdate !== 'function') return;
      const snapshot = propagateSnapshot(this.satrecs, new Date(), this.observer);
      this.onUpdate(snapshot, {
        corrupt: false,
        agePenaltyDb: this.meta.agePenaltyDb,
        source: this.meta.source
      });
    }, this.tickMs);
  }

  getSnapshot(date = new Date()) {
    if (this.meta.corrupt || this.satrecs.length === 0) return [];
    return propagateSnapshot(this.satrecs, date, this.observer);
  }

  /** Ganti konstelasi runtime */
  async switchConstellation(constellId) {
    if (!PRIMARY_GROUPS[constellId]) throw new Error(`Unknown constellation: ${constellId}`);
    this.constellId = constellId;
    this.meta.constellId = constellId;
    await this._loadTLE(true);
  }

  stop() {
    if (this._tickTimer) { clearInterval(this._tickTimer); this._tickTimer = null; }
    if (this._refreshTimer) { clearTimeout(this._refreshTimer); this._refreshTimer = null; }
  }

  dispose() {
    this._disposed = true;
    this.stop();
    this.satrecs = [];
  }
}

/** Convenience: fetch satu grup tanpa class */
async function fetchLiveTLE(opts = {}) {
  const constellId = opts.constellId || opts.group || 'iridium';
  return fetchGroupTLE(constellId, opts);
}

export {
  PRIMARY_GROUPS,
  CELESTRAK_BASE,
  REFRESH_INTERVAL_MS,
  DEFAULT_OBSERVER,
  EMBEDDED_BACKUP,
  parseTLEText,
  validateTLEChecksum,
  tleChecksum,
  computeDataAgePenaltyDb,
  fetchLiveTLE,
  fetchGroupTLE,
  buildSatRecs,
  propagateSnapshot,
  LiveConstellation
};
