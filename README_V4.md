# CIKUR GO Internal AI — V4 Integration Candidate

This package is a controlled integration candidate, not a production claim.

## Live path
Firebase/Auth/Firestore -> cikur-config.js (context/infrastructure gate) -> bcgo.js (telemetry/state intake) -> Internal AI runtime -> bcgo.html (live observer/chat).

## What changed
- `cikur-config-v4.js`: exposes a frozen Internal AI context gate only. No reasoning engine is placed here.
- `bcgo-v4.js`: imports and installs the internal runtime adapter and feeds every BCGO state snapshot into it.
- `cikur-internal-ai-runtime-adapter-v2.js`: deterministic internal intelligence layer; builds live snapshots, signal/posture, guarded conversational answers, and live thought events.
- `bcgo-v4.html`: chat uses the internal runtime when available and displays live Internal AI status/thoughts.
- `cikur-internal-ai-core-v2.js` and `cikur-internal-ai-knowledge-v1.js`: foundation modules retained in the package.

## Safety boundaries
- No external AI/API is used as the brain.
- No automatic source patching.
- No automatic execution.
- Human approval remains required.
- Medicine remains the verification/investigation layer.
- Executor remains the deterministic execution gate.

## Important deployment note
Rename the `*-v4` files to the production filenames only after browser/runtime testing. Keep the originals in this package for rollback.
