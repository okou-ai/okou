import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readDesktopEnvironment } from "../scripts/desktop-environment.js";
import desktopIdentities from "./desktop-identities.json";
import { rewriteDesktopServiceHostname } from "./desktop-api-base-url";

const DESKTOP_RUNTIME_CONFIG_FILE = "desktop-runtime-config.json";

export type DesktopEnvironment = "production" | "staging" | "development";
type DesktopIdentityKind = "production" | "development";

export interface DesktopIdentity {
  readonly product: "okou";
  readonly brandName: "Okou";
  readonly displayName: string;
  readonly userDataDirectoryName: string;
  readonly updateLine: "ai-okou-desktop";
  readonly bundleId: string;
  readonly authProtocolName: string;
  readonly authScheme: string;
}

interface DesktopRuntimeConfig {
  readonly platformUrl: string;
  readonly product?: DesktopIdentity["product"];
  readonly clerkPublishableKey?: string;
}

export interface DesktopConfig {
  readonly platformUrl: URL;
  readonly webUrl: URL;
  readonly authUrl: URL;
  readonly environment: DesktopEnvironment;
  readonly identity: DesktopIdentity;
  readonly clerkPublishableKey: string | null;
  readonly sessionPartition: string;
  readonly authPartition: string;
  readonly allowedAppOrigins: ReadonlySet<string>;
}

function desktopProduct(value: string): DesktopIdentity["product"] {
  if (value === "okou") {
    return value;
  }
  throw new Error(`Unsupported desktop product: ${value}`);
}

function desktopBrandName(value: string): "Okou" {
  if (value === "Okou") {
    return value;
  }
  throw new Error(`Unsupported desktop brand: ${value}`);
}

function desktopUpdateLine(value: string): DesktopIdentity["updateLine"] {
  if (value === "ai-okou-desktop") {
    return value;
  }
  throw new Error(`Unsupported desktop update line: ${value}`);
}

function desktopIdentity(
  product: DesktopIdentity["product"],
  kind: DesktopIdentityKind,
): DesktopIdentity {
  const identity = desktopIdentities[product][kind];
  return {
    ...identity,
    product: desktopProduct(identity.product),
    brandName: desktopBrandName(identity.brandName),
    updateLine: desktopUpdateLine(identity.updateLine),
  };
}

function desktopRuntimeConfigPath(): string {
  return join(__dirname, "..", DESKTOP_RUNTIME_CONFIG_FILE);
}

function parseRuntimeConfig(value: unknown): DesktopRuntimeConfig {
  if (
    typeof value !== "object" ||
    value === null ||
    !("platformUrl" in value)
  ) {
    throw new Error(
      `${DESKTOP_RUNTIME_CONFIG_FILE} must contain a platformUrl string`,
    );
  }

  const config = value as {
    readonly platformUrl?: unknown;
    readonly product?: unknown;
    readonly clerkPublishableKey?: unknown;
  };
  if (typeof config.platformUrl !== "string") {
    throw new Error(
      `${DESKTOP_RUNTIME_CONFIG_FILE} must contain a platformUrl string`,
    );
  }
  if (config.product !== undefined && typeof config.product !== "string") {
    throw new Error(`${DESKTOP_RUNTIME_CONFIG_FILE} product must be okou`);
  }
  if (
    config.clerkPublishableKey !== undefined &&
    (typeof config.clerkPublishableKey !== "string" ||
      !/^pk_(test|live)_\S+$/.test(config.clerkPublishableKey))
  ) {
    throw new Error(
      `${DESKTOP_RUNTIME_CONFIG_FILE} clerkPublishableKey is invalid`,
    );
  }

  return {
    platformUrl: config.platformUrl,
    ...(config.product === undefined
      ? {}
      : { product: desktopProduct(config.product) }),
    ...(config.clerkPublishableKey === undefined
      ? {}
      : { clerkPublishableKey: config.clerkPublishableKey as string }),
  };
}

function readDesktopRuntimeConfig(): DesktopRuntimeConfig | undefined {
  const configPath = desktopRuntimeConfigPath();
  if (!existsSync(configPath)) {
    return undefined;
  }

  const configValue: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  return parseRuntimeConfig(configValue);
}

