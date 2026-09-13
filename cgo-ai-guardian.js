/* CIKUR GO Internal Guardian — Final Internal Auto Policy v1.6.0
 * Deterministic integrity/security gate between proof, policy and execution.
 * No external AI/API. No source mutation. Guardian authorizes intent only.
 *
 * INTERNAL AUTO PRINCIPLE:
 * A complete proof does not require a second human approval step. The Guardian
 * remains the mandatory gate and allows automatic execution only for the exact
 * CIKUR internal execution policy with complete proof/integrity bindings.
 */
import { CASE_TRANSITIONS } from "./cgo-ai-core.js?v=20260913-bcgo-cgo-me-exec-v2";
import * as Instruction from "./cgo-instruction.js?v=20260913-bcgo-cgo-me-exec-v2";

const VERSION="1.7.0-CONSTITUTION-BOUND";
const INTERNAL_AUTO_POLICY="CIKUR-INTERNAL-AUTO-1";
const RISK = {LOW:1, MEDIUM:2, HIGH:3, CRITICAL:4};

export function classifyRisk(input={}) {
  if(input.risk && RISK[input.risk]) return input.risk;
  if(input.severity==="CRITICAL" || input.affectsSecurity || input.affectsRules) return "CRITICAL";
  if(input.severity==="HIGH" || input.affectsAuth || input.affectsDataModel || input.affectsDeployment) return "HIGH";
  if(input.severity==="MEDIUM") return "MEDIUM";
  if(input.crossFile || input.sharedCore) return "MEDIUM";
  return "LOW";
}

function countDependents(knowledge, nodeId) {
  if(!knowledge || !Array.isArray(knowledge.edges) || !nodeId) return 0;
  return knowledge.edges.filter(e => e.to===nodeId && e.type==="DEPENDS_ON" && e.status!=="RETIRED").length;
}

export function classifyRiskWithGraph(input={}, knowledge=null) {
  const base=classifyRisk(input);
  if(!knowledge || !input.target) return base;
  const node=(knowledge.nodes||[]).find(n=>n.id===input.target || n.name===input.target);
  if(!node) return base;
  const dependents=countDependents(knowledge,node.id);
  const order=["LOW","MEDIUM","HIGH","CRITICAL"];
  const bump=dependents>=5 ? 2 : dependents>=2 ? 1 : 0;
  return order[Math.min(order.length-1,order.indexOf(base)+bump)];
}

function internalAutoPolicy(policy={}) {
  return policy.version===INTERNAL_AUTO_POLICY &&
    policy.allowAutomaticExecution===true &&
    policy.automaticPatch===true &&
    policy.automaticExecution===true &&
    policy.executionMode==="INTERNAL_AUTO";
}

function humanApprovedPolicy(policy={}) {
  return policy.version===INTERNAL_AUTO_POLICY &&
    policy.executionMode==="HUMAN_APPROVED" &&
    policy.humanApprovalVerified===true;
}

export function authorizeAction(input={}) {
  const risk=input.knowledge ? classifyRiskWithGraph(input,input.knowledge) : classifyRisk(input);
  const verified=!!input.rootCauseVerified && !!input.sourceVerified && !!input.exactFingerprint;
  const sourceIntegrity=!!input.sourceFingerprint;
  const candidateReady=typeof input.proposedCode==="string" && input.proposedCode.trim().length>0;
  const clean=!(input.contradictoryEvidence || input.unresolvedEvidence);
  const policy=input.policy||{};

  if(!verified || !clean)
    return {decision:"BLOCKED",risk,reason:"PROOF_CHAIN_INCOMPLETE_OR_CONTRADICTORY",policyVersion:policy.version||INTERNAL_AUTO_POLICY};

  if(!candidateReady)
    return {decision:"BLOCKED",risk,reason:"CONCRETE_SOLUTION_NOT_READY",policyVersion:policy.version||INTERNAL_AUTO_POLICY};

  if(!sourceIntegrity)
    return {decision:"BLOCKED",risk,reason:"SOURCE_INTEGRITY_BINDING_REQUIRED",policyVersion:policy.version||INTERNAL_AUTO_POLICY};

  if(!internalAutoPolicy(policy) && !humanApprovedPolicy(policy))
    return {decision:"BLOCKED",risk,reason:"EXECUTION_AUTHORIZATION_POLICY_REQUIRED",policyVersion:policy.version||INTERNAL_AUTO_POLICY};

  return {
    decision:internalAutoPolicy(policy) ? "AUTO_ALLOWED" : "HUMAN_AUTHORIZED",
    risk,
    reason:risk==="CRITICAL" || risk==="HIGH"
      ? "VERIFIED_INTERNAL_AUTO_POLICY_ALLOWED_HIGH_ASSURANCE"
      : "VERIFIED_INTERNAL_AUTO_POLICY_ALLOWED",
    policyVersion:INTERNAL_AUTO_POLICY
  };
}

export function guardTransition(from,to,ctx={}) {
  const ok=to==="EVIDENCE_COLLECTING" || (CASE_TRANSITIONS[from]||[]).includes(to);
  return {ok,from,to,reason:ok?"ALLOWED":"INVALID_TRANSITION"};
}

export { VERSION, INTERNAL_AUTO_POLICY, Instruction };
