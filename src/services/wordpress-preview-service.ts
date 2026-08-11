import type { EntityId, JsonObject, SourceDTO, SourceProductDTO, TargetContentTemplateDTO, TargetDTO } from "../contracts/index.js";
import { EntityNotFoundError, IntegrationContractError } from "../core/errors/index.js";
import type { TargetExporterRegistry } from "../core/registry/index.js";
import { hashStableJson } from "../core/utils/index.js";
import { perceptualHashDistance } from "../processing/media/index.js";
import {
  applyWordPressTitlePolicy,
  renderWordPressContentFields,
  type WordPressProductSnapshotReader,
  WordPressExporter,
} from "../integrations/index.js";
import type {
  InternalProductRepository,
  SourceProductRepository,
  SourceRepository,
  TargetDictionaryRepository,
  TargetDictionaryValueRecord,
  TargetRepository,
  TargetContentTemplateRepository,
  ExportControlRepository,
} from "../repositories/index.js";
import type { TargetReferenceMappingService } from "./target-reference-mapping-service.js";
import { summarizeExportControlPreflight } from "./export-control-summary.js";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalized(item)]));
  }
  return value;
}

function different(expected: unknown, actual: unknown): boolean {
  return JSON.stringify(normalized(expected)) !== JSON.stringify(normalized(actual));
}

function sizeKey(value: unknown): string {
  const size = record(value);
  const taxonomy = String(size.taxonomy ?? "");
  const termId = Number(size.term_id);
  return taxonomy !== "" && Number.isSafeInteger(termId) && termId > 0 ? `${taxonomy}:${termId}` : "";
}

function snapshotVariations(value: unknown): Map<string, Record<string, unknown>> {
  if (!Array.isArray(value)) return new Map();
  return new Map(value.flatMap((raw) => {
    const item = record(raw);
    const keys = Array.isArray(item.attributes) ? item.attributes.map(sizeKey).filter(Boolean) : [];
    return keys.length === 1 ? [[keys[0]!, item] as const] : [];
  }));
}

function variationComparison(plan: readonly JsonObject[], snapshot: unknown) {
  const planned = new Map(plan.flatMap((item) => {
    const key = sizeKey(item.size);
    return key === "" ? [] : [[key, item] as const];
  }));
  const actual = snapshotVariations(snapshot);
  const differences: Record<string, unknown>[] = [];
  const deactivated: string[] = [];
  const rows: Record<string, unknown>[] = [];
  for (const key of [...new Set([...planned.keys(), ...actual.keys()])].sort()) {
    const expected = planned.get(key) ?? null;
    const current = actual.get(key) ?? null;
    const state = (item: Record<string, unknown> | JsonObject | null) => item === null ? null : ({
      regularPrice: String(item.regular_price ?? ""), stockStatus: String(item.stock_status ?? ""),
      manageStock: item.manage_stock === true, stockQuantity: item.stock_quantity === null ? null : Number(item.stock_quantity),
    });
    if (expected === null && current?.stock_status === "outofstock" && current.manage_stock === true && Number(current.stock_quantity) === 0) {
      deactivated.push(key);
      rows.push({ size: key, status: "unchanged", expected: null, actual: state(current), alreadyDeactivated: true });
      continue;
    }
    const expectedState = state(expected);
    const actualState = state(current);
    const changed = different(expectedState, actualState);
    if (changed) differences.push({ size: key, expected: expectedState, actual: actualState });
    rows.push({
      size: key,
      status: expected === null ? "deactivate" : current === null ? "add" : changed ? "change" : "unchanged",
      expected: expectedState,
      actual: actualState,
    });
  }
  return { differences, deactivated, rows };
}

function payloadTaxonomies(value: unknown): Record<string, number[]> {
  return Object.fromEntries(Object.entries(record(value)).map(([taxonomy, spec]) => [taxonomy, Array.isArray(record(spec).term_ids) ? (record(spec).term_ids as unknown[]).map(Number).sort((a, b) => a - b) : []]));
}

