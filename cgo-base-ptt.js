/**
 * cgo-base-ptt.js
 * ============================================================
 * PTT terpusat (BASE) — operator di pusat membalas ke channel
 *
 * - Channel custom 0–255 (ketik nomor HT tujuan)
 * - Mic browser + sidetone (dengar suara sendiri saat tahan PTT)
 * - Squelch open / roger beep
 *
 * EXPORTS: BasePTT, getBasePTT, BASE_AGENT_ID, BASE_CALLSIGN
 * ============================================================
 */

import { encodeHTPacket, STATUS_FLAGS, CHANNEL_COUNT } from './ht-protocol.js';
import { getTransport, PATH, PRIORITY } from './cgo-transport.js';
import { htAudioSynth } from './ht-audio-synth.js';

const BASE_AGENT_ID = 0;
const BASE_CALLSIGN = 'BASE';

class BasePTT {
  /**
   * @param {object} [options]
   * @param {object} [options.transport]
   * @param {Function} [options.onStateChange]
   * @param {Function} [options.onTransmit]
   * @param {number} [options.defaultChannel=0]
   * @param {number} [options.heartbeatMs=1500]
   * @param {boolean} [options.micEnabled=true]
   * @param {boolean} [options.sidetone=true]  dengar mic sendiri
   */
  constructor(options = {}) {
    this.transport = options.transport || null;
    this.onStateChange = options.onStateChange || null;
    this.onTransmit = options.onTransmit || null;
    this.channel = this._clampChannel(options.defaultChannel ?? 0);
    this.heartbeatMs = options.heartbeatMs ?? 1500;
    this.micEnabled = options.micEnabled !== false;
    this.sidetone = options.sidetone !== false;

    this.active = false;
    this.sequence = 0;
    this._timer = null;
    this._txBuffer = new Uint8Array(32);
    this._mediaStream = null;
    this._micSource = null;
    this._micGain = null;

    this.stats = { txCount: 0, lastTxAt: 0 };
  }

  setTransport(transport) {
    this.transport = transport;
  }

  setChannel(ch) {
    this.channel = this._clampChannel(ch);
    this._emit();
    if (this.active) this._transmit(true);
  }

  getChannel() {
    return this.channel;
  }

  isActive() {
    return this.active;
  }

  _clampChannel(ch) {
    const n = Number(ch);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(CHANNEL_COUNT - 1, Math.floor(n)));
  }

  /**
   * Mulai PTT (press) — minta mic + sidetone + flag paket.
   */
  async startPTT() {
    if (this.active) return true;

    // Pastikan AudioContext hidup (user gesture)
    try {
      await htAudioSynth.init();
      await htAudioSynth.resume();
    } catch { /* */ }

    this.active = true;
    this._emit();
    htAudioSynth.playSquelchOpen();
    this._transmit(true);

    if (this._timer) clearInterval(this._timer);
    this._timer = setInterval(() => {
      if (this.active) this._transmit(false);
    }, this.heartbeatMs);

    if (this.micEnabled) {
      await this._openMic();
    }

    return true;
  }

  stopPTT() {
    if (!this.active) return;

    this.active = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }

    this._transmit(true, false);
    this._closeMic();
    htAudioSynth.playRogerBeep();
    this._emit();
  }

  setMicEnabled(on) {
    this.micEnabled = !!on;
  }

  // ----------------------------------------------------------
  // MIC + SIDETONE
  // ----------------------------------------------------------

  async _openMic() {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      console.warn('[BasePTT] getUserMedia tidak tersedia');
      return;
    }

    try {
      this._mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      });

      // Sidetone: dengar suara sendiri lewat speaker (monitor)
      if (this.sidetone) {
        const ctx = htAudioSynth.getContext();
        if (ctx) {
          if (ctx.state === 'suspended') await ctx.resume();
          this._micSource = ctx.createMediaStreamSource(this._mediaStream);
          this._micGain = ctx.createGain();
          // Volume monitor rendah biar tidak feedback keras
          this._micGain.gain.value = 0.35;
          this._micSource.connect(this._micGain);
          this._micGain.connect(ctx.destination);
        }
      }
    } catch (err) {
      console.warn('[BasePTT] mic denied / unavailable:', err);
      this._mediaStream = null;
    }

    this._emit();
  }

  _closeMic() {
    if (this._micSource) {
      try { this._micSource.disconnect(); } catch { /* */ }
      this._micSource = null;
    }
    if (this._micGain) {
      try { this._micGain.disconnect(); } catch { /* */ }
      this._micGain = null;
    }
    if (this._mediaStream) {
      for (const t of this._mediaStream.getTracks()) t.stop();
      this._mediaStream = null;
    }
  }

  // ----------------------------------------------------------
  // TRANSMIT
  // ----------------------------------------------------------

  _transmit(force = false, pttActive = this.active) {
    const status = pttActive ? STATUS_FLAGS.PTT_ACTIVE : 0;

    const packet = encodeHTPacket({
      sequence: this.sequence,
      agentId: BASE_AGENT_ID,
      latitude: 0,
      longitude: 0,
      status,
      battery: 100,
      timestamp: Date.now(),
      signalQuality: 95,
      channel: this.channel,
      callsign: BASE_CALLSIGN,
      hopCount: 0
    }, this._txBuffer);

    this.sequence = (this.sequence + 1) & 0xFF;

    const payload = new Uint8Array(packet);
    const meta = {
      priority: pttActive ? PRIORITY.PTT : PRIORITY.NORMAL,
      ptt: pttActive,
      emergency: false,
      source: 'base',
      callsign: BASE_CALLSIGN,
      agentId: BASE_AGENT_ID,
      force
    };

    const transport = this.transport || null;
    if (transport && typeof transport.send === 'function') {
      transport.send(this.channel, payload, meta);
    } else if (typeof this.onTransmit === 'function') {
      this.onTransmit(this.channel, payload, meta);
    }

    this.stats.txCount++;
    this.stats.lastTxAt = Date.now();
    this.onTransmit?.(this.channel, payload, meta);
  }

  _emit() {
    this.onStateChange?.({
      active: this.active,
      channel: this.channel,
      callsign: BASE_CALLSIGN,
      agentId: BASE_AGENT_ID,
      micEnabled: this.micEnabled,
      hasMic: !!this._mediaStream
    });
  }

  getState() {
    return {
      active: this.active,
      channel: this.channel,
      callsign: BASE_CALLSIGN,
      hasMic: !!this._mediaStream,
      stats: { ...this.stats }
    };
  }

  dispose() {
    this.stopPTT();
    this.onStateChange = null;
    this.onTransmit = null;
    this.transport = null;
  }
}

let _basePtt = null;

function getBasePTT(options) {
  if (!_basePtt) {
    _basePtt = new BasePTT(options || {});
  } else if (options?.transport) {
    _basePtt.setTransport(options.transport);
  }
  return _basePtt;
}

export {
  BasePTT,
  getBasePTT,
  BASE_AGENT_ID,
  BASE_CALLSIGN,
  PATH,
  PRIORITY
};
