/**
 * ============================================================
 * BCGO — BRAIN CIKUR GO
 * Core Decision Engine
 * ============================================================
 *
 * BCGO adalah engine inti untuk seluruh sistem mitra CIKUR GO.
 *
 * Supported Partner Types:
 * - assistant
 * - restaurant
 * - driver
 *
 * Architecture:
 *
 *   agentcgo.html ─┐
 *   resto.html ────┼──> BCGO ENGINE
 *   driver.html ──┘
 *
 * ============================================================
 */

"use strict";

/* ============================================================
   BCGO CORE CONFIGURATION
============================================================ */

const BCGO_VERSION = "0.1.0";

const BCGO_PARTNER_TYPES = {
    ASSISTANT: "assistant",
    RESTAURANT: "restaurant",
    DRIVER: "driver"
};

const BCGO_DECISIONS = {
    APPROVE: "APPROVE",
    REVIEW: "REVIEW",
    REJECT: "REJECT"
};

const BCGO_RISK_LEVELS = {
    LOW: "LOW",
    MEDIUM: "MEDIUM",
    HIGH: "HIGH",
    UNKNOWN: "UNKNOWN"
};


/* ============================================================
   BCGO — REQUIRED DATA
============================================================ */

const BCGO_REQUIRED_FIELDS = {
    assistant: [
        "name",
        "phone",
        "address",
        "serviceType"
    ],

    restaurant: [
        "name",
        "phone",
        "address",
        "businessName"
    ],

    driver: [
        "name",
        "phone",
        "address",
        "vehicleType"
    ]
};


/* ============================================================
   BCGO — BASIC UTILITIES
============================================================ */

/**
 * Memastikan nilai benar-benar memiliki isi.
 */
function bcgoHasValue(value) {
    return (
        value !== undefined &&
        value !== null &&
        String(value).trim() !== ""
    );
}


/**
 * Mengambil field yang belum diisi.
 */
function bcgoFindMissingFields(data, requiredFields) {

    return requiredFields.filter(
        field => !bcgoHasValue(data[field])
    );
}


/**
 * Menentukan jenis mitra.
 */
function bcgoNormalizePartnerType(type) {

    if (!type) {
        return null;
    }

    const normalized = String(type)
        .trim()
        .toLowerCase();

    if (
        normalized === "assistant" ||
        normalized === "agent" ||
        normalized === "agentcgo"
    ) {
        return BCGO_PARTNER_TYPES.ASSISTANT;
    }

    if (
        normalized === "restaurant" ||
        normalized === "resto"
    ) {
        return BCGO_PARTNER_TYPES.RESTAURANT;
    }

    if (
        normalized === "driver" ||
        normalized === "pengemudi"
    ) {
        return BCGO_PARTNER_TYPES.DRIVER;
    }

    return null;
}


/* ============================================================
   BCGO — DATA VALIDATION
============================================================ */

/**
 * Memeriksa apakah tipe mitra didukung.
 */
function bcgoValidatePartnerType(partnerType) {

    const normalizedType =
        bcgoNormalizePartnerType(partnerType);

    return {
        passed: normalizedType !== null,
        normalizedType
    };
}


/**
 * Memeriksa kelengkapan data mitra.
 */
function bcgoValidateRequiredData(
    partner,
    partnerType
) {

    const requiredFields =
        BCGO_REQUIRED_FIELDS[partnerType] || [];

    const missingFields =
        bcgoFindMissingFields(
            partner,
            requiredFields
        );

    return {
        passed: missingFields.length === 0,
        requiredFields,
        missingFields
    };
}


/* ============================================================
   BCGO — BASIC IDENTITY CHECK
============================================================ */

/**
 * Pemeriksaan dasar identitas/kontak.
 *
 * CATATAN:
 * Ini BELUM merupakan verifikasi identitas resmi.
 * Untuk saat ini hanya memeriksa keberadaan data.
 */
function bcgoIdentityCheck(partner) {

    const checks = {
        name: bcgoHasValue(partner.name),
        phone: bcgoHasValue(partner.phone),
        address: bcgoHasValue(partner.address)
    };

    const passed =
        checks.name &&
        checks.phone &&
        checks.address;

    return {
        passed,
        checks
    };
}


/* ============================================================
   BCGO — PARTNER-SPECIFIC CHECKS
============================================================ */

