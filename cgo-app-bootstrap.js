/* ============================================================
 * CIKUR GO — Customer CGO App Bootstrap
 * Wires navigation + optional discovery runtime to window.CGO
 * ============================================================ */
(function (window) {
  "use strict";

  function safeOpen(url) {
    try {
      window.location.href = url;
      return { success: true, url: url };
    } catch (e) {
      return { success: false, reason: String(e && e.message || e) };
    }
  }

  function connectNavigation() {
    if (!window.CGO || typeof window.CGO.connectNavigation !== "function") return;
    window.CGO.connectNavigation({
      openService: function (service, options) {
        const id = (service && (service.id || service.handoff && service.handoff.target)) || "";
        const map = {
          food: "./customer/food.html",
          ride: "./customer/ride.html",
          assistant: "./customer/assistant.html",
          cikurgo2in1: "./customer/cikurgo2in1.html"
        };
        const url = map[String(id).toLowerCase()];
        if (!url) {
          return { success: false, reason: "UNKNOWN_SERVICE", service: service };
        }
        return safeOpen(url);
      }
    });
  }

  /**
   * Discovery adapter (honest UNKNOWN by default).
   * When agent presence / resto data available via CikurCloud, extend here.
   * Never invent availability.
   */
  function connectDiscovery() {
    if (!window.CGO || typeof window.CGO.connectDiscovery !== "function") return;
    if (!window.CGO_CUSTOMER || !window.CGO_CUSTOMER.discovery) return;

    window.CGO.connectDiscovery({
      check: function (request) {
        // Without live agent/resto snapshot, return UNKNOWN (never fake AVAILABLE)
        return {
          ok: true,
          status: "unknown",
          verified: false,
          source: "bootstrap-local",
          requestId: request && request.requestId,
          message: "Runtime live belum terhubung ke sensor agent/resto. Tidak mengklaim ketersediaan.",
          items: [],
          count: 0
        };
      },
      checkAsync: async function (request) {
        return this.check(request);
      },
      findNearby: function (request) {
        return this.check(request);
      }
    });
  }

  function boot() {
    connectNavigation();
    connectDiscovery();
    const ready = window.CGO && typeof window.CGO.isReady === "function" ? window.CGO.isReady() : false;
    const modules = window.CGO && typeof window.CGO.getModuleStatus === "function" ? window.CGO.getModuleStatus() : {};
    console.info("[CGO Bootstrap] ready=", ready, "modules=", modules);
    try {
      window.dispatchEvent(new CustomEvent("cgo-customer-ready", { detail: { ready: ready, modules: modules } }));
    } catch (_) {}
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})(window);
