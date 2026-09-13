/* ============================================================
 * CIKUR GO — CUSTOMER CGO MAIN GATEWAY
 * ------------------------------------------------------------
 * File    : cgo-customer.js
 * Version : 1.1.1-customer-gateway-aligned
 *
 * Peran:
 *   Gerbang utama Customer CGO.
 *
 * Pipeline:
 *   Customer Message
 *        ↓
 *   Conversation
 *        ↓
 *   Knowledge
 *        ↓
 *   Discovery (jika diperlukan)
 *        ↓
 *   Response Candidate
 *        ↓
 *   Guardian
 *        ↓
 *   Customer Response
 *
 * Prinsip:
 *   - Internal JavaScript gateway.
 *   - Tidak membutuhkan external AI/API.
 *   - Knowledge ≠ Runtime.
 *   - Runtime harus memiliki evidence.
 *   - Personality tidak boleh mengalahkan truth.
 * ============================================================ */

(function (window) {
    "use strict";

    window.CGO_CUSTOMER = window.CGO_CUSTOMER || {};

    const VERSION = "1.1.1-customer-gateway-aligned";

    const EVENTS = Object.freeze({
        READY: "ready",
        MESSAGE: "message",
        ANALYZED: "analyzed",
        KNOWLEDGE: "knowledge",
        DISCOVERY_REQUIRED: "discovery_required",
        DISCOVERY_STARTED: "discovery_started",
        DISCOVERY_FINISHED: "discovery_finished",
        RESPONSE_CANDIDATE: "response_candidate",
        GUARDED: "guarded",
        RESPONSE: "response",
        ERROR: "error",
        RESET: "reset"
    });

    /* =========================================================
     * INTERNAL STATE
     * ========================================================= */

    const state = {
        version: VERSION,

        ready: false,

        conversationId: createConversationId(),

        turn: 0,

        messages: [],

        lastInput: "",

        lastResponse: "",

        lastAnalysis: null,

        lastKnowledge: null,

        lastDiscovery: null,

        lastGuard: null,

        pendingDiscovery: null,

        pendingQuestion: null,

        currentTopic: "conversation",

        currentIntent: "conversation",

        currentMood: "neutral",

        candidateService: null,

        combinedServiceCandidate: null,

        mentionedServices: [],

        detectedNeeds: [],

        lastError: null
    };

    const listeners = {};

    /* =========================================================
     * UTILITIES
     * ========================================================= */

    function createConversationId() {
        return (
            "cgo-customer-" +
            Date.now().toString(36) +
            "-" +
            Math.random().toString(36).slice(2, 8)
        );
    }

    function now() {
        return new Date().toISOString();
    }

    function clone(value) {
        try {
            return JSON.parse(JSON.stringify(value));
        } catch (error) {
            return value;
        }
    }

    function emit(eventName, payload) {
        const callbacks = listeners[eventName] || [];

        callbacks.forEach(function (callback) {
            try {
                callback(payload);
            } catch (error) {
                console.warn(
                    "[CGO CUSTOMER] event listener error:",
                    error
                );
            }
        });
    }

    function on(eventName, callback) {
        if (typeof callback !== "function") {
            return function () {};
        }

        listeners[eventName] = listeners[eventName] || [];
        listeners[eventName].push(callback);

        return function unsubscribe() {
            const list = listeners[eventName] || [];
            const index = list.indexOf(callback);

            if (index !== -1) {
                list.splice(index, 1);
            }
        };
    }

    function normalizeInput(input) {
        if (input === null || input === undefined) {
            return "";
        }

        if (typeof input === "string") {
            return input.trim();
        }

        if (typeof input === "object") {
            if (typeof input.text === "string") {
                return input.text.trim();
            }

            if (typeof input.message === "string") {
                return input.message.trim();
            }

            if (typeof input.input === "string") {
                return input.input.trim();
            }
        }

        return String(input).trim();
    }

    function getConversationModule() {
        return window.CGO_CUSTOMER.conversation || null;
    }

    function getKnowledgeModule() {
        return window.CGO_CUSTOMER.knowledge || null;
    }

    function getDiscoveryModule() {
        return window.CGO_CUSTOMER.discovery || null;
    }

    function getGuardianModule() {
        return window.CGO_CUSTOMER.guardian || null;
    }

    /* =========================================================
     * MODULE STATUS
     * ========================================================= */

    function getModuleStatus() {
        return {
            conversation: !!getConversationModule(),
            knowledge: !!getKnowledgeModule(),
            discovery: !!getDiscoveryModule(),
            guardian: !!getGuardianModule()
        };
    }

    function isReady() {
        const modules = getModuleStatus();

        /*
         * Conversation, Knowledge, dan Guardian merupakan
         * fondasi utama.
         *
         * Discovery boleh belum terhubung karena tidak semua
         * percakapan membutuhkan pengecekan runtime.
         */
        return (
            modules.conversation === true &&
            modules.knowledge === true &&
            modules.guardian === true
        );
    }

    /* =========================================================
     * MESSAGE RECORD
     * ========================================================= */

    function recordMessage(role, text, metadata) {
        const message = {
            id:
                "msg-" +
                Date.now().toString(36) +
                "-" +
                Math.random().toString(36).slice(2, 7),

            conversationId: state.conversationId,

            role: role,

            text: text,

            timestamp: now(),

            metadata: metadata || {}
        };

        state.messages.push(message);

        /*
         * Menjaga history lokal tetap masuk akal.
         * Tidak menyimpan tanpa batas.
         */
        if (state.messages.length > 100) {
            state.messages.shift();
        }

        emit(EVENTS.MESSAGE, clone(message));

        return message;
    }

    /* =========================================================
     * CONVERSATION PROCESSING
     * ========================================================= */

    function analyzeConversation(input, options) {
        const conversation = getConversationModule();

        if (!conversation) {
            throw new Error(
                "CGO Customer Conversation module belum tersedia."
            );
        }

        let result = null;

        if (typeof conversation.process === "function") {
            result = conversation.process(input, {
                conversationId: state.conversationId,
                turn: state.turn,
                options: options || {},
                previousState: clone(state)
            });

            /*
             * Conversation.process() is the authoritative conversation
             * pipeline. It already classifies, updates context, detects
             * topic transitions, generates the personality response, and
             * advances its own turn counter.
             *
             * Gateway hanya menormalkan hasilnya menjadi contract yang
             * dipakai oleh Knowledge / Discovery / Guardian. Jangan
             * menjalankan generateResponse() kedua kali.
             */
            if (result && result.classification) {
                const classification = clone(result.classification);
                result = Object.assign({}, classification, {
                    responseText: result.text || "",
                    responseMode: result.mode || "conversation",
                    shouldOfferService:
                        result.mode === "service_discovery" ||
                        Boolean(result.response && result.response.shouldOfferService),
                    shouldAskNeed:
                        Boolean(result.response && result.response.mode === "service_discovery"),
                    conversationResult: clone(result),
                    conversationState: clone(result.state || null),
                    transition: clone(result.transition || null),
                    meta: clone(result.meta || null)
                });
            }
        } else if (typeof conversation.classify === "function") {
            result = conversation.classify(input, {
                conversationId: state.conversationId,
                turn: state.turn
            });
        } else {
            throw new Error(
                "Conversation module tidak memiliki process() atau classify()."
            );
        }

        if (!result || typeof result !== "object") {
            result = {
                intent: "conversation",
                topic: "conversation",
                mood: "neutral",
                needs: [],
                mentionedServices: [],
                candidateService: null,
                combinedServiceCandidate: null
            };
        }

        state.lastAnalysis = clone(result);

        /* Conversation adalah source of truth untuk turn. */
        if (result.meta && Number.isFinite(result.meta.turn)) {
            state.turn = result.meta.turn;
        } else if (result.conversationState && Number.isFinite(result.conversationState.turn)) {
            state.turn = result.conversationState.turn;
        } else if (typeof conversation.getState === "function") {
            const conversationState = conversation.getState();
            if (conversationState && Number.isFinite(conversationState.turn)) {
                state.turn = conversationState.turn;
            }
        }

        if (result.topic) {
            state.currentTopic = result.topic;
        }

        if (result.intent) {
            state.currentIntent = result.intent;
        }

        if (result.mood) {
            state.currentMood = result.mood;
        }

        if (Array.isArray(result.needs)) {
            state.detectedNeeds = clone(result.needs);
        }

        if (Array.isArray(result.mentionedServices)) {
            state.mentionedServices = clone(
                result.mentionedServices
            );
        }

        if (result.candidateService) {
            state.candidateService = result.candidateService;
        }

        if (result.combinedServiceCandidate) {
            state.combinedServiceCandidate =
                result.combinedServiceCandidate;
        }

        emit(EVENTS.ANALYZED, clone(result));

        return result;
    }

    /* =========================================================
     * KNOWLEDGE PROCESSING
     * ========================================================= */

    function queryKnowledge(input, analysis, options) {
        const knowledge = getKnowledgeModule();

        if (!knowledge) {
            return {
                status: "unknown",
                known: false,
                reason: "Knowledge module tidak tersedia."
            };
        }

        let result = null;

        /*
         * Bila knowledge module memiliki interpretasi langsung,
         * gunakan itu terlebih dahulu.
         */
        if (typeof knowledge.interpret === "function") {
            result = knowledge.interpret(input, {
                analysis: analysis,
                state: clone(state),
                options: options || {}
            });
        }

        /*
         * Jika tidak ada interpret(), gunakan query() bila tersedia.
         */
        if (
            (!result || typeof result !== "object") &&
            typeof knowledge.query === "function"
        ) {
            result = knowledge.query(input, {
                analysis: analysis,
                state: clone(state)
            });
        }

        /*
         * Jika conversation sudah menentukan kandidat service,
         * ambil knowledge service tersebut.
         */
        if (
            (!result || typeof result !== "object") &&
            analysis &&
            (analysis.combinedServiceCandidate || analysis.candidateService) &&
            typeof knowledge.getService === "function"
        ) {
            const candidate =
                analysis.combinedServiceCandidate ||
                analysis.candidateService;

            const serviceId =
                typeof candidate === "string"
                    ? candidate
                    : candidate.id;

            const service =
                knowledge.getService(serviceId);

            if (service) {
                const status =
                    service.status || "complete";

                result = {
                    status: status,
                    known: status !== "unknown",
                    service: service,
                    source: "service_registry",
                    requiresDiscovery: Boolean(
                        service.discovery &&
                        service.discovery.required
                    )
                };
            }
        }

        if (!result || typeof result !== "object") {
            result = {
                status: "unknown",
                known: false,
                service: null,
                source: null
            };
        }

        state.lastKnowledge = clone(result);

        emit(EVENTS.KNOWLEDGE, clone(result));

        return result;
    }

    /* =========================================================
     * DISCOVERY DECISION
     * ========================================================= */

    function needsRuntimeDiscovery(
        input,
        analysis,
        knowledge,
        options
    ) {
        options = options || {};

        /*
         * Caller dapat memaksa discovery secara eksplisit.
         */
        if (options.forceDiscovery === true) {
            return true;
        }

        /*
         * Jangan melakukan discovery hanya karena menyebut nama
         * service. Discovery hanya dilakukan ketika kebutuhan
         * memang membutuhkan kondisi aktual.
         */
        if (
            analysis &&
            analysis.intent === "availability"
        ) {
            return true;
        }

        if (
            analysis &&
            analysis.intent === "order"
        ) {
            return true;
        }

        if (
            analysis &&
            analysis.intent === "location"
        ) {
            return true;
        }

        if (
            analysis &&
            analysis.intent === "action"
        ) {
            return true;
        }

        /*
         * Runtime language must be recognized even when Conversation
         * has not classified the sentence as availability/location yet.
         * This keeps Discovery from depending on one upstream classifier.
         */
        const text = String(input || "").toLowerCase();
        const runtimeWords = [
            "sekarang",
            "saat ini",
            "ada nggak",
            "ada gak",
            "ada ga",
            "ada enggak",
            "tersedia",
            "dekat aku",
            "dekat saya",
            "sekitar sini",
            "sekitar aku",
            "sekitar saya",
            "di sekitar",
            "bisa datang",
            "bisa antar",
            "bisa jemput",
            "siapa yang tersedia"
        ];

        if (
            runtimeWords.some(function (word) {
                return text.indexOf(word) !== -1;
            })
        ) {
            return true;
        }

        /*
         * Knowledge dapat menyatakan discovery diperlukan untuk service
         * tertentu. Pada tahap ini kita hanya membaca requirement-nya;
         * keputusan tetap tidak boleh membuat klaim runtime.
         */
        if (
            knowledge &&
            knowledge.service &&
            knowledge.service.discovery &&
            knowledge.service.discovery.required === true
        ) {
            return false;
        }

        return false;
    }

    /* =========================================================
     * DISCOVERY REQUEST
     * ========================================================= */

    function buildDiscoveryRequest(
        input,
        analysis,
        knowledge,
        options
    ) {
        options = options || {};

        let serviceId = null;

        if (
            analysis &&
            analysis.combinedServiceCandidate
        ) {
            serviceId =
                typeof analysis.combinedServiceCandidate ===
                "string"
                    ? analysis.combinedServiceCandidate
                    : analysis.combinedServiceCandidate.id;
        }

        if (!serviceId && analysis && analysis.candidateService) {
            serviceId =
                typeof analysis.candidateService === "string"
                    ? analysis.candidateService
                    : analysis.candidateService.id;
        }

        if (!serviceId && knowledge && knowledge.service) {
            serviceId = knowledge.service.id || null;
        }

        const discoveryTypes =
            knowledge &&
            knowledge.service &&
            knowledge.service.discovery &&
            Array.isArray(
                knowledge.service.discovery.types
            )
                ? knowledge.service.discovery.types
                : [];

        return {
            requestId:
                "customer-discovery-" +
                Date.now().toString(36) +
                "-" +
                Math.random().toString(36).slice(2, 7),

            serviceId: serviceId,

            service:
                knowledge && knowledge.service
                    ? clone(knowledge.service)
                    : null,

            types: discoveryTypes,

            query: input,

            needs:
                analysis && Array.isArray(analysis.needs)
                    ? clone(analysis.needs)
                    : [],

            context: {
                conversationId: state.conversationId,
                turn: state.turn,
                topic: state.currentTopic,
                intent: state.currentIntent,
                mood: state.currentMood,

                location:
                    options.location ||
                    (
                        analysis &&
                        analysis.location
                    ) ||
                    null,

                duration:
                    analysis &&
                    analysis.duration
                        ? analysis.duration
                        : null
            }
        };
    }

    /* =========================================================
     * DISCOVERY EXECUTION
     * ========================================================= */

    function performDiscovery(
        input,
        analysis,
        knowledge,
        options
    ) {
        const discovery = getDiscoveryModule();

        if (!discovery) {
            const unknown = {
                status: "unknown",
                verified: false,
                source: null,
                reason:
                    "Discovery module belum tersedia."
            };

            state.lastDiscovery = clone(unknown);

            return unknown;
        }

        const request = buildDiscoveryRequest(
            input,
            analysis,
            knowledge,
            options
        );

        state.pendingDiscovery = clone(request);

        emit(
            EVENTS.DISCOVERY_REQUIRED,
            clone(request)
        );

        /*
         * Jika discovery adapter belum terhubung, module Discovery
         * sendiri harus mengembalikan UNKNOWN.
         *
         * Gateway tidak boleh mengubah UNKNOWN menjadi AVAILABLE.
         */
        let result;

        if (typeof discovery.screen === "function") {
            result = discovery.screen(request);
        } else if (
            typeof discovery.findNearby === "function"
        ) {
            result = discovery.findNearby(request);
        } else {
            result = {
                status: "unknown",
                verified: false,
                source: null,
                reason:
                    "Tidak ada metode discovery yang tersedia."
            };
        }

        state.lastDiscovery = clone(result);
        state.pendingDiscovery = null;

        emit(
            EVENTS.DISCOVERY_FINISHED,
            clone(result)
        );

        return result;
    }

    async function performDiscoveryAsync(
        input,
        analysis,
        knowledge,
        options
    ) {
        const discovery = getDiscoveryModule();

        if (!discovery) {
            const unknown = {
                status: "unknown",
                verified: false,
                source: null,
                reason:
                    "Discovery module belum tersedia."
            };

            state.lastDiscovery = clone(unknown);

            return unknown;
        }

        const request = buildDiscoveryRequest(
            input,
            analysis,
            knowledge,
            options
        );

        state.pendingDiscovery = clone(request);

        emit(
            EVENTS.DISCOVERY_STARTED,
            clone(request)
        );

        let result;

        try {
            if (
                typeof discovery.screenAsync ===
                "function"
            ) {
                result =
                    await discovery.screenAsync(
                        request
                    );
            } else if (
                typeof discovery.findNearbyAsync ===
                "function"
            ) {
                result =
                    await discovery.findNearbyAsync(
                        request
                    );
            } else if (
                typeof discovery.screen ===
                "function"
            ) {
                result = discovery.screen(request);
            } else {
                result = {
                    status: "unknown",
                    verified: false,
                    source: null,
                    reason:
                        "Tidak ada metode discovery yang tersedia."
                };
            }
        } catch (error) {
            result = {
                status: "error",
                verified: false,
                source: null,
                error: error.message,
                reason:
                    "Discovery gagal dijalankan."
            };
        }

        state.lastDiscovery = clone(result);
        state.pendingDiscovery = null;

        emit(
            EVENTS.DISCOVERY_FINISHED,
            clone(result)
        );

        return result;
    }

    /* =========================================================
     * RESPONSE CANDIDATE
     * ========================================================= */

    function generateResponseCandidate(
        input,
        analysis,
        knowledge,
        discovery,
        options
    ) {
        const conversation =
            getConversationModule();

        if (!conversation) {
            return fallbackResponse(
                "conversation_module_missing"
            );
        }

        let response = null;

        /*
         * Bila Discovery benar-benar dijalankan, hasil runtime harus
         * mempengaruhi candidate. Jangan biarkan responseText Conversation
         * menutupi UNKNOWN / VERIFIED runtime state. Personality tetap
         * dipertahankan oleh fallback Gateway, tetapi truth tetap utama.
         */
        const discoveryWasPerformed = Boolean(
            discovery &&
            discovery.status &&
            discovery.status !== "not_required"
        );

        if (discoveryWasPerformed) {
            response = generateGatewayFallback(
                input,
                analysis,
                knowledge,
                discovery
            );
        } else if (
            analysis &&
            analysis.intent === "pricing_question"
        ) {
            /* Harga harus selalu dijawab dari data harga yang sah.
             * Saat Knowledge belum menyediakan harga, jangan membuat angka. */
            response = generateGatewayFallback(
                input,
                analysis,
                knowledge,
                discovery
            );
        } else if (shouldPreferKnowledgeResponse(analysis, knowledge)) {
            /*
             * Knowledge yang lebih spesifik daripada classifier Conversation
             * harus boleh mengoreksi arah candidate tanpa menggantikan
             * personality engine. Ini penting untuk kombinasi layanan,
             * misalnya Food + Assistant -> CIKUR GO 2in1.
             */
            response = generateKnowledgeAwareResponse(
                input,
                analysis,
                knowledge
            );
        } else if (analysis && typeof analysis.responseText === "string") {
            /* Conversation.process() tetap menjadi sumber personality utama. */
            response = analysis.responseText;
        }

        /*
         * Compatibility fallback untuk conversation module lama: bila
         * process() tidak mengembalikan responseText, kirim classification
         * object — BUKAN raw input string.
         */
        if (
            (!response || typeof response !== "string" || !response.trim()) &&
            typeof conversation.generateResponse === "function"
        ) {
            response = conversation.generateResponse(
                analysis,
                {
                    knowledge: knowledge,
                    discovery: discovery,
                    state: clone(state),
                    options: options || {}
                }
            );
        }

        /*
         * Beberapa versi conversation module mungkin mengembalikan
         * object, bukan string.
         */
        if (
            response &&
            typeof response === "object"
        ) {
            if (typeof response.text === "string") {
                response = response.text;
            } else if (
                typeof response.response === "string"
            ) {
                response = response.response;
            } else if (
                typeof response.message === "string"
            ) {
                response = response.message;
            }
        }

        if (
            typeof response !== "string" ||
            !response.trim()
        ) {
            response = generateGatewayFallback(
                input,
                analysis,
                knowledge,
                discovery
            );
        }

        response = response.trim();

        emit(EVENTS.RESPONSE_CANDIDATE, {
            input: input,
            response: response,
            analysis: clone(analysis),
            knowledge: clone(knowledge),
            discovery: clone(discovery)
        });

        return response;
    }

    function shouldPreferKnowledgeResponse(analysis, knowledge) {
        if (!analysis || !knowledge || !knowledge.service) {
            return false;
        }

        const knowledgeServiceId =
            knowledge.service.id || "";

        const analysisServiceId =
            typeof analysis.candidateService === "string"
                ? analysis.candidateService
                : analysis.candidateService && analysis.candidateService.id
                    ? analysis.candidateService.id
                    : "";

        const combinedId =
            typeof analysis.combinedServiceCandidate === "string"
                ? analysis.combinedServiceCandidate
                : analysis.combinedServiceCandidate && analysis.combinedServiceCandidate.id
                    ? analysis.combinedServiceCandidate.id
                    : "";

        /* Conversation.process() is authoritative when it already produced
         * a response. Knowledge should only fill a genuine response gap, not
         * replace the richer conversation/personality result. */
        if (analysis.responseText && String(analysis.responseText).trim()) {
            return false;
        }

        /* Knowledge wins only when it has identified a concrete service
         * and Conversation has either identified another service or no
         * concrete service at all. */
        if (!knowledgeServiceId) {
            return false;
        }

        if (knowledgeServiceId === "cikurgo2in1") {
            return combinedId !== knowledgeServiceId;
        }

        return !analysisServiceId && !combinedId;
    }

    function generateKnowledgeAwareResponse(
        input,
        analysis,
        knowledge
    ) {
        const service =
            knowledge && knowledge.service
                ? knowledge.service
                : null;

        if (!service) {
            return "";
        }

        if (service.id === "cikurgo2in1") {
            return (
                "Hehe, ini cocoknya CIKUR GO 2in1 😄 " +
                "Karena kamu mau belanja sekaligus pesan makanan, " +
                "keduanya bisa diarahkan sebagai satu kebutuhan gabungan. " +
                "Kamu mau dibantu untuk belanjanya juga, atau ada kebutuhan lain sekalian?"
            );
        }

        return "";
    }

    /* =========================================================
     * FALLBACK RESPONSE
     * ========================================================= */

    function fallbackResponse(reason) {
        if (
            reason ===
            "conversation_module_missing"
        ) {
            return (
                "Aku masih menyiapkan bagian percakapanku. " +
                "Coba sebentar lagi yaaa 😊"
            );
        }

        return (
            "Aku belum punya informasi yang cukup untuk " +
            "menjawabnya dengan tepat. Aku nggak mau asal nebak yaa 😊"
        );
    }

    function generateGatewayFallback(
        input,
        analysis,
        knowledge,
        discovery
    ) {
        /*
         * Fallback ini sengaja sederhana.
         * Personality utama tetap berada di Conversation.
         */

        if (
            analysis &&
            analysis.intent === "pricing_question"
        ) {
            const serviceName =
                knowledge &&
                knowledge.service &&
                knowledge.service.name
                    ? knowledge.service.name
                    : "layanan itu";

            return (
                "Untuk harga " +
                serviceName +
                ", aku belum punya data harga yang terverifikasi. " +
                "Aku nggak mau asal menyebut angka yaa 😊"
            );
        }

        if (
            analysis &&
            analysis.intent === "availability"
        ) {
            if (
                discovery &&
                discovery.status === "available" &&
                discovery.verified === true
            ) {
                return (
                    "Aku sudah mendapatkan hasil pengecekan " +
                    "yang bisa diverifikasi. Ada layanan yang " +
                    "sesuai berdasarkan data yang tersedia 😊"
                );
            }

            if (
                discovery &&
                discovery.status === "unavailable" &&
                discovery.verified === true
            ) {
                return (
                    "Aku sudah cek berdasarkan data yang tersedia, " +
                    "dan saat ini belum ada layanan yang bisa " +
                    "aku konfirmasi sesuai kebutuhanmu."
                );
            }

            return (
                "Sebentar yaaa, aku belum bisa memastikan " +
                "ketersediaannya karena hasil runtime yang " +
                "terverifikasi belum ada 😊"
            );
        }

        if (
            knowledge &&
            knowledge.service
        ) {
            const service =
                knowledge.service;

            return (
                service.name +
                " bisa membantu " +
                (
                    service.description ||
                    "sesuai kebutuhanmu."
                )
            );
        }

        return fallbackResponse(
            "insufficient_response"
        );
    }

    /* =========================================================
     * GUARDIAN
     * ========================================================= */

    function guardResponse(
        candidate,
        analysis,
        knowledge,
        discovery,
        options
    ) {
        const guardian =
            getGuardianModule();

        if (!guardian) {
            /*
             * Guardian merupakan fondasi wajib.
             * Jika tidak tersedia, jangan meneruskan candidate
             * sebagai jawaban final.
             */
            const blocked = {
                safe: false,
                status: "blocked",
                response:
                    "Aku belum bisa memberikan jawaban dengan aman " +
                    "karena penjaga kebenaran CGO belum siap.",
                original: candidate,
                warnings: [
                    "Guardian module tidak tersedia."
                ]
            };

            state.lastGuard = clone(blocked);

            return blocked;
        }

        const context = {
            conversationId:
                state.conversationId,

            turn: state.turn,

            knowledge: knowledge,

            discovery: discovery,

            evidence:
                discovery &&
                discovery.evidence
                    ? discovery.evidence
                    : discovery,

            runtimeConnected:
                !!(
                    getDiscoveryModule() &&
                    typeof getDiscoveryModule()
                        .isConnected ===
                        "function" &&
                    getDiscoveryModule().isConnected()
                ),

            authorized:
                options &&
                options.authorized === true,

            actionAuthorized:
                options &&
                options.actionAuthorized === true,

            humanApproved:
                options &&
                options.humanApproved === true,

            service:
                analysis &&
                analysis.candidateService
                    ? analysis.candidateService
                    : null,

            intent:
                analysis &&
                analysis.intent
                    ? analysis.intent
                    : null,

            needs:
                analysis &&
                Array.isArray(analysis.needs)
                    ? analysis.needs
                    : []
        };

        let result;

        if (
            typeof guardian.guard ===
            "function"
        ) {
            result = guardian.guard(
                candidate,
                context
            );
        } else {
            result = {
                safe: false,
                status: "blocked",
                response:
                    "Aku belum bisa memberikan jawaban dengan aman.",
                warnings: [
                    "Guardian guard() tidak tersedia."
                ]
            };
        }

        state.lastGuard = clone(result);

        emit(EVENTS.GUARDED, clone(result));

        return result;
    }

    /* =========================================================
     * RESPONSE FINALIZATION
     * ========================================================= */

    function finalizeResponse(
        input,
        analysis,
        knowledge,
        discovery,
        candidate,
        options
    ) {
        const guardResult =
            guardResponse(
                candidate,
                analysis,
                knowledge,
                discovery,
                options
            );

        let finalResponse =
            guardResult &&
            typeof guardResult.response ===
                "string"
                ? guardResult.response
                : "";

        if (!finalResponse.trim()) {
            finalResponse =
                "Aku belum bisa memastikan jawabannya dengan cukup aman.";
        }

        finalResponse = finalResponse.trim();

        state.lastResponse = finalResponse;

        recordMessage(
            "assistant",
            finalResponse,
            {
                guardStatus:
                    guardResult.status,

                analysis:
                    clone(analysis),

                knowledge:
                    clone(knowledge),

                discovery:
                    clone(discovery)
            }
        );

        emit(EVENTS.RESPONSE, {
            conversationId:
                state.conversationId,

            turn:
                state.turn,

            input:
                input,

            response:
                finalResponse,

            guard:
                clone(guardResult)
        });

        return {
            response: finalResponse,

            guard:
                clone(guardResult),

            analysis:
                clone(analysis),

            knowledge:
                clone(knowledge),

            discovery:
                clone(discovery)
        };
    }

    /* =========================================================
     * MAIN SYNC PIPELINE
     * ========================================================= */

    function chat(input, options) {
        options = options || {};

        const text = normalizeInput(input);

        if (!text) {
            return {
                response:
                    "Aku dengerin kok 😊 Coba ceritain pelan-pelan.",
                status: "empty_input"
            };
        }

        state.lastInput = text;
        state.lastError = null;

        recordMessage(
            "user",
            text,
            {
                /*
                 * Turn final berasal dari Conversation setelah process().
                 * Metadata user memakai next turn sebagai preview agar
                 * urutan message tetap terbaca tanpa mengambil alih owner.
                 */
                turn: state.turn + 1
            }
        );

        try {
            /*
             * STEP 1 — CONVERSATION
             */
            const analysis =
                analyzeConversation(
                    text,
                    options
                );

            /*
             * STEP 2 — KNOWLEDGE
             */
            const knowledge =
                queryKnowledge(
                    text,
                    analysis,
                    options
                );

            /*
             * STEP 3 — DISCOVERY
             */
            let discovery = null;

            if (
                needsRuntimeDiscovery(
                    text,
                    analysis,
                    knowledge,
                    options
                )
            ) {
                discovery =
                    performDiscovery(
                        text,
                        analysis,
                        knowledge,
                        options
                    );
            } else {
                discovery = {
                    status: "not_required",
                    verified: false,
                    source: null
                };
            }

            /*
             * STEP 4 — RESPONSE CANDIDATE
             */
            const candidate =
                generateResponseCandidate(
                    text,
                    analysis,
                    knowledge,
                    discovery,
                    options
                );

            /*
             * STEP 5 — GUARDIAN
             */
            const result =
                finalizeResponse(
                    text,
                    analysis,
                    knowledge,
                    discovery,
                    candidate,
                    options
                );

            return result;
        } catch (error) {
            state.lastError = {
                message:
                    error.message,
                timestamp:
                    now()
            };

            emit(EVENTS.ERROR, {
                error:
                    clone(state.lastError),
                input:
                    text
            });

            const safeErrorResponse =
                "Aduh, bagian dalam CGO lagi mengalami kendala. " +
                "Aku nggak mau mengarang jawaban yaaa. " +
                "Coba ulangi sebentar lagi 😊";

            state.lastResponse =
                safeErrorResponse;

            recordMessage(
                "assistant",
                safeErrorResponse,
                {
                    error: true
                }
            );

            return {
                response:
                    safeErrorResponse,

                status: "error",

                error:
                    clone(state.lastError)
            };
        }
    }

    /* =========================================================
     * MAIN ASYNC PIPELINE
     * ========================================================= */

    async function chatAsync(
        input,
        options
    ) {
        options = options || {};

        const text =
            normalizeInput(input);

        if (!text) {
            return {
                response:
                    "Aku dengerin kok 😊 Coba ceritain pelan-pelan.",
                status: "empty_input"
            };
        }

        state.lastInput = text;
        state.lastError = null;

        recordMessage(
            "user",
            text,
            {
                /*
                 * Turn final berasal dari Conversation setelah process().
                 * Metadata user memakai next turn sebagai preview agar
                 * urutan message tetap terbaca tanpa mengambil alih owner.
                 */
                turn: state.turn + 1
            }
        );

        try {
            /*
             * STEP 1 — CONVERSATION
             */
            const analysis =
                analyzeConversation(
                    text,
                    options
                );

            /*
             * STEP 2 — KNOWLEDGE
             */
            const knowledge =
                queryKnowledge(
                    text,
                    analysis,
                    options
                );

            /*
             * STEP 3 — DISCOVERY ASYNC
             */
            let discovery = null;

            if (
                needsRuntimeDiscovery(
                    text,
                    analysis,
                    knowledge,
                    options
                )
            ) {
                discovery =
                    await performDiscoveryAsync(
                        text,
                        analysis,
                        knowledge,
                        options
                    );
            } else {
                discovery = {
                    status: "not_required",
                    verified: false,
                    source: null
                };
            }

            /*
             * STEP 4 — RESPONSE CANDIDATE
             */
            const candidate =
                generateResponseCandidate(
                    text,
                    analysis,
                    knowledge,
                    discovery,
                    options
                );

            /*
             * STEP 5 — GUARDIAN
             */
            const result =
                finalizeResponse(
                    text,
                    analysis,
                    knowledge,
                    discovery,
                    candidate,
                    options
                );

            return result;
        } catch (error) {
            state.lastError = {
                message:
                    error.message,
                timestamp:
                    now()
            };

            emit(EVENTS.ERROR, {
                error:
                    clone(state.lastError),
                input:
                    text
            });

            const safeErrorResponse =
                "Aku lagi mengalami kendala di bagian dalam. " +
                "Aku nggak mau asal jawab yaaa 😊";

            state.lastResponse =
                safeErrorResponse;

            recordMessage(
                "assistant",
                safeErrorResponse,
                {
                    error: true
                }
            );

            return {
                response:
                    safeErrorResponse,

                status: "error",

                error:
                    clone(state.lastError)
            };
        }
    }

    /* =========================================================
     * SERVICE API
     * ========================================================= */

    function getServices() {
        const knowledge =
            getKnowledgeModule();

        if (
            knowledge &&
            typeof knowledge.getServices ===
                "function"
        ) {
            return clone(
                knowledge.getServices()
            );
        }

        return [];
    }

    function registerService(service) {
        const knowledge =
            getKnowledgeModule();

        if (
            !knowledge ||
            typeof knowledge.registerService !==
                "function"
        ) {
            return {
                success: false,
                reason:
                    "Knowledge module belum siap."
            };
        }

        return knowledge.registerService(
            service
        );
    }

    function getService(serviceId) {
        const knowledge =
            getKnowledgeModule();

        if (
            knowledge &&
            typeof knowledge.getService ===
                "function"
        ) {
            return clone(
                knowledge.getService(
                    serviceId
                )
            );
        }

        return null;
    }

    /* =========================================================
     * SERVICE HANDOFF
     * ========================================================= */

    function openService(serviceId, options) {
        options = options || {};

        const service =
            getService(serviceId);

        if (!service) {
            return {
                success: false,
                reason:
                    "Service tidak ditemukan."
            };
        }

        const navigation =
            window.CGO_CUSTOMER.navigation;

        /*
         * Gateway tidak melakukan navigasi palsu.
         * Kalau adapter navigation tersedia, baru diteruskan.
         */
        if (
            navigation &&
            typeof navigation.openService ===
                "function"
        ) {
            return navigation.openService(
                service,
                options
            );
        }

        return {
            success: false,
            status: "navigation_not_connected",
            service: clone(service),
            reason:
                "Navigation adapter belum terhubung."
        };
    }

    /* =========================================================
     * RUNTIME CONNECTION
     * ========================================================= */

    function connectDiscovery(adapter) {
        const discovery =
            getDiscoveryModule();

        if (
            !discovery ||
            typeof discovery.connect !==
                "function"
        ) {
            return {
                success: false,
                reason:
                    "Discovery module belum tersedia."
            };
        }

        return discovery.connect(
            adapter
        );
    }

    function disconnectDiscovery() {
        const discovery =
            getDiscoveryModule();

        if (
            discovery &&
            typeof discovery.disconnect ===
                "function"
        ) {
            return discovery.disconnect();
        }

        return {
            success: false,
            reason:
                "Discovery module belum tersedia."
        };
    }

    function connectRuntime(adapter) {
        /*
         * Alias semantik untuk runtime discovery.
         *
         * Tidak membuat external API.
         */
        return connectDiscovery(
            adapter
        );
    }

    /* =========================================================
     * NAVIGATION CONNECTION
     * ========================================================= */

    function connectNavigation(adapter) {
        if (
            !adapter ||
            typeof adapter !== "object"
        ) {
            return {
                success: false,
                reason:
                    "Navigation adapter tidak valid."
            };
        }

        window.CGO_CUSTOMER.navigation =
            adapter;

        return {
            success: true,
            connected: true
        };
    }

    /* =========================================================
     * CONVERSATION CONTROL
     * ========================================================= */

    function resetConversation() {
        state.conversationId =
            createConversationId();

        state.turn = 0;

        state.messages = [];

        state.lastInput = "";

        state.lastResponse = "";

        state.lastAnalysis = null;

        state.lastKnowledge = null;

        state.lastDiscovery = null;

        state.lastGuard = null;

        state.pendingDiscovery = null;

        state.pendingQuestion = null;

        state.currentTopic =
            "conversation";

        state.currentIntent =
            "conversation";

        state.currentMood =
            "neutral";

        state.candidateService = null;

        state.combinedServiceCandidate =
            null;

        state.mentionedServices = [];

        state.detectedNeeds = [];

        state.lastError = null;

        const conversation =
            getConversationModule();

        if (
            conversation &&
            typeof conversation.reset ===
                "function"
        ) {
            try {
                conversation.reset();
            } catch (error) {
                console.warn(
                    "[CGO CUSTOMER] conversation reset error:",
                    error
                );
            }
        }

        emit(EVENTS.RESET, {
            conversationId:
                state.conversationId,
            timestamp:
                now()
        });

        return {
            success: true,
            conversationId:
                state.conversationId
        };
    }

    /* =========================================================
     * CONTEXT
     * ========================================================= */

    function getConversation() {
        return clone(
            state.messages
        );
    }

    function getState() {
        const discovery =
            getDiscoveryModule();

        let discoveryConnected =
            false;

        if (
            discovery &&
            typeof discovery.isConnected ===
                "function"
        ) {
            discoveryConnected =
                discovery.isConnected();
        }

        return clone({
            version:
                state.version,

            ready:
                isReady(),

            modules:
                getModuleStatus(),

            conversationId:
                state.conversationId,

            turn:
                state.turn,

            lastInput:
                state.lastInput,

            lastResponse:
                state.lastResponse,

            currentTopic:
                state.currentTopic,

            currentIntent:
                state.currentIntent,

            currentMood:
                state.currentMood,

            candidateService:
                state.candidateService,

            combinedServiceCandidate:
                state.combinedServiceCandidate,

            mentionedServices:
                state.mentionedServices,

            detectedNeeds:
                state.detectedNeeds,

            pendingDiscovery:
                state.pendingDiscovery,

            lastAnalysis:
                state.lastAnalysis,

            lastKnowledge:
                state.lastKnowledge,

            lastDiscovery:
                state.lastDiscovery,

            lastGuard:
                state.lastGuard,

            discoveryConnected:
                discoveryConnected,

            lastError:
                state.lastError
        });
    }

    /* =========================================================
     * READY CHECK
     * ========================================================= */

    function refreshReadyState() {
        const previous =
            state.ready;

        state.ready =
            isReady();

        if (
            state.ready &&
            previous !== true
        ) {
            emit(EVENTS.READY, {
                version:
                    VERSION,

                modules:
                    getModuleStatus(),

                timestamp:
                    now()
            });
        }

        return state.ready;
    }

    /* =========================================================
     * PUBLIC API
     * ========================================================= */

    const CGO = {

        version:
            VERSION,

        EVENTS:
            EVENTS,

        chat:
            chat,

        chatAsync:
            chatAsync,

        resetConversation:
            resetConversation,

        getConversation:
            getConversation,

        getState:
            getState,

        isReady:
            function () {
                return refreshReadyState();
            },

        getModuleStatus:
            getModuleStatus,

        getServices:
            getServices,

        getService:
            getService,

        registerService:
            registerService,

        openService:
            openService,

        connectDiscovery:
            connectDiscovery,

        disconnectDiscovery:
            disconnectDiscovery,

        connectRuntime:
            connectRuntime,

        connectNavigation:
            connectNavigation,

        on:
            on
    };

    /*
     * PUBLIC GLOBAL GATEWAY
     */
    window.CGO = CGO;

    /*
     * Pastikan state readiness dihitung setelah semua object
     * global yang sudah tersedia dibaca.
     */
    state.ready =
        isReady();

    emit(EVENTS.READY, {
        version:
            VERSION,

        ready:
            state.ready,

        modules:
            getModuleStatus(),

        timestamp:
            now()
    });

    console.log(
        "[CGO CUSTOMER] Gateway ready:",
        VERSION
    );

})(window);
