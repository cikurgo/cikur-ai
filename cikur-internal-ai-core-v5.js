/**
 * CIKUR GO INTERNAL AI — REASONING CORE V5
 * Evidence-first causal reasoning. Read-only: no patch, no execution.
 */
"use strict";
export const VERSION = "5.0.0-causal-reasoning";
const clone=v=>{try{return JSON.parse(JSON.stringify(v));}catch{return v;}};
const text=v=>String(v??"").trim();
const norm=v=>text(v).toLowerCase().replace(/\s+/g," ").trim();
const number=v=>Number.isFinite(Number(v))?Number(v):0;
const now=()=>Date.now();
function hash(v){let h=2166136261;for(const c of String(v)){h^=c.charCodeAt(0);h=Math.imul(h,16777619)>>>0;}return h.toString(16);}
function sourceTrust(source){
  if(/runtime|errorLog/i.test(source))return .97;
  if(/sourceScan/i.test(source))return .90;
  if(/latestLogs|systemLogs/i.test(source))return .84;
  if(/activeCases/i.test(source))return .86;
  if(/recentEvents/i.test(source))return .68;
  return .55;
}
function freshness(observedAt){
  const t=Number(observedAt||0); if(!t)return .55;
  const age=Math.max(0,now()-t); const hour=3600000;
  if(age<2*60000)return 1;
  if(age<15*60000)return .95;
  if(age<2*hour)return .85;
  if(age<24*hour)return .70;
  return .50;
}
function evidenceId(kind,file,claim,observedAt){return `ev_${hash(`${kind}|${norm(file)}|${norm(claim)}|${Number(observedAt)||0}`)}`;}
function add(raw,kind,source,claim,details={},observedAt){
  const file=details.file||details.target||null;
  const at=Number(observedAt||details.at||0)||now();
  const trust=sourceTrust(source), fresh=freshness(at);
  const independentKey=hash(`${kind}|${norm(file||"")}|${norm(claim)}`);
  raw.push({id:evidenceId(kind,file,claim,at),fingerprint:independentKey,kind,source,claim:text(claim),file,observedAt:at,trust,freshness:fresh,weight:Math.round(trust*fresh*100)/100,details:clone(details)});
}
function collect(t){
  const raw=[];
  const err=t.errorLog;
  if(err){const msg=typeof err==="string"?err:(err.message||err.error||"");if(msg)add(raw,"RUNTIME_ERROR","BCGO_STATE.errorLog",msg,{file:err.file||err.fileName||null,line:err.line||null,column:err.column||null},err.at||err.timestamp);}
  (Array.isArray(t.activeCases)?t.activeCases:[]).forEach((c,i)=>{
    const msg=c?.evidence?.message||c?.evidence?.sourceFinding?.message||c?.message||c?.error;
    const file=c?.target||c?.file;
    if(msg||file)add(raw,"ACTIVE_CASE","BCGO_STATE.activeCases",[file,msg].filter(Boolean).join(": "),{caseId:c?.id||`case-${i}`,file,target:file,severity:c?.severity},c?.at||c?.createdAt);
  });
  (Array.isArray(t.latestLogs)?t.latestLogs:[]).slice(0,50).forEach((l,i)=>{
    const msg=l?.message||l?.error||l?.text;if(msg)add(raw,"LOG","BCGO_STATE.latestLogs",msg,{file:l?.fileName||l?.file||null,type:l?.type,index:i},l?.at||l?.timestamp||l?.createdAt);
  });
  const sf=Array.isArray(t.sourceScan?.findings)?t.sourceScan.findings:[];
  const cf=Array.isArray(t.sourceScan?.crossFileFindings)?t.sourceScan.crossFileFindings:[];
  sf.forEach((f,i)=>{const file=f?.file||f?.target||f?.fileName;const msg=f?.message||f?.error||f?.detail||f?.finding;if(file||msg)add(raw,"SOURCE_FINDING","BCGO_STATE.sourceScan.findings",[file,msg].filter(Boolean).join(": "),{file,severity:f?.severity,type:f?.type,status:f?.status,index:i},f?.at||f?.timestamp);});
  cf.forEach((f,i)=>{const file=f?.file||f?.target||f?.fileName;const msg=f?.message||f?.error||f?.detail||f?.finding;if(file||msg)add(raw,"CROSS_FILE_FINDING","BCGO_STATE.sourceScan.crossFileFindings",[file,msg].filter(Boolean).join(": "),{file,target:f?.target||null,severity:f?.severity,type:f?.type,index:i},f?.at||f?.timestamp);});
  (Array.isArray(t.recentEvents)?t.recentEvents:[]).slice(0,40).forEach((e,i)=>{const msg=e?.message||e?.text;if(msg&&/error|anomal|finding|failed|offline|mismatch|medicine|execution/i.test(msg))add(raw,"EVENT","BCGO_STATE.recentEvents",msg,{type:e?.type,target:e?.target||null,index:i},e?.at||e?.timestamp);});
  const unique=new Map();
  for(const x of raw){const key=x.fingerprint;const old=unique.get(key);if(!old||x.weight>old.weight)unique.set(key,x);}
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
function buildHypotheses(t,e,history={}){
  const out=[];
  const add=(kind,claim,base,support,next,details={})=>{
    const ids=[...new Set(support)].filter(id=>e.some(x=>x.id===id));
    const independent=new Set(ids.map(id=>e.find(x=>x.id===id)?.fingerprint)).size;
    const supportWeight=ids.map(id=>e.find(x=>x.id===id)?.weight||0).reduce((a,b)=>a+b,0);
    const diversity=new Set(ids.map(id=>e.find(x=>x.id===id)?.source||"?")).size;
    const historyOnly=number(history[norm(claim)]||0);
    // History can rank a hypothesis but can never add confidence by itself.
    const bonus=Math.min(.18,supportWeight*.045)+Math.min(.06,Math.max(0,diversity-1)*.02)+Math.min(.04,Math.max(0,independent-1)*.01);
    const confidence=Math.round(Math.min(.94,Math.max(.05,base+bonus))*100)/100;
    out.push({id:`hyp_${hash(kind+claim)}`,kind,claim,confidence,status:"UNVERIFIED",supportingEvidenceIds:ids,contradictingEvidenceIds:[],independentEvidenceCount:independent,sourceDiversity:diversity,historyOccurrences:historyOnly,nextEvidence:next,details:clone(details)});
  };
  const symbol=extractSymbol(e);
  if(symbol){
    const ids=e.filter(x=>new RegExp(symbol.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),"i").test(x.claim)).map(x=>x.id);
    add("UNDEFINED_SYMBOL",`Simbol "${symbol}" dipanggil tetapi belum terbukti tersedia pada runtime.`,.66,ids,`Verifikasi definisi "${symbol}", scope/import, caller, dan file sumber.`,{symbol});
  }
  const byFile=new Map();
  e.filter(x=>x.kind.includes("SOURCE")&&x.file).forEach(x=>{if(!byFile.has(x.file))byFile.set(x.file,[]);byFile.get(x.file).push(x);});
  for(const [file,items] of byFile){
    add("SOURCE_CLUSTER",`${file} memiliki ${items.length} temuan source yang perlu dikorelasikan dengan runtime.`,.54,items.map(x=>x.id),`Periksa source asli ${file}, caller/dependency, lalu cocokkan dengan telemetry runtime.`,{file,count:items.length});
  }
  const cases=Array.isArray(t.activeCases)?t.activeCases:[];const grouped=new Map();
  cases.forEach(c=>{const target=c?.target||c?.file||"UNKNOWN";if(!grouped.has(target))grouped.set(target,[]);grouped.get(target).push(c);});
  for(const [target,list] of grouped){
    const ids=e.filter(x=>x.file===target||norm(x.claim).includes(norm(target))).map(x=>x.id);
    add("CASE_CLUSTER",`Kasus aktif terkonsentrasi pada ${target} (${list.length} kasus).`,.58,ids,`Kumpulkan exact source, dependency/caller context, dan runtime evidence untuk ${target}.`,{target,count:list.length});
  }
  const cross=e.filter(x=>x.kind==="CROSS_FILE_FINDING"||/mismatch|variant/i.test(x.claim));
  if(cross.length)add("CROSS_FILE_VARIANT","Ada indikasi variasi atau mismatch lintas-file; hubungan sebab-akibat belum terbukti.",.54,cross.map(x=>x.id),"Bandingkan definisi, caller, dependency, dan kontrak antar-file sebelum memilih akar masalah.");
  if(!out.length&&e.length)add("UNRESOLVED_SIGNAL","Telemetry memiliki sinyal tetapi pola penyebab belum cukup spesifik untuk hipotesis kuat.",.36,e.slice(0,6).map(x=>x.id),"Kumpulkan evidence langsung dari source, runtime context, dan dependency graph.");
  return out.sort((a,b)=>b.confidence-a.confidence).slice(0,8);
}
function contradictions(e,hs){
  const bad=[];
  for(const h of hs){
    const symbol=h.details?.symbol;
    const related=e.filter(x=>symbol?norm(x.claim).includes(norm(symbol)):true);
    const explicit=related.filter(x=>/healthy|resolved|recovered|no error|normal/i.test(x.claim));
    if(explicit.length){h.contradictingEvidenceIds=explicit.map(x=>x.id);bad.push(h.id);}
  }
  return bad;
}
function causalLinks(e,hs){
  const links=[];
  for(const h of hs){
    const files=[...new Set(h.supportingEvidenceIds.map(id=>e.find(x=>x.id===id)?.file).filter(Boolean))];
    for(const file of files){links.push({hypothesisId:h.id,from:file,to:"RUNTIME_SYMPTOM",relation:"POTENTIAL_CAUSE_OF",verified:false});}
  }
  return links;
}
export function reason(telemetry={},history={}){
  const t=clone(telemetry||{}),evidence=collect(t),classification=classify(t,evidence),hypotheses=buildHypotheses(t,evidence,history),contradictionIds=contradictions(evidence,hypotheses),selected=hypotheses[0]||null;
  const blockers=[];
  if(classification!=="STABLE"&&!evidence.length)blockers.push("EVIDENCE_MISSING");
  if(contradictionIds.length)blockers.push("CONTRADICTORY_EVIDENCE");
  if(classification!=="STABLE"&&!selected)blockers.push("HYPOTHESIS_MISSING");
  if(selected&&selected.confidence<.72)blockers.push("HYPOTHESIS_CONFIDENCE_LOW");
  if(classification!=="STABLE"&&!evidence.some(x=>x.kind.includes("SOURCE")))blockers.push("DIRECT_SOURCE_EVIDENCE_MISSING");
  blockers.push(...(classification!=="STABLE"?["ROOT_CAUSE_REQUIRES_MEDICINE_VERIFICATION","EXACT_SOURCE_REQUIRES_VERIFICATION"]:[]));
  const stable=classification==="STABLE";
  return {
    version:VERSION,generatedAt:new Date().toISOString(),classification,evidence,hypotheses,selectedHypothesisId:selected?.id||null,
    correlations:{target:t.targetCell||null,activeCaseCount:(t.activeCases||[]).length,evidenceCount:evidence.length,independentEvidenceCount:new Set(evidence.map(x=>x.fingerprint)).size},
    causalLinks:causalLinks(evidence,hypotheses),
    precisionGate:{pass:stable&&blockers.length===0,blockers,verifiedRootCause:false,verifiedExactSource:false},
    investigation:selected?{objective:"Uji hubungan sebab-akibat dengan evidence langsung sebelum menyimpulkan root cause.",nextEvidence:selected.nextEvidence,required:["exact source","dependency/caller context","runtime context","cross-file consistency"],doNotConclude:["root cause","exact source","safe patch"]}:{objective:"Kumpulkan evidence yang dapat diverifikasi.",nextEvidence:"Tambahkan source evidence dan runtime context."}
  };
}
if(typeof globalThis!=="undefined")globalThis.CIKURInternalAIReasoningCore={VERSION,reason};
