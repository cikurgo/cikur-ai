/* CIKUR GO — BCGO ↔ CGO AUTHORITATIVE BRIDGE V1
 * One internal transport for the BCGO-CGO boundary.
 * Same-tab: CustomEvent. Cross-tab: BroadcastChannel + localStorage recovery.
 * No external API, no AI provider, no source mutation.
 */
export const VERSION = "V1.1.0-BCGO-CGO-AUTHORITATIVE-BRIDGE";
export const CHANNEL = "CIKUR_GO_BCGO_CGO_BRIDGE_V1";
export const STATE_EVENT = "cikur-bcgo-state";
export const COMMAND_EVENT = "cikur-cgo-command";
export const RESPONSE_EVENT = "cikur-cgo-response";

const STATE_KEY = `${CHANNEL}_STATE`;
const EVENT_KEY = `${CHANNEL}_EVENT`;
const COMMAND_KEY = `${CHANNEL}_COMMAND`;
const MAX_SEEN = 800;
const seen = new Set();
let channel = null;
let installed = false;
let latestState = null;
let latestCommand = null;
const stateListeners = new Set();
const commandListeners = new Set();
const directiveListeners = new Set();
const responseListeners = new Set();

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
  // Recovery is deliberately read-only: it restores the latest transport state.
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
    for (const fn of responseListeners) { try { fn(clone(packet)); } catch {} }
    emit(RESPONSE_EVENT, packet);
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

function publishResponse(response, meta = {}) {
  const packet = { id:id("RESPONSE"), bridge:CHANNEL, from:"CGO", type:"CGO_RESPONSE", at:Date.now(), ...meta, response:clone(response) };
  route(packet);
  try { ensureChannel()?.postMessage(packet); } catch {}
  try { localStorage.setItem(EVENT_KEY, JSON.stringify(packet)); } catch {}
  return clone(packet);
}

const api = Object.freeze({
  version: VERSION,
  channel: CHANNEL,
  install,
  publishState,
  publishHumanCommand,
  publishDirective,
  publishResponse,
  getState: () => clone(latestState),
  getLatestCommand: () => clone(latestCommand),
  onState(fn) { if (typeof fn !== "function") return () => {}; stateListeners.add(fn); return () => stateListeners.delete(fn); },
  onCommand(fn) { if (typeof fn !== "function") return () => {}; commandListeners.add(fn); return () => commandListeners.delete(fn); },
  onDirective(fn) { if (typeof fn !== "function") return () => {}; directiveListeners.add(fn); return () => directiveListeners.delete(fn); },
  onResponse(fn) { if (typeof fn !== "function") return () => {}; responseListeners.add(fn); return () => responseListeners.delete(fn); },
  destroy() { try { channel?.close(); } catch {} channel = null; installed = false; stateListeners.clear(); commandListeners.clear(); directiveListeners.clear(); responseListeners.clear(); }
});

if (typeof window !== "undefined") {
  window.CIKUR_BCGO_CGO_BRIDGE = api;
}
