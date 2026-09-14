import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { installLangfuseRuntimeEnvironment } from "./rpc";

const PARENT = {
  traceId: "1".repeat(32),
  spanId: "2".repeat(16),
  traceFlags: 1,
  sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
} as const;

const MANAGED_ENVIRONMENT = [
  "OKOU_PI_LANGFUSE_DEBUG_ENABLED",
  "LANGFUSE_PI_PARENT_TRACE_ID",
  "LANGFUSE_PI_PARENT_SPAN_ID",
  "LANGFUSE_PI_PARENT_SESSION_ID",
  "LANGFUSE_PI_PARENT_DEPTH",
  "PI_LANGFUSE_CONTINUATION",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_BASE_URL",
  "LANGFUSE_USER_ID",
  "LANGFUSE_TRACING_ENVIRONMENT",
] as const;

function withRestoredEnvironment(exercise: () => void): void {
  const original = Object.fromEntries(
    MANAGED_ENVIRONMENT.map((name) => {
      return [name, process.env[name]];
    }),
  );
  try {
    exercise();
  } finally {
    for (const name of MANAGED_ENVIRONMENT) {
      const value = original[name];
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

function installSpoofedParent(): void {
  process.env.LANGFUSE_PI_PARENT_TRACE_ID = "a".repeat(32);
  process.env.LANGFUSE_PI_PARENT_SPAN_ID = "b".repeat(16);
  process.env.LANGFUSE_PI_PARENT_SESSION_ID =
    "ffffffff-ffff-4fff-8fff-ffffffffffff";
  process.env.LANGFUSE_PI_PARENT_DEPTH = "99";
  process.env.PI_LANGFUSE_CONTINUATION = "true";
}

describe("Pi Langfuse RPC environment boundary", () => {
  it("clears inherited parent state when the trusted run gate is off", () => {
    withRestoredEnvironment(() => {
      process.env.OKOU_PI_LANGFUSE_DEBUG_ENABLED = "false";
      installSpoofedParent();

      const restore = installLangfuseRuntimeEnvironment(
        PARENT,
        "pending-tool-continuation",
      );
      expect(process.env.LANGFUSE_PI_PARENT_TRACE_ID).toBeUndefined();
      expect(process.env.LANGFUSE_PI_PARENT_SPAN_ID).toBeUndefined();
      expect(process.env.LANGFUSE_PI_PARENT_SESSION_ID).toBeUndefined();
      expect(process.env.LANGFUSE_PI_PARENT_DEPTH).toBeUndefined();
      expect(process.env.PI_LANGFUSE_CONTINUATION).toBeUndefined();

      restore();
      expect(process.env.LANGFUSE_PI_PARENT_TRACE_ID).toBe("a".repeat(32));
      expect(process.env.PI_LANGFUSE_CONTINUATION).toBe("true");
    });
  });

  it("installs only the validated parent and pending-tool marker", () => {
    withRestoredEnvironment(() => {
      process.env.OKOU_PI_LANGFUSE_DEBUG_ENABLED = "true";
      installSpoofedParent();

      const restore = installLangfuseRuntimeEnvironment(
        PARENT,
        "pending-tool-continuation",
      );
      expect(process.env.LANGFUSE_PI_PARENT_TRACE_ID).toBe(PARENT.traceId);
      expect(process.env.LANGFUSE_PI_PARENT_SPAN_ID).toBe(PARENT.spanId);
      expect(process.env.LANGFUSE_PI_PARENT_SESSION_ID).toBe(PARENT.sessionId);
      expect(process.env.LANGFUSE_PI_PARENT_DEPTH).toBe("0");
      expect(process.env.PI_LANGFUSE_CONTINUATION).toBe("true");

      restore();
      expect(process.env.LANGFUSE_PI_PARENT_TRACE_ID).toBe("a".repeat(32));
    });
  });

  it("installs private credentials after exec without exposing them through procfs", () => {
    withRestoredEnvironment(() => {
      process.env.OKOU_PI_LANGFUSE_DEBUG_ENABLED = "true";
      const publicKey = "pk-lf-runtime-only-pr33756";
      const secretKey = "sk-lf-runtime-only-pr33756";
      const previousPublicKey = process.env.LANGFUSE_PUBLIC_KEY;
      const previousSecretKey = process.env.LANGFUSE_SECRET_KEY;

      const restore = installLangfuseRuntimeEnvironment(
        PARENT,
        "pending-tool-continuation",
        {
          publicKey,
          secretKey,
          baseUrl: "https://us.cloud.langfuse.com",
          userId: "anonymous-user",
          environment: "internal-debug",
        },
      );
      expect(process.env.LANGFUSE_PUBLIC_KEY).toBe(publicKey);
      expect(process.env.LANGFUSE_SECRET_KEY).toBe(secretKey);
      if (process.platform === "linux") {
        const initialEnvironment = readFileSync("/proc/self/environ", "utf8");
        expect(initialEnvironment).not.toContain(publicKey);
        expect(initialEnvironment).not.toContain(secretKey);
      }

      restore();
      expect(process.env.LANGFUSE_PUBLIC_KEY).toBe(previousPublicKey);
      expect(process.env.LANGFUSE_SECRET_KEY).toBe(previousSecretKey);
    });
  });

  it("does not inherit the pending-tool marker in settled continuation", () => {
    withRestoredEnvironment(() => {
      process.env.OKOU_PI_LANGFUSE_DEBUG_ENABLED = "true";
      installSpoofedParent();

      const restore = installLangfuseRuntimeEnvironment(
        PARENT,
        "settled-session-continuation",
      );
      expect(process.env.LANGFUSE_PI_PARENT_TRACE_ID).toBe(PARENT.traceId);
      expect(process.env.PI_LANGFUSE_CONTINUATION).toBeUndefined();
      restore();
    });
  });
});
