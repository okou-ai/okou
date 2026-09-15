import {
  modelSettingsPatchSchema,
  modelSettingsSchema,
  type ModelSettings,
  type ModelSettingsPatch,
} from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { and, asc, eq, exists, gt, notExists, sql } from "drizzle-orm";
import { alias, unionAll } from "drizzle-orm/pg-core";
import type {
  ChatThreadEvent,
  ChatThreadServiceTier,
  ChatThreadSnapshotProjection,
  CodexServiceTier,
} from "@okouai/api-contracts/contracts/chat-threads";
import type { ImageModelId } from "@okouai/api-contracts/contracts/image-models";
import { agents } from "@okouai/db/schema/agent";
import {
  chatThreadEventSequences,
  chatThreadEvents,
  type ChatThreadEventKind,
} from "@okouai/db/schema/chat-thread-event";
import { chatThreadSnapshots } from "@okouai/db/schema/chat-thread-snapshot";

import type { ReadonlyDb } from "../external/db";
import type { Tx } from "../../lib/db-types";

// The sequence row lock must remain held until its event becomes visible.
// Requiring a transaction prevents callers from splitting those two commits.
export type ChatThreadEventTransaction = Tx;
const CHAT_THREAD_EVENTS_PAGE_SIZE = 1000;
const cursorChatThreadEvent = alias(
  chatThreadEvents,
  "cursor_chat_thread_event",
);
const pageChatThreadEvent = alias(chatThreadEvents, "page_chat_thread_event");

async function reserveChatThreadEventSeqId(
  db: ChatThreadEventTransaction,
  userId: string,
  orgId: string,
): Promise<number> {
  const [sequence] = await db
    .insert(chatThreadEventSequences)
    .values({
      userId,
      orgId,
      lastSeqId: 1,
    })
    .onConflictDoUpdate({
      target: [chatThreadEventSequences.userId, chatThreadEventSequences.orgId],
      set: {
        lastSeqId: sql`${chatThreadEventSequences.lastSeqId} + 1`,
      },
    })
    .returning({ seqId: chatThreadEventSequences.lastSeqId });
  if (!sequence) {
    throw new Error("Unable to reserve chat thread event seq_id");
  }
  return sequence.seqId;
}

export async function appendChatThreadEvent(
  db: ChatThreadEventTransaction,
  args: {
    readonly kind: ChatThreadEventKind;
    readonly userId: string;
    readonly orgId?: string | null;
    readonly chatThreadId: string;
    readonly agentId: string;
    readonly eventId?: string;
    readonly title?: string | null;
    readonly pinOrder?: string | null;
    readonly selectedModel?: string | null;
    readonly modelSettings?: ModelSettings;
    readonly modelSettingsPatch?: ModelSettingsPatch;
    readonly serviceTier?: ChatThreadServiceTier | null;
    readonly computerUseHostId?: string | null;
    readonly cloudBrowserEnabled?: boolean;
    readonly selectedVideoModel?: string | null;
    readonly selectedImageModel?: ImageModelId | null;
    readonly createdAt?: Date;
  },
): Promise<void> {
  let orgId = args.orgId ?? undefined;
  if (orgId === undefined) {
    const [compose] = await db
      .select({ orgId: agents.orgId })
      .from(agents)
      .where(eq(agents.id, args.agentId))
      .limit(1);
    orgId = compose?.orgId;
  }

  if (orgId === undefined) {
    throw new Error("Unable to resolve org for chat thread event");
  }

  const seqId = await reserveChatThreadEventSeqId(db, args.userId, orgId);

  await db
    .insert(chatThreadEvents)
    .values({
      ...(args.eventId !== undefined ? { id: args.eventId } : {}),
      userId: args.userId,
      orgId,
      seqId,
      chatThreadId: args.chatThreadId,
      kind: args.kind,
      agentId: args.agentId,
      title: args.title ?? null,
      pinOrder: args.pinOrder ?? null,
      selectedModel: args.selectedModel ?? null,
      modelSettings: args.modelSettings,
      modelSettingsPatch: args.modelSettingsPatch,
      serviceTier: args.serviceTier ?? null,
      computerUseHostId: args.computerUseHostId ?? null,
      cloudBrowserEnabled: args.cloudBrowserEnabled ?? false,
      selectedVideoModel: args.selectedVideoModel ?? null,
      selectedImageModel: args.selectedImageModel ?? null,
      ...(args.createdAt !== undefined ? { createdAt: args.createdAt } : {}),
    })
    .onConflictDoNothing({ target: chatThreadEvents.id });
}

