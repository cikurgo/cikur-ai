/**
 * CGO-CYBER PROXY v2.2.1 — Cloudflare Worker
 * Cyber Lab Gold Master v3.4 companion
 * Zero functional regression from v2.2.0
 *
 * v2.2.0 upgrades:
 *  - CORS: reflect Origin + Access-Control-Allow-Credentials: true (no *)
 *  - Cookie sanitize: strip Domain, Secure, SameSite, Partitioned
 *  - CSS url() rewrite in <style> and style=""
 *  - HLS: rewrite #EXT-X-MAP and #EXT-X-KEY URI= for AES-128 playback
 *  - XML/RSS: skip CDATA and <enclosure> when rewriting URLs
 *  - Zero regression: SSRF, redirects, method+body, WS, b64, path-style
 */

export default {
  async fetch(request, env, ctx) {
    const reqOrigin = request.headers.get("Origin") || "";
    const CORS_HEADERS = buildCorsHeaders(reqOrigin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const reqUrl = new URL(request.url);
    const wantJson =
      reqUrl.searchParams.get("format") === "json" ||
      (request.headers.get("accept") || "").toLowerCase().includes("application/json");

    let targetUrl = reqUrl.searchParams.get("url");

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

    if (!targetUrl) {
      const path = reqUrl.pathname || "";
      if (/^\/https?:\/\//i.test(path)) {
        targetUrl = path.slice(1);
      } else if (/^\/https?[%:](?:%2[fF]|\/)/i.test(path)) {
        try {
          const decoded = decodeURIComponent(path.slice(1));
          if (/^https?:\/\//i.test(decoded)) targetUrl = decoded;
        } catch {
          targetUrl = null;
        }
      }
    }

    if (!targetUrl) {
      return new Response(HELP_HTML, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8", ...CORS_HEADERS },
      });
    }

    if (targetUrl.length > 8192) {
      return errorResponse("URL terlalu panjang", 414, targetUrl, wantJson, CORS_HEADERS);
    }

    targetUrl = String(targetUrl).trim();
    let targetUrlObj;
    try {
      targetUrlObj = new URL(targetUrl);
    } catch {
      return errorResponse("URL tidak valid", 400, targetUrl, wantJson, CORS_HEADERS);
    }

    const upgradeHdr = (request.headers.get("Upgrade") || "").toLowerCase();
    const isWsRequest = upgradeHdr === "websocket";

    const validProtocols = isWsRequest
      ? ["http:", "https:", "ws:", "wss:"]
      : ["http:", "https:"];
    if (!validProtocols.includes(targetUrlObj.protocol)) {
      return errorResponse(
        isWsRequest
          ? "Protokol tidak diizinkan (http/https/ws/wss)"
          : "Hanya protokol http/https yang diizinkan",
        400,
        targetUrl,
        wantJson,
        CORS_HEADERS
      );
    }

    if (isPrivateHost(targetUrlObj.hostname)) {
      return errorResponse(
        "Target host diblokir (private/internal address)",
        403,
        targetUrl,
        wantJson,
        CORS_HEADERS
      );
    }

    const proxyBase = reqUrl.origin;

    let timeoutMs = 15000;
    const tParam = reqUrl.searchParams.get("timeout");
    if (tParam) {
      const n = parseInt(tParam, 10);
      if (!Number.isNaN(n)) timeoutMs = Math.min(30000, Math.max(3000, n));
    }

    const refererOverride = reqUrl.searchParams.get("referer");
    const uaOverride = reqUrl.searchParams.get("ua");
    const originOverride = reqUrl.searchParams.get("origin");

    if (isWsRequest) {
      return handleWebSocket(request, targetUrl, targetUrlObj, CORS_HEADERS);
    }

    const targetOrigin = targetUrlObj.origin;

    try {
      const upstreamHeaders = new Headers();
      const STRIP_REQ = new Set([
        "host",
        "origin",
        "referer",
        "cookie",
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "content-length",
      ]);

      for (const [k, v] of request.headers) {
        const lk = k.toLowerCase();
        if (!STRIP_REQ.has(lk) && !lk.startsWith("cf-") && !lk.startsWith("x-forwarded-")) {
          upstreamHeaders.set(k, v);
        }
      }

      // Forward Cookie if client sent via custom header X-Proxy-Cookie
      const proxyCookie = request.headers.get("X-Proxy-Cookie");
      if (proxyCookie) upstreamHeaders.set("Cookie", proxyCookie);

      const methodUpper = request.method.toUpperCase();

      upstreamHeaders.set(
        "User-Agent",
        uaOverride ||
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
      );
      upstreamHeaders.set("Accept-Language", "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7");
      if (!upstreamHeaders.has("Accept")) upstreamHeaders.set("Accept", "*/*");
      upstreamHeaders.set("Referer", refererOverride || targetOrigin + "/");

      if (originOverride) {
        upstreamHeaders.set("Origin", originOverride);
      } else if (["POST", "PUT", "PATCH", "DELETE"].includes(methodUpper)) {
        upstreamHeaders.set("Origin", targetOrigin);
      } else {
        upstreamHeaders.delete("Origin");
      }

      upstreamHeaders.set(
        "Sec-CH-UA",
        '"Chromium";v="123", "Not:A-Brand";v="8", "Google Chrome";v="123"'
      );
      upstreamHeaders.set("Sec-CH-UA-Mobile", "?0");
      upstreamHeaders.set("Sec-CH-UA-Platform", '"Windows"');

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

      let bodyData = null;
      if (!["GET", "HEAD"].includes(methodUpper) && request.body) {
        bodyData = await request.arrayBuffer();
      }

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

      const { response, finalUrl, redirectCount } = await fetchWithRedirects(targetUrl, init);
      clearTimeout(timeoutId);

      const newHeaders = new Headers();
      const STRIP_RES = new Set([
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "content-security-policy",
        "content-security-policy-report-only",
        "x-frame-options",
        "frame-options",
        "strict-transport-security",
        "cross-origin-opener-policy",
        "cross-origin-embedder-policy",
        "cross-origin-resource-policy",
        "permissions-policy",
        "report-to",
        "nel",
        "content-length",
      ]);

      for (const [k, v] of response.headers) {
        if (!STRIP_RES.has(k.toLowerCase())) newHeaders.set(k, v);
      }
      for (const [k, v] of Object.entries(CORS_HEADERS)) newHeaders.set(k, v);

      newHeaders.set("X-Proxy-Final-Url", finalUrl);
      newHeaders.set("X-Proxy-Status", String(response.status));
      newHeaders.set("X-Proxy-Redirects", String(redirectCount));

      // ----- COOKIE SANITIZE (Domain, Secure, SameSite, Partitioned) -----
      let cookies = [];
      try {
        if (typeof response.headers.getSetCookie === "function") {
          cookies = response.headers.getSetCookie();
        }
      } catch (_) {}
      if (cookies.length) {
        newHeaders.delete("set-cookie");
        for (const c of cookies) {
          const cleaned = String(c)
            .replace(/;\s*domain=[^;]*/gi, "")
            .replace(/;\s*secure/gi, "")
            .replace(/;\s*samesite=[^;]*/gi, "")
            .replace(/;\s*partitioned/gi, "");
          newHeaders.append("set-cookie", cleaned);
        }
      }

      const contentType = (newHeaders.get("content-type") || "").toLowerCase();
      const isHTML =
        contentType.includes("text/html") || contentType.includes("application/xhtml");
      const isXML =
        contentType.includes("text/xml") ||
        contentType.includes("application/xml") ||
        contentType.includes("application/rss+xml") ||
        contentType.includes("application/atom+xml") ||
        contentType.includes("+xml");
      const isHLS =
        contentType.includes("application/vnd.apple.mpegurl") ||
        contentType.includes("application/x-mpegurl") ||
        contentType.includes("audio/mpegurl") ||
        /\.m3u8(\?|$)/i.test(finalUrl);
      const isHead = request.method === "HEAD";

      const rewriteAbsToProxy = (raw, base) => {
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
          const abs = new URL(trimmed, base || finalUrl);
          const finalOrigin = new URL(finalUrl).origin;
          if (abs.origin === targetOrigin || abs.origin === finalOrigin) {
            return proxyBase + "/?url=" + encodeURIComponent(abs.href);
          }
          return abs.href;
        } catch {
          return raw;
        }
      };

      // ----- HLS playlist rewrite (MAP + KEY + URI) -----
      if (isHLS && !isHead && response.body) {
        newHeaders.delete("content-encoding");
        newHeaders.delete("content-length");
        let text = await response.text();
        text = rewriteHlsPlaylist(text, finalUrl, proxyBase, targetOrigin);
        if (!newHeaders.has("content-type")) {
          newHeaders.set("content-type", "application/vnd.apple.mpegurl");
        }
        return new Response(text, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders,
        });
      }

      // ----- XML / RSS / ATOM (skip CDATA + enclosure) -----
      if (isXML && !isHead && response.body) {
        newHeaders.delete("content-encoding");
        newHeaders.delete("content-length");
        let xmlText = await response.text();
        xmlText = rewriteXmlSafe(xmlText, finalUrl, proxyBase, targetOrigin);
        return new Response(xmlText, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders,
        });
      }

      // ----- HTML + CSS url() -----
      if (isHTML && !isHead && response.body) {
        newHeaders.delete("content-encoding");
        newHeaders.delete("content-length");

        const escapeAttr = (s) =>
          String(s)
            .replace(/&/g, "&amp;")
            .replace(/"/g, "&quot;")
            .replace(/</g, "&lt;");

        const rewriteCssUrls = (css) => {
          if (!css) return css;
          return String(css).replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, (full, q, u) => {
            const rewritten = rewriteAbsToProxy(u.trim(), finalUrl);
            const quote = q || "";
            return "url(" + quote + rewritten + quote + ")";
          });
        };

        const rewriter = new HTMLRewriter()
          .on("head", {
            element(el) {
              try {
                el.prepend(
                  '<base href="' + escapeAttr(new URL(finalUrl).origin) + '/">',
                  { html: true }
                );
              } catch (_) {}
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
              if (href) el.setAttribute("href", rewriteAbsToProxy(href, finalUrl));
            },
          })
          .on(
            "img[src], script[src], iframe[src], source[src], video[src], audio[src], embed[src]",
            {
              element(el) {
                const src = el.getAttribute("src");
                if (src) el.setAttribute("src", rewriteAbsToProxy(src, finalUrl));
              },
            }
          )
          .on("form[action]", {
            element(el) {
              const action = el.getAttribute("action");
              if (action) el.setAttribute("action", rewriteAbsToProxy(action, finalUrl));
            },
          })
          .on("img[srcset], source[srcset]", {
            element(el) {
              const srcset = el.getAttribute("srcset");
              if (!srcset) return;
              const parts = [];
              const re = /(data:[^\s,]+|https?:\/\/\S+?|\/\S+?)(\s+[\d.]+[wx])?(?:\s*,\s*|$)/gi;
              let m;
              while ((m = re.exec(srcset)) !== null) {
                if (!m[0]) {
                  re.lastIndex++;
                  continue;
                }
                let url = m[1];
                const desc = m[2] || "";
                while (url.endsWith(",")) url = url.slice(0, -1);
                if (!url) continue;
                parts.push(rewriteAbsToProxy(url, finalUrl) + desc);
              }
              if (parts.length) el.setAttribute("srcset", parts.join(", "));
            },
          })
          .on("style", {
            text(text) {
              if (text.text) text.replace(rewriteCssUrls(text.text), { html: false });
            },
          })
          .on("*[style]", {
            element(el) {
              const st = el.getAttribute("style");
              if (st) el.setAttribute("style", rewriteCssUrls(st));
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

      return new Response(isHead ? null : response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    } catch (error) {
      let msg = error && error.message ? error.message : String(error);
      let status = 502;
      if (error && error.name === "AbortError") {
        msg = "Request Timeout (" + Math.round(timeoutMs / 1000) + " detik).";
        status = 504;
      }
      return errorResponse(msg, status, targetUrl, wantJson, CORS_HEADERS);
    }
  },
};

function buildCorsHeaders(reqOrigin) {
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers":
      "*, X-Proxy-Final-Url, X-Proxy-Status, X-Proxy-Redirects",
    "Access-Control-Max-Age": "86400",
  };
  if (reqOrigin) {
    headers["Access-Control-Allow-Origin"] = reqOrigin;
    headers["Access-Control-Allow-Credentials"] = "true";
    headers["Vary"] = "Origin";
  } else {
    // No Origin (curl / same-origin / non-browser) — wildcard OK without credentials
    headers["Access-Control-Allow-Origin"] = "*";
  }
  return headers;
}

function rewriteHlsPlaylist(text, finalUrl, proxyBase, targetOrigin) {
  const finalOrigin = new URL(finalUrl).origin;
  const toProxy = (u) => {
    try {
      const abs = new URL(u.trim(), finalUrl);
      if (abs.origin === targetOrigin || abs.origin === finalOrigin) {
        return proxyBase + "/?url=" + encodeURIComponent(abs.href);
      }
      return abs.href;
    } catch {
      return u;
    }
  };

  // #EXT-X-MAP:URI="..."
  text = text.replace(/#EXT-X-MAP:([^\r\n]*)/gi, (line, attrs) => {
    const next = attrs.replace(/URI="([^"]+)"/i, (_, u) => 'URI="' + toProxy(u) + '"');
    return "#EXT-X-MAP:" + next;
  });
  // #EXT-X-KEY:...URI="..."
  text = text.replace(/#EXT-X-KEY:([^\r\n]*)/gi, (line, attrs) => {
    const next = attrs.replace(/URI="([^"]+)"/i, (_, u) => 'URI="' + toProxy(u) + '"');
    return "#EXT-X-KEY:" + next;
  });
  // #EXT-X-MEDIA:...URI="..."
  text = text.replace(/#EXT-X-MEDIA:([^\r\n]*)/gi, (line, attrs) => {
    const next = attrs.replace(/URI="([^"]+)"/i, (_, u) => 'URI="' + toProxy(u) + '"');
    return "#EXT-X-MEDIA:" + next;
  });
  // plain segment / playlist relative lines (non-comment)
  text = text
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (!t || t.startsWith("#")) return line;
      if (/^https?:\/\//i.test(t) || t.startsWith("/") || !t.includes("://")) {
        try {
          return toProxy(t);
        } catch {
          return line;
        }
      }
      return line;
    })
    .join("\n");
  return text;
}

