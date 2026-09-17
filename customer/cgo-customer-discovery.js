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
    "1.4.0-discovery-agent-geo-scoped-production";

  const LOCATION_MAX_AGE_MS = 120000;
  const AGENT_PRESENCE_MAX_AGE_MS = 180000;
  const MAX_NEARBY_RADIUS_KM = 10;
  const MAX_NEARBY_RESULTS = 20;
  const DEFAULT_RADIUS_KM = 5;

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
  let latestRequestId = null;

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
   * CUSTOMER LOCATION + AGENT PRESENCE
   * ========================================================== */

  function toFiniteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function normalizeCoordinates(value) {
    const source = value && typeof value === "object" ? value : {};
    const lat = toFiniteNumber(
      source.lat ?? source.latitude ?? source.coords?.latitude
    );
    const lng = toFiniteNumber(
      source.lng ?? source.lon ?? source.longitude ?? source.coords?.longitude
    );
    if (lat === null || lng === null || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return null;
    }
    const accuracy = toFiniteNumber(source.accuracy ?? source.coords?.accuracy);
    const obtainedAt = source.obtainedAt || source.updatedAt || source.timestamp || now();
    return { lat, lng, accuracy, obtainedAt };
  }

  function isFresh(timestamp, maxAge) {
    const time = Date.parse(timestamp || "");
    if (!Number.isFinite(time)) return false;
    return Math.abs(now() - time) <= maxAge;
  }

  function haversineKm(a, b) {
    const earthRadius = 6371;
    const lat1 = a.lat * Math.PI / 180;
    const lat2 = b.lat * Math.PI / 180;
    const dLat = (b.lat - a.lat) * Math.PI / 180;
    const dLng = (b.lng - a.lng) * Math.PI / 180;
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return earthRadius * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  async function getCustomerLocation(options = {}) {
    if (runtimeAdapter && typeof runtimeAdapter.getCustomerLocation === "function") {
      try {
        const location = await runtimeAdapter.getCustomerLocation(clone(options));
        const normalized = normalizeCoordinates(location);
        if (normalized) return { ok: true, verified: true, source: "runtime:customer-geolocation", location: normalized };
      } catch (error) {
        return { ok: false, verified: false, source: "runtime:customer-geolocation", error: cleanText(error?.message || error) };
      }
    }

    if (typeof navigator !== "undefined" && navigator.geolocation) {
      return new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
          (position) => {
            const location = normalizeCoordinates({
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
              accuracy: position.coords.accuracy,
              obtainedAt: new Date(position.timestamp || now()).toISOString()
            });
            resolve(location
              ? { ok: true, verified: true, source: "browser:navigator.geolocation", location }
              : { ok: false, verified: false, source: "browser:navigator.geolocation" });
          },
          (error) => resolve({
            ok: false,
            verified: false,
            source: "browser:navigator.geolocation",
            error: cleanText(error?.message || error?.code || "LOCATION_UNAVAILABLE")
          }),
          {
            enableHighAccuracy: options.enableHighAccuracy !== false,
            maximumAge: Number.isFinite(options.maximumAge) ? options.maximumAge : 30000,
            timeout: Number.isFinite(options.timeout) ? options.timeout : 10000
          }
        );
      });
    }

    return { ok: false, verified: false, source: null, error: "CUSTOMER_LOCATION_UNAVAILABLE" };
  }

  function enrichNearbyResult(result, request) {
    if (!result || typeof result !== "object") return result;
    const customerLocation = normalizeCoordinates(request.location);
    if (!customerLocation) return result;

    const radiusKm = Number.isFinite(Number(request.radiusKm))
      ? Math.min(MAX_NEARBY_RADIUS_KM, Math.max(0, Number(request.radiusKm)))
      : DEFAULT_RADIUS_KM;

    const items = Array.isArray(result.items) ? result.items : [];
    const nearby = items.map((item) => {
      if (item?.presenceVerified === true && Number.isFinite(Number(item.distanceKm))) {
        if (item.active === false || item.online === false || item.available === false) return null;
        const updatedAt = item.updatedAt || null;
        if (!isFresh(updatedAt, AGENT_PRESENCE_MAX_AGE_MS)) return null;
        const distance = Number(item.distanceKm);
        if (distance > radiusKm) return null;
        return {
          ...clone(item),
          distanceKm: Number(distance.toFixed(3)),
          distanceMeters: Number.isFinite(Number(item.distanceMeters))
            ? Number(item.distanceMeters)
            : Math.round(distance * 1000),
          presenceVerified: true
        };
      }

      const location = normalizeCoordinates(item?.location || item?.coordinates || item);
      if (!location) return null;
      if (item.active === false || item.online === false || item.available === false) return null;
      const updatedAt = item.updatedAt || item.lastSeenAt || item.timestamp || location.obtainedAt;
      if (!isFresh(updatedAt, AGENT_PRESENCE_MAX_AGE_MS)) return null;
      const distanceKm = haversineKm(customerLocation, location);
      if (distanceKm > radiusKm) return null;
      return {
        ...clone(item),
        location,
        distanceKm: Number(distanceKm.toFixed(3)),
        distanceMeters: Math.round(distanceKm * 1000),
        presenceVerified: true
      };
    }).filter(Boolean).sort((a, b) => a.distanceKm - b.distanceKm).slice(0, MAX_NEARBY_RESULTS);

    return {
      ...result,
      status: nearby.length ? STATUS.AVAILABLE : STATUS.UNAVAILABLE,
      verified: result.verified === true,
      items: nearby,
      count: nearby.length,
      data: {
        ...(result.data && typeof result.data === "object" ? clone(result.data) : {}),
        customerLocation,
        radiusKm,
        nearbyAgents: nearby
      },
      metadata: {
        ...(result.metadata && typeof result.metadata === "object" ? clone(result.metadata) : {}),
        locationMode: "CUSTOMER_GEOLOCATION",
        distanceMethod: "HAVERSINE_LOCAL",
        agentPresenceFreshnessMs: AGENT_PRESENCE_MAX_AGE_MS,
        resultLimit: MAX_NEARBY_RESULTS
      }
    };
  }

  async function prepareNearbyRequest(request) {
    const normalized = normalizeRequest(request);
    const needsLocation = normalized.types.some((type) => ["agent", "driver", "mitra"].includes(type)) ||
      /(?:dekat|sekitar|di mana|dimana|lokasi)/i.test(normalized.query);
    if (!needsLocation || normalized.location) return normalized;

    const location = await getCustomerLocation(normalized.locationOptions || {});
    if (!location.verified) {
      return { ...normalized, locationError: location.error || "CUSTOMER_LOCATION_NOT_VERIFIED" };
    }
    return { ...normalized, location: location.location, locationSource: location.source };
  }

  function sanitizeNearbyItem(item) {
    if (!item || typeof item !== "object") return item;
    const safe = clone(item);
    delete safe.location;
    delete safe.coordinates;
    delete safe.position;
    delete safe.lat;
    delete safe.lng;
    delete safe.latitude;
    delete safe.longitude;
    return safe;
  }

  function sanitizeDiscoveryResult(result) {
    if (!result || typeof result !== "object") return result;
    const safe = clone(result);
    if (safe.data && typeof safe.data === "object") {
      delete safe.data.customerLocation;
      delete safe.data.nearbyAgents;
    }
    if (Array.isArray(safe.items)) safe.items = safe.items.map(sanitizeNearbyItem);
    if (safe.request && typeof safe.request === "object") {
      delete safe.request.location;
      delete safe.request.locationOptions;
    }
    return safe;
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
        cleanText(input.requestId) ||
        ("discovery-" + now() + "-" + (++requestSequence)),

      serviceId,

      serviceName:
        cleanText(
          input.serviceName ||
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

      radiusKm:
        Number.isFinite(Number(input.radiusKm))
          ? Math.max(0, Number(input.radiusKm))
          : DEFAULT_RADIUS_KM,

      locationOptions:
        clone(input.locationOptions || {}),

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
    const verified =
      raw.verified === false
        ? false
        : Boolean(
            raw.verified === true ||
            raw.source ||
            raw.data ||
            raw.items ||
            raw.records
          );

    // Explicit unverified runtime output can never claim live availability.
    if (raw.verified === false &&
        (status === STATUS.AVAILABLE || status === STATUS.UNAVAILABLE)) {
      status = STATUS.UNKNOWN;
    }

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
    const RUNTIME_CHECK_TIMEOUT_MS = 15000;

    if (!isConnected()) {
      return unknownResult(
        request,
        "Runtime CIKUR GO belum terhubung."
      );
    }

    try {
      let raw;

      let runtimePromise = null;

      if (
        typeof runtimeAdapter.checkAsync ===
        "function"
      ) {
        runtimePromise = runtimeAdapter.checkAsync(
          clone(request)
        );
      } else if (
        typeof runtimeAdapter.check ===
        "function"
      ) {
        runtimePromise = runtimeAdapter.check(
          clone(request)
        );
      } else if (
        typeof runtimeAdapter.findNearby ===
        "function"
      ) {
        runtimePromise = runtimeAdapter.findNearby(
          clone(request)
        );
      } else {
        return unknownResult(
          request,
          "Runtime tidak memiliki metode pemeriksaan."
        );
      }

      let timeoutHandle;
      try {
        raw = await Promise.race([
          Promise.resolve(runtimePromise),
          new Promise((resolve) => {
            timeoutHandle = setTimeout(() => {
              resolve({
                ok: false,
                status: STATUS.UNKNOWN,
                verified: false,
                request: clone(request),
                source: "runtime",
                checkedAt: now(),
                data: null,
                items: [],
                count: 0,
                timeout: true,
                reason:
                  "Runtime check timeout: data live belum selesai diverifikasi dalam batas waktu."
              });
            }, RUNTIME_CHECK_TIMEOUT_MS);
          })
        ]);
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
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
    latestRequestId = normalized.requestId;

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

    const enriched =
      normalized.location &&
      normalized.types.some((type) => ["agent", "driver", "mitra"].includes(type))
        ? enrichNearbyResult(result, normalized)
        : result;

    const verification =
      verifyResult(
        enriched
      );

    if (
      enriched.status ===
        STATUS.AVAILABLE &&
      !verification.verified
    ) {
      enriched.status =
        STATUS.UNKNOWN;

      enriched.verified =
        false;

      enriched.message =
        "Data runtime belum cukup untuk memastikan ketersediaan.";
    }

    if (normalized.requestId !== latestRequestId) {
      return sanitizeDiscoveryResult({
        ...enriched,
        stale: true,
        status: STATUS.UNKNOWN,
        verified: false,
        message: "Hasil pencarian lama diabaikan karena ada request Customer yang lebih baru."
      });
    }

    const safeEnriched = sanitizeDiscoveryResult(enriched);
    lastResult = clone(safeEnriched);

    emit(
      "discovery:completed",
      clone(safeEnriched)
    );

    return safeEnriched;
  }

  /* ==========================================================
   * ASYNC SCREENING
   * ========================================================== */

  async function screenAsync(
    request
  ) {
    const normalized =
      await prepareNearbyRequest(request);

    lastRequest =
      clone(normalized);
    latestRequestId = normalized.requestId;

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

    let result =
      await invokeAsync(
        normalized
      );

    if (normalized.locationError) {
      result = unknownResult(
        normalized,
        "Lokasi Customer belum dapat diverifikasi, jadi aku belum bisa menentukan Agent CGO yang benar-benar berada di sekitar sini."
      );
      result.metadata = { locationRequired: true, locationError: normalized.locationError };
    } else if (
      normalized.location &&
      normalized.types.some((type) => ["agent", "driver", "mitra"].includes(type))
    ) {
      result = enrichNearbyResult(result, normalized);
    }

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

    if (normalized.requestId !== latestRequestId) {
      return sanitizeDiscoveryResult({
        ...result,
        stale: true,
        status: STATUS.UNKNOWN,
        verified: false,
        message: "Hasil pencarian lama diabaikan karena ada request Customer yang lebih baru."
      });
    }

    const safeResult = sanitizeDiscoveryResult(result);
    lastResult = clone(safeResult);

    emit(
      "discovery:completed",
      clone(safeResult)
    );

    return safeResult;
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

      radiusKm:
        input.radiusKm,

      requestId:
        input.requestId,

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

      radiusKm:
        input.radiusKm,

      requestId:
        input.requestId,

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
    const safe = clone(lastRequest);
    if (safe && typeof safe === "object") {
      delete safe.location;
      delete safe.locationOptions;
    }
    return safe;
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

    getCustomerLocation,

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
