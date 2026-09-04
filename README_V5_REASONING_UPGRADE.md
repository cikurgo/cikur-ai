# CIKUR GO INTERNAL AI — V5 REASONING UPGRADE

Production filenames remain unchanged:
- bcgo.js
- bcgo.html
- cikur-config.js

New internal intelligence modules are kept together in the repository root:
- cikur-internal-ai-core-v3.js
- cikur-internal-ai-knowledge-v2.js
- cikur-internal-ai-runtime-adapter-v3.js

## What changed

V4 was a live runtime adapter. V5 upgrades that adapter into an evidence-first internal reasoning layer.

The Internal AI now:
1. Normalizes live BCGO_STATE.
2. Collects evidence from runtime error, active cases, logs, source findings, cross-file findings, and relevant events.
3. Classifies the current signal.
4. Forms multiple deterministic hypotheses when the evidence supports them.
5. Scores hypotheses with bounded internal confidence.
6. Shows supporting evidence IDs.
7. Produces a concrete investigation plan / next evidence request.
8. Runs a Precision Gate that blocks unverified root-cause/exact-source conclusions.
9. Publishes a reasoning event to the UI.
10. Answers chat questions from the live reasoning snapshot.

## Hard boundaries

- No third-party AI/API.
- No network-based LLM.
- No automatic source mutation.
- No automatic patch.
- No automatic execution.
- Medicine remains responsible for root-cause and exact-source verification.
- Executor remains responsible for deterministic review/execution.
- Human approval remains mandatory.

## Pipeline

BCGO -> Internal Intelligence -> Medicine -> Executor -> Human Approval -> Execution -> Validation -> BCGO

This is an integration/test build. It should be validated in the live project before being treated as production-stable.
