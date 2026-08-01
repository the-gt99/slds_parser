import type {
  ClassifiedReferenceDTO,
  EntityId,
  IgnoredReferenceDTO,
  JsonObject,
  ProductClassificationDTO,
  ReferenceCandidateDTO,
  UniversalProductDTO,
  UnresolvedReferenceDTO,
} from "../contracts/index.js";
import { IntegrationContractError } from "../core/errors/index.js";
import { hashStableJson, stableJsonStringify } from "../core/utils/index.js";
import type {
  ClassificationMappingMatchRecord,
  ClassificationReferenceTypeRecord,
  ClassificationRepository,
  ClassificationRuleConditionRecord,
  ClassificationRuleRecord,
  ProductClassificationObservationInput,
} from "../repositories/index.js";
import {
  classificationRuleScore,
  compareClassificationRuleScore,
  matchesClassificationRule,
  normalizeClassificationValue,
} from "./classification-rule-matcher.js";

export function normalizeSourceValue(sourceValue: string): string {
  return normalizeClassificationValue(sourceValue);
}

interface PreparedCandidate {
  readonly candidate: ReferenceCandidateDTO;
  readonly normalizedSourceValue: string;
  readonly contextKey: string;
}

interface RuleMatch {
  readonly rule: ClassificationRuleRecord;
  readonly score: readonly [number, number, number];
}

interface CandidateOutcome {
  readonly prepared: PreparedCandidate;
  readonly resolved?: ClassifiedReferenceDTO;
  readonly ignored?: IgnoredReferenceDTO;
  readonly unresolved?: UnresolvedReferenceDTO;
  readonly fingerprint: JsonObject;
}

export interface ProductClassifierRun {
  readonly product: UniversalProductDTO & { readonly classification: ProductClassificationDTO };
  readonly observations: readonly ProductClassificationObservationInput[];
}

function optionalSubjectKey(candidate: ReferenceCandidateDTO): { readonly subjectKey?: string } {
  return candidate.subjectKey === undefined ? {} : { subjectKey: candidate.subjectKey };
}

function matchingRules(
  sourceId: EntityId,
  candidate: ReferenceCandidateDTO,
  rules: readonly ClassificationRuleRecord[],
): readonly RuleMatch[] {
  return rules
    .filter((rule) => {
      if (rule.typeCode !== candidate.typeCode || rule.conditions.length === 0) return false;
      return matchesClassificationRule(candidate, rule.conditions);
    })
    .map((rule) => ({
      rule,
      score: classificationRuleScore(sourceId, rule),
    }))
    .sort((left, right) => compareClassificationRuleScore(right.score, left.score) || left.rule.id.localeCompare(right.rule.id));
}

function validateCandidate(candidate: ReferenceCandidateDTO): void {
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
}

function prepareCandidates(candidates: readonly ReferenceCandidateDTO[]): readonly PreparedCandidate[] {
  const keys = new Set<string>();
  return [...candidates]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((candidate) => {
      validateCandidate(candidate);
      if (keys.has(candidate.key)) throw new IntegrationContractError(`Duplicate classification candidate key: ${candidate.key}`);
      keys.add(candidate.key);
      return {
        candidate,
        normalizedSourceValue: normalizeSourceValue(candidate.sourceValue),
        contextKey: stableJsonStringify(candidate.context),
      };
    });
}

