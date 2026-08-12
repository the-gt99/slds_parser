import { describe, expect, it, vi } from "vitest";

import { previewFrameDocument, replacePreviewFrame } from "../../public/content-template-preview.js";

describe("content template preview frames", () => {
  it("creates a new iframe for every render, including identical repeated previews", () => {
    const frames: Array<Record<string, unknown>> = [];
    const documentNode = {
      createElement: vi.fn(() => {
        const frame = { id: "", title: "", srcdoc: "", setAttribute: vi.fn(), replaceWith: vi.fn() };
        frames.push(frame);
        return frame;
      }),
    } as unknown as Document;
    const original = { id: "preview-before", title: "Текущее описание", replaceWith: vi.fn() } as unknown as HTMLIFrameElement;

    const first = replacePreviewFrame(documentNode, original, "<p>Описание</p>");
    const second = replacePreviewFrame(documentNode, first, "<p>Описание</p>");

    expect(first).not.toBe(second);
    expect(original.replaceWith).toHaveBeenCalledWith(first);
    expect(first.replaceWith).toHaveBeenCalledWith(second);
    expect(first.srcdoc).toBe(second.srcdoc);
    expect(first.setAttribute).toHaveBeenCalledWith("sandbox", "");
  });

  it("shows an explicit empty state inside an empty preview frame", () => {
    expect(previewFrameDocument("")).toContain("Поле пустое");
  });
});
