/* ============================================================================
 * CGO — CCTV PROXY SERVER
 * File: proxy-server.js
 * Version: 2.0.2
 * ============================================================================
 * Tujuan (sama seperti v1.0.0, semua dipertahankan):
 *   - Menghapus header X-Frame-Options & CSP frame-ancestors agar bisa di-iframe
 *   - Menulis ulang URL relatif agar aset (CSS/JS/gambar) tetap melalui proxy
 *   - Whitelist domain untuk keamanan
 *   - CORS enabled
 *
 * Perubahan v2.0.2: whitelist + streetside.mugnimaestra.dev (dipakai drone-cgo.js v6.17+);
 *   /health kini melaporkan features {htmlRewrite,hlsRewrite,range} agar UI menyesuaikan diri.
 *
 * Perbaikan v2.0.0 (penyebab CCTV tidak termuat):
 *   1. Header content-encoding / content-length asli DISALIN padahal body sudah
 *      didekompres & ditulis ulang -> browser gagal decode (blank/ERR_CONTENT_
 *      DECODING_FAILED). Sekarang hanya header aman yang diteruskan.
 *   2. Playlist HLS (.m3u8) tidak ditulis ulang -> segmen .ts gagal dimuat.
 *      Sekarang URI di playlist diarahkan lewat proxy.
 *   3. Request fetch()/XHR milik player di dalam halaman embed (hls.js dsb)
 *      terkena CORS. Sekarang disuntik shim kecil yang mengarahkan ulang ke proxy.
 *   4. Redirect diikuti axios tanpa cek whitelist (celah SSRF). Sekarang tiap
 *      redirect diperiksa ulang terhadap whitelist.
 *   5. Seluruh respons di-buffer penuh. Sekarang di-stream + dukung Range.
 *   6. Endpoint baru /probe?url= untuk diagnosa (dipakai tombol DIAGNOSTIC).
 *   7. Tanpa dependensi (tidak perlu npm install express axios). Butuh Node >= 18.
 *
 * Cara jalankan:
 *   node proxy-server.js                      (port 3001, atau env PORT)
 *   EXTRA_ALLOWED_DOMAINS=a.com,b.com node proxy-server.js   (opsional)
 *
 * Endpoint (kompatibel dengan v1.0.0):
 *   GET /proxy?url=<URL>   GET /health   GET /probe?url=<URL>
 * ============================================================================ */

/* ===== CORE:BEGIN (Web-standard API; dipakai juga oleh proxy-worker.js) ===== */
const PROXY_VERSION = "2.0.2";

/* Whitelist domain yang diizinkan untuk diproksi */
const ALLOWED_DOMAINS = ["cctv.balitower.co.id",
  "jakcctv.jakarta.go.id",
  "atcs-dishub.bandung.go.id",
  "pelindung.bandung.go.id",
  "cctv.jogjakota.go.id",
  "pantausemar.semarangkota.go.id",
  "atcs.denpasarkota.go.id",
  "cctv-dishub.tangerangkab.go.id",
  "cctv.bantenprov.go.id",
  "cctv.serangkota.go.id",
  "matanya.batam.go.id",
  "streetside.mugnimaestra.dev"   /* sumber Streetside di drone-cgo.js v6.17+ (API JSON + HLS) */,
  "atcsdishub.medan.go.id",
  "dishub.bekasikota.go.id",
  "bsw.kotabogor.go.id",
  "socakaton.cirebonkab.go.id",
  "cctv.malangkota.go.id",
  "seribuwajah.bandarlampungkota.go.id",
  "paralluta.makassarkota.go.id",
  "atcs.banjarmasinkota.go.id",
  "cctv.bandaacehkota.go.id",
  "atcs-jakarta.com",
];

/* Header yang harus dihapus agar bisa di-embed */
const HEADERS_TO_REMOVE = [
  "x-frame-options",
  "content-security-policy",
  "content-security-policy-report-only",
  "x-content-type-options"
];

/* Hanya header ini yang diteruskan dari upstream ke browser */
const HEADERS_TO_PASS = [
  "content-type", "content-range", "accept-ranges",
  "etag", "last-modified", "expires"
];

