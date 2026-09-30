/**
 * CGO Audio Bus — koordinasi audio antar halaman (BCGO ↔ MESIN ABC)
 * BroadcastChannel("cgo-audio") + Page Visibility.
 * Offline only. Tidak mengubah path MP3.
 */
(function (global) {
  "use strict";
  const VERSION = "1.0.0-AUDIO-BUS";
  const CHANNEL = "cgo-audio";
  const PAGE_ID = "cgo-" + Math.random().toString(36).slice(2, 10);

  let bc = null;
  try { bc = new BroadcastChannel(CHANNEL); } catch (_) {}

  let mutedByVisibility = false;
  let remoteClaim = null; // { id, priority, ts }

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
            if (global.CGOAudioQueue && typeof global.CGOAudioQueue.pause === "function") {
              global.CGOAudioQueue.pause();
            }
            if (global.speechSynthesis) global.speechSynthesis.cancel();
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
    if (remoteClaim && remoteClaim.priority < pri) {
      // remote has higher priority (lower number)
      return { ok: false, reason: "remote-higher", id: claimId, remote: remoteClaim };
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
    if (remoteClaim && remoteClaim.priority < pri) return false;
    return true;
  }

  global.CGOAudioBus = Object.freeze({
    version: VERSION,
    pageId: PAGE_ID,
    klaim: klaim,
    lepas: lepas,
    canPlay: canPlay,
    isHidden: isHidden
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
