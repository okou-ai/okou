import { z } from "zod";

import { chatThreadServiceTierSchema } from "./chat-threads";
import { mcpChatModelIdSchema } from "./mcp-chat-discovery";
import {
  mcpChatInputReceiptSchema,
  mcpChatMessageTextSchema,
} from "./mcp-chat-mutations";
import { mcpChatMessageSchema } from "./mcp-chat-messages";
import { mcpChatThreadSchema } from "./mcp-chat-threads";

const requestIdSchema = z.uuid().toLowerCase();
const agentIdSchema = z.uuid().toLowerCase();
const titleSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/\S/u, "Provide a nonblank title");

export const mcpCreateEmptyChatThreadInputSchema = z.strictObject({
  requestId: requestIdSchema,
  agentId: agentIdSchema,
  title: titleSchema,
  model: mcpChatModelIdSchema,
});

export const mcpCreateChatWithMessageInputSchema = z.strictObject({
  requestId: requestIdSchema,
  agentId: agentIdSchema.optional(),
  title: titleSchema,
  model: mcpChatModelIdSchema.optional(),
  message: mcpChatMessageTextSchema,
});

export const mcpCreateChatThreadInputSchema = z.union([
  mcpCreateEmptyChatThreadInputSchema,
  mcpCreateChatWithMessageInputSchema,
]);

const createOutputShape = {
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
} as const;

export const mcpCreateEmptyChatThreadOutputSchema = z.strictObject({
  ...createOutputShape,
  nextAction: z.strictObject({
    tool: z.literal("send_chat_message"),
    arguments: z.strictObject({ threadId: z.uuid() }),
  }),
});

export const mcpCreateChatWithMessageOutputSchema = z.strictObject({
  ...createOutputShape,
  input: mcpChatInputReceiptSchema,
  nextAction: z.strictObject({
    tool: z.literal("get_chat_status"),
    arguments: z.strictObject({
      threadId: z.uuid(),
      inputRef: mcpChatMessageSchema.shape.ref,
    }),
  }),
});

export const mcpCreateChatThreadOutputSchema = z.union([
  mcpCreateEmptyChatThreadOutputSchema,
  mcpCreateChatWithMessageOutputSchema,
]);

export type McpCreateChatThreadInput = z.infer<
  typeof mcpCreateChatThreadInputSchema
>;
export type McpCreateEmptyChatThreadInput = z.infer<
  typeof mcpCreateEmptyChatThreadInputSchema
>;
export type McpCreateChatWithMessageInput = z.infer<
  typeof mcpCreateChatWithMessageInputSchema
>;
export type McpCreateChatThreadOutput = z.infer<
  typeof mcpCreateChatThreadOutputSchema
>;
export type McpCreateEmptyChatThreadOutput = z.infer<
  typeof mcpCreateEmptyChatThreadOutputSchema
>;
export type McpCreateChatWithMessageOutput = z.infer<
  typeof mcpCreateChatWithMessageOutputSchema
>;
