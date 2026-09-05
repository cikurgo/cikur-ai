# CIKUR GO Internal AI V5.1 — Production Synchronization

## Architecture
- `cgo-ai-*` = internal V5 brain modules.
- `cgo-ai-browser-adapter.js` = browser compatibility/integration bridge.
- `bcgo.js` = live BCGO intake into the V5 brain.
- `bcgo-medicine.js` = Medicine evidence reasoning through the V5 bridge.
- `bcgo.html` = presentation/observer surface; BCGO_STATE remains authoritative.
- `bcgo-medicine.html` = Medicine control-room surface.
- `bcgo-executor.js` + `bcgo-executor-core.js` = deterministic execution layer, separate from the brain.
- `cikur-config.js` = shared Firebase configuration/connection.

## Safety boundaries
- No external AI/API was added.
- Brain does not write repository source directly.
- Medicine remains the diagnostic/proof authority.
- Executor remains deterministic and human approval remains required unless an explicit auto policy is supplied and all gates pass.
- V5 brain modules are not added to BCGO ORGAN_REGISTRY, preventing recursive self-diagnosis.

## Audit findings fixed in V5.1
- HIGH evidence strength could previously be promoted to VERIFIED during the browser adapter conversion. Fixed: verification status is now explicit.
- Guardian blast-radius classification was not receiving the active knowledge graph through Logic. Fixed.
- Runtime and browser-bridge knowledge stores could diverge. Fixed with runtime knowledge synchronization.
- Replanning after a HUMAN_APPROVAL_REQUIRED plan could invalidate the lifecycle state. Fixed by allowing proof states to retain verified action planning.
- Rebuilding the same plan during execution could invalidate the revision binding. Fixed with live-plan reuse and explicit action-plan revision binding.

## Validation
- JS syntax: PASS for all JS modules.
- Local dependency reference scan: no missing JS/HTML source references inside the package.
- V5.1 integration self-test: PASS.
- V5.1 deterministic execution self-test: PASS.
- V5.1 stale-source protection self-test: PASS.
- V5.1 snapshot-restore self-test: PASS.

Note: `cikurgoicon.png` is referenced by the existing HTML surfaces but is not part of this synchronization package. The production repository already contains that asset; keep it present when deploying these files.
