/**
 * CGO Semantic Bridge — embedding offline di browser (Transformers.js lokal)
 * Membantu MESIN ABC + Knowledge matching berdasarkan MAKNA, bukan hanya keyword.
 *
 * Prinsip CGO:
 * - Zero API key / zero berlangganan / zero CDN runtime
 * - Model & library disimpan lokal di server
 * - Gagal load → fallback diam ke keyword (otak tetap jalan)
 * - Tidak print ke console kecuali options.debug === true
 *
 * API publik (jangan diubah):
 *   ensureReady, embed, indexDocuments, match, isReady, getStatus, clearCache, cosine
 *
 * window.CGOSemantic
 * Version 1.1.0-semantic-bridge
 */
(function (global) {
  "use strict";

  const VERSION = "1.1.0-semantic-bridge";
  /** Model lokal (folder di assets/models/). */
  const DEFAULT_MODEL = "all-MiniLM-L6-v2";
  const CACHE_KEY = "CGO_SEMANTIC_DOC_V1";
  const MAX_CACHE = 500;
  const TIMEOUT_MS = 15000;
  const MAX_RETRY = 3;

  /** Path relatif ke halaman admin (aman di GitHub Pages /cikur-ai/admin/). */
  function resolveUrl(rel) {
    try {
      const base = (typeof document !== "undefined" && document.baseURI) ||
        (typeof location !== "undefined" && location.href) ||
        "./";
      return new URL(rel, base).href;
    } catch (_) {
      return rel;
    }
  }

  const LIB_URL = resolveUrl("./assets/lib/transformers.min.js");
  const LOCAL_MODEL_PATH = resolveUrl("./assets/models/");

  let extractor = null;
  let loadPromise = null;
  let status = "idle"; // idle | loading | ready | error
  let lastError = null;
  const docCache = Object.create(null); // id → number[]
  const docText = Object.create(null); // id → text (untuk match text)

  function dbg(options) {
    return !!(options && options.debug);
  }

  function log() {
    /* silent by default — hanya lewat debugPrint */
  }

  function debugPrint(options, args) {
    if (!dbg(options)) return;
    try {
      if (typeof console !== "undefined" && console.log) {
        console.log.apply(console, ["[CGO-SEMANTIC]"].concat(args || []));
      }
    } catch (_) {}
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function cosine(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      const y = b[i];
      dot += x * y;
      na += x * x;
      nb += y * y;
    }
    if (na <= 0 || nb <= 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  function toArray(tensorOrArr) {
    if (!tensorOrArr) return null;
    if (Array.isArray(tensorOrArr)) return tensorOrArr;
    if (tensorOrArr.data) return Array.from(tensorOrArr.data);
    if (typeof tensorOrArr === "object" && typeof tensorOrArr.length === "number") {
      return Array.from(tensorOrArr);
    }
    return null;
  }

  function pruneCache() {
    const keys = Object.keys(docCache);
    if (keys.length <= MAX_CACHE) return;
    const toRemove = keys.slice(0, keys.length - MAX_CACHE);
    for (let i = 0; i < toRemove.length; i++) {
      delete docCache[toRemove[i]];
      delete docText[toRemove[i]];
    }
  }

  function saveCache() {
    try {
      if (typeof localStorage === "undefined") return;
      const obj = {};
      const keys = Object.keys(docCache);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        obj[k] = Array.from(docCache[k]);
      }
      localStorage.setItem(CACHE_KEY, JSON.stringify(obj));
    } catch (_) {}
  }

  function loadCache() {
    try {
      if (typeof localStorage === "undefined") return;
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return;
      const obj = JSON.parse(raw);
      const keys = Object.keys(obj || {});
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (Array.isArray(obj[k])) {
          docCache[k] = obj[k];
        }
      }
    } catch (_) {}
  }

  async function loadModuleOnce(options) {
    const timeoutPromise = new Promise(function (_, reject) {
      setTimeout(function () {
        reject(new Error("Load timeout " + TIMEOUT_MS + "ms"));
      }, TIMEOUT_MS);
    });
    const mod = await Promise.race([import(LIB_URL), timeoutPromise]);
    const pipeline = mod.pipeline || (mod.default && mod.default.pipeline);
    if (typeof pipeline !== "function") {
      throw new Error("pipeline() tidak tersedia di Transformers.js lokal");
    }

    try {
      if (mod.env) {
        mod.env.allowLocalModels = true;
        mod.env.localModelPath = LOCAL_MODEL_PATH;
        mod.env.allowRemoteModels = false;
        mod.env.useBrowserCache = true;
      }
    } catch (_) {}

    const modelId = options.model || DEFAULT_MODEL;
    const pipeOpts = {
      quantized: true,
      progress_callback: options.onProgress || null
    };
    // local_files_only: dukung jika runtime mengenali
    try {
      pipeOpts.local_files_only = true;
    } catch (_) {}

    extractor = await pipeline("feature-extraction", modelId, pipeOpts);
    return true;
  }

  /**
   * Lazy-load Transformers.js lokal + model lokal.
   * Aman dipanggil berkali-kali. Gagal → false (fallback keyword).
   */
  async function ensureReady(options) {
    options = options || {};
    if (status === "ready" && extractor) return true;
    if (status === "error" && !options.retry) return false;
    if (loadPromise) return loadPromise;

    status = "loading";
    loadPromise = (async function () {
      let attempt = 0;
      let lastErr = null;
      while (attempt < MAX_RETRY) {
        attempt++;
        try {
          await loadModuleOnce(options);
          status = "ready";
          lastError = null;
          debugPrint(options, ["Siap ·", VERSION, "· model", options.model || DEFAULT_MODEL, "· attempt", attempt]);
          // Warmup non-blocking
          try {
            setTimeout(function () {
              warmup().catch(function () {});
            }, 50);
          } catch (_) {}
          return true;
        } catch (err) {
          lastErr = err;
          lastError = String(err && err.message ? err.message : err);
          debugPrint(options, ["Attempt", attempt, "gagal:", lastError]);
          extractor = null;
          if (attempt < MAX_RETRY) {
            await sleep(1000 * attempt);
          }
        }
      }
      status = "error";
      extractor = null;
      loadPromise = null;
      lastError = String(lastErr && lastErr.message ? lastErr.message : lastErr || "unknown");
      debugPrint(options, ["Gagal load setelah", MAX_RETRY, "percobaan (fallback keyword):", lastError]);
      return false;
    })();

    return loadPromise;
  }

  async function warmup() {
    try {
      return await embed("warmup");
    } catch (_) {
      return null;
    }
  }

  async function embed(text) {
    const t = String(text || "").trim();
    if (!t) return null;
    const ok = await ensureReady();
    if (!ok || !extractor) return null;
    try {
      const out = await extractor(t, {
        pooling: "mean",
        normalize: true
      });
      return toArray(out);
    } catch (err) {
      lastError = String(err && err.message ? err.message : err);
      return null;
    }
  }

  /**
   * Index dokumen knowledge: [{ id, text }]
   */
  async function indexDocuments(docs, options) {
    options = options || {};
    if (!Array.isArray(docs) || !docs.length) {
      return { ok: false, indexed: 0 };
    }
    const ok = await ensureReady(options);
    if (!ok) return { ok: false, indexed: 0, error: lastError };

    let n = 0;
    for (let i = 0; i < docs.length; i++) {
      const d = docs[i];
      if (!d || !d.id) continue;
      const text = String(d.text || "").trim();
      if (!text) continue;
      if (docCache[d.id] && !options.force) {
        if (!docText[d.id]) docText[d.id] = text;
        n++;
        continue;
      }
      const vec = await embed(text);
      if (vec) {
        docCache[d.id] = vec;
        docText[d.id] = text;
        n++;
      }
    }
    pruneCache();
    saveCache();
    return { ok: true, indexed: n, total: docs.length };
  }

  /**
   * Cari dokumen paling mirip secara semantik.
   * @returns [{ id, score, text }]
   */
  async function match(query, options) {
    options = options || {};
    const topK = options.topK || 5;
    const minScore = options.minScore != null ? options.minScore : 0.28;
    const q = String(query || "").trim();
    if (!q) return [];

    const qVec = await embed(q);
    if (!qVec) return [];

    if (options.documents && options.documents.length) {
      await indexDocuments(options.documents, { force: false });
      for (let i = 0; i < options.documents.length; i++) {
        const d = options.documents[i];
        if (d && d.id && d.text) docText[d.id] = String(d.text);
      }
    }

    const ids = options.documents
      ? options.documents.map(function (d) { return d.id; })
      : Object.keys(docCache);

    const scored = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const v = docCache[id];
      if (!v) continue;
      const score = cosine(qVec, v);
      if (score >= minScore) {
        let text = docText[id] || null;
        if (!text && options.documents) {
          const found = options.documents.find(function (d) { return d && d.id === id; });
          text = found ? String(found.text || "") : null;
        }
        scored.push({ id: id, score: score, text: text });
      }
    }
    scored.sort(function (a, b) {
      return b.score - a.score;
    });
    return scored.slice(0, topK);
  }

  function isReady() {
    return status === "ready" && !!extractor;
  }

  function getStatus() {
    return {
      version: VERSION,
      status: status,
      ready: isReady(),
      error: lastError,
      model: DEFAULT_MODEL,
      cachedDocs: Object.keys(docCache).length,
      lib: LIB_URL,
      localModelPath: LOCAL_MODEL_PATH
    };
  }

  function clearCache() {
    Object.keys(docCache).forEach(function (k) {
      delete docCache[k];
      delete docText[k];
    });
    try {
      if (typeof localStorage !== "undefined") localStorage.removeItem(CACHE_KEY);
    } catch (_) {}
  }

  // Muat cache embedding dokumen dari localStorage
  loadCache();

  const API = Object.freeze({
    version: VERSION,
    ensureReady: ensureReady,
    embed: embed,
    indexDocuments: indexDocuments,
    match: match,
    isReady: isReady,
    getStatus: getStatus,
    clearCache: clearCache,
    cosine: cosine,
    warmup: warmup
  });

  global.CGOSemantic = API;
  if (!global.CGO_SEMANTIC) global.CGO_SEMANTIC = API;
})(typeof globalThis !== "undefined" ? globalThis : window);
