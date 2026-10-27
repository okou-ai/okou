import {
  chatEventRowSchema,
  type ChatEventRow,
} from "@okouai/api-contracts/contracts/chat-event-rows";
import {
  CURRENT_CHAT_EVENT_SCHEMA_VERSION,
  type ChatEventCursor,
} from "@okouai/api-contracts/contracts/chat-event-schema-version";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { agents } from "@okouai/db/schema/agent";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatEventSnapshots } from "@okouai/db/schema/chat-event-snapshot";
import { runOutputMaterializations } from "@okouai/db/schema/run-output-materialization";
import { command, computed, type Computed } from "ccstate";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  isNotNull,
  lte,
  not,
  sql,
} from "drizzle-orm";
import { db$ } from "../external/db";
import { canonicalChatEventContent } from "./canonical-chat-event-read.service";
import { chatEventTypeIn } from "./chat-event-type.service";

export interface CompletedRunOutput {
  readonly latestAssistant: {
    readonly sequenceNumber: number;
    readonly content: string;
  } | null;
  readonly resultFallback: {
    readonly sequenceNumber: number;
    readonly content: string;
  } | null;
}

/** The callback observes cancellation after timing this complete read batch. */
export const loadCompletedRunOutput$ = command(
  async (
    { get },
    args: {
      readonly runId: string;
      readonly lastEventSequence: number | null;
    },
  ): Promise<CompletedRunOutput> => {
    if (args.lastEventSequence === null) {
      return { latestAssistant: null, resultFallback: null };
    }

    const db = get(db$);
    const [state] = await db
      .select({
        latestResultSequence: runOutputMaterializations.latestResultSequence,
        latestResultText: runOutputMaterializations.latestResultText,
      })
      .from(runOutputMaterializations)
      .where(eq(runOutputMaterializations.runId, args.runId))
      .limit(1);

    const [event] = await db
      .select({
        content: canonicalChatEventContent(),
        sequenceNumber: chatEvents.runEventSequenceNumber,
      })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.runId, args.runId),
          chatEventTypeIn(["output.message"]),
          isNotNull(chatEvents.runEventSequenceNumber),
          isNotNull(canonicalChatEventContent()),
          not(sql`${canonicalChatEventContent()} ~ '^[[:space:]]*$'`),
          lte(chatEvents.runEventSequenceNumber, args.lastEventSequence),
        ),
      )
      .orderBy(desc(chatEvents.runEventSequenceNumber))
      .limit(1);

    const latestAssistant =
      !event || event.content === null || event.sequenceNumber === null
        ? null
        : { content: event.content, sequenceNumber: event.sequenceNumber };
    const resultFallback =
      state?.latestResultSequence !== null &&
      state?.latestResultSequence !== undefined &&
      state.latestResultSequence <= args.lastEventSequence &&
      state.latestResultText !== null
        ? {
            sequenceNumber: state.latestResultSequence,
            content: state.latestResultText,
          }
        : null;
    return { latestAssistant, resultFallback };
  },
);

const THREAD_START_SEQ_ID = 0;

const chatEventRowSelection = {
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
} as const;

export const ARCHIVE_ROW_CONTRACT_REVISION = 1;
const ARCHIVE_OBJECT_KEY_PREFIX_PATTERN = "^chat-events/[0-9a-f-]{36}/[0-9]+";
const ARCHIVE_OBJECT_KEY_SUFFIX_PATTERN = "-[0-9a-f]{64}[.]ndjson[.]gz$";
export const LEGACY_ARCHIVE_OBJECT_KEY_PATTERN = `${ARCHIVE_OBJECT_KEY_PREFIX_PATTERN}${ARCHIVE_OBJECT_KEY_SUFFIX_PATTERN}`;
const CURRENT_ARCHIVE_OBJECT_KEY_PATTERN = `${ARCHIVE_OBJECT_KEY_PREFIX_PATTERN}-r${ARCHIVE_ROW_CONTRACT_REVISION.toString()}${ARCHIVE_OBJECT_KEY_SUFFIX_PATTERN}`;
export function isCurrentChatEventSnapshotObjectKey(
  objectKey: string,
): boolean {
  return new RegExp(CURRENT_ARCHIVE_OBJECT_KEY_PATTERN, "u").test(objectKey);
}

