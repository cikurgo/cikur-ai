/**
 * CGO Audio Bus — koordinasi audio antar halaman (BCGO ↔ MESIN ABC)
 * BroadcastChannel("cgo-audio") + Page Visibility.
 * Offline only. Tidak mengubah path MP3.
 */
(function (global) {
  "use strict";
  const VERSION = "1.0.2-CLAIM-CLEANUP";
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

  function isHidden() {
    try { return !!(typeof document !== "undefined" && document.hidden); } catch (_) { return false; }
  }

  function onMessage(ev) {
    const d = ev && ev.data;
    if (!d || d.from === PAGE_ID) return;
    if (d.aksi === "klaim") {
      remoteClaim = { id: d.id, priority: Number(d.prioritas) || 99, ts: Date.now() };
    } else if (d.aksi === "lepas") {
      if (remoteClaim && remoteClaim.id === d.id) remoteClaim = null;
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
    isHidden: isHidden
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