const UPSTREAM_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Range",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, Content-Type"
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function createHandler(cfg) {
  cfg = cfg || {};
  const allowed = new Set(ALLOWED_DOMAINS);
  String(cfg.extraDomains || "").split(",").map(s => s.trim().toLowerCase())
    .filter(Boolean).forEach(d => allowed.add(d));
  const timeoutMs = cfg.timeoutMs || 25000;
  const maxRedirects = 5;

  function respond(body, status, headers) {
    const h = new Headers(CORS_HEADERS);
    for (const k in (headers || {})) h.set(k, headers[k]);
    return new Response(body, { status: status || 200, headers: h });
  }
  function json(obj, status) {
    return respond(JSON.stringify(obj), status, { "Content-Type": "application/json; charset=utf-8" });
  }
  function text(msg, status) {
    return respond(msg, status, { "Content-Type": "text/plain; charset=utf-8" });
  }

  function assertAllowed(u) {
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new HttpError(400, "Invalid URL");
    if (!allowed.has(u.hostname.toLowerCase())) throw new HttpError(403, "Domain not allowed: " + u.hostname);
  }

  /* Ambil URL upstream; setiap redirect diperiksa ulang terhadap whitelist */
  async function fetchUpstream(targetUrl, request, extraHeaders) {
    let current = new URL(targetUrl);
    for (let hop = 0; hop <= maxRedirects; hop++) {
      assertAllowed(current);
      const headers = {
        "User-Agent": UPSTREAM_UA,
        "Accept": request.headers.get("accept") || "*/*",
        "Accept-Language": "id,en;q=0.8",
        "Referer": current.origin + "/"
      };
      const range = request.headers.get("range");
      if (range) headers["Range"] = range;
      Object.assign(headers, extraHeaders || {});
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let res;
      try {
        res = await fetch(current.href, { method: "GET", headers, redirect: "manual", signal: ctrl.signal });
      } catch (e) {
        throw new HttpError(e && e.name === "AbortError" ? 504 : 502,
          "Proxy error: " + (e && e.name === "AbortError" ? "timeout" : (e && e.cause && e.cause.code) || (e && e.message)));
      } finally { clearTimeout(timer); }
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        try { if (res.body) res.body.cancel(); } catch (_) {}
        current = new URL(res.headers.get("location"), current);
        continue;
      }
      return { res, finalUrl: current };
    }
    throw new HttpError(502, "Proxy error: too many redirects");
  }

  function makeRewriter(base, pageUrl) {
    const px = abs => base + "/proxy?url=" + encodeURIComponent(abs);
    function ref(r) {
      const t = String(r).trim();
      if (!t || /^(#|data:|javascript:|blob:|mailto:|about:|tel:)/i.test(t)) return r;
      let abs;
      try { abs = new URL(t, pageUrl).href; } catch (_) { return r; }
      if (!/^https?:/i.test(abs)) return r;
      let host;
      try { host = new URL(abs).hostname.toLowerCase(); } catch (_) { return r; }
      /* host di luar whitelist: biarkan absolut, browser memuat langsung */
      if (!allowed.has(host)) return abs;
      return px(abs);
    }
    return { px, ref };
  }

  function rewriteCss(css, rw) {
    return css.replace(/url\(\s*(["']?)([^)"']+)\1\s*\)/gi,
      (m, q, u) => "url(" + q + rw.ref(u) + q + ")");
  }

  function rewriteM3u8(body, rw) {
    return body.split(/\r?\n/).map(line => {
      if (!line) return line;
      if (line.charAt(0) === "#") {
        return line
          .replace(/URI="([^"]+)"/gi, (m, u) => 'URI="' + rw.ref(u) + '"')
          .replace(/URI='([^']+)'/gi, (m, u) => "URI='" + rw.ref(u) + "'");
      }
      return rw.ref(line);
    }).join("\n");
  }

  function shimScript(base) {
    const hosts = JSON.stringify(Array.from(allowed));
    return "<script>(function(){var B=" + JSON.stringify(base) + ",A=" + hosts + ";" +
      "function px(u){try{var a=new URL(String(u),document.baseURI);" +
      "if(a.protocol!=='http:'&&a.protocol!=='https:')return u;" +
      "if(a.href.indexOf(B+'/proxy?')===0)return u;" +
      "if(A.indexOf(a.hostname.toLowerCase())<0)return u;" +
      "return B+'/proxy?url='+encodeURIComponent(a.href)}catch(e){return u}}" +
      "var F=window.fetch;if(F)window.fetch=function(i,o){try{" +
      "if(typeof i==='string'||(window.URL&&i instanceof URL))i=px(i);" +
      "else if(i&&i.url)i=new Request(px(i.url),i)}catch(e){}return F.call(this,i,o)};" +
      "var O=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(){" +
      "var a=[].slice.call(arguments);a[1]=px(a[1]);return O.apply(this,a)};" +
      "[['HTMLMediaElement','src'],['HTMLSourceElement','src'],['HTMLImageElement','src']," +
      "['HTMLScriptElement','src'],['HTMLIFrameElement','src'],['HTMLLinkElement','href']].forEach(function(p){" +
      "try{var P=window[p[0]].prototype,D=Object.getOwnPropertyDescriptor(P,p[1]);" +
      "if(D&&D.set)Object.defineProperty(P,p[1],{configurable:true,enumerable:D.enumerable," +
      "get:D.get,set:function(v){D.set.call(this,px(v))}})}catch(e){}});" +
      "var S=Element.prototype.setAttribute;Element.prototype.setAttribute=function(n,v){" +
      "if(typeof v==='string'&&this.tagName!=='A'&&(n==='src'||n==='href'||n==='poster'))v=px(v);" +
      "return S.call(this,n,v)};})();</script>";
  }

  function rewriteHtml(html, rw, base, pageUrl) {
    html = html.replace(/<meta[^>]+http-equiv\s*=\s*["']?(content-security-policy|x-frame-options)["']?[^>]*>/gi, "");
    html = html.replace(/(\s(?:src|href|action|poster|data-src)\s*=\s*)(["'])(.*?)\2/gi,
      (m, pre, q, v) => pre + q + rw.ref(v) + q);
    html = html.replace(/(\ssrcset\s*=\s*)(["'])(.*?)\2/gi, (m, pre, q, v) => {
      const out = v.split(",").map(part => {
        const bits = part.trim().split(/\s+/);
        if (!bits[0]) return part;
        return rw.ref(bits[0]) + (bits[1] ? " " + bits[1] : "");
      }).join(", ");
      return pre + q + out + q;
    });
    html = html.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi,
      (m, a, css, c) => a + rewriteCss(css, rw) + c);
    const inject = '<base href="' + pageUrl.replace(/"/g, "&quot;") + '">' + shimScript(base);
    if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, m => m + inject);
    return inject + html;
  }

  async function handleProxy(request, base, target) {
    let parsed;
    try { parsed = new URL(target); } catch (_) { throw new HttpError(400, "Invalid URL"); }
    const { res, finalUrl } = await fetchUpstream(parsed.href, request);
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    const pageUrl = finalUrl.href;
    const rw = makeRewriter(base, pageUrl);

    const out = {};
    for (const k of HEADERS_TO_PASS) {
      const v = res.headers.get(k);
      if (v && HEADERS_TO_REMOVE.indexOf(k) < 0) out[k] = v;
    }
    /* Header permisif */
    out["X-Frame-Options"] = "ALLOWALL";
    out["Content-Security-Policy"] = "frame-ancestors *";

    const isM3u8 = ct.indexOf("mpegurl") >= 0 || /\.m3u8(\?|$)/i.test(finalUrl.pathname + finalUrl.search);
    if (res.status >= 400) {
      return text("Proxy error: " + res.status, res.status === 404 ? 404 : 502);
    }
    if (ct.indexOf("text/html") >= 0) {
      const html = rewriteHtml(await res.text(), rw, base, pageUrl);
      out["Content-Type"] = "text/html; charset=utf-8";
      out["Cache-Control"] = "no-store";
      return respond(html, 200, out);
    }
    if (isM3u8) {
      const body = await res.text();
      out["Content-Type"] = "application/vnd.apple.mpegurl";
      out["Cache-Control"] = "no-store";
      return respond(rewriteM3u8(body, rw), 200, out);
    }
    if (ct.indexOf("text/css") >= 0) {
      const css = rewriteCss(await res.text(), rw);
      out["Content-Type"] = "text/css; charset=utf-8";
      return respond(css, 200, out);
    }
    /* Biner (gambar, video, segmen .ts, font, js) — di-stream apa adanya */
    const enc = res.headers.get("content-encoding");
    const len = res.headers.get("content-length");
    if (len && !enc) out["Content-Length"] = len;
    out["Cache-Control"] = res.headers.get("cache-control") || "no-store";
    return respond(res.body, res.status, out);
  }

  async function handleProbe(request, target) {
    let parsed;
    try { parsed = new URL(target); } catch (_) { throw new HttpError(400, "Invalid URL"); }
    const t0 = Date.now();
    const { res, finalUrl } = await fetchUpstream(parsed.href, request, { Range: "bytes=0-0" });
    try { if (res.body) res.body.cancel(); } catch (_) {}
    const xfo = res.headers.get("x-frame-options") || "";
    const csp = res.headers.get("content-security-policy") || "";
    return json({
      ok: res.status < 400, status: res.status,
      contentType: res.headers.get("content-type") || "",
      frameBlockedUpstream: !!xfo || /frame-ancestors/i.test(csp),
      strippedByProxy: true,
      finalUrl: finalUrl.href, ms: Date.now() - t0
    });
  }

  async function handle(request) {
    const u = new URL(request.url);
    const base = (cfg.publicBase || u.origin).replace(/\/+$/, "");
    if (request.method === "OPTIONS") return respond(null, 204);
    if (request.method !== "GET" && request.method !== "HEAD") return text("Method not allowed", 405);
    try {
      if (u.pathname === "/health") {
        return json({
          status: "ok", version: PROXY_VERSION,
          features: { htmlRewrite: true, hlsRewrite: true, range: true },
          allowedDomains: Array.from(allowed),
          timestamp: new Date().toISOString()
        });
      }
      if (u.pathname === "/proxy" || u.pathname === "/probe") {
        const target = u.searchParams.get("url");
        if (!target) return text("Missing ?url parameter", 400);
        return u.pathname === "/probe" ? await handleProbe(request, target)
                                       : await handleProxy(request, base, target);
      }
      if (u.pathname === "/") return text("CGO CCTV Proxy v" + PROXY_VERSION + " — gunakan /proxy?url=, /probe?url=, /health", 200);
      return text("Not found", 404);
    } catch (e) {
      if (e instanceof HttpError) return text(e.message, e.status);
      return text("Proxy error: " + (e && e.message), 502);
    }
  }

  return { handle, allowedDomains: () => Array.from(allowed) };
}
/* ===== CORE:END ===== */

/* ===== Adapter Node.js ===== */
if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  const http = require("http");
  const { Readable } = require("stream");
  const PORT = process.env.PORT || 3001;
  const handler = createHandler({
    extraDomains: process.env.EXTRA_ALLOWED_DOMAINS,
    publicBase: process.env.PUBLIC_BASE_URL
  });

  const server = http.createServer(async (req, res) => {
    try {
      const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() ||
        (req.socket.encrypted ? "https" : "http");
      const host = req.headers["x-forwarded-host"] || req.headers.host || ("localhost:" + PORT);
      const hdrs = {};
      if (req.headers.accept) hdrs.accept = req.headers.accept;
      if (req.headers.range) hdrs.range = req.headers.range;
      const request = new Request(proto + "://" + host + req.url, {
        method: req.method === "HEAD" ? "GET" : req.method, headers: hdrs
      });
      const response = await handler.handle(request);
      const outHeaders = {};
      response.headers.forEach((v, k) => { outHeaders[k] = v; });
      res.writeHead(response.status, outHeaders);
      if (req.method === "HEAD" || !response.body) return res.end();
      const stream = Readable.fromWeb(response.body);
      req.on("close", () => stream.destroy());
      stream.on("error", () => res.destroy());
      stream.pipe(res);
    } catch (e) {
      console.error("[Proxy]", e && e.message);
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal proxy error");
    }
  });

  server.listen(PORT, () => {
    console.log("CGO CCTV Proxy v" + PROXY_VERSION + " running on http://localhost:" + PORT);
    console.log("Whitelist domains:", handler.allowedDomains().join(", "));
  });
}

if (typeof module !== "undefined") module.exports = { createHandler, PROXY_VERSION, ALLOWED_DOMAINS };