export async function getChatThreadSnapshot(
  db: ReadonlyDb,
  args: {
    readonly userId: string;
    readonly orgId: string;
  },
): Promise<{
  readonly chatThreads: readonly ChatThreadSnapshotProjection[];
  readonly latestEventId: string | null;
  readonly latestSeqId: number | null;
}> {
  const [snapshot] = await db
    .select({
      latestEventId: chatThreadSnapshots.latestEventId,
      latestSeqId: chatThreadSnapshots.latestEventSeqId,
      chatThreads: chatThreadSnapshots.chatThreads,
    })
    .from(chatThreadSnapshots)
    .where(
      and(
        eq(chatThreadSnapshots.userId, args.userId),
        eq(chatThreadSnapshots.orgId, args.orgId),
      ),
    )
    .limit(1);

  return {
    chatThreads:
      snapshot?.chatThreads.map((thread) => {
        return {
          ...thread,
          selectedModel: thread.selectedModel ?? null,
          modelSettings: modelSettingsSchema.parse(thread.modelSettings ?? {}),
          serviceTier: thread.serviceTier ?? null,
          computerUseHostId: thread.computerUseHostId ?? null,
          cloudBrowserEnabled: thread.cloudBrowserEnabled ?? false,
          selectedVideoModel: thread.selectedVideoModel,
          // Snapshot rows compacted before image-model persistence have no key.
          // Keep hydration compatible until those rows and older browser caches
          // have been replaced. Follow-up:
          // https://github.com/vm0-ai/vm0/issues/27688
          selectedImageModel: thread.selectedImageModel ?? null,
        };
      }) ?? [],
    latestEventId: snapshot?.latestEventId ?? null,
    latestSeqId: snapshot?.latestSeqId ?? null,
  };
}

type ChatThreadEventRow = {
  readonly id: string;
  readonly seqId: number;
  readonly kind: ChatThreadEventKind;
  readonly chatThreadId: string;
  readonly agentId: string | null;
  readonly title: string | null;
  readonly pinOrder: string | null;
  readonly selectedModel: string | null;
  readonly modelSettings: ModelSettings | null;
  readonly modelSettingsPatch: ModelSettingsPatch | null;
  readonly serviceTier: ChatThreadServiceTier | null;
  readonly computerUseHostId: string | null;
  readonly cloudBrowserEnabled: boolean;
  readonly selectedVideoModel: string | null;
  readonly selectedImageModel: string | null;
  readonly createdAt: Date;
};

const chatThreadEventSelection = Object.freeze({
  id: chatThreadEvents.id,
  seqId: chatThreadEvents.seqId,
  kind: chatThreadEvents.kind,
  chatThreadId: chatThreadEvents.chatThreadId,
  agentId: chatThreadEvents.agentId,
  title: chatThreadEvents.title,
  pinOrder: chatThreadEvents.pinOrder,
  selectedModel: chatThreadEvents.selectedModel,
  modelSettings: chatThreadEvents.modelSettings,
  modelSettingsPatch: chatThreadEvents.modelSettingsPatch,
  serviceTier: chatThreadEvents.serviceTier,
  computerUseHostId: chatThreadEvents.computerUseHostId,
  cloudBrowserEnabled: chatThreadEvents.cloudBrowserEnabled,
  selectedVideoModel: chatThreadEvents.selectedVideoModel,
  selectedImageModel: chatThreadEvents.selectedImageModel,
  createdAt: chatThreadEvents.createdAt,
});

const pageChatThreadEventSelection = Object.freeze({
  id: pageChatThreadEvent.id,
  seqId: pageChatThreadEvent.seqId,
  kind: pageChatThreadEvent.kind,
  chatThreadId: pageChatThreadEvent.chatThreadId,
  agentId: pageChatThreadEvent.agentId,
  title: pageChatThreadEvent.title,
  pinOrder: pageChatThreadEvent.pinOrder,
  selectedModel: pageChatThreadEvent.selectedModel,
  modelSettings: pageChatThreadEvent.modelSettings,
  modelSettingsPatch: pageChatThreadEvent.modelSettingsPatch,
  serviceTier: pageChatThreadEvent.serviceTier,
  computerUseHostId: pageChatThreadEvent.computerUseHostId,
  cloudBrowserEnabled: pageChatThreadEvent.cloudBrowserEnabled,
  selectedVideoModel: pageChatThreadEvent.selectedVideoModel,
  selectedImageModel: pageChatThreadEvent.selectedImageModel,
  createdAt: pageChatThreadEvent.createdAt,
});

export function chatThreadServiceTierFromCodex(
  codexServiceTier: CodexServiceTier | null,
): ChatThreadServiceTier | null {
  return codexServiceTier === "fast" ? "priority" : null;
}

function hasCanonicalAgentReference(
  row: ChatThreadEventRow,
): row is ChatThreadEventRow & { readonly agentId: string } {
  return row.agentId !== null;
}

