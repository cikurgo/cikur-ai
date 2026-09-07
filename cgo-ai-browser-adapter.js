/* CIKUR GO Internal AI — Browser Synchronization Bridge
 * Binds the V5.2 active-investigation brain to the existing BCGO / Medicine contracts.
 * No external AI/API. No source mutation. Medicine remains proof authority.
 */
import * as Core from "./cgo-ai-core.js?v=20260907-0900-constitution-connectivity1";
import * as Knowledge from "./cgo-ai-knowledge.js?v=20260907-0900-constitution-connectivity1";
import * as Investigator from "./cgo-ai-investigator.js?v=20260907-0900-constitution-connectivity1";
import * as ActiveInvestigation from "./cgo-ai-investigation-engine.js?v=20260907-0900-constitution-connectivity1";
import * as Cognition from "./cgo-ai-cognition.js?v=20260907-0900-constitution-connectivity1";
import * as Instruction from "./cgo-instruction.js";
import * as Logic from "./cgo-ai-logic.js?v=20260907-0900-constitution-connectivity1";
import * as Memory from "./cgo-ai-memory.js?v=20260907-0900-constitution-connectivity1";
import { createRuntime } from "./cgo-ai-runtime-adapter.js?v=20260907-0900-constitution-connectivity1";

const VERSION = "V5.5-BROWSER-BRIDGE-3.4.0-INSTRUCTION-CONSTITUTION";
const INTERNAL_AUTO_POLICY = Object.freeze({
  version:"CIKUR-INTERNAL-AUTO-1",
  allowAutomaticExecution:true,
  automaticPatch:true,
  automaticExecution:true,
  executionMode:"INTERNAL_AUTO"
});

const runtime = createRuntime({});
const memory = Memory.createMemory();
const caseIds = new Map();
const evidenceTokens = new Map();
const activeEngines = new Map();
const activeRuns = new Map();
let knowledge = Knowledge.createKnowledgeStore();
let latest = null;
let latestBCGOState = null;
let lastChatCaseId = null;
let chatWorkSequence = 0;
const chatCaseIds = new Map();
const pendingRepairIntents = new Map();
let lastChatContext = { files: [], comparison: false, question: null, stateRevision: null };
let chatTranscript = [];
let chatSession = {
  turn: 0, lastUserText: null, primaryFile: null, files: [], comparison: false,
  caseId: null, intent: null, pendingCommand: null, lastCaseRevision: null, updatedAt: 0,
  pendingWork: null, clarificationNeeded: false, restoredCaseId: null, restoredAt: 0,
  dialogueMode: "IDLE", topic: null, tone: "WARM", address: null
};

// Conversation continuity is deliberately separate from operational proof.
// We may restore dialogue context after a refresh, but NEVER restore a runtime
// case, fingerprint, evidence, authorization, or validation result as trusted.
const CHAT_MEMORY_KEY = "CIKUR_GO_CGO_CHAT_MEMORY_V1";
const CHAT_MEMORY_VERSION = 1;
const CHAT_MEMORY_LIMIT = 40;
let chatRestoration = { restored:false, restoredAt:0, context:false, staleCaseDiscarded:false };

function safeStorage() {
  try { return window?.localStorage || null; } catch { return null; }
}

function readChatMemory() {
  const storage = safeStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(CHAT_MEMORY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== CHAT_MEMORY_VERSION) return null;
    return parsed;
  } catch { return null; }
}

function writeChatMemory() {
  const storage = safeStorage();
  if (!storage) return false;
  try {
    const payload = {
      version:CHAT_MEMORY_VERSION,
      savedAt:Date.now(),
      transcript:chatTranscript.slice(-CHAT_MEMORY_LIMIT).map(item => ({
        role:item?.role === 'user' ? 'user' : 'bcgo',
        text:String(item?.text || ''),
        at:Number(item?.at || Date.now()),
        caseId:null
      })),
      session:{
        turn:Number(chatSession.turn || 0),
        lastUserText:String(chatSession.lastUserText || ''),
        primaryFile:normalizeFile(chatSession.primaryFile),
        files:Array.isArray(chatSession.files) ? chatSession.files.slice(0,12).map(normalizeFile).filter(Boolean) : [],
        comparison:chatSession.comparison === true,
        intent:chatSession.intent || null,
        pendingCommand:chatSession.pendingCommand || null,
        pendingWork:chatSession.pendingWork ? clone(chatSession.pendingWork) : null,
        clarificationNeeded:chatSession.clarificationNeeded === true,
        dialogueMode:chatSession.dialogueMode || "IDLE",
        topic:chatSession.topic || null,
        tone:chatSession.tone || "WARM",
        address:chatSession.address || null,
        restoredCaseId:chatSession.caseId || chatSession.restoredCaseId || null
      },
      context:{
        files:Array.isArray(lastChatContext.files) ? lastChatContext.files.slice(0,12).map(normalizeFile).filter(Boolean) : [],
        comparison:lastChatContext.comparison === true,
        question:String(lastChatContext.question || ''),
        stateRevision:lastChatContext.stateRevision || null
      }
    };
    storage.setItem(CHAT_MEMORY_KEY, JSON.stringify(payload));
    return true;
  } catch { return false; }
}

function restoreChatMemory() {
  const saved = readChatMemory();
  if (!saved) return { restored:false, context:false, staleCaseDiscarded:false };
  const transcript = Array.isArray(saved.transcript) ? saved.transcript : [];
  chatTranscript = transcript.slice(-CHAT_MEMORY_LIMIT).filter(item => item && (item.role === 'user' || item.role === 'bcgo')).map(item => ({
    role:item.role, text:String(item.text || ''), at:Number(item.at || Date.now())
  }));
  const s = saved.session || {};
  const ctx = saved.context || {};
  const files = Array.isArray(s.files) ? s.files.map(normalizeFile).filter(Boolean) : [];
  lastChatContext = {
    files:Array.isArray(ctx.files) ? ctx.files.map(normalizeFile).filter(Boolean) : files,
    comparison:ctx.comparison === true || s.comparison === true,
    question:String(ctx.question || s.lastUserText || ''),
    stateRevision:ctx.stateRevision || null
  };
  // Runtime cases are process-local and therefore stale after a page reload.
  // Keep only a breadcrumb so the UI can explain what was restored.
  chatSession = {
    turn:Number(s.turn || chatTranscript.filter(x => x.role === 'user').length),
    lastUserText:String(s.lastUserText || lastChatUserText()),
    primaryFile:normalizeFile(s.primaryFile || files[0] || lastChatContext.files[0]),
    files, comparison:lastChatContext.comparison,
    caseId:null, intent:s.intent || null, pendingCommand:s.pendingCommand || null,
    lastCaseRevision:null, updatedAt:Date.now(), pendingWork:s.pendingWork ? clone(s.pendingWork) : null,
    clarificationNeeded:s.clarificationNeeded === true,
    restoredCaseId:s.restoredCaseId || null, restoredAt:Number(saved.savedAt || Date.now()),
    dialogueMode:s.dialogueMode || "IDLE", topic:s.topic || null, tone:s.tone || "WARM", address:s.address || null
  };
  chatRestoration = {
    restored:true, restoredAt:chatSession.restoredAt,
    context:!!(chatSession.primaryFile || chatSession.files.length || chatSession.pendingWork),
    staleCaseDiscarded:!!(s.restoredCaseId)
  };
  return clone(chatRestoration);
}

function setChatSession(patch = {}) {
  chatSession = { ...chatSession, ...patch, updatedAt: Date.now() };
  writeChatMemory();
  return chatSession;
}

function chatCaseFromSession() {
  // Conversation state is authoritative. lastChatCaseId is telemetry/diagnostic
  // bookkeeping only and must never resurrect an abandoned conversation case.
  const id = chatSession.caseId;
  return id ? runtime.getCase(id) : null;
}
function resolveChatReference(raw, state, explicitFiles = []) {
  const q = String(raw || '').toLowerCase();
  const c = chatCaseFromSession();
  // Human references such as "file itu" may resolve only against an explicit
  // conversation target. Telemetry's last file is observation context, not a
  // human target and must never silently become the target of a work command.
  const candidates = [...new Set([
    ...explicitFiles, normalizeFile(c?.exactSource?.file), chatSession.primaryFile, normalizeFile(c?.target),
    ...(Array.isArray(chatSession.files) ? chatSession.files : [])
  ].filter(Boolean))];
  const refersBack = /\b(yang tadi|bagian itu|file itu|yang barusan|sebelumnya|tadi|lanjut|lanjutkan|teruskan|hasilnya|progressnya|progresnya|kasus itu|case itu|bagian tersebut|yang itu|yang dimaksud)\b/i.test(q);
  return { candidates, refersBack, file: explicitFiles[0] || (refersBack ? candidates[0] : null) };
}

function isSystemStatusQuestion(raw) {
  return /\b(status sistem|kondisi sistem|sistem aman|aman tidak|aman nggak|aman enggak)\b/i.test(String(raw || '').trim());
}

function buildChatWorkPlan(intent, raw) {
  const text = String(raw || '').trim();
  if (!intent.repair && isSystemStatusQuestion(text)) return null;
  const check = !!intent.explicitCheck;
  const repair = !!intent.repair;
  const conditionalRepair = repair && /\b(kalau|jika|bila|apabila|kalau memang|jika memang|bila memang)\b/i.test(raw)
    || /\b(cek dulu|periksa dulu|telusuri dulu|investigasi dulu)\b/i.test(raw) && repair;
  const actions = [];
  if (check || intent.action) actions.push('CHECK');
  if (check || intent.explicitCheck || repair) actions.push('INVESTIGATE');
  if (repair) actions.push('REPAIR');
  if (!actions.length) return null;
  return {
    actions:[...new Set(actions)],
    conditionalRepair: conditionalRepair || !repair,
    executeOnlyIfProven: repair === true,
    source: 'CGO_CHAT',
    originalRequest: String(raw || '')
  };
}

function chatPlanNeedsTarget(plan) {
  return !!plan && plan.actions.some(a => a === 'CHECK' || a === 'INVESTIGATE' || a === 'REPAIR');
}

function naturalPlanAck(plan, file = null) {
  if (!plan) return null;
  if (!file) return 'Saya tangkap pekerjaannya: saya akan cek dulu, telusuri dengan evidence, lalu hanya melanjutkan perbaikan jika masalah dan solusi konkretnya benar-benar terbukti. Saya belum akan menebak file target.';
  const target = normalizeFile(file);
  if (plan.actions.includes('REPAIR')) return `Baik, saya pegang ${target}. Saya mulai dari pengecekan dan penelusuran source/dependency dulu. Kalau root cause, exact source, dan solusi konkret terbukti, baru saya lanjutkan perbaikannya. Tidak ada source yang saya ubah hanya karena permintaan chat.`;
  return `Baik, saya pegang ${target}. Saya mulai dari source aktual, lalu telusuri dependency dan evidence-nya. Kalau penyebabnya ternyata berada di file lain, saya akan mengikuti source yang terbukti, bukan memaksakan target awal.`;
}

function clarificationForMissingTarget(plan) {
  if (!plan) return null;
  return 'Saya siap mengerjakannya. Saya sudah menangkap alurnya: cek → telusuri → buktikan → dan bila memang terbukti bermasalah, lanjut perbaikan. Tapi file yang kamu maksud belum jelas dari percakapan ini, dan saya tidak akan menebak dari telemetry BCGO. Sebutkan nama file atau bagian yang dimaksud, ya.';
}
function chatCaseStatusText(c) {
  if (!c) return 'Saya belum punya pekerjaan percakapan yang aktif. Saya masih membaca state live dan menunggu instruksi.';
  const evaluation = Logic.evaluate(c, INTERNAL_AUTO_POLICY, knowledge);
  const proof = evaluation.proof || {};
  const file = normalizeFile(c.exactSource?.file || c.target) || 'target';
  const pendingRepair = pendingRepairIntents.has(c.caseId);
  if (c.state === 'RESOLVED') return `Sudah selesai. Perubahan pada ${file} sudah melewati validation dan hasilnya terbukti.`;
  if (pendingRepair) {
    if (proof.complete) return `Perintah perbaikannya masih saya pegang. Proof sudah lengkap untuk ${file}; saya tinggal memastikan gerbang internal dan execution berjalan tanpa melanggar fingerprint source.`;
    if (proof.rootCauseVerified && proof.sourceVerified && !proof.solutionReady) return `Saya masih mengerjakan perbaikan yang tadi. Root cause dan exact source ${file} sudah terbukti; sekarang saya menunggu proposal solusi konkret yang terikat ke source tersebut.`;
    if (proof.rootCauseVerified) return `Saya masih mengerjakan perbaikan yang tadi. Root cause untuk ${file} sudah terbukti, tetapi exact source dan/atau bukti lanjutan masih saya lengkapi.`;
    return `Saya masih mengerjakan perbaikan yang tadi. Saya sedang mengumpulkan bukti untuk ${file}; saya belum akan menganggap dugaan sebagai root cause.`;
  }
  if (proof.complete) return `Proof untuk ${file} sudah lengkap. Tindak lanjutnya adalah gerbang Guardian dan execution; source belum saya klaim berubah sebelum validation.`;
  if (c.rootCause && c.exactSource && !activeRuns.has(c.caseId)) return `Investigasi ${file} sudah selesai: root cause dan exact source terverifikasi. Source belum diubah. Tindak lanjut berikutnya adalah solusi konkret yang terikat ke source tersebut; saya tidak akan mengarang solusi.`;
  if (c.exactSource) return `Exact source ${file} sudah terikat. Investigasi belum saya nyatakan selesai sampai status causal/proof-nya konsisten.`;
  if (c.rootCause) return `Root cause untuk ${file} sudah terbukti. Saya lanjut memastikan exact source dan dependency yang benar sebelum mengambil tindakan.`;
  if (activeRuns.has(c.caseId)) return `Saya masih bekerja pada ${file}. Investigasi sedang berjalan dan saya mengikuti evidence terbaru.`;
  return `Saya masih menyelidiki ${file}. Status internalnya ${c.state || 'EVIDENCE_COLLECTING'} dan saya belum akan menganggap dugaan sebagai penyebab.`;
}
function cancelChatWork() {
  const c = chatCaseFromSession();
  if (c) clearPendingRepair(c.caseId);
  setChatSession({ pendingCommand:null, intent:null });
  return c ? `Baik, saya hentikan perintah tertunda untuk ${normalizeFile(c.exactSource?.file || c.target)}. Source tidak saya ubah.` : 'Baik, tidak ada perintah tertunda yang perlu dihentikan.';
}

// BCGO_STATE is the single authoritative live state. The bridge may receive a
// cloned snapshot during an engine callback, but chat/probes must always prefer
// the newest state published by BCGO itself. This prevents chat from answering
// from an older cycle while the monitor has already advanced.
function getLiveBCGOState(fallback = latestBCGOState) {
  try {
    if (window?.BCGO_STATE && typeof window.BCGO_STATE === "object") return clone(window.BCGO_STATE);
  } catch {}
  return fallback ? clone(fallback) : {};
}

