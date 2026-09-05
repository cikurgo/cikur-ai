/* CIKUR GO Internal Guardian
 * Capability is not globally disabled. Authorization is policy/risk based.
 * Guardian authorizes intent; it does not write files.
 */
import { CASE_TRANSITIONS } from "./cgo-ai-core.js";

const VERSION="1.4.0";

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

// UPGRADE: risk classification that is aware of blast radius. A change to a file
// many other files depend on deserves more scrutiny than the same change to an
// isolated file, even when nothing else about the change looks risky. Purely
// additive: with no knowledge graph (or no match for the target), behaves
// identically to classifyRisk().
export function classifyRiskWithGraph(input={}, knowledge=null) {
  const base = classifyRisk(input);
  if(!knowledge || !input.target) return base;
  const node = (knowledge.nodes||[]).find(n => n.id===input.target || n.name===input.target);
  if(!node) return base;
  const dependents = countDependents(knowledge, node.id);
  const order = ["LOW","MEDIUM","HIGH","CRITICAL"];
  const bump = dependents>=5 ? 2 : dependents>=2 ? 1 : 0;
  return order[Math.min(order.length-1, order.indexOf(base)+bump)];
}

export function authorizeAction(input={}) {
  const risk = input.knowledge ? classifyRiskWithGraph(input, input.knowledge) : classifyRisk(input);
  const verified=!!input.rootCauseVerified && !!input.sourceVerified && !!input.exactFingerprint;
  const candidateReady=typeof input.proposedCode === "string" && input.proposedCode.trim().length>0;
  const autoIntegrity=!!input.sourceFingerprint;
  const clean=!(input.contradictoryEvidence||input.unresolvedEvidence);
  const policy=input.policy||{};
  // Automatic execution is opt-in: only an explicit true may permit it.
  // Undefined and false both require human approval after proof/risk gates pass.
  if(!verified || !clean) return {decision:"BLOCKED",risk,reason:"PROOF_CHAIN_INCOMPLETE_OR_CONTRADICTORY",policyVersion:policy.version||"1"};
  if(!candidateReady) return {decision:"BLOCKED",risk,reason:"CONCRETE_SOLUTION_NOT_READY",policyVersion:policy.version||"1"};
  if(risk!=="CRITICAL" && risk!=="HIGH" && !autoIntegrity && input.allowAutomaticExecution===true)
    return {decision:"BLOCKED",risk,reason:"SOURCE_INTEGRITY_BINDING_REQUIRED",policyVersion:policy.version||"1"};
  if(risk==="CRITICAL") return {decision:"HUMAN_APPROVAL_REQUIRED",risk,reason:"CRITICAL_CHANGE",policyVersion:policy.version||"1"};
  if(risk==="HIGH") return {decision:"HUMAN_APPROVAL_REQUIRED",risk,reason:"HIGH_RISK_CHANGE",policyVersion:policy.version||"1"};
  if(input.allowAutomaticExecution!==true) return {decision:"HUMAN_APPROVAL_REQUIRED",risk,reason:"POLICY_REQUIRES_HUMAN_OR_NOT_EXPLICITLY_ENABLED",policyVersion:policy.version||"1"};
  return {decision:"AUTO_ALLOWED",risk,reason:"VERIFIED_LOW_RISK_POLICY_ALLOWED",policyVersion:policy.version||"1"};
}

export function guardTransition(from,to,ctx={}) {
  const ok=to==="EVIDENCE_COLLECTING" || (CASE_TRANSITIONS[from]||[]).includes(to);
  return {ok,from,to,reason:ok?"ALLOWED":"INVALID_TRANSITION"};
}
export { VERSION };
