import { z } from "zod";

import { mcpGetChatMessagesOutputSchema } from "./mcp-chat-messages";

const inputReferenceSchema = z.strictObject({
  threadId: z.uuid().toLowerCase(),
  eventId: z.uuid().toLowerCase(),
  seqId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

const activeLifecycleOutputSchema = z.enum(["pending", "partial"]);
const terminalRunOutcomes = [
  "completed",
  "failed",
  "timeout",
  "cancelled",
] as const;
const terminalRunOutcomeSchema = z.enum(terminalRunOutcomes);

export const mcpChatLifecycleSchema = z.union([
  z.strictObject({
    phase: z.literal("idle"),
    outcome: z.null(),
    output: z.literal("none"),
  }),
  z.strictObject({
    phase: z.literal("queued"),
    outcome: z.null(),
    output: activeLifecycleOutputSchema,
  }),
  z.strictObject({
    phase: z.literal("running"),
    outcome: z.null(),
    output: activeLifecycleOutputSchema,
  }),
  z.strictObject({
    phase: z.literal("finalizing"),
    outcome: terminalRunOutcomeSchema,
    output: activeLifecycleOutputSchema,
  }),
  z.strictObject({
    phase: z.literal("settled"),
    outcome: terminalRunOutcomeSchema,
    output: z.literal("ready"),
  }),
  z.strictObject({
    phase: z.literal("settled"),
    outcome: z.enum([...terminalRunOutcomes, "rejected", "revoked"]),
    output: z.literal("none"),
  }),
  z.strictObject({
    phase: z.literal("unavailable"),
    outcome: z.null(),
    output: z.literal("unavailable"),
  }),
]);

export const mcpGetChatStatusInputSchema = z
  .strictObject({
    threadId: z.uuid().toLowerCase(),
    inputRef: inputReferenceSchema.optional(),
    waitMs: z.number().int().nonnegative().max(60_000).optional(),
  })
  .superRefine((input, context) => {
    if (input.inputRef && input.inputRef.threadId !== input.threadId) {
      context.addIssue({
        code: "custom",
        path: ["inputRef", "threadId"],
        message: "inputRef must belong to threadId",
      });
    }
    if (input.waitMs !== undefined && input.waitMs > 0 && !input.inputRef) {
      context.addIssue({
        code: "custom",
        path: ["inputRef"],
        message: "A positive waitMs requires the exact original inputRef",
      });
    }
  });

export const mcpGetChatStatusOutputSchema = z.strictObject({
  threadId: z.uuid(),
  observedAt: z.iso.datetime(),
  lifecycle: mcpChatLifecycleSchema,
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
  wait: z
    .strictObject({
      requestedMs: z.number().int().positive(),
      effectiveMs: z.number().int().positive(),
      elapsedMs: z.number().int().nonnegative(),
      observations: z.number().int().positive().max(5),
      outcome: z.enum(["ready", "deadline", "status"]),
      returnReason: z.enum([
        "output_ready",
        "application_deadline",
        "non_retryable_state",
        "waiter_limit",
        "observation_limit",
      ]),
    })
    .nullable(),
  messagePage: mcpGetChatMessagesOutputSchema.nullable(),
  retryAfterMs: z.number().int().positive().nullable(),
});

export type McpGetChatStatusInput = z.infer<typeof mcpGetChatStatusInputSchema>;
export type McpChatLifecycle = z.infer<typeof mcpChatLifecycleSchema>;
export type McpGetChatStatusOutput = z.infer<
  typeof mcpGetChatStatusOutputSchema
>;
export type McpChatStatusResult =
  | { readonly kind: "ok"; readonly data: McpGetChatStatusOutput }
  | {
      readonly kind: "not_found" | "history_limit" | "history_unavailable";
      readonly message: string;
    };
