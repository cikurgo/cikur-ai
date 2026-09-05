import {
  collection,
  onSnapshot,
  query,
  orderBy,
  limit,
  addDoc,
  serverTimestamp,
  doc,
  getDoc
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { db, auth } from "./cikur-config.js";
import { reason as internalAIReason } from "./cikur-internal-ai-runtime-adapter-v9.js?v=5.2.5";

/*
 * ================================================================
 * BCGO MEDICINE v3.4.2 + INTERNAL AI V5 BRIDGE — PRECISION DIAGNOSTIC + INTERNAL EXECUTOR BRIDGE
 * ================================================================
 * Boundary:
 *   Medicine observes, investigates, proves, proposes and validates.
 *   It NEVER writes repository source by itself.
 *
 * Flow:
 *   TELEMETRY -> CASE -> DEPENDENCY SURFACE -> ROOT CAUSE
 *   -> EXACT SOURCE -> BEFORE/AFTER -> EXECUTION REVIEW
 *   -> HUMAN APPROVAL -> EXECUTION -> VALIDATION
 *
 * Medicine never writes repository source by itself. Execution Review is a
 * deterministic, non-writing preflight performed by the trusted internal Executor.
 * Actual execution remains locked behind explicit human approval.
 * ================================================================
 */

const BASE_REGISTRY = {
  "index.html":         { type: "Halaman Utama",       role: "customer" },
  "assistant.html":     { type: "Zona Customer",       role: "customer" },
  "food.html":          { type: "Zona Customer",       role: "customer" },
  "ride.html":          { type: "Zona Customer",       role: "customer" },
  "cikurgo2in1.html":   { type: "Zona Customer",       role: "customer" },
  "agentcgo.html":      { type: "Zona Mitra",          role: "mitra" },
  "resto.html":         { type: "Zona Mitra",          role: "restaurant" },
  "driver.html":        { type: "Zona Mitra",          role: "driver" },
  "data-cgo.html":      { type: "Zona Data Sistem",    role: "system-data" },
  "cikur-config.js":    { type: "Sistem Config",       role: "system" },
  "bcgo-engine.js":     { type: "Sistem Core",         role: "system" },
  "bcgo-admin.html":    { type: "Sistem Admin",        role: "admin" },
  "bcgo.html":          { type: "Sistem Monitor",      role: "monitor" },
  "bcgo.js":            { type: "Monitor Core",        role: "monitor" },
  "bcgo-medicine.html": { type: "UI Medicine",         role: "medicine" },
  "bcgo-medicine.js":  { type: "Otak Medicine",       role: "medicine" }
};

const REGISTRY = { ...BASE_REGISTRY };

// Medicine is the examiner, not the patient. Its own UI/engine files are
// excluded from the diagnostic source surface so live scans cannot recursively
// diagnose Medicine itself. They remain known in REGISTRY for metadata/API use.
const MEDICINE_INTERNAL_FILES = new Set([
  "bcgo-medicine.js",
  "bcgo-medicine.html"
]);

const isDiagnosticFile = file => {
  const name = normalizeFile(file);
  return !!name && !MEDICINE_INTERNAL_FILES.has(name);
};

const FIELD_ALIASES = {
  photo: ["photo", "profilePhoto", "fotoProfil", "regPhoto"],
  photoFront: ["photoFront", "fotoFront", "frontPhoto"],
  accountNo: ["accountNo", "accountNumber", "rekening", "nomorRekening"],
  accountNumber: ["accountNumber", "accountNo", "rekening", "nomorRekening"],
  vehicleType: ["vehicleType", "vehicle", "jenisKendaraan"],
  serviceType: ["serviceType", "service", "jenisLayanan"],
  bank: ["bank", "bankName"],
  bankName: ["bankName", "bank"],
  fotoKtp: ["fotoKtp", "ktpPhoto", "photo"],
  socialMedia: ["socialMedia", "instagram", "tiktok", "facebook"]
};

const CONTRACT_FIELDS = new Set([
  "name","phone","address","email","vehicleType","vehicle","serviceType",
  "photo","profilePhoto","fotoProfil","photoFront","photoIndoor","fotoKtp",
  "fotoSim","fotoStnk","ktp","sim","stnk","bank","bankName","accountName",
  "accountNumber","accountNo","businessName","businessType","ownerName",
  "role","village","district","city","province","openTime","closeTime",
  "operationalDays","legalStatus","socialMedia"
]);

const REQUIRED = {
  driver: ["name","phone","address","vehicleType","photo","ktp","sim","bank","accountName","accountNo"],
  assistant: ["name","phone","address","serviceType","ktp","fotoKtp","socialMedia"],
  customer: ["name","phone","email"],
  restaurant: [
    "name","phone","address","businessName","businessType","ownerName","role",
    "village","district","city","province","openTime","closeTime","operationalDays",
    "ktp","legalStatus","bankName","accountName","accountNumber","photoFront"
  ]
};

const RULE_PROBES = [
  "system_logs",
  "medicine_messages",
  "medicine_treatments",
  "medicine_patch_requests",
  "medicine_validations"
];

const ACTIVE_STATUSES = new Set([
  "DIAGNOSED",
  "INVESTIGATING",
  "INVESTIGATION_BLOCKED",
  "VERIFIED_DIAGNOSIS",
  "READY_FOR_PATCH",
  "READY_FOR_HUMAN_APPROVAL",
  "HUMAN_COPY_CONFIRMED",
  "PATCH_PENDING_EXECUTION",
  "PATCH_APPLIED",
  "PATCH_REQUIRES_REVIEW",
  "PATCH_FAILED"
]);

const TERMINAL_STATUSES = new Set(["REJECTED","FIXED_VERIFIED","RECOVERED"]);

const MAX_INVESTIGATION_ATTEMPTS_PER_REVISION = 3;

const S = {
  version: "3.4.2",
  registry: REGISTRY,
  surface: null,
  logs: [],
  cases: [],
  activeCase: null,
  findings: [],
  messages: [],
  listeners: [],
  sourceCache: new Map(),
  patchProposals: [],
  patchRequests: [],
  verification: null,
  validation: null,
  rules: {
    status: "WAITING",
    checkedAt: null,
    collections: {},
    permissionErrors: []
  },
  bcgoSync: {
    status: "WAITING",
    lastAt: 0,
    cycle: 0,
    step: "-",
    active: 0,
    total: 0,
    source: "NONE"
  },
  telemetry: {
    started: false,
    initialized: false,
    lastId: null,
    transport: "NONE"
  },
  human: {
    paused: false,
    mode: "ASSISTED",
    uid: null
  },
  busy: {
    surface: false,
    scan: false,
    verification: false,
    execution: false
  },
  executor: {
    available: false,
    name: null,
    version: null,
    status: "OFFLINE",
    lastEventAt: null,
    persistence: null,
    lastResult: null,
    investigation: null
  },
  aiCore: {
    version: null,
    classification: "WAITING",
    precisionGate: false,
    blockers: [],
    evidenceCount: 0,
    hypothesisCount: 0,
    selectedHypothesisId: null,
    investigation: null,
    lastAt: null
  },
  investigated: new Set(),
  investigationQueue: new Map(),
  bcgoSourceScan: {
    status: "WAITING",
    receivedAt: 0,
    cycle: 0,
    filesScanned: 0,
    filesReadable: 0,
    filesFailed: 0,
    findings: [],
    crossFileFindings: [],
    relations: [],
    sources: {}
  },
  liveSurface: {
    status: "WAITING",
    cycle: 0,
    scanning: false,
    updatedAt: 0,
    results: {},
    relations: [],
    findings: []
  },
  lastBCGOPacketId: null,
  bcgoAIContext: null,
  lastBCGOScanToken: null,
  bcgoIngestingToken: null,
  processedCrossFileEvidence: new Set()
};

const now = () => new Date().toISOString();
const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2,9)}`;
const text = (v, n = 1800) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0,n);
const lower = v => String(v ?? "").toLowerCase();
const escRe = v => String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const MEDICINE_BRIDGE_KEY = "CIKUR_GO_BCGO_MEDICINE_V1";
const MEDICINE_BRIDGE_EVENT_KEY = `${MEDICINE_BRIDGE_KEY}_EVENT`;
const MEDICINE_BRIDGE_LIVE_WINDOW = 15000;
let medicineBridgeChannel = typeof BroadcastChannel !== "undefined"
  ? new BroadcastChannel(MEDICINE_BRIDGE_KEY) : null;
let medicineSequence = 0;
const pendingExecutionReviews = new Map();
const EXECUTION_REVIEW_TIMEOUT = 5000;
const EXECUTION_REVIEW_EVENT_KEY = `${MEDICINE_BRIDGE_KEY}_REPAIR_CANDIDATE`;
const EXECUTION_REVIEW_RESULT_KEY = `${MEDICINE_BRIDGE_KEY}_EXECUTION_REVIEW`;
const EXECUTION_APPROVAL_KEY = `${MEDICINE_BRIDGE_KEY}_EXECUTION_APPROVAL`;
const EXECUTION_RESULT_KEY = `${MEDICINE_BRIDGE_KEY}_EXECUTION_RESULT`;
const seenExecutionResultIds = new Set();
const INVESTIGATION_EVENT_KEY = `${MEDICINE_BRIDGE_KEY}_INVESTIGATION`;
const INVESTIGATION_ACK_KEY = `${MEDICINE_BRIDGE_KEY}_INVESTIGATION_ACK`;

function publishMedicineState(event, data = {}) {
  const packet = {
    id: `MEDICINE-${Date.now()}-${++medicineSequence}-${Math.random().toString(36).slice(2,7)}`,
    bridge: MEDICINE_BRIDGE_KEY,
    from: "MEDICINE",
    type: "MEDICINE_STATE",
    medicineEvent: event,
    at: Date.now(),
    sequence: medicineSequence,
    caseId: data.case?.id || data.caseId || S.activeCase?.id || null,
    message: String(data.message || data.case?.status || event || "").slice(0,500),
    state: {
      status: S.activeCase?.status || "IDLE",
      caseId: S.activeCase?.id || null,
      cycle: S.bcgoSync.cycle,
      step: S.bcgoSync.step,
      active: S.bcgoSync.active,
      total: S.bcgoSync.total
    }
  };
  try { medicineBridgeChannel?.postMessage(packet); } catch {}
  try { localStorage.setItem(MEDICINE_BRIDGE_EVENT_KEY, JSON.stringify(packet)); } catch {}
}

function emit(event, data = {}) {
  window.dispatchEvent(new CustomEvent("bcgo:medicine", {
    detail: { event, at: now(), ...data }
  }));
  if (!String(event).startsWith("bcgo_bridge_")) publishMedicineState(event, data);
}

function publishExecutionCandidate(packet) {
  const message = {
    bridge: MEDICINE_BRIDGE_KEY,
    from: "MEDICINE",
    type: "MEDICINE_REPAIR_CANDIDATE",
    at: Date.now(),
    ...packet
  };
  try { medicineBridgeChannel?.postMessage(message); } catch {}
  try { localStorage.setItem(EXECUTION_REVIEW_EVENT_KEY, JSON.stringify(message)); } catch {}
  return message;
}

function publishInvestigationRequest(c, phase = "INVESTIGATING", extra = {}) {
  if (!c?.id) return null;
  if (!c.investigationSessionId) c.investigationSessionId = `INV-${uid().toUpperCase()}`;
  const message = {
    bridge: MEDICINE_BRIDGE_KEY,
    from: "MEDICINE",
    type: "MEDICINE_INVESTIGATION_REQUEST",
    at: Date.now(),
    investigationId: c.investigationSessionId,
    caseId: c.id,
    phase,
    target: c.source || null,
    symptom: c.signature || null,
    diagnosis: c.diagnosis?.title || null,
    runtimeLocation: c.runtimeLocation || null,
    evidenceCount: Number(c.evidenceCount || 0),
    evidence: c.lastEvidence || c.evidence || null,
    rootCauseFile: c.rootCauseFile || c.repairPlan?.rootCauseFile || null,
    rootCauseStatus: c.rootCauseStatus || c.repairPlan?.rootCauseStatus || "UNPROVEN",
    precisionGate: !!c.repairPlan?.precisionGate,
    decisionStatus: c.investigationDecision?.status || null,
    nextAction: c.investigationDecision?.nextAction || null,
    decisionReason: c.investigationDecision?.reason || null,
    aiDirective: c.investigationDecision?.aiDirective || S.aiCore?.investigation?.nextEvidence || null,
    sourceEvidenceCount: Array.isArray(c.sourceEvidence) ? c.sourceEvidence.length : 0,
    checkedFiles: Array.isArray(c.verification?.checkedFiles) ? c.verification.checkedFiles.length : 0,
    message: String(extra.message || "").slice(0,500),
    sequence: Date.now()
  };
  try { medicineBridgeChannel?.postMessage(message); } catch {}
  try { localStorage.setItem(INVESTIGATION_EVENT_KEY, JSON.stringify(message)); } catch {}
  emit("investigation_channel_sent", { investigation: message });
  return message;
}

function receiveInvestigationAck(packet) {
  if (!packet || packet.bridge !== MEDICINE_BRIDGE_KEY || packet.from !== "EXECUTION" || packet.type !== "EXECUTION_INVESTIGATION_ACK") return false;
  const investigationId = String(packet.investigationId || "").trim();
  if (!investigationId) return false;
  const active = S.activeCase;
  if (active?.investigationSessionId && active.investigationSessionId !== investigationId) return false;
  if (active?.id && packet.caseId && active.id !== packet.caseId) return false;
  S.executor.investigation = packet;
  emit("investigation_ack_received", { investigation: packet });
  return true;
}

function receiveExecutionResult(packet) {
  if (!packet || packet.bridge !== MEDICINE_BRIDGE_KEY || packet.from !== "EXECUTION" || packet.type !== "EXECUTION_RESULT") return false;
  const packetId = String(packet.id || `${packet.requestId || "EXECUTION"}-${packet.at || 0}-${packet.proposalId || ""}`).trim();
  if (seenExecutionResultIds.has(packetId)) return false;
  seenExecutionResultIds.add(packetId);
  if (seenExecutionResultIds.size > 100) seenExecutionResultIds.delete(seenExecutionResultIds.values().next().value);
  const result = packet.result || {};
  const requestId = String(packet.requestId || result.requestId || "").trim();
  const proposalId = String(packet.proposalId || "").trim();
  const c = S.cases.find(x => x.id === packet.caseId);
  if (!c) return false;

  // Never allow a stale/foreign execution result to mutate the current case.
  const expectedRequestId = String(
    c.executionRequestId ||
    c.patchProposal?.executionReview?.requestId ||
    ""
  ).trim();
  const expectedProposalId = String(c.patchProposal?.proposalId || "").trim();
  // A result is proof of one specific approved execution. If the current
  // in-memory case cannot identify that exact request + proposal, fail closed
  // instead of allowing a cached/stale result to mutate the case.
  if (!requestId || !proposalId) return false;
  if (!expectedRequestId || expectedRequestId !== requestId) return false;
  if (!expectedProposalId || expectedProposalId !== proposalId) return false;

  c.executionResult = {...result, requestId, proposalId};
  c.executionResultAt = now();
  if (result.status === "SUCCESS") {
    c.status = "PATCH_APPLIED";
    if (c.patchProposal) c.patchProposal.status = "PATCH_APPLIED";
    emit("execution_result_received", {result,case:c});
    validateAfterPatch(c.id).catch(error => emit("validation_error", {caseId:c.id,message:error?.message||String(error)}));
  } else {
    c.status = "PATCH_FAILED";
    if (c.patchProposal) c.patchProposal.status = "PATCH_FAILED";
    emit("execution_result_received", {result,case:c});
  }
  emit("case_updated", {case:c});
  return true;
}

function receiveExecutionReview(packet) {
  if (!packet || packet.bridge !== MEDICINE_BRIDGE_KEY || packet.from !== "EXECUTION" || packet.type !== "EXECUTION_REVIEW_RESULT") return false;
  const requestId = String(packet.requestId || packet.review?.requestId || "").trim();
  const pending = requestId ? pendingExecutionReviews.get(requestId) : null;
  if (!pending) return false;
  pendingExecutionReviews.delete(requestId);
  clearTimeout(pending.timer);
  pending.resolve(packet.review || packet);
  emit("execution_review_received", { review:packet.review || packet, requestId, caseId:packet.caseId || null, role:packet.role || "STANDALONE" });
  return true;
}

medicineBridgeChannel?.addEventListener("message", event => {
  receiveExecutionReview(event.data);
  receiveExecutionResult(event.data);
  receiveInvestigationAck(event.data);
});
window.addEventListener("storage", event => {
  if (!event.newValue) return;
  try {
    const packet = JSON.parse(event.newValue);
    if (event.key === EXECUTION_REVIEW_RESULT_KEY) receiveExecutionReview(packet);
    if (event.key === EXECUTION_RESULT_KEY) receiveExecutionResult(packet);
    if (event.key === INVESTIGATION_ACK_KEY) receiveInvestigationAck(packet);
  } catch {}
});


function sourceLineNumber(source, offset) {
  return String(source || "").slice(0, Math.max(0, offset)).split(/\r?\n/).length;
}

function extractBalancedBlock(source, startIndex) {
  const text = String(source || "");
  const start = Math.max(0, Number(startIndex) || 0);
  const open = text.indexOf("{", start);
  if (open < 0) return null;
  let depth = 0, quote = null, escaped = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { start: open, end: i + 1, text: text.slice(start, i + 1) };
    }
  }
  return null;
}

function extractNamedFunction(source, name, approxLine = null) {
  const text = String(source || "");
  const safe = escRe(name);
  const patterns = [
    new RegExp(`(?:^|\\n)\\s*(?:async\\s+)?function\\s+${safe}\\s*\\([^)]*\\)\\s*\\{`, "m"),
    new RegExp(`(?:^|\\n)\\s*(?:const|let|var)\\s+${safe}\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>\\s*\\{`, "m"),
    new RegExp(`(?:^|\\n)\\s*${safe}\\s*\\([^)]*\\)\\s*\\{`, "m")
  ];
  let best = null;
  for (const re of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    const line = sourceLineNumber(text, m.index);
    const block = extractBalancedBlock(text, m.index + m[0].lastIndexOf("{"));
    if (!block) continue;
    const candidate = { name, line, start:m.index, end:block.end, code:block.text };
    if (!best || (approxLine && Math.abs(line - Number(approxLine)) < Math.abs(best.line - Number(approxLine)))) best = candidate;
  }
  return best;
}

function lineContextFromSource(source, line, radius = 5) {
  const lines = String(source || "").split(/\r?\n/);
  const n = Number(line);
  if (!Number.isFinite(n) || n < 1) return null;
  const start = Math.max(1, n - radius), end = Math.min(lines.length, n + radius);
  return { startLine:start, endLine:end, lines:lines.slice(start - 1, end).map((code,i)=>({line:start+i,code})) };
}

function makeFullSourceRecord(file, source, meta = {}) {
  const lines = String(source || "").split(/\r?\n/);
  return {
    file,
    ok:true,
    lines:lines.length,
    bytes:meta.bytes || new Blob([source]).size,
    hash:meta.hash || fingerprint(source),
    refs:extractDependencies(file, source),
    fields:extractFields(file, source),
    text:String(source),
    lineIndex:lines.map((code,i)=>({line:i+1,code}))
  };
}

function bestCrossFileFinding(scan) {
  const all = [
    ...(Array.isArray(scan?.crossFileFindings) ? scan.crossFileFindings : []),
    ...(Array.isArray(scan?.findings) ? scan.findings.filter(f => String(f?.type || f?.kind || '').startsWith('CROSS_FILE_')) : [])
  ].map(f => ({ ...f, type: f?.type || f?.kind || "CROSS_FILE_FINDING" }));
  const severityRank = {HIGH:3,MEDIUM:2,LOW:1,INFO:0};
  return [...new Map(all.map(f => [JSON.stringify([f.type,f.sourceFile,f.targetFile,f.sourceLine,f.targetLine,f.area]),f])).values()]
    .sort((a,b)=>(severityRank[b.severity]||0)-(severityRank[a.severity]||0));
}

function trackedHtmlStack(source) {
  const trackedTags = new Set(['div','section','form','main','header','footer','script','style','body','html']);
  const stack = [];
  const textSource = String(source || '');
  const tagRe = /<\/?([a-zA-Z][\w:-]*)(\s[^>]*?)?\/?\s*>/g;
  let match;
  while ((match = tagRe.exec(textSource))) {
    const tag = String(match[1] || '').toLowerCase();
    if (!trackedTags.has(tag)) continue;
    const raw = match[0];
    const line = sourceLineNumber(textSource, match.index);
    if (/^<\//.test(raw)) {
      const pos = stack.map(x => x.tag).lastIndexOf(tag);
      if (pos !== -1) stack.splice(pos, 1);
    } else if (!/\/\s*>$/.test(raw) && !['meta','link','img','input','br','hr','source','area','base','embed','param','track','wbr'].includes(tag)) {
      stack.push({tag,line,index:match.index,open:raw});
    }
  }
  return stack;
}

function buildLocalSourceFindingCandidate(finding, record) {
  const file = normalizeFile(finding?.file || finding?.sourceFile || finding?.targetFile);
  const source = String(record?.text || '');
  if (!file || !source) return {ready:false,reason:'SOURCE_NOT_READABLE'};

  const type = String(finding?.type || finding?.kind || '').toUpperCase();

  if (type === 'UNBALANCED_HTML') {
    const tagMatch = String(finding?.message || '').match(/<\/?([a-zA-Z][\w:-]*)>/);
    const tag = tagMatch ? tagMatch[1].toLowerCase() : null;
    const stack = trackedHtmlStack(source);
    const target = stack.find(x => Number(x.line) === Number(finding?.line) && (!tag || x.tag === tag))
      || stack.find(x => (!tag || x.tag === tag));
    if (!target) return {ready:false,reason:'UNBALANCED_HTML_TARGET_NOT_FOUND'};

    const closers = stack.slice().reverse().map(x => `</${x.tag}>`);
    if (!closers.length) return {ready:false,reason:'NO_UNCLOSED_TAGS_FOUND'};

    const bodyClose = source.match(/<\/body\s*>/i);
    const htmlClose = source.match(/<\/html\s*>/i);
    const anchor = bodyClose || htmlClose;
    const before = anchor ? anchor[0] : source.slice(-1);
    const after = anchor
      ? `${closers.map(x => `\n${x}`).join('')}\n`
      : `\n${closers.join('\n')}\n`;

    return {
      ready:true,
      operation:{
        type:'INSERT_EXACT',
        file,
        line:target.line,
        before,
        after,
        reason:`Source scanner menemukan tag <${target.tag}> yang belum tertutup. Medicine membaca ulang source dan menutup seluruh tracked-tag yang benar-benar masih terbuka secara deterministic sebelum ${anchor ? anchor[0] : 'EOF'}.`,
        evidenceReason:`Bukti HIGH berasal dari source aktual ${file}:${target.line}; stack HTML dihitung ulang dari source yang sama dan target exact ditemukan.`
      },
      sourceBlock:{file,line:target.line,code:target.open},
      targetBlock:{file,line:target.line,code:target.open},
      evidenceStrength:'HIGH',
      evidenceReason:`Source aktual ${file} mengandung tracked tag <${target.tag}> yang belum memiliki pasangan penutup.`
    };
  }

  if (type === 'DUPLICATE_ID') {
    return {ready:false,reason:'DUPLICATE_ID_REQUIRES_SEMANTIC_REVIEW',evidenceStrength:'HIGH',evidenceReason:'Duplicate ID terbukti di source aktual, tetapi perubahan nama/remove ID dapat memutus dependency DOM sehingga tidak dibuka sebagai patch otomatis.'};
  }

  if (type === 'UNBALANCED_JS' || type === 'UNTERMINATED_STRING') {
    return {ready:false,reason:`${type}_REQUIRES_CODE_PARSE`,evidenceStrength:'HIGH',evidenceReason:'Finding source aktual terbukti, tetapi patch otomatis ditahan karena scanner belum memiliki transformasi AST/parser yang cukup aman untuk menghasilkan BEFORE → AFTER exact.'};
  }

  return {ready:false,reason:'SOURCE_FINDING_NOT_AUTOMATABLE',evidenceStrength:finding?.severity === 'HIGH' ? 'HIGH' : 'MEDIUM',evidenceReason:'Finding source aktual terbukti, tetapi belum memiliki transformasi deterministic yang aman.'};
}

async function createLocalSourceFindingCase(finding, sources, scan) {
  const file = normalizeFile(finding?.file || finding?.sourceFile || finding?.targetFile);
  if (!file || !isDiagnosticFile(file)) return null;
  const sourceRecord = sources[file];
  if (!sourceRecord?.ok || typeof sourceRecord.text !== 'string') return null;

  const key = `LOCAL_SOURCE|${String(finding.type || finding.kind || '')}|${file}|${finding.line || ''}|${text(finding.message || finding.detail || '',500)}`;
  let c = S.cases.find(x => x.localSourceKey === key && !isTerminal(x));
  if (!c) {
    const diagnosis = {
      code: String(finding.type || finding.kind || 'SOURCE_FINDING'),
      title: `Source anomaly terverifikasi pada ${file}`,
      severity: String(finding.severity || 'MEDIUM').toUpperCase(),
      confidence: String(finding.severity || '').toUpperCase() === 'HIGH' ? 0.98 : 0.84,
      treatment: 'SOURCE_PRECISION_REPAIR'
    };
    c = {
      id:`CASE-${uid().toUpperCase()}`,
      evidenceId:null,bcgoCaseId:null,source:file,
      signature:text(finding.message || finding.detail || `${finding.type || finding.kind} pada ${file}`,700),
      diagnosis,prescription:{treatment:'SOURCE_PRECISION_REPAIR',risk:diagnosis.severity,mode:'BCGO_SOURCE_SCAN'},
      status:'INVESTIGATING',createdAt:now(),lastSeenAt:now(),evidenceCount:1,
      evidence:{kind:'BCGO_SOURCE_FINDING',finding},lastEvidence:{kind:'BCGO_SOURCE_FINDING',finding},
      runtimeLocation:{file,line:Number(finding.line)||null,col:Number(finding.column)||null,stack:''},
      rootCauseFile:file,rootCauseStatus:'UNPROVEN',sourceEvidence:[],repairPlan:null,patchProposal:null,validation:null,
      localSourceKey:key,bcgoSourceFinding:finding,sourceFile:file,targetFile:file,
      bcgoCycle:Number(scan?.cycle || 0),bcgoReceivedAt:now(),bcgoRevisionToken:bcgoScanToken(scan),lastInvestigatedEvidenceToken:null
    };
    S.cases.unshift(c); S.cases=S.cases.slice(0,100); S.activeCase=c;
    emit('case_created',{case:c,source:'BCGO_LOCAL_SOURCE_SCAN'});
  } else {
    c.lastSeenAt=now();c.bcgoSourceFinding=finding;c.evidence={...(c.evidence||{}),kind:'BCGO_SOURCE_FINDING',finding};c.lastEvidence=c.evidence;S.activeCase=c;
  }

  const candidate=buildLocalSourceFindingCandidate(finding,sourceRecord);
  const checkedFiles=Object.keys(sources);
  const sourceEvidence=[{...finding,file,line:Number(finding.line)||null,sourceFile:file,targetFile:file,
    evidenceStrength:candidate.evidenceStrength || (String(finding.severity||'').toUpperCase()==='HIGH' ? 'HIGH':'MEDIUM'),
    evidenceReason:candidate.evidenceReason || 'Finding terbukti melalui source aktual yang dibaca ulang oleh Medicine.'}];
  const verification={requestedTarget:file,target:file,rootCauseFile:file,
    rootCauseStatus:candidate.ready?'CONFIRMED_ORIGINAL_TARGET':'UNPROVEN',
    verdict:candidate.ready?'SUPPORTED_BY_EXACT_SOURCE_EVIDENCE':'SOURCE_FINDING_REQUIRES_DEEPER_REVIEW',
    rootCauseCandidates:[{file,line:Number(finding.line)||null,type:finding.type||finding.kind,reason:finding.message||finding.detail,evidenceStrength:sourceEvidence[0].evidenceStrength}],
    sourceEvidence,runtimeEvidence:[],checkedFiles,checkedCount:checkedFiles.length,checkedAt:now(),question:'BCGO local source finding'};

  const plan=buildRepairPlan(c,verification);
  plan.rootCauseFile=file;plan.rootCauseStatus=verification.rootCauseStatus;plan.candidates=verification.rootCauseCandidates;plan.sourceEvidence=sourceEvidence;
  plan.strategy=candidate.ready?'DETERMINISTIC_SOURCE_FINDING_REPAIR':'SOURCE_FINDING_INVESTIGATION';
  if (candidate.ready && candidate.operation) {
    plan.operations.push(candidate.operation);plan.beforeAfter.push({file,line:candidate.operation.line,before:candidate.operation.before,after:candidate.operation.after});
    plan.precisionGate=true;plan.status='PROPOSED';plan.blockReason=null;c.rootCauseStatus='CONFIRMED_ORIGINAL_TARGET';c.status='VERIFIED_DIAGNOSIS';
  } else {
    plan.precisionGate=false;plan.status='PATCH_REQUIRES_REVIEW';plan.blockReason=`${candidate.reason || 'SOURCE_FINDING_REQUIRES_DEEPER_REVIEW'} — Medicine tidak mengarang patch.`;c.status='INVESTIGATION_BLOCKED';
  }
  c.verification=verification;c.repairPlan=plan;c.rootCauseFile=file;c.sourceEvidence=sourceEvidence;

  const proposal={proposalId:`PATCH-${uid().toUpperCase()}`,caseId:c.id,telemetryTarget:c.source,originalTarget:file,repairTarget:file,
    rootCauseStatus:plan.rootCauseStatus,diagnosis:c.diagnosis,verification,repairPlan:plan,operations:plan.operations,beforeAfter:plan.beforeAfter,
    precisionGate:plan.precisionGate,sourceWrite:false,requiresHumanApproval:true,requiresPostValidation:true,status:plan.precisionGate?'PROPOSED':'PATCH_REQUIRES_REVIEW',createdAt:now(),sourceFinding:finding};

  if (plan.precisionGate) {
    const executionReview=await reviewProposalWithExecutor(c,proposal);proposal.executionReview=executionReview;verification.executionReview=executionReview;c.verification=verification;
    if (executionReview?.status==='VALID') { proposal.status='READY_FOR_HUMAN_APPROVAL';c.status='READY_FOR_HUMAN_APPROVAL';plan.status='READY_FOR_HUMAN_APPROVAL'; }
    else { proposal.status='EXECUTION_REVIEW_REJECTED';c.status='INVESTIGATION_BLOCKED';plan.precisionGate=false;plan.status='PATCH_REQUIRES_REVIEW';plan.blockReason=`Execution review belum valid: ${executionReview?.reason||'UNKNOWN'}`; }
  }
  c.patchProposal=proposal;S.patchProposals.unshift(proposal);S.patchProposals=S.patchProposals.slice(0,50);
  emit('bcgo_local_source_investigation_complete',{case:c,finding,candidate,file});emit('patch_proposed',{proposal,case:c});emit('case_updated',{case:c});
  await safeAddMessage('medicine',candidate.ready
    ? `BCGO source scan menemukan ${finding.type||finding.kind} pada ${file}:${finding.line||'-'}. Saya membaca ulang source aktual, membuktikan target exact, membentuk BEFORE → AFTER deterministic, dan mengirim candidate ke Executor untuk review.`
    : `BCGO source scan menemukan ${finding.type||finding.kind} pada ${file}:${finding.line||'-'}. Evidence source terbukti, tetapi transformasi patch belum aman sehingga Medicine menahan treatment.`,
    {kind:'BCGO_LOCAL_SOURCE_INVESTIGATION',caseId:c.id,file,findingType:finding.type||finding.kind});
  return c;
}

function buildCrossFileCandidate(finding, sources) {
  const sourceFile = normalizeFile(finding?.sourceFile);
  const targetFile = normalizeFile(finding?.targetFile);
  const evidence = finding?.evidence || {};
  if (!sourceFile || !targetFile || sourceFile === targetFile) return {ready:false,reason:"CROSS_FILE_ENDPOINT_INVALID"};
  const source = sources[sourceFile]?.text || "";
  const target = sources[targetFile]?.text || "";
  if (!source || !target) return {ready:false,reason:"SOURCE_OR_TARGET_NOT_READABLE"};

  const fnName = evidence.referenceFunction || (String(finding.area || '').startsWith('FUNCTION:') ? String(finding.area).slice(9) : null);
  if (fnName) {
    const srcFn = extractNamedFunction(source, fnName, finding.sourceLine);
    const tgtFn = extractNamedFunction(target, fnName, finding.targetLine);
    if (srcFn && tgtFn && srcFn.code !== tgtFn.code) {
      return {
        ready:true,
        operation:{
          type:"REPLACE_EXACT",
          file:targetFile,
          line:tgtFn.line,
          before:tgtFn.code,
          after:srcFn.code,
          fullCode:source,
          sourceFile,
          sourceLine:srcFn.line,
          reason:`Implementasi ${fnName} pada ${targetFile} divergen dari kandidat reference ${sourceFile}; blok fungsi exact dapat dibandingkan tanpa menebak kode.`,
          evidenceReason:"Medicine membaca ulang source reference dan target lalu menemukan fungsi bernama sama dengan body berbeda."
        },
        sourceBlock:{file:sourceFile,line:srcFn.line,code:srcFn.code},
        targetBlock:{file:targetFile,line:tgtFn.line,code:tgtFn.code}
      };
    }
  }

  const missingFunctions = Array.isArray(evidence.missingFunctions) ? evidence.missingFunctions : [];
  for (const missing of missingFunctions.slice(0,10)) {
    const srcFn = extractNamedFunction(source, missing, null);
    if (srcFn) return {
      ready:false,
      reason:"TARGET_FUNCTION_MISSING",
      sourceBlock:{file:sourceFile,line:srcFn.line,code:srcFn.code},
      targetBlock:{file:targetFile,line:finding.targetLine || null,code:""},
      missingFunction:missing
    };
  }

  return {ready:false,reason:"EXACT_REPLACEMENT_NOT_PROVEN",sourceBlock:null,targetBlock:null};
}

async function ingestBCGOScan(scan, packet = {}) {
  if (!scan || typeof scan !== "object") return null;
  const cycle = Number(packet?.state?.cycle || 0);
  const sourcesMeta = scan.sources && typeof scan.sources === "object" ? scan.sources : {};
  const names = Object.keys(sourcesMeta).filter(isDiagnosticFile);
  const findings = Array.isArray(scan.findings) ? scan.findings : [];
  const cross = Array.isArray(scan.crossFileFindings) ? scan.crossFileFindings : [];

  S.bcgoSourceScan = {
    status:scan.status || "COMPLETE",
    receivedAt:Date.now(),
    cycle,
    filesScanned:Number(scan.filesScanned || names.length),
    filesReadable:Number(scan.filesReadable || names.length),
    filesFailed:Number(scan.filesFailed || 0),
    findings,
    crossFileFindings:cross,
    relations:Array.isArray(scan.relations) ? scan.relations : [],
    sources:sourcesMeta
  };

  // Preserve the previous verified surface before replacing its live metadata.
  // Otherwise the reuse check below would see an empty result map and still
  // download every file on each changed scan token.
  const previousResults = S.liveSurface.results || {};
  S.liveSurface = {
    ...S.liveSurface,
    status:"READING",
    cycle,
    scanning:true,
    updatedAt:Date.now(),
    findings:[...findings,...cross],
    relations:Array.isArray(scan.relations) ? scan.relations : [],
    results:{}
  };
  window.dispatchEvent(new CustomEvent("bcgo:medicine",{detail:{event:"bcgo_source_scan_received",scan:S.bcgoSourceScan}}));

  // Reuse an already verified live-surface record when BCGO reports the same
  // source hash. Only changed/previously unreadable files are fetched again.
  // This is critical for realtime operation: a new scan heartbeat must not turn
  // into N no-store HTTP downloads every few seconds.
  const results = {};
  for (const file of names) {
    const meta = sourcesMeta[file] || {};
    const previous = previousResults[file];
    const sameHash = !!meta.hash && !!previous?.hash && String(meta.hash) === String(previous.hash) && previous.ok === true;
    if (sameHash) {
      results[file] = previous;
    } else {
      const data = await fetchFile(file,{force:true});
      if (data.ok && typeof data.text === "string") {
        results[file] = makeFullSourceRecord(file,data.text,meta);
      } else {
        results[file] = {file,ok:false,lines:0,bytes:0,hash:null,refs:[],fields:[],text:"",lineIndex:[]};
      }
    }
    S.liveSurface.results = {...results};
    S.liveSurface.updatedAt = Date.now();
    window.dispatchEvent(new CustomEvent("bcgo:medicine",{detail:{event:"bcgo_source_file_read",file,record:results[file],progress:{done:Object.keys(results).length,total:names.length}}}));
  }

  S.liveSurface = {
    ...S.liveSurface,
    status:"COMPLETE",
    scanning:false,
    updatedAt:Date.now(),
    results,
    relations:Array.isArray(scan.relations) ? scan.relations : [],
    findings:[...findings,...cross]
  };
  window.dispatchEvent(new CustomEvent("bcgo:medicine",{detail:{event:"bcgo_source_scan_complete",surface:getLiveSurface()}}));

  // Consume LOCAL source findings as first-class Medicine evidence too.
  // Previously only CROSS_FILE findings entered Medicine, which made real
  // scanner findings disappear at the Medicine root-cause gate.
  const localActionable = (Array.isArray(scan.findings) ? scan.findings : [])
    .filter(f => f && f.file && isDiagnosticFile(f.file) && f.severity !== 'INFO')
    .slice(0,100);
  emit('bcgo_local_source_queue_ready',{count:localActionable.length,cycle,findings:localActionable});
  for (const finding of localActionable) {
    const file=normalizeFile(finding.file);
    const sourceHash=results[file]?.hash || '';
    const evidenceKey=`LOCAL|${finding.type || finding.kind || ''}|${file}|${finding.line || ''}|${sourceHash}|${text(finding.message || finding.detail || '',500)}`;
    if (S.processedCrossFileEvidence.has(evidenceKey)) continue;
    S.processedCrossFileEvidence.add(evidenceKey);
    if (S.processedCrossFileEvidence.size>200) S.processedCrossFileEvidence.delete(S.processedCrossFileEvidence.values().next().value);
    emit('bcgo_local_source_investigation_started',{finding,file,evidenceKey});
    try { await createLocalSourceFindingCase(finding,results,scan); }
    catch (error) { emit('bcgo_local_source_investigation_error',{finding,file,message:error?.message || String(error)}); }
  }

  // BCGO is the detector; Medicine must consume the complete actionable
  // cross-file result set, not silently reduce it to the first finding.
  // Every finding gets its own deterministic evidence key so a later BCGO
  // scan can re-open only the finding whose source/target evidence changed.
  const actionable = bestCrossFileFinding(scan);
  emit("bcgo_cross_file_queue_ready", {
    count: actionable.length,
    cycle,
    findings: actionable
  });

  for (const candidateFinding of actionable) {
    const sf=normalizeFile(candidateFinding.sourceFile)||"";
    const tf=normalizeFile(candidateFinding.targetFile)||"";
    const evidenceKey=`${candidateFinding.type}|${sf}|${tf}|${candidateFinding.sourceLine||''}|${candidateFinding.targetLine||''}|${candidateFinding.area||''}|${results[sf]?.hash||''}|${results[tf]?.hash||''}`;
    if (S.processedCrossFileEvidence.has(evidenceKey)) continue;

    S.processedCrossFileEvidence.add(evidenceKey);
    if (S.processedCrossFileEvidence.size>200) {
      S.processedCrossFileEvidence.delete(S.processedCrossFileEvidence.values().next().value);
    }

    emit("bcgo_cross_file_investigation_started", {
      finding:candidateFinding,
      sourceFile:sf,
      targetFile:tf,
      evidenceKey
    });

    try {
      await createCrossFileCase(candidateFinding, results, scan);
    } catch (error) {
      emit("bcgo_cross_file_investigation_error", {
        finding:candidateFinding,
        sourceFile:sf,
        targetFile:tf,
        message:error?.message || String(error)
      });
    }
  }

  return S.liveSurface;
}

async function createCrossFileCase(finding, sources, scan) {
  const sourceFile = normalizeFile(finding.sourceFile), targetFile = normalizeFile(finding.targetFile);
  if (!sourceFile || !targetFile) return null;
  const key = `${finding.type}|${sourceFile}|${targetFile}|${finding.sourceLine || ''}|${finding.targetLine || ''}|${finding.area || ''}`;
  let c = S.cases.find(x => x.crossFileKey === key && !isTerminal(x));
  if (!c) {
    const diagnosis = {
      code:"CROSS_FILE_SOURCE_MISMATCH",
      title:"Ketidaksinkronan source lintas-file",
      severity:finding.severity || "MEDIUM",
      confidence:finding.confidence === "HIGH" ? 0.95 : 0.78,
      treatment:"CROSS_FILE_REVIEW"
    };
    c = {
      id:`CASE-${uid().toUpperCase()}`,
      evidenceId:null,
      source:targetFile,
      signature:text(finding.message || `${sourceFile} tidak sinkron dengan ${targetFile}`,700),
      diagnosis,
      prescription:{treatment:"CROSS_FILE_REVIEW",risk:"LOW",mode:"SOURCE_CONSENSUS"},
      status:"INVESTIGATING",
      createdAt:now(),lastSeenAt:now(),evidenceCount:1,
      evidence:{kind:"BCGO_SOURCE_SCAN",finding},lastEvidence:{kind:"BCGO_SOURCE_SCAN",finding},
      runtimeLocation:{file:targetFile,line:Number(finding.targetLine)||null,col:null,stack:""},
      rootCauseFile:targetFile,rootCauseStatus:"UNPROVEN",sourceEvidence:[],repairPlan:null,patchProposal:null,validation:null,
      crossFileKey:key,bcgoFinding:finding,sourceFile,targetFile
    };
    S.cases.unshift(c); S.cases=S.cases.slice(0,100); S.activeCase=c;
    emit("case_created",{case:c,source:"BCGO_CROSS_FILE_SCAN"});
  } else S.activeCase=c;

  const candidate=buildCrossFileCandidate(finding,sources);
  const sourceRecord=sources[sourceFile], targetRecord=sources[targetFile];
  const checkedFiles=Object.keys(sources);
  const verification={
    requestedTarget:targetFile,target:targetFile,rootCauseFile:targetFile,rootCauseStatus:candidate.ready?"TARGET_CORRECTED_BY_MEDICINE":"UNPROVEN",
    verdict:candidate.ready?"SUPPORTED_BY_EXACT_SOURCE_EVIDENCE":"CROSS_FILE_EVIDENCE_REQUIRES_DEEPER_REVIEW",
    rootCauseCandidates:[{sourceFile,targetFile,area:finding.area,reason:finding.message,evidence:finding.evidence||{},line:finding.targetLine||null}],
    sourceEvidence:[{...finding,evidenceStrength:finding.confidence === "HIGH" ? "HIGH":"MEDIUM",sourceFile,targetFile}],
    runtimeEvidence:[],checkedFiles,checkedCount:checkedFiles.length,checkedAt:now(),question:"BCGO cross-file source scan"
  };

  const plan={
    planId:`REPAIR-${uid().toUpperCase()}`,caseId:c.id,target:targetFile,originalTarget:targetFile,
    rootCauseFile:targetFile,rootCauseStatus:verification.rootCauseStatus,diagnosis:c.diagnosis,verification,
    strategy:"CROSS_FILE_REFERENCE_CONSENSUS",operations:[],beforeAfter:[],candidates:verification.rootCauseCandidates,
    sourceEvidence:verification.sourceEvidence,preconditions:[
      "Reference candidate berasal dari BCGO source scan dan diverifikasi ulang oleh Medicine.",
      "Target harus diverifikasi sebagai implementasi yang tidak lengkap/divergen sebelum solusi dibuka.",
      "Tidak ada source write otomatis; manusia melakukan copy pada target.",
      "Executor hanya melakukan deterministic review terhadap candidate."
    ],postconditions:["Target kembali memenuhi bukti kontrak lintas-file.","Medicine melakukan validation setelah perubahan terlihat pada deployment."],
    precision:{exactTargetRequired:true,exactEvidenceRequired:true,exactOperationRequired:true,noGuessing:true,humanApprovalRequired:true,crossFileProofRequired:true},
    precisionGate:false,status:"PATCH_REQUIRES_REVIEW",blockReason:"Menunggu pembuktian source/target exact.",sourceWrite:false,requiresHumanApproval:true,requiresPostValidation:true,createdAt:now()
  };

  if (candidate.ready) {
    plan.operations.push(candidate.operation);
    plan.beforeAfter.push({file:targetFile,line:candidate.operation.line,before:candidate.operation.before,after:candidate.operation.after,sourceFile,sourceLine:candidate.operation.sourceLine,fullCode:sourceRecord?.text || ""});
    plan.precisionGate=true; plan.status="PROPOSED"; plan.blockReason=null;
    c.rootCauseStatus="TARGET_CORRECTED_BY_MEDICINE";
    c.status="VERIFIED_DIAGNOSIS";
  } else {
    c.status="INVESTIGATION_BLOCKED";
  }

  c.verification=verification;c.repairPlan=plan;c.rootCauseFile=targetFile;c.sourceEvidence=verification.sourceEvidence;
  const proposal={proposalId:`PATCH-${uid().toUpperCase()}`,caseId:c.id,telemetryTarget:c.source,originalTarget:targetFile,repairTarget:targetFile,rootCauseStatus:plan.rootCauseStatus,diagnosis:c.diagnosis,verification,repairPlan:plan,operations:plan.operations,beforeAfter:plan.beforeAfter,precisionGate:plan.precisionGate,sourceWrite:false,requiresHumanApproval:true,requiresPostValidation:true,status:plan.precisionGate?"PROPOSED":"PATCH_REQUIRES_REVIEW",createdAt:now(),crossFileFinding:finding,referenceFile:sourceFile,targetFile};

  if (plan.precisionGate) {
    const executionReview=await reviewProposalWithExecutor(c,proposal);
    proposal.executionReview=executionReview;verification.executionReview=executionReview;c.verification=verification;
    if (executionReview?.status === "VALID") { proposal.status="READY_FOR_HUMAN_APPROVAL";c.status="READY_FOR_HUMAN_APPROVAL";plan.status="READY_FOR_HUMAN_APPROVAL"; }
    else { proposal.status="EXECUTION_REVIEW_REJECTED";c.status="INVESTIGATION_BLOCKED";plan.precisionGate=false;plan.status="PATCH_REQUIRES_REVIEW";plan.blockReason=`Execution review belum valid: ${executionReview?.reason || "UNKNOWN"}`; }
  }

  c.patchProposal=proposal;S.patchProposals.unshift(proposal);S.patchProposals=S.patchProposals.slice(0,50);
  emit("cross_file_investigation_complete",{case:c,finding,candidate,sourceFile,targetFile});
  emit("patch_proposed",{proposal,case:c});emit("case_updated",{case:c});

  // If the cross-file evidence is not yet enough for an exact operation, do
  // not stop at a red card. Put the case into Medicine's existing autonomous
  // investigation queue so the dependency/root-cause pass continues without
  // a Verify click or page refresh.
  if (!candidate.ready) {
    queueAutoInvestigation(c, "bcgo_cross_file_requires_deeper_evidence");
  }
  await safeAddMessage("medicine",candidate.ready
    ? `BCGO menunjukkan ${sourceFile} ↔ ${targetFile}. Saya membaca ulang kedua source dan menemukan implementasi ${finding.area || 'terkait'} yang dapat dibandingkan exact. Candidate dikirim ke Execution untuk review deterministic; tidak ada eksekusi otomatis.`
    : `BCGO menunjukkan ${sourceFile} ↔ ${targetFile}. Saya sudah membaca ulang source yang tersedia, tetapi exact replacement belum terbukti aman. Saya menahan treatment dan meminta evidence lanjutan.`,
    {kind:"BCGO_CROSS_FILE_INVESTIGATION",caseId:c.id,sourceFile,targetFile,findingType:finding.type});
  return c;
}

function getLiveSurface() {
  return {
    ...S.liveSurface,
    results:{...S.liveSurface.results},
    relations:[...(S.liveSurface.relations || [])],
    findings:[...(S.liveSurface.findings || [])]
  };
}

function bcgoScanToken(scan) {
  if (!scan || typeof scan !== "object") return "";
  const sourceHashes = Object.entries(scan.sources || {})
    .filter(([file]) => isDiagnosticFile(file))
    .map(([file,meta]) => `${file}:${meta?.hash || ""}:${meta?.lines || 0}`)
    .sort()
    .join("|");
  const findings = [...(scan.findings || []), ...(scan.crossFileFindings || [])]
    .map(f => `${f?.type || ""}:${f?.sourceFile || ""}:${f?.targetFile || ""}:${f?.sourceLine || ""}:${f?.targetLine || ""}:${f?.area || ""}`)
    .sort()
    .join("|");
  // Do not include volatile scan timestamps. BCGO may publish the same source
  // snapshot every cycle; a timestamp-only change must NOT force Medicine to
  // re-download every file and rebuild the entire live surface.
  return `${scan.status || ""}|${scan.filesScanned || 0}|${scan.filesReadable || 0}|${scan.filesFailed || 0}|${sourceHashes}|${findings}`;
}

async function syncBCGOStateFromCache(source = "LOCAL_STORAGE_CACHE") {
  try {
    const cached = localStorage.getItem(`${MEDICINE_BRIDGE_KEY}_STATE`);
    if (!cached) return false;
    const packet = JSON.parse(cached);
    return receiveBCGOState(packet, source);
  } catch {
    return false;
  }
}

function startLiveSurface() {
  if (window.__BCGO_MEDICINE_LIVE_SURFACE_TIMER) return;
  const run = () => {
    const scan = S.bcgoSourceScan;
    if (!scan?.status || scan.status === "WAITING") return;
    const token = bcgoScanToken(scan);
    if (!token || token === S.lastBCGOScanToken || token === S.bcgoIngestingToken) return;
    S.bcgoIngestingToken = token;
    void ingestBCGOScan(scan,{state:{cycle:scan.cycle}})
      .then(() => { S.lastBCGOScanToken = token; })
      .catch(error => emit("bcgo_source_scan_error",{message:error?.message||String(error)}))
      .finally(() => { if (S.bcgoIngestingToken === token) S.bcgoIngestingToken = null; });
  };
  window.__BCGO_MEDICINE_LIVE_SURFACE_TIMER = setInterval(run, 3000);
  run();
}

function startBCGOBridgeRecovery() {
  if (window.__BCGO_MEDICINE_BRIDGE_RECOVERY_TIMER) return;
  const recover = () => { void syncBCGOStateFromCache("LOCAL_STORAGE_RECOVERY"); };
  window.__BCGO_MEDICINE_BRIDGE_RECOVERY_TIMER = setInterval(recover, 3000);
  window.addEventListener("pageshow", recover);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") recover();
  });
  recover();
}

function normalizeFile(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const clean = raw.split(/[?#]/)[0];
  return clean.substring(clean.lastIndexOf("/") + 1);
}

function isTerminal(caseItem) {
  return TERMINAL_STATUSES.has(caseItem?.status);
}

function activeCases() {
  return S.cases.filter(c => ACTIVE_STATUSES.has(c.status) && !isTerminal(c));
}

function mentionedFile(question) {
  const q = lower(question);
  return Object.keys(REGISTRY).find(name => q.includes(name.toLowerCase())) || null;
}

function classifyError(message) {
  const m = lower(message);
  if (/cannot set properties of null|cannot read properties of null/.test(m)) {
    return {
      code: "DOM_NULL_REFERENCE",
      title: "Referensi DOM tidak ditemukan",
      severity: "MEDIUM",
      confidence: 0.96,
      treatment: "DOM_REFERENCE_REVIEW"
    };
  }
  if (/permission-denied|missing or insufficient permissions|unauthenticated|permission denied/.test(m)) {
    return {
      code: "FIRESTORE_RULE_PERMISSION",
      title: "Permission Firestore ditolak",
      severity: "HIGH",
      confidence: 0.97,
      treatment: "FIRESTORE_RULE_REVIEW"
    };
  }
  if (/network|offline|unavailable|onSnapshot|listener/.test(m)) {
    return {
      code: "REALTIME_CONNECTIVITY",
      title: "Gangguan listener realtime",
      severity: "MEDIUM",
      confidence: 0.84,
      treatment: "REALTIME_LISTENER_REVIEW"
    };
  }
  if (/referenceerror|(?:is not defined|not defined)/.test(m)) {
    const symbol = m.match(/(?:referenceerror|is not defined|not defined)\s*:?[\s]*([a-z_$][\w$]*)/i)?.[1] || null;
    return {
      code: "UNDEFINED_SYMBOL",
      title: symbol ? `Simbol JavaScript tidak tersedia: ${symbol}` : "Simbol JavaScript tidak tersedia",
      severity: "HIGH",
      confidence: 0.96,
      treatment: "SYMBOL_SCOPE_REVIEW",
      symbol
    };
  }
  if (/is not a function|undefined/.test(m)) {
    return {
      code: "JAVASCRIPT_CONTRACT",
      title: "Kontrak JavaScript tidak terpenuhi",
      severity: "MEDIUM",
      confidence: 0.82,
      treatment: "JS_CONTRACT_REVIEW"
    };
  }
  if (/sinkron|synchron|count|jumlah|field|tidak sesuai|tidak sinkron/.test(m)) {
    return {
      code: "DATA_CONSISTENCY",
      title: "Kontrak/data lintas-file tidak konsisten",
      severity: "MEDIUM",
      confidence: 0.72,
      treatment: "CROSS_FILE_REVIEW"
    };
  }
  return {
    code: "UNCLASSIFIED_RUNTIME",
    title: "Runtime anomaly belum terklasifikasi",
    severity: "UNKNOWN",
    confidence: 0.45,
    treatment: "MANUAL_REVIEW"
  };
}

function classifyFirestoreError(error) {
  const code = lower(error?.code || "");
  const message = String(error?.message || error || "").slice(0,700);
  const permission = code.includes("permission-denied") ||
    /permission[- ]denied|missing or insufficient permissions|unauthenticated/i.test(message);
  return { code: code || "unknown", message, permission };
}

async function safeAddMessage(role, message, meta = {}) {
  const clientMessageId = meta.clientMessageId || uid();
  const payload = {
    role,
    text: text(message, 1800),
    system: role !== "human",
    actorUid: role === "human" ? (auth.currentUser?.uid || null) : null,
    createdAt: serverTimestamp(),
    clientMessageId,
    ...meta
  };

  try {
    await addDoc(collection(db, "medicine_messages"), payload);
  } catch (error) {
    emit("local_message", {
      message: { ...payload, createdAt: now() },
      storageError: error?.message || String(error)
    });
  }
}

async function fetchFile(name, options = {}) {
  const file = normalizeFile(name);
  if (!file) return { ok:false, status:0, text:"", error:"INVALID_FILE" };

  const force = options.force === true;
  const cached = S.sourceCache.get(file);
  if (!force && cached && Date.now() - cached.at < 10000) return cached.value;

  try {
    const response = await fetch(`./${encodeURIComponent(file)}`, {
      cache: "no-store",
      credentials: "same-origin"
    });
    const value = {
      ok: response.ok,
      status: response.status,
      text: response.ok ? await response.text() : "",
      fetchedAt: now()
    };
    S.sourceCache.set(file, { at: Date.now(), value });
    return value;
  } catch (error) {
    const value = {
      ok:false,
      status:0,
      text:"",
      error:error?.message || String(error),
      fetchedAt:now()
    };
    S.sourceCache.set(file, { at: Date.now(), value });
    return value;
  }
}

function canonicalFields(values) {
  const raw = new Set((values || []).map(String));
  const result = new Set(raw);
  for (const [canonical, aliases] of Object.entries(FIELD_ALIASES)) {
    if (aliases.some(a => raw.has(a))) result.add(canonical);
  }
  return result;
}

function extractFields(file, source) {
  if (!source) return [];
  const out = [];
  let m;

  const attrs = /(?:id|name|data-field|data-key)\s*=\s*["']([^"']+)["']/gi;
  while ((m = attrs.exec(source))) out.push(m[1]);

  const aliases = {
    regName:"name", regPhone:"phone", regAddress:"address",
    regVehicleType:"vehicleType", regVehicle:"vehicle", regPhoto:"photo",
    regFotoKtp:"fotoKtp", regFotoSim:"fotoSim", regFotoStnk:"fotoStnk",
    regKtp:"ktp", regSim:"sim", regBank:"bank",
    regAccountName:"accountName", regAccountNo:"accountNo",
    mitraAlamat:"address", mitraKtp:"ktp",
    mitraFotoKtp:"fotoKtp", mitraSocialMedia:"socialMedia"
  };

  for (const [id, field] of Object.entries(aliases)) {
    if (new RegExp(`id\\s*=\\s*["']${escRe(id)}["']`, "i").test(source)) out.push(field);
  }

  const dataDot = /\b(?:data|payload|application|partner)\s*\??\.\s*([A-Za-z_$][\w$]*)/g;
  while ((m = dataDot.exec(source))) out.push(m[1]);

  const dataBracket = /\b(?:data|payload|application|partner)\s*\[\s*["']([^"']+)["']\s*\]/g;
  while ((m = dataBracket.exec(source))) out.push(m[1]);

  if (/\.js$/i.test(file)) {
    const jsFields = /\b(name|phone|address|email|vehicleType|vehicle|photo|profilePhoto|fotoProfil|photoFront|photoIndoor|fotoKtp|fotoSim|fotoStnk|ktp|sim|stnk|bank|bankName|accountName|accountNumber|accountNo|serviceType|businessName|businessType|ownerName|role|village|district|city|province|openTime|closeTime|operationalDays|legalStatus|socialMedia)\b/g;
    while ((m = jsFields.exec(source))) out.push(m[1]);
  }

  return [...new Set(out)];
}

function extractDependencies(file, source) {
  if (!source) return [];
  const out = new Set();
  let m;

  const patterns = [
    /<script[^>]+(?:src|data-src)\s*=\s*["']([^"']+)["']/gi,
    /<(?:link|iframe)[^>]+(?:href|src)\s*=\s*["']([^"']+)["']/gi,
    /(?:from|import\s*\()\s*["']\.?\/?([^"']+\.(?:js|html))["']/gi,
    /(?:fetch|window\.open|location\.href)\s*\(\s*["']\.?\/?([^"']+\.(?:js|html))["']/gi
  ];

  for (const re of patterns) {
    while ((m = re.exec(source))) {
      const raw = String(m[1] || "").trim();
      if (/^(?:https?:|data:|blob:|javascript:|#)/i.test(raw)) continue;
      const candidate = normalizeFile(raw);
      if (candidate && candidate !== file && /\.(?:html|js)$/i.test(candidate)) out.add(candidate);
    }
  }
  return [...out];
}

async function discoverSystemSurface() {
  if (S.busy.surface) return S.surface?.files || [];
  S.busy.surface = true;

  try {
    // Only BCGO/system roots are entry points. Medicine files are deliberately
    // outside the diagnostic surface to prevent self-analysis/recursive scans.
    const roots = ["bcgo-engine.js","bcgo-admin.html","bcgo.js","bcgo.html"]
      .filter(isDiagnosticFile);
    const discovered = new Set();
    const queue = [...roots];
    const queued = new Set(queue);
    const edges = [];

    while (queue.length) {
      const root = queue.shift();
      if (!isDiagnosticFile(root) || discovered.has(root)) continue;
      discovered.add(root);

      const source = await fetchFile(root);
      if (!source.ok) continue;

      const refs = new Set([
        ...extractDependencies(root, source.text),
        ...[...source.text.matchAll(/["'`]([A-Za-z0-9_.-]+\.(?:html|js))["'`]/gi)]
          .map(m => normalizeFile(m[1]))
          .filter(Boolean)
      ]);

      for (const ref of refs) {
        if (!isDiagnosticFile(ref)) continue;
        if (!REGISTRY[ref]) REGISTRY[ref] = { type:"Discovered Dependency", role:"dependency" };
        edges.push({ from:root, to:ref });
        if (!discovered.has(ref) && !queued.has(ref)) {
          queued.add(ref);
          queue.push(ref);
        }
      }
    }

    const files = [...discovered];
    S.surface = {
      roots,
      files,
      edges: [...new Map(edges.map(e => [`${e.from}>${e.to}`, e])).values()],
      discoveredAt: now()
    };

    emit("dependency_surface", { surface:S.surface });
    return files;
  } finally {
    S.busy.surface = false;
  }
}

function sourceLines(source) {
  return String(source || "").split(/\r?\n/);
}

function lineOf(source, offset) {
  return String(source || "").slice(0, Math.max(0, offset)).split(/\r?\n/).length;
}

function sourceContext(source, line, radius = 4) {
  const lines = sourceLines(source);
  const n = Number(line);
  if (!Number.isFinite(n) || n < 1) return { startLine:null, endLine:null, lines:[] };
  const start = Math.max(1, n - radius);
  const end = Math.min(lines.length, n + radius);
  return {
    startLine:start,
    endLine:end,
    lines:lines.slice(start-1, end).map((code,i) => ({ line:start+i, code }))
  };
}

function parseRuntimeLocations(log) {
  const out = [];
  const add = (file,line,col,kind) => {
    const f = normalizeFile(file);
    if (!f) return;
    out.push({ file:f, line:Number(line)||null, col:Number(col)||null, kind });
  };

  add(
    log?.fileName || log?.source || log?.file,
    log?.lineNumber ?? log?.line ?? log?.lineno,
    log?.columnNumber ?? log?.column ?? log?.col,
    "telemetry"
  );

  const stack = String(log?.stack || log?.stackTrace || log?.errorStack || "");
  const re = /(?:https?:\/\/[^\s)]+\/)?([A-Za-z0-9_.-]+\.(?:html|js))(?::(\d+))?(?::(\d+))?/gi;
  let m;
  while ((m = re.exec(stack))) add(m[1],m[2],m[3],"stack");

  const sig = String(log?.message || log?.error || "");
  while ((m = re.exec(sig))) add(m[1],m[2],m[3],"signature");

  return [...new Map(out.map(x => [`${x.file}:${x.line}:${x.col}:${x.kind}`,x])).values()];
}

function domAssignments(file, source) {
  if (!source) return [];
  const out = [];
  let m;

  const direct = [
    /(?:document\.getElementById\(\s*["']([^"']+)["']\s*\)|document\.querySelector\(\s*["']([^"']+)["']\s*\)|\$\(\s*["']([^"']+)["']\s*\))\s*\.(textContent|innerHTML|value|className)\s*=\s*([^;\n]+);?/g,
    /([A-Za-z_$][\w$]*)\s*\.(textContent|innerHTML|value|className)\s*=\s*([^;\n]+);?/g
  ];

  for (const re of direct) {
    while ((m = re.exec(source)) && out.length < 120) {
      if (re === direct[0]) {
        out.push({
          file,
          selector:m[1] || m[2] || m[3] || null,
          property:m[4],
          rhs:m[5],
          before:m[0],
          line:lineOf(source,m.index),
          index:m.index,
          kind:"DIRECT"
        });
      } else {
        out.push({
          file,
          selector:null,
          variable:m[1],
          property:m[2],
          rhs:m[3],
          before:m[0],
          line:lineOf(source,m.index),
          index:m.index,
          kind:"BOUND"
        });
      }
    }
  }
  return out;
}

function htmlHasElement(source, selector) {
  if (!source || !selector) return false;
  const id = String(selector).replace(/^#/,"").trim();
  if (!/^[A-Za-z_][\w:.-]*$/.test(id)) return false;
  return new RegExp(`(?:id|name)\\s*=\\s*["']${escRe(id)}["']`, "i").test(source);
}

function exactDomEvidence(file, source, log) {
  const locations = parseRuntimeLocations(log);
  const assignments = domAssignments(file, source);
  const sig = lower(log?.message || log?.error || "");
  const fileLocations = locations.filter(x => lower(x.file) === lower(file));
  const result = [];

  for (const a of assignments) {
    const exactLine = fileLocations.some(x => x.line && Number(x.line) === Number(a.line));
    const nearLine = fileLocations.some(x => x.line && Math.abs(Number(x.line)-Number(a.line)) <= 2);
    const selectorHit = a.selector && sig.includes(lower(a.selector));
    const exists = /\.html$/i.test(file) && a.selector ? htmlHasElement(source,a.selector) : null;

    let strength = "LOW";
    let reason = "Reference source ditemukan, tetapi korelasi runtime belum cukup kuat.";

    if (exactLine) {
      strength = "HIGH";
      reason = `Telemetry menunjuk tepat ke ${file}:${a.line}; source pada lokasi tersebut menggunakan ${a.property}.`;
    } else if (exists === false && (selectorHit || nearLine)) {
      strength = "HIGH";
      reason = `Selector '${a.selector}' tidak ditemukan pada dokumen pemakai dan berkorelasi dengan runtime.`;
    } else if (selectorHit || nearLine) {
      strength = "MEDIUM";
      reason = `Source ${file}:${a.line} berkorelasi dengan signature/lokasi runtime.`;
    }

    result.push({
      ...a,
      existsInDocument:exists,
      exactLineHit:exactLine,
      nearLineHit:nearLine,
      signatureHit:!!selectorHit,
      evidenceStrength:strength,
      evidenceReason:reason
    });
  }
  return result;
}

async function buildSourceEvidence(targetFile, log) {
  const names = await discoverSystemSurface();
  const evidence = [];
  const results = {};

  for (const name of names) {
    results[name] = await fetchFile(name);
  }

  const htmlResults = Object.fromEntries(
    Object.entries(results).filter(([name]) => /\.html$/i.test(name))
  );

  for (const [name, data] of Object.entries(results)) {
    if (!data.ok || !data.text) continue;
    const loadedBy = /\.js$/i.test(name)
      ? Object.keys(htmlResults).filter(page => extractDependencies(page, htmlResults[page].text).includes(name))
      : [];

    for (const e of exactDomEvidence(name, data.text, log)) {
      let strength = e.evidenceStrength;
      let reason = e.evidenceReason;

      if (loadedBy.length && e.selector) {
        const missingPages = loadedBy.filter(page => htmlHasElement(htmlResults[page].text,e.selector) === false);
        if (missingPages.length && (e.signatureHit || e.nearLineHit || e.exactLineHit)) {
          strength = "HIGH";
          reason = `Script ${name} dipakai oleh ${missingPages.join(", ")} tetapi selector '${e.selector}' tidak ada di halaman tersebut.`;
        }
      }

      if (strength !== "LOW" || e.signatureHit || e.exactLineHit) {
        evidence.push({
          ...e,
          loadedBy,
          score: ({HIGH:3,MEDIUM:2,LOW:1}[strength] || 0) +
            (e.exactLineHit ? 3 : 0) +
            (e.signatureHit ? 2 : 0) +
            (loadedBy.length ? 1 : 0)
        });
      }
    }
  }

  evidence.sort((a,b) => b.score-a.score || a.line-b.line);
  return evidence.slice(0,30).map(({score,...e}) => e);
}

function buildExactDomOperation(file, source, evidence, signature) {
  if (!evidence || evidence.evidenceStrength !== "HIGH") return null;
  const property = evidence.property;
  const selector = evidence.selector;
  if (!property || !evidence.before) return null;

  if (evidence.kind === "DIRECT" && selector) {
    const accessor =
      evidence.before.match(/document\.getElementById\(\s*["'][^"']+["']\s*\)/)?.[0] ||
      evidence.before.match(/document\.querySelector\(\s*["'][^"']+["']\s*\)/)?.[0] ||
      evidence.before.match(/\$\(\s*["'][^"']+["']\s*\)/)?.[0];

    if (!accessor) return null;
    const rhs = evidence.rhs;
    const after = `{ const __medicineEl = ${accessor}; if (__medicineEl) __medicineEl.${property} = ${rhs}; }`;

    return {
      type:"REPLACE_EXACT",
      file,
      line:evidence.line,
      before:evidence.before,
      after,
      selector,
      property,
      reason:`Guard DOM '${selector}' sebelum assignment ${property}.`,
      evidenceReason:evidence.evidenceReason
    };
  }

  // For a bound variable, only propose a guard when the runtime line is exact.
  if (evidence.kind === "BOUND" && evidence.variable && evidence.exactLineHit) {
    const after = `{ if (${evidence.variable}) ${evidence.variable}.${property} = ${evidence.rhs}; }`;
    return {
      type:"REPLACE_EXACT",
      file,
      line:evidence.line,
      before:evidence.before,
      after,
      selector:evidence.variable,
      property,
      reason:`Guard reference '${evidence.variable}' sebelum assignment ${property}.`,
      evidenceReason:evidence.evidenceReason
    };
  }

  return null;
}

function operationRisk(op) {
  if (!op?.before || !op?.after) return "HIGH";
  if (op.type !== "REPLACE_EXACT") return "HIGH";
  if (op.before.length > 5000 || op.after.length > 7000) return "MEDIUM";
  return "LOW";
}

function fingerprint(value) {
  let h = 2166136261;
  for (const ch of String(value ?? "")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h,16777619);
  }
  return (h >>> 0).toString(16).padStart(8,"0");
}

function buildCodePrescription(plan) {
  const operations = Array.isArray(plan?.operations) ? plan.operations : [];
  const evidence = Array.isArray(plan?.sourceEvidence) ? plan.sourceEvidence : [];
  const items = operations.map((op,index) => {
    const ev = evidence.find(e =>
      e.file === op.file &&
      (e.line == null || op.line == null || Number(e.line) === Number(op.line))
    ) || evidence.find(e => e.file === op.file);

    return {
      index,
      file:op.file,
      line:op.line ?? null,
      type:op.type,
      before:String(op.before || ""),
      after:String(op.after || ""),
      fullCode:typeof op.fullCode === "string" ? op.fullCode : "",
      reason:text(op.reason,1200),
      evidenceStrength:ev?.evidenceStrength || "UNVERIFIED",
      evidenceReason:text(ev?.evidenceReason || "",1400),
      context:plan?._sourceContext?.[index] || null,
      risk:operationRisk(op),
      beforeHash:fingerprint(op.before),
      afterHash:fingerprint(op.after)
    };
  });

  const rootProven = [
    "CONFIRMED_ORIGINAL_TARGET",
    "TARGET_CORRECTED_BY_MEDICINE",
    "CONTRACT_ROOT_CAUSE_IDENTIFIED"
  ].includes(plan?.rootCauseStatus);

  const exact = items.length > 0 &&
    items.every(x => (x.type === "REPLACE_EXACT" || x.type === "INSERT_EXACT") && x.before && x.after);

  const high = items.every(x => x.evidenceStrength === "HIGH");

  return {
    ready: plan?.precisionGate === true && rootProven && exact && high,
    status: plan?.precisionGate === true && rootProven && exact && high
      ? "READY_TO_COPY"
      : "REVIEW_REQUIRED",
    targetFile:plan?.rootCauseFile || plan?.target || null,
    rootCauseStatus:plan?.rootCauseStatus || "UNPROVEN",
    evidenceCount:evidence.length,
    items,
    instruction: plan?.precisionGate === true && rootProven && exact && high
      ? "Review BEFORE → AFTER. Copy solusi hanya setelah manusia menyatakan perubahan benar."
      : "Precision Gate belum lulus. Medicine menahan solusi sampai root cause, evidence HIGH dan operasi exact terbukti."
  };
}

async function attachSourceContext(plan) {
  plan._sourceContext = {};
  for (let i=0;i<(plan.operations || []).length;i++) {
    const op = plan.operations[i];
    if (!op?.file || !op?.line) continue;
    const src = await fetchFile(op.file);
    plan._sourceContext[i] = src.ok ? sourceContext(src.text,op.line,4) : null;
  }
  plan.codePrescription = buildCodePrescription(plan);
  return plan;
}

function buildRepairPlan(c, verification) {
  return {
    planId:`REPAIR-${uid().toUpperCase()}`,
    caseId:c.id,
    target:c.source,
    originalTarget:c.source,
    rootCauseFile:verification?.rootCauseFile || c.source,
    rootCauseStatus:verification?.rootCauseStatus || "UNPROVEN",
    diagnosis:c.diagnosis,
    verification,
    strategy:"MINIMAL_SAFE_EXACT_CHANGE",
    operations:[],
    beforeAfter:[],
    candidates:verification?.rootCauseCandidates || [],
    sourceEvidence:verification?.sourceEvidence || [],
    preconditions:[
      "Root cause must be supported by exact runtime/source evidence.",
      "Source operation must be an exact replacement, never broad search-and-replace.",
      "Human approval is mandatory before executor use.",
      "Medicine itself never writes repository source."
    ],
    postconditions:[
      "Original runtime signature no longer recurs.",
      "Repaired source remains readable/loadable.",
      "Exact AFTER text is present and exact BEFORE text is absent.",
      "Relevant cross-file consistency remains valid."
    ],
    precision:{
      exactTargetRequired:true,
      exactEvidenceRequired:true,
      exactOperationRequired:true,
      noGuessing:true,
      humanApprovalRequired:true,
      crossFileProofRequired:true
    },
    precisionGate:false,
    status:"PATCH_REQUIRES_REVIEW",
    blockReason:"Evidence belum cukup untuk membuka Precision Gate.",
    sourceWrite:false,
    requiresHumanApproval:true,
    requiresPostValidation:true,
    createdAt:now()
  };
}

function extractRuntimeSymbol(log, caseItem=null) {
  const msg=String(log?.message||log?.error||log?.text||"");
  const explicit=log?.symbol || log?.details?.symbol || caseItem?.diagnosis?.symbol;
  if(explicit) return String(explicit).trim();
  return msg.match(/(?:ReferenceError|is not defined|not defined)\s*:?[\s]*([A-Za-z_$][\w$]*)/i)?.[1] || null;
}
function symbolDefinitionHits(source,symbol){
  const s=String(source||""), n=escRe(symbol);
  const patterns=[
    new RegExp(`(?:^|\\n)\\s*(?:async\\s+)?function\\s+${n}\\s*\\(`,'g'),
    new RegExp(`\\b(?:const|let|var)\\s+${n}\\s*=`, 'g'),
    new RegExp(`\\bwindow\\.${n}\\s*=`, 'g'),
    new RegExp(`\\bglobalThis\\.${n}\\s*=`, 'g')
  ];
  const out=[]; for(const re of patterns){let m;while((m=re.exec(s))&&out.length<20)out.push({line:lineOf(s,m.index),snippet:m[0].trim()});} return out.sort((a,b)=>a.line-b.line);
}
function symbolCallHits(source,symbol){
  const s=String(source||""), n=escRe(symbol); const re=new RegExp(`\\b${n}\\s*\\(`,'g'); const out=[];let m;while((m=re.exec(s))&&out.length<30)out.push({line:lineOf(s,m.index),snippet:s.split(/\r?\n/)[lineOf(s,m.index)-1]?.trim().slice(0,260)||""});return out;
}
async function buildUndefinedSymbolEvidence(targetFile,log,caseItem=null){
  const symbol=extractRuntimeSymbol(log, caseItem); if(!symbol)return null;
  const names=await discoverSystemSurface(); const rows=[]; let definitions=[],calls=[];
  for(const name of names){const src=await fetchFile(name);if(!src.ok||!src.text)continue;const defs=symbolDefinitionHits(src.text,symbol);const hits=symbolCallHits(src.text,symbol);if(defs.length)definitions.push(...defs.map(x=>({file:name,...x})));if(hits.length)calls.push(...hits.map(x=>({file:name,...x})));}
  const targetCalls=calls.filter(x=>normalizeFile(x.file)===normalizeFile(targetFile));
  if(!targetCalls.length && !calls.length)return null;
  const sameFileDefs=definitions.filter(x=>normalizeFile(x.file)===normalizeFile(targetFile));
  const allEvidence=[];
  for(const hit of targetCalls.slice(0,12)) allEvidence.push({file:hit.file,line:hit.line,symbol,kind:"SYMBOL_CALL_SITE",before:hit.snippet,evidenceStrength:"HIGH",evidenceReason:`Runtime melaporkan simbol ${symbol} tidak tersedia dan source aktual ${hit.file}:${hit.line} memang memanggil simbol tersebut.`});
  if(!definitions.length){
    return {symbol,definitions,calls,sourceEvidence:allEvidence,rootCauseStatus:targetCalls.length?"CONTRACT_ROOT_CAUSE_IDENTIFIED":"UNPROVEN",rootCauseFile:targetFile,rootCauseCandidates:[{file:targetFile,line:targetCalls[0]?.line||null,symbol,reason:`Simbol ${symbol} dipanggil pada runtime tetapi tidak memiliki definisi pada seluruh source diagnostic yang berhasil dibaca.`,evidenceStrength:"HIGH"}],resolvedOperation:null,reason:"SYMBOL_DEFINITION_MISSING_ACROSS_SCANNED_SURFACE"};
  }
  const providerFiles=[...new Set(definitions.map(x=>x.file))];
  return {symbol,definitions,calls,sourceEvidence:[...allEvidence,...definitions.slice(0,12).map(d=>({file:d.file,line:d.line,symbol,kind:"SYMBOL_DEFINITION",before:d.snippet,evidenceStrength:"HIGH",evidenceReason:`Definisi ${symbol} ditemukan di ${d.file}:${d.line}; Medicine harus memverifikasi loading/scope runtime sebelum menyimpulkan root cause.`}))],rootCauseStatus:sameFileDefs.length?"CONTRACT_ROOT_CAUSE_IDENTIFIED":"UNPROVEN",rootCauseFile:targetFile,rootCauseCandidates:[{file:targetFile,line:targetCalls[0]?.line||null,symbol,providerFiles,reason:sameFileDefs.length?`Runtime menyatakan ${symbol} undefined walau definisinya ada di source yang sama; indikasi kuat masalah scope/load order.`:`${symbol} dipanggil di ${targetFile} tetapi definisinya berada di provider ${providerFiles.join(", ")}; loading/import scope harus diverifikasi.`,evidenceStrength:"HIGH"}],resolvedOperation:null,reason:"SYMBOL_RUNTIME_AVAILABILITY_REQUIRES_SCOPE_VERIFICATION"};
}
async function resolveRootCause(c) {
  const log = c.evidence || {};
  const original = normalizeFile(c.source) || c.source;
  const locations = parseRuntimeLocations(log)
    .filter(loc => isDiagnosticFile(loc.file));

  // 0. Runtime undefined-symbol proof. This path converts visible ReferenceError
  // telemetry into exact source evidence instead of leaving Medicine at 0 evidence.
  if (c.diagnosis?.code === "UNDEFINED_SYMBOL" || /(?:ReferenceError|is not defined|not defined)/i.test(String(log?.message||log?.error||""))) {
    const symbolProof=await buildUndefinedSymbolEvidence(original,log,c);
    if(symbolProof?.sourceEvidence?.length){
      return {rootCauseFile:symbolProof.rootCauseFile,rootCauseStatus:symbolProof.rootCauseStatus,sourceEvidence:symbolProof.sourceEvidence,candidates:symbolProof.rootCauseCandidates,resolvedOperation:null};
    }
  }

  // 1. Exact runtime file + line.
  for (const loc of locations.filter(x => x.file && x.line && REGISTRY[x.file])) {
    const src = await fetchFile(loc.file);
    if (!src.ok) continue;

    const ctx = sourceContext(src.text,loc.line,3);
    const suspicious = ctx.lines.find(x =>
      /textContent|innerHTML|className|\.value\s*=|appendChild|querySelector|getElementById|classList|style\./.test(x.code)
    );

    if (suspicious) {
      const evidence = exactDomEvidence(loc.file,src.text,log)
        .find(x => Number(x.line) === Number(loc.line));

      if (evidence) {
        return {
          rootCauseFile:loc.file,
          rootCauseStatus:loc.file === original ? "CONFIRMED_ORIGINAL_TARGET" : "TARGET_CORRECTED_BY_MEDICINE",
          sourceEvidence:[{
            ...evidence,
            line:loc.line,
            evidenceStrength:"HIGH",
            evidenceReason:`Runtime location exact ${loc.file}:${loc.line} cocok dengan source.`
          }],
          candidates:[{
            file:loc.file,
            line:loc.line,
            context:ctx,
            evidenceStrength:"HIGH"
          }],
          resolvedOperation:buildExactDomOperation(loc.file,src.text,{...evidence,evidenceStrength:"HIGH",exactLineHit:true},c.signature)
        };
      }
    }
  }

  // 2. Complete source evidence surface.
  const candidates = await buildSourceEvidence(original,log);
  const best = candidates.find(x => x.evidenceStrength === "HIGH");

  if (best) {
    const src = await fetchFile(best.file);
    const op = buildExactDomOperation(best.file,src.text,best,c.signature);
    return {
      rootCauseFile:best.file,
      rootCauseStatus:best.file === original ? "CONFIRMED_ORIGINAL_TARGET" : "TARGET_CORRECTED_BY_MEDICINE",
      sourceEvidence:candidates.slice(0,20),
      candidates:candidates.slice(0,20),
      resolvedOperation:op
    };
  }

  // 3. Contract issue: prove the side of the contract that is incomplete.
  if (c.diagnosis.code === "DATA_CONSISTENCY") {
    const scan = await scanConsistency();
    const relevant = scan.findings.filter(f =>
      ["SOURCE_CONTRACT_GAP","ADMIN_PRESENTATION_GAP","SYSTEM_COVERAGE_GAP"].includes(f.kind)
    );
    const gap = relevant.find(f =>
      f.sourceFile === original || f.targetFile === original || f.relatedFile === original
    );

    if (gap) {
      return {
        rootCauseFile:gap.kind === "ADMIN_PRESENTATION_GAP"
          ? gap.targetFile
          : (gap.sourceFile || original),
        rootCauseStatus:"CONTRACT_ROOT_CAUSE_IDENTIFIED",
        sourceEvidence:[{
          file:gap.sourceFile,
          targetFile:gap.targetFile,
          missing:gap.missing || [],
          evidenceStrength:"HIGH",
          evidenceReason:"Gap kontrak terbukti melalui scan lintas-file."
        }],
        candidates:relevant.slice(0,20),
        resolvedOperation:null
      };
    }
  }

  return {
    rootCauseFile:original,
    rootCauseStatus:"UNPROVEN",
    sourceEvidence:candidates.slice(0,20),
    candidates:candidates.slice(0,20),
    resolvedOperation:null
  };
}

function investigationEvidenceToken(log) {
  if (!log) return "NO_EVIDENCE";
  return [
    log.id || log.eventId || "",
    log.reportedAt || log.createdAt || log.timestamp || "",
    log.fileName || log.source || log.file || "",
    log.lineNumber ?? log.line ?? log.lineno ?? "",
    log.columnNumber ?? log.column ?? log.col ?? "",
    log.message || log.error || "",
    log.stack || log.stackTrace || log.errorStack || ""
  ].map(v => String(v ?? "")).join("|").slice(0,5000);
}

const AUTO_REINVESTIGATE_STATUSES = new Set([
  "INVESTIGATION_BLOCKED",
  "INVESTIGATING",
  "PATCH_REQUIRES_REVIEW",
  "PATCH_FAILED"
]);

let investigationDrainScheduled = false;

function queueAutoInvestigation(caseItem, reason = "telemetry") {
  if (!caseItem?.id || S.human.paused || isTerminal(caseItem)) return false;
  if (!AUTO_REINVESTIGATE_STATUSES.has(caseItem.status)) return false;

  const evidenceToken = investigationEvidenceToken(caseItem.lastEvidence || caseItem.evidence);
  if (caseItem.lastInvestigatedEvidenceToken === evidenceToken) return false;

  S.investigationQueue.set(caseItem.id, {
    caseId:caseItem.id,
    evidenceToken,
    reason,
    queuedAt:Date.now()
  });

  emit("investigation_queued", {
    case:caseItem,
    reason,
    evidenceToken
  });

  scheduleInvestigationDrain();
  return true;
}

function scheduleInvestigationDrain() {
  if (investigationDrainScheduled) return;
  investigationDrainScheduled = true;
  setTimeout(() => {
    investigationDrainScheduled = false;
    void drainInvestigationQueue();
  }, 0);
}

async function drainInvestigationQueue() {
  if (S.human.paused || S.busy.verification) return;

  const queued = [...S.investigationQueue.values()]
    .map(item => ({
      ...item,
      caseItem:S.cases.find(c => c.id === item.caseId)
    }))
    .filter(item => item.caseItem && !isTerminal(item.caseItem) && !S.human.paused);

  if (!queued.length) {
    S.investigationQueue.clear();
    return;
  }

  queued.sort((a,b) => {
    const at = Date.parse(a.caseItem?.lastSeenAt || a.caseItem?.createdAt || "") || 0;
    const bt = Date.parse(b.caseItem?.lastSeenAt || b.caseItem?.createdAt || "") || 0;
    return bt - at;
  });

  const next = queued[0];
  S.investigationQueue.delete(next.caseId);
  const c = next.caseItem;
  const currentToken = investigationEvidenceToken(c.lastEvidence || c.evidence);

  if (c.lastInvestigatedEvidenceToken === currentToken) {
    scheduleInvestigationDrain();
    return;
  }

  S.activeCase = c;
  c.lastInvestigatedEvidenceToken = currentToken;
  c.lastInvestigationStartedAt = now();
  c.lastInvestigationReason = next.reason;

  emit("investigation_auto_reopened", {
    case:c,
    reason:next.reason,
    evidenceToken:currentToken
  });

  try {
    await verifyWithMedicine(c.source, {
      requestedBy:"telemetry_auto_recovery",
      question:`Re-investigasi realtime: ${c.signature}`,
      noRetry:true,
      autoRecovery:true,
      reason:next.reason
    });
  } catch (error) {
    delete c.lastInvestigatedEvidenceToken;
    emit("investigation_error", {
      caseId:c.id,
      message:error?.message || String(error),
      autoRecovery:true
    });
  } finally {
    scheduleInvestigationDrain();
  }
}

let recoveryMonitorRunning = false;

async function monitorBlockedCaseSource() {
  if (recoveryMonitorRunning || !auth.currentUser || S.human.paused || S.busy.verification) return;

  const candidates = activeCases()
    .filter(c => AUTO_REINVESTIGATE_STATUSES.has(c.status))
    .slice(0,3);
  if (!candidates.length) return;

  recoveryMonitorRunning = true;
  try {
    for (const c of candidates) {
      if (S.human.paused || S.busy.verification) break;
      const target = c.rootCauseFile || c.source;
      const source = await fetchFile(target, { force:true });
      if (!source.ok || typeof source.text !== "string") continue;

      const sourceFingerprint = fingerprint(source.text);
      const previousFingerprint = c.lastObservedSourceFingerprint || null;
      c.lastObservedSourceFingerprint = sourceFingerprint;

      // This is the missing recovery path: if the source changes while a case
      // is blocked, Medicine automatically reopens investigation. No refresh
      // and no human Verify click are required.
      if (previousFingerprint && previousFingerprint !== sourceFingerprint) {
        queueAutoInvestigation(c, "source_changed_while_monitoring");
      }
    }
  } finally {
    recoveryMonitorRunning = false;
  }
}

function startRecoveryMonitor() {
  if (window.__BCGO_MEDICINE_RECOVERY_MONITOR) return;
  window.__BCGO_MEDICINE_RECOVERY_MONITOR = setInterval(() => {
    void monitorBlockedCaseSource();
  }, 10000);
}

function makeCase(log, options = {}) {
  const source = normalizeFile(log?.fileName || log?.source || log?.file) || "UNKNOWN";
  if (!isDiagnosticFile(source)) return null;
  const signature = text(log?.message || log?.error || "Unknown error",700);
  const evidenceId = String(log?.id || log?.eventId || "").trim();

  const sameEvidenceCase = evidenceId
    ? S.cases.find(c => c.evidenceId === evidenceId)
    : null;

  if (sameEvidenceCase) {
    // Firestore can update the same telemetry document in place. Do not treat
    // that as a duplicate forever: if its evidence revision changed, feed the
    // changed evidence back into the realtime investigation queue.
    const previousToken = investigationEvidenceToken(sameEvidenceCase.lastEvidence || sameEvidenceCase.evidence);
    const nextToken = investigationEvidenceToken(log);
    if (previousToken === nextToken) return sameEvidenceCase;
  }

  let existing = sameEvidenceCase || S.cases.find(c =>
    c.source === source &&
    c.signature === signature &&
    ACTIVE_STATUSES.has(c.status)
  );

  if (existing) {
    const previousEvidenceToken = investigationEvidenceToken(existing.lastEvidence || existing.evidence);
    existing.evidenceCount = (existing.evidenceCount || 1) + 1;
    existing.lastSeenAt = now();
    existing.lastEvidence = log;
    S.activeCase = existing;
    emit("case_updated",{case:existing,mergedEvidence:true});

    const nextEvidenceToken = investigationEvidenceToken(log);
    if (nextEvidenceToken !== previousEvidenceToken) {
      queueAutoInvestigation(existing, "new_telemetry_evidence");
    }
    return existing;
  }

  const d = classifyError(signature);
  const c = {
    id:`CASE-${uid().toUpperCase()}`,
    evidenceId:evidenceId || null,
    source,
    signature,
    diagnosis:d,
    prescription:{
      treatment:d.treatment,
      risk:["DOM_REFERENCE_REVIEW","CROSS_FILE_REVIEW"].includes(d.treatment) ? "LOW" : "HIGH",
      mode:"EVIDENCE_FIRST"
    },
    status:"DIAGNOSED",
    createdAt:now(),
    lastSeenAt:now(),
    evidenceCount:1,
    evidence:log,
    lastEvidence:log,
    runtimeLocation:{
      file:source,
      line:Number(log?.lineNumber ?? log?.line ?? log?.lineno) || null,
      col:Number(log?.columnNumber ?? log?.column ?? log?.col) || null,
      stack:text(log?.stack || log?.stackTrace || "",1800)
    },
    rootCauseFile:source,
    rootCauseStatus:"UNPROVEN",
    sourceEvidence:[],
    repairPlan:null,
    patchProposal:null,
    validation:null,
    investigationSessionId:`INV-${uid().toUpperCase()}`
  };

  S.cases.unshift(c);
  S.cases = S.cases.slice(0,100);
  S.activeCase = c;

  emit("case_created",{case:c});
  publishInvestigationRequest(c, "STARTED", {
    message:"Case telemetry diterima. Execution diminta ikut memantau investigasi sebelum kandidat repair dibuka."
  });

  void safeAddMessage(
    "bcgo",
    `Saya menemukan evidence nyata pada ${source}: ${d.title}. Saya serahkan ${c.id} ke Medicine untuk pembuktian akar masalah.`,
    {kind:"BCGO_HANDOFF",caseId:c.id,target:source}
  );

  void safeAddMessage(
    "medicine",
    `Case ${c.id} diterima. Saya akan memeriksa dependency, runtime location dan source exact sebelum membuka treatment.`,
    {kind:"MEDICINE_ACK",caseId:c.id,target:source}
  );

  if (options.autoInvestigate !== false && !S.human.paused) {
    queueAutoInvestigation(c, "new_case");
  }

  return c;
}

function startTelemetry() {
  if (!auth.currentUser || S.telemetry.started) return;
  S.telemetry.started = true;
  S.telemetry.transport = "FIRESTORE_DIRECT";
  emit("telemetry_transport",{transport:S.telemetry.transport});

  const q = query(
    collection(db,"system_logs"),
    orderBy("reportedAt","desc"),
    limit(100)
  );

  try {
    const unsub = onSnapshot(q,snapshot => {
      const first = !S.telemetry.initialized;
      S.telemetry.initialized = true;
      S.logs = snapshot.docs.map(d => ({id:d.id,...d.data()}));

      const top = S.logs[0];
      const isNew = !!top?.id && top.id !== S.telemetry.lastId;
      S.telemetry.lastId = top?.id || S.telemetry.lastId;

      emit("telemetry",{
        logs:S.logs,
        transport:S.telemetry.transport,
        newEvent:isNew ? top : null
      });

      for (const log of S.logs.slice(0,80)) {
        makeCase(log,{autoInvestigate:!first});
      }

      if (first) {
        const c = activeCases()[0];
        if (c && !S.human.paused) queueAutoInvestigation(c, "initial_telemetry");
      }

      // An INVESTIGATION_BLOCKED case must not become a dead end. Every realtime
      // snapshot gets a chance to resume it, but only when its evidence
      // revision changed, so this remains event-driven rather than a scan loop.
      for (const c of activeCases()) {
        queueAutoInvestigation(c, "telemetry_recovery");
      }
    },error => {
      const info = classifyFirestoreError(error);
      S.telemetry.transport = "ERROR";
      emit("telemetry_error",{
        message:info.message,
        code:info.code,
        permissionDenied:info.permission
      });
    });

    if (typeof unsub === "function") S.listeners.push(unsub);
  } catch (error) {
    emit("telemetry_error",{message:error?.message || String(error)});
  }
}

function startConversation() {
  if (!auth.currentUser) return;
  const q = query(
    collection(db,"medicine_messages"),
    orderBy("createdAt","desc"),
    limit(200)
  );

  try {
    const unsub = onSnapshot(q,snapshot => {
      const seen = new Set();
      S.messages = snapshot.docs.map(d => ({id:d.id,...d.data()})).reverse().filter(m => {
        const key = m.clientMessageId || m.id;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      emit("conversation",{messages:S.messages,transport:"FIRESTORE"});
    },error => emit("conversation_error",{message:error?.message || String(error)}));

    if (typeof unsub === "function") S.listeners.push(unsub);
  } catch (error) {
    emit("conversation_error",{message:error?.message || String(error)});
  }
}

function startRuleHealthMonitor() {
  if (!auth.currentUser) return;
  S.rules = {status:"CHECKING",checkedAt:now(),collections:{},permissionErrors:[]};
  emit("rules_health",{rules:S.rules});

  for (const name of RULE_PROBES) {
    try {
      const q = query(collection(db,name),limit(1));
      const unsub = onSnapshot(q,
        snapshot => {
          S.rules.collections[name] = {
            status:"READ_OK",
            count:snapshot.size,
            checkedAt:now()
          };
          updateRuleSummary();
        },
        error => {
          const info = classifyFirestoreError(error);
          S.rules.collections[name] = {
            status:info.permission ? "PERMISSION_DENIED" : "ERROR",
            code:info.code,
            error:info.message,
            checkedAt:now()
          };
          updateRuleSummary();
        }
      );
      if (typeof unsub === "function") S.listeners.push(unsub);
    } catch (error) {
      const info = classifyFirestoreError(error);
      S.rules.collections[name] = {
        status:info.permission ? "PERMISSION_DENIED" : "ERROR",
        code:info.code,
        error:info.message,
        checkedAt:now()
      };
      updateRuleSummary();
    }
  }
}

function updateRuleSummary() {
  const entries = Object.entries(S.rules.collections);
  S.rules.permissionErrors = entries
    .filter(([,v]) => v.status === "PERMISSION_DENIED")
    .map(([collectionName,v]) => ({collection:collectionName,...v}));

  if (S.rules.permissionErrors.length) S.rules.status = "PERMISSION_DENIED";
  else if (entries.some(([,v]) => v.status === "ERROR")) S.rules.status = "ERROR";
  else if (entries.length === RULE_PROBES.length) S.rules.status = "READ_OK";
  else S.rules.status = "CHECKING";

  S.rules.checkedAt = now();
  emit("rules_health",{rules:{...S.rules}});
}

async function scanConsistency(targets = null) {
  if (S.busy.scan) return {results:{},findings:S.findings,busy:true};
  S.busy.scan = true;
  emit("scan_started",{});

  try {
    const names = targets?.length
      ? targets.filter(n => REGISTRY[n] && isDiagnosticFile(n))
      : await discoverSystemSurface();

    const results = {};
    for (const name of names) {
      const file = await fetchFile(name);
      results[name] = {...file,fields:extractFields(name,file.text)};
    }

    const findings = [];

    // Required source contracts.
    for (const [type, required] of Object.entries(REQUIRED)) {
      const source =
        type === "driver" ? "driver.html" :
        type === "restaurant" ? "resto.html" :
        type === "assistant" ? "agentcgo.html" :
        "index.html";

      const data = results[source];
      if (!data?.ok) continue;

      const present = canonicalFields(data.fields);
      const missing = required.filter(field =>
        !present.has(field) &&
        !(FIELD_ALIASES[field] || []).some(alias => present.has(alias))
      );

      if (missing.length) {
        findings.push({
          kind:"SOURCE_CONTRACT_GAP",
          sourceFile:source,
          missing
        });
      }
    }

    // Admin presentation gaps.
    const admin = results["bcgo-admin.html"];
    if (admin?.ok) {
      const adminFields = canonicalFields(admin.fields);
      const sourcePages = names.filter(n =>
        /\.html$/i.test(n) &&
        !["bcgo-medicine.html","bcgo.html"].includes(n)
      );

      for (const source of sourcePages) {
        const present = [...canonicalFields(results[source]?.fields || [])]
          .filter(f => CONTRACT_FIELDS.has(f) || Object.values(FIELD_ALIASES).flat().includes(f));

        const missing = present.filter(field =>
          !adminFields.has(field) &&
          !(FIELD_ALIASES[field] || []).some(alias => adminFields.has(alias))
        );

        if (missing.length) {
          findings.push({
            kind:"ADMIN_PRESENTATION_GAP",
            sourceFile:source,
            targetFile:"bcgo-admin.html",
            missing:[...new Set(missing)]
          });
        }
      }
    }

    // System coverage drift: Medicine must know what BCGO master references.
    for (const master of ["bcgo.js","bcgo.html"]) {
      const data = results[master];
      if (!data?.ok) continue;

      const refs = new Set([
        ...extractDependencies(master,data.text),
        ...[...data.text.matchAll(/["'`]([A-Za-z0-9_.-]+\.(?:html|js))["'`]/gi)]
          .map(m => normalizeFile(m[1]))
          .filter(Boolean)
      ]);

      const missing = [...refs].filter(ref => !Object.prototype.hasOwnProperty.call(BASE_REGISTRY,ref));
      if (missing.length) {
        findings.push({
          kind:"SYSTEM_COVERAGE_GAP",
          sourceFile:master,
          relatedFile:"bcgo-medicine.js",
          missing,
          detail:"Master BCGO menyebut file yang belum ada pada baseline Medicine."
        });
      }
    }

    S.findings = findings;
    emit("scan_complete",{results,findings});
    return {results,findings};
  } finally {
    S.busy.scan = false;
  }
}

function buildInvestigationDecision(c, v, plan, context = {}) {
  const blockers = [];
  if (!plan?.precisionGate) blockers.push(...(plan?.precisionBlockers || [plan?.blockReason || "PRECISION_GATE_BLOCKED"]));
  if (context.ai?.precisionGate === false) blockers.push(...(context.ai?.blockers || ["INTERNAL_AI_PRECISION_BLOCKED"]));
  const unique = [...new Set(blockers.filter(Boolean))];
  const ready = plan?.precisionGate === true && context.ai?.precisionGate !== false;
  const rootVerified = ["CONFIRMED_ORIGINAL_TARGET","TARGET_CORRECTED_BY_MEDICINE","CONTRACT_ROOT_CAUSE_IDENTIFIED"].includes(plan?.rootCauseStatus);
  const sourceVerified = Array.isArray(plan?.sourceEvidence) && plan.sourceEvidence.some(e => e.evidenceStrength === "HIGH");
  const operationVerified = Array.isArray(plan?.operations) && plan.operations.length > 0;
  let status = "INVESTIGATION_BLOCKED";
  let nextAction = "INVESTIGATE";
  if (ready) { status = "CANDIDATE_READY"; nextAction = "EXECUTOR_REVIEW"; }
  else if (rootVerified && sourceVerified && operationVerified) { status = "ROOT_CAUSE_IDENTIFIED_PATCH_BLOCKED"; nextAction = "RESOLVE_PRECISION_BLOCKERS"; }
  return {
    caseId:c?.id || null, investigationId:c?.investigationSessionId || null,
    attempt:Number(c?.investigationAttempt || 1), maxAttempts:MAX_INVESTIGATION_ATTEMPTS_PER_REVISION,
    target:c?.source || v?.target || null, rootCauseFile:plan?.rootCauseFile || null,
    rootCauseStatus:plan?.rootCauseStatus || "UNPROVEN", evidenceCount:Array.isArray(v?.sourceEvidence)?v.sourceEvidence.length:0,
    highEvidenceCount:Array.isArray(v?.sourceEvidence)?v.sourceEvidence.filter(e=>e.evidenceStrength==="HIGH").length:0,
    runtimeEvidenceCount:Array.isArray(v?.runtimeEvidence)?v.runtimeEvidence.length:0, operationCount:Array.isArray(plan?.operations)?plan.operations.length:0,
    precisionGate:ready, status, missingEvidence:unique, nextAction,
    aiDirective: context.ai?.operationalInvestigation?.evidenceRequests || context.ai?.investigation?.nextEvidence || null,
    message:ready ? "Candidate exact terbukti dan siap untuk deterministic Executor review." : (rootVerified ? "Root cause sudah teridentifikasi, tetapi Precision Gate masih terkunci." : "Medicine belum dapat membuktikan root cause dan exact source secara penuh."),
    reason:unique.join(" | ") || null, revisionToken:c?.lastInvestigatedRevisionToken || null, decidedAt:now(), trigger:context.trigger || "verification"
  };
}

function runInternalAIReasoning(c, v, plan, context = {}) {
  let result = null;
  try {
    result = internalAIReason({
      target:c?.source || v?.target || null,
      errorLog:c?.lastEvidence || c?.evidence || null,
      activeCases:activeCases(), latestLogs:S.logs.slice(0,50),
      sourceScan:S.bcgoSourceScan, recentEvents:context.recentEvents || [], bcgoAIContext:S.bcgoAIContext || null,
      medicineEvidence:Array.isArray(v?.sourceEvidence) ? v.sourceEvidence : [],
      sourceFingerprint:c?.lastObservedSourceFingerprint || null,
      medicinePlan:plan ? {
        rootCauseFile:plan.rootCauseFile,
        rootCauseStatus:plan.rootCauseStatus,
        precisionGate:!!plan.precisionGate,
        operationCount:Array.isArray(plan.operations)?plan.operations.length:0,
        candidates:Array.isArray(plan.candidates) ? plan.candidates : [],
        operations:Array.isArray(plan.operations) ? plan.operations : []
      } : null
    }, context.history || {});
  } catch (error) {
    result = {version:"V5_BRIDGE_ERROR",classification:"ERROR",evidence:[],hypotheses:[],selectedHypothesisId:null,precisionGate:{pass:false,blockers:[`INTERNAL_AI_ERROR:${error?.message||String(error)}`]},investigation:{status:"BLOCKED"}};
  }
  S.aiCore={version:result.version||null,classification:result.classification||"UNKNOWN",precisionGate:result.precisionGate?.pass===true,blockers:Array.isArray(result.precisionGate?.blockers)?result.precisionGate.blockers:[],evidenceCount:result.evidence?.length||0,hypothesisCount:result.hypotheses?.length||0,selectedHypothesisId:result.selectedHypothesisId||null,investigation:result.investigation||null,operationalInvestigation:result.operationalInvestigation||null,lastAt:now()};
  emit("internal_ai_state",{case:c, ai:S.aiCore});
  return result;
}

async function verifyWithMedicine(targetFile = null, context = {}) {
  if (S.busy.verification) return S.verification;
  S.busy.verification = true;

  try {
    const requestedTarget = normalizeFile(targetFile) && REGISTRY[normalizeFile(targetFile)]
      ? normalizeFile(targetFile)
      : (S.activeCase?.source || "bcgo.html");

    emit("verification_started",{target:requestedTarget,context});

    const scan = await scanConsistency();
    const runtimeEvidence = S.logs
      .filter(l => normalizeFile(l.fileName || l.source || l.file) === requestedTarget)
      .slice(0,10);

    let c = S.activeCase;
    if (!c || c.source !== requestedTarget) {
      c = activeCases().find(x => x.source === requestedTarget) || null;
    }

    const v = {
      requestedTarget,
      target:requestedTarget,
      verdict:"INSUFFICIENT_EVIDENCE",
      rootCauseFile:requestedTarget,
      rootCauseStatus:"UNPROVEN",
      rootCauseCandidates:[],
      sourceEvidence:[],
      runtimeEvidence,
      checkedFiles:scan.results ? Object.keys(scan.results) : [],
      checkedCount:scan.results ? Object.keys(scan.results).length : 0,
      targetFindings:(scan.findings || []).filter(f =>
        f.sourceFile === requestedTarget || f.targetFile === requestedTarget
      ),
      executionReview:null,
      checkedAt:now(),
      question:context.question || null
    };

    if (c) {
      S.activeCase = c;
      c.status = "INVESTIGATING";
      publishInvestigationRequest(c, "INVESTIGATING", {
        message:"Medicine sedang menelusuri target → dependency → source exact. Execution ikut menerima status investigasi, tetapi belum diberi perintah eksekusi."
      });

      const resolution = await resolveRootCause(c);
      v.rootCauseFile = resolution.rootCauseFile || requestedTarget;
      v.rootCauseStatus = resolution.rootCauseStatus || "UNPROVEN";
      v.rootCauseCandidates = resolution.candidates || [];
      v.sourceEvidence = resolution.sourceEvidence || [];

      const plan = buildRepairPlan(c,v);
      plan.rootCauseFile = v.rootCauseFile;
      plan.rootCauseStatus = v.rootCauseStatus;
      plan.candidates = v.rootCauseCandidates;
      plan.sourceEvidence = v.sourceEvidence;

      if (resolution.resolvedOperation) {
        plan.operations.push(resolution.resolvedOperation);
        plan.beforeAfter.push({
          file:resolution.resolvedOperation.file,
          line:resolution.resolvedOperation.line,
          before:resolution.resolvedOperation.before,
          after:resolution.resolvedOperation.after
        });
      }

      // Internal AI V5 reasons over the completed Medicine evidence surface.
      // It never proves root cause itself; Medicine remains the verification authority.
      const aiReasoning = runInternalAIReasoning(c, v, plan, context);

      const exactEvidence = plan.sourceEvidence.some(e => e.evidenceStrength === "HIGH");
      const exactOps = plan.operations.length > 0 &&
        plan.operations.every(op =>
          (op.type === "REPLACE_EXACT" || op.type === "INSERT_EXACT") &&
          op.before &&
          op.after &&
          op.file === plan.rootCauseFile
        );

      const rootProven = [
        "CONFIRMED_ORIGINAL_TARGET",
        "TARGET_CORRECTED_BY_MEDICINE",
        "CONTRACT_ROOT_CAUSE_IDENTIFIED"
      ].includes(plan.rootCauseStatus);

      // V5 is the reasoning layer, not the final proof authority.
      // Its own gate intentionally stays closed until Medicine verifies root cause/exact source.
      // Therefore Medicine must NOT require aiReasoning.precisionGate.pass here.
      const aiHardBlocked = new Set(["CONTRADICTORY_EVIDENCE","LIVE_STATE_UNAVAILABLE","HYPOTHESIS_MISSING","EVIDENCE_MISSING"]);
      const aiCompatible = !(aiReasoning?.precisionGate?.blockers || []).some(x => aiHardBlocked.has(x));
      plan.precisionGate = !!(exactEvidence && exactOps && rootProven && aiCompatible);
      plan.precisionBlockers = [...new Set([
        ...(exactEvidence ? [] : ["EXACT_HIGH_EVIDENCE_MISSING"]),
        ...(exactOps ? [] : ["EXACT_OPERATION_MISSING"]),
        ...(rootProven ? [] : ["ROOT_CAUSE_UNPROVEN"]),
        ...((aiCompatible) ? [] : (aiReasoning?.precisionGate?.blockers || ["INTERNAL_AI_REASONING_BLOCKED"]))
      ])];

      if (plan.precisionGate) {
        plan.status = "PROPOSED";
        plan.blockReason = null;
        c.status = "VERIFIED_DIAGNOSIS";
      } else {
        plan.status = "PATCH_REQUIRES_REVIEW";
        plan.blockReason =
          "PRECISION GATE TERKUNCI: root cause, evidence HIGH dan operasi exact belum lengkap.";
        c.status = "INVESTIGATION_BLOCKED";
      }

      await attachSourceContext(plan);
      c.repairPlan = plan;
      c.rootCauseFile = plan.rootCauseFile;
      c.rootCauseStatus = plan.rootCauseStatus;
      c.sourceEvidence = plan.sourceEvidence;

      if (plan.precisionGate) {
        publishInvestigationRequest(c, "ROOT_CAUSE_VERIFIED", {
          message:`Root cause terbukti pada ${plan.rootCauseFile}. Execution menerima hasil pembuktian ini dan menunggu candidate exact untuk deterministic preflight; belum ada perintah eksekusi.`
        });
      }

      publishInvestigationRequest(c, plan.precisionGate ? "CANDIDATE_READY" : (plan.sourceEvidence.length ? "EVIDENCE_FOUND" : "INVESTIGATION_BLOCKED"), {
        message: plan.precisionGate
          ? "Medicine menemukan kandidat exact. Execution akan menerima candidate untuk deterministic preflight."
          : plan.sourceEvidence.length
            ? "Evidence ditemukan, tetapi candidate belum aman dibuka; Execution diberi status untuk cross-check berikutnya."
            : "Evidence/source exact belum cukup; Execution tetap ikut memantau tetapi belum melakukan review patch."
      });

      const decision = buildInvestigationDecision(c, v, plan, { ai:{...aiReasoning?.precisionGate, pass:aiCompatible, investigation:aiReasoning?.investigation || null, operationalInvestigation:aiReasoning?.operationalInvestigation || null}, trigger:context.autoRecovery ? "auto_recovery" : "verification" });
      c.investigationDecision = decision;
      emit("investigation_decision", { case:c, decision, ai:S.aiCore });

      v.verdict = plan.precisionGate
        ? "SUPPORTED_BY_EXACT_SOURCE_EVIDENCE"
        : (plan.rootCauseStatus === "CONTRACT_ROOT_CAUSE_IDENTIFIED"
          ? "ROOT_CAUSE_IDENTIFIED_PATCH_BLOCKED"
          : "INSUFFICIENT_EVIDENCE");

      v.target = plan.rootCauseFile;
      c.verification = v;

      const proposal = {
        proposalId:`PATCH-${uid().toUpperCase()}`,
        caseId:c.id,
        telemetryTarget:c.source,
        originalTarget:requestedTarget,
        repairTarget:plan.rootCauseFile,
        rootCauseStatus:plan.rootCauseStatus,
        diagnosis:c.diagnosis,
        verification:v,
        repairPlan:plan,
        operations:plan.operations,
        beforeAfter:plan.beforeAfter,
        precisionGate:plan.precisionGate,
        sourceWrite:false,
        requiresHumanApproval:true,
        requiresPostValidation:true,
        status:plan.precisionGate ? "PROPOSED" : "PATCH_REQUIRES_REVIEW",
        createdAt:now()
      };

      if (proposal.precisionGate) {
        const executionReview = await reviewProposalWithExecutor(c, proposal);
        proposal.executionReview = executionReview;
        v.executionReview = executionReview;
        c.verification = v;
        if (executionReview?.status === "VALID") {
          proposal.status = "READY_FOR_HUMAN_APPROVAL";
          c.status = "READY_FOR_HUMAN_APPROVAL";
        } else {
          proposal.status = "EXECUTION_REVIEW_REJECTED";
          c.status = "INVESTIGATING";
          plan.precisionGate = false;
          plan.status = "PATCH_REQUIRES_REVIEW";
          plan.blockReason = `Execution review belum valid: ${executionReview?.reason || "UNKNOWN"}`;
        }
      }

      c.patchProposal = proposal;
      S.patchProposals.unshift(proposal);
      S.patchProposals = S.patchProposals.slice(0,50);

      emit("patch_proposed",{proposal,case:c});
      emit("case_updated",{case:c});
    } else {
      const synthetic = {
        id:`VERIFY-${uid()}`,
        source:requestedTarget,
        signature:runtimeEvidence[0]?.message || runtimeEvidence[0]?.error || "",
        diagnosis:classifyError(runtimeEvidence[0]?.message || runtimeEvidence[0]?.error || ""),
        evidence:runtimeEvidence[0] || {}
      };
      const resolution = await resolveRootCause(synthetic);
      v.rootCauseFile = resolution.rootCauseFile || requestedTarget;
      v.rootCauseStatus = resolution.rootCauseStatus || "UNPROVEN";
      v.rootCauseCandidates = resolution.candidates || [];
      v.sourceEvidence = resolution.sourceEvidence || [];
      if (v.rootCauseStatus === "CONTRACT_ROOT_CAUSE_IDENTIFIED") {
        v.verdict = "ROOT_CAUSE_IDENTIFIED_PATCH_BLOCKED";
      }
      S.verification = v;
    }

    emit("verification_complete",{verification:v});
    await safeAddMessage(
      "medicine",
      v.verdict === "SUPPORTED_BY_EXACT_SOURCE_EVIDENCE"
        ? `Verifikasi selesai. Root cause terbukti pada ${v.rootCauseFile}. BEFORE → AFTER sudah tersedia dan source tetap terkunci sampai Human Review.`
        : v.verdict === "ROOT_CAUSE_IDENTIFIED_PATCH_BLOCKED"
          ? `Akar masalah sudah dipersempit ke ${v.rootCauseFile}, tetapi operasi exact belum cukup. Saya menahan patch.`
          : `Saya belum bisa membuktikan akar masalah secara exact. Saya menahan treatment dan mempertahankan evidence chain.`,
      {
        kind:"MEDICINE_PRECISION_VERIFICATION",
        target:v.rootCauseFile,
        requestedTarget,
        verdict:v.verdict,
        rootCauseStatus:v.rootCauseStatus,
        checkedFiles:v.checkedFiles
      }
    );

    return v;
  } finally {
    S.busy.verification = false;
  }
}

function canApprove(c) {
  const p = c?.repairPlan;
  const v = c?.verification;
  return !!(
    c &&
    (c.status === "VERIFIED_DIAGNOSIS" || c.status === "READY_FOR_HUMAN_APPROVAL") &&
    p?.precisionGate === true &&
    c.patchProposal?.executionReview?.status === "VALID" &&
    v?.verdict === "SUPPORTED_BY_EXACT_SOURCE_EVIDENCE" &&
    p.operations?.length &&
    p.operations.every(op =>
      (op.type === "REPLACE_EXACT" || op.type === "INSERT_EXACT") &&
      op.file === p.rootCauseFile &&
      op.before &&
      op.after
    )
  );
}

function internalExecutor() {
  const e = window.BCGOInternalExecutor;
  return e && typeof e.execute === "function" ? e : null;
}

function canApplyPatch(c) {
  return false;
  /* legacy executor path intentionally disabled; human copies source manually. */
  const p = c?.repairPlan;
  const v = c?.verification;
  return !!(
    c &&
    c.status === "READY_FOR_PATCH" &&
    v?.verdict === "SUPPORTED_BY_EXACT_SOURCE_EVIDENCE" &&
    p?.precisionGate === true &&
    Array.isArray(p.operations) &&
    p.operations.length === 1 &&
    p.operations[0]?.type === "REPLACE_EXACT" &&
    p.operations[0]?.file === p.rootCauseFile &&
    typeof p.operations[0]?.before === "string" &&
    p.operations[0].before.length > 0 &&
    typeof p.operations[0]?.after === "string"
  );
}

function executorAvailable() {
  return !!internalExecutor();
}

function syncExecutorState() {
  const e = internalExecutor();
  if (!e) {
    S.executor = {
      ...S.executor,
      available: false,
      name: null,
      version: null,
      status: "OFFLINE"
    };
    emit("executor_state", { executor: { ...S.executor } });
    return S.executor;
  }

  let status = null;
  try { status = e.getStatus?.() || null; } catch {}
  S.executor = {
    ...S.executor,
    available: true,
    name: e.name || status?.engine || "BCGO_INTERNAL_EXECUTOR",
    version: e.version || status?.version || null,
    status: status?.status || "READY",
    persistence: status?.persistence || null,
    lastResult: status?.lastResult || S.executor.lastResult || null,
    lastEventAt: now()
  };
  emit("executor_state", { executor: { ...S.executor } });
  return S.executor;
}

function buildExecutorRequest(c, proposal, op, sourceRecord) {
  if (!c || !proposal || !op) throw new Error("EXECUTOR_REQUEST_INPUT_MISSING");
  if (op.type !== "REPLACE_EXACT" && op.type !== "INSERT_EXACT" && op.type !== "REMOVE_EXACT") {
    throw new Error("EXECUTOR_OPERATION_UNSUPPORTED");
  }
  if (!op.file || !op.before || typeof op.after !== "string") {
    throw new Error("EXECUTOR_EXACT_OPERATION_INCOMPLETE");
  }

  return {
    requestId: `REQ-${uid().toUpperCase()}`,
    caseId: c.id,
    proposalId: proposal.proposalId,
    planId: c.repairPlan?.planId || "",
    file: op.file,
    sourceId: op.file,
    operation: op.type,
    before: op.before,
    after: op.after,
    expectedFingerprint: sourceRecord?.fingerprint || fingerprint(sourceRecord?.text || ""),
    approval: "APPROVED",
    actorUid: auth.currentUser?.uid || null,
    target: c.repairPlan?.rootCauseFile || op.file,
    createdAt: now()
  };
}

async function reviewProposalWithExecutor(c, proposal) {
  const e = internalExecutor();
  const op = proposal?.operations?.[0];
  if (!op?.file || typeof op.before !== "string" || typeof op.after !== "string") {
    return { status:"REJECTED", reason:"REPAIR_CANDIDATE_INCOMPLETE" };
  }
  const source = await fetchFile(op.file, { force:true });
  if (!source.ok || typeof source.text !== "string") {
    return { status:"REJECTED", reason:`SOURCE_UNAVAILABLE:${op.file}` };
  }
  const request = buildExecutorRequest(c, proposal, op, { text:source.text, fingerprint:fingerprint(source.text) });
  request.approval = "REVIEW";
  const candidate = {
    request,
    sourceText:source.text,
    candidate:{
      file:op.file, location:op.location || op.line || null, before:op.before, after:op.after,
      fingerprint:request.expectedFingerprint, evidence:proposal.verification?.evidence || proposal.verification || null,
      operation:op.type, caseId:c.id, proposalId:proposal.proposalId
    },
    requestId:request.requestId, caseId:c.id, proposalId:proposal.proposalId
  };
  publishInvestigationRequest(c, "CANDIDATE_SENT", {
    message:`Candidate repair ${proposal.proposalId} dikirim ke Execution untuk deterministic review. Ini bukan perintah eksekusi.`
  });
  emit("execution_review_started", { case:c, proposal, request, channel:"CROSS_PAGE_REALTIME" });

  // Register the waiter BEFORE publishing the candidate to close the cross-page race.
  const review = await new Promise(resolve => {
    const timer = setTimeout(() => {
      pendingExecutionReviews.delete(request.requestId);
      resolve(null);
    }, EXECUTION_REVIEW_TIMEOUT);
    pendingExecutionReviews.set(request.requestId, { resolve, timer });
    publishExecutionCandidate(candidate);
  });

  let finalReview = review;
  if (!finalReview && e && typeof e.reviewCandidate === "function") {
    // No standalone Executor answered. The embedded internal Executor is a deterministic fallback only.
    finalReview = await Promise.resolve(e.reviewCandidate(request, source.text));
    finalReview = { ...finalReview, role:"MEDICINE_EMBEDDED_FALLBACK", transport:"LOCAL_FALLBACK" };
  }
  if (!finalReview) finalReview = { status:"REVIEW_UNAVAILABLE", reason:"EXECUTION_REVIEW_TIMEOUT" };
  proposal.executionReview = finalReview;
  proposal.executionReviewedAt = now();
  emit("execution_review_complete", { case:c, proposal, review:finalReview, channel:finalReview.role === "STANDALONE" ? "CROSS_PAGE_REALTIME" : "LOCAL_FALLBACK" });
  return finalReview;
}

async function applyApprovedTreatment(caseId) {
  const c=S.cases.find(x=>x.id===caseId);
  if(!c) throw new Error("Case tidak ditemukan");
  emit("manual_copy_required",{case:c,message:"Medicine tidak menulis source. Salin solusi exact ke target secara manual, lalu Medicine akan memvalidasi deployment."});
  throw new Error("MANUAL_COPY_REQUIRED: Medicine tidak melakukan eksekusi source otomatis");
}

async function validateAfterPatch(caseId) {
  const c = S.cases.find(x => x.id === caseId);
  if (!c) throw new Error("Case tidak ditemukan");

  const repairTarget = c.repairPlan?.rootCauseFile || c.source;
  const operations = c.repairPlan?.operations || [];
  emit("validation_started", { caseId, target: repairTarget, telemetryTarget: c.source });

  const e = internalExecutor();
  let internalSource = null;
  if (e?.getSource) {
    try { internalSource = await e.getSource(repairTarget); } catch {}
  }

  const deployed = await fetchFile(repairTarget, { force: true });
  const telemetryLogs = latestRelevantLogs(c.source);
  const beforeSig = c.signature;
  const currentError = telemetryLogs.find(l => safeLower(l.message || l.error).includes(safeLower(beforeSig)));

  let operationVerified = operations.length > 0;
  for (const op of operations) {
    const textToCheck = internalSource?.content || deployed.text || "";
    if (op.type === "REPLACE_EXACT") {
      if (textToCheck.includes(op.before) || !textToCheck.includes(op.after)) operationVerified = false;
    } else if (op.type === "INSERT_EXACT") {
      if (!textToCheck.includes(op.before + op.after) && !textToCheck.includes(op.after + op.before)) operationVerified = false;
    }
  }

  const persistenceVerified = !!internalSource && operations.every(op => {
    const content = internalSource.content || "";
    return !content.includes(op.before) && content.includes(op.after);
  });
  const localFilePersisted = internalSource?.origin === "LOCAL_FILE_HANDLE";
  const deployedChanged = !!deployed.ok && operations.every(op => {
    const content = deployed.text || "";
    return !content.includes(op.before) && content.includes(op.after);
  });

  const fullyFixed = persistenceVerified && (localFilePersisted || deployedChanged) && !currentError;
  const pendingDeployment = persistenceVerified && !localFilePersisted && !deployedChanged;

  const v = {
    caseId,
    target: repairTarget,
    telemetryTarget: c.source,
    passed: fullyFixed,
    status: fullyFixed
      ? "FIXED_VERIFIED"
      : pendingDeployment
        ? "INTERNAL_VERIFIED_PENDING_DEPLOYMENT"
        : "STILL_FAILING",
    checkedAt: now(),
    runtimeEvidence: telemetryLogs.slice(0, 5),
    previousSignature: beforeSig,
    sourceReadable: !!deployed.ok,
    internalSourceAvailable: !!internalSource,
    internalPersistenceVerified: persistenceVerified,
    localFilePersisted,
    deployedChanged,
    operationVerified,
    remainingFindings: [],
    note: pendingDeployment
      ? "Perubahan sudah tersimpan dan terbaca kembali oleh Internal Repository, tetapi source deployed belum berubah. Sistem tidak mengklaim FIXED_VERIFIED."
      : null
  };

  S.validation = v;
  c.validation = v;
  c.status = v.status;
  const proposal = c.patchProposal || findProposal(caseId);
  if (proposal) proposal.status = fullyFixed ? "VERIFIED_FIXED" : pendingDeployment ? "INTERNAL_VERIFIED" : "VALIDATION_FAILED";

  emit("validation_complete", { validation: v, case: c });
  emit("case_updated", { case: c });
  return v;
}

async function rejectTreatment(caseId, reason = "Treatment ditolak oleh manusia.") {
  const c = S.cases.find(x => x.id === caseId);
  if (!c) throw new Error("Case tidak ditemukan");
  c.status = "REJECTED";
  c.rejectedAt = now();
  c.rejectionReason = text(reason, 500);
  emit("case_updated", { case: c });
  return c;
}

async function setHumanMode(paused) {
  S.human.paused = !!paused;
  S.human.mode = paused ? "HUMAN_PAUSED" : "ASSISTED";
  S.human.uid = auth.currentUser?.uid || null;
  emit("human_control", { human: { ...S.human } });
}

async function requestReview(caseId) {
  const c = S.cases.find(x => x.id === caseId);
  if (!c) throw new Error("Case tidak ditemukan");
  emit("human_review_requested", { case: c });
  return c;
}

function publishExecutionApproval(c, proposal) {
  if (!c?.id || !proposal?.proposalId || proposal?.executionReview?.status !== "VALID") return null;
  const op = proposal.operations?.[0];
  const review = proposal.executionReview || {};
  const requestId = String(review.requestId || "").trim();
  if (!requestId || !op?.file || typeof op.before !== "string" || typeof op.after !== "string") return null;
  c.executionRequestId = requestId;
  c.executionApprovalAt = now();
  const request = {
    requestId, caseId:c.id, proposalId:proposal.proposalId, planId:c.repairPlan?.planId || "",
    file:op.file, sourceId:op.file, operation:op.type, before:op.before, after:op.after,
    expectedFingerprint:review.beforeFingerprint || "", approval:"APPROVED",
    actorUid:auth.currentUser?.uid || null, target:c.repairPlan?.rootCauseFile || op.file, createdAt:now()
  };
  const message = {bridge:MEDICINE_BRIDGE_KEY,from:"MEDICINE",type:"MEDICINE_EXECUTION_APPROVAL",at:Date.now(),approval:"HUMAN_APPROVED",requestId,caseId:c.id,proposalId:proposal.proposalId,request,approvedBy:auth.currentUser?.uid||null};
  let transported = false;
  try {
    if (medicineBridgeChannel) { medicineBridgeChannel.postMessage(message); transported = true; }
  } catch {}
  try {
    localStorage.setItem(EXECUTION_APPROVAL_KEY, JSON.stringify(message));
    transported = true;
  } catch {}
  if (!transported) {
    c.executionRequestId = null;
    c.executionApprovalAt = null;
    throw new Error("EXECUTION_APPROVAL_TRANSPORT_UNAVAILABLE");
  }
  emit("execution_approval_sent", {case:c,proposal,requestId,transported:true});
  return message;
}

async function approveTreatment(caseId) {
  const c = S.cases.find(x => x.id === caseId);
  if (!c) throw new Error("Case tidak ditemukan.");
  if (S.human.paused) throw new Error("Medicine sedang dijeda.");
  if (!canApprove(c)) throw new Error("Treatment belum memenuhi Precision Gate.");

  c.status = "READY_FOR_PATCH";
  c.approvedAt = now();
  c.approvedBy = auth.currentUser?.uid || null;

  if (c.repairPlan) c.repairPlan.status = "READY_FOR_PATCH";
  if (c.patchProposal) {
    c.patchProposal.status = "READY_FOR_PATCH";
    c.patchProposal.approvedAt = c.approvedAt;
    c.patchProposal.approvedBy = c.approvedBy;
  }

  try {
    await addDoc(collection(db,"medicine_treatments"),{
      caseId:c.id,
      source:c.source,
      diagnosis:c.diagnosis,
      verification:c.verification,
      repairPlan:c.repairPlan,
      action:"HUMAN_APPROVAL_READY_FOR_EXECUTION",
      actorUid:c.approvedBy,
      createdAt:serverTimestamp()
    });
  } catch (error) {
    emit("storage_warning",{message:error?.message || String(error)});
  }

  const executionApproval = publishExecutionApproval(c, c.patchProposal);
  if (!executionApproval) throw new Error("EXECUTION_APPROVAL_NOT_READY");

  await safeAddMessage(
    "medicine",
    `Human Approval diterima untuk ${c.id}. Candidate exact dikirim ke Executor untuk eksekusi terkontrol; Medicine tetap tidak menulis source.`,
    {kind:"HUMAN_APPROVAL",caseId:c.id,requestId:executionApproval.requestId}
  );

  emit("case_updated",{case:c});
  return c;
}


function intent(question) {
  const q = lower(question);
  return {
    status:/\b(status|sehat|normal|aman|bagaimana keadaan)\b/.test(q),
    progress:/\b(progress|progres|sedang apa|lagi ngapain|mengerjakan|apa yang.*kerja)\b/.test(q),
    investigate:/\b(cek|periksa|bedah|telusuri|trace|selidiki|analisis|buktikan|verifikasi)\b/.test(q),
    root:/\b(akar|root cause|penyebab|kenapa|mengapa|sumber masalah)\b/.test(q),
    repair:/\b(perbaiki|sembuhkan|obati|patch|solusi|before|after|ruang operasi)\b/.test(q),
    rules:/\b(rules?|permission|firestore|izin|ditolak)\b/.test(q),
    code:/\b(kode|source|script|selector|dom|function)\b/.test(q)
  };
}

function bcgoAnswer(question) {
  const i = intent(question);
  const active = activeCases();
  const target = mentionedFile(question) || active[0]?.source || null;

  if (i.status) {
    return `Status saraf: ${S.logs.length} telemetry, ${active.length} case aktif, ${S.findings.length} finding, Rules ${S.rules.status}, surface Medicine ${Object.keys(REGISTRY).length} file.`;
  }
  if (i.progress) {
    return active.length
      ? `Saya sedang mengawasi ${active.length} case aktif. Fokus ${active[0].source}; Medicine sedang membuktikan root cause.`
      : "Saya sedang memantau telemetry realtime. Belum ada case aktif yang terbukti.";
  }
  if (i.rules) {
    const denied = S.rules.permissionErrors.length;
    return denied
      ? `Ada ${denied} probe Rules yang ditolak. Saya pisahkan masalah permission dari bug aplikasi.`
      : `Health Rules saat ini ${S.rules.status}. Saya tidak menuduh Rules rusak tanpa evidence.`;
  }
  return `Saya menerima pesan Anda. ${target ? `Target awal ${target}, tetapi Medicine tidak akan menganggapnya sebagai root cause sebelum source dan dependency terbukti.` : "Saya akan mulai dari evidence terbaru lalu menelusuri root cause."}`;
}

function medicineAnswer(question) {
  const i = intent(question);
  const c = S.activeCase;
  const target = mentionedFile(question) || c?.source || null;

  if (i.status) {
    return c
      ? `Medicine: ${c.status}. Target awal ${c.source}; root cause ${c.rootCauseFile || "belum terbukti"}. Precision Gate ${c.repairPlan?.precisionGate ? "LULUS" : "TERKUNCI"}.`
      : "Medicine aktif mendengarkan telemetry realtime dan belum memegang case aktif.";
  }
  if (i.rules) {
    return `Health Rules: ${S.rules.status}. Permission denial terbukti: ${S.rules.permissionErrors.length}.`;
  }
  if (i.repair) {
    return c?.repairPlan?.operations?.length
      ? `Saya memiliki ${c.repairPlan.operations.length} operasi exact. Source tetap terkunci sampai Human Approval.`
      : "Belum ada operasi exact yang aman. Saya menahan treatment.";
  }
  if (i.root || i.investigate || i.code) {
    return `Siap. Saya mulai dari ${target || "evidence terbaru"}, lalu telusuri dependency → root cause → source exact. Jika bukti menunjuk file lain, target saya koreksi.`;
  }
  return "Saya Medicine. Ceritakan error atau gejala yang Anda lihat; saya akan mengubahnya menjadi investigasi berbasis evidence.";
}

async function sendMessage(message, role = "human") {
  const t = text(message,1200);
  if (!t) return;

  if (!auth.currentUser) {
    emit("local_message",{
      message:{
        role:"medicine",
        text:"Medicine menunggu sesi Admin aktif. Saya tidak membuka data Firestore tanpa autentikasi."
      }
    });
    return;
  }

  if (role !== "human") {
    await safeAddMessage(role,t);
    return;
  }

  const clientMessageId = uid();
  await safeAddMessage("human",t,{clientMessageId});

  if (S.human.paused) {
    await safeAddMessage(
      "medicine",
      "Pesan diterima. Medicine sedang dijeda oleh manusia sehingga diagnosis/treatment baru ditahan.",
      {replyTo:clientMessageId}
    );
    return;
  }

  const recipient = /^\s*(hai\s+)?bcgo\b/i.test(t) || /\bbcgo[,:]/i.test(t)
    ? "bcgo"
    : "medicine";

  await safeAddMessage(
    recipient,
    recipient === "bcgo" ? bcgoAnswer(t) : medicineAnswer(t),
    {replyTo:clientMessageId,kind:"DIRECT_REPLY"}
  );

  const i = intent(t);
  if (i.investigate || i.root || i.repair || i.code || i.rules) {
    const target = mentionedFile(t) || S.activeCase?.source || activeCases()[0]?.source || null;

    await safeAddMessage(
      "bcgo",
      `Baik. Saya buka jalur investigasi${target ? ` untuk ${target}` : ""}. Medicine akan membuktikan root cause sebelum membuka solusi.`,
      {kind:"INVESTIGATION_REQUEST",target,replyTo:clientMessageId}
    );

    await verifyWithMedicine(target,{
      question:t,
      requestedBy:"human_command",
      noRetry:true
    });
  }
}

function ingestBCGOActiveCases(activeCases, packet = {}) {
  if (!Array.isArray(activeCases)) return;
  for (const bcgoCase of activeCases.slice(0,20)) {
    const target=normalizeFile(bcgoCase?.target||bcgoCase?.rootCandidate||bcgoCase?.file||bcgoCase?.evidence?.file);
    if(!target || !REGISTRY[target]) continue;
    const bcgoId=String(bcgoCase?.id||"").trim();
    const signature=text(bcgoCase?.evidence?.message||bcgoCase?.message||bcgoCase?.signature||"BCGO anomaly",700);
    const revisionToken=investigationEvidenceToken({id:bcgoId,reportedAt:bcgoCase?.evidence?.reportedAt||packet?.at||Date.now(),fileName:target,line:bcgoCase?.evidence?.line??null,column:bcgoCase?.evidence?.column??null,message:signature,sourceRevision:bcgoCase?.evidence?.sourceFinding?.hash||bcgoCase?.evidence?.sourceFinding?.fingerprint||""});
    let c=bcgoId?S.cases.find(x=>x.bcgoCaseId===bcgoId&&!isTerminal(x)):null;
    if(!c)c=S.cases.find(x=>x.source===target&&x.signature===signature&&!isTerminal(x));
    if(c){
      const previousToken=c.bcgoRevisionToken || investigationEvidenceToken(c.lastEvidence||c.evidence);
      c.evidenceCount=Math.max(1,Number(c.evidenceCount||1)+(previousToken===revisionToken?0:1));
      c.lastSeenAt=now(); c.bcgoCaseId=bcgoId||c.bcgoCaseId||null; c.bcgoHandoff="READY_FOR_MEDICINE"; c.bcgoCycle=Number(packet?.state?.cycle||0); c.bcgoReceivedAt=now();
      c.lastEvidence={...(bcgoCase.evidence||{}),bcgoCaseId:bcgoId,source:"BCGO_STATE",revisionToken}; c.evidence=c.lastEvidence; c.bcgoRevisionToken=revisionToken;
      if(previousToken!==revisionToken){c.status="INVESTIGATION_BLOCKED"; queueAutoInvestigation(c,"bcgo_state_revision_changed");}
      S.activeCase=c; continue;
    }
    const d=classifyError(signature);
    c={id:`CASE-${uid().toUpperCase()}`,evidenceId:null,bcgoCaseId:bcgoId||null,source:target,signature,diagnosis:d,prescription:{treatment:d.treatment,risk:d.severity==="HIGH"?"HIGH":"MEDIUM",mode:"BCGO_HANDOFF"},status:"INVESTIGATION_BLOCKED",createdAt:now(),lastSeenAt:now(),evidenceCount:1,evidence:{...(bcgoCase.evidence||{}),bcgoCaseId:bcgoId,source:"BCGO_STATE",revisionToken},lastEvidence:{...(bcgoCase.evidence||{}),bcgoCaseId:bcgoId,source:"BCGO_STATE",revisionToken},runtimeLocation:{file:target,line:Number(bcgoCase?.evidence?.line)||null,col:Number(bcgoCase?.evidence?.column)||null,stack:""},rootCauseFile:target,rootCauseStatus:"UNPROVEN",sourceEvidence:[],repairPlan:null,patchProposal:null,validation:null,bcgoHandoff:"READY_FOR_MEDICINE",bcgoCycle:Number(packet?.state?.cycle||0),bcgoReceivedAt:now(),bcgoRevisionToken:revisionToken,lastInvestigatedEvidenceToken:null};
    S.cases.unshift(c); S.cases=S.cases.slice(0,100); S.activeCase=c; emit("bcgo_case_handoff",{case:c,source:"BCGO_STATE",handoff:"READY_FOR_MEDICINE"}); queueAutoInvestigation(c,"bcgo_case_handoff");
  }
}

function receiveBCGOState(packet, source = "BROADCAST_CHANNEL") {
  if (!packet || packet.bridge !== MEDICINE_BRIDGE_KEY || packet.from !== "BCGO") return false;
  if (packet.type !== "BCGO_STATE") return false;
  const packetId=String(packet.id||"");
  if (packetId && packetId===S.lastBCGOPacketId) return false;
  if (packetId) S.lastBCGOPacketId=packetId;
  const at=Number(packet.at)||0;
  if(!at)return false;
  const age=Date.now()-at;
  const st=packet.state||{};
  S.bcgoSync={...S.bcgoSync,status:age<=MEDICINE_BRIDGE_LIVE_WINDOW?"LIVE":"STALE",lastAt:at,cycle:Number(st.cycle)||0,step:st.step||"-",active:Number(st.metrics?.active)||0,total:Number(st.metrics?.total)||0,source:"BROADCAST_CHANNEL"};
  S.bcgoAIContext=st.internalAI?{...st.internalAI,receivedAt:now()}:S.bcgoAIContext;
  ingestBCGOActiveCases(st.activeCases||st.medicineQueue||[],packet);
  if(S.bcgoAIContext)emit("bcgo_ai_context",{ai:S.bcgoAIContext,cycle:Number(st.cycle)||0});
  const scan=st.sourceScan;
  if(scan&&typeof scan==='object'){
    S.bcgoSourceScan={...S.bcgoSourceScan,...scan,cycle:Number(st.cycle)||Number(S.bcgoSourceScan.cycle)||0,receivedAt:Date.now()};
    const token = bcgoScanToken(S.bcgoSourceScan);
    const scanStatus = String(scan.status || "").toUpperCase();
    const scanCompleted = !!scan.completedAt || ["COMPLETE", "CLEAN", "FINDINGS", "DEGRADED"].includes(scanStatus);
    if (token && token !== S.lastBCGOScanToken && token !== S.bcgoIngestingToken && scanCompleted) {
      S.bcgoIngestingToken = token;
      void ingestBCGOScan(S.bcgoSourceScan,packet)
        .then(() => { S.lastBCGOScanToken = token; })
        .catch(error=>emit("bcgo_source_scan_error",{message:error?.message||String(error)}))
        .finally(() => { if (S.bcgoIngestingToken === token) S.bcgoIngestingToken = null; });
    }
  }
  window.dispatchEvent(new CustomEvent("bcgo:medicine",{detail:{event:"bcgo_sync",at:now(),contract:{...S.bcgoSync},sourceScan:S.bcgoSourceScan}}));
  return true;
}

medicineBridgeChannel?.addEventListener("message", event => receiveBCGOState(event.data));
window.addEventListener("storage", event => {
  if (event.key !== MEDICINE_BRIDGE_KEY + "_STATE" || !event.newValue) return;
  try { receiveBCGOState(JSON.parse(event.newValue)); } catch {}
});
setInterval(() => {
  if (!S.bcgoSync.lastAt) return;
  if (Date.now() - S.bcgoSync.lastAt > MEDICINE_BRIDGE_LIVE_WINDOW && S.bcgoSync.status === "LIVE") {
    S.bcgoSync.status = "STALE";
    window.dispatchEvent(new CustomEvent("bcgo:medicine", {detail:{event:"bcgo_sync",at:now(),contract:{...S.bcgoSync}}}));
  }
}, 3000);

function syncExecutionResultFromCache() {
  let acceptedAny = false;
  const packets = [];
  try {
    const nowMs = Date.now();
    // Per-request caches prevent one completed execution from overwriting another
    // when multiple approved cases finish while Medicine is reloading/offline.
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i) || "";
      if (!key.startsWith(`${EXECUTION_RESULT_KEY}_`)) continue;
      try { packets.push({key,packet:JSON.parse(localStorage.getItem(key)||"null")}); } catch {}
    }
    // Keep compatibility with the legacy single-slot cache.
    const legacy = localStorage.getItem(EXECUTION_RESULT_KEY);
    if (legacy) { try { packets.push({key:EXECUTION_RESULT_KEY,packet:JSON.parse(legacy)}); } catch {} }
    for (const item of packets) {
      const packet=item.packet;
      const at=Number(packet?.at)||0;
      if (!at || nowMs-at > 10*60*1000) { try { localStorage.removeItem(item.key); } catch {} ; continue; }
      const accepted=receiveExecutionResult(packet);
      if (accepted) { acceptedAny=true; try { localStorage.removeItem(item.key); } catch {} }
    }
  } catch {}
  return acceptedAny;
}

onAuthStateChanged(auth, async user => {
  S.human.uid = user?.uid || null;
  emit("auth",{user:user ? {uid:user.uid,email:user.email || null} : null});

  if (!user) {
    emit("auth_required",{message:"Medicine menunggu sesi Admin aktif."});
    return;
  }

  try {
    const adminSnap = await getDoc(doc(db,"admin_users",user.uid));

    const adminData = adminSnap.exists() ? adminSnap.data() : null;
    const role = String(adminData?.role || "").toLowerCase();
    const roleAllowed = !role || role === "admin" || role === "super_admin";
    if (!adminSnap.exists() || adminData?.active !== true || !roleAllowed) {
      emit("auth",{user:null,deniedReason:"NOT_ADMIN"});
      emit("local_message",{
        message:{
          role:"medicine",
          text:"Akses Medicine ditahan: akun ini bukan Admin aktif."
        }
      });
      return;
    }

    emit("auth_verified",{
      user:{uid:user.uid,email:user.email || null},
      role:adminSnap.data()?.role || null
    });

    await discoverSystemSurface();
    startBCGOBridgeRecovery();
    await syncBCGOStateFromCache("LOCAL_STORAGE_BOOTSTRAP");
    syncExecutionResultFromCache();
    startLiveSurface();
    startTelemetry();
    startRecoveryMonitor();
    startConversation();
    startRuleHealthMonitor();

    const scan = await scanConsistency();
    emit("ready",{
      version:S.version,
      registryCount:Object.keys(REGISTRY).length,
      surfaceCount:S.surface?.files?.length || Object.keys(REGISTRY).length,
      findings:scan.findings?.length || 0,
      executorAvailable:executorAvailable(),
      executor:{...S.executor}
    });
  } catch (error) {
    const info = classifyFirestoreError(error);
    emit("auth_error",{
      code:info.code,
      message:info.message,
      permissionDenied:info.permission
    });
  }
});

const API = {
  scanConsistency,
  discoverSystemSurface,
  getLiveSurface,
  startLiveSurface,
  scanLiveSurface:() => ingestBCGOScan(S.bcgoSourceScan,{state:{cycle:S.bcgoSourceScan.cycle}}),
  verifyWithMedicine,
  reviewProposalWithExecutor,
  sendMessage,
  approveTreatment,
  applyApprovedTreatment,
  validateAfterPatch,
  rejectTreatment,
  requestReview,
  setHumanMode,
  buildCodePrescription,
  buildInvestigationDecision,
  getRegistry:() => ({...REGISTRY}),
  getState:() => ({
    ...S,
    sourceCache:undefined,
    investigated:undefined,
    listeners:undefined
  })
};

Object.defineProperties(API,{
  cases:{get:() => S.cases},
  activeCase:{get:() => S.activeCase},
  findings:{get:() => S.findings},
  logs:{get:() => S.logs},
  messages:{get:() => S.messages},
  human:{get:() => S.human},
  patchProposals:{get:() => S.patchProposals},
  patchRequests:{get:() => S.patchRequests},
  verification:{get:() => S.verification},
  validation:{get:() => S.validation},
  rules:{get:() => S.rules},
  executor:{get:() => ({...S.executor})},
});

window.BCGOMedicine = API;

// Internal Executor bridge: local same-origin engine only. No GitHub/API/Function brain.
window.addEventListener("bcgo-executor-state", () => syncExecutorState());
window.addEventListener("bcgo-executor-core-ready", () => syncExecutorState());
setTimeout(() => syncExecutorState(), 0);

emit("boot",{version:S.version,executorAvailable:executorAvailable()});
