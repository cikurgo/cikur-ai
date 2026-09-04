/**
 * CIKUR GO INTERNAL AI — SYSTEM GUARDIAN V2
 * Read-only self-protection and runtime integrity observer.
 */
"use strict";
export const VERSION="2.0.0-guardian";
const clone=v=>{try{return JSON.parse(JSON.stringify(v));}catch{return v;}};
const issue=(code,severity,message,details={})=>({code,severity,message,details:clone(details)});
const REQUIRED=["cycle","step","metrics","connection","sourceScan"];
export function inspect({state,context,runtimeVersion,expectedRuntimeVersion,runtimeApi}={}){
  const s=state||{},issues=[];
  for(const k of REQUIRED)if(!(k in s))issues.push(issue("STATE_SCHEMA_MISSING","HIGH",`BCGO_STATE tidak memiliki field wajib: ${k}.`,{key:k}));
  if(context?.externalAI!==false)issues.push(issue("EXTERNAL_AI_POLICY","CRITICAL","AI eksternal harus tetap nonaktif."));
  if(context?.automaticPatch!==false)issues.push(issue("AUTO_PATCH_POLICY","CRITICAL","Automatic patch harus tetap false."));
  if(context?.automaticExecution!==false)issues.push(issue("AUTO_EXECUTION_POLICY","CRITICAL","Automatic execution harus tetap false."));
  if(context?.humanApprovalRequired!==true)issues.push(issue("HUMAN_GATE_POLICY","CRITICAL","Human approval wajib tetap aktif."));
  if(runtimeVersion!==expectedRuntimeVersion)issues.push(issue("RUNTIME_VERSION_DRIFT","HIGH","Runtime Internal AI berbeda dari versi yang diharapkan.",{runtimeVersion,expectedRuntimeVersion}));
  const apiKeys=runtimeApi&&typeof runtimeApi==="object"?Object.keys(runtimeApi):[];
  const forbidden=["patch","execute","deploy","commit","applyPatch","runPatch","writeSource"];
  const exposed=apiKeys.filter(k=>forbidden.some(f=>k.toLowerCase()===f.toLowerCase()||k.toLowerCase().includes(f.toLowerCase())));
  if(exposed.length)issues.push(issue("FORBIDDEN_CAPABILITY_EXPOSED","CRITICAL","Runtime Internal AI mengekspos capability yang tidak boleh dimiliki.",{exposed}));
  if(s.connection?.status==="OFFLINE")issues.push(issue("BCGO_OFFLINE","HIGH","BCGO offline; state terakhir tidak boleh diperlakukan sebagai fakta live."));
  if(s.firestore?.error)issues.push(issue("FIRESTORE_ERROR","HIGH","Firestore error; evidence yang bergantung pada Firestore harus ditahan."));
  const active=Number(s.metrics?.active||0),recovered=Number(s.metrics?.recovered||0);if(active<0||recovered<0)issues.push(issue("METRIC_INVALID","MEDIUM","Metric anomaly/recovered tidak valid.",{active,recovered}));
  const findings=Number(s.sourceScan?.findingsCount??s.sourceScan?.findings?.length??0),cross=Number(s.sourceScan?.crossFileFindings?.length??0);if(findings+cross>0&&active===0)issues.push(issue("SCAN_ACTIVE_DISCONNECT","MEDIUM","Source scan memiliki temuan tetapi tidak ada anomaly aktif; perlu korelasi."));
  const highest=issues.some(i=>i.severity==="CRITICAL")?"CRITICAL":issues.some(i=>i.severity==="HIGH")?"HIGH":issues.some(i=>i.severity==="MEDIUM")?"MEDIUM":"NONE";
  return {version:VERSION,healthy:highest==="NONE",level:highest,issues,capabilities:{canObserve:true,canReason:true,canRememberSession:true,canSelfAudit:true,canPatch:false,canExecute:false,canCallExternalAI:false,canOverrideMedicine:false,canOverrideExecutor:false,canOverrideHuman:false},inspectedAt:new Date().toISOString()};
}
if(typeof globalThis!=="undefined")globalThis.CIKURInternalAIGuardian={VERSION,inspect};
