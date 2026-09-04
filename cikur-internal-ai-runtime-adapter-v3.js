/**
 * CIKUR GO INTERNAL AI — RUNTIME ADAPTER V3
 * Connects live BCGO_STATE to the internal reasoning and knowledge layers.
 * No external AI/API. No source mutation. No execution.
 */

"use strict";

import { reason, VERSION as REASONING_VERSION } from "./cikur-internal-ai-core-v3.js";
import { createKnowledgeSnapshot, VERSION as KNOWLEDGE_VERSION } from "./cikur-internal-ai-knowledge-v2.js";

export const VERSION = "3.0.0-runtime-reasoning";
export const INTERNAL_AI_EVENTS = Object.freeze({
  STATE: "cikur-internal-ai-state",
  CASE: "cikur-internal-ai-case",
  THOUGHT: "cikur-internal-ai-thought",
  REASONING: "cikur-internal-ai-reasoning",
  READY: "cikur-internal-ai-ready"
});

const clone = value => {
  try { return JSON.parse(JSON.stringify(value)); }
  catch { return value; }
};

const emit = (name, detail) => {
  try { window.dispatchEvent(new CustomEvent(name, { detail: clone(detail) })); } catch {}
};

function normalize(state) {
  return {
    source: "BCGO_STATE",
    capturedAt: Date.now(),
    cycle: Number(state?.cycle || 0),
    step: state?.step || "UNKNOWN",
    cycleMode: state?.cycleMode || "UNKNOWN",
    targetCell: state?.targetCell || null,
    message: String(state?.message || ""),
    errorLog: clone(state?.errorLog || null),
    metrics: clone(state?.metrics || {}),
    firestore: clone(state?.firestore || {}),
    connection: clone(state?.connection || {}),
    activeCases: clone(Array.isArray(state?.activeCases) ? state.activeCases : []),
    recentEvents: clone(Array.isArray(state?.recentEvents) ? state.recentEvents.slice(0,24) : []),
    latestLogs: clone(Array.isArray(state?.systemLogs) ? state.systemLogs.slice(0,50) : []),
    sourceScan: clone(state?.sourceScan || {}),
    medicineBridge: clone(state?.medicineBridge || {}),
    executionBridge: clone(state?.executionBridge || {})
  };
}

function signal(t, r) {
  if (t.firestore?.error || t.connection?.status === "OFFLINE") return "INFRASTRUCTURE_ERROR";
  if (r.precisionGate?.blockers?.includes("CONTRADICTORY_EVIDENCE")) return "CONTRADICTORY";
  if (r.hypotheses?.length) return "REASONING_ACTIVE";
  if (r.evidence?.length) return "EVIDENCE_ACTIVE";
  return "STABLE";
}

function thoughtText(t, r) {
  if (r.precisionGate?.blockers?.includes("CONTRADICTORY_EVIDENCE"))
    return "Saya menemukan evidence yang saling bertentangan. Saya menahan kesimpulan dan meminta verifikasi tambahan.";
  if (r.hypotheses?.length) {
    const h = r.hypotheses[0];
    return `Saya membentuk ${r.hypotheses.length} hipotesis. Hipotesis terkuat saat ini: ${h.claim} Confidence internal ${Math.round(h.confidence * 100)}%. Belum saya nyatakan sebagai root cause.`;
  }
  if (r.evidence?.length)
    return `Saya sudah mengumpulkan ${r.evidence.length} evidence. Bukti belum cukup untuk menetapkan akar masalah.`;
  return "Saya belum memiliki evidence yang cukup. Saya tetap mendengarkan BCGO_STATE.";
}

function answer(question, latest) {
  const q = String(question || "").trim().toLowerCase();
  if (!latest) return "Internal Intelligence belum menerima BCGO_STATE. Saya menunggu impuls pertama.";

  const t = latest.telemetry;
  const r = latest.reasoning;
  const h = r.hypotheses?.[0];
  const evidenceCount = r.evidence?.length || 0;

  if (/halo|hai|hello|siapa kamu/.test(q))
    return `Saya CIKUR GO Internal Intelligence. Saya membaca telemetry BCGO, menyusun evidence, membentuk hipotesis, dan menentukan apa yang masih harus dibuktikan. Saya tidak menggantikan Medicine atau Executor. Saat ini cycle #${t.cycle}, tahap ${t.step}.`;

  if (/sedang apa|lagi apa|mengerjakan/.test(q))
    return `${thoughtText(t, r)} Tahap BCGO sekarang ${t.step}, cycle #${t.cycle}.`;

  if (/hipotesis|dugaan|menurut kamu penyebab|kemungkinan/.test(q))
    return h
      ? `Hipotesis terkuat saya: ${h.claim} Confidence internal ${Math.round(h.confidence * 100)}%. Evidence pendukung: ${h.supportingEvidenceIds?.length || 0}. Status masih UNVERIFIED.`
      : "Belum ada hipotesis yang cukup spesifik. Saya tidak akan membuat dugaan tanpa evidence.";

  if (/bukti|evidence|dasar/.test(q))
    return `Saya memegang ${evidenceCount} evidence. Precision Gate masih ${r.precisionGate?.pass ? "LULUS" : "TERTUTUP"}. Blocker: ${(r.precisionGate?.blockers || []).join(", ") || "tidak ada"}.`;

  if (/akar|root cause|penyebab sebenarnya/.test(q))
    return h
      ? `Saya belum menyebut root cause sebagai fakta. Hipotesis terkuat adalah: ${h.claim} Namun Medicine tetap harus memverifikasi root cause dan exact source.`
      : "Belum ada dasar yang cukup untuk root cause.";

  if (/investigasi|selanjutnya|apa yang harus dilakukan|next/.test(q))
    return `Langkah investigasi saya: ${r.investigation?.nextEvidence || "kumpulkan evidence langsung"} Required: ${(r.investigation?.required || []).join(", ")}.`;

  if (/medicine/.test(q))
    return "Saya menyiapkan konteks dan hipotesis untuk Medicine. Medicine tetap organ yang memastikan root cause dan exact source sebelum solusi.";

  if (/executor|eksekusi|jalankan|patch/.test(q))
    return "Saya tidak melakukan patch atau eksekusi. Setelah Medicine memverifikasi solusi, Executor dan human approval tetap menjadi gerbang.";

  if (/status|kondisi|sehat|aman/.test(q))
    return `Intelligence ${latest.signal}. Classification ${r.classification}. Evidence ${evidenceCount}, hypotheses ${r.hypotheses?.length || 0}. Precision Gate ${r.precisionGate?.pass ? "PASS" : "BLOCKED"}.`;

  return `Saya menerima pertanyaan itu. Dari evidence live saat ini: ${evidenceCount} evidence dan ${r.hypotheses?.length || 0} hipotesis. ${thoughtText(t, r)}`;
}

