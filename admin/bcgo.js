/* BCGO offline-first: cloud modules di-load dinamis agar boot tidak mati jika Firebase/config gagal. */
let collection, onSnapshot, query, orderBy, limit, doc, getDoc, where;
let onAuthStateChanged;
let adminDb = null;
let adminAuth = null;
let createRadarEngine = null;
let __cgoCloudReady = false;
let __cgoCloudError = null;

async function __loadCgoCloud() {
  if (__cgoCloudReady) return true;
  try {
    const fsMod = await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js");
    collection = fsMod.collection;
    onSnapshot = fsMod.onSnapshot;
    query = fsMod.query;
    orderBy = fsMod.orderBy;
    limit = fsMod.limit;
    doc = fsMod.doc;
    getDoc = fsMod.getDoc;
    where = fsMod.where;

    const authMod = await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js");
    onAuthStateChanged = authMod.onAuthStateChanged;

    // Path config: admin/ → ../cikur-config.js (root). Fallback beberapa path.
    let cfg = null;
    const cfgPaths = ["../cikur-config.js", "./cikur-config.js", "/cikur-config.js"];
    let lastCfgErr = null;
    for (const path of cfgPaths) {
      try {
        cfg = await import(path);
        if (cfg && (cfg.adminDb || cfg.adminAuth)) break;
      } catch (e) {
        lastCfgErr = e;
        cfg = null;
      }
    }
    if (!cfg) throw lastCfgErr || new Error("cikur-config.js tidak ditemukan dari admin/");
    adminDb = cfg.adminDb;
    adminAuth = cfg.adminAuth;

    try {
      const radarMod = await import("./cgo-ai-radar.js");
      createRadarEngine = radarMod.createRadarEngine || null;
    } catch (_) {
      createRadarEngine = null;
    }

    __cgoCloudReady = true;
    __cgoCloudError = null;
    if (typeof createRadarEngine === "function") {
      try { radar = createRadarEngine({ maxAgents: AGENT_PRESENCE_LIMIT }); } catch (_) {}
    }
    return true;
  } catch (e) {
    __cgoCloudError = e;
    console.warn("[BCGO] Cloud/config gagal dimuat — mode otonomi lokal saja.", e);
    return false;
  }
}


