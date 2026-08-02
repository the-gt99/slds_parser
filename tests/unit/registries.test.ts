import { describe, expect, it, vi } from "vitest";

import type {
  ProductOperation,
  SourceAdapter,
  SourceProcessor,
  TargetExporter,
} from "../../src/contracts/index.js";
import {
  AdapterNotRegisteredError,
  DuplicateRegistrationError,
  ExporterNotRegisteredError,
  ProcessorNotRegisteredError,
} from "../../src/core/errors/index.js";
import {
  ProductOperationRegistry,
  SourceAdapterRegistry,
  SourceProcessorRegistry,
  TargetExporterRegistry,
} from "../../src/core/registry/index.js";
import { registerPipelineComponents } from "../../src/bootstrap.js";

const adapter: SourceAdapter = {
  code: "source",
  version: "1.0.0",
  discover: vi.fn(),
  collectProduct: vi.fn(),
};

const processor: SourceProcessor = {
  sourceCode: "source",
  version: "1.0.0",
  process: vi.fn(),
};

const exporter: TargetExporter = {
  targetCode: "target",
  version: "1.0.0",
  export: vi.fn(),
};

const operation: ProductOperation = {
  code: "operation",
  version: "1.0.0",
  execute: vi.fn(),
};

describe("component registries", () => {
  it("registers the GOAT pipeline components in bootstrap", () => { const adapters = new SourceAdapterRegistry(); const processors = new SourceProcessorRegistry(); const operations = new ProductOperationRegistry(); const exporters = new TargetExporterRegistry(); registerPipelineComponents({ adapters, processors, operations, exporters }, { PARSER_PUBLIC_BASE_URL: "https://parser.example/images" }); expect(adapters.get("goat").code).toBe("goat"); expect(processors.get("goat").sourceCode).toBe("goat"); expect(operations.listForSource("goat").map((item) => item.code)).toEqual(["normalize-product", "translate-content", "download-images", "convert-images-to-webp", "publish-images", "validate-processed-product"]); });
  it("registers and returns implementations by their own code", () => {
    const adapterRegistry = new SourceAdapterRegistry();
    const processorRegistry = new SourceProcessorRegistry();
    const exporterRegistry = new TargetExporterRegistry();

    adapterRegistry.register(adapter);
    processorRegistry.register(processor);
    exporterRegistry.register(exporter);

    expect(adapterRegistry.get(adapter.code)).toBe(adapter);
    expect(processorRegistry.get(processor.sourceCode)).toBe(processor);
    expect(exporterRegistry.get(exporter.targetCode)).toBe(exporter);
  });

  it.each([
    [new SourceAdapterRegistry(), AdapterNotRegisteredError],
    [new SourceProcessorRegistry(), ProcessorNotRegisteredError],
    [new TargetExporterRegistry(), ExporterNotRegisteredError],
  ])(
    "throws the matching error for a missing registration",
    (registry, ErrorType) => {
      expect(() => registry.get("missing")).toThrow(ErrorType);
    },
  );

  it("rejects a duplicate adapter code without replacing the first adapter", () => {
    const registry = new SourceAdapterRegistry();
    const duplicate = { ...adapter, version: "2.0.0" };

    registry.register(adapter);

    expect(() => registry.register(duplicate)).toThrow(
      DuplicateRegistrationError,
    );
    expect(registry.get(adapter.code)).toBe(adapter);
  });

  it("rejects a duplicate processor code", () => {
    const registry = new SourceProcessorRegistry();

    registry.register(processor);

    expect(() => registry.register({ ...processor })).toThrow(
      DuplicateRegistrationError,
    );
  });

  it("rejects a duplicate exporter code", () => {
    const registry = new TargetExporterRegistry();

    registry.register(exporter);

    expect(() => registry.register({ ...exporter })).toThrow(
      DuplicateRegistrationError,
    );
  });

  it("rejects a duplicate product operation code", () => {
    const registry = new ProductOperationRegistry();

    registry.register(operation);

    expect(() => registry.register({ ...operation })).toThrow(
      DuplicateRegistrationError,
    );
  });
});
