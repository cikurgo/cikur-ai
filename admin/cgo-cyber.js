/**
 * CGO-CYBER PROXY v2.1 — Cloudflare Worker
 * Robust CORS proxy + WAF bypass for Cyber Lab Gold Master
 *
 * v2.1 UPGRADES:
 *  - [FIX] Hash anchor (#hash) tidak lagi di-rewrite ke proxy
 *  - [FIX] Parsing srcset dengan regex aman (support data URI ber-koma)
 *  - [FIX] Deteksi XML/RSS/Atom untuk HTMLRewriter
 *  - [WAF] Chrome Client Hints + Sec-Fetch-* lengkap
 *  - [WAF] Origin hanya dikirim untuk POST/PUT/PATCH/DELETE
 *  - [WAF] Accept-Encoding pass-through (CF handles gzip/br)
 *  - [NEW] WebSocket Proxy (WebSocketPair)
 *  - [NEW] Base64 URL: ?b64=...
 *  - [NEW] Custom headers: ?referer=, ?ua=, ?origin=
 *
 * Deploy: wrangler deploy  →  https://cgo-cyber.cikurgo.workers.dev
 * Usage:  ?url=https://api.github.com/users/torvalds
 *         ?b64=aHR0cHM6Ly9hcGkuZ2l0aHViLmNvbQ==
 *         /https://api.github.com/users/torvalds
 *         ?url=...&timeout=20000&format=json&ua=Chrome
 */

