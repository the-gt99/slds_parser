import type { SourceAdapter } from "../../contracts/index.js";
import { AdapterNotRegisteredError } from "../errors/index.js";

export class SourceAdapterRegistry {
  readonly #adapters = new Map<string, SourceAdapter>();

  register(key: string, adapter: SourceAdapter): void {
    this.#adapters.set(key, adapter);
  }

  get(key: string): SourceAdapter {
    const adapter = this.#adapters.get(key);

    if (adapter === undefined) {
      throw new AdapterNotRegisteredError(key);
    }

    return adapter;
  }
}
