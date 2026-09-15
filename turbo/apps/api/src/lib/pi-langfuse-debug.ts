import { createHash } from "node:crypto";

import {
  getAllFeatureStates,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { safeUrlParse } from "../signals/utils";
import { optionalEnv } from "./env";

const PI_LANGFUSE_DEBUG_ENABLED_ENV = "OKOU_PI_LANGFUSE_DEBUG_ENABLED";
const LANGFUSE_PUBLIC_KEY_ENV = "LANGFUSE_PUBLIC_KEY";
const LANGFUSE_SECRET_KEY_ENV = "LANGFUSE_SECRET_KEY";
const LANGFUSE_BASE_URL_ENV = "LANGFUSE_BASE_URL";
const LANGFUSE_PROJECT_ID_ENV = "LANGFUSE_PROJECT_ID";
const LANGFUSE_TRACING_ENVIRONMENT_ENV = "LANGFUSE_TRACING_ENVIRONMENT";
const LANGFUSE_TRACING_ENABLED_ENV = "LANGFUSE_TRACING_ENABLED";
const LANGFUSE_MEDIA_UPLOAD_ENABLED_ENV = "LANGFUSE_MEDIA_UPLOAD_ENABLED";
const LANGFUSE_USER_ID_ENV = "LANGFUSE_USER_ID";
const PI_LANGFUSE_MAX_CHARS_ENV = "PI_LANGFUSE_MAX_CHARS";
const DEFAULT_LANGFUSE_BASE_URL = "https://us.cloud.langfuse.com";
const DEFAULT_LANGFUSE_PROJECT_ID = "cmu0bvhcu012gad0drbw8ddts";
const DEBUG_TRACING_ENVIRONMENT = "internal-debug";
export const PI_LANGFUSE_MAX_CAPTURED_CHARS = 20_000;

interface PiLangfuseServerConfig {
  readonly publicKey: string;
  readonly secretKey: string;
  readonly baseUrl: string;
  readonly projectId: string;
}

function trimmedOptionalEnv(name: string): string | undefined {
  const value = optionalEnv(name)?.trim();
  return value || undefined;
}

function validLangfuseBaseUrl(value: string): string | undefined {
  const url = safeUrlParse(value);
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
    return undefined;
  }
  return url.toString().replace(/\/$/, "");
}

/** Read the isolated debug-project configuration without enabling any run. */
export function readPiLangfuseServerConfig():
  | PiLangfuseServerConfig
  | undefined {
  const publicKey = trimmedOptionalEnv(LANGFUSE_PUBLIC_KEY_ENV);
  const secretKey = trimmedOptionalEnv(LANGFUSE_SECRET_KEY_ENV);
  if (!publicKey || !secretKey) {
    return undefined;
  }

  const configuredBaseUrl = trimmedOptionalEnv(LANGFUSE_BASE_URL_ENV);
  const baseUrl = validLangfuseBaseUrl(
    configuredBaseUrl ?? DEFAULT_LANGFUSE_BASE_URL,
  );
  if (!baseUrl) {
    return undefined;
  }

  const projectId =
    trimmedOptionalEnv(LANGFUSE_PROJECT_ID_ENV) ?? DEFAULT_LANGFUSE_PROJECT_ID;
  return { publicKey, secretKey, baseUrl, projectId };
}

/** Resolve the immutable per-run decision from its captured feature context. */
export function resolvePiLangfuseDebugConfig(
  context: FeatureSwitchContext,
): PiLangfuseServerConfig | undefined {
  if (!getAllFeatureStates(context)[FeatureSwitchKey.LangfuseTrace]) {
    return undefined;
  }
  return readPiLangfuseServerConfig();
}

export function isPiLangfuseDebugRunEnvironment(
  environment: Readonly<Record<string, string>>,
): boolean {
  return environment[PI_LANGFUSE_DEBUG_ENABLED_ENV] === "true";
}

export function piLangfuseDebugUserId(userId: string): string {
  const digest = createHash("sha256")
    .update(`vm0:pi-langfuse-debug:${userId}`)
    .digest("hex");
  return `vm0-user-${digest}`;
}

export function piLangfuseDebugPlatformEnvironment(args: {
  readonly config: PiLangfuseServerConfig;
  readonly userId: string;
}): Readonly<Record<string, string>> {
  return {
    [PI_LANGFUSE_DEBUG_ENABLED_ENV]: "true",
    [LANGFUSE_TRACING_ENABLED_ENV]: "true",
    [LANGFUSE_BASE_URL_ENV]: args.config.baseUrl,
    [LANGFUSE_TRACING_ENVIRONMENT_ENV]: DEBUG_TRACING_ENVIRONMENT,
    [LANGFUSE_MEDIA_UPLOAD_ENABLED_ENV]: "false",
    [LANGFUSE_USER_ID_ENV]: piLangfuseDebugUserId(args.userId),
    [PI_LANGFUSE_MAX_CHARS_ENV]: String(PI_LANGFUSE_MAX_CAPTURED_CHARS),
  };
}

/** Keep injected credentials in the encrypted claim-time secret set. */
export function piLangfuseDebugSecretEnvironment(
  config: PiLangfuseServerConfig,
): Readonly<Record<string, string>> {
  return {
    [LANGFUSE_PUBLIC_KEY_ENV]: config.publicKey,
    [LANGFUSE_SECRET_KEY_ENV]: config.secretKey,
  };
}

/** Select only a complete Langfuse credential pair at a trusted boundary. */
export function piLangfuseDebugCredentialsFromEnvironment(
  environment: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> | undefined {
  const publicKey = environment[LANGFUSE_PUBLIC_KEY_ENV]?.trim();
  const secretKey = environment[LANGFUSE_SECRET_KEY_ENV]?.trim();
  if (!publicKey || !secretKey) {
    return undefined;
  }
  return {
    [LANGFUSE_PUBLIC_KEY_ENV]: publicKey,
    [LANGFUSE_SECRET_KEY_ENV]: secretKey,
  };
}

export function piLangfuseTracingEnvironment(): string {
  return DEBUG_TRACING_ENVIRONMENT;
}

/** Mask only the debug-project credentials; run content policy stays explicit. */
export function createPiLangfuseCredentialMask(
  config: PiLangfuseServerConfig,
): (data: unknown) => unknown {
  const secrets = [config.publicKey, config.secretKey].filter(Boolean);
  const redactString = (value: string): string => {
    return secrets.reduce((redacted, secret) => {
      return redacted.replaceAll(secret, "[redacted-langfuse-secret]");
    }, value);
  };

  const visit = (data: unknown, ancestors: readonly object[]): unknown => {
    if (typeof data === "string") {
      return redactString(data);
    }
    if (data === null || typeof data !== "object") {
      return data;
    }
    if (ancestors.includes(data)) {
      return "[circular-reference]";
    }
    const nextAncestors = [...ancestors, data];
    if (Array.isArray(data)) {
      return data.map((value) => {
        return visit(value, nextAncestors);
      });
    }
    return Object.fromEntries(
      Object.entries(data).map(([key, value]) => {
        return [key, visit(value, nextAncestors)];
      }),
    );
  };

  return (data: unknown): unknown => {
    return visit(data, []);
  };
}
