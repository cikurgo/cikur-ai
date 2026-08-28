import {
  collection, onSnapshot, query, orderBy, limit, addDoc, serverTimestamp, doc, getDoc
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { db, auth } from "./cikur-config.js";

/*
 * BCGO MEDICINE v1.7 — PRECISION REPAIR / VERIFIED HEALING ENGINE
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
  "bcgo.js": { type: "Sistem Monitor Core", role: "monitor" },
  "bcgo-medicine.html": { type: "Sistem Medicine UI", role: "medicine" },
  "bcgo-medicine.js": { type: "Sistem Medicine Core", role: "medicine" }
};

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
  version: "2.0.0",
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
  runtime: {
    auth: "WAITING",
    firestore: "WAITING",
    telemetry: "WAITING",
    chat: "WAITING",
    autonomous: "STOPPED",
    bootedAt: null,
    lastRealtimeAt: null,
    error: null
  },
  runtimeStarted: false,
  autonomousTimer: null
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

function latestRelevantLogs(file) {
  return S.logs.filter(l => !file || safeLower(l.fileName || l.source) === safeLower(file)).slice(0, 12);
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

function makeCase(log) {
  const source = text(log.fileName || log.source || "UNKNOWN", 120);
  const sig = text(log.message || log.error || "Unknown error", 700);
  if (S.cases.some(c => c.source === source && c.signature === sig)) return null;

  const d = diagnosis(sig);
  const c = {
    id: `CASE-${uid().toUpperCase()}`,
    source,
    signature: sig,
    diagnosis: d,
    prescription: prescription(d),
    status: "DIAGNOSED",
    createdAt: now(),
    evidence: log,
    repairPlan: null,
    rootCauseFile: source,
    sourceEvidence: [],
    validation: null
  };
  S.cases.unshift(c);
  S.cases = S.cases.slice(0, 80);
  S.activeCase = c;
  emit("case_created", { case: c });

  postSystemMessage("bcgo", `Saya menemukan evidence pada ${source}: ${d.title}. Saya serahkan ${c.id} ke Medicine untuk verifikasi independen.`, {
    kind: "BCGO_HANDOFF", caseId: c.id, target: source
  });
  postSystemMessage("medicine", `Case ${c.id} saya terima. Saya akan mencari akar masalah, memeriksa kontrak lintas-file, lalu menyiapkan repair plan yang konkret.`, {
    kind: "MEDICINE_ACK", caseId: c.id, target: source
  });
  return c;
}

function setRuntime(key, value, extra = {}) {
  S.runtime[key] = value;
  S.runtime.lastRealtimeAt = now();
  emit("realtime_status", { runtime: { ...S.runtime }, ...extra });
}

function startTelemetry() {
  if (S.listeners.some(x => x && x.__medicineTelemetry)) return;
  setRuntime("telemetry", "CONNECTING");

  const handleLogs = logs => {
    S.logs = Array.isArray(logs) ? logs : [];
    setRuntime("telemetry", "LIVE", { count: S.logs.length });
    emit("telemetry", { logs: S.logs });
    for (const l of S.logs.slice(0, 60)) makeCase(l);
  };

  try {
    let unsub = null;
    if (window.CikurCloud?.listenSystemLogs) {
      unsub = window.CikurCloud.listenSystemLogs(handleLogs);
    } else {
      // Fallback: do not depend on a global CikurCloud bridge.
      // Firestore Rules remain authoritative; this listener still requires the verified Admin session.
      const q = query(collection(db, "system_logs"), limit(120));
      unsub = onSnapshot(q, snapshot => {
        const logs = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        logs.sort((a, b) => String(b.createdAt || b.timestamp || "").localeCompare(String(a.createdAt || a.timestamp || "")));
        handleLogs(logs);
      }, e => {
        setRuntime("telemetry", "ERROR", { error: e.message });
        emit("telemetry_error", { message: e.message });
      });
    }
    if (typeof unsub === "function") {
      const wrapped = () => unsub();
      wrapped.__medicineTelemetry = true;
      S.listeners.push(wrapped);
    }
  } catch (e) {
    setRuntime("telemetry", "ERROR", { error: e.message });
    emit("telemetry_error", { message: e.message });
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
  const q = escRegExp(id);
  return new RegExp(`(?:id|name)\\s*=\\s*["']${q}["']`, "i").test(source);
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
    const re = new RegExp(`<script[^>]+src=["'][^"']*${escRegExp(scriptFile)}(?:[?#][^"']*)?["']`, "i");
    if (re.test(data.text)) out.push(name);
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
  for (const c of domAssignmentCandidates(fileName, source)) {
    const selector = c.selector;
    if (!selector) continue;
    const existsInSameDocument = /\.html$/i.test(fileName) ? htmlHasElement(source, selector) : null;
    const stackHit = (context.runtimeLocations || []).some(x => x.file && safeLower(x.file) === safeLower(fileName) && (!x.line || x.line === c.line));
    const signatureHit = safeLower(signature).includes(safeLower(selector));
    let strength = "LOW";
    let reason = `Referensi DOM '${selector}' ditemukan pada source script; hubungan runtime belum terbukti.`;
    if (existsInSameDocument === false) {
      strength = "HIGH";
      reason = `Referensi DOM '${selector}' tidak ditemukan pada dokumen ${fileName}.`;
    } else if (existsInSameDocument === true && (stackHit || signatureHit)) {
      strength = "MEDIUM";
      reason = `Referensi DOM '${selector}' ada, tetapi bukti runtime menunjuk lokasi ini; penyebab perlu korelasi lintas-file.`;
    } else if (stackHit || signatureHit) {
      strength = "MEDIUM";
      reason = `Lokasi source ${fileName}:${c.line} berkorelasi dengan evidence runtime.`;
    }
    out.push({ ...c, existsInSameDocument, stackHit, signatureHit, evidenceStrength: strength, evidenceReason: reason });
  }
  return out;
}

async function buildSourceEvidence(targetFile, signature) {
  const names = Object.keys(REGISTRY);
  const evidence = [];
  const runtimeLocations = extractRuntimeLocation(signature);
  const loaded = {};
  const htmlResults = {};
  for (const name of names) {
    if (!/\.html$/i.test(name)) continue;
    const x = await fetchFile(name);
    htmlResults[name] = x;
  }
  for (const name of names) {
    const x = await fetchFile(name);
    if (!x.ok || !x.text) continue;
    const pages = /\.js$/i.test(name) ? loadedByPages(name, htmlResults) : [];
    loaded[name] = pages;
    for (const c of exactDomEvidence(name, x.text, signature, { runtimeLocations })) {
      let strength = c.evidenceStrength;
      let reason = c.evidenceReason;
      if (/\.js$/i.test(name) && pages.length && c.selector) {
        const missingPages = pages.filter(page => htmlHasElement(htmlResults[page]?.text || "", c.selector) === false);
        if (missingPages.length) {
          strength = "HIGH";
          reason = `Script ${name} dipakai oleh ${missingPages.join(', ')} tetapi target DOM '${c.selector}' tidak ditemukan di halaman tersebut.`;
        }
      }
      if (strength !== "LOW" || c.signatureHit || c.stackHit) evidence.push({ ...c, evidenceStrength: strength, evidenceReason: reason, loadedBy: pages });
    }
  }
  evidence.sort((a,b) => ({HIGH:3,MEDIUM:2,LOW:1}[b.evidenceStrength] - {HIGH:3,MEDIUM:2,LOW:1}[a.evidenceStrength]) || ((b.stackHit?1:0)-(a.stackHit?1:0)) || ((b.signatureHit?1:0)-(a.signatureHit?1:0)) || (a.line-b.line));
  return evidence.slice(0, 20);
}

async function resolveRootCause(c) {
  const originalTarget = c.source;
  const runtimeLocations = extractRuntimeLocation(c.signature);

  // First prove the original target. Do not keep it merely because BCGO named it.
  const direct = await fetchFile(originalTarget);
  const directEvidence = exactDomEvidence(originalTarget, direct.text, c.signature, { runtimeLocations })
    .filter(x => x.evidenceStrength === "HIGH");
  if (directEvidence.length) {
    const ops = findLikelyDomBinding(originalTarget, direct.text, c.signature)
      .filter(op => directEvidence.some(e => e.file === op.file && e.line === op.line));
    return {
      rootCauseFile: originalTarget,
      rootCauseStatus: "CONFIRMED_ORIGINAL_TARGET",
      sourceEvidence: directEvidence.map(e => ({ file:e.file, selector:e.selector, property:e.property, line:e.line, before:e.before, evidenceStrength:e.evidenceStrength, reason:e.evidenceReason, loadedBy:e.loadedBy || [] })),
      resolvedOperation: ops[0] || null,
      candidates: directEvidence.slice(0, 8)
    };
  }

  // For DOM/runtime errors, search the entire dependency surface. This is the
  // important v1.8 behavior: an incorrect BCGO target is allowed to move.
  if (c.diagnosis.code === "DOM_NULL_REFERENCE") {
    const candidates = await buildSourceEvidence(originalTarget, c.signature);
    const best = candidates.find(x => x.evidenceStrength === "HIGH");
    if (!best) return { rootCauseFile: originalTarget, rootCauseStatus: "UNPROVEN", sourceEvidence: candidates.slice(0, 12), resolvedOperation: null, candidates: candidates.slice(0, 12) };
    const src = await fetchFile(best.file);
    const ops = findLikelyDomBinding(best.file, src.text, c.signature).filter(op => op.line === best.line || safeLower(op.before).includes(safeLower(best.selector)));
    return {
      rootCauseFile: best.file,
      rootCauseStatus: best.file === originalTarget ? "CONFIRMED_ORIGINAL_TARGET" : "TARGET_CORRECTED_BY_MEDICINE",
      sourceEvidence: candidates.slice(0, 12).map(e => ({ file:e.file, selector:e.selector, property:e.property, line:e.line, before:e.before, evidenceStrength:e.evidenceStrength, reason:e.evidenceReason, loadedBy:e.loadedBy || [] })),
      resolvedOperation: ops[0] || null,
      candidates: candidates.slice(0, 12)
    };
  }

  // For consistency cases, explicitly prove which side of the contract is
  // incomplete. This can identify a better root-cause file even when no patch
  // can yet be generated safely.
  if (c.diagnosis.code === "DATA_CONSISTENCY") {
    const scan = await scanConsistency();
    const relevant = scan.findings.filter(f => f.kind === "ADMIN_PRESENTATION_GAP" || f.kind === "SOURCE_CONTRACT_GAP");
    const gap = relevant.find(f => f.sourceFile === originalTarget) ||
      relevant.find(f => f.targetFile === originalTarget) || null;
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

  return { rootCauseFile: originalTarget, rootCauseStatus: "UNPROVEN", sourceEvidence: [], resolvedOperation: null, candidates: [] };
}

function findDomNullOperations(fileName, source, signature) {
  if (!source) return [];
  const ops = [];
  const wanted = safeLower(signature).includes("textcontent");
  if (!wanted) return ops;

  const re = /^(\s*)(\$|document\.getElementById)\(\s*(["'])([^"']+)\3\s*\)\.textContent\s*=\s*([^;\n]+);?\s*$/gm;
  let m;
  while ((m = re.exec(source)) && ops.length < 12) {
    const before = m[0];
    const indent = m[1];
    const accessor = m[2] === "$" ? `$(${m[3]}${m[4]}${m[3]})` : `document.getElementById(${m[3]}${m[4]}${m[3]})`;
    const after = `${indent}{ const __medicineEl = ${accessor}; if (__medicineEl) __medicineEl.textContent = ${m[5]}; }`;
    ops.push({ type: "REPLACE_EXACT", file: fileName, line: lineOf(source, m.index), before, after, reason: "Guard DOM reference before assigning textContent" });
  }
  return ops;
}

function findLikelyDomBinding(fileName, source, signature) {
  const operations = findDomNullOperations(fileName, source, signature);
  if (operations.length) return operations;

  // Also identify direct getElementById(...).textContent assignments even when the
  // line was formatted differently. These remain reviewable exact replacements.
  const re = /(document\.getElementById\(\s*["']([^"']+)["']\s*\)\.textContent\s*=\s*[^;\n]+;)/g;
  let m;
  while ((m = re.exec(source)) && operations.length < 8) {
    const before = m[1];
    const id = m[2];
    const rhs = before.split("=").slice(1).join("=").trim().replace(/;$/, "");
    const after = `{ const __medicineEl = document.getElementById("${id}"); if (__medicineEl) __medicineEl.textContent = ${rhs}; }`;
    operations.push({ type: "REPLACE_EXACT", file: fileName, line: lineOf(source, m.index), before, after, reason: "Guard DOM reference before assigning textContent" });
  }
  return operations;
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
  const highEvidence = items.some(x => x.evidenceStrength === "HIGH");
  const rootProven = ["CONFIRMED_ORIGINAL_TARGET", "TARGET_CORRECTED_BY_MEDICINE", "CONTRACT_ROOT_CAUSE_IDENTIFIED"]
    .includes(p.rootCauseStatus);

  return {
    ready: !!(p.precisionGate === true && exact && highEvidence && rootProven),
    status: p.precisionGate === true && exact && highEvidence && rootProven ? "READY_TO_COPY" : "REVIEW_REQUIRED",
    targetFile: p.rootCauseFile || p.target || null,
    rootCauseStatus: p.rootCauseStatus || "UNPROVEN",
    evidenceCount: evidence.length,
    items,
    instruction: p.precisionGate === true && exact && highEvidence && rootProven
      ? "Solusi berasal dari operasi exact yang terikat pada source evidence. Review BEFORE/AFTER lalu copy secara manual."
      : "Medicine belum memiliki kombinasi root cause, source exact, evidence HIGH, dan operasi exact yang cukup untuk menyatakan solusi siap copy."
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
    if (gap) plan.operations.push(...buildAdminGapOperations("bcgo-admin.html", gap.missing || [], adminSource.text));
  }

  for (const op of plan.operations) {
    if (op.type === "REPLACE_EXACT") plan.beforeAfter.push({ file: op.file, line: op.line || null, before: op.before, after: op.after });
    if (op.type === "INSERT_BEFORE") plan.beforeAfter.push({ file: op.file, line: null, before: op.marker, after: `${op.marker}\n${op.content}` });
  }

  const exactEvidence = plan.sourceEvidence.some(e => e.evidenceStrength === "HIGH");
  const rootCauseProven = ["CONFIRMED_ORIGINAL_TARGET", "TARGET_CORRECTED_BY_MEDICINE", "CONTRACT_ROOT_CAUSE_IDENTIFIED"].includes(plan.rootCauseStatus);
  const operationMatchesRoot = plan.operations.length > 0 && plan.operations.every(op => op.file === plan.rootCauseFile && op.type === "REPLACE_EXACT" && op.before && op.after);
  const beforeStillExists = plan.operations.length > 0 && plan.operations.every(op => {
    const ev = plan.sourceEvidence.find(e => e.file === op.file && Number(e.line) === Number(op.line));
    return ev?.before ? String(ev.before) === String(op.before) : true;
  });
  if (plan.operations.length && exactEvidence && rootCauseProven && operationMatchesRoot && beforeStillExists) {
    plan.status = "PROPOSED";
    plan.blockReason = null;
    plan.precisionGate = true;
  } else {
    plan.status = "PATCH_REQUIRES_REVIEW";
    plan.blockReason = "PRECISION GATE: Medicine belum menemukan lokasi source dan operasi exact yang terbukti. Source tidak akan diubah berdasarkan tebakan.";
    plan.precisionGate = false;
  }
  return attachPrescription(plan);
}

function canApprove(c) {
  const v = c?.verification;
  const plan = c?.repairPlan;
  if (!c || !v || !plan?.operations?.length) return false;
  if (c.status !== "VERIFIED_DIAGNOSIS") return false;
  if (v.verdict !== "SUPPORTED_BY_EXACT_SOURCE_EVIDENCE" || plan.precisionGate !== true) return false;
  if (plan.rootCauseFile !== plan.operations[0].file) return false;
  return plan.operations.every(op => op.type === "REPLACE_EXACT" && op.before && op.after && op.file === plan.rootCauseFile);
}

function canApplyPatch(c) {
  return !!(
    c && c.status === "READY_FOR_PATCH" &&
    c.repairPlan?.operations?.length &&
    c.verification &&
    c.verification.verdict === "SUPPORTED_BY_EXACT_SOURCE_EVIDENCE" &&
    c.repairPlan.rootCauseFile === c.repairPlan.operations[0]?.file
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
    const exactProof = !!(
      plan.operations?.length &&
      plan.precisionGate === true &&
      plan.rootCauseFile === plan.operations[0]?.file &&
      ["CONFIRMED_ORIGINAL_TARGET", "TARGET_CORRECTED_BY_MEDICINE", "CONTRACT_ROOT_CAUSE_IDENTIFIED"].includes(plan.rootCauseStatus) &&
      plan.sourceEvidence.some(e => e.evidenceStrength === "HIGH") &&
      plan.operations.every(op => op.type === "REPLACE_EXACT" && op.before && op.after && op.file === plan.rootCauseFile)
    );
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
  return `BCGO menerima pesan Anda dari state aktual. Sebutkan file atau gejalanya jika ingin saya arahkan ke Medicine.`;
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
  return `Saya bekerja berdasarkan evidence. Sebutkan target file/gejala agar saya dapat memverifikasi dan menyiapkan perbaikan konkret.`;
}

function recipient(q) {
  const x = q.trim().toLowerCase();
  if (/^(hai\s+)?bcgo\b/.test(x) || /\bbcgo[,:]/.test(x)) return "bcgo";
  if (/^(hai\s+)?medicine\b/.test(x) || /\bmedicine[,:]/.test(x)) return "medicine";
  if (/\b(bcgo|medicine)\b/.test(x)) return x.indexOf("bcgo") < x.indexOf("medicine") ? "bcgo" : "medicine";
  return "medicine";
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
  if (S.listeners.some(x => x && x.__medicineConversation)) return;
  setRuntime("chat", "CONNECTING");
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
      setRuntime("chat", "LIVE", { count: S.messages.length });
      emit("conversation", { messages: S.messages });
    }, e => {
      setRuntime("chat", "ERROR", { error: e.message });
      emit("conversation_error", { message: e.message });
    });
    if (typeof unsub === "function") {
      const wrapped = () => unsub();
      wrapped.__medicineConversation = true;
      S.listeners.push(wrapped);
    }
  } catch (e) {
    setRuntime("chat", "ERROR", { error: e.message });
    emit("conversation_error", { message: e.message });
  }
}

async function autonomousTick() {
  if (!S.runtimeStarted || S.human.paused) return;
  try {
    emit("autonomous_tick", { runtime: { ...S.runtime }, activeCases: activeCases().length });
    const active = activeCases();
    if (active[0] && !active[0].verification) {
      await verifyWithMedicine(active[0].source, { question: "Autonomous nerve observation", requestedBy: "medicine_autonomous" });
      return;
    }
    if (active.length) {
      const c = active[0];
      await postSystemMessage("bcgo", `Saya masih mengawasi ${c.source}. Medicine sedang menelusuri evidence sebelum kita menyatakan akar masalah.`, { kind: "AUTONOMOUS_OBSERVATION", caseId: c.id });
      await postSystemMessage("medicine", `Saya lanjutkan pemeriksaan ${c.source}. Saya belum akan membuka ruang operasi sebelum source evidence dan operasi exact benar-benar terverifikasi.`, { kind: "AUTONOMOUS_INVESTIGATION", caseId: c.id });
    } else {
      await postSystemMessage("bcgo", `Telemetry saat ini stabil. Saya tetap memantau ${Object.keys(REGISTRY).length} organ dan menunggu perubahan nyata.`, { kind: "AUTONOMOUS_PATROL" });
      await postSystemMessage("medicine", `Patroli saraf berlanjut. Tidak ada case aktif; saya tidak akan mengarang masalah yang tidak didukung evidence.`, { kind: "AUTONOMOUS_PATROL" });
    }
  } catch (e) {
    S.runtime.error = e.message;
    emit("autonomous_error", { message: e.message });
  }
}

function startAutonomousEngine() {
  if (S.autonomousTimer) return;
  S.runtime.autonomous = "LIVE";
  emit("autonomous_status", { runtime: { ...S.runtime } });
  autonomousTick();
  S.autonomousTimer = setInterval(autonomousTick, 30000);
}

function stopRuntime() {
  for (const unsub of S.listeners.splice(0)) { try { unsub(); } catch (_) {} }
  if (S.autonomousTimer) { clearInterval(S.autonomousTimer); S.autonomousTimer = null; }
  S.runtimeStarted = false;
  S.runtime.autonomous = "STOPPED";
}

onAuthStateChanged(auth, async user => {
  stopRuntime();
  S.human.uid = user?.uid || null;
  S.runtime.auth = user ? "SIGNED_IN" : "SIGNED_OUT";
  emit("auth", { user: user ? { uid: user.uid, email: user.email || null } : null, runtime: { ...S.runtime } });
  if (!user) {
    S.runtime.firestore = "AUTH_REQUIRED";
    S.runtime.telemetry = "AUTH_REQUIRED";
    S.runtime.chat = "AUTH_REQUIRED";
    emit("realtime_status", { runtime: { ...S.runtime } });
    return;
  }

  S.runtime.firestore = "CHECKING";
  emit("realtime_status", { runtime: { ...S.runtime } });
  try {
    const adminSnap = await getDoc(doc(db, "admin_users", user.uid));
    if (!adminSnap.exists() || adminSnap.data()?.active !== true) {
      S.runtime.auth = "NOT_ADMIN";
      S.runtime.firestore = "DENIED";
      emit("auth", { user: null, deniedReason: "NOT_ADMIN", runtime: { ...S.runtime } });
      emit("local_message", { message: { role: "medicine", text: "Akses ditolak: akun ini bukan Admin terverifikasi. Silakan login sebagai Admin melalui bcgo-admin.html.", clientMessageId: "auth-denied" } });
      return;
    }
    S.runtime.auth = "ADMIN_VERIFIED";
    S.runtime.firestore = "CONNECTED";
    S.runtime.bootedAt = now();
    S.runtimeStarted = true;
    emit("realtime_status", { runtime: { ...S.runtime } });
    startTelemetry();
    await startConversation();
    startAutonomousEngine();
    emit("runtime_ready", { runtime: { ...S.runtime } });
  } catch (e) {
    S.runtime.firestore = "ERROR";
    S.runtime.error = e.message;
    emit("auth", { user: null, deniedReason: "ADMIN_CHECK_FAILED", error: e.message, runtime: { ...S.runtime } });
    emit("realtime_status", { runtime: { ...S.runtime } });
  }
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
  getCodePrescription: caseId => { const c = caseId ? S.cases.find(x => x.id === caseId) : S.activeCase; return c?.repairPlan?.codePrescription || buildCodePrescription(c?.repairPlan); },
  buildCodePrescription,
  getRegistry: () => ({ ...REGISTRY }),
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
