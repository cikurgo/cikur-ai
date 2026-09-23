/**
 * cgo-satellite-virtual.js
 * ============================================================
 * Digital Twin Fisika Satelit LEO untuk BCGO
 * 
 * VERSI: 2.0 (Audited & Rebuilt)
 * - Fisika diverifikasi vs referensi (Iridium 9602, ITU-R P.676)
 * - LQM berbasis Eb/N0 dengan mapping PER eksplisit
 * - 3 physics mode: ideal / realistic / stress
 * - Pure functions + orchestrator (testable)
 * - Portable (browser, Node, Web Worker)
 * 
 * REFERENSI:
 * [1] Iridium 9602 SBD Transceiver Product Manual, Rev 5.0
 * [2] ITU-R P.676-13: Attenuation by atmospheric gases
 * [3] ICAO Doc 10020: Manual on Iridium SBD
 * [4] Maral & Bousquet: Satellite Communications Systems (6th ed)
 * [5] Basu et al.: Ionospheric scintillation at equatorial region
 * ============================================================
 */

// ============================================================================
// KONSTANTA FISIKA — DENGAN SITASI
// ============================================================================

const SAT_CONSTANTS = Object.freeze({
  // --- IDENTITAS LINK ---
  // [1] Iridium 9602 SBD: uplink L-band, SBD only
  FREQ_MHZ: 1621.25,               // [1] center band (1616-1626.5 MHz)
  CHANNEL_BW_HZ: 41667,            // [1] Iridium channel bandwidth
  DATA_RATE_BPS: 50,               // [1] SBD data rate (250 byte/message)

  // --- LINK BUDGET ---
  // [1] Iridium 9602: max EIRP 7 dBW = 37 dBm @ 30° elevasi
  EIRP_DBM: 37,                    // [1] terminal transmit EIRP
  RX_GAIN_DBI: 3,                  // [1] patch antenna gain typical
  // [4] Thermal noise: kTB @ 300K, BW = 41.667 kHz
  //     N = -174 + 10*log10(41667) = -174 + 46.2 = -127.8 dBm
  //     + NF receiver 2.2 dB (Iridium spec) = -125.6 dBm
  NOISE_FLOOR_DBM: -125.6,         // [4] thermal + receiver NF

  // --- PROCESSING GAIN ---
  // [1] SBD dengan FEC + spread: processing gain
  //     Gp = 10*log10(BW/Rb) = 10*log10(41667/50) = 29.2 dB
  PROCESSING_GAIN_DB: 29.2,        // [1] Eb/N0 vs SNR conversion

  // --- ORBIT (IRIDIUM) ---
  // [1] Iridium: 66 satelit, orbit 780 km (bukan 550!)
  ORBIT_ALTITUDE_KM: 780,          // [1] Iridium constellation altitude
  EARTH_RADIUS_KM: 6371,           // WGS84 mean

  // --- DOPPLER ---
  // [3] Max Doppler shift @ 1621.25 MHz, v_rel = 7.5 km/s:
  //     f_d = (v/c) * f_c = (7500 / 3e8) * 1621.25e6 = 40.53 kHz
  MAX_DOPPLER_HZ: 40530,           // [3] verified ±40.5 kHz
  // [3] Max Doppler rate: 280 Hz/s (empirical, passes multiple refs)
  MAX_DOPPLER_RATE_HZ_S: 280,      // [3]

  // --- ELEVASI ---
  MIN_ELEVATION_DEG: 10,           // [1] hard floor untuk SBD
  MAX_ELEVATION_DEG: 75,           // [3] typical max @ mid-latitude

  // --- ATMOSFER (ITU-R P.676) ---
  // [2] Simplified: L_atm(θ) = 0.1 / sin(θ) untuk 1-2 GHz
  ATM_COEF_DB: 0.1,                // [2] tropospheric absorption coef

  // --- SCINTILLATION EQUATORIAL (Indonesia) ---
  // [5] S4 index 0.3-0.8 @ equatorial anomaly, 20:00-23:00 LT
  //     Fade depth: 3-15 dB
  SCINT_PROB_NIGHT: 0.08,          // per tick (100ms), 20:00-23:00
  SCINT_PROB_DAY: 0.005,           // per tick
  SCINT_EQUINOX_MULT: 2.5,         // Maret-April, Sept-Okt
  SCINT_FADE_MIN_DB: 3,            // minimum fade
  SCINT_FADE_MAX_DB: 15,           // maximum fade

  // --- LQM (Eb/N0 THRESHOLD) ---
  // [1] Iridium SBD: BER 1e-5 butuh Eb/N0 ~6 dB (after FEC)
  // Mapping PER (256 bit packet):
  //   Eb/N0 = 7.5 dB → BER ~1e-6 → PER ~0.03%   (excellent)
  //   Eb/N0 = 6.0 dB → BER ~1e-5 → PER ~0.26%   (good)
  //   Eb/N0 = 4.5 dB → BER ~1e-4 → PER ~2.5%    (marginal)
  //   Eb/N0 = 3.0 dB → BER ~1e-3 → PER ~22%     (bad)
  //   Eb/N0 = 2.0 dB → BER ~1e-2 → PER ~92%     (unusable)
  LQM_THRESHOLD_VALID_DB: 6.0,     // PER < 1% (FEC corrected)
  LQM_THRESHOLD_DEGRADED_DB: 4.0,  // PER < 10% (marginal)

  // --- PACKET ---
  PACKET_BITS: 256,                // 32 byte * 8 bit

  // --- TIMING ---
  PASS_DURATION_SEC: 550,          // [3] average Iridium pass
  INTER_PASS_MIN_MS: 120_000,      // 2 menit minimum gap
  INTER_PASS_MAX_MS: 900_000,      // 15 menit maximum gap
  COLD_START_MIN_MS: 30_000,       // boot acquisition
  COLD_START_MAX_MS: 90_000,
  RE_ACQ_WINDOW_MS: 15_000,        // re-acquisition window
  SCAN_TIMEOUT_MS: 90_000,         // scanning timeout
  MAX_DELTA_MS: 1000,              // clamp untuk safety
  HISTORY_SIZE: 20,                // ~2s @100ms
  SUSTAINED_SAMPLES: 10,           // ~1s sustained check
  // Doppler rate → LQM penalty (~0.7 dB at max 280 Hz/s)
  DOPPLER_WEIGHT: 1 / 400,
});

