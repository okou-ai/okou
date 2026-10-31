import {
  discriminatedUnion,
  literal,
  object,
  string,
  enum as zEnum,
  type output,
} from "zod";

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
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import {
  chatEvents,
  chatEventRunlessInputPredicate,
} from "@okouai/db/schema/chat-event";
import { modelProviderAccounts } from "@okouai/db/schema/model-provider-account";
import { chatEventContextTypeSchema } from "@okouai/api-contracts/contracts/chat-events";
import { chatInputModelSelectionSchema } from "@okouai/api-contracts/contracts/chat-input-model";
import { userMessageDocumentSchema } from "@okouai/api-contracts/validators/chat-threads";
import { pgTimestampWithoutTimezoneToDateSchema } from "../../lib/db-raw-rows";
import { conflict } from "../../lib/error";
import { isPersonalSubscriptionProviderType } from "./model-provider-account.service";
import { personalSubscriptionAccountIdentity } from "./personal-subscription-recovery.service";
import {
  canonicalChatEventUserMessage,
  canonicalChatInputModelSelection,
} from "./canonical-chat-event-read.service";
import { prepareChatEventReplacement } from "./chat-event.service";
import type { PreparedChatEventRow } from "./chat-event-append.service";
import { withRunModelAnnotation } from "./chat-user-message.service";
import type { PreparedCommitPreparedLaunchArgs } from "./thread-claim-run.service";
import type { ChatThreadContinuation } from "./chat-session-continuity.service";

interface ValidatedPendingThreadSession {
  readonly kind: "validated-thread-session-snapshot";
  readonly chatThreadId: string;
  readonly threadAgentId: string | null;
  readonly framework: string | null;
  readonly frameworkSessionId: string | null;
  readonly frameworkSessionRunId: string | null;
  readonly admission: ChatThreadContinuation["admission"];
}

interface AdmissionFacts {
  readonly validatedThreadSession: ValidatedPendingThreadSession | undefined;
  readonly validatedAccountIdentity: string | null;
}

export const pendingAdmissionRecordSchema = discriminatedUnion("phase", [
  object({
    phase: literal("thread"),
    threadAgentId: string().nullable(),
    framework: string().nullable(),
    frameworkSessionId: string().nullable(),
    frameworkSessionRunId: string().nullable(),
  }),
  object({
    phase: literal("subscription"),
    type: string(),
    externalAccountId: string().nullable(),
    accountEmail: string().nullable(),
    workspaceName: string().nullable(),
  }),
  object({
    phase: literal("head"),
    id: string(),
    chatThreadId: string(),
    createdAt: pgTimestampWithoutTimezoneToDateSchema,
    eventType: zEnum(["input.prompt", "input.automation"]),
    contextType: chatEventContextTypeSchema.nullable(),
    contextId: string().nullable(),
    userMessage: userMessageDocumentSchema.nullable(),
    modelSelection: chatInputModelSelectionSchema.nullable(),
  }),
]);
type AdmissionRecord = output<typeof pendingAdmissionRecordSchema>;

type AdmissionStatement = AdmissionFacts & {
  readonly kind: "statement";
  readonly phase: "thread" | "subscription" | "head";
  readonly sql: SQL;
};
type PreparedInputClaim = AdmissionFacts & {
  readonly kind: "claim";
  readonly claimInput: PreparedChatEventRow & {
    readonly revokesEventId: string;
  };
  readonly headSql: SQL;
};
type Admitted = AdmissionFacts & { readonly kind: "admitted" };
export type PendingAdmissionProgress =
  | AdmissionStatement
  | PreparedInputClaim
  | Admitted
  | { readonly kind: "queue-first-claim-lost" }
  | (ReturnType<typeof conflict> & {
      readonly admissionFailure?: "subscription_account_disconnected";
    });

/** Finite read plan and prepared input; publication owns the only write.
 * Each phase occurs at most once. No retries, resources, callbacks or handles. */
export function pendingLaunchAdmissionStart(
  args: PreparedCommitPreparedLaunchArgs,
): PendingAdmissionProgress {
  const facts: AdmissionFacts = {
    validatedThreadSession: undefined,
    validatedAccountIdentity: null,
  };
  const threadId = args.createArgs.chatThreadId;
  const resolution = args.createArgs.threadContinuation;
  if (threadId && resolution) {
    const captured: AdmissionFacts = {
      ...facts,
      validatedThreadSession: {
        kind: "validated-thread-session-snapshot",
        chatThreadId: threadId,
        threadAgentId: resolution.expected.threadAgentId,
        framework: resolution.expected.framework,
        frameworkSessionId: resolution.expected.frameworkSessionId,
        frameworkSessionRunId: resolution.expected.frameworkSessionRunId,
        admission: resolution.admission,
      },
    };
    return subscriptionStep(args, captured);
  }
  return threadId
    ? {
        ...facts,
        kind: "statement",
        phase: "thread",
        sql: sql`SELECT 'thread' AS phase, ${chatThreads.agentId} AS "threadAgentId", ${chatThreads.framework} AS "framework", ${chatThreads.frameworkSessionId} AS "frameworkSessionId", ${chatThreads.frameworkSessionRunId} AS "frameworkSessionRunId"
      FROM ${chatThreads} WHERE ${eq(chatThreads.id, threadId)} LIMIT 1`,
      }
    : subscriptionStep(args, facts);
}

function subscriptionStep(
  args: PreparedCommitPreparedLaunchArgs,
  facts: AdmissionFacts,
): PendingAdmissionProgress {
  const provider = args.context.modelProvider;
  if (!provider || !isPersonalSubscriptionProviderType(provider.type)) {
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
    return { ...facts, kind: "admitted" };
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

  switch (step.phase) {
    case "thread": {
      return advanceThreadSnapshot(args, facts, row);
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
      return advanceQueueHead(args, facts, row, step.sql);
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
  const resolution = args.createArgs.threadContinuation;
  if (!resolution) {
    return subscriptionStep(args, facts);
  }
  if (
    row.framework !== resolution.expected.framework ||
    row.frameworkSessionId !== resolution.expected.frameworkSessionId ||
    row.frameworkSessionRunId !== resolution.expected.frameworkSessionRunId
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
    framework: row.framework,
    frameworkSessionId: row.frameworkSessionId,
    frameworkSessionRunId: row.frameworkSessionRunId,
    admission: resolution.admission,
  });
  const captured = { ...facts, validatedThreadSession };
  return subscriptionStep(args, captured);
}

function advanceQueueHead(
  args: PreparedCommitPreparedLaunchArgs,
  facts: AdmissionFacts,
  row: AdmissionRecord | undefined,
  headSql: SQL,
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
    ? ("priority" as const)
    : undefined;
  const prepared = prepareChatEventReplacement(row, {
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
  });
  return {
    ...facts,
    kind: "claim",
    claimInput: { ...prepared.row, revokesEventId: row.id },
    headSql,
  };
}
