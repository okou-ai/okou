import { z } from "zod";
import { agentResponseSchema } from "./agents";
import { initContract } from "./base";
import { CHAT_SEARCH_RESULT_LIMIT, chatSearchContract } from "./chat-threads";
import { mcpRunIdSchema, mcpThreadIdSchema } from "./mcp-identifiers";

const c = initContract();
const nativeSearch = chatSearchContract.search;
const nativeResult = nativeSearch.responses[200].shape.results.element;

const mcpChatSearchResultSchema = nativeResult
  .omit({ agentName: true, chatThreadId: true })
  .extend({
    ...agentResponseSchema.pick({ agentId: true, displayName: true }).shape,
    threadId: mcpThreadIdSchema,
    matchedMessage: nativeResult.shape.matchedMessage
      .omit({ chatThreadId: true })
      .extend({
        threadId: mcpThreadIdSchema,
        runId: mcpRunIdSchema.nullable(),
      }),
  });

/** Used only by the MCP in-process route slice, not the public Web search API. */
export const mcpChatSearchContract = c.router({
  search: {
    ...nativeSearch,
    responses: {
      ...nativeSearch.responses,
      200: z.object({
        results: z
          .array(mcpChatSearchResultSchema)
          .max(CHAT_SEARCH_RESULT_LIMIT),
      }),
    },
    summary: "Search chat messages with canonical visible Agent metadata",
  },
});

export type McpChatSearchResult = z.infer<typeof mcpChatSearchResultSchema>;
export type McpChatSearchResponse = z.infer<
  (typeof mcpChatSearchContract.search.responses)[200]
>;