function validateReferenceTypes(
  prepared: readonly PreparedCandidate[],
  typeDefinitions: readonly ClassificationReferenceTypeRecord[],
): void {
  const definitions = new Map(typeDefinitions.map((definition) => [definition.code, definition]));
  const requestedTypes = [...new Set(prepared.map(({ candidate }) => candidate.typeCode))];
  const unknownTypes = requestedTypes.filter((typeCode) => !definitions.has(typeCode));
  if (unknownTypes.length > 0) {
    throw new IntegrationContractError(`Unknown classification reference types: ${unknownTypes.join(", ")}`);
  }
  const counts = new Map<string, number>();
  for (const { candidate } of prepared) {
    const definition = definitions.get(candidate.typeCode)!;
    if (!definition.allowedSubjectKinds.includes(candidate.subjectKind)) {
      throw new IntegrationContractError(
        `Classification type ${candidate.typeCode} does not allow subject ${candidate.subjectKind}`,
      );
    }
    const subject = `${candidate.typeCode}/${candidate.subjectKind}/${candidate.subjectKey ?? ""}`;
    const count = (counts.get(subject) ?? 0) + 1;
    counts.set(subject, count);
    if (definition.cardinality === "single" && count > 1) {
      throw new IntegrationContractError(
        `Classification type ${candidate.typeCode} allows only one value for ${candidate.subjectKind} ${candidate.subjectKey ?? "product"}`,
      );
    }
  }
}

function mappingOutcome(
  prepared: PreparedCandidate,
  mapping: ClassificationMappingMatchRecord,
): CandidateOutcome {
  const { candidate } = prepared;
  if (mapping.status === "ignored") {
    return {
      prepared,
      ignored: {
        candidateKey: candidate.key,
        typeCode: candidate.typeCode,
        scope: candidate.scope,
        subjectKind: candidate.subjectKind,
        ...optionalSubjectKey(candidate),
        sourceValue: candidate.sourceValue,
        mappingId: mapping.mappingId,
        mappingRevision: mapping.revision,
      },
      fingerprint: { candidateKey: candidate.key, outcome: "ignored", mappingId: mapping.mappingId, revision: mapping.revision },
    };
  }
  if (mapping.referenceValueId === null) {
    throw new IntegrationContractError(`Confirmed mapping ${mapping.mappingId} has no reference value`);
  }
  return {
    prepared,
    resolved: {
      candidateKey: candidate.key,
      typeCode: candidate.typeCode,
      scope: candidate.scope,
      subjectKind: candidate.subjectKind,
      ...optionalSubjectKey(candidate),
      referenceValueId: mapping.referenceValueId,
      resolutionKind: "mapping",
      resolutionId: mapping.mappingId,
      resolutionRevision: mapping.revision,
    },
    fingerprint: {
      candidateKey: candidate.key,
      outcome: "resolved",
      referenceValueId: mapping.referenceValueId,
      mappingId: mapping.mappingId,
      revision: mapping.revision,
    },
  };
}

function ruleOutcome(
  sourceId: EntityId,
  prepared: PreparedCandidate,
  rules: readonly ClassificationRuleRecord[],
): CandidateOutcome {
  const { candidate } = prepared;
  const matches = matchingRules(sourceId, candidate, rules);
  const bestScore = matches[0]?.score;
  const best = bestScore === undefined ? [] : matches.filter((match) => compareClassificationRuleScore(match.score, bestScore) === 0);
  const references = new Set(best.map(({ rule }) => rule.referenceValueId));
  if (references.size > 1) {
    return {
      prepared,
      unresolved: {
        candidateKey: candidate.key,
        typeCode: candidate.typeCode,
        scope: candidate.scope,
        subjectKind: candidate.subjectKind,
        ...optionalSubjectKey(candidate),
        sourceValue: candidate.sourceValue,
        reason: "rule_ambiguous",
      },
      fingerprint: {
        candidateKey: candidate.key,
        outcome: "ambiguous",
        rules: best.map(({ rule }) => ({ id: rule.id, revision: rule.revision, referenceValueId: rule.referenceValueId })),
      },
    };
  }
  const selected = best[0]?.rule;
  if (selected === undefined) {
    return {
      prepared,
      unresolved: {
        candidateKey: candidate.key,
        typeCode: candidate.typeCode,
        scope: candidate.scope,
        subjectKind: candidate.subjectKind,
        ...optionalSubjectKey(candidate),
        sourceValue: candidate.sourceValue,
        reason: "mapping_missing",
      },
      fingerprint: { candidateKey: candidate.key, outcome: "unresolved" },
    };
  }
  return {
    prepared,
    resolved: {
      candidateKey: candidate.key,
      typeCode: candidate.typeCode,
      scope: candidate.scope,
      subjectKind: candidate.subjectKind,
      ...optionalSubjectKey(candidate),
      referenceValueId: selected.referenceValueId,
      resolutionKind: "rule",
      resolutionId: selected.id,
      resolutionRevision: selected.revision,
    },
    fingerprint: {
      candidateKey: candidate.key,
      outcome: "resolved",
      referenceValueId: selected.referenceValueId,
      rules: best.map(({ rule }) => ({ id: rule.id, revision: rule.revision })),
    },
  };
}

