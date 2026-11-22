import { describe, expect, it } from "vitest";
import { mcpProjectChatSearchContract } from "../mcp-chat-search";

describe("MCP chat search response", () => {
  it.each(["Research", null])(
    "carries current Project membership with name %s",
    (projectName) => {
      const hit = {
        threadId: "22222222-2222-4222-8222-222222222222",
        projectId:
          projectName === null ? null : "11111111-1111-4111-8111-111111111111",
        projectName,
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
        mcpProjectChatSearchContract.search.responses[200].parse({
          results: [hit],
        }),
      ).toStrictEqual({ results: [hit] });
      const { projectId: _projectId, ...missingId } = hit;
      expect(
        mcpProjectChatSearchContract.search.responses[200].safeParse({
          results: [missingId],
        }).success,
      ).toBeFalsy();
    },
  );
});
