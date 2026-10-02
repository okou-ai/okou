import { chatEventAppendResultSchema } from "./chat-event-append.service";
import {
  parseRawRows,
  pgTimestampWithoutTimezoneToDateSchema,
} from "../../lib/db-raw-rows";
import { command } from "ccstate";
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
import { alias, QueryBuilder } from "drizzle-orm/pg-core";
import { writeDb$ } from "../external/db";
import { z } from "zod";
import { settleIncludingAbort } from "../utils";
import { publishChatThreadMessageCreatedSafely } from "../external/realtime";
import { nowDate } from "../../lib/time";
import { assistantEventIdForRunEvent } from "./assistant-event-id";
import { chatEventsInsertSql } from "./chat-event.service";
import {
  chatEventTypeIn,
  runOwnedChatEventCondition,
} from "./chat-event-type.service";
import { canonicalChatEventError } from "./canonical-chat-event-read.service";
import { publishFirstAssistantEventCreatedSafely$ } from "./chat-first-assistant-event-metric.service";
import { chatThreadEventInsertSql } from "./chat-thread-event.service";
import { reportChatEventSideEffect } from "./chat-event-write-side-effects.service";
import { chatThreadOrganizationCondition } from "./chat-thread-organization.service";

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
    };

export interface InsertAssistantEventsInput {
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

interface ChatThreadTouchOptions {
  readonly touchedAt?: Date;
  readonly eventId?: string;
  readonly authorizedScope?: AuthorizedChatThreadTouchScope;
  /**
   * The thread's organization, already validated by the caller, so its thread
   * events skip the Agent lookup. Unlike `authorizedScope`, it does not add
   * predicates to the thread read.
   */
  readonly orgId?: string;
  /**
   * Set only for a completed or failed run's terminal marker: that marker makes
   * the thread unread, so an archived thread also returns to the default
   * sidebar list. Cancellation is user-initiated and leaves it archived.
   */
  readonly unarchive?: boolean;
}

const appendThreadTouchEvent$ = command(
  async (
    { set },
    event: Parameters<typeof chatThreadEventInsertSql>[0],
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    await set(writeDb$).execute(chatThreadEventInsertSql(event));
    signal.throwIfAborted();
  },
);

export const touchChatThreadLastMessageAtIndependently$ = command(
  async (
    { set },
    threadId: string,
    options: ChatThreadTouchOptions,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    const database = set(writeDb$);
    const { touchedAt = nowDate(), eventId, authorizedScope } = options;
    const orgId = authorizedScope?.orgId ?? options.orgId;
    // Resolve identity before either independent write. Failure of the weak
    // timestamp update must not suppress the separate ordering event attempt.
    const [thread] = await database
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
                chatThreadOrganizationCondition(authorizedScope.orgId),
              )
            : undefined,
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!thread?.agentId) {
      return;
    }
    const agentId = thread.agentId;
    // The flag rides on the same single-row UPDATE; `archived` is not indexed.
    // A concurrent re-archive between the read and this write loses, which is
    // acceptable for a best-effort sidebar state.
    const unarchive = options.unarchive === true && thread.archived;
    const timestampStartedAt = performance.now();
    const timestampWrite = await settleIncludingAbort(
      database
        .update(chatThreads)
        .set({
          lastMessageAt: sql`GREATEST(${chatThreads.lastMessageAt}, ${touchedAt.toISOString()}::timestamp)`,
          ...(unarchive ? { archived: false } : {}),
        })
        .where(eq(chatThreads.id, threadId))
        .returning({ id: chatThreads.id }),
    );
    signal.throwIfAborted();
    reportChatEventSideEffect(
      "last_message_at",
      threadId,
      timestampStartedAt,
      timestampWrite,
    );
    const unarchived =
      unarchive && timestampWrite.ok && timestampWrite.value.length > 0;
    const sortStartedAt = performance.now();
    const sortWrite = await settleIncludingAbort(
      set(
        appendThreadTouchEvent$,
        {
          kind: "sort_touched",
          userId: thread.userId,
          orgId,
          chatThreadId: threadId,
          agentId,
          eventId,
          createdAt: touchedAt,
        },
        signal,
      ),
    );
    signal.throwIfAborted();
    reportChatEventSideEffect(
      "sort_touched",
      threadId,
      sortStartedAt,
      sortWrite,
    );
    if (!unarchived) {
      return;
    }
    const unarchiveStartedAt = performance.now();
    const unarchiveWrite = await settleIncludingAbort(
      set(
        appendThreadTouchEvent$,
        {
          kind: "unarchived",
          userId: thread.userId,
          orgId,
          chatThreadId: threadId,
          agentId,
        },
        signal,
      ),
    );
    signal.throwIfAborted();
    reportChatEventSideEffect(
      "unarchived",
      threadId,
      unarchiveStartedAt,
      unarchiveWrite,
    );
  },
);

/**
 * A direct send's sidebar touch, run after the pick. The send already
 * authorized the thread and knows its identity, so this does not re-read the
 * thread; unlike a run's terminal touch, it never unarchives it.
 */
