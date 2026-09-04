# CIKUR GO Internal AI V9 — Investigation Upgrade (Verified)

Tujuan V9: membuat Internal AI tidak berhenti pada telemetry → hypothesis, tetapi membangun investigation context berbasis source intelligence dan dependency evidence sebelum Medicine mengambil alih verifikasi.

## Production files (nama dipertahankan)
- `bcgo.js`
- `bcgo.html`
- `cikur-config.js`
- `cikur-internal-ai-core-v9.js`
- `cikur-internal-ai-knowledge-v6.js`
- `cikur-internal-ai-guardian-v4.js`
- `cikur-internal-ai-runtime-adapter-v9.js`

Semua file production berada di root ZIP agar mudah dipantau/upload sebagai satu paket.

## Upgrade inti
1. BCGO source scanner sekarang membuat `sourceIntelligence` ringkas: fungsi, call surface, local references, DOM handlers, source findings, dan symbol search.
2. Raw source tidak dimasukkan ke `BCGO_STATE`; hanya metadata/evidence terkontrol.
3. Internal AI dapat membedakan `SOURCE_DEFINITION`, `SOURCE_ABSENCE`, `SOURCE_CALL_SITE`, `DOM_HANDLER_REFERENCE`, `SOURCE_SYMBOL_HIT`, dan `SOURCE_REFERENCE`.
4. Undefined-symbol investigation sekarang menguji caller → provider/scope/loading, bukan hanya menyebut hipotesis.
5. Investigation plan memiliki required evidence dan explicit `doNotConclude`.
6. Causal links tetap `verified:false` sampai bukti eksplisit memadai.
7. Precision Gate tetap menahan root cause/exact source; Medicine tetap pemegang verifikasi.
8. Knowledge graph diperluas dengan file/function/symbol/reference nodes.
9. Guardian V4 memblokir kondisi ketika source scan selesai tetapi source intelligence hilang.
10. Chat BCGO menggunakan Internal AI runtime jika tersedia.
11. `bcgo.html` menampilkan status Internal AI, reasoning, dan investigation sebagai observer saja.

## Security boundary
- external AI/API: FALSE
- automatic patch: FALSE
- automatic execution: FALSE
- human approval: REQUIRED
- Medicine owns root-cause/exact-source verification
- Executor owns execution gate
- Internal AI read-only

## Flow
BCGO → Internal AI Investigation → Medicine Verification → Executor Review → Human Approval → Execution → Validation → BCGO
