import type { RelatedChat } from "@okouai/api-contracts/contracts/chat-relations";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agents } from "@okouai/db/schema/agent";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatRelations } from "@okouai/db/schema/chat-relation";
import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import { command } from "ccstate";
import { and, desc, eq, inArray, max, or, sql, sum } from "drizzle-orm";
import { pgIntegerDecoder } from "../../lib/db-structured-result";
import { db$ } from "../external/db";

interface RelationOwner {
  readonly orgId: string;
  readonly userId: string;
}
interface RelationQuery extends RelationOwner {
  readonly threadId: string;
}
function ownedRelations(owner: RelationOwner) {
  return and(
    eq(chatRelations.orgId, owner.orgId),
    eq(chatRelations.userId, owner.userId),
  );
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
  async ({ get, set }, query: RelationQuery, signal: AbortSignal) => {
    const rows = await get(db$)
      .select()
      .from(chatRelations)
      .where(
        and(
          ownedRelations(query),
          eq(chatRelations.type, "created"),
          eq(chatRelations.sourceChatThreadId, query.threadId),
        ),
      )
      .orderBy(desc(chatRelations.createdAt), desc(chatRelations.id));
    signal.throwIfAborted();
    const chats = await set(
      relatedChats$,
      query,
      rows.map((row) => {
        return row.targetChatThreadId;
      }),
      signal,
    );
    return {
      items: rows.map((row) => {
        return {
          ...relatedChat(chats, row.targetChatThreadId),
          id: row.id,
          sourceRunId: row.sourceRunId,
          createdAt: row.createdAt.toISOString(),
        };
      }),
    };
  },
);
export const chatCommunications$ = command(
  async ({ get, set }, query: RelationQuery, signal: AbortSignal) => {
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
          ownedRelations(query),
          eq(chatRelations.type, "message"),
          eq(chatRelations.sourceChatThreadId, query.threadId),
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
          ownedRelations(query),
          eq(chatRelations.type, "message"),
          eq(chatRelations.targetChatThreadId, query.threadId),
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
    const rows = await db
      .select()
      .from(peers)
      .orderBy(desc(peers.createdAt), desc(peers.peerId));
    signal.throwIfAborted();
    const chats = await set(
      relatedChats$,
      query,
      rows.map((row) => {
        return row.peerId;
      }),
      signal,
    );
    return {
      items: rows.map((row) => {
        return {
          ...relatedChat(chats, row.peerId),
          sentCount: row.sentCount,
          receivedCount: row.receivedCount,
          lastMessageAt: row.createdAt.toISOString(),
        };
      }),
    };
  },
);
export const chatRelationMessages$ = command(
  async (
    { get },
    query: RelationQuery,
    peerId: string,
    signal: AbortSignal,
  ) => {
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
          ownedRelations(query),
          eq(chatRelations.type, "message"),
          or(
            and(
              eq(chatRelations.sourceChatThreadId, query.threadId),
              eq(chatRelations.targetChatThreadId, peerId),
            ),
            and(
              eq(chatRelations.targetChatThreadId, query.threadId),
              eq(chatRelations.sourceChatThreadId, peerId),
            ),
          ),
        ),
      )
      .orderBy(desc(chatRelations.createdAt), desc(chatRelations.id));
    signal.throwIfAborted();
    return {
      items: rows.map(({ relation, payload }) => {
        if (relation.messageEventId === null) {
          throw new Error("Message relation is missing its accepted event");
        }
        return {
          id: relation.id,
          direction:
            relation.sourceChatThreadId === query.threadId
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
    };
  },
);
