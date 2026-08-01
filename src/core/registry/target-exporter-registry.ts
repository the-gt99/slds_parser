import type { TargetExporter } from "../../contracts/index.js";
import { ExporterNotRegisteredError } from "../errors/index.js";

export class TargetExporterRegistry {
  readonly #exporters = new Map<string, TargetExporter>();

  register(key: string, exporter: TargetExporter): void {
    this.#exporters.set(key, exporter);
  }

  get(key: string): TargetExporter {
    const exporter = this.#exporters.get(key);

    if (exporter === undefined) {
      throw new ExporterNotRegisteredError(key);
    }

    return exporter;
  }
}