/*
 * BCGO MASTER NERVE SYSTEM v4.3.1-BOOT-NO-HANG
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
  { file: "admin/bcgo.html", path: "bcgo.html", role: "BCGO Monitor" },
  { file: "admin/bcgo.js", path: "bcgo.js", role: "BCGO Engine" },
  { file: "admin/bcgo-admin.html", path: "bcgo-admin.html", role: "Admin Control" },
  { file: "admin/data-cgo.html", path: "data-cgo.html", role: "Data Console" },
  { file: "cikur-config.js", path: "../cikur-config.js", role: "Auth / Config" },
  { file: "bcgo-engine.js", path: "../bcgo-engine.js", role: "Shared Engine" },
  { file: "admin/cgo-machine-abc.html", path: "cgo-machine-abc.html", role: "Mesin ABC Monitor" },
  { file: "admin/cgo-machine-abc.js", path: "cgo-machine-abc.js", role: "Mesin ABC Core" },
  { file: "admin/cgo-machine-abc-bridge.js", path: "cgo-machine-abc-bridge.js", role: "Mesin ABC Bridge" },
  { file: "admin/cgo-abc-cognition.js", path: "cgo-abc-cognition.js", role: "ABC Cognition" },
  { file: "admin/cgo-ai-browser-adapter.js", path: "cgo-ai-browser-adapter.js", role: "CGO Browser Adapter" },
  { file: "admin/cgo-ai-core.js", path: "cgo-ai-core.js", role: "CGO Core" },
  { file: "admin/cgo-ai-cognition.js", path: "cgo-ai-cognition.js", role: "CGO Cognition" },
  { file: "admin/cgo-ai-guardian.js", path: "cgo-ai-guardian.js", role: "CGO Guardian" },
  { file: "admin/cgo-ai-investigation-engine.js", path: "cgo-ai-investigation-engine.js", role: "CGO Investigation" },
  { file: "admin/cgo-ai-investigator.js", path: "cgo-ai-investigator.js", role: "CGO Investigator" },
  { file: "admin/cgo-ai-knowledge.js", path: "cgo-ai-knowledge.js", role: "CGO Knowledge" },
  { file: "admin/cgo-ai-logic.js", path: "cgo-ai-logic.js", role: "CGO Logic" },
  { file: "admin/cgo-ai-memory.js", path: "cgo-ai-memory.js", role: "CGO Memory" },
  { file: "admin/cgo-ai-runtime-adapter.js", path: "cgo-ai-runtime-adapter.js", role: "CGO Runtime" },
  { file: "admin/cgo-ai-sovereignty.js", path: "cgo-ai-sovereignty.js", role: "CGO Sovereignty" },
  { file: "admin/cgo-ai-radar.js", path: "cgo-ai-radar.js", role: "Radar Engine" },
  { file: "admin/cgo-ai-radar-visual.js", path: "cgo-ai-radar-visual.js", role: "Radar Visual" },
  { file: "admin/cgo-ai-voice-operator.js", path: "cgo-ai-voice-operator.js", role: "Voice Operator" },
  { file: "admin/cikur-go.browser.js", path: "cikur-go.browser.js", role: "Otak Jenius Browser" },
  { file: "admin/cikur-go.js", path: "cikur-go.js", role: "Otak Jenius Core" },
  { file: "admin/cikur-v3-extension.js", path: "cikur-v3-extension.js", role: "Otak Jenius v3" },
  { file: "admin/cgo-instruction.js", path: "cgo-instruction.js", role: "CGO Constitution" },
  { file: "cgo-app-bootstrap.js", path: "../cgo-app-bootstrap.js", role: "Customer Bootstrap" },
  { file: "index.html", path: "../index.html", role: "Customer Home" },
  { file: "customer/food.html", path: "../customer/food.html", role: "Customer Food" },
  { file: "customer/ride.html", path: "../customer/ride.html", role: "Customer Ride" },
  { file: "customer/assistant.html", path: "../customer/assistant.html", role: "Customer Assistant" },
  { file: "customer/cikurgo2in1.html", path: "../customer/cikurgo2in1.html", role: "Customer 2in1" },
  { file: "customer/cgo-customer.js", path: "../customer/cgo-customer.js", role: "Customer Gateway" },
  { file: "customer/cgo-customer-conversation.js", path: "../customer/cgo-customer-conversation.js", role: "Customer Conversation" },
  { file: "customer/cgo-customer-reasoning.js", path: "../customer/cgo-customer-reasoning.js", role: "Customer Reasoning" },
  { file: "customer/cgo-customer-memory.js", path: "../customer/cgo-customer-memory.js", role: "Customer Memory" },
  { file: "customer/cgo-customer-planner.js", path: "../customer/cgo-customer-planner.js", role: "Customer Planner" },
  { file: "customer/cgo-customer-knowledge.js", path: "../customer/cgo-customer-knowledge.js", role: "Customer Knowledge" },
  { file: "customer/cgo-customer-discovery.js", path: "../customer/cgo-customer-discovery.js", role: "Customer Discovery" },
  { file: "customer/cgo-customer-meta.js", path: "../customer/cgo-customer-meta.js", role: "Customer Meta" },
  { file: "customer/cgo-customer-boundary.js", path: "../customer/cgo-customer-boundary.js", role: "Customer Boundary" },
  { file: "customer/cgo-customer-guardian.js", path: "../customer/cgo-customer-guardian.js", role: "Customer Guardian" },
  { file: "customer/cgo-customer-composer.js", path: "../customer/cgo-customer-composer.js", role: "Customer Composer" },
  { file: "mitra/agentcgo.html", path: "../mitra/agentcgo.html", role: "Mitra Agent" },
  { file: "mitra/resto.html", path: "../mitra/resto.html", role: "Mitra Resto" },
  { file: "mitra/driver.html", path: "../mitra/driver.html", role: "Mitra Driver" }
];

const CORE_SOURCE_FILES = new Set([
  "admin/bcgo.html","admin/bcgo.js","admin/cgo-machine-abc.html","admin/cgo-machine-abc.js",
  "admin/cgo-machine-abc-bridge.js","admin/cgo-abc-cognition.js","admin/cgo-ai-browser-adapter.js",
  "admin/cgo-ai-core.js","admin/cgo-ai-cognition.js","admin/cgo-ai-guardian.js","admin/cgo-ai-investigation-engine.js",
  "admin/cgo-ai-investigator.js","admin/cgo-ai-knowledge.js","admin/cgo-ai-logic.js","admin/cgo-ai-memory.js",
  "admin/cgo-ai-runtime-adapter.js","admin/cgo-ai-sovereignty.js","admin/cgo-ai-radar.js","admin/cgo-ai-radar-visual.js",
  "admin/cgo-instruction.js","admin/cikur-go.browser.js","admin/cikur-go.js","admin/cikur-v3-extension.js","admin/cgo-ai-voice-operator.js"
]);

function makeInitialSourceScan() {
  const fileStates = {};
  for (const item of INTERNAL_SOURCE_SCAN) fileStates[item.file] = { status: "QUEUED", message: "Menunggu pembacaan source." };
  return {
    status: "WAITING", phase: "BOOT", totalFiles: INTERNAL_SOURCE_SCAN.length, filesScanned: 0,
    filesReadable: 0, filesFailed: 0, currentFile: null, findings: [], crossFileFindings: [],
    relations: [], relationSummary: { synchronized: 0, mismatch: 0, variant: 0, unknown: 0, linked: 0 },
    coreSummary: { total: CORE_SOURCE_FILES.size, readable: 0, failed: 0, mismatches: 0, status: "WAITING" },
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
const AGENT_PRESENCE_MAX_ACCURACY_M = 500;
function __makeStubRadar() {
  return {
    setOrigin() {},
    setRadiusKm() {},
    ingest() { return { count: 0, freshCount: 0, staleCount: 0, items: [], events: [] }; },
    snapshot() { return { count: 0, freshCount: 0, staleCount: 0, items: [], events: [], status: "STANDBY" }; }
  };
}
let radar = (typeof createRadarEngine === "function")
  ? createRadarEngine({ maxAgents: AGENT_PRESENCE_LIMIT })
  : __makeStubRadar();


const INTERNAL_TELEMETRY_SOURCES = new Set([
  "bcgo.html", "bcgo.js", "bcgo-admin.html", "data-cgo.html",
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

/** Error noise lokal (storage browser, dll) — bukan kerusakan code organ. */
function isNoiseTelemetry(log) {
  const msg = String(log?.message || log?.error || log || "").trim();
  if (/QuotaExceededError|exceeded the quota|Setting the value of ['"]cikur_/i.test(msg)) return true;
  if (/Failed to execute ['"]setItem['"] on ['"]Storage['"]/i.test(msg)) return true;
  if (/NS_ERROR_DOM_QUOTA_REACHED|QUOTA_EXCEEDED_ERR/i.test(msg)) return true;
  // Browser cross-origin sanitized error — tidak ada detail berguna
  if (msg === "Script error." || msg === "Script error") return true;
  // noise internal BCGO mirror
  if (/BCGO cross-tab state mirror|CIKUR_GO_BCGO_STATE/i.test(msg)) return true;
  return false;
}

function isActionableTelemetry(log) {
  return !isNoiseTelemetry(log) && !isInternalTelemetry(log);
}


// BCGO early boot stub (module scope) — tersedia segera saat modul ter-import
try {
  if (typeof globalThis !== "undefined" && !globalThis.BCGOBrain) {
    globalThis.BCGOBrain = {
      version: "module-stub",
      ask: function () { return "BCGO engine sedang diinisialisasi…"; },
      getState: function () { return globalThis.BCGO_STATE || null; },
      getSituation: function () { return "BOOT"; },
      stop: function () {}
    };
  }
} catch (_) {}

export async function runAutonomousEngine(onCycleUpdate) {
  if (typeof onCycleUpdate !== "function") {
    throw new TypeError("BCGO membutuhkan callback UI.");
  }

  // Stub brain SEGERA agar Otak Hub / chat / dashboard tidak menunggu cloud
  if (typeof globalThis !== "undefined" && !globalThis.BCGOBrain) {
    globalThis.BCGOBrain = {
      version: "boot-stub",
      ask: function () { return "BCGO sedang bangun (mode lokal). Tunggu sebentar lalu tanya lagi."; },
      getState: function () { return globalThis.BCGO_STATE || null; },
      getSituation: function () { return "BOOT"; },
      stop: function () {}
    };
    try {
      globalThis.dispatchEvent && globalThis.dispatchEvent(new CustomEvent("cgo:otak-state", { detail: { module: "BCGO_ENGINE", version: "boot-stub" } }));
    } catch (_) {}
  }

  // Coba cloud dengan TIMEOUT — jangan gantung boot selamanya
  let cloudOk = false;
  try {
    cloudOk = await Promise.race([
      __loadCgoCloud(),
      new Promise(function (resolve) {
        setTimeout(function () {
          console.warn("[BCGO] Cloud load timeout 4s — lanjut offline");
          resolve(false);
        }, 4000);
      })
    ]);
  } catch (e) {
    console.warn("[BCGO] Cloud load error:", e);
    cloudOk = false;
  }
  if (!cloudOk) {
    console.warn("[BCGO] Menjalankan tanpa Firebase:", __cgoCloudError?.message || __cgoCloudError || "timeout/offline");
  }


  let stopped = false;
  let authorized = false;
  let localMode = false; // offline autonomy when Super Admin session belum ada
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
  let pendingTelemetry = null;
  let interruptStreak = 0;
  const MAX_CONSECUTIVE_INTERRUPTS = 3;
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
      // Noise storage tidak mengisi peta organ (resto stuck QuotaExceeded)
      if (isNoiseTelemetry(log)) continue;
      const candidates = telemetrySourceCandidates(log);
      const files = candidates.length ? candidates : [normalizeFile(log?.fileName)];
      const tMs = timestamp(log?.reportedAt);
      for (const file of files) {
        if (!ORGAN_REGISTRY[file]) continue;
        const candidate = { log, time: tMs };
        const previous = map.get(file);
        if (!previous || candidate.time >= previous.time) map.set(file, candidate);
      }
    }
    return map;
  }

  function buildOrgans() {
    const recent = newestLogByFile();
    const organs = {};

    for (const [file, meta] of Object.entries(ORGAN_REGISTRY)) {
      const item = recent.get(file);
      // Historis hanya dari log actionable (bukan QuotaExceeded / storage noise)
      const historical = latestSystemLogs.some(log =>
        normalizeFile(log?.fileName) === file && isActionableTelemetry(log)
      );

      if (item && isRecent(item.time) && item.log && isActionableTelemetry(item.log)) {
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

  
  /** Soft: operator wanita umumkan error ber-lokasi (anti-spam 20s). */
  let _lastAttentionAt = 0;
  let _lastAttentionKey = "";
  function cgoAnnounceFromEmit(level, message, code, detail, meta) {
    try {
      if (typeof window === "undefined" || !window.CGOOperatorVoice) return;
      if (typeof window.CGOOperatorVoice.announceAttention !== "function") return;
      const mode = (meta && meta.cycleMode) || level || "";
      if (mode !== "ERROR" && mode !== "WARNING" && level !== "ERROR" && level !== "WARN") return;
      const msg = String(message || detail || "").slice(0, 160);
      const key = String(code || "") + "|" + msg.slice(0, 40);
      const now = Date.now();
      if (key === _lastAttentionKey && now - _lastAttentionAt < 20000) return;
      _lastAttentionKey = key;
      _lastAttentionAt = now;
      // Coba ekstrak nama file dari pesan
      let file = "";
      const m = msg.match(/([\w.\-]+\.(?:js|html|css|json|wasm|onnx))/i);
      if (m) file = m[1];
      window.CGOOperatorVoice.announceAttention({
        kind: (mode === "ERROR" || level === "ERROR") ? "error" : "warning",
        file: file,
        message: msg || String(code || "gangguan sistem")
      }, { skipClip: true });
    } catch (_) {}
  }

function emit(step, message, target, error = null, options = {}) {
    try { cgoAnnounceFromEmit(arguments[0], arguments[1], arguments[2], arguments[3], arguments[4]); } catch (_att) {}

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
      // Hanya refresh ageMs & status — JANGAN drop STANDBY/STALE di tiap cycle
      const refreshed = state.agentPresence.items.map(item => {
        const ageMs = item.updatedAt ? Math.max(0, nowMs - presenceTimestamp(item.updatedAt)) : item.ageMs;
        let status = item.status;
        const hasGeo = !!(item.location && Number.isFinite(item.location.lat));
        if (hasGeo && Number.isFinite(ageMs)) {
          if (ageMs <= AGENT_PRESENCE_MAX_AGE_MS) status = item.available === false ? "BUSY" : "READY";
          else if (ageMs <= AGENT_PRESENCE_MAX_AGE_MS * 2) status = "STALE";
          else status = "STANDBY";
        }
        return { ...item, ageMs, status };
      });
      const withGeo = refreshed.filter(item => item.location && Number.isFinite(item.location.lat));
      state.agentPresence = {
        ...state.agentPresence,
        items: refreshed,
        count: refreshed.length,
        freshCount: refreshed.filter(i => i.status === "READY" || i.status === "BUSY").length,
        staleCount: refreshed.filter(i => i.status === "STALE").length,
        standbyCount: refreshed.filter(i => i.status === "STANDBY").length,
        geoCount: withGeo.length,
        radar: radar.ingest(withGeo, { updatedAt: new Date().toISOString(), reason: "AGE_REFRESH" })
      };
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


  /** Satu otak: bukti BCGO + Otak Jenius → jawaban natural (bukan dua otak terpisah). */
  function naturalizeWithOtak(question, evidenceAnswer) {
    try {
      const CG = (typeof window !== "undefined" && window.CIKURGO) ? window.CIKURGO : null;
      const st = state || {};
      const metrics = st.metrics || {};
      const qRaw = String(question || "").trim();
      const q = qRaw.toLowerCase();
      let text = String(evidenceAnswer || "").trim();

      // Angka → kata (satu-satunya fungsi CIKURGO yang aman untuk mempercantik jawaban bukti)
      const num = (n) => {
        if (CG && typeof CG.angkaKeKata === "function") {
          try {
            const k = CG.angkaKeKata(Number(n) || 0, "id");
            if (k && String(k).trim()) return String(k).trim();
          } catch (_) {}
        }
        return String(n);
      };

      const polish = (s) => String(s || "")
        .replace(/\b(\d{1,3})\s*%/g, (_, d) => num(d) + " persen")
        .replace(/\bcycle\s*#?\s*(\d+)\b/gi, (_, d) => "siklus ke-" + num(d))
        .replace(/\bsiklus\s*#?\s*(\d+)\b/gi, (_, d) => "siklus ke-" + num(d))
        .replace(/\b(\d+)\s+anomali\b/gi, (_, d) => num(d) + " anomali")
        .replace(/\b(\d+)\s+organ\b/gi, (_, d) => num(d) + " organ")
        .replace(/\bUNKNOWN\b/g, "belum diketahui")
        .replace(/\bNULL\b/g, "kosong")
        .replace(/\btrue\b/gi, "ya")
        .replace(/\bfalse\b/gi, "tidak")
        .replace(/\s{2,}/g, " ")
        .trim();

      // TOLAK label klasifikasi nalar (bukan jawaban percakapan)
      const isClassLabel = (s) => {
        const t = String(s || "").trim();
        if (!t) return true;
        if (/^teks\s+(campuran|biasa|kosong)/i.test(t)) return true;
        if (/^(input kosong|empty)/i.test(t)) return true;
        if (/^(angka|romawi|emoji|warna|kode|script_)(\s|,|$)/i.test(t) && t.length < 80) return true;
        if (/^teks campuran:/i.test(t)) return true;
        return false;
      };

      // Sapaan
      if (/^(halo|hai|hallo|helo|hello|hi|hey|pagi|siang|sore|malam)\b/.test(q) || /siapa\s+kamu|kamu\s+siapa/.test(q)) {
        return "Halo, saya CGO Operator. Saya membaca saraf sistem yang sedang hidup — tahap " +
          (st.step || "siaga") + ", siklus ke-" + num(st.cycle || cycleNo || 0) + ".";
      }

      if (/bisa\s*apa|kamu\s*bisa|fitur|kemampuan|bisa\s*bantu/.test(q)) {
        return "Saya bisa membantu status sistem, scanner source, radar agent, hitung angka ke kata, ejaan, dan ringkasan organ.";
      }

      if (/terima kasih|makasih|thanks/.test(q)) {
        return "Sama-sama.";
      }

      // Status
      if (/status|apa kabar|sehatkah|bagaimana sistem|kondisi sistem|sistem aman/.test(q)) {
        const active = metrics.active ?? 0;
        const total = metrics.total ?? 0;
        const healthy = metrics.healthy ?? 0;
        const open = active === 0
          ? "Sistem stabil, tidak ada anomali aktif."
          : "Ada " + num(active) + " anomali aktif dari " + num(total) + " organ.";
        return open + " Tahap " + (st.step || "—") + ", " + num(healthy) + " organ sehat, scanner " +
          ((st.sourceScan && st.sourceScan.status) || "—") + ".";
      }

      // Sedang apa
      if (/sedang apa|lagi apa|ngapain|kerja apa|apa yang (sedang )?kamu (kerjakan|lakukan)/.test(q)) {
        return "Saya sedang di tahap " + (st.step || "siaga") + ", siklus ke-" + num(st.cycle || 0) +
          ". " + (st.message ? String(st.message).slice(0, 160) : "Memantau telemetry dan source scan.");
      }

      // Jika evidence kosong
      if (!text) {
        return "Saya sudah baca permintaanmu, tetapi bukti live belum cukup untuk menjawab itu.";
      }

      // Buang bila evidence sendiri adalah label klasifikasi (regresi lama)
      if (isClassLabel(text)) {
        return "Saya memahami arah pertanyaanmu, tapi belum bisa menjawabnya dengan pasti. Bisa dijelaskan sedikit lagi?";
      }

      return polish(text);
    } catch (_) {
      return evidenceAnswer;
    }
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

    if (/^(halo|hai|hallo|helo|hello|hi|hey|pagi|siang|sore|malam)\b/.test(q) || /siapa kamu|kamu siapa/.test(q)) {
      return `Halo. Saya CGO di tahap ${state.step}, siklus ${cycleNo}. ${situation()}`;
    }

    if (/scan ulang|rescan|pindai ulang|periksa ulang/.test(q)) {
      recordEvent("CHAT_COMMAND", "Anda meminta pemeriksaan ulang telemetry.", "SYS_CHAT_RESCAN");
      emit("IN", "Saya menerima perintah pemeriksaan ulang. Saya membaca ulang telemetry yang tersedia sekarang.", "SYS_CHAT_RESCAN", null, { cycleMode: "CHAT_COMMAND" });
      return `Baik. Saya mulai pemeriksaan ulang. Saat ini ${metrics.active} anomali aktif dari ${metrics.total} organ.`;
    }

    if (/sedang apa|sedang mengerjakan|lagi apa|ngapain|kerja apa/.test(q)) {
      return `Saya sedang berada di tahap ${state.step}, cycle #${cycleNo}. ${state.message} ${situation()}`;
    }

    // Radar / agent terdekat
    if (/agent|radar|terdekat|nearby|radius|gps|lokasi agent/.test(q)) {
      const ap = state.agentPresence || {};
      const items = Array.isArray(ap.items) ? ap.items : [];
      const withGeo = items.filter(i => i.location && Number.isFinite(i.location.lat));
      if (!items.length) {
        return `Radar LIVE, tetapi belum ada Agent approved yang online. Minta Agent buka mitra/agentcgo.html → AKTIFKAN + izinkan lokasi. Saat ini TOTAL=${ap.count||0}, READY=${ap.freshCount||0}, GEO=${ap.geoCount||0}.`;
      }
      const lines = items.slice(0, 8).map(i => {
        const loc = i.location;
        const dist = loc ? "ada GPS" : "tanpa GPS";
        return `· ${i.name || "Agent"} [${i.status}] ${dist}`;
      });
      return `Radar Agent CGO: TOTAL ${items.length}, READY ${ap.freshCount||0}, GEO ${withGeo.length}, STALE ${ap.staleCount||0}.\n${lines.join("\n")}\nStatus sensor: ${ap.status || "-"}.`;
    }

    // Scanner / source integrity
    if (/scan|scanner|source|integrity|file sehat|kode|source code/.test(q)) {
      const sc = state.sourceScan || {};
      const states = sc.fileStates || {};
      const clean = Object.values(states).filter(s => s?.status === "CLEAN").length;
      const review = Object.values(states).filter(s => s?.status === "REVIEW").length;
      const failed = Object.values(states).filter(s => s?.status === "FAILED").length;
      const changed = Object.entries(states).filter(([,s]) => String(s?.message||"").includes("DIROMBAK")).map(([f]) => f);
      return `Scanner: status ${sc.status||"-"}, fase ${sc.phase||"-"}, terbaca ${sc.filesReadable||0}/${sc.totalFiles||0}, gagal ${failed}, review ${review}, bersih ${clean}. Relasi linked ${sc.relationSummary?.linked||0}. ${changed.length ? "File dirombak terdeteksi: " + changed.join(", ") + "." : "Belum ada file yang berubah sejak scan sebelumnya."} Scanner ulang otomatis tiap ~75 detik.`;
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

    // Keyword umum "jelaskan/detail" jangan menelan objek spesifik (radar/scanner/saraf)
    if (/jelaskan|detail|rincian/.test(q)) {
      if (/radar|agent|gps|radius|terdekat/.test(q)) {
        const ap = state.agentPresence || {};
        return `Radar Agent CGO: TOTAL ${ap.count||0}, READY ${ap.freshCount||0}, GEO ${ap.geoCount||0}, STALE ${ap.staleCount||0}. Sensor: ${ap.status||"-"}. Pusat GPS admin harus terverifikasi; TOTAL ≠ otomatis dalam radius.`;
      }
      if (/scan|scanner|source|integrity/.test(q)) {
        const sc = state.sourceScan || {};
        return `Scanner source: status ${sc.status||"-"}, fase ${sc.phase||"-"}, terbaca ${sc.filesReadable||0}/${sc.totalFiles||0}, synchronized ${sc.relationSummary?.synchronized||0}, linked ${sc.relationSummary?.linked||0}, mismatch ${sc.relationSummary?.mismatch||0}. READABLE ≠ SYNCHRONIZED.`;
      }
      if (/saraf|nerve|organ/.test(q)) {
        const nerves = state.fileNerves || {};
        const lines = Object.keys(ORGAN_REGISTRY).slice(0, 12).map(f => `· ${f}: ${nerves[f]?.health?.overall || "UNKNOWN"}`);
        return `Peta saraf:\n${lines.join("\n")}`;
      }
      return `Saya bisa menjelaskan berdasarkan bukti. Saat ini: ${metrics.active} anomali aktif, ${metrics.recovered} recovered, Firestore ${firestore.connected ? "LIVE" : "belum LIVE"}, target ${state.targetCell}. Untuk detail, sebutkan objek: radar, scanner, saraf, file, atau telemetry.`;
    }

    // Saraf / nerve per file
    if (/saraf|nerve|organ|kesehatan file|status file/.test(q)) {
      const nerves = state.fileNerves || {};
      const organs = buildOrgans();
      const lines = Object.keys(ORGAN_REGISTRY).map(f => {
        const n = nerves[f];
        const o = organs[f];
        const h = n?.health?.overall || o?.state || "UNKNOWN";
        return `· ${f}: ${h}`;
      });
      return `Peta saraf (basename organ):\n${lines.join("\n")}\nAnomali aktif dari telemetry: ${Object.values(organs).filter(o=>o.state==="ACTIVE").length}.`;
    }

    return `Saya menangkap pertanyaanmu: “${raw}”. Saya belum punya bukti spesifik. Tanyakan: status sistem, error, file tertentu, scanner, radar/agent terdekat, saraf/organ, telemetry terakhir, atau cycle.`;
  }

  function interruptForTelemetry(fileName, message, log) {
    if (stopped || !authorized) return;
    if (isNoiseTelemetry(log) || isNoiseTelemetry(message)) return;

    const file = normalizeFile(fileName);
    const text = String(message || "Sinyal telemetry baru diterima.").slice(0, 900);
    const at = timestamp(log?.reportedAt) || Date.now();
    const signature = `${file}|${text}|${at}`;

    // Jangan membatalkan pemeriksaan yang sedang berjalan. Simpan hanya bukti
    // telemetry terbaru; setelah interrupt selesai, bukti ini akan diproses.
    if (signature === previousTopSignature && !pendingTelemetry) return;
    previousTopSignature = signature;

    if (realtimeBusy) {
      pendingTelemetry = { file, text, at, log };
      return;
    }

    realtimeBusy = true;
    interruptStreak++;
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

        phaseIndex = 3;

        const pending = pendingTelemetry;
        pendingTelemetry = null;
        if (pending && interruptStreak < MAX_CONSECUTIVE_INTERRUPTS) {
          // Coalesce telemetry terbaru, tetapi beri batas agar telemetry tidak
          // dapat menguasai scheduler selamanya.
          realtimeBusy = false;
          interruptForTelemetry(pending.file, pending.text, pending.log);
          return;
        }

        // Fairness boundary: setelah N interrupt beruntun, wajib kembali ke
        // OUT/cycle normal. Bukti terbaru tidak hilang dari state telemetry;
        // ia akan menjadi kandidat interrupt berikutnya setelah scheduler normal.
        realtimeBusy = false;
        interruptStreak = 0;
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
    const hasGeo = Number.isFinite(lat) && Number.isFinite(lng);
    const accuracy = Number(location?.accuracy);
    if (hasGeo && Number.isFinite(accuracy) && accuracy > AGENT_PRESENCE_MAX_ACCURACY_M) return null;
    const updatedMs = presenceTimestamp(presence.updatedAt || data.updatedAt || data.lastStatusChangeAt);
    const age = updatedMs ? Math.max(0, Date.now() - updatedMs) : Infinity;
    const isOnlineFlag = data.isOnline === true || data.operationalStatus === "online" || presence.active === true;
    // Live GPS dalam window fresh → READY/BUSY; online tanpa GPS → STANDBY; offline lama → skip
    if (!isOnlineFlag && !hasGeo) return null;
    if (hasGeo && age > AGENT_PRESENCE_MAX_AGE_MS * 4 && !isOnlineFlag) return null;
    let status = "STANDBY";
    if (hasGeo && age <= AGENT_PRESENCE_MAX_AGE_MS) {
      status = presence.available === false ? "BUSY" : "READY";
    } else if (hasGeo && age <= AGENT_PRESENCE_MAX_AGE_MS * 2) {
      status = "STALE";
    } else if (isOnlineFlag) {
      status = "STANDBY"; // online, belum ada koordinat live
    } else {
      return null;
    }
    return {
      id: docSnap.id,
      agentId: String(data.uid || docSnap.id.replace(/_agent$/, "")),
      name: String(data.namaPanggilan || data.name || data.agentName || "Agent CGO"),
      type: "agent",
      status,
      active: status === "READY" || status === "BUSY" || status === "STALE" || status === "STANDBY",
      available: presence.available !== false && data.isOnline !== false,
      location: hasGeo ? { lat, lng, accuracy: Number.isFinite(accuracy) ? accuracy : null } : null,
      updatedAt: presence.updatedAt || data.updatedAt || data.lastStatusChangeAt || null,
      ageMs: Number.isFinite(age) ? age : null,
      source: "BCGO_AGENT_PRESENCE_REALTIME"
    };
  }

  function startAgentPresence() {
    if (!adminDb || !__cgoCloudReady) return;
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
        // Dedup by agentId — ambil yang paling fresh (hindari double jarak / double blip)
        {
          const byId = new Map();
          for (const it of items) {
            const key = String(it.agentId || it.id || "");
            if (!key) continue;
            const prev = byId.get(key);
            if (!prev || (Number(it.ageMs) || Infinity) < (Number(prev.ageMs) || Infinity)) {
              byId.set(key, it);
            }
          }
          items.length = 0;
          items.push(...byId.values());
        }
        items.sort((a,b) => a.agentId.localeCompare(b.agentId));
        const withGeo = items.filter(item => item.location && Number.isFinite(item.location.lat));
        const freshCount = items.filter(item => item.status === "READY" || item.status === "BUSY").length;
        const staleCount = items.filter(item => item.status === "STALE").length;
        const standbyCount = items.filter(item => item.status === "STANDBY").length;
        state.agentPresence = {
          status: "LIVE",
          connected: true,
          count: items.length,
          freshCount,
          staleCount,
          standbyCount,
          geoCount: withGeo.length,
          lastServerAt: Date.now(),
          items: items.slice(0, AGENT_PRESENCE_LIMIT)
        };
        state.agentPresence.items = state.agentPresence.items.map(item => ({
          ...item,
          ageMs: item.updatedAt ? Math.max(0, Date.now() - presenceTimestamp(item.updatedAt)) : item.ageMs
        }));
        // Radar engine hanya ingest yang punya koordinat
        state.agentPresence.radar = radar.ingest(withGeo, { updatedAt: new Date().toISOString(), reason: "FIRESTORE_SNAPSHOT" });
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
    pendingTelemetry = null;
    interruptStreak = 0;
    if (sourceScanController) { try { sourceScanController.abort(); } catch (_) {} sourceScanController = null; }
    clearTimeout(cycleTimer);
    clearTimeout(interruptTimerProcess);
    clearTimeout(interruptTimerReview);
    clearInterval(refreshTimer);
    clearInterval(sourceScanTimer);
    sourceScanTimer = null;
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
    if (!adminDb || !__cgoCloudReady) return;
    const listenerEpoch = authEpoch;
    // PENTING: pakai adminDb + adminAuth, bukan CikurCloud.listenSystemLogs
    // (yang memakai customerDb tanpa token Super Admin → permission denied / sensor mati).
    if (typeof unsubscribeSystemLogs === "function") unsubscribeSystemLogs();
    try {
      const q = query(
        collection(adminDb, "system_logs"),
        orderBy("reportedAt", "desc"),
        limit(LOG_LIMIT)
      );
      unsubscribeSystemLogs = onSnapshot(q, snapshot => {
        if (stopped || !authorized || listenerEpoch !== authEpoch) return;
        const rawLogs = [];
        snapshot.forEach(docSnap => {
          rawLogs.push({ id: docSnap.id, ...docSnap.data() });
        });
        // Filter: internal BCGO + noise storage (QuotaExceeded) jangan menguasai sensor.
        latestSystemLogs = rawLogs
          .filter(log => !isInternalTelemetry(log) && !isNoiseTelemetry(log))
          .slice(0, LOG_LIMIT);
        // Untuk tampilan "Telemetry: xxx" pilih log actionable terbaru, bukan noise resto.
        const top = latestSystemLogs[0] || null;
        const topAt = timestamp(top?.reportedAt);
        const previousTop = previousTopSignature;

        const organs = buildOrgans();
        state.systemOrgans = organs;
        state.metrics = makeMetrics(organs);
        state.activeCases = makeCases(organs);
        // Panel error: tampilkan actionable; noise tetap bisa di-debug di console saja
        state.systemLogs = latestSystemLogs.slice();
        if (top) {
          state.lastTelemetryFile = telemetrySourceCandidates(top)[0] || normalizeFile(top.fileName);
          state.lastTelemetryAt = topAt || state.lastTelemetryAt;
          state.lastTelemetryMessage = top?.message || state.lastTelemetryMessage;
        }
        window.BCGO_STATE = safeClone(state);

        const topFile = top ? (telemetrySourceCandidates(top)[0] || normalizeFile(top.fileName)) : null;
        // Interrupt cycle hanya untuk sinyal actionable — jangan stuck di QuotaExceeded resto
        if (top && topFile && `${topFile}|${String(top.message || "")}|${topAt}` !== previousTop) {
          interruptForTelemetry(topFile, top.message, top);
        } else {
          publishToUI(safeClone(state));
        }
      }, error => {
        if (stopped || !authorized || listenerEpoch !== authEpoch) return;
        emit("PROCESS", "Kanal telemetry system_logs gagal (adminDb).", "SYS_SYSTEM_LOGS_LISTENER", error?.message, { cycleMode: "ERROR" });
      });
    } catch (error) {
      emit("PROCESS", "Kanal telemetry lintas-file gagal dibuka.", "SYS_SYSTEM_LOGS_LISTENER", error?.message, { cycleMode: "ERROR" });
    }
  }

  function startFirestoreProbe() {
    if (!adminDb || !__cgoCloudReady) return;
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

  // BCGO-owned source absorption cache.
  // Repaired source stays in the active BCGO runtime path for the next scan cycle.
  // No OPFS/localStorage/service/external persistence is introduced.
  const sourceRepairCache = new Map();

  let sourceScanInFlight = false;
  let sourceScanTimer = null;
  let sourceScanController = null;

  function getRepairBridge() {
    try { return globalThis.CGOMachineABCBridge || null; } catch (_) { return null; }
  }

  function fingerprintSource(value) {
    const text = String(value ?? "");
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  }

  function recordRepairRuntime(file, result, sourceText, postRepair) {
    const patched = result?.patchedText;
    if (!result || result.status !== "REPAIRED" || result.verified !== true || typeof patched !== "string" || !patched.trim()) return null;
    const entry = {
      file,
      status: "REPAIRED",
      candidate: result.candidate?.id || null,
      verified: true,
      beforeFingerprint: result.beforeFingerprint || null,
      afterFingerprint: result.afterFingerprint || null,
      sourceLength: String(sourceText || "").length,
      patchedLength: patched.length,
      postRepairStatus: postRepair?.status || null,
      postRepairAudit: postRepair?.audit || null,
      postRepairRoute: postRepair?.route || null,
      appliedAt: new Date().toISOString()
    };
    sourceRepairCache.set(file, {
      verified: true,
      candidate: entry.candidate,
      originFingerprint: fingerprintSource(sourceText),
      afterFingerprint: entry.afterFingerprint,
      patchedText: patched,
      postRepairVerified: !!entry.postRepairVerified,
      postRepairAudit: entry.postRepairAudit || null,
      updatedAt: entry.appliedAt
    });

    state.repairRuntime = {
      ...(state.repairRuntime || {}),
      status: "REPAIRED",
      cycle: Number(state.cycle || 0),
      repaired: Number(state.repairRuntime?.repaired || 0) + 1,
      verified: Number(state.repairRuntime?.verified || 0) + 1,
      targets: { ...(state.repairRuntime?.targets || {}), [file]: entry }
    };
    return entry;
  }

  async function runInternalSourceScan() {
    if (!canRun() || sourceScanInFlight) return;
    sourceScanInFlight = true;
    if (sourceScanController) { try { sourceScanController.abort(); } catch (_) {} }
    sourceScanController = new AbortController();
    const scanSignal = sourceScanController.signal;
    // Simpan snapshot scan sebelumnya sebelum state.sourceScan diganti.
    // Ini adalah sumber kebenaran untuk deteksi DIROMBAK pada scan berikutnya.
    const previousScan = state.sourceScan && typeof state.sourceScan === "object"
      ? safeClone(state.sourceScan)
      : makeInitialSourceScan();
    const scan = makeInitialSourceScan();
    scan.status = "SCANNING";
    scan.phase = "READING";
    state.sourceScan = scan;
    publishToUI(safeClone(state));

    const contents = new Map();
    for (let i = 0; i < INTERNAL_SOURCE_SCAN.length; i++) {
      if (!canRun()) { sourceScanInFlight = false; return; }
      const item = INTERNAL_SOURCE_SCAN[i];
      scan.currentFile = item.file;
      scan.phase = "READING";
      scan.fileStates[item.file] = { status: "READING", message: "Membaca source live dari origin aplikasi." };
      publishToUI(safeClone(state));
      try {
        const response = await fetch(new URL(item.path, location.href).href, { cache: "no-store", signal: scanSignal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const fetchedText = await response.text();
        if (!fetchedText.trim()) throw new Error("SOURCE_EMPTY");

        // If the live origin still matches the source fingerprint that produced
        // a verified repair, BCGO re-absorbs the already repaired FULL SOURCE
        // before analysis. This keeps the repair inside the BCGO source path
        // without introducing OPFS/localStorage or a parallel executor.
        const cachedRepair = sourceRepairCache.get(item.file);
        let text = fetchedText;
        if (
          cachedRepair &&
          cachedRepair.verified === true &&
          cachedRepair.originFingerprint === fingerprintSource(fetchedText) &&
          typeof cachedRepair.patchedText === "string" &&
          cachedRepair.patchedText.trim()
        ) {
          text = cachedRepair.patchedText;
          scan.fileStates[item.file] = {
            status: "REPAIRED_ABSORBED",
            message: `${text.length.toLocaleString("id-ID")} karakter · FULL PATCH terserap kembali ke jalur BCGO.`,
            contentHash: cachedRepair.afterFingerprint || null,
            changed: true,
            repair: {
              candidate: cachedRepair.candidate || null,
              verified: true,
              postRepairVerified: cachedRepair.postRepairVerified === true,
              audit: cachedRepair.postRepairAudit || null,
              absorbed: true
            }
          };
        }

        contents.set(item.file, text);
        scan.filesReadable++;
        scan.filesScanned++;
        // Pemeriksaan isi — hanya isu nyata, jangan false-positive massal
        const issues = [];
        // Path legacy yang benar-benar masih di-import (bukan string di komentar panjang)
        if (/(?:src|href|from|import)\s*[=:(\s]*["'][^"']*(?:\/brain\/|\/shared\/)[^"']*["']/.test(text)) {
          issues.push("legacy-path");
        }
        if (/\.html$/i.test(item.file)) {
          const opens = (text.match(/<(?:div|section|main|article)\b/gi) || []).length;
          const closes = (text.match(/<\/(?:div|section|main|article)>/gi) || []).length;
          if (opens > closes + 12) issues.push("html-unbalanced");
        }
        // Hash konten untuk deteksi rombak file
        let hash = 0;
        for (let h = 0; h < text.length; h++) hash = ((hash << 5) - hash + text.charCodeAt(h)) | 0;
        const contentHash = String(hash);
        const prevHash = previousScan?.fileStates?.[item.file]?.contentHash;
        const changed = Boolean(prevHash && prevHash !== contentHash);
        if (changed) {
          recordEvent("SOURCE_CHANGED", `Source ${item.file} berubah — saraf disesuaikan ulang.`, item.file.split("/").pop());
        }
        let repairResult = null;
        let postRepair = null;
        if (
          /\.(?:js|html)$/i.test(item.file)
        ) {
          const bridge = getRepairBridge();
          if (bridge && typeof bridge.repairSource === "function") {
            try {
              repairResult = bridge.repairSource(text, { source: item.file, autoApply: true, fullAudit: true });
              if (repairResult?.status === "REPAIRED" && repairResult.verified === true && typeof repairResult.patchedText === "string") {
                // PATCH FULL SOURCE kembali ke alur BCGO saat ini — tanpa OPFS/runtime storage paralel.
                const originalText = text;
                text = repairResult.patchedText;
                contents.set(item.file, text);
                postRepair = typeof bridge.analyze === "function"
                  ? bridge.analyze(text, { source: item.file, fullAudit: true, autoReflect: false, maxCycles: 1 })
                  : null;
                const entry = recordRepairRuntime(item.file, repairResult, originalText, postRepair);
                const verifiedPost = !!(postRepair && postRepair.ok && postRepair.audit?.status === "VALID");
                if (entry) {
                  entry.postRepairVerified = verifiedPost;
                  entry.postRepairStatus = postRepair?.status || null;
                  entry.postRepairAudit = postRepair?.audit?.status || postRepair?.audit || null;
                  entry.postRepairRoute = postRepair?.packet?.cycles?.[0]?.pipeline
                    ? Object.entries(postRepair.packet.cycles[0].pipeline).filter(([k,v]) => ["A","B","C","D"].includes(k) && v).map(([k]) => k).join(">")
                    : null;
                  const cached = sourceRepairCache.get(item.file);
                  if (cached) {
                    cached.postRepairVerified = verifiedPost;
                    cached.postRepairAudit = entry.postRepairAudit;
                    cached.postRepairRoute = entry.postRepairRoute;
                    cached.patchedText = text;
                    cached.afterFingerprint = repairResult.afterFingerprint || cached.afterFingerprint;
                  }
                }
                scan.fileStates[item.file] = {
                  status: verifiedPost ? "REPAIRED_VERIFIED" : "REPAIRED_REVIEW",
                  message: `${text.length.toLocaleString("id-ID")} karakter · ${repairResult.candidate?.id || "REPAIR"} · FULL PATCH → SERAP ULANG → POST-REPAIR ${verifiedPost ? "VERIFIED" : "REVIEW"}`,
                  issues,
                  contentHash: repairResult.afterFingerprint || contentHash,
                  changed: true,
                  repair: {
                    candidate: repairResult.candidate?.id || null,
                    verified: repairResult.verified === true,
                    postRepairVerified: verifiedPost,
                    audit: postRepair?.audit?.status || postRepair?.audit || null
                  }
                };
                scan.findings.push({
                  type: "SOURCE_REPAIRED",
                  severity: verifiedPost ? "INFO" : "MEDIUM",
                  sourceFile: item.file,
                  message: `Full patch ${repairResult.candidate?.id || "REPAIR"} dikembalikan ke source aktif BCGO dan diserap ulang.`,
                  repair: scan.fileStates[item.file].repair
                });
              }
            } catch (repairError) {
              repairResult = { status: "REPAIR_ERROR", error: String(repairError?.message || repairError).slice(0, 240) };
            }
          }
        }

        if (repairResult?.status === "REPAIRED" && repairResult.verified === true) {
          // Jangan timpa hasil repair dengan CLEAN/REVIEW pada cabang scanner biasa.
        } else if (issues.length) {
          scan.fileStates[item.file] = {
            status: "REVIEW",
            message: `${text.length.toLocaleString("id-ID")} karakter · pantau: ${issues.join(", ")}${changed ? " · DIROMBAK" : ""}`,
            issues,
            contentHash,
            changed
          };
          scan.findings.push({
            type: "SOURCE_REVIEW",
            severity: "LOW",
            sourceFile: item.file,
            message: `Source terbaca, perlu pantau: ${issues.join(", ")}`
          });
        } else {
          scan.fileStates[item.file] = {
            status: "CLEAN",
            message: `${text.length.toLocaleString("id-ID")} karakter · sehat${changed ? " · DIROMBAK & sinkron" : ""}`,
            contentHash,
            changed
          };
        }
      } catch (error) {
        if (error?.name === "AbortError") {
          sourceScanInFlight = false;
          sourceScanController = null;
          return;
        }
        scan.filesFailed++;
        scan.filesScanned++;
        scan.fileStates[item.file] = { status: "FAILED", message: String(error?.message || error).slice(0,180) };
        scan.findings.push({ type: "SOURCE_UNREADABLE", severity: "HIGH", sourceFile: item.file, message: `Source tidak dapat dibaca: ${String(error?.message || error).slice(0,240)}` });
      }
      publishToUI(safeClone(state));
    }

    scan.phase = "ANALYZING";
    const relations = [];
    // Semua source internal pada registry dibaca relatif terhadap halaman
    // BCGO yang hidup di /admin/. Dengan begitu `cgo-*.js` tetap /admin/*,
    // sedangkan referensi `../cikur-config.js` tetap naik ke root.
    const rootUrl = new URL("./", location.href).href;
    for (const item of INTERNAL_SOURCE_SCAN) {
      const text = contents.get(item.file);
      if (!text) continue;
      const refs = [];
      const re = /(?:\b(?:src|href)\s*=\s*["']([^"']+)["'])|(?:\b(?:from|import)\s*["']([^"']+)["'])/g;
      let m;
      while ((m = re.exec(text))) refs.push(m[1] || m[2]);
      for (const ref of refs) {
        if (!ref || /^(https?:|data:|#|javascript:)/i.test(ref)) continue;
        const cleanRef = String(ref).split("#")[0].split("?")[0];
        let target;
        try { target = new URL(cleanRef, new URL(item.path, rootUrl)).pathname.replace(/^\//, ""); } catch { continue; }
        if (target.startsWith("cikur-ai/")) target = target.slice("cikur-ai/".length);
        const base = target.split("/").pop();
        const matched = INTERNAL_SOURCE_SCAN.find(x => x.path === target || x.file === target || x.file.endsWith("/" + base) || x.file === base || x.path.endsWith("/" + base));
        if (matched) relations.push({ type: "CROSS_FILE_SURFACE", status: "LINKED", confidence: "VERIFIED", sourceFile: item.file, targetFile: matched.file, key: cleanRef });
        else if (/\.(?:html|js)$/i.test(target) && !/tailwind|leaflet|firebase|googleapis|cdn\./i.test(target)) {
          // Modul CGO companion (emosi/narasi/otak/audio/semantic) — ada di repo, bukan mismatch
          const companion = /cgo-(emosi|narasi|otak|semantic|audio|machine|abc|instruction|ai-voice|shared|app-bootstrap)|cikur-go/i.test(base || target);
          const optional = /cgo-customer|cgo-app-bootstrap|cikur-go|cgo-ai-voice/i.test(target);
          relations.push({
            type: "CROSS_FILE_SURFACE",
            status: companion || optional ? "LINKED" : "UNKNOWN",
            confidence: companion || optional ? "VERIFIED" : "UNKNOWN",
            sourceFile: item.file,
            targetFile: target,
            key: cleanRef
          });
        }
      }
    }
    // Explicit internal contracts that must remain wired.
    const contracts = [
      ["admin/bcgo.html", "admin/bcgo.js", "BCGO_ENGINE_IMPORT"],
      ["admin/cgo-error-dashboard.html", "admin/cgo-error-dashboard.js", "ERROR_DASHBOARD"],
      ["admin/bcgo.js", "cikur-config.js", "ADMIN_AUTH_CONFIG"],
      ["admin/bcgo-admin.html", "cikur-config.js", "ADMIN_AUTH_CONFIG"],
      ["admin/data-cgo.html", "cikur-config.js", "ADMIN_AUTH_CONFIG"],
      ["admin/bcgo.js", "cgo-ai-radar.js", "RADAR_ENGINE"],
      ["index.html", "customer/cgo-customer.js", "CUSTOMER_GATEWAY"],
      ["index.html", "cgo-app-bootstrap.js", "CUSTOMER_BOOTSTRAP"],
      ["index.html", "cikur-config.js", "CUSTOMER_CONFIG"],
      ["customer/food.html", "cikur-config.js", "CUSTOMER_CONFIG"],
      ["customer/ride.html", "cikur-config.js", "CUSTOMER_CONFIG"],
      ["mitra/agentcgo.html", "cikur-config.js", "MITRA_CONFIG"],
      ["mitra/driver.html", "cikur-config.js", "MITRA_CONFIG"],
      ["mitra/resto.html", "cikur-config.js", "MITRA_CONFIG"]
    ];
    for (const [a,b,key] of contracts) {
      const text=contents.get(a)||"";
      const ok = text.includes(b.split('/').pop()) || (b === "cikur-config.js" && (text.includes("../cikur-config.js") || text.includes("cikur-config.js"))) || (b === "admin/bcgo.js" && text.includes("./bcgo.js"));
      relations.push({ type:"CROSS_FILE_CONTRACT", status: ok ? "LINKED" : "MISMATCH", confidence: ok ? "VERIFIED" : "HIGH", sourceFile:a, targetFile:b, key, evidence:{ missingSemantic: ok ? [] : [key] } });
    }
    scan.relations = relations;
    scan.relationSummary.linked = relations.filter(r=>r.status === "LINKED").length;
    scan.relationSummary.mismatch = relations.filter(r=>r.status === "MISMATCH").length;
    scan.relationSummary.unknown = relations.filter(r=>r.status === "UNKNOWN").length;
    scan.relationSummary.variant = relations.filter(r=>r.status === "VARIANT").length;
    // SYNCHRONIZED hanya berarti source terbaca dan tidak memiliki kontrak
    // mismatch/unknown yang terkait. READABLE != SYNCHRONIZED.
    // READABLE ≠ SYNCHRONIZED: butuh minimal 1 relasi LINKED + tanpa MISMATCH/UNKNOWN
    scan.relationSummary.synchronized = INTERNAL_SOURCE_SCAN.filter(item => {
      const fs = scan.fileStates[item.file];
      if (!fs || fs.status === "FAILED") return false;
      const related = relations.filter(r => r.sourceFile === item.file || r.targetFile === item.file);
      if (!related.length) return false; // terbaca saja ≠ tersinkron
      if (related.some(r => r.status === "MISMATCH" || r.status === "UNKNOWN")) return false;
      return related.some(r => r.status === "LINKED");
    }).length;
    scan.crossFileFindings = relations.filter(r=>r.status === "MISMATCH");
    const coreItems = INTERNAL_SOURCE_SCAN.filter(item => CORE_SOURCE_FILES.has(item.file));
    const coreReadable = coreItems.filter(item => scan.fileStates[item.file]?.status && scan.fileStates[item.file].status !== "FAILED").length;
    const coreFailed = coreItems.filter(item => scan.fileStates[item.file]?.status === "FAILED").length;
    const coreMismatch = relations.filter(r => (CORE_SOURCE_FILES.has(r.sourceFile) || CORE_SOURCE_FILES.has(r.targetFile)) && r.status === "MISMATCH").length;
    scan.coreSummary = { total: coreItems.length, readable: coreReadable, failed: coreFailed, mismatches: coreMismatch, status: coreFailed || coreMismatch ? "ATTENTION" : (coreReadable === coreItems.length ? "HEALTHY" : "PARTIAL") };
    const allFetchFailed = scan.filesReadable === 0 && scan.filesFailed === scan.totalFiles;
    scan.status = allFetchFailed ? "SCANNER_UNAVAILABLE" : (scan.filesFailed || scan.relationSummary.mismatch ? "DEGRADED" : "CLEAN");
    scan.phase = "COMPLETE";
    scan.currentFile = null;
    scan.message = allFetchFailed
      ? "Scanner source tidak tersedia — BCGO source scanner membutuhkan HTTP(S) server, bukan file://."
      : scan.status === "CLEAN"
        ? `Source internal live selesai dibaca: ${scan.filesReadable}/${scan.totalFiles} file dan ${scan.relationSummary.linked} relasi terverifikasi.`
        : `Source internal selesai dengan ${scan.filesFailed} file gagal dibaca dan ${scan.relationSummary.mismatch} kontrak mismatch.`;
    const nerves = {};
    for (const item of INTERNAL_SOURCE_SCAN) {
      const fs = scan.fileStates[item.file];
      const organKey = item.file.split("/").pop();
      const related = relations.filter(r => r.sourceFile === item.file || r.targetFile === item.file);
      const hasMismatch = related.some(r => r.status === "MISMATCH");
      const hasUnknown = related.some(r => r.status === "UNKNOWN");
      const overall = fs?.status === "FAILED" || hasMismatch ? "ANOMALY" : fs?.status === "REVIEW" || hasUnknown ? "REVIEW" : "HEALTHY";
      // DEP/CTR berbasis evidence saja — tidak pernah label "VERIFIED" palsu
      const hasLinked = related.some(r => r.status === "LINKED");
      const dependency = fs?.status === "FAILED" ? "UNREADABLE"
        : hasUnknown ? "UNKNOWN"
        : hasLinked ? "OBSERVED"
        : related.length ? "PARTIAL"
        : "UNOBSERVED";
      const contract = hasMismatch ? "MISMATCH"
        : hasUnknown ? "UNKNOWN"
        : hasLinked ? "LINKED"
        : "UNOBSERVED";
      nerves[organKey] = {
        health: {
          overall,
          source: fs?.status === "FAILED" ? "UNREADABLE" : fs?.status || "UNKNOWN",
          runtime: "NOT_OBSERVED",
          dependency,
          contract
        },
        source: { readable: fs?.status !== "FAILED", status: fs?.status || "UNKNOWN", message: fs?.message || "" },
        runtime: { active: false, observed: false },
        evidenceSummary: {
          relations: related.length,
          unresolved: related.filter(r => r.status === "UNKNOWN" || r.status === "MISMATCH").length
        },
        contentHash: fs?.contentHash || null,
        changed: Boolean(fs?.contentHash && previousScan?.fileStates?.[item.file]?.contentHash && fs.contentHash !== previousScan.fileStates[item.file].contentHash)
      };
    }
    const uniqueNerves = Object.values(nerves);
    scan.nerveSummary.healthy = uniqueNerves.filter(n=>n.health.overall === "HEALTHY").length;
    scan.nerveSummary.anomaly = uniqueNerves.filter(n=>n.health.overall === "ANOMALY").length;
    scan.nerveSummary.review = uniqueNerves.filter(n=>n.health.overall === "REVIEW").length;
    scan.nerveSummary.unresolved = uniqueNerves.filter(n=>Number(n.evidenceSummary?.unresolved) > 0).length;
    state.fileNerves = nerves;
    state.sourceScan = scan;
    publishToUI(safeClone(state));

    // CLOSED LOOP: setelah BCGO selesai menyerap source/evidence, jalankan
    // satu siklus Mesin ABC terhadap snapshot BCGO terbaru. Dashboard menerima
    // telemetry A→B→C→D dari bridge dan dapat meminta scan berikutnya.
    try {
      const abcBridge = getRepairBridge();
      if (abcBridge && typeof abcBridge.ingestBCGOState === "function") {
        const link = abcBridge.ingestBCGOState(safeClone(state), {
          force: true,
          autoRepair: false,
          maxCycles: 1
        });
        if (link && link.ok) {
          state.abcLiveLink = {
            mode: link.mode || "LIVE",
            status: link.status || null,
            audit: link.audit || null,
            revision: link.evidence?.revision ?? state.cycle ?? null,
            fingerprint: link.evidence?.fingerprint || null,
            claimCount: link.claimCount ?? link.evidence?.claims?.length ?? 0,
            capturedAt: link.capturedAt || new Date().toISOString(),
            source: "BCGO_SOURCE_SCAN_CLOSED_LOOP"
          };
          publishToUI(safeClone(state));
        }
      }
    } catch (abcError) {
      recordEvent("ABC_CLOSED_LOOP_ERROR", `Mesin ABC gagal memproses snapshot source scan: ${String(abcError?.message || abcError).slice(0, 220)}`, "SYS_ABC_CLOSED_LOOP");
    }

    sourceScanInFlight = false;
    sourceScanController = null;
  }

  let dashboardControlChannel = null;
  let lastDashboardCycleCommand = null;
  try {
    if (typeof BroadcastChannel === "function") {
      dashboardControlChannel = new BroadcastChannel("CGO_DASHBOARD_CONTROL");
      dashboardControlChannel.onmessage = (ev) => {
        const command = ev && ev.data;
        if (!command || command.type !== "CGO_DASHBOARD_NEXT_CYCLE") return;
        if (lastDashboardCycleCommand === command.cycle) return;
        if (!canRun()) return;
        lastDashboardCycleCommand = command.cycle;
        recordEvent("DASHBOARD_LOOP", `Dashboard meminta siklus berikutnya: ${command.action || "RESCAN_AND_REPROCESS"}.`, "SYS_DASHBOARD_NEXT_CYCLE");
        try {
          runInternalSourceScan().catch(error => {
            sourceScanInFlight = false;
            state.sourceScan = { ...makeInitialSourceScan(), status: "DEGRADED", phase: "COMPLETE", message: String(error?.message || error) };
            publishToUI(safeClone(state));
          });
        } catch (error) {
          recordEvent("DASHBOARD_LOOP_ERROR", String(error?.message || error), "SYS_DASHBOARD_NEXT_CYCLE");
        }
      };
    }
  } catch (_) {}

  function refreshState() {
    if (!canRun()) return;
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

  function canRun() { return !stopped && (authorized || localMode); }

  function scheduleNext(delay) {
    clearTimeout(cycleTimer);
    cycleTimer = setTimeout(nextPhase, delay);
  }

  function nextPhase() {
    if (!canRun() || realtimeBusy) return;
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


  function startLocalAutonomy(reason) {
    if (stopped || authorized || localMode) return;
    localMode = true;
    state.cycleMode = "LOCAL";
    state.message = "[LOCAL] Otonomi lokal aktif — scan & chat jalan tanpa cloud. " + (reason || "");
    state.step = "IN";
    recordEvent("LOCAL", "Mode otonomi lokal aktif — sensor Firestore menunggu sesi Super Admin.", "SYS_LOCAL_AUTONOMY");
    emit("IN",
      "Mode otonomi lokal aktif. Saya memindai organ & source tanpa Firestore. " + (reason || "Login Super Admin di bcgo-admin.html untuk telemetry LIVE."),
      "SYS_LOCAL_AUTONOMY",
      null,
      { cycleMode: "LOCAL" }
    );
    // connection stays honest
    state.connection = { status: "OFFLINE_LOCAL", lastServerAt: 0, reason: reason || "no_admin_session" };
    state.agentPresence = { ...(state.agentPresence || {}), status: "STANDBY", connected: false };
    // Start local sensors
    const kickSourceScan = () => {
      runInternalSourceScan().catch(error => {
        sourceScanInFlight = false;
        state.sourceScan = { ...makeInitialSourceScan(), status: "DEGRADED", phase: "COMPLETE", message: String(error?.message || error) };
        publishToUI(safeClone(state));
      });
    };
    kickSourceScan();
    sourceScanTimer = setInterval(kickSourceScan, 120000);
    refreshTimer = setInterval(refreshState, 15000);
    phaseIndex = -1;
    scheduleNext(800);
    publishToUI(safeClone(state));
  }

  async function verifyAdmin(user, epoch) {
    if (stopped || epoch !== authEpoch) return;
    if (!user) {
      authorized = false;
      authorizedUid = null;
      cleanupRealtime();
      emit("OUT", "Sesi Admin belum tersedia. Login dulu di bcgo-admin.html, lalu buka lagi monitor ini.", "SYS_AUTH_REQUIRED");
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
      emit("OUT", "Akun ini bukan Super Admin aktif. Mode otonomi lokal diaktifkan (tanpa telemetry Firestore).", "SYS_AUTH_NOT_ADMIN");
      setTimeout(() => { if (!stopped && !authorized) startLocalAutonomy("Bukan Super Admin"); }, 800);
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
    localMode = false;
    authorizedUid = user.uid;
    recordEvent("AUTH", "Admin terverifikasi. Sensor real-time dibuka.", "SYS_AUTH_VERIFIED");
    emit("IN", "Admin terverifikasi. Saya membuka sensor telemetry dan Firestore real-time.", "SYS_AUTH_VERIFIED", null, { cycleMode: "BOOT" });
    startSystemLogs();
    startFirestoreProbe();
    startAgentPresence();
    const kickSourceScan = () => {
      runInternalSourceScan().catch(error => {
        sourceScanInFlight = false;
        state.sourceScan = { ...makeInitialSourceScan(), status: "DEGRADED", phase: "COMPLETE", message: String(error?.message || error) };
        publishToUI(safeClone(state));
      });
    };
    kickSourceScan();
    // Rescan berkala agar pembacaan file tetap presisi (bukan sekali saja)
    if (sourceScanTimer) clearInterval(sourceScanTimer);
    sourceScanTimer = setInterval(() => {
      if (stopped || !authorized) return;
      kickSourceScan();
    }, 75000);
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
    ask: function(q) {
      const raw = answerQuestion(q);
      return naturalizeWithOtak(q, raw);
    },
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
      if (sourceScanTimer) { clearInterval(sourceScanTimer); sourceScanTimer = null; }
      if (sourceScanController) { try { sourceScanController.abort(); } catch (_) {} sourceScanController = null; }
      try { if (dashboardControlChannel) dashboardControlChannel.close(); } catch (_) {}
      dashboardControlChannel = null;
      if (typeof unsubscribeAuth === "function") unsubscribeAuth();
      cleanupRealtime();
    }
  };

  window.BCGOBrain = brain;
  window.BCGO_STATE = safeClone(state);
  try {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("cgo:otak-state", { detail: { module: "BCGO_ENGINE", version: brain?.version || "4.3.0" } }));
    }
  } catch (_) {}

  // Publish the boot state immediately. The monitor must visibly report its
  // actual lifecycle even while Firebase is still restoring the Admin session.
  publishToUI(safeClone(state));

  // Tanpa cloud: langsung otonomi lokal (jangan stuck BOOT)
  if (!cloudOk) {
    try { startLocalAutonomy(__cgoCloudError ? String(__cgoCloudError.message || __cgoCloudError) : "Cloud tidak tersedia"); } catch (_) {}
  }

  if (cloudOk && adminAuth && typeof onAuthStateChanged === "function") {
    unsubscribeAuth = onAuthStateChanged(adminAuth, user => {
      const epoch = ++authEpoch;
      if (!user) {
        authorized = false;
        authorizedUid = null;
        cleanupRealtime();
        setTimeout(() => {
          if (stopped || epoch !== authEpoch || authorized) return;
          startLocalAutonomy("Sesi Admin belum ada");
        }, 800);
        return;
      }
      verifyAdmin(user, epoch).catch(error => {
        if (stopped || epoch !== authEpoch) return;
        authorized = false;
        authorizedUid = null;
        cleanupRealtime();
        emit("OUT", "Saya gagal memverifikasi status Admin.", "SYS_AUTH_CHECK_FAILED", error?.message, { cycleMode: "ERROR" });
        setTimeout(() => {
          if (stopped || epoch !== authEpoch || authorized) return;
          startLocalAutonomy("Verifikasi Admin gagal");
        }, 1000);
      });
    });
  } else {
    // Tanpa cloud: langsung otonomi lokal
    setTimeout(() => {
      if (!stopped && !authorized) startLocalAutonomy(__cgoCloudError ? String(__cgoCloudError.message || __cgoCloudError) : "Cloud tidak tersedia");
    }, 300);
  }
  return brain;
}


  // ─── Semantic Bridge auto-init (modul ke-9) ───
  function syncSemanticState(ok, extra) {
    try {
      const payload = {
        ready: !!ok,
        status: ok ? "ready" : "error",
        version: (window.CGOSemantic && window.CGOSemantic.version) || null,
        ts: Date.now()
      };
      if (extra && typeof extra === "object") {
        if (extra.error) payload.error = String(extra.error);
        if (extra.status) payload.status = extra.status;
      }
      if (window.BCGO_STATE && typeof window.BCGO_STATE === "object") {
        window.BCGO_STATE.semantic = payload;
      } else {
        window.BCGO_STATE = window.BCGO_STATE || {};
        window.BCGO_STATE.semantic = payload;
      }
      try {
        window.dispatchEvent(new CustomEvent("cgo:semantic-state", { detail: payload }));
      } catch (_) {}
    } catch (_) {}
  }

  function bootSemanticBridge() {
    if (!window.CGOSemantic || typeof window.CGOSemantic.ensureReady !== "function") {
      syncSemanticState(false, { status: "missing" });
      return;
    }
    syncSemanticState(false, { status: "loading" });
    window.CGOSemantic.ensureReady()
      .then(function (ok) {
        syncSemanticState(!!ok, ok ? { status: "ready" } : { status: "error", error: (window.CGOSemantic.getStatus && window.CGOSemantic.getStatus().error) || null });
      })
      .catch(function (e) {
        syncSemanticState(false, { status: "error", error: String((e && e.message) || e) });
      });
  }

  // Poll status setiap 5 detik agar panel Otak & BCGO_STATE sinkron
  function pollSemanticStatus() {
    try {
      if (!window.CGOSemantic) return;
      const st = window.CGOSemantic.getStatus ? window.CGOSemantic.getStatus() : null;
      if (st) syncSemanticState(!!st.ready, { status: st.status || (st.ready ? "ready" : "error"), error: st.error });
    } catch (_) {}
  }

  try {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function () { setTimeout(bootSemanticBridge, 200); });
    } else {
      setTimeout(bootSemanticBridge, 200);
    }
    setInterval(pollSemanticStatus, 5000);
  } catch (_) {}

