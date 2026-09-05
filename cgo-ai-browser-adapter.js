/* CIKUR GO Internal AI — Browser Synchronization Bridge
 * Binds the V5.2 active-investigation brain to the existing BCGO / Medicine contracts.
 * No external AI/API. No source mutation. Medicine remains proof authority.
 */
import * as Core from "./cgo-ai-core.js";
import * as Knowledge from "./cgo-ai-knowledge.js";
import * as Investigator from "./cgo-ai-investigator.js";
import * as ActiveInvestigation from "./cgo-ai-investigation-engine.js";
import * as Cognition from "./cgo-ai-cognition.js";
import * as Logic from "./cgo-ai-logic.js";
import * as Memory from "./cgo-ai-memory.js";
import { createRuntime } from "./cgo-ai-runtime-adapter.js";

const VERSION = "V5.2-BROWSER-BRIDGE-1.2.1";
const runtime = createRuntime({});
const memory = Memory.createMemory();
const caseIds = new Map();
const evidenceTokens = new Map();
const activeEngines = new Map();
const activeRuns = new Map();
let knowledge = Knowledge.createKnowledgeStore();
let latest = null;

function clone(v) {
  return typeof structuredClone === "function"
    ? structuredClone(v)
    : JSON.parse(JSON.stringify(v));
}

function now() { return new Date().toISOString(); }

function normalizeFile(v) {
  const raw = String(v || "").trim();
  if (!raw) return null;
  const clean = raw.split("?")[0].split("#")[0];
  return clean.substring(clean.lastIndexOf("/") + 1) || raw;
}

function token(v) {
  return JSON.stringify(v, Object.keys(v || {}).sort());
}

function ensureKnowledge(state) {
  let next = knowledge;
  const files = state?.sourceScan?.sources || state?.sourceScan?.fileStates || {};
  for (const file of Object.keys(files)) {
    const id = `file:${file}`;
    try {
      next = Knowledge.upsertNode(next, {
        id,
        type: "FILE",
        name: file,
        status: "OBSERVED",
        provenance: { source: "BCGO_SOURCE_SCAN", observedAt: now() }
      });
    } catch {}
  }
  const relations = Array.isArray(state?.sourceScan?.relations) ? state.sourceScan.relations : [];
  for (const rel of relations) {
    const from = `file:${normalizeFile(rel.from || rel.sourceFile || rel.file) || ""}`;
    const to = `file:${normalizeFile(rel.to || rel.targetFile || rel.relatedFile) || ""}`;
    if (!from.endsWith(":") && !to.endsWith(":") &&
        next.nodes.some(n => n.id === from) && next.nodes.some(n => n.id === to)) {
      try {
        next = Knowledge.addRelation(next, from, to, "DEPENDS_ON", {
          status: rel.status === "SYNCHRONIZED" || rel.status === "MATCHED_SURFACE" ? "VERIFIED" : "OBSERVED",
          source: "BCGO_SOURCE_SCAN"
        });
      } catch {}
    }
  }
  knowledge = next;
  try { runtime.setKnowledge?.(next); } catch {}
  return clone(knowledge);
}

