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

  const VERSION = "1.3.0-UNIFIED-BRAIN-PIPELINE";
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
  const CIKURGO_WIRED = ["nalar", "ingat", "konteks_sekarang", "angkaKeKata", "urai", "putuskan", "jelaskan", "nilai_kualitas", "deteksi_pola", "sarankan_lanjutan", "daftarBahasa"];

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
      probe() {
        const s = global.CGOSemantic;
        if (!s) return null;
        const st = typeof s.getStatus === "function" ? s.getStatus() : null;
        const ready = st ? !!st.ready : (typeof s.isReady === "function" ? !!s.isReady() : false);
        return { ready: ready, version: (st && st.version) || s.version || null, note: st && st.status ? st.status : null };
      }
    },
    {
      id: "INSTRUCTION", label: "Konstitusi CGO", role: "Intent · dialog · kontrak jawaban", required: false,
      probe() {
        const i = global.CGOInstruction;
        return i ? { ready: typeof i.classifyIntent === "function", version: (i.VERSION || (i.getInstructionVersion && i.getInstructionVersion().VERSION) || null) } : null;
      }
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
  const SYSTEM_TRIGGER = /cgo|bcgo|cikur go|sistem|file|berkas|kode|source|dependency|dependensi|relasi|hubungan|telemetry|anomaly|anomali|investigasi|root cause|error|bug|status sistem|perbaiki|perbaikan|patch|radar|machine abc|mesin abc/i;
  const RECALL_TRIGGER = /^(tadi|sebelumnya|barusan)\b|kita bahas apa|topik terakhir|apa yang tadi/i;
  const WEAK_ANSWER = /belum punya bukti|belum bisa/i;

  
  
  // Sesi percakapan bersama (instruction + memori)
  let convSession = { topic: null, turn: 0, mood: null, style: null, files: [], primaryFile: null };

  async function ask(text, ctx) {
    ctx = ctx || {};
    const t = String(text || "").trim();
    const trace = [];
    const step = (module, ok, note) => trace.push({ module: module, ok: !!ok, note: note || null });
    let answer = null;
    let abc = null;

    if (!t) return { ok: false, answer: null, trace: trace, error: "EMPTY_QUESTION" };

    const CG = global.CIKURGO;
    const Inst = global.CGOInstruction;
    const live = ctx.liveState || global.BCGO_STATE || {};

    // ─── A. Konstitusi percakapan (cgo-instruction) ───
    let intent = null;
    try {
      if (Inst && typeof Inst.classifyIntent === "function") {
        intent = Inst.classifyIntent(t, convSession);
        if (typeof Inst.updateConversationState === "function") {
          convSession = Inst.updateConversationState(convSession, t, intent, {});
        }
        step("INSTRUCTION", true, (intent && (intent.topic || intent.mode)) || "classified");
      } else step("INSTRUCTION", false, "belum termuat");
    } catch (e) {
      step("INSTRUCTION", false, String((e && e.message) || e));
    }

    const topic = intent && intent.topic ? intent.topic : null;
    const mode = intent && intent.mode ? intent.mode : null;
    const systemRequest = SYSTEM_TRIGGER.test(t) || !!(intent && (intent.technicalSignal || intent.statusQuestion || intent.explicitAction));
    const convOnly = !systemRequest;

    
    // ─── B. Otak Jenius: multi-bahasa · multi-hitung · multi-emoji · multi-fungsi ───
    let audit = null;
    let spoken = null;
    let tokens = [];

    // Deteksi bahasa target dari pesan (default id)
    let lang = "id";
    try {
      const lm = t.match(/\b(?:bahasa|in|in\s+language|lang(?:uage)?)\s*[:=]?\s*(id|en|es|fr|de|pt|ar|ja)\b/i)
        || t.match(/\b(in\s+english|dalam\s+bahasa\s+inggris)\b/i)
        || t.match(/\b(dalam\s+bahasa\s+)?(indonesia|inggris|spanyol|perancis|jerman|portugis|arab|jepang)\b/i);
      if (lm) {
        const raw = (lm[1] || lm[2] || "").toLowerCase();
        const map = { indonesia: "id", inggris: "en", english: "en", spanyol: "es", perancis: "fr", jerman: "de", portugis: "pt", arab: "ar", jepang: "ja" };
        lang = map[raw] || (["id","en","es","fr","de","pt","ar","ja"].indexOf(raw) >= 0 ? raw : "id");
      }
    } catch (_) {}

    try {
      if (CG && typeof CG.urai === "function") {
        // Signature: urai(teks, mode, bahasa, audit)
        const u = CG.urai(t, "auto", lang, true);
        if (u && typeof u === "object") {
          audit = u;
          spoken = u.teks_hasil || u.teks || null;
          tokens = u.token || u.tokens || [];
        } else if (typeof u === "string") {
          spoken = u;
        }
        step("OTAK_CIKURGO", true, "urai:" + lang);
      }
    } catch (e) {
      step("OTAK_CIKURGO", false, String((e && e.message) || e));
    }

    let nalarAlasan = [];
    try {
      if (CG && typeof CG.nalar === "function") {
        const n = CG.nalar(t, { bahasa: lang });
        if (n && Array.isArray(n.alasan)) nalarAlasan = n.alasan.filter(Boolean);
        step("OTAK_CIKURGO", true, "nalar");
      }
    } catch (_) {}

    let polaNote = null;
    try {
      if (CG && typeof CG.deteksi_pola === "function") {
        const p = CG.deteksi_pola(t);
        if (p && Array.isArray(p.rekomendasi) && p.rekomendasi.length) {
          polaNote = p.rekomendasi.slice(0, 2).join("; ");
        }
        step("OTAK_CIKURGO", true, "deteksi_pola");
      }
    } catch (_) {}

    const jenis = {};
    for (const tok of tokens) {
      const j = tok && tok.jenis;
      if (j && j !== "spasi" && j !== "kata") jenis[j] = (jenis[j] || 0) + 1;
    }

    // Deteksi multi-fungsi lewat regex (tidak bergantung token urai saja)
    const emojiRe = /\p{Extended_Pictographic}/u;
    const hasEmoji = emojiRe.test(t) || !!jenis.emoji;
    const hasNumInText = /\d/.test(t);
    const hasWarna = /#(?:[0-9a-fA-F]{3,8})\b|\brgb\s*\([^)]+\)/i.test(t) || !!jenis.hex_warna || !!jenis.rgb_warna;
    const hasRomawi = /\b[IVXLCDMivxlcdm]{2,}\b/.test(t) || !!jenis.romawi;
    const wantHitung = /\b(hitung|jumlah|berapa|tambah|kurang|kali|bagi|plus|minus)\b/i.test(t)
      || /^\s*[\d\s+\-*/().,]+(=|\s*=\s*)?\s*$/.test(t);
    const wantEja = /\b(eja|ejaan|spell|spelling)\b/i.test(t);
    const wantUang = /\b(rupiah|dollar|euro|yen|rp\.?|usd|eur|idr)\b/i.test(t);
    const wantWaktu = /\b(jam|pukul|waktu|durasi|menit|detik|jam\s*\d)/i.test(t);
    const wantTanggal = /\b(tanggal|tgl|hari\s+ini)\b/i.test(t) || /\b\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}\b/.test(t);
    const wantBaca = /\b(baca|bacakan|ucapkan|lafal|jadi\s*kata|ke\s*kata|dibaca)\b/i.test(t);
    const wantBahasaList = /\b(daftar\s*bahasa|bahasa\s*apa|multi\s*bahasa|language\s*list)\b/i.test(t);

    const linguistic = hasNumInText || hasEmoji || hasWarna || hasRomawi || wantHitung || wantEja
      || wantUang || wantWaktu || wantTanggal || wantBaca || wantBahasaList
      || jenis.angka || jenis.desimal || jenis.emoji;

    function pickLafal(val) {
      if (val == null) return null;
      if (Array.isArray(val)) return val[0] != null ? String(val[0]) : null;
      if (typeof val === "object" && val.lafal) return String(val.lafal);
      return String(val);
    }

    if (linguistic && CG && !systemRequest) {
      const parts = [];

      // 1) Hasil urai penuh (multi-token natural)
      if (spoken && String(spoken).trim() && String(spoken).trim() !== t) {
        parts.push(String(spoken).trim());
      }

      // 2) Multi-hitung / angka → kata (multi-bahasa)
      if ((hasNumInText || wantHitung || jenis.angka || jenis.desimal) && typeof CG.angkaKeKata === "function") {
        const nums = t.match(/\d+(?:[.,]\d+)?/g) || [];
        for (const n of nums.slice(0, 6)) {
          try {
            const k = CG.angkaKeKata(String(n).replace(",", "."), lang);
            if (k) parts.push(n + " → " + k + (lang !== "id" ? " (" + lang + ")" : ""));
          } catch (_) {}
        }
        // ekspresi sederhana a+b / a-b
        const expr = t.match(/(\d+(?:[.,]\d+)?)\s*([+\-*/x×])\s*(\d+(?:[.,]\d+)?)/);
        if (expr) {
          try {
            const a = parseFloat(expr[1].replace(",", "."));
            const b = parseFloat(expr[3].replace(",", "."));
            const op = expr[2];
            let r = null;
            if (op === "+") r = a + b;
            else if (op === "-") r = a - b;
            else if (op === "*" || op === "x" || op === "×") r = a * b;
            else if (op === "/" && b !== 0) r = a / b;
            if (r != null && !isNaN(r)) {
              const rk = CG.angkaKeKata(String(Math.round(r * 1000) / 1000), lang);
              parts.push("Hasil hitung: " + r + (rk ? " (" + rk + ")" : ""));
            }
          } catch (_) {}
        }
      }

      // 3) Multi-emoji
      if (hasEmoji && typeof CG.lafalEmoji === "function") {
        const em = t.match(/\p{Extended_Pictographic}+/gu) || [];
        for (const e of em.slice(0, 8)) {
          try {
            const L = pickLafal(CG.lafalEmoji(e, lang));
            if (L) parts.push(e + " → " + L);
          } catch (_) {}
        }
      }

      // 4) Multi-warna
      if (hasWarna && typeof CG.lafalWarna === "function") {
        const wm = t.match(/#(?:[0-9a-fA-F]{3,8})\b|\brgb\s*\([^)]+\)/gi) || [];
        for (const w of wm.slice(0, 4)) {
          try {
            const L = pickLafal(CG.lafalWarna(w, lang));
            if (L) parts.push(w + " → " + L);
          } catch (_) {}
        }
      }

      // 5) Romawi
      if (hasRomawi && typeof CG.romawiKeKata === "function") {
        const rms = t.match(/\b[IVXLCDMivxlcdm]{2,}\b/g) || [];
        for (const r of rms.slice(0, 4)) {
          try {
            const L = CG.romawiKeKata(r, lang) || (CG.romawiKeAngka && CG.angkaKeKata(String(CG.romawiKeAngka(r)), lang));
            if (L) parts.push(r + " → " + L);
          } catch (_) {}
        }
      }

      // 6) Ejaan
      if (wantEja) {
        const m = t.match(/\b(?:eja|ejaan|spell|spelling)\s+(.+)/i);
        const target = m ? m[1].trim() : "";
        if (target) {
          try {
            if (typeof CG.ejaKode === "function") {
              const L = CG.ejaKode(target, lang);
              if (L) parts.push("Ejaan: " + L);
            } else if (typeof CG.ejaKarakter === "function") {
              const chars = [...target].map(function (c) {
                try { return CG.ejaKarakter(c, lang); } catch (_) { return c; }
              });
              parts.push("Ejaan: " + chars.join(" "));
            }
          } catch (_) {}
        }
      }

      // 7) Uang
      if (wantUang && typeof CG.uangKeKata === "function") {
        const um = t.match(/(\d+(?:[.,]\d+)?)/);
        if (um) {
          try {
            const cur = /usd|dollar/i.test(t) ? "USD" : (/eur|euro/i.test(t) ? "EUR" : "IDR");
            const L = CG.uangKeKata(um[1].replace(",", "."), cur, lang);
            if (L) parts.push(L);
          } catch (_) {}
        }
      }

      // 8) Waktu / durasi
      if (wantWaktu) {
        try {
          if (typeof CG.waktuKeKata === "function") {
            const jm = t.match(/\b(\d{1,2})[:.](\d{2})\b/);
            if (jm) {
              const L = CG.waktuKeKata(jm[1] + ":" + jm[2], lang);
              if (L) parts.push(L);
            }
          }
          if (typeof CG.durasiKeKata === "function") {
            const dm = t.match(/\b(\d+)\s*(detik|menit|jam|hari)\b/i);
            if (dm) {
              const L = CG.durasiKeKata(dm[0], lang);
              if (L) parts.push(L);
            }
          }
        } catch (_) {}
      }

      // 9) Tanggal
      if (wantTanggal && typeof CG.tanggalKeKata === "function") {
        try {
          const tm = t.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/);
          if (tm) {
            const L = CG.tanggalKeKata(tm[0], lang);
            if (L) parts.push(L);
          }
        } catch (_) {}
      }

      // 10) Daftar multi-bahasa
      if (wantBahasaList && typeof CG.daftarBahasa === "function") {
        try {
          const list = CG.daftarBahasa();
          if (Array.isArray(list) && list.length) {
            parts.push("Bahasa didukung Otak: " + list.join(", "));
          }
        } catch (_) {}
      }

      if (polaNote) parts.push(polaNote);

      // Dedup & compose
      const seen = {};
      const uniq = [];
      for (const p of parts) {
        const k = String(p).trim();
        if (!k || seen[k]) continue;
        seen[k] = 1;
        uniq.push(k);
      }
      if (uniq.length) {
        answer = uniq.join(". ");
        if (!answer.endsWith(".")) answer += ".";
        step("OTAK_CIKURGO", true, "multi:" + lang);
      }
    }

// C2. Percakapan / sapaan / identitas / kapabilitas — susun dari konstitusi + state live
    if (!answer && convOnly && intent) {
      const stepName = live.step || "siaga";
      const cycle = live.cycle != null ? live.cycle : "—";
      const active = (live.metrics && live.metrics.active) || 0;
      if (intent.greeting || topic === "GREETING") {
        answer = "Halo. Saya CGO, lapisan kecerdasan internal CIKUR GO. Sekarang saya di tahap " +
          stepName + ", siklus " + cycle + (active ? (", memantau " + active + " anomali") : ", tanpa anomali aktif") +
          ". Silakan ngobrol atau minta saya mengurai angka, emoji, file, maupun status sistem.";
      } else if (intent.identity || topic === "IDENTITY") {
        answer = "Saya CGO — kecerdasan internal CIKUR GO. BCGO adalah lingkungan operasi live; saya menafsirkan, menalar, dan menjawab dari bukti di sana. Satu identitas, mode bisa berganti.";
      } else if (intent.capability || topic === "CAPABILITY") {
        answer = "Saya bisa mengurai teks campuran (angka, emoji, warna, multi-bahasa), menalar pola, menyusun ide/rencana, mengingat percakapan, membaca status/scanner/radar BCGO, dan meminta Mesin ABC mengaudit bukti. Tanya saja apa yang dibutuhkan.";
      } else if (intent.gratitude || topic === "THANKS") {
        answer = "Sama-sama. Saya tetap di sini memantau saraf sistem.";
      } else if (intent.farewell || topic === "FAREWELL") {
        answer = "Sampai jumpa. Panggil saya kapan saja.";
      } else if (intent.currentActivity || topic === "CURRENT_ACTIVITY") {
        answer = "Saya sedang di tahap " + stepName + ", siklus " + cycle + ". " +
          (live.message ? String(live.message).slice(0, 160) : "Memantau telemetry dan source scan.");
      } else if (intent.justChatting || topic === "CASUAL_CHAT") {
        answer = "Boleh. Saya siap ngobrol. Kalau nanti butuh cek sistem atau mengurai angka/emoji, langsung saja.";
      } else if (intent.systemRole || topic === "CGO_BCGO_ROLE") {
        answer = "BCGO = pusat saraf dan state live. CGO = kecerdasan yang membaca state itu, menalar, dan menjawab. Keduanya satu sistem, peran berbeda.";
      } else if (intent.emotionalBoundary || topic === "EMOTION_BOUNDARY") {
        answer = "Saya tidak punya perasaan seperti manusia. Saya bisa mengenali nada bicara Anda dan menyesuaikan jawaban agar lebih nyaman, tanpa mengarang emosi.";
      } else if (intent.contextualFollowUp || intent.contextualWhy) {
        // biarkan jatuh ke BCGO / memori
      } else {
        // percakapan umum: pakai cipta_ide / sarankan bila cocok
        try {
          if (CG && typeof CG.cipta_ide === "function" && /\b(ide|gagasan|usul)\b/i.test(t)) {
            const ideas = CG.cipta_ide(t, 3, {});
            const list = ideas && (ideas.ide || ideas.hasil || ideas.ideas);
            if (Array.isArray(list) && list.length) {
              answer = "Beberapa arah ide: " + list.slice(0, 3).map(function (x) {
                return typeof x === "string" ? x : (x.teks || x.ide || JSON.stringify(x));
              }).join("; ") + ".";
              step("OTAK_CIKURGO", true, "cipta_ide");
            }
          }
        } catch (_) {}
      }
      if (answer) step("INSTRUCTION", true, topic || mode || "conversation");
    }

    // C3. Memori / referensi "yang tadi"
    if (!answer && RECALL_TRIGGER.test(t) && state.memory.length) {
      const last = state.memory.slice(-3).map(function (x) { return "“" + x.q + "”"; }).join(", ");
      answer = "Yang terakhir kita bahas: " + last + ".";
      step("MEMORI_BERSAMA", true, String(state.memory.length));
    }

    // C4. Rencana / putusan (Otak kognitif)
    if (!answer && CG && /\b(rencana|susun\s*langkah|buat\s*rencana)\b/i.test(t) && typeof CG.susun_rencana === "function") {
      try {
        const r = CG.susun_rencana(t, {});
        const langkah = r && (r.langkah || r.steps);
        if (Array.isArray(langkah) && langkah.length) {
          answer = "Rencana: " + langkah.slice(0, 5).map(function (L, i) {
            return (L.urutan || (i + 1)) + ") " + (L.aksi || L.step || L);
          }).join(" ");
          step("OTAK_CIKURGO", true, "susun_rencana");
        }
      } catch (_) {}
    }

    if (!answer && CG && /\b(rekomendasi|putusan|pilih|keputusan|saran\s*terbaik)\b/i.test(t) && typeof CG.putuskan === "function") {
      try {
        const opsi = ["Pantau telemetri", "Periksa scanner source", "Fokus file anomali", "Tunggu siklus berikutnya"];
        const p = CG.putuskan(t, opsi, { live: live });
        const put = p && (p.putusan || p.pilihan || p.hasil || p.rekomendasi);
        if (put) {
          answer = "Putusan Otak: " + put + (p.alasan && p.alasan[0] ? " — " + p.alasan[0] : "");
          step("OTAK_CIKURGO", true, "putuskan");
        }
      } catch (_) {}
    }

    // ─── D–F. SATU PIPELINE OTAK SISTEM ───
    // Urutan kontrak: LIVE STATE → ABC → INTERNAL REASONING → BCGO FACTS → MEMORY.
    // Tidak ada modul yang menjadi fallback diam-diam. Masing-masing menyumbang
    // data/penalaran ke trace yang sama dan hasil yang sudah ada tidak ditimpa.
    if (systemRequest) {
      const brain = global.BCGOBrain;
      const internal = global.CGOInternalBrain;
      let bcgoAnswer = null;
      let internalAnswer = null;

      // 1) Sinkronkan snapshot hidup ke Otak Internal sebelum penalaran.
      try {
        if (internal && typeof internal.ingestBCGOState === "function") {
          internal.ingestBCGOState(live);
          step("STATE_SYNC", true, "BCGO_STATE→INTERNAL_BRAIN");
        } else if (internal) {
          step("STATE_SYNC", false, "liveState belum tersedia");
        }
      } catch (e) {
        step("STATE_SYNC", false, String((e && e.message) || e));
      }

      // 2) Mesin ABC menjadi validator formal untuk permintaan sistem.
      // Hanya jalur sistem yang masuk ABC; chat biasa tetap ringan.
      if (ABC_TRIGGER.test(t) || systemRequest) {
        try {
          const bridge = global.CGOMachineABCBridge;
          if (bridge && typeof bridge.analyze === "function") {
            const r = bridge.analyze(t, { maxCycles: 1 });
            if (r && r.ok) {
              abc = r;
              const conf = r.confidence != null ? Math.round(Number(r.confidence) * 100) + "%" : "–";
              const line = "Mesin ABC: status " + (r.status || "–") + ", keyakinan " + conf +
                ", temuan " + ((r.findings || []).length) + ", audit " + ((r.audit && r.audit.status) || "–") + ".";
              step("MESIN_ABC", true, r.status || null);
              if (internal && typeof internal.ingestMachineAbc === "function") {
                try {
                  internal.ingestMachineAbc({
                    status: r.status ?? null,
                    confidence: r.confidence ?? null,
                    audit: r.audit?.status || r.audit || null,
                    findingsCount: Array.isArray(r.findings) ? r.findings.length : 0,
                    mode: r.mode || "CHAT_SYSTEM",
                    at: Date.now()
                  });
                  step("ABC_TO_INTERNAL", true, "formal-summary");
                } catch (e) {
                  step("ABC_TO_INTERNAL", false, String((e && e.message) || e));
                }
              }
            } else {
              step("MESIN_ABC", false, (r && (r.error || r.message)) || "tidak ok");
            }
          } else {
            step("MESIN_ABC", false, "bridge belum termuat");
          }
        } catch (e) {
          step("MESIN_ABC", false, String((e && e.message) || e));
        }
      }

      // 3) Internal Brain menjadi pengolah utama bukti, bukan fallback.
      try {
        if (internal && typeof internal.reasonChat === "function") {
          const r = internal.reasonChat({ text: t, analysis: { systemRequest, machineAbc: abc ? {
            ok: true, status: abc.status, confidence: abc.confidence,
            audit: abc.audit?.status || abc.audit || null
          } : null } }, { liveState: live, machineAbc: abc });
          if (r && r.handled && r.text) internalAnswer = String(r.text).trim();
          if (internalAnswer) step("INTERNAL_BRAIN", true, "evidence+reasoning");
          else step("INTERNAL_BRAIN", false, "tidak menghasilkan jawaban");
        } else {
          step("INTERNAL_BRAIN", false, "belum termuat");
        }
      } catch (e) {
        step("INTERNAL_BRAIN", false, String((e && e.message) || e));
      }

      // 4) BCGO tetap sumber fakta live. Ambil sebagai evidence provider,
      // bukan sebagai pengganti hasil penalaran Internal Brain.
      try {
        if (brain && typeof brain.ask === "function") {
          const r = await Promise.resolve(brain.ask(t));
          if (r && String(r).trim()) {
            bcgoAnswer = String(r).trim();
            step("BCGO_ENGINE", true, "live-facts");
          } else {
            step("BCGO_ENGINE", false, "kosong");
          }
        } else {
          step("BCGO_ENGINE", false, "belum termuat");
        }
      } catch (e) {
        step("BCGO_ENGINE", false, String((e && e.message) || e));
      }

      // 5) Compose sekali. Internal reasoning tetap utama; fakta BCGO ditambahkan
      // hanya bila berbeda agar tidak menggandakan jawaban.
      const pieces = [];
      if (internalAnswer) pieces.push(internalAnswer);
      if (bcgoAnswer && bcgoAnswer !== internalAnswer &&
          !String(internalAnswer || "").includes(bcgoAnswer) &&
          !bcgoAnswer.includes(String(internalAnswer || ""))) {
        pieces.push("Fakta BCGO: " + bcgoAnswer);
      }
      if (pieces.length) answer = pieces.join("\n\n");
      else if (abc) {
        const conf = abc.confidence != null ? Math.round(Number(abc.confidence) * 100) + "%" : "–";
        answer = "Mesin ABC: status " + (abc.status || "–") + ", keyakinan " + conf +
          ", temuan " + ((abc.findings || []).length) + ", audit " + ((abc.audit && abc.audit.status) || "–") + ".";
      }
    }

    // 6) Satu memori bersama: simpan hasil akhir juga ke Memory internal bila tersedia.
    if (answer && systemRequest) {
      try {
        const internal = global.CGOInternalBrain;
        const rt = internal && typeof internal.getRuntime === "function" ? internal.getRuntime() : null;
        if (rt && typeof rt.remember === "function") {
          rt.remember({
            type: "CHAT_TURN",
            question: t.slice(0, 500),
            answer: String(answer).slice(0, 1200),
            modules: trace.filter(x => x.ok).map(x => x.module),
            abc: abc ? { status: abc.status ?? null, confidence: abc.confidence ?? null } : null,
            at: new Date().toISOString()
          });
          step("INTERNAL_MEMORY", true, "CHAT_TURN");
        }
      } catch (e) {
        step("INTERNAL_MEMORY", false, String((e && e.message) || e));
      }
    }

    // ─── G. Jelaskan audit urai bila diminta ───
    if (CG && audit && /\b(jelaskan|uraikan|kenapa\s+bisa)\b/i.test(t) && typeof CG.jelaskan === "function") {
      try {
        const j = CG.jelaskan(audit);
        const langkah = j && (j.langkah || j.steps);
        if (Array.isArray(langkah) && langkah.length) {
          const extra = langkah.slice(0, 4).join(" · ");
          answer = (answer ? answer + " " : "") + "Rincian urai: " + extra;
          step("OTAK_CIKURGO", true, "jelaskan");
        }
      } catch (_) {}
    }

    // ─── H. Polish + larangan label klasifikasi ───
    if (answer) {
      answer = String(answer)
        .replace(/\n\n\[Otak Jenius\]\s*/g, "\n\n")
        .replace(/Rekomendasi Otak:\s*/g, "Rekomendasi: ")
        .replace(/\[CGO Internal\]\s*/gi, "")
        .replace(/\bUNKNOWN\b/g, "belum diketahui")
        .replace(/\bNULL\b/g, "kosong")
        .replace(/\s{2,}/g, " ")
        .trim();
      if (/^teks\s+(campuran|biasa)/i.test(answer) || /^teks campuran:/i.test(answer)) {
        answer = spoken && spoken !== t
          ? ("Hasil urai Otak: " + spoken + ".")
          : "Saya sudah menalar input itu, tetapi butuh pertanyaan yang lebih spesifik agar jawaban lebih berguna.";
      }
      if (CG && typeof CG.angkaKeKata === "function") {
        answer = String(answer)
          .replace(/\b(\d{1,3})\s*%/g, function (_, d) {
            try { return CG.angkaKeKata(Number(d), "id") + " persen"; } catch (_) { return d + " persen"; }
          })
          .replace(/\bcycle\s*#?\s*(\d+)\b/gi, function (_, d) {
            try { return "siklus ke-" + CG.angkaKeKata(Number(d), "id"); } catch (_) { return "siklus ke-" + d; }
          })
          .replace(/\b(\d+)\s+anomali\b/gi, function (_, d) {
            try { return CG.angkaKeKata(Number(d), "id") + " anomali"; } catch (_) { return d + " anomali"; }
          });
      }
    }

    // ─── I. Fallback terbuka + saran lanjutan Otak ───
    if (!answer) {
      if (spoken && String(spoken).trim() && String(spoken).trim() !== t) {
        answer = "Hasil pengurai Otak: " + String(spoken).trim() + ".";
      } else {
        answer = "Saya menerima pesan Anda. Saya bisa mengurai angka/emoji/warna, membaca status BCGO, atau menalar pola — sampaikan saja kebutuhan Anda.";
      }
      try {
        if (CG && typeof CG.sarankan_lanjutan === "function") {
          const s = CG.sarankan_lanjutan();
          const ide = s && (s.ide || s.saran);
          if (Array.isArray(ide) && ide[0]) answer += " Saran: " + ide[0] + ".";
        }
      } catch (_) {}
      step("OTAK_CIKURGO", true, "fallback");
    }

    // Ingat
    if (answer) {
      remember(t, answer, trace.filter(function (x) { return x.ok; }).map(function (x) { return x.module; }));
      try { if (CG && typeof CG.ingat === "function") CG.ingat(t, answer); } catch (_) {}
    }

    state.lastTrace = trace.filter(function (x) { return x.ok; }).map(function (x) { return x.module; }).join(" → ") || "—";
    notify();
    return {
      ok: !!answer,
      answer: answer || null,
      trace: trace,
      abc: abc,
      intent: intent ? { topic: intent.topic, mode: intent.mode, behavior: intent.behavior } : null,
      sources: trace.filter(function (x) { return x.ok; }).map(function (x) { return x.module; })
    };
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
