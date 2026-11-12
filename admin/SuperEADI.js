/**
 * SuperEADI.js v3.0 – Ratio-based DCT Watermarking (Titanium Grade)
 * NEXUS core · 100% client-side (Canvas 2D / OffscreenCanvas), tanpa dependensi.
 *
 * API utama : window.NexusEADI (juga module.exports)
 * Kompatibel: dct2D, idct2D, embedSVD, extractSVD tetap tersedia sebagai global bila belum dipakai.
 *
 * Baru v3: redundansi + voting lunak (tahan kompresi), kunci sebar blok, framing payload ber-CRC32
 *          (embedBytes/embedText tanpa perlu tahu panjang), laporan PSNR.
 * Perbaikan utama v2:
 *  - Rumus rata-rata embed diperbaiki (c2 dulu memakai c1 yang sudah berubah).
 *  - Warna asli dipertahankan (hanya luminans yang digeser, bukan diubah jadi abu-abu).
 *  - Tiap blok diverifikasi pasca-kuantisasi 8-bit dan diperkuat otomatis bila lemah.
 *  - Hanya blok 8×8 penuh yang dipakai (blok tepi berpadding nol tidak bisa diekstrak andal).
 *  - Validasi input, cek kapasitas, penanganan canvas tercemar, DCT berbasis tabel (jauh lebih cepat).
 */
