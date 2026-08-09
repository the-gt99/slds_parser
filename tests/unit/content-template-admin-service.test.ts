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
  it("stores immutable revisions and activates only the selected field version", async () => {
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