function clone(v) {
  return typeof structuredClone === "function"
    ? structuredClone(v)
    : JSON.parse(JSON.stringify(v));
}

function now() { return new Date().toISOString(); }

function stateRevisionOf(state = {}) {
  const candidates = [state?.lastEventAt, state?.sourceScan?.completedAt, state?.lastTelemetryAt];
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
    const parsed = Date.parse(String(value || ""));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const cycle = Number(state?.cycle);
  return Number.isFinite(cycle) ? cycle : 0;
}

function normalizeFile(v) {
  const raw = String(v || "").trim();
  if (!raw) return null;
  const clean = raw.split("?")[0].split("#")[0];
  return clean.substring(clean.lastIndexOf("/") + 1) || raw;
}

function token(v) {
  return JSON.stringify(v, Object.keys(v || {}).sort());
}

function ensureKnowledge(state) {
  let next = knowledge;
  const files = state?.sourceScan?.sources || state?.sourceScan?.fileStates || {};
  for (const file of Object.keys(files)) {
    const id = `file:${file}`;
    try {
      next = Knowledge.upsertNode(next, {
        id,
        type: "FILE",
        name: file,
        status: "OBSERVED",
        provenance: { source: "BCGO_SOURCE_SCAN", observedAt: now() }
      });
    } catch {}
  }
  const relations = Array.isArray(state?.sourceScan?.relations) ? state.sourceScan.relations : [];
  for (const rel of relations) {
    const from = `file:${normalizeFile(rel.from || rel.sourceFile || rel.file) || ""}`;
    const to = `file:${normalizeFile(rel.to || rel.targetFile || rel.relatedFile) || ""}`;
    if (!from.endsWith(":") && !to.endsWith(":") &&
        next.nodes.some(n => n.id === from) && next.nodes.some(n => n.id === to)) {
      try {
        next = Knowledge.addRelation(next, from, to, "DEPENDS_ON", {
          status: rel.status === "SYNCHRONIZED" || rel.status === "MATCHED_SURFACE" ? "VERIFIED" : "OBSERVED",
          source: "BCGO_SOURCE_SCAN"
        });
      } catch {}
    }
  }
  knowledge = next;
  try { runtime.setKnowledge?.(next); } catch {}
  return clone(knowledge);
}

function mapEvidence(raw, sourceKind = "BCGO") {
  const file = normalizeFile(raw?.fileName || raw?.sourceFile || raw?.file || raw?.target || raw?.source);
  const claim = String(raw?.claim || raw?.message || raw?.error || raw?.detail || "").trim();
  const exact = Number.isFinite(raw?.line) || Number.isFinite(raw?.lineNumber) || !!raw?.exactLineHit;
  const strength = raw?.evidenceStrength === "HIGH" ? 1 :
    raw?.evidenceStrength === "MEDIUM" ? 0.65 :
    Number.isFinite(raw?.strength) ? Math.max(0, Math.min(1, raw.strength)) : 0.35;
  const id = String(raw?.id || raw?.eventId || `${sourceKind}:${file || "unknown"}:${raw?.line || raw?.lineNumber || ""}:${claim}`).slice(0,180);
  return {
    id,
    type: raw?.type || raw?.kind || sourceKind,
    source: file || raw?.source || sourceKind,
    claim: claim || "Telemetry/source observation received.",
    status: ["VERIFIED","UNVERIFIED","CONTRADICTED","REJECTED"].includes(String(raw?.status || "").toUpperCase())
      ? String(raw.status).toUpperCase()
      : "UNVERIFIED",
    strength,
    exact,
    observedAt: raw?.reportedAt || raw?.observedAt || raw?.timestamp || now(),
    fingerprint: raw?.fingerprint || null,
    metadata: {
      file: file || null,
      sourceKind,
      line: raw?.line ?? raw?.lineNumber ?? null,
      evidenceStrength: raw?.evidenceStrength || null,
      proofRequired: raw?.proofRequired !== false
    }
  };
}


function stableNerveToken(nerve = {}, sourceScan = {}) {
  const clean = {
    file: nerve.file || null,
    revision: nerve.revision || nerve.source?.hash || null,
    health: nerve.health || null,
    unresolved: (nerve.unresolved || []).map(x => ({symbol:x.symbol,kind:x.kind,line:x.line,evidence:x.evidence})),
    dependency: {
      refs: (nerve.dependency?.refs || []).slice(0,80),
      relationCount: Number(nerve.dependency?.relationCount || 0),
      issues: (nerve.dependency?.issues || []).map(x => ({status:x.status,sourceFile:x.sourceFile,targetFile:x.targetFile,type:x.type}))
    },
    contract: {
      definitions: (nerve.contract?.definitions || []).slice(0,80),
      callers: (nerve.contract?.callers || []).slice(0,80),
      onclicks: (nerve.contract?.onclicks || []).slice(0,40)
    },
    findings: (nerve.findings?.items || []).slice(0,40).map(x => ({kind:x.kind,type:x.type,severity:x.severity,file:x.file,sourceFile:x.sourceFile,targetFile:x.targetFile,line:x.line,detail:x.detail,missing:x.missing}))
  };
  return JSON.stringify(clean).slice(0,12000);
}

function buildNerveEvidence(state, target) {
  const nerve = state?.fileNerves?.[target];
  if (!nerve) return [];
  const out = [];
  const base = {
    sourceKind: "BCGO_FILE_NERVE",
    fileName: target,
    status: "VERIFIED",
    strength: 0.85,
    exact: false,
    reportedAt: new Date().toISOString()
  };
  out.push({
    ...base,
    id:`NERVE:${target}:SUMMARY:${nerve.revision || nerve.source?.hash || "NA"}`,
    type:"FILE_NERVE_SUMMARY",
    claim:`BCGO nerve ${target}: source=${nerve.health?.source || "UNKNOWN"}, runtime=${nerve.health?.runtime || "UNKNOWN"}, dependency=${nerve.health?.dependency || "UNKNOWN"}, contract=${nerve.health?.contract || "UNKNOWN"}, unresolved=${nerve.unresolved?.length || 0}, relations=${nerve.evidenceSummary?.relations || 0}, findings=${nerve.evidenceSummary?.sourceFindings || 0}.`,
    metadata:{file:target,health:nerve.health||{},evidenceSummary:nerve.evidenceSummary||{},revision:nerve.revision||nerve.source?.hash||null,proofRequired:true}
  });
  for (const x of (nerve.unresolved || []).slice(0,20)) {
    out.push({
      ...base,
      id:`NERVE:${target}:UNRESOLVED:${x.symbol}:${x.kind}:${x.line ?? "NA"}`,
      type:"NERVE_UNRESOLVED_SYMBOL",
      claim:x.evidence || `BCGO menemukan simbol ${x.symbol || "UNKNOWN"} belum terverifikasi pada ${target}.`,
      exact:Number.isFinite(x.line),
      metadata:{file:target,symbol:x.symbol||null,kind:x.kind||null,line:x.line??null,source:x.source||"BCGO_FILE_NERVE",proofRequired:true}
    });
  }
  for (const f of (nerve.findings?.items || []).slice(0,20)) {
    const fFile=normalizeFile(f.file || f.sourceFile || target);
    if (fFile !== target && normalizeFile(f.targetFile) !== target) continue;
    out.push({
      ...base,
      id:`NERVE:${target}:FINDING:${f.kind || f.type || "UNKNOWN"}:${f.line ?? "NA"}:${String(f.detail || f.message || "").slice(0,80)}`,
      type:"NERVE_SOURCE_FINDING",
      claim:`BCGO source finding pada ${target}: ${f.detail || f.message || f.kind || f.type || "temuan source"}.`,
      strength:f.severity === "HIGH" ? 1 : f.severity === "MEDIUM" ? .75 : .55,
      exact:Number.isFinite(f.line),
      metadata:{file:target,kind:f.kind||f.type||null,severity:f.severity||null,line:f.line??null,targetFile:normalizeFile(f.targetFile)||null,missing:f.missing||[],proofRequired:true}
    });
  }
  return out.slice(0,32);
}

function buildNerveRelations(state, target) {
  return (state?.sourceScan?.relations || []).filter(r =>
    normalizeFile(r.sourceFile || r.from || r.file) === target || normalizeFile(r.targetFile || r.to || r.relatedFile) === target
  ).slice(0,24).map((r,i) => ({
    id:`NERVE:${target}:REL:${i}:${r.sourceFile || r.from || ""}:${r.targetFile || r.to || ""}:${r.type || ""}`,
    type:"NERVE_DEPENDENCY_RELATION",
    source:target,
    claim:`BCGO dependency relation ${normalizeFile(r.sourceFile || r.from) || "?"} → ${normalizeFile(r.targetFile || r.to) || "?"} berstatus ${r.status || "OBSERVED"}.`,
    status:"VERIFIED", strength:/MISMATCH|UNKNOWN|VARIANT/.test(String(r.status||"")) ? .8 : .65, exact:false,
    observedAt:new Date().toISOString(), metadata:{file:target,from:normalizeFile(r.sourceFile || r.from),to:normalizeFile(r.targetFile || r.to),relationType:r.type||null,relationStatus:r.status||"OBSERVED",proofRequired:true}
  }));
}

function upsertBCGOCase(item, state) {
  const source = normalizeFile(item?.target || item?.source || state?.lastTelemetryFile) || "UNKNOWN";
  const caseId = String(item?.id || `BCGO-${source}`);
  let c = runtime.getCase(caseId);

  if (!c) {
    c = runtime.detect({
      caseId,
      target: source,
      symptom: item?.evidence?.message || item?.message || state?.lastTelemetryMessage || null,
      severity: item?.severity || "UNKNOWN"
    });
  }

  const raw = item?.evidence || {
    id: `${caseId}:telemetry`,
    fileName: source,
    message: item?.message || state?.lastTelemetryMessage || "BCGO telemetry active.",
    reportedAt: item?.reportedAt || state?.lastTelemetryAt || now()
  };
  const ev = mapEvidence(raw, raw?.type || "BCGO_TELEMETRY");
  // Runtime telemetry is an observation signal, not source proof. It must not
  // permanently block a later proof chain merely because the original symptom
  // remains in the case ledger.
  ev.metadata.proofRequired = false;
  const t = token(ev);
  if (evidenceTokens.get(caseId) !== t) {
    // This is new authoritative BCGO telemetry. Invalidate the old probe plan
    // so the next generation starts from the newest evidence revision.
    activeEngines.delete(caseId);
    const current = runtime.getCase(caseId);
    const sequence = Number(current?.event?.sequence || 0) + 1;
    try { c = runtime.addEvidence(caseId, { ...ev, sequence, eventId: `${caseId}:${sequence}` }); }
    catch { c = runtime.getCase(caseId); }
    evidenceTokens.set(caseId, t);
  }
  const nerve = state?.fileNerves?.[source];
  if (nerve) {
    const nerveToken = stableNerveToken(nerve, state?.sourceScan);
    const priorNerveToken = evidenceTokens.get(`${caseId}:nerve`);
    if (priorNerveToken !== nerveToken) {
      const nerveEvidence = [...buildNerveEvidence(state, source), ...buildNerveRelations(state, source)];
      if (nerveEvidence.length) {
        // File-nerve changes are authoritative source-scan evidence and therefore
        // invalidate the previous investigation generation as well.
        activeEngines.delete(caseId);
        const current = runtime.getCase(caseId);
        const startSeq = Number(current?.event?.sequence ?? -1);
        const stamped = nerveEvidence.map((e,i) => ({...e, sequence:startSeq+i+1, eventId:`${caseId}:nerve:${i}:${nerveToken.slice(0,32)}`}));
        try { c = runtime.addEvidence(caseId, stamped); } catch { c = runtime.getCase(caseId); }
        emitBrainEvent(caseId, "BCGO_NERVE_EVIDENCE_INGESTED", {file:source,evidenceCount:nerveEvidence.length,revision:nerve.revision||nerve.source?.hash||null});
      }
      evidenceTokens.set(`${caseId}:nerve`, nerveToken);
    }
  }
  caseIds.set(source, caseId);
  return c;
}


function investigationFiles(state) {
  const live = getLiveBCGOState(state);
  const sources = live?.sourceScan?.sources;
  if (sources && typeof sources === "object") return Object.keys(sources).map(normalizeFile).filter(Boolean);
  const states = live?.sourceScan?.fileStates;
  if (states && typeof states === "object") return Object.keys(states).map(normalizeFile).filter(Boolean);
  return [];
}

function createInternalProbeProvider(state) {
  return {
    get sourceSurfaceComplete() {
      const live = getLiveBCGOState(state);
      return live?.sourceScan?.status === "CLEAN" || live?.sourceScan?.status === "FINDINGS";
    },
    async listFiles() { return investigationFiles(state); },
    async readSource(file) {
      const normalized = normalizeFile(file);
      if (!normalized) throw new Error("SOURCE_FILE_REQUIRED");
      const url = new URL(normalized, window.location.href).href;
      const response = await fetch(url, {method:"GET", cache:"no-store", credentials:"same-origin"});
      if (!response.ok) throw new Error(`SOURCE_READ_HTTP_${response.status}:${normalized}`);
      const source = await response.text();
      if (!source.trim()) throw new Error(`SOURCE_EMPTY:${normalized}`);
      return {file:normalized, source, fingerprint:Core.contentFingerprint(source)};
    }
  };
}

function getActiveEngine(caseId, caseData) {
  let engine = activeEngines.get(caseId);
  // A probe generation owns its completed-probe cache. Internal probe evidence
  // also increments the runtime case revision, so revision alone cannot be used
  // as a reason to recreate the engine (that previously caused duplicate
  // SOURCE_READ evidence and EVIDENCE_ID_COLLISION). Authoritative BCGO evidence
  // explicitly deletes the engine above, which starts a clean generation.
  if (!engine) {
    engine = ActiveInvestigation.createInvestigationEngine(caseData, knowledge, {maxSteps:10, maxFiles:40});
    engine.state.caseRevision = Number(caseData?.revision ?? 0);
    activeEngines.set(caseId, engine);
  }
  return engine;
}

