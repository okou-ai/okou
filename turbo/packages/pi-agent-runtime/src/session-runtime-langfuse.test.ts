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
const originalPublicKey = process.env.LANGFUSE_PUBLIC_KEY;
const originalSecretKey = process.env.LANGFUSE_SECRET_KEY;

function restoreEnvironment(): void {
  if (originalPublicKey === undefined) {
    delete process.env.LANGFUSE_PUBLIC_KEY;
  } else {
    process.env.LANGFUSE_PUBLIC_KEY = originalPublicKey;
  }
  if (originalSecretKey === undefined) {
    delete process.env.LANGFUSE_SECRET_KEY;
  } else {
    process.env.LANGFUSE_SECRET_KEY = originalSecretKey;
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
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-disabled";
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-disabled";
    const created = await createSession(false);
    try {
      expect(process.env.LANGFUSE_PUBLIC_KEY).toBe("pk-lf-disabled");
      expect(process.env.LANGFUSE_SECRET_KEY).toBe("sk-lf-disabled");
    } finally {
      created.session.dispose();
    }
  });

  it("fails closed and removes partial credentials", async () => {
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-partial";
    delete process.env.LANGFUSE_SECRET_KEY;
    const created = await createSession(true);
    try {
      expect(process.env.LANGFUSE_PUBLIC_KEY).toBeUndefined();
      expect(process.env.LANGFUSE_SECRET_KEY).toBeUndefined();
    } finally {
      created.session.dispose();
    }
  });

  it("loads the plugin and removes captured credentials before tools run", async () => {
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-enabled";
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-enabled";
    const created = await createSession(true);
    try {
      expect(process.env.LANGFUSE_PUBLIC_KEY).toBeUndefined();
      expect(process.env.LANGFUSE_SECRET_KEY).toBeUndefined();
    } finally {
      created.session.dispose();
    }
  });
});