export default {
  async fetch(request, env, ctx) {
    const CORS_HEADERS = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Expose-Headers": "*, X-Proxy-Final-Url, X-Proxy-Status, X-Proxy-Redirects",
      "Access-Control-Max-Age": "86400",
    };

    // ----- PREFLIGHT -----
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const reqUrl = new URL(request.url);
    const wantJson =
      reqUrl.searchParams.get("format") === "json" ||
      (request.headers.get("accept") || "").toLowerCase().includes("application/json");

    // =========================================================
    // ----- RESOLVE TARGET URL -----
    // Priority: ?url=  →  ?b64=  →  path-style
    // =========================================================
    let targetUrl = reqUrl.searchParams.get("url");

    // (1) Base64 URL support: ?b64=...
    if (!targetUrl) {
      const b64 = reqUrl.searchParams.get("b64");
      if (b64) {
        try {
          const normalized = b64.replace(/-/g, "+").replace(/_/g, "/");
          const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
          const binary = atob(padded);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          targetUrl = new TextDecoder().decode(bytes);
        } catch {
          return errorResponse("Parameter ?b64= bukan Base64 yang valid", 400, "", wantJson, CORS_HEADERS);
        }
      }
    }

    // (2) Path-style: /https://...  atau  /https%3A%2F%2F...
    // NOTE: reqUrl.pathname TIDAK di-decode oleh URL API.
    //       Untuk form encoded, decode SATU kali saja. Tidak ada double decode.
    if (!targetUrl) {
      const path = reqUrl.pathname || "";
      if (/^\/https?:\/\//i.test(path)) {
        // Form mentah — tidak perlu decode
        targetUrl = path.slice(1) + (reqUrl.search || "");
      } else if (/^\/https?[%:](?:%2[fF]|\/)/i.test(path)) {
        // Form encoded — decode SEKALI (bukan double decode)
        try {
          const decoded = decodeURIComponent(path.slice(1));
          if (/^https?:\/\//i.test(decoded)) {
            targetUrl = decoded + (reqUrl.search || "");
          }
        } catch {
          targetUrl = null;
        }
      }
    }

    // ----- HELP PAGE -----
    if (!targetUrl) {
      return new Response(HELP_HTML, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8", ...CORS_HEADERS },
      });
    }

    if (targetUrl.length > 8192) {
      return errorResponse("URL terlalu panjang", 414, targetUrl, wantJson, CORS_HEADERS);
    }

    // =========================================================
    // ----- VALIDATE URL (NO double-decode) -----
    // =========================================================
    targetUrl = String(targetUrl).trim();
    let targetUrlObj;
    try {
      targetUrlObj = new URL(targetUrl);
    } catch {
      return errorResponse("URL tidak valid", 400, targetUrl, wantJson, CORS_HEADERS);
    }

    // Detect WebSocket upgrade request
    const isWsRequest = (request.headers.get("Upgrade") || "").toLowerCase() === "websocket";

    // Allowed protocols (ws/wss only for WebSocket upgrades)
    const validProtocols = isWsRequest
      ? ["http:", "https:", "ws:", "wss:"]
      : ["http:", "https:"];
    if (!validProtocols.includes(targetUrlObj.protocol)) {
      return errorResponse(
        isWsRequest
          ? "Protokol tidak diizinkan (http/https/ws/wss)"
          : "Hanya protokol http/https yang diizinkan",
        400, targetUrl, wantJson, CORS_HEADERS
      );
    }

    // SSRF check
    if (isPrivateHost(targetUrlObj.hostname)) {
      return errorResponse("Target host diblokir (private/internal address)", 403, targetUrl, wantJson, CORS_HEADERS);
    }

    const proxyBase = reqUrl.origin;

    // =========================================================
    // ----- TIMEOUT (clamp 3000–30000 ms) -----
    // =========================================================
    let timeoutMs = 15000;
    const tParam = reqUrl.searchParams.get("timeout");
    if (tParam) {
      const n = parseInt(tParam, 10);
      if (!Number.isNaN(n)) timeoutMs = Math.min(30000, Math.max(3000, n));
    }

    // =========================================================
    // ----- CUSTOM HEADER OVERRIDES -----
    // =========================================================
    const refererOverride = reqUrl.searchParams.get("referer");
    const uaOverride = reqUrl.searchParams.get("ua");
    const originOverride = reqUrl.searchParams.get("origin");

    // =========================================================
    // ----- WEBSOCKET PROXY -----
    // =========================================================
    if (isWsRequest) {
      return handleWebSocket(request, targetUrl, targetUrlObj, CORS_HEADERS);
    }

    // =========================================================
    // ----- NORMAL HTTP PATH -----
    // =========================================================
    const httpTargetUrl = targetUrl; // already http(s) at this point
    const targetOrigin = targetUrlObj.origin;

    try {
      // ----- UPSTREAM REQUEST HEADERS -----
      const upstreamHeaders = new Headers();
      // NOTE: accept-encoding TIDAK di-strip — biarkan Cloudflare urus kompresi.
      const STRIP_REQ = new Set([
        "host", "origin", "referer", "cookie",
        "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
        "te", "trailer", "transfer-encoding", "upgrade", "content-length",
      ]);

      for (const [k, v] of request.headers) {
        const lk = k.toLowerCase();
        if (!STRIP_REQ.has(lk) && !lk.startsWith("cf-") && !lk.startsWith("x-forwarded-")) {
          upstreamHeaders.set(k, v);
        }
      }

      const methodUpper = request.method.toUpperCase();

      // --- User-Agent (Chrome spoof, override via ?ua=) ---
      upstreamHeaders.set(
        "User-Agent",
        uaOverride ||
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
      );

      // --- Accept-Language ---
      upstreamHeaders.set("Accept-Language", "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7");

      if (!upstreamHeaders.has("Accept")) upstreamHeaders.set("Accept", "*/*");

      // --- Referer (override via ?referer=) ---
      upstreamHeaders.set("Referer", refererOverride || (targetOrigin + "/"));

      // --- Origin: HANYA untuk method non-GET/HEAD (override via ?origin=) ---
      if (originOverride) {
        upstreamHeaders.set("Origin", originOverride);
      } else if (["POST", "PUT", "PATCH", "DELETE"].includes(methodUpper)) {
        upstreamHeaders.set("Origin", targetOrigin);
      } else {
        // GET/HEAD → jangan set Origin (mengikuti request asli)
        upstreamHeaders.delete("Origin");
      }

      // --- Chrome Client Hints (WAF bypass) ---
      upstreamHeaders.set(
        "Sec-CH-UA",
        '"Chromium";v="123", "Not:A-Brand";v="8", "Google Chrome";v="123"'
      );
      upstreamHeaders.set("Sec-CH-UA-Mobile", "?0");
      upstreamHeaders.set("Sec-CH-UA-Platform", '"Windows"');

      // --- Sec-Fetch-* (Chrome navigation/cors realism) ---
      const acceptLower = (request.headers.get("accept") || "").toLowerCase();
      const isApiLike =
        acceptLower.includes("application/json") ||
        acceptLower.includes("text/event-stream");
      if (isApiLike) {
        upstreamHeaders.set("Sec-Fetch-Dest", "empty");
        upstreamHeaders.set("Sec-Fetch-Mode", "cors");
      } else {
        upstreamHeaders.set("Sec-Fetch-Dest", "document");
        upstreamHeaders.set("Sec-Fetch-Mode", "navigate");
        upstreamHeaders.set("Sec-Fetch-User", "?1");
      }
      upstreamHeaders.set("Sec-Fetch-Site", "cross-site");

      // ----- BUFFER BODY (retry-safe for redirects) -----
      let bodyData = null;
      if (!["GET", "HEAD"].includes(methodUpper) && request.body) {
        bodyData = await request.arrayBuffer();
      }

      // ----- ABORT CONTROLLER -----
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        if (request.signal) {
          request.signal.addEventListener("abort", () => controller.abort(), { once: true });
        }
      } catch (_) {}

      const init = {
        method: request.method,
        headers: upstreamHeaders,
        redirect: "manual",
        signal: controller.signal,
        body: bodyData,
      };

      const { response, finalUrl, redirectCount } = await fetchWithRedirects(httpTargetUrl, init);
      clearTimeout(timeoutId);

      // ----- RESPONSE HEADERS -----
      const newHeaders = new Headers();
      const STRIP_RES = new Set([
        "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
        "te", "trailer", "transfer-encoding", "upgrade",
        "content-security-policy", "content-security-policy-report-only",
        "x-frame-options", "frame-options",
        "strict-transport-security", "cross-origin-opener-policy",
        "cross-origin-embedder-policy", "cross-origin-resource-policy",
        "permissions-policy", "report-to", "nel",
        "content-length",
        "content-encoding", // CF sudah decompress di edge
      ]);

      for (const [k, v] of response.headers) {
        if (!STRIP_RES.has(k.toLowerCase())) newHeaders.set(k, v);
      }
      for (const [k, v] of Object.entries(CORS_HEADERS)) newHeaders.set(k, v);

      // Diagnostic headers
      newHeaders.set("X-Proxy-Final-Url", finalUrl);
      newHeaders.set("X-Proxy-Status", String(response.status));
      newHeaders.set("X-Proxy-Redirects", String(redirectCount));

      // ----- SET-COOKIE SANITIZE -----
      let cookies = [];
      if (typeof response.headers.getSetCookie === "function") {
        cookies = response.headers.getSetCookie();
      }
      if (cookies.length) {
        newHeaders.delete("set-cookie");
        for (const c of cookies) {
          const cleaned = c
            .replace(/;\s*domain=[^;]*/gi, "")
            .replace(/;\s*secure/gi, "")
            .replace(/;\s*samesite=[^;]*/gi, "");
          newHeaders.append("set-cookie", cleaned);
        }
      }

      // ----- CONTENT-TYPE DETECTION (HTML + XML/RSS/ATOM) -----
      const contentType = (newHeaders.get("content-type") || "").toLowerCase();
      const isHTML =
        contentType.includes("text/html") ||
        contentType.includes("application/xhtml") ||
        contentType.includes("text/xml") ||
        contentType.includes("application/xml") ||
        contentType.includes("application/rss+xml") ||
        contentType.includes("application/atom+xml");
      const isHead = request.method === "HEAD";

      // =========================================================
      // ----- HTML / XML REWRITER -----
      // =========================================================
      if (isHTML && !isHead) {
        newHeaders.delete("content-encoding");
        const escapeAttr = (s) =>
          String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

        // Rewrite URL → proxy (kecuali #hash, data:, blob:, javascript:, mailto:, tel:)
        const rewriteToProxy = (raw) => {
          if (!raw) return raw;
          const trimmed = String(raw).trim();
          if (
            !trimmed ||
            trimmed.startsWith("#") ||
            trimmed.startsWith("data:") ||
            trimmed.startsWith("blob:") ||
            trimmed.startsWith("javascript:") ||
            trimmed.startsWith("mailto:") ||
            trimmed.startsWith("tel:")
          ) {
            return raw;
          }
          try {
            const abs = new URL(trimmed, finalUrl);
            if (abs.origin === targetOrigin || abs.origin === new URL(finalUrl).origin) {
              return `${proxyBase}/?url=${encodeURIComponent(abs.href)}`;
            }
            return abs.href;
          } catch {
            return raw;
          }
        };

        // Safe srcset parser (handles data URI dengan koma)
        const rewriteSrcset = (srcset) => {
          if (!srcset) return srcset;
          const results = [];
          // Greedy `data:` alternation, lazy `\S+?` untuk URL biasa.
          // `(?:\s+[\d.]+[wx])?` menangkap descriptor (100w / 2x / dst).
          const re = /(data:[^\s]+|\S+?)(\s+[\d.]+[wx])?(?:\s*,\s*|$)/g;
          let m;
          while ((m = re.exec(srcset)) !== null) {
            if (m[0] === "") {
              re.lastIndex++;
              continue;
            }
            let url = m[1];
            const desc = m[2] || "";
            // Strip trailing commas dari URL (data URI case)
            while (url.endsWith(",")) url = url.slice(0, -1);
            if (!url) continue;
            results.push(rewriteToProxy(url) + desc);
          }
          return results.length ? results.join(", ") : srcset;
        };

        const rewriter = new HTMLRewriter()
          .on("head", {
            element(el) {
              el.prepend(`<base href="${escapeAttr(new URL(finalUrl).origin)}/">`, { html: true });
            },
          })
          .on("meta[http-equiv]", {
            element(el) {
              const v = (el.getAttribute("http-equiv") || "").toLowerCase();
              if (v === "content-security-policy" || v === "refresh") el.remove();
            },
          })
          .on("a[href], link[href], area[href]", {
            element(el) {
              const href = el.getAttribute("href");
              if (href) el.setAttribute("href", rewriteToProxy(href));
            },
          })
          .on("img[src], script[src], iframe[src], source[src], video[src], audio[src], embed[src]", {
            element(el) {
              const src = el.getAttribute("src");
              if (src) el.setAttribute("src", rewriteToProxy(src));
            },
          })
          .on("form[action]", {
            element(el) {
              const action = el.getAttribute("action");
              if (action) el.setAttribute("action", rewriteToProxy(action));
            },
          })
          .on("img[srcset], source[srcset]", {
            element(el) {
              const srcset = el.getAttribute("srcset");
              if (srcset) el.setAttribute("srcset", rewriteSrcset(srcset));
            },
          });

        return rewriter.transform(
          new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders,
          })
        );
      }

      // ----- NON-HTML (stream pass-through) -----
      return new Response(isHead ? null : response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    } catch (error) {
      let msg = error?.message || String(error);
      let status = 502;
      if (error?.name === "AbortError") {
        msg = `Request Timeout (${Math.round(timeoutMs / 1000)} detik).`;
        status = 504;
      }
      return errorResponse(msg, status, targetUrl, wantJson, CORS_HEADERS);
    }
  },
};

