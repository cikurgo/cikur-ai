/* CIKUR GO Internal Investigator - Upgraded v1.3.0
 * Enhanced multi-hop predictive probing and advanced discrimination scoring.
 */
const VERSION="1.3.0";
const now=()=>new Date().toISOString();

export function createInvestigation(caseData, knowledge={}) {
  return {
    investigationId:`inv_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
    caseId:caseData.caseId,
    status:"ACTIVE",
    objective:"PROVE_ROOT_CAUSE_AND_EXACT_SOURCE_ADVANCED",
    requests:[],
    findings:[],
    visitedNodes:[],
    probeHistory:[],
    startedAt:now(),
    updatedAt:now()
  };
}
export function requestEvidence(inv, request) {
  const x=structuredClone(inv);
  const r={id:`req_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,status:"OPEN",createdAt:now(),...request};
  x.requests.push(r);
  if(r.nodeIds) x.probeHistory.push({type:r.type||"UNKNOWN",nodeIds:structuredClone(r.nodeIds),score:Number(r.score||0),createdAt:r.createdAt});
  x.updatedAt=now(); return x;
}
export function recordFinding(inv, finding) {
  const x=structuredClone(inv);
  x.findings.push({
    id:finding.id||`find_${Date.now()}`,
    source:finding.source||null,
    type:finding.type||"unknown",
    claim:finding.claim||null,
    evidenceIds:Array.isArray(finding.evidenceIds)?finding.evidenceIds:[],
    status:finding.status||"UNVERIFIED",
    exact:!!finding.exact,
    recordedAt:now()
  });
  x.updatedAt=now(); return x;
}
function nodeEvidence(caseData,nodeId){
  return (caseData?.evidence||[]).filter(e=>{
    const m=e?.metadata||{};
    return m.nodeId===nodeId || m.dependencyId===nodeId ||
      (Array.isArray(m.nodeIds)&&m.nodeIds.includes(nodeId)) ||
      (Array.isArray(m.relatedNodeIds)&&m.relatedNodeIds.includes(nodeId));
  });
}
export function rankProbes(inv,caseData,knowledge={}) {
  const graph=knowledge||{};
  const visited=new Set(inv?.visitedNodes||[]);
  const deps=[];
  const target=(graph.nodes||[]).find(n=>n.id===caseData?.target||n.name===caseData?.target);
  if(target){
    const seen=new Set([target.id]); let frontier=[target.id];
    for(let depth=1;depth<=8&&frontier.length;depth++){
      const next=[];
      for(const from of frontier){
        for(const e of (graph.edges||[]).filter(x=>x.from===from&&x.type==="DEPENDS_ON"&&x.status!=="RETIRED")){
          if(!seen.has(e.to)){seen.add(e.to);deps.push({nodeId:e.to,depth,edgeId:e.id,status:e.status||"OBSERVED"});next.push(e.to);}
        }
      }
      frontier=next;
    }
  }
  const totalHyp=Math.max(1,(caseData?.hypotheses||[]).length);
  const candidates=deps.filter(d=>!visited.has(d.nodeId)).map(d=>{
    const node=(graph.nodes||[]).find(n=>n.id===d.nodeId)||{};
    const ev=nodeEvidence(caseData,d.nodeId);
    const verified=ev.filter(e=>e.status==="VERIFIED").length;
    const unresolved=ev.filter(e=>e.status!=="VERIFIED").length;
    const hyp=(caseData?.hypotheses||[]).filter(h=>(Array.isArray(h.nodeIds)?h.nodeIds:[]).includes(d.nodeId)).length;
    const conflict=node.status==="CONFLICTED"?1:0;
    const depthValue=1/Math.max(1,d.depth);
    const coverage= Math.min(1,hyp/totalHyp);
    const novelty=verified===0?1:Math.max(0,1-(verified/3));
    const score=Math.max(0,Math.min(1,
      depthValue*0.12 + coverage*0.22 + novelty*0.26 + (unresolved?0.30:0.10) + (conflict?0.10:0)
    ));
    return {type:"DEPENDENCY_TRACE",nodeId:d.nodeId,nodeName:node.name||null,depth:d.depth,edgeId:d.edgeId,score,reason:"Advanced multi-hop predictive discrimination"};
  }).sort((a,b)=>b.score-a.score||a.depth-b.depth||String(a.nodeId).localeCompare(String(b.nodeId)));
  return candidates;
}
export function nextProbe(inv, caseData, knowledge={}) {
  const verified=caseData?.evidence?.filter(e=>e.status==="VERIFIED")||[];
  const exact=verified.filter(e=>e.exact);
  if(!verified.length) return {type:"SOURCE_ACQUISITION",reason:"No verified evidence available",score:1};
  if(!caseData.rootCause){
    const ranked=rankProbes(inv,caseData,knowledge);
    if(ranked.length) return {type:"DEPENDENCY_TRACE",reason:"Probe selected by advanced information gain",score:ranked[0].score,nodeIds:[ranked[0].nodeId],candidates:ranked.slice(0,5)};
    const targetNodes=(knowledge.nodes||[]).filter(n=>n.name===caseData.target||n.id===caseData.target).map(n=>n.id);
    return targetNodes.length?{type:"DEPENDENCY_TRACE",reason:"Root cause not verified",nodeIds:targetNodes,score:.5}:
      {type:"ROOT_CAUSE_PROOF",reason:"Root cause not verified",score:.4};
  }
  if(!exact.length || !caseData.exactSource) return {type:"EXACT_SOURCE_PROOF",reason:"Exact source not verified",score:.9};
  return {type:"EXECUTION_READINESS",reason:"Proof chain complete",score:1};
}
export { VERSION };