export const touchSentChatThreadSort$ = command(
  async (
    { set },
    args: {
      readonly threadId: string;
      readonly userId: string;
      readonly orgId: string;
      readonly agentId: string;
      readonly touchedAt: Date;
      readonly eventId: string | undefined;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    const database = set(writeDb$);
    const timestampStartedAt = performance.now();
    const timestampWrite = await settleIncludingAbort(
      database
        .update(chatThreads)
        .set({
          lastMessageAt: sql`GREATEST(${chatThreads.lastMessageAt}, ${args.touchedAt.toISOString()}::timestamp)`,
        })
        .where(eq(chatThreads.id, args.threadId)),
    );
    signal.throwIfAborted();
    reportChatEventSideEffect(
      "last_message_at",
      args.threadId,
      timestampStartedAt,
      timestampWrite,
    );
    const sortStartedAt = performance.now();
    const sortWrite = await settleIncludingAbort(
      set(
        appendThreadTouchEvent$,
        {
          kind: "sort_touched",
          userId: args.userId,
          orgId: args.orgId,
          chatThreadId: args.threadId,
          agentId: args.agentId,
          eventId: args.eventId,
          createdAt: args.touchedAt,
        },
        signal,
      ),
    );
    signal.throwIfAborted();
    reportChatEventSideEffect(
      "sort_touched",
      args.threadId,
      sortStartedAt,
      sortWrite,
    );
  },
);

/** The caller executes this on its own transaction and decodes the returned identity. */
export function chatThreadLastMessageTouchSql(
  threadId: string,
  touchedAt: Date,
  authorizedScope?: AuthorizedChatThreadTouchScope,
): SQL {
  const condition = and(
    eq(chatThreads.id, threadId),
    isNotNull(chatThreads.agentId),
    authorizedScope
      ? and(
          eq(chatThreads.userId, authorizedScope.userId),
          chatThreadOrganizationCondition(authorizedScope.orgId),
        )
      : undefined,
  );
  if (!condition) {
    throw new Error("Thread touch predicate is empty");
  }
  return sql`UPDATE ${chatThreads}
    SET last_message_at = GREATEST(${chatThreads.lastMessageAt}, ${touchedAt.toISOString()}::timestamp)
    WHERE ${condition}
    RETURNING id, user_id AS "userId", agent_id AS "agentId", last_message_at::text AS "lastMessageAt"`;
}

export const chatThreadLastMessageTouchSchema = z.object({
  id: z.string().uuid(),
  userId: z.string(),
  agentId: z.string().uuid().nullable(),
  lastMessageAt: pgTimestampWithoutTimezoneToDateSchema,
});

/** SQL-only continuation; a missing unscoped thread is a no-op, as before. */
export function chatThreadLastMessageSortSql(
  rows: readonly z.output<typeof chatThreadLastMessageTouchSchema>[],
  eventId?: string,
  authorizedScope?: AuthorizedChatThreadTouchScope,
): SQL | null {
  const thread = rows[0];
  if (!thread?.agentId) {
    if (authorizedScope) {
      throw new Error("Authorized chat thread changed before sort touch");
    }
    return null;
  }
  return chatThreadEventInsertSql({
    kind: "sort_touched",
    userId: thread.userId,
    ...(authorizedScope ? { orgId: authorizedScope.orgId } : {}),
    chatThreadId: thread.id,
    agentId: thread.agentId,
    eventId,
    createdAt: thread.lastMessageAt,
  });
}

export function visibleChatEventCondition(): SQL | undefined {
  return visibleChatEventPredicate();
}

export function visibleChatEventPredicate(): SQL | undefined {
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
    notExists(
      new QueryBuilder()
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

interface AppendAssistantEventRowsResult {
  readonly insertedRowCount: number;
  readonly shouldAttemptFirstAssistantEventClaim: boolean;
}

export const appendAssistantEventRows$ = command(
  async (
    { set },
    args: InsertAssistantEventsInput,
    signal: AbortSignal,
  ): Promise<AppendAssistantEventRowsResult> => {
    signal.throwIfAborted();
    const database = set(writeDb$);
    if (args.items.length === 0) {
      return {
        insertedRowCount: 0,
        shouldAttemptFirstAssistantEventClaim: false,
      };
    }

    const [run] = await database
      .select({
        apiStartedAt: agentRuns.apiStartedAt,
        firstAssistantEventAcknowledgedAt:
          agentRuns.firstAssistantEventAcknowledgedAt,
      })
      .from(agentRuns)
      .where(
        and(eq(agentRuns.id, args.runId), isNotNull(agentRuns.triggerSource)),
      )
      .limit(1);
    signal.throwIfAborted();

    const insertedRows = parseRawRows(
      chatEventAppendResultSchema,
      await database.execute(
        chatEventsInsertSql(
          args.items.map((item) => {
            const eventIdentity = {
              id: assistantEventIdForRunEvent(args.runId, item.runEventId),
              chatThreadId: args.threadId,
              runId: args.runId,
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
            return {
              ...eventIdentity,
              eventType: item.eventType,
              content: null,
              error: item.error,
            };
          }),
        ),
      ),
    );
    signal.throwIfAborted();

    return {
      insertedRowCount: insertedRows.length,
      shouldAttemptFirstAssistantEventClaim:
        run !== undefined &&
        run.apiStartedAt !== null &&
        run.firstAssistantEventAcknowledgedAt === null,
    };
  },
);

export const insertAssistantEvents$ = command(
  async (
    { set },
    args: InsertAssistantEventsInput,
    signal: AbortSignal,
  ): Promise<number> => {
    const result = await set(appendAssistantEventRows$, args, signal);
    if (result.insertedRowCount > 0) {
      if (result.shouldAttemptFirstAssistantEventClaim) {
        await set(
          publishFirstAssistantEventCreatedSafely$,
          {
            orgId: args.orgId,
            userId: args.userId,
            threadId: args.threadId,
            runId: args.runId,
          },
          signal,
        );
      } else {
        await publishChatThreadMessageCreatedSafely({
          userId: args.userId,
          orgId: args.orgId,
          threadId: args.threadId,
        });
        signal.throwIfAborted();
      }
    }
    return result.insertedRowCount;
  },
);
