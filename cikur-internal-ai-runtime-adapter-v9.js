/*
 * CIKUR GO INTERNAL AI — MASTER RUNTIME GATEWAY / SYNCHRONIZED BRAIN
 *
 * This filename is retained as the single deployment entrypoint requested by
 * the project. The three renamed foundation modules are the original source
 * contents moved without rewriting:
 *   cikur-internal-ai-core-v9.js     -> cgo-core.js
 *   cikur-internal-ai-knowledge-v6.js -> cgo-knowledge.js
 *   cikur-internal-ai-guardian-v4.js  -> cgo-guardian.js
 *
 * The active V5.2 brain remains available as the causal/proof/investigation
 * layer. This gateway composes both layers without allowing source mutation,
 * external AI, patching, or execution.
 */
import * as FoundationCore from "./cgo-core.js";
import * as FoundationKnowledge from "./cgo-knowledge.js";
import * as FoundationGuardian from "./cgo-guardian.js";
import * as Core from "./cgo-ai-core.js";
import * as Logic from "./cgo-ai-logic.js";
import * as Cognition from "./cgo-ai-cognition.js";
import * as Investigator from "./cgo-ai-investigator.js";
import * as InvestigationEngine from "./cgo-ai-investigation-engine.js";
import * as Knowledge from "./cgo-ai-knowledge.js";
import * as Guardian from "./cgo-ai-guardian.js";
import * as Memory from "./cgo-ai-memory.js";
import * as RuntimeAdapter from "./cgo-ai-runtime-adapter.js";
import * as BrowserBridge from "./cgo-ai-browser-adapter.js";

export const VERSION = "V5.2.5-SYNCHRONIZED-MASTER-RUNTIME";
export const ARCHITECTURE = "CGO_INTERNAL_BRAIN_SYNCHRONIZED_MASTER_GATEWAY";
export const LEGACY_V9 = false;

export { FoundationCore, FoundationKnowledge, FoundationGuardian,
  Core, Logic, Cognition, Investigator, InvestigationEngine, Knowledge,
  Guardian, Memory, RuntimeAdapter, BrowserBridge };

const policy = Object.freeze({
  externalAI: false,
  automaticPatch: true,
  automaticExecution: true,
  automaticSourceMutation: false,
  humanApprovalRequired: true,
  medicineOwnsVerification: true,
  executorOwnsExecutionGate: true,
  sourceBoundProof: true,
  causalVerification: true,
  staleStateProtection: true
});

function clone(v) {
  try { return typeof structuredClone === "function" ? structuredClone(v) : JSON.parse(JSON.stringify(v)); }
  catch { return v; }
}

function foundationReason(state, history = {}) {
  try { return FoundationCore.reason(clone(state), clone(history)); }
  catch (error) { return { version: FoundationCore.VERSION, classification: "FOUNDATION_ERROR", error: String(error?.message || error) }; }
}

function foundationKnowledge(state, foundationReasoning) {
  try { return FoundationKnowledge.createKnowledgeSnapshot(clone(state), clone(foundationReasoning)); }
  catch (error) { return { version: FoundationKnowledge.VERSION, nodes: [], edges: [], error: String(error?.message || error) }; }
}

function foundationGuardian(state) {
  try {
    return FoundationGuardian.inspect({
      state: clone(state),
      // Foundation guardian is the preserved legacy lineage auditor.
      // Its historical policy is intentionally fixed to non-mutating capability.
      // The active execution policy is owned by the V5.2 guardian/Executor path.
      context: { ...policy, automaticPatch: false, automaticExecution: false },
      runtimeVersion: VERSION,
      expectedRuntimeVersion: VERSION,
      runtimeApi: { version: VERSION, ingestBCGOState: true }
    });
  } catch (error) {
    return { version: FoundationGuardian.VERSION, healthy: false, level: "CRITICAL", issues: [{ code: "FOUNDATION_GUARDIAN_ERROR", severity: "CRITICAL", message: String(error?.message || error) }] };
  }
}

let cached = null;

export function install() {
  if (cached) return cached;
  const bridge = BrowserBridge.install();
  const gateway = {
    version: VERSION,
    architecture: ARCHITECTURE,
    ingestBCGOState(state = {}) {
      const active = bridge.ingestBCGOState(clone(state));
      const foundation = foundationReason(state);
      const graph = foundationKnowledge(state, foundation);
      const guard = foundationGuardian(state);
      const merged = {
        ...active,
        masterRuntimeVersion: VERSION,
        foundation: { reasoning: foundation, knowledge: graph, guardian: guard },
        policy
      };
      try {
        window.dispatchEvent(new CustomEvent("cikur-internal-ai-master-state", { detail: clone(merged) }));
      } catch {}
      return merged;
    },
    getSnapshot() { return bridge.getSnapshot?.() || null; },
    deliberate: bridge.deliberate,
    investigate: bridge.investigate,
    logic: bridge.logic,
    getRuntime: bridge.getRuntime
  };
  cached = Object.freeze(gateway);
  return cached;
}

export function reason(context = {}, history = {}) {
  const active = BrowserBridge.reason(context, history);
  const foundationInput = {
    source: "MEDICINE",
    targetCell: context.target || null,
    errorLog: context.errorLog || null,
    medicineEvidence: clone(context.medicineEvidence || []),
    activeCases: context.activeCases || [],
    sourceScan: context.sourceScan || {},
    connection: context.connection || { status: "UNKNOWN" },
    firestore: context.firestore || {}
  };
  const foundation = foundationReason(foundationInput, history);
  const graph = foundationKnowledge(foundationInput, foundation);
  return {
    ...active,
    masterRuntimeVersion: VERSION,
    foundation: { reasoning: foundation, knowledge: graph },
    policy
  };
}

export function getBrainManifest() {
  return Object.freeze({
    version: VERSION,
    architecture: ARCHITECTURE,
    gateway: "cikur-internal-ai-runtime-adapter-v9.js",
    lineage: Object.freeze({
      core: "cikur-internal-ai-core-v9.js -> cgo-core.js (original content)",
      knowledge: "cikur-internal-ai-knowledge-v6.js -> cgo-knowledge.js (original content)",
      guardian: "cikur-internal-ai-guardian-v4.js -> cgo-guardian.js (original content)"
    }),
    modules: Object.freeze({
      foundationCore: FoundationCore.VERSION,
      foundationKnowledge: FoundationKnowledge.VERSION,
      foundationGuardian: FoundationGuardian.VERSION,
      core: Core.VERSION,
      logic: Logic.VERSION,
      cognition: Cognition.VERSION,
      investigator: Investigator.VERSION,
      investigationEngine: InvestigationEngine.VERSION,
      knowledge: Knowledge.VERSION,
      guardian: Guardian.VERSION,
      memory: Memory.VERSION,
      runtimeAdapter: RuntimeAdapter.VERSION,
      browserBridge: BrowserBridge.VERSION
    }),
    policy
  });
}

export function createMasterRuntime(options = {}) {
  const runtime = RuntimeAdapter.createRuntime(options);
  return Object.freeze({
    version: VERSION,
    manifest: getBrainManifest(),
    runtime,
    foundation: { Core: FoundationCore, Knowledge: FoundationKnowledge, Guardian: FoundationGuardian },
    brain: { Core, Logic, Cognition, Investigator, InvestigationEngine, Knowledge, Guardian, Memory, RuntimeAdapter },
    browser: { install, reason }
  });
}
