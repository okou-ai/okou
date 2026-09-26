import { z } from "zod";

import { indicatorsSchema } from "./chat-threads";
import {
  mcpChatOutputTimestampSchema,
  mcpFilterTimestampSchema,
  mcpTimestampKey,
} from "./mcp-chat-time";

export const mcpListChatThreadsInputSchema = z
  .strictObject({
    agentId: z.uuid().optional(),
    title: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/\S/u, "Provide a nonblank title")
      .optional(),
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

export const mcpGetChatThreadInputSchema = z.strictObject({
  threadId: z.uuid(),
});

export const mcpChatThreadSchema = z.strictObject({
  threadId: z.uuid(),
  title: z.string().max(1000).nullable(),
  titleTruncated: z.boolean(),
  agent: z.strictObject({
    agentId: z.uuid(),
    name: z.string().max(512),
  }),
  model: z.strictObject({
    selectedModel: z.string().nullable(),
    effectiveModel: z.string().nullable(),
    source: z.enum(["thread", "member_default", "org_default"]).nullable(),
    admission: z.literal("checked_on_send"),
  }),
  createdAt: mcpChatOutputTimestampSchema,
  metadataUpdatedAt: mcpChatOutputTimestampSchema,
  lastMessageAt: mcpChatOutputTimestampSchema,
  url: z.url(),
});

export const mcpListChatThreadsOutputSchema = z.strictObject({
  threads: z.array(mcpChatThreadSchema).max(50),
  nextCursor: z.string().nullable(),
});

export const mcpGetChatThreadOutputSchema = z.strictObject({
  thread: mcpChatThreadSchema,
});

export const mcpGetChatIndicatorsInputSchema = z.strictObject({});
export const mcpGetChatIndicatorsOutputSchema = indicatorsSchema;

export type McpListChatThreadsInput = z.infer<
  typeof mcpListChatThreadsInputSchema
>;
export type McpGetChatThreadInput = z.infer<typeof mcpGetChatThreadInputSchema>;
export type McpGetChatIndicatorsOutput = z.infer<
  typeof mcpGetChatIndicatorsOutputSchema
>;
export type McpChatThread = z.infer<typeof mcpChatThreadSchema>;
export type McpListChatThreadsOutput = z.infer<
  typeof mcpListChatThreadsOutputSchema
>;
export type McpGetChatThreadOutput = z.infer<
  typeof mcpGetChatThreadOutputSchema
>;

export type McpThreadReadResult<T> =
  | { readonly kind: "ok"; readonly data: T }
  | {
      readonly kind: "invalid_cursor" | "not_found";
      readonly message: string;
    };
