# CIKUR GO Internal AI — Master Runtime V5.2.5

## Deployment entrypoint
`cikur-internal-ai-runtime-adapter-v9.js`

The filename is retained as the requested upload/deployment entrypoint. It is a **master gateway**, not the legacy V9 brain.

## Active brain
The gateway exposes the current `cgo-ai-*` brain as namespaces:
- Core
- Logic
- Cognition
- Investigator
- Investigation Engine
- Knowledge
- Guardian
- Memory
- Runtime Adapter
- Browser Bridge

BCGO and Medicine now import the gateway instead of importing `cgo-ai-browser-adapter.js` directly.

## Safety boundaries
- External AI/API: disabled
- Automatic source mutation: disabled
- Human approval for execution: required
- Source-bound proof: required
- Causal verification: required
- Stale-state protection: retained

## Important
The original legacy V9 source file was not present in the working filesystem/package used for this build. Therefore this file does **not** pretend to contain unknown legacy V9 implementation. It uses the requested filename as a stable gateway around the verified current `cgo-ai-*` architecture.
