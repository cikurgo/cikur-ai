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

    const VERSION = "1.2.1-customer-natural-qa-gateway";

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

    function getBrainModule() {
        return (
            window.CGO_BRAIN ||
            window.CGO_INTERNAL_BRAIN ||
            window.CGO_CUSTOMER.brain ||
            null
        );
    }

    function connectBrain(brain) {
        if (!brain || typeof brain.ask !== "function") return false;
        window.CGO_CUSTOMER.brain = brain;

        // The Brain is also the internal bridge for live Agent CGO presence.
        // No external AI/API is introduced here. Discovery only receives
        // presence/location evidence exposed by the internal browser bridge.
        const discovery = getDiscoveryModule();
        if (discovery && typeof discovery.connect === "function" &&
            (typeof brain.findNearbyAgents === "function" || typeof brain.getCustomerLocation === "function")) {
            const bridge = {
                getCustomerLocation: typeof brain.getCustomerLocation === "function"
                    ? (options) => brain.getCustomerLocation(options || {})
                    : undefined,
                findNearby: typeof brain.findNearbyAgents === "function"
                    ? (request) => brain.findNearbyAgents(request || {})
                    : undefined,
                check: typeof brain.findNearbyAgents === "function"
                    ? (request) => brain.findNearbyAgents(request || {})
                    : undefined,
                setPresenceQueryResolver: typeof brain.setPresenceQueryResolver === "function"
                    ? (resolver) => brain.setPresenceQueryResolver(resolver)
                    : undefined,
                getPresenceContract: typeof brain.getPresenceContract === "function"
                    ? () => brain.getPresenceContract()
                    : undefined
            };
            if (typeof brain.setPresenceQueryResolver === "function" && typeof window.CikurCloud?.findNearbyAgentPresence === "function") {
                try {
                    brain.setPresenceQueryResolver((request) => window.CikurCloud.findNearbyAgentPresence(request || {}));
                } catch (error) {
                    emit(EVENTS.ERROR, { stage: "agent_presence_resolver", message: error?.message || String(error) });
                }
            }
            try { discovery.connect(bridge); } catch (error) {
                emit(EVENTS.ERROR, { stage: "brain_discovery_bridge", message: error?.message || String(error) });
            }
        }

        emit("brain_connected", {
            version: typeof brain.getVersion === "function" ? brain.getVersion() : brain.version || null,
            at: now(),
            discoveryBridge: !!(typeof brain.findNearbyAgents === "function" || typeof brain.getCustomerLocation === "function")
        });
        return true;
    }

    function shouldDelegateToBrain(text) {
        const q = String(text || "").toLowerCase();
        return /\b(cgo|bcgo|cikur go|sistem|file|berkas|kode|source|dependency|dependensi|relasi|hubungan|telemetry|anomaly|anomali|investigasi|root cause|error|bug|status sistem|perbaiki|perbaikan|patch)\b/.test(q);
    }

    function askBrainIfApplicable(input, analysis, knowledge, discovery) {
        const brain = getBrainModule();
        if (!brain || typeof brain.ask !== "function") return null;
        const text = normalizeInput(input);
        if (!shouldDelegateToBrain(text)) return null;
        if (analysis && ["availability", "order", "location", "action"].includes(analysis.intent)) return null;
        try {
            const result = brain.ask({
                text,
                source: "CGO_CUSTOMER",
                analysis: clone(analysis || {}),
                knowledge: clone(knowledge || {}),
                discovery: clone(discovery || {})
            });
            const answer = typeof result === "string" ? result :
                result && typeof result.text === "string" ? result.text :
                result && typeof result.response === "string" ? result.response : null;
            return answer && answer.trim() ? answer.trim() : null;
        } catch (error) {
            emit(EVENTS.ERROR, { stage: "brain", message: error?.message || String(error) });
            return null;
        }
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
            brain: !!getBrainModule() && typeof getBrainModule().ask === "function"
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
         * Knowledge dapat menyatakan discovery diperlukan.
         */
        if (
            knowledge &&
            knowledge.service &&
            knowledge.service.discovery &&
            knowledge.service.discovery.required === true
        ) {
            /*
             * Tetapi hanya ketika customer benar-benar meminta
             * kondisi sekarang atau tindakan nyata.
             */
            const text = input.toLowerCase();

            const runtimeWords = [
                "sekarang",
                "saat ini",
                "ada nggak",
                "ada gak",
                "ada ga",
                "tersedia",
                "dekat aku",
                "dekat saya",
                "sekitar sini",
                "sekitar aku",
                "sekitar saya",
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

            location:
                options.location ||
                (analysis && analysis.location) ||
                null,

            radiusKm:
                Number.isFinite(Number(options.radiusKm))
                    ? Number(options.radiusKm)
                    : undefined,

            locationOptions:
                options.locationOptions &&
                typeof options.locationOptions === "object"
                    ? clone(options.locationOptions)
                    : {},

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

                radiusKm:
                    Number.isFinite(Number(options.radiusKm))
                        ? Number(options.radiusKm)
                        : undefined,

                locationOptions:
                    options.locationOptions &&
                    typeof options.locationOptions === "object"
                        ? clone(options.locationOptions)
                        : {},

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

        const DISCOVERY_TIMEOUT_MS = 15000;

        state.pendingDiscovery = clone(request);

        emit(
            EVENTS.DISCOVERY_STARTED,
            clone(request)
        );

        let result;

        try {
            const discoveryPromise =
                typeof discovery.screenAsync ===
                "function"
                    ? discovery.screenAsync(request)
                    : typeof discovery.findNearbyAsync ===
                      "function"
                        ? discovery.findNearbyAsync(request)
                        : null;

            if (discoveryPromise) {
                let timeoutHandle;
                try {
                    result = await Promise.race([
                        discoveryPromise,
                        new Promise((resolve) => {
                            timeoutHandle = setTimeout(() => {
                                resolve({
                                    status: "unknown",
                                    verified: false,
                                    source: null,
                                    timeout: true,
                                    reason:
                                        "Discovery timeout: data live belum selesai diverifikasi dalam batas waktu."
                                });
                            }, DISCOVERY_TIMEOUT_MS);
                        })
                    ]);
                } finally {
                    if (timeoutHandle) clearTimeout(timeoutHandle);
                }
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
         * Response generator milik Conversation tetap menjadi
         * sumber personality dan natural conversation.
         */
        if (
            typeof conversation.generateResponse ===
            "function"
        ) {
            response =
                conversation.generateResponse(
                    input,
                    {
                        analysis: analysis,
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
                discovery.status === "available" &&
                discovery.verified === true &&
                Array.isArray(discovery.items) &&
                discovery.items.some(item => Number.isFinite(item.distanceKm))
            ) {
                const items = discovery.items;
                const first = items[0];
                const distance = first && Number.isFinite(first.distanceKm)
                    ? `${first.distanceKm < 1 ? Math.round(first.distanceKm * 1000) + " meter" : first.distanceKm.toFixed(1) + " km"}`
                    : null;
                return `Aku menemukan ${items.length} Agent CGO aktif di sekitar lokasi kamu${distance ? ", yang terdekat sekitar " + distance : ""}.`;
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
            const brainResponse = askBrainIfApplicable(
                text, analysis, knowledge, discovery
            );

            const candidate =
                brainResponse ||
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
            const brainResponse = askBrainIfApplicable(
                text, analysis, knowledge, discovery
            );

            const candidate =
                brainResponse ||
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

        connectBrain:
            connectBrain,

        getBrain:
            getBrainModule,

        connectNavigation:
            connectNavigation,

        on:
            on
    };

    /*
     * PUBLIC GLOBAL GATEWAY
     */
    window.CGO = CGO;

    try {
        if (getBrainModule()) connectBrain(getBrainModule());
        window.addEventListener("cgo-brain-ready", function () {
            connectBrain(getBrainModule());
            refreshReadyState();
        });
    } catch {}

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
