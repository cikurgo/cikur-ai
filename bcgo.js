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
 * ============================================================
 * BCGO MASTER NERVE SYSTEM — CONTINUOUS NEURAL CYCLE
 * ============================================================
 * Prinsip:
 * 1. Firestore tetap menjadi sumber fakta real-time.
 * 2. Neural cycle berjalan terus: IN -> PROCESS -> REVIEW -> OUT.
 * 3. Event Firestore dapat menginterupsi cycle kapan saja.
 * 4. Komunikasi BCGO menjawab berdasarkan state aktual, bukan
 *    mengarang kondisi sistem.
 */

const ORGAN_REGISTRY = {
    "index.html": { type: "Halaman Utama" },
    "assistant.html": { type: "Zona Customer" },
    "food.html": { type: "Zona Customer" },
    "ride.html": { type: "Zona Customer" },
    "cikurgo2in1.html": { type: "Zona Customer" },
    "agentcgo.html": { type: "Zona Mitra" },
    "resto.html": { type: "Zona Mitra" },
    "driver.html": { type: "Zona Mitra" },
    "cikur-config.js": { type: "Sistem Config" },
    "bcgo-engine.js": { type: "Sistem Core" },
    "bcgo-admin.html": { type: "Sistem Admin" },
    "bcgo.html": { type: "Sistem Monitor" }
};

const ACTIVE_WINDOW = 10 * 60 * 1000;
const LOG_LIMIT = 50;
const PROBE_LIMIT = 5;
const EVENT_HISTORY_LIMIT = 30;
const HEARTBEAT_STALE_MS = 12000;
const CYCLE = {
    IN: 1800,
    PROCESS: 1800,
    REVIEW: 1800,
    OUT: 1800
};

