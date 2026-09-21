import { z } from "zod";

import {
  mcpChatInputRefSchema,
  mcpGetChatStatusNextActionSchema,
} from "./mcp-chat-references";

export const mcpChatMessageTextSchema = z
  .string()
  .max(32_000)
  .regex(/\S/u, "Message text must not be blank");

export const mcpSendChatMessageInputSchema = z.strictObject({
  threadId: z.uuid().toLowerCase(),
  text: mcpChatMessageTextSchema,
  requestId: z.uuid().toLowerCase(),
});

export const mcpChatInputReceiptSchema = z.strictObject({
  inputRef: mcpChatInputRefSchema,
  acceptedAt: z.iso.datetime(),
  retryUntil: z.iso.datetime(),
  disposition: z.enum([
    "queued",
    "reserved",
    "associated",
    "rejected",
    "revoked",
    "unavailable",
  ]),
  runId: z.uuid().nullable(),
});

export const mcpSendChatMessageOutputSchema = mcpChatInputReceiptSchema.extend({
  replayed: z.boolean(),
  url: z.url(),
  nextAction: mcpGetChatStatusNextActionSchema,
});

export const mcpRevokeQueuedMessageInputSchema = z.strictObject({
  inputRef: mcpChatInputRefSchema,
});

export const mcpRevokeQueuedMessageOutputSchema = z.strictObject({
  inputRef: mcpChatInputRefSchema,
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
  | {
      readonly kind: "error";
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
    };
