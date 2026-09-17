/* ============================================================
 * CIKUR GO — CUSTOMER CGO GUARDIAN
 * ------------------------------------------------------------
 * File    : cgo-customer-guardian.js
 * Version : 1.0.0-guardian
 *
 * Peran:
 *   Penjaga kebenaran dan keamanan jawaban CGO Customer.
 *
 * Prinsip utama:
 *   1. NEVER INVENT
 *   2. NEVER FAKE PROOF
 *   3. NEVER GUESS
 *   4. NEVER BYPASS AUTHORIZATION
 *   5. PERSONALITY NEVER OVERRIDES TRUTH
 *
 * Catatan arsitektur:
 *   - Tidak memakai external AI/API.
 *   - Tidak melakukan reasoning eksternal.
 *   - Tidak membuat data runtime sendiri.
 *   - Knowledge dan Runtime Discovery tetap dipisahkan.
 *   - Guardian hanya memvalidasi, menyaring, dan mengamankan
 *     klaim sebelum diberikan kepada customer.
 * ============================================================ */

(function (window) {
    "use strict";

    window.CGO_CUSTOMER = window.CGO_CUSTOMER || {};

    const VERSION = "1.0.0-guardian";

    const STATUS = Object.freeze({
        SAFE: "safe",
        SANITIZED: "sanitized",
        BLOCKED: "blocked",
        UNKNOWN: "unknown"
    });

    const CLAIM_TYPES = Object.freeze({
        KNOWLEDGE: "knowledge",
        RUNTIME: "runtime",
        AVAILABILITY: "availability",
        PRICE: "price",
        LOCATION: "location",
        STATUS: "status",
        CAPABILITY: "capability",
        ACTION: "action",
        AUTHORIZATION: "authorization",
        UNKNOWN: "unknown"
    });

    const EVIDENCE_LEVEL = Object.freeze({
        NONE: "none",
        WEAK: "weak",
        VERIFIED: "verified"
    });

    const RULES = Object.freeze({
        NEVER_INVENT: "NEVER_INVENT",
        NEVER_FAKE_PROOF: "NEVER_FAKE_PROOF",
        NEVER_GUESS: "NEVER_GUESS",
        NEVER_BYPASS_AUTHORIZATION: "NEVER_BYPASS_AUTHORIZATION",
        PERSONALITY_NEVER_OVERRIDES_TRUTH:
            "PERSONALITY_NEVER_OVERRIDES_TRUTH"
    });

    const state = {
        version: VERSION,
        lastStatus: STATUS.UNKNOWN,
        lastResult: null,
        lastClaims: [],
        lastWarnings: [],
        lastBlockedClaims: [],
        validationCount: 0,
        sanitizedCount: 0,
        blockedCount: 0
    };

    const listeners = {};

    /* =========================================================
     * UTILITIES
     * ========================================================= */

    function now() {
        return new Date().toISOString();
    }

    function makeId(prefix) {
        return (
            prefix +
            "-" +
            Date.now().toString(36) +
            "-" +
            Math.random().toString(36).slice(2, 8)
        );
    }

    function safeString(value) {
        if (value === null || value === undefined) {
            return "";
        }

        return String(value).trim();
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
                    "[CGO CUSTOMER GUARDIAN] listener error:",
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

    /* =========================================================
     * TEXT NORMALIZATION
     * ========================================================= */

    function normalizeText(text) {
        return safeString(text)
            .replace(/\s+/g, " ")
            .trim();
    }

    function lower(text) {
        return normalizeText(text).toLowerCase();
    }

    /* =========================================================
     * CLAIM DETECTION
     * ========================================================= */

    function containsAny(text, words) {
        const value = lower(text);

        return words.some(function (word) {
            return value.indexOf(lower(word)) !== -1;
        });
    }

    function detectClaimType(text) {
        const value = lower(text);

        if (
            containsAny(value, [
                "tersedia sekarang",
                "ada agent",
                "agent tersedia",
                "tersedia di sekitar",
                "bisa ditemukan",
                "sudah ditemukan",
                "ada driver",
                "driver tersedia",
                "restoran tersedia",
                "mitra tersedia"
            ])
        ) {
            return CLAIM_TYPES.AVAILABILITY;
        }

        if (
            containsAny(value, [
                "harganya",
                "harga",
                "biaya",
                "tarif",
                "rp",
                "rupiah"
            ])
        ) {
            return CLAIM_TYPES.PRICE;
        }

        if (
            containsAny(value, [
                "lokasinya",
                "berada di",
                "di sekitar",
                "alamat",
                "dekat kamu",
                "dekat sini"
            ])
        ) {
            return CLAIM_TYPES.LOCATION;
        }

        if (
            containsAny(value, [
                "sedang buka",
                "sedang tutup",
                "aktif",
                "nonaktif",
                "online",
                "offline",
                "statusnya"
            ])
        ) {
            return CLAIM_TYPES.STATUS;
        }

        if (
            containsAny(value, [
                "aku sudah cek",
                "saya sudah cek",
                "sudah saya cek",
                "sudah aku cek",
                "hasil pengecekan",
                "hasil cek",
                "aku menemukan",
                "saya menemukan",
                "ditemukan"
            ])
        ) {
            return CLAIM_TYPES.RUNTIME;
        }

        if (
            containsAny(value, [
                "aku bisa bantu",
                "cikur go bisa",
                "bisa digunakan untuk",
                "layanan ini membantu",
                "fungsi layanan",
                "layanan ini"
            ])
        ) {
            return CLAIM_TYPES.CAPABILITY;
        }

        if (
            containsAny(value, [
                "aku akan",
                "aku bisa langsung",
                "langsung aku",
                "saya akan",
                "saya bisa langsung",
                "langsung saya"
            ])
        ) {
            return CLAIM_TYPES.ACTION;
        }

        if (
            containsAny(value, [
                "izin",
                "otorisasi",
                "persetujuan",
                "persetujuan manusia",
                "approval"
            ])
        ) {
            return CLAIM_TYPES.AUTHORIZATION;
        }

        return CLAIM_TYPES.UNKNOWN;
    }

    /* =========================================================
     * RUNTIME / EVIDENCE DETECTION
     * ========================================================= */

    function normalizeEvidence(source) {
        if (!source || typeof source !== "object") {
            return {
                level: EVIDENCE_LEVEL.NONE,
                verified: false,
                source: null,
                items: []
            };
        }

        const items = Array.isArray(source.items)
            ? source.items
            : [];

        const explicitVerified =
            source.verified === true ||
            source.isVerified === true;

        const explicitSource =
            typeof source.source === "string" &&
            source.source.trim() !== "";

        const hasRuntimeId =
            typeof source.requestId === "string" &&
            source.requestId.trim() !== "";

        const hasData =
            items.length > 0 ||
            (source.data &&
                typeof source.data === "object" &&
                Object.keys(source.data).length > 0);

        if (explicitVerified && (explicitSource || hasRuntimeId || hasData)) {
            return {
                level: EVIDENCE_LEVEL.VERIFIED,
                verified: true,
                source: source.source || null,
                requestId: source.requestId || null,
                items: items,
                data: source.data || null
            };
        }

        if (explicitSource || hasData || hasRuntimeId) {
            return {
                level: EVIDENCE_LEVEL.WEAK,
                verified: false,
                source: source.source || null,
                requestId: source.requestId || null,
                items: items,
                data: source.data || null
            };
        }

        return {
            level: EVIDENCE_LEVEL.NONE,
            verified: false,
            source: null,
            requestId: null,
            items: [],
            data: null
        };
    }

    function isVerifiedRuntime(source) {
        const evidence = normalizeEvidence(source);

        return evidence.level === EVIDENCE_LEVEL.VERIFIED;
    }

    /* =========================================================
     * CONTEXT NORMALIZATION
     * ========================================================= */

    function normalizeContext(context) {
        context = context || {};

        const discovery =
            context.discovery ||
            context.discoveryResult ||
            context.runtimeResult ||
            null;

        const evidence = normalizeEvidence(
            context.evidence || discovery
        );

        return {
            knowledge:
                context.knowledge ||
                context.knowledgeResult ||
                null,

            discovery: discovery,

            evidence: evidence,

            runtimeConnected:
                context.runtimeConnected === true,

            authorized:
                context.authorized === true,

            humanApproved:
                context.humanApproved === true,

            actionAuthorized:
                context.actionAuthorized === true,

            service:
                context.service || null,

            intent:
                context.intent || null,

            needs:
                Array.isArray(context.needs)
                    ? context.needs
                    : []
        };
    }

    /* =========================================================
     * RULE EVALUATION
     * ========================================================= */

    function makeClaim(text, index) {
        return {
            id: makeId("claim"),
            index: index,
            text: normalizeText(text),
            type: detectClaimType(text),
            supported: false,
            verified: false,
            rule: null,
            severity: "none",
            reason: null
        };
    }

    function validateKnowledgeClaim(claim, context) {
        const knowledge = context.knowledge;

        if (!knowledge) {
            return {
                supported: false,
                verified: false,
                rule: RULES.NEVER_INVENT,
                severity: "high",
                reason: "Tidak ada sumber knowledge yang mendukung klaim."
            };
        }

        if (
            knowledge.known === true ||
            knowledge.status === "complete" ||
            knowledge.status === "known"
        ) {
            return {
                supported: true,
                verified: true,
                rule: null,
                severity: "none",
                reason: null
            };
        }

        return {
            supported: false,
            verified: false,
            rule: RULES.NEVER_INVENT,
            severity: "high",
            reason: "Klaim knowledge belum memiliki dasar yang cukup."
        };
    }

    function validateRuntimeClaim(claim, context) {
        const evidence = context.evidence;

        if (
            claim.type === CLAIM_TYPES.AVAILABILITY ||
            claim.type === CLAIM_TYPES.LOCATION ||
            claim.type === CLAIM_TYPES.STATUS ||
            claim.type === CLAIM_TYPES.RUNTIME
        ) {
            if (evidence.level === EVIDENCE_LEVEL.VERIFIED) {
                return {
                    supported: true,
                    verified: true,
                    rule: null,
                    severity: "none",
                    reason: null
                };
            }

            return {
                supported: false,
                verified: false,
                rule: RULES.NEVER_FAKE_PROOF,
                severity: "high",
                reason:
                    "Klaim runtime membutuhkan bukti runtime yang benar-benar terverifikasi."
            };
        }

        return null;
    }

    function validatePriceClaim(claim, context) {
        const knowledge = context.knowledge;

        if (
            knowledge &&
            knowledge.price &&
            knowledge.price.verified === true
        ) {
            return {
                supported: true,
                verified: true,
                rule: null,
                severity: "none",
                reason: null
            };
        }

        if (
            context.evidence &&
            context.evidence.level === EVIDENCE_LEVEL.VERIFIED &&
            context.evidence.data &&
            context.evidence.data.price !== undefined
        ) {
            return {
                supported: true,
                verified: true,
                rule: null,
                severity: "none",
                reason: null
            };
        }

        return {
            supported: false,
            verified: false,
            rule: RULES.NEVER_GUESS,
            severity: "high",
            reason:
                "Harga atau tarif tidak boleh dibuat tanpa sumber yang valid."
        };
    }

    function validateActionClaim(claim, context) {
        if (
            context.authorized === true ||
            context.actionAuthorized === true
        ) {
            return {
                supported: true,
                verified: true,
                rule: null,
                severity: "none",
                reason: null
            };
        }

        return {
            supported: false,
            verified: false,
            rule: RULES.NEVER_BYPASS_AUTHORIZATION,
            severity: "high",
            reason:
                "CGO tidak boleh menyatakan tindakan telah dilakukan tanpa otorisasi."
        };
    }

    function validateClaim(claimInput, context) {
        const contextData = normalizeContext(context);

        const claim =
            typeof claimInput === "object" && claimInput !== null
                ? Object.assign(
                      makeClaim(claimInput.text || "", 0),
                      claimInput
                  )
                : makeClaim(claimInput, 0);

        let result = null;

        if (claim.type === CLAIM_TYPES.PRICE) {
            result = validatePriceClaim(claim, contextData);
        }

        if (!result) {
            result = validateRuntimeClaim(claim, contextData);
        }

        if (!result && claim.type === CLAIM_TYPES.ACTION) {
            result = validateActionClaim(claim, contextData);
        }

        if (!result && claim.type === CLAIM_TYPES.CAPABILITY) {
            result = validateKnowledgeClaim(claim, contextData);
        }

        if (!result && claim.type === CLAIM_TYPES.RUNTIME) {
            result = validateRuntimeClaim(claim, contextData);
        }

        if (!result) {
            /*
             * Klaim percakapan biasa tidak otomatis dianggap fakta.
             * Guardian hanya menganggapnya aman apabila tidak mengandung
             * klaim runtime/faktual yang membutuhkan bukti khusus.
             */
            result = {
                supported: true,
                verified: false,
                rule: null,
                severity: "none",
                reason: null
            };
        }

        claim.supported = result.supported;
        claim.verified = result.verified;
        claim.rule = result.rule;
        claim.severity = result.severity;
        claim.reason = result.reason;

        return claim;
    }

    /* =========================================================
     * UNSAFE CLAIM PATTERNS
     * ========================================================= */

    function containsUnsupportedRuntimeClaim(text) {
        return containsAny(text, [
            "sudah aku cek",
            "sudah saya cek",
            "aku sudah menemukan",
            "saya sudah menemukan",
            "ternyata ada agent",
            "ternyata ada driver",
            "agent tersedia",
            "driver tersedia",
            "restoran tersedia",
            "mitra tersedia",
            "pasti tersedia",
            "pasti ada",
            "pasti bisa",
            "aku sudah memastikan",
            "saya sudah memastikan"
        ]);
    }

    function containsFakeCertainty(text) {
        return containsAny(text, [
            "pasti",
            "tentu tersedia",
            "dijamin tersedia",
            "sudah pasti",
            "tanpa ragu",
            "100% tersedia",
            "pasti ada"
        ]);
    }

    function containsUnauthorizedAction(text) {
        return containsAny(text, [
            "sudah saya pesan",
            "sudah aku pesan",
            "sudah dipesankan",
            "sudah saya booking",
            "sudah aku booking",
            "sudah saya batalkan",
            "sudah aku batalkan",
            "sudah saya jalankan",
            "sudah aku jalankan",
            "sudah dieksekusi"
        ]);
    }

    /* =========================================================
     * RESPONSE SEGMENTATION
     * ========================================================= */

    function splitSentences(text) {
        const normalized = normalizeText(text);

        if (!normalized) {
            return [];
        }

        return normalized
            .split(/(?<=[.!?])\s+/)
            .map(function (part) {
                return part.trim();
            })
            .filter(Boolean);
    }

    function sentenceNeedsRuntime(sentence) {
        const type = detectClaimType(sentence);

        return (
            type === CLAIM_TYPES.AVAILABILITY ||
            type === CLAIM_TYPES.LOCATION ||
            type === CLAIM_TYPES.STATUS ||
            type === CLAIM_TYPES.RUNTIME
        );
    }

    /* =========================================================
     * SANITIZATION
     * ========================================================= */

    function safeUnknownRuntimeSentence(original) {
        const value = normalizeText(original);

        if (
            containsAny(value, [
                "sudah aku cek",
                "sudah saya cek",
                "sudah aku menemukan",
                "sudah saya menemukan",
                "sudah memastikan"
            ])
        ) {
            return (
                "Aku belum bisa memastikan hasil pengecekannya karena " +
                "belum ada bukti runtime yang bisa aku verifikasi."
            );
        }

        if (
            containsAny(value, [
                "agent tersedia",
                "driver tersedia",
                "restoran tersedia",
                "mitra tersedia",
                "ternyata ada agent",
                "ternyata ada driver"
            ])
        ) {
            return (
                "Aku belum bisa memastikan apakah layanan atau Agent " +
                "yang sesuai sedang tersedia sekarang."
            );
        }

        if (containsFakeCertainty(value)) {
            return (
                "Aku belum mau memastikan hal itu sebelum ada informasi " +
                "yang benar-benar bisa diverifikasi."
            );
        }

        return (
            "Aku belum punya bukti yang cukup untuk memastikan informasi itu."
        );
    }

    function safeUnauthorizedActionSentence(original) {
        return (
            "Aku belum melakukan tindakan tersebut. Kalau memang " +
            "diperlukan, tindakan harus melalui alur dan otorisasi " +
            "CIKUR GO yang sesuai."
        );
    }

    function sanitizeSentence(sentence, context) {
        const normalized = normalizeText(sentence);

        if (!normalized) {
            return {
                text: "",
                changed: false,
                blocked: false,
                reason: null
            };
        }

        if (containsUnauthorizedAction(normalized)) {
            return {
                text: safeUnauthorizedActionSentence(normalized),
                changed: true,
                blocked: true,
                reason: RULES.NEVER_BYPASS_AUTHORIZATION
            };
        }

        if (
            containsUnsupportedRuntimeClaim(normalized) ||
            sentenceNeedsRuntime(normalized)
        ) {
            if (!isVerifiedRuntime(context.discovery || context.evidence)) {
                return {
                    text: safeUnknownRuntimeSentence(normalized),
                    changed: true,
                    blocked: true,
                    reason: RULES.NEVER_FAKE_PROOF
                };
            }
        }

        if (containsFakeCertainty(normalized)) {
            /*
             * Jangan membuang personality secara keseluruhan.
             * Hanya klaim kepastian yang tidak memiliki dasar
             * yang diturunkan menjadi bahasa yang jujur.
             */
            return {
                text:
                    "Aku belum mau memastikan itu sebelum informasinya " +
                    "benar-benar terverifikasi.",
                changed: true,
                blocked: true,
                reason: RULES.NEVER_GUESS
            };
        }

        return {
            text: normalized,
            changed: false,
            blocked: false,
            reason: null
        };
    }

    /* =========================================================
     * RESPONSE GUARD
     * ========================================================= */

    function guard(response, context) {
        const original = normalizeText(response);
        const contextData = normalizeContext(context);

        state.validationCount += 1;

        if (!original) {
            const emptyResult = {
                id: makeId("guard"),
                timestamp: now(),
                status: STATUS.UNKNOWN,
                safe: false,
                original: "",
                response: "",
                claims: [],
                warnings: [
                    "Respons kosong tidak dapat diberikan kepada customer."
                ],
                blockedClaims: [],
                rules: [RULES.NEVER_INVENT]
            };

            state.lastStatus = STATUS.UNKNOWN;
            state.lastResult = emptyResult;
            state.lastClaims = [];
            state.lastWarnings = emptyResult.warnings;
            state.lastBlockedClaims = [];

            emit("guarded", emptyResult);

            return emptyResult;
        }

        const sentences = splitSentences(original);

        const output = [];
        const claims = [];
        const warnings = [];
        const blockedClaims = [];
        const appliedRules = [];

        sentences.forEach(function (sentence, index) {
            const claim = validateClaim(
                {
                    text: sentence,
                    index: index
                },
                contextData
            );

            claims.push(claim);

            if (!claim.supported && claim.rule) {
                warnings.push({
                    sentence: sentence,
                    rule: claim.rule,
                    reason: claim.reason
                });

                blockedClaims.push(claim);

                if (appliedRules.indexOf(claim.rule) === -1) {
                    appliedRules.push(claim.rule);
                }
            }

            const sanitized = sanitizeSentence(
                sentence,
                contextData
            );

            if (sanitized.changed) {
                warnings.push({
                    sentence: sentence,
                    replacement: sanitized.text,
                    rule: sanitized.reason
                });

                if (
                    sanitized.reason &&
                    appliedRules.indexOf(sanitized.reason) === -1
                ) {
                    appliedRules.push(sanitized.reason);
                }

                if (sanitized.blocked) {
                    blockedClaims.push({
                        id: makeId("blocked"),
                        text: sentence,
                        rule: sanitized.reason
                    });
                }
            }

            if (sanitized.text) {
                output.push(sanitized.text);
            }
        });

        let finalResponse = output.join(" ").trim();

        if (!finalResponse) {
            finalResponse =
                "Aku belum bisa memastikan informasi itu dengan cukup aman. " +
                "Aku lebih baik jujur daripada kasih jawaban yang belum terbukti.";
        }

        let status = STATUS.SAFE;

        if (warnings.length > 0) {
            status = STATUS.SANITIZED;
            state.sanitizedCount += 1;
        }

        if (blockedClaims.length > 0) {
            state.blockedCount += 1;
        }

        /*
         * Jika semua klaim yang berisiko runtime telah diturunkan
         * menjadi jawaban aman, response tetap boleh diberikan.
         *
         * Guardian bukan "refusal engine".
         * Tugasnya adalah menjaga kebenaran, bukan membuat CGO kaku.
         */

        const result = {
            id: makeId("guard"),
            timestamp: now(),
            status: status,
            safe: true,
            original: original,
            response: finalResponse,
            claims: claims,
            warnings: warnings,
            blockedClaims: blockedClaims,
            rules: appliedRules,
            evidence: contextData.evidence,
            runtimeConnected: contextData.runtimeConnected
        };

        state.lastStatus = status;
        state.lastResult = clone(result);
        state.lastClaims = clone(claims);
        state.lastWarnings = clone(warnings);
        state.lastBlockedClaims = clone(blockedClaims);

        emit("guarded", result);

        if (status === STATUS.SANITIZED) {
            emit("sanitized", result);
        }

        if (blockedClaims.length > 0) {
            emit("blocked_claim", result);
        }

        return result;
    }

    /* =========================================================
     * QUICK SAFETY CHECK
     * ========================================================= */

    function isSafe(response, context) {
        const result = guard(response, context);

        return result.safe === true;
    }

    function sanitizeResponse(response, context) {
        return guard(response, context).response;
    }

    /* =========================================================
     * RUNTIME CLAIM CHECK
     * ========================================================= */

    function canClaimAvailability(context) {
        const contextData = normalizeContext(context);

        return (
            contextData.evidence.level === EVIDENCE_LEVEL.VERIFIED
        );
    }

    function canClaimLocation(context) {
        const contextData = normalizeContext(context);

        return (
            contextData.evidence.level === EVIDENCE_LEVEL.VERIFIED
        );
    }

    function canClaimStatus(context) {
        const contextData = normalizeContext(context);

        return (
            contextData.evidence.level === EVIDENCE_LEVEL.VERIFIED
        );
    }

    function canClaimPrice(context) {
        const contextData = normalizeContext(context);

        if (
            contextData.knowledge &&
            contextData.knowledge.price &&
            contextData.knowledge.price.verified === true
        ) {
            return true;
        }

        return (
            contextData.evidence.level === EVIDENCE_LEVEL.VERIFIED &&
            contextData.evidence.data &&
            contextData.evidence.data.price !== undefined
        );
    }

    /* =========================================================
     * AUTHORIZATION CHECK
     * ========================================================= */

    function canClaimAction(context) {
        const contextData = normalizeContext(context);

        return (
            contextData.authorized === true ||
            contextData.actionAuthorized === true
        );
    }

    function canClaimHumanApproval(context) {
        const contextData = normalizeContext(context);

        return contextData.humanApproved === true;
    }

    /* =========================================================
     * FULL RESPONSE AUDIT
     * ========================================================= */

    function audit(response, context) {
        const result = guard(response, context);

        return {
            safe: result.safe,
            status: result.status,
            original: result.original,
            finalResponse: result.response,

            claimCount: result.claims.length,

            unsupportedClaims: result.claims.filter(
                function (claim) {
                    return claim.supported === false;
                }
            ),

            verifiedClaims: result.claims.filter(
                function (claim) {
                    return claim.verified === true;
                }
            ),

            warnings: result.warnings,

            rules: result.rules,

            runtimeEvidence:
                result.evidence,

            runtimeConnected:
                result.runtimeConnected
        };
    }

    /* =========================================================
     * GUARDIAN POLICY
     * ========================================================= */

    function getPolicy() {
        return {
            version: VERSION,

            rules: [
                {
                    id: RULES.NEVER_INVENT,
                    description:
                        "CGO tidak boleh membuat fakta yang tidak diketahui."
                },

                {
                    id: RULES.NEVER_FAKE_PROOF,
                    description:
                        "CGO tidak boleh menyatakan pengecekan atau hasil runtime tanpa bukti yang benar-benar terverifikasi."
                },

                {
                    id: RULES.NEVER_GUESS,
                    description:
                        "CGO tidak boleh mengubah ketidakpastian menjadi kepastian."
                },

                {
                    id: RULES.NEVER_BYPASS_AUTHORIZATION,
                    description:
                        "CGO tidak boleh mengklaim tindakan telah dilakukan tanpa otorisasi yang sah."
                },

                {
                    id: RULES.PERSONALITY_NEVER_OVERRIDES_TRUTH,
                    description:
                        "Gaya bicara, humor, emosi, atau personality tidak pernah boleh mengalahkan kebenaran."
                }
            ],

            principles: {
                knowledgeIsNotRuntime: true,
                runtimeRequiresEvidence: true,
                unknownIsSaferThanInvented: true,
                personalityMustRespectTruth: true,
                authorizationMustBeExplicit: true
            }
        };
    }

    /* =========================================================
     * STATE
     * ========================================================= */

    function getState() {
        return clone({
            version: state.version,
            lastStatus: state.lastStatus,
            lastResult: state.lastResult,
            lastClaims: state.lastClaims,
            lastWarnings: state.lastWarnings,
            lastBlockedClaims: state.lastBlockedClaims,
            validationCount: state.validationCount,
            sanitizedCount: state.sanitizedCount,
            blockedCount: state.blockedCount
        });
    }

    function reset() {
        state.lastStatus = STATUS.UNKNOWN;
        state.lastResult = null;
        state.lastClaims = [];
        state.lastWarnings = [];
        state.lastBlockedClaims = [];
        state.validationCount = 0;
        state.sanitizedCount = 0;
        state.blockedCount = 0;

        emit("reset", {
            timestamp: now()
        });
    }

    /* =========================================================
     * PUBLIC API
     * ========================================================= */

    const guardian = {

        version: VERSION,

        STATUS: STATUS,

        CLAIM_TYPES: CLAIM_TYPES,

        EVIDENCE_LEVEL: EVIDENCE_LEVEL,

        RULES: RULES,

        guard: guard,

        audit: audit,

        isSafe: isSafe,

        sanitizeResponse: sanitizeResponse,

        validateClaim: validateClaim,

        canClaimAvailability: canClaimAvailability,

        canClaimLocation: canClaimLocation,

        canClaimStatus: canClaimStatus,

        canClaimPrice: canClaimPrice,

        canClaimAction: canClaimAction,

        canClaimHumanApproval: canClaimHumanApproval,

        isVerifiedRuntime: isVerifiedRuntime,

        getPolicy: getPolicy,

        getState: getState,

        reset: reset,

        on: on
    };

    window.CGO_CUSTOMER.guardian = guardian;

    emit("ready", {
        version: VERSION,
        timestamp: now()
    });

    console.log(
        "[CGO CUSTOMER GUARDIAN] Ready:",
        VERSION
    );

})(window);
