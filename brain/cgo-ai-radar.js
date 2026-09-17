/* CIKUR GO Internal Radar Engine
 * GEO-scoped live presence state for BCGO internal monitoring.
 * No external AI/API. No customer-facing coordinate export.
 */

export const RADAR_VERSION = "1.0.0-INTERNAL-GEO-RADAR";

export const RADAR_CONTRACT = Object.freeze({
  version: RADAR_VERSION,
  scope: "BCGO_ADMIN_RADAR",
  ringsKm: Object.freeze([1, 3, 5, 10]),
  maxAgents: 500,
  freshnessMs: 180000,
  staleAfterMs: 180000,
  offlineAfterMs: 360000,
  maxAccuracyM: 1000,
  exposesCoordinatesToCustomer: false,
  customerQueryScope: "CUSTOMER_GEO_SCOPED",
  eventModel: "JOIN_UPDATE_MOVE_STATUS_STALE_OFFLINE_LEAVE"
});

const R = RADAR_CONTRACT;

function isoNow() { return new Date().toISOString(); }

function timestamp(value) {
  if (value == null) return 0;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value?.toMillis === "function") {
    try { return value.toMillis(); } catch {}
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function geo(value) {
  const source = value && typeof value === "object" ? value : {};
  const lat = Number(source.lat ?? source.latitude ?? source.coords?.latitude);
  const lng = Number(source.lng ?? source.longitude ?? source.coords?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  const accuracy = Number(source.accuracy ?? source.coords?.accuracy);
  return {
    lat,
    lng,
    accuracy: Number.isFinite(accuracy) ? accuracy : null
  };
}

function distanceKm(a, b) {
  if (!a || !b) return null;
  const earth = 6371;
  const p1 = a.lat * Math.PI / 180;
  const p2 = b.lat * Math.PI / 180;
  const dp = (b.lat - a.lat) * Math.PI / 180;
  const dl = (b.lng - a.lng) * Math.PI / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return earth * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function clone(value) {
  return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function normalizeAgent(raw, nowMs) {
  const item = raw && typeof raw === "object" ? raw : {};
  const id = String(item.id ?? item.agentId ?? item.uid ?? "").trim();
  if (!id) return null;

  const location = geo(item.location ?? item.coordinates ?? item.position ?? item);
  const updatedAt = item.updatedAt ?? item.lastSeenAt ?? item.timestamp ?? null;
  const updatedMs = timestamp(updatedAt);
  const ageMs = updatedMs ? Math.max(0, nowMs - updatedMs) : Infinity;
  const accuracy = location?.accuracy;
  const geoUsable = Boolean(location) && (accuracy == null || accuracy <= R.maxAccuracyM);
  const active = item.active === true;
  const available = item.available !== false;

  let status = "OFFLINE";
  if (active && geoUsable && ageMs <= R.freshnessMs) {
    status = available ? "READY" : "BUSY";
  } else if (active && ageMs <= R.offlineAfterMs) {
    status = "STALE";
  }

  return {
    id,
    name: String(item.name ?? item.displayName ?? item.agentName ?? id),
    type: String(item.type ?? item.jenis ?? "agent").toLowerCase(),
    active,
    available,
    status,
    location: geoUsable ? location : null,
    updatedAt,
    updatedMs,
    ageMs: Number.isFinite(ageMs) ? ageMs : null,
    accuracy: accuracy ?? null,
    presenceVerified: status === "READY" || status === "BUSY"
  };
}

function eventFor(previous, current) {
  if (!previous && current) return { type: "JOIN", reason: "NEW_AGENT" };
  if (previous && !current) return { type: "LEAVE", reason: "REMOVED_FROM_FEED" };
  if (!previous || !current) return null;
  if (previous.status !== current.status) return { type: "STATUS_CHANGE", from: previous.status, to: current.status };
  if (previous.updatedAt !== current.updatedAt) {
    if (previous.location && current.location) {
      const movedKm = distanceKm(previous.location, current.location);
      if (movedKm != null && movedKm >= 0.025) return { type: "MOVE", distanceKm: Number(movedKm.toFixed(3)) };
    }
    return { type: "UPDATE", reason: "HEARTBEAT" };
  }
  if (previous.location && current.location) {
    const movedKm = distanceKm(previous.location, current.location);
    if (movedKm != null && movedKm >= 0.025) return { type: "MOVE", distanceKm: Number(movedKm.toFixed(3)) };
  }
  return null;
}

function summarize(items) {
  const counts = { total: items.length, ready: 0, busy: 0, stale: 0, offline: 0 };
  for (const item of items) {
    if (item.status === "READY") counts.ready += 1;
    else if (item.status === "BUSY") counts.busy += 1;
    else if (item.status === "STALE") counts.stale += 1;
    else counts.offline += 1;
  }
  return counts;
}

export function createRadarEngine(options = {}) {
  const maxAgents = Math.max(1, Math.min(R.maxAgents, Number(options.maxAgents) || R.maxAgents));
  let agents = new Map();
  let events = [];
  let lastUpdatedAt = null;
  let sequence = 0;
  const subscribers = new Set();

  function emit(agent, event) {
    if (!event) return;
    sequence += 1;
    events.unshift({
      id: `RADAR-${Date.now()}-${sequence}`,
      at: isoNow(),
      agentId: agent?.id ?? null,
      agentName: agent?.name ?? null,
      ...event
    });
    if (events.length > 100) events.length = 100;
    const payload = clone(events[0]);
    for (const subscriber of subscribers) {
      try { subscriber(payload); } catch {}
    }
  }

  function ingest(input = [], meta = {}) {
    const nowMs = Date.now();
    const list = Array.isArray(input) ? input : [];
    const next = new Map();
    for (const raw of list) {
      const item = normalizeAgent(raw, nowMs);
      if (!item || next.has(item.id)) continue;
      next.set(item.id, item);
      if (next.size >= maxAgents) break;
    }

    for (const [id, previous] of agents) {
      const current = next.get(id) || null;
      emit(current || previous, eventFor(previous, current));
    }
    for (const [id, current] of next) {
      if (!agents.has(id)) emit(current, eventFor(null, current));
    }

    agents = next;
    lastUpdatedAt = meta.updatedAt || isoNow();
    return getSnapshot();
  }

  function refresh() {
    return ingest([...agents.values()], { updatedAt: isoNow(), reason: "AGE_REFRESH" });
  }

  function queryNearby(location, radiusKm = 10, types = []) {
    const origin = geo(location);
    if (!origin) return { ok: false, status: "unknown", verified: false, items: [], count: 0, reason: "CUSTOMER_LOCATION_REQUIRED" };
    const radius = Math.min(R.ringsKm[R.ringsKm.length - 1], Math.max(0, Number(radiusKm) || 0));
    const wanted = Array.isArray(types) ? types.map(v => String(v).toLowerCase()) : [];
    const items = [];
    for (const item of agents.values()) {
      if (!item.location || !item.presenceVerified || item.active !== true) continue;
      if (wanted.length && !wanted.includes(item.type)) continue;
      const d = distanceKm(origin, item.location);
      if (d == null || d > radius) continue;
      items.push({
        id: item.id,
        name: item.name,
        type: item.type,
        status: item.status,
        distanceKm: Number(d.toFixed(3)),
        presenceVerified: true,
        updatedAt: item.updatedAt
      });
    }
    items.sort((a, b) => a.distanceKm - b.distanceKm);
    return { ok: true, status: items.length ? "available" : "unavailable", verified: true, items, count: items.length };
  }

  function getSnapshot() {
    const nowMs = Date.now();
    const current = [...agents.values()].map(item => {
      const ageMs = item.updatedMs ? Math.max(0, nowMs - item.updatedMs) : null;
      let status = item.status;
      if (item.active && ageMs != null && ageMs > R.offlineAfterMs) status = "OFFLINE";
      else if (item.active && ageMs != null && ageMs > R.freshnessMs) status = "STALE";
      return { ...item, status, ageMs };
    }).sort((a, b) => a.id.localeCompare(b.id));
    const counts = summarize(current);
    return {
      contract: clone(R),
      connected: true,
      status: "LIVE",
      updatedAt: lastUpdatedAt,
      counts,
      ringsKm: [...R.ringsKm],
      agents: clone(current),
      events: clone(events.slice(0, 24))
    };
  }

  function getCustomerSafeSnapshot() {
    const snapshot = getSnapshot();
    return {
      contract: { ...clone(R), scope: R.customerQueryScope, exposesCoordinatesToCustomer: false },
      counts: snapshot.counts,
      agents: snapshot.agents.filter(item => item.presenceVerified).map(item => ({
        id: item.id,
        name: item.name,
        type: item.type,
        status: item.status,
        active: item.active,
        available: item.available,
        updatedAt: item.updatedAt,
        presenceVerified: true
      }))
    };
  }

  function subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    subscribers.add(listener);
    return () => subscribers.delete(listener);
  }

  function getRecentEvents(limit = 24) {
    const safeLimit = Math.max(0, Math.min(100, Number(limit) || 0));
    return clone(events.slice(0, safeLimit));
  }

  function clear() {
    agents = new Map();
    events = [];
    lastUpdatedAt = null;
    return getSnapshot();
  }

  return Object.freeze({
    ingest,
    refresh,
    queryNearby,
    getSnapshot,
    getCustomerSafeSnapshot,
    getContract: () => clone(R),
    getRecentEvents,
    subscribe,
    clear
  });
}
