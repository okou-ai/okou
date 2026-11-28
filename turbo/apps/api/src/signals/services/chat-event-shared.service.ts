import { publishChatThreadMessageCreated$ } from "./chat-event-publication.service";
import { writeDb$ } from "../external/db";
import { publishFirstAssistantEventCreatedSafely$ } from "./chat-first-assistant-event-metric.service";
import type { ChatRecommendedFollowup } from "@okouai/api-contracts/contracts/chat-threads";
import { serializeChatFollowupsContent } from "@okouai/api-contracts/validators/chat-threads";
import {
  chatEventAppendResultSchema,
  chatEventCommandResultSchema,
} from "./chat-event-append.service";
import { parseRawRows } from "../../lib/db-raw-rows";
import { command } from "ccstate";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { settle, settleIncludingAbort } from "../utils";
import { isForeignKeyViolation } from "../../lib/pg-errors";
import { publishChatThreadReadCursorUpdatedSafely } from "../external/realtime";
import { nowDate } from "../../lib/time";
import {
  assistantEventIdForRunEvent,
  followupsEventIdForRun,
} from "./assistant-event-id";
import { chatEventInsertSql, chatEventsInsertSql } from "./chat-event.service";
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
  /** External notification delivery consumes unread state for the whole thread. */
  readonly markRead?: boolean;
  /**
   * Optional already-loaded thread identity and archived state. When present
   * without `authorizedScope`, skips the redundant pre-update SELECT on
   * `chat_threads`.
   */
  readonly threadSnapshot?: {
    readonly id: string;
    readonly userId: string;
    readonly archived: boolean;
  };
}

export const insertRecommendedFollowupsEvent$ = command(
  async (
    { set },
    args: {
      readonly runId: string;
      readonly threadId: string;
      readonly userId: string;
      readonly orgId: string;
      readonly followups: readonly ChatRecommendedFollowup[];
      readonly markRead: boolean;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    signal.throwIfAborted();
    const database = set(writeDb$);
    const query = chatEventInsertSql(
      {
        id: followupsEventIdForRun(args.runId),
        chatThreadId: args.threadId,
        eventType: "output.followups",
        content: serializeChatFollowupsContent(args.followups),
        runId: args.runId,
      },
      "id",
    );
    const result = await settle(
      (async () => {
        return parseRawRows(
          chatEventCommandResultSchema,
          await database.execute(query),
        );
      })(),
      signal,
    );
    if (!result.ok) {
      if (
        !isForeignKeyViolation(
          result.error,
          "chat_event_sequences_chat_thread_id_chat_threads_id_fk",
        ) &&
        !isForeignKeyViolation(
          result.error,
          "chat_events_chat_thread_id_chat_threads_id_fk",
        )
      ) {
        throw result.error;
      }
      // Generation can outlive thread deletion. Let the FK arbitrate the race,
      // then omit only follow-ups whose captured thread is actually gone.
      const [thread] = await database
        .select({ id: chatThreads.id })
        .from(chatThreads)
        .where(eq(chatThreads.id, args.threadId))
        .limit(1);
      signal.throwIfAborted();
      if (thread) {
        throw result.error;
      }
      return false;
    }

    const inserted = result.value[0] ?? null;
    signal.throwIfAborted();
    if (!inserted) {
      return false;
    }

    if (args.markRead) {
      await set(
        touchChatThreadLastMessageAtIndependently$,
        args.threadId,
        {
          touchedAt: inserted.createdAt,
          orgId: args.orgId,
          markRead: true,
        },
        signal,
      );
    }
    await set(
      publishChatThreadMessageCreated$,
      {
        userId: args.userId,
        orgId: args.orgId,
        threadId: args.threadId,
        syncThroughSeqId: inserted.seqId,
      },
      signal,
    );
    signal.throwIfAborted();
    return true;
  },
);

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
    const thread =
      !authorizedScope && options.threadSnapshot
        ? options.threadSnapshot
        : (
            await database
              .select({
                id: chatThreads.id,
                userId: chatThreads.userId,
                archived: chatThreads.archived,
              })
              .from(chatThreads)
              .where(
                and(
                  eq(chatThreads.id, threadId),
                  authorizedScope
                    ? and(
                        eq(chatThreads.userId, authorizedScope.userId),
                        chatThreadOrganizationCondition(authorizedScope.orgId),
                      )
                    : undefined,
                ),
              )
              .limit(1)
          )[0];
    signal.throwIfAborted();
    if (!thread) {
      return;
    }
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
          ...(options.markRead
            ? {
                lastReadAt: sql`GREATEST(${chatThreads.lastReadAt}, ${chatThreads.lastMessageAt}, ${touchedAt.toISOString()}::timestamp)`,
              }
            : {}),
          ...(unarchive
            ? {
                archived: sql`CASE WHEN ${chatThreads.muted} THEN ${chatThreads.archived} ELSE false END`,
              }
            : {}),
        })
        .where(eq(chatThreads.id, threadId))
        .returning({
          id: chatThreads.id,
          archived: chatThreads.archived,
          lastReadAt: chatThreads.lastReadAt,
        }),
    );
    signal.throwIfAborted();
    reportChatEventSideEffect(
      "last_message_at",
      threadId,
      timestampStartedAt,
      timestampWrite,
    );
    const lastReadAt = timestampWrite.ok && timestampWrite.value[0]?.lastReadAt;
    if (options.markRead && orgId && lastReadAt) {
      await publishChatThreadReadCursorUpdatedSafely(
        { userId: thread.userId, orgId },
        { threadId, lastReadAt: lastReadAt.toISOString() },
      );
      signal.throwIfAborted();
    }
    const unarchived =
      unarchive &&
      timestampWrite.ok &&
      timestampWrite.value[0]?.archived === false;
    const sortStartedAt = performance.now();
    const sortWrite = await settleIncludingAbort(
      set(
        appendThreadTouchEvent$,
        {
          kind: "sort_touched",
          userId: thread.userId,
          orgId,
          chatThreadId: threadId,
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
        await set(
          publishChatThreadMessageCreated$,
          {
            userId: args.userId,
            orgId: args.orgId,
            threadId: args.threadId,
          },
          signal,
        );
        signal.throwIfAborted();
      }
    }
    return result.insertedRowCount;
  },
);
