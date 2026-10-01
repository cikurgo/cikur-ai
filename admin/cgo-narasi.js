/**
 * CGO Narasi — ubah laporan kaku menjadi cerita singkat
 * Tidak mengubah fakta; hanya gaya bahasa.
 */
(function (global) {
  "use strict";
  const VERSION = "1.0.0-NARASI";

  function isReportStyle(text) {
    const t = String(text || "");
    if (t.length < 40) return false;
    // pola laporan: banyak titik dua / bullet teknis
    const colons = (t.match(/:/g) || []).length;
    const tech = /\b(status|scanner|relasi|integrity|cycle|telemetry|file)\b/i.test(t);
    return colons >= 2 && tech;
  }

  // Ganti dengan teks tetap, tapi huruf pertama dikapitalkan bila jatuh di awal kalimat.
  function sentenceAware(txt) {
    return function (m, offset, str) {
      var before = String(str).slice(0, offset);
      var atStart = /(^|[.!?]\s+)$/.test(before);
      return atStart ? txt.charAt(0).toUpperCase() + txt.slice(1) : txt;
    };
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
      [/Scanner:\s*status\s*CLEAN[^.]*\./i, "Saya cek scanner — semuanya bersih."],
      [/terbaca\s+(\d+)\/(\d+)/i, "terbaca $1 dari $2 file"],
      [/gagal\s+0/i, "tanpa kegagalan"],
      [/Relasi\s*linked\s*(\d+)/i, "$1 relasi saling terhubung"],
      [/Sistem stabil,?\s*tidak ada anomali aktif\.?/i, "Sistem sedang stabil, tidak ada anomali aktif."],
      // "Tahap X" di AWAL kalimat tetap kapital ("Di tahap X"); di tengah kalimat jadi "di tahap X".
      // "tahap X": awal kalimat -> "Di tahap X"; tengah kalimat -> "di tahap X"; sudah didahului "di" -> biarkan.
      [/(^|[.!?]\s+|\bdi\s+)?tahap\s+(\w+)/gi, function (m, pre, name, offset) {
        pre = pre == null ? null : pre;
        if (pre && /^\s*di\s+$/i.test(pre)) return m;
        if (pre !== null && (pre === "" || /[.!?]\s+$/.test(pre))) return pre + "Di tahap " + name;
        return "di tahap " + name;
      }],
      [/scanner\s+DEGRADED/i, "scanner masih perlu perhatian (DEGRADED)"],
      [/Integrity:\s*PASS/i, sentenceAware("integritas aman")],
      [/Integrity:\s*FAIL/i, sentenceAware("integritas bermasalah")]
    ];
    for (let i = 0; i < reps.length; i++) {
      try { t = t.replace(reps[i][0], reps[i][1]); } catch (_) {}
    }

    // Metafora ringan bila masih sangat teknis
    if (/\bembedding\b/i.test(t)) {
      t = t.replace(/\bembedding\b/gi, "koordinat makna");
    }
    if (/\bcycle\b/i.test(t) && !/siklus/.test(t)) {
      t = t.replace(/\bcycle\b/gi, "siklus");
    }

    // Struktur: jangan memanjangkan jawaban singkat
    if (konteks.short || t.split(/\s+/).length < 18) return t;

    // (Prefix pembuka laporan dihapus — jawaban langsung ke inti.)

    return t.replace(/\s{2,}/g, " ").trim();
  }

  global.CGONarasi = Object.freeze({
    version: VERSION,
    narrate: narrate,
    isReportStyle: isReportStyle
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
