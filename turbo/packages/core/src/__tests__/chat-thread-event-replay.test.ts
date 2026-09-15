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
