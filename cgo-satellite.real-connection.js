/**
 * cgo-satellite.real-connection.js
 * UNIFIED HARDWARE ABSTRACTION LAYER (HAL)
 *
 * Saat LOCK_ACQUIRED (SNR > threshold, EL > min_elev, PER < 1%):
 *   a. Identifikasi tipe: Broadband (Starlink/OW) vs Narrowband (Iridium) vs GNSS
 *   b. Broadband → AT command via WebSerial/WebUSB → hotspot validation
 *   c. Iridium/GNSS → Network Capability / NMEA decode
 * Fallback: Signal Strength API browser
 *
 * Juga tetap menyediakan jalur SDR (WebUSB RTL) untuk IQ stream.
 */
'use strict';

const DEFAULTS = Object.freeze({
  vendorId: 0x0bda,
  productId: 0x2832,
  interfaceNumber: 0,
  endpointNumber: 1,
  transferSize: 16 * 1024,
  sampleRate: 2.4e6,
  reconnectDelayMs: 1000,
  maxReconnectAttempts: 5
});

const LOCK_THRESHOLDS = Object.freeze({
  starlink: { snrDb: 8,  minEl: 10, maxPer: 0.01 },
  oneweb:   { snrDb: 8,  minEl: 10, maxPer: 0.01 },
  iridium:  { snrDb: 6,  minEl: 5,  maxPer: 0.01 },
  gps:      { snrDb: 10, minEl: 7,  maxPer: 0.05 },
  galileo:  { snrDb: 10, minEl: 7,  maxPer: 0.05 },
});

const CONNECTION_TYPE = Object.freeze({
  BROADBAND: 'broadband',   // Starlink / OneWeb
  NARROWBAND: 'narrowband', // Iridium
  GNSS: 'gnss',             // GPS / Galileo
});

function assertWebUSB() {
  if (!globalThis.navigator?.usb) {
    throw new Error('WebUSB tidak tersedia pada browser/context ini.');
  }
}

function validateConfig(c) {
  if (!Number.isInteger(c.vendorId) || c.vendorId < 0 || c.vendorId > 0xffff) throw new TypeError('vendorId tidak valid');
  if (!Number.isInteger(c.productId) || c.productId < 0 || c.productId > 0xffff) throw new TypeError('productId tidak valid');
  if (!Number.isInteger(c.interfaceNumber) || c.interfaceNumber < 0) throw new TypeError('interfaceNumber tidak valid');
  if (!Number.isInteger(c.endpointNumber) || c.endpointNumber <= 0) throw new TypeError('endpointNumber tidak valid');
  if (!Number.isInteger(c.transferSize) || c.transferSize <= 0) throw new TypeError('transferSize tidak valid');
  if (!Number.isFinite(c.sampleRate) || c.sampleRate <= 0) throw new TypeError('sampleRate tidak valid');
}

function classifyConnection(constellId) {
  const id = (constellId || '').toLowerCase();
  if (id === 'starlink' || id === 'oneweb') return CONNECTION_TYPE.BROADBAND;
  if (id === 'iridium') return CONNECTION_TYPE.NARROWBAND;
  if (id === 'gps' || id === 'galileo') return CONNECTION_TYPE.GNSS;
  return CONNECTION_TYPE.NARROWBAND;
}

/**
 * Evaluate whether LOCK_ACQUIRED conditions are met.
 */
function evaluateLock({ constellId, snrDb, elevationDeg, per }) {
  const th = LOCK_THRESHOLDS[constellId] || LOCK_THRESHOLDS.iridium;
  const okSnr = Number.isFinite(snrDb) && snrDb >= th.snrDb;
  const okEl  = Number.isFinite(elevationDeg) && elevationDeg >= th.minEl;
  const okPer = Number.isFinite(per) ? per < th.maxPer : true;
  return {
    locked: okSnr && okEl && okPer,
    okSnr, okEl, okPer,
    threshold: th,
    type: classifyConnection(constellId)
  };
}

// ─── Broadband: AT command hotspot path ──────────────────────────────────────

async function requestSerialPort() {
  if (!navigator.serial) throw new Error('WebSerial tidak tersedia');
  return navigator.serial.requestPort();
}

async function openSerial(port, baudRate = 115200) {
  if (!port.readable && !port.writable) {
    await port.open({ baudRate });
  }
  return {
    writer: port.writable?.getWriter?.() || null,
    reader: null,
    port
  };
}

