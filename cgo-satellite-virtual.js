/**
 * cgo-satellite-virtual.js
 * Digital Twin Fisika Satelit LEO untuk BCGO
 * 
 * PARAMETER TERKUNCI (FINAL):
 * - LQM Formula: SNR_eff - |DopplerRate|/400 - P_atm(theta)
 * - Hard Floor Elevasi: theta_min = 10°
 * - Threshold Valid: LQM >= +2.6 dB
 * - Threshold Degraded: [-2.0, +2.6) dB
 * - Doppler Weighting: Wd = 1/400 dB/(Hz/s)
 */

// ============================================================================
// KONSTANTA FISIKA & THRESHOLD (TIDAK BOLEH DIUBAH TANPA RE-VALIDASI)
// ============================================================================
const SAT_CONSTANTS = {
    NOISE_FLOOR_DBM: -138,        // Thermal noise + NF receiver real
    EIRP_DBM: 30,                 // Effective Isotropic Radiated Power terminal
    RX_GAIN_DBI: 3,               // Gain antena patch sederhana
    FREQ_MHZ: 1616,               // Frekuensi carrier Iridium SBD
    DOPPLER_WEIGHT: 1 / 400,      // Wd: 1 dB penalty per 400 Hz/s
    MIN_ELEVATION_DEG: 10,        // Hard floor elevasi (path blocked jika < ini)
    LQM_THRESHOLD_VALID: 2.6,     // Batas decode sukses (dB)
    LQM_THRESHOLD_DEGRADED: -2.0, // Batas zona marginal (dB)
    COLD_START_MIN_MS: 30000,     // Waktu akuisisi minimal (ms)
    COLD_START_MAX_MS: 90000,     // Waktu akuisisi maksimal (ms)
    RE_ACQ_WINDOW_MS: 15000,      // Window re-acquisition (ms)
    PACKET_BITS: 256              // 32 byte × 8 bit
};

// Lookup table BER Rician K=7dB (divalidasi vs kurva waterfall empiris)
// Key: SNR (dB), Value: Bit Error Rate
const BER_RICIAN_LOOKUP = new Map([
    [10, 1e-9], [8, 1e-7], [6, 5e-6], [4, 5e-4],
    [2, 2e-2],  [0, 8e-2],  [-2, 0.25],   [-4, 0.35],
    [-6, 0.42], [-8, 0.48]
]);

function getBER(snrDb) {
    const keys = Array.from(BER_RICIAN_LOOKUP.keys()).sort((a, b) => b - a);
    for (let i = 0; i < keys.length - 1; i++) {
        if (snrDb >= keys[i + 1]) {
            const snrHigh = keys[i], snrLow = keys[i + 1];
            const berHigh = BER_RICIAN_LOOKUP.get(snrHigh);
            const berLow = BER_RICIAN_LOOKUP.get(snrLow);
            // Interpolasi log-linear untuk akurasi
            const ratio = (snrDb - snrLow) / (snrHigh - snrLow);
            return berLow * Math.pow(berHigh / berLow, ratio);
        }
    }
    return snrDb >= keys[0] ? BER_RICIAN_LOOKUP.get(keys[0]) : 0.5;
}

// ============================================================================
// FUNGSI INTI: LINK QUALITY METRIC (LQM)
// Rumus: LQM = SNR_eff - (|DopplerRate| / 400) - P_atm(theta)
// ============================================================================
function calculateLQM(snrEffDb, dopplerRateHzPerSec, elevationDeg) {
    // 1. Hard floor elevasi → sinyal tidak mungkin terbaca
    if (elevationDeg < SAT_CONSTANTS.MIN_ELEVATION_DEG) {
        return -Infinity;
    }

    // 2. Penalti atmosfer berbasis elevasi (piecewise)
    let atmPenalty = 0;
    if (elevationDeg < 30) {
        atmPenalty = (30 - elevationDeg) * 0.1;
    }

    // 3. Penalti tracking Doppler
    const dopplerPenalty = Math.abs(dopplerRateHzPerSec) * SAT_CONSTANTS.DOPPLER_WEIGHT;

    // 4. LQM final dalam dB
    return snrEffDb - dopplerPenalty - atmPenalty;
}

