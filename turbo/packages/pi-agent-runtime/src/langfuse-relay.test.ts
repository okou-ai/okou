import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

import {
  createAgentSessionRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { expect, it, onTestFinished, vi } from "vitest";

import { installLangfuseRuntimeEnvironment } from "./rpc";
import { createPiAgentSessionForRuntime } from "./session-runtime";

it("exports real Pi spans through the authenticated relay without connector credentials", async () => {
  const token = "private-run-relay-token";
  const parent = {
    traceId: "1".repeat(32),
    spanId: "2".repeat(16),
    traceFlags: 1 as const,
    sessionId: randomUUID(),
    sandboxWaitStartedAt: Date.now() - 1000,
  };
  vi.stubEnv("OKOU_PI_LANGFUSE_DEBUG_ENABLED", "true");
  vi.stubEnv("LANGFUSE_TRACING_ENABLED", "true");
  vi.stubEnv("LANGFUSE_PUBLIC_KEY", "user-dev-public-key");
  vi.stubEnv("LANGFUSE_SECRET_KEY", "user-dev-secret-key");
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const exports: { authorization: string | null; body: string }[] = [];
  const message = {
    type: "message",
    id: "msg_relay",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Sandbox answer", annotations: [] }],
  };
  const events = [
    {
      type: "response.created",
      response: {
        id: "resp_relay",
        object: "response",
        status: "in_progress",
        output: [],
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: "Sandbox answer",
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        id: "resp_relay",
        object: "response",
        status: "completed",
        output: [message],
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      },
    },
  ];
  const server = createServer((request, response) => {
    if (request.url === "/v1/responses") {
      request.resume();
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        events
          .map((event) => {
            return `data: ${JSON.stringify(event)}\n\n`;
          })
          .join(""),
      );
      return;
    }
    if (request.url !== "/traces") {
      request.resume();
      response.writeHead(404).end();
      return;
    }
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      exports.push({
        authorization: request.headers.authorization ?? null,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    })().catch((error: unknown) => {
      response.destroy(
        error instanceof Error ? error : new Error(String(error)),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  onTestFinished(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected TCP test address");
  const origin = `http://127.0.0.1:${address.port}`;
  const endpoint = `${origin}/traces`;
  const restore = installLangfuseRuntimeEnvironment(parent, "sandbox-first", {
    relay: { endpoint, token },
    userId: "anonymous-user",
    environment: "internal-debug",
  });
  onTestFinished(restore);
  const cwd = "/home/user/workspace";
  const agentDir = "/home/user/.pi/agent";
  const runtime = await createAgentSessionRuntime(
    async (target) => {
      const created = await createPiAgentSessionForRuntime({
        ...target,
        model: {
          provider: "openai",
          baseUrl: `${origin}/v1`,
          apiKey: "test-model-key",
          model: "gpt-5.6-terra",
          dialect: "openai-responses",
          transport: "sse",
        },
        appendSystemPrompt: null,
        resourceSnapshot: { schemaVersion: 1, agentsFiles: [], skills: [] },
        enableLangfuseObservability: true,
      });
      return { ...created, diagnostics: created.services.diagnostics };
    },
    {
      cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(cwd, { id: randomUUID() }),
    },
  );
  try {
    expect(process.env.OKOU_PI_LANGFUSE_OTLP_TOKEN).toBeUndefined();
    expect(process.env.LANGFUSE_SECRET_KEY).toBeUndefined();
    await runtime.session.prompt(`Check trace redaction: ${token}`);
    await runtime.session.prompt("Continue in the same sandbox");
  } finally {
    await runtime.dispose();
  }
  expect(exports.length).toBeGreaterThan(0);
  expect(
    exports.every((batch) => {
      return batch.authorization === `Bearer ${token}`;
    }),
  ).toBe(true);
  const payload = exports
    .map((batch) => {
      return batch.body;
    })
    .join("\n");
  expect(payload).toContain("LLM Call");
  expect(payload).toContain(parent.traceId);
  expect(payload).toContain(parent.spanId);
  expect(payload).toContain("Sandbox answer");
  expect(payload).not.toContain(token);
  expect(payload).not.toContain("user-dev-secret-key");

  const spans = exports.flatMap((batch) => {
    const exported = JSON.parse(batch.body) as {
      resourceSpans: {
        scopeSpans: {
          spans: {
            name: string;
            traceId: string;
            spanId: string;
            parentSpanId: string;
            startTimeUnixNano: string;
            endTimeUnixNano: string;
          }[];
        }[];
      }[];
    };
    return exported.resourceSpans.flatMap((resource) => {
      return resource.scopeSpans.flatMap((scope) => {
        return scope.spans;
      });
    });
  });
  const waits = spans.filter((span) => {
    return span.name === "Sandbox Wait";
  });
  const executions = spans.filter((span) => {
    return span.name === "Sandbox Execution";
  });
  const generations = spans.filter((span) => {
    return span.name.startsWith("LLM Call");
  });
  expect(waits).toHaveLength(1);
  expect(executions).toHaveLength(2);
  expect(generations).toHaveLength(2);
  expect(waits[0]?.parentSpanId).toBe(parent.spanId);
  expect(waits[0]?.startTimeUnixNano).toBe(
    String(BigInt(parent.sandboxWaitStartedAt) * 1_000_000n),
  );
  expect(waits[0]?.endTimeUnixNano).toBe(executions[0]?.startTimeUnixNano);
  for (const execution of executions) {
    expect(execution.parentSpanId).toBe(parent.spanId);
  }
  for (const generation of generations) {
    expect(
      executions.map((span) => {
        return span.spanId;
      }),
    ).toContain(generation.parentSpanId);
  }
});
