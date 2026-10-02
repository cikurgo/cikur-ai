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

  const VERSION = "1.5.1-DOMAIN-UI";
  const PAGE_ID = "abc-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const BUS_NAME = "cgo-machine-abc-bus";
  const listeners = new Set();
  let lastPacket = null;
  let bus = null;
  let telemetryBus = null;
  let telemetryContext = { context: "UNSCOPED", loopEligible: false, bcgoCycle: null };
  try {
    if (typeof BroadcastChannel !== "undefined") telemetryBus = new BroadcastChannel("CGO_MACHINE_ABC_TELEMETRY");
  } catch (_) { telemetryBus = null; }

  function withTelemetryContext(context, loopEligible, bcgoCycle, fn) {
    const prev = telemetryContext;
    telemetryContext = { context: context || "UNSCOPED", loopEligible: loopEligible === true, bcgoCycle: bcgoCycle != null ? Number(bcgoCycle) : null };
    try { return fn(); } finally { telemetryContext = prev; }
  }

  function publishTelemetry(packet) {
    if (!packet || packet.type !== "ABC_TELEMETRY") return;
    const enriched = { ...packet, context: telemetryContext.context, loopEligible: telemetryContext.loopEligible, bcgoCycle: telemetryContext.bcgoCycle, bridgeVersion: VERSION };
    try { global.dispatchEvent(new CustomEvent("cgo:abc-telemetry", { detail: enriched })); } catch (_) {}
    try { if (telemetryBus) telemetryBus.postMessage(enriched); } catch (_) {}
    try { publishBus("telemetry", enriched); } catch (_) {}
    lastTelemetry = enriched;
    return enriched;
  }
  let lastTelemetry = null;
  try {
    if (typeof BroadcastChannel !== "undefined") bus = new BroadcastChannel(BUS_NAME);
  } catch (_) { bus = null; }

  let _lastPingAt = 0;
  function publishBus(kind, data) {
    const msg = {
      type: "CGO_ABC_BUS",
      kind: kind,
      source: (typeof location !== "undefined" && location.pathname) || "unknown",
      pageId: PAGE_ID,
      at: new Date().toISOString(),
      data: data
    };
    try { if (bus) bus.postMessage(msg); } catch (_) {}
    try {
      // fallback lintas-tab untuk browser tanpa BroadcastChannel (dibatasi: telemetry bisa puluhan paket/siklus)
      const t = Date.now();
      if (kind !== "telemetry" || t - _lastPingAt > 400) {
        _lastPingAt = t;
        localStorage.setItem("cgo-abc-bus-ping", JSON.stringify({ t: t, kind: kind }));
      }
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
      const cap = (a, n) => (Array.isArray(a) ? a.slice(0, n) : []);
      const compact = (Array.isArray(cycles) ? cycles : []).map((c, i) => {
        const r = c && (c.result || c);
        const P = c?.pipeline || {};
        const res = r ? {
          status: r.status,
          durationMs: r.durationMs || P.C?.durationMs || 0,
          decision: r.decision || null,
          findings: cap(r.findings, 60),
          relations: cap(r.relations, 60),
          evidence: cap(r.evidence, 60),
          uncertainty: cap(r.uncertainty, 60),
          reasoning: cap(r.reasoning, 60),
          constraints: cap(r.constraints, 60),
          hypotheses: cap(r.hypotheses, 60),
          inferences: cap(r.inferences, 60),
          verification: cap(r.verification, 60),
          contradictions: cap(r.contradictions, 60),
          summary: r.summary || null
        } : null;
        return {
          cycleIndex: c?.cycleIndex ?? i,
          result: res,
          audit: c?.audit || null,
          telemetry: c?.telemetry ? {
            route: c.telemetry.route || null,
            routeStatus: c.telemetry.routeStatus || null,
            phases: cap(c.telemetry.phases, 8).map(x => ({ stage: x.stage, status: x.status, durationMs: x.durationMs })),
            execution: cap(c.telemetry.execution, 40).map(x => ({ function: x.function, status: x.status, stage: x.stage, durationMs: x.durationMs, attempts: x.attempts, error: x.error ? String(x.error).slice(0, 120) : undefined }))
          } : null,
          // Monitor membaca daftar temuan/relasi/dst. dari pipeline.C dan jejak penalaran dari pipeline.B
          pipeline: c?.pipeline ? {
            A: { stage: P.A?.stage || "READY", durationMs: P.A?.durationMs, input: { type: P.A?.input?.type, fingerprint: P.A?.input?.fingerprint } },
            B: { stage: P.B?.stage || "processing", durationMs: P.B?.durationMs, degraded: !!P.B?.degraded, operations: cap(P.B?.operations, 40), reasoning: cap(P.B?.reasoning, 60), reasoningTrace: cap(P.B?.reasoningTrace, 20), decision: P.B?.decision || null },
            C: Object.assign({}, res || {}, { status: P.C?.status || res?.status, durationMs: P.C?.durationMs, payloadHash: P.C?.payloadHash, validation: P.C?.validation ? { status: P.C.validation.status } : null, evidenceChain: cap(P.C?.evidenceChain, 40).map(x => ({ hash: x && x.hash })), metadata: { inputFingerprint: P.C?.metadata?.inputFingerprint, generatedAt: P.C?.metadata?.generatedAt } })
          } : null
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

  if (!global.__CGO_ABC_BRIDGE_TELEMETRY_OBSERVER__) {
    global.__CGO_ABC_BRIDGE_TELEMETRY_OBSERVER__ = true;
    E.observeTelemetry(function (packet) {
      publishTelemetry(packet);
    });
  }

  /**
   * Analisis payload (teks / objek / HTML / JSON) lewat pipeline A→B→C→D.
   * Aman dipanggil dari BCGO chat / scanner.
   */
  function buildHumanSummary(result, audit, extras) {
    extras = extras || {};
    const st = String((result && result.status) || "UNKNOWN");
    const conf = result && result.decision && result.decision.confidence != null
      ? Math.round(Number(result.decision.confidence) * 100) : null;
    const findings = (result && result.findings) || [];
    const phys = findings.filter(f => f && /PHYSICS/.test(String(f.type || "")));
    const relBreaks = extras.relationBreaks || [];
    const lines = [];
    if (phys.length) {
      const p = phys[0];
      lines.push("Fisika tautan: LQM " + (p.lqm != null ? Number(p.lqm).toFixed(1) + " dB" : "—") +
        ", SNR " + (p.snrDb != null ? Number(p.snrDb).toFixed(1) + " dB" : "—") +
        ", usable=" + (p.usable === true ? "ya" : p.usable === false ? "tidak" : "—") + ".");
    }
    if (relBreaks.length) {
      lines.push("Relasi bermasalah: " + relBreaks.slice(0, 3).map(r =>
        (String(r.from || "?").split("/").pop()) + " → " + (String(r.to || "?").split("/").pop()) + " (" + (r.status || "?") + ")"
      ).join("; ") + ".");
    }
    if (extras.symptom) lines.push("Gejala: " + String(extras.symptom).slice(0, 160));
    if (extras.scanStatus) lines.push("Source scan: " + extras.scanStatus +
      (extras.filesFailed != null ? " · gagal " + extras.filesFailed : "") + ".");
    if (extras.activeCases && extras.activeCases.length) {
      lines.push("Kasus aktif: " + extras.activeCases.slice(0, 3).map(function (c) {
        return (c.message || c.type || c.id || "kasus");
      }).join("; ") + ".");
    }
    if (!lines.length) {
      lines.push("Status formal " + st + (conf != null ? " · keyakinan " + conf + "%" : "") +
        (audit ? " · audit " + (audit.status || audit) : "") + ".");
    } else {
      lines.unshift("Status " + st + (conf != null ? " (" + conf + "%)" : "") + ".");
    }
    const tips = [];
    if (relBreaks.length) tips.push("Periksa path script/import yang berstatus UNKNOWN atau MISMATCH.");
    if (phys.length && phys[0].usable === false) tips.push("Tautan fisika di bawah ambang — cek elevasi/jarak/fade.");
    if (extras.repaired) tips.push("Patch aman diterapkan di memori; verifikasi ulang sebelum persist.");
    if (tips.length) lines.push("Saran: " + tips.join(" "));
    return { headline: "ABC · " + st + (conf != null ? " · " + conf + "%" : ""), body: lines.join(" "), status: st, confidence: conf };
  }

  function extractDomainHints(input) {
    const hints = { relationBreaks: [], symptom: null, physicsEvidence: null, claims: [] };
    if (!input || typeof input !== "object") return hints;
    if (input.symptom) hints.symptom = String(input.symptom);
    if (input.message && !hints.symptom) hints.symptom = String(input.message);
    if (input.sourceScan && input.sourceScan.status) hints.scanStatus = String(input.sourceScan.status);
    if (input.sourceScan && input.sourceScan.filesFailed != null) hints.filesFailed = input.sourceScan.filesFailed;
    if (Array.isArray(input.activeCases)) {
      hints.activeCases = input.activeCases.slice(0, 5);
      for (const c of hints.activeCases) {
        if (!c) continue;
        hints.claims.push({
          source: "ACTIVE_CASE",
          target: c.target || c.file || "runtime",
          status: "ANOMALY",
          severity: String(c.severity || "HIGH").toUpperCase(),
          message: String(c.message || c.type || "kasus aktif").slice(0, 200)
        });
      }
    }
    const rels = input.relations || (input.sourceScan && input.sourceScan.relations) || [];
    for (const r of rels) {
      if (!r) continue;
      const st = String(r.status || "").toUpperCase();
      if (st === "UNKNOWN" || st === "MISMATCH") {
        const row = { from: r.sourceFile || r.from || r.source, to: r.targetFile || r.to || r.target, status: st, key: r.key };
        hints.relationBreaks.push(row);
        hints.claims.push({
          source: "DOMAIN_SCAN", target: row.to || row.from || "unknown",
          status: "ANOMALY", severity: st === "MISMATCH" ? "HIGH" : "MEDIUM",
          message: "Relasi " + st + ": " + (row.from || "?") + " → " + (row.to || "?")
        });
      }
    }
    const geo = input.geo || input.physics || input;
    if (Number.isFinite(Number(geo.elevationDeg)) && Number.isFinite(Number(geo.distanceKm))) {
      hints.physicsEvidence = {
        source: "CALLER_PHYSICS",
        elevationDeg: Number(geo.elevationDeg),
        distanceKm: Number(geo.distanceKm),
        dopplerRateHzPerSec: geo.dopplerRateHzPerSec != null ? Number(geo.dopplerRateHzPerSec) : 0,
        scintFadeDb: geo.scintFadeDb != null ? Number(geo.scintFadeDb) : 0,
        mode: geo.mode || input.physicsMode || undefined
      };
    }
    return hints;
  }

  function analyze(input, options = {}) {
    if (E.isPaused()) {
      return { ok: false, paused: true, message: "Mesin ABC sedang dijeda." };
    }
    try {
      const fast = options.fast !== false && !options.fullAudit && !options.autoReflect;
      const hints = extractDomainHints(input);
      const ext = options.externalEvidence || (hints.claims.length ? {
        schema: "CGO_EXTERNAL_EVIDENCE_V1",
        source: "ANALYZE_DOMAIN",
        capturedAt: new Date().toISOString(),
        claims: hints.claims,
        fingerprint: stableFingerprint(hints.claims)
      } : undefined);
      const phys = options.physicsEvidence || hints.physicsEvidence || undefined;
      const out = withTelemetryContext(options.context || "ANALYZE", false, options.bcgoCycle, () => E.process(input, {
        maxCycles: options.maxCycles ?? 1,
        autoReflect: !!options.autoReflect,
        fast: fast,
        skipAudit: fast,
        externalEvidence: ext,
        physicsEvidence: phys,
        ...options,
        externalEvidence: ext,
        physicsEvidence: phys
      }));
      const result = out?.result || out?.finalResult || null;
      const audit = out?.audit || out?.cycles?.at?.(-1)?.audit || null;
      const human = buildHumanSummary(result, audit, {
        relationBreaks: hints.relationBreaks,
        symptom: hints.symptom,
        scanStatus: hints.scanStatus,
        filesFailed: hints.filesFailed,
        activeCases: hints.activeCases
      });
      return {
        ok: true,
        engine: "CGO_MACHINE_ABC",
        version: E.version,
        status: result?.status || null,
        confidence: result?.decision?.confidence ?? null,
        summary: result?.summary || null,
        findings: result?.findings || [],
        audit: audit,
        human: human,
        relationBreaks: hints.relationBreaks,
        physics: phys || null,
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

  function repairSource(input, options = {}) {
    if (E.isPaused()) return { ok: false, status: "PAUSED", verified: false, message: "Mesin ABC sedang dijeda." };
    try {
      const out = withTelemetryContext(options.context || "SOURCE_REPAIR", false, options.bcgoCycle, () => E.repair(String(input), {
        source: options.source || "unknown",
        autoApply: options.autoApply !== false,
        maxRepairSteps: options.maxRepairSteps ?? 3,
        maxCycles: options.maxCycles ?? 5,
        fast: false,
        skipAudit: false
      }));
      const patchedText = typeof out?.repaired?.pipeline?.A?.input?.content?.value === "string"
        ? out.repaired.pipeline.A.input.content.value
        : (typeof out?.repaired?.pipeline?.A?.content?.value === "string" ? out.repaired.pipeline.A.content.value : null);
      const cycle = out?.repaired || out?.postRepair || null;
      return {
        ok: true, engine: "CGO_MACHINE_ABC", version: E.version, status: out?.status || null, verified: out?.verified === true,
        candidate: out?.candidate || null, patchedText, beforeFingerprint: out?.comparison?.before?.fingerprint || null,
        afterFingerprint: out?.comparison?.after?.fingerprint || null, audit: out?.verification?.postRepairAudit || cycle?.audit?.status || null,
        route: out?.verification?.postRepairRoute || cycle?.telemetry?.route || null, packet: out
      };
    } catch (err) { return { ok: false, status: "REPAIR_ERROR", verified: false, error: String(err?.message || err) }; }
  }

  function repair(input, options = {}) {
    if (E.isPaused()) return { engine: "CGO_MACHINE_ABC", version: E.version, status: "PAUSED", applied: false, verified: false };
    const result = withTelemetryContext(options.context || "REPAIR", false, options.bcgoCycle, () => E.repair(input, options));
    const summary = {
      status: result.status,
      applied: !!result.applied,
      verified: !!result.verified,
      candidateId: result.candidate?.id || null,
      steps: (result.steps || []).map(x => ({ index: x.index, id: x.id, status: x.status, audit: x.audit || null })),
      comparison: result.comparison || null,
      reason: result.reason || null,
      verificationScope: result.verificationScope || "UNKNOWN",
      runtimeExecution: result.runtimeExecution || "UNKNOWN",
      persistence: result.persistence || "UNKNOWN",
      at: new Date().toISOString()
    };
    emit("cgo:machine-abc-repair", result);
    publishBus("repair", summary);
    return result;
  }


  function stableFingerprint(value) {
    const text = JSON.stringify(value);
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  }

  function buildBCGOEvidence(state) {
    const sourceScan = state?.sourceScan || {};
    const activeCases = Array.isArray(state?.activeCases) ? state.activeCases : [];
    const claims = [
      { key: "cycle", value: state?.cycleNo ?? null },
      { key: "phase", value: state?.phase ?? null },
      { key: "sourceScanStatus", value: sourceScan.status ?? null },
      { key: "filesReadable", value: sourceScan.filesReadable ?? null },
      { key: "filesFailed", value: sourceScan.filesFailed ?? null },
      { key: "relationMismatch", value: sourceScan.relationSummary?.mismatch ?? null },
      { key: "activeCases", value: activeCases.length }
    ];
    const repairTargets = Array.isArray(sourceScan.repairTargets)
      ? sourceScan.repairTargets.filter(x => x && typeof x.file === "string" && typeof x.text === "string").slice(0, 4)
      : [];
    const repairMeta = repairTargets.map(x => ({ file: x.file, contentHash: x.contentHash || null, reason: x.reason || "SOURCE_CHANGED", size: x.text.length }));
    const scanFingerprint = {
      status: sourceScan.status ?? null,
      filesReadable: sourceScan.filesReadable ?? null,
      filesFailed: sourceScan.filesFailed ?? null,
      relationSummary: sourceScan.relationSummary || null,
      repairMeta
    };
    return {
      source: "BCGO",
      capturedAt: new Date().toISOString(),
      revision: state?.cycle ?? state?.cycleNo ?? 0,
      fingerprint: stableFingerprint({ cycle: state?.cycleNo ?? null, scan: scanFingerprint, cases: activeCases.length }),
      claims,
      repairTargets: repairTargets.map(x => ({
        file: x.file,
        contentHash: x.contentHash || null,
        reason: x.reason || "SOURCE_CHANGED",
        text: x.text.slice(0, 1024 * 1024)
      }))
    };
  }

  let lastBCGOFingerprint = null;
  function ingestBCGOState(state, options = {}) {
    if (E.isPaused()) {
      return { ok: false, mode: "PAUSED", status: "PAUSED", audit: "ATTENTION", repairs: [] };
    }
    const evidence = buildBCGOEvidence(state);
    const fingerprint = evidence.fingerprint;
    if (!options.force && fingerprint === lastBCGOFingerprint) {
      return {
        ok: true,
        deduped: true,
        mode: "LIVE",
        status: "STANDBY",
        audit: "VALID",
        evidence,
        repairs: [],
        packet: null,
        link: { type: "CGO_ABC_LIVE_LINK", source: "BCGO", mode: "LIVE", status: "STANDBY", audit: "VALID", evidence }
      };
    }
    lastBCGOFingerprint = fingerprint;
    const processState = state && typeof state === "object"
      ? { ...state, sourceScan: { ...(state.sourceScan || {}) } }
      : state;
    if (processState?.sourceScan) delete processState.sourceScan.repairTargets;
    const cycleNumber = state?.cycle ?? state?.cycleNo ?? evidence.revision ?? 0;
    const packet = withTelemetryContext("BCGO_NEURAL_CYCLE", true, cycleNumber, () => E.process(processState, {
      source: "BCGO_STATE",
      externalEvidence: evidence,
      fast: false,
      skipAudit: false,
      maxCycles: options.maxCycles ?? 1
    }));
    const targets = evidence.repairTargets;
    const repairs = [];
    if (options.autoRepair !== false && targets.length) {
      for (const target of targets) {
        try {
          const result = withTelemetryContext("BCGO_SOURCE_REPAIR", false, cycleNumber, () => E.repair(target.text, {
            autoApply: true,
            source: `BCGO_SOURCE:${target.file}`,
            maxRepairSteps: options.maxRepairSteps ?? 3
          }));
          repairs.push({
            file: target.file,
            contentHash: target.contentHash,
            status: result.status,
            applied: !!result.applied,
            verified: !!result.verified,
            candidate: result.candidate?.id || null,
            persistence: result.persistence || "IN_MEMORY_RESULT_ONLY",
            runtimeExecution: result.runtimeExecution || "NOT_PERFORMED",
            postStatus: result.repaired?.result?.status || null,
            audit: result.repaired?.audit?.status || null
          });
        } catch (err) {
          repairs.push({ file: target.file, contentHash: target.contentHash, status: "ERROR", applied: false, verified: false, error: String(err?.message || err) });
        }
      }
    }
    const finalCycle = packet?.cycles?.at?.(-1) || null;
    const status = finalCycle?.result?.status || packet?.result?.status || packet?.finalResult?.status || "UNKNOWN";
    const audit = finalCycle?.audit?.status || packet?.audit?.status || "ATTENTION";
    const link = {
      type: "CGO_ABC_LIVE_LINK",
      source: "BCGO",
      mode: "LIVE",
      status,
      audit,
      evidence,
      repairs,
      packet,
      claimCount: evidence.claims.length,
      capturedAt: evidence.capturedAt
    };
    global.CGO_ABC_LIVE_LINK = link;
    emit("cgo:machine-abc-bcgo-evidence", { evidence, packet, repairs });
    emit("cgo:machine-abc-bcgo-sync", link);
    publishBus("bcgo-evidence", { status, audit, fingerprint, repairs, revision: evidence.revision });
    return { ok: true, deduped: false, mode: "LIVE", status, audit, evidence, repairs, packet, link };
  }

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
    repair,
    repairSource,
    ingestBCGOState,
    getLastTelemetry: () => lastTelemetry ? { ...lastTelemetry } : null,
    healthSnapshot,
    process: (input, opt) => E.process(input, opt || {}),
    observe: (fn) => {
      if (typeof fn === "function") listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getLastPacket: () => lastPacket,
    publishBus,
    pageId: PAGE_ID,
    BUS_NAME,
    pause: () => E.pause(),
    resume: () => E.resume(),
    isPaused: () => E.isPaused()
  });

  global.CGOMachineABCBridge = API;
  global.CGO_MACHINE_ABC = E;
  // Alias singkat untuk Otak CGO
  if (!global.CGOCoreMachine) global.CGOCoreMachine = E;

  try {
    if (typeof global.addEventListener === "function") global.addEventListener("beforeunload", () => { try { telemetryBus?.close?.(); } catch (_) {} try { bus?.close?.(); } catch (_) {} }, { once: true });
  } catch (_) {}

  emit("cgo-machine-abc-ready", { version: VERSION, engine: E.version });
  emit("cgo:machine-abc-ready", { version: VERSION, engine: E.version });
  try { publishBus("ready", { version: VERSION, engine: E.version }); } catch (_) {}
  console.log("[CGO-ABC-BRIDGE] Siap · engine", E.version, "· bridge", VERSION);
})(typeof globalThis !== "undefined" ? globalThis : window);
