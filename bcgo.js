import { collection, onSnapshot, query, orderBy, limit, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { db, auth } from "./cikur-config.js";

export function runAutonomousEngine(onCycleUpdate) {

    let state = {
        step: "IN",
        message: "Memindai seluruh jaringan organ sistem...",
        targetCell: "SYS_MASTER_REGISTRY",
        errorLog: null,
        retryCount: 0
    };

    function emitState(step, msg, cell, err = null) {
        state.step = step;
        state.message = msg;
        state.targetCell = cell;
        state.errorLog = err;
        onCycleUpdate(state);
    }

    // 0. VERIFIKASI ADMIN
    onAuthStateChanged(auth, async (user) => {
        if (!user) {
            emitState("OUT", "Diperlukan login Admin via bcgo-admin.html.", "SYS_AUTH_REQUIRED");
            return;
        }

        try {
            const adminSnap = await getDoc(doc(db, "admin_users", user.uid));
            if (!adminSnap.exists() || adminSnap.data()?.active !== true) {
                emitState("OUT", "Akses monitor ditolak: Bukan Admin terverifikasi.", "SYS_AUTH_NOT_ADMIN");
                return;
            }
        } catch (error) {
            emitState("OUT", "Gagal memverifikasi status Admin.", "SYS_AUTH_CHECK_FAILED", error.message);
            return;
        }

        // Mulai pemantauan lintas file real-time
        startGlobalSystemMonitoring();
    });

    let unsubscribeLogs = null;
    let unsubscribeFirestore = null;

    // 1. PEMANTAUAN LINTAS FILE REAL-TIME VIA FIRESTORE LOGS
    function startGlobalSystemMonitoring() {
        emitState("IN", "Menghubungkan ke pusat log sistem lintas file...", "SYS_CROSS_FILE_MONITOR");

        // Pantau error global dari seluruh file yang terhubung ke cikur-config.js
        const logsQuery = query(collection(db, "system_logs"), orderBy("timestamp", "desc"), limit(1));
        
        unsubscribeLogs = onSnapshot(logsQuery, (snapshot) => {
            if (!snapshot.empty) {
                const latestLog = snapshot.docs[0].data();
                // Jika ada error baru dari file manapun, langsung trigger proses anomali
                handleCellFailure(`CELL_ERR_${latestLog.source.toUpperCase().replace('.', '_')}`, new Error(latestLog.error));
            } else {
                scanFirestoreConnection();
            }
        }, (error) => {
            handleCellFailure("CELL_LOGS_LISTENER_ERR", error);
        });
    }

    // 2. PEMANTAUAN KESEHATAN KONEKSI FIRESTORE UTAMA
    function scanFirestoreConnection() {
        emitState("IN", "Memeriksa stabilitas database Firestore...", "SYS_FIRESTORE_CONNECTION");

        if (typeof unsubscribeFirestore === "function") {
            unsubscribeFirestore();
        }

        try {
            const q = query(collection(db, "mitra_applications"), orderBy("submittedAt", "desc"), limit(1));

            unsubscribeFirestore = onSnapshot(q, (snapshot) => {
                state.retryCount = 0;
                emitState("REVIEW", `Seluruh organ sistem stabil. ${snapshot.size} data mitra terakhir terpantau.`, "SYS_FIRESTORE_HEALTHY");
            }, (error) => {
                handleCellFailure("CELL_FIRESTORE_LISTENER", error);
            });
        } catch (err) {
            handleCellFailure("SYS_CONFIG_CORRUPT", err);
        }
    }

    // 3. PROSES ANALISIS ANOMALI OTOMATIS
    function handleCellFailure(cellId, error) {
        state.retryCount++;
        emitState("PROCESS", `Anomali terdeteksi pada [${cellId}]. Menganalisis...`, cellId, error.message);

        setTimeout(() => {
            if (state.retryCount <= 3) {
                emitState("REVIEW", `Diagnostik [${cellId}] selesai. Melakukan pemulihan otomatis...`, cellId, error.message);

                setTimeout(() => {
                    executeReconnect(cellId);
                }, 1500);
            } else {
                emitState("OUT", `[${cellId}] gagal pulih otomatis. Perlu intervensi manual.`, cellId, "FATAL_ORGAN_FAILURE");
            }
        }, 2000);
    }

    // 4. REKONEKSI OTOMATIS
    function executeReconnect(cellId) {
        emitState("IN", `Menyambungkan ulang modul [${cellId}]...`, cellId);
        startGlobalSystemMonitoring();
    }

    return { systemOrgans: {} };
}
