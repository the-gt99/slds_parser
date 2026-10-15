import { describe, expect, it } from "vitest";
import { legacyImageBatches } from "../../src/infrastructure/media/legacy-image-batches.js";

async function* paths(count: number) { for (let index = 0; index < count; index++) yield String(index); }
async function batches(count: number, concurrency: number, maximumBytes: number, size: number) {
  const result: string[][] = [];
  for await (const batch of legacyImageBatches(paths(count), concurrency, maximumBytes, async () => size)) result.push(batch);
  return result;
}
describe("bounded legacy image batches", () => {
  it("limits file count and flushes the final partial batch", async () => {
    expect((await batches(197, 96, 1000, 1)).map((batch) => batch.length)).toEqual([96, 96, 5]);
  });
  it("limits bytes even with high configured concurrency", async () => {
    expect(await batches(5, 96, 10, 4)).toEqual([["0", "1"], ["2", "3"], ["4"]]);
  });
  it("rejects invalid limits and oversized files without yielding them", async () => {
    await expect(batches(1, 97, 10, 1)).rejects.toThrow("Invalid");
    await expect(batches(1, 6, 10, 11)).rejects.toThrow("retained");
    await expect(batches(1, 6, 10, -1)).rejects.toThrow("retained");
    await expect(batches(1, 6, 10, Number.NaN)).rejects.toThrow("retained");
  });
  it("does not enumerate another batch before the current one is consumed", async () => {
    let inspected = 0;
    const iterator = legacyImageBatches(paths(100), 24, 1000, async () => { inspected++; return 1; });
    expect((await iterator.next()).value).toHaveLength(24);
    expect(inspected).toBe(24);
    await iterator.return(undefined);
    expect(inspected).toBe(24);
  });
});
