# CIKUR GO INTERNAL AI — V6 REASONING + GUARDIAN

This package is an upgrade of the V5.1 runtime, not a replacement of the CIKUR GO architecture.

## Production files (unchanged names)
- `bcgo.js`
- `bcgo.html`
- `cikur-config.js`

## Internal Intelligence
- `cikur-internal-ai-core-v4.js` — evidence collection, deduplication, correlation, hypothesis ranking, contradiction checks, session pattern memory.
- `cikur-internal-ai-knowledge-v3.js` — read-only system knowledge graph from verified runtime context.
- `cikur-internal-ai-runtime-adapter-v4.js` — runtime brain connecting BCGO_STATE -> knowledge -> reasoning -> guardian -> UI.
- `cikur-internal-ai-guardian-v1.js` — read-only system guard for state schema, policy integrity, runtime drift, connection/Firestore risk, and telemetry inconsistencies.

## What V6 adds
1. Evidence is deduplicated before reasoning so repeated telemetry does not inflate the apparent proof.
2. Evidence source trust contributes to ranking, but trust never becomes proof.
3. Similar active cases are clustered instead of creating repeated copies of the same hypothesis.
4. Cross-file mismatch/variant signals become a separate hypothesis class.
5. Contradictory evidence blocks premature conclusions.
6. Session pattern memory records repeated hypotheses without claiming that repetition proves causality.
7. Knowledge graph records explicit runtime relationships and refuses to invent unknown relationships.
8. Guardian verifies the Internal AI policy and BCGO_STATE integrity on every intake.
9. Guardian has no patch/execute/network-AI capability.
10. UI can expose REASONING ACTIVE and GUARD status without turning heartbeat cycles into chat spam.

## Hard boundaries
- No third-party AI/API.
- No external LLM.
- No automatic source mutation.
- No automatic patch.
- No automatic execution.
- Medicine remains responsible for root-cause and exact-source verification.
- Executor remains responsible for deterministic execution review/gate.
- Human approval remains mandatory.

## Pipeline
BCGO -> Internal Intelligence -> Medicine -> Executor -> Human Approval -> Execution -> Validation -> BCGO

## Important limitation
V6 is a deterministic internal intelligence system, not a general-purpose neural/LLM model. Its intelligence comes from structured evidence, system knowledge, correlation, hypothesis testing, guardrails, and live state. The next meaningful capability is deeper system knowledge/source understanding, not adding an external AI service.

## Backup
`BACKUP_ORIGINAL/` contains the pre-V6 production files for rollback/reference. It is not required by the runtime.
