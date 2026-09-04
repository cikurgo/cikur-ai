/**
 * CIKUR GO INTERNAL AI — KNOWLEDGE CORE V2
 * Read-only, explicit-fact knowledge graph.
 * No external AI/API. No inferred graph edges without evidence.
 */

"use strict";

export const VERSION = "2.0.0-knowledge";

const clone = value => {
  try { return JSON.parse(JSON.stringify(value)); }
  catch { return value; }
};

const NODE_TYPES = new Set([
  "FILE","MODULE","FUNCTION","COLLECTION","RULE_SET","EVENT",
  "PAGE","SERVICE","STATE","CONTRACT","ERROR","CASE","UNKNOWN"
]);

const RELATIONS = new Set([
  "IMPORTS","EXPORTS","CALLS","CALLED_BY","READS","WRITES",
  "LISTENS","EMITS","DEPENDS_ON","PROTECTED_BY","USES",
  "PRODUCES","CONSUMES","SENDS","RECEIVES","VALIDATES","MONITORS"
]);

export function createKnowledgeSnapshot(telemetry = {}) {
  const nodes = [];
  const edges = [];

  const addNode = (type, name, source, metadata = {}) => {
    if (!name) return null;
    const n = {
      id: `kn_${type}_${String(name).replace(/[^a-zA-Z0-9_-]/g, "_")}`,
      type: NODE_TYPES.has(type) ? type : "UNKNOWN",
      name: String(name),
      source,
      observedAt: new Date().toISOString(),
      confidence: 1,
      metadata: clone(metadata)
    };
    nodes.push(n);
    return n.id;
  };

  const bcgo = addNode("MODULE", "bcgo.js", "BCGO_STATE");
  const html = addNode("PAGE", "bcgo.html", "BCGO_STATE");
  const config = addNode("MODULE", "cikur-config.js", "BCGO_STATE");
  const ai = addNode("SERVICE", "CIKUR GO Internal Intelligence", "INTERNAL_AI");
  const medicine = addNode("SERVICE", "Medicine", "BCGO_STATE");
  const executor = addNode("SERVICE", "Executor", "BCGO_STATE");

  if (bcgo && ai) edges.push({ from: bcgo, to: ai, relation: "SENDS", source: "RUNTIME_INTEGRATION", confidence: 1 });
  if (ai && html) edges.push({ from: ai, to: html, relation: "PRODUCES", source: "RUNTIME_INTEGRATION", confidence: 1 });
  if (config && bcgo) edges.push({ from: bcgo, to: config, relation: "DEPENDS_ON", source: "PROJECT_STRUCTURE", confidence: 1 });
  if (ai && medicine) edges.push({ from: ai, to: medicine, relation: "SENDS", source: "PIPELINE_POLICY", confidence: 0.9 });
  if (medicine && executor) edges.push({ from: medicine, to: executor, relation: "SENDS", source: "PIPELINE_POLICY", confidence: 1 });

  const target = telemetry.targetCell || telemetry.activeCases?.[0]?.target;
  if (target) addNode("FILE", target, "BCGO_STATE.targetCell", { role: "current_target" });

  return {
    version: VERSION,
    observedAt: new Date().toISOString(),
    readOnly: true,
    nodes,
    edges,
    policy: {
      explicitFactsOnly: true,
      mutationAllowed: false,
      staleKnowledgeMustBeRevalidated: true
    }
  };
}

if (typeof globalThis !== "undefined") {
  globalThis.CIKURInternalAIKnowledgeCore = { VERSION, createKnowledgeSnapshot };
}