function mapEvidence(raw, sourceKind = "BCGO") {
  const file = normalizeFile(raw?.fileName || raw?.sourceFile || raw?.file || raw?.target || raw?.source);
  const claim = String(raw?.claim || raw?.message || raw?.error || raw?.detail || "").trim();
  const exact = Number.isFinite(raw?.line) || Number.isFinite(raw?.lineNumber) || !!raw?.exactLineHit;
  const strength = raw?.evidenceStrength === "HIGH" ? 1 :
    raw?.evidenceStrength === "MEDIUM" ? 0.65 :
    Number.isFinite(raw?.strength) ? Math.max(0, Math.min(1, raw.strength)) : 0.35;
  const id = String(raw?.id || raw?.eventId || `${sourceKind}:${file || "unknown"}:${raw?.line || raw?.lineNumber || ""}:${claim}`).slice(0,180);
  return {
    id,
    type: raw?.type || raw?.kind || sourceKind,
    source: file || raw?.source || sourceKind,
    claim: claim || "Telemetry/source observation received.",
    status: ["VERIFIED","UNVERIFIED","CONTRADICTED","REJECTED"].includes(String(raw?.status || "").toUpperCase())
      ? String(raw.status).toUpperCase()
      : "UNVERIFIED",
    strength,
    exact,
    observedAt: raw?.reportedAt || raw?.observedAt || raw?.timestamp || now(),
    fingerprint: raw?.fingerprint || null,
    metadata: {
      file: file || null,
      sourceKind,
      line: raw?.line ?? raw?.lineNumber ?? null,
      evidenceStrength: raw?.evidenceStrength || null,
      proofRequired: raw?.proofRequired !== false
    }
  };
}

function upsertBCGOCase(item, state) {
  const source = normalizeFile(item?.target || item?.source || state?.lastTelemetryFile) || "UNKNOWN";
  const caseId = String(item?.id || `BCGO-${source}`);
  let c = runtime.getCase(caseId);

  if (!c) {
    c = runtime.detect({
      caseId,
      target: source,
      symptom: item?.evidence?.message || item?.message || state?.lastTelemetryMessage || null,
      severity: item?.severity || "UNKNOWN"
    });
  }

  const raw = item?.evidence || {
    id: `${caseId}:telemetry`,
    fileName: source,
    message: item?.message || state?.lastTelemetryMessage || "BCGO telemetry active.",
    reportedAt: item?.reportedAt || state?.lastTelemetryAt || now()
  };
  const ev = mapEvidence(raw, raw?.type || "BCGO_TELEMETRY");
  // Runtime telemetry is an observation signal, not source proof. It must not
  // permanently block a later proof chain merely because the original symptom
  // remains in the case ledger.
  ev.metadata.proofRequired = false;
  const t = token(ev);
  if (evidenceTokens.get(caseId) !== t) {
    const current = runtime.getCase(caseId);
    const sequence = Number(current?.event?.sequence || 0) + 1;
    try { c = runtime.addEvidence(caseId, { ...ev, sequence, eventId: `${caseId}:${sequence}` }); }
    catch { c = runtime.getCase(caseId); }
    evidenceTokens.set(caseId, t);
  }
  caseIds.set(source, caseId);
  return c;
}


function investigationFiles(state) {
  const sources = state?.sourceScan?.sources;
  if (sources && typeof sources === "object") return Object.keys(sources).map(normalizeFile).filter(Boolean);
  const states = state?.sourceScan?.fileStates;
  if (states && typeof states === "object") return Object.keys(states).map(normalizeFile).filter(Boolean);
  return [];
}

function createInternalProbeProvider(state) {
  const files = investigationFiles(state);
  return {
    sourceSurfaceComplete: state?.sourceScan?.status === "CLEAN" || state?.sourceScan?.status === "FINDINGS",
    async listFiles() { return files.slice(); },
    async readSource(file) {
      const normalized = normalizeFile(file);
      if (!normalized) throw new Error("SOURCE_FILE_REQUIRED");
      const url = new URL(normalized, window.location.href).href;
      const response = await fetch(url, {method:"GET", cache:"no-store", credentials:"same-origin"});
      if (!response.ok) throw new Error(`SOURCE_READ_HTTP_${response.status}:${normalized}`);
      const source = await response.text();
      if (!source.trim()) throw new Error(`SOURCE_EMPTY:${normalized}`);
      return {file:normalized, source, fingerprint:Core.contentFingerprint(source)};
    }
  };
}

function getActiveEngine(caseId, caseData) {
  let engine = activeEngines.get(caseId);
  // Evidence invalidation starts a new investigation generation. Never keep a
  // probe cache from an older case revision after new telemetry/source arrives.
  if (!engine || Number(engine.state?.caseRevision ?? -1) !== Number(caseData?.revision ?? 0)) {
    engine = ActiveInvestigation.createInvestigationEngine(caseData, knowledge, {maxSteps:10, maxFiles:40});
    engine.state.caseRevision = Number(caseData?.revision ?? 0);
    activeEngines.set(caseId, engine);
  }
  return engine;
}

