/* ============================================================
 * CIKUR GO — CUSTOMER ↔ CIKURGO BRAIN BRIDGE
 * ------------------------------------------------------------
 * File    : cgo-customer-cikur-bridge.js
 * Version : 1.0.0-optional-brain-bridge
 *
 * Aditif & anti-regresi:
 * - Jika window.CIKURGO (cikur-go.browser.js) belum load → no-op aman
 * - Tidak mengganti Guardian / Discovery / Knowledge
 * - Hanya memperkaya pemahaman teks (nalar + urai)
 * - Tidak boleh mengklaim ketersediaan / harga live
 * ============================================================ */
(function (window) {
  "use strict";

  const ROOT = window.CGO_CUSTOMER || (window.CGO_CUSTOMER = {});
  const VERSION = "1.0.0-optional-brain-bridge";

  function getBrain() {
    const b = window.CIKURGO || window.CIKURGO_V3 || null;
    if (!b) return null;
    // Instance methods or static exports
    if (typeof b.nalar === "function") return b;
    if (b.cikur && typeof b.cikur.nalar === "function") return b.cikur;
    // Namespace object from browser build
    if (typeof b === "object" && typeof window.nalar === "function") {
      return {
        nalar: window.nalar,
        urai: window.urai,
        angkaKeKata: window.angkaKeKata
      };
    }
    return b;
  }

  function isAvailable() {
    const brain = getBrain();
    return !!(brain && typeof brain.nalar === "function");
  }

  /**
   * Enrich understanding of user text via CIKURGO.nalar.
   * Returns null if brain missing or fails — caller must continue.
   */
  function enrich(text, options) {
    options = options || {};
    const brain = getBrain();
    if (!brain || typeof brain.nalar !== "function") {
      return null;
    }

    const lang = options.lang === "en" ? "en" : "id";
    const raw = String(text == null ? "" : text).trim();
    if (!raw) return null;

    try {
      const insight = brain.nalar(raw, {
        bahasa: lang,
        konteks: options.konteks || null
      });

      if (!insight || typeof insight !== "object") return null;

      // Optional: urai for mixed tokens (numbers, dates) — never required
      let uraiHasil = null;
      if (typeof brain.urai === "function") {
        try {
          uraiHasil = brain.urai(raw, "auto", true, lang);
        } catch (_) {
          uraiHasil = null;
        }
      }

      return {
        source: "CIKURGO",
        version: VERSION,
        brainVersion: brain.VERSION || brain.version || null,
        kesimpulan: insight.kesimpulan || insight.hasil || null,
        hasil: insight.hasil || insight.kesimpulan || null,
        alasan: Array.isArray(insight.alasan) ? insight.alasan.slice(0, 8) : [],
        keyakinan:
          typeof insight.keyakinan === "number"
            ? insight.keyakinan
            : null,
        alternatif: Array.isArray(insight.alternatif)
          ? insight.alternatif.slice(0, 4)
          : [],
        catatan: insight.catatan || null,
        urai: uraiHasil
      };
    } catch (err) {
      if (options.debug) {
        console.warn("[CGO CIKUR Bridge] nalar error:", err);
      }
      return null;
    }
  }

  /**
   * Soft natural line from nalar insight — never claims runtime facts.
   */
  function insightToHint(insight, lang) {
    if (!insight) return null;
    const L = lang === "en" ? "en" : "id";
    const conf =
      typeof insight.keyakinan === "number" ? insight.keyakinan : 0;

    // Only surface when reasonably confident
    if (conf > 0 && conf < 0.35) return null;

    const k = String(insight.kesimpulan || insight.hasil || "").trim();
    if (!k || k.length < 4) return null;

    // Reject if looks like availability/price invention patterns
    const lower = k.toLowerCase();
    if (
      /tersedia sekarang|agent tersedia|driver tersedia|pasti ada|rp\s*\d|harga\s*\d/i.test(
        lower
      )
    ) {
      return null;
    }

    if (L === "en") {
      return conf >= 0.6
        ? "From what I can reason: " + k
        : null;
    }
    return conf >= 0.6 ? "Dari penalaran: " + k : null;
  }

  const Bridge = {
    version: VERSION,
    isAvailable: isAvailable,
    enrich: enrich,
    insightToHint: insightToHint,
    getBrain: getBrain
  };

  ROOT.cikurBridge = Bridge;

  if (typeof ROOT.registerModule === "function") {
    ROOT.registerModule("cikurBridge", Bridge);
  }

  if (typeof ROOT.emit === "function") {
    ROOT.emit("module:ready", { module: "cikurBridge", version: VERSION });
  }

  console.info(
    "[CGO Customer] CIKUR Bridge ready:",
    VERSION,
    isAvailable() ? "· brain linked" : "· brain offline (optional)"
  );
})(window);
