import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { afterEach, describe, expect, it } from "vitest";

import { clearMockedEnv, mockOptionalEnv } from "./env";
import {
  createPiLangfuseCredentialMask,
  isPiLangfuseDebugRunEnvironment,
  piLangfuseDebugPlatformEnvironment,
  piLangfuseDebugSecretEnvironment,
  piLangfuseDebugUserId,
  resolvePiLangfuseDebugConfig,
} from "./pi-langfuse-debug";

const STAFF_ORG_ID = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";
const USER_ID = "user_pi_langfuse_debug";

function configureDebugProject(): void {
  mockOptionalEnv("LANGFUSE_PUBLIC_KEY", "pk-lf-debug");
  mockOptionalEnv("LANGFUSE_SECRET_KEY", "sk-lf-debug");
  mockOptionalEnv("LANGFUSE_BASE_URL", "https://langfuse.example/");
}

afterEach(() => {
  clearMockedEnv();
});

describe("Pi Langfuse debug configuration", () => {
  it("requires a staff user and per-user feature switch", () => {
    configureDebugProject();

    expect(
      resolvePiLangfuseDebugConfig({
        userId: USER_ID,
        orgId: STAFF_ORG_ID,
        overrides: { [FeatureSwitchKey.PiLangfuseDebug]: true },
      }),
    ).toStrictEqual({
      publicKey: "pk-lf-debug",
      secretKey: "sk-lf-debug",
      baseUrl: "https://langfuse.example",
    });

    expect(
      resolvePiLangfuseDebugConfig({
        userId: "another-user",
        orgId: STAFF_ORG_ID,
        overrides: { [FeatureSwitchKey.PiLangfuseDebug]: true },
      }),
    ).toStrictEqual({
      publicKey: "pk-lf-debug",
      secretKey: "sk-lf-debug",
      baseUrl: "https://langfuse.example",
    });
    expect(
      resolvePiLangfuseDebugConfig({
        userId: USER_ID,
        orgId: "org_external",
        overrides: { [FeatureSwitchKey.PiLangfuseDebug]: true },
      }),
    ).toBeUndefined();
    expect(
      resolvePiLangfuseDebugConfig({
        userId: USER_ID,
        orgId: STAFF_ORG_ID,
        overrides: { [FeatureSwitchKey.PiLangfuseDebug]: false },
      }),
    ).toBeUndefined();
  });

  it("fails closed when project credentials or the base URL are invalid", () => {
    mockOptionalEnv("LANGFUSE_PUBLIC_KEY", "pk-lf-debug");
    mockOptionalEnv("LANGFUSE_SECRET_KEY", undefined);
    mockOptionalEnv("LANGFUSE_BASE_URL", undefined);
    expect(
      resolvePiLangfuseDebugConfig({
        userId: USER_ID,
        orgId: STAFF_ORG_ID,
        overrides: { [FeatureSwitchKey.PiLangfuseDebug]: true },
      }),
    ).toBeUndefined();

    mockOptionalEnv("LANGFUSE_SECRET_KEY", "sk-lf-debug");
    expect(
      resolvePiLangfuseDebugConfig({
        userId: USER_ID,
        orgId: STAFF_ORG_ID,
        overrides: { [FeatureSwitchKey.PiLangfuseDebug]: true },
      }),
    ).toStrictEqual({
      publicKey: "pk-lf-debug",
      secretKey: "sk-lf-debug",
      baseUrl: "https://us.cloud.langfuse.com",
    });

    mockOptionalEnv("LANGFUSE_BASE_URL", "file:///tmp/not-allowed");
    expect(
      resolvePiLangfuseDebugConfig({
        userId: USER_ID,
        orgId: STAFF_ORG_ID,
        overrides: { [FeatureSwitchKey.PiLangfuseDebug]: true },
      }),
    ).toBeUndefined();
  });

  it("builds a media-disabled trusted overlay and tracks both credentials", () => {
    configureDebugProject();
    const config = resolvePiLangfuseDebugConfig({
      userId: USER_ID,
      orgId: STAFF_ORG_ID,
      overrides: { [FeatureSwitchKey.PiLangfuseDebug]: true },
    });
    expect(config).toBeDefined();
    if (!config) {
      throw new Error("Expected the debug project configuration");
    }

    const platformEnvironment = piLangfuseDebugPlatformEnvironment({
      config,
      userId: USER_ID,
    });
    expect(platformEnvironment).toMatchObject({
      OKOU_PI_LANGFUSE_DEBUG_ENABLED: "true",
      LANGFUSE_TRACING_ENABLED: "true",
      LANGFUSE_MEDIA_UPLOAD_ENABLED: "false",
      LANGFUSE_TRACING_ENVIRONMENT: "internal-debug",
      LANGFUSE_USER_ID: piLangfuseDebugUserId(USER_ID),
      PI_LANGFUSE_MAX_CHARS: "20000",
    });
    expect(platformEnvironment).not.toHaveProperty("PI_LANGFUSE_CONTINUATION");
    expect(isPiLangfuseDebugRunEnvironment(platformEnvironment)).toBe(true);
    expect(isPiLangfuseDebugRunEnvironment({})).toBe(false);
    expect(platformEnvironment.LANGFUSE_USER_ID).not.toContain(USER_ID);
    expect(piLangfuseDebugSecretEnvironment(config)).toStrictEqual({
      LANGFUSE_PUBLIC_KEY: "pk-lf-debug",
      LANGFUSE_SECRET_KEY: "sk-lf-debug",
    });
  });

  it("masks credentials recursively without looping on cycles", () => {
    configureDebugProject();
    const config = resolvePiLangfuseDebugConfig({
      userId: USER_ID,
      orgId: STAFF_ORG_ID,
      overrides: { [FeatureSwitchKey.PiLangfuseDebug]: true },
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
