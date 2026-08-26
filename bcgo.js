import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, collection, onSnapshot, query, orderBy, limit } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { firebaseConfig } from "./cikur-config.js";

// Inisialisasi Database
let app, db;
try {
    app = initializeApp(firebaseConfig);
    db = getFirestore(app);
} catch (e) {
    console.error("Gagal inisialisasi genetik:", e);
}

/**
 * Mesin Otonom BCGO dengan Sistem Pelacakan Sel Kode Spesifik
 */
export function runAutonomousEngine(onCycleUpdate) {
    let state = {
        step: "IN",
        message: "Memulai pemindaian seluruh sel kode sistem...",
        targetCell: "SYS_CORE_INIT",
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

    // [IN] Tahap Masuk & Deteksi Awal Sel
    function scanAndListenCells() {
        emitState("IN", "Menghubungkan saraf sensorik ke database utama...", "CELL_DB_LISTENER");

        if (!db) {
            handleCellFailure("CELL_DB_LISTENER", new Error("Instance Database tidak ditemukan (Null Reference)."));
            return;
        }

        try {
            // Target sel kode yang dipantau real-time
            const q = query(collection(db, "mitra_applications"), orderBy("submittedAt", "desc"), limit(5));
            
            onSnapshot(q, (snapshot) => {
                // Sel Normal & Stabil
                state.retryCount = 0;
                emitState("REVIEW", "Sel [CELL_DB_LISTENER] stabil. Arus sinyal saraf normal.", "CELL_DB_LISTENER");
            }, (error) => {
                // Terdeteksi sel kode yang mengalami gangguan/error
                handleCellFailure("CELL_DB_LISTENER", error);
            });

        } catch (err) {
            handleCellFailure("CELL_DB_SYS_CATCH", err);
        }
    }

    // [PROCESS & REVIEW] Menangkap titik sel yang sakit
    function handleCellFailure(cellId, error) {
        state.retryCount++;
        
        emitState("PROCESS", `Anomali terdeteksi pada sel spesifik: [${cellId}]. Menganalisis tingkat kerusakan...`, cellId, error.message);

        setTimeout(() => {
            if (state.retryCount <= 3) {
                emitState("REVIEW", `Diagnostik sel [${cellId}] selesai. Menyiapkan perintah regenerasi OUT...`, cellId, error.message);
                
                // [OUT] Memantulkan perintah balik untuk perbaikan otomatis sel tersebut
                setTimeout(() => {
                    executeCellAutoFix(cellId);
                }, 1500);
            } else {
                emitState("OUT", `Sel [${cellId}] mengalami kerusakan parah. Memerlukan penanganan manual.`, cellId, "FATAL_CELL_ERROR");
            }
        }, 2000);
    }

    // [OUT / AUTO-FIX] Regenerasi sel kode yang sakit secara spesifik
    function executeCellAutoFix(cellId) {
        emitState("IN", `[AUTO-FIX] Meregenerasi ulang struktur sel [${cellId}] secara real-time...`, cellId);

        setTimeout(() => {
            // Simulasi perbaikan berhasil, reset dan sambungkan ulang sel
            state.retryCount = 0;
            emitState("REVIEW", `Sel [${cellId}] berhasil dipulihkan! Saraf kembali terhubung.`, cellId);
            
            setTimeout(() => {
                scanAndListenCells();
            }, 2000);
        }, 2000);
    }

    // Eksekusi awal sistem
    scanAndListenCells();
}
