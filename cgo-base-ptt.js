/**
 * cgo-base-ptt.js
 * ============================================================
 * PTT terpusat (BASE) — operator di pusat membalas ke channel
 *
 * Fase 1: flag + log (tanpa stream audio penuh)
 *   - pilih channel
 *   - press-and-hold PTT
 *   - kirim paket HT sebagai BASE (agentId 0)
 *   - lewat transport (sat/local/auto) sama seperti agent
 *
 * EXPORTS: BasePTT, getBasePTT
 * ============================================================
 */

import { encodeHTPacket, STATUS_FLAGS, CHANNEL_COUNT } from './ht-protocol.js';
import { getTransport, PATH, PRIORITY } from './cgo-transport.js';

const BASE_AGENT_ID = 0;
const BASE_CALLSIGN = 'BASE';

class BasePTT {
  /**
   * @param {object} [options]
   * @param {object} [options.transport]
   * @param {Function} [options.onStateChange] (state) => void
   * @param {Function} [options.onTransmit] (channel, payload, meta) => void
   * @param {number} [options.defaultChannel=0]
   * @param {number} [options.heartbeatMs=1500]  repeat while PTT held
   */
  constructor(options = {}) {
    this.transport = options.transport || null;
    this.onStateChange = options.onStateChange || null;
    this.onTransmit = options.onTransmit || null;
    this.channel = options.defaultChannel ?? 0;
    this.heartbeatMs = options.heartbeatMs ?? 1500;

    this.active = false;
    this.sequence = 0;
    this._timer = null;
    this._txBuffer = new Uint8Array(32);
    this.micEnabled = false;
    this._mediaStream = null;

    this.stats = { txCount: 0, lastTxAt: 0 };
  }

  setTransport(transport) {
    this.transport = transport;
  }

  setChannel(ch) {
    const n = Math.max(0, Math.min(CHANNEL_COUNT - 1, Number(ch) || 0));
    this.channel = n;
    this._emit();
    // Jika sedang PTT, kirim ulang di channel baru
    if (this.active) this._transmit(true);
  }

  getChannel() {
    return this.channel;
  }

  isActive() {
    return this.active;
  }

  /**
   * Mulai PTT (press).
   * @returns {Promise<boolean>}
   */
  async startPTT() {
    if (this.active) return true;

    this.active = true;
    this._emit();
    this._transmit(true);

    if (this._timer) clearInterval(this._timer);
    this._timer = setInterval(() => {
      if (this.active) this._transmit(false);
    }, this.heartbeatMs);

    // Opsional: minta mic (fase 2 siap; fase 1 tidak wajib stream)
    if (this.micEnabled && typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia) {
      try {
        this._mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: false
        });
      } catch (err) {
        console.warn('[BasePTT] mic denied / unavailable:', err);
      }
    }

    return true;
  }

  /**
   * Akhiri PTT (release).
   */
  stopPTT() {
    if (!this.active) return;

    this.active = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }

    // Kirim sekali tanpa PTT flag = "OVER"
    this._transmit(true, false);

    if (this._mediaStream) {
      for (const t of this._mediaStream.getTracks()) t.stop();
      this._mediaStream = null;
    }

    this._emit();
  }

  /**
   * Toggle mic capture (persiapan audio fase 2).
   */
  setMicEnabled(on) {
    this.micEnabled = !!on;
  }

  // ----------------------------------------------------------
  // INTERNAL
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

    const transport = this.transport || (typeof getTransport === 'function' ? getTransport() : null);

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
