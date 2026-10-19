/* ============================================================================
 * CGO — CCTV PROXY SERVER
 * File: proxy-server.js
 * Version: 1.0.0
 * ============================================================================
 * Tujuan:
 *   - Menghapus header X-Frame-Options & CSP frame-ancestors
 *   - Menulis ulang URL relatif agar aset (CSS/JS/gambar) tetap melalui proxy
 *   - Whitelist domain untuk keamanan
 *   - CORS enabled
 *
 * Cara jalankan:
 *   npm init -y
 *   npm install express axios
 *   node proxy-server.js
 * ============================================================================ */

const express = require("express");
const axios = require("axios");
const { URL } = require("url");

const app = express();
const PORT = process.env.PORT || 3001;

/* Whitelist domain yang diizinkan untuk diproksi */
const ALLOWED_DOMAINS = [
  "cctv.balitower.co.id",
  "jakcctv.jakarta.go.id",
  "atcs-dishub.bandung.go.id",
  "pelindung.bandung.go.id",
  "cctv.jogjakota.go.id",
  "pantausemar.semarangkota.go.id",
  "atcs.denpasarkota.go.id",
  "cctv-dishub.tangerangkab.go.id",
  "cctv.bantenprov.go.id",
  "cctv.serangkota.go.id",
  "matanya.batam.go.id"
];

/* Header yang harus dihapus agar bisa di-embed */
const HEADERS_TO_REMOVE = [
  "x-frame-options",
  "content-security-policy",
  "content-security-policy-report-only",
  "x-content-type-options"
];

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

/**
 * Endpoint proxy utama.
 * Contoh: /proxy?url=https://cctv.balitower.co.id/...
 */
app.get("/proxy", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send("Missing ?url parameter");

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch (_) {
    return res.status(400).send("Invalid URL");
  }

  if (!ALLOWED_DOMAINS.includes(parsed.hostname)) {
    return res.status(403).send("Domain not allowed: " + parsed.hostname);
  }

  try {
    const response = await axios.get(targetUrl, {
      responseType: "arraybuffer",
      timeout: 15000,
      maxRedirects: 5,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9," +
          "image/avif,image/webp,*/*;q=0.8"
      }
    });

    /* Salin header asli kecuali yang diblokir */
    for (const [key, value] of Object.entries(response.headers)) {
      if (!HEADERS_TO_REMOVE.includes(key.toLowerCase())) {
        try {
          res.setHeader(key, value);
        } catch (_) {}
      }
    }

    /* Header permisif */
    res.setHeader("X-Frame-Options", "ALLOWALL");
    res.setHeader("Content-Security-Policy", "frame-ancestors *");
    res.setHeader("Access-Control-Allow-Origin", "*");

    const contentType = (response.headers["content-type"] || "").toLowerCase();

    /* Jika HTML, tulis ulang URL relatif agar melalui proxy */
    if (contentType.includes("text/html")) {
      let html = response.data.toString("utf8");
      const baseUrl = `${parsed.protocol}//${parsed.host}`;

      /* Tulis ulang src / href / action / srcset (sederhana) */
      html = html.replace(
        /(src|href|action)=["'](?!https?:\/\/|\/\/|#|data:|javascript:)([^"']+)["']/gi,
        (match, attr, path) => {
          try {
            const absolute = new URL(path, baseUrl).href;
            return `${attr}="/proxy?url=${encodeURIComponent(absolute)}"`;
          } catch (_) {
            return match;
          }
        }
      );

      /* Tulis ulang srcset */
      html = html.replace(/srcset=["']([^"']+)["']/gi, (match, srcset) => {
        const rewritten = srcset
          .split(",")
          .map(part => {
            const [url, descriptor] = part.trim().split(/\s+/);
            try {
              const absolute = new URL(url, baseUrl).href;
              return `/proxy?url=${encodeURIComponent(absolute)} ${descriptor || ""}`;
            } catch (_) {
              return part;
            }
          })
          .join(", ");
        return `srcset="${rewritten}"`;
      });

      return res.send(html);
    }

    /* Biner (gambar, video, font, dll.) langsung kirim */
    res.send(response.data);
  } catch (error) {
    console.error("[Proxy]", error.message);
    res
      .status(502)
      .send("Proxy error: " + (error.response?.status || error.message));
  }
});

/* Health check */
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    allowedDomains: ALLOWED_DOMAINS,
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`CGO CCTV Proxy running on http://localhost:${PORT}`);
  console.log("Whitelist domains:", ALLOWED_DOMAINS.join(", "));
});
