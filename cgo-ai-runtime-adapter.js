/* CIKUR GO Internal AI Runtime Adapter
 * Integrates the eight brain modules without external AI.
 * Orchestrates approved repair/execution through an injected deterministic Executor.
 * The brain never writes source directly; it can trigger Executor execution when policy permits.
 */
import * as Core from "./cgo-ai-core.js";
import * as Knowledge from "./cgo-ai-knowledge.js";
import * as Investigator from "./cgo-ai-investigator.js";
import * as Memory from "./cgo-ai-memory.js";
import * as Cognition from "./cgo-ai-cognition.js";
import * as Guardian from "./cgo-ai-guardian.js";
import * as Logic from "./cgo-ai-logic.js";

const VERSION="1.9.0";

export function createDeterministicExecutor(target={}) {
  let bound = target && typeof target.read === "function" && typeof target.write === "function" ? target : null;
  const consumed = new Set();

  function bind(next){
    if(!next || typeof next.read!=="function" || typeof next.write!=="function")
      throw new Error("EXECUTION_TARGET_INTERFACE_REQUIRED");
    if(typeof next.execute!=="function")
      throw new Error("EXECUTION_TARGET_EXECUTE_REQUIRED");
    bound=next;
    return true;
  }

  function applyExact(source, request){
    const operation=request.operation || "REPLACE_EXACT";
    const original=String(request.originalCode ?? "");
    const proposed=request.proposedCode;
    if(!original) throw new Error("ORIGINAL_CODE_REQUIRED");
    if(operation==="REPLACE_EXACT"){
      if(typeof proposed!=="string") throw new Error("PROPOSED_CODE_REQUIRED");
      const at=source.indexOf(original);
      if(at<0) throw new Error("EXACT_SOURCE_NOT_FOUND");
      if(source.indexOf(original,at+1)>=0) throw new Error("AMBIGUOUS_EXACT_SOURCE");
      return source.slice(0,at)+proposed+source.slice(at+original.length);
    }
    if(operation==="INSERT_EXACT"){
      if(typeof proposed!=="string") throw new Error("PROPOSED_CODE_REQUIRED");
      const at=source.indexOf(original);
      if(at<0) throw new Error("INSERT_ANCHOR_NOT_FOUND");
      if(source.indexOf(original,at+1)>=0) throw new Error("AMBIGUOUS_INSERT_ANCHOR");
      return source.slice(0,at)+proposed+source.slice(at);
    }
    if(operation==="REMOVE_EXACT"){
      const at=source.indexOf(original);
      if(at<0) throw new Error("EXACT_SOURCE_NOT_FOUND");
      if(source.indexOf(original,at+1)>=0) throw new Error("AMBIGUOUS_EXACT_SOURCE");
      return source.slice(0,at)+source.slice(at+original.length);
    }
    throw new Error(`UNSUPPORTED_OPERATION:${operation}`);
  }

  return {
    version:"1.1.0",
    bind,
    snapshot(){ return {consumed:[...consumed]}; },
    restore(state={}){
      if(state===null || state===undefined) return true;
      if(!Array.isArray(state.consumed)) throw new Error("INVALID_EXECUTOR_SNAPSHOT");
      consumed.clear();
      for(const id of state.consumed){ if(typeof id!=="string" || !id) throw new Error("INVALID_EXECUTOR_SNAPSHOT"); consumed.add(id); }
      return true;
    },
    async execute(request={}, context={}){
      if(!context.authorizationId) throw new Error("EXECUTION_AUTHORIZATION_REQUIRED");
      if(!context.planId) throw new Error("EXECUTION_PLAN_REQUIRED");
      if(consumed.has(context.authorizationId)) throw new Error("EXECUTOR_AUTHORIZATION_REPLAY");
      if(!bound) throw new Error("EXECUTION_TARGET_NOT_BOUND");
      if(typeof bound.execute!=="function") throw new Error("EXECUTION_TARGET_EXECUTE_REQUIRED");
      const current=String(await bound.read());
      if(!request.sourceFingerprint) throw new Error("EXECUTION_SOURCE_FINGERPRINT_REQUIRED");
      if(Core.contentFingerprint(current)!==request.sourceFingerprint)
        throw new Error("EXECUTION_SOURCE_FINGERPRINT_MISMATCH");
      const next=applyExact(current,request);
      const verification = request.operation==="REMOVE_EXACT"
        ? !next.includes(String(request.originalCode))
        : request.operation==="INSERT_EXACT"
          ? next === (current.slice(0,current.indexOf(String(request.originalCode))) +
              String(request.proposedCode) + current.slice(current.indexOf(String(request.originalCode))))
          : next === (current.slice(0,current.indexOf(String(request.originalCode))) +
              String(request.proposedCode) +
              current.slice(current.indexOf(String(request.originalCode))+String(request.originalCode).length));
      if(!verification) throw new Error("PATCH_READBACK_VERIFICATION_FAILED");
      await bound.write(next);
      const readBack=String(await bound.read());
      if(readBack!==next) throw new Error("PATCH_PERSISTENCE_READBACK_MISMATCH");
      let executionResult;
      try {
        executionResult=await bound.execute({
          file:request.file||null,
          operation:request.operation || "REPLACE_EXACT",
          before:current,
          after:readBack,
          authorizationId:context.authorizationId,
          planId:context.planId,
          proofFingerprint:context.proofFingerprint||request.fingerprint||null
        });
      } catch(err) {
        try {
          await bound.write(current);
          const rollback=String(await bound.read());
          if(rollback!==current) throw new Error("PATCH_ROLLBACK_READBACK_MISMATCH");
        } catch(rollbackErr) {
          throw new Error(`AUTOMATIC_EXECUTION_FAILED_ROLLBACK_FAILED:${rollbackErr.message}`);
        }
        throw new Error(`AUTOMATIC_EXECUTION_FAILED:${err?.message||"EXECUTOR_ERROR"}`);
      }
      if(executionResult===false || executionResult?.success===false) {
        try {
          await bound.write(current);
          const rollback=String(await bound.read());
          if(rollback!==current) throw new Error("PATCH_ROLLBACK_READBACK_MISMATCH");
        } catch(rollbackErr) {
          throw new Error(`AUTOMATIC_EXECUTION_FAILED_ROLLBACK_FAILED:${rollbackErr.message}`);
        }
        throw new Error("AUTOMATIC_EXECUTION_FAILED");
      }
      consumed.add(context.authorizationId);
      return {
        status:"PATCH_APPLIED_AND_EXECUTED",
        operation:request.operation || "REPLACE_EXACT",
        file:request.file || null,
        authorizationId:context.authorizationId,
        planId:context.planId,
        beforeFingerprint:Core.contentFingerprint(current),
        afterFingerprint:Core.contentFingerprint(readBack),
        readBackVerified:true,
        executed:true,
        executionResult:structuredClone(executionResult??{success:true}),
        at:new Date().toISOString()
      };
    }
  };
}