function rewriteXmlSafe(xmlText, finalUrl, proxyBase, targetOrigin) {
  const finalOrigin = new URL(finalUrl).origin;
  // Protect CDATA and <enclosure ...> blocks from URL rewrite
  const holders = [];
  const park = (m) => {
    holders.push(m);
    return "\u0000XMLHOLD" + (holders.length - 1) + "\u0000";
  };
  let text = xmlText
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, park)
    .replace(/<enclosure\b[^>]*>/gi, park);

  text = text.replace(/(https?:\/\/[^\s"'<>]+)/gi, (match) => {
    try {
      const u = new URL(match);
      if (u.origin === targetOrigin || u.origin === finalOrigin) {
        return proxyBase + "/?url=" + encodeURIComponent(u.href);
      }
    } catch (_) {}
    return match;
  });

  text = text.replace(/\u0000XMLHOLD(\d+)\u0000/g, (_, i) => holders[Number(i)] || "");
  return text;
}

async function handleWebSocket(request, targetUrl, targetUrlObj, CORS_HEADERS) {
  try {
    if (typeof WebSocketPair === "undefined") {
      return new Response("WebSocketPair tidak tersedia di runtime ini", {
        status: 501,
        headers: CORS_HEADERS,
      });
    }

    let fetchUrl = targetUrl;
    const proto = targetUrlObj.protocol;
    if (proto === "ws:") fetchUrl = "http://" + targetUrl.slice(5);
    else if (proto === "wss:") fetchUrl = "https://" + targetUrl.slice(6);

    const fetchOrigin = new URL(fetchUrl).origin;
    const upstreamHeaders = new Headers();
    for (const [k, v] of request.headers) {
      const lk = k.toLowerCase();
      if (
        lk === "host" ||
        lk === "cookie" ||
        lk.startsWith("cf-") ||
        lk.startsWith("x-forwarded-")
      ) {
        continue;
      }
      upstreamHeaders.set(k, v);
    }
    upstreamHeaders.set("Origin", fetchOrigin);
    upstreamHeaders.set("Sec-Fetch-Dest", "websocket");
    upstreamHeaders.set("Sec-Fetch-Mode", "websocket");
    upstreamHeaders.set("Sec-Fetch-Site", "cross-site");

    const upstreamResponse = await fetch(fetchUrl, { headers: upstreamHeaders });
    const upstreamWs = upstreamResponse.webSocket;
    if (!upstreamWs || upstreamResponse.status !== 101) {
      const status =
        upstreamResponse.status && upstreamResponse.status !== 200
          ? upstreamResponse.status
          : 502;
      return new Response(
        "Upstream menolak WebSocket (status " + upstreamResponse.status + ")",
        { status: status, headers: CORS_HEADERS }
      );
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    upstreamWs.accept();

    server.addEventListener("message", function (e) {
      try {
        upstreamWs.send(e.data);
      } catch (_) {}
    });
    upstreamWs.addEventListener("message", function (e) {
      try {
        server.send(e.data);
      } catch (_) {}
    });
    server.addEventListener("close", function (e) {
      try {
        upstreamWs.close(e.code, e.reason);
      } catch (_) {}
    });
    upstreamWs.addEventListener("close", function (e) {
      try {
        server.close(e.code, e.reason);
      } catch (_) {}
    });
    server.addEventListener("error", function () {
      try {
        upstreamWs.close(1011, "client error");
      } catch (_) {}
    });
    upstreamWs.addEventListener("error", function () {
      try {
        server.close(1011, "upstream error");
      } catch (_) {}
    });

    return new Response(null, { status: 101, webSocket: client });
  } catch (err) {
    return new Response(
      "WebSocket init failed: " + (err && err.message ? err.message : String(err)),
      { status: 500, headers: CORS_HEADERS }
    );
  }
}

async function fetchWithRedirects(url, init, maxRedirects) {
  if (maxRedirects === undefined) maxRedirects = 5;
  let currentUrl = url;
  let currentMethod = init.method;
  let currentBody = init.body;
  let currentHeaders = new Headers(init.headers);
  let redirectCount = 0;

  for (let i = 0; i <= maxRedirects; i++) {
    const u = new URL(currentUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
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
        if (res.body) await res.body.cancel();
      } catch (_) {}
      continue;
    }

    return { response: res, finalUrl: currentUrl, redirectCount: redirectCount };
  }
  throw new Error("Terlalu banyak redirect (>5)");
}

