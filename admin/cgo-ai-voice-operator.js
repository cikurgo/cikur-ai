/*
 * CGO OPERATOR VOICE v3.3.0 — NEURAL SARA · OTAK-AWARE · NATURAL CHAT
 * Female airport-style operator. Event-driven (no spam on LIVE).
 * speakAnswer() = natural spoken reply to user chat (Otak-backed).
 * Offline only — SpeechSynthesis + local MP3 fallback. No external API.
 */
(function (global) {
  "use strict";

  const VERSION = "3.3.0-NEURAL-CHAT-OTAK";
  const BUILD = "CIKUR-GO-OPERATOR-3.3.0";
  const ROOT = "./audio/cgo-operator/";

  const EVENTS = Object.freeze({
    SYSTEM_BOOT: "SYSTEM_BOOT",
    SYSTEM_READY: "SYSTEM_READY",
    REFRESH_READY: "REFRESH_READY",
    COMMAND_ACCEPTED: "COMMAND_ACCEPTED",
    COMMAND_DUPLICATE: "COMMAND_DUPLICATE",
    PROCESSING: "PROCESSING",
    PROCESSING_WAIT: "PROCESSING_WAIT",
    ABC_STAGE_A: "ABC_STAGE_A",
    ABC_STAGE_B: "ABC_STAGE_B",
    ABC_STAGE_C: "ABC_STAGE_C",
    ABC_STAGE_D: "ABC_STAGE_D",
    LIVE_INPUT: "LIVE_INPUT",
    STANDBY: "STANDBY",
    VALID: "VALID",
    WARNING: "WARNING",
    ERROR: "ERROR",
    RECOVERY: "RECOVERY",
    RESET: "RESET",
    ABORT: "ABORT",
    SYSTEM_IDLE: "SYSTEM_IDLE",
    CHAT_REPLY: "CHAT_REPLY"
  });

  const TEXT = Object.freeze({
    SYSTEM_BOOT: "Selamat datang di Sistem Internal CIKUR GO. Operator siap.",
    SYSTEM_READY: "Sistem internal aktif. Operator siap mendampingi.",
    REFRESH_READY: "Wah, segar kembali. Sistem sudah siap kembali.",
    COMMAND_ACCEPTED: "Perintah diterima. Sedang diproses.",
    COMMAND_DUPLICATE: "Sistem sedang berjalan. Mohon menunggu.",
    PROCESSING: "Pemrosesan berlangsung.",
    PROCESSING_WAIT: "Masih diproses. Mohon tunggu sebentar.",
    ABC_STAGE_A: "Tahap A. Representasi input.",
    ABC_STAGE_B: "Tahap B. Proses analisis.",
    ABC_STAGE_C: "Tahap C. Hasil disusun.",
    ABC_STAGE_D: "Tahap D. Audit akhir.",
    LIVE_INPUT: "Input langsung diterima.",
    STANDBY: "Sistem siaga.",
    VALID: "Hasil tervalidasi.",
    WARNING: "Perhatian. Diperlukan pemeriksaan.",
    ERROR: "Terjadi gangguan pada jalur sistem.",
    RECOVERY: "Pemulihan berjalan. Sistem menstabilkan diri.",
    RESET: "Sistem direset. Siap menerima perintah baru.",
    ABORT: "Proses dibatalkan.",
    SYSTEM_IDLE: "Sistem menganggur. Menunggu instruksi."
  });

  const MP3 = Object.freeze({
    SYSTEM_BOOT: "welcome.mp3",
    SYSTEM_READY: "welcome.mp3",
    REFRESH_READY: "welcome.mp3",
    COMMAND_ACCEPTED: "processing.mp3",
    COMMAND_DUPLICATE: "processing.mp3",
    PROCESSING: "processing.mp3",
    PROCESSING_WAIT: "processing.mp3",
    ABC_STAGE_A: "stageA.mp3",
    ABC_STAGE_B: "stageB.mp3",
    ABC_STAGE_C: "stageC.mp3",
    ABC_STAGE_D: "stageD.mp3",
    LIVE_INPUT: "live.mp3",
    STANDBY: "standby.mp3",
    VALID: "valid.mp3",
    WARNING: "warning.mp3",
    ERROR: "error.mp3",
    RECOVERY: "standby.mp3",
    RESET: "welcome.mp3",
    ABORT: "error.mp3",
    SYSTEM_IDLE: "standby.mp3",
    CHAT_REPLY: null
  });

  const COOLDOWN = Object.freeze({
    SYSTEM_BOOT: 90000, SYSTEM_READY: 60000, REFRESH_READY: 90000,
    COMMAND_ACCEPTED: 2500, COMMAND_DUPLICATE: 4000,
    PROCESSING: 8000, PROCESSING_WAIT: 10000,
    ABC_STAGE_A: 0, ABC_STAGE_B: 0, ABC_STAGE_C: 0, ABC_STAGE_D: 0,
    LIVE_INPUT: 12000, STANDBY: 15000, VALID: 6000, WARNING: 5000,
    ERROR: 4000, RECOVERY: 8000, RESET: 5000, ABORT: 4000,
    SYSTEM_IDLE: 20000, CHAT_REPLY: 0
  });

  let enabled = true;
  let unlocked = false;
  let quietLive = true;
  let selectedVoice = null;
  let speaking = false;
  const lastPlayed = new Map();
  const audioCache = new Map();
  let chatSpeakEnabled = true;
  let lastChatHash = "";
  let lastChatAt = 0;

  function otakNum(n) {
    try {
      if (global.CIKURGO && typeof global.CIKURGO.angkaKeKata === "function") {
        return global.CIKURGO.angkaKeKata(Number(n) || 0, "id");
      }
    } catch (_) {}
    return String(n);
  }

  function otakEnrich(text) {
    try {
      return String(text)
        .replace(/\b(\d{1,3})\s*%/g, function (_, d) { return otakNum(d) + " persen"; })
        .replace(/\b(\d+)\s+siklus\b/gi, function (_, d) { return otakNum(d) + " siklus"; })
        .replace(/\b(\d+)\s+temuan\b/gi, function (_, d) { return otakNum(d) + " temuan"; })
        .replace(/\b(\d+)\s+anomali\b/gi, function (_, d) { return otakNum(d) + " anomali"; });
    } catch (_) {
      return String(text);
    }
  }

  function toSpeechText(raw) {
    var t = String(raw || "")
      .replace(/\[Otak Jenius\]\s*/gi, "")
      .replace(/\[Mesin ABC[^\]]*\]\s*/gi, "")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`[^`]+`/g, " ")
      .replace(/\*\*?/g, "")
      .replace(/\n{2,}/g, ". ")
      .replace(/\n/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (t.length > 320) {
      var cut = t.slice(0, 300);
      var lastDot = Math.max(cut.lastIndexOf("."), cut.lastIndexOf(","));
      t = (lastDot > 120 ? cut.slice(0, lastDot) : cut) + ".";
    }
    return otakEnrich(t);
  }

  function isFemaleId(v) {
    var n = (v.name + " " + v.voiceURI).toLowerCase();
    var l = (v.lang || "").toLowerCase();
    if (l.startsWith("id")) return true;
    if (!l.startsWith("en")) return false;
    return /(female|woman|zira|samantha|ava|aria|jenny|susan)/i.test(n);
  }

  function refreshVoices() {
    if (!("speechSynthesis" in global)) return false;
    var voices = global.speechSynthesis.getVoices() || [];
    if (!voices.length) return false;
    var idFemale = voices.filter(function (v) {
      return (v.lang || "").toLowerCase().startsWith("id") && isFemaleId(v);
    });
    var idAny = voices.filter(function (v) {
      return (v.lang || "").toLowerCase().startsWith("id");
    });
    var enFemale = voices.filter(isFemaleId);
    selectedVoice =
      idFemale.find(function (v) { return /google|microsoft|natural|premium/i.test(v.name); }) ||
      idFemale[0] || idAny[0] || enFemale[0] || null;
    return !!selectedVoice;
  }

  if ("speechSynthesis" in global) {
    refreshVoices();
    global.speechSynthesis.onvoiceschanged = refreshVoices;
  }

  function getAudio(file) {
    if (!file) return null;
    var a = audioCache.get(file);
    if (!a) {
      a = new Audio(ROOT + file);
      a.preload = "auto";
      audioCache.set(file, a);
      a.addEventListener("error", function () {
        try { a.src = "./" + file; } catch (_) {}
      });
    }
    return a;
  }

  function playMp3(key) {
    return new Promise(function (resolve) {
      var file = MP3[key];
      if (!file) return resolve(false);
      var a = getAudio(file);
      if (!a) return resolve(false);
      try {
        a.pause();
        a.currentTime = 0;
        var done = function () {
          a.removeEventListener("ended", done);
          a.removeEventListener("error", done);
          resolve(true);
        };
        a.addEventListener("ended", done);
        a.addEventListener("error", done);
        var p = a.play();
        if (p && p.catch) p.catch(function () { resolve(false); });
      } catch (_) {
        resolve(false);
      }
    });
  }

  function speakTTS(text, opts) {
    return new Promise(function (resolve) {
      if (!("speechSynthesis" in global) || !text) return resolve(false);
      try { global.speechSynthesis.cancel(); } catch (_) {}
      refreshVoices();
      var u = new SpeechSynthesisUtterance(text);
      u.lang = (selectedVoice && selectedVoice.lang) || "id-ID";
      if (selectedVoice) u.voice = selectedVoice;
      u.rate = (opts && opts.rate) || 0.92;
      u.pitch = (opts && opts.pitch) || 1.05;
      u.volume = 1;
      var finished = false;
      var fin = function (ok) {
        if (finished) return;
        finished = true;
        speaking = false;
        resolve(!!ok);
      };
      u.onend = function () { fin(true); };
      u.onerror = function () { fin(false); };
      speaking = true;
      try {
        global.speechSynthesis.speak(u);
        setTimeout(function () { fin(true); }, Math.min(20000, 800 + text.length * 80));
      } catch (_) {
        fin(false);
      }
    });
  }

  function canEmit(key, force) {
    if (!enabled && !force) return false;
    if (quietLive && /^ABC_STAGE_/.test(key) && !force) return false;
    var cd = COOLDOWN[key] || 0;
    var last = lastPlayed.get(key) || 0;
    if (!force && cd > 0 && Date.now() - last < cd) return false;
    return true;
  }

  function emit(key, detail) {
    var force = !!(detail && detail.force);
    if (!TEXT[key] && key !== "CHAT_REPLY") return Promise.resolve(false);
    if (!canEmit(key, force)) return Promise.resolve(false);
    lastPlayed.set(key, Date.now());
    var phrase = TEXT[key];
    if (phrase) {
      return speakTTS(otakEnrich(phrase)).then(function (ok) {
        if (ok) return true;
        return playMp3(key);
      });
    }
    return playMp3(key);
  }

  function speakAnswer(rawText, options) {
    if (!chatSpeakEnabled && !(options && options.force)) return Promise.resolve(false);
    var text = toSpeechText(rawText);
    if (!text || text.length < 3) return Promise.resolve(false);
    var hash = text.slice(0, 80);
    if (!(options && options.force) && hash === lastChatHash && Date.now() - lastChatAt < 8000) {
      return Promise.resolve(false);
    }
    lastChatHash = hash;
    lastChatAt = Date.now();
    var start = unlocked ? Promise.resolve(true) : unlock();
    return start.then(function () {
      return speakTTS(text, { rate: 0.94, pitch: 1.06 }).then(function (ok) {
        if (ok) return true;
        return playMp3("VALID");
      });
    });
  }

  function unlock() {
    unlocked = true;
    refreshVoices();
    if ("speechSynthesis" in global) {
      try {
        var u = new SpeechSynthesisUtterance("");
        u.volume = 0;
        global.speechSynthesis.speak(u);
      } catch (_) {}
    }
    return Promise.resolve(true);
  }

  function welcome() {
    return emit(EVENTS.SYSTEM_BOOT, { force: true });
  }

  function state(s, detail) {
    var map = {
      READY: EVENTS.SYSTEM_READY, SYSTEM_READY: EVENTS.SYSTEM_READY,
      BOOT: EVENTS.SYSTEM_BOOT, PROCESSING: EVENTS.PROCESSING,
      VALID: EVENTS.VALID, ERROR: EVENTS.ERROR, WARNING: EVENTS.WARNING,
      STANDBY: EVENTS.STANDBY, IDLE: EVENTS.SYSTEM_IDLE, LIVE: EVENTS.LIVE_INPUT,
      RESET: EVENTS.RESET, ABORT: EVENTS.ABORT, RECOVERY: EVENTS.RECOVERY
    };
    var key = map[String(s || "").toUpperCase()] || String(s || "").toUpperCase();
    return emit(key, detail);
  }

  function announcePipelineStage(stage, detail) {
    var s = String(stage || "").toUpperCase();
    var key =
      s === "A" || s === "STAGE_A" ? EVENTS.ABC_STAGE_A :
      s === "B" || s === "STAGE_B" ? EVENTS.ABC_STAGE_B :
      s === "C" || s === "STAGE_C" ? EVENTS.ABC_STAGE_C :
      s === "D" || s === "STAGE_D" ? EVENTS.ABC_STAGE_D : null;
    if (!key) return Promise.resolve(false);
    if (quietLive && !(detail && detail.force)) return Promise.resolve(false);
    return emit(key, detail);
  }

  var api = {
    version: VERSION,
    build: BUILD,
    EVENTS: EVENTS,
    emit: emit,
    speakAnswer: speakAnswer,
    speak: speakAnswer,
    unlock: unlock,
    welcome: welcome,
    state: state,
    announcePipelineStage: announcePipelineStage,
    setEnabled: function (v) { enabled = !!v; },
    setChatSpeak: function (v) { chatSpeakEnabled = !!v; },
    setQuietLive: function (v) { quietLive = !!v; },
    otakEnrich: otakEnrich,
    toSpeechText: toSpeechText,
    isUnlocked: function () { return unlocked; },
    isEnabled: function () { return enabled; }
  };

  global.CGOOperatorVoice = api;
  global.CGO_OPERATOR_VOICE = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : this);
