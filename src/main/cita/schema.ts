import type { DialogueActType, TurnUnderstanding } from "./contracts";

const ACTS = new Set<DialogueActType>([
  "affirm", "cancel", "select", "request", "request_explanation", "inform",
  "correct", "continue", "compare", "comment", "greet", "unclear",
]);
const RELATIONS = new Set(["direct", "candidate_position", "previous", "focused", "comparison_item"]);
const TRANSITIONS = new Set(["continue", "switch", "return", "unclear"]);
const REWRITE_STATUSES = new Set(["unchanged", "contextualized", "ambiguous"]);
const UNCERTAINTIES = new Set([
  "multiple_references", "missing_context", "expired_context", "unclear_dialogue_act", "topic_ambiguity",
]);

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${label} has unknown field: ${unknown}`);
}

function string(value: unknown, label: string, max = 2_000): string {
  if (typeof value !== "string" || !value || value.length > max) throw new Error(`${label} is invalid`);
  return value;
}

function array(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label} is invalid`);
  return value;
}

export function parseTurnUnderstanding(value: unknown): TurnUnderstanding {
  const root = object(value, "TurnUnderstanding");
  exactKeys(root, [
    "dialogueAct", "resolvedReferences", "topicTransition", "focusedEntityRefs",
    "contextualizedQuery", "rewriteStatus", "uncertainties",
  ], "TurnUnderstanding");

  const dialogueAct = typeof root.dialogueAct === "string"
    ? { type: root.dialogueAct }
    : object(root.dialogueAct, "dialogueAct");
  exactKeys(dialogueAct, ["type"], "dialogueAct");
  if (!ACTS.has(dialogueAct.type as DialogueActType)) throw new Error("dialogueAct.type is invalid");

  const resolvedReferences = array(root.resolvedReferences, "resolvedReferences", 32).map((item, index) => {
    const ref = object(item, `resolvedReferences[${index}]`);
    exactKeys(ref, ["surface", "targetRef", "relation"], `resolvedReferences[${index}]`);
    if (!RELATIONS.has(ref.relation as string)) throw new Error(`resolvedReferences[${index}].relation is invalid`);
    return {
      surface: string(ref.surface, `resolvedReferences[${index}].surface`, 200),
      targetRef: string(ref.targetRef, `resolvedReferences[${index}].targetRef`, 240),
      relation: ref.relation as TurnUnderstanding["resolvedReferences"][number]["relation"],
    };
  });

  if (!TRANSITIONS.has(root.topicTransition as string)) throw new Error("topicTransition is invalid");
  const focusedEntityRefs = array(root.focusedEntityRefs, "focusedEntityRefs", 16)
    .map((item, index) => string(item, `focusedEntityRefs[${index}]`, 240));
  const contextualizedQuery = string(root.contextualizedQuery, "contextualizedQuery");
  if (!REWRITE_STATUSES.has(root.rewriteStatus as string)) throw new Error("rewriteStatus is invalid");

  const uncertainties = array(root.uncertainties, "uncertainties", 16).map((item, index) => {
    const uncertainty = object(item, `uncertainties[${index}]`);
    exactKeys(uncertainty, ["type", "description"], `uncertainties[${index}]`);
    if (!UNCERTAINTIES.has(uncertainty.type as string)) throw new Error(`uncertainties[${index}].type is invalid`);
    return {
      type: uncertainty.type as TurnUnderstanding["uncertainties"][number]["type"],
      description: string(uncertainty.description, `uncertainties[${index}].description`, 500),
    };
  });

  return {
    dialogueAct: { type: dialogueAct.type as DialogueActType },
    resolvedReferences,
    topicTransition: root.topicTransition as TurnUnderstanding["topicTransition"],
    focusedEntityRefs,
    contextualizedQuery,
    rewriteStatus: root.rewriteStatus as TurnUnderstanding["rewriteStatus"],
    uncertainties,
  };
}