// =============================================================
// ===== WEBSOCKET PROXY (Cloudflare WebSocketPair) =====
// =============================================================
function handleWebSocket(request, targetUrl, targetUrlObj, CORS_HEADERS) {
  try {
    const wsPair = new WebSocketPair();
    const [client, server] = Object.values(wsPair);
    server.accept();

    // Convert ws:// → http://, wss:// → https:// untuk Cloudflare fetch
    let fetchUrl = targetUrl;
    const proto = targetUrlObj.protocol;
    if (proto === "ws:") fetchUrl = "http://" + targetUrl.slice(3);
    else if (proto === "wss:") fetchUrl = "https://" + targetUrl.slice(4);
    const fetchOrigin = new URL(fetchUrl).origin;

    // Build upstream headers — preserve WS handshake headers
    const upstreamHeaders = new Headers();
    for (const [k, v] of request.headers) {
      const lk = k.toLowerCase();
      if (
        lk === "host" ||
        lk === "origin" ||
        lk === "cookie" ||
        lk.startsWith("cf-") ||
        lk.startsWith("x-forwarded-")
      ) {
        continue;
      }
      upstreamHeaders.set(k, v);
    }
    // Origin disetel ke origin target (banyak WS server mewajibkan ini)
    upstreamHeaders.set("Origin", fetchOrigin);
    // Realism hint
    upstreamHeaders.set("Sec-Fetch-Dest", "websocket");
    upstreamHeaders.set("Sec-Fetch-Mode", "websocket");
    upstreamHeaders.set("Sec-Fetch-Site", "cross-site");

    fetch(fetchUrl, {
      method: "GET",
      headers: upstreamHeaders,
    })
      .then((upstreamResponse) => {
        const upstreamWs = upstreamResponse.webSocket;
        if (!upstreamWs) {
          try { server.close(1011, "Upstream bukan WebSocket"); } catch (_) {}
          return;
        }
        upstreamWs.accept();

        // Client → Upstream
        server.addEventListener("message", (e) => {
          try { upstreamWs.send(e.data); } catch (_) {}
        });
        // Upstream → Client
        upstreamWs.addEventListener("message", (e) => {
          try { server.send(e.data); } catch (_) {}
        });
        // Close propagation
        server.addEventListener("close", (e) => {
          try { upstreamWs.close(e.code, e.reason); } catch (_) {}
        });
        upstreamWs.addEventListener("close", (e) => {
          try { server.close(e.code, e.reason); } catch (_) {}
        });
        // Error propagation
        server.addEventListener("error", () => {
          try { upstreamWs.close(1011, "client error"); } catch (_) {}
        });
        upstreamWs.addEventListener("error", () => {
          try { server.close(1011, "upstream error"); } catch (_) {}
        });
      })
      .catch(() => {
        try { server.close(1011, "upstream fetch failed"); } catch (_) {}
      });

    return new Response(null, { status: 101, webSocket: client });
  } catch (err) {
    return new Response(
      "WebSocket init failed: " + (err?.message || String(err)),
      { status: 500, headers: CORS_HEADERS }
    );
  }
}

