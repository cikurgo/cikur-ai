/* CIKUR GO Internal AI — Active Investigation Engine
 * Turns the Investigator from a probe planner into an executing, evidence-driven
 * internal investigation loop. No external AI/API. No source mutation.
 *
 * The engine never invents source. Every conclusion must be backed by a probe result
 * produced by the injected internal probe provider.
 */
import * as Core from "./cgo-ai-core.js";
import * as Investigator from "./cgo-ai-investigator.js";

const VERSION = "2.1.0-ACTIVE-NERVE";
const MAX_STEPS_DEFAULT = 10;
const MAX_FILES_DEFAULT = 40;

const now = () => new Date().toISOString();
const clone = v => typeof structuredClone === "function" ? structuredClone(v) : JSON.parse(JSON.stringify(v));
const normalizeFile = v => {
  const raw = String(v || "").trim();
  if (!raw) return null;
  const clean = raw.split("?")[0].split("#")[0];
  return clean.substring(clean.lastIndexOf("/") + 1) || raw;
};
const escapeRegExp = v => String(v || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const lineOf = (source, index) => String(source || "").slice(0, Math.max(0, index)).split("\n").length;
const snippet = (source, index, radius = 120) => String(source || "").slice(Math.max(0, index - radius), Math.min(String(source || "").length, index + radius)).trim();

function symbolFromCase(caseData) {
  const text = String(caseData?.symptom || "");
  const patterns = [
    /ReferenceError:\s*([A-Za-z_$][\w$]*)\s+is not defined/i,
    /\b([A-Za-z_$][\w$]*)\s+is not defined\b/i,
    /(?:undefined|missing)\s+(?:symbol|function|method)\s*[:=]?\s*([A-Za-z_$][\w$]*)/i
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) return m[1];
  }
  return null;
}


function symbolsFromCase(caseData) {
  const out = new Set();
  const add = v => {
    const s = String(v || "").trim();
    if (/^[A-Za-z_$][\w$]*$/.test(s)) out.add(s);
  };
  add(symbolFromCase(caseData));
  for (const e of (caseData?.evidence || [])) {
    add(e?.metadata?.symbol);
    const text = String(e?.claim || "");
    for (const m of text.matchAll(/(?:ReferenceError:\s*)?([A-Za-z_$][\w$]*)\s+is not defined/gi)) add(m[1]);
  }
  return [...out].slice(0, 12);
}

function structuralSignals(source, file) {
  const text = String(source || "");
  const out = [];
  if (/\.html?$/i.test(String(file || ""))) {
    const opens = [...text.matchAll(/<div\b[^>]*>/gi)].length;
    const closes = [...text.matchAll(/<\/div\s*>/gi)].length;
    if (opens !== closes) out.push({
      type: "HTML_DIV_BALANCE",
      claim: `Source ${file} memiliki ${opens} pembuka <div> dan ${closes} penutup </div>; struktur DOM tidak seimbang.`,
      exact: true,
      line: Math.max(1, lineOf(text, Math.max(0, text.lastIndexOf("<div"))))
    });
  }
  return out;
}

