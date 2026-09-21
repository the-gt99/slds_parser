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
import { hashStableJson } from "../core/utils/index.js";
import type {
  ClassificationMappingMatchRecord,
  ClassificationRepository,
  ClassificationRuleConditionRecord,
  ClassificationRuleRecord,
  ProductClassificationObservationInput,
} from "../repositories/index.js";
import { prepareReferenceCandidates, validateReferenceCandidates, type PreparedReferenceCandidate } from "./reference-candidate-validation.js";
export { normalizeSourceValue } from "./reference-candidate-validation.js";
import {
  classificationRuleScore,
  compareClassificationRuleScore,
  matchesClassificationRule,
  normalizeClassificationValue,
} from "./classification-rule-matcher.js";

type PreparedCandidate = PreparedReferenceCandidate;

interface RuleMatch {
  readonly rule: ClassificationRuleRecord;
  readonly score: readonly [number, number];
}

interface CompiledRuleSet {
  readonly revision: string;
  readonly brandFamily: ReadonlyMap<string, readonly ClassificationRuleRecord[]>;
  readonly generalByType: ReadonlyMap<string, readonly ClassificationRuleRecord[]>;
}

function exactConditionValue(rule: ClassificationRuleRecord, field: string): string | null {
  const condition = rule.conditions.find((item) => item.field === field && item.operator === "equals");
  return condition === undefined ? null : normalizeClassificationValue(condition.value);
}

function brandFamilyRuleKey(typeCode: string, brand: string, family: string): string {
  return `${typeCode}\u0000${normalizeClassificationValue(brand)}\u0000${normalizeClassificationValue(family)}`;
}

function compileRuleSet(revision: string, rules: readonly ClassificationRuleRecord[]): CompiledRuleSet {
  const brandFamily = new Map<string, ClassificationRuleRecord[]>();
  const generalByType = new Map<string, ClassificationRuleRecord[]>();
  for (const rule of rules) {
    const brand = exactConditionValue(rule, "context.brand");
    const family = exactConditionValue(rule, "context.family");
    if (rule.conditions.length === 2 && brand !== null && family !== null) {
      const key = brandFamilyRuleKey(rule.typeCode, brand, family);
      const indexed = brandFamily.get(key) ?? [];
      indexed.push(rule);
      brandFamily.set(key, indexed);
    } else {
      const general = generalByType.get(rule.typeCode) ?? [];
      general.push(rule);
      generalByType.set(rule.typeCode, general);
    }
  }
  return { revision, brandFamily, generalByType };
}

interface CandidateOutcome {
  readonly prepared: PreparedCandidate;
  readonly resolved?: ClassifiedReferenceDTO;
  readonly ignored?: IgnoredReferenceDTO;
  readonly unresolved?: UnresolvedReferenceDTO;
  readonly matchedRuleIds?: readonly EntityId[];
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
      score: classificationRuleScore(rule),
    }))
    .sort((left, right) => compareClassificationRuleScore(right.score, left.score) || left.rule.id.localeCompare(right.rule.id));
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

function ruleOutcome(prepared: PreparedCandidate, rules: readonly ClassificationRuleRecord[]): CandidateOutcome {
  const { candidate } = prepared;
  const matches = matchingRules(candidate, rules);
  const bestScore = matches[0]?.score;
  const best = bestScore === undefined ? [] : matches.filter((match) => compareClassificationRuleScore(match.score, bestScore) === 0);
  const references = new Set(best.map(({ rule }) => rule.referenceValueId));
  if (references.size > 1) {
    return {
      prepared,
      matchedRuleIds: matches.map(({ rule }) => rule.id),
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
  private readonly ruleSets = new Map<EntityId, CompiledRuleSet>();
  private readonly ruleSetLoads = new Map<EntityId, Promise<CompiledRuleSet>>();

  constructor(private readonly repository: ClassificationRepository) {}

  private candidateRules(candidate: ReferenceCandidateDTO, ruleSet: CompiledRuleSet): readonly ClassificationRuleRecord[] {
    const brand = candidate.context.brand;
    const family = candidate.context.family;
    const indexed = typeof brand === "string" && typeof family === "string"
      ? ruleSet.brandFamily.get(brandFamilyRuleKey(candidate.typeCode, brand, family)) ?? []
      : [];
    return [...indexed, ...(ruleSet.generalByType.get(candidate.typeCode) ?? [])];
  }

  private async getRuleSet(sourceId: EntityId, revision: string): Promise<CompiledRuleSet> {
    const cached = this.ruleSets.get(sourceId);
    if (cached?.revision === revision) return cached;

    const activeLoad = this.ruleSetLoads.get(sourceId);
    if (activeLoad !== undefined) {
      const loaded = await activeLoad;
      if (loaded.revision === revision) return loaded;
      return this.getRuleSet(sourceId, revision);
    }

    const load = this.repository.listAllActiveRules(sourceId)
      .then((rules) => compileRuleSet(revision, rules));
    this.ruleSetLoads.set(sourceId, load);
    try {
      const loaded = await load;
      this.ruleSets.set(sourceId, loaded);
      return loaded;
    } finally {
      if (this.ruleSetLoads.get(sourceId) === load) this.ruleSetLoads.delete(sourceId);
    }
  }

  async classify(sourceId: EntityId, product: UniversalProductDTO): Promise<ProductClassifierRun> {
    const prepared = prepareReferenceCandidates(product.referenceCandidates);
    const typeCodes = [...new Set(prepared.map(({ candidate }) => candidate.typeCode))].sort();
    const typeDefinitions = await this.repository.listReferenceTypes(typeCodes);
    validateReferenceCandidates(prepared, typeDefinitions);

    const [mappingMatches, revision] = await Promise.all([
      this.repository.findSourceDecisions(sourceId, prepared.map(({ candidate, normalizedSourceValue, contextKey }) => ({
        candidateKey: candidate.key,
        typeCode: candidate.typeCode,
        scope: candidate.scope,
        normalizedSourceValue,
        contextKey,
      }))),
      this.repository.getActiveRuleSetRevision(sourceId),
    ]);
    const ruleSet = await this.getRuleSet(sourceId, revision);
    const mappings = new Map(mappingMatches.map((mapping) => [mapping.candidateKey, mapping]));
    const outcomes = prepared.map((candidate) => {
      const mapping = mappings.get(candidate.candidate.key);
      return mapping === undefined ? ruleOutcome(candidate, this.candidateRules(candidate.candidate, ruleSet)) : mappingOutcome(candidate, mapping);
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
        ...(outcome.matchedRuleIds === undefined ? {} : { matchedRuleIds: outcome.matchedRuleIds }),
      };
    });
    return { product: { ...product, classification }, observations };
  }
}