// =============================================================
// ===== FETCH + MANUAL REDIRECT + SSRF ON EACH HOP =====
// =============================================================
async function fetchWithRedirects(url, init, maxRedirects = 5) {
  let currentUrl = url;
  let currentMethod = init.method;
  let currentBody = init.body;
  let currentHeaders = new Headers(init.headers);
  let redirectCount = 0;

  for (let i = 0; i <= maxRedirects; i++) {
    const u = new URL(currentUrl);
    if (!["http:", "https:"].includes(u.protocol)) {
      throw new Error("Redirect ke protokol tidak diizinkan");
    }
    if (isPrivateHost(u.hostname)) {
      throw new Error("Redirect ke host privat diblokir");
    }

    const res = await fetch(currentUrl, {
      method: currentMethod,
      headers: currentHeaders,
      body: currentBody,
      redirect: "manual",
      signal: init.signal,
    });

    if (res.status >= 300 && res.status < 400 && res.headers.has("location")) {
      const loc = res.headers.get("location");
      currentUrl = new URL(loc, currentUrl).toString();
      redirectCount++;

      // 303 → GET; 301/302 + POST → GET; 307/308 → keep method
      if (
        res.status === 303 ||
        ((res.status === 301 || res.status === 302) &&
          String(currentMethod).toUpperCase() === "POST")
      ) {
        currentMethod = "GET";
        currentBody = null;
        currentHeaders.delete("content-type");
        currentHeaders.delete("content-length");
      }

      try {
        await res.body?.cancel();
      } catch (_) {}
      continue;
    }

    return { response: res, finalUrl: currentUrl, redirectCount };
  }
  throw new Error("Terlalu banyak redirect (>5)");
}

