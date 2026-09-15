import "./cikur-config.js?v=AUTH-SESSION-V2";
import { APP_BRIDGE_VERSION, MODULE_REGISTRY, MODULE_GROUPS, getModule } from "./module-registry.js?v=APP-BRIDGE-V1";

const APP_BUILD = "APP-FOUNDATION-V3";
const cloud = window.CikurCloud;
const $ = (id) => document.getElementById(id);
const state = { user:null, view:"welcome", module:null, frameReady:false };

function setMessage(text){ $("authMessage").textContent=text||""; }
function setView(view){
  state.view=view;
  const loggedIn=Boolean(state.user);
  $("welcomeView").classList.toggle("hidden",loggedIn);
  $("homeView").classList.toggle("hidden",!loggedIn);
  $("bottomNav").classList.toggle("hidden",!loggedIn);
  if(!loggedIn) closeModule();
}
function applySession(user){
  state.user=user||null;
  $("sessionBadge").textContent=user?"SESSION AKTIF":"BELUM LOGIN";
  $("uidValue").textContent=user?.uid||"—";
  $("buildValue").textContent=cloud?.authBuild||"unknown";
  $("greeting").textContent=user?.displayName?`Halo, ${user.displayName} 👋`:"Halo 👋";
  setView(user?"home":"welcome");
}
async function loginEmail(){
  const email=$("email").value.trim(), password=$("password").value;
  if(!email||!password)return setMessage("Email dan password wajib diisi.");
  setMessage("Memproses login…");
  try{ const user=await cloud.loginWithEmail(email,password); applySession(user); setMessage("Login berhasil."); }
  catch(error){ console.error(error); setMessage(error?.message||"Login gagal."); }
}
async function loginGoogle(){
  setMessage("Membuka Google…");
  try{ if(typeof cloud.loginWithGoogle!=="function")throw new Error("Login Google belum tersedia pada Auth build ini."); const user=await cloud.loginWithGoogle(); applySession(user||cloud.auth?.currentUser||null); }
  catch(error){ console.error(error); setMessage(error?.message||"Login Google gagal."); }
}
async function logout(){
  try{ await cloud.logout(); applySession(null); setMessage("Kamu sudah keluar dari CIKUR GO."); }
  catch(error){ console.error(error); setMessage(error?.message||"Logout gagal."); }
}
function postBridge(type,payload={}){
  const frame=$("moduleFrame");
  if(!frame?.contentWindow)return false;
  frame.contentWindow.postMessage({source:"CIKUR_GO_APP",version:APP_BRIDGE_VERSION,type,payload},location.origin);
  return true;
}
function syncModuleSession(){
  postBridge("APP_SESSION",{uid:state.user?.uid||null,authBuild:cloud?.authBuild||null,appBuild:APP_BUILD});
}
function closeModule(){
  state.module=null; state.frameReady=false;
  $("moduleHost").classList.add("hidden");
  const frame=$("moduleFrame"); frame.removeAttribute("src");
  $("routeStatus").textContent="";
  document.querySelectorAll("[data-module-id]").forEach(b=>b.classList.remove("active"));
  document.querySelectorAll("[data-module-group]").forEach(b=>b.classList.toggle("active",b.dataset.moduleGroup==="home"));
}
function openModule(id){
  if(!state.user)return setMessage("Silakan login terlebih dahulu.");
  const meta=getModule(id); if(!meta)return setMessage("Modul tidak dikenal.");
  state.module=id; state.frameReady=false;
  $("moduleTitle").textContent=meta.title;
  $("moduleDescription").textContent=meta.description;
  const frame=$("moduleFrame");
  frame.src=`./modules/${meta.file}?embedded=1&appBuild=${encodeURIComponent(APP_BUILD)}&bridge=${encodeURIComponent(APP_BRIDGE_VERSION)}`;
  $("moduleHost").classList.remove("hidden");
  $("routeStatus").textContent=`Memuat ${meta.title}…`;
  document.querySelectorAll("[data-module-id]").forEach(b=>b.classList.toggle("active",b.dataset.moduleId===id));
  document.querySelectorAll("[data-module-group]").forEach(b=>b.classList.toggle("active",b.dataset.moduleGroup===meta.group));
}
function renderModuleGroups(){
  const root=$("moduleGroups");
  root.innerHTML=Object.entries(MODULE_GROUPS).map(([group,meta])=>`
    <section class="module-section">
      <div class="section-heading"><div><strong>${meta.title}</strong><span>Pilih modul</span></div></div>
      <div class="module-grid">${meta.modules.map(m=>`<button class="module-card" data-module-id="${m.id}"><strong>${m.title}</strong><span>${m.description}</span></button>`).join("")}</div>
    </section>`).join("");
  root.querySelectorAll("[data-module-id]").forEach(b=>b.addEventListener("click",()=>openModule(b.dataset.moduleId)));
}
function route(target){
  if(target==="home"){closeModule();return setMessage("");}
  const group=MODULE_GROUPS[target]; if(group?.modules?.[0]) return openModule(group.modules[0].id);
  openModule(target);
}
window.addEventListener("message",(event)=>{
  if(event.origin!==location.origin || event.source!==$("moduleFrame")?.contentWindow)return;
  const msg=event.data||{};
  if(msg.source!=="CIKUR_GO_MODULE" || msg.version!==APP_BRIDGE_VERSION)return;
  if(msg.type==="MODULE_READY"){
    state.frameReady=true;
    $("routeStatus").textContent=`${$("moduleTitle").textContent} aktif · App Bridge ${APP_BRIDGE_VERSION}`;
    syncModuleSession();
  } else if(msg.type==="MODULE_ROUTE"){
    const target=getModule(msg.payload?.moduleId); if(target)openModule(target.id);
  } else if(msg.type==="MODULE_CLOSE"){ closeModule(); }
});
$("moduleFrame").addEventListener("load",()=>{ if(state.module){ syncModuleSession(); $("routeStatus").textContent=`${$("moduleTitle").textContent} dimuat · menunggu handshake…`; }});
$("loginBtn").addEventListener("click",loginEmail); $("googleBtn").addEventListener("click",loginGoogle); $("logoutBtn").addEventListener("click",logout); $("closeModule").addEventListener("click",closeModule);
document.querySelectorAll("[data-module-group]").forEach(b=>b.addEventListener("click",()=>route(b.dataset.moduleGroup)));
renderModuleGroups();
window.CIKUR_GO_APP=Object.freeze({build:APP_BUILD,bridge:APP_BRIDGE_VERSION,getSession:()=>({user:state.user,authBuild:cloud?.authBuild||null}),route,openModule,closeModule,getModule:()=>state.module});
if(!cloud?.waitForAuth){ $("sessionBadge").textContent="AUTH ERROR"; setMessage("CikurCloud tidak tersedia. Periksa cikur-config.js."); }
else cloud.waitForAuth().then(applySession).catch(error=>{console.error(error);$("sessionBadge").textContent="AUTH ERROR";setMessage("Sesi gagal diperiksa.");});
if("serviceWorker" in navigator) window.addEventListener("load",()=>navigator.serviceWorker.register("./service-worker.js?v=APP-FOUNDATION-V3").catch(error=>console.warn("[CIKUR GO] Service worker tidak aktif:",error)));
console.info(`[CIKUR GO] ${APP_BUILD} · ${APP_BRIDGE_VERSION} aktif.`);
