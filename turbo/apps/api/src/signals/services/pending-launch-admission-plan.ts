import { literal, object, string, enum as zEnum, type output } from "zod";

import { and, asc, eq, inArray, notExists, sql, type SQL } from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";
import {
  chatEvents,
  chatEventRunlessInputPredicate,
} from "@okouai/db/schema/chat-event";
import { chatEventContextTypeSchema } from "@okouai/api-contracts/contracts/chat-events";
import { chatInputModelSelectionSchema } from "@okouai/api-contracts/contracts/chat-input-model";
import { userMessageDocumentSchema } from "@okouai/api-contracts/validators/chat-threads";
import { pgTimestampWithoutTimezoneToDateSchema } from "../../lib/db-raw-rows";
import {
  canonicalChatEventUserMessage,
  canonicalChatInputModelSelection,
} from "./canonical-chat-event-read.service";
import { prepareChatEventReplacement } from "./chat-event.service";
import type { PreparedChatEventRow } from "./chat-event-append.service";
import { withRunModelAnnotation } from "./chat-user-message.service";
import type { PreparedThreadLaunchCommit } from "./thread-claim-run.service";
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
  readonly validatedThreadSession: ValidatedPendingThreadSession;
  readonly validatedAccountIdentity: string | null;
}

export const pendingAdmissionRecordSchema = object({
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

type AdmissionRecord = output<typeof pendingAdmissionRecordSchema>;

type AdmissionStatement = AdmissionFacts & {
  readonly kind: "statement";
  readonly sql: SQL;
};
type PreparedInputClaim = AdmissionFacts & {
  readonly kind: "claim";
  readonly claimInput: PreparedChatEventRow & {
    readonly revokesEventId: string;
  };
  readonly headSql: SQL;
};
/** Read the queue head using accepted model facts; publication owns the write. */
export function pendingLaunchAdmissionStart(
  args: PreparedThreadLaunchCommit,
): AdmissionStatement {
  const threadId = args.createArgs.chatThreadId;
  const resolution = args.createArgs.threadContinuation;
  const captured: AdmissionFacts = {
    validatedThreadSession: {
      kind: "validated-thread-session-snapshot",
      chatThreadId: threadId,
      threadAgentId: resolution.expected.threadAgentId,
      framework: resolution.expected.framework,
      frameworkSessionId: resolution.expected.frameworkSessionId,
      frameworkSessionRunId: resolution.expected.frameworkSessionRunId,
      admission: resolution.admission,
    },
    validatedAccountIdentity: args.context.modelProvider.accountIdentity,
  };
  const association = args.createArgs.queueFirstAssociation;
  if (association.threadId !== threadId) {
    throw new Error("Queue-first association must match the run chat thread");
  }
  return {
    ...captured,
    kind: "statement",
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

/** Validate the decoded queue head without rereading accepted model sources. */
export function advancePendingLaunchAdmission(
  args: PreparedThreadLaunchCommit,
  step: AdmissionStatement,
  records: readonly AdmissionRecord[],
): PreparedInputClaim | { readonly kind: "queue-first-claim-lost" } {
  const row = records[0];
  const facts: AdmissionFacts = {
    validatedThreadSession: step.validatedThreadSession,
    validatedAccountIdentity: step.validatedAccountIdentity,
  };
  const association = args.createArgs.queueFirstAssociation;
  if (!row || row.id !== association.eventId) {
    return { kind: "queue-first-claim-lost" };
  }
  if (!row.userMessage) {
    throw new Error("Queued input event is missing userMessage");
  }
  if (row.eventType === "input.prompt" && row.contextType === null) {
    throw new Error("Queued user message is missing its context type");
  }
  const pin = args.createArgs.modelSelection;
  const serviceTier =
    args.createArgs.codexServiceTier === "fast"
      ? ("priority" as const)
      : args.createArgs.codexServiceTier;
  const prepared = prepareChatEventReplacement(row, {
    id: args.identity.runId,
    chatThreadId: association.threadId,
    eventType: "input.prompt",
    runId: args.identity.runId,
    ...(row.modelSelection === null
      ? {}
      : { modelSelection: row.modelSelection }),
    userMessage: withRunModelAnnotation(
      row.userMessage,
      pin.selectedModel,
      serviceTier,
    ),
  });
  return {
    ...facts,
    kind: "claim",
    claimInput: { ...prepared.row, revokesEventId: row.id },
    headSql: step.sql,
  };
}
