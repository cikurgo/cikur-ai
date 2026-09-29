/* CIKUR GO Internal AI Memory — REAL INTERNAL SESSION MEMORY
 * Deterministic bounded memory. No external API/network.
 */
const VERSION = "1.0.0-INTERNAL";
const MAX_ITEMS = 80;
function clone(v){ return typeof structuredClone === "function" ? structuredClone(v) : JSON.parse(JSON.stringify(v)); }
function createMemory(seed = {}){
  const items = Array.isArray(seed?.items) ? seed.items.slice(-MAX_ITEMS) : [];
  return {version:VERSION, items:clone(items), updatedAt:seed?.updatedAt || new Date().toISOString()};
}
function remember(memory, record){
  const next=createMemory(memory);
  const item={...clone(record||{}), at:record?.at || new Date().toISOString()};
  next.items.push(item); if(next.items.length>MAX_ITEMS) next.items.splice(0,next.items.length-MAX_ITEMS);
  next.updatedAt=new Date().toISOString(); return next;
}
function recall(memory, query=null, limit=10){
  const items=Array.isArray(memory?.items)?memory.items:[];
  const n=Math.max(1,Number(limit)||10);
  if(!query) return clone(items.slice(-n));
  const q=String(query).toLowerCase().trim();
  return clone(items.filter(x=>JSON.stringify(x).toLowerCase().includes(q)).slice(-n));
}
function clear(){ return createMemory(); }
function getStatus(memory){ return {version:VERSION,stub:false,ready:true,count:Array.isArray(memory?.items)?memory.items.length:0,maxItems:MAX_ITEMS}; }
export { VERSION, MAX_ITEMS, createMemory, remember, recall, clear, getStatus };
