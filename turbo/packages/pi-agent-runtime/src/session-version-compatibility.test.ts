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

import { inspectPiSessionJsonl } from "./api";
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
  await session.continuePendingTools();
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

it("restores the same native compacted context and pending tools after a bounded Pi branch cut", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-native-compact-generation-"));
  onTestFinished(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const source = await readFile(
    new URL("./test/fixtures/pi-0.84.1-session.jsonl", import.meta.url),
    "utf8",
  );
  const original = MemoryPiSession.fromJsonl(source);
  const lines = source.split("\n");
  const retained = lines.slice(6);
  const firstKept = JSON.parse(retained[0] ?? "null") as Record<
    string,
    unknown
  >;
  expect(firstKept.id).toBe("7a8ffa1b");
  const priorModel = JSON.parse(lines[1] ?? "null") as Record<string, unknown>;
  expect(priorModel.id).toBe("39d32408");
  const priorThinking = JSON.parse(lines[2] ?? "null") as Record<
    string,
    unknown
  >;
  expect(priorThinking.id).toBe("01001b0c");
  // The Guest preserves the last prior model and thinking records, kept
  // pre-compact entries, compact boundary, and post-boundary entries.
  // Reparenting only cut edges keeps Pi's native parent graph usable.
  const candidate = [
    lines[0],
    JSON.stringify({ ...priorModel, parentId: null }),
    JSON.stringify({ ...priorThinking, parentId: priorModel.id }),
    JSON.stringify({ ...firstKept, parentId: priorThinking.id }),
    ...retained.slice(1),
  ].join("\n");
  const bounded = MemoryPiSession.fromJsonl(candidate);
  expect(bounded.getSessionId()).toBe(original.getSessionId());
  // The official Pi projection includes messages, active model, and thinking level.
  expect(bounded.buildSessionContext()).toEqual(original.buildSessionContext());
  expect(bounded.pendingToolIds()).toEqual(original.pendingToolIds());
  expect(bounded.hasPendingToolCalls()).toBe(true);

  const path = join(root, "restored-pi.jsonl");
  const originalPath = join(root, "source-pi.jsonl");
  await writeFile(originalPath, source);
  await writeFile(path, candidate);
  const resumed = SessionManager.open(path, root, root);
  const sourceManager = SessionManager.open(originalPath, root, root);
  expect(resumed.buildSessionContext()).toEqual(
    sourceManager.buildSessionContext(),
  );
  expect(resumed.buildSessionContext()).toEqual(original.buildSessionContext());
  expect(
    resumed.getBranch().map((entry) => {
      return entry.id;
    }),
  ).toEqual([
    "39d32408",
    "01001b0c",
    "7a8ffa1b",
    "83fe410a",
    "a6557155",
    "45a24675",
    "99c24a0f",
  ]);
});

