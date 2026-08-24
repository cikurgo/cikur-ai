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
   1. BCGO CORE CONFIGURATION
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
   2. BCGO REQUIRED DATA DEFINITIONS
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
        "businessName",
        "businessType",
        "ownerName",
        "role",
        "village",
        "district",
        "city",
        "province",
        "openTime",
        "closeTime",
        "operationalDays",
        "ktp",
        "legalStatus",
        "bankName",
        "accountName",
        "accountNumber",
        "photoFront"
    ],

    driver: [
        "name",
        "phone",
        "address",
        "vehicleType"
    ]
};


/* ============================================================
   3. BCGO BASIC UTILITIES
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
 * Menentukan dan menormalisasi jenis mitra.
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
   4. BCGO DATA VALIDATION
============================================================ */

/**
 * Memeriksa apakah tipe mitra didukung.
 */
function bcgoValidatePartnerType(partnerType) {
    const normalizedType = bcgoNormalizePartnerType(partnerType);

    return {
        passed: normalizedType !== null,
        normalizedType
    };
}

/**
 * Memeriksa kelengkapan data wajib mitra.
 */
function bcgoValidateRequiredData(partner, partnerType) {
    const requiredFields = BCGO_REQUIRED_FIELDS[partnerType] || [];
    const missingFields = bcgoFindMissingFields(partner, requiredFields);

    return {
        passed: missingFields.length === 0,
        requiredFields,
        missingFields
    };
}


/* ============================================================
   5. BCGO IDENTITY CHECK UTILITIES
============================================================ */

/**
 * Pemeriksaan dasar identitas/kontak.
 */
function bcgoIdentityCheck(partner) {
    const checks = {
        name: bcgoHasValue(partner.name),
        phone: bcgoHasValue(partner.phone),
        address: bcgoHasValue(partner.address)
    };

    const passed = checks.name && checks.phone && checks.address;

    return {
        passed,
        checks
    };
}


/* ============================================================
   6. BCGO PARTNER-SPECIFIC CHECKS
============================================================ */

/**
 * Pemeriksaan khusus Assistant / Agent CGO.
 */
function bcgoCheckAssistant(partner) {
    return {
        serviceType: {
            passed: bcgoHasValue(partner.serviceType)
        }
    };
}

/**
 * Pemeriksaan khusus Restaurant Partner.
 */
function bcgoCheckRestaurant(partner) {
    const checks = {
        businessName: {
            passed: bcgoHasValue(partner.businessName || partner.namaUsaha || partner.name)
        },
        businessType: {
            passed: bcgoHasValue(partner.businessType)
        },
        description: {
            passed: bcgoHasValue(partner.description)
        },
        ownerName: {
            passed: bcgoHasValue(partner.ownerName)
        },
        role: {
            passed: bcgoHasValue(partner.role)
        },
        address: {
            passed: bcgoHasValue(partner.address || partner.alamat)
        },
        village: {
            passed: bcgoHasValue(partner.village)
        },
        district: {
            passed: bcgoHasValue(partner.district)
        },
        city: {
            passed: bcgoHasValue(partner.city)
        },
        province: {
            passed: bcgoHasValue(partner.province)
        },
        openTime: {
            passed: bcgoHasValue(partner.openTime)
        },
        closeTime: {
            passed: bcgoHasValue(partner.closeTime)
        },
        operationalDays: {
            passed: bcgoHasValue(partner.operationalDays)
        },
        ktp: {
            passed: bcgoHasValue(partner.ktp)
        },
        ktpPhoto: {
            passed: bcgoHasValue(partner.ktpPhoto || partner.fotoKtp)
        },
        legalStatus: {
            passed: bcgoHasValue(partner.legalStatus)
        },
        nib: {
            passed: partner.legalStatus === "Belum Memiliki NIB" || bcgoHasValue(partner.nib)
        },
        bankName: {
            passed: bcgoHasValue(partner.bankName)
        },
        accountName: {
            passed: bcgoHasValue(partner.accountName)
        },
        accountNumber: {
            passed: bcgoHasValue(partner.accountNumber)
        },
        photoFront: {
            passed: bcgoHasValue(partner.photoFront)
        },
        photoIndoor: {
            passed: partner.photoIndoor === undefined || partner.photoIndoor === null || bcgoHasValue(partner.photoIndoor)
        }
    };

    const checkValues = Object.values(checks);
    const passedCount = checkValues.filter(check => check.passed === true).length;
    const totalCount = checkValues.length;

    return {
        passed: passedCount === totalCount,
        score: totalCount > 0 ? Math.round((passedCount / totalCount) * 100) : 0,
        passedCount,
        totalCount,
        checks
    };
}

/**
 * Pemeriksaan khusus Driver Partner.
 */
function bcgoCheckDriver(partner) {
    return {
        vehicleType: {
            passed: bcgoHasValue(partner.vehicleType)
        }
    };
}

