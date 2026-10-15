import {
  ownedThread,
  currentSnapshotPointer$,
  chatEventRowFromDbRow,
  isCurrentChatEventSnapshotObjectKey,
  isLegacyChatEventSnapshotObjectKey,
} from "./chat-event-row-read.service";
import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import { CURRENT_CHAT_EVENT_SCHEMA_VERSION } from "@okouai/api-contracts/contracts/chat-event-schema-version";
import { command, computed, type Computed } from "ccstate";
import { and, asc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { agents } from "@okouai/db/schema/agent";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatEventSnapshots } from "@okouai/db/schema/chat-event-snapshot";
import { chatEventSequences } from "@okouai/db/schema/chat-event-sequence";
import { chatThreads } from "@okouai/db/runtime/chat-thread";

import { env } from "../../lib/env";
import { db$ } from "../external/db";
import { generatePresignedGetUrl } from "../external/s3";
import { refreshChatEventSnapshotThread$ } from "./cron-snapshot-chat-events.service";
import { PRESIGNED_URL_TTL_SECONDS } from "@okouai/api-contracts/contracts/presigned-urls";

const SNAPSHOT_URL_TTL_SECONDS = PRESIGNED_URL_TTL_SECONDS;
/** Cursor that reads a thread from its very first event. */
const THREAD_START_SEQ_ID = 0;

type ChatEventSnapshotDownload =
  | { readonly kind: "thread-not-found" }
  | { readonly kind: "snapshot-not-found" }
  | {
      readonly kind: "ok";
      readonly url: string;
      readonly expiresInSeconds: number;
      readonly lastEventId: string | null;
      readonly lastSeqId: number;
    };

interface ChatEventBatchSnapshotCursor {
  readonly lastEventId: string | null;
  readonly lastSeqId: number | null;
  readonly physicalLastSeqId: number;
}

interface ChatEventBatchCatchUpResult {
  readonly events: Readonly<Record<string, readonly ChatEventRow[]>>;
  readonly notFoundThreads: readonly string[];
}

interface ChatEventBatchContinuation {
  readonly threadId: string;
  readonly lastSeqId: number;
}

interface ChatEventBatchSnapshotCoverage {
  readonly lastSeqId: number;
  readonly physicalLastSeqId: number;
}

function validatedBatchSnapshotCursor(
  snapshot: ChatEventBatchSnapshotCursor,
): ChatEventBatchSnapshotCoverage {
  if (
    snapshot.lastSeqId === null ||
    !(
      (snapshot.lastSeqId === THREAD_START_SEQ_ID &&
        snapshot.lastEventId === null) ||
      (snapshot.lastSeqId > THREAD_START_SEQ_ID &&
        snapshot.lastEventId !== null)
    )
  ) {
    throw new Error("Current Chat Event Snapshot cursor is incomplete");
  }
  return {
    lastSeqId: snapshot.lastSeqId,
    physicalLastSeqId: snapshot.physicalLastSeqId,
  };
}

function resolveBatchContinuations(
  requested: ReadonlyMap<string, number>,
  ownedThreadLastSeqIds: ReadonlyMap<string, number>,
  snapshotsByThreadId: ReadonlyMap<string, ChatEventBatchSnapshotCoverage>,
): {
  readonly eventThreadIds: readonly string[];
  readonly continuations: readonly ChatEventBatchContinuation[];
  readonly notFoundThreads: readonly string[];
} {
  const eventThreadIds: string[] = [];
  const continuations: ChatEventBatchContinuation[] = [];
  const notFoundThreads: string[] = [];
  for (const [threadId, lastSeqId] of requested) {
    const threadLastSeqId = ownedThreadLastSeqIds.get(threadId);
    if (threadLastSeqId === undefined || lastSeqId > threadLastSeqId) {
      notFoundThreads.push(threadId);
      continue;
    }
    if (lastSeqId === threadLastSeqId) {
      eventThreadIds.push(threadId);
      continue;
    }
    const snapshot = snapshotsByThreadId.get(threadId);
    if (snapshot?.lastSeqId === lastSeqId) {
      eventThreadIds.push(threadId);
      if (snapshot.physicalLastSeqId !== threadLastSeqId) {
        continuations.push({
          threadId,
          lastSeqId: snapshot.physicalLastSeqId,
        });
      }
      continue;
    }
    if (
      (lastSeqId === THREAD_START_SEQ_ID && snapshot === undefined) ||
      (lastSeqId > THREAD_START_SEQ_ID &&
        (snapshot === undefined || lastSeqId > snapshot.physicalLastSeqId))
    ) {
      eventThreadIds.push(threadId);
      continuations.push({ threadId, lastSeqId });
      continue;
    }
    notFoundThreads.push(threadId);
  }
  return { eventThreadIds, continuations, notFoundThreads };
}

