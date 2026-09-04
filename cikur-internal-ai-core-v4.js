/**
 * CIKUR GO INTERNAL AI — REASONING CORE V4
 * Evidence-first internal reasoning with correlation, contradiction checks,
 * hypothesis ranking and session pattern memory.
 */
"use strict";

export const VERSION = "4.0.0-reasoning";
const clone = v => { try { return JSON.parse(JSON.stringify(v)); } catch { return v; } };
const text = v => String(v ?? "").trim();
const num = v => Number.isFinite(Number(v)) ? Number(v) : 0;
const norm = v => text(v).toLowerCase().replace(/\s+/g, " ").trim();
const hash = v => { let h=2166136261; for (const c of String(v)) h=((h^c.charCodeAt(0))*16777619)>>>0; return h.toString(16); };

function trust(source) {
  if (/errorLog|runtime-error/i.test(source)) return 0.95;
  if (/sourceScan/i.test(source)) return 0.90;
  if (/systemLogs|latestLogs/i.test(source)) return 0.82;
  if (/activeCases/i.test(source)) return 0.86;
  if (/recentEvents/i.test(source)) return 0.70;
  return 0.60;
}

function ev(id, source, claim, kind, details={}) {
  return { id, source, claim:text(claim), kind, trust:trust(source), details:clone(details) };
}

function collect(t) {
  const raw=[];
  if (t.errorLog) raw.push(ev("runtime-error","BCGO_STATE.errorLog",t.errorLog?.message || t.errorLog?.error || t.errorLog,"RUNTIME_ERROR"));
  (Array.isArray(t.activeCases)?t.activeCases:[]).forEach((c,i)=>{
    const msg=c?.evidence?.message || c?.evidence?.sourceFinding?.message || c?.message || c?.error;
    const target=c?.target || c?.file;
    if (msg || target) raw.push(ev(`case-${c?.id||i}`,"BCGO_STATE.activeCases",[target,msg].filter(Boolean).join(": "),"ACTIVE_CASE",{caseId:c?.id,target,severity:c?.severity}));
  });
  (Array.isArray(t.latestLogs)?t.latestLogs:[]).slice(0,40).forEach((l,i)=>{
    const msg=l?.message || l?.error || l?.text;
    if(msg) raw.push(ev(`log-${i}`,"BCGO_STATE.latestLogs",msg,"LOG",{file:l?.fileName||l?.file,type:l?.type}));
  });
  const sf=Array.isArray(t.sourceScan?.findings)?t.sourceScan.findings:[];
  const cf=Array.isArray(t.sourceScan?.crossFileFindings)?t.sourceScan.crossFileFindings:[];
  [...sf.map(x=>({...x,__cross:false})),...cf.map(x=>({...x,__cross:true}))].slice(0,80).forEach((f,i)=>{
    const file=f?.file||f?.target||f?.fileName;
    const msg=f?.message||f?.error||f?.detail||f?.finding;
    if(file||msg) raw.push(ev(`scan-${i}`,f.__cross?"BCGO_STATE.sourceScan.crossFileFindings":"BCGO_STATE.sourceScan.findings",[file,msg].filter(Boolean).join(": "),"SOURCE_FINDING",{file,crossFile:f.__cross,severity:f?.severity,type:f?.type}));
  });
  (Array.isArray(t.recentEvents)?t.recentEvents:[]).slice(0,30).forEach((e,i)=>{
    const msg=e?.message||e?.text;
    if(msg && /error|anomal|finding|failed|offline|medicine|execution|mismatch/i.test(msg)) raw.push(ev(`event-${i}`,"BCGO_STATE.recentEvents",msg,"EVENT",{type:e?.type,at:e?.at}));
  });

  const unique=new Map();
  for(const x of raw){
    const k=hash(norm(`${x.kind}|${x.details?.file||""}|${x.claim}`));
    if(!unique.has(k)) unique.set(k,{...x,fingerprint:k});
  }
  return [...unique.values()].slice(0,120);
}

function classify(t, e) {
  if(t.connection?.status === "OFFLINE" || t.firestore?.error) return "INFRASTRUCTURE";
  if((t.activeCases||[]).length) return "ACTIVE_CASE";
  if(e.some(x=>x.kind==="SOURCE_FINDING")) return "SOURCE_REVIEW";
  if(e.length) return "OBSERVED_SIGNAL";
  return "STABLE";
}

