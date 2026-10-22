/* ============================================================
 * CGO PROXY WORKER v1.1.0
 * Cloudflare Worker — bypass X-Frame-Options + CORS untuk CCTV
 *
 * v1.1.0 (kompatibel penuh dengan v1.0.0; endpoint & bentuk JSON sama):
 *   - /health melaporkan features {htmlRewrite:false, hlsRewrite:true, range:true}
 *     agar drone-cgo.js tahu worker ini hanya meneruskan byte (HLS/JSON), bukan
 *     merender ulang halaman embed (itu tugas proxy-server.js >= 2.x).
 *   - Redirect diikuti MANUAL & tiap hop diperiksa ulang ke whitelist
 *     (v1.0.0 mengikuti redirect otomatis tanpa cek).
 *   - Header Range diteruskan (tidak merusak pemutaran segmen/seek).
 *   - Playlist .m3u8: Cache-Control no-store (playlist live tidak boleh di-cache).
 *   - /probe menambah finalUrl & contentType (sama seperti proxy-server.js).
 *   - Whitelist disamakan dengan proxy-server.js (+ streetside.mugnimaestra.dev).
 *
 * Deploy:
 *   1. Buka https://dash.cloudflare.com/?to=/:account/workers-and-pages/create
 *   2. Create Worker → beri nama, mis. "cgo-proxy"
 *   3. Hapus template default, tempel seluruh isi file ini
 *   4. Deploy → salin URL (mis. https://cgo-proxy.username.workers.dev)
 *   5. Di drone-cgo.html: panel CCTV Proxy → tempel URL → SET
 * ============================================================ */

const PROXY_VERSION = "1.1.0";

// Domain yang diizinkan lewat proxy (tambah sesuai kebutuhan)
const ALLOWED_DOMAINS = [
  "cctv.balitower.co.id",
  "matanya.batam.go.id",
  "streetside.mugnimaestra.dev",
  "www.youtube.com",
  "youtube.com",
  "youtu.be",
  "jakcctv.jakarta.go.id",
  "cctv-dishub.tangerangkab.go.id",
  "cctv.bantenprov.go.id",
  "cctv.serangkota.go.id",
  "atcs-dishub.bandung.go.id",
  "pelindung.bandung.go.id",
  "cctv.jogjakota.go.id",
  "pantausemar.semarangkota.go.id",
  "atcs.denpasarkota.go.id"
];

// Header yang dibuang dari upstream agar iframe tidak diblokir
const HEADERS_TO_STRIP = [
  "x-frame-options",
  "content-security-policy",
  "content-security-policy-report-only",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
  "permissions-policy",
  "clear-site-data"
];

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, POST, OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-expose-headers": "*",
  "access-control-max-age": "86400"
};

const MAX_REDIRECTS = 5;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS_HEADERS }
  });
}

function isAllowed(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    return ALLOWED_DOMAINS.some(d => h === d || h.endsWith("." + d));
  } catch (_) { return false; }
}

async function handleHealth() {
  return json({
    status: "ok", version: PROXY_VERSION, ts: Date.now(),
    features: { htmlRewrite: false, hlsRewrite: true, range: true },
    allowedDomains: ALLOWED_DOMAINS
  });
}

/* Ikuti redirect secara manual; setiap hop harus lolos whitelist (cegah open-redirect ke host lain) */
async function fetchAllowed(target, init) {
  let current = target;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isAllowed(current)) {
      const err = new Error("redirect ke domain yang tidak diizinkan: " + current);
      err.blocked = true;
      throw err;
    }
    const res = await fetch(current, { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      try { if (res.body && res.body.cancel) res.body.cancel(); } catch (_) {}
      current = new URL(res.headers.get("location"), current).toString();
      continue;
    }
    return { res, finalUrl: current };
  }
  const err = new Error("terlalu banyak redirect");
  err.blocked = true;
  throw err;
}

