// FILE: cgo-ht-radio-engine.js | DEPS: ht-protocol, ht-audio-synth, chat-radio-formatter | EXPORTS: VirtualRadioGateway, radioGateway

import {
  decodeHTPacket,
  MAGIC_BYTE,
  CHANNEL_COUNT,
  STATUS_FLAGS
} from './ht-protocol.js';

import { htAudioSynth } from './ht-audio-synth.js';

import {
  formatRadioTransmission,
  formatRadioAlert
} from './chat-radio-formatter.js';

// ============================================================
// KONSTANTA
// ============================================================

const COLLISION_WINDOW_MS = 50;
const MAX_BUFFER_SIZE = 10;
const YIELD_EVERY = 5;                    // yield tiap 5 paket
const EMERGENCY_ALERT_COOLDOWN = 10_000;  // 10s per agent
const WEAK_SIGNAL_THRESHOLD = 30;
const LOW_BATTERY_THRESHOLD = 15;

// ============================================================
// SLOT CHANNEL
// ============================================================

function createChannelSlot() {
  return {
    buffer: [],
    lastActivity: 0,
    lastSeq: null,
    collisionCount: 0,
    droppedCount: 0,
    gapCount: 0,
    totalReceived: 0,
    _processing: false,
    _recentSignals: []
  };
}

// ============================================================
// KELAS GATEWAY
// ============================================================

class VirtualRadioGateway {
  /**
   * @param {object} [options]
   * @param {object} [options.state]       Objek BCGO_STATE (default window.BCGO_STATE)
   * @param {object} [options.chat]        Objek chat (default window.cgoChat)
   * @param {object} [options.audio]       Audio synth (default htAudioSynth singleton)
   * @param {Function} [options.onLog]     Callback custom log (channel, text, meta)
   * @param {boolean}  [options.verbose]   Log debug verbose
   */
  constructor(options = {}) {
    // Channel slots
    this.channels = Array.from({ length: CHANNEL_COUNT }, createChannelSlot);

    // Dependencies
    this.state = options.state ?? (typeof globalThis !== 'undefined' ? globalThis.BCGO_STATE : null);
    this.chat = options.chat ?? (typeof globalThis !== 'undefined' ? globalThis.cgoChat : null);
    this.audio = options.audio ?? htAudioSynth;
    this.onLog = options.onLog ?? null;
    this.verbose = options.verbose === true;

    // Runtime
    this.running = true;
    this._emergencyCooldown = new Map();  // agentId -> last alert ms
    this._recentGpsInvalid = new Map();   // agentId -> last alert ms
    this._recentBatteryLow = new Map();   // agentId -> last alert ms

    // Stats global
    this.stats = {
      totalReceived: 0,
      totalValid: 0,
      totalCrcFail: 0,
      totalMagicFail: 0,
      totalDropped: 0,
      totalGaps: 0,
      totalCollisions: 0,
      startedAt: Date.now()
    };

    // Pastikan BCGO_STATE.satellite ada
    if (this.state && !this.state.satellite) {
      this.state.satellite = {};
    }

    // Pastikan satelliteUpdates EventTarget
    if (this.state && !this.state.satelliteUpdates) {
      try {
        this.state.satelliteUpdates = new EventTarget();
      } catch {
        this.state.satelliteUpdates = null;
      }
    }
  }

  // ----------------------------------------------------------
  // RECEIVE
  // ----------------------------------------------------------

