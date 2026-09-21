// FILE: ht-protocol.js | DEPS: none | EXPORTS: MAGIC_BYTE, PACKET_SIZE, CHANNEL_COUNT, PROTOCOL_VER, STATUS_FLAGS, crc16ccitt, fnv1aHash, encodeHTPacket, decodeHTPacket

const MAGIC_BYTE = 0xB7;
const PACKET_SIZE = 32;
const CHANNEL_COUNT = 16;
const PROTOCOL_VER = 0x02;

const STATUS_FLAGS = Object.freeze({
  PTT_ACTIVE: 0x01,
  EMERGENCY: 0x02,
  WARN: 0x04,
  GPS_INVALID: 0x08
});

// CRC16 dihitung dari byte 0..17 (inklusif).
// CRC_END bersifat EXCLUSIVE karena loop pakai `i < finish`.
const CRC_START = 0;
const CRC_END = 18;        // EXCLUSIVE — menghitung byte 0..17
const CRC_OFFSET = 18;     // posisi tulis/baca CRC (byte 18-19)

// Batas aman Int32 untuk koordinat (hindari overflow DataView.setInt32)
const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;

// Batas geografis valid
const LAT_MIN = -90;
const LAT_MAX = 90;
const LON_MIN = -180;
const LON_MAX = 180;

const EMPTY_AUTH_TAG = new Uint8Array(4);
const encoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

function crc16ccitt(dataView, start, end) {
  if (!(dataView instanceof DataView)) {
    throw new TypeError("dataView harus berupa DataView");
  }

  const begin = Math.max(0, start | 0);
  const finish = Math.min(dataView.byteLength, end | 0);
  let crc = 0xFFFF;

  for (let i = begin; i < finish; i++) {
    crc ^= dataView.getUint8(i) << 8;

    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000)
        ? ((crc << 1) ^ 0x1021) & 0xFFFF
        : (crc << 1) & 0xFFFF;
    }
  }

  return crc;
}

function fnv1aHash(value) {
  const text = String(value ?? "");
  let hash = 0x811C9DC5;

  if (encoder) {
    const bytes = encoder.encode(text);

    for (let i = 0; i < bytes.length; i++) {
      hash ^= bytes[i];
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }

    return hash >>> 0;
  }

  // ASSUMPTION: Fallback hanya untuk runtime tanpa TextEncoder.
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i) & 0xFF;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash >>> 0;
}

function clampInt(value, min, max) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return min;
  }

  return Math.min(max, Math.max(min, Math.trunc(number)));
}

/**
 * Normalisasi koordinat ke Int32 dengan skala 1e7.
 * FIX #3: tambah clamp ke Int32 range untuk hindari overflow.
 */
function normalizeCoordinate(value, axis) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return 0;
  }

  let coord = number;

  // Clamp ke batas geografis valid dulu
  if (axis === "lat") {
    coord = Math.max(LAT_MIN, Math.min(LAT_MAX, coord));
  } else if (axis === "lon") {
    coord = Math.max(LON_MIN, Math.min(LON_MAX, coord));
  }

  const scaled = Math.trunc(coord * 10_000_000);

  // Clamp ke Int32 range (safety net)
  if (scaled < INT32_MIN) return INT32_MIN;
  if (scaled > INT32_MAX) return INT32_MAX;

  return scaled;
}

function normalizeTimestamp(timestamp) {
  const number = Number(timestamp);

  if (!Number.isFinite(number)) {
    return Date.now() & 0xFFFF;
  }

  return Math.trunc(number) & 0xFFFF;
}

function resolveNicknameHash(agentData) {
  if (agentData.nicknameHash != null) {
    return Number(agentData.nicknameHash) >>> 0;
  }

  if (agentData.callsign != null) {
    return fnv1aHash(agentData.callsign);
  }

  if (agentData.nickname != null) {
    return fnv1aHash(agentData.nickname);
  }

  return 0;
}

function resolveAuthTag(agentData, target, offset) {
  const authTag = agentData.authTag;

  if (authTag == null) {
    target.fill(0, offset, offset + 4);
    return;
  }

  if (
    authTag instanceof Uint8Array ||
    authTag instanceof Uint8ClampedArray ||
    authTag instanceof Int8Array
  ) {
    target.fill(0, offset, offset + 4);
    const length = Math.min(4, authTag.length);

    for (let i = 0; i < length; i++) {
      target[offset + i] = authTag[i] & 0xFF;
    }

    return;
  }

  if (Array.isArray(authTag)) {
    target.fill(0, offset, offset + 4);
    const length = Math.min(4, authTag.length);

    for (let i = 0; i < length; i++) {
      target[offset + i] = Number(authTag[i]) & 0xFF;
    }

    return;
  }

  if (typeof authTag === "number") {
    target[offset] = (authTag >>> 24) & 0xFF;
    target[offset + 1] = (authTag >>> 16) & 0xFF;
    target[offset + 2] = (authTag >>> 8) & 0xFF;
    target[offset + 3] = authTag & 0xFF;
    return;
  }

  target.set(EMPTY_AUTH_TAG, offset);
}