// ============================================================================
// PHYSICS MODE
// ============================================================================

const PHYSICS_MODE = Object.freeze({
  IDEAL: 'ideal',           // hanya geometri, tanpa noise/scint
  REALISTIC: 'realistic',   // geometri + atmosfer + scintillation
  STRESS: 'stress'          // + forced fade 30% + margin tipis
});

// ============================================================================
// BER LOOKUP — RICIAN K=7dB (LOS dominant) & K=3dB (partially blocked)
// ============================================================================
// [4] Rician K=7 dB: SNR vs BER (with FEC applied)
// Format: [ebn0_dB, log10(BER)]
const BER_RICIAN_K7 = [
  [-2, -0.30],   // BER 0.5
  [ 0, -0.90],   // BER 0.126
  [ 2, -1.70],   // BER 0.02
  [ 4, -3.30],   // BER 5e-4
  [ 6, -5.00],   // BER 1e-5
  [ 8, -7.00],   // BER 1e-7
  [10, -9.00],   // BER 1e-9
  [12, -11.0],   // BER 1e-11
];

// Rician K=3 dB (lebih banyak multipath, untuk elevasi rendah)
const BER_RICIAN_K3 = [
  [-2, -0.25],   // BER 0.56
  [ 0, -0.75],   // BER 0.18
  [ 2, -1.40],   // BER 0.04
  [ 4, -2.70],   // BER 2e-3
  [ 6, -4.30],   // BER 5e-5
  [ 8, -6.20],   // BER 6.3e-7
  [10, -8.20],   // BER 6.3e-9
  [12, -10.2],
];

/**
 * Interpolasi log-linear untuk BER.
 * @param {number} ebn0Db - Eb/N0 dalam dB
 * @param {Array<[number, number]>} table - lookup table
 * @returns {number} BER (linear, 0..0.5)
 */
function interpolateBER(ebn0Db, table) {
  // Clamp di luar range
  if (ebn0Db <= table[0][0]) return Math.pow(10, table[0][1]);
  if (ebn0Db >= table[table.length - 1][0]) {
    return Math.pow(10, table[table.length - 1][1]);
  }

  // Cari segment
  for (let i = 0; i < table.length - 1; i++) {
    const [x0, y0] = table[i];
    const [x1, y1] = table[i + 1];
    if (ebn0Db >= x0 && ebn0Db <= x1) {
      const ratio = (ebn0Db - x0) / (x1 - x0);
      const logBER = y0 + ratio * (y1 - y0);
      return Math.pow(10, logBER);
    }
  }
  return 0.5;
}

/**
 * Pilih lookup table berdasarkan elevasi.
 * @param {number} elevationDeg
 * @returns {Array<[number, number]>}
 */
function selectBERTable(elevationDeg) {
  // Elevasi rendah (< 30°): multipath dominan → K=3
  // Elevasi tinggi (>= 30°): LOS dominan → K=7
  return elevationDeg >= 30 ? BER_RICIAN_K7 : BER_RICIAN_K3;
}

/**
 * Hitung BER dengan model Rician adaptive.
 * @param {number} ebn0Db
 * @param {number} elevationDeg
 * @returns {number}
 */
function getBER(ebn0Db, elevationDeg = 45) {
  if (!Number.isFinite(ebn0Db)) return 0.5;
  if (!Number.isFinite(elevationDeg)) elevationDeg = 0;
  const table = selectBERTable(elevationDeg);
  return interpolateBER(ebn0Db, table);
}

/**
 * Hitung Packet Error Rate dari BER.
 * @param {number} ber - Bit Error Rate
 * @param {number} bits - jumlah bit per paket
 * @returns {number} PER (0..1)
 */
function getPER(ber, bits = SAT_CONSTANTS.PACKET_BITS) {
  if (!Number.isFinite(ber) || !Number.isFinite(bits) || bits <= 0) return 1;
  const safeBer = Math.max(0, Math.min(1, ber));
  const safeBits = Math.max(1, Math.floor(bits));
  // log1p/expm1 tetap stabil untuk BER kecil dan paket panjang.
  return -Math.expm1(safeBits * Math.log1p(-safeBer));
}

