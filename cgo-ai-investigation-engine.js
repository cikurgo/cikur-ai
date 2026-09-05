/* CIKUR GO INTERNAL AI — ACTIVE INVESTIGATION ENGINE v2.1.0
 * Evidence-driven, same-origin, deterministic investigation.
 * No external AI/API. No source mutation. Medicine remains proof authority.
 */
const VERSION = "2.1.0-ACTIVE";

const cleanFile = v => String(v || "").split(/[?#]/)[0].split("/").pop() || "";
const esc = v => String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const lineOf = (s, i) => String(s).slice(0, i).split(/\r?\n/).length;
const fingerprint = (text="") => {
  let h=2166136261;
  for(const ch of String(text)){ h ^= ch.codePointAt(0); h=Math.imul(h,16777619)>>>0; }
  return `fnv1a32:${h.toString(16).padStart(8,"0")}`;
};

function symbolFromLog(log={}) {
  const explicit=log.symbol||log.details?.symbol||"";
  if(explicit) return String(explicit).trim();
  return String(log.message||log.error||"").match(/(?:ReferenceError|is not defined|not defined)\s*:?\s*([A-Za-z_$][\w$]*)/i)?.[1] || null;
}

function calls(source,symbol){
  const re=new RegExp(`\\b${esc(symbol)}\\s*\\(`,"g"), out=[]; let m;
  while((m=re.exec(source)) && out.length<30){
    const line=lineOf(source,m.index), row=source.split(/\r?\n/)[line-1]||"";
    if(new RegExp(`(?:function\\s+|(?:const|let|var)\\s+${esc(symbol)}\\s*=)`).test(row)) continue;
    out.push({line,snippet:row.trim().slice(0,300)});
  }
  return out;
}
function definitions(source,symbol){
  const n=esc(symbol), patterns=[
    new RegExp(`(?:^|\\n)\\s*(?:async\\s+)?function\\s+${n}\\s*\\(`,"g"),
    new RegExp(`\\b(?:const|let|var)\\s+${n}\\s*=`,`g`),
    new RegExp(`\\b(?:window|globalThis)\\.${n}\\s*=`,`g`)
  ];
  const out=[]; for(const re of patterns){let m; while((m=re.exec(source))&&out.length<30) out.push({line:lineOf(source,m.index),snippet:(source.split(/\r?\n/)[lineOf(source,m.index)-1]||"").trim().slice(0,300)});}
  return out.sort((a,b)=>a.line-b.line);
}
function moduleContext(source){
  const imports=[...String(source).matchAll(/<script[^>]+type=["']module["'][^>]*src=["']([^"']+)["'][^>]*>/gi)].map(m=>cleanFile(m[1]));
  const scripts=[...String(source).matchAll(/<script[^>]+src=["']([^"']+)["'][^>]*>/gi)].map(m=>cleanFile(m[1]));
  const inlineHandlers=[...String(source).matchAll(/\bon[a-z]+\s*=\s*["'][^"']*[A-Za-z_$][\w$]*\s*\([^"']*["']/gi)].length;
  return {moduleImports:[...new Set(imports)],scripts:[...new Set(scripts)],inlineHandlers};
}

export function createInvestigationEngine(caseData={}, options={}) {
  const state={caseId:caseData.caseId||caseData.id||null, revision:caseData.revision||caseData.bcgoRevisionToken||null, status:"ACTIVE", cycle:0, probes:[], evidence:[], hypotheses:[], focus:null, sourceSurfaceComplete:!!options.sourceSurfaceComplete};
  const fetchSource=options.fetchSource || (async file=>{const r=await fetch(`./${encodeURIComponent(file)}`,{cache:"no-store",credentials:"same-origin"}); if(!r.ok) throw new Error(`HTTP ${r.status}`); return await r.text();});
  const files=()=>Object.keys(caseData.sourceScan?.sources||{}).map(cleanFile).filter(Boolean);
  const target=cleanFile(caseData.target||caseData.source||caseData.lastEvidence?.fileName||caseData.lastEvidence?.file);
  const log=caseData.lastEvidence||caseData.evidence||{};
  const symbol=symbolFromLog(log);

  async function step(){
    state.cycle++;
    const all=files();
    const targetFile=target||all[0]||null;
    if(!targetFile){state.status="BLOCKED";return snapshot();}
    state.focus={target:targetFile,symbol,actions:[]};
    const source=await fetchSource(targetFile);
    const targetCalls=symbol?calls(source,symbol):[];
    const targetDefs=symbol?definitions(source,symbol):[];
    const ctx=moduleContext(source);
    state.probes.push({type:"READ_SOURCE",file:targetFile,cycle:state.cycle,fingerprint:fingerprint(source)});
    if(symbol){
      state.probes.push({type:"SYMBOL_CALL_SEARCH",file:targetFile,symbol,hits:targetCalls.length});
      state.evidence.push(...targetCalls.map(x=>({id:`AI-${state.cycle}-${targetFile}-${x.line}-CALL`,status:"VERIFIED",exact:true,strength:0.95,file:targetFile,line:x.line,claim:`${symbol} dipanggil di ${targetFile}:${x.line}`,metadata:{kind:"SYMBOL_CALL_SITE",symbol}})));
      if(targetDefs.length){state.evidence.push(...targetDefs.map(x=>({id:`AI-${state.cycle}-${targetFile}-${x.line}-DEF`,status:"VERIFIED",exact:true,strength:0.95,file:targetFile,line:x.line,claim:`${symbol} didefinisikan di ${targetFile}:${x.line}`,metadata:{kind:"SYMBOL_DEFINITION",symbol}})));}
      const provider=[];
      if(!targetDefs.length){
        for(const f of all.filter(x=>x!==targetFile)){try{const s=await fetchSource(f);const d=definitions(s,symbol);if(d.length) provider.push(...d.map(x=>({file:f,...x})));}catch{}}
        state.probes.push({type:"DEPENDENCY_SYMBOL_SEARCH",symbol,filesChecked:all.length-1,providers:provider.length});
      }
      const support=provider.length?provider.map(x=>({id:`AI-${state.cycle}-${x.file}-${x.line}-PROVIDER`,status:"VERIFIED",exact:true,strength:0.9,file:x.file,line:x.line,claim:`${symbol} didefinisikan di provider ${x.file}:${x.line}`,metadata:{kind:"SYMBOL_PROVIDER",symbol}})):[];
      state.evidence.push(...support);
      const callsExist=targetCalls.length>0;
      const hypothesis = callsExist && !targetDefs.length && !provider.length
        ? {statement:`${symbol} dipanggil oleh ${targetFile}, tetapi definisinya tidak ditemukan pada source surface yang berhasil dibaca.`,score:0.9,kind:"MISSING_SYMBOL"}
        : callsExist && provider.length
        ? {statement:`${symbol} dipanggil oleh ${targetFile}, tetapi implementasinya berada di provider ${provider[0].file}; availability runtime harus dibuktikan melalui loading/scope.`,score:0.82,kind:"CROSS_FILE_SCOPE"}
        : callsExist && targetDefs.length
        ? {statement:`${symbol} memiliki call-site dan definisi dalam ${targetFile}; masalah kemungkinan berada pada runtime scope/load order.`,score:0.78,kind:"SCOPE_OR_LOAD_ORDER"}
        : null;
      if(hypothesis){state.hypotheses=[{hypothesisId:`H-AI-${state.cycle}`,...hypothesis,evidenceIds:state.evidence.map(e=>e.id)}];state.focus.actions=["TRACE_SYMBOL","VERIFY_SCOPE","COMPARE_LOAD_ORDER"];}
    }
    if(targetFile.endsWith(".html")){ state.probes.push({type:"HTML_MODULE_CONTEXT",file:targetFile,context:ctx}); }
    state.sourceSurfaceComplete=state.sourceSurfaceComplete || all.length>0;
    state.status=state.hypotheses.length?"HYPOTHESIS_FORMED":"EVIDENCE_COLLECTED";
    return snapshot();
  }
  function snapshot(){return {version:VERSION,...structuredClone(state),operationalInvestigation:{decision:state.status,focus:state.focus,cycle:state.cycle,probeCount:state.probes.length,evidenceCount:state.evidence.length,hypotheses:state.hypotheses,nextActions:state.focus?.actions||[],sourceSurfaceComplete:state.sourceSurfaceComplete}};}
  return Object.freeze({step,snapshot,version:VERSION});
}
