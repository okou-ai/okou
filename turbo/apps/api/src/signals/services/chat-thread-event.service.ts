import { randomUUID } from "node:crypto";
import {
  modelSettingsPatchSchema,
  modelSettingsSchema,
  type ModelSettings,
  type ModelSettingsPatch,
} from "@okouai/api-contracts/contracts/model-reasoning-effort";
import {
  and,
  asc,
  eq,
  exists,
  gt,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias, unionAll } from "drizzle-orm/pg-core";
import type {
  ChatThreadEvent,
  ChatThreadServiceTier,
  CodexServiceTier,
} from "@okouai/api-contracts/contracts/chat-threads";
import { agents } from "@okouai/db/schema/agent";
import {
  chatThreadEventSequences,
  chatThreadEvents,
  type ChatThreadEventKind,
} from "@okouai/db/schema/chat-thread-event";
import { chatThreadSnapshots } from "@okouai/db/schema/chat-thread-snapshot";

import { computed } from "ccstate";
import { db$ } from "../external/db";
import type { Tx } from "../../lib/db-types";

// Control operations still own transactions; ordinary appends own one statement.
export type ChatThreadEventTransaction = Tx;
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
  readonly reassignedAgentId?: string;
  readonly eventId?: string;
  readonly title?: string | null;
  readonly pinOrder?: string | null;
  readonly selectedModel?: string | null;
  readonly modelSettings?: ModelSettings;
  readonly modelSettingsPatch?: ModelSettingsPatch;
  readonly serviceTier?: ChatThreadServiceTier | null;
  readonly computerUseHostId?: string | null;
  readonly cloudBrowserEnabled?: boolean;
  readonly createdAt?: Date;
}

/** Pure statement preparation; the owning command executes and commits it. */
export function chatThreadEventInsertSql(
  args: Omit<ChatThreadEventAppend, "agentId"> & {
    readonly agentId?: string;
  },
  source?: {
    readonly cte: SQL;
    readonly gate: SQL;
    readonly agentId: SQL;
    readonly result?: SQL;
  },
) {
  let agentId: SQL;
  if (source) {
    agentId = source.agentId;
  } else {
    if (args.agentId === undefined) {
      throw new Error("Chat thread event requires an agent identity");
    }
    agentId = sql`${args.agentId}`;
  }
  // The scalar lookup executes as part of the owning statement, not in a
  // handle-taking helper. A missing authority fails the non-null org insert.
  const orgId =
    args.orgId === null || args.orgId === undefined
      ? sql`(SELECT ${agents.orgId} FROM ${agents} WHERE ${agents.id} = ${agentId}::uuid)`
      : sql`${args.orgId}`;
  const beforeReservation = source ? sql`${source.cte},` : sql.empty();
  const reservationInput = source
    ? sql`SELECT ${args.userId}, ${orgId}, 1 WHERE ${source.gate}`
    : sql`VALUES (${args.userId}, ${orgId}, 1)`;
  const reservation = sql`reserved AS (
      INSERT INTO ${chatThreadEventSequences} (user_id, org_id, last_seq_id)
      ${reservationInput}
      ON CONFLICT (user_id, org_id) DO UPDATE
      SET last_seq_id = ${chatThreadEventSequences.lastSeqId} + 1
      RETURNING last_seq_id
    )`;
  const insertion = sql`INSERT INTO ${chatThreadEvents} (
      id, user_id, org_id, seq_id, chat_thread_id, kind, agent_id,
      reassigned_agent_id, title,
      pin_order, selected_model, model_settings, model_settings_patch,
      service_tier, computer_use_host_id, cloud_browser_enabled, created_at
    ) SELECT
      ${args.eventId ?? randomUUID()}::uuid, ${args.userId}, ${orgId}, last_seq_id,
      ${args.chatThreadId}::uuid, ${args.kind}::chat_thread_event_kind,
      ${agentId}::uuid, ${args.reassignedAgentId ?? null}::uuid,
      ${args.title ?? null}, ${args.pinOrder ?? null},
      ${args.selectedModel ?? null},
      ${args.modelSettings === undefined ? null : JSON.stringify(args.modelSettings)}::jsonb,
      ${args.modelSettingsPatch === undefined ? null : JSON.stringify(args.modelSettingsPatch)}::jsonb,
      ${args.serviceTier ?? null}, ${args.computerUseHostId ?? null}::uuid,
      ${args.cloudBrowserEnabled ?? false},
      COALESCE(${args.createdAt ? args.createdAt.toISOString() : null}::timestamp, timezone('UTC', now()))
    FROM reserved
    ON CONFLICT (id) DO NOTHING
    RETURNING id`;
  if (source?.result !== undefined) {
    return sql`WITH ${beforeReservation} ${reservation}, inserted AS (${insertion}) ${source.result}`;
  }
  return sql`WITH ${beforeReservation} ${reservation} ${insertion}`;
}

/**
 * Returns the caller's R2 snapshot pointer, or null when the scope has no
 * snapshot row yet (compaction only publishes scopes that own chat threads).
 */
