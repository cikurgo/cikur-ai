/* ============================================================================
 * CIKUR GO — DRONE CGO FLEET ENGINE
 * Version: 6.10.0 — Real CCTV + Proxy + Diagnostic + Honest UI (Live-First + Katalog + Progresif + HLS-Langsung)
 * ============================================================================
 * ZERO REGRESSION: Semua fitur v4–v6.5 dipertahankan 100%
 * v6.10.0 (kamera BaliTower diputar tanpa iframe):
 *   - Tiap embed BaliTower diturunkan ke stream HLS-nya (…/<kode>/index.m3u8) → hlsAuto
 *   - DIAGNOSTIC memeriksa HLS langsung (CORS) sehingga jelas kamera mana yang bisa
 *     diputar tanpa proxy
 * v6.9.0 (scan terasa hidup):
 *   - Multi-scan menayangkan kamera live terdekat SEGERA (tanpa menunggu 11 wilayah selesai)
 *   - Event CCTV_SCAN_PROGRESSIVE dikirim tiap wilayah selesai → daftar & peta terisi bertahap
 * v6.8.0 (hasil scan bisa jadi tayangan):
 *   - Katalog kamera cameras.json (embed / hls / youtube / portal) dimuat otomatis
 *   - Pin OSM yang punya tag webcam (contact:webcam, webcam, camera:url, stream) ikut
 *     menjadi kamera live (YouTube / HLS) atau portal
 *   - Event scan membawa jumlah "live" agar UI tidak menyamakan pin dengan tayangan
 * v6.7.0 (perbaikan CCTV tidak termuat):
 *   - Kamera live (BaliTower) tidak lagi bergantung pada Overpass: dimuat & diputar
 *     langsung; bila Overpass gagal, kamera live tetap tampil (dulu hanya pin synthetic)
 *   - Proxy BENAR-BENAR dipakai (embedProxy / hlsProxy), + checkProxy() & probe()
 *   - Pin tanpa feed (OSM/synthetic) memutar kamera live terdekat (ditandai substitute)
 *   - Portal tidak lagi tertimpa HLS Batam; multi-scan tidak memilih portal sbg stream
 *   - Duplikat hasil multi-scan dihapus; _scanInProgress tidak bisa macet (try/finally)
 *   - fetchOverpass punya batas waktu total (dulu bisa 5+ menit)
 *   - diagnoseCCTV akurat (via proxy /probe), paralel, ber-timeout
 * Perubahan fokus CCTV (v6.6.0):
 *   - REAL_PUBLIC_CAMS: hanya BaliTower HTTPS (sumber yang realistis embed)
 *   - PUBLIC_STREAMS: HLS nyata (Batam), bukan film demo
 *   - REGION_PORTALS: ditandai openInNewTab (tidak dipaksa iframe)
 *   - _prepareStream: prioritas real cam → HLS → canvas
 *   - diagnoseCCTV(): test semua URL dan laporkan status
 *   - Proxy integration: gunakan CGO_ProxyURL jika tersedia
 * ============================================================================ */

(function (global) {
"use strict";

// ==========================================================================
// 0. KONSTANTA
// ==========================================================================
const VERSION = "6.10.3";
const TICK_MS = 1000;
const DRONE_MAX_LOG = 100;
const FLEET_MAX_LOG = 200;
const TELEM_HISTORY = 60;
const RTB_THRESHOLD = 15;
const RTB_HYSTERESIS = 20;
const MESH_RADIUS = 3;
const GRID_SIZE = 32;

const STATE = Object.freeze({
  IDLE:"IDLE", DEPLOYING:"DEPLOYING", MONITORING:"MONITORING",
  INTERACTING:"INTERACTING", EMERGENCY:"EMERGENCY",
  RETURN_TO_BASE:"RETURN_TO_BASE", OFFLINE:"OFFLINE"
});

const VALID_TRANSITIONS = {
  IDLE:["DEPLOYING","OFFLINE"],
  DEPLOYING:["MONITORING","RETURN_TO_BASE","OFFLINE"],
  MONITORING:["INTERACTING","EMERGENCY","RETURN_TO_BASE","OFFLINE"],
  INTERACTING:["MONITORING","EMERGENCY","RETURN_TO_BASE","OFFLINE"],
  EMERGENCY:["MONITORING","RETURN_TO_BASE","OFFLINE"],
  RETURN_TO_BASE:["IDLE","OFFLINE"],
  OFFLINE:["IDLE"]
};

const LOG_TYPE = Object.freeze({ INFO:0, SUCCESS:1, WARNING:2, DANGER:3 });

// ==========================================================================
// 1. UTILITAS
// ==========================================================================
const U = {
  clamp: (v, lo, hi) => v < lo ? lo : v > hi ? hi : v,
  rand: (lo, hi) => Math.random() * (hi - lo) + lo,
  randInt: (lo, hi) => Math.floor(Math.random() * (hi - lo + 1)) + lo,
  round: (v, d = 1) => Math.round(v * 10 ** d) / 10 ** d,
  now: () => new Date().toLocaleTimeString(),
  iso: () => new Date().toISOString()
};

// ==========================================================================
// 2. AUDIO ENGINE
// ==========================================================================
const AudioEngine = {
  _voices: [], _audioCtx: null, _voiceQueue: [], _speaking: false,
  _volume: 1.0, _muted: false,
  init() {
    if (!("speechSynthesis" in global)) return;
    const load = () => { this._voices = global.speechSynthesis.getVoices() || []; };
    load();
    if (global.speechSynthesis.onvoiceschanged !== undefined) {
      global.speechSynthesis.onvoiceschanged = load;
    }
  },
  _pickVoice(isEmergency) {
    const id = this._voices.filter(v => v.lang && v.lang.toLowerCase().startsWith("id"));
    if (id.length) {
      const female = id.find(v => /female|wanita|perempuan/i.test(v.name));
      return female || id[0];
    }
    return this._voices[0] || null;
  },
  speak(text, opts = {}) {
    if (!("speechSynthesis" in global) || this._muted) return;
    if (!text || !String(text).trim()) return;
    const isEmergency = !!opts.emergency;
    const priority = isEmergency ? 10 : 5;
    if (isEmergency) {
      try { global.speechSynthesis.cancel(); } catch (_) {}
      this._voiceQueue = [];
      this._speaking = false;
    }
    const chunks = String(text).match(/[^.!?…]+[.!?…]?/g) || [String(text)];
    for (const chunk of chunks) {
      const t = chunk.trim();
      if (!t) continue;
      this._voiceQueue.push({ text: t, priority, isEmergency });
    }
    this._voiceQueue.sort((a, b) => b.priority - a.priority);
    if (!this._speaking) this._drain();
  },
  _drain() {
    if (!this._voiceQueue.length) { this._speaking = false; return; }
    if (global.speechSynthesis.speaking || global.speechSynthesis.pending) {
      setTimeout(() => this._drain(), 200);
      return;
    }
    const job = this._voiceQueue.shift();
    const u = new SpeechSynthesisUtterance(job.text);
    const v = this._pickVoice(job.isEmergency);
    if (v) u.voice = v;
    u.lang = "id-ID";
    u.rate = job.isEmergency ? 0.95 : 0.92;
    u.pitch = 1.0;
    u.volume = this._volume;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      setTimeout(() => this._drain(), 180);
    };
    u.onend = finish;
    u.onerror = finish;
    this._speaking = true;
    try {
      global.speechSynthesis.speak(u);
      const estMs = Math.max(3000, job.text.length * 90);
      setTimeout(() => { if (!done) finish(); }, estMs + 2000);
    } catch (_) { this._speaking = false; finish(); }
  },
  _ensureCtx() {
    if (this._audioCtx) return this._audioCtx;
    try {
      const AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return null;
      this._audioCtx = new AC();
    } catch (_) {}
    return this._audioCtx;
  },
  playSiren(duration = 2.0) {
    if (this._muted) return;
    const ctx = this._ensureCtx(); if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    const osc = ctx.createOscillator(), gain = ctx.createGain(), t = ctx.currentTime;
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(400, t);
    osc.frequency.linearRampToValueAtTime(800, t + duration * .25);
    osc.frequency.linearRampToValueAtTime(400, t + duration * .5);
    osc.frequency.linearRampToValueAtTime(800, t + duration * .75);
    osc.frequency.linearRampToValueAtTime(400, t + duration);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(.12 * this._volume, t + .05);
    gain.gain.linearRampToValueAtTime(.12 * this._volume, t + duration - .1);
    gain.gain.linearRampToValueAtTime(0, t + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t); osc.stop(t + duration + .05);
  },
  playBeep(freq = 880, duration = .12) {
    if (this._muted) return;
    const ctx = this._ensureCtx(); if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    const osc = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime;
    osc.type = "sine"; osc.frequency.value = freq;
    g.gain.setValueAtTime(.08 * this._volume, t);
    g.gain.exponentialRampToValueAtTime(.001, t + duration);
    osc.connect(g).connect(ctx.destination);
    osc.start(t); osc.stop(t + duration + .02);
  },
  setVolume(v) { this._volume = U.clamp(v, 0, 1); },
  mute(m = true) {
    this._muted = m;
    if (m && "speechSynthesis" in global) global.speechSynthesis.cancel();
  },
  isMuted() { return this._muted; }
};

// ==========================================================================
// 3. IP SCANNER
// ==========================================================================
const IPScanner = {
  MIRRORS: [
    { url: "https://overpass-api.de/api/interpreter", country: "DE", host: "overpass-api.de" },
    { url: "https://overpass.kumi.systems/api/interpreter", country: "DE", host: "overpass.kumi.systems" },
    { url: "https://overpass.openstreetmap.ru/api/interpreter", country: "RU", host: "overpass.openstreetmap.ru" },
    { url: "https://overpass.openstreetmap.fr/api/interpreter", country: "FR", host: "overpass.openstreetmap.fr" }
  ],
  CORS_PROXIES: [
    "https://corsproxy.io/?",
    "https://api.allorigins.win/raw?url="
  ],
  IP_ENDPOINTS: [
    "https://api.ipify.org?format=json",
    "https://api64.ipify.org?format=json",
    "https://ipapi.co/json/",
    "https://api.myip.com",
    "https://ipinfo.io/json",
    "https://ifconfig.co/json"
  ],
  _currentMirror: 0,
  _publicIP: null,
  _geo: null,
  _busy: false,
  _lastMirrorChange: 0,
  TOTAL_BUDGET_MS: 45000,

  isBusy() { return this._busy; },

  nextMirror() {
    this._currentMirror = (this._currentMirror + 1) % this.MIRRORS.length;
    this._lastMirrorChange = Date.now();
    const m = this.MIRRORS[this._currentMirror];
    if (global.CGO_Fleet) {
      global.CGO_Fleet.emit("MIRROR_CHANGED", {
        host: m.host, country: m.country,
        index: this._currentMirror, total: this.MIRRORS.length
      });
    }
    return m;
  },

  getCurrentMirror() { return this.MIRRORS[this._currentMirror] || null; },

  async detectIP() {
    for (const url of this.IP_ENDPOINTS) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        const res = await fetch(url, { signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) continue;
        const data = await res.json();
        const ip = data.ip || data.query || data.IPv4 || data.ip_address;
        if (ip) {
          const geo = {
            ...data,
            country_code: data.country_code || data.countryCode || data.country || data.country_iso || "",
            country_name: data.country_name || data.country || "",
            city: data.city || data.region || "",
            org: data.org || data.asn || data.isp || data.organization || ""
          };
          this._publicIP = ip;
          this._geo = geo;
          if (global.CGO_Fleet) global.CGO_Fleet.emit("IP_DETECTED", { ip, geo });
          return { ip, geo };
        }
      } catch (_) {}
    }
    return null;
  },

  _buildAttempts(mirrorUrl, query) {
    const dataParam = "data=" + encodeURIComponent(query);
    const getUrl = mirrorUrl + (mirrorUrl.includes("?") ? "&" : "?") + dataParam;
    const attempts = [
      { url: mirrorUrl, method: "POST", body: dataParam, label: "POST direct" },
      { url: getUrl, method: "GET", body: null, label: "GET direct" }
    ];
    for (const p of this.CORS_PROXIES) {
      if (!p) continue;
      const proxied = p.includes("?") ? p + encodeURIComponent(getUrl) : p + getUrl;
      attempts.push({ url: proxied, method: "GET", body: null, label: "GET proxy" });
    }
    return attempts;
  },

  async fetchOverpass(query, timeout = 25000) {
    if (this._busy) throw new Error("Scanner sedang sibuk");
    this._busy = true;
    const startIdx = this._currentMirror;
    let lastErr = null;
    const deadline = Date.now() + this.TOTAL_BUDGET_MS;
    try {
      for (let attempt = 0; attempt < this.MIRRORS.length; attempt++) {
        const idx = (startIdx + attempt) % this.MIRRORS.length;
        const mirror = this.MIRRORS[idx];
        const attempts = this._buildAttempts(mirror.url, query);
        for (const att of attempts) {
          if (Date.now() > deadline) { lastErr = lastErr || new Error("batas waktu scan terlampaui"); break; }
          try {
            if (global.CGO_Fleet) {
              global.CGO_Fleet.logGlobal(
                `🌐 [NET] ${mirror.host} [${mirror.country}] · ${att.label}`, "INFO"
              );
            }
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), Math.min(timeout, 12000));
            const opts = { method: att.method, signal: ctrl.signal };
            if (att.method === "POST") {
              opts.headers = { "Content-Type": "application/x-www-form-urlencoded" };
              opts.body = att.body;
            }
            const res = await fetch(att.url, opts);
            clearTimeout(timer);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (!data || !Array.isArray(data.elements)) throw new Error("Invalid response");
            this._currentMirror = idx;
            if (global.CGO_Fleet) {
              global.CGO_Fleet.logGlobal(
                `✅ [NET] OK: ${mirror.host} (${att.label}) · ${data.elements.length} elements`, "SUCCESS"
              );
            }
            return data;
          } catch (e) { lastErr = e; }
        }
        if (Date.now() > deadline) break;
        if (global.CGO_Fleet) {
          global.CGO_Fleet.logGlobal(
            `⚠️ [NET] Mirror ${mirror.host} gagal semua metode — rotasi...`, "WARNING"
          );
        }
      }
      throw new Error("Semua mirror/proxy gagal: " + (lastErr?.message || "unknown"));
    } finally { this._busy = false; }
  },

  getStatus() {
    return {
      publicIP: this._publicIP, geo: this._geo,
      mirror: this.getCurrentMirror(), mirrorIndex: this._currentMirror,
      totalMirrors: this.MIRRORS.length, proxies: this.CORS_PROXIES.length,
      busy: this._busy
    };
  }
};

