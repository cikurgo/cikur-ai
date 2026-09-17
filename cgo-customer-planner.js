/* ============================================================
 * CIKUR GO — CUSTOMER PLANNER
 * ------------------------------------------------------------
 * File    : cgo-customer-planner.js
 * Version : 1.0.0-action-planner
 *
 * Turns needs + constraints + emotion + memory into an ordered
 * action plan. Deterministic, pure client-side, no external AI.
 * Never invents availability, price, or facts.
 * ============================================================ */

(function (window) {
  "use strict";

  const ROOT = window.CGO_CUSTOMER || (window.CGO_CUSTOMER = {});
  const VERSION = "1.0.0-action-planner";

  function lower(v) {
    return String(v == null ? "" : v).trim().toLowerCase();
  }

  function unique(list) {
    const out = [];
    (Array.isArray(list) ? list : []).forEach(function (x) {
      if (x != null && x !== "" && out.indexOf(x) === -1) out.push(x);
    });
    return out;
  }

  /**
   * Build an action plan from session signals.
   *
   * @param {object} input
   * @param {string[]} input.needs
   * @param {object|null} input.constraints
   * @param {string|null} input.emotion
   * @param {string|null} input.emotionStrength
   * @param {string[]} input.preferences
   * @param {string|null} input.topic
   * @param {object|null} input.memorySuggest  from memory.suggestFor()
   * @param {string} input.lang  "id" | "en"
   */
  function plan(input) {
    input = input || {};
    const needs = unique(input.needs || []);
    const constraints = input.constraints || null;
    const emotion = lower(input.emotion || "");
    const strength = lower(input.emotionStrength || "soft");
    const prefs = unique(input.preferences || []);
    const topic = lower(input.topic || "");
    const lang = input.lang === "en" ? "en" : "id";
    const mem = input.memorySuggest || null;

    const primaryGoal =
      needs.indexOf("food") !== -1
        ? "food"
        : needs.indexOf("ride") !== -1
          ? "ride"
          : needs.indexOf("assistant") !== -1
            ? "assistant"
            : needs.indexOf("combined_need") !== -1
              ? "combined"
              : topic && topic !== "conversation"
                ? topic
                : null;

    const secondaryGoals = needs.filter(function (n) {
      return n !== primaryGoal && n !== "combined_need";
    });

    const priorityOrder = [];
    const negativeEmotions = [
      "sad",
      "tired",
      "stressed",
      "lonely",
      "worried",
      "disappointed",
      "confused",
      "hurried"
    ];

    // 1. Acknowledge emotion if present
    if (emotion && negativeEmotions.indexOf(emotion) !== -1) {
      priorityOrder.push("acknowledge_emotion");
    }

    // 2. Confirm / surface constraints if rich
    if (
      constraints &&
      (constraints.budgetMax ||
        constraints.timeHint ||
        constraints.locationHint ||
        constraints.simplicity ||
        constraints.speed ||
        constraints.nearMe)
    ) {
      priorityOrder.push("confirm_constraints");
    }

    // 3. Primary service offer
    if (primaryGoal === "food" || primaryGoal === "combined") {
      priorityOrder.push("offer_food");
    } else if (primaryGoal === "ride") {
      priorityOrder.push("offer_ride");
    } else if (primaryGoal === "assistant") {
      priorityOrder.push("offer_assistant");
    } else if (primaryGoal === "cikurgo2in1") {
      priorityOrder.push("offer_2in1");
    }

    // 4. Secondary
    if (secondaryGoals.indexOf("ride") !== -1 && primaryGoal !== "ride") {
      priorityOrder.push("mention_ride_later");
    }
    if (secondaryGoals.indexOf("assistant") !== -1 && primaryGoal !== "assistant") {
      priorityOrder.push("mention_assistant");
    }
    if (secondaryGoals.indexOf("food") !== -1 && primaryGoal !== "food") {
      priorityOrder.push("mention_food");
    }

    // 5. Honesty anchor
    priorityOrder.push("honesty_anchor");

    // Tone
    let tone = "neutral";
    if (emotion === "tired" || emotion === "stressed") tone = "soft_tired";
    else if (emotion === "sad" || emotion === "lonely") tone = "warm_supportive";
    else if (emotion === "hurried") tone = "brief_efficient";
    else if (emotion === "confused" || emotion === "worried") tone = "calm_guiding";
    else if (emotion === "happy" || emotion === "excited") tone = "bright";

    // Clarifying question (only when useful, never invent)
    let clarifyingQuestion = null;
    if (
      primaryGoal === "food" &&
      constraints &&
      constraints.budgetMax &&
      !constraints.simplicity &&
      prefs.length === 0
    ) {
      clarifyingQuestion =
        lang === "en"
          ? "Any preference besides the budget (e.g. simple, nearby)?"
          : "Ada preferensi lain selain budget (misal yang simpel, deket)?";
    } else if (primaryGoal === "ride" && !constraints?.timeHint && emotion !== "hurried") {
      clarifyingQuestion =
        lang === "en"
          ? "Any preferred time window?"
          : "Ada kisaran waktu yang diinginkan?";
    }

    // Must never claim
    const mustNotClaim = ["availability", "price", "eta", "live_listing", "driver_name"];

    // Notes for composer
    const notes = [];
    if (constraints) {
      if (constraints.budgetMax) notes.push("budgetMax " + constraints.budgetMax);
      if (constraints.simplicity) notes.push("simplicity preferred");
      if (constraints.speed) notes.push("speed preferred");
      if (constraints.nearMe) notes.push("near me");
      if (constraints.locationHint) notes.push("location " + constraints.locationHint);
      if (constraints.timeHint) {
        if (constraints.timeHint.type === "clock") {
          notes.push("time ~" + constraints.timeHint.hour + ":00");
        } else if (constraints.timeHint.tag) {
          notes.push("time " + constraints.timeHint.tag);
        }
      }
    }
    if (prefs.length) notes.push("prefs " + prefs.join(","));
    if (mem && mem.frequentEmotion) notes.push("frequentEmotion " + mem.frequentEmotion);

    return {
      version: VERSION,
      primaryGoal: primaryGoal,
      secondaryGoals: secondaryGoals,
      priorityOrder: priorityOrder,
      clarifyingQuestion: clarifyingQuestion,
      tone: tone,
      mustNotClaim: mustNotClaim,
      notes: notes,
      emotion: emotion || null,
      emotionStrength: strength,
      constraints: constraints,
      preferences: prefs,
      lang: lang
    };
  }

  const Planner = {
    version: VERSION,
    plan: plan
  };

  ROOT.planner = Planner;

  if (typeof ROOT.registerModule === "function") {
    ROOT.registerModule("planner", Planner);
  }

  if (typeof ROOT.emit === "function") {
    ROOT.emit("module:ready", { module: "planner", version: VERSION });
  }

  console.info("[CGO Customer] Planner ready:", VERSION);
})(window);
