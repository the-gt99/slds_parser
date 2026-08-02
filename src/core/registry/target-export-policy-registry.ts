import type { TargetExportPolicy } from "../../contracts/index.js";
import { DuplicateRegistrationError, IntegrationContractError } from "../errors/index.js";

export class TargetExportPolicyRegistry {
  readonly #policies = new Map<string, TargetExportPolicy>();

  register(policy: TargetExportPolicy): void {
    if (this.#policies.has(policy.targetCode)) {
      throw new DuplicateRegistrationError("Target export policy", policy.targetCode);
    }
    this.#policies.set(policy.targetCode, policy);
  }

  get(code: string): TargetExportPolicy {
    const policy = this.#policies.get(code);
    if (policy === undefined) throw new IntegrationContractError(`Target export policy is not registered: ${code}`);
    return policy;
  }

  fingerprint(): readonly { readonly targetCode: string; readonly version: string }[] {
    return [...this.#policies.values()]
      .map(({ targetCode, version }) => ({ targetCode, version }))
      .sort((left, right) => left.targetCode.localeCompare(right.targetCode));
  }
}
