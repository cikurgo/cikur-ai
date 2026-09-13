/* CIKUR GO — BCGO ↔ CGO AUTHORITATIVE BRIDGE V1
 * One internal transport for the BCGO-CGO boundary.
 * Same-tab: CustomEvent. Cross-tab: BroadcastChannel + localStorage recovery.
 * No external API, no AI provider, no source mutation.
 */
export const VERSION = "V1.0.0-BCGO-CGO-AUTHORITATIVE-BRIDGE";
export const CHANNEL = "CIKUR_GO_BCGO_CGO_BRIDGE_V1";
export const STATE_EVENT = "cikur-bcgo-state";
export const COMMAND_EVENT = "cikur-cgo-command";
export const RESPONSE_EVENT = "cikur-cgo-response";
export const TEAM_REPORT_EVENT = "cikur-cgo-team-report";

const STATE_KEY = `${CHANNEL}_STATE`;
const EVENT_KEY = `${CHANNEL}_EVENT`;
const COMMAND_KEY = `${CHANNEL}_COMMAND`;
const TEAM_KEY = `${CHANNEL}_TEAM_LOG`;
const MAX_SEEN = 800;
const seen = new Set();
let channel = null;
let installed = false;
let latestState = null;
let latestCommand = null;
const stateListeners = new Set();
const commandListeners = new Set();
const directiveListeners = new Set();
const teamReportListeners = new Set();

function clone(value) {
  try { return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value)); }
  catch { return value; }
}
function id(prefix, packet = {}) {
  return String(packet.id || `${prefix}:${packet.at || Date.now()}:${packet.cycle ?? ""}:${packet.caseId || ""}:${Math.random().toString(36).slice(2,8)}`);
}
function remember(packetId) {
  if (!packetId || seen.has(packetId)) return false;
  seen.add(packetId);
  if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value);
  return true;
}
function emit(name, detail) {
  try { window.dispatchEvent(new CustomEvent(name, { detail: clone(detail) })); } catch {}
}
function ensureChannel() {
  if (channel || typeof BroadcastChannel === "undefined") return channel;
  try { channel = new BroadcastChannel(CHANNEL); } catch { channel = null; }
  return channel;
}

export function install() {
  if (installed) return api;
  installed = true;
  ensureChannel();
  channel?.addEventListener("message", event => route(event.data));
  if (typeof window !== "undefined") {
    window.addEventListener("storage", event => {
      if (!event.newValue) return;
      if (event.key === STATE_KEY || event.key === EVENT_KEY || event.key === COMMAND_KEY) {
        try { route(JSON.parse(event.newValue)); } catch {}
      }
    });
  }
  // Recovery is deliberately read-only: restore the latest state plus a bounded
  // durable team history so Medicine/Executor can join after BCGO is already live.
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (raw) route(JSON.parse(raw), true);
  } catch {}
  return api;
}

function route(packet, recovery = false) {
  if (!packet || packet.bridge !== CHANNEL) return false;
  if (!remember(String(packet.id || "")) && !recovery) return false;
  if (packet.type === "BCGO_STATE") {
    latestState = clone(packet.state || packet.payload || {});
    for (const fn of stateListeners) { try { fn(clone(latestState), packet); } catch {} }
    emit(STATE_EVENT, latestState);
    return true;
  }
  if (packet.type === "CGO_HUMAN_COMMAND") {
    latestCommand = clone(packet);
    for (const fn of commandListeners) { try { fn(clone(packet)); } catch {} }
    emit(COMMAND_EVENT, packet);
    return true;
  }
  if (packet.type === "CGO_BCGO_DIRECTIVE") {
    for (const fn of directiveListeners) { try { fn(clone(packet)); } catch {} }
    return true;
  }
  if (packet.type === "CGO_RESPONSE") {
    emit(RESPONSE_EVENT, packet);
    return true;
  }
  if (packet.from === "MEDICINE" || packet.from === "EXECUTION") {
    for (const fn of teamReportListeners) { try { fn(clone(packet)); } catch {} }
    emit(TEAM_REPORT_EVENT, packet);
    return true;
  }
  return false;
}

function publishState(state, meta = {}) {
  const packet = { id:id("STATE"), bridge:CHANNEL, from:"BCGO", type:"BCGO_STATE", at:Date.now(), state:clone(state), ...meta };
  latestState = clone(packet.state);
  route(packet);
  try { ensureChannel()?.postMessage(packet); } catch {}
  try { localStorage.setItem(STATE_KEY, JSON.stringify(packet)); } catch {}
  try { localStorage.setItem(EVENT_KEY, JSON.stringify(packet)); } catch {}
  return clone(packet);
}

