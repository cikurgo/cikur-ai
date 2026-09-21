// FILE: ht-audio-synth.js | DEPS: none | EXPORTS: htAudioSynth, AudioState

const AudioState = Object.freeze({
  OFF: "off",
  READY: "ready",
  SUSPENDED: "suspended"
});

let singleton = null;

class HTAudioSynth {
  constructor() {
    this.audioContext = null;
    this.activeNodes = new Set();
    this.lastCollisionAt = 0;
    this.batteryLevel = 1;
    this.batteryTimer = null;
    this.state = AudioState.OFF;
    this._battery = null;
    this._batteryUpdate = null;
    this._disposePromise = null;
  }

  async init() {
    // FIX #4: kalau sedang dispose, tunggu selesai dulu
    if (this._disposePromise) {
      await this._disposePromise.catch(() => {});
    }

    if (this.audioContext) {
      if (this.audioContext.state === "suspended") {
        try {
          await this.audioContext.resume();
        } catch (error) {
          console.warn("[HTAudio] Gagal resume AudioContext.", error);
        }
      }

      this.state =
        this.audioContext.state === "running"
          ? AudioState.READY
          : AudioState.SUSPENDED;

      return this.isReady();
    }

    if (typeof AudioContext === "undefined") {
      console.warn("[HTAudio] AudioContext tidak tersedia.");
      this.state = AudioState.OFF;
      return false;
    }

    try {
      this.audioContext = new AudioContext();

      if (this.audioContext.state === "suspended") {
        try {
          await this.audioContext.resume();
        } catch (error) {
          console.warn("[HTAudio] AudioContext masih suspended.", error);
        }
      }

      this.state =
        this.audioContext.state === "running"
          ? AudioState.READY
          : AudioState.SUSPENDED;

      this.startBatteryMonitor();

      return this.isReady();
    } catch (error) {
      console.error("[HTAudio] Gagal membuat AudioContext.", error);
      this.audioContext = null;
      this.state = AudioState.OFF;
      return false;
    }
  }

  isReady() {
    return Boolean(
      this.audioContext &&
      this.audioContext.state === "running"
    );
  }

  async resume() {
    if (!this.audioContext) {
      return this.init();
    }

    if (this.audioContext.state === "suspended") {
      try {
        await this.audioContext.resume();
      } catch (error) {
        console.warn("[HTAudio] Tap lagi untuk aktifkan audio.", error);
      }
    }

    this.state =
      this.audioContext.state === "running"
        ? AudioState.READY
        : AudioState.SUSPENDED;

    return this.isReady();
  }

  getGainMultiplier(emergency = false) {
    if (this.batteryLevel < 0.1) {
      return emergency ? 0.25 : 0;
    }

    if (this.batteryLevel < 0.2) {
      return 0.5;
    }

    return 1;
  }

  async updateBatteryLevel() {
    if (
      typeof navigator === "undefined" ||
      typeof navigator.getBattery !== "function"
    ) {
      this.batteryLevel = 1;
      return;
    }

    try {
      if (!this._battery) {
        const battery = await navigator.getBattery();
        this._battery = battery;

        const update = () => {
          if (Number.isFinite(battery.level)) {
            this.batteryLevel = battery.level;
          }
        };

        battery.addEventListener?.("levelchange", update);
        this._batteryUpdate = update;
      }

      if (Number.isFinite(this._battery.level)) {
        this.batteryLevel = this._battery.level;
      }
    } catch (error) {
      console.debug("[HTAudio] Battery API tidak tersedia.", error);
      this.batteryLevel = 1;
    }
  }

  startBatteryMonitor() {
    if (this.batteryTimer !== null) {
      return;
    }

    void this.updateBatteryLevel();

    // FIX #6: polling 30s redundan karena sudah ada `levelchange` listener.
    // Naikkan ke 5 menit sebagai safety net saja.
    this.batteryTimer = setInterval(() => {
      void this.updateBatteryLevel();
    }, 300_000);
  }

  stopBatteryMonitor() {
    if (this.batteryTimer !== null) {
      clearInterval(this.batteryTimer);
      this.batteryTimer = null;
    }

    if (this._battery && this._batteryUpdate) {
      this._battery.removeEventListener?.(
        "levelchange",
        this._batteryUpdate
      );
    }

    this._battery = null;
    this._batteryUpdate = null;
  }

  trackNode(node) {
    this.activeNodes.add(node);

    const cleanup = () => {
      this.activeNodes.delete(node);

      try {
        node.disconnect();
      } catch {
        // Node sudah terputus.
      }
    };

    return cleanup;
  }

  /**
   * Nada pendek "klik radio" saat paket valid (bukan beep keras).
   * Nada lebih rendah + noise-ish → terasa seperti squelch/tail.
   */
  playValidBeep(signalQuality = 0, options = {}) {
    if (!this.isReady()) {
      if (this.audioContext?.state === "suspended") {
        this.state = AudioState.SUSPENDED;
        console.warn("[HTAudio] Tap lagi untuk aktifkan audio.");
      }
      return false;
    }

    const emergency = options?.emergency === true;
    const multiplier = this.getGainMultiplier(emergency);
    if (multiplier <= 0) return false;

    const now = this.audioContext.currentTime;
    const signal = Math.max(0, Math.min(100, Number(signalQuality) || 0));
    // 420–620 Hz: nada radio klasik, lebih rendah dari beep lama
    const frequency = 420 + (signal / 100) * 200;

    const osc = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(frequency, now);

    const safePeak = Math.max(0.0002, 0.12 * multiplier);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(safePeak, now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.055);

    osc.connect(gain);
    gain.connect(this.audioContext.destination);
    const cleanup = this.trackNode(osc);
    osc.addEventListener?.("ended", () => {
      cleanup();
      try { gain.disconnect(); } catch { /* */ }
    }, { once: true });

    osc.start(now);
    osc.stop(now + 0.055);
    return true;
  }

