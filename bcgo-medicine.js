import {
  collection, onSnapshot, query, orderBy, limit, addDoc, serverTimestamp
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
  "bcgo.html": { type: "Sistem Monitor", role: "monitor" }
};

const REQUIRED = {
  driver: ["name", "phone", "address", "vehicleType"],
  assistant: ["name", "phone", "address", "serviceType"],
  customer: ["name", "phone", "email"],
  restaurant: [
    "name", "phone", "address", "businessName", "businessType", "ownerName", "role",
    "village", "district", "city", "province", "openTime", "closeTime", "operationalDays",
    "ktp", "legalStatus", "bankName", "accountName", "accountNumber", "photoFront"
  ]
};

const CONTRACT_FIELDS = new Set([
  "name", "phone", "address", "email", "vehicleType", "serviceType", "photo", "photoFront",
  "photoIndoor", "fotoKtp", "fotoSim", "fotoStnk", "ktp", "sim", "stnk", "businessName",
  "businessType", "ownerName", "role", "village", "district", "city", "province", "openTime",
  "closeTime", "operationalDays", "legalStatus", "bankName", "accountName", "accountNumber"
]);

const S = {
  version: "1.7.0",
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
  eventSeq: 0
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

function startTelemetry() {
  if (!window.CikurCloud?.listenSystemLogs) {
    emit("telemetry_unavailable");
    return;
  }
  const unsub = window.CikurCloud.listenSystemLogs(logs => {
    S.logs = Array.isArray(logs) ? logs : [];
    emit("telemetry", { logs: S.logs });
    for (const l of S.logs.slice(0, 60)) makeCase(l);
  });
  if (typeof unsub === "function") S.listeners.push(unsub);
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
  while ((m = htmlAttr.exec(source))) {
    if (CONTRACT_FIELDS.has(m[1]) || /^[a-z][A-Za-z0-9_-]{1,40}$/.test(m[1])) out.push(m[1]);
  }
  const jsFields = /\b(name|phone|address|email|vehicleType|photo|photoFront|photoIndoor|fotoKtp|fotoSim|fotoStnk|ktp|sim|stnk|bankName|accountName|accountNumber|serviceType|businessName|businessType|ownerName|role|village|district|city|province|openTime|closeTime|operationalDays|legalStatus)\b/g;
  if (/\.js$/i.test(name)) while ((m = jsFields.exec(source))) out.push(m[1]);
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

function exactDomEvidence(fileName, source, signature) {
  const out = [];
  for (const c of domAssignmentCandidates(fileName, source)) {
    const selector = c.selector;
    if (!selector) continue;
    const existsInSameDocument = /\.html$/i.test(fileName) ? htmlHasElement(source, selector) : null;
    out.push({
      ...c,
      existsInSameDocument,
      evidenceStrength: existsInSameDocument === false ? "HIGH" : existsInSameDocument === true ? "MEDIUM" : "LOW",
      evidenceReason: existsInSameDocument === false
        ? `Referensi DOM '${selector}' tidak ditemukan pada dokumen ${fileName}.`
        : existsInSameDocument === true
          ? `Referensi DOM '${selector}' ditemukan pada dokumen ${fileName}; penyebab runtime belum terbukti.`
          : `Referensi DOM '${selector}' ditemukan pada source script; hubungan runtime belum terbukti tanpa stack/selector evidence.`
    });
  }
  return out;
}

async function buildSourceEvidence(targetFile, signature) {
  const names = Object.keys(REGISTRY);
  const evidence = [];
  const priority = [targetFile, "bcgo-admin.html", "bcgo-engine.js", ...names].filter((v,i,a)=>v && a.indexOf(v)===i);
  for (const name of priority) {
    const x = await fetchFile(name);
    if (!x.ok || !x.text) continue;
    for (const c of exactDomEvidence(name, x.text, signature)) {
      const selectorHit = c.selector && safeLower(signature).includes(safeLower(c.selector));
      if (c.evidenceStrength === "HIGH" || selectorHit) evidence.push({ ...c, selectorHit: !!selectorHit });
    }
  }
  evidence.sort((a,b) => ({HIGH:3,MEDIUM:2,LOW:1}[b.evidenceStrength] - {HIGH:3,MEDIUM:2,LOW:1}[a.evidenceStrength]) || (b.selectorHit-a.selectorHit) || (a.line-b.line));
  return evidence.slice(0, 12);
}

async function resolveRootCause(c) {
  const originalTarget = c.source;
  const direct = await fetchFile(originalTarget);
  const directEvidence = exactDomEvidence(originalTarget, direct.text, c.signature)
    .filter(x => x.evidenceStrength === "HIGH");
  if (directEvidence.length) {
    const ops = findLikelyDomBinding(originalTarget, direct.text, c.signature)
      .filter(op => directEvidence.some(e => e.file === op.file && e.line === op.line));
    return {
      rootCauseFile: originalTarget,
      sourceEvidence: directEvidence.map(e => ({ file:e.file, selector:e.selector, property:e.property, line:e.line, before:e.before, evidenceStrength:e.evidenceStrength, reason:e.evidenceReason })),
      resolvedOperation: ops[0] || null
    };
  }
  if (c.diagnosis.code !== "DOM_NULL_REFERENCE") return { rootCauseFile: originalTarget, sourceEvidence: [] };
  const candidates = await buildSourceEvidence(originalTarget, c.signature);
  const best = candidates.find(x => x.evidenceStrength === "HIGH");
  if (!best) return { rootCauseFile: originalTarget, sourceEvidence: candidates.slice(0, 8), resolvedOperation: null };
  const src = await fetchFile(best.file);
  const ops = findLikelyDomBinding(best.file, src.text, c.signature).filter(op => op.line === best.line);
  return {
    rootCauseFile: best.file,
    sourceEvidence: candidates.slice(0, 8),
    resolvedOperation: ops[0] || null
  };
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
  // A contract gap is a finding, not permission to invent UI. Medicine must locate
  // an existing renderer/field mapping before it can propose a source edit.
  return [];
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
    const sf = new Set((result[source].fields || []).map(safeLower));
    const missing = req.filter(x => !sf.has(safeLower(x)));
    if (missing.length) findings.push({ kind: "SOURCE_CONTRACT_GAP", sourceFile: source, missing });
  }

  const sources = ["driver.html", "resto.html", "agentcgo.html", "index.html", "food.html", "ride.html"];
  for (const source of sources) {
    if (!result[source]?.ok || !result["bcgo-admin.html"]?.ok) continue;
    const sf = [...new Set((result[source].fields || []).map(safeLower))].filter(x => CONTRACT_FIELDS.has(x));
    const missing = sf.filter(x => !admin.has(x));
    if (missing.length) findings.push({ kind: "ADMIN_PRESENTATION_GAP", sourceFile: source, targetFile: "bcgo-admin.html", missing });
  }

  // Detect known DOM-null patterns directly from deployed source, not only telemetry.
  for (const name of names) {
    const source = result[name]?.text || "";
    const directNullRisk = /\$\(\s*["'][^"']+["']\s*\)\.textContent\s*=|document\.getElementById\(\s*["'][^"']+["']\s*\)\.textContent\s*=/.test(source);
    if (directNullRisk) {
      const evs = exactDomEvidence(name, source, "");
      for (const ev of evs) findings.push({ kind: "DOM_ASSIGNMENT_RISK", sourceFile: name, targetFile: name, selector: ev.selector, line: ev.line, evidenceStrength: ev.evidenceStrength, detail: ev.evidenceReason });
    }
  }

  S.findings = findings;
  emit("scan_complete", { results: result, findings });
  return { results: result, findings };
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
    precision: { exactTargetRequired: true, exactEvidenceRequired: true, noGuessing: true },
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

  if (plan.operations.length) {
    plan.status = "PROPOSED";
    plan.blockReason = null;
    plan.precisionGate = true;
  } else {
    plan.status = "PATCH_REQUIRES_REVIEW";
    plan.blockReason = "PRECISION GATE: Medicine belum menemukan lokasi source dan operasi exact yang terbukti. Source tidak akan diubah berdasarkan tebakan.";
    plan.precisionGate = false;
  }
  return plan;
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
  const target = targetFile && REGISTRY[targetFile] ? targetFile : (S.activeCase?.source || "bcgo-admin.html");
  emit("verification_started", { target, context });
  const targets = [target, "bcgo-engine.js", "bcgo-admin.html"].filter((v, i, a) => REGISTRY[v] && a.indexOf(v) === i);
  const result = await scanConsistency(targets);
  const targetFindings = result.findings.filter(f => f.sourceFile === target || f.targetFile === target);
  const logs = latestRelevantLogs(target);
  const runtimeEvidence = logs.slice(0, 5);

  let contractEvidence = targetFindings.some(f => f.kind === "SOURCE_CONTRACT_GAP" && Array.isArray(f.missing) && f.missing.length);
  let verdict = contractEvidence ? "SUPPORTED_BY_SOURCE_CONTRACT" : runtimeEvidence.length ? "RUNTIME_EVIDENCE_PRESENT" : "INSUFFICIENT_EVIDENCE";
  const v = { target, verdict, targetFindings, runtimeEvidence, checkedFiles: targets, checkedAt: now(), question: context.question || null };

  if (S.activeCase && (!targetFile || S.activeCase.source === target)) {
    S.activeCase.verification = v;
    S.activeCase.repairPlan = await enrichRepairPlan(S.activeCase, v);
    S.activeCase.rootCauseFile = S.activeCase.repairPlan.rootCauseFile || S.activeCase.source;
    S.activeCase.sourceEvidence = S.activeCase.repairPlan.sourceEvidence || [];

    const exactProof = !!(
      S.activeCase.repairPlan.operations?.length &&
      S.activeCase.repairPlan.rootCauseFile === S.activeCase.repairPlan.operations[0]?.file &&
      S.activeCase.sourceEvidence.some(e => e.evidenceStrength === "HIGH") &&
      S.activeCase.repairPlan.operations.every(op => op.type === "REPLACE_EXACT" && op.before && op.after)
    );
    if (exactProof) {
      verdict = "SUPPORTED_BY_EXACT_SOURCE_EVIDENCE";
      v.verdict = verdict;
    }

    S.verification = v;
    S.activeCase.verification = v;
    S.activeCase.status = (verdict === "SUPPORTED_BY_EXACT_SOURCE_EVIDENCE") ? "VERIFIED_DIAGNOSIS" : "NEEDS_EVIDENCE";
    S.activeCase.prescription = prescription(S.activeCase.diagnosis);
    emit("case_updated", { case: S.activeCase });

    const proposal = {
      proposalId: `PATCH-${uid().toUpperCase()}`,
      caseId: S.activeCase.id,
      telemetryTarget: S.activeCase.source,
      repairTarget: S.activeCase.repairPlan.rootCauseFile,
      diagnosis: S.activeCase.diagnosis,
      verification: v,
      repairPlan: S.activeCase.repairPlan,
      operations: S.activeCase.repairPlan.operations,
      beforeAfter: S.activeCase.repairPlan.beforeAfter,
      status: (exactProof ? "PROPOSED" : "PATCH_REQUIRES_REVIEW"),
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
    S.verification = v;
  }

  emit("verification_complete", { verification: v });
  const message = verdict === "SUPPORTED_BY_EXACT_SOURCE_EVIDENCE"
    ? `Verifikasi ${target} LULUS PRECISION GATE. Akar masalah dan lokasi repair didukung evidence source yang spesifik. Source tetap terkunci sampai persetujuan manusia.`
    : verdict === "SUPPORTED_BY_SOURCE_CONTRACT"
      ? `Verifikasi ${target} menemukan gap kontrak yang nyata, tetapi lokasi repair belum terbukti cukup presisi. Saya menahan patch.`
      : verdict === "RUNTIME_EVIDENCE_PRESENT"
        ? `Verifikasi ${target} menemukan evidence runtime, tetapi belum cukup untuk membuktikan akar masalah dan lokasi patch. Saya tidak akan menebak.`
        : `Verifikasi ${target} selesai. Evidence belum cukup. Saya tidak akan mengarang patch.`;
  await postSystemMessage("medicine", message, { kind: "MEDICINE_VERIFICATION", target, verdict, checkedFiles: targets });
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
    return `Saya cek pertanyaan Anda. Target paling relevan ${target}. ${evidence} Saya tidak akan langsung menyalahkan file tersebut. Saya minta Medicine melakukan verifikasi lintas-file dan mencari akar masalah.`;
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
    return `Saya akan memeriksa ${target} lintas-file: sumber data, kontrak field, engine, renderer Admin, dan telemetry. Bila akar masalah terbukti, saya susun perubahan kode konkret, bukan sekadar diagnosis.`;
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

onAuthStateChanged(auth, user => {
  S.human.uid = user?.uid || null;
  emit("auth", { user: user ? { uid: user.uid, email: user.email || null } : null });
  if (user) {
    startTelemetry();
    startConversation();
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
