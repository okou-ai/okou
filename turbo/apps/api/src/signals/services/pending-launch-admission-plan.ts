import { z } from "zod";
import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  notExists,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import {
  chatEvents,
  chatEventRunlessInputPredicate,
} from "@okouai/db/schema/chat-event";
import { modelProviderAccounts } from "@okouai/db/schema/model-provider-account";
import { chatEventContextTypeSchema } from "@okouai/api-contracts/contracts/chat-events";
import { chatInputModelSelectionSchema } from "@okouai/api-contracts/contracts/chat-input-model";
import { userMessageDocumentSchema } from "@okouai/api-contracts/contracts/chat-threads";
import { pgTimestampWithoutTimezoneToDateSchema } from "../../lib/db-raw-rows";
import { conflict } from "../../lib/error";
import { isPersonalSubscriptionProviderType } from "./model-provider-account.service";
import { personalSubscriptionAccountIdentity } from "./personal-subscription-recovery.service";
import {
  canonicalChatEventUserMessage,
  canonicalChatInputModelSelection,
} from "./canonical-chat-event-read.service";
import { chatEventReplacementInsertSql } from "./chat-event.service";
import { chatEventCommandResultSchema } from "./chat-event-append.service";
import { withRunModelAnnotation } from "./chat-user-message.service";
import type { PreparedCommitPreparedLaunchArgs } from "./thread-claim-run.service";

interface ValidatedPendingThreadSession {
  readonly kind: "validated-thread-session-snapshot";
  readonly chatThreadId: string;
  readonly threadAgentId: string | null;
  readonly agentSessionId: string | null;
  readonly agentSessionRunId: string | null;
}

interface AdmissionFacts {
  readonly validatedThreadSession: ValidatedPendingThreadSession | undefined;
  readonly validatedAccountIdentity: string | null;
}

const readRecordSchema = z.discriminatedUnion("phase", [
  z.object({
    phase: z.literal("thread"),
    threadAgentId: z.string().nullable(),
    agentSessionId: z.string().nullable(),
    agentSessionRunId: z.string().nullable(),
  }),
  z.object({
    phase: z.literal("session"),
    conversationId: z.string().nullable(),
  }),
  z.object({
    phase: z.literal("subscription"),
    type: z.string(),
    externalAccountId: z.string().nullable(),
    accountEmail: z.string().nullable(),
    workspaceName: z.string().nullable(),
  }),
  z.object({
    phase: z.literal("head"),
    id: z.string(),
    chatThreadId: z.string(),
    createdAt: pgTimestampWithoutTimezoneToDateSchema,
    eventType: z.enum(["input.prompt", "input.automation"]),
    contextType: chatEventContextTypeSchema.nullable(),
    contextId: z.string().nullable(),
    userMessage: userMessageDocumentSchema.nullable(),
    modelSelection: chatInputModelSelectionSchema.nullable(),
  }),
]);
export const pendingAdmissionRecordSchema = z.union([
  readRecordSchema,
  chatEventCommandResultSchema,
]);
type AdmissionRecord = z.output<typeof pendingAdmissionRecordSchema>;

type AdmissionStatement = AdmissionFacts & {
  readonly kind: "statement";
  readonly phase: "thread" | "session" | "subscription" | "head" | "claim";
  readonly sql: SQL;
};
type Admitted = AdmissionFacts & {
  readonly kind: "admitted";
  readonly queueFirstClaim:
    | { readonly kind: "claimed"; readonly createdAt: Date }
    | undefined;
};
export type PendingAdmissionProgress =
  | AdmissionStatement
  | Admitted
  | { readonly kind: "queue-first-claim-lost" }
  | (ReturnType<typeof conflict> & {
      readonly admissionFailure?: "subscription_account_disconnected";
    });

/** Pure finite SQL plan: thread -> session -> subscription -> head -> claim.
 * Each phase occurs at most once. No retries, resources, callbacks or handles. */
