import {
  collection, onSnapshot, query, orderBy, limit, addDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { db, auth } from "./cikur-config.js";

/* BCGO MEDICINE v1.3 — DIAGNOSE → VERIFY → PRESCRIBE → HUMAN HAND
   - BCGO can ask Medicine to independently verify a suspected target.
   - Medicine compares runtime evidence + cross-file source contracts.
   - Human approval is mandatory before a patch becomes READY_FOR_PATCH.
   - Browser Medicine never writes source-code directly.
*/
const REGISTRY = {
  "index.html": { type: "Halaman Utama" },
  "assistant.html": { type: "Zona Customer" },
  "food.html": { type: "Zona Customer" },
  "ride.html": { type: "Zona Customer" },
  "cikurgo2in1.html": { type: "Zona Customer" },
  "agentcgo.html": { type: "Zona Mitra" },
  "resto.html": { type: "Zona Mitra" },
  "driver.html": { type: "Zona Mitra" },
  "cikur-config.js": { type: "Sistem Config" },
  "bcgo-engine.js": { type: "Sistem Core" },
  "bcgo-admin.html": { type: "Sistem Admin" },
  "bcgo.html": { type: "Sistem Monitor" }
};
const REQUIRED = {
  driver:["name","phone","address","vehicleType"],
  assistant:["name","phone","address","serviceType"],
  customer:["name","phone","email"],
  restaurant:["name","phone","address","businessName","businessType","ownerName","role","village","district","city","province","openTime","closeTime","operationalDays","ktp","legalStatus","bankName","accountName","accountNumber","photoFront"]
};
const S = {
  version:"1.3.0", registry:REGISTRY, logs:[], cases:[], activeCase:null,
  findings:[], listeners:[], messages:[], human:{mode:"ASSISTED",paused:false,uid:null},
  patchProposals:[], verification:null, lastClientMessageId:null
};
const emit=(event,p={})=>window.dispatchEvent(new CustomEvent("bcgo:medicine",{detail:{event,at:new Date().toISOString(),...p}}));
const text=(v,n=1800)=>String(v??"").replace(/\s+/g," ").trim().slice(0,n);
const now=()=>new Date().toISOString();
const uid=()=>`${Date.now()}-${Math.random().toString(36).slice(2,9)}`;

function diagnosis(message){
  const m=String(message).toLowerCase();
  if(/cannot set properties of null|cannot read properties of null/.test(m))return{code:"DOM_NULL_REFERENCE",title:"Referensi DOM tidak ditemukan",severity:"MEDIUM",confidence:.96,treatment:"DOM_NULL_GUARD"};
  if(/permission-denied|permission denied|unauthenticated/.test(m))return{code:"AUTH_PERMISSION",title:"Masalah otorisasi",severity:"HIGH",confidence:.94,treatment:"AUTH_REVIEW"};
  if(/firestore|listener|network|offline|unavailable/.test(m))return{code:"REALTIME_CONNECTIVITY",title:"Gangguan koneksi/listener realtime",severity:"MEDIUM",confidence:.84,treatment:"FIRESTORE_RECONNECT"};
  if(/undefined|is not a function|not defined/.test(m))return{code:"JAVASCRIPT_CONTRACT",title:"Kontrak JavaScript tidak terpenuhi",severity:"MEDIUM",confidence:.82,treatment:"RUNTIME_CONTRACT_REVIEW"};
  if(/sinkron|synchron|count|jumlah|validasi|mitra/.test(m))return{code:"DATA_CONSISTENCY",title:"Potensi ketidaksinkronan data/validasi",severity:"MEDIUM",confidence:.70,treatment:"CROSS_FILE_CONSISTENCY_REVIEW"};
  return{code:"UNCLASSIFIED_RUNTIME",title:"Runtime anomaly belum terklasifikasi",severity:"UNKNOWN",confidence:.45,treatment:"MANUAL_DIAGNOSIS"};
}
function prescription(d){
  const safe=["DOM_NULL_GUARD","FIRESTORE_RECONNECT","CROSS_FILE_CONSISTENCY_REVIEW"].includes(d.treatment);
  return{treatment:d.treatment,risk:safe?"LOW":"HIGH",mode:safe?"SAFE_PROPOSAL":"APPROVAL_REQUIRED"};
}
function buildPatchProposal(c, verification=null){
  const d=c.diagnosis; let steps=[]; let changeSummary="";
  if(d.code==="DOM_NULL_REFERENCE"){
    steps=["Cari selector/ID DOM yang gagal pada target.","Pastikan elemen tersedia sebelum .textContent/.value/classList.","Jalankan binding setelah DOM siap.","Uji jalur realtime tanpa menghapus elemen opsional."];
    changeSummary="Tambahkan DOM guard pada jalur yang terbukti gagal.";
  } else if(d.code==="DATA_CONSISTENCY"){
    steps=["Bandingkan sumber data, kontrak field, transformasi, dan renderer target.","Pastikan sumber dan target memakai nama field/normalisasi yang sama.","Periksa apakah counter dihitung dari snapshot yang sama, bukan cache lama.","Setelah perubahan, validasi ulang nilai sumber dan nilai tampilan secara realtime."];
    changeSummary="Selaraskan kontrak sumber → engine → admin dan hitung ulang counter dari snapshot aktual.";
  } else if(d.code==="AUTH_PERMISSION") steps=["Periksa auth state sebelum query Firestore.","Pastikan rule sesuai role pengguna.","Jangan melewati permission dengan client-side workaround.","Uji login, listener, dan fallback."];
  else if(d.code==="REALTIME_CONNECTIVITY") steps=["Periksa auth, onSnapshot, query/index, dan rules.","Tambahkan reconnect-safe handling.","Pastikan event masuk tanpa refresh.","Validasi kembali listener setelah reconnect."];
  else if(d.code==="JAVASCRIPT_CONTRACT") steps=["Temukan fungsi/property yang tidak tersedia.","Bandingkan kontrak pemanggil dan yang dipanggil.","Selaraskan nama API atau beri compatibility guard.","Uji seluruh jalur pemakaian kontrak."];
  else steps=["Kumpulkan evidence tambahan.","Bandingkan source dengan target lintas-file.","Susun perubahan sekecil mungkin.","Validasi sebelum deployment."];
  return {proposalId:`PATCH-${uid().toUpperCase()}`,caseId:c.id,target:c.source,diagnosis:d,verification,steps,changeSummary,sourceWrite:false,status:"PROPOSED",createdAt:now()};
}

async function postSystemMessage(role,msg,meta={}){
  const payload={role,text:text(msg,1800),actorUid:role==="human"?(auth.currentUser?.uid||null):null,system:true,createdAt:serverTimestamp(),clientMessageId:meta.clientMessageId||uid(),...meta};
  try{await addDoc(collection(db,"medicine_messages"),payload);}catch(e){emit("local_message",{message:{...payload,createdAt:now()},storageError:e.message});}
}

function makeCase(log){
  const source=text(log.fileName||log.source||"UNKNOWN",120), sig=text(log.message||log.error||"Unknown error",700);
  if(S.cases.some(c=>c.source===source&&c.signature===sig))return null;
  const d=diagnosis(sig), c={id:`CASE-${uid().toUpperCase()}`,source,signature:sig,diagnosis:d,prescription:prescription(d),status:"DIAGNOSED",createdAt:now(),evidence:log};
  S.cases.unshift(c);S.cases=S.cases.slice(0,50);S.activeCase=c;emit("case_created",{case:c});
  postSystemMessage("bcgo",`Saya menemukan evidence pada ${source}: ${d.title}. Saya serahkan ${c.id} ke Medicine untuk verifikasi independen.` ,{kind:"BCGO_HANDOFF",caseId:c.id,target:source});
  postSystemMessage("medicine",`Case ${c.id} saya terima. Saya memeriksa evidence runtime dan kontrak lintas-file sebelum mengusulkan treatment.`,{kind:"MEDICINE_ACK",caseId:c.id,target:source});
  return c;
}
function startTelemetry(){
  if(!window.CikurCloud?.listenSystemLogs)return emit("telemetry_unavailable");
  const u=window.CikurCloud.listenSystemLogs(logs=>{S.logs=Array.isArray(logs)?logs:[];emit("telemetry",{logs:S.logs});for(const l of S.logs.slice(0,50))makeCase(l);});
  S.listeners.push(u);
}
async function fetchFile(name){try{const r=await fetch(`./${encodeURIComponent(name)}`,{cache:"no-store"});const t=r.ok?await r.text():"";return{ok:r.ok,status:r.status,text:t};}catch(e){return{ok:false,status:0,text:"",error:e.message};}}
function fields(name,t){
  if(!t)return[]; const out=[]; let m;
  const re=/(?:id|name|data-field)\s*=\s*["']([^"']+)["']/gi; while((m=re.exec(t)))out.push(m[1]);
  if(/\.js$/i.test(name)){const kr=/\b(name|phone|address|email|vehicleType|photo|fotoKtp|fotoSim|fotoStnk|ktp|sim|stnk|bankName|accountName|accountNumber|serviceType|businessName|businessType|ownerName|role|village|district|city|province|openTime|closeTime|operationalDays|legalStatus|photoFront|photoIndoor)\b/g;while((m=kr.exec(t)))out.push(m[1]);}
  return[...new Set(out)];
}
async function scanConsistency(targets=null){
  const names=targets?.length?targets.filter(n=>REGISTRY[n]):Object.keys(REGISTRY); emit("scan_started",{total:names.length,targets:names}); const r={};
  for(const n of names){const x=await fetchFile(n);r[n]={...x,fields:fields(n,x.text)};}
  const findings=[]; const admin=new Set((r["bcgo-admin.html"]?.fields||[]).map(x=>x.toLowerCase()));
  for(const [type,req] of Object.entries(REQUIRED)){
    const source=type==="driver"?"driver.html":type==="restaurant"?"resto.html":type==="assistant"?"agentcgo.html":"index.html";
    if(!r[source])continue; const sf=new Set((r[source].fields||[]).map(x=>x.toLowerCase())); const miss=req.filter(x=>!sf.has(x.toLowerCase()));
    if(miss.length)findings.push({kind:"SOURCE_CONTRACT_GAP",sourceFile:source,missing:miss});
  }
  const sources=["driver.html","resto.html","agentcgo.html","index.html","food.html","ride.html"];
  for(const source of sources){if(!r[source]||!r["bcgo-admin.html"])continue;const sf=[...new Set((r[source].fields||[]).map(x=>x.toLowerCase()))].filter(x=>/^(photo|fotoktp|fotosim|fotostnk|ktp|sim|stnk|name|phone|address|email|vehicletype|businessname|businesstype|ownername|bankname|accountname|accountnumber|servicetype)$/.test(x));const miss=sf.filter(x=>!admin.has(x));if(miss.length)findings.push({kind:"ADMIN_PRESENTATION_GAP",sourceFile:source,targetFile:"bcgo-admin.html",missing:miss});}
  S.findings=findings; emit("scan_complete",{results:r,findings}); return{results:r,findings};
}
function activeCases(){return S.cases.filter(c=>!["RECOVERED","REJECTED"].includes(c.status));}
function mentionedFile(q){const x=q.toLowerCase();return Object.keys(REGISTRY).find(f=>x.includes(f.toLowerCase()))||null;}
function latestRelevantLogs(file){return S.logs.filter(l=>!file||String(l.fileName||l.source||"").toLowerCase()===file.toLowerCase()).slice(0,10);}
function bcgoAnswer(q){
  const active=activeCases(), x=q.toLowerCase(), file=mentionedFile(q);
  if(/sinkron|synchron|jumlah|count|validasi|mitra|tidak sesuai|tidak sinkron/.test(x)){
    const target=file||active[0]?.source||"bcgo-admin.html";
    const logs=latestRelevantLogs(target);
    const evidence=logs[0]?`Saya punya evidence telemetry pada ${target}: ${text(logs[0].message||logs[0].error||"event",420)}.`:`Saya belum memiliki evidence runtime yang cukup spesifik untuk ${target}.`;
    return `Saya memeriksa pertanyaan Anda. Target yang paling relevan: ${target}. ${evidence} Saya belum akan menyatakan sumber masalah pasti hanya dari tampilan. Saya sarankan saya serahkan ${target} ke Medicine untuk verifikasi lintas-file dan pemeriksaan kontraknya.`;
  }
  if(/apa yang.*kerja|sedang|ngerjain|mengerjakan/.test(x))return active.length?`Saya sedang mengawasi ${Object.keys(REGISTRY).length} organ. Ada ${active.length} case aktif; fokus saya ${active[0].source} (${active[0].status}). Saya meneruskan evidence ke Medicine dan menunggu verifikasi.`:`Saya sedang menjalankan pemantauan lintas-file dan mendengarkan telemetry realtime. Belum ada case aktif.`;
  if(/aman|status|sehat|normal/.test(x))return`Status saya: telemetry ${S.logs.length} log, ${active.length} case aktif, dan ${S.findings.length} finding lintas-file. Saya tidak menyatakan aman tanpa evidence.`;
  if(/masalah|error|kendala|rusak|anomal/.test(x))return active.length?`Ya, saya menemukan ${active.length} case aktif. Prioritas ${active[0].source}: ${active[0].diagnosis.title}. Saya bisa meminta Medicine memverifikasinya.`:`Saat ini saya belum melihat case aktif dari telemetry yang saya terima.`;
  return`BCGO menerima pesan Anda dan bekerja dari telemetry/state aktual. Bila Anda menyebut file atau gejala spesifik, saya dapat mengarahkan Medicine untuk memverifikasinya.`;
}
function medicineAnswer(q){
  const x=q.toLowerCase(), active=activeCases(), file=mentionedFile(q);
  if(/sinkron|synchron|jumlah|count|validasi|mitra|tidak sesuai|tidak sinkron/.test(x)){
    const target=file||active[0]?.source||"bcgo-admin.html"; return `Saya akan memverifikasi ${target} secara lintas-file. Saya akan membandingkan kontrak field, jalur transformasi, dan evidence telemetry yang tersedia. Saya tidak akan menganggap target sebagai sumber kerusakan sebelum bukti mendukungnya.`;
  }
  if(/apa yang.*kerja|sedang|ngerjain|mengerjakan/.test(x))return active.length?`Saya sedang menganalisis ${active[0].source}. Evidence: ${active[0].diagnosis.title}; confidence ${Math.round(active[0].diagnosis.confidence*100)}%.`:`Saya sedang mengobservasi ${Object.keys(REGISTRY).length} organ dan ${S.logs.length} telemetry log secara realtime.`;
  if(/ada.*(masalah|error)|kendala|rusak|sakit/.test(x))return active.length?`Saya menemukan ${active.length} case aktif. Target pertama ${active[0].source}; diagnosis ${active[0].diagnosis.title}. Saya siap melakukan verifikasi silang.`:`Saat ini belum ada case aktif yang bisa saya nyatakan sebagai masalah.`;
  if(/obat|perbaiki|sembuhkan|treatment|patch/.test(x))return S.activeCase?`Prescription untuk ${S.activeCase.source}: ${S.activeCase.prescription.treatment}. Saya dapat membuat patch proposal setelah verifikasi. Source-code tetap terkunci sampai approval dan validasi.`:`Belum ada case aktif untuk diobati.`;
  if(/driver|foto|photo/.test(x))return`Saya dapat membandingkan driver.html, bcgo-engine.js, dan bcgo-admin.html. Jika field foto ada di sumber tetapi tidak dirender di Admin, saya tandai sebagai ADMIN_PRESENTATION_GAP dan siapkan proposal.`;
  return`Saya hanya menyimpulkan hal yang didukung evidence. Sebutkan target file/gejala agar saya bisa melakukan verifikasi terarah.`;
}
function recipient(q){const x=q.trim().toLowerCase();if(/^(hai\s+)?bcgo\b/.test(x)||/\bbcgo[,:]/.test(x))return"bcgo";if(/^(hai\s+)?medicine\b/.test(x)||/\bmedicine[,:]/.test(x))return"medicine";if(/\b(bcgo|medicine)\b/.test(x))return x.indexOf("bcgo")<x.indexOf("medicine")?"bcgo":"medicine";return"medicine";}
async function sendMessage(msg,role="human"){
  const t=text(msg,1200); if(!t)return;
  const clientMessageId=uid(); S.lastClientMessageId=clientMessageId;
  const payload={role,text:t,actorUid:auth.currentUser?.uid||null,createdAt:serverTimestamp(),clientMessageId};
  try{await addDoc(collection(db,"medicine_messages"),payload);}catch(e){emit("local_message",{message:{...payload,createdAt:now()},storageError:e.message});}
  if(role!=="human")return;
  if(S.human.paused){await postSystemMessage("medicine","Medicine sedang dijeda oleh manusia. Pesan diterima, tetapi diagnosis/treatment baru ditahan.",{replyTo:clientMessageId});return;}
  const target=recipient(t), answer=target==="bcgo"?bcgoAnswer(t):medicineAnswer(t);
  await postSystemMessage(target,answer,{replyTo:clientMessageId,kind:"DIRECT_REPLY"});
  if(target==="bcgo" && /medicine|periksa|verifikasi|pastikan|cek|sumber masalah/.test(t.toLowerCase())){
    const file=mentionedFile(t)||activeCases()[0]?.source||null;
    await postSystemMessage("bcgo",`Saya meneruskan permintaan verifikasi ke Medicine${file?` untuk ${file}`:""}. Medicine diminta membandingkan evidence dan kontrak lintas-file.`,{kind:"BCGO_TO_MEDICINE",target:file,replyTo:clientMessageId});
    await verifyWithMedicine(file,{question:t,requestedBy:"human_via_bcgo"});
  }
}
async function verifyWithMedicine(targetFile=null,context={}){
  const target=targetFile&&REGISTRY[targetFile]?targetFile:(S.activeCase?.source||"bcgo-admin.html");
  emit("verification_started",{target,context});
  const targets=[target,"bcgo-engine.js","bcgo-admin.html"].filter((v,i,a)=>REGISTRY[v]&&a.indexOf(v)===i);
  const result=await scanConsistency(targets);
  const targetFindings=result.findings.filter(f=>f.sourceFile===target||f.targetFile===target);
  const logs=latestRelevantLogs(target);
  const verdict=targetFindings.length?"SUPPORTED_BY_SOURCE_CONTRACT":logs.length?"RUNTIME_EVIDENCE_PRESENT":"INSUFFICIENT_EVIDENCE";
  const v={target,verdict,targetFindings,runtimeEvidence:logs.slice(0,3),checkedFiles:targets,checkedAt:now(),question:context.question||null};
  S.verification=v; emit("verification_complete",{verification:v});
  if(S.activeCase && (!targetFile||S.activeCase.source===target)){
    S.activeCase.verification=v; S.activeCase.status=verdict==="INSUFFICIENT_EVIDENCE"?"NEEDS_EVIDENCE":"VERIFIED_DIAGNOSIS"; S.activeCase.prescription=prescription(S.activeCase.diagnosis); emit("case_updated",{case:S.activeCase});
    const proposal=buildPatchProposal(S.activeCase,v); S.patchProposals.unshift(proposal); S.patchProposals=S.patchProposals.slice(0,30); emit("patch_proposed",{proposal});
  }
  const msg=verdict==="SUPPORTED_BY_SOURCE_CONTRACT"?`Verifikasi selesai untuk ${target}. Saya menemukan finding kontrak yang mendukung dugaan: ${targetFindings.map(f=>f.kind).join(", ")}. Diagnosis dapat dilanjutkan, tetapi patch tetap menunggu persetujuan manusia.`:verdict==="RUNTIME_EVIDENCE_PRESENT"?`Verifikasi selesai untuk ${target}. Ada evidence runtime terkait target, tetapi saya belum membuktikan akar masalah hanya dari telemetry. Saya tandai sebagai VERIFIED_DIAGNOSIS dan menunggu review sebelum patch.`:`Verifikasi selesai untuk ${target}. Evidence belum cukup untuk memastikan akar masalah. Saya tidak akan mengarang diagnosis atau menyentuh source-code.`;
  await postSystemMessage("medicine",msg,{kind:"MEDICINE_VERIFICATION",target,verdict,checkedFiles:targets});
  return v;
}
async function approveTreatment(caseId){
  const c=S.cases.find(x=>x.id===caseId);if(!c)throw new Error("Case tidak ditemukan");if(S.human.paused)throw new Error("Medicine sedang dijeda");
  if(!c.verification)await verifyWithMedicine(c.source,{question:"Approval requested without verification",requestedBy:"human"});
  c.status="READY_FOR_PATCH";c.approvedAt=now();c.approvedBy=auth.currentUser?.uid||null;
  const proposal=c.patchProposal||buildPatchProposal(c,c.verification);proposal.status="READY_FOR_PATCH";S.patchProposals.unshift(proposal);S.patchProposals=S.patchProposals.slice(0,30);
  try{await addDoc(collection(db,"medicine_treatments"),{caseId:c.id,source:c.source,diagnosis:c.diagnosis,prescription:c.prescription,verification:c.verification,patchProposal:proposal,action:"APPROVED_READY_FOR_PATCH",actorUid:auth.currentUser?.uid||null,createdAt:serverTimestamp()});}catch(e){emit("storage_warning",{message:e.message});}
  await postSystemMessage("human",`Saya menyetujui treatment untuk ${c.source}. Medicine boleh menyiapkan patch proposal terverifikasi; source-code tetap tidak ditulis otomatis.`,{kind:"HUMAN_APPROVAL",caseId:c.id});
  await postSystemMessage("medicine",`Approval manusia diterima untuk ${c.id}. Proposal ${proposal.proposalId} berstatus READY_FOR_PATCH. Langkah berikutnya adalah penerapan patch oleh mekanisme yang diizinkan lalu validasi ulang.`,{kind:"MEDICINE_READY_FOR_PATCH",caseId:c.id});
  emit("patch_proposed",{proposal});emit("case_updated",{case:c});return c;
}
async function rejectTreatment(caseId,reason="Treatment ditolak oleh manusia."){const c=S.cases.find(x=>x.id===caseId);if(!c)throw new Error("Case tidak ditemukan");c.status="REJECTED";c.rejectedAt=now();c.rejectionReason=text(reason,500);try{await addDoc(collection(db,"medicine_treatments"),{caseId:c.id,source:c.source,action:"REJECTED",reason:c.rejectionReason,actorUid:auth.currentUser?.uid||null,createdAt:serverTimestamp()});}catch(e){emit("storage_warning",{message:e.message});}await postSystemMessage("medicine",`Saya menerima penolakan untuk ${c.id}. Treatment dibatalkan; source-code tetap tidak disentuh.`);emit("case_updated",{case:c});return c;}
async function setHumanMode(paused){S.human.paused=!!paused;S.human.mode=paused?"HUMAN_PAUSED":"ASSISTED";S.human.uid=auth.currentUser?.uid||null;emit("human_control",{human:{...S.human}});await postSystemMessage("medicine",paused?"Mode Medicine dijeda oleh manusia. Saya hanya mengamati telemetry dan menunggu instruksi.":"Mode Medicine aktif kembali. Saya melanjutkan observasi, diagnosis, dan usulan treatment dengan approval manusia.",{kind:"HUMAN_MODE"});}
async function requestReview(caseId){const c=S.cases.find(x=>x.id===caseId);if(!c)throw new Error("Case tidak ditemukan");await postSystemMessage("bcgo",`Saya meminta review manusia untuk ${c.id}. Evidence: ${c.source} — ${c.diagnosis.title}.`,{kind:"HUMAN_REVIEW_REQUEST",caseId:c.id});emit("human_review_requested",{case:c});return c;}
async function startConversation(){try{const q=query(collection(db,"medicine_messages"),orderBy("createdAt","desc"),limit(150));const u=onSnapshot(q,s=>{const seen=new Set();S.messages=s.docs.map(d=>({id:d.id,...d.data()})).reverse().filter(m=>{const k=m.clientMessageId||m.id;if(seen.has(k))return false;seen.add(k);return true;});emit("conversation",{messages:S.messages});},e=>emit("conversation_error",{message:e.message}));S.listeners.push(u);}catch(e){emit("conversation_error",{message:e.message});}}
onAuthStateChanged(auth,u=>{S.auth=u?"AUTHENTICATED":"UNAUTHENTICATED";S.human.uid=u?.uid||null;emit("auth",{user:u?{uid:u.uid,email:u.email||null}:null});if(u){startTelemetry();startConversation();}});
const API={scanConsistency,verifyWithMedicine,sendMessage,approveTreatment,rejectTreatment,setHumanMode,requestReview,getRegistry:()=>({...REGISTRY}),getState:()=>JSON.parse(JSON.stringify(S))};
Object.defineProperties(API,{cases:{get:()=>S.cases},activeCase:{get:()=>S.activeCase},human:{get:()=>S.human},findings:{get:()=>S.findings},patchProposals:{get:()=>S.patchProposals},logs:{get:()=>S.logs},messages:{get:()=>S.messages}});
window.BCGOMedicine=API;
setTimeout(()=>scanConsistency().catch(e=>emit("scan_error",{message:e.message})),500); emit("ready",{version:S.version,registryCount:Object.keys(REGISTRY).length});
