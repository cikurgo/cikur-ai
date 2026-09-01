/* BCGO INTERNAL EXECUTOR CORE v2.0.0
   Deterministic internal patch engine.
   No network requests or third-party service calls.
*/
(() => {
  "use strict";

  const VERSION = "2.0.0";
  const NAME = "BCGO_INTERNAL_EXECUTOR_CORE";

  const OPS = Object.freeze({
    REPLACE_EXACT: "REPLACE_EXACT",
    INSERT_EXACT: "INSERT_EXACT",
    REMOVE_EXACT: "REMOVE_EXACT"
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

  function countExact(source, needle) {
    if (!needle) return 0;
    let n = 0, p = 0;
    while ((p = source.indexOf(needle, p)) !== -1) {
      n++;
      p += needle.length;
    }
    return n;
  }

  function validateBefore(source, expected) {
    const actual = fingerprint(source);
    if (expected == null || expected === "") {
      return { ok: true, skipped: true, actual };
    }
    return {
      ok: String(expected).toLowerCase() === actual.toLowerCase(),
      skipped: false,
      expected: String(expected),
      actual
    };
  }

  function apply(source, before, after, operation) {
    if (![source, before, after].every(v => typeof v === "string")) {
      return { ok: false, reason: "INVALID_SOURCE_OR_PATCH" };
    }

    const matches = countExact(source, before);
    if (matches !== 1) {
      return {
        ok: false,
        reason: matches === 0 ? "EXACT_TARGET_NOT_FOUND" : "EXACT_TARGET_NOT_UNIQUE",
        matches
      };
    }

    let result;
    if (operation === OPS.REPLACE_EXACT) result = source.replace(before, after);
    else if (operation === OPS.INSERT_EXACT) result = source.replace(before, before + after);
    else if (operation === OPS.REMOVE_EXACT) result = source.replace(before, "");
    else return { ok: false, reason: "UNSUPPORTED_OPERATION" };

    if (result === source) return { ok: false, reason: "SOURCE_UNCHANGED", matches };

    return {
      ok: true,
      matches,
      result,
      beforeFingerprint: fingerprint(source),
      afterFingerprint: fingerprint(result)
    };
  }

  window.BCGOExecutorCore = Object.freeze({
    name: NAME,
    version: VERSION,
    operations: OPS,
    fingerprint,
    countExact,
    validateBefore,
    apply
  });

  window.dispatchEvent(new CustomEvent("bcgo-executor-core-ready", {
    detail: { name: NAME, version: VERSION }
  }));
})();
