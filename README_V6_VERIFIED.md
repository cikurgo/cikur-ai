# V6 VERIFIED CHECK

Verified before packaging:
- Production filenames: `bcgo.js`, `bcgo.html`, `cikur-config.js`.
- All new JavaScript modules pass Node syntax parsing.
- `bcgo.js` imports the V4 runtime adapter with a cache-busting query string.
- Runtime adapter imports the V4 reasoning core, V3 knowledge core, and V1 guardian with matching root-relative paths.
- `cikur-config.js` contains exactly one Internal AI context declaration.
- Internal AI policy disables external AI, automatic patch, automatic source mutation, and automatic execution; human approval remains required.
- No known third-party AI provider names/endpoints are present in the V6 runtime files.
- Reasoning test: ReferenceError telemetry produced deduplicated evidence, multiple hypothesis classes, confidence ranking, and a blocked Precision Gate requiring Medicine/exact-source verification.
- Session-memory path is wired so repeated substantive hypotheses can be counted only when a new evidence fingerprint arrives; heartbeat cycles do not inflate memory/confidence or create thought spam. A repeated identical state therefore keeps the same confidence and emits no new thought.
- Guardian path is wired into every BCGO_STATE intake.
- Heartbeat/cycle changes do not by themselves create a new thought event.

This is an integration/test build and must be exercised in the live project before production adoption.
