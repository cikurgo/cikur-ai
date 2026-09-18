/* ============================================================
 * CIKUR GO — CUSTOMER META LAYER
 * ------------------------------------------------------------
 * File    : cgo-customer-meta.js
 * Version : 1.0.0-self-awareness
 *
 * Confidence, clarify-or-answer, and self-checks.
 * Deterministic, pure client-side, no external AI.
 * ============================================================ */

(function (window) {
  "use strict";

  const ROOT = window.CGO_CUSTOMER || (window.CGO_CUSTOMER = {});
  const VERSION = "1.0.0-self-awareness";

  function lower(v) {
    return String(v == null ? "" : v).trim().toLowerCase();
  }

  /**
   * Evaluate confidence and decide meta action.
   *
   * @param {object} ctx
   * @param {object|null} ctx.plan
   * @param {object|null} ctx.knowledge
   * @param {object|null} ctx.discovery
   * @param {object|null} ctx.guardianHint
   * @param {boolean} ctx.hasVerifiedRuntime
   * @param {string} ctx.lang
   */
  function evaluate(ctx) {
    ctx = ctx || {};
    const plan = ctx.plan || {};
    const discovery = ctx.discovery || null;
    const hasVerified = !!ctx.hasVerifiedRuntime;
    const lang = ctx.lang === "en" ? "en" : "id";

    let confidence = 0.55; // base for known services
    const reasons = [];

    // Knowledge of service concept is solid
    if (plan.primaryGoal === "food" || plan.primaryGoal === "ride" || plan.primaryGoal === "assistant" || plan.primaryGoal === "combined") {
      confidence += 0.15;
      reasons.push("known_service");
    }

    // Constraints present → we can acknowledge them confidently
    if (plan.constraints && (plan.constraints.budgetMax || plan.constraints.simplicity || plan.constraints.timeHint)) {
      confidence += 0.05;
      reasons.push("constraints_acknowledged");
    }

    // No verified runtime for availability/price claims
    if (!hasVerified) {
      confidence -= 0.2;
      reasons.push("no_verified_runtime");
    }

    // Discovery pending/unknown
    if (discovery && (discovery.status === "pending" || discovery.status === "unknown" || discovery.status === "checking")) {
      confidence -= 0.1;
      reasons.push("discovery_unresolved");
    }

    // Pure emotional / conversational → higher comfort answering as companion
    if (!plan.primaryGoal) {
      confidence = 0.7;
      reasons.push("conversational");
    }

    // Clamp
    confidence = Math.max(0.15, Math.min(0.95, confidence));

    let action = "answer";
    let suggestedQuestion = null;
    let allowServiceOffer = true;
    let forceHonesty = true;

    // Low confidence on service with constraints → clarify or soft answer
    if (confidence < 0.4 && plan.primaryGoal) {
      action = "clarify";
      suggestedQuestion = plan.clarifyingQuestion || (
        lang === "en"
          ? "I want to help accurately — can you share a bit more about what you need?"
          : "Aku ingin bantu dengan akurat — boleh cerita sedikit lagi apa yang kamu butuhkan?"
      );
    } else if (plan.clarifyingQuestion && confidence < 0.6) {
      action = "answer_with_optional_clarify";
      suggestedQuestion = plan.clarifyingQuestion;
    }

    // Availability without verification → must force honesty, no false offer
    if (
      plan.priorityOrder &&
      plan.priorityOrder.indexOf("offer_ride") !== -1 &&
      !hasVerified
    ) {
      forceHonesty = true;
      allowServiceOffer = true; // can still describe the service, not claim live
      reasons.push("ride_without_runtime");
    }

    // Strong negative emotion + no clear need → stay companion, don't push service
    const strongNeg = ["sad", "lonely", "stressed"];
    if (
      strongNeg.indexOf(lower(plan.emotion || "")) !== -1 &&
      !plan.primaryGoal
    ) {
      action = "companion";
      allowServiceOffer = false;
      reasons.push("emotion_first");
    }

    return {
      version: VERSION,
      confidence: Math.round(confidence * 100) / 100,
      action: action,
      reason: reasons.join(","),
      reasons: reasons,
      suggestedQuestion: suggestedQuestion,
      allowServiceOffer: allowServiceOffer,
      forceHonesty: forceHonesty
    };
  }

  const Meta = {
    version: VERSION,
    evaluate: evaluate
  };

  ROOT.meta = Meta;

  if (typeof ROOT.registerModule === "function") {
    ROOT.registerModule("meta", Meta);
  }

  if (typeof ROOT.emit === "function") {
    ROOT.emit("module:ready", { module: "meta", version: VERSION });
  }

  console.info("[CGO Customer] Meta Layer ready:", VERSION);
})(window);