function isPrivateHost(hostname) {
  const h = (hostname || "").toLowerCase();
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "metadata" || h === "metadata.google.internal") return true;

  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    const c = Number(v4[3]);
    const d = Number(v4[4]);
    if ([a, b, c, d].some(function (n) {
      return n > 255;
    }))
      return true;
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

  if (h.indexOf(":") !== -1 && h.indexOf(".") === -1) {
    if (h === "::1" || h === "::") return true;
    if (/^f[cd]/i.test(h) || /^fe[89ab]/i.test(h)) return true;
  }

  return false;
}

function errorResponse(msg, status, targetUrl, wantJson, cors) {
  if (targetUrl === undefined) targetUrl = "";
  if (wantJson === undefined) wantJson = false;
  if (cors === undefined) cors = {};

  const headers = Object.assign({}, cors || {});
  if (!headers["Access-Control-Allow-Origin"]) {
    headers["Access-Control-Allow-Origin"] = "*";
  }

  if (wantJson) {
    headers["Content-Type"] = "application/json; charset=utf-8";
    return new Response(
      JSON.stringify({
        ok: false,
        error: true,
        status: status,
        message: String(msg),
        target: targetUrl || null,
      }),
      { status: status, headers: headers }
    );
  }

  const safe = function (s) {
    return String(s).replace(/[<>&"]/g, function (c) {
      return { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c];
    });
  };

  headers["Content-Type"] = "text/html; charset=utf-8";
  return new Response(
    "<!DOCTYPE html>\n<html lang=\"id\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Proxy Error " +
      status +
      "</title></head>\n<body style=\"background:#05080f;color:#ff3366;font-family:monospace;padding:20px;line-height:1.5;\">\n<h2>❌ PROXY ERROR (" +
      status +
      ")</h2>\n" +
      (targetUrl ? "<p><b>Target:</b> " + safe(targetUrl) + "</p>\n" : "") +
      "<p><b>Pesan:</b> " +
      safe(msg) +
      "</p>\n<p style=\"color:#64748b;\"><i>Pastikan URL valid, target publik, dan tidak memblokir Cloudflare.</i></p>\n</body></html>",
    { status: status, headers: headers }
  );
}

const HELP_HTML =
  "<!DOCTYPE html>\n<html lang=\"id\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>CGO-CYBER PROXY v2.2.1</title></head>\n<body style=\"background:#05080f;color:#00ff9c;font-family:monospace;padding:20px;line-height:1.6;max-width:760px;\">\n<h2>🛡️ CGO-CYBER PROXY v2.2.1 AKTIF</h2>\n<p>CORS credentials · Cookie sanitize · CSS/HLS/XML rewrite · SSRF-safe</p>\n<hr style=\"border-color:#1e293b;\">\n<pre style=\"background:#0a1220;padding:12px;border-radius:8px;overflow:auto;\">?url=https://api.github.com\n?url=https://example.com/stream.m3u8\n?b64=...\n/https://api.github.com</pre>\n<p><a href=\"?url=https://api.github.com\" style=\"color:#22d3ee;\">Test GitHub API</a></p>\n</body></html>";