function hypotheses(t,e,memory={}) {
  const out=[]; const add=(kind,claim,base,support,next,details={})=>{
    const ids=[...new Set(support)];
    const repetition=num(memory[norm(claim)]);
    const supportScore=ids.reduce((s,id)=>s+(e.find(x=>x.id===id)?.trust||0),0);
    // Session repetition is memory/context only; it must never self-increase confidence.
    const confidence=Math.min(0.97, Math.max(0.05, base + Math.min(.16,supportScore*.025)));
    out.push({id:`hyp_${hash(kind+claim)}`,kind,claim,confidence:Math.round(confidence*100)/100,status:"UNVERIFIED",supportingEvidenceIds:ids,contradictingEvidenceIds:[],occurrencesThisSession:repetition,nextEvidence:next,details});
  };
  const all=e.map(x=>x.claim).join(" | ");
  const m=all.match(/(?:ReferenceError|is not defined)\s*:?[ ]*([A-Za-z_$][\w$]*)/i);
  if(m){const name=m[1]; const ids=e.filter(x=>new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),"i").test(x.claim)).map(x=>x.id); add("UNDEFINED_SYMBOL",`Simbol "${name}" dipanggil tetapi belum terbukti tersedia pada runtime.`,.72,ids,`Verifikasi definisi "${name}", scope/import, caller, dan file sumber.`);}

  const byFile=new Map();
  e.filter(x=>x.kind==="SOURCE_FINDING").forEach(x=>{const f=x.details?.file||"unknown"; if(!byFile.has(f))byFile.set(f,[]);byFile.get(f).push(x);});
  for(const [file,items] of byFile){
    const ids=items.map(x=>x.id);
    add("SOURCE_CLUSTER",`${file} memiliki ${items.length} temuan source yang saling berdekatan dan perlu korelasi dengan runtime.`,.64,ids,`Periksa source asli ${file}, caller/dependency, lalu cocokkan dengan telemetry runtime.`,{file,count:items.length});
  }

  const cases=Array.isArray(t.activeCases)?t.activeCases:[];
  if(cases.length){
    const grouped=new Map();
    cases.forEach(c=>{const k=norm(c?.target||c?.file||"unknown"); if(!grouped.has(k))grouped.set(k,[]);grouped.get(k).push(c);});
    for(const [target,list] of grouped){
      const ids=e.filter(x=>target && norm(x.claim).includes(target)).map(x=>x.id);
      add("CASE_CLUSTER",`Kasus aktif terkonsentrasi pada ${target||"target yang belum diketahui"} (${list.length} kasus).`,.68,ids,`Kumpulkan exact source, dependency/caller context, dan runtime evidence untuk ${target}.`,{target,count:list.length});
    }
  }

  if(/mismatch|variant/i.test(all)){
    const ids=e.filter(x=>/mismatch|variant/i.test(x.claim)).map(x=>x.id);
    add("CROSS_FILE_VARIANT","Ada indikasi variasi atau mismatch lintas-file; hubungan sebab-akibat belum terbukti.",.62,ids,"Bandingkan definisi, caller, dan kontrak antar-file sebelum memilih akar masalah.");
  }

  if(!out.length && e.length) add("UNRESOLVED_SIGNAL","Telemetry memiliki sinyal tetapi pola penyebab belum cukup spesifik untuk hipotesis yang kuat.",.42,e.slice(0,6).map(x=>x.id),"Kumpulkan evidence langsung dari source dan runtime context.");

  return out.sort((a,b)=>b.confidence-a.confidence).slice(0,8);
}

function contradictions(e, hs){
  const bad=[];
  for(const h of hs){
    const words=norm(h.claim).split(/\W+/).filter(w=>w.length>4).slice(0,5);
    const contra=e.filter(x=>/healthy|resolved|recovered|no error|normal/i.test(x.claim) && words.some(w=>norm(x.claim).includes(w)));
    if(contra.length){h.contradictingEvidenceIds=contra.map(x=>x.id); bad.push(h.id);}
  }
  return bad;
}

export function reason(telemetry={}, memory={}){
  const t=clone(telemetry||{}); const evidence=collect(t); const classification=classify(t,evidence);
  const hs=hypotheses(t,evidence,memory); const contradictionIds=contradictions(evidence,hs);
  const strongest=hs[0]||null;
  const blockers=[];
  if(!evidence.length && classification!=="STABLE") blockers.push("EVIDENCE_MISSING");
  if(contradictionIds.length) blockers.push("CONTRADICTORY_EVIDENCE");
  if(!strongest && classification!=="STABLE") blockers.push("HYPOTHESIS_MISSING");
  if(strongest && strongest.confidence<.75) blockers.push("HYPOTHESIS_CONFIDENCE_LOW");
  if(!evidence.some(x=>x.kind==="SOURCE_FINDING") && classification!=="STABLE") blockers.push("DIRECT_SOURCE_EVIDENCE_MISSING");
  if(classification!=="STABLE") blockers.push("ROOT_CAUSE_REQUIRES_MEDICINE_VERIFICATION","EXACT_SOURCE_REQUIRES_VERIFICATION");
  return {
    version:VERSION,generatedAt:new Date().toISOString(),classification,evidence,hypotheses:hs,
    selectedHypothesisId:strongest?.id||null,
    correlations:{target:t.targetCell||null,activeCaseCount:(t.activeCases||[]).length,evidenceCount:evidence.length},
    precisionGate:{pass:classification==="STABLE" && blockers.length===0,blockers,verifiedRootCause:false,verifiedExactSource:false},
    investigation:strongest?{objective:"Uji hipotesis dengan evidence langsung sebelum menyimpulkan root cause.",nextEvidence:strongest.nextEvidence,required:["exact source","dependency/caller context","runtime context","cross-file consistency"]}:{objective:"Kumpulkan evidence yang dapat diverifikasi.",nextEvidence:"Tambahkan source evidence dan runtime context."}
  };
}

if(typeof globalThis!=="undefined") globalThis.CIKURInternalAIReasoningCore={VERSION,reason};