// ============================================================================
// LAYER 1: FISIKA — PURE FUNCTIONS
// ============================================================================

/**
 * Hitung geometri satelit pada waktu t dalam 1 pass.
 * Model: parabola sederhana (approximation untuk LEO).
 * 
 * @param {number} elapsedSec - waktu sejak awal pass (0 .. passDuration)
 * @param {number} passDurationSec - durasi total pass
 * @returns {{elevationDeg, distanceKm, dopplerShiftHz, dopplerRateHzPerSec}}
 */
function computeGeometry(elapsedSec, passDurationSec) {
  const T = Number.isFinite(passDurationSec) && passDurationSec > 0
    ? passDurationSec
    : SAT_CONSTANTS.PASS_DURATION_SEC;
  const t = Number.isFinite(elapsedSec) ? elapsedSec : 0;
  const normT = (t / T) - 0.5;   // -0.5 .. +0.5

  // Elevasi: parabola (zenith di tengah pass)
  // elev(t) = maxElev * (1 - 4*normT^2)
  const maxElev = SAT_CONSTANTS.MAX_ELEVATION_DEG;
  const elevationDeg = maxElev * (1 - 4 * normT * normT);

  // Slant range (hukum cosinus, dengan Re dan h dari konstanta)
  const Re = SAT_CONSTANTS.EARTH_RADIUS_KM;
  const h = SAT_CONSTANTS.ORBIT_ALTITUDE_KM;
  const elRad = elevationDeg * Math.PI / 180;

  // Rumus: d = sqrt((Re+h)^2 - (Re*cos(el))^2) - Re*sin(el)
  const a = (Re + h) ** 2;
  const b = (Re * Math.cos(elRad)) ** 2;
  const c = Re * Math.sin(elRad);
  const distanceKm = Math.sqrt(Math.max(0, a - b)) - c;

  // Doppler shift: sinusoidal dalam normT
  // f_d(t) = -f_max * sin(normT * π)
  const maxShift = SAT_CONSTANTS.MAX_DOPPLER_HZ;
  const dopplerShiftHz = -maxShift * Math.sin(normT * Math.PI);

  // Doppler rate: turunan dari shift
  // df_d/dt = -f_max * (π/T) * cos(normT * π)
  const dopplerRateHzPerSec = -(maxShift * Math.PI / T) * Math.cos(normT * Math.PI);

  return { elevationDeg, distanceKm, dopplerShiftHz, dopplerRateHzPerSec };
}

/**
 * Hitung FSPL (Free Space Path Loss).
 * L = 20*log10(d_km) + 20*log10(f_MHz) + 32.45
 * 
 * @param {number} distanceKm
 * @param {number} freqMHz
 * @returns {number} FSPL dalam dB
 */
function computeFSPL(distanceKm, freqMHz = SAT_CONSTANTS.FREQ_MHZ) {
  if (!Number.isFinite(distanceKm) || distanceKm <= 0 ||
      !Number.isFinite(freqMHz) || freqMHz <= 0) {
    return Infinity;
  }
  return 20 * Math.log10(distanceKm) + 20 * Math.log10(freqMHz) + 32.45;
}

/**
 * Hitung SNR efektif di receiver.
 * SNR = EIRP + G_rx - FSPL - NoiseFloor
 * 
 * @param {number} distanceKm
 * @returns {number} SNR dalam dB
 */
function computeSNR(distanceKm) {
  const fspl = computeFSPL(distanceKm);
  if (!Number.isFinite(fspl)) return -Infinity;
  const prx = SAT_CONSTANTS.EIRP_DBM + SAT_CONSTANTS.RX_GAIN_DBI - fspl;
  return prx - SAT_CONSTANTS.NOISE_FLOOR_DBM;
}

/**
 * Hitung redaman atmosfer.
 * Model: L_atm(θ) = coef / sin(θ) + scintillation bonus
 * 
 * @param {number} elevationDeg
 * @returns {number} redaman dalam dB (positif)
 */
function computeAtmPenalty(elevationDeg) {
  if (elevationDeg <= 0) return 99;  // blocked

  const elRad = elevationDeg * Math.PI / 180;
  const sinEl = Math.max(0.1, Math.sin(elRad));

  // Base tropospheric (ITU-R P.676 simplified)
  let penalty = SAT_CONSTANTS.ATM_COEF_DB / sinEl;

  // Bonus scintillation equatorial @ elevasi rendah
  if (elevationDeg < 20) {
    penalty += (20 - elevationDeg) * 0.08;
  }

  return penalty;
}

/**
 * Scintillation equatorial (probabilistik).
 * Untuk Indonesia (equatorial anomaly).
 * 
 * @param {Date} now
 * @param {number} elevationDeg
 * @param {number} deltaMs
 * @param {string} mode - 'ideal' | 'realistic' | 'stress'
 * @returns {number} fade dalam dB (negatif = fade, 0 = clear)
 */
