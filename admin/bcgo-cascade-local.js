/**
 * BCGO Wake Cascade v4.4 — audit upgrade
 * Sumber kebenaran: window.CGO_OTAK (cgo-otak-hub.js)
 * Zero regresi: aditif · satu pemilik mic · TTS hanya jika operator belum ada
 */
(function () {
  "use strict";
  if (window.__CGO_WAKE_CASCADE_INIT__) return;
  window.__CGO_WAKE_CASCADE_INIT__ = true;
  window.__CGO_WAKE_CASCADE_OWN__ = true;

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var mode = "OFF";
  var wakeRec = null;
  var asrRec = null;
  var starting = false;
  var finalBuf = "";
  var silenceT = null;
  var sessionT = null;
  var restartT = null;
  var lastRestart = 0;
  var ttsCooldownUntil = 0;
  var VERSION = "4.4.0-AUDIT";

  function otak() { return window.CGO_OTAK || null; }

  function wakeEnabled() {
    var o = otak();
    if (!o) return true;
    if (typeof o.isWakeEnabled === "function") return !!o.isWakeEnabled();
    return true;
  }

  function primaryLabel() {
    var o = otak();
    if (o && typeof o.wakeStatus === "function") {
      try {
        var s = o.wakeStatus();
        if (s && s.primary) return String(s.primary);
      } catch (_) {}
    }
    if (o && o.wakeWords && o.wakeWords.primary) return String(o.wakeWords.primary);
    return "CGO";
  }

  function wakeWordList() {
    var o = otak();
    if (o && typeof o.wakeStatus === "function") {
      try {
        var s = o.wakeStatus();
        if (s && Array.isArray(s.words) && s.words.length) {
          return s.words.map(function (w) { return String(w || "").toLowerCase(); });
        }
      } catch (_) {}
    }
    if (o && o.wakeWords) {
      return [].concat(
        [o.wakeWords.primary],
        o.wakeWords.variants || [],
        o.wakeWords.secondary || []
      ).map(function (w) { return String(w || "").toLowerCase(); }).filter(Boolean);
    }
    return ["cgo", "c g o", "halo cgo", "hey cgo", "ok cgo", "oke cgo"];
  }

  /** Deteksi lewat Hub saja (satu jalur event). */
  function hubDetect(text) {
    var o = otak();
    if (!o) {
      var t = String(text || "").toLowerCase();
      return t.indexOf("cgo") >= 0;
    }
    if (typeof o.detectWake === "function") {
      try { return !!o.detectWake(text); } catch (_) {}
    }
    if (typeof o.onWakeTranscript === "function") {
      try {
        var r = o.onWakeTranscript(text, { force: true });
        return !!(r && r.heard);
      } catch (_) {}
    }
    return false;
  }

  function stripWake(text) {
    var t = String(text || "")
      .toLowerCase()
      .replace(/[-_.]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    var words = wakeWordList();
    words = words.slice().sort(function (a, b) { return b.length - a.length; });
    for (var i = 0; i < words.length; i++) {
      var v = String(words[i] || "").toLowerCase().replace(/[-_.]/g, " ").replace(/\s+/g, " ").trim();
      if (!v) continue;
      var esc = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      t = t.replace(new RegExp("\\b" + esc + "\\b", "gi"), " ");
    }
    return t.replace(/\s+/g, " ").trim();
  }
  function setStatus(text, tone) {
    var el = document.getElementById("cgo-wake-engine-status");
    if (el) {
      el.textContent = text;
      el.style.borderColor = tone === "ok" ? "#166534" : tone === "bad" ? "#881337" : tone === "live" ? "#1e3a5f" : "#334155";
      el.style.color = tone === "ok" ? "#86efac" : tone === "bad" ? "#fda4af" : tone === "live" ? "#67e8f9" : "#94a3b8";
      el.style.background = tone === "ok" ? "#052e16" : tone === "bad" ? "#4c0519" : "transparent";
    }
    var ind = document.getElementById("bcgo-wake-indicator");
    if (ind) {
      var p = primaryLabel();
      if (tone === "ok" || tone === "live") {
        ind.textContent = "WAKE · " + p + (mode === "STANDBY" ? " · siaga" : mode === "ACTIVE" ? " · dengar" : "");
        ind.classList.add("on");
        ind.title = "Otak Hub · " + p + " · mode " + mode;
      } else {
        ind.textContent = "WAKE · OFF";
        ind.classList.remove("on");
      }
    }
    var micEl = document.getElementById("cgo-mic-status");
    if (micEl) {
      if (mode === "STANDBY") {
        micEl.textContent = "WAKE " + primaryLabel() + " SIAGA";
        micEl.setAttribute("data-tone", "idle");
      } else if (mode === "ACTIVE") {
        micEl.textContent = "MENDENGARKAN PERINTAH…";
        micEl.setAttribute("data-tone", "live");
      }
    }
  }

  function showBanner(t, ms) {
    var b = document.getElementById("bcgo-listening-banner");
    var te = document.getElementById("bcgo-listening-text");
    var orb = document.getElementById("cgo-orb-wrap");
    if (!b) return;
    if (te && t) te.textContent = t;
    b.classList.add("on");
    if (orb) orb.classList.add("bcgo-listening");
    if (ms) setTimeout(hideBanner, ms);
  }
  function hideBanner() {
    var b = document.getElementById("bcgo-listening-banner");
    var orb = document.getElementById("cgo-orb-wrap");
    if (b) b.classList.remove("on");
    if (orb) orb.classList.remove("bcgo-listening");
  }
  function setMicBtn(on) {
    var btn = document.getElementById("chat-mic");
    if (btn) {
      btn.classList.toggle("mic-listening", !!on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }
  function clearTimers() {
    try { if (silenceT) clearTimeout(silenceT); } catch (_) {}
    try { if (sessionT) clearTimeout(sessionT); } catch (_) {}
    try { if (restartT) clearTimeout(restartT); } catch (_) {}
    silenceT = sessionT = restartT = null;
  }
  function destroyRec(rec) {
    if (!rec) return;
    try { rec.onstart = rec.onresult = rec.onerror = rec.onend = null; } catch (_) {}
    try { rec.abort(); } catch (_) { try { rec.stop(); } catch (__) {} }
  }
  function stopAll(reason) {
    clearTimers();
    starting = false;
    destroyRec(wakeRec); wakeRec = null;
    destroyRec(asrRec); asrRec = null;
    mode = "OFF";
    finalBuf = "";
    setMicBtn(false);
    hideBanner();
    setStatus("STOP", "idle");
    try {
      window.dispatchEvent(new CustomEvent("cgo:mic-status", { detail: { state: "IDLE", reason: reason || "" } }));
    } catch (_) {}
  }

  function enterStandby() {
    if (!wakeEnabled()) return;
    if (!SR) { setStatus("SR TIDAK DIDUKUNG", "bad"); return; }
    if (!window.isSecureContext && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
      setStatus("BUTUH LOCALHOST/HTTPS", "bad");
      return;
    }
    // Jangan start standby saat TTS masih bicara / cooldown
    if (Date.now() < ttsCooldownUntil) {
      restartT = setTimeout(function () {
        if (wakeEnabled() && mode !== "ACTIVE") enterStandby();
      }, Math.max(300, ttsCooldownUntil - Date.now()));
      return;
    }
    try {
      if (window.CGOOperatorVoice && window.CGOOperatorVoice.isSpeaking && window.CGOOperatorVoice.isSpeaking()) {
        restartT = setTimeout(function () {
          if (wakeEnabled() && mode !== "ACTIVE") enterStandby();
        }, 600);
        return;
      }
    } catch (_) {}

    if (starting || mode === "ACTIVE") return;
    var now = Date.now();
    if (now - lastRestart < 700) return;
    lastRestart = now;

    clearTimers();
    destroyRec(wakeRec); wakeRec = null;
    destroyRec(asrRec); asrRec = null;
    mode = "STANDBY";
    starting = true;
    finalBuf = "";
    setMicBtn(false);
    setStatus("SIAGA · " + primaryLabel(), "ok");

    try {
      wakeRec = new SR();
      wakeRec.lang = "id-ID";
      wakeRec.interimResults = true;
      wakeRec.continuous = true;
      wakeRec.maxAlternatives = 1;

      wakeRec.onstart = function () {
        starting = false;
        mode = "STANDBY";
      };
      wakeRec.onresult = function (ev) {
        if (mode !== "STANDBY") return;
        if (Date.now() < ttsCooldownUntil) return;
        var draft = "";
        for (var i = ev.resultIndex; i < ev.results.length; i++) {
          draft += String(ev.results[i][0] && ev.results[i][0].transcript || "");
        }
        draft = draft.trim();
        if (!draft) return;
        // Satu deteksi lewat Hub (emit event internal Hub)
        if (hubDetect(draft)) {
          enterActive("wake", stripWake(draft));
        }
      };
      wakeRec.onerror = function (ev) {
        starting = false;
        var code = String(ev && ev.error || "");
        if (code === "not-allowed" || code === "service-not-allowed" || code === "audio-capture") {
          setStatus("MIC DITOLAK · cek izin", "bad");
          mode = "OFF";
          return;
        }
        // no-speech / aborted / network → biar onend restart
      };
      wakeRec.onend = function () {
        wakeRec = null;
        starting = false;
        if (mode === "STANDBY" && wakeEnabled()) {
          restartT = setTimeout(function () {
            if (mode === "STANDBY" && wakeEnabled() && !starting) enterStandby();
          }, 650);
        }
      };

      try {
        if (window.CGOOperatorVoice && window.CGOOperatorVoice.stop) window.CGOOperatorVoice.stop();
      } catch (_) {}
      wakeRec.start();
    } catch (e) {
      starting = false;
      mode = "OFF";
      console.warn("[BCGO-WAKE " + VERSION + "] standby", e);
      setStatus("STANDBY GAGAL", "bad");
    }
  }

  function enterActive(source, prefill) {
    if (!SR) return;
    clearTimers();
    destroyRec(wakeRec); wakeRec = null;
    destroyRec(asrRec); asrRec = null;
    mode = "ACTIVE";
    starting = true;
    finalBuf = prefill ? String(prefill).trim() : "";
    setMicBtn(true);
    showBanner(
      source === "wake"
        ? primaryLabel() + " TERBANGUN · SILAKAN PERINTAH"
        : "CGO SEDANG MENDENGAR…"
    );
    setStatus("ACTIVE · perintah", "live");
    try {
      window.dispatchEvent(new CustomEvent("cgo:mic-status", { detail: { state: "LISTENING", source: source || "" } }));
    } catch (_) {}

    try {
      asrRec = new SR();
      asrRec.lang = "id-ID";
      asrRec.interimResults = true;
      asrRec.continuous = false;
      asrRec.maxAlternatives = 1;

      asrRec.onstart = function () {
        starting = false;
        var silenceMs = finalBuf.length > 2 ? 2000 : 4800;
        silenceT = setTimeout(function () {
          try { if (asrRec) asrRec.stop(); } catch (_) {}
        }, silenceMs);
        sessionT = setTimeout(function () {
          try { if (asrRec) asrRec.abort(); } catch (_) {}
        }, 14000);
      };
      asrRec.onresult = function (ev) {
        if (mode !== "ACTIVE") return;
        var interim = "", final = "";
        for (var i = ev.resultIndex; i < ev.results.length; i++) {
          var t = String(ev.results[i][0] && ev.results[i][0].transcript || "");
          if (ev.results[i].isFinal) final += t;
          else interim += t;
        }
        if (final.trim()) finalBuf = (finalBuf + " " + final.trim()).trim();
        var draft = (finalBuf + " " + interim).trim();
        try {
          var it = document.getElementById("cgo-interim-text");
          var ie = document.getElementById("cgo-interim");
          if (it) it.textContent = draft;
          if (ie) ie.classList.add("on");
          var input = document.getElementById("chat-input");
          if (input && draft) input.placeholder = draft;
        } catch (_) {}
        try { if (silenceT) clearTimeout(silenceT); } catch (_) {}
        silenceT = setTimeout(function () {
          try { if (asrRec) asrRec.stop(); } catch (_) {}
        }, 2200);
      };
      asrRec.onerror = function (ev) {
        starting = false;
        var code = String(ev && ev.error || "");
        if (code === "not-allowed" || code === "service-not-allowed") {
          setStatus("MIC DITOLAK", "bad");
          stopAll("denied");
        }
      };
      asrRec.onend = function () {
        clearTimers();
        asrRec = null;
        starting = false;
        setMicBtn(false);
        hideBanner();
        try {
          var ie = document.getElementById("cgo-interim");
          if (ie) ie.classList.remove("on");
        } catch (_) {}

        var text = finalBuf.trim();
        if (hubDetect(text)) text = stripWake(text);
        finalBuf = "";

        if (text) {
          try {
            window.dispatchEvent(new CustomEvent("cgo:mic-transcript", { detail: { text: text, modality: "voice" } }));
            window.dispatchEvent(new CustomEvent("cgo:mic-status", { detail: { state: "TRANSCRIPT", text: text } }));
          } catch (_) {}

          // Jalur chat utama
          var sent = false;
          if (typeof window.CGO_BCGO_SEND_QUESTION === "function") {
            try {
              window.CGO_BCGO_SEND_QUESTION(text, { modality: "voice", fromWake: source === "wake" });
              sent = true;
            } catch (_) {}
          }
          if (!sent && otak() && typeof otak().ask === "function") {
            try {
              Promise.resolve(otak().ask(text, { source: "voice" })).then(function (r) {
                if (r && r.answer) {
                  try {
                    if (window.CGOOperatorVoice && window.CGOOperatorVoice.speakAnswer) {
                      markTtsCooldown(r.answer);
                      window.CGOOperatorVoice.speakAnswer(r.answer);
                    }
                  } catch (_) {}
                }
              });
              sent = true;
            } catch (_) {}
          }
          if (!sent) {
            var input = document.getElementById("chat-input");
            if (input) input.value = text;
          }
        }

        mode = "OFF";
        // cooldown sebelum standby agar TTS jawaban tidak tertangkap sebagai wake
        ttsCooldownUntil = Date.now() + 1200;
        if (wakeEnabled()) {
          restartT = setTimeout(function () { enterStandby(); }, 1100);
        } else {
          setStatus("OFF", "idle");
        }
      };

      try {
        if (window.CGOOperatorVoice && window.CGOOperatorVoice.stop) window.CGOOperatorVoice.stop();
      } catch (_) {}
      asrRec.start();
    } catch (e) {
      starting = false;
      mode = "OFF";
      setMicBtn(false);
      hideBanner();
      console.warn("[BCGO-WAKE " + VERSION + "] active", e);
      setStatus("ASR GAGAL", "bad");
      if (wakeEnabled()) setTimeout(enterStandby, 1000);
    }
  }

  function markTtsCooldown(text) {
    var n = String(text || "").length;
    // ~60ms per karakter, min 1.2s max 12s
    var ms = Math.min(12000, Math.max(1200, Math.floor(n * 60)));
    ttsCooldownUntil = Date.now() + ms;
  }

  function onMicClick(ev) {
    try {
      if (ev) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    } catch (_) {}
    try {
      if (window.CGOOperatorVoice) window.CGOOperatorVoice.unlock && window.CGOOperatorVoice.unlock();
    } catch (_) {}
    if (mode === "ACTIVE") {
      try { if (asrRec) asrRec.stop(); } catch (_) {}
      return;
    }
    enterActive("button", "");
  }

  function ensurePanel() {
    if (document.getElementById("cgo-ondevice-wake-panel")) return;
    var chatHead = document.querySelector(".cgo-chat-head");
    var panel = document.createElement("div");
    panel.id = "cgo-ondevice-wake-panel";
    panel.style.cssText =
      "margin:10px 0;padding:12px 14px;border:1px solid #1e3a5f;border-radius:12px;background:linear-gradient(135deg,#06111f,#0a1628);font-size:12px;color:#cbd5e1";
    panel.innerHTML =
      '<div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between">' +
      '<div><div style="font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#67e8f9;font-weight:800">Wake · Otak Hub</div>' +
      '<div style="font-size:10px;color:#64748b;margin-top:3px">Sumber: <b style="color:#67e8f9">CGO_OTAK</b> · v' +
      VERSION +
      "</div></div>" +
      '<span id="cgo-wake-engine-status" style="font:10px ui-monospace,monospace;border:1px solid #334155;border-radius:999px;padding:4px 10px;color:#94a3b8">BELUM SIAP</span>' +
      "</div>" +
      '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;align-items:center">' +
      '<button id="cgo-local-start" type="button" style="padding:8px 14px;border-radius:8px;border:1px solid #166534;background:#052e16;color:#86efac;font-weight:700;cursor:pointer;font-size:11px">Aktifkan WAKE</button>' +
      '<button id="cgo-local-stop" type="button" style="padding:8px 14px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#94a3b8;cursor:pointer;font-size:11px">Stop</button>' +
      "</div>" +
      '<div style="margin-top:8px;font-size:10px;color:#64748b;line-height:1.45">' +
      "Ucapkan <b>CGO</b> (varian Hub) lalu perintah · mic = langsung perintah.<br>" +
      "Satu pemilik mic · sinkron Hub · zero regresi setupChatMic." +
      "</div>";
    if (chatHead && chatHead.parentNode) chatHead.parentNode.insertBefore(panel, chatHead.nextSibling);
    else document.body.prepend(panel);

    document.getElementById("cgo-local-start").onclick = function () {
      var o = otak();
      if (o && typeof o.setWakeEnabled === "function") o.setWakeEnabled(true);
      enterStandby();
    };
    document.getElementById("cgo-local-stop").onclick = function () {
      var o = otak();
      if (o && typeof o.setWakeEnabled === "function") o.setWakeEnabled(false);
      stopAll("user-stop");
    };

    // Badge indicator toggle
    try {
      var ind = document.getElementById("bcgo-wake-indicator");
      if (ind && !ind.__cgoCascadeBound) {
        ind.__cgoCascadeBound = true;
        ind.style.cursor = "pointer";
        ind.addEventListener("click", function () {
          var o = otak();
          var next = !wakeEnabled();
          if (o && typeof o.setWakeEnabled === "function") o.setWakeEnabled(next);
          if (next) enterStandby();
          else stopAll("badge-toggle");
        });
      }
    } catch (_) {}
  }

  function bindMic() {
    var micBtn = document.getElementById("chat-mic");
    if (!micBtn) return;
    try {
      var neo = micBtn.cloneNode(true);
      micBtn.parentNode.replaceChild(neo, micBtn);
      neo.addEventListener("click", onMicClick);
      neo.title = "Perintah langsung (tanpa wake) · cascade " + VERSION;
    } catch (_) {
      try { micBtn.addEventListener("click", onMicClick); } catch (__) {}
    }
  }

  /* TTS polyfill — HANYA jika operator asli belum punya speakAnswer */
  (function installVoiceIfNeeded() {
    if (window.CGOOperatorVoice && typeof window.CGOOperatorVoice.speakAnswer === "function") {
      // bungkus speakAnswer agar set cooldown standby
      try {
        var orig = window.CGOOperatorVoice.speakAnswer.bind(window.CGOOperatorVoice);
        window.CGOOperatorVoice.speakAnswer = function (text, opts) {
          markTtsCooldown(text);
          return orig(text, opts);
        };
      } catch (_) {}
      return;
    }
    var ss = window.speechSynthesis;
    var enabled = true, chatSpeak = true, unlocked = false, femaleVoice = null, speaking = false;
    function pick() {
      if (!ss) return null;
      var list = ss.getVoices() || [];
      var scored = list.map(function (v) {
        var n = ((v.name || "") + " " + (v.lang || "")).toLowerCase();
        var s = 0;
        if (/id-id|indonesia/.test(n) || /^id/i.test(v.lang || "")) s += 50;
        if (/female|wanita|woman|girl|siti|damayanti/.test(n)) s += 30;
        if (/google/.test(n)) s += 10;
        return { v: v, s: s };
      }).sort(function (a, b) { return b.s - a.s; });
      return scored[0] && scored[0].s > 0 ? scored[0].v : list[0] || null;
    }
    function refresh() { try { femaleVoice = pick(); } catch (_) {} }
    refresh();
    try {
      if (ss) {
        ss.addEventListener("voiceschanged", refresh);
        ss.getVoices();
      }
    } catch (_) {}
    function unlock() {
      unlocked = true;
      try { if (ss && ss.paused) ss.resume(); } catch (_) {}
    }
    function speakRaw(text, opts) {
      opts = opts || {};
      if (!enabled && !opts.force) return Promise.resolve();
      if (!ss) return Promise.resolve();
      if (!unlocked) unlock();
      var t = String(text || "").replace(/\s+/g, " ").trim();
      if (!t) return Promise.resolve();
      markTtsCooldown(t);
      return new Promise(function (resolve) {
        try {
          ss.cancel();
          speaking = false;
          setTimeout(function () {
            var u = new SpeechSynthesisUtterance(t.slice(0, 700));
            u.lang = "id-ID";
            u.rate = 1.02;
            u.pitch = 1.08;
            if (femaleVoice) try { u.voice = femaleVoice; } catch (_) {}
            var done = false;
            var fin = function () {
              if (done) return;
              done = true;
              speaking = false;
              resolve();
            };
            u.onend = fin;
            u.onerror = fin;
            speaking = true;
            ss.speak(u);
          }, 40);
        } catch (_) {
          speaking = false;
          resolve();
        }
      });
    }
    window.CGOOperatorVoice = {
      version: "polyfill-" + VERSION,
      unlock: unlock,
      setEnabled: function (v) { enabled = !!v; },
      isEnabled: function () { return enabled; },
      setChatSpeak: function (v) { chatSpeak = !!v; },
      setQuietLive: function () {},
      stop: function () {
        speaking = false;
        try { if (ss) ss.cancel(); } catch (_) {}
      },
      state: function () {},
      isSpeaking: function () { return speaking; },
      welcome: function () {
        return speakRaw("Halo, saya operator CGO. Ucapkan CGO atau tekan mic.", { force: true });
      },
      speakAnswer: function (text, opts) {
        if (!chatSpeak && !(opts && opts.force)) return Promise.resolve();
        return speakRaw(text, opts);
      },
      speak: function (text, opts) { return speakRaw(text, opts); }
    };
    try {
      var badge = document.getElementById("cgo-voice-mode-badge");
      if (badge) badge.textContent = "TTS · wanita";
    } catch (_) {}
    console.log("[BCGO-WAKE] TTS polyfill ·", VERSION);
  })();

  // Hub events
  try {
    window.addEventListener("cgo:wake-enabled", function () {
      if (wakeEnabled()) enterStandby();
    });
    window.addEventListener("cgo:wake-disabled", function () {
      stopAll("hub-off");
    });
    window.addEventListener("cgo:otak-state", function () {
      if (mode === "STANDBY") setStatus("SIAGA · " + primaryLabel(), "ok");
    });
  } catch (_) {}

  window.CGOLocalWake = {
    version: VERSION,
    start: enterStandby,
    stop: function () { stopAll("api"); },
    mode: function () { return mode; },
    primary: primaryLabel
  };

  function boot() {
    ensurePanel();
    bindMic();
    setStatus("SIAP · Hub " + (otak() ? "OK" : "…"), otak() ? "idle" : "idle");
    console.log("[BCGO-WAKE " + VERSION + "] primary=", primaryLabel(), "hub=", !!otak());
    // Jika hub sudah enable (default true), siaga setelah gesture
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  var gestured = false;
  function onGesture() {
    if (gestured) return;
    gestured = true;
    try {
      if (window.CGOOperatorVoice) {
        window.CGOOperatorVoice.unlock && window.CGOOperatorVoice.unlock();
        window.CGOOperatorVoice.setEnabled && window.CGOOperatorVoice.setEnabled(true);
        window.CGOOperatorVoice.setChatSpeak && window.CGOOperatorVoice.setChatSpeak(true);
      }
    } catch (_) {}
    if (wakeEnabled()) {
      setTimeout(function () {
        enterStandby();
        try {
          if (window.CGOOperatorVoice && window.CGOOperatorVoice.welcome) {
            var KEY = "cgo-welcome-audit44";
            var now = Date.now();
            var last = 0;
            try { last = Number(sessionStorage.getItem(KEY)) || 0; } catch (_) {}
            if (now - last > 5000) {
              try { sessionStorage.setItem(KEY, String(now)); } catch (_) {}
              window.CGOOperatorVoice.welcome();
            }
          }
        } catch (_) {}
      }, 450);
    }
  }
  ["pointerdown", "touchstart", "click"].forEach(function (n) {
    try {
      window.addEventListener(n, onGesture, { capture: true, passive: true });
    } catch (_) {}
  });
})();