async function runActiveInvestigation(caseId, state) {
  if (!caseId || activeRuns.has(caseId)) return;
  const current = runtime.getCase(caseId);
  if (!current) return;
  const startRevision = Number(current.revision ?? 0);
  const engine = getActiveEngine(caseId, current);
  if (engine.state?.status !== "ACTIVE") return;
  const provider = createInternalProbeProvider(state);
  const runPromise = (async () => {
    try {
      const out = await engine.run(current, provider, knowledge, {
        maxSteps:10,
        onStep: async (stepOut, stepNumber) => {
          emitBrainEvent(caseId, "ACTIVE_INVESTIGATION_PROGRESS", {
            step: stepNumber,
            probe: stepOut.probe || null,
            evidenceCount: (stepOut.evidence || []).length,
            caseState: stepOut.caseData?.state || null,
            investigationStatus: stepOut.investigation?.status || null,
            selectedHypothesis: stepOut.caseData?.selectedHypothesis ? {
              id: stepOut.caseData.selectedHypothesis.id,
              statement: stepOut.caseData.selectedHypothesis.statement,
              score: stepOut.caseData.selectedHypothesis.score,
              causal: stepOut.caseData.selectedHypothesis.causal === true
            } : null
          });
          try {
            window.dispatchEvent(new CustomEvent("cikur-internal-ai-state", {
              detail: compatibleSnapshot(caseId, "ACTIVE_INVESTIGATION_PROGRESS", stepOut.caseData)
            }));
          } catch {}
        }
      });
      const before = runtime.getCase(caseId);
      if (!before) return;
      // If telemetry/evidence arrived while probes were running, the result is
      // stale. Do not merge stale hypotheses/proof into the newer authoritative
      // case; the finally block will schedule a fresh generation.
      if (Number(before.revision ?? 0) !== startRevision) {
        emitBrainEvent(caseId, "STALE_INVESTIGATION_RESULT_DROPPED", {startRevision,currentRevision:before.revision,steps:out.steps});
        return;
      }

      // Sync only new evidence into the authoritative runtime. The engine never
      // writes source; runtime.addEvidence invalidates old proof before accepting it.
      const known = new Set(before.evidence.map(e => e.id));
      const newEvidence = out.caseData.evidence.filter(e => !known.has(e.id));
      if (newEvidence.length) {
        const startSeq = Number(before.event?.sequence ?? -1);
        const stamped = newEvidence.map((e,i) => ({...e, eventId:`CGO-PROBE:${caseId}:${startSeq+i+1}`, sequence:startSeq+i+1, source:e.source || "CGO_INTERNAL_PROBE"}));
        try { runtime.addEvidence(caseId, stamped); } catch (err) {
          emitBrainEvent(caseId, "PROBE_SYNC_REJECTED", {error:String(err?.message || err), evidenceIds:newEvidence.map(e=>e.id)});
        }
      }

      let synced = runtime.getCase(caseId) || before;
      // The runtime revision may advance when CGO probe evidence is committed;
      // keep this same probe generation attached to the new revision.
      engine.state.caseRevision = Number(synced?.revision ?? engine.state.caseRevision ?? 0);
      if (out.caseData.hypotheses?.length) {
        try { synced = runtime.reason(caseId, out.caseData.hypotheses); } catch {}
      }
      if (out.caseData.rootCause && !synced.rootCause) {
        try { synced = runtime.proveRootCause(caseId, out.caseData.rootCause); } catch {}
      }
      if (out.caseData.exactSource && !synced.exactSource) {
        try { synced = runtime.proveSource(caseId, out.caseData.exactSource); } catch {}
      }

      if ((synced?.exactSource?.file || synced?.rootCause) && chatSession.caseId === caseId) {
        // Investigation is allowed to advance a case in the background, but it
        // must never steal the conversational focus from a newer human target.
        setChatSession({
          caseId,
          primaryFile:normalizeFile(synced.exactSource?.file || synced.rootCause?.file || synced.target || chatSession.primaryFile),
          lastCaseRevision:Number(synced.revision ?? chatSession.lastCaseRevision ?? 0)
        });
      }
      emitBrainEvent(caseId, "ACTIVE_INVESTIGATION_STEP", {
        status:out.status,
        steps:out.steps,
        cycle:out.investigation?.cycle || 0,
        probeLog:out.investigation?.probeLog || [],
        evidenceAdded:newEvidence.length,
        selectedHypothesisId:synced?.selectedHypothesis?.id || null,
        selectedHypothesis:synced?.selectedHypothesis ? {id:synced.selectedHypothesis.id,score:synced.selectedHypothesis.score,causal:synced.selectedHypothesis.causal===true} : null,
        rootCauseVerified:!!synced?.rootCause,
        exactSourceVerified:!!synced?.exactSource,
        state:synced?.state || null
      });

      // The engine can legitimately stop at SOURCE_VERIFIED. Always convert
      // that terminal diagnostic state into an explicit human-readable outcome
      // and next action; otherwise the live chat indicator has no completion
      // signal and appears to be stuck forever.
      const outcome = investigationOutcome(synced, out.investigation);
      emitBrainEvent(caseId, "ACTIVE_INVESTIGATION_COMPLETED", {
        ...outcome,
        steps:out.steps,
        cycle:out.investigation?.cycle || 0,
        evidenceCount:Array.isArray(synced?.evidence) ? synced.evidence.length : 0,
        probeCount:Array.isArray(out.investigation?.probeLog) ? out.investigation.probeLog.length : 0
      });

      latest = compatibleSnapshot(caseId, "ACTIVE_INVESTIGATION");
      try { window.dispatchEvent(new CustomEvent("cikur-internal-ai-state", {detail:latest})); } catch {}
    } catch (err) {
      emitBrainEvent(caseId, "ACTIVE_INVESTIGATION_ERROR", {error:String(err?.message || err)});
    } finally {
      activeRuns.delete(caseId);
      const latestCase = runtime.getCase(caseId);
      if (latestCase && pendingRepairIntents.has(caseId)) {
        void continuePendingRepair(caseId, getLiveBCGOState(state)).catch(err => {
          emitBrainEvent(caseId, "CHAT_REPAIR_CONTINUE_ERROR", {error:String(err?.message || err)});
        });
      }
      if (latestCase && Number(latestCase.revision ?? 0) !== startRevision && activeEngines.get(caseId) !== engine) {
        // Only an authoritative BCGO evidence update replaces the engine. Internal
        // probe evidence also advances the case revision, but must NOT restart the
        // same generation (otherwise SOURCE_READ can be emitted twice and collide).
        setTimeout(() => {
          const fresh = runtime.getCase(caseId);
          if (fresh) void runActiveInvestigation(caseId, state);
        }, 0);
      }
    }
  })();
  activeRuns.set(caseId, runPromise);
  await runPromise;
}

function investigationOutcome(caseData, investigation = null) {
  const evaluation = Logic.evaluate(caseData, INTERNAL_AUTO_POLICY, knowledge);
  const proof = evaluation.proof || {};
  const file = normalizeFile(caseData?.exactSource?.file || caseData?.target) || "target";
  const status = String(investigation?.status || caseData?.state || "UNKNOWN");
  const nextProbe = investigation?.nextProbe || investigation?.nextEvidence || null;

  if (proof.complete) {
    return {
      phase: "PROOF_COMPLETE",
      status,
      conclusion: `Proof chain untuk ${file} sudah lengkap. Root cause, exact source, fingerprint, dan solusi konkret sudah terikat.`,
      nextAction: "GUARDIAN_AND_EXECUTION_GATE",
      blockers: [],
      target: file,
      rootCauseVerified: true,
      exactSourceVerified: true,
      solutionReady: true,
      nextProbe: null
    };
  }

  // SOURCE_VERIFIED is a valid diagnostic stopping point. The previous bridge
  // treated it as if investigation were still running, even though the engine
  // had intentionally stopped after binding the real source. That made the UI
  // appear stuck and gave the human no explicit conclusion or next action.
  if (proof.rootCauseVerified && proof.sourceVerified) {
    return {
      phase: "DIAGNOSIS_COMPLETE_SOLUTION_PENDING",
      status,
      conclusion: `Investigasi selesai untuk ${file}. Root cause dan exact source sudah terverifikasi; source belum diubah.`,
      nextAction: "CONCRETE_SOLUTION_REQUIRED",
      blockers: proof.solutionReady ? [] : ["CONCRETE_SOLUTION_NOT_READY"],
      target: file,
      rootCauseVerified: true,
      exactSourceVerified: true,
      solutionReady: proof.solutionReady === true,
      nextProbe: null
    };
  }

  if (proof.rootCauseVerified) {
    return {
      phase: "ROOT_CAUSE_COMPLETE_SOURCE_PENDING",
      status,
      conclusion: `Root cause untuk ${file} sudah terverifikasi, tetapi exact source belum lengkap terikat.`,
      nextAction: "VERIFY_EXACT_SOURCE",
      blockers: ["EXACT_SOURCE_NOT_VERIFIED"],
      target: file,
      rootCauseVerified: true,
      exactSourceVerified: false,
      solutionReady: false,
      nextProbe
    };
  }

  const blockers = Array.isArray(proof.blockers) ? proof.blockers.slice(0, 8) : ["PROOF_CHAIN_INCOMPLETE"];
  return {
    phase: status === "LIMIT_REACHED" || status === "YIELD" || status === "STABLE"
      ? "INVESTIGATION_STOPPED_WITHOUT_PROOF"
      : "INVESTIGATION_INCOMPLETE",
    status,
    conclusion: `Investigasi ${file} belum menghasilkan root cause yang terverifikasi. Saya tidak akan mengarang kesimpulan.`,
    nextAction: nextProbe ? "CONTINUE_WITH_NEXT_PROBE" : "REQUEST_MORE_EVIDENCE",
    blockers,
    target: file,
    rootCauseVerified: false,
    exactSourceVerified: false,
    solutionReady: false,
    nextProbe
  };
}

function emitBrainEvent(caseId, type, payload) {
  const detail = {version:VERSION,caseId,type,at:Date.now(),payload:clone(payload || {})};
  try { window.dispatchEvent(new CustomEvent("cikur-internal-ai-investigation", {detail})); } catch {}
}


function chatSourceFiles(state = {}) {
  const files = new Set(Object.keys(state?.systemOrgans || {}));
  const sources = state?.sourceScan?.sources;
  const fileStates = state?.sourceScan?.fileStates;
  if (sources && typeof sources === "object") Object.keys(sources).forEach(f => files.add(normalizeFile(f)));
  if (fileStates && typeof fileStates === "object") Object.keys(fileStates).forEach(f => files.add(normalizeFile(f)));
  return [...files].filter(Boolean);
}

function explicitFileMentions(q) {
  const text = String(q || "");
  // Filename identity is intentionally extension-agnostic. BCGO_STATE/sourceScan
  // remains the authority for whether a named file actually exists/is readable.
  // This lets chat understand arbitrary project files instead of a hard-coded
  // extension whitelist (for example .py, .php, .yaml, .sql, or future types).
  const matches = text.match(/(?:[A-Za-z0-9_-]+\.)+[A-Za-z0-9_-]+/g) || [];
  return [...new Set(matches.map(normalizeFile).filter(v => v && v !== "UNKNOWN"))];
}

function requestedChatFiles(q, state) {
  const files = chatSourceFiles(state);
  const lower = String(q || "").toLowerCase();
  const explicit = explicitFileMentions(q);
  const known = files.filter(file => lower.includes(String(file).toLowerCase()));
  return [...new Set([...explicit, ...known])].sort((a,b) => {
    const ai = lower.indexOf(String(a).toLowerCase());
    const bi = lower.indexOf(String(b).toLowerCase());
    return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi);
  });
}

function requestedChatFile(q, state) {
  return requestedChatFiles(q, state)[0] || null;
}

function fileKnownToBCGO(file, state) {
  const target = normalizeFile(file);
  if (!target || target === "UNKNOWN") return false;
  return chatSourceFiles(state).some(f => normalizeFile(f).toLowerCase() === target.toLowerCase());
}

function findChatCaseForFile(file) {
  const normalized = normalizeFile(file);
  const caseId = normalized ? chatCaseIds.get(normalized) : null;
  return caseId ? runtime.getCase(caseId) : null;
}

function chatFindingMatches(finding, files) {
  const wanted = new Set((files || []).map(normalizeFile).filter(Boolean));
  const a = normalizeFile(finding?.file || finding?.sourceFile || finding?.source);
  const b = normalizeFile(finding?.targetFile || finding?.relatedFile || finding?.to);
  return wanted.has(a) || wanted.has(b);
}

function syncChatContextEvidence(caseId, state, files, comparison) {
  const c = runtime.getCase(caseId);
  if (!c) return null;
  const scan = state?.sourceScan || {};
  const candidates = [
    ...(Array.isArray(scan.findings) ? scan.findings : []),
    ...(Array.isArray(scan.crossFileFindings) ? scan.crossFileFindings : [])
  ].filter(f => chatFindingMatches(f, files));
  const existing = new Set((c.evidence || []).map(e => e.id));
  const additions = candidates.slice(0, 32).map((f, i) => {
    const file = normalizeFile(f?.file || f?.sourceFile || f?.source);
    const line = f?.line ?? f?.targetLine ?? null;
    const kind = f?.type || f?.kind || "SOURCE_FINDING";
    const symbol = f?.symbol || f?.missing?.[0] || f?.metadata?.symbol || null;
    return {
      id:`CGO_CHAT_SCAN:${file || "unknown"}:${line ?? "NA"}:${kind}:${i}`,
      eventId:`CGO_CHAT_SCAN:${file || "unknown"}:${line ?? "NA"}:${kind}:${i}`,
      type:"CHAT_SOURCE_FINDING",
      source:"BCGO_SOURCE_SCAN",
      claim:`BCGO scanner menemukan ${kind} pada ${file || "source"}${line ? `:${line}` : ""}: ${f?.message || f?.detail || f?.claim || "temuan source"}.`,
      status:"VERIFIED",
      strength:f?.severity === "HIGH" ? 1 : f?.severity === "MEDIUM" ? .8 : .65,
      exact:Number.isFinite(line),
      fingerprint:f?.fingerprint || null,
      observedAt:now(),
      metadata:{
        file, line, kind, symbol,
        targetFile:normalizeFile(f?.targetFile || f?.relatedFile || f?.to),
        comparison:!!comparison,
        proofRequired:true
      }
    };
  }).filter(e => !existing.has(e.id));
  if (!additions.length) return c;
  try { return runtime.addEvidence(caseId, additions); } catch { return runtime.getCase(caseId) || c; }
}

function createChatCase(file, state, rawQuestion, chatContext = lastChatContext) {
  const targetFile = normalizeFile(file);
  if (!targetFile) return null;
  const live = getLiveBCGOState(state);
  const caseId = `CGO-CHAT-${Date.now()}-${++chatWorkSequence}`;
  let c = null;
  {
    c = runtime.detect({
      caseId,
      target: targetFile,
      symptom: rawQuestion,
      severity: "UNKNOWN",
      source: "CGO_CHAT"
    });
  }
  try {
    const current = runtime.getCase(caseId) || c;
    if (!current.evidence?.some(e => e.type === "CHAT_REQUEST")) {
      const seq = Number(current.event?.sequence ?? 0) + 1;
      c = runtime.addEvidence(caseId, {
        id:`CGO_CHAT:${targetFile}:${seq}`, eventId:`CGO_CHAT:${targetFile}:${seq}`, sequence:seq,
        type:"CHAT_REQUEST", source:"CGO_CHAT", claim:`Pengguna meminta CGO memeriksa ${targetFile}: ${rawQuestion}`,
        status:"VERIFIED", strength:.70, exact:false,
        metadata:{file:targetFile, proofRequired:false, userIntent:chatContext?.comparison ? "CROSS_FILE_CHECK" : "CHECK", relatedFiles:Array.isArray(chatContext?.files) ? chatContext.files.filter(f => f !== targetFile).slice(0,8) : []}
      });
    }
  } catch {}
  c = syncChatContextEvidence(caseId, live, chatContext?.files?.length ? chatContext.files : [targetFile], chatContext?.comparison);
  chatCaseIds.set(targetFile, caseId);
  lastChatCaseId = caseId;
  return runtime.getCase(caseId) || c;
}

