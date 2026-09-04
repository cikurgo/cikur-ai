/**
 * CIKUR GO INTERNAL AI — REASONING CORE V3
 * Purpose: internal, deterministic, evidence-first reasoning.
 * No external AI/API. No source mutation. No code execution.
 *
 * This is an intelligence engine, not Medicine and not Executor.
 * It can form/test hypotheses and produce an investigation plan,
 * but it cannot declare an unverified root cause as fact.
 */

"use strict";

export const VERSION = "3.0.0-reasoning";

export const STATES = Object.freeze([
  "DETECTED","OBSERVING","EVIDENCE_COLLECTING","INVESTIGATING",
  "HYPOTHESIS_FORMED","VERIFYING","ROOT_CAUSE_VERIFIED",
  "SOURCE_VERIFIED","CANDIDATE_READY","EXECUTOR_REVIEW",
  "HUMAN_APPROVAL","EXECUTING","VALIDATING","RESOLVED",
  "INSUFFICIENT_EVIDENCE","CONTRADICTORY_EVIDENCE",
  "SOURCE_NOT_VERIFIED","VALIDATION_FAILED","REOPENED"
]);

const clone = value => {
  try { return JSON.parse(JSON.stringify(value)); }
  catch { return value; }
};

const text = value => String(value ?? "").trim();

const count = value => Number.isFinite(Number(value)) ? Number(value) : 0;

function evidence(id, source, claim, strength, details = {}) {
  return {
    id,
    source,
    claim,
    strength: Math.max(0, Math.min(1, strength)),
    details: clone(details)
  };
}

function normalizeFinding(finding, index) {
  if (!finding) return null;
  return {
    id: text(finding.id) || `finding_${index}`,
    file: text(finding.file || finding.target || finding.fileName),
    message: text(finding.message || finding.error || finding.detail),
    type: text(finding.type || finding.kind || "SOURCE_FINDING"),
    severity: text(finding.severity || "UNKNOWN"),
    raw: clone(finding)
  };
}

function collectEvidence(t = {}) {
  const list = [];
  const logs = Array.isArray(t.latestLogs) ? t.latestLogs : [];
  const events = Array.isArray(t.recentEvents) ? t.recentEvents : [];
  const active = Array.isArray(t.activeCases) ? t.activeCases : [];
  const findings = Array.isArray(t.sourceScan?.findings) ? t.sourceScan.findings : [];
  const cross = Array.isArray(t.sourceScan?.crossFileFindings) ? t.sourceScan.crossFileFindings : [];

  if (t.errorLog) {
    list.push(evidence(
      "runtime-error",
      "BCGO_STATE.errorLog",
      text(t.errorLog?.message || t.errorLog?.error || t.errorLog),
      0.9,
      { kind: "RUNTIME_ERROR" }
    ));
  }

  active.slice(0, 10).forEach((c, i) => {
    const ev = c?.evidence || {};
    const sf = ev.sourceFinding || {};
    const msg = text(ev.message || sf.message || c?.message);
    if (msg) list.push(evidence(
      `case-${c?.id || i}`,
      "BCGO_STATE.activeCases",
      msg,
      0.82,
      { caseId: c?.id || null, target: c?.target || null, severity: c?.severity || null }
    ));
  });

  logs.slice(0, 30).forEach((l, i) => {
    const msg = text(l?.message || l?.error || l?.text);
    if (msg) list.push(evidence(
      `log-${i}`,
      "BCGO_STATE.latestLogs",
      msg,
      0.7,
      { file: l?.fileName || l?.file || null, type: l?.type || null }
    ));
  });

  [...findings, ...cross].slice(0, 50).forEach((f, i) => {
    const n = normalizeFinding(f, i);
    if (!n?.message && !n?.file) return;
    list.push(evidence(
      `scan-${n.id}`,
      cross.includes(f) ? "BCGO_STATE.sourceScan.crossFileFindings" : "BCGO_STATE.sourceScan.findings",
      [n.file, n.message].filter(Boolean).join(": "),
      0.76,
      { file: n.file, type: n.type, severity: n.severity, crossFile: cross.includes(f) }
    ));
  });

  events.slice(0, 20).forEach((e, i) => {
    const msg = text(e?.message || e?.text);
    if (msg && /error|anomal|finding|failed|offline|medicine|execution/i.test(msg)) {
      list.push(evidence(
        `event-${i}`,
        "BCGO_STATE.recentEvents",
        msg,
        0.62,
        { type: e?.type || null, at: e?.at || null }
      ));
    }
  });

  return list;
}

