/**
 * cgo-satellite-physical.js
 * ============================================================
 * Physical Satellite Adapter — transport layer only.
 *
 * Prinsip:
 *   BCGO packet 32-byte -> modem -> satellite service -> remote endpoint.
 *
 * File ini TIDAK mensimulasikan orbit. Ia menyediakan adapter hardware nyata.
 * Default adapter menggunakan Web Serial + AT command untuk modem Iridium SBD.
 * Browser harus berjalan di secure context dan hardware/service harus benar-benar
 * tersedia. Tidak ada kredensial/provider secret yang ditanam di source.
 *
 * EXPORTS: PhysicalSatelliteAdapter, IridiumSBDSerialAdapter,
 *          getPhysicalSatellite, setPhysicalSatellite
 * ============================================================
 */

const DEFAULT_BAUD_RATE = 19200;
const DEFAULT_TIMEOUT_MS = 30000;

function assertPacket(packet) {
  if (!(packet instanceof Uint8Array) || packet.byteLength !== 32) {
    throw new TypeError('[PhysicalSAT] packet harus Uint8Array 32-byte');
  }
}

function checksum16(bytes) {
  let sum = 0;
  for (const b of bytes) sum = (sum + b) & 0xFFFF;
  return sum;
}

function hexByte(v) {
  return v.toString(16).padStart(2, '0').toUpperCase();
}

class PhysicalSatelliteAdapter {
  constructor() { this.connected = false; }
  isConnected() { return this.connected === true; }
  async connect() { throw new Error('connect() belum diimplementasikan'); }
  async disconnect() { this.connected = false; }
  async sendPacket(_packet, _meta = {}) { throw new Error('sendPacket() belum diimplementasikan'); }
  async receivePacket() { return null; }
}

class IridiumSBDSerialAdapter extends PhysicalSatelliteAdapter {
  constructor(options = {}) {
    super();
    this.port = options.port || null;
    this.baudRate = options.baudRate ?? DEFAULT_BAUD_RATE;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.writer = null;
    this.reader = null;
    this._textBuffer = '';
    this.onStatus = options.onStatus || null;
  }

  async connect(port = this.port) {
    if (!port) {
      if (typeof navigator === 'undefined' || !navigator.serial) {
        throw new Error('[PhysicalSAT] Web Serial tidak tersedia pada runtime ini');
      }
      port = await navigator.serial.requestPort();
    }
    this.port = port;
    if (!this.port.readable && !this.port.writable) {
      await this.port.open({ baudRate: this.baudRate });
    }
    this.writer = this.port.writable?.getWriter?.() || null;
    this.connected = !!this.writer;
    this.onStatus?.({ connected: this.connected, adapter: 'iridium-sbd-serial' });
    return this.connected;
  }

  async disconnect() {
    try { await this.reader?.cancel?.(); } catch {}
    try { this.reader?.releaseLock?.(); } catch {}
    try { this.writer?.releaseLock?.(); } catch {}
    this.reader = null;
    this.writer = null;
    try { await this.port?.close?.(); } catch {}
    this.connected = false;
    this.onStatus?.({ connected: false, adapter: 'iridium-sbd-serial' });
  }

  async _write(bytes) {
    if (!this.writer) throw new Error('[PhysicalSAT] serial writer belum siap');
    await this.writer.write(bytes);
  }

  async _writeAscii(text) {
    await this._write(new TextEncoder().encode(text));
  }

  async _readUntil(predicate, timeoutMs = this.timeoutMs) {
    const decoder = new TextDecoder();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.port?.readable) throw new Error('[PhysicalSAT] serial readable tidak tersedia');
      if (!this.reader) this.reader = this.port.readable.getReader();
      const { value, done } = await Promise.race([
        this.reader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('SERIAL_TIMEOUT')), 1000))
      ]).catch(err => { if (err.message === 'SERIAL_TIMEOUT') return { value: undefined, done: false }; throw err; });
      if (done) break;
      if (value) {
        this._textBuffer += decoder.decode(value, { stream: true });
        const lines = this._textBuffer.split(/\r?\n/);
        this._textBuffer = lines.pop() || '';
        for (const line of lines) {
          const clean = line.trim();
          if (clean && predicate(clean)) return clean;
        }
      }
    }
    throw new Error('[PhysicalSAT] response timeout');
  }

  async _command(command, expected = /^(OK|READY|SBDIX)/) {
    await this._writeAscii(`${command}\r`);
    return this._readUntil(line => expected.test(line));
  }

  /**
   * Sends one 32-byte BCGO frame using Iridium SBD Mobile-Originated data.
   * The modem/service subscription and antenna are external physical requirements.
   */
  async sendPacket(packet, meta = {}) {
    assertPacket(packet);
    if (!this.isConnected()) throw new Error('[PhysicalSAT] modem belum connected');

    await this._writeAscii(`AT+SBDWB=${packet.byteLength}\r`);
    await this._readUntil(line => line === 'READY');

    const frame = new Uint8Array(packet.byteLength + 2);
    frame.set(packet, 0);
    const sum = checksum16(packet);
    frame[packet.byteLength] = (sum >> 8) & 0xFF;
    frame[packet.byteLength + 1] = sum & 0xFF;
    await this._write(frame);

    await this._readUntil(line => /^0\s*$/.test(line) || /SBDWB/i.test(line));
    const session = await this._command('AT+SBDIX', /^\+SBDIX:/);

    this.onStatus?.({
      connected: true,
      state: 'PHYSICAL_SAT_TX',
      session,
      channel: meta.channel,
      emergency: meta.emergency === true
    });

    return { success: true, delivered: true, path: 'physical-sat', session };
  }

  async receivePacket() {
    if (!this.isConnected()) return null;
    await this._writeAscii('AT+SBDIX\r');
    const session = await this._readUntil(line => /^\+SBDIX:/.test(line));
    // MT parsing intentionally remains adapter-specific; never fabricate a packet.
    return { session, packet: null };
  }
}

let _physicalSatellite = null;
function getPhysicalSatellite() {
  if (!_physicalSatellite) _physicalSatellite = new PhysicalSatelliteAdapter();
  return _physicalSatellite;
}
function setPhysicalSatellite(adapter) {
  if (adapter != null && typeof adapter.sendPacket !== 'function') {
    throw new TypeError('[PhysicalSAT] adapter harus memiliki sendPacket()');
  }
  _physicalSatellite = adapter || new PhysicalSatelliteAdapter();
  return _physicalSatellite;
}

export {
  PhysicalSatelliteAdapter,
  IridiumSBDSerialAdapter,
  getPhysicalSatellite,
  setPhysicalSatellite,
  checksum16,
  hexByte
};