export function runAutonomousEngine(onCycleUpdate) {
    if (typeof onCycleUpdate !== "function") {
        throw new TypeError("BCGO membutuhkan callback UI.");
    }

    let stopped = false;
    let unsubscribeFirestore = null;
    let unsubscribeSystemLogs = null;
    let unsubscribeAuth = null;
    let cycleTimer = null;
    let expiryTimer = null;

    let latestSystemLogs = [];
    let firestore = {
        connected: false,
        count: 0,
        error: null
    };

    let cycleNo = 0;
    let phaseIndex = -1;
    let authorized = false;
    let authGeneration = 0;
    let lastEventAt = 0;
    let lastEventText = "Belum ada impuls baru.";
    let lastTarget = "SYS_MASTER_REGISTRY";
    let lastError = null;
    let interrupted = false;
    let lastStatePublishedAt = 0;
    const eventHistory = [];

    const state = {
        step: "IN",
        message: "Membangunkan Pusat Saraf Master...",
        targetCell: "SYS_MASTER_REGISTRY",
        errorLog: null,
        retryCount: 0,
        cycle: 0,
        cycleMode: "NORMAL",
        metrics: {},
        systemOrgans: {},
        systemLogs: [],
        firestore: { ...firestore },
        lastEventAt: null,
        lastEventText: lastEventText,
        statePublishedAt: null,
        dataFreshness: "WAITING",
        eventHistory: []
    };

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

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function getActiveLogs() {
        const cutoff = Date.now() - ACTIVE_WINDOW;
        return latestSystemLogs.filter(log => {
            const t = timestamp(log?.reportedAt);
            return t > cutoff;
        });
    }

    function buildOrgans() {
        const now = Date.now();
        const recent = new Map();

        for (const log of latestSystemLogs) {
            const file = String(log?.fileName || "").trim();
            const t = timestamp(log?.reportedAt);

            if (
                ORGAN_REGISTRY[file] &&
                t &&
                now - t <= ACTIVE_WINDOW &&
                (!recent.has(file) || t > recent.get(file).time)
            ) {
                recent.set(file, { log, time: t });
            }
        }

        const organs = {};

        for (const [file, meta] of Object.entries(ORGAN_REGISTRY)) {
            const current = recent.get(file);
            const hasHistorical = latestSystemLogs.some(
                log => String(log?.fileName || "").trim() === file
            );

            if (current) {
                organs[file] = {
                    ...meta,
                    status: "ANOMALY",
                    state: "ACTIVE",
                    message: String(
                        current.log?.message || "Sinyal error diterima."
                    ).slice(0, 500),
                    reportedAt: current.log?.reportedAt || null
                };
            } else {
                organs[file] = {
                    ...meta,
                    status: hasHistorical ? "RECOVERED" : "HEALTHY",
                    state: hasHistorical ? "RECOVERED" : "HEALTHY",
                    message: hasHistorical
                        ? "Tidak ada error aktif; laporan sebelumnya sudah melewati window aktif."
                        : "Belum ada laporan error aktif."
                };
            }
        }

        return organs;
    }

    function makeMetrics(organs) {
        const values = Object.values(organs);
        const active = values.filter(x => x.state === "ACTIVE").length;
        const recovered = values.filter(x => x.state === "RECOVERED").length;
        const healthy = values.filter(x => x.state === "HEALTHY").length;

        return {
            total: values.length,
            active,
            recovered,
            healthy,
            logCount: latestSystemLogs.length,
            firestoreCount: firestore.count
        };
    }

    function emit(step, message, target, error = null, options = {}) {
        if (stopped) return;

        const organs = buildOrgans();
        const metrics = makeMetrics(organs);

        state.step = step;
        state.message = message;
        state.targetCell = target || lastTarget;
        state.errorLog = error ? String(error).slice(0, 700) : null;
        state.cycle = cycleNo;
        state.cycleMode = options.cycleMode || state.cycleMode || "NORMAL";
        state.systemOrgans = organs;
        state.systemLogs = latestSystemLogs;
        state.firestore = { ...firestore };
        state.metrics = metrics;
        state.lastEventAt = lastEventAt || null;
        state.lastEventText = lastEventText;
        state.statePublishedAt = Date.now();
        lastStatePublishedAt = state.statePublishedAt;
        state.dataFreshness = firestore.connected ? "LIVE" : (firestore.error ? "OFFLINE" : "WAITING");
        state.eventHistory = eventHistory.slice();

        lastTarget = state.targetCell;
        lastError = state.errorLog;

        const snapshot = {
            ...state,
            systemOrgans: clone(organs),
            systemLogs: latestSystemLogs.slice(),
            metrics: { ...metrics },
            firestore: { ...firestore },
            eventHistory: eventHistory.slice()
        };

        // Satu state yang sama untuk monitor, chat, dan integrasi lain.
        window.BCGO_STATE = snapshot;

        // UI adalah konsumen state, bukan bagian dari mesin autentikasi/telemetry.
        // Jika DOM rusak atau ada elemen yang hilang, engine tetap hidup dan
        // kesalahan tersebut tidak boleh dilaporkan sebagai kegagalan Admin.
        try {
            onCycleUpdate(snapshot);
        } catch (uiError) {
            console.error("BCGO UI render error:", uiError);
            state.uiError = uiError?.message || String(uiError);
        }
    }

    function activeAnomalies() {
        return Object.entries(buildOrgans()).filter(
            ([, info]) => info.state === "ACTIVE"
        );
    }

    function describeSituation() {
        const organs = buildOrgans();
        const active = activeAnomalies();
        const recovered = Object.entries(organs).filter(
            ([, info]) => info.state === "RECOVERED"
        ).length;

        if (firestore.error) {
            return `Saya sedang menangani gangguan koneksi Firestore. Saya tidak akan menyatakan sistem sehat sebelum koneksi kembali.`;
        }

        if (active.length) {
            const [file, info] = active[0];
            return `Saya sedang memeriksa ${active.length} anomali aktif. Fokus saya sekarang ${file}: ${info.message}`;
        }

        if (recovered) {
            return `Saya sedang melakukan verifikasi rutin. Saat ini tidak ada anomali aktif; ${recovered} organ memiliki laporan historis yang sudah pulih.`;
        }

        return `Saya sedang melakukan pemindaian rutin ${Object.keys(organs).length} organ. Firestore terhubung dan belum ada anomali aktif.`;
    }

    function answerQuestion(question) {
        const q = String(question || "").trim().toLowerCase();
        const organs = buildOrgans();
        const active = activeAnomalies();
        const metrics = makeMetrics(organs);

        if (!q) {
            return "Saya di sini. Tanyakan apa yang sedang saya kerjakan, kondisi sistem, error, Firestore, atau organ tertentu.";
        }

        if (
            q.includes("hai") ||
            q.includes("halo") ||
            q.includes("hello") ||
            q.includes("siapa kamu")
        ) {
            return `Hai. Saya BCGO, Pusat Saraf Master. Saat ini saya berada di tahap ${state.step} pada neural cycle #${state.cycle}. ${describeSituation()}`;
        }

        if (
            q.includes("sedang") ||
            q.includes("kerja") ||
            q.includes("kerjakan") ||
            q.includes("ngapain") ||
            q.includes("apa yang kamu lakukan")
        ) {
            return `Saat ini saya berada di tahap ${state.step}. ${state.message} ${describeSituation()}`;
        }

        if (
            q.includes("status") ||
            q.includes("sehat") ||
            q.includes("kondisi")
        ) {
            if (firestore.error) {
                return `Status saya belum bisa dinyatakan sehat karena Firestore sedang bermasalah: ${firestore.error}`;
            }

            return `Status saat ini: ${metrics.active} anomali aktif, ${metrics.recovered} recovered, dan ${metrics.healthy} organ tanpa laporan error aktif. Firestore terhubung dan membaca ${metrics.firestoreCount} data pendaftaran Mitra pada probe.`;
        }

        if (
            q.includes("error") ||
            q.includes("masalah") ||
            q.includes("anomali")
        ) {
            if (!active.length) {
                return `Saat ini saya tidak menemukan anomali aktif. Saya tetap mendengarkan system_logs secara real-time. Laporan historis tetap saya tampilkan sebagai RECOVERED.`;
            }

            const [file, info] = active[0];
            return `Ya. Saya menemukan ${active.length} anomali aktif. Fokus pertama saya ${file}. Pesannya: ${info.message}`;
        }

        if (q.includes("firestore") || q.includes("database")) {
            if (firestore.error) {
                return `Sensor Firestore sedang melaporkan gangguan: ${firestore.error}`;
            }
            return `Sensor Firestore aktif. Listener mitra_applications terhubung dan saat ini membaca ${firestore.count} dokumen pada probe.`;
        }

        const requestedFile = Object.keys(ORGAN_REGISTRY).find(file =>
            q.includes(file.toLowerCase())
        );

        if (requestedFile) {
            const info = organs[requestedFile];
            if (info.state === "ACTIVE") {
                return `${requestedFile} sedang ANOMALY. ${info.message}`;
            }
            if (info.state === "RECOVERED") {
                return `${requestedFile} berstatus RECOVERED. Saya tidak menemukan error aktif pada window pemantauan saat ini.`;
            }
            return `${requestedFile} saat ini HEALTHY menurut telemetry yang saya terima. Artinya belum ada laporan error aktif dari file tersebut.`;
        }

        if (
            q.includes("cycle") ||
            q.includes("siklus") ||
            q.includes("tahap") ||
            q.includes("posisi")
        ) {
            return `Neural cycle saya sekarang #${state.cycle}, tahap ${state.step}. Target saraf: ${state.targetCell}.`;
        }

        if (q.includes("kenapa") || q.includes("mengapa") || q.includes("alasan")) {
            return `Saya berada di tahap ${state.step} karena state saraf terakhir saya menunjukkan: ${state.message} Target saat ini ${state.targetCell}. ${lastEventText}`;
        }

        if (q.includes("live") || q.includes("real time") || q.includes("realtime") || q.includes("terhubung")) {
            if (firestore.connected) {
                return `Kanal Firestore saya LIVE. Saya menerima snapshot real-time dan state terakhir dipublikasikan pada ${new Date(state.statePublishedAt || Date.now()).toLocaleTimeString("id-ID")}.`;
            }
            return `Kanal Firestore belum LIVE. Status sensor: ${state.dataFreshness}. ${firestore.error || "Saya masih menunggu koneksi server."}`;
        }

        return `Saya belum memiliki data yang cukup untuk memastikan jawaban itu. Saya tidak mau mengarang. Yang bisa saya pastikan sekarang: ${describeSituation()}`;
    }

    function markEvent(text, target, error = null) {
        lastEventAt = Date.now();
        lastEventText = String(text || "Impuls baru diterima.");
        lastTarget = target || lastTarget;
        lastError = error;

        eventHistory.unshift({
            at: lastEventAt,
            text: lastEventText,
            target: lastTarget,
            error: error ? String(error).slice(0, 700) : null
        });
        if (eventHistory.length > EVENT_HISTORY_LIMIT) eventHistory.length = EVENT_HISTORY_LIMIT;
    }

    function nextPhase() {
        if (stopped || !authorized) return;

        phaseIndex = (phaseIndex + 1) % 4;

        if (phaseIndex === 0) {
            cycleNo += 1;
            interrupted = false;
            markEvent(`Neural cycle #${cycleNo} dimulai.`, "SYS_NEURAL_SCAN");

            emit(
                "IN",
                `Neural cycle #${cycleNo} dimulai. Saya memindai ${Object.keys(ORGAN_REGISTRY).length} organ dan membaca sinyal terbaru.`,
                "SYS_NEURAL_SCAN",
                null,
                { cycleMode: "NORMAL" }
            );

            scheduleNext(CYCLE.IN);
            return;
        }

        if (phaseIndex === 1) {
            const active = activeAnomalies();

            if (firestore.error) {
                emit(
                    "PROCESS",
                    `Saya menerima sinyal gangguan Firestore. Saya sedang menganalisis koneksi sebelum menyimpulkan kondisi sistem.`,
                    "SYS_FIRESTORE_CONNECTION",
                    firestore.error,
                    { cycleMode: "NORMAL" }
                );
            } else if (active.length) {
                const [file, info] = active[0];
                emit(
                    "PROCESS",
                    `Saya menemukan ${active.length} anomali aktif. Saya sedang memproses sinyal dari ${file}.`,
                    file,
                    info.message,
                    { cycleMode: "NORMAL" }
                );
            } else {
                emit(
                    "PROCESS",
                    `Tidak ada anomali aktif. Saya sedang membandingkan telemetry ${latestSystemLogs.length} laporan dengan window pemantauan.`,
                    "SYS_TELEMETRY_ANALYSIS",
                    null,
                    { cycleMode: "NORMAL" }
                );
            }

            scheduleNext(CYCLE.PROCESS);
            return;
        }

        if (phaseIndex === 2) {
            const active = activeAnomalies();

            if (firestore.error) {
                emit(
                    "REVIEW",
                    `Saya sedang REVIEW karena sensor Firestore belum stabil. Saya mempertahankan status waspada.`,
                    "SYS_FIRESTORE_REVIEW",
                    firestore.error,
                    { cycleMode: "NORMAL" }
                );
            } else if (active.length) {
                const [file, info] = active[0];
                emit(
                    "REVIEW",
                    `Saya sedang REVIEW ${active.length} anomali. Fokus diagnostik: ${file}.`,
                    file,
                    info.message,
                    { cycleMode: "NORMAL" }
                );
            } else {
                emit(
                    "REVIEW",
                    `Review selesai: tidak ada anomali aktif. Saya memeriksa kembali konsistensi status ${Object.keys(ORGAN_REGISTRY).length} organ.`,
                    "SYS_NEURAL_REVIEW",
                    null,
                    { cycleMode: "NORMAL" }
                );
            }

            scheduleNext(CYCLE.REVIEW);
            return;
        }

        const active = activeAnomalies();

        if (firestore.error) {
            emit(
                "OUT",
                `Saya belum menutup siklus sebagai stabil karena Firestore masih bermasalah. Saya akan kembali memeriksa.`,
                "SYS_FIRESTORE_WAIT",
                firestore.error,
                { cycleMode: "NORMAL" }
            );
        } else if (active.length) {
            emit(
                "OUT",
                `Siklus #${cycleNo} selesai. Saya menemukan ${active.length} anomali aktif dan akan terus mengawasinya pada siklus berikutnya.`,
                active[0][0],
                active[0][1].message,
                { cycleMode: "ALERT" }
            );
        } else {
            emit(
                "OUT",
                `Siklus #${cycleNo} selesai. Tidak ada anomali aktif. Saya tetap mendengarkan impuls real-time.`,
                "SYS_NEURAL_SYNC",
                null,
                { cycleMode: "NORMAL" }
            );
        }

        scheduleNext(CYCLE.OUT);
    }

    function scheduleNext(delay) {
        clearTimeout(cycleTimer);
        cycleTimer = setTimeout(nextPhase, delay);
    }

    function interruptForRealtimeEvent(fileName, message) {
        if (stopped || !authorized) return;

        const file = String(fileName || "UNKNOWN").trim();
        const text = String(message || "Sinyal baru diterima.").slice(0, 700);

        markEvent(
            `Impuls baru diterima dari ${file}.`,
            file,
            text
        );

        interrupted = true;

        emit(
            "PROCESS",
            `⚡ Impuls real-time diterima dari ${file}. Saya menghentikan sementara pola normal untuk memeriksa sinyal ini.`,
            file,
            text,
            { cycleMode: "INTERRUPTED" }
        );

        clearTimeout(cycleTimer);

        setTimeout(() => {
            if (stopped || !authorized) return;

            const active = activeAnomalies();
            const targetInfo = buildOrgans()[file];

            if (targetInfo?.state === "ACTIVE") {
                emit(
                    "REVIEW",
                    `Saya sedang REVIEW sinyal ${file}. Anomali masih aktif, jadi saya mempertahankan perhatian pada organ tersebut.`,
                    file,
                    targetInfo.message,
                    { cycleMode: "INTERRUPTED" }
                );
            } else if (active.length) {
                emit(
                    "REVIEW",
                    `Impuls ${file} sudah tidak aktif, tetapi saya masih menemukan anomali pada organ lain. Saya melanjutkan REVIEW.`,
                    active[0][0],
                    active[0][1].message,
                    { cycleMode: "INTERRUPTED" }
                );
            } else {
                emit(
                    "REVIEW",
                    `Saya sudah memeriksa impuls ${file}. Saat ini tidak ada anomali aktif.`,
                    file,
                    null,
                    { cycleMode: "INTERRUPTED" }
                );
            }

            setTimeout(() => {
                if (stopped || !authorized) return;

                emit(
                    "OUT",
                    activeAnomalies().length
                        ? "Saya selesai menilai impuls tersebut dan kembali mengawasi sistem."
                        : "Impuls sudah saya evaluasi. Sistem kembali ke pemantauan normal.",
                    file,
                    activeAnomalies()[0]?.[1]?.message || null,
                    { cycleMode: "NORMAL" }
                );

                interrupted = false;
                phaseIndex = 3;
                scheduleNext(CYCLE.OUT);
            }, CYCLE.REVIEW);
        }, CYCLE.PROCESS);
    }

    function publishCurrentState() {
        if (stopped) return;
        const organs = buildOrgans();
        const metrics = makeMetrics(organs);
        state.systemOrgans = organs;
        state.systemLogs = latestSystemLogs.slice();
        state.metrics = metrics;
        state.firestore = { ...firestore };
        state.lastEventAt = lastEventAt || null;
        state.lastEventText = lastEventText;
        state.statePublishedAt = Date.now();
        state.dataFreshness = firestore.connected ? "LIVE" : (firestore.error ? "OFFLINE" : "WAITING");
        state.eventHistory = eventHistory.slice();
        const snapshot = {
            ...state,
            systemOrgans: clone(organs),
            systemLogs: latestSystemLogs.slice(),
            metrics: { ...metrics },
            firestore: { ...firestore },
            eventHistory: eventHistory.slice()
        };
        window.BCGO_STATE = snapshot;
        try {
            onCycleUpdate(snapshot);
        } catch (uiError) {
            console.error('BCGO UI render error:', uiError);
            state.uiError = uiError?.message || String(uiError);
        }
    }

    function startSystemLogs() {
        if (!window.CikurCloud?.listenSystemLogs) {
            emit(
                "OUT",
                "Telemetry system_logs tidak tersedia. Saya tidak dapat menerima impuls lintas-file.",
                "SYS_TELEMETRY_UNAVAILABLE"
            );
            return;
        }

        if (typeof unsubscribeSystemLogs === "function") {
            unsubscribeSystemLogs();
        }

        try {
            unsubscribeSystemLogs = window.CikurCloud.listenSystemLogs(
                logs => {
                    const previous = latestSystemLogs;
                    latestSystemLogs = Array.isArray(logs)
                        ? logs.slice(0, LOG_LIMIT)
                        : [];

                    const previousTop = previous[0];
                    const currentTop = latestSystemLogs[0];

                    if (
                        currentTop &&
                        (!previousTop ||
                            timestamp(currentTop.reportedAt) >
                                timestamp(previousTop.reportedAt))
                    ) {
                        interruptForRealtimeEvent(
                            currentTop.fileName,
                            currentTop.message
                        );
                    } else {
                        publishCurrentState();
                    }
                },
                LOG_LIMIT
            );
        } catch (error) {
            emit(
                "PROCESS",
                "Saya gagal membuka kanal telemetry lintas-file.",
                "SYS_SYSTEM_LOGS_LISTENER",
                error.message,
                { cycleMode: "ERROR" }
            );
        }
    }

    function startFirestoreProbe() {
        if (typeof unsubscribeFirestore === "function") {
            unsubscribeFirestore();
        }

        try {
            const q = query(
                collection(db, "mitra_applications"),
                orderBy("submittedAt", "desc"),
                limit(PROBE_LIMIT)
            );

            unsubscribeFirestore = onSnapshot(
                q,
                snapshot => {
                    const wasDisconnected = !firestore.connected;

                    firestore = {
                        connected: true,
                        count: snapshot.size,
                        error: null
                    };

                    state.retryCount = 0;

                    if (wasDisconnected) {
                        markEvent(
                            "Sensor Firestore kembali terhubung.",
                            "SYS_FIRESTORE_HEALTHY"
                        );
                    }

                    if (wasDisconnected) {
                        state.message = "Sensor Firestore kembali online. Saya melanjutkan pemantauan.";
                        state.targetCell = "SYS_FIRESTORE_HEALTHY";
                    }
                    publishCurrentState();
                },
                error => {
                    firestore = {
                        connected: false,
                        count: 0,
                        error: error?.message || "Firestore listener error"
                    };

                    state.retryCount += 1;

                    interruptForRealtimeEvent(
                        "cikur-config.js",
                        `Sensor Firestore melaporkan: ${firestore.error}`
                    );
                }
            );
        } catch (error) {
            firestore = {
                connected: false,
                count: 0,
                error: error.message
            };

            emit(
                "PROCESS",
                "Saya gagal menyiapkan sensor Firestore.",
                "SYS_FIRESTORE_CONNECTION",
                error.message,
                { cycleMode: "ERROR" }
            );
        }
    }

    function refreshExpiredStatuses() {
        if (stopped || !authorized) return;

        publishCurrentState();
    }

    async function verifyAdmin(user) {
        const generation = ++authGeneration;

        if (!user) {
            authorized = false;
            clearTimeout(cycleTimer);
            clearInterval(expiryTimer);

            emit(
                "OUT",
                "Sesi Admin belum tersedia. Silakan login sebagai Admin.",
                "SYS_AUTH_REQUIRED"
            );
            return;
        }

        try {
            const adminSnap = await getDoc(doc(db, "admin_users", user.uid));

            // Jangan biarkan hasil verifikasi lama menimpa sesi Auth terbaru.
            if (generation !== authGeneration) return;

            if (!adminSnap.exists() || adminSnap.data()?.active !== true) {
                authorized = false;
                emit(
                    "OUT",
                    "Akun ini bukan Admin aktif. Akses Pusat Saraf ditolak.",
                    "SYS_AUTH_NOT_ADMIN"
                );
                return;
            }

            if (authorized) return;

            authorized = true;

            emit(
                "IN",
                `Admin terverifikasi. Saya membangunkan neural cycle dan membuka sensor real-time.`,
                "SYS_AUTH_VERIFIED"
            );

            startSystemLogs();
            startFirestoreProbe();

            clearInterval(expiryTimer);
            expiryTimer = setInterval(refreshExpiredStatuses, 5000);

            phaseIndex = -1;
            cycleNo = 0;
            nextPhase();
        } catch (error) {
            authorized = false;

            emit(
                "OUT",
                "Saya gagal memverifikasi status Admin.",
                "SYS_AUTH_CHECK_FAILED",
                error.message,
                { cycleMode: "ERROR" }
            );
        }
    }

    function reportRuntimeError(message, source = "bcgo.html") {
        if (stopped || !authorized) return;
        const text = String(message || "JavaScript error tidak diketahui.");
        // UI error tidak boleh menjadi telemetry organ bcgo.html.
        // Ini mencegah loop self-report: render error -> anomaly -> render -> error.
        if (
            text.includes("Cannot set properties of null") ||
            text.includes("Cannot read properties of null")
        ) {
            console.warn("BCGO UI guard suppressed:", text);
            return;
        }
        interruptForRealtimeEvent("bcgo.html", `[${source}] ${text}`);
    }

    window.addEventListener("error", event => {
        reportRuntimeError(
            event?.message || event?.error?.message || "JavaScript error tidak diketahui.",
            event?.filename || "bcgo.html"
        );
    });

    window.addEventListener("unhandledrejection", event => {
        reportRuntimeError(
            event?.reason?.message || String(event?.reason || "Unhandled promise rejection."),
            "promise"
        );
    });

    unsubscribeAuth = onAuthStateChanged(auth, verifyAdmin);

    emit(
        "IN",
        "Pusat Saraf Master siap. Menunggu verifikasi Admin...",
        "SYS_MASTER_REGISTRY",
        null,
        { cycleMode: "BOOT" }
    );

    const brain = {
        ask: answerQuestion,
        getState: () => ({
            ...state,
            systemOrgans: clone(buildOrgans()),
            systemLogs: latestSystemLogs.slice(),
            metrics: makeMetrics(buildOrgans()),
            firestore: { ...firestore },
            dataFreshness: state.dataFreshness,
            eventHistory: eventHistory.slice()
        }),
        getSituation: describeSituation,
        stop() {
            stopped = true;
            clearTimeout(cycleTimer);
            clearInterval(expiryTimer);

            if (typeof unsubscribeAuth === "function") unsubscribeAuth();
            if (typeof unsubscribeFirestore === "function") unsubscribeFirestore();
            if (typeof unsubscribeSystemLogs === "function") unsubscribeSystemLogs();
        }
    };

    window.BCGOBrain = brain;
    return brain;
}
