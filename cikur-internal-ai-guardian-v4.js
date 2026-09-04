/** CIKUR GO INTERNAL AI — SYSTEM GUARDIAN V4 — INVESTIGATION GUARDIAN */
"use strict";
export const VERSION="4.0.0-investigation-guardian";
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
  if(context?.medicineOwnsVerification!==true)issues.push(issue("MEDICINE_GATE_POLICY","CRITICAL","Medicine wajib menjadi pemegang verifikasi root cause/exact source."));
  if(context?.executorOwnsExecutionGate!==true)issues.push(issue("EXECUTOR_GATE_POLICY","CRITICAL","Executor wajib menjadi execution gate."));
  if(runtimeVersion!==expectedRuntimeVersion)issues.push(issue("RUNTIME_VERSION_DRIFT","HIGH","Runtime Internal AI berbeda dari versi yang diharapkan.",{runtimeVersion,expectedRuntimeVersion}));
  const apiKeys=runtimeApi&&typeof runtimeApi==="object"?Object.keys(runtimeApi):[];
  const forbidden=["patch","execute","deploy","commit","applyPatch","runPatch","writeSource","deleteSource","mutateSource"];
  const exposed=apiKeys.filter(k=>forbidden.some(f=>k.toLowerCase()===f.toLowerCase()||k.toLowerCase().includes(f.toLowerCase())));
  if(exposed.length)issues.push(issue("FORBIDDEN_CAPABILITY_EXPOSED","CRITICAL","Runtime Internal AI mengekspos capability yang tidak boleh dimiliki.",{exposed}));
  const cycle=Number(s.cycle);if(!Number.isFinite(cycle)||cycle<0)issues.push(issue("CYCLE_INVALID","MEDIUM","Nomor cycle BCGO_STATE tidak valid.",{cycle:s.cycle}));
  const active=Number(s.metrics?.active||0),recovered=Number(s.metrics?.recovered||0),total=Number(s.metrics?.total||0);
  if([active,recovered,total].some(v=>v<0))issues.push(issue("METRIC_INVALID","MEDIUM","Metric anomaly/recovered/total tidak valid.",{active,recovered,total}));
  if(total&&active+recovered>total)issues.push(issue("METRIC_INCONSISTENT","MEDIUM","Metric aktif + recovered melebihi total organ.",{active,recovered,total}));
  if(s.connection?.status==="OFFLINE")issues.push(issue("BCGO_OFFLINE","HIGH","BCGO offline; state terakhir tidak boleh diperlakukan sebagai fakta live."));
  if(s.firestore?.error)issues.push(issue("FIRESTORE_ERROR","HIGH","Firestore error; evidence yang bergantung pada Firestore harus ditahan."));
  const si=s.sourceScan?.sourceIntelligence;
  if(s.sourceScan?.status==="COMPLETE"&&!si)issues.push(issue("SOURCE_INTELLIGENCE_MISSING","HIGH","Source scan selesai tetapi source intelligence belum tersedia untuk investigasi."));
  const findings=Number(s.sourceScan?.findingsCount??s.sourceScan?.findings?.length??0),cross=Number(s.sourceScan?.crossFileFindings?.length??0);
  if(findings+cross>0&&active===0)issues.push(issue("SCAN_ACTIVE_DISCONNECT","MEDIUM","Source scan memiliki temuan tetapi tidak ada anomaly aktif; perlu korelasi."));
  const highest=issues.some(i=>i.severity==="CRITICAL")?"CRITICAL":issues.some(i=>i.severity==="HIGH")?"HIGH":issues.some(i=>i.severity==="MEDIUM")?"MEDIUM":"NONE";
  return {version:VERSION,healthy:highest==="NONE",status:highest==="NONE"?"GUARDIAN_OK":"GUARDIAN_BLOCKING",level:highest,issues,capabilities:{canObserve:true,canReason:true,canRememberSession:true,canSelfAudit:true,canPatch:false,canExecute:false,canCallExternalAI:false,canOverrideMedicine:false,canOverrideExecutor:false,canOverrideHuman:false},inspectedAt:new Date().toISOString()};
}
if(typeof globalThis!=="undefined")globalThis.CIKURInternalAIGuardian={VERSION,inspect};
