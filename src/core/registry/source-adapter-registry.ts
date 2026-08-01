import type { SourceAdapter } from "../../contracts/index.js";
import {
  AdapterNotRegisteredError,
  DuplicateRegistrationError,
} from "../errors/index.js";

export class SourceAdapterRegistry {
  readonly #adapters = new Map<string, SourceAdapter>();

  register(adapter: SourceAdapter): void {
    if (this.#adapters.has(adapter.code)) {
      throw new DuplicateRegistrationError("Source adapter", adapter.code);
    }

    this.#adapters.set(adapter.code, adapter);
  }

  get(code: string): SourceAdapter {
    const adapter = this.#adapters.get(code);

    if (adapter === undefined) {
      throw new AdapterNotRegisteredError(code);
    }

    return adapter;
  }
}
