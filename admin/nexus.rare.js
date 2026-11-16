/* ────────────────────────────────────────────────────────────────────────
 *  File: nexus.rare.js  (v2.0 — Bulletproof Edition)
 *
 *  Nexus Rare Code — robust, high-entropy, sync & async code generator.
 *
 *  Design goals
 *  ────────────
 *   • 128-bit cryptographic nonce (crypto.getRandomValues → 4× uint32)
 *   • Strong avalanche mixing  (MurmurHash3 finalizer)
 *   • Logistic-map chaos diffusion (R=3.99, 2 inner passes × 4 words)
 *   • Sync and Async paths are byte-for-byte identical algorithms
 *   • Defensive fallbacks: crypto → timing + counter + Math.random
 *   • No leaked workers, no leaked Blob URLs, no unhandled rejections
 *   • Works in browser (main + worker), Node, Deno, Bun, globalThis
 *   • Every failure mode has an explicit recovery path
 * ──────────────────────────────────────────────────────────────────────── */
(() => {
  'use strict';

  /* ─── Config ────────────────────────────────────────────────────────── */
  const LOGISTIC_R        = 3.99;        // edge-of-chaos
  const ITERATIONS        = 4;           // number of 32-bit output words
  const INNER_ITER        = 2;           // logistic steps per word
  const UINT32_MAX        = 0xFFFFFFFF;
  const HEX_SIZE          = 8;           // hex chars per word  (4×8 = 32 total)
  const NONCE_WORDS       = 4;           // 4×32 = 128-bit nonce
  const WORKER_TIMEOUT_MS = 5000;

  /* ─── Global reference (works everywhere) ──────────────────────────── */
  const G = (typeof globalThis !== 'undefined') ? globalThis
          : (typeof self       !== 'undefined') ? self
          : (typeof window     !== 'undefined') ? window
          : (typeof global     !== 'undefined') ? global
          : {};

  /* ─── Mixing primitives (MurmurHash3 finalizer — strong avalanche) ── */
  const mix32 = (h) => {
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return (h ^ (h >>> 16)) >>> 0;
  };
  const mix = (a, b) => mix32(((a >>> 0) + (b >>> 0)) >>> 0);

  /* ─── Entropy collectors ───────────────────────────────────────────── */
  let _counter = 0;

  const nowUint32 = () => {
    try {
      if (typeof performance !== 'undefined'
       && typeof performance.now === 'function') {
        return Math.floor(performance.now() * 1000) >>> 0;
      }
    } catch (_) { /* ignore */ }
    return Date.now() >>> 0;
  };

  const weakRandomUint32 = () => {
    try { return Math.floor(Math.random() * 0x100000000) >>> 0; }
    catch (_) { return 0; }
  };

  /** Returns a Uint32Array of length NONCE_WORDS (4 = 128 bits). */
  const collectNonce = () => {
    // Preferred: 128-bit cryptographically-secure nonce
    try {
      const c = G.crypto || (typeof crypto !== 'undefined' ? crypto : null);
      if (c && typeof c.getRandomValues === 'function') {
        const buf = new Uint32Array(NONCE_WORDS);
        c.getRandomValues(buf);
        return buf;
      }
    } catch (_) { /* fall through to weak fallback */ }

    // Fallback: timing jitter + monotonic counter + weak PRNG
    const ctr = (++_counter) >>> 0;
    const t1  = nowUint32();
    const t2  = nowUint32();
    const r1  = weakRandomUint32();
    const r2  = weakRandomUint32();
    return new Uint32Array([
      mix(t1, ctr),
      mix(t2, r1),
      mix(ctr, r2),
      mix(t1 ^ t2, r1 ^ r2),
    ]);
  };

  /* ─── Seed normalisation ───────────────────────────────────────────── */
  const normalizeSeed = (seed) => {
    const n = (typeof seed === 'number') ? seed : Number(seed);
    if (!Number.isFinite(n)) {
      throw new TypeError('NexusRareCode: seed must be a finite number');
    }
    return n >>> 0;
  };

  /* ─── Core generator (single source of truth) ──────────────────────── */
  const generateCore = (seedUint32, nonce) => {
    const parts = new Array(ITERATIONS);
    for (let i = 0; i < ITERATIONS; i++) {
      // Fold seed + one nonce word + index → 32-bit chain state
      let state = mix(seedUint32, mix(nonce[i], i));
      // x ∈ (0, 1)
      let x = (state >>> 1) / 0x80000000;
      if (!(x > 0) || x >= 1) x = 0.123456;
      // Chaos diffusion
      for (let j = 0; j < INNER_ITER; j++) {
        x = LOGISTIC_R * x * (1 - x);
      }
      const raw = Math.floor(x * UINT32_MAX) >>> 0;
      const out = mix32((state ^ raw) >>> 0);
      parts[i] = out.toString(16).slice(-HEX_SIZE).padStart(HEX_SIZE, '0');
    }
    return parts.join('');
  };

  /* ─── Sync public API ──────────────────────────────────────────────── */
  const generate = (seed) => generateCore(normalizeSeed(seed), collectNonce());

  /* ─── Worker source (byte-for-byte mirrors generateCore) ───────────── */
  const WORKER_SRC = `
    'use strict';
    const LOGISTIC_R = ${LOGISTIC_R};
    const ITERATIONS = ${ITERATIONS};
    const INNER_ITER = ${INNER_ITER};
    const UINT32_MAX = ${UINT32_MAX};
    const HEX_SIZE   = ${HEX_SIZE};
    const mix32 = (h) => {
      h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
      h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
      return (h ^ (h >>> 16)) >>> 0;
    };
    const mix = (a, b) => mix32(((a >>> 0) + (b >>> 0)) >>> 0);
    self.onmessage = (e) => {
      const id = e.data && e.data.id;
      try {
        const seedUint32 = e.data.seedUint32 >>> 0;
        const nonce      = e.data.nonce;
        const parts = new Array(ITERATIONS);
        for (let i = 0; i < ITERATIONS; i++) {
          let state = mix(seedUint32, mix(nonce[i], i));
          let x = (state >>> 1) / 0x80000000;
          if (!(x > 0) || x >= 1) x = 0.123456;
          for (let j = 0; j < INNER_ITER; j++) {
            x = LOGISTIC_R * x * (1 - x);
          }
          const raw = Math.floor(x * UINT32_MAX) >>> 0;
          const out = mix32((state ^ raw) >>> 0);
          parts[i] = out.toString(16).slice(-HEX_SIZE).padStart(HEX_SIZE, '0');
        }
        self.postMessage({ id, ok: true, value: parts.join('') });
      } catch (err) {
        self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
      }
    };
  `;

  /* ─── Worker lifecycle ─────────────────────────────────────────────── */
  let   _worker       = null;
  let   _workerUrl    = null;
  let   _workerBroken = false;
  let   _msgSeq       = 0;
  const _pending      = new Map();   // id → { resolve, reject, timer }

  const workerSupported = () => {
    try {
      return typeof Worker    !== 'undefined'
          && typeof Blob      !== 'undefined'
          && typeof URL       !== 'undefined'
          && typeof URL.createObjectURL === 'function';
    } catch (_) { return false; }
  };

  const rejectAll = (reason) => {
    for (const { reject, timer } of _pending.values()) {
      try { clearTimeout(timer); } catch (_) {}
      try { reject(reason); }      catch (_) {}
    }
    _pending.clear();
  };

  const destroyWorker = () => {
    if (_worker)    { try { _worker.terminate(); }    catch (_) {} _worker = null; }
    if (_workerUrl) { try { URL.revokeObjectURL(_workerUrl); } catch (_) {} _workerUrl = null; }
  };

  const teardownWorker = () => {
    destroyWorker();
    rejectAll(new Error('NexusRareCode: worker torn down'));
  };

  const failWorker = (reason) => {
    _workerBroken = true;
    destroyWorker();
    rejectAll(reason);
  };

  const spawnWorker = () => {
    if (_worker) return _worker;
    if (_workerBroken || !workerSupported()) return null;
    try {
      const blob   = new Blob([WORKER_SRC], { type: 'application/javascript' });
      _workerUrl   = URL.createObjectURL(blob);
      const w      = new Worker(_workerUrl);

      w.onmessage = (e) => {
        const data = e && e.data;
        if (!data || data.id == null) return;
        const slot = _pending.get(data.id);
        if (!slot) return;                          // already timed-out
        _pending.delete(data.id);
        try { clearTimeout(slot.timer); } catch (_) {}
        if (data.ok) slot.resolve(data.value);
        else         slot.reject(new Error(data.error || 'worker error'));
      };
      w.onerror = (ev) => {
        failWorker(new Error(
          'NexusRareCode worker error: ' + ((ev && ev.message) || 'unknown')));
      };
      w.onmessageerror = () => {
        failWorker(new Error('NexusRareCode: worker message error'));
      };

      _worker = w;
      return w;
    } catch (_) {
      _workerBroken = true;
      if (_workerUrl) { try { URL.revokeObjectURL(_workerUrl); } catch (_) {} _workerUrl = null; }
      return null;
    }
  };

  /* ─── Async public API (Worker + transparent sync fallback) ────────── */
  const generateAsync = (seed) => new Promise((resolve, reject) => {
    let s;
    try { s = normalizeSeed(seed); }
    catch (err) { reject(err); return; }

    const nonce = collectNonce();
    const w     = spawnWorker();

    // No worker available → generate synchronously (same algorithm, same quality)
    if (!w) {
      try { resolve(generateCore(s, nonce)); }
      catch (err) { reject(err); }
      return;
    }

    const id = (++_msgSeq) >>> 0;

    const timer = setTimeout(() => {
      if (_pending.has(id)) {
        _pending.delete(id);
        try { reject(new Error('NexusRareCode: worker timeout')); } catch (_) {}
        failWorker(new Error('NexusRareCode: worker timeout'));
      }
    }, WORKER_TIMEOUT_MS);

    _pending.set(id, { resolve, reject, timer });

    try {
      w.postMessage({ id, seedUint32: s, nonce });
    } catch (_) {
      // postMessage failed (worker just died) → sync fallback
      _pending.delete(id);
      try { clearTimeout(timer); } catch (_) {}
      try { resolve(generateCore(s, nonce)); }
      catch (err) { reject(err); }
    }
  });

  /* ─── Cleanup on page unload (idempotent) ─────────────────────────── */
  try {
    const add = (typeof G.addEventListener === 'function')
      ? G.addEventListener.bind(G)
      : (typeof addEventListener === 'function' ? addEventListener : null);
    if (add) {
      add('pagehide',     teardownWorker);
      add('beforeunload', teardownWorker);
    }
  } catch (_) { /* ignore */ }

  /* ─── Public export (frozen) ──────────────────────────────────────── */
  const exporter = Object.freeze({
    generate,                     // sync
    generateSync: generate,       // alias
    generateAsync,                // async (Web Worker w/ fallback)
    workerSupported,              // diagnostics helper
    VERSION: '2.0.0',
  });

  try { G.NexusRareCode = exporter; } catch (_) {}
})();
