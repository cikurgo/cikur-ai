export default {
  async fetch(request, env, ctx) {
    // ===== 0. HEADER CORS GLOBAL =====
    const CORS_HEADERS = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Expose-Headers": "*",
      "Access-Control-Max-Age": "86400",
    };

    // ===== 1. PREFLIGHT =====
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const reqUrl = new URL(request.url);
    let targetUrl = reqUrl.searchParams.get("url");

    // ===== 2. HELP PAGE =====
    if (!targetUrl) {
      return new Response(HELP_HTML, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8", ...CORS_HEADERS },
      });
    }

    if (targetUrl.length > 8192) return errorResponse("URL terlalu panjang", 414);

    // ===== 3. VALIDASI URL =====
    let targetUrlObj;
    try {
      targetUrl = decodeURIComponent(targetUrl);
      targetUrlObj = new URL(targetUrl);
    } catch {
      return errorResponse("URL tidak valid", 400, targetUrl);
    }

    if (!["http:", "https:"].includes(targetUrlObj.protocol)) {
      return errorResponse("Hanya protokol http/https yang diizinkan", 400, targetUrl);
    }
    if (isPrivateHost(targetUrlObj.hostname)) {
      return errorResponse("Target host diblokir (private/internal address)", 403, targetUrl);
    }

    const targetOrigin = targetUrlObj.origin;

    try {
      // ===== 4. BANGUN HEADER UPSTREAM (SPOOFING) =====
      const upstreamHeaders = new Headers();
      const STRIP_REQ = new Set([
        "host", "origin", "referer", "cookie", "accept-encoding",
        "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
        "te", "trailer", "transfer-encoding", "upgrade", "content-length",
      ]);

      for (const [k, v] of request.headers) {
        const lk = k.toLowerCase();
        if (!STRIP_REQ.has(lk) && !lk.startsWith("cf-") && !lk.startsWith("x-forwarded-")) {
          upstreamHeaders.set(k, v);
        }
      }

      upstreamHeaders.set(
        "User-Agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
      );
      upstreamHeaders.set("Accept-Language", "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7");
      if (!upstreamHeaders.has("Accept")) upstreamHeaders.set("Accept", "*/*");
      upstreamHeaders.set("Referer", targetOrigin + "/");
      upstreamHeaders.set("Origin", targetOrigin);

      // ===== 5. BUFFER BODY (agar bisa retry saat redirect) =====
      let bodyData = null;
      if (!["GET", "HEAD"].includes(request.method) && request.body) {
        bodyData = await request.arrayBuffer();
      }

      // ===== 6. ABORT CONTROL =====
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      try {
        request.signal?.addEventListener?.("abort", () => controller.abort());
      } catch (_) {}

      const init = {
        method: request.method,
        headers: upstreamHeaders,
        redirect: "manual",
        signal: controller.signal,
        body: bodyData,
      };

      const response = await fetchWithRedirects(targetUrl, init);
      clearTimeout(timeoutId);

      // ===== 7. BANGUN HEADER RESPONS =====
      const newHeaders = new Headers();
      const STRIP_RES = new Set([
        "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
        "te", "trailer", "transfer-encoding", "upgrade",
        "content-security-policy", "content-security-policy-report-only",
        "x-frame-options", "frame-options",
        "strict-transport-security", "cross-origin-opener-policy",
        "cross-origin-embedder-policy", "cross-origin-resource-policy",
        "permissions-policy", "report-to", "nel",
        "content-length", // akan dipulihkan nanti bila perlu
      ]);

      for (const [k, v] of response.headers) {
        if (!STRIP_RES.has(k.toLowerCase())) newHeaders.set(k, v);
      }
      for (const [k, v] of Object.entries(CORS_HEADERS)) newHeaders.set(k, v);

      // ===== 8. SANITASI SET-COOKIE =====
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

      // ===== 9. DETEKSI KONTEN =====
      const contentType = (newHeaders.get("content-type") || "").toLowerCase();
      const isHTML = contentType.includes("text/html") || contentType.includes("application/xhtml");
      const isHead = request.method === "HEAD";

      // ===== 10. HTML REWRITER =====
      if (isHTML && !isHead) {
        newHeaders.delete("content-encoding");
        const escapeAttr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

        const rewriter = new HTMLRewriter()
          .on("head", {
            element(el) {
              el.prepend(`<base href="${escapeAttr(targetOrigin)}/">`, { html: true });
            },
          })
          .on("meta[http-equiv]", {
            element(el) {
              const v = (el.getAttribute("http-equiv") || "").toLowerCase();
              if (v === "content-security-policy" || v === "refresh") el.remove();
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

      // ===== 11. NON-HTML (Streaming pass-through) =====
      const cl = response.headers.get("content-length");
      if (cl) newHeaders.set("content-length", cl);

      return new Response(isHead ? null : response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    } catch (error) {
      let msg = error?.message || String(error);
      let status = 502;
      if (error?.name === "AbortError") {
        msg = "Request Timeout (15 detik).";
        status = 504;
      }
      return errorResponse(msg, status, targetUrl);
    }
  },
};

// ===== FETCH DENGAN MANUAL REDIRECT + SSRF CHECK =====
async function fetchWithRedirects(url, init, maxRedirects = 5) {
  let currentUrl = url;
  let currentMethod = init.method;
  let currentBody = init.body;
  let currentHeaders = new Headers(init.headers);

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

      // 303 → GET, 301/302 + POST → GET, 307/308 → preserve method
      if (
        res.status === 303 ||
        ((res.status === 301 || res.status === 302) && currentMethod === "POST")
      ) {
        currentMethod = "GET";
        currentBody = null;
        currentHeaders.delete("content-type");
        currentHeaders.delete("content-length");
      }

      try { await res.body?.cancel(); } catch (_) {}
      continue;
    }
    return res;
  }
  throw new Error("Terlalu banyak redirect (>5)");
}

// ===== SSRF PROTECTION =====
function isPrivateHost(hostname) {
  const h = (hostname || "").toLowerCase();
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "metadata" || h === "metadata.google.internal") return true;

  // IPv4
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    if ([a, b, c, d].some((n) => n > 255)) return true;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;              // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;     // private
    if (a === 192 && b === 168) return true;              // private
    if (a === 100 && b >= 64 && b <= 127) return true;    // CGNAT
    if (a >= 224) return true;                            // multicast/reserved
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmark
  }

  // IPv6 (basic)
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    const inner = h.slice(1, end);
    if (inner === "::1" || inner === "::" || inner === "0:0:0:0:0:0:0:1") return true;
    if (/^f[cd]/i.test(inner)) return true;               // fc00::/7
    if (/^fe[89ab]/i.test(inner)) return true;            // fe80::/10
    if (/^::ffff:/i.test(inner)) return isPrivateHost(inner.replace(/^::ffff:/i, ""));
  }

  return false;
}

