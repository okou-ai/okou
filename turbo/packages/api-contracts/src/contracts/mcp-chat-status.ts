import { z } from "zod";

import { mcpChatMessageSchema } from "./mcp-chat-messages";
import { runStatusSchema } from "./runs";

const inputReferenceSchema = z.strictObject({
  threadId: z.uuid().toLowerCase(),
  eventId: z.uuid().toLowerCase(),
  seqId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export const mcpGetChatStatusInputSchema = z
  .strictObject({
    threadId: z.uuid().toLowerCase(),
    inputRef: inputReferenceSchema.optional(),
  })
  .refine(
    (input) => {
      return !input.inputRef || input.inputRef.threadId === input.threadId;
    },
    { message: "inputRef must belong to threadId" },
  );

export const mcpGetChatStatusOutputSchema = z.strictObject({
  threadId: z.uuid(),
  observedAt: z.iso.datetime(),
  input: z
    .strictObject({
      ref: inputReferenceSchema,
      state: z.enum([
        "queued",
        "reserved",
        "associated",
        "delivered",
        "rejected",
        "revoked",
        "unavailable",
      ]),
      deliveryMode: z.enum(["launch", "steer", "unknown"]),
      runId: z.uuid().nullable(),
      visibleMessageRef: mcpChatMessageSchema.shape.ref.nullable(),
    })
    .nullable(),
  runSelection: z.enum(["input", "latest"]),
  run: z
    .strictObject({
      id: z.uuid(),
      status: runStatusSchema,
      createdAt: z.iso.datetime(),
      startedAt: z.iso.datetime().nullable(),
      completedAt: z.iso.datetime().nullable(),
      cancellationRecovery: z.enum(["pending", "complete", "not_applicable"]),
    })
    .nullable(),
  output: z.strictObject({
    state: z.enum(["pending", "partial", "ready", "unavailable"]),
    messageRefs: z.array(mcpChatMessageSchema.shape.ref).max(20),
    hasMore: z.boolean(),
    reason: z
      .enum(["no_associated_run", "run_unavailable", "no_output"])
      .nullable(),
  }),
  messages: z
    .strictObject({
      tool: z.literal("get_chat_messages"),
      arguments: z.strictObject({
        threadId: z.uuid(),
        runId: z.uuid(),
        limit: z.literal(20),
      }),
    })
    .nullable(),
  retryAfterMs: z.number().int().positive().nullable(),
});

export type McpGetChatStatusInput = z.infer<typeof mcpGetChatStatusInputSchema>;
export type McpGetChatStatusOutput = z.infer<
  typeof mcpGetChatStatusOutputSchema
>;
export type McpChatStatusResult =
  | { readonly kind: "ok"; readonly data: McpGetChatStatusOutput }
  | {
      readonly kind: "not_found" | "history_limit" | "history_unavailable";
      readonly message: string;
    };
