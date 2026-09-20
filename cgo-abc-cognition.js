/**
 * CGO ABC Cognition — lapisan formal A→B→C→D untuk seluruh Otak CGO
 * (Sistem/BCGO + Customer). Zero network. Tidak mengganti kepribadian chat.
 *
 * Bergantung pada: cgo-machine-abc.js (+ opsional bridge)
 * API global: window.CGOAbcCognition
 */
(function (global) {
  "use strict";

  const VERSION = "1.0.0-CGO-ABC-COGNITION";

  function engine() {
    return global.CGOMachineABC || global.CGO_MACHINE_ABC || global.CGOCoreMachine || null;
  }

  function bridge() {
    return global.CGOMachineABCBridge || null;
  }

  function isReady() {
    return !!(bridge() || engine());
  }

  /**
   * Kapan formal pass berguna (sistem + customer).
   * Chat santai pendek → false. Struktur / audit / kode / JSON / sistem → true.
   */
  function shouldEnrich(text, options) {
    options = options || {};
    if (options.forceAbc === true || options.force === true) return true;
    if (options.skipAbc === true || options.skip === true) return false;
    const s = String(text || "");
    if (s.length < 6) return false;

    // Eksplisit formal / audit
    if (/\b(verifikasi|audit|mesin\s*abc|self-?test|cek struktur|analisis (struktur|kode|sistem)|bukti formal|well[_\s-]?formed|pipeline\s*a\s*[→\->]\s*b)\b/i.test(s)) {
      return true;
    }

    // JSON / kode / HTML cukup panjang
    const t = s.trim();
    if (t.length >= 20 && ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]")))) return true;
    if (t.length >= 60 && /<\s*(html|div|script|style|body|form)\b/i.test(s)) return true;
    if (t.length >= 80 && /\b(function\s+|export\s+|import\s+|const\s+\w+\s*=)/.test(s)) return true;

    // Pertanyaan sistem / diagnostik CGO
    if (/\b(bcgo|source\s*scan|kontrak|contract\s*gap|telemetry|organ saraf|anomali|integritas|fingerprint)\b/i.test(s) && s.length >= 12) {
      return true;
    }

    // Perintah analisis umum (bukan basa-basi)
    if (/\b(analisis|analisa|periksa struktur|validasi format)\b/i.test(s) && s.length >= 16) return true;

    return false;
  }

  function analyze(input, options) {
    options = options || {};
    const b = bridge();
    if (b && typeof b.analyze === "function") {
      try {
        return b.analyze(input, {
          maxCycles: options.maxCycles ?? 1,
          autoReflect: !!options.autoReflect,
          fast: options.fast !== false,
          skipAudit: options.skipAudit !== false && options.fast !== false
        });
      } catch (err) {
        return { ok: false, error: String(err && err.message || err) };
      }
    }
    const e = engine();
    if (e && typeof e.process === "function") {
      try {
        if (e.isPaused && e.isPaused()) {
          return { ok: false, paused: true, error: "Mesin ABC dijeda" };
        }
        const out = e.process(input, {
          maxCycles: options.maxCycles ?? 1,
          fast: options.fast !== false,
          skipAudit: options.skipAudit !== false
        });
        return {
          ok: true,
          engine: "CGO_MACHINE_ABC",
          version: e.version,
          status: out?.result?.status || null,
          confidence: out?.result?.decision?.confidence ?? null,
          summary: out?.result?.summary || null,
          findings: out?.result?.findings || [],
          audit: out?.audit || null,
          packet: out
        };
      } catch (err) {
        return { ok: false, error: String(err && err.message || err) };
      }
    }
    return { ok: false, error: "MESIN_ABC_NOT_LOADED" };
  }

  function health(force) {
    const b = bridge();
    if (b && typeof b.healthSnapshot === "function") {
      try { return b.healthSnapshot(!!force); } catch (_) {}
    }
    const e = engine();
    if (!e) return { ok: false, error: "MESIN_ABC_NOT_LOADED" };
    try {
      const st = e.selfTest();
      const ind = e.auditIndependence ? e.auditIndependence() : { verified: null };
      const m = e.getMetrics ? e.getMetrics() : {};
      return {
        ok: true,
        engine: "CGO_MACHINE_ABC",
        version: e.version,
        selfTest: { passed: st.passed, total: st.total, verified: st.verified },
        independence: { verified: ind.verified, scanned: ind.scannedFunctions },
        metrics: m,
        paused: e.isPaused ? e.isPaused() : false
      };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  }

  function formatHint(abc, style) {
    if (!abc || !abc.ok) return "";
    style = style || "compact";
    const conf = abc.confidence != null ? Math.round(Number(abc.confidence) * 100) + "%" : "–";
    const nFind = (abc.findings || []).length;
    const audit = abc.audit?.status || abc.audit || "–";
    const ver = abc.version || abc.engine || "";
    if (style === "customer") {
      return (
        "\n\n〔Mesin ABC〕 status " +
        (abc.status || "–") +
        " · keyakinan " +
        conf +
        (nFind ? " · temuan " + nFind : "") +
        (audit && audit !== "–" ? " · audit " + audit : "")
      );
    }
    return `[Mesin ABC ${ver}] status ${abc.status || "–"} · keyakinan ${conf} · temuan ${nFind} · audit ${audit}`;
  }

  /**
   * Enrich teks jawaban alami dengan jejak formal (opsional).
   */
  function appendHint(answerText, abc, options) {
    options = options || {};
    if (!abc || !abc.ok) return answerText;
    const show =
      options.includeAbcHint === true ||
      options.forceHint === true ||
      (options.userText && /mesin\s*abc|hasil audit|laporan formal|self-?test/i.test(String(options.userText)));
    if (!show) return answerText;
    const hint = formatHint(abc, options.style || "compact");
    if (!hint) return answerText;
    const base = answerText == null ? "" : String(answerText);
    if (base.includes("Mesin ABC") || base.includes("〔Mesin ABC〕")) return base;
    return base + (base && !base.endsWith("\n") ? "\n" : "") + hint;
  }

  /**
   * Satu pintu: analisa jika perlu, kembalikan {abc, hint, meta}
   */
  function enrich(text, options) {
    options = options || {};
    if (!shouldEnrich(text, options)) {
      return { used: false, abc: null, hint: "", meta: { reason: "SKIP_NOT_NEEDED" } };
    }
    if (!isReady()) {
      return { used: false, abc: null, hint: "", meta: { reason: "ENGINE_MISSING" } };
    }
    // self-test singkat
    if (/self-?test/i.test(String(text || ""))) {
      const h = health(true);
      if (h && h.ok !== false && h.selfTest) {
        const abc = {
          ok: !!h.selfTest.verified,
          version: h.version,
          status: h.selfTest.verified ? "SELF_TEST_OK" : "SELF_TEST_FAIL",
          confidence: h.selfTest.verified ? 1 : 0,
          findings: [],
          audit: { status: h.independence?.verified ? "PASS" : "CHECK" }
        };
        return {
          used: true,
          abc,
          hint: formatHint(abc, options.style || "compact") +
            ` · self-test ${h.selfTest.passed}/${h.selfTest.total}`,
          meta: { reason: "SELF_TEST", health: h }
        };
      }
    }
    const abc = analyze(text, options);
    return {
      used: true,
      abc,
      hint: abc && abc.ok ? formatHint(abc, options.style || "compact") : "",
      meta: { reason: "ANALYZE" }
    };
  }

  const API = Object.freeze({
    version: VERSION,
    isReady,
    shouldEnrich,
    analyze,
    health,
    formatHint,
    appendHint,
    enrich,
    engine,
    bridge
  });

  global.CGOAbcCognition = API;
  // Alias singkat
  if (!global.CGO_ABC) global.CGO_ABC = API;

  try {
    console.log("[CGO-ABC-COGNITION] Siap ·", VERSION, "· engine", isReady() ? "YES" : "NO");
  } catch (_) {}
})(typeof globalThis !== "undefined" ? globalThis : window);