  /**
   * Terima 1 paket biner dari channel tertentu.
   * @param {number} channelId 0-15
   * @param {Uint8Array} payload
   * @returns {boolean} true kalau paket diterima (belum tentu valid decode)
   */
  receive(channelId, payload) {
    if (!this.running) return false;

    if (!Number.isInteger(channelId) || channelId < 0 || channelId >= CHANNEL_COUNT) {
      return false;
    }

    if (!(payload instanceof Uint8Array) || payload.byteLength < 1) {
      return false;
    }

    const slot = this.channels[channelId];
    this.stats.totalReceived++;

    // 1. Validasi magic byte
    if (payload[0] !== MAGIC_BYTE) {
      this.stats.totalMagicFail++;
      slot.droppedCount++;
      return false;
    }

    // 2. Ambil seq (byte 1) untuk decision selanjutnya
    const incomingSeq = payload[1];

    // 3. Cek CRC dulu (decode penuh tapi buang data)
    const decoded = decodeHTPacket(payload);

    if (!decoded.valid) {
      // CRC mismatch dll → collision count
      slot.collisionCount++;
      this.stats.totalCrcFail++;

      if (this.verbose) {
        console.debug(`[Gateway] CH-${channelId} discard: ${decoded.error}`);
      }

      // Trigger collision alert suara (rate-limited di audio)
      this.audio.playCollisionAlert?.();
      return false;
    }

    // 4. Sequence gap detection
    if (slot.lastSeq !== null) {
      const delta = (incomingSeq - slot.lastSeq + 256) % 256;

      if (delta > 1 && delta < 128) {
        // Gap wajar (maju), bukan wrap
        slot.gapCount++;
        this.stats.totalGaps++;

        if (this.verbose) {
          console.debug(`[Gateway] CH-${channelId} gap: last=${slot.lastSeq} now=${incomingSeq} delta=${delta}`);
        }
      }
    }

    // 5. Collision check (deterministik)
    const now = Date.now();
    const timeSinceLast = now - slot.lastActivity;

    if (timeSinceLast < COLLISION_WINDOW_MS && slot.buffer.length > 0) {
      slot.collisionCount++;
      this.stats.totalCollisions++;

      // Policy: keep paket dengan SEQ lebih tinggi (state paling baru)
      const lastQueued = slot.buffer[slot.buffer.length - 1];
      const lastQueuedSeq = lastQueued ? lastQueued[1] : -1;

      if (incomingSeq <= lastQueuedSeq) {
        // Drop paket baru
        slot.droppedCount++;
        this.stats.totalDropped++;

        if (this.verbose) {
          console.debug(`[Gateway] CH-${channelId} collision: drop new seq=${incomingSeq}`);
        }
        return false;
      } else {
        // Evict paket lama, keep yang baru
        const evicted = slot.buffer.pop();
        slot.droppedCount++;
        this.stats.totalDropped++;

        if (this.verbose) {
          console.debug(`[Gateway] CH-${channelId} collision: evict seq=${evicted?.[1]}, keep seq=${incomingSeq}`);
        }
      }
    }

    // 6. Backpressure (FIFO drop oldest)
    if (slot.buffer.length >= MAX_BUFFER_SIZE) {
      slot.buffer.shift();
      slot.droppedCount++;
      this.stats.totalDropped++;

      if (this.verbose) {
        console.debug(`[Gateway] CH-${channelId} overflow: drop oldest`);
      }
    }

    // 7. Push ke buffer (defensive copy)
    const copy = new Uint8Array(payload.byteLength);
    copy.set(payload);

    slot.buffer.push(copy);
    slot.lastActivity = now;
    slot.lastSeq = incomingSeq;
    slot.totalReceived++;
    this.stats.totalValid++;

    // 8. Trigger process queue (async, non-blocking)
    if (!slot._processing) {
      void this._processQueue(channelId);
    }

    return true;
  }

  // ----------------------------------------------------------
  // PROCESS QUEUE
  // ----------------------------------------------------------

  async _processQueue(channelId) {
    const slot = this.channels[channelId];

    if (slot._processing) return;
    slot._processing = true;

    try {
      let count = 0;

      while (slot.buffer.length > 0 && this.running) {
        const packet = slot.buffer.shift();
        const result = decodeHTPacket(packet);

        if (!result.valid) {
          // Sudah dicek di receive(), tapi defensive
          slot.droppedCount++;
          continue;
        }

        this._handlePacket(channelId, result.data);

        count++;

        // Yield ke event loop
        if (count % YIELD_EVERY === 0) {
          await Promise.resolve();
        }
      }
    } catch (err) {
      console.error(`[Gateway] processQueue CH-${channelId} error:`, err);
    } finally {
      slot._processing = false;
    }
  }

  // ----------------------------------------------------------
  // HANDLE PACKET
  // ----------------------------------------------------------

