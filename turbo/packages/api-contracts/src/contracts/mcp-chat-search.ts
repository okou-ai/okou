import { z } from "zod";

import { mcpChatMessageSchema } from "./mcp-chat-messages";
import { mcpFilterTimestampSchema, mcpTimestampKey } from "./mcp-chat-threads";

export const mcpSearchChatMessagesInputSchema = z
  .strictObject({
    query: z.string().trim().min(1).max(200),
    threadId: z.uuid().optional(),
    agentId: z.uuid().optional(),
    role: z.enum(["user", "assistant"]).optional(),
    since: mcpFilterTimestampSchema.optional(),
    before: mcpFilterTimestampSchema.optional(),
    limit: z.number().int().min(1).max(50).default(20),
    cursor: z.string().min(1).max(4096).optional(),
  })
  .refine(
    (input) => {
      return (
        !input.since ||
        !input.before ||
        mcpTimestampKey(input.since) < mcpTimestampKey(input.before)
      );
    },
    { message: "since must be earlier than before" },
  );

const searchMatchSchema = z.strictObject({
  ref: mcpChatMessageSchema.shape.ref,
  threadTitle: z.string().max(1000).nullable(),
  titleTruncated: z.boolean(),
  agent: z.strictObject({ agentId: z.uuid(), name: z.string().max(512) }),
  role: z.enum(["user", "assistant"]),
  runId: z.string().nullable(),
  createdAt: z.iso.datetime(),
  excerpt: z.strictObject({
    text: z.string().max(1000),
    offset: z.number().int().nonnegative(),
    hasBefore: z.boolean(),
    hasAfter: z.boolean(),
  }),
  url: z.url(),
});

export const mcpSearchChatMessagesOutputSchema = z.strictObject({
  matches: z.array(searchMatchSchema).max(50),
  nextCursor: z.string().nullable(),
  scanLimited: z.boolean(),
});

export type McpSearchChatMessagesInput = z.infer<
  typeof mcpSearchChatMessagesInputSchema
>;
export type McpSearchChatMessagesOutput = z.infer<
  typeof mcpSearchChatMessagesOutputSchema
>;
export type McpChatSearchMatch = z.infer<typeof searchMatchSchema>;
export type McpChatSearchResult =
  | { readonly kind: "ok"; readonly data: McpSearchChatMessagesOutput }
  | {
      readonly kind:
        | "invalid_cursor"
        | "invalid_query"
        | "search_limit"
        | "search_unavailable";
      readonly message: string;
    };
