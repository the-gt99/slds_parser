import { describe, expect, it, vi } from "vitest";

import { GoatImageDownloader, type GoatHttpEnvironment } from "../../src/integrations/index.js";

const context = {
  source: { id: "1", code: "goat", config: {} },
  sourceProduct: { id: "2", sourceId: "1", sourceKey: "product", metadata: {} },
};

describe("GoatImageDownloader", () => {
  it("limits global image requests and isolates cookie jars from source collection", async () => {
    const environments: GoatHttpEnvironment[] = [];
    let active = 0;
    let maximumActive = 0;
    const releases: (() => void)[] = [];
    const factory = vi.fn((environment: GoatHttpEnvironment) => {
      environments.push(environment);
      return {
        getBuffer: vi.fn(async (url: string) => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise<void>((resolve) => releases.push(resolve));
          active -= 1;
          return Buffer.from(url);
        }),
      };
    });
    const downloader = new GoatImageDownloader(
      { GOAT_COOKIE_JAR_PATH: "/state/goat.cookies" },
      { concurrency: 2 },
      factory,
    );

    const downloads = ["one", "two", "three"].map((url) => downloader.download(url, context));
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.shift()!();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.shift()!();
    releases.shift()!();
    await Promise.all(downloads);

    expect(maximumActive).toBe(2);
    expect(environments.map((environment) => environment.GOAT_COOKIE_JAR_PATH).sort()).toEqual([
      "/state/goat.cookies.images-1",
      "/state/goat.cookies.images-2",
    ]);
  });
});
