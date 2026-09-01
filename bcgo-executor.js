/* ============================================================
   BCGO INTERNAL EXECUTOR
   Version 3.1.0
   ------------------------------------------------------------
   Request Manager + Approval Gate + Execution Manager +
   Source Manager + Persistence Manager + Audit Manager.
   Pure internal browser runtime. No external API.
   ============================================================ */
(() => {
  "use strict";

  const VERSION = "3.1.0";
  const ENGINE = "BCGO_INTERNAL_EXECUTOR";
  const STATUS = Object.freeze({
    OFFLINE: "OFFLINE", READY: "READY", DEGRADED: "DEGRADED",
    WAITING_APPROVAL: "WAITING_APPROVAL", VALIDATING: "VALIDATING",
    EXECUTING: "EXECUTING", PERSISTING: "PERSISTING",
    VERIFYING_PERSISTENCE: "VERIFYING_PERSISTENCE", SUCCESS: "SUCCESS",
    REJECTED: "REJECTED", FAILED: "FAILED"
  });

  const STORAGE_DB = "BCGO_INTERNAL_EXECUTOR";
  const STORAGE_VERSION = 2;
  const STORAGE_STORE = "sources";
  const AUDIT_STORE = "audit";
  const MAX_HISTORY = 100;
  const sourceHandles = new Map();

  const state = {
    status: STATUS.OFFLINE,
    request: null,
    result: null,
    history: [],
    source: null,
    persistence: null,
    health: { core: false, indexedDB: false, localFileAccess: false }
  };

  const core = () => window.BCGOExecutorCore || null;
  const now = () => new Date().toISOString();

  function emit() {
    window.dispatchEvent(new CustomEvent("bcgo-executor-state", { detail: getStatus() }));
  }
  function setStatus(status) { state.status = status; emit(); }

  function audit(event, detail = {}) {
    const record = Object.freeze({ timestamp: now(), engine: ENGINE, version: VERSION, event, ...detail });
    state.history.unshift(record);
    if (state.history.length > MAX_HISTORY) state.history.pop();
    saveAudit(record).catch(() => {});
    emit();
    return record;
  }

  function normalize(request) {
    if (!request || typeof request !== "object") throw new Error("INVALID_REQUEST");
    return {
      requestId: String(request.requestId || "").trim(),
      caseId: String(request.caseId || request.caseID || request.id || "").trim(),
      proposalId: String(request.proposalId || "").trim(),
      planId: String(request.planId || "").trim(),
      file: String(request.file || request.targetFile || request.target || "").trim(),
      operation: String(request.operation || "").toUpperCase(),
      before: typeof request.before === "string" ? request.before : (typeof request.beforeCode === "string" ? request.beforeCode : ""),
      after: typeof request.after === "string" ? request.after : (typeof request.afterCode === "string" ? request.afterCode : ""),
      approval: String(request.approval || request.approvalStatus || "").toUpperCase(),
      expectedFingerprint: request.expectedFingerprint || request.sourceFingerprint || request.expectedSha || "",
      actorUid: String(request.actorUid || "").trim(),
      sourceId: String(request.sourceId || request.file || "").trim()
    };
  }

  function validateRequest(r, source) {
    const errors = [];
    if (!r.requestId) errors.push("REQUEST_ID_REQUIRED");
    if (!r.caseId) errors.push("CASE_ID_REQUIRED");
    if (!r.file) errors.push("TARGET_FILE_REQUIRED");
    if (!core() || !Object.values(core().operations).includes(r.operation)) errors.push("UNSUPPORTED_OPERATION");
    if (!r.before) errors.push("BEFORE_REQUIRED");
    if (typeof r.after !== "string") errors.push("AFTER_REQUIRED");
    if (r.approval !== "APPROVED") errors.push("HUMAN_APPROVAL_REQUIRED");
    if (typeof source !== "string") errors.push("SOURCE_REQUIRED");
    return errors;
  }

  function isApproved(request) { try { return normalize(request).approval === "APPROVED"; } catch { return false; } }

  function openDB() {
    return new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) return reject(new Error("INDEXEDDB_UNAVAILABLE"));
      const req = indexedDB.open(STORAGE_DB, STORAGE_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORAGE_STORE)) db.createObjectStore(STORAGE_STORE);
        if (!db.objectStoreNames.contains(AUDIT_STORE)) db.createObjectStore(AUDIT_STORE, { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("INDEXEDDB_OPEN_FAILED"));
      req.onblocked = () => reject(new Error("INDEXEDDB_BLOCKED"));
    });
  }

  function putRecord(storeName, key, value) {
    return openDB().then(db => new Promise((resolve, reject) => {
      let closed = false;
      const close = () => { if (!closed) { closed = true; db.close(); } };
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).put(value, key);
      tx.oncomplete = () => { close(); resolve(value); };
      tx.onerror = () => { const e = tx.error || new Error("STORE_WRITE_FAILED"); close(); reject(e); };
      tx.onabort = () => { const e = tx.error || new Error("STORE_WRITE_ABORTED"); close(); reject(e); };
    }));
  }

  function getRecord(storeName, key) {
    return openDB().then(db => new Promise((resolve, reject) => {
      let closed = false;
      const close = () => { if (!closed) { closed = true; db.close(); } };
      const tx = db.transaction(storeName, "readonly");
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => { const e = req.error || new Error("STORE_READ_FAILED"); close(); reject(e); };
      tx.oncomplete = () => { close(); };
      tx.onabort = () => { close(); reject(tx.error || new Error("STORE_READ_ABORTED")); };
    }));
  }

  function saveAudit(record) {
    return putRecord(AUDIT_STORE, `${record.timestamp}_${Math.random().toString(16).slice(2)}`, record);
  }

  async function healthCheck() {
    state.health.core = !!core() && core().selfTest();
    try {
      const db = await openDB(); db.close(); state.health.indexedDB = true;
    } catch { state.health.indexedDB = false; }
    state.health.localFileAccess = typeof window.showOpenFilePicker === "function" && typeof FileSystemFileHandle !== "undefined";
    if (!state.health.core) setStatus(STATUS.OFFLINE);
    else if (!state.health.indexedDB) setStatus(STATUS.DEGRADED);
    else setStatus(STATUS.READY);
    audit("HEALTH_CHECK", { ...state.health });
    return { ...state.health };
  }

  async function registerSource(sourceId, text, metadata = {}) {
    if (!core()) throw new Error("CORE_NOT_READY");
    if (!sourceId) throw new Error("SOURCE_ID_REQUIRED");
    if (typeof text !== "string") throw new Error("SOURCE_MUST_BE_STRING");
    const record = { sourceId, file: metadata.file || sourceId, content: text, fingerprint: core().fingerprint(text), updatedAt: now(), origin: metadata.origin || "BCGO_INTERNAL_REPOSITORY", metadata };
    await putRecord(STORAGE_STORE, sourceId, record);
    state.source = record;
    state.persistence = { ok: true, mode: "INTERNAL_REPOSITORY", sourceId, fingerprint: record.fingerprint, persistedAt: now() };
    audit("SOURCE_REGISTERED", { sourceId, fingerprint: record.fingerprint });
    emit();
    return record;
  }

  async function getSource(sourceId) {
    if (!sourceId) return null;
    const handle = sourceHandles.get(sourceId);
    if (handle) {
      try {
        const file = await handle.getFile();
        const text = await file.text();
        return { sourceId, file: file.name, content: text, fingerprint: core().fingerprint(text), origin: "LOCAL_FILE_HANDLE" };
      } catch {}
    }
    return getRecord(STORAGE_STORE, sourceId);
  }

  async function bindLocalFile(sourceId, fileHandle) {
    if (!fileHandle || typeof fileHandle.getFile !== "function") throw new Error("INVALID_FILE_HANDLE");
    sourceHandles.set(sourceId, fileHandle);
    const file = await fileHandle.getFile();
    const text = await file.text();
    await registerSource(sourceId, text, { file: file.name, origin: "LOCAL_FILE_HANDLE" });
    audit("SOURCE_HANDLE_BOUND", { sourceId, file: file.name });
    return getSource(sourceId);
  }

  async function persistSource(sourceId, content, metadata = {}) {
    if (!core()) throw new Error("CORE_NOT_READY");
    if (!sourceId) throw new Error("SOURCE_ID_REQUIRED");
    if (typeof content !== "string") throw new Error("SOURCE_MUST_BE_STRING");
    const expectedBefore = metadata.expectedBeforeFingerprint || "";
    const actualAfter = core().fingerprint(content);

    const previous = await getSource(sourceId);
    if (expectedBefore && previous && !core().fingerprintsEqual(expectedBefore, previous.fingerprint)) {
      throw new Error("SOURCE_CHANGED_BEFORE_PERSISTENCE");
    }

    const handle = sourceHandles.get(sourceId);
    if (handle && typeof handle.createWritable === "function") {
      const writable = await handle.createWritable();
      try { await writable.write(content); await writable.close(); }
      catch (error) { try { await writable.abort(); } catch {} throw error; }
      const file = await handle.getFile();
      const readBack = await file.text();
      const readBackFingerprint = core().fingerprint(readBack);
      if (readBackFingerprint !== actualAfter || readBack !== content) throw new Error("PERSISTENCE_READBACK_MISMATCH");
      const record = { sourceId, file: file.name, content: readBack, fingerprint: readBackFingerprint, updatedAt: now(), origin: "LOCAL_FILE_HANDLE" };
      await putRecord(STORAGE_STORE, sourceId, record);
      state.persistence = { ok: true, mode: "LOCAL_FILE", sourceId, fingerprint: readBackFingerprint, persistedAt: now() };
      return state.persistence;
    }

    const record = { sourceId, file: metadata.file || sourceId, content, fingerprint: actualAfter, updatedAt: now(), origin: "BCGO_INTERNAL_REPOSITORY" };
    await putRecord(STORAGE_STORE, sourceId, record);
    const readBack = await getRecord(STORAGE_STORE, sourceId);
    if (!readBack || readBack.content !== content || !core().fingerprintsEqual(readBack.fingerprint, actualAfter)) throw new Error("PERSISTENCE_READBACK_MISMATCH");
    state.persistence = { ok: true, mode: "INTERNAL_REPOSITORY", sourceId, fingerprint: readBack.fingerprint, persistedAt: now() };
    return state.persistence;
  }

  async function prepare(request, sourceText) {
    if (!core()) return { ok: false, reason: "CORE_NOT_READY" };
    let r;
    try { r = normalize(request); } catch (e) { return { ok: false, reason: e.message }; }
    const errors = validateRequest(r, sourceText);
    if (errors.length) return { ok: false, reason: "REQUEST_REJECTED", errors };
    const gate = core().validateBefore(sourceText, r.expectedFingerprint);
    if (!gate.ok) return { ok: false, reason: "SOURCE_FINGERPRINT_MISMATCH", gate };
    return { ok: true, request: r, sourceBefore: sourceText, sourceFingerprint: gate.actual };
  }

  async function execute(request, sourceText = null) {
    state.request = request; state.result = null; state.persistence = null;
    let r;
    try { r = normalize(request); } catch (e) { return fail("INVALID_REQUEST", { error: e.message }); }
    audit("REQUEST_RECEIVED", { requestId: r.requestId, caseId: r.caseId, file: r.file });

    if (r.approval !== "APPROVED") { setStatus(STATUS.WAITING_APPROVAL); return reject("HUMAN_APPROVAL_REQUIRED"); }
    if (!core()) return fail("CORE_NOT_READY");
    if (!state.health.indexedDB) await healthCheck();
    const sourceId = r.sourceId || r.file;
    let source = sourceText;
    if (source == null) {
      const stored = await getSource(sourceId).catch(() => null);
      source = stored ? stored.content : null;
    }

    setStatus(STATUS.VALIDATING);
    const prepared = await prepare(request, source);
    if (!prepared.ok) return reject(prepared.reason, prepared);
    audit("APPROVAL_ACCEPTED", { requestId: r.requestId, caseId: r.caseId });

    setStatus(STATUS.EXECUTING);
    audit("EXECUTION_STARTED", { requestId: r.requestId, caseId: r.caseId, file: r.file, operation: r.operation });
    const patch = core().processPatch({ source, before: r.before, after: r.after, operation: r.operation, expectedFingerprint: r.expectedFingerprint });
    if (!patch.ok) return reject("PATCH_PIPELINE_FAILED", patch);
    audit("PATCH_VALIDATED", { requestId: r.requestId, beforeFingerprint: patch.beforeFingerprint, afterFingerprint: patch.afterFingerprint });

    setStatus(STATUS.PERSISTING);
    audit("PERSISTENCE_STARTED", { sourceId, file: r.file });
    try {
      await persistSource(sourceId, patch.sourceAfter, { file: r.file, expectedBeforeFingerprint: patch.beforeFingerprint });
    } catch (error) {
      return fail("PERSISTENCE_FAILED", { error: error.message, sourceId, beforeFingerprint: patch.beforeFingerprint, afterFingerprint: patch.afterFingerprint });
    }

    setStatus(STATUS.VERIFYING_PERSISTENCE);
    const persisted = await getSource(sourceId).catch(() => null);
    if (!persisted || persisted.content !== patch.sourceAfter || !core().fingerprintsEqual(persisted.fingerprint, patch.afterFingerprint)) {
      return fail("PERSISTENCE_VERIFICATION_FAILED", { sourceId, expectedFingerprint: patch.afterFingerprint, actualFingerprint: persisted?.fingerprint || null });
    }
    audit("PERSISTENCE_VERIFIED", { sourceId, fingerprint: persisted.fingerprint });

    const result = Object.freeze({ executor: ENGINE, version: VERSION, status: STATUS.SUCCESS, requestId: r.requestId, caseId: r.caseId, proposalId: r.proposalId, planId: r.planId, file: r.file, sourceId, operation: r.operation, sourceBefore: patch.sourceBefore, sourceAfter: patch.sourceAfter, beforeFingerprint: patch.beforeFingerprint, afterFingerprint: patch.afterFingerprint, diff: patch.diff, validation: patch.validation, persistence: state.persistence, executedAt: now() });
    state.result = result; state.source = persisted;
    audit("EXECUTION_SUCCESS", { requestId: r.requestId, caseId: r.caseId, sourceId, afterFingerprint: result.afterFingerprint });
    setStatus(STATUS.SUCCESS);
    return result;
  }

  function reject(reason, detail = null) {
    const result = { executor: ENGINE, version: VERSION, status: STATUS.REJECTED, reason, detail, executedAt: now() };
    state.result = result; audit("EXECUTION_REJECTED", { reason, detail }); setStatus(STATUS.REJECTED); return result;
  }
  function fail(reason, detail = null) {
    const result = { executor: ENGINE, version: VERSION, status: STATUS.FAILED, reason, detail, executedAt: now() };
    state.result = result; audit("EXECUTION_FAILED", { reason, detail }); setStatus(STATUS.FAILED); return result;
  }
  function attachRequest(request) { state.request = request; const approved = isApproved(request); setStatus(approved ? STATUS.READY : STATUS.WAITING_APPROVAL); audit("REQUEST_ATTACHED", { approved }); return getStatus(); }
  function reset() { state.request = null; state.result = null; state.persistence = null; setStatus(state.health.core && state.health.indexedDB ? STATUS.READY : STATUS.DEGRADED); audit("RUNTIME_RESET"); }
  function getStatus() { return { engine: ENGINE, version: VERSION, coreReady: !!core(), status: state.status, hasRequest: !!state.request, source: state.source, persistence: state.persistence, health: { ...state.health }, lastResult: state.result, history: state.history.slice() }; }

  async function listSources() {
    try {
      const db = await openDB();
      return await new Promise((resolve, reject) => {
        let closed = false; const close = () => { if (!closed) { closed = true; db.close(); } };
        const tx = db.transaction(STORAGE_STORE, "readonly"); const req = tx.objectStore(STORAGE_STORE).getAll();
        req.onsuccess = () => resolve(req.result || []); req.onerror = () => { close(); reject(req.error); }; tx.oncomplete = close; tx.onabort = () => { close(); reject(tx.error); };
      });
    } catch { return []; }
  }

  async function exportSource(sourceId) {
    const source = await getSource(sourceId);
    if (!source) throw new Error("SOURCE_NOT_FOUND");
    return source;
  }

  async function importSource(file) {
    if (!file || typeof file.text !== "function") throw new Error("INVALID_FILE");
    const text = await file.text();
    return registerSource(file.name, text, { file: file.name, origin: "USER_IMPORTED_SOURCE" });
  }

  window.BCGOInternalExecutor = Object.freeze({
    name: ENGINE, version: VERSION, status: STATUS,
    normalize, validateRequest, isApproved, healthCheck,
    registerSource, getSource, bindLocalFile, persistSource,
    prepare, execute, attachRequest, reset, getStatus,
    getHistory: () => state.history.slice(), listSources, exportSource, importSource
  });

  async function boot() {
    if (!core()) { setStatus(STATUS.OFFLINE); return; }
    await healthCheck();
    try {
      const existing = await getSource("demo-config.js");
      if (!existing) await registerSource("demo-config.js", "// CIKUR GO Internal Demo Config\nconst STATUS_MODE = \"STABLE_OFFLINE\";\nconst ROUTE_VERSION = \"v3.1.0\";\n", { file: "demo-config.js" });
      else state.source = existing;
    } catch (e) {
      audit("DEMO_SOURCE_INIT_FAILED", { error: e.message });
      if (state.status === STATUS.READY) setStatus(STATUS.DEGRADED);
    }
    emit();
  }

  if (core()) boot(); else window.addEventListener("bcgo-executor-core-ready", boot, { once: true });
})();
