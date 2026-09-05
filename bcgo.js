import {
  collection,
  onSnapshot,
  query,
  orderBy,
  limit,
  doc,
  getDoc
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { db, auth } from "./cikur-config.js";

/*
 * BCGO MASTER NERVE SYSTEM v2.16.1 + FILE NERVE FOUNDATION
 *
 * Prinsip:
 * - Firestore = sumber fakta real-time.
 * - Tidak memakai AI/API eksternal.
 * - Chat adalah reasoning lokal berbasis state telemetry yang sedang hidup.
 * - Error lintas-file hanya dianggap ACTIVE bila ada bukti telemetry yang valid.
 * - Tidak pernah menulis source code secara otomatis.
 * - Medicine hanya menerima konteks kasus melalui telemetry; keputusan/perbaikan tetap terpisah.
 * - BCGO sendiri bukan organ telemetry; bcgo.html tidak dimasukkan ke registry agar monitor tidak mendiagnosis dirinya sendiri.
 * - bcgo.js adalah engine monitor dan tetap berada di diagnostic/dependency surface Medicine, bukan organ telemetry BCGO.
 * - Medicine bukan organ BCGO; dua file Medicine berada di diagnostic layer terpisah.
 */

const ORGAN_REGISTRY = {
  "index.html": { type: "Halaman Utama", role: "customer" },
  "assistant.html": { type: "Zona Customer", role: "customer" },
  "food.html": { type: "Zona Customer", role: "customer" },
  "ride.html": { type: "Zona Customer", role: "customer" },
  "cikurgo2in1.html": { type: "Zona Customer", role: "customer" },
  "agentcgo.html": { type: "Zona Mitra", role: "mitra" },
  "resto.html": { type: "Zona Mitra", role: "restaurant" },
  "driver.html": { type: "Zona Mitra", role: "driver" },
  "cikur-config.js": { type: "Sistem Config", role: "system" },
  "bcgo-engine.js": { type: "Sistem Core", role: "system" },
  "bcgo-admin.html": { type: "Sistem Admin", role: "admin" },
  "data-cgo.html": { type: "Data Sistem", role: "data" }
};

const ORGAN_COUNT = Object.keys(ORGAN_REGISTRY).length;

const SOURCE_SCAN_INTERVAL = 20000;
const SOURCE_SCAN_FETCH_TIMEOUT = 10000;
const SOURCE_SCAN_VERSION = "1.11.0-NERVE";

const ACTIVE_WINDOW = 15 * 60 * 1000;
const CLOCK_SKEW = 5 * 60 * 1000;
const LOG_LIMIT = 50;
const PROBE_LIMIT = 5;
const EVENT_LIMIT = 24;

const INTERNAL_TELEMETRY_SOURCES = new Set([
  "bcgo.html", "bcgo.js", "bcgo-medicine.html", "bcgo-medicine.js",
  "unhandledrejection", "error", "window.error", "runtime", "unknown"
]);

function telemetrySourceCandidates(log) {
  const values = [
    log?.fileName, log?.sourceFile, log?.filename, log?.file, log?.source,
    log?.target, log?.url, log?.script
  ].filter(Boolean);
  const stack = String(log?.stack || log?.errorStack || "");
  const matches = stack.match(/(?:https?:\/\/[^\s)]+\/)?[^\s/()]+\.(?:html|js)(?::\d+(?::\d+)?)?/gi) || [];
  return [...values, ...matches].map(normalizeFile).filter(Boolean);
}

function isInternalTelemetry(log) {
  return telemetrySourceCandidates(log).some(file => INTERNAL_TELEMETRY_SOURCES.has(String(file).toLowerCase()));
}
const CYCLE = { IN: 2200, PROCESS: 2200, REVIEW: 2200, OUT: 1800 };

const normalizeFile = value => {
  const raw = String(value || "").trim();
  if (!raw) return "UNKNOWN";
  const clean = raw.split("?")[0].split("#")[0];
  return clean.substring(clean.lastIndexOf("/") + 1) || raw;
};