export class ProductClassifier {
  readonly version = "1.0.0";

  constructor(private readonly repository: ClassificationRepository) {}

  async classify(sourceId: EntityId, product: UniversalProductDTO): Promise<ProductClassifierRun> {
    const prepared = prepareCandidates(product.referenceCandidates);
    const typeCodes = [...new Set(prepared.map(({ candidate }) => candidate.typeCode))].sort();
    const typeDefinitions = await this.repository.listReferenceTypes(typeCodes);
    validateReferenceTypes(prepared, typeDefinitions);

    const [mappingMatches, rules] = await Promise.all([
      this.repository.findSourceDecisions(sourceId, prepared.map(({ candidate, normalizedSourceValue, contextKey }) => ({
        candidateKey: candidate.key,
        typeCode: candidate.typeCode,
        scope: candidate.scope,
        normalizedSourceValue,
        contextKey,
      }))),
      this.repository.listActiveRules(sourceId, typeCodes),
    ]);
    const mappings = new Map(mappingMatches.map((mapping) => [mapping.candidateKey, mapping]));
    const outcomes = prepared.map((candidate) => {
      const mapping = mappings.get(candidate.candidate.key);
      return mapping === undefined ? ruleOutcome(sourceId, candidate, rules) : mappingOutcome(candidate, mapping);
    });
    const resolved = outcomes.flatMap((outcome) => outcome.resolved === undefined ? [] : [outcome.resolved]);
    const ignored = outcomes.flatMap((outcome) => outcome.ignored === undefined ? [] : [outcome.ignored]);
    const unresolved = outcomes.flatMap((outcome) => outcome.unresolved === undefined ? [] : [outcome.unresolved]);
    const fingerprint = hashStableJson({
      classifierVersion: this.version,
      outcomes: outcomes.map((outcome) => outcome.fingerprint),
    });
    const classification = {
      status: unresolved.length === 0 ? "complete" as const : "partial" as const,
      classifierVersion: this.version,
      fingerprint,
      resolved,
      ignored,
      unresolved,
    };
    const observations = outcomes.map<ProductClassificationObservationInput>((outcome) => {
      const resolution = outcome.resolved;
      const ignoredReference = outcome.ignored;
      return {
        candidate: outcome.prepared.candidate,
        normalizedSourceValue: outcome.prepared.normalizedSourceValue,
        contextKey: outcome.prepared.contextKey,
        status: resolution !== undefined ? "resolved" : ignoredReference !== undefined ? "ignored"
          : outcome.unresolved?.reason === "rule_ambiguous" ? "ambiguous" : "unresolved",
        issueReason: outcome.unresolved?.reason ?? null,
        referenceValueId: resolution?.referenceValueId ?? null,
        resolutionKind: resolution?.resolutionKind ?? (ignoredReference === undefined ? null : "mapping"),
        resolutionId: resolution?.resolutionId ?? ignoredReference?.mappingId ?? null,
        resolutionRevision: resolution?.resolutionRevision ?? ignoredReference?.mappingRevision ?? null,
      };
    });
    return { product: { ...product, classification }, observations };
  }
}