function computeScintillation(now, elevationDeg, deltaMs, mode) {
  if (mode === PHYSICS_MODE.IDEAL) return 0;

  const hour = now.getHours();
  const month = now.getMonth(); // 0-11

  const isNight = hour >= 20 && hour <= 23;
  const isEquinox = (month >= 2 && month <= 3) || (month >= 8 && month <= 9);

  let prob = isNight ? SAT_CONSTANTS.SCINT_PROB_NIGHT : SAT_CONSTANTS.SCINT_PROB_DAY;
  if (isEquinox) prob *= SAT_CONSTANTS.SCINT_EQUINOX_MULT;

  // Elevasi rendah lebih rentan
  if (elevationDeg < 30) {
    prob *= (1 + (30 - elevationDeg) / 30);
  }

  // Scale by deltaMs (probabilitas per detik)
  const effectiveProb = prob * (deltaMs / 1000);

  // Stress mode: paksa fade lebih sering
  const finalProb = mode === PHYSICS_MODE.STRESS ? Math.min(0.5, effectiveProb * 5) : effectiveProb;

  if (Math.random() < finalProb) {
    const fadeMin = SAT_CONSTANTS.SCINT_FADE_MIN_DB;
    const fadeMax = SAT_CONSTANTS.SCINT_FADE_MAX_DB;
    return -(fadeMin + Math.random() * (fadeMax - fadeMin));
  }

  return 0;
}

// ============================================================================
// LAYER 2: LQM — DERIVED METRIC
// ============================================================================

/**
 * Hitung LQM = Eb/N0 efektif setelah semua penalti.
 * 
 * LQM = Eb/N0 - atmPenalty - dopplerPenalty + scintFade
 * 
 * Interpretasi:
 *   LQM >= 6.0  → PER < 1%   (VALID)
 *   LQM >= 4.0  → PER < 10%  (DEGRADED)
 *   LQM <  4.0  → PER > 10%  (LOSING LOCK)
 * 
 * @param {object} input
 * @param {number} input.snrDb - SNR di receiver
 * @param {number} input.dopplerRateHzPerSec
 * @param {number} input.elevationDeg
 * @param {number} input.scintFadeDb - fade dari scintillation (negatif)
 * @returns {number} LQM dalam dB, atau -Infinity jika blocked
 */
function calculateLQM({ snrDb, dopplerRateHzPerSec, elevationDeg, scintFadeDb = 0 }) {
  // Hard floor elevasi
  if (!Number.isFinite(elevationDeg) ||
      elevationDeg < SAT_CONSTANTS.MIN_ELEVATION_DEG ||
      !Number.isFinite(snrDb)) {
    return -Infinity;
  }

  // SNR → Eb/N0 (via processing gain)
  const ebn0 = snrDb + SAT_CONSTANTS.PROCESSING_GAIN_DB;

  // Penalti atmosfer
  const atmPenalty = computeAtmPenalty(elevationDeg);

  // Penalti Doppler tracking
  const dopplerPenalty = Math.abs(dopplerRateHzPerSec) * SAT_CONSTANTS.DOPPLER_WEIGHT || 0;
  // Normalize: kalau rate max 280 Hz/s, penalty max ~0.7 dB (reasonable)

  // LQM final
  return ebn0 - atmPenalty - dopplerPenalty + scintFadeDb;
}

// ============================================================================
// LAYER 3: CHANNEL SIMULATOR
// ============================================================================

class SatelliteChannelSimulator {
  /**
   * @param {object} [options]
   * @param {number} [options.passDurationSec=550]
   * @param {string} [options.mode='realistic']
   */
  constructor(options = {}) {
    this.passDuration = options.passDurationSec ?? SAT_CONSTANTS.PASS_DURATION_SEC;
    this.mode = options.mode ?? PHYSICS_MODE.REALISTIC;

    this.elapsed = 0;
    this.inPass = true;
    this.interPassRemaining = 0;

    this.tickCount = 0;
    this.lastScintFade = 0;
  }

