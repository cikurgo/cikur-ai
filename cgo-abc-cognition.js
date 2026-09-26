/**
 * CGO ABC Cognition — lapisan formal A→B→C→D untuk seluruh Otak CGO
 * (Sistem/BCGO + Customer). Zero network. Tidak mengganti kepribadian chat.
 *
 * Bergantung pada: cgo-machine-abc.js (+ opsional bridge)
 * API global: window.CGOAbcCognition
 */
(function (global) {
  "use strict";

  const VERSION = "1.1.0-CGO-ABC-COGNITION";

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
   * Chat santai sangat pendek → false.
   * Struktur / audit / kode / JSON / sistem / penjelasan / konteks / layanan → true.
   * Versi 1.1: lebih agresif membantu otak CGO (bukan hanya formal).
   */
  function shouldEnrich(text, options) {
    options = options || {};
    if (options.forceAbc === true || options.force === true) return true;
    if (options.skipAbc === true || options.skip === true) return false;
    const s = String(text || "");
    if (s.length < 4) return false;

    const t = s.trim();
    const lower = t.toLowerCase();

    // 1) Eksplisit formal / audit / mesin
    if (/\b(verifikasi|audit|mesin\s*abc|self-?test|cek struktur|analisis (struktur|kode|sistem)|bukti formal|well[_\s-]?formed|pipeline\s*a\s*[→\->]\s*b)\b/i.test(s)) {
      return true;
    }

    // 2) JSON / kode / HTML cukup panjang
    if (t.length >= 18 && ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]")))) return true;
    if (t.length >= 50 && /<\s*(html|div|script|style|body|form)\b/i.test(s)) return true;
    if (t.length >= 60 && /\b(function\s+|export\s+|import\s+|const\s+\w+\s*=)/.test(s)) return true;

    // 3) Diagnostik sistem / BCGO
    if (/\b(bcgo|source\s*scan|kontrak|contract\s*gap|telemetry|organ saraf|anomali|integritas|fingerprint)\b/i.test(s) && s.length >= 10) {
      return true;
    }

    // 4) Perintah analisis umum
    if (/\b(analisis|analisa|periksa struktur|validasi format)\b/i.test(s) && s.length >= 12) return true;

    // 5) BARU — pertanyaan penjelasan / definisi (membantu otak menjawab lebih cerdas)
    if (/\b(apa\s+itu|apa\s+sih|jelaskan|jelasin|ceritakan|ceritain|maksudnya|bagaimana\s+cara|gimana\s+cara|bagaimana\s+cara\s+kerja|what\s+is|what\s+does|explain|tell\s+me\s+about)\b/i.test(s) && s.length >= 8) {
      return true;
    }

    // 6) BARU — referensi konteks / memori percakapan
    if (/\b(tadi|sebelumnya|barusan|yang\s+tadi|kita\s+bahas|bahas\s+apa|topik\s+terakhir|lanjutkan|lanjut\s+yang|previous|earlier|what\s+did\s+we)\b/i.test(s) && s.length >= 8) {
      return true;
    }

    // 7) BARU — pertanyaan tentang layanan CIKUR GO / Mitra
    if (/\b(cikur\s*go|cikurgo|layanan|food|ride|assistant|2in1|mitra|driver|resto|pesan\s+makanan|pesan\s+ride|sewa\s+assistant)\b/i.test(s) && s.length >= 10) {
      return true;
    }

    // 8) BARU — pertanyaan cukup panjang / multi-kata yang tampak butuh pemahaman
    if (t.length >= 28 && (/\?$/.test(t) || /^(siapa|apa|bagaimana|gimana|kenapa|mengapa|kapan|dimana|di\s*mana|berapa|bisa|mau|inginin|tolong)\b/i.test(t))) {
      return true;
    }

    // 9) Mode light: pesan sedang + mengandung kata kerja permintaan
    if (options.light === true && t.length >= 16 && /\b(mau|inginin|tolong|bisa|ingin|butuh|cari|pesan|order)\b/i.test(s)) {
      return true;
    }

    return false;
  }

  /**
   * Analisis ringan riwayat percakapan (recentMessages) untuk bantu recall topik.
   * Input: array [{role, text}] atau string gabungan.
   * Output: {ok, topics, lastUserTopics, summary, confidence}
   */
  function analyzeConversationHistory(messages, options) {
    options = options || {};
    if (!isReady()) {
      return { ok: false, error: "MESIN_ABC_NOT_LOADED", topics: [], summary: null };
    }

    let payload = messages;
    if (Array.isArray(messages)) {
      // Bentuk ringkas yang mudah diparse mesin ABC
      payload = {
        type: "conversation_history",
        turns: messages.slice(-10).map(function (m, i) {
          return {
            i: i,
            role: (m && m.role) || "unknown",
            text: String((m && (m.text || m.content || m.message)) || "").slice(0, 400)
          };
        })
      };
    }

    const abc = analyze(payload, {
      maxCycles: 1,
      fast: true,
      skipAudit: true,
      force: true
    });

    if (!abc || !abc.ok) {
      return {
        ok: false,
        error: (abc && abc.error) || "ANALYZE_FAIL",
        topics: [],
        summary: null,
        abc: abc
      };
    }

    // Ekstrak topik kasar dari findings + summary (domain-neutral, lalu mapping layanan)
    const findings = Array.isArray(abc.findings) ? abc.findings : [];
    const summaryText = String(abc.summary || "");
    const joined = (findings.map(function (f) {
      return typeof f === "string" ? f : (f && (f.text || f.message || f.summary || JSON.stringify(f))) || "";
    }).join(" ") + " " + summaryText).toLowerCase();

    const topicMap = [
      { key: "food", re: /\b(food|makanan|makan|resto|restaurant|kuliner)\b/ },
      { key: "ride", re: /\b(ride|perjalanan|ojek|driver|antar|transport)\b/ },
      { key: "assistant", re: /\b(assistant|asisten|pendamping|bantuan)\b/ },
      { key: "cikurgo2in1", re: /\b(2in1|dua\s*in\s*satu|gabungan)\b/ },
      { key: "cikur_go", re: /\b(cikur\s*go|cikurgo|platform|layanan)\b/ },
      { key: "pricing", re: /\b(harga|biaya|tarif|price|cost)\b/ }
    ];

    const topics = [];
    topicMap.forEach(function (tm) {
      if (tm.re.test(joined)) topics.push(tm.key);
    });

    // Fallback: scan teks mentah messages jika findings kosong
    if (!topics.length && Array.isArray(messages)) {
      const raw = messages.map(function (m) {
        return String((m && (m.text || m.content)) || "").toLowerCase();
      }).join(" ");
      topicMap.forEach(function (tm) {
        if (tm.re.test(raw)) topics.push(tm.key);
      });
    }

    return {
      ok: true,
      topics: topics,
      lastUserTopics: topics.slice(0, 3),
      summary: abc.summary || (topics.length ? "Topik terdeteksi: " + topics.join(", ") : null),
      confidence: abc.confidence != null ? abc.confidence : (topics.length ? 0.7 : 0.3),
      status: abc.status,
      findingsCount: findings.length,
      abc: abc
    };
  }

  function analyze(input, options) {
    options = options || {};
    const b = bridge();
    if (b && typeof b.analyze === "function") {
      try {
        return b.analyze(input, {
          maxCycles: options.maxCycles ?? 1,
          autoReflect: !!options.autoReflect,
          // Formal cognition memakai pipeline penuh A→B→C→D secara default.
          // fast/skipAudit hanya bila caller meminta eksplisit.
          fast: options.fast === true,
          skipAudit: options.skipAudit === true
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
    analyzeConversationHistory,
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
