/* ============================================================
 * CIKUR GO — CUSTOMER MEMORY LAYER
 * ------------------------------------------------------------
 * File    : cgo-customer-memory.js
 * Version : 1.0.0-soft-memory
 *
 * Soft durable memory for Customer CGO.
 * - Pure client-side only (localStorage)
 * - No external API / server / AI
 * - Deterministic
 * - Soft: can decay, can be cleared by user
 * - Never invents facts
 * - Personality never overrides truth
 *
 * Storage key: CGO_CUSTOMER_MEMORY_V1
 * ============================================================ */

(function (window) {
  "use strict";

  const ROOT = window.CGO_CUSTOMER || (window.CGO_CUSTOMER = {});
  const VERSION = "1.0.0-soft-memory";
  const STORAGE_KEY = "CGO_CUSTOMER_MEMORY_V1";
  const MAX_PREF_PER_SERVICE = 12;
  const MAX_CONSTRAINT_HISTORY = 20;
  const MAX_NEED_KEYS = 10;

  /* ----------------------------------------------------------
   * Utilities
   * ---------------------------------------------------------- */
  function now() {
    return new Date().toISOString();
  }

  function clone(v) {
    try {
      return JSON.parse(JSON.stringify(v));
    } catch (e) {
      return v;
    }
  }

  function safeString(v) {
    return String(v == null ? "" : v).trim();
  }

  function lower(v) {
    return safeString(v).toLowerCase();
  }

  function unique(list) {
    const out = [];
    (Array.isArray(list) ? list : []).forEach(function (x) {
      if (x != null && x !== "" && out.indexOf(x) === -1) out.push(x);
    });
    return out;
  }

  /* ----------------------------------------------------------
   * Default shape
   * ---------------------------------------------------------- */
  function emptyMemory() {
    return {
      version: VERSION,
      preferences: {
        food: [],
        ride: [],
        assistant: [],
        general: []
      },
      constraintsHistory: [],
      emotionalPattern: {
        frequent: [],
        counts: {},
        lastStrong: null,
        lastAt: null
      },
      frequentNeeds: {},
      lastContext: {
        topic: null,
        locationHint: null,
        timeHint: null,
        preferences: [],
        updatedAt: null
      },
      createdAt: now(),
      updatedAt: now()
    };
  }

  /* ----------------------------------------------------------
   * Storage (localStorage only, graceful fallback)
   * ---------------------------------------------------------- */
  function canUseStorage() {
    try {
      if (typeof localStorage === "undefined") return false;
      const k = "__cgo_mem_test__";
      localStorage.setItem(k, "1");
      localStorage.removeItem(k);
      return true;
    } catch (e) {
      return false;
    }
  }

  const storageAvailable = canUseStorage();

  function readRaw() {
    if (!storageAvailable) return null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  function writeRaw(data) {
    if (!storageAvailable) return false;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ----------------------------------------------------------
   * In-memory state
   * ---------------------------------------------------------- */
  let mem = emptyMemory();
  let loaded = false;

  function ensureLoaded() {
    if (loaded) return mem;
    const raw = readRaw();
    if (raw && typeof raw === "object") {
      mem = normalize(raw);
    } else {
      mem = emptyMemory();
    }
    loaded = true;
    return mem;
  }

  function normalize(raw) {
    const base = emptyMemory();
    if (!raw || typeof raw !== "object") return base;

    // Preferences
    if (raw.preferences && typeof raw.preferences === "object") {
      ["food", "ride", "assistant", "general"].forEach(function (k) {
        if (Array.isArray(raw.preferences[k])) {
          base.preferences[k] = unique(raw.preferences[k]).slice(0, MAX_PREF_PER_SERVICE);
        }
      });
    }

    // Constraints history
    if (Array.isArray(raw.constraintsHistory)) {
      base.constraintsHistory = raw.constraintsHistory
        .filter(function (c) {
          return c && typeof c === "object";
        })
        .slice(-MAX_CONSTRAINT_HISTORY);
    }

    // Emotional pattern
    if (raw.emotionalPattern && typeof raw.emotionalPattern === "object") {
      base.emotionalPattern.frequent = Array.isArray(raw.emotionalPattern.frequent)
        ? unique(raw.emotionalPattern.frequent).slice(0, 8)
        : [];
      base.emotionalPattern.counts =
        raw.emotionalPattern.counts && typeof raw.emotionalPattern.counts === "object"
          ? raw.emotionalPattern.counts
          : {};
      base.emotionalPattern.lastStrong = raw.emotionalPattern.lastStrong || null;
      base.emotionalPattern.lastAt = raw.emotionalPattern.lastAt || null;
    }

    // Frequent needs
    if (raw.frequentNeeds && typeof raw.frequentNeeds === "object") {
      const keys = Object.keys(raw.frequentNeeds).slice(0, MAX_NEED_KEYS);
      keys.forEach(function (k) {
        const n = Number(raw.frequentNeeds[k]);
        if (!isNaN(n) && n > 0) base.frequentNeeds[k] = Math.floor(n);
      });
    }

    // Last context
    if (raw.lastContext && typeof raw.lastContext === "object") {
      base.lastContext.topic = raw.lastContext.topic || null;
      base.lastContext.locationHint = raw.lastContext.locationHint || null;
      base.lastContext.timeHint = raw.lastContext.timeHint || null;
      base.lastContext.preferences = Array.isArray(raw.lastContext.preferences)
        ? unique(raw.lastContext.preferences)
        : [];
      base.lastContext.updatedAt = raw.lastContext.updatedAt || null;
    }

    base.createdAt = raw.createdAt || base.createdAt;
    base.updatedAt = raw.updatedAt || base.updatedAt;
    base.version = VERSION;
    return base;
  }

  function persist() {
    mem.updatedAt = now();
    writeRaw(mem);
  }

  /* ----------------------------------------------------------
   * Public API
   * ---------------------------------------------------------- */
  function load() {
    ensureLoaded();
    return clone(mem);
  }

  function save(partial) {
    ensureLoaded();
    if (!partial || typeof partial !== "object") return clone(mem);

    if (partial.preferences && typeof partial.preferences === "object") {
      ["food", "ride", "assistant", "general"].forEach(function (k) {
        if (Array.isArray(partial.preferences[k])) {
          mem.preferences[k] = unique(
            (mem.preferences[k] || []).concat(partial.preferences[k])
          ).slice(0, MAX_PREF_PER_SERVICE);
        }
      });
    }

    if (partial.lastContext && typeof partial.lastContext === "object") {
      Object.keys(partial.lastContext).forEach(function (k) {
        if (partial.lastContext[k] != null) {
          mem.lastContext[k] = partial.lastContext[k];
        }
      });
      mem.lastContext.updatedAt = now();
    }

    persist();
    return clone(mem);
  }

  function getPreferences(service) {
    ensureLoaded();
    const s = lower(service || "general");
    if (s === "food" || s === "ride" || s === "assistant") {
      return clone(mem.preferences[s] || []);
    }
    // Merge all when general / unknown
    return unique(
      [].concat(
        mem.preferences.food || [],
        mem.preferences.ride || [],
        mem.preferences.assistant || [],
        mem.preferences.general || []
      )
    );
  }

  function addPreferences(service, tags) {
    ensureLoaded();
    const s = lower(service || "general");
    const key =
      s === "food" || s === "ride" || s === "assistant" ? s : "general";
    const list = Array.isArray(tags) ? tags : [tags];
    mem.preferences[key] = unique(
      (mem.preferences[key] || []).concat(list.map(safeString).filter(Boolean))
    ).slice(0, MAX_PREF_PER_SERVICE);
    persist();
    return clone(mem.preferences[key]);
  }

  function recordEmotion(mood, strength) {
    ensureLoaded();
    const m = lower(mood || "");
    if (!m || m === "neutral" || m === "casual") return clone(mem.emotionalPattern);

    mem.emotionalPattern.counts[m] = (mem.emotionalPattern.counts[m] || 0) + 1;

    // Rebuild frequent (top by count)
    const sorted = Object.keys(mem.emotionalPattern.counts)
      .map(function (k) {
        return { mood: k, n: mem.emotionalPattern.counts[k] };
      })
      .sort(function (a, b) {
        return b.n - a.n;
      });
    mem.emotionalPattern.frequent = sorted.slice(0, 5).map(function (x) {
      return x.mood;
    });

    const strong =
      strength === "strong" ||
      m === "sad" ||
      m === "stressed" ||
      m === "lonely" ||
      m === "tired";
    if (strong) {
      mem.emotionalPattern.lastStrong = m;
      mem.emotionalPattern.lastAt = now();
    }

    persist();
    return clone(mem.emotionalPattern);
  }

  function recordNeed(need) {
    ensureLoaded();
    const n = lower(need || "");
    if (!n) return clone(mem.frequentNeeds);
    mem.frequentNeeds[n] = (mem.frequentNeeds[n] || 0) + 1;
    // Keep size bounded
    const keys = Object.keys(mem.frequentNeeds);
    if (keys.length > MAX_NEED_KEYS) {
      keys
        .sort(function (a, b) {
          return mem.frequentNeeds[a] - mem.frequentNeeds[b];
        })
        .slice(0, keys.length - MAX_NEED_KEYS)
        .forEach(function (k) {
          delete mem.frequentNeeds[k];
        });
    }
    persist();
    return clone(mem.frequentNeeds);
  }

  function recordConstraints(constraints) {
    ensureLoaded();
    if (!constraints || typeof constraints !== "object") return;
    const entry = {
      at: now(),
      budgetMax: constraints.budgetMax || null,
      budgetMin: constraints.budgetMin || null,
      timeHint: constraints.timeHint || null,
      locationHint: constraints.locationHint || null,
      nearMe: !!constraints.nearMe,
      simplicity: !!constraints.simplicity,
      speed: !!constraints.speed,
      tags: Array.isArray(constraints.tags) ? constraints.tags.slice() : []
    };
    mem.constraintsHistory.push(entry);
    if (mem.constraintsHistory.length > MAX_CONSTRAINT_HISTORY) {
      mem.constraintsHistory = mem.constraintsHistory.slice(-MAX_CONSTRAINT_HISTORY);
    }

    // Also reflect useful bits into lastContext
    if (constraints.locationHint) {
      mem.lastContext.locationHint = constraints.locationHint;
    }
    if (constraints.timeHint) {
      mem.lastContext.timeHint = constraints.timeHint;
    }
    mem.lastContext.updatedAt = now();

    persist();
  }

  function setLastContext(ctx) {
    ensureLoaded();
    if (!ctx || typeof ctx !== "object") return clone(mem.lastContext);
    if (ctx.topic != null) mem.lastContext.topic = ctx.topic;
    if (ctx.locationHint != null) mem.lastContext.locationHint = ctx.locationHint;
    if (ctx.timeHint != null) mem.lastContext.timeHint = ctx.timeHint;
    if (Array.isArray(ctx.preferences)) {
      mem.lastContext.preferences = unique(ctx.preferences);
    }
    mem.lastContext.updatedAt = now();
    persist();
    return clone(mem.lastContext);
  }

  function getLastContext() {
    ensureLoaded();
    return clone(mem.lastContext);
  }

  function getEmotionalPattern() {
    ensureLoaded();
    return clone(mem.emotionalPattern);
  }

  function getFrequentNeeds() {
    ensureLoaded();
    return clone(mem.frequentNeeds);
  }

  /**
   * Merge session reasoning state into durable memory.
   * Called by gateway / conversation after a meaningful turn.
   */
  function ingestSession(session) {
    ensureLoaded();
    if (!session || typeof session !== "object") return clone(mem);

    // Preferences from reasoning
    if (Array.isArray(session.preferences) && session.preferences.length) {
      const topic = lower(session.lastTopic || session.topic || "general");
      const key =
        topic === "food" || topic === "ride" || topic === "assistant"
          ? topic
          : "general";
      addPreferences(key, session.preferences);
    }

    // Emotion
    if (session.lastEmotion) {
      recordEmotion(session.lastEmotion, session.emotionStrength);
    }

    // Needs
    if (Array.isArray(session.activeNeeds)) {
      session.activeNeeds.forEach(function (n) {
        recordNeed(n);
      });
    }

    // Constraints
    if (session.constraints) {
      recordConstraints(session.constraints);
    }

    // Last context
    setLastContext({
      topic: session.lastTopic || session.topic || null,
      locationHint:
        (session.constraints && session.constraints.locationHint) || null,
      timeHint: (session.constraints && session.constraints.timeHint) || null,
      preferences: session.preferences || []
    });

    return clone(mem);
  }

  /**
   * Soft suggestions for reasoning (never invent facts).
   * Returns known preferences + last context for the current topic.
   */
  function suggestFor(topic) {
    ensureLoaded();
    const t = lower(topic || "general");
    return {
      preferences: getPreferences(t),
      lastLocation: mem.lastContext.locationHint || null,
      lastTime: mem.lastContext.timeHint || null,
      frequentEmotion: (mem.emotionalPattern.frequent || [])[0] || null,
      lastStrongEmotion: mem.emotionalPattern.lastStrong || null,
      needCounts: clone(mem.frequentNeeds)
    };
  }

  function clear() {
    mem = emptyMemory();
    loaded = true;
    if (storageAvailable) {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch (e) {}
    }
    return clone(mem);
  }

  function isAvailable() {
    return storageAvailable;
  }

  function getVersion() {
    return VERSION;
  }

  /* ----------------------------------------------------------
   * Public object
   * ---------------------------------------------------------- */
  const Memory = {
    version: VERSION,
    load: load,
    save: save,
    getPreferences: getPreferences,
    addPreferences: addPreferences,
    recordEmotion: recordEmotion,
    recordNeed: recordNeed,
    recordConstraints: recordConstraints,
    setLastContext: setLastContext,
    getLastContext: getLastContext,
    getEmotionalPattern: getEmotionalPattern,
    getFrequentNeeds: getFrequentNeeds,
    ingestSession: ingestSession,
    suggestFor: suggestFor,
    clear: clear,
    isAvailable: isAvailable,
    getVersion: getVersion
  };

  ROOT.memory = Memory;

  if (typeof ROOT.registerModule === "function") {
    ROOT.registerModule("memory", Memory);
  }

  if (typeof ROOT.emit === "function") {
    ROOT.emit("module:ready", {
      module: "memory",
      version: VERSION
    });
  }

  console.info("[CGO Customer] Memory Engine ready:", VERSION);
})(window);
