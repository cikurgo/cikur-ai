// FILE: ht-ptt-simulator.js | DEPS: ht-protocol | EXPORTS: HTAgentSimulator, BEHAVIOR_PROFILES, createSimulator

import {
  encodeHTPacket,
  PACKET_SIZE,
  STATUS_FLAGS
} from './ht-protocol.js';

// ============================================================
// BEHAVIOR PROFILES
// ============================================================
// Setiap profil mendefinisikan:
//   checkInInterval : interval check-in rutin (ms)
//   gpsDrift        : apakah GPS agent bergerak acak
//   emergencyBurst  : interval burst saat emergency (ms, null = tidak)
//   statusChanged   : apakah agent bisa ubah status sendiri

const BEHAVIOR_PROFILES = Object.freeze({
  patrol: Object.freeze({
    checkInInterval: 30_000,
    gpsDrift: true,
    emergencyBurst: null,
    autoStatusChange: true,
    batteryDrainPerMin: 1.5,
    signalBase: 75,
    signalJitter: 20
  }),
  static: Object.freeze({
    checkInInterval: 60_000,
    gpsDrift: false,
    emergencyBurst: null,
    autoStatusChange: false,
    batteryDrainPerMin: 0.5,
    signalBase: 85,
    signalJitter: 10
  }),
  emergency: Object.freeze({
    checkInInterval: 5_000,
    gpsDrift: true,
    emergencyBurst: 5_000,
    autoStatusChange: false,
    batteryDrainPerMin: 5,
    signalBase: 60,
    signalJitter: 30
  })
});

// ============================================================
// KONSTANTA
// ============================================================

const TICK_INTERVAL = 100;          // ms
const SQUELCH_MIN = 50;             // ms
const SQUELCH_MAX = 200;            // ms
const CORRUPT_CHANCE = 0.05;        // 5%
const SKIP_CHANCE = 0.02;           // 2%
const GPS_DELTA_THRESHOLD = 50;     // meter
const EARTH_RADIUS_M = 6_371_000;   // meter

// ============================================================
// HELPER
// ============================================================

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function randomInt(min, max) {
  return Math.floor(randomBetween(min, max + 1));
}

/**
 * Haversine distance antara 2 koordinat (meter).
 */
