/* ============================================================================
 * CIKUR GO - DRONE CGO FLEET ENGINE
 * Version: 6.21.0
 * ============================================================================
 * Perubahan v6.21.0 — KALIBRASI TITIK TEMU NYATA (probe + host-block + stream OK):
 *   [CAL1] Probe cepat sebelum putar (proxy /probe atau fetch) → skip host mati.
 *   [CAL2] _hostFail: setelah timeout balitower, skip host sama 10 menit (antrean tidak macet).
 *   [CAL3] PUBLIC_STREAMS: hanya stream yang terbukti OK via proxy (Batam + sekupang).
 *   [CAL4] Default proxy cikurgo.workers.dev bila host GitHub Pages cikurgo.
 *   [CAL5] Timeout HLS manifest dipersingkat; advanceAccess lebih cepat ke kandidat hidup.
 *   [CAL6] REAL_PUBLIC baliTower ditandai preferHls + softFail (jangan blok antrean).
 *
 * Perubahan v6.20.0 — GPS GENERIK SEBAGAI ACUAN UTAMA (bukan mode Batam/Bali):
 *
 *   [GEN1] accessAround: OSM pin di radius GPS = lapisan utama; katalog hardcode
 *         HANYA masuk bila jarak ≤ localKm (default 40 km). Tidak memaksakan
 *         Batam/Bali saat GPS di kota lain.
 *   [GEN2] autoStream: progressive lokal dulu; Batam HANYA jika GPS ≤80 km dari Batam.
 *   [GEN3] _linkNearbyLiveFeeds: pin OSM ≤450 m dari feed katalog → status LIVE.
 *   [GEN4] Overpass: CGO-proxy dulu, query surveillance diperluas, id OSM stabil.
 *   [GEN5] Substitute pin tanpa feed: maks 12 km (bukan ∞).
 *   [GEN6] HLS-EXTRACT BaliTower (index.m3u8) + cascade proxy bila GPS dekat Jakarta.
 *   [GEN7] ACCESS_DEFAULTS: radius pin 10 km, localKm 40, maxTries 8.
 *   Hardcode PUBLIC_STREAMS / REAL_PUBLIC_CAMS = sumber opsional berjarak, BUKAN produk.
 *
 * Perubahan v6.18.0 (dari v6.17.0) — MULTI AUTO ACCESS (klik GPS / titik peta):
 *
 *   [A1] accessAround(lat,lng): satu perintah untuk seluruh alur titik GPS/peta:
 *        kamera berfeed di sekitar titik dimuat LOKAL seketika (tanpa menunggu
 *        Overpass), kamera terdekat langsung diputar, lalu pin OSM digabung.
 *   [A2] Antrean akses (_accessQueue): bila satu kamera gagal tayang, UI memanggil
 *        advanceAccess() → otomatis pindah ke kamera terdekat berikutnya
 *        (maks. maxTries). Tanpa proxy, host yang terbukti diblokir CORS dilewati.
 *   [A3] Hanya kamera <= localKm (default 50 km) yang masuk antrean — tidak pernah
 *        melompat ke kota lain. Bila kosong, jalur lama autoStream (berlabel
 *        remote) tetap dipakai seperti sebelumnya.
 *   [A4] IPScanner.cancel(): scan Overpass lama yang basi bisa dibatalkan agar klik
 *        terbaru tidak tertahan; hasil klik lama dibuang (anti balapan).
 *   [A5] Event baru: CCTV_ACCESS_START / _DONE / _ADVANCE / _EXHAUSTED / _NOLOCAL.
 *   [A6] Sadar-Streetside: kamera Streetside (HLS di-resolve saat diputar) ikut masuk
 *        antrean akses, dihitung LIVE, dan kegagalan resolve memicu kaskade.
 *   [A7] Sinkron dengan proxy yang berjalan: fetchSmart memakai proxy CGO milik
 *        sendiri (worker/server) SEBELUM relay publik pihak ketiga; checkProxy membaca
 *        versi/fitur proxy (worker v1.x = tanpa render HTML) -> getProxyInfo().
 *   [A8] Perbaikan: ensureCatalog tidak lagi menunggu Streetside > 2,5 dtk (dulu bisa
 *        menahan SEMUA scan hingga ~1 menit bila API Streetside lambat/mati); percobaan
 *        ulang Streetside dibatasi 60 dtk; resolve Streetside yang basi tidak lagi
 *        menimpa kamera yang dipilih belakangan.
 *   [A9] normalizeCoord: koordinat tanpa titik desimal kini dipulihkan ke kotak Indonesia
 *        (aturan lama memilih pembagi terbesar -> koordinat meleset ke dekat 0,0).
 *   Semua API v6.17.0 TIDAK diubah (scanNearby, scanMultiRegion, autoStream, dst).
 *
 * Perubahan v6.17.0 (dari v6.16.0) — MULTI-SOURCE RADAR (Streetside + normalize):
 *
 *   [S1] Streetside API (streetside.mugnimaestra.dev) diintegrasikan ke katalog
 *        realtime; HLS di-resolve on-demand saat play (sama pola playHls).
 *   [S2] normalizeCoord: perbaiki koordinat integer / titik desimal hilang.
 *   [S3] fetchSmart: direct → cascade proxy (corsproxy / allorigins / codetabs).
 *   [S4] BaliTower list diperluas (GBK 4, Asia Afrika 2, dsb.) tanpa duplikasi.
 *   [S5] Zero regresi: alur scanNearby / multi / progressive / proxy / UI cascade
 *        tetap identik; Streetside hanya menambah sumber realPublic.
 *
 * Perubahan v6.16.0 (dari v6.15.3) — MAX REAL ACCESS + GPS/MAP AUTO:
 *
 *   [M1] _pickProgressive(): hierarki radius 5→25→50→500→∞ km agar SELALU
 *        ada kandidat real (HLS/embed) saat tersedia di katalog.
 *   [M2] scanNearby/scanMulti: pakai _pickProgressive; options.forcePlay
 *        memaksa ganti stream aktif (klik GPS / klik peta).
 *   [M3] Substitute pin tanpa feed: radius progressive (bukan hard 25 km).
 *   [M4] HLS pure: streams[] selalu berisi direct + proxy (jika ada) agar
 *        UI bisa cascade tanpa tergantung noProxy.
 *   [M5] autoStream dipanggil otomatis dari UI saat GPS/map tak menemukan
 *        bestPlay lokal — Batam/remote tetap ditandai remote.
 *
 * Perubahan v6.15.3 (dari v6.15.2):
 *   [G12] Katalog cameras.json tidak di-fetch dari file://.
 *   [G13] Cache katalog + retry 30 dtk.
 *
 * Perubahan v6.15.2 — MULTI AUTO ACCESS REAL FIX: G1–G11.
 * ============================================================================ */

