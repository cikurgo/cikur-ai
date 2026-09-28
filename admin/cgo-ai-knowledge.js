/* CGO AI Knowledge Store — minimal compatible store for browser adapter */
const VERSION = "1.0.0-KNOWLEDGE-STUB";

export function createKnowledgeStore() {
  return { version: VERSION, nodes: [], relations: [], updatedAt: Date.now() };
}

export function upsertNode(store, node = {}) {
  const next = {
    version: store?.version || VERSION,
    nodes: Array.isArray(store?.nodes) ? store.nodes.slice() : [],
    relations: Array.isArray(store?.relations) ? store.relations.slice() : [],
    updatedAt: Date.now()
  };
  if (!node || !node.id) return next;
  const i = next.nodes.findIndex(n => n.id === node.id);
  if (i >= 0) next.nodes[i] = { ...next.nodes[i], ...node };
  else next.nodes.push({ ...node });
  return next;
}

export function addRelation(store, from, to, type = "RELATED", meta = {}) {
  const next = {
    version: store?.version || VERSION,
    nodes: Array.isArray(store?.nodes) ? store.nodes.slice() : [],
    relations: Array.isArray(store?.relations) ? store.relations.slice() : [],
    updatedAt: Date.now()
  };
  const id = `${from}->${to}:${type}`;
  if (!next.relations.some(r => r.id === id)) {
    next.relations.push({
      id, from, to, type,
      status: meta.status || "OBSERVED",
      source: meta.source || null,
      at: Date.now()
    });
  }
  return next;
}

export { VERSION };
