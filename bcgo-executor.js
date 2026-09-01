/* BCGO INTERNAL EXECUTOR v2.0.0
   Orchestration layer.
   No network requests or third-party service calls.
*/
(() => {
  "use strict";

  const VERSION = "2.0.0";
  const STATUS = Object.freeze({
    OFFLINE: "OFFLINE",
    READY: "READY",
    WAITING_APPROVAL: "WAITING_APPROVAL",
    VALIDATING: "VALIDATING",
    EXECUTING: "EXECUTING",
    SUCCESS: "SUCCESS",
    REJECTED: "REJECTED"
  });

  const state = {
    status: STATUS.OFFLINE,
    request: null,
    result: null,
    history: []
  };

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

  function normalize(request) {
    if (!request || typeof request !== "object") throw new Error("INVALID_REQUEST");

    return {
      caseId: request.caseId || request.caseID || request.id || "",
      file: request.file || request.targetFile || request.target || "",
      operation: String(request.operation || "").toUpperCase(),
      before: typeof request.before === "string" ? request.before : request.beforeCode,
      after: typeof request.after === "string" ? request.after : request.afterCode,
      approval: String(request.approval || request.approvalStatus || "").toUpperCase(),
      expectedFingerprint:
        request.expectedFingerprint ||
        request.sourceFingerprint ||
        request.expectedSha ||
        null
    };
  }

  function prepare(request, source) {
    const c = core();
    if (!c) return { ok: false, reason: "CORE_NOT_READY" };

    let r;
    try { r = normalize(request); }
    catch (e) { return { ok: false, reason: e.message }; }

    const errors = [];
    if (!r.caseId) errors.push("CASE_ID_REQUIRED");
    if (!r.file) errors.push("TARGET_FILE_REQUIRED");
    if (!Object.values(c.operations).includes(r.operation)) errors.push("UNSUPPORTED_OPERATION");
    if (typeof r.before !== "string") errors.push("BEFORE_REQUIRED");
    if (typeof r.after !== "string") errors.push("AFTER_REQUIRED");
    if (r.approval !== "APPROVED") errors.push("HUMAN_APPROVAL_REQUIRED");
    if (typeof source !== "string") errors.push("SOURCE_REQUIRED");
    if (errors.length) return { ok: false, reason: "REQUEST_REJECTED", errors };

    const gate = c.validateBefore(source, r.expectedFingerprint);
    if (!gate.ok) return { ok: false, reason: "SOURCE_FINGERPRINT_MISMATCH", fingerprint: gate };

    const patch = c.apply(source, r.before, r.after, r.operation);
    if (!patch.ok) return { ok: false, reason: patch.reason, matches: patch.matches };

    const verification = {
      ok: patch.result !== source,
      beforeStillPresent:
        r.operation === c.operations.REPLACE_EXACT
          ? patch.result.includes(r.before)
          : false,
      afterPresent:
        r.operation === c.operations.REPLACE_EXACT
          ? patch.result.includes(r.after)
          : true
    };

    if (!verification.ok || verification.beforeStillPresent || !verification.afterPresent) {
      return { ok: false, reason: "POST_PATCH_VALIDATION_FAILED", verification };
    }

    return {
      ok: true,
      caseId: r.caseId,
      file: r.file,
      operation: r.operation,
      sourceBefore: source,
      sourceAfter: patch.result,
      beforeFingerprint: patch.beforeFingerprint,
      afterFingerprint: patch.afterFingerprint,
      preparedAt: now()
    };
  }

  function execute(request, source) {
    state.request = request;
    state.result = null;

    let r;
    try { r = normalize(request); }
    catch (e) {
      return reject("INVALID_REQUEST", e.message);
    }

    if (r.approval !== "APPROVED") {
      setStatus(STATUS.WAITING_APPROVAL);
      return reject("HUMAN_APPROVAL_REQUIRED");
    }

    setStatus(STATUS.VALIDATING);
    const prepared = prepare(request, source);

    if (!prepared.ok) {
      setStatus(STATUS.REJECTED);
      return reject(prepared.reason, prepared);
    }

    setStatus(STATUS.EXECUTING);

    const result = {
      executor: "BCGO_INTERNAL_EXECUTOR",
      version: VERSION,
      status: STATUS.SUCCESS,
      caseId: prepared.caseId,
      file: prepared.file,
      operation: prepared.operation,
      beforeFingerprint: prepared.beforeFingerprint,
      afterFingerprint: prepared.afterFingerprint,
      source: prepared.sourceAfter,
      executedAt: now()
    };

    state.result = result;
    state.history.push(result);
    setStatus(STATUS.SUCCESS);
    return result;
  }

  function reject(reason, detail = null) {
    const result = {
      executor: "BCGO_INTERNAL_EXECUTOR",
      version: VERSION,
      status: STATUS.REJECTED,
      reason,
      detail,
      executedAt: now()
    };
    state.result = result;
    state.history.push(result);
    emit();
    return result;
  }

  function attachRequest(request) {
    state.request = request;
    const approval = String(
      request?.approval || request?.approvalStatus || ""
    ).toUpperCase();
    setStatus(approval === "APPROVED" ? STATUS.READY : STATUS.WAITING_APPROVAL);
    return getStatus();
  }

  function reset() {
    state.request = null;
    state.result = null;
    setStatus(core() ? STATUS.READY : STATUS.OFFLINE);
  }

  function getStatus() {
    return {
      engine: "BCGO_INTERNAL_EXECUTOR",
      version: VERSION,
      coreReady: !!core(),
      status: state.status,
      hasRequest: !!state.request,
      lastResult: state.result
    };
  }

  window.BCGOInternalExecutor = Object.freeze({
    name: "BCGO_INTERNAL_EXECUTOR",
    version: VERSION,
    status: STATUS,
    prepare,
    execute,
    attachRequest,
    reset,
    getStatus,
    getHistory: () => state.history.slice()
  });

  function boot() {
    setStatus(core() ? STATUS.READY : STATUS.OFFLINE);
  }

  if (core()) boot();
  else window.addEventListener("bcgo-executor-core-ready", boot, { once: true });
})();