/**
 * Menjalankan pemeriksaan khusus berdasarkan jenis mitra.
 */
function bcgoRunPartnerSpecificChecks(partner, partnerType) {
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
   7. BCGO SCORING, RISK, DECISION & REASON ENGINES
============================================================ */

function bcgoCalculateScore(validation, identity, partnerChecks) {
    let score = 0;

    if (validation.passed) {
        score += 40;
    }

    if (identity.passed) {
        score += 30;
    }

    const specificChecks = Object.values(partnerChecks);
    const passedSpecificChecks = specificChecks.filter(check => check.passed === true).length;
    const totalSpecificChecks = specificChecks.length;

    if (totalSpecificChecks > 0) {
        score += Math.round((passedSpecificChecks / totalSpecificChecks) * 30);
    }

    return Math.min(score, 100);
}

function bcgoDetermineRisk(score) {
    if (score >= 80) return BCGO_RISK_LEVELS.LOW;
    if (score >= 50) return BCGO_RISK_LEVELS.MEDIUM;
    if (score > 0) return BCGO_RISK_LEVELS.HIGH;
    return BCGO_RISK_LEVELS.UNKNOWN;
}

function bcgoDetermineDecision(score, validation, identity) {
    if (validation.passed && identity.passed && score >= 80) {
        return BCGO_DECISIONS.APPROVE;
    }

    if (score < 40) {
        return BCGO_DECISIONS.REJECT;
    }

    return BCGO_DECISIONS.REVIEW;
}

function bcgoGenerateReasons(validation, identity, partnerChecks, decision) {
    const reasons = [];

    if (!validation.passed) {
        reasons.push("Data wajib belum lengkap.");
    }

    if (!identity.passed) {
        reasons.push("Data identitas dasar belum lengkap.");
    }

    Object.entries(partnerChecks).forEach(([key, check]) => {
        if (!check.passed) {
            reasons.push(`Pemeriksaan ${key} belum terpenuhi.`);
        }
    });

    if (decision === BCGO_DECISIONS.APPROVE) {
        reasons.push("Data memenuhi kriteria dasar BCGO.");
    }

    if (decision === BCGO_DECISIONS.REVIEW) {
        reasons.push("Data membutuhkan pemeriksaan lebih lanjut.");
    }

    if (decision === BCGO_DECISIONS.REJECT) {
        reasons.push("Data belum memenuhi kriteria minimum.");
    }

    return reasons;
}


/* ============================================================
   8. BCGO MAIN EVALUATION ENGINE
============================================================ */

function bcgoEvaluatePartner(partner = {}) {
    const startedAt = new Date().toISOString();

    const typeValidation = bcgoValidatePartnerType(partner.partnerType);

    if (!typeValidation.passed) {
        return {
            bcgoVersion: BCGO_VERSION,
            status: BCGO_DECISIONS.REVIEW,
            score: 0,
            risk: BCGO_RISK_LEVELS.UNKNOWN,
            partnerType: null,
            checks: {
                partnerType: { passed: false }
            },
            reasons: ["Jenis mitra tidak dikenali."],
            meta: {
                startedAt,
                completedAt: new Date().toISOString()
            }
        };
    }

    const partnerType = typeValidation.normalizedType;

    const validation = bcgoValidateRequiredData(partner, partnerType);
    const identity = bcgoIdentityCheck(partner);
    const partnerChecks = bcgoRunPartnerSpecificChecks(partner, partnerType);
    const score = bcgoCalculateScore(validation, identity, partnerChecks);
    const risk = bcgoDetermineRisk(score);
    const decision = bcgoDetermineDecision(score, validation, identity);
    const reasons = bcgoGenerateReasons(validation, identity, partnerChecks, decision);

    return {
        bcgoVersion: BCGO_VERSION,
        status: decision,
        score,
        risk,
        partnerType,
        checks: {
            requiredData: validation,
            identity,
            partnerSpecific: partnerChecks
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
            completedAt: new Date().toISOString()
        }
    };
}


/* ============================================================
   9. EXPORTS (COMMONJS & BROWSER GLOBAL)
============================================================ */

if (typeof module !== "undefined" && module.exports) {
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

if (typeof window !== "undefined") {
    window.BCGO = {
        VERSION: BCGO_VERSION,
        PARTNER_TYPES: BCGO_PARTNER_TYPES,
        DECISIONS: BCGO_DECISIONS,
        RISK_LEVELS: BCGO_RISK_LEVELS,
        evaluatePartner: bcgoEvaluatePartner,
        validatePartnerType: bcgoValidatePartnerType,
        validateRequiredData: bcgoValidateRequiredData,
        identityCheck: bcgoIdentityCheck,
        determineRisk: bcgoDetermineRisk,
        determineDecision: bcgoDetermineDecision
    };
}