function publishDirective(type, payload = {}) {
  const packet = { id:id("DIRECTIVE"), bridge:CHANNEL, from:"CAPTAIN", type:"CGO_BCGO_DIRECTIVE", directiveType:String(type || ""), at:Date.now(), ...payload };
  if (!packet.directiveType) return null;
  route(packet);
  try { ensureChannel()?.postMessage(packet); } catch {}
  try { localStorage.setItem(EVENT_KEY, JSON.stringify(packet)); } catch {}
  return clone(packet);
}

function publishHumanCommand(text, meta = {}) {
  const packet = { id:id("COMMAND"), bridge:CHANNEL, from:"HUMAN", type:"CGO_HUMAN_COMMAND", at:Date.now(), text:String(text || "").trim(), ...meta };
  if (!packet.text) return null;
  latestCommand = clone(packet);
  route(packet);
  try { ensureChannel()?.postMessage(packet); } catch {}
  try { localStorage.setItem(COMMAND_KEY, JSON.stringify(packet)); } catch {}
  return clone(packet);
}


function publishTeamReport(type, payload = {}) {
  const packet = { id:id("TEAM"), bridge:CHANNEL, from:String(payload.from || "INTERNAL"), type:String(type || "TEAM_REPORT"), at:Date.now(), ...clone(payload) };
  route(packet);
  try {
    const raw = localStorage.getItem(TEAM_KEY);
    const history = raw ? JSON.parse(raw) : [];
    const next = Array.isArray(history) ? history.filter(x => String(x?.id || "") !== String(packet.id)) : [];
    next.push(packet);
    localStorage.setItem(TEAM_KEY, JSON.stringify(next.slice(-120)));
    localStorage.setItem(EVENT_KEY, JSON.stringify(packet));
  } catch {}
  try { ensureChannel()?.postMessage(packet); } catch {}
  return clone(packet);
}

function publishResponse(response, meta = {}) {
  const packet = { id:id("RESPONSE"), bridge:CHANNEL, from:"CGO", type:"CGO_RESPONSE", at:Date.now(), ...meta, response:clone(response) };
  route(packet);
  try { ensureChannel()?.postMessage(packet); } catch {}
  return clone(packet);
}

const api = Object.freeze({
  version: VERSION,
  channel: CHANNEL,
  install,
  publishState,
  publishHumanCommand,
  publishDirective,
  publishTeamReport,
  publishResponse,
  getState: () => clone(latestState),
  getLatestCommand: () => clone(latestCommand),
  onState(fn) {
    if (typeof fn !== "function") return () => {};
    stateListeners.add(fn);
    if (latestState) {
      const replay = () => { try { fn(clone(latestState), { bridge:CHANNEL, type:"BCGO_STATE", recovery:true }); } catch {} };
      try { if (typeof queueMicrotask === "function") queueMicrotask(replay); else Promise.resolve().then(replay); } catch { replay(); }
    }
    return () => stateListeners.delete(fn);
  },
  onCommand(fn) { if (typeof fn !== "function") return () => {}; commandListeners.add(fn); return () => commandListeners.delete(fn); },
  onDirective(fn) { if (typeof fn !== "function") return () => {}; directiveListeners.add(fn); return () => directiveListeners.delete(fn); },
  onTeamReport(fn) {
    if (typeof fn !== "function") return () => {};
    teamReportListeners.add(fn);
    const replay = () => {
      try {
        const raw = localStorage.getItem(TEAM_KEY);
        const history = raw ? JSON.parse(raw) : [];
        const cutoff = Date.now() - 15 * 60 * 1000;
        if (Array.isArray(history)) for (const packet of history.slice(-120)) {
          if (Number(packet?.at || 0) >= cutoff) route(packet, true);
        }
      } catch {}
    };
    try { if (typeof queueMicrotask === "function") queueMicrotask(replay); else Promise.resolve().then(replay); } catch { replay(); }
    return () => teamReportListeners.delete(fn);
  },
  destroy() { try { channel?.close(); } catch {} channel = null; installed = false; stateListeners.clear(); commandListeners.clear(); directiveListeners.clear(); teamReportListeners.clear(); }
});

if (typeof window !== "undefined") {
  window.CIKUR_BCGO_CGO_BRIDGE = api;
}
