import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { RetryableError } from "../../src/core/errors/index.js";
import { createShihuoSignedHeaders } from "../../src/shihuo/search-verifier.js";
import type { ShihuoGuestProfile } from "../../src/shihuo/types.js";

const profile: ShihuoGuestProfile = {
  platform: "android",
  "app-v": "1",
  sk: "sk",
  luid: "luid",
  osv: "14",
  "user-agent": "test",
};
const config = { python: "python", script: "signer.py", assetDirectory: "/assets" };

function fakeSigner() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
}

describe("createShihuoSignedHeaders", () => {
  it("classifies a signal interruption as retryable", async () => {
    const child = fakeSigner();
    const promise = createShihuoSignedHeaders(profile, config, (() => child) as never);

    child.emit("close", null, "SIGTERM");

    await expect(promise).rejects.toMatchObject({
      name: "RetryableError",
      code: "SHIHUO_SIGNER_INTERRUPTED",
    } satisfies Partial<RetryableError>);
  });

  it("classifies a signer timeout as retryable", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeSigner();
      const promise = createShihuoSignedHeaders(profile, config, (() => child) as never, 10);
      const expectation = expect(promise).rejects.toMatchObject({
        name: "RetryableError",
        code: "SHIHUO_SIGNER_TIMEOUT",
      } satisfies Partial<RetryableError>);

      await vi.advanceTimersByTimeAsync(10);

      await expectation;
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });
});