export function isLegacyChatEventSnapshotObjectKey(objectKey: string): boolean {
  return new RegExp(LEGACY_ARCHIVE_OBJECT_KEY_PATTERN, "u").test(objectKey);
}

export function chatEventRowFromDbRow(
  row: Pick<typeof chatEvents.$inferSelect, keyof typeof chatEventRowSelection>,
): ChatEventRow {
  return chatEventRowSchema.parse({
    id: row.id,
    chatThreadId: row.chatThreadId,
    runId: row.runId,
    revokesEventId: row.revokesEventId,
    eventType: row.eventType,
    payload: row.payload,
    ...(row.failureReason === null ? {} : { failureReason: row.failureReason }),
    contextType: row.contextType,
    contextId: row.contextId,
    runEventSequenceNumber: row.runEventSequenceNumber,
    runEventId: row.runEventId,
    seqId: row.seqId,
    createdAt: row.createdAt.toISOString(),
  });
}

type ChatEventRowsPage =
  | { readonly kind: "thread-not-found" }
  | { readonly kind: "expired" }
  | {
      readonly kind: "ok";
      readonly rows: readonly ChatEventRow[];
      readonly cursor: ChatEventCursor;
      readonly hasMore: boolean;
    };

interface ChatEventRowsBaseArgs {
  readonly threadId: string;
  readonly userId: string;
  readonly orgId?: string;
  readonly limit: number;
}

type ChatEventRowsArgs = ChatEventRowsBaseArgs &
  (
    | { readonly sinceSeqId: 0; readonly sinceEventId?: never }
    | {
        readonly sinceSeqId: number;
        readonly sinceEventId: string;
      }
  );

export const ownedThread = (
  threadId: string,
  userId: string,
  orgId?: string,
) => {
  return and(
    eq(chatThreads.id, threadId),
    eq(chatThreads.userId, userId),
    orgId === undefined
      ? undefined
      : exists(sql`(SELECT 1 FROM ${agents}
      WHERE ${eq(agents.id, chatThreads.agentId)} AND ${eq(agents.orgId, orgId)})`),
  );
};

interface SnapshotPointer {
  readonly objectKey: string;
  readonly lastEventId: string | null;
  readonly lastSeqId: number;
}

export const currentSnapshotPointer$ = command(
  async ({ get }, threadId: string): Promise<SnapshotPointer | null> => {
    const [pointer] = await get(db$)
      .select({
        objectKey: chatEventSnapshots.objectKey,
        lastEventId: chatEventSnapshots.terminalEventId,
        lastSeqId: chatEventSnapshots.terminalSeqId,
      })
      .from(chatEventSnapshots)
      .where(
        and(
          eq(chatEventSnapshots.chatThreadId, threadId),
          eq(
            chatEventSnapshots.archiveSchemaVersion,
            CURRENT_CHAT_EVENT_SCHEMA_VERSION,
          ),
        ),
      )
      .limit(1);
    if (pointer === undefined) {
      return null;
    }
    if (
      pointer.lastSeqId === null ||
      !(
        (pointer.lastSeqId === THREAD_START_SEQ_ID &&
          pointer.lastEventId === null) ||
        (pointer.lastSeqId > THREAD_START_SEQ_ID &&
          pointer.lastEventId !== null)
      )
    ) {
      throw new Error("Current Chat Event Snapshot cursor is incomplete");
    }
    return { ...pointer, lastSeqId: pointer.lastSeqId };
  },
);

function cursorMatches(
  cursor: { readonly lastEventId: string | null; readonly lastSeqId: number },
  args: ChatEventRowsArgs,
): boolean {
  return (
    cursor.lastSeqId === args.sinceSeqId &&
    cursor.lastEventId ===
      (args.sinceSeqId === THREAD_START_SEQ_ID ? null : args.sinceEventId)
  );
}

interface CurrentSnapshotCursor {
  readonly lastEventId: string | null;
  readonly lastSeqId: number | null;
  readonly physicalLastSeqId: number;
}

