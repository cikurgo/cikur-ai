/*
 * CIKUR GO INTERNAL CAPTAIN ORCHESTRATOR
 * Deterministic supervisor for BCGO <-> MEDICINE <-> EXECUTOR.
 *
 * IMPORTANT:
 * - No external AI/API.
 * - No cloud backend SDK or server function dependency.
 * - No source mutation.
 * - This module only observes real internal state/bridge packets and emits
 *   bounded directives. Proof/Guardian/Executor remain authoritative gates.
 */
const VERSION = "2.3.0-CAPTAIN-CGO-CONSTRUCTION-MEDICINE-REVIEW";
const BRIDGE = "CIKUR_GO_BCGO_MEDICINE_V1";
const MAX_ROUNDS = 4;
const DIRECTIVE_COOLDOWN = 12000;
const BLOCKER_REPEAT_COOLDOWN = 30000;
const HUMAN_COMMAND_WAIT_MS = 2500;
const CAPTAIN_ANALYSIS_PROMPT = "Terima kasih atas update-nya. Saya butuh data paling akurat dari kalian: 1. Apa penyebab paling mungkin? 2. Langkah apa yang harus dilakukan selanjutnya? 3. Apa yang saya perlu setujui? Saya menunggu evidence dan review sebelum membuka gerbang manusia.";
const HUMAN_APPROVAL_KEY = `${BRIDGE}_HUMAN_APPROVAL`;
const HUMAN_APPROVAL_MAX_AGE = 120000;
const CASE_STALE_MS = 10 * 60 * 1000;
const PROBE_MAX_PER_CASE = 6;

const clone = value => {
  try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
};

