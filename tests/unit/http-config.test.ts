import { describe, expect, it } from "vitest";
import { loadHttpConfig } from "../../src/config/index.js";

describe("HTTP config", () => {
  it("uses loopback and port 3000 by default", () => {
    expect(loadHttpConfig({})).toEqual({ host: "127.0.0.1", port: 3000 });
  });

  it("loads a custom host and port", () => {
    expect(loadHttpConfig({ PARSER_HTTP_HOST: "127.0.0.2", PARSER_HTTP_PORT: "4000" })).toEqual({ host: "127.0.0.2", port: 4000 });
  });

  it.each(["0", "65536", "1.5", "invalid"])("rejects invalid port %s", (port) => {
    expect(() => loadHttpConfig({ PARSER_HTTP_PORT: port })).toThrow("PARSER_HTTP_PORT");
  });
});
