import {
  collection, onSnapshot, query, orderBy, limit, addDoc, serverTimestamp, doc, getDoc
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { db, auth } from "./cikur-config.js";
import { runAutonomousEngine } from "./bcgo.js?v=3.0";

/*
 * BCGO MEDICINE v3.3 — PRECISION REPAIR / VERIFIED HEALING ENGINE
 *
 * Purpose:
 *   DIAGNOSE -> VERIFY -> BUILD REPAIR PLAN -> HUMAN APPROVAL -> EXECUTE -> VALIDATE
 *
 * Important boundary:
 *   Medicine can inspect deployed source and create an exact repair plan.
 *   Persistent source-code writing is ONLY delegated to a trusted Patch Executor
 *   exposed as window.BCGOPatchExecutor. A browser page must never contain a GitHub
 *   token or silently write repository source.
 *
 * Executor contract:
 *   window.BCGOPatchExecutor.apply({ case, proposal, request })
 *     -> { ok:boolean, changedFiles?:string[], commitUrl?:string, error?:string }
 *
 * The proposal contains deterministic operations with BEFORE/AFTER material so an
 * executor/backend can apply the repair and return the result to Medicine.
 */

// CONTRACT: this registry is an exact mirror of ORGAN_REGISTRY in bcgo.js.
// Do not add/remove/rename an entry here independently.
// v3.2: parity is verified against window.BCGOBrain.getRegistry() at runtime.
const REGISTRY = {
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
  "bcgo.html": { type: "Sistem Monitor", role: "monitor" },
  "data-cgo.html": { type: "Data Sistem", role: "data" },
  "bcgo-medicine.js": { type: "Otak Medicine", role: "medicine" },
  "bcgo-medicine.html": { type: "UI Medicine", role: "medicine" }
};

// bcgo.js is the producer engine itself, not an organ in BCGO's 15-organ registry.
// Medicine may inspect its source as a dependency, but it must not count it as an organ.
const SOURCE_SURFACE = ["bcgo.js"];

const REQUIRED = {
  driver: ["name", "phone", "address", "vehicleType", "photo", "ktp", "sim", "bank", "accountName", "accountNo"],
  assistant: ["name", "phone", "address", "serviceType", "ktp", "fotoKtp", "socialMedia"],
  customer: ["name", "phone", "email"],
  restaurant: [
    "name", "phone", "address", "businessName", "businessType", "ownerName", "role",
    "village", "district", "city", "province", "openTime", "closeTime", "operationalDays",
    "ktp", "legalStatus", "bankName", "accountName", "accountNumber", "photoFront"
  ]
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
  "name", "phone", "address", "email", "vehicleType", "vehicle", "serviceType", "photo", "profilePhoto", "fotoProfil",
  "photoFront", "photoIndoor", "fotoKtp", "fotoSim", "fotoStnk", "ktp", "sim", "stnk", "bank", "bankName",
  "accountName", "accountNumber", "accountNo", "businessName", "businessType", "ownerName", "role", "village",
  "district", "city", "province", "openTime", "closeTime", "operationalDays", "legalStatus", "socialMedia"
]);

function canonicalFieldSet(values) {
  const raw = new Set((values || []).map(String));
  const out = new Set(raw);
  for (const [canonical, aliases] of Object.entries(FIELD_ALIASES)) {
    if (aliases.some(a => raw.has(a))) out.add(canonical);
  }
  return out;
}

const S = {
  version: "3.3.0",
  registry: REGISTRY,
  logs: [],
  cases: [],
  activeCase: null,
  findings: [],
  listeners: [],
  messages: [],
  human: { mode: "ASSISTED", paused: false, uid: null },
  patchProposals: [],
  patchRequests: [],
  verification: null,
  validation: null,
  sourceCache: new Map(),
  lastClientMessageId: null,
  eventSeq: 0,
  autonomous: { enabled: true, turn: 0, timer: null, lastAt: 0 },
  bcgoState: null,
  registryParity: { ok: false, status: "WAITING", bcgoCount: 0, medicineCount: Object.keys(REGISTRY).length, missing: [], extra: [], mismatched: [] },
  bcgoContract: {
    step: "IN",
    message: "",
    targetCell: "",
    cycle: 0,
    cycleMode: "BOOT",
    metrics: {},
    systemOrgans: {},
    systemLogs: [],
    activeCases: [],
    medicineQueue: [],
    connection: {}
  },
  bcgoEngine: null,
  bcgoSynced: false
};

const emit = (event, p = {}) => window.dispatchEvent(new CustomEvent("bcgo:medicine", {
  detail: { event, at: new Date().toISOString(), ...p }
}));
const now = () => new Date().toISOString();
const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
const text = (v, n = 1800) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const safeLower = v => String(v ?? "").toLowerCase();
const escRegExp = v => String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function diagnosis(message) {
  const m = safeLower(message);
  if (/cannot set properties of null|cannot read properties of null/.test(m)) {
    return { code: "DOM_NULL_REFERENCE", title: "Referensi DOM tidak ditemukan", severity: "MEDIUM", confidence: .96, treatment: "DOM_NULL_GUARD" };
  }
  if (/permission-denied|permission denied|unauthenticated/.test(m)) {
    return { code: "AUTH_PERMISSION", title: "Masalah otorisasi", severity: "HIGH", confidence: .94, treatment: "AUTH_REVIEW" };
  }
  if (/firestore|listener|network|offline|unavailable|onSnapshot/.test(m)) {
    return { code: "REALTIME_CONNECTIVITY", title: "Gangguan koneksi/listener realtime", severity: "MEDIUM", confidence: .84, treatment: "FIRESTORE_RECONNECT" };
  }
  if (/undefined|is not a function|not defined/.test(m)) {
    return { code: "JAVASCRIPT_CONTRACT", title: "Kontrak JavaScript tidak terpenuhi", severity: "MEDIUM", confidence: .82, treatment: "RUNTIME_CONTRACT_REVIEW" };
  }
  if (/sinkron|synchron|count|jumlah|validasi|mitra|tidak sesuai|tidak sinkron/.test(m)) {
    return { code: "DATA_CONSISTENCY", title: "Potensi ketidaksinkronan data/validasi", severity: "MEDIUM", confidence: .70, treatment: "CROSS_FILE_CONSISTENCY_REVIEW" };
  }
  return { code: "UNCLASSIFIED_RUNTIME", title: "Runtime anomaly belum terklasifikasi", severity: "UNKNOWN", confidence: .45, treatment: "MANUAL_DIAGNOSIS" };
}

function prescription(d) {
  const safe = ["DOM_NULL_GUARD", "FIRESTORE_RECONNECT", "CROSS_FILE_CONSISTENCY_REVIEW"].includes(d.treatment);
  return { treatment: d.treatment, risk: safe ? "LOW" : "HIGH", mode: safe ? "SAFE_PROPOSAL" : "APPROVAL_REQUIRED" };
}

function activeCases() {
  return S.cases.filter(c => !["RECOVERED", "REJECTED", "FIXED_VERIFIED"].includes(c.status));
}

function mentionedFile(q) {
  const x = safeLower(q);
  return Object.keys(REGISTRY).find(f => x.includes(f.toLowerCase())) || null;
}

function normalizeFile(value) {
  const raw = String(value || "").trim();
  if (!raw) return "UNKNOWN";
  const clean = raw.split("?")[0].split("#")[0];
  return clean.substring(clean.lastIndexOf("/") + 1) || raw;
}

function latestRelevantLogs(file) {
  const wanted = normalizeFile(file);
  return S.logs.filter(l => normalizeFile(l.fileName || l.source || l.file) === wanted).slice(0, 12);
}


async function postSystemMessage(role, msg, meta = {}) {
  const clientMessageId = meta.clientMessageId || uid();
  const payload = {
    role,
    text: text(msg, 1800),
    actorUid: role === "human" ? (auth.currentUser?.uid || null) : null,
    system: role !== "human",
    createdAt: serverTimestamp(),
    clientMessageId,
    ...meta
  };
  try {
    await addDoc(collection(db, "medicine_messages"), payload);
  } catch (e) {
    emit("local_message", { message: { ...payload, createdAt: now() }, storageError: e.message });
  }
}

