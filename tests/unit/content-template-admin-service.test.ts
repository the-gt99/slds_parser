import { describe, expect, it, vi } from "vitest";

import { ContentTemplateAdminService } from "../../src/services/index.js";
import { createMemoryRepositories, MemoryStore, MemoryUnitOfWork, targetRecord } from "../support/in-memory.js";

function setup() {
  const store = new MemoryStore();
  store.targets.set("10", targetRecord());
  const repositories = createMemoryRepositories(store);
  const wordpressPreview = { preview: vi.fn().mockResolvedValue({ proposed: { fields: {} } }) };
  const service = new ContentTemplateAdminService(
    repositories.contentTemplates,
    repositories.targets,
    wordpressPreview as never,
    new MemoryUnitOfWork(store, repositories),
  );
  return { store, repositories, wordpressPreview, service };
}

describe("ContentTemplateAdminService", () => {
  it("stores immutable revisions and activates only the selected profile version", async () => {
    const value = setup();
    const first = await value.service.createDraft({ targetId: "10", field: "description", name: "Первый", templateSource: "<p>{{ product.effective_title }}</p>" }, "admin");
    const second = await value.service.createDraft({ targetId: "10", field: "description", name: "Второй", templateSource: "<h2>{{ product.effective_title }}</h2>" }, "admin");

    await value.service.activate("10", first.id, "admin");
    await value.service.activate("10", second.id, "admin");

    expect(await value.repositories.contentTemplates.getById(first.id)).toMatchObject({ status: "archived", revision: 1 });
    expect(await value.repositories.contentTemplates.getById(second.id)).toMatchObject({ status: "active", revision: 2 });
    expect(await value.repositories.contentTemplates.listActive("10")).toHaveLength(1);
    expect(value.store.transactionCount).toBe(4);
  });

  it("keeps different non-overlapping profiles active", async () => {
    const value = setup();
    const shoes = await value.service.createDraft({ targetId: "10", field: "description", name: "Обувь", templateSource: "<p>{{ content.story }}</p>",
      profileKey: "shoes", profileName: "Обувь", categoryTermIds: [74], requiredContextPaths: ["content.story"] }, "admin");
    const apparel = await value.service.createDraft({ targetId: "10", field: "description", name: "Одежда", templateSource: "<p>{{ content.description }}</p>",
      profileKey: "apparel", profileName: "Одежда", categoryTermIds: [91] }, "admin");

    await value.service.activate("10", shoes.id, "admin");
    await value.service.activate("10", apparel.id, "admin");

    expect(await value.repositories.contentTemplates.listActive("10")).toHaveLength(2);
  });

  it("blocks activation of overlapping category profiles", async () => {
    const value = setup();
    const first = await value.service.createDraft({ targetId: "10", field: "description", name: "Первый", templateSource: "<p>{{ content.story }}</p>",
      profileKey: "first", profileName: "Первый", categoryTermIds: [74] }, "admin");
    const second = await value.service.createDraft({ targetId: "10", field: "description", name: "Второй", templateSource: "<p>{{ content.story }}</p>",
      profileKey: "second", profileName: "Второй", categoryTermIds: [74, 75] }, "admin");
    await value.service.activate("10", first.id, "admin");

    await expect(value.service.activate("10", second.id, "admin")).rejects.toThrow("overlap");
  });

  it("validates a preview before calling WordPress", async () => {
    const value = setup();

    await expect(value.service.preview({
      targetId: "10",
      sourceProductId: "2",
      field: "description",
      name: "Ошибка",
      templateSource: "{{ unknown.value }}",
    })).rejects.toThrow("Unknown content template variable");
    expect(value.wordpressPreview.preview).not.toHaveBeenCalled();
  });
});
