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
 * BCGO MASTER NERVE SYSTEM v2.6
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

  // ------------------------------------------------------------
  // LOCAL CONVERSATION CORE — Phase 3A
  // One brain, one live state, no AI/API reasoning dependency.
  // ------------------------------------------------------------
  const conversation = [];
  const conversationMemory = {
    lastUser: "",
    lastIntent: "",
    lastFile: null,
    lastCase: null,
    lastEvidence: null,
    lastAnswerAt: 0
  };

  function rememberConversation(user, intent, context = {}) {
    conversationMemory.lastUser = String(user || "");
    conversationMemory.lastIntent = intent || "UNKNOWN";
    if (context.file) conversationMemory.lastFile = context.file;
    if (context.case) conversationMemory.lastCase = context.case;
    if (context.evidence) conversationMemory.lastEvidence = context.evidence;
    conversationMemory.lastAnswerAt = Date.now();
    conversation.push({ role: "user", text: String(user || ""), intent, at: Date.now() });
    if (conversation.length > 20) conversation.shift();
  }

  function rememberAnswer(text) {
    conversation.push({ role: "bcgo", text: String(text || ""), at: Date.now() });
    if (conversation.length > 20) conversation.shift();
    return text;
  }

  function detectIntent(raw) {
    const q = String(raw || "").toLowerCase().trim();
    if (!q) return "EMPTY";
    if (/^(halo|hai|hello|pagi|siang|sore|malam)\b/.test(q) || /siapa kamu/.test(q)) return "GREETING";
    if (/scan ulang|rescan|pindai ulang|periksa ulang|cek ulang/.test(q)) return "RESCAN";
    if (/medicine|obat|pengobatan|perbaiki|perbaikan|repair|sembuhkan|penyembuhan/.test(q)) return "MEDICINE";
    if (/sedang apa|sedang mengerjakan|lagi apa|ngapain|kerja apa|kamu kerjakan/.test(q)) return "WORK";
    if (/telemetry terakhir|impuls terakhir|error terakhir|error terbaru|laporan terakhir|terakhir/.test(q)) return "LATEST";
    if (/cycle|siklus|tahap|fase|posisi/.test(q)) return "CYCLE";
    if (/berapa.*(file|organ)|organ.*apa|pantau apa|memantau apa|file.*pantau/.test(q)) return "REGISTRY";
    if (/status|kondisi|sehat|aman|online|offline|live/.test(q)) return "STATUS";
    if (/masalah|error|anomali|gangguan|rusak/.test(q)) return "ANOMALY";
    if (/kenapa|mengapa|penyebab|akar masalah|root cause/.test(q)) return "WHY";
    if (/yang mana|mana yang|yang pertama|yang kedua|itu apa|itu yang|maksudnya|tadi|sebelumnya/.test(q)) return "FOLLOWUP";
    if (/jelaskan|detail|rincian|bukti|evidence|kenapa bisa|bagaimana/.test(q)) return "DETAIL";
    return "GENERAL";
  }

  function resolveContext(raw, organs, active, recovered) {
    const q = String(raw || "").toLowerCase();
    const registry = Object.keys(ORGAN_REGISTRY);
    let file = registry.find(name => q.includes(name.toLowerCase())) || null;

    // Pronoun / ordinal resolution comes from the live conversation, never invented data.
    if (!file && /yang pertama|pertama|ini|itu|tersebut|tadi|sebelumnya/.test(q)) {
      file = conversationMemory.lastFile || active[0]?.[0] || null;
    }
    if (!file && /yang kedua|kedua/.test(q)) file = active[1]?.[0] || recovered[1]?.[0] || null;
    if (!file && /yang ketiga|ketiga/.test(q)) file = active[2]?.[0] || recovered[2]?.[0] || null;

    const info = file ? organs[file] : null;
    const caseForFile = file ? makeCases(organs).find(c => c.target === file) || null : null;
    return { file, info, caseForFile };
  }

  function naturalList(items, limit = 4) {
    const names = items.slice(0, limit).map(([f]) => f);
    if (!names.length) return "";
    if (names.length === 1) return names[0];
    if (names.length === 2) return `${names[0]} dan ${names[1]}`;
    return `${names.slice(0, -1).join(", ")}, dan ${names[names.length - 1]}`;
  }

  function answerQuestion(question) {
    const raw = String(question || "").trim();
    const organs = buildOrgans();
    const active = Object.entries(organs).filter(([, v]) => v.state === "ACTIVE");
    const recovered = Object.entries(organs).filter(([, v]) => v.state === "RECOVERED");
    const metrics = makeMetrics(organs);
    const intent = detectIntent(raw);
    const ctx = resolveContext(raw, organs, active, recovered);

    const finish = (text, memory = {}) => {
      rememberConversation(raw, intent, { ...memory, file: memory.file || ctx.file });
      return rememberAnswer(text);
    };

    if (!raw) return finish("Saya siap. Tanyakan kondisi sistem, error, file tertentu, telemetry terakhir, siklus saya, atau kasus yang ingin ditelusuri.");

    if (intent === "GREETING") {
      return finish(`Halo. Saya BCGO. Saya bekerja dari state dan telemetry yang sedang hidup, bukan dari tebakan. Saat ini cycle #${cycleNo}, tahap ${state.step}. ${situation()}`);
    }

    if (intent === "RESCAN") {
      recordEvent("CHAT_COMMAND", "Anda meminta pemeriksaan ulang telemetry.", "SYS_CHAT_RESCAN");
      emit("IN", "Saya menerima perintah pemeriksaan ulang. Saya membaca ulang telemetry yang tersedia sekarang.", "SYS_CHAT_RESCAN", null, { cycleMode: "CHAT_COMMAND" });
      return finish(`Baik. Saya mulai pemeriksaan ulang. Saat ini saya membaca ${metrics.total} organ; ${metrics.active} anomaly aktif dan ${metrics.recovered} recovered.`, { file: active[0]?.[0] || null });
    }

    if (intent === "WORK") {
      return finish(`Saat ini saya berada di tahap ${state.step}, cycle #${cycleNo}. ${state.message} ${situation()}`);
    }

    if (intent === "STATUS") {
      if (firestore.error) return finish(`Saya belum bisa menyebut sistem aman. Sensor Firestore melaporkan gangguan: ${firestore.error}`);
      return finish(`Status sekarang: ${metrics.active} anomaly aktif, ${metrics.recovered} recovered, dan ${metrics.healthy} stabil dari ${metrics.total} organ. Firestore ${firestore.connected ? "LIVE" : "belum LIVE"}; snapshot terakhir membaca ${metrics.firestoreCount} data.`);
    }

    if (intent === "ANOMALY") {
      if (!active.length) return finish("Saat ini saya tidak melihat anomaly aktif dari telemetry. Laporan lama tetap menjadi bukti historis, bukan anomaly aktif.");
      const first = active[0];
      conversationMemory.lastFile = first[0];
      conversationMemory.lastEvidence = first[1].message;
      return finish(`Ya, ada ${active.length} anomaly aktif. Fokus pertama saya ${first[0]}. Bukti telemetry: ${first[1].message}${active.length > 1 ? ` Kasus lain: ${naturalList(active.slice(1))}.` : ""}`, { file: first[0], evidence: first[1].message });
    }

    if (intent === "LATEST") {
      if (!state.lastTelemetryFile) return finish("Belum ada telemetry terakhir yang bisa saya pastikan dari state yang hidup.");
      const age = effectiveAge(timestamp(state.lastTelemetryAt));
      return finish(`Telemetry terakhir yang saya terima berasal dari ${state.lastTelemetryFile}, ${age < 1000 ? "baru saja" : `${Math.round(age / 1000)} detik lalu`}. Pesannya: ${state.lastTelemetryMessage || "-"}`, { file: state.lastTelemetryFile, evidence: state.lastTelemetryMessage });
    }

    if (intent === "CYCLE") {
      return finish(`Saya berada di cycle #${cycleNo}, tahap ${state.step}, mode ${state.cycleMode}. Target saraf saat ini ${state.targetCell}.`);
    }

    if (intent === "REGISTRY") {
      return finish(`Saya mengenali ${metrics.total} organ: ${Object.keys(ORGAN_REGISTRY).join(", ")}. Saat ini ${metrics.active} anomaly aktif, ${metrics.recovered} recovered, dan ${metrics.healthy} stabil.`);
    }

    if (intent === "MEDICINE") {
      if (!active.length) return finish("Belum ada kasus aktif yang cukup kuat untuk saya teruskan ke Medicine. Saya tidak akan membuat source code perbaikan tanpa bukti telemetry.");
      const selected = ctx.caseForFile || makeCases(organs)[0];
      if (!selected) return finish("Saya belum memiliki kasus yang dapat diteruskan berdasarkan bukti aktif.");
      return finish(`Saya bisa menyiapkan handoff ke Medicine untuk ${selected.target}. Bukti yang tersedia: ${selected.evidence.message}. Ini baru konfirmasi telemetry; Medicine tetap harus menelusuri dependency, root cause, dan source exact sebelum menyusun BEFORE → AFTER.`, { file: selected.target, case: selected, evidence: selected.evidence.message });
    }

    if (intent === "FOLLOWUP") {
      const file = ctx.file;
      if (file && ctx.info) {
        if (ctx.info.state === "ACTIVE") return finish(`Yang kamu maksud adalah ${file}. Statusnya ANOMALY. Bukti yang sedang saya pegang: ${ctx.info.message}`, { file, evidence: ctx.info.message });
        if (ctx.info.state === "RECOVERED") return finish(`Yang kamu maksud adalah ${file}. Statusnya RECOVERED; ada bukti historis, tetapi tidak ada error aktif dalam window pemantauan.`, { file });
        return finish(`Yang kamu maksud adalah ${file}. Saat ini HEALTHY menurut telemetry yang saya terima. Itu bukan klaim bahwa source code pasti sempurna.`, { file });
      }
      if (conversationMemory.lastFile) return finish(`Kalau yang kamu maksud dengan “itu” adalah pembahasan terakhir, saya sedang merujuk ke ${conversationMemory.lastFile}.` , { file: conversationMemory.lastFile });
      return finish("Saya belum punya referensi percakapan yang cukup untuk mengetahui apa yang dimaksud “itu”. Sebutkan file, error, atau kasusnya agar saya tidak menebak.");
    }

    if (ctx.file && ctx.info && intent !== "WHY" && intent !== "DETAIL") {
      const info = ctx.info;
      if (info.state === "ACTIVE") return finish(`${ctx.file} sedang ANOMALY. Bukti telemetry yang saya terima: ${info.message}`, { file: ctx.file, evidence: info.message });
      if (info.state === "RECOVERED") return finish(`${ctx.file} berstatus RECOVERED. Ada bukti historis, tetapi tidak ada error aktif dalam window pemantauan.`, { file: ctx.file });
      return finish(`${ctx.file} saat ini HEALTHY menurut telemetry yang saya terima. Artinya belum ada error aktif yang terdeteksi, bukan bukti bahwa source code pasti sempurna.`, { file: ctx.file });
    }

    if (intent === "WHY") {
      const file = ctx.file || conversationMemory.lastFile;
      const info = file ? organs[file] : null;
      if (info?.state === "ACTIVE") {
        return finish(`Untuk ${file}, saya baru bisa memastikan gejalanya: ${info.message}. Itu belum cukup untuk menyebut root cause. Saya perlu menelusuri dependency dan source exact sebelum menyimpulkan penyebab sebenarnya.`, { file, evidence: info.message });
      }
      return finish(`Saya bisa menelusuri penyebab, tetapi saya tidak akan mengubah gejala menjadi root cause tanpa bukti. Sebutkan file atau error yang dimaksud agar saya mengikat pertanyaan ini ke telemetry yang tepat.`);
    }

    if (intent === "DETAIL") {
      const file = ctx.file || conversationMemory.lastFile;
      const info = file ? organs[file] : null;
      if (info?.state === "ACTIVE") {
        return finish(`Detail untuk ${file}: status ANOMALY. Bukti: ${info.message}. Waktu laporan: ${formatDateForReasoning(info.reportedAt)}. Posisi yang tersedia: line ${info.line ?? "?"}, column ${info.column ?? "?"}. Saya belum mengklaim root cause karena telemetry belum menunjukkan dependency/source exact.` , { file, evidence: info.message });
      }
      return finish(`Detail yang bisa saya pastikan sekarang berasal dari state hidup: ${metrics.active} anomaly aktif, ${metrics.recovered} recovered, ${metrics.healthy} stabil, Firestore ${firestore.connected ? "LIVE" : "belum LIVE"}. Untuk diagnosis presisi, saya perlu target yang spesifik.`);
    }

    return finish(`Saya menangkap pertanyaanmu: “${raw}”. Saya belum menemukan intent dan bukti yang cukup untuk menjawab secara spesifik. Saya tidak akan mengarang. Kamu bisa menanyakan status, error, file tertentu, telemetry terakhir, cycle, atau meminta handoff kasus ke Medicine.`);
  }

  function formatDateForReasoning(value) {
    const t = timestamp(value);
    if (!t) return "waktu tidak tersedia";
    try { return new Date(t).toLocaleString("id-ID"); } catch { return "waktu tidak tersedia"; }
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
