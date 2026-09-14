import { describe, expect, it } from "vitest";

import type { EventConsumerPayload } from "../../../lib/event-consumer/verify";
import { normalizeRunOutputEvents } from "../pi-memory-citation-events";

const citation = {
  entries: [{ path: "memory.md", lineStart: 1, lineEnd: 2, note: "used" }],
  rolloutIds: ["019c6e27-e55b-73d1-87d8-4e01f1f75043"],
} as const;
const envelope = `<oai-mem-citation><citation_entries>memory.md:1-2|note=[used]</citation_entries><rollout_ids>${citation.rolloutIds[0]}</rollout_ids></oai-mem-citation>`;

function payload(events: EventConsumerPayload["events"]): EventConsumerPayload {
  return {
    runId: "00000000-0000-4000-8000-000000000001",
    events,
    context: { userId: "user", orgId: "org" },
  };
}

describe("Pi run output normalization privacy boundary", () => {
  it("deduplicates a terminal citation by semantic fields, not object key order", () => {
    const normalized = normalizeRunOutputEvents(
      payload([
        {
          type: "assistant",
          sequenceNumber: 3,
          message: {
            content: [{ type: "text", text: "visible" }],
            memoryCitation: {
              entries: [
                {
                  path: "memory.md",
                  note: "used",
                  lineStart: 1,
                  lineEnd: 2,
                },
              ],
              rolloutIds: citation.rolloutIds,
            },
          },
        },
        {
          type: "result",
          sequenceNumber: 4,
          result: "visible",
          memoryCitation: citation,
        },
      ]),
    );

    expect(normalized.citations).toStrictEqual([
      { sequenceNumber: 3, citation },
    ]);
  });

  it("leaves non-Pi citation-like text byte-for-byte unchanged", () => {
    const event = {
      type: "assistant",
      sequenceNumber: 1,
      message: { content: [{ type: "text", text: `literal ${envelope}` }] },
    } as const;
    const normalized = normalizeRunOutputEvents(payload([event]));

    expect(normalized.payload.events[0]).toBe(event);
    expect(normalized.citations).toStrictEqual([]);
  });
});
