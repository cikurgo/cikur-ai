/* ============================================================
 * CIKUR GO — CUSTOMER CGO MAIN GATEWAY
 * ------------------------------------------------------------
 * File    : cgo-customer.js
 * Version : 1.1.0-customer-gateway
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

    const VERSION = "1.1.2-customer-gateway";

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

        let text;
        if (typeof input === "string") {
            text = input.trim();
        } else if (typeof input === "object") {
            if (typeof input.text === "string") {
                text = input.text.trim();
            } else if (typeof input.message === "string") {
                text = input.message.trim();
            } else if (typeof input.input === "string") {
                text = input.input.trim();
            } else {
                text = String(input).trim();
            }
        } else {
            text = String(input).trim();
        }

        return expandInformalEnglish(text);
    }

    /*
     * Memperluas singkatan/gaya chat santai Bahasa Inggris (mis. "who are u",
     * "can u help me") menjadi bentuk baku ("who are you", "can you help me")
     * SEBELUM masuk ke pencocokan pola di modul lain. Ini supaya pola yang
     * sudah terdaftar (mis. "who are you") tetap kena walau user menulis
     * versi singkatnya. Tidak mengubah teks yang tampil ke user di UI —
     * hanya memengaruhi teks yang dipakai untuk analisis internal.
     */
    function expandInformalEnglish(text) {
        if (!text) return text;

        const replacements = [
            [/\bu r\b/gi, "you are"],
            [/\bur\b/gi, "your"],
            [/\by['’]?a\b/gi, "you"],
            [/\bu\b/gi, "you"],
            [/\br\b/gi, "are"],
            [/\bpls\b/gi, "please"],
            [/\bplz\b/gi, "please"],
            [/\bthx\b/gi, "thanks"],
            [/\bty\b/gi, "thank you"],
            [/\bwanna\b/gi, "want to"],
            [/\bgonna\b/gi, "going to"],
            [/\bgimme\b/gi, "give me"],
            [/\bidk\b/gi, "i don't know"],
            [/\bhelp me\b/gi, "help me"]
        ];

        let result = text;

        // Hanya jalankan penggantian "r" -> "are" dan "u" -> "you" kalau kalimatnya
        // sudah kelihatan Bahasa Inggris (ada kata Inggris umum lain), supaya tidak
        // salah mengubah kalimat Bahasa Indonesia yang kebetulan punya huruf "u"/"r" tunggal.
        const looksEnglish =
            /\b(who|what|can|are|is|you|help|the|how|why|when|where)\b/i.test(result);

        replacements.forEach(([pattern, replacement]) => {
            if ((pattern.source === "\\bu\\b" || pattern.source === "\\br\\b") && !looksEnglish) {
                return;
            }
            result = result.replace(pattern, replacement);
        });

        return result;
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

    function getMemoryModule() {
        return window.CGO_CUSTOMER.memory || null;
    }

    function getPlannerModule() {
        return window.CGO_CUSTOMER.planner || null;
    }

    function getMetaModule() {
        return window.CGO_CUSTOMER.meta || null;
    }

    function getBoundaryModule() {
        return window.CGO_CUSTOMER.boundary || null;
    }

    function getComposerModule() {
        return window.CGO_CUSTOMER.composer || null;
    }

    /* =========================================================
     * MODULE STATUS
     * ========================================================= */

    function getModuleStatus() {
        return {
            conversation: !!getConversationModule(),
            knowledge: !!getKnowledgeModule(),
            discovery: !!getDiscoveryModule(),
            guardian: !!getGuardianModule(),
            memory: !!getMemoryModule(),
            planner: !!getPlannerModule(),
            meta: !!getMetaModule(),
            boundary: !!getBoundaryModule(),
            composer: !!getComposerModule()
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

        /*
         * Conversation.process() returns an envelope. The actual turn
         * interpretation lives in result.classification. Normalize it
         * here so Knowledge/Discovery/Guardian reason over the same
         * semantic object instead of accidentally receiving the envelope.
         */
        if (result && result.classification && typeof result.classification === "object") {
            const envelope = result;
            result = {
                ...clone(result.classification),
                conversationResult: clone(envelope),
                conversationState: clone(envelope.state || null),
                transition: clone(envelope.transition || null),
                meta: clone(envelope.meta || null)
            };
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
            analysis.candidateService &&
            typeof knowledge.getService === "function"
        ) {
            const serviceId =
                typeof analysis.candidateService === "string"
                    ? analysis.candidateService
                    : analysis.candidateService.id;

            const service =
                knowledge.getService(serviceId);

            if (service) {
                result = {
                    status: "complete",
                    known: true,
                    service: service,
                    source: "service_registry"
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
            analysis.shouldCheckAvailability === true
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
         * Explicit live-availability phrases should trigger
         * discovery even before a concrete service candidate
         * is resolved from knowledge.
         */
        const text = String(input || "").toLowerCase();
        const runtimeWords = [
            "sekarang",
            "saat ini",
            "ada nggak",
            "ada gak",
            "ada ga",
            "ada yang bisa",
            "ada yang tersedia",
            "tersedia",
            "dekat aku",
            "dekat saya",
            "sekitar sini",
            "sekitar aku",
            "sekitar saya",
            "bisa datang",
            "bisa antar",
            "bisa jemput",
            "siapa yang tersedia",
            "siapa yang bisa jemput",
            "available now"
        ];

        if (
            runtimeWords.some(function (word) {
                return text.indexOf(word) !== -1;
            })
        ) {
            return true;
        }

        /*
         * Knowledge can still declare discovery is required
         * for the matched service.
         */
        if (
            knowledge &&
            knowledge.service &&
            knowledge.service.discovery &&
            knowledge.service.discovery.required === true
        ) {
            return true;
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
         * Prefer the response already produced by conversation.process()
         * during analyzeConversation. That path already ran natural
         * reasoning with the correct conversation state (lastMath,
         * preferredLanguage, etc). Re-generating without that state
         * would break multi-turn math and language continuity.
         */
        if (
            analysis &&
            analysis.conversationResult &&
            analysis.conversationResult.text
        ) {
            response = analysis.conversationResult.text;
        }

        /*
         * If process() did not yield a usable text, generate once more
         * but pass conversation state (not gateway state) so reasoning
         * continuity is preserved.
         */
        if (
            (typeof response !== "string" || !response.trim()) &&
            conversation &&
            typeof conversation.generateResponse === "function"
        ) {
            const conversationState =
                typeof conversation.getState === "function"
                    ? conversation.getState()
                    : analysis && analysis.conversationState
                      ? analysis.conversationState
                      : {};

            response = conversation.generateResponse(
                analysis,
                {
                    analysis: analysis,
                    knowledge: knowledge,
                    discovery: discovery,
                    state: conversationState,
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
        // --- New brain layers: Boundary → Planner → Meta → Composer ---
        let enrichedCandidate = candidate;
        try {
            const boundary = getBoundaryModule();
            const planner = getPlannerModule();
            const meta = getMetaModule();
            const composer = getComposerModule();
            const memory = getMemoryModule();
            const lang =
                (analysis && analysis.lang) ||
                (options && options.lang) ||
                "id";

            // Boundary first
            let boundaryResult = null;
            if (boundary && typeof boundary.check === "function") {
                boundaryResult = boundary.check(
                    typeof input === "string" ? input : (input && input.text) || "",
                    lang
                );
            }

            // Build plan from analysis + reasoning state
            let planResult = null;
            if (planner && typeof planner.plan === "function") {
                const conv = getConversationModule();
                let reasoningState = {};
                try {
                    if (conv && typeof conv.getState === "function") {
                        const st = conv.getState();
                        reasoningState = (st && st.reasoning) || {};
                    }
                } catch (e) {}
                const memSuggest =
                    memory && typeof memory.suggestFor === "function"
                        ? memory.suggestFor(
                              state.currentTopic ||
                                  reasoningState.lastTopic ||
                                  "general"
                          )
                        : null;
                planResult = planner.plan({
                    needs:
                        state.detectedNeeds ||
                        (analysis && analysis.needs) ||
                        reasoningState.activeNeeds ||
                        [],
                    constraints: reasoningState.constraints || null,
                    emotion:
                        reasoningState.lastEmotion ||
                        state.currentMood ||
                        (analysis && analysis.mood) ||
                        null,
                    emotionStrength: reasoningState.emotionStrength || null,
                    preferences: reasoningState.preferences || [],
                    topic: state.currentTopic || (analysis && analysis.topic) || null,
                    memorySuggest: memSuggest,
                    lang: lang
                });
            }

            // Meta decision
            let metaResult = null;
            if (meta && typeof meta.evaluate === "function") {
                const hasVerified =
                    discovery &&
                    (discovery.status === "verified" ||
                        discovery.verified === true);
                metaResult = meta.evaluate({
                    plan: planResult,
                    knowledge: knowledge,
                    discovery: discovery,
                    hasVerifiedRuntime: !!hasVerified,
                    lang: lang
                });
            }

            // Composer: assemble / enrich text
            if (composer && typeof composer.compose === "function") {
                const baseText =
                    (candidate &&
                        (candidate.text ||
                            candidate.response ||
                            (typeof candidate === "string" ? candidate : ""))) ||
                    "";
                const composed = composer.compose({
                    plan: planResult,
                    meta: metaResult,
                    boundary: boundaryResult,
                    baseText: baseText,
                    lang: lang
                });
                if (composed && composed.text) {
                    if (typeof enrichedCandidate === "string") {
                        enrichedCandidate = composed.text;
                    } else if (enrichedCandidate && typeof enrichedCandidate === "object") {
                        enrichedCandidate = clone(enrichedCandidate);
                        enrichedCandidate.text = composed.text;
                        enrichedCandidate.response = composed.text;
                        enrichedCandidate.mode =
                            composed.mode || enrichedCandidate.mode;
                    } else {
                        enrichedCandidate = {
                            text: composed.text,
                            response: composed.text,
                            mode: composed.mode
                        };
                    }
                }
            } else if (boundaryResult && boundaryResult.allowed === false) {
                enrichedCandidate = {
                    text: boundaryResult.softRedirect,
                    response: boundaryResult.softRedirect,
                    mode: "boundary_redirect"
                };
            }
        } catch (layerErr) {
            // New layers must never break the core path
        }

        const guardResult =
            guardResponse(
                enrichedCandidate,
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

        // Soft durable memory: ingest meaningful session signals
        try {
            const memory = getMemoryModule();
            if (memory && typeof memory.ingestSession === "function") {
                const conv = getConversationModule();
                const reasoningState =
                    (conv &&
                        typeof conv.getState === "function" &&
                        conv.getState() &&
                        conv.getState().reasoning) ||
                    state.lastAnalysis?.reasoning ||
                    {};
                memory.ingestSession({
                    lastTopic:
                        state.currentTopic ||
                        reasoningState.lastTopic ||
                        null,
                    topic: state.currentTopic || null,
                    preferences: reasoningState.preferences || [],
                    lastEmotion:
                        reasoningState.lastEmotion ||
                        state.currentMood ||
                        null,
                    emotionStrength: reasoningState.emotionStrength || null,
                    activeNeeds:
                        state.detectedNeeds ||
                        reasoningState.activeNeeds ||
                        [],
                    constraints: reasoningState.constraints || null
                });
            }
        } catch (memErr) {
            // Memory must never break the response path
        }

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

        state.turn += 1;

        state.lastInput = text;
        state.lastError = null;

        recordMessage(
            "user",
            text,
            {
                turn: state.turn
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

            /* Lampirkan jejak ABC ke metadata (tidak mengubah jawaban alami kecuali diminta formal) */
            if (result && typeof result === "object" && abcResult) {
                result.machineAbc = {
                    ok: !!abcResult.ok,
                    status: abcResult.status || null,
                    confidence: abcResult.confidence ?? null,
                    audit: abcResult.audit?.status || null,
                    engine: abcResult.version || abcResult.engine || null
                };
                if (
                    abcResult.ok &&
                    options &&
                    (options.includeAbcHint === true ||
                        /mesin abc|hasil audit|laporan formal/i.test(text))
                ) {
                    const hint = formatAbcHint(abcResult);
                    if (hint) {
                        if (typeof result.response === "string") {
                            result.response = result.response + hint;
                        } else if (typeof result.text === "string") {
                            result.text = result.text + hint;
                        }
                    }
                }
            }

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


    /* =========================================================
     * MESIN ABC — formal structure pass (opsional, non-blocking)
     * Tidak mengganti kepribadian chat; hanya memperkuat bukti
     * saat input butuh verifikasi / struktur.
     * ========================================================= */
    function shouldUseMachineAbc(text, options) {
        options = options || {};
        // Prefer lapisan kognisi terpusat (sistem + customer)
        try {
            if (window.CGOAbcCognition && typeof window.CGOAbcCognition.shouldEnrich === "function") {
                return window.CGOAbcCognition.shouldEnrich(text, options);
            }
        } catch (_e) {}
        if (options.forceAbc === true) return true;
        if (options.skipAbc === true) return false;
        const s = String(text || "");
        if (s.length < 6) return false;
        if (/\b(verifikasi|audit|mesin\s*abc|self-?test|cek struktur|format json|periksa html|analisis (kode|struktur|sistem)|bcgo|telemetry|kontrak)\b/i.test(s)) return true;
        const trimmed = s.trim();
        if (trimmed.length >= 20 && ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]")))) return true;
        if (trimmed.length >= 60 && /<\s*(html|div|script|style)\b/i.test(s)) return true;
        if (trimmed.length >= 80 && /\b(function\s+|export\s+|import\s+)/.test(s)) return true;
        return false;
    }

    function runMachineAbc(text, options) {
        options = options || {};
        try {
            if (window.CGOAbcCognition && typeof window.CGOAbcCognition.analyze === "function") {
                return window.CGOAbcCognition.analyze(text, options);
            }
            const bridge = window.CGOMachineABCBridge;
            if (bridge && typeof bridge.analyze === "function") {
                return bridge.analyze(text, {
                    maxCycles: 1,
                    autoReflect: false,
                    fast: true,
                    skipAudit: true
                });
            }
            const eng = window.CGOMachineABC || window.CGO_MACHINE_ABC || window.CGOCoreMachine;
            if (eng && typeof eng.process === "function" && !eng.isPaused()) {
                const out = eng.process(text, { maxCycles: 1, fast: true, skipAudit: true });
                return {
                    ok: true,
                    engine: "CGO_MACHINE_ABC",
                    version: eng.version,
                    status: out?.result?.status || null,
                    confidence: out?.result?.decision?.confidence ?? null,
                    summary: out?.result?.summary || null,
                    findings: out?.result?.findings || [],
                    audit: out?.audit || null,
                    packet: out
                };
            }
        } catch (err) {
            return { ok: false, error: String(err && err.message || err) };
        }
        return null;
    }

    function runMachineAbcWithTimeout(text, options, ms) {
        ms = typeof ms === "number" ? ms : 90;
        return new Promise(function (resolve) {
            var done = false;
            var timer = setTimeout(function () {
                if (done) return;
                done = true;
                resolve({ ok: false, timeout: true, error: "abc_timeout" });
            }, ms);
            try {
                var result = runMachineAbc(text, options);
                if (!done) {
                    done = true;
                    clearTimeout(timer);
                    resolve(result);
                }
            } catch (e) {
                if (!done) {
                    done = true;
                    clearTimeout(timer);
                    resolve({ ok: false, error: String(e && e.message || e) });
                }
            }
        });
    }

    function formatAbcHint(abc) {
        if (!abc || !abc.ok) return "";
        try {
            if (window.CGOAbcCognition && typeof window.CGOAbcCognition.formatHint === "function") {
                return window.CGOAbcCognition.formatHint(abc, "customer");
            }
        } catch (_f) {}
        const conf = abc.confidence != null
            ? Math.round(Number(abc.confidence) * 100) + "%"
            : "–";
        const n = (abc.findings && abc.findings.length) || 0;
        const audit = (abc.audit && abc.audit.status) || "–";
        return (
            "\n\n〔Mesin ABC〕 status " +
            (abc.status || "–") +
            " · keyakinan " +
            conf +
            " · temuan " +
            n +
            " · audit " +
            audit
        );
    }


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

        state.turn += 1;

        state.lastInput = text;
        state.lastError = null;

        recordMessage(
            "user",
            text,
            {
                turn: state.turn
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
             * STEP 1b — MESIN ABC (opsional)
             * Hanya jika input butuh cek struktur/verifikasi.
             * Gagal / absen → chat tetap jalan normal.
             */
            let abcResult = null;
            try {
                if (shouldUseMachineAbc(text, options)) {
                    abcResult = await runMachineAbcWithTimeout(text, options, 90);
                    if (abcResult && abcResult.timeout) {
                        abcResult = { ok: false, timeout: true };
                    }
                    if (abcResult && analysis && typeof analysis === "object") {
                        analysis.machineAbc = {
                            ok: !!abcResult.ok,
                            status: abcResult.status || null,
                            confidence: abcResult.confidence ?? null,
                            audit: abcResult.audit?.status || null,
                            findingsCount: (abcResult.findings || []).length,
                            error: abcResult.error || null,
                            timeout: !!abcResult.timeout
                        };
                    }
                }
            } catch (_abcErr) {
                abcResult = null;
            }

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
