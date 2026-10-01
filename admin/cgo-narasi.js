/**
 * CGO Narasi — ubah laporan kaku menjadi cerita singkat
 * Tidak mengubah fakta; hanya gaya bahasa.
 */
(function (global) {
  "use strict";
  const VERSION = "1.1.0-NARASI";

  function isReportStyle(text) {
    const t = String(text || "");
    if (t.length < 40) return false;
    // pola laporan: banyak titik dua / bullet teknis
    const colons = (t.match(/:/g) || []).length;
    const tech = /\b(status|scanner|relasi|integrity|cycle|telemetry|file)\b/i.test(t);
    return colons >= 2 && tech;
  }

  function narrate(text, konteks) {
    let t = String(text || "").trim();
    if (!t) return t;
    konteks = konteks || {};

    // Jangan rusak jawaban hitung/eja/emoji pendek
    if (t.length < 50 && !isReportStyle(t)) return t;
    if (/^\d+\s*(→|dibaca|=)/.test(t)) return t;
    if (/Ejaan:/.test(t)) return t;

    // Ganti frasa laporan → narasi
    const reps = [
      // Semua transformasi di bawah hanya mengubah bentuk kalimat,
      // bukan status, angka, sumber, atau tingkat kepastian.
      [/Scanner:\s*status\s*(CLEAN|DEGRADED|FAIL|ERROR)\b/ig, "Scanner: status $1"],
      [/terbaca\s+(\d+)\/(\d+)/i, "terbaca $1 dari $2 file"],
      [/gagal\s+(\d+)/i, "gagal $1"],
      [/Relasi\s*linked\s*(\d+)/i, "$1 relasi saling terhubung"],
      [/Sistem stabil,?\s*tidak ada anomali aktif\.?/i, "Sistem sedang stabil, tidak ada anomali aktif."],
      [/Tahap\s+(\w+)/i, "di tahap $1"],
      [/scanner\s+DEGRADED/ig, "scanner masih berstatus DEGRADED"],
      [/Integrity:\s*PASS/ig, "Integrity: PASS"],
      [/Integrity:\s*FAIL/ig, "Integrity: FAIL"]
    ];
    for (let i = 0; i < reps.length; i++) {
      try { t = t.replace(reps[i][0], reps[i][1]); } catch (_) {}
    }

    // Metafora ringan bila masih sangat teknis
    if (/\bembedding\b/i.test(t)) {
      // Istilah teknis dipertahankan; narasi tidak boleh mengubah makna teknis.
      t = t.replace(/\bembedding\b/gi, "embedding");
    }
    if (/\bcycle\b/i.test(t) && !/siklus/.test(t)) {
      t = t.replace(/\bcycle\b/gi, "siklus");
    }

    // Struktur: jangan memanjangkan jawaban singkat
    if (konteks.short || t.split(/\s+/).length < 18) return t;

    // Hook ringan hanya untuk laporan panjang
    if (isReportStyle(text) && !/^(Tadi|Saya|Alhamdulillah|Aduh)/i.test(t)) {
      t = "Tadi saya lihat: " + t.charAt(0).toLowerCase() + t.slice(1);
    }

    return t.replace(/\s{2,}/g, " ").trim();
  }

  global.CGONarasi = Object.freeze({
    version: VERSION,
    narrate: narrate,
    isReportStyle: isReportStyle
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
