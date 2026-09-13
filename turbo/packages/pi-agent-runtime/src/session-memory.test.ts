import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
  Type,
  type Context,
} from "@earendil-works/pi-ai";
import {
  convertToLlm,
  CURRENT_SESSION_VERSION,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { MemoryPiSession, runPiFirstModelTurn } from "./session-memory";
import { UnsupportedPiSessionVersionError } from "./errors";
import { PiApiModelRequestError } from "./api-failure";
import { createPiApiFirstTurnOwnership } from "./provider-ownership";

const SESSION_ID = "00000000-0000-4000-8000-000000000123";
const temporaryDirectories: string[] = [];

function promiseWithResolvers<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
} {
  return (
    Promise as PromiseConstructor & {
      withResolvers<TValue>(): {
        readonly promise: Promise<TValue>;
        readonly resolve: (value: TValue) => void;
        readonly reject: (reason?: unknown) => void;
      };
    }
  ).withResolvers<T>();
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-memory-session-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("MemoryPiSession", () => {
  it("commits the durable provider boundary before invoking transport", async () => {
    const memory = MemoryPiSession.create({
      cwd: "/home/user/workspace",
      id: SESSION_ID,
    });
    const faux = createFauxCore({
      api: "provider-boundary-test",
      provider: "provider-boundary-test",
    });
    const ownership = createPiApiFirstTurnOwnership();
    const boundaryEntered = promiseWithResolvers<void>();
    const releaseBoundary = promiseWithResolvers<void>();
    faux.setResponses([
      () => {
        expect(ownership.stage).toBe("provider-may-have-started");
        return fauxAssistantMessage("boundary committed");
      },
    ]);

    const turn = runPiFirstModelTurn({
      model: faux.getModel(),
      session: memory,
      stream: faux.streamSimple,
      systemPrompt: "system",
      prompt: "cross the durable provider boundary",
      tools: [],
      ownership,
      providerRequestBoundary: async (markProviderRequestMayHaveStarted) => {
        expect(ownership.stage).toBe("pre-provider");
        boundaryEntered.resolve();
        await releaseBoundary.promise;
        markProviderRequestMayHaveStarted();
      },
    });

    await boundaryEntered.promise;
    expect(faux.state.callCount).toBe(0);
    expect(ownership.stage).toBe("pre-provider");
    releaseBoundary.resolve();
    await expect(turn).resolves.toMatchObject({ handoffRequired: false });
    expect(faux.state.callCount).toBe(1);
    expect(ownership.stage).toBe("provider-may-have-started");
  });

  it("round-trips native Pi JSONL and appends one API model turn", async () => {
    const directory = await temporaryDirectory();
    const nativeSession = SessionManager.create(
      "/home/user/workspace",
      directory,
      {
        id: SESSION_ID,
      },
    );
    nativeSession.appendMessage({
      role: "user",
      content: "historical question",
      timestamp: 1,
    });
    nativeSession.appendMessage(
      fauxAssistantMessage("historical answer", { timestamp: 2 }),
    );
    const sessionFile = nativeSession.getSessionFile();
    if (!sessionFile) {
      throw new Error("Expected Pi to create a native session file");
    }
    const nativeJsonl = await readFile(sessionFile, "utf8");
    const memory = MemoryPiSession.fromJsonl(nativeJsonl);
    expect(memory.toJsonl()).toBe(nativeJsonl);

    let modelContext: Context | undefined;
    const faux = createFauxCore({
      api: "memory-test",
      provider: "memory-test",
    });
    const ownership = createPiApiFirstTurnOwnership();
    faux.setResponses([
      (context, options) => {
        expect(ownership.stage).toBe("provider-may-have-started");
        modelContext = context;
        expect(options?.sessionId).toBe(SESSION_ID);
        return fauxAssistantMessage(
          fauxToolCall("read", { path: "/workspace/AGENTS.md" }),
          { stopReason: "toolUse", timestamp: 4 },
        );
      },
    ]);
    const turn = await runPiFirstModelTurn({
      model: faux.getModel(),
      session: memory,
      stream: faux.streamSimple,
      systemPrompt: "preheated Pi system prompt",
      prompt: "continue from history",
      timestamp: 3,
      tools: [
        {
          name: "read",
          description: "Read a file",
          parameters: Type.Object({ path: Type.String() }),
        },
      ],
      ownership,
    });

    expect(turn.handoffRequired).toBe(true);
    expect(ownership.stage).toBe("provider-may-have-started");
    expect(faux.state.callCount).toBe(1);
    expect(modelContext?.systemPrompt).toBe("preheated Pi system prompt");
    expect(
      modelContext?.messages.map((message) => {
        return message.role;
      }),
    ).toStrictEqual(["user", "assistant", "user"]);
    expect(memory.toJsonl().startsWith(nativeJsonl)).toBe(true);
    expect(await readFile(sessionFile, "utf8")).toBe(nativeJsonl);
  });

  it("persists Pi's default thinking level before an API-first tool handoff", async () => {
    const memory = MemoryPiSession.create({
      cwd: "/home/user/workspace",
      id: SESSION_ID,
    });
    const faux = createFauxCore({
      api: "memory-reasoning-test",
      provider: "memory-reasoning-test",
      models: [
        {
          id: "reasoning-model",
          reasoning: true,
          input: ["text"],
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
          contextWindow: 128_000,
          maxTokens: 16_384,
        },
      ],
    });
    const model = {
      ...faux.getModel(),
      thinkingLevelMap: {
        minimal: null,
        low: null,
        medium: null,
        high: "high",
        max: "max",
      },
    };
    let requestedReasoning: string | undefined;
    const ownership = createPiApiFirstTurnOwnership();
    faux.setResponses([
      (_context, options) => {
        expect(ownership.stage).toBe("provider-may-have-started");
        requestedReasoning = options?.reasoning;
        return fauxAssistantMessage(
          fauxToolCall("read", { path: "/etc/os-release" }),
          { stopReason: "toolUse", timestamp: 2 },
        );
      },
    ]);

    await runPiFirstModelTurn({
      model,
      session: memory,
      stream: faux.streamSimple,
      systemPrompt: "system",
      prompt: "read the operating system release",
      timestamp: 1,
      tools: [
        {
          name: "read",
          description: "Read a file",
          parameters: Type.Object({ path: Type.String() }),
        },
      ],
      ownership,
    });

    expect(requestedReasoning).toBe("high");
    const entries = memory
      .toJsonl()
      .trim()
      .split("\n")
      .map((line) => {
        return JSON.parse(line) as {
          readonly type: string;
          readonly thinkingLevel?: string;
        };
      });
    expect(
      entries.map((entry) => {
        return entry.type;
      }),
    ).toStrictEqual([
      "session",
      "model_change",
      "thinking_level_change",
      "message",
      "message",
    ]);
    expect(entries[2]?.thinkingLevel).toBe("high");
    expect(
      MemoryPiSession.fromJsonl(memory.toJsonl()).buildSessionContext()
        .thinkingLevel,
    ).toBe("high");
  });

  it("applies each API run effort and preserves earlier thinking entries", async () => {
    const memory = MemoryPiSession.create({
      cwd: "/home/user/workspace",
      id: SESSION_ID,
    });
    const faux = createFauxCore({
      api: "memory-terra-reasoning-test",
      provider: "openai",
      models: [
        {
          id: "gpt-5.6-terra",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
          contextWindow: 272_000,
          maxTokens: 128_000,
        },
      ],
    });
    const requestedReasoning: Array<string | undefined> = [];
    faux.setResponses([
      (_context, options) => {
        requestedReasoning.push(options?.reasoning);
        return fauxAssistantMessage("first Terra answer", { timestamp: 2 });
      },
      (_context, options) => {
        requestedReasoning.push(options?.reasoning);
        return fauxAssistantMessage("second Terra answer", { timestamp: 4 });
      },
    ]);

    await runPiFirstModelTurn({
      model: faux.getModel(),
      session: memory,
      stream: faux.streamSimple,
      systemPrompt: "system",
      prompt: "first Terra prompt",
      thinkingLevel: "low",
      timestamp: 1,
      tools: [],
      ownership: createPiApiFirstTurnOwnership(),
    });
    await runPiFirstModelTurn({
      model: faux.getModel(),
      session: memory,
      stream: faux.streamSimple,
      systemPrompt: "system",
      prompt: "second Terra prompt",
      thinkingLevel: "high",
      timestamp: 3,
      tools: [],
      ownership: createPiApiFirstTurnOwnership(),
    });

    expect(requestedReasoning).toStrictEqual(["low", "high"]);
    const thinkingEntries = memory
      .toJsonl()
      .trim()
      .split("\n")
      .map((line) => {
        return JSON.parse(line) as {
          type: string;
          thinkingLevel?: string;
        };
      })
      .filter((entry) => {
        return entry.type === "thinking_level_change";
      });
    expect(thinkingEntries).toStrictEqual([
      expect.objectContaining({ thinkingLevel: "low" }),
      expect.objectContaining({ thinkingLevel: "high" }),
    ]);
  });

  it("keeps an explicit thinking entry authoritative before the first message", () => {
    const memory = MemoryPiSession.create({
      cwd: "/home/user/workspace",
      id: SESSION_ID,
    });
    const faux = createFauxCore({
      api: "memory-existing-reasoning-test",
      provider: "openai",
      models: [
        {
          id: "gpt-5.6-terra",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
          contextWindow: 272_000,
          maxTokens: 128_000,
        },
      ],
    });

    memory.prepareModelTurn(faux.getModel(), "high");
    memory.prepareModelTurn(faux.getModel());

    expect(memory.buildSessionContext().thinkingLevel).toBe("high");
    expect(
      memory
        .toJsonl()
        .trim()
        .split("\n")
        .map((line) => {
          return JSON.parse(line) as { type: string };
        })
        .filter((entry) => {
          return entry.type === "thinking_level_change";
        }),
    ).toHaveLength(1);
  });

  it("moves ownership before a synchronous provider transport failure", async () => {
    const memory = MemoryPiSession.create({
      cwd: "/home/user/workspace",
      id: SESSION_ID,
    });
    const faux = createFauxCore({
      api: "memory-failure-test",
      provider: "memory-failure-test",
    });
    const ownership = createPiApiFirstTurnOwnership();

    await expect(
      runPiFirstModelTurn({
        model: faux.getModel(),
        session: memory,
        stream: () => {
          expect(ownership.stage).toBe("provider-may-have-started");
          throw new Error("provider transport failed");
        },
        systemPrompt: "system",
        prompt: "must not be replayed",
        tools: [],
        ownership,
      }),
    ).rejects.toMatchObject({
      name: "PiApiModelRequestError",
      message: "Pi API model request failed",
      diagnostic: { category: "unknown" },
    });
    expect(ownership.stage).toBe("provider-may-have-started");
  });

  it("does not turn a durable ownership failure into a model request failure", async () => {
    const memory = MemoryPiSession.create({
      cwd: "/workspace",
      id: SESSION_ID,
    });
    const faux = createFauxCore({
      api: "boundary-failure",
      provider: "boundary-failure",
    });
    const failure = new Error(
      "durable transaction failed after marking ownership",
    );
    const turn = runPiFirstModelTurn({
      model: faux.getModel(),
      session: memory,
      stream: faux.streamSimple,
      systemPrompt: "system",
      prompt: "keep the original invariant",
      tools: [],
      ownership: createPiApiFirstTurnOwnership(),
      providerRequestBoundary: async (mark) => {
        mark();
        throw failure;
      },
    });
    await expect(turn).rejects.toBe(failure);
    await expect(turn).rejects.not.toBeInstanceOf(PiApiModelRequestError);
    expect(faux.state.callCount).toBe(0);
  });

  it("uses Pi migrations and compacted-context projection", async () => {
    const legacyJsonl = [
      {
        type: "session",
        id: SESSION_ID,
        timestamp: "2025-01-01T00:00:00.000Z",
        cwd: "/home/user/workspace",
      },
      {
        type: "message",
        timestamp: "2025-01-01T00:00:01.000Z",
        message: { role: "user", content: "legacy message", timestamp: 1 },
      },
    ]
      .map((entry) => {
        return JSON.stringify(entry);
      })
      .join("\n");
    const migrated = MemoryPiSession.fromJsonl(legacyJsonl);
    expect(migrated.getHeader().version).toBe(CURRENT_SESSION_VERSION);

    const directory = await temporaryDirectory();
    const nativeSession = SessionManager.create(
      "/home/user/workspace",
      directory,
      {
        id: SESSION_ID,
      },
    );
    nativeSession.appendMessage({
      role: "user",
      content: "summarized turn",
      timestamp: 1,
    });
    const firstKeptEntryId = nativeSession.appendMessage({
      role: "user",
      content: "kept turn",
      timestamp: 2,
    });
    nativeSession.appendCompaction(
      "Pi generated summary",
      firstKeptEntryId,
      42,
    );
    nativeSession.appendMessage(
      fauxAssistantMessage("after compaction", { timestamp: 3 }),
    );
    const sessionFile = nativeSession.getSessionFile();
    if (!sessionFile) {
      throw new Error("Expected Pi to create a native session file");
    }
    const memory = MemoryPiSession.fromJsonl(
      await readFile(sessionFile, "utf8"),
    );
    const nativeContext = nativeSession.buildSessionContext();
    expect(memory.buildSessionContext()).toStrictEqual(
      JSON.parse(JSON.stringify(nativeContext)) as unknown,
    );
    expect(
      JSON.parse(
        JSON.stringify(convertToLlm(memory.buildSessionContext().messages)),
      ),
    ).toStrictEqual(
      JSON.parse(
        JSON.stringify(convertToLlm(nativeContext.messages)),
      ) as unknown,
    );
  });

  it("rejects a future Pi session version without invoking the model", () => {
    const futureJsonl = `${JSON.stringify({
      type: "session",
      version: CURRENT_SESSION_VERSION + 1,
      id: SESSION_ID,
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: "/home/user/workspace",
    })}\n`;

    expect(() => {
      return MemoryPiSession.fromJsonl(futureJsonl);
    }).toThrow(UnsupportedPiSessionVersionError);
  });

  it("rejects a malformed line after a valid native session header", () => {
    const memory = MemoryPiSession.create({
      cwd: "/home/user/workspace",
      id: SESSION_ID,
    });

    expect(() => {
      return MemoryPiSession.fromJsonl(`${memory.toJsonl()}{malformed\n`);
    }).toThrow(SyntaxError);
  });

  it("distinguishes a pending handoff from a settled native checkpoint", () => {
    const memory = MemoryPiSession.create({
      cwd: "/home/user/workspace",
      id: SESSION_ID,
    });
    memory.appendMessage({ role: "user", content: "read it", timestamp: 1 });
    const pending = fauxAssistantMessage(
      fauxToolCall("read", { path: "/home/user/workspace/README.md" }),
      { stopReason: "toolUse", timestamp: 2 },
    );
    memory.appendMessage(pending);

    expect(memory.hasPendingToolCalls()).toBe(true);
    expect(memory.isSettledCheckpoint()).toBe(false);
    const call = pending.content.find((content) => {
      return content.type === "toolCall";
    });
    if (!call || call.type !== "toolCall") {
      throw new Error("Expected a pending tool call");
    }
    memory.appendMessage({
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text: "contents" }],
      isError: false,
      timestamp: 3,
    });

    expect(memory.hasPendingToolCalls()).toBe(false);
    expect(memory.isSettledCheckpoint()).toBe(false);
    memory.appendMessage(
      fauxAssistantMessage("done", { stopReason: "stop", timestamp: 4 }),
    );
    expect(memory.isSettledCheckpoint()).toBe(true);
  });
});