function scheduleChatInvestigation(file, state, rawQuestion, chatContext = lastChatContext) {
  const c = createChatCase(file, state, rawQuestion, chatContext);
  if (!c) return null;
  setChatSession({
    caseId:c.caseId,
    primaryFile:normalizeFile(c.exactSource?.file || c.target || file),
    files:Array.isArray(chatContext?.files) && chatContext.files.length ? chatContext.files.map(normalizeFile).filter(Boolean) : [normalizeFile(file)].filter(Boolean),
    comparison:chatContext?.comparison === true,
    intent:'INVESTIGATE'
  });
  if (!activeRuns.has(c.caseId)) {
    void runActiveInvestigation(c.caseId, state).catch(err => {
      emitBrainEvent(c.caseId, "CHAT_INVESTIGATION_ERROR", {error:String(err?.message || err)});
    });
  }
  latest = compatibleSnapshot(c.caseId, "CHAT_INVESTIGATION_STARTED");
  try { window.dispatchEvent(new CustomEvent("cikur-internal-ai-state", {detail:latest})); } catch {}
  return c;
}

function bindInternalExecutionTarget() {
  const target = window.CIKURInternalExecutionTarget || window.BCGOPatchExecutor;
  if (!target) return false;
  if (typeof target.read !== "function" || typeof target.write !== "function" || typeof target.execute !== "function") return false;
  try {
    runtime.bindExecutionTarget?.(target);
    return runtime.hasExecutionHand?.() === true;
  } catch (err) {
    emitBrainEvent(lastChatCaseId, "EXECUTION_TARGET_BIND_FAILED", {error:String(err?.message || err)});
    return false;
  }
}

function setPendingRepair(caseId, file, rawQuestion, context = lastChatContext) {
  if (!caseId) return;
  pendingRepairIntents.set(caseId, {
    caseId,
    target: normalizeFile(file),
    question: String(rawQuestion || ""),
    relatedFiles: Array.isArray(context?.files) ? context.files.slice(0, 12).map(normalizeFile).filter(Boolean) : [],
    comparison: context?.comparison === true,
    requestedAt: Date.now(),
    stateRevision: stateRevisionOf(getLiveBCGOState())
  });
}

function clearPendingRepair(caseId) {
  if (caseId) pendingRepairIntents.delete(caseId);
}

async function continuePendingRepair(caseId, state) {
  const intent = pendingRepairIntents.get(caseId);
  if (!intent || activeRuns.has(caseId)) return null;
  const c = runtime.getCase(caseId);
  if (!c) { clearPendingRepair(caseId); return null; }
  const evaluation = Logic.evaluate(c, INTERNAL_AUTO_POLICY, knowledge);
  if (!evaluation.proof.complete) {
    emitBrainEvent(caseId, "CHAT_REPAIR_WAITING", {
      target: normalizeFile(intent.target || c.target),
      revision: c.revision,
      blockers: evaluation.proof?.blockers || [],
      solutionReady: evaluation.proof?.solutionReady === true,
      stateRevision: stateRevisionOf(getLiveBCGOState(state))
    });
    return evaluation;
  }
  if (evaluation.guardian?.decision !== "AUTO_ALLOWED") {
    emitBrainEvent(caseId, "CHAT_REPAIR_BLOCKED", {reason:evaluation.guardian?.reason || "GUARDIAN_BLOCKED", target:normalizeFile(c.exactSource?.file || c.target)});
    return evaluation;
  }
  if (!bindInternalExecutionTarget()) {
    emitBrainEvent(caseId, "CHAT_REPAIR_READY_EXECUTOR_MISSING", {target:normalizeFile(c.exactSource?.file || c.target)});
    return evaluation;
  }
  clearPendingRepair(caseId);
  try {
    const result = await runtime.execute(caseId, INTERNAL_AUTO_POLICY);
    const finalCase = runtime.getCase(caseId);
    const completed = finalCase?.state === "RESOLVED" || result?.status === "RESOLVED";
    if (chatSession.caseId === caseId) {
      setChatSession({caseId, primaryFile:normalizeFile(finalCase?.exactSource?.file || c.exactSource?.file || c.target), pendingCommand:completed ? null : 'REPAIR', intent:'REPAIR', lastCaseRevision:Number(finalCase?.revision ?? c.revision ?? 0)});
    }
    emitBrainEvent(caseId, completed ? "CHAT_REPAIR_COMPLETED" : "CHAT_REPAIR_EXECUTED", {result, state:finalCase?.state || null, target:normalizeFile(finalCase?.exactSource?.file || c.exactSource?.file || c.target)});
    latest = compatibleSnapshot(caseId, "CHAT_REPAIR_EXECUTED");
    try { window.dispatchEvent(new CustomEvent("cikur-internal-ai-state", {detail:latest})); } catch {}
    return result;
  } catch (err) {
    // Keep the intent only for recoverable readiness failures; execution failures
    // must not silently retry a consumed or integrity-failed authorization.
    const msg = String(err?.message || err);
    if (/AUTHORIZATION_|EXECUTION_PROOF_|EXECUTION_AUTHORIZATION_|EXECUTOR_NOT_CONFIGURED/.test(msg)) clearPendingRepair(caseId);
    emitBrainEvent(caseId, "CHAT_REPAIR_FAILED", {error:msg,target:normalizeFile(c.exactSource?.file || c.target)});
    return {status:"FAILED",reason:msg,caseId};
  }
}

function repairChatCase(file, state, rawQuestion) {
  // A repair instruction referring to "yang tadi/bagian itu" belongs to the
  // currently active conversation case. Never create a fresh case merely
  // because investigation has already moved the proven source to another file.
  const sessionCase = chatCaseFromSession();
  const requested = normalizeFile(file);
  const sessionTargets = new Set([
    normalizeFile(sessionCase?.target),
    normalizeFile(sessionCase?.exactSource?.file),
    ...(Array.isArray(chatSession.files) ? chatSession.files.map(normalizeFile) : [])
  ].filter(Boolean));
  let c = sessionCase && (!requested || sessionTargets.has(requested))
    ? sessionCase
    : findChatCaseForFile(requested);
  if (!c) c = scheduleChatInvestigation(requested, state, rawQuestion);
  if (!c) return {text:"Saya belum bisa menentukan file target dari perintah itu.", caseId:null};
  setPendingRepair(c.caseId, file, rawQuestion, lastChatContext);

  const policy = INTERNAL_AUTO_POLICY;
  const evaluation = Logic.evaluate(c, policy, knowledge);
  const exactFile = normalizeFile(c.exactSource?.file) || normalizeFile(file);
  if (!evaluation.proof.complete) {
    // Do not restart an already-proven investigation merely because the concrete
    // repair solution has not arrived yet. Re-probing here would add evidence,
    // invalidate the exact-source proof, and make the chat appear to move
    // backwards. Continue investigation only while the causal/source proof is
    // actually incomplete.
    const proofNeedsInvestigation = !evaluation.proof.rootCauseVerified || !evaluation.proof.sourceVerified;
    if (proofNeedsInvestigation && !activeRuns.has(c.caseId)) void runActiveInvestigation(c.caseId, state).catch(()=>{});
    const rootStatus = evaluation.proof.rootCauseVerified ? "root cause terbukti" : "root cause belum terbukti";
    const sourceStatus = evaluation.proof.sourceVerified ? "exact source terbukti" : "exact source belum terbukti";
    const locationText = exactFile && exactFile !== normalizeFile(file)
      ? ` Hasil investigasi sementara mengikat source ke ${exactFile}, bukan sekadar target chat ${normalizeFile(file)}.`
      : "";
    const solutionStatus = evaluation.proof.solutionReady ? "solusi konkret sudah siap" : "solusi konkret belum tersedia";
    const waitingText = evaluation.proof.rootCauseVerified && evaluation.proof.sourceVerified && !evaluation.proof.solutionReady
      ? " Saya menunggu proposal solusi konkret yang terikat ke exact source; saya tidak akan mengulang proof yang sudah sah."
      : " Saya lanjutkan hanya dari evidence dan source yang sudah terbukti.";
    return {
      caseId:c.caseId,
      text:`Saya terima perintah perbaikan. Saya belum mengubah source. Saat ini ${rootStatus}, ${sourceStatus}, dan ${solutionStatus}.${locationText}${waitingText}`
    };
  }

  if (evaluation.guardian?.decision !== "AUTO_ALLOWED") {
    return {
      caseId:c.caseId,
      text:`Proof untuk ${exactFile} sudah lengkap, tetapi gerbang internal belum menghasilkan AUTO_ALLOWED: ${evaluation.guardian?.reason || "UNKNOWN"}. Saya tidak akan melewati gerbang tersebut.`
    };
  }

  if (!bindInternalExecutionTarget()) {
    emitBrainEvent(c.caseId, "AUTO_EXECUTION_READY", {
      decision:evaluation.guardian?.decision,
      risk:evaluation.guardian?.risk,
      reason:evaluation.guardian?.reason,
      target:normalizeFile(exactFile),
      next:"PATCH_EXECUTOR_BIND_REQUIRED"
    });
    return {
      caseId:c.caseId,
      text:`Proof sudah lengkap dan gerbang internal sudah AUTO_ALLOWED untuk ${normalizeFile(exactFile)}, tetapi Patch Executor internal belum ter-bind. Saya mempertahankan perintah “Perbaiki” sebagai intent tertunda dan tidak akan mengarang eksekusi.`
    };
  }

  void continuePendingRepair(c.caseId, state);
  return {
    caseId:c.caseId,
    text:`Baik. Perintah “Perbaiki” untuk ${normalizeFile(exactFile)} diterima. Proof dan gerbang internal akan saya ikat ke source/fingerprint terbaru sebelum execution lalu validation.`
  };
}

function recordChatTurn(role, text, meta = {}) {
  // Persist only conversational text/metadata safe for restoration. Runtime
  // proof, authorization, fingerprints and case identity are never persisted.
  chatTranscript.push({ role, text:String(text || ''), at:Date.now(), ...clone(meta), caseId:null });
  if (chatTranscript.length > CHAT_MEMORY_LIMIT) chatTranscript = chatTranscript.slice(-CHAT_MEMORY_LIMIT);
  writeChatMemory();
}

function lastChatUserText() {
  for (let i = chatTranscript.length - 1; i >= 0; i--) {
    if (chatTranscript[i]?.role === 'user') return String(chatTranscript[i].text || '');
  }
  return '';
}

function lastChatAssistantText() {
  for (let i = chatTranscript.length - 1; i >= 0; i--) {
    if (chatTranscript[i]?.role === 'bcgo') return String(chatTranscript[i].text || '');
  }
  return '';
}

function classifyDialogue(raw, session = chatSession) {
  return Instruction.classifyDialogue(raw, session);
}

function conversationalAnswer(dialogue, state = {}, session = chatSession) {
  if (!dialogue?.casual) return null;
  if (dialogue.identity) {
    return 'Aku CGO — lapisan kecerdasan internal CIKUR GO yang berbicara melalui kanal BCGO. Aku bisa ngobrol, memahami konteks percakapan, dan saat masuk pekerjaan teknis aku beralih ke mode evidence-first: source, dependency, root cause, proof, lalu tindakan yang diizinkan.';
  }
  if (dialogue.systemRole) {
    return 'BCGO bukan “hanya sistem” yang berdiri sendiri. BCGO adalah lingkungan saraf/operasional yang membaca telemetry, source scan, event, dan state live. CGO adalah intelligence yang memahami informasi itu dan berbicara kepadamu melalui UI BCGO. Jadi sederhananya: BCGO memberi keadaan nyata, CGO memahami dan meresponsnya.';
  }
  if (dialogue.capability) {
    return 'Aku bisa menemani percakapan biasa, menjaga konteks, membaca keadaan BCGO yang live, menelusuri source dan dependency, membedakan fakta dari hipotesis, serta menyiapkan tindakan teknis hanya jika buktinya cukup. Untuk perubahan source, aku tetap terikat pada proof dan gerbang execution — bukan asal mengubah file.';
  }
  if (dialogue.emotional) {
    return 'Aku bisa memakai bahasa yang hangat dan merespons nuansa percakapan, tetapi aku tidak akan berpura-pura punya perasaan manusia. Yang penting, aku bisa tetap hadir dalam percakapan dan memahami konteks yang sedang kita bicarakan.';
  }
  if (dialogue.currentActivity) {
    if (session?.caseId && session?.primaryFile) {
      const action = session.pendingCommand === 'REPAIR' ? 'menangani perbaikan' : 'menelusuri';
      return `Saat ini aku sedang ${action} ${session.primaryFile}. Aku masih mengikuti evidence dan konteks pekerjaan itu, jadi kalau kamu bertanya lanjut seperti “kenapa?” atau “gimana?”, aku akan mengaitkannya ke pekerjaan ini.`;
    }
    return 'Saat ini aku sedang mengikuti percakapan ini dan membaca konteks yang kamu berikan. Kalau kamu mengarahkan ke pekerjaan sistem, aku bisa berpindah ke mode investigasi tanpa kehilangan konteks obrolan.';
  }
  if (dialogue.contextualWhy) {
    if (session?.topic === 'CURRENT_ACTIVITY') return 'Karena aku sedang menjaga percakapan dan konteks pekerjaan/pertanyaan terakhir tetap nyambung. Kalau yang kamu maksud “kenapa” terhadap keputusan teknis tertentu, sebutkan bagian itu dan aku akan membedah alasannya berdasarkan evidence.';
    if (session?.topic === 'CGO_BCGO_ROLE') return 'Karena keduanya memang punya tugas berbeda dalam satu alur: BCGO menyediakan keadaan nyata sistem, sementara CGO memahami, menalar, dan berkomunikasi berdasarkan keadaan itu.';
    if (session?.topic === 'IDENTITY') return 'Karena peranku memang sebagai intelligence internal yang memahami percakapan dan keadaan BCGO, bukan sekadar tampilan dashboard.';
    return 'Karena aku masih mengikuti konteks percakapan terakhir. Kalau “kenapa” yang kamu maksud adalah alasan teknis, aku akan membedakannya dari obrolan biasa dan meminta evidence yang relevan sebelum menyimpulkan.';
  }
  if (dialogue.contextualFollowUp) {
    if (session?.topic === 'CGO_BCGO_ROLE') return 'Kalau maksudmu penjelasan tadi: hubungan keduanya memang seperti itu — BCGO menjaga keadaan nyata sistem, sedangkan CGO menjadi lapisan intelligence yang memahami keadaan tersebut dan berbicara melalui BCGO. Jadi bukan dua otak yang saling bersaing; keduanya punya peran berbeda dalam satu alur.';
    if (session?.topic === 'IDENTITY') return 'Kalau maksudmu tentang aku tadi: aku CGO, intelligence internal yang berbicara melalui BCGO. Aku bisa berpindah dari obrolan biasa ke pekerjaan teknis tanpa memutus konteks, tetapi untuk kebenaran sistem aku tetap tunduk pada evidence.';
    if (session?.topic === 'CAPABILITY') return 'Kalau maksudmu “terus bagaimana cara kerjanya?”: percakapan tetap ditangani CGO, sementara BCGO memasok state, telemetry, event, dan source surface yang nyata. Saat kamu memberi instruksi teknis, konteks itu berubah menjadi case dan masuk ke jalur investigasi.';
    return 'Kalau maksudmu melanjutkan obrolan tadi, aku masih mengikuti topiknya. Lanjutkan saja dengan bahasa biasa; aku akan menjaga konteksnya selama konteks itu memang masih jelas.';
  }

  if (dialogue.greeting) {
    const cycle = Number(state?.cycle);
    const live = state?.connection?.status === 'LIVE' ? 'BCGO juga sedang menerima state live.' : 'Aku tetap siap meski state live belum lengkap.';
    return Number.isFinite(cycle) && cycle > 0
      ? `Halo 😊 Aku di sini. Cycle BCGO sekarang #${cycle}; ${live} Kalau mau ngobrol santai boleh, kalau mau kerja teknis juga tinggal arahkan.`
      : `Halo 😊 Aku di sini. ${live} Kita bisa ngobrol biasa atau langsung masuk ke pekerjaan sistem.`;
  }
  if (dialogue.gratitude) return 'Sama-sama 😊. Kita lanjut pelan-pelan tapi tetap presisi. Kalau ada yang mau dicek atau dibahas, bilang saja.';
  if (dialogue.apology) return 'Tidak apa-apa 😊. Kita luruskan saja konteksnya dan lanjut dari bagian yang benar. Kalau menyangkut sistem, aku tetap pastikan buktinya jelas.';
  if (dialogue.farewell) return 'Baik 😊. Sampai ketemu lagi. Konteks percakapan yang aman boleh tersimpan, tetapi proof/runtime lama tetap harus diverifikasi ulang ketika pekerjaan teknis dilanjutkan.';
  if (dialogue.affection) return 'Hehe 😊 Aku terima semangatnya. Kita lanjutkan dengan tenang — ngobrol boleh santai, tapi kalau sudah menyentuh source dan tindakan sistem, aku tetap harus disiplin pada bukti.';
  return null;
}

