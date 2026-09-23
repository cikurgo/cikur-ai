/**
 * cgo-satellite-physical.js
 * ============================================================
 * Adaptive Geometric Engine + Physical Hardware Adapter
 *
 * 1) Constellation-Aware Dynamic Thresholding & Link Budget
 * 2) SGP4 Deep Space Perturbation helpers (step size by orbit)
 * 3) Antenna Gain Profile per konstelasi
 * 4) Hardware adapter (Web Serial Iridium SBD) — tetap ada
 *
 * EXPORTS: computeLinkBudget, CONSTELLATION_THRESHOLDS, ANTENNA_GAIN,
 *          getIntegrationStepMs, PhysicalSatelliteAdapter, ...
 * ============================================================
 */

const DEFAULT_BAUD_RATE = 19200;
const DEFAULT_TIMEOUT_MS = 30000;

// ─── Constellation-Aware Thresholds ──────────────────────────────────────────
const CONSTELLATION_THRESHOLDS = Object.freeze({
  starlink: {
    band: 'Ku/Ka',
    minElevationDeg: 10,
    rainFadeMarginDb: 3.5,
    freqGHz: 12.0,
    noiseFloorDbm: -110,
  },
  oneweb: {
    band: 'Ku/Ka',
    minElevationDeg: 10,
    rainFadeMarginDb: 3.0,
    freqGHz: 12.0,
    noiseFloorDbm: -110,
  },
  iridium: {
    band: 'L',
    minElevationDeg: 5,       // lebih toleran atmosfer
    rainFadeMarginDb: 0.5,
    freqGHz: 1.621,
    noiseFloorDbm: -125.6,
  },
  gps: {
    band: 'L1/L2',
    minElevationDeg: 7,       // multipath mitigation
    rainFadeMarginDb: 0,
    freqGHz: 1.575,
    noiseFloorDbm: -130,
  },
  galileo: {
    band: 'E1/E5',
    minElevationDeg: 7,
    rainFadeMarginDb: 0,
    freqGHz: 1.575,
    noiseFloorDbm: -130,
  },
});

// Antenna Gain Profile (gRx) per konstelasi — menghilangkan anomali SNR cross-band
const ANTENNA_GAIN = Object.freeze({
  starlink:  { gTxDbi: 5,  gRxDbi: 35 },  // user terminal phased array
  oneweb:    { gTxDbi: 5,  gRxDbi: 35 },
  iridium:   { gTxDbi: 3,  gRxDbi: 2  },  // patch antenna
  gps:       { gTxDbi: 0,  gRxDbi: 3  },  // passive patch
  galileo:   { gTxDbi: 0,  gRxDbi: 3  },
});

// EIRP tipikal (dBm)
const EIRP_DBM = Object.freeze({
  starlink:  40,
  oneweb:    38,
  iridium:   37,
  gps:       27,   // satellite side; user is receive-only
  galileo:   27,
});

/**
 * Integration step for SGP4 / numerical propagation.
 * LEO <600 km → 10 s; MEO/GNSS → 30 s.
 */
function getIntegrationStepMs(altKm) {
  if (!Number.isFinite(altKm)) return 30_000;
  return altKm < 600 ? 10_000 : 30_000;
}

/**
 * Free-space path loss (dB).
 * FSPL = 20*log10(d_km) + 20*log10(f_GHz) + 92.45
 */
function computeFSPL(rangeKm, freqGHz) {
  if (!Number.isFinite(rangeKm) || rangeKm <= 0 || !Number.isFinite(freqGHz) || freqGHz <= 0) {
    return Infinity;
  }
  return 20 * Math.log10(rangeKm) + 20 * Math.log10(freqGHz) + 92.45;
}

/**
 * Atmospheric / rain fade approximate (dB).
 * Simplified: L ≈ rainMargin / sin(elev) for elev > 0.
 */
function computeAtmosphericLoss(elevationDeg, rainFadeMarginDb) {
  if (!Number.isFinite(elevationDeg) || elevationDeg <= 0) return 99;
  const sinEl = Math.sin(elevationDeg * Math.PI / 180);
  if (sinEl < 0.01) return 99;
  return rainFadeMarginDb / sinEl;
}

/**
 * Constellation-Aware Dynamic Thresholding + Link Budget.
 *
 * @param {object} input
 * @param {string} input.constellId  - starlink|oneweb|iridium|gps|galileo
 * @param {number} input.elevationDeg
 * @param {number} input.rangeKm
 * @param {number} [input.agePenaltyDb=0]  - from TLE data age
 * @param {number} [input.extraLossDb=0]
 * @returns {object} link budget result with precision targets:
 *   elev ±0.1°, az ±0.5°, range ±50 m (caller must supply already-rounded geometry)
 */