it("preserves a pre-compact assistant model and thinking setting when compact is the leaf", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-compact-prior-model-"));
  onTestFinished(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const header = {
    type: "session",
    version: 3,
    id: "pi-checkpoint-test",
    cwd: root,
    timestamp: "2026-09-27T00:00:00Z",
  };
  const model = {
    type: "message",
    id: "model",
    parentId: null,
    timestamp: "2026-09-27T00:00:00Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "previous model" }],
      provider: "faux",
      model: "faux-1",
      stopReason: "stop",
      timestamp: 1,
    },
  };
  const thinking = {
    type: "thinking_level_change",
    id: "think",
    parentId: "model",
    timestamp: "2026-09-27T00:00:00Z",
    thinkingLevel: "high",
  };
  const title = {
    type: "session_info",
    id: "title",
    parentId: "think",
    timestamp: "2026-09-27T00:00:00Z",
    name: "Retained title",
  };
  const large = {
    type: "message",
    id: "large",
    parentId: "title",
    timestamp: "2026-09-27T00:00:00Z",
    message: { role: "user", content: "X".repeat(2048) },
  };
  const kept = {
    type: "message",
    id: "kept",
    parentId: "large",
    timestamp: "2026-09-27T00:00:00Z",
    message: { role: "user", content: "kept" },
  };
  const compact = {
    type: "compaction",
    id: "compact",
    parentId: "kept",
    timestamp: "2026-09-27T00:00:00Z",
    summary: "summary",
    firstKeptEntryId: "kept",
    tokensBefore: 1000,
  };
  const source = [header, model, thinking, title, large, kept, compact]
    .map((entry) => {
      return JSON.stringify(entry);
    })
    .join("\n");
  const bounded = [
    header,
    model,
    thinking,
    title,
    { ...kept, parentId: "title" },
    compact,
  ]
    .map((entry) => {
      return JSON.stringify(entry);
    })
    .join("\n");
  const originalPath = join(root, "source.jsonl");
  const candidatePath = join(root, "candidate.jsonl");
  await writeFile(originalPath, source);
  await writeFile(candidatePath, bounded);
  const original = SessionManager.open(originalPath, root, root);
  const candidate = SessionManager.open(candidatePath, root, root);
  expect(original.buildSessionContext()).toMatchObject({
    thinkingLevel: "high",
    model: { provider: "faux", modelId: "faux-1" },
  });
  expect(candidate.buildSessionContext()).toEqual(
    original.buildSessionContext(),
  );
  // Session info is not in the model context; check Pi's separate native reader.
  expect(original.getSessionName()).toBe("Retained title");
  expect(candidate.getSessionName()).toBe(original.getSessionName());
  expect(
    candidate.getBranch().map((entry) => {
      return entry.id;
    }),
  ).toEqual(["model", "think", "title", "kept", "compact"]);
  const settledCandidate = [
    bounded,
    JSON.stringify({
      type: "message",
      id: "done",
      parentId: "compact",
      timestamp: "2026-09-27T00:00:00Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        provider: "faux",
        model: "faux-1",
        stopReason: "stop",
        timestamp: 2,
      },
    }),
  ].join("\n");
  expect(inspectPiSessionJsonl(settledCandidate)).toMatchObject({
    sessionId: header.id,
    hasPendingToolCalls: false,
    isSettledCheckpoint: true,
  });
});

it("restores a Pi-written compaction with no kept pre-compact entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-compact-no-kept-"));
  onTestFinished(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const timestamp = "2026-09-27T00:00:00Z";
  const header = {
    type: "session",
    version: 3,
    id: "pi-no-kept",
    cwd: root,
    timestamp,
  };
  const model = {
    type: "model_change",
    id: "model",
    parentId: null,
    timestamp,
    provider: "faux",
    modelId: "faux-1",
  };
  const old = {
    type: "message",
    id: "old",
    parentId: "model",
    timestamp,
    message: { role: "user", content: "X".repeat(2048) },
  };
  const originalPath = join(root, "original.jsonl");
  await writeFile(
    originalPath,
    [header, model, old]
      .map((entry) => {
        return JSON.stringify(entry);
      })
      .join("\n") + "\n",
  );
  const original = SessionManager.open(originalPath, root, root);
  const compactId = original.appendCompaction("summary", null, 1000);
  const doneId = original.appendMessage(fauxAssistantMessage("done"));
  const entries = original.getEntries();
  const compact = entries.find((entry) => {
    return entry.id === compactId;
  });
  const done = entries.find((entry) => {
    return entry.id === doneId;
  });
  expect(compact).toMatchObject({
    type: "compaction",
    firstKeptEntryId: compactId,
    parentId: "old",
  });
  expect(done).toMatchObject({ type: "message", parentId: compactId });
  if (!compact || !done) {
    throw new Error("Pi did not write the expected native entries");
  }
  const candidateJsonl = [
    header,
    model,
    { ...compact, parentId: "model" },
    done,
  ]
    .map((entry) => {
      return JSON.stringify(entry);
    })
    .join("\n");
  const candidatePath = join(root, "candidate.jsonl");
  await writeFile(candidatePath, candidateJsonl);
  const candidate = SessionManager.open(candidatePath, root, root);
  expect(candidate.buildSessionContext()).toEqual(
    original.buildSessionContext(),
  );
  expect(candidate.getSessionName()).toBe(original.getSessionName());
  expect(
    candidate.getBranch().map((entry) => {
      return entry.id;
    }),
  ).toEqual(["model", compactId, doneId]);
  expect(inspectPiSessionJsonl(candidateJsonl)).toMatchObject({
    sessionId: header.id,
    isSettledCheckpoint: true,
    hasPendingToolCalls: false,
  });
});