export function install() {
  if (typeof window === "undefined") throw new Error("RUNTIME_ADAPTER_BROWSER_ONLY");
  if (window.CIKURInternalAIRuntime?.version === VERSION) return window.CIKURInternalAIRuntime;

  let latest = null;
  let lastReasoningKey = "";

  function ingestBCGOState(state) {
    const telemetry = normalize(state);
    const reasoning = reason(telemetry);
    const knowledge = createKnowledgeSnapshot(telemetry);
    const signalValue = signal(telemetry, reasoning);

    latest = {
      version: VERSION,
      reasoningVersion: REASONING_VERSION,
      knowledgeVersion: KNOWLEDGE_VERSION,
      type: "CIKUR_INTERNAL_AI_SNAPSHOT",
      at: Date.now(),
      signal: signalValue,
      telemetry,
      reasoning,
      knowledge,
      policy: {
        inference: "EVIDENCE_FIRST_CONSTRAINED",
        sourceRequired: true,
        unresolvedEvidenceBlocksCandidate: true,
        automaticPatch: false,
        automaticExecution: false,
        humanApprovalRequired: true
      }
    };

    emit(INTERNAL_AI_EVENTS.STATE, latest);

    for (const c of telemetry.activeCases.slice(0, 10)) {
      emit(INTERNAL_AI_EVENTS.CASE, {
        version: VERSION, at: Date.now(), case: clone(c), source: "BCGO_STATE"
      });
    }

    const top = reasoning.hypotheses?.[0];
    const key = [
      telemetry.cycle,
      telemetry.step,
      reasoning.classification,
      reasoning.evidence.length,
      top?.id || "",
      top?.claim || "",
      reasoning.precisionGate?.blockers?.join("|") || ""
    ].join("::");

    if (key !== lastReasoningKey) {
      lastReasoningKey = key;
      emit(INTERNAL_AI_EVENTS.REASONING, {
        version: VERSION,
        at: Date.now(),
        signal: signalValue,
        cycle: telemetry.cycle,
        step: telemetry.step,
        classification: reasoning.classification,
        evidenceCount: reasoning.evidence.length,
        hypotheses: clone(reasoning.hypotheses),
        precisionGate: clone(reasoning.precisionGate),
        investigation: clone(reasoning.investigation)
      });
      emit(INTERNAL_AI_EVENTS.THOUGHT, {
        version: VERSION,
        at: Date.now(),
        signal: signalValue,
        cycle: telemetry.cycle,
        step: telemetry.step,
        text: thoughtText(telemetry, reasoning)
      });
    }

    return clone(latest);
  }

  const api = Object.freeze({
    version: VERSION,
    events: INTERNAL_AI_EVENTS,
    ingestBCGOState,
    getSnapshot: () => clone(latest),
    getReasoning: () => clone(latest?.reasoning || null),
    getKnowledge: () => clone(latest?.knowledge || null),
    getPosture: () => latest ? thoughtText(latest.telemetry, latest.reasoning) : "Menunggu BCGO_STATE.",
    ask: question => answer(question, latest),
    reset: () => { latest = null; lastReasoningKey = ""; }
  });

  window.CIKURInternalAIRuntime = api;
  emit(INTERNAL_AI_EVENTS.READY, {
    version: VERSION,
    reasoningVersion: REASONING_VERSION,
    knowledgeVersion: KNOWLEDGE_VERSION,
    at: Date.now()
  });
  return api;
}

if (typeof globalThis !== "undefined") {
  globalThis.CIKURInternalAIRuntimeAdapter = { VERSION, INTERNAL_AI_EVENTS, install };
}
