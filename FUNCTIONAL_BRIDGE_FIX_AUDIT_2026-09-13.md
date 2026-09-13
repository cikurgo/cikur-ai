# CIKUR GO — BCGO ↔ CGO ↔ MEDICINE ↔ EXECUTOR FUNCTIONAL BRIDGE FIX — 2026-09-13

## Why this milestone exists
Live screenshots showed both Medicine and Executor could remain in `WAITING` even while BCGO had already completed a source scan. The issue was not cosmetic: downstream pages could miss the already-published BCGO state because of page boot order, and a single localStorage EVENT slot could overwrite the only Medicine/Candidate packet before the downstream page joined.

## Concrete fixes
1. `cgo-bcgo-bridge.js`
   - Keeps the authoritative `CIKUR_GO_BCGO_CGO_BRIDGE_V1` channel.
   - Persists latest `BCGO_STATE`.
   - Adds bounded durable team history (`*_TEAM_LOG`) for Medicine/Executor packets.
   - `onState()` replays the latest recovered state after listener registration.
   - `onTeamReport()` replays recent team packets after listener registration.
   - Recovery is read-only and bounded to recent packets.

2. `bcgo-medicine.js`
   - Hydrates recovered BCGO_STATE immediately.
   - Investigates cases after Admin authorization even when the recovered revision did not change.
   - Uses the authoritative durable team transport.
   - Normalizes deterministic exact-source simulation escaping.
   - Exposes a real diagnostic command handler.

3. `bcgo-executor.js`
   - Hydrates recovered BCGO_STATE immediately.
   - Uses the authoritative durable team transport.
   - Continues to fail closed without a real internal write target.

4. `bcgo-medicine.html`
   - Diagnostic command now calls Medicine's actual command handler rather than performing a no-op refresh.

5. Cache-busters
   - BCGO, Captain, Browser Adapter, Medicine, and Executor now reference the same bridge revision `20260913-me6`.

## Expected live behavior
When BCGO has already published a complete scan:
`Medicine opened later -> BCGO LIVE / scan state recovered -> cases hydrated -> investigation can start after Admin authorization.`

`Executor opened later -> BCGO nerve LIVE -> recent Medicine investigation/candidate can be replayed -> deterministic review can continue.`

## Safety
- No external AI/API introduced.
- No Firebase Function introduced.
- Medicine never writes source.
- Executor never reports SUCCESS without a real internal write target and readback.
- Human approval remains mandatory before execution.

## Validation
- All deployment JavaScript files: `node --check` PASS.
- Old `CIKUR_GO_BCGO_MEDICINE_V1` sweep across Medicine/Executor/bridge: no active reference found.
- Bridge recovery harness: latest BCGO cycle recovered and recent Medicine candidate replayed exactly once.
- Current full `INTEGRATION-MANIFEST.txt` retained and appended with Stage 25; not replaced by a shortened manifest.

## Not claimed
Production browser E2E on GitHub Pages is still an external deployment acceptance test. This package removes the identified boot-order/transport defects and provides deterministic local validation, but it does not fabricate production execution success.
