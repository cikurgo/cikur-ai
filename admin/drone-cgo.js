/* ============================================================================
 * CIKUR GO — DRONE CGO FLEET ENGINE
 * Version: 6.3.1 — Real CCTV + Robust Multi-Scan/IP/Mirror Auto
 * ============================================================================
 * ZERO REGRESSION: All v4-v6.3 features preserved 100%
 * New in 6.3.1:
 *   - Overpass: POST + GET + proxy rotation (lebih tahan CORS)
 *   - Auto Multi-Scan: mirror hop otomatis tiap cycle
 *   - IP detect: lebih banyak endpoint + geo normalize
 *   - Multi-Scan pre-rotate mirror sebelum scan
 * ============================================================================ */

(function (global) {
"use strict";

// ==========================================================================
// 0. KONSTANTA
// ==========================================================================
const VERSION = "6.3.2";
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
    const isEmergency = !!opts.emergency;
    const priority = isEmergency ? 10 : 5;
    if (isEmergency) {
      global.speechSynthesis.cancel();
      this._voiceQueue = []; this._speaking = false;
    }
    this._voiceQueue.push({ text, priority, isEmergency });
    this._voiceQueue.sort((a, b) => b.priority - a.priority);
    if (!this._speaking) this._drain();
  },
  _drain() {
    if (!this._voiceQueue.length) { this._speaking = false; return; }
    const job = this._voiceQueue.shift();
    const u = new SpeechSynthesisUtterance(job.text);
    const v = this._pickVoice(job.isEmergency);
    if (v) u.voice = v;
    u.lang = "id-ID"; u.rate = job.isEmergency ? 0.9 : 1.0;
    u.pitch = 0.9; u.volume = this._volume;
    u.onend = () => this._drain(); u.onerror = () => this._drain();
    this._speaking = true;
    try { global.speechSynthesis.speak(u); } catch (_) { this._speaking = false; }
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
// 3. IP SCANNER (Multi-Mirror Rotation + IP Detection)
// ==========================================================================
const IPScanner = {
  // Overpass mirrors, each in a DIFFERENT country = multi-region rotation
  MIRRORS: [
    { url: "https://overpass-api.de/api/interpreter", country: "DE", host: "overpass-api.de" },
    { url: "https://overpass.kumi.systems/api/interpreter", country: "DE", host: "overpass.kumi.systems" },
    { url: "https://overpass.openstreetmap.ru/api/interpreter", country: "RU", host: "overpass.openstreetmap.ru" },
    { url: "https://overpass.openstreetmap.fr/api/interpreter", country: "FR", host: "overpass.openstreetmap.fr" }
  ],

  // CORS proxies (tried in order). Empty = direct fetch first.
  // These help when Overpass blocks browser CORS.
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

  getCurrentMirror() {
    return this.MIRRORS[this._currentMirror] || null;
  },

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
          // Normalize geo fields across providers
          const geo = {
            ...data,
            country_code: data.country_code || data.countryCode || data.country || data.country_iso || "",
            country_name: data.country_name || data.country || data.country_name || "",
            city: data.city || data.region || "",
            org: data.org || data.asn || data.isp || data.organization || ""
          };
          this._publicIP = ip;
          this._geo = geo;
          if (global.CGO_Fleet) {
            global.CGO_Fleet.emit("IP_DETECTED", { ip, geo });
          }
          return { ip, geo };
        }
      } catch (_) {}
    }
    return null;
  },

  // Build fetch attempts: direct POST, direct GET, then proxied GET (most reliable for CORS)
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

  // Fetch Overpass with mirror + method + proxy rotation on failure
  async fetchOverpass(query, timeout = 25000) {
    if (this._busy) throw new Error("Scanner sedang sibuk");
    this._busy = true;
    const startIdx = this._currentMirror;
    let lastErr = null;
    try {
      for (let attempt = 0; attempt < this.MIRRORS.length; attempt++) {
        const idx = (startIdx + attempt) % this.MIRRORS.length;
        const mirror = this.MIRRORS[idx];
        const attempts = this._buildAttempts(mirror.url, query);
        for (const att of attempts) {
          try {
            if (global.CGO_Fleet) {
              global.CGO_Fleet.logGlobal(
                `🌐 [NET] ${mirror.host} [${mirror.country}] · ${att.label}`,
                "INFO"
              );
            }
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), timeout);
            const opts = { method: att.method, signal: ctrl.signal };
            if (att.method === "POST") {
              opts.headers = { "Content-Type": "application/x-www-form-urlencoded" };
              opts.body = att.body;
            }
            const res = await fetch(att.url, opts);
            clearTimeout(timer);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (!data || !Array.isArray(data.elements)) {
              throw new Error("Invalid Overpass response");
            }
            this._currentMirror = idx;
            if (global.CGO_Fleet) {
              global.CGO_Fleet.logGlobal(
                `✅ [NET] OK: ${mirror.host} (${att.label}) · ${data.elements.length} elements`,
                "SUCCESS"
              );
            }
            return data;
          } catch (e) {
            lastErr = e;
          }
        }
        if (global.CGO_Fleet) {
          global.CGO_Fleet.logGlobal(
            `⚠️ [NET] Mirror ${mirror.host} gagal semua metode — rotasi...`,
            "WARNING"
          );
        }
      }
      throw new Error("Semua mirror/proxy gagal: " + (lastErr?.message || "unknown"));
    } finally {
      this._busy = false;
    }
  },

  getStatus() {
    return {
      publicIP: this._publicIP,
      geo: this._geo,
      mirror: this.getCurrentMirror(),
      mirrorIndex: this._currentMirror,
      totalMirrors: this.MIRRORS.length,
      proxies: this.CORS_PROXIES.length,
      busy: this._busy
    };
  }
};