function snapshotTaxonomies(value: unknown): Record<string, number[]> {
  return Object.fromEntries(Object.entries(record(value)).map(([taxonomy, terms]) => [taxonomy, Array.isArray(terms) ? terms.map((term) => Number(record(term).term_id)).filter((id) => Number.isSafeInteger(id) && id > 0).sort((a, b) => a - b) : []]));
}

export interface PreviewTerm {
  readonly termId: number;
  readonly name: string;
  readonly slug: string | null;
  readonly origins?: readonly {
    readonly relationCode: string;
    readonly sourceTypeCode: string;
    readonly sourceLabel: string;
  }[];
}

function snapshotTermMap(value: unknown): Map<string, PreviewTerm> {
  const result = new Map<string, PreviewTerm>();
  for (const [taxonomy, rawTerms] of Object.entries(record(value))) {
    if (!Array.isArray(rawTerms)) continue;
    for (const rawTerm of rawTerms) {
      const term = record(rawTerm);
      const termId = Number(term.term_id);
      if (!Number.isSafeInteger(termId) || termId <= 0) continue;
      result.set(`${taxonomy}:${termId}`, {
        termId,
        name: String(term.name ?? term.term_slug ?? `#${termId}`),
        slug: typeof term.slug === "string" ? term.slug : typeof term.term_slug === "string" ? term.term_slug : null,
      });
    }
  }
  return result;
}

function dictionaryTermMap(values: readonly TargetDictionaryValueRecord[]): Map<string, PreviewTerm> {
  return new Map(values.flatMap((value) => value.taxonomy === null ? [] : [[`${value.taxonomy}:${value.externalId}`, {
    termId: Number(value.externalId), name: value.name, slug: value.slug,
  }] as const]));
}

function termDetails(
  taxonomy: string,
  termId: number,
  snapshot: Map<string, PreviewTerm>,
  dictionary: Map<string, PreviewTerm>,
  origins: ReadonlyMap<string, PreviewTerm["origins"]>,
): PreviewTerm {
  const term = snapshot.get(`${taxonomy}:${termId}`) ?? dictionary.get(`${taxonomy}:${termId}`) ?? { termId, name: `Термин #${termId}`, slug: null };
  const termOrigins = origins.get(`${taxonomy}:${termId}`);
  return termOrigins === undefined ? term : { ...term, origins: termOrigins };
}

function taxonomyComparison(
  expected: Readonly<Record<string, readonly number[]>>,
  current: Readonly<Record<string, readonly number[]>>,
  snapshotTerms: Map<string, PreviewTerm>,
  dictionaryTerms: Map<string, PreviewTerm>,
  origins: ReadonlyMap<string, PreviewTerm["origins"]> = new Map(),
) {
  return [...new Set([...Object.keys(expected), ...Object.keys(current)])].sort().map((taxonomy) => {
    const managed = Object.hasOwn(expected, taxonomy);
    const beforeIds = current[taxonomy] ?? [];
    const afterIds = managed ? expected[taxonomy] ?? [] : beforeIds;
    const before = new Set(beforeIds);
    const after = new Set(afterIds);
    const terms = (ids: readonly number[]) => ids.map((id) => termDetails(taxonomy, id, snapshotTerms, dictionaryTerms, origins));
    return {
      taxonomy,
      managed,
      before: terms(beforeIds),
      after: terms(afterIds),
      added: terms(afterIds.filter((id) => !before.has(id))),
      removed: managed ? terms(beforeIds.filter((id) => !after.has(id))) : [],
      unchanged: terms(beforeIds.filter((id) => after.has(id))),
      changed: managed && different(beforeIds, afterIds),
    };
  });
}

const previewFields = ["title", "slug", "sku", "description_html", "short_description_html"] as const;
const managedFieldForPreview = {
  title: "title",
  slug: "slug",
  sku: "sku",
  description_html: "description",
  short_description_html: "short_description",
} as const;

function fieldComparison(expected: Record<string, unknown>, current: Record<string, unknown>, managedFields: ReadonlySet<string>) {
  return previewFields.map((field) => {
    const managed = managedFields.has(managedFieldForPreview[field]);
    const actual = current[field] ?? null;
    const expectedValue = managed ? expected[field] ?? null : actual;
    return {
      field,
      expected: expectedValue,
      actual,
      managed,
      changed: managed && different(expectedValue, actual),
    };
  });
}

