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

  const VERSION = "3.9.5-SYNTHESIS-RECOVER";
  const BUILD = "CIKUR-GO-OPERATOR-3.9.5-RECOVER";
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

  // MUTLAK: tidak ada klip MP3 sistem (stage/beep terdengar seperti robot).
  // Semua pengumuman lewat TTS suara wanita (speakAnswer / TEXT).
  const MP3 = Object.freeze({
    SYSTEM_BOOT: null,
    SYSTEM_READY: null,
    REFRESH_READY: null,
    COMMAND_ACCEPTED: null,
    COMMAND_DUPLICATE: null,
    PROCESSING: null,
    PROCESSING_WAIT: null,
    ABC_STAGE_A: null,
    ABC_STAGE_B: null,
    ABC_STAGE_C: null,
    ABC_STAGE_D: null,
    LIVE_INPUT: null,
    STANDBY: null,
    VALID: null,
    WARNING: null,
    ERROR: null,
    RECOVERY: null,
    RESET: null,
    ABORT: null,
    SYSTEM_IDLE: null,
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
  function isMaleMarked(n) {
    // "female" mengandung "male" dan "woman" berakhiran "man": netralkan dulu sebelum cek penanda pria.
    var t = String(n || "").toLowerCase().replace(/female|woman|women|wanita|perempuan|gadis/g, " f ");
    return /(\bmale\b|\bman\b|\bboy\b|\bpria\b|\blaki|david|\bmark\b|james|john|thomas|daniel|\bardi\b|andika|rizki)/i.test(t);
  }

  // Android/Java lama memakai kode "in" (in-ID / in_ID) untuk Indonesia, bukan "id".
  function isIdLang(l, n) {
    l = String(l || "").toLowerCase();
    if (/^(id|in)([-_]|$)/.test(l)) return true;
    return /indonesia/.test(String(n || "").toLowerCase());
  }

  function isConfirmedFemale(v) {
    var n = String((v && v.name) || "") + " " + String((v && v.voiceURI) || "");
    n = n.toLowerCase();
    var l = String((v && v.lang) || "").toLowerCase();
    if (!isIdLang(l, n)) return false;
    if (isMaleMarked(n)) return false;
    // Eksplisit wanita
    if (/(female|woman|zira|samantha|ava|aria|jenny|susan|gadis|perempuan)/i.test(n)) return true;
    // Google / Microsoft / Neural id-ID umumnya suara wanita — boleh dipakai
    if (/(google|microsoft|natural|neural|premium|wavenet|studio)/i.test(n)) return true;
    // Nama generik "Bahasa Indonesia" / "Indonesian" tanpa penanda pria
    if (/(bahasa indonesia|indonesian)/i.test(n)) return true;
    return false;
  }

  function refreshVoices() {
    if (!("speechSynthesis" in global)) { selectedVoice = null; return false; }
    var voices = global.speechSynthesis.getVoices() || [];
    if (!voices.length) { selectedVoice = null; return false; }
    var idFemale = voices.filter(isConfirmedFemale);
    selectedVoice =
      idFemale.find(function (v) { return /gadis|female|wanita|perempuan/i.test(String(v.name || "")); }) ||
      idFemale.find(function (v) { return /google|microsoft|natural|premium|neural/i.test(String(v.name || "")); }) ||
      idFemale[0] || null;
    // Last resort: any id-ID not marked male (hindari robot/pria)
    if (!selectedVoice) {
      var idAny = voices.filter(function (v) {
        var l = String((v && v.lang) || "").toLowerCase();
        var n = String((v && v.name) || "") + " " + String((v && v.voiceURI) || "");
        return isIdLang(l, n) && !isMaleMarked(n);
      });
      selectedVoice = idAny[0] || null;
    }
    return !!selectedVoice;
  }

  if ("speechSynthesis" in global) {
    // Refresh halaman bisa meninggalkan mesin suara dalam keadaan macet/paused: bersihkan.
    try { global.speechSynthesis.cancel(); global.speechSynthesis.resume(); } catch (_) {}
    refreshVoices();
    global.speechSynthesis.onvoiceschanged = refreshVoices;
    try {
      global.addEventListener("pagehide", function () {
        try { global.speechSynthesis.cancel(); } catch (_) {}
      });
      ["pointerdown", "touchend", "keydown"].forEach(function (n) {
        global.addEventListener(n, function () {
          // Ucapan terakhir ditolak browser karena belum ada interaksi: ulangi sekali begitu pengguna menyentuh layar.
          if (_pendingText && Date.now() - _pendingAt < 60000 && enabled) {
            var t = _pendingText; _pendingText = null;
            try { speakTTS(t, {}); } catch (_) {}
          }
        }, { capture: true, passive: true });
      });
    } catch (_) {}
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
    // MUTLAK: klip MP3 stage/beep = suara robot. Tidak pernah diputar.
    return Promise.resolve(false);
  }


  // ---- TTS tangguh: tunggu suara siap, pecah per kalimat, deteksi "tidak mulai", coba ulang sekali ----
  var _ttsSession = 0;
  var _diag = { lastResult: "", lastError: "", voiceCount: 0, voiceName: "", at: 0 };

  function waitForVoices(maxMs) {
    return new Promise(function (resolve) {
      if (refreshVoices() && selectedVoice) return resolve(true);
      var t0 = Date.now();
      var iv = setInterval(function () {
        if ((refreshVoices() && selectedVoice) || Date.now() - t0 > maxMs) {
          clearInterval(iv);
          resolve(!!selectedVoice);
        }
      }, 150);
    });
  }

  function splitSpeech(text) {
    // Chrome sering memotong/membisukan ucapan panjang (>~15 detik): ucapkan per potongan pendek.
    var parts = String(text).match(/[^.!?;:]+[.!?;:]?\s*/g) || [String(text)];
    var out = [], buf = "";
    parts.forEach(function (p) {
      p = p.trim();
      if (!p) return;
      if (buf && (buf + " " + p).length > 140) { out.push(buf); buf = p; }
      else buf = buf ? buf + " " + p : p;
    });
    if (buf) out.push(buf);
    var fin = [];
    out.forEach(function (c) {
      while (c.length > 180) {
        var cut = c.lastIndexOf(" ", 170);
        if (cut < 60) cut = 170;
        fin.push(c.slice(0, cut));
        c = c.slice(cut).trim();
      }
      if (c) fin.push(c);
    });
    return fin;
  }

  function hardReset(cb) {
    var ss = global.speechSynthesis;
    try { if (ss.speaking || ss.pending || ss.paused) ss.cancel(); } catch (_) {}
    try { ss.resume(); } catch (_) {}
    // cancel() lalu speak() seketika sering membuat ucapan berikutnya dibuang: beri jeda singkat.
    setTimeout(cb, 120);
  }

  var _pendingText = null, _pendingAt = 0;
  function speakChunk(chunk, opts, useVoice) {
    return new Promise(function (resolve) {
      var ss = global.speechSynthesis;
      var u = new SpeechSynthesisUtterance(chunk);
      if (useVoice && selectedVoice) {
        u.lang = selectedVoice.lang || "id-ID";
        u.voice = selectedVoice;
      } else {
        u.lang = "id-ID";
      }
      u.rate = (opts && opts.rate != null) ? opts.rate : 0.92;
      u.pitch = (opts && opts.pitch != null) ? opts.pitch : 1.08;
      u.volume = 1;
      var started = false, done = false, startTimer = null, maxTimer = null;
      function fin(r) {
        if (done) return;
        done = true;
        clearTimeout(startTimer);
        clearTimeout(maxTimer);
        resolve(r);
      }
      u.onstart = function () { started = true; clearTimeout(startTimer); };
      u.onend = function () { fin("ok"); };
      u.onerror = function (e) {
        var er = e && e.error ? String(e.error) : "";
        _diag.lastError = er;
        fin(er === "interrupted" || er === "canceled" ? "cancel" : "fail");
      };
      startTimer = setTimeout(function () {
        var live = false;
        try { live = !!ss.speaking; } catch (_) {}
        if (!started && !live) { try { ss.cancel(); } catch (_) {} fin("nostart"); }
      }, 3500);
      maxTimer = setTimeout(function () {
        try { ss.cancel(); } catch (_) {}
        fin(started ? "ok" : "fail");
      }, Math.min(30000, 4000 + chunk.length * 160));
      try {
        if (ss.paused) ss.resume();
        ss.speak(u);
      } catch (_) { fin("fail"); }
    });
  }

  function speakTTS(text, opts) {
    return new Promise(function (resolve) {
      if (!("speechSynthesis" in global) || !text) return resolve(false);
      var session = ++_ttsSession;
      waitForVoices(1500).then(function (ok) {
        _diag.voiceCount = ((global.speechSynthesis.getVoices && global.speechSynthesis.getVoices()) || []).length;
        _diag.voiceName = selectedVoice ? String(selectedVoice.name || "") : "";
        _diag.at = Date.now();
        // Tidak ada suara id terdeteksi: tetap bicara dengan lang "id-ID" (mesin bawaan perangkat memilih
        // suara Indonesia sendiri — umumnya wanita). Diam total jauh lebih buruk daripada suara bawaan.
        if (!selectedVoice) { _diag.voiceName = "(bawaan id-ID)"; }
        if (session !== _ttsSession) { _diag.lastResult = "superseded"; return resolve(false); }
        var chunks = splitSpeech(text), idx = 0, retried = false, useVoice = !!selectedVoice;
        speaking = true;
        function end(r, why) { speaking = false; _diag.lastResult = why; resolve(r); }
        function next() {
          if (session !== _ttsSession) return end(false, "superseded");
          if (idx >= chunks.length) return end(true, "ok");
          speakChunk(chunks[idx], opts, useVoice).then(function (r) {
            if (session !== _ttsSession) return end(false, "superseded");
            if (r === "ok") { idx++; return next(); }
            if (r === "nostart" && !retried) { retried = true; return hardReset(next); }
            // suara terpilih ditolak mesin (synthesis-failed dsb): coba sekali tanpa memilih suara
            if (r === "fail" && useVoice) { useVoice = false; _diag.voiceName = "(bawaan id-ID)"; return hardReset(next); }
            // synthesis-failed / network: batalkan, resume, coba ulang sekali tanpa voice terpilih
            if (r === "fail" && /synthesis-failed|network|error/i.test(String(_diag.lastError)) && !retried) {
              retried = true; useVoice = false; _diag.voiceName = "(bawaan id-ID recovery)";
              return hardReset(next);
            }
            if (r === "fail" && /not-allowed/.test(String(_diag.lastError))) { _pendingText = String(text); _pendingAt = Date.now(); }
            end(idx > 0, r);
          });
        }
        hardReset(next);
      });
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
    // MUTLAK: tidak ada MP3/beep robot. Hanya TTS suara wanita (speakAnswer).
    if (!phrase) return Promise.resolve(false);
    return speakAnswer(phrase, { force: force, source: "emit:" + key, system: true });
  }


  function stop() {
    _chatSpeaking = false;
    _ttsSession++;
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
    // Force request (welcome, error, warning) boleh bypass queue-disabled.
    if (!options.force && global.CGOAudioQueue && typeof global.CGOAudioQueue.isEnabled === "function" && !global.CGOAudioQueue.isEnabled()) {
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
        jenis: options.system ? "sys" : "tts",
        priority: options.system ? 1 : 0,
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
        rate: 0.92,
        system: true
      });
    }).then(function (ok) {
      return { ok: !!ok, phrase: phrase };
    });
  }


  var _primed = false;
  function unlock() {
    unlocked = true;
    refreshVoices();
    if ("speechSynthesis" in global) {
      var ss = global.speechSynthesis;
      try { if (ss.paused) ss.resume(); } catch (_) {}
      // "Priming" cukup sekali, hanya setelah ada interaksi pengguna, dan tidak saat sedang bicara.
      var act = true;
      try { if (navigator.userActivation) act = !!navigator.userActivation.hasBeenActive; } catch (_) {}
      if (!_primed && act) {
        _primed = true;
        try {
          if (!ss.speaking && !ss.pending) {
            var u = new SpeechSynthesisUtterance(" ");
            u.volume = 0;
            ss.speak(u);
          }
        } catch (_) {}
      }
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
    diag: function () {
      var d = {}; for (var k in _diag) d[k] = _diag[k];
      d.enabled = enabled; d.unlocked = unlocked; d.chatSpeak = chatSpeakEnabled;
      try { d.engineSpeaking = !!global.speechSynthesis.speaking; d.enginePaused = !!global.speechSynthesis.paused; } catch (_) {}
      return d;
    },
    isEnabled: function () { return enabled; }
  };

  global.CGOOperatorVoice = api;
  global.CGO_OPERATOR_VOICE = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : this);
