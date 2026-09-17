/* ============================================================
 * CIKUR GO — CGO CUSTOMER KNOWLEDGE ENGINE
 * ------------------------------------------------------------
 * File    : cgo-customer-knowledge.js
 * Role    : Service Knowledge / Registry / Matching
 * Scope   : Customer-facing CGO
 *
 * IMPORTANT:
 * - Internal JavaScript module only.
 * - No external API.
 * - No external AI.
 * - No Firebase Functions.
 * - No third-party runtime.
 * - Knowledge != Runtime.
 * - Never invent unavailable facts.
 * - New services can be registered without modifying
 *   the conversation engine.
 * ============================================================ */

(function (window) {
  "use strict";

  const ROOT =
    window.CGO_CUSTOMER ||
    (window.CGO_CUSTOMER = {});

  const VERSION =
    "1.0.0-knowledge";

  /* ==========================================================
   * CONSTANTS
   * ========================================================== */

  const KNOWLEDGE_STATUS = Object.freeze({
    COMPLETE: "complete",
    PARTIAL: "partial",
    UNKNOWN: "unknown"
  });

  const DISCOVERY_TYPES = Object.freeze([
    "agent",
    "mitra",
    "restaurant",
    "driver",
    "location",
    "service",
    "none"
  ]);

  /* ==========================================================
   * UTILITIES
   * ========================================================== */

  function cleanText(value) {
    return String(value == null ? "" : value)
      .replace(/\s+/g, " ")
      .trim();
  }

  function lower(value) {
    return cleanText(value).toLowerCase();
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

  function normalizeId(value) {
    return lower(value)
      .replace(/[^a-z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  }

  function unique(list) {
    return Array.from(
      new Set(
        Array.isArray(list)
          ? list.filter(Boolean)
          : []
      )
    );
  }

  function includesAny(text, values) {
    const value = lower(text);

    return values.some(function (item) {
      return value.includes(
        lower(item)
      );
    });
  }

  /* ==========================================================
   * SERVICE REGISTRY
   * ========================================================== */

  const registry = Object.create(null);

  /*
   * A service definition is knowledge only.
   *
   * It must NOT contain fake runtime values such as:
   *
   * availableNow: true
   * agentCount: 5
   * currentLocation: ...
   *
   * Runtime information belongs to Discovery.
   */

  function normalizeService(service) {
    if (!service || typeof service !== "object") {
      return null;
    }

    const id =
      normalizeId(
        service.id ||
        service.slug ||
        service.name
      );

    if (!id) {
      return null;
    }

    return {
      id,

      name:
        cleanText(
          service.name || id
        ),

      shortName:
        cleanText(
          service.shortName ||
          service.name ||
          id
        ),

      category:
        cleanText(
          service.category ||
          "service"
        ),

      status:
        service.status ||
        KNOWLEDGE_STATUS.COMPLETE,

      aliases:
        unique(
          service.aliases || []
        ).map(lower),

      keywords:
        unique(
          service.keywords || []
        ).map(lower),

      description:
        cleanText(
          service.description || ""
        ),

      purpose:
        cleanText(
          service.purpose || ""
        ),

      helpsWith:
        unique(
          service.helpsWith || []
        ),

      examples:
        unique(
          service.examples || []
        ),

      suitableFor:
        unique(
          service.suitableFor || []
        ),

      notFor:
        unique(
          service.notFor || []
        ),

      discovery: {
        required:
          Boolean(
            service.discovery &&
            service.discovery.required
          ),

        types:
          unique(
            service.discovery &&
            service.discovery.types
              ? service.discovery.types
              : ["none"]
          ).filter(function (type) {
            return DISCOVERY_TYPES.includes(type);
          }),

        reason:
          cleanText(
            service.discovery &&
            service.discovery.reason
              ? service.discovery.reason
              : ""
          )
      },

      combinations:
        unique(
          service.combinations || []
        ).map(normalizeId),

      questions:
        unique(
          service.questions || []
        ),

      handoff:
        service.handoff
          ? {
              enabled:
                Boolean(
                  service.handoff.enabled
                ),

              target:
                cleanText(
                  service.handoff.target ||
                  ""
                )
            }
          : {
              enabled: false,
              target: ""
            },

      metadata:
        clone(
          service.metadata || {}
        )
    };
  }

  /* ==========================================================
   * REGISTER SERVICE
   * ========================================================== */

  function registerService(service) {
    const normalized =
      normalizeService(service);

    if (!normalized) {
      return {
        ok: false,
        error: "INVALID_SERVICE"
      };
    }

    const existed =
      Boolean(
        registry[normalized.id]
      );

    registry[normalized.id] =
      normalized;

    return {
      ok: true,
      created: !existed,
      updated: existed,
      service: clone(normalized)
    };
  }

  function registerServices(services) {
    if (!Array.isArray(services)) {
      return {
        ok: false,
        error: "SERVICES_MUST_BE_ARRAY",
        results: []
      };
    }

    const results =
      services.map(registerService);

    return {
      ok: results.every(
        function (item) {
          return item.ok;
        }
      ),
      results
    };
  }

  /* ==========================================================
   * REMOVE SERVICE
   * ========================================================== */

  function removeService(id) {
    const key =
      normalizeId(id);

    if (!key || !registry[key]) {
      return false;
    }

    delete registry[key];

    return true;
  }

  /* ==========================================================
   * GET SERVICE
   * ========================================================== */

  function getService(id) {
    const key =
      normalizeId(id);

    if (!key) {
      return null;
    }

    return registry[key]
      ? clone(registry[key])
      : null;
  }

  function getServices() {
    return Object.keys(registry)
      .map(function (id) {
        return clone(
          registry[id]
        );
      });
  }

  /* ==========================================================
   * SERVICE SEARCH
   * ========================================================== */

  function serviceMatchesText(service, text) {
    const value =
      lower(text);

    if (!value) {
      return false;
    }

    const searchable =
      [
        service.id,
        service.name,
        service.shortName,
        service.category
      ]
        .concat(service.aliases)
        .concat(service.keywords)
        .concat(service.helpsWith)
        .concat(service.suitableFor)
        .concat(service.examples)
        .join(" ");

    return includesAny(
      value,
      searchable.split(" ")
    );
  }

  function calculateMatchScore(
    service,
    text
  ) {
    const value =
      lower(text);

    let score = 0;

    if (
      includesAny(
        value,
        service.aliases
      )
    ) {
      score += 5;
    }

    if (
      includesAny(
        value,
        service.keywords
      )
    ) {
      score += 4;
    }

    if (
      includesAny(
        value,
        service.helpsWith
      )
    ) {
      score += 4;
    }

    if (
      includesAny(
        value,
        service.suitableFor
      )
    ) {
      score += 3;
    }

    if (
      includesAny(
        value,
        service.examples
      )
    ) {
      score += 2;
    }

    if (
      lower(service.name) &&
      value.includes(
        lower(service.name)
      )
    ) {
      score += 8;
    }

    if (
      lower(service.shortName) &&
      value.includes(
        lower(service.shortName)
      )
    ) {
      score += 8;
    }

    return score;
  }

  function findServices(text) {
    const services =
      getServices();

    return services
      .map(function (service) {
        return {
          service,
          score:
            calculateMatchScore(
              service,
              text
            )
        };
      })
      .filter(function (result) {
        return result.score > 0;
      })
      .sort(function (a, b) {
        return b.score - a.score;
      });
  }

  function findBestService(text) {
    const results =
      findServices(text);

    return results.length
      ? clone(results[0])
      : null;
  }

  /* ==========================================================
   * NEED MATCHING
   * ========================================================== */

  function findServicesForNeed(need) {
    const value =
      lower(need);

    if (!value) {
      return [];
    }

    return getServices()
      .map(function (service) {
        let score = 0;

        if (
          service.helpsWith.some(
            function (item) {
              return lower(item)
                .includes(value) ||
                value.includes(
                  lower(item)
                );
            }
          )
        ) {
          score += 5;
        }

        if (
          service.suitableFor.some(
            function (item) {
              return lower(item)
                .includes(value) ||
                value.includes(
                  lower(item)
                );
            }
          )
        ) {
          score += 4;
        }

        if (
          service.keywords.some(
            function (item) {
              return lower(item)
                .includes(value) ||
                value.includes(
                  lower(item)
                );
            }
          )
        ) {
          score += 3;
        }

        return {
          service,
          score
        };
      })
      .filter(function (result) {
        return result.score > 0;
      })
      .sort(function (a, b) {
        return b.score - a.score;
      });
  }

  /* ==========================================================
   * COMBINATION ENGINE
   * ========================================================== */

  function getCombinations(serviceId) {
    const service =
      getService(serviceId);

    if (!service) {
      return [];
    }

    return service.combinations
      .map(function (id) {
        return getService(id);
      })
      .filter(Boolean);
  }

  function findCombination(
    serviceIds
  ) {
    const ids =
      unique(
        serviceIds || []
      ).map(normalizeId);

    if (ids.length < 2) {
      return null;
    }

    const services =
      ids
        .map(function (id) {
          return getService(id);
        })
        .filter(Boolean);

    if (services.length < 2) {
      return null;
    }

    for (
      const service of services
    ) {
      for (
        const combinationId
        of service.combinations
      ) {
        if (
          ids.includes(
            combinationId
          )
        ) {
          const combination =
            getService(
              combinationId
            );

          if (combination) {
            return {
              id: combination.id,
              name: combination.name,
              services:
                services.map(
                  function (item) {
                    return item.id;
                  }
                )
            };
          }
        }
      }
    }

    return null;
  }

  /* ==========================================================
   * KNOWLEDGE QUERY
   * ========================================================== */

  function explainService(id) {
    const service =
      getService(id);

    if (!service) {
      return {
        ok: false,
        known: false,
        reason: "SERVICE_UNKNOWN"
      };
    }

    if (
      service.status ===
      KNOWLEDGE_STATUS.UNKNOWN
    ) {
      return {
        ok: true,
        known: false,
        service
      };
    }

    return {
      ok: true,
      known: true,

      service,

      explanation: {
        name: service.name,

        description:
          service.description,

        purpose:
          service.purpose,

        helpsWith:
          clone(service.helpsWith),

        examples:
          clone(service.examples),

        suitableFor:
          clone(service.suitableFor)
      }
    };
  }

  /* ==========================================================
   * KNOWLEDGE COMPLETENESS
   * ========================================================== */

  function getCompleteness(service) {
    const requiredFields = [
      "name",
      "description",
      "purpose"
    ];

    let present = 0;

    requiredFields.forEach(
      function (field) {
        if (
          cleanText(
            service[field]
          )
        ) {
          present += 1;
        }
      }
    );

    if (present === 0) {
      return 0;
    }

    return Math.round(
      (present /
        requiredFields.length) *
        100
    );
  }

  function auditKnowledge() {
    return getServices()
      .map(function (service) {
        const completeness =
          getCompleteness(
            service
          );

        let status =
          KNOWLEDGE_STATUS.COMPLETE;

        if (completeness < 50) {
          status =
            KNOWLEDGE_STATUS.UNKNOWN;
        } else if (
          completeness < 100
        ) {
          status =
            KNOWLEDGE_STATUS.PARTIAL;
        }

        return {
          id: service.id,
          name: service.name,
          completeness,
          status,
          discovery:
            clone(
              service.discovery
            )
        };
      });
  }

  /* ==========================================================
   * DISCOVERY REQUIREMENT
   * ========================================================== */

  function requiresDiscovery(id) {
    const service =
      getService(id);

    if (!service) {
      return false;
    }

    return Boolean(
      service.discovery &&
      service.discovery.required
    );
  }

  function getDiscoveryRequirements(id) {
    const service =
      getService(id);

    if (!service) {
      return null;
    }

    return clone(
      service.discovery
    );
  }

  /* ==========================================================
   * CUSTOMER NEED → SERVICE
   * ========================================================== */

  function recommendForNeeds(
    needs
  ) {
    const normalizedNeeds =
      unique(
        Array.isArray(needs)
          ? needs
          : [needs]
      ).map(lower);

    if (!normalizedNeeds.length) {
      return [];
    }

    const scored =
      getServices().map(
        function (service) {
          let score = 0;
          const matched = [];

          normalizedNeeds.forEach(
            function (need) {
              const allTerms =
                []
                  .concat(
                    service.helpsWith
                  )
                  .concat(
                    service.suitableFor
                  )
                  .concat(
                    service.keywords
                  );

              const matchedNeed =
                allTerms.some(
                  function (term) {
                    const normalizedTerm =
                      lower(term);

                    return (
                      normalizedTerm.includes(
                        need
                      ) ||
                      need.includes(
                        normalizedTerm
                      )
                    );
                  }
                );

              if (matchedNeed) {
                score += 3;
                matched.push(need);
              }
            }
          );

          return {
            service,
            score,
            matchedNeeds:
              unique(matched)
          };
        }
      );

    return scored
      .filter(function (item) {
        return item.score > 0;
      })
      .sort(function (a, b) {
        return b.score - a.score;
      });
  }

  /* ==========================================================
   * TEXT → KNOWLEDGE INTERPRETATION
   * ========================================================== */

  function understand(text) {
    const value =
      cleanText(text);

    const matches =
      findServices(value);

    const best =
      matches.length
        ? matches[0]
        : null;

    const services =
      matches.map(
        function (item) {
          return item.service.id;
        }
      );

    const combination =
      findCombination(
        services
      );

    return {
      text: value,

      knownServices:
        services,

      bestService:
        best
          ? best.service.id
          : null,

      bestScore:
        best
          ? best.score
          : 0,

      combination:
        combination
          ? clone(combination)
          : null,

      confidence:
        best
          ? calculateConfidence(
              best.score
            )
          : 0
    };
  }

  function calculateConfidence(
    score
  ) {
    if (score >= 10) return 1;
    if (score >= 7) return 0.85;
    if (score >= 5) return 0.7;
    if (score >= 3) return 0.5;

    return 0;
  }

  /* ==========================================================
   * SAFE ANSWER BUILDING
   * ========================================================== */

  function buildExplanation(
    serviceId
  ) {
    const result =
      explainService(
        serviceId
      );

    if (
      !result.ok ||
      !result.known
    ) {
      return {
        ok: false,
        text:
          "Aku belum punya informasi yang cukup tentang layanan itu."
      };
    }

    const service =
      result.service;

    let text =
      service.name;

    if (service.description) {
      text +=
        " " +
        service.description;
    }

    if (service.purpose) {
      text +=
        " " +
        service.purpose;
    }

    return {
      ok: true,
      text: cleanText(text),
      service: clone(service)
    };
  }

  /* ==========================================================
   * DEFAULT OFFICIAL KNOWLEDGE
   * ========================================================== */

  registerServices([

    {
      id: "food",

      name:
        "CIKUR GO Food",

      shortName:
        "Food",

      category:
        "food",

      aliases: [
        "food",
        "makanan",
        "pesan makanan",
        "kuliner",
        "makan",
        "pesan makan"
      ],

      keywords: [
        "lapar",
        "makan",
        "makanan",
        "kuliner",
        "pesan"
      ],

      description:
        "Layanan CIKUR GO untuk kebutuhan makanan.",

      purpose:
        "Membantu kebutuhan pemesanan atau pengantaran makanan sesuai kemampuan layanan yang tersedia.",

      helpsWith: [
        "makanan",
        "lapar",
        "pesan makanan",
        "pengantaran makanan"
      ],

      examples: [
        "mau makan",
        "lagi lapar",
        "pesan makanan",
        "cari makanan"
      ],

      suitableFor: [
        "kebutuhan makanan"
      ],

      discovery: {
        required: true,
        types: [
          "restaurant",
          "mitra",
          "location"
        ],
        reason:
          "Kebutuhan makanan dapat memerlukan data mitra/restoran dan kondisi layanan aktual."
      },

      combinations: [
        "cikurgo2in1"
      ],

      questions: [
        "Kamu lagi pengin makan apa?",
        "Kamu sudah tahu mau pesan dari mana atau masih cari?"
      ],

      handoff: {
        enabled: true,
        target: "food"
      }
    },

    {
      id: "ride",

      name:
        "CIKUR GO Ride",

      shortName:
        "Ride",

      category:
        "ride",

      aliases: [
        "ride",
        "ojek",
        "antar",
        "jemput",
        "kendaraan",
        "transportasi"
      ],

      keywords: [
        "perjalanan",
        "antar",
        "jemput",
        "kendaraan",
        "naik"
      ],

      description:
        "Layanan CIKUR GO untuk kebutuhan perjalanan atau transportasi.",

      purpose:
        "Membantu kebutuhan perjalanan sesuai layanan dan kondisi operasional yang tersedia.",

      helpsWith: [
        "perjalanan",
        "antar",
        "jemput",
        "transportasi"
      ],

      examples: [
        "mau pergi",
        "butuh kendaraan",
        "mau diantar",
        "mau dijemput"
      ],

      suitableFor: [
        "kebutuhan perjalanan",
        "transportasi"
      ],

      discovery: {
        required: true,
        types: [
          "driver",
          "location"
        ],
        reason:
          "Ketersediaan perjalanan membutuhkan kondisi driver dan lokasi aktual."
      },

      combinations: [],

      questions: [
        "Kamu mau pergi atau perlu diantar ke mana?"
      ],

      handoff: {
        enabled: true,
        target: "ride"
      }
    },

    {
      id: "assistant",

      name:
        "CIKUR GO Assistant",

      shortName:
        "Assistant",

      category:
        "assistant",

      aliases: [
        "assistant",
        "asisten",
        "pendamping",
        "teman",
        "temenin",
        "nemenin"
      ],

      keywords: [
        "pendamping",
        "ditemani",
        "dibantu",
        "bantuan",
        "teman"
      ],

      description:
        "Layanan pendamping atau bantuan dari CIKUR GO sesuai kebutuhan customer.",

      purpose:
        "Dapat digunakan untuk menemani saat liburan, membantu ketika belanja, menemani acara keluarga, atau kebutuhan lainnya sesuai layanan yang tersedia.",

      helpsWith: [
        "pendampingan",
        "menemani",
        "bantuan",
        "liburan",
        "belanja",
        "acara keluarga"
      ],

      examples: [
        "mau liburan tapi sendirian",
        "butuh teman saat belanja",
        "butuh pendamping acara keluarga",
        "butuh bantuan untuk kebutuhan tertentu"
      ],

      suitableFor: [
        "liburan",
        "belanja",
        "acara keluarga",
        "kebutuhan pendampingan"
      ],

      discovery: {
        required: true,
        types: [
          "agent",
          "location"
        ],
        reason:
          "Kebutuhan Assistant dapat memerlukan pemeriksaan Agent dan lokasi aktual."
      },

      combinations: [
        "cikurgo2in1"
      ],

      questions: [
        "Kira-kira kamu butuh ditemani atau dibantu untuk apa?",
        "Kebutuhannya untuk berapa lama?",
        "Kamu berada di area mana?"
      ],

      handoff: {
        enabled: true,
        target: "assistant"
      }
    },

    {
      id: "cikurgo2in1",

      name:
        "CIKUR GO 2in1",

      shortName:
        "2in1",

      category:
        "combined_service",

      aliases: [
        "2in1",
        "2 in 1",
        "food assistant",
        "food dan assistant",
        "makanan dan assistant"
      ],

      keywords: [
        "sekalian",
        "sekaligus",
        "makanan dan bantuan",
        "makanan dan pendamping",
        "food dan assistant"
      ],

      description:
        "Konsep layanan gabungan CIKUR GO yang menghubungkan kebutuhan Food dan Assistant.",

      purpose:
        "Cocok ketika customer memiliki kebutuhan makanan sekaligus kebutuhan bantuan atau pendampingan.",

      helpsWith: [
        "makanan sekaligus bantuan",
        "makanan sekaligus pendampingan",
        "food dan assistant"
      ],

      examples: [
        "mau pesan makanan sekaligus butuh bantuan",
        "mau belanja dan pesan makanan",
        "butuh makanan sekaligus pendamping"
      ],

      suitableFor: [
        "gabungan Food dan Assistant"
      ],

      discovery: {
        required: true,
        types: [
          "agent",
          "mitra",
          "restaurant",
          "location"
        ],
        reason:
          "Kebutuhan gabungan memerlukan pemeriksaan kondisi layanan yang relevan secara aktual."
      },

      combinations: [
        "food",
        "assistant"
      ],

      questions: [
        "Kamu ingin makanan sekaligus dibantu atau ditemani untuk kebutuhan apa?"
      ],

      handoff: {
        enabled: true,
        target: "cikurgo2in1"
      }
    }

  ]);

  /* ==========================================================
   * PUBLIC MODULE
   * ========================================================== */

  const Knowledge = {

    version: VERSION,

    knowledgeStatus:
      clone(KNOWLEDGE_STATUS),

    discoveryTypes:
      DISCOVERY_TYPES.slice(),

    registerService,

    registerServices,

    removeService,

    getService,

    getServices,

    findServices,

    findBestService,

    findServicesForNeed,

    getCombinations,

    findCombination,

    explainService,

    auditKnowledge,

    requiresDiscovery,

    getDiscoveryRequirements,

    recommendForNeeds,

    understand,

    calculateConfidence,

    buildExplanation
  };

  /* ==========================================================
   * ATTACH MODULE
   * ========================================================== */

  ROOT.knowledge =
    Knowledge;

  if (
    typeof ROOT.registerModule ===
    "function"
  ) {
    ROOT.registerModule(
      "knowledge",
      Knowledge
    );
  }

  /* ==========================================================
   * READY EVENT
   * ========================================================== */

  if (
    typeof ROOT.emit ===
    "function"
  ) {
    ROOT.emit(
      "module:ready",
      {
        module: "knowledge",
        version: VERSION
      }
    );
  }

  console.info(
    "[CGO Customer] Knowledge Engine ready:",
    VERSION
  );

})(window);
