import {
  collection,
  onSnapshot,
  query,
  orderBy,
  limit,
  doc,
  getDoc,
  addDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { db, auth } from "./cikur-config.js";

/*
 * BCGO UNIVERSAL NEURAL MONITOR
 * PHASE 1 — REALTIME BRAIN / 15-ORGAN REGISTRY
 *
 * Prinsip:
 * - Tidak memakai AI/API eksternal.
 * - Firebase hanya dipakai sebagai backend telemetry/auth yang memang sudah
 *   menjadi bagian sistem CIKUR GO.
 * - Tidak membuat telemetry palsu.
 * - Status organ berasal dari system_logs yang benar-benar diterima.
 * - Tidak mengubah source code organ.
 * - Chat memakai state/evidence aktual, bukan jawaban dummy.
 */

const ORGAN_REGISTRY = {
  "index.html":        { type: "Halaman Utama", role: "customer" },
  "assistant.html":    { type: "Zona Customer", role: "customer" },
  "food.html":         { type: "Zona Customer", role: "customer" },
  "ride.html":         { type: "Zona Customer", role: "customer" },
  "cikurgo2in1.html":  { type: "Zona Customer", role: "customer" },
  "agentcgo.html":     { type: "Zona Mitra", role: "mitra" },
  "resto.html":        { type: "Zona Mitra", role: "resto" },
  "driver.html":       { type: "Zona Mitra", role: "driver" },
  "data-cgo.html":     { type: "Zona Data-Sistem-Otak", role: "data" },
  "cikur-config.js":   { type: "Sistem Config", role: "system" },
  "bcgo-engine.js":    { type: "Sistem Core", role: "system" },
  "bcgo-admin.html":   { type: "Sistem Admin", role: "admin" },
  "bcgo.html":         { type: "Sistem Monitor", role: "monitor" },
  "bcgo-medicine.js":  { type: "Sistem Medicine Core", role: "medicine" },
  "bcgo-medicine.html":{ type: "Sistem Medicine UI", role: "medicine" }
};

const ACTIVE_WINDOW = 10 * 60 * 1000;
const LOG_LIMIT = 50;
const EVENT_LIMIT = 30;
const CHAT_LIMIT = 30;

const clean = (v, max = 1200) => String(v ?? "").trim().slice(0, max);

function timestamp(value) {
  try {
    if (!value) return 0;
    if (typeof value.toMillis === "function") return value.toMillis();
    if (typeof value.toDate === "function") return value.toDate().getTime();
    if (value instanceof Date) return value.getTime();
    if (typeof value === "number") return value;
    const n = Date.parse(value);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function makeEvent(type, message, target = null, extra = {}) {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    message: clean(message, 600),
    target: target || null,
    at: nowIso(),
    ...extra
  };
}

function normalizeLogs(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(log => ({
      ...log,
      fileName: clean(log?.fileName || log?.source || "UNKNOWN", 160),
      message: clean(log?.message || log?.error || "Telemetry tanpa pesan.", 1200),
      reportedAt: log?.reportedAt || log?.createdAt || null
    }))
    .sort((a, b) => timestamp(b.reportedAt) - timestamp(a.reportedAt));
}

function deriveOrgans(logs) {
  const now = Date.now();
  const latest = new Map();

  for (const log of logs) {
    const file = clean(log.fileName);
    const t = timestamp(log.reportedAt);
    if (!ORGAN_REGISTRY[file] || !t) continue;
    if (now - t <= ACTIVE_WINDOW && (!latest.has(file) || t > latest.get(file).time)) {
      latest.set(file, { log, time: t });
    }
  }

  const result = {};
  for (const [file, meta] of Object.entries(ORGAN_REGISTRY)) {
    const hit = latest.get(file);
    const historical = logs.some(log => clean(log.fileName) === file);

    if (hit) {
      result[file] = {
        ...meta,
        status: "ANOMALY",
        state: "ACTIVE",
        message: clean(hit.log.message || "Anomaly terdeteksi.", 500),
        reportedAt: hit.log.reportedAt,
        evidence: hit.log
      };
    } else {
      result[file] = {
        ...meta,
        status: historical ? "RECOVERED" : "HEALTHY",
        state: historical ? "RECOVERED" : "HEALTHY",
        message: historical
          ? "Tidak ada error aktif pada window pemantauan."
          : "Belum ada telemetry error yang diterima.",
        reportedAt: null,
        evidence: null
      };
    }
  }

  return result;
}

function countMetrics(organs, logs, probe) {
  const values = Object.values(organs);
  return {
    total: values.length,
    active: values.filter(x => x.state === "ACTIVE").length,
    healthy: values.filter(x => x.state === "HEALTHY").length,
    recovered: values.filter(x => x.state === "RECOVERED").length,
    telemetry: logs.length,
    firestoreCount: probe.count || 0
  };
}

function findMentionedFile(question) {
  const q = clean(question).toLowerCase();
  return Object.keys(ORGAN_REGISTRY)
    .sort((a, b) => b.length - a.length)
    .find(file => q.includes(file.toLowerCase())) || null;
}

function latestForFile(logs, file) {
  if (!file) return null;
  return logs.find(log => clean(log.fileName).toLowerCase() === file.toLowerCase()) || null;
}

function makeBrain(state) {
  const q = clean(state.question).toLowerCase();
  const organs = state.systemOrgans || {};
  const active = Object.entries(organs).filter(([, v]) => v.state === "ACTIVE");
  const recovered = Object.entries(organs).filter(([, v]) => v.state === "RECOVERED");
  const mentioned = findMentionedFile(q);
  const target = mentioned || state.targetCell || null;
  const targetInfo = target ? organs[target] : null;
  const targetLog = latestForFile(state.systemLogs || [], target);

  const has = (...terms) => terms.some(term => q.includes(term));

  if (!q) return "Silakan tanyakan sesuatu. Saya akan menjawab berdasarkan telemetry dan state yang benar-benar saya terima.";

  if (has("halo", "hai", "hello", "pagi", "siang", "sore", "malam")) {
    return `Halo. Saya BCGO. Saya sedang berada di tahap ${state.step}, cycle #${state.cycle}. ` +
      `Saat ini ${active.length} anomaly aktif dari ${state.metrics.total} organ yang dipantau.`;
  }

  if (has("apa yang kamu kerjakan", "apa yang kamu kerjakan", "sedang apa", "lagi apa", "ngapain", "kerjakan")) {
    if (active.length) {
      const focus = active[0][0];
      return `Saya sedang memproses ${active.length} anomaly aktif. Fokus saat ini ${focus}: ` +
        `${clean(active[0][1].message, 280)}. Saya belum menyebut akar masalah sebelum evidence-nya cukup.`;
    }
    return `Saya sedang menjalankan pemantauan real-time. Saat ini tidak ada anomaly aktif yang terbukti dari telemetry.`;
  }

  if (has("status", "kondisi sistem", "sehat", "aman")) {
    if (state.connection?.status === "OFFLINE") {
      return "Saya belum bisa menyatakan sistem aman karena listener Firestore sedang OFFLINE. Saya mempertahankan state terakhir dan menunggu koneksi pulih.";
    }
    if (active.length) {
      return `Sistem belum sepenuhnya aman. Ada ${active.length} anomaly aktif: ${active.map(([f]) => f).join(", ")}.`;
    }
    return `Saat ini tidak ada anomaly aktif. ${state.metrics.healthy} organ stabil dan ${recovered.length} memiliki riwayat telemetry yang sudah tidak aktif.`;
  }

  if (has("masalah", "error", "anomaly", "gangguan", "rusak")) {
    if (!active.length) {
      return "Saat ini saya tidak menerima anomaly aktif dari telemetry. Saya tetap mendengarkan system_logs untuk impuls baru.";
    }
    const focus = active[0];
    return `Ya. Saya melihat ${active.length} anomaly aktif. Prioritas saya ${focus[0]}: ${clean(focus[1].message, 360)}.`;
  }

  if (has("cek", "periksa", "scan", "pindai", "lihat", "status file")) {
    if (!target) {
      return `Saya bisa memeriksa target tertentu. Sebutkan nama file, misalnya "cek index.html". ` +
        `Saat ini saya menerima ${state.systemLogs.length} telemetry log.`;
    }
    if (!targetInfo) return `File ${target} belum ada dalam registry BCGO.`;
    if (targetInfo.state === "ACTIVE") {
      return `Saya sudah melihat telemetry aktif pada ${target}. Evidence terakhir: ${clean(targetInfo.message, 420)}. ` +
        `Saya menahan kesimpulan akar masalah sampai source/dependency dapat dibuktikan.`;
    }
    if (targetLog) {
      return `${target} memiliki telemetry historis, tetapi tidak ada anomaly aktif pada window sekarang. ` +
        `Saya tidak akan menyebutnya rusak hanya karena pernah error.`;
    }
    return `${target} belum memiliki telemetry error yang saya terima. Jadi saya belum punya bukti bahwa file itu bermasalah.`;
  }

  if (has("telemetry terakhir", "error terakhir", "laporan terakhir", "impuls terakhir", "terakhir")) {
    const last = state.systemLogs?.[0];
    if (!last) return "Belum ada telemetry yang bisa saya pastikan.";
    return `Telemetry terakhir yang saya terima berasal dari ${last.fileName}: ${clean(last.message, 500)}.`;
  }

  if (has("berapa", "jumlah", "count", "ada berapa")) {
    return `State aktual: ${state.metrics.total} organ, ${state.metrics.active} anomaly aktif, ` +
      `${state.metrics.healthy} stabil, ${state.metrics.recovered} recovered, dan ${state.metrics.telemetry} telemetry log.`;
  }

  if (has("cycle", "siklus", "tahap", "fase", "phase")) {
    return `Saya sekarang berada di ${state.step}, cycle #${state.cycle}, mode ${state.cycleMode}. ` +
      `Target saraf: ${state.targetCell || "belum ditentukan"}.`;
  }

  if (has("medicine", "obati", "sembuhkan", "perbaiki", "repair", "treatment")) {
    if (active.length) {
      const focus = target && organs[target]?.state === "ACTIVE" ? target : active[0][0];
      return `Kasus aktif bisa diarahkan ke Medicine. Saya akan membawa evidence ${focus} apa adanya; ` +
        `Medicine tetap harus membuktikan root cause dan source exact sebelum treatment.`;
    }
    return "Belum ada anomaly aktif yang terbukti untuk diarahkan ke Medicine.";
  }

  if (has("rules", "rule firestore", "firestore rules", "permission", "izin")) {
    return `Saya dapat memantau sinyal permission yang benar-benar masuk ke system_logs. ` +
      `Saya tidak akan menyimpulkan Rules salah hanya dari status UI.`;
  }

  if (has("ulang", "scan ulang", "pindai ulang", "refresh")) {
    return "Baik. Saya mulai siklus evaluasi ulang dari state dan telemetry yang sedang hidup. Saya tidak membuat data baru hanya untuk mengubah indikator.";
  }

  return `Saya menangkap pertanyaanmu. Agar jawaban saya tidak mengarang, saya memakai state aktual: ` +
    `cycle #${state.cycle}, tahap ${state.step}, ${state.metrics.active} anomaly aktif, target ${state.targetCell || "belum ada"}. ` +
    `Kamu bisa bertanya "apa yang kamu kerjakan?", "cek index.html", "ada masalah?", atau "telemetry terakhir apa?".`;
}

export function runAutonomousEngine(onCycleUpdate) {
  if (typeof onCycleUpdate !== "function") {
    throw new TypeError("BCGO membutuhkan callback.");
  }

  let stopped = false;
  let unsubscribeAuth = null;
  let unsubscribeLogs = null;
  let unsubscribeProbe = null;
  let unsubscribeMessages = null;

  let logs = [];
  let probe = { connected: false, count: 0, error: null };
  let chatMessages = [];
  let recentEvents = [];
  let cycle = 0;
  let lastStep = "OUT";
  let lastTarget = "SYS_MASTER_REGISTRY";
  let lastEventAt = null;
  let connectionStatus = "CONNECTING";
  let authorized = false;
  let retryCount = 0;
  let lastState = null;

  function pushEvent(type, message, target = null, extra = {}) {
    recentEvents.unshift(makeEvent(type, message, target, extra));
    recentEvents = recentEvents.slice(0, EVENT_LIMIT);
  }

  function publish(step, message, target = lastTarget, error = null, mode = "NORMAL") {
    if (stopped) return;

    lastStep = step;
    lastTarget = target || lastTarget;
    lastEventAt = nowIso();

    const systemOrgans = deriveOrgans(logs);
    const metrics = countMetrics(systemOrgans, logs, probe);

    const state = {
      version: "2.0.0-phase1",
      step,
      cycle,
      cycleMode: mode,
      message: clean(message, 900),
      targetCell: clean(lastTarget, 180),
      errorLog: error ? clean(error, 900) : null,
      retryCount,
      authorized,
      connection: {
        status: connectionStatus,
        lastServerAt: probe.connected ? nowIso() : (lastState?.connection?.lastServerAt || null),
        error: probe.error || null
      },
      metrics,
      systemOrgans,
      systemLogs: logs,
      recentEvents,
      chatMessages,
      lastTelemetryFile: logs[0]?.fileName || null,
      lastTelemetryAt: logs[0]?.reportedAt || null,
      lastEventAt,
      question: ""
    };

    lastState = state;
    window.BCGO_STATE = state;
    onCycleUpdate(state);
  }

  function evaluate(reason = "telemetry") {
    if (stopped || !authorized) return;

    const organs = deriveOrgans(logs);
    const active = Object.entries(organs).filter(([, value]) => value.state === "ACTIVE");

    cycle += 1;

    if (probe.error) {
      connectionStatus = "OFFLINE";
      pushEvent("FIRESTORE_ERROR", `Listener Firestore: ${probe.error}`, "SYS_FIRESTORE_CONNECTION");
      publish("PROCESS", "Saya kehilangan koneksi Firestore. Saya tidak akan memalsukan status organ selama koneksi terganggu.", "SYS_FIRESTORE_CONNECTION", probe.error, "INTERRUPTED");
      return;
    }

    connectionStatus = "LIVE";

    if (active.length) {
      const [file, info] = active[0];
      pushEvent(
        reason === "telemetry" ? "TELEMETRY_DETECTED" : "NEURAL_SCAN",
        `${active.length} anomaly aktif. Fokus ${file}.`,
        file
      );
      publish(
        "PROCESS",
        `${active.length} anomaly aktif terdeteksi. Saya sedang memeriksa evidence terbaru dari ${file}.`,
        file,
        info.message,
        reason === "telemetry" ? "INTERRUPTED" : "NORMAL"
      );
    } else {
      pushEvent("NEURAL_SCAN", "Tidak ada anomaly aktif pada window telemetry.", "SYS_NEURAL_SCAN");
      publish(
        "REVIEW",
        `Evaluasi selesai. ${Object.keys(organs).length} organ dipantau dan tidak ada anomaly aktif.`,
        "SYS_NEURAL_REVIEW",
        null,
        "NORMAL"
      );
    }
  }

  function startSystemLogs() {
    if (!window.CikurCloud?.listenSystemLogs) {
      connectionStatus = "OFFLINE";
      publish("OUT", "Bridge telemetry system_logs tidak tersedia di CikurCloud.", "SYS_TELEMETRY_UNAVAILABLE", "listenSystemLogs tidak tersedia");
      return;
    }

    try {
      unsubscribeLogs = window.CikurCloud.listenSystemLogs(value => {
        if (stopped) return;
        logs = normalizeLogs(value).slice(0, LOG_LIMIT);
        retryCount = 0;
        evaluate("telemetry");
      }, LOG_LIMIT);
    } catch (error) {
      connectionStatus = "OFFLINE";
      retryCount += 1;
      publish("OUT", "Gagal membuka listener system_logs.", "SYS_SYSTEM_LOGS_LISTENER", error.message, "INTERRUPTED");
    }
  }

  function startFirestoreProbe() {
    try {
      const q = query(
        collection(db, "mitra_applications"),
        orderBy("submittedAt", "desc"),
        limit(5)
      );

      unsubscribeProbe = onSnapshot(
        q,
        snapshot => {
          if (stopped) return;
          probe = { connected: true, count: snapshot.size, error: null };
          connectionStatus = "LIVE";
          retryCount = 0;
          if (!lastState) {
            pushEvent("FIRESTORE_LIVE", "Probe Firestore berhasil terhubung.", "SYS_FIRESTORE_HEALTHY");
          }
          evaluate("firestore");
        },
        error => {
          probe = {
            connected: false,
            count: 0,
            error: clean(error?.message || "Firestore listener error", 700)
          };
          retryCount += 1;
          evaluate("firestore_error");
        }
      );
    } catch (error) {
      probe = { connected: false, count: 0, error: clean(error.message, 700) };
      retryCount += 1;
      evaluate("firestore_error");
    }
  }

  function startSharedChat() {
    try {
      const q = query(
        collection(db, "medicine_messages"),
        orderBy("createdAt", "desc"),
        limit(CHAT_LIMIT)
      );

      unsubscribeMessages = onSnapshot(
        q,
        snapshot => {
          if (stopped) return;
          chatMessages = [];
          snapshot.forEach(item => chatMessages.push({ id: item.id, ...item.data() }));
          chatMessages.reverse();

          if (lastState) {
            const next = {
              ...lastState,
              chatMessages,
              recentEvents
            };
            lastState = next;
            window.BCGO_STATE = next;
            onCycleUpdate(next);
          }
        },
        error => {
          pushEvent("CHAT_LISTENER_ERROR", clean(error?.message || "Chat listener error"), "SYS_CHAT");
          if (lastState) {
            const next = {
              ...lastState,
              chatError: clean(error?.message || "Chat listener error")
            };
            lastState = next;
            window.BCGO_STATE = next;
            onCycleUpdate(next);
          }
        }
      );
    } catch (error) {
      pushEvent("CHAT_INIT_ERROR", clean(error.message), "SYS_CHAT");
    }
  }

  async function sendSharedMessage(role, text, meta = {}) {
    const message = clean(text, 1800);
    if (!message) return { ok: false, error: "Pesan kosong." };

    try {
      await addDoc(collection(db, "medicine_messages"), {
        role,
        text: message,
        system: role !== "human" && role !== "user",
        actorUid: role === "human" || role === "user" ? (auth.currentUser?.uid || null) : null,
        createdAt: serverTimestamp(),
        clientMessageId: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        ...meta
      });
      return { ok: true };
    } catch (error) {
      pushEvent("CHAT_WRITE_ERROR", clean(error.message), "SYS_CHAT");
      return { ok: false, error: clean(error.message, 700) };
    }
  }

  async function verifyAdmin(user) {
    if (stopped) return;

    if (!user) {
      authorized = false;
      connectionStatus = "CONNECTING";
      publish("OUT", "Sesi Admin belum tersedia. Silakan login melalui bcgo-admin.html.", "SYS_AUTH_REQUIRED");
      return;
    }

    try {
      const adminSnap = await getDoc(doc(db, "admin_users", user.uid));

      if (stopped) return;

      if (!adminSnap.exists() || adminSnap.data()?.active !== true) {
        authorized = false;
        connectionStatus = "OFFLINE";
        publish("OUT", "Akun ini bukan Admin aktif. Akses monitor ditolak.", "SYS_AUTH_NOT_ADMIN");
        return;
      }

      authorized = true;
      connectionStatus = "LIVE";
      pushEvent("AUTH_VERIFIED", "Admin terverifikasi.", "SYS_AUTH_VERIFIED");

      publish("IN", "Admin terverifikasi. Saya membuka telemetry dan monitor real-time.", "SYS_AUTH_VERIFIED");

      startSystemLogs();
      startFirestoreProbe();
      startSharedChat();

      // Evaluasi awal menggunakan data yang benar-benar diterima.
      evaluate("boot");
    } catch (error) {
      authorized = false;
      connectionStatus = "OFFLINE";
      publish("OUT", "Verifikasi Admin gagal.", "SYS_AUTH_CHECK_FAILED", error.message, "INTERRUPTED");
    }
  }

  function ask(question) {
    const q = clean(question, 500);
    const state = {
      ...(lastState || {
        step: lastStep,
        cycle,
        cycleMode: "NORMAL",
        targetCell: lastTarget,
        metrics: countMetrics(deriveOrgans(logs), logs, probe),
        systemOrgans: deriveOrgans(logs),
        systemLogs: logs,
        connection: { status: connectionStatus },
        recentEvents,
        chatMessages
      }),
      question: q
    };

    const answer = makeBrain(state);

    pushEvent("CHAT", `Anda bertanya: ${q}`, "SYS_CHAT");
    pushEvent("BCGO_REPLY", answer, state.targetCell || "SYS_CHAT");

    const next = {
      ...state,
      recentEvents,
      chatMessages,
      question: ""
    };

    lastState = next;
    window.BCGO_STATE = next;
    onCycleUpdate(next);

    // Simpan percakapan ke kanal yang sama agar BCGO/Medicine dapat melihat
    // percakapan real-time. Jika write ditolak Rules, jawaban lokal tetap tampil.
    sendSharedMessage("user", q, { source: "bcgo.html", kind: "USER_CHAT" });
    sendSharedMessage("bcgo", answer, { source: "bcgo.js", kind: "BCGO_CHAT" });

    return answer;
  }

  unsubscribeAuth = onAuthStateChanged(auth, verifyAdmin);

  publish("IN", `Menginisialisasi registry ${Object.keys(ORGAN_REGISTRY).length} organ...`, "SYS_MASTER_REGISTRY");

  return {
    getState: () => lastState,
    getOrgans: () => deriveOrgans(logs),
    ask,
    sendMessage: sendSharedMessage,
    getRegistry: () => ({ ...ORGAN_REGISTRY }),
    stop() {
      stopped = true;
      if (typeof unsubscribeAuth === "function") unsubscribeAuth();
      if (typeof unsubscribeLogs === "function") unsubscribeLogs();
      if (typeof unsubscribeProbe === "function") unsubscribeProbe();
      if (typeof unsubscribeMessages === "function") unsubscribeMessages();
    }
  };
}
