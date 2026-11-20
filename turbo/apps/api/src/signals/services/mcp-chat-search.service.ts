import { computed, type Computed } from "ccstate";
import type {
  McpChatSearchQuery,
  McpChatSearchResponse,
} from "@okouai/api-contracts/contracts/mcp-chat-search";
import { chatSearch } from "./chat-search.service";

export function mcpChatSearch(
  args$: Computed<
    McpChatSearchQuery & {
      readonly userId: string;
      readonly orgId: string;
    }
  >,
): Computed<Promise<McpChatSearchResponse>> {
  const nativeSearch$ = chatSearch(
    computed((get) => {
      return { ...get(args$), projectMetadata: true };
    }),
  );
  return computed(async (get) => {
    const { results } = await get(nativeSearch$);
    return {
      results: results.map(
        ({
          projectId,
          projectName,
          chatThreadId,
          matchedMessage,
          matchedRanges,
        }) => {
          const { chatThreadId: messageThreadId, ...message } = matchedMessage;
          return {
            projectId,
            projectName,
            threadId: chatThreadId,
            matchedMessage: { ...message, threadId: messageThreadId },
            matchedRanges,
          };
        },
      ),
    };
  });
}
