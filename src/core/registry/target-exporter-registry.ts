import type { TargetExporter } from "../../contracts/index.js";
import {
  DuplicateRegistrationError,
  ExporterNotRegisteredError,
} from "../errors/index.js";

export class TargetExporterRegistry {
  readonly #exporters = new Map<string, TargetExporter>();

  register(exporter: TargetExporter): void {
    if (this.#exporters.has(exporter.targetCode)) {
      throw new DuplicateRegistrationError(
        "Target exporter",
        exporter.targetCode,
      );
    }

    this.#exporters.set(exporter.targetCode, exporter);
  }

  get(code: string): TargetExporter {
    const exporter = this.#exporters.get(code);

    if (exporter === undefined) {
      throw new ExporterNotRegisteredError(code);
    }

    return exporter;
  }
}
