// FILE: stress-test-ht.js | DEPS: ht-protocol, ht-ptt-simulator, cgo-ht-radio-engine, ht-audio-synth | EXPORTS: StressTest, runStressTest

import { PACKET_SIZE, MAGIC_BYTE } from './ht-protocol.js';
import { createSimulator } from './ht-ptt-simulator.js';
import { getGateway } from './cgo-ht-radio-engine.js';
import { htAudioSynth } from './ht-audio-synth.js';

// ============================================================
// KONFIGURASI DEFAULT
// ============================================================

const DEFAULT_CONFIG = Object.freeze({
  agents: 50,
  durationSec: 300,
  channels: 8,
  corruptRate: 0.05,
  randomRate: 0.02,
  verbose: false,

  // Alert thresholds
  fpsThreshold: 30,
  fpsSustainSec: 5,
  memGrowthMBPerMin: 10,
  audioLatencyMs: 100,
  chatNodeMax: 500,
  bufferDepthAlert: 8,

  // Sampling
  fpsSampleMs: 1000,
  memSampleMs: 5000,
  chatSampleMs: 2000,
  injectIntervalMs: 100,

  // Adaptive throttle
  throttleFpsThreshold: 30,
  throttleSustainSec: 3,
  throttleBatchReduction: 5
});

// ============================================================
// ARG PARSER
// ============================================================

function parseArgs(argv) {
  const args = { ...DEFAULT_CONFIG };

  if (!Array.isArray(argv)) return args;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    const parseNum = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    switch (arg) {
      case '--agents': {
        const v = parseNum(argv[++i]);
        if (v !== null) args.agents = Math.max(1, Math.floor(v));
        break;
      }
      case '--duration': {
        const v = parseNum(argv[++i]);
        if (v !== null) args.durationSec = Math.max(1, Math.floor(v));
        break;
      }
      case '--channels': {
        const v = parseNum(argv[++i]);
        if (v !== null) args.channels = Math.max(1, Math.min(16, Math.floor(v)));
        break;
      }
      case '--corrupt': {
        const v = parseNum(argv[++i]);
        if (v !== null) args.corruptRate = Math.max(0, Math.min(1, v));
        break;
      }
      case '--random': {
        const v = parseNum(argv[++i]);
        if (v !== null) args.randomRate = Math.max(0, Math.min(1, v));
        break;
      }
      case '--verbose':
      case '-v':
        args.verbose = true;
        break;
      default:
        break;
    }
  }

  return args;
}

// ============================================================
// UTIL
// ============================================================

function randomInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function padRight(str, len) {
  return String(str).padEnd(len, ' ');
}

function padLeft(str, len) {
  return String(str).padStart(len, ' ');
}

function formatDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

// ============================================================
// KELAS STRESS TEST
// ============================================================

class StressTest {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.gateway = getGateway();
    this.audio = htAudioSynth;

    // Runtime
    this.running = false;
    this.startTime = 0;
    this.endTime = 0;
    this.throttled = false;

    // Simulator
    this.simulator = null;
    this.packetPool = [];      // Pre-generated payload untuk inject
    this.poolIndex = 0;

    // Stats
    this.stats = this._createStats();

    // Timers
    this.timers = {
      inject: null,
      fps: null,
      mem: null,
      chat: null,
      duration: null,
      fpsWatchdog: null
    };

    // FPS tracking
    this._frameCount = 0;
    this._fpsSampled = 0;
    this._fpsHistory = [];
    this._lowFpsSince = 0;

    // Memory
    this._memSamples = [];

    // Audio latency
    this._audioLatencies = [];

    // Chat DOM
    this._chatNodeCount = 0;

