/* CIKUR GO Internal AI Logic Layer
 * Deterministic decision logic between cognition/core, proof, guardian and execution.
 * No external AI/API. No source mutation. Automatic patch/execution remains capability-driven
 * and is allowed only when proof + policy + integrity gates all pass.
 */
import * as Core from "./cgo-ai-core.js?v=20260907-1315-instruction1";
import * as Guardian from "./cgo-ai-guardian.js?v=20260907-1315-instruction1";
import * as Cognition from "./cgo-ai-cognition.js?v=20260907-1315-instruction1";
import * as Instruction from "./cgo-instruction.js";

const VERSION_OTAK = "1.2.0-VOCAB-PARSE";
const VERSION="1.6.0-VOCAB-PARSE";

function clone(v){ return structuredClone(v); }
function verifiedEvidence(caseData){ return (caseData?.evidence||[]).filter(e=>e?.status==="VERIFIED"); }
function contradictions(caseData){ return Core.detectContradictions(caseData?.evidence||[]); }

export function evaluate(caseData, policy={}, knowledge=null){
  const c=clone(caseData||{});
  const verified=verifiedEvidence(c);
  const contradictory=contradictions(c);
  const unresolved=(c.evidence||[]).some(e=>e?.status!=="VERIFIED" && e?.metadata?.proofRequired!==false);
  const rootIds=Array.isArray(c.rootCause?.evidenceIds)?c.rootCause.evidenceIds:[];
  const rootEvidenceBound=!!c.rootCause && rootIds.length>0 && new Set(rootIds).size===rootIds.length && rootIds.every(id=>verified.some(e=>e.id===id));
  const rootHypothesis = c.hypotheses?.find(h=>h?.id===c.rootCause?.hypothesisId);
  const rootHypothesisEvidence = Array.isArray(rootHypothesis?.evidenceIds) ? rootHypothesis.evidenceIds : [];
  const independentRootSupport = new Set(rootIds.map(id=>{const e=verified.find(x=>x.id===id); return e?.source || e?.metadata?.file || e?.type || e?.id;})).size>=2 || rootIds.length>=2;
  const causalRootVerified = rootEvidenceBound && !!rootHypothesis && Number(rootHypothesis.score)>=0.60 &&
    Number(c.rootCause?.hypothesisScore)===Number(rootHypothesis.score) &&
    String(c.rootCause?.statement || "").trim()===String(rootHypothesis.statement || "").trim() &&
    rootHypothesisEvidence.length>0 && rootIds.every(id=>rootHypothesisEvidence.includes(id)) && independentRootSupport;
  const rootVerified=causalRootVerified && c.state!=="CONTRADICTORY_EVIDENCE";
  const sourceEvidenceBound=!!c.exactSource && Array.isArray(c.exactSource.evidenceIds) &&
    c.exactSource.evidenceIds.length>0 && c.exactSource.evidenceIds.every(id=>rootIds.includes(id));
  const sourceVerified=!!c.exactSource && sourceEvidenceBound;
  const fingerprintBound=sourceVerified && !!c.exactSource?.fingerprint &&
    c.exactSource.contentFingerprint===Core.contentFingerprint(c.exactSource.originalCode||"");
  const sourceFingerprintBound=sourceVerified && !!c.exactSource?.sourceFingerprint;
  const solutionReady=typeof c.exactSource?.proposedCode === "string" && c.exactSource.proposedCode.trim().length>0;
  const proof={
    evidenceCount:(c.evidence||[]).length,
    verifiedEvidenceCount:verified.length,
    unresolved,
    contradictory:contradictory.length>0,
    rootCauseVerified:rootVerified,
    causalRootVerified,
    rootEvidenceBound,
    sourceVerified,
    fingerprintBound,
    sourceFingerprintBound,
    sourceEvidenceBound,
    solutionReady,
    complete:rootVerified && sourceVerified && fingerprintBound && sourceFingerprintBound && sourceEvidenceBound && solutionReady && !unresolved && !contradictory.length
  };
  proof.blockers = [];
  if (!proof.rootCauseVerified) proof.blockers.push("ROOT_CAUSE_NOT_VERIFIED");
  if (!proof.sourceVerified) proof.blockers.push("EXACT_SOURCE_NOT_VERIFIED");
  if (!proof.fingerprintBound) proof.blockers.push("SOURCE_FINGERPRINT_REQUIRED");
  if (!proof.sourceEvidenceBound) proof.blockers.push("SOURCE_EVIDENCE_BINDING_REQUIRED");
  if (!proof.solutionReady) proof.blockers.push("CONCRETE_SOLUTION_NOT_READY");
  if (proof.unresolved) proof.blockers.push("UNVERIFIED_EVIDENCE_PRESENT");
  if (proof.contradictory) proof.blockers.push("CONTRADICTORY_EVIDENCE");
  const cognition=Cognition.deliberate({
    evidence:c.evidence||[], rootCause:c.rootCause, exactSource:c.exactSource,
    contradictions:contradictory, proofComplete:(rootVerified && sourceVerified && fingerprintBound && sourceFingerprintBound && sourceEvidenceBound && !unresolved && !contradictory.length)
  });
  const guardian=Guardian.authorizeAction({
    caseId:c.caseId,
    rootCauseVerified:rootVerified,
    causalRootVerified,
    rootEvidenceBound,
    sourceVerified,
    exactFingerprint:fingerprintBound ? c.exactSource.fingerprint : null,
    sourceFingerprint:c.exactSource?.sourceFingerprint||null,
    allowAutomaticExecution:policy.allowAutomaticExecution,
    contradictoryEvidence:proof.contradictory,
    unresolvedEvidence:proof.unresolved,
    severity:c.severity,
    target:c.target,
    proposedCode:c.exactSource?.proposedCode || null,
    knowledge,
    policy
  });
  const action = proof.complete ? guardian.decision : "BLOCKED";
  const reason = !proof.complete ? (solutionReady ? "PROOF_CHAIN_INCOMPLETE" : "CONCRETE_SOLUTION_NOT_READY") : guardian.reason;
  return clone({caseId:c.caseId, revision:c.revision||0, proof, cognition, guardian, decision:action, reason, constitutionVersion:Instruction.CONSTITUTION_VERSION});
}

