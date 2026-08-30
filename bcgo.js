import {
  collection,
  onSnapshot,
  query,
  orderBy,
  limit,
  doc,
  getDoc
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { db, auth } from "./cikur-config.js";

/*
 * BCGO MASTER NERVE SYSTEM v2.7 — LOCAL CONTEXT BRAIN
 *
 * Prinsip:
 * - Firestore = sumber fakta real-time.
 * - Tidak memakai AI/API eksternal.
 * - Chat adalah reasoning lokal berbasis state telemetry yang sedang hidup.
 * - Error lintas-file hanya dianggap ACTIVE bila ada bukti telemetry yang valid.
 * - Tidak pernah menulis source code secara otomatis.
 * - Medicine hanya menerima konteks kasus; keputusan/perbaikan tetap terpisah.
 */

const ORGAN_REGISTRY = {
  "index.html": { type: "Halaman Utama", role: "customer" },
  "assistant.html": { type: "Zona Customer", role: "customer" },
  "food.html": { type: "Zona Customer", role: "customer" },
  "ride.html": { type: "Zona Customer", role: "customer" },
  "cikurgo2in1.html": { type: "Zona Customer", role: "customer" },
  "agentcgo.html": { type: "Zona Mitra", role: "mitra" },
  "resto.html": { type: "Zona Mitra", role: "restaurant" },
  "driver.html": { type: "Zona Mitra", role: "driver" },
  "cikur-config.js": { type: "Sistem Config", role: "system" },
  "bcgo-engine.js": { type: "Sistem Core", role: "system" },
  "bcgo-admin.html": { type: "Sistem Admin", role: "admin" },
  "bcgo.html": { type: "Sistem Monitor", role: "monitor" },
  "data-cgo.html": { type: "Data Sistem", role: "data" },
  "bcgo-medicine.js": { type: "Otak Medicine", role: "medicine" },
  "bcgo-medicine.html": { type: "UI Medicine", role: "medicine" }
};

const ACTIVE_WINDOW = 15 * 60 * 1000;
const CLOCK_SKEW = 5 * 60 * 1000;
const LOG_LIMIT = 50;
const PROBE_LIMIT = 5;
const EVENT_LIMIT = 24;
const CYCLE = { IN: 2200, PROCESS: 2200, REVIEW: 2200, OUT: 1800 };

const normalizeFile = value => {
  const raw = String(value || "").trim();
  if (!raw) return "UNKNOWN";
  const clean = raw.split("?")[0].split("#")[0];
  return clean.substring(clean.lastIndexOf("/") + 1) || raw;
};

export function runAutonomousEngine(onCycleUpdate) {
  if (typeof onCycleUpdate !== "function") {
    throw new TypeError("BCGO membutuhkan callback UI.");
  }

  let stopped = false;
  let authorized = false;
  let cycleNo = 0;
  let phaseIndex = -1;
  let cycleTimer = null;
  let refreshTimer = null;
  let unsubscribeAuth = null;
  let unsubscribeFirestore = null;
  let unsubscribeSystemLogs = null;
  let latestSystemLogs = [];
  let previousTopSignature = "";
  let realtimeBusy = false;

  const firestore = { connected: false, count: 0, error: null, lastServerAt: 0 };
  const state = {
    step: "IN",
    message: "Membangunkan Pusat Saraf Master...",
    targetCell: "SYS_MASTER_REGISTRY",
    errorLog: null,
    retryCount: 0,
    cycle: 0,
    cycleMode: "BOOT",
    metrics: { total: Object.keys(ORGAN_REGISTRY).length, active: 0, recovered: 0, healthy: Object.keys(ORGAN_REGISTRY).length, firestoreCount: 0 },
    systemOrgans: {},
    systemLogs: [],
    recentEvents: [],
    firestore: { ...firestore },
    lastEventAt: null,
    lastTelemetryFile: null,
    lastTelemetryAt: null,
    lastTelemetryMessage: null,
    activeCases: [],
    medicineQueue: [],
    connection: { status: "CONNECTING", lastServerAt: 0 }
  };

  function timestamp(value) {
    try {
      if (!value) return 0;
      if (typeof value.toMillis === "function") return value.toMillis();
      if (typeof value.toDate === "function") return value.toDate().getTime();
      if (value instanceof Date) return value.getTime();
      if (typeof value === "number") return value;
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : 0;
    } catch {
      return 0;
    }
  }

  function safeClone(value) {
    try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
  }

  function recordEvent(type, message, target = "SYSTEM") {
    state.recentEvents.unshift({ type, message, target, at: Date.now() });
    state.recentEvents = state.recentEvents.slice(0, EVENT_LIMIT);
    state.lastEventAt = Date.now();
  }

  function effectiveAge(t) {
    if (!t) return Infinity;
    return Math.max(0, Date.now() - t);
  }

  function isRecent(t) {
    // Timestamps sedikit di masa depan masih diterima agar perbedaan jam perangkat/server
    // tidak membuat error nyata berubah menjadi HEALTHY.
    return t > 0 && (t >= Date.now() - ACTIVE_WINDOW || t <= Date.now() + CLOCK_SKEW);
  }

  function newestLogByFile() {
    const map = new Map();
    for (const log of latestSystemLogs) {
      const file = normalizeFile(log?.fileName);
      if (!ORGAN_REGISTRY[file]) continue;
      const t = timestamp(log?.reportedAt);
      const candidate = { log, time: t };
      const previous = map.get(file);
      if (!previous || candidate.time >= previous.time) map.set(file, candidate);
    }
    return map;
  }

  function buildOrgans() {
    const recent = newestLogByFile();
    const organs = {};

    for (const [file, meta] of Object.entries(ORGAN_REGISTRY)) {
      const item = recent.get(file);
      const historical = latestSystemLogs.some(log => normalizeFile(log?.fileName) === file);

      if (item && isRecent(item.time)) {
        organs[file] = {
          ...meta,
          status: "ANOMALY",
          state: "ACTIVE",
          message: String(item.log?.message || "Sinyal error diterima.").slice(0, 700),
          reportedAt: item.log?.reportedAt || null,
          line: item.log?.line ?? item.log?.lineno ?? null,
          column: item.log?.column ?? item.log?.colno ?? null
        };
      } else if (historical) {
        organs[file] = {
          ...meta,
          status: "RECOVERED",
          state: "RECOVERED",
          message: "Tidak ada error aktif dalam window pemantauan; laporan sebelumnya masih tersimpan sebagai bukti historis."
        };
      } else {
        organs[file] = {
          ...meta,
          status: "HEALTHY",
          state: "HEALTHY",
          message: "Belum ada laporan error aktif dari file ini."
        };
      }
    }
    return organs;
  }

  function makeCases(organs) {
    return Object.entries(organs)
      .filter(([, info]) => info.state === "ACTIVE")
      .map(([file, info]) => {
        const t = timestamp(info.reportedAt) || Date.now();
        const fingerprint = `${file}|${info.message}|${t}`.replace(/\s+/g, " ");
        let hash = 0;
        for (let i = 0; i < fingerprint.length; i++) hash = ((hash << 5) - hash + fingerprint.charCodeAt(i)) | 0;
        const id = `CASE-${Math.abs(hash).toString(36).toUpperCase()}`;
        return {
          id,
          target: file,
          rootCandidate: file,
          severity: /security|permission|denied|failed|undefined|null/i.test(info.message) ? "HIGH" : "MEDIUM",
          confidence: 92,
          status: "TELEMETRY_CONFIRMED",
          evidence: {
            message: info.message,
            reportedAt: info.reportedAt,
            line: info.line,
            column: info.column
          }
        };
      });
  }

  function makeMetrics(organs) {
    const values = Object.values(organs);
    return {
      total: values.length,
      active: values.filter(v => v.state === "ACTIVE").length,
      recovered: values.filter(v => v.state === "RECOVERED").length,
      healthy: values.filter(v => v.state === "HEALTHY").length,
      logCount: latestSystemLogs.length,
      firestoreCount: firestore.count
    };
  }

  function deriveConnection() {
    if (firestore.error) return { status: "OFFLINE", lastServerAt: firestore.lastServerAt || 0 };
    if (firestore.connected) return { status: "LIVE", lastServerAt: firestore.lastServerAt || 0 };
    return { status: "CONNECTING", lastServerAt: firestore.lastServerAt || 0 };
  }

  function emit(step, message, target, error = null, options = {}) {
    if (stopped) return;
    const organs = buildOrgans();
    const metrics = makeMetrics(organs);
    const cases = makeCases(organs);

    state.step = step;
    state.message = String(message || "");
    state.targetCell = target || state.targetCell;
    state.errorLog = error ? String(error).slice(0, 900) : null;
    state.cycle = cycleNo;
    state.cycleMode = options.cycleMode || state.cycleMode || "NORMAL";
    state.systemOrgans = organs;
    state.systemLogs = latestSystemLogs.slice();
    state.metrics = metrics;
    state.firestore = { ...firestore };
    state.connection = deriveConnection();
    state.activeCases = cases;
    state.medicineQueue = cases.map(c => ({ ...c, handoff: "READY_FOR_MEDICINE" }));

    if (options.telemetry) {
      state.lastTelemetryFile = options.telemetry.file;
      state.lastTelemetryAt = options.telemetry.at || null;
      state.lastTelemetryMessage = options.telemetry.message || null;
    }

    window.BCGO_STATE = safeClone(state);
    onCycleUpdate(safeClone(state));
  }

  function situation() {
    const organs = buildOrgans();
    const active = Object.entries(organs).filter(([, v]) => v.state === "ACTIVE");
    if (firestore.error) return `Saya sedang menjaga koneksi Firestore. Sensor melaporkan: ${firestore.error}`;
    if (active.length) {
      const [file, info] = active[0];
      return `Saya menemukan ${active.length} anomali aktif. Fokus pertama saya ${file}: ${info.message}`;
    }
    const recovered = Object.values(organs).filter(v => v.state === "RECOVERED").length;
    return recovered
      ? `Tidak ada anomali aktif saat ini. ${recovered} organ masih memiliki bukti error historis yang saya tandai RECOVERED.`
      : `Semua ${Object.keys(ORGAN_REGISTRY).length} organ belum memiliki laporan error aktif dalam telemetry yang saya terima.`;
  }

  function findFile(question) {
    const q = String(question || "").toLowerCase();
    return Object.keys(ORGAN_REGISTRY).find(file => q.includes(file.toLowerCase())) || null;
  }

  // Memori percakapan lokal: hanya konteks singkat untuk membuat dialog natural.
  // Tidak dikirim ke layanan AI/API eksternal.
  const chatMemory = {
    history: [],
    lastIntent: null,
    lastFile: null,
    lastTarget: null,
    lastQuestion: null,
    lastAnswer: null
  };

  function rememberChat(role, text, meta = {}) {
    chatMemory.history.push({ role, text: String(text || ''), at: Date.now(), ...meta });
    chatMemory.history = chatMemory.history.slice(-12);
    if (meta.intent) chatMemory.lastIntent = meta.intent;
    if (meta.file) chatMemory.lastFile = meta.file;
    if (meta.target) chatMemory.lastTarget = meta.target;
    if (role === 'user') chatMemory.lastQuestion = String(text || '');
    if (role === 'bcgo') chatMemory.lastAnswer = String(text || '');
  }

  function resolveContextFile(raw, explicitFile) {
    if (explicitFile) return explicitFile;
    const q = String(raw || '').toLowerCase();
    const contextWords = /\b(ini|itu|dia|yang tadi|yang pertama|yang terakhir|masalah tadi|error tadi|file tadi|file itu|kasus tadi|kasus itu)\b/i;
    if (!contextWords.test(q)) return null;
    if (chatMemory.lastFile && ORGAN_REGISTRY[chatMemory.lastFile]) return chatMemory.lastFile;
    const previousUser = [...chatMemory.history].reverse().find(x => x.role === 'user');
    if (previousUser) return Object.keys(ORGAN_REGISTRY).find(f => previousUser.text.toLowerCase().includes(f.toLowerCase())) || null;
    return null;
  }

  function topActiveFile(active, raw) {
    const explicit = findFile(raw);
    const contextual = resolveContextFile(raw, explicit);
    if (contextual && active.some(([f]) => f === contextual)) return contextual;
    return active[0]?.[0] || null;
  }

  function formatActive(active, max = 4) {
    return active.slice(0, max).map(([file, info]) => `${file}: ${info.message}`).join(' | ');
  }

  function classifyIntent(raw) {
    const q = String(raw || '').toLowerCase().trim();
    if (!q) return 'EMPTY';
    if (/\b(scan|rescan|pindai|periksa)\b.*\b(ulang|lagi|kembali)?\b/.test(q) && /ulang|lagi|pindai|scan/.test(q)) return 'RESCAN';
    if (/\b(halo|hai|hello|selamat pagi|selamat siang|selamat sore|selamat malam)\b/.test(q) || /siapa kamu|kamu siapa/.test(q)) return 'GREETING';
    if (/sedang apa|lagi apa|sedang mengerjakan|ngapain|kerja apa/.test(q)) return 'ACTIVITY';
    if (/status|kondisi|sehat|aman|hidup|aktif/.test(q)) return 'STATUS';
    if (/ada (masalah|error|gangguan)|masalah|error|anomali|gangguan|rusak|bermasalah/.test(q)) return 'ANOMALY';
    if (/telemetry|impuls|laporan terakhir|error terakhir|terakhir/.test(q)) return 'TELEMETRY';
    if (/cycle|siklus|tahap|fase|posisi/.test(q)) return 'CYCLE';
    if (/berapa.*(file|organ)|organ apa|pantau apa|memantau apa|cakupan/.test(q)) return 'REGISTRY';
    if (/medicine|obat|pengobatan|perbaiki|perbaikan|repair|sembuhkan|healing|treatment/.test(q)) return 'MEDICINE';
    if (/kenapa|mengapa|penyebab|akar masalah|root cause/.test(q)) return 'WHY';
    if (/jelaskan|detail|rincian|bukti|evidence/.test(q)) return 'DETAIL';
    if (findFile(raw)) return 'FILE';
    return 'GENERAL';
  }

  function answerQuestion(question) {
    const raw = String(question || '').trim();
    const q = raw.toLowerCase();
    const organs = buildOrgans();
    const active = Object.entries(organs).filter(([, v]) => v.state === 'ACTIVE');
    const recovered = Object.entries(organs).filter(([, v]) => v.state === 'RECOVERED');
    const metrics = makeMetrics(organs);
    const file = findFile(raw);
    const intent = classifyIntent(raw);

    if (!q) return 'Saya siap. Tanyakan kondisi sistem, error, file tertentu, telemetry terakhir, siklus saya, atau perintah pemeriksaan.';

    rememberChat('user', raw, { intent, file: resolveContextFile(raw, file) || undefined });

    if (intent === 'RESCAN') {
      recordEvent('CHAT_COMMAND', 'Anda meminta pemeriksaan ulang telemetry.', 'SYS_CHAT_RESCAN');
      emit('IN', 'Saya menerima perintah pemeriksaan ulang. Saya membaca ulang bukti telemetry yang tersedia sekarang.', 'SYS_CHAT_RESCAN', null, { cycleMode: 'CHAT_COMMAND' });
      const answer = `Baik. Saya mulai pemeriksaan ulang berdasarkan telemetry yang benar-benar tersedia. Saat ini ${metrics.active} anomaly aktif dari ${metrics.total} organ.`;
      rememberChat('bcgo', answer);
      return answer;
    }

    if (intent === 'GREETING') {
      const answer = `Halo. Saya BCGO. Saya bekerja dari state dan telemetry yang sedang hidup, bukan tebakan. Sekarang cycle #${cycleNo}, tahap ${state.step}. ${situation()}`;
      rememberChat('bcgo', answer);
      return answer;
    }

    if (intent === 'ACTIVITY') {
      const focus = topActiveFile(active, raw);
      const answer = focus
        ? `Saat ini saya berada di tahap ${state.step}, cycle #${cycleNo}. ${state.message} Fokus yang sedang saya awasi adalah ${focus}. Bukti aktif: ${organs[focus].message}`
        : `Saat ini saya berada di tahap ${state.step}, cycle #${cycleNo}. ${state.message} Belum ada anomaly aktif yang bisa saya jadikan fokus.`;
      rememberChat('bcgo', answer, { file: focus || undefined });
      return answer;
    }

    if (intent === 'STATUS') {
      const answer = firestore.error
        ? `Saya belum bisa menyebut sistem aman. Sensor Firestore sedang melaporkan: ${firestore.error}`
        : `Status aktual: ${metrics.active} anomaly aktif, ${metrics.recovered} recovered, ${metrics.healthy} stabil dari ${metrics.total} organ. Firestore ${firestore.connected ? 'LIVE' : 'belum LIVE'} dengan ${metrics.firestoreCount} snapshot probe. ${active.length ? `Fokus pertama: ${active[0][0]}.` : 'Belum ada anomaly aktif.'}`;
      rememberChat('bcgo', answer);
      return answer;
    }

    if (intent === 'ANOMALY') {
      if (!active.length) {
        const answer = 'Saat ini saya tidak melihat anomaly aktif dari telemetry. Laporan lama tetap saya pertahankan sebagai RECOVERED bila memang punya riwayat bukti.';
        rememberChat('bcgo', answer);
        return answer;
      }
      const answer = `Ya, saya melihat ${active.length} anomaly aktif. ${formatActive(active)}. Saya belum menyebut semuanya sebagai root cause karena telemetry baru membuktikan gejala/error, bukan source penyebabnya.`;
      rememberChat('bcgo', answer, { file: active[0][0] });
      return answer;
    }

    if (intent === 'TELEMETRY') {
      if (!state.lastTelemetryFile || !state.lastTelemetryAt) {
        const answer = 'Belum ada telemetry terakhir yang bisa saya pastikan dari state saat ini.';
        rememberChat('bcgo', answer);
        return answer;
      }
      const age = effectiveAge(timestamp(state.lastTelemetryAt));
      const ageText = age < 1000 ? 'baru saja' : `${Math.round(age / 1000)} detik lalu`;
      const answer = `Telemetry terakhir yang saya catat berasal dari ${state.lastTelemetryFile}, ${ageText}. Pesannya: ${state.lastTelemetryMessage || '-'}`;
      rememberChat('bcgo', answer, { file: state.lastTelemetryFile });
      return answer;
    }

    if (intent === 'CYCLE') {
      const answer = `Saya sekarang berada di cycle #${cycleNo}, tahap ${state.step}, mode ${state.cycleMode}. Target saraf: ${state.targetCell}. ${state.message}`;
      rememberChat('bcgo', answer);
      return answer;
    }

    if (intent === 'REGISTRY') {
      const answer = `Saya mengenali ${metrics.total} organ dalam registry: ${Object.keys(ORGAN_REGISTRY).join(', ')}. Saat ini ${metrics.active} anomaly aktif, ${metrics.recovered} recovered, dan ${metrics.healthy} stabil.`;
      rememberChat('bcgo', answer);
      return answer;
    }

    if (intent === 'MEDICINE') {
      const focus = topActiveFile(active, raw);
      if (!focus) {
        const answer = 'Belum ada kasus aktif dengan bukti telemetry yang cukup untuk saya jadikan kandidat Medicine. Saya tidak akan membuat source perbaikan tanpa evidence.';
        rememberChat('bcgo', answer);
        return answer;
      }
      const info = organs[focus];
      const answer = `Saya menangkap permintaan terkait Medicine. Kandidat saat ini ${focus}, dengan bukti: ${info.message}. Ini baru TELEMETRY_CONFIRMED; root cause dan source exact tetap harus diverifikasi sebelum solusi BEFORE → AFTER dibuat.`;
      rememberChat('bcgo', answer, { file: focus, target: focus });
      return answer;
    }

    if (intent === 'WHY') {
      const focus = topActiveFile(active, raw);
      const answer = focus
        ? `Untuk ${focus}, telemetry yang saya miliki saat ini membuktikan ${organs[focus].message}. Itu belum cukup untuk menyatakan akar masalah. Saya perlu menelusuri dependency dan source exact sebelum menyebut root cause.`
        : `Saya belum punya file/kasus yang jelas dari pertanyaan ini. State saya sekarang: tahap ${state.step}, target ${state.targetCell}. Saya tidak akan menebak akar masalah.`;
      rememberChat('bcgo', answer, { file: focus || undefined });
      return answer;
    }

    if (intent === 'DETAIL') {
      const focus = topActiveFile(active, raw);
      const answer = focus
        ? `Bukti untuk ${focus}: ${organs[focus].message}. Status ${organs[focus].state}, reported ${formatTimeValue(organs[focus].reportedAt)}${organs[focus].line ? `, line ${organs[focus].line}` : ''}${organs[focus].column ? `, column ${organs[focus].column}` : ''}. Saya sengaja memisahkan bukti telemetry dari kesimpulan root cause.`
        : `Bukti saraf saat ini: ${metrics.active} anomaly aktif, ${metrics.recovered} recovered, Firestore ${firestore.connected ? 'LIVE' : 'belum LIVE'}, target ${state.targetCell}. Sebutkan file atau kasus bila ingin detail spesifik.`;
      rememberChat('bcgo', answer, { file: focus || undefined });
      return answer;
    }

    if (intent === 'FILE' && file) {
      const info = organs[file];
      const answer = info?.state === 'ACTIVE'
        ? `${file} sedang ANOMALY. Bukti telemetry: ${info.message}. Saya belum menyebut source penyebabnya tanpa verifikasi.`
        : info?.state === 'RECOVERED'
          ? `${file} berstatus RECOVERED. Ada bukti historis, tetapi tidak ada error aktif dalam window pemantauan.`
          : `${file} saat ini HEALTHY menurut telemetry yang saya terima. Artinya belum ada laporan error aktif; bukan jaminan source code sempurna.`;
      rememberChat('bcgo', answer, { file });
      return answer;
    }

    // Pertanyaan lanjutan yang menyebut "itu/yang tadi" tetapi tanpa nama file.
    const contextualFile = resolveContextFile(raw, file);
    if (contextualFile && organs[contextualFile]) {
      const info = organs[contextualFile];
      const answer = `Saya mengaitkan “itu” dengan ${contextualFile} dari konteks percakapan terakhir. Statusnya ${info.state}. Bukti yang saya pegang: ${info.message}`;
      rememberChat('bcgo', answer, { file: contextualFile });
      return answer;
    }

    const answer = `Saya menangkap pertanyaanmu: “${raw}”. Saya belum punya bukti yang cukup untuk menjawab lebih spesifik. Saya akan tetap menggunakan state, telemetry, dan konteks percakapan yang nyata; saya tidak akan mengarang jawaban.`;
    rememberChat('bcgo', answer);
    return answer;
  }

  function formatTimeValue(value) {
    const t = timestamp(value);
    return t ? new Date(t).toLocaleString('id-ID') : '-';
  }

  function interruptForTelemetry(fileName, message, log) {
    if (stopped || !authorized) return;
    const file = normalizeFile(fileName);
    const text = String(message || "Sinyal telemetry baru diterima.").slice(0, 900);
    const at = timestamp(log?.reportedAt) || Date.now();
    const signature = `${file}|${text}|${at}`;

    if (signature === previousTopSignature) return;
    previousTopSignature = signature;
    realtimeBusy = true;

    recordEvent("TELEMETRY", `Impuls baru dari ${file}.`, file);
    emit("PROCESS", `⚡ Saya menerima bukti baru dari ${file}. Saya hentikan sejenak siklus normal untuk memeriksanya.`, file, text, {
      cycleMode: "INTERRUPTED",
      telemetry: { file, at, message: text }
    });

    clearTimeout(cycleTimer);
    setTimeout(() => {
      if (stopped || !authorized) return;
      const organs = buildOrgans();
      const info = organs[file];
      const active = Object.entries(organs).filter(([, v]) => v.state === "ACTIVE");
      if (info?.state === "ACTIVE") {
        emit("REVIEW", `Bukti ${file} masih aktif. Saya mempertahankan kasus ini sebagai kandidat diagnosis dan menyiapkan konteks untuk Medicine.`, file, info.message, {
          cycleMode: "INTERRUPTED",
          telemetry: { file, at, message: text }
        });
      } else if (active.length) {
        emit("REVIEW", `Impuls ${file} sudah tidak aktif, tetapi ${active.length} anomali lain masih aktif. Saya lanjutkan REVIEW.`, active[0][0], active[0][1].message, { cycleMode: "INTERRUPTED" });
      } else {
        emit("REVIEW", `Saya sudah memeriksa impuls ${file}. Saat ini tidak ada anomali aktif yang bisa saya pastikan.`, file, null, { cycleMode: "INTERRUPTED" });
      }

      setTimeout(() => {
        if (stopped || !authorized) return;
        const activeNow = Object.entries(buildOrgans()).filter(([, v]) => v.state === "ACTIVE");
        emit("OUT", activeNow.length
          ? `Saya selesai menilai impuls ${file}. ${activeNow.length} kasus tetap berada dalam pengawasan.`
          : `Saya selesai menilai impuls ${file}. Pemantauan normal dilanjutkan.`, activeNow[0]?.[0] || file, activeNow[0]?.[1]?.message || null, { cycleMode: "NORMAL" });
        realtimeBusy = false;
        phaseIndex = 3;
        scheduleNext(CYCLE.OUT);
      }, CYCLE.REVIEW);
    }, CYCLE.PROCESS);
  }

  function startSystemLogs() {
    if (!window.CikurCloud?.listenSystemLogs) {
      emit("OUT", "Kanal telemetry system_logs belum tersedia dari CikurCloud. Saya tidak akan mengklaim pemantauan lintas-file aktif.", "SYS_TELEMETRY_UNAVAILABLE");
      return;
    }

    if (typeof unsubscribeSystemLogs === "function") unsubscribeSystemLogs();
    try {
      unsubscribeSystemLogs = window.CikurCloud.listenSystemLogs(logs => {
        latestSystemLogs = Array.isArray(logs) ? logs.slice(0, LOG_LIMIT) : [];
        const top = latestSystemLogs[0];
        const topAt = timestamp(top?.reportedAt);
        const previousTop = previousTopSignature;

        const organs = buildOrgans();
        state.systemOrgans = organs;
        state.metrics = makeMetrics(organs);
        state.activeCases = makeCases(organs);
        state.medicineQueue = state.activeCases.map(c => ({ ...c, handoff: "READY_FOR_MEDICINE" }));
        state.systemLogs = latestSystemLogs.slice();
        state.lastTelemetryFile = top ? normalizeFile(top.fileName) : state.lastTelemetryFile;
        state.lastTelemetryAt = topAt || state.lastTelemetryAt;
        state.lastTelemetryMessage = top?.message || state.lastTelemetryMessage;
        window.BCGO_STATE = safeClone(state);

        if (top && `${normalizeFile(top.fileName)}|${String(top.message || "")}|${topAt}` !== previousTop) {
          interruptForTelemetry(top.fileName, top.message, top);
        } else {
          onCycleUpdate(safeClone(state));
        }
      }, LOG_LIMIT);
    } catch (error) {
      emit("PROCESS", "Kanal telemetry lintas-file gagal dibuka.", "SYS_SYSTEM_LOGS_LISTENER", error?.message, { cycleMode: "ERROR" });
    }
  }

  function startFirestoreProbe() {
    if (typeof unsubscribeFirestore === "function") unsubscribeFirestore();
    try {
      const q = query(collection(db, "mitra_applications"), orderBy("submittedAt", "desc"), limit(PROBE_LIMIT));
      unsubscribeFirestore = onSnapshot(q, snapshot => {
        firestore.connected = true;
        firestore.count = snapshot.size;
        firestore.error = null;
        firestore.lastServerAt = Date.now();
        state.retryCount = 0;
        if (!realtimeBusy) {
          recordEvent("FIRESTORE", "Sensor Firestore aktif dan menerima snapshot baru.", "SYS_FIRESTORE_HEALTHY");
        }
        emit(state.step, state.message, "SYS_FIRESTORE_HEALTHY", null, { cycleMode: state.cycleMode });
      }, error => {
        firestore.connected = false;
        firestore.count = 0;
        firestore.error = error?.message || "Firestore listener error";
        recordEvent("FIRESTORE_ERROR", firestore.error, "SYS_FIRESTORE_CONNECTION");
        emit("PROCESS", "Sensor Firestore melaporkan gangguan. Saya mempertahankan status waspada dan tidak menyebut sistem sehat.", "SYS_FIRESTORE_CONNECTION", firestore.error, { cycleMode: "ERROR" });
      });
    } catch (error) {
      firestore.connected = false;
      firestore.error = error?.message || "Gagal membuat query Firestore";
      emit("PROCESS", "Saya gagal menyiapkan sensor Firestore.", "SYS_FIRESTORE_CONNECTION", firestore.error, { cycleMode: "ERROR" });
    }
  }

  function refreshState() {
    if (stopped || !authorized) return;
    const organs = buildOrgans();
    state.systemOrgans = organs;
    state.metrics = makeMetrics(organs);
    state.activeCases = makeCases(organs);
    state.medicineQueue = state.activeCases.map(c => ({ ...c, handoff: "READY_FOR_MEDICINE" }));
    state.systemLogs = latestSystemLogs.slice();
    state.firestore = { ...firestore };
    state.connection = deriveConnection();
    window.BCGO_STATE = safeClone(state);
    onCycleUpdate(safeClone(state));
  }

  function scheduleNext(delay) {
    clearTimeout(cycleTimer);
    cycleTimer = setTimeout(nextPhase, delay);
  }

  function nextPhase() {
    if (stopped || !authorized || realtimeBusy) return;
    phaseIndex = (phaseIndex + 1) % 4;

    if (phaseIndex === 0) {
      cycleNo += 1;
      recordEvent("CYCLE", `Neural cycle #${cycleNo} dimulai.`, "SYS_NEURAL_SCAN");
      emit("IN", `Neural cycle #${cycleNo} dimulai. Saya memindai ${Object.keys(ORGAN_REGISTRY).length} organ dan membaca bukti telemetry terbaru.`, "SYS_NEURAL_SCAN", null, { cycleMode: "NORMAL" });
      scheduleNext(CYCLE.IN);
      return;
    }

    if (phaseIndex === 1) {
      const active = Object.entries(buildOrgans()).filter(([, v]) => v.state === "ACTIVE");
      emit("PROCESS", active.length
        ? `Saya menemukan ${active.length} anomali aktif. Saya memproses bukti sebelum menyimpulkan akar masalah.`
        : `Tidak ada anomali aktif. Saya membandingkan ${latestSystemLogs.length} laporan telemetry dengan window pemantauan.`, active[0]?.[0] || "SYS_TELEMETRY_ANALYSIS", active[0]?.[1]?.message || null, { cycleMode: "NORMAL" });
      scheduleNext(CYCLE.PROCESS);
      return;
    }

    if (phaseIndex === 2) {
      const active = Object.entries(buildOrgans()).filter(([, v]) => v.state === "ACTIVE");
      emit("REVIEW", active.length
        ? `REVIEW: ${active.length} kasus aktif. Saya mempertahankan bukti dan menyiapkan konteks yang dapat diverifikasi Medicine.`
        : "REVIEW selesai. Tidak ada anomali aktif yang dapat saya pastikan dari telemetry saat ini.", active[0]?.[0] || "SYS_NEURAL_REVIEW", active[0]?.[1]?.message || null, { cycleMode: "NORMAL" });
      scheduleNext(CYCLE.REVIEW);
      return;
    }

    const active = Object.entries(buildOrgans()).filter(([, v]) => v.state === "ACTIVE");
    emit("OUT", active.length
      ? `Cycle #${cycleNo} selesai. ${active.length} anomali tetap aktif dan terus diawasi.`
      : `Cycle #${cycleNo} selesai. Pemantauan kembali normal dan telemetry tetap didengarkan.`, active[0]?.[0] || "SYS_NEURAL_SYNC", active[0]?.[1]?.message || null, { cycleMode: active.length ? "ALERT" : "NORMAL" });
    scheduleNext(CYCLE.OUT);
  }

  async function verifyAdmin(user) {
    if (!user) {
      authorized = false;
      clearTimeout(cycleTimer);
      clearInterval(refreshTimer);
      emit("OUT", "Sesi Admin belum tersedia. Silakan login sebagai Admin.", "SYS_AUTH_REQUIRED");
      return;
    }

    try {
      const snap = await getDoc(doc(db, "admin_users", user.uid));
      const data = snap.exists() ? snap.data() : null;
      if (data?.active !== true) {
        authorized = false;
        emit("OUT", "Akun ini bukan Admin aktif. Akses Pusat Saraf ditolak.", "SYS_AUTH_NOT_ADMIN");
        return;
      }
      if (authorized) return;

      authorized = true;
      recordEvent("AUTH", "Admin terverifikasi. Sensor real-time dibuka.", "SYS_AUTH_VERIFIED");
      emit("IN", "Admin terverifikasi. Saya membuka sensor telemetry dan Firestore real-time.", "SYS_AUTH_VERIFIED", null, { cycleMode: "BOOT" });
      startSystemLogs();
      startFirestoreProbe();
      refreshTimer = setInterval(refreshState, 15000);
      phaseIndex = -1;
      cycleNo = 0;
      nextPhase();
    } catch (error) {
      authorized = false;
      emit("OUT", "Saya gagal memverifikasi status Admin.", "SYS_AUTH_CHECK_FAILED", error?.message, { cycleMode: "ERROR" });
    }
  }

  // Error di halaman monitor sendiri: jangan mengklaim file lain rusak.
  window.addEventListener("error", event => {
    if (stopped) return;
    const source = normalizeFile(event?.filename || "bcgo.html");
    const message = event?.message || event?.error?.message || "JavaScript error tidak diketahui.";
    if (source === "bcgo.html" || source === "bcgo.js") {
      recordEvent("LOCAL_ERROR", `Error monitor: ${message}`, source);
      emit("PROCESS", `Saya menerima error lokal dari ${source}. Saya tandai sebagai bukti monitor, bukan sebagai error lintas-file.`, source, `[L:${event?.lineno || "?"} C:${event?.colno || "?"}] ${message}`, { cycleMode: "ERROR" });
    }
  });

  window.addEventListener("unhandledrejection", event => {
    if (stopped) return;
    const reason = event?.reason?.message || String(event?.reason || "Unhandled Promise rejection.");
    recordEvent("LOCAL_REJECTION", reason, "bcgo.html");
    emit("PROCESS", "Saya menerima Promise rejection lokal pada monitor.", "bcgo.html", reason, { cycleMode: "ERROR" });
  });

  const brain = {
    ask: answerQuestion,
    getState: () => {
      const organs = buildOrgans();
      state.systemOrgans = organs;
      state.metrics = makeMetrics(organs);
      state.activeCases = makeCases(organs);
      state.medicineQueue = state.activeCases.map(c => ({ ...c, handoff: "READY_FOR_MEDICINE" }));
      return safeClone(state);
    },
    getSituation: situation,
    getRegistry: () => ({ ...ORGAN_REGISTRY }),
    getConversation: () => safeClone(chatMemory.history),
    getChatContext: () => safeClone({
      lastIntent: chatMemory.lastIntent,
      lastFile: chatMemory.lastFile,
      lastTarget: chatMemory.lastTarget,
      lastQuestion: chatMemory.lastQuestion
    }),
    stop() {
      stopped = true;
      clearTimeout(cycleTimer);
      clearInterval(refreshTimer);
      if (typeof unsubscribeAuth === "function") unsubscribeAuth();
      if (typeof unsubscribeFirestore === "function") unsubscribeFirestore();
      if (typeof unsubscribeSystemLogs === "function") unsubscribeSystemLogs();
    }
  };

  window.BCGOBrain = brain;
  window.BCGO_STATE = safeClone(state);
  unsubscribeAuth = onAuthStateChanged(auth, verifyAdmin);
  return brain;
}