async function runActiveInvestigation(caseId, state) {
  if (!caseId || activeRuns.has(caseId)) return;
  const current = runtime.getCase(caseId);
  if (!current) return;
  const startRevision = Number(current.revision ?? 0);
  const engine = getActiveEngine(caseId, current);
  const provider = createInternalProbeProvider(state);
  const runPromise = (async () => {
    try {
      const out = await engine.run(current, provider, knowledge, {maxSteps:6});
      const before = runtime.getCase(caseId);
      if (!before) return;
      // If telemetry/evidence arrived while probes were running, the result is
      // stale. Do not merge stale hypotheses/proof into the newer authoritative
      // case; the finally block will schedule a fresh generation.
      if (Number(before.revision ?? 0) !== startRevision) {
        emitBrainEvent(caseId, "STALE_INVESTIGATION_RESULT_DROPPED", {startRevision,currentRevision:before.revision,steps:out.steps});
        return;
      }

      // Sync only new evidence into the authoritative runtime. The engine never
      // writes source; runtime.addEvidence invalidates old proof before accepting it.
      const known = new Set(before.evidence.map(e => e.id));
      const newEvidence = out.caseData.evidence.filter(e => !known.has(e.id));
      if (newEvidence.length) {
        const startSeq = Number(before.event?.sequence ?? -1);
        const stamped = newEvidence.map((e,i) => ({...e, eventId:`CGO-PROBE:${caseId}:${startSeq+i+1}`, sequence:startSeq+i+1, source:e.source || "CGO_INTERNAL_PROBE"}));
        try { runtime.addEvidence(caseId, stamped); } catch (err) {
          emitBrainEvent(caseId, "PROBE_SYNC_REJECTED", {error:String(err?.message || err), evidenceIds:newEvidence.map(e=>e.id)});
        }
      }

      let synced = runtime.getCase(caseId) || before;
      if (out.caseData.hypotheses?.length) {
        try { synced = runtime.reason(caseId, out.caseData.hypotheses); } catch {}
      }
      if (out.caseData.rootCause && !synced.rootCause) {
        try { synced = runtime.proveRootCause(caseId, out.caseData.rootCause); } catch {}
      }
      if (out.caseData.exactSource && !synced.exactSource) {
        try { synced = runtime.proveSource(caseId, out.caseData.exactSource); } catch {}
      }

      emitBrainEvent(caseId, "ACTIVE_INVESTIGATION_STEP", {
        status:out.status,
        steps:out.steps,
        cycle:out.investigation?.cycle || 0,
        probeLog:out.investigation?.probeLog || [],
        evidenceAdded:newEvidence.length,
        selectedHypothesisId:synced?.selectedHypothesis?.id || null,
        state:synced?.state || null
      });

      latest = compatibleSnapshot(caseId, "ACTIVE_INVESTIGATION");
      try { window.dispatchEvent(new CustomEvent("cikur-internal-ai-state", {detail:latest})); } catch {}
    } catch (err) {
      emitBrainEvent(caseId, "ACTIVE_INVESTIGATION_ERROR", {error:String(err?.message || err)});
    } finally {
      activeRuns.delete(caseId);
      const latestCase = runtime.getCase(caseId);
      if (latestCase && Number(latestCase.revision ?? 0) !== startRevision) {
        // A new event may have arrived while this generation was running.
        // Re-enter with the newest case after the current promise fully closes.
        setTimeout(() => {
          const fresh = runtime.getCase(caseId);
          if (fresh) void runActiveInvestigation(caseId, state);
        }, 0);
      }
    }
  })();
  activeRuns.set(caseId, runPromise);
  await runPromise;
}

