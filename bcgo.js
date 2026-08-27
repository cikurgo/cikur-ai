import { collection, onSnapshot, query, orderBy, limit, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { db, auth } from "./cikur-config.js";
// window.CikurCloud sudah tersedia dari cikur-config.js (di-import di atas,
// yang otomatis menjalankan top-level code-nya termasuk window.CikurCloud = {...})

/**
 * BCGO MASTER NERVE SYSTEM (Universal Registry)
 * Memantau kesehatan koneksi Firestore, DAN memantau error lintas file
 * secara real-time lewat laporan yang dikirim tiap file ke Firestore
 * (collection "system_logs") via CikurCloud.reportSystemError().
 *
 * Cakupan: file yang BELUM disisipi pemanggilan reportSystemError()
 * tidak akan pernah muncul sebagai ANOMALY di sini walau errornya
 * sungguhan terjadi - status "HEALTHY"-nya di peta ini cuma berarti
 * "belum ada laporan masuk", bukan jaminan file itu benar-benar sehat.
 */
export function runAutonomousEngine(onCycleUpdate) {

    // PETA REFERENSI SISTEM - status akan berubah otomatis begitu ada
    // laporan error masuk dari file terkait via reportSystemError().
    const systemOrgans = {
        "index.html": { type: "Halaman Utama", status: "HEALTHY" },
        "assistant.html": { type: "Zona Customer", status: "HEALTHY" },
        "food.html": { type: "Zona Customer", status: "HEALTHY" },
        "ride.html": { type: "Zona Customer", status: "HEALTHY" },
        "cikurgo2in1.html": { type: "Zona Customer", status: "HEALTHY" },
        "agentcgo.html": { type: "Zona Mitra", status: "HEALTHY" },
        "resto.html": { type: "Zona Mitra", status: "HEALTHY" },
        "driver.html": { type: "Zona Mitra", status: "HEALTHY" },
        "cikur-config.js": { type: "Sistem Config", status: "HEALTHY" },
        "bcgo-engine.js": { type: "Sistem Core", status: "HEALTHY" },
        "bcgo-admin.html": { type: "Sistem Admin", status: "HEALTHY" },
        "bcgo.html": { type: "Sistem Monitor (halaman ini)", status: "HEALTHY" }
    };

    let state = {
        step: "IN",
        message: "Memindai koneksi Firestore inti...",
        targetCell: "SYS_MASTER_REGISTRY",
        errorLog: null,
        retryCount: 0
    };

    function emitState(step, msg, cell, err = null) {
        state.step = step;
        state.message = msg;
        state.targetCell = cell;
        state.errorLog = err;
        onCycleUpdate({ ...state, systemOrgans, systemLogs: latestSystemLogs });
    }

    // 0. VERIFIKASI ADMIN SEBELUM MULAI MEMANTAU
    // (mencegah error izin, dan mencegah orang tak berwenang membuka monitor ini)
    onAuthStateChanged(auth, async (user) => {
        if (!user) {
            emitState("OUT", "Diperlukan login Admin. Silakan login melalui bcgo-admin.html terlebih dahulu, lalu buka halaman ini lagi.", "SYS_AUTH_REQUIRED");
            return;
        }

        try {
            const adminSnap = await getDoc(doc(db, "admin_users", user.uid));
            if (!adminSnap.exists() || adminSnap.data()?.active !== true) {
                emitState("OUT", "Akun ini bukan Admin terverifikasi. Akses monitor ditolak.", "SYS_AUTH_NOT_ADMIN");
                return;
            }
        } catch (error) {
            emitState("OUT", "Gagal memverifikasi status Admin.", "SYS_AUTH_CHECK_FAILED", error.message);
            return;
        }

        // Admin terverifikasi -> mulai pemantauan sungguhan
        scanOrgansHealth();
        startPeriodicPulse();
        startListeningSystemLogs();
    });

    // 1. TANGKAP ERROR JAVASCRIPT DI HALAMAN INI SENDIRI
    // (hanya mencakup bcgo.html/bcgo.js, bukan file lain - lihat catatan di atas)
    window.onerror = function(message, source, lineno, colno, error) {
        const cellTag = "CELL_ERR_BCGO_MONITOR_PAGE";
        handleCellFailure(cellTag, new Error(`[${source || 'bcgo.html'} L:${lineno}] ${message}`));
        return true;
    };

    let unsubscribeFirestore = null;
    let unsubscribeSystemLogs = null;
    let periodicPulseInterval = null;
    let latestSystemLogs = [];

    // PEMANTAUAN LINTAS FILE SUNGGUHAN - dengarkan laporan error
    // yang dikirim tiap file via CikurCloud.reportSystemError()
    function startListeningSystemLogs() {
        if (typeof unsubscribeSystemLogs === "function") unsubscribeSystemLogs();

        unsubscribeSystemLogs = window.CikurCloud.listenSystemLogs((logs) => {
            latestSystemLogs = logs;

            // Reset semua ke HEALTHY dulu, lalu tandai ANOMALY
            // untuk file yang punya laporan error dalam 10 menit terakhir
            Object.keys(systemOrgans).forEach(f => systemOrgans[f].status = "HEALTHY");

            const tenMinutesAgo = Date.now() - (10 * 60 * 1000);
            logs.forEach(log => {
                const reportedTime = log.reportedAt?.toMillis ? log.reportedAt.toMillis() : Date.now();
                if (systemOrgans[log.fileName] && reportedTime > tenMinutesAgo) {
                    systemOrgans[log.fileName].status = "ANOMALY";
                }
            });

            if (typeof onCycleUpdate === "function") {
                onCycleUpdate({ ...state, systemLogs: latestSystemLogs, systemOrgans });
            }
        });
    }

    // DETAK JANTUNG BERKALA - supaya terlihat terus aktif memantau,
    // bukan cuma diam menunggu perubahan data (walau onSnapshot sendiri
    // sebenarnya sudah reaktif real-time terhadap perubahan sungguhan).
    function startPeriodicPulse() {
        if (periodicPulseInterval) clearInterval(periodicPulseInterval);
        periodicPulseInterval = setInterval(() => {
            scanOrgansHealth();
        }, 15000);
    }

    // 2. PEMANTAUAN KESEHATAN KONEKSI FIRESTORE (INI YANG SUNGGUHAN REAL-TIME)
    function scanOrgansHealth() {
        emitState("IN", "Menghubungkan ke Firestore (mitra_applications)...", "SYS_FIRESTORE_CONNECTION");

        if (typeof unsubscribeFirestore === "function") {
            unsubscribeFirestore();
        }

        try {
            const q = query(collection(db, "mitra_applications"), orderBy("submittedAt", "desc"), limit(5));

            unsubscribeFirestore = onSnapshot(q, (snapshot) => {
                state.retryCount = 0;
                emitState("REVIEW", `Koneksi Firestore stabil. ${snapshot.size} data pendaftaran Mitra terpantau.`, "SYS_FIRESTORE_HEALTHY");
            }, (error) => {
                handleCellFailure("CELL_FIRESTORE_LISTENER", error);
            });
        } catch (err) {
            handleCellFailure("SYS_CONFIG_CORRUPT", err);
        }
    }

    // 3. PROSES ANALISIS ANOMALI
    function handleCellFailure(cellId, error) {
        state.retryCount++;
        emitState("PROCESS", `Anomali terdeteksi pada [${cellId}]. Menganalisis...`, cellId, error.message);

        setTimeout(() => {
            if (state.retryCount <= 3) {
                emitState("REVIEW", `Diagnostik [${cellId}] selesai. Mencoba menyambung ulang...`, cellId, error.message);

                setTimeout(() => {
                    executeReconnect(cellId);
                }, 1500);
            } else {
                emitState("OUT", `[${cellId}] gagal pulih otomatis setelah 3 percobaan. Perlu pengecekan manual.`, cellId, "FATAL_ORGAN_FAILURE");
            }
        }, 2000);
    }

    // 4. COBA SAMBUNG ULANG LISTENER FIRESTORE
    // (ini genuinely mencoba ulang koneksi, bukan sekadar animasi)
    function executeReconnect(cellId) {
        emitState("IN", `Menyambungkan ulang listener Firestore [${cellId}]...`, cellId);
        scanOrgansHealth();
    }

    return { systemOrgans };
}

/*
 * ============================================================
 * CATATAN PENGEMBANGAN LANJUTAN: Monitoring lintas-file sungguhan
 * ============================================================
 * Untuk benar-benar memantau error di index.html/assistant.html/dll
 * dari SATU halaman admin, setiap file perlu melaporkan errornya
 * sendiri ke Firestore, misalnya lewat fungsi baru di cikur-config.js:
 *
 *   window.addEventListener("error", (e) => {
 *       CikurCloud.reportSystemError("assistant.html", e.message);
 *   });
 *
 * yang menulis ke collection "system_logs". bcgo.html kemudian
 * mendengarkan collection itu (bukan window.onerror lokal) untuk
 * menampilkan error dari SEMUA file secara benar-benar real-time.
 * Ini pekerjaan terpisah yang perlu ditambahkan ke tiap file satu-satu.
 */
