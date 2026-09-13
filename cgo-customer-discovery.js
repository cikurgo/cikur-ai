/* ============================================================
 * CIKUR GO — CGO CUSTOMER DISCOVERY ENGINE
 * ------------------------------------------------------------
 * File    : cgo-customer-discovery.js
 * Role    : Runtime Discovery / Local Screening
 * Scope   : Customer-facing CGO
 *
 * IMPORTANT:
 * - Internal JavaScript module only.
 * - No external API.
 * - No external AI.
 * - No Firebase Functions.
 * - No third-party runtime.
 * - This module does NOT create availability data.
 * - It only reads data supplied by an authorized
 *   CIKUR GO runtime adapter.
 *
 * PRINCIPLE:
 *   Knowledge = what CIKUR GO knows.
 *   Discovery = what CIKUR GO can verify now.
 *
 *   UNKNOWN is always safer than invented availability.
 * ============================================================ */

(function (window) {
  "use strict";

  const ROOT =
    window.CGO_CUSTOMER ||
    (window.CGO_CUSTOMER = {});

  const VERSION =
    "1.0.1-discovery-evidence-aligned";

  /* ==========================================================
   * DISCOVERY STATUS
   * ========================================================== */

  const STATUS = Object.freeze({
    IDLE: "idle",
    CHECKING: "checking",
    AVAILABLE: "available",
    UNAVAILABLE: "unavailable",
    UNKNOWN: "unknown",
    ERROR: "error"
  });

  const SOURCE_TYPES = Object.freeze([
    "agent",
    "mitra",
    "restaurant",
    "driver",
    "service",
    "location"
  ]);

  /* ==========================================================
   * INTERNAL STATE
   * ========================================================== */

  let runtimeAdapter = null;

  let lastResult = null;

  let lastRequest = null;

  let requestSequence = 0;

  /* ==========================================================
   * UTILITIES
   * ========================================================== */

  function cleanText(value) {
    return String(value == null ? "" : value)
      .replace(/\s+/g, " ")
      .trim();
  }

  function lower(value) {
    return cleanText(value).toLowerCase();
  }

  function clone(value) {
    try {
      return JSON.parse(
        JSON.stringify(value)
      );
    } catch (error) {
      return value;
    }
  }

  function normalizeId(value) {
    return lower(value)
      .replace(/[^a-z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  }

  function unique(list) {
    return Array.from(
      new Set(
        Array.isArray(list)
          ? list.filter(Boolean)
          : []
      )
    );
  }

  function now() {
    return Date.now();
  }

  /* ==========================================================
   * EVENT SYSTEM
   * ========================================================== */

  const listeners =
    Object.create(null);

  function emit(eventName, payload) {
    const callbacks =
      listeners[eventName];

    if (!Array.isArray(callbacks)) {
      return;
    }

    callbacks.slice().forEach(
      function (callback) {
        try {
          callback(
            clone(payload)
          );
        } catch (error) {
          console.error(
            "[CGO Customer Discovery] Listener error:",
            error
          );
        }
      }
    );
  }

  function on(eventName, callback) {
    if (
      typeof callback !==
      "function"
    ) {
      return function () {};
    }

    if (
      !listeners[eventName]
    ) {
      listeners[eventName] = [];
    }

    listeners[eventName].push(
      callback
    );

    return function unsubscribe() {
      const list =
        listeners[eventName];

      if (!Array.isArray(list)) {
        return;
      }

      const index =
        list.indexOf(callback);

      if (index !== -1) {
        list.splice(index, 1);
      }
    };
  }

  /* ==========================================================
   * RUNTIME ADAPTER VALIDATION
   * ========================================================== */

  function isValidAdapter(adapter) {
    if (
      !adapter ||
      typeof adapter !==
      "object"
    ) {
      return false;
    }

    return (
      typeof adapter.check ===
        "function" ||
      typeof adapter.checkAsync ===
        "function" ||
      typeof adapter.findNearby ===
        "function"
    );
  }

  function connect(adapter) {
    if (!isValidAdapter(adapter)) {
      runtimeAdapter = null;

      return {
        ok: false,
        connected: false,
        error:
          "INVALID_RUNTIME_ADAPTER"
      };
    }

    runtimeAdapter = adapter;

    emit(
      "runtime:connected",
      {
        version: VERSION,
        connected: true
      }
    );

    return {
      ok: true,
      connected: true,
      version: VERSION
    };
  }

  function disconnect() {
    runtimeAdapter = null;

    emit(
      "runtime:disconnected",
      {
        version: VERSION
      }
    );

    return {
      ok: true,
      connected: false
    };
  }

  function isConnected() {
    return Boolean(
      runtimeAdapter &&
      isValidAdapter(
        runtimeAdapter
      )
    );
  }

  /* ==========================================================
   * REQUEST NORMALIZATION
   * ========================================================== */

  function normalizeRequest(request) {
    const input =
      request &&
      typeof request === "object"
        ? request
        : {};

    const serviceId =
      normalizeId(
        input.serviceId ||
        input.service ||
        ""
      );

    const types =
      unique(
        input.types ||
        []
      ).filter(
        function (type) {
          return SOURCE_TYPES.includes(
            lower(type)
          );
        }
      );

    return {
      requestId:
        "discovery-" +
        now() +
        "-" +
        (++requestSequence),

      serviceId,

      serviceName:
        cleanText(
          input.serviceName ||
          (
            input.service &&
            typeof input.service === "object"
              ? input.service.name || ""
              : ""
          ) ||
          ""
        ),

      types,

      location:
        clone(
          input.location ||
          null
        ),

      needs:
        unique(
          input.needs ||
          []
        ),

      query:
        cleanText(
          input.query ||
          ""
        ),

      context:
        clone(
          input.context ||
          {}
        ),

      requestedAt:
        now()
    };
  }

  /* ==========================================================
   * RESULT NORMALIZATION
   * ========================================================== */

  function normalizeResult(
    raw,
    request
  ) {
    if (
      !raw ||
      typeof raw !==
      "object"
    ) {
      return {
        ok: false,

        status:
          STATUS.UNKNOWN,

        verified: false,

        request:
          clone(request),

        source: null,

        data: null,

        message:
          "Runtime tidak memberikan hasil yang dapat diverifikasi.",

        checkedAt:
          now()
      };
    }

    let status =
      lower(
        raw.status ||
        ""
      );

    if (
      !Object.values(
        STATUS
      ).includes(status)
    ) {
      status =
        raw.available === true
          ? STATUS.AVAILABLE
          : raw.available === false
            ? STATUS.UNAVAILABLE
            : STATUS.UNKNOWN;
    }

    /*
     * A result is considered verified only when
     * the runtime explicitly supplies evidence/data.
     */
    /*
     * Verification must match the Guardian evidence contract.
     * Presence of source/data/items/records alone is NOT proof.
     * Runtime must explicitly mark the result as verified and
     * provide at least one traceable evidence anchor.
     */
    const explicitVerified =
      raw.verified === true ||
      raw.isVerified === true;

    const explicitSource =
      typeof raw.source === "string" &&
      raw.source.trim() !== "";

    const hasRuntimeId =
      typeof raw.requestId === "string" &&
      raw.requestId.trim() !== "";

    const hasData =
      Boolean(
        (raw.data &&
          typeof raw.data === "object" &&
          Object.keys(raw.data).length > 0) ||
        (Array.isArray(raw.items) && raw.items.length > 0) ||
        (Array.isArray(raw.records) && raw.records.length > 0)
      );

    const verified =
      explicitVerified &&
      (explicitSource || hasRuntimeId || hasData);

    const items =
      Array.isArray(
        raw.items
      )
        ? clone(raw.items)
        : Array.isArray(
            raw.records
          )
          ? clone(raw.records)
          : [];

    return {
      ok:
        raw.ok !== false,

      status,

      verified,

      request:
        clone(request),

      source:
        cleanText(
          raw.source ||
          "runtime"
        ),

      checkedAt:
        now(),

      data:
        clone(
          raw.data ||
          null
        ),

      items,

      count:
        Number.isFinite(
          raw.count
        )
          ? raw.count
          : items.length,

      message:
        cleanText(
          raw.message ||
          ""
        ),

      evidence:
        clone(
          raw.evidence ||
          null
        ),

      metadata:
        clone(
          raw.metadata ||
          {}
        )
    };
  }

  /* ==========================================================
   * SAFE UNKNOWN RESULT
   * ========================================================== */

  function unknownResult(
    request,
    reason
  ) {
    return {
      ok: false,

      status:
        STATUS.UNKNOWN,

      verified: false,

      request:
        clone(request),

      source: null,

      checkedAt:
        now(),

      data: null,

      items: [],

      count: 0,

      message:
        cleanText(
          reason ||
          "Kondisi layanan belum dapat diverifikasi."
        ),

      evidence: null,

      metadata: {}
    };
  }

  /* ==========================================================
   * ADAPTER INVOCATION
   * ========================================================== */

  function invokeSync(
    request
  ) {
    if (!isConnected()) {
      return unknownResult(
        request,
        "Runtime CIKUR GO belum terhubung."
      );
    }

    try {
      let raw = null;

      if (
        typeof runtimeAdapter.check ===
        "function"
      ) {
        raw =
          runtimeAdapter.check(
            clone(request)
          );
      } else if (
        typeof runtimeAdapter.findNearby ===
        "function"
      ) {
        raw =
          runtimeAdapter.findNearby(
            clone(request)
          );
      }

      /*
       * A Promise cannot be treated as a
       * synchronous verified result.
       */
      if (
        raw &&
        typeof raw.then ===
        "function"
      ) {
        return unknownResult(
          request,
          "Runtime membutuhkan pemeriksaan asynchronous."
        );
      }

      return normalizeResult(
        raw,
        request
      );

    } catch (error) {
      console.error(
        "[CGO Customer Discovery] Runtime error:",
        error
      );

      return {
        ok: false,

        status:
          STATUS.ERROR,

        verified: false,

        request:
          clone(request),

        source:
          "runtime",

        checkedAt:
          now(),

        data: null,

        items: [],

        count: 0,

        message:
          "Pemeriksaan runtime mengalami kendala.",

        evidence: null,

        metadata: {
          error:
            cleanText(
              error &&
              error.message
                ? error.message
                : error
            )
        }
      };
    }
  }

  async function invokeAsync(
    request
  ) {
    if (!isConnected()) {
      return unknownResult(
        request,
        "Runtime CIKUR GO belum terhubung."
      );
    }

    try {
      let raw;

      if (
        typeof runtimeAdapter.checkAsync ===
        "function"
      ) {
        raw =
          await runtimeAdapter.checkAsync(
            clone(request)
          );
      } else if (
        typeof runtimeAdapter.check ===
        "function"
      ) {
        raw =
          await runtimeAdapter.check(
            clone(request)
          );
      } else if (
        typeof runtimeAdapter.findNearby ===
        "function"
      ) {
        raw =
          await runtimeAdapter.findNearby(
            clone(request)
          );
      } else {
        return unknownResult(
          request,
          "Runtime tidak memiliki metode pemeriksaan."
        );
      }

      return normalizeResult(
        raw,
        request
      );

    } catch (error) {
      console.error(
        "[CGO Customer Discovery] Async runtime error:",
        error
      );

      return {
        ok: false,

        status:
          STATUS.ERROR,

        verified: false,

        request:
          clone(request),

        source:
          "runtime",

        checkedAt:
          now(),

        data: null,

        items: [],

        count: 0,

        message:
          "Pemeriksaan runtime mengalami kendala.",

        evidence: null,

        metadata: {
          error:
            cleanText(
              error &&
              error.message
                ? error.message
                : error
            )
        }
      };
    }
  }

  /* ==========================================================
   * VERIFY RESULT
   * ========================================================== */

  function verifyResult(result) {
    if (!result) {
      return {
        verified: false,
        status:
          STATUS.UNKNOWN,
        reason:
          "EMPTY_RESULT"
      };
    }

    /*
     * Never convert UNKNOWN into AVAILABLE.
     *
     * Never convert a guess into proof.
     */

    if (
      result.status ===
      STATUS.AVAILABLE
    ) {
      if (
        !result.verified
      ) {
        return {
          verified: false,
          status:
            STATUS.UNKNOWN,
          reason:
            "AVAILABLE_WITHOUT_VERIFIABLE_EVIDENCE"
        };
      }

      return {
        verified: true,
        status:
          STATUS.AVAILABLE,
        reason:
          "RUNTIME_CONFIRMED"
      };
    }

    if (
      result.status ===
      STATUS.UNAVAILABLE
    ) {
      return {
        verified:
          Boolean(
            result.verified
          ),
        status:
          STATUS.UNAVAILABLE,
        reason:
          result.verified
            ? "RUNTIME_CONFIRMED"
            : "UNVERIFIED_UNAVAILABLE"
      };
    }

    return {
      verified: false,
      status:
        result.status ||
        STATUS.UNKNOWN,
      reason:
        "NOT_CONFIRMED"
    };
  }

  /* ==========================================================
   * SCREENING
   * ========================================================== */

  function screen(
    request
  ) {
    const normalized =
      normalizeRequest(
        request
      );

    lastRequest =
      clone(normalized);

    emit(
      "discovery:started",
      clone(normalized)
    );

    if (
      !normalized.serviceId &&
      !normalized.query
    ) {
      const result =
        unknownResult(
          normalized,
          "Service atau kebutuhan yang akan diperiksa belum ditentukan."
        );

      lastResult =
        clone(result);

      emit(
        "discovery:completed",
        clone(result)
      );

      return result;
    }

    const result =
      invokeSync(
        normalized
      );

    const verification =
      verifyResult(
        result
      );

    if (
      result.status ===
        STATUS.AVAILABLE &&
      !verification.verified
    ) {
      result.status =
        STATUS.UNKNOWN;

      result.verified =
        false;

      result.message =
        "Data runtime belum cukup untuk memastikan ketersediaan.";
    }

    lastResult =
      clone(result);

    emit(
      "discovery:completed",
      clone(result)
    );

    return result;
  }

  /* ==========================================================
   * ASYNC SCREENING
   * ========================================================== */

  async function screenAsync(
    request
  ) {
    const normalized =
      normalizeRequest(
        request
      );

    lastRequest =
      clone(normalized);

    emit(
      "discovery:started",
      clone(normalized)
    );

    if (
      !normalized.serviceId &&
      !normalized.query
    ) {
      const result =
        unknownResult(
          normalized,
          "Service atau kebutuhan yang akan diperiksa belum ditentukan."
        );

      lastResult =
        clone(result);

      emit(
        "discovery:completed",
        clone(result)
      );

      return result;
    }

    const result =
      await invokeAsync(
        normalized
      );

    const verification =
      verifyResult(
        result
      );

    if (
      result.status ===
        STATUS.AVAILABLE &&
      !verification.verified
    ) {
      result.status =
        STATUS.UNKNOWN;

      result.verified =
        false;

      result.message =
        "Data runtime belum cukup untuk memastikan ketersediaan.";
    }

    lastResult =
      clone(result);

    emit(
      "discovery:completed",
      clone(result)
    );

    return result;
  }

  /* ==========================================================
   * NEARBY SEARCH
   * ========================================================== */

  function findNearby(
    serviceId,
    options
  ) {
    const input =
      options &&
      typeof options === "object"
        ? options
        : {};

    return screen({
      serviceId,

      serviceName:
        input.serviceName,

      types:
        input.types ||
        ["agent", "mitra"],

      location:
        input.location ||
        null,

      needs:
        input.needs ||
        [],

      query:
        input.query ||
        "",

      context:
        input.context ||
        {}
    });
  }

  async function findNearbyAsync(
    serviceId,
    options
  ) {
    const input =
      options &&
      typeof options === "object"
        ? options
        : {};

    return screenAsync({
      serviceId,

      serviceName:
        input.serviceName,

      types:
        input.types ||
        ["agent", "mitra"],

      location:
        input.location ||
        null,

      needs:
        input.needs ||
        [],

      query:
        input.query ||
        "",

      context:
        input.context ||
        {}
    });
  }

  /* ==========================================================
   * CUSTOMER-FACING STATUS TEXT
   * ========================================================== */

  function getCustomerMessage(
    result
  ) {
    if (!result) {
      return {
        status:
          STATUS.UNKNOWN,

        text:
          "Aku belum bisa memastikan kondisi layanan itu."
      };
    }

    if (
      result.status ===
      STATUS.AVAILABLE
    ) {
      if (!result.verified) {
        return {
          status:
            STATUS.UNKNOWN,

          text:
            "Aku belum bisa memastikan ketersediaannya."
        };
      }

      return {
        status:
          STATUS.AVAILABLE,

        text:
          "Aku sudah cek berdasarkan data yang tersedia, dan layanan yang kamu cari terkonfirmasi tersedia."
      };
    }

    if (
      result.status ===
      STATUS.UNAVAILABLE
    ) {
      if (!result.verified) {
        return {
          status:
            STATUS.UNKNOWN,

          text:
            "Aku belum punya data yang cukup untuk memastikan layanan itu sedang tidak tersedia."
        };
      }

      return {
        status:
          STATUS.UNAVAILABLE,

        text:
          "Aku sudah cek, dan berdasarkan data yang tersedia saat ini layanan yang kamu cari belum tersedia."
      };
    }

    if (
      result.status ===
      STATUS.ERROR
    ) {
      return {
        status:
          STATUS.ERROR,

        text:
          "Aku lagi mengalami kendala saat mengecek kondisi layanan. Jadi aku nggak mau asal bilang tersedia atau tidak."
      };
    }

    return {
      status:
        STATUS.UNKNOWN,

      text:
        "Aku belum bisa memastikan ketersediaannya dari data runtime yang bisa diverifikasi."
    };
  }

  /* ==========================================================
   * LAST RESULT
   * ========================================================== */

  function getLastResult() {
    return clone(
      lastResult
    );
  }

  function getLastRequest() {
    return clone(
      lastRequest
    );
  }

  function getStatus() {
    if (!lastResult) {
      return STATUS.IDLE;
    }

    return (
      lastResult.status ||
      STATUS.UNKNOWN
    );
  }

  /* ==========================================================
   * RUNTIME HEALTH
   * ========================================================== */

  function runtimeHealth() {
    return {
      connected:
        isConnected(),

      version:
        VERSION,

      adapterMethods:
        isConnected()
          ? {
              check:
                typeof runtimeAdapter.check ===
                "function",

              checkAsync:
                typeof runtimeAdapter.checkAsync ===
                "function",

              findNearby:
                typeof runtimeAdapter.findNearby ===
                "function"
            }
          : {
              check: false,
              checkAsync: false,
              findNearby: false
            },

      lastCheck:
        lastResult
          ? {
              status:
                lastResult.status,

              verified:
                lastResult.verified,

              checkedAt:
                lastResult.checkedAt
            }
          : null
    };
  }

  /* ==========================================================
   * PUBLIC MODULE
   * ========================================================== */

  const Discovery = {

    version: VERSION,

    status:
      clone(STATUS),

    sourceTypes:
      SOURCE_TYPES.slice(),

    connect,

    disconnect,

    isConnected,

    screen,

    screenAsync,

    findNearby,

    findNearbyAsync,

    getCustomerMessage,

    verifyResult,

    getLastResult,

    getLastRequest,

    getStatus,

    runtimeHealth,

    on
  };

  /* ==========================================================
   * ATTACH MODULE
   * ========================================================== */

  ROOT.discovery =
    Discovery;

  if (
    typeof ROOT.registerModule ===
    "function"
  ) {
    ROOT.registerModule(
      "discovery",
      Discovery
    );
  }

  /* ==========================================================
   * READY EVENT
   * ========================================================== */

  if (
    typeof ROOT.emit ===
    "function"
  ) {
    ROOT.emit(
      "module:ready",
      {
        module: "discovery",
        version: VERSION
      }
    );
  }

  console.info(
    "[CGO Customer] Discovery Engine ready:",
    VERSION
  );

})(window);