/**
 * Resolve complete raw-row tails for a batch of per-thread seq cursors.
 * Missing threads and cursors covered by the current Snapshot are deliberately
 * indistinguishable so the client follows the same Snapshot rebuild path.
 * Cursors above that boundary are sequence watermarks, so reserved gaps remain
 * valid continuation points without a separate physical-row lookup.
 */
export function catchUpChatThreadEvents(args: {
  readonly cursors: readonly (readonly [string, number])[];
  readonly userId: string;
  readonly orgId: string;
}): Computed<Promise<ChatEventBatchCatchUpResult>> {
  return computed(async (get) => {
    const requested = new Map(args.cursors);
    if (requested.size === 0) {
      return { events: {}, notFoundThreads: [] };
    }

    const db = get(db$);
    const threadIds = [...requested.keys()];
    const ownedRows = await db
      .select({
        threadId: chatThreads.id,
        lastChatEventSeqId:
          sql`COALESCE(${chatEventSequences.lastSeqId}, 0)`.mapWith(
            chatEventSequences.lastSeqId,
          ),
      })
      .from(chatThreads)
      .leftJoin(
        chatEventSequences,
        eq(chatEventSequences.chatThreadId, chatThreads.id),
      )
      .innerJoin(agents, eq(agents.id, chatThreads.agentId))
      .where(
        and(
          inArray(chatThreads.id, threadIds),
          eq(chatThreads.userId, args.userId),
          eq(agents.orgId, args.orgId),
        ),
      );
    const ownedThreadLastSeqIds = new Map(
      ownedRows.map((row): readonly [string, number] => {
        return [row.threadId, row.lastChatEventSeqId];
      }),
    );

    // Event writes reserve this watermark in the same transaction as their
    // rows. Unused reservations can only send a thread through the slow path.
    const laggingThreadIds = [...requested]
      .filter(([threadId, lastSeqId]) => {
        const threadLastSeqId = ownedThreadLastSeqIds.get(threadId);
        return threadLastSeqId !== undefined && lastSeqId < threadLastSeqId;
      })
      .map(([threadId]) => {
        return threadId;
      });

    const snapshots =
      laggingThreadIds.length === 0
        ? []
        : await db
            .select({
              threadId: chatEventSnapshots.chatThreadId,
              lastEventId: chatEventSnapshots.terminalEventId,
              lastSeqId: chatEventSnapshots.terminalSeqId,
              physicalLastSeqId: chatEventSnapshots.lastSeqId,
            })
            .from(chatEventSnapshots)
            .where(
              and(
                inArray(chatEventSnapshots.chatThreadId, laggingThreadIds),
                eq(
                  chatEventSnapshots.archiveSchemaVersion,
                  CURRENT_CHAT_EVENT_SCHEMA_VERSION,
                ),
              ),
            );
    const snapshotsByThreadId = new Map(
      snapshots.map(
        (snapshot): readonly [string, ChatEventBatchSnapshotCoverage] => {
          return [snapshot.threadId, validatedBatchSnapshotCursor(snapshot)];
        },
      ),
    );

    const { eventThreadIds, continuations, notFoundThreads } =
      resolveBatchContinuations(
        requested,
        ownedThreadLastSeqIds,
        snapshotsByThreadId,
      );

    const physicalRows =
      continuations.length === 0
        ? []
        : await db
            .select({
              id: chatEvents.id,
              chatThreadId: chatEvents.chatThreadId,
              runId: chatEvents.runId,
              revokesEventId: chatEvents.revokesEventId,
              eventType: chatEvents.eventType,
              payload: chatEvents.payload,
              failureReason: chatEvents.failureReason,
              contextType: chatEvents.contextType,
              contextId: chatEvents.contextId,
              runEventSequenceNumber: chatEvents.runEventSequenceNumber,
              runEventId: chatEvents.runEventId,
              seqId: chatEvents.seqId,
              createdAt: chatEvents.createdAt,
            })
            .from(chatEvents)
            .where(
              or(
                ...continuations.map(({ threadId, lastSeqId }) => {
                  return and(
                    eq(chatEvents.chatThreadId, threadId),
                    gt(chatEvents.seqId, lastSeqId),
                  );
                }),
              ),
            )
            .orderBy(asc(chatEvents.chatThreadId), asc(chatEvents.seqId));
    const events: Record<string, ChatEventRow[]> = Object.fromEntries(
      eventThreadIds.map((threadId) => {
        return [threadId, []];
      }),
    );
    for (const row of physicalRows) {
      const threadEvents = events[row.chatThreadId];
      if (!threadEvents) {
        throw new Error("Chat Event tail escaped its requested partition");
      }
      threadEvents.push(chatEventRowFromDbRow(row));
    }

    return { events, notFoundThreads };
  });
}