function emitBrainEvent(caseId, type, payload) {
  const detail = {version:VERSION,caseId,type,at:Date.now(),payload:clone(payload || {})};
  try { window.dispatchEvent(new CustomEvent("cikur-internal-ai-investigation", {detail})); } catch {}
}

function compatibleSnapshot(caseId, signal = "LIVE_TELEMETRY") {
  const c = runtime.getCase(caseId);
  if (!c) {
    return {
      version: VERSION, signal, at: Date.now(),
      reasoning: {
        classification: "INSUFFICIENT_EVIDENCE",
        evidence: [], hypotheses: [], selectedHypothesisId: null,
        precisionGate: { pass: false, blockers: ["NO_ACTIVE_CASE"] },
        investigation: { status: "BLOCKED", nextEvidence: null },
        operationalInvestigation: { status: "BLOCKED", evidenceRequests: [] },
        causalLinks: []
      },
      guardian: { healthy: false, level: "BLOCKED", issues: ["NO_ACTIVE_CASE"] }
    };
  }

  const evaluation = Logic.evaluate(c, { allowAutomaticExecution: false }, knowledge);
  const active = activeEngines.get(caseId);
  const investigation = active ? active.snapshot() : Investigator.createInvestigation(c, knowledge);
  const probe = active && active.state.status === "ACTIVE"
    ? (active.state.probeLog.at(-1) || Investigator.nextProbe(investigation, c, knowledge))
    : Investigator.nextProbe(investigation, c, knowledge);
  const deliberate = Cognition.deliberate({
    evidence: c.evidence,
    rootCause: c.rootCause,
    exactSource: c.exactSource,
    contradictions: Core.detectContradictions(c.evidence),
    proofComplete: evaluation.proof.complete
  });

  const blockers = [];
  if (!evaluation.proof.complete) blockers.push("PROOF_CHAIN_INCOMPLETE");
  if (evaluation.proof.unresolved) blockers.push("UNVERIFIED_EVIDENCE_PRESENT");
  if (evaluation.proof.contradictory) blockers.push("CONTRADICTORY_EVIDENCE");
  if (!evaluation.proof.rootCauseVerified) blockers.push("ROOT_CAUSE_NOT_VERIFIED");
  if (!evaluation.proof.sourceVerified) blockers.push("EXACT_SOURCE_NOT_VERIFIED");

  return {
    version: VERSION,
    brainVersion: Core.VERSION,
    logicVersion: Logic.VERSION,
    cognitionVersion: Cognition.VERSION,
    guardianVersion: evaluation.guardian?.policyVersion || "1",
    signal,
    at: Date.now(),
    reasoning: {
      classification: deliberate.conclusion,
      evidence: c.evidence.map(e => ({
        id: e.id, claim: e.claim, source: e.source, exact: e.exact, status: e.status
      })),
      hypotheses: c.hypotheses || [],
      selectedHypothesisId: c.selectedHypothesis?.id || null,
      correlations: {
        independentEvidenceCount: new Set(c.evidence.map(e => e.source || e.type || e.id)).size
      },
      precisionGate: { pass: evaluation.proof.complete, blockers: blockers.slice(0,20) },
      investigation: {
        status: c.state,
        nextEvidence: probe,
        nextProbe: probe
      },
      operationalInvestigation: {
        status: c.state,
        evidenceRequests: probe ? [probe] : []
      },
      causalLinks: c.rootCause ? [{
        hypothesisId: c.rootCause.hypothesisId,
        evidenceIds: c.rootCause.evidenceIds
      }] : []
    },
    guardian: {
      healthy: evaluation.guardian?.decision !== "BLOCKED",
      level: evaluation.guardian?.risk || "UNKNOWN",
      issues: evaluation.guardian?.reason ? [evaluation.guardian.reason] : []
    }
  };
}

