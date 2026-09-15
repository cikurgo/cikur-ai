const CACHE="cikur-go-app-v2";
const SHELL=["./app.html","./app.js?v=APP-FOUNDATION-V2","./app.css?v=APP-FOUNDATION-V2","./manifest.json"];
self.addEventListener("install",event=>event.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener("activate",event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener("fetch",event=>{const u=new URL(event.request.url);if(u.origin!==location.origin)return;event.respondWith(caches.match(event.request).then(cached=>cached||fetch(event.request).then(r=>{if(event.request.method==="GET"){const copy=r.clone();caches.open(CACHE).then(c=>c.put(event.request,copy));}return r;}).catch(()=>cached)));});
