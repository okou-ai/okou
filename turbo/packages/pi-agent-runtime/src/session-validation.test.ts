import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { runInIsolatedProcess } from "../../../scripts/run-isolated-test.mjs";
import { inspectPiSessionJsonl, projectPiMemoryStage1Evidence } from "./api";
import { runPiOfficialRpcMode } from "./rpc";
import { MemoryPiSession } from "./session-memory";
import { UnsupportedPiSessionVersionError } from "./errors";

const SESSION_ID = "synthetic-session";
const header = {
  type: "session",
  version: 3,
  id: SESSION_ID,
  timestamp: "2026-09-05T00:00:00.000Z",
  cwd: "/workspace",
};
function jsonl(
  entries: readonly unknown[],
  version: number | null = 3,
): string {
  return (
    [{ ...header, version: version ?? undefined }, ...entries]
      .map((record) => {
        return JSON.stringify(record);
      })
      .join("\n") + "\n"
  );
}
function entry(id: string, parentId: string | null) {
  return {
    type: "model_change",
    id,
    parentId,
    timestamp: header.timestamp,
    provider: "openai",
    modelId: "gpt-5.6-terra",
  };
}
const cycles = [
  [entry("self", "self")],
  [entry("a", "b"), entry("b", "a")],
  [entry("a", "b"), entry("b", "c"), entry("c", "a")],
  [entry("a", "b"), entry("b", "a"), entry("active", null)],
];

