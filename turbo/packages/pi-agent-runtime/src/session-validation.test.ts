import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { runInIsolatedProcess } from "../../../scripts/run-isolated-test.mjs";
import { inspectPiSessionJsonl } from "./api";
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
    modelId: "gpt-6-luna",
  };
}
const cycles = [
  [entry("self", "self")],
  [entry("a", "b"), entry("b", "a")],
  [entry("a", "b"), entry("b", "c"), entry("c", "a")],
  [entry("a", "b"), entry("b", "a"), entry("active", null)],
];

describe("native Pi history structural boundaries", () => {
  it("rejects cycles in every component before API inspection", async () => {
    if (await runInIsolatedProcess(import.meta.url)) {
      return;
    }
    for (const entries of cycles) {
      const history = jsonl(entries);
      expect(() => {
        return inspectPiSessionJsonl(history);
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
      pendingToolIds: [],
      hasPendingToolCalls: false,
      isSettledHistory: false,
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
      expect(migrated.isSettledHistory()).toBe(true);
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
    expect(memory.isSettledHistory()).toBe(true);
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
      isSettledHistory: true,
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
      isSettledHistory: false,
    });
  });
});
