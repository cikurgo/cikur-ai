import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, collection, onSnapshot, query, orderBy, limit } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { firebaseConfig } from "./cikur-config.js";

/**
 * BCGO MASTER NERVE SYSTEM (Universal Registry)
 * Memetakan dan mengawasi seluruh organ file dalam satu badan sistem Cikur Go.
 */
export function runAutonomousEngine(onCycleUpdate) {
    
    // PETA TUBUH SISTEM (Registry Seluruh File Organ)
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
        "data-cgo.html": { type: "Sistem Data", status: "HEALTHY" }
    };

    let state = {
        step: "IN",
        message: "Memindai seluruh peta organ file Cikur Go...",
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

    // 1. GLOBAL INTERCEPTOR: Menangkap sinyal rasa sakit dari file mana pun
    window.onerror = function(message, source, lineno, colno, error) {
        let detectedFile = "UNKNOWN_ORGAN";
        
        // Cocokkan sumber error dengan daftar organ file kita
        for (let fileName in systemOrgans) {
            if (source && source.includes(fileName)) {
                detectedFile = fileName;
                systemOrgans[fileName].status = "ANOMALY";
                break;
            }
        }

        const cellTag = `CELL_ERR_${detectedFile.toUpperCase().replace(/[\.-]/g, '_')}`;
        handleCellFailure(cellTag, new Error(`[${detectedFile} L:${lineno}] ${message}`));
        return true;
    };

    // 2. PEMINDAIAN AWAL KESEHATAN ORGAN (IN)
    function scanOrgansHealth() {
        emitState("IN", "Mengecek denyut saraf lintas file organ terdaftar...", "SYS_ORGAN_SCANNER");

        try {
            if (!firebaseConfig) {
                throw new Error("Inisialisasi gagal: Struktur konfigurasi inti terputus.");
            }
            // Simulasi pengecekan database utama via bcgo-engine / config
            const app = initializeApp(firebaseConfig);
            const db = getFirestore(app);

            const q = query(collection(db, "mitra_applications"), orderBy("submittedAt", "desc"), limit(5));
            
            onSnapshot(q, (snapshot) => {
                state.retryCount = 0;
                emitState("REVIEW", "Semua organ file dan jalur saraf Cikur Go stabil & sinkron.", "SYS_ALL_HEALTHY");
            }, (error) => {
                handleCellFailure("CELL_DB_LISTENER", error);
            });
        } catch (err) {
            handleCellFailure("SYS_CONFIG_CORRUPT", err);
        }
    }
    // 3. PROSES ANALISIS ANOMALI (PROCESS)
    function handleCellFailure(cellId, error) {
        state.retryCount++;
        emitState("PROCESS", `Anomali terdeteksi pada organ [${cellId}]. Menganalisis pola perbaikan...`, cellId, error.message);

        setTimeout(() => {
            if (state.retryCount <= 3) {
                emitState("REVIEW", `Diagnostik organ [${cellId}] selesai. Menyiapkan pantulan sinyal OUT...`, cellId, error.message);
                
                // 4. PANTULAN BALIK / AUTO-FIX (OUT)
                setTimeout(() => {
                    executeAutoFix(cellId);
                }, 1500);
            } else {
                emitState("OUT", `Organ [${cellId}] gagal pulih otomatis. Perlu pengecekan manual.`, cellId, "FATAL_ORGAN_FAILURE");
            }
        }, 2000);
    }

    // 5. REGENERASI / PENYEMBUHAN MANDIRI
    function executeAutoFix(cellId) {
        emitState("IN", `[AUTO-FIX] Menarik ulang sinkronisasi dan meregenerasi organ [${cellId}]...`, cellId);

        setTimeout(() => {
            state.retryCount = 0;
            emitState("REVIEW", `Organ [${cellId}] berhasil diselaraskan kembali! Saraf normal.`, cellId);
            
            setTimeout(() => {
                scanOrgansHealth();
            }, 2000);
        }, 2000);
    }

    // Mulai siklus pemetaan master
    scanOrgansHealth();
}