export function decide(caseData, policy={}, knowledge=null){
  const evaluation=evaluate(caseData,policy,knowledge);
  if(evaluation.decision!=="AUTO_ALLOWED") return evaluation;
  if(!evaluation.proof.complete) return {...evaluation,decision:"BLOCKED",reason:"PROOF_CHAIN_INCOMPLETE"};
  return {...evaluation,decision:"AUTO_ALLOWED",reason:"AUTO_PATCH_EXECUTION_READY"};
}

export function reconcile(caseData, policy={}, previous=null, knowledge=null){
  const current=decide(caseData,policy,knowledge);
  if(!previous) return current;
  if(previous.caseId!==current.caseId) return current;
  if(Number(previous.revision||0)>Number(current.revision||0))
    return clone(previous);
  return current;
}

export function buildAction(caseData, authorization){
  const c=clone(caseData||{});
  const auth=clone(authorization||{});
  if(c.state!=="SOURCE_VERIFIED" || !c.rootCause || !c.exactSource)
    return {action:"INVESTIGATE",executable:false,reason:"PROOF_CHAIN_INCOMPLETE"};
  if(typeof c.exactSource.proposedCode!=="string" || !c.exactSource.proposedCode.trim())
    return {action:"INVESTIGATE",executable:false,reason:"CONCRETE_SOLUTION_NOT_READY"};
  if(auth.decision==="AUTO_ALLOWED") return {
    action:"AUTO_PATCH_AND_EXECUTE_INTENT", executable:true,
    authorizationId:auth.authorizationId||null, caseId:c.caseId,
    revision:c.revision||0, request:clone({
      file:c.exactSource.file,
      fingerprint:c.exactSource.fingerprint,
      sourceFingerprint:c.exactSource.sourceFingerprint||null,
      operation:c.exactSource.operation||"REPLACE_EXACT",
      originalCode:c.exactSource.originalCode,
      proposedCode:c.exactSource.proposedCode||null,
      evidenceIds:c.exactSource.evidenceIds||[]
    })
  };
  if(auth.decision==="HUMAN_APPROVAL_REQUIRED") return {
    action:"HUMAN_APPROVAL_PATCH_AND_EXECUTE", executable:false,
    authorizationId:auth.authorizationId||null, caseId:c.caseId,
    revision:c.revision||0
  };
  return {action:"BLOCKED",executable:false,reason:auth.reason||"POLICY_BLOCKED",caseId:c.caseId};
}

