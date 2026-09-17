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

type ContinuationFixture = "pending" | "settled" | "untouched";

async function fixture(mode: ContinuationFixture = "pending") {
  vi.stubEnv("OKOU_TOKEN", "ordinary-agent-token");
  const sessionId = randomUUID();
  const runId = randomUUID();
  const session = MemoryPiSession.create({
    cwd: "/home/user/workspace",
    id: sessionId,
  });
  if (mode !== "untouched") {
    session.appendMessage({
      role: "user",
      content: "x".repeat(6 * 1024 * 1024),
      timestamp: 1,
    });
    session.appendMessage({
      role: "assistant",
      content:
        mode === "settled"
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
      stopReason: mode === "settled" ? "stop" : "toolUse",
      timestamp: 2,
    });
  }
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
    baseSession: {
      sessionId,
      sha256: mode === "untouched" ? null : "b".repeat(64),
    },
    sandboxEventSequenceStart: 12,
    continuation:
      mode === "untouched"
        ? { mode: "untouched-h0" }
        : {
            mode: mode === "settled" ? "settled-session" : "pending-tools",
            h1Hash: "c".repeat(64),
            manifestGeneration: 4,
            lastEventSequence: 11,
            ...(mode === "pending"
              ? { pendingToolIds: ["retained-tool-id"] }
              : {}),
          },
  });
  const sessionDir = await mkdtemp(join(tmpdir(), "pi-durable-consumer-"));
  directories.push(sessionDir);
  const deferredHandoffFile = join(sessionDir, "authenticated-handoff.json");
  await writeFile(deferredHandoffFile, wire, { mode: 0o600 });
  const fetch = vi.fn(() => {
    throw new Error("deferred CLI must not select or use an HTTP credential");
  }) as unknown as typeof globalThis.fetch;
  return {
    config,
    sessionId,
    sessionDir,
    deferredHandoffFile,
    sessionHistory,
    resourceSnapshot,
    runtime: { fetch, now: Date.now, sleep: async () => {} },
    fetch,
  };
}

describe("deferred Pi CLI transport reader", () => {
  it.each(["pending", "settled", "untouched"] as const)(
    "restores exact authenticated handoff bytes without selecting the ordinary agent token, mode=%s",
    async (mode) => {
      const f = await fixture(mode);
      const result = await resolvePiApiFirstTurnHandoff(f);
      expect(await readFile(result.sessionFile, "utf8")).toBe(f.sessionHistory);
      expect(f.fetch).not.toHaveBeenCalled();
      expect(result.resourceSnapshot).toEqual(f.resourceSnapshot);
      expect(result.boundaryControl).toEqual({
        schemaVersion: 2,
        sandboxEventSequenceStart: 12,
        ownershipTransferMode:
          mode === "pending"
            ? "pending-tool-continuation"
            : mode === "settled"
              ? "settled-session-continuation"
              : "sandbox-first",
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

  it("fails closed when the Guest did not provide authenticated handoff bytes", async () => {
    const f = await fixture();
    await expect(
      resolvePiApiFirstTurnHandoff({
        config: f.config,
        sessionDir: f.sessionDir,
        sessionId: f.sessionId,
        runtime: f.runtime,
      }),
    ).rejects.toThrow("requires its authenticated handoff file");
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("rejects an expired owner before requesting any continuation bytes", async () => {
    const f = await fixture();
    await expect(
      resolvePiApiFirstTurnHandoff({
        ...f,
        config: { ...f.config, deadlineAt: 1 },
      }),
    ).rejects.toThrow("integrity or deadline check");
    expect(f.fetch).not.toHaveBeenCalled();
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