export function install() {
  return {
    version: VERSION,
    ingestBCGOState(state = {}) {
      ensureKnowledge(state);
      const active = Array.isArray(state.activeCases) ? state.activeCases : [];
      let primary = null;
      for (const item of active) {
        try {
          const c = upsertBCGOCase(item, state);
          if (!primary) primary = c;
        } catch {}
      }
      if (!primary && state.lastTelemetryFile) {
        primary = upsertBCGOCase({
          id: `BCGO-${normalizeFile(state.lastTelemetryFile)}`,
          target: normalizeFile(state.lastTelemetryFile),
          severity: "UNKNOWN",
          evidence: {
            fileName: normalizeFile(state.lastTelemetryFile),
            message: state.lastTelemetryMessage || "Telemetry aktif.",
            reportedAt: state.lastTelemetryAt || now()
          }
        }, state);
      }
      latest = compatibleSnapshot(primary?.caseId, primary ? "LIVE_TELEMETRY" : "NO_ACTIVE_CASE");
      try { window.dispatchEvent(new CustomEvent("cikur-internal-ai-state", { detail: latest })); } catch {}
      if (primary?.caseId) {
        // Fire-and-progress: the bridge remains responsive while CGO performs its
        // internal source probes asynchronously. No external service is called.
        runActiveInvestigation(primary.caseId, state).catch(()=>{});
      }
      try { window.dispatchEvent(new CustomEvent("cikur-internal-ai-guardian", { detail: latest.guardian })); } catch {}
      return clone(latest);
    },
    getSnapshot() { return clone(latest); },
    deliberate(caseId, policy = {}) {
      return runtime.deliberate(caseId, policy);
    },
    logic(caseId, policy = {}) {
      return runtime.logic(caseId, policy);
    },
    async investigate(caseId, state = {}, options = {}) {
      if (!caseId) throw new Error("CASE_ID_REQUIRED");
      const current = runtime.getCase(caseId);
      if (!current) throw new Error("CASE_NOT_FOUND");
      const engine = getActiveEngine(caseId, current);
      const provider = createInternalProbeProvider(state);
      const out = await engine.run(current, provider, knowledge, options);
      return clone(out);
    },
    getRuntime() { return runtime; }
  };
}

