// FILE: cgo-satellite-live-tle.js | DEPS: global `satellite` (satellite.js, via CDN script tag) | EXPORTS: lihat bawah
//
// Data ORBIT ASLI (bukan simulasi) untuk konstelasi Iridium NEXT, dari CelesTrak.
// Alurnya:
//   1) fetchLiveTLE()      -> ambil TLE (Two-Line Element) teks dari CelesTrak, dengan cache di localStorage
//   2) buildSatRecs()      -> parse TLE jadi "satrec" pakai satellite.js (twoline2satrec)
//   3) propagateSnapshot() -> hitung posisi tiap satelit pada waktu `now` pakai SGP4 (lat/lon/alt asli,
//                             plus azimuth/elevasi/jarak dari titik pengamat)
//   4) LiveConstellation   -> class pembungkus: pegang satrecs, auto-refresh TLE tiap beberapa jam,
//                             dan tick posisi tiap detik lewat callback onUpdate(snapshot)
//
// PENTING: modul ini butuh library satellite.js sudah dimuat (global `window.satellite`).
// Di cgo-satellite.html, ini dimuat lewat:
//   <script src="https://cdn.jsdelivr.net/npm/satellite.js@6.0.0/dist/satellite.min.js"></script>
// Kalau CDN itu berubah/404 di kemudian hari, ganti ke versi lain dari https://www.npmjs.com/package/satellite.js
// atau host sendiri file dist/satellite.min.js-nya di server sendiri (lebih aman untuk produksi).

