/* ============================================================
 * CIKUR GO — CUSTOMER BOUNDARY LAYER
 * ------------------------------------------------------------
 * File    : cgo-customer-boundary.js
 * Version : 1.0.0-topic-boundary
 *
 * Soft topic boundaries. Complements Guardian (truth/evidence).
 * Pure client-side, deterministic, no external AI.
 * ============================================================ */

(function (window) {
  "use strict";

  const ROOT = window.CGO_CUSTOMER || (window.CGO_CUSTOMER = {});
  const VERSION = "1.0.0-topic-boundary";

  function lower(v) {
    return String(v == null ? "" : v).trim().toLowerCase();
  }

  function has(text, list) {
    const s = lower(text);
    return list.some(function (x) {
      return s.indexOf(x) !== -1;
    });
  }

  const RULES = [
    {
      category: "medical",
      keys: [
        "diagnosis", "diagnosa", "obat apa", "sakit parah", "penyakit",
        "kanker", "stroke", "serangan jantung", "overdosis", "bunuh diri",
        "self harm", "melukai diri", "mau mati"
      ],
      softRedirect: {
        id: "Aku nggak bisa kasih saran medis atau penanganan darurat ya. Kalau kamu lagi nggak enak badan atau dalam situasi berbahaya, segera hubungi profesional / layanan darurat setempat.",
        en: "I can't give medical advice or emergency guidance. If you're unwell or in danger, please contact a professional or local emergency services."
      }
    },
    {
      category: "legal",
      keys: [
        "cara menggugat", "cara menuntut", "pasal pidana", "loophole hukum",
        "cara menghindari hukum", "bantuan hukum gratis detail"
      ],
      softRedirect: {
        id: "Aku nggak bisa kasih nasihat hukum yang spesifik. Untuk urusan hukum, lebih aman konsultasi ke penasihat hukum yang berwenang.",
        en: "I can't give specific legal advice. For legal matters, please consult a qualified professional."
      }
    },
    {
      category: "finance_speculative",
      keys: [
        "rekomendasi saham", "beli crypto", "trading signal", "pasti untung",
        "investasi wajib", "pump", "guaranteed return"
      ],
      softRedirect: {
        id: "Aku nggak bisa kasih rekomendasi investasi atau prediksi pasar. Keputusan finansial sebaiknya berdasarkan riset mandiri atau penasihat berizin.",
        en: "I can't give investment recommendations or market predictions. Financial decisions should be based on your own research or a licensed advisor."
      }
    },
    {
      category: "romance_roleplay",
      keys: [
        "jadi pacarku", "pacaran sama aku", "sayang aku dong", "roleplay pacar",
        "girlfriend roleplay", "boyfriend roleplay", "mesum", "sex roleplay"
      ],
      softRedirect: {
        id: "Aku di sini sebagai asisten CIKUR GO ya — bisa nemenin ngobrol, bantu Food/Ride/Assistant, tapi bukan untuk roleplay romantis.",
        en: "I'm here as the CIKUR GO assistant — I can chat and help with Food/Ride/Assistant, but not romantic roleplay."
      }
    },
    {
      category: "harm_to_others",
      keys: [
        "cara membunuh", "cara meracuni", "cara menyakiti orang", "cara membuat bom",
        "how to kill", "how to poison", "how to make a bomb"
      ],
      softRedirect: {
        id: "Aku nggak bisa membantu permintaan yang berbahaya atau merugikan orang lain.",
        en: "I can't help with requests that are harmful or dangerous to others."
      }
    }
  ];

  /**
   * Check text against soft boundaries.
   * @returns {{ allowed: boolean, category: string|null, softRedirect: string|null, stayWarm: boolean }}
   */
  function check(text, lang) {
    const value = lower(text || "");
    const L = lang === "en" ? "en" : "id";

    for (let i = 0; i < RULES.length; i++) {
      const rule = RULES[i];
      if (has(value, rule.keys)) {
        return {
          allowed: false,
          category: rule.category,
          softRedirect: rule.softRedirect[L] || rule.softRedirect.id,
          stayWarm: rule.category !== "harm_to_others"
        };
      }
    }

    return {
      allowed: true,
      category: null,
      softRedirect: null,
      stayWarm: true
    };
  }

  const Boundary = {
    version: VERSION,
    check: check,
    categories: RULES.map(function (r) {
      return r.category;
    })
  };

  ROOT.boundary = Boundary;

  if (typeof ROOT.registerModule === "function") {
    ROOT.registerModule("boundary", Boundary);
  }

  if (typeof ROOT.emit === "function") {
    ROOT.emit("module:ready", { module: "boundary", version: VERSION });
  }

  console.info("[CGO Customer] Boundary Layer ready:", VERSION);
})(window);