export function pendingLaunchAdmissionStart(
  args: PreparedCommitPreparedLaunchArgs,
): PendingAdmissionProgress {
  const facts: AdmissionFacts = {
    validatedThreadSession: undefined,
    validatedAccountIdentity: null,
  };
  const threadId = args.createArgs.chatThreadId;
  const resolution = args.createArgs.threadSessionResolution;
  if (threadId && resolution) {
    const captured: AdmissionFacts = {
      ...facts,
      validatedThreadSession: {
        kind: "validated-thread-session-snapshot",
        chatThreadId: threadId,
        threadAgentId: resolution.expected.threadAgentId,
        agentSessionId: resolution.expected.agentSessionId,
        agentSessionRunId: resolution.expected.agentSessionRunId,
      },
    };
    // The atomic binding CAS fences both captured thread columns. Keep the
    // separate session/conversation lock; it protects a different row.
    const sessionId = resolution.expected.sessionId;
    return sessionId === null
      ? subscriptionStep(args, captured)
      : {
          ...captured,
          kind: "statement",
          phase: "session",
          sql: sql`SELECT 'session' AS phase, ${agentSessions.conversationId} AS "conversationId"
        FROM ${agentSessions} WHERE ${eq(agentSessions.id, sessionId)} LIMIT 1 FOR UPDATE`,
        };
  }
  return threadId
    ? {
        ...facts,
        kind: "statement",
        phase: "thread",
        sql: sql`SELECT 'thread' AS phase, ${chatThreads.agentId} AS "threadAgentId", ${chatThreads.agentSessionId} AS "agentSessionId", ${chatThreads.agentSessionRunId} AS "agentSessionRunId"
      FROM ${chatThreads} WHERE ${eq(chatThreads.id, threadId)} LIMIT 1`,
      }
    : subscriptionStep(args, facts);
}

function subscriptionStep(
  args: PreparedCommitPreparedLaunchArgs,
  facts: AdmissionFacts,
): PendingAdmissionProgress {
  const provider = args.context.modelProvider;
  if (
    !provider ||
    !isPersonalSubscriptionProviderType(provider.type) ||
    provider.credentialOwner !== "member"
  ) {
    return queueHeadStep(args, facts);
  }
  if (!provider.id) {
    return disconnectedSubscription();
  }
  return {
    ...facts,
    kind: "statement",
    phase: "subscription",
    sql: sql`SELECT 'subscription' AS phase, ${modelProviderAccounts.type} AS type,
      ${modelProviderAccounts.externalAccountId} AS "externalAccountId", ${modelProviderAccounts.accountEmail} AS "accountEmail",
      ${modelProviderAccounts.workspaceName} AS "workspaceName" FROM ${modelProviderAccounts}
      WHERE ${and(
        eq(modelProviderAccounts.id, provider.id),
        eq(modelProviderAccounts.orgId, args.createArgs.orgId),
        eq(modelProviderAccounts.userId, args.createArgs.userId),
        eq(modelProviderAccounts.type, provider.type),
        isNull(modelProviderAccounts.disconnectedAt),
      )}
      LIMIT 1`,
  };
}

function disconnectedSubscription() {
  return {
    ...conflict(
      "The selected subscription account was disconnected. Reconnect it before starting another run.",
    ),
    admissionFailure: "subscription_account_disconnected" as const,
  };
}

function queueHeadStep(
  args: PreparedCommitPreparedLaunchArgs,
  facts: AdmissionFacts,
): PendingAdmissionProgress {
  const association = args.createArgs.queueFirstAssociation;
  if (!association) {
    return { ...facts, kind: "admitted", queueFirstClaim: undefined };
  }
  if (association.threadId !== args.createArgs.chatThreadId) {
    throw new Error("Queue-first association must match the run chat thread");
  }
  const revoker = alias(chatEvents, "pending_launch_queue_revoker");
  const unrevoked = notExists(
    new QueryBuilder()
      .select({ id: revoker.id })
      .from(revoker)
      .where(eq(revoker.revokesEventId, chatEvents.id)),
  );
  return {
    ...facts,
    kind: "statement",
    phase: "head",
    sql: sql`SELECT 'head' AS phase, ${chatEvents.id} AS id, ${chatEvents.chatThreadId} AS "chatThreadId",
      ${chatEvents.createdAt} AS "createdAt", ${chatEvents.eventType} AS "eventType", ${chatEvents.contextType} AS "contextType", ${chatEvents.contextId} AS "contextId",
      ${canonicalChatEventUserMessage()} AS "userMessage", ${canonicalChatInputModelSelection()} AS "modelSelection"
      FROM ${chatEvents} WHERE ${and(
        eq(chatEvents.chatThreadId, association.threadId),
        chatEventRunlessInputPredicate(chatEvents.runId, chatEvents.eventType),
        inArray(chatEvents.eventType, ["input.prompt", "input.automation"]),
        unrevoked,
      )}
      ORDER BY ${asc(chatEvents.seqId)} LIMIT 1`,
  };
}