export function runAutonomousEngine(onCycleUpdate) {
  let internalAI = null;
  let internalAIStatus = "WAITING";
  let internalAIError = null;
  if (typeof onCycleUpdate !== "function") {
    throw new TypeError("BCGO membutuhkan callback UI.");
  }

  let stopped = false;
  let authorized = false;
  let authorizedUid = null;
  let authEpoch = 0;
  let cycleNo = 0;
  let phaseIndex = -1;
  let cycleTimer = null;
  let refreshTimer = null;
  let unsubscribeAuth = null;
  let unsubscribeFirestore = null;
  let unsubscribeSystemLogs = null;
  let latestSystemLogs = [];
  let previousTopSignature = "";
  let realtimeBusy = false;
  let interruptTimerProcess = null;
  let interruptTimerReview = null;
  let interruptGeneration = 0;
  let sourceScanTimer = null;
  let sourceScanBusy = false;
  let sourceScanGeneration = 0;

  const firestore = { connected: false, count: 0, error: null, lastServerAt: 0 };
  async function loadInternalAI() {
    if (stopped || internalAI) return internalAI;
    try {
      const mod = await import("./cikur-internal-ai-runtime-adapter-v9.js?v=5.2.5-sync-20260905");
      if (typeof mod.install !== "function") throw new Error("INTERNAL_AI_ADAPTER_INVALID");
      internalAI = mod.install();
      internalAIStatus = "READY";
      internalAIError = null;
      recordEvent("INTERNAL_AI", "Internal AI adapter aktif; BCGO_STATE mulai diserahkan setelah sensor BCGO hidup.", "SYS_INTERNAL_AI_READY");
      publishToUI(safeClone(state));
      return internalAI;
    } catch (primaryError) {
      // Compatibility fallback: the current brain bridge may already be deployed
      // under cgo-ai-browser-adapter.js. BCGO must never die merely because an
      // optional reasoning adapter is absent.
      try {
        const mod = await import("./cgo-ai-browser-adapter.js?v=5.2.5-sync-20260905");
        if (typeof mod.install !== "function") throw new Error("BROWSER_BRAIN_ADAPTER_INVALID");
        internalAI = mod.install();
        internalAIStatus = "READY";
        internalAIError = null;
        recordEvent("INTERNAL_AI", "Internal AI browser bridge aktif melalui adapter V5.2.", "SYS_INTERNAL_AI_READY");
        publishToUI(safeClone(state));
        return internalAI;
      } catch (fallbackError) {
        internalAIStatus = "UNAVAILABLE";
        internalAIError = fallbackError?.message || primaryError?.message || String(fallbackError);
        state.internalAI = {
          version:null, signal:"WAITING", classification:"BCGO_SENSOR_ONLY",
          status:"ADAPTER_UNAVAILABLE", error:internalAIError,
          precisionGate:{pass:false, blockers:["INTERNAL_AI_NOT_LOADED"]}, at:Date.now()
        };
        recordEvent("INTERNAL_AI_WAITING", "BCGO tetap hidup sebagai sensor; adapter Internal AI belum tersedia.", "SYS_INTERNAL_AI_WAITING");
        publishToUI(safeClone(state));
        return null;
      }
    }
  }

  function ingestInternalAI(snapshot) {
    if (!internalAI || typeof internalAI.ingestBCGOState !== "function") return null;
    try {
      return internalAI.ingestBCGOState(snapshot);
    } catch (error) {
      internalAIStatus = "ERROR";
      internalAIError = error?.message || String(error);
      console.warn("CIKUR Internal AI intake error:", error);
      return null;
    }
  }

  const state = {
    step: "IN",
    message: "Membangunkan Pusat Saraf Master...",
    targetCell: "SYS_MASTER_REGISTRY",
    errorLog: null,
    retryCount: 0,
    cycle: 0,
    cycleMode: "BOOT",
    metrics: { total: ORGAN_COUNT, active: 0, recovered: 0, healthy: ORGAN_COUNT, firestoreCount: 0 },
    systemOrgans: {},
    systemLogs: [],
    recentEvents: [],
    firestore: { ...firestore },
    lastEventAt: null,
    lastTelemetryFile: null,
    lastTelemetryAt: null,
    lastTelemetryMessage: null,
    activeCases: [],
    medicineQueue: [],
    connection: { status: "CONNECTING", lastServerAt: 0 },
    fileNerves: {},
    sourceScan: {
      version: SOURCE_SCAN_VERSION, status: "WAITING", startedAt: 0, completedAt: 0,
      filesScanned: 0, filesReadable: 0, filesFailed: 0, currentFile: null, currentIndex: 0,
      totalFiles: ORGAN_COUNT, phase: "WAITING", fileStates: {}, findings: [], crossFileFindings: [], relations: [], relationSummary: { synchronized:0, mismatch:0, variant:0, unknown:0 },
      sources: {}, message: "Pemindaian source code belum dimulai."
    },
    medicineBridge: {
      status: "DISCONNECTED",
      lastAt: 0,
      lastEvent: null,
      lastCaseId: null,
      message: null
    },
    executionBridge: {
      status: "DISCONNECTED",
      lastAt: 0,
      lastEvent: null,
      lastCaseId: null,
      requestId: null,
      reviewStatus: null,
      message: null
    }
  };


  // ============================================================
  // BCGO ↔ MEDICINE NERVE
  // BCGO is the master state producer.
  // Medicine is a separate diagnostic consumer/producer.
  // There is deliberately NO import between the two engines.
  // ============================================================
  const MEDICINE_BRIDGE_KEY = "CIKUR_GO_BCGO_MEDICINE_V1";
  const MEDICINE_BRIDGE_STATE_KEY = `${MEDICINE_BRIDGE_KEY}_STATE`;
  const MEDICINE_BRIDGE_EVENT_KEY = `${MEDICINE_BRIDGE_KEY}_EVENT`;
  const medicineBridgeChannel =
    typeof BroadcastChannel !== "undefined"
      ? new BroadcastChannel(MEDICINE_BRIDGE_KEY)
      : null;

  let lastMedicineBridgeAt = 0;
  const seenMedicineBridgeIds = new Set();

  function bridgeClone(value) {
    try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
  }

  function buildInternalAIHandoff(aiSnapshot) {
    const r = aiSnapshot?.reasoning || {};
    const g = aiSnapshot?.guardian || {};
    return { version:aiSnapshot?.version||null, reasoningVersion:aiSnapshot?.reasoningVersion||null, knowledgeVersion:aiSnapshot?.knowledgeVersion||null, guardianVersion:aiSnapshot?.guardianVersion||null, signal:aiSnapshot?.signal||"UNKNOWN", classification:r.classification||"UNKNOWN", evidenceCount:Array.isArray(r.evidence)?r.evidence.length:0, independentEvidenceCount:Number(r.correlations?.independentEvidenceCount||0), hypotheses:Array.isArray(r.hypotheses)?r.hypotheses.slice(0,10):[], selectedHypothesisId:r.selectedHypothesisId||null, precisionGate:{pass:r.precisionGate?.pass===true,blockers:Array.isArray(r.precisionGate?.blockers)?r.precisionGate.blockers.slice(0,20):[]}, investigation:r.investigation||null, operationalInvestigation:r.operationalInvestigation||null, causalLinks:Array.isArray(r.causalLinks)?r.causalLinks.slice(0,30):[], guardian:{healthy:g.healthy===true,level:g.level||"UNKNOWN",issues:Array.isArray(g.issues)?g.issues.slice(0,10):[]}, at:aiSnapshot?.at||Date.now() };
  }

  function publishBCGOStateToMedicine(snapshot) {
    const packet = {
      id: `BCGO-${Date.now()}-${state.cycle}-${Math.random().toString(36).slice(2,8)}`,
      bridge: "CIKUR_GO_BCGO_MEDICINE_V1",
      from: "BCGO",
      type: "BCGO_STATE",
      at: Date.now(),
      state: bridgeClone(snapshot)
    };

    try { medicineBridgeChannel?.postMessage(packet); } catch {}
    try {
      localStorage.setItem(MEDICINE_BRIDGE_STATE_KEY, JSON.stringify(packet));
    } catch {}
  }

  function receiveMedicineBridge(packet) {
    if (!packet ||
        packet.bridge !== "CIKUR_GO_BCGO_MEDICINE_V1" ||
        packet.from !== "MEDICINE") return;

    const at = Number(packet.at) || Date.now();
    const packetId = String(packet.id || `${packet.type || "MEDICINE"}-${at}-${packet.caseId || ""}`);

    // BroadcastChannel + localStorage can deliver the same event twice.
    if (seenMedicineBridgeIds.has(packetId)) return;
    seenMedicineBridgeIds.add(packetId);
    if (seenMedicineBridgeIds.size > 200) {
      const first = seenMedicineBridgeIds.values().next().value;
      seenMedicineBridgeIds.delete(first);
    }
    if (at < lastMedicineBridgeAt) return;
    lastMedicineBridgeAt = at;

    state.medicineBridge = {
      status: "LIVE",
      lastAt: at,
      lastEvent: packet.medicineEvent || packet.type || "MEDICINE",
      lastCaseId: packet.caseId || packet.case?.id || null,
      message: String(packet.message || "").slice(0, 500) || null
    };

    recordEvent(
      "MEDICINE",
      state.medicineBridge.message || `Medicine event: ${state.medicineBridge.lastEvent}`,
      state.medicineBridge.lastCaseId || "MEDICINE"
    );

    // IMPORTANT: update local UI only. Do NOT call publishBCGOStateToMedicine()
    // here. This keeps the bridge from becoming a feedback loop.
    publishToUI(safeClone(state));
  }

  if (medicineBridgeChannel) {
    medicineBridgeChannel.addEventListener("message", event => {
      receiveMedicineBridge(event.data);
    });
  }

  window.addEventListener("storage", event => {
    if (event.key !== "CIKUR_GO_BCGO_MEDICINE_V1_EVENT" || !event.newValue) return;
    try { receiveMedicineBridge(JSON.parse(event.newValue)); } catch {}
  });

  const EXECUTION_REVIEW_KEY = `${MEDICINE_BRIDGE_KEY}_EXECUTION_REVIEW`;
  const EXECUTION_ACK_KEY = `${MEDICINE_BRIDGE_KEY}_INVESTIGATION_ACK`;
  const seenExecutionBridgeIds = new Set();
  let executionBridgeTimer = null;

  function receiveExecutionBridge(packet) {
    if (!packet || packet.bridge !== MEDICINE_BRIDGE_KEY || packet.from !== "EXECUTION") return;
    const at = Number(packet.at) || Date.now();
    const packetId = String(packet.id || `${packet.type || "EXECUTION"}-${at}-${packet.requestId || packet.investigationId || ""}`);
    if (seenExecutionBridgeIds.has(packetId)) return;
    seenExecutionBridgeIds.add(packetId);
    if (seenExecutionBridgeIds.size > 300) {
      const first = seenExecutionBridgeIds.values().next().value;
      seenExecutionBridgeIds.delete(first);
    }

    const review = packet.review || null;
    const isReview = packet.type === "EXECUTION_REVIEW_RESULT";
    const status = review?.status || packet.status || (packet.type === "EXECUTION_INVESTIGATION_ACK" ? "REVIEWING" : "RECEIVED");
    const message = String(packet.message || review?.reason || (isReview ? `Execution review: ${status}` : "Execution menerima sesi investigasi.")).slice(0, 500);

    state.executionBridge = {
      status: "LIVE",
      lastAt: at,
      lastEvent: packet.type || "EXECUTION",
      lastCaseId: packet.caseId || null,
      requestId: packet.requestId || review?.requestId || null,
      reviewStatus: status,
      message
    };

    recordEvent(
      "EXECUTION",
      message,
      packet.caseId || packet.requestId || "EXECUTION"
    );
    publishToUI(safeClone(state));
  }

  if (medicineBridgeChannel) {
    medicineBridgeChannel.addEventListener("message", event => receiveExecutionBridge(event.data));
  }

  window.addEventListener("storage", event => {
    if (!event.newValue) return;
    if (event.key !== EXECUTION_REVIEW_KEY && event.key !== EXECUTION_ACK_KEY) return;
    try { receiveExecutionBridge(JSON.parse(event.newValue)); } catch {}
  });

  function timestamp(value) {
    try {
      if (!value) return 0;
      if (typeof value.toMillis === "function") return value.toMillis();
      if (typeof value.toDate === "function") return value.toDate().getTime();
      if (value instanceof Date) return value.getTime();
      if (typeof value === "number") return value;
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : 0;
    } catch {
      return 0;
    }
  }

  function safeClone(value) {
    try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
  }

  // UI adalah konsumen state. Kegagalan render tidak boleh mematikan engine
  // dan tidak boleh berubah menjadi anomaly pada organ bcgo.html.
  function publishToUI(snapshot) {
    try {
      onCycleUpdate(snapshot);
    } catch (uiError) {
      state.uiError = String(uiError?.message || uiError || "UI render error").slice(0, 500);
      console.warn("BCGO UI render error (engine tetap hidup):", state.uiError);
    }
  }

  function recordEvent(type, message, target = "SYSTEM") {
    state.recentEvents.unshift({ type, message, target, at: Date.now() });
    state.recentEvents = state.recentEvents.slice(0, EVENT_LIMIT);
    state.lastEventAt = Date.now();
  }

  function refreshExecutionBridge() {
    if (!state.executionBridge?.lastAt) return;
    if (Date.now() - state.executionBridge.lastAt > ACTIVE_WINDOW && state.executionBridge.status === "LIVE") {
      state.executionBridge.status = "STALE";
      publishToUI(safeClone(state));
    }
  }
  if (executionBridgeTimer === null) {
    executionBridgeTimer = setInterval(refreshExecutionBridge, 3000);
  }

  function effectiveAge(t) {
    if (!t) return Infinity;
    return Math.max(0, Date.now() - t);
  }

  function isRecent(t) {
    // Hanya sinyal dalam window aktif yang boleh menjadi ANOMALY.
    // BUG FIX: kondisi lama memakai OR sehingga SEMUA timestamp lama ikut dianggap aktif.
    const nowMs = Date.now();
    return t > 0 && t >= nowMs - ACTIVE_WINDOW && t <= nowMs + CLOCK_SKEW;
  }

  function newestLogByFile() {
    const map = new Map();
    for (const log of latestSystemLogs) {
      const file = normalizeFile(log?.fileName);
      if (!ORGAN_REGISTRY[file]) continue;
      const t = timestamp(log?.reportedAt);
      const candidate = { log, time: t };
      const previous = map.get(file);
      if (!previous || candidate.time >= previous.time) map.set(file, candidate);
    }
    return map;
  }

  // ============================================================
  // BCGO SOURCE CODE SCANNER — REAL SOURCE, PROGRESSIVE STATE
  // ============================================================
  function sourceLineNumber(text, index) {
    return String(text || '').slice(0, index).split('\n').length;
  }

  function sourceHash(text) {
    let hash = 2166136261;
    const input = String(text || '');
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function sourceUrl(file) {
    return new URL(file, window.location.href).href;
  }

  function extractLocalRefs(file, source) {
    const refs = new Set();
    const text = String(source || '');
    const re = /(?:src|href|import\s*\(|from\s*|fetch\s*\(|location(?:\.href)?\s*=\s*)["'`.]?([^"'`\s)]+\.(?:html|js)(?:\?[^"'`\s)]*)?)/gi;
    let match;
    while ((match = re.exec(text))) {
      const normalized = normalizeFile(match[1]);
      if (ORGAN_REGISTRY[normalized] && normalized !== file) refs.add(normalized);
    }
    return [...refs];
  }

  function extractFunctionSurface(text) {
    const functions = new Map();
    const source = String(text || '');
    const captures = [];
    const declarationRe = /(?:^|[;{}\n])\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/g;
    const arrowRe = /(?:^|[;{}\n])\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/g;
    const functionExprRe = /(?:^|[;{}\n])\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?function\s*\(([^)]*)\)\s*\{/g;
    for (const [re, kind] of [[declarationRe,'DECLARATION'],[arrowRe,'ARROW'],[functionExprRe,'FUNCTION_EXPR']]) {
      let match;
      while ((match = re.exec(source))) captures.push({ match, kind });
    }
    const extractStringAnchors = body => {
      const values = [];
      const re = /(['"`])((?:\\.|(?!\1)[^\\]){2,120})\1/g;
      let m;
      while ((m = re.exec(String(body || '')))) {
        const v = String(m[2]).trim();
        if (!v || /^(use strict|javascript|text|click|change|submit|active|block|none)$/i.test(v)) continue;
        if (/^[A-Za-z_$][\w$.-]{2,80}$/.test(v) || /[A-Za-z]{4,}/.test(v)) values.push(v.toLowerCase());
      }
      return [...new Set(values)];
    };
    const extractDomAnchors = body => {
      const out = new Set();
      const textBody = String(body || '');
      const patterns = [
        /getElementById\(\s*['"]([^'"]+)['"]\s*\)/gi,
        /querySelector(?:All)?\(\s*['"]([^'"]+)['"]\s*\)/gi,
        /getElementsBy(?:ClassName|Name|TagName)\(\s*['"]([^'"]+)['"]\s*\)/gi
      ];
      for (const re of patterns) {
        let m;
        while ((m = re.exec(textBody))) out.add(String(m[1]).toLowerCase());
      }
      return [...out];
    };
    const extractCalls = body => {
      const out = new Set();
      const re = /\b([A-Za-z_$][\w$]*)\s*\(/g;
      let m;
      while ((m = re.exec(String(body || '')))) {
        const n = m[1];
        if (!['if','for','while','switch','catch','function','setTimeout','setInterval','String','Number','Boolean','Math','Date','Array','Object','Promise','Error'].includes(n)) out.add(n.toLowerCase());
      }
      return [...out];
    };
    for (const { match, kind } of captures.sort((a,b) => a.match.index - b.match.index)) {
      const name = match[1];
      const rawParams = match[2] || '';
      const params = rawParams.replace(/^\(|\)$/g, '').trim();
      const start = match.index + match[0].lastIndexOf('{');
      let depth = 0, quote = null, escaped = false, end = start;
      for (let i = start; i < source.length; i++) {
        const ch = source[i];
        if (quote) {
          if (escaped) { escaped = false; continue; }
          if (ch === '\\') { escaped = true; continue; }
          if (ch === quote) quote = null;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
      }
      const body = source.slice(start, end);
      const domAnchors = extractDomAnchors(body);
      const stringAnchors = extractStringAnchors(body);
      const callNames = extractCalls(body);
      const bodyTokens = [...codeTokenSet(body)];
      functions.set(name, {
        name, kind,
        line: sourceLineNumber(source, match.index),
        params,
        bodyLength: body.length,
        bodyHash: sourceHash(body),
        normalizedBody: body.replace(/\s+/g, ' ').trim(),
        bodyText: body,
        domAnchors,
        stringAnchors,
        callNames,
        anchorTokens: [...new Set([...domAnchors, ...stringAnchors, ...callNames])],
        tokenCount: bodyTokens.length
      });
    }
    return [...functions.values()];
  }

  function extractDomSurface(file, source) {
    const text = String(source || '');
    const ids = new Map();
    const onclicks = [];
    const idRe = /\bid\s*=\s*["']([^"']+)["']/gi;
    let match;
    while ((match = idRe.exec(text))) {
      const id = match[1].trim();
      if (!id) continue;
      if (!ids.has(id)) ids.set(id, sourceLineNumber(text, match.index));
    }
    const eventRe = /\bon(?:click|submit|change|input)\s*=\s*["']([^"']+)["']/gi;
    while ((match = eventRe.exec(text))) {
      const expr = match[1].trim();
      const fn = /^([A-Za-z_$][\w$]*)\s*\(/.exec(expr);
      if (fn) onclicks.push({ name: fn[1], line: sourceLineNumber(text, match.index), expression: expr });
    }
    return { ids:[...ids.entries()].map(([id,line]) => ({id,line})), onclicks };
  }

  function normalizeSurfaceToken(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/&(?:amp|nbsp|quot|apos|lt|gt);/g, ' ')
      .replace(/[^a-z0-9_$-]+/g, ' ')
      .split(/\s+/)
      .filter(token => token.length >= 2)
      .join(' ')
      .trim();
  }

  function collectAttributeEntries(body, text, bodyOffset) {
    const entries = [];
    const re = /\b(?:name|id|data-field|data-name|placeholder|aria-label)\s*=\s*["']([^"']+)["']/gi;
    let match;
    while ((match = re.exec(body))) {
      const value = match[1].trim();
      if (!value) continue;
      entries.push({ value, normalized: normalizeSurfaceToken(value), line: sourceLineNumber(text, bodyOffset + match.index) });
    }
    return entries;
  }

  function extractFormHandlerRefs(body, text, bodyOffset) {
    const refs = [];
    const seen = new Set();
    const patterns = [
      /\bon(?:click|submit|change|input)\s*=\s*["']\s*([A-Za-z_$][\w$]*)\s*\(/gi,
      /\b(?:onsubmit|onclick)\s*=\s*["'][^"']*?\b([A-Za-z_$][\w$]*)\s*\(/gi
    ];
    for (const re of patterns) {
      let match;
      while ((match = re.exec(body))) {
        const name = match[1];
        if (!seen.has(name)) {
          seen.add(name);
          refs.push({ name, line: sourceLineNumber(text, bodyOffset + match.index) });
        }
      }
    }
    return refs;
  }

  function scanHtmlSource(file, source) {
    const findings = [];
    const text = String(source || '');
    const ids = new Map();
    const tagStack = [];
    const trackedTags = new Set(['div','section','form','main','header','footer','script','style']);
    const tagRe = /<\/?([a-zA-Z][\w:-]*)(\s[^>]*?)?\/?\s*>/g;
    // Structural HTML parsing must not interpret '<div>' / '</div>' strings
    // inside inline JavaScript or CSS as real DOM tags. Keep offsets/line
    // numbers identical while blanking script/style bodies for the tag stack.
    const structuralText = text.replace(/(<script\b[^>]*>)[\s\S]*?(<\/script\s*>)/gi, (_,open,close) => open + ' '.repeat(Math.max(0, _.length - open.length - close.length)) + close)
      .replace(/(<style\b[^>]*>)[\s\S]*?(<\/style\s*>)/gi, (_,open,close) => open + ' '.repeat(Math.max(0, _.length - open.length - close.length)) + close);
    let match;
    while ((match = tagRe.exec(structuralText))) {
      const tag = match[1].toLowerCase();
      const raw = match[0];
      const line = sourceLineNumber(text, match.index);
      if (raw.startsWith('</')) {
        if (trackedTags.has(tag)) {
          const pos = tagStack.map(x => x.tag).lastIndexOf(tag);
          if (pos === -1) findings.push({ severity:'HIGH', type:'UNBALANCED_HTML', file, line, message:`Tag </${tag}> tidak memiliki pasangan pembuka yang sesuai.` });
          else tagStack.splice(pos, 1);
        }
      } else {
        const attrs = match[2] || '';
        const selfClosing = /\/\s*>$/.test(raw) || ['meta','link','img','input','br','hr','source','area','base','embed','param','track','wbr'].includes(tag);
        const idMatch = /\bid\s*=\s*["']([^"']+)["']/i.exec(attrs);
        if (idMatch) {
          const id = idMatch[1].trim();
          if (ids.has(id)) findings.push({ severity:'HIGH', type:'DUPLICATE_ID', file, line, message:`ID "${id}" muncul lebih dari sekali (sebelumnya baris ${ids.get(id)}).` });
          else ids.set(id, line);
        }
        if (trackedTags.has(tag) && !selfClosing) tagStack.push({ tag, line });
      }
    }
    for (const unclosed of tagStack.slice(-12)) findings.push({ severity:'HIGH', type:'UNBALANCED_HTML', file, line:unclosed.line, message:`Tag <${unclosed.tag}> belum memiliki penutup.` });

    const forms = [];
    const formRe = /<form\b([^>]*)>([\s\S]*?)<\/form\s*>/gi;
    while ((match = formRe.exec(text))) {
      const attrs = match[1] || '', body = match[2] || '';
      const bodyOffset = match.index + match[0].indexOf('>') + 1;
      const attr = key => { const r = new RegExp(`\\b${key}\\s*=\\s*["']([^"']+)["']`, 'i').exec(attrs); return r ? r[1].trim() : ''; };
      const key = attr('id') || attr('name') || attr('data-form') || attr('data-form-id');
      const fieldEntries = collectAttributeEntries(body, text, bodyOffset);
      const fields = [...new Map(fieldEntries.map(x => [x.normalized, x])).values()].filter(x => x.normalized).sort((a,b)=>a.normalized.localeCompare(b.normalized));
      const controls = [...body.matchAll(/<(?:input|select|textarea|button)\b[^>]*>/gi)].map(x => ({ line:sourceLineNumber(text, bodyOffset + x.index), tag:x[0].match(/^<(\w+)/)?.[1]?.toLowerCase() || 'control' }));
      const semanticTokens = [];
      const pushTokens = value => {
        const normalized = normalizeSurfaceToken(value);
        if (normalized) semanticTokens.push(...normalized.split(' '));
      };
      for (const x of body.matchAll(/\b(?:name|id|data-field|data-name|placeholder|aria-label|type)\s*=\s*["']([^"']+)["']/gi)) pushTokens(x[1]);
      for (const x of body.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/gi)) pushTokens(x[1].replace(/<[^>]+>/g,' '));
      for (const x of body.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gi)) pushTokens(x[1].replace(/<[^>]+>/g,' '));
      const semanticSurface = [...new Set(semanticTokens)].sort();
      const submitMatch = /\bonsubmit\s*=\s*["']([^"']+)["']/i.exec(attrs);
      const submitHandler = submitMatch ? submitMatch[1].trim() : '';
      const action = attr('action');
      const handlerRefs = extractFormHandlerRefs(body, text, bodyOffset);
      const surfaceLabel = [...body.matchAll(/<(?:h[1-6]|label|button)\b[^>]*>([\s\S]*?)<\/(?:h[1-6]|label|button)>/gi)]
        .map(x => normalizeSurfaceToken(x[1].replace(/<[^>]+>/g,' '))).filter(Boolean).slice(0,12);
      forms.push({
        key:key.toLowerCase(), line:sourceLineNumber(text, match.index),
        fields:fields.map(x=>x.normalized), fieldEntries:fields,
        semanticSurface, surfaceLabel,
        controlCount:controls.length, controlLines:controls,
        submitHandler, action, handlerRefs,
        completenessScore:fields.length * 4 + semanticSurface.length + controls.length * 2 + (submitHandler ? 5 : 0) + (action ? 2 : 0) + handlerRefs.length * 3
      });
    }
    const dom = extractDomSurface(file, text);
    return { findings, forms, ids:[...ids.entries()].map(([id,line]) => ({id,line})), onclicks:dom.onclicks, functions:extractFunctionSurface(text) };
  }

  function scanJsSource(file, source) {
    const findings = [];
    const text = String(source || '');
    let depth = 0, quote = null, escaped = false, line = 1;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '\n') line++;
      if (quote) {
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      if (depth < 0) { findings.push({ severity:'HIGH', type:'UNBALANCED_JS', file, line, message:'Kurung kurawal penutup lebih banyak daripada pembuka.' }); break; }
    }
    if (quote) findings.push({ severity:'HIGH', type:'UNTERMINATED_STRING', file, line, message:'String/template literal tampak tidak tertutup.' });
    if (depth !== 0) findings.push({ severity:'HIGH', type:'UNBALANCED_JS', file, line, message:`Keseimbangan kurung kurawal gagal (depth=${depth}).` });
    return { findings, forms:[], ids:[], onclicks:[], functions:extractFunctionSurface(text) };
  }

  function scanSourceFile(file, source) {
    const parsed = /\.html?$/i.test(file) ? scanHtmlSource(file, source) : scanJsSource(file, source);
    return {
      file, type:ORGAN_REGISTRY[file]?.type || 'UNKNOWN', role:ORGAN_REGISTRY[file]?.role || 'unknown',
      bytes:new Blob([source]).size, lines:String(source).split('\n').length, hash:sourceHash(source),
      rawSource:String(source), refs:extractLocalRefs(file, source), ...parsed
    };
  }

  // Compact source intelligence: cukup untuk investigasi Internal AI tanpa mengirim
  // seluruh source code ke BCGO_STATE. Source asli tetap hanya berada di scanner.
  function extractSymbolFromText(value) {
    const m = String(value || '').match(/(?:ReferenceError|is not defined)\s*:?\s*([A-Za-z_$][\w$]*)/i);
    return m ? m[1] : null;
  }

  function sourceLineHits(source, symbol) {
    if (!symbol) return [];
    const re = new RegExp(`\\b${String(symbol).replace(/[.*+?^${}()|[\\]\\]/g,'\\$&')}\\b`, 'g');
    const lines = String(source || '').split('\n');
    const hits = [];
    for (let i=0;i<lines.length && hits.length<12;i++) if (re.test(lines[i])) { hits.push({line:i+1,text:lines[i].trim().slice(0,220)}); re.lastIndex=0; }
    return hits;
  }

  function buildSourceIntelligence(scanned, logs) {
    const files = {};
    const symbols = new Map();
    const runtimeSymbols = [];
    for (const [file,item] of Object.entries(scanned)) {
      const functions = (item.functions || []).map(fn => ({
        name:fn.name, line:fn.line, params:fn.params || '', bodyHash:fn.bodyHash,
        callNames:(fn.callNames || []).slice(0,80), domAnchors:(fn.domAnchors || []).slice(0,40),
        stringAnchors:(fn.stringAnchors || []).slice(0,40)
      }));
      const functionNames = functions.map(x => x.name);
      const calledNames = [...new Set(functions.flatMap(x => x.callNames || []))];
      files[file] = {
        file, type:item.type, role:item.role, lines:item.lines, bytes:item.bytes, hash:item.hash,
        refs:(item.refs || []).slice(0,80), functions, functionNames, calledNames,
        ids:(item.ids || []).slice(0,120),
        onclicks:(item.onclicks || []).slice(0,80).map(x=>({name:x.name,line:x.line,expression:String(x.expression||'').slice(0,220)})),
        forms:(item.forms || []).slice(0,40).map(x=>({key:x.key,line:x.line,handlers:x.handlerRefs||[],submitHandler:x.submitHandler||null,action:x.action||null})),
        findings:(item.findings || []).slice(0,40)
      };
      for (const fn of functions) {
        const k=fn.name.toLowerCase();
        if (!symbols.has(k)) symbols.set(k,{symbol:fn.name,definedIn:[],calledIn:[],onclickIn:[],importedBy:[]});
        symbols.get(k).definedIn.push({file,line:fn.line});
      }
      for (const called of calledNames) {
        const k=called.toLowerCase();
        if (!symbols.has(k)) symbols.set(k,{symbol:called,definedIn:[],calledIn:[],onclickIn:[],importedBy:[]});
        const holder=symbols.get(k);
        holder.calledIn.push({file,lines:functions.filter(fn=>(fn.callNames||[]).includes(called)).map(fn=>fn.line).slice(0,12)});
      }
      for (const click of item.onclicks || []) {
        const k=String(click.name||'').toLowerCase();
        if (!k) continue;
        if (!symbols.has(k)) symbols.set(k,{symbol:click.name,definedIn:[],calledIn:[],onclickIn:[],importedBy:[]});
        symbols.get(k).onclickIn.push({file,line:click.line});
      }
    }
    const logSymbols = (logs || []).map(l => extractSymbolFromText(l?.message||l?.error||l?.text)).filter(Boolean);
    const findingSymbols = Object.values(scanned).flatMap(x=>(x.findings||[]).map(f=>extractSymbolFromText(f?.message||f?.error||f?.detail))).filter(Boolean);
    for (const symbol of [...new Set([...logSymbols,...findingSymbols])].slice(0,30)) {
      const k=symbol.toLowerCase(), rec=symbols.get(k)||{symbol,definedIn:[],calledIn:[],onclickIn:[],importedBy:[]};
      for (const [file,item] of Object.entries(scanned)) {
        const hits=sourceLineHits(item.rawSource,symbol);
        if (hits.length) rec.sourceHits=(rec.sourceHits||[]).concat(hits.map(h=>({file,...h}))).slice(0,24);
        if ((item.refs||[]).some(r=>String(r).toLowerCase().includes(k))) rec.importedBy.push({file,ref:rec.symbol});
      }
      rec.status = rec.definedIn.length ? (rec.definedIn.length===1 ? 'DEFINED_ONCE' : 'DEFINED_MULTIPLE') : 'NOT_DEFINED_IN_SCANNED_SOURCE';
      runtimeSymbols.push(rec);
    }
    return {version:'1.0.0-source-intelligence',generatedAt:Date.now(),files,symbols:runtimeSymbols,policy:{rawSourceExcluded:true,definitionsAreSourceEvidence:true,absenceOnlyMeansNotFoundInScannedSources:true,rootCauseStillRequiresMedicine:true}};
  }

  function tokenSet(values) {
    return new Set((values || []).map(v => String(v || '').toLowerCase().trim()).filter(Boolean));
  }

  function jaccardSimilarity(aValues, bValues) {
    const a = tokenSet(aValues), b = tokenSet(bValues);
    if (!a.size && !b.size) return 1;
    if (!a.size || !b.size) return 0;
    let intersection = 0;
    for (const value of a) if (b.has(value)) intersection++;
    return intersection / new Set([...a, ...b]).size;
  }

  function formSurfaceTokens(form, includeKey = false) {
    const values = [
      ...(includeKey ? [form?.key] : []),
      ...(form?.fields || []),
      ...(form?.semanticSurface || []),
      form?.submitHandler,
      form?.action
    ];
    return values.filter(Boolean).map(v => String(v).replace(/[^a-zA-Z0-9_$:-]/g, '').toLowerCase()).filter(Boolean);
  }

  function normalizeContractValue(value) {
    return normalizeSurfaceToken(value).replace(/\b(the|dan|atau|untuk|dengan|silakan|klik|submit)\b/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function formContract(form) {
    const fields = (form?.fieldEntries || []).map(x => normalizeContractValue(x?.normalized || x?.value)).filter(Boolean);
    const semantic = (form?.semanticSurface || []).map(normalizeContractValue).filter(Boolean);
    const labels = (form?.surfaceLabel || []).map(normalizeContractValue).filter(Boolean);
    const handlers = (form?.handlerRefs || []).map(x => normalizeContractValue(x?.name)).filter(Boolean);
    const submit = form?.submitHandler ? [normalizeContractValue(form.submitHandler)] : [];
    const action = form?.action ? [normalizeContractValue(form.action)] : [];
    const all = new Set([...fields, ...semantic, ...labels, ...handlers, ...submit, ...action].filter(Boolean));
    return { fields:[...new Set(fields)], semantic:[...new Set(semantic)], labels:[...new Set(labels)], handlers:[...new Set([...handlers,...submit])], action:[...new Set(action)], tokens:[...all] };
  }

  function intersection(a, b) {
    const bs = new Set(b || []);
    return [...new Set(a || [])].filter(x => bs.has(x));
  }

  function subsetRatio(a, b) {
    const aa = new Set(a || []);
    if (!aa.size) return 0;
    return intersection([...aa], b).length / aa.size;
  }

  function businessIdentityScore(reference, target) {
    const a = formContract(reference), b = formContract(target);
    const fieldShared = intersection(a.fields, b.fields);
    const semanticShared = intersection(a.semantic, b.semantic);
    const labelShared = intersection(a.labels, b.labels);
    const tokenShared = intersection(a.tokens, b.tokens);
    const fieldUnion = new Set([...a.fields, ...b.fields]).size || 1;
    const semanticUnion = new Set([...a.semantic, ...b.semantic]).size || 1;
    const fieldJaccard = fieldShared.length / fieldUnion;
    const semanticJaccard = semanticShared.length / semanticUnion;
    const keyExact = Boolean(reference.key && target.key && reference.key.toLowerCase() === target.key.toLowerCase());
    const distinctive = tokenShared.filter(x => x.length >= 5 && !['email','password','username','alamat','address','phone','nomor','number','submit','button'].includes(x));
    const score = keyExact ? 1 : Math.min(1, fieldJaccard * 0.55 + semanticJaccard * 0.25 + Math.min(1, distinctive.length / 3) * 0.20);
    return {score, fieldShared, semanticShared, labelShared, tokenShared, distinctive, fieldJaccard, semanticJaccard, keyExact};
  }

  function compareContract(reference, target) {
    const a = formContract(reference), b = formContract(target);
    const missingFields = a.fields.filter(x => !b.fields.includes(x));
    const extraFields = b.fields.filter(x => !a.fields.includes(x));
    const missingLabels = a.labels.filter(x => !b.labels.includes(x));
    const extraLabels = b.labels.filter(x => !a.labels.includes(x));
    const missingHandlers = a.handlers.filter(x => !b.handlers.includes(x));
    const extraHandlers = b.handlers.filter(x => !a.handlers.includes(x));
    const missingSemantic = a.semantic.filter(x => !b.semantic.includes(x));
    const extraSemantic = b.semantic.filter(x => !a.semantic.includes(x));
    const sourceComponentCount = new Set([...a.fields, ...a.labels, ...a.handlers, ...a.semantic]).size;
    const targetComponentCount = new Set([...b.fields, ...b.labels, ...b.handlers, ...b.semantic]).size;
    const missingComponents = [...new Set([...missingFields, ...missingLabels, ...missingHandlers, ...missingSemantic])];
    return {missingFields, extraFields, missingLabels, extraLabels, missingHandlers, extraHandlers, missingSemantic, extraSemantic, missingComponents, sourceComponentCount, targetComponentCount};
  }

  function codeTokenSet(value) {
    const text = String(value || '')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ')
      .replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, ' ')
      .toLowerCase();
    return new Set((text.match(/[a-z_$][a-z0-9_$]*/gi) || [])
      .filter(token => token.length >= 3)
      .filter(token => !['const','let','var','function','return','async','await','true','false','null','undefined','this','new','if','else','for','while','try','catch','throw','typeof','instanceof','class','switch','case','break','continue'].includes(token)));
  }

  function functionContract(fn) {
    const bodyTokens = codeTokenSet(fn?.normalizedBody || '');
    const paramTokens = codeTokenSet(fn?.params || '');
    const all = new Set([...bodyTokens, ...paramTokens]);
    return {
      tokens: [...all],
      bodyTokens: [...bodyTokens],
      paramTokens: [...paramTokens],
      size: all.size
    };
  }

  function compareFunctionContract(reference, target) {
    const a = functionContract(reference), b = functionContract(target);
    const missing = a.tokens.filter(token => !b.tokens.includes(token));
    const extra = b.tokens.filter(token => !a.tokens.includes(token));
    const shared = a.tokens.filter(token => b.tokens.includes(token));
    const anchorA = new Set(reference?.anchorTokens || []);
    const anchorB = new Set(target?.anchorTokens || []);
    const sharedAnchors = [...anchorA].filter(x => anchorB.has(x));
    const missingAnchors = [...anchorA].filter(x => !anchorB.has(x));
    const targetCoverage = a.tokens.length ? shared.length / a.tokens.length : 0;
    const referenceCoverage = b.tokens.length ? shared.length / b.tokens.length : 0;
    const tokenUnion = new Set([...a.tokens, ...b.tokens]).size || 1;
    const tokenJaccard = shared.length / tokenUnion;
    const distinctive = shared.filter(token => token.length >= 6 && !['render','update','handle','submit','button','status','profile','system','data','element'].includes(token));
    const sizeRatio = Math.min(reference.bodyLength, target.bodyLength) / Math.max(reference.bodyLength, target.bodyLength || 1);
    return {
      missing, extra, shared, targetCoverage, referenceCoverage, tokenJaccard,
      distinctive, sourceSize:a.size, targetSize:b.size,
      sizeGap:Math.max(0, a.size - b.size), sizeRatio,
      sharedAnchors, missingAnchors,
      sharedDomAnchors:sharedAnchors.filter(x => (reference.domAnchors||[]).includes(x) && (target.domAnchors||[]).includes(x)),
      missingDomAnchors:missingAnchors.filter(x => (reference.domAnchors||[]).includes(x))
    };
  }

  function functionSimilarity(a, b) {
    const c = compareFunctionContract(a, b);
    const anchorUnion = new Set([...(a.anchorTokens || []), ...(b.anchorTokens || [])]).size || 1;
    const anchorJaccard = c.sharedAnchors.length / anchorUnion;
    return { ...c, anchorJaccard };
  }

  function anchorSourceLines(fn, anchors) {
    const body = String(fn?.bodyText || fn?.normalizedBody || '');
    return (anchors || []).slice(0, 12).map(anchor => {
      const safe = String(anchor).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const index = body.search(new RegExp(safe, 'i'));
      return { anchor, line: index >= 0 ? (fn.line + body.slice(0, index).split('\n').length - 1) : fn.line };
    });
  }

  function functionNameIsGeneric(name) {
    return new Set(['init','setup','start','stop','load','render','update','refresh','handle','submit','click','open','close','toggle','reset','save','send','getdata','setdata']).has(String(name || '').toLowerCase());
  }

  function compareFileSurface(reference, target) {
    const aTokens = [...codeTokenSet(reference?.rawSource || '')];
    const bTokens = [...codeTokenSet(target?.rawSource || '')];
    const shared = aTokens.filter(x => bTokens.includes(x));
    const missing = aTokens.filter(x => !bTokens.includes(x));
    const union = new Set([...aTokens, ...bTokens]).size || 1;
    const jaccard = shared.length / union;
    const coverage = aTokens.length ? shared.length / aTokens.length : 0;
    const aFns = new Set((reference?.functions || []).map(x => x.name));
    const bFns = new Set((target?.functions || []).map(x => x.name));
    const sharedFunctions = [...aFns].filter(x => bFns.has(x));
    const missingFunctions = [...aFns].filter(x => !bFns.has(x));
    const aIds = new Set((reference?.ids || []).map(x => x.id));
    const bIds = new Set((target?.ids || []).map(x => x.id));
    const sharedIds = [...aIds].filter(x => bIds.has(x));
    const missingIds = [...aIds].filter(x => !bIds.has(x));
    const sizeRatio = Math.min(reference.rawSource.length, target.rawSource.length) / Math.max(reference.rawSource.length, target.rawSource.length || 1);
    const identity = (sharedFunctions.length >= 3 ? 0.45 : sharedFunctions.length / 3 * 0.45)
      + (sharedIds.length >= 4 ? 0.35 : sharedIds.length / 4 * 0.35)
      + Math.min(0.20, jaccard * 0.20);
    return {shared, missing, jaccard, coverage, sharedFunctions, missingFunctions, sharedIds, missingIds, sizeRatio, identity};
  }

  function compareCrossFileSources(scanned) {
    const findings = [], relations = [];
    const items = Object.values(scanned);
    const allForms = [];
    const functionMap = new Map();

    for (const item of items) {
      for (const form of item.forms || []) allForms.push({file:item.file, role:item.role, ...form});
      for (const fn of item.functions || []) {
        if (!functionMap.has(fn.name)) functionMap.set(fn.name, []);
        functionMap.get(fn.name).push({file:item.file, role:item.role, ...fn});
      }
    }

    const explicitRef = (a, b) => (scanned[a]?.refs || []).includes(b) || (scanned[b]?.refs || []).includes(a);
    const relationKeys = new Set();
    const addRelation = relation => {
      const key = [relation.sourceFile, relation.targetFile, relation.type, relation.sourceLine || '', relation.targetLine || '', relation.key || ''].join('|');
      if (relationKeys.has(key)) return;
      relationKeys.add(key);
      relations.push(relation);
    };

    const emit = (reference, target, identity, mode) => {
      const comparison = compareContract(reference, target);
      const source = formContract(reference), targetContract = formContract(target);
      const sourceSubset = subsetRatio(targetContract.tokens, source.tokens);
      const targetSubset = subsetRatio(source.tokens, targetContract.tokens);
      const gap = Math.max(0, comparison.sourceComponentCount - comparison.targetComponentCount);
      const handlerGap = comparison.missingHandlers.length;
      const fieldGap = comparison.missingFields.length;
      const strongIdentity = identity.keyExact || (
        identity.score >= 0.60 && identity.fieldShared.length >= 2 &&
        (identity.distinctive.length >= 1 || identity.fieldShared.length >= 3)
      );
      const targetLooksIncomplete = strongIdentity && (
        fieldGap >= 1 && (sourceSubset >= 0.65 || fieldGap >= 2) ||
        handlerGap >= 1 ||
        (gap >= 2 && targetSubset >= 0.45)
      );
      const bothComparable = strongIdentity && !targetLooksIncomplete;
      const confidence = identity.keyExact ? 'HIGH' : targetLooksIncomplete ? (identity.score >= 0.72 ? 'HIGH' : 'MEDIUM') : identity.score >= 0.72 ? 'MEDIUM' : 'LOW';
      const status = targetLooksIncomplete ? 'MISMATCH_CANDIDATE' : bothComparable ? 'MATCHED_SURFACE' : 'VARIANT_SURFACE';
      const type = identity.keyExact ? 'CROSS_FILE_CONTRACT' : 'CROSS_FILE_SURFACE';
      const sourceCandidateReason = targetLooksIncomplete
        ? 'Reference candidate dipilih karena target tampak sebagai subset surface dan memiliki komponen kontrak yang hilang; ini bukan klaim bahwa file yang lebih panjang otomatis benar.'
        : 'Tidak ada bukti cukup bahwa salah satu implementasi adalah canonical; relasi dipertahankan sebagai surface/variant.';
      const evidence = {
        identityMode:mode, identityScore:Number(identity.score.toFixed(3)), keyExact:identity.keyExact,
        sharedFields:identity.fieldShared, sharedSemantic:identity.semanticShared, sharedLabels:identity.labelShared,
        distinctiveTokens:identity.distinctive,
        sourceFields:source.fields, targetFields:targetContract.fields,
        missingFields:comparison.missingFields, extraFields:comparison.extraFields,
        missingLabels:comparison.missingLabels, extraLabels:comparison.extraLabels,
        missingHandlers:comparison.missingHandlers, extraHandlers:comparison.extraHandlers,
        missingSemantic:comparison.missingSemantic, extraSemantic:comparison.extraSemantic,
        sourceComponentCount:comparison.sourceComponentCount, targetComponentCount:comparison.targetComponentCount,
        componentGap:gap, targetCoverageOfReference:Number((sourceSubset * 100).toFixed(1)),
        referenceCoverageOfTarget:Number((targetSubset * 100).toFixed(1)),
        sourceCompleteness:reference.completenessScore, targetCompleteness:target.completenessScore,
        sourceCandidateReason
      };

      addRelation({sourceFile:reference.file,targetFile:target.file,type,status,confidence,sourceLine:reference.line,targetLine:target.line,key:reference.key || target.key || 'SURFACE',evidence});

      if (targetLooksIncomplete) {
        findings.push({
          severity:identity.keyExact || identity.score >= 0.72 ? 'HIGH' : 'MEDIUM',
          type:'CROSS_FILE_CONTRACT_MISMATCH', sourceFile:reference.file, sourceLine:reference.line,
          targetFile:target.file, targetLine:target.line,
          area:`FORM:${reference.key || target.key || 'SURFACE'}`,
          message:`Surface lintas-file teridentifikasi sebagai kandidat yang sama. Target tampak tidak lengkap: ${comparison.missingFields.length} field, ${comparison.missingHandlers.length} handler, ${comparison.missingSemantic.length} semantic component tidak terbukti ada pada target.`,
          confidence,
          evidence
        });
      }
    };

    // 1) Explicitly keyed contracts: strongest evidence. Compare every pair but never declare canonical truth from size alone.
    const byKey = new Map();
    for (const form of allForms) if (form.key) {
      const key = form.key.toLowerCase();
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(form);
    }
    for (const entries of byKey.values()) {
      if (entries.length < 2) continue;
      for (let i=0;i<entries.length;i++) for (let j=i+1;j<entries.length;j++) {
        const a=entries[i], b=entries[j];
        const identity=businessIdentityScore(a,b);
        const reference=a.completenessScore >= b.completenessScore ? a : b;
        const target=reference===a ? b : a;
        emit(reference,target,{...identity,keyExact:true,score:1},'KEYED_CONTRACT');
      }
    }

    // 2) Renamed/copied surfaces: infer identity from multiple independent signals, not function name or source length.
    for (let i=0;i<allForms.length;i++) for (let j=i+1;j<allForms.length;j++) {
      const a=allForms[i], b=allForms[j];
      if (a.file===b.file) continue;
      if (a.key && b.key && a.key.toLowerCase()===b.key.toLowerCase()) continue;
      const identity=businessIdentityScore(a,b);
      if (identity.score < 0.60 || identity.fieldShared.length < 2) continue;
      if (identity.distinctive.length < 1 && identity.fieldShared.length < 3) continue;
      const reference=a.completenessScore >= b.completenessScore ? a : b;
      const target=reference===a ? b : a;
      emit(reference,target,identity,'SEMANTIC_SURFACE');
    }

    // 3) Direct file references become dependency relations, but they are not automatically synchronization contracts.
    for (const item of items) for (const ref of item.refs || []) if (scanned[ref]) {
      addRelation({sourceFile:item.file,targetFile:ref,type:'EXPLICIT_FILE_REFERENCE',status:'LINKED',confidence:'HIGH',evidence:{reason:'Referensi file ditemukan langsung di source; belum berarti kedua surface harus identik.'}});
    }

    // 4) Function contracts: use sibling consensus before declaring an outlier.
    // Two-file families use deterministic subset evidence. Three-or-more-file families
    // use majority/similarity support so BCGO can identify the implementation that
    // diverges from the shared contract without pretending that file length is truth.
    for (const [name, entries] of functionMap) {
      const unique = [...new Map(entries.map(x => [x.file, x])).values()];
      if (unique.length < 2) continue;

      const family = unique.map(fn => ({
        fn,
        support: unique.filter(other => other.file !== fn.file).reduce((score, other) => {
          const s = functionSimilarity(fn, other);
          const sameBody = fn.bodyHash === other.bodyHash;
          const strong = sameBody || (s.sharedAnchors.length >= 2 && s.tokenJaccard >= 0.62 && s.targetCoverage >= 0.72);
          return score + (strong ? 1 : 0);
        }, 0)
      }));
      const consensus = family.slice().sort((a,b) => b.support - a.support || b.fn.bodyLength - a.fn.bodyLength)[0];
      const consensusCount = consensus.support + 1;

      for (const entry of unique) {
        if (entry.file === consensus.fn.file) continue;
        const reference = consensus.fn;
        const target = entry;
        const linked = explicitRef(reference.file, target.file);
        const c = functionSimilarity(reference, target);
        const sameBody = reference.bodyHash === target.bodyHash;
        const familyHasConsensus = unique.length >= 3 && consensusCount >= 2;
        const identityStrong = (
          sameBody || c.sharedAnchors.length >= 2 || c.distinctive.length >= 2 || linked
        ) && c.shared.length >= 4;

        const targetLooksIncomplete = !sameBody && identityStrong && (
          (c.targetCoverage >= 0.72 && c.missingAnchors.length >= 1 && c.sizeRatio <= 0.82) ||
          (c.targetCoverage >= 0.80 && c.missingAnchors.length >= 2 && c.sizeGap >= 8) ||
          (familyHasConsensus && c.targetCoverage >= 0.70 && c.missingAnchors.length >= 2 && c.anchorJaccard >= 0.45)
        );
        const status = sameBody ? 'SYNCHRONIZED' : targetLooksIncomplete ? 'MISMATCH_CANDIDATE' : 'VARIANT';
        const confidence = sameBody ? 'HIGH' : targetLooksIncomplete && (familyHasConsensus || linked || c.targetCoverage >= 0.82) ? 'HIGH' : targetLooksIncomplete ? 'MEDIUM' : 'LOW';
        const relationType = sameBody ? 'SHARED_FUNCTION_SYNC' : targetLooksIncomplete ? 'CROSS_FILE_FUNCTION_CONTRACT' : 'SHARED_FUNCTION_VARIANT';
        const missingAnchorLines = anchorSourceLines(reference, c.missingAnchors);

        addRelation({
          sourceFile:reference.file, targetFile:target.file, type:relationType, status, confidence,
          sourceLine:reference.line, targetLine:target.line, key:name,
          evidence:{
            familySize:unique.length, familyConsensusFile:reference.file, familyConsensusSupport:consensusCount,
            explicitReference:linked, sameBody, sharedTokens:c.shared.slice(0,100), missingTokens:c.missing.slice(0,100),
            extraTokens:c.extra.slice(0,100), sharedAnchors:c.sharedAnchors.slice(0,60), missingAnchors:c.missingAnchors.slice(0,60),
            missingAnchorLines, sharedDomAnchors:c.sharedDomAnchors.slice(0,40), missingDomAnchors:c.missingDomAnchors.slice(0,40),
            targetCoverage:Number((c.targetCoverage*100).toFixed(1)), referenceCoverage:Number((c.referenceCoverage*100).toFixed(1)),
            tokenJaccard:Number((c.tokenJaccard*100).toFixed(1)), anchorJaccard:Number((c.anchorJaccard*100).toFixed(1)),
            sourceTokenCount:c.sourceSize, targetTokenCount:c.targetSize, sizeGap:c.sizeGap,
            sourceBodyLength:reference.bodyLength, targetBodyLength:target.bodyLength, sizeRatio:Number(c.sizeRatio.toFixed(3)),
            referenceCandidateReason: familyHasConsensus
              ? `Reference candidate dipilih dari keluarga fungsi berdasarkan dukungan ${consensusCount}/${unique.length} implementasi yang selaras; bukan berdasarkan panjang file saja.`
              : 'Reference candidate dipilih dari implementasi yang memiliki bukti kontrak lebih lengkap; status tetap kandidat sampai Medicine memverifikasi source of truth.'
          }
        });

        if (targetLooksIncomplete) {
          findings.push({
            severity:confidence === 'HIGH' ? 'HIGH' : 'MEDIUM',
            type:'CROSS_FILE_FUNCTION_CONTRACT_MISMATCH',
            sourceFile:reference.file, sourceLine:reference.line, targetFile:target.file, targetLine:target.line,
            area:`FUNCTION:${name}`, confidence,
            message:`Implementasi ${name} pada ${target.file} terdeteksi sebagai kandidat tidak lengkap terhadap kontrak ${reference.file}: coverage ${Math.round(c.targetCoverage*100)}%, ${c.missingAnchors.length} anchor penting hilang dan ${c.missing.length} token kontrak tidak terbukti.`,
            evidence:{
              referenceFunction:name, targetFunction:name, familySize:unique.length, familyConsensusFile:reference.file,
              familyConsensusSupport:consensusCount, missingAnchors:c.missingAnchors.slice(0,60), missingAnchorLines,
              sharedAnchors:c.sharedAnchors.slice(0,60), missingTokens:c.missing.slice(0,80), sharedTokens:c.shared.slice(0,80),
              targetCoverage:Number((c.targetCoverage*100).toFixed(1)), referenceCoverage:Number((c.referenceCoverage*100).toFixed(1)),
              tokenJaccard:Number((c.tokenJaccard*100).toFixed(1)), anchorJaccard:Number((c.anchorJaccard*100).toFixed(1)),
              sourceTokenCount:c.sourceSize, targetTokenCount:c.targetSize, sourceBodyLength:reference.bodyLength,
              targetBodyLength:target.bodyLength, sizeGap:c.sizeGap, explicitReference:linked,
              sourceCandidateReason:familyHasConsensus
                ? 'Kandidat reference memiliki dukungan keluarga implementasi yang lebih kuat; canonical tetap harus diverifikasi Medicine.'
                : 'Kandidat reference memiliki cakupan kontrak lebih tinggi; canonical tetap harus diverifikasi Medicine.'
            }
          });
        }
      }

      // If every sibling implementation is equivalent, publish one explicit family sync relation.
      if (unique.length >= 2 && family.every(x => x.support === unique.length - 1)) {
        const first = unique[0];
        addRelation({
          sourceFile:first.file, targetFile:unique[1].file, type:'FUNCTION_FAMILY_SYNC', status:'SYNCHRONIZED', confidence:'HIGH',
          sourceLine:first.line, targetLine:unique[1].line, key:name,
          evidence:{familySize:unique.length, reason:'Seluruh anggota keluarga fungsi memiliki kontrak yang setara pada bukti scanner.'}
        });
      }
    }

    // 5) Whole-file surface families: when two files are demonstrably siblings
    // (shared functions + DOM IDs + substantial token overlap), detect an outlier
    // file whose implementation is a strict/near-strict subset. This catches
    // incomplete copied features even when there is no <form> key and no identical
    // function name for every missing block.
    const fileItems = items.filter(x => x.rawSource);
    for (let i=0;i<fileItems.length;i++) for (let j=i+1;j<fileItems.length;j++) {
      const a=fileItems[i], b=fileItems[j];
      if (a.file===b.file) continue;
      const cmpAB=compareFileSurface(a,b), cmpBA=compareFileSurface(b,a);
      const linked=explicitRef(a.file,b.file);
      const sameRole=String(a.role||'')===String(b.role||'');
      const strongIdentity=(cmpAB.identity>=0.58 && (cmpAB.sharedFunctions.length>=3 || cmpAB.sharedIds.length>=4)) || (linked && cmpAB.jaccard>=0.20);
      if (!strongIdentity) continue;
      const aLarger = a.rawSource.length >= b.rawSource.length ? a : b;
      const smaller = aLarger===a ? b : a;
      const cmp = aLarger===a ? cmpAB : cmpBA;
      const likelySubset = cmp.coverage>=0.68 && cmp.sizeRatio<=0.78 && (cmp.missingFunctions.length>=2 || cmp.missingIds.length>=3 || cmp.missing.length>=10);
      const nearSync = cmp.jaccard>=0.88 && cmp.missingFunctions.length===0 && cmp.missingIds.length===0;
      if (!likelySubset && !nearSync) continue;
      const status=nearSync?'SYNCHRONIZED':'MISMATCH_CANDIDATE';
      const confidence=nearSync?'HIGH':(linked || (sameRole && cmp.coverage>=0.80))?'HIGH':'MEDIUM';
      const type=nearSync?'FILE_SURFACE_SYNC':'CROSS_FILE_FILE_SURFACE_CONTRACT';
      const sourceFnLines=cmp.missingFunctions.slice(0,12).map(name=>({name,line:(aLarger.functions||[]).find(x=>x.name===name)?.line||null}));
      const sourceIdLines=cmp.missingIds.slice(0,12).map(id=>({id,line:(aLarger.ids||[]).find(x=>x.id===id)?.line||null}));
      addRelation({sourceFile:aLarger.file,targetFile:smaller.file,type,status,confidence,key:'FILE_SURFACE',sourceLine:1,targetLine:1,evidence:{linked,sameRole,identity:Number(cmp.identity.toFixed(3)),jaccard:Number((cmp.jaccard*100).toFixed(1)),coverage:Number((cmp.coverage*100).toFixed(1)),sizeRatio:Number(cmp.sizeRatio.toFixed(3)),sourceBytes:aLarger.bytes,targetBytes:smaller.bytes,sharedFunctions:cmp.sharedFunctions.slice(0,60),missingFunctions:cmp.missingFunctions.slice(0,60),missingFunctionLines:sourceFnLines,sharedIds:cmp.sharedIds.slice(0,60),missingIds:cmp.missingIds.slice(0,60),missingIdLines:sourceIdLines,missingTokens:cmp.missing.slice(0,60),reason:nearSync?'Whole-file contract surfaces are highly equivalent.':'Whole-file contract surface indicates the target is a materially smaller subset of a strongly related reference candidate; this is evidence of drift, not automatic canonical truth.'}});
      if (!nearSync) findings.push({severity:confidence==='HIGH'?'HIGH':'MEDIUM',type:'CROSS_FILE_FILE_SURFACE_MISMATCH',sourceFile:aLarger.file,sourceLine:1,targetFile:smaller.file,targetLine:1,area:'FILE_SURFACE',confidence,message:`${smaller.file} tampak sebagai implementasi yang tidak lengkap terhadap surface ${aLarger.file}: coverage ${Math.round(cmp.coverage*100)}%, ${cmp.missingFunctions.length} fungsi dan ${cmp.missingIds.length} ID DOM yang tidak terbukti pada target.`,evidence:{linked,sameRole,identity:Number(cmp.identity.toFixed(3)),jaccard:Number((cmp.jaccard*100).toFixed(1)),coverage:Number((cmp.coverage*100).toFixed(1)),sizeRatio:Number(cmp.sizeRatio.toFixed(3)),missingFunctions:cmp.missingFunctions.slice(0,60),missingFunctionLines:sourceFnLines,missingIds:cmp.missingIds.slice(0,60),missingIdLines:sourceIdLines,missingTokens:cmp.missing.slice(0,80)}});
    }

    return {findings, relations};
  }


  // ============================================================
  // BCGO FILE NERVE MAP — RUNTIME + SOURCE + DEPENDENCY + CONTRACT
  // This is the canonical sensor packet consumed by the Internal AI.
  // A file is not called healthy merely because it has no recent telemetry.
  // ============================================================
  const NERVE_BUILTINS = new Set([
    'if','for','while','switch','catch','function','setTimeout','setInterval',
    'clearTimeout','clearInterval','String','Number','Boolean','Math','Date','Array',
    'Object','Promise','Error','RegExp','JSON','Map','Set','WeakMap','WeakSet','Symbol',
    'parseInt','parseFloat','isNaN','isFinite','decodeURI','decodeURIComponent',
    'encodeURI','encodeURIComponent','console','window','document','navigator','location',
    'fetch','URL','URLSearchParams','AbortController','Blob','File','FormData','Headers',
    'Request','Response','Intl','BigInt','undefined','NaN','Infinity'
  ]);

  function buildFileNerves(scanned, logs, relations, crossFileFindings) {
    const intelligence = buildSourceIntelligence(scanned, logs);
    const definitions = new Map();
    const fileNerves = {};

    for (const [file,item] of Object.entries(scanned || {})) {
      for (const fn of item.functions || []) {
        const key = String(fn.name || '').toLowerCase();
        if (!key) continue;
        if (!definitions.has(key)) definitions.set(key, []);
        definitions.get(key).push({ file, line:fn.line, name:fn.name });
      }
    }

    // Cross-file relation index: every relation becomes a dependency nerve,
    // regardless of whether it is currently actionable.
    const relByFile = new Map();
    for (const relation of relations || []) {
      for (const file of [normalizeFile(relation.sourceFile), normalizeFile(relation.targetFile)]) {
        if (!file || file === 'UNKNOWN' || !ORGAN_REGISTRY[file]) continue;
        if (!relByFile.has(file)) relByFile.set(file, []);
        relByFile.get(file).push(relation);
      }
    }

    // Runtime ReferenceError is promoted into a source-bound nerve only when
    // the current source surface proves the symbol is not defined anywhere.
    const runtimeErrorsByFile = new Map();
    for (const log of logs || []) {
      const file = normalizeFile(log?.fileName || log?.sourceFile || log?.file);
      if (!ORGAN_REGISTRY[file]) continue;
      const message = String(log?.message || log?.error || log?.text || '');
      if (!message) continue;
      if (!runtimeErrorsByFile.has(file)) runtimeErrorsByFile.set(file, []);
      runtimeErrorsByFile.get(file).push({
        type: /ReferenceError/i.test(message) ? 'REFERENCE_ERROR' : 'RUNTIME_ERROR',
        message: message.slice(0,500),
        line: log?.line ?? log?.lineno ?? null,
        column: log?.column ?? log?.colno ?? null,
        at: timestamp(log?.reportedAt)
      });
    }

    for (const [file,item] of Object.entries(scanned || {})) {
      const info = intelligence.files?.[file] || {};
      const runtime = runtimeErrorsByFile.get(file) || [];
      const localFindings = (item.findings || []).slice(0,40);
      const relationList = (relByFile.get(file) || []).slice(0,80);
      const unresolved = [];

      // Do not treat every generic function call as an error: browser globals,
      // imported Firebase helpers, object methods, and methods defined with syntax
      // that the lightweight parser cannot enumerate would create false positives.
      // Static absence is therefore promoted only for explicit HTML handlers here;
      // runtime ReferenceError is handled below with stronger telemetry evidence.
      //
      // Function-body call names are still retained in the contract/dependency
      // surface through intelligence.files[*].calledNames.

      // Runtime symbol proof is stronger than a generic static absence. It is
      // bound to the current source scan and therefore becomes an explicit nerve.
      for (const error of runtime) {
        const symbol = extractSymbolFromText(error.message);
        if (!symbol || !/ReferenceError|is not defined/i.test(error.message)) continue;
        const defs = definitions.get(symbol.toLowerCase()) || [];
        const hits = sourceLineHits(item.rawSource, symbol);
        if (!defs.length) {
          unresolved.push({
            symbol, kind:'RUNTIME_UNDEFINED', file,
            line:error.line || hits[0]?.line || null,
            source:'RUNTIME_TELEMETRY + COMPLETE_SOURCE_SURFACE',
            evidence:`Telemetry ${file} melaporkan ${symbol} tidak terdefinisi dan scanner tidak menemukan definisi ${symbol} pada ${Object.keys(scanned || {}).length} source yang terbaca.`
          });
        }
      }

      const uniqueUnresolved = [...new Map(unresolved.map(x => [`${x.symbol}|${x.kind}|${x.line}`, x])).values()].slice(0,40);
      const sourceReadable = Boolean(item.rawSource && item.hash);
      const sourceFindings = [...localFindings, ...(crossFileFindings || []).filter(f => normalizeFile(f.file || f.sourceFile || f.targetFile) === file || normalizeFile(f.targetFile) === file)].slice(0,60);
      const high = sourceFindings.filter(f => f.severity === 'HIGH').length;
      const medium = sourceFindings.filter(f => f.severity === 'MEDIUM').length;
      const runtimeActive = runtime.some(e => isRecent(e.at));
      const dependencyIssues = relationList.filter(r => /MISMATCH|UNKNOWN|VARIANT/.test(String(r.status || '')));
      const contractIssues = sourceFindings.filter(f => /CONTRACT|FUNCTION|FORM|FILE_SURFACE|VARIANT/.test(String(f.type || '')));

      let overall = 'HEALTHY';
      if (!sourceReadable) overall = 'SOURCE_UNREADABLE';
      else if (uniqueUnresolved.length || runtimeActive || high) overall = 'ANOMALY';
      else if (medium || dependencyIssues.length || contractIssues.length) overall = 'REVIEW';
      else if ((item.refs || []).length || relationList.length || (info.functions || []).length) overall = 'OBSERVED';

      fileNerves[file] = {
        file,
        role:item.role,
        type:item.type,
        revision:item.hash,
        source:{ readable:sourceReadable, lines:item.lines || 0, bytes:item.bytes || 0, hash:item.hash || null },
        runtime:{ active:runtimeActive, count:runtime.length, errors:runtime.slice(-12) },
        dependency:{ refs:(item.refs || []).slice(0,80), relationCount:relationList.length, issues:dependencyIssues.slice(0,30), relations:relationList.slice(0,40) },
        contract:{ functions:(info.functions || []).length, definitions:(info.functionNames || []).slice(0,80), callers:(info.calledNames || []).slice(0,80), onclicks:(info.onclicks || []).slice(0,60), findings:contractIssues.slice(0,30) },
        unresolved:uniqueUnresolved,
        findings:{ total:sourceFindings.length, high, medium, items:sourceFindings.slice(0,40) },
        health:{ overall, runtime:runtimeActive ? 'ANOMALY' : 'HEALTHY', source:sourceReadable ? 'READABLE' : 'FAILED', dependency:dependencyIssues.length ? 'REVIEW' : 'SYNC', contract:contractIssues.length || uniqueUnresolved.length ? 'REVIEW' : 'OK' },
        evidenceSummary:{ runtime:runtime.length, unresolved:uniqueUnresolved.length, relations:relationList.length, sourceFindings:sourceFindings.length },
        updatedAt:Date.now()
      };
    }

    return { fileNerves, intelligence };
  }

  async function fetchSourceForScan(file, generation) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SOURCE_SCAN_FETCH_TIMEOUT);
    try {
      const response = await fetch(sourceUrl(file), { method:'GET', cache:'no-store', credentials:'same-origin', signal:controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const source = await response.text();
      if (generation !== sourceScanGeneration) return null;
      if (!source.trim()) throw new Error('Source kosong.');
      return source;
    } finally { clearTimeout(timeout); }
  }

  async function runSourceScan(reason = 'REALTIME') {
    if (stopped || !authorized || sourceScanBusy) return;
    sourceScanBusy = true;
    const generation = ++sourceScanGeneration;
    const startedAt = Date.now();
    const files = Object.keys(ORGAN_REGISTRY);
    const scanned = {}, failures = [], fileStates = {};
    for (const file of files) fileStates[file] = { status:'QUEUED', line:null, message:'Menunggu giliran scan...' };

    const publishProgress = patch => {
      state.sourceScan = { ...state.sourceScan, version:SOURCE_SCAN_VERSION, status:'SCANNING', startedAt, completedAt:0, totalFiles:files.length, fileStates:{...fileStates}, findings:[...failures, ...Object.values(scanned).flatMap(item => item.findings || [])].slice(0,100), crossFileFindings:[], relations:[], sources:Object.fromEntries(Object.entries(scanned).map(([name,item]) => [name,{file:name,lines:item.lines,bytes:item.bytes,hash:item.hash,refs:item.refs}])), sourceIntelligence:buildSourceIntelligence(scanned, latestSystemLogs), ...patch };
      publishToUI(safeClone(state));
    };

    state.sourceScan = { ...state.sourceScan, version:SOURCE_SCAN_VERSION, status:'SCANNING', startedAt, completedAt:0, filesScanned:0, filesReadable:0, filesFailed:0, currentFile:null, currentIndex:0, totalFiles:files.length, phase:'QUEUE', fileStates:{...fileStates}, findings:[], crossFileFindings:[], sources:{}, message:`Antrian scan dibuka: ${files.length} source akan dibaca dari deployment aktif.` };
    recordEvent('SOURCE_SCAN', `Pemindaian source code dimulai (${reason}) — ${files.length} organ.`, 'SYS_SOURCE_SCANNER');
    publishToUI(safeClone(state));

    try {
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        if (generation !== sourceScanGeneration) return;
        fileStates[file] = { status:'READING', line:null, message:'Mengambil source aktual dari deployment...' };
        publishProgress({ currentFile:file, currentIndex:index+1, filesScanned:index, filesReadable:Object.keys(scanned).length, filesFailed:failures.length, phase:'READ', message:`Membaca source aktual ${index+1}/${files.length}: ${file}` });
        try {
          const source = await fetchSourceForScan(file, generation);
          if (source == null) return;
          fileStates[file] = { status:'ANALYZING', line:null, message:`Source terbaca (${source.length} karakter). Menganalisis struktur...` };
          publishProgress({ currentFile:file, currentIndex:index+1, filesScanned:index, filesReadable:Object.keys(scanned).length, filesFailed:failures.length, phase:'ANALYZE', message:`Source ${file} terbaca. Analisis struktur dan referensi dimulai...` });
          const item = scanSourceFile(file, source);
          scanned[file] = item;
          const localFindings = item.findings || [];
          fileStates[file] = { status:localFindings.length ? 'FINDING' : 'CLEAN', line:localFindings[0]?.line ?? null, message:localFindings.length ? `${localFindings.length} temuan lokal terdeteksi; bukti disimpan.` : `Source dibaca dan dianalisis: ${item.lines} baris, hash ${item.hash}.` };
          publishProgress({ currentFile:file, currentIndex:index+1, filesScanned:index+1, filesReadable:Object.keys(scanned).length, filesFailed:failures.length, phase:'FILE_DONE', message:`Selesai ${index+1}/${files.length}: ${file} — ${localFindings.length ? localFindings.length+' temuan' : 'tidak ada temuan lokal'}.` });
        } catch (error) {
          const finding = { severity:'HIGH', type:'SOURCE_UNREADABLE', file, line:null, message:`Source ${file} tidak dapat dibaca: ${String(error?.message || error)}` };
          failures.push(finding);
          fileStates[file] = { status:'FAILED', line:null, message:finding.message };
          publishProgress({ currentFile:file, currentIndex:index+1, filesScanned:index+1, filesReadable:Object.keys(scanned).length, filesFailed:failures.length, phase:'FILE_FAILED', message:`Gagal membaca ${file}; scanner lanjut ke file berikutnya.` });
        }
      }
      const allFindings = Object.values(scanned).flatMap(item => item.findings || []);
      const crossComparison = compareCrossFileSources(scanned);
      const crossFileFindings = crossComparison.findings;
      const relations = crossComparison.relations;
      const actionable = [...failures,...allFindings,...crossFileFindings].filter(f => f.severity !== 'INFO').slice(0,100);
      const relationSummary = {
        synchronized: relations.filter(r => r.status === 'SYNCHRONIZED' || r.status === 'MATCHED_SURFACE').length,
        mismatch: relations.filter(r => /MISMATCH/.test(String(r.status))).length,
        variant: relations.filter(r => r.status === 'VARIANT' || r.status === 'VARIANT_SURFACE').length,
        unknown: relations.filter(r => r.status === 'UNKNOWN').length,
        linked: relations.filter(r => r.status === 'LINKED').length
      };
      const nerve = buildFileNerves(scanned, latestSystemLogs, relations, crossFileFindings);
      const nerveFindings = Object.values(nerve.fileNerves).flatMap(n => (n.unresolved || []).map(u => ({
        severity:'HIGH', type:'UNRESOLVED_SYMBOL', file:n.file, line:u.line ?? null, targetFile:n.file, targetLine:u.line ?? null,
        area:'SYMBOL_DEPENDENCY', symbol:u.symbol, message:u.evidence, evidence:{symbol:u.symbol,kind:u.kind,source:u.source}
      })));
      const mergedCrossFindings = [...crossFileFindings, ...nerveFindings].slice(0,160);
      const mergedActionable = [...failures,...allFindings,...mergedCrossFindings].filter(f => f.severity !== 'INFO').slice(0,120);
      const status = failures.length ? 'DEGRADED' : mergedActionable.length ? 'FINDINGS' : 'CLEAN';
      state.fileNerves = nerve.fileNerves;
      state.sourceScan = { version:SOURCE_SCAN_VERSION,status,startedAt,completedAt:Date.now(),filesScanned:files.length,filesReadable:Object.keys(scanned).length,filesFailed:failures.length,currentFile:null,currentIndex:files.length,totalFiles:files.length,phase:'COMPLETE',fileStates:{...fileStates},findings:[...failures,...allFindings].slice(0,100),crossFileFindings:mergedCrossFindings,relations:relations.slice(0,200),relationSummary,sources:Object.fromEntries(Object.entries(scanned).map(([name,item]) => [name,{file:name,lines:item.lines,bytes:item.bytes,hash:item.hash,refs:item.refs}])),sourceIntelligence:nerve.intelligence,nerveSummary:{healthy:Object.values(nerve.fileNerves).filter(n=>n.health.overall==='HEALTHY').length,observed:Object.values(nerve.fileNerves).filter(n=>n.health.overall==='OBSERVED').length,review:Object.values(nerve.fileNerves).filter(n=>n.health.overall==='REVIEW').length,anomaly:Object.values(nerve.fileNerves).filter(n=>n.health.overall==='ANOMALY').length,unresolved:nerveFindings.length},message:failures.length ? `Scanner selesai: ${files.length} source diproses, ${failures.length} source tidak terbaca.` : mergedActionable.length ? `Scanner selesai: ${files.length} source dibaca; ${mergedActionable.length} bukti/temuan membutuhkan pemeriksaan.` : `Scanner selesai: ${files.length} source dibaca dan dianalisis tanpa temuan struktural/cross-file.` };
      recordEvent('SOURCE_SCAN_RESULT', state.sourceScan.message, actionable.length ? 'SYS_SOURCE_FINDINGS' : 'SYS_SOURCE_CLEAN');
      const aiSnapshot = ingestInternalAI(safeClone(state));
      if (aiSnapshot) state.internalAI = buildInternalAIHandoff(aiSnapshot);
      window.BCGO_STATE = safeClone(state);
      publishToUI(safeClone(state));
      publishBCGOStateToMedicine(safeClone(state));
    } finally { sourceScanBusy = false; }
  }

  function scheduleSourceScan(delay = SOURCE_SCAN_INTERVAL) {
    clearTimeout(sourceScanTimer);
    sourceScanTimer = setTimeout(() => { runSourceScan('REALTIME_TIMER').finally(() => { if (!stopped && authorized) scheduleSourceScan(SOURCE_SCAN_INTERVAL); }); }, delay);
  }

  function buildOrgans() {
    const recent = newestLogByFile();
    const organs = {};

    for (const [file, meta] of Object.entries(ORGAN_REGISTRY)) {
      const item = recent.get(file);
      const historical = latestSystemLogs.some(log => normalizeFile(log?.fileName) === file);

      if (item && isRecent(item.time)) {
        organs[file] = {
          ...meta,
          status: "ANOMALY",
          state: "ACTIVE",
          message: String(item.log?.message || "Sinyal error diterima.").slice(0, 700),
          reportedAt: item.log?.reportedAt || null,
          line: item.log?.line ?? item.log?.lineno ?? null,
          column: item.log?.column ?? item.log?.colno ?? null
        };
      } else if (historical) {
        organs[file] = {
          ...meta,
          status: "RECOVERED",
          state: "RECOVERED",
          message: "Tidak ada error aktif dalam window pemantauan; laporan sebelumnya masih tersimpan sebagai bukti historis."
        };
      } else {
        organs[file] = {
          ...meta,
          status: "HEALTHY",
          state: "HEALTHY",
          message: "Belum ada laporan error aktif dari file ini."
        };
      }
    }

    const sourceFindings = [
      ...(Array.isArray(state.sourceScan?.findings) ? state.sourceScan.findings : []),
      ...(Array.isArray(state.sourceScan?.crossFileFindings) ? state.sourceScan.crossFileFindings : [])
    ].filter(f => f && f.severity === "HIGH");
    // File nerves are authoritative for source-bound unresolved symbols and
    // runtime/source correlation. They can promote a file even when the raw
    // telemetry window alone would otherwise leave it green.
    const nerveEntries = Object.entries(state.fileNerves || {});
    for (const [file, nerve] of nerveEntries) {
      if (!organs[file]) continue;
      if (nerve?.health?.overall === 'ANOMALY' && (nerve.unresolved?.length || nerve.runtime?.active || nerve.findings?.high)) {
        const first = nerve.unresolved?.[0];
        organs[file] = {
          ...organs[file], status:'ANOMALY', state:'ACTIVE', evidenceType:'FILE_NERVE',
          line:first?.line ?? organs[file].line ?? null,
          message:first?.evidence || nerve.runtime?.errors?.[0]?.message || `Saraf source mendeteksi ${nerve.findings?.high || 0} temuan HIGH.`
        };
      } else if (organs[file]?.state === 'HEALTHY' && nerve?.health?.overall === 'REVIEW') {
        organs[file] = { ...organs[file], status:'REVIEW', state:'REVIEW', evidenceType:'FILE_NERVE', message:`Source terbaca, tetapi saraf dependency/contract memerlukan verifikasi (${nerve.evidenceSummary?.relations || 0} relasi, ${nerve.evidenceSummary?.sourceFindings || 0} temuan).` };
      }
    }
    for (const finding of sourceFindings) {
      const target = normalizeFile(finding.targetFile || finding.file);
      if (!ORGAN_REGISTRY[target] || !organs[target]) continue;
      organs[target] = {
        ...organs[target],
        status: "ANOMALY",
        state: "ACTIVE",
        evidenceType: "SOURCE_SCAN",
        line: finding.targetLine ?? finding.line ?? organs[target].line ?? null,
        sourceFinding: finding,
        message: finding.type?.startsWith("CROSS_FILE_")
          ? `Cross-file mismatch: ${finding.sourceFile} → ${target}. ${finding.message}`
          : finding.message
      };
    }
    for (const file of Object.keys(ORGAN_REGISTRY)) {
      if (state.sourceScan?.status === "SCANNING" && !state.sourceScan?.sources?.[file] && !sourceFindings.some(f => normalizeFile(f.file || f.targetFile) === file)) {
        organs[file] = { ...organs[file], status:"SCANNING", state:"SCANNING", message:`Source sedang dipindai (${state.sourceScan.currentFile || "antrian"}).` };
      } else if (organs[file]?.state === "HEALTHY" && state.sourceScan?.sources?.[file]) {
        organs[file].message = `Source terbaca (${state.sourceScan.sources[file].lines} baris, hash ${state.sourceScan.sources[file].hash}); tidak ada temuan aktif dari scanner.`;
      }
    }
    return organs;
  }

  function makeCases(organs) {
    return Object.entries(organs)
      .filter(([, info]) => info.state === "ACTIVE")
      .map(([file, info]) => {
        const t = timestamp(info.reportedAt) || Date.now();
        const fingerprint = `${file}|${info.message}|${t}`.replace(/\s+/g, " ");
        let hash = 0;
        for (let i = 0; i < fingerprint.length; i++) hash = ((hash << 5) - hash + fingerprint.charCodeAt(i)) | 0;
        const id = `CASE-${Math.abs(hash).toString(36).toUpperCase()}`;
        return {
          id,
          target: file,
          rootCandidate: file,
          severity: /security|permission|denied|failed|undefined|null/i.test(info.message) ? "HIGH" : "MEDIUM",
          confidence: 92,
          status: info.evidenceType === "SOURCE_SCAN" ? "SOURCE_SCAN_CONFIRMED" : "TELEMETRY_CONFIRMED",
          evidence: {
            type: info.evidenceType || "TELEMETRY",
            message: info.message,
            reportedAt: info.reportedAt,
            line: info.line,
            column: info.column,
            sourceFinding: info.sourceFinding || null
          }
        };
      });
  }

  function makeMetrics(organs) {
    const values = Object.values(organs);
    return {
      total: values.length,
      active: values.filter(v => v.state === "ACTIVE").length,
      recovered: values.filter(v => v.state === "RECOVERED").length,
      healthy: values.filter(v => v.state === "HEALTHY").length,
      review: values.filter(v => v.state === "REVIEW").length,
      logCount: latestSystemLogs.length,
      firestoreCount: firestore.count,
      sourceScanStatus: state.sourceScan?.status || "WAITING",
      sourceFindings: Array.isArray(state.sourceScan?.findings) ? state.sourceScan.findings.length : 0,
      crossFileFindings: Array.isArray(state.sourceScan?.crossFileFindings) ? state.sourceScan.crossFileFindings.filter(f => f.severity !== "INFO").length : 0
    };
  }

  function deriveConnection() {
    if (firestore.error) return { status: "OFFLINE", lastServerAt: firestore.lastServerAt || 0 };
    if (firestore.connected) return { status: "LIVE", lastServerAt: firestore.lastServerAt || 0 };
    return { status: "CONNECTING", lastServerAt: firestore.lastServerAt || 0 };
  }

  function emit(step, message, target, error = null, options = {}) {
    if (stopped) return;
    const organs = buildOrgans();
    const metrics = makeMetrics(organs);
    const cases = makeCases(organs);

    state.step = step;
    state.message = String(message || "");
    state.targetCell = target || state.targetCell;
    state.errorLog = error ? String(error).slice(0, 900) : null;
    state.cycle = cycleNo;
    state.cycleMode = options.cycleMode || state.cycleMode || "NORMAL";
    state.systemOrgans = organs;
    state.systemLogs = latestSystemLogs.slice();
    state.metrics = metrics;
    state.firestore = { ...firestore };
    state.connection = deriveConnection();
    state.activeCases = cases;
    state.medicineQueue = cases.map(c => ({ ...c, handoff: "READY_FOR_MEDICINE" }));

    if (options.telemetry) {
      state.lastTelemetryFile = options.telemetry.file;
      state.lastTelemetryAt = options.telemetry.at || null;
      state.lastTelemetryMessage = options.telemetry.message || null;
    }

    let snapshot = safeClone(state);
    window.BCGO_STATE = snapshot;
    const aiSnapshot = ingestInternalAI(snapshot);
    if (aiSnapshot) {
      state.internalAI = buildInternalAIHandoff(aiSnapshot);
      snapshot = safeClone(state);
      window.BCGO_STATE = snapshot;
    } else if (!state.internalAI) {
      state.internalAI = {version:null,signal:"WAITING",classification:"BCGO_SENSOR_ONLY",status:internalAIStatus,error:internalAIError,precisionGate:{pass:false,blockers:["INTERNAL_AI_NOT_READY"]},at:Date.now()};
      snapshot = safeClone(state);
      window.BCGO_STATE = snapshot;
    }
    publishToUI(snapshot);
    publishBCGOStateToMedicine(snapshot);
  }

  function situation() {
    const organs = buildOrgans();
    const active = Object.entries(organs).filter(([, v]) => v.state === "ACTIVE");
    if (firestore.error) return `Saya sedang menjaga koneksi Firestore. Sensor melaporkan: ${firestore.error}`;
    if (active.length) {
      const [file, info] = active[0];
      return `Saya menemukan ${active.length} anomali aktif. Fokus pertama saya ${file}: ${info.message}`;
    }
    const recovered = Object.values(organs).filter(v => v.state === "RECOVERED").length;
    return recovered
      ? `Tidak ada anomali aktif saat ini. ${recovered} organ masih memiliki bukti error historis yang saya tandai RECOVERED.`
      : `Semua ${ORGAN_COUNT} organ belum memiliki laporan error aktif dalam telemetry yang saya terima.`;
  }

  function findFile(question) {
    const q = String(question || "").toLowerCase();
    return Object.keys(ORGAN_REGISTRY).find(file => q.includes(file.toLowerCase())) || null;
  }

  function answerQuestion(question) {
    const raw = String(question || "").trim();
    const q = raw.toLowerCase();
    const organs = buildOrgans();
    const active = Object.entries(organs).filter(([, v]) => v.state === "ACTIVE");
    const recovered = Object.entries(organs).filter(([, v]) => v.state === "RECOVERED");
    const metrics = makeMetrics(organs);
    const file = findFile(raw);

    if (!q) return "Saya siap. Tanyakan kondisi sistem, error, file tertentu, telemetry terakhir, siklus saya, atau apa yang perlu saya teruskan ke Medicine.";

    if (/^(halo|hai|hello|pagi|siang|sore|malam)\b/.test(q) || /siapa kamu/.test(q)) {
      return `Halo. Saya BCGO. Saya bekerja dari telemetry dan state sistem yang sedang hidup, bukan dari tebakan. Sekarang cycle #${cycleNo}, tahap ${state.step}. ${situation()}`;
    }

    if (/scan ulang|rescan|pindai ulang|periksa ulang/.test(q)) {
      recordEvent("CHAT_COMMAND", "Anda meminta pemeriksaan ulang telemetry.", "SYS_CHAT_RESCAN");
      emit("IN", "Saya menerima perintah pemeriksaan ulang. Saya membaca ulang telemetry yang tersedia sekarang.", "SYS_CHAT_RESCAN", null, { cycleMode: "CHAT_COMMAND" });
      return `Baik. Saya mulai pemeriksaan ulang. Saat ini ${metrics.active} anomali aktif dari ${metrics.total} organ.`;
    }

    if (/medicine|obat|pengobatan|perbaiki|perbaikan|repair|sembuhkan/.test(q)) {
      if (!active.length) return "Belum ada kasus aktif yang cukup kuat untuk saya teruskan ke Medicine. Saya tidak akan membuat source code perbaikan tanpa bukti.";
      const [target, info] = active[0];
      return `Saya bisa meneruskan konteks ke Medicine. Kasus aktif pertama: ${target}. Bukti: ${info.message}. Medicine harus memverifikasi root cause dan source exact sebelum menyusun BEFORE → AFTER.`;
    }

    if (/sedang apa|sedang mengerjakan|lagi apa|ngapain|kerja apa/.test(q)) {
      return `Saya sedang berada di tahap ${state.step}, cycle #${cycleNo}. ${state.message} ${situation()}`;
    }

    if (/status|kondisi|sehat|aman/.test(q)) {
      if (firestore.error) return `Belum bisa saya sebut aman. Firestore sedang bermasalah: ${firestore.error}`;
      return `Status sekarang: ${metrics.active} anomali aktif, ${metrics.recovered} recovered, ${metrics.healthy} stabil dari ${metrics.total} organ. Firestore ${firestore.connected ? "LIVE" : "belum terhubung penuh"} dan probe membaca ${metrics.firestoreCount} data.`;
    }

    if (/error|masalah|anomali|gangguan|rusak/.test(q)) {
      if (!active.length) return "Saya belum melihat anomali aktif dari telemetry. Laporan lama tetap saya simpan sebagai RECOVERED; saya menunggu bukti baru secara real-time.";
      const detail = active.slice(0, 4).map(([f, v]) => `${f}: ${v.message}`).join(" | ");
      return `Ya, ada ${active.length} anomali aktif. ${detail}`;
    }

    if (/telemetry terakhir|impuls terakhir|error terakhir|terakhir/.test(q)) {
      if (!state.lastTelemetryFile) return "Belum ada telemetry terakhir yang bisa saya pastikan.";
      const age = effectiveAge(timestamp(state.lastTelemetryAt));
      return `Telemetry terakhir berasal dari ${state.lastTelemetryFile}, sekitar ${age < 1000 ? "baru saja" : `${Math.round(age / 1000)} detik lalu`}. Pesannya: ${state.lastTelemetryMessage || "-"}`;
    }

    if (/cycle|siklus|tahap|posisi/.test(q)) {
      return `Saya berada di cycle #${cycleNo}, tahap ${state.step}, mode ${state.cycleMode}. Target saraf saat ini: ${state.targetCell}.`;
    }

    if (/berapa.*file|berapa.*organ|organ.*apa|pantau apa|memantau apa/.test(q)) {
      return `Saya mengenali ${metrics.total} organ: ${Object.keys(ORGAN_REGISTRY).join(", ")}. ${metrics.active} sedang aktif bermasalah, ${metrics.recovered} recovered, ${metrics.healthy} stabil.`;
    }

    if (file) {
      const info = organs[file];
      if (!info) return `Saya mengenali ${file}, tetapi belum menerima state-nya.`;
      if (info.state === "ACTIVE") return `${file} sedang ANOMALY. Bukti telemetry: ${info.message}`;
      if (info.state === "RECOVERED") return `${file} berstatus RECOVERED. Ada bukti historis, tetapi tidak ada error aktif dalam window pemantauan.`;
      return `${file} saat ini HEALTHY menurut telemetry yang saya terima. Ini berarti belum ada laporan error aktif, bukan bukti bahwa source code pasti sempurna.`;
    }

    if (/kenapa|mengapa/.test(q)) {
      return `Saya berada di ${state.step} karena mesin sedang menjalankan: ${state.message} Target: ${state.targetCell}. Jika yang Anda tanyakan adalah penyebab error tertentu, sebutkan file atau error-nya agar saya tidak menebak.`;
    }

    if (/jelaskan|detail|rincian/.test(q)) {
      return `Saya bisa menjelaskan berdasarkan bukti. Saat ini: ${metrics.active} anomali aktif, ${metrics.recovered} recovered, Firestore ${firestore.connected ? "LIVE" : "belum LIVE"}, target ${state.targetCell}. Untuk detail akar masalah, saya perlu kasus/file yang spesifik.`;
    }

    return `Saya menangkap pertanyaanmu: “${raw}”. Saya belum punya bukti telemetry yang cukup untuk menjawab secara spesifik. Saya tidak akan mengarang. Kamu bisa bertanya tentang status, error, file tertentu, telemetry terakhir, cycle, atau meminta saya meneruskan kasus ke Medicine.`;
  }

  function interruptForTelemetry(fileName, message, log) {
    if (stopped || !authorized) return;
    const file = normalizeFile(fileName);
    const text = String(message || "Sinyal telemetry baru diterima.").slice(0, 900);
    const at = timestamp(log?.reportedAt) || Date.now();
    const signature = `${file}|${text}|${at}`;

    if (signature === previousTopSignature) return;
    previousTopSignature = signature;
    realtimeBusy = true;
    const generation = ++interruptGeneration;

    clearTimeout(cycleTimer);
    clearTimeout(interruptTimerProcess);
    clearTimeout(interruptTimerReview);
    interruptTimerProcess = null;
    interruptTimerReview = null;

    recordEvent("TELEMETRY", `Impuls baru dari ${file}.`, file);
    emit("PROCESS", `⚡ Saya menerima bukti baru dari ${file}. Saya hentikan sejenak siklus normal untuk memeriksanya.`, file, text, {
      cycleMode: "INTERRUPTED",
      telemetry: { file, at, message: text }
    });

    interruptTimerProcess = setTimeout(() => {
      interruptTimerProcess = null;
      if (stopped || !authorized || generation !== interruptGeneration) return;
      const organs = buildOrgans();
      const info = organs[file];
      const active = Object.entries(organs).filter(([, v]) => v.state === "ACTIVE");
      if (info?.state === "ACTIVE") {
        emit("REVIEW", `Bukti ${file} masih aktif. Saya mempertahankan kasus ini sebagai kandidat diagnosis dan menyiapkan konteks untuk Medicine.`, file, info.message, {
          cycleMode: "INTERRUPTED",
          telemetry: { file, at, message: text }
        });
      } else if (active.length) {
        emit("REVIEW", `Impuls ${file} sudah tidak aktif, tetapi ${active.length} anomali lain masih aktif. Saya lanjutkan REVIEW.`, active[0][0], active[0][1].message, { cycleMode: "INTERRUPTED" });
      } else {
        emit("REVIEW", `Saya sudah memeriksa impuls ${file}. Saat ini tidak ada anomali aktif yang bisa saya pastikan.`, file, null, { cycleMode: "INTERRUPTED" });
      }

      interruptTimerReview = setTimeout(() => {
        interruptTimerReview = null;
        if (stopped || !authorized || generation !== interruptGeneration) return;
        const activeNow = Object.entries(buildOrgans()).filter(([, v]) => v.state === "ACTIVE");
        emit("OUT", activeNow.length
          ? `Saya selesai menilai impuls ${file}. ${activeNow.length} kasus tetap berada dalam pengawasan.`
          : `Saya selesai menilai impuls ${file}. Pemantauan normal dilanjutkan.`, activeNow[0]?.[0] || file, activeNow[0]?.[1]?.message || null, { cycleMode: "NORMAL" });
        realtimeBusy = false;
        phaseIndex = 3;
        scheduleNext(CYCLE.OUT);
      }, CYCLE.REVIEW);
    }, CYCLE.PROCESS);
  }

  function cleanupRealtime() {
    if (executionBridgeTimer !== null) {
      clearInterval(executionBridgeTimer);
      executionBridgeTimer = null;
    }
    ++interruptGeneration;
    previousTopSignature = "";
    clearTimeout(cycleTimer);
    clearTimeout(interruptTimerProcess);
    clearTimeout(interruptTimerReview);
    clearInterval(refreshTimer);
    if (sourceScanTimer !== null) { clearTimeout(sourceScanTimer); sourceScanTimer = null; }
    ++sourceScanGeneration;
    sourceScanBusy = false;
    cycleTimer = null;
    interruptTimerProcess = null;
    interruptTimerReview = null;
    refreshTimer = null;
    if (typeof unsubscribeFirestore === "function") unsubscribeFirestore();
    if (typeof unsubscribeSystemLogs === "function") unsubscribeSystemLogs();
    unsubscribeFirestore = null;
    unsubscribeSystemLogs = null;
    realtimeBusy = false;
    if (sourceScanTimer) { clearTimeout(sourceScanTimer); sourceScanTimer = null; }
    sourceScanGeneration++;
  }

  function startSystemLogs() {
    const listenerEpoch = authEpoch;
    if (!window.CikurCloud?.listenSystemLogs) {
      emit("OUT", "Kanal telemetry system_logs belum tersedia dari CikurCloud. Saya tidak akan mengklaim pemantauan lintas-file aktif.", "SYS_TELEMETRY_UNAVAILABLE");
      return;
    }

    if (typeof unsubscribeSystemLogs === "function") unsubscribeSystemLogs();
    try {
      unsubscribeSystemLogs = window.CikurCloud.listenSystemLogs(logs => {
        if (stopped || !authorized || listenerEpoch !== authEpoch) return;
        const rawLogs = Array.isArray(logs) ? logs : [];
        // Filter first, then apply the display limit. Otherwise a burst of internal
        // self-errors at the top of the listener payload could hide real organ telemetry.
        latestSystemLogs = rawLogs.filter(log => !isInternalTelemetry(log)).slice(0, LOG_LIMIT);
        const top = latestSystemLogs[0];
        const topAt = timestamp(top?.reportedAt);
        const previousTop = previousTopSignature;

        const organs = buildOrgans();
        state.systemOrgans = organs;
        state.metrics = makeMetrics(organs);
        state.activeCases = makeCases(organs);
        state.medicineQueue = state.activeCases.map(c => ({ ...c, handoff: "READY_FOR_MEDICINE" }));
        state.systemLogs = latestSystemLogs.slice();
        state.lastTelemetryFile = top ? normalizeFile(top.fileName) : state.lastTelemetryFile;
        state.lastTelemetryAt = topAt || state.lastTelemetryAt;
        state.lastTelemetryMessage = top?.message || state.lastTelemetryMessage;
        window.BCGO_STATE = safeClone(state);
        // Every authoritative system_logs snapshot must pass through Internal AI.
        // The adapter itself deduplicates identical evidence, so this keeps the AI
        // synchronized without turning heartbeat/listener refreshes into new evidence.
        ingestInternalAI(window.BCGO_STATE);

        if (top && `${normalizeFile(top.fileName)}|${String(top.message || "")}|${topAt}` !== previousTop) {
          interruptForTelemetry(top.fileName, top.message, top);
        } else {
          publishToUI(safeClone(state));
        }
      }, LOG_LIMIT);
    } catch (error) {
      emit("PROCESS", "Kanal telemetry lintas-file gagal dibuka.", "SYS_SYSTEM_LOGS_LISTENER", error?.message, { cycleMode: "ERROR" });
    }
  }

  function startFirestoreProbe() {
    const listenerEpoch = authEpoch;
    if (typeof unsubscribeFirestore === "function") unsubscribeFirestore();
    try {
      const q = query(collection(db, "mitra_applications"), orderBy("submittedAt", "desc"), limit(PROBE_LIMIT));
      unsubscribeFirestore = onSnapshot(q, snapshot => {
        if (stopped || !authorized || listenerEpoch !== authEpoch) return;
        firestore.connected = true;
        firestore.count = snapshot.size;
        firestore.error = null;
        firestore.lastServerAt = Date.now();
        state.retryCount = 0;
        if (!realtimeBusy) {
          recordEvent("FIRESTORE", "Sensor Firestore aktif dan menerima snapshot baru.", "SYS_FIRESTORE_HEALTHY");
        }
        emit(state.step, state.message, "SYS_FIRESTORE_HEALTHY", null, { cycleMode: state.cycleMode });
      }, error => {
        if (stopped || !authorized || listenerEpoch !== authEpoch) return;
        firestore.connected = false;
        firestore.count = 0;
        firestore.error = error?.message || "Firestore listener error";
        recordEvent("FIRESTORE_ERROR", firestore.error, "SYS_FIRESTORE_CONNECTION");
        emit("PROCESS", "Sensor Firestore melaporkan gangguan. Saya mempertahankan status waspada dan tidak menyebut sistem sehat.", "SYS_FIRESTORE_CONNECTION", firestore.error, { cycleMode: "ERROR" });
      });
    } catch (error) {
      firestore.connected = false;
      firestore.error = error?.message || "Gagal membuat query Firestore";
      emit("PROCESS", "Saya gagal menyiapkan sensor Firestore.", "SYS_FIRESTORE_CONNECTION", firestore.error, { cycleMode: "ERROR" });
    }
  }

  function refreshState() {
    if (stopped || !authorized) return;
    const organs = buildOrgans();
    state.systemOrgans = organs;
    state.metrics = makeMetrics(organs);
    state.activeCases = makeCases(organs);
    state.medicineQueue = state.activeCases.map(c => ({ ...c, handoff: "READY_FOR_MEDICINE" }));
    state.systemLogs = latestSystemLogs.slice();
    state.firestore = { ...firestore };
    state.connection = deriveConnection();
    window.BCGO_STATE = safeClone(state);
    const aiSnapshot = ingestInternalAI(window.BCGO_STATE);
    if (aiSnapshot) {
      state.internalAI = buildInternalAIHandoff(aiSnapshot);
      window.BCGO_STATE = safeClone(state);
    }
    publishToUI(safeClone(state));
    publishBCGOStateToMedicine(safeClone(state));
  }

  function scheduleNext(delay) {
    clearTimeout(cycleTimer);
    cycleTimer = setTimeout(nextPhase, delay);
  }

  function nextPhase() {
    if (stopped || !authorized || realtimeBusy) return;
    phaseIndex = (phaseIndex + 1) % 4;

    if (phaseIndex === 0) {
      cycleNo += 1;
      recordEvent("CYCLE", `Neural cycle #${cycleNo} dimulai.`, "SYS_NEURAL_SCAN");
      emit("IN", `Neural cycle #${cycleNo} dimulai. Saya memindai ${ORGAN_COUNT} organ dan membaca bukti telemetry terbaru.`, "SYS_NEURAL_SCAN", null, { cycleMode: "NORMAL" });
      scheduleNext(CYCLE.IN);
      return;
    }

    if (phaseIndex === 1) {
      const active = Object.entries(buildOrgans()).filter(([, v]) => v.state === "ACTIVE");
      emit("PROCESS", active.length
        ? `Saya menemukan ${active.length} anomali aktif. Saya memproses bukti sebelum menyimpulkan akar masalah.`
        : `Tidak ada anomali aktif. Saya membandingkan ${latestSystemLogs.length} laporan telemetry dengan window pemantauan.`, active[0]?.[0] || "SYS_TELEMETRY_ANALYSIS", active[0]?.[1]?.message || null, { cycleMode: "NORMAL" });
      scheduleNext(CYCLE.PROCESS);
      return;
    }

    if (phaseIndex === 2) {
      const active = Object.entries(buildOrgans()).filter(([, v]) => v.state === "ACTIVE");
      emit("REVIEW", active.length
        ? `REVIEW: ${active.length} kasus aktif. Saya mempertahankan bukti dan menyiapkan konteks yang dapat diverifikasi Medicine.`
        : "REVIEW selesai. Tidak ada anomali aktif yang dapat saya pastikan dari telemetry saat ini.", active[0]?.[0] || "SYS_NEURAL_REVIEW", active[0]?.[1]?.message || null, { cycleMode: "NORMAL" });
      scheduleNext(CYCLE.REVIEW);
      return;
    }

    const active = Object.entries(buildOrgans()).filter(([, v]) => v.state === "ACTIVE");
    emit("OUT", active.length
      ? `Cycle #${cycleNo} selesai. ${active.length} anomali tetap aktif dan terus diawasi.`
      : `Cycle #${cycleNo} selesai. Pemantauan kembali normal dan telemetry tetap didengarkan.`, active[0]?.[0] || "SYS_NEURAL_SYNC", active[0]?.[1]?.message || null, { cycleMode: active.length ? "ALERT" : "NORMAL" });
    scheduleNext(CYCLE.OUT);
  }

  async function verifyAdmin(user, epoch) {
    if (stopped || epoch !== authEpoch) return;
    if (!user) {
      authorized = false;
      authorizedUid = null;
      cleanupRealtime();
      emit("OUT", "Sesi Admin belum tersedia. Silakan login sebagai Admin.", "SYS_AUTH_REQUIRED");
      return;
    }

    try {
      const snap = await getDoc(doc(db, "admin_users", user.uid));
      if (stopped || epoch !== authEpoch || auth.currentUser?.uid !== user.uid) return;
      const data = snap.exists() ? snap.data() : null;
      if (data?.active !== true) {
        authorized = false;
        authorizedUid = null;
        cleanupRealtime();
        emit("OUT", "Akun ini bukan Admin aktif. Akses Pusat Saraf ditolak.", "SYS_AUTH_NOT_ADMIN");
        return;
      }
      // Auth state can change without reloading the page. Never keep an old
      // listener/session alive for a different UID.
      if (authorized && authorizedUid === user.uid) return;
      if (authorized && authorizedUid !== user.uid) {
        cleanupRealtime();
        authorized = false;
        authorizedUid = null;
      }

      authorized = true;
      authorizedUid = user.uid;
      recordEvent("AUTH", "Admin terverifikasi. Sensor real-time dibuka.", "SYS_AUTH_VERIFIED");
      emit("IN", "Admin terverifikasi. Saya membuka sensor telemetry dan Firestore real-time.", "SYS_AUTH_VERIFIED", null, { cycleMode: "BOOT" });
      startSystemLogs();
      startFirestoreProbe();
      if (sourceScanTimer === null) {
        runSourceScan("BOOT").finally(() => { if (!stopped && authorized) scheduleSourceScan(SOURCE_SCAN_INTERVAL); });
      }
      refreshTimer = setInterval(refreshState, 15000);
      phaseIndex = -1;
      cycleNo = 0;
      nextPhase();
    } catch (error) {
      authorized = false;
      authorizedUid = null;
      cleanupRealtime();
      emit("OUT", "Saya gagal memverifikasi status Admin.", "SYS_AUTH_CHECK_FAILED", error?.message, { cycleMode: "ERROR" });
    }
  }

  // Error UI lokal hanya dicatat sebagai diagnostic internal.
  // Tidak boleh masuk ke system_logs sebagai anomaly bcgo.html karena itu
  // dapat membuat loop: render error -> telemetry -> render -> error.
  window.addEventListener("error", event => {
    if (stopped) return;
    const source = normalizeFile(event?.filename || "__BCGO_UI__");
    const message = event?.message || event?.error?.message || "JavaScript error tidak diketahui.";
    if (source === "bcgo.html" || source === "bcgo.js") {
      state.uiError = `[${source}] ${String(message).slice(0, 450)}`;
      recordEvent("UI_ERROR", state.uiError, "SYS_UI_RENDER");
      console.warn("BCGO UI diagnostic:", state.uiError);
    }
  });

  window.addEventListener("unhandledrejection", event => {
    if (stopped) return;
    const reason = event?.reason?.message || String(event?.reason || "Unhandled Promise rejection.");
    state.uiError = String(reason).slice(0, 450);
    recordEvent("UI_REJECTION", state.uiError, "SYS_UI_RENDER");
    // This is a local diagnostic only. Never promote it into system_logs/anomaly.
    try { event.preventDefault(); } catch {}
    console.warn("BCGO UI rejection diagnostic:", state.uiError);
  });

  const brain = {
    ask: answerQuestion,
    getState: () => {
      const organs = buildOrgans();
      state.systemOrgans = organs;
      state.metrics = makeMetrics(organs);
      state.activeCases = makeCases(organs);
      state.medicineQueue = state.activeCases.map(c => ({ ...c, handoff: "READY_FOR_MEDICINE" }));
      return safeClone(state);
    },
    getSituation: situation,
    getRegistry: () => ({ ...ORGAN_REGISTRY }),
    stop() {
      stopped = true;
      ++authEpoch;
      clearTimeout(cycleTimer);
      clearInterval(refreshTimer);
      if (typeof unsubscribeAuth === "function") unsubscribeAuth();
      cleanupRealtime();
      try { medicineBridgeChannel?.close(); } catch {}
    }
  };

  window.BCGOBrain = brain;
  window.BCGO_STATE = safeClone(state);
  publishBCGOStateToMedicine(safeClone(state));
  // Optional reasoning adapter: load asynchronously so a missing/stale adapter
  // can never prevent the BCGO sensor, Firestore listener, or source scanner from booting.
  void loadInternalAI();
  unsubscribeAuth = onAuthStateChanged(auth, user => {
    const epoch = ++authEpoch;
    verifyAdmin(user, epoch).catch(error => {
      if (stopped || epoch !== authEpoch) return;
      authorized = false;
      authorizedUid = null;
      cleanupRealtime();
      emit("OUT", "Saya gagal memverifikasi status Admin.", "SYS_AUTH_CHECK_FAILED", error?.message, { cycleMode: "ERROR" });
    });
  });
  return brain;
}
