import { randomUUID } from "node:crypto";

import type { EntityId, ReferenceCandidateDTO } from "../contracts/index.js";
import { IntegrationContractError } from "../core/errors/index.js";
import type {
  ClassificationAdminRepository,
  ClassificationDecisionKey,
  ClassificationReferenceValueOption,
  ClassificationRepository,
  ClassificationReviewItem,
  ClassificationReviewQuery,
  ClassificationRuleConditionRecord,
  ClassificationRuleRecord,
  SaveClassificationDecisionResult,
} from "../repositories/index.js";
import {
  classificationRuleScore,
  compareClassificationRuleScore,
  matchesClassificationCondition,
  matchesClassificationRule,
} from "./classification-rule-matcher.js";

export interface ClassificationDecisionCommand extends ClassificationDecisionKey {
  readonly action: "confirm" | "ignore";
  readonly referenceValueId?: EntityId;
  readonly targetLink?: {
    readonly targetId: EntityId;
    readonly targetScope: string;
    readonly dictionaryValueId: EntityId;
  };
  readonly reason?: string;
}

export interface ClassificationRuleDraft {
  readonly sourceId: EntityId;
  readonly typeCode: string;
  readonly name: string;
  readonly priority: number;
  readonly conditions: readonly ClassificationRuleConditionRecord[];
  readonly referenceValueId: EntityId;
  readonly reason?: string;
}

export interface ClassificationRulePreviewExample {
  readonly observationId: EntityId;
  readonly sourceProductId: EntityId;
  readonly sourceKey: string;
  readonly title: string | null;
  readonly sku: string | null;
  readonly sourceValue: string;
  readonly outcome: "applicable" | "ambiguous" | "shadowed";
}

export interface ClassificationRulePreview {
  readonly matchedObservations: number;
  readonly matchedProducts: number;
  readonly affectedProducts: number;
  readonly ambiguousObservations: number;
  readonly shadowedObservations: number;
  readonly examples: readonly ClassificationRulePreviewExample[];
  readonly affectedSourceProductIds: readonly EntityId[];
}

function validateText(value: string, field: string, maximum: number): string {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > maximum) {
    throw new IntegrationContractError(`${field} must contain from 1 to ${maximum} characters`);
  }
  return trimmed;
}

function validateRuleDraft(draft: ClassificationRuleDraft): void {
  validateText(draft.sourceId, "sourceId", 64);
  if (!/^[a-z][a-z0-9_]*$/u.test(draft.typeCode)) {
    throw new IntegrationContractError("Invalid classification type code");
  }
  validateText(draft.name, "name", 200);
  if (!Number.isInteger(draft.priority) || draft.priority < -10_000 || draft.priority > 10_000) {
    throw new IntegrationContractError("priority must be an integer from -10000 to 10000");
  }
  if (draft.conditions.length === 0 || draft.conditions.length > 10) {
    throw new IntegrationContractError("A rule must contain from 1 to 10 conditions");
  }

  const emptyCandidate: ReferenceCandidateDTO = {
    key: "preview",
    typeCode: draft.typeCode,
    scope: "preview",
    subjectKind: "product",
    sourceValue: "preview",
    context: {},
    evidence: {},
  };
  for (const condition of draft.conditions) {
    matchesClassificationCondition(emptyCandidate, condition);
  }
}

export class ClassifierAdminService {
  constructor(
    private readonly adminRepository: ClassificationAdminRepository,
    private readonly classificationRepository: ClassificationRepository,
    private readonly actor = "admin-api",
  ) {}

  listReviewQueue(query: ClassificationReviewQuery): Promise<readonly ClassificationReviewItem[]> {
    return this.adminRepository.listReviewQueue(query);
  }

  listReferenceValues(
    typeCode: string,
    search: string | undefined,
    limit: number,
  ): Promise<readonly ClassificationReferenceValueOption[]> {
    if (!/^[a-z][a-z0-9_]*$/u.test(typeCode)) {
      throw new IntegrationContractError("Invalid classification type code");
    }
    return this.adminRepository.listReferenceValues(typeCode, search, limit);
  }

