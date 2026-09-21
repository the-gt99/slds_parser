import type { ReferenceCandidateDTO } from "../contracts/index.js";
import { IntegrationContractError } from "../core/errors/index.js";
import { stableJsonStringify } from "../core/utils/index.js";
import type { ClassificationReferenceTypeRecord } from "../repositories/index.js";
import { normalizeClassificationValue } from "./classification-rule-matcher.js";

export interface PreparedReferenceCandidate {
  readonly candidate: ReferenceCandidateDTO;
  readonly normalizedSourceValue: string;
  readonly contextKey: string;
}

export function normalizeSourceValue(sourceValue: string): string {
  return normalizeClassificationValue(sourceValue);
}

export function prepareReferenceCandidates(candidates: readonly ReferenceCandidateDTO[]): readonly PreparedReferenceCandidate[] {
  const keys = new Set<string>();
  return [...candidates].sort((left, right) => left.key.localeCompare(right.key)).map((candidate) => {
    if (candidate.key.trim() === "") throw new IntegrationContractError("Classification candidate key is required");
    if (!/^[a-z][a-z0-9_]*$/u.test(candidate.typeCode)) {
      throw new IntegrationContractError(`Invalid classification type code: ${candidate.typeCode}`);
    }
    if (candidate.scope.trim() === "") throw new IntegrationContractError(`Classification scope is required for ${candidate.key}`);
    if (candidate.sourceValue.trim() === "") throw new IntegrationContractError(`Classification source value is required for ${candidate.key}`);
    if (candidate.subjectKind === "variant" && !candidate.subjectKey) {
      throw new IntegrationContractError(`Variant classification candidate ${candidate.key} requires subjectKey`);
    }
    if (candidate.subjectKind === "product" && candidate.subjectKey !== undefined) {
      throw new IntegrationContractError(`Product classification candidate ${candidate.key} must not have subjectKey`);
    }
    if (keys.has(candidate.key)) throw new IntegrationContractError(`Duplicate classification candidate key: ${candidate.key}`);
    keys.add(candidate.key);
    return { candidate, normalizedSourceValue: normalizeSourceValue(candidate.sourceValue), contextKey: stableJsonStringify(candidate.context) };
  });
}

export function validateReferenceCandidates(prepared: readonly PreparedReferenceCandidate[],
  typeDefinitions: readonly ClassificationReferenceTypeRecord[]): void {
  const definitions = new Map(typeDefinitions.map((definition) => [definition.code, definition]));
  const unknownTypes = [...new Set(prepared.map(({ candidate }) => candidate.typeCode))]
    .filter((typeCode) => !definitions.has(typeCode));
  if (unknownTypes.length > 0) throw new IntegrationContractError(`Unknown classification reference types: ${unknownTypes.join(", ")}`);
  const counts = new Map<string, number>();
  for (const { candidate } of prepared) {
    const definition = definitions.get(candidate.typeCode)!;
    if (!definition.allowedSubjectKinds.includes(candidate.subjectKind)) {
      throw new IntegrationContractError(`Classification type ${candidate.typeCode} does not allow subject ${candidate.subjectKind}`);
    }
    const subject = `${candidate.typeCode}/${candidate.subjectKind}/${candidate.subjectKey ?? ""}`;
    const count = (counts.get(subject) ?? 0) + 1;
    counts.set(subject, count);
    if (definition.cardinality === "single" && count > 1) {
      throw new IntegrationContractError(`Classification type ${candidate.typeCode} allows only one value for ${candidate.subjectKind} ${candidate.subjectKey ?? "product"}`);
    }
  }
}