function syncFromBCGOState(state) {
  if (!state || typeof state !== "object") return;
  // BCGO_STATE is authoritative. Keep an explicit 1:1 contract snapshot
  // instead of rebuilding BCGO metrics/organs/cases inside Medicine.
  S.bcgoState = state;
  S.bcgoContract = {
    step: state.step,
    message: state.message,
    targetCell: state.targetCell,
    cycle: state.cycle,
    cycleMode: state.cycleMode,
    metrics: state.metrics || {},
    systemOrgans: state.systemOrgans || {},
    systemLogs: Array.isArray(state.systemLogs) ? state.systemLogs.slice() : [],
    activeCases: Array.isArray(state.activeCases) ? state.activeCases.slice() : [],
    medicineQueue: Array.isArray(state.medicineQueue) ? state.medicineQueue.slice() : [],
    connection: state.connection || {}
  };
  S.bcgoSynced = true;
  S.logs = S.bcgoContract.systemLogs.slice();

  const queue = S.bcgoContract.medicineQueue;
  const queueIds = new Set(queue.map(x => x.id));

  for (const handoff of queue) {
    const target = normalizeFile(handoff.target || handoff.file);
    const evidence = S.logs.find(log =>
      normalizeFile(log?.fileName || log?.source || log?.file) === target &&
      String(log?.reportedAt ?? "") === String(handoff?.evidence?.reportedAt ?? handoff?.reportedAt ?? "")
    ) || S.logs.find(log => normalizeFile(log?.fileName || log?.source || log?.file) === target);

    let c = S.cases.find(x => x.bcgoCaseId === handoff.id || x.id === handoff.id);
    if (!c) {
      const sig = text(evidence?.message || handoff?.evidence?.message || handoff.message || "Sinyal telemetry BCGO diterima.", 700);
      const d = diagnosis(sig);
      c = {
        id: handoff.id,
        bcgoCaseId: handoff.id,
        source: target,
        signature: sig,
        runtimeLocation: {
          file: target,
          line: Number(evidence?.lineNumber ?? evidence?.line ?? handoff?.evidence?.line) || null,
          col: Number(evidence?.columnNumber ?? evidence?.column ?? handoff?.evidence?.column) || null,
          stack: text(evidence?.stack || evidence?.stackTrace || "", 1200)
        },
        diagnosis: d,
        prescription: prescription(d),
        status: "DIAGNOSED",
        createdAt: now(),
        evidence: evidence || handoff.evidence || handoff,
        repairPlan: null,
        rootCauseFile: target,
        sourceEvidence: [],
        validation: null,
        bcgoHandoff: { ...handoff, handoff: "READY_FOR_MEDICINE" }
      };
      S.cases.unshift(c);
      S.cases = S.cases.slice(0, 80);
      emit("case_created", { case: c, source: "BCGO_STATE.medicineQueue" });
      void postSystemMessage("medicine", `Saya menerima ${c.id} langsung dari BCGO_STATE.medicineQueue. Target: ${target}. Saya hanya akan membuka treatment setelah root cause dan source exact terbukti.`, {
        kind: "MEDICINE_BCGO_HANDOFF", caseId: c.id, target
      });
    } else {
      c.bcgoHandoff = { ...handoff, handoff: "READY_FOR_MEDICINE" };
      c.evidence = evidence || c.evidence;
      c.lastBCGOStateAt = now();
      if (!c.repairPlan && !["REJECTED", "FIXED_VERIFIED"].includes(c.status)) {
        c.status = c.status === "PATCH_APPLIED" ? c.status : "DIAGNOSED";
      }
      emit("case_updated", { case: c, source: "BCGO_STATE.medicineQueue" });
    }
  }

  // BCGO is authoritative for whether a telemetry case is currently active.
  // Only cases that originated from BCGO are auto-recovered here. Treatment/validation
  // lifecycle is left intact.
  for (const c of S.cases) {
    if (!c.bcgoCaseId || queueIds.has(c.bcgoCaseId)) continue;
    if (["DIAGNOSED", "INVESTIGATING", "NEEDS_EVIDENCE"].includes(c.status)) {
      c.status = "RECOVERED";
      c.recoveredAt = now();
      emit("case_updated", { case: c, recovered: true, source: "BCGO_STATE" });
    }
  }

  S.activeCase = queueIds.size
    ? (S.cases.find(c => queueIds.has(c.bcgoCaseId)) || null)
    : null;

  emit("telemetry", { logs: S.logs, transport: "BCGO_STATE" });
  emit("bcgo_sync", {
    state,
    contract: {
      metrics: state.metrics || {},
      activeCases: state.activeCases || [],
      medicineQueue: queue,
      systemOrgans: state.systemOrgans || {},
      connection: state.connection || {}
    }
  });
}

function verifyRegistryParity() {
  const producer = window.BCGOBrain?.getRegistry?.();
  if (!producer || typeof producer !== "object") {
    S.registryParity = {
      ok: false, status: "WAITING_FOR_BCGO_REGISTRY",
      bcgoCount: 0, medicineCount: Object.keys(REGISTRY).length,
      missing: [], extra: [], mismatched: []
    };
    emit("registry_parity", S.registryParity);
    return S.registryParity;
  }

  const pNames = Object.keys(producer);
  const mNames = Object.keys(REGISTRY);
  const missing = pNames.filter(name => !REGISTRY[name]);
  const extra = mNames.filter(name => !producer[name]);
  const mismatched = mNames.filter(name => {
    if (!producer[name]) return false;
    return producer[name].type !== REGISTRY[name].type || producer[name].role !== REGISTRY[name].role;
  });

  S.registryParity = {
    ok: missing.length === 0 && extra.length === 0 && mismatched.length === 0 && pNames.length === mNames.length,
    status: missing.length || extra.length || mismatched.length ? "MISMATCH" : "EXACT_1_TO_1",
    bcgoCount: pNames.length, medicineCount: mNames.length, missing, extra, mismatched
  };
  emit("registry_parity", S.registryParity);
  return S.registryParity;
}

function startTelemetry() {
  if (S.bcgoEngine) return;
  try {
    // Use the exact BCGO engine as the state producer. Medicine does not reimplement
    // buildOrgans(), makeCases(), timestamp rules, or the ACTIVE window.
    S.bcgoEngine = runAutonomousEngine(state => syncFromBCGOState(state));
    verifyRegistryParity();
    S.listeners.push(() => {
      try { S.bcgoEngine?.stop?.(); } catch {}
      S.bcgoEngine = null;
    });
    emit("telemetry_transport", { transport: "BCGO_ENGINE_STATE" });
  } catch (e) {
    emit("telemetry_unavailable", { message: e?.message || String(e) });
  }
}

async function fetchFile(name) {
  const cached = S.sourceCache.get(name);
  if (cached && Date.now() - cached.at < 4000) return cached.value;
  try {
    const r = await fetch(`./${encodeURIComponent(name)}`, { cache: "no-store" });
    const value = { ok: r.ok, status: r.status, text: r.ok ? await r.text() : "", fetchedAt: now() };
    S.sourceCache.set(name, { at: Date.now(), value });
    return value;
  } catch (e) {
    const value = { ok: false, status: 0, text: "", error: e.message, fetchedAt: now() };
    S.sourceCache.set(name, { at: Date.now(), value });
    return value;
  }
}

