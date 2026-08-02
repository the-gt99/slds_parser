import type { TargetExportPolicy, TargetExportReadiness, UniversalProductDTO } from "../../contracts/index.js";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export class WordPressExportPolicy implements TargetExportPolicy {
  readonly targetCode = "wordpress";
  readonly version = "1.0.0";

  evaluate(product: UniversalProductDTO): TargetExportReadiness {
    const requiredCandidateKeys = ["product:brand", "product:category"];
    if (text(product.attributes.family) !== "") requiredCandidateKeys.push("product:model");
    const resolvedKeys = new Set(product.classification?.resolved.map((value) => value.candidateKey) ?? []);
    const missingRequiredCandidateKeys = requiredCandidateKeys.filter((key) => !resolvedKeys.has(key));
    return { ready: missingRequiredCandidateKeys.length === 0, missingRequiredCandidateKeys };
  }
}
