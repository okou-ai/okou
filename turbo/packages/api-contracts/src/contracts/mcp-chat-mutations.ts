import { z } from "zod";
import { chatEventsContract } from "./chat-threads";
import { mcpChatModelIdSchema } from "./mcp-chat-discovery";

/** MCP adapts plain text to Web acceptance; each send is new intended work. */
export const mcpSendChatMessageInputSchema = z.strictObject({
  agentId: z.uuid().toLowerCase(),
  prompt: z.string().max(32_000).regex(/\S/u, "Prompt must not be blank"),
  threadId: z.uuid().toLowerCase().optional(),
  model: mcpChatModelIdSchema.optional(),
});
const inputAcknowledgementShape = {
  threadId: z.uuid(),
  eventId: z.uuid(),
  createdAt: chatEventsContract.send.responses[201].shape.createdAt.unwrap(),
};
/** Correlation identity, not a Run or an idempotent-send receipt. */
export const mcpSendChatMessageOutputSchema = z.strictObject(
  inputAcknowledgementShape,
);

export const mcpRevokeQueuedMessageInputSchema = z.strictObject({
  agentId: z.uuid().toLowerCase(),
  threadId: z.uuid().toLowerCase(),
  eventId: z.uuid().toLowerCase(),
});
export const mcpRevokeQueuedMessageOutputSchema = z.strictObject(
  inputAcknowledgementShape,
);

export const mcpCancelRunInputSchema = z.strictObject({
  runId: z.uuid().toLowerCase(),
});
export const mcpCancelRunOutputSchema = z.strictObject({
  runId: z.uuid(),
  status: z.literal("cancelled"),
  alreadyCancelled: z.boolean(),
});
export type McpSendChatMessageInput = z.infer<
  typeof mcpSendChatMessageInputSchema
>;
export type McpSendChatMessageOutput = z.infer<
  typeof mcpSendChatMessageOutputSchema
>;
export type McpRevokeQueuedMessageInput = z.infer<
  typeof mcpRevokeQueuedMessageInputSchema
>;
export type McpRevokeQueuedMessageOutput = z.infer<
  typeof mcpRevokeQueuedMessageOutputSchema
>;
export type McpCancelRunInput = z.infer<typeof mcpCancelRunInputSchema>;
export type McpCancelRunOutput = z.infer<typeof mcpCancelRunOutputSchema>;
export type McpChatMutationResult<T> =
  | { readonly kind: "ok"; readonly data: T }
  | {
      readonly kind: "error";
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
    };