// ==========================================================================
// 4. DRONE ENTITY
// ==========================================================================
class DroneEntity {
  constructor(id) {
    this.id = id; this.state = STATE.IDLE; this.isDeployed = false;
    this.sector = { x: 0, y: 0 }; this.formation = null;
    this._interactTimer = null; this._rtbLock = false; this._jamTicks = 0;
    this.blackBox = [];
    this.telemetry = {
      battery: 100, solarInput: 0, altitude: 0, speed: 0,
      windSpeed: 2.5, smokeLevel: 0, lidarDistance: 50,
      acousticAlert: false, networkStatus: "STARLINK_LINK_ACTIVE",
      signalStrength: 95, isJammed: false, isDaylight: true, sunAngle: 90,
      currentTarget: null, position: { x: 0, y: 0, z: 0 }, uptime: 0
    };
    this._history = { battery: [], signal: [] };
  }
  _canTransition(next) { return (VALID_TRANSITIONS[this.state] || []).includes(next); }
  _transition(next) {
    if (!this._canTransition(next)) {
      this.log(`Transisi tidak valid: ${this.state} → ${next}`, "WARNING");
      return false;
    }
    this.state = next; return true;
  }
  log(message, type = "INFO") {
    const entry = { time: U.now(), message, type, droneId: this.id };
    this.blackBox.push(entry);
    if (this.blackBox.length > DRONE_MAX_LOG) this.blackBox.shift();
    return entry;
  }
  deploy() {
    if (!this._transition(STATE.DEPLOYING)) return null;
    this.isDeployed = true;
    return this.log("Misi dimulai. Lepas landas.", "SUCCESS");
  }
  returnToBase() {
    if (this.state === STATE.IDLE || this.state === STATE.OFFLINE) return null;
    if (this._interactTimer) { clearTimeout(this._interactTimer); this._interactTimer = null; }
    if (!this._transition(STATE.RETURN_TO_BASE)) return null;
    this.telemetry.currentTarget = null;
    return this.log("Perintah RTB diterima.", "WARNING");
  }
  interactWithTarget(targetName) {
    if (this.state !== STATE.MONITORING) return null;
    if (!this._transition(STATE.INTERACTING)) return null;
    this.telemetry.currentTarget = targetName;
    const log = this.log(`[MATA CGO] Target: ${targetName}.`, "SUCCESS");
    this._interactTimer = setTimeout(() => {
      if (this.state === STATE.INTERACTING) {
        this._transition(STATE.MONITORING);
        this.telemetry.currentTarget = null;
      }
      this._interactTimer = null;
    }, 8000);
    return log;
  }
  triggerTsunamiAlert() {
    this._transition(STATE.EMERGENCY);
    this.telemetry.networkStatus = "STARLINK_EMERGENCY_MODE";
    return this.log("🚨 [CRITICAL] TSUNAMI ALERT!", "DANGER");
  }
  activateVoidPulse() {
    this.telemetry.isJammed = false;
    this.telemetry.signalStrength = 100;
    this.telemetry.networkStatus = "SECURE_SATELLITE_LINK";
    this._jamTicks = 0;
    return this.log("⚡ [DEFENSE] VOID PULSE.", "DANGER");
  }
  tick(isDaylight, sunAngle, gridStats) {
    if (!this.isDeployed || this.state === STATE.OFFLINE) return;
    const T = this.telemetry;
    T.isDaylight = isDaylight; T.sunAngle = sunAngle; T.uptime++;
    const sunFactor = isDaylight ? Math.max(0.15, Math.sin(sunAngle * Math.PI / 180)) : 0;
    T.solarInput = U.round(sunFactor * 15, 2);
    let powerDraw = 0.15;
    if (this.state === STATE.MONITORING || this.state === STATE.INTERACTING) powerDraw = 0.08;
    else if (this.state === STATE.EMERGENCY) powerDraw = 0.25;
    const solarGain = T.solarInput / 100;
    T.battery = U.clamp(T.battery - powerDraw + solarGain, 0, 100);
    if (T.battery <= 0) {
      T.battery = 0; this._transition(STATE.OFFLINE);
      this.log("BATERAI HABIS.", "DANGER"); return;
    }
    if (this.state === STATE.MONITORING) {
      if (T.battery < RTB_THRESHOLD && !this._rtbLock) {
        this._rtbLock = true; this.returnToBase();
      } else if (T.battery > RTB_HYSTERESIS) this._rtbLock = false;
    }
    switch (this.state) {
      case STATE.DEPLOYING:
        T.altitude = Math.min(T.altitude + 5, 50); T.speed = 45;
        if (T.altitude >= 50) this._transition(STATE.MONITORING);
        break;
      case STATE.MONITORING: case STATE.EMERGENCY: case STATE.INTERACTING:
        T.speed = this.state === STATE.EMERGENCY ? 25 : 0;
        T.lidarDistance = U.round(U.rand(20, 100), 1);
        T.smokeLevel = Math.random() > 0.9 ? U.round(U.rand(0, 50), 1) : 0;
        T.windSpeed = U.round(U.rand(1, 11), 1);
        T.acousticAlert = Math.random() > 0.95;
        T.position.x = U.round(T.position.x + U.rand(-0.5, 0.5), 2);
        T.position.y = U.round(T.position.y + U.rand(-0.5, 0.5), 2);
        T.position.z = T.altitude; break;
      case STATE.RETURN_TO_BASE:
        T.altitude = Math.max(T.altitude - 5, 0);
        T.speed = 30; T.position.z = T.altitude;
        if (T.altitude <= 0) { this.isDeployed = false; this._transition(STATE.IDLE); }
        break;
    }
    if (!T.isJammed && Math.random() > 0.995) {
      const meshHelp = gridStats && gridStats.meshAvailable;
      if (!meshHelp) {
        T.isJammed = true; T.networkStatus = "SIGNAL_LOST_JAMMED";
        T.signalStrength = 10; this._jamTicks = 0;
        this.log("⚠️ Hostile Jammer detected!", "DANGER");
      }
    } else if (T.isJammed) {
      this._jamTicks++;
      if (this._jamTicks >= U.randInt(5, 15)) {
        T.isJammed = false; T.networkStatus = "MESH_RELAY_ESTABLISHED";
        T.signalStrength = U.randInt(60, 85);
        this.log("✅ Sinyal pulih.", "SUCCESS");
        this._jamTicks = 0;
      }
    } else T.signalStrength = U.randInt(85, 100);
    this._history.battery.push(U.round(T.battery, 1));
    this._history.signal.push(T.signalStrength);
    if (this._history.battery.length > TELEM_HISTORY) this._history.battery.shift();
    if (this._history.signal.length > TELEM_HISTORY) this._history.signal.shift();
  }
  getHistory() { return { battery: this._history.battery.slice(), signal: this._history.signal.slice() }; }
  toJSON() { return { id: this.id, state: this.state, isDeployed: this.isDeployed, sector: this.sector, telemetry: this.telemetry }; }
}