/** Actual decoded facts feed the next plan; validation never executes SQL. */
export function advancePendingLaunchAdmission(
  args: PreparedCommitPreparedLaunchArgs,
  step: AdmissionStatement,
  records: readonly AdmissionRecord[],
): PendingAdmissionProgress {
  const row = records[0];
  const facts: AdmissionFacts = {
    validatedThreadSession: step.validatedThreadSession,
    validatedAccountIdentity: step.validatedAccountIdentity,
  };
  const resolution = args.createArgs.threadSessionResolution;
  switch (step.phase) {
    case "thread": {
      return advanceThreadSnapshot(args, facts, row);
    }
    case "session": {
      if (
        !row ||
        !("phase" in row) ||
        row.phase !== "session" ||
        !resolution ||
        row.conversationId !== resolution.expected.conversationId
      ) {
        throw new Error("Chat thread session changed during run preparation");
      }
      return subscriptionStep(args, facts);
    }
    case "subscription": {
      if (!row) {
        return disconnectedSubscription();
      }
      if (!("phase" in row) || row.phase !== "subscription") {
        throw new Error("Unexpected subscription admission result");
      }
      return queueHeadStep(args, {
        ...facts,
        validatedAccountIdentity: personalSubscriptionAccountIdentity(row),
      });
    }
    case "head": {
      return advanceQueueHead(args, facts, row);
    }
    case "claim": {
      if (!row) {
        return { kind: "queue-first-claim-lost" };
      }
      if ("phase" in row) {
        throw new Error("Unexpected queue claim write result");
      }
      return {
        ...facts,
        kind: "admitted",
        queueFirstClaim: { kind: "claimed", createdAt: row.createdAt },
      };
    }
  }
}

function advanceThreadSnapshot(
  args: PreparedCommitPreparedLaunchArgs,
  facts: AdmissionFacts,
  row: AdmissionRecord | undefined,
): PendingAdmissionProgress {
  if (!row) {
    throw new Error("Chat thread not found while validating session snapshot");
  }
  if (!("phase" in row) || row.phase !== "thread") {
    throw new Error("Unexpected pending thread snapshot result");
  }
  const resolution = args.createArgs.threadSessionResolution;
  if (!resolution) {
    return subscriptionStep(args, facts);
  }
  if (
    row.agentSessionId !== resolution.expected.agentSessionId ||
    row.agentSessionRunId !== resolution.expected.agentSessionRunId
  ) {
    throw new Error("Chat thread session changed during run preparation");
  }
  const threadId = args.createArgs.chatThreadId;
  if (!threadId) {
    throw new Error("Validated session requires a chat thread");
  }
  const validatedThreadSession: ValidatedPendingThreadSession = Object.freeze({
    kind: "validated-thread-session-snapshot",
    chatThreadId: threadId,
    threadAgentId: row.threadAgentId,
    agentSessionId: row.agentSessionId,
    agentSessionRunId: row.agentSessionRunId,
  });
  const captured = { ...facts, validatedThreadSession };
  const sessionId = resolution.expected.sessionId;
  return sessionId === null
    ? subscriptionStep(args, captured)
    : {
        ...captured,
        kind: "statement",
        phase: "session",
        sql: sql`SELECT 'session' AS phase, ${agentSessions.conversationId} AS "conversationId"
      FROM ${agentSessions} WHERE ${eq(agentSessions.id, sessionId)} LIMIT 1 FOR UPDATE`,
      };
}

function advanceQueueHead(
  args: PreparedCommitPreparedLaunchArgs,
  facts: AdmissionFacts,
  row: AdmissionRecord | undefined,
): PendingAdmissionProgress {
  const association = args.createArgs.queueFirstAssociation;
  if (!association) {
    throw new Error("Queue-first claim requires a captured association");
  }
  if (
    !row ||
    !("phase" in row) ||
    row.phase !== "head" ||
    row.id !== association.eventId
  ) {
    return { kind: "queue-first-claim-lost" };
  }
  if (!row.userMessage) {
    throw new Error("Queued input event is missing userMessage");
  }
  if (row.eventType === "input.prompt" && row.contextType === null) {
    throw new Error("Queued user message is missing its context type");
  }
  const pin = args.createArgs.agentRunModelPin;
  if (!pin) {
    throw new Error("Queue-first claim requires a run model pin");
  }
  const serviceTier = args.createArgs.codexServiceTier
    ? args.createArgs.codexServiceTier === "fast"
      ? ("priority" as const)
      : ("ultrafast" as const)
    : undefined;
  return {
    ...facts,
    kind: "statement",
    phase: "claim",
    sql: chatEventReplacementInsertSql(row, {
      id: args.identity.runId,
      chatThreadId: association.threadId,
      eventType: "input.prompt",
      runId: args.identity.runId,
      ...(row.modelSelection === null
        ? {}
        : { modelSelection: row.modelSelection }),
      userMessage:
        pin.selectedModel === null
          ? row.userMessage
          : withRunModelAnnotation(
              row.userMessage,
              pin.selectedModel,
              serviceTier,
            ),
    }),
  };
}
