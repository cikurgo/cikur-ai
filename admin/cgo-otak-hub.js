/**
 * CGO OTAK HUB — satu Otak Jenius untuk seluruh modul CGO
 * Tahap 2: menyatukan BCGO Engine · Otak Internal · Mesin ABC (+ bridge/cognition) · CIKURGO
 * di atas SATU state bersama (window.CGO_OTAK) dan SATU jalur tanya-jawab (CGO_OTAK.ask).
 *
 * Prinsip:
 *  - Aditif: tidak menghapus/menimpa modul lama. Bila hub tidak ada, halaman memakai jalur lama.
 *  - Zero network, zero API eksternal.
 *  - Tidak membuat bukti baru: hanya meneruskan/merangkum hasil modul yang sudah ada.
 *
 * API global: window.CGO_OTAK
 *   status()            → daftar modul + kesiapan
 *   snapshot()          → state bersama ringkas (ABC + Internal + BCGO + memori)
 *   ask(text, ctx)      → satu jalur: BCGO → Mesin ABC → Otak Internal → memori bersama
 *   recall(n)           → percakapan terakhir dari memori bersama
 *   subscribe(fn)       → dengarkan perubahan state; mengembalikan fungsi unsubscribe
 */
(function (global) {
  "use strict";

  if (global.__CGO_OTAK_HUB__) return; // satu hub saja, aman bila dimuat ulang
  global.__CGO_OTAK_HUB__ = true;

  const VERSION = "1.0.0-OTAK-HUB";
  const MEM_MAX = 20;
  const STAMP_MS = 1500;

  const state = {
    abc: null,        // ringkasan hasil Mesin ABC terbaru
    abcLive: null,    // status jalur LIVE BCGO → ABC
    internal: null,   // ringkasan Otak Internal terbaru
    memory: [],       // memori percakapan bersama
    lastTrace: null,  // jejak jawaban terakhir
    updatedAt: 0
  };
  const listeners = new Set();
  let lastSignature = "";

  /* ---------------- Registri modul Otak ---------------- */
  const CIKURGO_REASONING = [
    "nalar", "putuskan", "deteksi_pola", "ingat", "lupakan", "konteks_sekarang",
    "sarankan_lanjutan", "jelaskan", "nilai_kualitas", "cipta_ide",
    "usul_tindakan", "susun_rencana", "silangkan_ide", "jelajahi_alternatif"
  ];
  // Yang benar-benar terhubung ke alur jawaban bersama (sisanya tersedia, output generik):
  const CIKURGO_WIRED = ["nalar", "ingat", "konteks_sekarang", "angkaKeKata", "urai"];

  const MODULES = [
    {
      id: "BCGO_ENGINE", label: "BCGO Engine", role: "Siklus saraf & telemetry", required: true,
      probe() { const b = global.BCGOBrain; return b ? { ready: typeof b.ask === "function", version: b.version || null } : null; }
    },
    {
      id: "INTERNAL_BRAIN", label: "Otak Internal", role: "Investigasi & bukti", required: true,
      probe() {
        const b = global.CGOInternalBrain;
        return b ? { ready: typeof b.reasonChat === "function", version: b.version || null,
          detail: { menerimaABC: typeof b.ingestMachineAbc === "function", chatAnswer: typeof b.chatAnswer === "function" } } : null;
      }
    },
    {
      id: "MESIN_ABC", label: "Mesin ABC", role: "Pipeline A→B→C→D", required: true,
      probe() { const e = global.CGOMachineABC || global.CGO_MACHINE_ABC; return e ? { ready: typeof e.process === "function", version: e.version || null } : null; }
    },
    {
      id: "ABC_BRIDGE", label: "Bridge ABC", role: "BCGO_STATE → ABC", required: true,
      probe() { const b = global.CGOMachineABCBridge; return b ? { ready: typeof b.ingestBCGOState === "function", version: b.version || null } : null; }
    },
    {
      id: "ABC_COGNITION", label: "Kognisi ABC", role: "Lapis formal untuk Otak", required: false,
      probe() { const c = global.CGOAbcCognition; return c ? { ready: !!(c.isReady && c.isReady()), version: c.version || null } : null; }
    },
    {
      id: "OTAK_CIKURGO", label: "CIKURGO (Otak Jenius)", role: "Nalar · memori · angka→kata", required: true,
      probe() {
        const c = global.CIKURGO; if (!c) return null;
        const have = CIKURGO_REASONING.filter(k => typeof c[k] === "function");
        return { ready: typeof c.nalar === "function", version: c.version || c.VERSION || null,
          detail: { fungsiPenalaran: have.length + "/" + CIKURGO_REASONING.length, terhubung: CIKURGO_WIRED.filter(k => typeof c[k] === "function").join(",") } };
      }
    },
    {
      id: "SEMANTIC", label: "Semantic Bridge", role: "Makna (embedding)", required: false,
      probe() { const s = global.CGOSemantic; return s ? { ready: true, version: s.version || null } : null; }
    },
    {
      id: "OPERATOR_VOICE", label: "CGO Operator", role: "Suara & persona", required: false,
      probe() { const v = global.CGOOperatorVoice; return v ? { ready: typeof v.speakAnswer === "function", version: v.version || null } : null; }
    }
  ];

  function status() {
    const mods = MODULES.map(m => {
      let p = null;
      try { p = m.probe(); } catch (_) { p = null; }
      return {
        id: m.id, label: m.label, role: m.role, required: m.required,
        loaded: !!p, ready: !!(p && p.ready), version: (p && p.version) || null, detail: (p && p.detail) || null
      };
    });
    const req = mods.filter(m => m.required);
    return {
      version: VERSION,
      modules: mods,
      ready: mods.filter(m => m.ready).length,
      total: mods.length,
      requiredReady: req.filter(m => m.ready).length,
      requiredTotal: req.length,
      unified: req.every(m => m.ready)
    };
  }

  /* ---------------- State bersama ---------------- */
  function pctOrNull(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

  function summarizeAbcPacket(packet) {
    const r = packet && (packet.result || packet.finalResult) || null;
    if (!r) return null;
    return {
      status: r.status ?? null,
      confidence: pctOrNull(r.decision && r.decision.confidence),
      findingsCount: Array.isArray(r.findings) ? r.findings.length : 0,
      audit: (packet.audit && packet.audit.status) || null,
      at: Date.now()
    };
  }

  function internalClaims() {
    // Klaim dari Otak Internal untuk diaudit Mesin ABC — hanya bila ada kasus aktif dengan blocker.
    // Pada kondisi bersih hasilnya kosong, sehingga perilaku ABC lama tidak berubah.
    const i = state.internal;
    if (!i || i.signal !== "LIVE_TELEMETRY" || !(i.blockers > 0)) return [];
    return [{
      source: "CGO_INTERNAL_BRAIN",
      target: i.target || "activeCase",
      status: "REVIEW",
      severity: "MEDIUM",
      message: "Otak Internal: klasifikasi " + (i.classification || "?") + ", " + i.blockers + " blocker bukti belum terpenuhi",
      evidence: { signal: i.signal, guardianLevel: i.guardianLevel || null, blockers: i.blockerList || [] }
    }];
  }

  function bcgoView() {
    const s = global.BCGO_STATE;
    if (!s || typeof s !== "object") return null;
    return {
      cycle: Number(s.cycle || 0),
      cycleMode: s.cycleMode || null,
      connection: (s.connection && s.connection.status) || null,
      activeCases: Array.isArray(s.activeCases) ? s.activeCases.length : 0,
      sourceScan: (s.sourceScan && s.sourceScan.status) || null
    };
  }

  function snapshot() {
    const st = status();
    return {
      version: VERSION,
      modulesReady: st.ready,
      modulesTotal: st.total,
      unified: st.unified,
      bcgo: bcgoView(),
      abc: state.abc ? { status: state.abc.status, confidence: state.abc.confidence, audit: state.abc.audit, findingsCount: state.abc.findingsCount, at: state.abc.at } : null,
      abcLive: state.abcLive,
      internal: state.internal ? { signal: state.internal.signal, classification: state.internal.classification, guardianLevel: state.internal.guardianLevel, blockers: state.internal.blockers } : null,
      memoryTurns: state.memory.length,
      lastTrace: state.lastTrace,
      claims: internalClaims(),
      updatedAt: state.updatedAt
    };
  }

  function stamp() {
    // BCGO_STATE menjadi satu sumber kebenaran: ikut memuat ringkasan Otak (bukan hanya lastAbcStatus).
    try {
      const s = global.BCGO_STATE;
      if (s && typeof s === "object" && !Object.isFrozen(s)) s.otak = snapshot();
    } catch (_) {}
  }

  function notify() {
    state.updatedAt = Date.now();
    stamp();
    const snap = snapshot();
    const sig = JSON.stringify({ ...snap, updatedAt: 0, bcgo: snap.bcgo && { ...snap.bcgo, cycle: 0 } });
    if (sig === lastSignature) return;
    lastSignature = sig;
    try {
      if (typeof global.dispatchEvent === "function" && typeof global.CustomEvent === "function") {
        global.dispatchEvent(new global.CustomEvent("cgo:otak-state", { detail: snap }));
      }
    } catch (_) {}
    for (const fn of [...listeners]) { try { fn(snap); } catch (_) {} }
  }

  function deliverAbcToInternal() {
    try {
      const ib = global.CGOInternalBrain;
      if (state.abc && ib && typeof ib.ingestMachineAbc === "function" && !state.abc.delivered) {
        ib.ingestMachineAbc({ ...state.abc, mode: state.abcLive && state.abcLive.mode });
        state.abc.delivered = true;
      }
    } catch (_) {}
  }

  /* ---------------- Sambungan antar otak (event) ---------------- */
  function onAbcPacket(packet) {
    const sum = summarizeAbcPacket(packet);
    if (!sum) return;
    state.abc = { ...sum, delivered: false };
    deliverAbcToInternal();   // Mesin ABC → Otak Internal
    notify();
  }

  function onAbcLive(link) {
    if (!link || typeof link !== "object") return;
    state.abcLive = { mode: link.mode || null, status: link.status || null, audit: link.audit || null, claimCount: link.claimCount ?? null, revision: link.revision ?? null };
    // Event paket mentah datang sebelum audit D terpasang; lengkapi dari link LIVE lalu kirim ulang ke Otak Internal.
    if (state.abc && link.audit) { state.abc.audit = link.audit; state.abc.delivered = false; deliverAbcToInternal(); }
    notify();
  }

  function onInternalState(detail) {
    if (!detail || typeof detail !== "object") return;
    if (detail.source === "CGO_MACHINE_ABC") return; // event yang sama juga dipakai bridge ABC; abaikan
    const r = detail.reasoning || {};
    const gate = r.precisionGate || {};
    const blockers = Array.isArray(gate.blockers) ? gate.blockers : [];
    const ev0 = Array.isArray(r.evidence) && r.evidence[0] ? r.evidence[0] : null;
    state.internal = {
      signal: detail.signal || null,
      classification: r.classification || null,
      guardianLevel: (detail.guardian && detail.guardian.level) || null,
      blockers: blockers.length,
      blockerList: blockers.slice(0, 6),
      target: (ev0 && ev0.source) || null,
      at: Date.now()
    };
    notify();
  }

  if (typeof global.addEventListener === "function") {
    global.addEventListener("cgo:machine-abc", e => { try { onAbcPacket(e.detail); } catch (_) {} });
    global.addEventListener("cgo:machine-abc-bcgo-sync", e => { try { onAbcLive(e.detail); } catch (_) {} });
    global.addEventListener("cikur-internal-ai-state", e => { try { onInternalState(e.detail); } catch (_) {} });
  }
  // Modul yang dimuat belakangan (mis. Otak Internal via import dinamis): kirim ulang & tempel state berkala.
  const timer = (typeof setInterval === "function") ? setInterval(() => { deliverAbcToInternal(); notify(); }, STAMP_MS) : null;
  if (timer && typeof timer.unref === "function") timer.unref();

  /* ---------------- Memori percakapan bersama ---------------- */
  function remember(q, a, sources) {
    const turn = { q: String(q).slice(0, 200), a: String(a || "").slice(0, 240), sources: sources || [], at: Date.now() };
    state.memory.push(turn);
    if (state.memory.length > MEM_MAX) state.memory.shift();
    try { const c = global.CIKURGO; if (c && typeof c.ingat === "function") c.ingat(turn.q, turn.a); } catch (_) {}
    return turn;
  }
  function recall(n) { return state.memory.slice(-(Number(n) || 5)); }

  /* ---------------- Satu jalur tanya-jawab ---------------- */
  const ABC_TRIGGER = /analisis|struktur|audit|verifikasi|bukti|mesin abc|pipeline|self-?test/i;
  const RECALL_TRIGGER = /^(tadi|sebelumnya|barusan)\b|kita bahas apa|topik terakhir|apa yang tadi/i;
  const WEAK_ANSWER = /belum punya bukti|belum bisa/i;

  async function ask(text, ctx) {
    ctx = ctx || {};
    const t = String(text || "").trim();
    const trace = [];
    const step = (module, ok, note) => trace.push({ module, ok: !!ok, note: note || null });
    let answer = null;
    let abc = null;

    if (!t) return { ok: false, answer: null, trace, error: "EMPTY_QUESTION" };

    // 0) Memori bersama: rujukan ke percakapan sebelumnya
    if (RECALL_TRIGGER.test(t) && state.memory.length) {
      const last = state.memory.slice(-3).map(x => "“" + x.q + "”").join(", ");
      answer = "Yang terakhir kita bahas: " + last + ".";
      step("MEMORI_BERSAMA", true, state.memory.length + " percakapan");
    }

    // 1) BCGO Engine — jawaban berbasis telemetry/scanner/radar
    if (!answer) {
      const brain = global.BCGOBrain;
      if (brain && typeof brain.ask === "function") {
        try { answer = await Promise.resolve(brain.ask(t)); step("BCGO_ENGINE", !!answer); }
        catch (e) { step("BCGO_ENGINE", false, String((e && e.message) || e)); }
      } else step("BCGO_ENGINE", false, "belum termuat");
    }

    // 2) Mesin ABC — bukti formal (hanya untuk permintaan analisis/audit, sama seperti perilaku lama)
    if (ABC_TRIGGER.test(t)) {
      try {
        const bridge = global.CGOMachineABCBridge;
        if (bridge && typeof bridge.analyze === "function") {
          const r = bridge.analyze(t, { maxCycles: 1 });
          if (r && r.ok) {
            abc = r;
            const conf = r.confidence != null ? Math.round(Number(r.confidence) * 100) + "%" : "–";
            const line = "[Mesin ABC " + r.version + "] status " + (r.status || "–") + " · keyakinan " + conf +
              " · temuan " + (r.findings || []).length + " · audit " + ((r.audit && r.audit.status) || "–");
            answer = answer ? String(answer) + "\n\n" + line : line;
            step("MESIN_ABC", true, r.status || null);
          } else step("MESIN_ABC", false, (r && (r.error || r.message)) || "tidak ok");
        } else step("MESIN_ABC", false, "bridge belum termuat");
      } catch (e) { step("MESIN_ABC", false, String((e && e.message) || e)); }
    }

    // 3) Otak Internal — pendalaman bila jawaban kosong/lemah; selalu diberi state live terbaru
    const internal = global.CGOInternalBrain;
    if (internal) {
      try {
        if (ctx.liveState && typeof internal.ingestBCGOState === "function") internal.ingestBCGOState(ctx.liveState);
        if (!answer || WEAK_ANSWER.test(String(answer))) {
          let deep = null;
          if (typeof internal.chatAnswer === "function") deep = await Promise.resolve(internal.chatAnswer(t));
          if (!deep && typeof internal.reasonChat === "function") { const r = internal.reasonChat({ text: t }, {}); if (r && r.handled) deep = r.text; }
          if (deep && String(deep).trim()) { answer = String(deep).trim(); step("INTERNAL_BRAIN", true, "pendalaman bukti"); }
          else step("INTERNAL_BRAIN", false, "tidak ada bukti internal");
        } else step("INTERNAL_BRAIN", true, "disinkron");
      } catch (e) { step("INTERNAL_BRAIN", false, String((e && e.message) || e)); }
    } else step("INTERNAL_BRAIN", false, "belum termuat");

    // 4) Bersihkan label dual-brain lama (satu suara)
    if (answer) {
      try { answer = String(answer).replace(/\n\n\[Otak Jenius\]\s*/g, "\n\n").replace(/Rekomendasi Otak:\s*/g, "Rekomendasi: "); } catch (_) {}
    }

    // 5) Memori bersama + CIKURGO.ingat
    if (answer) { remember(t, answer, trace.filter(x => x.ok).map(x => x.module)); step("OTAK_CIKURGO", true, "memori tercatat"); }

    state.lastTrace = trace.filter(x => x.ok).map(x => x.module).join(" → ") || "—";
    notify();
    return { ok: !!answer, answer: answer || null, trace, abc, sources: trace.filter(x => x.ok).map(x => x.module) };
  }

  const API = Object.freeze({
    version: VERSION,
    status, snapshot, ask, recall,
    subscribe(fn) { if (typeof fn !== "function") return () => {}; listeners.add(fn); return () => listeners.delete(fn); },
    refresh: notify
  });

  global.CGO_OTAK = API;
  notify();
  try { console.log("[CGO-OTAK-HUB] Siap ·", VERSION, "·", status().ready + "/" + status().total, "modul"); } catch (_) {}
})(typeof globalThis !== "undefined" ? globalThis : window);