function configuredProduct(
  rawProduct: string | undefined,
  fileConfig: DesktopRuntimeConfig | undefined,
): DesktopIdentity["product"] {
  return desktopProduct(
    rawProduct?.trim() ||
      readDesktopEnvironment("OKOU_DESKTOP_PRODUCT") ||
      fileConfig?.product ||
      "okou",
  );
}

function configuredPlatformUrl(
  rawPlatformUrl: string | undefined,
  fileConfig: DesktopRuntimeConfig | undefined,
): string | undefined {
  if (rawPlatformUrl !== undefined) {
    return rawPlatformUrl;
  }
  return (
    readDesktopEnvironment("OKOU_DESKTOP_PLATFORM_URL") ||
    fileConfig?.platformUrl
  );
}

function parsePlatformUrl(
  rawUrl: string | undefined,
  product: DesktopIdentity["product"],
): URL {
  const value = rawUrl?.trim() || desktopIdentities[product].defaultPlatformUrl;
  const url = new URL(value);

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(
      `OKOU_DESKTOP_PLATFORM_URL must use http or https, received ${url.protocol}`,
    );
  }

  return url;
}

function environmentForPlatformUrl(
  platformUrl: URL,
  hasExplicitUrl: boolean,
): DesktopEnvironment {
  if (!hasExplicitUrl || platformUrl.hostname === "app.okou.ai") {
    return "production";
  }
  if (platformUrl.hostname === "staging-app.omby.ai") {
    return "staging";
  }
  return "development";
}

function identityForEnvironment(
  product: DesktopIdentity["product"],
  environment: DesktopEnvironment,
): DesktopIdentity {
  return desktopIdentity(
    product,
    environment === "production" ? "production" : "development",
  );
}

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

function addDerivedOrigin(
  origins: Set<string>,
  platformUrl: URL,
  target: "api" | "www",
): void {
  origins.add(deriveCompanionUrl(platformUrl, target).origin);
}

function allowedOriginsForPlatformUrl(platformUrl: URL): ReadonlySet<string> {
  const origins = new Set<string>([platformUrl.origin]);
  addDerivedOrigin(origins, platformUrl, "www");
  addDerivedOrigin(origins, platformUrl, "api");
  return origins;
}

function deriveCompanionUrl(platformUrl: URL, target: "api" | "www"): URL {
  const url = new URL(platformUrl.toString());
  if (isLocalHost(url.hostname)) {
    if (url.port === "3002") {
      url.port = target === "www" ? "3000" : "3001";
    }
  } else {
    url.hostname = rewriteDesktopServiceHostname(url.hostname, target);
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

export function resolveDesktopConfig(
  rawPlatformUrl?: string,
  rawProduct?: string,
): DesktopConfig {
  const fileConfig = readDesktopRuntimeConfig();
  const product = configuredProduct(rawProduct, fileConfig);
  const platformUrlSource = configuredPlatformUrl(rawPlatformUrl, fileConfig);
  const hasExplicitUrl = Boolean(platformUrlSource?.trim());
  const platformUrl = parsePlatformUrl(platformUrlSource, product);
  const environment = environmentForPlatformUrl(platformUrl, hasExplicitUrl);

  const sessionPartition = `persist:vm0-desktop-${environment}`;
  const authUrl = new URL(
    environment === "production"
      ? desktopIdentities.okou.defaultPlatformUrl
      : platformUrl.origin,
  );
  return {
    platformUrl,
    webUrl: deriveCompanionUrl(platformUrl, "www"),
    authUrl,
    environment,
    identity: identityForEnvironment(product, environment),
    clerkPublishableKey:
      process.env.OKOU_DESKTOP_CLERK_PUBLISHABLE_KEY?.trim() ||
      fileConfig?.clerkPublishableKey ||
      null,
    sessionPartition,
    // Keep Clerk and App credentials in their own store. Signing out can clear
    // it completely without touching native preferences, recordings or plugins.
    authPartition: `persist:okou-desktop-auth-${createHash("sha256").update(authUrl.origin).digest("hex")}`,
    allowedAppOrigins: allowedOriginsForPlatformUrl(platformUrl),
  };
}
