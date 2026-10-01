/**
 * CIKUR GO — Smart Error Dashboard Engine
 * Real-time monitor: gejala → file → baris → relasi → akar
 * Zero network dependency. Baca BCGO_STATE + runtime traps + source scan.
 * Version: 1.0.0-SMART-ERROR-ROOT
 */
(function (global) {
  "use strict";

  const VERSION = "1.1.1-NO-STUCK";
  const MAX_ERRORS = 80;
  const MAX_CHAIN = 12;

  const state = {
    errors: [],
    chains: [],
    summary: { total: 0, active: 0, recovered: 0, relationBreaks: 0, runtime: 0 },
    lastTick: 0,
    bcgo: null,
    sourceScan: null
  };
  const listeners = new Set();
  let channel = null;
  let pollTimer = null;
  let trapsInstalled = false;

  function now() { return Date.now(); }
  function iso(t) { try { return new Date(t || now()).toISOString(); } catch (_) { return String(t); } }

  function normalizeFile(value) {
    const raw = String(value || "").trim();
    if (!raw) return null;
    const clean = raw.split("?")[0].split("#")[0];
    const base = clean.substring(clean.lastIndexOf("/") + 1);
    return base || clean;
  }

  function parseStack(stack) {
    const frames = [];
    const text = String(stack || "");
    const re = /(?:at\s+)?(?:([^\s(]+)\s+\()?((?:https?:\/\/|file:\/\/|\/)?[^\s:)]+\.(?:js|html|mjs|ts))(?::(\d+))?(?::(\d+))?\)?/gi;
    let m;
    while ((m = re.exec(text)) && frames.length < 20) {
      frames.push({
        fn: m[1] || null,
        file: normalizeFile(m[2]),
        path: m[2],
        line: m[3] ? Number(m[3]) : null,
        column: m[4] ? Number(m[4]) : null
      });
    }
    // Fallback: simple file:line:col
    if (!frames.length) {
      const simple = text.match(/([\w./-]+\.(?:js|html)):(\d+)(?::(\d+))?/);
      if (simple) {
        frames.push({
          fn: null,
          file: normalizeFile(simple[1]),
          path: simple[1],
          line: Number(simple[2]),
          column: simple[3] ? Number(simple[3]) : null
        });
      }
    }
    return frames;
  }

  function classifySeverity(msg, type) {
    const s = String(msg || "").toLowerCase();
    const t = String(type || "").toLowerCase();
    if (t === "error" || /typeerror|referenceerror|syntaxerror|uncaught|fatal|cannot read|is not defined|is not a function/.test(s)) return "CRITICAL";
    if (/failed|timeout|network|firestore|permission|quota|mismatch|unknown surface|putus|tidak terhubung/.test(s)) return "HIGH";
    if (/warn|degraded|partial|stale|missing|optional/.test(s)) return "MEDIUM";
    return "LOW";
  }

  function makeId(parts) {
    return parts.filter(Boolean).join("|").slice(0, 180);
  }

  function pushError(entry) {
    const id = entry.id || makeId([entry.source, entry.file, entry.line, entry.message]);
    const existing = state.errors.findIndex((e) => e.id === id);
    const row = {
      id,
      at: entry.at || now(),
      source: entry.source || "RUNTIME",
      type: entry.type || "error",
      severity: entry.severity || classifySeverity(entry.message, entry.type),
      message: String(entry.message || "").slice(0, 900),
      file: entry.file || null,
      path: entry.path || null,
      line: entry.line != null ? Number(entry.line) : null,
      column: entry.column != null ? Number(entry.column) : null,
      frames: entry.frames || [],
      related: entry.related || [],
      rootHint: entry.rootHint || null,
      count: 1
    };
    if (existing >= 0) {
      state.errors[existing].count += 1;
      state.errors[existing].at = row.at;
      state.errors[existing].message = row.message;
      return state.errors[existing];
    }
    state.errors.unshift(row);
    state.errors = state.errors.slice(0, MAX_ERRORS);
    return row;
  }

  function relationBreaksFromScan(scan) {
    const breaks = [];
    const relations = (scan && scan.relations) || [];
    for (const r of relations) {
      if (!r || (r.status !== "UNKNOWN" && r.status !== "MISMATCH")) continue;
      breaks.push({
        status: r.status,
        from: r.sourceFile || r.source || null,
        to: r.targetFile || r.target || null,
        key: r.key || null,
        type: r.type || "CROSS_FILE",
        confidence: r.confidence || null
      });
    }
    return breaks;
  }

  function buildRootHint(err, breaks) {
    if (err.rootHint) return err.rootHint;
    const file = err.file;
    const hits = breaks.filter((b) => {
      const a = normalizeFile(b.from);
      const bto = normalizeFile(b.to);
      return (file && (a === file || bto === file)) ||
        (err.message && b.key && String(err.message).includes(String(b.key).slice(0, 40)));
    });
    if (hits.length) {
      const h = hits[0];
      return {
        kind: "RELASI_PUTUS",
        summary: `File ${normalizeFile(h.from) || "?"} tidak terhubung ke ${normalizeFile(h.to) || "?"} (${h.status})`,
        from: h.from,
        to: h.to,
        status: h.status,
        key: h.key,
        line: err.line,
        detail: err.line
          ? `Gejala di ${file || "unknown"} baris ${err.line}` + (err.column != null ? ` kolom ${err.column}` : "")
          : `Gejala di ${file || "runtime"}`
      };
    }
    if (/is not defined|is not a function|Cannot read propert/i.test(err.message || "")) {
      return {
        kind: "RUNTIME_REF",
        summary: "Referensi runtime gagal — fungsi/modul mungkin belum dimuat atau nama salah",
        from: file,
        to: null,
        line: err.line,
        detail: err.frames && err.frames[0]
          ? `Stack teratas: ${err.frames[0].file || "?"}:${err.frames[0].line || "?"}`
          : null
      };
    }
    if (/Script error/i.test(err.message || "")) {
      return {
        kind: "CROSS_ORIGIN",
        summary: "Script error tersanitasi browser (cross-origin) — detail baris tidak tersedia",
        from: file,
        line: err.line
      };
    }
    return {
      kind: "GEJALA",
      summary: err.message ? String(err.message).slice(0, 200) : "Error tanpa pesan",
      from: file,
      line: err.line,
      detail: err.frames && err.frames[1]
        ? `Pemanggil: ${err.frames[1].file || "?"}:${err.frames[1].line || "?"}`
        : null
    };
  }


  /* ========== MESIN ABC → teks manusia untuk Dashboard ========== */
  function severityToId(sev) {
    const s = String(sev || "").toUpperCase();
    if (s === "CRITICAL") return "kritis";
    if (s === "HIGH") return "tinggi";
    if (s === "MEDIUM") return "sedang";
    return "rendah";
  }

  function humanizeAbcResult(abc, chain) {
    if (!abc) {
      return {
        ok: false,
        headline: "Mesin ABC belum tersedia",
        body: "Muat cgo-machine-abc.js + bridge agar setiap error diterjemahkan formal A→B→C→D."
      };
    }
    if (!abc.ok) {
      return {
        ok: false,
        headline: "Mesin ABC tidak memproses",
        body: String(abc.error || abc.message || "gagal")
      };
    }
    const st = String(abc.status || "UNKNOWN");
    const conf = abc.confidence != null ? Math.round(Number(abc.confidence) * 100) : null;
    const audit = abc.audit && (abc.audit.status || abc.audit);
    const findings = Array.isArray(abc.findings) ? abc.findings : [];
    const nFind = findings.length;
    const file = chain && chain.file ? chain.file : null;
    const line = chain && chain.line != null ? chain.line : null;

    let tone = "perlu perhatian";
    if (/WELL_FORMED|PROCESSED|VALID|OK|CLEAN/i.test(st) && nFind === 0) tone = "terkendali";
    else if (/CONTRADICTION|FAIL|ERROR|CRITICAL/i.test(st)) tone = "ada konflik / kegagalan formal";
    else if (/PARTIAL|DEGRADED|ATTENTION/i.test(st)) tone = "sebagian terisi, belum lengkap";

    const lines = [];
    lines.push("Mesin ABC menilai kasus ini: status " + st +
      (conf != null ? " (keyakinan " + conf + "%)" : "") +
      (audit ? ", audit " + audit : "") + " — " + tone + ".");

    if (file) {
      lines.push("Lokasi yang ditinjau: " + file +
        (line != null ? " pada baris " + line : "") + ".");
    }

    if (chain && chain.root && chain.root.summary) {
      lines.push("Hipotesis dashboard: " + chain.root.summary + ".");
    }

    if (chain && chain.relationHits && chain.relationHits.length) {
      const r = chain.relationHits[0];
      lines.push("Scanner mendeteksi relasi " + (r.status || "?") +
        " dari " + (String(r.from || "").split("/").pop() || "?") +
        " ke " + (String(r.to || "").split("/").pop() || "?") +
        ". Artinya tautan modul itu putus atau belum terdaftar sebagai kontrak.");
    }

    if (nFind) {
      const tops = findings.slice(0, 3).map(function (f) {
        if (!f) return null;
        if (typeof f === "string") return f;
        return f.message || f.type || f.status || JSON.stringify(f).slice(0, 80);
      }).filter(Boolean);
      if (tops.length) {
        lines.push("Temuan formal ABC (" + nFind + "): " + tops.join("; ") + ".");
      }
    }

    if (abc.summary) {
      var sum = abc.summary;
      if (sum && typeof sum === "object") {
        sum = sum.text || sum.message || sum.headline || sum.status || "";
      }
      if (sum) lines.push("Ringkasan mesin: " + String(sum).slice(0, 280));
    }

    // Saran manusia
    const tips = [];
    if (chain && chain.root && chain.root.kind === "RELASI_PUTUS") {
      tips.push("Periksa apakah script target dimuat di HTML sumber, dan path-nya benar (tanpa salah folder).");
    }
    if (chain && chain.root && chain.root.kind === "RUNTIME_REF") {
      tips.push("Pastikan urutan <script> benar: modul penyedia harus dimuat sebelum pemanggil.");
    }
    if (/CONTRADICTION|FAIL|ERROR/i.test(st)) {
      tips.push("Tangani sebagai prioritas: jangan anggap sistem sehat sampai status ABC membaik.");
    }
    if (!tips.length) {
      tips.push("Pantau ulang setelah perbaikan; bila gejala hilang, entri ini bisa dibersihkan dari dashboard.");
    }
    lines.push("Saran: " + tips.join(" "));

    return {
      ok: true,
      headline: "ABC · " + st + (conf != null ? " · " + conf + "%" : ""),
      body: lines.join(" "),
      status: st,
      confidence: conf,
      audit: audit || null,
      findingsCount: nFind
    };
  }

  function buildAbcInputFromChain(chain) {
    return {
      type: "error-dashboard-case",
      source: "CGO_ERROR_DASHBOARD",
      capturedAt: new Date().toISOString(),
      symptom: chain.symptom || chain.message || null,
      severity: chain.severity || null,
      file: chain.file || null,
      line: chain.line != null ? chain.line : null,
      column: chain.column != null ? chain.column : null,
      rootKind: chain.root && chain.root.kind || null,
      rootSummary: chain.root && chain.root.summary || null,
      relations: (chain.relationHits || []).map(function (r) {
        return { from: r.from, to: r.to, status: r.status, key: r.key };
      }),
      frames: (chain.frames || []).slice(0, 5)
    };
  }

  function analyzeChainWithAbc(chain) {
    const bridge = global.CGOMachineABCBridge;
    const engine = global.CGOMachineABC;
    if (!bridge && !engine) return humanizeAbcResult(null, chain);

    try {
      const input = buildAbcInputFromChain(chain);
      const claims = [{
        source: "ERROR_DASHBOARD",
        target: chain.file || "unknown",
        status: /CRITICAL|HIGH/i.test(String(chain.severity)) ? "ANOMALY" : "REVIEW",
        severity: chain.severity || "MEDIUM",
        message: chain.symptom || chain.message || "error dashboard case"
      }];
      let abc;
      if (bridge && typeof bridge.analyze === "function") {
        abc = bridge.analyze(input, {
          maxCycles: 1,
          fast: false,
          skipAudit: false,
          externalEvidence: {
            schema: "CGO_EXTERNAL_EVIDENCE_V1",
            source: "ERROR_DASHBOARD",
            capturedAt: new Date().toISOString(),
            claims: claims,
            fingerprint: String(chain.id || "")
          }
        });
      } else {
        const packet = engine.process(input, {
          externalEvidence: {
            schema: "CGO_EXTERNAL_EVIDENCE_V1",
            source: "ERROR_DASHBOARD",
            capturedAt: new Date().toISOString(),
            claims: claims
          }
        });
        const result = packet && (packet.result || packet.finalResult);
        abc = {
          ok: true,
          status: result && result.status,
          confidence: result && result.decision && result.decision.confidence,
          summary: result && result.summary,
          findings: result && result.findings || [],
          audit: packet && packet.audit,
          packet: packet
        };
      }
      return humanizeAbcResult(abc, chain);
    } catch (err) {
      return {
        ok: false,
        headline: "ABC error",
        body: String(err && err.message || err)
      };
    }
  }

  function enrichChainsWithAbc() {
    for (const c of state.chains) {
      // Cache: jangan ulang proses jika id sama & sudah ada human
      if (c.abcHuman && c._abcFor === c.id + ":" + c.count) continue;
      const human = analyzeChainWithAbc(c);
      c.abcHuman = human;
      c._abcFor = c.id + ":" + (c.count || 1);
    }
  }


  function rebuildChains() {
    const breaks = relationBreaksFromScan(state.sourceScan);
    const chains = [];
    for (const err of state.errors.slice(0, MAX_CHAIN * 2)) {
      const root = buildRootHint(err, breaks);
      chains.push({
        id: err.id,
        severity: err.severity,
        at: err.at,
        count: err.count,
        symptom: err.message,
        source: err.source,
        file: err.file,
        line: err.line,
        column: err.column,
        frames: err.frames.slice(0, 6),
        relationHits: breaks.filter((b) => {
          const a = normalizeFile(b.from);
          const bto = normalizeFile(b.to);
          return err.file && (a === err.file || bto === err.file);
        }).slice(0, 4),
        root
      });
    }
    // Relation-only breaks (no runtime error yet)
    for (const b of breaks.slice(0, 8)) {
      const id = makeId(["REL", b.from, b.to, b.status]);
      if (chains.some((c) => c.id === id)) continue;
      chains.push({
        id,
        severity: b.status === "MISMATCH" ? "HIGH" : "MEDIUM",
        at: now(),
        count: 1,
        symptom: `Relasi ${b.status}: ${normalizeFile(b.from) || "?"} → ${normalizeFile(b.to) || "?"}`,
        source: "SOURCE_SCAN",
        file: normalizeFile(b.from),
        line: null,
        column: null,
        frames: [],
        relationHits: [b],
        root: {
          kind: "RELASI_PUTUS",
          summary: `Scanner: ${b.status} antara ${normalizeFile(b.from)} dan ${normalizeFile(b.to)}`,
          from: b.from,
          to: b.to,
          status: b.status,
          key: b.key
        }
      });
    }
    state.chains = chains.slice(0, MAX_CHAIN);
    try { enrichChainsWithAbc(); } catch (_) {}
    state.summary = {
      total: state.errors.length,
      active: state.errors.filter((e) => e.severity === "CRITICAL" || e.severity === "HIGH").length,
      recovered: 0,
      relationBreaks: breaks.length,
      runtime: state.errors.filter((e) => e.source === "RUNTIME" || e.source === "REJECTION").length
    };
  }

  function ingestBcgoState(snap) {
    if (!snap || typeof snap !== "object") return;
    state.bcgo = snap;
    state.sourceScan = snap.sourceScan || state.sourceScan;

    if (snap.uiError) {
      pushError({
        source: "BCGO_UI",
        type: "uiError",
        message: snap.uiError,
        file: "bcgo.html"
      });
    }

    const organs = snap.systemOrgans || {};
    for (const [file, info] of Object.entries(organs)) {
      if (!info || (info.state !== "ACTIVE" && info.status !== "ANOMALY")) continue;
      pushError({
        source: "ORGAN",
        type: "anomaly",
        message: info.message || `Anomali organ ${file}`,
        file: normalizeFile(file),
        line: info.line ?? info.lineno ?? null,
        column: info.column ?? info.colno ?? null,
        rootHint: {
          kind: "ORGAN_ACTIVE",
          summary: `${file}: ${String(info.message || "anomali aktif").slice(0, 160)}`,
          from: file,
          line: info.line ?? null
        }
      });
    }

    const events = Array.isArray(snap.recentEvents) ? snap.recentEvents : [];
    for (const ev of events.slice(0, 12)) {
      if (!ev) continue;
      const t = String(ev.type || "");
      if (!/ERROR|FAIL|ANOMALY|UI_|REJECTION|AUTH.*FAIL/i.test(t) && !/error|gagal|fail/i.test(String(ev.message || ""))) continue;
      pushError({
        source: "NEURAL_EVENT",
        type: t || "event",
        message: ev.message || t,
        file: normalizeFile(ev.target) || normalizeFile(ev.source),
        at: ev.at || now()
      });
    }

    // Source scan relation breaks as structured errors
    if (state.sourceScan) {
      for (const b of relationBreaksFromScan(state.sourceScan).slice(0, 20)) {
        pushError({
          source: "SOURCE_SCAN",
          type: b.status,
          message: `${b.status}: ${normalizeFile(b.from) || "?"} → ${normalizeFile(b.to) || "?"}${b.key ? " · " + String(b.key).slice(0, 60) : ""}`,
          file: normalizeFile(b.from),
          rootHint: {
            kind: "RELASI_PUTUS",
            summary: `Tidak terhubung: ${normalizeFile(b.from)} → ${normalizeFile(b.to)} (${b.status})`,
            from: b.from,
            to: b.to,
            status: b.status,
            key: b.key
          }
        });
      }
    }

    rebuildChains();
    notify();
  }

  function installTraps() {
    if (trapsInstalled) return;
    trapsInstalled = true;

    const prevOnError = global.onerror;
    if (typeof global.addEventListener !== "function") return;
    global.addEventListener("error", function (ev) {
      try {
        const frames = parseStack(ev.error && ev.error.stack);
        pushError({
          source: "RUNTIME",
          type: "error",
          message: ev.message || (ev.error && ev.error.message) || "window.error",
          file: normalizeFile(ev.filename) || (frames[0] && frames[0].file),
          path: ev.filename || null,
          line: ev.lineno ?? (frames[0] && frames[0].line),
          column: ev.colno ?? (frames[0] && frames[0].column),
          frames
        });
        rebuildChains();
        notify();
      } catch (_) {}
      if (typeof prevOnError === "function") try { prevOnError.apply(global, arguments); } catch (_) {}
    }, true);

    global.addEventListener("unhandledrejection", function (ev) {
      try {
        const reason = ev.reason;
        const msg = reason && (reason.message || String(reason)) || "Unhandled rejection";
        const frames = parseStack(reason && reason.stack);
        pushError({
          source: "REJECTION",
          type: "unhandledrejection",
          message: msg,
          file: frames[0] && frames[0].file,
          line: frames[0] && frames[0].line,
          column: frames[0] && frames[0].column,
          frames
        });
        rebuildChains();
        notify();
      } catch (_) {}
    });

    try {
      channel = new BroadcastChannel("CIKUR_GO_BCGO_STATE_V1");
      channel.onmessage = function (ev) {
        const d = ev && ev.data;
        if (d && typeof d === "object") ingestBcgoState(d.state || d);
      };
    } catch (_) {}
  }

  function tick() {
    state.lastTick = now();
    try {
      if (global.BCGO_STATE) ingestBcgoState(global.BCGO_STATE);
    } catch (_) {}
    // Mirror lintas-tab dari BCGO (BroadcastChannel bisa terlewat; localStorage cadangan)
    try {
      if (typeof global.localStorage !== "undefined") {
        const raw = global.localStorage.getItem("CIKUR_GO_BCGO_STATE_V1");
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object") ingestBcgoState(parsed.state || parsed);
        }
      }
    } catch (_) {}
    try {
      if (global.CGO_OTAK && typeof global.CGO_OTAK.snapshot === "function") {
        const sn = global.CGO_OTAK.snapshot();
        if (sn && sn.abc && sn.abc.status && /ERROR|FAIL|CONTRADICTION/i.test(String(sn.abc.status))) {
          pushError({
            source: "MESIN_ABC",
            type: String(sn.abc.status),
            message: "Mesin ABC: " + sn.abc.status + (sn.abc.audit ? " · audit " + sn.abc.audit : ""),
            file: "cgo-machine-abc.js"
          });
          rebuildChains();
        }
      }
    } catch (_) {}
    notify();
  }

  function notify() {
    const snap = snapshot();
    for (const fn of [...listeners]) {
      try { fn(snap); } catch (_) {}
    }
    try {
      if (typeof global.dispatchEvent === "function") {
        global.dispatchEvent(new CustomEvent("cgo:error-dashboard", { detail: snap }));
      }
    } catch (_) {}
  }

  function snapshot() {
    return {
      version: VERSION,
      at: now(),
      summary: { ...state.summary },
      errors: state.errors.slice(0, MAX_ERRORS),
      chains: state.chains.slice(0, MAX_CHAIN),
      sourceScan: state.sourceScan
        ? {
            status: state.sourceScan.status,
            message: state.sourceScan.message,
            relationSummary: state.sourceScan.relationSummary || null,
            filesScanned: state.sourceScan.filesScanned,
            totalFiles: state.sourceScan.totalFiles
          }
        : null,
      bcgoCycle: state.bcgo ? (state.bcgo.cycle != null ? state.bcgo.cycle : (state.bcgo.cycleNo != null ? state.bcgo.cycleNo : null)) : null,
      bcgoMode: state.bcgo && state.bcgo.cycleMode || null,
      abcReady: !!(global.CGOMachineABCBridge || global.CGOMachineABC)
    };
  }

  function start(intervalMs) {
    installTraps();
    tick();
    if (pollTimer) clearInterval(pollTimer);
    try { if (pollTimer) clearInterval(pollTimer); } catch (_e) {}
    pollTimer = setInterval(tick, Math.max(800, intervalMs || 1500));
    return API;
  }

  function stop() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    try { if (channel) channel.close(); } catch (_) {}
    return API;
  }

  const API = {
    version: VERSION,
    start,
    stop,
    tick,
    snapshot,
    getErrors: () => state.errors.slice(),
    getChains: () => state.chains.slice(),
    ingestBcgoState,
    subscribe(fn) {
      if (typeof fn !== "function") return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    clear() {
      state.errors = [];
      state.chains = [];
      rebuildChains();
      notify();
    }
  };

  global.CGOErrorDashboard = API;
  global.CGO_ERROR_DASHBOARD = API;
  try { console.log("[CGO-ERROR-DASHBOARD] Siap ·", VERSION); } catch (_) {}
})(typeof globalThis !== "undefined" ? globalThis : window);
