# CIKUR GO Internal AI V5.2 — ACTIVE INVESTIGATION BRAIN

## Purpose
This pass converts the internal CGO brain from a probe-planning/evaluation layer into an active, evidence-driven investigation loop.

## Core change
Added `cgo-ai-investigation-engine.js`.

The engine can now, through an injected same-origin internal probe provider:
- read the real deployed source;
- search symbol call sites;
- search symbol definitions;
- inspect import/export relationships;
- inspect HTML script loading/module context;
- inspect basic HTML structural integrity;
- inspect registered dependency-graph relations;
- record every probe as explicit evidence with provenance;
- build competing hypotheses from collected evidence;
- re-evaluate after each probe;
- attempt causal root-cause proof only after required evidence exists;
- bind an exact source segment to the current source fingerprint;
- stop only at a proof state or an investigation yield/block state.

## Safety
- No external AI/API was introduced.
- The active engine never writes repository source.
- Source is read through the existing deployment origin only.
- Raw BCGO runtime telemetry is observational and does not permanently block a later proof chain.
- Exact source is bound to the current source fingerprint.
- Human approval and Guardian/Executor gates remain unchanged.

## Browser integration
`cgo-ai-browser-adapter.js` now:
- keeps a persistent active investigation engine per case;
- runs bounded asynchronous internal probe cycles after BCGO intake;
- synchronizes newly produced evidence back into the authoritative runtime;
- synchronizes hypotheses/root-cause/source proof through the runtime gates;
- dispatches `cikur-internal-ai-investigation` progress events;
- updates the existing `cikur-internal-ai-state` snapshot after asynchronous progress.

`bcgo.js` now listens for asynchronous internal-AI state updates and republishes the updated brain state to the BCGO UI and Medicine bridge without requiring a page refresh.

## Causal hardening
A generic "definition exists" observation is not treated as a root cause by itself. The current module-boundary proof path requires:
- a runtime/HTML handler reference;
- a verified definition in the referenced module;
- a verified `<script type="module">` loading context for that provider.

A missing-symbol path requires both a verified call-site and a verified absence across the scanned source surface.

## Validation
- All JS syntax checks: PASS.
- Undefined-symbol active investigation self-test: PASS.
- Module-boundary causal gate self-test: PASS.
- Classic/global definition negative causal gate self-test: PASS.
- No automatic patch/execution was introduced.

## Deployment note
Keep the existing production asset `cikurgoicon.png` and the existing Firebase configuration/permissions unchanged. This package focuses on the CGO brain and its browser synchronization bridge.


## Pre-test audit hardening — 2026-09-05
- Fixed symbol-call classification so function/method declarations are not falsely recorded as runtime call sites.
- Missing-symbol absence proof is now allowed only when the source surface is explicitly complete; partial scans cannot be described as whole-surface absence.
- Added investigation-generation invalidation: new case revisions no longer reuse stale probe caches.
- Added stale-run protection: if telemetry/evidence changes while a probe run is active, the stale result is dropped and a fresh investigation generation is scheduled.
- Root-cause verification now binds the statement and hypothesis score to the actual selected hypothesis. Invalid re-verification is non-destructive when a valid proof already exists.
- Guardian/Logic/Core action gates now require a concrete non-empty proposed solution before any execution authorization/action can be produced. Root-cause/source proof remains distinct from solution readiness.
- Cache-busting versions were advanced for the updated browser bridge (`5.2.2`) and BCGO bridge asset (`2.15.2` in the page import must be applied in the production `bcgo.html`).
- Validation after hardening: all JS syntax checks pass; active missing-symbol, module-boundary, incomplete-surface, negative-global, candidate-gate, and deterministic execution tests pass.


## V5.2.2 MEDICINE LOADING HARDENING — 2026-09-05

- Removed volatile `completedAt` from the BCGO source-scan deduplication token.
- Prevented unchanged scan heartbeats from triggering a full source re-download.
- Reused verified live-surface source records when the BCGO-reported source hash is unchanged.
- Changed Medicine runtime version to `3.4.1` to match the cache-busted HTML import.
- No external AI/API was added. No source mutation behavior was added.

### Reason
The previous live-surface path could treat every BCGO scan heartbeat as a new scan because `completedAt` was part of the token. `ingestBCGOScan()` then forced `fetch(..., cache: "no-store")` for every diagnostic file. On a mobile connection this could repeatedly download and re-parse the whole source surface, causing heavy loading and making Medicine appear stuck/not opening.

The hardened path only re-fetches a file when its reported source hash changes or no verified previous record exists.