/** Resolve the current persisted Snapshot pointer. */
export function chatThreadEventSnapshot(args: {
  readonly threadId: string;
  readonly userId: string;
  readonly orgId?: string;
}) {
  return command(
    async (
      { get, set },
      signal: AbortSignal,
    ): Promise<ChatEventSnapshotDownload> => {
      const db = get(db$);
      const [owned] = await db
        .select({ id: chatThreads.id })
        .from(chatThreads)
        .where(ownedThread(args.threadId, args.userId, args.orgId))
        .limit(1);
      signal.throwIfAborted();
      if (!owned) {
        return { kind: "thread-not-found" } as const;
      }

      let pointer = await set(currentSnapshotPointer$, args.threadId);
      signal.throwIfAborted();
      if (pointer === null) {
        return { kind: "snapshot-not-found" };
      }
      if (!isCurrentChatEventSnapshotObjectKey(pointer.objectKey)) {
        if (!isLegacyChatEventSnapshotObjectKey(pointer.objectKey)) {
          throw new Error(
            "Chat Event Snapshot has an unsupported contract revision",
          );
        }
        await set(refreshChatEventSnapshotThread$, args.threadId, signal);
        pointer = await set(currentSnapshotPointer$, args.threadId);
        signal.throwIfAborted();
        if (
          pointer === null ||
          !isCurrentChatEventSnapshotObjectKey(pointer.objectKey)
        ) {
          throw new Error(
            "Chat Event Snapshot contract repair did not publish",
          );
        }
      }

      const url = await get(
        generatePresignedGetUrl(
          env("R2_USER_STORAGES_BUCKET_NAME"),
          pointer.objectKey,
        ),
      );
      signal.throwIfAborted();
      return {
        kind: "ok",
        url,
        expiresInSeconds: SNAPSHOT_URL_TTL_SECONDS,
        lastEventId: pointer.lastEventId,
        lastSeqId: pointer.lastSeqId,
      };
    },
  );
}

/**
 * Raw-row tail after a paired cursor. A missing cursor row means the range
 * below it is unavailable and the client has to rebuild from a fresh
 * Snapshot. `sinceSeqId: 0` remains the cold start for a thread that has never
 * had a Snapshot.
 */
