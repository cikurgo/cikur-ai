/**
 * CGO Audio Bus — koordinasi audio antar halaman (BCGO ↔ MESIN ABC)
 * BroadcastChannel("cgo-audio") + Page Visibility.
 * Offline only. Tidak mengubah path MP3.
 *
 * v1.1.0 (aditif, API lama tidak berubah):
 *   klaimMic()/lepasMic(id)  → kunci mikrofon: TTS/antrean dijeda selama sesi dengar; otomatis
 *                              kedaluwarsa (MIC_TTL_MS) agar suara tidak bisu selamanya bila lepasMic terlewat.
 *   klaimWake()/lepasWake()  → lease wake-listener antar-tab (hanya satu tab yang mendengarkan).
 *   Event window: cgo:mic-claim · cgo:mic-release · cgo:wake-yield
 */
(function (global) {
  "use strict";
  const VERSION = "1.2.0-FX-STABLE";
  const CLAIM_TTL_MS = 30000; // klaim tab lain yang tidak pernah dilepas (tab ditutup) kedaluwarsa
  const CHANNEL = "cgo-audio";
  const PAGE_ID = "cgo-" + Math.random().toString(36).slice(2, 10);

  let bc = null;
  try { bc = new BroadcastChannel(CHANNEL); } catch (_) {}

  let mutedByVisibility = false;
  let remoteClaim = null; // { id, priority, ts }

  function activeRemote() {
    if (remoteClaim && Date.now() - remoteClaim.ts > CLAIM_TTL_MS) remoteClaim = null;
    return remoteClaim;
  }

  let pausedByBus = false;

  /* ---------- MIC LOCK + WAKE LEASE (v1.1.0) ---------- */
  const MIC_TTL_MS = 20000;   // sesi mic maks 15 dtk di BCGO; 20 dtk = batas aman anti-macet
  const WAKE_TTL_MS = 12000;  // lease wake kedaluwarsa bila pemegangnya mati (heartbeat 4 dtk)
  let myMic = null;           // { id, at }
  let remoteMic = null;       // { id, ts }
  let micExpiryT = null;
  let myWake = null;          // { id }
  let remoteWake = null;      // { id, ts }
  let wakeHbT = null;

  function fire(name, detail) {
    try {
      if (typeof global.dispatchEvent === "function" && typeof CustomEvent === "function") {
        global.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
      }
    } catch (_) {}
  }
  function post(msg) {
    try { if (bc) { msg.from = PAGE_ID; bc.postMessage(msg); } } catch (_) {}
  }
  function activeRemoteMic() {
    if (remoteMic && Date.now() - remoteMic.ts > MIC_TTL_MS) remoteMic = null;
    return remoteMic;
  }
  function activeRemoteWake() {
    if (remoteWake && Date.now() - remoteWake.ts > WAKE_TTL_MS) remoteWake = null;
    return remoteWake;
  }
  function isMicLocked() {
    if (myMic && Date.now() - myMic.at > MIC_TTL_MS) { releaseMic(myMic.id, true); }
    return !!myMic;
  }
  function releaseMic(id, expired) {
    if (!myMic) return false;
    if (id && myMic.id !== id) return false; // klaim lama tidak boleh melepas klaim sesi baru
    const old = myMic.id;
    myMic = null;
    try { if (micExpiryT) clearTimeout(micExpiryT); } catch (_) {}
    micExpiryT = null;
    post({ aksi: "mic-lepas", id: old });
    fire("cgo:mic-release", { id: old, expired: !!expired });
    return true;
  }
  /** Kunci mikrofon untuk sesi dengar. Mengembalikan { ok, id } atau { ok:false, reason }. */
  function klaimMic() {
    if (activeRemoteMic()) return { ok: false, reason: "remote-mic-busy" };
    if (myMic) releaseMic(myMic.id, false); // sesi sebelumnya yang tertinggal diganti
    const id = PAGE_ID + "-mic-" + Date.now();
    myMic = { id: id, at: Date.now() };
    post({ aksi: "mic-klaim", id: id });
    try { if (global.speechSynthesis) global.speechSynthesis.cancel(); } catch (_) {}
    try { if (micExpiryT) clearTimeout(micExpiryT); } catch (_) {}
    micExpiryT = setTimeout(function () { releaseMic(id, true); }, MIC_TTL_MS + 50);
    fire("cgo:mic-claim", { id: id });
    return { ok: true, id: id };
  }
  function lepasMic(id) { return releaseMic(id, false); }

  function holdsWake() { return !!myWake; }
  function sendWakeHb() { if (myWake) post({ aksi: "wake-klaim", id: myWake.id }); }
  function lepasWake() {
    if (!myWake) return false;
    const id = myWake.id;
    myWake = null;
    try { if (wakeHbT) clearInterval(wakeHbT); } catch (_) {}
    wakeHbT = null;
    post({ aksi: "wake-lepas", id: id });
    return true;
  }
  /** Lease wake-listener: hanya satu tab yang boleh membuka mikrofon untuk wake word. */
  function klaimWake() {
    if (myWake) return { ok: true, id: myWake.id, held: true };
    if (activeRemoteWake()) return { ok: false, reason: "remote-wake-active" };
    myWake = { id: PAGE_ID + "-wake-" + Date.now() };
    sendWakeHb();
    try { if (wakeHbT) clearInterval(wakeHbT); } catch (_) {}
    wakeHbT = setInterval(sendWakeHb, 4000);
    return { ok: true, id: myWake.id };
  }

  function isHidden() {
    try { return !!(typeof document !== "undefined" && document.hidden); } catch (_) { return false; }
  }

  function onMessage(ev) {
    const d = ev && ev.data;
    if (!d || d.from === PAGE_ID) return;
    if (d.aksi === "klaim") {
      remoteClaim = { id: d.id, priority: Number(d.prioritas) || 99, ts: Date.now() };
      fire("cgo:audio-remote-claim", { id: d.id, priority: Number(d.prioritas) });
    } else if (d.aksi === "lepas") {
      if (remoteClaim && remoteClaim.id === d.id) remoteClaim = null;
    } else if (d.aksi === "mic-klaim") {
      remoteMic = { id: d.id, ts: Date.now() };
      fire("cgo:mic-claim", { id: d.id, remote: true });
    } else if (d.aksi === "mic-lepas") {
      if (remoteMic && remoteMic.id === d.id) { remoteMic = null; fire("cgo:mic-release", { id: d.id, remote: true }); }
    } else if (d.aksi === "wake-klaim") {
      remoteWake = { id: d.id, ts: Date.now() };
      // dua tab mengklaim bersamaan: id yang lebih kecil menang (deterministik)
      if (myWake && String(d.id) < String(myWake.id)) { lepasWake(); fire("cgo:wake-yield", { to: d.id }); }
    } else if (d.aksi === "wake-lepas") {
      if (remoteWake && remoteWake.id === d.id) remoteWake = null;
    }
  }

  if (bc) {
    try { bc.onmessage = onMessage; } catch (_) {}
  }

  try {
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", function () {
        mutedByVisibility = isHidden();
        if (mutedByVisibility) {
          try {
            const q = global.CGOAudioQueue;
            if (q && typeof q.pause === "function") {
              const st = q.getStatus && q.getStatus();
              pausedByBus = !(st && st.paused);
              q.pause();
            }
            if (global.speechSynthesis) global.speechSynthesis.cancel();
          } catch (_) {}
        } else if (pausedByBus) {
          // kembali ke tab: lanjutkan antrean yang dijeda oleh bus (bukan oleh tombol Pause pengguna)
          pausedByBus = false;
          try {
            const q = global.CGOAudioQueue;
            if (q && typeof q.resume === "function" && !global.__cgoUserPausedAudio) q.resume();
            if (global.speechSynthesis && global.speechSynthesis.paused) global.speechSynthesis.resume();
          } catch (_) {}
        }
      });
    }
  } catch (_) {}

  function klaim(prioritas, id) {
    const claimId = id || (PAGE_ID + "-" + Date.now());
    const p = Number(prioritas);
    const pri = isNaN(p) ? 2 : p;
    if (mutedByVisibility || isHidden()) {
      return { ok: false, reason: "hidden", id: claimId };
    }
    const rc = activeRemote();
    if (rc && rc.priority < pri) {
      // remote has higher priority (lower number)
      return { ok: false, reason: "remote-higher", id: claimId, remote: rc };
    }
    try {
      if (bc) bc.postMessage({ aksi: "klaim", prioritas: pri, id: claimId, from: PAGE_ID });
    } catch (_) {}
    return { ok: true, id: claimId };
  }

  function lepas(id) {
    try {
      if (bc) bc.postMessage({ aksi: "lepas", id: id, from: PAGE_ID });
    } catch (_) {}
  }

  function canPlay(prioritas) {
    if (mutedByVisibility || isHidden()) return false;
    const p = Number(prioritas);
    const pri = isNaN(p) ? 2 : p;
    const rc = activeRemote();
    if (rc && rc.priority < pri) return false;
    return true;
  }

  // Lepas semua claim saat tab ditutup / refresh.
  var _myClaims = [];
  var _origKlaim = klaim;
  klaim = function (prioritas, id) {
    var r = _origKlaim(prioritas, id);
    if (r && r.ok) _myClaims.push(r.id);
    return r;
  };
  var _origLepas = lepas;
  lepas = function (id) {
    _myClaims = _myClaims.filter(function (x) { return x !== id; });
    return _origLepas(id);
  };
  function releaseAllClaims() {
    _myClaims.forEach(function (id) { try { _origLepas(id); } catch (_) {} });
    _myClaims = [];
    try { if (myMic) releaseMic(myMic.id, false); } catch (_) {}
    try { lepasWake(); } catch (_) {}
  }
  try {
    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", releaseAllClaims, { once: true });
      window.addEventListener("pagehide", releaseAllClaims, { once: true });
    }
  } catch (_) {}

  global.CGOAudioBus = Object.freeze({
    version: VERSION,
    pageId: PAGE_ID,
    klaim: klaim,
    lepas: lepas,
    canPlay: canPlay,
    isHidden: isHidden,
    // v1.1.0
    klaimMic: klaimMic,
    lepasMic: lepasMic,
    isMicLocked: isMicLocked,
    klaimWake: klaimWake,
    lepasWake: lepasWake,
    holdsWake: holdsWake,
    MIC_TTL_MS: MIC_TTL_MS
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
