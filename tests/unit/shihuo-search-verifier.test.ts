import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { RetryableError } from "../../src/core/errors/index.js";
import { createShihuoSignedHeaders, PersistentShihuoSigner } from "../../src/shihuo/search-verifier.js";
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

  it("reuses one signer process and keeps concurrent profiles in request order", async () => {
    const child = fakeSigner();
    const spawn = vi.fn(() => child) as never;
    const signer = new PersistentShihuoSigner(config, spawn);
    const writes: string[] = [];
    child.stdin.on("data", (value: Buffer) => writes.push(value.toString("utf8")));

    const first = signer.sign(profile);
    const secondProfile = { ...profile, luid: "second" };
    const second = signer.sign(secondProfile);
    await new Promise((resolve) => setImmediate(resolve));

    expect(spawn).toHaveBeenCalledOnce();
    expect(JSON.parse(writes[0]!.trim())).toEqual({ id: "1", profile });
    expect(writes).toHaveLength(1);

    child.stdout.write(`${JSON.stringify({ id: "1", ok: true, headers: {
      "sh-sign": "first", "sh-ba": "ba", "sh-jt": "jt", timestamp: "1",
    } })}\n`);
    await expect(first).resolves.toMatchObject({ "sh-sign": "first" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(JSON.parse(writes[1]!.trim())).toEqual({ id: "2", profile: secondProfile });

    child.stdout.write(`${JSON.stringify({ id: "2", ok: true, headers: {
      "sh-sign": "second", "sh-ba": "ba", "sh-jt": "jt", timestamp: "2",
    } })}\n`);
    await expect(second).resolves.toMatchObject({ "sh-sign": "second", timestamp: "2" });
    signer.close();
  });
});
