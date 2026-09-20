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

const mcpGetChatStatusOutputObjectSchema = z.strictObject({
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

type ChatStatusOutputValue = z.infer<typeof mcpGetChatStatusOutputObjectSchema>;
type ChatStatusWait = NonNullable<ChatStatusOutputValue["wait"]>;

interface ChatStatusCoherenceIssue {
  readonly path: (string | number)[];
  readonly message: string;
}

function isRetryableLifecycle(
  lifecycle: ChatStatusOutputValue["lifecycle"],
): boolean {
  return (
    lifecycle.phase === "queued" ||
    lifecycle.phase === "running" ||
    lifecycle.phase === "finalizing"
  );
}

function lifecycleRequiresRun(
  lifecycle: ChatStatusOutputValue["lifecycle"],
): boolean {
  return (
    (lifecycle.phase === "queued" && lifecycle.output === "partial") ||
    lifecycle.phase === "running" ||
    lifecycle.phase === "finalizing" ||
    (lifecycle.phase === "settled" &&
      lifecycle.outcome !== "rejected" &&
      lifecycle.outcome !== "revoked")
  );
}

function lifecycleForbidsRun(
  lifecycle: ChatStatusOutputValue["lifecycle"],
): boolean {
  return (
    lifecycle.phase === "idle" ||
    lifecycle.phase === "unavailable" ||
    (lifecycle.phase === "settled" &&
      (lifecycle.outcome === "rejected" || lifecycle.outcome === "revoked"))
  );
}

function coreStatusCoherenceIssues(
  status: ChatStatusOutputValue,
): ChatStatusCoherenceIssue[] {
  const issues: ChatStatusCoherenceIssue[] = [];
  const retryable = isRetryableLifecycle(status.lifecycle);
  if (retryable !== (status.retryAfterMs !== null)) {
    issues.push({
      path: ["retryAfterMs"],
      message:
        "retryAfterMs must be present exactly while lifecycle remains retryable",
    });
  }
  if (lifecycleRequiresRun(status.lifecycle) && status.messages === null) {
    issues.push({
      path: ["messages"],
      message: "messages must identify the run required by lifecycle",
    });
  }
  if (lifecycleForbidsRun(status.lifecycle) && status.messages !== null) {
    issues.push({
      path: ["messages"],
      message: "messages must be null when lifecycle has no selected run",
    });
  }
  if (
    status.messages !== null &&
    status.messages.arguments.threadId !== status.threadId
  ) {
    issues.push({
      path: ["messages", "arguments", "threadId"],
      message: "messages must belong to the status threadId",
    });
  }
  return issues;
}

function waitReasonMatchesOutcome(wait: ChatStatusWait): boolean {
  switch (wait.outcome) {
    case "ready": {
      return wait.returnReason === "output_ready";
    }
    case "deadline": {
      return wait.returnReason === "application_deadline";
    }
    case "status": {
      return (
        wait.returnReason === "non_retryable_state" ||
        wait.returnReason === "waiter_limit" ||
        wait.returnReason === "observation_limit"
      );
    }
  }
}

function waitReasonRequiresRetryable(
  reason: ChatStatusWait["returnReason"],
): boolean {
  return (
    reason === "application_deadline" ||
    reason === "waiter_limit" ||
    reason === "observation_limit"
  );
}

function waitStatusCoherenceIssues(
  status: ChatStatusOutputValue,
): ChatStatusCoherenceIssue[] {
  const issues: ChatStatusCoherenceIssue[] = [];
  const waitReturnsReady = status.wait?.returnReason === "output_ready";
  if (waitReturnsReady !== (status.messagePage !== null)) {
    issues.push({
      path: ["messagePage"],
      message:
        "messagePage must be present exactly when wait returns ready output",
    });
  }
  if (!status.wait) {
    return issues;
  }
  if (status.messagePage?.messages.length === 0) {
    issues.push({
      path: ["messagePage", "messages"],
      message: "ready messagePage must contain readable output",
    });
  }
  if (status.messagePage && status.messages) {
    if (status.messagePage.messages.length > status.messages.arguments.limit) {
      issues.push({
        path: ["messagePage", "messages"],
        message: "messagePage must honor the handoff message limit",
      });
    }
    for (const [index, message] of status.messagePage.messages.entries()) {
      if (message.ref.threadId !== status.threadId) {
        issues.push({
          path: ["messagePage", "messages", index, "ref", "threadId"],
          message: "messagePage messages must belong to the status threadId",
        });
      }
      if (message.runId !== status.messages.arguments.runId) {
        issues.push({
          path: ["messagePage", "messages", index, "runId"],
          message: "messagePage messages must belong to the handoff runId",
        });
      }
    }
  }
  if (!waitReasonMatchesOutcome(status.wait)) {
    issues.push({
      path: ["wait", "returnReason"],
      message: "wait returnReason does not match its outcome",
    });
  }
  if (
    status.wait.returnReason === "output_ready" &&
    status.lifecycle.output !== "ready"
  ) {
    issues.push({
      path: ["wait", "returnReason"],
      message: "output_ready requires ready lifecycle output",
    });
  }
  const retryable = isRetryableLifecycle(status.lifecycle);
  if (status.wait.returnReason === "non_retryable_state" && retryable) {
    issues.push({
      path: ["wait", "returnReason"],
      message: "non_retryable_state requires a non-retryable lifecycle",
    });
  }
  if (waitReasonRequiresRetryable(status.wait.returnReason) && !retryable) {
    issues.push({
      path: ["wait", "returnReason"],
      message: `${status.wait.returnReason} requires a retryable lifecycle`,
    });
  }
  return issues;
}

export const mcpGetChatStatusOutputSchema =
  mcpGetChatStatusOutputObjectSchema.superRefine((status, context) => {
    const issues = [
      ...coreStatusCoherenceIssues(status),
      ...waitStatusCoherenceIssues(status),
    ];
    for (const issue of issues) {
      context.addIssue({ code: "custom", ...issue });
    }
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