// ===== ERROR UI (XSS-safe) =====
function errorResponse(msg, status, targetUrl = "") {
  const safe = (s) =>
    String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
  return new Response(
    `<!DOCTYPE html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Proxy Error ${status}</title></head>
<body style="background:#05080f;color:#ff3366;font-family:monospace;padding:20px;line-height:1.5;">
<h2>❌ PROXY ERROR (${status})</h2>
${targetUrl ? `<p><b>Target:</b> ${safe(targetUrl)}</p>` : ""}
<p><b>Pesan:</b> ${safe(msg)}</p>
<p style="color:#64748b;"><i>Pastikan URL valid, target publik, dan tidak memblokir Cloudflare.</i></p>
</body></html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}

// ===== HELP PAGE =====
const HELP_HTML = `<!DOCTYPE html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CGO-CYBER PROXY</title></head>
<body style="background:#05080f;color:#00ff9c;font-family:monospace;padding:20px;line-height:1.6;">
<h2>🛡️ CGO-CYBER PROXY AKTIF</h2>
<p>Format: <code>?url=https://example.com</code></p>
<p>Contoh: <a href="?url=https://api.github.com" style="color:#22d3ee;">?url=https://api.github.com</a></p>
<hr style="border-color:#1e293b;">
<p style="color:#64748b;font-size:12px;">SSRF Protected • CORS Enabled • HTML Rewritten • Redirect-Aware</p>
</body></html>`;
