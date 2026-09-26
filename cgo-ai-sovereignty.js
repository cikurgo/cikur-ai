/* CIKUR GO Internal AI — Sovereignty Guard
 * Local-only source/policy verifier. No network, storage, or third-party dependency.
 */
const VERSION = "1.0.0-INTERNAL-SOVEREIGNTY";
const FORBIDDEN = [
  /https?:\/\//i,
  /\bfetch\s*\(/i,
  /\bXMLHttpRequest\b/i,
  /\bWebSocket\b/i,
  /\bimport\s*\(/i,
  /\brequire\s*\(/i,
  /\blocalStorage\b/i,
  /\bsessionStorage\b/i,
  /\bindexedDB\b/i
];
export function assertInternalSovereignty(source = "", label = "source") {
  const text = String(source || "");
  const violations = [];
  for (const re of FORBIDDEN) if (re.test(text)) violations.push(re.source);
  return Object.freeze({version:VERSION,label:String(label||"source"),internal:violations.length===0,verified:violations.length===0,violations});
}
export { VERSION };
