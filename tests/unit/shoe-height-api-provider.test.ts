import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import { IntegrationContractError } from "../../src/core/errors/index.js";
import { ShoeHeightApiProvider } from "../../src/infrastructure/vision/index.js";

async function png(): Promise<Buffer> {
  return await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } }).png().toBuffer();
}

describe("shoe height API provider", () => {
  it("sends a JPEG multipart file and validates the prediction", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ predicted_class: "low", confidence: 0.999, top1_index: 1 }), { status: 200 }));
    const provider = new ShoeHeightApiProvider({ apiUrl: "http://classifier.example/predict", timeoutMs: 1_000, attempts: 1, retryDelayMs: 0 }, request);

    await expect(provider.predict(await png())).resolves.toEqual({ predictedClass: "low", confidence: 0.999, top1Index: 1 });
    const body = request.mock.calls[0]?.[1]?.body as FormData;
    const file = body.get("file") as File;
    expect(file.type).toBe("image/jpeg");
    expect(file.name).toBe("shoe.jpg");
    expect(Buffer.from(await file.arrayBuffer()).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });

  it("rejects an unknown model class", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ predicted_class: "boot" }), { status: 200 }));
    const provider = new ShoeHeightApiProvider({ apiUrl: "http://classifier.example/predict", timeoutMs: 1_000, attempts: 1, retryDelayMs: 0 }, request);

    await expect(provider.predict(await png())).rejects.toBeInstanceOf(IntegrationContractError);
  });
});
