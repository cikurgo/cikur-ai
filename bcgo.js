import { collection, onSnapshot, query, orderBy, limit } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { db } from "./cikur-config.js";

/**
 * BCGO MASTER NERVE SYSTEM (Universal Registry)
 * Memantau kesehatan koneksi Firestore, dan menangkap error JavaScript
 * yang terjadi SELAMA halaman monitor ini (bcgo.html) sedang dibuka.
 *
 * CATATAN PENTING soal cakupan:
 * window.onerror hanya bisa menangkap error dari halaman yang SEDANG
 * TERBUKA di tab ini. index.html/assistant.html/food.html/dll berjalan
 * di tab browser masing-masing yang terpisah, sehingga error di sana
 * TIDAK bisa terdeteksi otomatis dari sini. Daftar "organ" di bawah ini
 * berfungsi sebagai referensi/peta sistem, bukan pemantauan real-time
 * lintas-tab. Untuk pemantauan lintas file yang sungguhan, setiap file
 * perlu melaporkan errornya sendiri ke Firestore (lihat catatan di
 * akhir file ini untuk cara membangunnya).
 */
export function runAutonomousEngine(onCycleUpdate) {

    // PETA REFERENSI SISTEM (bukan status real-time per file)
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
        onCycleUpdate(state);
    }

    // 1. TANGKAP ERROR JAVASCRIPT DI HALAMAN INI SENDIRI
    // (hanya mencakup bcgo.html/bcgo.js, bukan file lain - lihat catatan di atas)
    window.onerror = function(message, source, lineno, colno, error) {
        const cellTag = "CELL_ERR_BCGO_MONITOR_PAGE";
        handleCellFailure(cellTag, new Error(`[${source || 'bcgo.html'} L:${lineno}] ${message}`));
        return true;
    };

    // 2. PEMANTAUAN KESEHATAN KONEKSI FIRESTORE (INI YANG SUNGGUHAN REAL-TIME)
    function scanOrgansHealth() {
        emitState("IN", "Menghubungkan ke Firestore (mitra_applications)...", "SYS_FIRESTORE_CONNECTION");

        try {
            const q = query(collection(db, "mitra_applications"), orderBy("submittedAt", "desc"), limit(5));

            onSnapshot(q, (snapshot) => {
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

    // Mulai siklus pemantauan
    scanOrgansHealth();

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