const referenceLabels: Readonly<Record<string, string>> = {
  brand: "Бренд",
  model: "Модель",
  category: "Категория",
  tag: "Метка",
  color: "Цвет",
  material: "Материал",
  activity: "Вид спорта",
  shoe_height: "Высота обуви",
  season: "Сезон",
};

const maximumLegacyImagePerceptualDistance = 12;

function imageIdentity(value: unknown) {
  const image = record(value);
  const url = typeof image.url === "string" ? image.url.trim() : "";
  const sourceUrl = typeof image.source_url === "string" ? image.source_url.trim() : "";
  const originUrl = typeof image.origin_url === "string" ? image.origin_url.trim() : "";
  const filename = typeof image.filename === "string" ? image.filename.trim() : "";
  const importName = typeof image.import_name === "string" ? image.import_name.trim() : "";
  const contentHash = typeof image.content_hash === "string" ? image.content_hash.trim().toLowerCase() : "";
  const perceptualHash = typeof image.perceptual_hash === "string" ? image.perceptual_hash.trim().toLowerCase() : "";
  return {
    url,
    sourceUrl,
    originUrl,
    filename: filename || importName,
    contentHash,
    perceptualHash,
  };
}

function imagesMatch(expected: unknown, actual: unknown) {
  const left = imageIdentity(expected);
  const right = imageIdentity(actual);
  if (left.contentHash !== "" && right.contentHash !== "" && left.contentHash === right.contentHash) {
    return { matched: true, reason: "content_hash", perceptualDistance: null };
  }
  if (left.sourceUrl !== "" && right.originUrl !== "") {
    return {
      matched: left.sourceUrl === right.originUrl,
      reason: left.sourceUrl === right.originUrl ? "source_url" : null,
      perceptualDistance: null,
    };
  }
  const perceptualDistance = perceptualHashDistance(left.perceptualHash, right.perceptualHash);
  if (perceptualDistance !== null && perceptualDistance <= maximumLegacyImagePerceptualDistance) {
    return { matched: true, reason: "perceptual_hash", perceptualDistance };
  }
  const matched = JSON.stringify({ url: left.url, sourceUrl: left.sourceUrl, filename: left.filename })
    === JSON.stringify({ url: right.url, sourceUrl: right.sourceUrl, filename: right.filename });
  return { matched, reason: matched ? "identity" : null, perceptualDistance };
}

function imageDiff(expected: unknown, actual: unknown) {
  const expectedImages = Array.isArray(expected) ? expected : [];
  const actualImages = Array.isArray(actual) ? actual : [];
  const max = Math.max(expectedImages.length, actualImages.length);
  const differences: Record<string, unknown>[] = [];
  const rows: Record<string, unknown>[] = [];
  for (let index = 0; index < max; index++) {
    const expectedImage = expectedImages[index] ?? null;
    const actualImage = actualImages[index] ?? null;
    const comparison = imagesMatch(expectedImage, actualImage);
    const changed = !comparison.matched;
    if (changed) {
      differences.push({ position: index, expected: expectedImage, actual: actualImage });
    }
    rows.push({
      position: index,
      status: expectedImage === null ? "remove" : actualImage === null ? "add" : changed ? "change" : "unchanged",
      expected: expectedImage,
      actual: actualImage,
      matchReason: comparison.reason,
      perceptualDistance: comparison.perceptualDistance,
    });
  }
  return {
    expectedCount: expectedImages.length,
    actualCount: actualImages.length,
    changed: differences.length > 0,
    differences,
    rows,
  };
}

export class WordPressPreviewService {
  constructor(
    private readonly repositories: { readonly sources: SourceRepository; readonly sourceProducts: SourceProductRepository; readonly internalProducts: InternalProductRepository; readonly targets: TargetRepository; readonly contentTemplates: TargetContentTemplateRepository },
    private readonly exporters: TargetExporterRegistry,
    private readonly mappings: TargetReferenceMappingService,
    private readonly targetDictionaries?: TargetDictionaryRepository,
    private readonly snapshotReader?: Pick<WordPressProductSnapshotReader, "read">,
    private readonly exportControl?: ExportControlRepository,
  ) {}