function toApiChatThreadEvent(
  row: ChatThreadEventRow & { readonly agentId: string },
): ChatThreadEvent {
  return {
    id: row.id,
    seqId: row.seqId,
    kind: row.kind,
    chatThreadId: row.chatThreadId,
    agentId: row.agentId,
    title: row.title,
    pinOrder: row.pinOrder,
    selectedModel: row.selectedModel,
    ...(row.modelSettings === null
      ? {}
      : { modelSettings: modelSettingsSchema.parse(row.modelSettings) }),
    ...(row.modelSettingsPatch === null
      ? {}
      : {
          modelSettingsPatch: modelSettingsPatchSchema.parse(
            row.modelSettingsPatch,
          ),
        }),
    serviceTier: row.serviceTier,
    computerUseHostId: row.computerUseHostId,
    cloudBrowserEnabled: row.cloudBrowserEnabled,
    selectedVideoModel: row.selectedVideoModel,
    selectedImageModel: row.selectedImageModel,
    createdAt: row.createdAt.toISOString(),
  };
}

async function getChatThreadEventRowsAfterCursor(
  db: ReadonlyDb,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly sinceSeqId: number;
  },
): Promise<readonly ChatThreadEventRow[] | null> {
  const validCursor = db.$with("valid_cursor").as(
    unionAll(
      db
        .select({ seqId: cursorChatThreadEvent.seqId })
        .from(cursorChatThreadEvent)
        .where(
          and(
            eq(cursorChatThreadEvent.userId, args.userId),
            eq(cursorChatThreadEvent.orgId, args.orgId),
            eq(cursorChatThreadEvent.seqId, args.sinceSeqId),
            // Snapshot advancement must not invalidate retained event cursors.
            // Exclude only the exact watermark so the union branches stay disjoint.
            notExists(
              db
                .select({ userId: chatThreadSnapshots.userId })
                .from(chatThreadSnapshots)
                .where(
                  and(
                    eq(chatThreadSnapshots.userId, args.userId),
                    eq(chatThreadSnapshots.orgId, args.orgId),
                    eq(chatThreadSnapshots.latestEventSeqId, args.sinceSeqId),
                  ),
                ),
            ),
          ),
        ),
      db
        .select({
          seqId: sql`${chatThreadSnapshots.latestEventSeqId}`
            .mapWith(chatThreadEvents.seqId)
            .as("seq_id"),
        })
        .from(chatThreadSnapshots)
        .where(
          and(
            eq(chatThreadSnapshots.userId, args.userId),
            eq(chatThreadSnapshots.orgId, args.orgId),
            eq(chatThreadSnapshots.latestEventSeqId, args.sinceSeqId),
          ),
        ),
    ),
  );

  // Validation and page selection share one statement snapshot so a cursor
  // cannot cross an append or compaction boundary between the two checks.
  const cursorRows = await db
    .with(validCursor)
    .select({ event: pageChatThreadEventSelection })
    .from(validCursor)
    .leftJoin(
      pageChatThreadEvent,
      and(
        eq(pageChatThreadEvent.userId, args.userId),
        eq(pageChatThreadEvent.orgId, args.orgId),
        gt(pageChatThreadEvent.seqId, validCursor.seqId),
        exists(
          db
            .select({ id: agents.id })
            .from(agents)
            .where(eq(agents.id, pageChatThreadEvent.agentId)),
        ),
      ),
    )
    .orderBy(asc(pageChatThreadEvent.seqId))
    .limit(CHAT_THREAD_EVENTS_PAGE_SIZE + 1);
  if (cursorRows.length === 0) {
    return null;
  }
  return cursorRows.flatMap((row) => {
    return row.event ? [row.event] : [];
  });
}

export async function getChatThreadEventsSince(
  db: ReadonlyDb,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly sinceSeqId?: number;
  },
): Promise<
  | {
      readonly kind: "ok";
      readonly events: readonly ChatThreadEvent[];
      readonly hasMore: boolean;
    }
  | { readonly kind: "expired" }
> {
  let rows: readonly ChatThreadEventRow[];
  if (args.sinceSeqId !== undefined) {
    const cursorRows = await getChatThreadEventRowsAfterCursor(db, {
      userId: args.userId,
      orgId: args.orgId,
      sinceSeqId: args.sinceSeqId,
    });
    if (cursorRows === null) {
      return { kind: "expired" };
    }
    rows = cursorRows;
  } else {
    rows = await db
      .select(chatThreadEventSelection)
      .from(chatThreadEvents)
      .where(
        and(
          eq(chatThreadEvents.userId, args.userId),
          eq(chatThreadEvents.orgId, args.orgId),
          exists(
            db
              .select({ id: agents.id })
              .from(agents)
              .where(eq(agents.id, chatThreadEvents.agentId)),
          ),
        ),
      )
      .orderBy(asc(chatThreadEvents.seqId))
      .limit(CHAT_THREAD_EVENTS_PAGE_SIZE + 1);
  }

  const visibleRows = rows.filter(hasCanonicalAgentReference);
  return {
    kind: "ok",
    events: visibleRows
      .slice(0, CHAT_THREAD_EVENTS_PAGE_SIZE)
      .map(toApiChatThreadEvent),
    hasMore: visibleRows.length > CHAT_THREAD_EVENTS_PAGE_SIZE,
  };
}