describe("native Pi history structural boundaries", () => {
  it("rejects cycles in every component before API inspection and Stage 1 projection", async () => {
    if (await runInIsolatedProcess(import.meta.url)) {
      return;
    }
    for (const entries of cycles) {
      const history = jsonl(entries);
      expect(() => {
        return inspectPiSessionJsonl(history);
      }).toThrow("Pi session parent graph contains a cycle");
      expect(() => {
        return projectPiMemoryStage1Evidence({
          jsonl: history,
          expectedSessionId: SESSION_ID,
        });
      }).toThrow("Pi session parent graph contains a cycle");
    }
  }, 150_000);
  it.each([
    {
      entries: [entry("a", null), entry("a", null)],
      error: "duplicate entry ids",
    },
    { entries: [entry("", null)], error: "nonempty string" },
    { entries: [{ ...entry("a", null), id: 42 }], error: "nonempty string" },
    {
      entries: [{ type: "extension", parentId: null }],
      error: "nonempty string",
    },
    {
      entries: [{ type: "extension", id: "a" }],
      error: "parentId must be null or a string",
    },
    {
      entries: [{ ...entry("a", null), parentId: {} }],
      error: "parentId must be null or a string",
    },
    { entries: [header], error: "exactly one session header" },
    ...[null, [], 0, false, "private source"].map((record) => {
      return {
        entries: [record],
        error: "records must be objects",
      };
    }),
  ])("rejects malformed structure ($error)", ({ entries, error }) => {
    expect(() => {
      return inspectPiSessionJsonl(jsonl(entries));
    }).toThrow(error);
  });
  it("sanitizes malformed JSON errors and retains future-version classification", () => {
    expect(() => {
      return inspectPiSessionJsonl(`${jsonl([])}private source`);
    }).toThrow(
      new SyntaxError("Pi session JSONL contains an invalid JSON record"),
    );
    expect(() => {
      return inspectPiSessionJsonl(jsonl([], 999));
    }).toThrow(UnsupportedPiSessionVersionError);
    expect(() => {
      return inspectPiSessionJsonl(JSON.stringify(entry("a", null)));
    }).toThrow("must start with a session header");
  });
  it("validates deep chains and wide branching iteratively", async () => {
    if (await runInIsolatedProcess(import.meta.url)) {
      return;
    }
    const entries = Array.from({ length: 30_000 }, (_, index) => {
      return entry(`deep-${index}`, index === 0 ? null : `deep-${index - 1}`);
    });
    entries.reverse();
    entries.push(
      ...Array.from({ length: 30_000 }, (_, index) => {
        return entry(`wide-${index}`, "deep-29999");
      }),
    );
    expect(inspectPiSessionJsonl(jsonl(entries))).toStrictEqual({
      sessionId: SESSION_ID,
      messageCount: 0,
      hasPendingToolCalls: false,
      isSettledCheckpoint: false,
    });
  }, 150_000);
  it.each([null, 1, 2])(
    "preserves official legacy migration for version %s",
    (version) => {
      const history = jsonl(
        [
          {
            type: "message",
            ...(version === 2 ? { id: "legacy", parentId: null } : {}),
            timestamp: header.timestamp,
            message: {
              role: "hookMessage",
              customType: "legacy-extension",
              content: "legacy custom",
              display: true,
              timestamp: 1,
              extra: { preserved: true },
            },
          },
          {
            type: "message",
            ...(version === 2 ? { id: "answer", parentId: "legacy" } : {}),
            timestamp: header.timestamp,
            message: {
              ...fauxAssistantMessage("legacy answer"),
              legacyField: "preserved",
            },
          },
        ],
        version,
      );
      const migrated = MemoryPiSession.fromJsonl(history);
      expect(migrated.getHeader()).toMatchObject({
        id: SESSION_ID,
        version: 3,
      });
      expect(migrated.buildSessionContext().messages).toMatchObject([
        { role: "custom", extra: { preserved: true } },
        { role: "assistant", legacyField: "preserved" },
      ]);
      expect(migrated.isSettledCheckpoint()).toBe(true);
    },
  );
  it("preserves SDK multiple roots, branches, labels, compaction and custom records", () => {
    const native = SessionManager.inMemory("/workspace", { id: SESSION_ID });
    const root = native.appendMessage({
      role: "user",
      content: "first root",
      timestamp: 1,
    });
    native.appendMessage(fauxAssistantMessage("abandoned branch"));
    native.branch(root);
    native.appendCustomEntry("extension", { preserved: [1, 2] });
    native.appendLabelChange(root, "branch label");
    native.resetLeaf();
    const kept = native.appendMessage({
      role: "user",
      content: "new root",
      timestamp: 2,
    });
    native.appendCompaction("summary", kept, 100, { preserved: true });
    native.appendMessage(fauxAssistantMessage("compacted answer"));
    native.branchWithSummary(null, "root summary", { preserved: true });
    native.appendSessionInfo("session title");
    native.appendMessage(
      fauxAssistantMessage("active answer", { stopReason: "length" }),
    );
    const history =
      [native.getHeader(), ...native.getEntries()]
        .map((record) => {
          return JSON.stringify(record);
        })
        .join("\n") + "\n";
    const memory = MemoryPiSession.fromJsonl(history);
    expect(memory.toJsonl()).toBe(history);
    expect(memory.buildSessionContext()).toEqual(
      JSON.parse(JSON.stringify(native.buildSessionContext())),
    );
    expect(memory.isSettledCheckpoint()).toBe(true);
  });
  it("preserves legacy null message content through the official projection", () => {
    const history = jsonl([
      {
        ...entry("answer", null),
        type: "message",
        message: { ...fauxAssistantMessage("legacy"), content: null },
      },
    ]);
    const memory = MemoryPiSession.fromJsonl(history);
    expect(memory.toJsonl()).toBe(history);
    expect(memory.buildSessionContext().messages).toMatchObject([
      { role: "assistant", content: [] },
    ]);
    expect(inspectPiSessionJsonl(history)).toMatchObject({
      messageCount: 1,
      isSettledCheckpoint: true,
    });
  });

  it("preserves orphans, forward references and non-parent reference namespaces", () => {
    const history = jsonl([
      {
        ...entry("child", "parent"),
        type: "extension",
        targetId: "child",
        fromId: "child",
      },
      entry("parent", "missing"),
      entry(SESSION_ID, null),
      {
        ...entry("answer", "child"),
        type: "message",
        message: fauxAssistantMessage("forward branch"),
      },
    ]);
    const memory = MemoryPiSession.fromJsonl(history);
    expect(memory.toJsonl()).toBe(history);
    expect(
      memory.getBranchEntries().map((record) => {
        return record.id;
      }),
    ).toEqual(["parent", "child", "answer"]);
    expect(memory.buildSessionContext().messages).toMatchObject([
      { role: "assistant" },
    ]);
    expect(inspectPiSessionJsonl(jsonl([]))).toMatchObject({
      messageCount: 0,
      isSettledCheckpoint: false,
    });
  });
  it("rejects direct persisted RPC startup before rewriting files or executing runtime work", async () => {
    if (await runInIsolatedProcess(import.meta.url)) {
      return;
    }
    const directory = await mkdtemp(join(tmpdir(), "pi-invalid-rpc-"));
    const sessionFile = join(directory, "session.jsonl");
    const args = {
      sessionId: SESSION_ID,
      sessionFile,
      sessionDir: directory,
      cwd: directory,
      agentDir: join(directory, "agent"),
      appendSystemPrompt: null,
      ownershipTransferMode: "sandbox-first" as const,
      model: {
        provider: "openai",
        model: "gpt-5.6-terra",
        dialect: "openai-responses" as const,
        transport: "sse" as const,
        apiKey: "synthetic-key",
        baseUrl: "http://127.0.0.1:1",
      },
    };
    try {
      for (const version of [2, 3]) {
        for (const entries of cycles) {
          const history = jsonl(entries, version);
          await writeFile(sessionFile, history);
          await expect(runPiOfficialRpcMode(args)).rejects.toThrow(
            "Pi session parent graph contains a cycle",
          );
          expect(await readFile(sessionFile, "utf8")).toBe(history);
        }
      }
      for (const { history, error } of [
        {
          history: jsonl([entry("a", null), entry("a", null)], 2),
          error: "duplicate entry ids",
        },
        { history: jsonl([null], 1), error: "records must be objects" },
        { history: jsonl([], 999), error: "newer than supported" },
        {
          history: jsonl([], 1).replace(SESSION_ID, "wrong-session"),
          error: "session id does not match",
        },
      ]) {
        await writeFile(sessionFile, history);
        await expect(runPiOfficialRpcMode(args)).rejects.toThrow(error);
        expect(await readFile(sessionFile, "utf8")).toBe(history);
      }
      const valid = jsonl([entry("a", null)]);
      await writeFile(sessionFile, valid);
      // Fault-inject the third-party load result to prove runtime validates
      // the entries it receives, independently of the earlier byte check.
      const open = SessionManager.open.bind(SessionManager);
      const spy = vi
        .spyOn(SessionManager, "open")
        .mockImplementation((...openArgs) => {
          const manager = open(...openArgs);
          const loaded = manager.getEntries()[0];
          if (!loaded) throw new Error("Expected a loaded entry");
          loaded.parentId = loaded.id;
          return manager;
        });
      try {
        await expect(runPiOfficialRpcMode(args)).rejects.toThrow(
          "Pi session parent graph contains a cycle",
        );
        expect(await readFile(sessionFile, "utf8")).toBe(valid);
      } finally {
        spy.mockRestore();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 150_000);
});
