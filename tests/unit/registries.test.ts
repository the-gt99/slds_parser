import { describe, expect, it, vi } from "vitest";

import type {
  SourceAdapter,
  SourceProcessor,
  TargetExporter,
} from "../../src/contracts/index.js";
import {
  AdapterNotRegisteredError,
  ExporterNotRegisteredError,
  ProcessorNotRegisteredError,
} from "../../src/core/errors/index.js";
import {
  SourceAdapterRegistry,
  SourceProcessorRegistry,
  TargetExporterRegistry,
} from "../../src/core/registry/index.js";

const adapter: SourceAdapter = {
  version: "1.0.0",
  discover: vi.fn(),
  collectProduct: vi.fn(),
};

const processor: SourceProcessor = {
  version: "1.0.0",
  process: vi.fn(),
};

const exporter: TargetExporter = {
  version: "1.0.0",
  export: vi.fn(),
};

describe("component registries", () => {
  it("registers and returns a source adapter", () => {
    const registry = new SourceAdapterRegistry();
    registry.register("source", adapter);

    expect(registry.get("source")).toBe(adapter);
  });

  it("registers and returns a source processor", () => {
    const registry = new SourceProcessorRegistry();
    registry.register("source", processor);

    expect(registry.get("source")).toBe(processor);
  });

  it("registers and returns a target exporter", () => {
    const registry = new TargetExporterRegistry();
    registry.register("target", exporter);

    expect(registry.get("target")).toBe(exporter);
  });

  it.each([
    [new SourceAdapterRegistry(), AdapterNotRegisteredError],
    [new SourceProcessorRegistry(), ProcessorNotRegisteredError],
    [new TargetExporterRegistry(), ExporterNotRegisteredError],
  ])("throws the matching error for a missing registration", (registry, ErrorType) => {
    expect(() => registry.get("missing")).toThrow(ErrorType);
  });
});
