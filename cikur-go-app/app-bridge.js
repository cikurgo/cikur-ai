const BRIDGE_VERSION = "APP-BRIDGE-V1";
const PARENT_SOURCE = "CIKUR_GO_APP";
const MODULE_SOURCE = "CIKUR_GO_MODULE";
const parentOrigin = window.location.origin;

function send(type,payload={}){
  if(window.parent===window)return false;
  window.parent.postMessage({source:MODULE_SOURCE,version:BRIDGE_VERSION,type,payload},parentOrigin);
  return true;
}

window.CIKUR_GO_MODULE_BRIDGE = Object.freeze({
  version:BRIDGE_VERSION,
  ready:()=>send("MODULE_READY",{module:location.pathname.split("/").pop()||null}),
  close:()=>send("MODULE_CLOSE"),
  route:(moduleId)=>send("MODULE_ROUTE",{moduleId}),
  getSession:()=>window.__CIKUR_GO_APP_SESSION||null
});

window.addEventListener("message",(event)=>{
  if(event.origin!==parentOrigin || event.source!==window.parent)return;
  const msg=event.data||{};
  if(msg.source!==PARENT_SOURCE || msg.version!==BRIDGE_VERSION)return;
  if(msg.type==="APP_SESSION"){
    window.__CIKUR_GO_APP_SESSION=Object.freeze({...msg.payload});
    window.dispatchEvent(new CustomEvent("cikur-go-app-session",{detail:window.__CIKUR_GO_APP_SESSION}));
  }
});

if(window.parent!==window) {
  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",()=>send("MODULE_READY",{module:location.pathname.split("/").pop()||null}),{once:true});
  else send("MODULE_READY",{module:location.pathname.split("/").pop()||null});
}
