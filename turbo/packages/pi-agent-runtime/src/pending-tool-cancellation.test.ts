import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  fauxAssistantMessage,
  fauxToolCall,
  Type,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type InlineExtension,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";

import { runInIsolatedProcess } from "../../../scripts/run-isolated-test.mjs";
import { resumePiApiFirstTurn } from "./rpc";
import { MemoryPiSession } from "./session-memory";

const server = setupServer();
beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});
const ENDPOINT = "https://pending-tools.example/v1/responses";
const PARAMETERS = Type.Object({ path: Type.String() });
const SESSION_ID = "00000000-0000-4000-8000-000000000915";

function barrier<T = void>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function completedResponse(inputTokens = 5) {
  return HttpResponse.text(
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "response_fixture",
        object: "response",
        status: "completed",
        output: [
          {
            type: "message",
            id: "message_fixture",
            role: "assistant",
            status: "completed",
            content: [
              { type: "output_text", text: "complete", annotations: [] },
            ],
          },
        ],
        usage: {
          input_tokens: inputTokens,
          output_tokens: 2,
          total_tokens: inputTokens + 2,
        },
      },
    })}\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

async function fixture(args: {
  tool: ToolDefinition<typeof PARAMETERS>;
  count?: number;
  length?: boolean;
  resolved?: boolean;
  compactable?: boolean;
  preResponseCompaction?: boolean;
  extensionFactories?: InlineExtension[];
}) {
  const root = await mkdtemp(join(tmpdir(), "pi-pending-cancel-"));
  onTestFinished(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const file = join(root, "session.jsonl");
  const effect = join(root, "effect.txt");
  const memory = MemoryPiSession.create({ cwd: root, id: SESSION_ID });
  if (args.preResponseCompaction) {
    for (let index = 0; index < 3; index += 1) {
      memory.appendMessage({
        role: "user",
        content: `historical question ${index}`,
        timestamp: 0,
      });
      memory.appendMessage(
        fauxAssistantMessage("historical answer ".repeat(500), {
          timestamp: 0,
        }),
      );
    }
  }
  if (args.compactable) {
    memory.appendMessage({
      role: "user",
      content: "earlier synthetic question",
      timestamp: 0,
    });
    memory.appendMessage(
      fauxAssistantMessage("earlier synthetic answer ".repeat(25_000), {
        timestamp: 0,
      }),
    );
  }
  memory.appendMessage({
    role: "user",
    content: "original handoff",
    timestamp: 1,
  });
  memory.appendMessage(
    fauxAssistantMessage(
      Array.from({ length: args.count ?? 1 }, (_, index) => {
        return fauxToolCall(
          "controlled",
          { path: effect },
          { id: `call-${index}` },
        );
      }),
      {
        stopReason: args.length ? "length" : "toolUse",
        timestamp: 2,
        ...(args.preResponseCompaction
          ? {
              usage: {
                input: 7000,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 7001,
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0,
                },
              },
            }
          : {}),
      },
    ),
  );
  if (args.resolved)
    memory.appendMessage({
      role: "toolResult",
      toolCallId: "call-0",
      toolName: "controlled",
      content: [{ type: "text", text: "already resolved" }],
      isError: false,
      timestamp: 3,
    });
  await writeFile(file, memory.toJsonl());
  const model = {
    ...getBuiltinModel("openai", "gpt-5.6-terra"),
    baseUrl: "https://pending-tools.example/v1",
    ...(args.preResponseCompaction ? { contextWindow: 10000 } : {}),
  };
  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false,
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerProvider("openai", {
    name: "openai",
    api: "openai-responses",
    apiKey: "synthetic-key",
    baseUrl: model.baseUrl,
    models: [model],
  });
  const reopen = async () => {
    const settingsManager = SettingsManager.inMemory(
      args.preResponseCompaction
        ? {
            compaction: {
              enabled: true,
              reserveTokens: 2000,
              keepRecentTokens: 3000,
            },
          }
        : {},
      { projectTrusted: true },
    );
    const resourceLoader = new DefaultResourceLoader({
      cwd: root,
      agentDir: join(root, "agent"),
      settingsManager,
      extensionFactories: args.extensionFactories,
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: root,
      agentDir: join(root, "agent"),
      sessionManager: SessionManager.open(file),
      model,
      modelRuntime,
      settingsManager,
      resourceLoader,
      tools: ["controlled"],
      customTools: [args.tool],
    });
    onTestFinished(() => {
      session.dispose();
    });
    return session;
  };
  const session = await reopen();
  const events: string[] = [];
  session.subscribe((event) => {
    events.push(event.type);
  });
  return { session, file, effect, events, reopen, modelRuntime };
}

