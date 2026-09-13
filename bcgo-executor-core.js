/* CIKUR GO — DETERMINISTIC EXECUTOR CORE v4.0
 * Pure source transformation + proof engine. No network, AI or Firebase.
 */
(() => {
  "use strict";
  const VERSION = "4.0.0-EXECUTION-CORE-HARD-CUT";
  const OPS = Object.freeze({ REPLACE_EXACT:"REPLACE_EXACT", INSERT_EXACT:"INSERT_EXACT", REMOVE_EXACT:"REMOVE_EXACT" });
  const STATUS = Object.freeze({ VALID:"VALID", REJECTED:"REJECTED", COMPLETE:"COMPLETE" });
  const fp = text => {
    if (typeof text !== "string") throw new TypeError("SOURCE_MUST_BE_STRING");
    let h=0x811c9dc5;
    for(let i=0;i<text.length;i++){ h^=text.charCodeAt(i); h=Math.imul(h,0x01000193); }
    return (h>>>0).toString(16).padStart(8,"0");
  };
  const equal=(a,b)=>String(a??"").toLowerCase()===String(b??"").toLowerCase();
  const count=(source,needle)=>{
    if(typeof source!=="string"||typeof needle!=="string"||!needle)return 0;
    let n=0,p=0; while((p=source.indexOf(needle,p))!==-1){n++;p+=needle.length;} return n;
  };
  const lineColumn=(text,index)=>{const a=text.slice(0,Math.max(0,index)).split("\n");return {line:a.length,column:a[a.length-1].length+1};};
  function diff(before,after){
    if(typeof before!=="string"||typeof after!=="string")return {ok:false,reason:"INVALID_DIFF_INPUT"};
    if(before===after)return {ok:false,changed:false,reason:"SOURCE_UNCHANGED",beforeFingerprint:fp(before),afterFingerprint:fp(after)};
    let s=0; const m=Math.min(before.length,after.length); while(s<m&&before.charCodeAt(s)===after.charCodeAt(s))s++;
    let eb=before.length-1,ea=after.length-1; while(eb>=s&&ea>=s&&before.charCodeAt(eb)===after.charCodeAt(ea)){eb--;ea--;}
    return {ok:true,changed:true,start:s,beforeEnd:eb+1,afterEnd:ea+1,location:lineColumn(before,s),removed:before.slice(s,eb+1),added:after.slice(s,ea+1),beforeFingerprint:fp(before),afterFingerprint:fp(after)};
  }
  function validateBefore(source,expected){
    if(typeof source!=="string")return {ok:false,reason:"INVALID_SOURCE_TYPE"};
    const actual=fp(source); if(!expected)return {ok:true,skipped:true,actual,reason:"NO_EXPECTED_FINGERPRINT"};
    return {ok:equal(expected,actual),skipped:false,expected:String(expected),actual,reason:equal(expected,actual)?"FINGERPRINT_MATCH":"SOURCE_FINGERPRINT_MISMATCH"};
  }
  function apply(source,before,after,operation){
    if(![source,before,after].every(v=>typeof v==="string"))return {ok:false,status:STATUS.REJECTED,reason:"INVALID_PATCH_INPUT"};
    const op=String(operation||"").toUpperCase(); if(!Object.values(OPS).includes(op))return {ok:false,status:STATUS.REJECTED,reason:"UNSUPPORTED_OPERATION"};
    if(!before)return {ok:false,status:STATUS.REJECTED,reason:"EMPTY_EXACT_TARGET"};
    const matches=count(source,before); if(matches!==1)return {ok:false,status:STATUS.REJECTED,reason:matches===0?"EXACT_TARGET_NOT_FOUND":"EXACT_TARGET_NOT_UNIQUE",matches};
    let result=op===OPS.REPLACE_EXACT?source.replace(before,after):op===OPS.INSERT_EXACT?source.replace(before,before+after):source.replace(before,"");
    if(result===source)return {ok:false,status:STATUS.REJECTED,reason:"SOURCE_UNCHANGED",matches};
    return {ok:true,status:STATUS.COMPLETE,operation:op,matches,result,beforeFingerprint:fp(source),afterFingerprint:fp(result),diff:diff(source,result)};
  }
  function validateResult(original,result,before,after,operation){
    const errors=[]; const op=String(operation||"").toUpperCase();
    if(typeof original!=="string"||typeof result!=="string")errors.push("INVALID_VALIDATION_INPUT");
    if(result===original)errors.push("SOURCE_UNCHANGED");
    if(op===OPS.REPLACE_EXACT){if(count(result,before)!==0)errors.push("BEFORE_STILL_PRESENT");if(after&&count(result,after)<1)errors.push("AFTER_NOT_PRESENT");}
    else if(op===OPS.INSERT_EXACT){if(count(result,before+after)<1)errors.push("INSERT_RESULT_NOT_FOUND");}
    else if(op===OPS.REMOVE_EXACT){if(count(result,before)!==0)errors.push("REMOVE_TARGET_STILL_PRESENT");}
    else errors.push("UNSUPPORTED_OPERATION");
    return {ok:errors.length===0,status:errors.length===0?STATUS.VALID:STATUS.REJECTED,errors,beforeFingerprint:typeof original==="string"?fp(original):null,afterFingerprint:typeof result==="string"?fp(result):null,readBackFingerprint:typeof result==="string"?fp(result):null};
  }
  function processPatch(input={}){
    const gate=validateBefore(input.source,input.expectedFingerprint); if(!gate.ok)return {ok:false,stage:"FINGERPRINT",gate};
    const patch=apply(input.source,input.before,input.after,input.operation); if(!patch.ok)return {ok:false,stage:"PATCH",patch};
    const validation=validateResult(input.source,patch.result,input.before,input.after,input.operation);
    if(!validation.ok)return {ok:false,stage:"VALIDATION",patch,validation};
    return {ok:true,status:STATUS.COMPLETE,stage:"COMPLETE",sourceBefore:input.source,sourceAfter:patch.result,beforeFingerprint:patch.beforeFingerprint,afterFingerprint:patch.afterFingerprint,diff:patch.diff,validation};
  }
  window.BCGOExecutorCore=Object.freeze({version:VERSION,operations:OPS,status:STATUS,fingerprint:fp,fingerprintsEqual:equal,countExact:count,lineColumnAt:lineColumn,diff,validateBefore,apply,validateResult,processPatch});
  window.dispatchEvent(new CustomEvent("bcgo-executor-core-ready",{detail:{version:VERSION}}));
})();
