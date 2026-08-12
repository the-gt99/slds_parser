import type {
  EntityId,
  TargetProjectionResolutionInput,
  TargetReferenceProjectionDTO,
  UniversalProductDTO,
} from "../contracts/index.js";
import { MappingMissingError } from "../core/errors/index.js";
import type { ReferenceRepository } from "../repositories/index.js";
import { resolveTargetAssignments } from "./target-assignment-rule-matcher.js";

export class TargetReferenceMappingService {
  constructor(private readonly references: ReferenceRepository) {}

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
    return resolveTargetAssignments(product, await this.references.listTargetAssignmentRules(targetId));
  }
}
