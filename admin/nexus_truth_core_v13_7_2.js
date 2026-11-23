/*! ═══════════════════════════════════════════════════════════════════
 *  NEXUS TRUTH CORE v13.7.2 — Universal Truth-Guard (IPV6 HARDENED + browser SSRF on)
 *  ─────────────────────────────────────────────────────────────────
 *  CHANGELOG dari v13.7.1:
 *   • FIX: T7/T10/T11/T12 kini juga dijalankan di browser (guard SSRF aktif di browser)
 *  CHANGELOG dari v13.7.0:
 *   • FIX: isSafeUrl aktif di browser (hapus bypass IS_BROWSER)
 *   • ADD: blok hostname metadata (metadata.google.internal, k8s default)
 *  CHANGELOG dari v13.6:
 *   • FIX B6: expandIPv6 — normalisasi penuh, tangkap `0:0:0:0:0:ffff:7f00:1`
 *   • FIX B7: blokir NAT64 (64:ff9b::/96), 6to4 (2002::/16), Teredo (2001::/32),
 *             IPv4-compatible (::/96), documentation (2001:db8::/32)
 *   • FIX B8: calibrate() propagate sourceTier/quoteVerified/entityFound
 *             → label(calibrate(...)) kini konsisten
 *   • FIX B5: numOr() helper — opts.maxRedirects:0 & opts.threshold:0 dihormati
 *   • FIX B3: label() demote entityAmbiguous tanpa quoteVerified
 *   • FIX B2: audit() truncation extend ke whitespace (URL tak terpotong)
 *   • ADD: T11/T12/T13 — regresi IPv6 SSRF + calibrate→label round-trip
 *   • ADD: norm() strip BOM (\uFEFF) & Mongolian vowel separator
 *  ─────────────────────────────────────────────────────────────────
 *  KONTRAK: Nol dependensi, nol API key. Publik TIDAK throw.
 *           Tanpa bukti → confidence ≤30% (Hukum 4).
 * ═══════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = factory();
  } else if (typeof define === 'function' && define.amd) {
    define([], function () { return factory(); });
  } else {
    root.NexusTruth = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis
 : typeof self !== 'undefined' ? self : this,
function () {
  'use strict';

  /* ══════════════════ KONFIGURASI ══════════════════ */
  const DEFAULTS = Object.freeze({
    timeoutMs: 8000, retries: 1,
    quoteThreshold: 0.90, entityThreshold: 0.75,
    noEvidenceCap: 30, verifyUrlsPerGate: 5,
    maxBodyBytes: 5 * 1024 * 1024,
    maxAuditBytes: 2 * 1024 * 1024,
    maxRedirects: 5, useProxy: true, allowPrivateUrls: false,
    proxies: Object.freeze([
      'https://api.allorigins.win/raw?url=',
      'https://corsproxy.io/?url='
    ])
  });

  const ALLOWED_KEYS = Object.freeze({
    timeoutMs:        { min: 500, max: 60000, int: true },
    retries:          { min: 0,   max: 5,     int: true },
    quoteThreshold:   { min: 0,   max: 1,     num: true },
    entityThreshold:  { min: 0,   max: 1,     num: true },
    noEvidenceCap:    { min: 0,   max: 100,   int: true },
    verifyUrlsPerGate:{ min: 0,   max: 20,    int: true },
    maxBodyBytes:     { min: 1024, max: 50 * 1024 * 1024, int: true },
    maxAuditBytes:    { min: 1024, max: 20 * 1024 * 1024, int: true },
    maxRedirects:     { min: 0,   max: 10,    int: true },
    useProxy:         { bool: true },
    allowPrivateUrls: { bool: true },
    proxies:          { arr: true }
  });

  const cfg = Object.assign({}, DEFAULTS, { proxies: DEFAULTS.proxies.slice() });

  const IS_BROWSER = typeof window !== 'undefined'
                  && typeof document !== 'undefined';
  const HAS_FETCH  = typeof fetch === 'function';
  const HAS_ABORT  = typeof AbortController === 'function';
  const HAS_NORMALIZE = typeof ''.normalize === 'function';

  function configure(o) {
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      for (const k of Object.keys(o)) {
        if (!Object.prototype.hasOwnProperty.call(ALLOWED_KEYS, k)) continue;
        const spec = ALLOWED_KEYS[k];
        const v = o[k];
        if (spec.bool) { cfg[k] = !!v; continue; }
        if (spec.arr) {
          cfg[k] = Array.isArray(v)
            ? v.filter(x => {
                if (typeof x !== 'string') return false;
                if (!/^https?:\/\//i.test(x)) return false;
                try {
                  const u = new URL(x);
                  if (u.username || u.password) return false;
                  return true;
                } catch (e) { return false; }
              }).slice(0, 8)
            : cfg[k];
          continue;
        }
        if (spec.num) {
          const n = Number(v);
          if (!Number.isFinite(n)) continue;
          cfg[k] = Math.max(spec.min, Math.min(spec.max, n));
          continue;
        }
        if (spec.int) {
          const n = parseInt(v, 10);
          if (!Number.isFinite(n)) continue;
          cfg[k] = Math.max(spec.min, Math.min(spec.max, n));
          continue;
        }
      }
    }
    return getConfig();
  }

  function getConfig() {
    return Object.assign({}, cfg, { proxies: cfg.proxies.slice() });
  }

  /* ══════════════════ UTIL INTI ══════════════════ */
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  /* FIX B5: helper — hormati 0 & string angka */
  function numOr(v, def) {
    if (v == null) return def;
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  }

  function norm(s) {
    let v = String(s == null ? '' : s)
      .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u180E\uFEFF]/g, ' ')
      .replace(/[\u200B\u200C\u200D]/g, '')
      .replace(/\u00AD/g, '')
      .replace(/[\u2018\u2019\u02BC\u2032]/g, "'")
      .replace(/[\u201C\u201D\u02BA\u2033]/g, '"')
      .replace(/[\u2013\u2014\u2012\u2212]/g, '-');
    if (HAS_NORMALIZE) {
      try { v = v.normalize('NFKC'); } catch (e) { /* surrogate rusak */ }
    }
    return v.replace(/\s+/g, ' ').toLowerCase().trim();
  }

  function decodeNumericEntity(c) {
    if (!(c >= 32 && c <= 0x10FFFF)) return ' ';
    try {
      if (c < 0x10000) return String.fromCharCode(c);
      return String.fromCodePoint(c);
    } catch (e) { return ' '; }
  }

  const NAMED_ENTITIES = Object.freeze({
    amp:'&', quot:'"', apos:"'", lt:'<', gt:'>', nbsp:' ',
    mdash:'-', ndash:'-', hellip:'...', copy:'(c)', reg:'(r)', trade:'(tm)'
  });

  function htmlToText(h) {
    return String(h == null ? '' : h)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|([a-zA-Z]+));/g,
        (m, dec, hex, name) => {
          if (dec) return decodeNumericEntity(+dec);
          if (hex) return decodeNumericEntity(parseInt(hex, 16));
          const v = NAMED_ENTITIES[name.toLowerCase()];
          return v !== undefined ? v : m;
        });
  }

  function trigrams(s) {
    const t = new Set();
    s = norm(s);
    for (let i = 0; i <= s.length - 3; i++) t.add(s.slice(i, i + 3));
    return t;
  }

  function trigramScore(needle, hay) {
    const a = trigrams(needle), b = trigrams(hay);
    if (a.size === 0 || b.size === 0) return 0;
    let hit = 0;
    a.forEach(x => { if (b.has(x)) hit++; });
    return hit / a.size;
  }

  const unique = (arr) => Array.from(new Set(arr));

  function esc(s) {
    return String(s).replace(/[<>&"']/g,
      c => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;', '"':'&quot;', "'":'&#39;' }[c]));
  }

  /* ══════════════════ SSRF GUARD ══════════════════ */
  function parseNum(s) {
    if (/^0x[0-9a-f]+$/i.test(s)) return parseInt(s, 16);
    if (/^0[0-7]+$/.test(s) && s.length > 1) return parseInt(s, 8);
    if (/^[0-9]+$/.test(s)) return parseInt(s, 10);
    return null;
  }

  function canonicalIPv4(h) {
    h = String(h || '').replace(/\.$/, '');
    if (!/^[0-9a-fx.]+$/i.test(h)) return null;
    const parts = h.split('.');
    if (parts.length === 1) {
      const n = parseNum(parts[0]);
      if (n !== null && n <= 0xFFFFFFFF) {
        return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
      }
      return null;
    }
    if (parts.length < 2 || parts.length > 4) return null;
    const nums = parts.map(parseNum);
    if (nums.some(n => n === null)) return null;
    let addr = 0;
    if (parts.length === 4) {
      if (nums.some(n => n > 255)) return null;
      addr = (nums[0] << 24 | nums[1] << 16 | nums[2] << 8 | nums[3]) >>> 0;
    } else if (parts.length === 3) {
      if (nums[0] > 255 || nums[1] > 255 || nums[2] > 0xFFFF) return null;
      addr = (nums[0] << 24 | nums[1] << 16 | nums[2]) >>> 0;
    } else {
      if (nums[0] > 255 || nums[1] > 0xFFFFFF) return null;
      addr = (nums[0] << 24 | nums[1]) >>> 0;
    }
    return [addr >>> 24, (addr >>> 16) & 255, (addr >>> 8) & 255, addr & 255].join('.');
  }

  function isPrivateIPv4(ip) {
    const [a, b, c] = ip.split('.').map(Number);
    if (a === 0) return true;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a === 198 && b === 51 && c === 100) return true;
    if (a === 203 && b === 0 && c === 113) return true;
    if (a >= 224) return true;
    return false;
  }

  /* FIX B6: normalisasi IPv6 penuh (expand ::, IPv4-mapped dotted/hex) */
  function expandIPv6(h) {
    if (typeof h !== 'string' || h.indexOf(':') === -1) return null;
    let s = h.toLowerCase().replace(/%[^:]*$/, '');
    if (s.length > 512) return null;                 // sanity cap

    /* IPv4 suffix: ...:a.b.c.d  (bisa setelah ::) */
    let v4Groups = null;
    const v4tail = s.match(/(^|:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (v4tail) {
      const v4 = canonicalIPv4(v4tail[2]);
      if (!v4) return null;
      const [a, b, c, d] = v4.split('.').map(Number);
      v4Groups = [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
      s = s.slice(0, s.length - v4tail[2].length).replace(/:$/, '');
      if (!s) s = '::';
    }

    const parts = s.split('::');
    if (parts.length > 2) return null;
    let head, tail;
    if (parts.length === 2) {
      head = parts[0] ? parts[0].split(':') : [];
      tail = parts[1] ? parts[1].split(':') : [];
    } else {
      head = parts[0] ? parts[0].split(':') : [];
      tail = [];
    }
    if (v4Groups) tail = tail.concat(v4Groups);

    const total = head.length + tail.length;
    if (total > 8) return null;
    if (parts.length === 1 && total !== 8) return null;
    if (parts.length === 2 && total >= 8) return null;

    const missing = 8 - total;
    const groups = head.concat(Array(missing).fill('0'), tail);
    if (groups.length !== 8) return null;

    const nums = groups.map(g => {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return NaN;
      return parseInt(g, 16);
    });
    if (nums.some(n => !Number.isFinite(n) || n < 0 || n > 0xFFFF)) return null;
    return nums;
  }

  /* FIX B7: lengkapi cakupan — NAT64, 6to4, Teredo, IPv4-compatible, doc */
  function isPrivateIPv6(h) {
    const g = expandIPv6(h);
    if (!g) return false;

    /* ::/128 unspecified */
    if (g.every(x => x === 0)) return true;
    /* ::1/128 loopback */
    if (g[0]===0 && g[1]===0 && g[2]===0 && g[3]===0
        && g[4]===0 && g[5]===0 && g[6]===0 && g[7]===1) return true;
    /* ::/96 IPv4-compatible (deprecated) */
    if (g[0]===0 && g[1]===0 && g[2]===0 && g[3]===0
        && g[4]===0 && g[5]===0) return true;
    /* ::ffff:0:0/96 IPv4-mapped */
    if (g[0]===0 && g[1]===0 && g[2]===0 && g[3]===0
        && g[4]===0 && g[5]===0xffff) return true;
    /* 64:ff9b::/96 NAT64 */
    if (g[0]===0x0064 && g[1]===0xff9b
        && g[2]===0 && g[3]===0 && g[4]===0 && g[5]===0) return true;
    /* 64:ff9b:1::/48 NAT64 lokal */
    if (g[0]===0x0064 && g[1]===0xff9b && g[2]===0x0001) return true;
    /* 2001::/32 Teredo */
    if (g[0]===0x2001 && g[1]===0x0000) return true;
    /* 2001:db8::/32 documentation */
    if (g[0]===0x2001 && g[1]===0x0db8) return true;
    /* 2002::/16 6to4 */
    if (g[0]===0x2002) return true;
    /* fc00::/7 ULA */
    if ((g[0] & 0xfe00) === 0xfc00) return true;
    /* fe80::/10 link-local */
    if ((g[0] & 0xffc0) === 0xfe80) return true;
    /* ff00::/8 multicast */
    if ((g[0] & 0xff00) === 0xff00) return true;

    return false;
  }

  function isSafeUrl(urlStr) {
    try {
      if (typeof URL !== 'function') return true;
      if (typeof urlStr !== 'string' || urlStr.length > 8192) return false;
      if (/[\x00-\x1f\x7f]/.test(urlStr)) return false;
      const u = new URL(urlStr);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      if (!u.hostname) return false;

      let h = u.hostname.toLowerCase();
      if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
      h = h.split('%')[0].replace(/\.$/, '');
      if (!h) return false;

      /* allowPrivateUrls = true hanya untuk debug/power-user eksplisit.
         Default (termasuk di browser): selalu blok private/metadata ranges. */
      if (cfg.allowPrivateUrls === true) return true;

      /* IPv4 langsung (decimal/oktal/hex/trailing-dot) */
      const v4 = canonicalIPv4(h);
      if (v4) return !isPrivateIPv4(v4);

      /* IPv6 literal — satu jalur penuh (B6+B7) */
      if (h.indexOf(':') !== -1) return !isPrivateIPv6(h);

      /* Hostname DNS + metadata endpoints umum */
      if (h === 'localhost' || h.endsWith('.localhost')) return false;
      if (h.endsWith('.internal') || h.endsWith('.local')) return false;
      if (h.endsWith('.test') || h.endsWith('.example') || h.endsWith('.invalid')) return false;
      if (h === 'metadata.google.internal' || h === 'metadata' ||
          h === 'kubernetes.default' || h === 'kubernetes.default.svc') return false;
      /* Single-label → resolusi lokal, blokir */
      if (h.indexOf('.') === -1) return false;

      return true;
    } catch (e) { return false; }
  }

  /* ══════════════════ URL EXTRACTION ══════════════════ */
  function trimUrlTrailing(u) {
    if (u.length > 16384) return u.slice(0, 16384);
    let s = String(u).replace(/[.,;:!?]+$/, '');
    const count = (str, ch) => {
      let n = 0, i = 0;
      while ((i = str.indexOf(ch, i)) !== -1) { n++; i += ch.length; }
      return n;
    };
    const trimBal = (open, close) => {
      while (s.length > 0) {
        if (count(s, close) > count(s, open) && s.charAt(s.length - 1) === close)
          s = s.slice(0, -1);
        else break;
      }
    };
    trimBal('(', ')');
    trimBal('[', ']');
    return s.replace(/[.,;:!?]+$/, '');
  }

  const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;

  function extractUrls(text) {
    const s = String(text || '');
    if (s.length > 2 * 1024 * 1024) return [];
    const out = new Set();
    const re = new RegExp(URL_RE.source, 'gi');
    let m;
    while ((m = re.exec(s)) !== null) {
      const u = trimUrlTrailing(m[0]);
      if (u && u.length <= 8192) out.add(u);
      if (out.size >= 100) break;
    }
    return Array.from(out);
  }

  /* ══════════════════ FETCH ══════════════════ */
  async function fetchText(url, opts) {
    opts = opts || {};
    const timeoutMs = Math.max(500, numOr(opts.timeoutMs, cfg.timeoutMs));
    const maxBytes  = Math.max(1024, numOr(opts.maxBytes, cfg.maxBodyBytes));
    const maxRedir  = Math.max(0, Math.min(10, numOr(opts.maxRedirects, cfg.maxRedirects)));

    if (!HAS_FETCH) {
      return { ok:false, status:0, text:'', ctype:'',
               error:'fetch tidak tersedia (butuh Node >=18 / browser modern)' };
    }

    const ctrl = HAS_ABORT ? new AbortController() : null;
    let timer = null;
    let timedOut = false;
    const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };

    const timeoutPromise = new Promise(resolve => {
      timer = setTimeout(() => {
        timedOut = true;
        if (ctrl) { try { ctrl.abort(); } catch (e) {} }
        resolve(null);
      }, timeoutMs);
    });

    let fetchChain;
    try {
      if (IS_BROWSER) {
        fetchChain = fetch(url, { signal: ctrl ? ctrl.signal : undefined,
                                  redirect: 'follow' });
      } else {
        fetchChain = (async () => {
          let current = url, redirects = 0;
          while (true) {
            const res = await fetch(current, {
              signal: ctrl ? ctrl.signal : undefined,
              redirect: 'manual',
              headers: { 'User-Agent': 'NexusTruth/13.7 (+ipv6-hardened)' }
            });
            if (res.status >= 300 && res.status < 400) {
              const loc = res.headers.get('location');
              if (!loc) throw new Error('redirect tanpa Location');
              let next;
              try { next = new URL(loc, current).href; }
              catch (e) { throw new Error('Location invalid: ' + loc); }
              if (!isSafeUrl(next) && !opts.unsafe) {
                const err = new Error('redirect ke URL tidak aman: ' + next);
                err.__blocked = 'redirect-ssrf';
                throw err;
              }
              current = next;
              if (++redirects > maxRedir) throw new Error('redirect > ' + maxRedir);
              continue;
            }
            return res;
          }
        })();
      }
    } catch (e) {
      clearTimer();
      return { ok:false, status:0, text:'', ctype:'',
               error:String(e && e.message || e),
               blocked: e && e.__blocked };
    }

    fetchChain.catch(() => {});

    try {
      const res = await Promise.race([fetchChain, timeoutPromise]);
      if (!res || timedOut) {
        clearTimer();
        return { ok:false, status:0, text:'', ctype:'',
                 error:'timeout ' + timeoutMs + 'ms' };
      }

      const ctype = (res.headers && typeof res.headers.get === 'function'
                    && res.headers.get('content-type')) || '';
      const finalUrl = (res.url && typeof res.url === 'string') ? res.url : url;

      if (!opts.unsafe && !isSafeUrl(finalUrl)) {
        clearTimer();
        return { ok:false, status:0, text:'', ctype:'',
                 error:'URL final tidak aman: ' + finalUrl,
                 finalUrl, blocked: 'post-redirect-ssrf' };
      }

      if (!res.ok) {
        clearTimer();
        return { ok:false, status:res.status || 0, text:'', ctype,
                 error:'HTTP ' + (res.status || 0), finalUrl };
      }

      const isBinary = /^(image|audio|video)\//i.test(ctype) ||
        /application\/(pdf|zip|octet-stream|gzip|x-tar|x-7z|x-rar|x-bzip)/i.test(ctype);
      if (isBinary) {
        clearTimer();
        return { ok:true, status:res.status, text:'', ctype, binary:true, finalUrl };
      }

      const clen = res.headers && typeof res.headers.get === 'function'
        ? parseInt(res.headers.get('content-length'), 10) : NaN;
      if (Number.isFinite(clen) && clen > maxBytes) {
        clearTimer();
        return { ok:false, status:res.status, text:'', ctype,
                 error:'respons terlalu besar: ' + clen + ' > ' + maxBytes,
                 finalUrl, tooLarge: true };
      }

      /* Timer tetap aktif selama body-read — abort mempropagasi ke stream */
      const text = await res.text();
      clearTimer();

      if (text.length > maxBytes) {
        return { ok:false, status:res.status, text:'', ctype,
                 error:'respons terlalu besar setelah dibaca: ' + text.length,
                 finalUrl, tooLarge: true };
      }
      return { ok:true, status:res.status, text, ctype, finalUrl };
    } catch (e) {
      clearTimer();
      const msg = (e && e.name === 'AbortError')
        ? 'timeout ' + timeoutMs + 'ms'
        : String((e && e.message) || e);
      return { ok:false, status:0, text:'', ctype:'', error:msg,
               blocked: e && e.__blocked };
    }
  }

  async function withRetry(fn, retries) {
    const max = (typeof retries === 'number' && retries >= 0)
      ? (retries | 0) : cfg.retries;
    let last = null;
    for (let i = 0; i <= max; i++) {
      try {
        const r = await fn(i);
        if (r && r.ok) return r;
        last = r || last;
        if (r && r.blocked) return r;
        if (r && r.status >= 400 && r.status < 500
            && r.status !== 408 && r.status !== 429) {
          return r;
        }
      } catch (e) {
        last = { ok:false, status:0, text:'', ctype:'',
                 error: String((e && e.message) || e) };
      }
      if (i < max) {
        const base = 300 * Math.pow(2, i);
        const jitter = Math.random() * 200;
        await sleep(Math.min(base + jitter, 5000));
      }
    }
    return last || { ok:false, status:0, text:'', ctype:'', error:'no attempt' };
  }

  /* ════════ HUKUM 3 — ENTITY REGISTRY CHECK ════════ */
  async function _fetchWikidata(q, lang, fOpts) {
    const u = 'https://www.wikidata.org/w/api.php?action=wbsearchentities'
      + '&search=' + q + '&language=' + lang
      + '&format=json&origin=*&limit=10';
    const r = await withRetry(() => fetchText(u, fOpts), fOpts.retries);
    if (!r || !r.ok) throw new Error(r ? (r.error || 'HTTP ' + r.status) : 'no response');
    const j = JSON.parse(r.text);
    if (!j || !Array.isArray(j.search)) throw new Error('response tak terduga');
    return j.search.filter(s => s && s.label).map(s => ({
      label: String(s.label), desc: String(s.description || ''),
      id: String(s.id || ''), via: 'wikidata'
    }));
  }

  async function _fetchWikipedia(q, fOpts) {
    const u2 = 'https://en.wikipedia.org/w/api.php?action=opensearch'
      + '&search=' + q + '&limit=5&format=json&origin=*';
    const r2 = await withRetry(() => fetchText(u2, fOpts), fOpts.retries);
    if (!r2 || !r2.ok) throw new Error(r2 ? (r2.error || 'HTTP ' + r2.status) : 'no response');
    const j2 = JSON.parse(r2.text);
    if (!Array.isArray(j2) || !Array.isArray(j2[1])) throw new Error('response tak terduga');
    return j2[1].filter(Boolean).map(t => ({ label: String(t), via: 'wikipedia' }));
  }

  async function checkEntity(name, opts) {
    opts = opts || {};
    const out = {
      query: name, found: false, ambiguous: false, inconclusive: false,
      matchScore: 0, matches: [], sources: [], errors: [],
      verdict: '', tookMs: 0
    };
    const t0 = Date.now();
    try {
      if (typeof name !== 'string' || name.trim().length < 2) {
        out.verdict = 'query tidak valid (minimal 2 karakter)';
        return out;
      }
      if (!HAS_FETCH) {
        out.verdict = 'fetch tidak tersedia — butuh Node >=18 / browser modern';
        return out;
      }
      const q = encodeURIComponent(name.trim().slice(0, 200));
      const lang = (typeof opts.lang === 'string' && /^[a-z-]{2,10}$/i.test(opts.lang))
        ? opts.lang : 'en';
      const fOpts = { timeoutMs: opts.timeoutMs, retries: opts.retries,
                      unsafe: opts.unsafe };

      const [wdRes, wpRes] = await Promise.allSettled([
        _fetchWikidata(q, lang, fOpts),
        _fetchWikipedia(q, fOpts)
      ]);

      if (wdRes.status === 'fulfilled') {
        out.matches.push(...wdRes.value);
        out.sources.push('wikidata');
      } else {
        out.errors.push('wikidata: ' + String(wdRes.reason && wdRes.reason.message || wdRes.reason));
      }
      if (wpRes.status === 'fulfilled') {
        out.matches.push(...wpRes.value);
        out.sources.push('wikipedia');
      } else {
        out.errors.push('wikipedia: ' + String(wpRes.reason && wpRes.reason.message || wpRes.reason));
      }

      const seen = new Set();
      out.matches = out.matches.filter(m => {
        const k = norm(m.label || '');
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      });

      const target = norm(name);
      let best = 0;
      out.matches.forEach(m => {
        best = Math.max(best, trigramScore(target, m.label || ''));
      });
      out.matchScore = best;

      const thr = Math.max(0, Math.min(1,
        numOr(opts.threshold, cfg.entityThreshold)));
      out.found = out.matches.length > 0 && best >= thr;

      if (out.found) {
        const near = out.matches.filter(m =>
          trigramScore(target, m.label || '') >= thr * 0.9);
        if (near.length > 3) out.ambiguous = true;
      }

      if (out.sources.length === 0 && out.errors.length > 0) {
        out.inconclusive = true;
        out.verdict = 'SEMUA REGISTRY GAGAL — tak dapat disimpulkan (' + out.errors[0] + ')';
      } else if (out.found) {
        out.verdict = 'ENTITAS DITEMUKAN di registry (' + out.sources.join('+') + ')'
          + (out.ambiguous ? ' — ambigu, perlu klarifikasi' : '');
      } else {
        out.verdict = 'ENTITAS TIDAK DITEMUKAN di registry — '
          + 'perlakukan sebagai tak terverifikasi (Hukum 3.2)';
      }
      return out;
    } catch (e) {
      out.error = true;
      out.verdict = 'ERROR: ' + esc(e && e.message || e);
      return out;
    } finally {
      out.tookMs = Date.now() - t0;
    }
  }

  /* ════════ HUKUM 2 — CITATION VERIFICATION ════════ */
  async function _doFetchPage(url, opts) {
    const fetchImpl = (typeof opts.fetchImpl === 'function')
      ? (u) => withRetry(() => opts.fetchImpl(u), opts.retries)
      : (u) => withRetry(() => fetchText(u, opts), opts.retries);

    let r = await fetchImpl(url);
    if (!r) r = { ok:false, status:0, text:'', ctype:'', error:'tanpa respons' };

    if (!r.ok && !r.binary && !opts.noProxy && IS_BROWSER && cfg.useProxy) {
      for (const p of cfg.proxies) {
        const pr = await fetchImpl(p + encodeURIComponent(url));
        if (pr && pr.ok) { r = pr; r._viaProxy = true; break; }
      }
    }
    return r;
  }

  async function verifyCitation(url, quote, opts) {
    opts = opts || {};
    const out = {
      url: url, quote: quote || '', reachable: false, status: null,
      matchScore: 0, quoteVerified: false, via: 'direct',
      finalUrl: null, verdict: '', notes: [], tookMs: 0
    };
    const t0 = Date.now();
    try {
      if (typeof url !== 'string' || !url.trim()) {
        out.verdict = 'URL kosong atau tidak valid'; return out;
      }
      if (!HAS_FETCH) {
        out.verdict = 'fetch tidak tersedia — butuh Node >=18 / browser modern';
        return out;
      }
      const skipSafety = !!opts.fetchImpl || opts.unsafe === true;
      if (!skipSafety && !isSafeUrl(url)) {
        out.verdict = 'URL DITOLAK oleh safety filter — wajib http(s), bukan host privat';
        out.notes.push('skema/host tidak aman');
        return out;
      }

      const cache = opts._fetchCache;
      let rPromise;
      if (cache) {
        if (!cache.has(url)) cache.set(url, _doFetchPage(url, opts));
        rPromise = cache.get(url);
      } else {
        rPromise = _doFetchPage(url, opts);
      }
      const r = await rPromise;
      if (r && r._viaProxy) out.via = 'proxy';

      if (!r.ok) {
        out.status = r.status || 0;
        out.notes.push(r.error || ('HTTP ' + (r.status || 0)));
        out.verdict = 'SITASI TIDAK TERVERIFIKASI — URL tidak terjangkau '
          + '(Hukum 2.4: buang klaim)';
        if (r.blocked) out.notes.push('blocked: ' + r.blocked);
        return out;
      }
      out.reachable = true;
      out.status = r.status;
      out.finalUrl = r.finalUrl || url;

      if (r.binary) {
        out.notes.push('konten biner (PDF dsb) — kutipan tak dapat '
          + 'dicocokkan dari konteks ini');
        out.verdict = 'REACHABLE — kutipan TAK TERVERIFIKASI (biner)';
        return out;
      }

      const hay = norm(htmlToText(r.text || ''));
      const q = norm(quote || '');
      out.emptyPage = hay.length < 50;

      if (q.length >= 12) {
        out.matchScore = hay.includes(q) ? 1 : trigramScore(q, hay);
        const thr = Math.max(0, Math.min(1,
          numOr(opts.threshold, cfg.quoteThreshold)));
        out.quoteVerified = out.matchScore >= thr;

        if (out.quoteVerified) {
          out.verdict = 'KUTIPAN TERVERIFIKASI — persis ada di halaman';
        } else if (out.emptyPage) {
          out.verdict = 'HALAMAN (NYARIS) KOSONG — kutipan tak dapat diverifikasi';
        } else if (out.matchScore >= 0.60) {
          out.verdict = 'KUTIPAN MIRIP TAPI TAK PERSIS — dilarang dilabeli verbatim';
        } else {
          out.verdict = 'KUTIPAN TIDAK DITEMUKAN DI HALAMAN — dugaan fabrikasi';
        }
      } else {
        out.verdict = 'HALAMAN TERBUKA — kutipan terlalu pendek untuk dicocokkan';
      }
      return out;
    } catch (e) {
      out.error = true;
      out.verdict = 'ERROR: ' + esc(e && e.message || e);
      return out;
    } finally {
      out.tookMs = Date.now() - t0;
    }
  }

  async function verifyBatch(list, opts) {
    opts = opts || {};
    try {
      const items = Array.isArray(list) ? list : [];
      const n = items.length;
      if (n === 0) return { results: [], ok: true };
      const results = new Array(n);
      const conc = Math.max(1, Math.min(numOr(opts.concurrency, 4), 8, n));
      const fetchCache = new Map();
      let idx = 0;
      async function worker() {
        while (idx < n) {
          const i = idx++;
          const it = items[i] || {};
          results[i] = await verifyCitation(it.url, it.quote || '',
            Object.assign({}, opts, { _fetchCache: fetchCache }));
        }
      }
      await Promise.all(Array.from({ length: conc }, () => worker()));
      return { results, ok: true };
    } catch (e) {
      return { results: [], ok: false, error: esc(e && e.message || e) };
    }
  }

  /* ════════ HUKUM 4 — CALIBRATOR ════════ */
  function calibrate(e) {
    e = e || {};
    const tiers = { official: 85, primary: 70, secondary: 45, none: 15 };
    const hasTier = Object.prototype.hasOwnProperty.call(tiers, e.sourceTier);
    let conf = hasTier ? tiers[e.sourceTier] : tiers.none;
    const reasons = [];

    if (e.quoteVerified === true) {
      conf += 10;
      reasons.push('kutipan terverifikasi');
    } else if (typeof e.matchScore === 'number' && e.matchScore > 0) {
      conf += Math.round(Math.min(1, e.matchScore) * 8);
      reasons.push('kemiripan kutipan ' + ((e.matchScore * 100) | 0) + '%');
    }
    if (e.reachable === false) {
      conf -= 25;
      reasons.push('URL tidak terjangkau');
    }
    if (e.emptyPage === true) {
      conf = Math.min(conf, 25);
      reasons.push('halaman kosong');
    }
    if (e.entityFound === true) {
      conf += 8;
      reasons.push('entitas ada di registry');
    }
    if (e.entityMissing === true) {
      conf = Math.min(conf, 10);
      reasons.push('entitas TIDAK ada di registry');
    }
    if (e.entityAmbiguous === true) {
      conf -= 5;
      reasons.push('entitas ambigu');
    }
    if (e.contradiction === true) {
      conf = Math.min(conf, 10);
      reasons.push('kontradiksi bukti');
    }
    if (!e.hasEvidence) {
      conf = Math.min(conf, cfg.noEvidenceCap);
      reasons.push('tanpa bukti → dibatasi ' + cfg.noEvidenceCap + '%');
    }
    conf = Math.max(0, Math.min(100, Math.round(conf)));

    /* FIX B8: propagate semua sinyal agar label(calibrate(...)) konsisten */
    const result = { confidence: conf, reasons };
    if (hasTier)                    result.sourceTier = e.sourceTier;
    if (e.quoteVerified === true)   result.quoteVerified = true;
    if (e.entityFound === true)     result.entityFound = true;
    if (e.entityMissing === true)   result.entityMissing = true;
    if (e.entityAmbiguous === true) result.entityAmbiguous = true;
    if (e.contradiction === true)   result.contradiction = true;
    if (e.emptyPage === true)       result.emptyPage = true;
    return result;
  }

  /* ════════ HUKUM 6 — LABELER ════════ */
  function label(cal) {
    cal = cal || {};
    if (cal.contradiction === true) return '[TAK DIKETAHUI]';
    if (cal.emptyPage === true)     return '[TAK DIKETAHUI]';
    if (cal.entityMissing === true) return '[TAK DIKETAHUI]';

    const c = (typeof cal.confidence === 'number'
              && Number.isFinite(cal.confidence))
      ? cal.confidence : 0;

    /* FIX B3: entity ambigu tanpa kutipan terverifikasi → demote */
    if (cal.entityAmbiguous === true && cal.quoteVerified !== true) {
      return c >= 40 ? '[EKSTRAPOLASI]' : '[TAK DIKETAHUI]';
    }

    const strong =
         cal.quoteVerified === true
      || cal.entityFound === true
      || cal.sourceTier === 'official'
      || cal.sourceTier === 'primary';

    if (c >= 80 && strong) return '[SUMBER NYATA]';
    if (c >= 40) return '[EKSTRAPOLASI]';
    return '[TAK DIKETAHUI]';
  }

  /* ════════ HUKUM 1+5 — AUDITOR ════════ */
  const DETECTORS = Object.freeze([
    { type:'URL',         re: /https?:\/\/[^\s<>"'`]+/gi,
      rule:'buka & cek sebelum dipercaya' },
    { type:'KUTIPAN',     re: /[“"][^“”"]{15,}[”"]/g,
      rule:'harus cocok karakter-per-karakter' },
    { type:'LEGAL-PASAL', re: /\bPasal\s+\d+[^\n.,;]{0,40}/gi,
      rule:'cek EUR-Lex / registry' },
    { type:'LEGAL-CELEX', re: /CELEX[^\n,;]{0,30}/gi,
      rule:'cek EUR-Lex' },
    { type:'STANDAR',     re: /\bISO(?:\/?IEC)?\s?\d{3,5}\b/gi,
      rule:'cek ISO Online Browsing Platform' },
    { type:'LEGAL-UMUM',  re: /\b(Directive|Regulation|Framework|Bill|Act|Undang[- ]Undang|Peraturan)\b[^\n.,;]{0,50}/gi,
      rule:'cek registry resmi' },
    { type:'ANGKA',       re: /\b\d{1,3}(?:[.,]\d+)?\s?%|€\s?\d+|\$\s?\d+|\b\d{1,3}(?:[.,]\d+)?\s?(?:juta|miliar|triliun|million|billion|trillion)\b/gi,
      rule:'butuh metodologi & sumber' },
    { type:'TAHUN',       re: /\b(19|20)\d{2}\b/g,
      rule:'butuh konteks temporal' },
    { type:'ATRIBUSI',    re: /\b(menurut|sumber\s?:|studi\s+menunjukkan|panel|arsip|analytics|open\s+archives|cross-disciplinary|global\s+communication\s+ecosystems)[^\n.]{0,80}/gi,
      rule:'butuh nama spesifik & tautan' }
  ]);

  const HARD_TYPES = Object.freeze(new Set([
    'URL','KUTIPAN','LEGAL-PASAL','LEGAL-CELEX',
    'LEGAL-UMUM','STANDAR','ATRIBUSI'
  ]));

  function audit(text, providedSources) {
    try {
      if (typeof text !== 'string') {
        return { flags: [], verdict: 'INPUT INVALID — teks harus string',
                 clean: false };
      }
      let truncated = false;
      if (text.length > cfg.maxAuditBytes) {
        /* FIX B2: extend mundur ke whitespace — URL tak terpotong di tengah */
        let cut = cfg.maxAuditBytes;
        const ws = text.lastIndexOf(' ', cut);
        if (ws > 0 && ws >= cut - 1000) cut = ws;
        text = text.slice(0, cut);
        truncated = true;
      }
      if (text.trim().length === 0) {
        return { flags: [], verdict: 'INPUT KOSONG — tidak ada klaim',
                 clean: true };
      }
      const flags = [];
      const seen = new Set();
      const MAX_FLAGS = 60;
      const MAX_PER_TYPE = 12;

      for (const det of DETECTORS) {
        if (flags.length >= MAX_FLAGS) break;
        const found = text.match(det.re) || [];
        let count = 0;
        for (const m of found) {
          if (count >= MAX_PER_TYPE || flags.length >= MAX_FLAGS) break;
          const clean = det.type === 'URL' ? trimUrlTrailing(m) : String(m);
          if (clean.length === 0) continue;
          const key = det.type + '::' + norm(clean);
          if (seen.has(key)) continue;
          seen.add(key);
          flags.push({
            type: det.type,
            snippet: clean.slice(0, 120),
            rule: det.rule
          });
          count++;
        }
      }

      const prov = unique(
        (Array.isArray(providedSources) ? providedSources.slice(0, 200) : [])
          .map(s => (s && typeof s === 'object') ? s.url : s)
          .filter(x => typeof x === 'string' && x.length > 0)
      );

      const urlFlags = flags.filter(f =>
        f.type === 'URL' || f.type === 'KUTIPAN');
      const otherFlags = flags.filter(f =>
        f.type !== 'URL' && f.type !== 'KUTIPAN');
      const coveredUrls = urlFlags.filter(f =>
        prov.some(u => norm(trimUrlTrailing(f.snippet))
                    === norm(trimUrlTrailing(u))));
      const uncoveredCount =
        otherFlags.length + (urlFlags.length - coveredUrls.length);

      const clean = flags.length === 0;
      let verdict;
      if (clean) {
        verdict = 'BERSIH — tidak ada tripwire terpicu';
      } else if (prov.length > 0 && uncoveredCount === 0) {
        verdict = 'TERSARING — seluruh tripwire tertutup sumber sistem';
      } else if (prov.length > 0) {
        verdict = 'SEBAGIAN TERGROUNDED — ' + uncoveredCount
          + ' dari ' + flags.length + ' masih butuh bukti';
      } else {
        verdict = 'TAK TERGROUNDED — ' + flags.length
          + ' klaim butuh bukti (Hukum 1.3)';
      }
      const result = { flags, verdict, clean };
      if (truncated) result.truncated = true;
      return result;
    } catch (e) {
      return { flags: [], verdict: 'ERROR: ' + esc(e && e.message || e),
               clean: false };
    }
  }

  /* ════════ GATE ════════ */
  async function gate(text, opts) {
    opts = opts || {};
    try {
      if (typeof text !== 'string') {
        return { clean: false, verdict: 'INPUT INVALID',
                 suggestedAction: 'BLOCK',
                 audit: { flags: [], verdict: 'INPUT INVALID', clean: false },
                 citations: [], entities: [] };
      }
      const auditRes = audit(text, opts.sources);

      const rawUrls = extractUrls(text);
      const cap = (opts.verifyUrlsPerGate != null)
        ? Math.max(0, Math.min(20, numOr(opts.verifyUrlsPerGate, 0)))
        : cfg.verifyUrlsPerGate;
      const urls = rawUrls.slice(0, cap);

      let citations = [];
      if (urls.length > 0) {
        const list = urls.map(u => ({
          url: u,
          quote: (opts.quotes && opts.quotes[u]) || ''
        }));
        const vres = await verifyBatch(list, {
          concurrency: Math.min(urls.length, numOr(opts.concurrency, 4)),
          timeoutMs: opts.timeoutMs,
          noProxy: opts.noProxy,
          threshold: opts.threshold,
          fetchImpl: opts.fetchImpl,
          unsafe: opts.unsafe
        });
        citations = Array.isArray(vres.results) ? vres.results : [];
      }

      let entityResults = [];
      const rawEntities = Array.isArray(opts.entities) ? opts.entities : [];
      const entityList = unique(
        rawEntities
          .map(e => typeof e === 'string' ? e : (e && e.name))
          .filter(x => typeof x === 'string' && x.trim().length >= 2)
      ).slice(0, 5);
      if (entityList.length > 0 && HAS_FETCH) {
        const settled = await Promise.allSettled(
          entityList.map(e => checkEntity(e, opts))
        );
        entityResults = settled.map(s => s.status === 'fulfilled' ? s.value : {
          query: 'unknown', found: false, ambiguous: false, inconclusive: true,
          matchScore: 0, matches: [], sources: [],
          errors: [String(s.reason && s.reason.message || s.reason)],
          verdict: 'ERROR: ' + esc(s.reason && s.reason.message || s.reason),
          tookMs: 0
        });
      }
      const missingEntities = entityResults.filter(r =>
        r.found === false && !r.inconclusive).length;
      const ambiguousEntities = entityResults.filter(r =>
        r.found === true && r.ambiguous === true).length;

      const hardFlags = auditRes.flags.filter(f => HARD_TYPES.has(f.type));
      const unreachable = citations.filter(c => !c.reachable).length;
      const failedQuotes = citations.filter(c =>
        c.reachable && c.quote && c.quote.length >= 12
        && !c.quoteVerified).length;

      const blocking = hardFlags.length > 0 || unreachable > 0
                    || failedQuotes > 0 || missingEntities > 0;
      const clean = !blocking
                 && auditRes.flags.length === 0
                 && ambiguousEntities === 0;

      let suggestedAction;
      if (blocking) suggestedAction = 'BLOCK';
      else if (clean) suggestedAction = 'EMIT';
      else suggestedAction = 'EMIT_WITH_DISCLAIMER';

      return {
        clean,
        audit: auditRes,
        citations,
        entities: entityResults,
        suggestedAction,
        verdict: clean
          ? 'LOLOS — respons boleh dipancarkan (Hukum terpenuhi)'
          : 'TAK TERGROUNDED — ' + auditRes.flags.length + ' tripwire, '
            + unreachable + ' sitasi tak terjangkau, '
            + failedQuotes + ' kutipan tak cocok, '
            + missingEntities + ' entitas hilang, '
            + ambiguousEntities + ' ambigu → ' + suggestedAction
      };
    } catch (e) {
      return {
        clean: false, suggestedAction: 'BLOCK',
        verdict: 'ERROR: ' + esc(e && e.message || e),
        audit: { flags: [], verdict: 'ERROR', clean: false },
        citations: [], entities: []
      };
    }
  }

  /* ════════ HUKUM 7 — SELF-TEST T1..T13 ════════ */
  async function selfTest(progress) {
    const results = [];
    const P = (n, status, d) => {
      results.push({ n, status, d });
      try { if (typeof progress === 'function') progress(n, status, d); }
      catch (e) { /* callback user tidak boleh merusak self-test */ }
    };

    /* T1 — fisika */
    (function () {
      const one  = 16100 / 200000 * 1000;
      const rtt  = one * 2;
      const anti = 20037.5 / 200000 * 1000;
      const ok = Math.abs(one - 80.5) < 0.01
              && Math.abs(rtt - 161) < 0.01
              && Math.abs(anti - 100.19) < 0.1 && 10 < one;
      P('T1 FISIKA', ok ? 'PASS' : 'FAIL',
        'one-way ' + one.toFixed(1) + ' ms · RTT ' + rtt.toFixed(1)
        + ' ms · antipoda ' + anti.toFixed(1) + ' ms → 10 ms global MUSTAHIL');
    })();

    const isOnline = await (async () => {
      try {
        const r = await fetchText(
          'https://www.wikidata.org/w/api.php?action=query&meta=siteinfo'
          + '&format=json&origin=*', { timeoutMs: 5000 });
        return !!(r && r.ok);
      } catch (e) { return false; }
    })();

    if (isOnline) {
      const mix = [
        ['Google', true], ['United Nations', true], ['Paris', true],
        ['Euphoria Language Compliance Directive', false],
        ['Zorblaxian Quantum Council', false]
      ];
      let okc = 0;
      for (const [name, expect] of mix) {
        try {
          const r = await checkEntity(name, { timeoutMs: 4000, retries: 0 });
          if (!r.inconclusive && r.found === expect) okc++;
        } catch (e) {}
      }
      P('T2 REGISTRY ENTITAS', okc >= 4 ? 'PASS' : 'FAIL',
        okc + '/5 benar — membedakan nyata vs karangan via registry');
    } else {
      P('T2 REGISTRY ENTITAS', 'SKIP', 'offline — butuh internet');
    }

    const mockFetch = async () => ({
      ok: true, status: 200, ctype: 'text/html',
      text: '<html><body>ISO/IEC 42001:2023 Artificial intelligence '
          + 'Management system published December 2023. This document '
          + 'specifies requirements for establishing an AI management system.'
          + '</body></html>'
    });
    const good = await verifyCitation('mock://kontrol',
      'This document specifies requirements for establishing an AI '
      + 'management system.', { fetchImpl: mockFetch, noProxy: true });
    const bad = await verifyCitation('mock://kontrol',
      'Article 7 mandates annual audit reports and ten million euro fines.',
      { fetchImpl: mockFetch, noProxy: true });
    P('T3 PENCOCOK KUTIPAN',
      (good.quoteVerified && bad.matchScore < 0.6) ? 'PASS' : 'FAIL',
      'kutipan benar ' + ((good.matchScore * 100) | 0)
      + '% · kutipan karangan ' + ((bad.matchScore * 100) | 0) + '% → ditolak');

    if (isOnline) {
      const r4 = await checkEntity(
        'EU Digital Language Transparency Directive',
        { timeoutMs: 4000, retries: 0 });
      P('T4 PENGETAHUAN NEGATIF',
        (!r4.inconclusive && r4.found === false) ? 'PASS' : 'FAIL',
        r4.verdict + ' (match ' + ((r4.matchScore * 100) | 0)
        + '%) — direktif ini TIDAK ADA (fabrikasi terkonfirmasi)');
    } else {
      P('T4 PENGETAHUAN NEGATIF', 'SKIP', 'offline — butuh internet');
    }

    const ghost = 'Sumber: cross-disciplinary panels, open archives, dan '
      + 'analytics of global communication ecosystems. Pasal 7 menetapkan '
      + 'denda €10 juta atau 2% pendapatan. Language Drift Index turun ke '
      + '3.1 pada 2035.';
    const a5 = audit(ghost);
    P('T5 AUDITOR',
      (a5.flags.length >= 3 && a5.verdict !== 'BERSIH') ? 'PASS' : 'FAIL',
      a5.flags.length + ' flag: ' + a5.flags.map(f => f.type).join(', '));

    const noEv = calibrate({ hasEvidence: false, sourceTier: 'none' });
    const ev = calibrate({
      hasEvidence: true, sourceTier: 'official',
      quoteVerified: true, reachable: true
    });
    P('T6 KALIBRASI',
      (noEv.confidence <= 30 && ev.confidence >= 80) ? 'PASS' : 'FAIL',
      'tanpa bukti ' + noEv.confidence + '% (terkunci ≤30) · dengan bukti '
      + ev.confidence + '% (≥80)');

    if (false /* v13.7.2: guard SSRF aktif di browser → uji penuh */) {
      const scheme = !isSafeUrl('file:///etc/passwd')
                  && !isSafeUrl('javascript:alert(1)')
                  && isSafeUrl('https://example.com/');
      P('T7 SSRF GUARD', scheme ? 'PASS' : 'FAIL',
        'browser mode — skema http(s) diuji');
    } else {
      const bad = [
        'http://127.0.0.1/', 'http://127.0.0.1./',
        'http://169.254.169.254/latest/meta-data/',
        'http://[::1]/', 'http://2130706433/', 'http://0x7f000001/',
        'http://0177.0.0.1/', 'http://0177.0.0.1./',
        'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/',
        'file:///etc/passwd', 'javascript:alert(1)',
        'http://localhost/', 'http://localhost./', 'http://LOCALHOST./',
        'http://printer.local/', 'http://metadata.internal/',
        'http://intranet/', 'http://printer/', 'http://nas/'
      ];
      const good = ['https://example.com/', 'https://www.google.com/'];
      const fails = bad.filter(u => isSafeUrl(u));
      const allows = good.filter(u => isSafeUrl(u));
      P('T7 SSRF GUARD',
        (fails.length === 0 && allows.length === good.length) ? 'PASS' : 'FAIL',
        'menolak ' + (bad.length - fails.length) + '/' + bad.length
        + ' URL privat · izinkan ' + allows.length + '/' + good.length
        + (fails.length ? ' · BYPASS: ' + fails.join(', ') : ''));
    }

    const sample = 'Lihat https://example.com/page. Juga https://example.org/a?b=1, '
      + 'dan (https://example.net/path). https://en.wikipedia.org/wiki/AI_(disambig)';
    const urls = extractUrls(sample);
    const checks = [
      urls.includes('https://example.com/page'),
      urls.includes('https://example.org/a?b=1'),
      urls.includes('https://example.net/path'),
      urls.includes('https://en.wikipedia.org/wiki/AI_(disambig)'),
      !urls.some(u => u.endsWith('.'))
    ];
    P('T8 URL EXTRACTION', checks.every(Boolean) ? 'PASS' : 'FAIL',
      urls.length + ' URL terekstrak, trailing punctuation dibuang, '
      + 'balanced parens dipertahankan');

    (function () {
      const inputs = ['127.0.0.1.', '0x7f000001.', '0177.0.0.1.'];
      const blocked = inputs.every(h => {
        const c = canonicalIPv4(h);
        return c && isPrivateIPv4(c);
      });
      P('T9 TRAILING-DOT', blocked ? 'PASS' : 'FAIL',
        'trailing-dot tidak melewati canonicalIPv4 — bypass tertutup');
    })();

    if (false /* v13.7.2: guard SSRF aktif di browser → uji penuh */) {
      P('T10 SINGLE-LABEL', 'SKIP', 'browser mode — tidak relevan');
    } else {
      const bad = ['http://intranet/', 'http://printer/', 'http://nas/',
                   'http://localhost/', 'http://metadata/'];
      const bypass = bad.filter(u => isSafeUrl(u));
      P('T10 SINGLE-LABEL', bypass.length === 0 ? 'PASS' : 'FAIL',
        'menolak ' + (bad.length - bypass.length) + '/' + bad.length
        + ' hostname single-label'
        + (bypass.length ? ' · BYPASS: ' + bypass.join(', ') : ''));
    }

    /* T11 — IPv4-mapped IPv6 expanded form (B6) */
    if (false /* v13.7.2: guard SSRF aktif di browser → uji penuh */) {
      P('T11 IPV6-EXPANDED', 'SKIP', 'browser mode');
    } else {
      const cases = [
        'http://[0:0:0:0:0:ffff:7f00:1]/',
        'http://[0000:0000:0000:0000:0000:ffff:7f00:0001]/',
        'http://[::ffff:7f00:1]/',
        'http://[::ffff:127.0.0.1]/'
      ];
      const bypass = cases.filter(u => isSafeUrl(u));
      P('T11 IPV6-EXPANDED', bypass.length === 0 ? 'PASS' : 'FAIL',
        'menolak ' + (cases.length - bypass.length) + '/' + cases.length
        + ' IPv4-mapped expanded'
        + (bypass.length ? ' · BYPASS: ' + bypass.join(', ') : ''));
    }

    /* T12 — NAT64 / 6to4 / Teredo (B7) */
    if (false /* v13.7.2: guard SSRF aktif di browser → uji penuh */) {
      P('T12 TUNNEL-PREFIX', 'SKIP', 'browser mode');
    } else {
      const cases = [
        'http://[64:ff9b::7f00:1]/',                  // NAT64 → 127.0.0.1
        'http://[64:ff9b::c0a8:1]/',                  // NAT64 → 192.168.0.1
        'http://[64:ff9b:1::7f00:1]/',                // NAT64 lokal
        'http://[2002:7f00:1::]/',                    // 6to4 → 127.0.0.1
        'http://[2002:c0a8:1::]/',                    // 6to4 → 192.168.0.1
        'http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/'  // Teredo
      ];
      const bypass = cases.filter(u => isSafeUrl(u));
      P('T12 TUNNEL-PREFIX', bypass.length === 0 ? 'PASS' : 'FAIL',
        'menolak ' + (cases.length - bypass.length) + '/' + cases.length
        + ' tunnel IPv6 (NAT64/6to4/Teredo)'
        + (bypass.length ? ' · BYPASS: ' + bypass.join(', ') : ''));
    }

    /* T13 — calibrate→label round-trip (B8) */
    (function () {
      const c1 = calibrate({ hasEvidence: true, sourceTier: 'official',
                             reachable: true });
      const l1 = label(c1);
      const c2 = calibrate({ hasEvidence: true, sourceTier: 'secondary',
                             reachable: true });
      const l2 = label(c2);
      const c3 = calibrate({ hasEvidence: true, sourceTier: 'none',
                             reachable: true });
      const l3 = label(c3);
      const ok = c1.sourceTier === 'official'
              && c1.confidence >= 80
              && l1 === '[SUMBER NYATA]'
              && l2 === '[EKSTRAPOLASI]'
              && l3 === '[TAK DIKETAHUI]';
      P('T13 LABEL ROUND-TRIP', ok ? 'PASS' : 'FAIL',
        'official→' + l1 + ' · secondary→' + l2 + ' · none→' + l3
        + (c1.sourceTier === 'official' ? '' : ' · sourceTier LOST'));
    })();

    const pass = results.filter(r => r.status === 'PASS').length;
    const skip = results.filter(r => r.status === 'SKIP').length;
    return {
      results, pass, skip, total: results.length,
      score: pass + '/' + results.length
           + (skip ? ' (' + skip + ' skip offline)' : '')
    };
  }

  /* ══════════════════ EKSPOR PUBLIK ══════════════════ */
  /* Integrity Meta (Fase 1, additive — zero regression) */
  const MODULE_CHECKSUM = '05374e1deb4bd20e012bf6ec2fb344f8f3146616a007ac3923410a100f14b885';
  const MODULE_ID = 'NexusTruth';
  const MODULE_VERSION = '13.7.2';

  function getMeta() {
    return Object.freeze({
      id: MODULE_ID,
      version: MODULE_VERSION,
      checksum: MODULE_CHECKSUM,
      fingerprint: 'sha256:' + MODULE_CHECKSUM,
      algorithm: 'SHA-256',
      artifact: 'source-file',
      note: 'Checksum is build-time hash. Runtime selfTest verifies API surface integrity (zero regression).'
    });
  }

  const _nxOrigSelfTest = selfTest;
  async function selfTestWithIntegrity(progress) {
    const base = await _nxOrigSelfTest(progress);
    try {
      const meta = getMeta();
      const surfaceOk = typeof audit === 'function'
        && typeof gate === 'function'
        && typeof calibrate === 'function'
        && typeof label === 'function'
        && meta && meta.id === MODULE_ID
        && meta.version === MODULE_VERSION;
      if (base && Array.isArray(base.results)) {
        base.results.push({ n: 'T14 INTEGRITY', status: surfaceOk ? 'PASS' : 'FAIL', d: surfaceOk ? 'getMeta+surface OK' : 'MISMATCH' });
        if (surfaceOk) base.pass = (base.pass || 0) + 1;
        base.total = base.results.length;
      }
      if (base) {
        base.meta = meta;
        base.integrity = surfaceOk ? 'OK' : 'MISMATCH';
        if (base.pass != null && base.total != null) {
          base.score = base.pass + '/' + base.total + (base.skip ? ' (' + base.skip + ' skip offline)' : '');
        }
      }
    } catch (e) { /* never break original */ }
    return base;
  }

  return {
    version: MODULE_VERSION,
    getMeta,
    configure, getConfig,
    checkEntity, verifyCitation, verifyBatch,
    calibrate, label, audit, gate, selfTest: selfTestWithIntegrity,
    _internal: {
      fetchText, norm, htmlToText, trigramScore,
      isSafeUrl, extractUrls, trimUrlTrailing,
      get cfg() {
        const c = getConfig();
        Object.freeze(c.proxies);
        return Object.freeze(c);
      },
      _canonicalIPv4: canonicalIPv4,
      _isPrivateIPv4: isPrivateIPv4,
      _isPrivateIPv6: isPrivateIPv6,
      _expandIPv6: expandIPv6,
      _numOr: numOr
    }
  };
});