export function createCaptain(options = {}) {
  const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(BRIDGE) : null;
  const listeners = new Set();
  const seen = new Set();
  const cases = new Map();
  let latestBCGO = null;
  let latestAI = null;
  let latestMedicine = null;
  let latestExecutor = null;
  let lastDirectiveAt = 0;
  let started = false;
  let greetingSent = false;

  const state = {
    version: VERSION,
    role: "CAPTAIN",
    status: "WAITING",
    phase: "IDLE",
    caseId: null,
    round: 0,
    maxRounds: MAX_ROUNDS,
    decision: "WAITING",
    nextAction: "WAIT_FOR_BCGO",
    blocker: null,
    candidate: null,
    humanGate: false,
    at: Date.now(),
    bcgoExploration: null,
    captainAssessment: null
  };

  function emit(event, data = {}) {
    const snapshot = clone({ ...state, event, data, at: Date.now() });
    for (const fn of listeners) { try { fn(snapshot); } catch {} }
    try { window.dispatchEvent(new CustomEvent("cikur-captain-state", { detail: snapshot })); } catch {}
    return snapshot;
  }

  function set(patch = {}, event = "CAPTAIN_STATE") {
    Object.assign(state, patch, { at: Date.now() });
    return emit(event, patch);
  }

  function post(type, payload = {}) {
    const packet = {
      id: `CAPTAIN-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
      bridge: BRIDGE,
      from: "CAPTAIN",
      type,
      at: Date.now(),
      caseId: payload.caseId || state.caseId || null,
      captain: { version: VERSION, round: state.round, phase: state.phase },
      ...payload
    };
    try { channel?.postMessage(packet); } catch {}
    try { localStorage.setItem(`${BRIDGE}_EVENT`, JSON.stringify(packet)); } catch {}
    return packet;
  }

  function directive(type, payload = {}, options = {}) {
    const now = Date.now();
    if (!options.force && now - lastDirectiveAt < DIRECTIVE_COOLDOWN) return null;
    lastDirectiveAt = now;
    return post(type, payload);
  }

  function currentCaseId() {
    if (state.caseId) return state.caseId;
    const active = Array.isArray(latestBCGO?.activeCases) ? latestBCGO.activeCases : [];
    const primary = active[0];
    return primary?.id || primary?.caseId || primary?.target || null;
  }

  function captainReply(text, meta = {}) {
    const response = {
      from: "CAPTAIN",
      type: "CAPTAIN_HUMAN_RESPONSE",
      bridge: BRIDGE,
      caseId: currentCaseId(),
      message: String(text || ""),
      at: Date.now(),
      ...meta
    };
    emit("CAPTAIN_HUMAN_RESPONSE", response);
    try { window.dispatchEvent(new CustomEvent("cikur-captain-human-response", { detail: clone(response) })); } catch {}
    return response;
  }

  function persistHumanApproval(packet) {
    try { localStorage.setItem(HUMAN_APPROVAL_KEY, JSON.stringify(packet)); } catch {}
  }

  function receiveHumanCommand(text, meta = {}) {
    const raw = String(text || "").trim();
    if (!raw) return { handled: false, reason: "EMPTY_COMMAND" };

    // Only direct operator commands are claimed by Captain. Other ordinary
    // questions remain available to the existing internal BCGO conversation.
    const lower = raw.toLocaleLowerCase("id-ID");
    const addressed = /(^|[\s,.:!?])cgo([\s,.:!?]|$)/i.test(raw) || /kapten cgo/i.test(raw);
    if (!addressed) return { handled: false, reason: "NOT_ADDRESSED_TO_CAPTAIN" };

    const caseId = currentCaseId();
    if (caseId) registerCase(caseId);

    const isApprove = /\b(setujui|approve|saya setuju|izinkan|lanjutkan perubahan)\b/i.test(raw);
    const isReject = /\b(tolak|reject|jangan setujui|jangan lanjutkan|batalkan candidate)\b/i.test(raw);
    const isInvestigate = /\b(cek|periksa|periksa lagi|investigasi|selidiki|pengecekan|pengecekan ulang|cari tahu|telusuri|janggal|aneh|anomali|evidence|bukti)\b/i.test(raw);
    const isUpdate = /\b(update|laporkan|laporan|status|sedang mengerjakan apa|apa yang dikerjakan)\b/i.test(raw);

    if (isApprove) {
      if (!state.humanGate) {
        return captainReply("Saya belum membuka gerbang persetujuan. Candidate belum lolos seluruh pemeriksaan Captain, Medicine, dan Executor.", { decision: "APPROVAL_BLOCKED" });
      }
      const approval = post("CGO_HUMAN_APPROVAL", { caseId, decision: "APPROVE", humanCommand: raw, approvalId: `HUMAN-${caseId}-${Date.now()}` });
      persistHumanApproval(approval);
      set({ status: "LIVE", phase: "HUMAN_APPROVAL", decision: "HUMAN_APPROVED", nextAction: "MEDICINE_AUTHORIZE", humanGate: false }, "CAPTAIN_HUMAN_COMMAND");
      return captainReply("Baik. Persetujuan manusia diterima. Saya meneruskannya melalui jalur internal yang sudah digate; Captain sendiri tidak mengubah source.", { decision: "APPROVE" });
    }

    if (isReject) {
      const approval = post("CGO_HUMAN_APPROVAL", { caseId, decision: "REJECT", reason: raw, humanCommand: raw, approvalId: `HUMAN-${caseId}-${Date.now()}` });
      persistHumanApproval(approval);
      set({ status: "LIVE", phase: "REINVESTIGATING", decision: "HUMAN_REJECTED", nextAction: "MEDICINE_INVESTIGATE", humanGate: false, blocker: "HUMAN_REJECTED" }, "CAPTAIN_HUMAN_COMMAND");
      // The Human Approval packet is the single reject command. Medicine consumes it
      // once and performs the reopen/re-investigation path; do not send a second
      // CGO_REJECT_CANDIDATE command here or the same case can be processed twice.
      return captainReply("Baik. Candidate ditolak. Saya meminta Medicine kembali mencari evidence dan solusi; tidak ada perubahan source yang diteruskan.", { decision: "REJECT" });
    }

    if (isInvestigate) {
      const packet = directive("CGO_BCGO_EXPLORE", {
        caseId,
        target: latestBCGO?.lastTelemetryFile || latestMedicine?.target || null,
        question: raw,
        humanCommand: true,
        commander: "HUMAN",
        exploration: "SOURCE_CONTRACT_MULTI_HOP"
      }, { force: true });
      const current = cases.get(caseId);
      if (current) { current.investigationDispatched = !!packet; current.awaitingEvidence = !!packet; current.lastAction = packet ? "BCGO_EXPLORE" : current.lastAction; }
      set({ status: "LIVE", phase: "DELEGATING", decision: "HUMAN_REQUESTED_INVESTIGATION", nextAction: "BCGO_EXPLORE", blocker: null }, "CAPTAIN_HUMAN_COMMAND");
      return captainReply(packet
        ? `Baik. Perintah manusia saya terima. Saya instruksikan BCGO untuk menjelajah source dan kontraknya sekarang. Belum ada izin perubahan source.`
        : "Perintah diterima, tetapi jalur internal belum siap mengirim directive. Saya menahan eksekusi dan tidak mengubah source.",
        { decision: packet ? "INVESTIGATION_DISPATCHED" : "INVESTIGATION_BLOCKED" });
    }

    if (isUpdate) {
      const packet = directive("CGO_REQUEST_UPDATE", { caseId, humanCommand: raw, commander: "HUMAN" }, { force: true });
      set({ status: "LIVE", phase: "STATUS_REQUEST", decision: "HUMAN_REQUESTED_UPDATE", nextAction: "ASK_TEAM" }, "CAPTAIN_HUMAN_COMMAND");
      return captainReply(packet
        ? "Baik. Saya meminta BCGO, Medicine, dan Executor melaporkan pekerjaan serta blocker mereka sekarang."
        : "Perintah diterima, tetapi jalur laporan sedang sibuk. Saya tidak membuka tindakan baru di luar gerbang.",
        { decision: packet ? "UPDATE_DISPATCHED" : "UPDATE_BLOCKED" });
    }

    return captainReply("Saya menerima perintah kakak. Jelaskan tindakan yang diinginkan—misalnya minta tim melakukan pengecekan, minta update, atau setujui/tolak candidate yang sudah membuka gerbang manusia.", { decision: "COMMAND_NEEDS_SCOPE" });
  }

  function registerCase(caseId) {
    if (!caseId) return { round: 0 };
    if (!cases.has(caseId)) cases.set(caseId, { round: 0, lastAction: null, candidate: null, investigationDispatched: false, awaitingEvidence: false, lastBlockerKey: null, lastBlockerAt: 0, teamReports: { bcgo: false, medicine: false, executor: false }, analysisPrompted: false });
    const c = cases.get(caseId);
    state.caseId = caseId;
    state.round = c.round;
    return c;
  }

  function announceGreeting() {
    if (greetingSent) return;
    if (state.status !== "WAITING" && state.status !== "LIVE") return;
    greetingSent = true;
    set({ status: "LIVE", phase: "STATUS_REQUEST", decision: "REQUESTING_UPDATES", nextAction: "ASK_TEAM" }, "CAPTAIN_GREETING");
    post("CGO_REQUEST_UPDATE", {
      caseId: state.caseId,
      message: "Hallo,, BCGO, MEDICINE dan EXECUTOR. Tolong update Kalian sedang mengerjakan apa"
    });
  }

  function chooseNextBCGOProbe(snapshot = latestBCGO) {
    const exploration = snapshot?.sourceScan?.exploration || {};
    const gaps = Array.isArray(exploration.gaps) ? exploration.gaps : [];
    const rank = { HIGH: 3, MEDIUM: 2, LOW: 1 };
    const current = state.caseId ? cases.get(state.caseId) : null;
    const history = Array.isArray(current?.probeHistory) ? current.probeHistory : [];
    if (history.length >= PROBE_MAX_PER_CASE) return null;
    const used = new Set(history.map(x => String(x.type || '').toUpperCase() + '|' + String(x.file || '') + '|' + String(x.line || '') + '|' + String(x.symbol || x.handler || x.asset || '')));
    const map = {
      CONTRACT_GAP_UNRESOLVED_HANDLER: 'VERIFY_HANDLER_BINDING',
      CONTRACT_GAP_AMBIGUOUS_HANDLER_BINDING: 'VERIFY_HANDLER_BINDING',
      CONTRACT_GAP_NO_DOWNSTREAM_CONSEQUENCE: 'TRACE_HANDLER_DEPENDENCIES',
      CONTRACT_GAP_MISSING_DOM_CONSUMER: 'TRACE_DOM_CONSUMER',
      CONTRACT_GAP_MISSING_PRODUCER: 'VERIFY_SYMBOL_PRODUCER',
      CONTRACT_GAP_ORPHAN_PRODUCER: 'VERIFY_FUNCTION_CONSUMER',
      CONTRACT_GAP_STATE_WITHOUT_OBSERVED_CONSUMER: 'TRACE_STATE_CONSUMER',
      CONTRACT_GAP_MISSING_ASSET: 'VERIFY_ASSET_PATH_OR_DEPLOYMENT',
      CONTRACT_GAP_ASSET_UNVERIFIED: 'RETRY_ASSET_PROBE',
      CONTRACT_GAP_FORM_SUBMISSION_PATH: 'TRACE_DYNAMIC_EVENT_BINDING'
    };
    const sorted = gaps.slice().sort((a,b)=>(rank[String(b?.severity||'').toUpperCase()]||0)-(rank[String(a?.severity||'').toUpperCase()]||0));
    for (const g of sorted) {
      const type = map[g?.type] || g?.nextAction || null;
      if (!type || type === 'CONTINUE_OBSERVATION') continue;
      const file = g?.file || g?.sourceFile || null;
      const line = g?.line || g?.handlerLine || null;
      const symbol = g?.handler || g?.function || g?.consumerSymbol || g?.state || g?.asset || null;
      const key = String(type).toUpperCase() + '|' + String(file || '') + '|' + String(line || '') + '|' + String(symbol || '');
      if (used.has(key)) continue;
      return { probeId:`PROBE-${Date.now()}-${Math.random().toString(36).slice(2,7)}`, type, caseId:state.caseId || null, file, line, symbol, gapType:g?.type || null, severity:g?.severity || 'UNKNOWN', confidence:g?.confidence || 'UNVERIFIED', dependencyTrace:g?.dependencyTrace || null, reason:g?.message || 'BCGO evidence requires a bounded verification probe.', round:state.round, createdAt:Date.now() };
    }
    return null;
  }

  function dispatchNextBCGOProbe(snapshot = latestBCGO, reason = 'CAPTAIN_SELECTED_NEXT_PROBE') {
    const probe = chooseNextBCGOProbe(snapshot);
    if (!probe) return null;
    const current = state.caseId ? cases.get(state.caseId) : null;
    if (current) {
      current.probeHistory = Array.isArray(current.probeHistory) ? current.probeHistory : [];
      current.probeHistory.push(clone(probe));
      current.lastProbe = clone(probe);
      current.lastAction = 'BCGO_PROBE';
      current.awaitingEvidence = true;
    }
    const packet = directive('CGO_BCGO_EXPLORE', { caseId:probe.caseId, exploration:'TARGETED_PROBE', probe, question:`Captain memilih probe ${probe.type} untuk memverifikasi ${probe.file || 'source'}${probe.line ? `:${probe.line}` : ''}${probe.symbol ? ` / ${probe.symbol}` : ''}.` });
    if (!packet) return null;
    set({ phase:'BCGO_PROBING', decision:'NEXT_PROBE_DISPATCHED', nextAction:probe.type, blocker:null }, reason);
    return probe;
  }

  function assessBCGOExploration(snapshot) {
    const scan = snapshot?.sourceScan || {};
    const exploration = scan.exploration || {};
    const gaps = Array.isArray(exploration.gaps) ? exploration.gaps : [];
    const traces = Array.isArray(exploration.traces) ? exploration.traces : [];
    const summary = exploration.summary || {};
    const high = Number(summary.high || 0);
    const medium = Number(summary.medium || 0);
    const unresolved = gaps.filter(g => String(g?.proofStatus || '').toUpperCase() !== 'INHERITED_EVIDENCE');
    const assessment = {
      status: exploration.status || scan.status || 'UNVERIFIED',
      gapCount: gaps.length,
      high,
      medium,
      unresolved: unresolved.length,
      multiHopTraces: Number(summary.multiHopTraces || 0),
      maxTraceDepth: Number(summary.maxTraceDepth || 0),
      nextActions: Array.isArray(exploration.nextActions) ? exploration.nextActions.slice(0,8) : [],
      at: Date.now()
    };
    state.bcgoExploration = clone(assessment);
    if (unresolved.length || high || medium) {
      state.captainAssessment = {
        conclusion: 'BCGO_EVIDENCE_REQUIRES_REVIEW',
        rule: 'OBSERVED_CANDIDATE_NOT_ROOT_CAUSE',
        priority: high ? 'HIGH' : 'MEDIUM',
        nextAction: assessment.nextActions[0] || 'VERIFY_BCGO_EVIDENCE',
        evidence: unresolved.slice(0,6).map(g => ({
          type:g.type || null, file:g.file || g.sourceFile || null, line:g.line || null,
          severity:g.severity || 'UNKNOWN', confidence:g.confidence || 'UNVERIFIED',
          dependencyTrace:g.dependencyTrace || null
        }))
      };
      set({ phase: 'BCGO_EXPLORATION', decision: 'BCGO_EVIDENCE_RECEIVED', nextAction: assessment.nextAction || 'VERIFY_BCGO_EVIDENCE', blocker: null }, 'CAPTAIN_BCGO_EXPLORATION_ASSESSED');
      if (state.caseId) {
        const c = cases.get(state.caseId);
        if (!c?.awaitingEvidence) dispatchNextBCGOProbe(snapshot);
      }
    } else {
      state.captainAssessment = { conclusion:'NO_ACTIONABLE_GAP_OBSERVED', rule:'NO_GAP_PROVEN', nextAction:'CONTINUE_OBSERVATION', evidence:[] };
      set({ phase: 'OBSERVING', decision: 'BCGO_NO_ACTIONABLE_GAP', nextAction:'CONTINUE_OBSERVATION', blocker:null }, 'CAPTAIN_BCGO_EXPLORATION_ASSESSED');
    }
    return clone(state.captainAssessment);
  }

  function chooseFromState() {
    const active = Array.isArray(latestBCGO?.activeCases) ? latestBCGO.activeCases : [];
    const primary = (state.caseId && active.find(x => (x.id || x.caseId || x.target) === state.caseId)) || active[0] || (latestBCGO?.lastTelemetryFile ? { id:`BCGO-${latestBCGO.lastTelemetryFile}`, target:latestBCGO.lastTelemetryFile } : null);
    if (!primary) {
      set({ phase: "OBSERVING", decision: "WAIT", nextAction: "WAIT_FOR_CASE", blocker: "NO_ACTIVE_CASE" }, "CAPTAIN_WAITING");
      return;
    }
    registerCase(primary.id || primary.caseId || primary.target);
    // A heartbeat is observation, not permission to keep dispatching work.
    // Captain waits for the three real reports before issuing one bounded
    // investigation directive.
    maybePromptTeamAnalysis(state.caseId);
  }

  function normalizeCandidatePacket(packet) {
    const raw = packet?.candidate || packet?.request || packet || {};
    const request = packet?.request || {};
    return {
      caseId: raw.caseId || packet?.caseId || request.caseId || state.caseId || null,
      proposalId: raw.proposalId || packet?.proposalId || request.proposalId || null,
      requestId: raw.requestId || packet?.requestId || request.requestId || null,
      file: raw.file || request.file || packet?.file || null,
      operation: raw.operation || request.operation || null,
      before: raw.before ?? raw.originalCode ?? request.before ?? request.originalCode ?? null,
      after: raw.after ?? raw.proposedCode ?? request.after ?? request.proposedCode ?? null,
      fingerprint: raw.fingerprint || request.expectedFingerprint || packet?.sourceFingerprint || null,
      location: raw.location || null,
      evidence: raw.evidence || null,
      sourceText: packet?.sourceText || raw.originalSource || null,
      originalSource: raw.originalSource || packet?.originalSource || null,
      proposedSource: raw.proposedSource || packet?.proposedSource || null,
      changedRanges: raw.changedRanges || packet?.changedRanges || [],
      lineMap: raw.lineMap || packet?.lineMap || null,
      sovereignty: raw.sovereignty || packet?.sovereignty || null,
      confidence: raw.confidence ?? packet?.confidence ?? null,
      rootCause: raw.rootCause || packet?.rootCause || null,
      evidenceIds: raw.evidenceIds || packet?.evidenceIds || [],
      dependencies: raw.dependencies || packet?.dependencies || []
    };
  }

  function maybePromptTeamAnalysis(caseId) {
    const current = cases.get(caseId);
    if (!current || current.analysisPrompted) return;
    if (!current.teamReports.bcgo || !current.teamReports.medicine || !current.teamReports.executor) return;
    current.analysisPrompted = true;
    set({ phase: "ANALYZING", decision: "TEAM_ANALYSIS_REQUESTED", nextAction: "MEDICINE_INVESTIGATE", blocker: null }, "CAPTAIN_TEAM_ANALYSIS_REQUEST");
    const packet = directive("CGO_INVESTIGATE", {
      caseId,
      target: latestBCGO?.lastTelemetryFile || latestMedicine?.medicine?.target || null,
      question: CAPTAIN_ANALYSIS_PROMPT
    });
    if (packet) {
      current.lastAction = "MEDICINE_INVESTIGATE";
      current.investigationDispatched = true;
      current.awaitingEvidence = true;
    }
  }

  function submitConstructedCandidate(candidate, meta = {}) {
    const normalized = normalizeCandidatePacket({ candidate, ...meta });
    const caseId = normalized.caseId || currentCaseId();
    if (!caseId || !normalized.file || !normalized.operation || !normalized.before || typeof normalized.after !== "string") {
      set({ phase:"CONSTRUCTION_BLOCKED", decision:"CANDIDATE_INCOMPLETE", nextAction:"MEDICINE_INVESTIGATE", blocker:"CGO_CANDIDATE_CONTRACT_INCOMPLETE", humanGate:false }, "CAPTAIN_CONSTRUCTION_BLOCKED");
      return null;
    }
    registerCase(caseId);
    const current = cases.get(caseId);
    current.candidate = clone({ ...candidate, ...normalized });
    current.awaitingEvidence = false;
    set({ caseId, phase:"MEDICINE_REVIEW", decision:"CGO_CONSTRUCTED_CANDIDATE", nextAction:"MEDICINE_VERIFY_CANDIDATE", blocker:null, humanGate:false, candidate:clone(current.candidate) }, "CAPTAIN_CANDIDATE_CONSTRUCTED");
    const packet = directive("CGO_VERIFY_CANDIDATE", {
      caseId, proposalId:normalized.proposalId || null, candidate:clone(current.candidate),
      question:"CGO telah membangun candidate dari source/evidence internal. Medicine wajib memverifikasi root cause, exact source, anchor, fingerprint, dependency impact dan kelayakan perubahan sebelum candidate diteruskan ke Executor."
    }, { force:true });
    emit("CAPTAIN_MEDICINE_CANDIDATE_REVIEW", { candidate:clone(current.candidate), packet:clone(packet) });
    return packet;
  }

  function handleMedicine(packet) {
    latestMedicine = clone(packet);
    const caseId = packet.caseId || packet.medicine?.caseId || state.caseId;
    registerCase(caseId);
    const current = cases.get(caseId);
    if (packet.at && Date.now() - Number(packet.at) > CASE_STALE_MS) return;
    current.teamReports.medicine = true;
    const msg = String(packet.message || packet.medicineEvent || packet.type || "Medicine report");
    const phase = String(packet.phase || packet.medicine?.status || "").toUpperCase();

    if (packet.type === "MEDICINE_CANDIDATE_VERIFIED") {
      current.awaitingEvidence = false;
      set({
        phase:"HUMAN_APPROVAL",
        decision:"CANDIDATE_READY",
        nextAction:"HUMAN_APPROVAL",
        blocker:null,
        humanGate:true,
        candidate:clone(current.candidate)
      }, "CAPTAIN_CANDIDATE_VERIFIED_BY_MEDICINE_EXECUTOR");
      emit("CAPTAIN_CODE_READY", { candidate:clone(current.candidate), medicine:clone(packet) });
      return;
    }

    if (packet.type === "MEDICINE_FINALIZED_FOR_EXECUTION") {
      current.awaitingEvidence = false;
      current.finalized = true;
      set({
        phase: "EXECUTOR_HANDOFF",
        decision: "MEDICINE_FINALIZED",
        nextAction: "EXECUTOR_EXECUTE",
        blocker: null,
        humanGate: false,
        candidate: clone(current.candidate?.candidate || current.candidate || null)
      }, "CAPTAIN_MEDICINE_FINALIZED");
      emit("CAPTAIN_EXECUTOR_HANDOFF", { packet: clone(packet) });
      return;
    }

    if (packet.type === "MEDICINE_VALIDATION_RESULT") {
      const validation = packet.validation || {};
      const status = String(validation.status || "").toUpperCase();
      if (status === "FIXED_VERIFIED") {
        current.finalized = false;
        set({ phase: "RESOLVED", decision: "CASE_RESOLVED", nextAction: "CLOSE_CASE", blocker: null, humanGate: false }, "CAPTAIN_CASE_RESOLVED");
      } else if (status === "INTERNAL_VERIFIED_PENDING_DEPLOYMENT") {
        set({ phase: "VALIDATING", decision: "PENDING_DEPLOYMENT", nextAction: "WAIT_FOR_DEPLOYMENT", blocker: validation.note || "DEPLOYMENT_NOT_YET_VERIFIED", humanGate: false }, "CAPTAIN_VALIDATION_PENDING");
      } else {
        set({ phase: "REINVESTIGATING", decision: "VALIDATION_FAILED", nextAction: "MEDICINE_INVESTIGATE", blocker: validation.note || "VALIDATION_FAILED", humanGate: false }, "CAPTAIN_VALIDATION_FAILED");
        const retry = directive("CGO_INVESTIGATE", { caseId, target: packet.target || latestBCGO?.lastTelemetryFile || null, question: "Captain menerima validasi gagal. Medicine harus kembali ke evidence dan membuktikan penyebab yang tersisa." }, { force: true });
        if (retry) { current.investigationDispatched = true; current.awaitingEvidence = true; }
      }
      return;
    }

    if (packet.type === "MEDICINE_REPAIR_CANDIDATE") {
      current.candidate = clone(normalizeCandidatePacket(packet));
      current.awaitingEvidence = false;
      set({ phase: "EXECUTOR_REVIEW", decision: "WAIT_EXECUTOR_REVIEW", nextAction: "EXECUTOR_REVIEW", blocker: null, candidate: clone(packet.candidate || packet) }, "CAPTAIN_CANDIDATE_RECEIVED");
      return;
    }

    if (packet.type === "MEDICINE_CGO_UPDATE" || packet.type === "MEDICINE_CGO_ACK" || packet.type === "MEDICINE_CGO_BLOCKED" || packet.type === "MEDICINE_CGO_ERROR") {
      emit("CAPTAIN_MEDICINE_REPORT", { packet });
      maybePromptTeamAnalysis(caseId);
    }

    // WAITING/ACK/UPDATE are status, not failures. Only an explicit blocked or
    // proof-failure report may trigger a bounded retry. This prevents the
    // previous WAITING regex from turning every heartbeat into an endless loop.
    const explicitBlocked = packet.type === "MEDICINE_CGO_BLOCKED" ||
      packet.type === "MEDICINE_CGO_ERROR" ||
      /^(BLOCKED|INSUFFICIENT_EVIDENCE|UNPROVEN|CONTRADICTORY_EVIDENCE|SOURCE_NOT_VERIFIED|REJECTED)$/.test(phase);
    if (explicitBlocked) {
      const blockerKey = `${packet.type}|${phase}|${msg}`;
      const now = Date.now();
      const repeated = current.lastBlockerKey === blockerKey && (now - current.lastBlockerAt) < BLOCKER_REPEAT_COOLDOWN;
      current.awaitingEvidence = false;
      if (repeated) {
        set({ phase: "WAITING_EVIDENCE", decision: "HOLD_FOR_NEW_EVIDENCE", nextAction: "WAIT_FOR_MEDICINE", blocker: msg }, "CAPTAIN_HOLD");
        return;
      }
      current.lastBlockerKey = blockerKey;
      current.lastBlockerAt = now;
      if (current.round < MAX_ROUNDS) {
        current.round += 1;
        set({ round: current.round, phase: "REINVESTIGATING", decision: "REQUEST_MORE_EVIDENCE", nextAction: "MEDICINE_INVESTIGATE", blocker: msg }, "CAPTAIN_RETRY");
        const retry = directive("CGO_INVESTIGATE", {
          caseId,
          target: packet.target || packet.medicine?.target || latestBCGO?.lastTelemetryFile || null,
          question: `Captain menerima blocker nyata. Putaran ${current.round}/${MAX_ROUNDS}: cari evidence baru, koreksi target bila perlu, dan verifikasi source exact.`
        }, { force: true });
        if (retry) { current.investigationDispatched = true; current.awaitingEvidence = true; }
        return;
      }
      set({ phase: "BLOCKED", decision: "HOLD", nextAction: "HUMAN_REVIEW_REQUIRED", blocker: "MAX_INVESTIGATION_ROUNDS_REACHED" }, "CAPTAIN_HOLD");
    }
  }

  function handleExecutor(packet) {
    latestExecutor = clone(packet);
    const caseId = packet.caseId || packet.review?.caseId || state.caseId;
    registerCase(caseId);
    const current = cases.get(caseId);
    const review = packet.review || {};
    const status = String(review.status || packet.status || "").toUpperCase();
    if (packet.at && Date.now() - Number(packet.at) > CASE_STALE_MS) return;
    current.teamReports.executor = true;

    if (packet.type === "EXECUTION_CGO_UPDATE") maybePromptTeamAnalysis(caseId);

    if (packet.type === "EXECUTION_RESULT") {
      const result = packet.result || {};
      const status = String(result.status || packet.status || "").toUpperCase();
      if (status === "SUCCESS") {
        set({ phase: "VALIDATING", decision: "EXECUTION_COMPLETE_WAIT_VALIDATION", nextAction: "BCGO_VALIDATE", blocker: null, humanGate: false }, "CAPTAIN_EXECUTION_COMPLETE");
      } else {
        set({ phase: "REINVESTIGATING", decision: "EXECUTION_FAILED", nextAction: "MEDICINE_INVESTIGATE", blocker: result.reason || status || "EXECUTION_FAILED", humanGate: false }, "CAPTAIN_EXECUTION_FAILED");
      }
      emit("CAPTAIN_EXECUTION_REPORT", { packet: clone(packet) });
      return;
    }

    if (packet.type === "EXECUTION_REVIEW_RESULT") {
      if (status === "VALID") {
        const candidate = cases.get(caseId)?.candidate || null;
        const current = cases.get(caseId);
        if (current) current.awaitingEvidence = false;
        const normalizedCandidate = normalizeCandidatePacket(candidate);
        set({ phase: "HUMAN_APPROVAL", decision: "CANDIDATE_READY", nextAction: "HUMAN_APPROVAL", blocker: null, humanGate: true, candidate: clone(normalizedCandidate) }, "CAPTAIN_HUMAN_GATE");
        emit("CAPTAIN_CODE_READY", { candidate: clone(normalizedCandidate), review: clone(review) });
      } else {
        const current = cases.get(caseId);
        if (current && current.round < MAX_ROUNDS) current.round += 1;
        set({ round: current?.round || state.round, phase: "REINVESTIGATING", decision: "REJECT_CANDIDATE", nextAction: "MEDICINE_INVESTIGATE", blocker: review.reason || status || "EXECUTOR_REVIEW_REJECTED", humanGate: false }, "CAPTAIN_EXECUTOR_REJECT");
        const rejected = directive("CGO_REJECT_CANDIDATE", { caseId, reason: review.reason || `Executor review ${status || "REJECTED"}; source/evidence must be reacquired.` });
        if (current && rejected) { current.investigationDispatched = true; current.awaitingEvidence = true; }
      }
      return;
    }
    emit("CAPTAIN_EXECUTOR_REPORT", { packet });
  }

  function handleBCGOProbeResult(packet) {
    latestBCGO = clone(packet.state || latestBCGO || {});
    const caseId = packet.caseId || state.caseId;
    if (caseId) registerCase(caseId);
    const current = caseId ? cases.get(caseId) : null;
    if (current) current.awaitingEvidence = false;
    set({ phase:'BCGO_PROBE_RESULT', decision:'BCGO_PROBE_RESULT_RECEIVED', nextAction:'ASSESS_PROBE_RESULT', blocker:null }, 'CAPTAIN_BCGO_PROBE_RESULT');
    const assessment = assessBCGOExploration(latestBCGO);
    if (assessment?.conclusion === 'BCGO_EVIDENCE_REQUIRES_REVIEW') {
      const probe = dispatchNextBCGOProbe(latestBCGO, 'CAPTAIN_PROBE_RESULT_ASSESSED');
      if (!probe) set({ phase:'BCGO_EXPLORATION', decision:'EVIDENCE_REQUIRES_HUMAN_REVIEW', nextAction:'HUMAN_REVIEW', blocker:'PROBE_BUDGET_OR_NO_NEW_PROBE' }, 'CAPTAIN_PROBE_BOUNDARY');
    }
  }

  function handlePacket(packet) {
    if (!packet || packet.bridge !== BRIDGE) return;
    const id = String(packet.id || `${packet.from}:${packet.type}:${packet.at}:${packet.caseId || ""}`);
    if (seen.has(id)) return;
    seen.add(id);
    if (seen.size > 500) seen.delete(seen.values().next().value);
    if (packet.from === "BCGO" && packet.type === 'BCGO_PROBE_RESULT') handleBCGOProbeResult(packet);
    if (packet.from === "MEDICINE") handleMedicine(packet);
    if (packet.from === "EXECUTION") handleExecutor(packet);
  }

  function onBCGO(stateSnapshot) {
    if (!stateSnapshot || typeof stateSnapshot !== "object") return;
    latestBCGO = clone(stateSnapshot);
    const active = Array.isArray(latestBCGO?.activeCases) ? latestBCGO.activeCases : [];
    const primary = (state.caseId && active.find(x => (x.id || x.caseId || x.target) === state.caseId)) || active[0] || (latestBCGO?.lastTelemetryFile ? { id:`BCGO-${latestBCGO.lastTelemetryFile}`, target:latestBCGO.lastTelemetryFile } : null);
    if (primary) {
      const caseId = primary.id || primary.caseId || primary.target;
      const current = registerCase(caseId);
      current.teamReports.bcgo = true;
      const scan = latestBCGO?.sourceScan || {};
      const high = Array.isArray(scan.findings) ? scan.findings.filter(f => String(f.severity).toUpperCase() === "HIGH") : [];
      const cross = Array.isArray(scan.crossFileFindings) ? scan.crossFileFindings.filter(f => String(f.severity).toUpperCase() === "HIGH") : [];
      const target = primary.target || primary.source || latestBCGO?.lastTelemetryFile || null;
      current.bcgoReport = {
        target,
        sourceScanStatus: scan.status || null,
        filesReadable: Number(scan.filesReadable || 0),
        filesFailed: Number(scan.filesFailed || 0),
        highFindings: [...high, ...cross].slice(0, 8).map(f => ({ type:f.type, sourceFile:f.sourceFile || f.file || null, targetFile:f.targetFile || null, line:f.line || f.sourceLine || null, targetLine:f.targetLine || null, message:f.message || null })),
        lastTelemetryFile: latestBCGO?.lastTelemetryFile || null,
        at: Date.now()
      };
      set({ decision: "BCGO_REPORT_RECEIVED", nextAction: state.nextAction, blocker: null }, "CAPTAIN_BCGO_REPORT");
    }
    if (state.status === "WAITING") announceGreeting();
    const assessment = assessBCGOExploration(latestBCGO);
    if (assessment?.conclusion === 'BCGO_EVIDENCE_REQUIRES_REVIEW') return;
    chooseFromState();
  }

  function recoverBridgeCaches() {
    try {
      const candidate = localStorage.getItem(`${BRIDGE}_REPAIR_CANDIDATE`);
      if (candidate) handlePacket(JSON.parse(candidate));
    } catch {}
    try {
      const review = localStorage.getItem(`${BRIDGE}_EXECUTION_REVIEW`);
      if (review) handlePacket(JSON.parse(review));
    } catch {}
    try {
      const approval = localStorage.getItem(HUMAN_APPROVAL_KEY);
      if (approval) {
        const packet = JSON.parse(approval);
        const at = Number(packet?.at) || 0;
        if (at && Date.now() - at <= HUMAN_APPROVAL_MAX_AGE && packet?.caseId) {
          set({ status: "LIVE", phase: packet.decision === "APPROVE" ? "HUMAN_APPROVAL" : "REINVESTIGATING", decision: packet.decision === "APPROVE" ? "HUMAN_APPROVED" : "HUMAN_REJECTED", nextAction: packet.decision === "APPROVE" ? "MEDICINE_AUTHORIZE" : "MEDICINE_INVESTIGATE", humanGate: false }, "CAPTAIN_HUMAN_APPROVAL_RECOVERED");
        } else {
          localStorage.removeItem(HUMAN_APPROVAL_KEY);
        }
      }
    } catch {}
  }

  function start() {
    if (started) return api;
    started = true;
    channel?.addEventListener("message", e => handlePacket(e.data));
    if (typeof window !== "undefined") window.addEventListener("storage", e => {
      if (e.key !== `${BRIDGE}_EVENT` || !e.newValue) return;
      try { handlePacket(JSON.parse(e.newValue)); } catch {}
    });
    if (typeof window !== "undefined") window.addEventListener("cikur-bcgo-state", e => onBCGO(e.detail || {}));
    if (typeof window !== "undefined") window.addEventListener("cikur-internal-ai-state", e => {
      latestAI = clone(e.detail || {});
      emit("CAPTAIN_AI_UPDATE", { ai: latestAI });
    });
    if (typeof window !== "undefined" && window.BCGO_STATE) onBCGO(window.BCGO_STATE);
    set({ status: "WAITING", phase: "IDLE", nextAction: "WAIT_FOR_BCGO" }, "CAPTAIN_READY");
    recoverBridgeCaches();
    return api;
  }

  const api = Object.freeze({
    version: VERSION,
    start,
    stop() { try { channel?.close(); } catch {} started = false; },
    onState(fn) { if (typeof fn === "function") listeners.add(fn); return () => listeners.delete(fn); },
    getState() { return clone(state); },
    getSnapshot() { return { captain: clone(state), bcgo: clone(latestBCGO), ai: clone(latestAI), medicine: clone(latestMedicine), executor: clone(latestExecutor) }; },
    ingestBCGOState(snapshot = {}) { onBCGO(snapshot); return clone(state); },
    assessBCGOExploration(snapshot = latestBCGO) { return assessBCGOExploration(snapshot || {}); },
    chooseNextBCGOProbe(snapshot = latestBCGO) { return chooseNextBCGOProbe(snapshot || {}); },
    dispatchNextBCGOProbe(snapshot = latestBCGO) { return dispatchNextBCGOProbe(snapshot || {}); },
    submitConstructedCandidate(candidate, meta = {}) { return submitConstructedCandidate(candidate, meta); },
    requestUpdate() { return directive("CGO_REQUEST_UPDATE", { caseId: state.caseId }); },
    receiveHumanCommand,
    humanApprove(caseId = state.caseId) {
      if (!state.humanGate) return captainReply("Gerbang persetujuan belum terbuka. Saya tidak meneruskan approval.", { decision: "APPROVAL_BLOCKED" });
      state.humanGate = false;
      const packet = post("CGO_HUMAN_APPROVAL", { caseId, decision: "APPROVE", approvalId: `HUMAN-${caseId}-${Date.now()}` });
      persistHumanApproval(packet);
      return packet;
    },
    humanReject(caseId = state.caseId, reason = "Human menolak candidate melalui Captain.") {
      if (!state.humanGate) return captainReply("Gerbang keputusan belum terbuka. Saya tidak meneruskan penolakan di luar case candidate yang aktif.", { decision: "REJECTION_BLOCKED" });
      state.humanGate = false;
      const packet = post("CGO_HUMAN_APPROVAL", { caseId, decision: "REJECT", reason, approvalId: `HUMAN-${caseId}-${Date.now()}` });
      persistHumanApproval(packet);
      return packet;
    }
  });

  return api;
}

export const VERSION_EXPORT = VERSION;
