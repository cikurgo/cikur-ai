/*
 * CGO AI VOICE OPERATOR
 * Local audio assets only — no external voice/API/service.
 * Version: 1.0.0-LOCAL-OPERATOR
 */
(function () {
  'use strict';

  const ROOT = './audio/cgo-operator/';
  const BUILD = 'CIKUR-GO-VOICE-OPERATOR-1.0.0';
  const FILES = Object.freeze({
    welcome: 'welcome.mp3',
    live: 'live.mp3',
    processing: 'processing.mp3',
    valid: 'valid.mp3',
    warning: 'warning.mp3',
    error: 'error.mp3',
    standby: 'standby.mp3'
  });

  const COOLDOWN = Object.freeze({
    welcome: 12000,
    live: 4500,
    processing: 3500,
    valid: 4500,
    warning: 3500,
    error: 3000,
    standby: 7000
  });

  const queue = [];
  const lastPlayed = new Map();
  const audio = new Map();
  let unlocked = false;
  let busy = false;
  let pendingUnlock = false;
  let welcomed = false;
  let lastState = '';
  let lastStage = '';

  function getAudio(key) {
    if (!FILES[key]) return null;
    let a = audio.get(key);
    if (!a) {
      a = new Audio(ROOT + FILES[key]);
      a.preload = 'auto';
      a.volume = 0.82;
      audio.set(key, a);
    }
    return a;
  }

  function canPlay(key, force) {
    if (force) return true;
    const now = Date.now();
    const last = lastPlayed.get(key) || 0;
    return now - last >= (COOLDOWN[key] || 4000);
  }

  async function drain() {
    if (busy || !unlocked || !queue.length) return;
    busy = true;
    const key = queue.shift();
    const a = getAudio(key);
    if (!a) { busy = false; return drain(); }

    try {
      a.pause();
      a.currentTime = 0;
      lastPlayed.set(key, Date.now());
      await a.play();
      await new Promise(resolve => {
        const done = () => { cleanup(); resolve(); };
        const cleanup = () => {
          a.removeEventListener('ended', done);
          a.removeEventListener('error', done);
        };
        a.addEventListener('ended', done, { once: true });
        a.addEventListener('error', done, { once: true });
      });
    } catch (_) {
      pendingUnlock = true;
    } finally {
      busy = false;
      drain();
    }
  }

  function unlock() {
    if (unlocked) return;
    unlocked = true;
    pendingUnlock = false;
    drain();
  }

  ['pointerdown', 'touchstart', 'keydown'].forEach(type => {
    window.addEventListener(type, unlock, { passive: true, once: true });
  });

  function play(key, options) {
    options = options || {};
    if (!FILES[key]) return false;
    if (!canPlay(key, !!options.force)) return false;
    queue.push(key);
    if (queue.length > 3) queue.splice(0, queue.length - 3);
    drain();
    return true;
  }

  function welcome() {
    if (welcomed) return false;
    welcomed = true;
    return play('welcome', { force: true });
  }

  function state(stateName, detail) {
    const s = String(stateName || '').toUpperCase();
    if (!s || s === lastState) return false;
    lastState = s;
    if (s === 'LIVE') return play('live', detail);
    if (s === 'PROCESSING' || s === 'RUNNING') return play('processing', detail);
    if (s === 'VALID' || s === 'COMPLETE' || s === 'DONE') return play('valid', detail);
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
      return play('processing');
    }
    lastStage = st;
    if (stage === 'D') {
      return String(result?.audit || '').toUpperCase() === 'VALID'
        ? play('valid')
        : play('warning');
    }
    return false;
  }

  window.CGOOperatorVoice = Object.freeze({
    version: '1.0.0-LOCAL-OPERATOR',
    build: BUILD,
    play,
    welcome,
    state,
    announcePipelineStage,
    unlock,
    get unlocked() { return unlocked; },
    get pendingUnlock() { return pendingUnlock; }
  });

  document.addEventListener('DOMContentLoaded', () => {
    // Attempt the greeting immediately. Browser autoplay policy may defer it
    // until the user's first interaction; the queue remains intact.
    setTimeout(welcome, 650);
  }, { once: true });
})();
