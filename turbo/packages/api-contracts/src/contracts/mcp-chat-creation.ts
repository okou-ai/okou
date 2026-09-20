import { z } from "zod";

import { chatThreadServiceTierSchema } from "./chat-threads";
import { mcpChatThreadSchema } from "./mcp-chat-threads";

export const mcpCreateChatThreadInputSchema = z.strictObject({
  requestId: z.uuid().toLowerCase(),
  agentId: z.uuid().toLowerCase(),
  title: z
    .string()
    .min(1)
    .max(200)
    .refine((title) => {
      return title.trim().length > 0;
    }, "Provide a nonblank title"),
  model: z.string().min(1).max(255),
});

export const mcpCreateChatThreadOutputSchema = z.strictObject({
  threadId: z.uuid(),
  agentId: z.uuid(),
  title: z.string().max(1000).nullable(),
  titleTruncated: z.boolean(),
  model: mcpChatThreadSchema.shape.model,
  serviceTier: chatThreadServiceTierSchema.nullable(),
  createdAt: z.iso.datetime(),
  url: z.url(),
  replayed: z.boolean(),
  retryUntil: z.iso.datetime(),
  nextAction: z.strictObject({
    tool: z.literal("send_chat_message"),
    arguments: z.strictObject({ threadId: z.uuid() }),
  }),
});

export type McpCreateChatThreadInput = z.infer<
  typeof mcpCreateChatThreadInputSchema
>;
export type McpCreateChatThreadOutput = z.infer<
  typeof mcpCreateChatThreadOutputSchema
>;
