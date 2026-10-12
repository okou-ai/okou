import { z } from "zod";
import { agentResponseSchema } from "./agents";
import { initContract } from "./base";
import { CHAT_SEARCH_RESULT_LIMIT, chatSearchContract } from "./chat-threads";

const c = initContract();
const nativeSearch = chatSearchContract.search;

const mcpChatSearchResultSchema =
  nativeSearch.responses[200].shape.results.element
    .omit({ agentName: true })
    .extend({
      agentId: agentResponseSchema.shape.agentId.describe(
        "Stable Agent ID, matching list_agents.agentId",
      ),
      agentDisplayName: agentResponseSchema.shape.displayName.describe(
        "Canonical display name, matching list_agents.displayName; null when unset",
      ),
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