export function createRuntime(options={}) {
  let knowledge=Knowledge.createKnowledgeStore(options.knowledge);
  let memory=Memory.createMemory(options.memory);
  const cases=new Map();
  const investigations=new Map();
  const listeners=new Set();
  const eventLedger=new Map();
  const planCache=new Map();
  const authorizationLedger=new Map();
  let executor = options.executor || createDeterministicExecutor(options.executionTarget);

  function emit(event,payload){ for(const fn of listeners){ try{fn({event,payload,at:new Date().toISOString()});}catch{} } }
  function assertStateTransition(from,to){
    if(from===to) return true;
    const g=Guardian.guardTransition(from,to);
    if(!g.ok) throw new Error(`INVALID_CASE_STATE_TRANSITION:${from}->${to}`);
    return true;
  }
  function validateRestoredCase(c){
    if(!c?.caseId || typeof c.state!=="string") throw new Error(`INVALID_SNAPSHOT_CASE:${c?.caseId||"unknown"}`);
    const known=new Set(["DETECTED","OBSERVING","EVIDENCE_COLLECTING","INVESTIGATING","HYPOTHESIS_FORMED","VERIFYING","ROOT_CAUSE_VERIFIED","SOURCE_VERIFIED","CANDIDATE_READY","EXECUTOR_REVIEW","HUMAN_APPROVAL","EXECUTING","VALIDATING","RESOLVED","INSUFFICIENT_EVIDENCE","CONTRADICTORY_EVIDENCE","SOURCE_NOT_VERIFIED","VALIDATION_FAILED","REOPENED","INVESTIGATION_BLOCKED"]);
    if(!known.has(c.state)) throw new Error(`INVALID_SNAPSHOT_STATE:${c.state}`);
    if(!Array.isArray(c.evidence)||!Array.isArray(c.hypotheses)) throw new Error(`INVALID_SNAPSHOT_CASE:${c.caseId}`);
    if(c.state==="SOURCE_VERIFIED"||c.state==="CANDIDATE_READY"||c.state==="EXECUTOR_REVIEW"||c.state==="HUMAN_APPROVAL"||c.state==="EXECUTING"||c.state==="VALIDATING"||c.state==="RESOLVED") {
      if(!c.rootCause||!c.exactSource) throw new Error(`INVALID_SNAPSHOT_PROOF:${c.caseId}`);
    }
    if(["EXECUTOR_REVIEW","HUMAN_APPROVAL","EXECUTING","VALIDATING","RESOLVED"].includes(c.state) && !c.actionPlan)
      throw new Error(`INVALID_SNAPSHOT_LIFECYCLE:${c.caseId}`);
    if(["EXECUTING","VALIDATING","RESOLVED"].includes(c.state) && !c.validation && !c.execution)
      throw new Error(`INVALID_SNAPSHOT_LIFECYCLE:${c.caseId}`);
    if(c.rootCause){
      const h=c.hypotheses.find(x=>x?.id===c.rootCause.hypothesisId);
      if(typeof c.rootCause.statement!=="string" || !c.rootCause.statement.trim() || !h || Number(h.score)<0.60 ||
         !Array.isArray(c.rootCause.evidenceIds) || !c.rootCause.evidenceIds.length ||
         !Array.isArray(h.evidenceIds) || !c.rootCause.evidenceIds.every(id=>h.evidenceIds.includes(id)))
        throw new Error(`INVALID_SNAPSHOT_ROOT_CAUSE:${c.caseId}`);
    }
    if(c.exactSource){
      if(c.exactSource.contentFingerprint!==Core.contentFingerprint(c.exactSource.originalCode||""))
        throw new Error(`INVALID_SNAPSHOT_PROOF_FINGERPRINT:${c.caseId}`);
      const ids=Array.isArray(c.exactSource.evidenceIds)?c.exactSource.evidenceIds:[];
      if(!ids.length || !ids.every(id=>c.evidence.some(e=>e?.id===id && e.status==="VERIFIED")))
        throw new Error(`INVALID_SNAPSHOT_PROOF_EVIDENCE:${c.caseId}`);
      if(c.rootCause && !Array.isArray(c.rootCause.evidenceIds))
        throw new Error(`INVALID_SNAPSHOT_ROOT_CAUSE:${c.caseId}`);
    }
    if(c.actionPlan?.request?.file && c.exactSource?.file && c.actionPlan.request.file!==c.exactSource.file)
      throw new Error(`INVALID_SNAPSHOT_ACTION_BINDING:${c.caseId}`);
    return true;
  }

  function authorizationDecision(caseId,policy={}){
    const c=cases.get(caseId);
    if(!c) throw new Error(`CASE_NOT_FOUND:${caseId}`);
    // Every authorization path re-runs the complete proof chain. Truthy
    // rootCause/exactSource objects are never sufficient by themselves.
    const evaluation=Logic.evaluate(c,policy,knowledge);
    return evaluation.guardian;
  }

  const api={
    version:VERSION,
    on(fn){listeners.add(fn); return ()=>listeners.delete(fn);},
    getKnowledge(){return structuredClone(knowledge);},
    getMemory(){return structuredClone(memory);},
    getCase(caseId){return structuredClone(cases.get(caseId)||null);},
    setExecutor(nextExecutor){
      if(nextExecutor!==null && typeof nextExecutor?.execute!=="function") throw new Error("EXECUTOR_INTERFACE_REQUIRED");
      executor=nextExecutor;
      return !!executor;
    },
    bindExecutionTarget(target){
      if(!executor || typeof executor.bind!=="function") throw new Error("BUILTIN_EXECUTOR_NOT_AVAILABLE");
      return executor.bind(target);
    },
    hasExecutionHand(){ return !!executor && typeof executor.execute==="function"; },

    detect(input){
      input=input||{};
      const requestedId=input?.caseId;
      if(requestedId && cases.has(requestedId)){
        const existing=cases.get(requestedId);
        throw new Error(`CASE_ID_COLLISION:${requestedId}`);
      }
      const c=Core.createCase(input);
      c.event = {eventId: input.eventId || null, sequence: Number.isInteger(input.sequence) ? input.sequence : 0, observedAt: input.observedAt || c.createdAt, source: input.source || "BCGO"};
      cases.set(c.caseId,c);
      eventLedger.set(c.caseId,{sequence:Number.isInteger(c.event.sequence)?c.event.sequence:-1,eventIds:new Set(c.event.eventId?[c.event.eventId]:[])});
      investigations.set(c.caseId,Investigator.createInvestigation(c,knowledge));
      emit("CASE_DETECTED",c);
      return structuredClone(c);
    },

    addEvidence(caseId,evidence){
      const c0=cases.get(caseId);
      if(!c0) throw new Error(`CASE_NOT_FOUND:${caseId}`);
      const incoming=Array.isArray(evidence)?evidence:[evidence];
      const ledger=eventLedger.get(caseId)||{sequence:Number.isInteger(c0.event?.sequence)?c0.event.sequence:-1,eventIds:new Set()};
      for(const e of incoming){
        if(e?.eventId && ledger.eventIds.has(e.eventId)) throw new Error(`DUPLICATE_EVENT:${e.eventId}`);
        if(Number.isInteger(e?.sequence) && e.sequence <= ledger.sequence) throw new Error(`STALE_EVENT:${e.sequence}<=${ledger.sequence}`);
        if(e?.id){
          const prior=c0.evidence.find(x=>x.id===e.id);
          if(prior){
            const immutable=(k)=>prior[k]===undefined || e[k]===undefined || JSON.stringify(prior[k])===JSON.stringify(e[k]);
            for(const k of ["type","source","claim","observedAt","fingerprint","exact"]){
              if(!immutable(k)) throw new Error(`EVIDENCE_ID_COLLISION:${e.id}`);
            }
          }
        }
      }
      const c=Core.ingestEvidence(c0,evidence);
      // Any new evidence invalidates prior proof/action artifacts. A verified proof
      // is a snapshot of evidence, not a permanent truth claim.
      c.rootCause=null;
      c.exactSource=null;
      c.actionPlan=null;
      c.validation=null;
      c.state="EVIDENCE_COLLECTING";
      c.updatedAt=new Date().toISOString();
      c.revision++;
      for(const e of incoming){
        if(e?.eventId) ledger.eventIds.add(e.eventId);
        if(Number.isInteger(e?.sequence)) ledger.sequence=Math.max(ledger.sequence,e.sequence);
      }
      c.event={eventId:incoming.at(-1)?.eventId||c0.event?.eventId||null,sequence:ledger.sequence,observedAt:incoming.at(-1)?.observedAt||new Date().toISOString(),source:incoming.at(-1)?.source||c0.event?.source||"BCGO"};
      eventLedger.set(caseId,ledger);
      cases.set(caseId,c); emit("EVIDENCE_UPDATED",c); return structuredClone(c);
    },

    reason(caseId,hypotheses){
      const out=Core.reason(cases.get(caseId),hypotheses);
      cases.set(caseId,out.caseData);
      emit("REASONING_UPDATED",out);
      return structuredClone(out);
    },

    proveRootCause(caseId,rootCause){
      const before=cases.get(caseId);
      const c=Core.verifyRootCause(before,rootCause);
      cases.set(caseId,c); emit("ROOT_CAUSE_VERIFIED",c); return structuredClone(c);
    },

    proveSource(caseId,source){
      const before=cases.get(caseId);
      const c=Core.verifyExactSource(before,source);
      cases.set(caseId,c); emit("SOURCE_VERIFICATION",c); return structuredClone(c);
    },

    authorize(caseId,policy={}){
      const c=cases.get(caseId);
      const auth=authorizationDecision(caseId,policy);
      const bound={
        caseId,
        revision:c?.revision||0,
        fingerprint:c?.exactSource?.fingerprint||null,
        sourceFingerprint:c?.exactSource?.sourceFingerprint||null,
        proposedFingerprint:c?.exactSource?.proposedCode==null ? null : Core.contentFingerprint(c.exactSource.proposedCode),
        file:c?.exactSource?.file||null,
        operation:c?.exactSource?.operation||null,
        decision:auth.decision,
        risk:auth.risk,
        policyVersion:auth.policyVersion
      };
      auth.authorizationId=`auth_${caseId}_${c?.revision||0}_${Math.random().toString(36).slice(2,10)}`;
      auth.binding=JSON.stringify(bound);
      auth.issuedAt=new Date().toISOString();
      const maxAgeMs=Number.isFinite(policy.authorizationTtlMs)?Math.max(1000,policy.authorizationTtlMs):60000;
      auth.expiresAt=new Date(Date.now()+maxAgeMs).toISOString();
      auth.consumed=false;
      authorizationLedger.set(auth.authorizationId,{binding:auth.binding,expiresAt:auth.expiresAt,consumed:false,caseId});
      emit("ACTION_AUTHORIZATION",auth);
      return structuredClone(auth);
    },

    consumeAuthorization(auth,expected={}){
      if(!auth?.authorizationId) throw new Error("AUTHORIZATION_ID_REQUIRED");
      const rec=authorizationLedger.get(auth.authorizationId);
      if(!rec) throw new Error(`AUTHORIZATION_NOT_FOUND:${auth.authorizationId}`);
      if(rec.consumed) throw new Error(`AUTHORIZATION_REPLAY:${auth.authorizationId}`);
      if(Date.now()>Date.parse(rec.expiresAt) || auth.expiresAt!==rec.expiresAt) throw new Error(`AUTHORIZATION_EXPIRED:${auth.authorizationId}`);
      if(auth.binding!==rec.binding) throw new Error(`AUTHORIZATION_BINDING_MISMATCH:${auth.authorizationId}`);
      const parsed=JSON.parse(rec.binding);
      if(auth.decision!==parsed.decision || auth.risk!==parsed.risk || auth.policyVersion!==parsed.policyVersion)
        throw new Error(`AUTHORIZATION_BINDING_MISMATCH:${auth.authorizationId}`);
      if(parsed.decision==="BLOCKED") throw new Error(`AUTHORIZATION_NOT_EXECUTABLE:${auth.authorizationId}`);
      if(expected.caseId && expected.caseId!==rec.caseId) throw new Error("AUTHORIZATION_CASE_MISMATCH");
      if(expected.fingerprint && parsed.fingerprint!==expected.fingerprint) throw new Error("AUTHORIZATION_SOURCE_MISMATCH");
      if(expected.sourceFingerprint && parsed.sourceFingerprint!==expected.sourceFingerprint) throw new Error("AUTHORIZATION_SOURCE_MISMATCH");
      rec.consumed=true;
      authorizationLedger.set(auth.authorizationId,rec);
      return {authorizationId:auth.authorizationId,consumed:true,consumedAt:new Date().toISOString()};
    },

    plan(caseId,policy={}){
      const c0=cases.get(caseId);
      if(!c0) throw new Error(`CASE_NOT_FOUND:${caseId}`);
      const existing=c0.actionPlan;
      if(existing && existing.executionStatus==="CONSUMED" && existing.request?.fingerprint===c0.exactSource?.fingerprint &&
         existing.request?.file===c0.exactSource?.file &&
         existing.request?.operation===(c0.exactSource?.operation||"REPLACE_EXACT")){
        return structuredClone(c0);
      }
      const decision=authorizationDecision(caseId,policy);
      const key=JSON.stringify({caseId,revision:c0.revision||0,proofFingerprint:c0.exactSource?.fingerprint||null,sourceFingerprint:c0.exactSource?.sourceFingerprint||null,proposedFingerprint:c0.exactSource?.proposedCode==null?null:Core.contentFingerprint(c0.exactSource.proposedCode),rootEvidence:c0.rootCause?.evidenceIds||[],decision:decision.decision,risk:decision.risk,policy});
      if(planCache.has(key)){
        const cached=planCache.get(key);
        const rec=cached?.actionPlan?.authorizationId?authorizationLedger.get(cached.actionPlan.authorizationId):null;
        if(rec && !rec.consumed && !rec.inFlight && Date.now()<=Date.parse(rec.expiresAt)) return structuredClone(cached);
      }
      const auth=api.authorize(caseId,policy);
      const c=Core.buildActionPlan(c0,auth);
      cases.set(caseId,c); planCache.set(key,c); emit("ACTION_PLAN_READY",c.actionPlan); return structuredClone(c);
    },
    async execute(caseId, policy={}){
      const c=cases.get(caseId);
      if(!c) throw new Error(`CASE_NOT_FOUND:${caseId}`);
      const planned=api.plan(caseId,policy);
      const action=planned.actionPlan;
      if(action?.executionStatus==="CONSUMED") return {status:"BLOCKED",reason:"AUTHORIZATION_ALREADY_CONSUMED",caseId,authorizationId:action.authorizationId||null};
      if(!action || action.action==="BLOCKED" || action.action==="INVESTIGATE")
        return {status:"BLOCKED",reason:"ACTION_NOT_EXECUTABLE",caseId,action:action?.action||null};
      if(action.action==="HUMAN_APPROVAL_PATCH_AND_EXECUTE")
        return {status:"HUMAN_APPROVAL_REQUIRED",caseId,authorizationId:action.authorizationId,action:action.action};
      if(action.action!=="AUTO_PATCH_AND_EXECUTE_INTENT")
        return {status:"BLOCKED",reason:"UNKNOWN_ACTION",caseId,action:action.action};
      if(!executor) throw new Error("EXECUTOR_NOT_CONFIGURED");
      const authId=action.authorizationId;
      const rec=authorizationLedger.get(authId);
      if(!rec) throw new Error("AUTHORIZATION_NOT_FOUND");
      const current=cases.get(caseId);
      const bound=JSON.parse(rec.binding);
      if(!current?.exactSource || current.exactSource.fingerprint!==action.request?.fingerprint ||
         current.exactSource.file!==bound.file || current.exactSource.operation!==bound.operation ||
         (current.exactSource.proposedCode==null ? null : Core.contentFingerprint(current.exactSource.proposedCode))!==bound.proposedFingerprint ||
         Number(current.revision||0)!==Number(bound.revision||0))
        throw new Error("EXECUTION_PROOF_BINDING_MISMATCH");
      if(rec.consumed) throw new Error(`AUTHORIZATION_REPLAY:${authId}`);
      if(rec.inFlight) throw new Error(`AUTHORIZATION_IN_FLIGHT:${authId}`);
      if(Date.now()>Date.parse(rec.expiresAt)) throw new Error(`AUTHORIZATION_EXPIRED:${authId}`);
      if(bound.caseId!==caseId || bound.fingerprint!==action.request.fingerprint || bound.sourceFingerprint!==(action.request.sourceFingerprint||null) || bound.file!==action.request.file ||
         bound.operation!==(action.request.operation||"REPLACE_EXACT") ||
         bound.proposedFingerprint!==(action.request.proposedCode==null ? null : Core.contentFingerprint(action.request.proposedCode)) ||
         Number(bound.revision||0)!==Number(action.revision||0))
        throw new Error("EXECUTION_AUTHORIZATION_BINDING_MISMATCH");
      rec.inFlight=true;
      authorizationLedger.set(authId,rec);
      cases.set(caseId,Core.transitionCaseState(current,"EXECUTING"));
      let result;
      try {
        result=await executor.execute(structuredClone(action.request),{
          caseId, authorizationId:authId, risk:action.risk, policyVersion:bound.policyVersion,
          planId:action.planId, proofFingerprint:action.request.fingerprint, sourceFingerprint:action.request.sourceFingerprint||null
        });
      } catch(err) {
        rec.inFlight=false;
        authorizationLedger.set(authId,rec);
        const failed=cases.get(caseId);
        try{ cases.set(caseId,Core.transitionCaseState(failed,"VALIDATION_FAILED")); }catch{}
        emit("AUTO_EXECUTION_FAILED",{caseId,authorizationId:authId,error:String(err?.message||err)});
        throw err;
      }
      rec.inFlight=false;
      rec.consumed=true;
      rec.consumedAt=new Date().toISOString();
      authorizationLedger.set(authId,rec);
      const validating=cases.get(caseId);
      validating.execution=structuredClone(result);
      validating.actionPlan={...structuredClone(validating.actionPlan),executionStatus:"CONSUMED",executedAt:new Date().toISOString()};
      cases.set(caseId,Core.transitionCaseState(validating,"VALIDATING"));
      emit("AUTO_EXECUTION_DISPATCHED",{caseId,authorizationId:authId,planId:action.planId,result});
      return {status:"EXECUTION_DISPATCHED",caseId,authorizationId:authId,planId:action.planId,result};
    },

    investigate(caseId){
      const c=cases.get(caseId), inv=investigations.get(caseId);
      if(!c||!inv) throw new Error(`CASE_NOT_FOUND:${caseId}`);
      const probe=Investigator.nextProbe(inv,c,knowledge);
      const updated=Investigator.requestEvidence(inv,probe);
      investigations.set(caseId,updated);
      emit("EVIDENCE_REQUESTED",probe);
      return probe;
    },

    logic(caseId,policy={}){
      const c=cases.get(caseId);
      if(!c) throw new Error(`CASE_NOT_FOUND:${caseId}`);
      return Logic.decide(c,policy,knowledge);
    },

    validate(caseId, outcome={}){
      const c0=cases.get(caseId);
      if(!c0) throw new Error(`CASE_NOT_FOUND:${caseId}`);
      if(c0.state!=="VALIDATING") throw new Error(`VALIDATION_STATE_REQUIRED:${c0.state}`);
      const success=outcome===true || outcome?.success===true || outcome?.status==="FIXED_VERIFIED";
      const c=structuredClone(c0);
      c.validation={status:success?"FIXED_VERIFIED":"VALIDATION_FAILED",success,details:structuredClone(outcome),validatedAt:new Date().toISOString()};
      const next=success?"RESOLVED":"REOPENED";
      cases.set(caseId,Core.transitionCaseState(c,next));
      emit(success?"CASE_RESOLVED":"VALIDATION_FAILED",cases.get(caseId));
      return structuredClone(cases.get(caseId));
    },

    deliberate(caseId,policy={}){
      const c=cases.get(caseId);
      if(!c) throw new Error(`CASE_NOT_FOUND:${caseId}`);
      const evaluation=Logic.evaluate(c,policy,knowledge);
      return Cognition.deliberate({
        evidence:c.evidence,
        rootCause:c.rootCause,
        exactSource:c.exactSource,
        contradictions:Core.detectContradictions(c.evidence),
        proofComplete:evaluation.proof.complete
      });
    },

    remember(record){
      memory=Memory.remember(memory,record);
      emit("MEMORY_STORED",record);
      return structuredClone(record);
    },

    addKnowledgeNode(node){knowledge=Knowledge.upsertNode(knowledge,node);return structuredClone(knowledge);},
    addKnowledgeRelation(from,to,type,meta={}){knowledge=Knowledge.addRelation(knowledge,from,to,type,meta);return structuredClone(knowledge);},

    snapshot(){
      return {
        version:VERSION,
        cases:[...cases.values()],
        knowledge,
        memory,
        authorizations:[...authorizationLedger.entries()].map(([id,v])=>[id,v]),
        executorState:executor && typeof executor.snapshot==="function" ? executor.snapshot() : null
      };
    },

    restore(snapshot){
      if(!snapshot || !Array.isArray(snapshot.cases) || !snapshot.knowledge || !snapshot.memory ||
         (snapshot.authorizations!==undefined && !Array.isArray(snapshot.authorizations))) throw new Error("INVALID_SNAPSHOT");
      cases.clear(); investigations.clear(); eventLedger.clear(); planCache.clear(); authorizationLedger.clear();
      knowledge=structuredClone(snapshot.knowledge);
      Knowledge.validateStore(knowledge);
      for(const c of snapshot.cases){
        if(cases.has(c?.caseId)) throw new Error(`INVALID_SNAPSHOT_CASE:${c?.caseId||"unknown"}`);
        validateRestoredCase(c);
        cases.set(c.caseId,structuredClone(c));
        investigations.set(c.caseId,Investigator.createInvestigation(c,knowledge));
        eventLedger.set(c.caseId,{sequence:Number.isInteger(c.event?.sequence)?c.event.sequence:-1,eventIds:new Set(c.event?.eventId?[c.event.eventId]:[])});
      }
      memory=structuredClone(snapshot.memory);
      for(const entry of (snapshot.authorizations||[])){
        if(!Array.isArray(entry)||entry.length!==2||!entry[0]||!entry[1]?.binding||!entry[1]?.expiresAt) throw new Error("INVALID_SNAPSHOT_AUTHORIZATION");
        let parsed;
        try{ parsed=JSON.parse(entry[1].binding); }catch{ throw new Error("INVALID_SNAPSHOT_AUTHORIZATION"); }
        if(!parsed?.caseId || !cases.has(parsed.caseId) || !parsed.policyVersion || !parsed.decision || !parsed.risk || !parsed.file || !parsed.fingerprint)
          throw new Error("INVALID_SNAPSHOT_AUTHORIZATION");
        if(entry[1].caseId!==parsed.caseId || typeof entry[1].consumed!=="boolean") throw new Error("INVALID_SNAPSHOT_AUTHORIZATION");
        if(entry[1].inFlight!==undefined && typeof entry[1].inFlight!=="boolean") throw new Error("INVALID_SNAPSHOT_AUTHORIZATION");
        if(Number.isNaN(Date.parse(entry[1].expiresAt))) throw new Error("INVALID_SNAPSHOT_AUTHORIZATION");
        authorizationLedger.set(entry[0],structuredClone(entry[1]));
      }
      if(snapshot.executorState!==undefined && executor && typeof executor.restore==="function") executor.restore(structuredClone(snapshot.executorState));
      emit("RUNTIME_RESTORED",{caseCount:cases.size,authorizationCount:authorizationLedger.size});
      return api.snapshot();
    }
  };
  return api;
}

export { VERSION };
