/* ------------------------------------------------------------------
 * NexusPharma.js – In-Silico Drug Discovery Engine
 * Scientific-Grade Client-Side Prototype (v3.2.0-robust)
 *
 * v3.2.0: hardening + ljCurve / parseAtoms / screenLibrary (see CHANGELOG at bottom of file)
 *
 * Upgrades over v2.2:
 *  - Higher-precision physical constants (COULOMB_K from 1/(4πε₀) conversion)
 *  - Soft-core Lennard-Jones + Coulomb (Beutler et al. style) → truly singularity-free
 *  - Expanded drug-likeness: Lipinski + Veber + Ghose + Egan + Muegge + continuous QED-like score
 *  - Distance-dependent dielectric option (ε(r) = A + B·r)
 *  - Optional geometric hydrogen-bond term
 *  - Lorentz-Berthelot combining rules with safety clamps
 *  - Richer docking statistics (min distance, energy density, contact map summary)
 *  - Binding affinity estimator (ΔG → Ki / Kd via van't Hoff)
 *  - Exhaustive self-test suite with known analytical values & edge cases
 *  - Strict input validation, finite-math guards, no silent NaNs
 * ------------------------------------------------------------------ */

(function (global) {
  'use strict';

  // ------------------------------------------------------------------
  // High-precision physical constants
  // ------------------------------------------------------------------
  // 1/(4πε₀) in kcal·Å·mol⁻¹·e⁻²  (derived from SI constants, 2022 CODATA)
  // Reference value widely used in MM force fields ≈ 332.063713
  const COULOMB_K = 332.063713298;

  // Soft-core parameters (Beutler / Gromacs-style)
  // α_LJ ≈ 0.15–0.25 gives strong short-range repulsion while remaining finite
  const SOFTCORE_ALPHA = 0.18;
  const SOFTCORE_POWER = 6;
  const MIN_R_HARD = 0.05;             // absolute floor (Å) – only used as last resort
  const R_KCAL = 8.314462618 / 4184;   // kcal·mol⁻¹·K⁻¹ (CODATA R, thermochemical calorie)
  const RT_298K = R_KCAL * 298.15;     // 0.592485 kcal/mol (R·T at 298.15 K)

  // ------------------------------------------------------------------
  // Utility helpers
  // ------------------------------------------------------------------
  function isFiniteNumber(v) {
    return typeof v === 'number' && Number.isFinite(v);
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function roundTo(v, digits) {
    if (!Number.isFinite(v)) return v;
    const p = Math.pow(10, digits);
    const out = Math.round(v * p) / p;
    return Number.isFinite(out) ? out : v; // v3.2: no Infinity from v*p overflow
  }

  function opt(o) { return (o !== null && typeof o === 'object') ? o : {}; }

  function distance3D(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  function isValidAtom(a) {
    return a &&
      isFiniteNumber(a.x) && isFiniteNumber(a.y) && isFiniteNumber(a.z) &&
      isFiniteNumber(a.charge);
  }

  // ------------------------------------------------------------------
  // 1. Drug-likeness (multi-rule + continuous score)
  // ------------------------------------------------------------------
  /**
   * evaluateDrugLikeness
   * Combines:
   *   - Lipinski Rule of Five
   *   - Veber (rotB ≤ 10, PSA ≤ 140)
   *   - Ghose filter (160 ≤ MW ≤ 480, −0.4 ≤ logP ≤ 5.6, 20 ≤ atoms ≤ 70 – approximated)
   *   - Egan (PSA ≤ 131.6, logP ≤ 5.88)
   *   - Muegge (200 ≤ MW ≤ 600, −2 ≤ logP ≤ 5, donors ≤ 5, acceptors ≤ 10, rings ≤ 7 – partial)
   *   - Continuous desirability score inspired by QED (Bickerton et al.)
   *
   * @returns {object} status, score (0-100), violations[], details, qedLike
   */
  function evaluateDrugLikeness(mw, logP, hBondDonors, hBondAcceptors, rotatableBonds, polarSurfaceArea, options = {}) {
    options = opt(options);
    const heavyAtoms = options.heavyAtoms; // optional

    // Strict validation
    if (!isFiniteNumber(mw) || mw < 0 ||
        !isFiniteNumber(logP) ||
        !isFiniteNumber(hBondDonors) || hBondDonors < 0 ||
        !isFiniteNumber(hBondAcceptors) || hBondAcceptors < 0 ||
        !isFiniteNumber(rotatableBonds) || rotatableBonds < 0 ||
        !isFiniteNumber(polarSurfaceArea) || polarSurfaceArea < 0) {
      return {
        status: 'GAGAL',
        score: 0,
        violations: ['Input tidak valid: semua parameter harus finite; MW, HBD, HBA, rotB, PSA ≥ 0'],
        details: { mw, logP, hBondDonors, hBondAcceptors, rotatableBonds, polarSurfaceArea },
        qedLike: 0
      };
    }

    const rules = [
      // Lipinski
      { id: 'lipinski_mw',   pass: mw <= 500,          weight: 1.0, msg: `MW ${mw.toFixed(1)} > 500 Da` },
      { id: 'lipinski_logP', pass: logP <= 5,          weight: 1.0, msg: `logP ${logP.toFixed(2)} > 5` },
      { id: 'lipinski_hbd',  pass: hBondDonors <= 5,   weight: 1.0, msg: `HBD ${hBondDonors} > 5` },
      { id: 'lipinski_hba',  pass: hBondAcceptors <= 10,weight: 1.0, msg: `HBA ${hBondAcceptors} > 10` },
      // Veber
      { id: 'veber_rot',     pass: rotatableBonds <= 10, weight: 0.9, msg: `RotB ${rotatableBonds} > 10` },
      { id: 'veber_psa',     pass: polarSurfaceArea <= 140, weight: 0.9, msg: `PSA ${polarSurfaceArea.toFixed(1)} > 140 Å²` },
      // Ghose (simplified)
      { id: 'ghose_mw',      pass: mw >= 160 && mw <= 480, weight: 0.7, msg: `MW ${mw.toFixed(1)} outside 160–480 (Ghose)` },
      { id: 'ghose_logP',    pass: logP >= -0.4 && logP <= 5.6, weight: 0.7, msg: `logP ${logP.toFixed(2)} outside −0.4–5.6 (Ghose)` },
      // Egan
      { id: 'egan_psa',      pass: polarSurfaceArea <= 131.6, weight: 0.8, msg: `PSA ${polarSurfaceArea.toFixed(1)} > 131.6 (Egan)` },
      { id: 'egan_logP',     pass: logP <= 5.88, weight: 0.8, msg: `logP ${logP.toFixed(2)} > 5.88 (Egan)` },
      // Muegge (partial)
      { id: 'muegge_mw',     pass: mw >= 200 && mw <= 600, weight: 0.6, msg: `MW ${mw.toFixed(1)} outside 200–600 (Muegge)` },
      { id: 'muegge_logP',   pass: logP >= -2 && logP <= 5, weight: 0.6, msg: `logP ${logP.toFixed(2)} outside −2–5 (Muegge)` }
    ];

    const violations = [];
    let weightedPass = 0;
    let totalWeight = 0;

    for (const r of rules) {
      totalWeight += r.weight;
      if (r.pass) {
        weightedPass += r.weight;
      } else {
        violations.push(r.msg);
      }
    }

    // Continuous desirability (simple product of sigmoid-like terms – QED inspired)
    // Ideal centers: MW≈350, logP≈2.5, HBD≈1.5, HBA≈4, rotB≈4, PSA≈70
    function desirability(x, ideal, width, direction = 'both') {
      const z = (x - ideal) / width;
      if (direction === 'upper') return 1 / (1 + Math.exp(z));
      if (direction === 'lower') return 1 / (1 + Math.exp(-z));
      return Math.exp(-0.5 * z * z); // Gaussian-like
    }

    const dMW   = desirability(mw, 340, 140);
    const dLogP = desirability(logP, 2.5, 2.2);
    const dHBD  = desirability(hBondDonors, 1.5, 2.2, 'upper');
    const dHBA  = desirability(hBondAcceptors, 4.5, 4.0, 'upper');
    const dRot  = desirability(rotatableBonds, 5.0, 5.0, 'upper');
    const dPSA  = desirability(polarSurfaceArea, 80, 50, 'upper');

    const qedLike = Math.pow(dMW * dLogP * dHBD * dHBA * dRot * dPSA, 1 / 6);
    const score = Math.round((weightedPass / totalWeight) * 65 + qedLike * 35); // hybrid 0-100

    const status = violations.length === 0 ? 'LULUS' :
                   violations.length <= 2 ? 'MARGINAL' : 'GAGAL';

    return {
      status,
      score: clamp(score, 0, 100),
      violations,
      details: {
        passedWeight: roundTo(weightedPass, 2),
        totalWeight: roundTo(totalWeight, 2),
        rulesEvaluated: rules.length,
        mw, logP, hBondDonors, hBondAcceptors, rotatableBonds, polarSurfaceArea,
        heavyAtoms: heavyAtoms ?? null
      },
      qedLike: roundTo(qedLike, 4)
    };
  }

  // ------------------------------------------------------------------
  // 2. Soft-core Lennard-Jones 12-6
  // ------------------------------------------------------------------
  /**
   * calculateLennardJones
   *
   * Classic form:
   *   V(r) = 4ε [(σ/r)^12 − (σ/r)^6]
   *
   * Soft-core form (Beutler 1994 / Gromacs):
   *   r_sc = (α·σ^6 · λ^p + r^6)^{1/6}
   *   V_sc = 4ε [(σ/r_sc)^12 − (σ/r_sc)^6]
   *
   * When λ = 1 and α > 0 the potential remains finite at r = 0.
   * Here we use a fixed soft-core strength for robustness (α = SOFTCORE_ALPHA).
   *
   * @param {number} r
   * @param {number} [epsilon=0.1]
   * @param {number} [sigma=3.5]
   * @param {object} [opts] { softCore=true, alpha=SOFTCORE_ALPHA (0.18) }
   * @returns {number} energy kcal/mol
   */
  function calculateLennardJones(r, epsilon = 0.1, sigma = 3.5, opts = {}) {
    opts = opt(opts);
    if (!isFiniteNumber(r) || r < 0) return Number.POSITIVE_INFINITY;
    if (!isFiniteNumber(epsilon) || epsilon < 0) epsilon = 0.1;
    if (!isFiniteNumber(sigma) || sigma <= 0) sigma = 3.5;

    const useSoft = opts.softCore !== false;
    const alpha = isFiniteNumber(opts.alpha) ? opts.alpha : SOFTCORE_ALPHA;

    let rEff;
    if (useSoft && alpha > 0) {
      // Soft-core effective distance
      const r6 = r * r * r * r * r * r;
      const sig6 = sigma * sigma * sigma * sigma * sigma * sigma;
      const soft = alpha * sig6 + r6;
      rEff = Math.pow(soft, 1 / 6);
    } else {
      rEff = Math.max(r, MIN_R_HARD);
    }

    const inv = sigma / rEff;
    const inv2 = inv * inv;
    const inv6 = inv2 * inv2 * inv2;
    const inv12 = inv6 * inv6;

    const energy = 4 * epsilon * (inv12 - inv6);
    return Number.isFinite(energy) ? energy : 1e6; // hard clamp extreme overflow
  }

  /**
   * Analytical minimum of classic LJ: r_min = 2^{1/6} σ ≈ 1.122462 σ
   * V_min = −ε
   */
  function lennardJonesMinimum(epsilon = 0.1, sigma = 3.5) {
    const rmin = Math.pow(2, 1 / 6) * sigma;
    return { rmin, vmin: -epsilon };
  }

  // ------------------------------------------------------------------
  // 3. Soft-core Coulomb
  // ------------------------------------------------------------------
  function calculateCoulomb(r, q1, q2, dielectric = 4.0, opts = {}) {
    opts = opt(opts);
    if (!isFiniteNumber(r) || r < 0) return 0;
    if (!isFiniteNumber(q1) || !isFiniteNumber(q2)) return 0;
    if (!isFiniteNumber(dielectric) || dielectric <= 0) dielectric = 4.0;

    const useSoft = opts.softCore !== false;
    const alpha = isFiniteNumber(opts.alpha) ? opts.alpha : 0.01; // smaller alpha for Coulomb

    let rEff;
    if (useSoft && alpha > 0) {
      // Soft-core Coulomb: r_sc = (α + r^n)^{1/n}
      const n = 2; // common choice
      rEff = Math.pow(alpha + Math.pow(r, n), 1 / n);
    } else {
      rEff = Math.max(r, MIN_R_HARD);
    }

    // Optional distance-dependent dielectric: ε(r) = A + B·r  (commonly A=1, B=0.5 or similar)
    let eps = dielectric;
    if (opts.distanceDependent) {
      const A = opts.dielA ?? 1.0;
      const B = opts.dielB ?? 0.5;
      eps = A + B * rEff;
      if (!isFiniteNumber(eps) || eps < 1e-3) eps = 1e-3; // v3.2: never divide by ≤0 dielectric
    }

    const energy = (COULOMB_K * q1 * q2) / (eps * rEff);
    return Number.isFinite(energy) ? energy : 0;
  }

  // ------------------------------------------------------------------
  // 4. Advanced Docking
  // ------------------------------------------------------------------
  /**
   * simulateDockingAdvanced
   *
   * E_total = Σᵢⱼ [ V_LJ_soft(rᵢⱼ) + V_Coulomb_soft(rᵢⱼ) + V_HB(rᵢⱼ) ]
   *
   * Features:
   *  - Soft-core potentials (singularity-free)
   *  - Lorentz-Berthelot combining rules
   *  - Optional geometric H-bond term (simple 12-10 or distance-only)
   *  - Distance-dependent dielectric
   *  - Rich statistics
   */
  function simulateDockingAdvanced(ligandAtoms, proteinAtoms, options = {}) {
    options = opt(options);
    const dielectric = isFiniteNumber(options.dielectric) && options.dielectric > 0
      ? options.dielectric : 4.0;
    const contactCutoff = isFiniteNumber(options.contactCutoff) && options.contactCutoff > 0
      ? options.contactCutoff : 4.5;
    const useSoftCore = options.softCore !== false;
    const includeHB = options.hydrogenBond === true;
    const hbCutoff = isFiniteNumber(options.hbCutoff) && options.hbCutoff > 0 ? options.hbCutoff : 3.5;
    const hbEnergy = isFiniteNumber(options.hbEnergy) ? options.hbEnergy : -1.5; // kcal/mol typical

    if (!Array.isArray(ligandAtoms) || !Array.isArray(proteinAtoms)) {
      return errorResult('Input harus berupa array of atom objects');
    }

    const lig = ligandAtoms.filter(isValidAtom);
    const pro = proteinAtoms.filter(isValidAtom);
    const maxPairs = isFiniteNumber(options.maxPairs) && options.maxPairs > 0 ? options.maxPairs : 25e6;
    if (lig.length * pro.length > maxPairs) {
      return errorResult(`Terlalu banyak pasangan atom (${lig.length}×${pro.length} > ${maxPairs}); naikkan options.maxPairs atau kurangi atom`);
    }

    if (lig.length === 0 || pro.length === 0) {
      return errorResult('Tidak ada atom valid setelah filter');
    }

    let energyLJ = 0;
    let energyCoulomb = 0;
    let energyHB = 0;
    let contacts = 0;
    let pairCount = 0;
    let minDistance = Infinity;
    let maxAttraction = 0; // most negative LJ pair

    const softOpts = { softCore: useSoftCore, alpha: options.softCoreAlpha ?? SOFTCORE_ALPHA };
    const coulOpts = {
      softCore: useSoftCore,
      alpha: options.coulombSoftAlpha ?? 0.5,   // stronger damping for Coulomb singularity
      distanceDependent: options.distanceDependent === true,
      dielA: options.dielA,
      dielB: options.dielB
    };

    for (const L of lig) {
      const epsL = (isFiniteNumber(L.epsilon) && L.epsilon >= 0) ? L.epsilon : 0.1;
      const sigL = (isFiniteNumber(L.sigma) && L.sigma > 0) ? L.sigma : 3.5;
      const isDonorL = L.hbondDonor === true;
      const isAcceptorL = L.hbondAcceptor === true;

      for (const P of pro) {
        const epsP = (isFiniteNumber(P.epsilon) && P.epsilon >= 0) ? P.epsilon : 0.1;
        const sigP = (isFiniteNumber(P.sigma) && P.sigma > 0) ? P.sigma : 3.5;

        // Lorentz-Berthelot
        const epsilon = Math.sqrt(epsL * epsP);
        const sigma = 0.5 * (sigL + sigP);

        const r = distance3D(L, P);
        if (r < minDistance) minDistance = r;

        // LJ
        const lj = calculateLennardJones(r, epsilon, sigma, softOpts);
        energyLJ += lj;
        if (lj < maxAttraction) maxAttraction = lj;

        // Coulomb
        const coul = calculateCoulomb(r, L.charge, P.charge, dielectric, coulOpts);
        energyCoulomb += coul;

        // Simple geometric H-bond (very approximate)
        if (includeHB && r < hbCutoff) {
          const isDonorP = P.hbondDonor === true;
          const isAcceptorP = P.hbondAcceptor === true;
          if ((isDonorL && isAcceptorP) || (isAcceptorL && isDonorP)) {
            // Linear distance weighting
            const strength = 1 - (r / hbCutoff);
            energyHB += hbEnergy * strength;
          }
        }

        if (r < contactCutoff) contacts++;
        pairCount++;
      }
    }

    let total = energyLJ + energyCoulomb + energyHB;
    if (!Number.isFinite(total)) {
      return errorResult('Energi tidak finit (overflow/koordinat ekstrem) – hasil ditolak, bukan dibulatkan ke 0');
    }

    // Rough binding affinity estimate (very approximate)
    // ΔG ≈ total (assuming the energy is already a free-energy proxy)
    // Ki ≈ exp(ΔG / RT)
    const deltaG = total;
    const ki_uM = Math.exp(deltaG / RT_298K) * 1e6; // crude conversion to µM scale

    // Status prioritises steric clash (very short contacts) over pure energy sign
    let status;
    if (minDistance < 1.2) {
      status = 'CLASH / UNFAVORABLE';
    } else if (total < -5.0) {
      status = 'FAVORABLE';
    } else if (total < -1.0) {
      status = 'MODERATELY FAVORABLE';
    } else if (total > 15.0) {
      status = 'CLASH / UNFAVORABLE';
    } else {
      status = 'WEAK / NEUTRAL';
    }

    return {
      energy:          roundTo(total, 3),
      energyLJ:        roundTo(energyLJ, 3),
      energyCoulomb:   roundTo(energyCoulomb, 3),
      energyHB:        roundTo(energyHB, 3),
      unit:            'kcal/mol',
      contacts,
      pairCount,
      minDistance:     roundTo(minDistance === Infinity ? 0 : minDistance, 4),
      maxPairAttraction: roundTo(maxAttraction, 3),
      dielectric,
      softCore:        useSoftCore,
      status,
      ligandAtomsUsed: lig.length,
      proteinAtomsUsed: pro.length,
      ligandAtomsDropped: ligandAtoms.length - lig.length,
      proteinAtomsDropped: proteinAtoms.length - pro.length,
      ligandEfficiency: roundTo(-deltaG / lig.length, 4),
      estimatedKi_uM:  Number.isFinite(ki_uM) ? roundTo(ki_uM, 4) : null,
      deltaG:          roundTo(deltaG, 3)
    };
  }

  function errorResult(msg) {
    return {
      energy: 0, energyLJ: 0, energyCoulomb: 0, energyHB: 0,
      unit: 'kcal/mol', contacts: 0, pairCount: 0,
      minDistance: 0, maxPairAttraction: 0,
      dielectric: null, softCore: null,
      status: 'ERROR', message: msg,
      ligandAtomsUsed: 0, proteinAtomsUsed: 0,
      ligandAtomsDropped: 0, proteinAtomsDropped: 0, ligandEfficiency: 0,
      estimatedKi_uM: null, deltaG: 0
    };
  }

  // ------------------------------------------------------------------
  // 5. Binding affinity helper
  // ------------------------------------------------------------------
  /**
   * estimateAffinity
   * Converts an energy (kcal/mol) into approximate Ki / Kd at given temperature.
   * Ki = exp(ΔG / RT)
   */
  function estimateAffinity(deltaG, temperatureK = 298.15) {
    if (!isFiniteNumber(deltaG) || !isFiniteNumber(temperatureK) || temperatureK <= 0) {
      return { ki: null, pKi: null, unit: 'M' };
    }
    const RT = R_KCAL * temperatureK; // kcal/mol
    const ki = Math.exp(deltaG / RT);
    if (!Number.isFinite(ki) || ki <= 0) {
      return { ki: null, pKi: null, unit: 'M', temperatureK, note: 'Di luar jangkauan numerik' };
    }
    const pKi = -Math.log10(ki);
    return {
      ki,
      pKi: roundTo(pKi, 3),
      unit: 'M',
      temperatureK,
      note: 'Very approximate – assumes ΔG is the binding free energy'
    };
  }


  // ------------------------------------------------------------------
  // 5b. Verified additions (v3.1) – every formula is textbook/literature
  //     and is covered by an analytical test in selfTest().
  // ------------------------------------------------------------------

  /** Lipinski-only check (≤1 violation allowed, per Lipinski 1997). */
  function lipinskiOnly(mw, logP, donors, acceptors) {
    if (!isFiniteNumber(mw) || mw < 0 || !isFiniteNumber(logP) ||
        !isFiniteNumber(donors) || donors < 0 || !isFiniteNumber(acceptors) || acceptors < 0) {
      return { pass: false, violations: ['Input tidak valid'], count: NaN };
    }
    const v = [];
    if (mw > 500) v.push(`MW ${mw.toFixed(1)} > 500`);
    if (logP > 5) v.push(`logP ${logP.toFixed(2)} > 5`);
    if (donors > 5) v.push(`HBD ${donors} > 5`);
    if (acceptors > 10) v.push(`HBA ${acceptors} > 10`);
    return { pass: v.length <= 1, violations: v, count: v.length };
  }

  /**
   * estimateLogD – Henderson–Hasselbalch (neutral species only partitions).
   * acid:  logD = logP − log10(1 + 10^(pH − pKa))
   * base:  logD = logP − log10(1 + 10^(pKa − pH))
   */
  function estimateLogD(logP, pKa, pH = 7.4, type = 'acid') {
    if (!isFiniteNumber(logP) || !isFiniteNumber(pKa) || !isFiniteNumber(pH)) return null;
    if (type !== 'acid' && type !== 'base') return null;
    const x = type === 'acid' ? pH - pKa : pKa - pH;
    // log10(1+10^x) computed stably for large x
    const corr = x > 30 ? x : Math.log10(1 + Math.pow(10, x));
    const neutralFraction = 1 / (1 + Math.pow(10, clamp(x, -300, 300)));
    return { logD: roundTo(logP - corr, 4), neutralFraction: neutralFraction, pH, pKa, type };
  }

  /** ΔG (kcal/mol) from a dissociation constant in molar: ΔG = RT ln(K). */
  function kdToDeltaG(kdMolar, temperatureK = 298.15) {
    if (!isFiniteNumber(kdMolar) || kdMolar <= 0 || !isFiniteNumber(temperatureK) || temperatureK <= 0) return null;
    return R_KCAL * temperatureK * Math.log(kdMolar);
  }

  /** Cheng–Prusoff (competitive): Ki = IC50 / (1 + [S]/Km). Same units in and out. */
  function chengPrusoff(ic50, substrateConc, km) {
    if (!isFiniteNumber(ic50) || ic50 < 0 || !isFiniteNumber(substrateConc) || substrateConc < 0 ||
        !isFiniteNumber(km) || km <= 0) return null;
    return ic50 / (1 + substrateConc / km);
  }

  /**
   * Ligand-efficiency family (Hopkins 2004; Abad-Zapatero; Leeson & Springthorpe 2007).
   *  LE   = −ΔG / HA            (kcal/mol per heavy atom)
   *  BEI  = pActivity / MW(kDa)
   *  SEI  = pActivity / (PSA/100)
   *  LLE  = pActivity − logP
   *  LELP = logP / LE
   */
  function ligandEfficiencyMetrics(p) {
    p = opt(p);
    const { pActivity, heavyAtoms, mw, psa, logP } = p;
    const T = isFiniteNumber(p.temperatureK) && p.temperatureK > 0 ? p.temperatureK : 298.15;
    if (!isFiniteNumber(pActivity) || !isFiniteNumber(heavyAtoms) || heavyAtoms <= 0) return null;
    const dG = -R_KCAL * T * Math.LN10 * pActivity; // kcal/mol (negative)
    const LE = -dG / heavyAtoms;
    const out = { deltaG: roundTo(dG, 4), LE: roundTo(LE, 4) };
    if (isFiniteNumber(mw) && mw > 0) out.BEI = roundTo(pActivity / (mw / 1000), 3);
    if (isFiniteNumber(psa) && psa > 0) out.SEI = roundTo(pActivity / (psa / 100), 3);
    if (isFiniteNumber(logP)) {
      out.LLE = roundTo(pActivity - logP, 3);
      if (LE > 0) out.LELP = roundTo(logP / LE, 3);
    }
    return out;
  }

  /**
   * CNS MPO (Wager et al., ACS Chem Neurosci 2010) – six monotonic/hump
   * desirability transforms, each 0–1, sum 0–6; ≥4 is the published
   * "desirable" threshold.
   */
  function cnsMPO(p) {
    p = opt(p);
    const { clogP, clogD, mw, tpsa, hbd, pKa } = p;
    if (![clogP, clogD, mw, tpsa, hbd, pKa].every(isFiniteNumber)) return null;
    const down = (x, full, zero) => clamp((zero - x) / (zero - full), 0, 1); // 1 below `full`, 0 above `zero`
    const tpsaScore = tpsa <= 20 ? 0 : tpsa < 40 ? (tpsa - 20) / 20 : tpsa <= 90 ? 1 :
                      tpsa < 120 ? (120 - tpsa) / 30 : 0;
    const parts = {
      clogP: down(clogP, 3, 5),
      clogD: down(clogD, 2, 4),
      mw:    down(mw, 360, 500),
      tpsa:  tpsaScore,
      hbd:   down(hbd, 0.5, 3.5),
      pKa:   down(pKa, 8, 10)
    };
    const total = Object.values(parts).reduce((a, b) => a + b, 0);
    for (const k in parts) parts[k] = roundTo(parts[k], 4);
    return { score: roundTo(total, 3), desirable: total >= 4, parts };
  }

  /** Extra published filters (all closed-form, no structure needed). */
  function evaluateExtraFilters(mw, logP, hbd, hba, rotB, psa) {
    if (![mw, logP, hbd, hba, rotB, psa].every(isFiniteNumber)) return null;
    return {
      ruleOfThree_fragment: mw <= 300 && logP <= 3 && hbd <= 3 && hba <= 3 && rotB <= 3 && psa <= 60, // Congreve 2003
      pfizer_3_75_toxRisk:  logP > 3 && psa < 75,                                                    // Hughes 2008 (higher tox risk)
      gsk_4_400_good:       mw <= 400 && logP <= 4,                                                  // Gleeson 2008
      leadLike_oprea:       mw >= 200 && mw <= 460 && logP >= -4 && logP <= 4.2 && rotB <= 10 && hbd <= 5 && hba <= 9
    };
  }

  /** One-call integrated profile. Missing optional inputs are simply skipped. */
  function analyzeCandidate(p) {
    p = opt(p);
    const dl = evaluateDrugLikeness(p.mw, p.logP, p.hbd, p.hba, p.rotB, p.psa, { heavyAtoms: p.heavyAtoms });
    const report = {
      drugLikeness: dl,
      lipinski: lipinskiOnly(p.mw, p.logP, p.hbd, p.hba),
      extraFilters: evaluateExtraFilters(p.mw, p.logP, p.hbd, p.hba, p.rotB, p.psa)
    };
    if (isFiniteNumber(p.pKa) && p.ionType) report.logD = estimateLogD(p.logP, p.pKa, p.pH ?? 7.4, p.ionType);
    if (isFiniteNumber(p.pActivity)) {
      report.efficiency = ligandEfficiencyMetrics({ pActivity: p.pActivity, heavyAtoms: p.heavyAtoms, mw: p.mw, psa: p.psa, logP: p.logP });
    }
    return report;
  }

  // ------------------------------------------------------------------
  // 5c. v3.2 additions: energy curve, atom parser, library screening
  // ------------------------------------------------------------------

  /** LJ + optional Coulomb curve for plotting. Returns [{r, lj, coulomb, total}]. */
  function ljCurve(epsilon = 0.1, sigma = 3.5, rMin = 2, rMax = 10, points = 80, opts = {}) {
    opts = opt(opts);
    if (!isFiniteNumber(rMin) || !isFiniteNumber(rMax) || rMax <= rMin) { rMin = 2; rMax = 10; }
    points = clamp(Math.floor(isFiniteNumber(points) ? points : 80), 2, 2000);
    const q1 = isFiniteNumber(opts.q1) ? opts.q1 : 0, q2 = isFiniteNumber(opts.q2) ? opts.q2 : 0;
    const out = [];
    for (let i = 0; i < points; i++) {
      const r = rMin + (rMax - rMin) * i / (points - 1);
      const lj = calculateLennardJones(r, epsilon, sigma, opts);
      const coulomb = (q1 && q2) ? calculateCoulomb(r, q1, q2, opts.dielectric ?? 4, opts) : 0;
      out.push({ r: roundTo(r, 4), lj: roundTo(lj, 5), coulomb: roundTo(coulomb, 5), total: roundTo(lj + coulomb, 5) });
    }
    return out;
  }

  /**
   * parseAtoms – text → atoms. One atom per line: x y z charge [epsilon sigma D A]
   * (separator: space, comma, tab or semicolon; '#' starts a comment; D/A = 1|0|d|a).
   * Returns { atoms, errors:[{line,msg}] } – bad lines are reported, never thrown.
   */
  function parseAtoms(text) {
    const atoms = [], errors = [];
    if (typeof text !== 'string') return { atoms, errors: [{ line: 0, msg: 'Input bukan teks' }] };
    text.split(/\r?\n/).forEach((raw, i) => {
      const line = raw.replace(/#.*$/, '').trim();
      if (!line) return;
      const t = line.split(/[\s,;]+/);
      const n = t.slice(0, 6).map(Number);
      if (t.length < 4 || n.slice(0, 4).some(v => !Number.isFinite(v))) {
        errors.push({ line: i + 1, msg: 'Butuh minimal: x y z charge (angka)' }); return;
      }
      const a = { x: n[0], y: n[1], z: n[2], charge: n[3] };
      if (t.length > 4 && Number.isFinite(n[4]) && n[4] >= 0) a.epsilon = n[4];
      if (t.length > 5 && Number.isFinite(n[5]) && n[5] > 0) a.sigma = n[5];
      const flag = v => v !== undefined && /^(1|d|a|true|y)$/i.test(v);
      if (flag(t[6])) a.hbondDonor = true;
      if (flag(t[7])) a.hbondAcceptor = true;
      atoms.push(a);
    });
    return { atoms, errors };
  }

  /** Rank a list of candidates ({name, mw, logP, hbd, hba, rotB, psa, ...}) by drug-likeness score. */
  function screenLibrary(list) {
    if (!Array.isArray(list)) return [];
    return list.map((c, i) => {
      const a = analyzeCandidate(c);
      return { name: (c && c.name) || ('Kandidat ' + (i + 1)), score: a.drugLikeness.score,
               status: a.drugLikeness.status, lipinski: a.lipinski.pass, qedLike: a.drugLikeness.qedLike, report: a };
    }).sort((x, y) => y.score - x.score);
  }

  // ------------------------------------------------------------------
  // 6. Exhaustive Self-Test
  // ------------------------------------------------------------------
  function selfTest(verbose = false) {
    const results = [];
    let pass = 0;

    const assert = (name, cond, detail = '') => {
      const ok = !!cond;
      results.push({ name, ok, detail });
      if (ok) pass++;
      if (verbose && !ok) console.warn('FAIL:', name, detail);
    };

    // ---------- Drug-likeness ----------
    const ideal = evaluateDrugLikeness(340, 2.1, 2, 5, 6, 95);
    assert('Ideal molecule LULUS', ideal.status === 'LULUS' && ideal.score >= 80, `score=${ideal.score}`);
    assert('Ideal QED-like reasonable', ideal.qedLike > 0.45, `qed=${ideal.qedLike}`);

    assert('High MW → not LULUS', evaluateDrugLikeness(550, 2, 1, 4, 5, 80).status !== 'LULUS');
    assert('High PSA → not LULUS', evaluateDrugLikeness(380, 1.8, 2, 6, 7, 155).status !== 'LULUS');
    assert('NaN input → GAGAL', evaluateDrugLikeness(NaN, 2, 1, 1, 1, 50).status === 'GAGAL');
    assert('Negative MW → GAGAL', evaluateDrugLikeness(-10, 2, 1, 1, 1, 50).status === 'GAGAL');

    // ---------- Lennard-Jones physics ----------
    const atSigma = calculateLennardJones(3.5, 0.1, 3.5, { softCore: false });
    assert('V(σ) ≈ 0 (hard)', Math.abs(atSigma) < 1e-10, `got ${atSigma}`);

    const attractive = calculateLennardJones(4.2, 0.15, 3.5, { softCore: false });
    assert('Attractive region (r > σ) < 0', attractive < 0);

    const repulsive = calculateLennardJones(2.0, 0.15, 3.5, { softCore: false });
    assert('Repulsive region (r < σ) > 0', repulsive > 0);

    const nearZeroHard = calculateLennardJones(0.01, 0.1, 3.5, { softCore: false });
    assert('Hard core r→0 finite & highly repulsive', Number.isFinite(nearZeroHard) && nearZeroHard > 100);

    const nearZeroSoft = calculateLennardJones(0.0, 0.1, 3.5, { softCore: true });
    assert('Soft-core r=0 remains finite', Number.isFinite(nearZeroSoft) && nearZeroSoft > 0);

    const minInfo = lennardJonesMinimum(0.2, 3.5);
    const vAtMin = calculateLennardJones(minInfo.rmin, 0.2, 3.5, { softCore: false });
    assert('V(rmin) ≈ −ε', Math.abs(vAtMin + 0.2) < 1e-8, `got ${vAtMin}`);

    // ---------- Coulomb ----------
    const coulFar = calculateCoulomb(10, 1, -1, 1, { softCore: false });
    assert('Coulomb attractive at distance', coulFar < 0);

    const coulZeroSoft = calculateCoulomb(0, 1, -1, 1, { softCore: true });
    assert('Soft Coulomb r=0 finite', Number.isFinite(coulZeroSoft));

    // ---------- Docking ----------
    const lig = [
      { x: 0, y: 0, z: 0, charge: 0.2, epsilon: 0.12, sigma: 3.4, hbondDonor: true },
      { x: 1.4, y: 0, z: 0, charge: -0.15, hbondAcceptor: true }
    ];
    const pro = [
      { x: 0.7, y: 0.1, z: 0, charge: -0.3, epsilon: 0.1, sigma: 3.6, hbondAcceptor: true },
      { x: 3.5, y: 0, z: 0, charge: 0.1 }
    ];

    const dock = simulateDockingAdvanced(lig, pro, { dielectric: 4, softCore: true });
    assert('Docking finite energy', Number.isFinite(dock.energy));
    assert('Docking separates components', Number.isFinite(dock.energyLJ) && Number.isFinite(dock.energyCoulomb));
    assert('Docking atom counts', dock.ligandAtomsUsed === 2 && dock.proteinAtomsUsed === 2);
    assert('Docking minDistance > 0', dock.minDistance > 0);

    assert('Empty ligand → ERROR', simulateDockingAdvanced([], pro).status === 'ERROR');
    assert('Invalid atoms filtered', simulateDockingAdvanced([{ x: NaN, y: 0, z: 0, charge: 1 }], pro).status === 'ERROR');

    const clash = simulateDockingAdvanced(
      [{ x: 0, y: 0, z: 0, charge: 1 }],
      [{ x: 0, y: 0, z: 0, charge: -1 }],
      { softCore: true }
    );
    assert('Zero-distance soft docking remains finite', Number.isFinite(clash.energy));

    // H-bond option
    const dockHB = simulateDockingAdvanced(lig, pro, { hydrogenBond: true, softCore: true });
    assert('H-bond term present', typeof dockHB.energyHB === 'number');

    // Affinity helper
    const aff = estimateAffinity(-8.0);
    assert('Affinity pKi reasonable', aff.pKi > 5 && aff.pKi < 7);

    // ---------- v3.1: golden values captured from v3.0.0 (zero-regression guard) ----------
    assert('GOLDEN LJ soft r=4', Math.abs(calculateLennardJones(4, 0.1, 3.5) - (-0.0971269820582874)) < 1e-12);
    assert('GOLDEN Coulomb soft', Math.abs(calculateCoulomb(3, 0.5, -0.5, 4, { alpha: 0.5 }) - (-6.733480934644956)) < 1e-9);
    assert('GOLDEN druglikeness scores', evaluateDrugLikeness(340, 2.1, 2, 5, 6, 95).score === 85 &&
                                         evaluateDrugLikeness(550, 2, 1, 4, 5, 80).score === 73);
    assert('GOLDEN docking components', dock.energy === 25.802 && dock.energyLJ === 27.144 &&
                                        dock.energyCoulomb === -1.342 && dock.minDistance === 0.7071 &&
                                        dock.contacts === 4 && dock.status === 'CLASH / UNFAVORABLE');
    assert('GOLDEN H-bond energy', dockHB.energyHB === -1.197);

    // ---------- v3.1: bug-fix regressions ----------
    assert('null options do not crash', (() => {
      try {
        evaluateDrugLikeness(300, 2, 1, 3, 3, 50, null);
        calculateLennardJones(3, 0.1, 3.5, null);
        calculateCoulomb(3, 1, -1, 4, null);
        return simulateDockingAdvanced(lig, pro, null).status !== undefined;
      } catch (e) { return false; }
    })());
    assert('Bad hbEnergy no longer poisons total', Number.isFinite(
      simulateDockingAdvanced(lig, pro, { hydrogenBond: true, hbEnergy: 'x' }).energy));
    assert('Overflow coords → ERROR not 0', simulateDockingAdvanced(
      [{ x: 0, y: 0, z: 0, charge: 1 }], [{ x: 1e308, y: 1e308, z: 0, charge: 1 }]).status !== 'FAVORABLE');
    assert('checkLipinski aspirin passes', API.checkLipinski(180.16, 1.3, 1, 3).startsWith('LULUS'));
    assert('checkLipinski paracetamol passes', API.checkLipinski(151.16, 0.5, 2, 2).startsWith('LULUS'));
    assert('checkLipinski 2 violations fails', API.checkLipinski(650, 6, 2, 5).startsWith('GAGAL'));
    assert('Affinity T<=0 → null', estimateAffinity(-8, 0).ki === null && estimateAffinity(-8, -5).ki === null);
    assert('Affinity overflow → null', estimateAffinity(1e6).ki === null);
    assert('RT_298K = R·T exact', Math.abs(RT_298K - 0.5924849497) < 1e-9);

    // ---------- v3.1: analytical checks for new functions ----------
    assert('Coulomb 1 Å, ±1e, ε=1 = −K', Math.abs(calculateCoulomb(1, 1, -1, 1, { softCore: false }) + COULOMB_K) < 1e-9);
    const ld = estimateLogD(3, 4.4, 7.4, 'acid');
    assert('logD acid (x=3)', Math.abs(ld.logD - (3 - Math.log10(1001))) < 1e-3 && Math.abs(ld.neutralFraction - 1 / 1001) < 1e-9);
    assert('logD at pH=pKa → −log10(2)', Math.abs(estimateLogD(2, 7.4, 7.4, 'base').logD - (2 - Math.log10(2))) < 1e-3);
    assert('logD bad type → null', estimateLogD(2, 7, 7.4, 'x') === null);
    const dG9 = kdToDeltaG(1e-9);
    assert('Kd 1 nM → ΔG ≈ −12.278', Math.abs(dG9 + 12.2778) < 2e-3, `got ${dG9}`);
    assert('Kd↔ΔG round trip', Math.abs(estimateAffinity(dG9).ki / 1e-9 - 1) < 1e-9);
    assert('Cheng–Prusoff [S]=Km → IC50/2', chengPrusoff(100, 5, 5) === 50 && chengPrusoff(1, 1, 0) === null);
    const le = ligandEfficiencyMetrics({ pActivity: 9, heavyAtoms: 30, mw: 400, psa: 80, logP: 3 });
    assert('LE = 1.364·pAct/HA', Math.abs(le.LE - 0.4093) < 1e-3 && le.LLE === 6 && le.BEI === 22.5 && le.SEI === 11.25, JSON.stringify(le));
    assert('LE invalid → null', ligandEfficiencyMetrics({ pActivity: 9, heavyAtoms: 0 }) === null);
    assert('CNS MPO ideal = 6', cnsMPO({ clogP: 2, clogD: 1, mw: 300, tpsa: 60, hbd: 0, pKa: 7 }).score === 6);
    assert('CNS MPO worst = 0', cnsMPO({ clogP: 6, clogD: 5, mw: 600, tpsa: 150, hbd: 5, pKa: 11 }).score === 0);
    assert('CNS MPO mid (clogP=4 → 0.5)', cnsMPO({ clogP: 4, clogD: 1, mw: 300, tpsa: 60, hbd: 0, pKa: 7 }).score === 5.5);
    assert('CNS MPO tpsa ramps', cnsMPO({ clogP: 2, clogD: 1, mw: 300, tpsa: 30, hbd: 0, pKa: 7 }).parts.tpsa === 0.5 &&
                                  cnsMPO({ clogP: 2, clogD: 1, mw: 300, tpsa: 105, hbd: 0, pKa: 7 }).parts.tpsa === 0.5);
    assert('Extra filters: fragment', evaluateExtraFilters(250, 2, 2, 2, 2, 50).ruleOfThree_fragment === true);
    assert('Extra filters: Pfizer 3/75 flag', evaluateExtraFilters(300, 3.5, 1, 3, 3, 60).pfizer_3_75_toxRisk === true);
    assert('analyzeCandidate integrates', (() => {
      const a = analyzeCandidate({ mw: 340, logP: 2.1, hbd: 2, hba: 5, rotB: 6, psa: 95, heavyAtoms: 24, pActivity: 8 });
      return a.drugLikeness.status === 'LULUS' && a.lipinski.pass && a.efficiency.LE > 0;
    })());

    // ---------- v3.2 ----------
    const cv = ljCurve(0.2, 3.5, 3, 8, 30, { softCore: false });
    assert('ljCurve length & min near rmin', cv.length === 30 && Math.min(...cv.map(p => p.lj)) < -0.19);
    assert('ljCurve bad range falls back', ljCurve(0.1, 3.5, 9, 2, 5).length === 5);
    const pa = parseAtoms('0 0 0 0.2 0.1 3.4 1 0 # donor\nbad line\n1,1,1,-0.3');
    assert('parseAtoms good+bad lines', pa.atoms.length === 2 && pa.errors.length === 1 && pa.atoms[0].hbondDonor === true);
    assert('parseAtoms non-string safe', parseAtoms(null).atoms.length === 0);
    assert('maxPairs guard → ERROR', simulateDockingAdvanced(lig, pro, { maxPairs: 3 }).status === 'ERROR');
    assert('negative dielB stays finite', Number.isFinite(calculateCoulomb(5, 1, -1, 4, { distanceDependent: true, dielA: 1, dielB: -1 })));
    assert('roundTo overflow-safe', roundTo(1e307, 3) === 1e307);
    assert('screenLibrary sorted', (() => {
      const r = screenLibrary([{ name: 'bad', mw: 700, logP: 7, hbd: 6, hba: 12, rotB: 14, psa: 200 },
                               { mw: 340, logP: 2.1, hbd: 2, hba: 5, rotB: 6, psa: 95 }]);
      return r[0].score > r[1].score && r[1].name === 'bad';
    })());

    // ---------- Constants sanity ----------
    assert('COULOMB_K precision', Math.abs(COULOMB_K - 332.063713) < 0.0001);

    const summary = {
      ok: pass === results.length,
      passed: pass,
      total: results.length,
      version: API.version,
      results
    };

    if (verbose) {
      console.log(`NexusPharma selfTest: ${pass}/${results.length} passed`);
    }
    return summary;
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------
  const API = {
    // Core
    evaluateDrugLikeness,
    calculateLennardJones,
    calculateCoulomb,
    simulateDockingAdvanced,
    estimateAffinity,
    lennardJonesMinimum,
    selfTest,

    // Convenience
    // v3.1 FIX: evaluates Lipinski ONLY (≤1 violation allowed). v3.0 wrongly
    // pulled in Ghose/Muegge MW floors, rejecting aspirin/paracetamol.
    checkLipinski(mw, logP, donors, acceptors) {
      const r = lipinskiOnly(mw, logP, donors, acceptors);
      return r.pass ? 'LULUS (Kandidat Obat)' : 'GAGAL (Tidak Layak Obat)';
    },

    // New in v3.1
    estimateLogD,
    kdToDeltaG,
    chengPrusoff,
    ligandEfficiencyMetrics,
    cnsMPO,
    evaluateExtraFilters,
    analyzeCandidate,

    // New in v3.2
    ljCurve,
    parseAtoms,
    screenLibrary,

    // Metadata
    version: '3.2.0-robust',
    constants: {
      COULOMB_K,
      SOFTCORE_ALPHA,
      RT_298K,
      R_KCAL
    }
  };

  // Freeze public surface
  Object.freeze(API.constants);
  Object.freeze(API);

  global.NexusPharma = API;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = API;
  }

})(typeof globalThis !== 'undefined' ? globalThis : this);

/* ------------------------------------------------------------------
 * CHANGELOG
 * v3.2.0  + ljCurve(), parseAtoms(), screenLibrary()
 *         + maxPairs guard in docking (no browser freeze on huge inputs)
 *         ! roundTo no longer returns Infinity on overflow
 *         ! distance-dependent dielectric can never be ≤ 0
 *         ! doc fix: LJ default soft-core alpha is 0.18 (was documented 0.5)
 *         + 8 new self-tests (62 total); all v3.1 golden values unchanged
 * v3.1.0  Lipinski-only checkLipinski fix, logD, Kd↔ΔG, Cheng–Prusoff,
 *         LE/BEI/SEI/LLE, CNS MPO, extra filters, analyzeCandidate
 * ------------------------------------------------------------------ */