function encodeHTPacket(agentData, outBuffer) {
  if (!agentData || typeof agentData !== "object") {
    throw new TypeError("agentData harus berupa object");
  }

  let target;

  if (outBuffer === undefined) {
    target = new Uint8Array(PACKET_SIZE);
  } else if (outBuffer instanceof Uint8Array) {
    if (outBuffer.byteLength < PACKET_SIZE) {
      throw new RangeError("outBuffer minimal 32 byte");
    }

    target = outBuffer;
  } else {
    throw new TypeError("outBuffer harus berupa Uint8Array");
  }

  const view = new DataView(
    target.buffer,
    target.byteOffset,
    target.byteLength
  );

  target.fill(0, 0, PACKET_SIZE);

  target[0] = MAGIC_BYTE;
  target[1] = clampInt(agentData.sequence ?? 0, 0, 255);

  const agentId = clampInt(agentData.agentId ?? 0, 0, 0xFFFF);
  view.setUint16(2, agentId, false);

  view.setInt32(4, normalizeCoordinate(agentData.latitude, "lat"), false);
  view.setInt32(8, normalizeCoordinate(agentData.longitude, "lon"), false);

  target[12] = clampInt(agentData.status ?? 0, 0, 0xFF);

  target[13] =
    agentData.battery == null
      ? 0xFF
      : clampInt(agentData.battery, 0, 100);

  view.setUint16(14, normalizeTimestamp(agentData.timestamp), false);
  target[16] = clampInt(agentData.signalQuality ?? 0, 0, 100);
  target[17] = clampInt(agentData.channel ?? 0, 0, CHANNEL_COUNT - 1);

  const crc = crc16ccitt(view, CRC_START, CRC_END);
  view.setUint16(CRC_OFFSET, crc, false);

  resolveAuthTag(agentData, target, 20);

  view.setUint32(24, resolveNicknameHash(agentData), false);
  view.setUint16(28, clampInt(agentData.hopCount ?? 0, 0, 0xFFFF), false);

  target[30] = PROTOCOL_VER;
  target[31] = 0x00;

  return target.subarray(0, PACKET_SIZE);
}

function asUint8Array(buffer) {
  if (buffer instanceof Uint8Array) {
    return buffer;
  }

  if (buffer instanceof ArrayBuffer) {
    return new Uint8Array(buffer);
  }

  if (ArrayBuffer.isView(buffer)) {
    return new Uint8Array(
      buffer.buffer,
      buffer.byteOffset,
      buffer.byteLength
    );
  }

  return null;
}

function decodeHTPacket(buffer) {
  const bytes = asUint8Array(buffer);

  if (!bytes || bytes.byteLength !== PACKET_SIZE) {
    return { valid: false, error: "BAD_LENGTH" };
  }

  if (bytes[0] !== MAGIC_BYTE) {
    return { valid: false, error: "BAD_MAGIC" };
  }

  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength
  );

  const expectedCrc = view.getUint16(18, false);
  const actualCrc = crc16ccitt(view, CRC_START, CRC_END);

  if (expectedCrc !== actualCrc) {
    return { valid: false, error: "CRC_MISMATCH" };
  }

  if (bytes[30] !== PROTOCOL_VER) {
    return { valid: false, error: "BAD_VERSION" };
  }

  const status = bytes[12];

  // FIX #2: gunakan subarray (view) untuk authTag, bukan slice (copy).
  // Caller yang butuh persist harus copy sendiri.
  const authTagView = bytes.subarray(20, 24);

  return {
    valid: true,
    data: {
      sequence: bytes[1],
      agentId: view.getUint16(2, false),
      latitude: view.getInt32(4, false) / 10_000_000,
      longitude: view.getInt32(8, false) / 10_000_000,
      latitudeRaw: view.getInt32(4, false),
      longitudeRaw: view.getInt32(8, false),
      status,
      pttActive: (status & STATUS_FLAGS.PTT_ACTIVE) !== 0,
      emergency: (status & STATUS_FLAGS.EMERGENCY) !== 0,
      warn: (status & STATUS_FLAGS.WARN) !== 0,
      gpsInvalid: (status & STATUS_FLAGS.GPS_INVALID) !== 0,
      battery: bytes[13] === 0xFF ? null : bytes[13],
      timestampModulo: view.getUint16(14, false),
      signalQuality: bytes[16],
      // FIX #4: mask channel ke 0-15 untuk cegah nilai invalid dari paket corrupt
      channel: bytes[17] & 0x0F,
      crc: expectedCrc,
      authTag: authTagView,
      nicknameHash: view.getUint32(24, false),
      hopCount: view.getUint16(28, false),
      protocolVersion: bytes[30]
    }
  };
}

export {
  MAGIC_BYTE,
  PACKET_SIZE,
  CHANNEL_COUNT,
  PROTOCOL_VER,
  STATUS_FLAGS,
  crc16ccitt,
  fnv1aHash,
  encodeHTPacket,
  decodeHTPacket
};
