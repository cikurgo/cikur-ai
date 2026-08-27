import { collection, onSnapshot, query, orderBy, limit, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { db, auth } from "./cikur-config.js";

const ORGAN_REGISTRY = {
  "index.html": {type:"Halaman Utama"}, "assistant.html": {type:"Zona Customer"},
  "food.html": {type:"Zona Customer"}, "ride.html": {type:"Zona Customer"},
  "cikurgo2in1.html": {type:"Zona Customer"}, "agentcgo.html": {type:"Zona Mitra"},
  "resto.html": {type:"Zona Mitra"}, "driver.html": {type:"Zona Mitra"},
  "cikur-config.js": {type:"Sistem Config"}, "bcgo-engine.js": {type:"Sistem Core"},
  "bcgo-admin.html": {type:"Sistem Admin"}, "bcgo.html": {type:"Sistem Monitor"}
};
const ACTIVE_WINDOW = 10 * 60 * 1000;
const LOG_LIMIT = 50;
const PROBE_LIMIT = 5;

export function runAutonomousEngine(onCycleUpdate) {
  if (typeof onCycleUpdate !== "function") throw new TypeError("BCGO membutuhkan callback.");
  let stopped=false, unLogs=null, unProbe=null, unAuth=null;
  let logs=[], probe={connected:false,count:0,error:null};
  let state={step:"IN",message:"Menginisialisasi Pusat Saraf Master...",targetCell:"SYS_MASTER_REGISTRY",errorLog:null,retryCount:0,metrics:{}};

  const ts=v=>{
    try {
      if(!v)return 0;
      if(typeof v.toMillis==="function")return v.toMillis();
      if(typeof v.toDate==="function")return v.toDate().getTime();
      if(v instanceof Date)return v.getTime();
      if(typeof v==="number")return v;
      const n=Date.parse(v); return Number.isFinite(n)?n:0;
    } catch{return 0;}
  };

  function organs(){
    const now=Date.now(), recent=new Map();
    for(const log of logs){
      const f=String(log?.fileName||"").trim(), t=ts(log?.reportedAt);
      if(ORGAN_REGISTRY[f] && t && now-t<=ACTIVE_WINDOW && (!recent.has(f)||t>recent.get(f).t))
        recent.set(f,{log,t});
    }
    const out={};
    for(const [f,m] of Object.entries(ORGAN_REGISTRY)){
      const r=recent.get(f), historical=logs.some(x=>String(x?.fileName||"").trim()===f);
      out[f]=r
        ? {...m,status:"ANOMALY",state:"ACTIVE",message:String(r.log?.message||"Error terdeteksi").slice(0,500),reportedAt:r.log?.reportedAt}
        : {...m,status:"HEALTHY",state:historical?"RECOVERED":"HEALTHY",message:historical?"Tidak ada error aktif; laporan lama sudah pulih.":"Belum ada laporan error aktif."};
    }
    return out;
  }

  function emit(step,message,target,error=null){
    if(stopped)return;
    const systemOrgans=organs();
    const active=Object.values(systemOrgans).filter(x=>x.state==="ACTIVE").length;
    const recovered=Object.values(systemOrgans).filter(x=>x.state==="RECOVERED").length;
    state={...state,step,message,targetCell:target,errorLog:error?String(error).slice(0,500):null,
      metrics:{total:Object.keys(ORGAN_REGISTRY).length,active,recovered,healthy:Object.keys(ORGAN_REGISTRY).length-active,logCount:logs.length,firestoreCount:probe.count}};
    onCycleUpdate({...state,systemOrgans,systemLogs:logs});
  }

  function evaluate(){
    if(stopped)return;
    const o=organs(), active=Object.entries(o).filter(([,x])=>x.state==="ACTIVE");
    if(probe.error){ emit("PROCESS","Anomali koneksi Firestore terdeteksi.","SYS_FIRESTORE_CONNECTION",probe.error); return; }
    if(active.length){
      const [f,x]=active[0];
      emit("PROCESS",`${active.length} anomali aktif terdeteksi. Menganalisis ${f}...`,f,x.message);
      setTimeout(()=>{
        if(stopped)return;
        const now=Object.entries(organs()).filter(([,x])=>x.state==="ACTIVE");
        if(now.length) emit("REVIEW",`Diagnostik selesai. ${now.length} organ perlu perhatian.`,now[0][0],now[0][1].message);
        else emit("OUT","Seluruh organ kembali stabil. Monitor tersinkron.","SYS_ALL_ORGANS_STABLE");
      },350);
    } else {
      emit("REVIEW",`Pemindaian selesai. ${Object.keys(o).length} organ tanpa anomali aktif.`,"SYS_NEURAL_REVIEW");
      setTimeout(()=>{if(!stopped && !probe.error)emit("OUT",`Monitor sinkron. Firestore aktif dan ${Object.keys(organs()).length} organ stabil.`,"SYS_NEURAL_SYNC");},700);
    }
  }

  function startLogs(){
    if(!window.CikurCloud?.listenSystemLogs){emit("OUT","Telemetry system_logs tidak tersedia.","SYS_TELEMETRY_UNAVAILABLE");return;}
    try{
      unLogs=window.CikurCloud.listenSystemLogs(v=>{logs=Array.isArray(v)?v.slice(0,LOG_LIMIT):[];evaluate();},LOG_LIMIT);
    }catch(e){emit("OUT","Gagal membuka telemetry system_logs.","SYS_SYSTEM_LOGS_LISTENER",e.message);}
  }

  function startProbe(){
    try{
      const q=query(collection(db,"mitra_applications"),orderBy("submittedAt","desc"),limit(PROBE_LIMIT));
      unProbe=onSnapshot(q,s=>{probe={connected:true,count:s.size,error:null};state.retryCount=0;evaluate();},
        e=>{probe={connected:false,count:0,error:e?.message||"Firestore listener error"};state.retryCount++;evaluate();});
    }catch(e){probe={connected:false,count:0,error:e.message};evaluate();}
  }

  async function verify(user){
    if(!user){emit("OUT","Sesi Admin belum tersedia. Silakan login sebagai Admin.","SYS_AUTH_REQUIRED");return;}
    try{
      const snap=await getDoc(doc(db,"admin_users",user.uid));
      if(!snap.exists()||snap.data()?.active!==true){emit("OUT","Akses monitor ditolak: akun bukan Admin aktif.","SYS_AUTH_NOT_ADMIN");return;}
      emit("IN","Admin terverifikasi. Memulai pemindaian organ dan telemetry...","SYS_AUTH_VERIFIED");
      startLogs(); startProbe();
    }catch(e){emit("OUT","Verifikasi Admin gagal.","SYS_AUTH_CHECK_FAILED",e.message);}
  }

  unAuth=onAuthStateChanged(auth,verify);
  emit("IN","Menginisialisasi registry 12 organ...","SYS_MASTER_REGISTRY");

  return {systemOrgans:organs(),stop(){
    stopped=true;
    if(typeof unAuth==="function")unAuth();
    if(typeof unLogs==="function")unLogs();
    if(typeof unProbe==="function")unProbe();
  }};
}
