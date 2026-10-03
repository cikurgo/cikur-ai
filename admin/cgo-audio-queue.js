/**
 * CGO Audio Queue Manager — satu antrian global MP3 + TTS
 * Prioritas: P0 error < P1 warning/processing < P2 stage/valid/live < P3 standby/welcome
 * Hanya SATU suara aktif. Offline only.
 */
(function (global) {
  "use strict";
  const VERSION = "1.1.0-MIC-AWARE-WATCHDOG";
  const WATCHDOG_MS = 75000; // job yang tidak pernah selesai dilepas paksa agar antrean tidak macet

  // File priority map (nama file saja — path dari operator)
  const FILE_PRIORITY = Object.freeze({
    "error.mp3": 0,
    "warning.mp3": 1,
    "processing.mp3": 1,
    "stageA.mp3": 2,
    "stageB.mp3": 2,
    "stageC.mp3": 2,
    "stageD.mp3": 2,
    "valid.mp3": 2,
    "live.mp3": 2,
    "standby.mp3": 3,
    "welcome.mp3": 3
  });

  let enabled = true;
  let paused = false;
  let current = null; // { id, priority, jenis, stop }
  const queue = [];
  let seq = 0;

  function now() {
    try { return performance.now(); } catch (_) { return Date.now(); }
  }

  function priorityOf(item) {
    if (item.priority != null) return Number(item.priority);
    if (item.file && FILE_PRIORITY[item.file] != null) return FILE_PRIORITY[item.file];
    if (item.jenis === "tts" || item.jenis === "chat") return 2;
    return 2;
  }

  function stopCurrent(reason) {
    if (!current) return;
    try { clearTimeout(current.wd); } catch (_) {}
    try {
      if (typeof current.stop === "function") current.stop(reason || "preempt");
    } catch (_) {}
    try {
      if (global.CGOAudioBus && current.claimId) global.CGOAudioBus.lepas(current.claimId);
    } catch (_) {}
    current = null;
  }

  function pump() {
    if (paused || !enabled) return;
    if (current) return;
    if (!queue.length) return;

    // sort by priority asc, then seq
    queue.sort(function (a, b) {
      const pa = priorityOf(a);
      const pb = priorityOf(b);
      if (pa !== pb) return pa - pb;
      return a.seq - b.seq;
    });

    const next = queue.shift();
    if (!next) return;

    // Bus claim
    let claimId = null;
    try {
      if (global.CGOAudioBus) {
        const c = global.CGOAudioBus.klaim(priorityOf(next), next.id);
        if (!c.ok) {
          // re-queue lower priority later or drop P3
          if (priorityOf(next) >= 3) return pump();
          queue.push(next);
          setTimeout(pump, 400);
          return;
        }
        claimId = c.id;
      }
    } catch (_) {}

    current = {
      id: next.id,
      priority: priorityOf(next),
      jenis: next.jenis,
      claimId: claimId,
      stop: null
    };

    const finish = function () {
      try { clearTimeout(wd); } catch (_) {}
      try {
        if (global.CGOAudioBus && claimId) global.CGOAudioBus.lepas(claimId);
      } catch (_) {}
      if (current && current.id === next.id) current = null;
      setTimeout(pump, 30);
    };

    const wd = setTimeout(function () {
      if (current && current.id === next.id) {
        stopCurrent("watchdog");
        setTimeout(pump, 30);
      }
    }, WATCHDOG_MS);
    current.wd = wd;

    try {
      if (typeof next.play === "function") {
        const handle = next.play();
        current.stop = function () {
          try {
            if (handle && typeof handle.stop === "function") handle.stop();
          } catch (_) {}
          try {
            if (global.speechSynthesis) global.speechSynthesis.cancel();
          } catch (_) {}
        };
        Promise.resolve(handle && handle.done ? handle.done : handle)
          .catch(function () {})
          .then(finish);
      } else {
        finish();
      }
    } catch (_) {
      finish();
    }
  }

  /**
   * Enqueue audio job
   * @param {object} item { jenis, file?, priority?, play: () => Promise|{done,stop} }
   */
  function enqueue(item) {
    if (!enabled) return Promise.resolve(false);
    item = item || {};
    const id = "aq-" + (++seq) + "-" + Date.now();
    const pri = priorityOf(item);

    // Preempt rules
    if (current) {
      const curPri = current.priority;
      // P0 vs P3: stop P3, run P0, optionally don't resume P3
      if (pri < curPri) {
        // higher priority (lower number) preempts
        if (pri === 0) {
          stopCurrent("p0");
          // drop remaining P2 that were mid-play (policy: don't resume P2 after P0)
        } else if (pri <= 1 && curPri >= 3) {
          stopCurrent("p1-over-p3");
        } else if (pri === 0 && curPri >= 2) {
          stopCurrent("p0-over-p2");
        }
      }
    }

    // Chat TTS: if new chat while old TTS playing, stop old TTS
    if (item.jenis === "tts" || item.jenis === "chat") {
      if (current && (current.jenis === "tts" || current.jenis === "chat" || current.jenis === "sys")) {
        stopCurrent("new-chat");
      }
      // jawaban chat baru: buang antrean jawaban/pengumuman lama yang belum sempat bunyi
      for (let i = queue.length - 1; i >= 0; i--) {
        const j = queue[i].jenis;
        if (j === "tts" || j === "chat" || j === "sys") queue.splice(i, 1);
      }
    }

    return new Promise(function (resolve) {
      const job = {
        id: id,
        seq: seq,
        jenis: item.jenis || "mp3",
        file: item.file || null,
        priority: pri,
        play: function () {
          const result = item.play();
          if (result && typeof result.then === "function") {
            return {
              done: result.then(function (v) { resolve(v); return v; }, function (e) { resolve(false); throw e; }),
              stop: function () {
                try { if (global.speechSynthesis) global.speechSynthesis.cancel(); } catch (_) {}
                try {
                  document.querySelectorAll("audio[data-cgo-operator]").forEach(function (a) {
                    try { a.pause(); a.currentTime = 0; } catch (_) {}
                  });
                } catch (_) {}
              }
            };
          }
          resolve(true);
          return result;
        }
      };
      queue.push(job);
      pump();
    });
  }

  function setEnabled(on) {
    enabled = !!on;
    if (!enabled) {
      stopCurrent("mute");
      queue.length = 0;
      try { if (global.speechSynthesis) global.speechSynthesis.cancel(); } catch (_) {}
    } else {
      pump();
    }
  }

  function pause(reason) {
    paused = true;
    try { global.__cgoAudioPauseReason = String(reason || "manual"); } catch (_) {}
    stopCurrent("pause:" + String(reason || "manual"));
  }

  function resume(reason) {
    if (reason === "mic" && global.__cgoUserPausedAudio) return;
    paused = false;
    try { global.__cgoAudioPauseReason = ""; } catch (_) {}
    pump();
  }

  function clear() {
    queue.length = 0;
    stopCurrent("clear");
  }

  function getStatus() {
    return {
      version: VERSION,
      enabled: enabled,
      paused: paused,
      current: current ? { id: current.id, priority: current.priority, jenis: current.jenis } : null,
      queued: queue.length
    };
  }

  global.CGOAudioQueue = Object.freeze({
    version: VERSION,
    enqueue: enqueue,
    setEnabled: setEnabled,
    pause: pause,
    resume: resume,
    clear: clear,
    getStatus: getStatus,
    FILE_PRIORITY: FILE_PRIORITY,
    isEnabled: function () { return enabled; }
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
