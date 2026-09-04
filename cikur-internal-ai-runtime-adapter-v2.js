/**
 * CIKUR GO INTERNAL AI — RUNTIME ADAPTER V2
 * Real-time internal intelligence junction for BCGO.
 * No external AI/API. No source mutation. No execution.
 */
"use strict";

export const VERSION = "2.0.0-runtime-adapter";
export const INTERNAL_AI_EVENTS = Object.freeze({
  STATE: "cikur-internal-ai-state",
  CASE: "cikur-internal-ai-case",
  READY: "cikur-internal-ai-ready",
  THOUGHT: "cikur-internal-ai-thought"
});

const clone = value => { try { return JSON.parse(JSON.stringify(value)); } catch { return value; } };
const emit = (name, detail) => { try { window.dispatchEvent(new CustomEvent(name, { detail: clone(detail) })); } catch {} };

function normalize(state) {
  return {
    source: "BCGO_STATE",
    capturedAt: Date.now(),
    cycle: Number(state?.cycle || 0),
    step: state?.step || "UNKNOWN",
    cycleMode: state?.cycleMode || "UNKNOWN",
    targetCell: state?.targetCell || null,
    message: String(state?.message || ""),
    errorLog: state?.errorLog || null,
    metrics: clone(state?.metrics || {}),
    firestore: clone(state?.firestore || {}),
    connection: clone(state?.connection || {}),
    activeCases: clone(Array.isArray(state?.activeCases) ? state.activeCases : []),
    recentEvents: clone(Array.isArray(state?.recentEvents) ? state.recentEvents.slice(0,24) : []),
    latestLogs: clone(Array.isArray(state?.systemLogs) ? state.systemLogs.slice(0,50) : []),
    sourceScan: clone(state?.sourceScan || {}),
    medicineBridge: clone(state?.medicineBridge || {}),
    executionBridge: clone(state?.executionBridge || {})
  };
}

function signal(t) {
  if (t.firestore?.error || t.connection?.status === "OFFLINE") return "INFRASTRUCTURE_ERROR";
  if (t.activeCases.length || Number(t.metrics?.active || 0) > 0) return "ATTENTION";
  if (Number(t.sourceScan?.findings?.length || 0) || Number(t.sourceScan?.crossFileFindings?.length || 0)) return "REVIEW_REQUIRED";
  return "STABLE";
}

function posture(t) {
  if (t.firestore?.error) return "Saya menahan kesimpulan karena kanal Firestore sedang bermasalah.";
  if (t.activeCases.length) return `Saya sedang menjaga ${t.activeCases.length} kasus aktif dan belum menganggapnya selesai sebelum bukti cukup.`;
  if (Number(t.sourceScan?.filesFailed || 0) > 0) return `Saya menemukan ${t.sourceScan.filesFailed} source yang belum terbaca; bukti belum lengkap.`;
  if (Number(t.sourceScan?.findings?.length || 0) + Number(t.sourceScan?.crossFileFindings?.length || 0) > 0) return "Scanner menemukan bukti yang perlu diverifikasi, bukan langsung saya jadikan akar masalah.";
  return "Saya sedang memantau telemetry dan source evidence secara real-time.";
}