const CELESTRAK_GROUP = 'iridium-NEXT'; // konstelasi Iridium asli sudah deorbit; ini yang aktif sekarang
const CELESTRAK_URL = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${CELESTRAK_GROUP}&FORMAT=tle`;

const CACHE_KEY = 'cgo_live_tle_iridium_next_v1';
const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;   // 4 jam — data orbit (TLE) baru berubah signifikan tiap beberapa jam
const RETRY_INTERVAL_MS = 5 * 60 * 1000;          // kalau fetch gagal, coba lagi 5 menit kemudian (bukan langsung 4 jam)
const FETCH_TIMEOUT_MS = 15_000;

// Titik pengamat default: Jakarta (konsisten dengan koordinat base yang sudah dipakai di ht-ptt-simulator.js)
const DEFAULT_OBSERVER = Object.freeze({
  latitudeDeg: -6.2088,
  longitudeDeg: 106.8456,
  heightKm: 0.02
});

function requireSatelliteLib() {
  if (typeof globalThis.satellite === 'undefined') {
    throw new Error(
      'satellite.js belum dimuat. Tambahkan <script src="https://cdn.jsdelivr.net/npm/satellite.js@6.0.0/dist/satellite.min.js"></script> sebelum modul ini dipakai.'
    );
  }
  return globalThis.satellite;
}

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.satellites) || !parsed.fetchedAt) return null;
    return parsed;
  } catch {
    return null; // localStorage tidak tersedia / data korup — anggap tidak ada cache
  }
}

function writeCache(satellites) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      satellites,
      fetchedAt: Date.now()
    }));
  } catch {
    // Gagal simpan cache (storage penuh/diblokir) — tidak fatal, cukup dilewati
  }
}

/**
 * Parse teks TLE mentah (format CelesTrak: nama, line1, line2 berulang) jadi array objek.
 * @param {string} text
 * @returns {Array<{name: string, line1: string, line2: string}>}
 */
function parseTLEText(text) {
  const lines = text.split('\n').map(l => l.trimEnd()).filter(l => l.trim().length > 0);
  const out = [];

  for (let i = 0; i + 2 < lines.length + 1; i += 3) {
    const name = lines[i]?.trim();
    const line1 = lines[i + 1];
    const line2 = lines[i + 2];
    if (!name || !line1 || !line2) continue;
    if (!line1.startsWith('1 ') || !line2.startsWith('2 ')) continue; // baris rusak/format tak sesuai — skip
    out.push({ name, line1, line2 });
  }

  return out;
}

/**
 * Ambil TLE dari CelesTrak, dengan cache localStorage.
 * @param {{force?: boolean}} opts
 * @returns {Promise<{satellites: Array, fetchedAt: number, source: 'network'|'cache'|'stale-cache'}>}
 */
async function fetchLiveTLE(opts = {}) {
  const { force = false } = opts;
  const cached = readCache();
  const cacheAge = cached ? Date.now() - cached.fetchedAt : Infinity;

  if (!force && cached && cacheAge < REFRESH_INTERVAL_MS) {
    return { satellites: cached.satellites, fetchedAt: cached.fetchedAt, source: 'cache' };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(CELESTRAK_URL, { signal: controller.signal, cache: 'no-store' });
    clearTimeout(timeoutId);

    if (!res.ok) throw new Error(`CelesTrak HTTP ${res.status}`);

    const text = await res.text();
    const satellites = parseTLEText(text);

    if (satellites.length === 0) throw new Error('CelesTrak balas kosong / format tak dikenali');

    writeCache(satellites);
    return { satellites, fetchedAt: Date.now(), source: 'network' };
  } catch (err) {
    clearTimeout(timeoutId);

    // Fetch gagal (offline, CORS, timeout, dll) — pakai cache lama kalau ada, daripada mati total
    if (cached) {
      return { satellites: cached.satellites, fetchedAt: cached.fetchedAt, source: 'stale-cache', error: err.message };
    }
    throw err;
  }
}

/**
 * Ubah daftar TLE jadi satrec (siap dipropagasi). Satelit dengan TLE korup dilewati satu-satu
 * (tidak menggagalkan seluruh batch) dan dilaporkan lewat `skipped`.
 * @param {Array<{name: string, line1: string, line2: string}>} tleList
 * @returns {{ satrecs: Array<{name: string, satrec: object}>, skipped: Array<{name: string, reason: string}> }}
 */
function buildSatRecs(tleList) {
  const sat = requireSatelliteLib();
  const satrecs = [];
  const skipped = [];

  for (const { name, line1, line2 } of tleList) {
    try {
      const satrec = sat.twoline2satrec(line1, line2);
      if (!satrec || satrec.error) {
        skipped.push({ name, reason: `satrec error code ${satrec?.error ?? '?'}` });
        continue;
      }
      satrecs.push({ name, satrec });
    } catch (err) {
      skipped.push({ name, reason: err.message });
    }
  }

  return { satrecs, skipped };
}

/**
 * Hitung posisi satu satelit pada waktu `date`: lat/lon/alt asli (geodetic) + az/el/jarak dari observer.
 * @param {{name: string, satrec: object}} entry
 * @param {Date} date
 * @param {{latitudeDeg:number, longitudeDeg:number, heightKm:number}} observer
 * @returns {object|null} null kalau propagasi gagal (misal satelit sudah decay)
 */
function propagateOne(entry, date, observer) {
  const sat = requireSatelliteLib();
  const pv = sat.propagate(entry.satrec, date);
  if (!pv || !pv.position) return null; // decayed / error — lihat entry.satrec.error kalau perlu diagnosa

  const gmst = sat.gstime(date);
  const geo = sat.eciToGeodetic(pv.position, gmst);

  const observerGd = {
    latitude: sat.degreesToRadians(observer.latitudeDeg),
    longitude: sat.degreesToRadians(observer.longitudeDeg),
    height: observer.heightKm
  };
  const positionEcf = sat.eciToEcf(pv.position, gmst);
  const look = sat.ecfToLookAngles(observerGd, positionEcf);

  const speedKmS = pv.velocity
    ? Math.hypot(pv.velocity.x, pv.velocity.y, pv.velocity.z)
    : null;

  return {
    name: entry.name,
    latDeg: sat.degreesLat(geo.latitude),
    lonDeg: sat.degreesLong(geo.longitude),
    altKm: geo.height,
    azDeg: sat.radiansToDegrees(look.azimuth),
    elDeg: sat.radiansToDegrees(look.elevation),
    rangeKm: look.rangeSat,
    speedKmS,
    aboveHorizon: look.elevation > 0
  };
}

/**
 * Propagasi seluruh konstelasi pada satu waktu `date`.
 * @param {Array<{name: string, satrec: object}>} satrecs
 * @param {Date} date
 * @param {object} [observer]
 * @returns {Array<object>} entri yang gagal dipropagasi otomatis dilewati
 */
function propagateSnapshot(satrecs, date, observer = DEFAULT_OBSERVER) {
  const out = [];
  for (const entry of satrecs) {
    const r = propagateOne(entry, date, observer);
    if (r) out.push(r);
  }
  return out;
}

/**
 * Pembungkus stateful: pegang satrecs, auto-refresh TLE, dan tick posisi berkala.
 * Pemakaian:
 *   const live = new LiveConstellation({ onUpdate: snap => draw(snap), onStatus: s => console.log(s) });
 *   await live.start();
 *   ...
 *   live.stop();
 */
class LiveConstellation {
  constructor({ observer = DEFAULT_OBSERVER, tickMs = 1000, onUpdate = null, onStatus = null } = {}) {
    this.observer = observer;
    this.tickMs = tickMs;
    this.onUpdate = onUpdate;
    this.onStatus = onStatus;

    this.satrecs = [];
    this.skipped = [];
    this.meta = { fetchedAt: null, source: null, satCount: 0 };

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
      const { satellites, fetchedAt, source, error } = await fetchLiveTLE({ force });
      const { satrecs, skipped } = buildSatRecs(satellites);

      this.satrecs = satrecs;
      this.skipped = skipped;
      this._emitStatus({
        fetchedAt,
        source,
        satCount: satrecs.length,
        skippedCount: skipped.length,
        lastError: error ?? null
      });

      // Jadwalkan refresh berikutnya: interval normal kalau sukses, lebih cepat kalau masih pakai cache basi
      const nextDelay = source === 'stale-cache' ? RETRY_INTERVAL_MS : REFRESH_INTERVAL_MS;
      this._scheduleRefresh(nextDelay);
    } catch (err) {
      this._emitStatus({ lastError: err.message, satCount: 0 });
      this._scheduleRefresh(RETRY_INTERVAL_MS); // gagal total (belum ada cache sama sekali) — coba lagi 5 menit lagi
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
      if (this.satrecs.length === 0 || typeof this.onUpdate !== 'function') return;
      const snapshot = propagateSnapshot(this.satrecs, new Date(), this.observer);
      this.onUpdate(snapshot);
    }, this.tickMs);
  }

  getSnapshot(date = new Date()) {
    return propagateSnapshot(this.satrecs, date, this.observer);
  }

  stop() {
    if (this._tickTimer) {
      clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
    }
  }

  dispose() {
    this._disposed = true;
    this.stop();
    this.satrecs = [];
  }
}

export {
  CELESTRAK_URL,
  REFRESH_INTERVAL_MS,
  DEFAULT_OBSERVER,
  parseTLEText,
  fetchLiveTLE,
  buildSatRecs,
  propagateSnapshot,
  LiveConstellation
};
