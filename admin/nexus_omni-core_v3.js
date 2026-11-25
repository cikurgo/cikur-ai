// nexus.omni-core.v3.js — HARDENED EDITION v3.2.1 (FINAL)
// NO eval, NO Function, NO execution of analyzed code.
// ---------------------------------------------------------------
(() => {
  'use strict';

  // =====================================================
  // [0] CONSTANTS
  // =====================================================
  const V3              = '3.2.1-ULTIMATE-HARDENED-FINAL';
  const MAX_DEPTH       = 12;
  const MAX_BYTES       = 512 * 1024;
  const MAX_RECURS      = 2;
  const MIN_ENC_LEN     = 48;
  const HIGH_ENT        = 4.5;
  const MAX_CONCAT_ITER = 20;
  const MAX_NESTED      = 6;

  const CORE = (typeof window !== 'undefined' && window.NexusOmniCore)
             || (typeof globalThis !== 'undefined' && globalThis.NexusOmniCore);
  if (!CORE) throw new Error('NexusOmniCore v2.0 required');

  // =====================================================
  // [1] UTILITIES
  // =====================================================
  const ESC_IN = { n:'\n', t:'\t', r:'\r', '0':'\0', b:'\b', f:'\f', v:'\v',
                   '\\':'\\', "'":"'", '"':'"', '`':'`' };

  function decodeEsc(s) {
    if (typeof s !== 'string') return '';
    return s.replace(/\\(x[\da-f]{2}|u\{[\da-f]+\}|u[\da-f]{4}|[\s\S])/gi, (m, c) => {
      const h = c[0];
      if (h === 'x' && c.length === 3) return String.fromCharCode(parseInt(c.slice(1), 16));
      if (h === 'u') {
        if (c[1] === '{') {
          const n = parseInt(c.slice(2, -1), 16);
          return (Number.isFinite(n) && n <= 0x10FFFF) ? String.fromCodePoint(n) : m;
        }
        if (c.length === 5) return String.fromCharCode(parseInt(c.slice(1), 16));
      }
      return ESC_IN[c] !== undefined ? ESC_IN[c] : c;
    });
  }

  const quote = (s) => JSON.stringify(String(s));

  function shannonEntropy(s) {
    if (!s || typeof s !== 'string') return 0;
    const f = new Map();
    for (const c of s) f.set(c, (f.get(c) || 0) + 1);
    let h = 0;
    const n = s.length;
    for (const v of f.values()) { const p = v / n; h -= p * Math.log2(p); }
    return h;
  }

  function hashStr(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) h = ((h ^ s.charCodeAt(i)) * 16777619) | 0;
    return h >>> 0;
  }

  function deepFreeze(o, seen) {
    seen = seen || new WeakSet();
    if (o === null || typeof o !== 'object' || seen.has(o)) return o;
    seen.add(o);
    try { Object.freeze(o); } catch (_) { return o; }
    for (const k of Object.keys(o)) { try { deepFreeze(o[k], seen); } catch (_) {} }
    return o;
  }

  // FIX #4 (v3.2): pad base64url properly for atob
  function decodeBase64(b64) {
    let s = b64.replace(/-/g, '+').replace(/_/g, '/');
    const pad = s.length % 4;
    if (pad === 2) s += '==';
    else if (pad === 3) s += '=';
    else if (pad === 1) return null;
    return s;
  }

  // =====================================================
  // [2] REGEX BANK
  // =====================================================
  const RE = {
    BRACKET_DOT: /\b(window|globalThis|self|document|Object|Function|Array|RegExp|String|Number|JSON|Reflect|eval|atob|btoa|fetch|Symbol|Promise|Math|Date|console|setTimeout|setInterval|XMLHttpRequest|WebSocket|Worker|EventSource|RTCPeerConnection|localStorage|sessionStorage|Image)\s*\[\s*(['"])([\w$]+)\2\s*\]/g,

    // Lookahead (?!\1) — opposite quote allowed inside
    STR_CONCAT:     /(['"])((?:(?!\1)[^\\]|\\.){0,2048}?)\1\s*\+\s*(['"])((?:(?!\3)[^\\]|\\.){0,2048}?)\3/g,
    FROM_CHARCODE:  /\bString\s*\.\s*fromCharCode\s*\(\s*((?:0x[\da-f]+|\d+)(?:\s*,\s*(?:0x[\da-f]+|\d+))*)\s*\)/gi,
    FROM_CODEPOINT: /\bString\s*\.\s*fromCodePoint\s*\(\s*((?:0x[\da-f]+|\d+)(?:\s*,\s*(?:0x[\da-f]+|\d+))*)\s*\)/gi,
    HEX_ESC:        /(['"])((?:(?!\1)[^\\]|\\.)+)\1/g,

    // FIX #10: {2,} → decode even 1-char
    ATOB_LIT:       /\batob\s*\(\s*(['"])([A-Za-z0-9+/_-]{2,}={0,2})\1\s*\)/g,
    BTOA_LIT:       /\bbtoa\s*\(\s*(['"])((?:(?!\1)[^\\]|\\.){4,})\1\s*\)/g,
    PARSEINT_RADIX: /\bparseInt\s*\(\s*(['"])([0-9a-fA-F]+)\1\s*,\s*(16|2|8)\s*\)/g,
    ARRAY_JOIN:     /\[\s*((?:'[^']*'|"[^"]*")\s*(?:,\s*(?:'[^']*'|"[^"]*")\s*)*)\]\s*\.\s*join\s*\(\s*(['"])([^'"]*)\2\s*\)/g,
    REVERSE_JOIN:   /(['"])((?:[^\\'"]|\\.)*)\1\s*\.\s*split\s*\(\s*(['"])\s*\3\s*\)\s*\.\s*reverse\s*\(\s*\)\s*\.\s*join\s*\(\s*(['"])\s*\4\s*\)/g,
    UNESCAPE:       /\bunescape\s*\(\s*(['"])((?:[^\\'"]|\\.)*)\1\s*\)/g,
    DECODE_URI:     /\bdecodeURIComponent\s*\(\s*(['"])((?:[^\\'"]|\\.)*)\1\s*\)/g,

    // FIX #1 (regresi v3.2): fromCodePoint restored; backrefs verified
    XOR_SPLIT_MAP:  /(['"])((?:\d{1,5}\s*,\s*){2,}\d{1,5})\1\s*\.\s*split\s*\(\s*(['"])\s*,\s*\3\s*\)\s*\.\s*map\s*\(\s*(?:function\s*\(\s*(\w+)\s*\)\s*\{?\s*return|\(?\s*(\w+)\s*\)?\s*=>)\s*String\s*\.\s*from(?:CharCode|CodePoint)\s*\(\s*(\w+)\s*\^\s*(0x[\da-f]+|\d+)\s*\)\s*\)(?:\s*\.\s*join\s*\(\s*(['"])([^'"]*)\8\s*\))?/gi,

    XOR_ARRAY_MAP:  /\[\s*((?:\d{1,5}\s*,\s*)+\d{1,5})\s*\]\s*\.\s*map\s*\(\s*(?:function\s*\(\s*(\w+)\s*\)\s*\{?\s*return|\(?\s*(\w+)\s*\)?\s*=>)\s*String\s*\.\s*from(?:CharCode|CodePoint)\s*\(\s*(\w+)\s*\^\s*(0x[\da-f]+|\d+)\s*\)\s*\)(?:\s*\.\s*join\s*\(\s*(['"])([^'"]*)\6\s*\))?/gi,
  };

  // =====================================================
  // [3] DEOBFUSCATION RULES
  // =====================================================
  const RULES = [
    { name: 'bracket_dot',
      apply: s => s.replace(RE.BRACKET_DOT, '$1.$3') },

    { name: 'string_concat',
      apply: function(s) {
        let prev, safety = 0;
        do {
          prev = s;
          s = s.replace(RE.STR_CONCAT,
            (_m, _q1, a, _q2, b) => quote(decodeEsc(a) + decodeEsc(b)));
        } while (s !== prev && ++safety < MAX_CONCAT_ITER);
        return s;
      } },

    { name: 'from_charcode',
      apply: s => s.replace(RE.FROM_CHARCODE, (m, args) => {
        try {
          const nums = args.split(',').map(x => {
            x = x.trim();
            return x.startsWith('0x') ? parseInt(x, 16) : parseInt(x, 10);
          });
          if (nums.some(n => !Number.isFinite(n) || n < 0 || n > 0xFFFF)) return m;
          return quote(String.fromCharCode(...nums));
        } catch { return m; }
      }) },

    { name: 'from_codepoint',
      apply: s => s.replace(RE.FROM_CODEPOINT, (m, args) => {
        try {
          const nums = args.split(',').map(x => {
            x = x.trim();
            return x.startsWith('0x') ? parseInt(x, 16) : parseInt(x, 10);
          });
          if (nums.some(n => !Number.isFinite(n) || n < 0 || n > 0x10FFFF)) return m;
          return quote(String.fromCodePoint(...nums));
        } catch { return m; }
      }) },

    { name: 'hex_unicode_escapes',
      apply: s => s.replace(RE.HEX_ESC, (m, q, content) =>
        /\\[xu]/.test(content) ? q + JSON.stringify(decodeEsc(content)).slice(1, -1) + q : m) },

    { name: 'atob_literal',
      apply: s => s.replace(RE.ATOB_LIT, (m, _q, b64) => {
        try {
          const padded = decodeBase64(b64);
          if (padded === null) return m;
          const dec = atob(padded);
          if (!/^[\x20-\x7e\s]*$/.test(dec)) return m;
          return '/*[DECODED_B64]*/' + quote(dec);
        } catch { return m; }
      }) },

    { name: 'btoa_literal',
      apply: s => s.replace(RE.BTOA_LIT, (m, _q, content) => {
        try {
          const b64 = btoa(decodeEsc(content));
          return '/*[ENCODED_B64]*/' + quote(b64);
        } catch { return m; }
      }) },

    { name: 'parseint_radix',
      apply: s => s.replace(RE.PARSEINT_RADIX, (m, _q, num, radix) => {
        const v = parseInt(num, parseInt(radix, 10));
        return Number.isFinite(v) ? String(v) : m;
      }) },

    { name: 'array_join_literal',
      apply: s => s.replace(RE.ARRAY_JOIN, (m, arr, _jq, sep) => {
        try {
          const parts = arr.match(/(['"])((?:[^\\'"]|\\.)*)\1/g);
          if (!parts) return m;
          const joined = parts
            .map(p => decodeEsc(p.slice(1, -1)))
            .join(decodeEsc(sep || ''));
          return '/*[DEOBF:arrayJoin]*/' + quote(joined);
        } catch { return m; }
      }) },

    { name: 'reverse_join',
      apply: s => s.replace(RE.REVERSE_JOIN, (m, _q, content) => {
        try { return quote([...decodeEsc(content)].reverse().join('')); }
        catch { return m; }
      }) },

    { name: 'unescape_literal',
      apply: s => s.replace(RE.UNESCAPE, (m, _q, content) => {
        try {
          const dec = decodeEsc(content).replace(/%u([\da-f]{4})|%([\da-f]{2})/gi,
            (_x, u, h) => String.fromCharCode(parseInt(u || h, 16)));
          return '/*[DECODED_UNESCAPE]*/' + quote(dec);
        } catch { return m; }
      }) },

    { name: 'decode_uri_component',
      apply: s => s.replace(RE.DECODE_URI, (m, _q, content) => {
        try { return quote(decodeURIComponent(decodeEsc(content))); }
        catch { return m; }
      }) },

    { name: 'xor_split_map',
      apply: s => s.replace(RE.XOR_SPLIT_MAP,
        (m, _q, csv, _sq, argF, argA, fromArg, key, _jq, joinSep) => {
          if (fromArg !== (argF || argA)) return m;
          try {
            const k = key.toLowerCase().startsWith('0x') ? parseInt(key, 16) : parseInt(key, 10);
            const sep = joinSep !== undefined ? decodeEsc(joinSep) : '';
            const chars = csv.split(',')
              .map(n => String.fromCharCode(parseInt(n.trim(), 10) ^ k));
            const dec = chars.join(sep);
            if (!/^[\x20-\x7e\s]*$/.test(dec)) return m;
            return '/*[DECODED_XOR:k=' + k + ']*/' + quote(dec);
          } catch { return m; }
        }) },

    { name: 'xor_array_map',
      apply: s => s.replace(RE.XOR_ARRAY_MAP,
        (m, csv, argF, argA, fromArg, key, _jq, joinSep) => {
          if (fromArg !== (argF || argA)) return m;
          try {
            const k = key.toLowerCase().startsWith('0x') ? parseInt(key, 16) : parseInt(key, 10);
            const sep = joinSep !== undefined ? decodeEsc(joinSep) : '';
            const chars = csv.split(',')
              .map(n => String.fromCharCode(parseInt(n.trim(), 10) ^ k));
            const dec = chars.join(sep);
            if (!/^[\x20-\x7e\s]*$/.test(dec)) return m;
            return '/*[DECODED_XOR:k=' + k + ']*/' + quote(dec);
          } catch { return m; }
        }) },
  ];

  // =====================================================
  // [4] DEOBFUSCATION LOOP
  // =====================================================
  function deobfuscate(code, failures) {
    failures = failures || [];
    const history = [{ depth: 0, changes: [], length: code.length }];
    const visited = new Set([hashStr(code)]);
    let current = code;
    for (let depth = 1; depth <= MAX_DEPTH; depth++) {
      let next = current;
      const changes = [];
      for (const rule of RULES) {
        try {
          const before = next;
          next = rule.apply(next);
          if (next !== before) changes.push(rule.name);
        } catch (e) {
          failures.push({ stage: 'rule:' + rule.name, error: String((e && e.message) || e) });
        }
      }
      if (!changes.length) break;
      if (next.length > MAX_BYTES) {
        history.push({ depth, changes: [...changes, 'SIZE_CAP'], length: next.length });
        break;
      }
      const h = hashStr(next);
      if (visited.has(h)) {
        history.push({ depth, changes: [...changes, 'CYCLE_DETECTED'], length: next.length });
        break;
      }
      visited.add(h);
      history.push({ depth, changes, length: next.length });
      current = next;
    }
    return { original: code, deobfuscated: current, history };
  }

  // =====================================================
  // [5] ENCODED-PAYLOAD DETECTOR
  //     FIX #5: lookahead — allow opposite quote inside strings
  // =====================================================
  function detectEncodedPayloads(code) {
    const out = [];
    const re = /(['"])((?:(?!\1)[^\\]|\\.){20,})\1/g;
    let m;
    while ((m = re.exec(code)) !== null) {
      let content;
      try { content = decodeEsc(m[2]); } catch { continue; }
      if (content.length < MIN_ENC_LEN) continue;
      const H = shannonEntropy(content);
      if (H < HIGH_ENT) continue;
      out.push({
        length: content.length,
        entropy: +H.toFixed(2),
        kind: H > 5.5 ? 'likely_encrypted' : 'likely_encoded',
        preview: content.slice(0, 40).replace(/[^\x20-\x7e]/g, '.') + '…',
      });
      if (out.length >= 10) break;
    }
    return out;
  }

  // =====================================================
  // [6] NESTED PAYLOAD EXTRACTOR
  //     FIX #4: lookahead — allow opposite quote inside strings
  // =====================================================
  function extractNestedPayloads(code) {
    const out = [];

    const reEval = /\b(?:eval|execScript)\s*\(\s*(['"])((?:(?!\1)[^\\]|\\.){20,})\1\s*\)/g;
    for (const m of code.matchAll(reEval)) {
      try { out.push({ kind: 'eval_string', payload: decodeEsc(m[2]) }); } catch (_) {}
    }

    const reTimer = /\bset(?:Timeout|Interval)\s*\(\s*(['"])((?:(?!\1)[^\\]|\\.){20,})\1\s*[,)]/g;
    for (const m of code.matchAll(reTimer)) {
      try { out.push({ kind: 'timer_string', payload: decodeEsc(m[2]) }); } catch (_) {}
    }

    const reFn = /\b(?:new\s+)?Function\s*\(([^)]*)\)/g;
    for (const m of code.matchAll(reFn)) {
      const parts = m[1].match(/(['"])((?:(?!\1)[^\\]|\\.)*)\1/g);
      if (parts && parts.length) {
        try {
          const last = parts[parts.length - 1];
          out.push({ kind: 'function_body', payload: decodeEsc(last.slice(1, -1)) });
        } catch (_) {}
      }
    }

    return out
      .filter(x => x.payload && x.payload.length >= 20 && x.payload.length <= MAX_BYTES)
      .slice(0, MAX_NESTED);
  }

  // =====================================================
  // [7] EXTRA TAG DETECTOR
  //     FIX #2, #3: assignment regex with = (?!=) and operator support
  // =====================================================
  function detectExtraTags(code) {
    const findings = [];
    const add = (tag, weight, cwe, severity, source, flags) => {
      try {
        const re = new RegExp(source, flags || 'gi');
        const m = code.match(re);
        if (m && m.length) {
          findings.push({
            category: 'V3', tag, cwe, severity, count: m.length,
            samples: m.slice(0, 3).map(v => ({ value: String(v).slice(0, 100), index: 0 })),
            weight,
          });
        }
      } catch (_) {}
    };

    // ASG = assignment (= but not ==, ===) with optional operator
    const ASG = String.raw`\s*(?:[+\-*/%&|^]|<<|>>|\*\*)?=(?!=)`;

    // --- Keystroke / form / clipboard ---
    add('keypress_hook', 10, 'CWE-359', 'high',
      String.raw`\.addEventListener\s*\(\s*['"]key(?:down|press|up)['"]`);
    add('keylogger', 10, 'CWE-359', 'high',
      String.raw`(?:key(?:down|press|up)|keyCode|which)[^;]{0,80}(?:fetch|XMLHttpRequest|sendBeacon|socket\.send)`);
    add('form_access', 6, 'CWE-200', 'medium',
      String.raw`\bdocument\s*\.\s*forms\b|\.querySelector(?:All)?\s*\(\s*['"][^'"]*input`);
    add('input_read', 7, 'CWE-200', 'high',
      String.raw`(?:input|password|user|email|card|cvv|pin)[^;]{0,80}\.value\b`);
    add('clipboard_read', 8, 'CWE-359', 'high',
      String.raw`\bnavigator\s*\.\s*clipboard\s*\.\s*read(?:Text)?\b`);
    add('clipboard_api', 5, 'CWE-359', 'medium',
      String.raw`\bnavigator\s*\.\s*clipboard\b`);

    // --- Storage / egress (FIX #2) ---
    add('cookie_assign', 6, 'CWE-539', 'medium',
      String.raw`\bdocument\s*\.\s*cookie` + ASG);
    add('cookie_read', 4, 'CWE-539', 'low',
      String.raw`\bdocument\s*\.\s*cookie\b(?!\s*(?:[+\-*/%&|^]|<<|>>|\*\*)?=(?!=))`);
    add('localstorage_write', 5, 'CWE-922', 'medium',
      String.raw`\blocalStorage\s*\.\s*setItem\b|\blocalStorage\s*\[`);
    add('sessionstorage_write', 5, 'CWE-922', 'medium',
      String.raw`\bsessionStorage\s*\.\s*setItem\b|\bsessionStorage\s*\[`);
    add('fetch', 3, 'CWE-201', 'low',
      String.raw`\bfetch\s*\(`);
    add('xhr_new', 4, 'CWE-201', 'medium',
      String.raw`new\s+XMLHttpRequest\b|\bnew\s+ActiveXObject\s*\(\s*['"]MSXML`);
    add('websocket', 5, 'CWE-201', 'medium',
      String.raw`new\s+WebSocket\s*\(`);
    add('beacon', 6, 'CWE-201', 'high',
      String.raw`\bnavigator\s*\.\s*sendBeacon\s*\(`);
    add('image_beacon', 6, 'CWE-201', 'high',
      String.raw`new\s+Image\s*\([^)]*\)[^;]{0,40}\.src\s*=`);

    // --- Dynamic code ---
    add('eval_call', 9, 'CWE-95', 'critical',
      String.raw`\beval\s*\(`);
    add('function_ctor', 9, 'CWE-95', 'critical',
      String.raw`\bnew\s+Function\s*\(|\bFunction\s*\(\s*['"]`);
    add('constructor_constructor', 10, 'CWE-95', 'critical',
      String.raw`\.constructor\s*\.\s*constructor\b`);
    add('timer_string_exec', 7, 'CWE-95', 'high',
      String.raw`\bset(?:Timeout|Interval)\s*\(\s*['"]`);

    // --- DOM injection (FIX #3) ---
    add('innerHTML_assign', 7, 'CWE-79', 'high',
      String.raw`\.innerHTML` + ASG);
    add('outerHTML_assign', 7, 'CWE-79', 'high',
      String.raw`\.outerHTML` + ASG);
    add('insertAdjacentHTML', 7, 'CWE-79', 'high',
      String.raw`\.insertAdjacentHTML\s*\(`);
    add('document_write', 6, 'CWE-79', 'medium',
      String.raw`\bdocument\s*\.\s*write(?:ln)?\s*\(`);
    add('script_injection', 9, 'CWE-79', 'critical',
      String.raw`createElement\s*\(\s*['"]script['"]\s*\)`);

    // --- Proto pollution ---
    add('proto_assign', 8, 'CWE-1321', 'high',
      String.raw`\b__proto__\s*[=.]|\.prototype\s*\[`);
    add('proto_dunder', 9, 'CWE-1321', 'high',
      String.raw`\b__proto__\b|\bconstructor\s*\.\s*prototype\b`);
    add('symbol_primitive', 8, 'CWE-1321', 'high',
      String.raw`Symbol\s*\.\s*toPrimitive`);

    // --- WebRTC ---
    add('webrtc', 7, 'CWE-201', 'high',
      String.raw`RTCPeerConnection`);
    add('conn_probe', 5, 'CWE-200', 'medium',
      String.raw`createDataChannel|createOffer|localDescription`);

    // --- Service worker / cache / WASM ---
    add('service_worker_register', 9, 'CWE-829', 'high',
      String.raw`\bserviceWorker\s*\.\s*register\s*\(`);
    add('caches_open', 6, 'CWE-829', 'medium',
      String.raw`\bcaches\s*\.\s*open\s*\(`);
    add('cache_storage', 5, 'CWE-829', 'medium',
      String.raw`\bCacheStorage\b|\bcaches\b`);
    add('wasm_instantiate', 10, 'CWE-829', 'high',
      String.raw`WebAssembly\s*\.\s*(?:instantiate|instantiateStreaming|compile|compileStreaming)\b`);
    add('webassembly_module', 7, 'CWE-829', 'medium',
      String.raw`\bWebAssembly\b`);
    add('worker_new', 6, 'CWE-829', 'medium',
      String.raw`\bnew\s+(?:Shared)?Worker\s*\(`);

    // --- Crypto / geo ---
    add('crypto_subtle', 7, 'CWE-327', 'medium',
      String.raw`\bcrypto\s*\.\s*subtle\s*\.\s*(?:encrypt|decrypt|importKey|deriveKey|sign|verify)\b`);
    add('subtle_encrypt', 7, 'CWE-327', 'medium',
      String.raw`\bsubtle\s*\.\s*encrypt\s*\(`);
    add('geolocation_get', 7, 'CWE-359', 'high',
      String.raw`\bnavigator\s*\.\s*geolocation\s*\.\s*getCurrentPosition\b`);

    return findings;
  }

  // =====================================================
  // [8] BEHAVIORAL CHAIN ANALYZER
  //     FIX #6: proto_exfil_gadget requires actual proto tamper
  //     FIX #9: null-safe findings iteration
  // =====================================================
  function analyzeChains(findings, syntheticTags) {
    const tags = new Set();
    for (const f of findings) {
      if (!f || typeof f !== 'object') continue;              // FIX #9
      if (typeof f.tag === 'string') tags.add(f.tag);
      if (Array.isArray(f.tags)) for (const t of f.tags) tags.add(t);
    }
    if (syntheticTags) for (const t of syntheticTags) tags.add(t);

    const has = (...t) => t.some(x => tags.has(x));
    const chains = [];
    const add = (chain, severity, meaning) => chains.push({ chain, severity, meaning });

    if (has('atob','eval_call') && has('from_charcode','hex_escape_run'))
      add('layered_dropper', 10, 'Multi-layer encoding + dynamic exec');

    if (has('fetch','xhr_new','websocket','beacon') &&
        has('cookie_assign','localstorage_write','sessionstorage_write'))
      add('credential_exfil', 10, 'Storage/cookie access + egress');

    if (has('proto_assign','proto_dunder','symbol_primitive') &&
        has('document_write','innerHTML_assign','outerHTML_assign','insertAdjacentHTML'))
      add('dom_proto_pollution', 9, 'Prototype tamper → DOM inject');

    if (has('beacon','image_beacon') && has('atob','high_entropy_base64'))
      add('stealth_exfil', 9, 'Obfuscated + beacon-based exfil');

    if (has('webrtc','conn_probe') && has('cookie_assign','localstorage_write'))
      add('p2p_credential_theft', 10, 'P2P exfil of credentials');

    if (has('script_injection') && has('timer_string_exec'))
      add('delayed_injection', 8, 'Delayed script exec via timer');

    if (has('keylogger','keypress_hook') && has('fetch','xhr_new','beacon'))
      add('keylogger_exfil', 10, 'Keystroke capture + exfil');

    if (has('form_access','input_read') && has('fetch','xhr_new'))
      add('form_harvest', 9, 'Form scraping + exfil');

    if (has('clipboard_read','clipboard_api') && has('fetch','xhr_new'))
      add('clipboard_theft', 8, 'Clipboard access + exfil');

    if (has('service_worker_register') && has('caches_open','cache_storage'))
      add('sw_persistence', 9, 'Service-worker persistence');

    if (has('wasm_instantiate','webassembly_module') && has('worker_new'))
      add('wasm_worker_payload', 9, 'WASM payload in worker');

    if (has('crypto_subtle','subtle_encrypt') && has('atob','high_entropy_base64'))
      add('encrypted_stager', 8, 'Crypto + encoded stager');

    if (has('geolocation_get') && has('fetch','beacon'))
      add('geo_tracking', 7, 'Geolocation exfiltration');

    if (has('constructor_constructor') && has('atob','hex_escape_run'))
      add('obfuscated_eval', 10, 'Indirect eval via constructor chain');

    // FIX #6: require actual proto tamper — Symbol.toPrimitive alone is legit
    if (has('symbol_primitive') &&
        has('proto_assign','proto_dunder','constructor_constructor') &&
        has('fetch','xhr_new','beacon'))
      add('proto_exfil_gadget', 9, 'Prototype coercion → exfil');

    return chains;
  }

  // =====================================================
  // [9] EXTERNAL DEPENDENCY DETECTOR
  // =====================================================
  function detectExternalDeps(code) {
    const urls = [...new Set(code.match(/https?:\/\/[^\s'"`<>()]{4,2048}/gi) || [])].slice(0, 20);

    const dynamicLoads = [];
    for (const m of code.matchAll(/\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g))
      dynamicLoads.push({ kind: 'dynamic_import', url: m[2] });
    for (const m of code.matchAll(/new\s+(?:Shared)?Worker\s*\(\s*(['"])([^'"]+)\1/g))
      dynamicLoads.push({ kind: 'worker_load', url: m[2] });
    for (const m of code.matchAll(/\.src\s*=\s*(['"])([^'"]+\.js[^'"]*)\1/g))
      dynamicLoads.push({ kind: 'script_src', url: m[2] });
    for (const m of code.matchAll(/\bimportScripts\s*\(\s*(['"])([^'"]+)\1/g))
      dynamicLoads.push({ kind: 'import_scripts', url: m[2] });
    for (const m of code.matchAll(/\bserviceWorker\s*\.\s*register\s*\(\s*(['"])([^'"]+)\1/g))
      dynamicLoads.push({ kind: 'sw_register', url: m[2] });
    for (const m of code.matchAll(/\.(?:href|action|src)\s*=\s*(['"])([^'"]+)\1/g)) {
      if (/^(https?:|\/\/|data:|blob:)/i.test(m[2]))
        dynamicLoads.push({ kind: 'dom_redirect', url: m[2] });
    }

    const hasWasm = /\.wasm\b|WebAssembly\s*\.\s*(?:instantiate|compile|Module|Instance)/i.test(code);

    const gates = [];
    if (/\blocation\s*\.\s*(?:hostname|href|origin|pathname)\b/i.test(code)) gates.push('location_gate');
    if (/\bnavigator\s*\.\s*(?:userAgent|platform|language|vendor)\b/i.test(code)) gates.push('useragent_gate');
    if (/\bDate\s*\.\s*now|\bnew\s+Date\b/i.test(code) && /\bif\s*\([^)]*Date/i.test(code)) gates.push('time_gate');
    if (/\bdocument\s*\.\s*cookie\b/i.test(code)) gates.push('cookie_gate');
    if (/\bscreen\s*\.\s*(?:width|height|availWidth|availHeight)\b/i.test(code)) gates.push('screen_gate');
    if (/\bperformance\s*\.\s*(?:now|timing)\b/i.test(code) && /\bif\s*\([^)]*performance/i.test(code)) gates.push('perf_gate');
    if (/\bdebugger\b/.test(code)) gates.push('debugger_gate');

    return {
      urls, dynamicLoads, hasWasm,
      conditionalGates: gates,
      remotePayloads: dynamicLoads.filter(d => !/^(data|blob|javascript):/i.test(d.url)),
    };
  }

  // =====================================================
  // [10] RECURSIVE NESTED ANALYSIS
  // =====================================================
  function analyzeRecursive(payload, depth, acc, report, failures, threatType) {
    if (depth > MAX_RECURS) return acc;
    if (typeof payload !== 'string' || payload.length > MAX_BYTES) return acc;

    const deobf = deobfuscate(payload, failures);
    const nested = extractNestedPayloads(deobf.deobfuscated);

    for (const n of nested) {
      const r = report(threatType, n.payload);
      acc.push({
        depth, kind: n.kind, length: n.payload.length,
        preview: n.payload.slice(0, 120),
        status: r ? r.status : 'CLEAN',
        TSI: r ? r.TSI : 0,
      });
      if (r && (r.status === 'SUSPICIOUS' ||
                r.status === 'MALICIOUS'  ||
                r.status === 'CRITICAL')) {
        analyzeRecursive(n.payload, depth + 1, acc, report, failures, threatType);
      }
    }
    return acc;
  }

  // =====================================================
  // [11] MAIN PIPELINE
  // =====================================================
  function analyzeV3(threatType, payload) {
    if (typeof threatType !== 'string' || typeof payload !== 'string')
      throw new TypeError('analyzeV3(threatType: string, payload: string)');

    const t0 = (typeof performance !== 'undefined' && performance.now)
             ? performance.now() : Date.now();

    const failures = [];
    const report = (type, p) => {
      try {
        const r = CORE.analyzeAndNeutralize(type, p);
        if (r && typeof r === 'object') return r;
      } catch (e) {
        failures.push({ stage: 'safeReport', error: String((e && e.message) || e) });
      }
      return {
        TSI: 0, status: 'CLEAN',
        vectorBreakdown: { OI: 0, EI: 0, NE: 0, SM: 0 },
        findings: [], neutralizationProtocol: [], iocs: [],
      };
    };

    // Stage 1 — deobfuscate
    const deobf = deobfuscate(payload, failures);
    const wasObfuscated = deobf.deobfuscated !== payload;

    // Stage 2 — dual scan
    const origReport = report(threatType, payload);
    const deobReport = wasObfuscated ? report(threatType, deobf.deobfuscated) : origReport;

    // Stage 3 — merge vectors
    const vb = (r) => (r.vectorBreakdown && {
      OI: +r.vectorBreakdown.OI || 0, EI: +r.vectorBreakdown.EI || 0,
      NE: +r.vectorBreakdown.NE || 0, SM: +r.vectorBreakdown.SM || 0,
    }) || { OI: 0, EI: 0, NE: 0, SM: 0 };

    const o = vb(origReport), d = vb(deobReport);
    const vectors = {
      OI: Math.max(o.OI, d.OI), EI: Math.max(o.EI, d.EI),
      NE: Math.max(o.NE, d.NE), SM: Math.max(o.SM, d.SM),
    };
    const TSI = Math.round(
      vectors.OI * 0.30 + vectors.EI * 0.25 +
      vectors.NE * 0.25 + vectors.SM * 0.20
    );
    const origTSI = +origReport.TSI || 0;

    // Stage 4 — enrich findings
    // FIX #8: dedupe by (category, tag)
    const rawFindings = [
      ...(origReport.findings || []),
      ...(wasObfuscated ? (deobReport.findings || []) : []),
    ];
    const extraFindings = detectExtraTags(wasObfuscated ? deobf.deobfuscated : payload);

    const seen = new Set();
    const allFindings = [...rawFindings, ...extraFindings].filter(f => {
      if (!f || typeof f !== 'object') return false;
      const k = (f.category || '') + ':' + (f.tag || '');
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    const encoded      = detectEncodedPayloads(wasObfuscated ? deobf.deobfuscated : payload);
    const externalDeps = detectExternalDeps(payload);

    // Stage 5 — recursive nested analysis
    const nestedAcc = [];
    analyzeRecursive(payload, 1, nestedAcc, report, failures, threatType);

    const syntheticTags = new Set();
    if (encoded.length) syntheticTags.add('high_entropy_base64');
    if (nestedAcc.some(n => n.kind === 'eval_string' || n.kind === 'function_body'))
      syntheticTags.add('eval_call');
    if (nestedAcc.some(n => n.kind === 'timer_string'))
      syntheticTags.add('timer_string_exec');

    const chains = analyzeChains(allFindings, syntheticTags);

    // Stage 6 — status
    let status = TSI >= 70 ? 'MALICIOUS'
               : TSI >= 40 ? 'SUSPICIOUS'
               : TSI >= 20 ? 'LOW_RISK'
               :             'CLEAN';

    if (wasObfuscated && TSI >= 40 && (TSI - origTSI) > 15) status = 'CRITICAL';
    if (chains.some(c => c.severity >= 9) && status !== 'CRITICAL') status = 'MALICIOUS';

    const rank = { CLEAN: 0, LOW_RISK: 1, SUSPICIOUS: 2, MALICIOUS: 3, CRITICAL: 4 };
    const worstNested = nestedAcc.reduce(
      (acc, n) => (rank[n.status] || 0) > (rank[acc] || 0) ? n.status : acc, 'CLEAN'
    );
    if (worstNested === 'CRITICAL') status = 'CRITICAL';
    else if (worstNested === 'MALICIOUS' && status !== 'CRITICAL') status = 'MALICIOUS';
    else if (worstNested === 'SUSPICIOUS' && (status === 'CLEAN' || status === 'LOW_RISK'))
      status = 'SUSPICIOUS';

    if ((status === 'CLEAN' || status === 'LOW_RISK') && externalDeps.remotePayloads.length)
      status = 'NEEDS_FETCH';
    if ((status === 'CLEAN' || status === 'LOW_RISK') && externalDeps.hasWasm)
      status = 'NEEDS_DYNAMIC';

    // Stage 7 — confidence
    // FIX #7: weight TSI so single-signal high-TSI gets fair confidence
    const confidence = status === 'CLEAN'
      ? Math.max(0, 90 - TSI - allFindings.length * 2)
      : Math.min(100,
          40 + allFindings.length * 4 + chains.length * 15
          + (wasObfuscated ? 20 : 0)
          + (encoded.length ? 10 : 0)
          + (nestedAcc.length ? 10 : 0)
          + Math.min(Math.round(TSI * 0.3), 20));

    // Stage 8 — protocols
    const protocols = [...(origReport.neutralizationProtocol || [])];

    if (wasObfuscated) {
      protocols.push({
        priority: 'P0',
        action: `Static deobfuscation: ${deobf.history.length - 1} pass(es) — ` +
                `${[...new Set(deobf.history.map(h => h.changes).flat())].join(', ')}.`,
        trigger: 'deobfuscation',
      });
    }
    for (const c of chains) {
      protocols.push({
        priority: 'P0',
        action: `Behavioral chain [${c.chain}] sev=${c.severity}: ${c.meaning}`,
        trigger: 'behavioral_chain',
      });
    }
    if (encoded.length) {
      protocols.push({
        priority: 'P1',
        action: `High-entropy literal(s) detected (${encoded.length}) — ` +
                `likely encoded/encrypted payload; route to decoder.`,
        trigger: 'entropy',
      });
    }
    for (const n of nestedAcc) {
      if (n.status === 'MALICIOUS' || n.status === 'CRITICAL') {
        protocols.push({
          priority: 'P0',
          action: `Nested payload depth=${n.depth} [${n.kind}] verdict=${n.status} TSI=${n.TSI}`,
          trigger: 'nested_payload',
        });
      }
    }
    if (externalDeps.remotePayloads.length) {
      protocols.push({
        priority: 'P1',
        action: `Fetch & re-analyze ${externalDeps.remotePayloads.length} remote payload(s): ` +
                externalDeps.remotePayloads.slice(0, 3).map(dp => dp.url).join(', '),
        trigger: 'external_dependency',
      });
    }
    if (externalDeps.conditionalGates.length) {
      protocols.push({
        priority: 'P1',
        action: `Execute in sandbox under monitored gates: ` +
                externalDeps.conditionalGates.join(', '),
        trigger: 'conditional_gate',
      });
    }
    if (externalDeps.hasWasm) {
      protocols.push({
        priority: 'P1',
        action: 'Route WebAssembly binary to WASM-specific analyzer.',
        trigger: 'wasm',
      });
    }

    const t1 = (typeof performance !== 'undefined' && performance.now)
             ? performance.now() : Date.now();

    const result = {
      version: V3,
      threatType, TSI, confidence, status,
      vectorBreakdown: vectors,
      originalStatus: origReport.status,
      originalTSI: origTSI,
      deobfuscation: {
        wasObfuscated,
        layers: deobf.history.length - 1,
        transformations: [...new Set(deobf.history.map(h => h.changes).flat())],
        deobfuscatedPreview: wasObfuscated ? deobf.deobfuscated.slice(0, 800) : null,
        sizeChange: deobf.deobfuscated.length - payload.length,
      },
      behavioralChains: chains,
      externalDependencies: externalDeps,
      encodedPayloads: encoded,
      nestedPayloads: nestedAcc,
      findings: allFindings,
      neutralizationProtocol: protocols,
      iocs: origReport.iocs || [],
      failures: failures.slice(0, 20),
      stats: {
        bytes: payload.length,
        findings: allFindings.length,
        chains: chains.length,
        nested: nestedAcc.length,
        layersUnpacked: deobf.history.length - 1,
        analysisMs: +(t1 - t0).toFixed(2),
      },
    };

    return deepFreeze(result);
  }

  // =====================================================
  // [12] PUBLIC API
  // =====================================================
  const nexusV3 = Object.freeze({
    analyze: analyzeV3,
    deobfuscate,
    detectExternalDeps,
    detectEncodedPayloads,
    extractNestedPayloads,
    detectExtraTags,
    analyzeChains,
    VERSION: V3,
    BASE_VERSION: CORE.VERSION || '2.0',
    getMeta: function () { var b = { id: 'NexusOmniCoreV3', version: V3, checksum: null, fingerprint: null, source: 'none', status: 'SKIP' }; try { var I = typeof globalThis !== 'undefined' ? globalThis.NexusIntegrity : null; if (I && typeof I.describe === 'function') return I.describe(b.id, b); } catch (e) {} return b; },
    _rules: Object.freeze(RULES.map(r => r.name)),
    _regex: Object.freeze(RE),
  });

  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'NexusOmniCoreV3', {
      value: nexusV3, writable: false, enumerable: true, configurable: false,
    });
  } else if (typeof globalThis !== 'undefined') {
    globalThis.NexusOmniCoreV3 = nexusV3;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = nexusV3;
})();
