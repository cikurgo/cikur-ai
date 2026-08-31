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
 * - Medicine hanya menerima konteks kasus melalui telemetry; keputusan/perbaikan tetap terpisah.
 * - Medicine bukan organ BCGO; dua file Medicine berada di diagnostic layer terpisah.
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
  "data-cgo.html": { type: "Data Sistem", role: "data" }
};

const ORGAN_COUNT = Object.keys(ORGAN_REGISTRY).length;

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
  let authorizedUid = null;
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
  let authEpoch = 0;

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
    medicineQueue: [],
    connection: { status: "CONNECTING", lastServerAt: 0 },
    medicineBridge: {
      status: "DISCONNECTED",
      lastAt: 0,
      lastEvent: null,
      lastCaseId: null,
      message: null
    }
  };


  // ============================================================
  // BCGO ↔ MEDICINE NERVE
  // BCGO is the master state producer.
  // Medicine is a separate diagnostic consumer/producer.
  // There is deliberately NO import between the two engines.
  // ============================================================
  const medicineBridgeChannel =
    typeof BroadcastChannel !== "undefined"
      ? new BroadcastChannel("CIKUR_GO_BCGO_MEDICINE_V1")
      : null;

  let lastMedicineBridgeAt = 0;

  function bridgeClone(value) {
    try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
  }

  function publishBCGOStateToMedicine(snapshot) {
    const packet = {
      bridge: "CIKUR_GO_BCGO_MEDICINE_V1",
      from: "BCGO",
      type: "BCGO_STATE",
      at: Date.now(),
      state: bridgeClone(snapshot)
    };

    try { medicineBridgeChannel?.postMessage(packet); } catch {}
    try {
      localStorage.setItem("CIKUR_GO_BCGO_MEDICINE_V1", JSON.stringify(packet));
    } catch {}
  }

  function receiveMedicineBridge(packet) {
    if (stopped || !packet ||
        packet.bridge !== "CIKUR_GO_BCGO_MEDICINE_V1" ||
        packet.from !== "MEDICINE") return;

    const at = Number(packet.at) || Date.now();

    // Ignore an exact duplicate packet. This is important when both
    // BroadcastChannel and localStorage fallback are available.
    if (at <= lastMedicineBridgeAt) return;
    lastMedicineBridgeAt = at;

    state.medicineBridge = {
      status: "LIVE",
      lastAt: at,
      lastEvent: packet.medicineEvent || packet.type || "MEDICINE",
      lastCaseId: packet.caseId || packet.case?.id || null,
      message: String(packet.message || "").slice(0, 500) || null
    };

    recordEvent(
      "MEDICINE",
      state.medicineBridge.message || `Medicine event: ${state.medicineBridge.lastEvent}`,
      state.medicineBridge.lastCaseId || "MEDICINE"
    );

    // IMPORTANT: update local UI only. Do NOT call publishBCGOStateToMedicine()
    // here. This keeps the bridge from becoming a feedback loop.
    publishToUI(safeClone(state));
  }

  if (medicineBridgeChannel) {
    medicineBridgeChannel.addEventListener("message", event => {
      receiveMedicineBridge(event.data);
    });
  }

  window.addEventListener("storage", event => {
    if (event.key !== "CIKUR_GO_BCGO_MEDICINE_V1" || !event.newValue) return;
    try { receiveMedicineBridge(JSON.parse(event.newValue)); } catch {}
  });

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
  function publishToUI(snapshot) {
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

    const snapshot = safeClone(state);
    window.BCGO_STATE = snapshot;
    publishToUI(snapshot);
    publishBCGOStateToMedicine(snapshot);
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

    if (!q) return "Saya siap. Tanyakan kondisi sistem, error, file tertentu, telemetry terakhir, siklus saya, atau apa yang perlu saya teruskan ke Medicine.";

    if (/^(halo|hai|hello|pagi|siang|sore|malam)\b/.test(q) || /siapa kamu/.test(q)) {
      return `Halo. Saya BCGO. Saya bekerja dari telemetry dan state sistem yang sedang hidup, bukan dari tebakan. Sekarang cycle #${cycleNo}, tahap ${state.step}. ${situation()}`;
    }

    if (/scan ulang|rescan|pindai ulang|periksa ulang/.test(q)) {
      recordEvent("CHAT_COMMAND", "Anda meminta pemeriksaan ulang telemetry.", "SYS_CHAT_RESCAN");
      emit("IN", "Saya menerima perintah pemeriksaan ulang. Saya membaca ulang telemetry yang tersedia sekarang.", "SYS_CHAT_RESCAN", null, { cycleMode: "CHAT_COMMAND" });
      return `Baik. Saya mulai pemeriksaan ulang. Saat ini ${metrics.active} anomali aktif dari ${metrics.total} organ.`;
    }

    if (/medicine|obat|pengobatan|perbaiki|perbaikan|repair|sembuhkan/.test(q)) {
      if (!active.length) return "Belum ada kasus aktif yang cukup kuat untuk saya teruskan ke Medicine. Saya tidak akan membuat source code perbaikan tanpa bukti.";
      const [target, info] = active[0];
      return `Saya bisa meneruskan konteks ke Medicine. Kasus aktif pertama: ${target}. Bukti: ${info.message}. Medicine harus memverifikasi root cause dan source exact sebelum menyusun BEFORE → AFTER.`;
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

    return `Saya menangkap pertanyaanmu: “${raw}”. Saya belum punya bukti telemetry yang cukup untuk menjawab secara spesifik. Saya tidak akan mengarang. Kamu bisa bertanya tentang status, error, file tertentu, telemetry terakhir, cycle, atau meminta saya meneruskan kasus ke Medicine.`;
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
    const interruptEpoch = authEpoch;

    recordEvent("TELEMETRY", `Impuls baru dari ${file}.`, file);
    emit("PROCESS", `⚡ Saya menerima bukti baru dari ${file}. Saya hentikan sejenak siklus normal untuk memeriksanya.`, file, text, {
      cycleMode: "INTERRUPTED",
      telemetry: { file, at, message: text }
    });

    clearTimeout(cycleTimer);
    setTimeout(() => {
      if (stopped || !authorized || interruptEpoch !== authEpoch) return;
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
        if (stopped || !authorized || interruptEpoch !== authEpoch) return;
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

  function cleanupRealtime() {
    clearTimeout(cycleTimer);
    clearInterval(refreshTimer);
    cycleTimer = null;
    refreshTimer = null;
    if (typeof unsubscribeFirestore === "function") unsubscribeFirestore();
    if (typeof unsubscribeSystemLogs === "function") unsubscribeSystemLogs();
    unsubscribeFirestore = null;
    unsubscribeSystemLogs = null;
    realtimeBusy = false;
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
          publishToUI(safeClone(state));
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
    const epoch = ++authEpoch;
    if (!user) {
      authEpoch += 1;
      authorized = false;
      authorizedUid = null;
      cleanupRealtime();
      emit("OUT", "Sesi Admin belum tersedia. Silakan login sebagai Admin.", "SYS_AUTH_REQUIRED");
      return;
    }

    try {
      const snap = await getDoc(doc(db, "admin_users", user.uid));
      if (stopped || epoch !== authEpoch || auth.currentUser?.uid !== user.uid) return;
      const data = snap.exists() ? snap.data() : null;
      if (data?.active !== true) {
        authorized = false;
        authorizedUid = null;
        cleanupRealtime();
        emit("OUT", "Akun ini bukan Admin aktif. Akses Pusat Saraf ditolak.", "SYS_AUTH_NOT_ADMIN");
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
      refreshTimer = setInterval(refreshState, 15000);
      phaseIndex = -1;
      cycleNo = 0;
      nextPhase();
    } catch (error) {
      authorized = false;
      authorizedUid = null;
      cleanupRealtime();
      emit("OUT", "Saya gagal memverifikasi status Admin.", "SYS_AUTH_CHECK_FAILED", error?.message, { cycleMode: "ERROR" });
    }
  }

  // Error UI lokal hanya dicatat sebagai diagnostic internal.
  // Tidak boleh masuk ke system_logs sebagai anomaly bcgo.html karena itu
  // dapat membuat loop: render error -> telemetry -> render -> error.
  window.addEventListener("error", event => {
    if (stopped) return;
    const source = normalizeFile(event?.filename || "bcgo.html");
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
    console.warn("BCGO UI rejection diagnostic:", state.uiError);
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
      cleanupRealtime();
      try { medicineBridgeChannel?.close(); } catch {}
    }
  };

  window.BCGOBrain = brain;
  window.BCGO_STATE = safeClone(state);
  publishBCGOStateToMedicine(safeClone(state));
  unsubscribeAuth = onAuthStateChanged(auth, verifyAdmin);
  return brain;
}
