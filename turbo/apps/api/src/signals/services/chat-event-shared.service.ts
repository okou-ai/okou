import { command } from "ccstate";
import { historicalRunGroupId } from "./run-event-provenance.service";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import {
  and,
  eq,
  isNotNull,
  isNull,
  not,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { writeDb$, type Db } from "../external/db";
import { publishChatThreadMessageCreatedSafely } from "../external/realtime";
import { nowDate } from "../../lib/time";
import { assistantEventIdForRunEvent } from "./assistant-event-id";
import { insertChatEvents } from "./chat-event.service";
import {
  chatEventTypeIn,
  runOwnedChatEventCondition,
} from "./chat-event-type.service";
import { canonicalChatEventError } from "./canonical-chat-event-read.service";
import { publishFirstAssistantEventCreatedSafely } from "./chat-first-assistant-event-metric.service";
import {
  appendChatThreadEvent,
  type ChatThreadEventTransaction,
} from "./chat-thread-event.service";
import { attemptChatEventSideEffect } from "./chat-event-write-side-effects.service";
import { chatThreadOrganizationCondition } from "./chat-thread-organization.service";

import {
  withRunOutputWrite,
  type RunContentOwnership,
} from "./run-content-erasure-admission.service";

const EXT_MIMETYPE_MAP: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  aac: "audio/aac",
  flac: "audio/flac",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  mpga: "audio/mpeg",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  opus: "audio/opus",
  wav: "audio/wav",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  md: "text/markdown",
  html: "text/html",
  htm: "text/html",
  har: "application/json",
  json: "application/json",
};
const revoker = alias(chatEvents, "revoker");

type InsertAssistantEventItem =
  | {
      readonly eventType: "output.message";
      readonly runEventSequenceNumber: number;
      readonly content: string;
      readonly runEventId: string;
    }
  | {
      readonly eventType: "output.error";
      readonly runEventSequenceNumber: number;
      readonly error: string;
      readonly runEventId: string;
    }
  | {
      readonly eventType: "output.thinking";
      readonly runEventSequenceNumber: number;
      readonly thinking: string;
      readonly runEventId: string;
    };

export interface InsertAssistantEventsInput {
  readonly ownership: RunContentOwnership;
  readonly runId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly items: readonly InsertAssistantEventItem[];
}

export function inferMimetype(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  return ext
    ? (EXT_MIMETYPE_MAP[ext] ?? "application/octet-stream")
    : "application/octet-stream";
}

/**
 * Supplies the organization the caller already authorized for this thread, so
 * the sort event does not rediscover it. The predicates only re-prove that
 * same scope; they must not narrow which threads the caller could already
 * touch.
 */
interface AuthorizedChatThreadTouchScope {
  readonly userId: string;
  readonly orgId: string;
}

export async function touchChatThreadLastMessageAtIndependently(
  tx: Db,
  threadId: string,
  touchedAt: Date = nowDate(),
  eventId?: string,
  authorizedScope?: AuthorizedChatThreadTouchScope,
): Promise<void> {
  await touchChatThreadIndependently(tx, threadId, {
    touchedAt,
    eventId,
    authorizedScope,
    unarchive: false,
  });
}

/**
 * Touch for a completed or failed run's terminal marker. That marker makes the
 * thread unread, so an archived thread also returns to the default sidebar
 * list. Cancellation is user-initiated and must not use this.
 */
export async function touchChatThreadForUnreadRunFinishIndependently(
  tx: Db,
  threadId: string,
  touchedAt: Date = nowDate(),
): Promise<void> {
  await touchChatThreadIndependently(tx, threadId, {
    touchedAt,
    eventId: undefined,
    authorizedScope: undefined,
    unarchive: true,
  });
}

