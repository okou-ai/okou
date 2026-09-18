import { z } from "zod";

import { mcpChatMessageSchema } from "./mcp-chat-messages";

export const mcpSendChatMessageInputSchema = z.strictObject({
  threadId: z.uuid().toLowerCase(),
  text: z
    .string()
    .max(32_000)
    .refine(
      (text) => {
        return text.trim().length > 0;
      },
      {
        message: "Message text must not be blank",
      },
    ),
  requestId: z.uuid().toLowerCase(),
});

export const mcpSendChatMessageOutputSchema = z.strictObject({
  inputRef: mcpChatMessageSchema.shape.ref,
  acceptedAt: z.iso.datetime(),
  retryUntil: z.iso.datetime(),
  replayed: z.boolean(),
  disposition: z.enum([
    "queued",
    "reserved",
    "associated",
    "rejected",
    "revoked",
    "unavailable",
  ]),
  runId: z.uuid().nullable(),
  url: z.url(),
});

export const mcpRevokeQueuedMessageInputSchema = z.strictObject({
  threadId: z.uuid().toLowerCase(),
  inputId: z.uuid().toLowerCase(),
});

export const mcpRevokeQueuedMessageOutputSchema = z.strictObject({
  threadId: z.uuid(),
  inputId: z.uuid(),
  outcome: z.enum([
    "revoked",
    "already_revoked",
    "not_revocable",
    "unavailable",
  ]),
  runId: z.uuid().nullable(),
  reason: z.enum(["reserved_or_associated", "not_queued"]).optional(),
});

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
  | { readonly kind: "error"; readonly message: string };