it("preserves a cleared optional native session name after a bounded cut", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-compact-cleared-name-"));
  onTestFinished(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const timestamp = "2026-09-27T00:00:00Z";
  const header = {
    type: "session",
    version: 3,
    id: "pi-cleared-name",
    cwd: root,
    timestamp,
  };
  const title = {
    type: "session_info",
    id: "prior_title",
    parentId: null,
    timestamp,
    name: "Former title",
  };
  const cleared = {
    type: "session_info",
    id: "cleared_title",
    parentId: "prior_title",
    timestamp,
  };
  const old = {
    type: "message",
    id: "old",
    parentId: "cleared_title",
    timestamp,
    message: { role: "user", content: "X".repeat(2048) },
  };
  const kept = {
    type: "message",
    id: "kept",
    parentId: "old",
    timestamp,
    message: { role: "user", content: "kept" },
  };
  const compact = {
    type: "compaction",
    id: "compact",
    parentId: "kept",
    timestamp,
    summary: "summary",
    firstKeptEntryId: "kept",
    tokensBefore: 1000,
  };
  const done = {
    type: "message",
    id: "done",
    parentId: "compact",
    timestamp,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      provider: "faux",
      model: "faux-1",
      stopReason: "stop",
      timestamp: 1,
    },
  };
  const originalJsonl = [header, title, cleared, old, kept, compact, done]
    .map((entry) => {
      return JSON.stringify(entry);
    })
    .join("\n");
  const boundedJsonl = [
    header,
    { ...cleared, parentId: null },
    { ...kept, parentId: "cleared_title" },
    compact,
    done,
  ]
    .map((entry) => {
      return JSON.stringify(entry);
    })
    .join("\n");
  const originalPath = join(root, "original.jsonl");
  const candidatePath = join(root, "candidate.jsonl");
  await writeFile(originalPath, originalJsonl);
  await writeFile(candidatePath, boundedJsonl);
  const original = SessionManager.open(originalPath, root, root);
  const candidate = SessionManager.open(candidatePath, root, root);
  expect(original.getSessionName()).toBeUndefined();
  expect(candidate.getSessionName()).toBe(original.getSessionName());
  expect(candidate.buildSessionContext()).toEqual(
    original.buildSessionContext(),
  );
  expect(
    candidate.getBranch().map((entry) => {
      return entry.id;
    }),
  ).toEqual(["cleared_title", "kept", "compact", "done"]);
  expect(inspectPiSessionJsonl(boundedJsonl)).toMatchObject({
    sessionId: header.id,
    isSettledCheckpoint: true,
  });
});

it("reads a 0.86.1-written session identically on 0.85.1 and projects its new system entry", async () => {
  const source = await readFile(
    new URL("./test/fixtures/pi-0.86.1-session.jsonl", import.meta.url),
    "utf8",
  );
  expect(source.endsWith("\n")).toBe(false);

  // Session format stays v3, so the stored record is unchanged by the upgrade.
  const memory = MemoryPiSession.fromJsonl(source);
  expect(memory.getSessionId()).toBe("pi-0861-rollback-fixture");
  expect(memory.getBranchEntries()).toHaveLength(5);

  // 0.86 declares the tool loadout as a transcript system message, so every
  // projection that counts or positionally inspects messages must tolerate it.
  const context = memory.buildSessionContext();
  expect(
    context.messages.map((message) => {
      return message.role;
    }),
  ).toEqual(["user", "assistant", "system", "user", "assistant"]);

  // Positional readers stay correct with the system entry present.
  expect(memory.hasPendingToolCalls()).toBe(false);
  expect(memory.pendingToolIds()).toEqual([]);
  expect(memory.isSettledCheckpoint()).toBe(true);

  // Rollback is readable, not lossless: an official 0.85.1 installation reads
  // this same file with the identical session id, 5 entries, 5 active-branch
  // entries and the same 5 projected messages, including the `system` one its
  // own LLM boundary would then discard. See the PR for that measurement.
  const reopened = MemoryPiSession.fromJsonl(memory.toJsonl());
  expect(reopened.getSessionId()).toBe(memory.getSessionId());
  expect(reopened.buildSessionContext()).toEqual(context);
  expect(memory.toJsonl().startsWith(source)).toBe(true);
});
