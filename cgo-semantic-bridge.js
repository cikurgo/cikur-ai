/**
 * CGO Semantic Bridge — embedding gratis di browser (Transformers.js)
 * Membantu MESIN ABC + Knowledge matching berdasarkan MAKNA, bukan hanya keyword.
 *
 * - Zero API key / zero berlangganan
 * - Model diunduh sekali, lalu cache browser
 * - Gagal load → fallback diam ke keyword (otak tetap jalan)
 *
 * API: window.CGOSemantic
 */
(function (global) {
  "use strict";

  const VERSION = "1.0.0-semantic-bridge";
  /** Model kecil, cocok browser. Bisa diganti model multilingual bila perlu. */
  const DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2";
  const CACHE_KEY = "CGO_SEMANTIC_DOC_V1";

  let extractor = null;
  let loadPromise = null;
  let status = "idle"; // idle | loading | ready | error
  let lastError = null;
  const docCache = Object.create(null); // id → Float32Array / number[]

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
    if (tensorOrArr.data) {
      return Array.from(tensorOrArr.data);
    }
    if (typeof tensorOrArr === "object" && typeof tensorOrArr.length === "number") {
      return Array.from(tensorOrArr);
    }
    return null;
  }

  /**
   * Lazy-load Transformers.js + model. Aman dipanggil berkali-kali.
   */
  async function ensureReady(options) {
    options = options || {};
    if (status === "ready" && extractor) return true;
    if (status === "error" && !options.retry) return false;
    if (loadPromise) return loadPromise;

    status = "loading";
    loadPromise = (async function () {
      try {
        // Dynamic import CDN — tidak perlu build step
        const mod = await import(
          "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1"
        );
        const pipeline = mod.pipeline || (mod.default && mod.default.pipeline);
        if (typeof pipeline !== "function") {
          throw new Error("pipeline() tidak tersedia di Transformers.js");
        }

        // env: cache di browser
        try {
          if (mod.env) {
            mod.env.allowLocalModels = false;
            mod.env.useBrowserCache = true;
          }
        } catch (_) {}

        const modelId = options.model || DEFAULT_MODEL;
        extractor = await pipeline("feature-extraction", modelId, {
          // quantized default di banyak build
          progress_callback: options.onProgress || null
        });

        status = "ready";
        lastError = null;
        try {
          console.log(
            "[CGO-SEMANTIC] Siap ·",
            VERSION,
            "· model",
            modelId
          );
        } catch (_) {}
        return true;
      } catch (err) {
        status = "error";
        lastError = String(err && err.message ? err.message : err);
        extractor = null;
        loadPromise = null;
        try {
          console.warn("[CGO-SEMANTIC] Gagal load (fallback keyword):", lastError);
        } catch (_) {}
        return false;
      }
    })();

    return loadPromise;
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
   * Disimpan di memori (dan opsional localStorage ringkas).
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
        n++;
        continue;
      }
      const vec = await embed(text);
      if (vec) {
        docCache[d.id] = vec;
        n++;
      }
    }
    return { ok: true, indexed: n, total: docs.length };
  }

  /**
   * Cari dokumen paling mirip secara semantik.
   * @returns [{ id, score, text? }]
   */
  async function match(query, options) {
    options = options || {};
    const topK = options.topK || 5;
    const minScore = options.minScore != null ? options.minScore : 0.28;
    const q = String(query || "").trim();
    if (!q) return [];

    const qVec = await embed(q);
    if (!qVec) return [];

    // Docs dari cache atau dari options.documents
    const ids = options.documents
      ? options.documents.map(function (d) {
          return d.id;
        })
      : Object.keys(docCache);

    if (options.documents && options.documents.length) {
      await indexDocuments(options.documents, { force: false });
    }

    const scored = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const v = docCache[id];
      if (!v) continue;
      const score = cosine(qVec, v);
      if (score >= minScore) {
        scored.push({ id: id, score: score });
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
      cachedDocs: Object.keys(docCache).length
    };
  }

  function clearCache() {
    Object.keys(docCache).forEach(function (k) {
      delete docCache[k];
    });
  }

  const API = Object.freeze({
    version: VERSION,
    ensureReady: ensureReady,
    embed: embed,
    indexDocuments: indexDocuments,
    match: match,
    isReady: isReady,
    getStatus: getStatus,
    clearCache: clearCache,
    cosine: cosine
  });

  global.CGOSemantic = API;
  if (!global.CGO_SEMANTIC) global.CGO_SEMANTIC = API;

  try {
    console.log("[CGO-SEMANTIC] Modul terpasang ·", VERSION, "· panggil ensureReady() saat perlu");
  } catch (_) {}
})(typeof globalThis !== "undefined" ? globalThis : window);
