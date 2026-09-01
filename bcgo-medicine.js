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

/*
 * ================================================================
 * BCGO MEDICINE v2.8.1 — PRECISION DIAGNOSTIC + INTERNAL EXECUTOR BRIDGE
 * ================================================================
 * Boundary:
 *   Medicine observes, investigates, proves, proposes and validates.
 *   It NEVER writes repository source by itself.
 *
 * Flow:
 *   TELEMETRY -> CASE -> DEPENDENCY SURFACE -> ROOT CAUSE
 *   -> EXACT SOURCE -> BEFORE/AFTER -> HUMAN APPROVAL
 *   -> HUMAN REVIEW -> VALIDATION
 *
 * Medicine does not execute source changes. Executor integration is intentionally
 * absent from this clean baseline and will be added later as a separate internal system.
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
  "NEEDS_EVIDENCE",
  "VERIFIED_DIAGNOSIS",
  "READY_FOR_PATCH",
  "PATCH_PENDING_EXECUTION",
  "PATCH_APPLIED",
  "PATCH_REQUIRES_REVIEW",
  "PATCH_FAILED"
]);

const TERMINAL_STATUSES = new Set(["REJECTED","FIXED_VERIFIED","RECOVERED"]);

const S = {
  version: "2.8.1",
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
    lastResult: null
  },
  investigated: new Set()
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
  if (/not defined|undefined|is not a function/.test(m)) {
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
  if (S.busy.surface) return S.surface?.files || Object.keys(REGISTRY);
  S.busy.surface = true;

  try {
    const roots = ["bcgo-engine.js","bcgo-admin.html","bcgo.js","bcgo.html"];
    const discovered = new Set(Object.keys(REGISTRY));
    const edges = [];

    for (const root of roots) {
      const source = await fetchFile(root);
      if (!source.ok) continue;

      const refs = [
        ...extractDependencies(root, source.text),
        ...[...source.text.matchAll(/["'`]([A-Za-z0-9_.-]+\.(?:html|js))["'`]/gi)]
          .map(m => normalizeFile(m[1]))
          .filter(Boolean)
      ];

      for (const ref of refs) {
        discovered.add(ref);
        if (!REGISTRY[ref]) REGISTRY[ref] = { type:"Discovered Dependency", role:"dependency" };
        edges.push({ from:root, to:ref });
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
    items.every(x => x.type === "REPLACE_EXACT" && x.before && x.after);

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

async function resolveRootCause(c) {
  const log = c.evidence || {};
  const original = normalizeFile(c.source) || c.source;
  const locations = parseRuntimeLocations(log);

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

function makeCase(log, options = {}) {
  const source = normalizeFile(log?.fileName || log?.source || log?.file) || "UNKNOWN";
  const signature = text(log?.message || log?.error || "Unknown error",700);
  const evidenceId = String(log?.id || log?.eventId || "").trim();

  if (evidenceId && S.cases.some(c => c.evidenceId === evidenceId)) return null;

  let existing = S.cases.find(c =>
    c.source === source &&
    c.signature === signature &&
    ACTIVE_STATUSES.has(c.status)
  );

  if (existing) {
    existing.evidenceCount = (existing.evidenceCount || 1) + 1;
    existing.lastSeenAt = now();
    existing.lastEvidence = log;
    S.activeCase = existing;
    emit("case_updated",{case:existing,mergedEvidence:true});
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
    validation:null
  };

  S.cases.unshift(c);
  S.cases = S.cases.slice(0,100);
  S.activeCase = c;

  emit("case_created",{case:c});

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

  if (options.autoInvestigate !== false && !S.human.paused && !S.investigated.has(c.id)) {
    S.investigated.add(c.id);
    setTimeout(() => {
      verifyWithMedicine(c.source,{
        requestedBy:"telemetry_auto",
        question:`Auto-investigasi telemetry: ${c.signature}`,
        noRetry:true
      }).catch(error => emit("investigation_error",{
        caseId:c.id,
        message:error?.message || String(error)
      }));
    },250);
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
        if (c && !S.investigated.has(c.id) && !S.human.paused) {
          S.investigated.add(c.id);
          setTimeout(() => {
            verifyWithMedicine(c.source,{
              requestedBy:"telemetry_initial",
              question:`Initial investigation: ${c.signature}`,
              noRetry:true
            }).catch(error => emit("investigation_error",{
              caseId:c.id,
              message:error?.message || String(error)
            }));
          },350);
        }
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
      ? targets.filter(n => REGISTRY[n])
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
      checkedAt:now(),
      question:context.question || null
    };

    if (c) {
      S.activeCase = c;
      c.status = "INVESTIGATING";

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

      const exactEvidence = plan.sourceEvidence.some(e => e.evidenceStrength === "HIGH");
      const exactOps = plan.operations.length > 0 &&
        plan.operations.every(op =>
          op.type === "REPLACE_EXACT" &&
          op.before &&
          op.after &&
          op.file === plan.rootCauseFile
        );

      const rootProven = [
        "CONFIRMED_ORIGINAL_TARGET",
        "TARGET_CORRECTED_BY_MEDICINE",
        "CONTRACT_ROOT_CAUSE_IDENTIFIED"
      ].includes(plan.rootCauseStatus);

      plan.precisionGate = !!(exactEvidence && exactOps && rootProven);

      if (plan.precisionGate) {
        plan.status = "PROPOSED";
        plan.blockReason = null;
        c.status = "VERIFIED_DIAGNOSIS";
      } else {
        plan.status = "PATCH_REQUIRES_REVIEW";
        plan.blockReason =
          "PRECISION GATE TERKUNCI: root cause, evidence HIGH dan operasi exact belum lengkap.";
        c.status = "NEEDS_EVIDENCE";
      }

      await attachSourceContext(plan);
      c.repairPlan = plan;
      c.rootCauseFile = plan.rootCauseFile;
      c.rootCauseStatus = plan.rootCauseStatus;
      c.sourceEvidence = plan.sourceEvidence;

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
    c.status === "VERIFIED_DIAGNOSIS" &&
    p?.precisionGate === true &&
    v?.verdict === "SUPPORTED_BY_EXACT_SOURCE_EVIDENCE" &&
    p.operations?.length &&
    p.operations.every(op =>
      op.type === "REPLACE_EXACT" &&
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

async function applyApprovedTreatment(caseId) {
  const c = S.cases.find(x => x.id === caseId);
  if (!c) throw new Error("Case tidak ditemukan");
  if (S.human.paused) throw new Error("Medicine sedang dijeda");
  if (!canApplyPatch(c)) throw new Error("Patch belum memenuhi Precision Gate");

  const e = internalExecutor();
  if (!e) throw new Error("INTERNAL_EXECUTOR_NOT_LOADED");

  const proposal = c.patchProposal || findProposal(c.id);
  if (!proposal) throw new Error("Patch proposal tidak ditemukan");
  const ops = Array.isArray(c.repairPlan?.operations) ? c.repairPlan.operations : [];
  if (ops.length !== 1) {
    throw new Error("INTERNAL_EXECUTOR_BATCH_NOT_SUPPORTED: gunakan satu operasi exact per eksekusi");
  }

  const op = ops[0];
  const source = await fetchFile(op.file, { force: true });
  if (!source.ok || typeof source.text !== "string") {
    throw new Error(`SOURCE_UNAVAILABLE:${op.file}`);
  }

  const currentFingerprint = fingerprint(source.text);
  if (op.before && !source.text.includes(op.before)) {
    throw new Error("EXACT_BEFORE_NOT_PRESENT_IN_CURRENT_SOURCE");
  }

  const request = buildExecutorRequest(c, proposal, op, {
    text: source.text,
    fingerprint: currentFingerprint
  });

  S.busy.execution = true;
  proposal.status = "APPLY_REQUESTED";
  c.status = "PATCH_PENDING_EXECUTION";
  S.patchRequests.unshift(request);
  S.patchRequests = S.patchRequests.slice(0, 40);
  emit("patch_apply_requested", { proposal, request, case: c, executorAvailable: true, executor: syncExecutorState() });

  try {
    const result = await e.execute(request, source.text);
    proposal.executorResult = result || null;
    proposal.status = result?.status === "SUCCESS" ? "APPLIED" : "APPLY_FAILED";
    c.status = result?.status === "SUCCESS" ? "PATCH_APPLIED" : "PATCH_FAILED";
    S.executor = {
      ...S.executor,
      available: true,
      name: e.name || "BCGO_INTERNAL_EXECUTOR",
      version: e.version || null,
      status: result?.status || "FAILED",
      persistence: result?.persistence || null,
      lastResult: result || null,
      lastEventAt: now()
    };
    emit("executor_state", { executor: { ...S.executor } });
    emit("patch_apply_complete", { proposal, request, result, case: c });

    if (result?.status === "SUCCESS") {
      await validateAfterPatch(caseId);
    }

    return { case: c, proposal, request, result };
  } finally {
    S.busy.execution = false;
  }
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
    if (op.type === "REPLACE_EXACT") {
      const textToCheck = internalSource?.content || deployed.text || "";
      if (textToCheck.includes(op.before) || !textToCheck.includes(op.after)) operationVerified = false;
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
      action:"APPROVED_READY_FOR_PATCH",
      actorUid:c.approvedBy,
      createdAt:serverTimestamp()
    });
  } catch (error) {
    emit("storage_warning",{message:error?.message || String(error)});
  }

  await safeAddMessage(
    "medicine",
    `Approval manusia diterima untuk ${c.id}. Repair plan ${c.repairPlan?.planId} siap masuk ke executor tepercaya.`,
    {kind:"HUMAN_APPROVAL",caseId:c.id}
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

function receiveBCGOState(packet) {
  if (!packet || packet.bridge !== MEDICINE_BRIDGE_KEY || packet.from !== "BCGO") return;
  if (!["BCGO_STATE","BCGO_SYNC_REQUEST"].includes(packet.type)) return;
  const at = Number(packet.at) || 0;
  if (!at) return;
  const age = Date.now() - at;
  const st = packet.state || {};
  S.bcgoSync = {
    ...S.bcgoSync,
    status: age <= MEDICINE_BRIDGE_LIVE_WINDOW ? "LIVE" : "STALE",
    lastAt: at,
    cycle: Number(st.cycle) || 0,
    step: st.step || "-",
    active: Number(st.metrics?.active) || 0,
    total: Number(st.metrics?.total) || 0,
    source: "BROADCAST_CHANNEL"
  };
  window.dispatchEvent(new CustomEvent("bcgo:medicine", {
    detail:{event:"bcgo_sync",at:now(),contract:{...S.bcgoSync}}
  }));
  // A sync request receives a real acknowledgement. No diagnosis is triggered.
  if (packet.type === "BCGO_SYNC_REQUEST") publishMedicineState("BCGO_SYNC_ACK", {message:`ACK cycle #${S.bcgoSync.cycle} / ${S.bcgoSync.step}`});
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
    startTelemetry();
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
  verifyWithMedicine,
  sendMessage,
  approveTreatment,
  applyApprovedTreatment,
  validateAfterPatch,
  rejectTreatment,
  requestReview,
  setHumanMode,
  buildCodePrescription,
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