// ==========================================================================
// 5. SWARM COORDINATOR
// ==========================================================================
const SwarmCoordinator = {
  GRID: GRID_SIZE, _sectorMap: new Map(), _formation: "grid",
  assignSector(drone) {
    const n = parseInt(drone.id.split("-")[1], 10) || 0;
    drone.sector.x = n % this.GRID;
    drone.sector.y = Math.floor(n / this.GRID) % this.GRID;
  },
  rebuildSectorMap(drones) {
    this._sectorMap.clear();
    for (const d of drones.values()) {
      const key = `${d.sector.x},${d.sector.y}`;
      if (!this._sectorMap.has(key)) this._sectorMap.set(key, []);
      this._sectorMap.get(key).push(d.id);
    }
  },
  getNeighbors(drone) {
    const ids = [];
    for (let dx = -MESH_RADIUS; dx <= MESH_RADIUS; dx++) {
      for (let dy = -MESH_RADIUS; dy <= MESH_RADIUS; dy++) {
        if (dx === 0 && dy === 0) continue;
        const key = `${drone.sector.x + dx},${drone.sector.y + dy}`;
        const arr = this._sectorMap.get(key);
        if (arr) ids.push(...arr);
      }
    }
    return ids;
  },
  getMeshAvailability(drone, droneMap) {
    const neighbors = this.getNeighbors(drone);
    let healthy = 0;
    for (const id of neighbors) {
      const d = droneMap.get(id);
      if (d && d.telemetry.signalStrength > 50 && !d.telemetry.isJammed) healthy++;
    }
    return { count: healthy, meshAvailable: healthy >= 2 };
  },
  setFormation(name) {
    if (["grid", "circle", "v", "line"].includes(name)) { this._formation = name; return true; }
    return false;
  },
  getFormation() { return this._formation; }
};