    // Event listeners (unsubscribe)
    this._unsubscribers = [];
  }

  _createStats() {
    return {
      injected: 0,
      validInjected: 0,
      corruptInjected: 0,
      randomInjected: 0,
      fpsMin: Infinity,
      fpsMax: 0,
      fpsSum: 0,
      fpsCount: 0,
      memStart: 0,
      memPeak: 0,
      memSamples: 0,
      audioLatencyMax: 0,
      chatNodePeak: 0,
      bufferDepthPeak: 0,
      fpsAlerts: 0,
      memAlerts: 0,
      audioAlerts: 0,
      chatAlerts: 0,
      bufferAlerts: 0,
      throttleEvents: 0
    };
  }

  // ----------------------------------------------------------
  // START
  // ----------------------------------------------------------

  async start() {
    if (this.running) {
      console.warn('[StressTest] Sudah berjalan.');
      return;
    }

    this.running = true;
    this.startTime = Date.now();
    this.endTime = this.startTime + this.config.durationSec * 1000;

    console.log('═══════════════════════════════════════════════');
    console.log(' BCGO STRESS TEST — HT RADIO');
    console.log('═══════════════════════════════════════════════');
    console.log(` Agents:        ${this.config.agents}`);
    console.log(` Duration:      ${formatDuration(this.config.durationSec)}`);
    console.log(` Channels:      ${this.config.channels}`);
    console.log(` Corrupt rate:  ${(this.config.corruptRate * 100).toFixed(1)}%`);
    console.log(` Random rate:   ${(this.config.randomRate * 100).toFixed(1)}%`);
    console.log('═══════════════════════════════════════════════');

    // Init audio
    try {
      await this.audio.init();
    } catch (err) {
      console.warn('[StressTest] Audio init gagal:', err);
    }

    // Reset gateway
    this.gateway.reset();

    // Setup simulator
    this._setupSimulator();

    // Pre-generate packet pool (max 200 untuk hindari memory bloat)
    this._buildPacketPool(200);

    // Snapshot memory awal
    this._snapshotMemory(true);

    // Setup FPS watchdog
    this._setupFpsWatchdog();

    // Setup subscribers (opsional: bisa override gateway.onLog)
    this._setupSubscribers();

    // Start timers
    this._startInjectLoop();
    this._startFpsSampling();
    this._startMemSampling();
    this._startChatSampling();

    // Auto-stop
    this.timers.duration = setTimeout(() => {
      this.stop().catch((err) => {
        console.error('[StressTest] stop error:', err);
      });
    }, this.config.durationSec * 1000);
  }

  // ----------------------------------------------------------
  // SETUP
  // ----------------------------------------------------------

  _setupSimulator() {
    // Simulator tidak start sendiri; kita pakai onTransmit untuk inject langsung.
    this.simulator = createSimulator({
      count: this.config.agents,
      channels: this.config.channels,
      onTransmit: (channel, payload) => {
        // Inject ke gateway
        this.gateway.receive(channel, payload);
        this.stats.injected++;
        this.stats.validInjected++;
      },
      onError: (err) => {
        console.error('[StressTest] sim error:', err);
      }
    });
  }

  _buildPacketPool(size) {
    this.packetPool.length = 0;

    // Buat paket valid menggunakan encodeHTPacket via simulator,
    // lalu corrupt/random varian untuk inject selanjutnya.
    const { encodeHTPacket } = globalThis.__htProtocol ?? {};

    // Fallback: buat pool dengan memanggil simulator agent transmit sekali
    // tapi karena simulator kita tidak start, kita generate manual:
    for (let i = 0; i < size; i++) {
      const buf = new Uint8Array(PACKET_SIZE);

      // Random payload dengan magic byte valid
      buf[0] = MAGIC_BYTE;
      buf[1] = i & 0xFF;
      buf[2] = (i >> 8) & 0xFF;
      buf[3] = i & 0xFF;

      // Random data
      for (let j = 4; j < PACKET_SIZE - 2; j++) {
        buf[j] = randomInt(0, 255);
      }

      // CRC akan mismatch untuk random, tapi itu OK — kita cuma butuh stream biner.
      // Yang penting magic byte valid agar lolos check pertama.
      this.packetPool.push(buf);
    }
  }

  _setupSubscribers() {
    // Override gateway.onLog supaya tidak spam chat saat stress test
    // kecuali chat logging diinginkan.
    const originalOnLog = this.gateway.onLog;
    this._originalOnLog = originalOnLog;

    this.gateway.onLog = (channelId, text, meta) => {
      // Hitung paket chat yang baru dipush (untuk metrik DOM)
      this._chatNodeCount++;

      if (this.config.verbose) {
        console.log(text);
      }
    };

    this._unsubscribers.push(() => {
      this.gateway.onLog = originalOnLog;
    });
  }

  // ----------------------------------------------------------
  // INJECT LOOP
  // ----------------------------------------------------------

  _startInjectLoop() {
    let batchSize = Math.min(this.config.agents, 10);

    const loop = () => {
      if (!this.running) return;

      const now = Date.now();
      const elapsed = now - this.startTime;

      // Adaptive throttle
      if (this.throttled) {
        batchSize = Math.max(1, this.config.throttleBatchReduction);
      } else {
        batchSize = Math.min(this.config.agents, 10);
      }

      // Pick random agents
      const sim = this.simulator;
      if (sim && sim.agents.length > 0) {
        for (let i = 0; i < batchSize; i++) {
          const agent = sim.agents[randomInt(0, sim.agents.length - 1)];
          if (!agent) continue;

          const channel = agent.channel;
          const roll = Math.random();

          let payload;

          if (roll < this.config.randomRate) {
            // Random bytes
            payload = this._makeRandomPayload();
            this.stats.randomInjected++;
          } else if (roll < this.config.randomRate + this.config.corruptRate) {
            // Valid packet dengan CRC corrupt
            payload = this._makeCorruptPayload(agent);
            this.stats.corruptInjected++;
          } else {
            // Packet dari pool (bisa valid atau tidak, magic byte selalu valid)
            payload = this.packetPool[this.poolIndex % this.packetPool.length];
            this.poolIndex++;
            this.stats.validInjected++;
          }

          // Inject ke gateway
          const accepted = this.gateway.receive(channel, payload);
          if (accepted) this.stats.injected++;
        }
      }

      // Track buffer depth peak
      const chStats = this.gateway.getChannelStats();
      for (const ch in chStats) {
        if (chStats[ch].bufferDepth > this.stats.bufferDepthPeak) {
          this.stats.bufferDepthPeak = chStats[ch].bufferDepth;
        }
      }

      // Schedule next
      this.timers.inject = setTimeout(loop, this.config.injectIntervalMs);
    };

    loop();
  }

  _makeRandomPayload() {
    const buf = new Uint8Array(PACKET_SIZE);
    for (let i = 0; i < PACKET_SIZE; i++) {
      buf[i] = randomInt(0, 255);
    }
    return buf;
  }

  _makeCorruptPayload(agent) {
    // Buat paket yang menyerupai valid (magic + seq) tapi CRC rusak
    const buf = new Uint8Array(PACKET_SIZE);
    buf[0] = MAGIC_BYTE;
    buf[1] = agent.sequence & 0xFF;
    buf[2] = (agent.agentId >> 8) & 0xFF;
    buf[3] = agent.agentId & 0xFF;
    buf[17] = agent.channel & 0x0F;
    buf[30] = 0x02;

    // Isi sisanya random (CRC pasti mismatch)
    for (let i = 4; i < PACKET_SIZE - 2; i++) {
      if (i === 17 || i === 30) continue;
      buf[i] = randomInt(0, 255);
    }

    return buf;
  }

  // ----------------------------------------------------------
  // SAMPLING — FPS
  // ----------------------------------------------------------

  _startFpsSampling() {
    const sample = () => {
      if (!this.running) return;

      const fps = this._fpsSampled;

      if (fps > 0) {
        this._fpsHistory.push(fps);
        if (this._fpsHistory.length > 60) this._fpsHistory.shift();

        this.stats.fpsSum += fps;
        this.stats.fpsCount++;
        this.stats.fpsMin = Math.min(this.stats.fpsMin, fps);
        this.stats.fpsMax = Math.max(this.stats.fpsMax, fps);

        if (fps < this.config.fpsThreshold) {
          if (this._lowFpsSince === 0) {
            this._lowFpsSince = Date.now();
          } else if ((Date.now() - this._lowFpsSince) / 1000 > this.config.fpsSustainSec) {
            this.stats.fpsAlerts++;
            console.warn(`⚠️ [StressTest] FPS rendah: ${fps.toFixed(1)} fps sustained ${this.config.fpsSustainSec}s`);
            this._lowFpsSince = Date.now(); // reset agar tidak spam
          }
        } else {
          this._lowFpsSince = 0;
        }
      }

      // Reset counter
      this._fpsSampled = 0;
      this.timers.fps = setTimeout(sample, this.config.fpsSampleMs);
    };

    // Hook RAF untuk hitung FPS
    this._rafLoop = () => {
      if (!this.running) return;
      this._fpsSampled++;
      requestAnimationFrame(this._rafLoop);
    };

    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(this._rafLoop);
    }

    this.timers.fps = setTimeout(sample, this.config.fpsSampleMs);
  }

  /**
   * Manual frame tick — panggil dari render loop utama kalau ada.
   */
  tickFrame() {
    this._fpsSampled++;
  }

  // ----------------------------------------------------------
  // SAMPLING — MEMORY
  // ----------------------------------------------------------

  _snapshotMemory(initial = false) {
    if (typeof performance === 'undefined' || !performance.memory) return null;

    const mb = performance.memory.usedJSHeapSize / 1024 / 1024;

    if (initial) {
      this.stats.memStart = mb;
      this.stats.memPeak = mb;
    } else {
      this.stats.memPeak = Math.max(this.stats.memPeak, mb);
      this._memSamples.push({ t: Date.now(), mb });
      if (this._memSamples.length > 200) this._memSamples.shift();
    }

    this.stats.memSamples++;

    return mb;
  }

  _startMemSampling() {
    const sample = () => {
      if (!this.running) return;

      const mb = this._snapshotMemory();
      if (mb === null) {
        // performance.memory tidak tersedia, skip
        this.timers.mem = setTimeout(sample, this.config.memSampleMs);
        return;
      }

      // Cek growth vs 1 menit lalu
      const cutoff = Date.now() - 60_000;
      const old = this._memSamples.find((s) => s.t >= cutoff);

      if (old) {
        const growthPerMin = mb - old.mb;

        if (growthPerMin > this.config.memGrowthMBPerMin) {
          this.stats.memAlerts++;
          console.warn(`⚠️ [StressTest] Memory growth: +${growthPerMin.toFixed(1)} MB/min (current: ${mb.toFixed(1)} MB)`);
        }
      }

      this.timers.mem = setTimeout(sample, this.config.memSampleMs);
    };

    this.timers.mem = setTimeout(sample, this.config.memSampleMs);
  }

  // ----------------------------------------------------------
  // SAMPLING — CHAT DOM
  // ----------------------------------------------------------

  _startChatSampling() {
    const sample = () => {
      if (!this.running) return;

      if (typeof document !== 'undefined') {
        const count = document.querySelectorAll('.msg-radio').length;
        this._chatNodeCount = count;
        this.stats.chatNodePeak = Math.max(this.stats.chatNodePeak, count);

        if (count > this.config.chatNodeMax) {
          this.stats.chatAlerts++;
          console.warn(`⚠️ [StressTest] Chat DOM nodes: ${count} (threshold ${this.config.chatNodeMax})`);
        }
      }

      this.timers.chat = setTimeout(sample, this.config.chatSampleMs);
    };

    this.timers.chat = setTimeout(sample, this.config.chatSampleMs);
  }

  // ----------------------------------------------------------
  // FPS WATCHDOG → ADAPTIVE THROTTLE
  // ----------------------------------------------------------

  _setupFpsWatchdog() {
    const check = () => {
      if (!this.running) return;

      if (this._fpsHistory.length < this.config.throttleSustainSec) {
        this.timers.fpsWatchdog = setTimeout(check, 1000);
        return;
      }

      const recent = this._fpsHistory.slice(-this.config.throttleSustainSec);
      const avg = recent.reduce((a, b) => a + b, 0) / recent.length;

      const wasThrottled = this.throttled;
      this.throttled = avg < this.config.throttleFpsThreshold;

      if (this.throttled && !wasThrottled) {
        this.stats.throttleEvents++;
        console.log(`🐢 [StressTest] Adaptive throttle ON (avg FPS ${avg.toFixed(1)})`);
      } else if (!this.throttled && wasThrottled) {
        console.log(`🚀 [StressTest] Adaptive throttle OFF (avg FPS ${avg.toFixed(1)})`);
      }

      this.timers.fpsWatchdog = setTimeout(check, 1000);
    };

    check();
  }

  // ----------------------------------------------------------
  // AUDIO LATENCY TRACKING
  // ----------------------------------------------------------

  /**
   * Bungkus callback beep untuk ukur latency.
   * Dipanggil manual dari test.html setelah init.
   */
  wrapAudioLatency() {
    const original = this.audio.playValidBeep.bind(this.audio);

    this.audio.playValidBeep = (signal, opts) => {
      const t0 = performance.now();
      const result = original(signal, opts);
      const t1 = performance.now();

      const latency = t1 - t0;
      this._audioLatencies.push(latency);
      if (this._audioLatencies.length > 500) this._audioLatencies.shift();

      this.stats.audioLatencyMax = Math.max(this.stats.audioLatencyMax, latency);

      if (latency > this.config.audioLatencyMs) {
        this.stats.audioAlerts++;
      }

      return result;
    };

    this._unsubscribers.push(() => {
      this.audio.playValidBeep = original;
    });
  }

  // ----------------------------------------------------------
  // STOP
  // ----------------------------------------------------------

  async stop() {
    if (!this.running) return;

    this.running = false;

    // Clear timers
    for (const key in this.timers) {
      if (this.timers[key] !== null) {
        clearTimeout(this.timers[key]);
        clearInterval(this.timers[key]);
        this.timers[key] = null;
      }
    }

    // Unsubscribers
    for (const fn of this._unsubscribers) {
      try { fn(); } catch { /* ignore */ }
    }
    this._unsubscribers.length = 0;

    // Dispose simulator
    if (this.simulator) {
      this.simulator.stopAll();
      this.simulator.disposeAll();
      this.simulator = null;
    }

    // Dispose audio
    try {
      this.audio.dispose();
    } catch (err) {
      console.warn('[StressTest] Audio dispose error:', err);
    }

    // Reset BCGO_STATE.satellite
    if (this.gateway?.state?.satellite) {
      for (const key in this.gateway.state.satellite) {
        delete this.gateway.state.satellite[key];
      }
    }

    // Reset gateway
    this.gateway.reset();

    // Final memory snapshot
    this._snapshotMemory();

    // Print report
    this._printReport();

    // Emit event
    if (typeof window !== 'undefined' && window.dispatchEvent) {
      try {
        window.dispatchEvent(new CustomEvent('stressTestComplete', {
          detail: this.getReport()
        }));
      } catch { /* ignore */ }
    }
  }

  // ----------------------------------------------------------
  // REPORT
  // ----------------------------------------------------------

  getReport() {
    const elapsed = (Date.now() - this.startTime) / 1000;
    const globalStats = this.gateway.getGlobalStats();
    const chStats = this.gateway.getChannelStats();

    let totalCollisions = 0;
    let totalDropped = 0;
    let totalGaps = 0;

    for (const ch in chStats) {
      totalCollisions += chStats[ch].collisionCount;
      totalDropped += chStats[ch].droppedCount;
      totalGaps += chStats[ch].gapCount;
    }

    return {
      elapsedSec: elapsed,
      config: { ...this.config },
      stats: { ...this.stats },
      gateway: globalStats,
      collisions: totalCollisions,
      dropped: totalDropped,
      gaps: totalGaps,
      avgFps: this.stats.fpsCount > 0
        ? this.stats.fpsSum / this.stats.fpsCount
        : 0,
      fpsMin: this.stats.fpsMin === Infinity ? 0 : this.stats.fpsMin,
      fpsMax: this.stats.fpsMax,
      memStart: this.stats.memStart,
      memPeak: this.stats.memPeak,
      memGrowth: this.stats.memPeak - this.stats.memStart,
      audioLatencyMax: this.stats.audioLatencyMax,
      chatNodePeak: this.stats.chatNodePeak
    };
  }

  _printReport() {
    const r = this.getReport();

    const lines = [];
    lines.push('');
    lines.push('═══════════════════════════════════════════════════');
    lines.push(' TEST COMPLETE — BCGO HT Radio');
    lines.push('═══════════════════════════════════════════════════');
    lines.push(` Duration:         ${formatDuration(Math.round(r.elapsedSec))}`);
    lines.push(` Agents:           ${r.config.agents}`);
    lines.push(` Channels:         ${r.config.channels}`);
    lines.push('───────────────────────────────────────────────────');
    lines.push(` Avg FPS:          ${r.avgFps.toFixed(1)}`);
    lines.push(` FPS Range:        ${r.fpsMin.toFixed(1)} - ${r.fpsMax.toFixed(1)}`);
    lines.push(` FPS Alerts:       ${r.stats.fpsAlerts}`);
    lines.push('───────────────────────────────────────────────────');

    if (r.memStart > 0) {
      lines.push(` Memory Start:     ${r.memStart.toFixed(1)} MB`);
      lines.push(` Memory Peak:      ${r.memPeak.toFixed(1)} MB`);
      lines.push(` Memory Growth:    +${r.memGrowth.toFixed(1)} MB`);
      lines.push(` Memory Alerts:    ${r.stats.memAlerts}`);
    } else {
      lines.push(` Memory:           (performance.memory unavailable)`);
    }

    lines.push('───────────────────────────────────────────────────');
    lines.push(` Total Injected:   ${r.stats.injected.toLocaleString()}`);
    lines.push(` ├─ Valid:         ${r.stats.validInjected.toLocaleString()}`);
    lines.push(` ├─ Corrupt:       ${r.stats.corruptInjected.toLocaleString()}`);
    lines.push(` └─ Random:        ${r.stats.randomInjected.toLocaleString()}`);
    lines.push('───────────────────────────────────────────────────');
    lines.push(` Gateway Received: ${r.gateway.totalReceived.toLocaleString()}`);
    lines.push(` ├─ Valid:         ${r.gateway.totalValid.toLocaleString()}`);
    lines.push(` ├─ CRC Fail:      ${r.gateway.totalCrcFail.toLocaleString()}`);
    lines.push(` └─ Magic Fail:    ${r.gateway.totalMagicFail.toLocaleString()}`);
    lines.push(` Collisions:       ${r.collisions.toLocaleString()}`);
    lines.push(` Dropped:          ${r.dropped.toLocaleString()}`);
    lines.push(` Gaps:             ${r.gaps.toLocaleString()}`);
    lines.push('───────────────────────────────────────────────────');
    lines.push(` Audio Latency:    ${r.audioLatencyMax.toFixed(1)} ms (max)`);
    lines.push(` Audio Alerts:     ${r.stats.audioAlerts}`);
    lines.push(` Chat Nodes Peak:  ${r.chatNodePeak}`);
    lines.push(` Chat Alerts:      ${r.stats.chatAlerts}`);
    lines.push(` Buffer Peak:      ${r.stats.bufferDepthPeak} / 10`);
    lines.push(` Buffer Alerts:    ${r.stats.bufferAlerts}`);
    lines.push(` Throttle Events:  ${r.stats.throttleEvents}`);
    lines.push('═══════════════════════════════════════════════════');
    lines.push('');

    console.log(lines.join('\n'));
  }
}

// ============================================================
// HELPER UNTUK NODE / CLI
// ============================================================

async function runStressTest(config = {}) {
  // Parse dari process.argv kalau ada
  let args = { ...config };

  if (typeof process !== 'undefined' && Array.isArray(process.argv)) {
    args = { ...parseArgs(process.argv.slice(2)), ...config };
  }

  const test = new StressTest(args);
  await test.start();

  return test;
}

// ============================================================
// EXPORTS
// ============================================================

export {
  StressTest,
  runStressTest,
  parseArgs,
  DEFAULT_CONFIG
};

// Auto-run kalau di Node
if (
  typeof process !== 'undefined' &&
  typeof window === 'undefined' &&
  import.meta?.url?.endsWith(process.argv?.[1] ?? '')
) {
  runStressTest().catch((err) => {
    console.error('[StressTest] Fatal:', err);
    if (typeof process !== 'undefined') process.exit(1);
  });
}
