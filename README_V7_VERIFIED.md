# CIKUR GO INTERNAL AI V7 — VERIFIED

## Tujuan
V7 memperkuat Internal Intelligence CIKUR GO dari reasoning berbasis sinyal menjadi **evidence-first causal reasoning** yang tetap read-only.

## Production files
- `bcgo.js` — monitoring/telemetry gateway dan intake Internal AI.
- `bcgo.html` — observer/UI; menampilkan reasoning dan causal trace.
- `cikur-config.js` — Firebase/infrastructure context gate; tidak berisi reasoning engine.

## Internal AI modules
- `cikur-internal-ai-core-v5.js` — evidence normalization/deduplication, freshness, source trust, hypothesis ranking, contradiction checks, causal links, precision blockers.
- `cikur-internal-ai-knowledge-v4.js` — internal knowledge graph dan verified/unverified relationship tracking.
- `cikur-internal-ai-guardian-v2.js` — runtime/schema/policy/capability guardian.
- `cikur-internal-ai-runtime-adapter-v5.js` — runtime coordinator dan controlled chat/reasoning event bridge.

## Guardrails
- External AI/API: disabled.
- Automatic patch: disabled.
- Automatic execution: disabled.
- Human approval: required.
- Medicine retains root-cause/exact-source verification.
- Executor retains execution gate.
- Internal AI cannot override Medicine, Executor, or Human approval.

## V7 behavior improvements
1. Evidence is deduplicated by content fingerprint instead of array position alone.
2. Evidence freshness affects weight; stale evidence cannot silently dominate fresh runtime evidence.
3. Session history can rank patterns but cannot increase confidence by repetition alone.
4. Hypotheses expose independent evidence count and source diversity.
5. Causal links are explicitly marked `verified: false` until proven by the proper investigation path.
6. Active cases remain blocked from root-cause/exact-source claims until Medicine verification.
7. Guardian audits required state fields and forbidden runtime capabilities.
8. Heartbeat/cycle changes alone do not create new thought messages or raise hypothesis confidence.
9. UI adds a compact `CAUSAL TRACE` line without replacing the existing BCGO monitor.

## Verification performed
- Node syntax check: all V7 JavaScript modules and `bcgo.js` PASS.
- Inline JavaScript extracted from `bcgo.html`: PASS.
- Runtime simulation: PASS.
- Identical-evidence heartbeat test: confidence unchanged.
- Identical-evidence heartbeat test: one thought only; no chat spam.
- Guardian baseline: NONE/healthy under valid policy.
- Guardian capabilities: patch/execute/external-AI/override capabilities all false.
- Active-case precision gate: remains BLOCKED for root-cause/exact-source verification.
- Stable-state precision gate: PASS.
- External AI/API name/dependency scan of Internal AI modules: PASS.

## Deployment note
Production filenames are intentionally unchanged. Upload the three production files and the four Internal AI modules together at the same repository path. Do not rename the production files.

The `BACKUP_ORIGINAL/` directory contains the pre-Internal-AI originals used for rollback.