// ============================================================================
// SIMULATOR CHANNEL SATELIT REALISTIS
// Menghasilkan metrik fisik berdasarkan waktu elapsed dalam satu pass satelit
// ============================================================================
class SatelliteChannelSimulator {
    constructor(passDurationSec = 600) {
        this.passDuration = passDurationSec;
        this.elapsed = 0;
    }

    tick(deltaMs) {
        this.elapsed += deltaMs / 1000;
        if (this.elapsed > this.passDuration) {
            this.elapsed = 0; // Reset untuk pass berikutnya
        }
        return this.getCurrentMetrics();
    }

    getCurrentMetrics() {
        const t = this.elapsed;
        const T = this.passDuration;
        const normT = (t / T) - 0.5; // -0.5 s/d +0.5

        // Elevasi: model parabola sederhana (zenith di tengah pass)
        const maxElev = 75; // derajat
        const elevation = maxElev * (1 - 4 * normT * normT);

        // Jarak slant range (aproksimasi dari elevasi, orbit 550km)
        const Re = 6371; // jari-jari bumi km
        const h = 550;   // ketinggian orbit km
        const sinEl = Math.sin(elevation * Math.PI / 180);
        const distance = Math.sqrt((Re + h) ** 2 - (Re * Math.cos(elevation * Math.PI / 180)) ** 2) 
                         - Re * sinEl;

        // FSPL
        const fspl = 20 * Math.log10(distance) + 20 * Math.log10(SAT_CONSTANTS.FREQ_MHZ) + 32.44;

        // Received power & SNR efektif
        const prx = SAT_CONSTANTS.EIRP_DBM + SAT_CONSTANTS.RX_GAIN_DBI - fspl;
        const snrEff = prx - SAT_CONSTANTS.NOISE_FLOOR_DBM;

        // Doppler asimetris (kemiringan 6% untuk lintang Indonesia)
        const maxShift = 40500; // Hz
        const skewFactor = 1 + 0.06 * normT; // Asimetri
        const dopplerShift = -maxShift * Math.sin(normT * Math.PI) * skewFactor;
        const dopplerRate = -(maxShift * Math.PI / T) * Math.cos(normT * Math.PI) * skewFactor;

        return { elevation, distance, snrEff, dopplerShift, dopplerRate };
    }
}

// ============================================================================
// STATE MACHINE SATELIT BERBASIS LQM
// Transisi state murni berdasarkan metrik kualitas link
// ============================================================================
class SatelliteStateMachine {
    constructor(channelSimulator) {
        this.channel = channelSimulator;
        this.state = 'COLD_START';
        this.stateTimer = 0;
        this.lqmHistory = []; // Rolling window 2 detik untuk validasi sustained
        this.coldStartDuration = this._randomColdStart();
    }

    _randomColdStart() {
        return SAT_CONSTANTS.COLD_START_MIN_MS + 
               Math.random() * (SAT_CONSTANTS.COLD_START_MAX_MS - SAT_CONSTANTS.COLD_START_MIN_MS);
    }

