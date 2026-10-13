import { describe, expect, it } from "vitest";
import { mcpChatSearchContract } from "../mcp-chat-search";

describe("MCP chat search time filter", () => {
  it.each([
    "2026-10-12T08:02:50Z",
    "2026-10-12T16:02:50+08:00",
    "2026-10-12T08:02:50.1Z",
    "2026-10-12T08:02:50.12Z",
    "2026-10-12T08:02:50.123Z",
  ])(
    "accepts a timezone-qualified timestamp without changing it: %s",
    (since) => {
      expect(
        mcpChatSearchContract.search.query.parse({ keyword: "search", since }),
      ).toStrictEqual({ keyword: "search", since });
    },
  );

  it.each([
    1791792170,
    1791792170000,
    "1791792170000",
    "2026-10-12T08:02:50",
    "2026-02-30T08:02:50Z",
    "2026-10-12T08:02:50.0001Z",
    "2026-10-12T08:02:50+24:00",
    "2026-10-12T08:02Z",
  ])("rejects ambiguous or unsupported time input: %s", (since) => {
    expect(
      mcpChatSearchContract.search.query.safeParse({ keyword: "search", since })
        .success,
    ).toBe(false);
  });
});

describe("MCP chat search response", () => {
  it.each(["Okou", null])(
    "carries a stable Agent ID with display name %s",
    (displayName) => {
      const hit = {
        threadId: "22222222-2222-4222-8222-222222222222",
        agentId: "11111111-1111-4111-8111-111111111111",
        displayName,
        matchedMessage: {
          threadId: "22222222-2222-4222-8222-222222222222",
          role: "user" as const,
          content: "Searchable message",
          createdAt: "2026-10-12T08:00:00.000Z",
          seqId: 1,
          runId: null,
        },
        matchedRanges: [{ start: 0, end: 10 }],
      };

      expect(
        mcpChatSearchContract.search.responses[200].parse({ results: [hit] }),
      ).toStrictEqual({ results: [hit] });
      const { agentId: _agentId, ...missingId } = hit;
      expect(
        mcpChatSearchContract.search.responses[200].safeParse({
          results: [missingId],
        }).success,
      ).toBeFalsy();
    },
  );
});