async function touchChatThreadIndependently(
  tx: Db,
  threadId: string,
  options: {
    readonly touchedAt: Date;
    readonly eventId: string | undefined;
    readonly authorizedScope: AuthorizedChatThreadTouchScope | undefined;
    readonly unarchive: boolean;
  },
): Promise<void> {
  const { touchedAt, eventId, authorizedScope } = options;
  // Resolve identity before either independent write. Failure of the weak
  // timestamp update must not suppress the separate ordering event attempt.
  const [thread] = await tx
    .select({
      id: chatThreads.id,
      userId: chatThreads.userId,
      agentId: chatThreads.agentId,
      archived: chatThreads.archived,
    })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.id, threadId),
        isNotNull(chatThreads.agentId),
        authorizedScope
          ? and(
              eq(chatThreads.userId, authorizedScope.userId),
              chatThreadOrganizationCondition(tx, authorizedScope.orgId),
            )
          : undefined,
      ),
    )
    .limit(1);
  if (!thread?.agentId) {
    return;
  }
  const agentId = thread.agentId;
  // The flag rides on the same single-row UPDATE; `archived` is not indexed.
  // A concurrent re-archive between the read and this write loses, which is
  // acceptable for a best-effort sidebar state.
  const unarchive = options.unarchive && thread.archived;
  let unarchived = false;
  await attemptChatEventSideEffect("last_message_at", threadId, async () => {
    const updated = await tx
      .update(chatThreads)
      .set({
        lastMessageAt: sql`GREATEST(${chatThreads.lastMessageAt}, ${touchedAt.toISOString()}::timestamp)`,
        ...(unarchive ? { archived: false } : {}),
      })
      .where(
        and(
          eq(chatThreads.id, threadId),
          eq(chatThreads.userId, thread.userId),
        ),
      )
      .returning({ id: chatThreads.id });
    unarchived = unarchive && updated.length > 0;
  });
  await attemptChatEventSideEffect("sort_touched", threadId, async () => {
    await appendChatThreadEvent(tx, {
      kind: "sort_touched",
      userId: thread.userId,
      ...(authorizedScope ? { orgId: authorizedScope.orgId } : {}),
      chatThreadId: threadId,
      agentId,
      eventId,
      createdAt: touchedAt,
    });
  });
  if (!unarchived) {
    return;
  }
  await attemptChatEventSideEffect("unarchived", threadId, async () => {
    await appendChatThreadEvent(tx, {
      kind: "unarchived",
      userId: thread.userId,
      chatThreadId: threadId,
      agentId,
    });
  });
}

export async function touchChatThreadLastMessageAt(
  tx: ChatThreadEventTransaction,
  threadId: string,
  touchedAt: Date = nowDate(),
  eventId?: string,
  authorizedScope?: AuthorizedChatThreadTouchScope,
): Promise<void> {
  const [thread] = await tx
    .update(chatThreads)
    .set({
      lastMessageAt: sql`GREATEST(${chatThreads.lastMessageAt}, ${touchedAt.toISOString()}::timestamp)`,
    })
    .where(
      and(
        eq(chatThreads.id, threadId),
        isNotNull(chatThreads.agentId),
        authorizedScope
          ? and(
              eq(chatThreads.userId, authorizedScope.userId),
              chatThreadOrganizationCondition(tx, authorizedScope.orgId),
            )
          : undefined,
      ),
    )
    .returning({
      id: chatThreads.id,
      userId: chatThreads.userId,
      agentId: chatThreads.agentId,
      lastMessageAt: chatThreads.lastMessageAt,
    });
  if (!thread?.agentId) {
    if (authorizedScope) {
      throw new Error("Authorized chat thread changed before sort touch");
    }
    return;
  }
  await appendChatThreadEvent(tx, {
    kind: "sort_touched",
    userId: thread.userId,
    ...(authorizedScope ? { orgId: authorizedScope.orgId } : {}),
    chatThreadId: thread.id,
    agentId: thread.agentId,
    eventId,
    createdAt: thread.lastMessageAt,
  });
}

export function visibleChatEventCondition(
  db: Pick<Db, "select">,
): SQL | undefined {
  const isUserInputEvent = chatEventTypeIn([
    "input.prompt",
    "input.automation",
    "input.rejected",
    "control.interrupt",
    "control.revoke",
  ]);
  const hasRunOwner = and(
    isNotNull(chatEvents.runId),
    runOwnedChatEventCondition(),
  );
  return and(
    not(chatEventTypeIn(["input.goal"])),
    notExists(
      db
        .select({ id: revoker.id })
        .from(revoker)
        .where(eq(revoker.revokesEventId, chatEvents.id)),
    ),
    or(
      not(isUserInputEvent),
      hasRunOwner,
      isNull(chatEvents.revokesEventId),
      isNotNull(canonicalChatEventError()),
    ),
    not(chatEventTypeIn(["control.interrupt"])),
  );
}

