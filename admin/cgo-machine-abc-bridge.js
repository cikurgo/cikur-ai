/**
 * CGO MACHINE ABC — Bridge ke Otak CGO / BCGO
 * Mesin ABC murni (zero network, zero storage).
 * Bridge ini hanya:
 *  - memastikan engine terpasang di window
 *  - meneruskan hasil observasi ke event CGO/BCGO
 *  - menyediakan API resmi untuk analisis payload
 */
(function (global) {
  "use strict";

  const E = global.CGOMachineABC;
  if (!E) {
    console.warn("[CGO-ABC-BRIDGE] CGOMachineABC belum termuat. Muat cgo-machine-abc.js lebih dulu.");
    return;
  }

  const VERSION = "1.2.0-ABC-BRIDGE";
  const listeners = new Set();
  let lastPacket = null;

  function emit(name, detail) {
    try {
      if (typeof global.dispatchEvent === "function" &&
          typeof global.CustomEvent === "function") {
        global.dispatchEvent(new CustomEvent(name, { detail }));
      }
    } catch (_) {}
  }

  function onPacket(packet) {
    lastPacket = packet;
    emit("cgo:machine-abc", packet);
    emit("cikur-internal-ai-state", {
      source: "CGO_MACHINE_ABC",
      version: E.version,
      bridge: VERSION,
      result: packet?.result || null,
      stopReason: packet?.stopReason || null,
      timestamp: packet?.timestamp || new Date().toISOString()
    });

    for (const fn of [...listeners]) {
      try { fn(packet); } catch (_) {}
    }
  }

  // Satu observer global — tidak dobel jika bridge dimuat ulang.
  if (!global.__CGO_ABC_BRIDGE_OBSERVER__) {
    global.__CGO_ABC_BRIDGE_OBSERVER__ = true;
    if (typeof E.observe === "function") E.observe(onPacket);
  }

  /**
   * API input resmi bridge.
   * Payload diteruskan ke E.process() tanpa fetch/XHR/WebSocket,
   * tanpa BroadcastChannel dan tanpa localStorage.
   */
  function analyze(input, options = {}) {
    if (typeof E.process !== "function") {
      return { ok: false, error: "CGOMachineABC.process tidak tersedia." };
    }

    if (typeof E.isPaused === "function" && E.isPaused()) {
      return { ok: false, paused: true, message: "Mesin ABC sedang dijeda." };
    }

    try {
      const opts = (options && typeof options === "object" && !Array.isArray(options))
        ? { ...options }
        : {};

      // Default bridge: jalur penuh dengan audit Machine D. Fast mode hanya bila diminta eksplisit.
      const fast = opts.fast === true && !opts.fullAudit && !opts.autoReflect;

      if (opts.maxCycles == null) opts.maxCycles = 1;
      if (opts.autoReflect == null) opts.autoReflect = false;
      if (opts.fast == null) opts.fast = fast;
      if (opts.skipAudit == null) opts.skipAudit = fast;

      const out = E.process(input, opts);
      const result = out?.result || out?.finalResult || null;
      const lastCycle = Array.isArray(out?.cycles) && out.cycles.length
        ? out.cycles[out.cycles.length - 1]
        : null;

      return {
        ok: true,
        engine: "CGO_MACHINE_ABC",
        version: E.version,
        status: result?.status ?? null,
        confidence: result?.decision?.confidence ?? null,
        result,
        summary: result?.summary ?? null,
        findings: Array.isArray(result?.findings) ? result.findings : [],
        audit: out?.audit || lastCycle?.audit || null,
        packet: out
      };
    } catch (err) {
      return {
        ok: false,
        error: String(err?.message || err),
        name: err?.name || "Error"
      };
    }
  }

  /** Ringkas status engine untuk panel kesehatan BCGO. */
  let _healthCache = null;
  let _healthCacheAt = 0;
  const HEALTH_TTL_MS = 120000;

  function healthSnapshot(force = false) {
    const nowMs = Date.now();

    let metrics = null;
    try {
      metrics = typeof E.getMetrics === "function" ? E.getMetrics() : null;
    } catch (_) {}

    const paused = typeof E.isPaused === "function" ? E.isPaused() : false;

    if (!force && _healthCache && (nowMs - _healthCacheAt) < HEALTH_TTL_MS) {
      return { ..._healthCache, cached: true, metrics, paused };
    }

    let st = { passed: false, total: 0, verified: false };
    let ind = { verified: false, scannedFunctions: 0 };

    try {
      if (typeof E.selfTest === "function") st = E.selfTest() || st;
    } catch (_) {}

    try {
      if (typeof E.auditIndependence === "function") ind = E.auditIndependence() || ind;
    } catch (_) {}

    _healthCache = {
      engine: "CGO_MACHINE_ABC",
      version: E.version,
      bridge: VERSION,
      selfTest: {
        passed: !!st.passed,
        total: Number(st.total) || 0,
        verified: !!st.verified
      },
      independence: {
        verified: !!ind.verified,
        scanned: Number(ind.scannedFunctions) || 0
      },
      metrics,
      paused,
      lastStatus: lastPacket?.result?.status || metrics?.lastStatus || null,
      cached: false
    };
    _healthCacheAt = nowMs;
    return _healthCache;
  }

  const API = Object.freeze({
    version: VERSION,
    engineVersion: E.version,
    engine: E,
    analyze,
    healthSnapshot,
    process: (input, opt) => E.process(input, opt || {}),
    observe: (fn) => {
      if (typeof fn !== "function") return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getLastPacket: () => lastPacket,
    pause: () => typeof E.pause === "function" && E.pause(),
    resume: () => typeof E.resume === "function" && E.resume(),
    isPaused: () => typeof E.isPaused === "function" ? E.isPaused() : false
  });

  global.CGOMachineABCBridge = API;
  global.CGO_MACHINE_ABC = E;

  // Alias singkat untuk Otak CGO.
  if (!global.CGOCoreMachine) global.CGOCoreMachine = E;

  emit("cgo-machine-abc-ready", { version: VERSION, engine: E.version });
  emit("cgo:machine-abc-ready", { version: VERSION, engine: E.version });

  console.log("[CGO-ABC-BRIDGE] Siap · engine", E.version, "· bridge", VERSION);
})(typeof globalThis !== "undefined" ? globalThis : window);