export { VERSION, Instruction };

try {
  if (typeof globalThis !== "undefined") {
    globalThis.CGOAiLogic = { VERSION: typeof VERSION !== "undefined" ? VERSION : "1.6.0-VOCAB-PARSE", parseCommandVocabulary, getVocabularyVersion, evaluate };
  }
} catch (_) {}


/* ============================================================
 * VOCABULARY / COMMAND UNDERSTANDING (local, additive)
 * Tidak mengganti evaluate() — hanya memperkaya pemahaman perintah bahasa.
 * Alur: normalisasi → wake → intent → target → action → ambiguitas
 * ============================================================ */
const VOCAB_VERSION = "1.0.0-LOCAL";

const WAKE_PATTERNS = [
  /^\s*c\s*\.?\s*g\s*\.?\s*o\b/i,
  /^\s*ce\s*ge\s*o\b/i,
  /^\s*si\s*ji\s*o\b/i,
  /^\s*si\s*ji\s*ou\b/i,
  /^\s*si\s*jio\b/i,
  /^\s*siji\s*o\b/i,
  /^\s*siji\s*ou\b/i,
  /^\s*sijiou\b/i,
  /^\s*sijiow\b/i
];

const INTENT_VOCAB = {
  GREETING: [/\b(hai|halo|hello|hei|selamat\s+pagi|selamat\s+siang|selamat\s+sore|selamat\s+malam)\b/i],
  HELP: [/\b(bantu|tolong\s+bantu|bisa\s+bantu|minta\s+bantuan|help|kamu\s+bisa\s+apa|apa\s+yang\s+bisa\s+kamu\s+lakukan)\b/i],
  INSPECT: [/\b(cek|periksa|check|lihat|tinjau|analisis|cek\s+kondisi|cek\s+status|status)\b/i],
  DATA_RETRIEVE: [/\b(tarik\s+data|ambil\s+data|ambilkan\s+data|minta\s+data|tampilkan\s+data|tampilkan\s+datanya|buka\s+data|lihat\s+data|cek\s+data|cari\s+data|ambil\s+informasi|tampilkan\s+informasi|berikan\s+data|berikan\s+informasi|unduh\s+(data|csv)|export\s+(data|csv))\b/i],
  REPAIR: [/\b(perbaiki|perbaiki\s+error|fix\b|fix\s+error|repair|benahi|betulkan|koreksi|upgrade|tingkatkan)\b/i],
  EXECUTE: [/\b(jalankan|execute|eksekusi|mulai|start|terapkan|apply|laksanakan)\b/i],
  STOP: [/\b(stop|berhenti|hentikan|batalkan|batal|cancel|jangan\s+lanjutkan|jangan\s+jalankan)\b/i],
  RETRY: [/\b(ulang|ulangi|coba\s+lagi|ulang\s+lagi|retry|jalankan\s+ulang|proses\s+ulang)\b/i],
  EXPLAIN: [/\b(jelaskan|jelaskan\s+ini|terangkan|apa\s+maksudnya|kenapa|mengapa|bagaimana|jelaskan\s+hasilnya|jelaskan\s+datanya)\b/i],
  SHOW: [/\b(tampilkan|perlihatkan|tunjukkan|lihatkan|show)\b/i],
  BRIEFING: [/\b(briefing|ringkasan\s+harian|laporan\s+harian|rekap\s+hari\s+ini)\b/i]
};

const TARGET_VOCAB = {
  CUSTOMER: [/\b(customer|pelanggan|pengguna|\buser\b)\b/i],
  MITRA: [/\b(mitra|partner|merchant)\b/i],
  DRIVER: [/\b(driver|pengemudi)\b/i],
  RESTO: [/\b(resto|restoran|restaurant)\b/i],
  TRANSAKSI: [/\b(transaksi|pesanan|order|orders|booking|pembayaran)\b/i],
  CHAT: [/\b(chat|percakapan|komunikasi|riwayat\s+chat)\b/i],
  FILE: [/\b(file|berkas|dokumen|source|kode|\bcode\b)\b/i],
  SYSTEM: [/\b(sistem|system|status\s+sistem|kondisi\s+sistem)\b/i]
};

