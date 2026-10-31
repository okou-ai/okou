import { array, iso, object, type infer as zInfer } from "zod";

import { agentResponseSchema } from "../validators/agents";
import { initContract } from "./base";
import { CHAT_SEARCH_RESULT_LIMIT, chatSearchContract } from "./chat-threads";
import { mcpRunIdSchema, mcpThreadIdSchema } from "./mcp-identifiers";

const c = initContract();
const nativeSearch = chatSearchContract.search;
const nativeResult = nativeSearch.responses[200].shape.results.element;
const nativeRange = nativeResult.shape.matchedRanges.element;

// Extra fractional precision would silently truncate when converted to Date.
const mcpSearchSinceSchema = iso
  .datetime({ offset: true })
  .regex(
    /T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/,
    "Use seconds, at most three fractional digits, and Z or a ±HH:MM timezone",
  )
  .meta({ format: "date-time" })
  .describe(
    "Inclusive lower bound: matchedMessage.createdAt >= since. Use an ISO 8601 datetime with seconds, at most three fractional digits, and an explicit Z or ±HH:MM timezone, for example 2026-10-12T08:02:50Z. Omit to search without a time filter.",
  );

const mcpChatSearchResultSchema = nativeResult
  .omit({ agentName: true, chatThreadId: true })
  .extend({
    ...agentResponseSchema.pick({ agentId: true, displayName: true }).shape,
    threadId: mcpThreadIdSchema,
    matchedRanges: array(
      nativeRange.extend({
        start: nativeRange.shape.start.describe(
          "Inclusive start offset in UTF-16 code units within matchedMessage.content.",
        ),
        end: nativeRange.shape.end.describe(
          "Exclusive end offset in UTF-16 code units within matchedMessage.content.",
        ),
      }),
    ).describe(
      "Highlight [start,end) intervals in matchedMessage.content, measured in UTF-16 code units, not code points, grapheme clusters or UTF-8 bytes. JavaScript can use content.slice(start,end). Example: 中文 in ACK-QA-A1-🧪-中文 has [13,15). For code-point or UTF-8 byte indexing, translate both UTF-16 boundaries before slicing. Ranges can split a displayed grapheme; apply them to the unchanged returned content.",
    ),
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
    query: nativeSearch.query.extend({
      keyword: nativeSearch.query.shape.keyword.describe(
        "Lexical search: CJK runs use adjacent two-character (bigram) tokens; any single-character CJK run returns no results, including in mixed queries. Other letter/number runs match whole-word tokens after lowercasing; token groups are combined with AND. Non-token characters such as emoji and punctuation are ignored; queries with no indexable tokens return no results. For example, 中文 🧪 searches 中文, and 1️⃣ contributes the digit 1. No Unicode normalization, semantic matching or general substring guarantee.",
      ),
      since: mcpSearchSinceSchema.optional(),
    }),
    responses: {
      ...nativeSearch.responses,
      200: object({
        results: array(mcpChatSearchResultSchema).max(CHAT_SEARCH_RESULT_LIMIT),
      }),
    },
    summary: "Search chat messages with canonical visible Agent metadata",
  },
});

export type McpChatSearchQuery = zInfer<
  typeof mcpChatSearchContract.search.query
>;
export type McpChatSearchResult = zInfer<typeof mcpChatSearchResultSchema>;
export type McpChatSearchResponse = zInfer<
  (typeof mcpChatSearchContract.search.responses)[200]
>;
