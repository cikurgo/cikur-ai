/*
 * CIKUR GO INTERNAL AI — MASTER RUNTIME GATEWAY
 *
 * IMPORTANT:
 * - This filename is retained as the requested deployment entrypoint.
 * - It is NOT the legacy V9 brain.
 * - The active brain remains the cgo-ai-* architecture.
 * - This module is the single public gateway for BCGO and Medicine.
 * - No external AI/API is used.
 * - No source mutation is performed here.
 */

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

export const VERSION = "V5.2.5-MASTER-RUNTIME";
export const ARCHITECTURE = "CGO_INTERNAL_BRAIN_MASTER_GATEWAY";
export const LEGACY_V9 = false;

/*
 * The complete brain is exposed as stable namespaces so callers have one
 * deterministic import point without flattening or renaming internal APIs.
 */
export {
  Core,
  Logic,
  Cognition,
  Investigator,
  InvestigationEngine,
  Knowledge,
  Guardian,
  Memory,
  RuntimeAdapter,
  BrowserBridge
};

/*
 * Public BCGO / Medicine surface.
 * Keep these aliases deliberately small: production surfaces should depend
 * on the gateway, while the internal modules remain independently testable.
 */
export const install = BrowserBridge.install;
export const reason = BrowserBridge.reason;

export function getBrainManifest() {
  return Object.freeze({
    version: VERSION,
    architecture: ARCHITECTURE,
    legacyV9: LEGACY_V9,
    gateway: "cgo-runtime-adapter.js",
    modules: Object.freeze({
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
    policy: Object.freeze({
      externalAI: false,
      automaticSourceMutation: false,
      humanApprovalForExecution: true,
      sourceBoundProof: true,
      causalVerification: true,
      staleStateProtection: true
    })
  });
}

export function createMasterRuntime(options = {}) {
  const runtime = RuntimeAdapter.createRuntime(options);
  return Object.freeze({
    version: VERSION,
    manifest: getBrainManifest(),
    runtime,
    brain: {
      Core,
      Logic,
      Cognition,
      Investigator,
      InvestigationEngine,
      Knowledge,
      Guardian,
      Memory,
      RuntimeAdapter
    },
    browser: {
      install,
      reason
    }
  });
}
