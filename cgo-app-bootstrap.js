/* CIKUR GO APPLICATION BOOTSTRAP
 * Application wiring only: Customer CGO ↔ internal BCGO presence/radar.
 * No external AI/API. No fabricated presence. UNKNOWN is preserved when
 * live internal presence cannot be verified.
 */
import { createRadarEngine } from "./brain/cgo-ai-radar.js";
import { install as installBrowserBridge } from "./brain/cgo-ai-browser-adapter.js";

const VERSION = "1.4.0-APPLICATION-BRAIN-PRIMARY-RADAR";
const PRESENCE_MAX_AGE_MS = 180000;
const radarEngine = createRadarEngine({ maxAgents: 100 });
let bridge = null;
let radarPanel = null;

function clone(value) {
  try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
}

function normalizeLocation(location) {
  if (!location || typeof location !== "object") return null;
  const lat = Number(location.lat ?? location.latitude);
  const lng = Number(location.lng ?? location.lon ?? location.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function livePresence() {
  const state = window.BCGO_STATE;
  const presence = state?.agentPresence;
  if (!presence || presence.connected !== true || presence.status !== "LIVE" || !Array.isArray(presence.items)) return null;

  const serverMs = Number(presence.lastServerAt);
  if (!Number.isFinite(serverMs) || serverMs <= 0) return null;
  if (Date.now() - serverMs > PRESENCE_MAX_AGE_MS) return null;

  // BCGO already removes stale source records. Keep the gateway conservative:
  // every item must still carry a valid source timestamp within the same window.
  const freshItems = presence.items.filter(item => {
    const raw = item?.updatedAt;
    const ms = typeof raw === "number" ? raw : Date.parse(String(raw || ""));
    return Number.isFinite(ms) && ms > 0 && Date.now() - ms <= PRESENCE_MAX_AGE_MS;
  });
  if (freshItems.length !== presence.items.length) return null;
  return { ...presence, items: freshItems };
}

function customerDiscoveryAdapter() {
  return {
    version: VERSION,
    async findNearby(request = {}) {
      const origin = normalizeLocation(request.location);
      if (!origin) return { ok:false, status:"unknown", verified:false, items:[], count:0, reason:"CUSTOMER_LOCATION_REQUIRED" };
      const presence = livePresence();
      if (!presence) return { ok:false, status:"unknown", verified:false, items:[], count:0, reason:"BCGO_AGENT_PRESENCE_UNAVAILABLE" };

      const updatedAt = presence.lastServerAt || presence.updatedAt || new Date().toISOString();
      radarEngine.ingest(presence.items, { updatedAt: new Date(updatedAt).toISOString(), reason:"BCGO_LIVE_STATE" });
      const result = radarEngine.queryNearby(origin, request.radiusKm ?? 10, request.types ?? []);
      return {
        ...result,
        source: "BCGO_STATE.agentPresence",
        observedAt: new Date().toISOString(),
        live: true,
        verified: result.status === "available" || result.status === "busy"
      };
    },
    async check(request = {}) { return this.findNearby(request); },
    async checkAsync(request = {}) { return this.findNearby(request); }
  };
}

function ensureRadarPanel() {
  if (radarPanel || !document?.body) return radarPanel;
  radarPanel = document.createElement("section");
  radarPanel.id = "cgoLiveRadarPanel";
  radarPanel.setAttribute("aria-live", "polite");
  radarPanel.style.cssText = "position:fixed;left:12px;right:12px;bottom:82px;z-index:9998;display:none;background:#fff;border:1px solid #e2e8f0;border-radius:16px;box-shadow:0 10px 30px rgba(15,23,42,.12);padding:12px;font:12px/1.4 system-ui,sans-serif;color:#0f172a";
  radarPanel.innerHTML = '<div style="font-weight:700">CGO Live Radar</div><div id="cgoLiveRadarStatus" style="margin-top:4px;color:#64748b">Menunggu pemeriksaan…</div><div id="cgoLiveRadarMeta" style="margin-top:6px;font-size:11px;color:#94a3b8"></div>';
  document.body.appendChild(radarPanel);
  return radarPanel;
}

function updateRadarPanel(mode, payload = {}) {
  const panel = ensureRadarPanel();
  if (!panel) return;
  const status = panel.querySelector("#cgoLiveRadarStatus");
  const meta = panel.querySelector("#cgoLiveRadarMeta");
  panel.style.display = mode === "hide" ? "none" : "block";

  if (mode === "checking") {
    status.textContent = "Sedang mendeteksi Agent CGO dari data runtime…";
    meta.textContent = "Radar aktif • menunggu hasil observasi nyata";
  } else if (mode === "result") {
    const result = payload || {};
    const count = Number(result.count || 0);
    status.textContent = result.verified ? `Terdeteksi ${count} Agent CGO pada data live.` : "Belum dapat memastikan Agent CGO secara live.";
    meta.textContent = result.verified ? `Status: ${String(result.status || "available").toUpperCase()} • sumber: ${result.source || "BCGO"}` : `Status: UNKNOWN • alasan: ${result.reason || "data belum terverifikasi"}`;
  } else if (mode === "error") {
    status.textContent = "Radar tidak dapat memastikan kondisi saat ini.";
    meta.textContent = `UNKNOWN • ${String(payload?.message || "runtime tidak tersedia")}`;
  }
}

const BCGO_STATE_KEY = "CIKUR_GO_BCGO_STATE_V1";
let bcgoChannel = null;

function acceptBCGOState(state) {
  if (!state || typeof state !== "object") return false;
  try {
    window.BCGO_STATE = clone(state);
    bridge?.ingestBCGOState?.(window.BCGO_STATE);
    return true;
  } catch {
    return false;
  }
}

function connectBCGOStateFeed() {
  try {
    const raw = localStorage.getItem(BCGO_STATE_KEY);
    if (raw) acceptBCGOState(JSON.parse(raw));
  } catch {}

  try {
    bcgoChannel = new BroadcastChannel(BCGO_STATE_KEY);
    bcgoChannel.addEventListener("message", event => acceptBCGOState(event?.data));
  } catch {}

  window.addEventListener("storage", event => {
    if (event.key !== BCGO_STATE_KEY || !event.newValue) return;
    try { acceptBCGOState(JSON.parse(event.newValue)); } catch {}
  });
}

async function boot() {
  if (!document.body) {
    await new Promise(resolve => document.addEventListener("DOMContentLoaded", resolve, { once: true }));
  }
  ensureRadarPanel();
  bridge = installBrowserBridge();
  // The Brain owns the radar capability. Bootstrap only supplies the live
  // internal BCGO evidence resolver; no external AI/API is introduced.
  bridge.setPresenceQueryResolver?.((request = {}) => customerDiscoveryAdapter().findNearby(request));
  bridge.setCustomerLocationResolver?.(() => null);

  // Customer gateway is loaded before this ES module. Explicitly connect
  // the real internal brain now; otherwise the gateway remains on its
  // Customer-only fallback path even though the brain exists.
  if (window.CGO?.connectBrain) {
    window.CGO.connectBrain(bridge);
  }
  window.dispatchEvent(new CustomEvent("cgo-brain-ready", { detail: { version: bridge.version } }));

  connectBCGOStateFeed();
  if (window.BCGO_STATE) bridge.ingestBCGOState?.(window.BCGO_STATE);

  if (window.CGO?.connectRuntime) {
    window.CGO.connectRuntime(customerDiscoveryAdapter());
  }

  // Discovery menggunakan event bus internal Customer, bukan event palsu dari UI.
  const discovery = window.CGO_CUSTOMER?.discovery;
  if (discovery?.on) {
    discovery.on("discovery:started", payload => updateRadarPanel("checking", payload));
    discovery.on("discovery:completed", payload => updateRadarPanel("result", payload));
  }

  window.CGO_INTERNAL_BRAIN_BRIDGE = bridge;
  window.CGO_APPLICATION_READY = Object.freeze({ version: VERSION, ready:true, radar:true, externalAI:false });
  window.dispatchEvent(new CustomEvent("cgo-application-ready", { detail: clone(window.CGO_APPLICATION_READY) }));
  return bridge;
}

boot().catch(error => {
  window.CGO_APPLICATION_READY = Object.freeze({ version:VERSION, ready:false, radar:false, externalAI:false, error:String(error?.message || error) });
  window.dispatchEvent(new CustomEvent("cgo-application-error", { detail:clone(window.CGO_APPLICATION_READY) }));
});
