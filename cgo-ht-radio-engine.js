// FILE: cgo-ht-radio-engine.js | DEPS: ht-protocol, ht-audio-synth, chat-radio-formatter | EXPORTS: VirtualRadioGateway, getGateway, radioGateway

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

const COLLISION_WINDOW_MS = 50;
const MAX_BUFFER_SIZE = 10;
const YIELD_EVERY = 5;
const EMERGENCY_ALERT_COOLDOWN = 10_000;
const WEAK_SIGNAL_THRESHOLD = 30;
const LOW_BATTERY_THRESHOLD = 15;

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

class VirtualRadioGateway {
  constructor(options = {}) {
    this.channels = Array.from({ length: CHANNEL_COUNT }, createChannelSlot);
    this.state = options.state ?? (typeof globalThis !== 'undefined' ? globalThis.BCGO_STATE : null);
    this.chat = options.chat ?? (typeof globalThis !== 'undefined' ? globalThis.cgoChat : null);
    this.audio = options.audio ?? htAudioSynth;
    this.onLog = options.onLog ?? null;
    this.verbose = options.verbose === true;
    this.running = true;
    this._emergencyCooldown = new Map();
    this._recentGpsInvalid = new Map();
    this._recentBatteryLow = new Map();
    this.stats = {
      totalReceived: 0, totalValid: 0, totalCrcFail: 0,
      totalMagicFail: 0, totalDropped: 0, totalGaps: 0,
      totalCollisions: 0, startedAt: Date.now()
    };
    if (this.state && !this.state.satellite) this.state.satellite = {};
    if (this.state && !this.state.satelliteUpdates) {
      try { this.state.satelliteUpdates = new EventTarget(); }
      catch { this.state.satelliteUpdates = null; }
    }
  }

  receive(channelId, payload) {
    if (!this.running) return false;
    if (!Number.isInteger(channelId) || channelId < 0 || channelId >= CHANNEL_COUNT) return false;
    if (!(payload instanceof Uint8Array) || payload.byteLength < 1) return false;

    const slot = this.channels[channelId];
    this.stats.totalReceived++;

    if (payload[0] !== MAGIC_BYTE) {
      this.stats.totalMagicFail++;
      slot.droppedCount++;
      return false;
    }

    const incomingSeq = payload[1];
    const decoded = decodeHTPacket(payload);

    if (!decoded.valid) {
      this.stats.totalCrcFail++;
      if (this.verbose) console.debug(`[Gateway] CH-${channelId} discard: ${decoded.error}`);
      this.audio.playCollisionAlert?.();
      return false;
    }

    if (slot.lastSeq !== null) {
      const delta = (incomingSeq - slot.lastSeq + 256) % 256;
      if (delta > 1 && delta < 128) {
        slot.gapCount++;
        this.stats.totalGaps++;
      }
    }

    const now = Date.now();
    const timeSinceLast = now - slot.lastActivity;

    if (timeSinceLast < COLLISION_WINDOW_MS && slot.buffer.length > 0) {
      slot.collisionCount++;
      this.stats.totalCollisions++;
      const lastQueued = slot.buffer[slot.buffer.length - 1];
      const lastQueuedSeq = lastQueued ? lastQueued[1] : -1;

      if (incomingSeq <= lastQueuedSeq) {
        slot.droppedCount++;
        this.stats.totalDropped++;
        return false;
      } else {
        slot.buffer.pop();
        slot.droppedCount++;
        this.stats.totalDropped++;
      }
    }

    if (slot.buffer.length >= MAX_BUFFER_SIZE) {
      slot.buffer.shift();
      slot.droppedCount++;
      this.stats.totalDropped++;
    }

    const copy = new Uint8Array(payload.byteLength);
    copy.set(payload);
    slot.buffer.push(copy);
    slot.lastActivity = now;
    slot.lastSeq = incomingSeq;
    slot.totalReceived++;
    this.stats.totalValid++;

    if (slot._recentSignals.length >= 20) slot._recentSignals.shift();
    if (decoded.data?.signalQuality != null) slot._recentSignals.push(decoded.data.signalQuality);

    if (!slot._processing) void this._processQueue(channelId);
    return true;
  }

  async _processQueue(channelId) {
    const slot = this.channels[channelId];
    if (slot._processing) return;
    slot._processing = true;
    try {
      let count = 0;
      while (slot.buffer.length > 0 && this.running) {
        const packet = slot.buffer.shift();
        const result = decodeHTPacket(packet);
        if (!result.valid) { slot.droppedCount++; continue; }
        this._handlePacket(channelId, result.data);
        count++;
        if (count % YIELD_EVERY === 0) await Promise.resolve();
      }
    } catch (err) {
      console.error(`[Gateway] processQueue CH-${channelId} error:`, err);
    } finally {
      slot._processing = false;
    }
  }