function haversine(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
    Math.sin(dLon / 2) ** 2;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

/**
 * GPS drift: geser koordinat random sejauh beberapa meter.
 */
function driftCoordinate(lat, lon, maxMeters) {
  const angle = Math.random() * Math.PI * 2;
  const distance = Math.random() * maxMeters;

  const dLat = (distance * Math.cos(angle)) / 111_320;
  const dLon =
    (distance * Math.sin(angle)) /
    (111_320 * Math.cos(lat * (Math.PI / 180)));

  return [lat + dLat, lon + dLon];
}

// ============================================================
// KELAS UTAMA
// ============================================================

class HTAgentSimulator {
  /**
   * @param {number} agentId      1-65535
   * @param {number} channel      0-15
   * @param {string} behaviorProfile 'patrol' | 'static' | 'emergency'
   * @param {object} [options]
   * @param {object} [options.initialPosition] { lat, lon }
   * @param {string} [options.callsign]
   * @param {number} [options.battery]         0-100
   * @param {Function} [options.onTransmit]    (channel, Uint8Array) => void
   * @param {Function} [options.onStateChange] (agentId, state) => void
   * @param {Function} [options.onError]       (error) => void
   */
  constructor(agentId, channel, behaviorProfile = 'patrol', options = {}) {
    if (!Number.isInteger(agentId) || agentId < 1 || agentId > 0xFFFF) {
      throw new RangeError('agentId harus integer 1-65535');
    }
    if (!Number.isInteger(channel) || channel < 0 || channel > 15) {
      throw new RangeError('channel harus integer 0-15');
    }
    if (!BEHAVIOR_PROFILES[behaviorProfile]) {
      throw new RangeError(`behaviorProfile tidak valid: ${behaviorProfile}`);
    }

    this.agentId = agentId;
    this.channel = channel;
    this.profile = BEHAVIOR_PROFILES[behaviorProfile];
    this.profileName = behaviorProfile;

    // Position — spread across western Indonesia so markers are visible on radar
    // (previously all agents stacked on Jakarta ≈ one pixel)
    const initial = options.initialPosition ?? (() => {
      const seeds = [
        { lat: -6.2088, lon: 106.8456 }, // Jakarta
        { lat: -6.9175, lon: 107.6191 }, // Bandung
        { lat: -7.2575, lon: 112.7521 }, // Surabaya
        { lat: -6.9667, lon: 110.4167 }, // Semarang
        { lat: -7.7956, lon: 110.3695 }, // Yogyakarta
        { lat: -6.1783, lon: 106.6319 }, // Tangerang
        { lat: -6.2383, lon: 106.9756 }, // Bekasi
        { lat: -6.5971, lon: 106.7990 }, // Bogor
        { lat: -6.4025, lon: 106.7942 }, // Depok
        { lat: -7.0167, lon: 110.4167 }, // near Semarang
        { lat: -8.4095, lon: 115.1889 }, // Bali
        { lat: -7.8014, lon: 110.3647 }  // near Yogya
      ];
      const seed = seeds[(agentId - 1) % seeds.length];
      return {
        lat: seed.lat + (Math.random() - 0.5) * 0.06,
        lon: seed.lon + (Math.random() - 0.5) * 0.06
      };
    })();
    this.latitude = initial.lat;
    this.longitude = initial.lon;
    this.lastTxLat = this.latitude;
    this.lastTxLon = this.longitude;

    // State
    this.battery = Number.isFinite(options.battery)
      ? Math.max(0, Math.min(100, options.battery))
      : randomInt(60, 100);

    this.signalQuality = this._computeSignal();
    this.callsign = options.callsign ?? `AGT-${String(agentId).padStart(4, '0')}`;
    this.nicknameHash = null; // dihitung oleh protocol

    this.status = 0;
    this.sequence = randomInt(0, 255);

    // Lifecycle
    this.running = false;
    this.tickTimer = null;
    this.lastTx = 0;
    this.statusChanged = true;   // trigger TX pertama
    this.emergencyMode = behaviorProfile === 'emergency';
    this.pendingTx = null;       // timeout handle squelch delay
    this.createdAt = Date.now();

    // Buffer reuse untuk encode
    this._txBuffer = new Uint8Array(PACKET_SIZE);

    // Callbacks
    this.onTransmit = options.onTransmit ?? (() => {});
    this.onStateChange = options.onStateChange ?? (() => {});
    this.onError = options.onError ?? ((err) => console.error('[HTAgent]', err));

    // Set emergency bit kalau profile emergency
    if (behaviorProfile === 'emergency') {
      this.status |= STATUS_FLAGS.EMERGENCY;
    }
  }

  // ----------------------------------------------------------
  // LIFECYCLE
  // ----------------------------------------------------------

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTx = Date.now();
    this.tickTimer = setInterval(() => this._tick(), TICK_INTERVAL);
  }

  stop() {
    if (!this.running) return;
    this.running = false;

    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }

    if (this.pendingTx !== null) {
      clearTimeout(this.pendingTx);
      this.pendingTx = null;
    }
  }

  dispose() {
    this.stop();
    this.onTransmit = () => {};
    this.onStateChange = () => {};
    this.onError = () => {};
  }

  // ----------------------------------------------------------
  // STATE MANIPULATION
  // ----------------------------------------------------------

  setPTT(active) {
    const was = (this.status & STATUS_FLAGS.PTT_ACTIVE) !== 0;
    if (was === active) return;

    if (active) {
      this.status |= STATUS_FLAGS.PTT_ACTIVE;
    } else {
      this.status &= ~STATUS_FLAGS.PTT_ACTIVE;
    }

    this.statusChanged = true;
  }

  setStatus(flag, active) {
    const was = (this.status & flag) !== 0;
    if (was === active) return;

    if (active) {
      this.status |= flag;
    } else {
      this.status &= ~flag;
    }

    this.statusChanged = true;
  }

  clearEmergency() {
    if ((this.status & STATUS_FLAGS.EMERGENCY) === 0) return;
    this.status &= ~STATUS_FLAGS.EMERGENCY;
    this.emergencyMode = false;
    this.statusChanged = true;
    this._emitState();
  }

  triggerEmergency() {
    if (this.status & STATUS_FLAGS.EMERGENCY) return;
    this.status |= STATUS_FLAGS.EMERGENCY;
    this.emergencyMode = true;
    this.statusChanged = true;
    this._emitState();
  }

  setBattery(level) {
    this.battery = Math.max(0, Math.min(100, Number(level) || 0));
    this.statusChanged = true;
  }

  // ----------------------------------------------------------
  // INTERNAL
  // ----------------------------------------------------------

  _computeSignal() {
    const p = this.profile;
    const raw = p.signalBase + randomBetween(-p.signalJitter, p.signalJitter);
    return Math.max(0, Math.min(100, Math.round(raw)));
  }

  _getCheckInInterval() {
    if (this.emergencyMode && this.profile.emergencyBurst !== null) {
      return this.profile.emergencyBurst;
    }
    return this.profile.checkInInterval;
  }

  _tick() {
    if (!this.running) return;

    const now = Date.now();

    // Battery drain
    const elapsedMin = TICK_INTERVAL / 60_000;
    this.battery = Math.max(0, this.battery - this.profile.batteryDrainPerMin * elapsedMin);

    // Signal jitter (halus)
    if (Math.random() < 0.1) {
      this.signalQuality = this._computeSignal();
    }

    // GPS drift
    if (this.profile.gpsDrift) {
      const [newLat, newLon] = driftCoordinate(
        this.latitude,
        this.longitude,
        randomBetween(0, 15)  // 0-15 meter per tick
      );
      this.latitude = newLat;
      this.longitude = newLon;
    }

    // Status change otomatis untuk patrol
    if (this.profile.autoStatusChange && Math.random() < 0.02) {
      const ptt = Math.random() < 0.5;
      this.setPTT(ptt);
    }

    // Cek kondisi transmit
    const timeDue = now - this.lastTx > this._getCheckInInterval();
    const gpsDelta = this.profile.gpsDrift
      ? haversine(this.lastTxLat, this.lastTxLon, this.latitude, this.longitude)
      : 0;
    const gpsMoved = gpsDelta > GPS_DELTA_THRESHOLD;

    if (timeDue || this.statusChanged || gpsMoved) {
      if (this.pendingTx === null) {
        // Skip chance (simulasi hardware hang)
        if (Math.random() < SKIP_CHANCE) {
          // Anggap saja transmit, tapi tidak kirim apa-apa
          // Update lastTx agar tidak spam skip
          this.lastTx = now;
          this.statusChanged = false;
          return;
        }

        // Squelch delay non-blocking
        const delay = randomBetween(SQUELCH_MIN, SQUELCH_MAX);
        this.pendingTx = setTimeout(() => {
          this.pendingTx = null;
          if (!this.running) return;
          this._transmit();
        }, delay);
      }
    }
  }

  _transmit() {
    try {
      const now = Date.now();

      // Reset statusChanged SEBELUM encode (biar konsisten)
      this.statusChanged = false;
      this.lastTx = now;

      // Encode ke buffer reuse
      const packet = encodeHTPacket({
        sequence: this.sequence,
        agentId: this.agentId,
        latitude: this.latitude,
        longitude: this.longitude,
        status: this.status,
        battery: Math.round(this.battery),
        timestamp: now,
        signalQuality: this.signalQuality,
        channel: this.channel,
        callsign: this.callsign,
        hopCount: 0
      }, this._txBuffer);

      // Corrupt injection 5%
      if (Math.random() < CORRUPT_CHANCE) {
        // Rusak 1 byte di area data (byte 4-17) supaya CRC mismatch
        const corruptIdx = randomInt(4, 17);
        packet[corruptIdx] ^= 0xFF;
      }

      // Update last GPS reference
      this.lastTxLat = this.latitude;
      this.lastTxLon = this.longitude;

      // Sequence naik (wrapping 0-255)
      this.sequence = (this.sequence + 1) & 0xFF;

      // Kirim ke callback (copy agar buffer reuse berikutnya aman)
      const out = new Uint8Array(packet);
      this.onTransmit(this.channel, out);

      this._emitState();
    } catch (err) {
      this.onError(err);
    }
  }

  _emitState() {
    try {
      this.onStateChange(this.agentId, {
        agentId: this.agentId,
        channel: this.channel,
        status: this.status,
        pttActive: (this.status & STATUS_FLAGS.PTT_ACTIVE) !== 0,
        emergency: (this.status & STATUS_FLAGS.EMERGENCY) !== 0,
        warn: (this.status & STATUS_FLAGS.WARN) !== 0,
        gpsInvalid: (this.status & STATUS_FLAGS.GPS_INVALID) !== 0,
        battery: Math.round(this.battery),
        signalQuality: this.signalQuality,
        latitude: this.latitude,
        longitude: this.longitude,
        callsign: this.callsign,
        profile: this.profileName
      });
    } catch (err) {
      this.onError(err);
    }
  }

  // ----------------------------------------------------------
  // DEBUG / INSPEKSI
  // ----------------------------------------------------------

  getStats() {
    return {
      agentId: this.agentId,
      channel: this.channel,
      profile: this.profileName,
      running: this.running,
      uptimeMs: Date.now() - this.createdAt,
      battery: Math.round(this.battery),
      signalQuality: this.signalQuality,
      status: this.status,
      sequence: this.sequence,
      lastTx: this.lastTx,
      position: { lat: this.latitude, lon: this.longitude }
    };
  }
}

