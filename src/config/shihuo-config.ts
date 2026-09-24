export interface ShihuoEnvironment {
  readonly SHIHUO_ONBOARDING_BASE_URL?: string;
  readonly SHIHUO_WIREGUARD_ENDPOINT?: string;
  readonly SHIHUO_WIREGUARD_SERVER_PUBLIC_KEY?: string;
  readonly SHIHUO_WIREGUARD_SUBNET?: string;
  readonly SHIHUO_WIREGUARD_DNS?: string;
  readonly SHIHUO_CA_CERT_PATH?: string;
  readonly SHIHUO_ONBOARDING_TTL_HOURS?: string;
  readonly SHIHUO_WG_COMMAND?: string;
  readonly SHIHUO_RECONCILE_SERVICE?: string;
  readonly SHIHUO_GATEWAY_TOKEN_HASH?: string;
  readonly SHIHUO_APP_IOS_URL?: string;
  readonly SHIHUO_APP_ANDROID_URL?: string;
}

export interface ShihuoConfig {
  readonly onboardingBaseUrl: string;
  readonly endpoint: string;
  readonly serverPublicKey: string;
  readonly subnet: string;
  readonly dns: string;
  readonly caCertificatePath: string;
  readonly onboardingTtlHours: number;
  readonly wgCommand: string;
  readonly reconcileService: string;
  readonly gatewayTokenHash: string;
  readonly iosAppUrl: string;
  readonly androidAppUrl: string;
}

export function loadShihuoConfig(environment: ShihuoEnvironment = process.env): ShihuoConfig | null {
  const baseUrl = environment.SHIHUO_ONBOARDING_BASE_URL?.trim() ?? "";
  if (baseUrl === "") return null;
  const url = new URL(baseUrl);
  if (url.protocol !== "https:") throw new Error("SHIHUO_ONBOARDING_BASE_URL must use HTTPS");
  const required = (name: keyof ShihuoEnvironment): string => {
    const value = environment[name]?.trim() ?? "";
    if (!value) throw new Error(`${name} is required when Shihuo onboarding is enabled`);
    return value;
  };
  const ttl = Number(environment.SHIHUO_ONBOARDING_TTL_HOURS?.trim() || "24");
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 168) throw new Error("SHIHUO_ONBOARDING_TTL_HOURS must be from 1 to 168");
  const gatewayTokenHash = required("SHIHUO_GATEWAY_TOKEN_HASH").toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(gatewayTokenHash)) throw new Error("SHIHUO_GATEWAY_TOKEN_HASH must be a SHA-256 hex digest");
  return {
    onboardingBaseUrl: url.toString().replace(/\/$/u, ""), endpoint: required("SHIHUO_WIREGUARD_ENDPOINT"),
    serverPublicKey: required("SHIHUO_WIREGUARD_SERVER_PUBLIC_KEY"), subnet: environment.SHIHUO_WIREGUARD_SUBNET?.trim() || "10.77.0.0/24",
    dns: environment.SHIHUO_WIREGUARD_DNS?.trim() || "1.1.1.1", caCertificatePath: required("SHIHUO_CA_CERT_PATH"),
    onboardingTtlHours: ttl, wgCommand: environment.SHIHUO_WG_COMMAND?.trim() || "wg",
    reconcileService: environment.SHIHUO_RECONCILE_SERVICE?.trim() || "",
    gatewayTokenHash,
    iosAppUrl: environment.SHIHUO_APP_IOS_URL?.trim() || "https://apps.apple.com/cn/app/id875177200",
    androidAppUrl: environment.SHIHUO_APP_ANDROID_URL?.trim() || "https://www.shihuo.cn/app/",
  };
}
