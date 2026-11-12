/* ------------------------------------------------------------------
 * NexusPharma.js - In-Silico Drug Discovery Engine (Titanium Grade)
 * ------------------------------------------------------------------
 * Mesin simulasi farmasi 100% Client-Side.
 * - Lipinski's Rule of Five Checker
 * - Euclidean Docking Simulation
 * ------------------------------------------------------------------ */

(function (global) {
  'use strict';

  /**
   * Memeriksa apakah molekul mematuhi Lipinski's Rule of Five.
   * Syarat Lulus: Maksimal 1 pelanggaran.
   */
  function checkLipinski(molecularWeight, logP, hBondDonors, hBondAcceptors) {
    // Reject non-finite numbers or negative inputs
    if ([molecularWeight, logP, hBondDonors, hBondAcceptors].some(v => !Number.isFinite(v) || v < 0)) {
      return "GAGAL (Input Tidak Valid)";
    }
    
    let violations = 0;
    if (molecularWeight > 500) violations++;
    if (logP > 5) violations++;
    if (hBondDonors > 5) violations++;
    if (hBondAcceptors > 10) violations++;

    // Lulus jika maksimal 1 pelanggaran
    return violations > 1 ? "GAGAL (Tidak Layak Obat)" : "LULUS (Kandidat Obat)";
  }

  /**
   * Simulasi Docking Sederhana (Euclidean Distance).
   * Menghitung berapa banyak atom ligan yang berjarak < 4 Å dari protein.
   * Mengembalikan skor afinitas (semakin negatif semakin baik).
   */
  function simulateDocking(ligandCoords, proteinCoords) {
    if (!Array.isArray(ligandCoords) || !Array.isArray(proteinCoords)) {
      return "0.0 kcal/mol";
    }

    const threshold = 4.0; // Jarak Angstrom
    const sigma = 1.0;     // Skor per kontak

    const validLigand = ligandCoords.filter(c => c.length === 3);
    if (validLigand.length === 0) return "0.0 kcal/mol";

    let contacts = 0;
    for (const L of validLigand) {
      for (const P of proteinCoords) {
        if (P.length !== 3) continue;
        const dx = L[0] - P[0];
        const dy = L[1] - P[1];
        const dz = L[2] - P[2];
        const r2 = dx * dx + dy * dy + dz * dz;
        
        // Jika jarak < 4.0 Å, hitung sebagai 1 kontak ikatan
        if (r2 <= threshold * threshold) {
          contacts++;
          break; // Hindari double-counting untuk atom yang sama
        }
      }
    }

    // Semakin banyak kontak, skor semakin negatif (ikatan kuat)
    const affinity = -(contacts / validLigand.length) * sigma;
    return `${affinity.toFixed(1)} kcal/mol`;
  }

  /**
   * Fungsi Uji Mandiri (Self-Test) untuk memvalidasi logika.
   */
  function selfTest() {
    const results = [];
    let passCount = 0;

    const test = (name, condition) => {
      results.push({ name, ok: condition });
      if (condition) passCount++;
    };

    // --- Uji Lipinski ---
    test("Lipinski: Molekul Ideal (Lulus)", checkLipinski(400, 3.1, 2, 5).includes("LULUS"));
    test("Lipinski: Berat Berlebih (Gagal)", checkLipinski(600, 4.5, 1, 4).includes("GAGAL"));
    test("Lipinski: logP Terlalu Tinggi (Gagal)", checkLipinski(450, 6.5, 1, 3).includes("GAGAL"));
    test("Lipinski: Hampir Sempurna (Lulus)", checkLipinski(480, 3.9, 3, 9).includes("LULUS"));
    test("Lipinski: Input Negatif (Gagal)", checkLipinski(-50, 3, 1, 1).includes("GAGAL"));

    // --- Uji Docking ---
    const ligand = [[0, 0, 0], [5, 0, 0], [10, 0, 0]];
    const protein = [[1, 0, 0], [4, 0, 0], [8, 0, 0]];
    const dockResult = simulateDocking(ligand, protein);
    
    // Ekspektasi: 2 dari 3 ligan berikatan. Skor = -(2/3) = -0.7
    test("Docking: Skor Negatif (Ikatan Kuat)", dockResult === "-0.7 kcal/mol");
    
    test("Docking: Array Kosong (Aman)", simulateDocking([], protein) === "0.0 kcal/mol");

    return { ok: passCount === results.length, results };
  }

  // Ekspos API ke global window
  const API = { checkLipinski, simulateDocking, selfTest };
  global.NexusPharma = API;

  // Kompatibilitas Node.js (jika diuji di terminal)
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = API;
  }

})(typeof globalThis !== 'undefined' ? globalThis : this);