export function reason(context = {}, history = {}) {
  const evidenceRaw = Array.isArray(context.medicineEvidence) ? context.medicineEvidence : [];
  const target = normalizeFile(context.target);
  const c0 = Core.createCase({
    caseId: `MEDICINE-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
    target,
    symptom: context.errorLog?.message || context.errorLog?.error || context.errorLog || null,
    severity: context.medicinePlan?.severity || "UNKNOWN"
  });

  const evidence = evidenceRaw.map((e, index) => ({
    ...mapEvidence({
      ...e,
      id: e.id || `MED-EV-${index}-${target || "unknown"}`,
      status: ["VERIFIED","UNVERIFIED","CONTRADICTED","REJECTED"].includes(String(e.status || "").toUpperCase())
        ? String(e.status).toUpperCase()
        : "UNVERIFIED",
      exact: !!(e.exact || e.exactLineHit || e.before),
      strength: e.evidenceStrength === "HIGH" ? 1 : e.evidenceStrength === "MEDIUM" ? .65 : .35
    }, "MEDICINE"),
    metadata: {
      file: normalizeFile(e.file || e.sourceFile || target),
      medicineEvidenceStrength: e.evidenceStrength || null,
      evidenceReason: e.evidenceReason || null
    }
  }));

  let c = Core.ingestEvidence(c0, evidence);
  const candidates = Array.isArray(context.medicinePlan?.candidates)
    ? context.medicinePlan.candidates
    : [];
  const hypothesisEvidenceIds = evidence.map(e => e.id);
  const hypotheses = hypothesisEvidenceIds.length ? [{
    id: `H-${target || "CASE"}`,
    statement: String(
      context.medicinePlan?.rootCauseFile ||
      candidates[0]?.reason ||
      "Medicine evidence requires causal verification."
    ),
    evidenceIds: hypothesisEvidenceIds
  }] : [];
  if (hypotheses.length) {
    c = Core.reason(c, hypotheses).caseData;
  }

  if (context.medicinePlan?.rootCauseStatus &&
      ["CONFIRMED_ORIGINAL_TARGET","TARGET_CORRECTED_BY_MEDICINE","CONTRACT_ROOT_CAUSE_IDENTIFIED"].includes(context.medicinePlan.rootCauseStatus) &&
      hypotheses.length) {
    const rootEvidenceIds = evidence.filter(e => e.status === "VERIFIED").map(e => e.id);
    const statement = String(candidates[0]?.reason || context.medicinePlan.rootCauseFile || "Medicine root cause candidate verified.");
    c = Core.verifyRootCause(c, {
      statement,
      hypothesisId: hypotheses[0].id,
      evidenceIds: rootEvidenceIds
    });
  }

  if (context.medicinePlan?.operations?.length && c.rootCause) {
    const op = context.medicinePlan.operations[0];
    const originalCode = String(op.before || "");
    const proposedCode = String(op.after || "");
    if (originalCode && proposedCode) {
      const sourceFile = normalizeFile(op.file || context.medicinePlan.rootCauseFile || target);
      const fp = Core.contentFingerprint(originalCode);
      const sourceFingerprint = op.sourceFingerprint || null;
      try {
        c = Core.verifyExactSource(c, {
          file: sourceFile,
          originalCode,
          proposedCode,
          operation: op.type || "REPLACE_EXACT",
          fingerprint: fp,
          contentFingerprint: fp,
          sourceFingerprint: context.sourceFingerprint || sourceFingerprint || null,
          evidenceIds: c.rootCause.evidenceIds
        });
      } catch {}
    }
  }

  const evaluation = Logic.evaluate(c, { allowAutomaticExecution: false }, knowledge);
  const deliberate = Cognition.deliberate({
    evidence: c.evidence,
    rootCause: c.rootCause,
    exactSource: c.exactSource,
    contradictions: Core.detectContradictions(c.evidence),
    proofComplete: evaluation.proof.complete
  });
  const blockers = [];
  if (!evaluation.proof.complete) blockers.push("PROOF_CHAIN_INCOMPLETE");
  if (evaluation.proof.contradictory) blockers.push("CONTRADICTORY_EVIDENCE");
  if (evaluation.proof.unresolved) blockers.push("UNVERIFIED_EVIDENCE_PRESENT");
  if (!evaluation.proof.causalRootVerified) blockers.push("CAUSAL_ROOT_NOT_VERIFIED");
  if (!evaluation.proof.sourceVerified) blockers.push("EXACT_SOURCE_NOT_VERIFIED");
  if (!evaluation.proof.sourceFingerprintBound) blockers.push("SOURCE_FINGERPRINT_REQUIRED");

  const investigation = Investigator.nextProbe(
    Investigator.createInvestigation(c, knowledge), c, knowledge
  );

  const result = {
    version: VERSION,
    classification: deliberate.conclusion,
    evidence: c.evidence,
    hypotheses: c.hypotheses,
    selectedHypothesisId: c.selectedHypothesis?.id || null,
    precisionGate: { pass: evaluation.proof.complete, blockers: [...new Set(blockers)] },
    investigation: {
      status: c.state,
      nextEvidence: investigation,
      nextProbe: investigation
    },
    operationalInvestigation: {
      status: c.state,
      evidenceRequests: investigation ? [investigation] : []
    },
    causalLinks: c.rootCause ? [{
      hypothesisId: c.rootCause.hypothesisId,
      evidenceIds: c.rootCause.evidenceIds
    }] : [],
    correlations: {
      independentEvidenceCount: new Set(c.evidence.map(e => e.source || e.type || e.id)).size
    },
    brainProof: evaluation.proof,
    guardian: evaluation.guardian,
    memory: { advisoryOnly: true, historicalHints: [] }
  };

  latest = clone(result);
  return result;
}

export { VERSION };