  saveDecision(
    command: ClassificationDecisionCommand,
    actor = this.actor,
  ): Promise<SaveClassificationDecisionResult> {
    validateText(command.sourceId, "sourceId", 64);
    validateText(command.scope, "scope", 200);
    validateText(command.normalizedSourceValue, "normalizedSourceValue", 1_000);
    validateText(command.contextKey, "contextKey", 10_000);
    if (command.targetLink !== undefined) {
      validateText(command.targetLink.targetScope, "targetScope", 200);
    }

    return this.adminRepository.saveDecision({
      ...command,
      ...(command.action === "confirm" && command.referenceValueId === undefined && command.targetLink !== undefined
        ? { generatedReferenceCode: `ref-${randomUUID()}` }
        : {}),
      actor,
    });
  }

  async previewRule(draft: ClassificationRuleDraft): Promise<ClassificationRulePreview> {
    validateRuleDraft(draft);
    const [candidates, existingRules] = await Promise.all([
      this.adminRepository.listRuleCandidates(draft.sourceId, draft.typeCode),
      this.classificationRepository.listActiveRules(draft.sourceId, [draft.typeCode]),
    ]);
    const proposed: ClassificationRuleRecord = {
      id: "preview",
      sourceId: draft.sourceId,
      typeCode: draft.typeCode,
      name: draft.name.trim(),
      priority: draft.priority,
      conditions: draft.conditions,
      referenceValueId: draft.referenceValueId,
      revision: "preview",
    };
    const proposedScore = classificationRuleScore(draft.sourceId, proposed);
    let ambiguousObservations = 0;
    let shadowedObservations = 0;
    const matchedProductIds = new Set<EntityId>();
    const affectedProductIds = new Set<EntityId>();
    const examples: ClassificationRulePreviewExample[] = [];
    let matchedObservations = 0;

    for (const item of candidates) {
      if (!matchesClassificationRule(item.candidate, draft.conditions)) continue;
      matchedObservations += 1;
      matchedProductIds.add(item.sourceProductId);
      const existingMatches = existingRules
        .filter((rule) => matchesClassificationRule(item.candidate, rule.conditions))
        .map((rule) => ({ rule, score: classificationRuleScore(item.sourceId, rule) }))
        .sort((left, right) => compareClassificationRuleScore(right.score, left.score));
      const existingBestScore = existingMatches[0]?.score;
      const comparison = existingBestScore === undefined
        ? 1
        : compareClassificationRuleScore(proposedScore, existingBestScore);
      let outcome: ClassificationRulePreviewExample["outcome"];
      if (comparison < 0) {
        shadowedObservations += 1;
        outcome = "shadowed";
      } else if (comparison === 0) {
        const bestReferenceIds = new Set(
          existingMatches
            .filter(({ score }) => compareClassificationRuleScore(score, existingBestScore!) === 0)
            .map(({ rule }) => rule.referenceValueId),
        );
        if ([...bestReferenceIds].some((referenceId) => referenceId !== draft.referenceValueId)) {
          ambiguousObservations += 1;
          outcome = "ambiguous";
        } else {
          outcome = "applicable";
        }
        affectedProductIds.add(item.sourceProductId);
      } else {
        outcome = "applicable";
        affectedProductIds.add(item.sourceProductId);
      }

      if (examples.length < 10) {
        examples.push({
          observationId: item.observationId,
          sourceProductId: item.sourceProductId,
          sourceKey: item.sourceKey,
          title: item.title,
          sku: item.sku,
          sourceValue: item.candidate.sourceValue,
          outcome,
        });
      }
    }

    return {
      matchedObservations,
      matchedProducts: matchedProductIds.size,
      affectedProducts: affectedProductIds.size,
      ambiguousObservations,
      shadowedObservations,
      examples,
      affectedSourceProductIds: [...affectedProductIds],
    };
  }

  async createRule(draft: ClassificationRuleDraft, actor = this.actor) {
    const preview = await this.previewRule(draft);
    const result = await this.adminRepository.createRule({
      ...draft,
      name: draft.name.trim(),
      actor,
      affectedSourceProductIds: preview.affectedSourceProductIds,
    });
    return { ...result, preview };
  }

  getDecisionContext(key: ClassificationDecisionKey) {
    return this.adminRepository.getDecisionContext(key);
  }
}