(function (global) {
  'use strict';

  const clamp = v => Math.max(0, Math.min(255, Math.round(v)));
  // Luminans (Y) – koefisien BT.601 (dipertahankan agar kompatibel dengan gambar lama)
  const rgbToY = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

  // Koefisien DCT mid-frequency yang dipakai
  const U1 = 4, V1 = 5, U2 = 5, V2 = 4;
  const DELTA = 25;            // jarak rasio: makin besar makin tahan kompresi, visual makin terlihat
  const MAX_ATTEMPTS = 5, MAX_PIXELS = 100e6;

  /*---------------------- DCT 8×8 (separabel, tabel cosinus) ----------------------*/
  const COS = Array.from({ length: 8 }, (_, u) => Array.from({ length: 8 }, (_, x) => Math.cos((2 * x + 1) * u * Math.PI / 16)));
  const C = u => (u === 0 ? Math.SQRT1_2 : 1);
  const grid = () => Array.from({ length: 8 }, () => new Array(8).fill(0));

  const dct2D = block => {
    const tmp = grid(), coeff = grid();
    for (let u = 0; u < 8; u++) for (let y = 0; y < 8; y++) {
      let s = 0; for (let x = 0; x < 8; x++) s += block[x][y] * COS[u][x];
      tmp[u][y] = s;
    }
    for (let u = 0; u < 8; u++) for (let v = 0; v < 8; v++) {
      let s = 0; for (let y = 0; y < 8; y++) s += tmp[u][y] * COS[v][y];
      coeff[u][v] = 0.25 * C(u) * C(v) * s;
    }
    return coeff;
  };
  const idct2D = coeff => {
    const tmp = grid(), block = grid();
    for (let u = 0; u < 8; u++) for (let y = 0; y < 8; y++) {
      let s = 0; for (let v = 0; v < 8; v++) s += C(v) * coeff[u][v] * COS[v][y];
      tmp[u][y] = s;
    }
    for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) {
      let s = 0; for (let u = 0; u < 8; u++) s += C(u) * tmp[u][y] * COS[u][x];
      block[x][y] = 0.25 * s;
    }
    return block;
  };

  /*---------------------- Blok & piksel ----------------------*/
  // Blok Y 8×8 (nol bila di luar gambar) – dipertahankan untuk kompatibilitas
  const getBlock = (data, w, h, bx, by) => {
    const block = grid();
    for (let x = 0; x < 8; x++) {
      if (by + x >= h) continue;
      for (let y = 0; y < 8; y++) {
        if (bx + y >= w) continue;
        const i = ((by + x) * w + bx + y) * 4;
        block[x][y] = rgbToY(data[i], data[i + 1], data[i + 2]);
      }
    }
    return block;
  };

  /* Tanamkan satu bit ke satu blok penuh. true bila margin akhir cukup kuat. */
  function embedBlock(data, w, bx, by, bit, delta) {
    const Y0 = grid(), px = [];
    for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) {
      const i = ((by + x) * w + bx + y) * 4;
      px.push(i); Y0[x][y] = rgbToY(data[i], data[i + 1], data[i + 2]);
    }
    const c = dct2D(Y0), margin = (a, b) => (bit ? a - b : b - a);
    if (margin(c[U1][V1], c[U2][V2]) >= delta) return true;      // sudah memenuhi
    const m = (c[U1][V1] + c[U2][V2]) / 2;                       // rata-rata dihitung SEBELUM diubah
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const d = delta * (1 + 0.5 * attempt), cc = c.map(r => r.slice());
      cc[U1][V1] = bit ? m + d / 2 : m - d / 2;
      cc[U2][V2] = bit ? m - d / 2 : m + d / 2;
      const Yn = idct2D(cc), out = [], Yq = grid();
      px.forEach((i, k) => {
        const x = k >> 3, y = k & 7, dY = Yn[x][y] - Y0[x][y];   // geser Y, pertahankan warna
        const r = clamp(data[i] + dY), g = clamp(data[i + 1] + dY), b = clamp(data[i + 2] + dY);
        out.push(r, g, b); Yq[x][y] = rgbToY(r, g, b);
      });
      const q = dct2D(Yq), ok = margin(q[U1][V1], q[U2][V2]) >= delta / 2;   // cek setelah kuantisasi 8-bit
      if (ok || attempt === MAX_ATTEMPTS - 1) {
        px.forEach((i, k) => { data[i] = out[k * 3]; data[i + 1] = out[k * 3 + 1]; data[i + 2] = out[k * 3 + 2]; });
        return ok;
      }
    }
    return false;
  }

  /*---------------------- Sumber gambar & canvas ----------------------*/
  function dimsOf(src) {
    if (!src || typeof src !== 'object') throw new TypeError('Sumber gambar tidak valid (butuh img/canvas/ImageBitmap)');
    if ('complete' in src && (!src.complete || (src.naturalWidth === 0 && !src.width))) throw new Error('Gambar belum selesai dimuat atau rusak');
    const w = src.naturalWidth || src.videoWidth || src.width, h = src.naturalHeight || src.videoHeight || src.height;
    if (!(w > 0 && h > 0)) throw new Error('Dimensi gambar tidak valid');
    if (w * h > MAX_PIXELS) throw new RangeError('Gambar terlalu besar (maks 100 megapiksel)');
    return { w: Math.floor(w), h: Math.floor(h) };
  }
  function makeCanvas(w, h) {
    if (typeof document !== 'undefined') { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    throw new Error('Canvas 2D tidak tersedia di lingkungan ini');
  }
  function readPixels(src) {
    const { w, h } = dimsOf(src), canvas = makeCanvas(w, h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Tidak dapat membuat konteks Canvas 2D');
    ctx.drawImage(src, 0, 0);
    let imgData;
    try { imgData = ctx.getImageData(0, 0, w, h); }
    catch (e) { throw new Error('Canvas tercemar: gambar lintas-origin tanpa CORS tidak dapat dibaca (' + (e && e.name || 'SecurityError') + ')'); }
    return { w, h, canvas, ctx, imgData };
  }

  /*---------------------- Tata letak blok (redundansi + kunci sebar) ----------------------*/
  const strSeed = s => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
  const mulberry = a => () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  function parseOpts(opts, w, h) {
    const o = opts || {}, delta = o.delta > 0 ? +o.delta : DELTA, rep = o.redundancy === undefined ? 1 : Math.floor(+o.redundancy);
    if (!(rep >= 1 && rep <= 99) || !Number.isFinite(rep)) throw new RangeError('redundancy harus bilangan bulat 1-99');
    const total = (w >> 3) * (h >> 3), order = Array.from({ length: total }, (_, i) => i);
    if (o.key !== undefined && o.key !== '') { const rnd = mulberry(strSeed(o.key)); for (let i = total - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; } }
    return { delta, rep, order, total, cap: Math.floor(total / rep), bw: w >> 3 };
  }
  const blockXY = (L, idx) => { const b = L.order[idx]; return [(b % L.bw) * 8, Math.floor(b / L.bw) * 8]; };
  const capacityOf = (w, h, opts) => parseOpts(opts, w, h).cap;
  const capacity = (src, opts) => { const { w, h } = dimsOf(src); return capacityOf(w, h, opts); };
  const psnrOf = (a, b) => { let se = 0, n = 0; for (let i = 0; i < a.length; i += 4) for (let k = 0; k < 3; k++) { const d = a[i + k] - b[i + k]; se += d * d; n++; } return se === 0 ? Infinity : 10 * Math.log10(255 * 255 / (se / n)); };

  /*---------------------- EMBED ----------------------*/
  // opts: { delta=25, redundancy=1, key }. redundancy=r → tiap bit ditanam di r blok berjauhan (voting lunak saat ekstrak).
  const embedSVD = (imageElement, payload, opts) => {
    if (typeof payload !== 'string' || !/^[01]+$/.test(payload)) throw new Error('Payload must be binary string');
    const { w, h, canvas, ctx, imgData } = readPixels(imageElement), L = parseOpts(opts, w, h);
    if (payload.length > L.cap) throw new RangeError(`Payload ${payload.length} bit melebihi kapasitas gambar (${L.cap} bit pada redundancy ${L.rep})`);
    const data = imgData.data, before = data.slice(); let weak = 0;
    for (let i = 0; i < payload.length; i++) {
      const bit = payload.charCodeAt(i) === 49 ? 1 : 0;
      for (let k = 0; k < L.rep; k++) { const [bx, by] = blockXY(L, i + k * L.cap); if (!embedBlock(data, w, bx, by, bit, L.delta)) weak++; }
    }
    ctx.putImageData(imgData, 0, 0);
    canvas.nexusReport = { bits: payload.length, capacity: L.cap, redundancy: L.rep, weakBlocks: weak, delta: L.delta, psnr: psnrOf(before, data) };
    return canvas;
  };

  /*---------------------- EXTRACT ----------------------*/
  function readBits(data, w, h, n, L) {
    const bits = [], m = Math.min(n, L.cap);
    for (let i = 0; i < m; i++) {
      let sum = 0;
      for (let k = 0; k < L.rep; k++) { const [bx, by] = blockXY(L, i + k * L.cap), c = dct2D(getBlock(data, w, h, bx, by)); sum += c[U1][V1] - c[U2][V2]; }
      bits.push(sum > 0 ? '1' : '0');                              // r=1 identik dengan aturan lama: c1 > c2 → '1'
    }
    return bits.join('');
  }
  const extractSVD = (imageElement, payloadLength, opts) => {
    const n = Math.floor(+payloadLength);
    if (!Number.isFinite(n) || n < 1) throw new RangeError('payloadLength harus bilangan bulat positif');
    const { w, h, imgData } = readPixels(imageElement);
    return readBits(imgData.data, w, h, n, parseOpts(opts, w, h));
  };

  /*---------------------- Framing ber-CRC32 (tanpa perlu panjang) ----------------------*/
  // Header 72 bit: magic "NX"(16) ‖ versi(8) ‖ panjang byte(16) ‖ CRC32 payload(32), lalu payload.
  const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = u8 => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const HDR_BITS = 72;
  const bytesToBits = u8 => Array.from(u8, b => b.toString(2).padStart(8, '0')).join('');
  const bitsToBytes = bits => Uint8Array.from(bits.match(/.{8}/g) || [], b => parseInt(b, 2));
  function embedBytes(imageElement, bytes, opts) {
    const u8 = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    if (u8.length > 65535) throw new RangeError('Payload maksimum 65535 byte');
    const hd = new Uint8Array(9), dv = new DataView(hd.buffer);
    dv.setUint16(0, 0x4E58); hd[2] = 1; dv.setUint16(3, u8.length); dv.setUint32(5, crc32(u8));
    return embedSVD(imageElement, bytesToBits(hd) + bytesToBits(u8), opts);
  }
  /* Hasil: { ok, bytes, length, crcOk, reason } – tidak melempar untuk gambar tanpa watermark. */
  function extractBytes(imageElement, opts) {
    const { w, h, imgData } = readPixels(imageElement), L = parseOpts(opts, w, h), data = imgData.data;
    if (L.cap < HDR_BITS) return { ok: false, reason: 'Gambar terlalu kecil' };
    const hd = bitsToBytes(readBits(data, w, h, HDR_BITS, L)), dv = new DataView(hd.buffer);
    if (dv.getUint16(0) !== 0x4E58 || hd[2] !== 1) return { ok: false, reason: 'Tanda watermark tidak ditemukan (kunci/redundancy salah, atau gambar rusak)' };
    const len = dv.getUint16(3), crc = dv.getUint32(5);
    if (HDR_BITS + len * 8 > L.cap) return { ok: false, reason: 'Panjang di header melebihi kapasitas' };
    const body = bitsToBytes(readBits(data, w, h, HDR_BITS + len * 8, L).slice(HDR_BITS)), crcOk = crc32(body) === crc;
    return { ok: crcOk, bytes: body, length: len, crcOk, reason: crcOk ? '' : 'CRC tidak cocok (payload rusak)' };
  }
  const embedText = (img, text, opts) => embedBytes(img, new TextEncoder().encode(String(text)), opts);
  const extractText = (img, opts) => { const r = extractBytes(img, opts); return r.ok ? { ...r, text: new TextDecoder().decode(r.bytes) } : r; };

  /*---------------------- Helper bit ----------------------*/
  const textToBits = s => Array.from(new TextEncoder().encode(String(s)), b => b.toString(2).padStart(8, '0')).join('');
  const bitsToText = bits => {
    if (!/^[01]*$/.test(bits)) throw new TypeError('Bukan string biner');
    const bytes = bits.match(/.{8}/g) || [];
    return new TextDecoder().decode(Uint8Array.from(bytes, b => parseInt(b, 2)));
  };
  const hexToBits = hex => {
    if (typeof hex !== 'string' || /[^0-9a-f]/i.test(hex)) throw new TypeError('Hex tidak valid');
    return Array.from(hex, ch => parseInt(ch, 16).toString(2).padStart(4, '0')).join('');
  };
  const bitsToHex = bits => {
    if (!/^[01]*$/.test(bits) || bits.length % 4) throw new TypeError('Bit harus kelipatan 4 dan biner');
    return (bits.match(/.{4}/g) || []).map(b => parseInt(b, 2).toString(16)).join('');
  };

  /*---------------------- Self-test (tanpa canvas) ----------------------*/
  function selfTest() {
    const r = [], t = (name, ok) => r.push({ name, ok: !!ok });
    let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    const blk = grid().map(row => row.map(() => rnd() * 255));
    const back = idct2D(dct2D(blk));
    t('DCT→IDCT bolak-balik', blk.every((row, x) => row.every((v, y) => Math.abs(v - back[x][y]) < 1e-9)));
    const w = 8, mk = () => { const d = new Uint8ClampedArray(256); for (let i = 0; i < 64; i++) { d[i * 4] = 40 + rnd() * 170; d[i * 4 + 1] = 40 + rnd() * 170; d[i * 4 + 2] = 40 + rnd() * 170; d[i * 4 + 3] = 255; } return d; };
    let okAll = true, alphaKept = true;
    for (let n = 0; n < 40; n++) {
      const bit = n & 1, d = mk(); embedBlock(d, w, 0, 0, bit, DELTA);
      const noisy = d.map((v, i) => (i & 3) === 3 ? v : clamp(v + (rnd() * 4 - 2)));       // simulasi derau ±2
      const c = dct2D(getBlock(noisy, 8, 8, 0, 0));
      if ((c[U1][V1] > c[U2][V2] ? 1 : 0) !== bit) okAll = false;
      for (let i = 3; i < 256; i += 4) if (d[i] !== 255) alphaKept = false;
    }
    t('Bit bertahan setelah kuantisasi + derau', okAll);
    t('Kanal alpha tidak berubah', alphaKept);
    t('Helper teks↔bit (UTF-8)', bitsToText(textToBits('Nexus ✓')) === 'Nexus ✓');
    t('Helper hex↔bit', bitsToHex(hexToBits('a5f0')) === 'a5f0');
    t('CRC32 vektor standar', crc32(new TextEncoder().encode('123456789')) === 0xCBF43926);
    t('Tata letak kunci sebar deterministik & permutasi', (() => { const a = parseOpts({ key: 'k' }, 64, 64).order, b = parseOpts({ key: 'k' }, 64, 64).order; return a.join() === b.join() && new Set(a).size === 64; })());
    return { ok: r.every(x => x.ok), results: r };
  }

  /*---------------------- Ekspor ----------------------*/
  const API = { version: '3.0.0', DELTA, dct2D, idct2D, getBlock, rgbToY, embedSVD, extractSVD, capacity,
    embedBytes, extractBytes, embedText, extractText, crc32,
    textToBits, bitsToText, hexToBits, bitsToHex, selfTest };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  global.NexusEADI = API;
  ['dct2D', 'idct2D', 'embedSVD', 'extractSVD'].forEach(n => { if (!(n in global)) global[n] = API[n]; });
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this);
