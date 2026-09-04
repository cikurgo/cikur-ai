/**
 * CIKUR GO INTERNAL AI — SYSTEM GUARDIAN V1
 * Read-only runtime safety observer.
 * It does not patch, execute, or call external AI/API.
 */
"use strict";

export const VERSION = "1.0.0-guardian";

const REQUIRED_STATE_KEYS = ["cycle","step","metrics","connection","sourceScan"];
const clone = v => { try { return JSON.parse(JSON.stringify(v)); } catch { return v; } };

function issue(code, severity, message, details = {}) {
  return { code, severity, message, details: clone(details) };
}

export function inspect({ state, context, runtimeVersion, expectedRuntimeVersion }) {
  const issues = [];
  const s = state || {};

  for (const key of REQUIRED_STATE_KEYS) {
    if (!(key in s)) issues.push(issue("STATE_SCHEMA_MISSING", "HIGH", `BCGO_STATE tidak memiliki field wajib: ${key}.`, { key }));
  }

  if (context && context.externalAI !== false)
    issues.push(issue("EXTERNAL_AI_POLICY", "CRITICAL", "Kebijakan Internal AI tidak secara eksplisit menonaktifkan AI eksternal."));
  if (context && context.automaticPatch !== false)
    issues.push(issue("AUTO_PATCH_POLICY", "CRITICAL", "Automatic patch harus tetap false."));
  if (context && context.automaticExecution !== false)
    issues.push(issue("AUTO_EXECUTION_POLICY", "CRITICAL", "Automatic execution harus tetap false."));
  if (context && context.humanApprovalRequired !== true)
    issues.push(issue("HUMAN_GATE_POLICY", "CRITICAL", "Human approval wajib tetap aktif."));

  if (expectedRuntimeVersion && runtimeVersion !== expectedRuntimeVersion)
    issues.push(issue("RUNTIME_VERSION_DRIFT", "HIGH", "Runtime Internal AI yang aktif berbeda dari versi yang diharapkan.", { runtimeVersion, expectedRuntimeVersion }));

  const connection = s.connection || {};
  if (connection.status === "OFFLINE")
    issues.push(issue("BCGO_OFFLINE", "HIGH", "BCGO kehilangan koneksi live; reasoning harus diperlakukan sebagai state terakhir, bukan fakta live."));

  if (s.firestore?.error)
    issues.push(issue("FIRESTORE_ERROR", "HIGH", "Firestore melaporkan error; evidence yang bergantung pada Firestore perlu ditahan."));

  const metrics = s.metrics || {};
  const active = Number(metrics.active || 0);
  const recovered = Number(metrics.recovered || 0);
  if (active < 0 || recovered < 0)
    issues.push(issue("METRIC_INVALID", "MEDIUM", "Metric anomaly/recovered bernilai tidak valid.", { active, recovered }));

  const findings = Number(s.sourceScan?.findingsCount ?? s.sourceScan?.findings?.length ?? 0);
  const cross = Number(s.sourceScan?.crossFileFindings?.length ?? 0);
  if (findings + cross > 0 && active === 0)
    issues.push(issue("SCAN_ACTIVE_DISCONNECT", "MEDIUM", "Source scan memiliki temuan tetapi tidak ada anomaly aktif; status perlu korelasi sebelum dianggap kasus aktif.", { findings, cross }));

  const highest = issues.some(i => i.severity === "CRITICAL") ? "CRITICAL"
    : issues.some(i => i.severity === "HIGH") ? "HIGH"
    : issues.some(i => i.severity === "MEDIUM") ? "MEDIUM" : "NONE";

  return {
    version: VERSION,
    healthy: highest === "NONE",
    level: highest,
    issues,
    capabilities: {
      canObserve: true,
      canReason: true,
      canRememberSession: true,
      canPatch: false,
      canExecute: false,
      canCallExternalAI: false,
      canOverrideMedicine: false,
      canOverrideExecutor: false,
      canOverrideHuman: false
    },
    inspectedAt: new Date().toISOString()
  };
}

if (typeof globalThis !== "undefined") globalThis.CIKURInternalAIGuardian = { VERSION, inspect };
