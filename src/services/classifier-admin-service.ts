import { randomUUID } from "node:crypto";

import type { EntityId, ReferenceCandidateDTO } from "../contracts/index.js";
import { IntegrationContractError } from "../core/errors/index.js";
import type {
  ClassificationAdminRepository,
  ClassificationConfigListQuery,
  ClassificationDecisionKey,
  ClassificationDecisionPreview,
  ClassificationReferenceValueOption,
  ClassificationRepository,
  ClassificationReviewItem,
  ClassificationReviewQuery,
  ClassificationRuleConditionRecord,
  ClassificationRuleRecord,
  SaveClassificationDecisionResult,
  SaveClassificationDecisionInput,
  TargetDictionaryValueRecord,
  TargetRelatedProjectionSync,
  TargetClassificationProjectionCommand,
  TargetDictionaryRepository,
  TargetRecord,
  TargetValueMappingCommand,
} from "../repositories/index.js";
import type { TargetDictionaryProviderRegistry } from "../integrations/index.js";
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
  readonly referenceValueId?: EntityId;
  readonly targetLink?: {
    readonly targetId: EntityId;
    readonly targetScope: string;
    readonly dictionaryValueId: EntityId;
  };
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
  readonly reason: string;
  readonly winningResolution?: {
    readonly kind: "mapping" | "rule";
    readonly id: EntityId;
    readonly name: string | null;
    readonly sameResult: boolean;
  };
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

export interface ProjectionCommand {
  readonly targetId: EntityId;
  readonly resolutionKind: "mapping" | "rule";
  readonly resolutionId: EntityId;
  readonly targetScope: string;
  readonly dictionaryValueId: EntityId;
  readonly reason?: string;
}

export interface ReferenceProjectionCommand {
  readonly targetId: EntityId;
  readonly referenceValueId: EntityId;
  readonly targetScope: string;
  readonly dictionaryValueId: EntityId;
  readonly reason?: string;
}

export interface ReferenceTargetMappingCommand extends ReferenceProjectionCommand {
  readonly typeCode: string;
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
  if ((draft.referenceValueId === undefined) === (draft.targetLink === undefined)) {
    throw new IntegrationContractError("A rule requires exactly one result: an internal value or a target term");
  }
  if (draft.referenceValueId !== undefined) validateText(draft.referenceValueId, "referenceValueId", 64);

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
  if (draft.typeCode === "model") {
    const hasContext = draft.conditions.some((condition) =>
      condition.field.startsWith("context.") || condition.field.startsWith("evidence."));
    const sourceOnly = draft.conditions.length === 1 && draft.conditions[0]?.field === "sourceValue";
    if (!hasContext || sourceOnly) {
      throw new IntegrationContractError("Model rules require product context or evidence; bare sourceValue rules are unsafe");
    }
  }
}

export class ClassifierAdminService {
  private readonly targetDictionaries: TargetDictionaryRepository | undefined;
  private readonly targetProviders: TargetDictionaryProviderRegistry | undefined;
  private readonly actor: string;
  private readonly currentProcessorVersions: Readonly<Record<EntityId, string>>;

  constructor(
    private readonly adminRepository: ClassificationAdminRepository,
    private readonly classificationRepository: ClassificationRepository,
    targetDictionariesOrActor?: TargetDictionaryRepository | string,
    targetProviders?: TargetDictionaryProviderRegistry,
    actor = "admin-api",
    currentProcessorVersions: Readonly<Record<EntityId, string>> = {},
  ) {
    this.currentProcessorVersions = currentProcessorVersions;
    if (typeof targetDictionariesOrActor === "string") {
      this.actor = targetDictionariesOrActor;
      return;
    }
    this.targetDictionaries = targetDictionariesOrActor;
    this.targetProviders = targetProviders;
    this.actor = actor;
  }

  listReviewQueue(query: ClassificationReviewQuery): Promise<readonly ClassificationReviewItem[]> {
    return this.adminRepository.listReviewQueue({ ...query, currentProcessorVersions: this.currentProcessorVersions });
  }

  countReviewQueue(query: ClassificationReviewQuery): Promise<number> {
    return this.adminRepository.countReviewQueue({ ...query, currentProcessorVersions: this.currentProcessorVersions });
  }

