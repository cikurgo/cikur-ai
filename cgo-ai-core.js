/* CIKUR GO Internal AI Core
 * Pure internal reasoning/orchestration primitives.
 * No external AI/API. No direct source mutation; orchestrates approved execution through an injected Executor.
 */
const VERSION = "1.4.0";

function now(){ return new Date().toISOString(); }
function id(prefix="case"){ return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2,8)}`; }
function uniq(a){ return [...new Set((a||[]).filter(Boolean))]; }
// Single source of truth for legal case-state transitions. Exported so any module
// that needs to reason about state (e.g. the Guardian) reads from here instead of
// keeping its own copy that can silently drift out of sync.
export const CASE_TRANSITIONS = {
  DETECTED:["OBSERVING","EVIDENCE_COLLECTING","INVESTIGATING"],
  OBSERVING:["EVIDENCE_COLLECTING","INVESTIGATING"],
  EVIDENCE_COLLECTING:["INVESTIGATING","HYPOTHESIS_FORMED","VERIFYING","ROOT_CAUSE_VERIFIED","CONTRADICTORY_EVIDENCE","INSUFFICIENT_EVIDENCE"],
  INVESTIGATING:["HYPOTHESIS_FORMED","VERIFYING","INSUFFICIENT_EVIDENCE","CONTRADICTORY_EVIDENCE"],
  HYPOTHESIS_FORMED:["VERIFYING","ROOT_CAUSE_VERIFIED","INVESTIGATING","INSUFFICIENT_EVIDENCE","CONTRADICTORY_EVIDENCE"],
  VERIFYING:["ROOT_CAUSE_VERIFIED","SOURCE_NOT_VERIFIED","INSUFFICIENT_EVIDENCE","CONTRADICTORY_EVIDENCE"],
  ROOT_CAUSE_VERIFIED:["SOURCE_VERIFIED","SOURCE_NOT_VERIFIED","INVESTIGATING","EVIDENCE_COLLECTING"],
  // FIX: SOURCE_VERIFIED must be able to reach INVESTIGATION_BLOCKED. buildActionPlan()
  // can produce a BLOCKED action from a case that is already SOURCE_VERIFIED (proof
  // chain complete, but Guardian denies authorization e.g. missing integrity binding
  // on a low/medium-risk change). Without this entry, that legitimate outcome crashed
  // the runtime with INVALID_CASE_STATE_TRANSITION instead of blocking gracefully.
  SOURCE_VERIFIED:["CANDIDATE_READY","INVESTIGATING","EVIDENCE_COLLECTING","INVESTIGATION_BLOCKED"],
  CANDIDATE_READY:["EXECUTOR_REVIEW","HUMAN_APPROVAL","EXECUTING","INVESTIGATING"],
  EXECUTOR_REVIEW:["HUMAN_APPROVAL","EXECUTING","INVESTIGATION_BLOCKED"],
  HUMAN_APPROVAL:["EXECUTING","INVESTIGATION_BLOCKED"],
  EXECUTING:["VALIDATING","VALIDATION_FAILED"],
  VALIDATING:["RESOLVED","REOPENED","VALIDATION_FAILED"],
  VALIDATION_FAILED:["REOPENED","INVESTIGATING"],
  REOPENED:["INVESTIGATING","EVIDENCE_COLLECTING"]
};

function transition(c,to){
  if(!c || !c.state) throw new Error("CASE_STATE_REQUIRED");
  if(c.state===to) return c;
  if(to!=="EVIDENCE_COLLECTING" && !(CASE_TRANSITIONS[c.state]||[]).includes(to)) throw new Error(`INVALID_CASE_STATE_TRANSITION:${c.state}->${to}`);
  c.state=to;
  return c;
}

// Deterministic content binding for the brain layer. This is an integrity binding,
// not a cryptographic security primitive; the Executor must still enforce its own
// cryptographic source fingerprint before writing anything.
export function transitionCaseState(caseData,to){ const c=structuredClone(caseData); transition(c,to); c.updatedAt=now(); c.revision++; return c; }

export function contentFingerprint(text="") {
  let h=2166136261;
  for(const ch of String(text)){
    h ^= ch.codePointAt(0);
    h = Math.imul(h,16777619) >>> 0;
  }
  return `fnv1a32:${h.toString(16).padStart(8,"0")}`;
}

function normalizeEvidence(e={}) {
  return {
    id: e.id || id("ev"),
    type: e.type || "unknown",
    source: e.source || null,
    claim: e.claim || null,
    status: e.status || "UNVERIFIED",
    strength: Number.isFinite(e.strength) ? Math.max(0, Math.min(1,e.strength)) : 0,
    exact: !!e.exact,
    observedAt: e.observedAt || now(),
    fingerprint: e.fingerprint || null,
    metadata: e.metadata || {}
  };
}

export function createCase(input={}) {
  return {
    caseId: input.caseId || id(),
    state: "DETECTED",
    target: input.target || null,
    symptom: input.symptom || input.error || null,
    severity: input.severity || "UNKNOWN",
    evidence: [],
    hypotheses: [],
    selectedHypothesis: null,
    rootCause: null,
    exactSource: null,
    actionPlan: null,
    validation: null,
    createdAt: input.createdAt || now(),
    updatedAt: now(),
    revision: 0
  };
}

export function ingestEvidence(caseData, evidence) {
  const c = structuredClone(caseData);
  const incoming = Array.isArray(evidence) ? evidence : [evidence];
  const map = new Map(c.evidence.map(x=>[x.id,x]));
  for (const e of incoming) {
    const n = normalizeEvidence(e);
    const prior=map.get(n.id);
    if(prior){
      for(const k of ["type","source","claim","observedAt","fingerprint","exact"]){
        if(prior[k]!==undefined && n[k]!==undefined && JSON.stringify(prior[k])!==JSON.stringify(n[k]))
          throw new Error(`EVIDENCE_ID_COLLISION:${n.id}`);
      }
    }
    map.set(n.id,n);
  }
  c.evidence = [...map.values()];
  if(c.evidence.length){
    c.rootCause=null; c.exactSource=null; c.actionPlan=null; c.validation=null;
    transition(c,"EVIDENCE_COLLECTING");
  }
  c.updatedAt = now(); c.revision++;
  return c;
}

function normalizeClaim(claim=""){
  return String(claim).toLowerCase().replace(/\s+/g," ").trim();
}
function contradictionKey(claim=""){
  const c=normalizeClaim(claim);
  const prefix=/^(not |no |missing |absent |false: |does not |isn't |isnt |cannot |can't |cant )/;
  const negSuffix=/( does not exist| does not| is not| isn't| isnt| cannot| can't| cant| missing| absent| false)$/;
  const posSuffix=/( exists| is present| is available| true)$/;
  if(prefix.test(c)) return {atom:c.replace(prefix,"").trim(),negative:true};
  if(negSuffix.test(c)) return {atom:c.replace(negSuffix,"").trim(),negative:true};
  if(posSuffix.test(c)) return {atom:c.replace(posSuffix,"").trim(),negative:false};
  return {atom:c,negative:false};
}

export function detectContradictions(evidence=[]) {
  const groups=new Map();
  for(const e of evidence){
    if(!e?.claim) continue;
    const {atom,negative}=contradictionKey(e.claim);
    const g=groups.get(atom)||{positive:[],negative:[]};
    (negative?g.negative:g.positive).push(e);
    groups.set(atom,g);
  }
  const contradictions=[];
  for(const [atom,g] of groups){
    const pos=g.positive.filter(e=>e.status==="VERIFIED");
    const neg=g.negative.filter(e=>e.status==="VERIFIED");
    if(pos.length&&neg.length) contradictions.push({atom,positive:pos.map(e=>e.id),negative:neg.map(e=>e.id),kind:"SEMANTIC_NEGATION"});
    const all=[...g.positive,...g.negative];
    const rejected=all.filter(e=>e.status==="REJECTED"||e.status==="CONTRADICTED");
    const verified=all.filter(e=>e.status==="VERIFIED");
    if(verified.length&&rejected.length) contradictions.push({atom,verified:verified.map(e=>e.id),rejected:rejected.map(e=>e.id),kind:"STATUS_CONFLICT"});
  }
  return contradictions;
}

export function scoreHypothesis(h, evidence=[]) {
  const related = evidence.filter(e => (h.evidenceIds||[]).includes(e.id));
  if (!related.length) return 0;
  const verified = related.filter(e=>e.status==="VERIFIED");
  const exact = related.filter(e=>e.exact);
  const contradicted = related.filter(e=>e.status==="CONTRADICTED" || e.status==="REJECTED");
  const strength = related.reduce((s,e)=>s+e.strength,0) / related.length;
  return Math.max(0, Math.min(1, strength*0.45 + (verified.length/related.length)*0.35 +
    Math.min(1, exact.length/related.length)*0.20 - Math.min(0.7,contradicted.length*0.25)));
}

export function reason(caseData, hypotheses=[]) {
  const c = structuredClone(caseData);
  const hs = hypotheses.map(h => ({...h, score: scoreHypothesis(h,c.evidence)}))
    .sort((a,b)=>b.score-a.score);
  const contradictions = detectContradictions(c.evidence);
  c.hypotheses = hs;
  c.selectedHypothesis = hs[0] || null;
  const nextState=contradictions.length ? "CONTRADICTORY_EVIDENCE" :
    hs.length ? "HYPOTHESIS_FORMED" : "INVESTIGATING";
  transition(c,nextState);
  c.updatedAt = now(); c.revision++;
  return {caseData:c, contradictions};
}

export function verifyRootCause(caseData, rootCause) {
  const c = structuredClone(caseData);
  if(typeof rootCause?.statement!=="string" || !rootCause.statement.trim()) {
    c.rootCause=null;
    transition(c,"INSUFFICIENT_EVIDENCE");
    c.updatedAt=now(); c.revision++;
    return c;
  }
  const required = Array.isArray(rootCause?.evidenceIds) ? uniq(rootCause.evidenceIds) : [];
  const evidence = c.evidence.filter(e=>required.includes(e.id));
  const hypothesisId = typeof rootCause?.hypothesisId==="string" ? rootCause.hypothesisId.trim() : "";
  const hypothesis = c.hypotheses.find(h=>h?.id===hypothesisId);
  const hypothesisEvidence = Array.isArray(hypothesis?.evidenceIds) ? uniq(hypothesis.evidenceIds) : [];
  const independentSources = new Set(evidence.map(e=>e.source || e.metadata?.file || e.type || e.id));
  const independentSupport = independentSources.size>=2 || evidence.length>=2;
  const causalScore = Number(hypothesis?.score);
  const allVerified = required.length>0 && evidence.length===required.length &&
    evidence.every(e=>e.status==="VERIFIED") && !detectContradictions(evidence).length &&
    !!hypothesis && causalScore>=0.60 && hypothesisEvidence.length>0 &&
    required.every(id=>hypothesisEvidence.includes(id)) && independentSupport;
  c.rootCause = allVerified ? {
    statement: rootCause.statement,
    hypothesisId,
    hypothesisScore: causalScore,
    evidenceIds: required,
    verifiedAt: now()
  } : null;
  transition(c,allVerified ? "ROOT_CAUSE_VERIFIED" : "INSUFFICIENT_EVIDENCE");
  c.updatedAt = now(); c.revision++;
  return c;
}

export function verifyExactSource(caseData, source) {
  const c = structuredClone(caseData);
  const boundEvidence = Array.isArray(source?.evidenceIds) ? c.evidence.filter(e=>source.evidenceIds.includes(e.id)) : [];
  const exactBoundEvidence = boundEvidence.filter(e=>e.status==="VERIFIED" && e.exact && (
    e.fingerprint===source?.fingerprint || e.metadata?.file===source?.file || e.source===source?.file
  ));
  const valid = !!c.rootCause && !!source?.file && !!source?.originalCode &&
    !!source?.fingerprint && Array.isArray(source.evidenceIds) &&
    source.evidenceIds.length>0 &&
    source.evidenceIds.every(id => c.evidence.some(e=>e.id===id && e.status==="VERIFIED")) &&
    new Set(source.evidenceIds).size===source.evidenceIds.length &&
    source.evidenceIds.every(id => c.rootCause.evidenceIds.includes(id)) &&
    exactBoundEvidence.length>0 &&
    source.contentFingerprint === contentFingerprint(source.originalCode);
  c.exactSource = valid ? {...source, verifiedAt:now()} : null;
  transition(c,valid ? "SOURCE_VERIFIED" : "SOURCE_NOT_VERIFIED");
  c.updatedAt = now(); c.revision++;
  return c;
}

export function buildActionPlan(caseData, authorization) {
  const c = structuredClone(caseData);
  const proofState = ["SOURCE_VERIFIED","CANDIDATE_READY","EXECUTOR_REVIEW","HUMAN_APPROVAL"].includes(c.state);
  const verified = proofState && !!c.rootCause && !!c.exactSource;
  const decision = authorization?.decision || "BLOCKED";
  const action = !verified ? "INVESTIGATE" :
    decision==="AUTO_ALLOWED" ? "AUTO_PATCH_AND_EXECUTE_INTENT" :
    decision==="HUMAN_APPROVAL_REQUIRED" ? "HUMAN_APPROVAL_PATCH_AND_EXECUTE" :
    "BLOCKED";
  c.actionPlan = {
    planId:id("plan"),
    action,
    authorization: decision,
    authorizationId: authorization?.authorizationId || null,
    risk: authorization?.risk || "UNKNOWN",
    request: verified ? {
      file:c.exactSource.file,
      fingerprint:c.exactSource.fingerprint,
      sourceFingerprint:c.exactSource.sourceFingerprint||null,
      operation:c.exactSource.operation || "REPLACE_EXACT",
      originalCode:c.exactSource.originalCode,
      proposedCode:c.exactSource.proposedCode || null,
      evidenceIds:c.exactSource.evidenceIds
    } : null,
    createdAt:now()
  };
  transition(c,action==="INVESTIGATE" ? "INVESTIGATING" :
    action==="BLOCKED" ? "INVESTIGATION_BLOCKED" : "CANDIDATE_READY");
  c.updatedAt=now(); c.revision++;
  c.actionPlan.revision=c.revision;
  return c;
}

export { VERSION };
