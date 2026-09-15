import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { afterEach, describe, expect, it } from "vitest";

import { clearMockedEnv, mockOptionalEnv } from "./env";
import {
  createPiLangfuseCredentialMask,
  isPiLangfuseDebugRunEnvironment,
  piLangfuseDebugCredentialsFromEnvironment,
  piLangfuseDebugPlatformEnvironment,
  piLangfuseDebugUserId,
  resolvePiLangfuseDebugConfig,
} from "./pi-langfuse-debug";

const ORG_ID = "org_external";
const USER_ID = "user_pi_langfuse_debug";

function configureDebugProject(): void {
  mockOptionalEnv("LANGFUSE_PUBLIC_KEY", "pk-lf-debug");
  mockOptionalEnv("LANGFUSE_SECRET_KEY", "sk-lf-debug");
  mockOptionalEnv("LANGFUSE_BASE_URL", "https://langfuse.example/");
  mockOptionalEnv("LANGFUSE_PROJECT_ID", "  project-debug  ");
}

afterEach(() => {
  clearMockedEnv();
});

describe("Pi Langfuse debug configuration", () => {
  it("uses only the default-off per-user trace switch", () => {
    configureDebugProject();

    for (const context of [
      {
        userId: USER_ID,
        orgId: ORG_ID,
        overrides: { [FeatureSwitchKey.LangfuseTrace]: true },
      },
      {
        userId: "another-user",
        orgId: "another-external-org",
        overrides: { [FeatureSwitchKey.LangfuseTrace]: true },
      },
    ]) {
      expect(resolvePiLangfuseDebugConfig(context)).toStrictEqual({
        publicKey: "pk-lf-debug",
        secretKey: "sk-lf-debug",
        baseUrl: "https://langfuse.example",
        projectId: "project-debug",
      });
    }

    expect(
      resolvePiLangfuseDebugConfig({
        userId: USER_ID,
        orgId: ORG_ID,
      }),
    ).toBeUndefined();
    expect(
      resolvePiLangfuseDebugConfig({
        userId: USER_ID,
        orgId: ORG_ID,
        overrides: { [FeatureSwitchKey.LangfuseTrace]: false },
      }),
    ).toBeUndefined();
  });

  it("fails closed when project credentials or the base URL are invalid", () => {
    mockOptionalEnv("LANGFUSE_PUBLIC_KEY", "pk-lf-debug");
    mockOptionalEnv("LANGFUSE_SECRET_KEY", undefined);
    mockOptionalEnv("LANGFUSE_BASE_URL", undefined);
    mockOptionalEnv("LANGFUSE_PROJECT_ID", undefined);
    expect(
      resolvePiLangfuseDebugConfig({
        userId: USER_ID,
        orgId: ORG_ID,
        overrides: { [FeatureSwitchKey.LangfuseTrace]: true },
      }),
    ).toBeUndefined();

    mockOptionalEnv("LANGFUSE_SECRET_KEY", "sk-lf-debug");
    expect(
      resolvePiLangfuseDebugConfig({
        userId: USER_ID,
        orgId: ORG_ID,
        overrides: { [FeatureSwitchKey.LangfuseTrace]: true },
      }),
    ).toStrictEqual({
      publicKey: "pk-lf-debug",
      secretKey: "sk-lf-debug",
      baseUrl: "https://us.cloud.langfuse.com",
      projectId: "cmu0bvhcu012gad0drbw8ddts",
    });

    mockOptionalEnv("LANGFUSE_BASE_URL", "file:///tmp/not-allowed");
    expect(
      resolvePiLangfuseDebugConfig({
        userId: USER_ID,
        orgId: ORG_ID,
        overrides: { [FeatureSwitchKey.LangfuseTrace]: true },
      }),
    ).toBeUndefined();
  });

  it("builds a media-disabled relay overlay without platform credentials", () => {
    configureDebugProject();
    const config = resolvePiLangfuseDebugConfig({
      userId: USER_ID,
      orgId: ORG_ID,
      overrides: { [FeatureSwitchKey.LangfuseTrace]: true },
    });
    expect(config).toBeDefined();
    if (!config) {
      throw new Error("Expected the debug project configuration");
    }

    const platformEnvironment = piLangfuseDebugPlatformEnvironment({
      userId: USER_ID,
    });
    expect(platformEnvironment).toMatchObject({
      OKOU_PI_LANGFUSE_DEBUG_ENABLED: "true",
      OKOU_PI_LANGFUSE_RELAY_ENABLED: "true",
      LANGFUSE_TRACING_ENABLED: "true",
      LANGFUSE_MEDIA_UPLOAD_ENABLED: "false",
      LANGFUSE_TRACING_ENVIRONMENT: "internal-debug",
      LANGFUSE_USER_ID: piLangfuseDebugUserId(USER_ID),
      PI_LANGFUSE_MAX_CHARS: "20000",
    });
    expect(platformEnvironment).not.toHaveProperty("PI_LANGFUSE_CONTINUATION");
    expect(platformEnvironment).not.toHaveProperty("LANGFUSE_PUBLIC_KEY");
    expect(platformEnvironment).not.toHaveProperty("LANGFUSE_SECRET_KEY");
    expect(platformEnvironment).not.toHaveProperty("LANGFUSE_BASE_URL");
    expect(isPiLangfuseDebugRunEnvironment(platformEnvironment)).toBe(true);
    expect(isPiLangfuseDebugRunEnvironment({})).toBe(false);
    expect(platformEnvironment.LANGFUSE_USER_ID).not.toContain(USER_ID);
    const credentials = {
      LANGFUSE_PUBLIC_KEY: "pk-lf-debug",
      LANGFUSE_SECRET_KEY: "sk-lf-debug",
    };
    expect(
      piLangfuseDebugCredentialsFromEnvironment(credentials),
    ).toStrictEqual(credentials);
  });
});

describe("Pi Langfuse credential masking", () => {
  it("masks credentials recursively without looping on cycles", () => {
    configureDebugProject();
    const config = resolvePiLangfuseDebugConfig({
      userId: USER_ID,
      orgId: ORG_ID,
      overrides: { [FeatureSwitchKey.LangfuseTrace]: true },
    });
    if (!config) {
      throw new Error("Expected the debug project configuration");
    }
    const circular: { value: string; self?: unknown } = {
      value: "pk-lf-debug and sk-lf-debug",
    };
    circular.self = circular;

    expect(createPiLangfuseCredentialMask(config)(circular)).toStrictEqual({
      value: "[redacted-langfuse-secret] and [redacted-langfuse-secret]",
      self: "[circular-reference]",
    });
  });
});
