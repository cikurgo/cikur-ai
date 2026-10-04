/*
 * CGO MACHINE ABC — UNIVERSAL CORE ENGINE
 * Version 0.13.0-ADVANCED-REPAIR (lihat konstanta VERSION)
 * Zero External · Zero API · Zero Network · Domain Neutral
 * A = INGEST / PARSE / REPRESENT
 * B = ANALYZE / RELATE / VERIFY / REASON
 * C = SYNTHESIZE / VALIDATE / EMIT
 * D = AUDIT / INTEGRITY / REPLAY
 */
(function (global) {
  "use strict";

  const VERSION = "0.13.0-ADVANCED-REPAIR";
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
    if(claims.length && !packet.fingerprint) s.uncertainty.push({type:"EXTERNAL_EVIDENCE_UNFINGERPRINTED",severity:"LOW",source:packet.source??null});
  }
  // Physics Kernel dipanggil hanya bila caller menyediakan physicalEvidence.
  // Default path ABC tetap domain-neutral dan tidak menjalankan fisika untuk input biasa.
  function ingestPhysicsEvidenceB(s, packet, options={}){
    if(!packet || typeof packet!=="object") return;
    const geo=packet.geo&&typeof packet.geo==="object"?packet.geo:packet;
    if(!Number.isFinite(geo.elevationDeg)||!Number.isFinite(geo.distanceKm)){
      s.operations.push("PHYSICS_EVIDENCE_REVIEW");
      s.uncertainty.push({type:"PHYSICS_INPUT_INCOMPLETE",severity:"HIGH",required:["elevationDeg","distanceKm"]});
      s.verification.push({type:"PHYSICS_EVIDENCE",status:"UNKNOWN",reason:"geometry_incomplete"});
      return;
    }
    const mode=packet.mode??options.physicsMode??CGOPhysics.PHYSICS_MODE.REALISTIC;
    const when=packet.now instanceof Date?packet.now:(packet.now?new Date(packet.now):new Date());
    const link=CGOPhysics.evaluateLinkFromGeo(geo,mode,when);
    const validThreshold=CGOPhysics.PHYSICS_CONSTANTS.LQM_THRESHOLD_VALID_DB;
    const degradedThreshold=CGOPhysics.PHYSICS_CONSTANTS.LQM_THRESHOLD_DEGRADED_DB;
    s.operations.push("PHYSICS_EVALUATION");
    s.findings.push({type:"PHYSICS_LINK_EVALUATION",source:packet.source??"CGO_PHYSICS",mode,elevationDeg:link.elevationDeg,distanceKm:link.distanceKm,lqm:link.lqm,snrDb:link.snrDb,atmPenalty:link.atmPenalty,dopplerRateHzPerSec:link.dopplerRateHzPerSec,scintFadeDb:link.scintFadeDb,ber:link.ber,per:link.per,usable:link.usable});
    s.evidence.push({type:"PHYSICS_LINK_METRICS",source:packet.source??"CGO_PHYSICS",mode,metrics:clone(link)});
    if(!link.usable){
      const critical=link.elevationDeg<CGOPhysics.PHYSICS_CONSTANTS.MIN_ELEVATION_DEG;
      s.contradictions.push({type:"PHYSICS_LINK_UNUSABLE",severity:critical?"CRITICAL":"HIGH",reason:critical?"below_minimum_elevation":"lqm_below_degraded_threshold",metrics:clone(link)});
      s.verification.push({type:"PHYSICS_EVIDENCE",status:"FAIL",reason:"link_unusable",lqm:link.lqm});
    }else if(link.lqm<validThreshold){
      s.uncertainty.push({type:"PHYSICS_LINK_DEGRADED",severity:"MEDIUM",lqm:link.lqm,threshold:validThreshold,per:link.per});
      s.verification.push({type:"PHYSICS_EVIDENCE",status:"UNKNOWN",reason:"link_degraded",lqm:link.lqm});
    }else{
      s.verification.push({type:"PHYSICS_EVIDENCE",status:"PASS",reason:"link_quality_valid",lqm:link.lqm,per:link.per});
    }
    s.inferences.push({type:"PHYSICS_EVIDENCE_CONSIDERED",basis:["link_budget","propagation_penalties","effective_ebn0","ber_per"],usable:link.usable,lqm:link.lqm});
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
  function decideB(s,options={}){if(s.errors?.length||s.degraded)return{status:"DEGRADED",confidence:confidenceB(s,options),reason:"step_error"};if(s.uncertainty.some(x=>x.type==="INSUFFICIENT_REPRESENTATION"))return{status:"UNRESOLVED",confidence:0,reason:"insufficient_representation"};const failed=s.verification.filter(x=>x.status==="FAIL").length;const critical=s.contradictions.some(x=>x.severity==="CRITICAL");const highContr=s.contradictions.some(x=>x.severity==="HIGH");const confidence=confidenceB(s,options);if(critical)return{status:"CONTRADICTION",confidence,reason:"critical_contradiction"};if(highContr)return{status:"PARTIAL",confidence,reason:"high_contradiction"};if(failed||s.uncertainty.some(x=>x.severity==="HIGH"))return{status:"PARTIAL",confidence,reason:failed?"verification_failed":"high_uncertainty",failedChecks:failed};if(s.uncertainty.some(x=>x.severity==="MEDIUM")){const med=s.uncertainty.filter(x=>x.severity==="MEDIUM");const onlySoft=med.every(x=>/UNFINGERPRINTED|STRUCTURE|FORMAT|LOW_FORMAT/i.test(String(x.type||"")));if(!onlySoft)return{status:"PARTIAL",confidence,reason:"medium_uncertainty"};return{status:"PROCESSED",confidence:Math.max(confidence,0.55),reason:"soft_uncertainty_only"};}return{status:"PROCESSED",confidence,reason:"analysis_and_verification_completed"}}
  function processBatch(rep,options={}){const started=Date.now();const depth=Number(options.batchDepth||0);const s=blankB(rep);if(depth>=MAX_BATCH_DEPTH){s.uncertainty.push({type:"BATCH_DEPTH_LIMIT_B",severity:"HIGH",depth});s.decision={status:"UNRESOLVED",confidence:0,reason:"batch_depth_limit"};s.durationMs=elapsed(started);return s;}s.operations.push("BATCH_PROCESSING","ITEM_ANALYSIS","CROSS_ITEM_RELATION_ANALYSIS","BATCH_VERIFICATION","BATCH_INFERENCE");s.items=rep.content.value.map((member,i)=>({index:i,source:member.metadata?.source??`item-${i+1}`,fingerprint:member.input?.fingerprint??null,processing:MachineB.process(member,{...options,batchDepth:depth+1})}));s.items.forEach(x=>{s.findings.push({type:"ITEM_ANALYZED",index:x.index,status:x.processing.decision?.status});s.evidence.push({type:"ITEM_EVIDENCE",index:x.index,count:x.processing.evidence.length});s.verification.push({type:"ITEM_VERIFICATION",index:x.index,count:x.processing.verification.length});s.hypotheses.push(...(x.processing.hypotheses||[]));s.constraints.push(...(x.processing.constraints||[]));s.contradictions.push(...(x.processing.contradictions||[]));s.reasoning.push(...(x.processing.reasoning||[]));s.reasoningTrace.push(...(x.processing.reasoningTrace||[]));if(x.processing.uncertainty.length)s.uncertainty.push({type:"ITEM_UNCERTAINTY",index:x.index,count:x.processing.uncertainty.length});});for(let i=0;i<s.items.length;i++)for(let j=i+1;j<s.items.length;j++)s.relations.push({type:"ITEM_RELATION_CANDIDATE",from:i,to:j,basis:"same_injection_batch"});s.inferences.push({type:"MULTI_MATERIAL_INPUT",itemCount:s.items.length,basis:["batch_structure","item_analysis"]});s.decision={status:s.items.some(x=>x.processing.decision?.status!=="PROCESSED")?"PARTIAL":"PROCESSED",confidence:clamp(s.items.reduce((a,x)=>a+(x.processing.decision?.confidence??0),0)/(s.items.length||1)),reason:"batch_analysis_and_verification_completed"};s.durationMs=elapsed(started);return s}

  const MachineB={process(rep,options={}){const started=Date.now();if(!rep?.structure)return unresolvedB("representation_missing",started);if(rep.structure.kind==="batch"&&Array.isArray(rep.content?.value))return processBatch(rep,options);const s=blankB(rep);const steps=selectedSteps(options,rep.content?.format);const allSteps=["structure","content","syntax","relation","constraint","hypothesis","verify","infer","reasoning","decision"];s.selectedSteps=steps.slice();s.skippedSteps=allSteps.filter(x=>!steps.includes(x));s.operations.push("AUTO_STEP_SELECTION");timed(s,"structure",()=>steps.includes("structure")&&inspectStructureB(rep,s),options);timed(s,"content",()=>steps.includes("content")&&inspectContentB(rep,s),options);timed(s,"syntax",()=>steps.includes("syntax")&&analyzeSyntaxB(rep,s),options);timed(s,"relation",()=>steps.includes("relation")&&deriveRelationsB(rep,s),options);timed(s,"constraint",()=>steps.includes("constraint")&&analyzeConstraintsB(rep,s,options),options);timed(s,"contradiction",()=>detectContradictionsB(rep,s),options);timed(s,"hypothesis",()=>steps.includes("hypothesis")&&inferHypothesesB(rep,s),options);timed(s,"verify",()=>steps.includes("verify")&&verifyB(rep,s),options);timed(s,"infer",()=>steps.includes("infer")&&inferB(rep,s));if(steps.includes("reasoning"))reasonB(s);if(options.__deadline&&Date.now()>options.__deadline){s.degraded=true;s.errors.push({step:"pipeline",error:"TIMEOUT",timestamp:now()});}if(steps.includes("decision")){s.decision=decideB(s,options);try{const d=s.reasoning&&s.reasoning.find(x=>x.step==="DECIDE");if(d)d.status=s.decision&&s.decision.status&&s.decision.status!=="UNRESOLVED"?"complete":"pending";if(s.reasoningTrace){const tr=s.reasoningTrace.find(x=>x.step==="DECIDE");if(tr)tr.status=d?d.status:"complete";}}catch(_){}}s.durationMs=elapsed(started);return s}}
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
    try{b=phase("B",()=>{const value=MachineB.process(a,{...options,__deadline:deadline,cycleIndex});if(options.externalEvidence){ingestExternalEvidenceB(value,options.externalEvidence,options);}if(options.physicsEvidence){ingestPhysicsEvidenceB(value,options.physicsEvidence,options);}if((options.externalEvidence||options.physicsEvidence)&&value.reasoning?.length)reasonB(value);if(options.externalEvidence||options.physicsEvidence)value.decision=decideB(value,options);return value;});}catch(e){b=blankB(a);b.degraded=true;b.errors.push({stage:"B",error:String(e.message||e),timestamp:now()});b.fallbacks.push({from:"B",to:"A",timestamp:now()});b.decision={status:"DEGRADED",confidence:0,reason:"fallback_B_to_A"};}
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
  function auditIndependence(){const forbidden=[["fetch",/\bfetch\s*\(/,"network"],["XMLHttpRequest",/\bXMLHttpRequest\b/,"network"],["WebSocket",/\bWebSocket\b/,"network"],["sendBeacon",/\bsendBeacon\b/,"network"],["document",/\bdocument\b/,"dom"],["localStorage",/\blocalStorage\b/,"storage"],["sessionStorage",/\bsessionStorage\b/,"storage"],["indexedDB",/\bindexedDB\b/,"storage"],["eval",/\beval\s*\(/,"dynamic"],["new Function",/\bnew\s+Function\b/,"dynamic"],["import(",/\bimport\s*\(/,"import"],["require(",/\brequire\s*\(/,"import"],["setTimeout/setInterval",/\bset(?:Timeout|Interval)\s*\(/,"timer"],["postMessage",/\bpostMessage\b/,"messaging"]];const internal=[safeClone,normalizeSpecial,hasCircular,validateInput,fingerprint,stableStringify,sha256Hex,digest,classifyText,looksLikeCode,looksLikeCSV,regexAllowedAt,balancedDelimiters,parseStructuredText,extractHtml,extractCode,tokenize,lineStats,analyzeText,assertEnvelope,describeStructure,extractContent,MachineA.process,blankB,ingestExternalEvidenceB,selectedSteps,timed,inspectStructureB,inspectContentB,analyzeSyntaxB,deriveRelationsB,structuredOf,analyzeConstraintsB,inferHypothesesB,verifyB,reasonB,detectContradictionsB,confidenceB,decideB,processBatch,MachineB.process,unresolvedB,inferB,sealChain,verifyChain,validateOutput,MachineC.process,MachineC.inject,summarize,compactAnalysis,fallbackResult,runCycle,reflect,replay,verifyReplay,MachineD.audit,pausedResult,notify];const runtimePublic=new Set([runLocalRuntimeSandbox,verifyRuntime,createCodeWithRuntime,normalizeRuntimeSpec]);const pub=Object.values(CGOMachineABC).filter(f=>typeof f==="function"&&f!==auditIndependence&&f!==selfTest&&!runtimePublic.has(f));const funcs=[...new Set([...internal,...pub])];const hits=[];for(const fn of funcs){const src=String(fn);for(const [name,re,kind] of forbidden)if(re.test(src))hits.push({name,kind})}const forbiddenReferences=[...new Set(hits.map(h=>h.name))];const globalCapabilities=["fetch","XMLHttpRequest","WebSocket","document","localStorage","sessionStorage","indexedDB"].filter(x=>typeof globalThis!=="undefined"&&x in globalThis);const count=k=>hits.filter(h=>h.kind===k).length;return{verified:forbiddenReferences.length===0,scannedFunctions:funcs.length,forbiddenReferences,globalCapabilities,networkCalls:count("network"),externalImports:count("import"),nativeOnly:forbiddenReferences.length===0,runtimeIsolated:globalCapabilities.length===0,coverage:{scannedFunctions:funcs.length,publicFunctions:pub.length,scope:"registered_functions_only"},note:"Pemindaian statis atas fungsi terdaftar (kata utuh, bukan potongan kata). Bukan bukti isolasi runtime: kemampuan global browser (fetch, document, dst.) tetap ada dan hanya dilaporkan."}}

  // ============================================================
  // PHYSICS KERNEL — rumus fisika murni untuk MESIN ABC (domain-neutral)
  // Identitas modul sumber / konstelasi / vendor DIHAPUS.
  // Parameter default bisa di-override caller; tidak mengunci domain.
  // ============================================================
  const CGOPhysics = (() => {

    const PHYSICS_CONSTANTS = Object.freeze({
      // Spektrum & kanal (default RF generik)
      FREQ_MHZ: 1621.25,
      CHANNEL_BW_HZ: 41667,
      DATA_RATE_BPS: 50,
      PACKET_BITS: 256,

      // Link budget
      EIRP_DBM: 37,
      RX_GAIN_DBI: 3,
      NOISE_FLOOR_DBM: -125.6,
      PROCESSING_GAIN_DB: 29.2,

      // Geometri relatif (bukan orbit konstelasi)
      REF_RANGE_KM: 780,
      EARTH_RADIUS_KM: 6371,
      MAX_REL_SPEED_MPS: 7500,

      // Doppler generik: f_d = (v/c) * f_c
      MAX_DOPPLER_HZ: 40530,
      MAX_DOPPLER_RATE_HZ_S: 280,
      DOPPLER_WEIGHT: 1 / 400,

      // Sudut elevasi generik
      MIN_ELEVATION_DEG: 10,
      MAX_ELEVATION_DEG: 75,

      // Atmosfer sederhana L = k / sin(θ)
      ATM_COEF_DB: 0.1,

      // Fading stokastik opsional (domain-neutral)
      SCINT_PROB_NIGHT: 0.08,
      SCINT_PROB_DAY: 0.005,
      SCINT_EQUINOX_MULT: 2.5,
      SCINT_FADE_MIN_DB: 3,
      SCINT_FADE_MAX_DB: 15,

      // Ambang kualitas link (LQM dB)
      LQM_THRESHOLD_VALID_DB: 6.0,
      LQM_THRESHOLD_DEGRADED_DB: 4.0,

      // Timing sesi generik (bukan pass konstelasi)
      SESSION_DURATION_SEC: 550,
      HISTORY_SIZE: 20,
      SUSTAINED_SAMPLES: 10,
      MAX_DELTA_MS: 1000
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
    function getPER(ber, bits = PHYSICS_CONSTANTS.PACKET_BITS) {
      return 1 - Math.pow(1 - ber, bits);
    }

    // ============================================================================
    // LAYER 1: FISIKA — PURE FUNCTIONS
    // ============================================================================

    /**
     * Hitung geometri relatif pada waktu t dalam 1 lintasan.
     * Model: parabola sederhana (domain-neutral).
     * 
     * @param {number} elapsedSec - waktu sejak awal lintasan (0 .. duration)
     * @param {number} passDurationSec - durasi total lintasan
     * @returns {{elevationDeg, distanceKm, dopplerShiftHz, dopplerRateHzPerSec}}
     */
    function computeGeometry(elapsedSec, passDurationSec) {
      const T = passDurationSec;
      const normT = (elapsedSec / T) - 0.5;   // -0.5 .. +0.5

      // Elevasi: parabola (zenith di tengah lintasan)
      // elev(t) = maxElev * (1 - 4*normT^2)
      const maxElev = PHYSICS_CONSTANTS.MAX_ELEVATION_DEG;
      const elevationDeg = maxElev * (1 - 4 * normT * normT);

      // Slant range (hukum cosinus, dengan Re dan h dari konstanta)
      const Re = PHYSICS_CONSTANTS.EARTH_RADIUS_KM;
      const h = PHYSICS_CONSTANTS.REF_RANGE_KM;
      const elRad = elevationDeg * Math.PI / 180;

      // Rumus: d = sqrt((Re+h)^2 - (Re*cos(el))^2) - Re*sin(el)
      const a = (Re + h) ** 2;
      const b = (Re * Math.cos(elRad)) ** 2;
      const c = Re * Math.sin(elRad);
      const distanceKm = Math.sqrt(Math.max(0, a - b)) - c;

      // Doppler shift: sinusoidal dalam normT
      // f_d(t) = -f_max * sin(normT * π)
      const maxShift = PHYSICS_CONSTANTS.MAX_DOPPLER_HZ;
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
    function computeFSPL(distanceKm, freqMHz = PHYSICS_CONSTANTS.FREQ_MHZ) {
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
      const prx = PHYSICS_CONSTANTS.EIRP_DBM + PHYSICS_CONSTANTS.RX_GAIN_DBI - fspl;
      return prx - PHYSICS_CONSTANTS.NOISE_FLOOR_DBM;
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
      let penalty = PHYSICS_CONSTANTS.ATM_COEF_DB / sinEl;

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

      let prob = isNight ? PHYSICS_CONSTANTS.SCINT_PROB_NIGHT : PHYSICS_CONSTANTS.SCINT_PROB_DAY;
      if (isEquinox) prob *= PHYSICS_CONSTANTS.SCINT_EQUINOX_MULT;

      // Elevasi rendah lebih rentan
      if (elevationDeg < 30) {
        prob *= (1 + (30 - elevationDeg) / 30);
      }

      // Scale by deltaMs (probabilitas per detik)
      const effectiveProb = prob * (deltaMs / 1000);

      // Stress mode: paksa fade lebih sering
      const finalProb = mode === PHYSICS_MODE.STRESS ? Math.min(0.5, effectiveProb * 5) : effectiveProb;

      if (Math.random() < finalProb) {
        const fadeMin = PHYSICS_CONSTANTS.SCINT_FADE_MIN_DB;
        const fadeMax = PHYSICS_CONSTANTS.SCINT_FADE_MAX_DB;
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
      if (elevationDeg < PHYSICS_CONSTANTS.MIN_ELEVATION_DEG) {
        return -Infinity;
      }

      // SNR → Eb/N0 (via processing gain)
      const ebn0 = snrDb + PHYSICS_CONSTANTS.PROCESSING_GAIN_DB;

      // Penalti atmosfer
      const atmPenalty = computeAtmPenalty(elevationDeg);

      // Penalti Doppler tracking
      const dopplerPenalty = Math.abs(dopplerRateHzPerSec) * PHYSICS_CONSTANTS.DOPPLER_WEIGHT || 0;
      // Normalize: kalau rate max 280 Hz/s, penalty max ~0.7 dB (reasonable)

      // LQM final
      return ebn0 - atmPenalty - dopplerPenalty + scintFadeDb;
    }

    function evaluateLinkFromGeo(geo, mode = PHYSICS_MODE.REALISTIC, now = new Date()) {
      const elevationDeg = geo?.elevationDeg ?? 0;
      const distanceKm = geo?.distanceKm ?? Infinity;
      if (elevationDeg < PHYSICS_CONSTANTS.MIN_ELEVATION_DEG || !Number.isFinite(distanceKm)) {
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
      const effectiveEbn0 = lqm;
      const ber = getBER(effectiveEbn0, elevationDeg);
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
        usable: lqm >= PHYSICS_CONSTANTS.LQM_THRESHOLD_DEGRADED_DB
      };
    }


    function runSelfTest() {
      const results = [];
      const assert = (name, cond, info = '') => results.push({ name, pass: !!cond, info });
      try {
        const fspl = computeFSPL(780);
        assert('FSPL @ ref range ≈ 154.5 dB', Math.abs(fspl - 154.48) < 1, `got ${fspl.toFixed(2)}`);
        const snr = computeSNR(780);
        assert('SNR @ ref range ≈ 11 dB', Math.abs(snr - 11.12) < 1, `got ${snr.toFixed(2)}`);
        const geo = computeGeometry(275, 550);
        assert('Doppler rate awal pass', Math.abs(Math.abs(geo.dopplerRateHzPerSec) - 231) < 50, `got ${geo.dopplerRateHzPerSec.toFixed(1)}`);
        const lqm = calculateLQM({snrDb:11.12,dopplerRateHzPerSec:0,elevationDeg:75,scintFadeDb:0});
        assert('LQM zenith > 35 dB', lqm > 35, `got ${lqm.toFixed(2)}`);
        const ber = getBER(6,45);
        assert('BER @ 6 dB within Rician K7 range', ber > 1e-7 && ber < 1e-4, `got ${ber.toExponential(2)}`);
        const per = getPER(1e-5,256);
        assert('PER @ BER 1e-5 / 256 bit', Math.abs(per - 0.00256) < 0.001, `got ${(per*100).toFixed(3)}%`);
        const nowDate = new Date(2025,5,15,12,0,0);
        const clear= evaluateLinkFromGeo({elevationDeg:75,distanceKm:780,dopplerRateHzPerSec:0,scintFadeDb:0},PHYSICS_MODE.IDEAL,nowDate);
        const faded= evaluateLinkFromGeo({elevationDeg:75,distanceKm:780,dopplerRateHzPerSec:0,scintFadeDb:-30},PHYSICS_MODE.IDEAL,nowDate);
        assert('Effective Eb/N0 drives BER/PER', faded.ber>clear.ber && faded.per>clear.per, `clear ${clear.per} faded ${faded.per}`);
        assert('Physics usable threshold', clear.usable===true && evaluateLinkFromGeo({elevationDeg:5,distanceKm:780},PHYSICS_MODE.IDEAL,nowDate).usable===false);
        assert('Invalid geometry does not crash', evaluateLinkFromGeo({elevationDeg:75,distanceKm:Infinity},PHYSICS_MODE.IDEAL,nowDate).usable===false);
      } catch(e) { results.push({name:'physics-self-test-exception',status:'FAIL',pass:false,info:String(e.message||e)}); }
      const pass=results.filter(x=>x.pass).length;
      const fail=results.length-pass;
      return {pass,fail,total:results.length,results,verified:fail===0};
    }

    return Object.freeze({PHYSICS_CONSTANTS,PHYSICS_MODE,evaluateLinkFromGeo,computeGeometry,computeFSPL,computeSNR,computeAtmPenalty,computeScintillation,calculateLQM,getBER,getPER,runSelfTest});
  })();

  // Capability audit: proves the repair engine can perform the documented
  // deterministic capabilities, not merely report an internal pipeline status.
  // Each fixture is deliberately split into BROKEN / VALID / UNSUPPORTED cases.
  function auditRepairCapabilities(){
    const cases = [
      {
        id:"MISSING_OBJECT_COMMA",
        kind:"BROKEN",
        source:'const x = {\n  id: "A"\n  status: "ACTIVE"\n};',
        expectedStatus:"REPAIRED_VERIFIED",
        expectedRule:"MISSING_OBJECT_COMMA"
      },
      {
        id:"MISSING_CONCAT_LINES_PUSH",
        kind:"BROKEN",
        source:'function f(item){\n  const lines=[];\n  lines.push(\n    item.id\n    " | "\n    item.name\n  );\n  return lines.join("\\n");\n}',
        expectedStatus:"REPAIRED_VERIFIED",
        expectedRule:"MISSING_CONCAT_LINES_PUSH"
      },
      {
        id:"MULTI_RULE_COMBINED",
        kind:"BROKEN",
        source:'function buildSatelliteReport(){\n  const satellite={\n    id:"SAT-001",\n    name:"CIKUR-SAT",\n    altitude:550\n    status:"ACTIVE",\n    signal:98\n  };\n  const lines=[];\n  lines.push(\n    "A"\n    " | "\n    "B"\n  );\n  return {satellite,lines};\n}',
        expectedStatus:"REPAIRED_VERIFIED",
        expectedRules:["MISSING_OBJECT_COMMA","MISSING_CONCAT_LINES_PUSH"]
      },
      {
        id:"MISSING_LIST_COMMA_NONLITERAL",
        kind:"BROKEN",
        source:'const cfg = {\n  id: makeId(1)\n  tags: [a, b]\n  owner: user.name\n};',
        expectedStatus:"REPAIRED_VERIFIED",
        expectedRule:"MISSING_LIST_COMMA"
      },
      {
        id:"MISSING_CLOSER_EOF",
        kind:"BROKEN",
        source:'function run() {\n  if (ready) {\n    start();\n',
        expectedStatus:"REPAIRED_VERIFIED",
        expectedRule:"MISSING_CLOSER_INDENT"
      },
      {
        id:"MISSING_CLOSER_MID_FILE",
        kind:"BROKEN",
        source:'function a() {\n  if (x) {\n    go();\n  \n}\n\nfunction b() {\n  return 1;\n}\n',
        expectedStatus:"REPAIRED_VERIFIED",
        expectedRule:"MISSING_CLOSER_INDENT"
      },
      {
        id:"JSON_TRAILING_COMMA",
        kind:"BROKEN",
        source:'{"a":1,"b":[1,2,],}',
        expectedStatus:"REPAIRED_VERIFIED",
        expectedRule:"JSON_TRAILING_COMMA"
      },
      {
        id:"AMBIGUOUS_PAREN_ELEMENT",
        kind:"UNSUPPORTED",
        source:'foo(a (b) => b);',
        expectedStatus:"NO_PATCH"
      },
      {
        id:"VALID_PLUS_PLUS",
        kind:"VALID",
        source:'const a = + +b;\nconst c = a++;',
        expectedStatus:"NO_PATCH"
      },
      {
        id:"VALID_MULTILINE_PLUS",
        kind:"VALID",
        source:'const total = first +\n  second;',
        expectedStatus:"NO_PATCH"
      },
      {
        id:"VALID_DOUBLE_SEMICOLON",
        kind:"VALID",
        source:'const x = 1;;',
        expectedStatus:"NO_PATCH"
      },
      {
        id:"UNSUPPORTED_EMPTY_ASSIGNMENT",
        kind:"UNSUPPORTED",
        source:'function x(){ const a = ; return a; }',
        expectedStatus:"REVIEW"
      },
      {
        id:"UNSUPPORTED_OPERATOR_INTENT",
        kind:"UNSUPPORTED",
        source:'const x = value +; ',
        expectedStatus:"REVIEW"
      }
    ];
    const results = cases.map(c => {
      const r = repair(c.source,{autoApply:true,source:"CAPABILITY_AUDIT:"+c.id});
      const repairedCode = r.fullRepairedCode;
      let compilePass = null;
      // Full JavaScript parsing is intentionally not claimed here. The engine
      // uses its deterministic source gate; host-side tests may additionally
      // compile the returned text with a JavaScript parser.
      const rulePass = c.expectedRules
        ? c.expectedRules.every(rule => Array.isArray(r.appliedRules) && r.appliedRules.includes(rule))
        : (!c.expectedRule || (Array.isArray(r.appliedRules) && r.appliedRules.includes(c.expectedRule)));
      const statusPass = r.status === c.expectedStatus;
      const sourcePass = c.expectedStatus === "REPAIRED_VERIFIED" ? r.sourceSyntax?.pass === true : true;
      const pass = statusPass && rulePass && sourcePass && (compilePass !== false);
      return {id:c.id,kind:c.kind,status:r.status,expectedStatus:c.expectedStatus,rule:r.appliedRules||[],expectedRule:c.expectedRule||null,expectedRules:c.expectedRules||null,sourceSyntax:r.sourceSyntax?.status||"UNKNOWN",compileProbe:compilePass,pass};
    });
    const passed=results.filter(x=>x.pass).length;
    return Object.freeze({name:"REPAIR_CAPABILITY_AUDIT",version:VERSION,passed,failed:results.length-passed,total:results.length,verified:passed===results.length,cases:results});
  }

  function selfTestInner(){const results=[];const test=(name,fn)=>{try{fn();results.push({name,status:"PASS"})}catch(e){results.push({name,status:"FAIL",error:String(e.message||e)})}};test("repair-capability-audit",()=>{const a=auditRepairCapabilities();if(!a.verified)throw Error("repair capability audit: "+a.failed+" failed")});const pt=CGOPhysics.runSelfTest();if(!pt.verified)throw Error("physics kernel self-test failed: "+pt.results.filter(x=>!x.pass).map(x=>x.name).join(","));results.push({name:"physics-kernel",status:"PASS"});test("fingerprint",()=>{if(fingerprint("a")!==fingerprint("a"))throw Error("unstable")});test("delimiter-comment-regex",()=>{if(!balancedDelimiters("const x=/\\{/; // }\n{a:1}").balanced)throw Error("false negative")});test("auto-format",()=>{if(classifyText('{"a":1}').format!=="json")throw Error("json")});test("html-relations-duplicates",()=>{const h=extractHtml('<div id="x"></div><span id="x"><a href="/a"></a>');if(!h.duplicateIds.includes("x")||!h.references.includes("/a"))throw Error("html regression")});test("envelope-validator",()=>{const r=assertEnvelope({__cgoMachineInjection:true,contentMode:"bad",payload:{}});if(r.valid)throw Error("invalid envelope accepted")});test("pipeline",()=>{const o=runCycle("hello world");if(!o.result||!o.audit)throw Error("pipeline")});test("external-evidence-propagation",()=>{const o=runCycle("hello",{externalEvidence:{schema:"CGO_EXTERNAL_EVIDENCE_V1",source:"TEST_REAL_INPUT",capturedAt:now(),claims:[{source:"TEST_REAL_INPUT",target:"observed-target",status:"ANOMALY",severity:"HIGH",message:"observed failure"}],fingerprint:"evidence-test"}});if(o.pipeline.B.findings.filter(x=>x.type==="EXTERNAL_EVIDENCE").length!==1||o.pipeline.C.status!=="PARTIAL"||o.audit.status!=="ATTENTION")throw Error("external evidence not propagated")});test("physics-evidence-propagation",()=>{const o=runCycle("physics",{physicsEvidence:{source:"TEST_PHYSICS",geo:{elevationDeg:5,distanceKm:780,dopplerRateHzPerSec:0,scintFadeDb:0},mode:CGOPhysics.PHYSICS_MODE.IDEAL}});if(!o.pipeline.B.findings.some(x=>x.type==="PHYSICS_LINK_EVALUATION")||o.pipeline.B.decision?.status!=="CONTRADICTION"||o.result?.status!=="CONTRADICTION")throw Error("physics evidence not propagated")});test("physics-evidence-valid",()=>{const o=runCycle("physics-valid",{physicsEvidence:{source:"TEST_PHYSICS",geo:{elevationDeg:75,distanceKm:780,dopplerRateHzPerSec:0,scintFadeDb:0},mode:CGOPhysics.PHYSICS_MODE.IDEAL}});if(o.pipeline.B.decision?.status!=="PROCESSED"||!o.pipeline.B.verification.some(x=>x.type==="PHYSICS_EVIDENCE"&&x.status==="PASS"))throw Error("valid physics evidence rejected")});test("batch",()=>{const o=CGOMachineABC.processMany(["a","b"]);if(o.pipeline.B.items?.length!==2)throw Error("batch")});test("batch-unknowns-aggregate",()=>{let nested={__cgoBatchInjection:true,version:VERSION,items:[]};for(let i=0;i<MAX_BATCH_DEPTH;i++)nested={__cgoBatchInjection:true,version:VERSION,items:[nested]};const rep=MachineA.process(nested);if(!rep.unknowns.some(x=>x.type==="BATCH_DEPTH_LIMIT"&&x.itemIndex===0))throw Error("batch unknown not aggregated")});test("c-injection",()=>{const o=runCycle("x");const inj=MachineC.inject(o.result);const q=runCycle(inj);if(!q.result)throw Error("injection")});test("auto-step",()=>{const o=runCycle("plain text",{});if(o.pipeline.B.operations.includes("SYNTAX_ANALYSIS"))throw Error("text syntax should be skipped");if(!o.pipeline.B.operations.includes("CONTENT_INSPECTION"))throw Error("content step missing")});test("custom-step-selection",()=>{const o=runCycle("hello",{steps:["structure"]});if(!o.pipeline.B.operations.includes("STRUCTURE_INSPECTION")||o.pipeline.B.operations.includes("CONTENT_INSPECTION")||o.pipeline.B.decision!==null)throw Error("custom steps")});test("auto-reflect",()=>{const o=reflect("hello",{maxCycles:3,stopOnStatus:"__NEVER__"});if(!Array.isArray(o.cycles)||o.cycles.length<2||!o.finalResult)throw Error("reflect")});test("reflect-actually-reflects",()=>{const o=reflect("hello",{maxCycles:2,stopOnStatus:"__NEVER__"});const first=o.cycles[0].result;if(o.cycles.length<2||fingerprint(o.cycles[1].pipeline.A.content.value)!==fingerprint(first))throw Error("reflection payload not processed")});test("stream",()=>{let n=0;CGOMachineABC.stream("hello",{onCycle:()=>n++});if(n<1)throw Error("stream")});test("stream-real-time",()=>{const seen=[];CGOMachineABC.stream("hello",{autoReflect:true,maxCycles:3,stopOnStatus:"__NEVER__",minConfidenceDelta:0,onCycle:c=>seen.push(c.cycleIndex)});if(seen.length!==3||seen[0]!==0||seen[1]!==1||seen[2]!==2)throw Error("buffered stream")});test("observe",()=>{let n=0;const off=CGOMachineABC.observe(()=>n++);CGOMachineABC.process("observe");off();if(n!==1)throw Error("observe")});test("stream-observe",()=>{let n=0;const off=CGOMachineABC.observe(()=>n++);CGOMachineABC.stream("observe-stream",{autoReflect:true,maxCycles:2,stopOnStatus:"__NEVER__"});off();if(n!==2)throw Error("stream observe")});test("independence",()=>{const a=auditIndependence();if(!a.verified||a.scannedFunctions<8)throw Error("independence")});test("machine-D",()=>{const o=CGOMachineABC.process("audit");if(o.audit?.status!=="VALID")throw Error("audit failed")});test("audit-tamper-C-payload",()=>{const o=CGOMachineABC.process("tamper");o.pipeline.C.findings.push({fake:true});const d=MachineD.audit(o,"tamper");if(d.status!=="ATTENTION"||!d.checks.some(x=>x.type==="C_PAYLOAD_HASH"&&x.status==="FAIL"))throw Error("tamper undetected")});test("b-batch-depth-guard",()=>{const rep=MachineA.process({__cgoBatchInjection:true,items:[],version:VERSION},{batchDepth:MAX_BATCH_DEPTH});const b=MachineB.process({...rep,structure:{kind:"batch",count:0},content:{mode:"batch",value:[]}}, {batchDepth:MAX_BATCH_DEPTH});if(b.decision?.reason!=="batch_depth_limit")throw Error("guard")});test("record-verification",()=>{const o=runCycle({name:"cgo",value:1});const checks=o.pipeline.B.verification;if(!checks.some(x=>x.type==="RECORD_PRESENT"&&x.status==="PASS"))throw Error("record check missing")});test("collection-verification",()=>{const o=runCycle([{id:1}]);if(!o.pipeline.B.verification.some(x=>x.type==="COLLECTION_PRESENT"&&x.status==="PASS"))throw Error("collection check missing")});test("nan-infinity",()=>{if(CGOMachineABC.process(Infinity).pipeline.A.content.value!=="Infinity")throw Error("infinity")});test("max-input-override",()=>{const o=CGOMachineABC.process("abc",{maxInputSize:10});if(!o.result)throw Error("override")});test("skipped-steps",()=>{const o=CGOMachineABC.process("abc",{steps:["structure"]});if(!o.pipeline.B.skippedSteps.includes("content"))throw Error("skipped")});test("degraded-field",()=>{if(typeof CGOMachineABC.process("abc").pipeline.B.degraded!=="boolean")throw Error("degraded")});test("errors-array",()=>{if(!Array.isArray(CGOMachineABC.process("abc").pipeline.B.errors))throw Error("errors")});test("fallback-array",()=>{if(!Array.isArray(CGOMachineABC.process("abc").pipeline.C.fallbacks))throw Error("fallback")});test("weighted-check",()=>{const o=CGOMachineABC.process("abc");if(!o.pipeline.B.verification[0].status)throw Error("check")});test("contradiction-severity",()=>{const o=CGOMachineABC.process('<!doctype html><html><div id="x"></div><span id="x"></span></html>');if(!o.pipeline.B.contradictions.some(x=>x.severity))throw Error("severity")});test("decision-hierarchy",()=>{const o=CGOMachineABC.process({x:1});if(!["PROCESSED","WELL_FORMED","PARTIAL","DEGRADED","CONTRADICTION","UNRESOLVED"].includes(o.result.status))throw Error("status")});test("machineD-fallback-check",()=>{const o=CGOMachineABC.process("abc");if(!o.audit.checks.some(x=>x.type==="FALLBACK_CHAIN"))throw Error("fallback audit")});test("replay-shape",()=>{const o=CGOMachineABC.process("abc"),r=CGOMachineABC.replay(o);if(!Array.isArray(r.steps))throw Error("replay")});test("verify-replay",()=>{const o=CGOMachineABC.process("abc"),r=CGOMachineABC.replay(o);if(CGOMachineABC.verifyReplay(o,r).status!=="MATCH")throw Error("verify replay")});test("metrics-reset",()=>{const before=CGOMachineABC.getMetrics().totalProcessed;CGOMachineABC.resetMetrics();if(CGOMachineABC.getMetrics().totalProcessed!==0||before<0)throw Error("reset")});test("state-cycle-index",()=>{const o=CGOMachineABC.process("state");if(CGOMachineABC.getState().lastCycleIndex!==0)throw Error("state cycle")});test("pause-reflect",()=>{CGOMachineABC.pause();const r=CGOMachineABC.reflect("pause",{maxCycles:2});CGOMachineABC.resume();if(r.stopReason!=="paused")throw Error("pause reflect")});test("reflect-direct-C",()=>{const r=CGOMachineABC.reflect("abc",{maxCycles:2,stopOnStatus:"__NEVER__",minConfidenceDelta:0});if(r.cycles.length!==2||r.cycles[1].pipeline.A.content.mode!=="record")throw Error("direct C")});test("stream-complete",()=>{let done=false;CGOMachineABC.stream("abc",{onComplete:()=>done=true});if(!done)throw Error("complete")});test("stream-batch-summary",()=>{const o=CGOMachineABC.processMany(["a","b"],{streamBatch:true});if(o.pipeline.C.batch.items.some(x=>x.analysis===undefined))throw Error("summary")});test("date-input",()=>{if(CGOMachineABC.process(new Date()).pipeline.A.input.type!=="date")throw Error("date")});test("repair-header-paren-precision",()=>{const cases=[['if (value > 50 { return "STRONG"; }','if (value > 50) { return "STRONG"; }'],['while (x < 10 { x++; }','while (x < 10) { x++; }'],['for (let i=0; i<3; i++ { work(i); }','for (let i=0; i<3; i++) { work(i); }'],['switch (kind { case "A": break; }','switch (kind) { case "A": break; }'],['try { run(); } catch (err { recover(err); }','try { run(); } catch (err) { recover(err); }'],['function calculateTotal(a, b { return a + b; }','function calculateTotal(a, b) { return a + b; }']];for(const [src,want] of cases){const r=CGOMachineABC.repair(src,{autoApply:true});if(r.status!=="REPAIRED_VERIFIED"||!r.verified||r.fullRepairedCode!==want)throw Error("header patch precision")}});test("repair-object-plus-priority",()=>{const src='const x = { title: name\n  " | TELEMETRY", };';const r=CGOMachineABC.repair(src,{autoApply:true});if(r.status!=="REPAIRED_VERIFIED"||!r.appliedRules.includes("MISSING_CONCAT_OBJECT_PROPERTY")||r.appliedRules.includes("MISSING_LIST_COMMA")||!r.fullRepairedCode.includes('name\n  + " | TELEMETRY"'))throw Error("object plus priority")});test("valid-plus-plus-not-repaired",()=>{const src='const a = + +b;\nconst c = a++;';const r=CGOMachineABC.repair(src,{autoApply:true});if(r.status!=="NO_PATCH"||r.applied||r.verified||r.sourceSyntax?.pass!==true||r.candidate)throw Error("valid plus-plus was altered");});test("valid-plus-line-continuation-not-repaired",()=>{const src='const total = first +\n  second;';const r=CGOMachineABC.repair(src,{autoApply:true});if(r.applied||r.verified||r.sourceSyntax?.pass!==true||r.candidate)throw Error("valid multiline plus was altered");});test("repair-audit-ledger-present",()=>{const r=CGOMachineABC.repair('const x = {\n  id: "A"\n  status: "ACTIVE"\n};',{autoApply:true});if(!Array.isArray(r.auditLedger)||!r.auditLedger.some(x=>x.id==="AMBIGUOUS_LOGIC"&&x.status==="BLOCKED"))throw Error("audit ledger missing");});test("repair-object-comma-deterministic",()=>{const src='const x = {\n  id: "A"\n  status: "ACTIVE"\n};';const r=CGOMachineABC.repair(src,{autoApply:true});if(!r.applied||!r.candidate||!r.candidate.patch.after.includes('id: "A",\n  status')||r.sourceSyntax?.pass!==true)throw Error("deterministic object comma repair")});test("repair-does-not-claim-invalid-source",()=>{const src='const x = {\n  id: "A"\n  status: "ACTIVE"\n};';const r=CGOMachineABC.repair(src,{autoApply:false});if(r.verified||r.status!=="REVIEW")throw Error("ambiguous verification")});test("invalid-source-without-rule-is-review",()=>{const r=CGOMachineABC.repair("function x(){ const a = ; return a; }",{autoApply:true});if(r.verified||r.status!=="REVIEW"||r.sourceSyntax?.status!=="FAIL")throw Error("invalid source was not gated")});test("repair-export-function-precision",()=>{const r=CGOMachineABC.repair("export function calc(a, b {\n return a+b;\n}",{autoApply:true});if(r.status!=="REPAIRED_VERIFIED"||!r.verified||r.fullRepairedCode!=="export function calc(a, b) {\n return a+b;\n}")throw Error("export function patch")});test("project-context-repair-and-relations",()=>{const p=CGOMachineABC.repairProject({files:[{path:"src/math.js",content:"export function calc(a, b {\n return a+b;\n}"},{path:"src/app.js",content:"import { calc } from \"./math.js\";\nconst total=calc(1,2);"}]},{autoApply:true});if(p.status!=="REPAIRED_VERIFIED"||!p.verified||p.projectProof.changedFiles!==1||!p.projectProof.idempotent||!p.projectProof.relationSafe||!p.relations.after.relations.some(x=>x.status==="MATCH"&&x.sourceFile==="src/app.js"&&x.targetFile==="src/math.js"))throw Error("project context repair")});test("project-missing-relation-not-verified",()=>{const p=CGOMachineABC.repairProject({files:[{path:"a.js",content:"import {x} from \"./missing.js\";\nconst a=1;"}]},{autoApply:true});if(p.verified||p.projectProof.relationSafe!==false)throw Error("missing relation accepted")});test("object-freeze",()=>{if(!Object.isFrozen(CGOMachineABC))throw Error("freeze")});test("fingerprint-undefined",()=>{const o=CGOMachineABC.process(undefined);if(!o.result||!o.audit)throw Error("undefined crash")});test("digest-sha256-vectors",()=>{if(sha256Hex("abc")!=="ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"||sha256Hex("")!=="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"||sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")!=="248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1")throw Error("sha256")});test("utf8-fallback-availability",()=>{if(typeof utf8Encode!=="function"||utf8Encode("Cikur 🚀").length<8)throw Error("utf8 encoder")});test("digest-key-order",()=>{if(digest({a:1,b:2})!==digest({b:2,a:1}))throw Error("order")});test("prose-not-delimiter-checked",()=>{const o=CGOMachineABC.process("Halo :) tolong 1) cek saldo (dulu");if(o.pipeline.A.content.syntax.delimiters||o.result.status==="PARTIAL")throw Error("prose flagged")});test("let-me-know-is-text",()=>{if(classifyText("let me know if you can help").format!=="text")throw Error("prose as code")});test("regex-after-return",()=>{if(!balancedDelimiters("function f(s){ return /[)]/.test(s) }").balanced)throw Error("regex heuristic")});test("pause-blocks-process",()=>{CGOMachineABC.pause();const o=CGOMachineABC.process("x");const st=CGOMachineABC.stream("x");CGOMachineABC.resume();if(!o.skipped||st.status!=="PAUSED")throw Error("pause ignored")});test("stop-reason-to-observer",()=>{let got=null;const off=CGOMachineABC.observe(p=>{got=p});CGOMachineABC.process("abc",{autoReflect:true,maxCycles:3,stopOnStatus:"__NEVER__",minConfidenceDelta:0});off();if(!got||got.stopReason!=="maxCycles")throw Error("stopReason lost")});test("map-set-preserved",()=>{const o=CGOMachineABC.process({m:new Map([[1,2]]),s:new Set([7])});const v=o.pipeline.A.content.value;if(v.m.__cgoType!=="Map"||v.s.values[0]!==7)throw Error("map/set lost")});test("required-fields",()=>{const o=CGOMachineABC.process({nama:"",hp:"1"},{requiredFields:["nama","email"]});const t=o.pipeline.B.contradictions.map(x=>x.type);if(!t.includes("REQUIRED_FIELD_EMPTY")||!t.includes("REQUIRED_FIELD_MISSING")||o.result.status!=="PARTIAL")throw Error("required")});test("json-string-structure",()=>{const o=CGOMachineABC.process('{"nama":"","hp":null}');if(o.pipeline.B.constraints.filter(x=>x.type==="EMPTY_FIELD").length!==2)throw Error("json string not analysed")});test("dup-id-single-contradiction",()=>{const o=CGOMachineABC.process('<!doctype html><html><div id="x"></div><span id="x"></span></html>');if(o.pipeline.B.contradictions.filter(x=>x.type==="DUPLICATE_IDENTIFIER").length!==1)throw Error("double count")});test("reflect-default-stop",()=>{const o=CGOMachineABC.reflect("hello",{maxCycles:5});if(o.stopReason!=="status")throw Error("default stop never fires")});
    test("command-contract-normalize",()=>{const c=CGOMachineABC.normalizeCommand({operation:"repair",payload:"function calc(a, b { return a+b; }",source:"BCGO_TEST"});if(!c.ok||c.status!=="COMMAND_ACCEPTED"||c.operation!=="repair"||!c.requestId)throw Error("command contract")});
    test("command-contract-reject",()=>{const c=CGOMachineABC.normalizeCommand({operation:"execute_arbitrary",payload:"x"});if(c.ok||c.status!=="UNSUPPORTED_COMMAND")throw Error("unsafe command accepted")});
    test("command-repair-dispatch",()=>{const c=CGOMachineABC.executeCommand({operation:"repair",payload:"function calc(a, b { return a+b; }",source:"BCGO_TEST"});if(!c.ok||c.result?.status!=="REPAIRED_VERIFIED"||!c.result?.fullRepairedCode)throw Error("repair dispatch")});
    test("command-project-dispatch",()=>{const c=CGOMachineABC.executeCommand({operation:"project_repair",payload:{files:[{path:"math.js",content:"export function calc(a, b { return a+b; }"},{path:"app.js",content:'import { calc } from "./math.js";\nconst total=calc(1,2);'}]},source:"BCGO_PROJECT_TEST"});if(!c.ok||c.result?.status!=="REPAIRED_VERIFIED"||!c.result?.projectProof?.idempotent)throw Error("project dispatch")});
    test("full-pipeline-trace",()=>{const o=CGOMachineABC.process("full-trace",{fast:false,skipAudit:false});if(!o.pipelineTrace||o.pipelineTrace.length!==4)throw Error("pipeline trace missing");if(o.pipelineTrace[2].status!=="COMPLETED")throw Error("C not completed");if(o.pipelineTrace[3].status!=="COMPLETED"||o.audit?.status!=="VALID")throw Error("D not completed")});
    test("phase-telemetry-route",()=>{const o=CGOMachineABC.process("telemetry-route",{fast:false,skipAudit:false});if(o.version!==VERSION||o.telemetry?.route!=="A>B>C>D"||o.telemetry?.routeStatus!=="COMPLETE"||!o.telemetry?.fingerprint||o.telemetry.phases.length!==4)throw Error("phase telemetry missing")});
    test("telemetry-observer",()=>{let n=0;const off=CGOMachineABC.observeTelemetry(e=>{if(e.type==="ABC_TELEMETRY")n++});CGOMachineABC.process("telemetry-observer");off();if(n<8)throw Error("telemetry events missing")});test("typed-html-inline-repair",()=>{const p=repairProject({files:[{path:"x.html",content:"<html><script>function test(a, b { return a+b; }</script></html>"}]});if(p.status!=="REPAIRED_VERIFIED"||!p.verified||!p.files[0].content.includes("function test(a, b)"))throw Error("html inline repair")});test("typed-html-valid-no-patch",()=>{const s="<html><style>.a { color:red; }</style><script>async function runRepairFromDev(options = {}) {}</script></html>";const p=repairProject({files:[{path:"x.html",content:s}]});if(p.status!=="NO_PATCH"||p.files[0].content!==s)throw Error("valid html changed")});test("css-isolation",()=>{const s=".a { content: "+"; }";const p=repairProject({files:[{path:"x.css",content:s}]});if(p.status!=="NO_PATCH"||p.files[0].content!==s)throw Error("css touched")});test("external-script-reference",()=>{const p=repairProject({files:[{path:"x.html",content:"<script src=\"missing.js\"></script>"}]});if(p.files[0].content!=="<script src=\"missing.js\"></script>"||p.relations.after.summary.missing!==1)throw Error("external reference")});test("project-idempotency",()=>{const p=repairProject({files:[{path:"src/math.js",content:"export function calc(a, b { return a+b; }"},{path:"src/app.js",content:"import { calc } from \"./math.js\";\nconst total=calc(1,2);"}]});if(p.status!=="REPAIRED_VERIFIED"||!p.projectProof.idempotent)throw Error("project idempotency")});test("no-patch-full-output",()=>{const s="async function runRepairFromDev(options = {}) {}";const r=repair(s,{source:"x.js"});if(r.status!=="NO_PATCH"||r.fullRepairedCode!==s||r.output.code!==s||r.beforeFingerprint!==r.afterFingerprint)throw Error("no patch output")});test("patch-ledger-honest",()=>{const r=repair("function calc(a, b { return a+b; }",{source:"x.js"});if(r.status!=="REPAIRED_VERIFIED"||!Array.isArray(r.patchLedger)||r.patchLedger.length!==1||r.patchLedger[0].status!=="APPLIED"||r.patchLedger[0].rule!=="MISSING_PAREN_FUNCTION_DECL")throw Error("patch ledger")});test("multiple-error-chain",()=>{const s="function calc(a, b {\n const x = {\n  id: 1\n  name: 2\n };\n if (x.id > 0 { return x; }\n}";const r=repair(s,{source:"x.js"});if(r.status!=="REPAIRED_VERIFIED"||!r.fullRepairedCode.includes("id: 1,\n  name: 2")||!r.fullRepairedCode.includes("x.id > 0)"))throw Error("multi error chain")});test("core-fingerprint-stability",()=>{const src="const x = 1;";if(digest(src)!==digest(src))throw Error("fingerprint instability")});test("phase1-create-verified",()=>{const r=createCode({moduleName:"selfTestModule",functions:[{name:"add",params:["a","b"],body:"return a + b;",export:true}]});if(r.status!=="CREATED_VERIFIED"||!r.verified||!r.fullRepairedCode.includes("function add"))throw Error("phase1 create")});test("phase1-create-reject",()=>{const r=createCode({moduleName:"bad-name",functions:[{name:"x"}]});if(r.status!=="INVALID_CREATE_NAME")throw Error("phase1 unsafe name")});test("phase1-command-create",()=>{const r=executeCommand({operation:"create",payload:{moduleName:"commandModule",functions:[{name:"x",body:"return 1;"}]}});if(!r.ok||r.result?.status!=="CREATED_VERIFIED")throw Error("phase1 command")});test("phase3-forward-cross-file-symbol",()=>{const r=deepProjectReasoning({files:[{path:"src/app.js",content:"import { calc } from \"./math.js\";\nexport const total=calc(1,2);"},{path:"src/math.js",content:"export function calc(a,b){ return a+b; }"}]});if(!r.verified||r.graph.summary.missingSymbol!==0||!r.graph.relations.some(x=>x.status==="SYMBOL_REFERENCE"&&x.symbol==="calc"))throw Error("cross-file forward symbol")});test("phase3-missing-cross-file-symbol",()=>{const r=deepProjectReasoning({files:[{path:"src/app.js",content:"import { missing } from \"./math.js\";"},{path:"src/math.js",content:"export function calc(){ return 1; }"}]});if(r.verified||r.graph.summary.missingSymbol!==1||r.diagnosis.affectedFiles.length!==2)throw Error("missing cross-file symbol")});test("phase3-cross-file-repair-and-reverify",()=>{const r=repairProject({files:[{path:"src/app.js",content:"import { calc } from \"./math.js\";\nconst total=calc(1,2);"},{path:"src/math.js",content:"export function calc(a,b { return a+b; }"}]},{autoApply:true});if(r.status!=="REPAIRED_VERIFIED"||!r.verified||!r.projectProof.relationSafe||!r.projectProof.idempotent||r.projectProof.changedFiles!==1)throw Error("cross-file repair")});test("phase3-command-reason",()=>{const r=executeCommand({operation:"project_reason",payload:{files:[{path:"a.js",content:"import { x } from \"./b.js\";"},{path:"b.js",content:"export const x=1;"}]}});if(!r.ok||r.result?.status!=="CONTRACT_HEALTHY"||!r.result?.verified)throw Error("project reason command")});    return{passed:results.filter(x=>x.status==="PASS").length,failed:results.filter(x=>x.status==="FAIL").length,total:results.length,results,verified:results.every(x=>x.status==="PASS")}}

  function selfTest(){
    // Self-test tidak boleh meninggalkan jejak: metrics, state, observer, dan status pause dipulihkan.
    const wasPaused=paused,savedState={...runtimeState},savedMetrics={...metrics},savedObs=[...observers],savedTelemetryObs=[...telemetryObservers];
    paused=false;observers.clear();telemetryObservers.clear();
    try{return selfTestInner()}
    finally{paused=wasPaused;Object.assign(runtimeState,savedState);Object.assign(metrics,savedMetrics);observers.clear();savedObs.forEach(fn=>observers.add(fn));telemetryObservers.clear();savedTelemetryObs.forEach(fn=>telemetryObservers.add(fn))}
  }
  const CGOMachineABC={name:"CGO_MACHINE_ABC",version:VERSION,A:MachineA,B:MachineB,C:MachineC,D:MachineD,physics:CGOPhysics,physicsSelfTest:()=>CGOPhysics.runSelfTest(),inject:(v,o={})=>MachineC.inject(v,o),createBatchInjection(inputs,o={}){if(!Array.isArray(inputs))throw new TypeError("createBatchInjection membutuhkan array input.");const v=validateInput(inputs,o);if(!v.valid)throw new TypeError(v.reason);return{__cgoBatchInjection:true,version:VERSION,mode:"batch",transport:"internal",createdAt:now(),items:inputs.slice(0,MAX_ITEMS).map(clone),metadata:clone(o.metadata??{})}},processMany(inputs,o={}){return CGOMachineABC.process(CGOMachineABC.createBatchInjection(inputs,o),{...o,source:o.source??"batch-injection"})},process(input,options={}){if(paused)return pausedResult();const v=validateInput(input,options);if(!v.valid)throw new TypeError(v.reason);metrics.totalProcessed++;if(toBool(options.autoReflect,false)){const r=reflect(v.sanitized,options);const packet={engine:"CGO_MACHINE_ABC",version:VERSION,cycles:r.cycles,finalResult:r.finalResult,stopReason:r.stopReason,audit:r.cycles.at(-1)?.audit||null,reflected:true};notify(packet,r.cycles);return packet}const out=runCycle(v.sanitized,options,0);notify(out,[out]);return out},stream(input,options={}){if(paused){const pr=pausedResult();options.onComplete?.(pr.result);return pr.result}const v=validateInput(input,options);if(!v.valid)throw new TypeError(v.reason);if(options.autoReflect===true){const r=reflect(v.sanitized,{...options,onCycle:c=>{options.onCycle?.(c);notify(c,[c])}});options.onComplete?.(r.finalResult,r.stopReason);return r.finalResult}const c=runCycle(v.sanitized,options,0);options.onCycle?.(c);notify(c,[c]);options.onComplete?.(c.result);return c.result},observe(handler){if(typeof handler!=="function")throw new TypeError("observe(handler) membutuhkan function");observers.add(handler);return()=>observers.delete(handler)},observeTelemetry(handler){if(typeof handler!=="function")throw new TypeError("observeTelemetry(handler) membutuhkan function");telemetryObservers.add(handler);return()=>telemetryObservers.delete(handler)},auditIndependence,selfTest,validateOutput,validateInput,safeClone,reflect,auditRepairCapabilities,replay:(p)=>MachineD.replay(p),verifyReplay:(p,r)=>MachineD.verifyReplay(p,r),pause(){paused=true;runtimeState.paused=true;runtimeState.pauseAt=now()},resume(){paused=false;runtimeState.paused=false;runtimeState.pauseAt=null},isPaused:()=>paused,getState:()=>clone(runtimeState),getMetrics:()=>({totalProcessed:metrics.totalProcessed,totalCycles:metrics.totalCycles,avgConfidence:metrics.totalCycles?metrics.confidenceSum/metrics.totalCycles:0,degradedCount:metrics.degradedCount,errorCount:metrics.errorCount,skippedWhilePaused:metrics.skippedWhilePaused,lastStatus:metrics.lastStatus}),sha256:sha256Hex,digest,resetMetrics(){Object.assign(metrics,{totalProcessed:0,totalCycles:0,confidenceSum:0,degradedCount:0,errorCount:0,skippedWhilePaused:0,lastStatus:null});return CGOMachineABC.getMetrics()}};
  function pausedResult(){metrics.skippedWhilePaused++;const result={machine:"C",stage:"result",version:VERSION,status:"PAUSED",summary:null,findings:[],relations:[],inferences:[],hypotheses:[],constraints:[],contradictions:[],reasoning:[],reasoningTrace:[],evidence:[],uncertainty:[],verification:[],decision:{status:"PAUSED",confidence:0,reason:"engine_paused"},errors:[],fallbacks:[],metadata:{generatedAt:now()}};return{engine:"CGO_MACHINE_ABC",version:VERSION,paused:true,skipped:true,result,audit:null}}
  function notify(result,cycles){const payload={result:result?.result??result,cycles:Array.isArray(cycles)?cycles:cycles?[cycles]:[],stopReason:result?.stopReason??null,timestamp:now()};for(const fn of [...observers]){try{fn(payload)}catch(_){}}}
  
  /*
   * Deterministic source gate.
   * IMPORTANT: this is intentionally conservative. It never claims a full JS
   * grammar parse. It only returns PASS when every registered structural check
   * passes; otherwise it returns FAIL/REVIEW. No eval(), Function(), network,
   * DOM, storage, or external parser is used.
   */
  function sourceSyntaxGate(text, gateOpts) {
    const source = String(text ?? "");
    const scanSource = maskJsNoise(source);
    const detection = classifyText(source, { extension: "js", mimeType: "application/javascript" });
    const checks = [];
    const d = balancedDelimiters(source);
    // Bukti token (lexer penuh): hanya dipakai bila JS non-JSON, lexer selesai tanpa error, dan tidak ada template ber-${...}
    // (isi ${...} tidak masuk daftar token, jadi tak bisa dibuktikan). Selain itu perilaku lama dipertahankan persis.
    const jsonModeEarly = jsonModeOf(source);
    const tokEv = jsonModeEarly ? null : tokenRuleAnalysis(source, gateOpts);
    const tokUsable = !!tokEv && !tokEv.toks.some(t => t.t === "tpl" && source.slice(t.s, t.e).indexOf("${") >= 0);
    const tokBalanced = tokUsable && !tokEv.mismatch && !tokEv.stray.length && !tokEv.unclosed.length;
    const tokDangling = tokUsable && tokEv.toks.some((t, k) => t.t === "p" && /^[+\-*\/%|&]$/.test(t.v) && tokEv.toks[k + 1] && tokEv.toks[k + 1].t === "p" && tokEv.toks[k + 1].v === ";");
    const delimOk = d.balanced || tokBalanced;
    checks.push({ id: "DELIMITERS", status: delimOk ? "PASS" : "FAIL", detail: d, ...(tokBalanced && !d.balanced ? { tokenProof: "BALANCED" } : {}) });
    const obvious = [
      { id: "UNTERMINATED_STRING", fail: d.unterminatedString },
      { id: "UNTERMINATED_COMMENT", fail: d.unterminatedComment },
      { id: "UNTERMINATED_REGEX", fail: d.unterminatedRegex },
      { id: "EMPTY_RETURN_OPERATOR", fail: /\breturn\s*[+\-*\/%]\s*;/.test(scanSource) },
      { id: "EMPTY_ASSIGNMENT", fail: /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*;/.test(scanSource) },
      { id: "DANGLING_OPERATOR_BEFORE_SEMICOLON", fail: /(?:\b[A-Za-z_$][\w$]*|\d+|\)|\]|\})\s*(?:\+|-|\*|\/|%|\||&)\s*;/.test(scanSource) && (tokUsable ? tokDangling : true) },
      { id: "MISSING_OBJECT_COMMA", fail: hasDeterministicMissingObjectComma(source) },
      { id: "MISSING_CONCAT_LINES_PUSH", fail: hasDeterministicLinesPushConcat(source) },
      { id: "MISSING_CONCAT_ASSIGNMENT", fail: repairDeterministicMultilinePlus(source).steps.some(x => x.id === "MISSING_CONCAT_ASSIGNMENT") },
      { id: "AMBIGUOUS_ASSIGNMENT_ADJACENCY", fail: hasAmbiguousMultilineAssignment(source) },
      { id: "MISSING_CONCAT_OBJECT_PROPERTY", fail: repairDeterministicObjectPropertyPlus(source).changed },
      { id: "MISSING_PAREN_HEADER", fail: repairDeterministicMissingHeaderParen(source).steps.some(x => x.id === "MISSING_PAREN_HEADER") },
      { id: "MISSING_PAREN_FUNCTION_DECL", fail: repairDeterministicMissingHeaderParen(source).steps.some(x => x.id === "MISSING_PAREN_FUNCTION_DECL") }
    ];
    for (const x of obvious) checks.push({ id: x.id, status: x.fail ? "FAIL" : "PASS" });
    // Pemeriksaan berbasis token (tidak mengeksekusi kode). JSON murni diverifikasi dengan JSON.parse;
    // selain itu: dua elemen berurutan tanpa koma dalam object/array/argumen, dan ';' di dalam tanda kurung biasa.
    const jsonMode = jsonModeEarly;
    if (jsonMode) checks.push({ id: "JSON_PARSE", status: jsonMode.valid ? "PASS" : "FAIL" });
    else {
      const ta = tokEv;
      if (ta) {
        checks.push({ id: "MISSING_LIST_COMMA", status: ta.adjacent.length ? "FAIL" : "PASS" });
        checks.push({ id: "SEMICOLON_IN_PAREN", status: ta.semis.length ? "FAIL" : "PASS" });
      }
    }
    const failed = checks.filter(x => x.status === "FAIL");
    return {
      status: failed.length ? "FAIL" : "PASS",
      pass: failed.length === 0,
      scope: "DETERMINISTIC_STRUCTURAL",
      parser: "INTERNAL_NO_DYNAMIC_EXECUTION",
      format: detection.format,
      confidence: detection.confidence,
      checks,
      failed: failed.map(x => x.id)
    };
  }

  /*
   * Only match an unambiguous two-property object-literal pattern:
   *   const x = {
   *     key: literal
   *     next: literal
   *   }
   * The rule requires the opening object brace to be immediately before the
   * first property block, so it will not guess across arbitrary statements.
   */
  function repairDeterministicLinesPushConcat(source) {
    const blockRe = /lines\.push\(\n([\s\S]*?)\n([ \t]*)\);/g;
    let changed = false;
    const steps = [];
    const termRe = /^(?:\([^\n]*\)|["'](?:\\.|[^"'\\])*["']|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)$/;
    const after = String(source).replace(blockRe, (whole, body, closeIndent) => {
      const lines = body.split(/\r?\n/);
      const meaningful = lines.map((line, i) => ({ line, i, value: line.trim() })).filter(x => x.value);
      if (meaningful.length < 2) return whole;
      if (!meaningful.every(x => termRe.test(x.value))) return whole;
      // Every term is a standalone expression and there are no existing separators/operators.
      changed = true;
      steps.push({ id: "MISSING_CONCAT_LINES_PUSH", status: "CANDIDATE", reason: "standalone lines.push terms tanpa operator concatenation" });
      const rebuiltLines = meaningful.map((x, i) => {
        const indent = x.line.match(/^\s*/)?.[0] ?? "    ";
        return indent + (i === 0 ? x.value : "+ " + x.value);
      });
      return "lines.push(\n" + rebuiltLines.join("\n") + "\n" + closeIndent + ");";
    });
    return { text: after, changed, steps };
  }

  function hasDeterministicLinesPushConcat(source) {
    return repairDeterministicLinesPushConcat(source).changed;
  }

  function repairDeterministicMissingObjectComma(source) {
    const propRe = /^(?:[A-Za-z_$][\w$]*|["'][^"'\r\n]+["'])\s*:\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|-?(?:\d+(?:\.\d+)?|\.\d+)|true|false|null)\s*,?$/;
    const blockRe = /((?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*\{)([\s\S]*?)(\n[ \t]*\})/g;
    let changed = false;
    const steps = [];
    const after = String(source).replace(blockRe, (whole, open, body, close) => {
      const lines = body.split(/\r?\n/);
      for (let i = 0; i < lines.length - 1; i++) {
        const a = lines[i];
        const b = lines[i + 1];
        if (!propRe.test(a.trim()) || !propRe.test(b.trim())) continue;
        if (/,[ \t]*$/.test(a)) continue;
        lines[i] = a.replace(/[ \t]*$/, ',');
        changed = true;
        steps.push({ id: "MISSING_OBJECT_COMMA", status: "CANDIDATE", reason: "dua property literal berurutan di dalam object literal tanpa koma" });
      }
      return open + lines.join("\n") + close;
    });
    return { text: after, changed, steps };
  }

  function hasDeterministicMissingObjectComma(source) {
    return repairDeterministicMissingObjectComma(source).changed;
  }

  function repairDeterministicObjectPropertyPlus(source) {
    const s=String(source);
    // Only repair an object-property continuation when the value is a complete
    // identifier/member expression and the next line begins a string literal.
    // The object boundary may occur mid-line: `const x = { title: name\n  " | " }`.
    const re=/(^|[,{]\s*)([A-Za-z_$][\w$]*\s*:\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\n([ \t]*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')(?=\s*[,}])/gm;
    let changed=false;
    const text=s.replace(re,(m,prefix,property,indent,str)=>{
      changed=true;
      return prefix+property+"\n"+indent+"+ "+str;
    });
    return {text,changed,steps:changed?[{id:"MISSING_CONCAT_OBJECT_PROPERTY",status:"CANDIDATE",reason:"object property value diikuti string literal tanpa operator"}]:[]};
  }


  function applyDeterministicSourceRules(text) {
    const result = repairDeterministicMissingObjectComma(String(text ?? ""));
    return result;
  }

  /* ================================================================
   * TOKEN-AWARE REPAIR KERNEL (v0.9.19)
   * Tanpa eval / Function / network / DOM. Lexer + penganalisis konteks daftar
   * (object / array / argumen) yang hanya mengusulkan patch bila dapat DIBUKTIKAN
   * dari struktur token. Tebakan nilai/niat pengguna tidak pernah dibuat.
   * ================================================================ */
  const TOKEN_RULE_LIMIT = 1500000;
  const TK_NOT_VALUE_END = new Set([
    "return","throw","typeof","void","delete","new","in","of","instanceof","yield","await","case","do","else",
    "try","catch","finally","if","for","while","switch","with","var","let","const","function","class","extends",
    "import","export","default","break","continue","debugger"
  ]);
  const TK_REGEX_BEFORE = new Set(["return","typeof","instanceof","in","of","new","delete","void","throw","case","do","else","yield","await"]);
  const TK_OBJECT_BEFORE = new Set(["return","throw","yield","await","typeof","void","delete"]);
  const TK_INFIX_WORDS = new Set(["in","of","instanceof","extends","as","from"]);
  const TK_MODIFIERS = new Set(["async","get","set","static","as"]);
  const TK_PUNCT = [">>>=","...","===","!==","**=","<<=",">>=",">>>","&&=","||=","??=","=>","==","!=","<=",">=","&&","||","??","?.","++","--","+=","-=","*=","/=","%=","&=","|=","^=","**","<<",">>"];

  function lexJsTokens(src) {
    const s = String(src), n = s.length, root = [];
    const err = { unterminatedString: false, unterminatedComment: false, unterminatedTemplate: false, unterminatedRegex: false, jsx: false, badChar: false };
    const NUM = /(?:0[xX][\da-fA-F_]+n?|0[bB][01_]+n?|0[oO][0-7_]+n?|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?n?)/y;
    const ID_START = /[\p{L}\p{Nl}$_#]/u, ID_PART = /[\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}$\u200c\u200d]/u;
    function skipStr(j) {
      const q = s[j]; j++;
      while (j < n) {
        const c = s[j];
        if (c === "\\") { j += 2; continue; }
        if (c === q) return j + 1;
        if (c === "\n") return -1;
        j++;
      }
      return -1;
    }
    function skipTemplate(j, subs) {
      while (j < n) {
        const c = s[j];
        if (c === "\\") { j += 2; continue; }
        if (c === "`") return j + 1;
        if (c === "$" && s[j + 1] === "{") { const arr = []; j = scan(j + 2, arr, true); if (j < 0) return -1; subs.push(arr); continue; }
        j++;
      }
      return -1;
    }
    function regexOk(toks) {
      const p = toks[toks.length - 1];
      if (!p) return true;
      if (p.t === "p") return !(p.v === ")" || p.v === "]" || p.v === "}" || p.v === "++" || p.v === "--");
      if (p.t === "id") { const pp = toks[toks.length - 2]; return TK_REGEX_BEFORE.has(p.v) && !(pp && pp.t === "p" && (pp.v === "." || pp.v === "?.")); }
      return false;
    }
    // scan: memindai token mulai i. nested=true berarti di dalam ${ ... }: berhenti pada '}' yang menutup dan mengembalikan indeks setelahnya.
    function scan(i, toks, nested) {
      let nl = false, depth = 0;
      while (i < n) {
        const c = s[i];
        if (c === "\n" || c === "\u2028" || c === "\u2029") { nl = true; i++; continue; }
        if (c === " " || c === "\t" || c === "\r" || c === "\f" || c === "\v" || c === "\u00a0" || c === "\ufeff") { i++; continue; }
        if (c === "/" && s[i + 1] === "/") { while (i < n && s[i] !== "\n") i++; continue; }
        if (c === "/" && s[i + 1] === "*") {
          const e = s.indexOf("*/", i + 2);
          if (e < 0) { err.unterminatedComment = true; return -1; }
          if (s.slice(i, e).indexOf("\n") >= 0) nl = true;
          i = e + 2; continue;
        }
        if (!nested && i === 0 && c === "#" && s[1] === "!") { while (i < n && s[i] !== "\n") i++; continue; }
        const start = i;
        let t = null, v = null, subs = null;
        if (c === '"' || c === "'") {
          const e = skipStr(i); if (e < 0) { err.unterminatedString = true; return -1; }
          i = e; t = "str";
        } else if (c === "`") {
          subs = [];
          const e = skipTemplate(i + 1, subs); if (e < 0) { err.unterminatedTemplate = true; return -1; }
          i = e; t = "tpl";
        } else if ((c >= "0" && c <= "9") || (c === "." && s[i + 1] >= "0" && s[i + 1] <= "9")) {
          NUM.lastIndex = i; const m = NUM.exec(s);
          if (!m) { err.badChar = true; return -1; }
          i += m[0].length; t = "num";
        } else if (c === "/" && regexOk(toks)) {
          let j = i + 1, cls = false, ok = false;
          while (j < n) {
            const d = s[j];
            if (d === "\n") break;
            if (d === "\\") { j += 2; continue; }
            if (d === "[") cls = true; else if (d === "]") cls = false;
            else if (d === "/" && !cls) { ok = true; j++; break; }
            j++;
          }
          if (!ok) { err.unterminatedRegex = true; return -1; }
          while (j < n && /[A-Za-z]/.test(s[j])) j++;
          i = j; t = "re";
        } else {
          const cp = s.codePointAt(i), ch = String.fromCodePoint(cp);
          if (ID_START.test(ch)) {
            let j = i + ch.length;
            while (j < n) { const cp2 = s.codePointAt(j), ch2 = String.fromCodePoint(cp2); if (ID_PART.test(ch2)) j += ch2.length; else break; }
            t = "id"; v = s.slice(i, j); i = j;
          } else {
            t = "p"; v = null;
            for (const pu of TK_PUNCT) { if (s.startsWith(pu, i)) { v = pu; break; } }
            if (v === "?." && s[i + 2] >= "0" && s[i + 2] <= "9") v = "?";
            if (v === null) v = c;
            i += v.length;
            if (v === "<" && s[i] === "/" && /[A-Za-z>]/.test(s[i + 1] || "")) err.jsx = true;
            if (v === "/" && s[i] === ">") err.jsx = true;
            if (nested) {
              if (v === "{") depth++;
              else if (v === "}") { if (depth === 0) return i; depth--; }
            }
          }
        }
        const tkn = { t, v, s: start, e: i, nl };
        if (subs && subs.length) tkn.subs = subs;
        toks.push(tkn);
        nl = false;
      }
      if (nested) { err.unterminatedTemplate = true; return -1; }
      return i;
    }
    scan(0, root, false);
    return { toks: root, err };
  }

  function tkIsValueEnd(a, pa) {
    if (!a) return false;
    if (a.t === "num" || a.t === "str" || a.t === "tpl" || a.t === "re") return true;
    if (a.t === "id") {
      if (pa && pa.t === "p" && (pa.v === "." || pa.v === "?.")) return true;
      if (TK_NOT_VALUE_END.has(a.v)) return false;
      if (TK_MODIFIERS.has(a.v)) return "mod";
      return true;
    }
    return a.v === ")" || a.v === "]" || a.v === "}";
  }
  function tkIsValueStart(b, a) {
    if (b.t === "id") return !TK_INFIX_WORDS.has(b.v);
    if (b.t === "num" || b.t === "str") return true;
    if (b.t === "p") {
      if (b.v === "...") return true;
      if (b.v === "!" || b.v === "~") return true;
      if (b.v === "{") return a.t !== "id" && a.v !== ")";
    }
    return false;
  }
  function tkBraceKind(toks, k, fr, colonTernary) {
    const P = toks[k - 1];
    if (!P) return "block";
    if (P.t === "p") {
      if (P.v === "," && toks[k - 3] && toks[k - 3].t === "id" && toks[k - 3].v === "import" && toks[k - 2] && toks[k - 2].t === "id") return "block";
      if (P.v === ")" || P.v === "]" || P.v === "}" || P.v === ";" || P.v === "{" || P.v === "=>") return "block";
      if (P.v === ":") return (colonTernary[k - 1] || (fr && fr.kind === "object")) ? "object" : "block";
      return "object";
    }
    if (P.t === "id") {
      const PP = toks[k - 2];
      const afterDot = PP && PP.t === "p" && (PP.v === "." || PP.v === "?.");
      if (!afterDot && TK_OBJECT_BEFORE.has(P.v)) return "object";
      if (!afterDot && P.v === "default" && PP && PP.t === "id" && PP.v === "export") return "object";
    }
    return "block";
  }

  function analyzeJsTokens(src, lexed) {
    const lx = lexed || lexJsTokens(src);
    const out = { toks: lx.toks, err: lx.err, adjacent: [], semis: [], stray: [], unclosed: [], mismatch: null };
    const CLOSE = { "{": "}", "[": "]", "(": ")" };
    const lists = [{ toks: lx.toks, main: true }];
    (function gather(arr) { for (const t of arr) if (t.subs) for (const sub of t.subs) { lists.push({ toks: sub, main: false }); gather(sub); } })(lx.toks);
    for (const L of lists) {
      const toks = L.toks, stack = [], colonTernary = [];
      let broke = false;
      for (let k = 0; k < toks.length; k++) {
        const tk = toks[k], fr = stack[stack.length - 1];
        if (fr && fr.listy && fr.prev >= 0) {
          const a = toks[fr.prev], pa = toks[fr.prev - 1];
          const ve = tkIsValueEnd(a, pa);
          if (ve === true && tkIsValueStart(tk, a)) out.adjacent.push(a.e);
          else if (ve === "mod" && tk.t !== "id" && tk.t !== "str" && tk.t !== "num" && !(tk.t === "p" && (tk.v === "[" || tk.v === "*" || tk.v === "{" || tk.v === "...")) && tkIsValueStart(tk, a)) out.adjacent.push(a.e);
        }
        if (tk.t === "p") {
          const v = tk.v;
          if (v === "{" || v === "(" || v === "[") {
            let kind = "list", listy = true, forParen = false;
            if (v === "{") { kind = tkBraceKind(toks, k, fr, colonTernary); listy = kind === "object"; }
            if (v === "(") {
              const p1 = toks[k - 1], p2 = toks[k - 2];
              forParen = !!(p1 && p1.t === "id" && (p1.v === "for" || (p1.v === "await" && p2 && p2.t === "id" && p2.v === "for")));
            }
            stack.push({ ch: v, kind, listy, prev: -1, q: 0, forParen, openIdx: k });
            continue;
          }
          if (v === ")" || v === "]" || v === "}") {
            if (!stack.length) { if (L.main) out.stray.push(k); else out.mismatch = { index: -1, expected: null, inTemplate: true }; continue; }
            const top = stack[stack.length - 1];
            if (CLOSE[top.ch] !== v) { out.mismatch = { index: L.main ? k : -1, expected: CLOSE[top.ch], inTemplate: !L.main }; broke = true; break; }
            stack.pop();
            if (stack.length) stack[stack.length - 1].prev = k;
            continue;
          }
          if (fr) {
            if (v === "?") fr.q++;
            else if (v === ":" && fr.q > 0) { fr.q--; colonTernary[k] = true; }
            else if (v === ";" && ((fr.ch === "(" && !fr.forParen) || fr.ch === "[")) out.semis.push(tk.s);
          }
        }
        if (fr) fr.prev = k;
      }
      if (!broke && stack.length) {
        if (L.main) out.unclosed = stack.map(f => f.openIdx);
        else out.mismatch = { index: -1, expected: null, inTemplate: true };
      }
      if (broke) break;
    }
    return out;
  }

  function tkSkipTokenRules(source, opts) {
    // Artefak String(objek) bukan source code: jangan pernah "diperbaiki".
    if (/^\s*\[object [A-Za-z]+\]\s*$/.test(source)) return true;
    const name = String((opts && (opts.source || opts.extension)) || "");
    if (/\.(?:ts|tsx|mts|cts|jsx|vue|svelte)\b/i.test(name)) return true;
    return /^\s*(?:export\s+)?(?:declare\s+|abstract\s+)?(?:interface\s+[A-Za-z_$]|enum\s+[A-Za-z_$]|namespace\s+[A-Za-z_$]|type\s+[A-Za-z_$][\w$]*\s*(?:<[^>\n]*>)?\s*=)/m.test(source)
      || /\)\s*:\s*(?:string|number|boolean|void|any|unknown|never|Promise<[^>\n]*>)\s*(?:\{|=>)/.test(source)
      || /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*:\s*[A-Za-z_$][\w$<>\[\]|,. ]*\s*=/.test(source);
  }

  /** Analisis token untuk gate: null bila kernel tidak berlaku (JSON/TS/JSX/lex gagal/terlalu besar). */
  function tokenRuleAnalysis(source, opts) {
    const s = String(source ?? "");
    if (s.length > TOKEN_RULE_LIMIT || tkSkipTokenRules(s, opts)) return null;
    const a = analyzeJsTokens(s);
    const e = a.err;
    if (e.unterminatedString || e.unterminatedComment || e.unterminatedTemplate || e.unterminatedRegex || e.jsx || e.badChar) return null;
    return a;
  }

  /* ---------- JSON ---------- */
  function lexJsonTokens(src) {
    const s = String(src), n = s.length, toks = [];
    const NUMJ = /-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
    let i = 0;
    while (i < n) {
      const c = s[i];
      if (c === " " || c === "\t" || c === "\r" || c === "\n" || c === "\ufeff") { i++; continue; }
      if (c === "{" || c === "}" || c === "[" || c === "]" || c === "," || c === ":") { toks.push({ t: "p", v: c, s: i, e: i + 1 }); i++; continue; }
      if (c === '"') {
        let j = i + 1;
        while (j < n && s[j] !== '"') { if (s[j] === "\n") return null; j += s[j] === "\\" ? 2 : 1; }
        if (j >= n) return null;
        toks.push({ t: "str", v: null, s: i, e: j + 1 }); i = j + 1; continue;
      }
      if (c === "-" || (c >= "0" && c <= "9") || c === ".") {
        NUMJ.lastIndex = i; const m = NUMJ.exec(s);
        if (!m) return null;
        toks.push({ t: "num", v: null, s: i, e: i + m[0].length }); i += m[0].length; continue;
      }
      const lit = /^(?:true|false|null)/.exec(s.slice(i, i + 5));
      if (lit) { toks.push({ t: "lit", v: null, s: i, e: i + lit[0].length }); i += lit[0].length; continue; }
      return null;
    }
    return toks;
  }
  /** {valid} bila teks berbentuk JSON murni (token JSON saja, diawali { atau [); selain itu null. */
  function jsonModeOf(source) {
    const s = String(source ?? "");
    if (s.length > TOKEN_RULE_LIMIT) return null;
    const t = s.replace(/^\ufeff/, "").trimStart();
    if (t[0] !== "{" && t[0] !== "[") return null;
    const toks = lexJsonTokens(s);
    if (!toks || !toks.length) return null;
    let valid = true;
    try { JSON.parse(s); } catch (_) { valid = false; }
    return { valid, toks };
  }

  function planJsonRepairs(source) {
    const s = String(source);
    const jm = jsonModeOf(s);
    if (!jm || jm.valid) return { text: s, changed: false, steps: [] };
    const T = jm.toks, edits = [], closers = [];
    const FAIL = { fail: true };
    let p = 0;
    const isStart = t => !!t && (t.t === "str" || t.t === "num" || t.t === "lit" || t.v === "{" || t.v === "[");
    const lineOf = pos => s.slice(0, pos).split("\n").length;
    function parseValue() {
      const t = T[p];
      if (!t) throw FAIL;
      if (t.t === "str" || t.t === "num" || t.t === "lit") { p++; return; }
      if (t.v === "{") return parseObject();
      if (t.v === "[") return parseArray();
      throw FAIL;
    }
    function dropComma(c) { edits.push({ pos: T[c].s, del: 1, ins: "", id: "JSON_TRAILING_COMMA", reason: "koma sisa sebelum penutup / akhir data (baris " + lineOf(T[c].s) + ")" }); }
    function addComma() { const a = T[p - 1]; edits.push({ pos: a.e, del: 0, ins: ",", id: "JSON_MISSING_COMMA", reason: "dua nilai/anggota JSON berurutan tanpa koma (baris " + lineOf(a.e) + ")" }); }
    function parseObject() {
      p++;
      for (;;) {
        let t = T[p];
        if (!t) { closers.push("}"); return; }
        if (t.v === "}") { p++; return; }
        if (t.t !== "str") throw FAIL;
        p++;
        if (!T[p] || T[p].v !== ":") throw FAIL;
        p++;
        parseValue();
        t = T[p];
        if (!t) { closers.push("}"); return; }
        if (t.v === ",") {
          const c = p; p++;
          if (!T[p]) { dropComma(c); closers.push("}"); return; }
          if (T[p].v === "}") { dropComma(c); p++; return; }
          continue;
        }
        if (t.v === "}") { p++; return; }
        if (t.t === "str") { addComma(); continue; }
        throw FAIL;
      }
    }
    function parseArray() {
      p++;
      for (;;) {
        let t = T[p];
        if (!t) { closers.push("]"); return; }
        if (t.v === "]") { p++; return; }
        parseValue();
        t = T[p];
        if (!t) { closers.push("]"); return; }
        if (t.v === ",") {
          const c = p; p++;
          if (!T[p]) { dropComma(c); closers.push("]"); return; }
          if (T[p].v === "]") { dropComma(c); p++; return; }
          continue;
        }
        if (t.v === "]") { p++; return; }
        if (isStart(t)) { addComma(); continue; }
        throw FAIL;
      }
    }
    try { parseValue(); if (p < T.length) throw FAIL; } catch (e) { if (e !== FAIL) throw e; return { text: s, changed: false, steps: [] }; }
    if (closers.length) {
      const last = T[T.length - 1];
      edits.push({ pos: last.e, del: 0, ins: closers.join(""), id: "JSON_TRUNCATED_CLOSE", reason: "data JSON terpotong; ditutup dengan " + closers.join("") + " sesuai urutan struktur" });
    }
    const sorted = edits.slice().sort((a, b) => b.pos - a.pos || (b.del - a.del));
    let text = s;
    for (const ed of sorted) text = text.slice(0, ed.pos) + ed.ins + text.slice(ed.pos + ed.del);
    let ok = true;
    try { JSON.parse(text); } catch (_) { ok = false; }
    if (!ok || text === s) return { text: s, changed: false, steps: [] };
    return { text, changed: true, steps: edits.slice().sort((a, b) => a.pos - b.pos).map(e => ({ id: e.id, status: "CANDIDATE", reason: e.reason })) };
  }

  /* ---------- JS token rules ---------- */
  const TK_CONTINUATION = new Set([".","?.","?",":","+","-","*","/","%","&&","||","??","=","==","===","!=","!==","<",">","<=",">=","&","|","^","=>","**","<<",">>",",","else","catch","finally","in","of","instanceof","as"]);

  function jsLineTables(s) {
    const starts = [0];
    for (let i = 0; i < s.length; i++) if (s[i] === "\n") starts.push(i + 1);
    const lineOfPos = pos => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; } return lo; };
    const indentOfLine = li => {
      const end = starts[li + 1] === undefined ? s.length : starts[li + 1];
      const m = /^[ \t]*/.exec(s.slice(starts[li], end));
      let w = 0; for (const ch of m[0]) w += ch === "\t" ? 4 : 1;
      return { width: w, text: m[0] };
    };
    const lineEndPos = pos => { const e = s.indexOf("\n", pos); return e < 0 ? s.length : (s[e - 1] === "\r" ? e - 1 : e); };
    return { starts, lineOfPos, indentOfLine, lineEndPos };
  }

  /** Simulasi tumpukan penutup berbasis indentasi. Mengembalikan null bila tidak dapat dibuktikan. */
  function planClosersByIndent(s, a, eol) {
    const toks = a.toks, T = jsLineTables(s), edits = [];
    const CLOSE = { "{": "}", "[": "]", "(": ")" };
    const OPERATOR_START = new Set([".","?.","?",":","+","-","*","/","%","&&","||","??","=","==","===","!=","!==","<",">","<=",">=","&","|","^","=>","**","<<",">>",",","in","of","instanceof","as"]);
    const stack = [];
    const pendingAt = new Map(); // pos -> {pos,text,why[]}
    const addInsert = (pos, closer, ind, why) => {
      const cur = pendingAt.get(pos) || { pos, text: "", why: [] };
      cur.text += eol + ind.text + closer; cur.why.push(why);
      pendingAt.set(pos, cur);
      return cur;
    };
    const parentWantsComma = par => !!par && (par.ch === "(" || par.ch === "[" || (par.ch === "{" && par.objectLike));
    let inserted = 0;
    for (let k = 0; k < toks.length; k++) {
      const tk = toks[k];
      const li = T.lineOfPos(tk.s);
      const first = k === 0 || tk.nl;
      const isOpen = tk.t === "p" && (tk.v === "{" || tk.v === "(" || tk.v === "[");
      const isClose = tk.t === "p" && (tk.v === "}" || tk.v === ")" || tk.v === "]");
      if (first && stack.length && k > 0) {
        const W = T.indentOfLine(li).width;
        const word = (tk.t === "p" || tk.t === "id") ? tk.v : "";
        const prevTok = toks[k - 1];
        const chainWord = tk.t === "id" && (word === "else" || word === "catch" || word === "finally") && prevTok && prevTok.t === "p" && prevTok.v === "}";
        // Gaya Allman: else/catch/finally di awal baris harus sejajar dengan '}' sebelumnya; selain itu indentasi tidak dapat dipercaya.
        if (chainWord && T.indentOfLine(T.lineOfPos(prevTok.s)).width !== W) return null;
        let last = null;
        while (stack.length) {
          const top = stack[stack.length - 1];
          if (top.li === li) break;
          if (!isClose && !chainWord && OPERATOR_START.has(word) && W <= top.ind.width) return null; // ambigu: operator/generator di awal baris
          const missing = isClose ? (W < top.ind.width) : (W <= top.ind.width && !chainWord);
          if (!missing) break;
          last = addInsert(T.lineEndPos(prevTok.e), CLOSE[top.ch], top.ind, "baris " + (li + 1) + " menjorok " + W + " <= pembuka '" + top.ch + "' (baris " + (top.li + 1) + ", indentasi " + top.ind.width + ")");
          stack.pop(); inserted++;
        }
        if (last) {
          const par = stack[stack.length - 1];
          const nextIsFlow = isClose || (tk.t === "p" && (tk.v === "," || tk.v === ";"));
          if (parentWantsComma(par) && !nextIsFlow) last.text += ",";
        }
      }
      if (isOpen) {
        const par = stack[stack.length - 1];
        const prev = toks[k - 1];
        let objectLike = false;
        if (tk.v === "{") objectLike = (prev && prev.t === "id" && (prev.v === "const" || prev.v === "let" || prev.v === "var")) || tkBraceKind(toks, k, par ? { kind: par.objectLike ? "object" : "block" } : null, []) === "object";
        stack.push({ ch: tk.v, li, ind: T.indentOfLine(li), objectLike });
        continue;
      }
      if (isClose) {
        const top = stack[stack.length - 1];
        if (!top) continue; // stray: ditangani aturan lain
        if (CLOSE[top.ch] !== tk.v) return null;
        stack.pop();
      }
    }
    // sisa tumpukan: semua baris sesudah pembuka lebih menjorok (bila tidak, sudah ditutup di atas)
    let leftover = 0;
    if (stack.length) {
      const lastTok = toks[toks.length - 1];
      if (!lastTok) return null;
      const tailPos = T.lineEndPos(lastTok.e);
      for (let i = stack.length - 1; i >= 0; i--) { addInsert(tailPos, CLOSE[stack[i].ch], stack[i].ind, "penutup '" + CLOSE[stack[i].ch] + "' hilang di akhir file; semua baris sesudah pembuka (baris " + (stack[i].li + 1) + ") lebih menjorok"); leftover++; }
    }
    if (!inserted && !leftover) return null;
    for (const e of pendingAt.values()) edits.push({ pos: e.pos, del: 0, ins: e.text, id: "MISSING_CLOSER_INDENT", reason: e.why.join("; ") });
    return edits;
  }

  /** Koherensi indentasi: setiap penutup di awal baris harus sejajar dengan baris pembukanya. */
  function indentCoherent(s, a) {
    const toks = a.toks, T = jsLineTables(s), CLOSE = { "{": "}", "[": "]", "(": ")" };
    const stack = [];
    for (let k = 0; k < toks.length; k++) {
      const tk = toks[k];
      if (tk.t !== "p") continue;
      if (tk.v === "{" || tk.v === "(" || tk.v === "[") { const li = T.lineOfPos(tk.s); stack.push({ ch: tk.v, li, w: T.indentOfLine(li).width }); continue; }
      if (tk.v === "}" || tk.v === ")" || tk.v === "]") {
        const top = stack.pop();
        if (!top || CLOSE[top.ch] !== tk.v) return false;
        if (k === 0 || tk.nl) {
          const li = T.lineOfPos(tk.s);
          if (li !== top.li && T.indentOfLine(li).width !== top.w) return false;
        }
      }
    }
    return stack.length === 0;
  }

  function maskJsNoise(source) {
    const s=String(source??""); const out=s.split(""); let mode="code", quote="", esc=false, rxClass=false;
    for(let i=0;i<s.length;i++){
      const c=s[i], n=s[i+1];
      if(mode==="line"){ if(c!=="\n"&&c!=="\r") out[i]=" "; else mode="code"; continue; }
      if(mode==="block"){ if(c==="*"&&n==="/"){out[i]=out[i+1]=" "; i++; mode="code";} else if(c!=="\n"&&c!=="\r") out[i]=" "; continue; }
      if(mode==="string"||mode==="template"){ if(c!=="\n"&&c!=="\r") out[i]=" "; if(esc){esc=false;} else if(c==="\\"){esc=true;} else if(c===quote){mode="code";} continue; }
      if(mode==="regex"){ if(c!=="\n"&&c!=="\r") out[i]=" "; if(esc){esc=false;} else if(c==="\\"){esc=true;} else if(c==="["){rxClass=true;} else if(c==="]"){rxClass=false;} else if(c==="/"&&!rxClass){mode="code";} continue; }
      if(c==="/"&&n==="/"){out[i]=out[i+1]=" "; i++; mode="line"; continue;}
      if(c==="/"&&n==="*"){out[i]=out[i+1]=" "; i++; mode="block"; continue;}
      if(c==='"'||c==="'"){out[i]="S"; quote=c; esc=false; mode="string"; continue;}
      if(c==='`'){out[i]="T"; quote='`'; esc=false; mode="template"; continue;}
      if(c==="/"&&regexAllowedAt(s,i)){out[i]="R"; esc=false; rxClass=false; mode="regex"; continue;}
    }
    return out.join("");
  }

  function repairDeterministicMissingHeaderParen(source) {
    const s = String(source), scan = maskJsNoise(s), edits = [];
    // Header repair is deliberately line-bounded but allows an inline block body:
    //   if (x > 1 { return x; }  ->  if (x > 1) { return x; }
    // It must never jump across a newline, string/template, or another block opener.
    const control = /(^|[\n;}])([ \t]*)(if|while|switch|catch)\s*\(([^\n{};]*?)\s*\{/g;
    const forControl = /(^|[\n;}])([ \t]*)for\s*\(([^\n{}]*?)\s*\{/g;
    let m;
    while ((m = control.exec(scan))) {
      const brace = m.index + m[0].length - 1;
      let insertPos = brace; while (insertPos > m.index && /\s/.test(s[insertPos - 1])) insertPos--;
      const before = s.slice(m.index, insertPos);
      if (!/\)\s*$/.test(before) && !/\)/.test(m[4]||"")) edits.push({pos:insertPos,del:0,ins:")",id:"MISSING_PAREN_HEADER",reason:"control header membuka block sebelum ')'"});
    }
    while ((m = forControl.exec(scan))) {
      const brace = m.index + m[0].length - 1;
      let insertPos = brace; while (insertPos > m.index && /\s/.test(s[insertPos - 1])) insertPos--;
      const before = s.slice(m.index, insertPos);
      if (!/\)\s*$/.test(before) && !/\)/.test(m[3]||"")) edits.push({pos:insertPos,del:0,ins:")",id:"MISSING_PAREN_HEADER",reason:"for header membuka block sebelum ')'"});
    }
    const fn = /(^|[\n;}])([ \t]*)(?:export\s+(?:default\s+)?)?(?:async\s+)?function(?:\s+[*]?[A-Za-z_$][\w$]*)?\s*\(([^\n{}]*?)\s*\{/g;
    while ((m = fn.exec(scan))) {
      const lineEnd = s.indexOf("\n", m.index);
      const brace = s.lastIndexOf("{", lineEnd < 0 ? s.length : lineEnd);
      if (brace < m.index) continue;
      let insertPos = brace; while (insertPos > m.index && /\s/.test(s[insertPos - 1])) insertPos--;
      const before = s.slice(m.index, insertPos);
      if (!/\)\s*$/.test(before)) edits.push({pos:insertPos,del:0,ins:")",id:"MISSING_PAREN_FUNCTION_DECL",reason:"function declaration membuka block sebelum ')'"});
    }
    if (!edits.length) return {text:s,changed:false,steps:[]};
    const text=edits.slice().sort((a,b)=>b.pos-a.pos).reduce((o,e)=>o.slice(0,e.pos)+e.ins+o.slice(e.pos+e.del),s);
    return {text,changed:text!==s,steps:edits.map(e=>({id:e.id,status:"CANDIDATE",reason:e.reason}))};
  }

  function hasAmbiguousMultilineAssignment(source) {
    const s=String(source);
    return /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*\n\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\n\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*;/.test(s);
  }

  function repairDeterministicMultilinePlus(source) {
    const s=String(source), lines=s.split(/(\r?\n)/), steps=[];
    const term=/^(?:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\d+(?:\.\d+)?)\s*$/;
    const str=/^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*$/;
    let changed=false, assignment=false;
    for(let i=0;i<lines.length;i+=2){
      const raw=lines[i], t=raw.trim(); if(!t) continue;
      if(/\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*$/.test(t)){assignment=true;continue;}
      const next=lines[i+2]; if(next==null||!next.trim()) continue;
      const a0=t.replace(/^\+\s+/,'').replace(/;\s*$/,'').trim(), b=next.trim().replace(/;\s*$/,'').trim();
      const assignmentContext=assignment||/\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=/.test(raw);
      const objectContext=/^[A-Za-z_$][\w$]*\s*:\s*.+$/.test(t)&&str.test(b);
      const objectValue=objectContext ? t.replace(/^[A-Za-z_$][\w$]*\s*:\s*/,'').trim() : a0;
      if(!assignmentContext&&!objectContext) continue;
      // Assignment concatenation is only deterministic when a string literal
      // participates in the continuation. Generic `a` / `b` adjacency is REVIEW.
      if(assignmentContext&&!objectContext&&!str.test(a0)&&!str.test(b)) continue;
      if(!term.test(objectValue)||!term.test(b)) continue;
      if(/[,+*/?:]|\.\.\.|&&|\|\||=>|[-]\s*$/.test(objectValue)) continue;
      lines[i+2]=next.replace(/^(\s*)/,'$1+ '); changed=true;
      steps.push({id:objectContext?"MISSING_CONCAT_OBJECT_PROPERTY":"MISSING_CONCAT_ASSIGNMENT",status:"CANDIDATE",reason:objectContext?"object property value continuation":"assignment multiline expression continuation"});
      if(/;\s*$/.test(next)) assignment=false;
    }
    const text=lines.join(''); return {text,changed:text!==s,steps};
  }

  function planJsTokenRepairs(source, opts, depth) {
    const original=String(source), prefix=[];
    let s=original;
    const none=()=>({text:s,changed:false,steps:prefix.slice()});
    const header=repairDeterministicMissingHeaderParen(s);
    if(header.changed){ prefix.push(...header.steps); const g=tokenRuleAnalysis(header.text,opts); s=header.text; if(g&&!g.mismatch&&!g.stray.length&&!g.unclosed.length)return{text:s,changed:true,steps:prefix}; }
    const plus=repairDeterministicMultilinePlus(s);
    if(plus.changed){ prefix.push(...plus.steps); const g=tokenRuleAnalysis(plus.text,opts); s=plus.text; if(g&&!g.mismatch&&!g.stray.length&&!g.unclosed.length&&!g.adjacent.length)return{text:s,changed:true,steps:prefix}; }
    const a=tokenRuleAnalysis(s,opts); if(!a||(a.mismatch&&a.mismatch.inTemplate))return none();
    const toks=a.toks,eol=/\r\n/.test(s)?"\r\n":"\n";
    const lineOf=pos=>s.slice(0,pos).split("\n").length;
    const apply=edits=>edits.slice().sort((x,y)=>y.pos-x.pos||(y.del-x.del)).reduce((text,e)=>text.slice(0,e.pos)+e.ins+text.slice(e.pos+e.del),s);
    const stepsOf=edits=>edits.slice().sort((x,y)=>x.pos-y.pos).map(e=>({id:e.id,status:"CANDIDATE",reason:e.reason}));
    const imbalanced=!!(a.mismatch||a.unclosed.length||a.stray.length);
    if(!imbalanced){
      const commaEdits=[],seen=new Set();
      for(const pos of a.adjacent){if(seen.has(pos))continue;seen.add(pos);commaEdits.push({pos,del:0,ins:",",id:"MISSING_LIST_COMMA",reason:"context daftar tanpa koma (baris "+lineOf(pos)+")"});}
      if(!commaEdits.length)return none();
      const text=apply(commaEdits),t2=tokenRuleAnalysis(text,opts);
      if(text===s||!t2||t2.mismatch||t2.stray.length||t2.unclosed.length||t2.adjacent.length)return none();
      return{text,changed:true,steps:prefix.concat(stepsOf(commaEdits))};
    }
    if(depth||balancedDelimiters(s).balanced)return none();
    let closeEdits=[];
    if(a.stray.length&&!a.unclosed.length&&!a.mismatch){
      const n=toks.length,st=a.stray,tailOk=st.every((k,i)=>k===n-st.length+i);
      if(tailOk){const lineStartOf=pos=>s.lastIndexOf("\n",pos-1)+1;let alone=true;for(const k of st){const ls=lineStartOf(toks[k].s),le=s.indexOf("\n",toks[k].e),rowEnd=le<0?s.length:le;if(s.slice(ls,toks[k].s).trim()||s.slice(toks[k].e,rowEnd).trim()){alone=false;break;}}if(alone){const ls=lineStartOf(toks[st[0]].s);if(!s.slice(ls).replace(/[}\])\s]/g,""))closeEdits=[{pos:ls,del:s.length-ls,ins:"",id:"STRAY_CLOSER_EOF",reason:"penutup berlebih di akhir file"}];}}
    }else if(!a.stray.length){const plan=planClosersByIndent(s,a,eol);if(plan)closeEdits=plan;}
    if(!closeEdits.length)return none();
    const text1=apply(closeEdits); if(!balancedDelimiters(text1).balanced)return none();
    const t1=tokenRuleAnalysis(text1,opts); if(!t1||t1.mismatch||t1.stray.length||t1.unclosed.length)return none();
    if(closeEdits[0].id==="MISSING_CLOSER_INDENT"&&!indentCoherent(text1,t1))return none();
    const steps=stepsOf(closeEdits),second=planJsTokenRepairs(text1,opts,1);
    if(second.changed)return{text:second.text,changed:true,steps:prefix.concat(steps,second.steps)};
    if(t1.adjacent.length)return none();
    return{text:text1,changed:true,steps:prefix.concat(steps)};
  }
  /** Lokasi masalah terstruktur (baris/kolom) untuk laporan REVIEW — tanpa menebak perbaikan. */
  function describeSourceProblems(source, opts) {
    const s = String(source ?? ""), out = [];
    const T = jsLineTables(s);
    const where = pos => { const li = T.lineOfPos(Math.max(0, Math.min(pos, s.length))); return { line: li + 1, column: Math.max(0, pos) - T.starts[li] + 1, snippet: s.slice(T.starts[li], T.starts[li + 1] === undefined ? s.length : T.starts[li + 1]).replace(/\r?\n$/, "").slice(0, 160) }; };
    const jm = jsonModeOf(s);
    if (jm) {
      if (!jm.valid) { let msg = ""; try { JSON.parse(s); } catch (e) { msg = String(e && e.message || e).slice(0, 160); } out.push({ id: "JSON_PARSE", detail: msg }); }
      return out;
    }
    const a = tokenRuleAnalysis(s, opts);
    if (!a) return out;
    for (const pos of a.adjacent.slice(0, 20)) out.push({ id: "MISSING_LIST_COMMA", ...where(pos), detail: "koma diperlukan setelah elemen ini" });
    for (const pos of a.semis.slice(0, 20)) out.push({ id: "SEMICOLON_IN_PAREN", ...where(pos), detail: "';' tidak valid di dalam tanda kurung/array" });
    if (a.mismatch && a.mismatch.index >= 0) out.push({ id: "DELIMITER_MISMATCH", ...where(a.toks[a.mismatch.index].s), detail: "penutup tidak cocok; diharapkan '" + a.mismatch.expected + "'" });
    else if (a.mismatch) out.push({ id: "DELIMITER_MISMATCH", detail: "tanda kurung tidak seimbang di dalam ${...} template literal" });
    for (const k of a.stray.slice(0, 20)) out.push({ id: "STRAY_CLOSER", ...where(a.toks[k].s), detail: "penutup '" + s[a.toks[k].s] + "' tanpa pembuka" });
    for (const k of a.unclosed.slice(0, 20)) out.push({ id: "UNCLOSED_OPENER", ...where(a.toks[k].s), detail: "pembuka '" + s[a.toks[k].s] + "' belum ditutup" });
    return out;
  }

  /* FILE-AWARE / DOMAIN-SAFE REPAIR LAYER — local only. */
  function detectFileType(file={}) {
    const path=String(file.path||file.name||""); const ext=extensionOf(path); const mime=String(file.mimeType||file.type||"").toLowerCase();
    const byExt=ext ? ({js:"js",mjs:"js",cjs:"js",ts:"js",tsx:"js",jsx:"js",html:"html",htm:"html",css:"css",json:"json",txt:"text",md:"text",markdown:"text"}[ext]||null) : null;
    if(byExt) return {language:byExt,extension:ext,mimeType:mime,basis:"extension"};
    if(mime.includes("html")) return {language:"html",extension:ext,mimeType:mime,basis:"mime"};
    if(mime.includes("css")) return {language:"css",extension:ext,mimeType:mime,basis:"mime"};
    if(mime.includes("javascript")||mime.includes("typescript")) return {language:"js",extension:ext,mimeType:mime,basis:"mime"};
    const d=classifyText(String(file.content||""),{extension:ext,mimeType:mime});
    return {language:d.format==="code"?"js":d.format==="html"?"html":d.format==="css"?"css":d.format==="json"?"json":"text",extension:ext,mimeType:mime,basis:"content"};
  }
  function cssSyntaxGate(source) {
    const s=String(source??""); const d=balancedDelimiters(s,{regex:false});
    const checks=[{id:"CSS_DELIMITERS",status:d.balanced?"PASS":"FAIL",detail:d},{id:"CSS_QUOTES",status:d.unterminatedString?"FAIL":"PASS"},{id:"CSS_COMMENT",status:d.unterminatedComment?"FAIL":"PASS"}];
    const failed=checks.filter(x=>x.status==="FAIL");
    return {status:failed.length?"FAIL":"PASS",pass:!failed.length,scope:"CSS_STRUCTURAL",parser:"INTERNAL_CSS_STRUCTURE",format:"css",checks,failed:failed.map(x=>x.id)};
  }
  function repairCss(source) {
    const s=String(source??""); const pre=cssSyntaxGate(s);
    if(pre.pass) return {status:"NO_PATCH",applied:false,verified:true,sourceSyntax:pre,fullRepairedCode:s,output:{type:"FULL_SOURCE",available:true,code:s,charCount:s.length,lineCount:s.split(/\r?\n/).length},patchLedger:[],appliedRules:[],reason:"valid_css_no_patch"};
    if(pre.failed.some(x=>x!=="CSS_DELIMITERS")) return {status:"REPAIR_FAILED",applied:false,verified:false,sourceSyntax:pre,fullRepairedCode:s,output:{type:"FULL_INPUT_SOURCE",available:true,code:s,charCount:s.length,lineCount:s.split(/\r?\n/).length},patchLedger:[],appliedRules:[],reason:"css_error_not_safely_repairable"};
    const d=pre.checks.find(x=>x.id==="CSS_DELIMITERS")?.detail;
    if(d && d.unclosed>0 && !d.unterminatedString && !d.unterminatedComment) {
      const after=s+Array(d.unclosed).fill("}").join(""); const post=cssSyntaxGate(after);
      if(post.pass) {
        const patch={id:"PATCH-"+digest(after).slice(0,12),file:null,language:"CSS",region:"FULL_FILE",rule:"CSS_MISSING_CLOSER",rootCause:"CSS_BLOCK_UNCLOSED",before:s,after,reason:"unclosed CSS block closed according to deterministic delimiter stack",cycle:1,status:"APPLIED"};
        return {status:"REPAIRED_VERIFIED",applied:true,verified:true,sourceSyntax:post,fullRepairedCode:after,output:{type:"FULL_REPAIRED_SOURCE",available:true,code:after,charCount:after.length,lineCount:after.split(/\r?\n/).length},patchLedger:[patch],appliedRules:[patch.rule],reason:"css_safe_closer_verified"};
      }
    }
    return {status:"REPAIR_FAILED",applied:false,verified:false,sourceSyntax:pre,fullRepairedCode:s,output:{type:"FULL_INPUT_SOURCE",available:true,code:s,charCount:s.length,lineCount:s.split(/\r?\n/).length},patchLedger:[],appliedRules:[],reason:"css_no_safe_candidate"};
  }
  function htmlStructureGate(source) {
    const s=String(source??""); const tags=[]; const voids=new Set(["area","base","br","col","embed","hr","img","input","link","meta","param","source","track","wbr"]);
    const re=/<\s*(\/?)\s*([A-Za-z][\w:-]*)\b[^>]*>/g; let m; let mismatch=null; let scriptDepth=0;
    while((m=re.exec(s))){const closing=!!m[1], tag=m[2].toLowerCase(); if(tag==="script"||tag==="style"){if(!closing)scriptDepth++;else scriptDepth=Math.max(0,scriptDepth-1);} if(scriptDepth>0&&tag!=="script"&&tag!=="style") continue; if(voids.has(tag)||tag.startsWith("!")) continue; if(closing){const last=tags.pop(); if(last!==tag){mismatch={expected:last||null,found:tag,index:m.index};break;}} else tags.push(tag);}
    const checks=[{id:"HTML_TAG_STRUCTURE",status:!mismatch&&tags.length===0?"PASS":"FAIL",detail:{openTags:tags,mismatch}}];
    const failed=checks.filter(x=>x.status==="FAIL"); return {status:failed.length?"FAIL":"PASS",pass:!failed.length,scope:"HTML_STRUCTURAL",parser:"INTERNAL_HTML_STRUCTURE",format:"html",checks,failed:failed.map(x=>x.id)};
  }
  function repairHtml(file, options={}) {
    const source=String(file.content??""); const pre=htmlStructureGate(source); const scripts=[]; const scriptRe=/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi; let m;
    while((m=scriptRe.exec(source))) { const attrs=m[1]||""; const body=m[2]||""; const src=(attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i)||[])[1]||null; scripts.push({start:m.index,openEnd:m.index+m[0].indexOf(">")+1,bodyStart:m.index+m[0].indexOf(">")+1,bodyEnd:m.index+m[0].lastIndexOf("</"),src,body}); }
    const styles=[]; const styleRe=/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi; while((m=styleRe.exec(source))) styles.push({body:m[1]||"",start:m.index});
    const inline=scripts.filter(x=>!x.src); let output=source; const ledger=[]; let changed=false;
    for(let i=inline.length-1;i>=0;i--){const sc=inline[i]; const r=repair(sc.body,{...options,source:(file.path||"HTML")+"#script-inline",autoApply:true}); if(r.applied){const before=output; output=output.slice(0,sc.bodyStart)+r.fullRepairedCode+output.slice(sc.bodyEnd); changed=true; ledger.push(...(r.patchLedger||[]).map(p=>({...p,file:file.path||null,language:"JavaScript",region:"HTML_SCRIPT_INLINE",cycle:p.cycle||1})));} else if(r.status==="REVIEW"||r.status==="REPAIR_FAILED") ledger.push(...(r.patchLedger||[]));}
    const post=htmlStructureGate(output); const scriptsPost=[...output.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]; let inlineSyntax=true;
    for(const x of scriptsPost){const attrs=x[1]||""; if(/\bsrc\s*=\s*["'][^"']+["']/i.test(attrs)) continue; const sg=sourceSyntaxGate(x[2],{source:(file.path||"HTML")+"#script-inline"}); if(!sg.pass) inlineSyntax=false;}
    const verified=changed&&post.pass&&inlineSyntax&&output!==source;
    const status=verified?"REPAIRED_VERIFIED":(!changed?(pre.pass?"NO_PATCH":"REPAIR_FAILED"):"REPAIRED");
    const fpBefore=digest(source), fpAfter=digest(output);
    return {status,applied:changed,verified,sourceSyntax:post,htmlProof:{before:pre,after:post,inlineScripts:inline.length,externalScripts:scripts.filter(x=>x.src).length,styles:styles.length,inlineSyntax},fullRepairedCode:output,output:{type:changed?"FULL_REPAIRED_SOURCE":"FULL_SOURCE",available:true,code:output,charCount:output.length,lineCount:output.split(/\r?\n/).length},patchLedger:ledger,appliedRules:ledger.map(x=>x.rule),beforeFingerprint:fpBefore,afterFingerprint:fpAfter,reason:verified?"html_inline_js_repaired_and_reverified":pre.pass?"valid_html_no_patch":"html_not_safely_repairable"};
  }
  function repairTypedFile(file, options={}) {
    const f={path:String(file.path||file.name||"DEV INPUT"),content:String(file.content??""),mimeType:file.mimeType||file.type||""}; const d=detectFileType(f);
    if(d.language==="html") return {...repairHtml(f,options),language:"HTML",path:f.path};
    if(d.language==="css") return {...repairCss(f.content),language:"CSS",path:f.path};
    if(d.language==="json") { const r=repair(f.content,{...options,source:f.path}); return {...r,language:"JSON",path:f.path}; }
    if(d.language==="js") { const r=repair(f.content,{...options,source:f.path}); return {...r,language:"JavaScript",path:f.path}; }
    const source=f.content; return {status:"NO_PATCH",applied:false,verified:true,language:"TEXT",path:f.path,sourceSyntax:{status:"PASS",pass:true,scope:"TEXT"},fullRepairedCode:source,output:{type:"FULL_SOURCE",available:true,code:source,charCount:source.length,lineCount:source.split(/\r?\n/).length},patchLedger:[],appliedRules:[],reason:"text_passthrough"};
  }

  /* PROJECT CONTEXT LAYER — local, deterministic, no filesystem/network dependency. */
  function normalizeProjectInput(input) {
    if (input && typeof input === "object" && Array.isArray(input.files)) {
      return input.files.filter(f => f && typeof f.path === "string" && typeof f.content === "string")
        .map(f => ({ path: f.path.replace(/\\/g,"/"), content: f.content }));
    }
    if (typeof input !== "string") return null;
    const text = input;
    const marker = /(?:^|\n)\s*(?:\/\/|#|<!--)\s*(?:={2,}\s*)?FILE\s*:\s*([^\n>]+?)(?:\s*={2,})?\s*(?:-->)?\s*(?:\n|$)/gi;
    const matches=[]; let m;
    while((m=marker.exec(text))) matches.push({index:m.index, end:marker.lastIndex, path:m[1].trim()});
    if(matches.length<2) return null;
    const files=[];
    for(let i=0;i<matches.length;i++){
      const start=matches[i].end, end=i+1<matches.length?matches[i+1].index:text.length;
      const content=text.slice(start,end).replace(/^\s*\n/,'');
      if(matches[i].path && content.trim()) files.push({path:matches[i].path,content});
    }
    return files.length>=2?files:null;
  }
  function normalizePath(path){
    const parts=String(path||"").replace(/\\/g,"/").split("/"); const out=[];
    for(const x of parts){if(!x||x===".")continue;if(x==="..")out.pop();else out.push(x)}
    return out.join("/");
  }
  function resolveProjectTarget(from, spec, paths){
    const raw=String(spec||""); if(!raw || /^(https?:|data:|#|\/\/)/i.test(raw)) return {status:"EXTERNAL",target:raw};
    const clean=raw.split(/[?#]/,1)[0];
    let base=clean.startsWith("/")?normalizePath(clean):normalizePath((String(from).split("/").slice(0,-1).join("/"))+"/"+clean);
    const candidates=[base,base+".js",base+".mjs",base+".json",base+"/index.js",base+"/index.html"];
    const hit=candidates.find(x=>paths.has(x));
    return hit?{status:"MATCH",target:hit}:{status:"MISSING",target:base};
  }
  function extractProjectRelations(files){
    const paths=new Set(files.map(f=>normalizePath(f.path))); const relations=[]; const defsByFile=new Map(); const exportsByFile=new Map();
    const defs=/\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|\b(?:export\s+)?(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/g;
    const exportNamed=/\bexport\s*\{([\s\S]*?)\}/g;
    const importFrom=/(?:^|[;\n])\s*import\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
    const importSide=/(?:^|[;\n])\s*import\s*["']([^"']+)["']/g;
    const requireRef=/(?:^|[;\n])\s*(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/g;
    const scriptRef=/<script[^>]+src\s*=\s*["']([^"']+)["']/gi;
    const exportDefault=/\bexport\s+default\s+(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*))/g;
    // First pass: build the complete symbol/export graph before resolving imports.
    for(const f of files){
      const path=normalizePath(f.path), defsLocal=[]; let m;
      defs.lastIndex=0; while((m=defs.exec(f.content))) defsLocal.push(m[1]||m[2]);
      exportNamed.lastIndex=0; const exported=[];
      while((m=exportNamed.exec(f.content))){ for(const part of m[1].split(',')){ const bits=part.trim().split(/\s+as\s+/i); const n=bits[0]?.trim(); const a=bits[1]?.trim()||n; if(n) exported.push({name:n,as:a}); }}
      exportDefault.lastIndex=0; while((m=exportDefault.exec(f.content))){ const n=m[1]||m[2]||m[3]; if(n) exported.push({name:n,as:'default'}); else exported.push({name:'default',as:'default'}); }
      for(const d of defsLocal) if(/\bexport\s+(?:async\s+)?(?:function|const|let|var|class)\s+/.test(f.content.match(new RegExp('export\\s+(?:async\\s+)?(?:function|const|let|var|class)\\s+'+d+'\\b'))?.[0]||'')) exported.push({name:d,as:d});
      const uniqueDefs=[...new Set(defsLocal)], uniqueExports=[...new Map(exported.map(x=>[x.as,x])).values()];
      defsByFile.set(path,uniqueDefs); exportsByFile.set(path,uniqueExports);
      const counts=new Map(); for(const name of defsLocal) counts.set(name,(counts.get(name)||0)+1); for(const [name,count] of counts) if(count>1) relations.push({sourceFile:path,targetFile:path,status:"DUPLICATE_SYMBOL",symbol:name,count});
    }
    const hasExport=(target,name)=>{
      if(name==='default') return (exportsByFile.get(target)||[]).some(x=>x.as==='default');
      const defsLocal=defsByFile.get(target)||[], ex=exportsByFile.get(target)||[];
      return ex.some(x=>x.as===name||x.name===name) || (defsLocal.includes(name) && ex.length===0 && !/\bexport\b/.test(files.find(f=>normalizePath(f.path)===target)?.content||''));
    };
    for(const f of files){
      const path=normalizePath(f.path);
      const addRef=(spec,clause=null)=>{
        if(!spec)return; const r=resolveProjectTarget(path,spec,paths); relations.push({sourceFile:path,targetFile:r.target,status:r.status,spec});
        if(r.status!=="MATCH"||!clause)return;
        const names=[]; const named=(clause.match(/\{([\s\S]*?)\}/)||[])[1];
        if(named) for(const part of named.split(',')){ const bits=part.trim().split(/\s+as\s+/i); const n=bits[0]?.trim(); if(n) names.push(n); }
        const defaultName=(clause.match(/^\s*([A-Za-z_$][\w$]*)\s*(?:,|$)/)||[])[1]; if(defaultName) names.push('default');
        for(const name of names){
          if(hasExport(r.target,name)) relations.push({sourceFile:path,targetFile:r.target,status:"SYMBOL_REFERENCE",symbol:name,spec});
          else relations.push({sourceFile:path,targetFile:r.target,status:"MISSING_SYMBOL",symbol:name,spec});
        }
      };
      let im; importFrom.lastIndex=0; while((im=importFrom.exec(f.content))) addRef(im[2],im[1]);
      importSide.lastIndex=0; while((im=importSide.exec(f.content))) addRef(im[1]);
      requireRef.lastIndex=0; while((im=requireRef.exec(f.content))) addRef(im[2],im[1]);
      scriptRef.lastIndex=0; while((im=scriptRef.exec(f.content))) addRef(im[1]);
    }
    const summary={match:relations.filter(r=>r.status==="MATCH").length,missing:relations.filter(r=>r.status==="MISSING").length,external:relations.filter(r=>r.status==="EXTERNAL").length,duplicateSymbol:relations.filter(r=>r.status==="DUPLICATE_SYMBOL").length,missingSymbol:relations.filter(r=>r.status==="MISSING_SYMBOL").length,symbolReference:relations.filter(r=>r.status==="SYMBOL_REFERENCE").length,total:relations.length};
    return {relations,symbols:[...defsByFile.entries()].flatMap(([path,names])=>names.map(name=>({name,owners:[path],exports:(exportsByFile.get(path)||[]).filter(x=>x.name===name||x.as===name).map(x=>x.as)}))),summary,healthy:summary.missing===0&&summary.missingSymbol===0};
  }
  function deepProjectReasoning(input){
    const files=normalizeProjectInput(input); if(!files||!files.length) return {ok:false,status:"PROJECT_INPUT_REQUIRED",verified:false};
    const graph=extractProjectRelations(files); const syntax=[];
    for(const f of files){ const d=detectFileType(f); let pass=true,detail={language:d.language}; if(d.language==='js'||d.language==='json') { const g=sourceSyntaxGate(f.content,{source:f.path}); pass=g.pass; detail.syntax=g; } else if(d.language==='html'){ const g=htmlStructureGate(f.content); pass=g.pass; detail.syntax=g; } else if(d.language==='css'){ const g=cssSyntaxGate(f.content); pass=g.pass; detail.syntax=g; } syntax.push({path:f.path,pass,...detail}); }
    const broken=[...new Set(syntax.filter(x=>!x.pass).map(x=>x.path))];
    const missing=graph.relations.filter(x=>x.status==='MISSING'||x.status==='MISSING_SYMBOL');
    const external=graph.relations.filter(x=>x.status==='EXTERNAL');
    const affected=[...new Set([...broken,...missing.map(x=>x.sourceFile),...missing.map(x=>x.targetFile).filter(x=>pathsHas(files,x))])];
    return {ok:true,status:(broken.length||missing.length)?"CONTRACT_BROKEN":"CONTRACT_HEALTHY",verified:broken.length===0&&missing.length===0,graph,syntax,diagnosis:{brokenFiles:broken,missingRelations:missing,externalRelations:external,affectedFiles:affected,reasoning:"SYNTAX + DEPENDENCY + SYMBOL CONTRACT"}};
  }
  function pathsHas(files,path){ return files.some(f=>normalizePath(f.path)===normalizePath(path)); }

  function repairProject(input, options={}) {
    const files=normalizeProjectInput(input);
    if(!files || !files.length) return {ok:false,status:"ERROR",verified:false,reason:"PROJECT_INPUT_REQUIRED"};
    if(files.length>100) return {ok:false,status:"ERROR",verified:false,reason:"Maksimum 100 file per siklus."};
    const beforeGraph=extractProjectRelations(files), results=[];
    for(const f of files){
      const d=detectFileType(f); const r=repairTypedFile({...f,language:d.language},{...options,autoApply:true});
      const content=typeof r.fullRepairedCode==="string"?r.fullRepairedCode:f.content;
      results.push({path:f.path,language:d.language,status:r.status,applied:!!r.applied,verified:!!r.verified,rules:r.appliedRules||[],beforeHash:digest(f.content),afterHash:digest(content),changed:content!==f.content,content,patchLedger:r.patchLedger||[],result:r});
    }
    const patchedFiles=results.map(x=>({path:x.path,content:x.content})); const afterGraph=extractProjectRelations(patchedFiles);
    const allValid=results.every(x=>x.result?.sourceSyntax?.pass===true || (x.status==="NO_PATCH"&&x.result?.sourceSyntax?.pass===true));
    const changed=results.filter(x=>x.changed).length; const verifiedFiles=results.every(x=>x.verified||x.status==="NO_PATCH"); const relationSafe=afterGraph.healthy;
    const allIdempotent=results.every(x=>{if(!x.changed)return x.status==="NO_PATCH"; const again=repairTypedFile({path:x.path,content:x.content},{autoApply:true}); return again.status==="NO_PATCH"&&again.fullRepairedCode===x.content;});
    const beforeFp=digest(files.map(x=>({path:x.path,content:x.content}))), afterFp=digest(patchedFiles); const ledger=results.flatMap(x=>x.patchLedger);
    const verified=changed>0 ? (verifiedFiles&&allValid&&relationSafe&&allIdempotent&&beforeFp!==afterFp) : (allValid&&relationSafe&&allIdempotent&&beforeFp===afterFp);
    const status=changed>0 ? (verified?"REPAIRED_VERIFIED":"REPAIRED") : (verified?"NO_PATCH":"REPAIR_FAILED");
    return {ok:true,engine:"CGO_MACHINE_ABC",version:VERSION,status,verified,files:results.map(x=>({path:x.path,language:x.language,status:x.status,applied:x.applied,verified:x.verified,rules:x.rules,beforeHash:x.beforeHash,afterHash:x.afterHash,changed:x.changed,content:x.content,patchLedger:x.patchLedger})),relations:{before:beforeGraph,after:afterGraph},patchLedger:ledger,projectProof:{changedFiles:changed,verifiedFiles,syntaxOk:allValid,relationSafe,idempotent:allIdempotent,beforeFingerprint:beforeFp,afterFingerprint:afterFp},output:{type:"PROJECT_REPAIRED_BUNDLE",available:true,files:patchedFiles},reason:verified?(changed?"all_file_repairs_and_project_verification_complete":"all_files_valid_unchanged"):"project_verification_contract_failed"};
  }

  const REPAIR_RULE_REGISTRY = Object.freeze([
    "MISSING_CONCAT_LINES_PUSH", "MISSING_CONCAT_ASSIGNMENT", "MISSING_CONCAT_OBJECT_PROPERTY", "MISSING_PAREN_HEADER", "MISSING_PAREN_FUNCTION_DECL", "MISSING_OBJECT_COMMA",
    "TRAILING_PLUS", "EMPTY_RETURN_PLUS", "DOUBLE_SEMICOLON",
    "COMMA_BEFORE_BRACE", "EMPTY_RETURN_OP", "TRIPLE_EQ_TYPO",
    "MISSING_CATCH_BODY", "STRAGGLE_COMMA_NL", "PHYSICS_INPUT",
    "STRAY_PLUS_EOL", "DOUBLE_PLUS_SPACE",
    "MISSING_LIST_COMMA", "MISSING_CLOSER_INDENT", "STRAY_CLOSER_EOF",
    "JSON_TRAILING_COMMA", "JSON_MISSING_COMMA", "JSON_TRUNCATED_CLOSE"
  ]);
  const BLOCKED_AMBIGUOUS_RULES = Object.freeze({
    STRAY_PLUS_EOL: "Diblokir: bisa merupakan operator + yang sengaja diteruskan ke baris berikutnya.",
    DOUBLE_PLUS_SPACE: "Diblokir: bisa merupakan unary plus / increment yang valid."
  });
  const MANUAL_REVIEW_RULES = Object.freeze({
    TRAILING_PLUS: "Manual review: operator context is required.",
    EMPTY_RETURN_PLUS: "Manual review: return expression context is required.",
    DOUBLE_SEMICOLON: "Manual review: duplicate semicolons can be intentional.",
    COMMA_BEFORE_BRACE: "Manual review: trailing comma compatibility/context required.",
    EMPTY_RETURN_OP: "Manual review: return expression context is required.",
    TRIPLE_EQ_TYPO: "Manual review: operator intent is not proven by text alone.",
    MISSING_CATCH_BODY: "Manual review: catch recovery behavior must be explicit.",
    STRAGGLE_COMMA_NL: "Manual review: trailing comma may be intentional."
  });

  /** Safe in-memory repair: baseline process → heuristic patches → re-process → verify */
  function buildRepairPlan(input, baseline, planOpts) {
    const text = typeof input === "string" ? input : (input && (input.text || input.content || input.source) != null ? String(input.text || input.content || input.source) : JSON.stringify(input));
    const steps = [];
    let after = text;
    /* Multi-rule convergence: each deterministic repair is independently re-analysed.
       A combined source must not stop at the first successful rule. Hard cap prevents loops. */
    if (typeof after === "string") {
      const MAX_REPAIR_PASSES = 8;
      for (let pass = 0; pass < MAX_REPAIR_PASSES; pass++) {
        const beforePass = after;
        const applyStep = (result) => {
          if (!result || !result.changed) return;
          steps.push(...result.steps.map(x => ({ ...x, pass: pass + 1, beforeLen: after.length, afterLen: result.text.length })));
          after = result.text;
        };
        applyStep(repairDeterministicMissingHeaderParen(after));
        applyStep(repairDeterministicObjectPropertyPlus(after));
        applyStep(repairDeterministicMultilinePlus(after));
        applyStep(repairDeterministicLinesPushConcat(after));
        applyStep(repairDeterministicMissingObjectComma(after));
        const tokenPlan = jsonModeOf(after) ? planJsonRepairs(after) : planJsTokenRepairs(after, planOpts);
        applyStep(tokenPlan);
        if (after === beforePass) break;
      }
    }
    // Legacy heuristic rules are audit-only in deterministic mode. They are
    // intentionally NOT allowed to mutate source automatically because their
    // intent cannot be proven from text alone. This prevents a valid source
    // from being rewritten merely because a regex happens to match.
    for (const [id, reason] of Object.entries(MANUAL_REVIEW_RULES)) {
      if (REPAIR_RULE_REGISTRY.includes(id)) steps.push({ id, status: "MANUAL", reason });
    }
    const findings = (baseline && baseline.result && baseline.result.findings) || [];
    for (const f of findings) {
      if (f && f.type === "PHYSICS_INPUT_INCOMPLETE") {
        steps.push({ id: "PHYSICS_INPUT", status: "MANUAL", reason: "lengkapi elevationDeg & distanceKm" });
      }
    }
    const appliedIds = new Set(steps.filter(s => s.status === "CANDIDATE").map(s => s.id));
    const manualIds = new Set(steps.filter(s => s.status === "MANUAL").map(s => s.id));
    const ruleAudit = REPAIR_RULE_REGISTRY.map(id => ({
      id,
      status: BLOCKED_AMBIGUOUS_RULES[id] ? "BLOCKED" : (manualIds.has(id) || MANUAL_REVIEW_RULES[id] ? "MANUAL" : (appliedIds.has(id) ? "APPLIED" : "NOT_TRIGGERED")),
      reason: BLOCKED_AMBIGUOUS_RULES[id] || MANUAL_REVIEW_RULES[id] || (appliedIds.has(id) ? "Rule menghasilkan candidate patch." : "Tidak terpenuhi oleh source." )
    }));
    const auditLedger = [
      ...ruleAudit,
      ...steps.map(s => ({ id: s.id, class: s.status === "MANUAL" ? "MANUAL" : "REPAIR_CANDIDATE", status: s.status, reason: s.reason, pass: s.pass ?? null })),
      { id: "UNAPPLIED_RULES", class: "TRANSPARENCY", status: "NOT_APPLIED", reason: "Rule yang tidak cocok tidak dieksekusi." },
      { id: "AMBIGUOUS_LOGIC", class: "SAFETY", status: "BLOCKED", reason: "Tidak ada tebakan nilai/niat pengguna." }
    ];
    return {
      count: steps.length,
      automaticCandidates: steps.filter(s => s.status === "CANDIDATE"),
      manualCandidates: steps.filter(s => s.status === "MANUAL"),
      steps,
      auditLedger,
      ruleAudit,
      afterText: after,
      changed: after !== text,
      convergence: { passes: new Set(steps.map(s => s.pass).filter(Boolean)).size, maxPasses: 8, converged: true }
    };
  }

  function repair(input, options = {}) {
    if (paused) {
      return { engine: "CGO_MACHINE_ABC", version: VERSION, status: "PAUSED", applied: false, verified: false, reason: "engine_paused" };
    }
    const text = typeof input === "string" ? input : (input && (input.text || input.content || input.source) != null ? String(input.text || input.content || input.source) : null);
    const baseline = CGOMachineABC.process(input, { maxCycles: 1, fast: false, skipAudit: false, source: options.source || "REPAIR_BASELINE" });
    const gateOpts = { source: options.source || "" };
    const preSourceSyntax = text != null ? sourceSyntaxGate(text, gateOpts) : null;
    // Zero-ambiguity rule: a source that already passes the deterministic gate is
    // never normalized/re-written just because a legacy rule happens to match it.
    // Repair is entered only when a deterministic gate reports a concrete failure.
    let plan;
    let repairCycles = 0;
    if (preSourceSyntax && preSourceSyntax.pass) {
      plan={count:0,automaticCandidates:[],manualCandidates:[],steps:[],auditLedger:[{id:"PRE_SOURCE_SYNTAX",class:"GATE",status:"PASS",reason:"Source sudah lolos; tidak ada patch yang diizinkan."},...REPAIR_RULE_REGISTRY.map(id=>({id,class:BLOCKED_AMBIGUOUS_RULES[id]?"SAFETY":"REPAIR_RULE",status:BLOCKED_AMBIGUOUS_RULES[id]?"BLOCKED":"NOT_APPLIED",reason:BLOCKED_AMBIGUOUS_RULES[id]||"Source sudah lolos gate."})),{id:"AMBIGUOUS_LOGIC",class:"SAFETY",status:"BLOCKED",reason:"Tidak menulis ulang source yang sudah valid."}],ruleAudit:REPAIR_RULE_REGISTRY.map(id=>({id,status:BLOCKED_AMBIGUOUS_RULES[id]?"BLOCKED":"NOT_APPLIED",reason:BLOCKED_AMBIGUOUS_RULES[id]||"Source sudah lolos gate."})),afterText:text,changed:false,convergence:{passes:0,maxPasses:5,converged:true}};
    } else {
      let current=text; const MAX_REPAIR_CYCLES=5;
      for(let cycle=1;cycle<=MAX_REPAIR_CYCLES;cycle++){
        repairCycles=cycle; const cp=buildRepairPlan(current,baseline,gateOpts); cp.steps=(cp.steps||[]).map(x=>({...x,cycle}));
        const gate=sourceSyntaxGate(cp.afterText,gateOpts); cp.retryCycle=cycle; cp.postGate=gate; plan=cp;
        if(!cp.changed || gate.pass) break;
        current=cp.afterText;
      }
      plan.retryCycles=repairCycles;
    }
    const autoApply = options.autoApply !== false;
    let applied = false;
    let candidate = null;
    let repaired = null;
    let comparison = null;
    if (autoApply && plan.changed && text != null) {
      candidate = {
        id: "PATCH-" + digest(plan.afterText).slice(0, 12),
        patch: { before: text, after: plan.afterText },
        steps: plan.steps.filter(s => s.status === "CANDIDATE")
      };
      repaired = CGOMachineABC.process(plan.afterText, { maxCycles: options.maxCycles ?? 1, fast: false, skipAudit: false, source: options.source || "REPAIR_POST" });
      applied = true;
      const bf = baseline.result && baseline.result.summary ? baseline.result.summary.findings : (baseline.result && baseline.result.findings ? baseline.result.findings.length : 0);
      const af = repaired.result && repaired.result.summary ? repaired.result.summary.findings : (repaired.result && repaired.result.findings ? repaired.result.findings.length : 0);
      comparison = {
        before: { fingerprint: digest(text), findings: bf, status: baseline.result && baseline.result.status },
        after: { fingerprint: digest(plan.afterText), findings: af, status: repaired.result && repaired.result.status },
        findingDelta: (typeof af === "number" && typeof bf === "number") ? (af - bf) : null
      };
    } else if (!plan.changed) {
      const sourceGate = text != null ? sourceSyntaxGate(text, gateOpts) : { status: "UNKNOWN", pass: false, scope: "DETERMINISTIC_STRUCTURAL", failed: ["NO_TEXT_SOURCE"] };
      const review = sourceGate.pass === false && sourceGate.status === "FAIL";
      return {
        engine: "CGO_MACHINE_ABC", version: VERSION, status: review ? "REVIEW" : "NO_PATCH", applied: false, verified: false,
        baseline, plan, finalPlan: plan, candidate: null, repaired: null, comparison: null,
        reason: review ? "source_syntax_invalid_and_no_safe_patch" : "no_safe_automatic_patch",
        sourceSyntax: sourceGate,
        diagnostics: (review && text != null) ? describeSourceProblems(text, gateOpts) : [],
        verification: { postRepairAudit: baseline.audit && baseline.audit.status, postRepairRoute: "A-B-C-D", sourceSyntax: sourceGate },
        verificationScope: "INTERNAL_PROCESS_AND_DETERMINISTIC_SOURCE_GATE",
        persistence: "FULL_SOURCE_RETURNED_TO_CALLER", runtimeExecution: "NOT_PERFORMED",
        fullRepairedCode: text != null ? String(text) : null,
        output: {type: review ? "FULL_INPUT_SOURCE" : "FULL_SOURCE",available:text!=null,code:text!=null?String(text):null,lineCount:text!=null?String(text).split(/\r?\n/).length:0,charCount:text!=null?String(text).length:0},
        beforeFingerprint: text != null ? digest(text) : null, afterFingerprint: text != null ? digest(text) : null,
        patchLedger: [], appliedRules: [],
        steps: []
      };
    }
    const postStatus = repaired && repaired.result && repaired.result.status;
    const postAudit = repaired && repaired.audit && repaired.audit.status;
    const sourceGate = applied ? sourceSyntaxGate(plan.afterText, gateOpts) : sourceSyntaxGate(text, gateOpts);
    const beforeGate = preSourceSyntax || sourceSyntaxGate(text, gateOpts);
    const beforeFingerprint = text != null ? digest(text) : null;
    const afterFingerprint = applied ? digest(plan.afterText) : beforeFingerprint;
    const sourceChanged = applied && beforeFingerprint !== afterFingerprint && plan.afterText !== text;
    const candidateCount = (plan.steps || []).filter(s => s.status === "CANDIDATE").length;
    const routeComplete = !!(repaired && Array.isArray(repaired.pipelineTrace) && repaired.pipelineTrace.length >= 4 &&
      repaired.pipelineTrace[0]?.machine === "A" && repaired.pipelineTrace[1]?.machine === "B" &&
      repaired.pipelineTrace[2]?.machine === "C" && repaired.pipelineTrace[3]?.machine === "D" &&
      repaired.pipelineTrace.every(x => x && x.status === "COMPLETED"));
    const dVerified = postAudit === "VALID";
    const repairProof = {
      sourceBeforeFailed: beforeGate.pass === false,
      sourceAfterPassed: sourceGate.pass === true,
      sourceChanged,
      candidateCount,
      routeComplete,
      dVerified,
      statusAcceptable: !!postStatus && !/ERROR|FAIL|DEGRADED/i.test(String(postStatus))
    };
    const verified = !!(applied && repairProof.sourceBeforeFailed && repairProof.sourceAfterPassed &&
      repairProof.sourceChanged && repairProof.candidateCount > 0 && repairProof.routeComplete &&
      repairProof.dVerified && repairProof.statusAcceptable);
    return {
      engine: "CGO_MACHINE_ABC",
      version: VERSION,
      status: applied ? (verified ? "REPAIRED_VERIFIED" : "REPAIRED") : "REVIEW",
      applied,
      verified,
      baseline,
      plan,
      auditLedger: plan.auditLedger || [],
      ruleAudit: plan.ruleAudit || [],
      finalPlan: plan,
      candidate,
      repaired,
      postRepair: repaired,
      comparison,
      steps: (plan.steps || []).map((s, i) => ({ index: i, id: s.id, status: s.status === "CANDIDATE" && applied ? "APPLIED" : s.status, audit: postAudit || null })),
      verification: {
        postRepairAudit: postAudit || null,
        postRepairRoute: "A-B-C-D",
        postStatus: postStatus || null,
        sourceSyntax: sourceGate,
        repairProof
      },
      sourceSyntax: sourceGate,
      repairProof,
      retryCycles: repairCycles,
      patchLedger: (plan.steps || []).filter(s=>s.status==="CANDIDATE").map((s,i,a)=>({id:"PATCH-"+String(i+1).padStart(3,"0"),file:options.source||"REPAIR_INPUT",language:"JavaScript",region:"DETERMINISTIC_SOURCE",rule:s.id,rootCause:s.reason||"deterministic finding",before:i===0?text:null,after:i===a.length-1?String(plan.afterText):null,reason:s.reason||"candidate generated",cycle:s.cycle||repairCycles||1,status:applied?"APPLIED":"CANDIDATE"})),
      appliedRules: (plan.steps || []).filter(s => s.status === "CANDIDATE").map(s => s.id),
      fullRepairedCode: applied ? String(plan.afterText) : null,
      output: {
        type: applied ? "FULL_REPAIRED_SOURCE" : "NO_REPAIRED_SOURCE",
        available: applied === true,
        code: applied ? String(plan.afterText) : null,
        lineCount: applied ? String(plan.afterText).split(/\r?\n/).length : 0,
        charCount: applied ? String(plan.afterText).length : 0
      },
      verificationScope: "INTERNAL_PROCESS_AND_DETERMINISTIC_SOURCE_GATE",
      runtimeExecution: applied ? "DETERMINISTIC_POST_REPAIR_VERIFICATION" : "NOT_APPLICABLE",
      persistence: "FULL_SOURCE_RETURNED_TO_CALLER",
      reason: applied ? (verified ? "deterministic_safe_patch_verified" : "patch_applied_but_verification_contract_failed") : "awaiting_safe_patch"
    };
  }

  /*
   * PHASE 4 — ADVANCED AUTO-REPAIR
   * Candidate synthesis -> isolated verification -> rollback on failure.
   * The engine never mutates a source that already passes the deterministic gate.
   * Runtime observation is optional and must come from the local sandbox/host adapter.
   */
  const ADVANCED_REPAIR_VERSION = "CGO_ABC_ADVANCED_REPAIR_V1";
  async function advancedRepair(input, options={}) {
    const text = typeof input === "string" ? input : (input && (input.text || input.content || input.source) != null ? String(input.text || input.content || input.source) : null);
    if (text == null) return {engine:"CGO_MACHINE_ABC",version:VERSION,status:"REVIEW",verified:false,reason:"ADVANCED_REPAIR_SOURCE_REQUIRED",versionAdvanced:ADVANCED_REPAIR_VERSION};
    const maxCycles=Math.max(1,Math.min(8,toInt(options.maxCycles,5)));
    const attempts=[]; let current=text; let final=null;
    for(let cycle=1;cycle<=maxCycles;cycle++){
      const gate=sourceSyntaxGate(current,{source:options.source||"ADVANCED_REPAIR.js"});
      if(gate.pass){
        final={engine:"CGO_MACHINE_ABC",version:VERSION,status:cycle===1?"NO_PATCH":"REPAIRED_VERIFIED",verified:true,applied:cycle>1,sourceSyntax:gate,fullRepairedCode:current,attempts,advancedRepair:true,advancedRepairVersion:ADVANCED_REPAIR_VERSION,repairCycles:cycle-1,reason:cycle===1?"already_valid_no_mutation":"converged_after_verified_patch"};
        break;
      }
      const r=repair(current,{...options,autoApply:true,source:options.source||"ADVANCED_REPAIR.js"});
      attempts.push({cycle,status:r.status,verified:r.verified,changed:r.applied===true,sourceBefore:current,sourceAfter:r.fullRepairedCode||current,patchLedger:r.patchLedger||[]});
      if(!r.applied || !r.fullRepairedCode || r.fullRepairedCode===current){
        final={...r,advancedRepair:true,advancedRepairVersion:ADVANCED_REPAIR_VERSION,repairCycles:cycle,attempts};
        break;
      }
      const candidate=r.fullRepairedCode;
      const candidateGate=sourceSyntaxGate(candidate,{source:options.source||"ADVANCED_REPAIR.js"});
      if(!candidateGate.pass){
        final={...r,status:"REPAIR_FAILED",verified:false,advancedRepair:true,advancedRepairVersion:ADVANCED_REPAIR_VERSION,repairCycles:cycle,attempts,reason:"candidate_failed_source_gate"};
        break;
      }
      let runtime=null;
      if(typeof options.runtimeCheck === "function"){
        try { runtime=await options.runtimeCheck(candidate,cycle); } catch(e){ runtime={verified:false,status:"RUNTIME_CHECK_ERROR",error:String(e&&e.message||e)}; }
        attempts[attempts.length-1].runtime=runtime;
        if(runtime && runtime.verified===false && options.rejectRuntimeFailure!==false){
          final={...r,status:"REPAIR_FAILED",verified:false,advancedRepair:true,advancedRepairVersion:ADVANCED_REPAIR_VERSION,repairCycles:cycle,attempts,reason:"runtime_observation_rejected_candidate",runtime};
          break;
        }
      }
      current=candidate;
      final=r;
    }
    if(!final) final={engine:"CGO_MACHINE_ABC",version:VERSION,status:"REPAIR_FAILED",verified:false,advancedRepair:true,advancedRepairVersion:ADVANCED_REPAIR_VERSION,repairCycles:maxCycles,attempts,fullRepairedCode:current,reason:"advanced_repair_cycle_limit"};
    const idempotent=(()=>{try{const again=repairTypedFile({path:options.source||"ADVANCED_REPAIR.js",content:current},{autoApply:true});return again.status==="NO_PATCH"&&again.fullRepairedCode===current}catch(_){return false}})();
    final.idempotent=idempotent;
    if(final.verified && !idempotent){final.status="REPAIR_FAILED";final.verified=false;final.reason="advanced_repair_idempotency_failed";}
    final.fullRepairedCode=current;
    final.output={type:current===text?"FULL_SOURCE":"FULL_REPAIRED_SOURCE",available:true,code:current,lineCount:current.split(/\r?\n/).length,charCount:current.length};
    final.beforeFingerprint=digest(text); final.afterFingerprint=digest(current); final.sourceChanged=text!==current;
    final.patchLedger=attempts.flatMap(a=>a.patchLedger||[]);
    return final;
  }

  /*
   * PHASE 1 — AUTO CODE CREATION
   * Deterministic local creator. It accepts a structured blueprint so the
   * future BCGO chat layer can translate natural-language intent into a safe
   * creation contract without putting an external model inside ABC.
   */
  const CREATE_VERSION = "CGO_ABC_CREATE_V1";
  const SAFE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
  function normalizeCreateSpec(spec={}) {
    if(!spec || typeof spec !== "object" || Array.isArray(spec)) return {ok:false,status:"INVALID_CREATE_SPEC",reason:"CREATE_SPEC_OBJECT_REQUIRED",version:CREATE_VERSION};
    const language=String(spec.language||"javascript").trim().toLowerCase();
    if(language!=="javascript" && language!=="js") return {ok:false,status:"UNSUPPORTED_CREATE_LANGUAGE",reason:"PHASE1_CREATOR_SUPPORTS_JAVASCRIPT_ONLY",version:CREATE_VERSION,language};
    const moduleName=String(spec.moduleName||spec.name||"cgo_generated_module").trim();
    if(!SAFE_IDENTIFIER.test(moduleName)) return {ok:false,status:"INVALID_CREATE_NAME",reason:"MODULE_NAME_INVALID",version:CREATE_VERSION,moduleName};
    const rawFns=Array.isArray(spec.functions)?spec.functions:[];
    if(!rawFns.length) return {ok:false,status:"CREATE_FUNCTIONS_REQUIRED",reason:"AT_LEAST_ONE_FUNCTION_REQUIRED",version:CREATE_VERSION};
    const functions=[];
    for(const f of rawFns){
      if(!f || typeof f!=="object" || !SAFE_IDENTIFIER.test(String(f.name||""))) return {ok:false,status:"INVALID_CREATE_FUNCTION",reason:"FUNCTION_NAME_INVALID",version:CREATE_VERSION};
      const params=Array.isArray(f.params)?f.params.map(String):[];
      if(params.some(x=>!SAFE_IDENTIFIER.test(x))) return {ok:false,status:"INVALID_CREATE_PARAMETER",reason:"PARAMETER_NAME_INVALID",version:CREATE_VERSION,function:String(f.name)};
      const body=f.body==null?"return null;":String(f.body);
      const exported=f.export===true || f.exported===true;
      functions.push({name:String(f.name),params,body,exported});
    }
    return {ok:true,status:"CREATE_SPEC_ACCEPTED",version:CREATE_VERSION,moduleName,language:"javascript",functions,metadata:safeClone(spec.metadata||{})};
  }
  function createJavaScriptFromSpec(spec={}) {
    const n=normalizeCreateSpec(spec);
    if(!n.ok) return n;
    const lines=[];
    lines.push(`// Generated by CGO_MACHINE_ABC ${CREATE_VERSION}`);
    lines.push(`// Module: ${n.moduleName}`);
    lines.push("");
    for(const f of n.functions){
      lines.push(`function ${f.name}(${f.params.join(", ")}) {`);
      const bodyLines=f.body.split(/\r?\n/);
      if(bodyLines.length) for(const line of bodyLines) lines.push(`  ${line}`);
      lines.push("}");
      lines.push("");
    }
    const exports=n.functions.filter(f=>f.exported).map(f=>f.name);
    if(exports.length){
      lines.push(`if (typeof module !== "undefined" && module.exports) module.exports = { ${exports.join(", ")} };`);
      lines.push(`if (typeof globalThis !== "undefined") globalThis.${n.moduleName} = { ${exports.join(", ")} };`);
    }
    return {ok:true,status:"CODE_CREATED",version:CREATE_VERSION,spec:n,code:lines.join("\n")};
  }
  function createCode(spec={},options={}) {
    if(paused) return {engine:"CGO_MACHINE_ABC",version:VERSION,status:"PAUSED",created:false,verified:false};
    const generated=createJavaScriptFromSpec(spec);
    if(!generated.ok) return {engine:"CGO_MACHINE_ABC",version:VERSION,status:generated.status,created:false,verified:false,create:generated};
    const code=generated.code;
    const syntax=sourceSyntaxGate(code,{source:options.source||spec.path||"GENERATED.js"});
    const pipeline=CGOMachineABC.process(code,{source:options.source||spec.path||"GENERATED.js",fast:false,skipAudit:false});
    const route=Array.isArray(pipeline.pipelineTrace)&&pipeline.pipelineTrace.length>=4&&pipeline.pipelineTrace.slice(0,4).every((x,i)=>x.machine===["A","B","C","D"][i]&&x.status==="COMPLETED");
    const verified=syntax.pass===true && route===true && pipeline.audit?.status==="VALID";
    return {engine:"CGO_MACHINE_ABC",version:VERSION,status:verified?"CREATED_VERIFIED":"CREATE_REVIEW",created:true,verified,create:generated,spec:generated.spec,sourceSyntax:syntax,pipeline:pipeline.result,postRepair:pipeline,audit:pipeline.audit,fullRepairedCode:code,output:{type:"FULL_CREATED_SOURCE",available:true,code,lineCount:code.split(/\r?\n/).length,charCount:code.length},beforeFingerprint:null,afterFingerprint:digest(code),runtimeExecution:"NOT_PERFORMED",verificationScope:"CREATED_SOURCE_A_B_C_D_DETERMINISTIC_VERIFICATION",reason:verified?"created_source_verified":"created_source_requires_review"};
  }

  /*
   * Phase 2 — LOCAL RUNTIME SANDBOX V1
   * Browser-local Web Worker execution only. No eval/new Function/imports/network.
   * This is execution isolation, not a security boundary against hostile browser extensions.
   */
  const RUNTIME_SANDBOX_VERSION = "CGO_ABC_RUNTIME_SANDBOX_V1";
  function normalizeRuntimeSpec(spec={}) {
    if(!spec || typeof spec!=="object" || Array.isArray(spec)) return {ok:false,status:"INVALID_RUNTIME_SPEC",reason:"RUNTIME_SPEC_OBJECT_REQUIRED"};
    const source=String(spec.source??spec.code??"");
    if(!source.trim()) return {ok:false,status:"INVALID_RUNTIME_SOURCE",reason:"RUNTIME_SOURCE_REQUIRED"};
    const entry=String(spec.entry||"").trim();
    if(entry && !SAFE_IDENTIFIER.test(entry)) return {ok:false,status:"INVALID_RUNTIME_ENTRY",reason:"ENTRY_IDENTIFIER_INVALID"};
    if(/(^|\\n)\\s*(?:import|export)\\b/.test(source)) return {ok:false,status:"RUNTIME_MODULE_UNSUPPORTED",reason:"CLASSIC_WORKER_MODE_DOES_NOT_ACCEPT_IMPORT_EXPORT"};
    const timeoutMs=Math.max(25,Math.min(toInt(spec.timeoutMs,1500),10000));
    const args=Array.isArray(spec.args)?clone(spec.args):[];
    return {ok:true,status:"RUNTIME_SPEC_ACCEPTED",source,entry,args,timeoutMs,metadata:safeClone(spec.metadata||{})};
  }
  function runLocalRuntimeSandbox(spec={},options={}) {
    const n=normalizeRuntimeSpec(spec);
    if(!n.ok) return Promise.resolve({...n,version:RUNTIME_SANDBOX_VERSION,verified:false,runtimeExecution:"REJECTED"});
    if(typeof Worker!=="function" || typeof Blob!=="function" || typeof URL!=="object" || typeof URL.createObjectURL!=="function")
      return Promise.resolve({engine:"CGO_MACHINE_ABC",version:VERSION,runtimeSandboxVersion:RUNTIME_SANDBOX_VERSION,status:"RUNTIME_UNAVAILABLE",verified:false,runtimeExecution:"NOT_AVAILABLE",reason:"LOCAL_WORKER_RUNTIME_UNAVAILABLE"});
    const token=digest({source:n.source,entry:n.entry,args:n.args,at:now()}).slice(0,16);
    const workerSource=`\n"use strict";\nself.fetch=undefined; self.XMLHttpRequest=undefined; self.WebSocket=undefined; self.importScripts=undefined; self.indexedDB=undefined; self.caches=undefined;\n${n.source}\nself.onmessage=function(ev){\n  const p=ev.data||{};\n  try{\n    const entry=${n.entry?`globalThis[${JSON.stringify(n.entry)}]`:"null"};\n    if(!entry && ${JSON.stringify(!!n.entry)}) throw new Error("RUNTIME_ENTRY_NOT_FOUND");\n    const value=entry ? entry(...(Array.isArray(p.args)?p.args:[])) : true;\n    if(value && typeof value.then==="function"){ value.then(v=>self.postMessage({ok:true,value:v})).catch(e=>self.postMessage({ok:false,error:String(e&&e.message||e),name:String(e&&e.name||"Error")})); }\n    else self.postMessage({ok:true,value});\n  }catch(e){ self.postMessage({ok:false,error:String(e&&e.message||e),name:String(e&&e.name||"Error")}); }\n};`;
    let blob,url,worker,timer,settled=false;
    const finish=(result)=>{if(settled)return;settled=true;try{clearTimeout(timer)}catch(_){}try{worker?.terminate()}catch(_){}try{URL.revokeObjectURL(url)}catch(_){}options.onComplete?.(result);return result};
    try{
      blob=new Blob([workerSource],{type:"text/javascript"}); url=URL.createObjectURL(blob); worker=new Worker(url);
      return new Promise(resolve=>{
        timer=setTimeout(()=>resolve(finish({engine:"CGO_MACHINE_ABC",version:VERSION,runtimeSandboxVersion:RUNTIME_SANDBOX_VERSION,status:"RUNTIME_TIMEOUT",verified:false,runtimeExecution:"SANDBOX_TIMEOUT",token,timeoutMs:n.timeoutMs})),n.timeoutMs);
        worker.onmessage=e=>{const d=e.data||{};resolve(finish({engine:"CGO_MACHINE_ABC",version:VERSION,runtimeSandboxVersion:RUNTIME_SANDBOX_VERSION,status:d.ok?"RUNTIME_VERIFIED":"RUNTIME_FAILED",verified:d.ok===true,runtimeExecution:"LOCAL_WORKER",token,timeoutMs:n.timeoutMs,entry:n.entry||null,args:n.args,result:d.ok?d.value:undefined,error:d.ok?null:{name:d.name||"Error",message:d.error||"RUNTIME_ERROR"}}))};
        worker.onerror=e=>resolve(finish({engine:"CGO_MACHINE_ABC",version:VERSION,runtimeSandboxVersion:RUNTIME_SANDBOX_VERSION,status:"RUNTIME_FAILED",verified:false,runtimeExecution:"LOCAL_WORKER",token,timeoutMs:n.timeoutMs,entry:n.entry||null,error:{name:"WorkerError",message:String(e.message||"WORKER_ERROR")}}));
        worker.postMessage({args:n.args});
      });
    }catch(e){return Promise.resolve(finish({engine:"CGO_MACHINE_ABC",version:VERSION,runtimeSandboxVersion:RUNTIME_SANDBOX_VERSION,status:"RUNTIME_FAILED",verified:false,runtimeExecution:"LOCAL_WORKER",token,error:{name:String(e.name||"Error"),message:String(e.message||e)}}));}
  }
  function verifyRuntime(source,options={}) {
    return runLocalRuntimeSandbox({source,entry:options.entry,args:options.args,timeoutMs:options.timeoutMs,metadata:options.metadata});
  }
  async function repairWithRuntime(source,options={}) {
    const repaired=repair(source,{source:options.source||"RUNTIME_REPAIR.js",autoApply:true});
    if(!repaired || !repaired.fullRepairedCode) return {...repaired,runtimeExecution:"NOT_ATTEMPTED"};
    const rt=await runLocalRuntimeSandbox({source:repaired.fullRepairedCode,entry:options.entry,args:options.args,timeoutMs:options.timeoutMs});
    const verified=repaired.verified===true && rt.verified===true;
    return {...repaired,verified,status:verified?"REPAIRED_RUNTIME_VERIFIED":repaired.status,runtime:rt,runtimeExecution:rt.runtimeExecution,verificationScope:`${repaired.verificationScope||"A_B_C_D"}+LOCAL_RUNTIME_SANDBOX`};
  }
  async function createCodeWithRuntime(spec={},options={}) {
    const created=createCode(spec,options);
    if(!created.created || !created.verified) return {...created,runtimeExecution:"NOT_ATTEMPTED",verificationScope:`${created.verificationScope||"CREATED_SOURCE_A_B_C_D_DETERMINISTIC_VERIFICATION"}+RUNTIME`};
    const rt=await runLocalRuntimeSandbox({source:created.fullRepairedCode,entry:options.entry,args:options.args,timeoutMs:options.timeoutMs});
    const verified=created.verified && rt.verified===true;
    return {...created,verified,status:verified?"CREATED_RUNTIME_VERIFIED":created.status,runtime:rt,runtimeExecution:rt.runtimeExecution,verificationScope:`${created.verificationScope}+LOCAL_RUNTIME_SANDBOX`};
  }

  /*
   * Internal Command Contract — bridge-ready, deterministic, no external brain.
   * BCGO may inject a structured command later without coupling the chat layer
   * to the internal A>B>C>D implementation details.
   */
  const COMMAND_VERSION = "CGO_ABC_COMMAND_V1";
  const COMMAND_OPERATIONS = Object.freeze(["analyze","repair","create","project_repair","project_reason","runtime_verify"]);
  function normalizeCommand(command={}) {
    if(!command || typeof command !== "object" || Array.isArray(command))
      return {ok:false,status:"INVALID_COMMAND",reason:"COMMAND_OBJECT_REQUIRED",version:COMMAND_VERSION};
    const operation=String(command.operation||command.intent||"").trim().toLowerCase();
    if(!COMMAND_OPERATIONS.includes(operation))
      return {ok:false,status:"UNSUPPORTED_COMMAND",reason:"operation tidak didukung",version:COMMAND_VERSION,operation:operation||null};
    const payload=command.payload!==undefined?command.payload:(command.input!==undefined?command.input:command.source);
    if(payload===undefined||payload===null)
      return {ok:false,status:"INVALID_COMMAND",reason:"COMMAND_PAYLOAD_REQUIRED",version:COMMAND_VERSION,operation};
    const source=command.source!==undefined?String(command.source):"BCGO_COMMAND";
    const requestId=command.requestId!==undefined?String(command.requestId):"CMD-"+digest({operation,payload}).slice(0,12);
    return {ok:true,status:"COMMAND_ACCEPTED",version:COMMAND_VERSION,requestId,operation,source,payload,metadata:safeClone(command.metadata||{})};
  }
  function executeCommand(command={}) {
    const c=normalizeCommand(command);
    if(!c.ok) return c;
    if(c.operation==="analyze") return {ok:true,status:"COMMAND_COMPLETED",command:c,result:CGOMachineABC.process(c.payload,{source:c.source,fast:false,skipAudit:false})};
    if(c.operation==="repair") return {ok:true,status:"COMMAND_COMPLETED",command:c,result:CGOMachineABC.repair(c.payload,{source:c.source,autoApply:true})};
    if(c.operation==="create") return {ok:true,status:"COMMAND_COMPLETED",command:c,result:CGOMachineABC.createCode(c.payload,{source:c.source})};
    if(c.operation==="runtime_verify") return {ok:true,status:"COMMAND_ACCEPTED",command:c,result:CGOMachineABC.verifyRuntime(c.payload?.source??c.payload?.code??c.payload,{entry:c.payload?.entry,args:c.payload?.args,timeoutMs:c.payload?.timeoutMs})};
    if(c.operation==="project_reason") return {ok:true,status:"COMMAND_COMPLETED",command:c,result:CGOMachineABC.deepProjectReasoning(c.payload)};
    const result=CGOMachineABC.repairProject(c.payload,{source:c.source,autoApply:true});
    return {ok:true,status:"COMMAND_COMPLETED",command:c,result};
  }
  function createCommandEnvelope(operation,payload,options={}) {
    return normalizeCommand({operation,payload,source:options.source||"BCGO_COMMAND",requestId:options.requestId,metadata:options.metadata});
  }
  async function executeCommandAsync(command={}) {
    const c=normalizeCommand(command);
    if(!c.ok) return c;
    if(c.operation!=="runtime_verify") return executeCommand(c);
    const result=await CGOMachineABC.verifyRuntime(c.payload?.source??c.payload?.code??c.payload,{entry:c.payload?.entry,args:c.payload?.args,timeoutMs:c.payload?.timeoutMs});
    return {ok:true,status:"COMMAND_COMPLETED",command:c,result};
  }

  // Attach repair API before freeze
  CGOMachineABC.repair = repair;
  CGOMachineABC.repairProject = repairProject;
  CGOMachineABC.analyzeProjectRelations = (input) => { const f=normalizeProjectInput(input); return f ? extractProjectRelations(f) : {status:"PROJECT_INPUT_REQUIRED"}; };
  CGOMachineABC.deepProjectReasoning = deepProjectReasoning;
  CGOMachineABC.buildRepairPlan = buildRepairPlan;
  CGOMachineABC.advancedRepair = advancedRepair;
  CGOMachineABC.advancedRepairVersion = ADVANCED_REPAIR_VERSION;
  CGOMachineABC.createCode = createCode;
  CGOMachineABC.createVersion = CREATE_VERSION;
  CGOMachineABC.normalizeCreateSpec = normalizeCreateSpec;
  CGOMachineABC.createJavaScriptFromSpec = createJavaScriptFromSpec;
  CGOMachineABC.runtimeSandboxVersion = RUNTIME_SANDBOX_VERSION;
  CGOMachineABC.normalizeRuntimeSpec = normalizeRuntimeSpec;
  CGOMachineABC.runLocalRuntimeSandbox = runLocalRuntimeSandbox;
  CGOMachineABC.verifyRuntime = verifyRuntime;
  CGOMachineABC.repairWithRuntime = repairWithRuntime;
  CGOMachineABC.createCodeWithRuntime = createCodeWithRuntime;
  CGOMachineABC.sourceSyntaxGate = sourceSyntaxGate;
  CGOMachineABC.commandVersion = COMMAND_VERSION;
  CGOMachineABC.commandOperations = COMMAND_OPERATIONS;
  CGOMachineABC.normalizeCommand = normalizeCommand;
  CGOMachineABC.executeCommand = executeCommand;
  CGOMachineABC.executeCommandAsync = executeCommandAsync;
  CGOMachineABC.createCommandEnvelope = createCommandEnvelope;

[MachineA,MachineB,MachineC,MachineD].forEach(m=>Object.freeze(m));Object.freeze(CGOMachineABC);if(typeof module!=="undefined"&&module.exports)module.exports=CGOMachineABC;global.CGOMachineABC=CGOMachineABC;/* Jangan timpa window.CGO (Customer chat / CGO.esc UI) */if(typeof global.CGO==="undefined"){global.CGO=CGOMachineABC;}
})(typeof globalThis!=="undefined"?globalThis:window);
