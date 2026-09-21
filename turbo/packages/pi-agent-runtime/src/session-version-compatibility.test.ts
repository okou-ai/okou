import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createFauxCore,
  fauxAssistantMessage,
  Type,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { expect, it, onTestFinished } from "vitest";

import { resumePiApiFirstTurn } from "./rpc";
import { MemoryPiSession } from "./session-memory";

it("continues the official 0.84.1 branch and compaction fixture without replay or a JSONL rewrite", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-session-version-"));
  onTestFinished(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const source = await readFile(
    new URL("./test/fixtures/pi-0.84.1-session.jsonl", import.meta.url),
    "utf8",
  );
  expect(source.endsWith("\n")).toBe(false);
  const memory = MemoryPiSession.fromJsonl(source);
  expect(memory.getSessionId()).toBe("pi-0841-rollback-fixture");
  expect(memory.hasPendingToolCalls()).toBe(true);
  const file = join(root, "session.jsonl");
  await writeFile(file, source);
  const manager = SessionManager.open(file, root, root);
  const originalEntries = manager.getEntries();
  const originalBranch = manager.getBranch();
  expect(manager.buildSessionContext()).toEqual(memory.buildSessionContext());
  expect(
    originalEntries.filter((entry) => {
      return entry.type === "compaction";
    }),
  ).toHaveLength(1);
  expect(
    originalEntries.filter((entry) => {
      return entry.type === "branch_summary";
    }),
  ).toHaveLength(1);
  const faux = createFauxCore({
    api: "session-version-test",
    provider: "session-version-test",
  });
  faux.setResponses([
    (context) => {
      expect(
        context.messages.filter((message) => {
          return message.role === "toolResult";
        }),
      ).toMatchObject([
        {
          toolCallId: "resolved-call",
          content: [{ text: "already resolved by the prior owner" }],
        },
        { toolCallId: "pending-call", content: [{ text: "continued once" }] },
      ]);
      return fauxAssistantMessage("continued with 0.85.1");
    },
    fauxAssistantMessage("ordinary follow-up complete"),
  ]);
  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false,
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerProvider(faux.provider, {
    name: faux.provider,
    api: faux.api,
    apiKey: "synthetic-key",
    baseUrl: faux.getModel().baseUrl,
    streamSimple: faux.streamSimple,
    models: faux.models,
  });
  const executed: string[] = [];
  const parameters = Type.Object({ path: Type.String() });
  const continuationTool: ToolDefinition<typeof parameters> = {
    name: "controlled",
    label: "controlled",
    description: "Continue the historical fixture",
    parameters,
    execute: async (id, args) => {
      executed.push(id);
      await writeFile(join(root, args.path), "continued once");
      return {
        content: [{ type: "text", text: "continued once" }],
        details: { preserved: true },
      };
    },
  };
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: join(root, "agent"),
    sessionManager: manager,
    model: faux.getModel(),
    modelRuntime,
    settingsManager: SettingsManager.inMemory({}, { projectTrusted: true }),
    tools: ["controlled"],
    customTools: [continuationTool],
  });
  onTestFinished(() => {
    session.dispose();
  });
  const started: string[] = [];
  let settled = 0;
  session.subscribe((event) => {
    if (event.type === "message_start") started.push(event.message.role);
    if (event.type === "agent_settled") settled += 1;
  });
  await resumePiApiFirstTurn(session);
  expect(executed).toEqual(["pending-call"]);
  expect(await readFile(join(root, "effect.txt"), "utf8")).toBe(
    "continued once",
  );
  expect(faux.state.callCount).toBe(1);
  // 0.86 declares the tool loadout in a system message before each model
  // request, so the post-tool assistant response is preceded by one.
  expect(started).toEqual(["toolResult", "system", "assistant"]);
  expect(settled).toBe(1);
  await session.prompt("new explicit follow-up");
  expect(faux.state.callCount).toBe(2);
  expect(executed).toEqual(["pending-call"]);
  const written = await readFile(file, "utf8");
  expect(written.startsWith(`${source}\n`)).toBe(true);
  const reopened = SessionManager.open(file);
  expect(reopened.getSessionId()).toBe(memory.getSessionId());
  expect(reopened.getEntries().slice(0, originalEntries.length)).toEqual(
    originalEntries,
  );
  expect(reopened.getBranch().slice(0, originalBranch.length)).toEqual(
    originalBranch,
  );
  expect(MemoryPiSession.fromJsonl(written).isSettledCheckpoint()).toBe(true);
});
