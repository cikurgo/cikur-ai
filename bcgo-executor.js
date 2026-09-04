/* ============================================================
   BCGO INTERNAL EXECUTOR
   Version 3.2.1 (Production Enhanced)
   ------------------------------------------------------------
   Orchestration + Request + Approval + Source + Persistence +
   Audit management.
   No external service is used as the execution brain.
   ============================================================ */
(() => {
  "use strict";

  const VERSION = "3.2.1";
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
    executionReview: null,
    incomingCandidate: null,
    investigation: null,
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
  const BRIDGE_CHANNEL = "CIKUR_GO_BCGO_MEDICINE_V1";
  const REPAIR_CANDIDATE_KEY = `${BRIDGE_CHANNEL}_REPAIR_CANDIDATE`;
  const REVIEW_RESULT_KEY = `${BRIDGE_CHANNEL}_EXECUTION_REVIEW`;
  const EXECUTION_CONSUMED_KEY = `${BRIDGE_CHANNEL}_EXECUTION_CONSUMED`;
  const INVESTIGATION_KEY = `${BRIDGE_CHANNEL}_INVESTIGATION`;
  const INVESTIGATION_ACK_KEY = `${BRIDGE_CHANNEL}_INVESTIGATION_ACK`;
  const REPAIR_CANDIDATE_MAX_AGE = 30000;
  const INVESTIGATION_MAX_AGE = 30000;
  const EXECUTOR_ROLE = String(window.__BCGO_EXECUTOR_ROLE || "STANDALONE").toUpperCase();
  const bridgeChannel = typeof BroadcastChannel !== "undefined"
    ? new BroadcastChannel(BRIDGE_CHANNEL) : null;
  const seenRepairCandidates = new Set();
  const reviewedCandidates = new Map();
  const processingApprovals = new Set();
  const seenInvestigations = new Set();
  const lastInvestigationPhase = new Map();

  function publishInvestigationAck(packet) {
    const message = {
      bridge: BRIDGE_CHANNEL,
      from: "EXECUTION",
      type: "EXECUTION_INVESTIGATION_ACK",
      role: EXECUTOR_ROLE,
      at: Date.now(),
      ...packet
    };
    try { bridgeChannel?.postMessage(message); } catch {}
    try { localStorage.setItem(INVESTIGATION_ACK_KEY, JSON.stringify(message)); } catch {}
    return message;
  }

  function handleInvestigationRequest(packet, source = "BROADCAST_CHANNEL") {
    if (EXECUTOR_ROLE !== "STANDALONE") return false;
    if (!packet || packet.bridge !== BRIDGE_CHANNEL || packet.from !== "MEDICINE" || packet.type !== "MEDICINE_INVESTIGATION_REQUEST") return false;
    const at = Number(packet.at) || 0;
    if (!at || Date.now() - at > INVESTIGATION_MAX_AGE) return false;
    const investigationId = String(packet.investigationId || "").trim();
    if (!investigationId) return false;

    const phase = String(packet.phase || "INVESTIGATING").toUpperCase();
    // One investigation session legitimately emits multiple phases.
    // Dedupe by session + phase, not by session alone, otherwise the Executor
    // would ACK STARTED and silently ignore EVIDENCE_FOUND/CANDIDATE_READY.
    const phaseKey = `${investigationId}:${phase}`;
    if (seenInvestigations.has(phaseKey)) return false;
    seenInvestigations.add(phaseKey);
    lastInvestigationPhase.set(investigationId, phase);
    if (seenInvestigations.size > 300) {
      const first = seenInvestigations.values().next().value;
      seenInvestigations.delete(first);
    }
    if (lastInvestigationPhase.size > 150) {
      const first = lastInvestigationPhase.keys().next().value;
      lastInvestigationPhase.delete(first);
    }

    const hasExactEvidence = Number(packet.sourceEvidenceCount || 0) > 0 && String(packet.rootCauseStatus || "UNPROVEN") !== "UNPROVEN";
    let participation = "RECEIVED";
    let message = "Execution menerima sesi investigasi. Menunggu candidate exact dari Medicine.";
    if (phase === "STARTED" || phase === "INVESTIGATING") {
      participation = "REVIEWING";
      message = "Execution ikut memantau investigasi. Belum ada source/operation yang boleh direview.";
    } else if (phase === "NEEDS_EVIDENCE") {
      participation = "EVIDENCE_INSUFFICIENT";
      message = "Evidence/source exact belum cukup. Execution belum membuka review patch.";
    } else if (phase === "EVIDENCE_FOUND") {
      participation = hasExactEvidence ? "EVIDENCE_RECEIVED" : "EVIDENCE_INSUFFICIENT";
      message = hasExactEvidence ? "Evidence diterima. Menunggu candidate exact untuk deterministic preflight." : "Evidence masih belum cukup untuk preflight deterministic.";
    } else if (phase === "ROOT_CAUSE_VERIFIED") {
      participation = "ROOT_CAUSE_RECEIVED";
      message = "Root cause diterima dari Medicine. Execution menunggu candidate exact untuk deterministic preflight; tidak ada eksekusi.";
    } else if (phase === "CANDIDATE_READY" || phase === "CANDIDATE_SENT") {
      participation = "CANDIDATE_EXPECTED";
      message = "Candidate repair sedang/akan diterima. Execution hanya melakukan deterministic review, bukan eksekusi.";
    }

    state.investigation = {
      investigationId,
      caseId:packet.caseId || null,
      phase,
      target:packet.target || null,
      symptom:packet.symptom || null,
      diagnosis:packet.diagnosis || null,
      runtimeLocation:packet.runtimeLocation || null,
      evidenceCount:Number(packet.evidenceCount || 0),
      sourceEvidenceCount:Number(packet.sourceEvidenceCount || 0),
      rootCauseFile:packet.rootCauseFile || null,
      rootCauseStatus:packet.rootCauseStatus || "UNPROVEN",
      precisionGate:!!packet.precisionGate,
      status:participation,
      message,
      source,
      receivedAt:now()
    };
    audit("INVESTIGATION_REQUEST_RECEIVED", { investigationId, caseId:packet.caseId || null, phase, target:packet.target || null, status:participation });
    emit();
    publishInvestigationAck({ investigationId, caseId:packet.caseId || null, phase, status:participation, message, source, receivedAt:state.investigation.receivedAt });
    return true;
  }

  function startInvestigationBridge() {
    if (EXECUTOR_ROLE !== "STANDALONE") return;
    try { bridgeChannel?.addEventListener("message", event => { handleInvestigationRequest(event.data, "BROADCAST_CHANNEL"); }); } catch {}
    try {
      window.addEventListener("storage", event => {
        if (event.key === INVESTIGATION_KEY && event.newValue) {
          try { handleInvestigationRequest(JSON.parse(event.newValue), "LOCAL_STORAGE"); } catch {}
        }
      });
    } catch {}
    try {
      const cached = localStorage.getItem(INVESTIGATION_KEY);
      if (cached) handleInvestigationRequest(JSON.parse(cached), "LOCAL_STORAGE_CACHE");
    } catch {}
  }

  function publishReviewResult(packet) {
    const message = {
      bridge: BRIDGE_CHANNEL,
      from: "EXECUTION",
      type: "EXECUTION_REVIEW_RESULT",
      role: EXECUTOR_ROLE,
      at: Date.now(),
      ...packet
    };
    try { bridgeChannel?.postMessage(message); } catch {}
    try { localStorage.setItem(REVIEW_RESULT_KEY, JSON.stringify(message)); } catch {}
    return message;
  }

  async function handleRepairCandidate(packet, source = "BROADCAST_CHANNEL") {
    if (EXECUTOR_ROLE !== "STANDALONE") return false;
    if (!packet || packet.bridge !== BRIDGE_CHANNEL || packet.from !== "MEDICINE" || packet.type !== "MEDICINE_REPAIR_CANDIDATE") return false;
    const at = Number(packet.at) || 0;
    if (!at || Date.now() - at > REPAIR_CANDIDATE_MAX_AGE) return false;
    const requestId = String(packet.requestId || packet.request?.requestId || "").trim();
    if (!requestId || seenRepairCandidates.has(requestId)) return false;
    seenRepairCandidates.add(requestId);
    if (seenRepairCandidates.size > 100) seenRepairCandidates.delete(seenRepairCandidates.values().next().value);

    state.incomingCandidate = packet.candidate || packet.request || null;
    state.executionReview = { status:"REVIEWING", requestId, caseId:packet.caseId || null, proposalId:packet.proposalId || null, file:packet.request?.file || packet.candidate?.file || null, receivedAt:now(), source };
    state.request = packet.request || null;
    audit("REPAIR_CANDIDATE_RECEIVED", { requestId, caseId:packet.caseId, proposalId:packet.proposalId, file:packet.request?.file || null });
    emit();

    let review;
    try {
      review = reviewCandidate(packet.request, packet.sourceText);
    } catch (error) {
      review = { executor:ENGINE, version:VERSION, status:"REJECTED", review:"REJECTED", reason:error?.message || "REVIEW_FAILED", requestId, caseId:packet.caseId || null, proposalId:packet.proposalId || null, reviewedAt:now() };
    }

    state.executionReview = { ...review, requestId, caseId:packet.caseId || null, proposalId:packet.proposalId || null, file:packet.request?.file || packet.candidate?.file || null, receivedAt:state.executionReview.receivedAt, completedAt:now(), role:EXECUTOR_ROLE };
    audit(review.status === "VALID" ? "REPAIR_REVIEW_VALID" : "REPAIR_REVIEW_REJECTED", { requestId, caseId:packet.caseId, proposalId:packet.proposalId, file:packet.request?.file || null, reason:review.reason || null, role:EXECUTOR_ROLE });
    if (review.status === "VALID") {
      reviewedCandidates.set(requestId, {request:packet.request, sourceText:packet.sourceText, review, caseId:packet.caseId||null, proposalId:packet.proposalId||null, reviewedAt:Date.now()});
      if (reviewedCandidates.size > 100) reviewedCandidates.delete(reviewedCandidates.keys().next().value);
    }
    emit();
    publishReviewResult({ requestId, caseId:packet.caseId || null, proposalId:packet.proposalId || null, review:state.executionReview });
    return true;
  }

  async function handleExecutionApproval(packet, source = "BROADCAST_CHANNEL") {
    if (EXECUTOR_ROLE !== "STANDALONE") return false;
    if (!packet || packet.bridge !== BRIDGE_CHANNEL || packet.from !== "MEDICINE" || packet.type !== "MEDICINE_EXECUTION_APPROVAL") return false;
    const at = Number(packet.at) || 0;
    if (!at || Date.now() - at > REPAIR_CANDIDATE_MAX_AGE) return false;
    if (packet.approval !== "HUMAN_APPROVED") return false;
    const requestId = String(packet.requestId || packet.request?.requestId || "").trim();
    if (!requestId || processingApprovals.has(requestId)) return false;

    // Execution approvals are one-time capabilities. A stale approval and its
    // cached candidate must never become executable again after an Executor
    // page reload. A new attempt must receive a new requestId/approval.
    try {
      const consumed = JSON.parse(localStorage.getItem(EXECUTION_CONSUMED_KEY) || "{}");
      if (consumed && consumed[requestId]) return false;
    } catch {}

    processingApprovals.add(requestId);
    let reviewed = requestId ? reviewedCandidates.get(requestId) : null;
    if (!reviewed) {
      try {
        const cached = localStorage.getItem(REPAIR_CANDIDATE_KEY);
        if (cached) {
          const cachedPacket = JSON.parse(cached);
          const cachedRequestId = String(cachedPacket?.requestId || cachedPacket?.request?.requestId || "").trim();
          if (cachedRequestId === requestId) await handleRepairCandidate(cachedPacket, "LOCAL_STORAGE_APPROVAL_RECOVERY");
        }
      } catch {}
      reviewed = requestId ? reviewedCandidates.get(requestId) : null;
    }
    try {
      if (!reviewed || reviewed.review?.status !== "VALID") {
        publishReviewResult({requestId,caseId:packet.caseId||null,proposalId:packet.proposalId||null,review:{executor:ENGINE,version:VERSION,status:"REJECTED",review:"REJECTED",reason:"CANDIDATE_NOT_PREVIOUSLY_VALIDATED",requestId,caseId:packet.caseId||null,proposalId:packet.proposalId||null,reviewedAt:now()}});
        return false;
      }
      if (String(reviewed.caseId||"") !== String(packet.caseId||"") || String(reviewed.proposalId||"") !== String(packet.proposalId||"")) return false;
      const request = {...reviewed.request, approval:"APPROVED", actorUid:packet.approvedBy || reviewed.request?.actorUid || null};
      const result = await execute(request, reviewed.sourceText);
      audit(result.status === STATUS.SUCCESS ? "APPROVED_EXECUTION_SUCCESS" : "APPROVED_EXECUTION_FAILED", {requestId,caseId:packet.caseId||null,proposalId:packet.proposalId||null,source});
      const executionMessage = {id:`EXECUTION-${requestId}-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,bridge:BRIDGE_CHANNEL,from:"EXECUTION",type:"EXECUTION_RESULT",at:Date.now(),role:EXECUTOR_ROLE,requestId,caseId:packet.caseId||null,proposalId:packet.proposalId||null,result};
      try { bridgeChannel?.postMessage(executionMessage); } catch {}
      try {
        const resultCache = `${BRIDGE_CHANNEL}_EXECUTION_RESULT`;
        // Keep a per-request cache so concurrent executions cannot overwrite each other.
        localStorage.setItem(`${resultCache}_${requestId}`, JSON.stringify(executionMessage));
        // Retain the legacy latest-result slot for compatibility with older consumers.
        localStorage.setItem(resultCache, JSON.stringify(executionMessage));
      } catch {}

      // Consume the approval even when execution failed. This prevents a cached
      // HUMAN_APPROVED packet from silently replaying after a reload. Keep only
      // a bounded audit map; a future retry must originate from Medicine with a
      // new requestId and fresh deterministic review.
      try {
        const consumed = JSON.parse(localStorage.getItem(EXECUTION_CONSUMED_KEY) || "{}");
        consumed[requestId] = {at:Date.now(),status:result.status,caseId:packet.caseId||null,proposalId:packet.proposalId||null};
        const entries = Object.entries(consumed).sort((a,b)=>(Number(b[1]?.at)||0)-(Number(a[1]?.at)||0)).slice(0,100);
        localStorage.setItem(EXECUTION_CONSUMED_KEY, JSON.stringify(Object.fromEntries(entries)));
        localStorage.removeItem(`${BRIDGE_CHANNEL}_EXECUTION_APPROVAL`);
        localStorage.removeItem(REPAIR_CANDIDATE_KEY);
      } catch {}
      reviewedCandidates.delete(requestId);
      return true;
    } finally {
      processingApprovals.delete(requestId);
    }
  }

  function startRepairCandidateBridge() {
    if (EXECUTOR_ROLE !== "STANDALONE") return;
    try { bridgeChannel?.addEventListener("message", event => { handleRepairCandidate(event.data, "BROADCAST_CHANNEL").catch(() => {}); }); } catch {}
    try {
      window.addEventListener("storage", event => {
        if (event.key === REPAIR_CANDIDATE_KEY && event.newValue) {
          try { handleRepairCandidate(JSON.parse(event.newValue), "LOCAL_STORAGE").catch(() => {}); } catch {}
        }
      });
    } catch {}
    try {
      const cached = localStorage.getItem(REPAIR_CANDIDATE_KEY);
      if (cached) handleRepairCandidate(JSON.parse(cached), "LOCAL_STORAGE_CACHE").catch(() => {});
    } catch {}
  }

  function startExecutionApprovalBridge() {
    if (EXECUTOR_ROLE !== "STANDALONE") return;
    try { bridgeChannel?.addEventListener("message", event => { handleExecutionApproval(event.data, "BROADCAST_CHANNEL").catch(() => {}); }); } catch {}
    try { window.addEventListener("storage", event => { if (event.key === `${BRIDGE_CHANNEL}_EXECUTION_APPROVAL` && event.newValue) { try { handleExecutionApproval(JSON.parse(event.newValue), "LOCAL_STORAGE").catch(() => {}); } catch {} } }); } catch {}
    try { const cached = localStorage.getItem(`${BRIDGE_CHANNEL}_EXECUTION_APPROVAL`); if (cached) handleExecutionApproval(JSON.parse(cached), "LOCAL_STORAGE_CACHE").catch(() => {}); } catch {}
  }

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

  function recoverBridgeCaches() {
    try {
      const cached = localStorage.getItem(NERVE_STATE_KEY);
      if (cached) updateNerve(JSON.parse(cached), "LOCAL_STORAGE_RECOVERY");
    } catch {}
    if (EXECUTOR_ROLE !== "STANDALONE") return;
    try {
      const investigation = localStorage.getItem(INVESTIGATION_KEY);
      if (investigation) handleInvestigationRequest(JSON.parse(investigation), "LOCAL_STORAGE_RECOVERY");
    } catch {}
    try {
      const candidate = localStorage.getItem(REPAIR_CANDIDATE_KEY);
      if (candidate) handleRepairCandidate(JSON.parse(candidate), "LOCAL_STORAGE_RECOVERY").catch(() => {});
    } catch {}
  }

  function startBridgeRecovery() {
    if (bridgeRecoveryTimer !== null) return;
    bridgeRecoveryTimer = setInterval(recoverBridgeCaches, 3000);
    window.addEventListener("pageshow", recoverBridgeCaches);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") recoverBridgeCaches();
    });
    recoverBridgeCaches();
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
  let bridgeRecoveryTimer = null;

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

    // Review validates the same request contract as execution, but uses a
    // temporary approval flag only for structural validation. It NEVER executes.
    const reviewRequest = { ...r, approval: "APPROVED" };
    const errors = validateRequest(reviewRequest, sourceText);
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

  function reviewCandidate(request, sourceText = null) {
    let r;
    try { r = normalize(request); }
    catch (e) {
      const result = { executor: ENGINE, version: VERSION, status: "REJECTED", review: "REJECTED", reason: e.message, reviewedAt: now() };
      audit("REPAIR_REVIEW_REJECTED", { reason: e.message });
      return result;
    }

    // Review is a non-writing preflight. Reuse the same structural validator,
    // but do not require human approval at this stage; approval belongs only
    // to execute(). The request itself remains marked REVIEW and can never
    // reach the write path through this function.
    const validationRequest = { ...r, approval: "APPROVED" };
    const errors = validateRequest(validationRequest, sourceText);
    if (errors.length) {
      const result = { executor: ENGINE, version: VERSION, status: "REJECTED", review: "REJECTED", reason: "REPAIR_CANDIDATE_INVALID", errors, caseId:r.caseId || null, proposalId:r.proposalId || null, file:r.file || null, reviewedAt:now() };
      audit("REPAIR_REVIEW_REJECTED", { caseId:r.caseId, proposalId:r.proposalId, file:r.file, errors });
      setStatus(STATUS.REJECTED);
      emit();
      return result;
    }

    if (typeof sourceText !== "string") {
      const result = { executor: ENGINE, version: VERSION, status: "REJECTED", review: "REJECTED", reason: "SOURCE_REQUIRED_FOR_REVIEW", caseId:r.caseId || null, proposalId:r.proposalId || null, reviewedAt:now() };
      audit("REPAIR_REVIEW_REJECTED", { reason: result.reason, caseId:r.caseId, proposalId:r.proposalId });
      setStatus(STATUS.REJECTED);
      emit();
      return result;
    }

    const gate = core().validateBefore(sourceText, r.expectedFingerprint);
    if (!gate.ok) {
      const result = { executor: ENGINE, version: VERSION, status: "REJECTED", review: "REJECTED", reason: "SOURCE_FINGERPRINT_MISMATCH", gate, caseId:r.caseId || null, proposalId:r.proposalId || null, file:r.file || null, reviewedAt:now() };
      audit("REPAIR_REVIEW_REJECTED", { reason: result.reason, caseId:r.caseId, proposalId:r.proposalId, file:r.file });
      setStatus(STATUS.REJECTED);
      emit();
      return result;
    }

    const simulated = core().processPatch({
      source: sourceText,
      before: r.before,
      after: r.after,
      operation: r.operation,
      expectedFingerprint: r.expectedFingerprint
    });

    const result = simulated.ok
      ? { executor:ENGINE, version:VERSION, status:"VALID", review:"VALID", caseId:r.caseId || null, proposalId:r.proposalId || null, file:r.file || null, operation:r.operation, beforeFingerprint:simulated.beforeFingerprint, afterFingerprint:simulated.afterFingerprint, diff:simulated.diff, validation:simulated.validation, reviewedAt:now() }
      : { executor:ENGINE, version:VERSION, status:"REJECTED", review:"REJECTED", reason:"SIMULATION_FAILED", caseId:r.caseId || null, proposalId:r.proposalId || null, file:r.file || null, detail:simulated, reviewedAt:now() };

    audit(result.status === "VALID" ? "REPAIR_REVIEW_VALID" : "REPAIR_REVIEW_REJECTED", { caseId:r.caseId, proposalId:r.proposalId, file:r.file, status:result.status, reason:result.reason || null });
    emit();
    return result;
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
      executionReview: state.executionReview,
      incomingCandidate: state.incomingCandidate,
      investigation: state.investigation,
      executorRole: EXECUTOR_ROLE,
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
    reviewCandidate,
    execute,
    attachRequest,
    reset,
    getStatus,
    getHistory: () => state.history.slice(),
    listSources,
    getNerveStatus: () => ({ ...refreshNerveStatus() })
  });

  function boot() {
    startBridgeRecovery();
    startNerveMonitor();
    startInvestigationBridge();
    startRepairCandidateBridge();
    startExecutionApprovalBridge();
    setStatus(core() ? STATUS.READY : STATUS.OFFLINE);
  }

  if (core()) boot();
  else window.addEventListener("bcgo-executor-core-ready", boot, { once: true });
  window.dispatchEvent(new CustomEvent("bcgo-executor-ready", {detail:{name:ENGINE,version:VERSION}}));
})();