export function getChatThreadSnapshot(args: {
  readonly userId: string;
  readonly orgId: string;
}) {
  return computed(
    async (
      get,
    ): Promise<{
      readonly objectKey: string;
      readonly latestEventId: string | null;
      readonly latestSeqId: number | null;
    } | null> => {
      const [snapshot] = await get(db$)
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
    },
  );
}

type ChatThreadEventRow = {
  readonly id: string;
  readonly seqId: number;
  readonly kind: ChatThreadEventKind;
  readonly chatThreadId: string;
  readonly agentId: string | null;
  readonly reassignedAgentId: string | null;
  readonly title: string | null;
  readonly pinOrder: string | null;
  readonly selectedModel: string | null;
  readonly modelSettings: ModelSettings | null;
  readonly modelSettingsPatch: ModelSettingsPatch | null;
  readonly serviceTier: ChatThreadServiceTier | null;
  readonly computerUseHostId: string | null;
  readonly cloudBrowserEnabled: boolean;
  readonly createdAt: Date;
};

const chatThreadEventSelection = Object.freeze({
  id: chatThreadEvents.id,
  seqId: chatThreadEvents.seqId,
  kind: chatThreadEvents.kind,
  chatThreadId: chatThreadEvents.chatThreadId,
  agentId: chatThreadEvents.agentId,
  reassignedAgentId: chatThreadEvents.reassignedAgentId,
  title: chatThreadEvents.title,
  pinOrder: chatThreadEvents.pinOrder,
  selectedModel: chatThreadEvents.selectedModel,
  modelSettings: chatThreadEvents.modelSettings,
  modelSettingsPatch: chatThreadEvents.modelSettingsPatch,
  serviceTier: chatThreadEvents.serviceTier,
  computerUseHostId: chatThreadEvents.computerUseHostId,
  cloudBrowserEnabled: chatThreadEvents.cloudBrowserEnabled,
  createdAt: chatThreadEvents.createdAt,
});

const pageChatThreadEventSelection = Object.freeze({
  id: pageChatThreadEvent.id,
  seqId: pageChatThreadEvent.seqId,
  kind: pageChatThreadEvent.kind,
  chatThreadId: pageChatThreadEvent.chatThreadId,
  agentId: pageChatThreadEvent.agentId,
  reassignedAgentId: pageChatThreadEvent.reassignedAgentId,
  title: pageChatThreadEvent.title,
  pinOrder: pageChatThreadEvent.pinOrder,
  selectedModel: pageChatThreadEvent.selectedModel,
  modelSettings: pageChatThreadEvent.modelSettings,
  modelSettingsPatch: pageChatThreadEvent.modelSettingsPatch,
  serviceTier: pageChatThreadEvent.serviceTier,
  computerUseHostId: pageChatThreadEvent.computerUseHostId,
  cloudBrowserEnabled: pageChatThreadEvent.cloudBrowserEnabled,
  createdAt: pageChatThreadEvent.createdAt,
});

export function chatThreadServiceTierFromCodex(
  codexServiceTier: CodexServiceTier | null,
): ChatThreadServiceTier | null {
  return codexServiceTier === "fast"
    ? "priority"
    : codexServiceTier === "ultrafast"
      ? "ultrafast"
      : null;
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
    ...(row.reassignedAgentId === null
      ? {}
      : { reassignedAgentId: row.reassignedAgentId }),
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
    createdAt: row.createdAt.toISOString(),
  };
}

function chatThreadEventRowsAfterCursor(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly sinceSeqId: number;
}) {
  return computed(
    async (get): Promise<readonly ChatThreadEventRow[] | null> => {
      const db = get(db$);
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
                        eq(
                          chatThreadSnapshots.latestEventSeqId,
                          args.sinceSeqId,
                        ),
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
            // Tombstones for Agent deletion outlive the Agent itself. Other
            // events still require a canonical Agent to be returned.
            or(
              eq(pageChatThreadEvent.kind, "deleted"),
              exists(
                db
                  .select({ id: agents.id })
                  .from(agents)
                  .where(eq(agents.id, pageChatThreadEvent.agentId)),
              ),
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
    },
  );
}

export function getChatThreadEventsSince(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly sinceSeqId?: number;
}) {
  const cursorRows$ =
    args.sinceSeqId === undefined
      ? null
      : chatThreadEventRowsAfterCursor({
          userId: args.userId,
          orgId: args.orgId,
          sinceSeqId: args.sinceSeqId,
        });
  return computed(
    async (
      get,
    ): Promise<
      | {
          readonly kind: "ok";
          readonly events: readonly ChatThreadEvent[];
          readonly hasMore: boolean;
        }
      | { readonly kind: "expired" }
    > => {
      const db = get(db$);
      let rows: readonly ChatThreadEventRow[];
      if (cursorRows$ !== null) {
        const cursorRows = await get(cursorRows$);
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
              or(
                eq(chatThreadEvents.kind, "deleted"),
                exists(
                  db
                    .select({ id: agents.id })
                    .from(agents)
                    .where(eq(agents.id, chatThreadEvents.agentId)),
                ),
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
    },
  );
}
