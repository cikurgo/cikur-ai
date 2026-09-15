export const APP_BRIDGE_VERSION = "APP-BRIDGE-V1";

export const MODULE_REGISTRY = Object.freeze([
  { id:"assistant", group:"customer", title:"Assistant", file:"assistant.html", description:"Asisten CIKUR GO" },
  { id:"food", group:"customer", title:"Food", file:"food.html", description:"Pesan makanan" },
  { id:"ride", group:"customer", title:"Ride", file:"ride.html", description:"Layanan perjalanan" },
  { id:"cikurgo2in1", group:"customer", title:"CIKUR GO 2in1", file:"cikurgo2in1.html", description:"Food + Assistant" },
  { id:"agentcgo", group:"mitra", title:"Agent CGO", file:"agentcgo.html", description:"Dashboard Agent CGO" },
  { id:"resto", group:"mitra", title:"Resto", file:"resto.html", description:"Dashboard Resto" },
  { id:"driver", group:"mitra", title:"Driver", file:"driver.html", description:"Dashboard Driver" },
  { id:"bcgo-admin", group:"internal", title:"BCGO Admin", file:"bcgo-admin.html", description:"Internal administration" },
  { id:"data-cgo", group:"internal", title:"Data CGO", file:"data-cgo.html", description:"Internal data" }
]);

export const MODULE_GROUPS = Object.freeze({
  customer: Object.freeze({ title:"Customer", modules:MODULE_REGISTRY.filter(m=>m.group==="customer") }),
  mitra: Object.freeze({ title:"Mitra", modules:MODULE_REGISTRY.filter(m=>m.group==="mitra") }),
  internal: Object.freeze({ title:"Internal", modules:MODULE_REGISTRY.filter(m=>m.group==="internal") })
});

export function getModule(id){ return MODULE_REGISTRY.find(m=>m.id===id) || null; }
