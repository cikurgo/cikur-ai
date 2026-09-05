/* CIKUR GO Internal AI Knowledge / System Graph */
const VERSION="1.2.0";
const now=()=>new Date().toISOString();

export function createKnowledgeStore(seed={}) {
  const store={version:VERSION,nodes:Array.isArray(seed.nodes)?structuredClone(seed.nodes):[],edges:Array.isArray(seed.edges)?structuredClone(seed.edges):[]};
  validateStore(store); return store;
}
function nodeKey(n){ return `${n.type||"node"}:${n.name||n.id||"unknown"}`; }
function immutableNodeFields(n){ return [n.type||null,n.name||null,n.source||null,n.fingerprint||null,n.version||null]; }
function immutableEdgeFields(e){ return [e.from,e.to,e.type,e.fingerprint||null]; }
export function validateStore(store={}){
  if(!Array.isArray(store.nodes)||!Array.isArray(store.edges)) throw new Error("INVALID_KNOWLEDGE_STORE");
  const ids=new Set();
  for(const n of store.nodes){
    if(!n?.id||typeof n.id!=="string") throw new Error("INVALID_KNOWLEDGE_NODE");
    if(ids.has(n.id)) throw new Error(`KNOWLEDGE_NODE_COLLISION:${n.id}`);
    ids.add(n.id);
    if(n.status && !["OBSERVED","VERIFIED","CONFLICTED","RETIRED"].includes(n.status)) throw new Error("INVALID_KNOWLEDGE_NODE_STATUS");
    if(n.provenance && typeof n.provenance!=="object") throw new Error("INVALID_KNOWLEDGE_NODE_PROVENANCE");
  }
  const edgeIds=new Set(); const pairTypes=new Set();
  for(const e of store.edges){
    if(!e?.id||!e.from||!e.to||!e.type) throw new Error("INVALID_KNOWLEDGE_EDGE");
    if(edgeIds.has(e.id)) throw new Error(`KNOWLEDGE_EDGE_COLLISION:${e.id}`);
    if(!ids.has(e.from)||!ids.has(e.to)) throw new Error(`KNOWLEDGE_DANGLING_EDGE:${e.id}`);
    const key=`${e.from}|${e.to}|${e.type}`;
    if(pairTypes.has(key)) throw new Error(`KNOWLEDGE_RELATION_COLLISION:${key}`);
    pairTypes.add(key); edgeIds.add(e.id);
    if(e.status && !["OBSERVED","VERIFIED","CONFLICTED","RETIRED"].includes(e.status)) throw new Error("INVALID_KNOWLEDGE_EDGE_STATUS");
  }
  return true;
}
export function upsertNode(store,node) {
  const s=structuredClone(store);
  if(!node||typeof node!=="object"||Array.isArray(node)) throw new Error("KNOWLEDGE_NODE_REQUIRED");
  const nodeId=node.id||nodeKey(node);
  const prior=s.nodes.find(x=>x.id===nodeId);
  // FIX: a partial upsert (e.g. only updating metadata) must not silently wipe an
  // already-verified status or overwrite real provenance (audit trail: who/what/when
  // observed this node) with a fabricated "just observed now" record. Only fall back
  // to defaults when there is no prior node and the caller supplied nothing.
  const n={
    ...node,
    id:nodeId,
    updatedAt:now(),
    status:node.status || prior?.status || "OBSERVED",
    provenance:node.provenance || prior?.provenance || {source:"INTERNAL_GRAPH",observedAt:now()}
  };
  if(prior && JSON.stringify(immutableNodeFields(prior))!==JSON.stringify(immutableNodeFields(n)))
    throw new Error(`KNOWLEDGE_NODE_IDENTITY_COLLISION:${n.id}`);
  s.nodes=s.nodes.filter(x=>x.id!==n.id); s.nodes.push(n); validateStore(s); return s;
}
export function addRelation(store,from,to,type,meta={}) {
  const s=structuredClone(store);
  if(!s.nodes.some(n=>n.id===from)||!s.nodes.some(n=>n.id===to)) throw new Error("KNOWLEDGE_RELATION_NODE_NOT_FOUND");
  if(!type||typeof type!=="string") throw new Error("KNOWLEDGE_RELATION_TYPE_REQUIRED");
  const existing=s.edges.find(e=>e.from===from&&e.to===to&&e.type===type);
  if(existing){
    const candidate={...existing,...structuredClone(meta)};
    if(JSON.stringify(immutableEdgeFields(existing))!==JSON.stringify(immutableEdgeFields(candidate))) throw new Error("KNOWLEDGE_EDGE_IDENTITY_COLLISION");
    return s;
  }
  s.edges.push({id:`edge:${Date.now()}:${Math.random().toString(36).slice(2,7)}`,from,to,type,status:meta.status||"OBSERVED",fingerprint:meta.fingerprint||null,meta:structuredClone(meta),createdAt:now()});
  validateStore(s); return s;
}
export function neighbors(store,id,type=null) { return store.edges.filter(e=>(e.from===id||e.to===id)&&(!type||e.type===type)); }
export function dependencyChain(store,startId,maxDepth=8) {
  validateStore(store); if(!store.nodes.some(n=>n.id===startId)) throw new Error("KNOWLEDGE_START_NODE_NOT_FOUND");
  const out=[]; const seen=new Set([startId]); let frontier=[startId];
  for(let d=0;d<maxDepth&&frontier.length;d++){
    const next=[];
    for(const id of frontier){ for(const e of store.edges.filter(x=>x.from===id&&x.type==="DEPENDS_ON"&&x.status!=="RETIRED")){ if(!seen.has(e.to)){seen.add(e.to);out.push({depth:d+1,from:id,to:e.to,edgeId:e.id,status:e.status||"OBSERVED"});next.push(e.to);} } }
    frontier=next;
  } return out;
}
export function graphIntegrity(store){
  validateStore(store); const conflictedNodes=store.nodes.filter(n=>n.status==="CONFLICTED").map(n=>n.id); const retired=store.nodes.filter(n=>n.status==="RETIRED").map(n=>n.id);
  return {valid:true,nodeCount:store.nodes.length,edgeCount:store.edges.length,conflictedNodes,retiredNodes:retired};
}
export { VERSION };
