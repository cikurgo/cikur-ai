/*
 * CGO Semantic Bridge — LOCAL / ZERO DEPENDENCY
 *
 * Purpose:
 * - membantu matching berdasarkan token, prefix, dan character n-gram;
 * - tidak mengunduh model;
 * - tidak memakai API, CDN, fetch, storage, atau library pihak ketiga;
 * - gagal/hasil rendah tetap aman: caller dapat fallback ke keyword biasa.
 *
 * API: window.CGOSemantic
 */
(function (global) {
  "use strict";

  const VERSION = "1.1.0-local-semantic";
  const DEFAULT_TOP_K = 5;
  const DEFAULT_MIN_SCORE = 0.18;
  const docCache = Object.create(null);
  let lastError = null;
  let status = "ready";

  function normalize(text) {
    return String(text == null ? "" : text)
      .toLowerCase()
      .normalize("NFKC")
      .replace(/[^\p{L}\p{N}_]+/gu, " ")
      .trim();
  }

  function tokens(text) {
    const s = normalize(text);
    return s ? s.split(/\s+/).filter(Boolean) : [];
  }

  function grams(text, n = 3) {
    const s = ` ${normalize(text)} `;
    const out = new Set();
    if (!s.trim()) return out;
    if (s.length <= n) { out.add(s); return out; }
    for (let i = 0; i <= s.length - n; i++) out.add(s.slice(i, i + n));
    return out;
  }

  function vector(text) {
    const ts = tokens(text);
    const tf = Object.create(null);
    for (const t of ts) tf[t] = (tf[t] || 0) + 1;
    const g = grams(text);
    return { tokens: tf, grams: g, size: ts.length };
  }

  function jaccard(a, b) {
    if (!a.size && !b.size) return 1;
    if (!a.size || !b.size) return 0;
    let common = 0;
    for (const x of a) if (b.has(x)) common++;
    return common / (a.size + b.size - common);
  }

  function tokenScore(a, b) {
    const ak = Object.keys(a.tokens);
    const bk = Object.keys(b.tokens);
    if (!ak.length || !bk.length) return 0;
    const aset = new Set(ak);
    const bset = new Set(bk);
    let common = 0;
    let weighted = 0;
    for (const k of aset) {
      if (!bset.has(k)) continue;
      common++;
      weighted += Math.min(a.tokens[k], b.tokens[k]);
    }
    const denom = Math.max(1, Math.max(a.size, b.size));
    return Math.min(1, (common / Math.max(ak.length, bk.length)) * 0.65 + (weighted / denom) * 0.35);
  }

  function prefixScore(a, b) {
    const x = normalize(a), y = normalize(b);
    if (!x || !y) return 0;
    if (x === y) return 1;
    if (x.startsWith(y) || y.startsWith(x)) return 0.35;
    return 0;
  }

  function similarity(aText, bText) {
    const a = vector(aText), b = vector(bText);
    const token = tokenScore(a, b);
    const gram = jaccard(a.grams, b.grams);
    const prefix = prefixScore(aText, bText);
    return Math.max(0, Math.min(1, token * 0.55 + gram * 0.35 + prefix * 0.10));
  }

  function ensureReady() { return Promise.resolve(true); }

  async function embed(text) {
    const s = normalize(text);
    if (!s) return null;
    // Deterministic local feature representation, bukan embedding model eksternal.
    return vector(s);
  }

  async function indexDocuments(docs, options) {
    options = options || {};
    if (!Array.isArray(docs) || !docs.length) return { ok: false, indexed: 0 };
    let n = 0;
    for (const d of docs) {
      if (!d || d.id == null) continue;
      const id = String(d.id);
      const text = String(d.text || "").trim();
      if (!text) continue;
      if (docCache[id] && !options.force) { n++; continue; }
      docCache[id] = { id, text, vector: vector(text) };
      n++;
    }
    return { ok: true, indexed: n, total: docs.length };
  }

  async function match(query, options) {
    options = options || {};
    const q = String(query || "").trim();
    if (!q) return [];
    const docs = Array.isArray(options.documents) ? options.documents : Object.values(docCache);
    if (options.documents) await indexDocuments(options.documents, { force: false });
    const topK = Math.max(1, Math.min(50, Number(options.topK) || DEFAULT_TOP_K));
    const minScore = options.minScore != null ? Number(options.minScore) : DEFAULT_MIN_SCORE;
    const scored = [];
    for (const d of docs) {
      if (!d || d.id == null) continue;
      const text = String(d.text || "");
      if (!text) continue;
      const score = similarity(q, text);
      if (score >= minScore) scored.push({ id: String(d.id), score: Number(score.toFixed(6)) });
    }
    scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return scored.slice(0, topK);
  }

  function isReady() { return status === "ready"; }
  function getStatus() {
    return { version: VERSION, status, ready: isReady(), error: lastError, model: null, cachedDocs: Object.keys(docCache).length, mode: "LOCAL_TOKEN_NGRAM" };
  }
  function clearCache() { for (const k of Object.keys(docCache)) delete docCache[k]; }

  const API = Object.freeze({
    version: VERSION,
    ensureReady,
    embed,
    indexDocuments,
    match,
    similarity,
    isReady,
    getStatus,
    clearCache
  });

  global.CGOSemantic = API;
})(typeof globalThis !== "undefined" ? globalThis : window);
