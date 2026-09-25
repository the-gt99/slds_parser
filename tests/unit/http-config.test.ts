import { describe, expect, it } from "vitest";
import { loadAdminApiConfig, loadHttpConfig, loadMcpConfig, loadWordPressTargetConfig } from "../../src/config/index.js";

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

  it("requires a sufficiently long admin token", () => {
    expect(() => loadAdminApiConfig({})).toThrow("PARSER_ADMIN_TOKEN");
    expect(loadAdminApiConfig({
      PARSER_ADMIN_TOKEN: "a".repeat(32),
      PARSER_ADMIN_USERNAME: "admin",
      PARSER_ADMIN_PASSWORD: "password-long-enough",
      PARSER_SESSION_SECRET: "s".repeat(32),
    })).toEqual({
      token: "a".repeat(32),
      username: "admin",
      password: "password-long-enough",
      sessionSecret: "s".repeat(32),
    });
  });

  it("keeps MCP disabled without a dedicated token and validates configured tokens", () => {
    expect(loadMcpConfig({})).toBeNull();
    expect(() => loadMcpConfig({ PARSER_MCP_TOKEN: "short" })).toThrow("PARSER_MCP_TOKEN");
    expect(loadMcpConfig({ PARSER_MCP_TOKEN: "m".repeat(32) })).toEqual({ token: "m".repeat(32) });
  });

  it("keeps WordPress integration disabled unless its complete configuration is present", () => {
    expect(loadWordPressTargetConfig({})).toBeNull();
    expect(() => loadWordPressTargetConfig({ PARSER_WORDPRESS_BASE_URL: "https://shop.example" })).toThrow("configured together");
    expect(loadWordPressTargetConfig({
      PARSER_WORDPRESS_BASE_URL: "https://shop.example/",
      PARSER_WORDPRESS_AUTH_TOKEN: "token",
    })).toEqual({ baseUrl: "https://shop.example", authToken: "token", timeoutMs: 30000, jobTimeoutMs: 900000, pollIntervalMs: 2000 });
  });
});
