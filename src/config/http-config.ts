export interface HttpEnvironment {
  readonly PARSER_HTTP_HOST?: string;
  readonly PARSER_HTTP_PORT?: string;
  readonly PARSER_ADMIN_TOKEN?: string;
}

export interface HttpConfig {
  readonly host: string;
  readonly port: number;
}

export interface AdminApiConfig {
  readonly token: string;
}

export function loadHttpConfig(
  environment: HttpEnvironment = process.env,
): HttpConfig {
  const host = environment.PARSER_HTTP_HOST?.trim() || "127.0.0.1";
  const portValue = environment.PARSER_HTTP_PORT?.trim() || "3000";
  const port = Number(portValue);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PARSER_HTTP_PORT must be an integer from 1 to 65535");
  }

  return { host, port };
}

export function loadAdminApiConfig(
  environment: HttpEnvironment = process.env,
): AdminApiConfig {
  const token = environment.PARSER_ADMIN_TOKEN?.trim() ?? "";
  if (token.length < 32) {
    throw new Error("PARSER_ADMIN_TOKEN must contain at least 32 characters");
  }
  return { token };
}