function answer(question, snap) {
  const q = String(question || "").trim().toLowerCase();
  const t = snap?.telemetry;
  if (!t) return "Kanal intelligence belum menerima BCGO_STATE. Saya menunggu impuls pertama.";
  const active = t.activeCases;
  const total = Number(t.metrics?.total || 0);
  const healthy = Number(t.metrics?.healthy || 0);
  const recovered = Number(t.metrics?.recovered || 0);
  const findings = Number(t.sourceScan?.findings?.length || 0) + Number(t.sourceScan?.crossFileFindings?.length || 0);
  const conn = t.connection?.status || "UNKNOWN";
  const target = t.targetCell || "-";
  const file = t.activeCases[0]?.target || t.targetCell || t.latestLogs[0]?.fileName || "-";

  if (!q) return "Saya aktif. Beri saya pertanyaan tentang apa yang sedang saya lihat, bukti terbaru, kasus aktif, atau hubungan saya dengan Medicine.";
  if (/halo|hai|hello|pagi|siang|sore|malam|siapa kamu/.test(q)) return `Halo. Saya CIKUR GO Internal Intelligence yang bekerja melalui saraf BCGO. Sekarang cycle #${t.cycle}, tahap ${t.step}. ${posture(t)}`;
  if (/sedang apa|sedang mengerjakan|lagi apa|ngapain|kerja apa/.test(q)) return `Saya sedang di tahap ${t.step}, cycle #${t.cycle}. ${t.message} ${posture(t)}`;
  if (/status|kondisi|aman|sehat/.test(q)) return `Status intelligence: ${signal(t)}. ${active.length} kasus aktif, ${healthy} stabil, ${recovered} recovered dari ${total} organ. Koneksi ${conn}.`;
  if (/error|masalah|anomali|gangguan/.test(q)) return active.length ? `Saya melihat ${active.length} kasus aktif. Fokus pertama saya ${file}. Saya menjaga bukti: ${String(active[0]?.evidence?.message || active[0]?.evidence?.sourceFinding?.message || "telemetry aktif").slice(0,500)}. Saya belum menyebut root cause sebelum Medicine memverifikasinya.` : `Saat ini saya belum melihat kasus aktif. Saya tetap mendengarkan telemetry baru secara real-time.`;
  if (/bukti|evidence|lihat apa|apa yang kamu lihat/.test(q)) return `Bukti yang sedang saya pegang: ${t.latestLogs.length} telemetry terbaru, ${findings} temuan scanner, ${active.length} kasus aktif. Target saraf ${target}. Bukti yang belum terverifikasi tidak saya naikkan menjadi diagnosis.`;
  if (/medicine|obat|repair|perbaikan|perbaiki/.test(q)) return active.length ? `Saya siap mengirim konteks kasus ${file} ke Medicine. Peran saya adalah merapikan telemetry dan evidence; Medicine tetap wajib memastikan root cause dan exact source sebelum solusi.` : "Belum ada kasus aktif yang cukup kuat untuk saya kirim. Saya tidak akan membuat solusi dari dugaan.";
  if (/executor|eksekusi|jalankan/.test(q)) return "Saya tidak mengeksekusi perubahan. Setelah Medicine memverifikasi kasus dan solusi, Executor tetap menjadi gerbang deterministik dan human approval tetap wajib.";
  if (/cycle|siklus|tahap|posisi/.test(q)) return `Saya berada di cycle #${t.cycle}, tahap ${t.step}, mode ${t.cycleMode}. Target ${target}.`;
  if (/file|organ|pantau/.test(q)) return `Saya membaca ${total} organ. Saat ini ${healthy} stabil, ${active.length} aktif, ${recovered} recovered. Target yang sedang saya pegang: ${target}.`;
  return `Saya menangkap: “${String(question).slice(0,180)}”. Dari state hidup yang saya miliki sekarang, saya belum punya bukti yang cukup untuk menjawab lebih spesifik. Saya tidak akan mengarang.`;
}

export function install() {
  if (typeof window === "undefined") throw new Error("RUNTIME_ADAPTER_BROWSER_ONLY");
  if (window.CIKURInternalAIRuntime?.version === VERSION) return window.CIKURInternalAIRuntime;
  let latest = null;
  let lastThoughtKey = "";
  let lastCycle = -1;

  function ingestBCGOState(state) {
    latest = { version: VERSION, type: "CIKUR_INTERNAL_AI_SNAPSHOT", at: Date.now(), signal: signal(normalize(state)), telemetry: normalize(state), policy: { inference:"CONSTRAINED_INTERNAL", sourceRequired:true, unresolvedEvidenceBlocksCandidate:true, automaticPatch:false, automaticExecution:false, humanApprovalRequired:true } };
    emit(INTERNAL_AI_EVENTS.STATE, latest);
    for (const c of latest.telemetry.activeCases.slice(0,10)) emit(INTERNAL_AI_EVENTS.CASE, { version:VERSION, at:Date.now(), case:clone(c), source:"BCGO_STATE" });

    const t = latest.telemetry;
    const event = t.recentEvents[0];
    const key = `${event?.type||""}|${event?.message||""}|${event?.at||""}|${t.step}|${t.cycle}`;
    const meaningful = event && (event.type === "TELEMETRY" || event.type === "SOURCE_SCAN_RESULT" || event.type === "FIRESTORE_ERROR" || event.type === "MEDICINE" || event.type === "EXECUTION");
    if (meaningful && key !== lastThoughtKey) {
      lastThoughtKey = key; lastCycle = t.cycle;
      emit(INTERNAL_AI_EVENTS.THOUGHT, { version:VERSION, at:Date.now(), signal:latest.signal, step:t.step, cycle:t.cycle, text: posture(t), event:clone(event||null) });
    }
    return clone(latest);
  }

  const api = Object.freeze({
    version: VERSION,
    events: INTERNAL_AI_EVENTS,
    ingestBCGOState,
    getSnapshot: () => clone(latest),
    ask: question => answer(question, latest),
    getPosture: () => latest ? posture(latest.telemetry) : "Menunggu BCGO_STATE.",
    reset: () => { latest = null; lastThoughtKey = ""; lastCycle = -1; }
  });
  window.CIKURInternalAIRuntime = api;
  emit(INTERNAL_AI_EVENTS.READY, { version:VERSION, at:Date.now() });
  return api;
}

if (typeof globalThis !== "undefined") globalThis.CIKURInternalAIRuntimeAdapter = { VERSION, INTERNAL_AI_EVENTS, install };
