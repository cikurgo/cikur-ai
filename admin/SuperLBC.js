/*====================================================================*
 * SuperLBC.js v3.0 – Merkle-Patricia Trie + Schnorr BIP-340 (secp256k1)
 * NEXUS core · 100% client-side · tanpa dependensi eksternal.
 * Berjalan di browser (classic/module), Web Worker, dan Node.js.
 *
 * API utama : window.NexusLBC  (juga module.exports)
 * Baru v3  : aritmetika Jacobian + tangga Montgomery (reguler, tanpa invers per langkah),
 *             Schnorr BIP-340 standar (x-only, tagged hash, nonce hedged, self-verify),
 *             bukti Merkle (membership/absence) + serialisasi trie.
 * Kompatibel: canonicalize, MPTNode, MerklePatriciaTrie, SECP256K1, mod,
 *             modInv, pointAdd, pointMultiply, generateSchnorrProof,
 *             verifySchnorrProof tetap tersedia sebagai global bila belum dipakai.
 *====================================================================*/
(function (global) {
  'use strict';

  /*------------------------- 0. Utilitas byte ---------------------------*/
  const enc = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
  const utf8 = s => enc ? enc.encode(s) : Uint8Array.from(unescape(encodeURIComponent(s)), c => c.charCodeAt(0));

  function toBytes(x) {
    if (x instanceof Uint8Array) return x;
    if (typeof x === 'string') return utf8(x);
    if (x instanceof ArrayBuffer) return new Uint8Array(x);
    if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    if (Array.isArray(x)) {
      if (!x.every(b => Number.isInteger(b) && b >= 0 && b <= 255)) throw new TypeError('Array byte harus berisi integer 0-255');
      return Uint8Array.from(x);
    }
    throw new TypeError('Tipe data tidak didukung (butuh Uint8Array, ArrayBuffer, Array byte, atau string)');
  }
  const bytesToHex = b => Array.from(toBytes(b), v => v.toString(16).padStart(2, '0')).join('');
  function hexToBytes(h) {
    if (typeof h !== 'string') throw new TypeError('Hex harus string');
    h = h.replace(/^0x/i, '');
    if (h.length % 2 || /[^0-9a-f]/i.test(h)) throw new TypeError('String hex tidak valid');
    const out = new Uint8Array(h.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
    return out;
  }
  const bytesToInt = b => { const h = bytesToHex(b); return h ? BigInt('0x' + h) : 0n; };
  const intToBytes32 = n => hexToBytes(n.toString(16).padStart(64, '0'));
  function concat(...arr) {
    const parts = arr.map(toBytes), out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  function randomBytes(n) {
    const c = global.crypto;
    if (!c || typeof c.getRandomValues !== 'function') throw new Error('CSPRNG (crypto.getRandomValues) tidak tersedia; penandatanganan dibatalkan demi keamanan');
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i += 65536) c.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
    return out;
  }

  /*------------------------- 1. SHA-256 sinkron -------------------------*/
  const K = new Uint32Array(64), H0 = new Uint32Array(8);
  (function initConst() {
    const primes = []; for (let n = 2; primes.length < 64; n++) if (primes.every(p => n % p)) primes.push(n);
    const frac = v => Math.floor((v - Math.floor(v)) * 4294967296);
    primes.forEach((p, i) => { K[i] = frac(Math.cbrt(p)); if (i < 8) H0[i] = frac(Math.sqrt(p)); });
  })();
  function sha256(data) {
    const msg = toBytes(data), len = msg.length;
    const total = ((len + 9 + 63) >> 6) << 6, buf = new Uint8Array(total);
    buf.set(msg); buf[len] = 0x80;
    const dv = new DataView(buf.buffer);
    dv.setUint32(total - 8, Math.floor(len / 0x20000000), false);
    dv.setUint32(total - 4, (len << 3) >>> 0, false);
    const h = Uint32Array.from(H0), w = new Uint32Array(64);
    const rr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < total; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
      for (let i = 16; i < 64; i++) {
        const s0 = rr(w[i - 15], 7) ^ rr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rr(w[i - 2], 17) ^ rr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i++) {
        const t1 = (hh + (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
        const t2 = ((rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
    }
    const out = new Uint8Array(32), odv = new DataView(out.buffer);
    h.forEach((v, i) => odv.setUint32(i * 4, v, false));
    return out;
  }
  const sha256Hex = d => bytesToHex(sha256(d));

  /*------------------------- 2. Canonical JSON --------------------------*/
  const MAX_DEPTH = 512;
  function canonicalize(node, _seen, _depth) {
    const seen = _seen || new WeakSet(), depth = _depth || 0;
    if (depth > MAX_DEPTH) throw new RangeError('Struktur terlalu dalam untuk dikanonikalkan');
    if (node && typeof node === 'object' && typeof node.toJSON === 'function') node = node.toJSON();
    switch (typeof node) {
      case 'bigint': throw new TypeError('BigInt tidak didukung dalam JSON kanonik (ubah ke string lebih dulu)');
      case 'undefined': case 'function': case 'symbol': return undefined;
      case 'number': return Number.isFinite(node) ? (node === 0 ? 0 : node) : null;
    }
    if (node === null || typeof node !== 'object') return node;
    if (seen.has(node)) throw new TypeError('Referensi melingkar tidak dapat dikanonikalkan');
    seen.add(node);
    try {
      if (ArrayBuffer.isView(node)) node = Array.from(node);
      if (Array.isArray(node)) return node.map(v => { const r = canonicalize(v, seen, depth + 1); return r === undefined ? null : r; });
      const out = {};
      for (const k of Object.keys(node).sort()) {
        const r = canonicalize(node[k], seen, depth + 1);
        if (r !== undefined) Object.defineProperty(out, k, { value: r, enumerable: true, writable: true, configurable: true });
      }
      return out;
    } finally { seen.delete(node); }
  }
  function canonicalJSON(value) {
    const s = JSON.stringify(canonicalize(value));
    if (s === undefined) throw new TypeError('Nilai tidak dapat diserialisasi ke JSON');
    return s;
  }

  /*------------------------- 3. Merkle-Patricia Trie --------------------*/
  const MPT_TAG = utf8('NEXUS/MPT/v1');
  class MPTNode {
    constructor() { this.isLeaf = false; this.value = null; this.children = new Map(); this.hash = null; }
  }
  const HEX_KEY = /^[0-9a-f]+$/i;
  function keyToNibbles(hexKey, strict) {
    if (typeof hexKey !== 'string' || !HEX_KEY.test(hexKey)) {
      if (strict) throw new TypeError('Kunci harus string hex tidak kosong (0-9, a-f)');
      return null;
    }
    return Array.from(hexKey, c => parseInt(c, 16));
  }

  function serializeNode(isLeaf, value, entries) {
    const parts = [MPT_TAG, Uint8Array.of(isLeaf ? 1 : 0)];
    if (isLeaf) { const l = new Uint8Array(4); new DataView(l.buffer).setUint32(0, value.length, false); parts.push(l, value); }
    for (const [nib, h] of entries.slice().sort((a, b) => a[0] - b[0])) parts.push(Uint8Array.of(nib), h);
    return concat(...parts);
  }

  class MerklePatriciaTrie {
    constructor() { this.root = new MPTNode(); this.size = 0; this.root.hash = this._hashNode(this.root); }

    /* hash = SHA-256(tag ‖ flag ‖ [len(4) ‖ value] ‖ (nibble ‖ childHash)*) */
    _serialize(node) {
      return serializeNode(node.isLeaf, node.value, Array.from(node.children.entries()).map(([n, c]) => [n, c.hash]));
    }
    _hashNode(node) { return sha256(this._serialize(node)); }

    _path(nibs) {
      const path = [this.root]; let cur = this.root;
      for (const n of nibs) { cur = cur.children.get(n); if (!cur) return null; path.push(cur); }
      return path;
    }
    _rehash(path) { for (let i = path.length - 1; i >= 0; i--) path[i].hash = this._hashNode(path[i]); }

    /* Sisipkan kunci hex → nilai (Uint8Array/Array byte/ArrayBuffer/string). Mengembalikan root hash (hex). */
    async put(hexKey, valueBuf) { return this.putSync(hexKey, valueBuf); }
    putSync(hexKey, valueBuf) {
      const nibs = keyToNibbles(hexKey, true), value = Uint8Array.from(toBytes(valueBuf));
      const path = [this.root]; let node = this.root;
      for (const n of nibs) {
        if (!node.children.has(n)) { const c = new MPTNode(); c.hash = this._hashNode(c); node.children.set(n, c); }
        node = node.children.get(n); path.push(node);
      }
      if (!node.isLeaf) this.size++;
      node.isLeaf = true; node.value = value;
      this._rehash(path);
      return this.rootHashHex;
    }

    get(hexKey) {
      const nibs = keyToNibbles(hexKey, false), path = nibs && this._path(nibs);
      const node = path && path[path.length - 1];
      return node && node.isLeaf ? Uint8Array.from(node.value) : null;
    }
    has(hexKey) { return this.get(hexKey) !== null; }

    /* Hapus kunci; node kosong dipangkas agar root hash identik dengan trie yang tak pernah memuatnya. */
    delete(hexKey) {
      const nibs = keyToNibbles(hexKey, false), path = nibs && this._path(nibs);
      if (!path || !path[path.length - 1].isLeaf) return false;
      const last = path[path.length - 1]; last.isLeaf = false; last.value = null; this.size--;
      for (let i = path.length - 1; i > 0; i--) {
        if (path[i].isLeaf || path[i].children.size) break;
        path[i - 1].children.delete(nibs[i - 1]); path.length = i;
      }
      this._rehash(path);
      return true;
    }
    clear() { this.root = new MPTNode(); this.size = 0; this.root.hash = this._hashNode(this.root); }


    /* Bukti membership/absence: urutan simpul dari akar; tiap langkah memuat saudara (hash) selain jalur kunci. */
    getProof(hexKey) {
      const nibs = keyToNibbles(hexKey, true), steps = []; let node = this.root, found = true;
      for (let i = 0; i <= nibs.length; i++) {
        const next = i === nibs.length ? null : nibs[i];
        steps.push({ leaf: node.isLeaf, value: node.isLeaf ? bytesToHex(node.value) : null,
          siblings: Array.from(node.children.entries()).filter(([n]) => n !== next).sort((a, b) => a[0] - b[0]).map(([n, c]) => [n, bytesToHex(c.hash)]) });
        if (next === null) break;
        const nx = node.children.get(next);
        if (!nx) { found = false; break; }
        node = nx;
      }
      if (found && !node.isLeaf) found = false;
      return { key: hexKey.toLowerCase(), found, steps };
    }

    /* Serialisasi / pemulihan (mis. localStorage). Root hash bisa diverifikasi saat memuat. */
    toJSON() {
      const out = [], walk = (node, pre) => {
        if (node.isLeaf) out.push([pre, bytesToHex(node.value)]);
        for (const [n, c] of Array.from(node.children.entries()).sort((a, b) => a[0] - b[0])) walk(c, pre + n.toString(16));
      };
      walk(this.root, '');
      return { version: 1, root: this.rootHashHex, entries: out.filter(e => e[0] !== '') };
    }
    static fromJSON(obj, expectedRootHex) {
      if (!obj || obj.version !== 1 || !Array.isArray(obj.entries)) throw new TypeError('Format trie tidak dikenal');
      const t = new MerklePatriciaTrie();
      for (const [k, v] of obj.entries) t.putSync(k, hexToBytes(v));
      const want = (expectedRootHex || obj.root || '').toLowerCase();
      if (want && t.rootHashHex !== want) throw new Error('Root hash tidak cocok: data trie rusak atau diubah');
      return t;
    }

    get rootHash() { return Uint8Array.from(this.root.hash); }
    get rootHashHex() { return bytesToHex(this.root.hash); }
    _traverse(hexKey) { const n = keyToNibbles(hexKey, false), p = n && this._path(n); return p ? p[p.length - 1] : null; }
  }


  /* Verifikasi bukti terhadap root hash tepercaya. Mengembalikan { valid, found, value } (tidak melempar). */
  function verifyMPTProof(rootHashHex, proof) {
    const bad = { valid: false, found: false, value: null };
    try {
      const nibs = keyToNibbles(proof.key, true), steps = proof.steps;
      if (!Array.isArray(steps) || !steps.length || steps.length > nibs.length + 1) return bad;
      let childHash = null;
      for (let i = steps.length - 1; i >= 0; i--) {
        const s = steps[i], entries = s.siblings.map(([n, h]) => {
          const hb = hexToBytes(h);
          if (!Number.isInteger(n) || n < 0 || n > 15 || hb.length !== 32) throw new TypeError('sibling cacat');
          return [n, hb];
        });
        if (i < steps.length - 1) entries.push([nibs[i], childHash]);
        if (new Set(entries.map(e => e[0])).size !== entries.length) return bad;
        const v = s.leaf ? hexToBytes(s.value) : null;
        if (s.leaf && v === null) return bad;
        childHash = sha256(serializeNode(!!s.leaf, v, entries));
      }
      if (bytesToHex(childHash) !== String(rootHashHex).toLowerCase()) return bad;
      const last = steps[steps.length - 1], complete = steps.length === nibs.length + 1;
      if (complete) return last.leaf ? { valid: true, found: true, value: hexToBytes(last.value) } : { valid: true, found: false, value: null };
      if (last.siblings.some(([n]) => n === nibs[steps.length - 1])) return bad;   // pemotongan jalur oleh prover
      return { valid: true, found: false, value: null };
    } catch (e) { return bad; }
  }

  /*------------------------- 4. secp256k1 -------------------------------*/
  const SECP256K1 = Object.freeze({
    P: 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn,
    N: 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n,
    Gx: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
    Gy: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
    B: 7n,
  });
  const G = Object.freeze({ x: SECP256K1.Gx, y: SECP256K1.Gy });

  function mod(n, m) { return ((n % m) + m) % m; }
  function modInv(a, m) {
    a = mod(a, m);
    if (a === 0n) throw new RangeError('Invers modular tidak ada untuk 0');
    let [r0, r1, t0, t1] = [m, a, 0n, 1n];
    while (r1 !== 0n) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [t0, t1] = [t1, t0 - q * t1]; }
    if (r0 !== 1n) throw new RangeError('Invers modular tidak ada (bilangan tidak koprima)');
    return mod(t0, m);
  }
  function isOnCurve(pt) {
    const { P, B } = SECP256K1;
    return !!pt && typeof pt.x === 'bigint' && typeof pt.y === 'bigint' && pt.x >= 0n && pt.x < P && pt.y >= 0n && pt.y < P &&
      mod(pt.y * pt.y - (pt.x * pt.x * pt.x + B), P) === 0n;
  }
  /* ---- Koordinat Jacobian (a = 0): tanpa invers modular per operasi ---- */
  const jInf = () => ({ X: 1n, Y: 1n, Z: 0n });
  const toJ = pt => (pt ? { X: pt.x, Y: pt.y, Z: 1n } : jInf());
  function fromJ(p) {
    if (p.Z === 0n) return null;
    const m = SECP256K1.P, zi = modInv(p.Z, m), zi2 = zi * zi % m;
    return { x: p.X * zi2 % m, y: p.Y * zi2 % m * zi % m };
  }
  function jDouble(p) {
    const m = SECP256K1.P;
    if (p.Z === 0n || p.Y === 0n) return jInf();
    const A = p.X * p.X % m, B = p.Y * p.Y % m, Cc = B * B % m, t = p.X + B;
    const D = mod(2n * (t * t - A - Cc), m), E = 3n * A, F = E * E % m;
    const X3 = mod(F - 2n * D, m);
    return { X: X3, Y: mod(E * (D - X3) - 8n * Cc, m), Z: mod(2n * p.Y * p.Z, m) };
  }
  function jAdd(p, q) {
    if (p.Z === 0n) return q;
    if (q.Z === 0n) return p;
    const m = SECP256K1.P, Z1 = p.Z * p.Z % m, Z2 = q.Z * q.Z % m;
    const U1 = p.X * Z2 % m, U2 = q.X * Z1 % m, S1 = p.Y * q.Z % m * Z2 % m, S2 = q.Y * p.Z % m * Z1 % m;
    if (U1 === U2) return S1 === S2 ? jDouble(p) : jInf();
    const H = mod(U2 - U1, m), R = mod(S2 - S1, m), HH = H * H % m, HHH = H * HH % m, V = U1 * HH % m;
    const X3 = mod(R * R - HHH - 2n * V, m);
    return { X: X3, Y: mod(R * (V - X3) - S1 * HHH, m), Z: H * p.Z % m * q.Z % m };
  }
  /* Tangga Montgomery: 256 iterasi tetap, urutan operasi seragam (add+double tiap bit). */
  function jMul(k, pt) {
    k = mod(k, SECP256K1.N);
    if (k === 0n || !pt) return jInf();
    let R0 = jInf(), R1 = toJ(pt);
    for (let i = 255; i >= 0; i--) {
      if ((k >> BigInt(i)) & 1n) { R0 = jAdd(R0, R1); R1 = jDouble(R1); }
      else { R1 = jAdd(R0, R1); R0 = jDouble(R0); }
    }
    return R0;
  }
  function pointAdd(A, Q) { return fromJ(jAdd(toJ(A), toJ(Q))); }
  function pointMultiply(k, pt) {
    if (typeof k !== 'bigint') throw new TypeError('Skalar harus BigInt');
    return fromJ(jMul(k, pt));
  }
  const samePoint = (a, b) => (!a && !b) || (!!a && !!b && a.x === b.x && a.y === b.y);

  function parsePrivateKey(k) {
    let d;
    if (typeof k === 'bigint') d = k;
    else if (typeof k === 'string') d = bytesToInt(hexToBytes(k));
    else if (k instanceof Uint8Array || Array.isArray(k)) d = bytesToInt(toBytes(k));
    else throw new TypeError('Private key harus BigInt, hex string, atau byte array');
    if (d < 1n || d >= SECP256K1.N) throw new RangeError('Private key di luar rentang [1, N-1]');
    return d;
  }
  function parsePublicKey(pk) {
    let pt = pk;
    if (typeof pk === 'string' || pk instanceof Uint8Array) {
      const b = typeof pk === 'string' ? hexToBytes(pk) : pk;
      if (b.length !== 65 || b[0] !== 4) throw new TypeError('Public key bytes harus 65 byte tak terkompresi (0x04‖x‖y)');
      pt = { x: bytesToInt(b.subarray(1, 33)), y: bytesToInt(b.subarray(33)) };
    }
    if (!isOnCurve(pt)) throw new RangeError('Public key tidak berada pada kurva secp256k1');
    return pt;
  }
  function randomScalar() {
    for (;;) { const k = bytesToInt(randomBytes(32)); if (k >= 1n && k < SECP256K1.N) return k; }
  }
  const generatePrivateKey = randomScalar;
  const getPublicKey = priv => pointMultiply(parsePrivateKey(priv), G);

  /*------------------------- 5. Schnorr ---------------------------------*/
  const SCHNORR_TAG = utf8('NEXUS/LBC/schnorr/v1');
  function challenge(R, PK, msg) {
    return mod(bytesToInt(sha256(concat(SCHNORR_TAG, intToBytes32(R.x), intToBytes32(R.y), intToBytes32(PK.x), intToBytes32(PK.y), toBytes(msg)))), SECP256K1.N);
  }
  /* Bukti = { R:{x,y}, s }. Nonce acak CSPRNG; tantangan memakai hash R‖PK‖pesan. */
  async function generateSchnorrProof(privateKey, messageHash) {
    const d = parsePrivateKey(privateKey), PK = getPublicKey(d), msg = toBytes(messageHash);
    let k, R;
    do { k = randomScalar(); R = pointMultiply(k, G); } while (!R);
    const s = mod(k + challenge(R, PK, msg) * d, SECP256K1.N);
    return { R, s };
  }
  /* Verifikasi: s·G == R + c·PK. Input cacat → false (tidak melempar). */
  async function verifySchnorrProof(publicKey, messageHash, proof) {
    try {
      const PK = parsePublicKey(publicKey), msg = toBytes(messageHash);
      if (!proof || typeof proof.s !== 'bigint' || proof.s < 0n || proof.s >= SECP256K1.N || !isOnCurve(proof.R)) return false;
      const c = challenge(proof.R, PK, msg);
      return samePoint(pointMultiply(proof.s, G), pointAdd(proof.R, pointMultiply(c, PK)));
    } catch (e) { return false; }
  }

  /*------------------------- 5b. Schnorr BIP-340 (standar) --------------*/
  const tagCache = new Map();
  function taggedHash(tag, ...msgs) {
    let th = tagCache.get(tag);
    if (!th) { th = sha256(utf8(tag)); tagCache.set(tag, th); }
    return sha256(concat(th, th, ...msgs));
  }
  function powMod(b, e, m) { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; } return r; }
  function liftX(x) {
    const p = SECP256K1.P;
    if (x < 0n || x >= p) return null;
    const c = mod(x * x * x + SECP256K1.B, p), y = powMod(c, (p + 1n) / 4n, p);
    return mod(y * y, p) === c ? { x, y: y % 2n === 0n ? y : p - y } : null;
  }
  const xorBytes = (a, b) => a.map((v, i) => v ^ b[i]);
  const asHex = v => (typeof v === 'string' ? hexToBytes(v) : toBytes(v));

  /* Kunci publik x-only 32 byte (BIP-340). */
  function schnorrGetPublicKey(privateKey) { return intToBytes32(pointMultiply(parsePrivateKey(privateKey), G).x); }
  function generateKeyPair() {
    const d = randomScalar();
    return { privateKey: bytesToHex(intToBytes32(d)), publicKey: bytesToHex(schnorrGetPublicKey(d)) };
  }
  /* Tanda tangan 64 byte. msg: bytes/string(UTF-8). aux (32 byte) opsional → nonce hedged; tanpa CSPRNG jatuh ke deterministik. */
  function schnorrSign(privateKey, message, aux) {
    const msg = toBytes(message), N = SECP256K1.N, d0 = parsePrivateKey(privateKey), Pt = pointMultiply(d0, G);
    const d = Pt.y % 2n === 0n ? d0 : N - d0;
    let a = aux === undefined ? null : toBytes(aux);
    if (a && a.length !== 32) throw new RangeError('aux harus 32 byte');
    if (!a) { try { a = randomBytes(32); } catch (e) { a = new Uint8Array(32); } }
    const t = xorBytes(intToBytes32(d), taggedHash('BIP0340/aux', a));
    const k0 = mod(bytesToInt(taggedHash('BIP0340/nonce', t, intToBytes32(Pt.x), msg)), N);
    if (k0 === 0n) throw new Error('Nonce nol – ulangi dengan aux berbeda');
    const R = pointMultiply(k0, G), k = R.y % 2n === 0n ? k0 : N - k0;
    const e = mod(bytesToInt(taggedHash('BIP0340/challenge', intToBytes32(R.x), intToBytes32(Pt.x), msg)), N);
    const sig = concat(intToBytes32(R.x), intToBytes32(mod(k + e * d, N)));
    if (!schnorrVerify(sig, msg, intToBytes32(Pt.x))) throw new Error('Self-verify gagal (kemungkinan fault); tanda tangan dibuang');
    return sig;
  }
  /* sig/publicKey: bytes atau hex string; message: bytes/string(UTF-8). Input cacat → false. */
  function schnorrVerify(signature, message, publicKey) {
    try {
      const sig = asHex(signature), pk = asHex(publicKey), msg = toBytes(message), N = SECP256K1.N;
      if (sig.length !== 64 || pk.length !== 32) return false;
      const Pt = liftX(bytesToInt(pk)), r = bytesToInt(sig.subarray(0, 32)), s = bytesToInt(sig.subarray(32));
      if (!Pt || r >= SECP256K1.P || s >= N) return false;
      const e = mod(bytesToInt(taggedHash('BIP0340/challenge', sig.subarray(0, 32), pk, msg)), N);
      const R = fromJ(jAdd(jMul(s, G), jMul(mod(-e, N), Pt)));
      return !!R && R.y % 2n === 0n && R.x === r;
    } catch (e) { return false; }
  }

  /*------------------------- 6. Self-test -------------------------------*/
  async function selfTest() {
    const r = [], t = (name, ok) => r.push({ name, ok: !!ok });
    t('SHA-256 "abc"', sha256Hex('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    t('SHA-256 kosong', sha256Hex('') === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    t('SHA-256 multi-blok', sha256Hex('a'.repeat(1000)) === '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3');
    t('Konstanta N (64 digit hex)', SECP256K1.N.toString(16).length === 64);
    t('G pada kurva', isOnCurve(G));
    t('N·G = ∞', pointMultiply(SECP256K1.N, G) === null);
    t('2G = G+G', samePoint(pointMultiply(2n, G), pointAdd(G, G)));
    t('Kanonik urut kunci', canonicalJSON({ b: 1, a: [2, { d: 1, c: 2 }] }) === '{"a":[2,{"c":2,"d":1}],"b":1}');
    const cyc = {}; cyc.self = cyc; let thr = false; try { canonicalize(cyc); } catch (e) { thr = true; } t('Tolak referensi melingkar', thr);
    const a = new MerklePatriciaTrie(), b = new MerklePatriciaTrie();
    a.putSync('abc', 'satu'); a.putSync('abd', 'dua'); b.putSync('abd', 'dua'); b.putSync('abc', 'satu');
    t('Root hash deterministik (urutan bebas)', a.rootHashHex === b.rootHashHex);
    const before = a.rootHashHex; a.putSync('abc', 'ubah');
    t('Root hash berubah saat nilai berubah', a.rootHashHex !== before);
    a.putSync('abc', 'satu'); a.putSync('ff', 'x'); a.delete('ff');
    t('Delete memulihkan root hash', a.rootHashHex === before && a.size === 2);
    const priv = generatePrivateKey(), pub = getPublicKey(priv), msg = sha256('nexus');
    const proof = await generateSchnorrProof(priv, msg);
    t('Schnorr: bukti valid lolos', await verifySchnorrProof(pub, msg, proof));
    t('Schnorr: pesan diubah ditolak', !(await verifySchnorrProof(pub, sha256('palsu'), proof)));
    t('Schnorr: kunci lain ditolak', !(await verifySchnorrProof(getPublicKey(generatePrivateKey()), msg, proof)));
    t('Schnorr: input cacat → false', (await verifySchnorrProof(pub, msg, { R: null, s: 1n })) === false);
    // Vektor resmi BIP-340 (0 dan 1)
    const v0 = { sk: '0000000000000000000000000000000000000000000000000000000000000003', pk: 'F9308A019258C31049344F85F89D5229B531C845836F99B08601F113BCE036F9',
      aux: '00'.repeat(32), msg: '00'.repeat(32), sig: 'E907831F80848D1069A5371B402410364BDF1C5F8307B0084C55F1CE2DCA821525F66A4A85EA8B71E482A74F382D2CE5EBEEE8FDB2172F477DF4900D310536C0' };
    const v1 = { sk: 'B7E151628AED2A6ABF7158809CF4F3C762E7160F38B4DA56A784D9045190CFEF', pk: 'DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659',
      aux: '00'.repeat(31) + '01', msg: '243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89', sig: '6896BD60EEAE296DB48A229FF71DFE071BDE413E6D43F917DC8DCF8C78DE33418906D11AC976ABCCB20B091292BFF4EA897EFCB639EA871CFA95F6DE339E4B0A' };
    for (const [i, v] of [v0, v1].entries()) {
      t('BIP-340 vektor ' + i + ': kunci publik', bytesToHex(schnorrGetPublicKey(v.sk)) === v.pk.toLowerCase());
      t('BIP-340 vektor ' + i + ': tanda tangan identik', bytesToHex(schnorrSign(v.sk, hexToBytes(v.msg), hexToBytes(v.aux))) === v.sig.toLowerCase());
      t('BIP-340 vektor ' + i + ': verifikasi', schnorrVerify(v.sig, hexToBytes(v.msg), v.pk));
    }
    const kp = generateKeyPair(), sg = schnorrSign(kp.privateKey, 'halo nexus');
    t('BIP-340: round-trip + tolak pesan lain', schnorrVerify(sg, 'halo nexus', kp.publicKey) && !schnorrVerify(sg, 'halo', kp.publicKey));
    const tampered = Uint8Array.from(sg); tampered[40] ^= 1;
    t('BIP-340: tanda tangan diubah ditolak', !schnorrVerify(tampered, 'halo nexus', kp.publicKey));
    // Bukti Merkle
    const mt = new MerklePatriciaTrie(); ['a1', 'a1f', 'b2', '0c9'].forEach((k, i) => mt.putSync(k, 'v' + i));
    const root = mt.rootHashHex, pf = mt.getProof('a1f'), pa = mt.getProof('a2'), pn = mt.getProof('a');
    const vf = verifyMPTProof(root, pf), va = verifyMPTProof(root, pa), vn = verifyMPTProof(root, pn);
    t('Bukti membership valid', vf.valid && vf.found && new TextDecoder().decode(vf.value) === 'v1');
    t('Bukti absence valid', va.valid && !va.found && vn.valid && !vn.found);
    const forged = JSON.parse(JSON.stringify(pf)); forged.steps[forged.steps.length - 1].value = bytesToHex(utf8('palsu'));
    t('Bukti dipalsukan ditolak', !verifyMPTProof(root, forged).valid && !verifyMPTProof('00'.repeat(32), pf).valid);
    t('Serialisasi trie bolak-balik', MerklePatriciaTrie.fromJSON(JSON.parse(JSON.stringify(mt.toJSON()))).rootHashHex === root);
    return { ok: r.every(x => x.ok), results: r };
  }

  /*------------------------- 7. Ekspor ----------------------------------*/
  const API = { version: '3.0.0', canonicalize, canonicalJSON, MPTNode, MerklePatriciaTrie, SECP256K1, G, mod, modInv, isOnCurve,
    pointAdd, pointMultiply, generatePrivateKey, getPublicKey, generateSchnorrProof, verifySchnorrProof,
    schnorrSign, schnorrVerify, schnorrGetPublicKey, generateKeyPair, taggedHash, verifyMPTProof,
    sha256, sha256Hex, bytesToHex, hexToBytes, toBytes, selfTest };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  global.NexusLBC = API;
  ['canonicalize', 'MPTNode', 'MerklePatriciaTrie', 'SECP256K1', 'mod', 'modInv', 'pointAdd', 'pointMultiply', 'generateSchnorrProof', 'verifySchnorrProof']
    .forEach(n => { if (!(n in global)) global[n] = API[n]; });
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this);
