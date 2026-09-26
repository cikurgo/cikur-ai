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

  const VERSION = "1.5.0-LIVE-ACK";
  const BUILD_ID = "CIKUR-GO-LIVE-ACK-2026-09-26";
  const listeners = new Set();
  let lastPacket = null;
  let lastLiveFingerprint = null;
  let liveRevision = 0;
  let liveBus = null;
  try { liveBus = new BroadcastChannel("CGO_MACHINE_ABC_LIVE_LINK"); } catch (_) {}

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
  function fingerprintEvidence(packet) {
    try {
      const text = JSON.stringify(packet, Object.keys(packet || {}).sort());
      let h = 2166136261;
      for (let i=0;i<text.length;i++){ h^=text.charCodeAt(i); h=Math.imul(h,16777619); }
      return (h>>>0).toString(16).padStart(8,"0");
    } catch (_) { return null; }
  }

  // Adapter BCGO -> kontrak evidence netral. ABC tidak mengetahui domain BCGO.
  function buildBCGOEvidence(state) {
    if (!state || typeof state !== "object") return null;
    const claims=[];
    const organs=state.systemOrgans && typeof state.systemOrgans==="object" ? state.systemOrgans : {};
    for (const [target,info] of Object.entries(organs)) {
      const status=String(info?.status||info?.state||"UNKNOWN").toUpperCase();
      if (["ANOMALY","ERROR","DEGRADED","REVIEW","RECOVERED","UNREADABLE","UNKNOWN","STALE"].includes(status)) {
        claims.push({source:"BCGO.systemOrgans",target,status,severity:info?.severity||((status==="ANOMALY"||status==="ERROR")?"HIGH":"MEDIUM"),message:info?.message||null,evidence:{reportedAt:info?.reportedAt??null,line:info?.line??null,column:info?.column??null}});
      }
    }
    for (const c of (Array.isArray(state.activeCases)?state.activeCases:[])) {
      claims.push({source:"BCGO.activeCases",target:c?.target||null,status:String(c?.status||"UNKNOWN").toUpperCase(),severity:c?.severity||"MEDIUM",message:c?.evidence?.message||null,evidence:c?.evidence||null});
    }
    const scan=state.sourceScan&&typeof state.sourceScan==="object"?state.sourceScan:null;
    if(scan){
      if(String(scan.status||"").toUpperCase()!=="CLEAN") claims.push({source:"BCGO.sourceScan",target:"sourceScan",status:String(scan.status||"UNKNOWN").toUpperCase(),severity:"HIGH",message:scan.message||null,evidence:{filesReadable:scan.filesReadable??null,totalFiles:scan.totalFiles??null,filesFailed:scan.filesFailed??null,relationSummary:scan.relationSummary||null}});
      for(const x of (Array.isArray(scan.crossFileFindings)?scan.crossFileFindings:[])) claims.push({source:"BCGO.sourceScan.crossFileFindings",target:x?.sourceFile||x?.targetFile||null,status:String(x?.status||"MISMATCH").toUpperCase(),severity:"HIGH",message:x?.key||null,evidence:x});
    }
    const nerves=state.fileNerves&&typeof state.fileNerves==="object"?state.fileNerves:{};
    for(const [target,n] of Object.entries(nerves)){const st=String(n?.health?.overall||"UNKNOWN").toUpperCase();if(st!=="HEALTHY")claims.push({source:"BCGO.fileNerves",target,status:st,severity:st==="ANOMALY"?"HIGH":"MEDIUM",message:n?.source?.message||null,evidence:{health:n?.health||null,evidenceSummary:n?.evidenceSummary||null,changed:!!n?.changed,contentHash:n?.contentHash||null}});}
    const capturedAt = Number(state.firestore?.lastServerAt || state.lastTelemetryAt || Date.now());
    const ageMs = Math.max(0, Date.now() - capturedAt);
    const serverLive = state.firestore?.connected === true && ageMs <= 120000;
    const telemetryLive = Number.isFinite(Number(state.lastTelemetryAt)) && (Date.now() - Number(state.lastTelemetryAt)) <= 900000;
    const explicitMode = String(state.operationMode || state.sourceMode || "").toUpperCase();
    const mode = explicitMode === "TEST" ? "TEST" : (serverLive || telemetryLive ? "LIVE" : "STANDBY");
    const observations = {
      connection: state.connection?.status || (serverLive ? "LIVE" : "UNKNOWN"),
      firestoreConnected: !!state.firestore?.connected,
      firestoreCount: Number(state.firestore?.count || 0),
      lastServerAt: Number(state.firestore?.lastServerAt || 0) || null,
      lastTelemetryAt: Number(state.lastTelemetryAt || 0) || null,
      telemetryAgeMs: Number.isFinite(Number(state.lastTelemetryAt)) ? Math.max(0, Date.now() - Number(state.lastTelemetryAt)) : null,
      cycle: Number(state.cycle || 0),
      cycleMode: state.cycleMode || null,
      activeCases: Array.isArray(state.activeCases) ? state.activeCases.length : 0,
      sourceScanStatus: state.sourceScan?.status || null
    };
    const fingerprint = fingerprintEvidence({claims,observations,mode});
    return {schema:"CGO_EXTERNAL_EVIDENCE_V1",source:"BCGO",capturedAt,revision:++liveRevision,mode,ageMs,serverLive,telemetryLive,observations,claims,fingerprint};
  }

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

      // Default bridge sekarang FULL PIPELINE: A→B→C→D.
      // Jalur cepat hanya aktif bila caller meminta fast:true / skipAudit:true secara eksplisit.
      if (opts.maxCycles == null) opts.maxCycles = 1;
      if (opts.autoReflect == null) opts.autoReflect = false;
      if (opts.fast == null) opts.fast = false;
      if (opts.skipAudit == null) opts.skipAudit = false;

      if (opts.bcgoState) {
        opts.externalEvidence = buildBCGOEvidence(opts.bcgoState);
        delete opts.bcgoState;
      }
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
        summary: result?.summary ?? null,
        findings: Array.isArray(result?.findings) ? result.findings : [],
        audit: out?.audit || lastCycle?.audit || null,
        externalEvidence: opts.externalEvidence || null,
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

  function ingestBCGOState(state) {
    const evidence = buildBCGOEvidence(state);
    if (!evidence) return {ok:false,error:"BCGO_STATE_REQUIRED"};
    if (evidence.mode === "TEST") {
      return {ok:false,mode:"TEST",status:"TEST_INPUT_REQUIRES_EXPLICIT_TEST_PATH",evidence};
    }
    // Jangan memproses snapshot yang identik berulang-ulang. Ini menjaga jalur live stabil.
    const dedupeKey = fingerprintEvidence({mode:evidence.mode,observations:evidence.observations,claims:evidence.claims});
    if (dedupeKey && dedupeKey === lastLiveFingerprint) {
      // Late subscriber support: ABC may have opened after BCGO already processed
      // this snapshot. Re-emit the last verified link so the new page can hydrate.
      const cachedLink = global.CGO_ABC_LIVE_LINK || null;
      try { if (cachedLink) liveBus?.postMessage(cachedLink); } catch (_) {}
      return {ok:true,duplicate:true,mode:evidence.mode,status:cachedLink?.status||lastPacket?.result?.status||null,audit:cachedLink?.audit||lastPacket?.audit?.status||null,evidence,link:cachedLink,packet:lastPacket};
    }
    lastLiveFingerprint = dedupeKey;
    try {
      const packet = E.process(
        {type:"external-evidence-snapshot",source:"BCGO",capturedAt:evidence.capturedAt,mode:evidence.mode,observations:evidence.observations},
        {source:"BCGO_STATE_SYNC",externalEvidence:evidence}
      );
      lastPacket = packet;
      const link = {
        type:"CGO_ABC_LIVE_LINK",
        source:"BCGO",
        mode:evidence.mode,
        revision:evidence.revision,
        capturedAt:evidence.capturedAt,
        ageMs:evidence.ageMs,
        serverLive:evidence.serverLive,
        telemetryLive:evidence.telemetryLive,
        status:packet.result?.status||null,
        audit:packet.audit?.status||null,
        fingerprint:evidence.fingerprint,
        claimCount:evidence.claims.length,
        packet
      };
      try { global.CGO_ABC_LIVE_LINK = Object.freeze({...link}); } catch (_) {}
      try { liveBus?.postMessage(link); } catch (_) {}
      emit("cgo:machine-abc-bcgo-sync", link);
      return {ok:true,mode:evidence.mode,status:packet.result?.status||null,audit:packet.audit?.status||null,evidence,packet};
    } catch(err) {
      const error=String(err?.message||err);
      const link={type:"CGO_ABC_LIVE_LINK",source:"BCGO",mode:evidence.mode,status:"ERROR",audit:"ATTENTION",error,revision:evidence.revision};
      try { liveBus?.postMessage(link); } catch (_) {}
      return {ok:false,mode:evidence.mode,error,link};
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
    build: BUILD_ID,
    engineVersion: E.version,
    engine: E,
    analyze,
    buildBCGOEvidence,
    ingestBCGOState,
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

  emit("cgo-machine-abc-ready", { version: VERSION, engine: E.version, build: BUILD_ID });
  emit("cgo:machine-abc-ready", { version: VERSION, engine: E.version, build: BUILD_ID });

  console.log("[CGO-ABC-BRIDGE] Siap · engine", E.version, "· bridge", VERSION);
})(typeof globalThis !== "undefined" ? globalThis : window);
