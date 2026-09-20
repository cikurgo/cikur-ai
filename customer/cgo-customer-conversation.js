/* ============================================================
 * CIKUR GO — CGO CUSTOMER CONVERSATION ENGINE
 * ------------------------------------------------------------
 * File    : cgo-customer-conversation.js
 * Role    : Conversation / Context / Mood / Personality Engine
 * Scope   : Customer-facing CGO
 *
 * IMPORTANT:
 * - Internal JavaScript module only.
 * - No external API.
 * - No external AI.
 * - No Firebase Functions.
 * - No third-party runtime.
 * - Does NOT claim real-time availability.
 * - Does NOT invent service facts.
 * - Personality NEVER overrides truth.
 *
 * Works with:
 *   window.CGO
 *
 * Designed to cooperate with:
 *   cgo-customer.js
 *   cgo-customer-knowledge.js
 *   cgo-customer-discovery.js
 *   cgo-customer-guardian.js
 * ============================================================ */

(function (window) {
  "use strict";

  /* ==========================================================
   * NAMESPACE
   * ========================================================== */

  const ROOT = window.CGO_CUSTOMER || (window.CGO_CUSTOMER = {});

  const VERSION = "1.2.0-emotional-continuity";

  /* ==========================================================
   * INTERNAL CONSTANTS
   * ========================================================== */

  const MOODS = Object.freeze([
    "neutral",
    "happy",
    "sad",
    "confused",
    "disappointed",
    "excited",
    "worried",
    "casual",
    "joking",
    "tired",
    "stressed",
    "hurried",
    "lonely"
  ]);

  const STYLES = Object.freeze([
    "natural",
    "casual",
    "formal",
    "short",
    "complex"
  ]);

  const TOPICS = Object.freeze([
    "conversation",
    "food",
    "ride",
    "assistant",
    "cikurgo2in1",
    "pricing",
    "availability",
    "order",
    "location",
    "unknown"
  ]);

  /* ==========================================================
   * SAFE UTILITIES
   * ========================================================== */

  function cleanText(value) {
    return String(value == null ? "" : value)
      .replace(/\s+/g, " ")
      .trim();
  }

  function lower(value) {
    return cleanText(value).toLowerCase();
  }

  function randomItem(list) {
    if (!Array.isArray(list) || !list.length) return "";
    return list[Math.floor(Math.random() * list.length)];
  }

  function includesAny(text, words) {
    const value = lower(text);

    return words.some(function (word) {
      return value.includes(lower(word));
    });
  }

  function clone(value) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (error) {
      return value;
    }
  }

  function now() {
    return Date.now();
  }

  /* ==========================================================
   * DEFAULT STATE
   * ========================================================== */

  function createInitialState() {
    return {
      version: VERSION,

      conversationId:
        "cgo-customer-" +
        now() +
        "-" +
        Math.random().toString(36).slice(2, 8),

      startedAt: now(),
      updatedAt: now(),

      turn: 0,

      mood: "neutral",
      previousMood: "neutral",

      topic: "conversation",
      previousTopic: "conversation",

      style: "natural",

      intent: "conversation",

      lastUserMessage: "",
      previousUserMessage: "",

      lastCGOMessage: "",

      lastQuestion: "",

      pendingQuestion: null,

      context: {
        recentMessages: [],
        mentionedServices: [],
        detectedNeeds: [],
        knownFacts: [],
        references: [],

        locationMentioned: null,
        durationMentioned: null,

        serviceCandidate: null,
        combinedServiceCandidate: null,

        emotionalState: null,

        unresolvedNeed: null,
        unresolvedTopic: null
      },

      reasoning: {
        preferredLanguage: null,
        lastMath: null,
        lastTopic: null
      },

      flags: {
        isGreeting: false,
        isFarewell: false,
        isSmallTalk: false,
        isQuestion: false,
        needsFollowUp: false,
        shouldOfferService: false,
        shouldAskNeed: false,
        shouldCheckAvailability: false,
        shouldStayConversational: true
      }
    };
  }

  let state = createInitialState();

  /* ==========================================================
   * EVENT SYSTEM
   * ========================================================== */

  const listeners = Object.create(null);

  function emit(eventName, payload) {
    const callbacks = listeners[eventName];

    if (!Array.isArray(callbacks)) return;

    callbacks.slice().forEach(function (callback) {
      try {
        callback(clone(payload));
      } catch (error) {
        console.error(
          "[CGO Customer Conversation] Listener error:",
          error
        );
      }
    });
  }

  function on(eventName, callback) {
    if (typeof callback !== "function") {
      return function () {};
    }

    if (!listeners[eventName]) {
      listeners[eventName] = [];
    }

    listeners[eventName].push(callback);

    return function unsubscribe() {
      const list = listeners[eventName];

      if (!Array.isArray(list)) return;

      const index = list.indexOf(callback);

      if (index !== -1) {
        list.splice(index, 1);
      }
    };
  }

  /* ==========================================================
   * MOOD DETECTION
   * ========================================================== */

  function detectMood(text) {
    const value = lower(text);

    // Strong negative first (higher priority)
    if (
      includesAny(value, [
        "sedih",
        "nangis",
        "menangis",
        "galau",
        "kecewa banget",
        "lagi down",
        "lagi sedih",
        "heartbroken",
        "broken heart",
        "patah hati",
        "mau nangis"
      ])
    ) {
      return "sad";
    }

    if (
      includesAny(value, [
        "kecewa",
        "mengecewakan",
        "kok begini",
        "kok gini",
        "parah",
        "gak sesuai",
        "nggak sesuai",
        "kecewa berat"
      ])
    ) {
      return "disappointed";
    }

    if (
      includesAny(value, [
        "capek banget",
        "lelah banget",
        "kecapean",
        "kelelahan",
        "exhausted",
        "burnout",
        "udah lelah",
        "udah capek",
        "capek berat",
        "lelah berat",
        "capek sekali",
        "lelah sekali"
      ])
    ) {
      return "tired";
    }

    if (
      includesAny(value, [
        "stress",
        "stres",
        "stres banget",
        "stress banget",
        "tertekan",
        "overwhelmed",
        "kepala pusing banget",
        "beban berat",
        "mentally tired"
      ])
    ) {
      return "stressed";
    }

    if (
      includesAny(value, [
        "buru-buru",
        "buru buru",
        "terburu-buru",
        "terburu buru",
        "kejar-kejaran",
        "deadline",
        "harus cepet",
        "harus cepat",
        "asap banget",
        "mendesak",
        "urgent",
        "lagi terburu"
      ])
    ) {
      return "hurried";
    }

    if (
      includesAny(value, [
        "sepi",
        "kesepian",
        "lonely",
        "sendiri terus",
        "sendirian",
        "nggak ada yang nemenin",
        "ga ada yang nemenin",
        "merasa sendiri",
        "alone"
      ])
    ) {
      return "lonely";
    }

    if (
      includesAny(value, [
        "bingung",
        "gak ngerti",
        "nggak ngerti",
        "ga ngerti",
        "enggak ngerti",
        "pusing",
        "buntu",
        "bingung banget"
      ])
    ) {
      return "confused";
    }

    if (
      includesAny(value, [
        "khawatir",
        "takut",
        "cemas",
        "was-was",
        "ragu",
        "cemas banget",
        "khawatir banget"
      ])
    ) {
      return "worried";
    }

    // Mild tired (after strong ones)
    if (
      includesAny(value, [
        "capek",
        "lelah",
        "tired",
        "ngantuk",
        "mengantuk",
        "udah cape",
        "cape",
        "lemas"
      ])
    ) {
      return "tired";
    }

    if (
      includesAny(value, [
        "senang",
        "bahagia",
        "happy",
        "asyik",
        "asik",
        "mantap",
        "yey",
        "hehe",
        "seneng",
        "seneng banget"
      ])
    ) {
      return "happy";
    }

    if (
      includesAny(value, [
        "semangat",
        "excited",
        "gak sabar",
        "nggak sabar",
        "gas",
        "ayok",
        "ayo",
        "antusias"
      ])
    ) {
      return "excited";
    }

    if (
      includesAny(value, [
        "wkwk",
        "haha",
        "hahaha",
        "lol",
        "ngakak",
        "becanda",
        "bercanda",
        "wkwkwk"
      ])
    ) {
      return "joking";
    }

    if (
      includesAny(value, [
        "lagi apa",
        "apa kabar",
        "gimana kabarnya",
        "ngapain",
        "sibuk gak",
        "sibuk nggak"
      ])
    ) {
      return "casual";
    }

    return "neutral";
  }

  /* ==========================================================
   * TOPIC DETECTION
   * ========================================================== */

  function detectTopic(text) {
    const value = lower(text);

    /*
     * Specific conversation intents must win over generic service words.
     * Contoh: "berapa harga Assistant?" adalah pricing, bukan assistant;
     * "ada Agent dekat aku?" adalah availability, bukan assistant.
     */
    if (
      includesAny(value, [
        "2in1",
        "2 in 1",
        "sekalian makanan",
        "sekalian makan",
        "makanan sekaligus",
        "food dan assistant"
      ])
    ) {
      return "cikurgo2in1";
    }

    if (
      includesAny(value, [
        "harga",
        "biaya",
        "tarif",
        "berapa",
        "bayar"
      ])
    ) {
      return "pricing";
    }

    if (
      includesAny(value, [
        "ada gak",
        "ada nggak",
        "ada ga",
        "ada enggak",
        "tersedia",
        "tersedia gak",
        "tersedia nggak",
        "available",
        "availability",
        "siapa yang tersedia",
        "bisa cek",
        "cek dulu",
        "agent",
        "mitra",
        "sekitar sini",
        "di sekitar",
        "dekat aku",
        "dekat saya"
      ])
    ) {
      return "availability";
    }

    if (
      includesAny(value, [
        "makan",
        "makanan",
        "lapar",
        "pesan makanan",
        "food",
        "kuliner",
        "resto",
        "restaurant"
      ])
    ) {
      return "food";
    }

    if (
      includesAny(value, [
        "ride",
        "ojek",
        "antar",
        "jemput",
        "kendaraan",
        "naik",
        "perjalanan"
      ])
    ) {
      return "ride";
    }

    if (
      includesAny(value, [
        "assistant",
        "asisten",
        "pendamping",
        "teman",
        "ditemani",
        "nemenin",
        "bantuin",
        "dibantu"
      ])
    ) {
      return "assistant";
    }

    if (
      includesAny(value, [
        "pesan",
        "order",
        "booking",
        "boking",
        "reservasi"
      ])
    ) {
      return "order";
    }

    if (
      includesAny(value, [
        "lokasi",
        "alamat",
        "di mana",
        "dimana",
        "dekat",
        "sekitar"
      ])
    ) {
      return "location";
    }

    return "conversation";
  }

  /* ==========================================================
   * INTENT DETECTION
   * ========================================================== */

  function detectIntent(text) {
    const value = lower(text);
    const scores = Object.create(null);

    function bump(intent, weight) {
      scores[intent] = (scores[intent] || 0) + weight;
    }

    // Weighted phrase scoring (higher = stronger signal)
    const rules = [
      { intent: "greeting", weight: 6, phrases: ["hai", "halo", "hello", "hei", "heii", "hii", "hallo", "hi cgo", "hai cgo", "pagi", "siang", "sore", "malam", "cgo??", "cgo?", "halo cgo", "haii", "haiii"] },
      { intent: "small_talk", weight: 5, phrases: ["lagi apa", "apa kabar", "gimana kabar", "ngapain", "how are you", "sedang apa", "lagi ngapain", "lagi sibuk", "lagi apa cgo", "sedang apa cgo"] },
      { intent: "farewell", weight: 6, phrases: ["dadah", "bye", "sampai nanti", "sampai jumpa", "aku pergi dulu", "see you", "goodbye"] },
      { intent: "need_discovery", weight: 5, phrases: ["aku butuh", "saya butuh", "aku mau", "saya mau", "pengen", "pengin", "ingin", "lagi cari", "butuh bantuan", "i need", "i want"] },
      { intent: "availability", weight: 7, phrases: [
        "ada agent", "ada mitra", "ada driver", "ada yang bisa", "ada yang tersedia",
        "siapa yang bisa", "bisa jemput", "bisa antar", "tersedia", "available",
        "bisa cek", "cek dulu", "di sekitar", "dekat aku", "dekat saya", "sekitar sini",
        "available now", "ada slot", "masih ada yang free"
      ] },
      { intent: "pricing_question", weight: 5, phrases: ["berapa harga", "berapa biaya", "berapa tarif", "how much", "ongkos", "tarifnya"] },
      { intent: "pricing_question", weight: 3, phrases: ["berapa", "harga", "biaya", "tarif"] },
      { intent: "service_information", weight: 5, phrases: ["apa itu", "maksudnya apa", "buat apa", "gunanya apa", "jelasin", "jelaskan", "what is", "explain"] },
      { intent: "question", weight: 2, phrases: ["bisa gak", "bisa nggak", "bisa tidak", "apakah", "can you", "could you"] }
    ];

    rules.forEach(function (rule) {
      rule.phrases.forEach(function (phrase) {
        if (value.indexOf(phrase) !== -1) {
          bump(rule.intent, rule.weight);
        }
      });
    });

    if (value.endsWith("?")) {
      bump("question", 1.5);
    }

    // Pure short call-out to CGO → greeting (hindari jawaban ngaco)
    const pureCall = value.replace(/[?!.,\s]+/g, "");
    if (pureCall === "cgo" || pureCall === "cikurgo" || pureCall === "haicgo" || pureCall === "halocgo") {
      bump("greeting", 8);
    }

    // Pure arithmetic / sisa uang → treat as light question, not pricing service
    if (/(?:\d+\s*[+\-×÷*/]\s*)+\d+/.test(value) || includesAny(value, ["sisa", "tersisa", "hasil"])) {
      bump("question", 4);
    }

    let best = "conversation";
    let bestScore = 0;
    Object.keys(scores).forEach(function (intent) {
      if (scores[intent] > bestScore) {
        bestScore = scores[intent];
        best = intent;
      }
    });

    // Require minimum confidence for non-default intents
    if (best !== "conversation" && bestScore < 2) {
      return "conversation";
    }
    return best;
  }

  function scoreIntents(text) {
    // Exposed for debugging / tests — mirrors detectIntent weights
    const value = lower(text);
    const scores = Object.create(null);
    function bump(intent, weight) {
      scores[intent] = (scores[intent] || 0) + weight;
    }
    const rules = [
      { intent: "greeting", weight: 6, phrases: ["hai", "halo", "hello", "hei", "heii", "hii", "hallo"] },
      { intent: "availability", weight: 7, phrases: ["ada yang bisa", "tersedia", "available", "ada driver"] },
      { intent: "need_discovery", weight: 5, phrases: ["aku butuh", "pengen", "pengin", "i need"] },
      { intent: "pricing_question", weight: 5, phrases: ["berapa harga", "how much", "tarif"] },
      { intent: "service_information", weight: 5, phrases: ["apa itu", "what is", "jelaskan"] }
    ];
    rules.forEach(function (rule) {
      rule.phrases.forEach(function (phrase) {
        if (value.indexOf(phrase) !== -1) bump(rule.intent, rule.weight);
      });
    });
    return scores;
  }

  /* ==========================================================
   * NEED DETECTION
   * ========================================================== */

  function detectNeeds(text) {
    const value = lower(text);
    const needs = [];

    const add = function (need) {
      if (!needs.includes(need)) {
        needs.push(need);
      }
    };

    if (
      includesAny(value, [
        "lapar", "makan", "makanan", "pesan makanan", "kuliner",
        "order makanan", "mau nasi", "snack", "hungry", "food",
        "beli makanan", "pesan food"
      ])
    ) {
      add("food");
    }

    if (
      includesAny(value, [
        "antar", "jemput", "naik", "kendaraan", "perjalanan",
        "ride", "ojek", "pick me up", "diantar", "dijemput",
        "ke stasiun", "ke bandara", "antar jemput", "butuh ojek",
        "mau dijemput", "mau diantar"
      ])
    ) {
      add("ride");
    }

    if (
      includesAny(value, [
        "ditemani", "nemenin", "temenin", "pendamping", "sendirian",
        "butuh teman", "bantu belanja", "mau belanja", "belanja",
        "bantu acara", "acara keluarga", "liburan", "butuh bantuan",
        "dibantu", "assistant", "companionship"
      ])
    ) {
      add("assistant");
    }

    if (
      includesAny(value, [
        "sekalian", "sekaligus", "dan juga", "plus", "sama",
        "sambil", "bareng", "2in1", "dua sekaligus"
      ])
    ) {
      add("combined_need");
    }

    // food + assistant → 2in1
    if (needs.includes("food") && needs.includes("assistant")) {
      add("combined_need");
    }
    // food + ride also counts as combined (multi-service)
    if (needs.includes("food") && needs.includes("ride")) {
      add("combined_need");
    }

    return needs;
  }

  /* ==========================================================
   * REFERENCE DETECTION
   * ========================================================== */

  function detectReferences(text) {
    const value = lower(text);
    const references = [];

    if (
      includesAny(value, [
        "yang tadi",
        "tadi",
        "sebelumnya",
        "barusan"
      ])
    ) {
      references.push("previous_topic");
    }

    if (
      includesAny(value, [
        "itu",
        "yang itu",
        "hal itu"
      ])
    ) {
      references.push("previous_subject");
    }

    if (
      includesAny(value, [
        "sekalian",
        "sambil",
        "juga",
        "plus",
        "sama"
      ]) ||
      /^(dan|terus|lalu)\b/i.test(value)
    ) {
      references.push("addition");
    }

    if (
      includesAny(value, [
        "kalau begitu",
        "kalau gitu",
        "berarti"
      ])
    ) {
      references.push("conclusion_from_previous");
    }

    return references;
  }

  /* ==========================================================
   * LOCATION / DURATION HINTS
   * ========================================================== */

  function detectLocationMention(text) {
    const value = cleanText(text);

    const patterns = [
      /(?:di|ke|dari|sekitar)\s+([A-Za-z0-9À-ÿ .,'-]{2,60})/i
    ];

    for (const pattern of patterns) {
      const match = value.match(pattern);

      if (match && match[1]) {
        return cleanText(match[1]);
      }
    }

    return null;
  }

  function detectDurationMention(text) {
    const value = lower(text);

    const match = value.match(
      /(\d+)\s*(hari|jam|minggu|bulan|malam)/
    );

    if (match) {
      return match[0];
    }

    return null;
  }

  /* ==========================================================
   * CONVERSATION CLASSIFICATION
   * ========================================================== */

  function classify(text) {
    const message = cleanText(text);

    const mood = detectMood(message);
    let topic = detectTopic(message);
    const intent = detectIntent(message);
    const needs = detectNeeds(message);
    const references = detectReferences(message);

    /*
     * Implicit need is still a real topic.
     * Contoh: "mau liburan tapi sendirian" tidak menyebut
     * kata Assistant, tetapi kebutuhan yang terdeteksi adalah Assistant.
     * Hal yang sama berlaku untuk "mau belanja".
     */
    if (topic === "conversation") {
      if (needs.includes("food") && needs.includes("assistant")) {
        topic = "cikurgo2in1";
      } else if (needs.includes("assistant")) {
        topic = "assistant";
      } else if (needs.includes("food")) {
        topic = "food";
      } else if (needs.includes("ride")) {
        topic = "ride";
      }
    }

    const isGreeting =
      intent === "greeting";

    const isFarewell =
      intent === "farewell";

    const isSmallTalk =
      intent === "small_talk";

    const isQuestion =
      intent === "question" ||
      intent === "pricing_question" ||
      intent === "service_information" ||
      intent === "availability";

    const shouldCheckAvailability =
      intent === "availability" ||
      (
        topic === "availability"
        &&
        (
          includesAny(message, [
            "agent",
            "mitra",
            "tersedia",
            "available",
            "sekitar",
            "cek"
          ])
        )
      );

    return {
      text: message,

      mood,
      topic,
      intent,

      needs,
      references,

      isGreeting,
      isFarewell,
      isSmallTalk,
      isQuestion,

      shouldCheckAvailability,

      locationMentioned:
        detectLocationMention(message),

      durationMentioned:
        detectDurationMention(message)
    };
  }

  /* ==========================================================
   * CONTEXT MANAGEMENT
   * ========================================================== */

  function rememberMessage(role, text, metadata) {
    const item = {
      role: role,
      text: cleanText(text),
      timestamp: now(),
      metadata: clone(metadata || {})
    };

    state.context.recentMessages.push(item);

    if (state.context.recentMessages.length > 12) {
      state.context.recentMessages.shift();
    }
  }

  function rememberUnique(list, value) {
    if (!value) return;

    if (!list.includes(value)) {
      list.push(value);
    }
  }

  function resolveReferenceFromState(text) {
    const value = lower(text);

    if (
      !includesAny(value, [
        "yang tadi",
        "tadi",
        "itu",
        "yang itu",
        "hal itu",
        "sebelumnya",
        "barusan",
        "kalau begitu",
        "kalau gitu",
        "berarti",
        "soal tadi",
        "tentang tadi",
        "lanjut yang tadi",
        "about that",
        "about earlier",
        "the previous one",
        "yang barusan"
      ])
    ) {
      return null;
    }

    if (state.context.serviceCandidate) {
      return state.context.serviceCandidate;
    }

    if (state.context.unresolvedTopic) {
      return state.context.unresolvedTopic;
    }

    if (state.topic && state.topic !== "conversation") {
      return state.topic;
    }

    if (state.previousTopic && state.previousTopic !== "conversation") {
      return state.previousTopic;
    }

    return null;
  }

  function updateContext(classification) {
    state.previousUserMessage = state.lastUserMessage;
    state.lastUserMessage = classification.text;

    state.previousMood = state.mood;
    state.mood = classification.mood;

    state.previousTopic = state.topic;

    if (
      classification.topic !== "conversation" ||
      state.topic === "conversation"
    ) {
      state.topic = classification.topic;
    }

    state.intent = classification.intent;

    /*
     * Keep the last concrete subject alive even when the customer
     * uses a short follow-up such as "yang tadi", "itu", or "berarti".
     * The subject is deliberately resolved from existing state only;
     * CGO never invents a missing subject.
     */
    const referencedSubject = resolveReferenceFromState(classification.text);
    if (referencedSubject) {
      state.context.unresolvedTopic = referencedSubject;
    } else if (classification.topic !== "conversation") {
      state.context.unresolvedTopic = classification.topic;
    }

    classification.needs.forEach(function (need) {
      rememberUnique(
        state.context.detectedNeeds,
        need
      );
    });

    // Mirror accumulated needs into reasoning state for multi-turn continuity
    state.reasoning = state.reasoning || {
      preferredLanguage: null,
      lastMath: null,
      lastTopic: null,
      activeNeeds: []
    };
    state.reasoning.activeNeeds = state.context.detectedNeeds.slice();

    classification.references.forEach(function (reference) {
      rememberUnique(
        state.context.references,
        reference
      );
    });

    if (classification.locationMentioned) {
      state.context.locationMentioned =
        classification.locationMentioned;
    }

    if (classification.durationMentioned) {
      state.context.durationMentioned =
        classification.durationMentioned;
    }

    state.context.emotionalState =
      classification.mood;

    state.updatedAt = now();

    state.turn += 1;

    state.flags.isGreeting =
      classification.isGreeting;

    state.flags.isFarewell =
      classification.isFarewell;

    state.flags.isSmallTalk =
      classification.isSmallTalk;

    state.flags.isQuestion =
      classification.isQuestion;

    state.flags.shouldCheckAvailability =
      classification.shouldCheckAvailability;

    state.flags.shouldStayConversational =
      classification.intent === "greeting" ||
      classification.intent === "small_talk" ||
      classification.mood === "sad" ||
      classification.mood === "confused" ||
      classification.mood === "worried" ||
      classification.mood === "tired" ||
      classification.mood === "stressed" ||
      classification.mood === "lonely" ||
      classification.intent === "conversation";

    // Emotional trajectory for multi-turn continuity (soft memory)
    const negativeMoods = [
      "sad",
      "disappointed",
      "tired",
      "stressed",
      "hurried",
      "lonely",
      "confused",
      "worried"
    ];
    if (negativeMoods.indexOf(classification.mood) !== -1) {
      state.reasoning = state.reasoning || {};
      state.reasoning.lastEmotion = classification.mood;
      state.reasoning.emotionTurn = state.turn;
      state.reasoning.emotionStrength =
        classification.mood === "sad" ||
        classification.mood === "stressed" ||
        classification.mood === "lonely"
          ? "strong"
          : "soft";
    } else if (
      classification.mood === "happy" ||
      classification.mood === "excited"
    ) {
      state.reasoning = state.reasoning || {};
      state.reasoning.lastEmotion = classification.mood;
      state.reasoning.emotionTurn = state.turn;
      state.reasoning.emotionStrength = "positive";
    }

    rememberMessage(
      "customer",
      classification.text,
      classification
    );
  }

  /* ==========================================================
   * TOPIC TRANSITION
   * ========================================================== */

  function detectTopicTransition() {
    if (
      state.previousTopic !== state.topic &&
      state.turn > 1
    ) {
      return {
        changed: true,
        from: state.previousTopic,
        to: state.topic
      };
    }

    return {
      changed: false,
      from: state.topic,
      to: state.topic
    };
  }

  /* ==========================================================
   * CONTEXT REFERENCES
   * ========================================================== */

  function getPreviousSubject() {
    if (
      state.context.serviceCandidate
    ) {
      return state.context.serviceCandidate;
    }

    if (
      state.context.unresolvedTopic
    ) {
      return state.context.unresolvedTopic;
    }

    if (
      state.previousTopic &&
      state.previousTopic !== "conversation"
    ) {
      return state.previousTopic;
    }

    return null;
  }

  function resolveReference(text) {
    const value = lower(text);

    const hasPreviousReference =
      includesAny(value, [
        "yang tadi",
        "tadi",
        "itu",
        "sebelumnya",
        "barusan"
      ]);

    if (!hasPreviousReference) {
      return null;
    }

    return getPreviousSubject();
  }

  /* ==========================================================
   * SERVICE CANDIDATE
   * ========================================================== */

  function chooseServiceCandidate(classification) {
    const needs = classification.needs || [];

    if (
      needs.includes("food") &&
      needs.includes("assistant")
    ) {
      return {
        primary: "cikurgo2in1",
        reason: "food_and_assistant"
      };
    }

    if (
      state.context.detectedNeeds.includes("food") &&
      state.context.detectedNeeds.includes("assistant") &&
      (
        classification.references.includes("addition") ||
        classification.intent === "need_discovery"
      )
    ) {
      return {
        primary: "cikurgo2in1",
        reason: "combined_context"
      };
    }

    if (needs.includes("assistant")) {
      return {
        primary: "assistant",
        reason: "assistant_need"
      };
    }

    if (needs.includes("food")) {
      return {
        primary: "food",
        reason: "food_need"
      };
    }

    if (needs.includes("ride")) {
      return {
        primary: "ride",
        reason: "ride_need"
      };
    }

    return null;
  }

  function updateServiceCandidate(classification) {
    const candidate =
      chooseServiceCandidate(classification);

    if (!candidate) {
      return null;
    }

    state.context.serviceCandidate =
      candidate.primary;

    state.context.unresolvedNeed =
      candidate.reason;

    rememberUnique(
      state.context.mentionedServices,
      candidate.primary
    );

    return candidate;
  }

  /* ==========================================================
   * QUESTION STRATEGY
   * ========================================================== */

  function questionAlreadyAsked(question) {
    if (!question) return false;

    return state.context.recentMessages.some(function (item) {
      return (
        item.role === "cgo" &&
        lower(item.text) === lower(question)
      );
    });
  }

  function setPendingQuestion(question, reason) {
    if (!question) {
      state.pendingQuestion = null;
      state.lastQuestion = "";
      return;
    }

    if (questionAlreadyAsked(question)) {
      state.pendingQuestion = null;
      state.lastQuestion = "";
      return;
    }

    state.pendingQuestion = {
      question: question,
      reason: reason || "conversation",
      createdAt: now()
    };

    state.lastQuestion = question;
  }

  function clearPendingQuestion() {
    state.pendingQuestion = null;
    state.lastQuestion = "";
  }

  function shouldAskNeed() {
    const candidate =
      state.context.serviceCandidate;

    if (candidate) {
      return false;
    }

    if (
      state.mood === "sad" ||
      state.mood === "confused" ||
      state.mood === "worried"
    ) {
      return false;
    }

    return true;
  }

  /* ==========================================================
   * PERSONALITY — GREETING
   * ========================================================== */

  function greetingResponse() {
    // Natural & konteks: bedakan sapaan pertama vs kembali, dan panggilan "CGO"
    const turn = state.turn || 0;
    const lastTopic = state.topic && state.topic !== "conversation" ? state.topic : null;
    const topicHint = {
      food: "makanan",
      ride: "perjalanan",
      assistant: "asisten",
      cikurgo2in1: "2in1",
      cikur_go: "CIKUR GO"
    };

    let greetings;
    if (turn <= 1) {
      greetings = [
        "Hai! Aku CGO 😊 Mau dibantu apa hari ini?",
        "Haiii 👋 Aku CGO, siap bantu Food, Ride, Assistant, atau sekadar ngobrol.",
        "Halo! Senang ketemu 😄 Ada yang bisa aku bantu?"
      ];
    } else if (lastTopic && topicHint[lastTopic]) {
      greetings = [
        "Hai lagi 😊 Tadi kita sempat bahas " + topicHint[lastTopic] + ". Mau lanjut atau ganti topik?",
        "Haiii 😄 Masih soal " + topicHint[lastTopic] + " atau ada kebutuhan lain?"
      ];
    } else {
      greetings = [
        "Hai lagi 😊 Ada yang mau dilanjut?",
        "Haiii! Senang ketemu kamu lagi ❤️",
        "Halo kamu 👋 Aku masih di sini."
      ];
    }

    const response = randomItem(greetings);
    clearPendingQuestion();
    return response;
  }

  /* ==========================================================
   * PERSONALITY — SMALL TALK
   * ========================================================== */

  function smallTalkResponse(text) {
    const value = lower(text);

    if (
      includesAny(value, [
        "lagi apa",
        "ngapain",
        "sedang apa",
        "lagi ngapain",
        "lagi sibuk"
      ])
    ) {
      clearPendingQuestion();

      return randomItem([
        "Lagi nemenin kamu di sini 😄 Kamu sendiri lagi apa?",
        "Aku di sini aja, standby 😊 Ada yang mau dibahas?",
        "Lagi santai nemenin kamu 😆 Kamu gimana?"
      ]);
    }

    if (
      includesAny(value, [
        "apa kabar",
        "gimana kabar"
      ])
    ) {
      clearPendingQuestion();

      return randomItem([
        "Baik 😊 Apalagi kalau diajak ngobrol. Kamu sendiri gimana?",
        "Aman dong 😄 Kamu hari ini oke?",
        "Baik-baik aja ❤️ Kamu gimana kabarnya?"
      ]);
    }

    clearPendingQuestion();

    return randomItem([
      "Hehe 😄 cerita aja, aku dengerin.",
      "Aku masih di sini 😊 Mau ngobrol apa?",
      "Siap 😄 Ada yang lagi di pikiranmu?"
    ]);
  }

  /* ==========================================================
   * PERSONALITY — EMOTIONAL RESPONSE
   * ========================================================== */

  function emotionalResponse(mood) {
    switch (mood) {
      case "sad":
        clearPendingQuestion();

        return randomItem([
          "Hmm... sini, cerita pelan-pelan aja ya 🥺 Aku dengerin.",
          "Aduh... kedengarannya kamu lagi nggak baik-baik aja 🥺 Cerita aja, nggak perlu buru-buru.",
          "Aku dengerin kok ❤️ Kalau mau cerita, mulai dari bagian yang paling bikin kamu berat aja."
        ]);

      case "disappointed":
        clearPendingQuestion();

        return randomItem([
          "Yah... aku ngerti kenapa kamu kecewa 😔 Ceritain dulu apa yang terjadi.",
          "Hmm, pasti nggak enak kalau hasilnya nggak sesuai harapan 😔 Aku dengerin dulu ya.",
          "Aku paham. Jangan dipendam sendiri, cerita aja pelan-pelan."
        ]);

      case "tired":
        clearPendingQuestion();

        return randomItem([
          "Wah, kedengarannya kamu lagi capek banget 😔 Santai dulu ya, aku di sini.",
          "Istirahat sejenak boleh kok 😊 Nggak perlu dipaksain. Aku dengerin aja.",
          "Capek ya... 🥺 Nggak usah buru-buru. Cerita atau diam dulu juga boleh."
        ]);

      case "stressed":
        clearPendingQuestion();

        return randomItem([
          "Aku ngerti, kalau lagi stress memang kepala penuh 😔 Pelan-pelan aja ya.",
          "Tarik napas dulu 😊 Kita urai satu-satu, nggak perlu langsung selesai semua.",
          "Stress emang bikin berat. Aku di sini, ceritain aja yang paling menekan."
        ]);

      case "hurried":
        clearPendingQuestion();

        return randomItem([
          "Oke, aku tangkap kamu lagi buru-buru 😊 Langsung aja bilang yang paling urgent.",
          "Siap, mode cepat ⚡ Kasih tau aja prioritasnya, aku bantu secepat yang bisa.",
          "Nggak usah panjang-panjang kalau lagi kejar waktu. Langsung ke intinya aja 😊"
        ]);

      case "lonely":
        clearPendingQuestion();

        return randomItem([
          "Hmm... kedengarannya kamu lagi merasa sendiri 🥺 Aku di sini kok, ngobrol aja.",
          "Nggak apa-apa kalau lagi sepi. Aku standby, cerita atau sekadar nemenin juga boleh ❤️",
          "Aku dengerin 😊 Kalau mau ditemani ngobrol, aku di sini."
        ]);

      case "confused":
        clearPendingQuestion();

        return randomItem([
          "Nggak apa-apa kalau masih bingung 😊 Kita urai pelan-pelan.",
          "Tenang, nggak perlu langsung tahu jawabannya. Ceritain dulu yang bikin kamu bingung.",
          "Sini, kita pelan-pelan aja ya. Bagian mana yang paling bikin kamu bingung?"
        ]);

      case "worried":
        clearPendingQuestion();

        return randomItem([
          "Aku ngerti, kalau lagi khawatir memang susah mikir tenang 😔 Cerita aja dulu.",
          "Tenang dulu ya 😊 Kita lihat satu-satu apa yang sebenarnya kamu butuhkan.",
          "Nggak usah buru-buru. Ceritain kekhawatiranmu, nanti kita lihat langkah yang masuk akal."
        ]);

      case "happy":
        clearPendingQuestion();

        return randomItem([
          "Wahhh 😄 ikut senang dengernya!",
          "Nahhh gitu dong 😆 Seneng kalau kamu lagi happy.",
          "Hehe, energi happy-nya sampai sini 😄❤️"
        ]);

      case "excited":
        clearPendingQuestion();

        return randomItem([
          "Wihhh semangat banget 😆🔥 Cerita dong, mau ngapain?",
          "Nah ini baru semangat 😄 Aku jadi ikut penasaran!",
          "Hahaha, kelihatan banget excited-nya 😆 Apa rencanamu?"
        ]);

      case "joking":
        clearPendingQuestion();

        return randomItem([
          "Wkwkwk 😆 bisa aja kamu.",
          "Hahaha 😂 oke, aku tangkap becandanya.",
          "Waduhhh 😆 mulai mode iseng nih."
        ]);

      case "casual":
        clearPendingQuestion();

        return randomItem([
          "Hehe 😄 aku standby kok.",
          "Santaiii 😊 aku di sini.",
          "Yuk ngobrol santai dulu 😄"
        ]);

      default:
        return null;
    }
  }

  /* ==========================================================
   * PERSONALITY — FAREWELL
   * ========================================================== */

  function farewellResponse() {
    clearPendingQuestion();

    return randomItem([
      "Okee 😊 sampai ketemu lagi yaaa.",
      "Siappp 😄 hati-hati yaa.",
      "Dadahhh 👋❤️ Jangan sungkan balik lagi.",
      "Okeee, aku standby kalau nanti kamu balik lagi 😊"
    ]);
  }

  /* ==========================================================
   * SERVICE NEED DISCOVERY
   * ========================================================== */

  function assistantNeedQuestion() {
    setPendingQuestion(
      "Kira-kira kamu butuh ditemani atau dibantu untuk apa?",
      "assistant_need_discovery"
    );

    return "Kalau Assistant, kamu bisa memanfaatkannya untuk menemani saat liburan, membantu ketika belanja, menemani acara keluarga, atau kebutuhan lainnya 😊 Kira-kira kamu butuh ditemani atau dibantu untuk apa?";
  }

  function foodNeedQuestion() {
    setPendingQuestion(
      "Kamu lagi pengin makan apa?",
      "food_need_discovery"
    );

    return randomItem([
      "Oalaaah 😄 berarti urusannya mulai dari perut nih. Kamu lagi pengin makan apa?",
      "Hehe, kalau lapar memang harus segera ditangani 😆 Kamu lagi pengin makan apa?",
      "Siap 😄 kamu lagi cari makanan tertentu atau masih bebas?"
    ]);
  }

  function rideNeedQuestion() {
    setPendingQuestion(
      "Kamu mau pergi atau perlu diantar ke mana?",
      "ride_need_discovery"
    );

    return "Okeee 😊 kalau kebutuhanmu perjalanan, aku bisa bantu arahkan ke CIKUR GO Ride. Kamu mau pergi atau perlu diantar ke mana?";
  }

  function combinedNeedResponse() {
    setPendingQuestion(
      "Kamu ingin makanan sekaligus dibantu atau ditemani untuk kebutuhan apa?",
      "combined_need_discovery"
    );

    return "Nahhh, kalau kebutuhanmu makanan sekaligus butuh bantuan atau pendampingan, itu mulai cocok dengan konsep CIKUR GO 2in1 😊 Kamu ingin makanan sekaligus dibantu atau ditemani untuk kebutuhan apa?";
  }

  /* ==========================================================
   * SERVICE RESPONSE
   * ========================================================== */

  function serviceCandidateResponse(candidate) {
    if (!candidate) return null;

    switch (candidate.primary) {
      case "assistant":
        return assistantNeedQuestion();

      case "food":
        return foodNeedQuestion();

      case "ride":
        return rideNeedQuestion();

      case "cikurgo2in1":
        return combinedNeedResponse();

      default:
        return null;
    }
  }

  /* ==========================================================
   * CONTEXTUAL FOLLOW-UP
   * ========================================================== */

  function contextualFollowUp(classification) {
    const reference =
      resolveReference(classification.text);

    const serviceName = {
      assistant: "Assistant",
      food: "makanan",
      ride: "perjalanan",
      cikurgo2in1: "CIKUR GO 2in1"
    }[reference];

    if (serviceName) {
      if (classification.intent === "pricing_question") {
        return "Okeee 😊 kita lanjut yang tadi soal " + serviceName + ". Kalau yang kamu tanyakan harganya, aku bantu lihat informasi yang memang tersedia dulu ya.";
      }

      if (classification.intent === "service_information") {
        return "Iyaa 😊 kita lanjut yang tadi soal " + serviceName + ". Kamu mau tahu bagian mana dari layanan itu?";
      }

      if (classification.intent === "question") {
        return "Okeee 😊 aku masih ngikutin konteks " + serviceName + " yang tadi. Kita bahas pertanyaanmu dari situ ya.";
      }

      if (reference === "assistant") {
        return "Yang tadi soal Assistant ya 😊 Kamu mau lanjut dari situ?";
      }

      if (reference === "food") {
        return "Yang tadi soal makanan yaa 😄 Kamu mau lanjut cari makanan atau ada kebutuhan lain juga?";
      }

      if (reference === "ride") {
        return "Yang tadi soal perjalanan ya 😊 Kamu mau lanjut dari situ?";
      }

      if (reference === "cikurgo2in1") {
        return "Yang tadi soal 2in1 yaa 😊 Kamu mau lanjut bahas kebutuhannya?";
      }
    }

    return null;
  }

  /* ==========================================================
   * GENERIC CONVERSATION
   * ========================================================== */

  function genericConversationResponse() {
    clearPendingQuestion();

    // Hindari jawaban generik berulang — manfaatkan topik / kebutuhan yang ada
    const topic = state.topic && state.topic !== "conversation" ? state.topic : null;
    const needs = (state.context && state.context.detectedNeeds) || [];
    const topicLabels = {
      food: "makanan",
      ride: "perjalanan",
      assistant: "asisten",
      cikurgo2in1: "layanan 2in1",
      cikur_go: "CIKUR GO",
      pricing: "harga"
    };

    if (topic && topicLabels[topic]) {
      return randomItem([
        "Oke, soal " + topicLabels[topic] + " ya 😊 Bagian mana yang mau kita dalami?",
        "Masih di jalur " + topicLabels[topic] + ". Kamu mau tahu apa lagi, atau pindah topik?",
        "Siap 😊 Mau lanjut detail " + topicLabels[topic] + " atau ada kebutuhan lain?"
      ]);
    }

    if (needs.length) {
      const n = needs.slice(0, 2).join(" & ");
      return randomItem([
        "Tadi sempat muncul kebutuhan seputar " + n + " 😊 Mau dilanjut dari situ?",
        "Oke, aku catat ada sinyal " + n + ". Mau kita fokus ke situ?"
      ]);
    }

    if (state.turn <= 1) {
      return randomItem([
        "Hehe 😊 aku dengerin. Cerita aja, atau bilang aja layanan yang kamu butuh.",
        "Aku di sini 😄 Mau ngobrol santai, atau langsung pesan Food / Ride / Assistant?"
      ]);
    }

    return randomItem([
      "Oke, aku ikut 😊 Mau lanjut cerita, atau ada layanan CIKUR GO yang bisa aku bantu?",
      "Siap 😄 Kamu mau bahas apa — makanan, perjalanan, asisten, atau yang lain?",
      "Hmm, arahnya masih terbuka. Bilang aja yang kamu butuhkan, aku bantu."
    ]);
  }

  /* ==========================================================
   * RESPONSE PRIORITY
   * ========================================================== */

  function generateResponse(classification, options) {
    /*
     * Natural reasoning gets first opportunity to interpret the turn.
     * It is deterministic/internal: no external model, API, or answer table.
     */
    try {
      const reasoning = ROOT.reasoning;
      if (reasoning && typeof reasoning.respond === "function") {
        const natural = reasoning.respond(classification.text, {
          classification,
          state: clone(state),
          knowledge: options?.knowledge || null,
          discovery: options?.discovery || null
        });
        if (natural && natural.handled && natural.text) {
          // Persist reasoning state (math continuity, language preference, topic)
          if (natural.stateUpdate && typeof natural.stateUpdate === "object") {
            state.reasoning = state.reasoning || {
              preferredLanguage: null,
              lastMath: null,
              lastTopic: null
            };
            Object.keys(natural.stateUpdate).forEach(function (k) {
              state.reasoning[k] = natural.stateUpdate[k];
            });
          }
          return natural;
        }
      }
    } catch (error) {
      emit("reasoning:error", { message: error?.message || String(error) });
    }

    /*
     * Priority is intentional.
     *
     * 1. Pure emotional expression (no clear service need)
     * 2. Greeting / farewell / small talk
     * 3. Contextual reference
     * 4. Service need (may be softened by prior emotion in reasoning)
     * 5. Generic conversation
     *
     * This prevents CGO from immediately selling a service
     * when the customer is actually expressing an emotion.
     * But if the same turn has both emotion + clear need
     * (e.g. "lagi capek, mau makanan yang simpel"), we let
     * reasoning handle the blend instead of pure short-circuit.
     */

    const hasClearServiceNeed =
      (classification.needs && classification.needs.length > 0) ||
      classification.topic === "food" ||
      classification.topic === "ride" ||
      classification.topic === "assistant" ||
      classification.topic === "cikurgo2in1";

    if (
      classification.mood !== "neutral" &&
      classification.mood !== "casual" &&
      !hasClearServiceNeed
    ) {
      const emotional =
        emotionalResponse(classification.mood);

      if (emotional) {
        return {
          text: emotional,
          mode: "emotional",
          shouldOfferService: false,
          stateUpdate: {
            lastEmotion: classification.mood,
            emotionTurn: state.turn,
            emotionStrength:
              classification.mood === "sad" ||
              classification.mood === "stressed" ||
              classification.mood === "lonely"
                ? "strong"
                : "soft"
          }
        };
      }
    }

    if (classification.isGreeting) {
      return {
        text: greetingResponse(),
        mode: "greeting",
        shouldOfferService: false
      };
    }

    if (classification.isFarewell) {
      return {
        text: farewellResponse(),
        mode: "farewell",
        shouldOfferService: false
      };
    }

    if (classification.isSmallTalk) {
      return {
        text: smallTalkResponse(classification.text),
        mode: "small_talk",
        shouldOfferService: false
      };
    }

    const contextual =
      contextualFollowUp(classification);

    if (
      contextual &&
      classification.references.length
    ) {
      return {
        text: contextual,
        mode: "context_reference",
        shouldOfferService: false
      };
    }

    const candidate =
      updateServiceCandidate(classification);

    if (candidate) {
      const serviceResponse =
        serviceCandidateResponse(candidate);

      if (serviceResponse) {
        return {
          text: serviceResponse,
          mode: "service_discovery",
          shouldOfferService: true
        };
      }
    }

    return {
      text: genericConversationResponse(),
      mode: "conversation",
      shouldOfferService: false
    };
  }

  /* ==========================================================
   * MAIN PROCESSOR
   * ========================================================== */

  function process(input, options) {
    const text = cleanText(input);

    if (!text) {
      return {
        ok: false,
        text: "",
        error: "EMPTY_MESSAGE"
      };
    }

    const classification =
      classify(text);

    updateContext(classification);

    const transition =
      detectTopicTransition();

    if (transition.changed) {
      emit("topic:changed", transition);
    }

    emit(
      "conversation:classified",
      classification
    );

    const response =
      generateResponse(classification, options || {});

    state.lastCGOMessage =
      response.text;

    rememberMessage(
      "cgo",
      response.text,
      response
    );

    state.flags.shouldOfferService =
      response.shouldOfferService;

    state.flags.shouldAskNeed =
      response.mode === "service_discovery";

    emit(
      "conversation:response",
      {
        classification,
        response,
        state: clone(state)
      }
    );

    return {
      ok: true,

      text: response.text,

      mode: response.mode,

      classification: clone(classification),

      state: clone(state),

      transition: clone(transition),

      meta: {
        version: VERSION,
        conversationId: state.conversationId,
        turn: state.turn
      }
    };
  }

  /* ==========================================================
   * PUBLIC CONTEXT API
   * ========================================================== */

  function getState() {
    return clone(state);
  }

  function getConversation() {
    return clone(
      state.context.recentMessages
    );
  }

  function reset() {
    state = createInitialState();

    emit(
      "conversation:reset",
      clone(state)
    );

    return getState();
  }

  function setStyle(style) {
    if (!STYLES.includes(style)) {
      return false;
    }

    state.style = style;

    return true;
  }

  function getMood() {
    return state.mood;
  }

  function getTopic() {
    return state.topic;
  }

  function getIntent() {
    return state.intent;
  }

  function getCandidateService() {
    return (
      state.context.serviceCandidate ||
      null
    );
  }

  function getPendingQuestion() {
    return clone(
      state.pendingQuestion
    );
  }

  /* ==========================================================
   * PUBLIC MODULE
   * ========================================================== */

  const Conversation = {

    version: VERSION,

    moods: MOODS.slice(),

    styles: STYLES.slice(),

    topics: TOPICS.slice(),

    process,

    classify,

    detectMood,

    detectTopic,

    detectIntent,

    detectNeeds,

    detectReferences,

    resolveReference,

    updateContext,

    generateResponse,

    reset,

    getState,

    getConversation,

    getMood,

    getTopic,

    getIntent,

    getCandidateService,

    getPendingQuestion,

    setStyle,

    clearPendingQuestion,

    on
  };

  /* ==========================================================
   * ATTACH TO CUSTOMER CGO NAMESPACE
   * ========================================================== */

  ROOT.conversation = Conversation;

  /*
   * Compatibility:
   *
   * If cgo-customer.js is already loaded and exposes
   * a module registration method, register automatically.
   */

  if (
    typeof ROOT.registerModule === "function"
  ) {
    ROOT.registerModule(
      "conversation",
      Conversation
    );
  }

  /* ==========================================================
   * READY EVENT
   * ========================================================== */

  emit(
    "module:ready",
    {
      module: "conversation",
      version: VERSION
    }
  );

  console.info(
    "[CGO Customer] Conversation Engine ready:",
    VERSION
  );

})(window);
