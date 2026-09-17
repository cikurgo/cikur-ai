/*
 * CIKUR GO INTERNAL AI — SOVEREIGNTY GATE
 *
 * Purpose:
 *   Keep the CGO intelligence boundary internal.
 *
 * Rule:
 *   External infrastructure may provide data/auth/realtime/presentation services,
 *   but no external AI provider may become a reasoning or decision dependency.
 *
 * This module is deliberately deterministic and dependency-free.
 */

export const VERSION = "V1.0.0-INTERNAL-SOVEREIGNTY-GATE";

const FORBIDDEN_AI_PATTERNS = Object.freeze([
  /api\.openai\.com/i,
  /openai/i,
  /api\.anthropic\.com/i,
  /anthropic/i,
  /claude/i,
  /generativelanguage\.googleapis\.com/i,
  /gemini/i,
  /api\.groq\.com/i,
  /groq/i,
  /mistral/i,
  /cohere/i,
  /openrouter/i,
  /perplexity/i,
  /huggingface/i,
  /together\.ai/i,
  /botpress/i
]);

const INFRASTRUCTURE_PATTERNS = Object.freeze([
  /firebase/i,
  /gstatic\.com/i,
  /fonts\.googleapis\.com/i,
  /fonts\.gstatic\.com/i
]);

function text(value) {
  return String(value ?? "");
}

export function inspectExternalReference(value) {
  const source = text(value);
  const forbidden = FORBIDDEN_AI_PATTERNS.filter(pattern => pattern.test(source)).map(String);
  const infrastructure = INFRASTRUCTURE_PATTERNS.filter(pattern => pattern.test(source)).map(String);

  return Object.freeze({
    externalAI: forbidden.length > 0,
    infrastructure: infrastructure.length > 0,
    forbiddenMatches: Object.freeze(forbidden),
    infrastructureMatches: Object.freeze(infrastructure)
  });
}

export function assertInternalSovereignty(value, label = "unknown") {
  const result = inspectExternalReference(value);
  if (result.externalAI) {
    const error = new Error(`CGO sovereignty violation: external AI dependency detected in ${label}.`);
    error.code = "CGO_EXTERNAL_AI_DEPENDENCY_BLOCKED";
    error.label = label;
    error.matches = result.forbiddenMatches;
    throw error;
  }
  return Object.freeze({ ok: true, label, ...result });
}

export function getSovereigntyManifest() {
  return Object.freeze({
    version: VERSION,
    intelligence: "INTERNAL_CIKUR_GO",
    externalAI: false,
    externalAIAllowed: false,
    externalAIAsFallback: false,
    externalAIAsExecutionAuthority: false,
    infrastructureMayBeExternal: true,
    infrastructureRole: "DATA_AUTH_REALTIME_PRESENTATION_ONLY",
    sourceMutationByThisGate: false
  });
}

export function isExternalAIReference(value) {
  return inspectExternalReference(value).externalAI;
}
