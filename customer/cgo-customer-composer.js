/* ============================================================
 * CIKUR GO — CUSTOMER COMPOSER
 * ------------------------------------------------------------
 * File    : cgo-customer-composer.js
 * Version : 1.0.0-response-composer
 *
 * Single place that assembles the final natural-language reply.
 * Deterministic, pure client-side, no external AI.
 * Personality never overrides truth.
 * ============================================================ */

(function (window) {
  "use strict";

  const ROOT = window.CGO_CUSTOMER || (window.CGO_CUSTOMER = {});
  const VERSION = "1.0.0-response-composer";

  function lower(v) {
    return String(v == null ? "" : v).trim().toLowerCase();
  }

  function clean(v) {
    return String(v == null ? "" : v).replace(/\s+/g, " ").trim();
  }

  function constraintLabel(c, lang) {
    if (!c) return "";
    const parts = [];
    if (lang === "en") {
      if (c.budgetMax) parts.push("budget under " + c.budgetMax);
      if (c.timeHint) {
        if (c.timeHint.type === "clock") {
          parts.push("around " + c.timeHint.hour + ":00");
        } else if (c.timeHint.tag) {
          parts.push(String(c.timeHint.tag).replace(/_/g, " "));
        }
      }
      if (c.locationHint) parts.push("near " + c.locationHint);
      if (c.nearMe) parts.push("nearby");
      if (c.simplicity) parts.push("simple");
      if (c.speed) parts.push("fast");
    } else {
      if (c.budgetMax) parts.push("budget di bawah " + c.budgetMax);
      if (c.timeHint) {
        if (c.timeHint.type === "clock") {
          parts.push("sekitar jam " + c.timeHint.hour);
        } else if (c.timeHint.tag) {
          const map = {
            tonight: "malam ini",
            afternoon: "siang ini",
            evening: "sore ini",
            tomorrow_morning: "besok pagi",
            tomorrow: "besok",
            today: "hari ini",
            now: "sekarang",
            weekend: "weekend"
          };
          parts.push(map[c.timeHint.tag] || c.timeHint.tag);
        }
      }
      if (c.locationHint) parts.push("dekat " + c.locationHint);
      if (c.nearMe) parts.push("dekat sini");
      if (c.simplicity) parts.push("yang simpel");
      if (c.speed) parts.push("yang cepat");
    }
    return parts.join(", ");
  }

  function emotionOpen(emotion, strength, lang) {
    const e = lower(emotion || "");
    const strong = strength === "strong";
    if (!e || e === "neutral" || e === "casual") return "";

    if (lang === "en") {
      if (e === "tired") return strong ? "You sound really tired. " : "You seem a bit tired. ";
      if (e === "stressed") return "I can tell things feel heavy right now. ";
      if (e === "sad") return "I'm here with you. ";
      if (e === "lonely") return "You're not alone in this. ";
      if (e === "hurried") return "Got it — keeping it brief. ";
      if (e === "worried") return "No rush. ";
      if (e === "confused") return "We'll take it step by step. ";
      if (e === "disappointed") return "I hear the disappointment. ";
      if (e === "happy") return "Glad to hear that. ";
      if (e === "excited") return "Love the energy. ";
      return "";
    }

    if (e === "tired") return strong ? "Kamu kelihatan lagi capek banget. " : "Kamu kelihatan lagi capek. ";
    if (e === "stressed") return "Aku tangkap kamu lagi stres. ";
    if (e === "sad") return "Aku di sini ya. ";
    if (e === "lonely") return "Kamu nggak sendirian kok. ";
    if (e === "hurried") return "Oke, aku singkat aja. ";
    if (e === "worried") return "Nggak usah buru-buru. ";
    if (e === "confused") return "Kita pelan-pelan aja. ";
    if (e === "disappointed") return "Aku ngerti kamu kecewa. ";
    if (e === "happy") return "Seneng denger itu. ";
    if (e === "excited") return "Semangatnya kelihatan. ";
    return "";
  }

  function honestyLine(lang) {
    return lang === "en"
      ? "I still won't invent live listings, prices, or availability — only verified data when it exists."
      : "Aku tetap nggak mengarang daftar live, harga, atau ketersediaan — hanya data terverifikasi kalau sudah ada.";
  }

  /**
   * Compose final text from plan + meta + boundary + optional base text.
   *
   * @param {object} opts
   * @param {object|null} opts.plan
   * @param {object|null} opts.meta
   * @param {object|null} opts.boundary
   * @param {string|null} opts.baseText   text already produced by reasoning/conversation
   * @param {string} opts.lang
   */
  function compose(opts) {
    opts = opts || {};
    const plan = opts.plan || null;
    const meta = opts.meta || null;
    const boundary = opts.boundary || null;
    const baseText = clean(opts.baseText || "");
    const lang = opts.lang === "en" ? "en" : (plan && plan.lang) || "id";

    // Boundary takes priority
    if (boundary && boundary.allowed === false && boundary.softRedirect) {
      return {
        text: boundary.softRedirect,
        mode: "boundary_redirect",
        composed: true
      };
    }

    // Meta: pure companion mode
    if (meta && meta.action === "companion") {
      const open = emotionOpen(plan && plan.emotion, plan && plan.emotionStrength, lang);
      const body =
        lang === "en"
          ? "I'm here. You can share what's on your mind — no need to rush."
          : "Aku di sini. Cerita aja yang lagi di pikiranmu — nggak perlu buru-buru.";
      return {
        text: clean(open + body),
        mode: "composed_companion",
        composed: true
      };
    }

    // If reasoning/conversation already produced a solid handled text, enrich lightly
    if (baseText) {
      // Avoid double emotion if base already has it
      let text = baseText;
      if (plan && plan.constraints && meta && meta.forceHonesty) {
        // Ensure honesty is present once
        if (!/tidak mengarang|won't invent|nggak mengarang|tidak akan mengarang/i.test(text)) {
          text = text + " " + honestyLine(lang);
        }
      }
      if (meta && meta.suggestedQuestion && meta.action === "answer_with_optional_clarify") {
        if (text.indexOf("?") === -1) {
          text = text + " " + meta.suggestedQuestion;
        }
      }
      return {
        text: clean(text),
        mode: "composed_enriched",
        composed: true
      };
    }

    // Full compose from plan
    if (!plan || !plan.primaryGoal) {
      return {
        text:
          lang === "en"
            ? "I'm here. Tell me what you need — Food, Ride, Assistant, or just a chat."
            : "Aku di sini. Bilang aja apa yang kamu butuhkan — Food, Ride, Assistant, atau sekadar ngobrol.",
        mode: "composed_generic",
        composed: true
      };
    }

    const parts = [];
    const open = emotionOpen(plan.emotion, plan.emotionStrength, lang);
    if (open) parts.push(open.trim());

    const cLabel = constraintLabel(plan.constraints, lang);

    if (plan.primaryGoal === "food" || plan.primaryGoal === "combined") {
      if (lang === "en") {
        parts.push(
          "Got it — you need food" +
            (plan.preferences && plan.preferences.length
              ? " (preference: " + plan.preferences.join(", ") + ")"
              : "") +
            "."
        );
        if (cLabel) parts.push("Noted: " + cLabel + ".");
        if (plan.constraints && plan.constraints.simplicity) {
          parts.push("Something simple might be easier right now.");
        }
        parts.push("I can help look at Food options with that in mind.");
      } else {
        parts.push(
          "Oke — kamu butuh makanan" +
            (plan.preferences && plan.preferences.length
              ? " (preferensi: " + plan.preferences.join(", ") + ")"
              : "") +
            "."
        );
        if (cLabel) parts.push("Catatan: " + cLabel + ".");
        if (plan.constraints && plan.constraints.simplicity) {
          parts.push("Yang simpel aja mungkin lebih enak buat sekarang.");
        }
        parts.push("Aku bisa bantu lihat opsi Food dengan catatan itu.");
      }
    } else if (plan.primaryGoal === "ride") {
      if (lang === "en") {
        parts.push("Alright — you need a ride.");
        if (cLabel) parts.push("Noted: " + cLabel + ".");
        parts.push("I can help with Ride once availability is verified.");
      } else {
        parts.push("Siap — kamu butuh ride.");
        if (cLabel) parts.push("Catatan: " + cLabel + ".");
        parts.push("Aku bisa bantu lewat layanan Ride setelah ketersediaan terverifikasi.");
      }
    } else if (plan.primaryGoal === "assistant") {
      if (lang === "en") {
        parts.push("Okay — it sounds like you need assistance or companionship.");
        if (cLabel) parts.push("Noted: " + cLabel + ".");
        parts.push("That fits the Assistant service.");
      } else {
        parts.push("Oke — sepertinya kamu butuh bantuan atau pendampingan.");
        if (cLabel) parts.push("Catatan: " + cLabel + ".");
        parts.push("Itu cocok dengan layanan Assistant.");
      }
    }

    if (plan.secondaryGoals && plan.secondaryGoals.indexOf("ride") !== -1 && plan.primaryGoal !== "ride") {
      parts.push(
        lang === "en"
          ? "We can also look at Ride later if you need it."
          : "Nanti kita bisa lihat Ride juga kalau kamu butuh."
      );
    }

    if (meta && meta.forceHonesty !== false) {
      parts.push(honestyLine(lang));
    }

    if (meta && meta.suggestedQuestion && meta.action !== "answer") {
      parts.push(meta.suggestedQuestion);
    }

    return {
      text: clean(parts.join(" ")),
      mode: "composed_from_plan",
      composed: true
    };
  }

  const Composer = {
    version: VERSION,
    compose: compose
  };

  ROOT.composer = Composer;

  if (typeof ROOT.registerModule === "function") {
    ROOT.registerModule("composer", Composer);
  }

  if (typeof ROOT.emit === "function") {
    ROOT.emit("module:ready", { module: "composer", version: VERSION });
  }

  console.info("[CGO Customer] Composer ready:", VERSION);
})(window);
