/*
 * CGO OPERATOR VOICE v3.7.0 — NEURAL SARA · NATURAL CHAT + ATTENTION
 * Operator wanita:
 *   - speakAnswer()  → TTS wanita untuk jawaban chat (teks dinamis)
 *   - announceAttention() → info natural bila ada error/warning + lokasi file/jalur
 *   - emit()         → MP3 event sistem (boot/error clip), di-jeda saat chat bicara
 * Anti-double: _chatSpeaking memblokir emit MP3 event & stage ABC.
 */
(function (global) {
  "use strict";

  const VERSION = "3.8.1-FEMALE-ONLY-ROOTSAFE";
  const BUILD = "CIKUR-GO-OPERATOR-3.8.1";
  /** Path audio cerdas: dukung load dari root portal maupun dari admin/ */
  function detectAudioRoot() {
    try {
      const path = (typeof location !== "undefined" && location.pathname) || "";
      if (/\/admin\/?/i.test(path)) {
        return "./audio/cgo-operator/";
      }
      // Dari root index.html → arahkan ke admin/
      return "./admin/audio/cgo-operator/";
    } catch (_) {
      return "./admin/audio/cgo-operator/";
    }
  }
  const ROOT = detectAudioRoot();

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
  let chatSpeakEnabled = true; // Chat TTS wanita aktif; MP3 event tetap untuk sistem (dijeda saat chat bicara)
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

  // STRICT FEMALE-ONLY POLICY.
  // Browser voice metadata is not guaranteed to expose gender. Therefore we NEVER
  // fall back to an unclassified Indonesian voice: an unknown voice may be male/robotic.
  // If the browser cannot positively identify a female voice, dynamic speech stays silent
  // rather than violating the Operator voice contract.
  function isConfirmedFemale(v) {
    var n = String((v && v.name) || "") + " " + String((v && v.voiceURI) || "");
    n = n.toLowerCase();
    var l = String((v && v.lang) || "").toLowerCase();
    if (!l.startsWith("id")) return false;
    return /(female|woman|zira|samantha|ava|aria|jenny|susan|gadis|perempuan)/i.test(n);
  }

  function refreshVoices() {
    if (!("speechSynthesis" in global)) { selectedVoice = null; return false; }
    var voices = global.speechSynthesis.getVoices() || [];
    if (!voices.length) { selectedVoice = null; return false; }
    var idFemale = voices.filter(isConfirmedFemale);
    selectedVoice =
      idFemale.find(function (v) { return /google|microsoft|natural|premium/i.test(String(v.name || "")); }) ||
      idFemale[0] || null;
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
      a.dataset.cgoOperator = "1";
      a.dataset.cgoTried = "0";
      try { a.setAttribute("data-cgo-operator", "1"); } catch (_) {}
      audioCache.set(file, a);
      // Satu kali fallback path — jangan loop error→src→error
      a.addEventListener("error", function onAudioErr() {
        try {
          if (a.dataset.cgoTried === "0") {
            a.dataset.cgoTried = "1";
            a.src = "./" + file;
          } else {
            a.removeEventListener("error", onAudioErr);
            audioCache.delete(file); // jangan cache file yang gagal
          }
        } catch (_) {
          try { a.removeEventListener("error", onAudioErr); } catch (_) {}
        }
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
      if (!refreshVoices() || !selectedVoice) return resolve(false);
      var u = new SpeechSynthesisUtterance(text);
      u.lang = selectedVoice.lang || "id-ID";
      u.voice = selectedVoice;
      // Airport-style delivery: calm, clear, slightly deliberate, never rushed.
      u.rate = (opts && opts.rate != null) ? opts.rate : 0.92;
      u.pitch = (opts && opts.pitch != null) ? opts.pitch : 1.05;
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
        // Do not declare speech finished on a guessed timer: browser TTS may still be speaking.
      // Watchdog only prevents a permanently stuck queue; normal completion is onend.
      setTimeout(function () {
        if (!finished) {
          try { global.speechSynthesis.cancel(); } catch (_) {}
          fin(false);
        }
      }, Math.min(60000, Math.max(12000, 2500 + text.length * 140)));
      } catch (_) {
        fin(false);
      }
    });
  }

  var _chatSpeaking = false;
  function canEmit(key, force) {
    if (!enabled && !force) return false;
    // Saat chat TTS/operator bicara — jangan emit event (cegah double suara)
    if (_chatSpeaking && !force) return false;
    if (quietLive && /^ABC_STAGE_/.test(key) && !force) return false;
    // Diamkan stage/valid/live yang berisik
    if (!force && (key === "VALID" || key === "LIVE_INPUT" || key === "SYSTEM_IDLE")) return false;
    var cd = COOLDOWN[key] || 0;
    var last = lastPlayed.get(key) || 0;
    if (!force && cd > 0 && Date.now() - last < cd) return false;
    return true;
  }

  function filePriority(key) {
    var file = MP3[key];
    var map = (global.CGOAudioQueue && global.CGOAudioQueue.FILE_PRIORITY) || {};
    if (file && map[file] != null) return map[file];
    if (key === "ERROR") return 0;
    if (key === "WARNING" || key === "PROCESSING" || key === "PROCESSING_WAIT") return 1;
    if (key === "STANDBY" || key === "SYSTEM_BOOT" || key === "SYSTEM_READY" || key === "REFRESH_READY" || key === "SYSTEM_IDLE") return 3;
    return 2;
  }

  function emit(key, detail) {
    var force = !!(detail && detail.force);
    if (!TEXT[key] && key !== "CHAT_REPLY") return Promise.resolve(false);
    if (!enabled) return Promise.resolve(false);
    if (!canEmit(key, force)) return Promise.resolve(false);
    lastPlayed.set(key, Date.now());
    var phrase = TEXT[key];
    var pri = filePriority(key);
    var file = MP3[key];

    function doPlay() {
      // HANYA MP3 operator wanita jernih — tanpa TTS browser sama sekali
      return playMp3(key);
    }

    if (global.CGOAudioQueue && typeof global.CGOAudioQueue.enqueue === "function") {
      return global.CGOAudioQueue.enqueue({
        jenis: "mp3",
        file: file || null,
        priority: pri,
        play: function () { return doPlay(); }
      });
    }
    return doPlay();
  }


  function stop() {
    _chatSpeaking = false;
    try { if (global.speechSynthesis) global.speechSynthesis.cancel(); } catch (_) {}
    try {
      var audios = document.querySelectorAll("audio[data-cgo-operator]");
      audios.forEach(function(a){ try { a.pause(); a.currentTime = 0; } catch(_){} });
    } catch (_) {}
  }
  function speakAnswer(rawText, options) {
    options = options || {};
    // Jawaban chat dinamis → TTS operator wanita (bukan MP3 frasa tetap).
    // Gate force+allowTts dihapus agar suara muncul saat chat dijawab.
    if (!enabled && !options.force) return Promise.resolve(false);
    if (!chatSpeakEnabled && !options.force) return Promise.resolve(false);
    if (global.CGOAudioQueue && typeof global.CGOAudioQueue.isEnabled === "function" && !global.CGOAudioQueue.isEnabled()) {
      return Promise.resolve(false);
    }
    var text = toSpeechText(rawText);
    if (!text || text.length < 3) return Promise.resolve(false);
    var hash = text.slice(0, 80);
    if (!options.force && hash === lastChatHash && Date.now() - lastChatAt < 6000) {
      return Promise.resolve(false);
    }
    lastChatHash = hash;
    lastChatAt = Date.now();

    var emosi = options.emosi || null;
    var voiceOpts = { rate: 0.92, pitch: 1.05 };
    try {
      if (emosi && global.CGOEmosi && typeof global.CGOEmosi.voiceFor === "function") {
        voiceOpts = global.CGOEmosi.voiceFor(emosi) || voiceOpts;
      }
    } catch (_) {}
    if (options.rate != null) voiceOpts.rate = options.rate;
    if (options.pitch != null) voiceOpts.pitch = options.pitch;

    function stopAllOperatorAudio() {
      try { if (global.speechSynthesis) global.speechSynthesis.cancel(); } catch (_) {}
      try {
        var nodes = document.querySelectorAll("audio[data-cgo-operator]");
        for (var i = 0; i < nodes.length; i++) {
          try { var a = nodes[i]; a.pause(); a.currentTime = 0; } catch (_) {}
        }
      } catch (_) {}
      try {
        audioCache.forEach(function (a) { try { a.pause(); a.currentTime = 0; } catch (_) {} });
      } catch (_) {}
      // Batalkan antrean MP3 event agar tidak double dengan TTS chat
      try {
        if (global.CGOAudioQueue && typeof global.CGOAudioQueue.clear === "function") {
          /* clear hanya jika API mendukung jenis; fallback: pause */
        }
      } catch (_) {}
    }

    function doSpeak() {
      _chatSpeaking = true;
      stopAllOperatorAudio();
      var startP = unlocked ? Promise.resolve(true) : unlock();
      return startP.then(function () {
        chatSpeakEnabled = true;
        return speakTTS(text, voiceOpts).then(function (ok) { return ok; });
      }).finally(function () {
        setTimeout(function () { _chatSpeaking = false; }, 400);
      });
    }

    if (global.CGOAudioQueue && typeof global.CGOAudioQueue.enqueue === "function") {
      return global.CGOAudioQueue.enqueue({
        jenis: "tts",
        priority: 0,
        play: function () { return doSpeak(); }
      });
    }
    return doSpeak();
  }

  /**
   * Pengumuman natural operator bila ada masalah.
   * detail: { file, path, message, kind: "error"|"warning", jalur }
   * Contoh: "Perhatian. Perlu pengecekan pada file bcgo.js di jalur admin."
   */
  function buildAttentionPhrase(detail) {
    detail = detail || {};
    var kind = String(detail.kind || detail.severity || "warning").toLowerCase();
    var file = String(detail.file || detail.fileName || detail.sourceFile || "").trim();
    var path = String(detail.path || detail.jalur || detail.route || "").trim();
    var msg = String(detail.message || detail.reason || "").trim();
    // Rapikan nama file dari path
    if (!file && path) {
      var parts = path.replace(/\\\\/g, "/").split("/");
      file = parts[parts.length - 1] || path;
    }
    var tempat = "";
    if (file && path && path !== file && path.indexOf(file) !== -1) {
      // path mengandung nama file → sebut file + folder
      var folder = path.replace(/\\/g, "/");
      var idx = folder.lastIndexOf("/");
      var dir = idx > 0 ? folder.slice(0, idx) : "";
      tempat = dir
        ? ("pada file " + file + " di folder " + dir)
        : ("pada file " + file);
    } else if (file && path && path.indexOf(file) === -1) {
      tempat = "pada file " + file + " di jalur " + path;
    } else if (file) {
      tempat = "pada file " + file;
    } else if (path) {
      tempat = "pada jalur " + path;
    }

    var open =
      kind === "error" || kind === "high" || kind === "critical"
        ? "Perhatian. Terdeteksi gangguan"
        : "Perhatian. Diperlukan pemeriksaan";

    var body = tempat ? (open + " " + tempat + ".") : (open + ".");
    if (msg) {
      // Ringkas pesan teknis jadi natural
      var short = msg
        .replace(/^Error:\s*/i, "")
        .replace(/\bError\b/gi, "kesalahan")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120);
      if (short) {
        body += " Ringkasan: " + short;
        if (body.slice(-1) !== ".") body += ".";
      }
    }
    if (tempat) {
      body += " Mohon tinjau " + (file ? "file tersebut" : "jalur tersebut") + " sebelum melanjutkan.";
    } else {
      body += " Mohon periksa status sistem.";
    }
    return body;
  }

  function announceAttention(detail, options) {
    options = options || {};
    var phrase = buildAttentionPhrase(detail);
    // Putar clip WARNING/ERROR singkat dulu (opsional), lalu TTS natural
    var kind = String((detail && (detail.kind || detail.severity)) || "warning").toLowerCase();
    var clipKey = (kind === "error" || kind === "high" || kind === "critical") ? "ERROR" : "WARNING";
    var clipP = Promise.resolve(false);
    if (!options.skipClip && enabled) {
      try {
        // force clip sekali, tapi canEmit akan hormati _chatSpeaking
        clipP = emit(clipKey, { force: !!options.forceClip });
      } catch (_) {}
    }
    return clipP.then(function () {
      return speakAnswer(phrase, {
        force: true,
        emosi: kind === "error" ? "tegas" : "khawatir",
        rate: 0.92
      });
    }).then(function (ok) {
      return { ok: !!ok, phrase: phrase };
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

  // Debounce state announcements — prevent collision when BCGO cycles fire every few seconds
  var _lastStateKey = "";
  var _lastStateAt = 0;
  var STATE_COOLDOWN_MS = 12000; // min 12s between identical/adjacent state sounds
  var STATE_SILENT = { PROCESSING: 1, PROCESSING_WAIT: 1, LIVE_INPUT: 1, SYSTEM_IDLE: 1, STANDBY: 1, VALID: 1, SYSTEM_READY: 1, ABC_STAGE_A: 1, ABC_STAGE_B: 1, ABC_STAGE_C: 1, ABC_STAGE_D: 1 }; // too noisy if every cycle

  function state(s, detail) {
    var map = {
      READY: EVENTS.SYSTEM_READY, SYSTEM_READY: EVENTS.SYSTEM_READY,
      BOOT: EVENTS.SYSTEM_BOOT, PROCESSING: EVENTS.PROCESSING,
      VALID: EVENTS.VALID, ERROR: EVENTS.ERROR, WARNING: EVENTS.WARNING,
      STANDBY: EVENTS.STANDBY, IDLE: EVENTS.SYSTEM_IDLE, LIVE: EVENTS.LIVE_INPUT,
      RESET: EVENTS.RESET, ABORT: EVENTS.ABORT, RECOVERY: EVENTS.RECOVERY
    };
    var key = map[String(s || "").toUpperCase()] || String(s || "").toUpperCase();
    // Silent for high-frequency operational states (UI still updates; no MP3 spam)
    if (STATE_SILENT[key]) return false;
    var now = Date.now();
    if (key === _lastStateKey && (now - _lastStateAt) < STATE_COOLDOWN_MS) return false;
    if ((now - _lastStateAt) < 4000 && key !== EVENTS.ERROR && key !== EVENTS.WARNING) return false;
    _lastStateKey = key;
    _lastStateAt = now;
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
    announceAttention: announceAttention,
    buildAttentionPhrase: buildAttentionPhrase,
    stop: stop,
    speak: speakAnswer,
    unlock: unlock,
    welcome: welcome,
    state: state,
    announcePipelineStage: announcePipelineStage,
    setEnabled: function (v) { enabled = !!v; },
    setChatSpeak: function (v) { chatSpeakEnabled = !!v; },
    setQuietLive: function (v) { quietLive = !!v; },
    isChatSpeaking: function () { return !!_chatSpeaking; },
    otakEnrich: otakEnrich,
    toSpeechText: toSpeechText,
    isUnlocked: function () { return unlocked; },
    isEnabled: function () { return enabled; }
  };

  global.CGOOperatorVoice = api;
  global.CGO_OPERATOR_VOICE = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : this);
