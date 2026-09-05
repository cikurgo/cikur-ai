# CIKUR GO Internal AI V5.2.2 — Brain Nerve Patch

Focused patch after BCGO Foundation v2.16.1 was confirmed LIVE.

## Changed
- cgo-ai-browser-adapter.js v5.2 browser bridge now ingests BCGO fileNerves, source findings, and dependency relations as proof-bound observations with stable deduplication.
- cgo-ai-investigation-engine.js v2.1.0 now distinguishes causal hypotheses from non-causal runtime/source discrepancies, adds runtime-context probing, and supports per-step progress callbacks.
- cgo-ai-core.js keeps causal hypotheses preferred on equal scores; non-causal hypotheses cannot be promoted to ROOT_CAUSE_VERIFIED.

## Safety
- No external AI/API added.
- No source mutation.
- No automatic patch execution.
- Existing Guardian / Executor gates remain authoritative.

## Deployment
Replace only the three JS files above in the existing internal-AI deployment. Do not replace bcgo.js, bcgo.html, Medicine, Executor, or Firestore Rules with this patch.

## Validation
- All brain JS syntax checks PASS.
- Missing-symbol causal test: SOURCE_VERIFIED PASS.
- Defined-symbol runtime discrepancy: remains HYPOTHESIS_FORMED / no false root cause PASS.
- Module-boundary causal test: SOURCE_VERIFIED PASS.