  listReviewExamples(reviewGroupId: EntityId, query: { readonly search?: string; readonly limit: number; readonly offset: number }) {
    validateText(reviewGroupId, "reviewGroupId", 64);
    return this.adminRepository.listReviewExamples({
      reviewGroupId,
      ...(query.search === undefined ? {} : { search: query.search }),
      limit: query.limit,
      offset: query.offset,
      currentProcessorVersions: this.currentProcessorVersions,
    });
  }

  listConfiguration(query: ClassificationConfigListQuery) {
    return this.adminRepository.listConfiguration({ ...query, currentProcessorVersions: this.currentProcessorVersions });
  }

  listConfigurationHistory(kind: "mapping" | "rule" | "target_mapping" | "projection", id: EntityId) {
    validateText(id, "id", 64);
    return this.adminRepository.listConfigurationHistory(kind, id);
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

  async saveDecision(
    command: ClassificationDecisionCommand,
    actor = this.actor,
  ): Promise<SaveClassificationDecisionResult> {
    validateText(command.sourceId, "sourceId", 64);
    validateText(command.scope, "scope", 200);
    validateText(command.normalizedSourceValue, "normalizedSourceValue", 1_000);
    validateText(command.contextKey, "contextKey", 10_000);
    const targetLink = command.targetLink === undefined
      ? undefined
      : await this.validatedTargetLink(command.typeCode, command.targetLink);

    return this.adminRepository.saveDecision({
      ...command,
      ...(targetLink === undefined ? {} : { targetLink }),
      ...(command.action === "confirm" && command.referenceValueId === undefined && command.targetLink !== undefined
        ? { generatedReferenceCode: `ref-${randomUUID()}` }
        : {}),
      actor,
    });
  }

  previewDecision(command: ClassificationDecisionCommand): Promise<ClassificationDecisionPreview> {
    validateText(command.sourceId, "sourceId", 64);
    validateText(command.scope, "scope", 200);
    validateText(command.normalizedSourceValue, "normalizedSourceValue", 1_000);
    validateText(command.contextKey, "contextKey", 10_000);
    if (command.action === "confirm" && command.referenceValueId === undefined && command.targetLink === undefined) {
      throw new IntegrationContractError("Confirmed classification decision requires a reference value or target term");
    }
    return this.adminRepository.previewDecision({ ...command, actor: this.actor });
  }

  listRuleConditionFields(sourceId: EntityId, typeCode: string) {
    validateText(sourceId, "sourceId", 64);
    if (!/^[a-z][a-z0-9_]*$/u.test(typeCode)) throw new IntegrationContractError("Invalid classification type code");
    return this.adminRepository.listRuleConditionFields(sourceId, typeCode, this.currentProcessorVersions[sourceId]);
  }

  async previewRule(
    draft: ClassificationRuleDraft,
    excludeRuleId?: EntityId,
    matchedObservationIds?: Set<EntityId>,
  ): Promise<ClassificationRulePreview> {
    validateRuleDraft(draft);
    const [resolution, candidates, existingRules] = await Promise.all([
      this.resolveRuleResult(draft),
      this.adminRepository.listRuleCandidates(
        draft.sourceId,
        draft.typeCode,
        this.currentProcessorVersions[draft.sourceId],
        draft.conditions,
      ),
      this.classificationRepository.listActiveRules(draft.sourceId, [draft.typeCode])
        .then((rules) => rules.filter((rule) => rule.id !== excludeRuleId)),
    ]);
    const proposed: ClassificationRuleRecord = {
      id: "preview",
      sourceId: draft.sourceId,
      typeCode: draft.typeCode,
      name: draft.name.trim(),
      priority: draft.priority,
      conditions: draft.conditions,
      referenceValueId: resolution.previewReferenceValueId,
      revision: "preview",
    };
    const proposedScore = classificationRuleScore(proposed);
    let ambiguousObservations = 0;
    let shadowedObservations = 0;
    const matchedProductIds = new Set<EntityId>();
    const affectedProductIds = new Set<EntityId>();
    const examples: ClassificationRulePreviewExample[] = [];
    let matchedObservations = 0;

    for (const item of candidates) {
      if (!matchesClassificationRule(item.candidate, draft.conditions)) continue;
      matchedObservations += 1;
      matchedObservationIds?.add(item.observationId);
      matchedProductIds.add(item.sourceProductId);
      if (item.mappingId !== null) {
        shadowedObservations += 1;
        if (examples.length < 10) {
          const sameResult = item.mappingReferenceValueId === resolution.previewReferenceValueId;
          examples.push({
            observationId: item.observationId,
            sourceProductId: item.sourceProductId,
            sourceKey: item.sourceKey,
            title: item.title,
            sku: item.sku,
            sourceValue: item.candidate.sourceValue,
            outcome: "shadowed",
            reason: sameResult
              ? `Уже покрыто более точным сопоставлением #${item.mappingId}; результат тот же.`
              : `Более точное сопоставление #${item.mappingId} имеет приоритет и ведёт к другому результату.`,
            winningResolution: { kind: "mapping", id: item.mappingId, name: null, sameResult },
          });
        }
        continue;
      }
      const existingMatches = existingRules
        .filter((rule) => matchesClassificationRule(item.candidate, rule.conditions))
        .map((rule) => ({ rule, score: classificationRuleScore(rule) }))
        .sort((left, right) => compareClassificationRuleScore(right.score, left.score));
      const existingBestScore = existingMatches[0]?.score;
      const comparison = existingBestScore === undefined
        ? 1
        : compareClassificationRuleScore(proposedScore, existingBestScore);
      let outcome: ClassificationRulePreviewExample["outcome"];
      let reason = "Новое правило будет применено.";
      let winningResolution: ClassificationRulePreviewExample["winningResolution"];
      if (comparison < 0) {
        shadowedObservations += 1;
        outcome = "shadowed";
        const winner = existingMatches[0]!.rule;
        const sameResult = winner.referenceValueId === resolution.previewReferenceValueId;
        reason = sameResult
          ? `Уже покрыто более точным правилом «${winner.name}» (#${winner.id}); результат тот же.`
          : `Более точное правило «${winner.name}» (#${winner.id}) имеет приоритет и ведёт к другому результату.`;
        winningResolution = { kind: "rule", id: winner.id, name: winner.name, sameResult };
      } else if (comparison === 0) {
        const bestRules = existingMatches.filter(({ score }) => compareClassificationRuleScore(score, existingBestScore!) === 0);
        const bestReferenceIds = new Set(
          bestRules.map(({ rule }) => rule.referenceValueId),
        );
        const differentWinner = bestRules.find(({ rule }) => rule.referenceValueId !== resolution.previewReferenceValueId)?.rule;
        if (differentWinner !== undefined) {
          ambiguousObservations += 1;
          outcome = "ambiguous";
          reason = `Равноценное правило «${differentWinner.name}» (#${differentWinner.id}) ведёт к другому результату.`;
          winningResolution = { kind: "rule", id: differentWinner.id, name: differentWinner.name, sameResult: false };
          affectedProductIds.add(item.sourceProductId);
        } else if (bestReferenceIds.has(resolution.previewReferenceValueId)) {
          const winner = bestRules[0]!.rule;
          shadowedObservations += 1;
          outcome = "shadowed";
          reason = `Уже покрыто равноценным правилом «${winner.name}» (#${winner.id}) с тем же результатом.`;
          winningResolution = { kind: "rule", id: winner.id, name: winner.name, sameResult: true };
        } else {
          outcome = "applicable";
          affectedProductIds.add(item.sourceProductId);
        }
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
          reason,
          ...(winningResolution === undefined ? {} : { winningResolution }),
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
    const matchedObservationIds = new Set<EntityId>();
    const preview = await this.previewRule(draft, undefined, matchedObservationIds);
    const resolution = await this.resolveRuleResult(draft);
    const result = await this.adminRepository.createRule({
      ...draft,
      name: draft.name.trim(),
      ...(resolution.referenceValueId === null ? {} : { referenceValueId: resolution.referenceValueId }),
      ...(resolution.targetLink === undefined ? {} : { targetLink: resolution.targetLink }),
      ...(resolution.referenceValueId === null ? { generatedReferenceCode: `ref-${randomUUID()}` } : {}),
      actor,
      affectedSourceProductIds: preview.affectedSourceProductIds,
      matchedObservationIds: [...matchedObservationIds],
    });
    return { ...result, preview };
  }

  async updateRule(ruleId: EntityId, draft: ClassificationRuleDraft, actor = this.actor) {
    validateText(ruleId, "ruleId", 64);
    const existing = await this.adminRepository.getRule(ruleId);
    if (existing === null) throw new IntegrationContractError(`Classification rule does not exist: ${ruleId}`);
    if (existing.sourceId !== draft.sourceId || existing.typeCode !== draft.typeCode) {
      throw new IntegrationContractError("Rule source and classification type cannot be changed");
    }
    const normalizedDraft = { ...draft, sourceId: existing.sourceId, typeCode: existing.typeCode };
    const resolution = await this.resolveRuleResult(normalizedDraft);
    if (resolution.referenceValueId === null) {
      throw new IntegrationContractError("A new target-linked internal value can only be created with a new rule");
    }
    const matchedObservationIds = new Set<EntityId>();
    const preview = await this.previewRule(normalizedDraft, ruleId, matchedObservationIds);
    const result = await this.adminRepository.updateRule({
      ruleId, ...normalizedDraft,
      referenceValueId: resolution.referenceValueId,
      name: draft.name.trim(),
      actor,
      affectedSourceProductIds: preview.affectedSourceProductIds,
      matchedObservationIds: [...matchedObservationIds],
    });
    return { ...result, preview };
  }

  async setRuleEnabled(ruleId: EntityId, enabled: boolean, actor = this.actor, reason?: string) {
    validateText(ruleId, "ruleId", 64);
    const rule = await this.adminRepository.getRule(ruleId);
    if (rule === null) throw new IntegrationContractError(`Classification rule does not exist: ${ruleId}`);
    const matchedObservationIds = new Set<EntityId>();
    const affectedSourceProductIds = enabled
      ? (await this.previewRule({
          sourceId: rule.sourceId,
          typeCode: rule.typeCode,
          name: rule.name,
          priority: rule.priority,
          conditions: rule.conditions,
          referenceValueId: rule.referenceValueId,
        }, ruleId, matchedObservationIds)).affectedSourceProductIds
      : await this.ruleAffectedProducts(ruleId);
    return this.adminRepository.setRuleEnabled({
      ruleId, enabled, actor, affectedSourceProductIds,
      matchedObservationIds: [...matchedObservationIds],
      ...(reason === undefined ? {} : { reason }),
    });
  }

  deleteRule(ruleId: EntityId, actor = this.actor, reason?: string) {
    validateText(ruleId, "ruleId", 64);
    return this.ruleAffectedProducts(ruleId).then((affectedSourceProductIds) => this.adminRepository.deleteRule({
      ruleId, actor, affectedSourceProductIds,
      ...(reason === undefined ? {} : { reason }),
    }));
  }

  getDecisionContext(key: ClassificationDecisionKey) {
    return this.adminRepository.getDecisionContext(key);
  }

  async previewTargetValueMapping(mappingId: EntityId, dictionaryValueId: EntityId) {
    return this.adminRepository.previewTargetValueMapping(
      await this.validatedTargetValueMappingCommand(mappingId, dictionaryValueId, this.actor),
    );
  }

  async updateTargetValueMapping(mappingId: EntityId, dictionaryValueId: EntityId, actor = this.actor, reason?: string) {
    return this.adminRepository.updateTargetValueMapping(
      await this.validatedTargetValueMappingCommand(mappingId, dictionaryValueId, actor, reason),
    );
  }

  setTargetValueMappingEnabled(mappingId: EntityId, enabled: boolean, actor = this.actor, reason?: string) {
    validateText(mappingId, "mappingId", 64);
    return this.adminRepository.setTargetValueMappingEnabled({ mappingId, enabled, actor, ...(reason === undefined ? {} : { reason }) });
  }

  async listTargetProjections(targetId: EntityId, resolutionKind: "mapping" | "rule", resolutionId: EntityId) {
    validateText(targetId, "targetId", 64);
    validateText(resolutionId, "resolutionId", 64);
    if (resolutionKind !== "mapping" && resolutionKind !== "rule") {
      throw new IntegrationContractError("resolutionKind must be mapping or rule");
    }
    return this.adminRepository.listTargetProjections(targetId, resolutionKind, resolutionId);
  }

  async previewTargetProjection(command: ProjectionCommand) {
    return this.adminRepository.previewTargetProjection(await this.validatedProjectionCommand(command, this.actor));
  }

  async createTargetProjection(command: ProjectionCommand, actor = this.actor) {
    return this.adminRepository.createTargetProjection(await this.validatedProjectionCommand(command, actor));
  }

  async updateTargetProjection(targetId: EntityId, projectionId: EntityId, command: Pick<ProjectionCommand, "targetScope" | "dictionaryValueId" | "reason">, actor = this.actor) {
    validateText(targetId, "targetId", 64);
    validateText(projectionId, "projectionId", 64);
    const existing = await this.adminRepository.getTargetProjection(targetId, projectionId);
    if (existing === null) throw new IntegrationContractError(`Target projection does not exist: ${projectionId}`);
    const validated = await this.validatedProjectionCommand({
      targetId,
      resolutionKind: existing.resolutionKind,
      resolutionId: existing.resolutionId,
      targetScope: command.targetScope,
      dictionaryValueId: command.dictionaryValueId,
      ...(command.reason === undefined ? {} : { reason: command.reason }),
    }, actor);
    return this.adminRepository.updateTargetProjection({ ...validated, projectionId });
  }

  async previewTargetProjectionUpdate(targetId: EntityId, projectionId: EntityId, command: Pick<ProjectionCommand, "targetScope" | "dictionaryValueId" | "reason">) {
    validateText(targetId, "targetId", 64);
    validateText(projectionId, "projectionId", 64);
    const existing = await this.adminRepository.getTargetProjection(targetId, projectionId);
    if (existing === null) throw new IntegrationContractError(`Target projection does not exist: ${projectionId}`);
    const validated = await this.validatedProjectionCommand({
      targetId,
      resolutionKind: existing.resolutionKind,
      resolutionId: existing.resolutionId,
      targetScope: command.targetScope,
      dictionaryValueId: command.dictionaryValueId,
      ...(command.reason === undefined ? {} : { reason: command.reason }),
    }, this.actor);
    return this.adminRepository.previewTargetProjection({ ...validated, excludeProjectionId: projectionId });
  }

  async deactivateTargetProjection(targetId: EntityId, projectionId: EntityId, actor = this.actor, reason?: string) {
    this.requireProjectionDependencies();
    validateText(targetId, "targetId", 64);
    validateText(projectionId, "projectionId", 64);
    return this.adminRepository.deactivateTargetProjection({
      targetId,
      projectionId,
      actor,
      ...(reason === undefined ? {} : { reason }),
    });
  }

  async createTargetValueMapping(command: ReferenceTargetMappingCommand, actor = this.actor) {
    this.requireProjectionDependencies();
    validateText(command.targetId, "targetId", 64);
    validateText(command.referenceValueId, "referenceValueId", 64);
    validateText(command.dictionaryValueId, "dictionaryValueId", 64);
    validateText(command.targetScope, "targetScope", 200);
    if (!/^[a-z][a-z0-9_]*$/u.test(command.typeCode)) throw new IntegrationContractError("Invalid classification type code");
    const target = await this.target(command.targetId);
    const provider = this.targetProviders!.get(providerCode(target.config, target.exporterCode));
    const capability = capabilitiesForTarget(target, provider.classificationCapabilities)
      .find((item) => item.typeCode === command.typeCode && item.targetScope === command.targetScope);
    if (capability === undefined) throw new IntegrationContractError(`Target scope ${command.targetScope} is not valid for ${command.typeCode}`);
    const dictionary = await this.targetDictionaries!.getValue(command.targetId, command.dictionaryValueId);
    if (dictionary === null || dictionary.entityType !== capability.entityType) throw new IntegrationContractError(`Dictionary value cannot be used for ${command.targetScope}`);
    const relatedProjectionSyncs = await this.relatedProjectionSyncs(target, provider, capability.typeCode, capability.entityType, capability.targetScope, dictionary);
    return this.adminRepository.createTargetValueMapping({
      ...command, targetCardinality: capability.cardinality, actor, relatedProjectionSyncs,
    });
  }

  listReferenceCatalog(query: { readonly typeCode?: string; readonly search?: string; readonly limit: number; readonly offset: number }) {
    return this.adminRepository.listReferenceCatalog(query);
  }

  async listReferenceProjections(targetId: EntityId, referenceValueId: EntityId) {
    validateText(targetId, "targetId", 64);
    validateText(referenceValueId, "referenceValueId", 64);
    return this.adminRepository.listReferenceProjections(targetId, referenceValueId);
  }

  async previewReferenceProjection(command: ReferenceProjectionCommand) {
    return this.adminRepository.previewReferenceProjection(await this.validatedReferenceProjectionCommand(command, this.actor));
  }

  async createReferenceProjection(command: ReferenceProjectionCommand, actor = this.actor) {
    return this.adminRepository.createReferenceProjection(await this.validatedReferenceProjectionCommand(command, actor));
  }

  async deactivateReferenceProjection(targetId: EntityId, projectionId: EntityId, actor = this.actor, reason?: string) {
    this.requireProjectionDependencies();
    validateText(targetId, "targetId", 64);
    validateText(projectionId, "projectionId", 64);
    return this.adminRepository.deactivateReferenceProjection({
      targetId, projectionId, actor, ...(reason === undefined ? {} : { reason }),
    });
  }

  private async ruleAffectedProducts(ruleId: EntityId): Promise<readonly EntityId[]> {
    const rule = await this.adminRepository.getRule(ruleId);
    if (rule === null) throw new IntegrationContractError(`Classification rule does not exist: ${ruleId}`);
    const candidates = await this.adminRepository.listRuleCandidates(
      rule.sourceId,
      rule.typeCode,
      this.currentProcessorVersions[rule.sourceId],
      rule.conditions,
    );
    return [...new Set(candidates
      .filter((item) => item.mappingId === null && matchesClassificationRule(item.candidate, rule.conditions))
      .map((item) => item.sourceProductId))];
  }

  private async resolveRuleResult(draft: ClassificationRuleDraft): Promise<{
    readonly previewReferenceValueId: EntityId;
    readonly referenceValueId: EntityId | null;
    readonly targetLink?: NonNullable<ClassificationRuleDraft["targetLink"]>;
  }> {
    if (draft.referenceValueId !== undefined) {
      return { previewReferenceValueId: draft.referenceValueId, referenceValueId: draft.referenceValueId };
    }
    const targetLink = await this.validatedRuleTargetLink(draft);
    const existing = await this.adminRepository.findRuleTargetReference({ typeCode: draft.typeCode, ...targetLink });
    return {
      previewReferenceValueId: existing ?? `target:${targetLink.targetId}:${targetLink.targetScope}:${targetLink.dictionaryValueId}`,
      referenceValueId: existing,
      targetLink,
    };
  }

  private async validatedRuleTargetLink(draft: ClassificationRuleDraft): Promise<NonNullable<ClassificationRuleDraft["targetLink"]>> {
    return this.validatedTargetLink(draft.typeCode, draft.targetLink!);
  }

  private async validatedTargetLink(
    typeCode: string,
    targetLink: NonNullable<ClassificationDecisionCommand["targetLink"]>,
  ): Promise<NonNullable<SaveClassificationDecisionInput["targetLink"]>> {
    this.requireProjectionDependencies();
    validateText(targetLink.targetId, "targetLink.targetId", 64);
    validateText(targetLink.targetScope, "targetLink.targetScope", 200);
    validateText(targetLink.dictionaryValueId, "targetLink.dictionaryValueId", 64);
    const target = await this.target(targetLink.targetId);
    const provider = this.targetProviders!.get(providerCode(target.config, target.exporterCode));
    const capability = capabilitiesForTarget(target, provider.classificationCapabilities)
      .find((item) => item.typeCode === typeCode && item.targetScope === targetLink.targetScope);
    if (capability === undefined) {
      throw new IntegrationContractError(`Target scope ${targetLink.targetScope} is not valid for ${typeCode}`);
    }
    const dictionary = await this.targetDictionaries!.getValue(targetLink.targetId, targetLink.dictionaryValueId);
    if (dictionary === null || dictionary.entityType !== capability.entityType) {
      throw new IntegrationContractError(`Dictionary value cannot be used for ${targetLink.targetScope}`);
    }
    const relatedProjectionSyncs = await this.relatedProjectionSyncs(
      target,
      provider,
      capability.typeCode,
      capability.entityType,
      capability.targetScope,
      dictionary,
    );
    const validated = {
      targetId: targetLink.targetId,
      targetScope: targetLink.targetScope,
      dictionaryValueId: targetLink.dictionaryValueId,
    };
    return relatedProjectionSyncs.length === 0 ? validated : { ...validated, relatedProjectionSyncs };
  }

  private async relatedProjectionSyncs(
    target: TargetRecord,
    provider: ReturnType<TargetDictionaryProviderRegistry["get"]>,
    typeCode: string,
    sourceEntityType: string,
    sourceTargetScope: string,
    sourceDictionary: TargetDictionaryValueRecord,
  ): Promise<readonly TargetRelatedProjectionSync[]> {
    const scopeOverrides = stringMap(target.config.targetScopeMap);
    const relations = (provider.termRelationCapabilities ?? []).filter((relation) =>
      relation.sourceEntityType === sourceEntityType && relation.relatedExternalIdPath !== undefined);
    const resolved = await Promise.all(relations.map(async (relation): Promise<TargetRelatedProjectionSync> => {
      const rawExternalId = valueAtPath(sourceDictionary.metadata, relation.relatedExternalIdPath!);
      const externalId = rawExternalId === null || rawExternalId === undefined ? "" : String(rawExternalId).trim();
      let dictionaryValueId: EntityId | null = null;
      if (externalId !== "" && externalId !== "0") {
        const matches = await this.targetDictionaries!.listValuesByExternalIds(target.id, [externalId]);
        const related = matches.find((value) => value.entityType === relation.relatedEntityType && value.active);
        if (related === undefined) {
          throw new IntegrationContractError(
            `Related target term ${relation.relatedEntityType}/${externalId} is absent from the synchronized dictionary`,
          );
        }
        dictionaryValueId = related.id;
      }
      return {
        relationCode: relation.relationCode,
        sourceTargetScope,
        targetScope: scopeOverrides[relation.targetScope] ?? relation.targetScope,
        dictionaryValueId,
        metadata: {
          managedBy: "target_term_relation",
          relationCode: relation.relationCode,
          relationLabel: relation.label,
          sourceTypeCode: typeCode,
          sourceTargetScope,
          sourceDictionaryValueId: sourceDictionary.id,
          sourceLabel: sourceDictionary.name,
        },
      };
    }));
    return resolved;
  }

  private async validatedProjectionCommand(command: ProjectionCommand, actor: string): Promise<TargetClassificationProjectionCommand> {
    this.requireProjectionDependencies();
    validateText(command.targetId, "targetId", 64);
    validateText(command.resolutionId, "resolutionId", 64);
    validateText(command.targetScope, "targetScope", 200);
    validateText(command.dictionaryValueId, "dictionaryValueId", 64);
    if (command.resolutionKind !== "mapping" && command.resolutionKind !== "rule") {
      throw new IntegrationContractError("resolutionKind must be mapping or rule");
    }
    const target = await this.target(command.targetId);
    const provider = this.targetProviders!.get(providerCode(target.config, target.exporterCode));
    const scopes = capabilitiesForTarget(target, provider.classificationCapabilities);
    const capability = scopes.find((item) => item.targetScope === command.targetScope);
    if (capability === undefined) {
      throw new IntegrationContractError(`Target scope is not supported: ${command.targetScope}`);
    }
    const dictionary = await this.targetDictionaries!.getValue(command.targetId, command.dictionaryValueId);
    if (dictionary === null) {
      throw new IntegrationContractError("Target dictionary value does not exist or is inactive");
    }
    if (dictionary.entityType !== capability.entityType) {
      throw new IntegrationContractError(`Dictionary value ${dictionary.entityType} cannot be used for ${command.targetScope}`);
    }
    return {
      targetId: command.targetId,
      resolutionKind: command.resolutionKind,
      resolutionId: command.resolutionId,
      targetScope: command.targetScope,
      dictionaryValueId: command.dictionaryValueId,
      targetCardinality: capability.cardinality,
      actor,
      ...(command.reason === undefined ? {} : { reason: command.reason }),
    };
  }

  private async validatedReferenceProjectionCommand(command: ReferenceProjectionCommand, actor: string) {
    this.requireProjectionDependencies();
    validateText(command.targetId, "targetId", 64);
    validateText(command.referenceValueId, "referenceValueId", 64);
    validateText(command.targetScope, "targetScope", 200);
    validateText(command.dictionaryValueId, "dictionaryValueId", 64);
    const target = await this.target(command.targetId);
    const provider = this.targetProviders!.get(providerCode(target.config, target.exporterCode));
    const capability = capabilitiesForTarget(target, provider.classificationCapabilities)
      .find((item) => item.targetScope === command.targetScope);
    if (capability === undefined) throw new IntegrationContractError(`Target scope is not supported: ${command.targetScope}`);
    const dictionary = await this.targetDictionaries!.getValue(command.targetId, command.dictionaryValueId);
    if (dictionary === null || dictionary.entityType !== capability.entityType) {
      throw new IntegrationContractError(`Dictionary value cannot be used for ${command.targetScope}`);
    }
    return {
      targetId: command.targetId,
      referenceValueId: command.referenceValueId,
      targetScope: command.targetScope,
      dictionaryValueId: command.dictionaryValueId,
      targetCardinality: capability.cardinality,
      actor,
      ...(command.reason === undefined ? {} : { reason: command.reason }),
    };
  }

  private async validatedTargetValueMappingCommand(
    mappingId: EntityId,
    dictionaryValueId: EntityId,
    actor: string,
    reason?: string,
  ): Promise<TargetValueMappingCommand> {
    this.requireProjectionDependencies();
    validateText(mappingId, "mappingId", 64);
    validateText(dictionaryValueId, "dictionaryValueId", 64);
    const mapping = await this.adminRepository.getTargetValueMapping(mappingId);
    if (mapping === null) throw new IntegrationContractError(`Target value mapping does not exist: ${mappingId}`);
    const target = await this.target(mapping.targetId);
    const provider = this.targetProviders!.get(providerCode(target.config, target.exporterCode));
    const capability = capabilitiesForTarget(target, provider.classificationCapabilities)
      .find((item) => item.typeCode === mapping.typeCode && item.targetScope === mapping.targetScope);
    if (capability === undefined) {
      throw new IntegrationContractError(`Target scope ${mapping.targetScope} is not valid for ${mapping.typeCode}`);
    }
    const dictionary = await this.targetDictionaries!.getValue(mapping.targetId, dictionaryValueId);
    if (dictionary === null || dictionary.entityType !== capability.entityType) {
      throw new IntegrationContractError(`Dictionary value cannot be used for ${mapping.targetScope}`);
    }
    const relatedProjectionSyncs = await this.relatedProjectionSyncs(
      target,
      provider,
      capability.typeCode,
      capability.entityType,
      capability.targetScope,
      dictionary,
    );
    return { mappingId, dictionaryValueId, relatedProjectionSyncs, actor, ...(reason === undefined ? {} : { reason }) };
  }

  private requireProjectionDependencies(): void {
    if (this.targetDictionaries === undefined || this.targetProviders === undefined) {
      throw new IntegrationContractError("Target projection management is not configured");
    }
  }

  private async target(targetId: EntityId): Promise<TargetRecord> {
    const target = (await this.targetDictionaries!.listTargets()).find((item) => item.id === targetId);
    if (target === undefined) throw new IntegrationContractError(`Target does not exist: ${targetId}`);
    return target;
  }
}

function providerCode(config: Record<string, unknown>, exporterCode: string): string {
  const configured = config.dictionaryProviderCode;
  return typeof configured === "string" && configured.trim() !== "" ? configured.trim() : exporterCode;
}

function stringMap(value: unknown): Readonly<Record<string, string>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) =>
    typeof entry === "string" && entry.trim() !== "" ? [[key, entry.trim()]] : []));
}

function valueAtPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function capabilitiesForTarget(
  target: TargetRecord,
  capabilities: readonly { readonly typeCode: string; readonly entityType: string; readonly targetScope: string; readonly cardinality: "single" | "multiple" }[],
) {
  const entityOverrides = stringMap(target.config.dictionaryEntityMap);
  const scopeOverrides = stringMap(target.config.targetScopeMap);
  return capabilities.map((capability) => ({
    ...capability,
    entityType: entityOverrides[capability.typeCode] ?? capability.entityType,
    targetScope: scopeOverrides[capability.targetScope] ?? capability.targetScope,
  }));
}