const ACTION_MAP = {
  GREETING: "GREET",
  HELP: "HELP",
  INSPECT: "CHECK",
  DATA_RETRIEVE: "RETRIEVE",
  REPAIR: "REPAIR",
  EXECUTE: "EXECUTE",
  STOP: "STOP",
  RETRY: "RETRY",
  EXPLAIN: "EXPLAIN",
  SHOW: "SHOW",
  BRIEFING: "BRIEF"
};

function normalizeCommandText(input) {
  return String(input || "")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function detectWake(text) {
  const s = String(text || "");
  for (const re of WAKE_PATTERNS) {
    const m = s.match(re);
    if (m) {
      return {
        wake: true,
        wakeWord: String(m[0]).trim().toUpperCase().replace(/\s+/g, " "),
        rest: s.slice(m[0].length).replace(/^[\s,.:;!\-]+/, "").trim()
      };
    }
  }
  return { wake: false, wakeWord: null, rest: s.trim() };
}

function matchFirstLabel(text, table) {
  for (const [label, regs] of Object.entries(table)) {
    for (const re of regs) {
      if (re.test(text)) return label;
    }
  }
  return null;
}

/**
 * Parse perintah bahasa alami → struktur pemahaman (tanpa eksekusi).
 * @returns {{wake,wakeWord,intent,target,action,confidence,requiresTarget,rest,vocabVersion}}
 */
export function parseCommandVocabulary(input) {
  const raw = normalizeCommandText(input);
  const w = detectWake(raw);
  const body = w.rest || (!w.wake ? raw : "");
  let intent = matchFirstLabel(body, INTENT_VOCAB);
  // Jika hanya wake tanpa body
  if (w.wake && !body) {
    return {
      wake: true,
      wakeWord: w.wakeWord,
      intent: "WAKE",
      target: "NONE",
      action: "ACTIVATE",
      confidence: "HIGH",
      requiresTarget: false,
      rest: "",
      vocabVersion: VOCAB_VERSION
    };
  }
  // Prioritas DATA_RETRIEVE jika frasa tarik/ambil data jelas
  if (/\b(tarik|ambil|unduh|export)\b/i.test(body) && /\b(data|csv|informasi)\b/i.test(body)) {
    intent = "DATA_RETRIEVE";
  }
  if (/\b(briefing|ringkasan\s+harian)\b/i.test(body)) intent = "BRIEFING";
  if (!intent && /\b(status\s+sistem|kondisi\s+sistem)\b/i.test(body)) intent = "INSPECT";

  let target = matchFirstLabel(body, TARGET_VOCAB);
  if (!target && intent === "INSPECT" && /\b(sistem|system)\b/i.test(body)) target = "SYSTEM";
  if (!target && intent === "REPAIR") target = "CURRENT_CONTEXT";

  const requiresTarget = (intent === "DATA_RETRIEVE" || intent === "SHOW") && (!target || target === "UNSPECIFIED");
  if ((intent === "DATA_RETRIEVE" || intent === "SHOW") && !target) target = "UNSPECIFIED";

  let confidence = "LOW";
  if (intent && target && target !== "UNSPECIFIED") confidence = "HIGH";
  else if (intent && !requiresTarget) confidence = "MEDIUM";
  else if (intent && requiresTarget) confidence = "MEDIUM";
  else if (w.wake) confidence = "MEDIUM";

  const action = intent ? (ACTION_MAP[intent] || "UNKNOWN") : "UNKNOWN";

  return {
    wake: w.wake,
    wakeWord: w.wakeWord,
    intent: intent || "UNKNOWN",
    target: target || "NONE",
    action,
    confidence,
    requiresTarget: !!requiresTarget,
    rest: body,
    vocabVersion: VOCAB_VERSION,
    raw
  };
}

export function getVocabularyVersion() {
  return { VERSION: VOCAB_VERSION, logicVersion: VERSION, otakTag: VERSION_OTAK };
}

