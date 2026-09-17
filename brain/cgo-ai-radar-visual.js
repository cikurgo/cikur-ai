/* CIKUR GO Internal Radar Visual State
 * Converts trusted Radar State + Events into UI-safe visual primitives.
 * No external map SDK, no external AI/API, no customer coordinate export.
 */

export const RADAR_VISUAL_VERSION = "1.0.0-INTERNAL-RADAR-VISUAL";

export const RADAR_VISUAL_CONTRACT = Object.freeze({
  version: RADAR_VISUAL_VERSION,
  scope: "INTERNAL_RADAR_VISUAL",
  internalScopes: Object.freeze(["BCGO_ADMIN_RADAR", "CUSTOMER_GEO_SCOPED"]),
  ringsKm: Object.freeze([1, 3, 5, 10]),
  statuses: Object.freeze(["READY", "BUSY", "STALE", "OFFLINE"]),
  eventAnimations: Object.freeze({
    JOIN: "PULSE_IN",
    MOVE: "MOVE",
    STATUS_CHANGE: "STATUS_TRANSITION",
    UPDATE: "HEARTBEAT",
    LEAVE: "FADE_OUT"
  }),
  maxMarkers: 500,
  staleFadeMs: 180000,
  offlineFadeMs: 360000,
  exposesCoordinatesToCustomer: false
});

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clone(value) {
  return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

function markerState(agent) {
  const status = RADAR_VISUAL_CONTRACT.statuses.includes(agent?.status) ? agent.status : "OFFLINE";
  return {
    id: String(agent?.id || ""),
    name: String(agent?.name || agent?.id || "Agent CGO"),
    type: String(agent?.type || "agent"),
    status,
    active: agent?.active === true,
    available: agent?.available !== false,
    presenceVerified: agent?.presenceVerified === true,
    // Coordinates are intentionally present only in the internal BCGO visual state.
    lat: agent?.location?.lat ?? null,
    lng: agent?.location?.lng ?? null,
    accuracy: agent?.accuracy ?? null,
    ageMs: agent?.ageMs ?? null,
    distanceKm: agent?.distanceKm ?? null
  };
}

function eventVisual(event) {
  if (!event) return null;
  const animation = RADAR_VISUAL_CONTRACT.eventAnimations[event.type] || "NONE";
  return {
    eventId: event.id || null,
    agentId: event.agentId || null,
    agentName: event.agentName || null,
    type: event.type || "UPDATE",
    animation,
    at: event.at || null,
    durationMs: animation === "PULSE_IN" ? 1400 : animation === "FADE_OUT" ? 1800 : 700,
    distanceKm: event.distanceKm ?? null,
    from: event.from ?? null,
    to: event.to ?? null
  };
}

export function createRadarVisualEngine(options = {}) {
  const maxMarkers = clamp(Math.floor(num(options.maxMarkers, RADAR_VISUAL_CONTRACT.maxMarkers)), 1, RADAR_VISUAL_CONTRACT.maxMarkers);
  let selectedStatus = "ALL";
  let selectedType = "ALL";
  let radiusKm = 10;
  let center = null;
  let lastState = null;
  let lastEvent = null;

  function setFilters(filters = {}) {
    const status = String(filters.status || "ALL").toUpperCase();
    const rawType = String(filters.type || "ALL");
    const type = rawType.toUpperCase() === "ALL" ? "ALL" : rawType.toLowerCase();
    selectedStatus = status === "ALL" || RADAR_VISUAL_CONTRACT.statuses.includes(status) ? status : "ALL";
    selectedType = type || "ALL";
    radiusKm = clamp(num(filters.radiusKm, radiusKm), 1, 10);
    if (filters.center?.lat != null && filters.center?.lng != null) {
      const lat = num(filters.center.lat, NaN);
      const lng = num(filters.center.lng, NaN);
      center = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
    } else if (filters.center === null) center = null;
    return getState();
  }

  function ingest(state = {}, event = null) {
    lastState = state || {};
    lastEvent = eventVisual(event);
    return getState();
  }

  function getState() {
    const source = lastState || { agents: [], counts: {}, ringsKm: RADAR_VISUAL_CONTRACT.ringsKm };
    const agents = Array.isArray(source.agents) ? source.agents : [];
    const filtered = agents
      .map(markerState)
      .filter(item => item.id)
      .filter(item => selectedStatus === "ALL" || item.status === selectedStatus)
      .filter(item => selectedType === "ALL" || item.type.toLowerCase() === selectedType)
      .filter(item => item.distanceKm == null || item.distanceKm <= radiusKm)
      .slice(0, maxMarkers);

    return {
      contract: clone(RADAR_VISUAL_CONTRACT),
      status: source.status || "UNKNOWN",
      connected: source.connected === true,
      updatedAt: source.updatedAt || null,
      center: center ? { ...center } : null,
      radiusKm,
      ringsKm: [...RADAR_VISUAL_CONTRACT.ringsKm],
      filters: { status: selectedStatus, type: selectedType },
      counts: source.counts || { total: 0, ready: 0, busy: 0, stale: 0, offline: 0 },
      markers: filtered,
      lastEvent: lastEvent ? { ...lastEvent } : null
    };
  }

  function getCustomerSafeState() {
    const state = getState();
    return {
      contract: { ...state.contract, scope: "CUSTOMER_GEO_SCOPED", exposesCoordinatesToCustomer: false },
      status: state.status,
      connected: state.connected,
      radiusKm: state.radiusKm,
      filters: { status: state.filters.status, type: state.filters.type },
      counts: { ...state.counts },
      markers: state.markers.filter(item => item.presenceVerified).map(item => ({
        id: item.id,
        name: item.name,
        type: item.type,
        status: item.status,
        active: item.active,
        available: item.available,
        presenceVerified: true,
        distanceKm: item.distanceKm
      }))
    };
  }

  function clear() {
    lastState = null;
    lastEvent = null;
    return getState();
  }

  return Object.freeze({
    ingest,
    setFilters,
    getState,
    getCustomerSafeState,
    getContract: () => clone(RADAR_VISUAL_CONTRACT),
    clear
  });
}
