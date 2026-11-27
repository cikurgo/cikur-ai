
/*! ═══════════════════════════════════════════════════════════════════
 *  NEXUS INTEGRITY v1.0.0 — Verifikasi integritas modul (aditif, non-mutating)
 *  ─────────────────────────────────────────────────────────────────
 *  Implementasi CEKLIS PERBAIKAN INTEGRITAS MODUL (A–G). Prinsip:
 *   • TIDAK mengubah / membekukan / menambah properti pada objek modul lain
 *     (agar sidik basis AKU & perilaku lama tidak bergeser). Semua data
 *     disimpan di sini; modul lain hanya DIBACA.
 *   • Keputusan integritas HANYA dari fingerprint/checksum — bukan dari string
 *     versi, teks screenshot, atau satu self-test lulus (F2).
 *   • Artefak yang di-hash (A2, realistis di browser):
 *       1) script-text : textContent <script id="…"> yang benar-benar termuat
 *       2) file        : byte file <script src="…"> (butuh http/https; file:// → SKIP)
 *       3) api-spec    : spek API serializable (nama+tipe prop, hash sumber fungsi)
 *     Algoritma: SHA-256 (lewat NexusLBC.sha256Hex bila lolos vektor 'abc',
 *     jika tidak: implementasi internal).
 *   • Status checksum: OK | MISMATCH | SKIP. Status modul:
 *       MISSING | MISMATCH | DRIFT | LOADED | OK
 *     "unknown" pada versi = modul tidak mendeklarasikan versi (bukan galat).
 *   • enforce (D): 'soft' (default; hanya MISSING yang memblokir panggilan),
 *     'standard' (+MISMATCH), 'strict' (+DRIFT). Default soft = nol regresi.
 *
 *  BATASAN JUJUR: ini lapisan integritas di dalam satu halaman. Baseline TOFU
 *  & manifest hidup di halaman yang sama — penyerang yang sudah menguasai
 *  halaman penuh tidak dihentikan. Tanda tangan (Schnorr/BIP-340) tanpa
 *  kunci publik yang di-pin di luar halaman = "integrity only", BUKAN proof of origin.
 * ═══════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root && !root.NexusIntegrity) {
    try { Object.defineProperty(root, 'NexusIntegrity', { value: api, enumerable: true, configurable: false, writable: false }); }
    catch (e) { try { root.NexusIntegrity = api; } catch (e2) {} }
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  var VERSION = '1.0.0';
  var ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  var GENESIS = new Array(65).join('0');
  var AUDIT_MAX = 500, DETAIL_MAX = 160, FLUSH_MS = 2500, WATCH_MS = 60000, BOOT_DELAY = 14000;
  var DB_NAME = 'nx-integrity-audit';

  var LEGEND = {
    MISSING: 'modul tidak termuat',
    MISMATCH: 'termuat tetapi checksum artefak tidak cocok dengan pembanding',
    DRIFT: 'termuat; spek API berubah sejak baseline (mis. patch runtime)',
    LOADED: 'termuat; bukti artefak belum cukup (checksum SKIP / baseline belum ada)',
    OK: 'termuat, checksum cocok, spek API stabil',
    unknown: 'modul tidak mendeklarasikan versi — keputusan integritas tetap dari fingerprint',
    /* Tier kesiapan operasional (bukan integritas load) — hasil audit dewan */
    LIVE: 'kapabilitas nyata di klien (bukan mock); siap dipakai sesuai lingkupnya',
    PARTIAL: 'berfungsi sebagian; belum memenuhi kriteria produksi penuh',
    FRAMEWORK: 'kerangka/API ada; belum ada jalur data hidup / uji keamanan / node nyata'
  };

  /* ───────────── SHA-256 internal (sinkron) ───────────── */
  var K = new Uint32Array(64), H0 = new Uint32Array(8);
  (function () {
    var primes = [], n, i;
    for (n = 2; primes.length < 64; n++) { var ok = true; for (i = 0; i < primes.length; i++) if (n % primes[i] === 0) { ok = false; break; } if (ok) primes.push(n); }
    function frac(v) { return Math.floor((v - Math.floor(v)) * 4294967296); }
    for (i = 0; i < 64; i++) { K[i] = frac(Math.cbrt(primes[i])); if (i < 8) H0[i] = frac(Math.sqrt(primes[i])); }
  })();
  var ENC = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
  function utf8(s) {
    if (ENC) return ENC.encode(s);
    var b = unescape(encodeURIComponent(s)), u = new Uint8Array(b.length);
    for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
    return u;
  }
  function sha256Bytes(msg) {
    var len = msg.length, total = ((len + 9 + 63) >> 6) << 6, buf = new Uint8Array(total);
    buf.set(msg); buf[len] = 0x80;
    var dv = new DataView(buf.buffer);
    dv.setUint32(total - 8, Math.floor(len / 0x20000000), false);
    dv.setUint32(total - 4, (len << 3) >>> 0, false);
    var h = Uint32Array.from(H0), w = new Uint32Array(64);
    function rr(x, n) { return (x >>> n) | (x << (32 - n)); }
    for (var off = 0; off < total; off += 64) {
      var i;
      for (i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
      for (i = 16; i < 64; i++) {
        var s0 = rr(w[i - 15], 7) ^ rr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        var s1 = rr(w[i - 2], 17) ^ rr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
      for (i = 0; i < 64; i++) {
        var t1 = (hh + (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
        var t2 = ((rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
    }
    var out = '';
    for (var j = 0; j < 8; j++) out += ('00000000' + (h[j] >>> 0).toString(16)).slice(-8);
    return out;
  }

  var lbcRef = null, lbcOk = false;
  function lbc() {
    var L = root.NexusLBC;
    if (L !== lbcRef) {
      lbcRef = L; lbcOk = false;
      try { lbcOk = !!(L && typeof L.sha256Hex === 'function' && L.sha256Hex('abc') === ABC); } catch (e) { lbcOk = false; }
    }
    return lbcOk ? L : null;
  }
  /* satu fungsi hash bersama (A2): string (UTF-8) atau Uint8Array → hex */
  function sha256Hex(x) {
    var bytes = typeof x === 'string' ? utf8(x) : (x instanceof Uint8Array ? x : utf8(String(x)));
    var L = lbc();
    if (L) { try { var r = L.sha256Hex(bytes); if (typeof r === 'string' && r.length === 64) return r; } catch (e) {} }
    return sha256Bytes(bytes);
  }
  function hashImpl() { return lbc() ? 'NexusLBC.sha256Hex' : 'internal-sha256'; }

  function canon(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + canon(v[k]); }).join(',') + '}';
  }

  /* ───────────── Registri modul ───────────── */
  /* tier: LIVE | PARTIAL | FRAMEWORK — kejujuran kesiapan operasional (audit dewan).
     LIVE      = kapabilitas nyata di klien sesuai lingkup modul
     PARTIAL   = jalan, tetapi celah produksi (tanpa node/pen-test/data hidup)
     FRAMEWORK = kerangka/API; belum ada operasi nyata */
  var REG = [
    { id: 'NexusTruth',      g: 'NexusTruth',      script: 'nexus-truth-core', sibling: 'nexus_truth_core_v13_7_2.js', req: true,  test: 'truth',  tier: 'LIVE',      note: 'SSRF guard + entity/quote verification aktif di klien' },
    { id: 'NexusOmniGuard',  g: 'NexusOmniGuard',  script: 'nx-omni-sentinel',        req: true,               tier: 'PARTIAL',   note: 'pemindaian statis Aegis; belum pen-test / SOC-2 otomatis' },
    { id: 'NexusOmniCoreV3', g: 'NexusOmniCoreV3', script: 'nx-omni-core-v3', sibling: 'nexus_omni-core_v3.js', req: false,              tier: 'LIVE',      note: 'deobfuscation + chain analysis murni klien' },
    { id: 'NexusEADI',       g: 'NexusEADI',       script: 'nx-super-eadi', sibling: 'SuperEADI.js', req: true,  test: 'eadi',  tier: 'LIVE',      note: 'watermark DCT ratio + CRC framing penuh di klien (inlined)' },
    { id: 'NexusLBC',        g: 'NexusLBC',        script: 'nx-super-lbc', sibling: 'SuperLBC.js', req: true,  test: 'lbc',   tier: 'PARTIAL',   note: 'MPT+Schnorr BIP-340 di klien; TIDAK ada node jaringan yang dapat ditulis (inlined)' },
    { id: 'NexusAku',        g: 'NexusAku',        script: 'nx-aku-module', sibling: 'NexusAku.js',           req: true,  test: 'aku',   tier: 'PARTIAL',   note: 'gerbang jati diri + HMAC; belum jalur identitas terdistribusi' },
    { id: 'NexusPharma',     g: 'NexusPharma',     script: 'nxp-engine',              req: false, test: 'pharma', tier: 'PARTIAL',  note: 'mesin farmasi; integrasi data/prod bergantung host' },
    { id: 'NexusDeck',       g: 'NexusDeck',       script: 'nxd-js',                  req: false, children: ['NexusLBC', 'NexusEADI'], tier: 'PARTIAL', note: 'deck mengorkestrasi LBC+EADI; kesiapan = min(anak)' },
    { id: 'NexusDeckAI',     g: 'NexusDeckAI',     script: 'nxd2-js',                 req: false,               tier: 'PARTIAL',   note: 'lapisan AI deck; bergantung model/host' },
    { id: 'NexusArchitect',  g: 'NexusArchitect',  script: 'nx-architect-patch-374',  req: false,               tier: 'FRAMEWORK', note: 'patch arsitektur; bukan runtime produksi mandiri' }
  ];
  var BY = {};
  REG.forEach(function (m) { BY[m.id] = m; });

  var cfg = { enforce: 'soft' };
  var base = {};            // baseline per modul: {fingerprint,count,checksum,ts}
  var csCache = {};         // checksum script-text
  var fileCs = {};          // checksum file eksternal: {hash,status,reason}
  var lastStatus = {};      // untuk deteksi perubahan (anti-flood)
  var traced = {};          // dedup baris Neural Trace
  var testCache = {};       // hasil self-test modul terakhir
  var fnCache = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  var mf; // manifest (undefined = belum dibaca)
  var booted = false, baselineDone = false, tick = 0;

  /* ───────────── Spek API (artefak 3) ───────────── */
  function fnHash(f) {
    var h = fnCache && fnCache.get(f);
    if (h) return h;
    var src = '';
    try { src = Function.prototype.toString.call(f); } catch (e) {}
    h = sha256Hex(src).slice(0, 16);
    if (fnCache) { try { fnCache.set(f, h); } catch (e) {} }
    return h;
  }
  function apiSpec(o) {
    if (o == null || (typeof o !== 'object' && typeof o !== 'function')) return null;
    var names, lines = [];
    try { names = Object.getOwnPropertyNames(o).sort(); } catch (e) { return null; }
    for (var i = 0; i < names.length; i++) {
      var k = names[i], d;
      try { d = Object.getOwnPropertyDescriptor(o, k); } catch (e) { continue; }
      if (!d) continue;
      if (d.get || d.set) { lines.push(k + ':accessor'); continue; }   // getter TIDAK dipanggil
      var v = d.value, t = typeof v;
      if (t === 'function') lines.push(k + ':fn:' + fnHash(v));
      else lines.push(k + ':' + (v === null ? 'null' : t));
    }
    return { count: lines.length, fingerprint: sha256Hex(lines.join('\n')) };
  }

  /* ───────────── Artefak: script-text / file ───────────── */
  /* Normalisasi sumber yang konsisten di semua jalur (hash, links, export).
     Hanya normalisasi newline; TIDAK trim — agar cocok dengan textContent browser
     dan dengan cara manifest dibuat. Ini menghilangkan false-MISMATCH. */
  function normalizeSource(t) {
    return String(t == null ? '' : t).replace(/\r\n?/g, '\n');
  }
  function scriptChecksum(id, fresh) {
    if (!fresh && csCache[id] !== undefined) return csCache[id];
    var out = null;
    try {
      if (typeof document !== 'undefined') {
        var el = document.getElementById(id);
        if (el && el.tagName === 'SCRIPT') {
          var t = normalizeSource(el.textContent || '');
          out = { hash: sha256Hex(t), bytes: t.length };
        }
      }
    } catch (e) { out = null; }
    csCache[id] = out;
    return out;
  }
  function loadFile(name) {
    if (fileCs[name]) return Promise.resolve(fileCs[name]);
    var res = function (o) { fileCs[name] = o; return o; };
    try {
      if (typeof document === 'undefined' || typeof fetch !== 'function') return Promise.resolve(res({ status: 'SKIP', reason: 'tanpa DOM/fetch' }));
      var proto = String(root.location && root.location.protocol || '');
      if (proto !== 'http:' && proto !== 'https:') return Promise.resolve(res({ status: 'SKIP', reason: 'protokol ' + proto + ' — byte file tak dapat dibaca (butuh http/https)' }));
      var els = document.querySelectorAll('script[src]'), url = null;
      for (var i = 0; i < els.length; i++) {
        var s = els[i].getAttribute('src') || '';
        if (s.split(/[?#]/)[0].split('/').pop() === name) { url = els[i].src; break; }
      }
      if (!url) return Promise.resolve(res({ status: 'SKIP', reason: 'tag <script src> tak ditemukan' }));
      return fetch(url, { cache: 'force-cache', credentials: 'omit' }).then(function (r) {
        if (!r.ok) return res({ status: 'SKIP', reason: 'HTTP ' + r.status });
        return r.arrayBuffer().then(function (ab) { return res({ status: 'READ', hash: sha256Hex(new Uint8Array(ab)), bytes: ab.byteLength }); });
      }).catch(function (e) { return res({ status: 'SKIP', reason: 'fetch gagal: ' + String(e && e.message || e).slice(0, 60) }); });
    } catch (e) { return Promise.resolve(res({ status: 'SKIP', reason: 'galat: ' + String(e && e.message || e).slice(0, 60) })); }
  }

  function manifest() {
    if (mf !== undefined) return mf;
    mf = null;
    try {
      var el = typeof document !== 'undefined' && document.getElementById('nx-integrity-manifest');
      if (el) { var j = JSON.parse(el.textContent); if (j && j.schema === 1) mf = j; }
    } catch (e) { mf = null; }
    return mf;
  }

  function verOf(o) {
    var v = null;
    try { v = o.version || o.VERSION || o.VERSI || null; } catch (e) {}
    return v ? String(v) : 'unknown';
  }

  /* ───────────── check() per modul ───────────── */
  function check(id, opt) {
    var m = BY[id];
    if (!m) return null;
    opt = opt || {};
    var obj = root[m.g];
    var loaded = !!obj && (typeof obj === 'object' || typeof obj === 'function');
    var r = {
      id: id, required: !!m.req, loaded: loaded, version: null, hasGetMeta: false,
      artifact: { kind: m.script ? 'script-text' : (m.file ? 'file' : 'none'), ref: m.script || m.file || null },
      checksum: { actual: null, expected: null, via: null, status: 'SKIP', reason: '' },
      fingerprint: { current: null, baseline: null, count: 0, status: 'PENDING' },
      status: 'MISSING',
      tier: m.tier || 'FRAMEWORK',
      tierNote: m.note || ''
    };
    if (!loaded) return r;
    r.version = verOf(obj);
    try { r.hasGetMeta = typeof obj.getMeta === 'function'; } catch (e) {}

    var sp = apiSpec(obj);
    if (sp) {
      r.fingerprint.current = sp.fingerprint; r.fingerprint.count = sp.count;
      var b = base[id];
      if (b && b.fingerprint) { r.fingerprint.baseline = b.fingerprint; r.fingerprint.status = b.fingerprint === sp.fingerprint ? 'STABLE' : 'DRIFT'; }
    }

    var actual = null, why = '';
    if (m.script) {
      var cs = scriptChecksum(m.script, opt.fresh);
      if (cs) actual = cs.hash; else why = 'script#' + m.script + ' tak ada di DOM';
    } else if (m.file) {
      var fc = fileCs[m.file];
      if (fc && fc.status === 'READ') actual = fc.hash; else why = fc ? fc.reason : 'file belum dibaca';
    } else why = 'tanpa artefak';
    r.checksum.actual = actual;

    var man = manifest(), exp = null, via = null;
    if (man) {
      var key = m.script ? (man.scripts && man.scripts[m.script]) : (man.files && man.files[m.file]);
      if (key) { exp = key; via = 'manifest'; }
    }
    if (!exp && base[id] && base[id].checksum) { exp = base[id].checksum; via = 'baseline(TOFU)'; }
    r.checksum.expected = exp; r.checksum.via = via;
    if (actual && exp) r.checksum.status = actual === exp ? 'OK' : 'MISMATCH';
    else { r.checksum.status = 'SKIP'; r.checksum.reason = why || 'tanpa pembanding (belum ada manifest/baseline)'; }

    if (r.checksum.status === 'MISMATCH') r.status = 'MISMATCH';
    else if (r.fingerprint.status === 'DRIFT') r.status = 'DRIFT';
    else if (r.checksum.status === 'OK' && r.fingerprint.status === 'STABLE') r.status = 'OK';
    else r.status = 'LOADED';
    return r;
  }

  /* ───────────── Audit tamper-evident (B) ───────────── */
  var audit = { base: GENESIS, head: GENESIS, seq: 0, entries: [] };
  var dirty = false, db = null, flushT = null, lastKey = {};
  function entryHash(e) { return sha256Hex(JSON.stringify([e.seq, e.ts, e.moduleId, e.fingerprint, e.event, e.actor, e.detail, e.prev])); }
  function verifyChain(entries, baseHash) {
    var prev = baseHash || GENESIS;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (!e || e.prev !== prev || entryHash(e) !== e.hash) return { ok: false, brokenAt: i };
      prev = e.hash;
    }
    return { ok: true, brokenAt: -1, head: prev };
  }
  function record(event, moduleId, fingerprint, actor, detail, force) {
    try {
      var key = moduleId + '|' + event + '|' + (fingerprint || '');
      if (!force && lastKey[moduleId + '|' + event] === key) return null;   // anti-flood
      lastKey[moduleId + '|' + event] = key;
      var e = {
        seq: audit.seq++, ts: Date.now(), moduleId: String(moduleId || '-'), fingerprint: fingerprint ? String(fingerprint).slice(0, 64) : null,
        event: String(event), actor: String(actor || 'system'), detail: String(detail || '').slice(0, DETAIL_MAX), prev: audit.head
      };
      e.hash = entryHash(e);
      audit.entries.push(e); audit.head = e.hash;
      while (audit.entries.length > AUDIT_MAX) { audit.base = audit.entries.shift().hash; }
      markDirty();
      return e;
    } catch (e) { return null; }
  }
  function markDirty() {
    dirty = true;
    if (flushT || typeof setTimeout !== 'function') return;
    flushT = setTimeout(function () { flushT = null; flush(); }, FLUSH_MS);
  }
  function idb() {
    return new Promise(function (res, rej) {
      try {
        if (typeof indexedDB === 'undefined') return rej(new Error('no-idb'));
        var q = indexedDB.open(DB_NAME, 1);
        q.onupgradeneeded = function () { try { q.result.createObjectStore('kv'); } catch (e) {} };
        q.onsuccess = function () { res(q.result); };
        q.onerror = function () { rej(q.error || new Error('idb-error')); };
        q.onblocked = function () { rej(new Error('idb-blocked')); };
      } catch (e) { rej(e); }
    });
  }
  function flush() {
    if (!dirty) return Promise.resolve(false);
    dirty = false;
    var payload = { v: 1, base: audit.base, entries: audit.entries.slice() };
    return Promise.resolve().then(function () { return db || idb(); }).then(function (d) {
      db = d;
      return new Promise(function (res, rej) {
        var tx = d.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(payload, 'chain');
        tx.oncomplete = function () { res(true); };
        tx.onerror = tx.onabort = function () { rej(tx.error || new Error('tx')); };
      });
    }).catch(function () { return false; });
  }
  function loadStore() {
    var t = new Promise(function (res) { setTimeout(function () { res(null); }, 1500); });
    var p = Promise.resolve().then(idb).then(function (d) {
      db = d;
      return new Promise(function (res) {
        try {
          var q = d.transaction('kv', 'readonly').objectStore('kv').get('chain');
          q.onsuccess = function () { res(q.result || null); };
          q.onerror = function () { res(null); };
        } catch (e) { res(null); }
      });
    }).catch(function () { return null; });
    return Promise.race([p, t]);
  }
  function prevBaselines(entries) {   // checksum baseline terakhir per modul dari sesi sebelumnya
    var out = {};
    entries.forEach(function (e) { if (e.event === 'BASELINE' || e.event === 'BASELINE_LATE') { var mm = /cs:([0-9a-f]+)/.exec(e.detail); out[e.moduleId] = { cs: mm ? mm[1] : null, fp: e.fingerprint }; } });
    return out;
  }

  /* ───────────── Neural Trace (F3, tanpa flood) ───────────── */
  function trace(tag, msg, key) {
    try {
      var k = key || msg;
      if (traced[k]) return;
      traced[k] = 1;
      if (typeof logEvent === 'function') logEvent(tag, '[INTEGRITY] ' + msg);
    } catch (e) {}
  }

  /* ───────────── Baseline & watcher ───────────── */
  function takeBaseline(id, actor, late) {
    var r = check(id);
    if (!r || !r.loaded) return null;
    base[id] = { fingerprint: r.fingerprint.current, count: r.fingerprint.count, checksum: r.checksum.actual, ts: Date.now() };
    record(late ? 'BASELINE_LATE' : 'BASELINE', id, r.fingerprint.current, actor || 'system',
      'cs:' + (r.checksum.actual ? r.checksum.actual.slice(0, 16) : '-') + ' v:' + r.version, true);
    return base[id];
  }
  function noteChange(r) {
    var prev = lastStatus[r.id];
    if (prev === r.status) return;
    lastStatus[r.id] = r.status;
    if (r.status === 'MISMATCH' || r.status === 'DRIFT' || (r.status === 'MISSING' && r.required)) {
      record('STATUS_' + r.status, r.id, r.fingerprint.current, 'watcher', 'checksum:' + r.checksum.status + ' fp:' + r.fingerprint.status);
      trace(r.status === 'MISSING' ? 'WARN' : 'ERROR',
        r.id + ' → ' + r.status + (r.status === 'MISMATCH' ? ' (checksum ≠ ' + (r.checksum.via || '?') + '; perbarui manifest bila Anda sengaja mengubah modul: NexusIntegrity.exportManifest())' : ''),
        r.id + ':' + r.status);
    } else if (prev && (prev === 'MISMATCH' || prev === 'DRIFT' || prev === 'MISSING')) {
      record('STATUS_RECOVERED', r.id, r.fingerprint.current, 'watcher', prev + '→' + r.status);
    }
  }
  function sweep(fresh) {
    var rows = REG.map(function (m) {
      var r = check(m.id, { fresh: !!fresh });
      if (r && r.loaded && baselineDone && !base[m.id]) { takeBaseline(m.id, 'system', true); r = check(m.id); }
      if (r) noteChange(r);
      return r;
    });
    ui(rows);
    return rows;
  }
  function boot() {
    if (booted) return Promise.resolve(false);
    booted = true;
    var prev = {};
    return loadStore().then(function (st) {
      if (st && st.v === 1 && Array.isArray(st.entries)) {
        var v = verifyChain(st.entries, st.base);
        if (v.ok) {
          audit.base = st.base; audit.entries = st.entries;
          audit.head = st.entries.length ? st.entries[st.entries.length - 1].hash : st.base;
          audit.seq = st.entries.length ? st.entries[st.entries.length - 1].seq + 1 : 0;
          prev = prevBaselines(st.entries);
        } else {
          record('AUDIT_STORE_INVALID', '-', null, 'system', 'rantai tersimpan rusak @' + v.brokenAt + ' — dimulai baru', true);
          trace('ERROR', 'rantai audit tersimpan rusak (indeks ' + v.brokenAt + ') — dimulai rantai baru');
        }
      }
      return Promise.all(REG.filter(function (m) { return m.file; }).map(function (m) { return loadFile(m.file); }));
    }).then(function () {
      var ids = REG.map(function (m) { return m.id; }), i = 0;
      return new Promise(function (res) {
        (function step() {
          var t0 = Date.now();
          while (i < ids.length && Date.now() - t0 < 30) { takeBaseline(ids[i], 'boot'); i++; }
          if (i < ids.length) setTimeout(step, 0); else res();
        })();
      });
    }).then(function () {
      baselineDone = true;
      var changed = [];
      REG.forEach(function (m) {
        var b = base[m.id], p = prev[m.id];
        if (b && p && p.cs && b.checksum && b.checksum.slice(0, 16) !== p.cs)
          { changed.push(m.id); record('CHANGED_SINCE_PREV_BOOT', m.id, b.fingerprint, 'boot', 'artefak berbeda dari sesi sebelumnya (info)', true); }
      });
      var rows = sweep(false);
      var c = { OK: 0, LOADED: 0, MISMATCH: 0, DRIFT: 0, MISSING: 0 };
      rows.forEach(function (r) { c[r.status]++; });
      trace('DIAG', 'baseline ' + rows.length + ' modul · OK ' + c.OK + ' · LOADED ' + c.LOADED + ' · MISMATCH ' + c.MISMATCH + ' · DRIFT ' + c.DRIFT + ' · MISSING ' + c.MISSING +
        (changed.length ? ' · berubah vs sesi lalu: ' + changed.join(',') : '') + ' · hash=' + hashImpl(), 'boot-summary');
      flush();
      return true;
    }).catch(function () { baselineDone = true; return false; });
  }
  function startWatch() {
    if (typeof setInterval !== 'function') return;
    var t = setInterval(function () {
      try { if (typeof document !== 'undefined' && document.hidden) return; tick++; sweep(tick % 5 === 0); } catch (e) {}
    }, WATCH_MS);
    if (t && t.unref) t.unref();
  }

  /* ───────────── Antarmuka status (C1) ───────────── */
  function buildInfo() {
    var lines = [], n = 0;
    REG.filter(function (m) { return m.script; }).map(function (m) { return m.id; }).sort().forEach(function (id) {
      var cs = scriptChecksum(BY[id].script);
      if (cs) { lines.push(id + '=' + cs.hash); n++; }
    });
    var fp = sha256Hex(lines.join('\n'));
    var man = manifest(), mfp = man && man.build ? man.build : null;
    return { fingerprint: fp, short: fp.slice(0, 12), modules: n, algo: 'SHA-256', kind: 'computed (script-text checksums)',
             manifest: mfp, match: mfp ? mfp === fp : null };
  }
  function buildFingerprint() { return buildInfo().fingerprint; }
  function ui(rows) {
    try {
      if (typeof document === 'undefined') return;
      var a = document.getElementById('nx-intg-fp'), b = document.getElementById('nx-intg-st');
      if (!a && !b) return;
      rows = rows || REG.map(function (m) { return check(m.id); });
      var bi = buildInfo(), ok = 0, bad = 0;
      rows.forEach(function (r) { if (r.status === 'OK') ok++; if (r.status === 'MISMATCH' || r.status === 'DRIFT' || (r.status === 'MISSING' && r.required)) bad++; });
      var ver = (root.NexusArchitect && root.NexusArchitect.version) || 'unknown';
      if (a) {
        a.textContent = bi.short + ' · v' + ver;
        a.title = 'Build fingerprint (SHA-256 checksum script modul)\n' + bi.fingerprint + '\nmanifest: ' + (bi.match === null ? 'tidak ada' : (bi.match ? 'cocok' : 'TIDAK COCOK')) +
          '\n\n' + rows.map(function (r) { return r.id + ' [' + r.status + '] v' + (r.version || '—'); }).join('\n') +
          '\n\n"unknown" = ' + LEGEND.unknown;
      }
      if (b) { b.textContent = ok + '/' + rows.length + ' OK' + (bad ? ' · ' + bad + ' !' : ''); b.style.color = bad ? '#ff5a6e' : ''; }
    } catch (e) {}
  }

  /* ───────────── ensureStable / guard (D) ───────────── */
  function blocks(status) {
    if (status === 'MISSING') return true;
    if (status === 'MISMATCH') return cfg.enforce === 'standard' || cfg.enforce === 'strict';
    if (status === 'DRIFT') return cfg.enforce === 'strict';
    return false;
  }
  function ensureStable(id) {
    try {
      var r = check(id);
      if (!r) return { ok: false, reason: 'modul tak terdaftar: ' + id, meta: null };
      var meta = describe(id);
      if (blocks(r.status)) return { ok: false, reason: id + ' ' + r.status + ' — ' + (LEGEND[r.status] || ''), meta: meta };
      var out = { ok: true, reason: r.status === 'OK' ? 'stabil' : id + ' ' + r.status + ' (peringatan, tidak memblokir pada enforce=' + cfg.enforce + ')', meta: meta };
      if (r.status !== 'OK') out.warning = r.status;
      return out;
    } catch (e) { return { ok: false, reason: 'ensureStable galat: ' + String(e && e.message || e), meta: null }; }
  }
  /* Wrapper lintas-modul: gagal cepat (fail-closed) bila dependency tak stabil. Tidak pernah melempar. */
  function guard(fromId, toId, fn, opts) {
    var st = ensureStable(toId);
    if (!st.ok) { record('GUARD_BLOCK', toId, st.meta && st.meta.fingerprint, fromId, st.reason); return { ok: false, blocked: true, reason: 'dependency ' + st.reason, meta: st.meta }; }
    try { return { ok: true, value: fn(), meta: st.meta }; }
    catch (e) { return { ok: false, blocked: false, reason: String(e && e.message || e).slice(0, 200), meta: st.meta }; }
  }

  /* ───────────── getMeta (A1) ───────────── */
  function describe(id, fallback) {
    var r = check(id);
    var b = fallback || {};
    if (!r) return b;
    return {
      id: id, version: r.version || b.version || 'unknown',
      checksum: r.checksum.actual, fingerprint: r.fingerprint.current,
      source: r.artifact.kind, status: r.status, checksumStatus: r.checksum.status,
      tier: r.tier || 'FRAMEWORK', tierNote: r.tierNote || ''
    };
  }
  function getMeta(id) {
    if (id) return describe(id);
    var o = {}; REG.forEach(function (m) { o[m.id] = describe(m.id); });
    return o;
  }

  /* ───────────── Tanda tangan snapshot (B3 / G3) ───────────── */
  var sessKey = null;
  function snapshot() {
    var rows = REG.map(function (m) { return check(m.id); });
    var bi = buildInfo();
    return {
      schema: 1, ts: Date.now(), tool: 'NexusIntegrity/' + VERSION, hash: hashImpl(),
      build: bi.fingerprint, auditHead: audit.head, auditCount: audit.entries.length,
      modules: rows.map(function (r) { return { id: r.id, version: r.version || 'unknown', status: r.status, checksum: r.checksum.actual, fingerprint: r.fingerprint.current }; })
    };
  }
  function signSnapshot(opts) {
    opts = opts || {};
    var L = lbc() || root.NexusLBC;
    if (!L || typeof L.schnorrSign !== 'function') return { ok: false, reason: 'NexusLBC.schnorrSign tidak tersedia' };
    try {
      var priv = opts.privateKey, kind = 'provided';
      if (!priv) { if (!sessKey) sessKey = L.generateKeyPair(); priv = sessKey.privateKey; kind = 'session-ephemeral'; }
      var snap = snapshot(), msg = canon(snap);
      var sig = L.bytesToHex(L.schnorrSign(priv, msg));
      var pub = L.bytesToHex(L.schnorrGetPublicKey(priv));
      record('SNAPSHOT_SIGNED', '-', snap.build, opts.actor || 'user', 'pub:' + pub.slice(0, 16) + ' kind:' + kind, true);
      return { ok: true, snapshot: snap, signature: sig, publicKey: pub, keyKind: kind,
        note: kind === 'provided' ? 'Verifikasi dengan kunci publik yang di-pin di luar halaman untuk authenticity.' : 'Kunci sesi sementara: hanya integrity, BUKAN proof of origin.' };
    } catch (e) { return { ok: false, reason: String(e && e.message || e).slice(0, 160) }; }
  }
  function verifySnapshot(pack, pinnedPublicKey) {
    var L = lbc() || root.NexusLBC;
    if (!pack || !pack.snapshot || !pack.signature || !pack.publicKey) return { ok: false, reason: 'paket tidak lengkap' };
    if (!L || typeof L.schnorrVerify !== 'function') return { ok: false, reason: 'NexusLBC.schnorrVerify tidak tersedia' };
    try {
      var sigOk = !!L.schnorrVerify(pack.signature, canon(pack.snapshot), pack.publicKey);
      var pinned = !!pinnedPublicKey, pinOk = pinned ? String(pinnedPublicKey).toLowerCase() === String(pack.publicKey).toLowerCase() : null;
      return { ok: sigOk && (pinned ? pinOk : true), signatureValid: sigOk, pinned: pinned, pinMatch: pinOk,
        authenticity: pinned && pinOk && sigOk ? 'terverifikasi terhadap kunci pin' : 'integrity only (tanpa kunci pin = bukan proof of origin)' };
    } catch (e) { return { ok: false, reason: String(e && e.message || e).slice(0, 160) }; }
  }

  /* ───────────── Self-test modul (adapter) ───────────── */
  var ADAPT = {
    truth:  function () { return Promise.resolve(root.NexusTruth.selfTest()).then(function (r) { return { ok: r.pass + (r.skip || 0) === r.total, detail: r.score }; }); },
    lbc:    function () { return Promise.resolve(root.NexusLBC.selfTest()).then(function (r) { return { ok: !!r.ok, detail: r.results.filter(function (x) { return x.ok; }).length + '/' + r.results.length }; }); },
    eadi:   function () { var r = root.NexusEADI.selfTest(); return Promise.resolve({ ok: !!r.ok, detail: r.results.filter(function (x) { return x.ok; }).length + '/' + r.results.length }); },
    aku:    function () { return Promise.resolve(root.NexusAku.selfTest()).then(function (r) { return { ok: r.pass === r.total, detail: r.score }; }); },
    pharma: function () { var r = root.NexusPharma.selfTest(false); return Promise.resolve({ ok: r.pass === r.total, detail: r.pass + '/' + r.total }); }
  };
  function runModuleTests(ids) {
    ids = ids || REG.filter(function (m) { return m.test; }).map(function (m) { return m.id; });
    var out = {};
    return ids.reduce(function (p, id) {
      return p.then(function () {
        var m = BY[id];
        if (!m || !m.test || !root[m.g]) { out[id] = { ok: null, detail: 'n/a' }; return; }
        return ADAPT[m.test]().then(function (r) { out[id] = r; testCache[id] = r; }, function (e) { out[id] = { ok: false, detail: 'galat: ' + String(e && e.message || e).slice(0, 80) }; testCache[id] = out[id]; });
      });
    }, Promise.resolve()).then(function () { return out; });
  }

  /* ───────────── Verdict (F2) & laporan (F1) ───────────── */
  function verdict() {
    var rows = REG.map(function (m) { return check(m.id); });
    var req = rows.filter(function (r) { return r.required; });
    var reasons = [];
    var bad = rows.filter(function (r) { return r.status === 'MISMATCH' || r.status === 'DRIFT' || (r.required && r.status === 'MISSING'); });
    bad.forEach(function (r) { reasons.push(r.id + ' ' + r.status); });
    var unproven = req.filter(function (r) { return r.loaded && r.status !== 'OK'; });
    unproven.forEach(function (r) { reasons.push(r.id + ' belum terbukti (' + (r.checksum.reason || r.fingerprint.status) + ')'); });
    var level = bad.length ? 'COMPROMISED' : (!baselineDone ? 'UNVERIFIED' : (unproven.length ? 'PARTIAL' : 'VERIFIED'));
    var live = rows.filter(function (r) { return r.loaded && r.tier === 'LIVE'; });
    var partial = rows.filter(function (r) { return r.loaded && r.tier === 'PARTIAL'; });
    var framework = rows.filter(function (r) { return r.loaded && r.tier === 'FRAMEWORK'; });
    /* Skor kesiapan operasional kasar: LIVE=1, PARTIAL=0.45, FRAMEWORK=0.1 (selaras audit dewan ~22%) */
    var readinessScore = 0, readinessN = 0;
    rows.forEach(function (r) {
      if (!r.loaded) return;
      readinessN++;
      readinessScore += r.tier === 'LIVE' ? 1 : (r.tier === 'PARTIAL' ? 0.45 : 0.1);
    });
    var readinessPct = readinessN ? Math.round((readinessScore / readinessN) * 100) : 0;
    return {
      integrity: level, ok: level === 'VERIFIED', reasons: reasons,
      evidence: { modules: rows.length, required: req.length, withChecksumOK: rows.filter(function (r) { return r.checksum.status === 'OK'; }).length,
                  fingerprintStable: rows.filter(function (r) { return r.fingerprint.status === 'STABLE'; }).length, baseline: baselineDone, hash: hashImpl(),
                  manifest: !!manifest() },
      readiness: {
        pct: readinessPct,
        live: live.map(function (r) { return r.id; }),
        partial: partial.map(function (r) { return r.id; }),
        framework: framework.map(function (r) { return r.id; }),
        note: 'LIVE=kapabilitas nyata klien; PARTIAL=celah produksi (tanpa node/pen-test/data hidup); FRAMEWORK=kerangka saja. Jangan samakan self-test lulus dengan siap OTF/produksi.'
      },
      note: 'Integritas = fingerprint/checksum saja. Kesiapan operasional = field readiness (hasil audit dewan). Bukan proof of origin tanpa tanda tangan + kunci pin.'
    };
  }
  function report(opts) {
    opts = opts || {};
    var rows = REG.map(function (m) {
      var r = check(m.id, { fresh: !!opts.fresh }), t = testCache[m.id];
      return { id: r.id, version: r.version || '—', status: r.status, tier: r.tier || 'FRAMEWORK', tierNote: r.tierNote || '',
        fingerprint: r.fingerprint.current ? r.fingerprint.current.slice(0, 12) : '—',
        checksum: r.checksum.actual ? r.checksum.actual.slice(0, 12) : '—', checksumStatus: r.checksum.status, via: r.checksum.via || '—', api: r.fingerprint.status,
        getMeta: r.hasGetMeta ? 'ya' : (r.loaded ? 'tidak' : '—'), selfTest: t ? ((t.ok ? 'PASS ' : 'FAIL ') + t.detail) : (m.test ? 'belum dijalankan' : 'n/a') };
    });
    try { if (opts.print !== false && typeof console !== 'undefined' && console.table) console.table(rows); } catch (e) {}
    return rows;
  }
  function reportAsync(opts) {
    opts = opts || {};
    return (opts.run ? runModuleTests() : Promise.resolve()).then(function () { return report(opts); });
  }


  /* ───────────── Tautan ke file mandiri (informasi; tidak memengaruhi status/verdict) ─────────────
     Membandingkan kode inline di HTML dengan file .js mandiri di folder yang sama. Hanya berjalan bila dipanggil, hanya lewat http/https. */
  /* norm untuk perbandingan sibling — sama dengan normalizeSource (tanpa trim)
     agar status SINKRON/BEDA konsisten dengan checksum utama & manifest. */
  function norm(t) { return normalizeSource(t); }
  function links() {
    var rows = REG.filter(function (m) { return m.sibling; });
    var proto = String(root.location && root.location.protocol || '');
    function row(m, st, why, extra) { var o = { id: m.id, file: m.sibling, status: st, detail: why || '' }; if (extra) for (var k in extra) o[k] = extra[k]; return o; }
    if (typeof fetch !== 'function' || typeof document === 'undefined') return Promise.resolve(rows.map(function (m) { return row(m, 'SKIP', 'tanpa DOM/fetch'); }));
    if (proto !== 'http:' && proto !== 'https:') return Promise.resolve(rows.map(function (m) { return row(m, 'SKIP', 'protokol ' + proto + ' — file mandiri tak dapat dibaca (butuh http/https)'); }));
    return Promise.all(rows.map(function (m) {
      var el = document.getElementById(m.script);
      if (!el) return row(m, 'SKIP', 'tag inline tak ditemukan');
      var url; try { url = new URL(m.sibling, root.location.href).href; } catch (e) { return row(m, 'SKIP', 'URL tak valid'); }
      return fetch(url, { cache: 'no-store', credentials: 'omit' }).then(function (r) {
        if (r.status === 404) return row(m, 'ABSEN', 'file tidak ada di folder yang sama');
        if (!r.ok) return row(m, 'SKIP', 'HTTP ' + r.status);
        return r.text().then(function (txt) {
          var a = norm(el.textContent), b = norm(txt);
          var same = a === b, inc = !same && (a.indexOf(b) >= 0 || b.indexOf(a) >= 0);
          return row(m, same ? 'SINKRON' : (inc ? 'SINKRON' : 'BEDA'), same ? 'identik' : (inc ? 'salah satu memuat yang lain (pembungkus berbeda)' : 'isi berbeda'),
            { inlineSha: sha256Hex(a).slice(0, 12), fileSha: sha256Hex(b).slice(0, 12) });
        });
      }).catch(function (e) { return row(m, 'SKIP', 'fetch gagal: ' + String(e && e.message || e).slice(0, 60)); });
    })).then(function (out) {
      try { if (typeof console !== 'undefined' && console.table) console.table(out); } catch (e) {}
      return out;
    });
  }

  /* ───────────── selfTest sinkron (E1) ───────────── */
  function selfTest(opts) {
    opts = opts || {};
    var tests = [];
    function T(n, ok, d) { tests.push({ n: n, ok: !!ok, d: d || '' }); }
    T('I1 SHA-256 vektor', sha256Hex('abc') === ABC && sha256Bytes(utf8('abc')) === ABC, hashImpl());
    var s1 = apiSpec({ a: 1, f: function () {} }), s2 = apiSpec({ a: 1, f: function () {} });
    T('I2 spek API deterministik', s1 && s2 && s1.count === 2 && typeof s1.fingerprint === 'string' && s1.fingerprint.length === 64);
    var t = { base: GENESIS, entries: [] }, p = GENESIS, i, e;
    for (i = 0; i < 3; i++) { e = { seq: i, ts: 1, moduleId: 'x', fingerprint: null, event: 'T', actor: 'a', detail: 'd' + i, prev: p }; e.hash = entryHash(e); t.entries.push(e); p = e.hash; }
    T('I3 rantai audit valid', verifyChain(t.entries, t.base).ok);
    var forged = JSON.parse(JSON.stringify(t.entries)); forged[1].detail = 'dipalsukan';
    T('I4 rantai audit: ubahan terdeteksi', verifyChain(forged, t.base).brokenAt === 1);
    T('I5 rantai audit hidup valid', verifyChain(audit.entries, audit.base).ok, audit.entries.length + ' entri');
    var man = manifest();
    T('I6 manifest', true, man ? 'ada (' + Object.keys(man.scripts || {}).length + ' script)' : 'tidak ada → pembanding = baseline TOFU');
    if (opts.deep) {
      var L = lbc() || root.NexusLBC, okSig = false;
      try { var pk = L.generateKeyPair(), msg = 'nx-int', sg = L.schnorrSign(pk.privateKey, msg); okSig = L.schnorrVerify(sg, msg, pk.publicKey) && !L.schnorrVerify(sg, msg + 'x', pk.publicKey); } catch (x) {}
      T('I7 Schnorr snapshot (deep)', okSig);
    }
    var ids = null;
    if (opts.scope === 'deck') ids = ['NexusDeck', 'NexusLBC', 'NexusEADI'];
    else if (Array.isArray(opts.scope)) ids = opts.scope;
    var modules = {}, failMod = false, warnMod = false;
    REG.forEach(function (m) {
      if (ids && ids.indexOf(m.id) < 0) return;
      var r = check(m.id, { fresh: !!opts.fresh });
      modules[m.id] = { status: r.status, version: r.version || null, checksum: r.checksum.actual, checksumStatus: r.checksum.status, fingerprint: r.fingerprint.current, api: r.fingerprint.status, required: r.required };
      if (r.status === 'MISMATCH' || r.status === 'DRIFT' || (r.required && r.status === 'MISSING')) failMod = true;
      else if (r.status !== 'OK' && (r.loaded)) warnMod = true;
    });
    var failT = tests.some(function (x) { return !x.ok; });
    var bi = buildInfo();
    return {
      status: (failT || failMod) ? 'FAIL' : (warnMod || !baselineDone ? 'WARN' : 'OK'),
      version: VERSION, checksum: bi.fingerprint, hash_timestamp: Date.now(),
      modules: modules, tests: tests, verdict: ids ? undefined : verdict().integrity, buildMatchesManifest: bi.match
    };
  }

  /* ───────────── Manifest builder (untuk pembaruan sengaja) ───────────── */
  function exportManifest() {
    var scripts = {}, files = {};
    REG.forEach(function (m) {
      if (m.script) { var cs = scriptChecksum(m.script, true); if (cs) scripts[m.script] = cs.hash; }
      else if (m.file && fileCs[m.file] && fileCs[m.file].status === 'READ') files[m.file] = fileCs[m.file].hash;
    });
    var bi = buildInfo();
    var o = { schema: 1, algo: 'SHA-256', generated: new Date().toISOString(), build: bi.fingerprint, scripts: scripts, files: files };
    return JSON.stringify(o, null, 1);
  }

  function configure(o) {
    if (o && typeof o === 'object' && (o.enforce === 'soft' || o.enforce === 'standard' || o.enforce === 'strict')) cfg.enforce = o.enforce;
    return { enforce: cfg.enforce };
  }
  function rebaseline(actor) {
    REG.forEach(function (m) { if (root[m.g]) takeBaseline(m.id, actor || 'user'); });
    traced = {}; lastStatus = {};
    return sweep(true).map(function (r) { return { id: r.id, status: r.status }; });
  }

  function exportAudit() { return { base: audit.base, head: audit.head, entries: audit.entries.slice() }; }
  function verifyAudit(exp) { exp = exp || exportAudit(); return verifyChain(exp.entries || [], exp.base); }

  /* ───────────── Boot ───────────── */
  (function arm() {
    if (typeof document === 'undefined' || typeof setTimeout !== 'function') return;
    function go() { setTimeout(function () { boot().then(startWatch); }, BOOT_DELAY); }
    if (document.readyState === 'complete') go(); else root.addEventListener('load', go, { once: true });
    document.addEventListener('visibilitychange', function () { if (document.hidden) flush(); });
    root.addEventListener('pagehide', function () { flush(); });
    function early() { ui(null); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(early, 2500); }, { once: true });
    else setTimeout(early, 2500);
  })();

  return Object.freeze({
    version: VERSION, LEGEND: LEGEND,
    getMeta: getMeta, describe: describe,
    check: check, report: report, reportAsync: reportAsync, runModuleTests: runModuleTests,
    verdict: verdict, selfTest: selfTest, links: links,
    ensureStable: ensureStable, guard: guard, configure: configure,
    buildFingerprint: buildFingerprint, buildInfo: buildInfo,
    sha256Hex: sha256Hex, hashImpl: hashImpl,
    exportManifest: exportManifest, rebaseline: rebaseline, refresh: function () { return sweep(true); },
    signSnapshot: signSnapshot, verifySnapshot: verifySnapshot,
    exportAudit: exportAudit, verifyAudit: verifyAudit, flush: flush,
    modules: function () { return REG.map(function (m) { return m.id; }); }
  });
});