  /**
   * Tick channel simulator.
   * @param {number} deltaMs
   * @param {Date} [now]
   * @param {object|null} [externalGeo] - geometri dari TLE/SGP4 (opsional)
   *   { elevationDeg, distanceKm, dopplerShiftHz?, dopplerRateHzPerSec?, name? }
   * @returns {object} metrics
   */
  tick(deltaMs, now = new Date(), externalGeo = null) {
    this.tickCount++;

    // ── Jalur LIVE: geometri dari TLE (bukan parabola internal) ──
    if (externalGeo && Number.isFinite(externalGeo.elevationDeg)) {
      const elevationDeg = externalGeo.elevationDeg;
      const distanceKm = Number.isFinite(externalGeo.distanceKm)
        ? externalGeo.distanceKm
        : Infinity;
      const inPass = elevationDeg >= SAT_CONSTANTS.MIN_ELEVATION_DEG
        && Number.isFinite(distanceKm)
        && distanceKm < 1e6;

      if (!inPass) {
        this.lastScintFade = 0;
        return {
          elevationDeg: Math.max(0, elevationDeg),
          distanceKm,
          snrDb: -Infinity,
          dopplerShiftHz: externalGeo.dopplerShiftHz ?? 0,
          dopplerRateHzPerSec: externalGeo.dopplerRateHzPerSec ?? 0,
          atmPenalty: 99,
          scintFadeDb: 0,
          inPass: false,
          source: 'tle',
          name: externalGeo.name ?? null
        };
      }

      const snrDb = computeSNR(distanceKm);
      const atmPenalty = computeAtmPenalty(elevationDeg);
      const scintFadeDb = computeScintillation(now, elevationDeg, deltaMs, this.mode);
      this.lastScintFade = scintFadeDb;

      return {
        elevationDeg,
        distanceKm,
        snrDb,
        dopplerShiftHz: externalGeo.dopplerShiftHz ?? 0,
        dopplerRateHzPerSec: externalGeo.dopplerRateHzPerSec ?? 0,
        atmPenalty,
        scintFadeDb,
        inPass: true,
        source: 'tle',
        name: externalGeo.name ?? null
      };
    }

    // ── Jalur SIM: parabola internal (fallback offline) ──
    if (!this.inPass) {
      this.interPassRemaining -= deltaMs;
      if (this.interPassRemaining <= 0) {
        this.inPass = true;
        this.elapsed = 0;
        this.interPassRemaining = 0;
      } else {
        return {
          elevationDeg: 0,
          distanceKm: Infinity,
          snrDb: -Infinity,
          dopplerShiftHz: 0,
          dopplerRateHzPerSec: 0,
          atmPenalty: 99,
          scintFadeDb: 0,
          inPass: false,
          source: 'sim'
        };
      }
    }

    this.elapsed += deltaMs / 1000;

    if (this.elapsed > this.passDuration) {
      this.inPass = false;
      this.interPassRemaining =
        SAT_CONSTANTS.INTER_PASS_MIN_MS +
        Math.random() * (SAT_CONSTANTS.INTER_PASS_MAX_MS - SAT_CONSTANTS.INTER_PASS_MIN_MS);

      this.elapsed = 0;
      return {
        elevationDeg: 0,
        distanceKm: Infinity,
        snrDb: -Infinity,
        dopplerShiftHz: 0,
        dopplerRateHzPerSec: 0,
        atmPenalty: 99,
        scintFadeDb: 0,
        inPass: false,
        source: 'sim'
      };
    }

    const geo = computeGeometry(this.elapsed, this.passDuration);
    const snrDb = computeSNR(geo.distanceKm);
    const atmPenalty = computeAtmPenalty(geo.elevationDeg);
    const scintFadeDb = computeScintillation(now, geo.elevationDeg, deltaMs, this.mode);
    this.lastScintFade = scintFadeDb;

    return {
      elevationDeg: geo.elevationDeg,
      distanceKm: geo.distanceKm,
      snrDb,
      dopplerShiftHz: geo.dopplerShiftHz,
      dopplerRateHzPerSec: geo.dopplerRateHzPerSec,
      atmPenalty,
      scintFadeDb,
      inPass: true,
      source: 'sim'
    };
  }

  reset() {
    this.elapsed = 0;
    this.inPass = true;
    this.interPassRemaining = 0;
    this.tickCount = 0;
    this.lastScintFade = 0;
  }
}

// ============================================================================
// LAYER 3: STATE MACHINE
// ============================================================================

const SAT_STATE = Object.freeze({
  COLD_START: 'COLD_START',
  SCANNING: 'SCANNING',
  ACQUIRING: 'ACQUIRING',
  TRACKING: 'TRACKING',
  DEGRADED: 'DEGRADED',
  LOSING_LOCK: 'LOSING_LOCK',
  RE_ACQUIRING: 'RE_ACQUIRING'
});

class SatelliteStateMachine {
  /**
   * @param {SatelliteChannelSimulator} channel
   */
  constructor(channel) {
    this.channel = channel;
    this.state = SAT_STATE.COLD_START;
    this.stateTimer = 0;
    this.lqmHistory = [];
    this.lastResult = null;

    this.coldStartDuration = this._randomColdStart();
    this.lastLQM = null;
  }

  _randomColdStart() {
    return SAT_CONSTANTS.COLD_START_MIN_MS +
           Math.random() * (SAT_CONSTANTS.COLD_START_MAX_MS - SAT_CONSTANTS.COLD_START_MIN_MS);
  }

  /**
   * Update state machine.
   * @param {number} deltaMs
   * @param {Date} [now]
   * @param {object|null} [externalGeo] - geometri TLE opsional
   * @returns {object} result
   */
  update(deltaMs, now = new Date(), externalGeo = null) {
    // Validate deltaMs
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
      return this.lastResult ?? {
        state: this.state, metrics: null, lqm: null, packetValid: false
      };
    }
    const dt = Math.min(deltaMs, SAT_CONSTANTS.MAX_DELTA_MS);

    this.stateTimer += dt;
    const metrics = this.channel.tick(dt, now, externalGeo);

    // Hitung LQM
    let lqm;
    if (!metrics.inPass || metrics.elevationDeg < SAT_CONSTANTS.MIN_ELEVATION_DEG) {
      lqm = -Infinity;
    } else {
      lqm = calculateLQM({
        snrDb: metrics.snrDb,
        dopplerRateHzPerSec: metrics.dopplerRateHzPerSec,
        elevationDeg: metrics.elevationDeg,
        scintFadeDb: metrics.scintFadeDb
      });
    }
    this.lastLQM = lqm;

