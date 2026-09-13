/*
 * ============================================================
 * CIKUR GO — CUSTOMER CGO
 * cgo-customer.js
 * ============================================================
 *
 * PURPOSE
 * -------
 * Customer-facing CGO brain / conversation gateway.
 *
 * IMPORTANT ARCHITECTURE RULE
 * ---------------------------
 * This file does NOT use external AI, external API, Botpress,
 * OpenAI, Gemini, or third-party reasoning service.
 *
 * It is an INTERNAL CIKUR GO intelligence/conversation layer.
 *
 * PUBLIC ENTRY
 * ------------
 *   window.CGO
 *
 * Basic usage:
 *   CGO.chat("Hai CGO");
 *   CGO.chat("Aku lagi lapar");
 *   CGO.chat("Assistant itu untuk apa?");
 *
 * Runtime discovery may later be connected through:
 *   CGO.connectDiscovery(adapter)
 *
 * Service knowledge may later be extended through:
 *   CGO.registerService(...)
 *
 * ============================================================
 */

(function (global) {
  "use strict";

  const VERSION = "1.0.0-customer-foundation";

  // ----------------------------------------------------------
  // INTERNAL STATE
  // ----------------------------------------------------------

  const state = {
    initialized: false,

    conversationId: createId("conversation"),

    messages: [],

    context: {
      lastUserMessage: "",
      lastCGOMessage: "",
      topic: null,
      previousTopic: null,
      intent: null,
      mood: "neutral",
      userMood: "neutral",
      needs: [],
      mentionedServices: [],
      pendingQuestion: null,
      pendingDiscovery: null
    },

    preferences: {
      language: "id-ID",
      emoji: true,
      style: "natural"
    },

    services: {},

    adapters: {
      discovery: null,
      navigation: null,
      runtime: null
    },

    listeners: []
  };


  // ----------------------------------------------------------
  // SERVICE REGISTRY
  // ----------------------------------------------------------

  /*
   * Only verified/declared service knowledge belongs here.
   *
   * Detailed commercial data such as current price, package,
   * availability, radius, merchant status, etc. MUST NOT be
   * invented here.
   *
   * Runtime data must come from the actual CIKUR GO system.
   */

  registerBuiltInServices();


  // ----------------------------------------------------------
  // INITIALIZATION
  // ----------------------------------------------------------

  state.initialized = true;


  // ----------------------------------------------------------
  // PUBLIC CGO OBJECT
  // ----------------------------------------------------------

  const CGO = {

    name: "CGO",

    version: VERSION,

    getState: function () {
      return clone(state.context);
    },

    getConversation: function () {
      return state.messages.map(function (message) {
        return Object.assign({}, message);
      });
    },

    chat: function (input, options) {
      return handleMessage(input, options || {});
    },

    resetConversation: function () {
      state.conversationId = createId("conversation");
      state.messages = [];

      state.context = {
        lastUserMessage: "",
        lastCGOMessage: "",
        topic: null,
        previousTopic: null,
        intent: null,
        mood: "neutral",
        userMood: "neutral",
        needs: [],
        mentionedServices: [],
        pendingQuestion: null,
        pendingDiscovery: null
      };

      emit("conversation:reset", {
        conversationId: state.conversationId
      });

      return true;
    },

    registerService: function (service) {
      return registerService(service);
    },

    getServices: function () {
      return clone(state.services);
    },

    connectDiscovery: function (adapter) {
      if (!adapter || typeof adapter !== "object") {
        return false;
      }

      state.adapters.discovery = adapter;

      emit("adapter:discovery", {
        connected: true
      });

      return true;
    },

    connectNavigation: function (adapter) {
      if (!adapter || typeof adapter !== "object") {
        return false;
      }

      state.adapters.navigation = adapter;

      return true;
    },

    connectRuntime: function (adapter) {
      if (!adapter || typeof adapter !== "object") {
        return false;
      }

      state.adapters.runtime = adapter;

      return true;
    },

    on: function (eventName, callback) {
      if (typeof callback !== "function") {
        return function () {};
      }

      state.listeners.push({
        event: eventName,
        callback: callback
      });

      return function unsubscribe() {
        state.listeners = state.listeners.filter(function (item) {
          return item.callback !== callback;
        });
      };
    },

    isReady: function () {
      return state.initialized === true;
    }
  };


  // ----------------------------------------------------------
  // MAIN CONVERSATION PIPELINE
  // ----------------------------------------------------------

  function handleMessage(input, options) {

    const message = normalizeInput(input);

    if (!message) {
      return createResult(
        "empty",
        "Hmm, pesannya belum masuk nih 😅 Coba tulis lagi yaa."
      );
    }

    const previousContext = clone(state.context);

    const analysis = analyzeMessage(message);

    updateContext(message, analysis);

    addMessage("user", message, analysis);

    emit("message:user", {
      text: message,
      analysis: analysis
    });


    // --------------------------------------------------------
    // GUARD — NEVER INVENT
    // --------------------------------------------------------

    const guardedAnalysis = guardianAnalyze(
      analysis,
      previousContext
    );


    // --------------------------------------------------------
    // DISCOVERY REQUEST
    // --------------------------------------------------------

    if (guardedAnalysis.requiresDiscovery) {

      const discoveryResult = performDiscovery(
        guardedAnalysis,
        options
      );

      if (discoveryResult.pending) {

        const pendingText =
          discoveryResult.message ||
          "Sebentar yaaa, aku cek dulu 😊";

        return finalizeResponse(
          pendingText,
          "discovery_pending",
          guardedAnalysis
        );
      }

      if (discoveryResult.completed) {

        return finalizeResponse(
          buildDiscoveryResponse(
            discoveryResult,
            guardedAnalysis
          ),
          "discovery_result",
          guardedAnalysis
        );
      }
    }


    // --------------------------------------------------------
    // CONVERSATION / PERSONALITY
    // --------------------------------------------------------

    const response = generateResponse(
      guardedAnalysis,
      previousContext
    );


    // --------------------------------------------------------
    // FINAL GUARD
    // --------------------------------------------------------

    const safeResponse = guardianResponse(
      response,
      guardedAnalysis
    );

    return finalizeResponse(
      safeResponse.text,
      safeResponse.type,
      guardedAnalysis
    );
  }


  // ----------------------------------------------------------
  // MESSAGE ANALYSIS
  // ----------------------------------------------------------

  function analyzeMessage(message) {

    const text = message.toLowerCase();

    const analysis = {
      original: message,

      type: "conversation",

      intent: "conversation",

      topic: detectTopic(text),

      mood: detectUserMood(text),

      services: detectServices(text),

      needs: detectNeeds(text),

      asksServiceInformation:
        detectServiceInformationQuestion(text),

      wantsAvailability:
        detectAvailabilityQuestion(text),

      wantsAction:
        detectActionRequest(text),

      greeting:
        detectGreeting(text),

      smallTalk:
        detectSmallTalk(text),

      farewell:
        detectFarewell(text),

      requiresDiscovery: false
    };


    /*
     * Need discovery is preferred when the customer describes
     * a real need without knowing the service name.
     */

    if (
      analysis.needs.length > 0 &&
      analysis.services.length === 0
    ) {
      analysis.intent = "need_discovery";
    }


    if (analysis.asksServiceInformation) {
      analysis.intent = "service_information";
    }


    if (analysis.wantsAvailability) {
      analysis.intent = "availability";
      analysis.requiresDiscovery = true;
    }


    if (analysis.wantsAction) {
      analysis.intent = "service_action";
    }


    if (analysis.services.length > 0) {

      analysis.intent =
        analysis.intent === "conversation"
          ? "service_conversation"
          : analysis.intent;
    }


    /*
     * Customer asking whether an Agent/Mitra is nearby.
     */

    if (
      /\b(agent|mitra)\b/.test(text) &&
      (
        /\b(dekat|sekitar|sekitar aku|sekitar saya)\b/.test(text) ||
        /\b(ada|tersedia|available)\b/.test(text)
      )
    ) {
      analysis.requiresDiscovery = true;
      analysis.intent = "local_service_discovery";
    }


    /*
     * If the customer explicitly asks CGO to check.
     */

    if (
      /\b(cek|check|carikan|cariin|lihatkan|lihat)\b/.test(text) &&
      (
        analysis.services.length > 0 ||
        analysis.needs.length > 0
      )
    ) {
      analysis.requiresDiscovery = true;
    }


    return analysis;
  }


  // ----------------------------------------------------------
  // CONTEXT
  // ----------------------------------------------------------

  function updateContext(message, analysis) {

    state.context.lastUserMessage = message;

    state.context.previousTopic =
      state.context.topic;

    if (analysis.topic) {
      state.context.topic = analysis.topic;
    }

    state.context.intent = analysis.intent;

    state.context.userMood = analysis.mood;

    if (analysis.services.length > 0) {

      state.context.mentionedServices =
        unique(
          state.context.mentionedServices.concat(
            analysis.services
          )
        );
    }

    if (analysis.needs.length > 0) {

      state.context.needs =
        mergeNeeds(
          state.context.needs,
          analysis.needs
        );
    }

    if (
      state.context.previousTopic &&
      state.context.topic &&
      state.context.previousTopic !== state.context.topic
    ) {
      emit("conversation:topic-transition", {
        from: state.context.previousTopic,
        to: state.context.topic
      });
    }
  }


  // ----------------------------------------------------------
  // RESPONSE ENGINE
  // ----------------------------------------------------------

  function generateResponse(analysis, previousContext) {

    // Greeting
    if (analysis.greeting) {
      return {
        type: "greeting",
        text: chooseGreeting(previousContext)
      };
    }


    // Farewell
    if (analysis.farewell) {
      return {
        type: "farewell",
        text: chooseFarewell()
      };
    }


    // Emotional state
    if (
      analysis.mood === "sad" ||
      analysis.mood === "disappointed"
    ) {
      return {
        type: "emotional_support",
        text: chooseEmotionalResponse(
          analysis.mood
        )
      };
    }


    if (analysis.mood === "excited") {
      return {
        type: "excited",
        text: chooseExcitedResponse()
      };
    }


    if (analysis.mood === "confused") {
      return {
        type: "confused",
        text:
          "Hehe, jangan bingung dulu 😅 Ceritain aja pelan-pelan kamu lagi bingung soal apa, nanti kita urai bareng."
      };
    }


    // Small talk
    if (analysis.smallTalk) {
      return {
        type: "small_talk",
        text: chooseSmallTalkResponse()
      };
    }


    // Service information
    if (analysis.asksServiceInformation) {

      const service =
        findBestService(analysis.services);

      if (service) {
        return {
          type: "service_information",
          text: explainServiceNaturally(service)
        };
      }

      return {
        type: "service_information",
        text:
          "Bisaa 😊 Ceritain dulu layanan CIKUR GO yang kamu maksud atau kebutuhanmu seperti apa, nanti aku bantu jelaskan."
      };
    }


    // Need discovery
    if (analysis.intent === "need_discovery") {

      return {
        type: "need_discovery",
        text:
          "Oohh, aku mulai paham kebutuhannya 😊 Kamu sebenarnya mau dibantu untuk apa? Ceritain aja dengan cara kamu sendiri, nggak harus tahu nama layanannya."
      };
    }


    // Known service
    if (analysis.services.length > 0) {

      const service =
        findBestService(analysis.services);

      if (service) {

        return {
          type: "service_conversation",
          text:
            buildServiceFollowUp(service, analysis)
        };
      }
    }


    // Generic conversation
    return {
      type: "conversation",
      text: chooseNaturalConversationResponse(
        previousContext
      )
    };
  }


  // ----------------------------------------------------------
  // SERVICE KNOWLEDGE
  // ----------------------------------------------------------

  function registerBuiltInServices() {

    registerService({
      id: "food",
      name: "CIKUR GO Food",
      aliases: [
        "food",
        "makanan",
        "makan",
        "kuliner",
        "pesan makanan",
        "pesan makan"
      ],
      description:
        "Layanan CIKUR GO untuk kebutuhan makanan.",
      needs: [
        "makanan",
        "lapar",
        "pesan makanan",
        "kuliner"
      ],
      discoveryTypes: [
        "merchant",
        "food",
        "delivery"
      ]
    });


    registerService({
      id: "ride",
      name: "CIKUR GO Ride",
      aliases: [
        "ride",
        "ojek",
        "antar",
        "jemput",
        "kendaraan",
        "perjalanan"
      ],
      description:
        "Layanan CIKUR GO untuk kebutuhan perjalanan dan transportasi.",
      needs: [
        "perjalanan",
        "jemput",
        "antar",
        "transportasi"
      ],
      discoveryTypes: [
        "driver",
        "ride"
      ]
    });


    registerService({
      id: "assistant",
      name: "CIKUR GO Assistant",
      aliases: [
        "assistant",
        "asisten",
        "pendamping",
        "teman",
        "bantuan assistant"
      ],
      description:
        "Layanan Assistant CIKUR GO untuk kebutuhan pendampingan dan bantuan sesuai layanan yang tersedia.",
      needs: [
        "pendampingan",
        "belanja",
        "liburan",
        "acara keluarga",
        "bantuan pribadi"
      ],
      examples: [
        "menemani saat liburan",
        "membantu saat belanja",
        "menemani acara keluarga",
        "kebutuhan pendampingan lainnya"
      ],
      discoveryTypes: [
        "agent",
        "assistant"
      ]
    });


    registerService({
      id: "cikurgo2in1",
      name: "CIKUR GO 2in1",
      aliases: [
        "2in1",
        "2 in 1",
        "cikurgo 2in1",
        "food assistant",
        "food + assistant",
        "makanan dan assistant"
      ],
      description:
        "Layanan kombinasi Food dan Assistant untuk kebutuhan yang membutuhkan keduanya.",
      needs: [
        "food_and_assistant",
        "makanan_dan_pendampingan"
      ],
      discoveryTypes: [
        "agent",
        "merchant",
        "food",
        "assistant"
      ]
    });
  }


  function registerService(service) {

    if (!service || !service.id || !service.name) {
      return false;
    }

    const normalized = Object.assign(
      {
        aliases: [],
        description: "",
        needs: [],
        examples: [],
        discoveryTypes: []
      },
      service
    );

    state.services[service.id] = normalized;

    return true;
  }


  // ----------------------------------------------------------
  // SERVICE EXPLANATION
  // ----------------------------------------------------------

  function explainServiceNaturally(service) {

    if (service.id === "assistant") {

      return (
        "Bisaa 😊 CIKUR GO Assistant bisa membantu untuk berbagai kebutuhan " +
        "pendampingan, misalnya menemani kamu saat liburan, membantu saat " +
        "belanja, menemani acara keluarga, atau kebutuhan lainnya yang " +
        "memerlukan bantuan seorang Assistant. " +
        "Kamu sendiri kira-kira butuh Assistant untuk apa nih? 😁"
      );
    }


    if (service.id === "food") {

      return (
        "Kalau CIKUR GO Food, itu untuk kebutuhan makanan 😊 " +
        "Kalau kamu lagi lapar atau ingin pesan makanan, ceritain aja " +
        "kamu lagi pengen makan apa. Nanti aku bantu arahkan."
      );
    }


    if (service.id === "ride") {

      return (
        "CIKUR GO Ride ditujukan untuk kebutuhan perjalanan atau antar-jemput 😊 " +
        "Kalau kamu ceritain mau pergi dari mana ke mana dan kapan, " +
        "aku bisa bantu memahami kebutuhanmu lebih lanjut."
      );
    }


    if (service.id === "cikurgo2in1") {

      return (
        "CIKUR GO 2in1 menggabungkan kebutuhan Food dan Assistant 😊 " +
        "Jadi kalau kebutuhanmu memang melibatkan makanan sekaligus " +
        "pendampingan atau bantuan, layanan ini bisa menjadi pilihan yang cocok."
      );
    }


    return (
      service.name +
      " adalah salah satu layanan CIKUR GO. " +
      service.description
    );
  }


  function buildServiceFollowUp(service, analysis) {

    if (service.id === "assistant") {

      return (
        "Okeee, berarti kamu sedang mempertimbangkan CIKUR GO Assistant 😊 " +
        "Coba ceritain dulu kebutuhanmu. Kamu ingin ditemani, dibantu " +
        "saat belanja, liburan, acara keluarga, atau ada kebutuhan lain?"
      );
    }


    if (service.id === "food") {

      return (
        "Siappp 😁 Kalau Food, kamu lagi pengen makan apa? " +
        "Biar aku bantu pahami pilihan yang kamu cari."
      );
    }


    if (service.id === "ride") {

      return (
        "Siapp 😊 Kamu mau pergi atau perlu dijemput/diantar ke mana?"
      );
    }


    if (service.id === "cikurgo2in1") {

      return (
        "Okeee 😁 Berarti ada kebutuhan Food sekaligus Assistant ya. " +
        "Ceritain dulu dua kebutuhannya, nanti aku bantu lihat alur yang paling cocok."
      );
    }


    return (
      "Siapp 😊 Ceritain sedikit lagi kebutuhanmu, nanti aku bantu."
    );
  }


  // ----------------------------------------------------------
  // LOCAL SERVICE DISCOVERY
  // ----------------------------------------------------------

  function performDiscovery(analysis, options) {

    const adapter =
      state.adapters.discovery;

    /*
     * No adapter = we MUST NOT pretend discovery happened.
     */

    if (!adapter) {

      state.context.pendingDiscovery = {
        requestedAt: Date.now(),
        reason: analysis.intent
      };

      return {
        pending: true,
        completed: false,
        message:
          "Sebentar yaaa, aku cek dulu apakah ada layanan atau Agent CIKUR GO yang sesuai di sekitar kamu 😊"
      };
    }


    try {

      let result;

      if (typeof adapter.check === "function") {

        result = adapter.check({
          analysis: clone(analysis),
          context: clone(state.context),
          options: options || {}
        });

      } else if (
        typeof adapter.findNearby === "function"
      ) {

        result = adapter.findNearby({
          analysis: clone(analysis),
          context: clone(state.context)
        });

      } else {

        return {
          pending: true,
          completed: false,
          message:
            "Sebentar yaaa, aku cek dulu yaa 😊"
        };
      }


      /*
       * Promise support.
       *
       * The current synchronous chat interface deliberately
       * does not fake an asynchronous result.
       * The adapter can later be exposed through chatAsync().
       */

      if (
        result &&
        typeof result.then === "function"
      ) {

        state.context.pendingDiscovery = {
          requestedAt: Date.now(),
          reason: analysis.intent,
          asynchronous: true
        };

        return {
          pending: true,
          completed: false,
          asynchronous: true,
          promise: result,
          message:
            "Sebentar yaaa, aku cek dulu yaa 😊"
        };
      }


      return normalizeDiscoveryResult(result);

    } catch (error) {

      emit("discovery:error", {
        error: safeError(error)
      });

      return {
        pending: false,
        completed: true,
        success: false,
        error: true,
        data: null
      };
    }
  }


  function buildDiscoveryResponse(result, analysis) {

    if (!result || result.success !== true) {

      return (
        "Aku belum bisa memastikan ketersediaannya saat ini 😅 " +
        "Aku nggak mau asal bilang ada kalau memang belum ada hasil pengecekan yang valid."
      );
    }


    if (
      Array.isArray(result.items) &&
      result.items.length > 0
    ) {

      return (
        "Nahhh, aku sudah cek 😊 Ada " +
        result.items.length +
        " pilihan CIKUR GO yang cocok/tersedia berdasarkan hasil pengecekan saat ini. " +
        "Aku bantu lanjutkan dari sini yaa."
      );
    }


    return (
      "Aku sudah cek, tapi saat ini belum menemukan Agent atau layanan " +
      "yang sesuai dari hasil screening tadi 😔"
    );
  }


  // ----------------------------------------------------------
  // GUARDIAN
  // ----------------------------------------------------------

  function guardianAnalyze(
    analysis,
    previousContext
  ) {

    const result = Object.assign({}, analysis);

    /*
     * Personality never overrides truth.
     */

    if (
      result.requiresDiscovery &&
      !state.adapters.discovery
    ) {
      result.discoveryUnavailable = true;
    }

    return result;
  }


  function guardianResponse(response, analysis) {

    if (!response || typeof response.text !== "string") {

      return {
        type: "guardian_fallback",
        text:
          "Hmm, aku belum yakin dengan jawabanku 😅 Coba ceritain lagi yaa."
      };
    }


    let text = response.text.trim();


    /*
     * Prevent accidental false availability claims in the
     * customer-facing foundation.
     *
     * Actual availability must be generated only from a
     * successful discovery result.
     */

    if (
      /\b(ada agent|agent tersedia|ada driver|driver tersedia)\b/i.test(text) &&
      !analysis.requiresDiscovery
    ) {

      text =
        "Sebentar yaaa, aku cek dulu apakah ada Agent CIKUR GO yang sesuai 😊";
    }


    return {
      type: response.type || "conversation",
      text: text
    };
  }


  // ----------------------------------------------------------
  // EMOTION
  // ----------------------------------------------------------

  function detectUserMood(text) {

    if (
      /\b(sedih|nangis|menangis|kecewa banget|hancur|galau)\b/.test(text)
    ) {
      return "sad";
    }

    if (
      /\b(kecewa|kesal|sebel|marah|kesel|nyebelin)\b/.test(text)
    ) {
      return "disappointed";
    }

    if (
      /\b(senang|bahagia|happy|gembira|seru banget)\b/.test(text)
    ) {
      return "happy";
    }

    if (
      /\b(excited|antusias|nggak sabar|ga sabar|semangat banget)\b/.test(text)
    ) {
      return "excited";
    }

    if (
      /\b(bingung|pusing|nggak ngerti|gak ngerti|ga ngerti)\b/.test(text)
    ) {
      return "confused";
    }

    if (
      /\b(khawatir|cemas|takut)\b/.test(text)
    ) {
      return "worried";
    }

    return "neutral";
  }


  function chooseEmotionalResponse(mood) {

    if (mood === "sad") {

      return (
        "Yahh… 🥺 Kalau kamu mau cerita, cerita aja pelan-pelan. " +
        "Aku dengerin kok. Nggak harus langsung semuanya."
      );
    }

    if (mood === "disappointed") {

      return (
        "Hmm… kedengarannya kamu lagi kecewa ya 😔 " +
        "Kalau kamu mau, ceritain apa yang terjadi. Kita lihat pelan-pelan."
      );
    }

    return (
      "Aku di sini kok 😊 Ceritain aja kalau kamu butuh ditemenin ngobrol."
    );
  }


  function chooseExcitedResponse() {

    const responses = [
      "WAAA 😆❤️ Ikut penasaran aku! Ceritain dong, ada apa nih?",
      "Wihhh semangatnya sampai kerasa dari sini 😁🔥 Ada kabar seru apa?",
      "Hahaha 😆 kayaknya ada cerita bagus nih. Ayo cerita!"
    ];

    return random(responses);
  }


  // ----------------------------------------------------------
  // CONVERSATION PERSONALITY
  // ----------------------------------------------------------

  function chooseGreeting(previousContext) {

    if (
      previousContext &&
      previousContext.lastUserMessage
    ) {

      const responses = [
        "Haiii 😁❤️ Aku di sini. Gimana kabarmu hari ini?",
        "Haloooo 😆 Aku masih standby kok. Kamu lagi ngapain?",
        "Haiii kamu 😊 Ada cerita apa hari ini?"
      ];

      return random(responses);
    }

    const responses = [
      "Haiii 😁❤️ Selamat datang di CIKUR GO! Aku CGO. Kamu lagi apa nih?",
      "Haloooo 😆 Aku CGO, siap nemenin kamu. Mau ngobrol dulu atau ada yang mau kamu cari?",
      "Haiii 😊 Aku di sini. Ceritain aja kamu lagi butuh apa."
    ];

    return random(responses);
  }


  function chooseSmallTalkResponse() {

    const responses = [
      "Aku lagi standby nemenin kamu 😁 Kalau kamu sendiri lagi ngapain?",
      "Aku? Lagi nunggu cerita dari kamu nih 😆 Kamu lagi sibuk atau santai?",
      "Lagi siap bantu kamu dongg 😊 Ada yang mau diceritain?",
      "Aku di sini ajaa 😁 Kamu hari ini gimana?"
    ];

    return random(responses);
  }


  function chooseNaturalConversationResponse(
    previousContext
  ) {

    if (
      previousContext &&
      previousContext.topic
    ) {

      return (
        "Hehe, aku masih ngikutin obrolan kita kok 😊 " +
        "Lanjut aja ceritanya, aku dengerin."
      );
    }

    const responses = [
      "Hmm, ceritain aja 😁 Aku dengerin.",
      "Okeee 😊 Aku ikutin dulu ceritamu. Kamu mau mulai dari mana?",
      "Boleh banget. Ceritain aja dengan cara kamu sendiri, nggak perlu dibuat formal 😄"
    ];

    return random(responses);
  }


  function chooseFarewell() {

    const responses = [
      "Okeee 😊 Sampai ketemu lagi yaa. Aku tetap di sini kalau kamu butuh.",
      "Siappp 😁 Hati-hati yaa. Sampai ngobrol lagi!",
      "Sampai nanti ❤️ Jangan lupa mampir lagi kalau butuh CGO."
    ];

    return random(responses);
  }


  // ----------------------------------------------------------
  // DETECTORS
  // ----------------------------------------------------------

  function detectGreeting(text) {

    return (
      /\b(hai|halo|hello|helo|hey|hi)\b/.test(text) ||
      /^pagi\b/.test(text) ||
      /^siang\b/.test(text) ||
      /^sore\b/.test(text) ||
      /^malam\b/.test(text)
    );
  }


  function detectSmallTalk(text) {

    return (
      /\blagi apa\b/.test(text) ||
      /\bgimana kabar\b/.test(text) ||
      /\bapa kabar\b/.test(text) ||
      /\bkamu gimana\b/.test(text) ||
      /\bngapain\b/.test(text) ||
      /\bmasih di sini\b/.test(text)
    );
  }


  function detectFarewell(text) {

    return (
      /\bbye\b/.test(text) ||
      /\bdah\b/.test(text) ||
      /\bsampai nanti\b/.test(text) ||
      /\bsampai jumpa\b/.test(text) ||
      /\bselamat tinggal\b/.test(text)
    );
  }


  function detectTopic(text) {

    if (
      /\b(food|makanan|makan|lapar|kuliner)\b/.test(text)
    ) {
      return "food";
    }

    if (
      /\b(ride|ojek|driver|jemput|antar|perjalanan)\b/.test(text)
    ) {
      return "ride";
    }

    if (
      /\b(assistant|asisten|pendamping|menemani|temani)\b/.test(text)
    ) {
      return "assistant";
    }

    if (
      /\b(2in1|2 in 1)\b/.test(text)
    ) {
      return "cikurgo2in1";
    }

    if (
      /\b(harga|biaya|tarif|berapa)\b/.test(text)
    ) {
      return "pricing";
    }

    return "conversation";
  }


  function detectServices(text) {

    const found = [];

    Object.keys(state.services).forEach(function (id) {

      const service =
        state.services[id];

      const terms =
        [service.name]
          .concat(service.aliases || [])
          .map(normalizeText);

      terms.forEach(function (term) {

        if (
          term &&
          text.indexOf(term) !== -1
        ) {
          found.push(id);
        }
      });
    });

    /*
     * Combined need detection.
     */

    if (
      (
        /\b(food|makanan|makan)\b/.test(text)
      ) &&
      (
        /\b(assistant|asisten|pendamping|temani|menemani)\b/.test(text)
      )
    ) {
      found.push("cikurgo2in1");
    }

    return unique(found);
  }


  function detectNeeds(text) {

    const needs = [];

    if (
      /\b(lapar|mau makan|ingin makan|pengen makan)\b/.test(text)
    ) {
      needs.push("makanan");
    }

    if (
      /\b(libur|liburan|wisata|jalan-jalan)\b/.test(text)
    ) {
      needs.push("liburan");
    }

    if (
      /\b(belanja|shopping|mall|pasar)\b/.test(text)
    ) {
      needs.push("belanja");
    }

    if (
      /\b(acara keluarga|keluarga|kondangan|acara)\b/.test(text)
    ) {
      needs.push("acara");
    }

    if (
      /\b(temenin|temani|menemani|pendamping)\b/.test(text)
    ) {
      needs.push("pendampingan");
    }

    if (
      /\b(antar|jemput|pergi ke|mau ke)\b/.test(text)
    ) {
      needs.push("perjalanan");
    }

    if (
      /\b(bantu|dibantu|butuh bantuan)\b/.test(text)
    ) {
      needs.push("bantuan");
    }

    return unique(needs);
  }


  function detectServiceInformationQuestion(text) {

    return (
      /\b(assistant|asisten|food|ride|2in1|2 in 1)\b/.test(text) &&
      (
        /\b(untuk apa|buat apa|bisa apa|apa saja|ngapain|fungsinya)\b/.test(text) ||
        /\b(jelasin|jelaskan|jelasin dong|jelaskan dong)\b/.test(text)
      )
    );
  }


  function detectAvailabilityQuestion(text) {

    return (
      /\b(ada|tersedia|available)\b/.test(text) &&
      (
        /\b(agent|mitra|driver|assistant)\b/.test(text)
      )
    );
  }


  function detectActionRequest(text) {

    return (
      /\b(pesan|booking|order|pesenin|carikan|bantu pesan)\b/.test(text)
    );
  }


  // ----------------------------------------------------------
  // HELPERS
  // ----------------------------------------------------------

  function findBestService(serviceIds) {

    if (!Array.isArray(serviceIds)) {
      return null;
    }

    for (let i = 0; i < serviceIds.length; i++) {

      const service =
        state.services[serviceIds[i]];

      if (service) {
        return service;
      }
    }

    return null;
  }


  function addMessage(role, text, analysis) {

    state.messages.push({
      id: createId("message"),
      role: role,
      text: text,
      timestamp: Date.now(),
      analysis: analysis
        ? clone(analysis)
        : null
    });
  }


  function finalizeResponse(
    text,
    type,
    analysis
  ) {

    const response = {
      id: createId("response"),
      conversationId: state.conversationId,
      type: type || "conversation",
      text: text,
      timestamp: Date.now(),
      analysis: clone(analysis),
      context: clone(state.context)
    };

    state.context.lastCGOMessage = text;

    addMessage(
      "cgo",
      text,
      {
        type: type,
        analysis: analysis
      }
    );

    emit("message:cgo", response);

    return response;
  }


  function createResult(type, text) {

    return finalizeResponse(
      text,
      type,
      {
        intent: type
      }
    );
  }


  function normalizeDiscoveryResult(result) {

    if (!result) {

      return {
        pending: false,
        completed: true,
        success: false,
        items: []
      };
    }

    if (
      result.success === true ||
      Array.isArray(result.items)
    ) {

      return {
        pending: false,
        completed: true,
        success: result.success !== false,
        items: Array.isArray(result.items)
          ? result.items
          : [],
        data: result.data || null
      };
    }

    return {
      pending: false,
      completed: true,
      success: false,
      items: [],
      data: null
    };
  }


  function mergeNeeds(existing, incoming) {

    return unique(
      (existing || []).concat(
        incoming || []
      )
    );
  }


  function normalizeInput(input) {

    if (typeof input === "string") {
      return input.trim();
    }

    if (
      input &&
      typeof input.text === "string"
    ) {
      return input.text.trim();
    }

    return "";
  }


  function normalizeText(text) {

    return String(text || "")
      .toLowerCase()
      .trim();
  }


  function unique(array) {

    return Array.from(
      new Set(array || [])
    );
  }


  function random(array) {

    return array[
      Math.floor(
        Math.random() * array.length
      )
    ];
  }


  function clone(value) {

    try {
      return JSON.parse(
        JSON.stringify(value)
      );
    } catch (error) {
      return value;
    }
  }


  function createId(prefix) {

    return (
      prefix +
      "_" +
      Date.now().toString(36) +
      "_" +
      Math.random()
        .toString(36)
        .slice(2, 8)
    );
  }


  function safeError(error) {

    if (!error) {
      return "unknown_error";
    }

    return {
      name: error.name || "Error",
      message: error.message || String(error)
    };
  }


  function emit(eventName, payload) {

    state.listeners.forEach(function (listener) {

      if (
        listener.event !== eventName &&
        listener.event !== "*"
      ) {
        return;
      }

      try {
        listener.callback(payload);
      } catch (error) {
        /*
         * Listener errors must never kill CGO.
         */
      }
    });
  }


  // ----------------------------------------------------------
  // OPTIONAL ASYNC CHAT
  // ----------------------------------------------------------

  /*
   * Used later when Local Discovery becomes asynchronous.
   *
   * This is still INTERNAL JavaScript.
   * It is NOT an external API.
   */

  CGO.chatAsync = async function (
    input,
    options
  ) {

    const message =
      normalizeInput(input);

    if (!message) {
      return CGO.chat("");
    }

    const analysis =
      analyzeMessage(message);

    updateContext(message, analysis);

    addMessage(
      "user",
      message,
      analysis
    );

    emit("message:user", {
      text: message,
      analysis: analysis
    });


    const guardedAnalysis =
      guardianAnalyze(
        analysis,
        state.context
      );


    if (
      guardedAnalysis.requiresDiscovery &&
      state.adapters.discovery
    ) {

      try {

        const adapter =
          state.adapters.discovery;

        let result = null;

        if (
          typeof adapter.checkAsync === "function"
        ) {

          result =
            await adapter.checkAsync({
              analysis: clone(guardedAnalysis),
              context: clone(state.context),
              options: options || {}
            });

        } else if (
          typeof adapter.check === "function"
        ) {

          result =
            await adapter.check({
              analysis: clone(guardedAnalysis),
              context: clone(state.context),
              options: options || {}
            });

        }

        if (result) {

          const discovery =
            normalizeDiscoveryResult(result);

          return finalizeResponse(
            buildDiscoveryResponse(
              discovery,
              guardedAnalysis
            ),
            "discovery_result",
            guardedAnalysis
          );
        }

      } catch (error) {

        emit("discovery:error", {
          error: safeError(error)
        });
      }
    }


    const response =
      generateResponse(
        guardedAnalysis,
        state.context
      );

    const safe =
      guardianResponse(
        response,
        guardedAnalysis
      );

    return finalizeResponse(
      safe.text,
      safe.type,
      guardedAnalysis
    );
  };


  // ----------------------------------------------------------
  // GLOBAL EXPOSURE
  // ----------------------------------------------------------

  /*
   * Single public gateway.
   *
   * Customer pages should NOT need to know the internal modules.
   */

  global.CGO = CGO;


  // ----------------------------------------------------------
  // OPTIONAL DEBUG INFORMATION
  // ----------------------------------------------------------

  if (
    typeof global.dispatchEvent === "function" &&
    typeof global.CustomEvent === "function"
  ) {

    try {

      global.dispatchEvent(
        new CustomEvent(
          "cgo:customer:ready",
          {
            detail: {
              version: VERSION
            }
          }
        )
      );

    } catch (error) {
      // Ignore browser event compatibility issues.
    }
  }


})(window);
