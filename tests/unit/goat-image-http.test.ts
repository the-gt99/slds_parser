import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoatHttpClient, parseGoatResponseHeaders } from "../../src/integrations/goat/goat-http-client.js";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));

const url = "https://image.goat.com/1000/test.png";
const environment = { GOAT_CLI_CURL_BIN: "curl-browser", GOAT_COOKIE_JAR_PATH: "test.cookies" };
let response = { status: 200, headers: 'Content-Type: image/png\r\nETag: "v1"', body: Buffer.from("image-bytes") };
const children: Array<EventEmitter & { killed: boolean; kill: ReturnType<typeof vi.fn> }> = [];

beforeEach(() => {
  spawn.mockReset(); children.length = 0;
  response = { status: 200, headers: 'Content-Type: image/png\r\nETag: "v1"', body: Buffer.from("image-bytes") };
  spawn.mockImplementation((_bin: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(),
      killed: false, exitCode: null as number | null, kill: vi.fn() });
    child.kill.mockImplementation(() => { child.killed = true; child.exitCode = -1;
      queueMicrotask(() => child.emit("close", -1)); return true; });
    children.push(child);
    queueMicrotask(() => {
      const marker = args[args.indexOf("--write-out") + 1]!.replace("%{http_code}", "");
      const warmup = args.at(-1) === "https://www.goat.com/";
      const status = warmup ? 200 : response.status;
      if (!warmup) {
        const headers = `HTTP/2 ${status} OK\r\n${response.headers}\r\n\r\n`;
        child.stdout.emit("data", Buffer.from(headers.slice(0, 9)));
        child.stdout.emit("data", Buffer.from(headers.slice(9)));
      }
      if (!child.killed) {
        child.stdout.emit("data", Buffer.concat([warmup ? Buffer.alloc(0) : response.body, Buffer.from(`${marker}${status}`)]));
        child.exitCode = 0; child.emit("close", 0);
      }
    });
    return child;
  });
});

describe("GOAT conditional image transport", () => {
  it("uses conditional GET, returns 304 without a body and prioritizes ETag", async () => {
    response = { status: 304, headers: 'ETag: "v1"', body: Buffer.alloc(0) };
    const result = await new GoatHttpClient(environment).getImage(url, { etag: '"v1"', lastModified: "Yesterday" }, true);
    expect(result).toEqual({ status: 304, headers: { etag: '"v1"' }, body: Buffer.alloc(0) });
    const args = spawn.mock.calls[1]![1] as string[];
    expect(args).toContain('If-None-Match: "v1"'); expect(args).toContain("Cache-Control: no-cache");
    expect(args).not.toContain("--head"); expect(args).not.toContain("If-Modified-Since: Yesterday");
    expect(children[1]?.kill).toHaveBeenCalledOnce();
  });

  it("stops after headers when bytes changed and downloads the full file only in the download request", async () => {
    const client = new GoatHttpClient(environment);
    expect((await client.getImage(url, { etag: '"old"' }, true)).body.length).toBe(0);
    expect(children[1]?.killed).toBe(true);
    const result = await client.getImage(url);
    expect(result.body).toEqual(response.body); expect(result.headers?.etag).toBe('"v1"');
    expect(children[2]?.killed).toBe(false);
  });

  it("handles validators without an ETag and does not treat 404 or HTML as an unchanged image", async () => {
    const client = new GoatHttpClient(environment);
    await client.getImage(url, { lastModified: "Yesterday" }, true);
    expect(spawn.mock.calls[1]![1]).toContain("If-Modified-Since: Yesterday");
    response.status = 404;
    await expect(client.getImage(url, { etag: '"v1"' }, true)).rejects.toMatchObject({ code: "GOAT_HTTP_PERMANENT" });
    response = { status: 200, headers: "Content-Type: text/html", body: Buffer.from("<html>challenge</html>") };
    await expect(client.getImage(url, {}, true)).rejects.toThrow("Content-Type");
  });

  it("rejects unrequested 304s and header injection before issuing a request", async () => {
    const client = new GoatHttpClient(environment);
    await expect(client.getImage(url, { etag: "x\r\nAuthorization: secret" }, true)).rejects.toThrow("validator");
    expect(spawn).not.toHaveBeenCalled();
    response.status = 304;
    await expect(client.getImage(url, {}, true)).rejects.toThrow("Unexpected");
  });

  it("parses redirects and informational blocks and keeps binary bytes outside headers", () => {
    const headers = 'HTTP/1.1 302 Redirect\r\nLocation: https://image.goat.com/new\r\n\r\n'
      + 'HTTP/2 103 Early Hints\r\nLink: x\r\n\r\nHTTP/2 200 OK\r\nETag: "new"\r\n\r\n';
    const data = Buffer.concat([Buffer.from(headers), Buffer.from([0, 255, 13, 10])]);
    expect(parseGoatResponseHeaders(data)).toEqual({ status: 200, headers: { etag: '"new"' }, bodyOffset: Buffer.byteLength(headers) });
    expect(parseGoatResponseHeaders(Buffer.from("HTTP/2 200"))).toBeNull();
  });
});