async function assistantEventRunContextForRun(
  db: Pick<Db, "select">,
  runId: string,
): Promise<{
  readonly shouldAttemptFirstAssistantEventClaim: boolean;
}> {
  const [run] = await db
    .select({
      apiStartedAt: agentRuns.apiStartedAt,
      firstAssistantEventAcknowledgedAt:
        agentRuns.firstAssistantEventAcknowledgedAt,
    })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), isNotNull(agentRuns.triggerSource)))
    .limit(1);
  return {
    shouldAttemptFirstAssistantEventClaim:
      run !== undefined &&
      run.apiStartedAt !== null &&
      run.firstAssistantEventAcknowledgedAt === null,
  };
}

interface InsertAssistantEventsTransactionResult {
  readonly insertedRowCount: number;
  readonly shouldAttemptFirstAssistantEventClaim: boolean;
}

export async function insertAssistantEventsInTransaction(
  tx: Db | ChatThreadEventTransaction,
  args: Omit<InsertAssistantEventsInput, "ownership"> & {
    readonly runGroupId: string | undefined;
  },
  signal: AbortSignal,
): Promise<InsertAssistantEventsTransactionResult> {
  if (args.items.length === 0) {
    return {
      insertedRowCount: 0,
      shouldAttemptFirstAssistantEventClaim: false,
    };
  }

  const runContext = await assistantEventRunContextForRun(tx, args.runId);
  signal.throwIfAborted();

  const insertedRows = await insertChatEvents(
    tx,
    args.items.map((item) => {
      const eventIdentity = {
        id: assistantEventIdForRunEvent(args.runId, item.runEventId),
        chatThreadId: args.threadId,
        runId: args.runId,
        runGroupId: args.runGroupId,
        runEventSequenceNumber: item.runEventSequenceNumber,
        runEventId: item.runEventId,
      };
      if (item.eventType === "output.message") {
        return {
          ...eventIdentity,
          eventType: item.eventType,
          content: item.content,
        };
      }
      if (item.eventType === "output.error") {
        return {
          ...eventIdentity,
          eventType: item.eventType,
          content: null,
          error: item.error,
        };
      }
      return {
        ...eventIdentity,
        eventType: item.eventType,
        thinking: item.thinking,
      };
    }),
  );
  signal.throwIfAborted();

  return {
    insertedRowCount: insertedRows.length,
    shouldAttemptFirstAssistantEventClaim:
      runContext.shouldAttemptFirstAssistantEventClaim,
  };
}

export async function insertAssistantEvents(
  writeDb: Db,
  args: InsertAssistantEventsInput,
  signal: AbortSignal,
): Promise<number> {
  if (args.items.length === 0) {
    return 0;
  }

  const runGroupId = await historicalRunGroupId(
    writeDb,
    args.runId,
    undefined,
    signal,
  );
  const admitted = await withRunOutputWrite(
    writeDb,
    { runId: args.runId, destination: args, ownership: args.ownership },
    async (tx, current) => {
      return {
        outcome: "written" as const,
        ownership: current.ownership,
        value: await insertAssistantEventsInTransaction(
          tx,
          { ...args, runGroupId },
          signal,
        ),
      };
    },
    signal,
  );
  const result = admitted.value;
  signal.throwIfAborted();

  if (result.insertedRowCount > 0) {
    if (result.shouldAttemptFirstAssistantEventClaim) {
      await publishFirstAssistantEventCreatedSafely({
        db: writeDb,
        ownership: admitted.ownership,
        orgId: args.orgId,
        userId: args.userId,
        threadId: args.threadId,
        runId: args.runId,
      });
    } else {
      await publishChatThreadMessageCreatedSafely({
        userId: args.userId,
        orgId: args.orgId,
        threadId: args.threadId,
      });
    }
    signal.throwIfAborted();
  }

  return result.insertedRowCount;
}

export const insertAssistantEvents$ = command(
  async (
    { set },
    args: InsertAssistantEventsInput,
    signal: AbortSignal,
  ): Promise<number> => {
    return await insertAssistantEvents(set(writeDb$), args, signal);
  },
);
