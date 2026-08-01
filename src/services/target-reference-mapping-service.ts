import type { EntityId } from "../contracts/index.js";
import { MappingMissingError } from "../core/errors/index.js";
import type { ReferenceRepository } from "../repositories/index.js";

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

  getTargetMappingRevision(targetId: EntityId): Promise<string> {
    return this.references.getTargetMappingRevision(targetId);
  }
}
