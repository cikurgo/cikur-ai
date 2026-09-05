/* CIKUR GO Internal AI — Browser Synchronization Bridge
 * Binds the V5.2 active-investigation brain to the existing BCGO / Medicine contracts.
 * No external AI/API. No source mutation. Medicine remains proof authority.
 */
import * as Core from "./cgo-ai-core.js";
import * as Knowledge from "./cgo-ai-knowledge.js";
import * as Investigator from "./cgo-ai-investigator.js";
import * as ActiveInvestigation from "./cgo-ai-investigation-engine.js";
import * as Cognition from "./cgo-ai-cognition.js";
import * as Logic from "./cgo-ai-logic.js";
import * as Memory from "./cgo-ai-memory.js";
import { createRuntime } from "./cgo-ai-runtime-adapter.js";

const VERSION = "V5.2-BROWSER-BRIDGE-1.4.0-ACTIVE-SOURCE";
const runtime = createRuntime({});
const memory = Memory.createMemory();
const caseIds = new Map();
const evidenceTokens = new Map();
const activeEngines = new Map();
const activeRuns = new Map();
let knowledge = Knowledge.createKnowledgeStore();
let latest = null;
let latestBCGOState = null;

function clone(v) {
  return typeof structuredClone === "function"
    ? structuredClone(v)
    : JSON.parse(JSON.stringify(v));
}

function now() { return new Date().toISOString(); }

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
  const sources = state?.sourceScan?.sources;
  if (sources && typeof sources === "object") return Object.keys(sources).map(normalizeFile).filter(Boolean);
  const states = state?.sourceScan?.fileStates;
  if (states && typeof states === "object") return Object.keys(states).map(normalizeFile).filter(Boolean);
  return [];
}