async function atCommand(serial, cmd, timeoutMs = 5000) {
  if (!serial.writer) throw new Error('Serial writer belum siap');
  await serial.writer.write(new TextEncoder().encode(cmd + '\r\n'));
  const decoder = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + timeoutMs;
  if (!serial.reader && serial.port?.readable) {
    serial.reader = serial.port.readable.getReader();
  }
  while (Date.now() < deadline && serial.reader) {
    const { value, done } = await Promise.race([
      serial.reader.read(),
      new Promise(r => setTimeout(() => r({ value: undefined, done: false }), 800))
    ]);
    if (done) break;
    if (value) {
      buf += decoder.decode(value, { stream: true });
      if (/OK|ERROR|\+QNWINFO|\+CWSAP|CWMODE/i.test(buf)) break;
    }
  }
  return buf;
}

/**
 * Broadband validation: AT+QNWINFO → hotspot AT+CWMODE=3 + AT+CWSAP
 * lalu monitor navigator.connection.downlink > 1 Mbps selama 5 detik.
 */
async function validateBroadbandHotspot(options = {}) {
  const result = {
    INTERNET_VALIDATED: false,
    ssid: null,
    downlinkMbps: null,
    networkInfo: null,
    path: 'at-serial',
    error: null
  };

  try {
    let port = options.port || null;
    if (!port) port = await requestSerialPort();
    const serial = await openSerial(port, options.baudRate || 115200);

    // Cek registrasi network
    const nwInfo = await atCommand(serial, 'AT+QNWINFO');
    result.networkInfo = nwInfo.trim();

    // Aktifkan hotspot (softAP)
    await atCommand(serial, 'AT+CWMODE=3');
    const ssid = options.ssid || 'BCGO-SAT-HOTSPOT';
    const pass = options.password || 'bcgo1234';
    await atCommand(serial, `AT+CWSAP="${ssid}","${pass}",1,3`);
    result.ssid = ssid;

    // Monitor throughput
    const ok = await monitorDownlink(5_000, 1.0);
    result.downlinkMbps = ok.avgMbps;
    result.INTERNET_VALIDATED = ok.valid;

    try { serial.writer?.releaseLock?.(); } catch {}
    try { serial.reader?.releaseLock?.(); } catch {}
  } catch (err) {
    result.error = err.message;
    result.path = 'fallback-signal';
    // Fallback: Signal Strength / Network Information API
    const fb = await fallbackSignalValidation();
    Object.assign(result, fb);
  }

  return result;
}

async function monitorDownlink(durationMs, minMbps) {
  const samples = [];
  const start = Date.now();
  while (Date.now() - start < durationMs) {
    const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    const dl = c?.downlink;
    if (Number.isFinite(dl)) samples.push(dl);
    await new Promise(r => setTimeout(r, 500));
  }
  const avg = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
  return { avgMbps: Math.round(avg * 100) / 100, valid: avg > minMbps, samples: samples.length };
}

async function fallbackSignalValidation() {
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const downlink = c?.downlink ?? null;
  const effectiveType = c?.effectiveType ?? null;
  const validated = Number.isFinite(downlink) && downlink >= 0.5;
  return {
    INTERNET_VALIDATED: validated,
    downlinkMbps: downlink,
    effectiveType,
    path: 'fallback-signal',
    ssid: null
  };
}

// ─── Narrowband / GNSS validation ────────────────────────────────────────────

/**
 * Iridium: Network Capability API atau decode NMEA dari stream virtual.
 * GNSS: parse NMEA sentences ($GPGGA / $GNGGA) untuk Fix Quality.
 */
function validateNarrowbandOrGnss({ constellId, nmeaText, signalStrength }) {
  const type = classifyConnection(constellId);
  const result = {
    SIGNAL_VALIDATED: false,
    fixQuality: null,
    satellitesInView: null,
    path: type,
    error: null
  };

  if (type === CONNECTION_TYPE.GNSS && nmeaText) {
    const gga = nmeaText.split(/\r?\n/).find(l => /\$G[PN]GGA/.test(l));
    if (gga) {
      const parts = gga.split(',');
      // GGA: fix quality = field 6, sats = field 7
      const fq = parseInt(parts[6], 10);
      const sats = parseInt(parts[7], 10);
      result.fixQuality = Number.isFinite(fq) ? fq : null;
      result.satellitesInView = Number.isFinite(sats) ? sats : null;
      result.SIGNAL_VALIDATED = fq >= 1;
    }
  } else if (type === CONNECTION_TYPE.NARROWBAND) {
    // Signal strength proxy
    const ss = signalStrength ?? (navigator.connection?.downlink);
    result.SIGNAL_VALIDATED = Number.isFinite(ss) ? ss > 0 : false;
    result.path = 'signal-strength-api';
  }

  return result;
}