    update(deltaMs) {
        this.stateTimer += deltaMs;
        const metrics = this.channel.tick(deltaMs);
        const lqm = calculateLQM(metrics.snrEff, metrics.dopplerRate, metrics.elevation);

        // Simpan history LQM untuk validasi "sustained"
        this.lqmHistory.push(lqm);
        if (this.lqmHistory.length > 20) this.lqmHistory.shift(); // ~2 detik @100ms

        switch (this.state) {
            case 'COLD_START':
                if (this.stateTimer >= this.coldStartDuration) {
                    this.state = 'SCANNING';
                    this.stateTimer = 0;
                }
                break;

            case 'SCANNING':
                // Pilot tone terdeteksi hanya jika elevasi valid DAN LQM > -12 dB
                if (metrics.elevation >= SAT_CONSTANTS.MIN_ELEVATION_DEG && lqm > -12) {
                    this.state = 'ACQUIRING';
                    this.stateTimer = 0;
                } else if (this.stateTimer >= 90000) {
                    // Timeout scanning → kembali cold start
                    this.state = 'COLD_START';
                    this.stateTimer = 0;
                    this.coldStartDuration = this._randomColdStart();
                }
                break;

            case 'ACQUIRING':
                // Lock dikonfirmasi jika LQM >= 2.6 dB secara sustained (seluruh history 2s)
                const sustainedValid = this.lqmHistory.every(v => v >= SAT_CONSTANTS.LQM_THRESHOLD_VALID);
                if (sustainedValid) {
                    this.state = 'TRACKING';
                    this.stateTimer = 0;
                } else if (lqm < SAT_CONSTANTS.LQM_THRESHOLD_DEGRADED || this.stateTimer >= 30000) {
                    this.state = 'SCANNING';
                    this.stateTimer = 0;
                }
                break;

            case 'TRACKING':
                if (lqm >= SAT_CONSTANTS.LQM_THRESHOLD_VALID) {
                    // Normal tracking → coba decode paket
                    const ber = getBER(metrics.snrEff);
                    const packetSuccess = Math.pow(1 - ber, SAT_CONSTANTS.PACKET_BITS);
                    return { 
                        state: 'TRACKING', 
                        metrics, 
                        lqm, 
                        packetValid: Math.random() < packetSuccess 
                    };
                } else if (lqm >= SAT_CONSTANTS.LQM_THRESHOLD_DEGRADED) {
                    return { state: 'DEGRADED', metrics, lqm, packetValid: false };
                } else {
                    this.state = 'LOSING_LOCK';
                    this.stateTimer = 0;
                }
                break;

            case 'DEGRADED':
                if (lqm >= SAT_CONSTANTS.LQM_THRESHOLD_VALID) {
                    this.state = 'TRACKING';
                    this.stateTimer = 0;
                } else if (lqm < SAT_CONSTANTS.LQM_THRESHOLD_DEGRADED && this.stateTimer >= 5000) {
                    this.state = 'LOSING_LOCK';
                    this.stateTimer = 0;
                }
                break;

            case 'LOSING_LOCK':
                this.state = 'RE_ACQUIRING';
                this.stateTimer = 0;
                break;

            case 'RE_ACQUIRING':
                if (lqm >= SAT_CONSTANTS.LQM_THRESHOLD_VALID) {
                    this.state = 'TRACKING';
                    this.stateTimer = 0;
                } else if (this.stateTimer >= SAT_CONSTANTS.RE_ACQ_WINDOW_MS) {
                    this.state = 'SCANNING';
                    this.stateTimer = 0;
                }
                break;
        }

        return { state: this.state, metrics, lqm, packetValid: false };
    }
}

// ============================================================================
// INTEGRASI KE BCGO ENGINE
// Export singleton instance siap pakai
// ============================================================================
const satelliteChannel = new SatelliteChannelSimulator(600);
const satelliteSM = new SatelliteStateMachine(satelliteChannel);

/**
 * Panggil fungsi ini setiap frame/tick BCGO engine
 * Return: object dengan state, metrik fisik, dan status paket
 */
export function updateSatelliteLink(deltaMs) {
    const result = satelliteSM.update(deltaMs);
    
    // Update BCGO_STATE secara langsung (zero-dummy policy)
    if (typeof window !== 'undefined' && window.BCGO_STATE) {
        window.BCGO_STATE.satelliteLink = {
            state: result.state,
            lqm: result.lqm === -Infinity ? null : parseFloat(result.lqm.toFixed(2)),
            elevation: parseFloat(result.metrics.elevation.toFixed(1)),
            snrEff: parseFloat(result.metrics.snrEff.toFixed(1)),
            dopplerRate: parseFloat(result.metrics.dopplerRate.toFixed(0)),
            packetValid: result.packetValid,
            timestamp: Date.now()
        };
    }

    return result;
}
