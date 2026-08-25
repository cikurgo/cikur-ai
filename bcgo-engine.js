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
 * - customer
 *
 * Architecture:
 *
 *   agentcgo.html ─┐
 *   resto.html ────┼──> BCGO ENGINE
 *   driver.html ──┘
 *   bcgo-admin.html┘
 *
 * ============================================================
 */

"use strict";

/* ============================================================
   BCGO CORE CONFIGURATION
============================================================ */

const BCGO_VERSION = "0.1.1";

const BCGO_PARTNER_TYPES = {
    ASSISTANT: "assistant",
    RESTAURANT: "restaurant",
    DRIVER: "driver",
    CUSTOMER: "customer"
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
    ],

    customer: [
        "name",
        "phone",
        "email",
        "registrationStatus"
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
 * Menentukan jenis mitra atau pengguna.
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

    if (
        normalized === "customer" ||
        normalized === "pelanggan"
    ) {
        return BCGO_PARTNER_TYPES.CUSTOMER;
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
 * ============================================================
 * BCGO — PEMERIKSAAN KHUSUS RESTAURANT
 * ============================================================
 */
function bcgoCheckRestaurant(partner) {

    const checks = {

        /* ================================
           IDENTITAS USAHA
        ================================= */

        businessName: {
            passed: bcgoHasValue(
                partner.businessName ||
                partner.namaUsaha ||
                partner.name
            )
        },

        businessType: {
            passed: bcgoHasValue(
                partner.businessType
            )
        },

        description: {
            passed: bcgoHasValue(
                partner.description
            )
        },


        /* ================================
           PENANGGUNG JAWAB
        ================================= */

        ownerName: {
            passed: bcgoHasValue(
                partner.ownerName
            )
        },

        role: {
            passed: bcgoHasValue(
                partner.role
            )
        },


        /* ================================
           LOKASI
        ================================= */

        address: {
            passed: bcgoHasValue(
                partner.address ||
                partner.alamat
            )
        },

        village: {
            passed: bcgoHasValue(
                partner.village
            )
        },

        district: {
            passed: bcgoHasValue(
                partner.district
            )
        },

        city: {
            passed: bcgoHasValue(
                partner.city
            )
        },

        province: {
            passed: bcgoHasValue(
                partner.province
            )
        },


        /* ================================
           OPERASIONAL
        ================================= */

        openTime: {
            passed: bcgoHasValue(
                partner.openTime
            )
        },

        closeTime: {
            passed: bcgoHasValue(
                partner.closeTime
            )
        },

        operationalDays: {
            passed: bcgoHasValue(
                partner.operationalDays
            )
        },


        /* ================================
           IDENTITAS / LEGALITAS
        ================================= */

        ktp: {
            passed: bcgoHasValue(
                partner.ktp
            )
        },

        ktpPhoto: {
            passed: bcgoHasValue(
                partner.ktpPhoto ||
                partner.fotoKtp
            )
        },

        legalStatus: {
            passed: bcgoHasValue(
                partner.legalStatus
            )
        },

        nib: {
            passed:
                partner.legalStatus === "Belum Memiliki NIB" ||
                bcgoHasValue(partner.nib)
        },


        /* ================================
           PENCAIRAN DANA
        ================================= */

        bankName: {
            passed: bcgoHasValue(
                partner.bankName
            )
        },

        accountName: {
            passed: bcgoHasValue(
                partner.accountName
            )
        },

        accountNumber: {
            passed: bcgoHasValue(
                partner.accountNumber
            )
        },


        /* ================================
           FOTO RESTORAN
        ================================= */

        photoFront: {
            passed: bcgoHasValue(
                partner.photoFront
            )
        },

        photoIndoor: {
            passed:
                partner.photoIndoor === undefined ||
                partner.photoIndoor === null ||
                bcgoHasValue(partner.photoIndoor)
        }

    };

    const checkValues =
        Object.values(checks);

    const passedCount =
        checkValues.filter(
            check => check.passed === true
        ).length;

    const totalCount =
        checkValues.length;

    return {

        passed:
            passedCount === totalCount,

        score:
            totalCount > 0
                ? Math.round(
                    (passedCount / totalCount) * 100
                )
                : 0,

        passedCount,

        totalCount,

        checks

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
 * Pemeriksaan khusus Customer (Sinkronisasi dari bcgo-admin.html).
 */
function bcgoCheckCustomer(partner) {
    const checks = {
        name: {
            passed: bcgoHasValue(partner.name)
        },
        phone: {
            passed: bcgoHasValue(partner.phone)
        },
        email: {
            passed: bcgoHasValue(partner.email)
        },
        registrationStatus: {
            passed: bcgoHasValue(partner.registrationStatus)
        },
        registeredAt: {
            passed: bcgoHasValue(partner.registeredAt || partner.createdAt)
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
 * Menjalankan pemeriksaan khusus
 * berdasarkan jenis mitra/pengguna.
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

        case BCGO_PARTNER_TYPES.CUSTOMER:
            return bcgoCheckCustomer(partner);

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
    partnerChecks,
    partnerType
) {
    let score = 0;

    if (partnerType === BCGO_PARTNER_TYPES.CUSTOMER) {
        if (validation.passed) {
            return 100;
        }
        const checksArr = Object.values(partnerChecks.checks || partnerChecks);
        const passedCount = checksArr.filter(c => c.passed).length;
        return checksArr.length > 0 ? Math.round((passedCount / checksArr.length) * 100) : 0;
    }

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
    identity,
    partnerType
) {
    if (partnerType === BCGO_PARTNER_TYPES.CUSTOMER) {
        return validation.passed ? BCGO_DECISIONS.APPROVE : BCGO_DECISIONS.REVIEW;
    }

    if (
        validation.passed &&
        identity.passed &&
        score >= 80
    ) {
        return BCGO_DECISIONS.APPROVE;
    }

    if (score < 40) {
        return BCGO_DECISIONS.REJECT;
    }

    return BCGO_DECISIONS.REVIEW;
}


/* ============================================================
   BCGO — REASON ENGINE
============================================================ */

function bcgoGenerateReasons(
    validation,
    identity,
    partnerChecks,
    decision,
    partnerType
) {
    const reasons = [];

    if (partnerType === BCGO_PARTNER_TYPES.CUSTOMER) {
        if (validation.passed) {
            reasons.push("Data pendaftaran customer lengkap dan sinkron.");
        } else {
            reasons.push("Ada kolom data customer yang belum lengkap.");
        }
        return reasons;
    }

    if (!validation.passed) {
        reasons.push("Data wajib belum lengkap.");
    }

    if (!identity.passed) {
        reasons.push("Data identitas dasar belum lengkap.");
    }

    Object.entries(partnerChecks)
        .forEach(([key, check]) => {
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
   BCGO — MAIN ENGINE
============================================================ */

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
                "Jenis mitra atau pengguna tidak dikenali."
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
            partnerChecks,
            partnerType
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
            identity,
            partnerType
        );


    /* --------------------------------------------
       8. REASONS
    -------------------------------------------- */

    const reasons =
        bcgoGenerateReasons(
            validation,
            identity,
            partnerChecks,
            decision,
            partnerType
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
                ? "Lanjutkan proses pendaftaran atau sinkronisasi data."
                : decision === BCGO_DECISIONS.REVIEW
                    ? "Minta pemeriksaan manual."
                    : "Jangan aktifkan akun sebelum memenuhi persyaratan.",

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


/*
 * Browser (dipakai langsung dari <script src="bcgo-engine.js">)
 */

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
