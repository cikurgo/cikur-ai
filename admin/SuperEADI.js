/**
 * SuperEADI.js - Ratio-based DCT Watermarking (Titanium Grade)
 * Berjalan 100% Client-Side menggunakan Canvas 2D.
 */

const clamp = v => Math.max(0, Math.min(255, Math.round(v)));

// Luminance (Y) conversion (BT.709)
const rgbToY = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

// Helpers to get/set an 8x8 block of Y values
const getBlock = (data, w, h, bx, by) => {
  const block = Array.from({ length: 8 }, () => Array(8).fill(0));
  for (let x = 0; x < 8; x++) {
    const ry = by + x;
    if (ry >= h) continue;
    for (let y = 0; y < 8; y++) {
      const cx = bx + y;
      if (cx >= w) continue;
      const idx = (ry * w + cx) * 4;
      block[x][y] = rgbToY(data[idx], data[idx + 1], data[idx + 2]);
    }
  }
  return block;
};

const setBlock = (data, w, h, bx, by, block) => {
  for (let x = 0; x < 8; x++) {
    const ry = by + x;
    if (ry >= h) continue;
    for (let y = 0; y < 8; y++) {
      const cx = bx + y;
      if (cx >= w) continue;
      const idx = (ry * w + cx) * 4;
      const val = clamp(block[x][y]);
      // Simpan kembali sebagai grayscale (R=G=B) untuk akurasi Luminance
      data[idx] = data[idx + 1] = data[idx + 2] = val;
    }
  }
};

// 8x8 2-D DCT / IDCT
const C = u => (u === 0 ? 1 / Math.sqrt(2) : 1);

const dct2D = block => {
  const coeff = Array.from({ length: 8 }, () => Array(8).fill(0));
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      let sum = 0;
      for (let x = 0; x < 8; x++)
        for (let y = 0; y < 8; y++)
          sum += block[x][y] * Math.cos((2 * x + 1) * u * Math.PI / 16) * Math.cos((2 * y + 1) * v * Math.PI / 16);
      coeff[u][v] = 0.25 * C(u) * C(v) * sum;
    }
  }
  return coeff;
};

const idct2D = coeff => {
  const block = Array.from({ length: 8 }, () => Array(8).fill(0));
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 8; y++) {
      let sum = 0;
      for (let u = 0; u < 8; u++)
        for (let v = 0; v < 8; v++)
          sum += C(u) * C(v) * coeff[u][v] * Math.cos((2 * x + 1) * u * Math.PI / 16) * Math.cos((2 * y + 1) * v * Math.PI / 16);
      block[x][y] = 0.25 * sum;
    }
  }
  return block;
};

// Kunci koefisien DCT yang digunakan (Mid-Frequency)
const U1 = 4, V1 = 5;
const U2 = 5, V2 = 4;
const DELTA = 25; // Jarak rasio. Semakin besar, semakin tahan kompresi, tapi visual bisa berubah.

// --- FUNGSI EMBED ---
const embedSVD = (imageElement, payload) => {
  if (!/^[01]+$/.test(payload)) throw new Error('Payload must be binary string');

  const width = imageElement.naturalWidth || imageElement.width;
  const height = imageElement.naturalHeight || imageElement.height;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(imageElement, 0, 0);
  const imgData = ctx.getImageData(0, 0, width, height);
  const data = imgData.data;

  let bitIdx = 0;
  // Iterasi per blok 8x8
  for (let by = 0; by < height; by += 8) {
    for (let bx = 0; bx < width; bx += 8) {
      if (bitIdx >= payload.length) break; // Hentikan jika payload habis

      const block = getBlock(data, width, height, bx, by);
      const coeff = dct2D(block);
      
      const bit = payload[bitIdx] === '1' ? 1 : 0;

      // Ratio-based embedding logic:
      // Kita memanipulasi selisih antara coeff[U1][V1] dan coeff[U2][V2]
      let c1 = coeff[U1][V1];
      let c2 = coeff[U2][V2];

      if (bit === 1) {
        if (c1 - c2 < DELTA) {
          c1 = (c1 + c2) / 2 + DELTA / 2;
          c2 = (c1 + c2) / 2 - DELTA / 2; // Trik matematika
        }
      } else {
        if (c2 - c1 < DELTA) {
          c1 = (c1 + c2) / 2 - DELTA / 2;
          c2 = (c1 + c2) / 2 + DELTA / 2;
        }
      }

      coeff[U1][V1] = c1;
      coeff[U2][V2] = c2;

      // Inverse DCT untuk mengembalikan ke pixel
      const newBlock = idct2D(coeff);
      setBlock(data, width, height, bx, by, newBlock);
      bitIdx++;
    }
    if (bitIdx >= payload.length) break;
  }

  ctx.putImageData(imgData, 0, 0);
  return canvas;
};

// --- FUNGSI EXTRACT ---
const extractSVD = (imageElement, payloadLength) => {
  const width = imageElement.naturalWidth || imageElement.width;
  const height = imageElement.naturalHeight || imageElement.height;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(imageElement, 0, 0);
  const data = ctx.getImageData(0, 0, width, height).data;

  let binaryString = '';

  for (let by = 0; by < height; by += 8) {
    for (let bx = 0; bx < width; bx += 8) {
      if (binaryString.length >= payloadLength) return binaryString;

      const block = getBlock(data, width, height, bx, by);
      const coeff = dct2D(block);
      
      const c1 = coeff[U1][V1];
      const c2 = coeff[U2][V2];

      // Jika c1 > c2, berarti bit '1'. Jika c2 > c1, bit '0'.
      if (c1 > c2) {
        binaryString += '1';
      } else {
        binaryString += '0';
      }
    }
  }
  return binaryString;
};