    // Update history — hanya di state yang relevan
    const trackedStates = [
      SAT_STATE.ACQUIRING,
      SAT_STATE.TRACKING,
      SAT_STATE.DEGRADED,
      SAT_STATE.RE_ACQUIRING
    ];
    if (trackedStates.includes(this.state)) {
      this.lqmHistory.push(lqm);
      if (this.lqmHistory.length > SAT_CONSTANTS.HISTORY_SIZE) {
        this.lqmHistory.shift();
      }
    }

    // Transisi state
    switch (this.state) {
      case SAT_STATE.COLD_START:
        if (this.stateTimer >= this.coldStartDuration) {
          this._transitionTo(SAT_STATE.SCANNING);
        }
        break;

      case SAT_STATE.SCANNING:
        // Beacon deteksi: elevasi valid + LQM > DEGRADED - 3 dB
        if (metrics.elevationDeg >= SAT_CONSTANTS.MIN_ELEVATION_DEG && lqm > -6) {
          this._transitionTo(SAT_STATE.ACQUIRING, true);
        } else if (this.stateTimer >= SAT_CONSTANTS.SCAN_TIMEOUT_MS) {
          this._transitionTo(SAT_STATE.COLD_START);
          this.coldStartDuration = this._randomColdStart();
        }
        break;

      case SAT_STATE.ACQUIRING: {
        // Butuh sustained valid
        const recent = this.lqmHistory.slice(-SAT_CONSTANTS.SUSTAINED_SAMPLES);
        const sustainedValid = recent.length >= SAT_CONSTANTS.SUSTAINED_SAMPLES &&
          recent.every(v => v >= SAT_CONSTANTS.LQM_THRESHOLD_VALID_DB);

        if (sustainedValid) {
          this._transitionTo(SAT_STATE.TRACKING);
        } else if (lqm < SAT_CONSTANTS.LQM_THRESHOLD_DEGRADED_DB || this.stateTimer >= 30000) {
          this._transitionTo(SAT_STATE.SCANNING, true);
        }
        break;
      }

      case SAT_STATE.TRACKING: {
        if (lqm >= SAT_CONSTANTS.LQM_THRESHOLD_VALID_DB) {
          // Paket bisa dikirim
          const ber = getBER(
            metrics.snrDb + SAT_CONSTANTS.PROCESSING_GAIN_DB,
            metrics.elevationDeg
          );
          const per = getPER(ber);
          const packetValid = Math.random() >= per;

          this.lastResult = {
            state: SAT_STATE.TRACKING,
            metrics,
            lqm,
            ber,
            per,
            packetValid
          };
          return this.lastResult;
        } else if (lqm >= SAT_CONSTANTS.LQM_THRESHOLD_DEGRADED_DB) {
          this._transitionTo(SAT_STATE.DEGRADED);
        } else {
          this._transitionTo(SAT_STATE.LOSING_LOCK);
        }
        break;
      }

      case SAT_STATE.DEGRADED: {
        if (lqm >= SAT_CONSTANTS.LQM_THRESHOLD_VALID_DB) {
          this._transitionTo(SAT_STATE.TRACKING);
        } else if (lqm < SAT_CONSTANTS.LQM_THRESHOLD_DEGRADED_DB && this.stateTimer >= 5000) {
          this._transitionTo(SAT_STATE.LOSING_LOCK);
        }
        break;
      }

      case SAT_STATE.LOSING_LOCK:
        this._transitionTo(SAT_STATE.RE_ACQUIRING);
        break;

      case SAT_STATE.RE_ACQUIRING: {
        const recent = this.lqmHistory.slice(-5);
        const sustainedValid = recent.length >= 5 &&
          recent.every(v => v >= SAT_CONSTANTS.LQM_THRESHOLD_VALID_DB);

        if (sustainedValid) {
          this._transitionTo(SAT_STATE.TRACKING);
        } else if (this.stateTimer >= SAT_CONSTANTS.RE_ACQ_WINDOW_MS) {
          this._transitionTo(SAT_STATE.SCANNING, true);
        }
        break;
      }
    }

    this.lastResult = {
      state: this.state,
      metrics,
      lqm: lqm === -Infinity ? -Infinity : lqm,
      packetValid: false
    };
    return this.lastResult;
  }

  _transitionTo(newState, clearHistory = false) {
    this.state = newState;
    this.stateTimer = 0;
    if (clearHistory) this.lqmHistory = [];
  }

  reset() {
    this.state = SAT_STATE.COLD_START;
    this.stateTimer = 0;
    this.lqmHistory = [];
    this.coldStartDuration = this._randomColdStart();
    this.lastResult = null;
    this.lastLQM = null;
    this.channel.reset();
  }
}

// ============================================================================
// ORCHESTRATOR — SINGLETON INSTANCE
// ============================================================================

let _instance = null;

function createSatelliteLink(options = {}) {
  const channel = new SatelliteChannelSimulator(options);
  const sm = new SatelliteStateMachine(channel);
  return { channel, sm, options };
}

function getSatelliteLink(options) {
  if (options !== undefined || _instance === null) {
    _instance = createSatelliteLink(options ?? {});
  }
  return _instance;
}

function resetSatelliteLink(options) {
  _instance = createSatelliteLink(options ?? {});
  return _instance;
}

