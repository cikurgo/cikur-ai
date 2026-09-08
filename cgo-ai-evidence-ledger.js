/* CIKUR GO INTERNAL AI — EVIDENCE LEDGER
 * Append-only, deterministic evidence/provenance spine for Captain lifecycle.
 * This is an integrity ledger, not a cryptographic security primitive.
 */
const VERSION="1.0.0-CAPTAIN-EVIDENCE-LEDGER";

function clone(v){return typeof structuredClone==="function"?structuredClone(v):JSON.parse(JSON.stringify(v));}
function hash(value){
  let h=2166136261;
  for(const ch of String(value)) { h^=ch.codePointAt(0); h=Math.imul(h,16777619)>>>0; }
  return `fnv1a32:${h.toString(16).padStart(8,"0")}`;
}
function canonical(value){
  if(value===null||typeof value!=="object") return JSON.stringify(value);
  if(Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(k=>JSON.stringify(k)+":"+canonical(value[k])).join(",")}}`;
}

export function createEvidenceLedger(seed=[]){
  const entries=Array.isArray(seed)?clone(seed):[];
  let previousHash="GENESIS";
  if(entries.length) previousHash=entries.at(-1)?.hash||"GENESIS";

  function append(type,payload={},meta={}){
    const entry={
      id:meta.id||`ledger_${Date.now()}_${entries.length+1}`,
      sequence:entries.length,
      type:String(type||"EVENT"),
      caseId:meta.caseId||null,
      revision:Number.isInteger(meta.revision)?meta.revision:null,
      observedAt:meta.observedAt||new Date().toISOString(),
      previousHash,
      payload:clone(payload)
    };
    entry.hash=hash(canonical(entry));
    entries.push(entry); previousHash=entry.hash;
    return clone(entry);
  }
  function verify(){
    let prev="GENESIS";
    for(let i=0;i<entries.length;i++){
      const e=entries[i];
      if(e.sequence!==i || e.previousHash!==prev) return {ok:false,index:i,reason:"CHAIN_LINK_INVALID"};
      const copy=clone(e); delete copy.hash;
      if(hash(canonical(copy))!==e.hash) return {ok:false,index:i,reason:"ENTRY_HASH_INVALID"};
      prev=e.hash;
    }
    return {ok:true,length:entries.length,headHash:prev};
  }
  function list(caseId=null){return clone(caseId?entries.filter(e=>e.caseId===caseId):entries);}
  function snapshot(){return clone(entries);}
  return Object.freeze({version:VERSION,append,verify,list,snapshot,size:()=>entries.length});
}

export { VERSION };
