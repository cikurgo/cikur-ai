/* CIKUR GO Internal Cognition — v1.3.0-OTAK-WIRE
 * Deliberasi ringan berbasis bukti. Aditif, zero network.
 */
const VERSION = "1.3.0-OTAK-WIRE";

function evidenceQuality(e) {
  if (!e) return 0;
  if (e.verified || e.status === "OK" || e.status === "VALID") return 1;
  if (e.status === "PARTIAL" || e.status === "ATTENTION") return 0.55;
  if (e.status === "UNKNOWN" || e.unverified) return 0.25;
  return 0.4;
}

export function deliberate(context = {}) {
  const claims = Array.isArray(context.claims) ? context.claims : [];
  const evidence = Array.isArray(context.evidence) ? context.evidence : [];
  const question = String(context.question || context.text || "").trim();
  const scores = evidence.map(evidenceQuality);
  const avg = scores.length ? scores.reduce(function (a, b) { return a + b; }, 0) / scores.length : (claims.length ? 0.5 : 0.35);
  const blockers = [];
  if (!claims.length && !evidence.length && !question) blockers.push("NO_INPUT");
  if (evidence.some(function (e) { return e && e.status === "FAIL"; })) blockers.push("FAILED_EVIDENCE");
  const stance = blockers.indexOf("FAILED_EVIDENCE") >= 0 ? "CAUTION"
    : avg >= 0.75 ? "CONFIDENT" : avg >= 0.45 ? "BALANCED" : "HEDGE";
  const summary = stance === "CONFIDENT"
    ? "Bukti relatif kuat; kesimpulan dapat disampaikan dengan jelas."
    : stance === "BALANCED"
      ? "Bukti cukup; sampaikan temuan utama dan sisa ketidakpastian."
      : stance === "CAUTION"
        ? "Ada bukti bermasalah; prioritaskan peringatan dan langkah verifikasi."
        : "Bukti terbatas; hindari klaim berlebihan.";
  return {
    version: VERSION,
    stance: stance,
    confidence: Math.round(avg * 100) / 100,
    blockers: blockers,
    summary: summary,
    claimCount: claims.length,
    evidenceCount: evidence.length,
    question: question || null
  };
}

export function speak(result, mode = "SYSTEM") {
  if (!result) return mode === "HUMAN" ? "Belum ada hasil penalaran." : "NO_RESULT";
  if (mode === "HUMAN") {
    const conf = result.confidence != null ? Math.round(Number(result.confidence) * 100) + "%" : "—";
    return (result.summary || "Penalaran selesai.") + " Keyakinan internal sekitar " + conf + ".";
  }
  return JSON.stringify({ stance: result.stance, confidence: result.confidence, blockers: result.blockers });
}

export { VERSION };

try {
  if (typeof globalThis !== "undefined") {
    globalThis.CGOAiCognition = { VERSION: VERSION, deliberate: deliberate, speak: speak };
  }
} catch (_) {}
