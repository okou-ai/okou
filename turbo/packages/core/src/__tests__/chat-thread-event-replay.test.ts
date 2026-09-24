import { describe, expect, it } from "vitest";
import { chatThreadEventSchema } from "@okouai/api-contracts/contracts/chat-threads";
import { replayChatThreadEvents } from "../chat-thread-event-replay";

const created = chatThreadEventSchema.parse({
  id: "00000000-0000-4000-8000-000000000001",
  seqId: 1,
  kind: "created",
  chatThreadId: "00000000-0000-4000-8000-000000000002",
  agentId: "00000000-0000-4000-8000-000000000003",
  title: null,
  selectedModel: "claude-sonnet-5",
  modelSettings: { "claude-sonnet-5": { effort: "high" } },
  selectedVideoModel: null,
  createdAt: "2026-09-09T00:00:00.000Z",
});
const selected = {
  ...created,
  id: "00000000-0000-4000-8000-000000000004",
  seqId: 2,
  kind: "model_selection_updated" as const,
  selectedModel: "claude-opus-4-8",
  modelSettingsPatch: {
    model: "claude-opus-4-8" as const,
    effort: "extra" as const,
  },
  createdAt: "2026-09-09T00:00:01.000Z",
};

describe("model settings event replay", () => {
  it("replays a selection received before its creation event", () => {
    expect(replayChatThreadEvents([], [selected, created])[0]).toMatchObject({
      selectedModel: "claude-opus-4-8",
      modelSettings: {
        "claude-sonnet-5": { effort: "high" },
        "claude-opus-4-8": { effort: "extra" },
      },
    });
  });

  it("preserves snapshots across model updates without a settings patch", () => {
    const snapshot = replayChatThreadEvents([], [created, selected]);
    const updateWithoutPatch = {
      ...created,
      kind: "model_selection_updated" as const,
      seqId: 3,
      createdAt: "2026-09-09T00:00:02.000Z",
    };
    expect(
      replayChatThreadEvents(snapshot, [updateWithoutPatch])[0],
    ).toMatchObject({
      modelSettings: {
        "claude-sonnet-5": { effort: "high" },
        "claude-opus-4-8": { effort: "extra" },
      },
    });
    expect(replayChatThreadEvents([], [created])[0]).toMatchObject({
      modelSettings: { "claude-sonnet-5": { effort: "high" } },
    });
  });
});

describe("archive event replay", () => {
  const archived = {
    ...created,
    id: "00000000-0000-4000-8000-000000000005",
    seqId: 2,
    kind: "archived" as const,
    createdAt: "2026-09-09T00:00:01.000Z",
  };
  const unarchived = {
    ...created,
    id: "00000000-0000-4000-8000-000000000006",
    seqId: 3,
    kind: "unarchived" as const,
    createdAt: "2026-09-09T00:00:02.000Z",
  };

  it("toggles the archived flag without moving the thread", () => {
    expect(replayChatThreadEvents([], [created])[0]).toMatchObject({
      archived: false,
    });
    expect(replayChatThreadEvents([], [created, archived])[0]).toMatchObject({
      archived: true,
      sortAt: created.createdAt,
    });
    expect(
      replayChatThreadEvents([], [created, archived, unarchived])[0],
    ).toMatchObject({ archived: false });
  });

  it("treats snapshots without the archived field as unarchived", () => {
    const [thread] = replayChatThreadEvents([], [created]);
    if (!thread) {
      throw new Error("Expected the created thread");
    }
    const { archived: _archived, ...legacySnapshot } = thread;
    expect(replayChatThreadEvents([legacySnapshot], [])[0]).toMatchObject({
      archived: false,
    });
    expect(
      replayChatThreadEvents([legacySnapshot], [archived])[0],
    ).toMatchObject({ archived: true });
  });
});

describe("independently committed activity touches", () => {
  it("keeps maximum activity time when sequence order differs from commit time", () => {
    const later = {
      ...created,
      kind: "sort_touched" as const,
      id: "00000000-0000-4000-8000-000000000021",
      seqId: 2,
      createdAt: "2026-09-09T00:00:10.000Z",
    };
    const older = {
      ...later,
      id: "00000000-0000-4000-8000-000000000022",
      seqId: 3,
      createdAt: "2026-09-09T00:00:05.000Z",
    };
    expect(replayChatThreadEvents([], [created, later, older])[0]?.sortAt).toBe(
      later.createdAt,
    );
    const snapshot = replayChatThreadEvents([], [created, later]);
    expect(replayChatThreadEvents(snapshot, [older])[0]?.sortAt).toBe(
      later.createdAt,
    );
  });

  it("still applies explicit pin order independently of activity time", () => {
    const pinned = {
      ...created,
      id: "00000000-0000-4000-8000-000000000023",
      seqId: 2,
      kind: "pinned" as const,
      pinOrder: "b",
      createdAt: "2026-09-09T00:00:10.000Z",
    };
    const moved = {
      ...pinned,
      id: "00000000-0000-4000-8000-000000000024",
      seqId: 3,
      kind: "sort_touched" as const,
      pinOrder: "a",
      createdAt: "2026-09-09T00:00:01.000Z",
    };
    expect(
      replayChatThreadEvents([], [created, pinned, moved])[0],
    ).toMatchObject({
      pinOrder: "a",
      pinnedAt: pinned.createdAt,
      sortAt: created.createdAt,
    });
  });
});
