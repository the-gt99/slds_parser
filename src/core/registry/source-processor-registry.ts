import type { SourceProcessor } from "../../contracts/index.js";
import { ProcessorNotRegisteredError } from "../errors/index.js";

export class SourceProcessorRegistry {
  readonly #processors = new Map<string, SourceProcessor>();

  register(key: string, processor: SourceProcessor): void {
    this.#processors.set(key, processor);
  }

  get(key: string): SourceProcessor {
    const processor = this.#processors.get(key);

    if (processor === undefined) {
      throw new ProcessorNotRegisteredError(key);
    }

    return processor;
  }
}
