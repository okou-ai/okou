import { randomUUID } from "node:crypto";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { createPiAgentSessionForRuntime } from "./session-runtime";

const MODEL = {
  provider: "openai" as const,
  baseUrl: "https://api.openai.com/v1",
  apiKey: "test-key",
  model: "gpt-5.6-terra",
  dialect: "openai-responses" as const,
  transport: "sse" as const,
};
const RESOURCE_SNAPSHOT = {
  schemaVersion: 1 as const,
  agentsFiles: [],
  skills: [],
};
const managedEnvironment = [
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "OKOU_PI_LANGFUSE_OTLP_ENDPOINT",
  "OKOU_PI_LANGFUSE_OTLP_TOKEN",
];
const originalEnvironment = Object.fromEntries(
  managedEnvironment.map((name) => {
    return [name, process.env[name]];
  }),
);

function restoreEnvironment(): void {
  for (const name of managedEnvironment) {
    const value = originalEnvironment[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

afterEach(() => {
  restoreEnvironment();
});

async function createSession(enableLangfuseObservability: boolean) {
  return await createPiAgentSessionForRuntime({
    cwd: "/home/user/workspace",
    agentDir: "/home/user/.pi/agent",
    sessionManager: SessionManager.inMemory("/home/user/workspace", {
      id: randomUUID(),
    }),
    model: MODEL,
    appendSystemPrompt: null,
    resourceSnapshot: RESOURCE_SNAPSHOT,
    enableLangfuseObservability,
  });
}

describe("Pi Langfuse extension gate", () => {
  it("does not load the plugin when the trusted runtime decision is false", async () => {
    process.env.OKOU_PI_LANGFUSE_OTLP_ENDPOINT = "https://api.okou.test/traces";
    process.env.OKOU_PI_LANGFUSE_OTLP_TOKEN = "disabled-run-token";
    const created = await createSession(false);
    try {
      expect(process.env.OKOU_PI_LANGFUSE_OTLP_TOKEN).toBe(
        "disabled-run-token",
      );
    } finally {
      created.session.dispose();
    }
  });

  it("rejects partial relay configuration even with ambient connector keys", async () => {
    process.env.OKOU_PI_LANGFUSE_OTLP_ENDPOINT = "https://api.okou.test/traces";
    delete process.env.OKOU_PI_LANGFUSE_OTLP_TOKEN;
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-user-project";
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-user-project";
    const created = await createSession(true);
    try {
      expect(process.env.LANGFUSE_PUBLIC_KEY).toBeUndefined();
      expect(process.env.LANGFUSE_SECRET_KEY).toBeUndefined();
      expect(process.env.OKOU_PI_LANGFUSE_OTLP_TOKEN).toBeUndefined();
      expect(process.env.OKOU_PI_LANGFUSE_OTLP_ENDPOINT).toBeUndefined();
    } finally {
      created.session.dispose();
    }
  });

  it("loads the relay plugin and removes captured authentication before tools run", async () => {
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    process.env.OKOU_PI_LANGFUSE_OTLP_ENDPOINT = "https://api.okou.test/traces";
    process.env.OKOU_PI_LANGFUSE_OTLP_TOKEN = "enabled-run-token";
    const created = await createSession(true);
    try {
      expect(process.env.LANGFUSE_PUBLIC_KEY).toBeUndefined();
      expect(process.env.LANGFUSE_SECRET_KEY).toBeUndefined();
      expect(process.env.OKOU_PI_LANGFUSE_OTLP_TOKEN).toBeUndefined();
      expect(process.env.OKOU_PI_LANGFUSE_OTLP_ENDPOINT).toBeUndefined();
    } finally {
      created.session.dispose();
    }
  });
});