function tool(
  execute: ToolDefinition<typeof PARAMETERS>["execute"],
  executionMode: "sequential" | "parallel" = "parallel",
): ToolDefinition<typeof PARAMETERS> {
  return {
    name: "controlled",
    label: "controlled",
    description: "A cooperative fixture with a real file effect",
    parameters: PARAMETERS,
    executionMode,
    execute,
  };
}

function observeRequests(inputTokens = 5) {
  const bodies: string[] = [];
  server.use(
    http.post(ENDPOINT, async ({ request }) => {
      bodies.push(await request.text());
      return completedResponse(inputTokens);
    }),
  );
  return bodies;
}

describe("native pending-tool cancellation", () => {
  it.each(["sequential", "parallel"] as const)(
    "owns %s tools, duplicate abort, queued input, settlement and reopen",
    async (mode) => {
      if (await runInIsolatedProcess(import.meta.url)) return;
      const requests = observeRequests();
      const started = barrier();
      const aborted = barrier();
      const releaseTools = barrier();
      const ending = barrier();
      const releaseEnd = barrier();
      const signals: AbortSignal[] = [];
      const { session, file, effect, events, reopen } = await fixture({
        count: 2,
        tool: tool(async (_id, args, signal) => {
          if (!signal) throw new Error("Tool requires native ownership");
          signals.push(signal);
          signal.addEventListener(
            "abort",
            () => {
              aborted.release();
            },
            { once: true },
          );
          if (signals.length === (mode === "parallel" ? 2 : 1))
            started.release();
          await releaseTools.promise;
          signal.throwIfAborted();
          await writeFile(args.path, "side effect");
          return { content: [{ type: "text", text: "written" }], details: {} };
        }, mode),
      });
      let settledAbort = false;
      let settledAgent = false;
      const unsubscribe = session.agent.subscribe(async (event) => {
        if (event.type === "agent_end") {
          ending.release();
          await releaseEnd.promise;
        }
      });
      const run = resumePiApiFirstTurn(session, {
        preflightResult(success) {
          expect(success).toBe(true);
          expect(session.isStreaming).toBe(true);
          expect(session.agent.signal).toBeInstanceOf(AbortSignal);
        },
      });
      await started.promise;
      await expect(resumePiApiFirstTurn(session)).rejects.toThrow(
        "already processing",
      );
      await expect(
        session.prompt("concurrent unqueued prompt"),
      ).rejects.toThrow("already processing");
      await session.prompt("acknowledged steering", {
        streamingBehavior: "steer",
      });
      await session.followUp("acknowledged follow-up");
      const abort = session.abort().then(() => {
        settledAbort = true;
      });
      const duplicateAbort = session.abort();
      const idle = session.agent.waitForIdle().then(() => {
        settledAgent = true;
      });
      await aborted.promise;
      expect(settledAbort).toBe(false);
      expect(
        signals.every((signal) => {
          return signal === signals[0] && signal.aborted;
        }),
      ).toBe(true);
      releaseTools.release();
      await ending.promise;
      expect(settledAbort).toBe(false);
      expect(settledAgent).toBe(false);
      expect(session.isStreaming).toBe(true);
      releaseEnd.release();
      await Promise.all([run, abort, duplicateAbort, idle]);
      unsubscribe();
      expect(requests).toHaveLength(0);
      await expect(readFile(effect)).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        events.filter((event) => {
          return event === "agent_settled";
        }),
      ).toHaveLength(1);
      expect(
        session.messages
          .filter((message) => {
            return message.role === "assistant";
          })
          .at(-1),
      ).toMatchObject({
        role: "assistant",
        stopReason: "aborted",
      });
      expect(session.pendingMessageCount).toBe(0);
      const cancelledHistory =
        SessionManager.open(file).buildSessionContext().messages;
      for (const text of ["acknowledged steering", "acknowledged follow-up"]) {
        expect(
          cancelledHistory.filter((message) => {
            return (
              message.role === "user" &&
              JSON.stringify(message.content).includes(text)
            );
          }),
        ).toHaveLength(1);
      }
      expect(session.agent.signal).toBeUndefined();
      await expect(resumePiApiFirstTurn(session)).rejects.toThrow(
        "no pending tool calls",
      );
      const cancelledSession = await reopen();
      expect(cancelledSession.sessionId).toBe(SESSION_ID);
      await expect(resumePiApiFirstTurn(cancelledSession)).rejects.toThrow(
        "no pending tool calls",
      );
      const freshSignals: AbortSignal[] = [];
      session.agent.subscribe((event, signal) => {
        if (event.type === "agent_start") freshSignals.push(signal);
      });
      await session.prompt("fresh explicit prompt");
      expect(freshSignals[0]).not.toBe(signals[0]);
      expect(freshSignals[0]?.aborted).toBe(false);
      expect(session.pendingMessageCount).toBe(0);
      expect(signals).toHaveLength(mode === "parallel" ? 2 : 1);
      const persisted =
        SessionManager.open(file).buildSessionContext().messages;
      for (const text of [
        "original handoff",
        "acknowledged steering",
        "acknowledged follow-up",
        "fresh explicit prompt",
      ]) {
        expect(
          persisted.filter((message) => {
            return (
              message.role === "user" &&
              JSON.stringify(message.content).includes(text)
            );
          }),
        ).toHaveLength(1);
      }
      expect(
        persisted.filter((message) => {
          return (
            message.role === "toolResult" && message.toolCallId === "call-0"
          );
        }),
      ).toHaveLength(1);
      const reopenedSession = await reopen();
      await reopenedSession.prompt("continue reopened history");
      expect(signals).toHaveLength(mode === "parallel" ? 2 : 1);
    },
    150_000,
  );

  it.each(["prepare", "context", "convert", "auth", "payload"] as const)(
    "starts no HTTP after cancellation at the %s barrier",
    async (boundary) => {
      if (await runInIsolatedProcess(import.meta.url)) return;
      const requests = observeRequests();
      const entered = barrier();
      const release = barrier();
      const { session, effect, events } = await fixture({
        tool: tool(async (_id, args) => {
          await writeFile(args.path, "completed before cancellation");
          return { content: [{ type: "text", text: "done" }], details: {} };
        }),
      });
      const block = async () => {
        entered.release();
        await release.promise;
      };
      if (boundary === "prepare") {
        const previous = session.agent.prepareNextTurnWithContext;
        session.agent.prepareNextTurnWithContext = async (...args) => {
          const value = await previous?.(...args);
          await block();
          return value;
        };
      } else if (boundary === "context") {
        const previous = session.agent.transformContext;
        session.agent.transformContext = async (messages, signal) => {
          const value = await previous?.(messages, signal);
          await block();
          return value ?? messages;
        };
      } else if (boundary === "convert") {
        const previous = session.agent.convertToLlm;
        session.agent.convertToLlm = async (messages) => {
          const value = await previous(messages);
          await block();
          return value;
        };
      } else if (boundary === "auth") {
        const previous = session.agent.getApiKey;
        session.agent.getApiKey = async (provider) => {
          const value = await previous?.(provider);
          await block();
          return value;
        };
      } else {
        session.agent.onPayload = async () => {
          await block();
        };
      }
      const run = resumePiApiFirstTurn(session);
      await entered.promise;
      const abort = session.abort();
      release.release();
      await Promise.all([run, abort]);
      expect(requests).toHaveLength(0);
      expect(await readFile(effect, "utf8")).toBe(
        "completed before cancellation",
      );
      expect(session.messages.at(-1)).toMatchObject({ stopReason: "aborted" });
      expect(
        events.filter((event) => {
          return event === "agent_settled";
        }),
      ).toHaveLength(1);
    },
    150_000,
  );

  it("cancels in-flight HTTP and does not revive agent-end queued input", async () => {
    if (await runInIsolatedProcess(import.meta.url)) return;
    const requested = barrier();
    const cancelled = barrier();
    let requests = 0;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        requests += 1;
        request.signal.addEventListener(
          "abort",
          () => {
            cancelled.release();
          },
          { once: true },
        );
        requested.release();
        await cancelled.promise;
        return HttpResponse.json(
          { error: { message: "synthetic retryable failure" } },
          { status: 503 },
        );
      }),
    );
    const { session, events } = await fixture({
      tool: tool(async () => {
        return { content: [{ type: "text", text: "done" }], details: {} };
      }),
    });
    session.agent.subscribe(async (event) => {
      if (event.type === "agent_end")
        await session.steer("accepted during native end");
    });
    const run = resumePiApiFirstTurn(session);
    await requested.promise;
    await Promise.all([
      session.abort(),
      session.abort(),
      run,
      cancelled.promise,
    ]);
    expect(requests).toBe(1);
    expect(
      session.messages
        .filter((message) => {
          return message.role === "assistant";
        })
        .at(-1),
    ).toMatchObject({ stopReason: "aborted" });
    expect(session.getSteeringMessages()).toEqual([]);
    expect(
      session.messages.filter((message) => {
        return (
          message.role === "user" &&
          JSON.stringify(message.content).includes("accepted during native end")
        );
      }),
    ).toHaveLength(1);
    expect(events).not.toContain("auto_retry_start");
    expect(events).not.toContain("compaction_start");
    expect(
      events.filter((event) => {
        return event === "agent_settled";
      }),
    ).toHaveLength(1);
  }, 150_000);

  it("does not start prepared parallel calls when an asynchronous before hook is cancelled", async () => {
    if (await runInIsolatedProcess(import.meta.url)) return;
    const requests = observeRequests();
    const preparing = barrier();
    const release = barrier();
    let executions = 0;
    const { session } = await fixture({
      count: 2,
      tool: tool(async () => {
        executions += 1;
        return { content: [], details: {} };
      }),
    });
    session.agent.beforeToolCall = async ({ toolCall }, signal) => {
      expect(signal).toBe(session.agent.signal);
      if (toolCall.id === "call-1") {
        preparing.release();
        await release.promise;
      }
      return undefined;
    };
    const run = resumePiApiFirstTurn(session);
    await preparing.promise;
    const abort = session.abort();
    release.release();
    await Promise.all([run, abort]);
    expect(executions).toBe(0);
    expect(requests).toHaveLength(0);
    expect(session.messages.at(-1)).toMatchObject({ stopReason: "aborted" });
  }, 150_000);

  it.each([false, true])(
    "preserves unresolved ordering, hooks, metadata and truncated-argument refusal (length=%s)",
    async (length) => {
      if (await runInIsolatedProcess(import.meta.url)) return;
      const requests = observeRequests();
      const ordering: string[] = [];
      const definition = tool(async (id, args, signal, update) => {
        expect(signal?.aborted).toBe(false);
        ordering.push(`execute:${id}`);
        update?.({ content: [{ type: "text", text: "partial" }], details: {} });
        await writeFile(args.path, id);
        return {
          content: [{ type: "text", text: id }],
          details: { original: true },
        };
      }, "sequential");
      definition.prepareArguments = (args) => {
        ordering.push("prepare");
        if (
          typeof args !== "object" ||
          args === null ||
          !("path" in args) ||
          typeof args.path !== "string"
        )
          throw new Error("Expected a fixture path");
        return { path: args.path };
      };
      const { session, effect, file } = await fixture({
        tool: definition,
        count: 3,
        resolved: true,
        length,
      });
      session.agent.beforeToolCall = async ({ toolCall }, signal) => {
        expect(signal).toBe(session.agent.signal);
        ordering.push(`before:${toolCall.id}`);
        return undefined;
      };
      session.agent.afterToolCall = async ({ toolCall }, signal) => {
        expect(signal).toBe(session.agent.signal);
        ordering.push(`after:${toolCall.id}`);
        return { details: { hooked: true } };
      };
      const updates: string[] = [];
      const replay: string[] = [];
      session.subscribe((event) => {
        if (event.type === "tool_execution_update")
          updates.push(event.toolCallId);
        if (event.type === "message_start" && event.message.role === "user")
          replay.push("user");
        if (
          event.type === "message_start" &&
          event.message.role === "assistant" &&
          event.message.stopReason === "toolUse"
        )
          replay.push("assistant");
      });
      await resumePiApiFirstTurn(session);
      expect(requests).toHaveLength(1);
      expect(replay).toEqual([]);
      const results = SessionManager.open(file)
        .buildSessionContext()
        .messages.filter((message) => {
          return message.role === "toolResult";
        });
      expect(
        results.map((message) => {
          return message.toolCallId;
        }),
      ).toEqual(["call-0", "call-1", "call-2"]);
      if (length) {
        expect(ordering).toEqual([]);
        expect(results.slice(1)).toMatchObject([
          { isError: true },
          { isError: true },
        ]);
        await expect(readFile(effect)).rejects.toMatchObject({
          code: "ENOENT",
        });
      } else {
        expect(ordering).toEqual([
          "prepare",
          "before:call-1",
          "execute:call-1",
          "after:call-1",
          "prepare",
          "before:call-2",
          "execute:call-2",
          "after:call-2",
        ]);
        expect(updates).toEqual(["call-1", "call-2"]);
        // 0.86 removed `ToolResult.addedToolNames`; a tool loadout change is
        // now declared on the transcript's system message via `toolsAdded`.
        // No Okou code consumed that field. Hook metadata is the subject here.
        expect(results.slice(1)).toMatchObject([
          { details: { hooked: true } },
          { details: { hooked: true } },
        ]);
        expect(await readFile(effect, "utf8")).toBe("call-2");
      }
    },
    150_000,
  );
  it("keeps native cancellation through the retry scheduling boundary", async () => {
    if (await runInIsolatedProcess(import.meta.url)) return;
    let requests = 0;
    server.use(
      http.post(ENDPOINT, () => {
        requests += 1;
        return HttpResponse.json(
          { error: { message: "synthetic overload" } },
          { status: 503 },
        );
      }),
    );
    const { session, events } = await fixture({
      tool: tool(async () => {
        return { content: [], details: {} };
      }),
    });
    let abort: Promise<void> | undefined;
    let ownedSignal: AbortSignal | undefined;
    session.agent.subscribe((event, signal) => {
      if (event.type === "agent_start") ownedSignal = signal;
    });
    session.subscribe((event) => {
      if (event.type === "auto_retry_start") {
        expect(session.agent.signal).toBe(ownedSignal);
        abort = session.abort();
      }
    });
    await resumePiApiFirstTurn(session);
    expect(abort).toBeDefined();
    await abort;
    expect(requests).toBe(1);
    expect(events).not.toContain("compaction_start");
    expect(session.messages.at(-1)).toMatchObject({ stopReason: "aborted" });
    expect(
      events.filter((event) => {
        return event === "agent_settled";
      }),
    ).toHaveLength(1);
  }, 150_000);

  it("persists an end-handler queue without compaction or execution after cancellation", async () => {
    if (await runInIsolatedProcess(import.meta.url)) return;
    const requests = observeRequests(270_000);
    const { session, events } = await fixture({
      tool: tool(async () => {
        return { content: [], details: {} };
      }),
    });
    let abort: Promise<void> | undefined;
    session.agent.subscribe(async (event) => {
      if (event.type === "agent_end" && !abort) {
        await session.followUp("owned end-handler follow-up");
        abort = session.abort();
      }
    });
    await resumePiApiFirstTurn(session);
    await abort;
    expect(requests).toHaveLength(1);
    expect(session.getFollowUpMessages()).toEqual([]);
    expect(
      session.messages.filter((message) => {
        return (
          message.role === "user" &&
          JSON.stringify(message.content).includes(
            "owned end-handler follow-up",
          )
        );
      }),
    ).toHaveLength(1);
    expect(
      session.messages
        .filter((message) => {
          return message.role === "assistant";
        })
        .at(-1),
    ).toMatchObject({ stopReason: "aborted" });
    expect(events).not.toContain("compaction_start");
    expect(
      events.filter((event) => {
        return event === "agent_settled";
      }),
    ).toHaveLength(1);
  }, 150_000);

  it("joins started parallel tools even when an awaited event listener fails", async () => {
    if (await runInIsolatedProcess(import.meta.url)) return;
    const requests = observeRequests();
    const secondStarted = barrier();
    const releaseSecond = barrier();
    const listenerFailed = barrier();
    const { session, events } = await fixture({
      count: 2,
      tool: tool(async (id) => {
        if (id === "call-1") {
          secondStarted.release();
          await releaseSecond.promise;
        }
        return { content: [], details: {} };
      }),
    });
    session.agent.subscribe((event) => {
      if (
        event.type === "tool_execution_end" &&
        event.toolCallId === "call-0"
      ) {
        listenerFailed.release();
        throw new Error("synthetic persistence-listener failure");
      }
    });
    let finished = false;
    const run = resumePiApiFirstTurn(session).then(() => {
      finished = true;
    });
    await Promise.all([secondStarted.promise, listenerFailed.promise]);
    expect(finished).toBe(false);
    expect(session.isStreaming).toBe(true);
    releaseSecond.release();
    await run;
    expect(requests).toHaveLength(0);
    expect(session.messages.at(-1)).toMatchObject({ stopReason: "error" });
    expect(
      events.filter((event) => {
        return event === "agent_settled";
      }),
    ).toHaveLength(1);
  }, 150_000);
  it("cancels compaction scheduled after the provider turn with the original native owner", async () => {
    if (await runInIsolatedProcess(import.meta.url)) return;
    const requests = observeRequests(270_000);
    const { session, events } = await fixture({
      compactable: true,
      tool: tool(async () => {
        return { content: [], details: {} };
      }),
    });
    let originalSignal: AbortSignal | undefined;
    let abort: Promise<void> | undefined;
    let compactionAborted = false;
    session.agent.subscribe((event, signal) => {
      if (event.type === "agent_start") originalSignal = signal;
    });
    session.subscribe((event) => {
      if (event.type === "compaction_start") {
        expect(session.agent.signal).toBe(originalSignal);
        expect(session.isStreaming).toBe(true);
        abort = session.abort();
      }
      if (event.type === "compaction_end") compactionAborted = event.aborted;
    });
    await resumePiApiFirstTurn(session);
    expect(abort).toBeDefined();
    await abort;
    expect(compactionAborted).toBe(true);
    expect(requests).toHaveLength(1);
    expect(session.messages.at(-1)).toMatchObject({ stopReason: "aborted" });
    expect(
      events.filter((event) => {
        return event === "agent_settled";
      }),
    ).toHaveLength(1);
  }, 150_000);

  it("persists parallel results in call order when completion order differs", async () => {
    if (await runInIsolatedProcess(import.meta.url)) return;
    const requests = observeRequests();
    const secondEnded = barrier();
    const finished: string[] = [];
    const { session, file } = await fixture({
      count: 2,
      tool: tool(async (id, args) => {
        if (id === "call-0") await secondEnded.promise;
        await writeFile(`${args.path}-${id}`, id);
        return { content: [{ type: "text", text: id }], details: {} };
      }),
    });
    session.agent.subscribe((event) => {
      if (event.type === "tool_execution_end") {
        finished.push(event.toolCallId);
        if (event.toolCallId === "call-1") secondEnded.release();
      }
    });
    await resumePiApiFirstTurn(session);
    expect(finished).toEqual(["call-1", "call-0"]);
    expect(requests).toHaveLength(1);
    expect(
      SessionManager.open(file)
        .buildSessionContext()
        .messages.filter((message) => {
          return message.role === "toolResult";
        })
        .map((message) => {
          return message.toolCallId;
        }),
    ).toEqual(["call-0", "call-1"]);
  }, 150_000);

  it("joins partial-update callbacks before reporting their failure", async () => {
    if (await runInIsolatedProcess(import.meta.url)) return;
    const requests = observeRequests();
    const failed = barrier();
    const held = barrier();
    const release = barrier();
    const { session } = await fixture({
      tool: tool(async (_id, _args, _signal, update) => {
        update?.({ content: [{ type: "text", text: "first" }], details: {} });
        update?.({ content: [{ type: "text", text: "second" }], details: {} });
        return { content: [], details: {} };
      }),
    });
    session.agent.subscribe(async (event) => {
      if (event.type === "tool_execution_update") {
        if (
          event.partialResult.content[0]?.type === "text" &&
          event.partialResult.content[0].text === "first"
        ) {
          failed.release();
          throw new Error("synthetic update-listener failure");
        }
        held.release();
        await release.promise;
      }
    });
    let finished = false;
    const run = resumePiApiFirstTurn(session).then(() => {
      finished = true;
    });
    await Promise.all([failed.promise, held.promise]);
    expect(finished).toBe(false);
    expect(session.isStreaming).toBe(true);
    release.release();
    await run;
    expect(requests).toHaveLength(0);
    expect(session.messages.at(-1)).toMatchObject({ stopReason: "error" });
  }, 150_000);
  it("retains normal retry and late queued input within the same successful native owner", async () => {
    if (await runInIsolatedProcess(import.meta.url)) return;
    let requests = 0;
    server.use(
      http.post(ENDPOINT, () => {
        requests += 1;
        if (requests === 1)
          return HttpResponse.json(
            { error: { message: "synthetic overload" } },
            { status: 503 },
          );
        return completedResponse();
      }),
    );
    let executions = 0;
    const { session, events, file } = await fixture({
      tool: tool(async () => {
        executions += 1;
        return { content: [], details: {} };
      }),
    });
    const signals: AbortSignal[] = [];
    let queued = false;
    session.agent.subscribe(async (event, signal) => {
      if (event.type === "agent_start") signals.push(signal);
      if (event.type === "agent_end" && requests === 2 && !queued) {
        queued = true;
        await session.followUp("late acknowledged input");
      }
    });
    await resumePiApiFirstTurn(session);
    expect(requests).toBe(3);
    expect(executions).toBe(1);
    expect(signals).toHaveLength(3);
    expect(
      signals.every((signal) => {
        return signal === signals[0] && !signal.aborted;
      }),
    ).toBe(true);
    expect(
      events.filter((event) => {
        return event === "auto_retry_start";
      }),
    ).toHaveLength(1);
    expect(
      events.filter((event) => {
        return event === "agent_settled";
      }),
    ).toHaveLength(1);
    expect(session.messages.at(-1)).toMatchObject({ stopReason: "stop" });
    expect(
      SessionManager.open(file)
        .buildSessionContext()
        .messages.filter((message) => {
          return (
            message.role === "user" &&
            JSON.stringify(message.content).includes("late acknowledged input")
          );
        }),
    ).toHaveLength(1);
  }, 150_000);
  it.each([false, true])(
    "persists context-only custom messages across tool and settlement boundaries (cancel=%s)",
    async (cancel) => {
      if (await runInIsolatedProcess(import.meta.url)) return;
      const toolStarted = barrier();
      const finishTool = barrier();
      const settling = barrier();
      const finishSettlement = barrier();
      const requests = observeRequests();
      const executions: string[] = [];
      const { session, file, events } = await fixture({
        count: 2,
        resolved: true,
        extensionFactories: [
          (pi) => {
            pi.on("agent_settled", async () => {
              settling.release();
              await finishSettlement.promise;
              pi.sendMessage(
                {
                  customType: "settlement-note",
                  content: "accepted by the terminal extension",
                  display: false,
                },
                { triggerTurn: false },
              );
            });
          },
        ],
        tool: tool(async (id) => {
          executions.push(id);
          toolStarted.release();
          await finishTool.promise;
          return {
            content: [{ type: "text", text: "tool done" }],
            details: {},
          };
        }),
      });
      const customEvents: string[] = [];
      const customEntries = () => {
        return SessionManager.open(file)
          .getEntries()
          .filter((entry) => {
            return entry.type === "custom_message";
          })
          .map((entry) => {
            return entry.customType;
          });
      };
      const persistedAtSettlement: string[][] = [];
      session.subscribe((event) => {
        if (event.type === "message_end" && event.message.role === "custom")
          customEvents.push(event.message.customType);
        if (event.type === "agent_settled")
          persistedAtSettlement.push(customEntries());
      });
      const run = resumePiApiFirstTurn(session);
      await toolStarted.promise;
      await session.sendCustomMessage(
        {
          customType: "tool-note",
          content: "accepted while the tool is running",
          display: false,
        },
        { triggerTurn: false },
      );
      expect(customEntries()).toEqual([]);
      expect(customEvents).toEqual([]);
      finishTool.release();
      await settling.promise;
      expect(customEntries()).toEqual(["tool-note"]);
      const abort = cancel ? session.abort() : undefined;
      finishSettlement.release();
      await Promise.all([run, abort]);
      expect(executions).toEqual(["call-1"]);
      expect(requests).toHaveLength(1);
      expect(customEntries()).toEqual(["tool-note", "settlement-note"]);
      expect(customEvents).toEqual(["tool-note", "settlement-note"]);
      expect(persistedAtSettlement).toEqual([["tool-note", "settlement-note"]]);
      expect(
        session.messages
          .filter((message) => {
            return message.role === "custom";
          })
          .map((message) => {
            return message.customType;
          }),
      ).toEqual(["tool-note", "settlement-note"]);
      const entries = SessionManager.open(file).getEntries();
      const toolResult = entries.findIndex((entry) => {
        return (
          entry.type === "message" &&
          entry.message.role === "toolResult" &&
          entry.message.toolCallId === "call-1"
        );
      });
      expect(toolResult).toBeGreaterThan(-1);
      expect(
        entries.findIndex((entry) => {
          return entry.type === "custom_message";
        }),
      ).toBeGreaterThan(toolResult);
      expect(
        session.messages
          .filter((message) => {
            return message.role === "assistant";
          })
          .at(-1),
      ).toMatchObject({ stopReason: cancel ? "aborted" : "stop" });
      expect(
        events.filter((event) => {
          return event === "agent_settled";
        }),
      ).toHaveLength(1);
    },
    150_000,
  );

  it.each([false, true])(
    "compacts a large handoff tool result before responding and admits preparation steering once (already queued=%s)",
    async (alreadyQueued) => {
      if (await runInIsolatedProcess(import.meta.url)) return;
      const preparing = barrier();
      const release = barrier();
      const requests: string[] = [];
      const executions: string[] = [];
      const { session, file, events } = await fixture({
        preResponseCompaction: true,
        count: 2,
        resolved: true,
        extensionFactories: [
          (pi) => {
            pi.on("session_before_compact", async () => {
              preparing.release();
              await release.promise;
            });
          },
        ],
        tool: tool(async (id) => {
          executions.push(id);
          return {
            content: [{ type: "text", text: "large tool result ".repeat(500) }],
            details: { retained: true },
          };
        }),
      });
      let compacted = false;
      let summaryRequests = 0;
      server.use(
        http.post(ENDPOINT, async ({ request }) => {
          const body = await request.text();
          if (!compacted) {
            summaryRequests += 1;
          } else {
            requests.push(body);
          }
          return completedResponse();
        }),
      );
      session.subscribe((event) => {
        if (event.type === "compaction_end" && event.result) compacted = true;
      });
      const replay: string[] = [];
      session.agent.subscribe(async (event) => {
        if (
          event.type === "message_start" &&
          event.message.role === "user" &&
          event.message.content === "original handoff"
        )
          replay.push("user");
        if (
          event.type === "message_start" &&
          event.message.role === "assistant" &&
          event.message.timestamp === 2
        )
          replay.push("assistant");
        if (
          alreadyQueued &&
          event.type === "turn_end" &&
          event.message.timestamp === 2
        )
          await session.steer("steering before preparation");
      });
      const run = resumePiApiFirstTurn(session);
      await preparing.promise;
      expect(requests).toEqual([]);
      expect(summaryRequests).toBe(0);
      await session.steer("steering during preparation");
      release.release();
      await run;
      expect(compacted).toBe(true);
      expect(summaryRequests).toBeGreaterThan(0);
      expect(requests).toHaveLength(alreadyQueued ? 2 : 1);
      expect(requests[0]).toContain(
        alreadyQueued
          ? "steering before preparation"
          : "steering during preparation",
      );
      if (alreadyQueued) {
        expect(requests[0]).not.toContain("steering during preparation");
        expect(requests[1]).toContain("steering during preparation");
      }
      expect(executions).toEqual(["call-1"]);
      expect(replay).toEqual([]);
      expect(
        events.filter((event) => {
          return event === "agent_settled";
        }),
      ).toHaveLength(1);
      const reopened = SessionManager.open(file);
      const entries = reopened.getEntries();
      expect(
        entries.filter((entry) => {
          return entry.type === "compaction";
        }),
      ).toHaveLength(1);
      for (const text of [
        "original handoff",
        "steering during preparation",
        ...(alreadyQueued ? ["steering before preparation"] : []),
      ]) {
        expect(
          entries.filter((entry) => {
            return (
              entry.type === "message" &&
              entry.message.role === "user" &&
              JSON.stringify(entry.message.content).includes(text)
            );
          }),
        ).toHaveLength(1);
      }
      expect(
        entries
          .filter((entry) => {
            return (
              entry.type === "message" && entry.message.role === "toolResult"
            );
          })
          .map((entry) => {
            return entry.type === "message" &&
              entry.message.role === "toolResult"
              ? entry.message.toolCallId
              : null;
          }),
      ).toEqual(["call-0", "call-1"]);
      expect(reopened.buildSessionContext().messages.at(-1)).toMatchObject({
        role: "assistant",
        stopReason: "stop",
      });
    },
    150_000,
  );

  it.each(["auth", "extension", "http", "retry"] as const)(
    "cancels pre-response compaction at %s without losing polled or newly accepted input",
    async (boundary) => {
      if (await runInIsolatedProcess(import.meta.url)) return;
      const entered = barrier();
      const release = barrier();
      const requests: string[] = [];
      const failures: boolean[] = [];
      let executions = 0;
      const { session, file, events, modelRuntime } = await fixture({
        preResponseCompaction: true,
        extensionFactories: [
          (pi) => {
            pi.on("session_before_compact", async (event) => {
              if (boundary === "extension") {
                entered.release();
                await release.promise;
                expect(event.signal.aborted).toBe(true);
              }
            });
            pi.on("session_compact_failed", (event) => {
              failures.push(event.aborted);
            });
          },
        ],
        tool: tool(async () => {
          executions += 1;
          return {
            content: [{ type: "text", text: "large tool result ".repeat(500) }],
            details: {},
          };
        }),
      });
      if (boundary === "auth") {
        const getAuth = modelRuntime.getAuth.bind(modelRuntime);
        const spy = vi
          .spyOn(modelRuntime, "getAuth")
          .mockImplementation(async (model, overrides) => {
            const result =
              typeof model === "string"
                ? await getAuth(model, overrides)
                : await getAuth(model, overrides);
            entered.release();
            await release.promise;
            return result;
          });
        onTestFinished(() => {
          spy.mockRestore();
        });
      }
      server.use(
        http.post(ENDPOINT, async ({ request }) => {
          requests.push(await request.text());
          if (boundary === "http") {
            const aborted = barrier();
            request.signal.addEventListener(
              "abort",
              () => {
                aborted.release();
              },
              { once: true },
            );
            entered.release();
            await aborted.promise;
          }
          return HttpResponse.json(
            { error: { message: "synthetic summary overload" } },
            { status: 503 },
          );
        }),
      );
      let abort: Promise<void> | undefined;
      session.subscribe((event) => {
        if (
          boundary === "retry" &&
          event.type === "summarization_retry_scheduled"
        ) {
          abort = session.abort();
          entered.release();
        }
      });
      session.agent.subscribe(async (event) => {
        if (event.type === "turn_end" && event.message.timestamp === 2) {
          await session.steer("accepted before preparation");
        }
      });
      const run = resumePiApiFirstTurn(session);
      await entered.promise;
      await session.steer("accepted during preparation");
      await session.followUp("accepted follow-up during preparation");
      abort ??= session.abort();
      const duplicateAbort = session.abort();
      release.release();
      await Promise.all([run, abort, duplicateAbort]);
      expect(requests).toHaveLength(
        boundary === "http" || boundary === "retry" ? 1 : 0,
      );
      expect(executions).toBe(1);
      expect(
        events.filter((event) => {
          return event === "agent_settled";
        }),
      ).toHaveLength(1);
      expect(events).not.toContain("auto_retry_start");
      expect(session.pendingMessageCount).toBe(0);
      expect(session.agent.signal).toBeUndefined();
      const reopened = SessionManager.open(file);
      const entries = reopened.getEntries();
      expect(
        entries.filter((entry) => {
          return entry.type === "compaction";
        }),
      ).toEqual([]);
      for (const text of [
        "accepted before preparation",
        "accepted during preparation",
        "accepted follow-up during preparation",
      ]) {
        expect(
          entries.filter((entry) => {
            return (
              entry.type === "message" &&
              entry.message.role === "user" &&
              JSON.stringify(entry.message.content).includes(text)
            );
          }),
        ).toHaveLength(1);
      }
      expect(
        entries.filter((entry) => {
          return (
            entry.type === "message" &&
            entry.message.role === "assistant" &&
            entry.message.stopReason === "aborted"
          );
        }),
      ).toHaveLength(1);
      if (boundary !== "auth") expect(failures).toEqual([true]);
    },
    150_000,
  );
});