function classify(t, evidenceList) {
  const firestoreError = Boolean(t.firestore?.error);
  const offline = t.connection?.status === "OFFLINE";
  const active = Array.isArray(t.activeCases) ? t.activeCases : [];
  const findings = count(t.sourceScan?.findings?.length) + count(t.sourceScan?.crossFileFindings?.length);

  if (firestoreError || offline) return "INFRASTRUCTURE";
  if (active.length) return "ACTIVE_CASE";
  if (findings) return "SOURCE_REVIEW";
  if (evidenceList.length) return "OBSERVED_SIGNAL";
  return "STABLE";
}

function buildHypotheses(t, evidenceList) {
  const hypotheses = [];
  const seen = new Set();
  const add = (kind, claim, confidence, supporting, next) => {
    const key = `${kind}|${claim}`;
    if (seen.has(key)) return;
    seen.add(key);
    hypotheses.push({
      id: `hyp_${kind.toLowerCase()}_${hypotheses.length + 1}`,
      kind,
      claim,
      confidence: Math.round(Math.max(0, Math.min(1, confidence)) * 100) / 100,
      status: "UNVERIFIED",
      supportingEvidenceIds: supporting,
      contradictingEvidenceIds: [],
      rootCauseVerified: false,
      exactSourceVerified: false,
      nextEvidence: next
    });
  };

  const errorText = evidenceList.map(e => e.claim).join(" | ");
  const active = Array.isArray(t.activeCases) ? t.activeCases : [];
  const findings = [
    ...(Array.isArray(t.sourceScan?.findings) ? t.sourceScan.findings : []),
    ...(Array.isArray(t.sourceScan?.crossFileFindings) ? t.sourceScan.crossFileFindings : [])
  ];

  const undefinedMatch = errorText.match(/(?:ReferenceError|is not defined)\s*:?\s*([A-Za-z_$][\w$]*)/i);
  if (undefinedMatch) {
    const name = undefinedMatch[1];
    const ids = evidenceList.filter(e => new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(e.claim)).map(e => e.id);
    add(
      "UNDEFINED_SYMBOL",
      `Simbol "${name}" dipanggil tetapi tidak terbukti tersedia pada runtime saat telemetry direkam.`,
      0.78 + (ids.length > 1 ? 0.08 : 0),
      ids,
      `Verifikasi definisi "${name}", scope/import, dan file sumber pemanggil.`
    );
  }

  for (const f of findings.slice(0, 20)) {
    const n = normalizeFinding(f, hypotheses.length);
    if (!n?.message) continue;
    if (/belum memiliki penutup|missing|not found|undefined|error|anomal/i.test(n.message)) {
      const ids = evidenceList.filter(e => e.claim.includes(n.message) || (n.file && e.claim.includes(n.file))).map(e => e.id);
      add(
        "SOURCE_FINDING",
        `${n.file || "Sumber"} memiliki temuan yang perlu diverifikasi: ${n.message}`,
        0.72 + (ids.length > 1 ? 0.06 : 0),
        ids,
        `Baca sumber asli ${n.file || "yang terkait"} dan cocokkan dengan pemanggil/dependensinya.`
      );
    }
  }

  if (active.length) {
    active.slice(0, 5).forEach((c, i) => {
      const target = text(c?.target || c?.file || t.targetCell);
      const msg = text(c?.evidence?.message || c?.evidence?.sourceFinding?.message || c?.message);
      if (!target && !msg) return;
      const ids = evidenceList.filter(e => (target && e.claim.includes(target)) || (msg && e.claim.includes(msg))).map(e => e.id);
      add(
        "ACTIVE_CASE_CORRELATION",
        `Kasus aktif terpusat pada ${target || "target yang belum bernama"}${msg ? `: ${msg}` : "."}`,
        0.74 + (ids.length > 1 ? 0.07 : 0),
        ids,
        `Kumpulkan exact source dan dependency context untuk ${target || "kasus aktif"}.`
      );
    });
  }

  if (!hypotheses.length && evidenceList.length) {
    add(
      "UNRESOLVED_SIGNAL",
      "Telemetry menunjukkan sinyal yang perlu diperiksa, tetapi pola penyebab belum cukup spesifik.",
      0.45,
      evidenceList.slice(0, 5).map(e => e.id),
      "Tambahkan evidence langsung dari source, runtime context, atau dependency terkait."
    );
  }

  return hypotheses.sort((a, b) => b.confidence - a.confidence).slice(0, 8);
}