function computeLinkBudget({
  constellId = 'iridium',
  elevationDeg,
  rangeKm,
  agePenaltyDb = 0,
  extraLossDb = 0
} = {}) {
  const th = CONSTELLATION_THRESHOLDS[constellId] || CONSTELLATION_THRESHOLDS.iridium;
  const gain = ANTENNA_GAIN[constellId] || ANTENNA_GAIN.iridium;
  const eirp = EIRP_DBM[constellId] ?? 37;

  // Guard NaN/null — jangan hitung geometri dari data rusak
  if (!Number.isFinite(elevationDeg) || !Number.isFinite(rangeKm) || rangeKm <= 0) {
    return {
      valid: false,
      reason: 'INVALID_GEOMETRY',
      elevationDeg: null,
      rangeKm: null,
      snrDb: -Infinity,
      linkMarginDb: -Infinity,
      aboveThreshold: false,
      minElevationDeg: th.minElevationDeg,
      band: th.band,
    };
  }

  const aboveThreshold = elevationDeg >= th.minElevationDeg;
  const fspl = computeFSPL(rangeKm, th.freqGHz);
  const atmLoss = computeAtmosphericLoss(elevationDeg, th.rainFadeMarginDb);
  const totalLoss = fspl + atmLoss + (Number.isFinite(agePenaltyDb) ? agePenaltyDb : 0) + extraLossDb;

  // Prx = EIRP + G_rx - FSPL - atm - age
  const prxDbm = eirp + gain.gRxDbi - totalLoss;
  const snrDb = prxDbm - th.noiseFloorDbm;
  const linkMarginDb = snrDb - 6; // target Eb/N0 ~6 dB for reliable link

  return {
    valid: true,
    reason: aboveThreshold ? (linkMarginDb > 0 ? 'OK' : 'LOW_MARGIN') : 'BELOW_MIN_ELEV',
    elevationDeg: Math.round(elevationDeg * 10) / 10,   // ±0.1°
    rangeKm: Math.round(rangeKm * 20) / 20,               // ~±50 m
    rangeM: Math.round(rangeKm * 1000),
    fsplDb: Math.round(fspl * 10) / 10,
    atmLossDb: Math.round(atmLoss * 10) / 10,
    agePenaltyDb: Math.round((agePenaltyDb || 0) * 10) / 10,
    totalLossDb: Math.round(totalLoss * 10) / 10,
    prxDbm: Math.round(prxDbm * 10) / 10,
    snrDb: Math.round(snrDb * 10) / 10,
    linkMarginDb: Math.round(linkMarginDb * 10) / 10,
    aboveThreshold,
    minElevationDeg: th.minElevationDeg,
    band: th.band,
    gRxDbi: gain.gRxDbi,
    eirpDbm: eirp,
    constellId,
  };
}

/**
 * Batch evaluate several satellites; returns only those above constellation threshold.
 */
function filterUsableSats(snapshot, constellId, agePenaltyDb = 0) {
  if (!Array.isArray(snapshot)) return [];
  const th = CONSTELLATION_THRESHOLDS[constellId] || CONSTELLATION_THRESHOLDS.iridium;
  return snapshot
    .filter(s => Number.isFinite(s.elDeg) && s.elDeg >= th.minElevationDeg)
    .map(s => ({
      ...s,
      link: computeLinkBudget({
        constellId,
        elevationDeg: s.elDeg,
        rangeKm: s.rangeKm,
        agePenaltyDb
      })
    }))
    .filter(s => s.link.valid && s.link.aboveThreshold)
    .sort((a, b) => b.link.snrDb - a.link.snrDb);
}

// ─── Hardware Adapter (unchanged core) ───────────────────────────────────────

function assertPacket(packet) {
  if (!(packet instanceof Uint8Array) || packet.byteLength !== 32) {
    throw new TypeError('[PhysicalSAT] packet harus Uint8Array 32-byte');
  }
}

function checksum16(bytes) {
  let sum = 0;
  for (const b of bytes) sum = (sum + b) & 0xFFFF;
  return sum;
}

function hexByte(v) {
  return v.toString(16).padStart(2, '0').toUpperCase();
}

class PhysicalSatelliteAdapter {
  constructor() { this.connected = false; }
  isConnected() { return this.connected === true; }
  async connect() { throw new Error('connect() belum diimplementasikan'); }
  async disconnect() { this.connected = false; }
  async sendPacket(_packet, _meta = {}) { throw new Error('sendPacket() belum diimplementasikan'); }
  async receivePacket() { return null; }
}

class IridiumSBDSerialAdapter extends PhysicalSatelliteAdapter {
  constructor(options = {}) {
    super();
    this.port = options.port || null;
    this.baudRate = options.baudRate ?? DEFAULT_BAUD_RATE;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.writer = null;
    this.reader = null;
    this._textBuffer = '';
    this.onStatus = options.onStatus || null;
  }

