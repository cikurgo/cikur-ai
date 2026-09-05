/* CIKUR GO Internal Memory - Upgraded v1.4.0
 * Enhanced pattern retrieval with score-based ranking independent of insertion order.
 */
const VERSION="1.4.0";
const now=()=>new Date().toISOString();
export function createMemory(seed=[]) { return {version:VERSION,records:Array.isArray(seed)?structuredClone(seed):[]}; }
export function remember(memory, record) {
  if(!record || typeof record!=="object" || Array.isArray(record)) throw new TypeError("MEMORY_RECORD_REQUIRED");
  const m=structuredClone(memory); const safe={...record};
  for(const k of ["proof","verified","authorizationId","decision","action","rootCause","exactSource","evidenceIds","fingerprint","sourceFingerprint"]) delete safe[k];
  const provenance={caseId:typeof record.caseId==="string"?record.caseId:null,source:record.source||"INTERNAL_HISTORY_ENHANCED",observedAt:record.observedAt||null,outcome:record.outcome||null,validatedAt:record.validatedAt||null};
  const storedAt=now();
  m.records.push({...safe,id:safe.id||`mem_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,storedAt,role:"HISTORICAL_HINT",proof:false,trust:"ADVISORY",confidence:Number.isFinite(record.confidence)?Math.max(0,Math.min(1,record.confidence)):0.5,provenance});
  return m;
}
function ageFactor(storedAt,halfLifeDays=30){ const t=Date.parse(storedAt); if(!Number.isFinite(t)) return 0.25; const days=Math.max(0,(Date.now()-t)/86400000); return Math.pow(0.5,days/Math.max(1,halfLifeDays)); }

export function recall(memory, query={}) {
  const limit = Number.isFinite(query.limit) ? Math.max(1, query.limit) : 20;
  return memory.records
    .filter(r=>!query.type||r.type===query.type)
    .filter(r=>!query.target||r.target===query.target)
    .map(r=>({...r,proof:false,role:"HISTORICAL_HINT",trust:"ADVISORY",relevanceScore:Math.max(0,Math.min(1,(r.confidence??0.5)*ageFactor(r.storedAt,query.halfLifeDays||30)))}))
    .sort((a,b)=>b.relevanceScore-a.relevanceScore)
    .slice(0, limit);
}
export function deriveHints(memory, caseData) { return recall(memory,{target:caseData.target}).sort((a,b)=>b.relevanceScore-a.relevanceScore).map(r=>({sourceMemoryId:r.id,hint:r.solution||r.pattern||null,mustReverify:true,relevanceScore:r.relevanceScore})); }
export { VERSION };
