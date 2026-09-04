# MANIFEST — CIKUR GO Internal AI V8.1 VERIFIED

Production:
- bcgo.js — BCGO monitor + Internal AI integration
- bcgo.html — BCGO observer/UI + Internal AI status/reasoning display
- cikur-config.js — Firebase/context infrastructure gate
- cikur-internal-ai-core-v6.js — evidence-first reasoning core
- cikur-internal-ai-knowledge-v5.js — provenance-aware knowledge graph
- cikur-internal-ai-guardian-v3.js — system guardian
- cikur-internal-ai-runtime-adapter-v6.js — runtime coordinator/event gate

Verification performed:
- Node syntax check: all production JS PASS
- Inline JS extracted from bcgo.html: PASS
- system_logs listener state is now explicitly ingested by Internal AI before UI publication
- Runtime simulation: PASS
- Identical heartbeat state did not increase evidence count
- Identical heartbeat state emitted no additional thought
- Guardian healthy state: GUARDIAN_OK / level NONE
- Active case remains Precision Gate BLOCKED until Medicine verification
- External AI/API capability: disabled by policy
- Automatic patch/execution: disabled by policy

Important: `level=NONE` in guardian data means no guardian issue. UI now renders this as `GUARD OK`.