function classifyChatIntent(raw, session = chatSession) {
  const q = String(raw || '').toLowerCase().trim();
  const dialogue = classifyDialogue(raw, session);
  const has = re => re.test(q);
  const cancel = has(/\b(batal|batalkan|hentikan|stop|jangan lanjut|jangan diteruskan)\b/);
  const repair = has(/\b(perbaiki|perbaikan|perbaiki(?:kan)?|fix|repair|patch|benahi|betulkan|perbaiki sekarang)\b/);
  const result = has(/\b(hasilnya?|progressnya?|progresnya?|sudah sampai|sampai mana|bagaimana hasil|gimana hasil|sudah selesai|selesai belum|statusnya?|perkembangannya?)\b/);
  const explicitCheck = has(/\b(cek|periksa|check|telusuri|investigasi|selidiki|bandingkan|cocokkan|lihat|analisa|analisis)\b/);
  const continuation = has(/\b(lanjut|lanjutkan|teruskan|proses|kerjakan|jalankan|jalan terus|terus)\b/);
  const greeting = has(/^(halo|hai|hello|pagi|siang|sore|malam)\b/);
  const presence = /^(bcgo|cgo)\s*[?!.]*$/i.test(q);
  const acknowledgement = /^(oke|ok|iya|ya|baik|sip|siap|mantap|benar|betul|oke ya|baik ya)$/i.test(q);
  const continuationOnly = /^(lanjut|lanjutkan|teruskan|jalan terus|terus|lanjut ya|lanjutkan ya|teruskan ya)$/i.test(q);
  const statusOnly = /^(hasilnya?|progressnya?|progresnya?|sudah sampai mana|sampai mana|bagaimana hasilnya?|gimana hasilnya?|sudah selesai|selesai belum|statusnya?)$/i.test(q);
  const contextualStatusOnly = /^(gimana|bagaimana)[?!.\s]*$/i.test(q) && !!(session?.caseId || session?.primaryFile || session?.files?.length);
  const correction = has(/\b(bukan itu|bukan yang (saya|aku) maksud|bukan begitu|bukan yang dimaksud|salah|maksud (saya|aku)|yang saya maksud|yang aku maksud|eh bukan|bukan)\b/);
  const feedback = has(/\b(jawabanmu|jawaban kamu|responmu|respon kamu|jawabannya|tidak sesuai|nggak sesuai|tidak nyambung|nggak nyambung|kurang tepat|tidak menjawab|bukan yang saya tanyakan|saya nanya apa)\b/);
  const question = has(/\b(apa|apakah|kenapa|mengapa|gimana|bagaimana|bisa|boleh|dimana|di mana|yang mana)\b/) || q.endsWith('?');
  const action = has(/\b(lakukan|kerjakan|jalankan|cek|periksa|telusuri|bandingkan|cocokkan|perbaiki|benahi|betulkan|lanjutkan|tangani)\b/);
  const conversationFirst = dialogue?.conversationFirst === true && !dialogue?.contextualWhy && !dialogue?.contextualFollowUp;
  return {
    cancel,
    repair: conversationFirst ? false : repair,
    result: conversationFirst ? false : result,
    explicitCheck: conversationFirst ? false : explicitCheck,
    continuation: conversationFirst ? false : continuation,
    greeting, presence, acknowledgement, correction, feedback, question,
    action: conversationFirst ? false : action,
    followUp: has(/\b(yang tadi|bagian itu|file itu|yang barusan|sebelumnya|tadi|kasus itu|case itu|bagian tersebut|yang itu|yang dimaksud|yang saya bilang|yang aku bilang)\b/),
    continuationOnly: conversationFirst ? false : continuationOnly,
    statusOnly, contextualStatusOnly, dialogue,
    q, hasWorkContext: !!(session?.caseId || session?.primaryFile || session?.files?.length)
  };
}

function continueExistingChatWork(state, intent) {
  const c = chatCaseFromSession();
  if (!c) {
    return { handled:false, text:null };
  }
  const target = normalizeFile(c.exactSource?.file || c.target || chatSession.primaryFile);
  const pendingRepair = pendingRepairIntents.has(c.caseId) || chatSession.pendingCommand === "REPAIR";
  if (pendingRepair) {
    // Never clear a repair intent merely because the user said "lanjutkan".
    // Continue the same case and preserve proof/revision continuity.
    if (!activeRuns.has(c.caseId)) void runActiveInvestigation(c.caseId, state).catch(()=>{});
    setChatSession({
      lastUserText:intent.q,
      intent:"REPAIR",
      pendingCommand:"REPAIR",
      pendingWork:chatSession.pendingWork,
      caseId:c.caseId,
      primaryFile:target,
      files:chatSession.files,
      comparison:chatSession.comparison
    });
    return {
      handled:true,
      text:`Baik, saya lanjutkan pekerjaan yang tadi dari case yang sama. Fokus tetap pada ${target}. Saya mempertahankan evidence dan proof yang sudah ada, lalu melanjutkan penelusuran dari posisi terakhir.`
    };
  }
  if (!activeRuns.has(c.caseId)) void runActiveInvestigation(c.caseId, state).catch(()=>{});
  setChatSession({
    lastUserText:intent.q,
    intent:chatSession.intent || "INVESTIGATE",
    caseId:c.caseId,
    primaryFile:target,
    files:chatSession.files,
    comparison:chatSession.comparison,
    pendingCommand:chatSession.pendingCommand,
    pendingWork:chatSession.pendingWork
  });
  return {
    handled:true,
    text:`Baik, saya lanjutkan dari posisi terakhir untuk ${target}. Saya tidak membuat case baru dan tidak mengulang pekerjaan hanya karena kamu meminta lanjut; saya mengikuti evidence terbaru yang sudah terkumpul.`
  };
}

function switchConversationTarget(newTarget) {
  const target = normalizeFile(newTarget);
  const current = chatCaseFromSession();
  const currentTarget = normalizeFile(current?.exactSource?.file || current?.target || chatSession.primaryFile);
  if (current && target && currentTarget && currentTarget.toLowerCase() !== target.toLowerCase()) {
    // A human target correction starts a new work case. Any repair intent bound
    // to the old target is canceled so it can never execute after the user has
    // moved the conversation elsewhere.
    clearPendingRepair(current.caseId);
  }
  return { current, currentTarget };
}