function assess(t) {
  const ev = collectEvidence(t);
  const classification = classify(t, ev);
  const hypotheses = buildHypotheses(t, ev);
  const strongest = hypotheses[0] || null;

  const contradictions = ev.filter(e => /contradict|conflict|mismatch/i.test(e.claim));
  const directSource = ev.filter(e => /sourceScan|source/i.test(e.source));
  const confirmedLike = ev.filter(e => e.strength >= 0.75);

  const blockers = [];
  if (!ev.length && classification !== "STABLE") blockers.push("EVIDENCE_MISSING");
  if (contradictions.length) blockers.push("CONTRADICTORY_EVIDENCE");
  if (!strongest) blockers.push("HYPOTHESIS_MISSING");
  if (strongest && strongest.confidence < 0.75) blockers.push("HYPOTHESIS_CONFIDENCE_LOW");
  if (!directSource.length && classification !== "STABLE") blockers.push("DIRECT_SOURCE_EVIDENCE_MISSING");
  blockers.push("ROOT_CAUSE_REQUIRES_MEDICINE_VERIFICATION");
  blockers.push("EXACT_SOURCE_REQUIRES_VERIFICATION");

  const gate = {
    pass: false,
    blockers,
    confirmedEvidence: confirmedLike.length,
    contradictionCount: contradictions.length,
    evaluatedAt: new Date().toISOString()
  };

  return {
    classification,
    evidence: ev,
    hypotheses,
    selectedHypothesisId: strongest?.id || null,
    gate,
    investigation: strongest ? {
      objective: "Memastikan hipotesis dengan evidence langsung sebelum menyimpulkan root cause.",
      nextEvidence: strongest.nextEvidence,
      required: [
        "exact source",
        "dependency/caller context",
        "runtime context",
        "cross-file consistency"
      ]
    } : {
      objective: "Mencari evidence pertama yang dapat diverifikasi.",
      nextEvidence: "Kumpulkan telemetry dan source evidence yang lebih spesifik."
    }
  };
}

export function reason(telemetry = {}) {
  const t = clone(telemetry || {});
  const assessment = assess(t);
  return {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    target: t.targetCell || null,
    cycle: count(t.cycle),
    step: t.step || "UNKNOWN",
    classification: assessment.classification,
    evidence: assessment.evidence,
    hypotheses: assessment.hypotheses,
    selectedHypothesisId: assessment.selectedHypothesisId,
    precisionGate: assessment.gate,
    investigation: assessment.investigation,
    policy: {
      evidenceFirst: true,
      rootCauseMustBeVerified: true,
      exactSourceMustBeVerified: true,
      automaticPatch: false,
      automaticExecution: false,
      humanApprovalRequired: true
    }
  };
}

if (typeof globalThis !== "undefined") {
  globalThis.CIKURInternalAIReasoningCore = { VERSION, STATES, reason };
}
