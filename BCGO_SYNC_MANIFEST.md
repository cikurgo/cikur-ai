# BCGO V2.15.5 — SYNCHRONIZED BRAIN DEPLOYMENT

Entry: bcgo.js -> cikur-internal-ai-runtime-adapter-v9.js?v=5.2.5

Active policy:
- automaticPatch: true
- automaticExecution: true
- externalAI: false
- automaticSourceMutation: false
- humanApprovalRequired: true
- medicineOwnsVerification: true
- executorOwnsExecutionGate: true

Foundation lineage included unchanged:
- cgo-core.js
- cgo-knowledge.js
- cgo-guardian.js

Critical deployment requirement:
The foundation files are bundled in the same deployment directory because the master runtime imports them. Missing them causes module-load failure before BCGO can initialize.
