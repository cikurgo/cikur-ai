/* CIKUR GO INTERNAL AI — APPLICATION RUNTIME ADAPTER
 * Application-only runtime for CGO reasoning, discovery support, and evidence.
 * No external AI/API. Application runtime only. No source mutation.
 */
import * as Core from "./cgo-ai-core.js";
import * as Knowledge from "./cgo-ai-knowledge.js";
import * as Investigator from "./cgo-ai-investigator.js";
import * as Memory from "./cgo-ai-memory.js";
import * as Cognition from "./cgo-ai-cognition.js";
import * as Guardian from "./cgo-ai-guardian.js";
import * as Logic from "./cgo-ai-logic.js";

export const VERSION = "2.0.0-APPLICATION-RUNTIME";

export function createRuntime(options = {}) {
  let knowledge = Knowledge.createKnowledgeStore(options.knowledge);
  let memory = Memory.createMemory(options.memory);
  const cases = new Map();
  const investigations = new Map();
  const listeners = new Set();

  function emit(event, payload) {
    const packet = { event, payload: structuredClone(payload), at: new Date().toISOString() };
    for (const fn of listeners) { try { fn(packet); } catch {} }
    try { window.dispatchEvent(new CustomEvent("cgo-runtime-event", { detail: packet })); } catch {}
    return packet;
  }

  const api = {
    version: VERSION,
    on(fn) { if (typeof fn !== "function") return () => {}; listeners.add(fn); return () => listeners.delete(fn); },
    getKnowledge() { return structuredClone(knowledge); },
    setKnowledge(next) { Knowledge.validateStore(next); knowledge = structuredClone(next); return structuredClone(knowledge); },
    getMemory() { return structuredClone(memory); },
    remember(record) { memory = Memory.remember(memory, record); emit("MEMORY_STORED", record); return structuredClone(record); },
    getCase(caseId) { return caseId && cases.has(caseId) ? structuredClone(cases.get(caseId)) : null; },
    listCases() { return [...cases.values()].map(structuredClone); },

    detect(input = {}) {
      const requestedId = input.caseId;
      if (requestedId && cases.has(requestedId)) throw new Error(`CASE_ID_COLLISION:${requestedId}`);
      const c = Core.createCase(input);
      c.event = { eventId: input.eventId || null, sequence: Number.isInteger(input.sequence) ? input.sequence : 0, observedAt: input.observedAt || c.createdAt, source: input.source || "BCGO" };
      cases.set(c.caseId, c);
      investigations.set(c.caseId, Investigator.createInvestigation(c, knowledge));
      emit("CASE_DETECTED", c);
      return structuredClone(c);
    },

    addEvidence(caseId, evidence) {
      const current = cases.get(caseId);
      if (!current) throw new Error(`CASE_NOT_FOUND:${caseId}`);
      const incoming = Array.isArray(evidence) ? evidence : [evidence];
      const c = Core.ingestEvidence(current, incoming);
      c.rootCause = null;
      c.exactSource = null;
      c.actionPlan = null;
      c.validation = null;
      c.state = "EVIDENCE_COLLECTING";
      c.updatedAt = new Date().toISOString();
      c.revision++;
      cases.set(caseId, c);
      investigations.set(caseId, Investigator.createInvestigation(c, knowledge));
      emit("EVIDENCE_UPDATED", c);
      return structuredClone(c);
    },

    reason(caseId, hypotheses = []) {
      const current = cases.get(caseId);
      if (!current) throw new Error(`CASE_NOT_FOUND:${caseId}`);
      const out = Core.reason(current, hypotheses);
      cases.set(caseId, out.caseData);
      emit("REASONING_UPDATED", out);
      return structuredClone(out);
    },

    proveRootCause(caseId, rootCause) {
      const current = cases.get(caseId);
      if (!current) throw new Error(`CASE_NOT_FOUND:${caseId}`);
      const c = Core.verifyRootCause(current, rootCause);
      cases.set(caseId, c);
      emit("ROOT_CAUSE_VERIFIED", c);
      return structuredClone(c);
    },

    proveSource(caseId, source) {
      const current = cases.get(caseId);
      if (!current) throw new Error(`CASE_NOT_FOUND:${caseId}`);
      const c = Core.verifyExactSource(current, source);
      cases.set(caseId, c);
      emit("SOURCE_VERIFIED", c);
      return structuredClone(c);
    },

    logic(caseId, policy = {}) {
      const c = cases.get(caseId);
      if (!c) throw new Error(`CASE_NOT_FOUND:${caseId}`);
      return Logic.decide(c, policy, knowledge);
    },

    deliberate(caseId, policy = {}) {
      const c = cases.get(caseId);
      if (!c) throw new Error(`CASE_NOT_FOUND:${caseId}`);
      const evaluation = Logic.evaluate(c, policy, knowledge);
      return Cognition.deliberate({
        evidence: c.evidence,
        rootCause: c.rootCause,
        exactSource: c.exactSource,
        contradictions: Core.detectContradictions(c.evidence),
        proofComplete: evaluation.proof.complete
      });
    },

    investigator(caseId) {
      const c = cases.get(caseId);
      if (!c) throw new Error(`CASE_NOT_FOUND:${caseId}`);
      return Investigator.createInvestigation(c, knowledge);
    },

    addKnowledgeNode(node) { knowledge = Knowledge.upsertNode(knowledge, node); return structuredClone(knowledge); },
    addKnowledgeRelation(from, to, type, meta = {}) { knowledge = Knowledge.addRelation(knowledge, from, to, type, meta); return structuredClone(knowledge); },

    snapshot() {
      return { version: VERSION, cases: [...cases.values()], knowledge: structuredClone(knowledge), memory: structuredClone(memory) };
    },

    restore(snapshot = {}) {
      if (!Array.isArray(snapshot.cases) || !snapshot.knowledge || !snapshot.memory) throw new Error("INVALID_SNAPSHOT");
      Knowledge.validateStore(snapshot.knowledge);
      cases.clear(); investigations.clear();
      knowledge = structuredClone(snapshot.knowledge);
      memory = structuredClone(snapshot.memory);
      for (const c of snapshot.cases) {
        if (!c?.caseId || cases.has(c.caseId)) throw new Error("INVALID_SNAPSHOT_CASE");
        cases.set(c.caseId, structuredClone(c));
        investigations.set(c.caseId, Investigator.createInvestigation(c, knowledge));
      }
      emit("RUNTIME_RESTORED", { caseCount: cases.size });
      return true;
    }
  };

  return Object.freeze(api);
}
