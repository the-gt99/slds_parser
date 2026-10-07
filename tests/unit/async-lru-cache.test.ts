import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { AsyncLruCache } from "../../src/core/utils/async-lru-cache.js";

describe("AsyncLruCache", () => {
  it("coalesces concurrent requests and evicts the least recently used result", async () => {
    const cache = new AsyncLruCache<string, string>(2);
    const load = vi.fn(async () => "a");
    await Promise.all([cache.getOrLoad("a", load), cache.getOrLoad("a", load)]);
    expect(load).toHaveBeenCalledOnce();
    await cache.getOrLoad("b", async () => "b");
    await cache.getOrLoad("a", load);
    await cache.getOrLoad("c", async () => "c");
    const reload = vi.fn(async () => "new-b");
    expect(await cache.getOrLoad("b", reload)).toBe("new-b");
    expect(cache.size).toBe(2);
    expect(load).toHaveBeenCalledOnce();
  });

  it("retries failures and prevents evicted requests from replacing newer results", async () => {
    const cache = new AsyncLruCache<string, string>(1);
    await expect(cache.getOrLoad("a", async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    expect(cache.size).toBe(0);
    let finish!: (value: string) => void;
    const old = cache.getOrLoad("a", () => new Promise<string>((resolve) => { finish = resolve; }));
    await cache.getOrLoad("b", async () => "b");
    await cache.getOrLoad("a", async () => "new-a");
    finish("old-a");
    await old;
    expect(await cache.getOrLoad("a", async () => "wrong")).toBe("new-a");
  });

  it("releases the async operation context after a cached request completes", () => {
    const output = execFileSync(process.execPath, ["--expose-gc", "--import", "tsx", "--input-type=module", "-e", `
      import { AsyncLocalStorage } from 'node:async_hooks';
      import { AsyncLruCache } from './src/core/utils/async-lru-cache.ts';
      const cache = new AsyncLruCache(2);
      const context = new AsyncLocalStorage();
      let weak;
      await (async () => {
        const state = { rules: new Array(100000).fill('rule') };
        weak = new WeakRef(state);
        await context.run(state, () => cache.getOrLoad('a', async () => 'result'));
      })();
      for (let i = 0; i < 5; i++) {
        await new Promise(resolve => setImmediate(resolve));
        global.gc();
      }
      if (weak.deref() !== undefined) throw new Error('Operation context is still retained');
      if (await cache.getOrLoad('a', async () => 'wrong') !== 'result') throw new Error('Result was lost');
      console.log('released');
    `], { encoding: "utf8" });
    expect(output.trim()).toBe("released");
  });
});
