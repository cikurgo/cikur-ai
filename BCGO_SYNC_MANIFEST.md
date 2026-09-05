# BCGO V2.15.6 — SYNCHRONIZED BRAIN DEPLOYMENT

Entry: bcgo.html -> bcgo.js?v=2.15.6 -> cikur-internal-ai-runtime-adapter-v9.js?v=5.2.6

Active policy:
- automaticPatch: true
- automaticExecution: true
- externalAI: false
- automaticSourceMutation: false
- humanApprovalRequired: true
- medicineOwnsVerification: true
- executorOwnsExecutionGate: true

Deployment closure:
- cikur-config.js is bundled because bcgo.js imports it directly.
- cgo-core.js, cgo-knowledge.js, cgo-guardian.js are bundled because the master runtime imports them directly.
- All local JavaScript imports in the BCGO package resolve to files included in this deployment.

Foundation guardian note:
- cgo-guardian.js is preserved original lineage and remains a non-mutating foundation auditor.
- Its historical automaticPatch=false / automaticExecution=false contract is intentionally preserved.
- The live V5.2 guardian + deterministic Executor path owns the active approved patch/execution policy.
