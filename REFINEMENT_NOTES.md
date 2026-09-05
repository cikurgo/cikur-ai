# CIKUR GO Internal AI — Refined v2

Baseline: the 8 uploaded JavaScript modules supplied for the refinement pass.

## Corrections made
1. Fixed the `allowAutomaticExecution` boolean inversion across runtime/logic authorization flow.
   - `false` now means human approval is required.
   - `true`/undefined no longer bypasses the source-integrity gate.
2. Passed the Knowledge/System Graph into Guardian risk evaluation so dependency blast-radius risk is actually used.
3. Hardened `INSERT_EXACT` so an ambiguous anchor is rejected.
4. Hardened patch verification so INSERT/REPLACE verification compares the exact expected resulting source rather than merely checking that the proposed text exists somewhere.
5. Allowed telemetry/evidence sequence `0` as the first event by initializing an empty event ledger at `-1`.
6. Kept the internal-only architecture: no external AI/API was introduced, and the brain modules still do not directly mutate source.

## Intentionally unchanged
- Human approval remains required for HIGH/CRITICAL risk.
- Memory remains advisory and never proof.
- Medicine/brain reasoning does not directly write source; execution remains through the injected executor.
- No third-party AI/API was added.


## V3 Deep-Hardening Pass
- Runtime authorization now re-runs the complete Logic proof chain; truthy `rootCause`/`exactSource` objects can no longer bypass proof gates.
- Exact-source proof now requires at least one VERIFIED, exact/source-bound evidence item tied to the claimed file or source fingerprint.
- Authorization binding now includes case revision and a deterministic fingerprint of the proposed code, preventing post-authorization proposal mutation from being executed.
- Execution rejects stale revision/proposal mismatches before dispatch.
- Root-cause statements must be non-empty before verification.
- Invalid exact-source proof now fails closed into `SOURCE_NOT_VERIFIED` without crashing the state machine.
- No external AI/API introduced; the internal-only architecture and human-control boundaries remain intact.
- V3 security self-test passed: authorization bypass blocked, exact-source gate blocked, and ambiguous INSERT anchor blocked.


## V5 hardening
- Automatic execution is now explicit opt-in: `allowAutomaticExecution` must be exactly `true`; undefined is human approval, not permission.
- Removed the weaker existing-plan authorization path; plan reuse now depends on the full Logic proof chain.
- Plan cache binding now includes case revision and proposed-code fingerprint.
- Blocked authorizations cannot be consumed.
- Cognition reports `READY_FOR_ACTION_POLICY` only when the complete Logic proof chain is complete, preventing an earlier UI-level readiness signal from outrunning Guardian/Logic.
- Runtime `deliberate()` now supplies the actual Logic proof-complete result.

- Added explicit causal root-cause proof: a verified root cause must bind to an actual scored hypothesis (`hypothesisId`), meet score >= 0.60, use evidence belonging to that hypothesis, and have independent support (two source/type groups or two evidence items).
- Logic now exposes `causalRootVerified` separately from simple evidence binding.
- Snapshot restore validates the causal root-cause binding instead of trusting shape alone.

## V5.1 Production Synchronization Audit

Additional hardening performed after full cross-file audit:

1. Evidence status integrity: HIGH evidence strength no longer upgrades an evidence item to VERIFIED. Only explicit VERIFIED status is treated as verified proof.
2. Guardian graph binding: Logic now passes the active Knowledge Graph to Guardian so dependency blast radius can affect risk classification.
3. Runtime knowledge synchronization: browser bridge synchronizes its knowledge graph into the runtime.
4. Action-plan lifecycle: verified proof remains valid through CANDIDATE_READY / EXECUTOR_REVIEW / HUMAN_APPROVAL states.
5. Action-plan revision binding: the generated action plan records its post-transition revision, preventing false stale-proof rejection.
6. Plan reuse: a still-live authorization/plan is reused only when its decision, risk, proof fingerprints, file, operation and revision still match.
7. Runtime execution was tested for normal execution, validation, and stale-source rejection.
8. Snapshot restore was tested with an executable authorization and preserved revision binding.

Result: V5.1 integration, runtime execution, and snapshot restore self-tests PASS.