/**
 * Pemeriksaan khusus Assistant.
 */
function bcgoCheckAssistant(partner) {

    return {
        serviceType: {
            passed: bcgoHasValue(
                partner.serviceType
            )
        }
    };
}


/**
 * Pemeriksaan khusus Restaurant.
 */
function bcgoCheckRestaurant(partner) {

    return {
        businessName: {
            passed: bcgoHasValue(
                partner.businessName
            )
        }
    };
}


/**
 * Pemeriksaan khusus Driver.
 */
function bcgoCheckDriver(partner) {

    return {
        vehicleType: {
            passed: bcgoHasValue(
                partner.vehicleType
            )
        }
    };
}


/**
 * Menjalankan pemeriksaan khusus
 * berdasarkan jenis mitra.
 */
function bcgoRunPartnerSpecificChecks(
    partner,
    partnerType
) {

    switch (partnerType) {

        case BCGO_PARTNER_TYPES.ASSISTANT:
            return bcgoCheckAssistant(partner);

        case BCGO_PARTNER_TYPES.RESTAURANT:
            return bcgoCheckRestaurant(partner);

        case BCGO_PARTNER_TYPES.DRIVER:
            return bcgoCheckDriver(partner);

        default:
            return {};
    }
}


/* ============================================================
   BCGO — SCORING ENGINE
============================================================ */

function bcgoCalculateScore(
    validation,
    identity,
    partnerChecks
) {

    let score = 0;

    /* Data lengkap */
    if (validation.passed) {
        score += 40;
    }

    /* Identitas dasar */
    if (identity.passed) {
        score += 30;
    }

    /* Pemeriksaan khusus */
    const specificChecks =
        Object.values(partnerChecks);

    const passedSpecificChecks =
        specificChecks.filter(
            check => check.passed === true
        ).length;

    const totalSpecificChecks =
        specificChecks.length;

    if (totalSpecificChecks > 0) {

        score += Math.round(
            (passedSpecificChecks /
                totalSpecificChecks) * 30
        );
    }

    return Math.min(score, 100);
}


/* ============================================================
   BCGO — RISK ENGINE
============================================================ */

function bcgoDetermineRisk(score) {

    if (score >= 80) {
        return BCGO_RISK_LEVELS.LOW;
    }

    if (score >= 50) {
        return BCGO_RISK_LEVELS.MEDIUM;
    }

    if (score > 0) {
        return BCGO_RISK_LEVELS.HIGH;
    }

    return BCGO_RISK_LEVELS.UNKNOWN;
}


/* ============================================================
   BCGO — DECISION ENGINE
============================================================ */

function bcgoDetermineDecision(
    score,
    validation,
    identity
) {

    /*
     * APPROVE
     * hanya jika data lengkap + identitas dasar
     * terpenuhi + score tinggi.
     */

    if (
        validation.passed &&
        identity.passed &&
        score >= 80
    ) {
        return BCGO_DECISIONS.APPROVE;
    }


    /*
     * REJECT
     * untuk kondisi dengan score sangat rendah.
     *
     * Ini masih rule dasar.
     * Nanti akan kita ganti dengan Risk Engine
     * yang lebih matang.
     */

    if (score < 40) {
        return BCGO_DECISIONS.REJECT;
    }


    /*
     * Sisanya membutuhkan pemeriksaan.
     */

    return BCGO_DECISIONS.REVIEW;
}


/* ============================================================
   BCGO — REASON ENGINE
============================================================ */

function bcgoGenerateReasons(
    validation,
    identity,
    partnerChecks,
    decision
) {

    const reasons = [];

    if (!validation.passed) {

        reasons.push(
            "Data wajib belum lengkap."
        );
    }

    if (!identity.passed) {

        reasons.push(
            "Data identitas dasar belum lengkap."
        );
    }

    Object.entries(partnerChecks)
        .forEach(([key, check]) => {

            if (!check.passed) {

                reasons.push(
                    `Pemeriksaan ${key} belum terpenuhi.`
                );
            }
        });


    if (
        decision === BCGO_DECISIONS.APPROVE
    ) {

        reasons.push(
            "Data memenuhi kriteria dasar BCGO."
        );
    }


    if (
        decision === BCGO_DECISIONS.REVIEW
    ) {

        reasons.push(
            "Data membutuhkan pemeriksaan lebih lanjut."
        );
    }


    if (
        decision === BCGO_DECISIONS.REJECT
    ) {

        reasons.push(
            "Data belum memenuhi kriteria minimum."
        );
    }

    return reasons;
}


