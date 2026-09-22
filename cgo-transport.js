/**
 * cgo-transport.js
 * ============================================================
 * Transport abstrak + Outbox untuk BCGO
 *
 * Tujuan: agent/kirim tidak peduli jalur.
 *   - LOCAL  : langsung ke gateway (sim / RF lokal)
 *   - SAT    : lewat cgo-satellite-virtual (Iridium-like)
 *   - AUTO   : coba sat jika TRACKING, else antri
 *
 * Pesan tidak hilang: masuk outbox → retry sampai ACK / maxAttempt.
 * Emergency & PTT diprioritaskan.
 *
 * DEPS: cgo-satellite-virtual, cgo-ht-radio-engine (opsional)
 * EXPORTS: CgoTransport, getTransport, PRIORITY, PATH
 * ============================================================
 */

import {
  updateSatelliteLink,
  getSatelliteLink,
  resetSatelliteLink,
  PHYSICS_MODE,
  SAT_STATE
} from './cgo-satellite-virtual.js';
import { getPhysicalSatellite } from './cgo-satellite-physical.js';

// Lazy gateway import agar tetap portable jika engine belum ada
function resolveGateway() {
  try {
    // dynamic-ish: gunakan global singleton jika sudah di-load
    if (typeof globalThis !== 'undefined' && globalThis.__cgoGateway) {
      return globalThis.__cgoGateway;
    }
  } catch { /* noop */ }
  return null;
}

// ============================================================
// KONSTANTA
// ============================================================

const PATH = Object.freeze({
  LOCAL: 'local',
  SAT: 'sat',
  AUTO: 'auto',
  PHYSICAL: 'physical'
});

const PRIORITY = Object.freeze({
  NORMAL: 0,
  PTT: 10,
  EMERGENCY: 100
});

const DEFAULTS = Object.freeze({
  path: PATH.AUTO,
  maxOutbox: 64,
  maxAttempts: 8,
  retryBaseMs: 2000,
  retryMaxMs: 60_000,
  flushIntervalMs: 500,
  satTickMs: 100,
  /** Mode satelit: ideal | realistic | stress */
  satMode: PHYSICS_MODE.REALISTIC,
  /**
   * Constellation-ish: gap antar-pass jauh lebih pendek
   * supaya terasa "selalu ada satelit di langit"
   */
  constellation: true,
  constellationInterPassMinMs: 5_000,
  constellationInterPassMaxMs: 25_000,
  physicalSatellite: null
});

// ============================================================
// OUTBOX ITEM
// ============================================================

/**
 * @typedef {object} OutboxItem
 * @property {string} id
 * @property {number} channel
 * @property {Uint8Array} payload
 * @property {number} priority
 * @property {number} attempts
 * @property {number} createdAt
 * @property {number} nextAttemptAt
 * @property {object} [meta]
 */