function createInternalProbeProvider(state) {
  const files = investigationFiles(state);
  return {
    sourceSurfaceComplete: state?.sourceScan?.status === "CLEAN" || state?.sourceScan?.status === "FINDINGS",
    async listFiles() { return files.slice(); },
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
  // Evidence invalidation starts a new investigation generation. Never keep a
  // probe cache from an older case revision after new telemetry/source arrives.
  if (!engine || Number(engine.state?.caseRevision ?? -1) !== Number(caseData?.revision ?? 0)) {
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
      if (out.caseData.hypotheses?.length) {
        try { synced = runtime.reason(caseId, out.caseData.hypotheses); } catch {}
      }
      if (out.caseData.rootCause && !synced.rootCause) {
        try { synced = runtime.proveRootCause(caseId, out.caseData.rootCause); } catch {}
      }
      if (out.caseData.exactSource && !synced.exactSource) {
        try { synced = runtime.proveSource(caseId, out.caseData.exactSource); } catch {}
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

      latest = compatibleSnapshot(caseId, "ACTIVE_INVESTIGATION");
      try { window.dispatchEvent(new CustomEvent("cikur-internal-ai-state", {detail:latest})); } catch {}
    } catch (err) {
      emitBrainEvent(caseId, "ACTIVE_INVESTIGATION_ERROR", {error:String(err?.message || err)});
    } finally {
      activeRuns.delete(caseId);
      const latestCase = runtime.getCase(caseId);
      if (latestCase && Number(latestCase.revision ?? 0) !== startRevision) {
        // A new event may have arrived while this generation was running.
        // Re-enter with the newest case after the current promise fully closes.
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

function emitBrainEvent(caseId, type, payload) {
  const detail = {version:VERSION,caseId,type,at:Date.now(),payload:clone(payload || {})};
  try { window.dispatchEvent(new CustomEvent("cikur-internal-ai-investigation", {detail})); } catch {}
}

function chatAnswer(question = {}) {
  const raw = typeof question === "string"
    ? question
    : String(question?.text || question?.question || "");
  const q = raw.toLowerCase().trim();
  const state = latestBCGOState || {};
  const snapshot = latest;
  const reasoning = snapshot?.reasoning || {};
  const proof = reasoning.precisionGate || {};
  const organs = state?.systemOrgans || {};
  const metrics = state?.metrics || {};
  const relations = Array.isArray(state?.sourceScan?.relations) ? state.sourceScan.relations : [];
  const findings = [
    ...(Array.isArray(state?.sourceScan?.findings) ? state.sourceScan.findings : []),
    ...(Array.isArray(state?.sourceScan?.crossFileFindings) ? state.sourceScan.crossFileFindings : [])
  ];
  const active = Object.entries(organs).filter(([,v]) => v?.state === "ACTIVE");
  const review = Object.entries(organs).filter(([,v]) => v?.state === "REVIEW");
  const target = String(state?.targetCell || state?.lastTelemetryFile || "sistem");
  const requestedFile = Object.keys(organs).find(file => q.includes(file.toLowerCase())) || null;

  const relationFor = file => relations
    .filter(r => {
      const a = String(r?.sourceFile || r?.from || r?.file || "").split("?")[0].split("#")[0].split("/").pop();
      const b = String(r?.targetFile || r?.to || r?.relatedFile || "").split("?")[0].split("#")[0].split("/").pop();
      return a === file || b === file;
    })
    .map(r => {
      const a = String(r?.sourceFile || r?.from || r?.file || "").split("?")[0].split("#")[0].split("/").pop();
      const b = String(r?.targetFile || r?.to || r?.relatedFile || "").split("?")[0].split("#")[0].split("/").pop();
      return { pair: a && b ? `${a} × ${b}` : null, status: r?.status || "OBSERVED" };
    })
    .filter(x => x.pair)
    .filter((x,i,arr) => arr.findIndex(y => y.pair === x.pair) === i);

  const sayStatus = () => {
    if (state?.connection?.status === "OFFLINE" || state?.firestore?.error) {
      return `Untuk kondisi sekarang, saya belum mau bilang 100% aman. Koneksi Firestore sedang ${state.connection?.status || "bermasalah"}.`;
    }
    if (active.length) {
      const names = active.slice(0,4).map(([f]) => f).join(", ");
      return `Saya sudah cek. Sistem sedang hidup dan telemetry masuk, tapi belum bisa saya sebut sepenuhnya aman karena ada ${active.length} anomaly aktif: ${names}. Saya tetap memisahkan temuan aktif dari file yang hanya berstatus review.`;
    }
    return `Sejauh telemetry yang sedang hidup, sistem dalam kondisi baik: ${metrics.healthy ?? 0} file stabil, ${metrics.review ?? review.length} perlu review, dan tidak ada anomaly aktif. Koneksi Firestore ${state.connection?.status || "UNKNOWN"}.`;
  };

  if (!q) return "Siap. Ceritakan saja apa yang ingin kamu cek. Saya akan jawab dari keadaan BCGO yang sedang hidup, bukan dari tebakan.";

  if (/^(halo|hai|hello|pagi|siang|sore|malam)\b/.test(q)) {
    return `Hehe, iya 😊 Saya di sini. Sekarang saya sedang berada di cycle #${state.cycle ?? "-"}, tahap ${state.step || "-"} dan terus membaca telemetry BCGO. Kalau mau, langsung tanya sistem, file, hubungan antar-file, atau kasus yang sedang saya selidiki.`;
  }

  if (/aman|sehat|normal|kondisi sistem|status sistem|sistem aman/.test(q)) {
    return `Baik, saya cek dulu kondisi yang benar-benar saya punya sekarang. ${sayStatus()} Jadi saya tidak sekadar melihat lampu hijau; saya cocokkan koneksi, telemetry, anomaly, dan hasil scanner.`;
  }

  if (/sedang apa|lagi apa|sedang mengerjakan|ngapain|kerja apa/.test(q)) {
    const focus = active[0]?.[0] || state.targetCell || "seluruh organ";
    return `Saya sedang bekerja di cycle #${state.cycle ?? "-"}, tahap ${state.step || "-"}. Fokus saya sekarang ${focus}. ${state.message || "Saya sedang menjaga telemetry dan source scan tetap sinkron."} Kalau ada bukti baru, saya akan pindah fokus berdasarkan evidence, bukan sekadar nama file.`;
  }

  if (/hubungan|terhubung|relasi|dependency|terkait/.test(q)) {
    const file = requestedFile || state.targetCell || null;
    if (file) {
      const rel = relationFor(file);
      if (!rel.length) return `Saya sudah mencari relasi untuk ${file}, tetapi pada snapshot scanner saat ini belum ada pasangan source yang bisa saya tampilkan sebagai hubungan terdeteksi. Saya tidak akan mengarang relasi.`;
      return `Untuk ${file}, saya menemukan ${rel.length} hubungan source yang tercatat. Yang terlihat sekarang: ${rel.slice(0,6).map(x => `${x.pair} (${x.status})`).join("; ")}. Jadi pasangan yang muncul di kartu memang berasal dari hasil scanner, bukan dekorasi UI.`;
    }
    return `Saat ini scanner mencatat ${relations.length} relasi antar-file. Sebutkan nama file, misalnya “hubungan agentcgo.html”, dan saya bisa uraikan pasangan yang terdeteksi.`;
  }

  if (requestedFile) {
    const info = organs[requestedFile];
    const rel = relationFor(requestedFile);
    const status = info?.state || "UNKNOWN";
    const finding = findings.find(f => String(f?.file || f?.sourceFile || f?.targetFile || "").includes(requestedFile));
    const relationText = rel.length ? rel.slice(0,4).map(x => `${x.pair} [${x.status}]`).join("; ") : "belum ada relasi yang terbukti";
    if (!info) return `Saya mengenali ${requestedFile}, tetapi snapshot live belum membawa status file itu.`;
    return `Oke, saya cek ${requestedFile}. Statusnya ${status}. ${info.message || "Belum ada pesan tambahan."} Hubungan yang saya punya: ${relationText}.${finding ? ` Ada temuan terkait: ${finding.message || finding.detail || finding.type || "temuan scanner"}.` : ""}`;
  }

  if (/error|masalah|anomaly|gangguan|rusak/.test(q)) {
    if (!active.length) return `Saya sudah cek telemetry aktif. Saat ini tidak ada anomaly aktif. Ada ${review.length} file yang masih perlu review, jadi “tidak ada anomaly aktif” bukan berarti saya mengklaim semua source sempurna.`;
    return `Iya, ada ${active.length} anomaly aktif. Yang paling menonjol ${active.slice(0,4).map(([f,v]) => `${f}: ${v.message || "temuan aktif"}`).join(" | ")}. Saya akan mempertahankan evidence-nya sebelum menyebut root cause.`;
  }

  if (/root cause|akar masalah|penyebab|kenapa|mengapa/.test(q)) {
    const root = reasoning?.rootCause || null;
    if (root) return `Untuk kasus ${target}, root cause sudah tercatat: ${root.statement}. Saya hanya menyebutnya root cause karena sudah masuk proof chain CGO.`;
    const blockers = proof.blockers?.length ? proof.blockers.slice(0,4).join(", ") : "evidence kausal belum cukup";
    return `Saya belum mau menyebut root cause. Saat ini yang paling aman adalah ${blockers}. Hipotesis boleh ada, tetapi belum saya naikkan menjadi fakta.`;
  }

  if (/bukti|evidence|telemetry/.test(q)) {
    const evidence = Array.isArray(snapshot?.reasoning?.evidence) ? snapshot.reasoning.evidence : [];
    const verified = evidence.filter(e => e?.status === "VERIFIED");
    const detail = verified.slice(0,4).map(e => e.claim || e.message || e.type).filter(Boolean).join(" | ");
    return `Yang bisa saya pertanggungjawabkan sekarang: ${verified.length} evidence terverifikasi dari ${evidence.length}. ${detail || "Belum ada evidence terverifikasi yang cukup untuk saya ceritakan lebih jauh."}`;
  }

  if (/data-cgo|data customer|customer|yang daftar|pendaftar|jumlah daftar/.test(q)) {
    const probeCount = Number(metrics.firestoreCount || 0);
    return `Saya menangkap maksudmu: kamu ingin angka data, bukan status source. Saat ini BCGO punya probe Firestore aktif dan snapshot terakhir membaca ${probeCount} dokumen pada sensor yang sedang dipantau. Tetapi saya belum punya bukti bahwa angka itu adalah total customer yang terdaftar; jadi saya tidak akan menyebutnya sebagai jumlah customer. Untuk angka pendaftaran yang benar, saya perlu membuka collection data yang memang menjadi sumber pendaftaran dan memverifikasi izin baca-nya.`;
  }

  if (/medicine|perbaiki|repair|solusi|patch/.test(q)) {
    if (!active.length) return "Belum ada kasus aktif yang cukup kuat untuk saya teruskan. Saya lebih baik menunggu evidence daripada membuat Medicine bekerja dari dugaan.";
    return `Saya bisa menyiapkan konteks untuk Medicine dari kasus ${active[0][0]}, tetapi root cause dan exact source tetap harus terbukti dulu. CGO tidak akan menganggap “target awal” sebagai penyebab hanya karena telemetry menunjuk ke sana.`;
  }

  if (/scan ulang|rescan|pindai ulang|cek ulang/.test(q)) {
    return `Bisa. Saya sedang menjaga source scanner tetap berjalan. Permintaanmu saya perlakukan sebagai permintaan pemeriksaan ulang, tetapi saya tidak akan mengubah source hanya karena diminta lewat chat.`;
  }

  return `Saya paham. Untuk “${raw}”, saya bisa bantu, tapi saya ingin jawab dengan fakta yang memang tersedia di BCGO. Sekarang fokus saya ${target}, cycle #${state.cycle ?? "-"}, dengan ${metrics.active ?? active.length} anomaly aktif dan ${relations.length} relasi source yang sudah terdeteksi. Kalau kamu sebut file atau data yang ingin dilihat, saya akan uraikan dari evidence yang ada.`;
}

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

  const evaluation = Logic.evaluate(c, { allowAutomaticExecution: true, automaticPatch: true, automaticExecution: true }, knowledge);
  const active = activeEngines.get(caseId);
  const investigation = active ? active.snapshot() : Investigator.createInvestigation(c, knowledge);
  const probe = active && active.state.status === "ACTIVE"
    ? (active.state.probeLog.at(-1) || Investigator.nextProbe(investigation, c, knowledge))
    : Investigator.nextProbe(investigation, c, knowledge);
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

  return {
    version: VERSION,
    brainVersion: Core.VERSION,
    logicVersion: Logic.VERSION,
    cognitionVersion: Cognition.VERSION,
    guardianVersion: evaluation.guardian?.policyVersion || "1",
    signal,
    at: Date.now(),
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
    guardian: {
      healthy: evaluation.guardian?.decision !== "BLOCKED",
      level: evaluation.guardian?.risk || "UNKNOWN",
      issues: evaluation.guardian?.reason ? [evaluation.guardian.reason] : []
    }
  };
}

export function install() {
  return {
    version: VERSION,
    ingestBCGOState(state = {}) {
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
    ask(question) { return chatAnswer(question); },
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

  const evaluation = Logic.evaluate(c, { allowAutomaticExecution: true, automaticPatch: true, automaticExecution: true }, knowledge);
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
