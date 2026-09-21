import { z } from "zod";

export const mcpChatInputRefSchema = z.strictObject({
  threadId: z.uuid().toLowerCase(),
  eventId: z.uuid().toLowerCase(),
  seqId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export const mcpGetChatStatusNextActionSchema = z.strictObject({
  tool: z.literal("get_chat_status"),
  arguments: z.strictObject({ inputRef: mcpChatInputRefSchema }),
});

export type McpChatInputRef = z.infer<typeof mcpChatInputRefSchema>;
export type McpGetChatStatusNextAction = z.infer<
  typeof mcpGetChatStatusNextActionSchema
>;