// ==========================================================================
// 6. CCTV ENGINE (Real Priority + Proxy + Diagnostic)
// ==========================================================================
const CCTVEngine = {
  _activeStreams: new Map(),
  _lastScan: null,
  _scanInProgress: false,

  REGIONS: [
    { name: "Jakarta Pusat",   lat: -6.1751, lng: 106.8272, radius: 4000 },
    { name: "Jakarta Selatan", lat: -6.2615, lng: 106.8106, radius: 4000 },
    { name: "Tangerang",       lat: -6.1783, lng: 106.6319, radius: 5000 },
    { name: "Tangerang Selatan", lat: -6.2889, lng: 106.7181, radius: 5000 },
    { name: "Serang (Banten)", lat: -6.1200, lng: 106.1503, radius: 5000 },
    { name: "Bandung",         lat: -6.9175, lng: 107.6191, radius: 4000 },
    { name: "Surabaya",        lat: -7.2575, lng: 112.7521, radius: 4000 },
    { name: "Medan",           lat:  3.5952, lng:  98.6722, radius: 4000 },
    { name: "Semarang",        lat: -6.9932, lng: 110.4203, radius: 4000 },
    { name: "Yogyakarta",      lat: -7.7956, lng: 110.3695, radius: 4000 },
    { name: "Denpasar",        lat: -8.6500, lng: 115.2167, radius: 4000 }
  ],

  /* HLS publik NYATA (bukan film demo) */
  PUBLIC_STREAMS: [
    "https://matanya.batam.go.id/cctv/casablanca2/stream.m3u8",
    "https://matanya.batam.go.id/cctv/danganom1/stream.m3u8"
  ],

  /* Kamera publik real — hanya BaliTower HTTPS */
  REAL_PUBLIC_CAMS: [
    { name: "Bendungan Hilir 1", lat: -6.2146, lng: 106.8081, embed: "https://cctv.balitower.co.id/Bendungan-Hilir-003-700014_1/embed.html", region: "Jakarta" },
    { name: "Bendungan Hilir 2", lat: -6.2148, lng: 106.8085, embed: "https://cctv.balitower.co.id/Bendungan-Hilir-003-700014_2/embed.html", region: "Jakarta" },
    { name: "Bendungan Hilir 3", lat: -6.2150, lng: 106.8078, embed: "https://cctv.balitower.co.id/Bendungan-Hilir-003-700014_3/embed.html", region: "Jakarta" },
    { name: "Bendungan Hilir 4", lat: -6.2144, lng: 106.8090, embed: "https://cctv.balitower.co.id/Bendungan-Hilir-003-700014_4/embed.html", region: "Jakarta" },
    { name: "GBK / Gelora 2", lat: -6.2186, lng: 106.8021, embed: "https://cctv.balitower.co.id/Gelora-017-700470_2/embed.html", region: "Jakarta" },
    { name: "GBK / Gelora 3", lat: -6.2188, lng: 106.8025, embed: "https://cctv.balitower.co.id/Gelora-017-700470_3/embed.html", region: "Jakarta" },
    { name: "GBK Asia Afrika", lat: -6.2240, lng: 106.8025, embed: "https://cctv.balitower.co.id/GBKC1002/embed.html", region: "Jakarta" },
    { name: "Manggarai Pintu Air 1", lat: -6.2100, lng: 106.8480, embed: "https://cctv.balitower.co.id/Manggarai-Pintu-Air_1/embed.html?proto=hls", region: "Jakarta" },
    { name: "Manggarai Pintu Air 2", lat: -6.2105, lng: 106.8485, embed: "https://cctv.balitower.co.id/Manggarai-Pintu-Air_2/embed.html?proto=hls", region: "Jakarta" },
    { name: "Tanjung Duren", lat: -6.1780, lng: 106.7900, embed: "https://cctv.balitower.co.id/Tanjung-Duren-Utara-005-702471_2/embed.html", region: "Jakarta" },
    { name: "Tomang", lat: -6.1720, lng: 106.7970, embed: "https://cctv.balitower.co.id/Tomang-004-702108_2/embed.html", region: "Jakarta" },
    { name: "Jati Pulo", lat: -6.1800, lng: 106.8000, embed: "https://cctv.balitower.co.id/Jati-Pulo-001-702017_2/embed.html", region: "Jakarta" },
    { name: "Cengkareng Barat", lat: -6.1450, lng: 106.7300, embed: "https://cctv.balitower.co.id/Cengkareng-Barat-013-702131_2/embed.html", region: "Jakarta" },
    { name: "Menteng / Bundaran HI", lat: -6.1944, lng: 106.8229, embed: "https://cctv.balitower.co.id/Menteng-001-700123_1/embed.html", region: "Jakarta" },
    { name: "Senayan 1", lat: -6.2270, lng: 106.8000, embed: "https://cctv.balitower.co.id/Senayan-004-705087_1/embed.html", region: "Jakarta" },
    { name: "Senayan 2", lat: -6.2275, lng: 106.8005, embed: "https://cctv.balitower.co.id/Senayan-004-705087_2/embed.html", region: "Jakarta" },
    { name: "Kemanggisan", lat: -6.1900, lng: 106.7850, embed: "https://cctv.balitower.co.id/Kemanggisan-038-792405_2/embed.html", region: "Jakarta" }
  ],

  /* Portal resmi — buka di tab baru */
  REGION_PORTALS: [
    { name: "Portal ATCS Tangerang Kab", lat: -6.1783, lng: 106.6319, url: "https://cctv-dishub.tangerangkab.go.id/cctv", region: "Banten", openInNewTab: true },
    { name: "Portal CCTV Banten Prov", lat: -6.1200, lng: 106.1503, url: "https://cctv.bantenprov.go.id/home", region: "Banten", openInNewTab: true },
    { name: "Portal CCTV Serang", lat: -6.1200, lng: 106.1503, url: "https://cctv.serangkota.go.id/", region: "Banten", openInNewTab: true },
    { name: "Portal ATCS Bandung", lat: -6.9175, lng: 107.6191, url: "https://atcs-dishub.bandung.go.id/", region: "Bandung", openInNewTab: true },
    { name: "Portal Pelindung Bandung", lat: -6.9175, lng: 107.6191, url: "https://pelindung.bandung.go.id/", region: "Bandung", openInNewTab: true },
    { name: "Portal CCTV Jogja", lat: -7.7956, lng: 110.3695, url: "https://cctv.jogjakota.go.id/", region: "Yogyakarta", openInNewTab: true },
    { name: "Portal CCTV Semarang", lat: -6.9932, lng: 110.4203, url: "https://pantausemar.semarangkota.go.id/", region: "Semarang", openInNewTab: true },
    { name: "Portal CCTV Denpasar", lat: -8.6500, lng: 115.2167, url: "https://atcs.denpasarkota.go.id/", region: "Denpasar", openInNewTab: true },
    { name: "Portal CCTV Jakarta Publik", lat: -6.1751, lng: 106.8272, url: "https://jakcctv.jakarta.go.id/publik", region: "Jakarta", openInNewTab: true }
  ],

  /* Proxy URL — diisi oleh UI / CGO_ProxyURL / ?proxy= / localStorage */
  PROXY_URL: null,
  _proxyOk: null,
  _proxyCheckedAt: 0,

  _normProxy(u) {
    if (!u) return null;
    u = String(u).trim();
    if (!u) return null;
    /* Tolak paste isi file proxy-worker.js / sampah */
    if (u.length > 280 || /[\r\n]/.test(u)) return null;
    if (/PROXY_VERSION|ALLOWED_DOMAINS|createHandler|HEADERS_TO_|function\s+respond|===== CORE/i.test(u)) return null;
    if (!/^https?:\/\//i.test(u)) u = "https://" + u;
    let parsed;
    try { parsed = new URL(u); } catch (_) { return null; }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const host = (parsed.hostname || "").toLowerCase();
    if (!host || host === "*") return null;
    if (host !== "localhost" && !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(host)) return null;
    return parsed.origin;
  },
  setProxyUrl(url) {
    this.PROXY_URL = this._normProxy(url);
    this._proxyOk = null; this._proxyCheckedAt = 0;
    try {
      if (global.localStorage) {
        if (this.PROXY_URL) global.localStorage.setItem("cgo_proxy_url", this.PROXY_URL);
        else global.localStorage.removeItem("cgo_proxy_url");
      }
    } catch (_) {}
    if (global.CGO_Fleet) global.CGO_Fleet.emit("PROXY_CHANGED", { url: this.PROXY_URL });
    return this.PROXY_URL;
  },
  getProxyUrl() {
    if (this.PROXY_URL) return this.PROXY_URL;
    const tryOne = (raw) => {
      const n = this._normProxy(raw);
      if (n) { this.PROXY_URL = n; return n; }
      return null;
    };
    try { if (global.CGO_ProxyURL) { const n = tryOne(global.CGO_ProxyURL); if (n) return n; } } catch (_) {}
    try {
      const q = global.location && new URLSearchParams(global.location.search).get("proxy");
      if (q) { const n = tryOne(q); if (n) return n; }
    } catch (_) {}
    try {
      const sv = global.localStorage && global.localStorage.getItem("cgo_proxy_url");
      if (sv) {
        const n = this._normProxy(sv);
        if (n) { this.PROXY_URL = n; return n; }
        try { global.localStorage.removeItem("cgo_proxy_url"); } catch (_) {}
      }
    } catch (_) {}
    try {
      const loc = global.location;
      if (loc && (loc.hostname === "localhost" || loc.hostname === "127.0.0.1" || loc.protocol === "file:")) {
        return "http://localhost:3001";
      }
    } catch (_) {}
    return null;
  },
  proxify(url) {
    const p = this.getProxyUrl();
    return (p && url) ? p + "/proxy?url=" + encodeURIComponent(url) : url;
  },
  async checkProxy(force = false) {
    const p = this.getProxyUrl();
    if (!p) return false;
    if (!force && this._proxyOk !== null && Date.now() - this._proxyCheckedAt < 15000) return this._proxyOk;
    let ok = false;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(p + "/health", { signal: ctrl.signal });
      clearTimeout(t);
      const j = res.ok ? await res.json() : null;
      ok = !!(j && j.status === "ok");
    } catch (_) {}
    this._proxyOk = ok; this._proxyCheckedAt = Date.now();
    if (global.CGO_Fleet) global.CGO_Fleet.emit("PROXY_STATUS", { url: p, ok });
    return ok;
  },
  async probe(url, timeoutMs = 9000) {
    const p = this.getProxyUrl();
    if (!p) return null;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(p + "/probe?url=" + encodeURIComponent(url), { signal: ctrl.signal });
      return await res.json();
    } catch (e) {
      return { ok: false, status: 0, error: e.name === "AbortError" ? "timeout" : e.message };
    } finally { clearTimeout(t); }
  },
  setStreamUrls(urls) { this.PUBLIC_STREAMS = Array.isArray(urls) ? urls.slice() : []; },

  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  },

  _spawnSyntheticCCTV(centerLat, centerLng, count = 10, radiusKm = 1.5) {
    const cctvs = [];
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.3;
      const r = (0.2 + Math.random() * 0.8) * radiusKm / 111;
      const lat = centerLat + Math.cos(angle) * r;
      const lng = centerLng + Math.sin(angle) * r;
      const dist = Math.round(this.calculateDistance(centerLat, centerLng, lat, lng));
      cctvs.push({
        id: `SIM-${Date.now()}-${i}-${Math.random().toString(36).slice(2,6)}`,
        lat, lng, distance: dist,
        name: `SIM-CCTV-${String(i + 1).padStart(2, "0")}`,
        surveillanceType: "simulated",
        synthetic: true,
        tags: { synthetic: "yes" }
      });
    }
    return cctvs;
  },

  /* ---------- Katalog kamera (cameras.json) ---------- */
  CATALOG_URL: "cameras.json",
  _catalogPromise: null,
  ensureCatalog() {
    if (!this._catalogPromise) this._catalogPromise = this.loadCatalog();
    return this._catalogPromise;
  },
  async loadCatalog(url) {
    const out = { added: 0, skipped: 0, error: null };
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      let res;
      try { res = await fetch(url || this.CATALOG_URL, { cache: "no-store", signal: ctrl.signal }); }
      finally { clearTimeout(t); }
      if (!res.ok) throw new Error("HTTP " + res.status);
      const j = await res.json();
      const list = Array.isArray(j) ? j : ((j && j.cameras) || []);
      for (const c of list) { if (this._addCatalogCam(c)) out.added++; else out.skipped++; }
    } catch (e) { out.error = e && e.name === "AbortError" ? "timeout" : (e && e.message); }
    if (global.CGO_Fleet) {
      global.CGO_Fleet.emit("CATALOG_LOADED", out);
      if (out.added) global.CGO_Fleet.logGlobal(`📚 [CCTV] Katalog: ${out.added} kamera ditambahkan`, "SUCCESS");
    }
    return out;
  },
  _addCatalogCam(c) {
    if (!c || c.disabled || !c.name || !isFinite(Number(c.lat)) || !isFinite(Number(c.lng))) return false;
    const lat = Number(c.lat), lng = Number(c.lng), name = String(c.name), region = c.region || "Katalog";
    const type = String(c.type || "").toLowerCase();
    const url = c.url ? String(c.url).trim() : "";
    const has = (arr) => arr.some(x => x.name === name);
    if (type === "portal") {
      if (!/^https?:\/\//i.test(url) || has(this.REGION_PORTALS)) return false;
      this.REGION_PORTALS.push({ name, lat, lng, url, region, openInNewTab: true });
      return true;
    }
    if (has(this.REAL_PUBLIC_CAMS)) return false;
    if (type === "embed") {
      if (!/^https:\/\//i.test(url)) return false;
      this.REAL_PUBLIC_CAMS.push({ name, lat, lng, embed: url, region });
      return true;
    }
    if (type === "hls") {
      if (!/^https:\/\//i.test(url)) return false;
      this.REAL_PUBLIC_CAMS.push({ name, lat, lng, hls: url, region });
      return true;
    }
    if (type === "youtube") {
      let embed = null;
      if (c.id && /^[\w-]{6,}$/.test(String(c.id))) embed = "https://www.youtube.com/embed/" + c.id + "?autoplay=1&mute=1";
      else if (c.channel && /^UC[\w-]{10,}$/.test(String(c.channel))) embed = "https://www.youtube.com/embed/live_stream?channel=" + c.channel + "&autoplay=1&mute=1";
      else if (url) embed = this._youtubeEmbed(url);
      if (!embed) return false;
      this.REAL_PUBLIC_CAMS.push({ name, lat, lng, embed, noProxy: true, region });
      return true;
    }
    return false;
  },
  _youtubeEmbed(url) {
    if (/youtube\.com\/embed\//i.test(url)) return url;
    let m = url.match(/youtube\.com\/watch\?[^#]*v=([\w-]{6,})/i) || url.match(/youtu\.be\/([\w-]{6,})/i) ||
            url.match(/youtube\.com\/live\/([\w-]{6,})/i);
    if (m) return "https://www.youtube.com/embed/" + m[1] + "?autoplay=1&mute=1";
    m = url.match(/youtube\.com\/channel\/(UC[\w-]{10,})/i);
    if (m) return "https://www.youtube.com/embed/live_stream?channel=" + m[1] + "&autoplay=1&mute=1";
    return null;
  },
  /* Pin OSM yang menyertakan alamat webcam → ubah jadi kamera live / portal */
  _osmStream(tags) {
    if (!tags) return null;
    const raw = tags["contact:webcam"] || tags["webcam"] || tags["camera:url"] || tags["stream"];
    if (!raw) return null;
    const url = String(raw).trim();
    if (!/^https?:\/\//i.test(url)) return null;
    const yt = this._youtubeEmbed(url);
    if (yt) return { realPublic: true, embed: yt, noProxy: true, surveillanceType: "osm_stream", fromOSM: true };
    if (/^https:\/\/[^\s]+\.m3u8(\?|$)/i.test(url)) return { realPublic: true, hls: url, surveillanceType: "osm_stream", fromOSM: true };
    return { realPublic: true, embed: url, isPortal: true, openInNewTab: true, surveillanceType: "osm_portal", fromOSM: true };
  },
  _camEntry(rc, dist) {
    const e = {
      id: "REAL-" + rc.name.replace(/\s+/g, "-"),
      lat: rc.lat, lng: rc.lng, distance: dist,
      name: rc.name, surveillanceType: "public_live",
      realPublic: true, embed: rc.embed, region: rc.region
    };
    if (rc.hls) e.hls = rc.hls;
    if (rc.noProxy) e.noProxy = true;
    const auto = rc.hls ? null : this._hlsFromEmbed(rc.embed);
    if (auto) e.hlsAuto = auto;
    return e;
  },
  /* Halaman embed BaliTower = pemutar Flussonic; stream HLS-nya ada di folder yang sama */
  _hlsFromEmbed(embed) {
    const m = String(embed || "").match(/^https?:\/\/(cctv\.balitower\.co\.id)\/([^/?#]+)\/embed\.html/i);
    return m ? "https://" + m[1] + "/" + m[2] + "/index.m3u8" : null;
  },

  /* Gabungan sementara (dedupe + kamera live/portal) untuk tampilan progresif */
  _mergePartial(allCCTVs, baseLat, baseLng) {
    const seen = new Map();
    for (const c of allCCTVs) { const k = String(c.id); if (!seen.has(k)) seen.set(k, c); }
    for (const c of this._liveEntries(baseLat, baseLng, { realMax: Infinity, portalMax: Infinity })) {
      const k = String(c.id);
      if (seen.has(k)) seen.get(k).distance = c.distance; else seen.set(k, c);
    }
    return Array.from(seen.values()).sort((a, b) => a.distance - b.distance);
  },

  /* Entri kamera live (BaliTower) + portal — murni lokal, tanpa jaringan */
  _liveEntries(lat, lng, opts = {}) {
    const realMax = opts.realMax != null ? opts.realMax : 20000;
    const portalMax = opts.portalMax != null ? opts.portalMax : 50000;
    const out = [];
    for (const rc of this.REAL_PUBLIC_CAMS) {
      const dist = Math.round(this.calculateDistance(lat, lng, rc.lat, rc.lng));
      if (dist <= realMax) out.push(this._camEntry(rc, dist));
    }
    for (const p of this.REGION_PORTALS) {
      const dist = Math.round(this.calculateDistance(lat, lng, p.lat, p.lng));
      if (dist <= portalMax) {
        out.push({
          id: "PORTAL-" + p.name.replace(/\s+/g, "-"),
          lat: p.lat, lng: p.lng, distance: dist,
          name: p.name, surveillanceType: "portal_live",
          realPublic: true, embed: p.url, region: p.region,
          isPortal: true, openInNewTab: true
        });
      }
    }
    out.sort((a, b) => a.distance - b.distance);
    return out;
  },

  /* Kamera live (non-portal) terdekat dari titik tertentu */
  _nearestLive(lat, lng, maxKm = 25) {
    let best = null, bestD = Infinity;
    for (const rc of this.REAL_PUBLIC_CAMS) {
      const d = this.calculateDistance(lat, lng, rc.lat, rc.lng);
      if (d < bestD && d / 1000 <= maxKm) {
        bestD = d;
        best = this._camEntry(rc, Math.round(d));
      }
    }
    return best;
  },

  findNearestRealCam(lat, lng, maxKm = 12) {
    let best = null, bestD = Infinity;
    for (const cam of this.REAL_PUBLIC_CAMS) {
      const d = this.calculateDistance(lat, lng, cam.lat, cam.lng) / 1000;
      if (d < bestD && d <= maxKm) {
        bestD = d;
        best = { ...cam, distance: Math.round(d * 1000) };
      }
    }
    if (best) return best;
    for (const p of this.REGION_PORTALS) {
      const d = this.calculateDistance(lat, lng, p.lat, p.lng) / 1000;
      if (d < bestD && d <= 40) {
        bestD = d;
        best = { ...p, distance: Math.round(d * 1000), isPortal: true, embed: p.url };
      }
    }
    return best;
  },

  async scanNearby(lat, lng, radius = 5000, options = {}) {
    const fleet = global.CGO_Fleet;
    if (!fleet) return null;
    if (this._scanInProgress && !options.allowConcurrent) {
      fleet.logGlobal("⚠️ [CCTV] Scan sedang berjalan...", "WARNING");
      return null;
    }
    if (!options.allowConcurrent) this._scanInProgress = true;
    fleet.logGlobal(`📡 [CCTV] Scan (${lat.toFixed(4)}, ${lng.toFixed(4)}) r=${radius}m...`, "INFO");
    if (!options.silent) fleet.emit("CCTV_SCAN_START", { lat, lng, radius });

    let live = [];
    try {
      await this.ensureCatalog();
      /* v6.7: kamera live tidak bergantung pada Overpass — siapkan & putar dulu */
      live = this._liveEntries(lat, lng, { realMax: Math.max(radius, 20000), portalMax: 50000 });
      if (!options.skipStream && !this._activeStreams.has("default")) {
        const firstLive = live.find(c => !c.isPortal);
        if (firstLive) this._prepareStream(firstLive, fleet);
      }

      const query = `
        [out:json][timeout:25];
        (
          node["man_made"="surveillance"](around:${radius},${lat},${lng});
          way["man_made"="surveillance"](around:${radius},${lat},${lng});
          relation["man_made"="surveillance"](around:${radius},${lat},${lng});
          node["surveillance"="camera"](around:${radius},${lat},${lng});
          node["surveillance:type"="camera"](around:${radius},${lat},${lng});
          node["camera:type"](around:${radius},${lat},${lng});
          node["highway"="traffic_signals"]["surveillance"](around:${radius},${lat},${lng});
        );
        out center tags;
      `;

      const data = await IPScanner.fetchOverpass(query, 25000);
      const elements = data.elements || [];
      const cctvs = [];

      for (const el of elements) {
        const elLat = el.lat ?? el.center?.lat;
        const elLon = el.lon ?? el.center?.lon;
        if (elLat == null || elLon == null) continue;
        const dist = this.calculateDistance(lat, lng, elLat, elLon);
        if (dist > radius) continue;
        const entry = {
          id: el.id, type: el.type, lat: elLat, lng: elLon,
          tags: el.tags || {}, distance: Math.round(dist),
          name: el.tags?.name || el.tags?.description || `CCTV-${el.id}`,
          operator: el.tags?.operator || null,
          surveillanceType: el.tags?.["surveillance:type"] || "unknown"
        };
        const osmLive = this._osmStream(el.tags);
        if (osmLive) Object.assign(entry, osmLive);
        cctvs.push(entry);
      }

      cctvs.push(...live);

      if (cctvs.length === 0) {
        fleet.logGlobal(`[CCTV] OSM kosong → spawn 6 synthetic pin`, "WARNING");
        cctvs.push(...this._spawnSyntheticCCTV(lat, lng, 6, 2));
      } else {
        const realN = cctvs.filter(c => c.realPublic).length;
        fleet.logGlobal(`[CCTV] ${cctvs.length} kamera (${realN} public live)`, "SUCCESS");
      }
      cctvs.sort((a, b) => a.distance - b.distance);

      const nearest = cctvs[0] || null;
      this._lastScan = {
        queryLat: lat, queryLng: lng, radius, cctvs, nearest, timestamp: U.iso()
      };

      fleet.logGlobal(
        `✅ [CCTV] ${cctvs.length} unit. Terdekat: ${nearest ? nearest.name + " (" + nearest.distance + "m)" : "—"}`,
        cctvs.length > 0 ? "SUCCESS" : "WARNING"
      );
      if (!options.silent) {
        fleet.emit("CCTV_SCAN_SUCCESS", {
          cctvs, nearest, total: cctvs.length,
          live: cctvs.filter(c => c.realPublic && !c.isPortal).length,
          queryLat: lat, queryLng: lng, radius
        });
      }

      const hasActive = this._activeStreams.has("default");
      if (nearest && !options.skipStream && !hasActive) {
        this._prepareStream(nearest, fleet);
      } else if (nearest && hasActive && !options.skipStream) {
        fleet.logGlobal(`🎥 [CCTV] Stream aktif dipertahankan`, "INFO");
      }

      return { cctvs, nearest, queryLat: lat, queryLng: lng, radius };
    } catch (err) {
      fleet.logGlobal(`❌ [CCTV] ${err.message}`, "DANGER");
      if (!options.silent) {
        /* v6.7: Overpass gagal ≠ kamera live hilang. Tampilkan kamera live; synthetic hanya jika kosong */
        const cctvs = live.slice();
        if (cctvs.length === 0) cctvs.push(...this._spawnSyntheticCCTV(lat, lng, 8, 2));
        cctvs.sort((a, b) => a.distance - b.distance);
        const nearest = cctvs[0];
        this._lastScan = { queryLat: lat, queryLng: lng, radius, cctvs, nearest, timestamp: U.iso() };
        fleet.emit("CCTV_SCAN_SUCCESS", {
          cctvs, nearest, total: cctvs.length,
          live: cctvs.filter(c => c.realPublic && !c.isPortal).length,
          queryLat: lat, queryLng: lng, radius, fallback: true, overpassFailed: true
        });
        const realN = cctvs.filter(c => c.realPublic).length;
        fleet.logGlobal(
          realN > 0
            ? `[CCTV] Overpass gagal — ${realN} kamera live tetap dimuat (${cctvs.length} total)`
            : `[CCTV] Fallback: spawn ${cctvs.length} synthetic`, "WARNING");
        if (!options.skipStream && !this._activeStreams.has("default")) this._prepareStream(nearest, fleet);
        return { cctvs, nearest, queryLat: lat, queryLng: lng, radius, fallback: true };
      }
      return null;
    } finally {
      if (!options.allowConcurrent) this._scanInProgress = false;
    }
  },

  async scanMultiRegion(baseLat, baseLng, regions = null) {
    const fleet = global.CGO_Fleet;
    if (!fleet) return null;
    const list = regions || this.REGIONS;
    if (!list.length) throw new Error("Tidak ada region dipilih");
    if (this._scanInProgress) {
      fleet.logGlobal("⚠️ [MULTI] Scan masih berjalan...", "WARNING");
      return null;
    }
    this._scanInProgress = true;
    try {
      await this.ensureCatalog();
      if (!this._activeStreams.has("default")) {
        const first = this._liveEntries(baseLat, baseLng, { realMax: Infinity, portalMax: 0 }).find(c => !c.isPortal);
        if (first) this._prepareStream(first, fleet);
      }
      const allCCTVs = [];
      let scanned = 0;
      fleet.logGlobal(`🌐 [MULTI] Memulai multi-scan ${list.length} region...`, "SUCCESS");

      for (const region of list) {
        scanned++;
        fleet.emit("MULTI_SCAN_PROGRESS", { current: scanned, total: list.length, region: region.name });
        fleet.logGlobal(`📡 [MULTI ${scanned}/${list.length}] Scan ${region.name}...`, "INFO");
        try {
          const result = await this.scanNearby(
            region.lat, region.lng, region.radius || 4000,
            { allowConcurrent: true, silent: true, skipStream: true }
          );
          if (result && result.cctvs) {
            for (const c of result.cctvs) c.region = region.name;
            allCCTVs.push(...result.cctvs);
          }
        } catch (e) {
          fleet.logGlobal(`⚠️ [MULTI] ${region.name} gagal: ${e.message}`, "WARNING");
        }
        const part = this._mergePartial(allCCTVs, baseLat, baseLng);
        fleet.emit("CCTV_SCAN_PROGRESSIVE", {
          cctvs: part, total: part.length,
          live: part.filter(c => c.realPublic && !c.isPortal).length,
          current: scanned, regions: list.length
        });
        if (scanned < list.length) await new Promise(r => setTimeout(r, 400));
      }

      const seen = new Set();
      let unique = [];
      for (const c of allCCTVs) {
        const key = String(c.id);
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(c);
      }

      if (unique.length === 0) {
        unique.push(...this._spawnSyntheticCCTV(baseLat, baseLng, 12, 3));
        fleet.logGlobal(`[MULTI] Tidak ada hasil, spawn ${unique.length} synthetic`, "WARNING");
      }

      /* Semua kamera live + portal (tanpa batas jarak), lalu dedupe ulang */
      for (const c of this._liveEntries(baseLat, baseLng, { realMax: Infinity, portalMax: Infinity })) {
        const key = String(c.id);
        if (seen.has(key)) {
          const prev = unique.find(u => String(u.id) === key);
          if (prev) prev.distance = c.distance;
          continue;
        }
        seen.add(key);
        unique.push(c);
      }

      unique.sort((a, b) => a.distance - b.distance);
      const nearestReal = unique.find(c => c.realPublic && (c.embed || c.hls) && !c.isPortal);
      const nearest = nearestReal || unique[0];

      this._lastScan = {
        queryLat: baseLat, queryLng: baseLng,
        cctvs: unique, nearest, multiRegion: true, timestamp: U.iso()
      };

      fleet.emit("CCTV_SCAN_SUCCESS", {
        cctvs: unique, nearest, total: unique.length,
        live: unique.filter(c => c.realPublic && !c.isPortal).length,
        queryLat: baseLat, queryLng: baseLng,
        radius: 5000, multiRegion: true
      });
      fleet.emit("MULTI_SCAN_COMPLETE", { total: unique.length, regions: list.length });
      fleet.logGlobal(`✅ [MULTI] Selesai: ${unique.length} CCTV dari ${list.length} region`, "SUCCESS");

      const hasActive = this._activeStreams.has("default");
      if (nearest && !hasActive) this._prepareStream(nearest, fleet);
      else if (hasActive) fleet.logGlobal(`🎥 [CCTV] Stream aktif dipertahankan`, "INFO");

      return unique;
    } finally {
      this._scanInProgress = false;
    }
  },

  _prepareStream(cctv, fleet, opts = {}) {
    if (!cctv) return;
    const force = !!opts.force;
    const proxy = this.getProxyUrl();

    /* 1) CCTV publik real (BaliTower) — hanya jika bukan portal */
    if (cctv.realPublic && cctv.embed && !cctv.isPortal) {
      const current = this._activeStreams.get("default");
      if (!force && current && current.embed === cctv.embed && !current.simulate) {
        fleet.logGlobal(`🎥 [CCTV] Embed real sudah aktif → ${cctv.name} (skip)`, "INFO");
        current.cctv = { ...cctv };
        fleet.emit("CCTV_STREAM_READY", {
          url: null, embed: cctv.embed, cctv: current.cctv, cctvId: cctv.id,
          distance: cctv.distance, simulate: false, realPublic: true, skipped: true
        });
        return;
      }
      this._activeStreams.set("default", {
        url: null, embed: cctv.embed, cctv, simulate: false, realPublic: true,
        substitute: !!opts.substitute
      });
      fleet.logGlobal(
        `🎥 [CCTV] REAL PUBLIC → ${cctv.name} (${cctv.distance}m)${opts.substitute ? " [pengganti pin]" : ""}`, "SUCCESS");
      fleet.emit("CCTV_STREAM_READY", {
        url: null, embed: cctv.embed, embedDirect: cctv.embed, noProxy: !!cctv.noProxy,
        hlsCandidate: cctv.hlsAuto || null,
        embedProxy: (proxy && !cctv.noProxy) ? this.proxify(cctv.embed) : null, proxyUrl: proxy,
        cctv, cctvId: cctv.id, distance: cctv.distance, simulate: false, realPublic: true,
        substitute: !!opts.substitute, requested: opts.requested || null
      });
      return;
    }

    /* 1b) Kamera dengan stream HLS sendiri (katalog / tag OSM) */
    if (cctv.realPublic && cctv.hls && !cctv.embed && !cctv.isPortal) {
      const streamUrl = cctv.hls;
      const current = this._activeStreams.get("default");
      if (!force && current && current.url === streamUrl && !current.simulate) {
        current.cctv = cctv;
        fleet.emit("CCTV_STREAM_READY", { url: streamUrl, cctv, cctvId: cctv.id, distance: cctv.distance, simulate: false, skipped: true });
        return;
      }
      this._activeStreams.set("default", { url: streamUrl, embed: null, cctv, simulate: false, substitute: !!opts.substitute });
      fleet.logGlobal(`🎥 [CCTV] HLS KAMERA → ${cctv.name} (${cctv.distance}m)${opts.substitute ? " [pengganti pin]" : ""}`, "SUCCESS");
      fleet.emit("CCTV_STREAM_READY", {
        url: streamUrl, hlsProxy: proxy ? this.proxify(streamUrl) : null, proxyUrl: proxy,
        embed: null, cctv, cctvId: cctv.id, distance: cctv.distance, simulate: false, hlsLive: true,
        substitute: !!opts.substitute, requested: opts.requested || null
      });
      return;
    }

    /* 2) Pin tanpa feed (OSM/synthetic): putar kamera live terdekat, ditandai "pengganti" */
    if (!cctv.isPortal && !cctv.embed && !cctv.hls && !opts.noSubstitute) {
      const near = this._nearestLive(cctv.lat, cctv.lng, 25);
      if (near) {
        fleet.logGlobal(
          `🎥 [CCTV] ${cctv.name} tidak punya feed publik → pengganti: ${near.name} (${near.distance}m)`, "INFO");
        this._prepareStream(near, fleet, { force, substitute: true, requested: cctv });
        return;
      }
    }

    /* 3) Portal — beri tahu UI untuk buka tab baru */
    if (cctv.isPortal && cctv.openInNewTab) {
      this._activeStreams.set("default", { url: null, embed: cctv.embed, cctv, simulate: false, openInNewTab: true });
      fleet.logGlobal(`🌐 [CCTV] Portal → ${cctv.name} (buka tab baru)`, "INFO");
      fleet.emit("CCTV_STREAM_READY", {
        url: null, embed: cctv.embed, cctv, cctvId: cctv.id,
        distance: cctv.distance, simulate: false, openInNewTab: true
      });
      return;
    }

    /* 4) HLS publik nyata — cadangan terakhir (BUKAN lokasi pin, ditandai substitute) */
    if (this.PUBLIC_STREAMS && this.PUBLIC_STREAMS.length > 0) {
      const idx = Math.abs(Number(cctv.id) || Date.now()) % this.PUBLIC_STREAMS.length;
      const streamUrl = this.PUBLIC_STREAMS[idx];
      const current = this._activeStreams.get("default");
      if (!force && current && current.url === streamUrl && !current.simulate) {
        fleet.logGlobal(`🎥 [CCTV] HLS sudah aktif → ${cctv.name} (skip)`, "INFO");
        current.cctv = cctv;
        fleet.emit("CCTV_STREAM_READY", {
          url: streamUrl, cctv, cctvId: cctv.id,
          distance: cctv.distance, simulate: false, skipped: true
        });
        return;
      }
      this._activeStreams.set("default", { url: streamUrl, embed: null, cctv, simulate: false, substitute: true });
      fleet.logGlobal(`🎥 [CCTV] HLS fallback → ${cctv.name} (feed publik umum, bukan lokasi pin)`, "SUCCESS");
      fleet.emit("CCTV_STREAM_READY", {
        url: streamUrl, hlsProxy: proxy ? this.proxify(streamUrl) : null, proxyUrl: proxy,
        embed: null, cctv, cctvId: cctv.id,
        distance: cctv.distance, simulate: false, substitute: true
      });
      return;
    }

    /* 5) Canvas fallback */
    this._activeStreams.set("default", { url: null, embed: null, cctv, simulate: true });
    fleet.logGlobal(`🎥 [CCTV] Canvas fallback → ${cctv.name}`, "WARNING");
    fleet.emit("CCTV_STREAM_READY", {
      url: null, embed: null, cctv, cctvId: cctv.id,
      distance: cctv.distance, simulate: true
    });
  },

  playCCTV(cctv) {
    const fleet = global.CGO_Fleet;
    if (!fleet || !cctv) return;
    fleet.logGlobal(`🎥 [CCTV] Beralih → ${cctv.name}`, "INFO");
    this._prepareStream(cctv, fleet, { force: true });
  },

  clearStream() { this._activeStreams.clear(); },
  getLastScan() { return this._lastScan; },
  getActiveStream() {
    const s = this._activeStreams.get("default");
    return s ? s.url : null;
  },

  /* Diagnostic — test semua URL dan laporkan (akurat via proxy /probe, paralel, ber-timeout) */
  async diagnoseCCTV() {
    const fleet = global.CGO_Fleet;
    const proxy = this.getProxyUrl();
    const proxyOk = proxy ? await this.checkProxy(true) : false;
    const testUrls = [
      ...this.REAL_PUBLIC_CAMS.map(c => ({ name: c.name, type: c.hls ? "HLS" : (c.noProxy ? "YouTube" : "BaliTower"), url: c.hls || this._hlsFromEmbed(c.embed) || c.embed, noProxy: !!c.noProxy })),
      ...this.PUBLIC_STREAMS.map((u, i) => ({ name: `HLS-${i + 1}`, type: "HLS", url: u })),
      ...this.REGION_PORTALS.map(p => ({ name: p.name, type: "Portal", url: p.url }))
    ];

    const head = proxy
      ? { name: "CGO Proxy", type: "Proxy", url: proxy + "/health",
          status: proxyOk ? "OK" : "FAIL: proxy tidak merespons", detail: proxy }
      : { name: "CGO Proxy", type: "Proxy", url: "-",
          status: "UNKNOWN: proxy belum diatur — embed BaliTower hampir pasti diblokir iframe",
          detail: "isi alamat proxy di panel CCTV" };

    const testOne = async (t) => {
      let status = "UNKNOWN", detail = "";
      if (t.noProxy) return { ...t, status: "UNKNOWN: embed resmi (tidak lewat proxy, tidak bisa diverifikasi dari sini)", detail };
      try {
        if (proxyOk) {
          const j = await this.probe(t.url);
          if (j && j.ok) {
            status = "OK";
            detail = `HTTP ${j.status} · ${j.ms}ms` + (j.frameBlockedUpstream ? " · frame-block dibuang proxy" : "");
          } else {
            status = "FAIL: " + (j && j.status ? `HTTP ${j.status}` : (j && j.error) || "tidak ada respons");
          }
        } else if (/\.m3u8(\?|$)/i.test(t.url)) {
          /* HLS: uji CORS sungguhan — jika lolos, kamera bisa diputar langsung tanpa proxy */
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 8000);
          try {
            const res = await fetch(t.url, { method: "GET", mode: "cors", signal: ctrl.signal });
            try { if (res.body && res.body.cancel) res.body.cancel(); } catch (_) {}
            if (res.ok) { status = "OK"; detail = "HLS langsung bisa (CORS diizinkan, tanpa proxy)"; }
            else status = "FAIL: HTTP " + res.status;
          } finally { clearTimeout(timer); }
        } else {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 8000);
          try {
            await fetch(t.url, { method: "GET", mode: "no-cors", signal: ctrl.signal });
          } finally { clearTimeout(timer); }
          status = "UNKNOWN: terjangkau (hasil opaque, butuh proxy untuk verifikasi)";
        }
      } catch (e) {
        status = "FAIL: " + (e && e.name === "AbortError" ? "timeout" : (e && e.message));
        if (/\.m3u8(\?|$)/i.test(t.url) && !proxyOk) detail = "diblokir CORS/jaringan — butuh proxy";
      }
      return { ...t, status, detail };
    };

    const results = new Array(testUrls.length);
    let next = 0;
    const worker = async () => {
      while (next < testUrls.length) {
        const i = next++;
        results[i] = await testOne(testUrls[i]);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    results.unshift(head);

    if (fleet) fleet.emit("CCTV_DIAGNOSTIC_RESULT", { results, timestamp: U.iso() });
    return results;
  }
};

// ==========================================================================
// 7. FLEET MANAGER
// ==========================================================================
const FleetManager = {
  version: VERSION,
  drones: new Map(),
  selectedDroneId: null,
  listeners: [],
  _onceListeners: [],
  fleetInterval: null,
  isTsunamiActive: false,
  isDaylight: true,
  _sunAngle: 90,
  _speedMultiplier: 1,
  _globalLog: [],
  _fleetStats: { active: 0, emergency: 0, offline: 0, jammed: 0, idle: 0 },
  _missionStartTime: null,
  _tickCount: 0,

  init(options = {}) {
    AudioEngine.init();
    if (options.autoStart !== false) this.startSimulation();
    return this;
  },

  generateFleet(count = 1000) {
    this.drones.clear();
    for (let i = 1; i <= count; i++) {
      const id = `CGO-${i.toString().padStart(4, "0")}`;
      const d = new DroneEntity(id);
      SwarmCoordinator.assignSector(d);
      this.drones.set(id, d);
    }
    SwarmCoordinator.rebuildSectorMap(this.drones);
    if (count > 0) this.selectDrone("CGO-0001");
    this.logGlobal(`Armada CIKUR GO: ${count} unit siap.`, "SUCCESS");
    this.emit("FLEET_GENERATED", { count });
    return this.drones.size;
  },

  selectDrone(id) {
    if (this.drones.has(id)) {
      this.selectedDroneId = id;
      this.emit("DRONE_SELECTED", this.drones.get(id));
      return true;
    }
    return false;
  },
  getSelectedDrone() { return this.drones.get(this.selectedDroneId) || null; },
  getDrone(id) { return this.drones.get(id) || null; },

  onEvent(cb) { if (typeof cb === "function") this.listeners.push({ event: "*", cb }); },
  on(eventName, cb) { if (typeof cb === "function") this.listeners.push({ event: eventName, cb }); },
  once(eventName, cb) { if (typeof cb === "function") this._onceListeners.push({ event: eventName, cb }); },
  off(eventName, cb) {
    this.listeners = this.listeners.filter(l => !(l.event === eventName && l.cb === cb));
  },
  emit(eventName, data) {
    const payload = { event: eventName, data, timestamp: U.iso() };
    for (const l of this.listeners) {
      if (l.event === "*" || l.event === eventName) {
        try { l.cb(payload); } catch (e) { console.error("[CGO] listener error:", e); }
      }
    }
    const keep = [];
    for (const l of this._onceListeners) {
      if (l.event === eventName || l.event === "*") {
        try { l.cb(payload); } catch (e) { console.error("[CGO] once error:", e); }
      } else keep.push(l);
    }
    this._onceListeners = keep;
  },

  logGlobal(message, type = "INFO") {
    const entry = { time: U.now(), message, type, droneId: "SYSTEM" };
    this._globalLog.push(entry);
    if (this._globalLog.length > FLEET_MAX_LOG) this._globalLog.shift();
    this.emit("NEW_LOG", entry);
  },
  getGlobalLog() { return this._globalLog.slice(); },

  deployAll() {
    let n = 0;
    for (const d of this.drones.values()) if (d.deploy()) n++;
    if (n > 0) this._missionStartTime = Date.now();
    this.logGlobal(`GLOBAL: ${n} drone takeoff.`, "SUCCESS");
    this.emit("FLEET_DEPLOYED", { count: n });
    AudioEngine.speak("Seluruh armada drone dilepas.");
    return n;
  },
  returnAll() {
    let n = 0;
    for (const d of this.drones.values()) if (d.returnToBase()) n++;
    this.logGlobal(`GLOBAL: ${n} drone RTB.`, "WARNING");
    this.emit("FLEET_RETURNING", { count: n });
    AudioEngine.speak("Seluruh armada kembali ke markas.");
    return n;
  },

  triggerGlobalTsunami() {
    this.isTsunamiActive = true;
    let n = 0;
    for (const d of this.drones.values()) {
      if (d.isDeployed) { d.triggerTsunamiAlert(); n++; }
    }
    this.logGlobal(`🚨 TSUNAMI ALERT GLOBAL. ${n} drone evakuasi!`, "DANGER");
    this.emit("DISASTER_ALERT_ACTIVE", { dronesAffected: n });
    AudioEngine.playSiren(3.0);
    AudioEngine.speak("Perhatian. Potensi tsunami terdeteksi. Segera tinggalkan area pantai...", { emergency: true });
    const sel = this.getSelectedDrone();
    const lat = sel ? (-6.2088 + sel.telemetry.position.x * 0.0001) : -6.2088;
    const lng = sel ? (106.8456 + sel.telemetry.position.y * 0.0001) : 106.8456;
    CCTVEngine.scanNearby(lat, lng, 5000).catch(err => {
      this.logGlobal(`[CCTV] Auto-scan gagal: ${err.message}`, "WARNING");
    });
  },

  activateVoidPulseAll() {
    this.isTsunamiActive = false;
    let n = 0;
    for (const d of this.drones.values()) if (d.activateVoidPulse()) n++;
    this.logGlobal("⚡ VOID PULSE GLOBAL aktif.", "DANGER");
    this.emit("VOID_PULSE_ACTIVE", { dronesAffected: n });
    AudioEngine.speak("Void pulse diaktifkan. Zona aman tercipta.");
  },

  interactSelected(targetName) {
    const d = this.getSelectedDrone();
    if (!d) return null;
    const log = d.interactWithTarget(targetName);
    if (log) this.emit("NEW_LOG", log);
    AudioEngine.speak(`Halo ${targetName}. Aku melihat trafik sangat macet di sekitarmu.`);
    return log;
  },

  setFormation(name) {
    const ok = SwarmCoordinator.setFormation(name);
    if (ok) {
      this.emit("FORMATION_CHANGED", { formation: name });
      this.logGlobal(`Formasi swarm → ${name.toUpperCase()}`, "INFO");
    }
    return ok;
  },

  scanCCTV(lat, lng, radius = 5000) {
    return CCTVEngine.scanNearby(lat, lng, radius);
  },
  scanMultiCCTV(lat, lng, regions) {
    return CCTVEngine.scanMultiRegion(lat, lng, regions);
  },
  diagnoseCCTV() {
    return CCTVEngine.diagnoseCCTV();
  },
  setProxyUrl(url) { return CCTVEngine.setProxyUrl(url); },
  getProxyUrl() { return CCTVEngine.getProxyUrl(); },
  checkProxy(force) { return CCTVEngine.checkProxy(force); },

  startSimulation() {
    this.stopSimulation();
    let lastTs = performance.now();
    this.fleetInterval = setInterval(() => {
      const now = performance.now();
      const dt = now - lastTs;
      lastTs = now;
      const ticks = Math.max(1, Math.round((dt / TICK_MS) * this._speedMultiplier));
      for (let i = 0; i < ticks && i < 3; i++) this._runTick();
    }, Math.floor(TICK_MS / this._speedMultiplier));
  },
  stopSimulation() {
    if (this.fleetInterval) { clearInterval(this.fleetInterval); this.fleetInterval = null; }
  },
  setSimulationSpeed(multiplier) {
    this._speedMultiplier = U.clamp(multiplier, 0.5, 5);
    if (this.fleetInterval) this.startSimulation();
    this.logGlobal(`Kecepatan simulasi → ${this._speedMultiplier}x`, "INFO");
  },
  getSimulationSpeed() { return this._speedMultiplier; },

  _runTick() {
    this._tickCount++;
    const cycle = (Date.now() / 1000) % 60;
    const dayFraction = cycle / 60;
    this.isDaylight = dayFraction < 0.5;
    this._sunAngle = this.isDaylight ? 180 * (dayFraction * 2) : 0;
    const meshCache = new Map();
    const droneArr = Array.from(this.drones.values());
    const stats = { active: 0, emergency: 0, offline: 0, jammed: 0, idle: 0 };
    for (const d of droneArr) {
      if (!d.isDeployed) {
        if (d.state === STATE.OFFLINE) stats.offline++;
        else stats.idle++;
        continue;
      }
      let meshStat;
      if (d.state === STATE.MONITORING && !meshCache.has(d.id)) {
        meshStat = SwarmCoordinator.getMeshAvailability(d, this.drones);
        meshCache.set(d.id, meshStat);
      } else meshStat = meshCache.get(d.id) || { meshAvailable: false };
      d.tick(this.isDaylight, this._sunAngle, meshStat);
      if (d.state === STATE.EMERGENCY) stats.emergency++;
      else if (d.state === STATE.OFFLINE) stats.offline++;
      else if (d.isDeployed) stats.active++;
      if (d.telemetry.isJammed) stats.jammed++;
    }
    this._fleetStats = stats;
    this.emit("FLEET_STATS_UPDATE", stats);
    const sel = this.getSelectedDrone();
    if (sel) this.emit("TELEMETRY_UPDATE", sel.telemetry);
    if (stats.offline > 0 && this._tickCount % 10 === 0) {
      this.logGlobal(`⚠️ ${stats.offline} drone OFFLINE.`, "WARNING");
    }
    if (stats.jammed > 0 && this._tickCount % 10 === 0) {
      this.logGlobal(`📡 ${stats.jammed} drone jammed.`, "WARNING");
    }
  },

  getFleetStats() { return Object.assign({}, this._fleetStats); },
  getMissionElapsed() {
    if (!this._missionStartTime) return 0;
    return Math.floor((Date.now() - this._missionStartTime) / 1000);
  },
  getNearbyDrones(id, radius = MESH_RADIUS) {
    const d = this.drones.get(id);
    if (!d) return [];
    const out = [];
    for (const other of this.drones.values()) {
      if (other.id === id) continue;
      const dx = Math.abs(other.sector.x - d.sector.x);
      const dy = Math.abs(other.sector.y - d.sector.y);
      if (dx <= radius && dy <= radius) out.push(other);
    }
    return out;
  },
  speak(text, isEmergency = false) { AudioEngine.speak(text, { emergency: isEmergency }); },
  playSiren() { AudioEngine.playSiren(); },
  mute(m = true) { AudioEngine.mute(m); this.emit("MUTE_STATE_CHANGED", m); },
  setVolume(v) { AudioEngine.setVolume(v); },

  exportState() {
    const drones = [];
    for (const d of this.drones.values()) drones.push(d.toJSON());
    return JSON.stringify({
      version: VERSION, exportedAt: U.iso(),
      selectedDroneId: this.selectedDroneId,
      isTsunamiActive: this.isTsunamiActive, drones
    });
  },
  importState(json) {
    try {
      const data = JSON.parse(json);
      if (!data.drones) throw new Error("Invalid state");
      this.drones.clear();
      for (const raw of data.drones) {
        const d = new DroneEntity(raw.id);
        d.state = raw.state || STATE.IDLE;
        d.isDeployed = !!raw.isDeployed;
        d.sector = raw.sector || { x: 0, y: 0 };
        Object.assign(d.telemetry, raw.telemetry || {});
        this.drones.set(d.id, d);
      }
      SwarmCoordinator.rebuildSectorMap(this.drones);
      if (data.selectedDroneId && this.drones.has(data.selectedDroneId)) {
        this.selectDrone(data.selectedDroneId);
      }
      this.logGlobal(`State loaded: ${this.drones.size} drone.`, "SUCCESS");
      return true;
    } catch (e) {
      this.logGlobal(`Import gagal: ${e.message}`, "DANGER");
      return false;
    }
  },
  reset() {
    this.stopSimulation();
    this.drones.clear();
    this.selectedDroneId = null;
    this.isTsunamiActive = false;
    this._fleetStats = { active: 0, emergency: 0, offline: 0, jammed: 0, idle: 0 };
    this._missionStartTime = null;
    this._tickCount = 0;
    this.logGlobal("Sistem di-reset.", "WARNING");
  },

  CCTV: CCTVEngine,
  IP: IPScanner
};

// ==========================================================================
// 8. BOOTSTRAP
// ==========================================================================
FleetManager.init({ autoStart: false });
global.CGO_Fleet = FleetManager;

global.CGO_Debug = {
  version: VERSION,
  getState: () => ({ ...FleetManager.getFleetStats() }),
  getDrone: id => FleetManager.getDrone(id),
  dumpLogs: () => FleetManager.getGlobalLog(),
  simulateDay: () => { FleetManager.isDaylight = true; },
  simulateNight: () => { FleetManager.isDaylight = false; },
  scanCCTV: (lat, lng, radius) => CCTVEngine.scanNearby(lat, lng, radius),
  scanMulti: (lat, lng, regions) => CCTVEngine.scanMultiRegion(lat, lng, regions),
  getLastScan: () => CCTVEngine.getLastScan(),
  setStreamUrls: (urls) => CCTVEngine.setStreamUrls(urls),
  detectIP: () => IPScanner.detectIP(),
  rotateMirror: () => IPScanner.nextMirror(),
  getIPStatus: () => IPScanner.getStatus(),
  setCORSProxies: (list) => { IPScanner.CORS_PROXIES = Array.isArray(list) ? list.slice() : []; },
  spawnSynthetic: (lat, lng, n) => CCTVEngine._spawnSyntheticCCTV(lat, lng, n || 10),
  diagnoseCCTV: () => CCTVEngine.diagnoseCCTV(),
  setProxyUrl: (url) => CCTVEngine.setProxyUrl(url),
  getProxyUrl: () => CCTVEngine.getProxyUrl(),
  checkProxy: (force) => CCTVEngine.checkProxy(force)
};

console.info(`[CGO Fleet] v${VERSION} — Real CCTV + Proxy + Diagnostic + Honest UI (Live-First + Katalog + Progresif + HLS-Langsung)`);

})(typeof window !== "undefined" ? window : globalThis);
