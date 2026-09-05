# CIKUR GO — BCGO + CGO BRAIN V5.3

Scope: BCGO and CGO brain only.

## Upgrades
- Preserved BCGO source-scan/file-nerve relation rendering.
- BCGO primary Internal AI loader now targets `cgo-runtime-adapter.js`.
- CGO runtime now exposes a BCGO-facing `install()` bridge with:
  - natural state-aware chat;
  - source-driven internal data query for `data-cgo.html`;
  - conversational context memory;
  - action planning contracts;
  - authorization/plan/execute hooks for the future Medicine → Executor chain.
- Internal data query is read-only and derives Firestore collection candidates from the actual `data-cgo.html` source. No collection name is invented.
- WRITE/PATCH/EXECUTE capability is represented in the brain/action contract; actual execution still requires a bound execution target and the runtime's proof/authorization gates.
- No external AI/API added.
- `cikur-config.js` and Firebase files/rules are excluded and untouched.
- Medicine and Executor files are excluded and untouched.

## Important validation note
`data-cgo.html` was not available in the local Library search during this build, so the runtime deliberately does not hard-code a customer collection. At runtime it reads `data-cgo.html` and discovers the collection literal(s) used by that file before querying.