  async connect(port = this.port) {
    if (!port) {
      if (typeof navigator === 'undefined' || !navigator.serial) {
        throw new Error('[PhysicalSAT] Web Serial tidak tersedia pada runtime ini');
      }
      port = await navigator.serial.requestPort();
    }
    this.port = port;
    if (!this.port.readable && !this.port.writable) {
      await this.port.open({ baudRate: this.baudRate });
    }
    this.writer = this.port.writable?.getWriter?.() || null;
    this.connected = !!this.writer;
    this.onStatus?.({ connected: this.connected, adapter: 'iridium-sbd-serial' });
    return this.connected;
  }

  async disconnect() {
    try { await this.reader?.cancel?.(); } catch {}
    try { this.reader?.releaseLock?.(); } catch {}
    try { this.writer?.releaseLock?.(); } catch {}
    this.reader = null;
    this.writer = null;
    try { await this.port?.close?.(); } catch {}
    this.connected = false;
    this.onStatus?.({ connected: false, adapter: 'iridium-sbd-serial' });
  }

  async _write(bytes) {
    if (!this.writer) throw new Error('[PhysicalSAT] serial writer belum siap');
    await this.writer.write(bytes);
  }

  async _writeAscii(text) {
    await this._write(new TextEncoder().encode(text));
  }

  async _readUntil(predicate, timeoutMs = this.timeoutMs) {
    const decoder = new TextDecoder();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.port?.readable) throw new Error('[PhysicalSAT] serial readable tidak tersedia');
      if (!this.reader) this.reader = this.port.readable.getReader();
      const { value, done } = await Promise.race([
        this.reader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('SERIAL_TIMEOUT')), 1000))
      ]).catch(err => { if (err.message === 'SERIAL_TIMEOUT') return { value: undefined, done: false }; throw err; });
      if (done) break;
      if (value) {
        this._textBuffer += decoder.decode(value, { stream: true });
        const lines = this._textBuffer.split(/\r?\n/);
        this._textBuffer = lines.pop() || '';
        for (const line of lines) {
          const clean = line.trim();
          if (clean && predicate(clean)) return clean;
        }
      }
    }
    throw new Error('[PhysicalSAT] response timeout');
  }

  async _command(command, expected = /^(OK|READY|SBDIX)/) {
    await this._writeAscii(`${command}\r`);
    return this._readUntil(line => expected.test(line));
  }

  async sendPacket(packet, meta = {}) {
    assertPacket(packet);
    if (!this.isConnected()) throw new Error('[PhysicalSAT] modem belum connected');

    await this._writeAscii(`AT+SBDWB=${packet.byteLength}\r`);
    await this._readUntil(line => line === 'READY');

    const frame = new Uint8Array(packet.byteLength + 2);
    frame.set(packet, 0);
    const sum = checksum16(packet);
    frame[packet.byteLength] = (sum >> 8) & 0xFF;
    frame[packet.byteLength + 1] = sum & 0xFF;
    await this._write(frame);

    await this._readUntil(line => /^0\s*$/.test(line) || /SBDWB/i.test(line));
    const session = await this._command('AT+SBDIX', /^\+SBDIX:/);

    this.onStatus?.({
      connected: true,
      state: 'PHYSICAL_SAT_TX',
      session,
      channel: meta.channel,
      emergency: meta.emergency === true
    });

    return { success: true, delivered: true, path: 'physical-sat', session };
  }

  async receivePacket() {
    if (!this.isConnected()) return null;
    await this._writeAscii('AT+SBDIX\r');
    const session = await this._readUntil(line => /^\+SBDIX:/.test(line));
    return { session, packet: null };
  }
}

let _physicalSatellite = null;
function getPhysicalSatellite() {
  if (!_physicalSatellite) _physicalSatellite = new PhysicalSatelliteAdapter();
  return _physicalSatellite;
}
function setPhysicalSatellite(adapter) {
  if (adapter != null && typeof adapter.sendPacket !== 'function') {
    throw new TypeError('[PhysicalSAT] adapter harus memiliki sendPacket()');
  }
  _physicalSatellite = adapter || new PhysicalSatelliteAdapter();
  return _physicalSatellite;
}

export {
  // Geometric engine
  CONSTELLATION_THRESHOLDS,
  ANTENNA_GAIN,
  EIRP_DBM,
  getIntegrationStepMs,
  computeFSPL,
  computeAtmosphericLoss,
  computeLinkBudget,
  filterUsableSats,
  // Hardware
  PhysicalSatelliteAdapter,
  IridiumSBDSerialAdapter,
  getPhysicalSatellite,
  setPhysicalSatellite,
  checksum16,
  hexByte
};
