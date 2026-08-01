import type { SourceProcessor } from "../../contracts/index.js";
import {
  DuplicateRegistrationError,
  ProcessorNotRegisteredError,
} from "../errors/index.js";

export class SourceProcessorRegistry {
  readonly #processors = new Map<string, SourceProcessor>();

  register(processor: SourceProcessor): void {
    if (this.#processors.has(processor.sourceCode)) {
      throw new DuplicateRegistrationError(
        "Source processor",
        processor.sourceCode,
      );
    }

    this.#processors.set(processor.sourceCode, processor);
  }

  get(code: string): SourceProcessor {
    const processor = this.#processors.get(code);

    if (processor === undefined) {
      throw new ProcessorNotRegisteredError(code);
    }

    return processor;
  }
}
