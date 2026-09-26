/*
 * CGO AI VOICE OPERATOR — FEMALE AIRPORT-STYLE LOCAL VOICE
 * Primary: SpeechSynthesis female id-ID (clear, measured, airport PA style)
 * Fallback: local MP3 (./audio/cgo-operator/ then ./)
 * No external TTS/API. No male voice.
 * Version: 2.2.0-FEMALE-AIRPORT-OPERATOR
 */
(function () {
  'use strict';

  const BUILD = 'CIKUR-GO-VOICE-OPERATOR-2.2.0-FEMALE-AIRPORT';
  const VERSION = '2.2.0-FEMALE-AIRPORT-OPERATOR';
  const ROOTS = ['./audio/cgo-operator/', './', '../audio/cgo-operator/'];
  const FILES = Object.freeze({
    welcome: 'welcome.mp3',
    live: 'live.mp3',
    processing: 'processing.mp3',
    valid: 'valid.mp3',
    warning: 'warning.mp3',
    error: 'error.mp3',
    standby: 'standby.mp3',
    stageA: 'stageA.mp3',
    stageB: 'stageB.mp3',
    stageC: 'stageC.mp3',
    stageD: 'stageD.mp3'
  });
  // Teks operator bandara — singkat, jelas, formal
  const TEXT = Object.freeze({
    welcome: 'Selamat datang di sistem internal CIKUR GO. Operator siap.',
    live: 'Input langsung diterima. Memproses data.',
    processing: 'Pemrosesan dimulai. Mohon tunggu.',
    valid: 'Analisis selesai. Hasil telah divalidasi.',
    warning: 'Perhatian. Sistem memerlukan pemeriksaan.',
    error: 'Terjadi kesalahan pada sistem. Silakan periksa.',
    standby: 'Sistem kembali ke mode siaga.',
    stageA: 'Tahap A. Mesin menerima dan merepresentasikan input.',
    stageB: 'Tahap B. Analisis dan verifikasi sedang berjalan.',
    stageC: 'Tahap C. Hasil disintesis.',
    stageD: 'Tahap D. Audit akhir sedang berlangsung.'
  });
  const COOLDOWN = Object.freeze({
    welcome: 14000, live: 4000, processing: 3000, valid: 4000,
    warning: 3500, error: 3000, standby: 6000,
    stageA: 0, stageB: 0, stageC: 0, stageD: 0
  });

  const queue = [];
  const lastPlayed = new Map();
  const audioCache = new Map();
  let unlocked = false;
  let busy = false;
  let pendingUnlock = false;
  let welcomed = false;
  let lastState = '';
  let lastStage = '';
  let selectedVoice = null;
  let voicesReady = false;
  let preferTts = true; // airport TTS first; MP3 fallback if TTS gagal

  function isFemaleId(v) {
    if (!v) return false;
    const lang = String(v.lang || '').toLowerCase();
    if (!(lang.startsWith('id') || lang.includes('indonesia'))) return false;
    const n = (v.name + ' ' + (v.voiceURI || '')).toLowerCase();
    // prefer explicit female markers; also accept common ID female names
    if (/(male|man|boy|david|mark|james|pria)/i.test(n) && !/female|woman/i.test(n)) return false;
    return true; // Indonesian voices on mobile are often female by default
  }

  function rankVoice(v) {
    const n = (v.name + ' ' + (v.voiceURI || '')).toLowerCase();
    let score = 0;
    if (/female|woman|girl|zira|samantha|ava|aria|jenny|susan/i.test(n)) score += 50;
    if (/google|microsoft|natural|premium|enhanced|neural/i.test(n)) score += 30;
    if ((v.lang || '').toLowerCase().startsWith('id-id')) score += 20;
    if ((v.lang || '').toLowerCase().startsWith('id')) score += 10;
    return score;
  }

  function refreshVoices() {
    if (!('speechSynthesis' in window)) return false;
    const voices = window.speechSynthesis.getVoices() || [];
    if (!voices.length) return false;
    const candidates = voices.filter(isFemaleId).sort((a, b) => rankVoice(b) - rankVoice(a));
    // If no id female found, try any id voice (often female on Android)
    selectedVoice = candidates[0] || voices.find(v => String(v.lang || '').toLowerCase().startsWith('id')) || null;
    voicesReady = !!selectedVoice;
    return voicesReady;
  }

  if ('speechSynthesis' in window) {
    refreshVoices();
    window.speechSynthesis.onvoiceschanged = refreshVoices;
  }

  function canPlay(key, force) {
    if (!TEXT[key] && !FILES[key]) return false;
    if (force) return true;
    const cd = COOLDOWN[key] ?? 3000;
    const last = lastPlayed.get(key) || 0;
    return Date.now() - last >= cd;
  }

  function resolveAudioUrl(key) {
    const file = FILES[key];
    if (!file) return null;
    // Prefer first root; actual load will try sequentially on error
    return ROOTS.map(r => r + file);
  }

  function loadAudio(key) {
    if (audioCache.has(key)) return audioCache.get(key);
    const urls = resolveAudioUrl(key);
    if (!urls || !urls.length) return null;
    const a = new Audio();
    a.preload = 'auto';
    a.src = urls[0];
    let tryIdx = 0;
    a.addEventListener('error', function onErr() {
      tryIdx += 1;
      if (tryIdx < urls.length) {
        a.src = urls[tryIdx];
        a.load();
      }
    });
    audioCache.set(key, a);
    return a;
  }

  function speakTts(key) {
    return new Promise((resolve) => {
      if (!('speechSynthesis' in window) || !TEXT[key]) {
        resolve(false);
        return;
      }
      refreshVoices();
      try { window.speechSynthesis.cancel(); } catch (_) {}
      const u = new SpeechSynthesisUtterance(TEXT[key]);
      u.lang = (selectedVoice && selectedVoice.lang) || 'id-ID';
      if (selectedVoice) u.voice = selectedVoice;
      // Airport PA style: slightly slower, clear, neutral pitch
      u.rate = 0.92;
      u.pitch = 1.05;
      u.volume = 1;
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        resolve(!!ok);
      };
      u.onend = () => finish(true);
      u.onerror = () => finish(false);
      try {
        window.speechSynthesis.speak(u);
        // safety timeout
        setTimeout(() => finish(true), Math.min(12000, 800 + TEXT[key].length * 80));
      } catch (_) {
        finish(false);
      }
    });
  }

  function playMp3(key) {
    return new Promise((resolve) => {
      const a = loadAudio(key);
      if (!a) {
        resolve(false);
        return;
      }
      try {
        a.pause();
        a.currentTime = 0;
        const p = a.play();
        if (p && typeof p.then === 'function') {
          p.then(() => {
            const done = () => resolve(true);
            a.addEventListener('ended', done, { once: true });
            a.addEventListener('error', () => resolve(false), { once: true });
            setTimeout(() => resolve(true), 8000);
          }).catch(() => resolve(false));
        } else {
          resolve(true);
        }
      } catch (_) {
        resolve(false);
      }
    });
  }

  async function drain() {
    if (busy) return;
    if (!unlocked) {
      pendingUnlock = true;
      return;
    }
    if (!queue.length) return;
    busy = true;
    const key = queue.shift();
    try {
      lastPlayed.set(key, Date.now());
      let ok = false;
      if (preferTts) {
        ok = await speakTts(key);
        if (!ok) ok = await playMp3(key);
      } else {
        ok = await playMp3(key);
        if (!ok) ok = await speakTts(key);
      }
    } catch (_) { /* silent */ }
    finally {
      busy = false;
      if (queue.length) setTimeout(drain, 60);
    }
  }

  function unlock() {
    if (unlocked) return;
    unlocked = true;
    pendingUnlock = false;
    // Resume audio context policies on iOS/Android
    try {
      if ('speechSynthesis' in window) {
        const warm = new SpeechSynthesisUtterance(' ');
        warm.volume = 0;
        window.speechSynthesis.speak(warm);
        window.speechSynthesis.cancel();
      }
    } catch (_) {}
    ROOTS.forEach(() => {});
    Object.keys(FILES).forEach(k => { try { loadAudio(k); } catch (_) {} });
    drain();
  }

  ['pointerdown', 'touchstart', 'keydown', 'click'].forEach(t => {
    window.addEventListener(t, unlock, { passive: true, once: false });
  });
  // first interaction only unlocks once flag is set
  window.addEventListener('pointerdown', function once() {
    unlock();
    window.removeEventListener('pointerdown', once);
  }, { passive: true });

  function play(key, options) {
    options = options || {};
    if (!TEXT[key] && !FILES[key]) return false;
    if (!canPlay(key, !!options.force)) return false;
    queue.push(key);
    if (queue.length > 10) queue.splice(0, queue.length - 10);
    drain();
    return true;
  }

  function welcome() {
    if (welcomed) return false;
    welcomed = true;
    return play('welcome', { force: true });
  }

  function state(name, detail) {
    const s = String(name || '').toUpperCase();
    if (!s || s === lastState) return false;
    lastState = s;
    if (s === 'LIVE') return play('live', detail);
    if (s === 'PROCESSING' || s === 'RUNNING') return play('processing', detail);
    if (s === 'VALID' || s === 'COMPLETE' || s === 'DONE' || s === 'WELL_FORMED' || s === 'PROCESSED') return play('valid', detail);
    if (s === 'WARNING' || s === 'DEGRADED' || s === 'PARTIAL') return play('warning', detail);
    if (s === 'ERROR' || s === 'FAILED') return play('error', detail);
    if (s === 'STANDBY' || s === 'IDLE') return play('standby', detail);
    return false;
  }

  function announcePipelineStage(stage, started, result) {
    const st = String(stage || '').toUpperCase();
    if (started) {
      if (st === lastStage) return false;
      lastStage = st;
      if (st === 'A') return play('stageA', { force: true });
      if (st === 'B') return play('stageB', { force: true });
      if (st === 'C') return play('stageC', { force: true });
      if (st === 'D') return play('stageD', { force: true });
      return play('processing', { force: true });
    }
    lastStage = st;
    if (st === 'D') {
      const audit = String(result?.audit || '').toUpperCase();
      return audit === 'VALID' ? play('valid', { force: true }) : play('warning', { force: true });
    }
    return false;
  }

  window.CGOOperatorVoice = Object.freeze({
    version: VERSION,
    build: BUILD,
    play,
    welcome,
    state,
    announcePipelineStage,
    unlock,
    get unlocked() { return unlocked; },
    get pendingUnlock() { return pendingUnlock; },
    get voice() { return selectedVoice?.name || null; },
    get voiceLanguage() { return selectedVoice?.lang || null; },
    get femaleVoiceReady() { return !!selectedVoice; },
    setPreferTts(v) { preferTts = !!v; }
  });

  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
      // Try welcome after short delay; may queue until unlock
      welcome();
    }, 700);
  }, { once: true });
})();
