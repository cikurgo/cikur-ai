/* --------------------------------------------------------------------
 * NexusEvolution.js — The Unified Evolution (v2.0.0)
 *
 * Features
 *   • Telemetry HUD (FPS + RAM, visibility-aware, cross-browser)
 *   • Isolated sandbox exec via transient Worker (best-effort isolation)
 *   • TTS lip-sync amplitude bridge (window.u_audioAmp)
 *   • Public API on window.Nexus
 *
 * Usage
 *   await Nexus.secureExec('return 1 + 1', { timeoutMs: 3000 }); // → 2
 *   await Nexus.speak('Halo dunia', { voiceLang: 'id-ID' });     // → true
 *   Nexus.stopSpeaking();
 *   Nexus.destroy();
 *
 * ⚠ Security note
 *   The Worker sandbox is best-effort isolation — NOT a security boundary.
 *   JS running in the same origin can always escape via Function/eval
 *   constructor tricks. For hard isolation, use an iframe with
 *   sandbox="allow-scripts" (without allow-same-origin).
 * -------------------------------------------------------------------- */

(function () {
  'use strict';

  /* ---------------------------------------------------------------
   * Guard: prevent double initialization
   * --------------------------------------------------------------- */
  if (window.Nexus && window.Nexus.__version) {
    console.warn('[Nexus] Already initialized (v' + window.Nexus.__version + '). Skipping.');
    return;
  }

  const VERSION = '2.0.0';
  const TAG = '%c[Nexus]';
  const log  = (...a) => console.log(TAG, 'color:#0f0', ...a);
  const warn = (...a) => console.warn(TAG, 'color:#ff0', ...a);
  const err  = (...a) => console.error(TAG, 'color:#f00', ...a);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /* ===============================================================
   * 1. TELEMETRY HUD
   * =============================================================== */
  let hudEl = null;
  let hudRAF = null;
  let hudFrames = 0;
  let hudLastTick = performance.now();
  let hudFPS = 0;

  function buildHUD() {
    const existing = document.getElementById('nexus-hud');
    if (existing) { hudEl = existing; return; }

    hudEl = document.createElement('div');
    hudEl.id = 'nexus-hud';
    hudEl.setAttribute('role', 'status');
    hudEl.setAttribute('aria-live', 'polite');
    hudEl.style.cssText = [
      'position: fixed', 'top: 10px', 'right: 10px', 'z-index: 9998',
      'padding: 8px 12px', 'background: rgba(0,0,0,0.7)', 'color: #0f0',
      'font-family: monospace', 'font-size: 12px', 'border-radius: 4px',
      'pointer-events: none', 'box-shadow: 0 0 6px rgba(0,255,0,0.5)',
      'border: 1px solid #0f0',
      'transition: border-color .3s, color .3s, box-shadow .3s',
      'white-space: nowrap', 'user-select: none'
    ].join(';') + ';';
    (document.body || document.documentElement).appendChild(hudEl);
  }

  function hudTick() {
    hudFrames++;
    const now = performance.now();

    if (now - hudLastTick >= 1000) {
      hudFPS = Math.round(hudFrames * 1000 / (now - hudLastTick));
      hudFrames = 0;
      hudLastTick = now;

      let memPct = null;
      // performance.memory — Chrome/Edge only
      if (performance.memory && performance.memory.jsHeapSizeLimit) {
        memPct = Math.round(
          (performance.memory.usedJSHeapSize / performance.memory.jsHeapSizeLimit) * 100
        );
      }

      if (hudEl) {
        hudEl.textContent =
          '⚡ ' + hudFPS + ' FPS | 🧠 ' +
          (memPct === null ? 'n/a' : memPct + '% RAM');
        const danger = (memPct !== null && memPct > 80);
        hudEl.style.borderColor = danger ? 'red' : '#0f0';
        hudEl.style.color       = danger ? 'red' : '#0f0';
        hudEl.style.boxShadow   = danger
          ? '0 0 10px red'
          : '0 0 6px rgba(0,255,0,0.5)';
      }
    }
    hudRAF = requestAnimationFrame(hudTick);
  }

  function startHUD() {
    buildHUD();
    if (!hudRAF) {
      hudLastTick = performance.now();
      hudFrames   = 0;
      hudRAF      = requestAnimationFrame(hudTick);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startHUD, { once: true });
  } else {
    startHUD();
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      // Avoid FPS spike after tab re-focus
      hudLastTick = performance.now();
      hudFrames   = 0;
    }
  });

  /* ===============================================================
   * 2. ISOLATED SANDBOX (transient Worker per-exec)
   * =============================================================== */
  const SE_WORKER_CODE = `
    'use strict';

    // Capture safe references BEFORE shadowing anything
    const _self        = self;
    const _post        = _self.postMessage.bind(_self);
    const _close       = _self.close.bind(_self);
    const _fetch       = typeof _self.fetch === 'function' ? _self.fetch.bind(_self) : undefined;
    const _setTimeout  = _self.setTimeout.bind(_self);
    const _clearTimeout= _self.clearTimeout.bind(_self);

    let _timer = null;
    function _clearActive() {
      if (_timer) { _clearTimeout(_timer); _timer = null; }
    }

    _self.onmessage = async function (ev) {
      const data      = (ev && ev.data) || {};
      const id        = data.id;
      const code      = data.code;
      const timeoutMs = Math.max(100, Math.min(data.timeoutMs || 3000, 30000));

      if (typeof code !== 'string' || !code) {
        _post({ id: id, error: 'Invalid code payload (string required)' });
        return;
      }

      let dead = false;
      _clearActive();
      _timer = _setTimeout(function () {
        dead = true;
        try { _post({ id: id, error: 'Execution Timeout (' + timeoutMs + 'ms)' }); } catch (_) {}
        try { _close(); } catch (_) {}
      }, timeoutMs);

      try {
        const safeConsole = Object.freeze({
          log:   function () { console.log.apply(console, ['[sandbox]'].concat([].slice.call(arguments))); },
          warn:  function () { console.warn.apply(console, ['[sandbox]'].concat([].slice.call(arguments))); },
          error: function () { console.error.apply(console, ['[sandbox]'].concat([].slice.call(arguments))); }
        });

        const allowed = Object.freeze({
          fetch: _fetch,
          setTimeout: _setTimeout,
          clearTimeout: _clearTimeout,
          console: safeConsole,
          JSON: JSON, Math: Math, Date: Date,
          Promise: Promise, Map: Map, Set: Set,
          WeakMap: WeakMap, WeakSet: WeakSet,
          Array: Array, Object: Object, String: String, Number: Number,
          Boolean: Boolean, RegExp: RegExp, Symbol: Symbol,
          Error: Error, TypeError: TypeError, RangeError: RangeError,
          isNaN: isNaN, isFinite: isFinite,
          parseInt: parseInt, parseFloat: parseFloat,
          encodeURIComponent: encodeURIComponent,
          decodeURIComponent: decodeURIComponent
        });

        // Best-effort shadowing of common escape vectors.
        // NOT a security boundary — see file header.
        const fn = new Function(
          'allowed',
          'self', 'globalThis', 'postMessage', 'importScripts',
          'XMLHttpRequest', 'WebSocket', 'indexedDB', 'caches',
          'Worker', 'SharedWorker', 'navigator', 'location', 'close',
          '"use strict";\\n' + code
        );

        const ret = fn(
          allowed,
          undefined, undefined, undefined, undefined,
          undefined, undefined, undefined, undefined,
          undefined, undefined, undefined, undefined, undefined
        );

        const result = await Promise.resolve(ret);

        if (dead) return;
        _clearActive();
        _post({ id: id, result: result });   // may throw DataCloneError
      } catch (e) {
        if (dead) return;
        _clearActive();
        _post({ id: id, error: (e && e.message) ? e.message : String(e) });
      }
    };
  `;

  const SE_WORKER_URL = URL.createObjectURL(
    new Blob([SE_WORKER_CODE], { type: 'application/javascript' })
  );

  let _execSeq = 0;

  function secureExec(code, options) {
    options = options || {};
    return new Promise(function (resolve, reject) {

      if (typeof Worker === 'undefined') {
        return reject(new Error('Web Workers not supported in this environment'));
      }
      if (typeof code !== 'string' || !code.trim()) {
        return reject(new Error('secureExec: code must be a non-empty string'));
      }

      const timeoutMs = clamp(options.timeoutMs || 3000, 100, 30000);
      const id        = ++_execSeq;

      let worker  = null;
      let timer   = null;
      let settled = false;

      function finish(isError, value) {
        if (settled) return;
        settled = true;
        if (timer) { clearTimeout(timer); timer = null; }
        try { if (worker) worker.terminate(); } catch (_) {}
        if (isError) reject(value); else resolve(value);
      }

      try {
        worker = new Worker(SE_WORKER_URL);
      } catch (e) {
        return reject(new Error('Worker creation failed: ' + e.message));
      }

      timer = setTimeout(function () {
        finish(true, new Error('Main-thread timeout (worker killed)'));
      }, timeoutMs + 500);

      worker.onmessage = function (e) {
        const d = e && e.data;
        if (!d || d.id !== id) return;
        if (d.error) finish(true, new Error(d.error));
        else         finish(false, d.result);
      };

      worker.onerror = function (e) {
        try { if (e && e.preventDefault) e.preventDefault(); } catch (_) {}
        finish(true, new Error((e && e.message) || 'Worker error'));
      };

      worker.onmessageerror = function () {
        finish(true, new Error('Worker message deserialization error'));
      };

      try {
        worker.postMessage({ code: code, id: id, timeoutMs: timeoutMs });
      } catch (e) {
        finish(true, new Error('postMessage failed: ' + e.message));
      }
    });
  }

  /* ===============================================================
   * 3. EXPRESSION ENGINE (Lip-Sync amplitude)
   * =============================================================== */
  if (!window.u_audioAmp || typeof window.u_audioAmp !== 'object') {
    window.u_audioAmp = { value: 0 };
  }
  const ampRef = window.u_audioAmp;
  if (typeof ampRef.value !== 'number' || !isFinite(ampRef.value)) {
    ampRef.value = 0;
  }

  let ttsPlaying = false;
  let lipRAF     = null;

  function lipLoop() {
    let target = 0;

    if (ttsPlaying) {
      const t = performance.now() / 1000;
      // Two sine waves for natural-looking speech envelope
      const a = 0.5 + 0.5 * Math.sin(t * 13.7);
      const b = 0.5 + 0.5 * Math.sin(t * 6.3 + 1.7);
      target = 0.05 + (a * 0.6 + b * 0.4) * 0.95;
    }

    // Fast attack, slower release for natural mouth movement
    const factor = ttsPlaying ? 0.55 : 0.12;
    ampRef.value += (target - ampRef.value) * factor;
    if (ampRef.value < 0.005) ampRef.value = 0;

    lipRAF = requestAnimationFrame(lipLoop);
  }
  lipRAF = requestAnimationFrame(lipLoop);

  /* ===============================================================
   * 4. TEXT-TO-SPEECH
   * =============================================================== */
  let _currentUtterance = null;
  let _voicesPromise    = null;

  function getVoicesAsync() {
    return new Promise(function (resolve) {
      if (!('speechSynthesis' in window)) return resolve([]);

      const synth   = window.speechSynthesis;
      const initial = synth.getVoices();
      if (initial && initial.length) return resolve(initial);

      let done = false;
      function finish() {
        if (done) return;
        done = true;
        try { synth.removeEventListener('voiceschanged', finish); } catch (_) {}
        resolve(synth.getVoices() || []);
      }

      try { synth.addEventListener('voiceschanged', finish); } catch (_) {}
      setTimeout(finish, 1500);
    });
  }

  function pickVoice(voices, lang) {
    if (!voices || !voices.length) return null;

    const norm = function (s) {
      return String(s || '').toLowerCase().replace('_', '-');
    };
    const want     = norm(lang);
    const wantBase = want.split('-')[0];

    let v = voices.find(function (x) { return norm(x.lang) === want; });
    if (!v) v = voices.find(function (x) { return norm(x.lang).indexOf(wantBase) === 0; });
    if (!v) v = voices.find(function (x) { return x.default; });
    return v || voices[0];
  }

  async function speak(text, options) {
    options = options || {};

    if (!('speechSynthesis' in window)) {
      const e = new Error('Speech Synthesis not supported');
      warn('TTS not supported');
      if (options.onError) { try { options.onError(e); } catch (_) {} }
      return false;
    }
    if (typeof text !== 'string' || !text.trim()) {
      warn('speak(): text must be a non-empty string');
      return false;
    }

    const synth = window.speechSynthesis;
    try { synth.cancel(); } catch (_) {}
    try { if (synth.paused) synth.resume(); } catch (_) {}

    if (!_voicesPromise) _voicesPromise = getVoicesAsync();
    const voices = await _voicesPromise;
    const voice  = pickVoice(voices, options.voiceLang || 'id-ID');

    const u = new SpeechSynthesisUtterance(text);
    if (voice) { u.voice = voice; u.lang = voice.lang; }
    u.rate   = clamp(options.rate   != null ? options.rate   : 0.85, 0.1, 10);
    u.pitch  = clamp(options.pitch  != null ? options.pitch  : 0.55, 0, 2);
    u.volume = clamp(options.volume != null ? options.volume : 1, 0, 1);

    // Keep reference — Chrome GC bug terminates speech otherwise
    _currentUtterance = u;

    u.onstart = function () {
      ttsPlaying = true;
      log('Speaking:', text.length > 48 ? text.slice(0, 48) + '…' : text);
      if (options.onStart) { try { options.onStart(); } catch (_) {} }
    };

    u.onend = function () {
      ttsPlaying = false;
      if (_currentUtterance === u) _currentUtterance = null;
      if (options.onEnd) { try { options.onEnd(); } catch (_) {} }
    };

    u.onerror = function (ev) {
      ttsPlaying = false;
      if (_currentUtterance === u) _currentUtterance = null;
      const code = ev && ev.error;
      // Expected lifecycle events — not real errors
      if (code === 'interrupted' || code === 'canceled') return;
      err('TTS error:', code || ev);
      if (options.onError) {
        try { options.onError(new Error(code || 'TTS error')); } catch (_) {}
      }
    };

    try {
      synth.speak(u);
      return true;
    } catch (e) {
      ttsPlaying = false;
      _currentUtterance = null;
      if (options.onError) { try { options.onError(e); } catch (_) {} }
      return false;
    }
  }

  function stopSpeaking() {
    try {
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    } catch (_) {}
    ttsPlaying = false;
    _currentUtterance = null;
  }

  /* ===============================================================
   * 5. LIFECYCLE + PUBLIC API
   * =============================================================== */
  function destroy() {
    stopSpeaking();
    if (lipRAF) { cancelAnimationFrame(lipRAF); lipRAF = null; }
    if (hudRAF) { cancelAnimationFrame(hudRAF); hudRAF = null; }
    if (hudEl && hudEl.parentNode) hudEl.parentNode.removeChild(hudEl);
    hudEl = null;
    try { URL.revokeObjectURL(SE_WORKER_URL); } catch (_) {}
    log('Destroyed');
  }

  const Nexus = {
    __version:     VERSION,
    secureExec:    secureExec,
    speak:         speak,
    stopSpeaking:  stopSpeaking,
    destroy:       destroy,
    isSpeaking:    function () { return ttsPlaying; }
  };

  Object.defineProperty(Nexus, 'audioAmp', {
    get: function () { return ampRef.value; },
    enumerable: true,
    configurable: false
  });

  window.Nexus = Object.freeze(Nexus);

  log('Loaded v' + VERSION + ' — HUD · Sandbox · Lip-Sync ready.');
})();
