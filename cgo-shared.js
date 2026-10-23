/* CIKUR GO - cgo-shared.js
 * Satu file bersama untuk SEMUA halaman (index, customer/*, mitra/*) supaya tampilan dan fungsi seragam:
 *   - font Figtree + variabel tema
 *   - ikon garis (sprite SVG) dan ikon 3D (Microsoft Fluent Emoji, lisensi MIT)
 *   - peta dasar gratis tanpa API key (OpenFreeMap) dengan cadangan OpenStreetMap
 *   - CGO.esc() untuk mengamankan teks dari pengguna sebelum masuk ke innerHTML
 * Pasang di <head> setiap halaman:  <script src="../cgo-shared.js"></script>   (di index.html: ./cgo-shared.js)
 */
(function () {
  "use strict";
  if (window.CGO) return;

  // ---------- Pengaturan ----------
  // Untuk lebih stabil, unduh PNG 3D ke folder assets/3d/ (nama file = kunci + ".png", mis. motor.png)
  // lalu isi CGO_ICON3D_LOCAL, contoh: window.CGO_ICON3D_LOCAL = "../assets/3d/";
  var ICON3D_BASE = "https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets/";
  var ICON3D = {
    motor: "Motor scooter/3D/motor_scooter_3d.png", pin: "Round pushpin/3D/round_pushpin_3d.png",
    flag: "Chequered flag/3D/chequered_flag_3d.png", chat: "Speech balloon/3D/speech_balloon_3d.png",
    cart: "Shopping cart/3D/shopping_cart_3d.png", food: "Pot of food/3D/pot_of_food_3d.png",
    memo: "Memo/3D/memo_3d.png", gear: "Gear/3D/gear_3d.png", compass: "Compass/3D/compass_3d.png",
    worldmap: "World map/3D/world_map_3d.png", warning: "Warning/3D/warning_3d.png", coin: "Coin/3D/coin_3d.png",
    card: "Credit card/3D/credit_card_3d.png", star: "Star/3D/star_3d.png", receipt: "Receipt/3D/receipt_3d.png",
    party: "Party popper/3D/party_popper_3d.png", burger: "Hamburger/3D/hamburger_3d.png",
    fork: "Fork and knife with plate/3D/fork_and_knife_with_plate_3d.png", bell: "Bell/3D/bell_3d.png",
    calendar: "Calendar/3D/calendar_3d.png", robot: "Robot/3D/robot_3d.png", shop: "Convenience store/3D/convenience_store_3d.png",
    bag: "Shopping bags/3D/shopping_bags_3d.png", clock: "Alarm clock/3D/alarm_clock_3d.png", lock: "Locked/3D/locked_3d.png"
  };
  var ICON3D_FB = {
    motor: "bike", pin: "pin", flag: "flag", chat: "chat", cart: "cart", food: "food", memo: "doc", gear: "gear",
    compass: "nav", worldmap: "map", warning: "warn", coin: "cash", card: "wallet", star: "star", receipt: "receipt",
    party: "check", burger: "food", fork: "food", bell: "clock", calendar: "clock", robot: "user", shop: "food",
    bag: "cart", clock: "clock", lock: "check"
  };
  var SPRITE = "<svg width=\"0\" height=\"0\" style=\"position:absolute\" aria-hidden=\"true\"><defs><symbol id=\"i-bike\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"5\" cy=\"17.5\" r=\"2.5\"/><circle cx=\"19\" cy=\"17.5\" r=\"2.5\"/><path d=\"M7.5 17.5h4.5c1.7 0 2-1 2.5-2l1.6-3.5\"/><path d=\"M14 5.5h3l2 12\"/><path d=\"M4 12.5h6.5c1.2 0 1.7.6 1.7 1.5\"/></symbol><symbol id=\"i-cash\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect width=\"20\" height=\"12\" x=\"2\" y=\"6\" rx=\"2\"/><circle cx=\"12\" cy=\"12\" r=\"2\"/><path d=\"M6 12h.01M18 12h.01\"/></symbol><symbol id=\"i-wallet\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1\"/><path d=\"M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4\"/></symbol><symbol id=\"i-phone\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z\"/></symbol><symbol id=\"i-user\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2\"/><circle cx=\"12\" cy=\"7\" r=\"4\"/></symbol><symbol id=\"i-pin\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z\"/><circle cx=\"12\" cy=\"10\" r=\"3\"/></symbol><symbol id=\"i-back\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"m15 18-6-6 6-6\"/></symbol><symbol id=\"i-target\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><line x1=\"2\" x2=\"5\" y1=\"12\" y2=\"12\"/><line x1=\"19\" x2=\"22\" y1=\"12\" y2=\"12\"/><line x1=\"12\" x2=\"12\" y1=\"2\" y2=\"5\"/><line x1=\"12\" x2=\"12\" y1=\"19\" y2=\"22\"/><circle cx=\"12\" cy=\"12\" r=\"7\"/><circle cx=\"12\" cy=\"12\" r=\"3\"/></symbol><symbol id=\"i-clock\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"12\" cy=\"12\" r=\"10\"/><polyline points=\"12 6 12 12 16 14\"/></symbol><symbol id=\"i-receipt\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z\"/><path d=\"M14 8H8\"/><path d=\"M16 12H8\"/><path d=\"M13 16H8\"/></symbol><symbol id=\"i-star\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><polygon points=\"12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2\"/></symbol>\n<symbol id=\"i-close\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M18 6 6 18\"/><path d=\"m6 6 12 12\"/></symbol><symbol id=\"i-share\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"18\" cy=\"5\" r=\"3\"/><circle cx=\"6\" cy=\"12\" r=\"3\"/><circle cx=\"18\" cy=\"19\" r=\"3\"/><line x1=\"8.59\" x2=\"15.42\" y1=\"13.51\" y2=\"17.49\"/><line x1=\"15.41\" x2=\"8.59\" y1=\"6.51\" y2=\"10.49\"/></symbol><symbol id=\"i-doc\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z\"/><path d=\"M14 2v4a2 2 0 0 0 2 2h4\"/><path d=\"M10 9H8\"/><path d=\"M16 13H8\"/><path d=\"M16 17H8\"/></symbol><symbol id=\"i-food\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2\"/><path d=\"M7 2v20\"/><path d=\"M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7\"/></symbol><symbol id=\"i-nav\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><polygon points=\"3 11 22 2 13 21 11 13 3 11\"/></symbol><symbol id=\"i-warn\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3\"/><path d=\"M12 9v4\"/><path d=\"M12 17h.01\"/></symbol><symbol id=\"i-check\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M20 6 9 17l-5-5\"/></symbol><symbol id=\"i-cart\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"8\" cy=\"21\" r=\"1\"/><circle cx=\"19\" cy=\"21\" r=\"1\"/><path d=\"M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12\"/></symbol><symbol id=\"i-chat\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M7.9 20A9 9 0 1 0 4 16.1L2 22Z\"/></symbol><symbol id=\"i-map\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z\"/><path d=\"M15 5.764v15\"/><path d=\"M9 3.236v15\"/></symbol><symbol id=\"i-flag\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z\"/><line x1=\"4\" x2=\"4\" y1=\"22\" y2=\"15\"/></symbol><symbol id=\"i-gear\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><line x1=\"21\" x2=\"14\" y1=\"4\" y2=\"4\"/><line x1=\"10\" x2=\"3\" y1=\"4\" y2=\"4\"/><line x1=\"21\" x2=\"12\" y1=\"12\" y2=\"12\"/><line x1=\"8\" x2=\"3\" y1=\"12\" y2=\"12\"/><line x1=\"21\" x2=\"16\" y1=\"20\" y2=\"20\"/><line x1=\"12\" x2=\"3\" y1=\"20\" y2=\"20\"/><line x1=\"14\" x2=\"14\" y1=\"2\" y2=\"6\"/><line x1=\"8\" x2=\"8\" y1=\"10\" y2=\"14\"/><line x1=\"16\" x2=\"16\" y1=\"18\" y2=\"22\"/></symbol></defs></svg>";

  // ---------- Font + tema ----------
  function loadFont() {
    if (document.querySelector("link[data-cgo-font]") || !document.head) return;
    var l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = "https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700;800&display=swap";
    l.setAttribute("data-cgo-font", "1");
    document.head.appendChild(l);
  }
  var CSS = [
    ":root{--font-main:'Figtree',system-ui,-apple-system,'Segoe UI',sans-serif;--font-mono:'Figtree',system-ui,sans-serif;--cgo-red:#E50914}",
    "body,button,input,select,textarea{font-family:var(--font-main)}",
    "body :where(h1,h2,h3,h4,h5,h6,p,span,div,a,label,li,td,th,small,b,strong){font-family:var(--font-main)}",
    ".i3d{width:18px;height:18px;object-fit:contain;vertical-align:-4px;display:inline-block}",
    ".i3d-fb{display:inline-flex;vertical-align:middle}",
    ".ic{width:20px;height:20px;display:inline-block;vertical-align:middle;flex:0 0 auto}",
    ".leaflet-container{background:#f3f5f7;font-family:var(--font-main)}",
    ".leaflet-control-attribution{font-size:9px!important;background:rgba(255,255,255,.78)!important;border-radius:8px 0 0 0}",
    ".cgo-num{font-variant-numeric:tabular-nums}"
  ].join("\n");
  function injectCss() {
    if (document.getElementById("cgo-shared-css") || !document.head) return;
    var s = document.createElement("style");
    s.id = "cgo-shared-css";
    s.textContent = CSS;
    document.head.appendChild(s);
  }
  function injectSprite() {
    if (document.getElementById("i-bike") || !document.body) return;
    var d = document.createElement("div");
    d.style.display = "none";
    d.innerHTML = SPRITE;
    document.body.insertBefore(d, document.body.firstChild);
  }

  // ---------- Ikon ----------
  function icon3dSrc(k) {
    var local = window.CGO_ICON3D_LOCAL;
    return local ? local + k + ".png" : ICON3D_BASE + encodeURI(ICON3D[k]);
  }
  function ic3Fail(img) {
    var s = document.createElement("span");
    s.className = "i3d-fb";
    s.innerHTML = '<svg class="ic"><use href="#i-' + (img.dataset.fb || "pin") + '"/></svg>';
    img.replaceWith(s);
  }
  function ic3(k, cls) {
    if (!ICON3D[k]) return '<svg class="ic"><use href="#i-' + (ICON3D_FB[k] || k) + '"/></svg>';
    return '<img class="i3d ' + (cls || "") + '" alt="" decoding="async" src="' + icon3dSrc(k) + '" data-fb="' + (ICON3D_FB[k] || "pin") + '" onerror="ic3Fail(this)">';
  }
  function hydrate3d(root) {
    (root || document).querySelectorAll("img[data-3d]").forEach(function (img) {
      var k = img.dataset["3d"];
      if (!ICON3D[k]) return;
      img.dataset.fb = ICON3D_FB[k] || "pin";
      img.onerror = function () { ic3Fail(img); };
      img.src = icon3dSrc(k);
      img.removeAttribute("data-3d");
    });
  }
  function ico(name) { return '<svg class="ic"><use href="#i-' + name + '"/></svg>'; }

  // ---------- Keamanan teks ----------
  function esc(t) {
    return String(t == null ? "" : t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // ---------- Peta dasar gratis tanpa API key ----------
  function addBaseMap(map) {
    try { map.setMaxZoom(19); map.setMinZoom(3); } catch (_) {}
    var gl = null, ok = false, fell = false;
    function fallback() {
      if (fell || ok) return;
      fell = true;
      try { if (gl) map.removeLayer(gl); } catch (_) {}
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap contributors" }).addTo(map);
    }
    try {
      if (window.maplibregl && L.maplibreGL) {
        gl = L.maplibreGL({
          style: "https://tiles.openfreemap.org/styles/positron",
          attribution: '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> · © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'
        }).addTo(map);
        var m = gl.getMaplibreMap && gl.getMaplibreMap();
        if (m) { m.on("load", function () { ok = true; }); m.on("error", function () { if (!ok) fallback(); }); }
        setTimeout(fallback, 9000);
        return;
      }
    } catch (e) { console.warn("[CIKUR] MapLibre gagal, pakai OSM:", e && e.message); }
    fallback();
  }

  // ---------- Pasang ----------
  window.CGO = { ic3: ic3, ico: ico, hydrate3d: hydrate3d, esc: esc, addBaseMap: addBaseMap, icon3dSrc: icon3dSrc, version: "1" };
  window.ic3 = ic3; window.ic3Fail = ic3Fail; window.hydrate3d = hydrate3d; window.addBaseMap = addBaseMap; window.icon3dSrc = icon3dSrc;

  loadFont();
  injectCss();
  function ready() { injectSprite(); hydrate3d(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready); else ready();
})();