  _handlePacket(channelId, data) {
    const { agentId, signalQuality, battery, status } = data;

    // 1. Update BCGO_STATE.satellite (merge, bukan replace)
    if (this.state) {
      const existing = this.state.satellite[agentId] ?? {};

      const merged = {
        ...existing,
        ...data,
        agentId,
        channel: channelId,
        source: 'virtual_ht',
        lastSeen: Date.now()
      };

      this.state.satellite[agentId] = merged;

      // 2. Emit event
      this._emitUpdate(merged);
    }

    // 3. Audio feedback
    if ((status & STATUS_FLAGS.PTT_ACTIVE) !== 0) {
      this.audio.playValidBeep?.(signalQuality, {
        emergency: (status & STATUS_FLAGS.EMERGENCY) !== 0
      });
    }

    // 4. Chat log
    this._logTransmission(channelId, data);

    // 5. Alert khusus
    this._checkSpecialAlerts(channelId, data);
  }

  _logTransmission(channelId, data) {
    const text = formatRadioTransmission(data);

    const meta = {
      channel: channelId,
      agentId: data.agentId,
      emergency: data.emergency,
      signalQuality: data.signalQuality,
      battery: data.battery,
      status: data.status,
      timestamp: Date.now()
    };

    if (typeof this.onLog === 'function') {
      try {
        this.onLog(channelId, text, meta);
      } catch (err) {
        console.error('[Gateway] onLog error:', err);
      }
      return;
    }

    // Fallback ke cgoChat global
    if (this.chat && typeof this.chat.logRadioMessage === 'function') {
      try {
        this.chat.logRadioMessage(text, meta);
      } catch (err) {
        console.error('[Gateway] chat.logRadioMessage error:', err);
      }
      return;
    }

    if (this.verbose) {
      console.log(text);
    }
  }

  _checkSpecialAlerts(channelId, data) {
    const { agentId, status, battery, signalQuality } = data;
    const now = Date.now();

    // Emergency alert
    if ((status & STATUS_FLAGS.EMERGENCY) !== 0) {
      const last = this._emergencyCooldown.get(agentId) ?? 0;

      if (now - last > EMERGENCY_ALERT_COOLDOWN) {
        this._emergencyCooldown.set(agentId, now);
        const alertText = formatRadioAlert('emergency', channelId, { agentId });
        this._logAlert(alertText, { level: 'emergency', channelId, agentId });
      }
    }

    // Weak signal
    if (signalQuality < WEAK_SIGNAL_THRESHOLD) {
      const last = this._recentGpsInvalid.get(agentId) ?? 0;

      if (now - last > 30_000) {
        this._recentGpsInvalid.set(agentId, now);
        const alertText = formatRadioAlert('weak_signal', channelId, {
          agentId, signal: signalQuality
        });
        this._logAlert(alertText, { level: 'warning', channelId, agentId });
      }
    }

    // Low battery
    if (battery != null && battery < LOW_BATTERY_THRESHOLD) {
      const last = this._recentBatteryLow.get(agentId) ?? 0;

      if (now - last > 60_000) {
        this._recentBatteryLow.set(agentId, now);
        const alertText = formatRadioAlert('battery_low', channelId, {
          agentId, battery
        });
        this._logAlert(alertText, { level: 'warning', channelId, agentId });
      }
    }

    // GPS invalid
    if ((status & STATUS_FLAGS.GPS_INVALID) !== 0) {
      const last = this._recentGpsInvalid.get(`gps_${agentId}`) ?? 0;

      if (now - last > 30_000) {
        this._recentGpsInvalid.set(`gps_${agentId}`, now);
        const alertText = formatRadioAlert('gps_loss', channelId, { agentId });
        this._logAlert(alertText, { level: 'warning', channelId, agentId });
      }
    }
  }

  _logAlert(text, meta) {
    if (typeof this.onLog === 'function') {
      try {
        this.onLog(meta.channelId, text, { ...meta, isAlert: true });
      } catch (err) {
        console.error('[Gateway] onLog (alert) error:', err);
      }
      return;
    }

    if (this.chat && typeof this.chat.logRadioMessage === 'function') {
      try {
        this.chat.logRadioMessage(text, { ...meta, isAlert: true });
      } catch (err) {
        console.error('[Gateway] chat.logRadioMessage (alert) error:', err);
      }
      return;
    }

    console.warn(text);
  }

