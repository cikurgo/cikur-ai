/** CIKUR GO INTERNAL AI — KNOWLEDGE GRAPH V4 */
"use strict";
export const VERSION="4.0.0-knowledge";
const clone=v=>{try{return JSON.parse(JSON.stringify(v));}catch{return v;}};
const key=s=>String(s||"").replace(/[^a-zA-Z0-9_-]/g,"_");
const id=(t,n)=>`kn_${key(t)}_${key(n)}`;
export function createKnowledgeSnapshot(t={},reasoning=null){
  const nodes=[],edges=[],seen=new Set(),now=new Date().toISOString();
  const node=(type,name,source,confidence=1,metadata={})=>{if(!name)return null;const k=`${type}|${name}`;if(seen.has(k))return id(type,name);seen.add(k);const n={id:id(type,name),type,name:String(name),source,observedAt:now,confidence,metadata:clone(metadata)};nodes.push(n);return n.id;};
  const edge=(from,to,relation,source,confidence=1,verified=false)=>{if(from&&to)edges.push({from,to,relation,source,confidence,verified});};
  const bcgo=node("MODULE","bcgo.js","RUNTIME_INTEGRATION");
  const html=node("PAGE","bcgo.html","RUNTIME_INTEGRATION");
  const config=node("MODULE","cikur-config.js","RUNTIME_INTEGRATION");
  const ai=node("SERVICE","CIKUR GO Internal Intelligence","INTERNAL_AI");
  const medicine=node("SERVICE","Medicine","PIPELINE_POLICY");
  const executor=node("SERVICE","Executor","PIPELINE_POLICY");
  edge(bcgo,ai,"SENDS","RUNTIME_INTEGRATION",1,true);edge(ai,html,"PRODUCES","RUNTIME_INTEGRATION",1,true);edge(bcgo,config,"DEPENDS_ON","PROJECT_STRUCTURE",1,true);edge(ai,medicine,"SENDS","PIPELINE_POLICY",.95,true);edge(medicine,executor,"SENDS","PIPELINE_POLICY",.95,true);
  const target=t.targetCell||t.activeCases?.[0]?.target||t.activeCases?.[0]?.file||null;const targetId=node("FILE",target,"BCGO_STATE",.85,{target:true});if(targetId)edge(ai,targetId,"INVESTIGATES","BCGO_STATE",.85,false);
  for(const c of (Array.isArray(t.activeCases)?t.activeCases:[]).slice(0,20)){const cid=node("CASE",c?.id||`${c?.target||c?.file||"unknown"}_${c?.message||"case"}`,"BCGO_STATE.activeCases",.9,{severity:c?.severity,target:c?.target||c?.file});if(cid&&targetId)edge(cid,targetId,"TARGETS","BCGO_STATE",.9,true);}
  for(const h of (reasoning?.hypotheses||[]).slice(0,8)){const hid=node("HYPOTHESIS",h.id,"REASONING_CORE",h.confidence,{claim:h.claim,status:h.status});if(hid&&targetId)edge(hid,targetId,"POTENTIAL_TARGET","REASONING_CORE",h.confidence,false);for(const eid of h.supportingEvidenceIds||[]){const ev=node("EVIDENCE",eid,"REASONING_CORE",.8);if(ev)edge(ev,hid,"SUPPORTS","REASONING_CORE",.8,true);}}
  return {version:VERSION,generatedAt:now,nodes,edges,stats:{nodes:nodes.length,edges:edges.length,hypotheses:reasoning?.hypotheses?.length||0,evidence:reasoning?.evidence?.length||0},freshnessPolicy:{runtimeEvidencePreferred:true,historyIsHintOnly:true,unverifiedRelationsCannotBecomeFacts:true}};
}
if(typeof globalThis!=="undefined")globalThis.CIKURInternalAIKnowledge={VERSION,createKnowledgeSnapshot};
