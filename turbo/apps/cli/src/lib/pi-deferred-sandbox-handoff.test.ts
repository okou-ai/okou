import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryPiSession,
  resumePiApiFirstTurn,
} from "@okouai/pi-agent-runtime/node";
import { piDeferredSandboxConfigSchema } from "@okouai/api-contracts/contracts/runners";
import { afterEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import { resolvePiApiFirstTurnHandoff } from "./pi-api-first-turn-handoff";

const directories: string[] = [];
const digest = (value: string) => {
  return createHash("sha256").update(value).digest("hex");
};
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((path) => {
      return rm(path, { recursive: true, force: true });
    }),
  );
});

async function fixture(settled = false) {
  vi.stubEnv("OKOU_TOKEN", "sandbox-fixture-token");
  vi.stubEnv("OKOU_API_BACKEND_URL", "https://durable-pi.test");
  const sessionId = randomUUID();
  const runId = randomUUID();
  const session = MemoryPiSession.create({
    cwd: "/home/user/workspace",
    id: sessionId,
  });
  session.appendMessage({
    role: "user",
    content: "x".repeat(6 * 1024 * 1024),
    timestamp: 1,
  });
  session.appendMessage({
    role: "assistant",
    content: settled
      ? [{ type: "text", text: "Completed in API" }]
      : [
          {
            type: "toolCall",
            id: "retained-tool-id",
            name: "read",
            arguments: { path: "README.md" },
          },
        ],
    api: "openai-completions",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: settled ? "stop" : "toolUse",
    timestamp: 2,
  });
  const sessionHistory = session.toJsonl();
  const resourceSnapshot = { schemaVersion: 1, agentsFiles: [], skills: [] };
  const wire = Buffer.from(
    JSON.stringify({ sessionHistory, resourceSnapshot }),
  );
  const config = piDeferredSandboxConfigSchema.parse({
    schemaVersion: 2,
    runId,
    activeInput: true,
    ownerEpoch: 7,
    generation: 3,
    deadlineAt: Date.now() + 60_000,
    historyHash: digest(sessionHistory),
    resourceSnapshotDigest: digest(JSON.stringify(resourceSnapshot)),
    baseSession: { sessionId, sha256: "b".repeat(64) },
    sandboxEventSequenceStart: 12,
    continuation: {
      mode: settled ? "settled-session" : "pending-tools",
      h1Hash: "c".repeat(64),
      manifestGeneration: 4,
      lastEventSequence: 11,
      ...(settled ? {} : { pendingToolIds: ["retained-tool-id"] }),
    },
  });
  let reads = 0;
  server.use(
    http.get(
      `https://durable-pi.test/api/runners/jobs/${runId}/pi-handoff/:offset`,
      ({ request, params }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer sandbox-fixture-token",
        );
        const offset = Number(params.offset);
        expect(offset).toBe(reads * 1024 * 1024);
        reads++;
        const end = Math.min(offset + 1024 * 1024, wire.length);
        return HttpResponse.json({
          chunk: wire.subarray(offset, end).toString("base64"),
          nextOffset: end === wire.length ? null : end,
        });
      },
    ),
  );
  const sessionDir = await mkdtemp(join(tmpdir(), "pi-durable-consumer-"));
  directories.push(sessionDir);
  return {
    config,
    sessionId,
    sessionDir,
    sessionHistory,
    resourceSnapshot,
    runtime: { fetch: globalThis.fetch, now: Date.now, sleep: async () => {} },
    reads: () => {
      return reads;
    },
  };
}

describe("deferred Pi CLI transport reader", () => {
  it.each([false, true])(
    "restores exact large H1 bytes through the authenticated continuation reader, settled=%s",
    async (settled) => {
      const f = await fixture(settled);
      const result = await resolvePiApiFirstTurnHandoff(f);
      expect(await readFile(result.sessionFile, "utf8")).toBe(f.sessionHistory);
      expect(f.reads()).toBeGreaterThan(6);
      expect(result.resourceSnapshot).toEqual(f.resourceSnapshot);
      expect(result.boundaryControl).toEqual({
        schemaVersion: 2,
        sandboxEventSequenceStart: 12,
        ownershipTransferMode: settled
          ? "settled-session-continuation"
          : "pending-tool-continuation",
      });
    },
  );

  it("rejects changed pending tool identity before RPC can start", async () => {
    const f = await fixture();
    const config = piDeferredSandboxConfigSchema.parse({
      ...f.config,
      continuation: {
        ...f.config.continuation,
        pendingToolIds: ["different-tool"],
      },
    });
    await expect(
      resolvePiApiFirstTurnHandoff({ ...f, config }),
    ).rejects.toThrow("pending tool identities mismatch");
  });

  it("rejects an expired owner before requesting any continuation bytes", async () => {
    const f = await fixture();
    await expect(
      resolvePiApiFirstTurnHandoff({
        ...f,
        config: { ...f.config, deadlineAt: 1 },
      }),
    ).rejects.toThrow("deadline expired");
    expect(f.reads()).toBe(0);
  });
  it("executes the restored pending tool once before the next actual provider HTTP request", async () => {
    const f = await fixture();
    const handoff = await resolvePiApiFirstTurnHandoff(f);
    await writeFile(join(f.sessionDir, "README.md"), "restored-tool-file");
    let requests = 0;
    server.use(
      http.post(
        "https://durable-provider.test/chat/completions",
        async ({ request }) => {
          requests++;
          expect(await request.json()).toMatchObject({
            messages: expect.arrayContaining([
              expect.objectContaining({
                role: "tool",
                tool_call_id: "retained-tool-id",
                content: "restored-tool-file",
              }),
            ]),
          });
          return new HttpResponse(
            `data: ${JSON.stringify({ id: "continuation", object: "chat.completion.chunk", created: 1, model: "deepseek-v4-flash", choices: [{ index: 0, delta: { role: "assistant", content: "Resumed" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
            { headers: { "Content-Type": "text/event-stream" } },
          );
        },
      ),
    );
    const runtime = await ModelRuntime.create({
      allowModelNetwork: false,
      modelsPath: null,
      refreshOnCreate: false,
    });
    runtime.registerProvider("deepseek", {
      api: "openai-completions",
      baseUrl: "https://durable-provider.test",
      apiKey: "synthetic-provider-key",
      models: [
        {
          id: "deepseek-v4-flash",
          name: "Durable consumer fixture",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8_000_000,
          maxTokens: 128,
        },
      ],
    });
    const model = runtime.getModel("deepseek", "deepseek-v4-flash");
    if (!model) {
      throw new Error("Missing test transport model");
    }
    const { session } = await createAgentSession({
      cwd: f.sessionDir,
      agentDir: join(f.sessionDir, "agent"),
      model,
      modelRuntime: runtime,
      sessionManager: SessionManager.open(handoff.sessionFile),
      tools: ["read"],
    });
    try {
      await resumePiApiFirstTurn(session);
      expect(requests).toBe(1);
      expect(
        session.messages.filter((message) => {
          return (
            message.role === "toolResult" &&
            message.toolCallId === "retained-tool-id"
          );
        }),
      ).toHaveLength(1);
      expect(session.messages.at(-1)).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "Resumed" }],
      });
    } finally {
      session.dispose();
    }
  });
});
