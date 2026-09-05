# CIKUR GO Internal AI V5.2.3 — Causal Investigation Loop

Focused brain patch. Does not modify BCGO UI, Medicine, Executor, or Firestore Rules.

## Changes
- CGO consumes multiple unresolved symbols from BCGO nerve evidence instead of only the first runtime symbol.
- Active probe queue now correctly advances through SYMBOL_CALLS -> SYMBOL_DEFINITIONS -> SYMBOL_IMPORTS_EXPORTS -> SCRIPT_LOADING -> RUNTIME_CONTEXT/HTML_STRUCTURE without repeating the same SCRIPT_LOADING probe.
- Causal module-boundary hypotheses are preferred over generic non-causal runtime-context hypotheses when evidence confidence is equal.
- BCGO source findings related to HTML/structure are represented as investigation hypotheses without being promoted to causal root cause until source probes validate them.
- Browser bridge now exposes the active step's actual case snapshot to the UI during async investigation, so progress is not hidden behind the old runtime snapshot.
- Progress events include selected hypothesis, score, causal flag, root-cause verification, and exact-source verification.
- No external AI/API. No source mutation. No automatic execution.

## Validation
- JS syntax: PASS
- Missing-symbol causal proof: PASS -> SOURCE_VERIFIED
- Module-boundary causal proof: PASS -> SOURCE_VERIFIED
- Multiple-symbol nerve input: PASS