// ─── Unified HAL entry point ─────────────────────────────────────────────────

/**
 * Panggil saat LOCK_ACQUIRED terpicu.
 * @returns {Promise<object>} validation status
 */
async function onLockAcquired({
  constellId,
  snrDb,
  elevationDeg,
  per,
  nmeaText,
  serialPort,
  ssid
} = {}) {
  const lock = evaluateLock({ constellId, snrDb, elevationDeg, per });
  if (!lock.locked) {
    return {
      event: 'LOCK_REJECTED',
      lock,
      INTERNET_VALIDATED: false,
      SIGNAL_VALIDATED: false
    };
  }

  const type = lock.type;
  let validation = {};

  if (type === CONNECTION_TYPE.BROADBAND) {
    validation = await validateBroadbandHotspot({ port: serialPort, ssid });
  } else {
    validation = validateNarrowbandOrGnss({
      constellId,
      nmeaText,
      signalStrength: snrDb
    });
  }

  return {
    event: 'LOCK_ACQUIRED',
    lock,
    type,
    ...validation,
    timestamp: Date.now()
  };
}

// ─── Existing SDR / WebUSB path (preserved) ──────────────────────────────────

async function initPhysicalConnection(options = {}) {
  assertWebUSB();
  const config = { ...DEFAULTS, ...options };
  validateConfig(config);

  const device = await navigator.usb.requestDevice({
    filters: [{ vendorId: config.vendorId, productId: config.productId }]
  });

  if (!device) throw new Error('Perangkat USB tidak dipilih.');
  await device.open();
  if (!device.configuration) await device.selectConfiguration(1);
  await device.claimInterface(config.interfaceNumber);

  return { device, config, openedAt: Date.now() };
}

function writeUsbChunkToWasm(wasmMemory, offset, data) {
  if (!(wasmMemory instanceof WebAssembly.Memory)) throw new TypeError('wasmMemory tidak valid');
  if (!Number.isInteger(offset) || offset < 0) throw new RangeError('offset tidak valid');

  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const memory = new Uint8Array(wasmMemory.buffer);
  if (offset + bytes.byteLength > memory.byteLength) {
    throw new RangeError('IQ chunk berada di luar Wasm memory');
  }
  memory.set(bytes, offset);
}

function startRawIQStream({ connection, wasmMemory, wasmExports, signal, onChunk, onError, onStop }) {
  if (!connection?.device) throw new TypeError('connection.device diperlukan');
  if (!(wasmMemory instanceof WebAssembly.Memory)) throw new TypeError('wasmMemory diperlukan');
  if (!wasmExports || typeof wasmExports.getNextWriteOffset !== 'function' || typeof wasmExports.processIQChunk !== 'function') {
    throw new TypeError('getNextWriteOffset() dan processIQChunk() diperlukan');
  }

  const { device, config } = connection;
  let running = true;
  let failures = 0;
  const stop = () => { running = false; };

  if (signal) {
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  }

  (async () => {
    try {
      while (running) {
        let result;
        try {
          if (!device.opened) throw new Error('USB device tertutup.');
          result = await device.transferIn(config.endpointNumber, config.transferSize);
          failures = 0;
        } catch (error) {
          failures++;
          onError?.(error, failures);
          if (failures > config.maxReconnectAttempts) throw error;
          await new Promise(r => setTimeout(r, config.reconnectDelayMs));
          continue;
        }

        if (!result || result.status !== 'ok' || !result.data?.byteLength) continue;
        const length = result.data.byteLength;
        const offset = wasmExports.getNextWriteOffset(length);
        if (!Number.isInteger(offset) || offset < 0) throw new Error('Wasm write offset tidak valid');

        writeUsbChunkToWasm(wasmMemory, offset, result.data);
        wasmExports.processIQChunk(offset, length, config.sampleRate);
        onChunk?.({ offset, byteLength: length, sampleRate: config.sampleRate, timestamp: performance.now() });
      }
    } catch (error) {
      if (running) onError?.(error, failures);
    } finally {
      running = false;
      onStop?.();
    }
  })();

  return { stop, get running() { return running; } };
}

