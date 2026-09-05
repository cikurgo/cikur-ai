/* CIKUR GO Internal AI — Browser Synchronization Bridge
 * Binds the V5 eight-module brain to the existing BCGO / Medicine contracts.
 * No external AI/API. No source mutation. Medicine remains proof authority.
 */
import * as Core from "./cgo-ai-core.js";
import * as Knowledge from "./cgo-ai-knowledge.js";
import * as Investigator from "./cgo-ai-investigator.js";
import * as Cognition from "./cgo-ai-cognition.js";
import * as Logic from "./cgo-ai-logic.js";
import * as Memory from "./cgo-ai-memory.js";
import { createRuntime } from "./cgo-ai-runtime-adapter.js";

const VERSION = "V5-BROWSER-BRIDGE-1.1.0";
const runtime = createRuntime({});
const memory = Memory.createMemory();
const caseIds = new Map();
const evidenceTokens = new Map();
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
      evidenceStrength: raw?.evidenceStrength || null
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
  const investigation = Investigator.createInvestigation(c, knowledge);
  const probe = Investigator.nextProbe(investigation, c, knowledge);
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