function fields(name, source) {
  if (!source) return [];
  const out = [];
  let m;
  const htmlAttr = /(?:id|name|data-field|data-key)\s*=\s*["']([^"']+)["']/gi;
  while ((m = htmlAttr.exec(source))) out.push(m[1]);

  // Normalize common registration IDs to their persisted contract fields.
  const idAliases = {
    regName:"name", regPhone:"phone", regAddress:"address", regVehicleType:"vehicleType", regVehicle:"vehicle",
    regPhoto:"photo", regFotoKtp:"fotoKtp", regFotoSim:"fotoSim", regFotoStnk:"fotoStnk", regKtp:"ktp", regSim:"sim",
    regBank:"bank", regAccountName:"accountName", regAccountNo:"accountNo", mitraAlamat:"address", mitraArea:"area",
    mitraKtp:"ktp", mitraFotoKtp:"fotoKtp", mitraSocialMedia:"socialMedia"
  };
  for (const [id, canonical] of Object.entries(idAliases)) if (source.includes(`id="${id}"`) || source.includes(`id='${id}'`)) out.push(canonical);

  // Read actual data contract usage in renderers/handlers, not only HTML attributes.
  // This is critical for Admin pages that render fields as ${data.photo}, data.photo,
  // optional chains, destructuring, or object spreads.
  const dataAccess = /\bdata\s*\??\.\s*([A-Za-z_$][\w$]*)/g;
  while ((m = dataAccess.exec(source))) out.push(m[1]);
  const dataBracket = /\bdata\s*\[\s*["']([A-Za-z_$][\w$]*)["']\s*\]/g;
  while ((m = dataBracket.exec(source))) out.push(m[1]);
  const interpolation = /\$\{\s*(?:data|application|partner|payload)\s*\??\.\s*([A-Za-z_$][\w$]*)/g;
  while ((m = interpolation.exec(source))) out.push(m[1]);

  if (/\.js$/i.test(name)) {
    const jsFields = /\b(name|phone|address|email|vehicleType|vehicle|photo|profilePhoto|fotoProfil|photoFront|photoIndoor|fotoKtp|fotoSim|fotoStnk|ktp|sim|stnk|bank|bankName|accountName|accountNumber|accountNo|serviceType|businessName|businessType|ownerName|role|village|district|city|province|openTime|closeTime|operationalDays|legalStatus|socialMedia)\b/g;
    while ((m = jsFields.exec(source))) out.push(m[1]);
  }
  return [...new Set(out)];
}

function sourceLines(source) {
  return String(source || "").split(/\r?\n/);
}

function lineOf(source, offset) {
  return String(source || "").slice(0, Math.max(0, offset)).split(/\r?\n/).length;
}


function normalizeLocalRef(ref, fromFile = "") {
  let value = String(ref || "").trim();
  if (!value || /^(https?:|data:|blob:|javascript:|#)/i.test(value)) return null;
  value = value.split(/[?#]/)[0];
  if (!value) return null;
  try {
    const base = new URL(`https://medicine.local/${fromFile || "index.html"}`);
    const url = new URL(value, base);
    value = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  } catch {}
  value = value.replace(/^\.\//, "");
  return REGISTRY[value] ? value : null;
}

function extractDependencies(fileName, source) {
  const out = new Set();
  if (!source) return [];
  let m;
  const patterns = [
    /<script[^>]+(?:src|data-src)=["']([^"']+)["']/gi,
    /(?:import|export)\s+(?:[^"']+?\s+from\s+)?["']([^"']+)["']/g,
    /import\s*\(\s*["']([^"']+)["']\s*\)/g,
    /(?:fetch|navigator\.serviceWorker\.register)\s*\(\s*["']([^"']+)["']/g
  ];
  for (const re of patterns) {
    while ((m = re.exec(source))) {
      const normalized = normalizeLocalRef(m[1], fileName);
      if (normalized && normalized !== fileName) out.add(normalized);
    }
  }
  return [...out];
}

function dependencyGraph(results) {
  const graph = {};
  for (const [name, data] of Object.entries(results || {})) graph[name] = extractDependencies(name, data?.text || "");
  return graph;
}

function dependencyClosure(root, graph, maxDepth = 5) {
  const out = [];
  const seen = new Set([root]);
  const queue = [{ file: root, depth: 0 }];
  while (queue.length) {
    const { file, depth } = queue.shift();
    if (depth >= maxDepth) continue;
    for (const dep of graph[file] || []) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      out.push({ file: dep, depth: depth + 1, via: file });
      queue.push({ file: dep, depth: depth + 1 });
    }
  }
  return out;
}

function findAssignmentOperations(fileName, source, signature = "") {
  if (!source) return [];
  const ops = [];
  const wantsText = /textcontent|innerhtml|value|classlist|style/i.test(signature) || /cannot set properties of null|cannot read properties of null/i.test(signature);
  if (!wantsText) return ops;

  const direct = [
    /(?:document\.getElementById|document\.querySelector|\$)\(\s*["']([^"']+)["']\s*\)\s*\.textContent\s*=\s*([^;\n]+);?/g,
    /(?:document\.getElementById|document\.querySelector|\$)\(\s*["']([^"']+)["']\s*\)\s*\.innerHTML\s*=\s*([^;\n]+);?/g,
    /(?:document\.getElementById|document\.querySelector|\$)\(\s*["']([^"']+)["']\s*\)\s*\.value\s*=\s*([^;\n]+);?/g
  ];
  for (const re of direct) {
    let m;
    while ((m = re.exec(source)) && ops.length < 30) {
      const property = /innerHTML/.test(m[0]) ? "innerHTML" : /\.value\s*=/.test(m[0]) ? "value" : "textContent";
      const before = m[0];
      const accessor = before.match(/(?:document\.getElementById|document\.querySelector|\$)\([^)]*\)/)?.[0];
      if (!accessor) continue;
      const rhs = m[2];
      const after = `{ const __medicineEl = ${accessor}; if (__medicineEl) __medicineEl.${property} = ${rhs}; }`;
      ops.push({ type: "REPLACE_EXACT", file: fileName, selector: m[1], property, line: lineOf(source, m.index), before, after, reason: `Guard DOM reference '${m[1]}' before assigning ${property}.` });
    }
  }

  // Pre-bound element pattern: const el = document.getElementById('x'); ... el.textContent = ...
  const bindRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(document\.getElementById|document\.querySelector|\$)\(\s*(["'])([^"']+)\3\s*\)\s*;?([\s\S]{0,900}?)(?:\1\s*\.textContent\s*=\s*([^;\n]+);?)/g;
  let b;
  while ((b = bindRe.exec(source)) && ops.length < 40) {
    const whole = b[0];
    const varName = b[1];
    const rhs = b[6];
    const assignIndex = whole.lastIndexOf(`${varName}.textContent`);
    if (assignIndex < 0 || !rhs || whole.includes(`if (${varName})`)) continue;
    const assignmentLine = lineOf(source, b.index + assignIndex);
    const assignment = `${varName}.textContent = ${rhs};`;
    const after = `${whole.slice(0, assignIndex)}if (${varName}) ${assignment}`;
    ops.push({ type: "REPLACE_EXACT", file: fileName, selector: b[4], property: "textContent", line: assignmentLine, before: assignment, after, reason: `Guard bound DOM reference '${b[4]}' before assigning textContent.` });
  }
  return ops;
}

function domAssignmentCandidates(fileName, source) {
  if (!source) return [];
  const out = [];
  const patterns = [
    /(?:document\.getElementById\(\s*["']([^"']+)["']\s*\)|\$\(\s*["']([^"']+)["']\s*\))\s*\.textContent\s*=\s*([^;\n]+);?/g,
    /(?:document\.querySelector\(\s*["']([^"']+)["']\s*\)|\$\(\s*["']([^"']+)["']\s*\))\s*\.innerHTML\s*=\s*([^;\n]+);?/g
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(source)) && out.length < 40) {
      const before = m[0];
      out.push({
        file: fileName,
        selector: m[1] || m[2] || "",
        property: /innerHTML/.test(before) ? "innerHTML" : "textContent",
        before,
        line: lineOf(source, m.index),
        index: m.index
      });
    }
  }
  return out;
}

function htmlHasElement(source, id) {
  if (!source || !id) return false;
  const raw = String(id).trim();
  const candidates = [raw, raw.replace(/^#/, "")];
  return candidates.some(value => {
    if (!value || /[.\s\[\]>:+~]/.test(value)) return false;
    const q = escRegExp(value);
    return new RegExp(`(?:id|name)\s*=\s*["']${q}["']`, "i").test(source);
  });
}

function extractRuntimeLocation(signature) {
  const s = String(signature || "");
  const out = [];
  const re = /(?:https?:\/\/[^\s)]+\/)?([^\s()/:]+\.(?:html|js))(?::(\d+))?(?::(\d+))?/gi;
  let m;
  while ((m = re.exec(s))) out.push({ file: m[1], line: m[2] ? Number(m[2]) : null, col: m[3] ? Number(m[3]) : null });
  return out;
}

function loadedByPages(scriptFile, htmlResults) {
  const out = [];
  for (const [name, data] of Object.entries(htmlResults || {})) {
    if (!/\.html$/i.test(name) || !data?.text) continue;
    if (extractDependencies(name, data.text).includes(scriptFile)) out.push(name);
  }
  return out;
}

function selectorFromSignature(signature, source) {
  const s = safeLower(signature);
  const ids = [];
  const re = /(?:getelementbyid|queryselector|\$)\s*\(\s*["']([^"']+)["']\s*\)/gi;
  let m;
  while ((m = re.exec(signature || ""))) ids.push(m[1]);
  for (const c of domAssignmentCandidates("runtime", source || "")) if (c.selector) ids.push(c.selector);
  return [...new Set(ids.filter(Boolean))].find(id => s.includes(safeLower(id))) || ids[0] || null;
}

function exactDomEvidence(fileName, source, signature, context = {}) {
  const out = [];
  const runtimeLocations = context.runtimeLocations || [];
  const htmlResults = context.htmlResults || {};
  const loadedBy = context.loadedBy || [];
  const assignments = findAssignmentOperations(fileName, source, signature);
  const accesses = assignments.length ? assignments : domAssignmentCandidates(fileName, source);

  for (const c of accesses) {
    const selector = c.selector;
    if (!selector) continue;
    const sameDoc = /\.html$/i.test(fileName) ? htmlHasElement(source, selector) : null;
    const runtimeHit = runtimeLocations.some(x => x.file && safeLower(x.file) === safeLower(fileName) && (!x.line || Number(x.line) === Number(c.line)));
    const signatureHit = safeLower(signature).includes(safeLower(selector));
    let strength = "LOW";
    let reason = `Reference DOM '${selector}' ditemukan pada ${fileName}, tetapi hubungan dengan runtime belum terbukti.`;

    // HIGH is reserved for a causally correlated failure. A missing DOM target
    // somewhere in the loaded surface is not enough: it can be an intentional
    // page-specific renderer or an unrelated assignment. The runtime location
    // (or an explicit selector in the runtime signature) must correlate with the
    // exact source operation before evidence can become HIGH.
    const runtimeCorrelated = runtimeHit || signatureHit;
    const missingOnLoadedPage = loadedBy.some(page => htmlHasElement(htmlResults[page]?.text || "", selector) === false);
    if (sameDoc === false && runtimeCorrelated) {
      strength = "HIGH";
      reason = `Reference DOM '${selector}' digunakan di ${fileName}, target DOM tidak ditemukan, dan lokasi/signature runtime berkorelasi dengan operasi exact.`;
    } else if (loadedBy.length) {
      const missingPages = loadedBy.filter(page => htmlHasElement(htmlResults[page]?.text || "", selector) === false);
      if (missingPages.length && runtimeCorrelated) {
        strength = "HIGH";
        reason = `Script ${fileName} dipakai oleh ${missingPages.join(', ')}; target DOM '${selector}' hilang pada halaman pemakai dan runtime berkorelasi dengan operasi exact.`;
      } else if (runtimeCorrelated) {
        strength = "MEDIUM";
        reason = `Script ${fileName} dipakai oleh ${loadedBy.join(', ')} dan runtime berkorelasi dengan reference '${selector}', tetapi bukti target DOM belum cukup untuk HIGH.`;
      } else if (missingPages.length) {
        strength = "LOW";
        reason = `Target DOM '${selector}' hilang pada ${missingPages.join(', ')}, tetapi belum ada korelasi runtime yang membuktikan assignment ini sebagai penyebab.`;
      }
    } else if (runtimeCorrelated) {
      strength = "MEDIUM";
      reason = `Lokasi source ${fileName}:${c.line} berkorelasi dengan evidence runtime, tetapi bukti DOM belum lengkap.`;
    }

    out.push({ ...c, existsInSameDocument: sameDoc, missingOnLoadedPage, stackHit: runtimeHit, signatureHit, evidenceStrength: strength, evidenceReason: reason, loadedBy });
  }
  return out;
}

async function buildSourceEvidence(targetFile, signature) {
  const names = [...new Set([...Object.keys(REGISTRY), ...SOURCE_SURFACE])];
  const evidence = [];
  const runtimeLocations = extractRuntimeLocation(signature);
  const results = {};
  for (const name of names) results[name] = await fetchFile(name);
  const graph = dependencyGraph(results);

  const htmlPages = names.filter(n => /\.html$/i.test(n));
  const priority = [];
  const pushPriority = (file, reason = "direct") => {
    if (!REGISTRY[file] || priority.some(x => x.file === file)) return;
    priority.push({ file, reason });
  };
  pushPriority(targetFile, "target");
  if (/\.html$/i.test(targetFile)) {
    for (const dep of dependencyClosure(targetFile, graph, 6)) pushPriority(dep.file, `dependency:${dep.via}`);
  }
  for (const loc of runtimeLocations) pushPriority(normalizeLocalRef(loc.file) || loc.file, "runtime");
  for (const page of htmlPages) {
    for (const dep of dependencyClosure(page, graph, 4)) pushPriority(dep.file, `page-dependency:${page}`);
  }
  for (const name of names) pushPriority(name, "surface");

  for (const item of priority) {
    const name = item.file;
    const x = results[name];
    if (!x?.ok || !x.text) continue;
    const loadedBy = /\.js$/i.test(name) ? loadedByPages(name, results) : [];
    const local = exactDomEvidence(name, x.text, signature, { runtimeLocations, htmlResults: results, loadedBy });
    for (const ev of local) {
      const dependencyHit = item.reason.startsWith("dependency") || item.reason.startsWith("page-dependency");
      const score = { HIGH: 3, MEDIUM: 2, LOW: 1 }[ev.evidenceStrength] + (dependencyHit ? 1 : 0) + (ev.stackHit ? 1 : 0) + (ev.signatureHit ? 1 : 0);
      evidence.push({ ...ev, dependencyReason: item.reason, _score: score });
    }
  }

  evidence.sort((a, b) => (b._score - a._score) || ({HIGH:3,MEDIUM:2,LOW:1}[b.evidenceStrength] - {HIGH:3,MEDIUM:2,LOW:1}[a.evidenceStrength]) || (a.line - b.line));
  return evidence.slice(0, 30).map(({ _score, ...e }) => e);
}

function exactProofForPlan(plan) {
  const p = plan || {};
  const ops = Array.isArray(p.operations) ? p.operations : [];
  const evidence = Array.isArray(p.sourceEvidence) ? p.sourceEvidence : [];
  if (!ops.length || p.precisionGate !== true) return { ok: false, reason: "NO_EXACT_OPERATION_OR_GATE" };
  if (!p.rootCauseFile || !p.rootCauseStatus) return { ok: false, reason: "ROOT_CAUSE_UNPROVEN" };
  if (!["CONFIRMED_ORIGINAL_TARGET", "TARGET_CORRECTED_BY_MEDICINE", "CONTRACT_ROOT_CAUSE_IDENTIFIED"].includes(p.rootCauseStatus)) {
    return { ok: false, reason: "ROOT_CAUSE_STATUS_NOT_PROVEN" };
  }

  for (const op of ops) {
    if (op.type !== "REPLACE_EXACT" || !op.file || op.file !== p.rootCauseFile || !op.before || !op.after || !Number.isFinite(Number(op.line))) {
      return { ok: false, reason: "OPERATION_NOT_EXACT" };
    }
    const matches = evidence.filter(e => e.file === op.file && Number(e.line) === Number(op.line));
    if (!matches.some(e => e.evidenceStrength === "HIGH" && String(e.before || "") === String(op.before))) {
      return { ok: false, reason: "HIGH_EVIDENCE_NOT_BOUND_TO_OPERATION" };
    }
    // For DOM-null cases, HIGH evidence must carry the actual runtime correlation
    // and prove that the referenced DOM is absent. This prevents a generic missing
    // selector on another page from becoming a false root cause.
    if (p.diagnosis?.code === "DOM_NULL_REFERENCE") {
      const domProof = matches.find(e => e.evidenceStrength === "HIGH" && e.stackHit === true && (e.existsInSameDocument === false || e.missingOnLoadedPage === true));
      if (!domProof) return { ok: false, reason: "DOM_CAUSALITY_NOT_PROVEN" };
    }
  }
  return { ok: true, reason: null };
}

async function validateExactOperationsAgainstSource(plan) {
  const p = plan || {};
  const ops = Array.isArray(p.operations) ? p.operations : [];
  if (!ops.length) return false;
  for (const op of ops) {
    if (op.type !== "REPLACE_EXACT" || !op.file || !Number.isFinite(Number(op.line))) return false;
    const src = await fetchFile(op.file);
    if (!src.ok || !src.text) return false;
    const lines = sourceLines(src.text);
    const actualLine = lines[Number(op.line) - 1] ?? "";
    if (!actualLine.includes(String(op.before))) return false;
    const occurrence = src.text.indexOf(String(op.before));
    if (occurrence < 0 || lineOf(src.text, occurrence) !== Number(op.line)) return false;
  }
  return true;
}

async function resolveRootCause(c) {
  const originalTarget = c.source;
  const runtimeLocations = [
    ...extractRuntimeLocation(c.signature),
    ...(c.runtimeLocation?.file ? [{ file: c.runtimeLocation.file, line: c.runtimeLocation.line, col: c.runtimeLocation.col }] : []),
    ...extractRuntimeLocation(c.runtimeLocation?.stack || "")
  ];
  const candidates = await buildSourceEvidence(originalTarget, c.signature);
  const high = candidates.filter(x => x.evidenceStrength === "HIGH");

  // For a DOM-null error, prefer a source assignment whose script is actually loaded
  // by the reported page and whose selector is absent there. This is stronger than
  // simply blaming the file named by telemetry.
  if (c.diagnosis.code === "DOM_NULL_REFERENCE") {
    // A DOM-null root cause is proven only when the runtime points to the exact
    // assignment (file + line) and the consuming HTML page demonstrably lacks the
    // referenced target. Missing DOM elsewhere is not causal proof.
    const causalHigh = high.filter(x => x.stackHit === true && x.loadedBy?.length && x.evidenceStrength === "HIGH");
    const best = causalHigh.find(x => x.file === originalTarget)
      || causalHigh.find(x => x.loadedBy?.some(p => p === originalTarget))
      || causalHigh[0];
    if (best) {
      const src = await fetchFile(best.file);
      const ops = findLikelyDomBinding(best.file, src.text, c.signature)
        .filter(op => Number(op.line) === Number(best.line) && op.selector === best.selector);
      const exactOperation = ops[0] || null;
      if (exactOperation) {
        return {
          rootCauseFile: best.file,
          rootCauseStatus: best.file === originalTarget ? "CONFIRMED_ORIGINAL_TARGET" : "TARGET_CORRECTED_BY_MEDICINE",
          sourceEvidence: candidates.slice(0, 18).map(e => ({ file:e.file, selector:e.selector, property:e.property, line:e.line, before:e.before, evidenceStrength:e.evidenceStrength, reason:e.evidenceReason, loadedBy:e.loadedBy || [], dependencyReason:e.dependencyReason, stackHit:e.stackHit === true, existsInSameDocument:e.existsInSameDocument })),
          resolvedOperation: exactOperation,
          candidates: candidates.slice(0, 18)
        };
      }
    }
    return { rootCauseFile: originalTarget, rootCauseStatus: "UNPROVEN", sourceEvidence: candidates.slice(0, 18), resolvedOperation: null, candidates: candidates.slice(0, 18) };
  }

  if (c.diagnosis.code === "DATA_CONSISTENCY") {
    const scan = await scanConsistency();
    const relevant = scan.findings.filter(f => f.kind === "ADMIN_PRESENTATION_GAP" || f.kind === "SOURCE_CONTRACT_GAP");
    const gap = relevant.find(f => f.sourceFile === originalTarget) || relevant.find(f => f.targetFile === originalTarget) || null;
    if (gap) {
      return {
        rootCauseFile: gap.kind === "ADMIN_PRESENTATION_GAP" ? (gap.targetFile || "bcgo-admin.html") : (gap.sourceFile || originalTarget),
        rootCauseStatus: "CONTRACT_ROOT_CAUSE_IDENTIFIED",
        sourceEvidence: [{ file: gap.sourceFile, targetFile: gap.targetFile, missing: gap.missing || [], evidenceStrength: "HIGH", reason: `Kontrak sumber ${gap.sourceFile} memiliki field yang belum dipetakan secara konsisten ke ${gap.targetFile || 'target'}.` }],
        resolvedOperation: null,
        candidates: relevant.slice(0, 12)
      };
    }
  }

  // For non-DOM cases, a strong runtime-correlated source may still identify the root.
  const correlated = candidates.find(x => x.evidenceStrength === "HIGH" && (x.stackHit || x.signatureHit));
  if (correlated) {
    const src = await fetchFile(correlated.file);
    const ops = findLikelyDomBinding(correlated.file, src.text, c.signature).filter(op => Number(op.line) === Number(correlated.line));
    return {
      rootCauseFile: correlated.file,
      rootCauseStatus: "TARGET_CORRECTED_BY_MEDICINE",
      sourceEvidence: candidates.slice(0, 18),
      resolvedOperation: ops[0] || null,
      candidates: candidates.slice(0, 18)
    };
  }

  return { rootCauseFile: originalTarget, rootCauseStatus: "UNPROVEN", sourceEvidence: candidates.slice(0, 18), resolvedOperation: null, candidates: candidates.slice(0, 18) };
}

function findDomNullOperations(fileName, source, signature) {
  return findAssignmentOperations(fileName, source, signature).filter(op => /textContent/i.test(op.property || ""));
}

function findLikelyDomBinding(fileName, source, signature) {
  return findAssignmentOperations(fileName, source, signature);
}

function buildAdminGapOperations(targetFile, missingFields, adminSource) {
  if (targetFile !== "bcgo-admin.html" || !adminSource || !missingFields?.length) return [];
  const source = String(adminSource);
  const operations = [];
  const labels = {
    photo:"Foto Profil", photoFront:"Foto Depan", vehicleType:"Jenis Kendaraan", serviceType:"Jenis Layanan",
    ktp:"Nomor KTP", sim:"Nomor SIM", stnk:"Nomor STNK", bank:"Bank / E-Wallet", bankName:"Bank / E-Wallet",
    accountName:"Nama Rekening", accountNo:"Nomor Rekening / Akun", accountNumber:"Nomor Rekening / Akun",
    socialMedia:"Media Sosial", name:"Nama", phone:"Telepon", address:"Alamat", email:"Email"
  };
  const valueExpr = f => {
    const alias = FIELD_ALIASES[f]?.[0] || f;
    return `data.${alias} || '-'`;
  };

  // Find an existing detail-row in the Admin renderer. The patch is allowed only as
  // an exact insertion next to an existing renderer block; Medicine never fabricates
  // a new renderer/function or rewrites unrelated code.
  const rowRe = /<div\s+class=["']detail-row["'][\s\S]*?<\/div>\s*\n?/gi;
  const rows = [...source.matchAll(rowRe)];
  if (!rows.length) return [];
  const anchor = rows.find(m => /Kontak|Nama|Alamat|Kendaraan|Rekening/i.test(m[0])) || rows[0];
  const marker = anchor[0];
  const line = lineOf(source, anchor.index);

  const blocks = missingFields.slice(0, 6).map(rawField => {
    const field = FIELD_ALIASES[rawField] ? rawField : rawField;
    const label = labels[field] || field.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());
    return `\n\n            <div class="detail-row">\n                <span class="detail-label">\n                    ${label}\n                </span>\n                <span class="detail-value">\n                    \${${valueExpr(field)}}\n                </span>\n            </div>`;
  });
  if (blocks.length) operations.push({
    type:"REPLACE_EXACT", file:targetFile, line, before:marker, after:marker + blocks.join(''),
    reason:`Tambahkan ${blocks.length} field kontrak yang benar-benar hilang pada renderer Admin melalui satu replacement exact.`
  });
  return operations;
}

async function scanConsistency(targets = null) {
  const names = targets?.length ? targets.filter(n => REGISTRY[n]) : Object.keys(REGISTRY);
  emit("scan_started", { total: names.length, targets: names });
  const result = {};
  for (const name of names) {
    const x = await fetchFile(name);
    result[name] = { ...x, fields: fields(name, x.text) };
  }

  const findings = [];
  const admin = new Set((result["bcgo-admin.html"]?.fields || []).map(safeLower));

  for (const [type, req] of Object.entries(REQUIRED)) {
    const source = type === "driver" ? "driver.html" : type === "restaurant" ? "resto.html" : type === "assistant" ? "agentcgo.html" : "index.html";
    if (!result[source]?.ok) continue;
    const sf = canonicalFieldSet(result[source].fields || []);
    const missing = req.filter(x => !sf.has(x) && !(FIELD_ALIASES[x] || []).some(a => sf.has(a)));
    if (missing.length) findings.push({ kind: "SOURCE_CONTRACT_GAP", sourceFile: source, missing });
  }

  const sources = ["driver.html", "resto.html", "agentcgo.html", "index.html", "food.html", "ride.html"];
  for (const source of sources) {
    if (!result[source]?.ok || !result["bcgo-admin.html"]?.ok) continue;
    const sf = [...canonicalFieldSet(result[source].fields || [])].filter(x => CONTRACT_FIELDS.has(x) || Object.values(FIELD_ALIASES).flat().includes(x));
    const adminCanonical = canonicalFieldSet(result["bcgo-admin.html"].fields || []);
    const missing = sf.filter(x => !adminCanonical.has(x) && !(FIELD_ALIASES[x] || []).some(a => adminCanonical.has(a)));
    if (missing.length) findings.push({ kind: "ADMIN_PRESENTATION_GAP", sourceFile: source, targetFile: "bcgo-admin.html", missing });
  }

  // Detect known DOM-null patterns directly from deployed source, not only telemetry.
  for (const name of names) {
    const source = result[name]?.text || "";
    const directNullRisk = /\$\(\s*["'][^"']+["']\s*\)\.textContent\s*=|document\.getElementById\(\s*["'][^"']+["']\s*\)\.textContent\s*=/.test(source);
    if (directNullRisk) {
      const evs = exactDomEvidence(name, source, "");
      for (const ev of evs) {
        // Existing DOM targets are not findings by themselves. Only missing targets
        // are promoted; correlated runtime evidence remains visible as MEDIUM/HIGH.
        if (ev.evidenceStrength === "HIGH" || ev.stackHit || ev.signatureHit) {
          findings.push({ kind: "DOM_ASSIGNMENT_RISK", sourceFile: name, targetFile: name, selector: ev.selector, line: ev.line, evidenceStrength: ev.evidenceStrength, detail: ev.evidenceReason });
        }
      }
    }
  }

  S.findings = findings;
  emit("scan_complete", { results: result, findings });
  return { results: result, findings };
}


function getSourceContext(source, line, radius = 4) {
  const lines = sourceLines(source);
  const n = Number(line);
  if (!Number.isFinite(n) || n < 1 || !lines.length) return { startLine: null, endLine: null, lines: [] };
  const start = Math.max(1, n - radius);
  const end = Math.min(lines.length, n + radius);
  return {
    startLine: start,
    endLine: end,
    lines: lines.slice(start - 1, end).map((code, i) => ({
      line: start + i,
      code
    }))
  };
}

function sourceFingerprint(value) {
  let h = 2166136261;
  for (const ch of String(value ?? "")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function operationRisk(op) {
  if (!op?.before || !op?.after) return "HIGH";
  if (op.type !== "REPLACE_EXACT") return "MEDIUM";
  if (op.before.length > 5000 || op.after.length > 7000) return "MEDIUM";
  return "LOW";
}

function buildCodePrescription(plan) {
  const p = plan || {};
  const ops = Array.isArray(p.operations) ? p.operations : [];
  const evidence = Array.isArray(p.sourceEvidence) ? p.sourceEvidence : [];
  const items = ops.slice(0, 12).map((op, index) => {
    const ev = evidence.find(e =>
      e?.file === op.file &&
      (e?.line == null || op.line == null || Number(e.line) === Number(op.line))
    ) || evidence.find(e => e?.file === op.file);

    const context = p._sourceContext?.[index] || null;
    return {
      index,
      file: op.file || null,
      line: op.line ?? null,
      type: op.type || "REPLACE_EXACT",
      before: String(op.before || ""),
      after: String(op.after || ""),
      reason: text(op.reason || "Perubahan diturunkan dari source evidence.", 1200),
      evidenceStrength: ev?.evidenceStrength || "UNVERIFIED",
      evidenceReason: text(ev?.reason || ev?.evidenceReason || "", 1400),
      context,
      risk: operationRisk(op),
      beforeHash: sourceFingerprint(op.before),
      afterHash: sourceFingerprint(op.after)
    };
  });

  const exact = items.length > 0 &&
    items.every(x => x.type === "REPLACE_EXACT" && x.before && x.after);
  const proof = exactProofForPlan(p);
  const ready = !!(p.precisionGate === true && exact && proof.ok);

  return {
    ready,
    status: ready ? "READY_TO_COPY" : "REVIEW_REQUIRED",
    targetFile: p.rootCauseFile || p.target || null,
    rootCauseStatus: p.rootCauseStatus || "UNPROVEN",
    evidenceCount: evidence.length,
    items,
    instruction: ready
      ? "Solusi berasal dari operasi exact yang terikat pada HIGH source evidence dan current deployed source. Review BEFORE/AFTER lalu copy secara manual."
      : `Medicine belum dapat membuka copy gate: ${proof.reason || "exact proof belum lengkap"}.`
  };
}

async function attachPrescription(plan) {
  const p = plan || {};
  p._sourceContext = {};
  for (let i = 0; i < (p.operations || []).length; i++) {
    const op = p.operations[i];
    if (!op?.file || !op?.line) continue;
    const src = await fetchFile(op.file);
    p._sourceContext[i] = src.ok ? getSourceContext(src.text, op.line, 4) : null;
  }
  p.codePrescription = buildCodePrescription(p);
  return p;
}

function buildRepairPlan(c, verification) {
  const d = c.diagnosis;
  const target = c.source;
  const plan = {
    planId: `REPAIR-${uid().toUpperCase()}`,
    caseId: c.id,
    target,
    diagnosis: d,
    verification,
    strategy: "MINIMAL_SAFE_CHANGE",
    operations: [],
    beforeAfter: [],
    preconditions: [],
    postconditions: [
      "Original runtime signature must no longer recur for the target.",
      "Target must remain loadable.",
      "Cross-file contract check must pass for the repaired path.",
      "The exact BEFORE text must be absent and the exact AFTER text must be present after execution."
    ],
    sourceWrite: false,
    precision: { exactTargetRequired: true, exactEvidenceRequired: true, exactOperationRequired: true, noGuessing: true, crossFileProofRequired: true },
    status: "PROPOSED",
    requiresHumanApproval: true,
    requiresPostValidation: true,
    createdAt: now()
  };

  if (d.code === "DOM_NULL_REFERENCE") {
    plan.preconditions.push("An exact source location must be proven by high-confidence evidence; a generic runtime message alone is insufficient.");
    plan.preconditions.push("The referenced DOM target must be proven missing/mismatched before a DOM guard is proposed.");
    plan.preconditions.push("Executor must apply exact replacements only; no broad search-and-replace.");
  } else if (d.code === "DATA_CONSISTENCY") {
    plan.preconditions.push("Source and target contract evidence must identify the exact missing or mismatched field.");
    plan.preconditions.push("A real existing renderer/mapping location must be identified before any UI patch is proposed.");
    plan.preconditions.push("Medicine must not invent a presentation bridge as a substitute for the missing implementation.");
  } else if (d.code === "REALTIME_CONNECTIVITY") {
    plan.preconditions.push("Authentication and Firestore rules must remain authoritative; Medicine will not bypass permissions.");
  } else {
    plan.preconditions.push("Root cause must be supported by runtime or source evidence before execution.");
  }

  return plan;
}

async function enrichRepairPlan(c, verification) {
  const plan = buildRepairPlan(c, verification);
  const resolution = await resolveRootCause(c);
  plan.originalTarget = c.source;
  plan.rootCauseFile = resolution.rootCauseFile || c.source;
  plan.rootCauseStatus = resolution.rootCauseStatus || "UNPROVEN";
  plan.candidates = resolution.candidates || [];
  plan.sourceEvidence = resolution.sourceEvidence || [];

  if (c.diagnosis.code === "DOM_NULL_REFERENCE") {
    if (resolution.resolvedOperation && (resolution.sourceEvidence || []).some(e => e.evidenceStrength === "HIGH" && e.line === resolution.resolvedOperation.line)) {
      plan.operations.push(resolution.resolvedOperation);
    }
  }

  if (c.diagnosis.code === "DATA_CONSISTENCY") {
    const adminSource = await fetchFile("bcgo-admin.html");
    const targetFindings = verification?.targetFindings || [];
    const gap = targetFindings.find(f => f.kind === "ADMIN_PRESENTATION_GAP");
    if (gap) {
      const ops = buildAdminGapOperations("bcgo-admin.html", gap.missing || [], adminSource.text);
      plan.operations.push(...ops);
      for (const op of ops) {
        plan.sourceEvidence.push({
          file: op.file,
          line: op.line,
          before: op.before,
          evidenceStrength: "HIGH",
          reason: `Operation exact diikat ke renderer ${op.file}:${op.line}; kontrak ${gap.sourceFile || "source"} -> ${gap.targetFile || "target"} menunjukkan field ${Array.isArray(gap.missing) ? gap.missing.join(", ") : "yang hilang"}.`,
          contractSourceFile: gap.sourceFile || null,
          contractTargetFile: gap.targetFile || null,
          missing: gap.missing || []
        });
      }
    }
  }

  for (const op of plan.operations) {
    if (op.type === "REPLACE_EXACT") plan.beforeAfter.push({ file: op.file, line: op.line || null, before: op.before, after: op.after });
    if (op.type === "INSERT_BEFORE") plan.beforeAfter.push({ file: op.file, line: null, before: op.marker, after: `${op.marker}\n${op.content}` });
  }

  // The gate is evaluated in two stages: evidence causality and current deployed
  // source. A HIGH score by itself is never enough. The exact BEFORE must still be
  // present at the exact line in the fetched source, and every operation must bind
  // to its own HIGH evidence.
  plan.precisionGate = false;
  const sourceExact = await validateExactOperationsAgainstSource(plan);
  plan.precisionGate = sourceExact;
  const proof = exactProofForPlan(plan);
  if (sourceExact && proof.ok) {
    plan.status = "PROPOSED";
    plan.blockReason = null;
  } else {
    plan.status = "PATCH_REQUIRES_REVIEW";
    plan.precisionGate = false;
    plan.blockReason = `PRECISION GATE: ${proof.reason || "EXACT_SOURCE_NOT_CONFIRMED"}. Source tidak akan diubah berdasarkan tebakan.`;
  }
  return attachPrescription(plan);
}

function canApprove(c) {
  const v = c?.verification;
  const plan = c?.repairPlan;
  if (!c || !v || c.status !== "VERIFIED_DIAGNOSIS") return false;
  if (v.verdict !== "SUPPORTED_BY_EXACT_SOURCE_EVIDENCE") return false;
  return exactProofForPlan(plan).ok;
}

function canApplyPatch(c) {
  return !!(
    c && c.status === "READY_FOR_PATCH" &&
    c.verification?.verdict === "SUPPORTED_BY_EXACT_SOURCE_EVIDENCE" &&
    exactProofForPlan(c.repairPlan).ok
  );
}

function executorAvailable() {
  return typeof window.BCGOPatchExecutor?.apply === "function";
}

function findProposal(caseId) {
  return S.patchProposals.find(p => p.caseId === caseId && ["PROPOSED", "READY_FOR_PATCH", "APPLY_REQUESTED", "APPLIED"].includes(p.status)) || null;
}

async function verifyWithMedicine(targetFile = null, context = {}) {
  const requestedTarget = targetFile && REGISTRY[targetFile] ? targetFile : (S.activeCase?.source || "bcgo-admin.html");
  emit("verification_started", { target: requestedTarget, context });

  // Verify the named target plus the whole dependency surface. Medicine is not
  // allowed to stop at the first accusation; it must be able to move the target.
  const targets = Object.keys(REGISTRY);
  const result = await scanConsistency(targets);
  const logs = latestRelevantLogs(requestedTarget);
  const runtimeEvidence = logs.slice(0, 8);
  const targetFindings = result.findings.filter(f => f.sourceFile === requestedTarget || f.targetFile === requestedTarget);

  let v = {
    requestedTarget,
    target: requestedTarget,
    verdict: "INSUFFICIENT_EVIDENCE",
    targetFindings,
    runtimeEvidence,
    checkedFiles: targets,
    checkedCount: targets.length,
    checkedAt: now(),
    question: context.question || null,
    rootCauseFile: requestedTarget,
    rootCauseStatus: "UNPROVEN",
    rootCauseCandidates: []
  };

  if (S.activeCase && (!targetFile || S.activeCase.source === requestedTarget)) {
    S.activeCase.verification = v;
    const resolution = await resolveRootCause(S.activeCase);
    v.rootCauseFile = resolution.rootCauseFile || requestedTarget;
    v.rootCauseStatus = resolution.rootCauseStatus || "UNPROVEN";
    v.rootCauseCandidates = resolution.candidates || [];
    v.sourceEvidence = resolution.sourceEvidence || [];
    S.activeCase.repairPlan = await enrichRepairPlan(S.activeCase, v);
    S.activeCase.rootCauseFile = S.activeCase.repairPlan.rootCauseFile || requestedTarget;
    S.activeCase.sourceEvidence = S.activeCase.repairPlan.sourceEvidence || [];

    const plan = S.activeCase.repairPlan;
    const proof = exactProofForPlan(plan);
    const exactProof = plan.precisionGate === true && proof.ok;
    if (!exactProof && plan.blockReason == null) {
      plan.blockReason = `PRECISION GATE: ${proof.reason || "EXACT_SOURCE_NOT_CONFIRMED"}.`;
    }
    v.verdict = exactProof ? "SUPPORTED_BY_EXACT_SOURCE_EVIDENCE"
      : (v.rootCauseStatus === "CONTRACT_ROOT_CAUSE_IDENTIFIED" ? "ROOT_CAUSE_IDENTIFIED_PATCH_BLOCKED" : "INSUFFICIENT_EVIDENCE");
    v.target = v.rootCauseFile || requestedTarget;
    S.verification = v;
    S.activeCase.verification = v;
    S.activeCase.status = exactProof ? "VERIFIED_DIAGNOSIS" : "NEEDS_EVIDENCE";
    S.activeCase.prescription = prescription(S.activeCase.diagnosis);
    emit("case_updated", { case: S.activeCase });

    const proposal = {
      proposalId: `PATCH-${uid().toUpperCase()}`,
      caseId: S.activeCase.id,
      telemetryTarget: S.activeCase.source,
      originalTarget: requestedTarget,
      repairTarget: plan.rootCauseFile,
      rootCauseStatus: plan.rootCauseStatus,
      diagnosis: S.activeCase.diagnosis,
      verification: v,
      repairPlan: plan,
      operations: plan.operations,
      beforeAfter: plan.beforeAfter,
      status: exactProof ? "PROPOSED" : "PATCH_REQUIRES_REVIEW",
      sourceWrite: false,
      requiresHumanApproval: true,
      requiresPostValidation: true,
      precisionGate: exactProof,
      createdAt: now()
    };
    S.patchProposals.unshift(proposal);
    S.patchProposals = S.patchProposals.slice(0, 40);
    S.activeCase.patchProposal = proposal;
    emit("patch_proposed", { proposal, case: S.activeCase });
  } else {
    // No active case: perform an independent scan and report only evidence,
    // never promote a target to a repairable diagnosis from a guess.
    const synthetic = { source: requestedTarget, signature: runtimeEvidence[0]?.message || "", diagnosis: diagnosis(runtimeEvidence[0]?.message || "") };
    const resolution = await resolveRootCause(synthetic);
    v.rootCauseFile = resolution.rootCauseFile || requestedTarget;
    v.rootCauseStatus = resolution.rootCauseStatus || "UNPROVEN";
    v.sourceEvidence = resolution.sourceEvidence || [];
    v.rootCauseCandidates = resolution.candidates || [];
    if (v.rootCauseStatus === "CONTRACT_ROOT_CAUSE_IDENTIFIED") v.verdict = "ROOT_CAUSE_IDENTIFIED_PATCH_BLOCKED";
    S.verification = v;
  }

  emit("verification_complete", { verification: v });
  const message = v.verdict === "SUPPORTED_BY_EXACT_SOURCE_EVIDENCE"
    ? `Verifikasi selesai. BCGO menunjuk ${requestedTarget}, Medicine memverifikasi akar masalah pada ${v.rootCauseFile}. Evidence exact cukup; Precision Gate LULUS dan source tetap terkunci sampai persetujuan manusia.`
    : v.verdict === "ROOT_CAUSE_IDENTIFIED_PATCH_BLOCKED"
      ? `BCGO menunjuk ${requestedTarget}, tetapi Medicine menemukan akar kontrak pada ${v.rootCauseFile}. Akar sudah dipersempit, namun lokasi operasi source belum exact; patch tetap dikunci.`
      : `BCGO menunjuk ${requestedTarget}, tetapi Medicine belum dapat membuktikan lokasi akar masalah secara exact. Saya menahan treatment dan terus mempertahankan evidence chain.`;
  await postSystemMessage("medicine", message, {
    kind: "MEDICINE_PRECISION_VERIFICATION",
    target: v.rootCauseFile,
    requestedTarget,
    verdict: v.verdict,
    rootCauseStatus: v.rootCauseStatus,
    checkedFiles: targets
  });
  return v;
}

function bcgoAnswer(q) {
  // BCGO is authoritative for system status. When the exact BCGO engine is
  // running on this page, ask it directly instead of maintaining a second
  // interpretation inside Medicine.
  if (window.BCGOBrain?.ask) {
    try { return window.BCGOBrain.ask(q); } catch {}
  }
  const active = activeCases();
  const x = safeLower(q);
  const file = mentionedFile(q);
  if (/sinkron|synchron|jumlah|count|validasi|mitra|tidak sesuai|tidak sinkron/.test(x)) {
    const target = file || active[0]?.source || "bcgo-admin.html";
    const logs = latestRelevantLogs(target);
    const evidence = logs[0] ? `Evidence telemetry pada ${target}: ${text(logs[0].message || logs[0].error || "event", 420)}.` : `Belum ada telemetry spesifik untuk ${target}.`;
    return `Saya cek pertanyaan Anda. Target awal ${target}. ${evidence} Target itu belum saya anggap sebagai akar masalah. Saya minta Medicine memverifikasi seluruh jalur dan mengoreksi target bila evidence menunjuk file lain.`;
  }
  if (/apa yang.*kerja|sedang|ngerjain|mengerjakan/.test(x)) {
    return active.length
      ? `Saya sedang mengawasi ${Object.keys(REGISTRY).length} organ. Ada ${active.length} case aktif; fokus ${active[0].source} (${active[0].status}). Medicine sedang saya minta menyiapkan repair plan.`
      : `Saya sedang memantau ${Object.keys(REGISTRY).length} organ dan telemetry realtime. Belum ada case aktif.`;
  }
  if (/aman|status|sehat|normal/.test(x)) return `Status saya: ${S.logs.length} telemetry log, ${active.length} case aktif, ${S.findings.length} finding. Saya tidak menyatakan aman tanpa evidence.`;
  if (/masalah|error|kendala|rusak|anomal/.test(x)) return active.length ? `Ya. Ada ${active.length} case aktif. Prioritas ${active[0].source}: ${active[0].diagnosis.title}. Saya dapat menyerahkannya ke Medicine untuk pemeriksaan dan penyembuhan terkontrol.` : `Saat ini belum ada case aktif dari telemetry yang saya terima.`;
  return `Halo 👋 Saya BCGO. Saya tidak akan menjawab kaku saja—saya akan melihat keadaan saraf saat ini, menjelaskan apa yang sedang kami telusuri, dan kalau Anda memberi perintah seperti “cari akar masalah”, saya langsung membuka jalur investigasi bersama Medicine.`;
}

function medicineAnswer(q) {
  const x = safeLower(q);
  const active = activeCases();
  const file = mentionedFile(q);
  if (/sinkron|synchron|jumlah|count|validasi|mitra|tidak sesuai|tidak sinkron/.test(x)) {
    const target = file || active[0]?.source || "bcgo-admin.html";
    return `Saya akan memeriksa ${target} lintas-file: sumber data, kontrak field, engine, renderer Admin, dan telemetry. Jika akar masalah terbukti, saya ambil source exact lalu susun BEFORE → AFTER yang konkret untuk direview manusia.`;
  }
  if (/obat|perbaiki|sembuhkan|treatment|patch|tangan/.test(x)) {
    if (!S.activeCase) return "Belum ada case aktif yang bisa saya obati.";
    const plan = S.activeCase.repairPlan;
    return plan?.operations?.length
      ? `Repair plan ${plan.planId} sudah memiliki ${plan.operations.length} operasi source yang terukur. Saya menunggu persetujuan manusia sebelum executor menerapkannya.`
      : `Saya belum memiliki operasi patch yang cukup aman. Saya tidak akan memaksakan perubahan source.`;
  }
  if (/driver|foto|photo/.test(x)) return `Saya dapat membandingkan driver.html → bcgo-engine.js → bcgo-admin.html. Jika field foto ada di sumber tetapi hilang di Admin, saya akan tandai sebagai ADMIN_PRESENTATION_GAP dan membuat repair plan yang dapat diaudit.`;
  if (/ada.*(masalah|error)|kendala|rusak|sakit/.test(x)) return active.length ? `Saya menemukan ${active.length} case aktif. Target ${active[0].source}; diagnosis ${active[0].diagnosis.title}. Saya siap mencari akar masalah dan menyiapkan patch.` : `Belum ada case aktif yang cukup kuat untuk dinyatakan bermasalah.`;
  return `Halo 👋 Saya Medicine. Saya siap membedah kasus sampai source exact. Anda bisa bilang “cari penyebab utama”, “tunjukkan kode yang rusak”, atau “bawa ke ruang operasi”; saya akan menjalankan tahapnya berdasarkan evidence, bukan tebakan.`;
}

function recipient(q) {
  const x = q.trim().toLowerCase();
  if (/^(hai\s+)?bcgo\b/.test(x) || /\bbcgo[,:]/.test(x)) return "bcgo";
  if (/^(hai\s+)?medicine\b/.test(x) || /\bmedicine[,:]/.test(x)) return "medicine";
  if (/\b(bcgo|medicine)\b/.test(x)) return x.indexOf("bcgo") < x.indexOf("medicine") ? "bcgo" : "medicine";
  return "medicine";
}

function currentConversationContext() {
  const active = activeCases();
  const c = S.activeCase || active[0] || null;
  const plan = c?.repairPlan || null;
  return { active, c, plan, logs: S.logs.slice(0, 5), findings: S.findings.slice(0, 8) };
}

function autonomousThought(role) {
  const { active, c, plan, logs, findings } = currentConversationContext();
  const target = c?.repairPlan?.rootCauseFile || c?.rootCauseFile || c?.source || logs[0]?.fileName || "seluruh organ";
  const evidenceCount = c?.sourceEvidence?.length || plan?.sourceEvidence?.length || 0;
  const operations = plan?.operations?.length || 0;
  const last = logs[0]?.message || c?.signature || "belum ada impuls baru";

  if (role === "bcgo") {
    if (active.length) return `Medicine, saya menjaga ${active.length} saraf aktif. Fokus saat ini ${target}. Saya kirim impuls terbaru: ${text(last, 240)}. Jangan berhenti di nama file laporan; telusuri dependency sampai sumber yang benar terbukti.`;
    if (findings.length) return `Saya belum melihat anomali aktif, tetapi masih ada ${findings.length} finding kontrak. Saya ingin kita pelajari satu per satu supaya status HEALTHY benar-benar didukung evidence.`;
    return `Siklus tenang, tetapi saya tetap mendengarkan telemetry. Impuls terakhir: ${text(last, 240)}. Kalau ada perubahan, saya ingin Medicine langsung memeriksa jalurnya.`;
  }

  if (plan?.codePrescription?.ready) return `BCGO, saya sudah menemukan source exact pada ${target}. Ada ${operations} operasi exact dan ${evidenceCount} evidence. BEFORE → AFTER sudah terbentuk; saya tahan source tetap terkunci sampai Human Review.`;
  if (c) {
    if (evidenceCount) return `Saya sedang membedah ${target}. Saat ini saya punya ${evidenceCount} bukti source dan ${operations} operasi kandidat. Saya sedang menguji apakah selector, halaman pemakai, dan source script benar-benar saling cocok.`;
    return `Saya sedang membedah ${target}, tetapi bukti source belum cukup. Saya lanjut menelusuri dependency dan tidak akan mengarang BEFORE → AFTER.`;
  }
  return `Saya tetap belajar dari telemetry yang masuk. Belum ada case yang cukup kuat untuk ruang operasi. Saya terus mencari hubungan runtime → source → root cause.`;
}

async function autonomousConversationTick() {
  if (!S.autonomous.enabled || S.human.paused || !auth.currentUser) return;
  const turn = S.autonomous.turn++;
  const active = activeCases();
  // Every few turns the pair performs real work, not just small-talk: re-check
  // the active case or refresh the cross-file evidence surface.
  if (turn > 0 && turn % 3 === 0) {
    if (active[0]) {
      await postSystemMessage("medicine", `Saya lanjut bedah ${active[0].source}. Saya ulangi trace terhadap evidence terbaru agar jalur source → root cause tidak berhenti pada diagnosis lama.`, { kind: "AUTONOMOUS_INVESTIGATION", caseId: active[0].id, autonomous: true });
      await verifyWithMedicine(active[0].source, { question: "Autonomous re-trace: terus pelajari saraf aktif.", requestedBy: "autonomous_medicine" });
      emit("autonomous_investigation", { case: active[0] });
    } else {
      await scanConsistency();
      await postSystemMessage("bcgo", `Saya melakukan scan lintas-file lagi. Tidak ada case aktif, jadi saya gunakan waktu ini untuk mencari kontrak yang belum konsisten sebelum menjadi kendala runtime.`, { kind: "AUTONOMOUS_SCAN", autonomous: true });
      emit("autonomous_scan", { findings: S.findings });
    }
  }
  const role = turn % 2 === 0 ? "bcgo" : "medicine";
  const message = autonomousThought(role);
  S.autonomous.lastAt = Date.now();
  await postSystemMessage(role, message, { kind: "AUTONOMOUS_DISCUSSION", autonomous: true });
  emit("autonomous_chat", { role, message });
}

function startAutonomousConversation() {
  if (S.autonomous.timer) clearInterval(S.autonomous.timer);
  S.autonomous.timer = setInterval(() => autonomousConversationTick().catch(e => emit("conversation_error", { message: e.message })), 18000);
  setTimeout(() => autonomousConversationTick().catch(() => {}), 3500);
}

function stopAutonomousConversation() {
  if (S.autonomous.timer) clearInterval(S.autonomous.timer);
  S.autonomous.timer = null;
}

function isInvestigationCommand(q) {
  return /cari (penyebab|akar)|penyebab utama|akar masalah|telusuri.*(akar|saraf)|bedah|ruang operasi|operasi|before.*after|kode (rusak|bermasalah|perbaikan)|solusi kode/.test(safeLower(q));
}

async function sendMessage(msg, role = "human") {
  const t = text(msg, 1200);
  if (!t) return;
  const clientMessageId = uid();
  S.lastClientMessageId = clientMessageId;
  const payload = { role, text: t, actorUid: auth.currentUser?.uid || null, createdAt: serverTimestamp(), clientMessageId };

  try {
    await addDoc(collection(db, "medicine_messages"), payload);
  } catch (e) {
    emit("local_message", { message: { ...payload, createdAt: now() }, storageError: e.message });
  }
  if (role !== "human") return;
  if (S.human.paused) {
    await postSystemMessage("medicine", "Medicine sedang dijeda oleh manusia. Pesan diterima, tetapi diagnosis/treatment baru ditahan.", { replyTo: clientMessageId });
    return;
  }

  const target = recipient(t);
  const answer = target === "bcgo" ? bcgoAnswer(t) : medicineAnswer(t);
  await postSystemMessage(target, answer, { replyTo: clientMessageId, kind: "DIRECT_REPLY" });

  const asksMedicine = /medicine|periksa|verifikasi|pastikan|cek|sumber masalah|perbaiki|sembuhkan|patch/.test(safeLower(t));
  if (isInvestigationCommand(t)) {
    const file = mentionedFile(t) || S.activeCase?.source || activeCases()[0]?.source || null;
    await postSystemMessage("bcgo", `Baik, saya buka jalur investigasi. Saya tidak akan berhenti di target awal${file ? ` ${file}` : ""}. Medicine saya minta mencari akar masalah, source exact, lalu menyiapkan BEFORE → AFTER bila bukti memungkinkan.`, { kind: "INVESTIGATION_REQUEST", target: file, replyTo: clientMessageId });
    await verifyWithMedicine(file, { question: t, requestedBy: "human_command" });
    return;
  }
  if (target === "bcgo" && asksMedicine) {
    const file = mentionedFile(t) || activeCases()[0]?.source || null;
    await postSystemMessage("bcgo", `Saya meneruskan permintaan Anda ke Medicine${file ? ` untuk ${file}` : ""}. Medicine akan mencari akar masalah dan menyiapkan repair plan.`, {
      kind: "BCGO_TO_MEDICINE", target: file, replyTo: clientMessageId
    });
    await verifyWithMedicine(file, { question: t, requestedBy: "human_via_bcgo" });
  }
}

async function approveTreatment(caseId) {
  const c = S.cases.find(x => x.id === caseId);
  if (!c) throw new Error("Case tidak ditemukan");
  if (S.human.paused) throw new Error("Medicine sedang dijeda");
  if (!c.verification) await verifyWithMedicine(c.source, { question: "Approval requested without verification", requestedBy: "human" });
  if (!canApprove(c)) throw new Error("Treatment belum boleh disetujui: evidence belum cukup.");
  if (!c.repairPlan?.operations?.length) throw new Error("Repair plan belum memiliki operasi source yang aman.");

  c.status = "READY_FOR_PATCH";
  c.approvedAt = now();
  c.approvedBy = auth.currentUser?.uid || null;
  c.repairPlan.status = "READY_FOR_PATCH";

  const proposal = c.patchProposal || findProposal(c.id);
  if (proposal) {
    proposal.status = "READY_FOR_PATCH";
    proposal.approvedAt = c.approvedAt;
    proposal.approvedBy = c.approvedBy;
  }

  try {
    await addDoc(collection(db, "medicine_treatments"), {
      caseId: c.id, source: c.source, diagnosis: c.diagnosis, prescription: c.prescription,
      verification: c.verification, repairPlan: c.repairPlan, action: "APPROVED_READY_FOR_PATCH",
      actorUid: c.approvedBy, createdAt: serverTimestamp()
    });
  } catch (e) { emit("storage_warning", { message: e.message }); }

  await postSystemMessage("human", `Saya menyetujui treatment untuk ${c.source}. Medicine boleh meminta executor menerapkan repair plan ${c.repairPlan.planId}.`, { kind: "HUMAN_APPROVAL", caseId: c.id });
  await postSystemMessage("medicine", `Approval manusia diterima. Repair plan ${c.repairPlan.planId} siap dikirim ke Patch Executor. Setelah eksekusi saya wajib memvalidasi hasilnya.`, { kind: "MEDICINE_READY_FOR_PATCH", caseId: c.id });
  emit("patch_proposed", { proposal, case: c });
  emit("case_updated", { case: c });
  return c;
}

async function applyPatch(caseId) {
  const c = S.cases.find(x => x.id === caseId);
  if (!c) throw new Error("Case tidak ditemukan");
  if (!canApplyPatch(c)) throw new Error("Patch belum siap atau belum memiliki operasi source yang aman.");

  const proposal = c.patchProposal || findProposal(caseId);
  if (!proposal) throw new Error("Patch proposal tidak ditemukan");

  const request = {
    requestId: `REQ-${uid().toUpperCase()}`,
    caseId,
    proposalId: proposal.proposalId,
    planId: c.repairPlan.planId,
    telemetryTarget: c.source,
    target: c.repairPlan.rootCauseFile,
    operations: c.repairPlan.operations,
    beforeAfter: c.repairPlan.beforeAfter,
    status: "PENDING_EXECUTION",
    actorUid: auth.currentUser?.uid || null,
    createdAt: serverTimestamp(),
    requestedAt: now(),
    executorAvailable: executorAvailable()
  };

  proposal.status = "APPLY_REQUESTED";
  c.status = "PATCH_PENDING_EXECUTION";
  S.patchRequests.unshift(request);
  S.patchRequests = S.patchRequests.slice(0, 40);

  try {
    await addDoc(collection(db, "medicine_patch_requests"), request);
  } catch (e) { emit("storage_warning", { message: e.message }); }

  await postSystemMessage("medicine", executorAvailable()
    ? `Repair request ${request.requestId} dikirim ke Patch Executor. Saya akan memeriksa hasil perubahan dan menjalankan validasi.`
    : `Repair request ${request.requestId} sudah tercatat. Executor tepercaya belum tersedia di halaman ini, jadi source belum ditulis.`, {
      kind: "PATCH_APPLY_REQUESTED", caseId, proposalId: proposal.proposalId, requestId: request.requestId
    });
  emit("patch_apply_requested", { proposal, request, case: c, executorAvailable: executorAvailable() });

  if (!executorAvailable()) return { case: c, proposal, request };

  try {
    const result = await window.BCGOPatchExecutor.apply({ case: c, proposal, request });
    proposal.status = result?.ok ? "APPLIED" : "APPLY_FAILED";
    proposal.executorResult = result || null;
    c.status = result?.ok ? "PATCH_APPLIED" : "PATCH_FAILED";
    emit("patch_apply_complete", { proposal, request, result, case: c });
    if (result?.ok) await validateAfterPatch(caseId);
    return { case: c, proposal, request, result };
  } catch (e) {
    proposal.status = "APPLY_FAILED";
    c.status = "PATCH_FAILED";
    emit("patch_apply_complete", { proposal, request, result: { ok: false, error: e.message }, case: c });
    throw e;
  }
}

async function validateAfterPatch(caseId) {
  const c = S.cases.find(x => x.id === caseId);
  if (!c) throw new Error("Case tidak ditemukan");
  const telemetryTarget = c.source;
  const repairTarget = c.repairPlan?.rootCauseFile || c.source;
  emit("validation_started", { caseId, target: repairTarget, telemetryTarget });

  const beforeSig = c.signature;
  for (const f of new Set([telemetryTarget, repairTarget, "bcgo-admin.html", "bcgo-engine.js"])) S.sourceCache.delete(f);

  const telemetryLogs = latestRelevantLogs(telemetryTarget);
  const currentError = telemetryLogs.find(l => safeLower(l.message || l.error).includes(safeLower(beforeSig)));
  const scan = await scanConsistency([telemetryTarget, repairTarget, "bcgo-engine.js", "bcgo-admin.html"].filter((v,i,a)=>REGISTRY[v]&&a.indexOf(v)===i));
  const sourceReadable = !!scan.results[repairTarget]?.ok;
  const related = scan.findings.filter(f => f.sourceFile === repairTarget || f.targetFile === repairTarget);
  const operations = c.repairPlan?.operations || [];

  let operationVerified = operations.length > 0;
  const repairSource = scan.results[repairTarget]?.text || "";
  for (const op of operations) {
    if (op.type === "REPLACE_EXACT") {
      if (repairSource.includes(op.before) || !repairSource.includes(op.after)) operationVerified = false;
    }
  }

  const passed = sourceReadable && !currentError && operationVerified && related.filter(f => f.kind !== "DOM_ASSIGNMENT_RISK").length === 0;
  const v = {
    caseId,
    target: repairTarget,
    telemetryTarget,
    passed,
    status: passed ? "FIXED_VERIFIED" : "STILL_FAILING",
    checkedAt: now(),
    remainingFindings: related,
    runtimeEvidence: telemetryLogs.slice(0, 5),
    previousSignature: beforeSig,
    sourceReadable,
    operationVerified
  };
  S.validation = v;
  c.validation = v;
  c.status = passed ? "FIXED_VERIFIED" : "PATCH_REQUIRES_REVIEW";

  const proposal = c.patchProposal || findProposal(caseId);
  if (proposal) proposal.status = passed ? "VERIFIED_FIXED" : "VALIDATION_FAILED";

  try {
    await addDoc(collection(db, "medicine_validations"), { ...v, createdAt: serverTimestamp(), actorUid: auth.currentUser?.uid || null });
  } catch (e) { emit("storage_warning", { message: e.message }); }

  await postSystemMessage("medicine", passed
    ? `Validasi pasca-repair LULUS. Telemetry ${telemetryTarget} tidak lagi menunjukkan signature lama dan perubahan exact pada ${repairTarget} terverifikasi.`
    : `Validasi pasca-repair BELUM LULUS. Saya menemukan evidence/gap yang masih tersisa; saya tidak menyatakan file sembuh.`, {
      kind: "POST_PATCH_VALIDATION", caseId, target: repairTarget, telemetryTarget, passed
    });
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
  try {
    await addDoc(collection(db, "medicine_treatments"), { caseId: c.id, source: c.source, action: "REJECTED", reason: c.rejectionReason, actorUid: auth.currentUser?.uid || null, createdAt: serverTimestamp() });
  } catch (e) { emit("storage_warning", { message: e.message }); }
  await postSystemMessage("medicine", `Saya menerima penolakan untuk ${c.id}. Repair dibatalkan; source-code tetap tidak disentuh.`);
  emit("case_updated", { case: c });
  return c;
}

async function setHumanMode(paused) {
  S.human.paused = !!paused;
  S.human.mode = paused ? "HUMAN_PAUSED" : "ASSISTED";
  S.human.uid = auth.currentUser?.uid || null;
  emit("human_control", { human: { ...S.human } });
  await postSystemMessage("medicine", paused
    ? "Mode Medicine dijeda oleh manusia. Saya hanya mengamati telemetry dan menunggu instruksi."
    : "Mode Medicine aktif kembali. Saya melanjutkan observasi, diagnosis, repair plan, dan validasi dengan approval manusia.", { kind: "HUMAN_MODE" });
}

async function requestReview(caseId) {
  const c = S.cases.find(x => x.id === caseId);
  if (!c) throw new Error("Case tidak ditemukan");
  await postSystemMessage("bcgo", `Saya meminta review manusia untuk ${c.id}. Evidence: ${c.source} — ${c.diagnosis.title}.`, { kind: "HUMAN_REVIEW_REQUEST", caseId: c.id });
  emit("human_review_requested", { case: c });
  return c;
}

async function startConversation() {
  try {
    const q = query(collection(db, "medicine_messages"), orderBy("createdAt", "desc"), limit(200));
    const unsub = onSnapshot(q, snapshot => {
      const seen = new Set();
      S.messages = snapshot.docs.map(d => ({ id: d.id, ...d.data() })).reverse().filter(m => {
        const key = m.clientMessageId || m.id;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      emit("conversation", { messages: S.messages });
    }, e => emit("conversation_error", { message: e.message }));
    if (typeof unsub === "function") S.listeners.push(unsub);
  } catch (e) { emit("conversation_error", { message: e.message }); }
}

onAuthStateChanged(auth, async user => {
  S.human.uid = user?.uid || null;
  emit("auth", { user: user ? { uid: user.uid, email: user.email || null } : null });
  if (!user) { stopAutonomousConversation(); return; }

  try {
    const adminSnap = await getDoc(doc(db, "admin_users", user.uid));
    if (!adminSnap.exists() || adminSnap.data()?.active !== true) {
      emit("auth", { user: null, deniedReason: "NOT_ADMIN" });
      emit("local_message", { message: { role: "medicine", text: "Akses ditolak: akun ini bukan Admin terverifikasi. Silakan login sebagai Admin melalui bcgo-admin.html.", clientMessageId: "auth-denied" } });
      return;
    }
  } catch (e) {
    emit("auth", { user: null, deniedReason: "ADMIN_CHECK_FAILED" });
    return;
  }

  startTelemetry();
  startConversation();
  startAutonomousConversation();
});

const API = {
  scanConsistency,
  verifyWithMedicine,
  sendMessage,
  approveTreatment,
  applyPatch,
  validateAfterPatch,
  rejectTreatment,
  setHumanMode,
  requestReview,
  startAutonomousConversation,
  stopAutonomousConversation,
  getCodePrescription: caseId => { const c = caseId ? S.cases.find(x => x.id === caseId) : S.activeCase; return c?.repairPlan?.codePrescription || buildCodePrescription(c?.repairPlan); },
  buildCodePrescription,
  getRegistry: () => ({ ...REGISTRY }),
  getRegistryParity: () => ({ ...S.registryParity, missing: [...S.registryParity.missing], extra: [...S.registryParity.extra], mismatched: [...S.registryParity.mismatched] }),
  getState: () => ({ ...S, sourceCache: undefined })
};
Object.defineProperties(API, {
  cases: { get: () => S.cases },
  activeCase: { get: () => S.activeCase },
  human: { get: () => S.human },
  findings: { get: () => S.findings },
  patchProposals: { get: () => S.patchProposals },
  patchRequests: { get: () => S.patchRequests },
  verification: { get: () => S.verification },
  validation: { get: () => S.validation },
  logs: { get: () => S.logs },
  messages: { get: () => S.messages },
  executorAvailable: { get: executorAvailable }
});
window.BCGOMedicine = API;

setTimeout(() => scanConsistency().catch(e => emit("scan_error", { message: e.message })), 600);
emit("ready", { version: S.version, registryCount: Object.keys(REGISTRY).length, executorAvailable: executorAvailable() });