function calculateDopplerHz(rangeRateMs, carrierHz) {
  if (!Number.isFinite(rangeRateMs) || !Number.isFinite(carrierHz) || carrierHz <= 0) {
    throw new TypeError('rangeRateMs/carrierHz tidak valid');
  }
  return -(rangeRateMs / 299792458) * carrierHz;
}

function uploadDecodedFrameToGPU({ gpuDevice, wasmMemory, yPtr, uvPtr, width, height }) {
  if (!gpuDevice?.queue?.writeTexture) throw new TypeError('gpuDevice WebGPU tidak valid');
  if (!(wasmMemory instanceof WebAssembly.Memory)) throw new TypeError('wasmMemory tidak valid');
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) throw new RangeError('Ukuran frame tidak valid');

  const uvWidth = Math.ceil(width / 2);
  const uvHeight = Math.ceil(height / 2);
  const ySize = width * height;
  const uvSize = uvWidth * uvHeight * 2;
  const memory = new Uint8Array(wasmMemory.buffer);

  if (yPtr < 0 || yPtr + ySize > memory.byteLength) throw new RangeError('Y plane di luar Wasm memory');
  if (uvPtr < 0 || uvPtr + uvSize > memory.byteLength) throw new RangeError('UV plane di luar Wasm memory');

  const yTexture = gpuDevice.createTexture({
    size: [width, height], format: 'r8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
  });
  const uvTexture = gpuDevice.createTexture({
    size: [uvWidth, uvHeight], format: 'rg8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
  });

  gpuDevice.queue.writeTexture({ texture: yTexture }, memory.subarray(yPtr, yPtr + ySize),
    { bytesPerRow: width }, { width, height, depthOrArrayLayers: 1 });
  gpuDevice.queue.writeTexture({ texture: uvTexture }, memory.subarray(uvPtr, uvPtr + uvSize),
    { bytesPerRow: uvWidth * 2 }, { width: uvWidth, height: uvHeight, depthOrArrayLayers: 1 });

  return { yTexture, uvTexture };
}

class SatelliteDisplay {
  constructor({ gpuDevice, wasmMemory, wasmExports, executeGPUPass }) {
    if (!gpuDevice || !(wasmMemory instanceof WebAssembly.Memory) || !wasmExports) throw new TypeError('GPU/Wasm dependency belum lengkap');
    if (typeof executeGPUPass !== 'function') throw new TypeError('executeGPUPass() diperlukan');
    this.gpuDevice = gpuDevice;
    this.wasmMemory = wasmMemory;
    this.wasmExports = wasmExports;
    this.executeGPUPass = executeGPUPass;
    this.lastRenderedEpoch = -Infinity;
  }

  render(decodedFramePtr, telemetryEpoch, width, height) {
    if (!Number.isFinite(telemetryEpoch) || telemetryEpoch <= this.lastRenderedEpoch) return false;
    const getY = this.wasmExports.getYPlanePointer;
    const getUV = this.wasmExports.getUVPlanePointer;
    if (typeof getY !== 'function' || typeof getUV !== 'function') throw new TypeError('Plane pointer export belum tersedia');

    const textures = uploadDecodedFrameToGPU({
      gpuDevice: this.gpuDevice,
      wasmMemory: this.wasmMemory,
      yPtr: getY(decodedFramePtr),
      uvPtr: getUV(decodedFramePtr),
      width, height
    });

    this.lastRenderedEpoch = telemetryEpoch;
    const telemetry = typeof this.wasmExports.getInterpolatedTelemetry === 'function'
      ? this.wasmExports.getInterpolatedTelemetry(telemetryEpoch) : null;

    try {
      this.executeGPUPass(textures.yTexture, textures.uvTexture, telemetry);
    } finally {
      textures.yTexture.destroy();
      textures.uvTexture.destroy();
    }
    return true;
  }
}

export {
  DEFAULTS,
  LOCK_THRESHOLDS,
  CONNECTION_TYPE,
  classifyConnection,
  evaluateLock,
  onLockAcquired,
  validateBroadbandHotspot,
  validateNarrowbandOrGnss,
  fallbackSignalValidation,
  initPhysicalConnection,
  writeUsbChunkToWasm,
  startRawIQStream,
  calculateDopplerHz,
  uploadDecodedFrameToGPU,
  SatelliteDisplay
};
