/**
 * CGO MACHINE ABC — Bridge ke Otak CGO / BCGO
 * Mesin ABC murni (zero network). Bridge ini hanya:
 *  - memastikan engine terpasang di window
 *  - meneruskan hasil observasi ke event CGO/BCGO
 *  - API ringkas untuk analisis struktur teks/HTML/JS
 */
(function (global) {
  "use strict";

  const E = global.CGOMachineABC;
  if (!E) {
    console.warn("[CGO-ABC-BRIDGE] CGOMachineABC belum termuat. Muat cgo-machine-abc.js lebih dulu.");
    return;
  }

  const VERSION = "1.1.0-ABC-BRIDGE-BUS";
  const BUS_NAME = "cgo-machine-abc-bus";
  const listeners = new Set();
  let lastPacket = null;
  let bus = null;
  try {
    if (typeof BroadcastChannel !== "undefined") bus = new BroadcastChannel(BUS_NAME);
  } catch (_) { bus = null; }

  function publishBus(kind, data) {
    const msg = {
      type: "CGO_ABC_BUS",
      kind: kind,
      source: (typeof location !== "undefined" && location.pathname) || "unknown",
      at: new Date().toISOString(),
      data: data
    };
    try { if (bus) bus.postMessage(msg); } catch (_) {}
    try {
      // fallback lintas-tab untuk browser tanpa BroadcastChannel
      localStorage.setItem("cgo-abc-bus-ping", JSON.stringify({ t: Date.now(), kind: kind }));
    } catch (_) {}
    return msg;
  }


  function emit(name, detail) {
    try {
      global.dispatchEvent(new CustomEvent(name, { detail }));
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
    // Siaran lintas-tab → monitor ABC / tab BCGO lain bisa melihat siklus
    try {
      const cycles = packet?.cycles || [];
      const compact = (Array.isArray(cycles) ? cycles : []).map((c, i) => {
        const r = c && (c.result || c);
        return {
          cycleIndex: c?.cycleIndex ?? i,
          result: r ? {
            status: r.status,
            durationMs: r.durationMs || c?.pipeline?.C?.durationMs || 0,
            decision: r.decision || null,
            findings: r.findings || [],
            relations: r.relations || [],
            evidence: r.evidence || [],
            uncertainty: r.uncertainty || [],
            reasoning: r.reasoning || [],
            summary: r.summary || null
          } : null,
          audit: c?.audit || null,
          pipeline: c?.pipeline ? { A: !!c.pipeline.A, B: !!c.pipeline.B, C: !!c.pipeline.C } : null
        };
      });
      publishBus("cycle", {
        result: compact[0]?.result || packet?.result || null,
        cycles: compact,
        stopReason: packet?.stopReason || null,
        timestamp: packet?.timestamp || null
      });
    } catch (_) {}
    for (const fn of [...listeners]) {
      try { fn(packet); } catch (_) {}
    }
  }

  // Satu observer global — tidak dobel jika bridge dipanggil ulang
  if (!global.__CGO_ABC_BRIDGE_OBSERVER__) {
    global.__CGO_ABC_BRIDGE_OBSERVER__ = true;
    E.observe(onPacket);
  }

  /**
   * Analisis payload (teks / objek / HTML / JSON) lewat pipeline A→B→C→D.
   * Aman dipanggil dari BCGO chat / scanner.
   */
  function analyze(input, options = {}) {
    if (E.isPaused()) {
      return { ok: false, paused: true, message: "Mesin ABC sedang dijeda." };
    }
    try {
      // Default cepat: 1 siklus, skip audit D (kecuali options.fullAudit)
      const fast = options.fast !== false && !options.fullAudit && !options.autoReflect;
      const out = E.process(input, {
        maxCycles: options.maxCycles ?? 1,
        autoReflect: !!options.autoReflect,
        fast: fast,
        skipAudit: fast,
        ...options
      });
      return {
        ok: true,
        engine: "CGO_MACHINE_ABC",
        version: E.version,
        status: out?.result?.status || out?.finalResult?.status || null,
        confidence: out?.result?.decision?.confidence ?? out?.finalResult?.decision?.confidence ?? null,
        summary: out?.result?.summary || null,
        findings: out?.result?.findings || [],
        audit: out?.audit || out?.cycles?.at?.(-1)?.audit || null,
        packet: out
      };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  /** Ringkas status engine untuk panel kesehatan BCGO */
  let _healthCache = null;
  let _healthCacheAt = 0;
  const HEALTH_TTL_MS = 120000;

  function healthSnapshot(force) {
    const nowMs = Date.now();
    if (!force && _healthCache && (nowMs - _healthCacheAt) < HEALTH_TTL_MS) {
      return { ..._healthCache, cached: true, metrics: E.getMetrics(), paused: E.isPaused() };
    }
    const st = E.selfTest();
    const m = E.getMetrics();
    const ind = E.auditIndependence();
    _healthCache = {
      engine: "CGO_MACHINE_ABC",
      version: E.version,
      bridge: VERSION,
      selfTest: { passed: st.passed, total: st.total, verified: st.verified },
      independence: { verified: ind.verified, scanned: ind.scannedFunctions },
      metrics: m,
      paused: E.isPaused(),
      lastStatus: lastPacket?.result?.status || m.lastStatus || null,
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
      if (typeof fn === "function") listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getLastPacket: () => lastPacket,
    publishBus,
    BUS_NAME,
    pause: () => E.pause(),
    resume: () => E.resume(),
    isPaused: () => E.isPaused()
  });

  global.CGOMachineABCBridge = API;
  global.CGO_MACHINE_ABC = E;
  // Alias singkat untuk Otak CGO
  if (!global.CGOCoreMachine) global.CGOCoreMachine = E;

  emit("cgo-machine-abc-ready", { version: VERSION, engine: E.version });
  emit("cgo:machine-abc-ready", { version: VERSION, engine: E.version });
  try { publishBus("ready", { version: VERSION, engine: E.version }); } catch (_) {}
  console.log("[CGO-ABC-BRIDGE] Siap · engine", E.version, "· bridge", VERSION);
})(typeof globalThis !== "undefined" ? globalThis : window);
