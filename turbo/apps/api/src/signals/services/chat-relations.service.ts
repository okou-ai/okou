import type { RelatedChat } from "@okouai/api-contracts/contracts/chat-relations";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agents } from "@okouai/db/schema/agent";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatRelations } from "@okouai/db/schema/chat-relation";
import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import { command } from "ccstate";
import { and, desc, eq, inArray, lt, max, or, sql, sum } from "drizzle-orm";
import { pgIntegerDecoder } from "../../lib/db-structured-result";
import { db$ } from "../external/db";

interface RelationOwner {
  readonly orgId: string;
  readonly userId: string;
}
interface RelationPage extends RelationOwner {
  readonly threadId: string;
  readonly limit: number;
  readonly before?: string;
  readonly beforeId?: string;
}
function ownedRelations(owner: RelationOwner) {
  return and(
    eq(chatRelations.orgId, owner.orgId),
    eq(chatRelations.userId, owner.userId),
  );
}
function relationCursor(page: RelationPage) {
  return page.before !== undefined && page.beforeId !== undefined
    ? or(
        lt(chatRelations.createdAt, new Date(page.before)),
        and(
          eq(chatRelations.createdAt, new Date(page.before)),
          lt(chatRelations.id, page.beforeId),
        ),
      )
    : undefined;
}
function nextCursor(
  rows: readonly { readonly id: string; readonly createdAt: Date }[],
  limit: number,
) {
  const last = rows[limit - 1];
  return rows.length > limit && last
    ? { id: last.id, createdAt: last.createdAt.toISOString() }
    : null;
}
const relatedChats$ = command(
  async (
    { get },
    owner: RelationOwner,
    ids: readonly string[],
    signal: AbortSignal,
  ) => {
    if (ids.length === 0) {
      return new Map<string, RelatedChat>();
    }
    const rows = await get(db$)
      .select({
        threadId: chatThreads.id,
        title: chatThreads.title,
        runStatus: agentRuns.status,
        queuedThreadId: queuedChatThreads.chatThreadId,
      })
      .from(chatThreads)
      .innerJoin(
        agents,
        and(eq(agents.id, chatThreads.agentId), eq(agents.orgId, owner.orgId)),
      )
      .leftJoin(
        activeAgentRuns,
        and(
          eq(activeAgentRuns.chatThreadId, chatThreads.id),
          eq(activeAgentRuns.orgId, owner.orgId),
          eq(activeAgentRuns.userId, owner.userId),
        ),
      )
      .leftJoin(agentRuns, eq(agentRuns.id, activeAgentRuns.runId))
      .leftJoin(
        queuedChatThreads,
        eq(queuedChatThreads.chatThreadId, chatThreads.id),
      )
      .where(
        and(eq(chatThreads.userId, owner.userId), inArray(chatThreads.id, ids)),
      );
    signal.throwIfAborted();
    return new Map(
      rows.map((row) => {
        const status =
          row.runStatus === "running"
            ? "running"
            : row.runStatus === "pending" || row.queuedThreadId !== null
              ? "queued"
              : "idle";
        return [
          row.threadId,
          {
            threadId: row.threadId,
            title: row.title,
            status,
          } satisfies RelatedChat,
        ];
      }),
    );
  },
);
function relatedChat(
  chats: ReadonlyMap<string, RelatedChat>,
  threadId: string,
): RelatedChat {
  return (
    chats.get(threadId) ?? { threadId, title: null, status: "unavailable" }
  );
}
export const createdChatRelations$ = command(
  async ({ get, set }, page: RelationPage, signal: AbortSignal) => {
    const rows = await get(db$)
      .select()
      .from(chatRelations)
      .where(
        and(
          ownedRelations(page),
          eq(chatRelations.type, "created"),
          eq(chatRelations.sourceChatThreadId, page.threadId),
          relationCursor(page),
        ),
      )
      .orderBy(desc(chatRelations.createdAt), desc(chatRelations.id))
      .limit(page.limit + 1);
    signal.throwIfAborted();
    const items = rows.slice(0, page.limit);
    const chats = await set(
      relatedChats$,
      page,
      items.map((row) => {
        return row.targetChatThreadId;
      }),
      signal,
    );
    return {
      items: items.map((row) => {
        return {
          ...relatedChat(chats, row.targetChatThreadId),
          id: row.id,
          sourceRunId: row.sourceRunId,
          createdAt: row.createdAt.toISOString(),
        };
      }),
      nextCursor: nextCursor(rows, page.limit),
    };
  },
);
export const chatCommunications$ = command(
  async ({ get, set }, page: RelationPage, signal: AbortSignal) => {
    const db = get(db$);
    // Each direction uses its owner/thread index; aggregate only this chat's message facts.
    const outgoing = db
      .select({
        peerId: chatRelations.targetChatThreadId,
        createdAt: chatRelations.createdAt,
        sent: sql`1::integer`.mapWith(pgIntegerDecoder).as("sent"),
        received: sql`0::integer`.mapWith(pgIntegerDecoder).as("received"),
      })
      .from(chatRelations)
      .where(
        and(
          ownedRelations(page),
          eq(chatRelations.type, "message"),
          eq(chatRelations.sourceChatThreadId, page.threadId),
        ),
      );
    const incoming = db
      .select({
        peerId: chatRelations.sourceChatThreadId,
        createdAt: chatRelations.createdAt,
        sent: sql`0::integer`.mapWith(pgIntegerDecoder).as("sent"),
        received: sql`1::integer`.mapWith(pgIntegerDecoder).as("received"),
      })
      .from(chatRelations)
      .where(
        and(
          ownedRelations(page),
          eq(chatRelations.type, "message"),
          eq(chatRelations.targetChatThreadId, page.threadId),
        ),
      );
    const messages = outgoing.unionAll(incoming).as("messages");
    const peers = db
      .select({
        peerId: messages.peerId,
        createdAt: sql`${max(messages.createdAt)}::timestamp`
          .mapWith(chatRelations.createdAt)
          .as("last_message_at"),
        sentCount: sql`${sum(messages.sent)}::integer`
          .mapWith(pgIntegerDecoder)
          .as("sent_count"),
        receivedCount: sql`${sum(messages.received)}::integer`
          .mapWith(pgIntegerDecoder)
          .as("received_count"),
      })
      .from(messages)
      .groupBy(messages.peerId)
      .as("peers");
    const cursor =
      page.before !== undefined && page.beforeId !== undefined
        ? or(
            lt(peers.createdAt, new Date(page.before)),
            and(
              eq(peers.createdAt, new Date(page.before)),
              lt(peers.peerId, page.beforeId),
            ),
          )
        : undefined;
    const rows = await db
      .select()
      .from(peers)
      .where(cursor)
      .orderBy(desc(peers.createdAt), desc(peers.peerId))
      .limit(page.limit + 1);
    signal.throwIfAborted();
    const items = rows.slice(0, page.limit);
    const chats = await set(
      relatedChats$,
      page,
      items.map((row) => {
        return row.peerId;
      }),
      signal,
    );
    return {
      items: items.map((row) => {
        return {
          ...relatedChat(chats, row.peerId),
          sentCount: row.sentCount,
          receivedCount: row.receivedCount,
          lastMessageAt: row.createdAt.toISOString(),
        };
      }),
      nextCursor: nextCursor(
        rows.map((row) => {
          return { id: row.peerId, createdAt: row.createdAt };
        }),
        page.limit,
      ),
    };
  },
);
export const chatRelationMessages$ = command(
  async ({ get }, page: RelationPage, peerId: string, signal: AbortSignal) => {
    const rows = await get(db$)
      .select({ relation: chatRelations, payload: chatEvents.payload })
      .from(chatRelations)
      .leftJoin(
        chatEvents,
        and(
          eq(chatEvents.id, chatRelations.messageEventId),
          eq(chatEvents.chatThreadId, chatRelations.targetChatThreadId),
        ),
      )
      .where(
        and(
          ownedRelations(page),
          eq(chatRelations.type, "message"),
          relationCursor(page),
          or(
            and(
              eq(chatRelations.sourceChatThreadId, page.threadId),
              eq(chatRelations.targetChatThreadId, peerId),
            ),
            and(
              eq(chatRelations.targetChatThreadId, page.threadId),
              eq(chatRelations.sourceChatThreadId, peerId),
            ),
          ),
        ),
      )
      .orderBy(desc(chatRelations.createdAt), desc(chatRelations.id))
      .limit(page.limit + 1);
    signal.throwIfAborted();
    return {
      items: rows.slice(0, page.limit).map(({ relation, payload }) => {
        if (relation.messageEventId === null) {
          throw new Error("Message relation is missing its accepted event");
        }
        return {
          id: relation.id,
          direction:
            relation.sourceChatThreadId === page.threadId
              ? ("sent" as const)
              : ("received" as const),
          sourceChatThreadId: relation.sourceChatThreadId,
          targetChatThreadId: relation.targetChatThreadId,
          sourceRunId: relation.sourceRunId,
          targetRunId: relation.targetRunId,
          messageEventId: relation.messageEventId,
          createdAt: relation.createdAt.toISOString(),
          userMessage: payload?.userMessage ?? null,
        };
      }),
      nextCursor: nextCursor(
        rows.map((row) => {
          return row.relation;
        }),
        page.limit,
      ),
    };
  },
);