function currentSnapshotCursor(
  args: ChatEventRowsArgs,
): Computed<Promise<CurrentSnapshotCursor | undefined>> {
  return computed(async (get) => {
    const [snapshot] = await get(db$)
      .select({
        lastEventId: chatEventSnapshots.terminalEventId,
        lastSeqId: chatEventSnapshots.terminalSeqId,
        physicalLastSeqId: chatEventSnapshots.lastSeqId,
      })
      .from(chatEventSnapshots)
      .where(
        and(
          eq(chatEventSnapshots.chatThreadId, args.threadId),
          eq(
            chatEventSnapshots.archiveSchemaVersion,
            CURRENT_CHAT_EVENT_SCHEMA_VERSION,
          ),
        ),
      )
      .limit(1);
    return snapshot;
  });
}

function currentSnapshotContinuation(
  current: CurrentSnapshotCursor | undefined,
  args: ChatEventRowsArgs,
): number | undefined {
  if (
    current === undefined ||
    current.lastSeqId === null ||
    !cursorMatches(
      { lastEventId: current.lastEventId, lastSeqId: current.lastSeqId },
      args,
    )
  ) {
    return undefined;
  }
  return current.physicalLastSeqId;
}

function cursorContinuationSeqId(
  args: ChatEventRowsArgs,
): Computed<Promise<number | null>> {
  return computed(async (get) => {
    const currentSnapshot = await get(currentSnapshotCursor(args));
    const currentContinuation = currentSnapshotContinuation(
      currentSnapshot,
      args,
    );
    if (currentContinuation !== undefined) {
      return currentContinuation;
    }
    // The cold-start cursor precedes every event, so it owns no row. It is
    // valid only while nothing has ever been archived; once any Snapshot exists
    // the client must start from that Snapshot's paired cursor.
    if (
      args.sinceSeqId === THREAD_START_SEQ_ID &&
      currentSnapshot === undefined
    ) {
      return THREAD_START_SEQ_ID;
    }
    if (args.sinceSeqId === THREAD_START_SEQ_ID) {
      return null;
    }
    const [physicalCursorRow] = await get(db$)
      .select({ id: chatEvents.id })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.chatThreadId, args.threadId),
          eq(chatEvents.seqId, args.sinceSeqId),
        ),
      )
      .limit(1);
    return physicalCursorRow?.id === args.sinceEventId ? args.sinceSeqId : null;
  });
}

export function chatThreadEventRows(
  args: ChatEventRowsArgs,
): Computed<Promise<ChatEventRowsPage>> {
  return computed(async (get) => {
    const db = get(db$);
    const [owned] = await db
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(ownedThread(args.threadId, args.userId, args.orgId))
      .limit(1);
    if (!owned) {
      return { kind: "thread-not-found" } as const;
    }
    const continuationSeqId = await get(cursorContinuationSeqId(args));
    if (continuationSeqId === null) {
      return { kind: "expired" } as const;
    }

    const physicalRows = await db
      .select(chatEventRowSelection)
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.chatThreadId, args.threadId),
          gt(chatEvents.seqId, continuationSeqId),
        ),
      )
      .orderBy(asc(chatEvents.seqId))
      .limit(args.limit);

    const rows = physicalRows.map(chatEventRowFromDbRow);
    const cursorLast = rows.at(-1);
    const priorCursor: ChatEventCursor =
      args.sinceSeqId === THREAD_START_SEQ_ID
        ? { lastEventId: null, lastSeqId: THREAD_START_SEQ_ID }
        : "sinceEventId" in args && args.sinceEventId !== undefined
          ? {
              lastEventId: args.sinceEventId,
              lastSeqId: args.sinceSeqId,
            }
          : (() => {
              throw new Error("Positive Chat Event cursor is missing its ID");
            })();
    const cursor: ChatEventCursor =
      cursorLast === undefined
        ? priorCursor
        : {
            lastEventId: cursorLast.id,
            lastSeqId: cursorLast.seqId,
          };

    return {
      kind: "ok",
      rows,
      cursor,
      hasMore: physicalRows.length === args.limit,
    } as const;
  });
}
