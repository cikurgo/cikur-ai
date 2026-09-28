/* CGO AI Memory — minimal conversation/case memory for browser adapter */
const VERSION = "1.0.0-MEMORY-STUB";

export function createMemory(limit = 50) {
  const turns = [];
  return {
    version: VERSION,
    remember(q, a, meta) {
      turns.push({ q: String(q || "").slice(0, 300), a: String(a || "").slice(0, 400), meta: meta || null, at: Date.now() });
      while (turns.length > limit) turns.shift();
      return turns[turns.length - 1];
    },
    recall(n = 5) { return turns.slice(-(Number(n) || 5)); },
    clear() { turns.length = 0; },
    size() { return turns.length; },
    snapshot() { return turns.slice(); }
  };
}

export { VERSION };