function chatAnswer(question = {}) {
  const raw = typeof question === "string" ? question : String(question?.text || question?.question || "");
  const q = raw.toLowerCase().trim();
  const state = getLiveBCGOState();
  latestBCGOState = clone(state);
  const snapshot = latest;
  const reasoning = snapshot?.reasoning || {};
  const organs = state?.systemOrgans || {};
  const metrics = state?.metrics || {};
  const relations = Array.isArray(state?.sourceScan?.relations) ? state.sourceScan.relations : [];
  const active = Object.entries(organs).filter(([,v]) => v?.state === "ACTIVE");
  const review = Object.entries(organs).filter(([,v]) => v?.state === "REVIEW");
  const mentionedFiles = requestedChatFiles(q, state);
  const explicitMentions = explicitFileMentions(raw);
  const unknownExplicitFiles = explicitMentions.filter(file => !fileKnownToBCGO(file, state));
  const ref = resolveChatReference(raw, state, mentionedFiles);
  const requestedFile = mentionedFiles[0] || null;
  const explicitRequestedFile = explicitMentions[0] || null;
  // An explicit human filename always outranks remembered telemetry/context.
  // If that filename is not known to the live BCGO registry/source surface,
  // preserve it as the requested target and ask for clarification instead of
  // silently substituting index.html or lastTelemetryFile.
  const chatFile = explicitRequestedFile || requestedFile || ref.file;
  const intent = classifyChatIntent(raw, chatSession);
  // Every turn updates the conversational state before any early return. This
  // keeps UI transcript, session memory, and the active work context aligned.
  setChatSession({
    turn:chatSession.turn + 1,
    lastUserText:raw
  });
  const newPlan = buildChatWorkPlan(intent, raw);

  // Pure continuation is a conversational control command, not a new work
  // request. It must never create CHAT_REQUEST evidence or invalidate proof.
  if (intent.continuationOnly && !intent.repair && !intent.explicitCheck && !intent.feedback && !intent.correction) {
    // If the immediately preceding turn is waiting for a target clarification,
    // “lanjutkan” cannot resurrect the abandoned/old case. The human must first
    // resolve the clarification.
    if (chatSession.clarificationNeeded) {
      return clarificationForMissingTarget(chatSession.pendingWork);
    }
    const continued = continueExistingChatWork(state, intent);
    if (continued.handled) return continued.text;
    if (intent.dialogue?.contextualFollowUp && chatSession.topic) {
      const follow = conversationalAnswer(intent.dialogue, state, chatSession);
      if (follow) return follow;
    }
    // If the human just corrected a target and then says “lanjutkan”, treat that
    // as an instruction to start work on the corrected target, but create a new
    // case rather than reviving an older case for the same filename.
    if (chatSession.primaryFile) {
      const target = normalizeFile(chatSession.primaryFile);
      const files = Array.isArray(chatSession.files) && chatSession.files.length ? chatSession.files : [target];
      lastChatContext = {files, comparison:files.length > 1, question:chatSession.lastUserText || intent.q, stateRevision:stateRevisionOf(state)};
      const c = scheduleChatInvestigation(target, state, chatSession.lastUserText || intent.q, lastChatContext);
      if (c) {
        const restoredRepair = chatSession.pendingCommand === 'REPAIR' || chatSession.pendingWork?.actions?.includes?.('REPAIR');
        const continuationWork = restoredRepair
          ? {actions:['CHECK','INVESTIGATE','REPAIR'], conditionalRepair:false, executeOnlyIfProven:true, source:'CGO_CHAT_CONTINUE_AFTER_CORRECTION'}
          : {actions:['CHECK','INVESTIGATE'], source:'CGO_CHAT_CONTINUE_AFTER_CORRECTION'};
        setChatSession({caseId:c.caseId, primaryFile:target, files, comparison:files.length > 1, intent:restoredRepair ? 'REPAIR' : 'INVESTIGATE', pendingCommand:restoredRepair ? 'REPAIR' : null, pendingWork:continuationWork, clarificationNeeded:false});
        if (restoredRepair) setPendingRepair(c.caseId, target, chatSession.lastUserText || intent.q, lastChatContext);
        return `Baik. Saya lanjutkan dari target yang baru kamu koreksi, yaitu ${target}. Saya mulai penelusuran dari source aktual dan evidence terbaru tanpa membawa case lama${restoredRepair ? ', dan perintah perbaikannya tetap saya pegang sebagai intent—bukan proof lama.' : '.'}`;
      }
    }
    return `Baik. Saya siap melanjutkan, tetapi belum ada pekerjaan percakapan yang aktif. Sebutkan file atau pekerjaan yang ingin saya mulai.`;
  }

  // A bare acknowledgement must not be converted into a CHECK plan because
  // acknowledgement is conversation, not an instruction to create a case.
  if (intent.acknowledgement && !intent.action && !intent.repair && !intent.explicitCheck) {
    const c = chatCaseFromSession();
    if (c) return `Baik 😊 Saya tetap di pekerjaan yang sama pada ${normalizeFile(c.exactSource?.file || c.target)}. Kalau ada arahan baru, sampaikan saja.`;
    return 'Baik 😊. Saya siap menerima instruksi berikutnya.';
  }

  // A correction that explicitly names a file is not merely conversational
  // feedback. It is a target correction and must be resolved BEFORE the generic
  // correction branch below. Otherwise a previous telemetry/chat case (often
  // index.html) can win and the human's corrected target is ignored.
  if ((intent.correction || intent.feedback) && explicitRequestedFile) {
    const correctedTarget = explicitRequestedFile;
    const correctedKnown = fileKnownToBCGO(correctedTarget, state);
    if (!correctedKnown) {
      const available = chatSourceFiles(state);
      const stem = correctedTarget.replace(/\.[^.]+$/, '').toLowerCase();
      const nearest = available.find(f => normalizeFile(f).replace(/\.[^.]+$/, '').toLowerCase() === stem);
      setChatSession({
        primaryFile:null, files:[], caseId:null, clarificationNeeded:true,
        pendingWork:newPlan || chatSession.pendingWork,
        pendingCommand:newPlan?.actions?.includes('REPAIR') ? 'REPAIR' : (newPlan ? 'INVESTIGATE' : chatSession.pendingCommand),
        intent:newPlan?.actions?.includes('REPAIR') ? 'REPAIR' : (newPlan ? 'INVESTIGATE' : chatSession.intent)
      });
      return nearest
        ? `Baik, saya pahami koreksinya: yang kamu maksud ${correctedTarget}. File itu belum ada pada source/ORGAN_REGISTRY BCGO yang sedang terbaca. Saya tidak akan kembali ke target lama. Yang tersedia dengan nama dasar yang sama adalah ${normalizeFile(nearest)}. Kalau itu yang dimaksud, saya lanjut dari sana.`
        : `Baik, saya pahami koreksinya: yang kamu maksud ${correctedTarget}. File itu belum ada pada source/ORGAN_REGISTRY BCGO yang sedang terbaca. Saya tidak akan menggantinya dengan target lama. Sebutkan file yang benar atau tambahkan source tersebut.`;
    }

    // Explicit corrected target + work verb = execute the corrected work path,
    // not the generic feedback path. The conversation remains continuous, but
    // the work target is now the file explicitly named by the human.
    if (newPlan && chatPlanNeedsTarget(newPlan)) {
      switchConversationTarget(correctedTarget);
      const correctedFiles = requestedChatFiles(raw, state);
      const files = correctedFiles.length ? correctedFiles : [correctedTarget];
      const cmp = files.length > 1;
      lastChatContext = {files, comparison:cmp, question:raw, stateRevision:stateRevisionOf(state)};
      const c = scheduleChatInvestigation(correctedTarget, state, raw, lastChatContext);
      if (!c) return `Saya menangkap koreksinya, tetapi belum bisa membuka ${correctedTarget}.`;
      setChatSession({
        caseId:c.caseId,
        primaryFile:correctedTarget,
        files,
        comparison:cmp,
        intent:newPlan.actions.includes('REPAIR') ? 'REPAIR' : 'INVESTIGATE',
        pendingCommand:newPlan.actions.includes('REPAIR') ? 'REPAIR' : null,
        pendingWork:newPlan,
        clarificationNeeded:false
      });
      if (newPlan.actions.includes('REPAIR')) setPendingRepair(c.caseId, correctedTarget, raw, lastChatContext);
      return `Iya, sekarang saya sudah menangkap koreksinya dengan benar. Saya pegang ${correctedTarget}, bukan target sebelumnya. Saya mulai menelusuri source aktual, dependency, dan evidence untuk file itu sekarang.`;
    }

    // Pure target correction: remember the explicit file, but do not attach the
    // conversation to an older case for that file. A correction changes human
    // intent; it must not resurrect stale evidence/proof from a previous work
    // session. A later explicit work command will create a fresh case.
    const previousCase = chatSession.caseId;
    if (previousCase) clearPendingRepair(previousCase);
    lastChatContext = {files:[correctedTarget], comparison:false, question:raw, stateRevision:stateRevisionOf(state)};
    setChatSession({
      primaryFile:correctedTarget, files:[correctedTarget], comparison:false,
      caseId:null, intent:null, pendingCommand:null, pendingWork:null,
      clarificationNeeded:false, lastCaseRevision:null
    });
    return `Baik, sekarang saya paham. Yang kamu maksud adalah ${correctedTarget}. Saya pegang target itu sebagai konteks baru dan tidak membawa evidence atau case lama ke target tersebut.`;
  }

  // A short follow-up must stay attached to the current conversation. It must
  // never accidentally downgrade a comparison case into a single-file check.
  const contextualFiles = mentionedFiles.length
    ? mentionedFiles
    : (intent.followUp || intent.result || intent.continuation || intent.repair)
      ? (chatSession.files?.length ? chatSession.files : [chatSession.primaryFile].filter(Boolean))
      : [];
  const effectiveFile = chatFile || chatSession.primaryFile || contextualFiles[0] || null;
  const explicitTargetIsUnknown = !!explicitRequestedFile && unknownExplicitFiles.some(f => f.toLowerCase() === explicitRequestedFile.toLowerCase());
  const comparison = contextualFiles.length > 1
    ? true
    : chatSession.comparison === true;

  setChatSession({
    turn: chatSession.turn,
    lastUserText: raw,
    primaryFile: effectiveFile || chatSession.primaryFile,
    files: contextualFiles.length ? contextualFiles : chatSession.files,
    comparison,
    intent: intent.cancel ? chatSession.intent : (isSystemStatusQuestion(q) && !intent.repair) ? chatSession.intent : intent.repair ? 'REPAIR' : intent.explicitCheck ? 'INVESTIGATE' : (intent.continuation ? (chatSession.intent || 'CONTINUE') : chatSession.intent),
    pendingCommand: intent.cancel ? null : intent.repair ? 'REPAIR' : chatSession.pendingCommand,
    pendingWork: intent.cancel ? null : (newPlan || chatSession.pendingWork),
    clarificationNeeded: newPlan ? false : chatSession.clarificationNeeded,
    dialogueMode: intent.dialogue?.mode || chatSession.dialogueMode || "IDLE",
    topic: intent.dialogue?.topic || chatSession.topic || null,
    tone: "WARM"
  });

  if (!q) return 'Saya di sini. Ceritakan apa yang ingin kamu periksa atau kerjakan.';
  if (intent.cancel) return cancelChatWork();

  // Pure conversation is answered by CGO's conversational layer. Work commands
  // remain higher priority, so a warm phrase never creates or hijacks a case.
  const conversational = conversationalAnswer(intent.dialogue, state, chatSession);
  if (conversational && !newPlan && !intent.explicitCheck && !intent.repair && !intent.continuation && !intent.correction && !intent.feedback) {
    setChatSession({
      dialogueMode:intent.dialogue.mode || 'CONVERSATION',
      topic:intent.dialogue.topic || chatSession.topic,
      tone:'WARM'
    });
    return conversational;
  }

  // Never replace an explicit human filename with telemetry or a previous
  // conversation target. If the filename is unknown to the live source
  // surface, say so plainly and offer the nearest registered candidate when
  // there is an obvious basename typo (for example bcgo-engine.html vs
  // bcgo-engine.js). This is a target-integrity gate, not a generic fallback.
  if (explicitTargetIsUnknown && newPlan && chatPlanNeedsTarget(newPlan)) {
    const requested = explicitRequestedFile;
    switchConversationTarget(requested);
    // Explicitly unknown target means the previous work target is no longer
    // authoritative for this conversation turn. Do not leave a stale case or
    // pending repair capable of being resumed by a later short message.
    const available = chatSourceFiles(state);
    const stem = requested.replace(/\.[^.]+$/, '').toLowerCase();
    const nearest = available.find(f => normalizeFile(f).replace(/\.[^.]+$/, '').toLowerCase() === stem);
    setChatSession({
      pendingWork:newPlan,
      clarificationNeeded:true,
      primaryFile:null,
      files:[],
      caseId:null,
      pendingCommand:newPlan.actions.includes('REPAIR') ? 'REPAIR' : null,
      intent:newPlan.actions.includes('REPAIR') ? 'REPAIR' : 'INVESTIGATE'
    });
    return nearest
      ? `Saya menangkap target yang kamu sebut: ${requested}. Tetapi file itu belum ada pada source/ORGAN_REGISTRY BCGO yang sedang terbaca, jadi saya tidak akan menggantinya diam-diam dengan file lain. Yang terdaftar dengan nama dasar yang sama adalah ${normalizeFile(nearest)}. Kalau itu yang kamu maksud, katakan saja dan saya lanjutkan penelusurannya.`
      : `Saya menangkap target yang kamu sebut: ${requested}. Tetapi file itu belum ada pada source/ORGAN_REGISTRY BCGO yang sedang terbaca. Saya tidak akan menebak atau menggantinya dengan file lain. Sebutkan file yang benar atau tambahkan file tersebut ke source BCGO.`;
  }

  // If the previous turn asked the human to identify an ambiguous target, a
  // file name in the next turn is treated as the answer to that clarification,
  // not as a request for a passive status report.
  if (mentionedFiles.length && chatSession.pendingWork && chatSession.clarificationNeeded) {
    const files = mentionedFiles;
    const plan = chatSession.pendingWork;
    const cmp = files.length > 1;
    lastChatContext = {files, comparison:cmp, question:plan.originalRequest || raw, stateRevision:stateRevisionOf(state)};
    const c = scheduleChatInvestigation(files[0], state, plan.originalRequest || raw, lastChatContext);
    if (c) {
      setChatSession({caseId:c.caseId, primaryFile:files[0], files, comparison:cmp, intent:plan.actions.includes('REPAIR') ? 'REPAIR' : 'INVESTIGATE', pendingCommand:plan.actions.includes('REPAIR') ? 'REPAIR' : null, pendingWork:plan, clarificationNeeded:false});
      if (plan.actions.includes('REPAIR')) setPendingRepair(c.caseId, files[0], plan.originalRequest || raw, lastChatContext);
      return naturalPlanAck(plan, files[0]);
    }
  }

  // Corrections and quality feedback belong to the current dialogue turn.
  // They must never fall through to the generic answer or create another case.
  if (intent.correction || intent.feedback) {
    const c = chatCaseFromSession();
    const current = c ? normalizeFile(c.exactSource?.file || c.target) : null;
    const previous = lastChatAssistantText();
    if (current) {
      const working = activeRuns.has(c.caseId) || pendingRepairIntents.has(c.caseId);
      return working
        ? `Iya, saya tangkap. Jawaban saya tadi belum mengenai maksudmu. Saya tidak akan membuat case baru atau mengulang dari nol. Saya tetap pegang ${current} dan pekerjaan yang sedang berjalan; koreksi saja bagian yang kamu maksud, nanti saya arahkan penelusurannya dari konteks yang sama.`
        : `Iya, saya tangkap. Jawaban saya tadi belum tepat. Saya tetap pegang konteks ${current}; saya tidak akan menebak atau mengubah source. Koreksi bagian yang kamu maksud, dan saya sesuaikan pekerjaan dari case yang sama.`;
    }
    if (previous) return 'Iya, saya tangkap. Jawaban saya tadi belum sesuai dengan maksudmu. Saya tidak akan memaksakan jawaban itu. Jelaskan koreksinya dengan bahasa biasa, dan saya akan mengikuti maksudmu.';
    return 'Iya, saya tangkap. Berarti saya belum menangkap maksudmu dengan benar. Koreksi saja arah atau bagian yang dimaksud; saya akan menyesuaikannya.';
  }

  // Informational questions that happen to contain a work verb (for example
  // "cek status sistem") are not source-work commands. Do not ask for a
  // file target unless the human actually requested source investigation.
  const informationalSystemQuestion = isSystemStatusQuestion(q) && !intent.repair;

  // Work requests are first-class commands. Resolve a human target before
  // creating a case; BCGO telemetry can inform investigation, but it cannot
  // impersonate the human's omitted target.
  if (newPlan && !effectiveFile && chatPlanNeedsTarget(newPlan) && !informationalSystemQuestion) {
    setChatSession({pendingWork:newPlan, clarificationNeeded:true, intent:newPlan.actions.includes('REPAIR') ? 'REPAIR' : 'INVESTIGATE', pendingCommand:newPlan.actions.includes('REPAIR') ? 'REPAIR' : null});
    return clarificationForMissingTarget(newPlan);
  }

  if (intent.presence) {
    const c = chatCaseFromSession();
    if (!c) return 'Iya, saya di sini 😊. Saya membaca keadaan BCGO yang sedang hidup. Katakan saja apa yang ingin kita cek atau kerjakan.';
    return `Iya, saya di sini 😊. Saya masih memegang pekerjaan ${normalizeFile(c.exactSource?.file || c.target)}. Saya belum melepas konteksnya dan akan mengikuti instruksi berikutnya dari case yang sama.`;
  }

  // A repair request that refers back to the active case is an action on that
  // existing case, not a fresh investigation request. This gate must run before
  // the generic CHECK/INVESTIGATE branch so proof is not invalidated by a new
  // CHAT_REQUEST when the human says “perbaiki bagian itu”.
  if (intent.repair && chatSession.caseId && (!explicitRequestedFile || intent.followUp)) {
    const current = chatCaseFromSession();
    const currentTarget = normalizeFile(current?.exactSource?.file || current?.target || chatSession.primaryFile);
    const target = effectiveFile || currentTarget;
    if (current && target && (!explicitRequestedFile || normalizeFile(explicitRequestedFile).toLowerCase() === String(currentTarget || '').toLowerCase())) {
      const result = repairChatCase(target, state, raw);
      const c = result?.caseId ? runtime.getCase(result.caseId) : current;
      setChatSession({
        caseId:c?.caseId || current.caseId,
        primaryFile:normalizeFile(c?.exactSource?.file || c?.target || target),
        files:contextualFiles.length ? contextualFiles : chatSession.files,
        comparison:comparison || chatSession.comparison,
        pendingCommand:'REPAIR', intent:'REPAIR', lastCaseRevision:c?.revision ?? chatSession.lastCaseRevision
      });
      if (result && typeof result === 'object') return result.text;
      return String(result || 'Perintah perbaikan diterima dan tetap saya pegang.');
    }
  }

  // A follow-up check such as “cek yang itu” refers to the current work when
  // the target is already the active conversational case. It must not mint a
  // duplicate case or duplicate CHAT_REQUEST evidence.
  if (newPlan && intent.followUp && intent.explicitCheck && chatSession.caseId && effectiveFile) {
    const current = chatCaseFromSession();
    const currentTarget = normalizeFile(current?.exactSource?.file || current?.target || chatSession.primaryFile);
    if (current && currentTarget && currentTarget.toLowerCase() === normalizeFile(effectiveFile).toLowerCase()) {
      if (!activeRuns.has(current.caseId)) void runActiveInvestigation(current.caseId, state).catch(()=>{});
      setChatSession({caseId:current.caseId, primaryFile:currentTarget, files:chatSession.files?.length ? chatSession.files : [currentTarget], intent:chatSession.intent || 'INVESTIGATE', pendingCommand:chatSession.pendingCommand, pendingWork:chatSession.pendingWork});
      return `Baik, saya cek lagi ${currentTarget} dari case yang sama. Saya tidak membuat case baru; saya lanjutkan dari evidence dan source terbaru.`;
    }
  }

  if (newPlan && effectiveFile && (newPlan.actions.includes('CHECK') || newPlan.actions.includes('INVESTIGATE'))) {
    lastChatContext = {files:contextualFiles.length ? contextualFiles : [effectiveFile], comparison:comparison || contextualFiles.length > 1, question:raw, stateRevision:stateRevisionOf(state)};
    const c = scheduleChatInvestigation(effectiveFile, state, raw, lastChatContext);
    if (!c) return `Saya belum bisa membuka target ${effectiveFile}.`;
    setChatSession({caseId:c.caseId, primaryFile:effectiveFile, files:lastChatContext.files, comparison:lastChatContext.comparison, intent:newPlan.actions.includes('REPAIR') ? 'REPAIR' : 'INVESTIGATE', pendingCommand:newPlan.actions.includes('REPAIR') ? 'REPAIR' : null, pendingWork:newPlan});
    if (newPlan.actions.includes('REPAIR')) setPendingRepair(c.caseId, effectiveFile, raw, lastChatContext);
    if (lastChatContext.comparison && lastChatContext.files.length > 1) {
      const peers = lastChatContext.files.filter(f => f !== effectiveFile);
      return newPlan.actions.includes('REPAIR')
        ? `Baik, saya pegang ${lastChatContext.files.join(' dan ')} sebagai satu pekerjaan perbandingan. Saya telusuri source aktual, dependency, evidence, dan mismatch yang terbukti; bila memang ada masalah dan solusi konkretnya siap, barulah perintah perbaikannya saya lanjutkan.`
        : `Baik, saya pegang ${lastChatContext.files.join(' dan ')} sebagai satu pekerjaan perbandingan. Saya cocokkan source aktual, dependency, hubungan, dan evidence-nya. Saya tidak akan menganggap salah satu file sebagai acuan hanya karena disebut lebih dulu.`;
    }
    return naturalPlanAck(newPlan, effectiveFile);
  }

  // Result/progress questions have priority over "check" words. This prevents
  // phrases such as "bagaimana hasil cek yang tadi?" from spawning a new case.
  if (intent.result || intent.contextualStatusOnly || (intent.followUp && chatSession.caseId && !intent.repair && !intent.explicitCheck)) {
    const c = chatCaseFromSession();
    if (!c && chatRestoration.restored && chatSession.primaryFile) {
      return `Konteks percakapan saya masih ingat: kita terakhir membahas ${normalizeFile(chatSession.primaryFile)}. Karena halaman sempat dimuat ulang, case runtime dan proof lama tidak saya anggap sah lagi. Kalau kamu ingin saya lanjutkan, saya akan buka case baru lalu verifikasi ulang source dan evidence terbaru.`;
    }
    return chatCaseStatusText(c);
  }

  // Repair has priority over check/continue because a sentence may naturally
  // contain both: "cek lagi lalu perbaiki bagian itu".
  if (intent.repair || (intent.continuation && chatSession.pendingCommand === 'REPAIR')) {
    const targetFile = effectiveFile || chatSession.primaryFile || null;
    if (!targetFile) return 'Saya siap memperbaiki, tetapi targetnya belum cukup jelas. Sebutkan file atau bagian yang dimaksud.';
    const result = repairChatCase(targetFile, state, raw);
    const c = result?.caseId ? runtime.getCase(result.caseId) : chatCaseFromSession();
    setChatSession({
      caseId:result?.caseId || c?.caseId || chatSession.caseId,
      primaryFile:normalizeFile(c?.exactSource?.file || c?.target || targetFile),
      files:contextualFiles.length ? contextualFiles : chatSession.files,
      comparison:comparison || chatSession.comparison,
      pendingCommand:'REPAIR', intent:'REPAIR', lastCaseRevision:c?.revision ?? null
    });
    if (result && typeof result === 'object') {
      if (intent.continuation && !intent.repair && result.text?.startsWith('Saya terima perintah')) {
        return `Baik. Saya lanjutkan perintah perbaikan yang tadi dari case yang sama. ${result.text.replace(/^Saya terima perintah perbaikan\.\s*/,'')}`;
      }
      if (lastChatContext.comparison && lastChatContext.files.length > 1 && result.text?.startsWith('Baik. Perintah')) {
        const peers = lastChatContext.files.filter(f => f !== normalizeFile(targetFile));
        result.text = `Baik. Saya lanjutkan perbaikan yang tadi kita bahas. Fokusnya hanya pada mismatch yang sudah terbukti antara ${normalizeFile(targetFile)} dan ${peers.join(' / ')}. Saya tidak akan menyentuh fungsi lain di luar proof.`;
      }
      return result.text;
    }
    return String(result || 'Perintah perbaikan diterima dan tetap saya pegang.');
  }

  if (!informationalSystemQuestion && (intent.explicitCheck || (intent.followUp && effectiveFile && /\b(cek|periksa|lihat|telusuri)\b/.test(q)))) {
    const files = contextualFiles.length ? contextualFiles : [effectiveFile].filter(Boolean);
    lastChatContext = { files, comparison:files.length > 1 || comparison, question:raw, stateRevision:stateRevisionOf(state) };
    const c = scheduleChatInvestigation(effectiveFile, state, raw, lastChatContext);
    if (!c) return `Saya belum bisa membuka target ${effectiveFile || 'tersebut'}.`;
    setChatSession({caseId:c.caseId, primaryFile:effectiveFile, files:lastChatContext.files, comparison:lastChatContext.comparison, intent:'INVESTIGATE', pendingCommand:chatSession.pendingCommand});
    if (lastChatContext.comparison) {
      const peers = lastChatContext.files.filter(f => f !== effectiveFile);
      return `Siap. Saya cek ${effectiveFile} bersama ${peers.join(' dan ')}. Saya mulai dari source aktual, lalu telusuri dependency, hubungan, evidence, dan lokasi masalahnya. Saya belum mengubah source.`;
    }
    return `Siap. Saya mulai cek ${effectiveFile} sekarang. Saya akan mengikuti hasil investigasi; kalau penyebabnya ternyata ada di file lain, saya akan mengikuti source yang terbukti.`;
  }

  if (intent.continuation && chatSession.caseId) {
    const c = chatCaseFromSession();
    if (c) {
      if (!activeRuns.has(c.caseId)) void runActiveInvestigation(c.caseId, state).catch(()=>{});
      return `Baik. Saya lanjutkan pekerjaan ${normalizeFile(c.exactSource?.file || c.target)} dari posisi terakhir. Saya tidak mengulang kesimpulan lama; saya mengikuti evidence terbaru.`;
    }
  }

  if (intent.acknowledgement) {
    const c = chatCaseFromSession();
    if (c) return `Baik 😊 Saya tetap di case yang sama. Kalau maksudmu lanjut bekerja, saya teruskan dari evidence terakhir.`;
    return 'Baik 😊. Saya siap. Beri instruksi berikutnya dan saya akan mengikutinya.';
  }

  if (intent.greeting) {
    const cycle = Number(state?.cycle);
    return Number.isFinite(cycle)
      ? `Halo 😊 Saya di sini. BCGO sedang berjalan di cycle #${cycle}, tahap ${state?.step || '-'}. Ada yang ingin kamu cek atau saya kerjakan?`
      : 'Halo 😊 Saya di sini. BCGO sedang berjalan dan saya siap menerima instruksi.';
  }
  if (/\b(aman|sehat|normal|kondisi sistem|status sistem|sistem aman)\b/.test(q)) {
    if (state?.connection?.status === 'OFFLINE' || state?.firestore?.error) return `Untuk sekarang saya belum mau bilang aman. Koneksi sistem sedang ${state.connection?.status || 'bermasalah'}, jadi saya mempertahankan state terakhir.`;
    if (active.length) return `Sistem hidup dan telemetry masuk, tetapi belum sepenuhnya aman. Saya melihat ${active.length} anomaly aktif: ${active.slice(0,4).map(([f])=>f).join(', ')}.`;
    return `Saat ini tidak ada anomaly aktif pada telemetry yang saya terima. Ada ${metrics.healthy ?? 0} file stabil dan ${review.length} file yang masih perlu review.`;
  }
  if (/\b(sedang apa|lagi apa|sedang mengerjakan|ngapain|kerja apa)\b/.test(q)) {
    const c = chatCaseFromSession();
    if (c) return chatCaseStatusText(c);
    return `Saya sedang memantau telemetry live. Belum ada case percakapan yang sedang saya kerjakan; kalau kamu memberi instruksi, saya akan membuat pekerjaan dari target yang kamu sebutkan dan menelusurinya dengan evidence.`;
  }
  if (/\b(hubungan|terhubung|relasi|dependency|terkait)\b/.test(q)) {
    const file = requestedFile || chatSession.primaryFile || null;
    if (file) {
      const rel = relations.filter(r => normalizeFile(r?.sourceFile||r?.from||r?.file)===file || normalizeFile(r?.targetFile||r?.to||r?.relatedFile)===file);
      if (!rel.length) return `Saya sudah mencari relasi untuk ${file}, tetapi belum ada hubungan source yang cukup kuat untuk saya nyatakan.`;
      return `Untuk ${file}, saya menemukan ${rel.length} relasi yang tercatat di scanner: ${rel.slice(0,6).map(r=>`${normalizeFile(r.sourceFile||r.from||r.file)||'?'} × ${normalizeFile(r.targetFile||r.to||r.relatedFile)||'?'} [${r.status||'OBSERVED'}]`).join('; ')}.`;
    }
    return `Saat ini scanner mencatat ${relations.length} relasi antar-file. Sebutkan file yang ingin kamu telusuri, dan saya ikuti dependency-nya.`;
  }
  if (/\b(apa saja|ada apa saja|isi sistem|isi dari sistem|file apa saja|daftar file|daftar sistem|komponen sistem|organ sistem)\b/.test(q) && !intent.explicitCheck && !intent.repair) {
    const entries = Object.entries(organs);
    if (!entries.length) return `Saya belum menerima daftar organ dari BCGO. Saya tidak akan mengarang isi sistem sebelum registry live terbaca.`;
    const shown = entries.slice(0, 14).map(([file, info]) => `${file} [${info?.state || info?.status || 'UNKNOWN'}]`);
    const more = entries.length > shown.length ? ` dan ${entries.length - shown.length} lainnya` : '';
    return `Saat ini BCGO mengirim ${entries.length} organ/komponen ke saya: ${shown.join('; ')}${more}. Status tersebut berasal dari state live BCGO, bukan tebakan. Kalau kamu mau, aku bisa lanjut jelaskan mana yang aktif, bermasalah, standby, atau saling terhubung.`;
  }

  if (requestedFile) {
    const info = organs[requestedFile];
    if (!info) return `Saya mengenali ${requestedFile}, tetapi snapshot live belum membawa status file itu.`;
    return `Oke, ${requestedFile} sekarang berstatus ${info.state || 'UNKNOWN'}. ${info.message || ''}`.trim();
  }
  if (/\b(error|masalah|anomaly|gangguan|rusak)\b/.test(q)) {
    if (!active.length) return `Saat ini saya tidak melihat anomaly aktif. Saya tetap mendengarkan telemetry baru.`;
    return `Iya, ada ${active.length} anomaly aktif. Yang terlihat sekarang ${active.slice(0,4).map(([f,v])=>`${f}: ${v.message || 'temuan aktif'}`).join(' | ')}. Saya belum menyebut root cause sebelum terbukti.`;
  }
  if (/\b(root cause|akar masalah|penyebab|kenapa|mengapa)\b/.test(q)) {
    const c = chatCaseFromSession();
    if (c?.rootCause) return `Untuk ${normalizeFile(c.exactSource?.file || c.target)}, root cause yang sudah masuk proof chain adalah: ${c.rootCause.statement}`;
    return `Saya belum mau menyebut root cause. Yang ada sekarang masih evidence/hipotesis; saya akan menaikkannya menjadi root cause hanya setelah causal proof terpenuhi.`;
  }
  if (/\b(bukti|evidence|telemetry)\b/.test(q)) {
    const evidence = Array.isArray(chatCaseFromSession()?.evidence) ? chatCaseFromSession().evidence : (Array.isArray(snapshot?.reasoning?.evidence) ? snapshot.reasoning.evidence : []);
    const verified = evidence.filter(e=>e?.status==='VERIFIED');
    return `Saat ini saya punya ${verified.length} evidence terverifikasi dari ${evidence.length} evidence pada konteks yang sedang aktif. Saya akan memakai bukti itu sebagai dasar keputusan.`;
  }

  // When the user speaks naturally but there is an active case, answer from the
  // case instead of falling back to a generic "I understand" sentence. This is
  // the conversational hand-off between the human dialogue and the investigation brain.
  if (chatSession.caseId && chatSession.hasWorkContext !== false) {
    const c = chatCaseFromSession();
    if (c) {
      const file = normalizeFile(c.exactSource?.file || c.target) || 'target';
      if (intent.question || intent.action || intent.followUp) {
        return `Saya menangkapnya. Konteks yang sedang kita pegang adalah ${file}. Saya tidak akan membuat kesimpulan baru hanya dari kalimat ini; saya akan menghubungkannya ke evidence dan hasil investigasi case yang sama. Kalau yang kamu maksud adalah bagian tertentu, sebutkan bagian itu dan saya lanjutkan dari sana.`;
      }
      return `Saya masih memegang konteks ${file}. Kamu tidak perlu mengulang dari awal; lanjutkan saja dengan bahasa biasa, dan saya akan mengaitkan pesanmu ke pekerjaan yang sedang berjalan.`;
    }
  }
  if (intent.question) {
    const c = chatCaseFromSession();
    if (c) return `Saya menangkap pertanyaannya. Konteks yang sedang aktif adalah ${normalizeFile(c.exactSource?.file || c.target) || 'case ini'}, jadi saya akan menjawab berdasarkan pekerjaan dan evidence yang sudah ada, bukan jawaban umum. Kalau ada bagian yang ingin kamu arahkan, sebutkan saja.`;
    return 'Saya menangkap pertanyaannya, tetapi konteksnya belum cukup untuk menjawab dengan presisi. Sebutkan file, bagian, atau pekerjaan yang kamu maksud agar saya tidak menebak.';
  }
  return 'Saya dengar. Bicara saja seperti biasa. Saya akan membedakan mana obrolan, mana pertanyaan, dan mana instruksi kerja; ketika masuk pekerjaan teknis, saya ikat ke case, source, dependency, dan evidence yang nyata.';
}

