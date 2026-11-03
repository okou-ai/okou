import {
  discriminatedUnion,
  literal,
  looseObject,
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
import { projectMessageDocumentSchema as userMessageDocumentSchema } from "@okouai/api-contracts/validators/project-message";
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
import type { QueueFirstRunAssociation } from "./chat-queued-event.service";

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

const subscriptionRecordSchema = object({
  phase: literal("subscription"),
  type: string(),
  externalAccountId: string().nullable(),
  accountEmail: string().nullable(),
  workspaceName: string().nullable(),
});

const headRecordSchema = object({
  phase: literal("head"),
  id: string(),
  chatThreadId: string(),
  createdAt: pgTimestampWithoutTimezoneToDateSchema,
  eventType: zEnum(["input.prompt", "input.automation"]),
  contextType: chatEventContextTypeSchema.nullable(),
  contextId: string().nullable(),
  userMessage: userMessageDocumentSchema.nullable(),
  modelSelection: chatInputModelSelectionSchema.nullable(),
});

/**
 * One row for both independent reads. An absent LEFT JOIN LATERAL part has a
 * NULL phase; a present part is decoded by its own phase record schema.
 */
const subscriptionHeadRecordSchema = looseObject({
  phase: literal("subscription-head"),
  subscriptionPhase: literal("subscription").nullable(),
  headPhase: literal("head").nullable(),
}).transform(({ subscriptionPhase, headPhase, ...columns }) => {
  return {
    phase: "subscription-head" as const,
    subscription:
      subscriptionPhase === null
        ? undefined
        : subscriptionRecordSchema.parse({
            ...columns,
            phase: subscriptionPhase,
          }),
    head:
      headPhase === null
        ? undefined
        : headRecordSchema.parse({ ...columns, phase: headPhase }),
  };
});

export const pendingAdmissionRecordSchema = discriminatedUnion("phase", [
  object({
    phase: literal("thread"),
    threadAgentId: string().nullable(),
    framework: string().nullable(),
    frameworkSessionId: string().nullable(),
    frameworkSessionRunId: string().nullable(),
  }),
  subscriptionRecordSchema,
  headRecordSchema,
  subscriptionHeadRecordSchema,
]);
type AdmissionRecord = output<typeof pendingAdmissionRecordSchema>;

type AdmissionStatement = AdmissionFacts &
  (
    | {
        readonly kind: "statement";
        readonly phase: "thread" | "subscription" | "head";
        readonly sql: SQL;
      }
    | {
        readonly kind: "statement";
        readonly phase: "subscription-head";
        readonly sql: SQL;
        /** The queue head read alone; publication repeats it as its guard. */
        readonly headSql: SQL;
      }
  );
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
 * Each phase occurs at most once; independent subscription and queue head
 * reads share one statement. No retries, resources, callbacks or handles. */
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
  const subscriptionSql = sql`SELECT 'subscription' AS phase, ${modelProviderAccounts.type} AS type,
      ${modelProviderAccounts.externalAccountId} AS "externalAccountId", ${modelProviderAccounts.accountEmail} AS "accountEmail",
      ${modelProviderAccounts.workspaceName} AS "workspaceName" FROM ${modelProviderAccounts}
      WHERE ${and(
        eq(modelProviderAccounts.id, provider.id),
        eq(modelProviderAccounts.orgId, args.createArgs.orgId),
        eq(modelProviderAccounts.userId, args.createArgs.userId),
        eq(modelProviderAccounts.type, provider.type),
        isNull(modelProviderAccounts.disconnectedAt),
      )}
      LIMIT 1`;
  const association = args.createArgs.queueFirstAssociation;
  if (!association || association.threadId !== args.createArgs.chatThreadId) {
    // Any queue head step and its association check follow this read.
    return {
      ...facts,
      kind: "statement",
      phase: "subscription",
      sql: subscriptionSql,
    };
  }
  // The head read does not depend on the subscription result: both share one
  // round trip, and evaluation keeps the subscription-first order.
  const headSql = queueHeadSql(association);
  return {
    ...facts,
    kind: "statement",
    phase: "subscription-head",
    sql: sql`SELECT 'subscription-head' AS phase,
      admission_subscription.phase AS "subscriptionPhase", admission_subscription.type,
      admission_subscription."externalAccountId", admission_subscription."accountEmail",
      admission_subscription."workspaceName", admission_head.phase AS "headPhase",
      admission_head.id, admission_head."chatThreadId", admission_head."createdAt",
      admission_head."eventType", admission_head."contextType", admission_head."contextId",
      admission_head."userMessage", admission_head."modelSelection"
      FROM (VALUES (1)) AS admission_seed(value)
      LEFT JOIN LATERAL (${subscriptionSql}) AS admission_subscription ON true
      LEFT JOIN LATERAL (${headSql}) AS admission_head ON true`,
    headSql,
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
  return {
    ...facts,
    kind: "statement",
    phase: "head",
    sql: queueHeadSql(association),
  };
}

function queueHeadSql(association: QueueFirstRunAssociation): SQL {
  const revoker = alias(chatEvents, "pending_launch_queue_revoker");
  const unrevoked = notExists(
    new QueryBuilder()
      .select({ id: revoker.id })
      .from(revoker)
      .where(eq(revoker.revokesEventId, chatEvents.id)),
  );
  return sql`SELECT 'head' AS phase, ${chatEvents.id} AS id, ${chatEvents.chatThreadId} AS "chatThreadId",
      ${chatEvents.createdAt} AS "createdAt", ${chatEvents.eventType} AS "eventType", ${chatEvents.contextType} AS "contextType", ${chatEvents.contextId} AS "contextId",
      ${canonicalChatEventUserMessage()} AS "userMessage", ${canonicalChatInputModelSelection()} AS "modelSelection"
      FROM ${chatEvents} WHERE ${and(
        eq(chatEvents.chatThreadId, association.threadId),
        chatEventRunlessInputPredicate(chatEvents.runId, chatEvents.eventType),
        inArray(chatEvents.eventType, ["input.prompt", "input.automation"]),
        unrevoked,
      )}
      ORDER BY ${asc(chatEvents.seqId)} LIMIT 1`;
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
    case "subscription-head": {
      if (!row || !("phase" in row) || row.phase !== "subscription-head") {
        throw new Error("Unexpected subscription and queue head result");
      }
      // A disconnected account takes precedence over the queue head.
      if (!row.subscription) {
        return disconnectedSubscription();
      }
      return advanceQueueHead(
        args,
        {
          ...facts,
          validatedAccountIdentity: personalSubscriptionAccountIdentity(
            row.subscription,
          ),
        },
        row.head,
        step.headSql,
      );
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