function findSymbolHits(source, file, symbol) {
  const re = new RegExp(`\\b${escapeRegExp(symbol)}\\b`, "g");
  const hits = [];
  for (const m of String(source || "").matchAll(re)) {
    const i = m.index ?? 0;
    const before = String(source).slice(Math.max(0, i - 80), i);
    const after = String(source).slice(i + symbol.length, i + symbol.length + 120);
    const declarationLike = new RegExp(`(?:function\\s+|(?:const|let|var)\\s+|(?:window|globalThis)\\.)${escapeRegExp(symbol)}\\b`).test(before + symbol)
      || (/(?:^|[\n;{}]\s*)(?:async\s+)?[A-Za-z_$][\w$]*\s*$/.test(before) && /^\s*\(/.test(after) && /\)\s*\{/.test(after));
    // A declaration such as `function foo()` also has `(` after the symbol.
    // It must not be emitted as a runtime call-site.
    const call = !declarationLike && /^\s*\(/.test(after);
    const definition = declarationLike;
    const handler = /(?:onclick|onchange|onsubmit|oninput|onload)\s*=/.test(before);
    hits.push({file, line:lineOf(source,i), snippet:snippet(source,i), definition, call, handler});
  }
  return hits;
}
function findDefinitions(source, file, symbol) {
  const s = escapeRegExp(symbol);
  const patterns = [
    new RegExp(`(?:function\\s+${s}\\b|(?:const|let|var)\\s+${s}\\s*=|(?:window|globalThis)\\.${s}\\s*=)`, "g"),
    new RegExp(`export\\s+(?:async\\s+)?function\\s+${s}\\b`, "g")
  ];
  const hits = [];
  for (const re of patterns) {
    for (const m of String(source || "").matchAll(re)) {
      const i = m.index ?? 0;
      if (!hits.some(x => x.line === lineOf(source,i))) hits.push({file,line:lineOf(source,i),snippet:snippet(source,i),exact:true});
    }
  }
  return hits;
}

function findImportsExports(source, file, symbol) {
  const s = escapeRegExp(symbol);
  const re = new RegExp(`(?:import|export)[^\\n;{}]*\\b${s}\\b[^\\n;{}]*`, "g");
  return [...String(source || "").matchAll(re)].map(m => {
    const i = m.index ?? 0;
    return {file,line:lineOf(source,i),snippet:snippet(source,i),exact:true};
  });
}

function scriptTags(source, file) {
  if (!/\.html?$/i.test(String(file || ""))) return [];
  const out = [];
  for (const m of String(source || "").matchAll(/<script\b([^>]*)>/gi)) {
    const i = m.index ?? 0;
    const attrs = m[1] || "";
    const src = (attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i) || [])[1] || null;
    const type = (attrs.match(/\btype\s*=\s*["']([^"']+)["']/i) || [])[1] || null;
    out.push({file,line:lineOf(source,i),src,type,inline:!src,exact:true,snippet:snippet(source,i,180)});
  }
  return out;
}

function makeEvidence(id, payload) {
  return {
    id,
    type: payload.type || "INTERNAL_PROBE",
    source: payload.source || payload.file || "CGO_INTERNAL_PROBE",
    claim: payload.claim,
    status: payload.status || "VERIFIED",
    strength: Number.isFinite(payload.strength) ? payload.strength : 1,
    exact: payload.exact !== false,
    observedAt: now(),
    fingerprint: payload.fingerprint || null,
    metadata: {
      ...(payload.metadata || {}),
      file: payload.file || null,
      probe: payload.probe || null,
      proofRequired: payload.proofRequired !== false
    }
  };
}

function unique(arr) { return [...new Set((arr || []).filter(Boolean))]; }

function buildHypotheses(caseData, context) {
  const ev = caseData?.evidence || [];
  const sourceSurfaceComplete = context.sourceSurfaceComplete === true;
  const symbols = Array.isArray(context.symbols) ? context.symbols : [context.symbol || symbolFromCase(caseData)].filter(Boolean);
  const symbol = symbols[0] || null;
  const hs = [];
  const calls = ev.filter(e => e.type === "SYMBOL_CALL_SITE");
  const defs = ev.filter(e => e.type === "SYMBOL_DEFINITION");
  const absence = ev.filter(e => e.type === "SYMBOL_DEFINITION_ABSENCE");
  const scripts = ev.filter(e => e.type === "SCRIPT_LOADING_CONTEXT");
  const dom = ev.filter(e => e.type === "HTML_DIV_BALANCE");
  const nerveUnresolved = ev.filter(e => e.type === "NERVE_UNRESOLVED_SYMBOL");
  const nerveFindings = ev.filter(e => e.type === "NERVE_SOURCE_FINDING");

  if (sourceSurfaceComplete && symbol && calls.length && !defs.length && absence.length) {
    hs.push({
      id:`H-SYMBOL-MISSING-${symbol}`,
      statement:`Simbol ${symbol} dipanggil pada runtime/source target tetapi tidak memiliki definisi pada seluruh source surface yang berhasil diverifikasi.`,
      evidenceIds:unique([...calls.map(e=>e.id), ...absence.map(e=>e.id)]),
      nodeIds:unique([...calls.map(e=>e.metadata?.file), ...absence.map(e=>e.metadata?.file)]),
      causal:true
    });
  }
  // If runtime says a symbol is undefined but the current source surface DOES contain
  // a definition, do not manufacture a missing-symbol root cause. This is a discrepancy
  // that requires execution-context investigation (scope/module/load/runtime state).
  if (symbol && calls.length && defs.length && !absence.length) {
    hs.push({
      id:`H-SYMBOL-RUNTIME-CONTEXT-${symbol}`,
      statement:`Runtime melaporkan ${symbol} tidak terdefinisi, tetapi source surface saat ini memiliki definisi ${symbol}; penyebab runtime belum terbukti dan harus ditelusuri pada execution context.`,
      evidenceIds:unique([...calls.map(e=>e.id), ...defs.map(e=>e.id), ...nerveUnresolved.map(e=>e.id)]),
      nodeIds:unique([...calls.map(e=>e.metadata?.file), ...defs.map(e=>e.metadata?.file)]),
      causal:false
    });
  }

  if (nerveUnresolved.length && symbol && !calls.length && !defs.length) {
    hs.push({
      id:`H-NERVE-UNRESOLVED-${symbol}`,
      statement:`BCGO nerve menandai simbol ${symbol} belum terverifikasi; source probe diperlukan sebelum causal root cause dapat dinyatakan.`,
      evidenceIds:unique(nerveUnresolved.map(e=>e.id)),
      nodeIds:unique(nerveUnresolved.map(e=>e.metadata?.file)),
      causal:false
    });
  }

  for (const sym of symbols.slice(1)) {
    const scalls = ev.filter(e => e.type === "SYMBOL_CALL_SITE" && e.metadata?.symbol === sym);
    const sdefs = ev.filter(e => e.type === "SYMBOL_DEFINITION" && e.metadata?.symbol === sym);
    const sabs = ev.filter(e => e.type === "SYMBOL_DEFINITION_ABSENCE" && e.metadata?.symbol === sym);
    if (sourceSurfaceComplete && scalls.length && !sdefs.length && sabs.length) {
      hs.push({
        id:`H-SYMBOL-MISSING-${sym}`,
        statement:`Simbol ${sym} dipanggil pada runtime/source target tetapi tidak memiliki definisi pada seluruh source surface yang berhasil diverifikasi.`,
        evidenceIds:unique([...scalls.map(e=>e.id), ...sabs.map(e=>e.id)]),
        nodeIds:unique([...scalls.map(e=>e.metadata?.file), ...sabs.map(e=>e.metadata?.file)]),
        causal:true
      });
    } else if (scalls.length && sdefs.length && !sabs.length) {
      hs.push({
        id:`H-SYMBOL-RUNTIME-CONTEXT-${sym}`,
        statement:`Runtime melaporkan ${sym} tidak terdefinisi, tetapi source surface saat ini memiliki definisi ${sym}; penyebab runtime belum terbukti dan harus ditelusuri pada execution context.`,
        evidenceIds:unique([...scalls.map(e=>e.id), ...sdefs.map(e=>e.id)]),
        nodeIds:unique([...scalls.map(e=>e.metadata?.file), ...sdefs.map(e=>e.metadata?.file)]),
        causal:false
      });
    }
  }

  const moduleBoundary = symbol && calls.some(e=>
    normalizeFile(e.metadata?.file)===normalizeFile(caseData?.target) &&
    /(?:onclick|onchange|onsubmit|oninput|onload)\s*=/.test(String(e.metadata?.snippet||""))
  ) && defs.length && scripts.some(e=>{
    const src = normalizeFile(e.metadata?.src);
    const isModule = String(e.metadata?.type||"").toLowerCase()==="module";
    return isModule && src && defs.some(d=>normalizeFile(d.metadata?.file)===normalizeFile(src));
  });
  if (moduleBoundary) {
    hs.push({
      id:`H-SYMBOL-MODULE-BOUNDARY-${symbol}`,
      statement:`Simbol ${symbol} didefinisikan di dalam module script dan dipanggil dari inline HTML handler; module scope tidak mengekspos fungsi tersebut ke global scope yang dibutuhkan handler.`,
      evidenceIds:unique([...calls.map(e=>e.id), ...defs.map(e=>e.id), ...scripts.map(e=>e.id)]),
      nodeIds:unique([...calls.map(e=>e.metadata?.file), ...defs.map(e=>e.metadata?.file), ...scripts.map(e=>e.metadata?.file)]),
      causal:true
    });
  }
  const sourceFinding = nerveFindings.filter(e => /div|html|structure|syntax/i.test(String(e.metadata?.kind || "") + " " + String(e.claim || "")));
  if (sourceFinding.length) {
    hs.push({
      id:`H-SOURCE-FINDING-${normalizeFile(caseData?.target) || "TARGET"}`,
      statement:`Temuan source BCGO pada ${normalizeFile(caseData?.target) || "target"} perlu divalidasi langsung terhadap source aktual sebelum causal root cause dapat dinyatakan.`,
      evidenceIds:unique(sourceFinding.map(e=>e.id)),
      nodeIds:unique(sourceFinding.map(e=>e.metadata?.file)),
      causal:false
    });
  }

  if (dom.length) {
    hs.push({
      id:`H-HTML-STRUCTURE-${normalizeFile(caseData?.target) || "TARGET"}`,
      statement:`Struktur HTML target tidak seimbang pada elemen div dan dapat memutus struktur DOM yang diharapkan oleh runtime/UI.`,
      evidenceIds:unique(dom.map(e=>e.id)),
      nodeIds:unique(dom.map(e=>e.metadata?.file)),
      causal:true
    });
  }
  return hs;
}

function chooseProbe(engine, caseData, knowledge) {
  const s = engine.state;
  const symbols = symbolsFromCase(caseData);
  const symbol = symbols[0] || null;
  const target = normalizeFile(caseData?.target);
  const done = s.completedProbes;
  if (target && !done.has(`SOURCE_READ:${target}`)) return {type:"SOURCE_READ",file:target,score:1};
  for (const sym of symbols) {
    if (!done.has(`SYMBOL_CALLS:${sym}`)) return {type:"SYMBOL_CALLS",symbol:sym,score:.98};
    if (!done.has(`SYMBOL_DEFINITIONS:${sym}`)) return {type:"SYMBOL_DEFINITIONS",symbol:sym,score:.97};
    if (!done.has(`SYMBOL_IMPORTS_EXPORTS:${sym}`)) return {type:"SYMBOL_IMPORTS_EXPORTS",symbol:sym,score:.92};
    if (!done.has(`SCRIPT_LOADING:${sym}`)) return {type:"SCRIPT_LOADING",file:target,symbol:sym,score:.88};
    if (caseData?.hypotheses?.some(h => h.id === `H-SYMBOL-RUNTIME-CONTEXT-${sym}`) && !done.has(`RUNTIME_CONTEXT:${sym}`)) return {type:"RUNTIME_CONTEXT",file:target,symbol:sym,score:.90};
  }
  if (!done.has(`HTML_STRUCTURE:${target}`)) return {type:"HTML_STRUCTURE",file:target,score:.84};

  const ranked = Investigator.rankProbes({visitedNodes:[...s.visitedNodes]},caseData,knowledge);
  const next = ranked.find(p => !done.has(`DEPENDENCY_TRACE:${p.nodeId}`));
  if (next) return {...next, type:"DEPENDENCY_TRACE"};
  return {type:"ROOT_CAUSE_PROOF",score:.5,reason:"All deterministic source probes currently available have been exhausted; causal proof must be evaluated from accumulated evidence."};
}

export function createInvestigationEngine(caseData, knowledge={}, options={}) {
  const state = {
    version:VERSION,
    investigationId:options.investigationId || `inv_active_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
    caseId:caseData?.caseId || null,
    status:"ACTIVE",
    cycle:0,
    maxSteps:Number.isFinite(options.maxSteps) ? Math.max(1,Math.min(30,options.maxSteps)) : MAX_STEPS_DEFAULT,
    completedProbes:new Set(),
    visitedNodes:new Set(),
    probeLog:[],
    events:[],
    startedAt:now(),
    updatedAt:now()
  };

  function snapshot() {
    return {
      ...state,
      completedProbes:[...state.completedProbes],
      visitedNodes:[...state.visitedNodes]
    };
  }

  async function probe(probeRequest, currentCase, provider) {
    const type=probeRequest.type;
    if(!provider || typeof provider.readSource!=="function") throw new Error("INTERNAL_PROBE_PROVIDER_REQUIRED");
    const files = typeof provider.listFiles === "function" ? await provider.listFiles() : [normalizeFile(currentCase?.target)].filter(Boolean);
    const sourceFiles = unique(files.map(normalizeFile)).slice(0, options.maxFiles || MAX_FILES_DEFAULT);
    const read = async file => {
      const out = await provider.readSource(file);
      if(!out || typeof out.source !== "string") throw new Error(`SOURCE_READ_FAILED:${file}`);
      return {...out,file:normalizeFile(out.file || file)};
    };

    if(type === "SOURCE_READ") {
      const r=await read(probeRequest.file);
      return {
        evidence:[makeEvidence(`PROBE-SOURCE-${r.file}-${r.fingerprint || Core.contentFingerprint(r.source)}`,{
          type:"SOURCE_SNAPSHOT", source:r.file,file:r.file,fingerprint:r.fingerprint || Core.contentFingerprint(r.source),
          claim:`Source aktual ${r.file} berhasil dibaca dan diikat dengan fingerprint ${r.fingerprint || Core.contentFingerprint(r.source)}.`,
          metadata:{lines:String(r.source).split("\n").length,bytes:String(r.source).length}
        })],
        source:r
      };
    }

    if(type === "SYMBOL_CALLS" || type === "SYMBOL_DEFINITIONS" || type === "SYMBOL_IMPORTS_EXPORTS") {
      const all=[];
      for(const file of sourceFiles){
        const r=await read(file);
        const hits=type === "SYMBOL_CALLS" ? findSymbolHits(r.source,file,probeRequest.symbol).filter(h=>h.call || h.handler || !h.definition)
          : type === "SYMBOL_DEFINITIONS" ? findDefinitions(r.source,file,probeRequest.symbol)
          : findImportsExports(r.source,file,probeRequest.symbol);
        for(const h of hits) all.push({...h,sourceFingerprint:r.fingerprint || Core.contentFingerprint(r.source)});
      }
      if(type === "SYMBOL_DEFINITIONS" && !all.length && provider.sourceSurfaceComplete === true) {
        return {evidence:[makeEvidence(`PROBE-SYMBOL-ABSENCE-${probeRequest.symbol}`,{
          type:"SYMBOL_DEFINITION_ABSENCE",source:"CGO_SOURCE_SURFACE",file:currentCase.target,
          claim:`Tidak ditemukan definisi ${probeRequest.symbol} pada ${sourceFiles.length} source yang berhasil dibaca oleh probe internal.`,
          exact:true,strength:1,metadata:{symbol:probeRequest.symbol,scannedFiles:sourceFiles.length,files:sourceFiles}
        })]};
      }
      const typeName=type === "SYMBOL_CALLS" ? "SYMBOL_CALL_SITE" : type === "SYMBOL_DEFINITIONS" ? "SYMBOL_DEFINITION" : "SYMBOL_IMPORT_EXPORT";
      return {evidence:all.slice(0,80).map((h,i)=>makeEvidence(`PROBE-${typeName}-${probeRequest.symbol}-${normalizeFile(h.file)}-${h.line}-${i}`,{
        type:typeName,source:h.file,file:h.file,claim:type === "SYMBOL_CALLS"
          ? `Source ${h.file}:${h.line} memanggil/mereferensikan simbol ${probeRequest.symbol}.`
          : type === "SYMBOL_DEFINITIONS"
            ? `Definisi simbol ${probeRequest.symbol} ditemukan pada ${h.file}:${h.line}.`
            : `Import/export yang terkait dengan ${probeRequest.symbol} ditemukan pada ${h.file}:${h.line}.`,
        exact:true,strength:1,fingerprint:h.sourceFingerprint,metadata:{symbol:probeRequest.symbol,line:h.line,snippet:h.snippet}
      }))};
    }

    if(type === "SCRIPT_LOADING") {
      const r=await read(probeRequest.file);
      const tags=scriptTags(r.source,r.file);
      return {evidence:tags.map((h,i)=>makeEvidence(`PROBE-SCRIPT-${r.file}-${h.line}-${i}`,{
        type:"SCRIPT_LOADING_CONTEXT",source:r.file,file:r.file,
        claim:`Script loading context ditemukan pada ${r.file}:${h.line}${h.src ? `; src=${h.src}` : "; inline script"}.`,
        exact:true,strength:1,fingerprint:r.fingerprint || Core.contentFingerprint(r.source),metadata:h
      }))};
    }

    if(type === "RUNTIME_CONTEXT") {
      const r=await read(probeRequest.file);
      const tags=scriptTags(r.source,r.file);
      const symbol=String(probeRequest.symbol || "").trim();
      const hits=findSymbolHits(r.source,r.file,symbol);
      const defs=findDefinitions(r.source,r.file,symbol);
      const contextEvidence=[];
      for (const d of defs) {
        const line=Number(d.line||1);
        const lines=String(r.source).split("\n");
        const start=Math.max(0,line-40), end=Math.min(lines.length,line+10);
        const nearby=lines.slice(start,end).join("\n");
        const moduleLikely=tags.some(t=>String(t.type||"").toLowerCase()==="module" && Number(t.line||0)<=line);
        const globalAssign=new RegExp(`(?:window|globalThis)\\.${escapeRegExp(symbol)}\\s*=`).test(nearby);
        contextEvidence.push(makeEvidence(`PROBE-RUNTIME-CONTEXT-${symbol}-${d.line}`,{
          type:"RUNTIME_CONTEXT_ANALYSIS",source:r.file,file:r.file,
          claim:`Definisi ${symbol} ditemukan pada ${r.file}:${line}; konteks script=${moduleLikely?"MODULE_OR_MODULE_NEARBY":"CLASSIC_OR_UNKNOWN"}, explicitGlobalAssignment=${globalAssign}.`,
          exact:true,strength:.8,fingerprint:r.fingerprint || Core.contentFingerprint(r.source),
          metadata:{symbol,line,moduleLikely,globalAssignment:globalAssign,scriptTags:tags.slice(0,30),proofRequired:true}
        }));
      }
      return {evidence:contextEvidence};
    }

    if(type === "HTML_STRUCTURE") {
      const r=await read(probeRequest.file);
      const signals=structuralSignals(r.source,r.file);
      return {evidence:signals.map((h,i)=>makeEvidence(`PROBE-STRUCTURE-${r.file}-${h.line}-${i}`,{
        type:h.type,source:r.file,file:r.file,claim:h.claim,exact:true,strength:1,
        fingerprint:r.fingerprint || Core.contentFingerprint(r.source),metadata:{line:h.line}
      }))};
    }

    if(type === "EXACT_SOURCE_CONTEXT") {
      const call=currentCase.evidence.find(e=>e.type==="SYMBOL_CALL_SITE" && e.status==="VERIFIED" && e.exact);
      if(!call) return {evidence:[]};
      const r=await provider.readSource(call.source);
      const lines=String(r.source).split("\n");
      const line=Number(call.metadata?.line || 1);
      const originalCode=lines[Math.max(0,line-1)] || "";
      if(!originalCode.trim()) return {evidence:[]};
      return {source:r, evidence:[]};
    }

    if(type === "DEPENDENCY_TRACE") {
      const nodeId=probeRequest.nodeId;
      state.visitedNodes.add(nodeId);
      const node=(knowledge.nodes||[]).find(n=>n.id===nodeId);
      const dependents=(knowledge.edges||[]).filter(e=>e.from===nodeId || e.to===nodeId).slice(0,20);
      return {evidence:[makeEvidence(`PROBE-DEPENDENCY-${nodeId}-${state.cycle}`,{
        type:"DEPENDENCY_TRACE",source:node?.name || nodeId,file:node?.name || null,
        claim:`Dependency trace untuk ${node?.name || nodeId} menemukan ${dependents.length} relasi terdaftar pada Knowledge Graph.`,
        exact:false,strength:Math.min(1,dependents.length ? .9 : .55),metadata:{nodeId,relations:dependents.map(e=>({id:e.id,from:e.from,to:e.to,type:e.type,status:e.status}))}
      })]};
    }

    return {evidence:[]};
  }

  async function step(currentCase, provider, knowledgeOverride=knowledge) {
    if(!currentCase) throw new Error("CASE_REQUIRED");
    if(state.status !== "ACTIVE") return {caseData:clone(currentCase), investigation:snapshot(), progress:false};
    if(state.cycle >= state.maxSteps) { state.status="LIMIT_REACHED"; return {caseData:clone(currentCase),investigation:snapshot(),progress:false}; }

    const request=chooseProbe({state},currentCase,knowledgeOverride);
    const key=`${request.type}:${request.symbol || request.file || request.nodeId || "ROOT"}`;
    if(state.completedProbes.has(key)) {
      state.status="STABLE";
      return {caseData:clone(currentCase),investigation:snapshot(),progress:false,probe:request};
    }

    state.cycle++;
    const started=now();
    const result=await probe(request,currentCase,provider);
    let nextCase=clone(currentCase);
    if(result.evidence?.length) nextCase=Core.ingestEvidence(nextCase,result.evidence);
    const context={symbols:symbolsFromCase(nextCase),symbol:symbolFromCase(nextCase),sourceSurfaceComplete:provider.sourceSurfaceComplete===true};
    const hypotheses=buildHypotheses(nextCase,context);
    if(hypotheses.length && nextCase.state!=="ROOT_CAUSE_VERIFIED" && nextCase.state!=="SOURCE_VERIFIED")
      nextCase=Core.reason(nextCase,hypotheses).caseData;

    // Causal proof is attempted only after the engine has actually collected the
    // evidence required by the selected hypothesis. This is not a confidence
    // shortcut: Core.verifyRootCause performs the binding/score/independence gates.
    const selected=nextCase.selectedHypothesis;
    if(!nextCase.rootCause && selected?.causal === true && Number(selected.score)>=0.60 && Array.isArray(selected.evidenceIds) && selected.evidenceIds.length>=2){
      try {
        nextCase=Core.verifyRootCause(nextCase,{
          statement:selected.statement,
          hypothesisId:selected.id,
          evidenceIds:selected.evidenceIds
        });
      } catch {}
    }

    // Once causal proof exists, bind the exact runtime/source location from the
    // verified call-site evidence. The original source line is fetched again so
    // the binding is against the real current source, not a remembered snippet.
    if(nextCase.rootCause && !nextCase.exactSource) {
      const call=nextCase.evidence.find(e=>e.type==="SYMBOL_CALL_SITE" && e.status==="VERIFIED" && e.exact);
      if(call) {
        try {
          const r=await provider.readSource(call.source);
          const lineText=String(r.source).split("\n")[Math.max(0,Number(call.metadata?.line||1)-1)] || "";
          const symbol = String(call.metadata?.symbol || symbolFromCase(nextCase) || "").trim();
          const callMatch = symbol ? lineText.match(new RegExp(`\\b${escapeRegExp(symbol)}\\s*\\([^\\n;]*\\)`)) : null;
          const originalCode = callMatch?.[0] || lineText;
          if(originalCode.trim()) {
            const fp=Core.contentFingerprint(originalCode);
            const ids=nextCase.rootCause.evidenceIds.filter(id=>id===call.id || nextCase.evidence.some(e=>e.id===id && e.metadata?.file===call.source));
            if(ids.length) nextCase=Core.verifyExactSource(nextCase,{
              file:call.source, originalCode, proposedCode:null, operation:"REPLACE_EXACT",
              fingerprint:fp, contentFingerprint:fp, sourceFingerprint:r.fingerprint || Core.contentFingerprint(r.source), evidenceIds:ids
            });
          }
        } catch {}
      }
    }

    state.completedProbes.add(key);
    if(request.nodeId) state.visitedNodes.add(request.nodeId);
    state.probeLog.push({cycle:state.cycle,type:request.type,key,score:request.score||0,evidenceIds:(result.evidence||[]).map(e=>e.id),startedAt:started,completedAt:now()});
    state.events.push({type:"PROBE_EXECUTED",cycle:state.cycle,probe:request,evidenceCount:(result.evidence||[]).length,at:now()});
    state.updatedAt=now();

    const stopStates=new Set(["SOURCE_VERIFIED","CANDIDATE_READY","EXECUTOR_REVIEW","HUMAN_APPROVAL","EXECUTING","VALIDATING","RESOLVED","INVESTIGATION_BLOCKED"]);
    if(stopStates.has(nextCase.state)) state.status="COMPLETE";
    return {caseData:nextCase,investigation:snapshot(),progress:true,probe:request,evidence:result.evidence||[],source:result.source||null};
  }

  async function run(currentCase, provider, knowledgeOverride=knowledge, optionsOverride={}) {
    let c=clone(currentCase);
    const maxSteps=Number.isFinite(optionsOverride.maxSteps)?Math.max(1,Math.min(30,optionsOverride.maxSteps)):state.maxSteps;
    let steps=0;
    const trace=[];
    while(state.status === "ACTIVE" && steps<maxSteps) {
      const out=await step(c,provider,knowledgeOverride);
      c=out.caseData;
      trace.push(out);
      steps++;
      if (typeof optionsOverride.onStep === "function") {
        try { await optionsOverride.onStep(clone(out), steps); } catch {}
      }
      const evalLike = c.rootCause && c.exactSource;
      if(evalLike || state.status !== "ACTIVE" || !out.progress) break;
    }
    if(state.status === "ACTIVE" && steps>=maxSteps) state.status="YIELD";
    return {caseData:c,investigation:snapshot(),trace,steps,status:state.status};
  }

  return {version:VERSION,state,snapshot,step,run};
}

export { VERSION };
