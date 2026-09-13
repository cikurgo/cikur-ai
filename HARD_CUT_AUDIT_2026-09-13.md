# CIKUR GO — MEDICINE + EXECUTOR HARD CUT AUDIT — 2026-09-13

## Verdict
This milestone is a **real module rebuild**, not a cosmetic patch.

### Before
- `bcgo-medicine.js`: 3,648 lines / 153,653 bytes
- `bcgo-executor.js`: 1,197 lines / 49,464 bytes
- `bcgo-executor-core.js`: 291 lines / 8,159 bytes
- legacy bridge contracts and cyclic waiting existed.

### After
- `bcgo-medicine.js`: rebuilt as v4.0.0-MEDICINE-HARD-CUT
- `bcgo-executor.js`: rebuilt as v4.0.0-EXECUTOR-HARD-CUT
- `bcgo-executor-core.js`: rebuilt as v4.0.0-EXECUTION-CORE-HARD-CUT
- single active bridge: `CIKUR_GO_BCGO_CGO_BRIDGE_V1`

## Functional boundaries
1. BCGO/Captain starts the investigation.
2. Medicine investigates without waiting for Executor.
3. Medicine reads current same-origin source and binds evidence to a fingerprint.
4. Medicine only creates a repair candidate when a deterministic recipe exists.
5. Executor reviews the candidate without writing.
6. Human approval is owned by Captain.
7. Captain authorization is durable in `medicine_patch_requests/{requestId}`.
8. Executor verifies the durable authorization and source fingerprint again before write.
9. Actual source write requires a real local File System Access handle.
10. Read-back fingerprint is required before reporting execution success.

## Important production truth
GitHub Pages is a static deployment surface. A browser-side system cannot
silently rewrite the deployed repository without an authorized write service.
The rebuilt Executor therefore fails closed with `PRODUCTION_SOURCE_WRITE_TARGET_UNAVAILABLE`
when no real local file handle is bound. It does not convert IndexedDB persistence
into a false production deployment claim.

## Bridge correctness
- Medicine and Executor import the same `cgo-bcgo-bridge.js` revision.
- Both also open a direct same-origin BroadcastChannel for Captain/team packets.
- localStorage EVENT recovery is retained.
- Old `CIKUR_GO_BCGO_MEDICINE_V1` is not used by the rebuilt Medicine/Executor.
- All internal cache-buster revisions in the deployment were normalized to the
  hard-cut revision to avoid duplicate module instances.

## Static checks
- JS syntax: PASS for all deployment JS files.
- Required runtime files: PASS.
- Manifest: current 3.5.0 baseline retained and Stage 24 appended.
- No external AI provider/API introduced.
- No Firebase Function introduced.

## Deliberately NOT claimed
Production browser E2E against the live GitHub deployment has not been claimed
by static inspection alone. The final acceptance test must observe a real
BCGO_STATE -> Captain -> Medicine -> Executor review -> Human Gate path in the
browser, and any real write must use an authorized file handle.
