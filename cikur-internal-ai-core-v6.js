/**
 * CIKUR GO INTERNAL AI — REASONING CORE V6
 * Evidence-first, freshness-aware, contradiction-aware causal reasoning.
 * Read-only: no patch, no execution, no external AI/API.
 */
"use strict";
export const VERSION = "6.0.0-disciplined-reasoning";
const clone=v=>{try{return JSON.parse(JSON.stringify(v));}catch{return v;}};
const text=v=>String(v??"").trim();
const norm=v=>text(v).toLowerCase().replace(/\s+/g," ").trim();
const num=v=>Number.isFinite(Number(v))?Number(v):0;
const hash=v=>{let h=2166136261;for(const c of String(v)){h^=c.charCodeAt(0);h=Math.imul(h,16777619)>>>0;}return h.toString(16);};
const now=()=>Date.now();
function sourceTrust(source){
  if(/runtime|errorLog/i.test(source))return .98;
  if(/sourceScan/i.test(source))return .91;
  if(/latestLogs|systemLogs/i.test(source))return .85;
  if(/activeCases/i.test(source))return .88;
  if(/recentEvents/i.test(source))return .70;
  return .55;
}
function freshness(at){
  const t=num(at); if(!t)return .55;
  const age=Math.max(0,now()-t),m=60000,h=3600000;
  if(age<2*m)return 1;
  if(age<15*m)return .95;
  if(age<2*h)return .85;
  if(age<24*h)return .70;
  return .50;
}
function stableFingerprint(kind,file,claim,details={}){
  const symbol=details.symbol||((text(claim).match(/(?:ReferenceError|is not defined)\s*:?\s*([A-Za-z_$][\w$]*)/i)||[])[1]||"");
  const target=details.target||"";
  return hash(`${kind}|${norm(file||"")}|${norm(claim)}|${norm(symbol)}|${norm(target)}`);
}
function evidenceId(kind,file,claim,details={}){return `ev_${stableFingerprint(kind,file,claim,details)}`;}
function add(raw,kind,source,claim,details={},observedAt){
  const file=details.file||details.target||null;
  const at=num(observedAt||details.at)||now();
  const trust=sourceTrust(source),fresh=freshness(at),fingerprint=stableFingerprint(kind,file,claim,details);
  raw.push({id:evidenceId(kind,file,claim,details),fingerprint,kind,source,claim:text(claim),file,observedAt:at,trust,freshness:fresh,weight:Math.round(trust*fresh*100)/100,details:clone(details)});
}
function collect(t){
  const raw=[];
  const err=t.errorLog;
  if(err){const msg=typeof err==="string"?err:(err.message||err.error||"");if(msg)add(raw,"RUNTIME_ERROR","BCGO_STATE.errorLog",msg,{file:err.file||err.fileName||null,line:err.line||null,column:err.column||null},err.at||err.timestamp);}
  (Array.isArray(t.activeCases)?t.activeCases:[]).forEach((c,i)=>{
    const msg=c?.evidence?.message||c?.evidence?.sourceFinding?.message||c?.message||c?.error;
    const file=c?.target||c?.file;
    if(msg||file)add(raw,"ACTIVE_CASE","BCGO_STATE.activeCases",[file,msg].filter(Boolean).join(": "),{caseId:c?.id||`case-${i}`,file,target:file,severity:c?.severity,status:c?.status},c?.at||c?.createdAt);
  });
  (Array.isArray(t.latestLogs)?t.latestLogs:[]).slice(0,50).forEach((l,i)=>{
    const msg=l?.message||l?.error||l?.text;if(msg)add(raw,"LOG","BCGO_STATE.latestLogs",msg,{file:l?.fileName||l?.file||null,type:l?.type,index:i},l?.at||l?.timestamp||l?.createdAt);
  });
  const sf=Array.isArray(t.sourceScan?.findings)?t.sourceScan.findings:[];
  sf.forEach((f,i)=>{const file=f?.file||f?.target||f?.fileName;const msg=f?.message||f?.error||f?.detail||f?.finding;if(file||msg)add(raw,"SOURCE_FINDING","BCGO_STATE.sourceScan.findings",[file,msg].filter(Boolean).join(": "),{file,severity:f?.severity,type:f?.type,status:f?.status,index:i},f?.at||f?.timestamp);});
  const cf=Array.isArray(t.sourceScan?.crossFileFindings)?t.sourceScan.crossFileFindings:[];
  cf.forEach((f,i)=>{const file=f?.file||f?.source||f?.from||f?.target||f?.fileName;const target=f?.target||f?.to||null;const msg=f?.message||f?.error||f?.detail||f?.finding;if(file||msg)add(raw,"CROSS_FILE_FINDING","BCGO_STATE.sourceScan.crossFileFindings",[file,target,msg].filter(Boolean).join(": "),{file,target,severity:f?.severity,type:f?.type,index:i},f?.at||f?.timestamp);});
  (Array.isArray(t.recentEvents)?t.recentEvents:[]).slice(0,40).forEach((e,i)=>{const msg=e?.message||e?.text;if(msg&&/error|anomal|finding|failed|offline|mismatch|medicine|execution/i.test(msg))add(raw,"EVENT","BCGO_STATE.recentEvents",msg,{type:e?.type,target:e?.target||null,index:i},e?.at||e?.timestamp);});
  const unique=new Map();
  for(const x of raw){const old=unique.get(x.fingerprint);if(!old||x.weight>old.weight)unique.set(x.fingerprint,x);}
  return [...unique.values()].sort((a,b)=>b.weight-a.weight).slice(0,160);
}
function classify(t,e){
  if(t.connection?.status==="OFFLINE"||t.firestore?.error)return "INFRASTRUCTURE";
  if((t.activeCases||[]).length)return "ACTIVE_CASE";
  if(e.some(x=>x.kind==="RUNTIME_ERROR"))return "RUNTIME_SIGNAL";
  if(e.some(x=>x.kind.includes("SOURCE")))return "SOURCE_REVIEW";
  if(e.length)return "OBSERVED_SIGNAL";
  return "STABLE";
}
function extractSymbol(e){
  const all=e.map(x=>x.claim).join(" | ");
  const m=all.match(/(?:ReferenceError|is not defined)\s*:?[ ]*([A-Za-z_$][\w$]*)/i);return m?m[1]:null;
}
function buildHypotheses(t,e){
  const out=[];
  const push=(kind,claim,base,support,next,details={})=>{
    const ids=[...new Set(support)].filter(id=>e.some(x=>x.id===id));
    const rows=ids.map(id=>e.find(x=>x.id===id)).filter(Boolean);
    const independent=new Set(rows.map(x=>x.fingerprint)).size;
    const diversity=new Set(rows.map(x=>x.source)).size;
    const supportWeight=rows.reduce((a,x)=>a+x.weight,0);
    const bonus=Math.min(.16,supportWeight*.04)+Math.min(.06,Math.max(0,diversity-1)*.02)+Math.min(.05,Math.max(0,independent-1)*.012);
    const confidence=Math.round(Math.min(.92,Math.max(.05,base+bonus))*100)/100;
    out.push({id:`hyp_${hash(kind+"|"+claim)}`,kind,claim,confidence,status:"UNVERIFIED",supportingEvidenceIds:ids,contradictingEvidenceIds:[],independentEvidenceCount:independent,sourceDiversity:diversity,nextEvidence:next,details:clone(details)});
  };
  const symbol=extractSymbol(e);
  if(symbol){
    const ids=e.filter(x=>new RegExp(symbol.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),"i").test(x.claim)).map(x=>x.id);
    push("UNDEFINED_SYMBOL",`Simbol "${symbol}" dipanggil tetapi ketersediaannya pada runtime belum terbukti.`,.64,ids,`Verifikasi definisi "${symbol}", scope/import, caller, dan file sumber.`,{symbol});
  }
  const byFile=new Map();
  e.filter(x=>x.kind==="SOURCE_FINDING"&&x.file).forEach(x=>{if(!byFile.has(x.file))byFile.set(x.file,[]);byFile.get(x.file).push(x);});
  for(const [file,items] of byFile)push("SOURCE_CLUSTER",`${file} memiliki ${items.length} temuan source yang perlu dikorelasikan dengan runtime.`,.50,items.map(x=>x.id),`Periksa source asli ${file}, caller/dependency, lalu cocokkan dengan telemetry runtime.`,{file,count:items.length});
  const cases=Array.isArray(t.activeCases)?t.activeCases:[],grouped=new Map();
  cases.forEach(c=>{const target=c?.target||c?.file||"UNKNOWN";if(!grouped.has(target))grouped.set(target,[]);grouped.get(target).push(c);});
  for(const [target,list] of grouped){const ids=e.filter(x=>x.file===target||x.details?.target===target||norm(x.claim).includes(norm(target))).map(x=>x.id);push("CASE_CLUSTER",`Kasus aktif terkonsentrasi pada ${target} (${list.length} kasus).`,.56,ids,`Kumpulkan exact source, dependency/caller context, dan runtime evidence untuk ${target}.`,{target,count:list.length});}
  const cross=e.filter(x=>x.kind==="CROSS_FILE_FINDING");
  if(cross.length)push("CROSS_FILE_VARIANT","Ada indikasi hubungan atau variasi lintas-file; hubungan sebab-akibat belum terbukti.",.52,cross.map(x=>x.id),"Bandingkan definisi, caller, dependency, dan kontrak antar-file sebelum memilih akar masalah.");
  if(!out.length&&e.length)push("UNRESOLVED_SIGNAL","Telemetry memiliki sinyal tetapi pola penyebab belum cukup spesifik untuk hipotesis kuat.",.34,e.slice(0,6).map(x=>x.id),"Kumpulkan evidence langsung dari source, runtime context, dan dependency graph.");
  return out.sort((a,b)=>b.confidence-a.confidence).slice(0,8);
}
function contradictionCheck(e,hs){
  const bad=[];
  for(const h of hs){
    const symbol=h.details?.symbol;
    const related=e.filter(x=>symbol?norm(x.claim).includes(norm(symbol)):(h.supportingEvidenceIds||[]).includes(x.id));
    const positive=related.filter(x=>/healthy|resolved|recovered|no error|normal/i.test(x.claim));
    if(positive.length){h.contradictingEvidenceIds=positive.map(x=>x.id);bad.push(h.id);}
  }
  return bad;
}
function causalLinks(t,e,hs){
  const links=[];
  const target=t.targetCell||t.activeCases?.[0]?.target||t.activeCases?.[0]?.file||null;
  for(const h of hs){
    const supported=e.filter(x=>(h.supportingEvidenceIds||[]).includes(x.id));
    const cross=supported.filter(x=>x.kind==="CROSS_FILE_FINDING"&&x.file&&x.details?.target);
    if(cross.length){for(const x of cross.slice(0,4))links.push({hypothesisId:h.id,from:x.file,to:x.details.target,relation:"POTENTIAL_CAUSE_OF",verified:false,evidenceIds:[x.id],basis:"explicit_cross_file_finding"});continue;}
    const files=[...new Set(supported.map(x=>x.file).filter(Boolean))];
    if(target&&files.length>1)for(const file of files.filter(f=>f!==target).slice(0,3))links.push({hypothesisId:h.id,from:file,to:target,relation:"POTENTIAL_CAUSE_OF",verified:false,evidenceIds:supported.filter(x=>x.file===file).map(x=>x.id),basis:"shared_runtime_target"});
  }
  return links;
}
export function reason(telemetry={},history={}){
  const t=clone(telemetry||{}),evidence=collect(t),classification=classify(t,evidence),hypotheses=buildHypotheses(t,evidence),contradictionIds=contradictionCheck(evidence,hypotheses),selected=hypotheses[0]||null;
  const blockers=[];
  if(classification!=="STABLE"&&!evidence.length)blockers.push("EVIDENCE_MISSING");
  if(contradictionIds.length)blockers.push("CONTRADICTORY_EVIDENCE");
  if(classification!=="STABLE"&&!selected)blockers.push("HYPOTHESIS_MISSING");
  if(selected&&selected.confidence<.72)blockers.push("HYPOTHESIS_CONFIDENCE_LOW");
  if(classification!=="STABLE"&&!evidence.some(x=>x.kind.includes("SOURCE")))blockers.push("DIRECT_SOURCE_EVIDENCE_MISSING");
  if(t.connection?.status==="OFFLINE"||t.firestore?.error)blockers.push("LIVE_STATE_UNAVAILABLE");
  if(classification!=="STABLE")blockers.push("ROOT_CAUSE_REQUIRES_MEDICINE_VERIFICATION","EXACT_SOURCE_REQUIRES_VERIFICATION");
  const stable=classification==="STABLE";
  return {
    version:VERSION,generatedAt:new Date().toISOString(),classification,evidence,hypotheses,selectedHypothesisId:selected?.id||null,
    correlations:{target:t.targetCell||null,activeCaseCount:(t.activeCases||[]).length,evidenceCount:evidence.length,independentEvidenceCount:new Set(evidence.map(x=>x.fingerprint)).size,sourceDiversity:new Set(evidence.map(x=>x.source)).size},
    causalLinks:causalLinks(t,evidence,hypotheses),
    precisionGate:{pass:stable&&blockers.length===0,blockers,verifiedRootCause:false,verifiedExactSource:false},
    investigation:selected?{objective:"Uji hubungan sebab-akibat dengan evidence langsung sebelum menyimpulkan root cause.",nextEvidence:selected.nextEvidence,required:["exact source","dependency/caller context","runtime context","cross-file consistency"],doNotConclude:["root cause","exact source","safe patch"]}:{objective:"Kumpulkan evidence yang dapat diverifikasi.",nextEvidence:"Tambahkan source evidence dan runtime context."},
    historyHint:history&&selected?{occurrences:num(history[norm(selected.claim)]||0)}:{occurrences:0}
  };
}
if(typeof globalThis!=="undefined")globalThis.CIKURInternalAIReasoningCore={VERSION,reason};
