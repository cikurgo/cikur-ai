/* CIKUR GO INTERNAL AI — CAPTAIN STATE MACHINE
 * Deterministic lifecycle authority facade.
 * Reads the existing Core transition table and Guardian policy; never duplicates it.
 */
const VERSION="1.0.0-CAPTAIN-STATE-MACHINE";

function clone(v){return typeof structuredClone==="function"?structuredClone(v):JSON.parse(JSON.stringify(v));}

export function createStateMachine({transitions={},guardTransition=null}={}){
  const table=transitions||{};
  function canTransition(from,to,context={}){
    if(from===to) return {ok:true,reason:"NOOP"};
    const allowed=Array.isArray(table[from])&&table[from].includes(to);
    if(!allowed) return {ok:false,reason:`TRANSITION_NOT_DECLARED:${from}->${to}`};
    if(typeof guardTransition==="function"){
      const g=guardTransition(from,to,context);
      if(!g?.ok) return {ok:false,reason:g?.reason||`GUARD_REJECTED:${from}->${to}`,guard:g};
    }
    return {ok:true,reason:"ALLOWED"};
  }
  function assertTransition(from,to,context={}){
    const result=canTransition(from,to,context);
    if(!result.ok) throw new Error(`CAPTAIN_STATE_TRANSITION_BLOCKED:${result.reason}`);
    return true;
  }
  function transition(caseData,to,context={}){
    const c=clone(caseData||{});
    if(!c.state) throw new Error("CAPTAIN_CASE_STATE_REQUIRED");
    assertTransition(c.state,to,context);
    if(c.state!==to){ c.state=to; c.revision=Number(c.revision||0)+1; }
    c.updatedAt=new Date().toISOString();
    return c;
  }
  return Object.freeze({
    version:VERSION,
    states:Object.freeze(Object.keys(table)),
    canTransition,
    assertTransition,
    transition,
    describe(from){return Object.freeze({from,allowed:[...(table[from]||[])]});}
  });
}

export { VERSION };
