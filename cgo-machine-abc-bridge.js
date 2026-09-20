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

  const VERSION = "1.0.0-ABC-BRIDGE";
  const listeners = new Set();
  let lastPacket = null;

  function emit(name, detail) {
    try {
      global.dispatchEvent(new CustomEvent(name, { detail }));
    } catch (_) {}
  }

  let bc = null;
  try { bc = new BroadcastChannel("CGO_MACHINE_ABC_MONITOR"); } catch (_) {}

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
    // Kirim ke tab monitor Mesin ABC (jika terbuka)
    try { bc && bc.postMessage({ type: "ABC_PACKET", packet }); } catch (_) {}
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
      const status = out?.result?.status || out?.finalResult?.status || null;
      const packet = {
        ok: true,
        engine: "CGO_MACHINE_ABC",
        version: E.version,
        status,
        confidence: out?.result?.decision?.confidence ?? out?.finalResult?.decision?.confidence ?? null,
        summary: out?.result?.summary || null,
        findings: out?.result?.findings || [],
        audit: out?.audit || out?.cycles?.at?.(-1)?.audit || null,
        packet: out
      };
      try {
        const ch = new BroadcastChannel("CGO_MACHINE_ABC_BUS");
        ch.postMessage({ type: "abc-result", status, source: "bridge-analyze", version: E.version, at: Date.now() });
        ch.close();
      } catch (_) {}
      return packet;
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
    pause: () => E.pause(),
    resume: () => E.resume(),
    isPaused: () => E.isPaused()
  });

  global.CGOMachineABCBridge = API;
  global.CGO_MACHINE_ABC = E;
  // Alias singkat untuk Otak CGO
  if (!global.CGOCoreMachine) global.CGOCoreMachine = E;

  emit("cgo:machine-abc-ready", { version: VERSION, engine: E.version });
  console.log("[CGO-ABC-BRIDGE] Siap · engine", E.version, "· bridge", VERSION);
})(typeof globalThis !== "undefined" ? globalThis : window);
