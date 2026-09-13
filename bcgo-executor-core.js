/* CIKUR GO — EXECUTOR CORE v5.0.0
 * Deterministic only. No AI/network. It validates candidates and executes only after explicit authorization.
 */
(()=>{
 "use strict";
 const VERSION="5.0.0-EXECUTOR-DETERMINISTIC-GATE";
 const OPS=Object.freeze({REPLACE_EXACT:"REPLACE_EXACT",INSERT_EXACT:"INSERT_EXACT",REMOVE_EXACT:"REMOVE_EXACT"});
 const fp=s=>{if(typeof s!=="string")throw Error("SOURCE_MUST_BE_STRING");let h=0x811c9dc5;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,0x01000193);}return(h>>>0).toString(16).padStart(8,"0")};
 const count=(s,n)=>{if(typeof s!=="string"||typeof n!=="string"||!n)return 0;let c=0,p=0;while((p=s.indexOf(n,p))!==-1){c++;p+=n.length}return c};
 function review(source,r){if(typeof source!=="string")return{ok:false,reason:"SOURCE_NOT_STRING"};if(!r||!r.file||!r.before||typeof r.after!=="string")return{ok:false,reason:"CANDIDATE_SCHEMA_INVALID"};const actual=fp(source);if(r.expectedFingerprint!==actual)return{ok:false,reason:"SOURCE_FINGERPRINT_MISMATCH",expected:r.expectedFingerprint,actual};const n=count(source,r.before);if(n!==1)return{ok:false,reason:n===0?"EXACT_TARGET_NOT_FOUND":"EXACT_TARGET_NOT_UNIQUE",matches:n};return{ok:true,stage:"FINGERPRINT_AND_EXACT_TARGET",beforeFingerprint:actual,matches:n};}
 function simulate(source,r){const gate=review(source,r);if(!gate.ok)return gate;let out;if(r.operation===OPS.REPLACE_EXACT)out=source.replace(r.before,r.after);else if(r.operation===OPS.INSERT_EXACT)out=source.replace(r.before,r.before+r.after);else if(r.operation===OPS.REMOVE_EXACT)out=source.replace(r.before,"");else return{ok:false,reason:"UNSUPPORTED_OPERATION"};if(out===source)return{ok:false,reason:"SOURCE_UNCHANGED"};const after=fp(out);return{ok:true,status:"VALID",sourceBefore:source,sourceAfter:out,beforeFingerprint:gate.beforeFingerprint,afterFingerprint:after,changed:true};}
 window.BCGOExecutorCore=Object.freeze({version:VERSION,operations:OPS,fingerprint:fp,countExact:count,review,simulate});
 window.dispatchEvent(new CustomEvent("bcgo-executor-core-ready",{detail:{version:VERSION}}));
})();
