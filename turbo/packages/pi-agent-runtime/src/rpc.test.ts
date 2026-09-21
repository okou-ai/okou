import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
  type Message,
  Type,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resumePiApiFirstTurn } from "./rpc";
import type { PiMemoryToolSourceUse } from "./api-types";
import { createPiMemoryTools } from "./memory-tools-node";
import { MemoryPiSession } from "./session-memory";

const SESSION_ID = "00000000-0000-4000-8000-000000000123";
const TOOL_CALL_ID = "api-tool-call";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("Pi API first-turn sandbox resume", () => {
  it("executes one pending memory call once and never repeats it on follow-up", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-memory-resume-"));
    temporaryDirectories.push(directory);
    const memoryRoot = join(directory, "memory");
    await mkdir(memoryRoot);
    await writeFile(join(memoryRoot, "MEMORY.md"), "Frozen version A");
    const sessionFile = join(directory, "handoff.jsonl");
    const memory = MemoryPiSession.create({
      cwd: "/home/user/workspace",
      id: SESSION_ID,
    });
    memory.appendMessage({
      role: "user",
      content: "read the frozen index",
      timestamp: 1,
    });
    memory.appendMessage(
      fauxAssistantMessage(
        fauxToolCall(
          "memories_read",
          { path: "MEMORY.md" },
          { id: TOOL_CALL_ID },
        ),
        { stopReason: "toolUse", timestamp: 2 },
      ),
    );
    await writeFile(sessionFile, memory.toJsonl());

    const faux = createFauxCore({
      api: "memory-resume-test",
      provider: "memory-resume-test",
    });
    faux.setResponses([
      (context) => {
        // 0.86 appends a tool-declaration system message after the tool
        // results, so the pending result is no longer the final message.
        expect(
          [...context.messages].reverse().find((message: Message) => {
            return message.role === "toolResult";
          }),
        ).toMatchObject({
          role: "toolResult",
          toolCallId: TOOL_CALL_ID,
          content: [
            {
              type: "text",
              text: expect.stringContaining("Frozen version A"),
            },
          ],
        });
        return fauxAssistantMessage("memory continuation complete", {
          timestamp: 3,
        });
      },
      fauxAssistantMessage("follow-up complete", { timestamp: 5 }),
    ]);
    const modelRuntime = await ModelRuntime.create({
      allowModelNetwork: false,
      modelsPath: null,
      refreshOnCreate: false,
    });
    modelRuntime.registerProvider(faux.provider, {
      name: faux.provider,
      api: faux.api,
      baseUrl: faux.getModel().baseUrl,
      apiKey: "test-api-key",
      streamSimple: faux.streamSimple,
      models: faux.models,
    });
    const sourceUses: PiMemoryToolSourceUse[] = [];
    const { session } = await createAgentSession({
      cwd: "/home/user/workspace",
      agentDir: join(directory, "agent"),
      model: faux.getModel(),
      modelRuntime,
      sessionManager: SessionManager.open(sessionFile),
      tools: ["memories_read"],
      customTools: createPiMemoryTools({
        mode: "sandbox",
        selection: {
          status: "no-content",
          memoryStorageId: "memory-storage-a",
          storageVersionId: "memory-version-a",
        },
        memoryRoot,
        onSourceUse(sourceUse) {
          sourceUses.push(sourceUse);
        },
      }),
    });

    await resumePiApiFirstTurn(session);
    expect(sourceUses).toHaveLength(1);
    expect(faux.state.callCount).toBe(1);
    await session.prompt("ordinary follow-up");
    expect(sourceUses).toHaveLength(1);
    expect(faux.state.callCount).toBe(2);
    session.dispose();

    const reopened = SessionManager.open(sessionFile);
    expect(
      reopened.buildSessionContext().messages.filter((message) => {
        return (
          message.role === "toolResult" && message.toolCallId === TOOL_CALL_ID
        );
      }),
    ).toHaveLength(1);
  });

  it("stages one API-first ad-hoc note exactly once after sandbox ownership", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-memory-write-resume-"));
    temporaryDirectories.push(directory);
    const memoryRoot = join(directory, "memory");
    await mkdir(memoryRoot);
    const sessionFile = join(directory, "handoff.jsonl");
    const filename = "2026-09-05T16-10-00-api-sandbox-handoff.md";
    const note = "# API-first handoff\n\nWrite these bytes exactly once.\n";
    const memory = MemoryPiSession.create({
      cwd: "/home/user/workspace",
      id: SESSION_ID,
    });
    memory.appendMessage({
      role: "user",
      content: "remember this after the sandbox takes ownership",
      timestamp: 1,
    });
    memory.appendMessage(
      fauxAssistantMessage(
        fauxToolCall(
          "add_ad_hoc_note",
          { filename, note },
          { id: TOOL_CALL_ID },
        ),
        { stopReason: "toolUse", timestamp: 2 },
      ),
    );
    await writeFile(sessionFile, memory.toJsonl());

    const faux = createFauxCore({
      api: "memory-write-resume-test",
      provider: "memory-write-resume-test",
    });
    faux.setResponses([
      (context) => {
        // 0.86 appends a tool-declaration system message after the tool
        // results, so the pending result is no longer the final message.
        expect(
          [...context.messages].reverse().find((message: Message) => {
            return message.role === "toolResult";
          }),
        ).toMatchObject({
          role: "toolResult",
          toolCallId: TOOL_CALL_ID,
          toolName: "add_ad_hoc_note",
          isError: false,
          content: [
            {
              type: "text",
              text: `{"status":"staged","path":"extensions/ad_hoc/notes/${filename}"}`,
            },
          ],
        });
        return fauxAssistantMessage("sandbox continuation complete", {
          timestamp: 3,
        });
      },
    ]);
    const modelRuntime = await ModelRuntime.create({
      allowModelNetwork: false,
      modelsPath: null,
      refreshOnCreate: false,
    });
    modelRuntime.registerProvider(faux.provider, {
      name: faux.provider,
      api: faux.api,
      baseUrl: faux.getModel().baseUrl,
      apiKey: "test-api-key",
      streamSimple: faux.streamSimple,
      models: faux.models,
    });
    const { session } = await createAgentSession({
      cwd: "/home/user/workspace",
      agentDir: join(directory, "agent"),
      model: faux.getModel(),
      modelRuntime,
      sessionManager: SessionManager.open(sessionFile),
      tools: ["add_ad_hoc_note"],
      customTools: createPiMemoryTools({
        mode: "sandbox",
        selection: {
          status: "no-content",
          memoryStorageId: "memory-storage-a",
          storageVersionId: "memory-version-a",
        },
        memoryRoot,
      }),
    });

    await resumePiApiFirstTurn(session);
    expect(
      await readFile(
        join(memoryRoot, "extensions", "ad_hoc", "notes", filename),
      ),
    ).toStrictEqual(Buffer.from(note, "utf8"));
    expect(faux.state.callCount).toBe(1);
    await expect(resumePiApiFirstTurn(session)).rejects.toThrow(
      "no pending tool calls",
    );
    expect(
      await readFile(
        join(memoryRoot, "extensions", "ad_hoc", "notes", filename),
      ),
    ).toStrictEqual(Buffer.from(note, "utf8"));
    session.dispose();

    const reopened = SessionManager.open(sessionFile);
    expect(
      reopened.buildSessionContext().messages.filter((message) => {
        return (
          message.role === "toolResult" && message.toolCallId === TOOL_CALL_ID
        );
      }),
    ).toHaveLength(1);
  });

  it("executes pending H1 tools and continues through Pi AgentSession", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-handoff-resume-"));
    temporaryDirectories.push(directory);
    const sessionFile = join(directory, "handoff.jsonl");
    const memory = MemoryPiSession.create({
      cwd: "/home/user/workspace",
      id: SESSION_ID,
    });
    memory.appendMessage({
      role: "user",
      content: "read the preheated skill",
      timestamp: 1,
    });
    memory.appendMessage(
      fauxAssistantMessage(
        fauxToolCall(
          "read",
          { path: "/home/user/.pi/agent/skills/example/SKILL.md" },
          { id: TOOL_CALL_ID },
        ),
        { stopReason: "toolUse", timestamp: 2 },
      ),
    );
    await writeFile(sessionFile, memory.toJsonl());

    const execute = vi.fn(async (_id: string, args: { path: string }) => {
      return {
        content: [{ type: "text" as const, text: `body:${args.path}` }],
        details: {},
      };
    });
    const faux = createFauxCore({
      api: "resume-test",
      provider: "resume-test",
    });
    faux.setResponses([
      (context) => {
        // 0.86 appends a tool-declaration system message after the tool
        // results, so the pending result is no longer the final message.
        expect(
          [...context.messages].reverse().find((message: Message) => {
            return message.role === "toolResult";
          }),
        ).toMatchObject({
          role: "toolResult",
          toolCallId: TOOL_CALL_ID,
        });
        return fauxAssistantMessage("sandbox continuation complete", {
          timestamp: 3,
        });
      },
    ]);
    const modelRuntime = await ModelRuntime.create({
      allowModelNetwork: false,
      modelsPath: null,
      refreshOnCreate: false,
    });
    modelRuntime.registerProvider(faux.provider, {
      name: faux.provider,
      api: faux.api,
      baseUrl: faux.getModel().baseUrl,
      apiKey: "test-api-key",
      streamSimple: faux.streamSimple,
      models: faux.models,
    });
    const { session } = await createAgentSession({
      cwd: "/home/user/workspace",
      agentDir: join(directory, "agent"),
      model: faux.getModel(),
      modelRuntime,
      sessionManager: SessionManager.open(sessionFile),
      tools: ["read"],
      customTools: [
        {
          name: "read",
          label: "read",
          description: "Read a file",
          parameters: Type.Object({ path: Type.String() }),
          execute,
        },
      ],
    });

    await resumePiApiFirstTurn(session);

    expect(execute).toHaveBeenCalledExactlyOnceWith(
      TOOL_CALL_ID,
      { path: "/home/user/.pi/agent/skills/example/SKILL.md" },
      expect.any(AbortSignal),
      expect.any(Function),
      expect.anything(),
    );
    expect(session.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "sandbox continuation complete" }],
    });
    expect(faux.state.callCount).toBe(1);
    session.dispose();
    const reopened = SessionManager.open(sessionFile);
    expect(reopened.buildSessionContext().messages.slice(-3)).toMatchObject([
      { role: "toolResult", toolCallId: TOOL_CALL_ID, isError: false },
      { role: "system" },
      {
        role: "assistant",
        content: [{ type: "text", text: "sandbox continuation complete" }],
      },
    ]);
    expect(await readFile(sessionFile, "utf8")).toContain(
      "sandbox continuation complete",
    );
  });

  it("executes the representative Okou CLI handoff through sandbox bash", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-okou-resume-"));
    temporaryDirectories.push(directory);
    const sessionFile = join(directory, "handoff.jsonl");
    const command = 'npx --yes --package="${CLI_PKG_URL}" okou --help';
    const memory = MemoryPiSession.create({
      cwd: "/home/user/workspace",
      id: SESSION_ID,
    });
    memory.appendMessage({
      role: "user",
      content: "inspect Okou once",
      timestamp: 1,
    });
    memory.appendMessage(
      fauxAssistantMessage(
        fauxToolCall("bash", { command }, { id: TOOL_CALL_ID }),
        { stopReason: "toolUse", timestamp: 2 },
      ),
    );
    await writeFile(sessionFile, memory.toJsonl());

    const execute = vi.fn(async (_id: string, args: { command: string }) => {
      return {
        content: [{ type: "text" as const, text: "Okou CLI fixture help" }],
        details: { command: args.command },
      };
    });
    const faux = createFauxCore({
      api: "terra-okou-resume-test",
      provider: "openai",
    });
    faux.setResponses([
      (context) => {
        // 0.86 appends a tool-declaration system message after the tool
        // results, so the pending result is no longer the final message.
        expect(
          [...context.messages].reverse().find((message: Message) => {
            return message.role === "toolResult";
          }),
        ).toMatchObject({
          role: "toolResult",
          toolCallId: TOOL_CALL_ID,
          content: [{ type: "text", text: "Okou CLI fixture help" }],
        });
        return fauxAssistantMessage("Okou handoff complete", {
          timestamp: 3,
        });
      },
    ]);
    const modelRuntime = await ModelRuntime.create({
      allowModelNetwork: false,
      modelsPath: null,
      refreshOnCreate: false,
    });
    modelRuntime.registerProvider(faux.provider, {
      name: faux.provider,
      api: faux.api,
      baseUrl: faux.getModel().baseUrl,
      apiKey: "test-api-key",
      streamSimple: faux.streamSimple,
      models: faux.models,
    });
    const { session } = await createAgentSession({
      cwd: "/home/user/workspace",
      agentDir: join(directory, "agent"),
      model: faux.getModel(),
      modelRuntime,
      sessionManager: SessionManager.open(sessionFile),
      tools: ["bash"],
      customTools: [
        {
          name: "bash",
          label: "bash",
          description: "Execute a sandboxed command",
          parameters: Type.Object({ command: Type.String() }),
          execute,
        },
      ],
    });

    await resumePiApiFirstTurn(session);

    expect(execute).toHaveBeenCalledExactlyOnceWith(
      TOOL_CALL_ID,
      { command },
      expect.any(AbortSignal),
      expect.any(Function),
      expect.anything(),
    );
    expect(faux.state.callCount).toBe(1);
    session.dispose();
    const persisted = await readFile(sessionFile, "utf8");
    expect(persisted).toContain("Okou CLI fixture help");
    expect(persisted).toContain("Okou handoff complete");
  });
});
