/* CIKUR GO Internal AI Logic Layer
 * Deterministic decision logic between cognition/core, proof, guardian and execution.
 * No external AI/API. No source mutation. Automatic patch/execution remains capability-driven
 * and is allowed only when proof + policy + integrity gates all pass.
 */
import * as Core from "./cgo-ai-core.js?v=5.2.5-sync-20260905";
import * as Guardian from "./cgo-ai-guardian.js?v=5.2.5-sync-20260905";
import * as Cognition from "./cgo-ai-cognition.js?v=5.2.5-sync-20260905";

const VERSION="1.4.0";

function clone(v){ return structuredClone(v); }
function verifiedEvidence(caseData){ return (caseData?.evidence||[]).filter(e=>e?.status==="VERIFIED"); }
function contradictions(caseData){ return Core.detectContradictions(caseData?.evidence||[]); }

export function evaluate(caseData, policy={}, knowledge=null){
  const c=clone(caseData||{});
  const verified=verifiedEvidence(c);
  const contradictory=contradictions(c);
  const unresolved=(c.evidence||[]).some(e=>e?.status!=="VERIFIED" && e?.metadata?.proofRequired!==false);
  const rootIds=Array.isArray(c.rootCause?.evidenceIds)?c.rootCause.evidenceIds:[];
  const rootEvidenceBound=!!c.rootCause && rootIds.length>0 && new Set(rootIds).size===rootIds.length && rootIds.every(id=>verified.some(e=>e.id===id));
  const rootHypothesis = c.hypotheses?.find(h=>h?.id===c.rootCause?.hypothesisId);
  const rootHypothesisEvidence = Array.isArray(rootHypothesis?.evidenceIds) ? rootHypothesis.evidenceIds : [];
  const independentRootSupport = new Set(rootIds.map(id=>{const e=verified.find(x=>x.id===id); return e?.source || e?.metadata?.file || e?.type || e?.id;})).size>=2 || rootIds.length>=2;
  const causalRootVerified = rootEvidenceBound && !!rootHypothesis && Number(rootHypothesis.score)>=0.60 &&
    Number(c.rootCause?.hypothesisScore)===Number(rootHypothesis.score) &&
    String(c.rootCause?.statement || "").trim()===String(rootHypothesis.statement || "").trim() &&
    rootHypothesisEvidence.length>0 && rootIds.every(id=>rootHypothesisEvidence.includes(id)) && independentRootSupport;
  const rootVerified=causalRootVerified && c.state!=="CONTRADICTORY_EVIDENCE";
  const sourceEvidenceBound=!!c.exactSource && Array.isArray(c.exactSource.evidenceIds) &&
    c.exactSource.evidenceIds.length>0 && c.exactSource.evidenceIds.every(id=>rootIds.includes(id));
  const sourceVerified=!!c.exactSource && sourceEvidenceBound;
  const fingerprintBound=sourceVerified && !!c.exactSource?.fingerprint &&
    c.exactSource.contentFingerprint===Core.contentFingerprint(c.exactSource.originalCode||"");
  const sourceFingerprintBound=sourceVerified && !!c.exactSource?.sourceFingerprint;
  const proof={
    evidenceCount:(c.evidence||[]).length,
    verifiedEvidenceCount:verified.length,
    unresolved,
    contradictory:contradictory.length>0,
    rootCauseVerified:rootVerified,
    causalRootVerified,
    rootEvidenceBound,
    sourceVerified,
    fingerprintBound,
    sourceFingerprintBound,
    sourceEvidenceBound,
    complete:rootVerified && sourceVerified && fingerprintBound && sourceFingerprintBound && sourceEvidenceBound && !unresolved && !contradictory.length
  };
  const cognition=Cognition.deliberate({
    evidence:c.evidence||[], rootCause:c.rootCause, exactSource:c.exactSource,
    contradictions:contradictory, proofComplete:(rootVerified && sourceVerified && fingerprintBound && sourceFingerprintBound && sourceEvidenceBound && !unresolved && !contradictory.length)
  });
  const guardian=Guardian.authorizeAction({
    caseId:c.caseId,
    rootCauseVerified:rootVerified,
    causalRootVerified,
    rootEvidenceBound,
    sourceVerified,
    exactFingerprint:fingerprintBound ? c.exactSource.fingerprint : null,
    sourceFingerprint:c.exactSource?.sourceFingerprint||null,
    allowAutomaticExecution:policy.allowAutomaticExecution,
    contradictoryEvidence:proof.contradictory,
    unresolvedEvidence:proof.unresolved,
    severity:c.severity,
    target:c.target,
    proposedCode:c.exactSource?.proposedCode || null,
    knowledge,
    policy
  });
  const action = proof.complete ? guardian.decision : "BLOCKED";
  const reason = !proof.complete ? "PROOF_CHAIN_INCOMPLETE" : guardian.reason;
  return clone({caseId:c.caseId, revision:c.revision||0, proof, cognition, guardian, decision:action, reason});
}

export function decide(caseData, policy={}, knowledge=null){
  const evaluation=evaluate(caseData,policy,knowledge);
  if(evaluation.decision!=="AUTO_ALLOWED") return evaluation;
  if(!evaluation.proof.complete) return {...evaluation,decision:"BLOCKED",reason:"PROOF_CHAIN_INCOMPLETE"};
  return {...evaluation,decision:"AUTO_ALLOWED",reason:"AUTO_PATCH_EXECUTION_READY"};
}

export function reconcile(caseData, policy={}, previous=null, knowledge=null){
  const current=decide(caseData,policy,knowledge);
  if(!previous) return current;
  if(previous.caseId!==current.caseId) return current;
  if(Number(previous.revision||0)>Number(current.revision||0))
    return clone(previous);
  return current;
}

export function buildAction(caseData, authorization){
  const c=clone(caseData||{});
  const auth=clone(authorization||{});
  if(c.state!=="SOURCE_VERIFIED" || !c.rootCause || !c.exactSource)
    return {action:"INVESTIGATE",executable:false,reason:"PROOF_CHAIN_INCOMPLETE"};
  if(typeof c.exactSource.proposedCode!=="string" || !c.exactSource.proposedCode.trim())
    return {action:"INVESTIGATE",executable:false,reason:"CONCRETE_SOLUTION_NOT_READY"};
  if(auth.decision==="AUTO_ALLOWED") return {
    action:"AUTO_PATCH_AND_EXECUTE_INTENT", executable:true,
    authorizationId:auth.authorizationId||null, caseId:c.caseId,
    revision:c.revision||0, request:clone({
      file:c.exactSource.file,
      fingerprint:c.exactSource.fingerprint,
      sourceFingerprint:c.exactSource.sourceFingerprint||null,
      operation:c.exactSource.operation||"REPLACE_EXACT",
      originalCode:c.exactSource.originalCode,
      proposedCode:c.exactSource.proposedCode||null,
      evidenceIds:c.exactSource.evidenceIds||[]
    })
  };
  if(auth.decision==="HUMAN_APPROVAL_REQUIRED") return {
    action:"HUMAN_APPROVAL_PATCH_AND_EXECUTE", executable:false,
    authorizationId:auth.authorizationId||null, caseId:c.caseId,
    revision:c.revision||0
  };
  return {action:"BLOCKED",executable:false,reason:auth.reason||"POLICY_BLOCKED",caseId:c.caseId};
}

export { VERSION };
