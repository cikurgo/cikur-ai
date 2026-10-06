/* CIKUR GO Internal Memory — v1.1.0-OTAK-WIRE
 * Store ringkas untuk bukti/percakapan internal. Zero network.
 * Dual: ESM export + global CGOAiMemory (untuk hub non-module).
 */
const VERSION = "1.1.0-OTAK-WIRE";
const MAX_ITEMS = 80;

function clone(v) {
  try {
    return typeof structuredClone === "function" ? structuredClone(v) : JSON.parse(JSON.stringify(v));
  } catch (_) {
    return v;
  }
}

function createMemory(seed = {}) {
  const items = Array.isArray(seed?.items) ? seed.items.slice(-MAX_ITEMS) : [];
  return { version: VERSION, items: clone(items), updatedAt: seed?.updatedAt || new Date().toISOString() };
}

function remember(memory, record) {
  if (!memory || typeof memory !== "object") memory = createMemory();
  const item = {
    id: record?.id || ("m-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7)),
    at: record?.at || new Date().toISOString(),
    kind: record?.kind || "note",
    text: String(record?.text || record?.q || record?.question || ""),
    answer: record?.answer != null ? String(record.answer) : null,
    tags: Array.isArray(record?.tags) ? record.tags : [],
    meta: record?.meta || null
  };
  if (!item.text && !item.answer) return memory;
  memory.items = (memory.items || []).concat([item]).slice(-MAX_ITEMS);
  memory.updatedAt = new Date().toISOString();
  return memory;
}

function tokenize(s) {
  return String(s || "").toLowerCase().split(/[^a-z0-9\u00c0-\u024f\u3040-\u30ff\u4e00-\u9fff]+/i).filter(function (w) { return w.length > 2; });
}

function recall(memory, query = null, limit = 10) {
  const items = Array.isArray(memory?.items) ? memory.items : [];
  if (!query) return items.slice(-Math.max(1, limit));
  const q = tokenize(query);
  if (!q.length) return items.slice(-Math.max(1, limit));
  const scored = items.map(function (it) {
    const blob = tokenize((it.text || "") + " " + (it.answer || "") + " " + (it.tags || []).join(" "));
    let score = 0;
    for (const w of q) if (blob.indexOf(w) >= 0) score += 1;
    return { it: it, score: score };
  }).filter(function (x) { return x.score > 0; });
  scored.sort(function (a, b) { return b.score - a.score; });
  return scored.slice(0, Math.max(1, limit)).map(function (x) { return x.it; });
}

function clear() { return createMemory(); }

function getStatus(memory) {
  return {
    version: VERSION,
    stub: false,
    ready: true,
    count: Array.isArray(memory?.items) ? memory.items.length : 0,
    maxItems: MAX_ITEMS
  };
}

const API = { VERSION, MAX_ITEMS, createMemory, remember, recall, clear, getStatus };

try {
  if (typeof globalThis !== "undefined") globalThis.CGOAiMemory = API;
} catch (_) {}

export { VERSION, MAX_ITEMS, createMemory, remember, recall, clear, getStatus };
