/* ------------------------------------------------------------------
 * NexusPharma.js – In-Silico Drug Discovery Engine
 * Scientific-Grade Client-Side Prototype (v2.2)
 * ------------------------------------------------------------------ */

(function (global) {
  'use strict';

  // Konstanta Coulomb (kcal·Å·mol⁻¹·e⁻²)
  const COULOMB_K = 332.0636;

  // Jarak minimum untuk menghindari singularitas (Å)
  const MIN_R = 0.15;

  // ----------------------------------------------------------------
  // 1. Drug-likeness
  // ----------------------------------------------------------------
  /**
   * evaluateDrugLikeness
   * Menggabungkan Lipinski (Rule of Five) dan Veber.
   *
   * @returns {{status, violations, score, details}}
   */
  function evaluateDrugLikeness(mw, logP, hBondDonors, hBondAcceptors, rotatableBonds, polarSurfaceArea) {
    if ([mw, hBondDonors, hBondAcceptors, rotatableBonds, polarSurfaceArea]
          .some(v => !Number.isFinite(v) || v < 0) || !Number.isFinite(logP)) {
      return {
        status: "GAGAL",
        violations: ["Input tidak valid (finite required; semua kecuali logP harus ≥ 0)"],
        score: 0,
        details: { mw, logP, hBondDonors, hBondAcceptors, rotatableBonds, polarSurfaceArea }
      };
    }

    const checks = [
      { pass: mw < 500,               msg: `MW ${mw.toFixed(1)} ≥ 500 Da` },
      { pass: logP < 5,               msg: `logP ${logP.toFixed(2)} ≥ 5` },
      { pass: hBondDonors < 5,        msg: `H-bond donors ${hBondDonors} ≥ 5` },
      { pass: hBondAcceptors < 10,    msg: `H-bond acceptors ${hBondAcceptors} ≥ 10` },
      { pass: rotatableBonds <= 10,   msg: `Rotatable bonds ${rotatableBonds} > 10` },
      { pass: polarSurfaceArea <= 140,msg: `PSA ${polarSurfaceArea.toFixed(1)} > 140 Å²` }
    ];

    const violations = checks.filter(c => !c.pass).map(c => c.msg);
    const passed = checks.length - violations.length;
    const score = Math.round((passed / checks.length) * 100);

    return {
      status: violations.length === 0 ? "LULUS" : "GAGAL",
      violations,
      score,
      details: {
        passedRules: passed,
        totalRules: checks.length,
        mw, logP, hBondDonors, hBondAcceptors, rotatableBonds, polarSurfaceArea
      }
    };
  }

  // ----------------------------------------------------------------
  // 2. Lennard-Jones 12-6
  // ----------------------------------------------------------------
  /**
   * calculateLennardJones
   *
   * Bentuk klasik:
   *   V_LJ(r) = 4ε [ (σ/r)^12 − (σ/r)^6 ]
   *
   * - (σ/r)^12  →  repulsi jarak dekat (Pauli)
   * - (σ/r)^6   →  atraksi van der Waals
   * - ε         →  kedalaman sumur potensial
   * - σ         →  jarak di mana V = 0
   *
   * Untuk mencegah divergensi ketika r → 0, jarak dibatasi
   * oleh MIN_R. Pada jarak ekstrem (< MIN_R) energi menjadi
   * sangat positif (clash), sesuai fisika.
   *
   * @param {number} r
   * @param {number} [epsilon=0.1]
   * @param {number} [sigma=3.5]
   * @returns {number} energi dalam kcal/mol
   */
  function calculateLennardJones(r, epsilon = 0.1, sigma = 3.5) {
    if (!Number.isFinite(r) || r < 0) return Number.POSITIVE_INFINITY;
    if (!Number.isFinite(epsilon) || epsilon < 0) epsilon = 0.1;
    if (!Number.isFinite(sigma) || sigma <= 0) sigma = 3.5;

    const safeR = Math.max(r, MIN_R);
    const inv = sigma / safeR;
    const inv6 = inv * inv * inv * inv * inv * inv;   // (σ/r)^6
    const inv12 = inv6 * inv6;                        // (σ/r)^12

    return 4 * epsilon * (inv12 - inv6);
  }

  // ----------------------------------------------------------------
  // 3. Docking
  // ----------------------------------------------------------------
  function distance3D(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
    return Math.sqrt(dx*dx + dy*dy + dz*dz);
  }

  function isValidAtom(a) {
    return a &&
      Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z) &&
      Number.isFinite(a.charge);
  }

  /**
   * simulateDockingAdvanced
   *
   * E_total = Σᵢⱼ [ V_LJ(rᵢⱼ) + (k · qᵢqⱼ) / (ε_r · rᵢⱼ) ]
   *
   * Atom boleh membawa parameter opsional: epsilon, sigma.
   * Combining rule sederhana: ε = √(εᵢεⱼ), σ = (σᵢ+σⱼ)/2
   *
   * @param {Array} ligandAtoms
   * @param {Array} proteinAtoms
   * @param {object} [options]  { dielectric=4.0, contactCutoff=4.5 }
   */
  function simulateDockingAdvanced(ligandAtoms, proteinAtoms, options = {}) {
    const dielectric = (Number.isFinite(options.dielectric) && options.dielectric > 0)
      ? options.dielectric : 4.0;
    const contactCutoff = (Number.isFinite(options.contactCutoff) && options.contactCutoff > 0)
      ? options.contactCutoff : 4.5;

    if (!Array.isArray(ligandAtoms) || !Array.isArray(proteinAtoms)) {
      return errorResult("Input harus array of atom objects");
    }

    const lig = ligandAtoms.filter(isValidAtom);
    const pro = proteinAtoms.filter(isValidAtom);

    if (lig.length === 0 || pro.length === 0) {
      return errorResult("Tidak ada atom valid");
    }

    let energyLJ = 0;
    let energyCoulomb = 0;
    let contacts = 0;
    let pairCount = 0;

    for (const L of lig) {
      const epsL = (Number.isFinite(L.epsilon) && L.epsilon >= 0) ? L.epsilon : 0.1;
      const sigL = (Number.isFinite(L.sigma) && L.sigma > 0) ? L.sigma : 3.5;

      for (const P of pro) {
        const epsP = (Number.isFinite(P.epsilon) && P.epsilon >= 0) ? P.epsilon : 0.1;
        const sigP = (Number.isFinite(P.sigma) && P.sigma > 0) ? P.sigma : 3.5;

        // Lorentz-Berthelot
        const epsilon = Math.sqrt(epsL * epsP);
        const sigma   = 0.5 * (sigL + sigP);

        const r = distance3D(L, P);
        const safeR = Math.max(r, MIN_R);

        const lj = calculateLennardJones(safeR, epsilon, sigma);
        energyLJ += Number.isFinite(lj) ? lj : 1000;

        const coul = (COULOMB_K * L.charge * P.charge) / (dielectric * safeR);
        energyCoulomb += Number.isFinite(coul) ? coul : 0;

        if (r < contactCutoff) contacts++;
        pairCount++;
      }
    }

    let total = energyLJ + energyCoulomb;
    if (!Number.isFinite(total)) total = 0;

    const round2 = v => Math.round(v * 100) / 100;

    return {
      energy:          round2(total),
      energyLJ:        round2(energyLJ),
      energyCoulomb:   round2(energyCoulomb),
      unit:            "kcal/mol",
      contacts,
      pairCount,
      dielectric,
      status:          total < -1.0 ? "FAVORABLE"
                       : total > 10.0 ? "CLASH / UNFAVORABLE"
                       : "WEAK / NEUTRAL",
      ligandAtomsUsed: lig.length,
      proteinAtomsUsed: pro.length
    };
  }

  function errorResult(msg) {
    return {
      energy: 0, energyLJ: 0, energyCoulomb: 0,
      unit: "kcal/mol", contacts: 0, pairCount: 0,
      dielectric: null, status: "ERROR", message: msg,
      ligandAtomsUsed: 0, proteinAtomsUsed: 0
    };
  }

  // ----------------------------------------------------------------
  // 4. Self-test
  // ----------------------------------------------------------------
  function selfTest() {
    const results = [];
    let pass = 0;
    const assert = (name, cond) => {
      results.push({ name, ok: !!cond });
      if (cond) pass++;
    };

    // Drug-likeness
    assert("Ideal molecule LULUS 100",
      evaluateDrugLikeness(340, 2.1, 2, 5, 6, 95).status === "LULUS" &&
      evaluateDrugLikeness(340, 2.1, 2, 5, 6, 95).score === 100);

    assert("High MW → GAGAL",
      evaluateDrugLikeness(550, 2, 1, 4, 5, 80).status === "GAGAL");

    assert("High PSA → GAGAL",
      evaluateDrugLikeness(380, 1.8, 2, 6, 7, 155).status === "GAGAL");

    assert("NaN input → GAGAL",
      evaluateDrugLikeness(NaN, 2, 1, 1, 1, 50).status === "GAGAL");

    // Lennard-Jones physics
    const atSigma = calculateLennardJones(3.5, 0.1, 3.5);
    assert("V(σ) ≈ 0", Math.abs(atSigma) < 1e-10);

    const attractive = calculateLennardJones(4.2, 0.15, 3.5);
    assert("Attractive region (r > σ) < 0", attractive < 0);

    const repulsive = calculateLennardJones(2.0, 0.15, 3.5);
    assert("Repulsive region (r < σ) > 0", repulsive > 0);

    const nearZero = calculateLennardJones(0.05, 0.1, 3.5);
    assert("r → 0 remains finite & highly repulsive", Number.isFinite(nearZero) && nearZero > 100);

    // Docking
    const lig = [
      { x: 0, y: 0, z: 0, charge: 0.2, epsilon: 0.12, sigma: 3.4 },
      { x: 1.4, y: 0, z: 0, charge: -0.15 }
    ];
    const pro = [
      { x: 0.7, y: 0.1, z: 0, charge: -0.3, epsilon: 0.1, sigma: 3.6 },
      { x: 3.5, y: 0, z: 0, charge: 0.1 }
    ];
    const dock = simulateDockingAdvanced(lig, pro, { dielectric: 4 });
    assert("Docking finite energy", Number.isFinite(dock.energy));
    assert("Docking separates LJ/Coulomb", Number.isFinite(dock.energyLJ) && Number.isFinite(dock.energyCoulomb));
    assert("Docking atom counts", dock.ligandAtomsUsed === 2 && dock.proteinAtomsUsed === 2);

    assert("Empty ligand → ERROR",
      simulateDockingAdvanced([], pro).status === "ERROR");

    const clash = simulateDockingAdvanced(
      [{ x: 0, y: 0, z: 0, charge: 1 }],
      [{ x: 0, y: 0, z: 0, charge: -1 }]
    );
    assert("Zero-distance remains finite", Number.isFinite(clash.energy));

    return { ok: pass === results.length, passed: pass, total: results.length, results };
  }

  // Public API
  const API = {
    evaluateDrugLikeness,
    calculateLennardJones,
    simulateDockingAdvanced,
    selfTest,
    checkLipinski(mw, logP, donors, acceptors) {
      const r = evaluateDrugLikeness(mw, logP, donors, acceptors, 0, 0);
      return r.status === "LULUS" ? "LULUS (Kandidat Obat)" : "GAGAL (Tidak Layak Obat)";
    },
    version: "2.2.0-scientific"
  };

  global.NexusPharma = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;

})(typeof globalThis !== "undefined" ? globalThis : this);
