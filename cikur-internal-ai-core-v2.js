/**
 * CIKUR GO INTERNAL AI — INTELLIGENCE CORE V2
 * Status: FOUNDATION / ISOLATED / NOT INTEGRATED
 *
 * Purpose:
 * - Internal reasoning/state foundation for CIKUR GO.
 * - No external AI/API/network.
 * - No automatic source modification.
 * - No code execution.
 * - No approval bypass.
 * - Medicine and Executor remain separate organs.
 */

"use strict";

const VERSION = "2.0.0-foundation";

const CASE_STATES = Object.freeze([
  "DETECTED","OBSERVING","EVIDENCE_COLLECTING","INVESTIGATING",
  "HYPOTHESIS_FORMED","VERIFYING","ROOT_CAUSE_VERIFIED",
  "SOURCE_VERIFIED","CANDIDATE_READY","EXECUTOR_REVIEW",
  "HUMAN_APPROVAL","EXECUTING","VALIDATING","RESOLVED",
  "INSUFFICIENT_EVIDENCE","CONTRADICTORY_EVIDENCE",
  "SOURCE_NOT_VERIFIED","VALIDATION_FAILED","REOPENED"
]);

const EVIDENCE_STATUS = Object.freeze([
  "CONFIRMED","REJECTED","UNKNOWN","STALE","CONTRADICTORY"
]);

const RELATIONS = Object.freeze([
  "IMPORTS","EXPORTS","CALLS","CALLED_BY","READS","WRITES",
  "LISTENS","EMITS","DEPENDS_ON","PROTECTED_BY","USES",
  "PRODUCES","CONSUMES","SENDS","RECEIVES","VALIDATES","MONITORS"
]);

const TERMINAL = new Set(["RESOLVED"]);
const FAILURE = new Set([
  "INSUFFICIENT_EVIDENCE","CONTRADICTORY_EVIDENCE",
  "SOURCE_NOT_VERIFIED","VALIDATION_FAILED"
]);

const TRANSITIONS = Object.freeze({
  DETECTED: ["OBSERVING","EVIDENCE_COLLECTING","INSUFFICIENT_EVIDENCE"],
  OBSERVING: ["EVIDENCE_COLLECTING","INVESTIGATING","INSUFFICIENT_EVIDENCE"],
  EVIDENCE_COLLECTING: ["INVESTIGATING","CONTRADICTORY_EVIDENCE","INSUFFICIENT_EVIDENCE"],
  INVESTIGATING: ["HYPOTHESIS_FORMED","EVIDENCE_COLLECTING","CONTRADICTORY_EVIDENCE"],
  HYPOTHESIS_FORMED: ["VERIFYING","EVIDENCE_COLLECTING","CONTRADICTORY_EVIDENCE"],
  VERIFYING: ["ROOT_CAUSE_VERIFIED","SOURCE_NOT_VERIFIED","CONTRADICTORY_EVIDENCE","INSUFFICIENT_EVIDENCE"],
  ROOT_CAUSE_VERIFIED: ["SOURCE_VERIFIED","VERIFYING"],
  SOURCE_VERIFIED: ["CANDIDATE_READY","VERIFYING","SOURCE_NOT_VERIFIED"],
  CANDIDATE_READY: ["EXECUTOR_REVIEW","VERIFYING","SOURCE_NOT_VERIFIED"],
  EXECUTOR_REVIEW: ["HUMAN_APPROVAL","VERIFYING","SOURCE_NOT_VERIFIED"],
  HUMAN_APPROVAL: ["EXECUTING","CANDIDATE_READY"],
  EXECUTING: ["VALIDATING","VALIDATION_FAILED"],
  VALIDATING: ["RESOLVED","VALIDATION_FAILED","REOPENED"],
  REOPENED: ["OBSERVING","EVIDENCE_COLLECTING","INVESTIGATING"],
  INSUFFICIENT_EVIDENCE: ["EVIDENCE_COLLECTING","INVESTIGATING","REOPENED"],
  CONTRADICTORY_EVIDENCE: ["EVIDENCE_COLLECTING","INVESTIGATING","REOPENED"],
  SOURCE_NOT_VERIFIED: ["INVESTIGATING","VERIFYING","REOPENED"],
  VALIDATION_FAILED: ["REOPENED","INVESTIGATING"]
});

