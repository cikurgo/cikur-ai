import {
  collection,
  onSnapshot,
  query,
  orderBy,
  limit,
  doc,
  getDoc,
  where
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { adminDb, adminAuth } from "../cikur-config.js";
import { createRadarEngine } from "../brain/cgo-ai-radar.js";

/*
 * BCGO MASTER NERVE SYSTEM v4.2.0-CLEAN-AGENT-RADAR
 *
 * Prinsip:
 * - Firestore = sumber fakta real-time.
 * - Tidak memakai AI/API eksternal.
 * - Chat adalah reasoning lokal berbasis state telemetry yang sedang hidup.
 * - Error lintas-file hanya dianggap ACTIVE bila ada bukti telemetry yang valid.
 * - Tidak pernah menulis source code secara otomatis.
 * - Diagnosis is evidence-driven; BCGO observes and reports system state only.
 * - BCGO sendiri bukan organ telemetry; bcgo.html tidak dimasukkan ke registry agar monitor tidak mendiagnosis dirinya sendiri.
 * - bcgo.js adalah engine monitor BCGO dan bukan organ telemetry.
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
  "data-cgo.html": { type: "Data Sistem", role: "data" }
};

const ORGAN_COUNT = Object.keys(ORGAN_REGISTRY).length;

const INTERNAL_SOURCE_SCAN = [
  { file: "internal/bcgo.html", path: "internal/bcgo.html", role: "BCGO Monitor" },
  { file: "internal/bcgo.js", path: "internal/bcgo.js", role: "BCGO Engine" },
  { file: "internal/bcgo-admin.html", path: "internal/bcgo-admin.html", role: "Admin Control" },
  { file: "internal/data-cgo.html", path: "internal/data-cgo.html", role: "Data Console" },
  { file: "cikur-config.js", path: "cikur-config.js", role: "Auth / Config" },
  { file: "shared/bcgo-engine.js", path: "shared/bcgo-engine.js", role: "Shared Engine" }
];

function makeInitialSourceScan() {
  const fileStates = {};
  for (const item of INTERNAL_SOURCE_SCAN) fileStates[item.file] = { status: "QUEUED", message: "Menunggu pembacaan source." };
  return {
    status: "WAITING", phase: "BOOT", totalFiles: INTERNAL_SOURCE_SCAN.length, filesScanned: 0,
    filesReadable: 0, filesFailed: 0, currentFile: null, findings: [], crossFileFindings: [],
    relations: [], relationSummary: { synchronized: 0, mismatch: 0, variant: 0, unknown: 0, linked: 0 },
    fileStates, nerveSummary: { healthy: 0, standby: 0, observed: 0, review: 0, anomaly: 0, unresolved: 0 },
    message: "Scanner source internal belum dimulai."
  };
}


const ACTIVE_WINDOW = 15 * 60 * 1000;
const CLOCK_SKEW = 5 * 60 * 1000;
const LOG_LIMIT = 50;
const PROBE_LIMIT = 5;
const EVENT_LIMIT = 24;
const AGENT_PRESENCE_MAX_AGE_MS = 180000;
const AGENT_PRESENCE_LIMIT = 500;
const AGENT_PRESENCE_MAX_ACCURACY_M = 1000;
const radar = createRadarEngine({ maxAgents: AGENT_PRESENCE_LIMIT });

const INTERNAL_TELEMETRY_SOURCES = new Set([
  "bcgo.html", "bcgo.js",
  "unhandledrejection", "error", "window.error", "runtime", "unknown"
]);

function telemetrySourceCandidates(log) {
  const values = [
    log?.fileName, log?.sourceFile, log?.filename, log?.file, log?.source,
    log?.target, log?.url, log?.script
  ].filter(Boolean);
  const stack = String(log?.stack || log?.errorStack || "");
  const matches = stack.match(/(?:https?:\/\/[^\s)]+\/)?[^\s/()]+\.(?:html|js)(?::\d+(?::\d+)?)?/gi) || [];
  return [...values, ...matches].map(normalizeFile).filter(Boolean);
}

function isInternalTelemetry(log) {
  return telemetrySourceCandidates(log).some(file => INTERNAL_TELEMETRY_SOURCES.has(String(file).toLowerCase()));
}
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
  let authorizedUid = null;
  let authEpoch = 0;
  let cycleNo = 0;
  let phaseIndex = -1;
  let cycleTimer = null;
  let refreshTimer = null;
  let unsubscribeAuth = null;
  let unsubscribeFirestore = null;
  let unsubscribeSystemLogs = null;
  let unsubscribeAgentPresence = null;
  let latestSystemLogs = [];
  let previousTopSignature = "";
  let realtimeBusy = false;
  let interruptTimerProcess = null;
  let interruptTimerReview = null;
  let interruptGeneration = 0;

  const firestore = { connected: false, count: 0, error: null, lastServerAt: 0 };
  const state = {
    step: "IN",
    message: "Membangunkan Pusat Saraf Master...",
    targetCell: "SYS_MASTER_REGISTRY",
    errorLog: null,
    retryCount: 0,
    cycle: 0,
    cycleMode: "BOOT",
    metrics: { total: ORGAN_COUNT, active: 0, recovered: 0, healthy: ORGAN_COUNT, firestoreCount: 0 },
    systemOrgans: {},
    systemLogs: [],
    recentEvents: [],
    firestore: { ...firestore },
    lastEventAt: null,
    lastTelemetryFile: null,
    lastTelemetryAt: null,
    lastTelemetryMessage: null,
    activeCases: [],
    sourceScan: makeInitialSourceScan(),
    fileNerves: {},
    connection: { status: "CONNECTING", lastServerAt: 0 },
    agentPresence: {
      status: "CONNECTING",
      connected: false,
      count: 0,
      freshCount: 0,
      staleCount: 0,
      lastServerAt: 0,
      radar: null,
      radarEvents: [],
      items: []
    }
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

  // UI adalah konsumen state. Kegagalan render tidak boleh mematikan engine
  // dan tidak boleh berubah menjadi anomaly pada organ bcgo.html.
  const BCGO_STATE_KEY = "CIKUR_GO_BCGO_STATE_V1";
  let bcgoChannel = null;
  try { bcgoChannel = new BroadcastChannel(BCGO_STATE_KEY); } catch {}

  function publishCrossTabState(snapshot) {
    try {
      const payload = safeClone(snapshot);
      localStorage.setItem(BCGO_STATE_KEY, JSON.stringify(payload));
      bcgoChannel?.postMessage(payload);
    } catch (error) {
      // Cross-tab mirroring is auxiliary. Never let storage/channel errors
      // stop the BCGO monitoring engine itself.
      console.warn("BCGO cross-tab state mirror unavailable:", error);
    }
  }

  function publishToUI(snapshot) {
    publishCrossTabState(snapshot);
    try {
      onCycleUpdate(snapshot);
    } catch (uiError) {
      state.uiError = String(uiError?.message || uiError || "UI render error").slice(0, 500);
      console.warn("BCGO UI render error (engine tetap hidup):", state.uiError);
    }
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
    // Hanya sinyal dalam window aktif yang boleh menjadi ANOMALY.
    // BUG FIX: kondisi lama memakai OR sehingga SEMUA timestamp lama ikut dianggap aktif.
    const nowMs = Date.now();
    return t > 0 && t >= nowMs - ACTIVE_WINDOW && t <= nowMs + CLOCK_SKEW;
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
    if (state.agentPresence?.items?.length) {
      const nowMs = Date.now();
      const fresh = state.agentPresence.items.filter(item => nowMs - presenceTimestamp(item.updatedAt) <= AGENT_PRESENCE_MAX_AGE_MS);
      state.agentPresence.items = fresh.map(item => ({ ...item, ageMs: Math.max(0, nowMs - presenceTimestamp(item.updatedAt)) }));
      state.agentPresence.freshCount = state.agentPresence.items.length;
      state.agentPresence.count = state.agentPresence.items.length;
      state.agentPresence.radar = radar.ingest(state.agentPresence.items, { updatedAt: new Date().toISOString(), reason: "AGE_REFRESH" });
    }
    state.connection = deriveConnection();
    state.activeCases = cases;

    if (options.telemetry) {
      state.lastTelemetryFile = options.telemetry.file;
      state.lastTelemetryAt = options.telemetry.at || null;
      state.lastTelemetryMessage = options.telemetry.message || null;
    }

    const snapshot = safeClone(state);
    window.BCGO_STATE = snapshot;
    publishToUI(snapshot);
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
      : `Semua ${ORGAN_COUNT} organ belum memiliki laporan error aktif dalam telemetry yang saya terima.`;
  }

  function findFile(question) {
    const q = String(question || "").toLowerCase();
    return Object.keys(ORGAN_REGISTRY).find(file => q.includes(file.toLowerCase())) || null;
  }

  function answerQuestion(question) {
    const raw = String(question || "").trim();
    const q = raw.toLowerCase();
    const organs = buildOrgans();
    const active = Object.entries(organs).filter(([, v]) => v.state === "ACTIVE");
    const recovered = Object.entries(organs).filter(([, v]) => v.state === "RECOVERED");
    const metrics = makeMetrics(organs);
    const file = findFile(raw);

    if (!q) return "Saya siap. Tanyakan kondisi sistem, error, file tertentu, telemetry terakhir, siklus saya, atau bukti yang sedang saya lihat.";

    if (/^(halo|hai|hello|pagi|siang|sore|malam)\b/.test(q) || /siapa kamu/.test(q)) {
      return `Halo. Saya BCGO. Saya bekerja dari telemetry dan state sistem yang sedang hidup, bukan dari tebakan. Sekarang cycle #${cycleNo}, tahap ${state.step}. ${situation()}`;
    }

    if (/scan ulang|rescan|pindai ulang|periksa ulang/.test(q)) {
      recordEvent("CHAT_COMMAND", "Anda meminta pemeriksaan ulang telemetry.", "SYS_CHAT_RESCAN");
      emit("IN", "Saya menerima perintah pemeriksaan ulang. Saya membaca ulang telemetry yang tersedia sekarang.", "SYS_CHAT_RESCAN", null, { cycleMode: "CHAT_COMMAND" });
      return `Baik. Saya mulai pemeriksaan ulang. Saat ini ${metrics.active} anomali aktif dari ${metrics.total} organ.`;
    }

    if (/sedang apa|sedang mengerjakan|lagi apa|ngapain|kerja apa/.test(q)) {
      return `Saya sedang berada di tahap ${state.step}, cycle #${cycleNo}. ${state.message} ${situation()}`;
    }

    if (/status|kondisi|sehat|aman/.test(q)) {
      if (firestore.error) return `Belum bisa saya sebut aman. Firestore sedang bermasalah: ${firestore.error}`;
      return `Status sekarang: ${metrics.active} anomali aktif, ${metrics.recovered} recovered, ${metrics.healthy} stabil dari ${metrics.total} organ. Firestore ${firestore.connected ? "LIVE" : "belum terhubung penuh"} dan probe membaca ${metrics.firestoreCount} data.`;
    }

    if (/error|masalah|anomali|gangguan|rusak/.test(q)) {
      if (!active.length) return "Saya belum melihat anomali aktif dari telemetry. Laporan lama tetap saya simpan sebagai RECOVERED; saya menunggu bukti baru secara real-time.";
      const detail = active.slice(0, 4).map(([f, v]) => `${f}: ${v.message}`).join(" | ");
      return `Ya, ada ${active.length} anomali aktif. ${detail}`;
    }

    if (/telemetry terakhir|impuls terakhir|error terakhir|terakhir/.test(q)) {
      if (!state.lastTelemetryFile) return "Belum ada telemetry terakhir yang bisa saya pastikan.";
      const age = effectiveAge(timestamp(state.lastTelemetryAt));
      return `Telemetry terakhir berasal dari ${state.lastTelemetryFile}, sekitar ${age < 1000 ? "baru saja" : `${Math.round(age / 1000)} detik lalu`}. Pesannya: ${state.lastTelemetryMessage || "-"}`;
    }

    if (/cycle|siklus|tahap|posisi/.test(q)) {
      return `Saya berada di cycle #${cycleNo}, tahap ${state.step}, mode ${state.cycleMode}. Target saraf saat ini: ${state.targetCell}.`;
    }

    if (/berapa.*file|berapa.*organ|organ.*apa|pantau apa|memantau apa/.test(q)) {
      return `Saya mengenali ${metrics.total} organ: ${Object.keys(ORGAN_REGISTRY).join(", ")}. ${metrics.active} sedang aktif bermasalah, ${metrics.recovered} recovered, ${metrics.healthy} stabil.`;
    }

    if (file) {
      const info = organs[file];
      if (!info) return `Saya mengenali ${file}, tetapi belum menerima state-nya.`;
      if (info.state === "ACTIVE") return `${file} sedang ANOMALY. Bukti telemetry: ${info.message}`;
      if (info.state === "RECOVERED") return `${file} berstatus RECOVERED. Ada bukti historis, tetapi tidak ada error aktif dalam window pemantauan.`;
      return `${file} saat ini HEALTHY menurut telemetry yang saya terima. Ini berarti belum ada laporan error aktif, bukan bukti bahwa source code pasti sempurna.`;
    }

    if (/kenapa|mengapa/.test(q)) {
      return `Saya berada di ${state.step} karena mesin sedang menjalankan: ${state.message} Target: ${state.targetCell}. Jika yang Anda tanyakan adalah penyebab error tertentu, sebutkan file atau error-nya agar saya tidak menebak.`;
    }

    if (/jelaskan|detail|rincian/.test(q)) {
      return `Saya bisa menjelaskan berdasarkan bukti. Saat ini: ${metrics.active} anomali aktif, ${metrics.recovered} recovered, Firestore ${firestore.connected ? "LIVE" : "belum LIVE"}, target ${state.targetCell}. Untuk detail akar masalah, saya perlu kasus/file yang spesifik.`;
    }

    return `Saya menangkap pertanyaanmu: “${raw}”. Saya belum punya bukti telemetry yang cukup untuk menjawab secara spesifik. Saya tidak akan mengarang. Kamu bisa bertanya tentang status, error, file tertentu, telemetry terakhir, cycle, atau meminta saya menjelaskan bukti telemetry yang tersedia.`;
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
    const generation = ++interruptGeneration;

    clearTimeout(cycleTimer);
    clearTimeout(interruptTimerProcess);
    clearTimeout(interruptTimerReview);
    interruptTimerProcess = null;
    interruptTimerReview = null;

    recordEvent("TELEMETRY", `Impuls baru dari ${file}.`, file);
    emit("PROCESS", `⚡ Saya menerima bukti baru dari ${file}. Saya hentikan sejenak siklus normal untuk memeriksanya.`, file, text, {
      cycleMode: "INTERRUPTED",
      telemetry: { file, at, message: text }
    });

    interruptTimerProcess = setTimeout(() => {
      interruptTimerProcess = null;
      if (stopped || !authorized || generation !== interruptGeneration) return;
      const organs = buildOrgans();
      const info = organs[file];
      const active = Object.entries(organs).filter(([, v]) => v.state === "ACTIVE");
      if (info?.state === "ACTIVE") {
        emit("REVIEW", `Bukti ${file} masih aktif. Saya mempertahankan kasus ini sebagai kandidat diagnosis berbasis telemetry dan mempertahankan bukti yang tersedia.`, file, info.message, {
          cycleMode: "INTERRUPTED",
          telemetry: { file, at, message: text }
        });
      } else if (active.length) {
        emit("REVIEW", `Impuls ${file} sudah tidak aktif, tetapi ${active.length} anomali lain masih aktif. Saya lanjutkan REVIEW.`, active[0][0], active[0][1].message, { cycleMode: "INTERRUPTED" });
      } else {
        emit("REVIEW", `Saya sudah memeriksa impuls ${file}. Saat ini tidak ada anomali aktif yang bisa saya pastikan.`, file, null, { cycleMode: "INTERRUPTED" });
      }

      interruptTimerReview = setTimeout(() => {
        interruptTimerReview = null;
        if (stopped || !authorized || generation !== interruptGeneration) return;
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

  function presenceTimestamp(value) {
    if (!value) return 0;
    try {
      if (typeof value.toMillis === "function") return value.toMillis();
      if (typeof value.toDate === "function") return value.toDate().getTime();
      if (typeof value === "number") return value;
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : 0;
    } catch { return 0; }
  }

  function normalizeAgentPresenceRecord(docSnap) {
    const data = docSnap.data() || {};
    if (data.jenis !== "agent" || data.status !== "approved") return null;
    const presence = data.presence || {};
    const location = presence.location || data.liveLocation || null;
    const lat = Number(location?.lat ?? location?.latitude);
    const lng = Number(location?.lng ?? location?.longitude ?? location?.lon);
    if (presence.active !== true || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const accuracy = Number(location?.accuracy);
    if (Number.isFinite(accuracy) && accuracy > AGENT_PRESENCE_MAX_ACCURACY_M) return null;
    const updatedMs = presenceTimestamp(presence.updatedAt || data.updatedAt);
    const age = updatedMs ? Math.max(0, Date.now() - updatedMs) : Infinity;
    if (age > AGENT_PRESENCE_MAX_AGE_MS) return null;
    return {
      id: docSnap.id,
      agentId: String(data.uid || docSnap.id.replace(/_agent$/, "")),
      name: String(data.namaPanggilan || data.name || data.agentName || "Agent CGO"),
      type: "agent",
      status: "active",
      active: true,
      available: presence.available !== false,
      location: { lat, lng, accuracy: Number.isFinite(Number(location?.accuracy)) ? Number(location.accuracy) : null },
      updatedAt: presence.updatedAt || data.updatedAt || null,
      ageMs: age,
      source: "BCGO_AGENT_PRESENCE_REALTIME"
    };
  }

  function startAgentPresence() {
    const listenerEpoch = authEpoch;
    if (typeof unsubscribeAgentPresence === "function") unsubscribeAgentPresence();
    state.agentPresence = { ...state.agentPresence, status: "CONNECTING", connected: false };
    try {
      const q = query(
        collection(adminDb, "mitra_applications"),
        where("jenis", "==", "agent"),
        where("status", "==", "approved")
      );
      unsubscribeAgentPresence = onSnapshot(q, snapshot => {
        if (stopped || !authorized || listenerEpoch !== authEpoch) return;
        const items = [];
        snapshot.forEach(docSnap => {
          const item = normalizeAgentPresenceRecord(docSnap);
          if (item) items.push(item);
        });
        items.sort((a,b) => a.agentId.localeCompare(b.agentId));
        const freshCount = items.filter(item => item.ageMs <= AGENT_PRESENCE_MAX_AGE_MS).length;
        state.agentPresence = {
          status: "LIVE",
          connected: true,
          count: items.length,
          freshCount,
          staleCount: Math.max(0, snapshot.size - items.length),
          lastServerAt: Date.now(),
          items: items.slice(0, AGENT_PRESENCE_LIMIT)
        };
        state.agentPresence.items = state.agentPresence.items.map(item => ({ ...item, ageMs: Math.max(0, Date.now() - presenceTimestamp(item.updatedAt)) }));
        state.agentPresence.radar = radar.ingest(state.agentPresence.items, { updatedAt: new Date().toISOString(), reason: "FIRESTORE_SNAPSHOT" });
        state.agentPresence.radarEvents = radar.getRecentEvents(24);
        window.BCGO_STATE = safeClone(state);
        publishToUI(safeClone(state));
      }, error => {
        if (stopped || !authorized || listenerEpoch !== authEpoch) return;
        state.agentPresence = { ...state.agentPresence, status: "ERROR", connected: false, lastError: String(error?.message || error) };
        recordEvent("AGENT_PRESENCE_ERROR", "Sensor presence Agent CGO gagal dibuka.", "SYS_AGENT_PRESENCE", error?.message);
        publishToUI(safeClone(state));
      });
    } catch (error) {
      state.agentPresence = { ...state.agentPresence, status: "ERROR", connected: false, lastError: String(error?.message || error) };
      publishToUI(safeClone(state));
    }
  }

  function cleanupRealtime() {
    ++interruptGeneration;
    previousTopSignature = "";
    clearTimeout(cycleTimer);
    clearTimeout(interruptTimerProcess);
    clearTimeout(interruptTimerReview);
    clearInterval(refreshTimer);
    cycleTimer = null;
    interruptTimerProcess = null;
    interruptTimerReview = null;
    refreshTimer = null;
    if (typeof unsubscribeFirestore === "function") unsubscribeFirestore();
    if (typeof unsubscribeSystemLogs === "function") unsubscribeSystemLogs();
    if (typeof unsubscribeAgentPresence === "function") unsubscribeAgentPresence();
    unsubscribeFirestore = null;
    unsubscribeSystemLogs = null;
    unsubscribeAgentPresence = null;
    realtimeBusy = false;
  }

  function startSystemLogs() {
    const listenerEpoch = authEpoch;
    if (!window.CikurCloud?.listenSystemLogs) {
      emit("OUT", "Kanal telemetry system_logs belum tersedia dari CikurCloud. Saya tidak akan mengklaim pemantauan lintas-file aktif.", "SYS_TELEMETRY_UNAVAILABLE");
      return;
    }

    if (typeof unsubscribeSystemLogs === "function") unsubscribeSystemLogs();
    try {
      unsubscribeSystemLogs = window.CikurCloud.listenSystemLogs(logs => {
        if (stopped || !authorized || listenerEpoch !== authEpoch) return;
        const rawLogs = Array.isArray(logs) ? logs : [];
        // Filter first, then apply the display limit. Otherwise a burst of internal
        // self-errors at the top of the listener payload could hide real organ telemetry.
        latestSystemLogs = rawLogs.filter(log => !isInternalTelemetry(log)).slice(0, LOG_LIMIT);
        const top = latestSystemLogs[0];
        const topAt = timestamp(top?.reportedAt);
        const previousTop = previousTopSignature;

        const organs = buildOrgans();
        state.systemOrgans = organs;
        state.metrics = makeMetrics(organs);
        state.activeCases = makeCases(organs);
        state.systemLogs = latestSystemLogs.slice();
        state.lastTelemetryFile = top ? normalizeFile(top.fileName) : state.lastTelemetryFile;
        state.lastTelemetryAt = topAt || state.lastTelemetryAt;
        state.lastTelemetryMessage = top?.message || state.lastTelemetryMessage;
        window.BCGO_STATE = safeClone(state);

        if (top && `${normalizeFile(top.fileName)}|${String(top.message || "")}|${topAt}` !== previousTop) {
          interruptForTelemetry(top.fileName, top.message, top);
        } else {
          publishToUI(safeClone(state));
        }
      }, LOG_LIMIT);
    } catch (error) {
      emit("PROCESS", "Kanal telemetry lintas-file gagal dibuka.", "SYS_SYSTEM_LOGS_LISTENER", error?.message, { cycleMode: "ERROR" });
    }
  }

  function startFirestoreProbe() {
    const listenerEpoch = authEpoch;
    if (typeof unsubscribeFirestore === "function") unsubscribeFirestore();
    try {
      const q = query(collection(adminDb, "mitra_applications"), orderBy("submittedAt", "desc"), limit(PROBE_LIMIT));
      unsubscribeFirestore = onSnapshot(q, snapshot => {
        if (stopped || !authorized || listenerEpoch !== authEpoch) return;
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
        if (stopped || !authorized || listenerEpoch !== authEpoch) return;
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

  async function runInternalSourceScan() {
    if (stopped || !authorized) return;
    const scan = makeInitialSourceScan();
    scan.status = "SCANNING";
    scan.phase = "READING";
    state.sourceScan = scan;
    publishToUI(safeClone(state));

    const contents = new Map();
    for (let i = 0; i < INTERNAL_SOURCE_SCAN.length; i++) {
      if (stopped || !authorized) return;
      const item = INTERNAL_SOURCE_SCAN[i];
      scan.currentFile = item.file;
      scan.phase = "READING";
      scan.fileStates[item.file] = { status: "READING", message: "Membaca source live dari origin aplikasi." };
      publishToUI(safeClone(state));
      try {
        const response = await fetch(new URL(item.path, location.href).href, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        if (!text.trim()) throw new Error("SOURCE_EMPTY");
        contents.set(item.file, text);
        scan.filesReadable++;
        scan.filesScanned++;
        scan.fileStates[item.file] = { status: "CLEAN", message: `${text.length.toLocaleString("id-ID")} karakter terbaca.` };
      } catch (error) {
        scan.filesFailed++;
        scan.filesScanned++;
        scan.fileStates[item.file] = { status: "FAILED", message: String(error?.message || error).slice(0,180) };
        scan.findings.push({ type: "SOURCE_UNREADABLE", severity: "HIGH", sourceFile: item.file, message: `Source tidak dapat dibaca: ${String(error?.message || error).slice(0,240)}` });
      }
      publishToUI(safeClone(state));
    }

    scan.phase = "ANALYZING";
    const relations = [];
    const rootUrl = location.href.split("/internal/")[0] + "/";
    for (const item of INTERNAL_SOURCE_SCAN) {
      const text = contents.get(item.file);
      if (!text) continue;
      const refs = [];
      const re = /(?:\b(?:src|href)\s*=\s*["']([^"']+)["'])|(?:\b(?:from|import)\s*["']([^"']+)["'])/g;
      let m;
      while ((m = re.exec(text))) refs.push(m[1] || m[2]);
      for (const ref of refs) {
        if (!ref || /^(https?:|data:|#|javascript:)/i.test(ref)) continue;
        let target;
        try { target = new URL(ref, new URL(item.path, rootUrl)).pathname.replace(/^\//, ""); } catch { continue; }
        if (target.startsWith("cikur-ai/")) target = target.slice("cikur-ai/".length);
        const known = INTERNAL_SOURCE_SCAN.some(x => x.path === target);
        if (known) relations.push({ type: "CROSS_FILE_SURFACE", status: "LINKED", confidence: "VERIFIED", sourceFile: item.file, targetFile: target, key: ref });
        else if (/\.(?:html|js)$/i.test(target)) relations.push({ type: "CROSS_FILE_SURFACE", status: "UNKNOWN", confidence: "UNKNOWN", sourceFile: item.file, targetFile: target, key: ref });
      }
    }
    // Explicit internal contracts that must remain wired.
    const contracts = [
      ["internal/bcgo.html", "internal/bcgo.js", "BCGO_ENGINE_IMPORT"],
      ["internal/bcgo.js", "cikur-config.js", "ADMIN_AUTH_CONFIG"],
      ["internal/bcgo-admin.html", "cikur-config.js", "ADMIN_AUTH_CONFIG"],
      ["internal/data-cgo.html", "cikur-config.js", "ADMIN_AUTH_CONFIG"]
    ];
    for (const [a,b,key] of contracts) {
      const text=contents.get(a)||"";
      const ok = text.includes(b.split('/').pop()) || (b === "cikur-config.js" && text.includes("../cikur-config.js")) || (b === "internal/bcgo.js" && text.includes("./bcgo.js"));
      relations.push({ type:"CROSS_FILE_CONTRACT", status: ok ? "LINKED" : "MISMATCH", confidence: ok ? "VERIFIED" : "HIGH", sourceFile:a, targetFile:b, key, evidence:{ missingSemantic: ok ? [] : [key] } });
    }
    scan.relations = relations;
    scan.relationSummary.linked = relations.filter(r=>r.status === "LINKED").length;
    scan.relationSummary.mismatch = relations.filter(r=>r.status === "MISMATCH").length;
    scan.relationSummary.unknown = relations.filter(r=>r.status === "UNKNOWN").length;
    scan.relationSummary.synchronized = scan.filesReadable;
    scan.crossFileFindings = relations.filter(r=>r.status === "MISMATCH");
    scan.status = scan.filesFailed || scan.relationSummary.mismatch ? "DEGRADED" : "CLEAN";
    scan.phase = "COMPLETE";
    scan.currentFile = null;
    scan.message = scan.status === "CLEAN"
      ? `Source internal live selesai dibaca: ${scan.filesReadable}/${scan.totalFiles} file dan ${scan.relationSummary.linked} relasi terverifikasi.`
      : `Source internal selesai dengan ${scan.filesFailed} file gagal dibaca dan ${scan.relationSummary.mismatch} kontrak mismatch.`;
    const nerves = {};
    for (const item of INTERNAL_SOURCE_SCAN) {
      const fs = scan.fileStates[item.file];
      nerves[item.file] = {
        health: { overall: fs?.status === "FAILED" ? "ANOMALY" : fs?.status === "CLEAN" ? "HEALTHY" : "REVIEW", source: fs?.status === "CLEAN" ? "READABLE" : "WAITING", runtime: "HEALTHY", dependency: "VERIFIED", contract: "VERIFIED" },
        source: { readable: fs?.status === "CLEAN" },
        runtime: { active: false },
        evidenceSummary: { relations: relations.filter(r=>r.sourceFile===item.file || r.targetFile===item.file).length, unresolved: 0 }
      };
    }
    scan.nerveSummary.healthy = Object.values(nerves).filter(n=>n.health.overall === "HEALTHY").length;
    scan.nerveSummary.anomaly = Object.values(nerves).filter(n=>n.health.overall === "ANOMALY").length;
    state.fileNerves = nerves;
    state.sourceScan = scan;
    publishToUI(safeClone(state));
  }

  function refreshState() {
    if (stopped || !authorized) return;
    const organs = buildOrgans();
    state.systemOrgans = organs;
    state.metrics = makeMetrics(organs);
    state.activeCases = makeCases(organs);
    state.systemLogs = latestSystemLogs.slice();
    state.firestore = { ...firestore };
    state.connection = deriveConnection();
    window.BCGO_STATE = safeClone(state);
    publishToUI(safeClone(state));
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
      emit("IN", `Neural cycle #${cycleNo} dimulai. Saya memindai ${ORGAN_COUNT} organ dan membaca bukti telemetry terbaru.`, "SYS_NEURAL_SCAN", null, { cycleMode: "NORMAL" });
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
        ? `REVIEW: ${active.length} kasus aktif. Saya mempertahankan bukti dan menyiapkan konteks evidence yang dapat diverifikasi.`
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

  async function verifyAdmin(user, epoch) {
    if (stopped || epoch !== authEpoch) return;
    if (!user) {
      authorized = false;
      authorizedUid = null;
      cleanupRealtime();
      emit("OUT", "Sesi Admin belum tersedia. Silakan login sebagai Admin.", "SYS_AUTH_REQUIRED");
      return;
    }

    // Retry baca admin_users — jangan anggap logout saat glitch jaringan setelah refresh.
    let snap = null;
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        snap = await getDoc(doc(adminDb, "admin_users", user.uid));
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        console.warn(`[BCGO] verifyAdmin attempt ${attempt}/3:`, error);
        await new Promise(r => setTimeout(r, 400 * attempt));
      }
    }

    if (stopped || epoch !== authEpoch || adminAuth.currentUser?.uid !== user.uid) return;

    if (lastError && !snap) {
      // Sesi Auth tetap ada; sensor ditunda sampai verifikasi berhasil di cycle berikutnya.
      emit("OUT", "Verifikasi Super Admin tertunda (koneksi). Sesi Auth tetap dijaga — coba refresh sebentar lagi.", "SYS_AUTH_CHECK_FAILED", lastError?.message, { cycleMode: "ERROR" });
      return;
    }

    const data = snap && snap.exists() ? snap.data() : null;
    if (data?.active !== true || data?.role !== "super_admin") {
      authorized = false;
      authorizedUid = null;
      cleanupRealtime();
      emit("OUT", "Akun ini bukan Super Admin aktif. Akses Pusat Saraf ditolak.", "SYS_AUTH_NOT_ADMIN");
      return;
    }

    // Auth state can change without reloading the page. Never keep an old
    // listener/session alive for a different UID.
    if (authorized && authorizedUid === user.uid) return;
    if (authorized && authorizedUid !== user.uid) {
      cleanupRealtime();
      authorized = false;
      authorizedUid = null;
    }

    authorized = true;
    authorizedUid = user.uid;
    recordEvent("AUTH", "Admin terverifikasi. Sensor real-time dibuka.", "SYS_AUTH_VERIFIED");
    emit("IN", "Admin terverifikasi. Saya membuka sensor telemetry dan Firestore real-time.", "SYS_AUTH_VERIFIED", null, { cycleMode: "BOOT" });
    startSystemLogs();
    startFirestoreProbe();
    startAgentPresence();
    runInternalSourceScan().catch(error => {
      state.sourceScan = { ...makeInitialSourceScan(), status: "DEGRADED", phase: "COMPLETE", message: String(error?.message || error) };
      publishToUI(safeClone(state));
    });
    refreshTimer = setInterval(refreshState, 15000);
    phaseIndex = -1;
    cycleNo = 0;
    nextPhase();
  }

  // Error UI lokal hanya dicatat sebagai diagnostic internal.
  // Tidak boleh masuk ke system_logs sebagai anomaly bcgo.html karena itu
  // dapat membuat loop: render error -> telemetry -> render -> error.
  window.addEventListener("error", event => {
    if (stopped) return;
    const source = normalizeFile(event?.filename || "__BCGO_UI__");
    const message = event?.message || event?.error?.message || "JavaScript error tidak diketahui.";
    if (source === "bcgo.html" || source === "bcgo.js") {
      state.uiError = `[${source}] ${String(message).slice(0, 450)}`;
      recordEvent("UI_ERROR", state.uiError, "SYS_UI_RENDER");
      console.warn("BCGO UI diagnostic:", state.uiError);
    }
  });

  window.addEventListener("unhandledrejection", event => {
    if (stopped) return;
    const reason = event?.reason?.message || String(event?.reason || "Unhandled Promise rejection.");
    state.uiError = String(reason).slice(0, 450);
    recordEvent("UI_REJECTION", state.uiError, "SYS_UI_RENDER");
    // This is a local diagnostic only. Never promote it into system_logs/anomaly.
    try { event.preventDefault(); } catch {}
    console.warn("BCGO UI rejection diagnostic:", state.uiError);
  });

  const brain = {
    ask: answerQuestion,
    getState: () => {
      const organs = buildOrgans();
      state.systemOrgans = organs;
      state.metrics = makeMetrics(organs);
      state.activeCases = makeCases(organs);
        return safeClone(state);
    },
    getSituation: situation,
    getRegistry: () => ({ ...ORGAN_REGISTRY }),
    stop() {
      stopped = true;
      ++authEpoch;
      clearTimeout(cycleTimer);
      clearInterval(refreshTimer);
      if (typeof unsubscribeAuth === "function") unsubscribeAuth();
      cleanupRealtime();
    }
  };

  window.BCGOBrain = brain;
  window.BCGO_STATE = safeClone(state);

  // Publish the boot state immediately. The monitor must visibly report its
  // actual lifecycle even while Firebase is still restoring the Admin session.
  // This is not a fabricated "online" state: cycleMode remains BOOT and
  // connection remains CONNECTING until the real auth/Firestore checks pass.
  publishToUI(safeClone(state));

  unsubscribeAuth = onAuthStateChanged(adminAuth, user => {
    const epoch = ++authEpoch;
    verifyAdmin(user, epoch).catch(error => {
      if (stopped || epoch !== authEpoch) return;
      authorized = false;
      authorizedUid = null;
      cleanupRealtime();
      emit("OUT", "Saya gagal memverifikasi status Admin.", "SYS_AUTH_CHECK_FAILED", error?.message, { cycleMode: "ERROR" });
    });
  });
  return brain;
}
