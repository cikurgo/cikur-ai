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

    // 0a) CIKURGO langsung — hitungan, ejaan, emoji, warna, tanggal, uang, multi-bahasa
    // (bukan status sistem; Otak Jenius menjawab natural tanpa jargon BCGO)
    try {
      const CG = global.CIKURGO;
      if (CG) {
        const ql = t.toLowerCase();
        let direct = null;

        // Normalisasi input bila ada
        let norm = t;
        try { if (typeof CG.normalisasiInput === "function") norm = CG.normalisasiInput(t) || t; } catch (_) {}

        // Angka → kata / sebutkan angka
        const numMatch = t.match(/(?:berapa|sebutkan|ucapkan|bilang|ubah|jadiin|jadikan)?\s*(?:angka\s*)?(\d+(?:[.,]\d+)?)\s*(?:dalam\s+kata|dibaca|ke\s*kata|jadi\s*kata|huruf)?/i)
          || t.match(/^\s*(\d{1,18}(?:[.,]\d+)?)\s*$/);
        if (!direct && numMatch && typeof CG.angkaKeKata === "function") {
          try {
            const n = String(numMatch[1]).replace(/,/g, ".");
            const kata = CG.angkaKeKata(n, "id");
            if (kata) direct = "Angka " + n + " dibaca: " + kata + ".";
          } catch (_) {}
        }

        // Uang
        if (!direct && /rupiah|rp\.?\s*\d|uang\s*\d/i.test(t) && typeof CG.uangKeKata === "function") {
          try {
            const um = t.match(/(\d[\d.,]*)/);
            if (um) {
              const uk = CG.uangKeKata(um[1], "id");
              if (uk) direct = uk;
            }
          } catch (_) {}
        }

        // Eja huruf / kode
        if (!direct && /\b(eja|ejaan|spell)\b/i.test(t)) {
          try {
            const em = t.match(/\b(?:eja|ejaan|spell)\s+(.+)/i);
            const target = em ? em[1].trim() : "";
            if (target && typeof CG.ejaKarakter === "function") {
              direct = CG.ejaKarakter(target, "id") || (typeof CG.ejaKode === "function" ? CG.ejaKode(target) : null);
            }
          } catch (_) {}
        }

        // Emoji
        if (!direct && (/emoji|arti\s*😊|😊|😂|🔥|💡|🙏/.test(t) || /\p{Extended_Pictographic}/u.test(t)) && typeof CG.lafalEmoji === "function") {
          try {
            const em = t.match(/(\p{Extended_Pictographic}+)/u);
            if (em) direct = CG.lafalEmoji(em[1], "id") || ("Emoji itu saya baca sebagai isyarat visual: " + em[1]);
            else if (/arti\s+emoji|emoji\s+apa/i.test(t)) direct = "Kirim emoji-nya, nanti saya bacakan artinya dalam kata.";
          } catch (_) {}
        }

        // Warna
        if (!direct && /\b(warna|color)\b/i.test(t) && typeof CG.lafalWarna === "function") {
          try {
            const wm = t.match(/#?[0-9a-fA-F]{3,8}|\brgb\b|\b(merah|biru|hijau|kuning|hitam|putih|ungu|oranye)\b/i);
            if (wm) direct = CG.lafalWarna(wm[0], "id");
          } catch (_) {}
        }

        // Tanggal / waktu
        if (!direct && /\b(tanggal|hari\s+ini|jam\s*\d)/i.test(t)) {
          try {
            if (typeof CG.tanggalKeKata === "function" && /tanggal|hari\s+ini/i.test(t)) {
              direct = CG.tanggalKeKata(new Date(), "id");
            } else if (typeof CG.waktuKeKata === "function") {
              const jm = t.match(/(\d{1,2}[:.]\d{2})/);
              if (jm) direct = CG.waktuKeKata(jm[1], "id");
            }
          } catch (_) {}
        }

        // Bahasa didukung
        if (!direct && /bahasa\s*(apa|yang\s*didukung|tersedia)|multi\s*bahasa|daftar\s*bahasa/i.test(t) && typeof CG.daftarBahasa === "function") {
          try {
            const list = CG.daftarBahasa();
            const arr = Array.isArray(list) ? list : (list && list.bahasa) || [];
            direct = arr.length
              ? ("Otak Jenius mendukung " + arr.length + " pola bahasa. Contoh: " + arr.slice(0, 8).join(", ") + ".")
              : "Otak Jenius mendukung multi-bahasa untuk angka, tanggal, dan ejaan. Mode utama: Indonesia.";
          } catch (_) {}
        }

        // Urai bebas (kalimat umum yang bukan status sistem)
        if (!direct && typeof CG.urai === "function" && !/status|sistem|scanner|radar|anomali|organ|bcgo|firestore|file\s+\w+\.\w+/i.test(t) && t.length < 120) {
          try {
            const u = CG.urai(norm, "auto", "id");
            const ringkas = u && (u.ringkas || u.teks || u.hasil || (typeof u === "string" ? u : null));
            // Hanya pakai urai jika hasilnya bermakna (bukan echo)
            if (ringkas && String(ringkas).trim().length > 8 && String(ringkas).toLowerCase() !== ql) {
              // skip — biar jalur sistem/chat bukti yang handle; urai terlalu generik bisa "ngaco"
            }
          } catch (_) {}
        }

        if (direct && String(direct).trim()) {
          answer = String(direct).trim();
          step("OTAK_CIKURGO", true, "jawaban langsung");
        }
      }
    } catch (_) {}

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

    // 4) Satu suara operator — natural, bersih, pakai Otak Jenius
    if (answer) {
      try {
        answer = String(answer)
          .replace(/\n\n\[Otak Jenius\]\s*/g, "\n\n")
          .replace(/Rekomendasi Otak:\s*/g, "Rekomendasi: ")
          .replace(/\[CGO Internal\]\s*/gi, "")
          .replace(/\[Mesin ABC[^\]]*\]/g, function (s) { return s.replace(/\[/g, "").replace(/\]/g, ""); });
      } catch (_) {}

      try {
        const CG = global.CIKURGO;
        if (CG) {
          // Angka teknis → kata (termasuk di bukti BCGO)
          if (typeof CG.angkaKeKata === "function") {
            answer = String(answer)
              .replace(/\b(\d{1,3})\s*%/g, function (_, d) {
                try { return CG.angkaKeKata(Number(d), "id") + " persen"; } catch (_) { return d + " persen"; }
              })
              .replace(/\bcycle\s*#?\s*(\d+)\b/gi, function (_, d) {
                try { return "siklus ke-" + CG.angkaKeKata(Number(d), "id"); } catch (_) { return "siklus ke-" + d; }
              })
              .replace(/\b(\d+)\s+anomali\b/gi, function (_, d) {
                try { return CG.angkaKeKata(Number(d), "id") + " anomali"; } catch (_) { return d + " anomali"; }
              })
              .replace(/\b(\d+)\s+organ\b/gi, function (_, d) {
                try { return CG.angkaKeKata(Number(d), "id") + " organ"; } catch (_) { return d + " organ"; }
              });
          }

          // Rapikan gaya bicara operator (hindari robotik)
          answer = String(answer)
            .replace(/\bUNKNOWN\b/g, "belum diketahui")
            .replace(/\bNULL\b/g, "kosong")
            .replace(/\btrue\b/gi, "ya")
            .replace(/\bfalse\b/gi, "tidak")
            .replace(/\s{2,}/g, " ")
            .trim();

          // Nalar singkat hanya jika jawaban masih terlalu teknis / pendek bukti
          if (typeof CG.nalar === "function" && answer.length > 20 && answer.length < 500) {
            try {
              const n = CG.nalar(
                "Ubah menjadi jawaban operator wanita yang natural, sopan, singkat dalam bahasa Indonesia. Jangan menambah fakta baru. Pertanyaan: " + t + ". Bukti: " + answer.slice(0, 360),
                { bahasa: "id" }
              );
              const hint = n && (n.ringkas || n.kesimpulan || n.hasil || n.alasan || (typeof n === "string" ? n : null));
              if (hint && String(hint).trim().length > 15) {
                const h = String(hint).trim().slice(0, 280);
                // Pakai nalar sebagai pembuka natural bila bukti masih kaku
                if (/\b(status|anomaly|telemetry|organ|scanner|firestore)\b/i.test(answer) && h.length > 20) {
                  answer = h;
                } else if (answer.indexOf(h.slice(0, 30)) < 0 && h.length < answer.length) {
                  // jangan timpa bukti panjang; sisipkan hanya jika membantu
                }
              }
              step("OTAK_CIKURGO", true, "naturalisasi");
            } catch (_) {}
          }

          // Putuskan jika diminta saran
          if (typeof CG.putuskan === "function" && /rekomendasi|saran|apa yang (harus|perlu)|putusan|keputusan/.test(t.toLowerCase())) {
            try {
              const p = CG.putuskan("Dari bukti sistem: " + String(answer).slice(0, 280) + " — beri rekomendasi singkat aman untuk operator.", { bahasa: "id" });
              const put = p && (p.putusan || p.keputusan || p.hasil || p.rekomendasi || (typeof p === "string" ? p : null));
              if (put && String(put).trim()) {
                answer = String(answer).trim() + " Rekomendasi: " + String(put).trim().slice(0, 180);
                step("OTAK_CIKURGO", true, "putuskan");
              }
            } catch (_) {}
          }
        }
      } catch (_) {}
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
