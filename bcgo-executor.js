/* ============================================================
   BCGO INTERNAL EXECUTOR
   Version 3.1.0 (Production Enhanced)
   ------------------------------------------------------------
   Orchestration + Request + Approval + Source + Persistence +
   Audit management.
   No external service is used as the execution brain.
   ============================================================ */
(() => {
  "use strict";

  const VERSION = "3.1.0";
  const ENGINE = "BCGO_INTERNAL_EXECUTOR";

  const STATUS = Object.freeze({
    OFFLINE: "OFFLINE",
    READY: "READY",
    WAITING_APPROVAL: "WAITING_APPROVAL",
    VALIDATING: "VALIDATING",
    EXECUTING: "EXECUTING",
    PERSISTING: "PERSISTING",
    VERIFYING_PERSISTENCE: "VERIFYING_PERSISTENCE",
    SUCCESS: "SUCCESS",
    REJECTED: "REJECTED",
    FAILED: "FAILED"
  });

  const STORAGE_DB = "BCGO_INTERNAL_EXECUTOR";
  const STORAGE_STORE = "sources";
  const AUDIT_STORE = "audit";

  const state = {
    status: STATUS.OFFLINE,
    request: null,
    result: null,
    history: [],
    source: null,
    persistence: null,
    nerve: {
      status: "DISCONNECTED",
      lastAt: 0,
      lastType: null,
      cycle: null,
      step: null,
      telemetryFile: null,
      active: 0,
      total: 0,
      eventCount: 0,
      source: "NONE"
    }
  };

  const MAX_HISTORY = 100;
  const core = () => window.BCGOExecutorCore;
  const now = () => new Date().toISOString();

  function emit() {
    window.dispatchEvent(new CustomEvent("bcgo-executor-state", {
      detail: getStatus()
    }));
  }

  function setStatus(status) {
    state.status = status;
    emit();
  }

  function audit(event, detail = {}) {
    const record = Object.freeze({
      timestamp: now(),
      engine: ENGINE,
      version: VERSION,
      event,
      ...detail
    });

    state.history.unshift(record);
    if (state.history.length > MAX_HISTORY) state.history.pop();

    saveAudit(record).catch(() => {});
    return record;
  }

  function normalize(request) {
    if (!request || typeof request !== "object") {
      throw new Error("INVALID_REQUEST");
    }

    return {
      requestId: String(request.requestId || "").trim(),
      caseId: String(request.caseId || request.caseID || request.id || "").trim(),
      proposalId: String(request.proposalId || "").trim(),
      planId: String(request.planId || "").trim(),
      file: String(request.file || request.targetFile || request.target || "").trim(),
      operation: String(request.operation || "").toUpperCase(),
      before: typeof request.before === "string"
        ? request.before
        : (typeof request.beforeCode === "string" ? request.beforeCode : ""),
      after: typeof request.after === "string"
        ? request.after
        : (typeof request.afterCode === "string" ? request.afterCode : ""),
      approval: String(request.approval || request.approvalStatus || "").toUpperCase(),
      expectedFingerprint:
        request.expectedFingerprint ||
        request.sourceFingerprint ||
        request.expectedSha ||
        "",
      actorUid: String(request.actorUid || "").trim(),
      sourceId: String(request.sourceId || request.file || "").trim()
    };
  }

  function validateRequest(r, source) {
    const errors = [];
    if (!r.caseId) errors.push("CASE_ID_REQUIRED");
    if (!r.file) errors.push("TARGET_FILE_REQUIRED");
    if (!core() || !Object.values(core().operations).includes(r.operation)) {
      errors.push("UNSUPPORTED_OPERATION");
    }
    if (!r.before) errors.push("BEFORE_REQUIRED");
    if (typeof r.after !== "string") errors.push("AFTER_REQUIRED");
    if (r.approval !== "APPROVED") errors.push("HUMAN_APPROVAL_REQUIRED");
    if (typeof source !== "string") errors.push("SOURCE_REQUIRED");
    return errors;
  }

  function isApproved(request) {
    try {
      return normalize(request).approval === "APPROVED";
    } catch {
      return false;
    }
  }

  /* ============================================================
     INTERNAL BCGO NERVE MONITOR
     ------------------------------------------------------------
     Consumes the existing CIKUR_GO_BCGO_MEDICINE_V1 bridge.
     This is browser-native same-origin communication only:
     BroadcastChannel + localStorage fallback.
     No external API, no network request, no Firebase Function.
     The indicator is GREEN only after a real BCGO_STATE packet
     is received within the live window.
     ============================================================ */
  const NERVE_CHANNEL = "CIKUR_GO_BCGO_MEDICINE_V1";
  const NERVE_STATE_KEY = `${NERVE_CHANNEL}_STATE`;
  const NERVE_LIVE_WINDOW = 15000;
  const nerveChannel = typeof BroadcastChannel !== "undefined"
    ? new BroadcastChannel(NERVE_CHANNEL)
    : null;
  const seenNervePackets = new Set();

  function updateNerve(packet, source = "BROADCAST") {
    if (!packet || packet.bridge !== NERVE_CHANNEL || packet.from !== "BCGO") return false;
    if (packet.type !== "BCGO_STATE" || !packet.state || typeof packet.state !== "object") return false;
    const at = Number(packet.at) || 0;
    if (!at) return false;
    const id = String(packet.id || `BCGO_STATE-${at}`);
    if (seenNervePackets.has(id)) return false;
    seenNervePackets.add(id);
    if (seenNervePackets.size > 200) {
      const first = seenNervePackets.values().next().value;
      seenNervePackets.delete(first);
    }
    state.nerve = {
      ...state.nerve,
      status: (Date.now() - at) <= NERVE_LIVE_WINDOW ? "LIVE" : "STALE",
      lastAt: at,
      lastType: packet.type,
      cycle: packet.state.cycle ?? null,
      step: packet.state.step ?? null,
      telemetryFile: packet.state.lastTelemetryFile || null,
      active: Number(packet.state.metrics?.active) || 0,
      total: Number(packet.state.metrics?.total) || 0,
      eventCount: Number(packet.state.recentEvents?.length) || 0,
      source
    };
    emit();
    return true;
  }

  function refreshNerveStatus() {
    if (!state.nerve.lastAt) return state.nerve;
    const age = Date.now() - state.nerve.lastAt;
    state.nerve.status = age <= NERVE_LIVE_WINDOW ? "LIVE" : "STALE";
    return state.nerve;
  }

  function startNerveMonitor() {
    try {
      nerveChannel?.addEventListener("message", event => updateNerve(event.data, "BROADCAST_CHANNEL"));
    } catch {}
    try {
      window.addEventListener("storage", event => {
        if (event.key !== NERVE_STATE_KEY || !event.newValue) return;
        try { updateNerve(JSON.parse(event.newValue), "LOCAL_STORAGE"); } catch {}
      });
    } catch {}
    try {
      if (window.BCGO_STATE && typeof window.BCGO_STATE === "object") {
        updateNerve({ bridge: NERVE_CHANNEL, from: "BCGO", type: "BCGO_STATE", at: Date.now(), id: "BOOTSTRAP_BCGO_STATE", state: window.BCGO_STATE }, "SAME_PAGE_STATE");
      }
      const cached = localStorage.getItem(NERVE_STATE_KEY);
      if (cached) updateNerve(JSON.parse(cached), "LOCAL_STORAGE_CACHE");
    } catch {}
    setInterval(() => { refreshNerveStatus(); emit(); }, 3000);
  }

  const sourceHandles = new Map();

  async function registerSource(sourceId, text, metadata = {}) {
    if (!sourceId) throw new Error("SOURCE_ID_REQUIRED");
    if (typeof text !== "string") throw new Error("SOURCE_MUST_BE_STRING");

    const record = {
      sourceId,
      file: metadata.file || sourceId,
      content: text,
      fingerprint: core().fingerprint(text),
      updatedAt: now(),
      metadata
    };

    await putRecord(STORAGE_STORE, sourceId, record);
    state.source = record;
    audit("SOURCE_REGISTERED", {
      sourceId,
      fingerprint: record.fingerprint
    });
    emit();
    return record;
  }

  async function getSource(sourceId) {
    if (!sourceId) return null;
    if (sourceHandles.has(sourceId)) {
      const handle = sourceHandles.get(sourceId);
      try {
        const file = await handle.getFile();
        const text = await file.text();
        return {
          sourceId,
          file: file.name,
          content: text,
          fingerprint: core().fingerprint(text),
          origin: "LOCAL_FILE_HANDLE"
        };
      } catch {}
    }
    return getRecord(STORAGE_STORE, sourceId);
  }

  async function bindLocalFile(sourceId, fileHandle) {
    if (!fileHandle || typeof fileHandle.getFile !== "function") {
      throw new Error("INVALID_FILE_HANDLE");
    }
    sourceHandles.set(sourceId, fileHandle);
    const source = await getSource(sourceId);
    if (source) await registerSource(sourceId, source.content, {
      file: source.file,
      origin: "LOCAL_FILE_HANDLE"
    });
    audit("SOURCE_HANDLE_BOUND", { sourceId });
    return getSource(sourceId);
  }

  async function persistSource(sourceId, content, metadata = {}) {
    if (!sourceId) throw new Error("SOURCE_ID_REQUIRED");
    if (typeof content !== "string") throw new Error("SOURCE_MUST_BE_STRING");

    const expected = metadata.expectedFingerprint || "";
    const actual = core().fingerprint(content);

    const handle = sourceHandles.get(sourceId);

    if (handle && typeof handle.createWritable === "function") {
      // Concurrency gate: verify the CURRENT local file before opening a writer.
      // Never mutate a file when the source has changed since Medicine prepared it.
      const currentFile = await handle.getFile();
      const currentText = await currentFile.text();
      const currentFingerprint = core().fingerprint(currentText);
      if (expected && !core().fingerprintsEqual(expected, currentFingerprint)) {
        throw new Error("SOURCE_CHANGED_BEFORE_PERSISTENCE");
      }

      const writable = await handle.createWritable();
      try {
        await writable.write(content);
        await writable.close();
      } catch (error) {
        try { await writable.abort(); } catch {}
        throw error;
      }

      const file = await handle.getFile();
      const readBack = await file.text();
      const readBackFingerprint = core().fingerprint(readBack);

      if (readBackFingerprint !== actual) {
        throw new Error("PERSISTENCE_READBACK_MISMATCH");
      }

      const record = {
        sourceId,
        file: file.name,
        content: readBack,
        fingerprint: readBackFingerprint,
        updatedAt: now(),
        origin: "LOCAL_FILE_HANDLE"
      };
      await putRecord(STORAGE_STORE, sourceId, record);
      state.persistence = {
        ok: true,
        mode: "LOCAL_FILE",
        sourceId,
        fingerprint: readBackFingerprint,
        persistedAt: now()
      };
      return state.persistence;
    }

    const currentRecord = await getRecord(STORAGE_STORE, sourceId);
    if (expected && currentRecord &&
        !core().fingerprintsEqual(expected, currentRecord.fingerprint)) {
      throw new Error("SOURCE_CHANGED_BEFORE_PERSISTENCE");
    }

    const record = {
      sourceId,
      file: metadata.file || sourceId,
      content,
      fingerprint: actual,
      updatedAt: now(),
      origin: "BCGO_INTERNAL_REPOSITORY"
    };

    await putRecord(STORAGE_STORE, sourceId, record);

    const readBack = await getRecord(STORAGE_STORE, sourceId);
    if (!readBack || readBack.content !== content ||
        !core().fingerprintsEqual(readBack.fingerprint, actual)) {
      throw new Error("PERSISTENCE_READBACK_MISMATCH");
    }

    state.persistence = {
      ok: true,
      mode: "INTERNAL_REPOSITORY",
      sourceId,
      fingerprint: readBack.fingerprint,
      persistedAt: now()
    };

    return state.persistence;
  }

  function openDB() {
    return new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) {
        reject(new Error("INDEXEDDB_UNAVAILABLE"));
        return;
      }

      const req = indexedDB.open(STORAGE_DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORAGE_STORE)) {
          db.createObjectStore(STORAGE_STORE);
        }
        if (!db.objectStoreNames.contains(AUDIT_STORE)) {
          db.createObjectStore(AUDIT_STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("INDEXEDDB_OPEN_FAILED"));
    });
  }

  function putRecord(storeName, key, value) {
    return openDB().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).put(value, key);
      tx.oncomplete = () => { db.close(); resolve(value); };
      tx.onerror = () => { db.close(); reject(tx.error || new Error("STORE_WRITE_FAILED")); };
    }));
  }

  function getRecord(storeName, key) {
    return openDB().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error || new Error("STORE_READ_FAILED"));
      tx.oncomplete = () => db.close();
    }));
  }

  function saveAudit(record) {
    return openDB().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(AUDIT_STORE, "readwrite");
      tx.objectStore(AUDIT_STORE).put({
        ...record,
        id: `${record.timestamp}_${Math.random().toString(16).slice(2)}`
      });
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    }));
  }

  async function prepare(request, sourceText) {
    if (!core()) return { ok: false, reason: "CORE_NOT_READY" };

    let r;
    try { r = normalize(request); }
    catch (e) { return { ok: false, reason: e.message }; }

    const errors = validateRequest(r, sourceText);
    if (errors.length) {
      return { ok: false, reason: "REQUEST_REJECTED", errors };
    }

    const gate = core().validateBefore(sourceText, r.expectedFingerprint);
    if (!gate.ok) {
      return { ok: false, reason: "SOURCE_FINGERPRINT_MISMATCH", gate };
    }

    return {
      ok: true,
      request: r,
      sourceBefore: sourceText,
      sourceFingerprint: gate.actual
    };
  }

  async function execute(request, sourceText = null) {
    state.request = request;
    state.result = null;
    state.persistence = null;

    let r;
    try { r = normalize(request); }
    catch (e) {
      return fail("INVALID_REQUEST", { error: e.message });
    }

    audit("REQUEST_RECEIVED", {
      requestId: r.requestId,
      caseId: r.caseId,
      file: r.file
    });

    if (r.approval !== "APPROVED") {
      setStatus(STATUS.WAITING_APPROVAL);
      return reject("HUMAN_APPROVAL_REQUIRED");
    }

    const sourceId = r.sourceId || r.file;
    let source = sourceText;

    if (source == null) {
      const stored = await getSource(sourceId).catch(() => null);
      source = stored ? stored.content : null;
    }

    setStatus(STATUS.VALIDATING);
    const prepared = await prepare(request, source);

    if (!prepared.ok) {
      return reject(prepared.reason, prepared);
    }

    audit("APPROVAL_ACCEPTED", {
      requestId: r.requestId,
      caseId: r.caseId
    });

    setStatus(STATUS.EXECUTING);
    audit("EXECUTION_STARTED", {
      requestId: r.requestId,
      caseId: r.caseId,
      file: r.file,
      operation: r.operation
    });

    const patch = core().processPatch({
      source,
      before: r.before,
      after: r.after,
      operation: r.operation,
      expectedFingerprint: r.expectedFingerprint
    });

    if (!patch.ok) {
      return reject("PATCH_PIPELINE_FAILED", patch);
    }

    audit("PATCH_VALIDATED", {
      requestId: r.requestId,
      beforeFingerprint: patch.beforeFingerprint,
      afterFingerprint: patch.afterFingerprint
    });

    setStatus(STATUS.PERSISTING);
    audit("PERSISTENCE_STARTED", { sourceId, file: r.file });

    try {
      await persistSource(sourceId, patch.sourceAfter, {
        file: r.file,
        expectedFingerprint: patch.beforeFingerprint
      });
    } catch (error) {
      return fail("PERSISTENCE_FAILED", {
        error: error.message,
        sourceId,
        afterFingerprint: patch.afterFingerprint
      });
    }

    setStatus(STATUS.VERIFYING_PERSISTENCE);
    const persisted = await getSource(sourceId);

    if (!persisted ||
        !core().fingerprintsEqual(persisted.fingerprint, patch.afterFingerprint) ||
        persisted.content !== patch.sourceAfter) {
      return fail("PERSISTENCE_VERIFICATION_FAILED", {
        sourceId,
        expectedFingerprint: patch.afterFingerprint,
        actualFingerprint: persisted?.fingerprint || null
      });
    }

    audit("PERSISTENCE_VERIFIED", {
      sourceId,
      fingerprint: persisted.fingerprint
    });

    const result = Object.freeze({
      executor: ENGINE,
      version: VERSION,
      status: STATUS.SUCCESS,
      requestId: r.requestId,
      caseId: r.caseId,
      proposalId: r.proposalId,
      planId: r.planId,
      file: r.file,
      sourceId,
      operation: r.operation,
      sourceBefore: patch.sourceBefore,
      sourceAfter: patch.sourceAfter,
      beforeFingerprint: patch.beforeFingerprint,
      afterFingerprint: patch.afterFingerprint,
      diff: patch.diff,
      validation: patch.validation,
      persistence: state.persistence,
      executedAt: now()
    });

    state.result = result;
    state.source = persisted;
    audit("EXECUTION_SUCCESS", {
      requestId: r.requestId,
      caseId: r.caseId,
      sourceId,
      afterFingerprint: result.afterFingerprint
    });
    setStatus(STATUS.SUCCESS);
    return result;
  }

  function reject(reason, detail = null) {
    const result = {
      executor: ENGINE,
      version: VERSION,
      status: STATUS.REJECTED,
      reason,
      detail,
      executedAt: now()
    };
    state.result = result;
    audit("EXECUTION_REJECTED", { reason, detail });
    setStatus(STATUS.REJECTED);
    return result;
  }

  function fail(reason, detail = null) {
    const result = {
      executor: ENGINE,
      version: VERSION,
      status: STATUS.FAILED,
      reason,
      detail,
      executedAt: now()
    };
    state.result = result;
    audit("EXECUTION_FAILED", { reason, detail });
    setStatus(STATUS.FAILED);
    return result;
  }

  function attachRequest(request) {
    state.request = request;
    const approved = isApproved(request);
    setStatus(approved ? STATUS.READY : STATUS.WAITING_APPROVAL);
    audit("REQUEST_ATTACHED", { approved });
    return getStatus();
  }

  function reset() {
    state.request = null;
    state.result = null;
    state.persistence = null;
    setStatus(core() ? STATUS.READY : STATUS.OFFLINE);
  }

  function getStatus() {
    return {
      engine: ENGINE,
      version: VERSION,
      coreReady: !!core(),
      status: state.status,
      hasRequest: !!state.request,
      source: state.source,
      persistence: state.persistence,
      persistenceReady: !!(window.indexedDB),
      nerve: refreshNerveStatus(),
      lastResult: state.result,
      history: state.history.slice()
    };
  }

  async function listSources() {
    try {
      const db = await openDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORAGE_STORE, "readonly");
        const req = tx.objectStore(STORAGE_STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
        tx.oncomplete = () => db.close();
      });
    } catch {
      return [];
    }
  }

  window.BCGOInternalExecutor = Object.freeze({
    name: ENGINE,
    version: VERSION,
    status: STATUS,
    normalize,
    validateRequest,
    isApproved,
    registerSource,
    getSource,
    bindLocalFile,
    persistSource,
    prepare,
    execute,
    attachRequest,
    reset,
    getStatus,
    getHistory: () => state.history.slice(),
    listSources,
    getNerveStatus: () => ({ ...refreshNerveStatus() })
  });

  function boot() {
    startNerveMonitor();
    setStatus(core() ? STATUS.READY : STATUS.OFFLINE);
    // Inisialisasi demo source otomatis agar langsung siap uji coba
    setTimeout(async () => {
      try {
        const existing = await getSource("demo-config.js");
        if (!existing) {
          await registerSource("demo-config.js", "// CIKUR GO Internal Demo Config\nconst STATUS_MODE = \"STABLE_OFFLINE\";\nconst ROUTE_VERSION = \"v3.0.0\";\n", { file: "demo-config.js" });
        } else {
          state.source = existing;
        }
        emit();
      } catch (e) {
        console.error("Auto init demo source error:", e);
      }
    }, 200);
  }

  if (core()) boot();
  else window.addEventListener("bcgo-executor-core-ready", boot, { once: true });
})();