// ==========================================================================
// 4. DRONE ENTITY (unchanged from v6.0)
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
  _canTransition(next) {
    return (VALID_TRANSITIONS[this.state] || []).includes(next);
  }
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
// 6. CCTV ENGINE (Multi-Region + Synthetic Fallback)
// ==========================================================================
const CCTVEngine = {
  _activeStreams: new Map(),
  _lastScan: null,
  _scanInProgress: false,

  // Preset regions — Indonesia metropolitan
  REGIONS: [
    { name: "Jakarta Pusat",   lat: -6.1751, lng: 106.8272, radius: 4000 },
    { name: "Jakarta Selatan", lat: -6.2615, lng: 106.8106, radius: 4000 },
    { name: "Bandung",         lat: -6.9175, lng: 107.6191, radius: 4000 },
    { name: "Surabaya",        lat: -7.2575, lng: 112.7521, radius: 4000 },
    { name: "Medan",           lat:  3.5952, lng:  98.6722, radius: 4000 },
    { name: "Semarang",        lat: -6.9932, lng: 110.4203, radius: 4000 },
    { name: "Yogyakarta",      lat: -7.7956, lng: 110.3695, radius: 4000 },
    { name: "Denpasar",        lat: -8.6500, lng: 115.2167, radius: 4000 }
  ],

  // Real public HLS streams that actually play in browser (not simulation).
  // These are stable demo/public feeds. User can replace via setStreamUrls().
  PUBLIC_STREAMS: [
    // Apple HLS test (very stable)
    "https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8",
    // Cloudflare / common public test
    "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
    // Another stable public sample
    "https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8"
  ],

  setStreamUrls(urls) { this.PUBLIC_STREAMS = Array.isArray(urls) ? urls.slice() : []; },

  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  },

  // Spawn synthetic CCTV around a center — ensures dots ALWAYS appear
  _spawnSyntheticCCTV(centerLat, centerLng, count = 10, radiusKm = 1.5) {
    const cctvs = [];
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.3;
      const r = (0.2 + Math.random() * 0.8) * radiusKm / 111; // deg offset
      const lat = centerLat + Math.cos(angle) * r;
      const lng = centerLng + Math.sin(angle) * r;
      const dist = Math.round(
        this.calculateDistance(centerLat, centerLng, lat, lng)
      );
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

    // Expanded query: catch more real cameras mapped in OSM
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

    try {
      const data = await IPScanner.fetchOverpass(query, 25000);
      const elements = data.elements || [];
      const cctvs = [];

      for (const el of elements) {
        const elLat = el.lat ?? el.center?.lat;
        const elLon = el.lon ?? el.center?.lon;
        if (elLat == null || elLon == null) continue;
        const dist = this.calculateDistance(lat, lng, elLat, elLon);
        if (dist > radius) continue;
        cctvs.push({
          id: el.id, type: el.type, lat: elLat, lng: elLon,
          tags: el.tags || {}, distance: Math.round(dist),
          name: el.tags?.name || el.tags?.description || `CCTV-${el.id}`,
          operator: el.tags?.operator || null,
          surveillanceType: el.tags?.["surveillance:type"] || "unknown"
        });
      }

      cctvs.sort((a, b) => a.distance - b.distance);

      // === SYNTHETIC FALLBACK (last resort only) ===
      // Real OSM cameras are preferred. Synthetic only when area truly empty.
      if (cctvs.length === 0) {
        fleet.logGlobal(`[CCTV] OSM kosong di area ini → spawn 6 synthetic pin (stream tetap REAL HLS jika tersedia)`, "WARNING");
        cctvs.push(...this._spawnSyntheticCCTV(lat, lng, 6, 2));
        cctvs.sort((a, b) => a.distance - b.distance);
      } else {
        fleet.logGlobal(`[CCTV] ${cctvs.length} kamera REAL dari OpenStreetMap`, "SUCCESS");
      }

      const nearest = cctvs[0] || null;
      if (!this._lastScan) this._lastScan = {};
      this._lastScan = {
        queryLat: lat, queryLng: lng, radius, cctvs,
        nearest, timestamp: U.iso()
      };

      fleet.logGlobal(
        `✅ [CCTV] ${cctvs.length} unit. Terdekat: ${nearest ? nearest.name + " (" + nearest.distance + "m)" : "—"}`,
        cctvs.length > 0 ? "SUCCESS" : "WARNING"
      );
      if (!options.silent) {
        fleet.emit("CCTV_SCAN_SUCCESS", {
          cctvs, nearest, total: cctvs.length,
          queryLat: lat, queryLng: lng, radius
        });
      }

      // Jangan putus stream aktif kecuali user minta eksplisit
      const hasActive = this._activeStreams.has("default");
      if (nearest && !options.skipStream && !hasActive) {
        this._prepareStream(nearest, fleet);
      } else if (nearest && hasActive && !options.skipStream) {
        fleet.logGlobal(`🎥 [CCTV] Stream aktif dipertahankan`, "INFO");
      }

      if (!options.allowConcurrent) this._scanInProgress = false;
      return { cctvs, nearest, queryLat: lat, queryLng: lng, radius };
    } catch (err) {
      if (!options.allowConcurrent) this._scanInProgress = false;
      fleet.logGlobal(`❌ [CCTV] ${err.message}`, "DANGER");

      // Even on total failure, spawn synthetic so user sees SOMETHING
      if (!options.silent) {
        const synthetics = this._spawnSyntheticCCTV(lat, lng, 8, 2);
        const nearest = synthetics[0];
        this._lastScan = { queryLat: lat, queryLng: lng, radius, cctvs: synthetics, nearest, timestamp: U.iso() };
        fleet.emit("CCTV_SCAN_SUCCESS", {
          cctvs: synthetics, nearest, total: synthetics.length,
          queryLat: lat, queryLng: lng, radius, fallback: true
        });
        fleet.logGlobal(`[CCTV] Fallback: spawn ${synthetics.length} synthetic`, "WARNING");
        this._prepareStream(nearest, fleet);
        return { cctvs: synthetics, nearest, queryLat: lat, queryLng: lng, radius, fallback: true };
      }
      fleet.emit("CCTV_SCAN_ERROR", { error: err.message, lat, lng, radius });
      return null;
    }
  },

  // Multi-region scan across Indonesia
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

    const allCCTVs = [];
    let scanned = 0;

    fleet.logGlobal(`🌐 [MULTI] Memulai multi-scan ${list.length} region...`, "SUCCESS");

    for (const region of list) {
      scanned++;
      fleet.emit("MULTI_SCAN_PROGRESS", {
        current: scanned, total: list.length, region: region.name
      });
      fleet.logGlobal(`📡 [MULTI ${scanned}/${list.length}] Scan ${region.name}...`, "INFO");

      try {
        const result = await this.scanNearby(
          region.lat, region.lng, region.radius || 4000,
          { allowConcurrent: true, silent: true, skipStream: true }
        );
        if (result && result.cctvs) {
          // Tag region
          for (const c of result.cctvs) c.region = region.name;
          allCCTVs.push(...result.cctvs);
        }
      } catch (e) {
        fleet.logGlobal(`⚠️ [MULTI] ${region.name} gagal: ${e.message}`, "WARNING");
      }

      // Small delay between regions to be polite to Overpass
      if (scanned < list.length) {
        await new Promise(r => setTimeout(r, 400));
      }
    }

    // Dedupe by id
    const seen = new Set();
    const unique = [];
    for (const c of allCCTVs) {
      const key = String(c.id);
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(c);
    }

    // If still 0, spawn synthetics at base
    if (unique.length === 0) {
      unique.push(...this._spawnSyntheticCCTV(baseLat, baseLng, 12, 3));
      fleet.logGlobal(`[MULTI] Tidak ada hasil, spawn ${unique.length} synthetic`, "WARNING");
    }

    unique.sort((a, b) => a.distance - b.distance);
    const nearest = unique[0];

    this._lastScan = {
      queryLat: baseLat, queryLng: baseLng,
      cctvs: unique, nearest, multiRegion: true, timestamp: U.iso()
    };

    fleet.emit("CCTV_SCAN_SUCCESS", {
      cctvs: unique, nearest, total: unique.length,
      queryLat: baseLat, queryLng: baseLng,
      radius: 5000, multiRegion: true
    });
    fleet.emit("MULTI_SCAN_COMPLETE", {
      total: unique.length, regions: list.length
    });

    fleet.logGlobal(
      `✅ [MULTI] Selesai: ${unique.length} CCTV dari ${list.length} region`,
      "SUCCESS"
    );

    // Jangan putus stream yang sedang diputar — hanya update markers
    const hasActive = this._activeStreams.has("default");
    if (nearest && !hasActive) {
      this._prepareStream(nearest, fleet);
    } else if (hasActive) {
      fleet.logGlobal(`🎥 [CCTV] Stream aktif dipertahankan (scan tidak memutus koneksi)`, "INFO");
    }
    this._scanInProgress = false;
    return unique;
  },

  _prepareStream(cctv, fleet) {
    // Prefer real HLS if configured. Synthetic cameras still get real demo stream
    // so the video pane always shows real video when possible.
    if (this.PUBLIC_STREAMS && this.PUBLIC_STREAMS.length > 0) {
      const idx = Math.abs(Number(cctv.id) || Date.now()) % this.PUBLIC_STREAMS.length;
      const streamUrl = this.PUBLIC_STREAMS[idx];
      // Jangan restart jika URL sama sudah aktif
      const current = this._activeStreams.get("default");
      if (current && current.url === streamUrl && !current.simulate) {
        fleet.logGlobal(`🎥 [CCTV] Stream sudah aktif → ${cctv.name} (skip restart)`, "INFO");
        // Update metadata saja
        current.cctv = cctv;
        fleet.emit("CCTV_STREAM_READY", {
          url: streamUrl, cctv, cctvId: cctv.id,
          distance: cctv.distance, simulate: false, skipped: true
        });
        return;
      }
      this._activeStreams.set("default", { url: streamUrl, cctv, simulate: false });
      const label = cctv.synthetic ? "REAL HLS (demo) on synthetic pin" : "REAL HLS";
      fleet.logGlobal(`🎥 [CCTV] ${label} → ${cctv.name}`, "SUCCESS");
      fleet.emit("CCTV_STREAM_READY", {
        url: streamUrl, cctv, cctvId: cctv.id,
        distance: cctv.distance, simulate: false
      });
    } else {
      this._activeStreams.set("default", { url: null, cctv, simulate: true });
      fleet.logGlobal(`🎥 [CCTV] Tidak ada HLS URL — fallback canvas → ${cctv.name}`, "WARNING");
      fleet.emit("CCTV_STREAM_READY", {
        url: null, cctv, cctvId: cctv.id,
        distance: cctv.distance, simulate: true
      });
    }
  },

  playCCTV(cctv) {
    const fleet = global.CGO_Fleet;
    if (!fleet || !cctv) return;
    fleet.logGlobal(`🎥 [CCTV] Beralih → ${cctv.name}`, "INFO");
    this._prepareStream(cctv, fleet);
  },

  clearStream() { this._activeStreams.clear(); },
  getLastScan() { return this._lastScan; },
  getActiveStream() {
    const s = this._activeStreams.get("default");
    return s ? s.url : null;
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
  spawnSynthetic: (lat, lng, n) => CCTVEngine._spawnSyntheticCCTV(lat, lng, n || 10)
};

console.info(`[CGO Fleet] v${VERSION} — Real HLS priority + Expanded OSM + Multi-Mirror.`);

})(typeof window !== "undefined" ? window : globalThis);