  async preview(sourceProductId: EntityId, targetId: EntityId, templateOverrides: readonly TargetContentTemplateDTO[] = []) {
    const configurationRevision = this.exportControl === undefined
      ? null
      : await this.mappings.getTargetMappingRevision(targetId);
    const sourceProduct = await this.repositories.sourceProducts.getById(sourceProductId);
    if (sourceProduct === null) throw new EntityNotFoundError("Source product", sourceProductId);
    const source = await this.repositories.sources.getById(sourceProduct.sourceId);
    if (source === null) throw new EntityNotFoundError("Source", sourceProduct.sourceId);
    const target = await this.repositories.targets.getById(targetId);
    if (target === null) throw new EntityNotFoundError("Target", targetId);
    const exporter = this.exporters.get(target.exporterCode);
    if (!(exporter instanceof WordPressExporter)) throw new IntegrationContractError("Target does not use the WordPress exporter");
    const activeTemplates = await this.repositories.contentTemplates.listActive(target.id);
    const overriddenFields = new Set(templateOverrides.map((template) => template.field));
    const contentTemplates: readonly TargetContentTemplateDTO[] = [
      ...activeTemplates.filter((template) => !overriddenFields.has(template.field)).map((template) => ({
        id: template.id, field: template.field, revision: template.revision, templateSource: template.templateSource,
      })),
      ...templateOverrides,
    ];
    let snapshot = await this.repositories.targets.findProductSnapshot(target.id, sourceProduct.id);
    let lookupFound: boolean | null = null;
    let lookupMatchedBy: string | null = null;
    if (this.snapshotReader !== undefined && sourceProduct.externalId !== null) {
      const [remote] = await this.snapshotReader.read(source.code, [sourceProduct.externalId]);
      if (remote === undefined) throw new IntegrationContractError("WordPress snapshot lookup did not return the requested product");
      lookupFound = remote.found;
      if (remote.found) {
        if (remote.externalId === undefined || remote.matchedBy === undefined || remote.snapshot === undefined) {
          throw new IntegrationContractError("WordPress snapshot lookup returned an incomplete matched product");
        }
        lookupMatchedBy = remote.matchedBy;
        snapshot = await this.repositories.targets.saveProductSnapshot({
          targetId: target.id,
          sourceProductId: sourceProduct.id,
          externalId: remote.externalId,
          sourceExternalId: sourceProduct.externalId,
          payload: remote.snapshot,
          contentHash: hashStableJson(remote.snapshot),
          fetchedAt: new Date().toISOString(),
        });
      } else {
        snapshot = null;
      }
    }
    const current = record(snapshot?.payload.product);
    const targetSummary = { id: target.id, code: target.code, name: target.name, enabled: target.enabled };
    const currentSummary = { externalId: snapshot?.externalId ?? null, snapshotFetchedAt: snapshot?.fetchedAt ?? null, product: current };
    const internal = await this.repositories.internalProducts.findBySourceProductId(sourceProductId);
    if (internal === null) {
      return {
        target: targetSummary,
        externalId: snapshot?.externalId ?? null,
        willCreate: lookupFound === false || snapshot === null,
        matchedBy: lookupMatchedBy ?? (snapshot === null ? null : "saved_snapshot"),
        readiness: {
          ready: false,
          phase: "processing",
          blockers: [{ code: "processing_required", message: "Товар собран, но ещё не прошёл обработку." }],
        },
        current: currentSummary,
        proposed: null,
        comparison: null,
        payload: null,
        diff: null,
      };
    }
    const targetProduct = await this.repositories.targets.findTargetProduct(target.id, internal.id);
    const finish = async <Result>(result: Result): Promise<Result> => {
      if (this.exportControl !== undefined && configurationRevision !== null) {
        await this.exportControl.savePreflight(summarizeExportControlPreflight({
          target, source, sourceProduct, internal, configurationRevision, preview: result,
        }));
      }
      return result;
    };
    const sourceDto: SourceDTO = { id: source.id, code: source.code, config: source.config };
    const sourceProductDto: SourceProductDTO = {
      id: sourceProduct.id, sourceId: sourceProduct.sourceId, sourceKey: sourceProduct.sourceKey,
      ...(sourceProduct.externalId === null ? {} : { externalId: sourceProduct.externalId }),
      ...(sourceProduct.slug === null ? {} : { slug: sourceProduct.slug }),
      ...(sourceProduct.url === null ? {} : { url: sourceProduct.url }), metadata: sourceProduct.discoveryMetadata,
    };
    const targetDto: TargetDTO = { id: target.id, code: target.code, config: target.config };
    const context = {
      source: sourceDto, sourceProduct: sourceProductDto, target: targetDto, product: internal.data,
      references: {
        resolveReference: (input) => this.mappings.resolveTargetValue(target.id, input.referenceId, input.targetScope),
        resolveProjections: (inputs) => this.mappings.resolveTargetProjections(target.id, inputs),
        resolveAssignments: (product) => this.mappings.resolveTargetAssignments(target.id, product),
      },
      contentTemplates,
      ...(targetProduct?.externalId === null || targetProduct?.externalId === undefined ? {} : { existingExternalId: targetProduct.externalId }),
    } satisfies Parameters<WordPressExporter["previewPayload"]>[0];
    let draft;
    try {
      draft = await exporter.previewPayload(context);
    } catch (error) {
      if (!(error instanceof IntegrationContractError)) throw error;
      return finish({
        target: targetSummary,
        externalId: snapshot?.externalId ?? targetProduct?.externalId ?? null,
        willCreate: lookupFound === false || (snapshot === null && targetProduct === null),
        matchedBy: lookupMatchedBy ?? (snapshot === null ? null : "saved_snapshot"),
        readiness: {
          ready: false,
          phase: "payload",
          blockers: [{ code: "payload_contract", message: error.message }],
        },
        current: currentSummary,
        proposed: null,
        comparison: null,
        payload: null,
        diff: null,
      });
    }
    const payload = draft.payload;
    const product = record(payload.product);
    const variations = record(payload.variations);
    const expectedVariations = Array.isArray(variations.items) ? variations.items : [];
    const expectedTaxonomies = payloadTaxonomies(product.taxonomies);
    const actualTaxonomies = snapshotTaxonomies(current.taxonomies);
    const preflight = draft.missingRequiredReferences.length === 0 ? await exporter.preflightPayload(payload) : null;
    const variationResult = preflight === null
      ? { differences: [] as Record<string, unknown>[], deactivated: [] as string[], rows: [] as Record<string, unknown>[] }
      : variationComparison(preflight.variationPlan, current.variations);
    const imageResult = imageDiff(product.images, current.images);
    const termIds = [...new Set([
      ...Object.values(expectedTaxonomies).flat(),
      ...Object.values(actualTaxonomies).flat(),
      ...(preflight?.variationPlan ?? []).flatMap((item) => {
        const key = sizeKey(item.size);
        return key === "" ? [] : [key.split(":").at(-1)!];
      }),
    ].map(String))];
    const dictionaryValues = this.targetDictionaries === undefined
      ? []
      : await this.targetDictionaries.listValuesByExternalIds(target.id, termIds);
    const taxonomyOrigins = new Map<string, PreviewTerm["origins"]>();
    for (const origin of draft.taxonomyOrigins) {
      const key = `${origin.taxonomy}:${origin.termId}`;
      const existing = taxonomyOrigins.get(key) ?? [];
      if (!existing.some((item) => item.relationCode === origin.relationCode
        && item.sourceTypeCode === origin.sourceTypeCode && item.sourceLabel === origin.sourceLabel)) {
        taxonomyOrigins.set(key, [...existing, {
          relationCode: origin.relationCode,
          sourceTypeCode: origin.sourceTypeCode,
          sourceLabel: origin.sourceLabel,
        }]);
      }
    }
    const taxonomyRows = taxonomyComparison(
      expectedTaxonomies,
      actualTaxonomies,
      snapshotTermMap(current.taxonomies),
      dictionaryTermMap(dictionaryValues),
      taxonomyOrigins,
    );
    const effectiveCategory = taxonomyRows.find((row) => row.taxonomy === "product_cat");
    const effectiveTaxonomies = {
      ...record(product.taxonomies),
      ...(effectiveCategory === undefined ? {} : {
        product_cat: { mode: "replace", term_ids: effectiveCategory.after.map((term) => term.termId) },
      }),
    };
    const effectiveTitle = applyWordPressTitlePolicy(String(product.title ?? ""), effectiveTaxonomies, target.config);
    const draftProductContext = record(draft.contentContext.product);
    const effectiveContentContext = {
      ...draft.contentContext,
      product: { ...draftProductContext, effective_title: effectiveTitle },
    };
    const effectiveContent = renderWordPressContentFields(effectiveContentContext, contentTemplates);
    const effectiveProduct = {
      ...product,
      title: effectiveTitle,
      description_html: effectiveContent.descriptionHtml,
      ...(effectiveContent.shortDescriptionHtml === undefined ? {} : { short_description_html: effectiveContent.shortDescriptionHtml }),
    };
    const managedFields = new Set(Array.isArray(payload.managed_fields) ? payload.managed_fields.map(String) : []);
    const fieldRows = fieldComparison(effectiveProduct, current, managedFields);
    const fields = fieldRows.filter((row) => row.changed).map(({ field, expected, actual }) => ({ field, expected, actual }));
    const taxonomyDifferences = taxonomyRows.filter((row) => row.changed).map((row) => ({
      taxonomy: row.taxonomy,
      expected: row.after.map((term) => term.termId),
      actual: row.before.map((term) => term.termId),
    }));
    const ready = preflight !== null;
    return finish({
      target: targetSummary,
      externalId: preflight?.externalId ?? snapshot?.externalId ?? targetProduct?.externalId ?? null,
      willCreate: preflight?.willCreate ?? (lookupFound === false || (snapshot === null && targetProduct === null)),
      matchedBy: preflight?.matchedBy ?? lookupMatchedBy ?? (snapshot === null ? null : "saved_snapshot"),
      ...(preflight === null ? {} : { payloadHash: preflight.payloadHash }),
      readiness: {
        ready,
        phase: ready ? "ready" : "classification",
        blockers: draft.missingRequiredReferences.map((referenceType) => ({
          code: "required_reference_missing",
          referenceType,
          message: `Не заполнено обязательное поле WordPress «${referenceLabels[referenceType] ?? referenceType}».`,
        })),
      },
      current: currentSummary,
      proposed: {
        complete: ready,
        contentContext: effectiveContentContext,
        fields: Object.fromEntries(fieldRows.map((row) => [row.field, row.expected])),
        taxonomies: taxonomyRows.map((row) => ({ taxonomy: row.taxonomy, terms: row.after, managed: row.managed })),
        images: Array.isArray(product.images) ? product.images : [],
        variations: preflight?.variationPlan ?? expectedVariations,
        sourceVariationCount: expectedVariations.length,
        variationPricesReady: ready,
      },
      comparison: {
        fields: fieldRows,
        taxonomies: taxonomyRows,
        images: imageResult,
        variations: {
          available: ready,
          rows: variationResult.rows,
          expectedCount: ready ? preflight.variationPlan.length : expectedVariations.length,
          actualCount: Array.isArray(current.variations) ? current.variations.length : 0,
          differences: variationResult.differences,
          deactivated: variationResult.deactivated,
        },
      },
      payload: {
        fields: Object.fromEntries(previewFields.flatMap((field) => Object.hasOwn(product, field) ? [[field, product[field] ?? null]] : [])),
        managedFields: [...managedFields],
        taxonomies: product.taxonomies ?? {}, images: product.images ?? [], activeVariations: expectedVariations,
      },
      diff: {
        snapshotFetchedAt: snapshot?.fetchedAt ?? null,
        fields,
        taxonomyDifferences,
        images: imageResult,
        variationDifferences: variationResult.differences,
        deactivatedVariations: variationResult.deactivated,
      },
    });
  }
}
