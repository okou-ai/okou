import { describe, expect, it } from "vitest";
import { projectPiMemoryChatStage1Evidence } from "./api";
import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";

const threadId = "00000000-0000-4000-8000-000000000001";
const sourceRunId = "00000000-0000-4000-8000-000000000002";

function row(
  seqId: number,
  eventType: ChatEventRow["eventType"],
  payload: ChatEventRow["payload"],
): ChatEventRow {
  return {
    id: `00000000-0000-4000-8000-${String(seqId + 10).padStart(12, "0")}`,
    chatThreadId: threadId,
    runId: sourceRunId,
    revokesEventId: null,
    eventType,
    payload,
    contextType: "web",
    contextId: null,
    runEventSequenceNumber: null,
    runEventId: null,
    seqId,
    createdAt: "2026-10-14T00:00:00.000Z",
  };
}

function project(events: readonly ChatEventRow[], lastSeqId = 10) {
  return projectPiMemoryChatStage1Evidence({
    input: { schemaVersion: 1, threadId, sourceRunId, lastSeqId, events },
    threadId,
    sourceRunId,
    lastSeqId,
  });
}

describe("Memory-owned settled Chat input", () => {
  it("preserves user preferences and published answers through unused allocation gaps", () => {
    const evidence = project([
      row(1, "input.prompt", {
        userMessage: {
          version: 1,
          parts: [{ type: "text", text: "Use metric units for my reports." }],
        },
      }),
      row(2, "output.message", {
        content: "I will use metric units for future reports.",
      }),
      row(3, "run.completed", null),
    ]);
    expect(evidence).toEqual([
      { kind: "human", content: "Use metric units for my reports." },
      {
        kind: "assistant",
        content: "I will use metric units for future reports.",
      },
    ]);
  });

  it("excludes revoked messages and runtime feedback before extraction", () => {
    const revoked = row(1, "input.prompt", {
      userMessage: {
        version: 1,
        parts: [{ type: "text", text: "This preference was withdrawn." }],
      },
    });
    const revoke = {
      ...row(3, "control.revoke", null),
      revokesEventId: revoked.id,
    };
    expect(
      project([
        revoked,
        row(2, "input.prompt", {
          userMessage: {
            version: 1,
            parts: [
              {
                type: "text",
                text: "<environment_context>runtime values</environment_context>",
              },
            ],
          },
        }),
        revoke,
        row(4, "run.completed", null),
      ]),
    ).toEqual([]);
  });

  it("rejects another Thread and a source without its settled Run", () => {
    const foreign = {
      ...row(1, "run.completed", null),
      chatThreadId: sourceRunId,
    };
    expect(() => project([foreign])).toThrow("ordering mismatch");
    expect(() =>
      project([row(1, "output.message", { content: "Still running" })]),
    ).toThrow("not settled");
  });
});