function makeId() {
  return `tx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function copyPayload(payload) {
  if (payload instanceof Uint8Array) {
    const out = new Uint8Array(payload.byteLength);
    out.set(payload);
    return out;
  }
  return new Uint8Array(payload);
}

// ============================================================
// TRANSPORT
// ============================================================

class CgoTransport {
  /**
   * @param {object} [options]
   * @param {string} [options.path]
   * @param {Function} [options.onDeliver]  (channel, payload, meta) => boolean|void
   * @param {Function} [options.onQueued]   (item) => void
   * @param {Function} [options.onDrop]     (item, reason) => void
   * @param {Function} [options.onAck]      (item, path) => void
   * @param {object}   [options.gateway]    VirtualRadioGateway instance
   * @param {boolean}  [options.constellation]
   * @param {string}   [options.satMode]
   */
  constructor(options = {}) {
    this.opts = { ...DEFAULTS, ...options };
    this.outbox = [];
    this.running = false;
    this._flushTimer = null;
    this._satTimer = null;
    this._lastSatResult = null;
    this.stats = {
      enqueued: 0,
      delivered: 0,
      dropped: 0,
      satOk: 0,
      satFail: 0,
      localOk: 0,
      sinkMissing: 0,
      physicalOk: 0,
      physicalFail: 0
    };

    this.onDeliver = options.onDeliver ?? null;
    this.onQueued = options.onQueued ?? null;
    this.onDrop = options.onDrop ?? null;
    this.onAck = options.onAck ?? null;
    this.gateway = options.gateway ?? null;
    this.physicalSatellite = options.physicalSatellite ?? this.opts.physicalSatellite ?? null;

    // Init satellite link (constellation → gap pendek)
    this._initSatellite();
  }

  _initSatellite() {
    const satOpts = {
      mode: this.opts.satMode,
      passDurationSec: 550
    };
    resetSatelliteLink(satOpts);

    // Patch inter-pass bila constellation
    if (this.opts.constellation) {
      try {
        const { channel } = getSatelliteLink();
        // Override gap generator via monkey-patch tick end — lebih aman:
        // simpan preferensi; channel pakai konstanta internal.
        // Kita override INTER_PASS saat reset channel dengan wrapper.
        const origTick = channel.tick.bind(channel);
        const minG = this.opts.constellationInterPassMinMs;
        const maxG = this.opts.constellationInterPassMaxMs;
        channel.tick = (deltaMs, now) => {
          const wasInPass = channel.inPass;
          const result = origTick(deltaMs, now);
          // Setelah baru keluar pass, perkecil gap
          if (wasInPass && !channel.inPass && channel.interPassRemaining > maxG) {
            channel.interPassRemaining =
              minG + Math.random() * (maxG - minG);
          }
          return result;
        };
      } catch (err) {
        console.warn('[Transport] constellation patch skip:', err);
      }
    }
  }

  // ----------------------------------------------------------
  // LIFECYCLE
  // ----------------------------------------------------------

  start() {
    if (this.running) return;
    this.running = true;

    this._satTimer = setInterval(() => {
      try {
        this._lastSatResult = updateSatelliteLink(this.opts.satTickMs);
      } catch (err) {
        console.error('[Transport] sat tick:', err);
      }
    }, this.opts.satTickMs);

    this._flushTimer = setInterval(() => {
      void this.flush().catch(err => console.error('[Transport] flush:', err));
    }, this.opts.flushIntervalMs);
  }

  stop() {
    this.running = false;
    if (this._satTimer) {
      clearInterval(this._satTimer);
      this._satTimer = null;
    }
    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
  }

  reset() {
    this.outbox.length = 0;
    this.stats = {
      enqueued: 0,
      delivered: 0,
      dropped: 0,
      satOk: 0,
      satFail: 0,
      localOk: 0,
      sinkMissing: 0,
      physicalOk: 0,
      physicalFail: 0
    };
    this._initSatellite();
  }

  // ----------------------------------------------------------
  // PUBLIC SEND
  // ----------------------------------------------------------

  /**
   * Kirim paket — tidak hilang: masuk outbox jika belum bisa.
   *
   * @param {number} channel
   * @param {Uint8Array} payload
   * @param {object} [meta]
   * @param {number} [meta.priority]
   * @param {boolean} [meta.emergency]
   * @param {boolean} [meta.ptt]
   * @param {string} [meta.path]  override path untuk item ini
   * @returns {{ id: string, queued: boolean, delivered: boolean }}
   */
  async send(channel, payload, meta = {}) {
    const normalizedChannel = Number(channel);
    if (!Number.isInteger(normalizedChannel) || normalizedChannel < 0 || normalizedChannel >= 256) {
      throw new RangeError('[Transport] channel harus integer 0..255');
    }
    if (!(payload instanceof Uint8Array) || payload.byteLength !== 32) {
      throw new TypeError('[Transport] payload harus Uint8Array 32-byte');
    }

    let priority = meta.priority ?? PRIORITY.NORMAL;
    if (meta.emergency) priority = Math.max(priority, PRIORITY.EMERGENCY);
    if (meta.ptt) priority = Math.max(priority, PRIORITY.PTT);

    const item = {
      id: makeId(),
      channel: normalizedChannel,
      payload: copyPayload(payload),
      priority,
      attempts: 0,
      createdAt: Date.now(),
      nextAttemptAt: 0,
      meta: { ...meta }
    };

    // Coba langsung
    const delivered = await this._tryDeliver(item);
    if (delivered) {
      this.stats.delivered++;
      this.onAck?.(item, item._lastPath || this.opts.path);
      return { id: item.id, queued: false, delivered: true };
    }

    // Antri
    this._enqueue(item);
    return { id: item.id, queued: true, delivered: false };
  }

  /**
   * Convenience: kirim dengan prioritas emergency.
   */
  sendEmergency(channel, payload, meta = {}) {
    return this.send(channel, payload, { ...meta, emergency: true });
  }

  // ----------------------------------------------------------
  // OUTBOX
  // ----------------------------------------------------------

  _enqueue(item) {
    // Cap size — drop lowest priority oldest
    if (this.outbox.length >= this.opts.maxOutbox) {
      this.outbox.sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
      const dropped = this.outbox.shift();
      if (dropped) {
        this.stats.dropped++;
        this.onDrop?.(dropped, 'outbox_full');
      }
    }

    this.outbox.push(item);
    this.stats.enqueued++;
    // Sort: priority desc, lalu createdAt asc
    this.outbox.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
    this.onQueued?.(item);
  }

  /**
   * Coba kirim semua yang sudah waktunya.
   * @returns {number} jumlah berhasil
   */
  async flush() {
    if (!this.outbox.length) return 0;

    const now = Date.now();
    let ok = 0;
    const remain = [];

    for (const item of this.outbox) {
      if (item.nextAttemptAt > now) {
        remain.push(item);
        continue;
      }

      const delivered = await this._tryDeliver(item);
      if (delivered) {
        ok++;
        this.stats.delivered++;
        this.onAck?.(item, item._lastPath || this.opts.path);
        continue;
      }

      item.attempts++;
      if (item.attempts >= this.opts.maxAttempts) {
        this.stats.dropped++;
        this.onDrop?.(item, 'max_attempts');
        continue;
      }

      // Exponential backoff
      const backoff = Math.min(
        this.opts.retryMaxMs,
        this.opts.retryBaseMs * Math.pow(2, item.attempts - 1)
      );
      item.nextAttemptAt = now + backoff + Math.random() * 500;
      remain.push(item);
    }

    this.outbox = remain;
    this.outbox.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
    return ok;
  }

  // ----------------------------------------------------------
  // DELIVER
  // ----------------------------------------------------------

  /**
   * @param {OutboxItem} item
   * @returns {boolean}
   */
  async _tryDeliver(item) {
    const path = item.meta?.path || this.opts.path;

    if (path === PATH.LOCAL) {
      return this._deliverLocal(item);
    }
    if (path === PATH.SAT) {
      return this._deliverSat(item);
    }
    if (path === PATH.PHYSICAL) {
      return await this._deliverPhysical(item);
    }
    // AUTO: sat dulu jika bagus, else local (sim), else fail → queue
    if (this._satIsGood()) {
      if (this._deliverSat(item)) return true;
    }
    // AUTO tidak diam-diam menganggap physical tersedia. Jika adapter terhubung,
    // physical menjadi jalur nyata yang boleh dicoba setelah virtual SAT gagal.
    if (this.physicalSatellite?.isConnected?.()) {
      if (await this._deliverPhysical(item)) return true;
    }
    // Fallback local (berguna di test bench / near base)
    if (this._deliverLocal(item)) return true;
    return false;
  }

  _satIsGood() {
    const r = this._lastSatResult;
    if (!r) return false;
    if (r.state !== SAT_STATE.TRACKING && r.state !== SAT_STATE.DEGRADED) return false;
    if (r.state === SAT_STATE.TRACKING) return true;
    // DEGRADED: izinkan dengan probabilitas rendah / emergency
    return r.packetValid === true;
  }

  _deliverSat(item) {
    // Tick sekali agar state segar
    try {
      this._lastSatResult = updateSatelliteLink(this.opts.satTickMs);
    } catch { /* keep last */ }

    const r = this._lastSatResult;
    if (!r || !r.metrics?.inPass) {
      this.stats.satFail++;
      return false;
    }

    // TRACKING: hormati packetValid dari model PER
    if (r.state === SAT_STATE.TRACKING) {
      if (r.packetValid === false) {
        this.stats.satFail++;
        return false;
      }
    } else if (r.state === SAT_STATE.DEGRADED) {
      // Emergency tetap dipaksa coba; normal butuh packetValid
      if (item.priority < PRIORITY.EMERGENCY && r.packetValid === false) {
        this.stats.satFail++;
        return false;
      }
    } else {
      this.stats.satFail++;
      return false;
    }

    const ok = this._handToGateway(item, 'sat');
    if (ok) this.stats.satOk++;
    else this.stats.satFail++;
    return ok;
  }


  async _deliverPhysical(item) {
    const sat = this.physicalSatellite || getPhysicalSatellite();
    if (!sat || typeof sat.sendPacket !== 'function' || !sat.isConnected?.()) {
      this.stats.satFail++;
      return false;
    }
    try {
      const result = await sat.sendPacket(item.payload, {
        channel: item.channel,
        priority: item.priority,
        emergency: item.meta?.emergency === true,
        ptt: item.meta?.ptt === true,
        agentId: item.meta?.agentId ?? null,
        callsign: item.meta?.callsign ?? null
      });
      if (result === true || result?.delivered === true || result?.success === true) {
        this.stats.physicalOk = (this.stats.physicalOk || 0) + 1;
        item._lastPath = PATH.PHYSICAL;
        return true;
      }
      this.stats.physicalFail = (this.stats.physicalFail || 0) + 1;
      return false;
    } catch (err) {
      this.stats.physicalFail = (this.stats.physicalFail || 0) + 1;
      this.onDrop?.(item, 'physical_error');
      return false;
    }
  }

  _deliverLocal(item) {
    const ok = this._handToGateway(item, 'local');
    if (ok) this.stats.localOk++;
    return ok;
  }

  _handToGateway(item, pathUsed) {
    item._lastPath = pathUsed;

    // 1) Custom deliver hook
    if (typeof this.onDeliver === 'function') {
      try {
        const result = this.onDeliver(item.channel, item.payload, {
          ...item.meta,
          path: pathUsed,
          transportId: item.id
        });
        if (result === false) return false;
        return true;
      } catch (err) {
        console.error('[Transport] onDeliver error:', err);
        return false;
      }
    }

    // 2) Gateway instance
    const gw = this.gateway || resolveGateway();
    if (gw && typeof gw.receive === 'function') {
      try {
        return gw.receive(item.channel, item.payload) === true;
      } catch (err) {
        console.error('[Transport] gateway.receive error:', err);
        return false;
      }
    }

    // 3) Tidak ada sink bukan delivery sukses.
    // Paket tetap berada di outbox agar tidak ada ACK palsu.
    this.stats.sinkMissing++;
    if (typeof console !== 'undefined' && console.debug) {
      console.debug('[Transport] no delivery sink', pathUsed, item.channel, item.id);
    }
    return false;
  }

  // ----------------------------------------------------------
  // STATUS
  // ----------------------------------------------------------

  getSatelliteStatus() {
    const r = this._lastSatResult;
    if (!r) return null;
    return {
      state: r.state,
      lqm: r.lqm === -Infinity ? null : r.lqm,
      inPass: r.metrics?.inPass ?? false,
      elevation: r.metrics?.elevationDeg ?? null,
      packetValid: r.packetValid ?? false,
      per: r.per ?? null
    };
  }

  getOutboxSize() {
    return this.outbox.length;
  }

  getStats() {
    return {
      ...this.stats,
      outbox: this.outbox.length,
      path: this.opts.path,
      constellation: this.opts.constellation,
      physicalConnected: !!this.physicalSatellite?.isConnected?.(),
      satellite: this.getSatelliteStatus()
    };
  }
}

// ============================================================
// SINGLETON
// ============================================================

let _transport = null;

function getTransport(options) {
  if (!_transport) {
    _transport = new CgoTransport(options || {});
  } else if (options && options.gateway) {
    _transport.gateway = options.gateway;
  }
  return _transport;
}

function resetTransport(options) {
  if (_transport) _transport.stop();
  _transport = new CgoTransport(options || {});
  return _transport;
}

export {
  CgoTransport,
  getTransport,
  resetTransport,
  PATH,
  PRIORITY,
  DEFAULTS
};
