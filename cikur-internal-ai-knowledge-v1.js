/**
 * CIKUR GO INTERNAL AI — KNOWLEDGE INGESTION + SYSTEM GRAPH V1
 * Status: ISOLATED / READ-ONLY / NOT INTEGRATED
 *
 * This module does NOT fetch files, edit files, execute code, or call APIs.
 * It accepts explicit source metadata from a trusted ingestion layer later.
 */

"use strict";

const VERSION = "1.0.0-knowledge";

const ALLOWED_TYPES = new Set([
  "FILE","MODULE","FUNCTION","COLLECTION","RULE_SET",
  "EVENT","PAGE","SERVICE","STATE","CONTRACT","UNKNOWN"
]);

const RELATIONS = new Set([
  "IMPORTS","EXPORTS","CALLS","CALLED_BY","READS","WRITES",
  "LISTENS","EMITS","DEPENDS_ON","PROTECTED_BY","USES",
  "PRODUCES","CONSUMES","SENDS","RECEIVES","VALIDATES","MONITORS"
]);

const now = () => new Date().toISOString();
const id = (p) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,9)}`;

function node(input = {}) {
  const type = ALLOWED_TYPES.has(input.type) ? input.type : "UNKNOWN";
  return {
    id: input.id || id("kn"),
    type,
    name: String(input.name || "UNKNOWN"),
    source: String(input.source || "unknown"),
    fingerprint: input.fingerprint || null,
    version: input.version || null,
    observedAt: input.observedAt || now(),
    status: input.status || "ACTIVE",
    confidence: Number.isFinite(input.confidence) ? input.confidence : 0,
    metadata: input.metadata ? JSON.parse(JSON.stringify(input.metadata)) : {}
  };
}

function edge(input = {}) {
  if (!RELATIONS.has(input.relation)) throw new Error("KNOWLEDGE_RELATION_INVALID");
  return {
    id: input.id || id("ke"),
    from: input.from,
    to: input.to,
    relation: input.relation,
    source: String(input.source || "unknown"),
    observedAt: input.observedAt || now(),
    confidence: Number.isFinite(input.confidence) ? input.confidence : 0,
    metadata: input.metadata ? JSON.parse(JSON.stringify(input.metadata)) : {}
  };
}

/**
 * Build a graph only from explicitly supplied facts.
 * No inferred edges are created here.
 */
function ingestFacts(facts = {}) {
  const nodes = [];
  const edges = [];
  const errors = [];

  for (const n of facts.nodes || []) {
    try { nodes.push(node(n)); }
    catch (e) { errors.push({ kind: "NODE", error: String(e.message || e) }); }
  }

  const nodeIds = new Set(nodes.map(n => n.id));

  for (const e of facts.edges || []) {
    try {
      const x = edge(e);
      if (!nodeIds.has(x.from) || !nodeIds.has(x.to)) {
        throw new Error("GRAPH_ENDPOINT_MISSING");
      }
      edges.push(x);
    } catch (err) {
      errors.push({ kind: "EDGE", error: String(err.message || err), input: e });
    }
  }

  return {
    version: VERSION,
    ingestedAt: now(),
    readOnly: true,
    inferredEdges: 0,
    nodes,
    edges,
    errors,
    counts: { nodes: nodes.length, edges: edges.length, errors: errors.length }
  };
}

/**
 * Create an auditable snapshot for later storage.
 */
function snapshot(graph, source = "manual") {
  return {
    snapshotId: id("snap"),
    createdAt: now(),
    source,
    version: VERSION,
    graph: JSON.parse(JSON.stringify(graph)),
    policy: {
      sourceRequired: true,
      inferredFactsAllowed: false,
      mutationAllowed: false
    }
  };
}

const API = Object.freeze({
  VERSION,
  ALLOWED_TYPES: [...ALLOWED_TYPES],
  RELATIONS: [...RELATIONS],
  ingestFacts,
  snapshot
});

if (typeof globalThis !== "undefined") globalThis.CIKURInternalAIKnowledge = API;
if (typeof module !== "undefined" && module.exports) module.exports = API;
