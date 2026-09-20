import type {
  EntityId,
  TargetAssignmentDTO,
  TargetProjectionResolutionInput,
  TargetReferenceProjectionDTO,
  UniversalProductDTO,
} from "../contracts/index.js";
import { MappingMissingError } from "../core/errors/index.js";
import type { ReferenceRepository } from "../repositories/index.js";
import { resolveTargetAssignments } from "./target-assignment-rule-matcher.js";

export interface SupplementalTargetAssignmentResolver {
  createTargetAssignmentResolver(targetId: EntityId): Promise<(
    product: UniversalProductDTO,
  ) => readonly TargetAssignmentDTO[] | Promise<readonly TargetAssignmentDTO[]>>;
}

export interface RulesOperationScope {
  run<T>(callback: () => Promise<T>): Promise<T>;
  prepareProduct(sourceId: EntityId, product: UniversalProductDTO): Promise<UniversalProductDTO>;
}

function mergeAssignments(
  primary: readonly TargetAssignmentDTO[],
  supplemental: readonly TargetAssignmentDTO[],
): readonly TargetAssignmentDTO[] {
  return [...new Map([...primary, ...supplemental].map((assignment) => [
    `${assignment.targetScope}\u0000${assignment.externalValue}\u0000${assignment.mode}`,
    assignment,
  ])).values()];
}

export class TargetReferenceMappingService {
  private readonly assignmentResolvers = new Map<EntityId, {
    readonly revision: string;
    readonly resolve: (product: UniversalProductDTO) => Promise<readonly TargetAssignmentDTO[]>;
  }>();

  constructor(
    private readonly references: ReferenceRepository,
    private readonly supplementalAssignments?: SupplementalTargetAssignmentResolver,
    private readonly execution?: RulesOperationScope,
  ) {}

  runWithRules<T>(callback: () => Promise<T>): Promise<T> { return this.execution?.run(callback) ?? callback(); }

  prepareProduct(sourceId: EntityId, product: UniversalProductDTO): Promise<UniversalProductDTO> {
    return this.execution?.prepareProduct(sourceId, product) ?? Promise.resolve(product);
  }

  async resolveTargetValue(
    targetId: EntityId,
    referenceValueId: EntityId,
    targetScope: string,
  ): Promise<string> {
    const mapping = await this.references.resolveTargetValue(
      targetId,
      referenceValueId,
      targetScope,
    );

    if (mapping === null) {
      throw new MappingMissingError(
        `target=${targetId}, referenceValue=${referenceValueId}, scope=${targetScope}`,
      );
    }

    return mapping.externalValue;
  }

  async resolveTargetMapping(
    targetId: EntityId,
    referenceValueId: EntityId,
    targetScope: string,
  ) {
    const mapping = await this.references.resolveTargetValue(targetId, referenceValueId, targetScope);
    if (mapping === null) {
      throw new MappingMissingError(
        `target=${targetId}, referenceValue=${referenceValueId}, scope=${targetScope}`,
      );
    }
    return { externalValue: mapping.externalValue, externalLabel: mapping.externalLabel };
  }

  async resolveTargetProjections(
    targetId: EntityId,
    resolutions: readonly TargetProjectionResolutionInput[],
  ): Promise<readonly TargetReferenceProjectionDTO[]> {
    const unique = [...new Map(resolutions.map((item) => [`${item.resolutionKind}:${item.resolutionId}:${item.referenceId}`, item])).values()];
    const projections = await this.references.resolveTargetProjections(targetId, unique);
    return projections.map((projection) => {
      const metadata = projection.metadata;
      const managedRelation = metadata.managedBy === "target_term_relation"
        && typeof metadata.relationCode === "string"
        && typeof metadata.sourceTypeCode === "string"
        && typeof metadata.sourceLabel === "string";
      return {
        resolutionKind: "referenceValueId" in projection ? "reference" as const : projection.resolutionKind,
        resolutionId: "referenceValueId" in projection ? projection.referenceValueId : projection.resolutionId,
        targetScope: projection.targetScope,
        externalValue: projection.externalValue,
        externalLabel: projection.externalLabel,
        externalSlug: projection.externalSlug,
        ...(managedRelation ? {
          provenance: {
            kind: "related_target_term" as const,
            relationCode: metadata.relationCode as string,
            sourceTypeCode: metadata.sourceTypeCode as string,
            sourceLabel: metadata.sourceLabel as string,
          },
        } : {}),
      };
    });
  }

  saveTargetProjection(input: Parameters<ReferenceRepository["saveTargetProjection"]>[0]) {
    return this.references.saveTargetProjection(input);
  }

  getTargetMappingRevision(targetId: EntityId): Promise<string> {
    return this.references.getTargetMappingRevision(targetId);
  }

  async resolveTargetAssignments(targetId: EntityId, product: UniversalProductDTO) {
    const revision = await this.references.getTargetMappingRevision(targetId);
    let cached = this.assignmentResolvers.get(targetId);
    if (cached === undefined || cached.revision !== revision) {
      const resolve = await this.createTargetAssignmentResolver(targetId);
      cached = { revision, resolve };
      this.assignmentResolvers.set(targetId, { revision, resolve });
    }
    return cached.resolve(product);
  }

  async createTargetAssignmentResolver(targetId: EntityId) {
    const [rules, supplemental] = await Promise.all([
      this.references.listTargetAssignmentRules(targetId),
      this.supplementalAssignments?.createTargetAssignmentResolver(targetId),
    ]);
    return async (product: UniversalProductDTO) => mergeAssignments(
      resolveTargetAssignments(product, rules),
      await (supplemental?.(product) ?? []),
    );
  }
}