// =============================================================
// ===== SSRF PROTECTION =====
// =============================================================
function isPrivateHost(hostname) {
  const h = (hostname || "").toLowerCase();
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "metadata" || h === "metadata.google.internal") return true;

  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    if ([a, b, c, d].some((n) => n > 255)) return true;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
  }

  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    const inner = h.slice(1, end === -1 ? h.length : end);
    if (inner === "::1" || inner === "::" || inner === "0:0:0:0:0:0:0:1") return true;
    if (/^f[cd]/i.test(inner)) return true;
    if (/^fe[89ab]/i.test(inner)) return true;
    if (/^::ffff:/i.test(inner)) return isPrivateHost(inner.replace(/^::ffff:/i, ""));
  }

  // bare IPv6 without brackets
  if (h.includes(":") && !h.includes(".")) {
    if (h === "::1" || h === "::") return true;
    if (/^f[cd]/i.test(h) || /^fe[89ab]/i.test(h)) return true;
  }

  return false;
}

// =============================================================
// ===== ERROR RESPONSE (HTML or JSON) =====
// =============================================================
function errorResponse(msg, status, targetUrl = "", wantJson = false, cors = {}) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    ...(cors || {}),
  };

  if (wantJson) {
    headers["Content-Type"] = "application/json; charset=utf-8";
    return new Response(
      JSON.stringify({
        ok: false,
        error: true,
        status,
        message: String(msg),
        target: targetUrl || null,
      }),
      { status, headers }
    );
  }

  const safe = (s) =>
    String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

  headers["Content-Type"] = "text/html; charset=utf-8";
  return new Response(
    `<!DOCTYPE html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Proxy Error ${status}</title></head>
<body style="background:#05080f;color:#ff3366;font-family:monospace;padding:20px;line-height:1.5;">
<h2>❌ PROXY ERROR (${status})</h2>
${targetUrl ? `<p><b>Target:</b> ${safe(targetUrl)}</p>` : ""}
<p><b>Pesan:</b> ${safe(msg)}</p>
<p style="color:#64748b;"><i>Pastikan URL valid, target publik, dan tidak memblokir Cloudflare.</i></p>
</body></html>`,
    { status, headers }
  );
}

