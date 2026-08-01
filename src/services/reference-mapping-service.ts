import type { EntityId } from "../contracts/index.js";
import { MappingMissingError } from "../core/errors/index.js";
import type { ReferenceRepository } from "../repositories/index.js";

export function normalizeSourceValue(sourceValue: string): string {
  return sourceValue.trim().normalize("NFKC").toLowerCase();
}

export class ReferenceMappingService {
  constructor(private readonly references: ReferenceRepository) {}

  async resolveSourceValue(
    sourceId: EntityId,
    typeCode: string,
    scope: string,
    sourceValue: string,
  ): Promise<EntityId> {
    const normalizedSourceValue = normalizeSourceValue(sourceValue);
    const referenceValue = await this.references.resolveSourceValue({
      sourceId,
      typeCode,
      scope,
      normalizedSourceValue,
      status: "confirmed",
    });

    if (referenceValue === null) {
      throw new MappingMissingError(
        `source=${sourceId}, type=${typeCode}, scope=${scope}, value=${normalizedSourceValue}`,
      );
    }

    return referenceValue.id;
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

  getTargetMappingRevision(targetId: EntityId): Promise<string> {
    return this.references.getTargetMappingRevision(targetId);
  }
}
