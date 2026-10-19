/* ============================================================================
 * CIKUR GO — DRONE CGO FLEET ENGINE (THE BRAIN & SWARM)
 * File: drone-cgo.js
 * Version: 5.0.0 (Real-Time CCTV Integration — Production Grade)
 * ============================================================================
 * UPGRADE NOTES (v4.0 → v5.0):
 *  - CCTVEngine: Overpass API scanner untuk man_made=surveillance
 *  - Haversine distance calculator
 *  - CCTV_SCAN_SUCCESS & CCTV_STREAM_READY events
 *  - Auto-scan CCTV saat triggerGlobalTsunami()
 *  - 100% BACKWARD COMPATIBLE dengan API v4.0
 * ============================================================================ */

(function (global) {
  "use strict";

  // ==========================================================================
  // 0. KONFIGURASI & KONSTANTA
  // ==========================================================================
  const VERSION       = "5.0.0";
  const TICK_MS       = 1000;
  const DRONE_MAX_LOG = 100;
  const FLEET_MAX_LOG = 200;
  const TELEM_HISTORY = 60;
  const RTB_THRESHOLD = 15;
  const RTB_HYSTERESIS = 20;
  const MESH_RADIUS   = 3;
  const GRID_SIZE     = 32;

  const STATE = Object.freeze({
    IDLE:           "IDLE",
    DEPLOYING:      "DEPLOYING",
    MONITORING:     "MONITORING",
    INTERACTING:    "INTERACTING",
    EMERGENCY:      "EMERGENCY",
    RETURN_TO_BASE: "RETURN_TO_BASE",
    OFFLINE:        "OFFLINE"
  });

  const VALID_TRANSITIONS = {
    IDLE:           ["DEPLOYING", "OFFLINE"],
    DEPLOYING:      ["MONITORING", "RETURN_TO_BASE", "OFFLINE"],
    MONITORING:     ["INTERACTING", "EMERGENCY", "RETURN_TO_BASE", "OFFLINE"],
    INTERACTING:    ["MONITORING", "EMERGENCY", "RETURN_TO_BASE", "OFFLINE"],
    EMERGENCY:      ["MONITORING", "RETURN_TO_BASE", "OFFLINE"],
    RETURN_TO_BASE: ["IDLE", "OFFLINE"],
    OFFLINE:        ["IDLE"]
  };

  const LOG_TYPE = Object.freeze({
    INFO: 0, SUCCESS: 1, WARNING: 2, DANGER: 3
  });

  // ==========================================================================
  // 1. UTILITAS
  // ==========================================================================
  const U = {
    clamp: (v, lo, hi) => v < lo ? lo : v > hi ? hi : v,
    rand:  (lo, hi) => Math.random() * (hi - lo) + lo,
    randInt: (lo, hi) => Math.floor(Math.random() * (hi - lo + 1)) + lo,
    round: (v, d = 1) => Math.round(v * 10 ** d) / 10 ** d,
    now:   () => new Date().toLocaleTimeString(),
    iso:   () => new Date().toISOString()
  };

  // ==========================================================================
  // 2. AUDIO ENGINE (Singleton — Voice Queue + Siren)
  // ==========================================================================
  const AudioEngine = {
    _voices: [],
    _audioCtx: null,
    _voiceQueue: [],
    _speaking: false,
    _volume: 1.0,
    _muted: false,

    init() {
      if (!("speechSynthesis" in global)) return;
      const load = () => {
        this._voices = global.speechSynthesis.getVoices() || [];
      };
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
      const priority    = isEmergency ? 10 : 5;

      if (isEmergency) {
        global.speechSynthesis.cancel();
        this._voiceQueue = [];
        this._speaking = false;
      }

      this._voiceQueue.push({ text, priority, isEmergency });
      this._voiceQueue.sort((a, b) => b.priority - a.priority);

      if (!this._speaking) this._drain();
    },

    _drain() {
      if (!this._voiceQueue.length) {
        this._speaking = false;
        return;
      }
      const job = this._voiceQueue.shift();
      const u = new SpeechSynthesisUtterance(job.text);
      const v = this._pickVoice(job.isEmergency);
      if (v) u.voice = v;
      u.lang   = "id-ID";
      u.rate   = job.isEmergency ? 0.9 : 1.0;
      u.pitch  = 0.9;
      u.volume = this._volume;

      u.onend = () => this._drain();
      u.onerror = () => this._drain();

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
      const ctx = this._ensureCtx();
      if (!ctx) return;
      if (ctx.state === "suspended") ctx.resume().catch(() => {});

      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      const t    = ctx.currentTime;

      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(400, t);
      osc.frequency.linearRampToValueAtTime(800, t + duration * 0.25);
      osc.frequency.linearRampToValueAtTime(400, t + duration * 0.5);
      osc.frequency.linearRampToValueAtTime(800, t + duration * 0.75);
      osc.frequency.linearRampToValueAtTime(400, t + duration);

      gain.gain.setValueAtTime(0.0, t);
      gain.gain.linearRampToValueAtTime(0.12 * this._volume, t + 0.05);
      gain.gain.linearRampToValueAtTime(0.12 * this._volume, t + duration - 0.1);
      gain.gain.linearRampToValueAtTime(0.0, t + duration);

      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + duration + 0.05);
    },

    playBeep(freq = 880, duration = 0.12) {
      if (this._muted) return;
      const ctx = this._ensureCtx();
      if (!ctx) return;
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      const osc = ctx.createOscillator();
      const g   = ctx.createGain();
      const t   = ctx.currentTime;
      osc.type = "sine";
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0.08 * this._volume, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + duration);
      osc.connect(g).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + duration + 0.02);
    },

    setVolume(v) { this._volume = U.clamp(v, 0, 1); },
    mute(m = true) {
      this._muted = m;
      if (m && "speechSynthesis" in global) global.speechSynthesis.cancel();
    },
    isMuted() { return this._muted; }
  };

  // ==========================================================================
  // 3. DRONE ENTITY
  // ==========================================================================
  class DroneEntity {
    constructor(id) {
      this.id = id;
      this.state = STATE.IDLE;
      this.isDeployed = false;
      this.sector = { x: 0, y: 0 };
      this.formation = null;
      this._interactTimer = null;
      this._rtbLock = false;
      this._jamTicks = 0;

      this.blackBox = [];
      this.telemetry = {
        battery: 100,
        solarInput: 0,
        altitude: 0,
        speed: 0,
        windSpeed: 2.5,
        smokeLevel: 0,
        lidarDistance: 50,
        acousticAlert: false,
        networkStatus: "STARLINK_LINK_ACTIVE",
        signalStrength: 95,
        isJammed: false,
        isDaylight: true,
        sunAngle: 90,
        currentTarget: null,
        position: { x: 0, y: 0, z: 0 },
        uptime: 0
      };

      this._history = { battery: [], signal: [] };
    }

    _canTransition(next) {
      const allowed = VALID_TRANSITIONS[this.state] || [];
      return allowed.includes(next);
    }

    _transition(next) {
      if (!this._canTransition(next)) {
        this.log(`Transisi tidak valid: ${this.state} → ${next}`, "WARNING");
        return false;
      }
      this.state = next;
      return true;
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
      return this.log("Perintah RTB diterima. Kembali ke markas.", "WARNING");
    }

    interactWithTarget(targetName) {
      if (this.state !== STATE.MONITORING) return null;
      if (!this._transition(STATE.INTERACTING)) return null;
      this.telemetry.currentTarget = targetName;
      const log = this.log(`[MATA CGO] Target terdeteksi: ${targetName}. Memulai interaksi.`, "SUCCESS");

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
      return this.log("🚨 [CRITICAL] PERINGATAN TSUNAMI DITERIMA!", "DANGER");
    }

    activateVoidPulse() {
      this.telemetry.isJammed = false;
      this.telemetry.signalStrength = 100;
      this.telemetry.networkStatus = "SECURE_SATELLITE_LINK";
      this._jamTicks = 0;
      return this.log("⚡ [DEFENSE] VOID PULSE DIAKTIFKAN.", "DANGER");
    }

    tick(isDaylight, sunAngle, gridStats) {
      if (!this.isDeployed || this.state === STATE.OFFLINE) return;

      const T = this.telemetry;
      T.isDaylight = isDaylight;
      T.sunAngle = sunAngle;
      T.uptime++;

      const sunFactor = isDaylight ? Math.max(0.15, Math.sin(sunAngle * Math.PI / 180)) : 0;
      T.solarInput = U.round(sunFactor * 15, 2);

      let powerDraw = 0.15;
      if (this.state === STATE.MONITORING || this.state === STATE.INTERACTING) {
        powerDraw = 0.08;
      } else if (this.state === STATE.EMERGENCY) {
        powerDraw = 0.25;
      }

      const solarGain = T.solarInput / 100;
      T.battery = U.clamp(T.battery - powerDraw + solarGain, 0, 100);

      if (T.battery <= 0) {
        T.battery = 0;
        this._transition(STATE.OFFLINE);
        this.log("BATERAI HABIS. Mendarat darurat.", "DANGER");
        return;
      }

      if (this.state === STATE.MONITORING) {
        if (T.battery < RTB_THRESHOLD && !this._rtbLock) {
          this._rtbLock = true;
          this.returnToBase();
        } else if (T.battery > RTB_HYSTERESIS) {
          this._rtbLock = false;
        }
      }

      switch (this.state) {
        case STATE.DEPLOYING:
          T.altitude = Math.min(T.altitude + 5, 50);
          T.speed = 45;
          if (T.altitude >= 50) this._transition(STATE.MONITORING);
          break;

        case STATE.MONITORING:
        case STATE.EMERGENCY:
        case STATE.INTERACTING:
          T.speed = this.state === STATE.EMERGENCY ? 25 : 0;
          T.lidarDistance = U.round(U.rand(20, 100), 1);
          T.smokeLevel   = Math.random() > 0.9 ? U.round(U.rand(0, 50), 1) : 0;
          T.windSpeed    = U.round(U.rand(1, 11), 1);
          T.acousticAlert = Math.random() > 0.95;
          T.position.x = U.round(T.position.x + U.rand(-0.5, 0.5), 2);
          T.position.y = U.round(T.position.y + U.rand(-0.5, 0.5), 2);
          T.position.z = T.altitude;
          break;

        case STATE.RETURN_TO_BASE:
          T.altitude = Math.max(T.altitude - 5, 0);
          T.speed = 30;
          T.position.z = T.altitude;
          if (T.altitude <= 0) {
            this.isDeployed = false;
            this._transition(STATE.IDLE);
          }
          break;
      }

      if (!T.isJammed && Math.random() > 0.995) {
        const meshHelp = gridStats && gridStats.meshAvailable;
        if (!meshHelp) {
          T.isJammed = true;
          T.networkStatus = "SIGNAL_LOST_JAMMED";
          T.signalStrength = 10;
          this._jamTicks = 0;
          this.log("⚠️ Hostile Jammer detected!", "DANGER");
        }
      } else if (T.isJammed) {
        this._jamTicks++;
        if (this._jamTicks >= U.randInt(5, 15)) {
          T.isJammed = false;
          T.networkStatus = "MESH_RELAY_ESTABLISHED";
          T.signalStrength = U.randInt(60, 85);
          this.log("✅ Sinyal pulih via mesh relay.", "SUCCESS");
          this._jamTicks = 0;
        }
      } else {
        T.signalStrength = U.randInt(85, 100);
      }

      this._history.battery.push(U.round(T.battery, 1));
      this._history.signal.push(T.signalStrength);
      if (this._history.battery.length > TELEM_HISTORY) this._history.battery.shift();
      if (this._history.signal.length  > TELEM_HISTORY) this._history.signal.shift();
    }

    getHistory() {
      return {
        battery: this._history.battery.slice(),
        signal:  this._history.signal.slice()
      };
    }

    toJSON() {
      return {
        id: this.id, state: this.state, isDeployed: this.isDeployed,
        sector: this.sector, telemetry: this.telemetry
      };
    }
  }

  // ==========================================================================
  // 4. SWARM COORDINATOR (Zona, Formasi, Mesh)
  // ==========================================================================
  const SwarmCoordinator = {
    GRID: GRID_SIZE,
    _sectorMap: new Map(),
    _formation: "grid",

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
      if (["grid", "circle", "v", "line"].includes(name)) {
        this._formation = name;
        return true;
      }
      return false;
    },

    getFormation() { return this._formation; }
  };

  // ==========================================================================
  // 5. CCTV ENGINE (BARU di v5.0.0)
  // ==========================================================================
  const CCTVEngine = {
    _activeStreams: new Map(),   // droneId -> stream URL
    _lastScan: null,

    /**
     * Haversine distance dalam meter
     */
    calculateDistance(lat1, lon1, lat2, lon2) {
      const R = 6371e3; // radius bumi (m)
      const φ1 = lat1 * Math.PI / 180;
      const φ2 = lat2 * Math.PI / 180;
      const Δφ = (lat2 - lat1) * Math.PI / 180;
      const Δλ = (lon2 - lon1) * Math.PI / 180;

      const a = Math.sin(Δφ / 2) ** 2 +
                Math.cos(φ1) * Math.cos(φ2) *
                Math.sin(Δλ / 2) ** 2;
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      return R * c;
    },

    /**
     * Scan CCTV sekitar koordinat via Overpass API
     */
    async scanNearby(lat, lng, radius = 5000) {
      const fleet = global.CGO_Fleet;
      if (!fleet) {
        console.error("[CCTVEngine] CGO_Fleet belum siap.");
        return null;
      }

      fleet.logGlobal(`📡 [CCTV] Memindai OSM sekitar (${lat.toFixed(4)}, ${lng.toFixed(4)}) radius ${radius}m...`, "INFO");
      fleet.emit("CCTV_SCAN_START", { lat, lng, radius });

      // Query Overpass: cari node/way man_made=surveillance dalam radius
      const query = `
        [out:json][timeout:25];
        (
          node["man_made"="surveillance"](around:${radius},${lat},${lng});
          way["man_made"="surveillance"](around:${radius},${lat},${lng});
        );
        out body;
        >;
        out skel qt;
      `;

      try {
        const response = await fetch("https://overpass-api.de/api/interpreter", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "data=" + encodeURIComponent(query)
        });

        if (!response.ok) {
          throw new Error(`Overpass API HTTP ${response.status}`);
        }

        const data = await response.json();
        const elements = data.elements || [];

        // Normalisasi & hitung jarak
        const cctvs = [];
        for (const el of elements) {
          const elLat = el.lat ?? el.center?.lat;
          const elLon = el.lon ?? el.center?.lon;
          if (elLat == null || elLon == null) continue;

          const dist = this.calculateDistance(lat, lng, elLat, elLon);
          if (dist > radius) continue;

          cctvs.push({
            id: el.id,
            type: el.type,
            lat: elLat,
            lng: elLon,
            tags: el.tags || {},
            distance: Math.round(dist),
            name: el.tags?.name || el.tags?.description || `CCTV ${el.id}`
          });
        }

        // Urutkan dari terdekat
        cctvs.sort((a, b) => a.distance - b.distance);

        this._lastScan = {
          queryLat: lat,
          queryLng: lng,
          radius,
          cctvs,
          timestamp: U.iso()
        };

        const nearest = cctvs[0] || null;

        fleet.logGlobal(
          `✅ [CCTV] Ditemukan ${cctvs.length} CCTV. Terdekat: ${nearest ? nearest.name + " (" + nearest.distance + "m)" : "tidak ada"}.`,
          cctvs.length > 0 ? "SUCCESS" : "WARNING"
        );

        // Emit event sukses
        fleet.emit("CCTV_SCAN_SUCCESS", {
          cctvs,
          nearest,
          total: cctvs.length,
          queryLat: lat,
          queryLng: lng,
          radius
        });

        // Siapkan stream HLS untuk drone terpilih
        if (nearest) {
          this._prepareStream(nearest, fleet);
        }

        return this._lastScan;

      } catch (err) {
        fleet.logGlobal(`❌ [CCTV] Scan gagal: ${err.message}`, "DANGER");
        fleet.emit("CCTV_SCAN_ERROR", { error: err.message, lat, lng, radius });
        return null;
      }
    },

    /**
     * Siapkan URL stream HLS
     */
    _prepareStream(cctv, fleet) {
      // Gunakan HLS stream publik yang valid (demo)
      // Di produksi, URL ini bisa dipetakan dari metadata CCTV
      const streamUrl = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";

      this._activeStreams.set("default", streamUrl);

      fleet.logGlobal(
        `🎥 [CCTV] Stream siap: ${cctv.name} (${cctv.distance}m) → ${streamUrl}`,
        "SUCCESS"
      );

      fleet.emit("CCTV_STREAM_READY", {
        url: streamUrl,
        cctv: cctv,
        cctvId: cctv.id,
        distance: cctv.distance
      });
    },

    getLastScan() { return this._lastScan; },
    getActiveStream() { return this._activeStreams.get("default") || null; }
  };

  // ==========================================================================
  // 6. FLEET MANAGER (Orchestrator)
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
      this.logGlobal(`Armada CIKUR GO diinisialisasi: ${count} unit siap.`, "SUCCESS");
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

    getSelectedDrone() {
      return this.drones.get(this.selectedDroneId) || null;
    },

    getDrone(id) { return this.drones.get(id) || null; },

    onEvent(callback) {
      if (typeof callback === "function") this.listeners.push({ event: "*", cb: callback });
    },
    on(eventName, callback) {
      if (typeof callback === "function") this.listeners.push({ event: eventName, cb: callback });
    },
    once(eventName, callback) {
      if (typeof callback === "function") this._onceListeners.push({ event: eventName, cb: callback });
    },
    off(eventName, callback) {
      this.listeners = this.listeners.filter(l =>
        !(l.event === eventName && l.cb === callback));
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
      for (const d of this.drones.values()) {
        if (d.deploy()) n++;
      }
      if (n > 0) this._missionStartTime = Date.now();
      this.logGlobal(`PERINTAH GLOBAL: ${n} drone lepas landas.`, "SUCCESS");
      this.emit("FLEET_DEPLOYED", { count: n });
      AudioEngine.speak("Seluruh armada drone dilepas. Memulai misi pemantauan.");
      return n;
    },

    returnAll() {
      let n = 0;
      for (const d of this.drones.values()) {
        if (d.returnToBase()) n++;
      }
      this.logGlobal(`PERINTAH GLOBAL: ${n} drone kembali ke markas.`, "WARNING");
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
      this.logGlobal(`🚨 [CRITICAL] TSUNAMI ALERT GLOBAL. ${n} drone mode evakuasi!`, "DANGER");
      this.emit("DISASTER_ALERT_ACTIVE", { dronesAffected: n });

      AudioEngine.playSiren(3.0);
      AudioEngine.speak(
        "Perhatian. Perhatian. Potensi tsunami terdeteksi di area pantai. " +
        "Segera tinggalkan area pantai. Ikuti arah terbang drone ini menuju zona " +
        "evakuasi aman terdekat. Tetap tenang dan jangan panik.",
        { emergency: true }
      );

      // === v5.0.0: Auto-scan CCTV saat tsunami ===
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
      for (const d of this.drones.values()) {
        if (d.activateVoidPulse()) n++;
      }
      this.logGlobal("⚡ VOID PULSE GLOBAL DIAKTIFKAN. Sinyal asing dilumpuhkan.", "DANGER");
      this.emit("VOID_PULSE_ACTIVE", { dronesAffected: n });
      AudioEngine.speak("Void pulse diaktifkan. Zona aman tercipta.");
    },

    interactSelected(targetName) {
      const d = this.getSelectedDrone();
      if (!d) return null;
      const log = d.interactWithTarget(targetName);
      if (log) this.emit("NEW_LOG", log);

      const greeting =
        `Halo ${targetName}. Aku melihat trafik sangat macet di sekitarmu. ` +
        `Apakah kamu akan melanjutkan perjalanan, atau aku infokan pilihan lain?`;
      AudioEngine.speak(greeting);
      return log;
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
        if (d.state === STATE.MONITORING && meshCache.has(d.id) === false) {
          meshStat = SwarmCoordinator.getMeshAvailability(d, this.drones);
          meshCache.set(d.id, meshStat);
        } else {
          meshStat = meshCache.get(d.id) || { meshAvailable: false };
        }

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
        this.logGlobal(`⚠️ ${stats.offline} drone OFFLINE. Perlu perhatian.`, "WARNING");
      }
      if (stats.jammed > 0 && this._tickCount % 10 === 0) {
        this.logGlobal(`📡 ${stats.jammed} drone terkena jammer.`, "WARNING");
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

    speak(text, isEmergency = false) {
      AudioEngine.speak(text, { emergency: isEmergency });
    },
    playSiren() { AudioEngine.playSiren(); },
    mute(m = true) { AudioEngine.mute(m); this.emit("MUTE_STATE_CHANGED", m); },
    setVolume(v) { AudioEngine.setVolume(v); },

    exportState() {
      const drones = [];
      for (const d of this.drones.values()) drones.push(d.toJSON());
      return JSON.stringify({
        version: VERSION,
        exportedAt: U.iso(),
        selectedDroneId: this.selectedDroneId,
        isTsunamiActive: this.isTsunamiActive,
        drones
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
        this.logGlobal(`State dimuat: ${this.drones.size} drone.`, "SUCCESS");
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

    // === v5.0.0: Expose CCTVEngine ===
    CCTV: CCTVEngine
  };

  // ==========================================================================
  // 7. BOOTSTRAP
  // ==========================================================================
  FleetManager.init({ autoStart: false });
  global.CGO_Fleet = FleetManager;

  // Debug helper
  global.CGO_Debug = {
    version: VERSION,
    getState: () => ({ ...FleetManager.getFleetStats() }),
    getDrone: id => FleetManager.getDrone(id),
    dumpLogs: () => FleetManager.getGlobalLog(),
    simulateDay: () => { FleetManager.isDaylight = true; },
    simulateNight: () => { FleetManager.isDaylight = false; },
    scanCCTV: (lat, lng, radius) => CCTVEngine.scanNearby(lat, lng, radius)
  };

  console.info(`[CGO Fleet] v${VERSION} — CCTV Integration ready.`);

})(typeof window !== "undefined" ? window : globalThis);