// =============================================================
// ===== HELP PAGE =====
// =============================================================
const HELP_HTML = `<!DOCTYPE html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CGO-CYBER PROXY v2.1</title></head>
<body style="background:#05080f;color:#00ff9c;font-family:monospace;padding:20px;line-height:1.6;max-width:760px;">
<h2>🛡️ CGO-CYBER PROXY v2.1 AKTIF</h2>
<p>Proxy CORS + SSRF-safe + WAF-bypass untuk <b>Cyber Lab Gold Master</b>.</p>
<hr style="border-color:#1e293b;">
<p><b>Format query:</b></p>
<pre style="background:#0a1220;padding:12px;border-radius:8px;overflow:auto;">?url=https://api.github.com/users/torvalds
?url=https://httpbin.org/post&amp;timeout=20000
?url=https://example.com&amp;format=json
?b64=aHR0cHM6Ly9hcGkuZ2l0aHViLmNvbQ==</pre>
<p><b>Format path:</b></p>
<pre style="background:#0a1220;padding:12px;border-radius:8px;overflow:auto;">/https://api.github.com/users/torvalds</pre>
<p><b>Custom headers (WAF tuning):</b></p>
<pre style="background:#0a1220;padding:12px;border-radius:8px;overflow:auto;">?url=...&amp;ua=Mozilla%2F5.0+%28iPhone%29
?url=...&amp;referer=https%3A%2F%2Fgoogle.com%2F
?url=...&amp;origin=https%3A%2F%2Ftrusted-site.com</pre>
<p><b>WebSocket:</b> kirim header <code>Upgrade: websocket</code> ke URL proxy dengan <code>?url=wss://target/ws</code>.</p>
<p><b>Contoh hidup:</b>
  <a href="?url=https://api.github.com" style="color:#22d3ee;">?url=https://api.github.com</a>
</p>
<hr style="border-color:#1e293b;">
<p style="color:#64748b;font-size:12px;">
  SSRF Protected · CORS Enabled · HTML Rewritten · Redirect-Aware · Method+Body Pass-through<br>
  Chrome Hints · Sec-Fetch-* · WebSocket · Base64 URL · XML/RSS Support<br>
  Headers: X-Proxy-Final-Url · X-Proxy-Status · X-Proxy-Redirects
</p>
</body></html>`;
