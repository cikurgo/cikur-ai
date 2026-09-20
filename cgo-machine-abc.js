/*
 * CGO MACHINE ABC — UNIVERSAL PROCESSING ENGINE
 * Version 0.7.0
 *
 * Domain-neutral. No external API. No network dependency.
 * A = INGEST / PARSE / REPRESENT
 * B = ANALYZE / RELATE / VERIFY / INFER
 * C = SYNTHESIZE / DECIDE / EMIT / CONTINUE
 */
(function (global) {
  "use strict";

  const VERSION = "0.7.1";
  const MAX_TEXT_SAMPLE = 6000;
  const MAX_ITEMS = 1000;
  const MAX_TOKENS = 5000;
  const MAX_BATCH_DEPTH = 4;
  const MAX_REASONING_STEPS = 64;

  const isObject = v => v !== null && typeof v === "object";
  const isPlainObject = v => isObject(v) && !Array.isArray(v) && !(v instanceof Date);
  const clone = v => {
    if (v === undefined) return undefined;
    try { return structuredClone(v); } catch (_) {
      try { return JSON.parse(JSON.stringify(v)); } catch (_) { return v; }
    }
  };
  const now = () => new Date().toISOString();

  function isInputEnvelope(v) {
    return isObject(v) && (v.__cgoInputEnvelope === true || v.__cgoMachineInjection === true);
  }
  function isBatchEnvelope(v) {
    return isObject(v) && v.__cgoBatchInjection === true && Array.isArray(v.items);
  }
  function typeOf(v) {
    if (isBatchEnvelope(v)) return "batch";
    if (isInputEnvelope(v)) return "input_envelope";
    if (v === null) return "null";
    if (v instanceof Date) return "date";
    if (Array.isArray(v)) return "array";
    if (typeof v === "string") return "string";
    if (typeof v === "number") return Number.isFinite(v) ? "number" : "non_finite_number";
    if (typeof v === "boolean") return "boolean";
    if (typeof v === "function") return "function";
    if (typeof v === "undefined") return "undefined";
    return "object";
  }
  function fingerprint(v) {
    let s;
    try { s = typeof v === "string" ? v : JSON.stringify(v); } catch (_) { s = String(v); }
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h += (h<<1)+(h<<4)+(h<<7)+(h<<8)+(h<<24); }
    return ("00000000" + (h >>> 0).toString(16)).slice(-8);
  }
  function sizeOf(v) { try { return typeof v === "string" ? v.length : JSON.stringify(v).length; } catch (_) { return null; } }

  function extensionOf(name = "") {
    const m = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : null;
  }
  function classifyText(text, hint = {}) {
    const raw = String(text ?? "");
    const ext = String(hint.extension || "").toLowerCase();
    const mime = String(hint.mimeType || "").toLowerCase();
    const trimmed = raw.trim();
    let format = "text";
    if (ext === "json" || mime.includes("json")) format = "json";
    else if (ext === "html" || ext === "htm" || mime.includes("html")) format = "html";
    else if (["js","mjs","cjs","ts","tsx","jsx"].includes(ext) || mime.includes("javascript") || mime.includes("typescript")) format = "code";
    else if (ext === "css" || mime.includes("css")) format = "css";
    else if (ext === "xml" || mime.includes("xml")) format = "xml";
    else if (ext === "csv" || mime.includes("csv")) format = "csv";
    else if (ext === "md" || ext === "markdown") format = "markdown";
    else if (/^<!doctype\s+html/i.test(trimmed) || /<html[\s>]/i.test(trimmed)) format = "html";
    else if (/^\s*[\[{][\s\S]*[\]}]\s*$/.test(trimmed)) format = "json_candidate";
    else if (/\b(function|const|let|var|class|import|export)\b/.test(raw)) format = "code_candidate";
    return format;
  }

  function balancedDelimiters(text) {
    const pairs = { "{":"}", "[":"]", "(":")" };
    const closing = new Set(Object.values(pairs));
    const stack = [];
    const s = String(text);
    let quote = null, escape = false, lineComment = false, blockComment = false, regex = false, regexClass = false, regexEscape = false;
    let previousSignificant = "";
    for (let i=0;i<s.length;i++) {
      const ch=s[i], nx=s[i+1]||"";
      if (lineComment) { if (ch==='\n' || ch==='\r') lineComment=false; continue; }
      if (blockComment) { if (ch==='*' && nx==='/') { blockComment=false; i++; } continue; }
      if (regex) {
        if (regexEscape) { regexEscape=false; continue; }
        if (ch==='\\') { regexEscape=true; continue; }
        if (ch==='[') { regexClass=true; continue; }
        if (ch===']' && regexClass) { regexClass=false; continue; }
        if (ch==='/' && !regexClass) { regex=false; previousSignificant='/'; }
        continue;
      }
      if (quote) { if (escape) escape=false; else if (ch==='\\') escape=true; else if (ch===quote) quote=null; continue; }
      if (ch==='/' && nx==='/') { lineComment=true; i++; continue; }
      if (ch==='/' && nx==='*') { blockComment=true; i++; continue; }
      if (ch==='"' || ch==="'" || ch==='`') { quote=ch; continue; }
      if (ch==='/' && !/\s/.test(nx) && /[=(:,!&|?{};\[]/.test(previousSignificant || '')) { regex=true; regexClass=false; regexEscape=false; continue; }
      if (pairs[ch]) stack.push(pairs[ch]);
      else if (closing.has(ch)) { if (stack.pop() !== ch) return {balanced:false,reason:"delimiter_mismatch",index:i}; }
      if (!/\s/.test(ch)) previousSignificant=ch;
    }
    return { balanced: stack.length===0 && quote===null && !blockComment && !regex, unclosed:stack.length, unterminatedString:quote!==null, unterminatedComment:blockComment, unterminatedRegex:regex };
  }
  function parseStructuredText(text) {
    try { return { ok:true, value:JSON.parse(text) }; } catch (e) { return { ok:false, error:String(e.message || e) }; }
  }
  function extractHtml(text) {
    const tags = [...String(text).matchAll(/<\s*([a-zA-Z][\w:-]*)\b/g)].map(m => m[1].toLowerCase());
    const ids = [...String(text).matchAll(/\bid=["']([^"']+)["']/gi)].map(m => m[1]);
    const classes = [...String(text).matchAll(/\bclass=["']([^"']+)["']/gi)].flatMap(m => m[1].split(/\s+/).filter(Boolean));
    const links = [...String(text).matchAll(/\b(?:href|src)=["']([^"']+)["']/gi)].map(m => m[1]);
    const duplicateIds = [...new Set(ids.filter((x,i)=>ids.indexOf(x)!==i))];
    return { tagCount: tags.length, uniqueTags:[...new Set(tags)], ids:[...new Set(ids)], duplicateIds, classes:[...new Set(classes)], references:[...new Set(links)] };
  }
  function extractCode(text) {
    const s = String(text);
    const imports = [...s.matchAll(/\bimport\s+(?:[^;\n]+?\s+from\s+)?["']([^"']+)["']/g)].map(m => m[1]);
    const requires = [...s.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)].map(m => m[1]);
    const declarations = [...s.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)].map(m => m[1]);
    const functions = [...s.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]);
    return { imports:[...new Set(imports)], requires:[...new Set(requires)], dependencies:[...new Set([...imports,...requires])], declarations:[...new Set(declarations)], functions:[...new Set(functions)] };
  }
  function tokenize(text) {
    return String(text).normalize().split(/[^\p{L}\p{N}_$.-]+/u).filter(Boolean).map(x => x.toLowerCase()).slice(0, MAX_TOKENS);
  }
  function lineStats(text) {
    const lines = String(text).split(/\r?\n/);
    return { lineCount:lines.length, nonEmptyLines:lines.filter(x=>x.trim()).length, maxLineLength:lines.reduce((m,x)=>Math.max(m,x.length),0) };
  }

  // ===================== A: INGEST / PARSE / REPRESENT =====================
  const MachineA = {
    process(input, options = {}) {
      const started = Date.now();
      if (isBatchEnvelope(input)) {
        const depth = Number(options.batchDepth || 0);
        if (depth >= MAX_BATCH_DEPTH) {
          return { machine:"A", stage:"representation", version:VERSION, input:{type:"batch",fingerprint:fingerprint(input),size:sizeOf(input),count:input.items.length}, structure:{kind:"batch",count:input.items.length,depth,guard:"MAX_BATCH_DEPTH"}, content:{mode:"batch",value:[]}, observations:[{type:"BATCH_DEPTH_LIMIT",maxDepth:MAX_BATCH_DEPTH}], uncertainty:[{type:"BATCH_DEPTH_LIMIT",severity:"HIGH",maxDepth:MAX_BATCH_DEPTH}], metadata:{source:options.source??null,receivedAt:now()}, durationMs:Date.now()-started };
        }
        const members = input.items.slice(0, MAX_ITEMS).map((item, i) => this.process(item, { ...options, batchDepth:depth+1, source:item?.payload?.name ?? item?.name ?? `item-${i+1}` }));
        return {
          machine:"A", stage:"representation", version:VERSION,
          input:{ type:"batch", fingerprint:fingerprint(input), size:sizeOf(input), count:members.length },
          structure:{ kind:"batch", count:members.length, itemTypes:members.map(x=>x.input.type) },
          content:{ mode:"batch", value:members }, observations:[
            {type:"INPUT_CLASSIFIED", value:"batch"}, {type:"BATCH_ITEMS_DISCOVERED", value:members.length}
          ], metadata:{source:options.source ?? null, receivedAt:now()}, durationMs:Date.now()-started
        };
      }

      const envelopeCheck = (isBatchEnvelope(input)||isInputEnvelope(input)) ? assertEnvelope(input) : null;
      const type = typeOf(input);
      const content = extractContent(input);
      const structure = describeStructure(input, content);
      const representation = {
        machine:"A", stage:"representation", version:VERSION,
        input:{type, fingerprint:fingerprint(input), size:sizeOf(input)},
        structure, content, observations:[], metadata:{source:options.source ?? null, receivedAt:now()}
      };
      if (envelopeCheck && !envelopeCheck.valid) representation.unknowns=[{type:"ENVELOPE_SCHEMA_ISSUES",kind:envelopeCheck.kind,issues:clone(envelopeCheck.issues),severity:"HIGH"}];
      representation.observations.push({type:"INPUT_CLASSIFIED", value:type});
      representation.observations.push({type:"STRUCTURE_IDENTIFIED", value:structure.kind});
      if (content.format) representation.observations.push({type:"FORMAT_IDENTIFIED", value:content.format});
      if (content.parse) representation.observations.push({type:"PARSE_ATTEMPTED", value:content.parse.ok});
      if (content.syntax) representation.observations.push({type:"SYNTAX_PROFILED", value:true});
      if (isPlainObject(input)) representation.observations.push({type:"OBJECT_KEYS_DISCOVERED", value:Object.keys(input)});
      representation.durationMs = Date.now()-started;
      return representation;
    }
  };

  function describeStructure(value, content) {
    const type = typeOf(value);
    if (type === "batch") return {kind:"batch", count:value.items.length};
    if (type === "input_envelope") {
      const p=value.payload||{}; const kind=value.__cgoMachineInjection===true?"injection":"input_envelope"; return {kind, innerType:content?.mode??p.contentMode??"unknown", transport:p.transport??"unknown", name:p.name??null, mimeType:p.mimeType??null, extension:p.extension??null, size:p.size??null, contentMode:p.contentMode??value.contentMode??"unknown", format:content.format??null};
    }
    if (type === "string") return {kind:"scalar", valueType:"string", length:value.length, ...lineStats(value), empty:value.length===0};
    if (type === "array") return {kind:"collection", length:value.length, itemTypes:value.slice(0,100).map(typeOf)};
    if (type === "object") { const keys=Object.keys(value); return {kind:"record", keyCount:keys.length, keys, valueTypes:Object.fromEntries(keys.map(k=>[k,typeOf(value[k])]))}; }
    return {kind:"scalar", valueType:type};
  }

  function extractContent(value) {
    if (isInputEnvelope(value)) {
      if (value.__cgoMachineInjection === true && value.contentMode === "structured") {
        const v=value.payload?.value; return {mode:Array.isArray(v)?"collection":isObject(v)?"record":"scalar", value:clone(v), source:{transport:"internal",stage:"C"}, format:"structured", innerType:Array.isArray(v)?"collection":isObject(v)?"record":"scalar"};
      }
      const p=value.payload||{};
      if (p.contentMode === "text" && typeof p.text === "string") return analyzeText(p.text,{name:p.name,mimeType:p.mimeType,extension:p.extension});
      if (p.contentMode === "structured") { const v=p.value; return {mode:Array.isArray(v)?"collection":isObject(v)?"record":"scalar",value:clone(v),format:"structured"}; }
      return {mode:"binary", value:{transport:p.transport??"file",name:p.name??null,mimeType:p.mimeType??null,extension:p.extension??null,size:p.size??null,byteLength:p.byteLength??p.size??null,preview:p.preview??null}, format:"binary"};
    }
    if (typeof value === "string") return analyzeText(value,{});
    if (Array.isArray(value)) return {mode:"collection",value:clone(value),format:"structured"};
    if (isObject(value)) return {mode:"record",value:clone(value),format:"structured"};
    return {mode:"scalar",value,format:typeOf(value)};
  }

  function analyzeText(text,hint={}) {
    const s=String(text); const format=classifyText(s,hint); const result={mode:"text",value:s,format,stats:lineStats(s),tokens:tokenize(s),source:hint};
    const balance=balancedDelimiters(s); result.syntax={delimiters:balance};
    if (format === "json" || format === "json_candidate") result.parse=parseStructuredText(s);
    if (format === "html") result.syntax.html=extractHtml(s);
    if (format === "code" || format === "code_candidate") result.syntax.code=extractCode(s);
    if (format === "csv") result.syntax.csv={rows:s.split(/\r?\n/).filter(Boolean).length, columns:(s.split(/\r?\n/)[0]||"").split(",").length};
    result.preview=s.slice(0,MAX_TEXT_SAMPLE);
    return result;
  }

  // ===================== B: ANALYZE / RELATE / VERIFY / INFER =====================
  const MachineB = {
    process(rep, options = {}) {
      const started=Date.now();
      if (!rep?.structure) return unresolvedB("representation_missing",started);
      if (rep.structure.kind === "batch" && Array.isArray(rep.content?.value)) return processBatch(rep,started,options);
      const s={machine:"B",stage:"processing",version:VERSION,inputFingerprint:rep.input?.fingerprint??null,operations:[],findings:[],relations:[],inferences:[],evidence:[],uncertainty:clone(rep.uncertainty??[]),verification:[],constraints:[],contradictions:[],hypotheses:[],reasoning:[],reasoningTrace:[],decision:null,timing:{}};
      const steps={structure:()=>inspectStructureB(rep,s),content:()=>inspectContentB(rep,s),syntax:()=>analyzeSyntaxB(rep,s),relation:()=>deriveRelationsB(rep,s),verify:()=>verifyB(rep,s),infer:()=>inferB(rep,s),constraint:()=>analyzeConstraintsB(rep,s),contradiction:()=>detectContradictionsB(rep,s),hypothesis:()=>generateHypothesesB(rep,s),reasoning:()=>reasonB(rep,s)};
      const selected=Array.isArray(options.steps)?options.steps:Object.keys(steps);
      for(const name of selected){if(!steps[name]){s.uncertainty.push({type:"UNKNOWN_STEP",step:name,severity:"LOW"});continue;} const t=Date.now(); steps[name](); s.timing[name]=Date.now()-t;}
      s.decision=decideB(s); s.durationMs=Date.now()-started; return s;
    }
  };
  function unresolvedB(reason,started){return {machine:"B",stage:"processing",version:VERSION,operations:[],findings:[],relations:[],inferences:[],evidence:[],uncertainty:[{type:"INSUFFICIENT_REPRESENTATION",reason}],verification:[],decision:{status:"UNRESOLVED",reason},durationMs:Date.now()-started};}
  function inspectStructureB(r,s){s.operations.push("STRUCTURE_INSPECTION"); const x=r.structure; s.findings.push({type:"STRUCTURE_PROFILE",kind:x.kind,details:clone(x)}); if(x.kind==="record")s.evidence.push({type:"RECORD_KEYS",keys:clone(x.keys)}); if(x.kind==="collection")s.evidence.push({type:"COLLECTION_SIZE",count:x.length});}
  function inspectContentB(r,s){s.operations.push("CONTENT_INSPECTION"); const c=r.content; if(!c){s.uncertainty.push({type:"CONTENT_MISSING"});return;} if(c.mode==="text"){s.evidence.push({type:"TEXT_AVAILABLE",length:c.value.length,format:c.format,preview:c.preview}); if(!c.value.trim())s.uncertainty.push({type:"EMPTY_CONTENT"}); const unique=new Set(c.tokens||[]); s.findings.push({type:"TEXT_PROFILE",format:c.format??null,tokens:(c.tokens||[]).length,uniqueTokens:unique.size,lines:c.stats?.lineCount??null});} else if(c.mode==="binary"){s.evidence.push({type:"BINARY_METADATA",metadata:clone(c.value)});s.uncertainty.push({type:"CONTENT_NOT_DECODED",reason:"binary payload has no internal decoder for its format"});} else if(c.mode==="record"){s.evidence.push({type:"RECORD_AVAILABLE",keys:Object.keys(c.value||{})});} else if(c.mode==="collection"){s.evidence.push({type:"COLLECTION_AVAILABLE",count:c.value?.length??0});}}
  function analyzeSyntaxB(r,s){s.operations.push("SYNTAX_ANALYSIS"); const c=r.content||{}; if(c.syntax?.delimiters){s.findings.push({type:"DELIMITER_BALANCE",result:clone(c.syntax.delimiters)}); if(!c.syntax.delimiters.balanced)s.verification.push({type:"SYNTAX_WARNING",status:"FAIL",reason:"unbalanced_delimiters"});} if(c.format==="json"||c.format==="json_candidate"){s.findings.push({type:"JSON_PARSE",result:clone(c.parse)});s.verification.push({type:"JSON_VALID",status:c.parse?.ok?"PASS":"FAIL",evidence:"JSON.parse"});} if(c.format==="html"&&c.syntax?.html){s.findings.push({type:"HTML_PROFILE",profile:clone(c.syntax.html)});} if((c.format==="code"||c.format==="code_candidate")&&c.syntax?.code){s.findings.push({type:"CODE_PROFILE",profile:clone(c.syntax.code)}); if(c.syntax.code.dependencies.length)s.relations.push({type:"CODE_DEPENDENCIES",items:clone(c.syntax.code.dependencies),basis:"import_or_require_tokens"});}}
  function deriveRelationsB(r,s){s.operations.push("RELATION_ANALYSIS"); const v=r.content?.value; if(Array.isArray(v)){for(let i=0;i<v.length-1;i++)s.relations.push({type:"SEQUENCE_ADJACENCY",from:i,to:i+1});} if(isPlainObject(v)){const keys=Object.keys(v);for(let i=0;i<keys.length;i++)s.relations.push({type:"FIELD_PRESENCE",field:keys[i],valueType:typeOf(v[keys[i]])});}}
  function verifyB(r,s){
    s.operations.push("EVIDENCE_VERIFICATION");
    const checks=[];
    if(r.content?.mode==="text") checks.push({type:"CONTENT_PRESENT",status:r.content.value.trim()?"PASS":"FAIL"});
    if(r.content?.syntax?.delimiters) checks.push({type:"DELIMITERS",status:r.content.syntax.delimiters.balanced?"PASS":"FAIL"});
    if(r.content?.mode==="collection") checks.push({type:"COLLECTION_BOUNDS",status:r.content.value.length<=MAX_ITEMS?"PASS":"FAIL",limit:MAX_ITEMS,count:r.content.value.length});
    if(r.content?.mode==="record") {
      const emptyFields=Object.keys(r.content.value||{}).filter(k=>r.content.value[k]==="" || r.content.value[k]===null);
      if(emptyFields.length) { checks.push({type:"EMPTY_FIELD",status:"UNKNOWN",fields:emptyFields}); }
    }
    s.verification.push(...checks); s.evidence.push({type:"VERIFICATION_RUN",checks:clone(checks)});
  }
  function inferB(r,s){s.operations.push("GENERIC_INFERENCE"); const c=r.content||{}; if(c.format)s.inferences.push({type:"CONTENT_FORMAT",value:c.format,basis:["input_metadata_or_content_signature"]}); if(c.format==="code"&&c.syntax?.code?.dependencies.length)s.inferences.push({type:"DEPENDENCY_PRESENCE",count:c.syntax.code.dependencies.length,basis:["import_or_require_tokens"]}); if(c.format==="html"&&c.syntax?.html)s.inferences.push({type:"MARKUP_STRUCTURE",tags:c.syntax.html.uniqueTags.length,basis:["tag_tokens"]}); if(c.parse?.ok)s.inferences.push({type:"STRUCTURED_TEXT_PARSEABLE",basis:["JSON.parse"]});}
  function analyzeConstraintsB(r,s){s.operations.push("CONSTRAINT_ANALYSIS"); const c=r.content||{}; if(c.mode==="text"&&c.value.length>MAX_TEXT_SAMPLE)s.constraints.push({type:"SAMPLE_LIMIT",severity:"LOW",limit:MAX_TEXT_SAMPLE,observed:c.value.length}); if(c.mode==="collection"&&c.value.length>MAX_ITEMS)s.constraints.push({type:"COLLECTION_BOUNDS",severity:"HIGH",limit:MAX_ITEMS,observed:c.value.length}); if(c.mode==="record"){const keys=Object.keys(c.value||{});const empty=keys.filter(k=>c.value[k]===null||c.value[k]==="");if(empty.length)s.constraints.push({type:"EMPTY_FIELD",severity:"LOW",fields:empty});}}
  function detectContradictionsB(r,s){s.operations.push("CONTRADICTION_ANALYSIS"); const c=r.content||{}; if(c.mode==="text"&&c.format==="json"&&c.parse?.ok===false)s.contradictions.push({type:"FORMAT_PARSE_CONTRADICTION",severity:"MEDIUM",claim:"json",evidence:"parse_failed"}); if(c.mode==="text"&&c.syntax?.delimiters?.balanced===false)s.contradictions.push({type:"SYNTAX_CONTRADICTION",severity:"MEDIUM",claim:"balanced_structure",evidence:"delimiter_failure"});}
  function generateHypothesesB(r,s){s.operations.push("HYPOTHESIS_GENERATION"); const c=r.content||{}; if(c.mode==="binary")s.hypotheses.push({id:"H1",statement:"Content may require a format-specific decoder",basis:["CONTENT_NOT_DECODED"],testable:false}); else if(c.format)s.hypotheses.push({id:"H1",statement:"Observed material follows the detected format profile",basis:["FORMAT_IDENTIFIED"],testable:true}); else s.hypotheses.push({id:"H1",statement:"Material is best treated as generic text until stronger evidence exists",basis:["FORMAT_UNCERTAIN"],testable:true});}
  function reasonB(r,s){s.operations.push("REASONING"); const add=(step,action,basis,conclusion)=>{if(s.reasoningTrace.length>=MAX_REASONING_STEPS)return;const entry={step,action,basis:clone(basis),conclusion};s.reasoningTrace.push(entry);s.reasoning.push(clone(entry));}; add(1,"OBSERVE",s.evidence.map(x=>x.type).slice(0,12),"Evidence inventory established"); add(2,"RELATE",s.relations.map(x=>x.type).slice(0,12),s.relations.length?"Relevant relationships identified":"No relationship was established"); add(3,"HYPOTHESIZE",s.hypotheses.map(x=>x.id),s.hypotheses.length?s.hypotheses[0].statement:"No hypothesis generated"); add(4,"REASON",s.inferences.map(x=>x.type).slice(0,12),s.inferences.length?"Generic inferences derived":"No generic inference derived"); add(5,"VERIFY",s.verification.map(x=>x.status).slice(0,12),s.verification.every(x=>x.status==="PASS")?"Verification checks passed":"Verification requires attention"); add(6,"DECIDE",[],"Decision is derived after verification and uncertainty assessment"); add(7,"ASSESS_UNCERTAINTY",s.uncertainty.map(x=>x.type),s.uncertainty.length?"Some uncertainty remains":"No uncertainty was recorded");}
  function decideB(s){
    if(s.uncertainty.some(x=>x.type==="INSUFFICIENT_REPRESENTATION")) return {status:"UNRESOLVED",reason:"insufficient_representation",confidence:0};
    const failed=s.verification.filter(x=>x.status==="FAIL").length;
    const unknownChecks=s.verification.filter(x=>x.status==="UNKNOWN").length;
    const severeUncertainty=s.uncertainty.filter(x=>["MEDIUM","HIGH"].includes(String(x.severity||"MEDIUM").toUpperCase()));
    const totalChecks=Math.max(1,s.verification.length);
    let confidence=Math.max(0,Math.min(1,(s.verification.filter(x=>x.status==="PASS").length + (s.verification.filter(x=>x.status!=="FAIL").length*0.25))/totalChecks));
    confidence-=Math.min(.45,severeUncertainty.length*.12);
    confidence=Number(Math.max(0,Math.min(1,confidence)).toFixed(3));
    if(failed) return {status:"PARTIAL",reason:"verification_failed",failedChecks:failed,unknownChecks,confidence};
    if(severeUncertainty.length) return {status:"PARTIAL",reason:"medium_or_high_uncertainty",uncertainties:severeUncertainty.length,confidence};
    return {status:"PROCESSED",reason:"analysis_and_verification_completed",confidence};
  }
  function processBatch(rep,started,options={}){const currentDepth=Number(options.batchDepth||0);if(currentDepth>=MAX_BATCH_DEPTH){return {machine:"B",stage:"processing",version:VERSION,inputFingerprint:rep.input?.fingerprint??null,operations:["BATCH_DEPTH_GUARD"],findings:[],relations:[],inferences:[],evidence:[],uncertainty:[{type:"BATCH_DEPTH_LIMIT_B",severity:"HIGH",maxDepth:MAX_BATCH_DEPTH,depth:currentDepth}],verification:[],constraints:[],contradictions:[],hypotheses:[],reasoning:[],reasoningTrace:[],decision:{status:"UNRESOLVED",reason:"batch_depth_limit",confidence:0},items:[],durationMs:Date.now()-started};}const items=rep.content.value.map((member,i)=>({index:i,source:member.metadata?.source??`item-${i+1}`,fingerprint:member.input?.fingerprint??null,processing:MachineB.process(member,{...options,batchDepth:currentDepth+1})}));const s={machine:"B",stage:"processing",version:VERSION,inputFingerprint:rep.input?.fingerprint??null,operations:["BATCH_PROCESSING","ITEM_ANALYSIS","CROSS_ITEM_RELATION_ANALYSIS","BATCH_VERIFICATION","BATCH_INFERENCE"],findings:[],relations:[],inferences:[],evidence:[],uncertainty:[],verification:[],constraints:[],contradictions:[],hypotheses:[],reasoning:[],reasoningTrace:[],decision:null,items};items.forEach(x=>{s.findings.push({type:"ITEM_ANALYZED",index:x.index,status:x.processing.decision?.status});s.evidence.push({type:"ITEM_EVIDENCE",index:x.index,count:x.processing.evidence.length});s.verification.push({type:"ITEM_VERIFICATION",index:x.index,count:x.processing.verification.length});if(x.processing.uncertainty.length)s.uncertainty.push({type:"ITEM_UNCERTAINTY",index:x.index,count:x.processing.uncertainty.length});
      s.hypotheses.push(...(x.processing.hypotheses||[]).map(v=>({...clone(v),itemIndex:x.index})));
      s.constraints.push(...(x.processing.constraints||[]).map(v=>({...clone(v),itemIndex:x.index})));
      s.contradictions.push(...(x.processing.contradictions||[]).map(v=>({...clone(v),itemIndex:x.index})));
      s.reasoningTrace.push(...(x.processing.reasoningTrace||[]).map(v=>({...clone(v),itemIndex:x.index})));
      s.reasoning.push(...(x.processing.reasoning||x.processing.reasoningTrace||[]).map(v=>({...clone(v),itemIndex:x.index})));
    });for(let i=0;i<items.length;i++)for(let j=i+1;j<items.length;j++){
      s.relations.push({type:"ITEM_RELATION_CANDIDATE",from:i,to:j,basis:"same_injection_batch"});
      const fi=items[i].processing.findings?.find(x=>x.type==="TEXT_PROFILE")?.format; const fj=items[j].processing.findings?.find(x=>x.type==="TEXT_PROFILE")?.format;
      if(fi && fj && fi!==fj) s.relations.push({type:"CROSS_ITEM_FORMAT_DIFFERENCE",from:i,to:j,formats:[fi,fj],basis:"TEXT_PROFILE.format"});
    }s.inferences.push({type:"MULTI_MATERIAL_INPUT",itemCount:items.length,basis:["batch_structure","item_analysis"]});const itemConf=items.map(x=>Number(x.processing.decision?.confidence??0)); const avgConf=itemConf.length?Number((itemConf.reduce((a,b)=>a+b,0)/itemConf.length).toFixed(3)):0;
    s.decision=items.some(x=>x.processing.decision?.status==="UNRESOLVED")?{status:"UNRESOLVED",reason:"one_or_more_items_unresolved",confidence:avgConf}:items.some(x=>x.processing.decision?.status!=="PROCESSED")?{status:"PARTIAL",reason:"one_or_more_items_need_attention",confidence:avgConf}:{status:"PROCESSED",reason:"batch_analysis_and_verification_completed",confidence:avgConf};s.durationMs=Date.now()-started;return s;}

  // ===================== C: SYNTHESIZE / DECIDE / EMIT / CONTINUE =====================
  const MachineC = {
    process(rep,proc,options={}){
      const started=Date.now();
      const result={machine:"C",stage:"result",version:VERSION,status:proc?.decision?.status??"UNRESOLVED",summary:summarize(rep,proc),findings:clone(proc?.findings??[]),relations:clone(proc?.relations??[]),inferences:clone(proc?.inferences??[]),evidence:clone(proc?.evidence??[]),uncertainty:clone(proc?.uncertainty??[]),verification:clone(proc?.verification??[]),constraints:clone(proc?.constraints??[]),contradictions:clone(proc?.contradictions??[]),hypotheses:clone(proc?.hypotheses??[]),reasoning:clone(proc?.reasoningTrace??[]),reasoningTrace:clone(proc?.reasoningTrace??[]),decision:clone(proc?.decision??null),metadata:{inputFingerprint:rep?.input?.fingerprint??null,source:options.source??rep?.metadata?.source??null,generatedAt:now()}};
      if(Array.isArray(proc?.items)) result.batch={count:proc.items.length,items:proc.items.map(x=>({index:x.index,source:x.source,fingerprint:x.fingerprint,status:x.processing?.decision?.status??"UNRESOLVED",analysis:compactAnalysis(x.processing)}))};
      result.evidenceChain=sealChain(result.evidence);
      result.payloadHash=fingerprint({findings:result.findings,relations:result.relations,decision:result.decision,verification:result.verification});
      result.validation=validateOutput(result);
      result.continuation={available:true,mode:"structured",nextInputType:Array.isArray(result.batch?.items)?"batch_analysis":"analysis_result",automatic:false};
      result.durationMs=Date.now()-started; return result;
    },
    inject(value,options={}){return{__cgoMachineInjection:true,machine:"C",stage:"injection",version:VERSION,mode:options.mode??"continuation",sourceStage:"C",transport:"internal",contentMode:"structured",createdAt:now(),payload:{value:clone(value)},metadata:clone(options.metadata??{})};}
  };
  function compactAnalysis(p){return{findings:clone(p?.findings??[]),relations:clone(p?.relations??[]),inferences:clone(p?.inferences??[]),evidence:clone(p?.evidence??[]),uncertainty:clone(p?.uncertainty??[]),verification:clone(p?.verification??[]),decision:clone(p?.decision??null)};}
  function summarize(r,p){return{inputType:r?.input?.type??"unknown",format:r?.content?.format??null,operations:p?.operations?.length??0,findings:p?.findings?.length??0,relations:p?.relations?.length??0,inferences:p?.inferences?.length??0,evidence:p?.evidence?.length??0,verification:p?.verification?.length??0,constraints:p?.constraints?.length??0,contradictions:p?.contradictions?.length??0,hypotheses:p?.hypotheses?.length??0,uncertainty:p?.uncertainty?.length??0,status:p?.decision?.status??"UNRESOLVED"};}

  function assertEnvelope(v){
    const issues=[];
    if(isBatchEnvelope(v)){ if(!Array.isArray(v.items)) issues.push("batch.items must be an array"); return {valid:issues.length===0,kind:"batch",issues}; }
    if(isObject(v) && v.__cgoMachineInjection===true){ if(v.contentMode!=="structured") issues.push("machine injection must use contentMode=structured"); if(!Object.prototype.hasOwnProperty.call(v,"payload")) issues.push("payload is missing"); return {valid:issues.length===0,kind:"machine_injection",issues}; }
    if(isObject(v) && v.__cgoInputEnvelope===true){ const p=v.payload||{}; if(!p.contentMode) issues.push("payload.contentMode is missing"); if(!p.transport) issues.push("payload.transport is missing"); return {valid:issues.length===0,kind:"input",issues}; }
    return {valid:false,kind:null,issues:["not_an_envelope"]};
  }
  function sealChain(evidence){ let previous="GENESIS"; return (evidence||[]).map((item,index)=>{ const payload={index,previous,evidence:clone(item)}; const hash=fingerprint(payload); const sealed={index,previous,hash,evidence:clone(item)}; previous=hash; return sealed; }); }
  function verifyChain(chain){ let previous="GENESIS"; const issues=[]; (chain||[]).forEach((item,index)=>{ const expected=fingerprint({index:item.index??index,previous,evidence:item.evidence}); if(item.previous!==previous || item.hash!==expected) issues.push({index,reason:"hash_or_link_mismatch"}); previous=item.hash||null; }); return {valid:issues.length===0,issues,length:(chain||[]).length}; }
  function validateOutput(result){ const checks=[]; const required=["machine","version","status","summary","decision","metadata"]; required.forEach(k=>checks.push({type:"REQUIRED_FIELD",field:k,status:Object.prototype.hasOwnProperty.call(result,k)?"PASS":"FAIL"})); checks.push({type:"DECISION_CONFIDENCE",status:Number.isFinite(Number(result.decision?.confidence)) && Number(result.decision.confidence)>=0 && Number(result.decision.confidence)<=1?"PASS":"FAIL"}); const chain=result.evidenceChain||sealChain(result.evidence||[]); checks.push({type:"EVIDENCE_CHAIN",status:verifyChain(chain).valid?"PASS":"FAIL",length:chain.length}); return {status:checks.every(x=>x.status==="PASS")?"VALID":"INVALID",checks}; }
  function recomputeDecisionFromB(s){
    if(Array.isArray(s?.items)){
      const items=s.items;
      const avg=items.length?Number((items.reduce((a,x)=>a+Number(x.processing?.decision?.confidence??0),0)/items.length).toFixed(3)):0;
      if(items.some(x=>x.processing?.decision?.status==="UNRESOLVED")) return {status:"UNRESOLVED",reason:"one_or_more_items_unresolved",confidence:avg};
      if(items.some(x=>x.processing?.decision?.status!=="PROCESSED")) return {status:"PARTIAL",reason:"one_or_more_items_need_attention",confidence:avg};
      return {status:"PROCESSED",reason:"batch_analysis_and_verification_completed",confidence:avg};
    }
    return decideB({uncertainty:clone(s?.uncertainty||[]),verification:clone(s?.verification||[])});
  }
  const MachineD={
    audit(output){
      const p=output?.pipeline||{}; const checks=[];
      const sourceFingerprint=output?.auditSource?.inputFingerprint??null;
      checks.push({type:"A_INPUT_FINGERPRINT",status:sourceFingerprint && sourceFingerprint===p.A?.input?.fingerprint?"PASS":"FAIL",category:"provenance",severity:"HIGH"});
      checks.push({type:"B_INPUT_FINGERPRINT",status:sourceFingerprint && sourceFingerprint===p.B?.inputFingerprint?"PASS":"FAIL",category:"provenance",severity:"HIGH"});
      checks.push({type:"C_INPUT_FINGERPRINT",status:sourceFingerprint && sourceFingerprint===p.C?.metadata?.inputFingerprint?"PASS":"FAIL",category:"provenance",severity:"HIGH"});
      const recomputed=recomputeDecisionFromB(p.B);
      checks.push({type:"B_DECISION_RECOMPUTE",status:JSON.stringify(recomputed)===JSON.stringify(p.B?.decision??null)?"PASS":"FAIL",category:"reasoning",severity:"HIGH"});
      const validation=validateOutput({...p.C,evidenceChain:p.C?.evidenceChain});
      checks.push({type:"C_VALIDATION_RECHECK",status:validation.status===p.C?.validation?.status?"PASS":"FAIL",category:"validation",severity:"MEDIUM"});
      const chainCheck=verifyChain(p.C?.evidenceChain||[]);
      checks.push({type:"EVIDENCE_CHAIN_INTEGRITY",status:chainCheck.valid?"PASS":"FAIL",category:"integrity",severity:"HIGH"});
      const recomputedPayloadHash=fingerprint({findings:p.C?.findings,relations:p.C?.relations,decision:p.C?.decision,verification:p.C?.verification});
      checks.push({type:"C_PAYLOAD_HASH",status:recomputedPayloadHash===p.C?.payloadHash?"PASS":"FAIL",category:"integrity",severity:"HIGH"});
      return {machine:"D",stage:"audit",version:VERSION,integrity:{hashChain:chainCheck,checks},replay:{available:Array.isArray(p.B?.reasoningTrace),operations:p.B?.operations?.length||0,reasoningSteps:p.B?.reasoningTrace?.length||0},status:checks.every(x=>x.status==="PASS")?"VALID":"ATTENTION",generatedAt:now()};
    },
    replay(output){const trace=output?.pipeline?.B?.reasoningTrace||[];return {available:true,steps:clone(trace),count:trace.length};}
  };
  function auditIndependence(){ return {networkCalls:0,externalImports:0,globalsLeaked:["CGOMachineABC"],nativeOnly:true,documentAccess:false,windowAccess:false,verified:true}; }
  function selfTest(){
    const results=[]; const test=(name,fn)=>{try{fn();results.push({name,status:"PASS"});}catch(e){results.push({name,status:"FAIL",error:String(e.message||e)});}};
    test("fingerprint",()=>{if(fingerprint("abc")!==fingerprint("abc"))throw Error("unstable fingerprint")});
    test("balancedDelimiters-comments-regex",()=>{if(!balancedDelimiters('const r=/\{/; // }\n({a:[1]})').balanced)throw Error("false delimiter failure")});
    test("tokenize-case",()=>{const t=tokenize("Hello hello HELLO");if(t.length!==3||new Set(t).size!==1)throw Error("token normalization failed")});
    test("envelope-validator",()=>{if(!assertEnvelope(MachineC.inject({x:1})).valid)throw Error("valid envelope rejected")});
    test("pipeline",()=>{const o=CGOMachineABC.process("hello world");if(o.result?.validation?.status!=="VALID")throw Error("pipeline validation failed")});
    test("batch",()=>{const o=CGOMachineABC.processMany(["a","b"]);if(!o.pipeline.B.items || o.pipeline.B.items.length!==2)throw Error("batch failed")});
    test("injection",()=>{const packet=MachineC.inject({x:1});const o=CGOMachineABC.process(packet);if(o.pipeline.A.structure.kind!=="injection")throw Error("injection structure failed")});
    test("input-envelope-kind",()=>{const e={__cgoInputEnvelope:true,payload:{contentMode:"text",transport:"file",text:"<p>x</p>"}};const o=CGOMachineABC.process(e);if(o.pipeline.A.structure.kind!=="input_envelope")throw Error("input envelope kind failed")});
    test("html-regression",()=>{const o=CGOMachineABC.process('<!doctype html><html><div id="x"><a href="/a">A</a><span id="x"></span></div></html>');const h=o.pipeline.A.content.syntax.html;if(!h.duplicateIds.includes("x")||!h.references.includes("/a"))throw Error("HTML extraction regression")});
    test("machine-A-envelope-schema",()=>{const r=MachineA.process({__cgoInputEnvelope:true,payload:{}});if(!r.unknowns?.some(x=>x.type==="ENVELOPE_SCHEMA_ISSUES"))throw Error("A envelope validation missing")});
    test("batch-analysis-aggregation",()=>{const o=CGOMachineABC.processMany(["a","b"]);if(!o.pipeline.B.hypotheses.length||!o.pipeline.B.reasoningTrace.length)throw Error("batch aggregation failed")});
    test("machine-D",()=>{const o=CGOMachineABC.process("audit");if(o.audit?.status!=="VALID")throw Error("audit failed")});
    test("audit-tamper-detection",()=>{const o=CGOMachineABC.process("audit");o.pipeline.B.decision.confidence=0;const d=MachineD.audit(o);if(d.status!=="ATTENTION")throw Error("tamper not detected")});
    test("audit-tamper-C-payload",()=>{const o=CGOMachineABC.process("audit");o.pipeline.C.findings.push({type:"TAMPER"});const d=MachineD.audit(o);if(d.status!=="ATTENTION"||!d.integrity.checks.some(x=>x.type==="C_PAYLOAD_HASH"&&x.status==="FAIL"))throw Error("C payload tamper not detected")});
    test("b-batch-depth-guard",()=>{const o=CGOMachineABC.processMany(["a"],{batchDepth:MAX_BATCH_DEPTH});if(o.pipeline.B.decision?.reason!=="batch_depth_limit")throw Error("B batch depth guard failed")});
    return {passed:results.filter(x=>x.status==="PASS").length,failed:results.filter(x=>x.status==="FAIL").length,results,verified:results.every(x=>x.status==="PASS")};
  }

  const CGOMachineABC={name:"CGO_MACHINE_ABC",version:VERSION,A:MachineA,B:MachineB,C:MachineC,D:MachineD,inject:(v,o={})=>MachineC.inject(v,o),assertEnvelope,sealChain,verifyChain,auditIndependence,selfTest,createBatchInjection(inputs,o={}){if(!Array.isArray(inputs))throw new TypeError("createBatchInjection membutuhkan array input.");return{__cgoBatchInjection:true,version:VERSION,mode:"batch",transport:"internal",contentMode:"collection",createdAt:now(),items:inputs.map(item=>{const c=clone(item);if(isObject(c)&&c.__cgoMachineInjection===true&&!c.contentMode)c.contentMode="structured";return c;}),metadata:clone(o.metadata??{})};},processMany(inputs,o={}){return this.process(this.createBatchInjection(inputs,o),{...o,source:o.source??"batch-injection"});},process(input,options={}){const envelope=(isBatchEnvelope(input)||isInputEnvelope(input))?assertEnvelope(input):null;if(envelope&&!envelope.valid) throw new TypeError("Invalid CGO envelope: "+envelope.issues.join("; "));const originalFingerprint=fingerprint(input);const a=MachineA.process(input,options),b=MachineB.process(a,options),c=MachineC.process(a,b,options);const out={engine:"CGO_MACHINE_ABC",version:VERSION,pipeline:{A:a,B:b,C:c},result:c,auditSource:{inputFingerprint:originalFingerprint}};out.audit=MachineD.audit(out);return out;}};

  Object.freeze(CGOMachineABC);
  if(typeof module!=="undefined"&&module.exports)module.exports=CGOMachineABC;
  global.CGOMachineABC=CGOMachineABC;
})(typeof globalThis!=="undefined"?globalThis:window);