async function handleProxy(request) {
  const reqUrl = new URL(request.url);
  const target = reqUrl.searchParams.get("url");
  if (!target) return json({ error: "missing ?url=" }, 400);
  if (!isAllowed(target)) return json({ error: "domain not allowed", target }, 403);

  const upHeaders = {
    "user-agent": "Mozilla/5.0 (compatible; CGO-Proxy/" + PROXY_VERSION + ")",
    "referer": new URL(target).origin + "/",
    "accept": request.headers.get("accept") || "*/*"
  };
  const range = request.headers.get("range");
  if (range) upHeaders["range"] = range;

  let upstream, finalUrl = target;
  try {
    const r = await fetchAllowed(target, { method: request.method === "HEAD" ? "HEAD" : "GET", headers: upHeaders });
    upstream = r.res; finalUrl = r.finalUrl;
  } catch (e) {
    if (e && e.blocked) return json({ error: "domain not allowed", message: String(e.message), target }, 403);
    return json({ error: "fetch failed", message: String(e) }, 502);
  }

  // Salin header upstream, buang yang blokir iframe
  const headers = new Headers();
  upstream.headers.forEach((v, k) => {
    if (HEADERS_TO_STRIP.includes(k.toLowerCase())) return;
    headers.set(k, v);
  });
  Object.entries(CORS_HEADERS).forEach(([k, v]) => headers.set(k, v));

  // Khusus HLS (.m3u8): rewrite semua URL agar sub-segmen juga lewat proxy
  const ct = (upstream.headers.get("content-type") || "").toLowerCase();
  const isM3u8 = ct.includes("mpegurl") || /\.m3u8(\?|$)/i.test(finalUrl);
  if (isM3u8 && request.method !== "HEAD") {
    let text = await upstream.text();
    const baseUrl = new URL(finalUrl);
    const self = reqUrl.origin + reqUrl.pathname;
    text = text.split("\n").map(line => {
      const t = line.trim();
      if (!t || t.startsWith("#")) return line;
      try {
        const abs = new URL(t, baseUrl).toString();
        return self + "?url=" + encodeURIComponent(abs);
      } catch (_) { return line; }
    }).join("\n");
    text = text.replace(/URI="([^"]+)"/g, (m, u) => {
      try {
        const abs = new URL(u, baseUrl).toString();
        return 'URI="' + self + "?url=" + encodeURIComponent(abs) + '"';
      } catch (_) { return m; }
    });
    headers.set("content-type", "application/vnd.apple.mpegurl");
    headers.set("cache-control", "no-store");
    headers.delete("content-length");
    headers.delete("content-encoding");
    return new Response(text, { status: upstream.status, headers });
  }

  return new Response(request.method === "HEAD" ? null : upstream.body, { status: upstream.status, headers });
}

async function handleProbe(request) {
  const reqUrl = new URL(request.url);
  const target = reqUrl.searchParams.get("url");
  if (!target) return json({ ok: false, error: "missing ?url=" }, 400);
  if (!isAllowed(target)) return json({ ok: false, error: "domain not allowed" }, 403);

  const t0 = Date.now();
  try {
    const { res, finalUrl } = await fetchAllowed(target, {
      method: "GET",
      headers: { "user-agent": "Mozilla/5.0 (compatible; CGO-Proxy/" + PROXY_VERSION + ")" }
    });
    const ms = Date.now() - t0;
    const xfo = (res.headers.get("x-frame-options") || "").toLowerCase();
    const csp = (res.headers.get("content-security-policy") || "").toLowerCase();
    const frameBlocked = xfo.includes("deny") || xfo.includes("sameorigin") ||
      (csp.includes("frame-ancestors") && (csp.includes("'none'") || csp.includes("'self'")));
    try { if (res.body && res.body.cancel) res.body.cancel(); } catch (_) {}
    return json({
      ok: res.ok, status: res.status, ms, frameBlockedUpstream: frameBlocked,
      contentType: res.headers.get("content-type") || "", strippedByProxy: true, finalUrl
    });
  } catch (e) {
    if (e && e.blocked) return json({ ok: false, status: 0, error: String(e.message), ms: Date.now() - t0 }, 403);
    return json({ ok: false, status: 0, error: String(e), ms: Date.now() - t0 });
  }
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (path === "/" || path === "/health") return handleHealth();
    if (path === "/proxy") return handleProxy(request);
    if (path === "/probe") return handleProbe(request);
    return json({
      error: "not found", path,
      endpoints: ["/health", "/proxy?url=", "/probe?url="]
    }, 404);
  }
};
