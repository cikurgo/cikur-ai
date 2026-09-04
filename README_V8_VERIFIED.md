# CIKUR GO Internal AI V8.1 — Verified

## Tujuan
V8.1 memperkuat Internal Intelligence CIKUR GO agar reasoning lebih disiplin, tidak menganggap heartbeat/scanner progress sebagai bukti baru, dan menjaga batas keamanan internal.

## Production files
- `bcgo.js`
- `bcgo.html`
- `cikur-config.js`
- `cikur-internal-ai-core-v6.js`
- `cikur-internal-ai-knowledge-v5.js`
- `cikur-internal-ai-guardian-v3.js`
- `cikur-internal-ai-runtime-adapter-v6.js`

## Perbaikan utama
1. Evidence fingerprint stabil: timestamp/cycle tidak membuat bukti identik menjadi bukti independen baru.
2. Heartbeat != evidence baru.
3. Reasoning update dipisahkan dari thought/chat update.
4. Thought hanya dipublikasikan ketika perubahan reasoning substantif terdeteksi dan memiliki cooldown.
5. Confidence tidak dinaikkan hanya karena pengulangan cycle.
6. Causal trace lebih konservatif: hubungan hanya dibuat dari explicit cross-file evidence atau kombinasi evidence yang berbagi target runtime; tetap `verified:false` sampai dibuktikan.
7. Contradictory evidence tetap memblokir Precision Gate.
8. Guardian memeriksa schema, policy, capability boundary, metric consistency, offline/Firestore condition, dan version drift.
9. UI menampilkan `GUARD OK` ketika guardian sehat; `NONE` tidak lagi terlihat seperti guardian tidak aktif.
10. Cache-busting `bcgo.html` dinaikkan ke `bcgo.js?v=8.0.0`.

## Boundary
Internal AI bersifat read-only. Tidak memiliki patch, execute, deploy, commit, source mutation, atau external AI capability. Medicine tetap memverifikasi root cause/exact source; Executor tetap execution gate; human approval tetap wajib.

## Backup
`BACKUP_ORIGINAL/` berisi baseline `bcgo.js`, `bcgo.html`, dan `cikur-config.js` sebelum V8.1.
