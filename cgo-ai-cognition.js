/* CIKUR GO Internal Cognition
 * Deep deliberation over supplied facts. It may say "insufficient evidence".
 */
const VERSION="1.1.0";

// UPGRADE: confidence used to be purely a headcount (verified.length/4), so four
// weak, unverified-strength pieces of evidence scored identically to four strong,
// exact ones. Now it blends evidence quality (strength + whether it's an exact
// match) with a count factor, so a handful of strong, exact evidence is trusted
// more than a pile of weak evidence, while a single strong item still doesn't
// alone reach full confidence.
function evidenceQuality(e){
  const strength = Number.isFinite(e?.strength) ? Math.max(0,Math.min(1,e.strength)) : 0;
  return Math.max(0, Math.min(1, 0.7*strength + 0.3*(e?.exact?1:0)));
}

export function deliberate(context={}) {
  const evidence=context.evidence||[];
  const verified=evidence.filter(e=>e.status==="VERIFIED");
  const contradictions=context.contradictions||[];
  const unresolved=evidence.filter(e=>e.status==="UNVERIFIED");
  let conclusion="INSUFFICIENT_EVIDENCE";
  if(contradictions.length) conclusion="CONTRADICTORY_EVIDENCE";
  else if(context.proofComplete===true) conclusion="READY_FOR_ACTION_POLICY";
  else if(verified.length) conclusion="CONTINUE_INVESTIGATION";
  const countFactor=Math.min(1, verified.length/4);
  const avgQuality=verified.length ? verified.reduce((s,e)=>s+evidenceQuality(e),0)/verified.length : 0;
  return {
    conclusion,
    facts:verified.map(e=>({id:e.id,claim:e.claim,source:e.source,exact:e.exact})),
    unknowns:unresolved.map(e=>e.id),
    contradictions,
    reasoning:["Separate observed facts from hypotheses.","Require independent verification before action.","Historical memory is not proof."],
    confidence:Math.max(0,Math.min(1, avgQuality*countFactor))
  };
}

export function speak(result, mode="SYSTEM") {
  if(result.conclusion==="INSUFFICIENT_EVIDENCE") return "Bukti belum cukup. Investigasi harus dilanjutkan.";
  if(result.conclusion==="CONTRADICTORY_EVIDENCE") return "Bukti saling bertentangan. Tindakan diblokir sampai kontradiksi diselesaikan.";
  if(result.conclusion==="READY_FOR_ACTION_POLICY") return "Rantai bukti lengkap dan terverifikasi. Selanjutnya keputusan tindakan mengikuti policy.";
  return "Bukti awal tersedia, tetapi pembuktian belum selesai.";
}
export { VERSION };
