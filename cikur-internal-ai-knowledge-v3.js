/** CIKUR GO INTERNAL AI — KNOWLEDGE GRAPH V3 */
"use strict";
export const VERSION="3.0.0-knowledge";
const clone=v=>{try{return JSON.parse(JSON.stringify(v));}catch{return v;}};
const id=s=>`kn_${String(s).replace(/[^a-zA-Z0-9_-]/g,"_")}`;
export function createKnowledgeSnapshot(t={}){
  const nodes=[],edges=[],seen=new Set();
  const node=(type,name,source,metadata={})=>{if(!name)return null;const key=`${type}|${name}`;if(seen.has(key))return id(key);seen.add(key);const n={id:id(key),type,name:String(name),source,observedAt:new Date().toISOString(),confidence:1,metadata:clone(metadata)};nodes.push(n);return n.id;};
  const edge=(a,b,relation,source,confidence=1)=>{if(a&&b)edges.push({from:a,to:b,relation,source,confidence});};
  const bcgo=node("MODULE","bcgo.js","RUNTIME_INTEGRATION");
  const html=node("PAGE","bcgo.html","RUNTIME_INTEGRATION");
  const config=node("MODULE","cikur-config.js","RUNTIME_INTEGRATION");
  const ai=node("SERVICE","CIKUR GO Internal Intelligence","INTERNAL_AI");
  const medicine=node("SERVICE","Medicine","PIPELINE_POLICY");
  const executor=node("SERVICE","Executor","PIPELINE_POLICY");
  edge(bcgo,ai,"SENDS","RUNTIME_INTEGRATION"); edge(ai,html,"PRODUCES","RUNTIME_INTEGRATION"); edge(bcgo,config,"DEPENDS_ON","PROJECT_STRUCTURE"); edge(ai,medicine,"SENDS","PIPELINE_POLICY",.9); edge(medicine,executor,"SENDS","PIPELINE_POLICY");
  const target=t.targetCell||t.activeCases?.[0]?.target||null; const targetId=node("FILE",target,"BCGO_STATE.targetCell",{role:"current_target"}); edge(ai,targetId,"INVESTIGATES","CURRENT_STATE",.8);
  (Array.isArray(t.activeCases)?t.activeCases:[]).slice(0,12).forEach((c,i)=>{const cid=node("CASE",c?.id||`case-${i}`,"BCGO_STATE.activeCases",{target:c?.target||c?.file||null,status:c?.status||null});edge(cid,ai,"CONSUMES","BCGO_STATE",.9);});
  const findings=[...(Array.isArray(t.sourceScan?.findings)?t.sourceScan.findings:[]),...(Array.isArray(t.sourceScan?.crossFileFindings)?t.sourceScan.crossFileFindings:[])];
  findings.slice(0,30).forEach((f,i)=>{const fid=node("ERROR",f?.id||`finding-${i}`,"BCGO_STATE.sourceScan",{file:f?.file||f?.target||null,message:f?.message||f?.error||null});edge(ai,fid,"CONSUMES","SOURCE_SCAN",.9);});
  return {version:VERSION,observedAt:new Date().toISOString(),readOnly:true,nodes,edges,policy:{explicitFactsOnly:true,mutationAllowed:false,staleKnowledgeMustBeRevalidated:true,unknownRelationshipsMustNotBeInvented:true}};
}
if(typeof globalThis!=="undefined")globalThis.CIKURInternalAIKnowledgeCore={VERSION,createKnowledgeSnapshot};