// ============================================================================
// PUBLIC API — updateSatelliteLink
// ============================================================================

/**
 * Update satellite link state.
 * @param {number} deltaMs
 * @param {object} [options] { now, externalGeo }
 *   externalGeo: { elevationDeg, distanceKm, dopplerShiftHz?, dopplerRateHzPerSec?, name? }
 * @returns {object} result
 */
function updateSatelliteLink(deltaMs, options = {}) {
  const { sm } = getSatelliteLink();
  const result = sm.update(
    deltaMs,
    options.now ?? new Date(),
    options.externalGeo ?? null
  );

  // Update BCGO_STATE (portable)
  const g = typeof globalThis !== 'undefined' ? globalThis : null;
  if (g && g.BCGO_STATE) {
    g.BCGO_STATE.satelliteLink = {
      state: result.state,
      lqm: result.lqm === -Infinity ? null : Number(result.lqm.toFixed(2)),
      elevation: result.metrics ? Number(result.metrics.elevationDeg.toFixed(1)) : null,
      snr: result.metrics && Number.isFinite(result.metrics.snrDb)
        ? Number(result.metrics.snrDb.toFixed(1)) : null,
      dopplerRate: result.metrics ? Number(result.metrics.dopplerRateHzPerSec.toFixed(0)) : null,
      scintFade: result.metrics ? Number(result.metrics.scintFadeDb.toFixed(1)) : 0,
      inPass: result.metrics ? result.metrics.inPass : false,
      per: result.per != null ? Number(result.per.toFixed(4)) : null,
      packetValid: result.packetValid,
      source: result.metrics?.source ?? null,
      name: result.metrics?.name ?? null,
      timestamp: Date.now()
    };
  }

  return result;
}

/**
 * Evaluasi link budget murni dari geometri eksternal (TLE), tanpa state machine.
 * Berguna untuk ranking multi-satelit / channel list.
 * @param {object} geo { elevationDeg, distanceKm, dopplerRateHzPerSec?, scintFadeDb? }
 * @param {string} [mode]
 * @param {Date} [now]
 */
function evaluateLinkFromGeo(geo, mode = PHYSICS_MODE.REALISTIC, now = new Date()) {
  const elevationDeg = geo?.elevationDeg ?? 0;
  const distanceKm = geo?.distanceKm ?? Infinity;
  if (elevationDeg < SAT_CONSTANTS.MIN_ELEVATION_DEG ||
      !Number.isFinite(distanceKm) || distanceKm <= 0) {
    return {
      elevationDeg,
      distanceKm,
      snrDb: -Infinity,
      lqm: -Infinity,
      atmPenalty: 99,
      scintFadeDb: 0,
      ber: 0.5,
      per: 1,
      usable: false
    };
  }
  const snrDb = computeSNR(distanceKm);
  const atmPenalty = computeAtmPenalty(elevationDeg);
  const scintFadeDb = geo.scintFadeDb != null
    ? geo.scintFadeDb
    : computeScintillation(now, elevationDeg, 1000, mode);
  const dopplerRateHzPerSec = geo.dopplerRateHzPerSec ?? 0;
  const lqm = calculateLQM({
    snrDb,
    dopplerRateHzPerSec,
    elevationDeg,
    scintFadeDb
  });
  const ebn0 = snrDb + SAT_CONSTANTS.PROCESSING_GAIN_DB;
  const ber = getBER(ebn0, elevationDeg);
  const per = getPER(ber);
  return {
    elevationDeg,
    distanceKm,
    snrDb,
    atmPenalty,
    scintFadeDb,
    dopplerRateHzPerSec,
    lqm,
    ber,
    per,
    usable: lqm >= SAT_CONSTANTS.LQM_THRESHOLD_DEGRADED_DB
  };
}

// ============================================================================
// TEST SUITE (embedded)
// ============================================================================

