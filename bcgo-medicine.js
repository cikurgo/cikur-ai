/* CIKUR GO — MEDICINE v5.0.0
 * Investigator only. BCGO is the source of truth; Medicine reads, proves and hands off.
 * No external AI/API. No source mutation here.
 */
import { collection,onSnapshot,query,orderBy,limit,addDoc,serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { doc,getDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { adminDb,adminAuth } from "./cikur-config.js?v=20260913-medicine5";
import { install as installBridge } from "./cgo-bcgo-bridge.js?v=20260913-me6";

const BRIDGE=installBridge(),db=adminDb,auth=adminAuth;
const VERSION="5.0.0-MEDICINE-BCGO-FIRST";
const TEAM=typeof BroadcastChannel!=="undefined"?new BroadcastChannel(BRIDGE.channel):null;
const KEY="CIKUR_GO_MEDICINE_RUNTIME_V5";
const S={authorized:false,uid:null,role:null,status:"BOOT",bcgo:null,scan:null,cases:[],active:null,events:[],executor:{status:"WAITING",available:false},lastRevision:null,lastCaseRevision:null};
const now=()=>new Date().toISOString(), id=p=>`${p}-${Date.now()}-${Math.random().toString(36).slice(2,9)}`, norm=v=>String(v||"").replace(/^\.\//,"").split("?")[0].split("#")[0];
const clone=v=>{try{return typeof structuredClone==="function"?structuredClone(v):JSON.parse(JSON.stringify(v));}catch{return v;}};
function save(){try{localStorage.setItem(KEY,JSON.stringify({...S,cases:S.cases.slice(0,30),events:S.events.slice(0,80)}));}catch{}}
function emit(type,p={}){const e={id:id("EV"),type,at:now(),...clone(p)};S.events.unshift(e);S.events=S.events.slice(0,120);save();try{window.dispatchEvent(new CustomEvent("bcgo:medicine",{detail:e}));}catch{};render();return e;}
function team(type,p={}){const packet=BRIDGE.publishTeamReport(type,{from:"MEDICINE",version:VERSION,...clone(p)});try{TEAM?.postMessage(packet);}catch{};emit(type,{packet});return packet;}
function fingerprint(s){let h=0x811c9dc5;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,0x01000193);}return (h>>>0).toString(16).padStart(8,"0");}
function source(file){return S.scan?.sources?.[norm(file)]?.rawSource||null;}
async function fetchSource(file){file=norm(file);const s=source(file);if(typeof s==="string"&&s.length)return s;try{const r=await fetch(new URL(file,location.href).href,{cache:"no-store",credentials:"same-origin"});if(!r.ok)throw Error(`HTTP_${r.status}`);return await r.text();}catch(e){emit("SOURCE_READ_FAILED",{file,error:String(e.message||e)});return null;}}
function actionableFindings(file){const a=[...(S.scan?.findings||[]),...(S.scan?.crossFileFindings||[])];return a.filter(f=>norm(f.file||f.sourceFile||f.targetFile)===norm(file)&&String(f.severity||"").toUpperCase()!=="INFO");}
function makeCase(f){const file=norm(f?.file||f?.sourceFile||f?.targetFile);if(!file)return null;let c=S.cases.find(x=>x.file===file&&x.signature===String(f.message||f.type||""));if(!c){c={id:id("CASE"),file,signature:String(f.message||f.type||"BCGO finding"),status:"QUEUED",revision:S.scan?.rescanGeneration||0,evidence:[clone(f)],rootCause:null,candidate:null,updatedAt:now()};S.cases.unshift(c);S.cases=S.cases.slice(0,30);}else c.evidence=[...c.evidence,clone(f)].slice(-12);return c;}
function exactRecipe(src,f){
  if(typeof f?.before==="string"&&typeof f?.after==="string"&&f.before&&src.split(f.before).length===2)return {operation:"REPLACE_EXACT",before:f.before,after:f.after,confidence:"HIGH"};
  if(String(f?.type||"")==="UNBALANCED_HTML"){
    const m=String(f.message||"").match(/<([a-z0-9-]+)> belum memiliki penutup/i); if(!m)return null;
    const tag=m[1].toLowerCase(),open=(src.match(new RegExp(`<${tag}\\b`,"gi"))||[]).length,close=(src.match(new RegExp(`</${tag}>`,"gi"))||[]).length;
    if(tag!=="div"||open!==close+1)return null;
    const anchor=src.trimEnd().slice(-1);if(!anchor)return null;
    return {operation:"INSERT_EXACT",before:anchor,after:`\n</div>`,confidence:"HIGH"};
  }
  return null;
}
function simulate(src,r){
  const escaped=String(r?.before||"").replace(/[.*+?^${}()|[\\]\\]/g,"\\$&");
  const n=(src.match(new RegExp(escaped,"g"))||[]).length;
  if(n!==1)return null;
  const out=r.operation==="REPLACE_EXACT"?src.replace(r.before,r.after):src.replace(r.before,r.before+r.after);
  if(out===src)return null;
  return {sourceAfter:out,beforeFingerprint:fingerprint(src),afterFingerprint:fingerprint(out)};
}
async function investigate(c,why="BCGO"){
  if(!S.authorized||!c)return false;
  const rev=Number(S.scan?.rescanGeneration||0); if(c.lastInvestigated===rev)return false; c.lastInvestigated=rev;c.status="INVESTIGATING";c.updatedAt=now();
  team("MEDICINE_INVESTIGATION",{caseId:c.id,investigationId:id("INV"),phase:"READ_SOURCE",target:c.file,revision:rev,evidenceCount:c.evidence.length,message:`Medicine membaca source aktual ${c.file}; penyebab belum dianggap terbukti sebelum source exact diperiksa.`});
  const src=await fetchSource(c.file); if(src==null){c.status="BLOCKED";c.blocker="SOURCE_NOT_AVAILABLE";emit("INVESTIGATION_BLOCKED",{caseId:c.id,blocker:c.blocker});return false;}
  const findings=actionableFindings(c.file); const exact=findings.find(f=>f.proofStatus==="SOURCE_EXACT")||findings[0]||c.evidence[0];
  c.rootCause=exact?{type:exact.type||"SOURCE_FINDING",message:exact.message||"Source finding",file:c.file,proofStatus:exact.proofStatus||"OBSERVED"}:null;
  const recipe=exactRecipe(src,exact||{}); const sim=recipe?simulate(src,recipe):null;
  c.sourceFingerprint=fingerprint(src);c.sourceLines=src.split("\n").length;c.status="EVIDENCE_FOUND";
  team("MEDICINE_EVIDENCE",{caseId:c.id,target:c.file,revision:rev,sourceFingerprint:c.sourceFingerprint,sourceLines:c.sourceLines,evidence:findings.slice(0,10),message:`Source aktual ${c.file} terbaca (${c.sourceLines} baris).`});
  if(sim){c.candidate={proposalId:id("PROP"),requestId:id("REQ"),caseId:c.id,file:c.file,operation:recipe.operation,before:recipe.before,after:recipe.after,expectedFingerprint:sim.beforeFingerprint,proposedSource:sim.sourceAfter,proposedFingerprint:sim.afterFingerprint,confidence:recipe.confidence,rootCause:c.rootCause};c.status="CANDIDATE_READY";team("MEDICINE_REPAIR_CANDIDATE",{caseId:c.id,proposalId:c.candidate.proposalId,requestId:c.candidate.requestId,file:c.file,sourceText:src,candidate:c.candidate,request:c.candidate,message:"Candidate deterministic terbentuk dari source exact. Executor diminta review; belum ada eksekusi."});
  }else{c.status="ROOT_CAUSE_FOUND";c.blocker="NO_SAFE_DETERMINISTIC_RECIPE";team("MEDICINE_CGO_BLOCKED",{caseId:c.id,target:c.file,phase:"ROOT_CAUSE_FOUND",message:"Evidence ditemukan tetapi tidak ada recipe deterministic yang cukup aman. Medicine tidak mengarang BEFORE→AFTER."});}
  save();render();return true;
}
function ingest(state){
  if(!state||typeof state!=="object")return;
  S.bcgo=clone(state);S.scan=state.sourceScan||null;S.status="BCGO_LIVE";
  const rev=Number(S.scan?.rescanGeneration||state.cycle||0);
  const isNewRevision=rev!==S.lastRevision;
  if(isNewRevision)S.lastRevision=rev;
  const findings=[...(S.scan?.findings||[]),...(S.scan?.crossFileFindings||[])].filter(f=>String(f.severity||"").toUpperCase()!=="INFO");
  if(isNewRevision){for(const f of findings.slice(0,20)){const c=makeCase(f);if(c&&!S.active)S.active=c;}}
  const active=Array.isArray(state.activeCases)?state.activeCases:[];
  for(const bc of active.slice(0,20)){const f=bc.evidence||bc;const c=makeCase({file:bc.target||bc.file||f.file,type:f.type||"BCGO_ACTIVE_CASE",message:f.message||bc.message||"Active BCGO case",proofStatus:f.proofStatus});if(c){c.bcgoCaseId=bc.id||null;c.evidence.push(clone(f));S.active=c;}}
  // Authorization can arrive after the BCGO snapshot. Do not require a new
  // revision just to start an investigation; hydrate first, then investigate.
  if(S.authorized){for(const c of S.cases.slice(0,20)){if(c&&c.lastInvestigated!==rev)void investigate(c,isNewRevision?"BCGO_NEW_SCAN":"BCGO_STATE_RECOVERY");}}
  emit("BCGO_STATE_RECEIVED",{cycle:state.cycle,revision:rev,active:state.metrics?.active||0,total:state.metrics?.total||0,recovered:!isNewRevision});
}
function handleTeam(p){if(!p||p.bridge!==BRIDGE.channel)return;if(p.from==="EXECUTION"){if(p.type==="EXECUTION_INVESTIGATION_ACK"){S.executor={available:true,status:p.status||"RECEIVED"};emit("EXECUTOR_ACK",{packet:p});}if(p.type==="EXECUTION_REVIEW_RESULT"){const c=S.cases.find(x=>x.id===p.caseId);if(c){c.review=p.review||null;c.status=p.review?.status==="VALID"?"WAITING_HUMAN_APPROVAL":"BLOCKED";S.executor={available:true,status:p.review?.status||"REJECTED"};team(c.status==="WAITING_HUMAN_APPROVAL"?"MEDICINE_HUMAN_GATE_READY":"MEDICINE_CGO_BLOCKED",{caseId:c.id,message:c.status==="WAITING_HUMAN_APPROVAL"?"Executor VALID. Human approval sekarang menjadi satu-satunya gate sebelum eksekusi.":`Executor menolak candidate: ${p.review?.reason||"REVIEW_REJECTED"}.`});render();}}
 if(p.type==="EXECUTION_RESULT"){const c=S.cases.find(x=>x.id===p.caseId);if(c){c.execution=p.result;c.status=p.result?.status==="SUCCESS"?"VALIDATING":"EXECUTION_FAILED";render();}}
 }
 if(p.from==="CAPTAIN"&&p.type==="CAPTAIN_EXECUTION_AUTHORIZATION"){const c=S.cases.find(x=>x.id===p.caseId);if(c&&c.candidate){c.authorization=p.authorization;c.status="READY_FOR_EXECUTION";team("MEDICINE_EXECUTION_AUTHORIZED",{caseId:c.id,requestId:p.requestId,authorizationId:p.authorization?.authorizationId,message:"Authorization Captain diterima; Executor menjadi satu-satunya target eksekusi."});}}
}
BRIDGE.onState(ingest);BRIDGE.onTeamReport(handleTeam);TEAM?.addEventListener("message",e=>handleTeam(e.data));window.addEventListener("storage",e=>{if(e.key===`${BRIDGE.channel}_EVENT`&&e.newValue){try{handleTeam(JSON.parse(e.newValue));}catch{}}});try{const recovered=BRIDGE.getState()||window.BCGO_STATE;if(recovered)ingest(recovered);}catch{}
try{const raw=localStorage.getItem(KEY);if(raw){const old=JSON.parse(raw);Object.assign(S,old,{events:old.events||[],cases:old.cases||[]});}}catch{}
async function boot(){onAuthStateChanged(auth,async user=>{S.uid=user?.uid||null;if(!user){S.authorized=false;S.status="AUTH_REQUIRED";emit("AUTH_REQUIRED",{message:"Medicine menunggu sesi Admin."});return;}try{const snap=await getDoc(doc(db,"admin_users",user.uid)),d=snap.exists()?snap.data():null;S.role=d?.role||null;S.authorized=!!snap.exists()&&d?.active===true&&["admin","super_admin"].includes(String(d?.role||"").toLowerCase());S.status=S.authorized?"READY":"AUTH_REJECTED";emit(S.authorized?"AUTH_VERIFIED":"AUTH_REJECTED",{uid:user.uid,role:S.role});if(S.authorized){ingest(BRIDGE.getState()||window.BCGO_STATE||{});team("MEDICINE_READY",{message:"Medicine siap. BCGO_STATE adalah source of truth; investigasi otomatis aktif."});}}catch(e){S.authorized=false;S.status="AUTH_ERROR";emit("AUTH_ERROR",{message:String(e.message||e)});}});
 try{const q=query(collection(db,"system_logs"),orderBy("reportedAt","desc"),limit(30));onSnapshot(q,s=>emit("TELEMETRY",{count:s.size}),e=>emit("TELEMETRY_ERROR",{message:String(e.message||e)}));}catch{}
}
function render(){try{window.dispatchEvent(new CustomEvent("cgo-medicine-state",{detail:clone(S)}));}catch{}}
function command(text){
  const raw=String(text||"").trim();
  const m=raw.match(/(?:investigasi|selidiki|periksa|cek)(?:\\s+ulang)?\\s+([A-Za-z0-9._/-]+)(?:\\s|$)/i);
  if(!m)return {handled:false,reason:"FILE_TARGET_REQUIRED"};
  const file=norm(m[1]);
  let c=S.cases.find(x=>x.file===file);
  if(!c)c=makeCase({file,type:"HUMAN_INVESTIGATION",message:`Instruksi manusia: ${raw}`,proofStatus:"REQUESTED"});
  S.active=c;save();render();
  if(S.authorized)void investigate(c,"HUMAN_COMMAND");
  return {handled:true,caseId:c.id,file};
}
window.BCGOMedicine=Object.freeze({version:VERSION,getState:()=>clone(S),getActiveCase:()=>clone(S.active),refresh:()=>ingest(BRIDGE.getState()||window.BCGO_STATE),investigate:(caseId)=>{const c=S.cases.find(x=>x.id===caseId);return investigate(c,"HUMAN_REQUEST")},command,getCases:()=>clone(S.cases)});
boot();render();