  /** Roger beep — dua nada pendek saat lepas PTT (BASE OVER) */
  playRogerBeep() {
    if (!this.isReady()) return false;
    const mult = this.getGainMultiplier(false);
    if (mult <= 0) return false;

    const ctx = this.audioContext;
    const now = ctx.currentTime;
    const tones = [880, 660]; // high → low

    tones.forEach((freq, i) => {
      const t0 = now + i * 0.09;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, t0);
      const peak = Math.max(0.0002, 0.18 * mult);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.linearRampToValueAtTime(peak, t0 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.07);
      osc.connect(gain);
      gain.connect(ctx.destination);
      const cleanup = this.trackNode(osc);
      osc.addEventListener?.("ended", () => {
        cleanup();
        try { gain.disconnect(); } catch { /* */ }
      }, { once: true });
      osc.start(t0);
      osc.stop(t0 + 0.07);
    });
    return true;
  }

  /** Squelch open — saat BASE mulai PTT */
  playSquelchOpen() {
    if (!this.isReady()) return false;
    const mult = this.getGainMultiplier(false);
    if (mult <= 0) return false;

    const ctx = this.audioContext;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(180, now);
    osc.frequency.exponentialRampToValueAtTime(90, now + 0.12);
    const peak = Math.max(0.0002, 0.08 * mult);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(peak, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);
    osc.connect(gain);
    gain.connect(ctx.destination);
    const cleanup = this.trackNode(osc);
    osc.addEventListener?.("ended", () => {
      cleanup();
      try { gain.disconnect(); } catch { /* */ }
    }, { once: true });
    osc.start(now);
    osc.stop(now + 0.14);
    return true;
  }

  playCollisionAlert() {
    if (!this.isReady()) {
      return false;
    }

    const nowMs = Date.now();

    if (nowMs - this.lastCollisionAt < 500) {
      return false;
    }

    // FIX #7: collision alert = diagnostik penting, tetap bunyi saat battery rendah.
    // ASSUMPTION: intentional pakai emergency=true.
    const multiplier = this.getGainMultiplier(true);

    if (multiplier <= 0) {
      return false;
    }

    this.lastCollisionAt = nowMs;

    const now = this.audioContext.currentTime;
    const oscillator = this.audioContext.createOscillator();
    const gain = this.audioContext.createGain();

    oscillator.type = "square";
    oscillator.frequency.setValueAtTime(400, now);

    const safePeak = Math.max(0.0002, 0.2 * multiplier);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(safePeak, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.15);

    oscillator.connect(gain);
    gain.connect(this.audioContext.destination);

    const cleanup = this.trackNode(oscillator);

    oscillator.addEventListener?.("ended", () => {
      cleanup();

      try {
        gain.disconnect();
      } catch {
        // Gain sudah terputus.
      }
    }, { once: true });

    oscillator.start(now);
    oscillator.stop(now + 0.15);

    return true;
  }

  dispose() {
    this.stopBatteryMonitor();

    for (const oscillator of this.activeNodes) {
      try {
        oscillator.stop();
      } catch {
        // Oscillator sudah berhenti.
      }

      try {
        oscillator.disconnect();
      } catch {
        // Oscillator sudah terputus.
      }
    }

    this.activeNodes.clear();

    const context = this.audioContext;
    this.audioContext = null;
    this.state = AudioState.OFF;
    this.lastCollisionAt = 0;

    if (context) {
      // FIX #4: track promise close agar init() berikutnya bisa menunggu.
      this._disposePromise = context.close()
        .catch((error) => {
          console.debug("[HTAudio] AudioContext close gagal.", error);
        })
        .finally(() => {
          this._disposePromise = null;
        });
    }

    if (singleton === this) {
      singleton = null;
    }
  }
}

function getSingleton() {
  if (!singleton) {
    singleton = new HTAudioSynth();
  }

  return singleton;
}

const htAudioSynth = {
  init() {
    return getSingleton().init();
  },

  resume() {
    return getSingleton().resume();
  },

  playValidBeep(signalQuality, options) {
    return getSingleton().playValidBeep(signalQuality, options);
  },

  playCollisionAlert() {
    return getSingleton().playCollisionAlert();
  },

  playRogerBeep() {
    return getSingleton().playRogerBeep();
  },

  playSquelchOpen() {
    return getSingleton().playSquelchOpen();
  },

  /** AudioContext instance (untuk sidetone mic) */
  getContext() {
    return getSingleton().audioContext;
  },

  dispose() {
    if (singleton) {
      singleton.dispose();
    }
  },

  isReady() {
    return singleton?.isReady() === true;
  },

  getState() {
    return singleton?.state ?? AudioState.OFF;
  }
};

export {
  htAudioSynth,
  AudioState
};
