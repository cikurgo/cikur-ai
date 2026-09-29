/* CIKUR GO Internal AI Knowledge — REAL INTERNAL STORE
 * Deterministic, local-only, evidence/provenance aware.
 * No external AI/API/network.
 */
const VERSION = "1.0.0-INTERNAL";
function clone(v){ return typeof structuredClone === "function" ? structuredClone(v) : JSON.parse(JSON.stringify(v)); }
function clean(v){ return String(v ?? "").trim(); }
function createKnowledgeStore(seed = {}) {
  const s = seed && typeof seed === "object" ? seed : {};
  return {
    version: VERSION,
    nodes: Array.isArray(s.nodes) ? clone(s.nodes) : [],
    relations: Array.isArray(s.relations) ? clone(s.relations) : [],
    updatedAt: s.updatedAt || new Date().toISOString()
  };
}
function validateStore(store){
  if(!store || typeof store !== "object" || !Array.isArray(store.nodes) || !Array.isArray(store.relations)) throw new Error("INVALID_KNOWLEDGE_STORE");
  const ids = new Set();
  for(const n of store.nodes){ if(!n || !clean(n.id)) throw new Error("INVALID_KNOWLEDGE_NODE"); if(ids.has(n.id)) throw new Error("DUPLICATE_KNOWLEDGE_NODE:"+n.id); ids.add(n.id); }
  for(const r of store.relations){ if(!r || !clean(r.from) || !clean(r.to) || !clean(r.type)) throw new Error("INVALID_KNOWLEDGE_RELATION"); }
  return true;
}
function upsertNode(store, node){
  const next = createKnowledgeStore(store);
  if(!node || !clean(node.id)) throw new Error("KNOWLEDGE_NODE_ID_REQUIRED");
  const normalized = {...clone(node), id:clean(node.id), updatedAt:new Date().toISOString()};
  const i = next.nodes.findIndex(n=>n.id===normalized.id);
  if(i >= 0) next.nodes[i] = {...next.nodes[i], ...normalized}; else next.nodes.push(normalized);
  next.updatedAt = normalized.updatedAt;
  validateStore(next); return next;
}
function addRelation(store, from, to, type, meta={}){
  const next = createKnowledgeStore(store);
  const f=clean(from), t=clean(to), k=clean(type);
  if(!f || !t || !k) throw new Error("KNOWLEDGE_RELATION_REQUIRED");
  const relation={from:f,to:t,type:k,...clone(meta),updatedAt:new Date().toISOString()};
  const i=next.relations.findIndex(r=>r.from===f&&r.to===t&&r.type===k);
  if(i>=0) next.relations[i]={...next.relations[i],...relation}; else next.relations.push(relation);
  next.updatedAt=relation.updatedAt; validateStore(next); return next;
}
function query(store, term, options={}){
  const q=clean(term).toLowerCase(); if(!q) return [];
  const limit=Math.max(1, Number(options.limit)||10);
  return store.nodes.filter(n=>JSON.stringify(n).toLowerCase().includes(q)).slice(0,limit).map(clone);
}
function search(store, term, options={}){ return query(store,term,options); }
function getStatus(store){ return {version:VERSION,stub:false,ready:true,nodes:store.nodes.length,relations:store.relations.length}; }
export { VERSION, createKnowledgeStore, validateStore, upsertNode, addRelation, query, search, getStatus };