/* ============================================================
   BCGO — MAIN ENGINE
============================================================ */

/**
 * ============================================================
 * bcgoEvaluatePartner()
 *
 * Fungsi utama BCGO.
 *
 * Input:
 * {
 *     partnerType: "assistant",
 *     name: "...",
 *     phone: "...",
 *     address: "...",
 *     serviceType: "..."
 * }
 *
 * Output:
 * {
 *     status,
 *     score,
 *     risk,
 *     checks,
 *     reasons
 * }
 * ============================================================
 */

function bcgoEvaluatePartner(partner = {}) {

    const startedAt =
        new Date().toISOString();


    /* --------------------------------------------
       1. NORMALIZE PARTNER TYPE
    -------------------------------------------- */

    const typeValidation =
        bcgoValidatePartnerType(
            partner.partnerType
        );


    if (!typeValidation.passed) {

        return {
            bcgoVersion: BCGO_VERSION,
            status: BCGO_DECISIONS.REVIEW,
            score: 0,
            risk: BCGO_RISK_LEVELS.UNKNOWN,

            partnerType: null,

            checks: {
                partnerType: {
                    passed: false
                }
            },

            reasons: [
                "Jenis mitra tidak dikenali."
            ],

            meta: {
                startedAt,
                completedAt:
                    new Date().toISOString()
            }
        };
    }


    const partnerType =
        typeValidation.normalizedType;


    /* --------------------------------------------
       2. REQUIRED DATA VALIDATION
    -------------------------------------------- */

    const validation =
        bcgoValidateRequiredData(
            partner,
            partnerType
        );


    /* --------------------------------------------
       3. IDENTITY CHECK
    -------------------------------------------- */

    const identity =
        bcgoIdentityCheck(partner);


    /* --------------------------------------------
       4. PARTNER-SPECIFIC CHECK
    -------------------------------------------- */

    const partnerChecks =
        bcgoRunPartnerSpecificChecks(
            partner,
            partnerType
        );


    /* --------------------------------------------
       5. SCORE
    -------------------------------------------- */

    const score =
        bcgoCalculateScore(
            validation,
            identity,
            partnerChecks
        );


    /* --------------------------------------------
       6. RISK
    -------------------------------------------- */

    const risk =
        bcgoDetermineRisk(score);


    /* --------------------------------------------
       7. DECISION
    -------------------------------------------- */

    const decision =
        bcgoDetermineDecision(
            score,
            validation,
            identity
        );


    /* --------------------------------------------
       8. REASONS
    -------------------------------------------- */

    const reasons =
        bcgoGenerateReasons(
            validation,
            identity,
            partnerChecks,
            decision
        );


    /* --------------------------------------------
       9. FINAL RESULT
    -------------------------------------------- */

    return {

        bcgoVersion:
            BCGO_VERSION,

        status:
            decision,

        score,

        risk,

        partnerType,

        checks: {

            requiredData:
                validation,

            identity,

            partnerSpecific:
                partnerChecks
        },

        reasons,

        recommendation:
            decision === BCGO_DECISIONS.APPROVE
                ? "Lanjutkan proses pendaftaran mitra."
                : decision === BCGO_DECISIONS.REVIEW
                    ? "Minta pemeriksaan manual."
                    : "Jangan aktifkan mitra sebelum memenuhi persyaratan.",

        meta: {

            startedAt,

            completedAt:
                new Date().toISOString()
        }
    };
}


/* ============================================================
   BCGO — EXPORT
============================================================ */

/*
 * Node.js / Firebase Cloud Functions
 */

if (
    typeof module !== "undefined" &&
    module.exports
) {

    module.exports = {

        BCGO_VERSION,

        BCGO_PARTNER_TYPES,

        BCGO_DECISIONS,

        BCGO_RISK_LEVELS,

        bcgoEvaluatePartner,

        bcgoValidatePartnerType,

        bcgoValidateRequiredData,

        bcgoIdentityCheck,

        bcgoDetermineRisk,

        bcgoDetermineDecision
    };
}