// Restore dialogue context once per bridge boot. This is intentionally performed
// before install() so the UI can render history even when no live case exists yet.
restoreChatMemory();

function compatibleSnapshot(caseId, signal = "LIVE_TELEMETRY", caseOverride = null) {
  const c = caseOverride || runtime.getCase(caseId);
  if (!c) {
    return {
      version: VERSION, signal, at: Date.now(),
      reasoning: {
        classification: "INSUFFICIENT_EVIDENCE",
        evidence: [], hypotheses: [], selectedHypothesisId: null,
        precisionGate: { pass: false, blockers: ["NO_ACTIVE_CASE"] },
        investigation: { status: "BLOCKED", nextEvidence: null },
        operationalInvestigation: { status: "BLOCKED", evidenceRequests: [] },
        causalLinks: []
      },
      guardian: { healthy: false, level: "BLOCKED", issues: ["NO_ACTIVE_CASE"] }
    };
  }

  const evaluation = Logic.evaluate(c, INTERNAL_AUTO_POLICY, knowledge);
  const active = activeEngines.get(caseId);
  const investigation = active ? active.snapshot() : Investigator.createInvestigation(c, knowledge);
  const probe = active && active.state.status === "ACTIVE"
    ? (active.state.probeLog.at(-1) || Investigator.nextProbe(investigation, c, knowledge))
    : Investigator.nextProbe(investigation, c, knowledge);
  const conversation = {
    mode: Cognition.dialogueMode({ text: chatSession.lastUserText || "", workContext: !!chatSession.caseId }),
    dialogueMode: chatSession.dialogueMode || "IDLE",
    topic: chatSession.topic || null
  };
  const deliberate = Cognition.deliberate({
    evidence: c.evidence,
    rootCause: c.rootCause,
    exactSource: c.exactSource,
    contradictions: Core.detectContradictions(c.evidence),
    proofComplete: evaluation.proof.complete
  });

  const blockers = [];
  if (!evaluation.proof.complete) blockers.push("PROOF_CHAIN_INCOMPLETE");
  if (evaluation.proof.unresolved) blockers.push("UNVERIFIED_EVIDENCE_PRESENT");
  if (evaluation.proof.contradictory) blockers.push("CONTRADICTORY_EVIDENCE");
  if (!evaluation.proof.rootCauseVerified) blockers.push("ROOT_CAUSE_NOT_VERIFIED");
  if (!evaluation.proof.sourceVerified) blockers.push("EXACT_SOURCE_NOT_VERIFIED");

  const liveState = getLiveBCGOState();
  return {
    version: VERSION,
    brainVersion: Core.VERSION,
    logicVersion: Logic.VERSION,
    cognitionVersion: Cognition.VERSION,
    guardianVersion: evaluation.guardian?.policyVersion || "1",
    signal,
    at: Date.now(),
    bcgoState: {
      cycle: liveState?.cycle ?? null,
      step: liveState?.step || null,
      cycleMode: liveState?.cycleMode || null,
      lastEventAt: liveState?.lastEventAt || null,
      sourceScanCompletedAt: liveState?.sourceScan?.completedAt || null,
      stateRevision: stateRevisionOf(liveState),
      stateAgeMs: (() => { const rev = stateRevisionOf(liveState); return rev > 0 ? Math.max(0, Date.now() - rev) : null; })()
    },
    reasoning: {
      classification: deliberate.conclusion,
      evidence: c.evidence.map(e => ({
        id: e.id, claim: e.claim, source: e.source, exact: e.exact, status: e.status
      })),
      hypotheses: c.hypotheses || [],
      selectedHypothesisId: c.selectedHypothesis?.id || null,
      correlations: {
        independentEvidenceCount: new Set(c.evidence.map(e => e.source || e.type || e.id)).size
      },
      precisionGate: { pass: evaluation.proof.complete, blockers: blockers.slice(0,20) },
      investigation: {
        status: c.state,
        nextEvidence: probe,
        nextProbe: probe
      },
      operationalInvestigation: {
        status: c.state,
        evidenceRequests: probe ? [probe] : []
      },
      causalLinks: c.rootCause ? [{
        hypothesisId: c.rootCause.hypothesisId,
        evidenceIds: c.rootCause.evidenceIds
      }] : []
    },
    conversation,
    guardian: {
      healthy: evaluation.guardian?.decision !== "BLOCKED",
      level: evaluation.guardian?.risk || "UNKNOWN",
      issues: evaluation.guardian?.reason ? [evaluation.guardian.reason] : []
    }
  };
}

