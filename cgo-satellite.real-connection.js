/**
 * cgo-satellite.real-connection.js
 * LOCAL HARDWARE SDR BRIDGE
 * WebUSB -> IQ buffer -> optional Wasm decoder -> WebGPU upload
 *
 * No server/cloud transport is used.
 * IMPORTANT: WebUSB does NOT expose the USB driver's DMA buffer directly to
 * Wasm, and WebGPU queue.writeTexture() is an upload. This implementation
 * therefore does not make a false zero-copy claim.
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

/**
 * Opens a real USB device. This only establishes USB access; it does NOT
 * pretend that a generic controlTransferOut is enough to initialize an
 * RTL2832U/R820T2. The complete device-specific register/tuner sequence must
 * be supplied by the actual SDR driver layer.
 */
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

/** Explicit USB -> Wasm copy. WebUSB cannot hand its browser buffer to Wasm directly. */
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

/** Start a cancellable real USB IQ loop. */
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

/** Doppler calculation only; rangeRate must come from validated telemetry/ephemeris. */
function calculateDopplerHz(rangeRateMs, carrierHz) {
    if (!Number.isFinite(rangeRateMs) || !Number.isFinite(carrierHz) || carrierHz <= 0) {
        throw new TypeError('rangeRateMs/carrierHz tidak valid');
    }
    return -(rangeRateMs / 299792458) * carrierHz;
}

/**
 * Wasm Y/UV -> WebGPU upload. This is an upload/copy path, not zero-copy.
 */
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
    initPhysicalConnection,
    writeUsbChunkToWasm,
    startRawIQStream,
    calculateDopplerHz,
    uploadDecodedFrameToGPU,
    SatelliteDisplay
};
