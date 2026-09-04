/* ============================================================
   BCGO INTERNAL EXECUTOR CORE
   Version 3.2.0 (Production Enhanced)
   ------------------------------------------------------------
   Pure deterministic execution engine.
   No external network, AI API, GitHub API, Firebase Functions,
   or third-party execution service.
   ============================================================ */
(() => {
  "use strict";

  const VERSION = "3.2.0";
  const NAME = "BCGO_INTERNAL_EXECUTOR_CORE";

  const OPS = Object.freeze({
    REPLACE_EXACT: "REPLACE_EXACT",
    INSERT_EXACT: "INSERT_EXACT",
    REMOVE_EXACT: "REMOVE_EXACT"
  });

  const RESULT = Object.freeze({
    OK: "OK",
    REJECTED: "REJECTED",
    FAILED: "FAILED"
  });

  function fingerprint(text) {
    if (typeof text !== "string") throw new TypeError("SOURCE_MUST_BE_STRING");
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  }

  function fingerprintsEqual(a, b) {
    return String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
  }

  function countExact(source, needle) {
    if (typeof source !== "string" || typeof needle !== "string" || !needle) return 0;
    let count = 0, pos = 0;
    while ((pos = source.indexOf(needle, pos)) !== -1) {
      count++;
      pos += needle.length;
    }
    return count;
  }

  function lineColumnAt(text, index) {
    const prefix = text.slice(0, Math.max(0, index));
    const lines = prefix.split("\n");
    return { line: lines.length, column: lines[lines.length - 1].length + 1 };
  }

  function diff(before, after) {
    if (typeof before !== "string" || typeof after !== "string") {
      return { ok: false, reason: "INVALID_DIFF_INPUT" };
    }
    if (before === after) {
      return {
        ok: false,
        changed: false,
        reason: "SOURCE_UNCHANGED",
        beforeFingerprint: fingerprint(before),
        afterFingerprint: fingerprint(after)
      };
    }

    let start = 0;
    const max = Math.min(before.length, after.length);
    while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;

    let endBefore = before.length - 1;
    let endAfter = after.length - 1;
    while (
      endBefore >= start &&
      endAfter >= start &&
      before.charCodeAt(endBefore) === after.charCodeAt(endAfter)
    ) {
      endBefore--;
      endAfter--;
    }

    const removed = before.slice(start, endBefore + 1);
    const added = after.slice(start, endAfter + 1);

    return {
      ok: true,
      changed: true,
      start,
      beforeEnd: endBefore + 1,
      afterEnd: endAfter + 1,
      location: lineColumnAt(before, start),
      removed,
      added,
      beforeFingerprint: fingerprint(before),
      afterFingerprint: fingerprint(after)
    };
  }

  function validateBefore(source, expected) {
    if (typeof source !== "string") {
      return { ok: false, reason: "INVALID_SOURCE_TYPE" };
    }

    const actual = fingerprint(source);

    if (expected == null || expected === "") {
      return {
        ok: true,
        skipped: true,
        reason: "NO_EXPECTED_FINGERPRINT",
        actual
      };
    }

    const ok = fingerprintsEqual(expected, actual);
    return {
      ok,
      skipped: false,
      expected: String(expected),
      actual,
      reason: ok ? "FINGERPRINT_MATCH" : "SOURCE_FINGERPRINT_MISMATCH"
    };
  }

  function apply(source, before, after, operation) {
    if (![source, before, after].every(v => typeof v === "string")) {
      return { ok: false, status: RESULT.REJECTED, reason: "INVALID_SOURCE_OR_PATCH" };
    }

    const op = String(operation || "").toUpperCase();

    if (!Object.values(OPS).includes(op)) {
      return { ok: false, status: RESULT.REJECTED, reason: "UNSUPPORTED_OPERATION" };
    }

    if (before.length === 0) {
      return { ok: false, status: RESULT.REJECTED, reason: "EMPTY_EXACT_TARGET" };
    }

    const matches = countExact(source, before);

    if (matches !== 1) {
      return {
        ok: false,
        status: RESULT.REJECTED,
        reason: matches === 0 ? "EXACT_TARGET_NOT_FOUND" : "EXACT_TARGET_NOT_UNIQUE",
        matches
      };
    }

    let result;
    if (op === OPS.REPLACE_EXACT) result = source.replace(before, after);
    else if (op === OPS.INSERT_EXACT) result = source.replace(before, before + after);
    else result = source.replace(before, "");

    if (result === source) {
      return { ok: false, status: RESULT.REJECTED, reason: "SOURCE_UNCHANGED", matches };
    }

    return {
      ok: true,
      status: RESULT.OK,
      operation: op,
      matches,
      result,
      beforeFingerprint: fingerprint(source),
      afterFingerprint: fingerprint(result),
      diff: diff(source, result)
    };
  }

  function validateResult(original, result, before, after, operation) {
    const errors = [];

    if (typeof original !== "string" || typeof result !== "string") {
      return { ok: false, status: RESULT.FAILED, errors: ["INVALID_VALIDATION_INPUT"] };
    }

    if (result === original) errors.push("SOURCE_UNCHANGED");

    const op = String(operation || "").toUpperCase();

    if (op === OPS.REPLACE_EXACT) {
      if (countExact(result, before) !== 0) errors.push("BEFORE_STILL_PRESENT");
      if (after && countExact(result, after) < 1) errors.push("AFTER_NOT_PRESENT");
    } else if (op === OPS.INSERT_EXACT) {
      if (countExact(result, before + after) < 1) errors.push("INSERT_RESULT_NOT_FOUND");
    } else if (op === OPS.REMOVE_EXACT) {
      if (countExact(result, before) !== 0) errors.push("REMOVE_TARGET_STILL_PRESENT");
    } else {
      errors.push("UNSUPPORTED_OPERATION");
    }

    return {
      ok: errors.length === 0,
      status: errors.length === 0 ? RESULT.OK : RESULT.FAILED,
      errors,
      beforeFingerprint: fingerprint(original),
      afterFingerprint: fingerprint(result),
      readBackFingerprint: fingerprint(result)
    };
  }

  function rollback(original, current, expectedCurrentFingerprint) {
    if (typeof original !== "string" || typeof current !== "string") {
      return { ok: false, status: RESULT.FAILED, reason: "INVALID_ROLLBACK_INPUT" };
    }

    const actual = fingerprint(current);

    if (
      expectedCurrentFingerprint &&
      !fingerprintsEqual(expectedCurrentFingerprint, actual)
    ) {
      return {
        ok: false,
        status: RESULT.REJECTED,
        reason: "ROLLBACK_FINGERPRINT_MISMATCH",
        actual
      };
    }

    return {
      ok: true,
      status: RESULT.OK,
      result: original,
      previousFingerprint: actual,
      restoredFingerprint: fingerprint(original)
    };
  }

  function processPatch({ source, before, after, operation, expectedFingerprint }) {
    const gate = validateBefore(source, expectedFingerprint);
    if (!gate.ok) return { ok: false, stage: "FINGERPRINT", gate };

    const patch = apply(source, before, after, operation);
    if (!patch.ok) return { ok: false, stage: "PATCH", patch };

    const validation = validateResult(
      source, patch.result, before, after, operation
    );

    if (!validation.ok) {
      const rb = rollback(source, patch.result, validation.afterFingerprint);
      return {
        ok: false,
        stage: "VALIDATION",
        patch,
        validation,
        rollback: rb
      };
    }

    return {
      ok: true,
      status: RESULT.OK,
      stage: "COMPLETE",
      sourceBefore: source,
      sourceAfter: patch.result,
      beforeFingerprint: patch.beforeFingerprint,
      afterFingerprint: patch.afterFingerprint,
      diff: patch.diff,
      validation
    };
  }

  window.BCGOExecutorCore = Object.freeze({
    name: NAME,
    version: VERSION,
    operations: OPS,
    result: RESULT,
    fingerprint,
    fingerprintsEqual,
    countExact,
    lineColumnAt,
    validateBefore,
    diff,
    apply,
    validateResult,
    rollback,
    processPatch
  });

  window.dispatchEvent(new CustomEvent("bcgo-executor-core-ready", {
    detail: { name: NAME, version: VERSION }
  }));
})();
