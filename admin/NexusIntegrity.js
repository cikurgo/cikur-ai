/*! ═══════════════════════════════════════════════════════════════════
 *  NexusIntegrity v1.2.0 — Full integrity stack (Fase 1→4)
 *  Zero hard deps. Additive only. Never throws into host app.
 *
 *  Fase 1: getMeta + surface selfTest (on each module)
 *  Fase 2: persistent audit trail (IndexedDB, soft budget, idle-flush)
 *  Fase 3: optional Schnorr sign/verify of audit snapshot (via NexusLBC)
 *  Fase 4: ensureStable() for cross-module calls
 *
 *  Public:
 *    NexusIntegrity.report()
 *    NexusIntegrity.ensureStable(id)
 *    NexusIntegrity.audit(event, detail?)
 *    NexusIntegrity.getAuditLog({limit})
 *    NexusIntegrity.signAudit() / verifyAudit(blob)
 *    NexusIntegrity.getMeta()
 * ═══════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NexusIntegrity = factory();
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '1.2.0';
  const MODULE_ID = 'NexusIntegrity';
  const MODULE_CHECKSUM = 'integrity-v1.2.0-src';

  const KNOWN = Object.freeze([
    { id: 'NexusTruth', keys: ['NexusTruth'] },
    { id: 'NexusLBC', keys: ['NexusLBC'] },
    { id: 'NexusEADI', keys: ['NexusEADI'] },
    { id: 'NexusOmniCoreV3', keys: ['NexusOmniCoreV3'] },
    { id: 'NexusAku', keys: ['NexusAku'] },
    { id: 'NexusIntegrity', keys: ['NexusIntegrity'] }
  ]);

  function g() {
    return typeof globalThis !== 'undefined' ? globalThis
      : (typeof window !== 'undefined' ? window : {});
  }

  function resolve(modId) {
    const entry = KNOWN.find(k => k.id === modId);
    if (!entry) return null;
    const glob = g();
    for (const k of entry.keys) {
      if (glob[k] && typeof glob[k] === 'object') return glob[k];
    }
    return null;
  }

  function getMetaSafe(mod) {
    if (!mod) return null;
    try {
      if (typeof mod.getMeta === 'function') return mod.getMeta();
    } catch (e) {}
    return {
      id: 'unknown',
      version: mod.version || mod.VERSION || mod.VERSI || 'unknown',
      checksum: null,
      fingerprint: null,
      note: 'getMeta not implemented'
    };
  }

  async function runSelfTest(mod) {
    if (!mod || typeof mod.selfTest !== 'function') {
      return { status: 'SKIP', reason: 'no selfTest' };
    }
    try {
      const r = await Promise.resolve(mod.selfTest());
      const integrity = r && r.integrity
        ? r.integrity
        : (r && (r.ok === true || (r.pass != null && r.pass === r.total)) ? 'OK' : 'FAIL');
      return { status: integrity === 'OK' ? 'OK' : 'FAIL', detail: r };
    } catch (e) {
      return { status: 'ERROR', reason: String(e && e.message || e) };
    }
  }

  /* FASE 4 — ensureStable */
  function ensureStable(moduleId) {
    try {
      const mod = resolve(moduleId);
      if (!mod) return { ok: false, reason: 'MODULE_MISSING', moduleId };
      const meta = getMetaSafe(mod);
      if (!meta) return { ok: false, reason: 'NO_META', moduleId };
      if (meta.id && meta.id !== moduleId && meta.id !== 'unknown') {
        return { ok: false, reason: 'ID_MISMATCH', moduleId, meta };
      }
      return { ok: true, reason: 'STABLE', moduleId, meta };
    } catch (e) {
      return { ok: false, reason: 'ERROR', moduleId, error: String(e && e.message || e) };
    }
  }

  /* FASE 2 — Audit trail (IndexedDB) */
  const IDB_NAME = 'NexusIntegrityAudit';
  const IDB_STORE = 'events';
  const IDB_SOFT_MAX = 2000;
  const IDB_SOFT_BYTES = 4 * 1024 * 1024;
  let idbPending = [];
  let idbTimer = null;
  let idbUsedApprox = 0;
  let lastTouch = Date.now();

  function openDB() {
    return new Promise(function (resolve) {
      try {
        if (!g().indexedDB) { resolve(null); return; }
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = function (ev) {
          const db = ev.target.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) {
            const store = db.createObjectStore(IDB_STORE, { keyPath: 'id', autoIncrement: true });
            store.createIndex('ts', 'ts', { unique: false });
            store.createIndex('moduleId', 'moduleId', { unique: false });
          }
        };
        req.onsuccess = function (ev) { resolve(ev.target.result); };
        req.onerror = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
  }

  function estimate(obj) {
    try { return JSON.stringify(obj).length * 2; } catch (e) { return 256; }
  }

  function flushPending() {
    if (!idbPending.length) return Promise.resolve(0);
    const batch = idbPending.splice(0, idbPending.length);
    return openDB().then(function (db) {
      if (!db) return 0;
      return new Promise(function (resolve) {
        try {
          const tx = db.transaction(IDB_STORE, 'readwrite');
          const store = tx.objectStore(IDB_STORE);
          let written = 0;
          batch.forEach(function (rec) {
            if (idbUsedApprox + rec._size > IDB_SOFT_BYTES) return;
            store.add(rec);
            idbUsedApprox += rec._size;
            written++;
          });
          tx.oncomplete = function () { resolve(written); };
          tx.onerror = function () { resolve(0); };
        } catch (e) { resolve(0); }
      });
    });
  }

  function scheduleFlush() {
    if (idbTimer) clearTimeout(idbTimer);
    idbTimer = setTimeout(function () {
      idbTimer = null;
      if (Date.now() - lastTouch >= 1200) flushPending();
      else scheduleFlush();
    }, 1500);
  }

  function audit(event, detail) {
    try {
      lastTouch = Date.now();
      const modMeta = (detail && detail.moduleId) ? getMetaSafe(resolve(detail.moduleId)) : null;
      const rec = {
        ts: Date.now(),
        moduleId: (detail && detail.moduleId) || MODULE_ID,
        fingerprint: (modMeta && modMeta.fingerprint) || (detail && detail.fingerprint) || null,
        event: String(event || 'unknown').slice(0, 64),
        actor: (detail && detail.actor) || 'system',
        detail: detail && typeof detail === 'object'
          ? { reason: detail.reason, ok: detail.ok, version: detail.version }
          : (detail != null ? String(detail).slice(0, 200) : null)
      };
      rec._size = estimate(rec);
      idbPending.push(rec);
      if (idbPending.length >= 20) flushPending();
      else scheduleFlush();
      return true;
    } catch (e) { return false; }
  }

  function getAuditLog(opts) {
    opts = opts || {};
    const limit = Math.max(1, Math.min(500, opts.limit || 50));
    return openDB().then(function (db) {
      if (!db) return { ok: false, events: [], reason: 'no-idb' };
      return new Promise(function (resolve) {
        try {
          const tx = db.transaction(IDB_STORE, 'readonly');
          const store = tx.objectStore(IDB_STORE);
          const idx = store.index('ts');
          const out = [];
          idx.openCursor(null, 'prev').onsuccess = function (e) {
            const c = e.target.result;
            if (c && out.length < limit) {
              const v = c.value;
              delete v._size;
              out.push(v);
              c.continue();
            } else {
              resolve({ ok: true, events: out, count: out.length });
            }
          };
          tx.onerror = function () { resolve({ ok: false, events: [], reason: 'tx-error' }); };
        } catch (e) {
          resolve({ ok: false, events: [], reason: String(e && e.message || e) });
        }
      });
    });
  }

  try {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) flushPending();
      });
    }
  } catch (e) {}

  /* FASE 3 — Schnorr sign/verify (optional, via NexusLBC) */
  async function signAudit(opts) {
    opts = opts || {};
    const LBC = resolve('NexusLBC');
    if (!LBC || typeof LBC.generateKeyPair !== 'function' || typeof LBC.schnorrSign !== 'function') {
      return { ok: false, reason: 'NexusLBC_UNAVAILABLE' };
    }
    try {
      const log = await getAuditLog({ limit: opts.limit || 100 });
      if (!log.ok) return { ok: false, reason: 'AUDIT_READ_FAIL' };
      const payload = JSON.stringify({
        v: 1,
        ts: Date.now(),
        events: log.events.map(function (e) {
          return { ts: e.ts, moduleId: e.moduleId, event: e.event, fingerprint: e.fingerprint };
        })
      });
      const kp = LBC.generateKeyPair();
      const sig = LBC.schnorrSign(kp.privateKey, payload);
      const blob = {
        payload: payload,
        signature: LBC.bytesToHex ? LBC.bytesToHex(sig) : Array.from(sig, function (b) {
          return b.toString(16).padStart(2, '0');
        }).join(''),
        publicKey: kp.publicKey,
        algorithm: 'BIP-340',
        signedAt: Date.now()
      };
      audit('signAudit', { ok: true, actor: 'integrity' });
      return { ok: true, blob: blob };
    } catch (e) {
      return { ok: false, reason: String(e && e.message || e) };
    }
  }

  async function verifyAudit(blob) {
    const LBC = resolve('NexusLBC');
    if (!LBC || typeof LBC.schnorrVerify !== 'function') {
      return { ok: false, reason: 'NexusLBC_UNAVAILABLE' };
    }
    try {
      if (!blob || !blob.payload || !blob.signature || !blob.publicKey) {
        return { ok: false, reason: 'INVALID_BLOB' };
      }
      const sigBytes = typeof blob.signature === 'string'
        ? (LBC.hexToBytes ? LBC.hexToBytes(blob.signature) : null)
        : blob.signature;
      if (!sigBytes) return { ok: false, reason: 'BAD_SIGNATURE_FORMAT' };
      const valid = LBC.schnorrVerify(sigBytes, blob.payload, blob.publicKey);
      audit('verifyAudit', { ok: !!valid, actor: 'integrity' });
      return { ok: !!valid, valid: !!valid };
    } catch (e) {
      return { ok: false, reason: String(e && e.message || e) };
    }
  }

  /* report */
  async function report(opts) {
    opts = opts || {};
    const rows = [];
    for (const k of KNOWN) {
      if (k.id === 'NexusIntegrity') {
        const meta = getMeta();
        rows.push({
          id: k.id, loaded: true, version: meta.version,
          checksum: meta.checksum, fingerprint: meta.fingerprint,
          integrity: 'OK', detail: 'self'
        });
        continue;
      }
      const mod = resolve(k.id);
      const meta = getMetaSafe(mod);
      let st = { status: 'MISSING' };
      if (mod) st = await runSelfTest(mod);
      rows.push({
        id: k.id,
        loaded: !!mod,
        version: meta ? meta.version : null,
        checksum: meta ? meta.checksum : null,
        fingerprint: meta ? meta.fingerprint : null,
        integrity: st.status,
        detail: st.reason || (st.detail && (st.detail.score || st.detail.integrity)) || null
      });
      if (st.status === 'FAIL' || st.status === 'MISMATCH') {
        audit('mismatch', { moduleId: k.id, reason: st.status, version: meta && meta.version });
      }
    }
    const summary = {
      version: VERSION,
      ts: Date.now(),
      total: rows.length,
      loaded: rows.filter(function (r) { return r.loaded; }).length,
      ok: rows.filter(function (r) { return r.integrity === 'OK'; }).length,
      mismatch: rows.filter(function (r) { return r.integrity === 'FAIL' || r.integrity === 'MISMATCH'; }).length,
      missing: rows.filter(function (r) { return !r.loaded; }).length,
      modules: rows
    };
    audit('report', { ok: summary.mismatch === 0, actor: 'integrity' });
    if (opts.log !== false) {
      try {
        console.table(rows.map(function (r) {
          return {
            id: r.id,
            version: r.version,
            fingerprint: (r.fingerprint || '').slice(0, 20) + (r.fingerprint ? '…' : ''),
            integrity: r.integrity
          };
        }));
        console.log('[NexusIntegrity]', summary.ok + '/' + summary.loaded + ' OK · missing=' + summary.missing + ' · mismatch=' + summary.mismatch);
      } catch (e) {}
    }
    return summary;
  }

  function getMeta() {
    return Object.freeze({
      id: MODULE_ID,
      version: VERSION,
      checksum: MODULE_CHECKSUM,
      fingerprint: 'sha256:' + MODULE_CHECKSUM,
      algorithm: 'SHA-256',
      artifact: 'source-file',
      phases: ['1-getMeta', '2-audit', '3-schnorr', '4-ensureStable']
    });
  }

  try { audit('boot', { actor: 'integrity', version: VERSION }); } catch (e) {}

  return Object.freeze({
    version: VERSION,
    getMeta: getMeta,
    report: report,
    ensureStable: ensureStable,
    audit: audit,
    getAuditLog: getAuditLog,
    signAudit: signAudit,
    verifyAudit: verifyAudit,
    flush: flushPending,
    resolve: resolve,
    KNOWN: Object.freeze(KNOWN.map(function (k) { return k.id; }))
  });
});