(function (global) {
"use strict";

// ==========================================================================
// 0. KONSTANTA
// ==========================================================================
const VERSION = "6.21.0";
const TICK_MS = 1000;
const DRONE_MAX_LOG = 100;
const FLEET_MAX_LOG = 200;
const TELEM_HISTORY = 60;
const RTB_THRESHOLD = 15;
const RTB_HYSTERESIS = 20;
const MESH_RADIUS = 3;
const GRID_SIZE = 32;

const BATAM_STREAM_COORDS = {
  "https://matanya.batam.go.id/cctv/batuaji/stream.m3u8":   { name: "Batu Aji (Batam)",     lat: 1.1300, lng: 104.0300 },
  "https://matanya.batam.go.id/cctv/atap/stream.m3u8":      { name: "Atap (Batam)",         lat: 1.1300, lng: 104.0500 },
  "https://matanya.batam.go.id/cctv/simpkuda2/stream.m3u8": { name: "Simpang Kuda (Batam)", lat: 1.1250, lng: 104.0450 },
  "https://matanya.batam.go.id/cctv/danganom2/stream.m3u8": { name: "Danganom (Batam)",     lat: 1.1200, lng: 104.0400 }
};

const STATE = Object.freeze({
  IDLE:"IDLE", DEPLOYING:"DEPLOYING", MONITORING:"MONITORING",
  INTERACTING:"INTERACTING", EMERGENCY:"EMERGENCY",
  RETURN_TO_BASE:"RETURN_TO_BASE", OFFLINE:"OFFLINE"
});

const VALID_TRANSITIONS = {
  IDLE:["DEPLOYING","OFFLINE"],
  DEPLOYING:["MONITORING","EMERGENCY","RETURN_TO_BASE","OFFLINE"],
  MONITORING:["INTERACTING","EMERGENCY","RETURN_TO_BASE","OFFLINE"],
  INTERACTING:["MONITORING","EMERGENCY","RETURN_TO_BASE","OFFLINE"],
  EMERGENCY:["MONITORING","RETURN_TO_BASE","OFFLINE"],
  RETURN_TO_BASE:["IDLE","OFFLINE"],
  OFFLINE:["IDLE"]
};

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

// [G1] helper sort null-safe
const distOf = x => (x && x.distance != null ? x.distance : Infinity);

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
    "https://corsproxy.io/?url=",
    "https://api.allorigins.win/raw?url=",
    "https://api.codetabs.com/v1/proxy?quest="
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
      { url: getUrl, method: "GET", body: null, label: "GET direct" },
      { url: mirrorUrl, method: "POST", body: dataParam, label: "POST direct" }
    ];
    try {
      const cgo = global.CGO_Fleet && global.CGO_Fleet.CCTV && global.CGO_Fleet.CCTV.getProxyUrl && global.CGO_Fleet.CCTV.getProxyUrl();
      if (cgo) {
        attempts.unshift({
          url: cgo + "/proxy?url=" + encodeURIComponent(getUrl),
          method: "GET", body: null, label: "GET cgo-proxy"
        });
      }
    } catch (_) {}
    for (const p of this.CORS_PROXIES) {
      if (!p) continue;
      const proxied = p.includes("?") ? p + encodeURIComponent(getUrl) : p + getUrl;
      attempts.push({ url: proxied, method: "GET", body: null, label: "GET proxy" });
    }
    return attempts;
  },

  /* [A4] batalkan fetch Overpass yang sedang berjalan (mis. klik GPS/peta yang lebih baru) */
  cancel() {
    this._cancel = true;
    try { if (this._ctrl) this._ctrl.abort(); } catch (_) {}
  },

  async fetchOverpass(query, timeout = 25000) {
    if (this._busy) throw new Error("Scanner sedang sibuk");
    this._busy = true;
    this._cancel = false;
    const startIdx = this._currentMirror;
    let lastErr = null;
    const deadline = Date.now() + this.TOTAL_BUDGET_MS;
    try {
      for (let attempt = 0; attempt < this.MIRRORS.length; attempt++) {
        const idx = (startIdx + attempt) % this.MIRRORS.length;
        const mirror = this.MIRRORS[idx];
        const attempts = this._buildAttempts(mirror.url, query);
        for (const att of attempts) {
          if (this._cancel) { lastErr = new Error("dibatalkan oleh permintaan baru"); break; }
          if (Date.now() > deadline) { lastErr = lastErr || new Error("batas waktu scan terlampaui"); break; }
          try {
            if (global.CGO_Fleet) {
              global.CGO_Fleet.logGlobal(
                `🌐 [NET] ${mirror.host} [${mirror.country}] · ${att.label}`, "INFO"
              );
            }
            const ctrl = new AbortController();
            this._ctrl = ctrl;
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
        if (this._cancel || Date.now() > deadline) break;
        if (global.CGO_Fleet) {
          global.CGO_Fleet.logGlobal(
            `⚠️ [NET] Mirror ${mirror.host} gagal semua metode - rotasi...`, "WARNING"
          );
        }
      }
      throw new Error("Semua mirror/proxy gagal: " + (lastErr?.message || "unknown"));
    } finally { this._busy = false; this._ctrl = null; }
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
      this.log(`Transisi tidak valid: ${this.state} -> ${next}`, "WARNING");
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
    if (!this._transition(STATE.EMERGENCY)) return null;
    this.telemetry.networkStatus = "STARLINK_EMERGENCY_MODE";
    return this.log("🚨 [CRITICAL] TSUNAMI ALERT!", "DANGER");
  }
  activateVoidPulse() {
    if (this.state === STATE.EMERGENCY) this._transition(STATE.MONITORING);
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
// 6. CCTV ENGINE
// ==========================================================================
const CCTVEngine = {
  _activeStreams: new Map(),
  _lastScan: null,
  _scanInProgress: false,

  BATAM_STREAM_DEFAULT: false,  /* v6.20: jangan fallback global ke Batam */

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

  PUBLIC_STREAMS: [
    /* Terbukti OK lewat https://cgo-proxy.cikurgo.workers.dev/probe (2026-10-23) */
    { name: "Batu Aji (Batam)",     lat: 1.1300, lng: 104.0300, hls: "https://matanya.batam.go.id/cctv/batuaji/stream.m3u8",   region: "Batam", accessType: "hls", realPublic: true, noProxy: true, verified: true },
    { name: "Atap (Batam)",         lat: 1.1450, lng: 104.0200, hls: "https://matanya.batam.go.id/cctv/atap/stream.m3u8",      region: "Batam", accessType: "hls", realPublic: true, noProxy: true, verified: true },
    { name: "Simpang Kuda (Batam)", lat: 1.1250, lng: 104.0450, hls: "https://matanya.batam.go.id/cctv/simpkuda2/stream.m3u8", region: "Batam", accessType: "hls", realPublic: true, noProxy: true, verified: true },
    { name: "Danganom (Batam)",     lat: 1.1200, lng: 104.0400, hls: "https://matanya.batam.go.id/cctv/danganom2/stream.m3u8", region: "Batam", accessType: "hls", realPublic: true, noProxy: true, verified: true },
    { name: "Sekupang (Batam)",     lat: 1.1160, lng: 103.9630, hls: "https://matanya.batam.go.id/cctv/sekupang/stream.m3u8", region: "Batam", accessType: "hls", realPublic: true, noProxy: true, verified: true }
  ],

  REAL_PUBLIC_CAMS: [
    { name: "Bendungan Hilir 1", lat: -6.2146, lng: 106.8081, embed: "https://cctv.balitower.co.id/Bendungan-Hilir-003-700014_1/embed.html", region: "Jakarta", softFail: true, hostKey: "cctv.balitower.co.id" },
    { name: "Bendungan Hilir 2", lat: -6.2148, lng: 106.8085, embed: "https://cctv.balitower.co.id/Bendungan-Hilir-003-700014_2/embed.html", region: "Jakarta", softFail: true, hostKey: "cctv.balitower.co.id" },
    { name: "Bendungan Hilir 3", lat: -6.2150, lng: 106.8078, embed: "https://cctv.balitower.co.id/Bendungan-Hilir-003-700014_3/embed.html", region: "Jakarta", softFail: true, hostKey: "cctv.balitower.co.id" },
    { name: "Bendungan Hilir 4", lat: -6.2144, lng: 106.8090, embed: "https://cctv.balitower.co.id/Bendungan-Hilir-003-700014_4/embed.html", region: "Jakarta", softFail: true, hostKey: "cctv.balitower.co.id" },
    { name: "GBK / Gelora 2", lat: -6.2186, lng: 106.8021, embed: "https://cctv.balitower.co.id/Gelora-017-700470_2/embed.html", region: "Jakarta", softFail: true, hostKey: "cctv.balitower.co.id" },
    { name: "GBK / Gelora 3", lat: -6.2188, lng: 106.8025, embed: "https://cctv.balitower.co.id/Gelora-017-700470_3/embed.html", region: "Jakarta", softFail: true, hostKey: "cctv.balitower.co.id" },
    { name: "GBK Asia Afrika", lat: -6.2240, lng: 106.8025, embed: "https://cctv.balitower.co.id/GBKC1002/embed.html", region: "Jakarta", softFail: true, hostKey: "cctv.balitower.co.id" },
    { name: "Manggarai Pintu Air 1", lat: -6.2100, lng: 106.8480, embed: "https://cctv.balitower.co.id/Manggarai-Pintu-Air_1/embed.html?proto=hls", region: "Jakarta", softFail: true, hostKey: "cctv.balitower.co.id" },
    { name: "Manggarai Pintu Air 2", lat: -6.2105, lng: 106.8485, embed: "https://cctv.balitower.co.id/Manggarai-Pintu-Air_2/embed.html?proto=hls", region: "Jakarta", softFail: true, hostKey: "cctv.balitower.co.id" },
    { name: "Tanjung Duren", lat: -6.1780, lng: 106.7900, embed: "https://cctv.balitower.co.id/Tanjung-Duren-Utara-005-702471_2/embed.html", region: "Jakarta", softFail: true, hostKey: "cctv.balitower.co.id" },
    { name: "Tomang", lat: -6.1720, lng: 106.7970, embed: "https://cctv.balitower.co.id/Tomang-004-702108_2/embed.html", region: "Jakarta", softFail: true, hostKey: "cctv.balitower.co.id" },
    { name: "Jati Pulo", lat: -6.1800, lng: 106.8000, embed: "https://cctv.balitower.co.id/Jati-Pulo-001-702017_2/embed.html", region: "Jakarta", softFail: true, hostKey: "cctv.balitower.co.id" },
    { name: "Cengkareng Barat", lat: -6.1450, lng: 106.7300, embed: "https://cctv.balitower.co.id/Cengkareng-Barat-013-702131_2/embed.html", region: "Jakarta", softFail: true, hostKey: "cctv.balitower.co.id" },
    { name: "Menteng / Bundaran HI", lat: -6.1944, lng: 106.8229, embed: "https://cctv.balitower.co.id/Menteng-001-700123_1/embed.html", region: "Jakarta", softFail: true, hostKey: "cctv.balitower.co.id" },
    { name: "Senayan 1", lat: -6.2270, lng: 106.8000, embed: "https://cctv.balitower.co.id/Senayan-004-705087_1/embed.html", region: "Jakarta", softFail: true, hostKey: "cctv.balitower.co.id" },
    { name: "Senayan 2", lat: -6.2275, lng: 106.8005, embed: "https://cctv.balitower.co.id/Senayan-004-705087_2/embed.html", region: "Jakarta", softFail: true, hostKey: "cctv.balitower.co.id" },
    { name: "Kemanggisan", lat: -6.1900, lng: 106.7850, embed: "https://cctv.balitower.co.id/Kemanggisan-038-792405_2/embed.html", region: "Jakarta", softFail: true, hostKey: "cctv.balitower.co.id" },
    { name: "GBK / Gelora 4", lat: -6.2185, lng: 106.8025, embed: "https://cctv.balitower.co.id/Gelora-017-700470_4/embed.html", region: "Jakarta", softFail: true, hostKey: "cctv.balitower.co.id" },
    { name: "GBK Asia Afrika 2", lat: -6.2230, lng: 106.8045, embed: "https://cctv.balitower.co.id/GBKC1003/embed.html", region: "Jakarta", softFail: true, hostKey: "cctv.balitower.co.id" },
  ],

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

  PROXY_URL: null,
  _proxyOk: null,
  _proxyInfo: null,
  _proxyCheckedAt: 0,

  // [S1] Streetside multi-source
  STREETSIDE_BASE: "https://streetside.mugnimaestra.dev",
  _streetsideLoaded: false,
  _streetsideLoading: null,
  _streetsideCount: 0,
  FETCH_SMART_PROXIES: [
    (u) => "https://corsproxy.io/?url=" + encodeURIComponent(u),
    (u) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u),
    (u) => "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(u)
  ],

  _normProxy(u) {
    if (u == null) return null;
    const raw = String(u).trim();
    if (!raw || raw.length > 280 || /\s/.test(raw)) return null;
    if (/PROXY_VERSION|ALLOWED_DOMAINS|createHandler|HEADERS_TO_|function\s+respond|===== CORE/i.test(raw)) return null;
    let v = raw;
    if (!/^https?:\/\//i.test(v)) v = "https://" + v;
    let p;
    try { p = new URL(v); } catch (_) { return null; }
    if (p.protocol !== "http:" && p.protocol !== "https:") return null;
    const h = (p.hostname || "").toLowerCase();
    if (!h || h === "*" || !/^[a-z0-9.-]+$/i.test(h)) return null;
    if (h !== "localhost" && h.indexOf(".") < 0) return null;
    return (p.origin + p.pathname).replace(/\/+$/, "");
  },
  setProxyUrl(url) {
    const raw = (url == null) ? "" : String(url).trim();
    const norm = this._normProxy(raw);
    if (raw && !norm) {
      if (global.CGO_Fleet) global.CGO_Fleet.emit("PROXY_REJECTED", { reason: "format" });
      return null;
    }
    this.PROXY_URL = norm;
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
    try { if (global.CGO_ProxyURL) { const g = this._normProxy(global.CGO_ProxyURL); if (g) return g; } } catch (_) {}
    try {
      const q = global.location && new URLSearchParams(global.location.search).get("proxy");
      if (q) { const n = this._normProxy(q); if (n) return n; }
    } catch (_) {}
    try {
      const sv = global.localStorage && global.localStorage.getItem("cgo_proxy_url");
      if (sv) {
        const n = this._normProxy(sv);
        if (n) return n;
        try { global.localStorage.removeItem("cgo_proxy_url"); } catch (_) {}
      }
    } catch (_) {}
    try {
      const loc = global.location;
      if (loc && /cikurgo\.(github\.io|workers\.dev)/i.test(String(loc.hostname || ""))) {
        return "https://cgo-proxy.cikurgo.workers.dev";
      }
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

  /* Host yang baru gagal (timeout/network) — jangan diantre 10 menit */
  _hostFail: Object.create(null),
  _hostKeyFromUrl(url) {
    try { return new URL(url).hostname.toLowerCase(); } catch (_) { return ""; }
  },
  markHostFail(urlOrHost, ms = 600000) {
    const h = String(urlOrHost || "").includes("://") ? this._hostKeyFromUrl(urlOrHost) : String(urlOrHost || "").toLowerCase();
    if (!h) return;
    this._hostFail[h] = Date.now() + ms;
    if (global.CGO_Fleet) global.CGO_Fleet.logGlobal("⛔ [CCTV] Host ditunda 10 mnt: " + h, "WARNING");
  },
  isHostFailed(urlOrHost) {
    const h = String(urlOrHost || "").includes("://") ? this._hostKeyFromUrl(urlOrHost) : String(urlOrHost || "").toLowerCase();
    if (!h) return false;
    const until = this._hostFail[h];
    if (!until) return false;
    if (Date.now() > until) { delete this._hostFail[h]; return false; }
    return true;
  },
  async probePlayable(url, timeoutMs = 5000) {
    if (!url) return false;
    if (this.isHostFailed(url)) return false;
    const p = this.getProxyUrl();
    try {
      if (p) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
          const res = await fetch(p + "/probe?url=" + encodeURIComponent(url), { signal: ctrl.signal });
          const j = await res.json().catch(() => null);
          if (j && j.ok) return true;
          if (j && /timeout/i.test(String(j.error || ""))) this.markHostFail(url);
          return false;
        } finally { clearTimeout(t); }
      }
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), Math.min(timeoutMs, 4000));
      try {
        const res = await fetch(url, { method: "GET", mode: "cors", signal: ctrl.signal });
        try { if (res.body && res.body.cancel) res.body.cancel(); } catch (_) {}
        return !!res.ok;
      } finally { clearTimeout(t); }
    } catch (e) {
      if (e && e.name === "AbortError") this.markHostFail(url);
      return false;
    }
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
      this._proxyInfo = ok ? { version: String(j.version || ""), features: j.features || null,
        allowedDomains: Array.isArray(j.allowedDomains) ? j.allowedDomains.map(d => String(d).toLowerCase()) : null } : null;
    } catch (_) { this._proxyInfo = null; }
    this._proxyOk = ok; this._proxyCheckedAt = Date.now();
    if (global.CGO_Fleet) global.CGO_Fleet.emit("PROXY_STATUS", { url: p, ok, version: ok && this._proxyInfo ? this._proxyInfo.version : null, htmlRewrite: this.proxyHasHtmlRewrite() });
    return ok;
  },
  getProxyInfo() { return this._proxyInfo ? { ...this._proxyInfo } : null; },
  /* Worker v1.x hanya meneruskan byte (HLS/JSON); halaman embed TIDAK dirender ulang -> iframe via proxy bisa kosong.
     Server >= 2.x (dan worker yang melaporkan features.htmlRewrite) merender ulang halaman. Tidak diketahui -> anggap bisa. */
  proxyHasHtmlRewrite() {
    const i = this._proxyInfo;
    if (!i) return true;
    if (i.features && typeof i.features.htmlRewrite === "boolean") return i.features.htmlRewrite;
    const major = parseInt(String(i.version || "").split(".")[0], 10);
    return Number.isFinite(major) ? major >= 2 : true;
  },
  async explainHls(url, timeoutMs = 6000) {
    const attempt = async (mode) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, { method: "GET", mode, signal: ctrl.signal });
        try { if (res.body && res.body.cancel) res.body.cancel(); } catch (_) {}
        return mode === "cors" ? (res.ok ? "ok" : "http:" + res.status) : "ok";
      } catch (e) { return e && e.name === "AbortError" ? "timeout" : "fail"; }
      finally { clearTimeout(t); }
    };
    const [c, n] = await Promise.all([attempt("cors"), attempt("no-cors")]);
    let text, code;
    if (c === "ok") { code = "cors-ok"; text = "CORS diizinkan - gagal karena format/segmen."; }
    else if (c.indexOf("http:") === 0) { code = "http"; text = "Server menjawab " + c.slice(5) + "."; }
    else if (n === "ok") { code = "no-cors"; text = "Kamera hidup, CORS menolak."; }
    else if (c === "timeout" || n === "timeout") { code = "timeout"; text = "Kamera tidak menjawab."; }
    else { code = "unreachable"; text = "Kamera tidak terjangkau."; }
    return { code, cors: c === "ok", reachable: n === "ok" || c === "ok", text };
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

  _normalizeStreamEntry(s) {
    if (!s) return null;
    if (typeof s === "string") {
      const d = BATAM_STREAM_COORDS[s] || {};
      return {
        name: d.name || "HLS",
        lat: d.lat, lng: d.lng,
        hls: s, region: "Batam",
        accessType: "hls", realPublic: true, noProxy: true
      };
    }
    if (typeof s === "object" && s.hls) return s;
    return null;
  },
  setStreamUrls(urls) {
    const arr = Array.isArray(urls) ? urls : [];
    this.PUBLIC_STREAMS = arr.map(u => this._normalizeStreamEntry(u)).filter(Boolean);
    return this.getStreamUrls();
  },
  getStreamUrls() {
    return this.PUBLIC_STREAMS.map(s => typeof s === "string" ? s : (s && s.hls) || "");
  },

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


  // [S2] Normalisasi koordinat (perbaiki serialisasi integer tanpa titik desimal)
  normalizeCoord(v, isLat) {
    let n = parseFloat(v);
    if (!Number.isFinite(n)) return null;
    const max = isLat ? 90 : 180;
    if (Math.abs(n) <= max) return n;
    if (Math.abs(n) > max * 100) {
      // [A9] Titik desimal hilang itu ambigu (mis. -62146000 bisa -62,146 atau -6,2146). Kamera di katalog ini
      // berada di Indonesia -> pilih pembagi yang jatuh di dalam kotak Indonesia; baru bila tak ada pakai aturan lama.
      const box = isLat ? [-11.5, 6.5] : [94.5, 141.5];
      for (const d of [1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9]) {
        const cand = n / d;
        if (cand >= box[0] && cand <= box[1]) return cand;
      }
      for (const d of [1e9, 1e8, 1e7, 1e6, 1e5, 1e4, 1e3, 1e2, 1e1]) {
        const cand = n / d;
        if (Math.abs(cand) <= max) return cand;
      }
    }
    return null;
  },

  // [S3] Fetch direct → cascade proxy (JSON/text)
  async fetchSmart(url, expectJson = true, timeoutMs = 9000) {
    const tryOne = async (u, ms) => {
      const res = await fetch(u, { signal: AbortSignal.timeout(ms), cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const text = await res.text();
      if (!text || /^<!doctype|^<html/i.test(text.trim())) throw new Error("Response HTML");
      return expectJson ? JSON.parse(text) : text;
    };
    try {
      return await tryOne(url, timeoutMs);
    } catch (e1) {
      const errs = [String(e1 && e1.message || e1)];
      // [A7] proxy CGO milik sendiri (worker/server yang sudah berjalan) lebih dulu — domain Streetside sudah di whitelist-nya
      try {
        if (this.getProxyUrl() && await this.checkProxy()) {
          const info = this._proxyInfo, host = new URL(url).hostname.toLowerCase();
          const known = info && info.allowedDomains;
          if (known && !known.some(d => host === d || host.endsWith("." + d))) {
            errs.push("CGO:domain belum di whitelist proxy");
            if (global.CGO_Fleet) global.CGO_Fleet.logGlobal(`⚠️ [PROXY] ${host} belum ada di whitelist proxy — tambahkan lewat EXTRA_ALLOWED_DOMAINS atau perbarui proxy-server.js`, "WARNING");
          } else {
            return await tryOne(this.proxify(url), 14000);
          }
        }
      } catch (e) { errs.push("CGO:" + (e && e.message || e)); }
      for (let i = 0; i < this.FETCH_SMART_PROXIES.length; i++) {
        try {
          return await tryOne(this.FETCH_SMART_PROXIES[i](url), 14000);
        } catch (e) {
          errs.push("P" + i + ":" + (e && e.message || e));
        }
      }
      throw new Error("Semua proxy gagal (" + errs.slice(0, 3).join(", ") + ")");
    }
  },

  // [S1] Muat katalog Streetside ke REAL_PUBLIC_CAMS (dedupe by name+coord)
  async loadStreetsideCameras() {
    if (this._streetsideLoaded) return this._streetsideCount;
    if (this._streetsideLoading) return this._streetsideLoading;
    if (this._streetsideFailedAt && Date.now() - this._streetsideFailedAt < 60000) return 0;   // [A8]
    this._streetsideLoading = (async () => {
      let added = 0;
      try {
        const data = await this.fetchSmart(this.STREETSIDE_BASE + "/api/cameras");
        const arr = Array.isArray(data) ? data : (data.cameras || data.data || []);
        const dedupeKey = (n, la, lo) => String(n) + "|" + Number(la).toFixed(4) + "|" + Number(lo).toFixed(4);
        const existing = new Set(this.REAL_PUBLIC_CAMS.map(c => dedupeKey(c.name, c.lat, c.lng)));
        for (const c of arr) {
          if (c.content_type && c.content_type !== "cctv") continue;
          if (c.is_enabled === false) continue;
          const lat = this.normalizeCoord(c.latitude ?? c.lat, true);
          const lng = this.normalizeCoord(c.longitude ?? c.lng ?? c.lon, false);
          if (lat == null || lng == null) continue;
          const name = c.cctv_name || c.name || c.title || ("Streetside-" + c.id);
          const key = dedupeKey(name, lat, lng);
          if (existing.has(key)) continue;
          existing.add(key);
          this.REAL_PUBLIC_CAMS.push({
            name: String(name),
            lat, lng,
            streetsideId: c.id,
            region: c.city_name || c.address || "Streetside",
            realPublic: true,
            accessType: "hls",
            surveillanceType: "streetside_live"
          });
          added++;
        }
        this._streetsideLoaded = true;
        this._streetsideCount = added;
        if (global.CGO_Fleet && added) {
          global.CGO_Fleet.logGlobal("📡 [CCTV] Streetside: " + added + " kamera ditambahkan", "SUCCESS");
        }
      } catch (e) {
        this._streetsideFailedAt = Date.now();
        if (global.CGO_Fleet) {
          global.CGO_Fleet.logGlobal("⚠️ [CCTV] Streetside gagal: " + (e && e.message), "WARNING");
        }
      } finally {
        this._streetsideLoading = null;
      }
      return added;
    })();
    return this._streetsideLoading;
  },

  // [S1] Resolve HLS URL untuk kamera Streetside (on-demand)
  async resolveStreetsideHls(cam) {
    if (!cam || cam.hls) return cam && cam.hls;
    const id = cam.streetsideId || (cam.id && String(cam.id).replace(/^SS-/, ""));
    if (!id) return null;
    this._ssHls = this._ssHls || new Map();
    if (this._ssHls.has(String(id))) { cam.hls = this._ssHls.get(String(id)); return cam.hls; }
    const detail = await this.fetchSmart(this.STREETSIDE_BASE + "/api/cameras/" + id);
    const raw = detail.hls || detail.stream_url || detail.url || detail.m3u8 ||
      (detail.stream && detail.stream.hls) || (detail.streams && detail.streams.hls) ||
      (detail.data && (detail.data.hls || detail.data.stream_url)) || "";
    if (!raw) return null;
    let resolved = String(raw);
    if (!/^https?:\/\//i.test(resolved)) {
      const base = this.STREETSIDE_BASE.replace(/\/$/, "");
      if (resolved.startsWith("/")) resolved = base + resolved;
      else if (resolved.startsWith("./")) resolved = base + "/" + resolved.slice(2);
      else resolved = base + "/" + resolved;
    }
    try {
      const u = new URL(resolved);
      if (!/^https?:$/.test(u.protocol)) return null;
    } catch (_) { return null; }
    cam.hls = resolved;
    this._ssHls.set(String(id), resolved);
    return resolved;
  },

  _linkNearbyLiveFeeds(pins, feeds, linkM = 450) {
    if (!pins || !pins.length || !feeds || !feeds.length) return pins || [];
    const sources = feeds.filter(f =>
      f && !f.isPortal && !f.synthetic &&
      (f.hls || f.embed || f.hlsAuto || f.streetsideId) &&
      f.lat != null && f.lng != null
    );
    if (!sources.length) return pins;
    for (const pin of pins) {
      if (!pin || pin.lat == null || pin.lng == null) continue;
      if (pin.hls || pin.embed || pin.hlsAuto || pin.streetsideId) continue;
      let best = null, bestD = linkM + 1;
      for (const f of sources) {
        const d = this.calculateDistance(pin.lat, pin.lng, f.lat, f.lng);
        if (d < bestD) { bestD = d; best = f; }
      }
      if (!best) continue;
      pin.linkedFrom = best.id || best.name;
      pin.linkedDistance = Math.round(bestD);
      if (best.hls) pin.hls = best.hls;
      if (best.hlsAuto) pin.hlsAuto = best.hlsAuto;
      if (best.embed) pin.embed = best.embed;
      if (best.streetsideId != null) pin.streetsideId = best.streetsideId;
      if (best.noProxy) pin.noProxy = true;
      pin.realPublic = true;
      pin.accessType = best.accessType || (best.hls || best.hlsAuto ? "hls" : "embed");
      pin.surveillanceType = pin.surveillanceType || "osm_linked_live";
      if (!pin.name || /^CCTV/i.test(String(pin.name))) {
        pin.name = (best.name || pin.name) + " · pin";
      }
    }
    return pins;
  },

  CATALOG_URL: "cameras.json",

  _catalogPromise: null,
  _catalogResult: null,
  _catalogFailedAt: 0,
  _catalogRetryMs: 30000,
  ensureCatalog() {
    if (this._catalogPromise) return this._catalogPromise;
    if (this._catalogResult) {
      const isLocalFile = this._catalogResult.error === "file-origin";
      const canReuse = !this._catalogResult.error ||
        isLocalFile ||
        Date.now() - this._catalogFailedAt < this._catalogRetryMs;
      if (canReuse) {
        // Streetside boleh di-refresh paralel tanpa memblokir cache katalog
        this.loadStreetsideCameras().catch(() => {});
        return Promise.resolve(this._catalogResult);
      }
    }
    this._catalogPromise = Promise.all([
      this.loadCatalog(),
      // [A8] Streetside terus dimuat di latar belakang; scan tidak menunggu > 2,5 dtk
      Promise.race([this.loadStreetsideCameras().catch(() => 0), new Promise(r => setTimeout(r, 2500))])
    ]).then(([r]) => {
      this._catalogResult = r;
      this._catalogFailedAt = r && r.error ? Date.now() : 0;
      return r;
    }).finally(() => {
      this._catalogPromise = null;
    });
    return this._catalogPromise;
  },
  async loadCatalog(url) {
    const out = { added: 0, skipped: 0, error: null };
    try {
      const target = url || this.CATALOG_URL;
      let protocol = "";
      try {
        protocol = new URL(target, global.location && global.location.href || "http://localhost/").protocol;
      } catch (_) {}
      if (protocol === "file:") {
        out.error = "file-origin";
      } else {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 4000);
        let res;
        try { res = await fetch(target, { cache: "no-store", signal: ctrl.signal }); }
        finally { clearTimeout(t); }
        if (!res.ok) throw new Error("HTTP " + res.status);
        const j = await res.json();
        const list = Array.isArray(j) ? j : ((j && j.cameras) || []);
        for (const c of list) { if (this._addCatalogCam(c)) out.added++; else out.skipped++; }
      }
    } catch (e) { out.error = e && e.name === "AbortError" ? "timeout" : (e && e.message); }
    if (global.CGO_Fleet) {
      global.CGO_Fleet.emit("CATALOG_LOADED", out);
      if (out.added) global.CGO_Fleet.logGlobal(`📚 [CCTV] Katalog: ${out.added} kamera ditambahkan`, "SUCCESS");
      if (out.error === "file-origin") {
        global.CGO_Fleet.logGlobal("⚠️ [CCTV] cameras.json dilewati: file:// tidak bisa memuat katalog lokal; gunakan server HTTP/HTTPS.", "WARNING");
      } else if (out.error) {
        global.CGO_Fleet.logGlobal(`⚠️ [CCTV] Katalog tidak dimuat (${out.error}); feed bawaan tetap tersedia.`, "WARNING");
      }
    }
    return out;
  },
  _classifyConfiguredAccess(url, declared) {
    const wanted = String(declared || "").toLowerCase();
    if (["public", "private", "vpn"].includes(wanted)) return wanted;
    try {
      const u = new URL(url);
      const h = u.hostname.toLowerCase();
      const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
      if (h === "localhost" || h.endsWith(".local") || (ipv4 && (
        Number(ipv4[1]) === 10 || Number(ipv4[1]) === 127 ||
        (Number(ipv4[1]) === 192 && Number(ipv4[2]) === 168) ||
        (Number(ipv4[1]) === 172 && Number(ipv4[2]) >= 16 && Number(ipv4[2]) <= 31)
      ))) return "private";
      return "public";
    } catch (_) { return "unknown"; }
  },
  _addCatalogCam(c) {
    if (!c || c.disabled || !c.name || !isFinite(Number(c.lat)) || !isFinite(Number(c.lng))) return false;
    const lat = Number(c.lat), lng = Number(c.lng), name = String(c.name), region = c.region || "Katalog";
    const type = String(c.type || "").toLowerCase();
    const url = c.url ? String(c.url).trim() : "";
    const declaredAccess = String(c.accessType || c.access || "").toLowerCase();
    let accessType = this._classifyConfiguredAccess(url, declaredAccess);
    if (/^private-/.test(type)) accessType = "private";
    if (/^vpn-/.test(type)) accessType = "vpn";
    const isConfiguredNetwork = ["private", "vpn"].includes(accessType) || /^(private|vpn)-/.test(type);
    const isValidUrl = (value) => {
      try {
        const u = new URL(value);
        if (!["https:", "http:"].includes(u.protocol)) return false;
        if (u.protocol === "http:" && !isConfiguredNetwork && declaredAccess !== "private" && declaredAccess !== "vpn") return false;
        return !!u.hostname;
      } catch (_) { return false; }
    };
    const dedupeKey = (n, la, lo) => `${n}|${Number(la).toFixed(4)}|${Number(lo).toFixed(4)}`;
    const has = (arr) => arr.some(x => dedupeKey(x.name, x.lat, x.lng) === dedupeKey(name, lat, lng));

    if (type === "portal") {
      if (!isValidUrl(url) || has(this.REGION_PORTALS)) return false;
      this.REGION_PORTALS.push({ name, lat, lng, url, region, openInNewTab: true, accessType });
      return true;
    }
    if (has(this.REAL_PUBLIC_CAMS)) return false;
    const noProxy = isConfiguredNetwork;

    if (["embed", "private-embed", "vpn-embed"].includes(type)) {
      if (!isValidUrl(url)) return false;
      const entry = { name, lat, lng, embed: url, region, accessType, configuredAccess: true, realPublic: true };
      if (noProxy) entry.noProxy = true;
      this.REAL_PUBLIC_CAMS.push(entry);
      return true;
    }
    if (["hls", "private-hls", "vpn-hls"].includes(type)) {
      if (!isValidUrl(url)) return false;
      const entry = { name, lat, lng, hls: url, region, accessType, configuredAccess: true, realPublic: true };
      if (noProxy) entry.noProxy = true;
      this.REAL_PUBLIC_CAMS.push(entry);
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
  _osmStream(tags) {
    if (!tags) return null;
    const strong = tags["contact:webcam"] || tags["webcam"] || tags["camera:url"] || tags["stream"]
      || tags["camera:stream"] || tags["surveillance:url"];
    const raw = strong || tags["url"] || tags["website"];
    if (!raw) return null;
    const url = String(raw).trim();
    if (!/^https?:\/\//i.test(url)) return null;
    const secure = /^https:\/\//i.test(url);
    let isPrivateHttp = false;
    if (!secure) {
      const access = this._classifyConfiguredAccess(url, "");
      if (access !== "private" && access !== "vpn") return null;
      isPrivateHttp = true;
    }
    const noProxy = isPrivateHttp;
    const yt = this._youtubeEmbed(url);
    if (yt) return { realPublic: true, embed: yt, noProxy: true, accessType: "youtube", surveillanceType: "osm_stream", fromOSM: true };
    if (/\.m3u8(\?|$)/i.test(url)) {
      const out = { realPublic: true, hls: url, accessType: "hls", surveillanceType: "osm_stream", fromOSM: true };
      if (noProxy) out.noProxy = true;
      return out;
    }
    if (/\/embed(\.html)?(\?|$)/i.test(url) || /balitower\.co\.id/i.test(url)) {
      const hlsAuto = this._hlsFromEmbed(url);
      const out = {
        realPublic: true, embed: url, accessType: "embed",
        hlsAuto: hlsAuto || undefined,
        surveillanceType: "osm_stream", fromOSM: true
      };
      if (noProxy) out.noProxy = true;
      return out;
    }
    if (!strong) return null;
    const out = { realPublic: true, embed: url, isPortal: true, openInNewTab: true, accessType: "portal", surveillanceType: "osm_portal", fromOSM: true };
    if (noProxy) out.noProxy = true;
    return out;
  },
  _playabilityScore(c) {
    if (!c) return -1;
    let s;
    if (c.isPortal) s = 1;
    else if (c.verified && c.hls) s = 95;           /* terbukti LIVE via proxy */
    else if (c.hls && c.noProxy) s = 90;
    else if (c.hls) s = 80;
    else if (c.hlsAuto && !c.softFail) s = 72;
    else if (c.hlsAuto && c.softFail) s = 35;       /* BaliTower: rendah sampai probe OK */
    else if (c.streetsideId) s = 65;
    else if (c.noProxy && c.embed) s = 60;
    else if (c.embed && c.softFail) s = 25;
    else if (c.embed) s = 45;
    else if (c.realPublic) s = 20;
    else s = 0;
    if (c.accessType === "private" || c.accessType === "vpn") s = Math.floor(s * 0.5);
    const hk = c.hostKey || this._hostKeyFromUrl(c.hls || c.hlsAuto || c.embed || "");
    if (hk && this.isHostFailed(hk)) s = -1;
    return s;
  },
  // [G2] filter posisi: null-lat hanya lolos jika maxKm = Infinity
  _pickBestPlayable(list, preferLat, preferLng, maxKm = 25, opts = {}) {
    if (!list || !list.length) return null;
    const includePortal = !!opts.includePortal;
    const scored = list
      .filter(c => {
        if (!c) return false;
        if (c.isPortal) return includePortal;
        if (!(c.hls || c.embed || c.hlsAuto || c.streetsideId)) return false;
        if (preferLat == null || preferLng == null) return true;
        if (c.lat == null || c.lng == null) return maxKm === Infinity;
        return this.calculateDistance(preferLat, preferLng, c.lat, c.lng) / 1000 <= maxKm;
      })
      .map(c => {
        let s = this._playabilityScore(c);
        if (preferLat != null && preferLng != null && c.lat != null && c.lng != null) {
          const d = this.calculateDistance(preferLat, preferLng, c.lat, c.lng);
          s += Math.max(0, 15 - d / 1000);
        }
        return { c, s };
      })
      .sort((a, b) => b.s - a.s);
    return scored.length ? scored[0].c : null;
  },

  // [M1] progressive radius: prioritaskan dekat, perluas sampai ada stream real
  _pickProgressive(list, lat, lng, opts = {}) {
    if (!list || !list.length) return null;
    const steps = [2, 5, 15, 40, 80, 200, Infinity];  /* generik: dekat dulu */
    const finalize = (pick) => {
      if (!pick) return null;
      // Hitung ulang jarak thd titik query (bukan jarak cache scan sebelumnya)
      if (lat != null && lng != null && pick.lat != null && pick.lng != null) {
        const d = Math.round(this.calculateDistance(lat, lng, pick.lat, pick.lng));
        pick = { ...pick, distance: d };
        if (d > 50000) pick.remote = true;
        else delete pick.remote;
      } else if (pick.distance != null && pick.distance > 50000) {
        pick = { ...pick, remote: true };
      }
      return pick;
    };
    for (const km of steps) {
      const pick = finalize(this._pickBestPlayable(list, lat, lng, km, opts));
      if (pick) return pick;
    }
    if (!opts.includePortal) {
      for (const km of steps) {
        const pick = finalize(this._pickBestPlayable(list, lat, lng, km, { includePortal: true }));
        if (pick) return pick;
      }
    }
    return null;
  },

  _camEntry(rc, dist) {
    const e = {
      id: rc.streetsideId != null ? ("SS-" + rc.streetsideId) : ("REAL-" + rc.name.replace(/\s+/g, "-")),
      lat: rc.lat, lng: rc.lng, distance: dist,
      name: rc.name, surveillanceType: rc.surveillanceType || (rc.configuredAccess ? "configured_live" : "public_live"),
      realPublic: rc.realPublic !== false, embed: rc.embed, region: rc.region,
      configuredAccess: !!rc.configuredAccess
    };
    if (rc.streetsideId != null) e.streetsideId = rc.streetsideId;
    if (rc.hls) { e.hls = rc.hls; e.accessType = rc.accessType || "hls"; }
    else if (rc.accessType) e.accessType = rc.accessType;
    if (rc.noProxy) { e.noProxy = true; e.accessType = e.accessType || "youtube"; }
    if (rc.verified) e.verified = true;
    if (rc.softFail) e.softFail = true;
    if (rc.hostKey) e.hostKey = rc.hostKey;
    const auto = rc.hls ? null : this._hlsFromEmbed(rc.embed);
    if (auto) e.hlsAuto = auto;
    if (!e.accessType) e.accessType = auto ? "embed+hls" : (rc.embed ? "embed" : (rc.streetsideId != null ? "hls" : "unknown"));
    if (rc.accessType && rc.accessType !== "hls") e.accessType = rc.accessType;
    return e;
  },
  _hlsFromEmbed(embed) {
    const s = String(embed || "");
    let m = s.match(/^https?:\/\/(cctv\.balitower\.co\.id)\/([^/?#]+)\/embed\.html/i);
    if (m) return "https://" + m[1] + "/" + m[2] + "/index.m3u8";
    m = s.match(/^(https?:\/\/[^/?#]+\/[^?#]*?)\/embed\.html(?:\?|$)/i);
    if (m && /cctv|atcs|stream/i.test(m[1])) return m[1] + "/index.m3u8";
    return null;
  },
  _primePick(live, lat, lng, opts = {}) {
    return this._pickProgressive(live, lat, lng, opts);
  },

  // [G4]+[M4] streams[] berprioritas: HLS-direct > HLS-proxy > Embed-proxy > Embed-direct
  // Direct dulu karena banyak feed publik (Batam) sudah CORS-ok; proxy cadangan.
  _buildEmbedStreams(cctv, proxy) {
    const streams = [];
    if (cctv.hlsAuto) {
      streams.push({ type: "hls", url: cctv.hlsAuto, proxied: null });
      if (proxy) streams.push({ type: "hls", url: cctv.hlsAuto, proxied: this.proxify(cctv.hlsAuto) });
    }
    if (cctv.embed) {
      if (proxy && !cctv.noProxy) {
        streams.push({ type: "embed", url: cctv.embed, proxied: this.proxify(cctv.embed) });
      }
      streams.push({ type: "embed", url: cctv.embed, proxied: null });
    }
    return streams;
  },

  _buildHlsStreams(streamUrl, proxy, noProxy) {
    const streams = [{ type: "hls", url: streamUrl, proxied: null }];
    if (proxy) streams.push({ type: "hls", url: streamUrl, proxied: this.proxify(streamUrl) });
    return streams;
  },

  // [G8] helper: apakah stream aktif = stream real (bukan portal/sim)?
  _isActiveRealStream(current) {
    if (!current) return false;
    if (current.openInNewTab) return false;
    if (current.simulate) return false;
    return !!(current.url || current.embed);
  },

  // [G9] merge partial — field baru tidak ditimpa null/undefined
  _mergePartial(allCCTVs, baseLat, baseLng) {
    const seen = new Map();
    for (const c of allCCTVs) {
      const k = String(c.id);
      if (!seen.has(k)) seen.set(k, c);
    }
    for (const c of this._liveEntries(baseLat, baseLng, {
      realMax: Infinity, portalMax: Infinity, streamMax: Infinity
    })) {
      if (c.distance != null && c.distance > 200000) continue;
      const k = String(c.id);
      if (seen.has(k)) {
        const prev = seen.get(k);
        for (const key of Object.keys(c)) {
          if (c[key] !== undefined && c[key] !== null) prev[key] = c[key];
        }
      } else {
        seen.set(k, c);
      }
    }
    return Array.from(seen.values()).sort((a, b) => distOf(a) - distOf(b));
  },

  // [G1] sort null-safe
  _liveEntries(lat, lng, opts = {}) {
    const realMax = opts.realMax != null ? opts.realMax : 20000;
    const portalMax = opts.portalMax != null ? opts.portalMax : 50000;
    const streamMax = opts.streamMax != null ? opts.streamMax : 500000;
    const out = [];
    for (const raw of this.PUBLIC_STREAMS) {
      const s = this._normalizeStreamEntry(raw);
      if (!s || !s.hls) continue;
      const dist = (s.lat != null && s.lng != null)
        ? Math.round(this.calculateDistance(lat, lng, s.lat, s.lng))
        : null;
      if (dist != null && dist > streamMax) continue;
      const e = this._camEntry(s, dist);
      e.farFromUser = dist != null && dist > 50000;
      out.push(e);
    }
    for (const rc of this.REAL_PUBLIC_CAMS) {
      if (rc.lat == null || rc.lng == null) continue;
      const dist = Math.round(this.calculateDistance(lat, lng, rc.lat, rc.lng));
      if (dist <= realMax) {
        const e = this._camEntry(rc, dist);
        e.farFromUser = dist > 50000;
        out.push(e);
      }
    }
    for (const p of this.REGION_PORTALS) {
      if (p.lat == null || p.lng == null) continue;
      const dist = Math.round(this.calculateDistance(lat, lng, p.lat, p.lng));
      if (dist <= portalMax) {
        out.push({
          id: "PORTAL-" + p.name.replace(/\s+/g, "-"),
          lat: p.lat, lng: p.lng, distance: dist,
          name: p.name, surveillanceType: "portal_live",
          realPublic: true, embed: p.url, region: p.region,
          isPortal: true, openInNewTab: true,
          farFromUser: dist > 50000
        });
      }
    }
    out.sort((a, b) => distOf(a) - distOf(b));
    return out;
  },

  // [G5] juga mencari PUBLIC_STREAMS
  _nearestLive(lat, lng, maxKm = 25) {
    let best = null, bestD = Infinity;
    const consider = (rc) => {
      if (!rc || rc.lat == null || rc.lng == null) return;
      const d = this.calculateDistance(lat, lng, rc.lat, rc.lng);
      if (d < bestD && d / 1000 <= maxKm) {
        bestD = d;
        best = this._camEntry(rc, Math.round(d));
      }
    };
    for (const raw of this.PUBLIC_STREAMS) {
      const s = this._normalizeStreamEntry(raw);
      if (s && s.hls) consider(s);
    }
    for (const rc of this.REAL_PUBLIC_CAMS) consider(rc);
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

    await this.ensureCatalog();
    // live lokal (radius scan) + katalog luas untuk progressive real stream
    const live = this._liveEntries(lat, lng, { realMax: radius, portalMax: Math.max(radius, 40000) });
    const liveWide = this._liveEntries(lat, lng, {
      realMax: Infinity, portalMax: Math.max(radius, 80000), streamMax: Infinity
    });

    // [G6]+[M2] initial-pick: prioritaskan stream real; forcePlay dari GPS/map
    const forcePlay = !!options.forcePlay;
    if (!options.skipStream && (forcePlay || !this._activeStreams.has("default"))) {
      let first = this._primePick(liveWide, lat, lng);
      if (!first) first = this._nearestLive(lat, lng, 50);
      if (!first) first = this._pickProgressive(liveWide, lat, lng, { includePortal: true });
      if (first) this._prepareStream(first, fleet, {
        force: forcePlay,
        substitute: !!(first.id && !live.some(c => c.id === first.id))
      });
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
        node["camera:mount"](around:${radius},${lat},${lng});
        node["highway"="traffic_signals"]["surveillance"](around:${radius},${lat},${lng});
        node["highway"="traffic_signals"]["camera:type"](around:${radius},${lat},${lng});
        node["man_made"="monitoring_station"](around:${radius},${lat},${lng});
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
        const entry = {
          id: "OSM-" + el.type + "-" + el.id,
          osmId: el.id, type: el.type, lat: elLat, lng: elLon,
          tags: el.tags || {}, distance: Math.round(dist),
          name: el.tags?.name || el.tags?.description || ("CCTV OSM #" + el.id),
          operator: el.tags?.operator || null,
          surveillanceType: el.tags?.["surveillance:type"] || el.tags?.["camera:type"] || "osm_pin",
          fromOSM: true
        };
        const osmLive = this._osmStream(el.tags);
        if (osmLive) Object.assign(entry, osmLive);
        cctvs.push(entry);
      }

      /* Pin OSM ↔ feed katalog ≤450 m → LIVE generik di titik GPS */
      this._linkNearbyLiveFeeds(cctvs, live, 450);
      cctvs.push(...live);

      if (cctvs.length === 0) {
        fleet.logGlobal(`[CCTV] OSM kosong -> spawn 6 synthetic pin`, "WARNING");
        cctvs.push(...this._spawnSyntheticCCTV(lat, lng, 6, 2));
      } else {
        const realN = cctvs.filter(c => c.realPublic).length;
        fleet.logGlobal(`[CCTV] ${cctvs.length} kamera (${realN} public live)`, "SUCCESS");
      }
      // [G1] sort null-safe
      cctvs.sort((a, b) => distOf(a) - distOf(b));

      const nearest = cctvs[0] || null;
      // [M1] progressive: lokal dulu, perluas ke katalog luas
      let bestPlay = this._pickProgressive(cctvs, lat, lng);
      if (!bestPlay) bestPlay = this._pickProgressive(liveWide, lat, lng);
      if (!bestPlay) bestPlay = this._pickProgressive(cctvs, lat, lng, { includePortal: true });
      this._lastScan = {
        queryLat: lat, queryLng: lng, radius, cctvs, nearest, bestPlay, timestamp: U.iso()
      };

      fleet.logGlobal(
        `✅ [CCTV] ${cctvs.length} unit. Putar: ${bestPlay ? bestPlay.name + (bestPlay.isPortal ? " [portal]" : "") + (bestPlay.remote ? " [remote]" : "") : "—"} · terdekat pin: ${nearest ? nearest.name + " (" + nearest.distance + "m)" : "—"}`,
        cctvs.length > 0 ? "SUCCESS" : "WARNING"
      );
      if (!options.silent) {
        fleet.emit("CCTV_SCAN_SUCCESS", {
          cctvs, nearest, bestPlay, total: cctvs.length,
          live: cctvs.filter(c => c.realPublic && !c.isPortal && (c.embed || c.hls || c.hlsAuto)).length,
          queryLat: lat, queryLng: lng, radius,
          bestPlayRemote: !!(bestPlay && bestPlay.remote)
        });
      }

      // [G7]+[M2] upgrade / forcePlay dari GPS-map
      const current = this._activeStreams.get("default");
      const hasRealActive = this._isActiveRealStream(current);
      if (bestPlay && !options.skipStream && (forcePlay || !hasRealActive)) {
        if (current && (current.openInNewTab || current.simulate)) {
          fleet.logGlobal(`🔄 [CCTV] Mengganti feed lama dengan stream real: ${bestPlay.name}`, "SUCCESS");
        }
        this._prepareStream(bestPlay, fleet, { force: forcePlay || !!current });
      } else if (bestPlay && !options.skipStream && hasRealActive) {
        fleet.logGlobal(`🎥 [CCTV] Stream real aktif dipertahankan`, "INFO");
      }

      return { cctvs, nearest, bestPlay, queryLat: lat, queryLng: lng, radius };
    } catch (err) {
      fleet.logGlobal(`❌ [CCTV] ${err.message}`, "DANGER");
      if (!options.silent) {
        const fallbackLive = this._liveEntries(lat, lng, {
          realMax: Infinity, portalMax: 80000, streamMax: Infinity
        });
        const cctvs = fallbackLive.slice();
        if (cctvs.length === 0) cctvs.push(...this._spawnSyntheticCCTV(lat, lng, 8, 2));
        // [G11] sort null-safe juga di fallback
        cctvs.sort((a, b) => distOf(a) - distOf(b));
        const nearest = cctvs[0];
        let bestPlay = this._pickProgressive(cctvs, lat, lng);
        if (!bestPlay) bestPlay = this._pickProgressive(cctvs, lat, lng, { includePortal: true });
        this._lastScan = { queryLat: lat, queryLng: lng, radius, cctvs, nearest, bestPlay, timestamp: U.iso() };
        fleet.emit("CCTV_SCAN_SUCCESS", {
          cctvs, nearest, bestPlay, total: cctvs.length,
          live: cctvs.filter(c => c.realPublic && !c.isPortal && (c.embed || c.hls || c.hlsAuto)).length,
          queryLat: lat, queryLng: lng, radius, fallback: true, overpassFailed: true,
          bestPlayRemote: !!(bestPlay && bestPlay.remote)
        });
        const realN = cctvs.filter(c => c.realPublic).length;
        fleet.logGlobal(
          realN > 0
            ? `[CCTV] Overpass gagal - ${realN} kamera live tetap dimuat (${cctvs.length} total)`
            : `[CCTV] Fallback: spawn ${cctvs.length} synthetic`, "WARNING");
        // [G11]+[M2] upgrade / forcePlay di fallback
        const current = this._activeStreams.get("default");
        const hasRealActive = this._isActiveRealStream(current);
        if (bestPlay && !options.skipStream && (forcePlay || !hasRealActive)) {
          if (current && (current.openInNewTab || current.simulate)) {
            fleet.logGlobal(`🔄 [CCTV] (fallback) Mengganti feed lama dengan stream real: ${bestPlay.name}`, "SUCCESS");
          }
          this._prepareStream(bestPlay, fleet, { force: forcePlay || !!current });
        }
        return { cctvs, nearest, bestPlay, queryLat: lat, queryLng: lng, radius, fallback: true };
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
      // [G6]+[M1] initial-pick progressive — prioritaskan stream real
      if (!this._activeStreams.has("default")) {
        const live0 = this._liveEntries(baseLat, baseLng, {
          realMax: Infinity, portalMax: 80000, streamMax: Infinity
        });
        let first = this._primePick(live0, baseLat, baseLng);
        if (!first) first = this._nearestLive(baseLat, baseLng, 50);
        if (!first) first = this._pickProgressive(live0, baseLat, baseLng, { includePortal: true });
        if (first) this._prepareStream(first, fleet, {
          substitute: !!(first.id && !live0.some(c => c.id === first.id))
        });
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
          live: part.filter(c => c.realPublic && !c.isPortal && (c.embed || c.hls || c.hlsAuto)).length,
          current: scanned, regions: list.length
        });
        if (scanned < list.length) await new Promise(r => setTimeout(r, 400));
      }

      const seen = new Set();
      const unique = [];
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

      for (const c of this._liveEntries(baseLat, baseLng, { realMax: Infinity, portalMax: Infinity, streamMax: Infinity })) {
        const key = String(c.id);
        if (seen.has(key)) {
          const prev = unique.find(u => String(u.id) === key);
          if (prev) {
            for (const k2 of Object.keys(c)) {
              if (c[k2] !== undefined && c[k2] !== null) prev[k2] = c[k2];
            }
          }
          continue;
        }
        seen.add(key);
        unique.push(c);
      }

      unique.sort((a, b) => distOf(a) - distOf(b));
      const nearest = unique[0] || null;

      // [M1] progressive multi — sama presisi dengan scanNearby/autoStream
      let bestPlay = this._pickProgressive(unique, baseLat, baseLng);
      if (!bestPlay) {
        const cand = unique
          .filter(c => !c.isPortal && (c.hls || c.embed || c.hlsAuto || c.streetsideId))
          .sort((a, b) => this._playabilityScore(b) - this._playabilityScore(a))[0] || null;
        if (cand) bestPlay = { ...cand, remote: true };
      }

      this._lastScan = {
        queryLat: baseLat, queryLng: baseLng,
        cctvs: unique, nearest, bestPlay, multiRegion: true, timestamp: U.iso()
      };

      fleet.emit("CCTV_SCAN_SUCCESS", {
        cctvs: unique, nearest, bestPlay, total: unique.length,
        live: unique.filter(c => c.realPublic && !c.isPortal && (c.embed || c.hls || c.hlsAuto)).length,
        queryLat: baseLat, queryLng: baseLng,
        radius: 5000, multiRegion: true,
        bestPlayRemote: !!(bestPlay && bestPlay.remote)
      });
      fleet.emit("MULTI_SCAN_COMPLETE", { total: unique.length, regions: list.length });

      // [G7] upgrade portal/synthetic → stream real
      const current = this._activeStreams.get("default");
      const hasRealActive = this._isActiveRealStream(current);
      if (bestPlay && !hasRealActive) {
        if (current && (current.openInNewTab || current.simulate)) {
          fleet.logGlobal(`🔄 [MULTI] Mengganti feed lama dengan stream real: ${bestPlay.name}`, "SUCCESS");
        }
        this._prepareStream(bestPlay, fleet, { force: !!current });
        const km = bestPlay.distance != null ? Math.round(bestPlay.distance / 1000) : null;
        const tag = bestPlay.isPortal ? " [portal]" : (bestPlay.remote ? " [remote]" : "");
        fleet.logGlobal(
          `📡 [MULTI] Feed terpilih: ${bestPlay.name}${km != null ? " ≈ " + km + " km" : ""}${tag}`,
          bestPlay.remote ? "WARNING" : "SUCCESS"
        );
      } else if (bestPlay && hasRealActive) {
        fleet.logGlobal(`🎥 [CCTV] Stream real aktif dipertahankan`, "INFO");
      } else if (!hasRealActive) {
        fleet.logGlobal("ℹ️ [MULTI] Tidak ada kandidat feed sama sekali.", "WARNING");
      }
      fleet.logGlobal(`✅ [MULTI] Selesai: ${unique.length} CCTV dari ${list.length} region`, "SUCCESS");

      return unique;
    } finally {
      this._scanInProgress = false;
    }
  },

  // [G3] SEMUA cabang kirim payload lengkap [C4]
  _prepareStream(cctv, fleet, opts = {}) {
    if (!cctv) return;
    if (!opts._streetsideResolved) this._prepSeq = (this._prepSeq || 0) + 1;
    const force = !!opts.force;
    const proxy = this.getProxyUrl();

    /* Skip host yang baru timeout (titik temu: antrean tidak macet di BaliTower mati) */
    const probeUrl = cctv.hls || cctv.hlsAuto || cctv.embed || "";
    const hostKey = cctv.hostKey || this._hostKeyFromUrl(probeUrl);
    if (hostKey && this.isHostFailed(hostKey) && !opts._ignoreHostFail) {
      fleet.logGlobal(`⏭️ [CCTV] Lewati ${cctv.name} — host ${hostKey} baru gagal`, "WARNING");
      fleet.emit("CCTV_STREAM_UNAVAILABLE", {
        cctv, cctvId: cctv.id, distance: cctv.distance,
        reason: "Host stream sedang tidak merespons (ditunda sementara)."
      });
      return;
    }

    /* softFail (BaliTower dsb): probe dulu; gagal → mark host + unavailable (kaskade cepat) */
    if (cctv.softFail && !opts._probed && (cctv.hls || cctv.hlsAuto || cctv.embed)) {
      const u = cctv.hls || cctv.hlsAuto || this._hlsFromEmbed(cctv.embed) || cctv.embed;
      const prepSeq = this._prepSeq;
      fleet.logGlobal(`🔎 [CCTV] Probe cepat: ${cctv.name}…`, "INFO");
      this.probePlayable(u, 4500).then(ok => {
        if (prepSeq !== this._prepSeq) return;
        if (!ok) {
          this.markHostFail(hostKey || u);
          fleet.emit("CCTV_STREAM_UNAVAILABLE", {
            cctv, cctvId: cctv.id, distance: cctv.distance,
            reason: "Probe gagal / timeout — mencoba kamera lain."
          });
          return;
        }
        this._prepareStream(cctv, fleet, Object.assign({}, opts, { force: true, _probed: true }));
      });
      return;
    }

    // ---------- Streetside HLS on-demand [S1] ----------
    if (cctv.streetsideId && !cctv.hls && !cctv.embed && !cctv.isPortal && !opts._streetsideResolved) {
      const prepSeq = this._prepSeq;   // [A8] resolve basi (kamera sudah diganti) dibuang
      fleet.logGlobal(`🔄 [CCTV] Resolve HLS Streetside -> ${cctv.name}...`, "INFO");
      this.resolveStreetsideHls(cctv).then(url => {
        if (prepSeq !== this._prepSeq) return;
        if (!url) {
          fleet.logGlobal(`⚠️ [CCTV] Streetside ${cctv.name}: HLS tidak ditemukan`, "WARNING");
          fleet.emit("CCTV_STREAM_UNAVAILABLE", {
            cctv, cctvId: cctv.id, distance: cctv.distance,
            reason: "HLS Streetside tidak tersedia untuk kamera ini."
          });
          return;
        }
        this._prepareStream(cctv, fleet, Object.assign({}, opts, { force: true, _streetsideResolved: true }));
      }).catch(e => {
        if (prepSeq !== this._prepSeq) return;
        fleet.logGlobal(`⚠️ [CCTV] Streetside resolve gagal: ${e && e.message}`, "WARNING");
        fleet.emit("CCTV_STREAM_UNAVAILABLE", {
          cctv, cctvId: cctv.id, distance: cctv.distance,
          reason: "Gagal mengambil stream Streetside: " + (e && e.message)
        });
      });
      return;
    }

    // ---------- EMBED dengan hlsAuto → prioritaskan HLS (generik putar real) ----------
    if (cctv.realPublic && cctv.embed && !cctv.isPortal && cctv.hlsAuto && !opts._embedOnly) {
      const streamUrl = cctv.hlsAuto;
      const streams = this._buildHlsStreams(streamUrl, proxy, !!cctv.noProxy);
      if (proxy && !cctv.noProxy) streams.push({ type: "embed", url: cctv.embed, proxied: this.proxify(cctv.embed) });
      streams.push({ type: "embed", url: cctv.embed, proxied: null });
      const hlsProxy = (streams.find(s => s.type === "hls" && s.proxied) || {}).proxied || null;
      const current = this._activeStreams.get("default");
      if (!force && current && current.url === streamUrl && !current.simulate) {
        current.cctv = cctv;
        fleet.emit("CCTV_STREAM_READY", {
          url: streamUrl, hlsProxy, proxyUrl: proxy,
          embed: cctv.embed, embedDirect: cctv.embed, hlsCandidate: streamUrl,
          noProxy: !!cctv.noProxy, streams,
          cctv, cctvId: cctv.id, distance: cctv.distance,
          simulate: false, hlsLive: true, realPublic: true, skipped: true,
          substitute: !!opts.substitute, requested: opts.requested || null,
          openInNewTab: false, portalInfo: false
        });
        return;
      }
      this._activeStreams.set("default", {
        url: streamUrl, embed: cctv.embed, cctv, simulate: false,
        substitute: !!opts.substitute
      });
      fleet.logGlobal(
        `🎥 [CCTV] HLS-EXTRACT -> ${cctv.name}${cctv.distance != null ? " (" + cctv.distance + "m)" : ""} · ${streamUrl.split("/").slice(-2).join("/")}${proxy ? " · proxy siap" : ""}`,
        "SUCCESS");
      fleet.emit("CCTV_STREAM_READY", {
        url: streamUrl, hlsProxy, proxyUrl: proxy,
        embed: cctv.embed, embedDirect: cctv.embed, hlsCandidate: streamUrl,
        noProxy: !!cctv.noProxy, streams,
        cctv, cctvId: cctv.id, distance: cctv.distance,
        simulate: false, hlsLive: true, realPublic: true,
        substitute: !!opts.substitute, requested: opts.requested || null,
        openInNewTab: false, portalInfo: false
      });
      return;
    }

    // ---------- EMBED murni ----------
    if (cctv.realPublic && cctv.embed && !cctv.isPortal) {
      const current = this._activeStreams.get("default");
      const embedProxy = (proxy && !cctv.noProxy) ? this.proxify(cctv.embed) : null;
      const hlsProxy   = (proxy && !cctv.noProxy && cctv.hlsAuto) ? this.proxify(cctv.hlsAuto) : null;
      const streams    = this._buildEmbedStreams(cctv, proxy);

      if (!force && current && current.embed === cctv.embed && !current.simulate) {
        current.cctv = { ...cctv };
        fleet.logGlobal(`🎥 [CCTV] Embed real sudah aktif -> ${cctv.name} (skip)`, "INFO");
        fleet.emit("CCTV_STREAM_READY", {
          url: null, embed: cctv.embed, embedDirect: cctv.embed,
          noProxy: !!cctv.noProxy, hlsCandidate: cctv.hlsAuto || null,
          hlsProxy, embedProxy, proxyUrl: proxy, streams,
          cctv: current.cctv, cctvId: cctv.id, distance: cctv.distance,
          simulate: false, realPublic: true, skipped: true,
          substitute: !!opts.substitute, requested: opts.requested || null,
          openInNewTab: false, portalInfo: false
        });
        return;
      }
      this._activeStreams.set("default", {
        url: null, embed: cctv.embed, cctv, simulate: false,
        realPublic: true, substitute: !!opts.substitute
      });
      fleet.logGlobal(
        `🎥 [CCTV] REAL PUBLIC -> ${cctv.name} (${cctv.distance}m)${opts.substitute ? " [pengganti pin]" : ""} (streams: ${streams.length})`,
        "SUCCESS");
      fleet.emit("CCTV_STREAM_READY", {
        url: null, embed: cctv.embed, embedDirect: cctv.embed,
        noProxy: !!cctv.noProxy, hlsCandidate: cctv.hlsAuto || null,
        hlsProxy, embedProxy, proxyUrl: proxy, streams,
        cctv, cctvId: cctv.id, distance: cctv.distance,
        simulate: false, realPublic: true,
        substitute: !!opts.substitute, requested: opts.requested || null,
        openInNewTab: false, portalInfo: false
      });
      return;
    }

    // ---------- HLS langsung (Batam / custom) ----------
    if (cctv.realPublic && cctv.hls && !cctv.embed && !cctv.isPortal) {
      const streamUrl = cctv.hls;
      const current = this._activeStreams.get("default");
      const streams = this._buildHlsStreams(streamUrl, proxy, !!cctv.noProxy);
      const hlsProxy = streams.find(s => s.proxied)?.proxied || null;
      if (!force && current && current.url === streamUrl && !current.simulate) {
        current.cctv = cctv;
        fleet.emit("CCTV_STREAM_READY", {
          url: streamUrl, hlsProxy, proxyUrl: proxy,
          embed: null, embedDirect: null, hlsCandidate: streamUrl,
          noProxy: !!cctv.noProxy, streams,
          cctv, cctvId: cctv.id, distance: cctv.distance,
          simulate: false, hlsLive: true, realPublic: true, skipped: true,
          substitute: !!opts.substitute, requested: opts.requested || null,
          openInNewTab: false, portalInfo: false
        });
        return;
      }
      this._activeStreams.set("default", {
        url: streamUrl, embed: null, cctv, simulate: false,
        substitute: !!opts.substitute
      });
      fleet.logGlobal(
        `🎥 [CCTV] HLS KAMERA -> ${cctv.name}${cctv.distance != null ? " (" + cctv.distance + "m)" : ""}${opts.substitute ? " [pengganti pin]" : ""}${cctv.remote ? " [remote]" : ""}`,
        "SUCCESS");
      fleet.emit("CCTV_STREAM_READY", {
        url: streamUrl, hlsProxy, proxyUrl: proxy,
        embed: null, embedDirect: null, hlsCandidate: streamUrl,
        noProxy: !!cctv.noProxy, streams,
        cctv, cctvId: cctv.id, distance: cctv.distance,
        simulate: false, hlsLive: true, realPublic: true,
        substitute: !!opts.substitute, requested: opts.requested || null,
        openInNewTab: false, portalInfo: false
      });
      return;
    }

    // ---------- pengganti pin: hanya ≤12 km (generik lokal, bukan loncat kota) ----------
    if (!cctv.isPortal && !cctv.embed && !cctv.hls && !cctv.hlsAuto && !cctv.streetsideId && !opts.noSubstitute) {
      const nearList = this._liveEntries(cctv.lat, cctv.lng, {
        realMax: 12000, portalMax: 0, streamMax: 12000
      });
      const near = this._pickProgressive(nearList, cctv.lat, cctv.lng);
      if (near && near.distance != null && near.distance <= 12000) {
        fleet.logGlobal(
          `🎥 [CCTV] ${cctv.name} pin tanpa feed → LIVE lokal: ${near.name} (${near.distance}m)`, "INFO");
        this._prepareStream(near, fleet, { force, substitute: true, requested: cctv });
        return;
      }
    }

    // ---------- PORTAL ----------
    if (cctv.isPortal && cctv.openInNewTab) {
      this._activeStreams.set("default", {
        url: null, embed: cctv.embed, cctv, simulate: false, openInNewTab: true
      });
      fleet.logGlobal(`🌐 [CCTV] Portal -> ${cctv.name} (buka tab baru)`, "INFO");
      fleet.emit("CCTV_STREAM_READY", {
        url: null, embed: cctv.embed, embedDirect: cctv.embed,
        noProxy: true, hlsCandidate: null, hlsProxy: null, embedProxy: null,
        proxyUrl: proxy,
        streams: [{ type: "embed", url: cctv.embed, proxied: null, openInNewTab: true }],
        cctv, cctvId: cctv.id, distance: cctv.distance,
        simulate: false, realPublic: true,
        openInNewTab: true, portalInfo: true,
        substitute: false, requested: null
      });
      return;
    }

    fleet.logGlobal(`⚠️ [CCTV] ${cctv.name || cctv.id}: tidak ada feed publik yang dapat diputar`, "WARNING");
    fleet.emit("CCTV_STREAM_UNAVAILABLE", {
      cctv, cctvId: cctv.id, distance: cctv.distance,
      reason: "Tidak ada URL feed publik yang terhubung ke kamera ini."
    });
  },

  playCCTV(cctv) {
    const fleet = global.CGO_Fleet;
    if (!fleet || !cctv) return;
    fleet.logGlobal(`🎥 [CCTV] Beralih -> ${cctv.name}`, "INFO");
    /* [A2] pilihan manual/tour: bila kamera ada di antrean akses, kaskade lanjut dari sini */
    const q = this._accessQueue;
    if (q) {
      const inQ = cctv.id != null && q.cams.has(String(cctv.id));
      q.currentId = inQ ? String(cctv.id) : null;
      if (inQ) q.attempts = 0;
    }
    this._prepareStream(cctv, fleet, { force: true });
  },

  clearStream() {
    this._activeStreams.clear();
    if (this._accessQueue) this._accessQueue.currentId = null;
  },
  getLastScan() { return this._lastScan; },
  getActiveStream() {
    const s = this._activeStreams.get("default");
    return s ? s.url : null;
  },

  getPlayableCandidates(lat, lng, maxKm = Infinity) {
    const list = this._liveEntries(lat, lng, { realMax: Infinity, portalMax: Infinity, streamMax: Infinity });
    const filtered = list.filter(c => {
      if (!c) return false;
      if (c.isPortal) return false;
      if (!(c.hls || c.embed || c.hlsAuto || c.streetsideId)) return false;
      if (maxKm !== Infinity && c.distance != null && c.distance > maxKm * 1000) return false;
      return true;
    });
    return filtered.sort((a, b) => {
      const sa = this._playabilityScore(a), sb = this._playabilityScore(b);
      if (sb !== sa) return sb - sa;
      return distOf(a) - distOf(b);
    });
  },


  // ==========================================================================
  // [A1–A5] MULTI AUTO ACCESS — klik GPS / titik peta
  // ==========================================================================
  ACCESS_DEFAULTS: { radius: 10000, localKm: 40, maxTries: 8 },
  _accessSeq: 0,
  _accessQueue: null,

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); },
  async _waitUntil(busyFn, maxMs, stepMs = 120) {
    const t0 = Date.now();
    while (busyFn()) {
      if (Date.now() - t0 >= maxMs) return false;
      await this._sleep(stepMs);
    }
    return true;
  },
  _camHost(c) {
    try { return new URL(c.hlsAuto || c.hls || c.embed).hostname.toLowerCase(); } catch (_) { return ""; }
  },

  /* Antrean: terdekat dulu; jaringan privat/VPN (jarang bisa diputar dari luar LAN) paling akhir */
  _buildAccessQueue(playable, maxTries) {
    const sorted = playable.slice().sort((a, b) => distOf(a) - distOf(b));
    const seenUrl = new Set(), pub = [], lan = [];
    for (const c of sorted) {
      const key = c.hls || c.hlsAuto || c.embed || (c.streetsideId != null ? "SS-" + c.streetsideId : null);
      if (!key || seenUrl.has(key)) continue;
      seenUrl.add(key);
      (c.accessType === "private" || c.accessType === "vpn" ? lan : pub).push(c);
    }
    const list = pub.concat(lan).slice(0, 30);
    const cams = new Map();
    for (const c of list) cams.set(String(c.id), c);
    return {
      ids: list.map(c => String(c.id)), cams,
      tried: new Set(), blockedHosts: new Set(),
      currentId: null, maxTries, attempts: 0, skipped: 0
    };
  },

  getAccessQueue() {
    const q = this._accessQueue;
    if (!q) return null;
    return {
      ids: q.ids.slice(), currentId: q.currentId, tried: Array.from(q.tried),
      attempts: q.attempts, maxTries: q.maxTries, skipped: q.skipped,
      blockedHosts: Array.from(q.blockedHosts),
      cams: q.ids.map(id => q.cams.get(id))
    };
  },
  cancelAccess() {
    this._accessSeq++;
    this._accessQueue = null;
  },

  /* Dipanggil UI saat kamera aktif gagal tayang → pindah ke kamera terdekat berikutnya */
  advanceAccess(failed, reason) {
    const fleet = global.CGO_Fleet, q = this._accessQueue;
    if (!fleet || !q || !failed || failed.id == null || q.currentId == null) return null;
    if (String(failed.id) !== String(q.currentId)) return null;
    const why = String(reason || "gagal");
    q.tried.add(String(failed.id));
    if (!this.getProxyUrl() && /cors|diblokir|proxy/i.test(why)) {
      const h = this._camHost(failed);
      if (h) q.blockedHosts.add(h);
    }
    const exhaust = (msg) => {
      q.currentId = null;
      fleet.logGlobal(`⚠️ [AKSES] ${msg}`, "WARNING");
      fleet.emit("CCTV_ACCESS_EXHAUSTED", {
        tried: q.tried.size, total: q.ids.length, skipped: q.skipped,
        blockedHosts: Array.from(q.blockedHosts), reason: why, proxy: !!this.getProxyUrl()
      });
      return null;
    };
    if (q.attempts >= q.maxTries) return exhaust(`Batas ${q.maxTries} percobaan tercapai`);
    let next = null;
    for (const id of q.ids) {
      if (q.tried.has(id)) continue;
      const c = q.cams.get(id);
      if (q.blockedHosts.size && q.blockedHosts.has(this._camHost(c))) {
        q.tried.add(id); q.skipped++;
        continue;
      }
      next = c; break;
    }
    if (!next) return exhaust(`Tidak ada kamera lain di sekitar titik (${q.tried.size - q.skipped} dicoba, ${q.skipped} dilewati)`);
    q.currentId = String(next.id);
    q.attempts++;
    fleet.logGlobal(
      `🔁 [AKSES] ${failed.name || failed.id} gagal (${why}) -> mencoba ${next.name} (${next.distance}m) [${q.attempts}/${q.maxTries}]`,
      "WARNING");
    fleet.emit("CCTV_ACCESS_ADVANCE", {
      from: failed, to: next, reason: why, attempt: q.attempts, max: q.maxTries, skipped: q.skipped
    });
    this._prepareStream(next, fleet, { force: true });
    return next;
  },

  async accessAround(lat, lng, options = {}) {
    const fleet = global.CGO_Fleet;
    if (!fleet) return null;
    lat = Number(lat); lng = Number(lng);
    if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      fleet.logGlobal("❌ [AKSES] Koordinat tidak valid", "DANGER");
      return null;
    }
    const D = this.ACCESS_DEFAULTS;
    const radius = U.clamp(Number(options.radius) || D.radius, 500, 25000);
    const localKm = U.clamp(Number(options.localKm) || D.localKm, 1, 500);
    const maxTries = U.clamp(Math.floor(Number(options.maxTries) || D.maxTries), 1, 20);
    const source = String(options.source || "titik");
    const seq = ++this._accessSeq;
    const alive = () => seq === this._accessSeq;
    const t0 = Date.now();

    fleet.emit("CCTV_ACCESS_START", { lat, lng, radius, localKm, source, seq });
    fleet.logGlobal(
      `🛰️ [AKSES·GENERIK] ${source.toUpperCase()} ${lat.toFixed(5)}, ${lng.toFixed(5)} · pin r=${radius}m · feed ≤ ${localKm} km`,
      "INFO"
    );

    /* OSM + katalog paralel — PIN di sekitar GPS adalah lapisan utama */
    const catalogP = Promise.race([this.ensureCatalog(), this._sleep(2000)]).catch(() => null);

    const startOsm = async () => {
      if (!alive()) return { pins: null, pinsError: "dibatalkan" };
      const busy = () => this._scanInProgress || IPScanner.isBusy();
      if (busy()) {
        let free = await this._waitUntil(busy, 2500);
        if (!free && alive()) { IPScanner.cancel(); free = await this._waitUntil(busy, 4000); }
      }
      if (!alive()) return { pins: null, pinsError: "dibatalkan" };
      if (busy()) return { pins: null, pinsError: "scanner sibuk" };
      this._scanInProgress = true;
      try {
        const res = await this.scanNearby(lat, lng, radius, {
          allowConcurrent: true, silent: true, skipStream: true
        });
        if (res && res.cctvs) return { pins: res.cctvs, pinsError: null };
        return { pins: null, pinsError: "Overpass gagal" };
      } catch (e) {
        return { pins: null, pinsError: (e && e.message) || "Overpass gagal" };
      } finally { this._scanInProgress = false; }
    };
    const pinsPromise = startOsm();

    try { await catalogP; } catch (_) {}
    if (!alive()) return null;

    /* Feed hardcode/katalog HANYA dalam localKm — bukan loncat ke Batam/Bali jauh */
    const local = this._liveEntries(lat, lng, {
      realMax: localKm * 1000,
      portalMax: Math.min(localKm * 1000, 60000),
      streamMax: localKm * 1000
    });
    const playable = local.filter(c =>
      !c.isPortal && (c.hls || c.embed || c.hlsAuto || c.streetsideId) && c.distance != null
    );
    const queue = this._buildAccessQueue(playable, maxTries);
    this._accessQueue = queue;

    fleet.emit("CCTV_SCAN_PROGRESSIVE", {
      cctvs: local, total: local.length, live: playable.length,
      current: 0, regions: 1, access: true, queryLat: lat, queryLng: lng
    });

    let started = null;
    if (queue.ids.length) {
      started = queue.cams.get(queue.ids[0]);
      queue.currentId = queue.ids[0];
      queue.attempts = 1;
      fleet.logGlobal(
        `🎥 [AKSES] LIVE lokal: ${started.name} (${started.distance}m) · ${queue.ids.length} kandidat ≤ ${localKm} km`,
        "SUCCESS"
      );
      this._prepareStream(started, fleet, { force: true });
    } else {
      fleet.logGlobal(
        `ℹ️ [AKSES] Belum ada feed LIVE ≤ ${localKm} km — menunggu pin OSM di radius ${radius}m (tanpa memaksa Batam/Bali)`,
        "WARNING"
      );
      fleet.emit("CCTV_ACCESS_NOLOCAL", { lat, lng, localKm });
      /* Jangan autoStream ke kota jauh di sini; biarkan pin OSM dulu */
    }

    const osm = await pinsPromise;
    if (!alive()) return null;
    let pins = (osm && osm.pins) || null;
    const pinsError = osm && osm.pinsError;

    if (pins && pins.length) {
      this._linkNearbyLiveFeeds(pins, local, 450);
    }

    const merged = new Map();
    /* Urutan: pin OSM dulu (generik), lalu katalog lokal */
    for (const c of (pins || [])) {
      if (c.synthetic) continue;
      merged.set(String(c.id), c);
    }
    for (const c of local) {
      const k = String(c.id);
      if (!merged.has(k)) merged.set(k, c);
      else {
        const prev = merged.get(k);
        for (const key of ["hls", "hlsAuto", "embed", "streetsideId", "realPublic", "accessType", "noProxy"]) {
          if (c[key] != null && c[key] !== "" && (prev[key] == null || prev[key] === "")) prev[key] = c[key];
        }
      }
    }

    let cctvs = Array.from(merged.values());
    if (cctvs.length === 0) {
      fleet.logGlobal("[AKSES] Radius kosong → 6 pin simulasi (bukan feed kota lain)", "WARNING");
      cctvs = this._spawnSyntheticCCTV(lat, lng, 6, 2);
    }
    cctvs.sort((a, b) => distOf(a) - distOf(b));

    /* Mulai putar bila belum: LIVE tertaut di pin, atau progressive murni lokal */
    if (!started) {
      const linked = cctvs.filter(c =>
        !c.isPortal && (c.hls || c.embed || c.hlsAuto || c.streetsideId) &&
        c.distance != null && c.distance <= localKm * 1000
      );
      if (linked.length) {
        const q2 = this._buildAccessQueue(linked, maxTries);
        this._accessQueue = q2;
        started = q2.cams.get(q2.ids[0]);
        q2.currentId = q2.ids[0];
        q2.attempts = 1;
        fleet.logGlobal(
          `🎥 [AKSES] LIVE dari pin/tautan lokal: ${started.name} (${started.distance}m)`,
          "SUCCESS"
        );
        this._prepareStream(started, fleet, { force: true });
      }
    }

    const nearest = cctvs[0] || null;
    const bestPlay = started || this._pickProgressive(
      cctvs.filter(c => c.distance == null || c.distance <= localKm * 1000),
      lat, lng
    ) || null;
    const liveN = cctvs.filter(c =>
      c.realPublic && !c.isPortal && (c.embed || c.hls || c.hlsAuto || c.streetsideId)
    ).length;
    const osmN = cctvs.filter(c => c.fromOSM || (c.id && String(c.id).indexOf("OSM-") === 0)).length;
    const qIds = (this._accessQueue && this._accessQueue.ids) ? this._accessQueue.ids.slice() : [];

    this._lastScan = {
      queryLat: lat, queryLng: lng, radius, cctvs, nearest, bestPlay,
      access: true, generic: true, timestamp: U.iso()
    };

    fleet.emit("CCTV_SCAN_SUCCESS", {
      cctvs, nearest, bestPlay, total: cctvs.length, live: liveN,
      queryLat: lat, queryLng: lng, radius, access: true, localKm,
      candidates: qIds.length, pinsError, source, osmPins: osmN,
      bestPlayRemote: !!(bestPlay && bestPlay.remote),
      generic: true
    });
    const ms = Date.now() - t0;
    fleet.emit("CCTV_ACCESS_DONE", {
      total: cctvs.length, live: liveN, candidates: qIds.length,
      pinsOk: !pinsError, pinsError, ms, source, osmPins: osmN, generic: true
    });
    fleet.logGlobal(
      `✅ [AKSES·GENERIK] ${cctvs.length} titik · ${liveN} LIVE · OSM ${osmN}` +
      (pinsError ? " · pin: " + pinsError : "") + ` · ${ms}ms`,
      "SUCCESS"
    );
    return {
      cctvs, nearest, bestPlay, queryLat: lat, queryLng: lng, radius,
      queue: qIds, pinsError, osmPins: osmN, generic: true
    };
  },


  autoStream(lat, lng) {
    const fleet = global.CGO_Fleet;
    if (!fleet) return null;
    /* Progressive generik: hanya perluas bertahap; Batam hanya jika GPS dekat Batam */
    const all = this._liveEntries(lat, lng, {
      realMax: Infinity, portalMax: Infinity, streamMax: Infinity
    });
    let pick = this._pickProgressive(all, lat, lng);
    if (pick && pick.distance != null && pick.distance > 80000) {
      /* terlalu jauh — coba portal regional ≤120 km dulu */
      const portal = all
        .filter(c => c.isPortal && c.distance != null && c.distance <= 120000)
        .sort((a, b) => distOf(a) - distOf(b))[0];
      if (portal) pick = portal;
    }
    if ((!pick || (pick.distance != null && pick.distance > 80000)) && this.BATAM_STREAM_DEFAULT) {
      const dBatam = this.calculateDistance(lat, lng, 1.13, 104.03);
      if (dBatam <= 80000) {
        const batam = this.getPlayableCandidates(lat, lng, 80)
          .find(c => c.hls && /matanya\.batam\.go\.id/i.test(c.hls));
        if (batam) pick = batam;
      }
    }
    if (!pick) {
      const cand = this.getPlayableCandidates(lat, lng, 40)[0] || null;
      if (cand) pick = cand;
    }
    if (!pick) return null;
    if (pick.distance != null && pick.distance > 50000) pick = { ...pick, remote: true };
    this._prepareStream(pick, fleet, { force: true });
    return pick;
  },


  async diagnoseCCTV() {
    const fleet = global.CGO_Fleet;
    const proxy = this.getProxyUrl();
    const proxyOk = proxy ? await this.checkProxy(true) : false;
    const testUrls = [
      ...this.REAL_PUBLIC_CAMS.map(c => ({ name: c.name, type: c.hls ? "HLS" : (c.noProxy ? "YouTube" : "BaliTower"), url: c.hls || this._hlsFromEmbed(c.embed) || c.embed, noProxy: !!c.noProxy })),
      ...this.PUBLIC_STREAMS.map((s, i) => {
        if (typeof s === "string") return { name: `HLS-${i + 1}`, type: "HLS", url: s };
        return { name: s.name || `HLS-${i + 1}`, type: "HLS", url: s.hls };
      }),
      ...this.REGION_PORTALS.map(p => ({ name: p.name, type: "Portal", url: p.url }))
    ];

    const head = proxy
      ? { name: "CGO Proxy", type: "Proxy", url: proxy + "/health",
          status: proxyOk ? "OK" : "FAIL: proxy tidak merespons", detail: proxy }
      : { name: "CGO Proxy", type: "Proxy", url: "-",
          status: "UNKNOWN: proxy belum diatur", detail: "isi alamat proxy di panel CCTV" };

    const testOne = async (t) => {
      let status = "UNKNOWN", detail = "";
      if (t.noProxy) return { ...t, status: "UNKNOWN: tidak lewat proxy", detail };
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
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 8000);
          try {
            const res = await fetch(t.url, { method: "GET", mode: "cors", signal: ctrl.signal });
            try { if (res.body && res.body.cancel) res.body.cancel(); } catch (_) {}
            if (res.ok) { status = "OK"; detail = "HLS langsung bisa (CORS diizinkan)"; }
            else status = "FAIL: HTTP " + res.status;
          } finally { clearTimeout(timer); }
        } else {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 8000);
          try {
            await fetch(t.url, { method: "GET", mode: "no-cors", signal: ctrl.signal });
          } finally { clearTimeout(timer); }
          status = "UNKNOWN: terjangkau (butuh proxy untuk verifikasi)";
        }
      } catch (e) {
        status = "FAIL: " + (e && e.name === "AbortError" ? "timeout" : (e && e.message));
        if (/\.m3u8(\?|$)/i.test(t.url) && !proxyOk) detail = "diblokir CORS/jaringan - butuh proxy";
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
      if (d.isDeployed && d.triggerTsunamiAlert()) n++;
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
      this.logGlobal(`Formasi swarm -> ${name.toUpperCase()}`, "INFO");
    }
    return ok;
  },

  scanCCTV(lat, lng, radius = 5000) {
    return CCTVEngine.scanNearby(lat, lng, radius);
  },
  scanMultiCCTV(lat, lng, regions) {
    return CCTVEngine.scanMultiRegion(lat, lng, regions);
  },
  accessCCTV(lat, lng, opts) { return CCTVEngine.accessAround(lat, lng, opts); },
  advanceAccess(cam, reason) { return CCTVEngine.advanceAccess(cam, reason); },
  getAccessQueue() { return CCTVEngine.getAccessQueue(); },
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
    this.logGlobal(`Kecepatan simulasi -> ${this._speedMultiplier}x`, "INFO");
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
    CCTVEngine.cancelAccess();
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
  getStreamUrls: () => CCTVEngine.getStreamUrls(),
  detectIP: () => IPScanner.detectIP(),
  rotateMirror: () => IPScanner.nextMirror(),
  getIPStatus: () => IPScanner.getStatus(),
  setCORSProxies: (list) => { IPScanner.CORS_PROXIES = Array.isArray(list) ? list.slice() : []; },
  spawnSynthetic: (lat, lng, n) => CCTVEngine._spawnSyntheticCCTV(lat, lng, n || 10),
  diagnoseCCTV: () => CCTVEngine.diagnoseCCTV(),
  setProxyUrl: (url) => CCTVEngine.setProxyUrl(url),
  getProxyUrl: () => CCTVEngine.getProxyUrl(),
  checkProxy: (force) => CCTVEngine.checkProxy(force),
  autoStream: (lat, lng) => CCTVEngine.autoStream(lat, lng),
  accessAround: (lat, lng, opts) => CCTVEngine.accessAround(lat, lng, opts),
  advanceAccess: (cam, reason) => CCTVEngine.advanceAccess(cam, reason),
  getAccessQueue: () => CCTVEngine.getAccessQueue(),
  getProxyInfo: () => CCTVEngine.getProxyInfo(),
  getPlayableCandidates: (lat, lng, maxKm) => CCTVEngine.getPlayableCandidates(lat, lng, maxKm),
  // bonus debug helper
  getActiveStream: () => {
    const s = CCTVEngine._activeStreams.get("default");
    return s ? { ...s } : null;
  },
  isActiveRealStream: () => CCTVEngine._isActiveRealStream(CCTVEngine._activeStreams.get("default"))
};

console.info(`[CGO Fleet] v${VERSION} — Kalibrasi nyata: probe+host-block · stream terverifikasi · GPS generik`);

})(typeof window !== "undefined" ? window : globalThis);