// ============================================================
// FACTORY
// ============================================================

/**
 * Buat banyak simulator sekaligus dengan callback broadcast.
 */
function createSimulator(config = {}) {
  const {
    count = 10,
    channels = 8,
    profiles = ['patrol', 'static', 'emergency'],
    weights = [0.7, 0.2, 0.1],
    onTransmit = () => {},
    onStateChange = () => {},
    onError = (err) => console.error('[Simulator]', err)
  } = config;

  // Weighted pick
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  function pickProfile() {
    let r = Math.random() * totalWeight;
    for (let i = 0; i < profiles.length; i++) {
      r -= weights[i];
      if (r <= 0) return profiles[i];
    }
    return profiles[profiles.length - 1];
  }

  const agents = [];
  for (let i = 0; i < count; i++) {
    const agentId = i + 1;
    const channel = i % channels;
    const profile = pickProfile();

    const agent = new HTAgentSimulator(agentId, channel, profile, {
      callsign: `AGT-${String(agentId).padStart(4, '0')}`,
      onTransmit,
      onStateChange,
      onError
    });

    agents.push(agent);
  }

  return {
    agents,

    startAll() {
      for (const a of agents) a.start();
    },

    stopAll() {
      for (const a of agents) a.stop();
    },

    disposeAll() {
      for (const a of agents) a.dispose();
      agents.length = 0;
    },

    clearEmergencyAll() {
      for (const a of agents) a.clearEmergency();
    },

    triggerEmergencyAll() {
      for (const a of agents) a.triggerEmergency();
    },

    getStats() {
      return agents.map((a) => a.getStats());
    },

    getAgent(agentId) {
      return agents.find((a) => a.agentId === agentId) ?? null;
    }
  };
}

export {
  HTAgentSimulator,
  BEHAVIOR_PROFILES,
  createSimulator
};