  _emitUpdate(state) {
    const target = this.state?.satelliteUpdates;
    if (!target) return;

    try {
      if (typeof target.dispatchEvent === 'function') {
        const evt = new CustomEvent('satelliteUpdates', { detail: { agentId: state.agentId, state } });
        target.dispatchEvent(evt);
      }
    } catch (err) {
      console.debug('[Gateway] emit error:', err);
    }
  }

  // ----------------------------------------------------------
  // EMERGENCY API
  // ----------------------------------------------------------

  clearEmergency(agentId) {
    if (!this.state) return false;

    const sat = this.state.satellite[agentId];
    if (!sat) return false;

    sat.status = (sat.status ?? 0) & ~STATUS_FLAGS.EMERGENCY;
    sat.emergency = false;
    sat.lastSeen = Date.now();

    this._emitUpdate(sat);
    return true;
  }

  // ----------------------------------------------------------
  // METRICS
  // ----------------------------------------------------------

  getChannelStats() {
    const result = {};

    for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
      const slot = this.channels[ch];
      const total = slot.totalReceived || 1;

      // Rolling avg signal (max 20 terakhir)
      const signals = slot._recentSignals;
      const avgSignal = signals.length > 0
        ? signals.reduce((a, b) => a + b, 0) / signals.length
        : 0;

      result[ch] = {
        utilization: (slot.buffer.length / MAX_BUFFER_SIZE) * 100,
        bufferDepth: slot.buffer.length,
        collisionRate: slot.collisionCount / total,
        gapRate: slot.gapCount / total,
        dropRate: slot.droppedCount / total,
        avgSignal: Math.round(avgSignal),
        totalReceived: slot.totalReceived,
        collisionCount: slot.collisionCount,
        droppedCount: slot.droppedCount,
        gapCount: slot.gapCount,
        lastActivity: slot.lastActivity
      };
    }

    return result;
  }

  getGlobalStats() {
    return {
      ...this.stats,
      uptimeMs: Date.now() - this.stats.startedAt,
      channelCount: CHANNEL_COUNT
    };
  }

  // ----------------------------------------------------------
  // LIFECYCLE
  // ----------------------------------------------------------

  reset() {
    for (const slot of this.channels) {
      slot.buffer.length = 0;
      slot.lastActivity = 0;
      slot.lastSeq = null;
      slot.collisionCount = 0;
      slot.droppedCount = 0;
      slot.gapCount = 0;
      slot.totalReceived = 0;
      slot._processing = false;
      slot._recentSignals.length = 0;
    }

    this._emergencyCooldown.clear();
    this._recentGpsInvalid.clear();
    this._recentBatteryLow.clear();

    this.stats = {
      totalReceived: 0,
      totalValid: 0,
      totalCrcFail: 0,
      totalMagicFail: 0,
      totalDropped: 0,
      totalGaps: 0,
      totalCollisions: 0,
      startedAt: Date.now()
    };
  }

  shutdown() {
    this.running = false;
    this.reset();
  }
}

// ============================================================
// SINGLETON GLOBAL
// ============================================================

let radioGateway = null;

/**
 * Get/set singleton gateway.
 * Tanpa argumen → ambil instance (bikin kalau belum ada).
 * Dengan argumen → set instance.
 */
function getGateway(options) {
  if (options !== undefined) {
    radioGateway = options;
    return radioGateway;
  }

  if (!radioGateway) {
    radioGateway = new VirtualRadioGateway();
  }

  return radioGateway;
}

// Ekspor sebagai proxy yang bisa dipanggil sebagai fungsi (getGateway)
// atau diakses properti (VirtualRadioGateway)
const radioGateway = new Proxy({}, {
  get(_, prop) {
    if (prop === 'VirtualRadioGateway') return VirtualRadioGateway;
    if (prop === 'getGateway') return getGateway;

    const instance = getGateway();
    const value = instance[prop];

    return typeof value === 'function'
      ? value.bind(instance)
      : value;
  }
});

export {
  VirtualRadioGateway,
  getGateway,
  radioGateway
};