const now = () => new Date().toISOString();
const uid = (prefix) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,10)}`;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function createTelemetry(input = {}) {
  return {
    id: input.id || uid("tel"),
    observedAt: input.observedAt || now(),
    source: input.source || "unknown",
    target: input.target || "UNKNOWN",
    file: input.file || null,
    severity: input.severity || "UNKNOWN",
    error: input.error || null,
    runtimeContext: clone(input.runtimeContext || {}),
    raw: clone(input.raw || {}),
    status: input.status || "OBSERVED"
  };
}

function createEvidence(input = {}) {
  return {
    id: input.id || uid("ev"),
    observedAt: input.observedAt || now(),
    source: input.source || "unknown",
    kind: input.kind || "OBSERVATION",
    status: EVIDENCE_STATUS.includes(input.status) ? input.status : "UNKNOWN",
    claim: input.claim || "",
    exactSource: clone(input.exactSource || null),
    telemetryId: input.telemetryId || null,
    fingerprint: input.fingerprint || null,
    confidence: Number.isFinite(input.confidence) ? input.confidence : 0,
    details: clone(input.details || {})
  };
}

function createKnowledgeNode(input = {}) {
  return {
    id: input.id || uid("node"),
    type: input.type || "UNKNOWN",
    name: input.name || "UNKNOWN",
    source: input.source || "unknown",
    version: input.version || null,
    fingerprint: input.fingerprint || null,
    status: input.status || "ACTIVE",
    observedAt: input.observedAt || now(),
    confidence: Number.isFinite(input.confidence) ? input.confidence : 0,
    metadata: clone(input.metadata || {})
  };
}

function createSystemGraph() {
  const nodes = new Map();
  const edges = new Map();

  function addNode(nodeInput) {
    const node = createKnowledgeNode(nodeInput);
    nodes.set(node.id, node);
    return clone(node);
  }

  function addEdge(input = {}) {
    if (!nodes.has(input.from) || !nodes.has(input.to)) {
      throw new Error("GRAPH_ENDPOINT_MISSING");
    }
    if (!RELATIONS.includes(input.relation)) {
      throw new Error("GRAPH_RELATION_INVALID");
    }
    const edge = {
      id: input.id || uid("edge"),
      from: input.from,
      to: input.to,
      relation: input.relation,
      source: input.source || "unknown",
      observedAt: input.observedAt || now(),
      confidence: Number.isFinite(input.confidence) ? input.confidence : 0,
      metadata: clone(input.metadata || {})
    };
    edges.set(edge.id, edge);
    return clone(edge);
  }

  function getNode(id) { return clone(nodes.get(id) || null); }
  function getEdge(id) { return clone(edges.get(id) || null); }
  function allNodes() { return [...nodes.values()].map(clone); }
  function allEdges() { return [...edges.values()].map(clone); }

  return Object.freeze({
    addNode, addEdge, getNode, getEdge, allNodes, allEdges,
    counts: () => ({ nodes: nodes.size, edges: edges.size })
  });
}

function createHypothesis(input = {}) {
  return {
    id: input.id || uid("hyp"),
    claim: input.claim || "",
    target: input.target || null,
    supportingEvidenceIds: [...(input.supportingEvidenceIds || [])],
    contradictingEvidenceIds: [...(input.contradictingEvidenceIds || [])],
    status: input.status || "OPEN",
    confidence: Number.isFinite(input.confidence) ? input.confidence : 0,
    rootCauseVerified: input.rootCauseVerified === true,
    exactSourceVerified: input.exactSourceVerified === true,
    createdAt: input.createdAt || now(),
    metadata: clone(input.metadata || {})
  };
}

function evaluatePrecisionGate({ evidence = [], hypothesis = null } = {}) {
  const confirmed = evidence.filter(e => e.status === "CONFIRMED");
  const contradictions = evidence.filter(e =>
    e.status === "CONTRADICTORY" || e.status === "REJECTED"
  );
  const unresolved = evidence.filter(e => e.status === "UNKNOWN" || e.status === "STALE");

  const blockers = [];
  if (!hypothesis) blockers.push("HYPOTHESIS_MISSING");
  if (!confirmed.length) blockers.push("CONFIRMED_EVIDENCE_MISSING");
  if (contradictions.length) blockers.push("CONTRADICTORY_OR_REJECTED_EVIDENCE");
  if (unresolved.length) blockers.push("UNRESOLVED_EVIDENCE");
  if (hypothesis && !hypothesis.rootCauseVerified) blockers.push("ROOT_CAUSE_NOT_VERIFIED");
  if (hypothesis && !hypothesis.exactSourceVerified) blockers.push("EXACT_SOURCE_NOT_VERIFIED");

  return {
    pass: blockers.length === 0,
    blockers,
    evidence: {
      confirmed: confirmed.length,
      contradictions: contradictions.length,
      unresolved: unresolved.length
    },
    evaluatedAt: now()
  };
}

function createCase(input = {}) {
  const telemetry = input.telemetry ? createTelemetry(input.telemetry) : null;
  return {
    id: input.id || uid("case"),
    createdAt: input.createdAt || now(),
    updatedAt: now(),
    state: "DETECTED",
    target: input.target || telemetry?.target || "UNKNOWN",
    telemetryIds: telemetry ? [telemetry.id] : [],
    evidence: [],
    hypotheses: [],
    selectedHypothesisId: null,
    precisionGate: null,
    candidate: null,
    history: [{ state: "DETECTED", at: now(), reason: "CASE_CREATED" }]
  };
}

function transitionCase(caseObj, nextState, reason = "") {
  if (!caseObj || !CASE_STATES.includes(nextState)) throw new Error("CASE_STATE_INVALID");
  if (TERMINAL.has(caseObj.state)) throw new Error("CASE_ALREADY_TERMINAL");
  const allowed = TRANSITIONS[caseObj.state] || [];
  if (!allowed.includes(nextState)) {
    throw new Error(`CASE_TRANSITION_BLOCKED:${caseObj.state}->${nextState}`);
  }
  caseObj.state = nextState;
  caseObj.updatedAt = now();
  caseObj.history.push({ state: nextState, at: now(), reason });
  return clone(caseObj);
}

function attachEvidence(caseObj, evidenceInput) {
  const evidence = createEvidence(evidenceInput);
  caseObj.evidence.push(evidence);
  caseObj.updatedAt = now();
  return clone(evidence);
}

function addHypothesis(caseObj, hypothesisInput) {
  const hypothesis = createHypothesis(hypothesisInput);
  caseObj.hypotheses.push(hypothesis);
  caseObj.updatedAt = now();
  return clone(hypothesis);
}

function selectHypothesis(caseObj, hypothesisId) {
  const found = caseObj.hypotheses.find(h => h.id === hypothesisId);
  if (!found) throw new Error("HYPOTHESIS_NOT_FOUND");
  caseObj.selectedHypothesisId = hypothesisId;
  caseObj.updatedAt = now();
  return clone(found);
}

function prepareCandidate(caseObj, candidateInput = {}) {
  const hypothesis = caseObj.hypotheses.find(h => h.id === caseObj.selectedHypothesisId) || null;
  const gate = evaluatePrecisionGate({ evidence: caseObj.evidence, hypothesis });
  caseObj.precisionGate = gate;
  if (!gate.pass) {
    throw new Error(`PRECISION_GATE_BLOCKED:${gate.blockers.join(",")}`);
  }
  caseObj.candidate = {
    id: uid("cand"),
    createdAt: now(),
    type: candidateInput.type || "CODE_SOLUTION",
    targetFile: candidateInput.targetFile || null,
    before: candidateInput.before || null,
    after: candidateInput.after || null,
    explanation: candidateInput.explanation || "",
    humanApprovalRequired: true
  };
  return clone(caseObj.candidate);
}

const API = Object.freeze({
  VERSION,
  CASE_STATES,
  EVIDENCE_STATUS,
  RELATIONS,
  FAILURE_STATES: [...FAILURE],
  createTelemetry,
  createEvidence,
  createKnowledgeNode,
  createSystemGraph,
  createHypothesis,
  evaluatePrecisionGate,
  createCase,
  transitionCase,
  attachEvidence,
  addHypothesis,
  selectHypothesis,
  prepareCandidate
});

if (typeof globalThis !== "undefined") globalThis.CIKURInternalAI = API;
if (typeof module !== "undefined" && module.exports) module.exports = API;
