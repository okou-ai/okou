import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

describe("Pi native pending-tool continuation", () => {
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

    await session.continuePendingTools();

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
    const command = "okou --help";
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
      api: "luna-okou-resume-test",
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

    await session.continuePendingTools();

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
