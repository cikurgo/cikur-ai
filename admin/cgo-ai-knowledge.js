/* CIKUR GO Internal Knowledge — v1.1.0-OTAK-WIRE
 * Graph pengetahuan lokal ringan. Zero network.
 */
const VERSION = "1.1.0-OTAK-WIRE";

function clone(v) {
  try {
    return typeof structuredClone === "function" ? structuredClone(v) : JSON.parse(JSON.stringify(v));
  } catch (_) {
    return v;
  }
}
function clean(v) { return String(v ?? "").trim(); }

function createKnowledgeStore(seed = {}) {
  return {
    version: VERSION,
    nodes: Array.isArray(seed.nodes) ? clone(seed.nodes) : [],
    relations: Array.isArray(seed.relations) ? clone(seed.relations) : (Array.isArray(seed.edges) ? clone(seed.edges) : []),
    updatedAt: seed.updatedAt || new Date().toISOString()
  };
}

function validateStore(store) {
  if (!store || typeof store !== "object") return { ok: false, issues: ["NO_STORE"] };
  const issues = [];
  if (!Array.isArray(store.nodes)) issues.push("NODES_NOT_ARRAY");
  if (!Array.isArray(store.relations) && !Array.isArray(store.edges)) issues.push("RELATIONS_NOT_ARRAY");
  return { ok: issues.length === 0, issues: issues };
}

function upsertNode(store, node) {
  if (!store) store = createKnowledgeStore();
  const id = clean(node?.id || node?.name);
  if (!id) return store;
  const idx = store.nodes.findIndex(function (n) { return n.id === id || n.name === id; });
  const row = Object.assign({}, node, { id: id, name: clean(node?.name || id), updatedAt: new Date().toISOString() });
  if (idx >= 0) store.nodes[idx] = Object.assign({}, store.nodes[idx], row);
  else store.nodes.push(row);
  store.updatedAt = new Date().toISOString();
  return store;
}

function addRelation(store, from, to, type, meta = {}) {
  if (!store) store = createKnowledgeStore();
  store.relations.push({
    from: clean(from), to: clean(to), type: clean(type || "RELATED"),
    meta: meta || {}, at: new Date().toISOString()
  });
  store.updatedAt = new Date().toISOString();
  return store;
}

function query(store, term, options = {}) {
  const q = clean(term).toLowerCase();
  const limit = Math.max(1, Number(options.limit) || 12);
  if (!store || !q) return { nodes: [], relations: [] };
  const nodes = (store.nodes || []).filter(function (n) {
    const blob = (n.id + " " + (n.name || "") + " " + (n.label || "") + " " + (n.kind || "")).toLowerCase();
    return blob.indexOf(q) >= 0;
  }).slice(0, limit);
  const ids = new Set(nodes.map(function (n) { return n.id; }));
  const relations = (store.relations || store.edges || []).filter(function (r) {
    return ids.has(r.from) || ids.has(r.to) || String(r.type || "").toLowerCase().indexOf(q) >= 0;
  }).slice(0, limit);
  return { nodes: nodes, relations: relations };
}

function search(store, term, options = {}) { return query(store, term, options); }

function getStatus(store) {
  return {
    version: VERSION,
    stub: false,
    ready: true,
    nodes: store && Array.isArray(store.nodes) ? store.nodes.length : 0,
    relations: store && (store.relations || store.edges) ? (store.relations || store.edges).length : 0
  };
}

const API = { VERSION, createKnowledgeStore, validateStore, upsertNode, addRelation, query, search, getStatus };
try { if (typeof globalThis !== "undefined") globalThis.CGOAiKnowledge = API; } catch (_) {}
export { VERSION, createKnowledgeStore, validateStore, upsertNode, addRelation, query, search, getStatus };