export function getCGOInstruction() { return Instruction.getInstruction(); }

export function install() {
  return {
    version: VERSION,
    ingestBCGOState(state = {}) {
      // BCGO_STATE is authoritative. Each intake replaces the previous bridge
      // snapshot; chat never treats an older investigation snapshot as live state.
      latestBCGOState = clone(state);
      ensureKnowledge(state);
      const active = Array.isArray(state.activeCases) ? state.activeCases : [];
      let primary = null;
      for (const item of active) {
        try {
          const c = upsertBCGOCase(item, state);
          if (!primary) primary = c;
        } catch {}
      }
      if (!primary && state.lastTelemetryFile) {
        primary = upsertBCGOCase({
          id: `BCGO-${normalizeFile(state.lastTelemetryFile)}`,
          target: normalizeFile(state.lastTelemetryFile),
          severity: "UNKNOWN",
          evidence: {
            fileName: normalizeFile(state.lastTelemetryFile),
            message: state.lastTelemetryMessage || "Telemetry aktif.",
            reportedAt: state.lastTelemetryAt || now()
          }
        }, state);
      }
      latest = compatibleSnapshot(primary?.caseId, primary ? "LIVE_TELEMETRY" : "NO_ACTIVE_CASE");
      try { window.dispatchEvent(new CustomEvent("cikur-internal-ai-state", { detail: latest })); } catch {}
      if (primary?.caseId) {
        // Fire-and-progress: the bridge remains responsive while CGO performs its
        // internal source probes asynchronously. No external service is called.
        runActiveInvestigation(primary.caseId, state).catch(()=>{});
      }
      try { window.dispatchEvent(new CustomEvent("cikur-internal-ai-guardian", { detail: latest.guardian })); } catch {}
      return clone(latest);
    },
    getSnapshot() { return clone(latest); },
    getBCGOState() { return getLiveBCGOState(); },
    ask(question) {
      const raw = typeof question === 'string' ? question : String(question?.text || question?.question || '');
      const answer = chatAnswer(question);
      recordChatTurn('user', raw, {caseId:chatSession.caseId, turn:chatSession.turn});
      recordChatTurn('bcgo', answer, {caseId:chatSession.caseId, turn:chatSession.turn});
      return answer;
    },
    getChatCommandStatus() {
      return [...pendingRepairIntents.values()].map(x => clone(x));
    },
    getChatContext() { return clone(chatSession); },
    getChatConversation() { return clone(chatTranscript); },
    getChatRestoration() { return clone(chatRestoration); },
    clearChatMemory() {
      const storage = safeStorage();
      try { storage?.removeItem(CHAT_MEMORY_KEY); } catch {}
      chatTranscript = [];
      chatRestoration = { restored:false, restoredAt:0, context:false, staleCaseDiscarded:false };
      chatSession = { turn:0, lastUserText:null, primaryFile:null, files:[], comparison:false, caseId:null, intent:null, pendingCommand:null, lastCaseRevision:null, updatedAt:Date.now(), pendingWork:null, clarificationNeeded:false, restoredCaseId:null, restoredAt:0, dialogueMode:"IDLE", topic:null, tone:"WARM", address:null };
      lastChatContext = { files:[], comparison:false, question:null, stateRevision:null };
      return true;
    },
    async acceptRepairProposal(caseId, proposal = {}) {
      const current = runtime.getCase(caseId);
      if (!current) throw new Error("CASE_NOT_FOUND");
      if (!current.rootCause || !current.exactSource) throw new Error("PROOF_CHAIN_INCOMPLETE");
      const file = normalizeFile(proposal.file || proposal.targetFile || current.exactSource.file);
      if (!file || file !== normalizeFile(current.exactSource.file)) throw new Error("REPAIR_SOURCE_TARGET_MISMATCH");
      const provider = createInternalProbeProvider(getLiveBCGOState());
      const live = await provider.readSource(file);
      const originalCode = String(proposal.before ?? proposal.originalCode ?? current.exactSource.originalCode ?? "");
      const proposedCode = String(proposal.after ?? proposal.proposedCode ?? "");
      if (!originalCode.trim() || !proposedCode.trim()) throw new Error("CONCRETE_SOLUTION_REQUIRED");
      if (!String(live.source).includes(originalCode)) throw new Error("REPAIR_ORIGINAL_CODE_NOT_PRESENT");
      const sourceFingerprint = live.fingerprint || Core.contentFingerprint(live.source);
      if (proposal.sourceFingerprint && proposal.sourceFingerprint !== sourceFingerprint) throw new Error("REPAIR_SOURCE_FINGERPRINT_MISMATCH");
      const verified = runtime.proveSource(caseId, {
        file, originalCode, proposedCode, operation: proposal.operation || "REPLACE_EXACT",
        fingerprint: Core.contentFingerprint(originalCode), contentFingerprint: Core.contentFingerprint(originalCode),
        sourceFingerprint, evidenceIds: current.rootCause.evidenceIds
      });
      emitBrainEvent(caseId, "CHAT_REPAIR_SOLUTION_ACCEPTED", {file, sourceFingerprint, proposedFingerprint:Core.contentFingerprint(proposedCode)});
      const continued = pendingRepairIntents.has(caseId) ? await continuePendingRepair(caseId, getLiveBCGOState()) : null;
      latest = compatibleSnapshot(caseId, "CHAT_REPAIR_SOLUTION_ACCEPTED");
      try { window.dispatchEvent(new CustomEvent("cikur-internal-ai-state", {detail:latest})); } catch {}
      return {caseData:verified, continuation:continued};
    },
    executionStatus() { return { executorAvailable: !!runtime.hasExecutionHand?.(), lastChatCaseId, pendingRepairCases: pendingRepairIntents.size, latest: clone(latest) }; },
    deliberate(caseId, policy = {}) {
      return runtime.deliberate(caseId, policy);
    },
    logic(caseId, policy = {}) {
      return runtime.logic(caseId, policy);
    },
    async investigate(caseId, state = {}, options = {}) {
      if (!caseId) throw new Error("CASE_ID_REQUIRED");
      const current = runtime.getCase(caseId);
      if (!current) throw new Error("CASE_NOT_FOUND");
      const engine = getActiveEngine(caseId, current);
      const provider = createInternalProbeProvider(state);
      const out = await engine.run(current, provider, knowledge, options);
      return clone(out);
    },
    getRuntime() { return runtime; }
  };
}

export function reason(context = {}, history = {}) {
  const evidenceRaw = Array.isArray(context.medicineEvidence) ? context.medicineEvidence : [];
  const target = normalizeFile(context.target);
  const c0 = Core.createCase({
    caseId: `MEDICINE-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
    target,
    symptom: context.errorLog?.message || context.errorLog?.error || context.errorLog || null,
    severity: context.medicinePlan?.severity || "UNKNOWN"
  });

  const evidence = evidenceRaw.map((e, index) => ({
    ...mapEvidence({
      ...e,
      id: e.id || `MED-EV-${index}-${target || "unknown"}`,
      status: ["VERIFIED","UNVERIFIED","CONTRADICTED","REJECTED"].includes(String(e.status || "").toUpperCase())
        ? String(e.status).toUpperCase()
        : "UNVERIFIED",
      exact: !!(e.exact || e.exactLineHit || e.before),
      strength: e.evidenceStrength === "HIGH" ? 1 : e.evidenceStrength === "MEDIUM" ? .65 : .35
    }, "MEDICINE"),
    metadata: {
      file: normalizeFile(e.file || e.sourceFile || target),
      medicineEvidenceStrength: e.evidenceStrength || null,
      evidenceReason: e.evidenceReason || null
    }
  }));

  let c = Core.ingestEvidence(c0, evidence);
  const candidates = Array.isArray(context.medicinePlan?.candidates)
    ? context.medicinePlan.candidates
    : [];
  const hypothesisEvidenceIds = evidence.map(e => e.id);
  const hypotheses = hypothesisEvidenceIds.length ? [{
    id: `H-${target || "CASE"}`,
    statement: String(
      context.medicinePlan?.rootCauseFile ||
      candidates[0]?.reason ||
      "Medicine evidence requires causal verification."
    ),
    evidenceIds: hypothesisEvidenceIds
  }] : [];
  if (hypotheses.length) {
    c = Core.reason(c, hypotheses).caseData;
  }

  if (context.medicinePlan?.rootCauseStatus &&
      ["CONFIRMED_ORIGINAL_TARGET","TARGET_CORRECTED_BY_MEDICINE","CONTRACT_ROOT_CAUSE_IDENTIFIED"].includes(context.medicinePlan.rootCauseStatus) &&
      hypotheses.length) {
    const rootEvidenceIds = evidence.filter(e => e.status === "VERIFIED").map(e => e.id);
    const statement = String(candidates[0]?.reason || context.medicinePlan.rootCauseFile || "Medicine root cause candidate verified.");
    c = Core.verifyRootCause(c, {
      statement,
      hypothesisId: hypotheses[0].id,
      evidenceIds: rootEvidenceIds
    });
  }

  if (context.medicinePlan?.operations?.length && c.rootCause) {
    const op = context.medicinePlan.operations[0];
    const originalCode = String(op.before || "");
    const proposedCode = String(op.after || "");
    if (originalCode && proposedCode) {
      const sourceFile = normalizeFile(op.file || context.medicinePlan.rootCauseFile || target);
      const fp = Core.contentFingerprint(originalCode);
      const sourceFingerprint = op.sourceFingerprint || null;
      try {
        c = Core.verifyExactSource(c, {
          file: sourceFile,
          originalCode,
          proposedCode,
          operation: op.type || "REPLACE_EXACT",
          fingerprint: fp,
          contentFingerprint: fp,
          sourceFingerprint: context.sourceFingerprint || sourceFingerprint || null,
          evidenceIds: c.rootCause.evidenceIds
        });
      } catch {}
    }
  }

  const evaluation = Logic.evaluate(c, INTERNAL_AUTO_POLICY, knowledge);
  const deliberate = Cognition.deliberate({
    evidence: c.evidence,
    rootCause: c.rootCause,
    exactSource: c.exactSource,
    contradictions: Core.detectContradictions(c.evidence),
    proofComplete: evaluation.proof.complete
  });
  const blockers = [];
  if (!evaluation.proof.complete) blockers.push("PROOF_CHAIN_INCOMPLETE");
  if (evaluation.proof.contradictory) blockers.push("CONTRADICTORY_EVIDENCE");
  if (evaluation.proof.unresolved) blockers.push("UNVERIFIED_EVIDENCE_PRESENT");
  if (!evaluation.proof.causalRootVerified) blockers.push("CAUSAL_ROOT_NOT_VERIFIED");
  if (!evaluation.proof.sourceVerified) blockers.push("EXACT_SOURCE_NOT_VERIFIED");
  if (!evaluation.proof.sourceFingerprintBound) blockers.push("SOURCE_FINGERPRINT_REQUIRED");

  const investigation = Investigator.nextProbe(
    Investigator.createInvestigation(c, knowledge), c, knowledge
  );

  const result = {
    version: VERSION,
    classification: deliberate.conclusion,
    evidence: c.evidence,
    hypotheses: c.hypotheses,
    selectedHypothesisId: c.selectedHypothesis?.id || null,
    precisionGate: { pass: evaluation.proof.complete, blockers: [...new Set(blockers)] },
    investigation: {
      status: c.state,
      nextEvidence: investigation,
      nextProbe: investigation
    },
    operationalInvestigation: {
      status: c.state,
      evidenceRequests: investigation ? [investigation] : []
    },
    causalLinks: c.rootCause ? [{
      hypothesisId: c.rootCause.hypothesisId,
      evidenceIds: c.rootCause.evidenceIds
    }] : [],
    correlations: {
      independentEvidenceCount: new Set(c.evidence.map(e => e.source || e.type || e.id)).size
    },
    brainProof: evaluation.proof,
    guardian: evaluation.guardian,
    memory: { advisoryOnly: true, historicalHints: [] }
  };

  latest = clone(result);
  return result;
}

export { VERSION };
