import { command } from "ccstate";
import { chatThreadSnapshotProjectionSchema } from "@okouai/api-contracts/contracts/chat-threads";
import { modelSettingsSchema } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { and, desc, eq, lt, sql, type SQLWrapper } from "drizzle-orm";
import { agents } from "@okouai/db/schema/agent";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import type { infer as zInfer } from "zod";
import {
  nullableDriverValueDecoder,
  pgTextDecoder,
} from "../../lib/db-structured-result";
import { db$ } from "../external/db";

/** Larger pages reduce round trips when rebuilding a scope's full sidebar. */
const PROJECTION_SCAN_PAGE_SIZE = 1000;

/** A timestamp rendered exactly as `jsonb_build_object` renders it. */
function jsonTimestamp(column: SQLWrapper) {
  return sql`to_jsonb(${column}) #>> '{}'`.mapWith(pgTextDecoder);
}

function nullableJsonTimestamp(column: SQLWrapper) {
  return sql`to_jsonb(${column}) #>> '{}'`.mapWith(
    nullableDriverValueDecoder(pgTextDecoder),
  );
}

/**
 * The scope's sidebar projection: the user's threads under the organization's
 * Agents, pinned first, then newest message first. Reads the org's Agent ids
 * and pages the user's threads by the (user_id, last_message_at, id) index,
 * filtering by Agent in the application instead of joining.
 */
export const loadChatThreadSnapshotProjection$ = command(
  async (
    { get },
    scope: { readonly userId: string; readonly orgId: string },
  ) => {
    const db = get(db$);
    const orgAgents = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.orgId, scope.orgId));
    const agentIds = new Set(
      orgAgents.map((agent) => {
        return agent.id;
      }),
    );
    const threads: zInfer<typeof chatThreadSnapshotProjectionSchema>[] = [];
    let after: { readonly lastMessageAt: Date; readonly id: string } | null =
      null;
    for (;;) {
      // Match the index's NULLS LAST order; both cursor columns are non-null.
      const page = await db
        .select({
          id: chatThreads.id,
          agentId: chatThreads.agentId,
          title: chatThreads.title,
          lastMessageAt: chatThreads.lastMessageAt,
          sortAt: jsonTimestamp(chatThreads.lastMessageAt),
          createdAt: jsonTimestamp(chatThreads.createdAt),
          updatedAt: jsonTimestamp(chatThreads.updatedAt),
          pinnedAt: nullableJsonTimestamp(chatThreads.pinnedAt),
          pinOrder: chatThreads.pinOrder,
          archived: chatThreads.archived,
          hidden: chatThreads.hidden,
          muted: chatThreads.muted,
          renamedAt: nullableJsonTimestamp(chatThreads.renamedAt),
          selectedModel: chatThreads.selectedModel,
          modelSettings: chatThreads.modelSettings,
          codexServiceTier: chatThreads.codexServiceTier,
          computerUseHostId: chatThreads.computerUseHostId,
          cloudBrowserEnabled: chatThreads.cloudBrowserEnabled,
        })
        .from(chatThreads)
        .where(
          and(
            eq(chatThreads.userId, scope.userId),
            after === null
              ? undefined
              : lt(
                  sql`(${chatThreads.lastMessageAt}, ${chatThreads.id})`,
                  sql`(${sql.param(after.lastMessageAt, chatThreads.lastMessageAt)}, ${sql.param(after.id, chatThreads.id)})`,
                ),
          ),
        )
        .orderBy(
          sql`${desc(chatThreads.lastMessageAt)} nulls last`,
          sql`${desc(chatThreads.id)} nulls last`,
        )
        .limit(PROJECTION_SCAN_PAGE_SIZE);
      for (const thread of page) {
        if (thread.agentId === null || !agentIds.has(thread.agentId)) {
          continue;
        }
        threads.push(
          chatThreadSnapshotProjectionSchema.parse({
            id: thread.id,
            agentId: thread.agentId,
            title: thread.title,
            sortAt: thread.sortAt,
            createdAt: thread.createdAt,
            updatedAt: thread.updatedAt,
            pinnedAt: thread.pinnedAt,
            pinOrder: thread.pinOrder,
            archived: thread.archived,
            hidden: thread.hidden,
            muted: thread.muted,
            renamedAt: thread.renamedAt,
            selectedModel: thread.selectedModel,
            modelSettings: modelSettingsSchema.parse(
              thread.modelSettings ?? {},
            ),
            serviceTier: thread.codexServiceTier === "fast" ? "priority" : null,
            computerUseHostId: thread.computerUseHostId,
            cloudBrowserEnabled: thread.cloudBrowserEnabled,
          }),
        );
      }
      const last = page.at(-1);
      if (!last || page.length < PROJECTION_SCAN_PAGE_SIZE) {
        break;
      }
      after = { lastMessageAt: last.lastMessageAt, id: last.id };
    }
    // Pinned threads first; both groups keep the newest-message-first order.
    return [
      ...threads.filter((thread) => {
        return thread.pinnedAt !== null;
      }),
      ...threads.filter((thread) => {
        return thread.pinnedAt === null;
      }),
    ];
  },
);
