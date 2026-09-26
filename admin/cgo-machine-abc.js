/*
 * CGO MACHINE ABC — UNIVERSAL CORE ENGINE
 * Version 0.9.4
 * Zero External · Zero API · Zero Network · Domain Neutral
 * A = INGEST / PARSE / REPRESENT
 * B = ANALYZE / RELATE / VERIFY / REASON
 * C = SYNTHESIZE / VALIDATE / EMIT
 * D = AUDIT / INTEGRITY / REPLAY
 */
(function (global) {
  "use strict";

  const VERSION = "0.9.9";
  const MAX_TEXT_SAMPLE = 6000;
  const MAX_ITEMS = 1000;
  const MAX_TOKENS = 5000;
  const MAX_BATCH_DEPTH = 4;
  const DEFAULT_MAX_CYCLES = 5;
  const DEFAULT_STOP_STATUS = "PROCESSED";
  const DEFAULT_MIN_CONFIDENCE_DELTA = 0.01;
  const MAX_INPUT_SIZE = 10 * 1024 * 1024;
  const DEFAULT_MAX_DURATION_MS = 30000;
  const DEFAULT_MAX_RETRIES = 2;
  const metrics = {totalProcessed:0,totalCycles:0,confidenceSum:0,degradedCount:0,errorCount:0,skippedWhilePaused:0,lastStatus:null};
  let runtimeState = {paused:false,cyclesRun:0,lastCycleIndex:-1,pauseAt:null,lastTelemetry:null,lastPipelineTrace:[]};
  const observers = new Set();
  const telemetryObservers = new Set();
  let paused = false;

  const isObject = v => v !== null && typeof v === "object";
  const isPlainObject = v => isObject(v) && !Array.isArray(v) && !(v instanceof Date);
  function safeClone(v){
    const seen=new WeakMap();
    function walk(x){if(x===null||typeof x!=="object")return x;if(seen.has(x))return seen.get(x);if(x instanceof Date)return new Date(x.getTime());if(x instanceof RegExp)return new RegExp(x.source,x.flags);const out=Array.isArray(x)?[]:{};seen.set(x,out);for(const k of Object.keys(x))out[k]=walk(x[k]);return out;}
    try{return {value:walk(v),ok:true};}catch(e){return {value:null,ok:false,error:String(e.message||e)};}
  }
  const clone = v => safeClone(v).value;
  function hasCircular(v){if(v===null||typeof v!=="object")return false;const seen=new WeakSet();let found=false;function scan(x){if(found||x===null||typeof x!=="object")return;if(seen.has(x)){found=true;return}seen.add(x);for(const k of Object.keys(x))scan(x[k]);}scan(v);return found;}
  function toInt(v,f=0){const n=Number(v);return Number.isFinite(n)?Math.trunc(n):f;}
  function toFloat(v,f=0){const n=Number(v);return Number.isFinite(n)?n:f;}
  function toBool(v,f=false){if(v===true||v===false)return v;if(v==="true"||v===1)return true;if(v==="false"||v===0)return false;return f;}
  function normalizeSpecial(v) {
    // Map/Set/typed array/ArrayBuffer tidak lagi diam-diam jadi {} — diubah ke bentuk bertanda __cgoType agar datanya tetap terbaca.
    const seen = new WeakMap();
    function walk(x) {
      if (x === null || typeof x !== "object") return x;
      if (x instanceof Date || x instanceof RegExp) return x;
      if (seen.has(x)) return seen.get(x);
      if (x instanceof Map) { const o = {__cgoType:"Map",size:x.size,entries:[]}; seen.set(x,o); x.forEach((val,key)=>o.entries.push([walk(key),walk(val)])); return o; }
      if (x instanceof Set) { const o = {__cgoType:"Set",size:x.size,values:[]}; seen.set(x,o); x.forEach(val=>o.values.push(walk(val))); return o; }
      if (x instanceof ArrayBuffer) return {__cgoType:"ArrayBuffer",byteLength:x.byteLength};
      if (ArrayBuffer.isView(x)) { const n = typeof x.length === "number"; return {__cgoType:x.constructor.name,length:n?x.length:x.byteLength,sample:n?Array.prototype.slice.call(x,0,100):[]}; }
      const out = Array.isArray(x) ? [] : {}; seen.set(x,out);
      for (const k of Object.keys(x)) out[k] = walk(x[k]);
      return out;
    }
    return walk(v);
  }
  function validateInput(input,options={}){const max=toInt(options.maxInputSize,MAX_INPUT_SIZE);if(typeof input==="symbol")return{valid:false,reason:"Symbol tidak didukung"};if(typeof input==="bigint")return{valid:false,reason:"BigInt tidak didukung (gunakan Number)"};if(typeof input==="function")return{valid:false,reason:"Function tidak didukung sebagai input"};const norm=(input!==null&&typeof input==="object")?normalizeSpecial(input):input;if(hasCircular(norm))return{valid:false,reason:"Circular reference terdeteksi"};let sanitized=norm;if(typeof input==="number"&&!Number.isFinite(input))sanitized=Number.isNaN(input)?"NaN":input===Infinity?"Infinity":"-Infinity";const size=sizeOf(sanitized);if(size!==null&&size>max)return{valid:false,reason:`Input melebihi batas ${max} karakter; gunakan chunk/stream`};return{valid:true,reason:null,sanitized};}
  const now = () => new Date().toISOString();
  const elapsed = t => Date.now() - t;
  const uniq = a => [...new Set((a || []).filter(Boolean))];
  const clamp = (n, lo=0, hi=1) => Math.max(lo, Math.min(hi, Number(n) || 0));

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
  function isInputEnvelope(v) { return isObject(v) && (v.__cgoInputEnvelope === true || v.__cgoMachineInjection === true); }
  function isBatchEnvelope(v) { return isObject(v) && v.__cgoBatchInjection === true && Array.isArray(v.items); }
  function fingerprint(v) {
    // Sidik cepat 32-bit (FNV-1a) untuk identitas/konsistensi input. BUKAN untuk bukti integritas: pakai digest().
    let s;
    try { s = typeof v === "string" ? v : JSON.stringify(v, function (k, x) { const raw = this[k]; return raw instanceof Date ? {__cgoDate: isNaN(raw) ? "Invalid Date" : raw.toISOString()} : x; }); }
    catch (_) { s = undefined; }
    if (typeof s !== "string") { try { s = String(v); } catch (_) { s = "[unprintable]"; } }   // undefined / function / symbol tetap punya sidik
    let h = 2166136261;
    for (let i=0;i<s.length;i++) { h ^= s.charCodeAt(i); h += (h<<1)+(h<<4)+(h<<7)+(h<<8)+(h<<24); }
    return ("00000000" + (h >>> 0).toString(16)).slice(-8);
  }
  function stableStringify(v) {
    const seen = new WeakSet();
    function w(x) {
      if (x === null) return "null";
      const t = typeof x;
      if (t === "string") return JSON.stringify(x);
      if (t === "number") return Number.isFinite(x) ? String(x) : JSON.stringify(String(x));
      if (t === "boolean") return String(x);
      if (t === "bigint") return JSON.stringify(x.toString() + "n");
      if (t === "undefined" || t === "function" || t === "symbol") return "null";
      if (x instanceof Date) return JSON.stringify({__cgoDate: isNaN(x) ? "Invalid Date" : x.toISOString()});
      if (seen.has(x)) return '"[Circular]"';
      seen.add(x);
      const out = Array.isArray(x)
        ? "[" + x.map(w).join(",") + "]"
        : "{" + Object.keys(x).sort().filter(k => x[k] !== undefined && typeof x[k] !== "function" && typeof x[k] !== "symbol").map(k => JSON.stringify(k) + ":" + w(x[k])).join(",") + "}";
      seen.delete(x);
      return out;
    }
    return w(v);
  }
  const SHA_K = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
  ]);
  function utf8Encode(value) {
    const s = String(value);
    // TextEncoder dipakai bila tersedia; fallback manual menjaga core tetap
    // berjalan pada runtime JS yang tidak menyediakan Web API TextEncoder.
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(s);
    const out = [];
    for (let i = 0; i < s.length; i++) {
      let cp = s.charCodeAt(i);
      if (cp >= 0xD800 && cp <= 0xDBFF) {
        const lo = s.charCodeAt(i + 1);
        if (lo >= 0xDC00 && lo <= 0xDFFF) {
          cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
          i++;
        } else cp = 0xFFFD;
      } else if (cp >= 0xDC00 && cp <= 0xDFFF) cp = 0xFFFD;
      if (cp <= 0x7F) out.push(cp);
      else if (cp <= 0x7FF) out.push(0xC0 | (cp >> 6), 0x80 | (cp & 0x3F));
      else if (cp <= 0xFFFF) out.push(0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
      else out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
    }
    return Uint8Array.from(out);
  }
  function sha256Hex(str) {
    // SHA-256 sinkron, murni JS (tanpa crypto.subtle / library).
    const bytes = utf8Encode(str);
    const l = bytes.length, padLen = ((l + 9 + 63) >> 6) << 6;
    const buf = new Uint8Array(padLen); buf.set(bytes); buf[l] = 0x80;
    const dv = new DataView(buf.buffer);
    dv.setUint32(padLen - 8, Math.floor(l / 0x20000000)); dv.setUint32(padLen - 4, (l << 3) >>> 0);
    let h0=0x6a09e667,h1=0xbb67ae85,h2=0x3c6ef372,h3=0xa54ff53a,h4=0x510e527f,h5=0x9b05688c,h6=0x1f83d9ab,h7=0x5be0cd19;
    const w = new Uint32Array(64);
    for (let off = 0; off < padLen; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const a = w[i-15], b = w[i-2];
        const s0 = ((a>>>7)|(a<<25)) ^ ((a>>>18)|(a<<14)) ^ (a>>>3);
        const s1 = ((b>>>17)|(b<<15)) ^ ((b>>>19)|(b<<13)) ^ (b>>>10);
        w[i] = (w[i-16] + s0 + w[i-7] + s1) >>> 0;
      }
      let a=h0,b=h1,c=h2,d=h3,e=h4,f=h5,g=h6,h=h7;
      for (let i = 0; i < 64; i++) {
        const S1 = ((e>>>6)|(e<<26)) ^ ((e>>>11)|(e<<21)) ^ ((e>>>25)|(e<<7));
        const t1 = (h + S1 + ((e&f) ^ (~e&g)) + SHA_K[i] + w[i]) >>> 0;
        const S0 = ((a>>>2)|(a<<30)) ^ ((a>>>13)|(a<<19)) ^ ((a>>>22)|(a<<10));
        const t2 = (S0 + ((a&b) ^ (a&c) ^ (b&c))) >>> 0;
        h=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
      }
      h0=(h0+a)>>>0; h1=(h1+b)>>>0; h2=(h2+c)>>>0; h3=(h3+d)>>>0; h4=(h4+e)>>>0; h5=(h5+f)>>>0; h6=(h6+g)>>>0; h7=(h7+h)>>>0;
    }
    return [h0,h1,h2,h3,h4,h5,h6,h7].map(x => x.toString(16).padStart(8, "0")).join("");
  }
  const digest = v => sha256Hex(stableStringify(v));   // sidik 256-bit, urutan key tidak berpengaruh
  function sizeOf(v) { try { return typeof v === "string" ? v.length : JSON.stringify(v,(_,x)=>x instanceof Date?{__cgoDate:x.toISOString()}:x).length; } catch (_) { return null; } }
  function extensionOf(name="") { const m=String(name).toLowerCase().match(/\.([a-z0-9]+)$/); return m?m[1]:null; }

  function classifyText(text, hint={}) {
    const raw=String(text??""); const ext=String(hint.extension||"").toLowerCase(); const mime=String(hint.mimeType||"").toLowerCase(); const trimmed=raw.trim();
    let format="text", confidence=0.96, basis=[];
    if (ext==="json"||mime.includes("json")) {format="json";confidence=.99;basis.push("metadata");}
    else if (ext==="html"||ext==="htm"||mime.includes("html")) {format="html";confidence=.99;basis.push("metadata");}
    else if (["js","mjs","cjs","ts","tsx","jsx"].includes(ext)||mime.includes("javascript")||mime.includes("typescript")) {format="code";confidence=.99;basis.push("metadata");}
    else if (ext==="css"||mime.includes("css")) {format="css";confidence=.99;basis.push("metadata");}
    else if (ext==="xml"||mime.includes("xml")) {format="xml";confidence=.99;basis.push("metadata");}
    else if (ext==="csv"||mime.includes("csv")) {format="csv";confidence=.99;basis.push("metadata");}
    else if (ext==="md"||ext==="markdown") {format="markdown";confidence=.99;basis.push("metadata");}
    else if (/^<!doctype\s+html/i.test(trimmed)||/<html[\s>]/i.test(trimmed)) {format="html";confidence=.99;basis.push("doctype_or_html_tag");}
    else if ((trimmed.startsWith("{")&&trimmed.endsWith("}"))||(trimmed.startsWith("[")&&trimmed.endsWith("]"))) {
      try { JSON.parse(trimmed); format="json";confidence=.99;basis.push("valid_json"); }
      catch (_) { format="json_candidate";confidence=.72;basis.push("json_shape"); }
    }
    else if (looksLikeCode(raw)) {format="code";confidence=.9;basis.push("code_tokens");}
    else if (looksLikeCSV(raw)) {format="csv";confidence=.86;basis.push("delimiter_consistency");}
    else if (/^\s{0,3}(#|[-*+]\s|>\s)/m.test(raw)) {format="markdown";confidence=.82;basis.push("markdown_shape");}
    if (!basis.length) basis.push("generic_text");
    return {format,confidence,basis,uncertain:confidence<.75};
  }
  function looksLikeCode(raw) {
    const s = String(raw);
    return /^\s*(?:import\s+[^\n]*?from\s+["'][^"']+["']|import\s+["'][^"']+["']|export\s+(?:default\b|const\b|let\b|var\b|function\b|class\b|async\b|\{))/m.test(s)
      || /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*(?:=|;)/.test(s)
      || /\bfunction\s*\*?\s*[A-Za-z_$]?[\w$]*\s*\([^)]*\)\s*\{/.test(s)
      || /\bclass\s+[A-Za-z_$][\w$]*\s*(?:extends\s+[\w$.]+\s*)?\{/.test(s)
      || /\([^()\n]*\)\s*=>|\b[A-Za-z_$][\w$]*\s*=>/.test(s);
  }
  function looksLikeCSV(s) {
    const lines=String(s).split(/\r?\n/).filter(x=>x.trim()); if(lines.length<2)return false;
    const counts=[",",";","\t","|"].map(d=>lines.slice(0,Math.min(5,lines.length)).map(x=>x.split(d).length-1));
    return counts.some(a=>a[0]>0&&a.every(n=>n===a[0]));
  }
  function regexAllowedAt(s,i) {
    let j = i - 1; while (j >= 0 && /\s/.test(s[j])) j--;
    if (j < 0) return true;
    const p = s[j];
    if (/[=(:,!&|?{};\[+\-*%<>~^]/.test(p)) return true;
    if (/[\w$]/.test(p)) { let k = j; while (k >= 0 && /[\w$]/.test(s[k])) k--; return /^(?:return|typeof|case|do|else|in|of|void|delete|throw|new|yield|await|instanceof)$/.test(s.slice(k+1, j+1)); }
    return false;
  }
  function balancedDelimiters(text, opts={}) {
    const pairs={"{":"}","[":"]","(":")"}; const closers=new Set(Object.values(pairs)); const stack=[];
    let quote=null,escape=false,lineComment=false,blockComment=false,regex=false,regexClass=false;
    const s=String(text);
    for(let i=0;i<s.length;i++){
      const ch=s[i], nx=s[i+1];
      if(lineComment){if(ch==="\n")lineComment=false;continue;}
      if(blockComment){if(ch==="*"&&nx==="/"){blockComment=false;i++;}continue;}
      if(quote){if(escape)escape=false;else if(ch==="\\")escape=true;else if(ch===quote)quote=null;continue;}
      if(regex){if(ch==="\n"){regex=false;regexClass=false;escape=false;continue;}if(escape)escape=false;else if(ch==="\\")escape=true;else if(ch==="[")regexClass=true;else if(ch==="]")regexClass=false;else if(ch==="/"&&!regexClass)regex=false;continue;}
      if(ch==="/"&&nx==="/"){lineComment=true;i++;continue;}
      if(ch==="/"&&nx==="*"){blockComment=true;i++;continue;}
      if(ch==='"'||ch==="'"||ch==='`'){quote=ch;continue;}
      if(ch==="/"&&opts.regex!==false&&regexAllowedAt(s,i)){regex=true;regexClass=false;continue;}
      if(pairs[ch]) stack.push(pairs[ch]);
      else if(closers.has(ch)){if(stack.pop()!==ch)return {balanced:false,reason:"delimiter_mismatch"};}
    }
    return {balanced:stack.length===0&&!quote&&!blockComment&&!regex,unclosed:stack.length,unterminatedString:!!quote,unterminatedComment:blockComment,unterminatedRegex:regex};
  }
  function parseStructuredText(text){try{return{ok:true,value:JSON.parse(text)}}catch(e){return{ok:false,error:String(e.message||e)}}}
  function extractHtml(text){
    const s=String(text); const tags=[...s.matchAll(/<\s*([a-zA-Z][\w:-]*)\b/g)].map(m=>m[1].toLowerCase());
    const ids=[...s.matchAll(/\bid=["']([^"']+)["']/gi)].map(m=>m[1]);
    const classes=[...s.matchAll(/\bclass=["']([^"']+)["']/gi)].flatMap(m=>m[1].split(/\s+/).filter(Boolean));
    const links=[...s.matchAll(/\b(?:href|src)=["']([^"']+)["']/gi)].map(m=>m[1]);
    return {tagCount:tags.length,uniqueTags:uniq(tags),ids:uniq(ids),classes:uniq(classes),duplicateIds:uniq(ids.filter((x,i)=>ids.indexOf(x)!==i)),references:uniq(links)};
  }
  function extractCode(text){const s=String(text);const imports=[...s.matchAll(/\bimport\s+(?:[^;\n]+?\s+from\s+)?["']([^"']+)["']/g)].map(m=>m[1]);const requires=[...s.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)].map(m=>m[1]);const declarations=[...s.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)].map(m=>m[1]);const functions=[...s.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)].map(m=>m[1]);return{imports:uniq(imports),requires:uniq(requires),dependencies:uniq([...imports,...requires]),declarations:uniq(declarations),functions:uniq(functions)}}
  function tokenize(text,limit){const s=String(text);const n=s.length;const cap=Math.min(typeof limit==="number"?limit:MAX_TOKENS,n<180?320:n<1200?900:MAX_TOKENS);return s.normalize().split(/[^\p{L}\p{N}_$.-]+/u).filter(Boolean).map(x=>x.toLowerCase()).slice(0,cap)}
  function lineStats(text){const lines=String(text).split(/\r?\n/);return{lineCount:lines.length,nonEmptyLines:lines.filter(x=>x.trim()).length,maxLineLength:lines.reduce((m,x)=>Math.max(m,x.length),0)}}
  function analyzeText(text,hint={}){const s=String(text);const detection=classifyText(s,hint);const result={mode:"text",value:s,format:detection.format,formatConfidence:detection.confidence,formatBasis:detection.basis,stats:lineStats(s),tokens:tokenize(s),source:hint};result.syntax={};if(["code","code_candidate","json","json_candidate"].includes(detection.format))result.syntax.delimiters=balancedDelimiters(s);else if(detection.format==="css")result.syntax.delimiters=balancedDelimiters(s,{regex:false});if(detection.format==="json"||detection.format==="json_candidate")result.parse=parseStructuredText(s);if(detection.format==="html")result.syntax.html=extractHtml(s);if(detection.format==="code"||detection.format==="code_candidate")result.syntax.code=extractCode(s);if(detection.format==="csv")result.syntax.csv={rows:s.split(/\r?\n/).filter(Boolean).length,columns:(s.split(/\r?\n/)[0]||"").split(/[;,\t|]/).length};result.preview=s.slice(0,MAX_TEXT_SAMPLE);return result}

  function assertEnvelope(v){
    if(isBatchEnvelope(v)){const issues=[];if(!Array.isArray(v.items))issues.push("items_not_array");if(v.items.length>MAX_ITEMS)issues.push("items_exceed_limit");return{valid:issues.length===0,kind:"batch",issues};}
    if(isObject(v)&&v.__cgoMachineInjection===true){const issues=[];if(v.contentMode!=="structured")issues.push("machine_injection_contentMode_must_be_structured");if(!isObject(v.payload)||!("value" in v.payload))issues.push("payload_value_missing");return{valid:issues.length===0,kind:"machine_injection",issues};}
    if(isObject(v)&&v.__cgoInputEnvelope===true){const issues=[];if(!isObject(v.payload))issues.push("payload_missing");if(v.payload&&!v.payload.contentMode)issues.push("contentMode_missing");return{valid:issues.length===0,kind:"input_envelope",issues};}
    return{valid:true,kind:"none",issues:[]};
  }

  function describeStructure(value,content){const t=typeOf(value);if(t==="batch")return{kind:"batch",count:value.items.length};if(t==="input_envelope"){if(value.__cgoMachineInjection===true)return{kind:"injection",innerType:content?.mode??"unknown",format:content?.format??null};const p=value.payload||{};return{kind:"input_envelope",transport:p.transport??"unknown",name:p.name??null,mimeType:p.mimeType??null,extension:p.extension??null,size:p.size??null,contentMode:p.contentMode??"unknown",format:content?.format??null};}if(t==="string")return{kind:"scalar",valueType:"string",length:value.length,...lineStats(value),empty:value.length===0};if(t==="array")return{kind:"collection",length:value.length,itemTypes:value.slice(0,100).map(typeOf)};if(t==="object") {const keys=Object.keys(value);return{kind:"record",keyCount:keys.length,keys,valueTypes:Object.fromEntries(keys.map(k=>[k,typeOf(value[k])]))}}return{kind:"scalar",valueType:t}}
  function extractContent(value){
    if(isInputEnvelope(value)){if(value.__cgoMachineInjection===true&&value.contentMode==="structured"){const v=value.payload?.value;return{mode:Array.isArray(v)?"collection":isObject(v)?"record":"scalar",value:clone(v),source:{transport:"internal",stage:"C"},format:"structured"};}const p=value.payload||{};if(p.contentMode==="text"&&typeof p.text==="string")return analyzeText(p.text,{name:p.name,mimeType:p.mimeType,extension:p.extension});if(p.contentMode==="structured"){const v=p.value;return{mode:Array.isArray(v)?"collection":isObject(v)?"record":"scalar",value:clone(v),format:"structured"}}return{mode:"binary",value:{transport:p.transport??"file",name:p.name??null,mimeType:p.mimeType??null,extension:p.extension??null,size:p.size??null,byteLength:p.byteLength??p.size??null,preview:p.preview??null},format:"binary"};}
    if(typeof value==="string")return analyzeText(value,{});if(Array.isArray(value))return{mode:"collection",value:clone(value),format:"structured"};if(isObject(value))return{mode:"record",value:clone(value),format:"structured"};return{mode:"scalar",value,format:typeOf(value)};
  }

  const MachineA={process(input,options={}){const started=Date.now();const depth=Number(options.batchDepth||0);if(isBatchEnvelope(input)){if(depth>=MAX_BATCH_DEPTH)return{machine:"A",stage:"representation",version:VERSION,input:{type:"batch",fingerprint:fingerprint(input),size:sizeOf(input),count:0},structure:{kind:"batch",count:0},content:{mode:"batch",value:[]},observations:[{type:"BATCH_DEPTH_LIMIT",depth}],unknowns:[{type:"BATCH_DEPTH_LIMIT",severity:"HIGH",depth}],metadata:{source:options.source??null,receivedAt:now()},durationMs:elapsed(started)};const members=input.items.slice(0,MAX_ITEMS).map((item,i)=>MachineA.process(item,{...options,batchDepth:depth+1,source:item?.payload?.name??item?.name??`item-${i+1}`}));const memberUnknowns=members.flatMap((x,i)=>(x.unknowns||[]).map(u=>({...clone(u),itemIndex:i})));const out={machine:"A",stage:"representation",version:VERSION,input:{type:"batch",fingerprint:fingerprint(input),size:sizeOf(input),count:members.length},structure:{kind:"batch",count:members.length,itemTypes:members.map(x=>x.input.type)},content:{mode:"batch",value:members},observations:[{type:"INPUT_CLASSIFIED",value:"batch"},{type:"BATCH_ITEMS_DISCOVERED",value:members.length}],unknowns:memberUnknowns,metadata:{source:options.source??null,receivedAt:now()},durationMs:elapsed(started)};return out;}
      const env=assertEnvelope(input);const type=typeOf(input);const content=extractContent(input);const structure=describeStructure(input,content);const rep={machine:"A",stage:"representation",version:VERSION,input:{type,fingerprint:fingerprint(input),size:sizeOf(input)},structure,content,observations:[],unknowns:[],evidence:[],metadata:{source:options.source??null,receivedAt:now()}};if(!env.valid)rep.unknowns.push({type:"ENVELOPE_SCHEMA_ISSUES",severity:"HIGH",issues:env.issues});rep.observations.push({type:"INPUT_CLASSIFIED",value:type},{type:"STRUCTURE_IDENTIFIED",value:structure.kind});if(content.format)rep.observations.push({type:"FORMAT_IDENTIFIED",value:content.format,confidence:content.formatConfidence??null});if(content.formatConfidence<.75)rep.unknowns.push({type:"LOW_FORMAT_CONFIDENCE",severity:"LOW",confidence:content.formatConfidence});if(content.parse)rep.observations.push({type:"PARSE_ATTEMPTED",value:content.parse.ok});if(content.syntax)rep.observations.push({type:"SYNTAX_PROFILED",value:true});rep.evidence.push({type:"INPUT_FINGERPRINT",fingerprint:rep.input.fingerprint});rep.durationMs=elapsed(started);return rep}}

  function blankB(rep){return{machine:"B",stage:"processing",version:VERSION,inputFingerprint:rep?.input?.fingerprint??null,externalEvidence:null,operations:[],timing:{},selectedSteps:[],skippedSteps:[],findings:[],relations:[],inferences:[],hypotheses:[],constraints:[],contradictions:[],evidence:[],uncertainty:[],verification:[],reasoning:[],reasoningTrace:[],decision:null,items:null,errors:[],degraded:false,fallbacks:[],retries:[]}}
  // Evidence eksternal harus berbentuk klaim terstruktur dari caller.
  // ABC tidak mengetahui domain BCGO; ia hanya menilai status/severity/evidence yang diberikan.
  function ingestExternalEvidenceB(s, packet, options={}){
    if(!packet || typeof packet!=="object") return;
    const claims=Array.isArray(packet.claims)?packet.claims:[];
    s.operations.push("EXTERNAL_EVIDENCE_INGESTION");
    s.externalEvidence={source:packet.source??null,revision:packet.revision??null,claimCount:claims.length,fingerprint:packet.fingerprint??null};
    s.evidence.push({type:"EXTERNAL_EVIDENCE_PACKET",source:packet.source??null,revision:packet.revision??null,claimCount:claims.length,fingerprint:packet.fingerprint??null});
    for(const claim of claims){
      if(!claim || typeof claim!=="object") continue;
      const status=String(claim.status??"UNKNOWN").toUpperCase();
      const severity=String(claim.severity??"MEDIUM").toUpperCase();
      const finding={type:"EXTERNAL_EVIDENCE",source:claim.source??packet.source??null,status,severity,message:claim.message??null,target:claim.target??null,evidence:clone(claim.evidence??null)};
      s.findings.push(finding);
      s.evidence.push({type:"EXTERNAL_CLAIM",source:finding.source,status,severity,target:finding.target,message:finding.message,evidence:clone(finding.evidence)});
      const bad=["ANOMALY","ERROR","FAIL","FAILED","MISMATCH","DEGRADED","UNRESOLVED","ATTENTION","BLOCKED"].includes(status);
      const review=["REVIEW","UNKNOWN","UNREADABLE","STALE","RECOVERED"].includes(status);
      if(bad){
        s.contradictions.push({type:"EXTERNAL_EVIDENCE_CONFLICT",severity:severity==="CRITICAL"?"CRITICAL":severity==="HIGH"?"HIGH":"MEDIUM",source:finding.source,target:finding.target,status,message:finding.message});
        s.verification.push({type:"EXTERNAL_EVIDENCE_REVIEW",status:"FAIL",source:finding.source,target:finding.target,evidenceStatus:status});
      }else if(review){
        s.uncertainty.push({type:"EXTERNAL_EVIDENCE_UNCERTAIN",severity:severity==="HIGH"?"HIGH":"MEDIUM",source:finding.source,target:finding.target,status});
        s.verification.push({type:"EXTERNAL_EVIDENCE_REVIEW",status:"UNKNOWN",source:finding.source,target:finding.target,evidenceStatus:status});
      }else{
        s.verification.push({type:"EXTERNAL_EVIDENCE_REVIEW",status:"PASS",source:finding.source,target:finding.target,evidenceStatus:status});
      }
    }
    if(claims.length) s.inferences.push({type:"EXTERNAL_EVIDENCE_CONSIDERED",count:claims.length,basis:["caller_supplied_structured_evidence"]});
    if(claims.length && !packet.fingerprint) s.uncertainty.push({type:"EXTERNAL_EVIDENCE_UNFINGERPRINTED",severity:"MEDIUM",source:packet.source??null});
  }
  function selectedSteps(options,format){if(Array.isArray(options.steps)&&options.steps.length)return options.steps;const all=["structure","content","syntax","relation","constraint","hypothesis","verify","infer","reasoning","decision"];if(format==="text"||format==="markdown")return all.filter(x=>x!=="syntax");return all}
  function timed(s,name,fn,options={}){const t=Date.now();const attempts=toBool(options.retryFailedSteps,false)&&name!=="structure"?Math.min(toInt(options.maxRetries,DEFAULT_MAX_RETRIES),DEFAULT_MAX_RETRIES)+1:1;let ok=false;for(let i=0;i<attempts&&!ok;i++){try{if(options.__deadline&&Date.now()>options.__deadline)throw new Error("TIMEOUT");fn();ok=true;}catch(e){s.errors.push({step:name,error:String(e.message||e),timestamp:now(),retry:i<attempts-1});if(i<attempts-1)s.retries.push({step:name,attempt:i+1,timestamp:now()});else s.degraded=true;}}s.timing[name]=elapsed(t);}
  function inspectStructureB(r,s){s.operations.push("STRUCTURE_INSPECTION");const x=r.structure;s.findings.push({type:"STRUCTURE_PROFILE",kind:x.kind,details:clone(x)});if(x.kind==="record")s.evidence.push({type:"RECORD_KEYS",keys:clone(x.keys)});if(x.kind==="collection")s.evidence.push({type:"COLLECTION_SIZE",count:x.length})}
  function inspectContentB(r,s){s.operations.push("CONTENT_INSPECTION");const c=r.content;if(!c){s.uncertainty.push({type:"CONTENT_MISSING",severity:"HIGH"});return;}if(c.mode==="text"){s.evidence.push({type:"TEXT_AVAILABLE",length:c.value.length,format:c.format,preview:c.preview});if(!c.value.trim())s.uncertainty.push({type:"EMPTY_CONTENT",severity:"MEDIUM"});const unique=new Set(c.tokens||[]);s.findings.push({type:"TEXT_PROFILE",tokens:(c.tokens||[]).length,uniqueTokens:unique.size,lines:c.stats?.lineCount??null,format:c.format,formatConfidence:c.formatConfidence??null});}else if(c.mode==="binary"){s.evidence.push({type:"BINARY_METADATA",metadata:clone(c.value)});s.uncertainty.push({type:"CONTENT_NOT_DECODED",severity:"MEDIUM",reason:"binary payload has no internal decoder for its format"});}else if(c.mode==="record"){s.evidence.push({type:"RECORD_AVAILABLE",keys:Object.keys(c.value||{})});}else if(c.mode==="collection"){s.evidence.push({type:"COLLECTION_AVAILABLE",count:c.value?.length??0});}}
  function analyzeSyntaxB(r,s){s.operations.push("SYNTAX_ANALYSIS");const c=r.content||{};if(c.syntax?.delimiters){s.findings.push({type:"DELIMITER_BALANCE",result:clone(c.syntax.delimiters)});if(!c.syntax.delimiters.balanced)s.verification.push({type:"SYNTAX_WARNING",status:"FAIL",reason:"unbalanced_delimiters"});}if(c.format==="json"||c.format==="json_candidate"){s.findings.push({type:"JSON_PARSE",result:{ok:!!c.parse?.ok,error:c.parse?.error??null,valueType:c.parse?.ok?typeOf(c.parse.value):null}});s.verification.push({type:"JSON_VALID",status:c.parse?.ok?"PASS":"FAIL",evidence:"JSON.parse"});}if(c.format==="html"&&c.syntax?.html){s.findings.push({type:"HTML_PROFILE",profile:clone(c.syntax.html)});if(c.syntax.html.references?.length)s.relations.push({type:"REFERENCE",items:clone(c.syntax.html.references),basis:"html_href_src"});}if((c.format==="code"||c.format==="code_candidate")&&c.syntax?.code){s.findings.push({type:"CODE_PROFILE",profile:clone(c.syntax.code)});if(c.syntax.code.dependencies.length)s.relations.push({type:"CODE_DEPENDENCIES",items:clone(c.syntax.code.dependencies),basis:"import_or_require_tokens"});}}
  function deriveRelationsB(r,s){s.operations.push("RELATION_ANALYSIS");const st=structuredOf(r.content);const v=st.kind?st.value:null;if(Array.isArray(v)){for(let i=0;i<v.length-1;i++)s.relations.push({type:"SEQUENCE_ADJACENCY",from:i,to:i+1});}if(isPlainObject(v)){const keys=Object.keys(v);for(const k of keys)s.relations.push({type:"FIELD_PRESENCE",field:k,valueType:typeOf(v[k])});}}
  function structuredOf(c){if(!c)return{kind:null,value:null};if(c.mode==="record")return{kind:"record",value:c.value};if(c.mode==="collection")return{kind:"collection",value:c.value};if(c.mode==="text"&&c.parse?.ok){const v=c.parse.value;if(Array.isArray(v))return{kind:"collection",value:v,parsed:true};if(isPlainObject(v))return{kind:"record",value:v,parsed:true}}return{kind:null,value:null}}
  function analyzeConstraintsB(r,s,options={}){s.operations.push("CONSTRAINT_ANALYSIS");const st=structuredOf(r.content);const req=new Set(Array.isArray(options.requiredFields)?options.requiredFields.map(String):[]);if(st.kind==="record"){const rec=st.value||{};for(const [k,v] of Object.entries(rec)){if(v===""||v===null)s.constraints.push({type:"EMPTY_FIELD",field:k,severity:req.has(k)?"HIGH":"MEDIUM",required:req.has(k),value:v});}for(const k of req)if(!(k in rec))s.constraints.push({type:"REQUIRED_FIELD_MISSING",field:k,severity:"HIGH",required:true});}if(st.kind==="collection"&&st.value.length>MAX_ITEMS)s.constraints.push({type:"COLLECTION_BOUNDS",severity:"HIGH",count:st.value.length,max:MAX_ITEMS});}
  function inferHypothesesB(r,s){s.operations.push("HYPOTHESIS_ANALYSIS");if(s.contradictions.length)s.hypotheses.push({type:"STRUCTURAL_CONFLICT",basis:s.contradictions.map(x=>x.type),status:"UNVERIFIED"});if(s.relations.length>1)s.hypotheses.push({type:"MULTI_RELATION_STRUCTURE",relationCount:s.relations.length,status:"UNVERIFIED"});}
  function verifyB(r,s){s.operations.push("EVIDENCE_VERIFICATION");const checks=[];const c=r.content||{};if(c.mode==="text")checks.push({type:"CONTENT_PRESENT",status:c.value.trim()?"PASS":"FAIL"});if(c.mode==="record"){checks.push({type:"RECORD_PRESENT",status:Object.keys(c.value||{}).length?"PASS":"FAIL",weight:"medium"});checks.push({type:"RECORD_STRUCTURE",status:r.structure?.kind==="record"?"PASS":"FAIL",weight:"high"});}if(c.mode==="collection"){checks.push({type:"COLLECTION_PRESENT",status:Array.isArray(c.value)&&c.value.length?"PASS":"FAIL",weight:"medium"});checks.push({type:"COLLECTION_STRUCTURE",status:r.structure?.kind==="collection"?"PASS":"FAIL",weight:"high"});}if(c.mode==="scalar")checks.push({type:"SCALAR_PRESENT",status:c.value!==null&&c.value!==undefined?"PASS":"FAIL",weight:"medium"});if(c.syntax?.delimiters)checks.push({type:"DELIMITERS",status:c.syntax.delimiters.balanced?"PASS":"FAIL"});if(r.unknowns?.length)checks.push({type:"REPRESENTATION_UNKNOWN_REVIEW",status:"UNKNOWN",count:r.unknowns.length});s.verification.push(...checks);s.evidence.push({type:"VERIFICATION_RUN",checks:clone(checks)});}
  function reasonB(s){s.reasoning=[{step:"OBSERVE",status:"complete"},{step:"RELATE",status:s.relations.length?"complete":"limited"},{step:"HYPOTHESIZE",status:s.hypotheses.length?"complete":"none"},{step:"REASON",status:"complete"},{step:"VERIFY",status:s.verification.some(x=>x.status==="FAIL")?"attention":"complete"},{step:"DECIDE",status:"pending"}];s.reasoningTrace=s.reasoning.map((x,i)=>({...x,index:i+1}));}
  function detectContradictionsB(r,s){const c=r.content||{};if(c.format==="json"&&c.parse&&!c.parse.ok)s.contradictions.push({type:"FORMAT_CONTENT_MISMATCH",severity:"HIGH",reason:"json_parse_failed"});if(c.syntax?.delimiters&&!c.syntax.delimiters.balanced)s.contradictions.push({type:"DELIMITER_MISMATCH",severity:"HIGH"});if(c.format==="html"&&c.syntax?.html?.duplicateIds?.length)s.contradictions.push({type:"DUPLICATE_IDENTIFIER",severity:"HIGH",ids:clone(c.syntax.html.duplicateIds)});for(const x of s.constraints||[]){if(x.required===true&&x.type==="EMPTY_FIELD")s.contradictions.push({type:"REQUIRED_FIELD_EMPTY",severity:"HIGH",field:x.field});if(x.type==="REQUIRED_FIELD_MISSING")s.contradictions.push({type:"REQUIRED_FIELD_MISSING",severity:"HIGH",field:x.field});}}
  function confidenceB(s,options={}){const weights={critical:3,high:2,medium:1,low:.5,...(options.checkWeights||{})};let total=0,score=0;for(const c of s.verification){const level=c.weight||((c.type==="EVIDENCE_CHAIN"||c.type==="C_PAYLOAD_HASH")?"critical":c.type.includes("FINGERPRINT")||c.type==="DELIMITERS"?"high":c.type.includes("UNKNOWN")?"low":"medium");const w=toFloat(weights[level],1);total+=w;if(c.status==="PASS")score+=w;else if(c.status==="UNKNOWN")score+=w*.5;}let out=total?score/total:1;for(const u of s.uncertainty)out-={LOW:.03,MEDIUM:.12,HIGH:.3}[u.severity]??.08;for(const c of s.contradictions)out-={LOW:.02,MEDIUM:.08,HIGH:.2,CRITICAL:.45}[c.severity]??.08;if(s.inputFingerprint&&s.verification.length<3)out=Math.min(out,.95);return clamp(out)}
  function decideB(s,options={}){if(s.errors?.length||s.degraded)return{status:"DEGRADED",confidence:confidenceB(s,options),reason:"step_error"};if(s.uncertainty.some(x=>x.type==="INSUFFICIENT_REPRESENTATION"))return{status:"UNRESOLVED",confidence:0,reason:"insufficient_representation"};const failed=s.verification.filter(x=>x.status==="FAIL").length;const critical=s.contradictions.some(x=>x.severity==="CRITICAL");const highContr=s.contradictions.some(x=>x.severity==="HIGH");const confidence=confidenceB(s,options);if(critical)return{status:"CONTRADICTION",confidence,reason:"critical_contradiction"};if(highContr)return{status:"PARTIAL",confidence,reason:"high_contradiction"};if(failed||s.uncertainty.some(x=>x.severity==="HIGH"))return{status:"PARTIAL",confidence,reason:failed?"verification_failed":"high_uncertainty",failedChecks:failed};if(s.uncertainty.some(x=>x.severity==="MEDIUM"))return{status:"PARTIAL",confidence,reason:"medium_uncertainty"};return{status:"PROCESSED",confidence,reason:"analysis_and_verification_completed"}}
  function processBatch(rep,options={}){const started=Date.now();const depth=Number(options.batchDepth||0);const s=blankB(rep);if(depth>=MAX_BATCH_DEPTH){s.uncertainty.push({type:"BATCH_DEPTH_LIMIT_B",severity:"HIGH",depth});s.decision={status:"UNRESOLVED",confidence:0,reason:"batch_depth_limit"};s.durationMs=elapsed(started);return s;}s.operations.push("BATCH_PROCESSING","ITEM_ANALYSIS","CROSS_ITEM_RELATION_ANALYSIS","BATCH_VERIFICATION","BATCH_INFERENCE");s.items=rep.content.value.map((member,i)=>({index:i,source:member.metadata?.source??`item-${i+1}`,fingerprint:member.input?.fingerprint??null,processing:MachineB.process(member,{...options,batchDepth:depth+1})}));s.items.forEach(x=>{s.findings.push({type:"ITEM_ANALYZED",index:x.index,status:x.processing.decision?.status});s.evidence.push({type:"ITEM_EVIDENCE",index:x.index,count:x.processing.evidence.length});s.verification.push({type:"ITEM_VERIFICATION",index:x.index,count:x.processing.verification.length});s.hypotheses.push(...(x.processing.hypotheses||[]));s.constraints.push(...(x.processing.constraints||[]));s.contradictions.push(...(x.processing.contradictions||[]));s.reasoning.push(...(x.processing.reasoning||[]));s.reasoningTrace.push(...(x.processing.reasoningTrace||[]));if(x.processing.uncertainty.length)s.uncertainty.push({type:"ITEM_UNCERTAINTY",index:x.index,count:x.processing.uncertainty.length});});for(let i=0;i<s.items.length;i++)for(let j=i+1;j<s.items.length;j++)s.relations.push({type:"ITEM_RELATION_CANDIDATE",from:i,to:j,basis:"same_injection_batch"});s.inferences.push({type:"MULTI_MATERIAL_INPUT",itemCount:s.items.length,basis:["batch_structure","item_analysis"]});s.decision={status:s.items.some(x=>x.processing.decision?.status!=="PROCESSED")?"PARTIAL":"PROCESSED",confidence:clamp(s.items.reduce((a,x)=>a+(x.processing.decision?.confidence??0),0)/(s.items.length||1)),reason:"batch_analysis_and_verification_completed"};s.durationMs=elapsed(started);return s}

  const MachineB={process(rep,options={}){const started=Date.now();if(!rep?.structure)return unresolvedB("representation_missing",started);if(rep.structure.kind==="batch"&&Array.isArray(rep.content?.value))return processBatch(rep,options);const s=blankB(rep);const steps=selectedSteps(options,rep.content?.format);const allSteps=["structure","content","syntax","relation","constraint","hypothesis","verify","infer","reasoning","decision"];s.selectedSteps=steps.slice();s.skippedSteps=allSteps.filter(x=>!steps.includes(x));s.operations.push("AUTO_STEP_SELECTION");timed(s,"structure",()=>steps.includes("structure")&&inspectStructureB(rep,s),options);timed(s,"content",()=>steps.includes("content")&&inspectContentB(rep,s),options);timed(s,"syntax",()=>steps.includes("syntax")&&analyzeSyntaxB(rep,s),options);timed(s,"relation",()=>steps.includes("relation")&&deriveRelationsB(rep,s),options);timed(s,"constraint",()=>steps.includes("constraint")&&analyzeConstraintsB(rep,s,options),options);timed(s,"contradiction",()=>detectContradictionsB(rep,s),options);timed(s,"hypothesis",()=>steps.includes("hypothesis")&&inferHypothesesB(rep,s),options);timed(s,"verify",()=>steps.includes("verify")&&verifyB(rep,s),options);timed(s,"infer",()=>steps.includes("infer")&&inferB(rep,s));if(steps.includes("reasoning"))reasonB(s);if(options.__deadline&&Date.now()>options.__deadline){s.degraded=true;s.errors.push({step:"pipeline",error:"TIMEOUT",timestamp:now()});}if(steps.includes("decision"))s.decision=decideB(s,options);s.durationMs=elapsed(started);return s}}
  function unresolvedB(reason,started){const s=blankB(null);s.uncertainty.push({type:"INSUFFICIENT_REPRESENTATION",severity:"HIGH",reason});s.decision={status:"UNRESOLVED",confidence:0,reason};s.durationMs=elapsed(started);return s}
  function inferB(r,s){s.operations.push("GENERIC_INFERENCE");const c=r.content||{};if(c.format)s.inferences.push({type:"CONTENT_FORMAT",value:c.format,confidence:c.formatConfidence??null,basis:c.formatBasis||["input_metadata_or_content_signature"]});if(c.format==="code"&&c.syntax?.code?.dependencies.length)s.inferences.push({type:"DEPENDENCY_PRESENCE",count:c.syntax.code.dependencies.length,basis:["import_or_require_tokens"]});if(c.format==="html"&&c.syntax?.html)s.inferences.push({type:"MARKUP_STRUCTURE",tags:c.syntax.html.uniqueTags.length,basis:["tag_tokens"]});if(c.parse?.ok)s.inferences.push({type:"STRUCTURED_TEXT_PARSEABLE",basis:["JSON.parse"]})}

  function sealChain(items){let prev="GENESIS";return(items||[]).map((item,i)=>{const body={index:i,previousHash:prev,evidence:item};const hash=digest(body);prev=hash;return{index:i,previousHash:body.previousHash,hash,evidence:clone(item)}})}
  function verifyChain(chain){let prev="GENESIS";for(const item of chain||[]){if(item.previousHash!==prev)return false;const expected=digest({index:item.index,previousHash:item.previousHash,evidence:item.evidence});if(expected!==item.hash)return false;prev=item.hash}return true}
  function validateOutput(result){const issues=[];for(const k of ["machine","version","status","summary","decision","metadata"]){if(!(k in (result||{})))issues.push("MISSING_"+k.toUpperCase())}const conf=result?.decision?.confidence;if(conf!=null&&(conf<0||conf>1))issues.push("DECISION_CONFIDENCE");if(result?.evidenceChain&&!verifyChain(result.evidenceChain))issues.push("EVIDENCE_CHAIN");if(result?.payloadHash){const p=digest({findings:result.findings,relations:result.relations,decision:result.decision,verification:result.verification});if(p!==result.payloadHash)issues.push("C_PAYLOAD_HASH")};return{status:issues.length?"INVALID":"VALID",issues}}
  const MachineC={process(rep,proc,options={}){const started=Date.now();const result={machine:"C",stage:"result",version:VERSION,status:proc?.decision?.status??"UNRESOLVED",summary:summarize(rep,proc),findings:clone(proc?.findings??[]),relations:clone(proc?.relations??[]),inferences:clone(proc?.inferences??[]),hypotheses:clone(proc?.hypotheses??[]),constraints:clone(proc?.constraints??[]),contradictions:clone(proc?.contradictions??[]),reasoning:clone(proc?.reasoning??[]),reasoningTrace:clone(proc?.reasoningTrace??[]),evidence:clone(proc?.evidence??[]),uncertainty:clone(proc?.uncertainty??[]),verification:clone(proc?.verification??[]),decision:clone(proc?.decision??null),errors:clone(proc?.errors??[]),fallbacks:clone(proc?.fallbacks??[]),metadata:{inputFingerprint:rep?.input?.fingerprint??null,source:options.source??rep?.metadata?.source??null,generatedAt:now()}};result.evidenceChain=sealChain(result.evidence);if(result.status==="PROCESSED"&&result.decision?.confidence>.9&&verifyChain(result.evidenceChain))result.status="WELL_FORMED";result.payloadHash=digest({findings:result.findings,relations:result.relations,decision:result.decision,verification:result.verification});if(Array.isArray(proc?.items))result.batch={count:proc.items.length,items:proc.items.map(x=>({index:x.index,source:x.source,fingerprint:x.fingerprint,status:x.processing?.decision?.status??"UNRESOLVED",analysis:compactAnalysis(x.processing)}))};result.continuation={available:true,mode:"structured",nextInputType:Array.isArray(proc?.items)?"batch_analysis":"analysis_result",automatic:!!options.autoReflect};result.continuation.metadata={cycles:options.cycleIndex??0,autoReflect:!!options.autoReflect};result.validation=validateOutput(result);result.durationMs=elapsed(started);return result},inject(value,options={}){return{__cgoMachineInjection:true,machine:"C",stage:"injection",version:VERSION,mode:options.mode??"continuation",sourceStage:"C",transport:"internal",contentMode:"structured",createdAt:now(),payload:{value:clone(value)},metadata:clone(options.metadata??{})}}};
  function compactAnalysis(p){return{findings:clone(p?.findings??[]),relations:clone(p?.relations??[]),inferences:clone(p?.inferences??[]),hypotheses:clone(p?.hypotheses??[]),constraints:clone(p?.constraints??[]),contradictions:clone(p?.contradictions??[]),reasoning:clone(p?.reasoning??[]),reasoningTrace:clone(p?.reasoningTrace??[]),evidence:clone(p?.evidence??[]),uncertainty:clone(p?.uncertainty??[]),verification:clone(p?.verification??[]),decision:clone(p?.decision??null)}}
  function summarize(r,p){return{inputType:r?.input?.type??"unknown",format:r?.content?.format??null,formatConfidence:r?.content?.formatConfidence??null,operations:p?.operations?.length??0,findings:p?.findings?.length??0,relations:p?.relations?.length??0,inferences:p?.inferences?.length??0,hypotheses:p?.hypotheses?.length??0,constraints:p?.constraints?.length??0,contradictions:p?.contradictions?.length??0,evidence:p?.evidence?.length??0,verification:p?.verification?.length??0,uncertainty:p?.uncertainty?.length??0,status:p?.decision?.status??"UNRESOLVED",confidence:p?.decision?.confidence??0}}

  function fallbackResult(stage,detail,input){return{machine:"C",stage:"result",version:VERSION,status:"DEGRADED",summary:`Fallback after ${stage} failure`,findings:[],relations:[],inferences:[],hypotheses:[],constraints:[],contradictions:[],reasoning:[],reasoningTrace:[],evidence:[],uncertainty:[{type:"PIPELINE_ERROR",severity:"HIGH",stage,detail}],verification:[],errors:[{stage,error:detail,timestamp:now()}],fallbacks:[{from:stage,to:stage==="C"?"B":stage==="B"?"A":"ERROR",timestamp:now()}],decision:{status:"DEGRADED",confidence:0,reason:`fallback_${stage}`},metadata:{inputFingerprint:input?.input?.fingerprint??null,generatedAt:now()}}}
  function emitTelemetry(event){const packet={engine:"CGO_MACHINE_ABC",version:VERSION,type:"ABC_TELEMETRY",at:now(),...event};runtimeState.lastTelemetry=clone(packet);for(const fn of [...telemetryObservers]){try{fn(packet)}catch(_){}}return packet}
  function runCycle(input,options={},cycleIndex=0){const cycleStarted=Date.now();const deadline=options.__deadline||(toInt(options.maxDurationMs,DEFAULT_MAX_DURATION_MS)>0?Date.now()+toInt(options.maxDurationMs,DEFAULT_MAX_DURATION_MS):0);let a,b,c;const phaseTelemetry=[];const phase=(stage,fn)=>{const started=Date.now();emitTelemetry({event:"PHASE_START",stage,cycleIndex,elapsedMs:started-cycleStarted});try{const value=fn();const ended=Date.now();const item={stage,status:"COMPLETED",startedAt:started,endedAt:ended,durationMs:ended-started};phaseTelemetry.push(item);emitTelemetry({event:"PHASE_END",stage,cycleIndex,status:"COMPLETED",durationMs:item.durationMs,elapsedMs:ended-cycleStarted});return value}catch(e){const ended=Date.now();const item={stage,status:"FAILED",startedAt:started,endedAt:ended,durationMs:ended-started,error:String(e.message||e)};phaseTelemetry.push(item);emitTelemetry({event:"PHASE_END",stage,cycleIndex,status:"FAILED",durationMs:item.durationMs,elapsedMs:ended-cycleStarted,error:item.error});throw e;}};
    try{a=phase("A",()=>MachineA.process(input,{...options,__deadline:deadline,cycleIndex}));}catch(e){a={machine:"A",stage:"representation",version:VERSION,input:{type:"error",fingerprint:fingerprint(String(e)),size:0},structure:{kind:"error"},content:{mode:"scalar",value:null,format:"error"},unknowns:[{type:"A_ERROR",severity:"CRITICAL",reason:String(e.message||e)}],errors:[{stage:"A",error:String(e.message||e),timestamp:now()}]};}
    try{b=phase("B",()=>{const value=MachineB.process(a,{...options,__deadline:deadline,cycleIndex});if(options.externalEvidence){ingestExternalEvidenceB(value,options.externalEvidence,options);if(value.reasoning?.length)reasonB(value);value.decision=decideB(value,options);}return value;});}catch(e){b=blankB(a);b.degraded=true;b.errors.push({stage:"B",error:String(e.message||e),timestamp:now()});b.fallbacks.push({from:"B",to:"A",timestamp:now()});b.decision={status:"DEGRADED",confidence:0,reason:"fallback_B_to_A"};}
    try{c=phase("C",()=>MachineC.process(a,b,{...options,cycleIndex}));}catch(e){c=fallbackResult("C",String(e.message||e),a);c.fallbacks.push({from:"C",to:"B",timestamp:now()});}
    if(b.degraded){c.status="DEGRADED";c.decision={...c.decision,status:"DEGRADED",reason:"b_degraded"};c.errors=[...(c.errors||[]),...(b.errors||[])];c.fallbacks=[...(c.fallbacks||[]),...(b.fallbacks||[])];}
    const out={engine:"CGO_MACHINE_ABC",version:VERSION,cycleIndex,pipeline:{A:a,B:b,C:c},result:c};
    out.pipelineTrace=[{stage:"A",status:a?.stage?"COMPLETED":"FAILED",machine:a?.machine||"A",durationMs:phaseTelemetry.find(x=>x.stage==="A")?.durationMs??null},{stage:"B",status:b?.decision?"COMPLETED":(b?.degraded?"DEGRADED":"FAILED"),machine:b?.machine||"B",decision:b?.decision?.status||null,durationMs:phaseTelemetry.find(x=>x.stage==="B")?.durationMs??null},{stage:"C",status:c?.stage==="result"?"COMPLETED":"FAILED",machine:c?.machine||"C",result:c?.status||null,durationMs:phaseTelemetry.find(x=>x.stage==="C")?.durationMs??null}];
    const auditStarted=Date.now();emitTelemetry({event:"PHASE_START",stage:"D",cycleIndex,elapsedMs:auditStarted-cycleStarted});const auditSkipped=(options.fast===true||options.skipAudit===true);out.audit=auditSkipped?{machine:"D",status:"SKIPPED_FAST",checks:[],checkedAt:now(),failedChecks:0,reason:"fast_or_skipAudit_requested"}:MachineD.audit(out,input);const auditEnded=Date.now();phaseTelemetry.push({stage:"D",status:auditSkipped?"SKIPPED":(out.audit?.status==="VALID"?"COMPLETED":"ATTENTION"),startedAt:auditStarted,endedAt:auditEnded,durationMs:auditEnded-auditStarted});emitTelemetry({event:"PHASE_END",stage:"D",cycleIndex,status:phaseTelemetry.at(-1).status,durationMs:auditEnded-auditStarted,elapsedMs:auditEnded-cycleStarted,audit:out.audit?.status||null});out.pipelineTrace.push({stage:"D",status:auditSkipped?"SKIPPED":(out.audit?.status==="VALID"?"COMPLETED":"ATTENTION"),machine:"D",audit:out.audit?.status||null,durationMs:auditEnded-auditStarted});
    out.telemetry={cycleIndex,startedAt:cycleStarted,finishedAt:auditEnded,durationMs:auditEnded-cycleStarted,phases:clone(phaseTelemetry),route:"A>B>C>D",routeStatus:out.pipelineTrace.every(x=>["COMPLETED","SKIPPED"].includes(x.status))?"COMPLETE":"ATTENTION"};out.telemetry.fingerprint=digest({cycleIndex,route:out.telemetry.route,phases:out.telemetry.phases.map(x=>({stage:x.stage,status:x.status,durationMs:x.durationMs})),audit:out.audit?.status||null});runtimeState.lastPipelineTrace=clone(out.pipelineTrace);
    if(deadline&&Date.now()>deadline){out.stopReason="timeout";out.result.status="DEGRADED";out.result.errors=[...(out.result.errors||[]),{stage:"pipeline",error:"TIMEOUT",timestamp:now()}];}metrics.totalCycles++;metrics.confidenceSum+=toFloat(out.result?.decision?.confidence,0);metrics.lastStatus=out.result?.status||"UNRESOLVED";if(out.result?.status==="DEGRADED")metrics.degradedCount++;metrics.errorCount+=(out.result?.errors?.length||0);runtimeState.cyclesRun++;runtimeState.lastCycleIndex=cycleIndex;return out}
  function reflect(input,options={}){const maxCycles=Math.max(1,Math.min(toInt(options.maxCycles,DEFAULT_MAX_CYCLES),DEFAULT_MAX_CYCLES));const stopStatus=options.stopOnStatus??DEFAULT_STOP_STATUS;const minDelta=toFloat(options.minConfidenceDelta,DEFAULT_MIN_CONFIDENCE_DELTA);const maxDuration=toInt(options.maxDurationMs,DEFAULT_MAX_DURATION_MS);const deadline=maxDuration>0?Date.now()+maxDuration:0;const cycles=[];let current=input,prev=null,stable=0,stopReason="maxCycles";for(let i=0;i<maxCycles;i++){if(paused){stopReason="paused";break}if(deadline&&Date.now()>deadline){stopReason="timeout";break}const cycle=runCycle(current,{...options,__deadline:deadline,autoReflect:true},i);cycles.push(cycle);options.onCycle?.(cycle);const conf=cycle.result?.decision?.confidence??0;if(cycle.result?.status===stopStatus||(stopStatus===DEFAULT_STOP_STATUS&&cycle.result?.status==="WELL_FORMED")){stopReason="status";break}if(cycle.stopReason==="timeout"){stopReason="timeout";break}if(prev!==null&&Math.abs(conf-prev)<minDelta)stable++;else stable=0;if(stable>=1){stopReason="confidence_stable";break}prev=conf;current=MachineC.inject(cycle.result,{metadata:{source:"auto-reflect",cycle:i}})}runtimeState.lastCycleIndex=cycles.length?cycles.at(-1).cycleIndex:runtimeState.lastCycleIndex;return{cycles,finalResult:cycles.at(-1)?.result??null,stopReason}}
  function replay(packet){const p=packet?.pipeline||{};return{machine:"D",inputFingerprint:p.A?.input?.fingerprint??null,steps:(p.B?.reasoningTrace||[]).map((x,i)=>({index:i+1,name:x.step,status:x.status,operation:p.B?.operations?.[i]??null,inputFingerprint:p.B?.inputFingerprint??null})),originalDecision:clone(p.B?.decision),originalStatus:p.C?.status??null}}
  function verifyReplay(packet,replayed){const a=packet?.pipeline?.B?.decision,b=replayed?.originalDecision;return{status:digest(a)===digest(b)?"MATCH":"REPLAY_MISMATCH",replay_mismatch:digest(a)!==digest(b),original:clone(a),replayed:clone(b)}}
  const MachineD={audit(packet,input){const p=packet?.pipeline||{},checks=[];const fp=fingerprint(input);checks.push({type:"A_INPUT_FINGERPRINT",status:fp===p.A?.input?.fingerprint?"PASS":"FAIL",weight:"high"});checks.push({type:"B_INPUT_FINGERPRINT",status:fp===p.B?.inputFingerprint?"PASS":"FAIL",weight:"high"});checks.push({type:"C_INPUT_FINGERPRINT",status:fp===p.C?.metadata?.inputFingerprint?"PASS":"FAIL",weight:"high"});checks.push({type:"B_TO_C_DECISION",status:p.B?.decision?.status===p.C?.decision?.status||p.C?.status==="WELL_FORMED"?"PASS":"FAIL",weight:"medium"});const v=validateOutput(p.C);checks.push({type:"C_VALIDATION_RECHECK",status:v.status==="VALID"?"PASS":"FAIL",issues:v.issues,weight:"high"});const ext=p.B?.findings?.filter(x=>x?.type==="EXTERNAL_EVIDENCE")||[];const extMeta=p.B?.externalEvidence||null;const blocking=ext.filter(x=>["ANOMALY","ERROR","FAIL","FAILED","MISMATCH","DEGRADED","UNRESOLVED","ATTENTION","BLOCKED"].includes(String(x.status||"").toUpperCase())).length;checks.push({type:"EXTERNAL_EVIDENCE_PROPAGATION",status:!blocking||["PARTIAL","CONTRADICTION","DEGRADED"].includes(p.C?.status)?"PASS":"FAIL",externalFindings:ext.length,blockingFindings:blocking,weight:"critical"});checks.push({type:"EXTERNAL_EVIDENCE_FINGERPRINT",status:!ext.length||(!!extMeta?.fingerprint&&extMeta.claimCount===ext.length)?"PASS":"FAIL",claimCount:ext.length,fingerprint:extMeta?.fingerprint??null,weight:"high"});checks.push({type:"EVIDENCE_CHAIN",status:verifyChain(p.C?.evidenceChain)?"PASS":"FAIL",weight:"critical"});checks.push({type:"C_PAYLOAD_HASH",status:digest({findings:p.C?.findings,relations:p.C?.relations,decision:p.C?.decision,verification:p.C?.verification})===p.C?.payloadHash?"PASS":"FAIL",weight:"critical"});checks.push({type:"B_DEGRADED",status:p.B?.degraded?"FAIL":"PASS",weight:"high"});checks.push({type:"FALLBACK_CHAIN",status:Array.isArray(p.C?.fallbacks)?"PASS":"FAIL",weight:"medium"});const failed=checks.filter(x=>x.status==="FAIL").length;const externalBlocking=checks.find(x=>x.type==="EXTERNAL_EVIDENCE_PROPAGATION")?.blockingFindings||0;return{machine:"D",status:(failed||externalBlocking)?"ATTENTION":"VALID",checks,checkedAt:now(),failedChecks:failed,replay:replay(packet)}},replay,verifyReplay}
  function auditIndependence(){const forbidden=[["fetch",/\bfetch\s*\(/,"network"],["XMLHttpRequest",/\bXMLHttpRequest\b/,"network"],["WebSocket",/\bWebSocket\b/,"network"],["sendBeacon",/\bsendBeacon\b/,"network"],["document",/\bdocument\b/,"dom"],["localStorage",/\blocalStorage\b/,"storage"],["sessionStorage",/\bsessionStorage\b/,"storage"],["indexedDB",/\bindexedDB\b/,"storage"],["eval",/\beval\s*\(/,"dynamic"],["new Function",/\bnew\s+Function\b/,"dynamic"],["import(",/\bimport\s*\(/,"import"],["require(",/\brequire\s*\(/,"import"],["setTimeout/setInterval",/\bset(?:Timeout|Interval)\s*\(/,"timer"],["postMessage",/\bpostMessage\b/,"messaging"]];const internal=[safeClone,normalizeSpecial,hasCircular,validateInput,fingerprint,stableStringify,sha256Hex,digest,classifyText,looksLikeCode,looksLikeCSV,regexAllowedAt,balancedDelimiters,parseStructuredText,extractHtml,extractCode,tokenize,lineStats,analyzeText,assertEnvelope,describeStructure,extractContent,MachineA.process,blankB,ingestExternalEvidenceB,selectedSteps,timed,inspectStructureB,inspectContentB,analyzeSyntaxB,deriveRelationsB,structuredOf,analyzeConstraintsB,inferHypothesesB,verifyB,reasonB,detectContradictionsB,confidenceB,decideB,processBatch,MachineB.process,unresolvedB,inferB,sealChain,verifyChain,validateOutput,MachineC.process,MachineC.inject,summarize,compactAnalysis,fallbackResult,runCycle,reflect,replay,verifyReplay,MachineD.audit,pausedResult,notify];const pub=Object.values(CGOMachineABC).filter(f=>typeof f==="function"&&f!==auditIndependence&&f!==selfTest);const funcs=[...new Set([...internal,...pub])];const hits=[];for(const fn of funcs){const src=String(fn);for(const [name,re,kind] of forbidden)if(re.test(src))hits.push({name,kind})}const forbiddenReferences=[...new Set(hits.map(h=>h.name))];const globalCapabilities=["fetch","XMLHttpRequest","WebSocket","document","localStorage","sessionStorage","indexedDB"].filter(x=>typeof globalThis!=="undefined"&&x in globalThis);const count=k=>hits.filter(h=>h.kind===k).length;return{verified:forbiddenReferences.length===0,scannedFunctions:funcs.length,forbiddenReferences,globalCapabilities,networkCalls:count("network"),externalImports:count("import"),nativeOnly:forbiddenReferences.length===0,runtimeIsolated:globalCapabilities.length===0,coverage:{scannedFunctions:funcs.length,publicFunctions:pub.length,scope:"registered_functions_only"},note:"Pemindaian statis atas fungsi terdaftar (kata utuh, bukan potongan kata). Bukan bukti isolasi runtime: kemampuan global browser (fetch, document, dst.) tetap ada dan hanya dilaporkan."}}

  // ============================================================
  // PHYSICS KERNEL — extracted physics core
  // Formula source preserved; no external satellite module required.
  // ============================================================
  const CGOPhysics = (() => {

    const SAT_CONSTANTS = Object.freeze({
      // --- IDENTITAS LINK ---
      // [1] Iridium 9602 SBD: uplink L-band, SBD only
      FREQ_MHZ: 1621.25,               // [1] center band (1616-1626.5 MHz)
      CHANNEL_BW_HZ: 41667,            // [1] Iridium channel bandwidth
      DATA_RATE_BPS: 50,               // [1] SBD data rate (250 byte/message)

      // --- LINK BUDGET ---
      // [1] Iridium 9602: max EIRP 7 dBW = 37 dBm @ 30° elevasi
      EIRP_DBM: 37,                    // [1] terminal transmit EIRP
      RX_GAIN_DBI: 3,                  // [1] patch antenna gain typical
      // [4] Thermal noise: kTB @ 300K, BW = 41.667 kHz
      //     N = -174 + 10*log10(41667) = -174 + 46.2 = -127.8 dBm
      //     + NF receiver 2.2 dB (Iridium spec) = -125.6 dBm
      NOISE_FLOOR_DBM: -125.6,         // [4] thermal + receiver NF

      // --- PROCESSING GAIN ---
      // [1] SBD dengan FEC + spread: processing gain
      //     Gp = 10*log10(BW/Rb) = 10*log10(41667/50) = 29.2 dB
      PROCESSING_GAIN_DB: 29.2,        // [1] Eb/N0 vs SNR conversion

      // --- ORBIT (IRIDIUM) ---
      // [1] Iridium: 66 satelit, orbit 780 km (bukan 550!)
      ORBIT_ALTITUDE_KM: 780,          // [1] Iridium constellation altitude
      EARTH_RADIUS_KM: 6371,           // WGS84 mean

      // --- DOPPLER ---
      // [3] Max Doppler shift @ 1621.25 MHz, v_rel = 7.5 km/s:
      //     f_d = (v/c) * f_c = (7500 / 3e8) * 1621.25e6 = 40.53 kHz
      MAX_DOPPLER_HZ: 40530,           // [3] verified ±40.5 kHz
      // [3] Max Doppler rate: 280 Hz/s (empirical, passes multiple refs)
      MAX_DOPPLER_RATE_HZ_S: 280,      // [3]

      // --- ELEVASI ---
      MIN_ELEVATION_DEG: 10,           // [1] hard floor untuk SBD
      MAX_ELEVATION_DEG: 75,           // [3] typical max @ mid-latitude

      // --- ATMOSFER (ITU-R P.676) ---
      // [2] Simplified: L_atm(θ) = 0.1 / sin(θ) untuk 1-2 GHz
      ATM_COEF_DB: 0.1,                // [2] tropospheric absorption coef

      // --- SCINTILLATION EQUATORIAL (Indonesia) ---
      // [5] S4 index 0.3-0.8 @ equatorial anomaly, 20:00-23:00 LT
      //     Fade depth: 3-15 dB
      SCINT_PROB_NIGHT: 0.08,          // per tick (100ms), 20:00-23:00
      SCINT_PROB_DAY: 0.005,           // per tick
      SCINT_EQUINOX_MULT: 2.5,         // Maret-April, Sept-Okt
      SCINT_FADE_MIN_DB: 3,            // minimum fade
      SCINT_FADE_MAX_DB: 15,           // maximum fade

      // --- LQM (Eb/N0 THRESHOLD) ---
      // [1] Iridium SBD: BER 1e-5 butuh Eb/N0 ~6 dB (after FEC)
      // Mapping PER (256 bit packet):
      //   Eb/N0 = 7.5 dB → BER ~1e-6 → PER ~0.03%   (excellent)
      //   Eb/N0 = 6.0 dB → BER ~1e-5 → PER ~0.26%   (good)
      //   Eb/N0 = 4.5 dB → BER ~1e-4 → PER ~2.5%    (marginal)
      //   Eb/N0 = 3.0 dB → BER ~1e-3 → PER ~22%     (bad)
      //   Eb/N0 = 2.0 dB → BER ~1e-2 → PER ~92%     (unusable)
      LQM_THRESHOLD_VALID_DB: 6.0,     // PER < 1% (FEC corrected)
      LQM_THRESHOLD_DEGRADED_DB: 4.0,  // PER < 10% (marginal)

      // --- PACKET ---
      PACKET_BITS: 256,                // 32 byte * 8 bit

      // --- TIMING ---
      PASS_DURATION_SEC: 550,          // [3] average Iridium pass
      INTER_PASS_MIN_MS: 120_000,      // 2 menit minimum gap
      INTER_PASS_MAX_MS: 900_000,      // 15 menit maximum gap
      COLD_START_MIN_MS: 30_000,       // boot acquisition
      COLD_START_MAX_MS: 90_000,
      RE_ACQ_WINDOW_MS: 15_000,        // re-acquisition window
      SCAN_TIMEOUT_MS: 90_000,         // scanning timeout
      MAX_DELTA_MS: 1000,              // clamp untuk safety
      HISTORY_SIZE: 20,                // ~2s @100ms
      SUSTAINED_SAMPLES: 10,           // ~1s sustained check
      // Doppler rate → LQM penalty (~0.7 dB at max 280 Hz/s)
      DOPPLER_WEIGHT: 1 / 400,
    });

    // ============================================================================
    // PHYSICS MODE
    // ============================================================================

    const PHYSICS_MODE = Object.freeze({
      IDEAL: 'ideal',           // hanya geometri, tanpa noise/scint
      REALISTIC: 'realistic',   // geometri + atmosfer + scintillation
      STRESS: 'stress'          // + forced fade 30% + margin tipis
    });

    // ============================================================================
    // BER LOOKUP — RICIAN K=7dB (LOS dominant) & K=3dB (partially blocked)
    // ============================================================================
    // [4] Rician K=7 dB: SNR vs BER (with FEC applied)
    // Format: [ebn0_dB, log10(BER)]
    const BER_RICIAN_K7 = [
      [-2, -0.30],   // BER 0.5
      [ 0, -0.90],   // BER 0.126
      [ 2, -1.70],   // BER 0.02
      [ 4, -3.30],   // BER 5e-4
      [ 6, -5.00],   // BER 1e-5
      [ 8, -7.00],   // BER 1e-7
      [10, -9.00],   // BER 1e-9
      [12, -11.0],   // BER 1e-11
    ];

    // Rician K=3 dB (lebih banyak multipath, untuk elevasi rendah)
    const BER_RICIAN_K3 = [
      [-2, -0.25],   // BER 0.56
      [ 0, -0.75],   // BER 0.18
      [ 2, -1.40],   // BER 0.04
      [ 4, -2.70],   // BER 2e-3
      [ 6, -4.30],   // BER 5e-5
      [ 8, -6.20],   // BER 6.3e-7
      [10, -8.20],   // BER 6.3e-9
      [12, -10.2],
    ];

    /**
     * Interpolasi log-linear untuk BER.
     * @param {number} ebn0Db - Eb/N0 dalam dB
     * @param {Array<[number, number]>} table - lookup table
     * @returns {number} BER (linear, 0..0.5)
     */
    function interpolateBER(ebn0Db, table) {
      // Clamp di luar range
      if (ebn0Db <= table[0][0]) return Math.pow(10, table[0][1]);
      if (ebn0Db >= table[table.length - 1][0]) {
        return Math.pow(10, table[table.length - 1][1]);
      }

      // Cari segment
      for (let i = 0; i < table.length - 1; i++) {
        const [x0, y0] = table[i];
        const [x1, y1] = table[i + 1];
        if (ebn0Db >= x0 && ebn0Db <= x1) {
          const ratio = (ebn0Db - x0) / (x1 - x0);
          const logBER = y0 + ratio * (y1 - y0);
          return Math.pow(10, logBER);
        }
      }
      return 0.5;
    }

    /**
     * Pilih lookup table berdasarkan elevasi.
     * @param {number} elevationDeg
     * @returns {Array<[number, number]>}
     */
    function selectBERTable(elevationDeg) {
      // Elevasi rendah (< 30°): multipath dominan → K=3
      // Elevasi tinggi (>= 30°): LOS dominan → K=7
      return elevationDeg >= 30 ? BER_RICIAN_K7 : BER_RICIAN_K3;
    }

    /**
     * Hitung BER dengan model Rician adaptive.
     * @param {number} ebn0Db
     * @param {number} elevationDeg
     * @returns {number}
     */
    function getBER(ebn0Db, elevationDeg = 45) {
      const table = selectBERTable(elevationDeg);
      return interpolateBER(ebn0Db, table);
    }

    /**
     * Hitung Packet Error Rate dari BER.
     * @param {number} ber - Bit Error Rate
     * @param {number} bits - jumlah bit per paket
     * @returns {number} PER (0..1)
     */
    function getPER(ber, bits = SAT_CONSTANTS.PACKET_BITS) {
      return 1 - Math.pow(1 - ber, bits);
    }

    // ============================================================================
    // LAYER 1: FISIKA — PURE FUNCTIONS
    // ============================================================================

    /**
     * Hitung geometri satelit pada waktu t dalam 1 pass.
     * Model: parabola sederhana (approximation untuk LEO).
     * 
     * @param {number} elapsedSec - waktu sejak awal pass (0 .. passDuration)
     * @param {number} passDurationSec - durasi total pass
     * @returns {{elevationDeg, distanceKm, dopplerShiftHz, dopplerRateHzPerSec}}
     */
    function computeGeometry(elapsedSec, passDurationSec) {
      const T = passDurationSec;
      const normT = (elapsedSec / T) - 0.5;   // -0.5 .. +0.5

      // Elevasi: parabola (zenith di tengah pass)
      // elev(t) = maxElev * (1 - 4*normT^2)
      const maxElev = SAT_CONSTANTS.MAX_ELEVATION_DEG;
      const elevationDeg = maxElev * (1 - 4 * normT * normT);

      // Slant range (hukum cosinus, dengan Re dan h dari konstanta)
      const Re = SAT_CONSTANTS.EARTH_RADIUS_KM;
      const h = SAT_CONSTANTS.ORBIT_ALTITUDE_KM;
      const elRad = elevationDeg * Math.PI / 180;

      // Rumus: d = sqrt((Re+h)^2 - (Re*cos(el))^2) - Re*sin(el)
      const a = (Re + h) ** 2;
      const b = (Re * Math.cos(elRad)) ** 2;
      const c = Re * Math.sin(elRad);
      const distanceKm = Math.sqrt(Math.max(0, a - b)) - c;

      // Doppler shift: sinusoidal dalam normT
      // f_d(t) = -f_max * sin(normT * π)
      const maxShift = SAT_CONSTANTS.MAX_DOPPLER_HZ;
      const dopplerShiftHz = -maxShift * Math.sin(normT * Math.PI);

      // Doppler rate: turunan dari shift
      // df_d/dt = -f_max * (π/T) * cos(normT * π)
      const dopplerRateHzPerSec = -(maxShift * Math.PI / T) * Math.cos(normT * Math.PI);

      return { elevationDeg, distanceKm, dopplerShiftHz, dopplerRateHzPerSec };
    }

    /**
     * Hitung FSPL (Free Space Path Loss).
     * L = 20*log10(d_km) + 20*log10(f_MHz) + 32.45
     * 
     * @param {number} distanceKm
     * @param {number} freqMHz
     * @returns {number} FSPL dalam dB
     */
    function computeFSPL(distanceKm, freqMHz = SAT_CONSTANTS.FREQ_MHZ) {
      return 20 * Math.log10(distanceKm) + 20 * Math.log10(freqMHz) + 32.45;
    }

    /**
     * Hitung SNR efektif di receiver.
     * SNR = EIRP + G_rx - FSPL - NoiseFloor
     * 
     * @param {number} distanceKm
     * @returns {number} SNR dalam dB
     */
    function computeSNR(distanceKm) {
      const fspl = computeFSPL(distanceKm);
      const prx = SAT_CONSTANTS.EIRP_DBM + SAT_CONSTANTS.RX_GAIN_DBI - fspl;
      return prx - SAT_CONSTANTS.NOISE_FLOOR_DBM;
    }

    /**
     * Hitung redaman atmosfer.
     * Model: L_atm(θ) = coef / sin(θ) + scintillation bonus
     * 
     * @param {number} elevationDeg
     * @returns {number} redaman dalam dB (positif)
     */
    function computeAtmPenalty(elevationDeg) {
      if (elevationDeg <= 0) return 99;  // blocked

      const elRad = elevationDeg * Math.PI / 180;
      const sinEl = Math.max(0.1, Math.sin(elRad));

      // Base tropospheric (ITU-R P.676 simplified)
      let penalty = SAT_CONSTANTS.ATM_COEF_DB / sinEl;

      // Bonus scintillation equatorial @ elevasi rendah
      if (elevationDeg < 20) {
        penalty += (20 - elevationDeg) * 0.08;
      }

      return penalty;
    }

    /**
     * Scintillation equatorial (probabilistik).
     * Untuk Indonesia (equatorial anomaly).
     * 
     * @param {Date} now
     * @param {number} elevationDeg
     * @param {number} deltaMs
     * @param {string} mode - 'ideal' | 'realistic' | 'stress'
     * @returns {number} fade dalam dB (negatif = fade, 0 = clear)
     */
    function computeScintillation(now, elevationDeg, deltaMs, mode) {
      if (mode === PHYSICS_MODE.IDEAL) return 0;

      const hour = now.getHours();
      const month = now.getMonth(); // 0-11

      const isNight = hour >= 20 && hour <= 23;
      const isEquinox = (month >= 2 && month <= 3) || (month >= 8 && month <= 9);

      let prob = isNight ? SAT_CONSTANTS.SCINT_PROB_NIGHT : SAT_CONSTANTS.SCINT_PROB_DAY;
      if (isEquinox) prob *= SAT_CONSTANTS.SCINT_EQUINOX_MULT;

      // Elevasi rendah lebih rentan
      if (elevationDeg < 30) {
        prob *= (1 + (30 - elevationDeg) / 30);
      }

      // Scale by deltaMs (probabilitas per detik)
      const effectiveProb = prob * (deltaMs / 1000);

      // Stress mode: paksa fade lebih sering
      const finalProb = mode === PHYSICS_MODE.STRESS ? Math.min(0.5, effectiveProb * 5) : effectiveProb;

      if (Math.random() < finalProb) {
        const fadeMin = SAT_CONSTANTS.SCINT_FADE_MIN_DB;
        const fadeMax = SAT_CONSTANTS.SCINT_FADE_MAX_DB;
        return -(fadeMin + Math.random() * (fadeMax - fadeMin));
      }

      return 0;
    }

    // ============================================================================
    // LAYER 2: LQM — DERIVED METRIC
    // ============================================================================

    /**
     * Hitung LQM = Eb/N0 efektif setelah semua penalti.
     * 
     * LQM = Eb/N0 - atmPenalty - dopplerPenalty + scintFade
     * 
     * Interpretasi:
     *   LQM >= 6.0  → PER < 1%   (VALID)
     *   LQM >= 4.0  → PER < 10%  (DEGRADED)
     *   LQM <  4.0  → PER > 10%  (LOSING LOCK)
     * 
     * @param {object} input
     * @param {number} input.snrDb - SNR di receiver
     * @param {number} input.dopplerRateHzPerSec
     * @param {number} input.elevationDeg
     * @param {number} input.scintFadeDb - fade dari scintillation (negatif)
     * @returns {number} LQM dalam dB, atau -Infinity jika blocked
     */
    function calculateLQM({ snrDb, dopplerRateHzPerSec, elevationDeg, scintFadeDb = 0 }) {
      // Hard floor elevasi
      if (elevationDeg < SAT_CONSTANTS.MIN_ELEVATION_DEG) {
        return -Infinity;
      }

      // SNR → Eb/N0 (via processing gain)
      const ebn0 = snrDb + SAT_CONSTANTS.PROCESSING_GAIN_DB;

      // Penalti atmosfer
      const atmPenalty = computeAtmPenalty(elevationDeg);

      // Penalti Doppler tracking
      const dopplerPenalty = Math.abs(dopplerRateHzPerSec) * SAT_CONSTANTS.DOPPLER_WEIGHT || 0;
      // Normalize: kalau rate max 280 Hz/s, penalty max ~0.7 dB (reasonable)

      // LQM final
      return ebn0 - atmPenalty - dopplerPenalty + scintFadeDb;
    }

    // ============================================================================
    // LAYER 3: CHANNEL SIMULATOR
    // ============================================================================

    class SatelliteChannelSimulator {
      /**
       * @param {object} [options]
       * @param {number} [options.passDurationSec=550]
       * @param {string} [options.mode='realistic']
       */
      constructor(options = {}) {
        this.passDuration = options.passDurationSec ?? SAT_CONSTANTS.PASS_DURATION_SEC;
        this.mode = options.mode ?? PHYSICS_MODE.REALISTIC;

        this.elapsed = 0;
        this.inPass = true;
        this.interPassRemaining = 0;

        this.tickCount = 0;
        this.lastScintFade = 0;
      }

      /**
       * Tick channel simulator.
       * @param {number} deltaMs
       * @param {Date} [now]
       * @param {object|null} [externalGeo] - geometri dari TLE/SGP4 (opsional)
       *   { elevationDeg, distanceKm, dopplerShiftHz?, dopplerRateHzPerSec?, name? }
       * @returns {object} metrics
       */
      tick(deltaMs, now = new Date(), externalGeo = null) {
        this.tickCount++;

        // ── Jalur LIVE: geometri dari TLE (bukan parabola internal) ──
        if (externalGeo && Number.isFinite(externalGeo.elevationDeg)) {
          const elevationDeg = externalGeo.elevationDeg;
          const distanceKm = Number.isFinite(externalGeo.distanceKm)
            ? externalGeo.distanceKm
            : Infinity;
          const inPass = elevationDeg >= SAT_CONSTANTS.MIN_ELEVATION_DEG
            && Number.isFinite(distanceKm)
            && distanceKm < 1e6;

          if (!inPass) {
            this.lastScintFade = 0;
            return {
              elevationDeg: Math.max(0, elevationDeg),
              distanceKm,
              snrDb: -Infinity,
              dopplerShiftHz: externalGeo.dopplerShiftHz ?? 0,
              dopplerRateHzPerSec: externalGeo.dopplerRateHzPerSec ?? 0,
              atmPenalty: 99,
              scintFadeDb: 0,
              inPass: false,
              source: 'tle',
              name: externalGeo.name ?? null
            };
          }

          const snrDb = computeSNR(distanceKm);
          const atmPenalty = computeAtmPenalty(elevationDeg);
          const scintFadeDb = computeScintillation(now, elevationDeg, deltaMs, this.mode);
          this.lastScintFade = scintFadeDb;

          return {
            elevationDeg,
            distanceKm,
            snrDb,
            dopplerShiftHz: externalGeo.dopplerShiftHz ?? 0,
            dopplerRateHzPerSec: externalGeo.dopplerRateHzPerSec ?? 0,
            atmPenalty,
            scintFadeDb,
            inPass: true,
            source: 'tle',
            name: externalGeo.name ?? null
          };
        }

        // ── Jalur SIM: parabola internal (fallback offline) ──
        if (!this.inPass) {
          this.interPassRemaining -= deltaMs;
          if (this.interPassRemaining <= 0) {
            this.inPass = true;
            this.elapsed = 0;
            this.interPassRemaining = 0;
          } else {
            return {
              elevationDeg: 0,
              distanceKm: Infinity,
              snrDb: -Infinity,
              dopplerShiftHz: 0,
              dopplerRateHzPerSec: 0,
              atmPenalty: 99,
              scintFadeDb: 0,
              inPass: false,
              source: 'sim'
            };
          }
        }

        this.elapsed += deltaMs / 1000;

        if (this.elapsed > this.passDuration) {
          this.inPass = false;
          this.interPassRemaining =
            SAT_CONSTANTS.INTER_PASS_MIN_MS +
            Math.random() * (SAT_CONSTANTS.INTER_PASS_MAX_MS - SAT_CONSTANTS.INTER_PASS_MIN_MS);

          this.elapsed = 0;
          return {
            elevationDeg: 0,
            distanceKm: Infinity,
            snrDb: -Infinity,
            dopplerShiftHz: 0,
            dopplerRateHzPerSec: 0,
            atmPenalty: 99,
            scintFadeDb: 0,
            inPass: false,
            source: 'sim'
          };
        }

        const geo = computeGeometry(this.elapsed, this.passDuration);
        const snrDb = computeSNR(geo.distanceKm);
        const atmPenalty = computeAtmPenalty(geo.elevationDeg);
        const scintFadeDb = computeScintillation(now, geo.elevationDeg, deltaMs, this.mode);
        this.lastScintFade = scintFadeDb;

        return {
          elevationDeg: geo.elevationDeg,
          distanceKm: geo.distanceKm,
          snrDb,
          dopplerShiftHz: geo.dopplerShiftHz,
          dopplerRateHzPerSec: geo.dopplerRateHzPerSec,
          atmPenalty,
          scintFadeDb,
          inPass: true,
          source: 'sim'
        };
      }

      reset() {
        this.elapsed = 0;
        this.inPass = true;
        this.interPassRemaining = 0;
        this.tickCount = 0;
        this.lastScintFade = 0;
      }
    }

    // ============================================================================
    // LAYER 3: STATE MACHINE
    // ============================================================================

    const SAT_STATE = Object.freeze({
      COLD_START: 'COLD_START',
      SCANNING: 'SCANNING',
      ACQUIRING: 'ACQUIRING',
      TRACKING: 'TRACKING',
      DEGRADED: 'DEGRADED',
      LOSING_LOCK: 'LOSING_LOCK',
      RE_ACQUIRING: 'RE_ACQUIRING'
    });

    class SatelliteStateMachine {
      /**
       * @param {SatelliteChannelSimulator} channel
       */
      constructor(channel) {
        this.channel = channel;
        this.state = SAT_STATE.COLD_START;
        this.stateTimer = 0;
        this.lqmHistory = [];
        this.lastResult = null;

        this.coldStartDuration = this._randomColdStart();
        this.lastLQM = null;
      }

      _randomColdStart() {
        return SAT_CONSTANTS.COLD_START_MIN_MS +
               Math.random() * (SAT_CONSTANTS.COLD_START_MAX_MS - SAT_CONSTANTS.COLD_START_MIN_MS);
      }

      /**
       * Update state machine.
       * @param {number} deltaMs
       * @param {Date} [now]
       * @param {object|null} [externalGeo] - geometri TLE opsional
       * @returns {object} result
       */
      update(deltaMs, now = new Date(), externalGeo = null) {
        // Validate deltaMs
        if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
          return this.lastResult ?? {
            state: this.state, metrics: null, lqm: null, packetValid: false
          };
        }
        const dt = Math.min(deltaMs, SAT_CONSTANTS.MAX_DELTA_MS);

        this.stateTimer += dt;
        const metrics = this.channel.tick(dt, now, externalGeo);

        // Hitung LQM
        let lqm;
        if (!metrics.inPass || metrics.elevationDeg < SAT_CONSTANTS.MIN_ELEVATION_DEG) {
          lqm = -Infinity;
        } else {
          lqm = calculateLQM({
            snrDb: metrics.snrDb,
            dopplerRateHzPerSec: metrics.dopplerRateHzPerSec,
            elevationDeg: metrics.elevationDeg,
            scintFadeDb: metrics.scintFadeDb
          });
        }
        this.lastLQM = lqm;

        // Update history — hanya di state yang relevan
        const trackedStates = [
          SAT_STATE.ACQUIRING,
          SAT_STATE.TRACKING,
          SAT_STATE.DEGRADED,
          SAT_STATE.RE_ACQUIRING
        ];
        if (trackedStates.includes(this.state)) {
          this.lqmHistory.push(lqm);
          if (this.lqmHistory.length > SAT_CONSTANTS.HISTORY_SIZE) {
            this.lqmHistory.shift();
          }
        }

        // Transisi state
        switch (this.state) {
          case SAT_STATE.COLD_START:
            if (this.stateTimer >= this.coldStartDuration) {
              this._transitionTo(SAT_STATE.SCANNING);
            }
            break;

          case SAT_STATE.SCANNING:
            // Beacon deteksi: elevasi valid + LQM > DEGRADED - 3 dB
            if (metrics.elevationDeg >= SAT_CONSTANTS.MIN_ELEVATION_DEG && lqm > -6) {
              this._transitionTo(SAT_STATE.ACQUIRING, true);
            } else if (this.stateTimer >= SAT_CONSTANTS.SCAN_TIMEOUT_MS) {
              this._transitionTo(SAT_STATE.COLD_START);
              this.coldStartDuration = this._randomColdStart();
            }
            break;

          case SAT_STATE.ACQUIRING: {
            // Butuh sustained valid
            const recent = this.lqmHistory.slice(-SAT_CONSTANTS.SUSTAINED_SAMPLES);
            const sustainedValid = recent.length >= SAT_CONSTANTS.SUSTAINED_SAMPLES &&
              recent.every(v => v >= SAT_CONSTANTS.LQM_THRESHOLD_VALID_DB);

            if (sustainedValid) {
              this._transitionTo(SAT_STATE.TRACKING);
            } else if (lqm < SAT_CONSTANTS.LQM_THRESHOLD_DEGRADED_DB || this.stateTimer >= 30000) {
              this._transitionTo(SAT_STATE.SCANNING, true);
            }
            break;
          }

          case SAT_STATE.TRACKING: {
            if (lqm >= SAT_CONSTANTS.LQM_THRESHOLD_VALID_DB) {
              // Paket bisa dikirim
              const ber = getBER(
                metrics.snrDb + SAT_CONSTANTS.PROCESSING_GAIN_DB,
                metrics.elevationDeg
              );
              const per = getPER(ber);
              const packetValid = Math.random() >= per;

              this.lastResult = {
                state: SAT_STATE.TRACKING,
                metrics,
                lqm,
                ber,
                per,
                packetValid
              };
              return this.lastResult;
            } else if (lqm >= SAT_CONSTANTS.LQM_THRESHOLD_DEGRADED_DB) {
              this._transitionTo(SAT_STATE.DEGRADED);
            } else {
              this._transitionTo(SAT_STATE.LOSING_LOCK);
            }
            break;
          }

          case SAT_STATE.DEGRADED: {
            if (lqm >= SAT_CONSTANTS.LQM_THRESHOLD_VALID_DB) {
              this._transitionTo(SAT_STATE.TRACKING);
            } else if (lqm < SAT_CONSTANTS.LQM_THRESHOLD_DEGRADED_DB && this.stateTimer >= 5000) {
              this._transitionTo(SAT_STATE.LOSING_LOCK);
            }
            break;
          }

          case SAT_STATE.LOSING_LOCK:
            this._transitionTo(SAT_STATE.RE_ACQUIRING);
            break;

          case SAT_STATE.RE_ACQUIRING: {
            const recent = this.lqmHistory.slice(-5);
            const sustainedValid = recent.length >= 5 &&
              recent.every(v => v >= SAT_CONSTANTS.LQM_THRESHOLD_VALID_DB);

            if (sustainedValid) {
              this._transitionTo(SAT_STATE.TRACKING);
            } else if (this.stateTimer >= SAT_CONSTANTS.RE_ACQ_WINDOW_MS) {
              this._transitionTo(SAT_STATE.SCANNING, true);
            }
            break;
          }
        }

        this.lastResult = {
          state: this.state,
          metrics,
          lqm: lqm === -Infinity ? -Infinity : lqm,
          packetValid: false
        };
        return this.lastResult;
      }

      _transitionTo(newState, clearHistory = false) {
        this.state = newState;
        this.stateTimer = 0;
        if (clearHistory) this.lqmHistory = [];
      }

      reset() {
        this.state = SAT_STATE.COLD_START;
        this.stateTimer = 0;
        this.lqmHistory = [];
        this.coldStartDuration = this._randomColdStart();
        this.lastResult = null;
        this.lastLQM = null;
        this.channel.reset();
      }
    }



    let _instance = null;

    function createSatelliteLink(options = {}) {
      const channel = new SatelliteChannelSimulator(options);
      const sm = new SatelliteStateMachine(channel);
      return { channel, sm, options };
    }

    function getSatelliteLink(options) {
      if (options !== undefined || _instance === null) {
        _instance = createSatelliteLink(options ?? {});
      }
      return _instance;
    }

    function resetSatelliteLink(options) {
      _instance = createSatelliteLink(options ?? {});
      return _instance;
    }

    // ============================================================================
    // PUBLIC API — updateSatelliteLink
    // ============================================================================

    /**
     * Update satellite link state.
     * @param {number} deltaMs
     * @param {object} [options] { now, externalGeo }
     *   externalGeo: { elevationDeg, distanceKm, dopplerShiftHz?, dopplerRateHzPerSec?, name? }
     * @returns {object} result
     */
    function updateSatelliteLink(deltaMs, options = {}) {
      const { sm } = getSatelliteLink();
      const result = sm.update(
        deltaMs,
        options.now ?? new Date(),
        options.externalGeo ?? null
      );

      return result;
    }

    /**
     * Evaluasi link budget murni dari geometri eksternal (TLE), tanpa state machine.
     * Berguna untuk ranking multi-satelit / channel list.
     * @param {object} geo { elevationDeg, distanceKm, dopplerRateHzPerSec?, scintFadeDb? }
     * @param {string} [mode]
     * @param {Date} [now]
     */
    function evaluateLinkFromGeo(geo, mode = PHYSICS_MODE.REALISTIC, now = new Date()) {
      const elevationDeg = geo?.elevationDeg ?? 0;
      const distanceKm = geo?.distanceKm ?? Infinity;
      if (elevationDeg < SAT_CONSTANTS.MIN_ELEVATION_DEG || !Number.isFinite(distanceKm)) {
        return {
          elevationDeg,
          distanceKm,
          snrDb: -Infinity,
          lqm: -Infinity,
          atmPenalty: 99,
          scintFadeDb: 0,
          ber: 0.5,
          per: 1,
          usable: false
        };
      }
      const snrDb = computeSNR(distanceKm);
      const atmPenalty = computeAtmPenalty(elevationDeg);
      const scintFadeDb = geo.scintFadeDb != null
        ? geo.scintFadeDb
        : computeScintillation(now, elevationDeg, 1000, mode);
      const dopplerRateHzPerSec = geo.dopplerRateHzPerSec ?? 0;
      const lqm = calculateLQM({
        snrDb,
        dopplerRateHzPerSec,
        elevationDeg,
        scintFadeDb
      });
      const ebn0 = snrDb + SAT_CONSTANTS.PROCESSING_GAIN_DB;
      const ber = getBER(ebn0, elevationDeg);
      const per = getPER(ber);
      return {
        elevationDeg,
        distanceKm,
        snrDb,
        atmPenalty,
        scintFadeDb,
        dopplerRateHzPerSec,
        lqm,
        ber,
        per,
        usable: lqm >= SAT_CONSTANTS.LQM_THRESHOLD_DEGRADED_DB
      };
    }


    function runSelfTest() {
      const results = [];
      const assert = (name, cond, info = '') => results.push({ name, pass: !!cond, info });
      try {
        const fspl = computeFSPL(780);
        assert('FSPL @ 780 km ≈ 154.5 dB', Math.abs(fspl - 154.48) < 1, `got ${fspl.toFixed(2)}`);
        const snr = computeSNR(780);
        assert('SNR @ 780 km ≈ 11 dB', Math.abs(snr - 11.12) < 1, `got ${snr.toFixed(2)}`);
        const geo = computeGeometry(275, 550);
        assert('Doppler rate awal pass', Math.abs(Math.abs(geo.dopplerRateHzPerSec) - 231) < 50, `got ${geo.dopplerRateHzPerSec.toFixed(1)}`);
        const lqm = calculateLQM({snrDb:11.12,dopplerRateHzPerSec:0,elevationDeg:75,scintFadeDb:0});
        assert('LQM zenith > 35 dB', lqm > 35, `got ${lqm.toFixed(2)}`);
        const ber = getBER(6,45);
        assert('BER @ 6 dB within Rician K7 range', ber > 1e-7 && ber < 1e-4, `got ${ber.toExponential(2)}`);
        const per = getPER(1e-5,256);
        assert('PER @ BER 1e-5 / 256 bit', Math.abs(per - 0.00256) < 0.001, `got ${(per*100).toFixed(3)}%`);
        const link = createSatelliteLink({passDurationSec:550,mode:PHYSICS_MODE.IDEAL});
        link.sm.coldStartDuration = 100;
        const nowDate = new Date(2025,5,15,12,0,0);
        let tracking = false;
        for(let i=0;i<500;i++){ const r=link.sm.update(100,nowDate); if(r.state===SAT_STATE.TRACKING){tracking=true;break;} }
        assert('State machine reaches TRACKING', tracking, `final ${link.sm.state}`);
        const link2=createSatelliteLink({passDurationSec:550,mode:PHYSICS_MODE.IDEAL});
        link2.sm.state=SAT_STATE.TRACKING; link2.sm.stateTimer=0; link2.channel.elapsed=275;
        const orig=link2.channel.tick.bind(link2.channel);
        link2.channel.tick=(dt,n)=>{const m=orig(dt,n);m.scintFadeDb=-35;return m;};
        let degraded=false;
        for(let i=0;i<50;i++){const r=link2.sm.update(100,nowDate);if(r.state===SAT_STATE.DEGRADED){degraded=true;break;}}
        assert('State machine reaches DEGRADED', degraded, `final ${link2.sm.state}`);
        const link3=createSatelliteLink();
        assert('Invalid delta does not crash', link3.sm.update(NaN)!==null && link3.sm.update(0)!==null && link3.sm.update(999999)!==null);
      } catch(e) { results.push({name:'physics-self-test-exception',status:'FAIL',pass:false,info:String(e.message||e)}); }
      const pass=results.filter(x=>x.pass).length;
      const fail=results.length-pass;
      return {pass,fail,total:results.length,results,verified:fail===0};
    }

    return Object.freeze({SAT_CONSTANTS,PHYSICS_MODE,SAT_STATE,SatelliteChannelSimulator,SatelliteStateMachine,createSatelliteLink,getSatelliteLink,resetSatelliteLink,updateSatelliteLink,evaluateLinkFromGeo,computeGeometry,computeFSPL,computeSNR,computeAtmPenalty,computeScintillation,calculateLQM,getBER,getPER,runSelfTest});
  })();

  function selfTestInner(){const results=[];const test=(name,fn)=>{try{fn();results.push({name,status:"PASS"})}catch(e){results.push({name,status:"FAIL",error:String(e.message||e)})}};const pt=CGOPhysics.runSelfTest();if(!pt.verified)throw Error("physics kernel self-test failed: "+pt.results.filter(x=>!x.pass).map(x=>x.name).join(","));results.push({name:"physics-kernel",status:"PASS"});test("fingerprint",()=>{if(fingerprint("a")!==fingerprint("a"))throw Error("unstable")});test("delimiter-comment-regex",()=>{if(!balancedDelimiters("const x=/\\{/; // }\n{a:1}").balanced)throw Error("false negative")});test("auto-format",()=>{if(classifyText('{"a":1}').format!=="json")throw Error("json")});test("html-relations-duplicates",()=>{const h=extractHtml('<div id="x"></div><span id="x"><a href="/a"></a>');if(!h.duplicateIds.includes("x")||!h.references.includes("/a"))throw Error("html regression")});test("envelope-validator",()=>{const r=assertEnvelope({__cgoMachineInjection:true,contentMode:"bad",payload:{}});if(r.valid)throw Error("invalid envelope accepted")});test("pipeline",()=>{const o=runCycle("hello world");if(!o.result||!o.audit)throw Error("pipeline")});test("external-evidence-propagation",()=>{const o=runCycle("hello",{externalEvidence:{schema:"CGO_EXTERNAL_EVIDENCE_V1",source:"TEST_REAL_INPUT",capturedAt:now(),claims:[{source:"TEST_REAL_INPUT",target:"observed-target",status:"ANOMALY",severity:"HIGH",message:"observed failure"}],fingerprint:"evidence-test"}});if(o.pipeline.B.findings.filter(x=>x.type==="EXTERNAL_EVIDENCE").length!==1||o.pipeline.C.status!=="PARTIAL"||o.audit.status!=="ATTENTION")throw Error("external evidence not propagated")});test("batch",()=>{const o=CGOMachineABC.processMany(["a","b"]);if(o.pipeline.B.items?.length!==2)throw Error("batch")});test("batch-unknowns-aggregate",()=>{let nested={__cgoBatchInjection:true,version:VERSION,items:[]};for(let i=0;i<MAX_BATCH_DEPTH;i++)nested={__cgoBatchInjection:true,version:VERSION,items:[nested]};const rep=MachineA.process(nested);if(!rep.unknowns.some(x=>x.type==="BATCH_DEPTH_LIMIT"&&x.itemIndex===0))throw Error("batch unknown not aggregated")});test("c-injection",()=>{const o=runCycle("x");const inj=MachineC.inject(o.result);const q=runCycle(inj);if(!q.result)throw Error("injection")});test("auto-step",()=>{const o=runCycle("plain text",{});if(o.pipeline.B.operations.includes("SYNTAX_ANALYSIS"))throw Error("text syntax should be skipped");if(!o.pipeline.B.operations.includes("CONTENT_INSPECTION"))throw Error("content step missing")});test("custom-step-selection",()=>{const o=runCycle("hello",{steps:["structure"]});if(!o.pipeline.B.operations.includes("STRUCTURE_INSPECTION")||o.pipeline.B.operations.includes("CONTENT_INSPECTION")||o.pipeline.B.decision!==null)throw Error("custom steps")});test("auto-reflect",()=>{const o=reflect("hello",{maxCycles:3,stopOnStatus:"__NEVER__"});if(!Array.isArray(o.cycles)||o.cycles.length<2||!o.finalResult)throw Error("reflect")});test("reflect-actually-reflects",()=>{const o=reflect("hello",{maxCycles:2,stopOnStatus:"__NEVER__"});const first=o.cycles[0].result;if(o.cycles.length<2||fingerprint(o.cycles[1].pipeline.A.content.value)!==fingerprint(first))throw Error("reflection payload not processed")});test("stream",()=>{let n=0;CGOMachineABC.stream("hello",{onCycle:()=>n++});if(n<1)throw Error("stream")});test("stream-real-time",()=>{const seen=[];CGOMachineABC.stream("hello",{autoReflect:true,maxCycles:3,stopOnStatus:"__NEVER__",minConfidenceDelta:0,onCycle:c=>seen.push(c.cycleIndex)});if(seen.length!==3||seen[0]!==0||seen[1]!==1||seen[2]!==2)throw Error("buffered stream")});test("observe",()=>{let n=0;const off=CGOMachineABC.observe(()=>n++);CGOMachineABC.process("observe");off();if(n!==1)throw Error("observe")});test("stream-observe",()=>{let n=0;const off=CGOMachineABC.observe(()=>n++);CGOMachineABC.stream("observe-stream",{autoReflect:true,maxCycles:2,stopOnStatus:"__NEVER__"});off();if(n!==2)throw Error("stream observe")});test("independence",()=>{const a=auditIndependence();if(!a.verified||a.scannedFunctions<8)throw Error("independence")});test("machine-D",()=>{const o=CGOMachineABC.process("audit");if(o.audit?.status!=="VALID")throw Error("audit failed")});test("audit-tamper-C-payload",()=>{const o=CGOMachineABC.process("tamper");o.pipeline.C.findings.push({fake:true});const d=MachineD.audit(o,"tamper");if(d.status!=="ATTENTION"||!d.checks.some(x=>x.type==="C_PAYLOAD_HASH"&&x.status==="FAIL"))throw Error("tamper undetected")});test("b-batch-depth-guard",()=>{const rep=MachineA.process({__cgoBatchInjection:true,items:[],version:VERSION},{batchDepth:MAX_BATCH_DEPTH});const b=MachineB.process({...rep,structure:{kind:"batch",count:0},content:{mode:"batch",value:[]}}, {batchDepth:MAX_BATCH_DEPTH});if(b.decision?.reason!=="batch_depth_limit")throw Error("guard")});test("record-verification",()=>{const o=runCycle({name:"cgo",value:1});const checks=o.pipeline.B.verification;if(!checks.some(x=>x.type==="RECORD_PRESENT"&&x.status==="PASS"))throw Error("record check missing")});test("collection-verification",()=>{const o=runCycle([{id:1}]);if(!o.pipeline.B.verification.some(x=>x.type==="COLLECTION_PRESENT"&&x.status==="PASS"))throw Error("collection check missing")});test("nan-infinity",()=>{if(CGOMachineABC.process(Infinity).pipeline.A.content.value!=="Infinity")throw Error("infinity")});test("max-input-override",()=>{const o=CGOMachineABC.process("abc",{maxInputSize:10});if(!o.result)throw Error("override")});test("skipped-steps",()=>{const o=CGOMachineABC.process("abc",{steps:["structure"]});if(!o.pipeline.B.skippedSteps.includes("content"))throw Error("skipped")});test("degraded-field",()=>{if(typeof CGOMachineABC.process("abc").pipeline.B.degraded!=="boolean")throw Error("degraded")});test("errors-array",()=>{if(!Array.isArray(CGOMachineABC.process("abc").pipeline.B.errors))throw Error("errors")});test("fallback-array",()=>{if(!Array.isArray(CGOMachineABC.process("abc").pipeline.C.fallbacks))throw Error("fallback")});test("weighted-check",()=>{const o=CGOMachineABC.process("abc");if(!o.pipeline.B.verification[0].status)throw Error("check")});test("contradiction-severity",()=>{const o=CGOMachineABC.process('<!doctype html><html><div id="x"></div><span id="x"></span></html>');if(!o.pipeline.B.contradictions.some(x=>x.severity))throw Error("severity")});test("decision-hierarchy",()=>{const o=CGOMachineABC.process({x:1});if(!["PROCESSED","WELL_FORMED","PARTIAL","DEGRADED","CONTRADICTION","UNRESOLVED"].includes(o.result.status))throw Error("status")});test("machineD-fallback-check",()=>{const o=CGOMachineABC.process("abc");if(!o.audit.checks.some(x=>x.type==="FALLBACK_CHAIN"))throw Error("fallback audit")});test("replay-shape",()=>{const o=CGOMachineABC.process("abc"),r=CGOMachineABC.replay(o);if(!Array.isArray(r.steps))throw Error("replay")});test("verify-replay",()=>{const o=CGOMachineABC.process("abc"),r=CGOMachineABC.replay(o);if(CGOMachineABC.verifyReplay(o,r).status!=="MATCH")throw Error("verify replay")});test("metrics-reset",()=>{const before=CGOMachineABC.getMetrics().totalProcessed;CGOMachineABC.resetMetrics();if(CGOMachineABC.getMetrics().totalProcessed!==0||before<0)throw Error("reset")});test("state-cycle-index",()=>{const o=CGOMachineABC.process("state");if(CGOMachineABC.getState().lastCycleIndex!==0)throw Error("state cycle")});test("pause-reflect",()=>{CGOMachineABC.pause();const r=CGOMachineABC.reflect("pause",{maxCycles:2});CGOMachineABC.resume();if(r.stopReason!=="paused")throw Error("pause reflect")});test("reflect-direct-C",()=>{const r=CGOMachineABC.reflect("abc",{maxCycles:2,stopOnStatus:"__NEVER__",minConfidenceDelta:0});if(r.cycles.length!==2||r.cycles[1].pipeline.A.content.mode!=="record")throw Error("direct C")});test("stream-complete",()=>{let done=false;CGOMachineABC.stream("abc",{onComplete:()=>done=true});if(!done)throw Error("complete")});test("stream-batch-summary",()=>{const o=CGOMachineABC.processMany(["a","b"],{streamBatch:true});if(o.pipeline.C.batch.items.some(x=>x.analysis===undefined))throw Error("summary")});test("date-input",()=>{if(CGOMachineABC.process(new Date()).pipeline.A.input.type!=="date")throw Error("date")});test("object-freeze",()=>{if(!Object.isFrozen(CGOMachineABC))throw Error("freeze")});test("fingerprint-undefined",()=>{const o=CGOMachineABC.process(undefined);if(!o.result||!o.audit)throw Error("undefined crash")});test("digest-sha256-vectors",()=>{if(sha256Hex("abc")!=="ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"||sha256Hex("")!=="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"||sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")!=="248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1")throw Error("sha256")});test("utf8-fallback-availability",()=>{if(typeof utf8Encode!=="function"||utf8Encode("Cikur 🚀").length<8)throw Error("utf8 encoder")});test("digest-key-order",()=>{if(digest({a:1,b:2})!==digest({b:2,a:1}))throw Error("order")});test("prose-not-delimiter-checked",()=>{const o=CGOMachineABC.process("Halo :) tolong 1) cek saldo (dulu");if(o.pipeline.A.content.syntax.delimiters||o.result.status==="PARTIAL")throw Error("prose flagged")});test("let-me-know-is-text",()=>{if(classifyText("let me know if you can help").format!=="text")throw Error("prose as code")});test("regex-after-return",()=>{if(!balancedDelimiters("function f(s){ return /[)]/.test(s) }").balanced)throw Error("regex heuristic")});test("pause-blocks-process",()=>{CGOMachineABC.pause();const o=CGOMachineABC.process("x");const st=CGOMachineABC.stream("x");CGOMachineABC.resume();if(!o.skipped||st.status!=="PAUSED")throw Error("pause ignored")});test("stop-reason-to-observer",()=>{let got=null;const off=CGOMachineABC.observe(p=>{got=p});CGOMachineABC.process("abc",{autoReflect:true,maxCycles:3,stopOnStatus:"__NEVER__",minConfidenceDelta:0});off();if(!got||got.stopReason!=="maxCycles")throw Error("stopReason lost")});test("map-set-preserved",()=>{const o=CGOMachineABC.process({m:new Map([[1,2]]),s:new Set([7])});const v=o.pipeline.A.content.value;if(v.m.__cgoType!=="Map"||v.s.values[0]!==7)throw Error("map/set lost")});test("required-fields",()=>{const o=CGOMachineABC.process({nama:"",hp:"1"},{requiredFields:["nama","email"]});const t=o.pipeline.B.contradictions.map(x=>x.type);if(!t.includes("REQUIRED_FIELD_EMPTY")||!t.includes("REQUIRED_FIELD_MISSING")||o.result.status!=="PARTIAL")throw Error("required")});test("json-string-structure",()=>{const o=CGOMachineABC.process('{"nama":"","hp":null}');if(o.pipeline.B.constraints.filter(x=>x.type==="EMPTY_FIELD").length!==2)throw Error("json string not analysed")});test("dup-id-single-contradiction",()=>{const o=CGOMachineABC.process('<!doctype html><html><div id="x"></div><span id="x"></span></html>');if(o.pipeline.B.contradictions.filter(x=>x.type==="DUPLICATE_IDENTIFIER").length!==1)throw Error("double count")});test("reflect-default-stop",()=>{const o=CGOMachineABC.reflect("hello",{maxCycles:5});if(o.stopReason!=="status")throw Error("default stop never fires")});
    test("full-pipeline-trace",()=>{const o=CGOMachineABC.process("full-trace",{fast:false,skipAudit:false});if(!o.pipelineTrace||o.pipelineTrace.length!==4)throw Error("pipeline trace missing");if(o.pipelineTrace[2].status!=="COMPLETED")throw Error("C not completed");if(o.pipelineTrace[3].status!=="COMPLETED"||o.audit?.status!=="VALID")throw Error("D not completed")});
    test("phase-telemetry-route",()=>{const o=CGOMachineABC.process("telemetry-route",{fast:false,skipAudit:false});if(o.version!==VERSION||o.telemetry?.route!=="A>B>C>D"||o.telemetry?.routeStatus!=="COMPLETE"||!o.telemetry?.fingerprint||o.telemetry.phases.length!==4)throw Error("phase telemetry missing")});
    test("telemetry-observer",()=>{let n=0;const off=CGOMachineABC.observeTelemetry(e=>{if(e.type==="ABC_TELEMETRY")n++});CGOMachineABC.process("telemetry-observer");off();if(n<8)throw Error("telemetry events missing")});    return{passed:results.filter(x=>x.status==="PASS").length,failed:results.filter(x=>x.status==="FAIL").length,total:results.length,results,verified:results.every(x=>x.status==="PASS")}}

  function selfTest(){
    // Self-test tidak boleh meninggalkan jejak: metrics, state, observer, dan status pause dipulihkan.
    const wasPaused=paused,savedState={...runtimeState},savedMetrics={...metrics},savedObs=[...observers],savedTelemetryObs=[...telemetryObservers];
    paused=false;observers.clear();telemetryObservers.clear();
    try{return selfTestInner()}
    finally{paused=wasPaused;Object.assign(runtimeState,savedState);Object.assign(metrics,savedMetrics);observers.clear();savedObs.forEach(fn=>observers.add(fn));telemetryObservers.clear();savedTelemetryObs.forEach(fn=>telemetryObservers.add(fn))}
  }
  const CGOMachineABC={name:"CGO_MACHINE_ABC",version:VERSION,A:MachineA,B:MachineB,C:MachineC,D:MachineD,physics:CGOPhysics,physicsSelfTest:()=>CGOPhysics.runSelfTest(),inject:(v,o={})=>MachineC.inject(v,o),createBatchInjection(inputs,o={}){if(!Array.isArray(inputs))throw new TypeError("createBatchInjection membutuhkan array input.");const v=validateInput(inputs,o);if(!v.valid)throw new TypeError(v.reason);return{__cgoBatchInjection:true,version:VERSION,mode:"batch",transport:"internal",createdAt:now(),items:inputs.slice(0,MAX_ITEMS).map(clone),metadata:clone(o.metadata??{})}},processMany(inputs,o={}){return CGOMachineABC.process(CGOMachineABC.createBatchInjection(inputs,o),{...o,source:o.source??"batch-injection"})},process(input,options={}){if(paused)return pausedResult();const v=validateInput(input,options);if(!v.valid)throw new TypeError(v.reason);metrics.totalProcessed++;if(toBool(options.autoReflect,false)){const r=reflect(v.sanitized,options);const packet={engine:"CGO_MACHINE_ABC",version:VERSION,cycles:r.cycles,finalResult:r.finalResult,stopReason:r.stopReason,audit:r.cycles.at(-1)?.audit||null,reflected:true};notify(packet,r.cycles);return packet}const out=runCycle(v.sanitized,options,0);notify(out,[out]);return out},stream(input,options={}){if(paused){const pr=pausedResult();options.onComplete?.(pr.result);return pr.result}const v=validateInput(input,options);if(!v.valid)throw new TypeError(v.reason);if(options.autoReflect===true){const r=reflect(v.sanitized,{...options,onCycle:c=>{options.onCycle?.(c);notify(c,[c])}});options.onComplete?.(r.finalResult,r.stopReason);return r.finalResult}const c=runCycle(v.sanitized,options,0);options.onCycle?.(c);notify(c,[c]);options.onComplete?.(c.result);return c.result},observe(handler){if(typeof handler!=="function")throw new TypeError("observe(handler) membutuhkan function");observers.add(handler);return()=>observers.delete(handler)},observeTelemetry(handler){if(typeof handler!=="function")throw new TypeError("observeTelemetry(handler) membutuhkan function");telemetryObservers.add(handler);return()=>telemetryObservers.delete(handler)},auditIndependence,selfTest,validateOutput,validateInput,safeClone,reflect,replay:(p)=>MachineD.replay(p),verifyReplay:(p,r)=>MachineD.verifyReplay(p,r),pause(){paused=true;runtimeState.paused=true;runtimeState.pauseAt=now()},resume(){paused=false;runtimeState.paused=false;runtimeState.pauseAt=null},isPaused:()=>paused,getState:()=>clone(runtimeState),getMetrics:()=>({totalProcessed:metrics.totalProcessed,totalCycles:metrics.totalCycles,avgConfidence:metrics.totalCycles?metrics.confidenceSum/metrics.totalCycles:0,degradedCount:metrics.degradedCount,errorCount:metrics.errorCount,skippedWhilePaused:metrics.skippedWhilePaused,lastStatus:metrics.lastStatus}),sha256:sha256Hex,digest,resetMetrics(){Object.assign(metrics,{totalProcessed:0,totalCycles:0,confidenceSum:0,degradedCount:0,errorCount:0,skippedWhilePaused:0,lastStatus:null});return CGOMachineABC.getMetrics()}};
  function pausedResult(){metrics.skippedWhilePaused++;const result={machine:"C",stage:"result",version:VERSION,status:"PAUSED",summary:null,findings:[],relations:[],inferences:[],hypotheses:[],constraints:[],contradictions:[],reasoning:[],reasoningTrace:[],evidence:[],uncertainty:[],verification:[],decision:{status:"PAUSED",confidence:0,reason:"engine_paused"},errors:[],fallbacks:[],metadata:{generatedAt:now()}};return{engine:"CGO_MACHINE_ABC",version:VERSION,paused:true,skipped:true,result,audit:null}}
  function notify(result,cycles){const payload={result:result?.result??result,cycles:Array.isArray(cycles)?cycles:cycles?[cycles]:[],stopReason:result?.stopReason??null,timestamp:now()};for(const fn of [...observers]){try{fn(payload)}catch(_){}}}
  [MachineA,MachineB,MachineC,MachineD].forEach(m=>Object.freeze(m));Object.freeze(CGOMachineABC);if(typeof module!=="undefined"&&module.exports)module.exports=CGOMachineABC;global.CGOMachineABC=CGOMachineABC;global.CGO=CGOMachineABC;
})(typeof globalThis!=="undefined"?globalThis:window);


  // Otak Jenius bridge — expose helpers for ABC UI / voice
  try {
    if (typeof window !== "undefined") {
      window.CGO_OTAK_BRIDGE = {
        version: "3.0.0",
        ready: function(){ return !!(window.CIKURGO && window.CIKURGO.nalar); },
        ringkas: function(status, conf, findings){
          try {
            if (!window.CIKURGO) return null;
            var pct = Math.round((Number(conf)||0)*100);
            var num = function(n){ try { return window.CIKURGO.angkaKeKata(Number(n)||0,"id"); } catch(e){ return String(n); } };
            var base = "Status "+String(status||"IDLE")+". Keyakinan "+num(pct)+" persen.";
            if (findings && findings.length) base += " Ditemukan "+num(findings.length)+" temuan.";
            if (window.CIKURGO.nalar) {
              var r = window.CIKURGO.nalar(base,{bahasa:"id"});
              return String((r && (r.kesimpulan||r.hasil)) || base).slice(0,220);
            }
            return base;
          } catch(e){ return null; }
        },
        urai: function(teks){
          try { return window.CIKURGO && window.CIKURGO.urai ? window.CIKURGO.urai(String(teks||""),"auto","id") : null; } catch(e){ return null; }
        }
      };
    }
  } catch (_) {}
