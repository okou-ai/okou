import { describe, expect, it } from "vitest";
import { mcpChatSearchContract } from "../mcp-chat-search";

describe("MCP chat search response", () => {
  it.each(["Okou", null])(
    "carries a stable Agent ID with display name %s",
    (agentDisplayName) => {
      const hit = {
        chatThreadId: "thread-1",
        agentId: "11111111-1111-4111-8111-111111111111",
        agentDisplayName,
        matchedMessage: {
          chatThreadId: "thread-1",
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
