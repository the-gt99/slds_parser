import type { ReferenceCandidateDTO } from "../contracts/index.js";
import { IntegrationContractError } from "../core/errors/index.js";
import type { RuleV2Record } from "../repositories/index.js";

/** Keep imported source conditions on the candidate that is being resolved. */
export function directCandidateConditions(rule: RuleV2Record): RuleV2Record["conditionGroups"] {
  const reference = rule.actions.find((action) => action.kind === "resolve_reference");
  if (reference?.kind !== "resolve_reference") throw new IntegrationContractError(`Rule ${rule.id} has no reference action`);
  const prefix = `candidate.${reference.referenceType}.`;
  const fieldPattern = /^(?:sourceValue|scope|subjectKind|(?:context|evidence)\.[a-zA-Z][a-zA-Z0-9_-]*)$/u;
  for (const group of rule.conditionGroups) for (const condition of group.conditions) {
    if (!condition.field.startsWith(prefix) || !fieldPattern.test(condition.field.slice(prefix.length))) {
      throw new IntegrationContractError(`Unsupported direct source condition: ${rule.id}/${condition.field}`);
    }
  }
  return rule.conditionGroups;
}

export function directCandidateField(candidate: ReferenceCandidateDTO, field: string): readonly string[] {
  const prefix = `candidate.${candidate.typeCode}.`;
  if (!field.startsWith(prefix)) return [];
  const path = field.slice(prefix.length);
  let value: unknown;
  if (path === "sourceValue") value = candidate.sourceValue;
  else if (path === "scope") value = candidate.scope;
  else if (path === "subjectKind") value = candidate.subjectKind;
  else if (path.startsWith("context.")) value = candidate.context[path.slice(8)];
  else if (path.startsWith("evidence.")) value = candidate.evidence[path.slice(9)];
  return [typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : ""];
}
