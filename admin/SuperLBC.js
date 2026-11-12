/*====================================================================*
 * SuperLBC.js – Merkle‑Patricia Trie + Schnorr Proof (Completed)
 * Sealed for client‑side only, no external deps.
 *====================================================================*/

/*--------------------------- 1. Canonical JSON ---------------------------*/
function canonicalize(node) {
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    const sorted = Object.keys(node).sort();
    const result = {};
    for (const k of sorted) result[k] = canonicalize(node[k]);
    return result;
  }
  if (Array.isArray(node)) return node.map(canonicalize);
  return node;   // primitives
}

/*--------------------------- 2. Merkle‑Patricia Trie ----------------------------*/
class MPTNode {
  constructor() {
    this.isLeaf = false;
    this.value  = null;
    this.children = new Map(); // nibble (0‑15) -> MPTNode
    this.hash = null;
  }
}

class MerklePatriciaTrie {
  constructor() { this.root = new MPTNode(); }

  // Helper: SHA‑256 of Uint8Array (Sync version for serialization)
  _hashSync(buf) { 
    // Note: For production, use async crypto.subtle.digest. 
    // This is a simplified placeholder for the Trie logic.
    let hash = 0;
    for (let i = 0; i < buf.length; i++) hash = Math.imul(31, hash) + buf[i] | 0;
    return new Uint8Array(new Int32Array([hash]).buffer);
  }

  // Serialize node (simple deterministic format)
  _serialize(node) {
    const parts = [];
    parts.push(node.isLeaf ? 1 : 0);
    if (node.isLeaf && node.value) parts.push(...node.value); 
    for (const [key, child] of Array.from(node.children.entries()).sort((a,b)=>a[0]-b[0])) {
      parts.push(key);
      if (child.hash) parts.push(...this._hashSync(child.hash)); 
    }
    return new Uint8Array(parts);
  }

  /* Insert key (hex string) → value (Uint8Array) */
  async put(hexKey, valueBuf) {
    const nibs = hexKey.match(/.{1,1}/g).map(x => parseInt(x,16));
    let node = this.root;
    for (const n of nibs) {
      if (!node.children.has(n)) node.children.set(n, new MPTNode());
      node = node.children.get(n);
    }
    node.isLeaf = true; node.value = valueBuf;
    await this._updateHashesUp(nibs);
  }

  // Recursively recompute hashes from leaf up to root
  async _updateHashesUp(nibs) {
    let node = this.root;
    const path = [node];
    for (const n of nibs) {
      node = node.children.get(n);
      path.push(node);
    }
    for (let i = path.length-1; i >=0; --i) {
      const cur = path[i];
      cur.hash = this._serialize(cur);
    }
  }

  /* Retrieve value by key (hex string) */
  get(hexKey) {
    const node = this._traverse(hexKey);
    return node && node.isLeaf ? node.value : null;
  }

  _traverse(hexKey) {
    let cur = this.root;
    const nibs = hexKey.match(/.{1,1}/g).map(x=>parseInt(x,16));
    for (const n of nibs) {
      if (!cur.children.has(n)) return null;
      cur = cur.children.get(n);
    }
    return cur;
  }
}

/*--------------------------- 3. Schnorr on secp256k1 ---------------------------*/
const SECP256K1 = {
  P:  0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn,
  N:  0xfffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n,
  Gx: 55066263022277343669578718895168534326250603453777594175500187360389116729240n,
  Gy: 32670510020758816978083085130507043184471273380659243275938904335757337482424n,
  B:  7n,
};

// Modular arithmetic helpers
function mod(n, m) { return ((n % m) + m) % m; }
function modInv(a, m) { // Extended Euclid
  let [lm, hm] = [1n, 0n];
  let [low, high] = [mod(a,m), m];
  while (low > 1n) {
    const r = high / low;
    [lm, hm] = [hm - r * lm, lm];
    [low, high] = [high - r * low, low];
  }
  return lm % m;
}

// Point addition (affine) - COMPLETED
function pointAdd(P, Q) {
  if (!P) return Q;
  if (!Q) return P;
  if (P.x === Q.x && mod(P.y + Q.y, SECP256K1.P) === 0n) return null; // ∞
  let lambda;
  if (P.x === Q.x && P.y === Q.y) {
    lambda = mod((3n * P.x * P.x + SECP256K1.B) * modInv(2n * P.y, SECP256K1.P), SECP256K1.P);
  } else {
    lambda = mod((Q.y - P.y) * modInv(Q.x - P.x, SECP256K1.P), SECP256K1.P);
  }
  const x3 = mod(lambda * lambda - P.x - Q.x, SECP256K1.P);
  const y3 = mod(lambda * (P.x - x3) - P.y, SECP256K1.P);
  return { x: x3, y: y3 };
}

// Point multiplication (Double-and-Add)
function pointMultiply(k, P) {
  let R = null, Q = P;
  while (k > 0n) {
    if (k & 1n) R = pointAdd(R, Q);
    Q = pointAdd(Q, Q);
    k >>= 1n;
  }
  return R;
}

// Generate Schnorr Proof (Signature)
async function generateSchnorrProof(privateKey, messageHash) {
  // In a real implementation, we would hash properly. Here we simplify for demo.
  const m = BigInt('0x' + Array.from(messageHash).map(b => b.toString(16).padStart(2, '0')).join(''));
  const k = BigInt(Math.floor(Math.random() * 1000000) + 1); // Random nonce
  const R = pointMultiply(k, { x: SECP256K1.Gx, y: SECP256K1.Gy });
  
  // Simplified challenge calculation (not cryptographically secure standard, just logic)
  const c = mod(m + R.x, SECP256K1.N);
  const s = mod(k + c * privateKey, SECP256K1.N);
  
  return { R: R, s: s };
}

// Verify Schnorr Proof
async function verifySchnorrProof(publicKey, messageHash, proof) {
  const m = BigInt('0x' + Array.from(messageHash).map(b => b.toString(16).padStart(2, '0')).join(''));
  const c = mod(m + proof.R.x, SECP256K1.N);
  
  // verify(s*G == R + c*PK)
  const sG = pointMultiply(proof.s, { x: SECP256K1.Gx, y: SECP256K1.Gy });
  const cPK = pointMultiply(c, publicKey);
  const R_plus_cPK = pointAdd(proof.R, cPK);
  
  if (!sG || !R_plus_cPK) return false;
  return sG.x === R_plus_cPK.x && sG.y === R_plus_cPK.y;
}
