# CIKUR GO Internal AI V5.2.4 — Active Causal Source Loop

## Perbaikan inti
1. BCGO source finding diprioritaskan sebelum probe simbol sekunder.
2. Anomali HTML `<div>` sekarang divalidasi langsung terhadap source aktual.
3. Hipotesis struktur HTML mengikat source snapshot + structure evidence sehingga causal gate dapat dibuktikan bila evidence memenuhi gate.
4. Exact-source binding tidak lagi hanya bergantung pada SYMBOL_CALL_SITE; HTML_DIV_BALANCE juga dapat menjadi source anchor.
5. `INVESTIGATION_BLOCKED` tidak lagi dianggap terminal oleh Active Investigation Engine. Engine terus mencari evidence sampai proof source tercapai atau budget probe habis.
6. Browser adapter dinaikkan ke bridge 1.4.0 dan active run budget menjadi 10 langkah.
7. `bcgo.js` dan `bcgo-medicine.js` diarahkan ke adapter cache `v=5.2.4`.

## Arsitektur tetap
- Otak: `cgo-ai-*` + Active Investigation Engine.
- Tidak memakai `cikur-internal-ai-runtime-adapter-v9.js`.
- Tidak ada external AI/API sebagai otak.
- Tidak ada source mutation oleh brain.
- Medicine tetap proof/repair authority dan human approval tetap berlaku.
