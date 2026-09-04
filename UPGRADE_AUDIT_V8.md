# UPGRADE AUDIT V8.1

## Findings fixed from V7 observation

### A. Thought spam
V7 could emit a new thought whenever evidence counts/independent counts changed during source-scan progression. V8 separates `reasoningKey` from `thoughtKey`, uses confidence bands, causal signature, blocker signature, guardian level, and a 12-second thought cooldown. Evidence-count growth alone is not a chat trigger.

### B. Guardian presentation
Guardian V2 used `level: NONE` for a healthy state. This was semantically correct but visually ambiguous. V8 adds `status: GUARDIAN_OK` and the UI renders `GUARD OK`.

### C. Causal trace overreach
V7 could attach a potential-cause link to every supported evidence file. V8 requires either explicit cross-file evidence with a target or multiple evidence files sharing a runtime target. All causal links remain unverified.

### D. Evidence inflation
V8 fingerprints evidence using stable semantic fields and excludes cycle/heartbeat identity. Identical telemetry therefore cannot become independent evidence merely because it arrived again.

### E. Security boundary
Guardian V3 explicitly verifies that the runtime API does not expose patch/execute/deploy/commit/source-mutation capabilities and verifies the required Medicine/Executor/Human gates.

## Runtime test summary
- Initial state: 3 unique evidence items.
- Identical state at next cycle: still 3 unique evidence items.
- Thought events: 1 total across initial + identical heartbeat + substantive evidence change.
- Reasoning events: 2, reflecting substantive reasoning changes.
- Guardian: `GUARDIAN_OK`.
- Precision Gate on active case: `BLOCKED` with root-cause/exact-source verification blockers.


## V8.1 runtime synchronization hardening

- `bcgo.js` now sends every authoritative `system_logs` snapshot through the Internal AI intake, including snapshots where the top log did not change.
- Internal AI evidence fingerprinting remains responsible for deduplication, so listener refreshes do not inflate evidence.
- `bcgo.html` cache-bust was advanced to `8.1.0` so GitHub Pages is less likely to serve the previous `bcgo.js`.