  _handlePacket(channelId, data) {
    const { agentId, signalQuality, status } = data;

    if (this.state) {
      const existing = this.state.satellite[agentId] ?? {};
      const merged = {
        ...existing, ...data, agentId,
        channel: channelId, source: 'virtual_ht', lastSeen: Date.now()
      };
      this.state.satellite[agentId] = merged;
      this._emitUpdate(merged);
    }

    if ((status & STATUS_FLAGS.PTT_ACTIVE) !== 0) {
      this.audio.playValidBeep?.(signalQuality, {
        emergency: (status & STATUS_FLAGS.EMERGENCY) !== 0
      });
    }

    this._logTransmission(channelId, data);
    this._checkSpecialAlerts(channelId, data);
  }

  _logTransmission(channelId, data) {
    const text = formatRadioTransmission(data);
    const meta = {
      channel: channelId, agentId: data.agentId,
      emergency: data.emergency, signalQuality: data.signalQuality,
      battery: data.battery, status: data.status, timestamp: Date.now()
    };
    if (typeof this.onLog === 'function') {
      try { this.onLog(channelId, text, meta); } catch (err) { console.error(err); }
      return;
    }
    if (this.chat && typeof this.chat.logRadioMessage === 'function') {
      try { this.chat.logRadioMessage(text, meta); } catch (err) { console.error(err); }
      return;
    }
    if (this.verbose) console.log(text);
  }

  _checkSpecialAlerts(channelId, data) {
    const { agentId, status, battery, signalQuality } = data;
    const now = Date.now();

    if ((status & STATUS_FLAGS.EMERGENCY) !== 0) {
      const last = this._emergencyCooldown.get(agentId) ?? 0;
      if (now - last > EMERGENCY_ALERT_COOLDOWN) {
        this._emergencyCooldown.set(agentId, now);
        this._logAlert(formatRadioAlert('emergency', channelId, { agentId }),
          { level: 'emergency', channelId, agentId });
      }
    }
    if (signalQuality < WEAK_SIGNAL_THRESHOLD) {
      const last = this._recentGpsInvalid.get(agentId) ?? 0;
      if (now - last > 30_000) {
        this._recentGpsInvalid.set(agentId, now);
        this._logAlert(formatRadioAlert('weak_signal', channelId, { agentId, signal: signalQuality }),
          { level: 'warning', channelId, agentId });
      }
    }
    if (battery != null && battery < LOW_BATTERY_THRESHOLD) {
      const last = this._recentBatteryLow.get(agentId) ?? 0;
      if (now - last > 60_000) {
        this._recentBatteryLow.set(agentId, now);
        this._logAlert(formatRadioAlert('battery_low', channelId, { agentId, battery }),
          { level: 'warning', channelId, agentId });
      }
    }
    if ((status & STATUS_FLAGS.GPS_INVALID) !== 0) {
      const last = this._recentGpsInvalid.get(`gps_${agentId}`) ?? 0;
      if (now - last > 30_000) {
        this._recentGpsInvalid.set(`gps_${agentId}`, now);
        this._logAlert(formatRadioAlert('gps_loss', channelId, { agentId }),
          { level: 'warning', channelId, agentId });
      }
    }
  }

  _logAlert(text, meta) {
    if (typeof this.onLog === 'function') {
      try { this.onLog(meta.channelId, text, { ...meta, isAlert: true }); } catch (err) { console.error(err); }
      return;
    }
    if (this.chat && typeof this.chat.logRadioMessage === 'function') {
      try { this.chat.logRadioMessage(text, { ...meta, isAlert: true }); } catch (err) { console.error(err); }
      return;
    }
    console.warn(text);
  }

  _emitUpdate(state) {
    const target = this.state?.satelliteUpdates;
    if (!target) return;
    try {
      if (typeof target.dispatchEvent === 'function') {
        target.dispatchEvent(new CustomEvent('satelliteUpdates', {
          detail: { agentId: state.agentId, state }
        }));
      }
    } catch (err) { console.debug('[Gateway] emit error:', err); }
  }

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

  getChannelStats() {
    const result = {};
    for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
      const slot = this.channels[ch];
      const total = slot.totalReceived || 1;
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
    return { ...this.stats, uptimeMs: Date.now() - this.stats.startedAt, channelCount: CHANNEL_COUNT };
  }

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
      totalReceived: 0, totalValid: 0, totalCrcFail: 0,
      totalMagicFail: 0, totalDropped: 0, totalGaps: 0,
      totalCollisions: 0, startedAt: Date.now()
    };
  }

  shutdown() { this.running = false; this.reset(); }
}

let _gatewayInstance = null;

function getGateway(options) {
  // Singleton — options only applied on first create
  if (!_gatewayInstance) {
    _gatewayInstance = new VirtualRadioGateway(options || {});
  }
  return _gatewayInstance;
}

const radioGateway = new Proxy({}, {
  get(_, prop) {
    if (prop === 'VirtualRadioGateway') return VirtualRadioGateway;
    if (prop === 'getGateway') return getGateway;
    const instance = getGateway();
    const value = instance[prop];
    return typeof value === 'function' ? value.bind(instance) : value;
  }
});

export { VirtualRadioGateway, getGateway, radioGateway };
