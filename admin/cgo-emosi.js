/**
 * CGO Emosi — penentu emosi kontekstual (bukan API eksternal)
 */
(function (global) {
  "use strict";
  const VERSION = "1.0.0-EMOSI";

  function tentukanEmosi(konteks) {
    konteks = konteks || {};
    const text = String(konteks.text || konteks.question || "").toLowerCase();
    const answer = String(konteks.answer || "").toLowerCase();
    const live = konteks.liveState || (typeof global.BCGO_STATE !== "undefined" ? global.BCGO_STATE : {}) || {};

    // User emotion cues
    if (/\b(capek|lelah|nyesek|sedih|kecewa)\b/.test(text)) {
      return { emosi: "prihatin", intensitas: 0.7, alasan: "user terlihat lelah/sedih" };
    }
    if (/\b(senang|alhamdulillah|mantap|bagus|hebat|terima kasih|makasih)\b/.test(text)) {
      return { emosi: "senang", intensitas: 0.75, alasan: "user positif" };
    }
    if (/\b(kenapa|kok|bingung|gak ngerti|tidak mengerti)\b/.test(text)) {
      return { emosi: "netral", intensitas: 0.55, alasan: "butuh penjelasan sabar" };
    }

    // System cues
    const hasError = /\b(error|gagal|crash|rusak|fatal)\b/.test(text + " " + answer)
      || live.integrity === "FAIL" || live.step === "ERROR";
    const hasWarn = /\b(warning|degraded|anomali|perhatian)\b/.test(text + " " + answer)
      || /DEGRADED/i.test(String(live.scanStatus || live.integrity || ""));
    const healthy = /\b(aman|sehat|normal|bersih|clean|stabil)\b/.test(answer)
      || live.integrity === "PASS" || live.integrity === "OK";

    if (hasError) return { emosi: "khawatir", intensitas: 0.65, alasan: "ada indikasi error" };
    if (hasWarn) return { emosi: "tegas", intensitas: 0.6, alasan: "ada peringatan sistem" };
    if (healthy) return { emosi: "tenang", intensitas: 0.7, alasan: "sistem terlihat aman" };

    if (/\b(selesai|berhasil|valid|lulus)\b/.test(answer)) {
      return { emosi: "senang", intensitas: 0.7, alasan: "tugas selesai baik" };
    }

    return { emosi: "netral", intensitas: 0.5, alasan: "tidak ada konteks khusus" };
  }

  /** Warna tint untuk bubble */
  function tintFor(emosi) {
    switch (emosi) {
      case "senang": return { border: "#34d399", bg: "rgba(6,78,59,0.45)", avatar: "senang" };
      case "khawatir": return { border: "#fbbf24", bg: "rgba(120,53,15,0.35)", avatar: "khawatir" };
      case "tegas": return { border: "#f87171", bg: "rgba(127,29,29,0.4)", avatar: "tegas" };
      case "tenang": return { border: "#38bdf8", bg: "rgba(12,74,110,0.35)", avatar: "tenang" };
      case "prihatin": return { border: "#c084fc", bg: "rgba(88,28,135,0.3)", avatar: "prihatin" };
      default: return { border: "#1e293b", bg: "rgba(15,23,42,0.9)", avatar: "netral" };
    }
  }

  /** TTS voice params */
  function voiceFor(emosi) {
    switch (emosi) {
      case "senang": return { rate: 1.0, pitch: 1.12 };
      case "khawatir": return { rate: 0.9, pitch: 0.95 };
      case "tegas": return { rate: 0.95, pitch: 1.0 };
      case "tenang": return { rate: 0.92, pitch: 1.02 };
      case "prihatin": return { rate: 0.9, pitch: 0.98 };
      default: return { rate: 0.94, pitch: 1.06 };
    }
  }

  /** Prefiks empati singkat (opsional, tidak mengganti jawaban Otak) */
  function prefiksEmosi(emosi, intensitas) {
    if (intensitas < 0.55) return "";
    switch (emosi) {
      case "senang": return "";
      case "khawatir": return "Aduh, ";
      case "tegas": return "";
      case "tenang": return "";
      case "prihatin": return "Saya mengerti. ";
      default: return "";
    }
  }

  global.CGOEmosi = Object.freeze({
    version: VERSION,
    tentukanEmosi: tentukanEmosi,
    tintFor: tintFor,
    voiceFor: voiceFor,
    prefiksEmosi: prefiksEmosi
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
