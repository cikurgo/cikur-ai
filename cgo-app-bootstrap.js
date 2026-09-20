/* ============================================================
 * CIKUR GO — Customer CGO App Bootstrap
 * Navigation + Discovery runtime (mata Otak CGO)
 * ============================================================ */
(function (window) {
  "use strict";

  const FRESH_MS = 3 * 60 * 1000; // presence GPS dianggap fresh 3 menit
  const DEFAULT_RADIUS_KM = 50;

  function safeOpen(url) {
    try {
      window.location.href = url;
      return { success: true, url: url };
    } catch (e) {
      return { success: false, reason: String(e && e.message || e) };
    }
  }

  function haversineKm(a, b) {
    if (!a || !b) return null;
    if (![a.lat, a.lng, b.lat, b.lng].every(Number.isFinite)) return null;
    const R = 6371;
    const p1 = a.lat * Math.PI / 180;
    const p2 = b.lat * Math.PI / 180;
    const dlat = (b.lat - a.lat) * Math.PI / 180;
    const dlng = (b.lng - a.lng) * Math.PI / 180;
    const h = Math.sin(dlat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dlng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  let customerLocation = null;
  let customerLocationSource = "NONE";

  function ensureCustomerLocation() {
    return new Promise((resolve) => {
      if (customerLocation && customerLocationSource === "GPS") {
        resolve(customerLocation);
        return;
      }
      if (!navigator.geolocation) {
        customerLocationSource = "UNAVAILABLE";
        resolve(null);
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const lat = Number(pos.coords.latitude);
          const lng = Number(pos.coords.longitude);
          if (Number.isFinite(lat) && Number.isFinite(lng)) {
            customerLocation = { lat, lng, accuracy: pos.coords.accuracy };
            customerLocationSource = "GPS";
          }
          resolve(customerLocation);
        },
        () => {
          customerLocationSource = "DENIED";
          resolve(null);
        },
        { maximumAge: 120000, timeout: 8000, enableHighAccuracy: true }
      );
    });
  }

  function connectNavigation() {
    if (!window.CGO || typeof window.CGO.connectNavigation !== "function") return;
    window.CGO.connectNavigation({
      openService: function (service) {
        const id = (service && (service.id || (service.handoff && service.handoff.target))) || "";
        const map = {
          food: "./customer/food.html",
          ride: "./customer/ride.html",
          assistant: "./customer/assistant.html",
          cikurgo2in1: "./customer/cikurgo2in1.html"
        };
        const url = map[String(id).toLowerCase()];
        if (!url) return { success: false, reason: "UNKNOWN_SERVICE", service: service };
        return safeOpen(url);
      }
    });
  }

  /**
   * Discovery adapter = "mata" Otak CGO.
   * Membaca Firestore via CikurCloud (tidak mengarang).
   */
  function connectDiscovery() {
    if (!window.CGO || typeof window.CGO.connectDiscovery !== "function") return;
    if (!window.CGO_CUSTOMER || !window.CGO_CUSTOMER.discovery) return;

    async function runCheck(request) {
      const req = request && typeof request === "object" ? request : {};
      const requestId = req.requestId || ("disc-" + Date.now());
      const types = Array.isArray(req.types) ? req.types.map((t) => String(t).toLowerCase()) : [];
      const serviceId = String(req.serviceId || req.service || "").toLowerCase();
      const wantsAgent =
        !types.length ||
        types.some((t) => t === "agent" || t === "mitra") ||
        serviceId === "assistant" ||
        serviceId === "cikurgo2in1" ||
        /agent|asisten|assistant|dekat|nearby|tersedia/i.test(String(req.query || ""));
      const wantsFood =
        types.some((t) => t === "restaurant" || t === "mitra") ||
        serviceId === "food" ||
        serviceId === "cikurgo2in1" ||
        /makan|food|resto|lapar/i.test(String(req.query || ""));

      const origin =
        (req.location && Number.isFinite(req.location.lat) && req.location) ||
        (await ensureCustomerLocation());

      const radiusKm = Number(req.radiusKm) > 0 ? Number(req.radiusKm) : DEFAULT_RADIUS_KM;
      const cloud = window.CikurCloud;
      const items = [];
      const evidence = { sources: [], origin: origin || null, radiusKm };

      try {
        if (wantsAgent && cloud && typeof cloud.listOnlineAgentsOnce === "function") {
          const agents = await cloud.listOnlineAgentsOnce();
          evidence.sources.push("mitra_applications");
          for (const a of agents) {
            let distanceKm = null;
            if (origin && a.location) distanceKm = haversineKm(origin, a.location);
            const fresh =
              a.location &&
              (a.ageMs == null || a.ageMs <= FRESH_MS);
            // Tanpa lokasi customer: tetap laporkan agent online (tanpa ranking km)
            const inRange = distanceKm == null ? true : distanceKm <= radiusKm;
            if (!inRange) continue;
            items.push({
              id: a.id,
              agentId: a.agentId,
              name: a.name,
              type: "agent",
              status: fresh && a.location ? (a.available === false ? "BUSY" : "READY") : a.location ? "STALE" : "STANDBY",
              distanceKm: distanceKm != null ? Number(distanceKm.toFixed(2)) : null,
              location: a.location,
              presenceVerified: Boolean(fresh && a.location)
            });
          }
        }
      } catch (err) {
        evidence.agentError = String(err && err.message || err).slice(0, 180);
      }

      try {
        if (wantsFood && cloud && typeof cloud.listApprovedRestosOnce === "function") {
          const restos = await cloud.listApprovedRestosOnce();
          evidence.sources.push("resto_profiles");
          evidence.restoCount = restos.length;
          // Resto: cukup hitung yang approved (detail menu di food.html)
          if (restos.length && !items.some((i) => i.type === "restaurant")) {
            items.push({
              id: "resto-summary",
              type: "restaurant",
              name: "Resto approved CIKUR GO",
              count: restos.length,
              status: "AVAILABLE",
              presenceVerified: true
            });
          }
        }
      } catch (err) {
        evidence.restoError = String(err && err.message || err).slice(0, 180);
      }

      items.sort((a, b) => {
        if (a.distanceKm == null && b.distanceKm == null) return 0;
        if (a.distanceKm == null) return 1;
        if (b.distanceKm == null) return -1;
        return a.distanceKm - b.distanceKm;
      });

      const readyAgents = items.filter((i) => i.type === "agent" && i.status === "READY");
      const anyVerified = items.some((i) => i.presenceVerified);

      if (!evidence.sources.length && (evidence.agentError || evidence.restoError)) {
        return {
          ok: false,
          status: "error",
          verified: false,
          source: "cikur-cloud",
          requestId,
          message: "Sensor runtime belum bisa dibaca (izin/koneksi). Tidak mengklaim ketersediaan.",
          items: [],
          count: 0,
          evidence,
          metadata: { customerLocationSource }
        };
      }

      if (anyVerified && (readyAgents.length > 0 || evidence.restoCount > 0)) {
        const parts = [];
        if (readyAgents.length) {
          const nearest = readyAgents[0];
          parts.push(
            nearest.distanceKm != null
              ? readyAgents.length + " Agent READY (terdekat ~" + nearest.distanceKm + " km)"
              : readyAgents.length + " Agent READY online"
          );
        }
        if (evidence.restoCount > 0) {
          parts.push(evidence.restoCount + " resto approved");
        }
        return {
          ok: true,
          status: "available",
          verified: true,
          source: "cikur-cloud",
          requestId,
          message: parts.join("; "),
          items,
          count: items.length,
          data: {
            readyAgentCount: readyAgents.length,
            restoCount: evidence.restoCount || 0,
            nearestAgentKm: readyAgents[0] && readyAgents[0].distanceKm != null ? readyAgents[0].distanceKm : null
          },
          evidence,
          metadata: { customerLocationSource, radiusKm }
        };
      }

      if (items.length && !anyVerified) {
        return {
          ok: true,
          status: "unknown",
          verified: false,
          source: "cikur-cloud",
          requestId,
          message: "Ada sinyal mitra, tetapi belum cukup bukti GPS fresh untuk diklaim tersedia.",
          items,
          count: items.length,
          evidence,
          metadata: { customerLocationSource }
        };
      }

      return {
        ok: true,
        status: "unavailable",
        verified: true,
        source: "cikur-cloud",
        requestId,
        message: "Belum ada Agent online ber-GPS fresh / resto approved yang cocok dengan permintaan saat ini.",
        items: [],
        count: 0,
        evidence,
        metadata: { customerLocationSource, radiusKm }
      };
    }

    window.CGO.connectDiscovery({
      check: function (request) {
        // Sync path: jangan block UI — UNKNOWN + minta async
        return {
          ok: true,
          status: "unknown",
          verified: false,
          source: "bootstrap-sync",
          requestId: request && request.requestId,
          message: "Pemeriksaan live membutuhkan jalur async.",
          items: [],
          count: 0
        };
      },
      checkAsync: function (request) {
        return runCheck(request);
      },
      findNearby: function (request) {
        return runCheck(request);
      }
    });
  }

  function boot() {
    connectNavigation();
    connectDiscovery();
    // Pre-warm GPS (opsional, tidak memaksa)
    try { ensureCustomerLocation(); } catch (_) {}
    const ready = window.CGO && typeof window.CGO.isReady === "function" ? window.CGO.isReady() : false;
    const modules = window.CGO && typeof window.CGO.getModuleStatus === "function" ? window.CGO.getModuleStatus() : {};
    console.info("[CGO Bootstrap] ready=", ready, "modules=", modules, "discovery=live-cloud");
    try {
      try {
        const abcOk = !!(window.CGOAbcCognition?.isReady?.() || window.CGOMachineABC || window.CGOMachineABCBridge);
        if (modules && typeof modules === "object") {
          modules.machineAbc = abcOk;
          modules.abcCognition = !!(window.CGOAbcCognition);
        }
        if (abcOk) console.log("[CGO BOOT] Mesin ABC + kognisi formal siap untuk Chat CGO");
        else console.warn("[CGO BOOT] Mesin ABC tidak terdeteksi (chat tetap normal)");
      } catch (_abc) {}
      window.dispatchEvent(new CustomEvent("cgo-customer-ready", { detail: { ready, modules } }));
    } catch (_) {}
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})(window);