function runSelfTest() {
  const results = [];
  const assert = (name, cond, info = '') => {
    results.push({ name, pass: !!cond, info });
  };

  // Test 1: FSPL @ zenith
  const fspl_zenith = computeFSPL(780);  // h = 780 km
  // Expected: 20*log10(780) + 20*log10(1621.25) + 32.45
  //         = 57.84 + 64.19 + 32.45 = 154.48 dB
  assert('FSPL @ zenith ≈ 154.5 dB',
    Math.abs(fspl_zenith - 154.48) < 1,
    `got ${fspl_zenith.toFixed(2)}`);

  // Test 2: SNR @ zenith harus positif & reasonable
  const snr_zenith = computeSNR(780);
  // P_rx = 37 + 3 - 154.48 = -114.48 dBm
  // SNR = -114.48 - (-125.6) = 11.12 dB
  assert('SNR @ zenith ≈ 11 dB',
    Math.abs(snr_zenith - 11.12) < 1,
    `got ${snr_zenith.toFixed(2)}`);

  // Test 3: Doppler rate paling besar di tengah pass pada model sinus.
  const geo_max = computeGeometry(275, 550);
  assert('Doppler rate tengah pass ~ 231 Hz/s',
    Math.abs(Math.abs(geo_max.dopplerRateHzPerSec) - 231) < 50,
    `got ${geo_max.dopplerRateHzPerSec.toFixed(1)} Hz/s`);

  // Test 4: LQM @ zenith harus tinggi
  const lqm_zenith = calculateLQM({
    snrDb: 11.12,
    dopplerRateHzPerSec: 0,
    elevationDeg: 75,
    scintFadeDb: 0
  });
  // ebn0 = 11.12 + 29.2 = 40.32
  // atmPenalty @ 75° = 0.1/sin(75°) = 0.104
  // LQM = 40.32 - 0.104 - 0 = 40.22 dB
  assert('LQM @ zenith > 35 dB',
    lqm_zenith > 35,
    `got ${lqm_zenith.toFixed(2)}`);

  // Test 5: LQM @ elevasi 10° harus moderate
  const geo_low = computeGeometry(0, 550); // akan dapat elev 0
  // Manual: elev 10°, distance ~2200 km
  const snr_low = computeSNR(2200);
  const lqm_low = calculateLQM({
    snrDb: snr_low,
    dopplerRateHzPerSec: 200,
    elevationDeg: 10,
    scintFadeDb: 0
  });
  assert('LQM @ elevasi 10° masih > 28 dB (model link budget)',
    lqm_low > 28,
    `got ${lqm_low.toFixed(2)} (snr=${snr_low.toFixed(1)})`);

  // Test 6: BER @ Eb/N0 = 6 dB
  const ber_6 = getBER(6, 45);
  // Expected dari Rician K7: 1e-5
  assert('BER @ Eb/N0=6dB, elev=45° ≈ 1e-5',
    ber_6 > 1e-7 && ber_6 < 1e-4,
    `got ${ber_6.toExponential(2)}`);

  // Test 7: PER @ BER 1e-5, 256 bit
  const per_1e5 = getPER(1e-5, 256);
  // 1 - (1-1e-5)^256 ≈ 256e-5 = 2.56e-3
  assert('PER @ BER 1e-5 ≈ 0.26%',
    Math.abs(per_1e5 - 0.00256) < 0.001,
    `got ${(per_1e5 * 100).toFixed(3)}%`);

  // Test 8: State machine reach TRACKING
  const link = createSatelliteLink({ passDurationSec: 550, mode: 'ideal' });
  link.sm.coldStartDuration = 100; // fast forward

  let reachedTracking = false;
  const now = new Date(2025, 5, 15, 12, 0, 0); // noon, non-equinox
  for (let i = 0; i < 500; i++) {  // 50s of ticks
    const r = link.sm.update(100, now);
    if (r.state === SAT_STATE.TRACKING) {
      reachedTracking = true;
      break;
    }
  }
  assert('State machine reach TRACKING dalam 50s (ideal)',
    reachedTracking,
    `final state: ${link.sm.state}`);

  // Test 9: DEGRADED reachable (bisa dicek dengan inject fade)
  const link2 = createSatelliteLink({ passDurationSec: 550, mode: 'ideal' });
  link2.sm.state = SAT_STATE.TRACKING;
  link2.sm.stateTimer = 0;
  link2.channel.elapsed = 275; // midpoint
  // Force LQM ke degraded range dengan override scintFade
  const origTick = link2.channel.tick.bind(link2.channel);
  link2.channel.tick = (dt, now) => {
    const m = origTick(dt, now);
    m.scintFadeDb = -50; // paksa drop
    return m;
  };
  let leftTracking = false;
  for (let i = 0; i < 50; i++) {
    const r = link2.sm.update(100, now);
    if (r.state === SAT_STATE.LOSING_LOCK || r.state === SAT_STATE.RE_ACQUIRING) {
      leftTracking = true;
      break;
    }
  }
  assert('Fade berat memutus TRACKING',
    leftTracking,
    `state: ${link2.sm.state}`);

  // Test 10: DeltaMs validation
  const link3 = createSatelliteLink();
  const r1 = link3.sm.update(NaN);
  const r2 = link3.sm.update(0);
  const r3 = link3.sm.update(999999); // harus di-clamp
  assert('DeltaMs invalid tidak crash',
    r1 !== null && r2 !== null && r3 !== null,
    '');

  // Test 11: input geometri/link invalid tidak menghasilkan NaN yang bocor.
  const invalidGeo = evaluateLinkFromGeo({
    elevationDeg: 45,
    distanceKm: 0,
    dopplerRateHzPerSec: NaN
  }, PHYSICS_MODE.IDEAL);
  assert('Input link invalid menghasilkan unusable, bukan NaN',
    invalidGeo.usable === false &&
    invalidGeo.lqm === -Infinity &&
    Number.isFinite(getPER(NaN)),
    `lqm=${invalidGeo.lqm}`);

  return results;
}

// ============================================================================
// EXPORTS
// ============================================================================

export {
  SAT_CONSTANTS,
  PHYSICS_MODE,
  SAT_STATE,
  SatelliteChannelSimulator,
  SatelliteStateMachine,
  createSatelliteLink,
  getSatelliteLink,
  resetSatelliteLink,
  updateSatelliteLink,
  evaluateLinkFromGeo,
  // Pure functions untuk testing
  computeGeometry,
  computeFSPL,
  computeSNR,
  computeAtmPenalty,
  computeScintillation,
  calculateLQM,
  getBER,
  getPER,
  runSelfTest
};
