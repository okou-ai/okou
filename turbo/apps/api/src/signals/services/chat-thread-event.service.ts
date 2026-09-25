import { randomUUID } from "node:crypto";
import { z } from "zod";
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

import type { Db, ReadonlyDb } from "../external/db";
import { executeRawRows } from "../../lib/db-raw-rows";
import type { Tx } from "../../lib/db-types";

// Control operations still own transactions; ordinary appends own one statement.
export type ChatThreadEventTransaction = Tx;
type ChatThreadEventWriter = Db | Tx;
const CHAT_THREAD_EVENTS_PAGE_SIZE = 1000;
const cursorChatThreadEvent = alias(
  chatThreadEvents,
  "cursor_chat_thread_event",
);
const pageChatThreadEvent = alias(chatThreadEvents, "page_chat_thread_event");

interface ChatThreadEventAppend {
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
}

export class ChatThreadEventIdConflictError extends Error {
  constructor() {
    super("Chat thread event id is already in use");
    this.name = "ChatThreadEventIdConflictError";
  }
}

async function insertChatThreadEvent(
  db: ChatThreadEventWriter,
  args: ChatThreadEventAppend,
  strict: boolean,
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

  // Sequence allocation and insertion commit together even without an outer
  // transaction. A deliberate id conflict may leave a sequence gap.
  const inserted = await executeRawRows(
    db,
    sql`WITH reserved AS (
      INSERT INTO ${chatThreadEventSequences} (user_id, org_id, last_seq_id)
      VALUES (${args.userId}, ${orgId}, 1)
      ON CONFLICT (user_id, org_id) DO UPDATE
      SET last_seq_id = ${chatThreadEventSequences.lastSeqId} + 1
      RETURNING last_seq_id
    )
    INSERT INTO ${chatThreadEvents} (
      id, user_id, org_id, seq_id, chat_thread_id, kind, agent_id, title,
      pin_order, selected_model, model_settings, model_settings_patch,
      service_tier, computer_use_host_id, cloud_browser_enabled,
      selected_video_model, selected_image_model, created_at
    ) SELECT
      ${args.eventId ?? randomUUID()}::uuid, ${args.userId}, ${orgId}, last_seq_id,
      ${args.chatThreadId}::uuid, ${args.kind}::chat_thread_event_kind,
      ${args.agentId}::uuid, ${args.title ?? null}, ${args.pinOrder ?? null},
      ${args.selectedModel ?? null},
      ${args.modelSettings === undefined ? null : JSON.stringify(args.modelSettings)}::jsonb,
      ${args.modelSettingsPatch === undefined ? null : JSON.stringify(args.modelSettingsPatch)}::jsonb,
      ${args.serviceTier ?? null}, ${args.computerUseHostId ?? null}::uuid,
      ${args.cloudBrowserEnabled ?? false}, ${args.selectedVideoModel ?? null},
      ${args.selectedImageModel ?? null},
      COALESCE(${args.createdAt?.toISOString() ?? null}::timestamp, timezone('UTC', now()))
    FROM reserved
    ON CONFLICT (id) DO NOTHING
    RETURNING id`,
    z.object({ id: z.string().uuid() }),
  );
  if (strict && inserted.length === 0) {
    throw new ChatThreadEventIdConflictError();
  }
}

export async function appendChatThreadEvent(
  db: ChatThreadEventWriter,
  args: ChatThreadEventAppend,
): Promise<void> {
  await insertChatThreadEvent(db, args, false);
}

/** A conflicting event id aborts the caller's transaction instead of dropping projection evidence. */
export async function appendChatThreadEventStrict(
  db: ChatThreadEventWriter,
  args: ChatThreadEventAppend & { readonly eventId: string },
): Promise<void> {
  await insertChatThreadEvent(db, args, true);
}

/**
 * Returns the caller's R2 snapshot pointer, or null when the scope has no
 * snapshot row yet (compaction only publishes scopes that own chat threads).
 */
export async function getChatThreadSnapshot(
  db: ReadonlyDb,
  args: {
    readonly userId: string;
    readonly orgId: string;
  },
): Promise<{
  readonly objectKey: string;
  readonly latestEventId: string | null;
  readonly latestSeqId: number | null;
} | null> {
  const [snapshot] = await db
    .select({
      objectKey: chatThreadSnapshots.objectKey,
      latestEventId: chatThreadSnapshots.latestEventId,
      latestSeqId: chatThreadSnapshots.latestEventSeqId,
    })
    .from(chatThreadSnapshots)
    .where(
      and(
        eq(chatThreadSnapshots.userId, args.userId),
        eq(chatThreadSnapshots.orgId, args.orgId),
      ),
    )
    .limit(1);
  if (!snapshot) {
    return null;
  }
  if (!snapshot.objectKey) {
    // The R2 backfill drained every legacy JSONB row (#36375) and compaction
    // only publishes rows with an object key.
    throw new Error("Chat thread snapshot row has no R2 object key");
  }
  return {
    objectKey: snapshot.objectKey,
    latestEventId: snapshot.latestEventId,
    latestSeqId: snapshot.latestSeqId,
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
