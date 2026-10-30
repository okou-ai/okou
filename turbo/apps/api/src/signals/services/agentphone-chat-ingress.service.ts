import {
  agentPhoneRouteLinkColumn,
  agentPhoneGroupRouteKey,
  agentPhoneGroupMessageRouteKey,
  agentPhoneGroupReplyRouteKey,
  type AgentPhoneChannel,
} from "./agentphone-shared.service";
import { agentphoneChatThreadRoutes } from "@okouai/db/schema/agentphone-chat-thread-route";
import { chatAgentphoneContext } from "@okouai/db/schema/chat-agentphone-context";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { and, eq, inArray, sql } from "drizzle-orm";
import { object, string, uuid } from "zod";

import { db$, writeDb$ } from "../external/db";
import { command } from "ccstate";
import { randomUUID } from "node:crypto";
import { loadNewChatThreadDefaults$ } from "./chat-thread-defaults.service";
import { parseRawRows } from "../../lib/db-raw-rows";
import {
  integrationChatThreadInsertFromRouteSql,
  integrationChatThreadValues,
  integrationThreadCreatedEventSql,
  type IntegrationChatThreadCreation,
} from "./integration-chat-thread-publication";

interface AgentPhoneChatThreadRouteKey {
  readonly agentphoneUserLinkId: string;
  readonly channel?: AgentPhoneChannel;
  readonly rootMessageId: string;
}

interface AgentPhoneChatThreadBinding {
  readonly chatThreadId: string;
}

interface AgentPhoneChatThreadCreateArgs extends IntegrationChatThreadCreation {
  readonly conversationId: string | null;
}

export const resolveAgentPhoneGroupChatRoot$ = command(
  async (
    { get },
    args: {
      readonly userLinkId: string;
      readonly conversationId: string;
      readonly replyToMessageId: string | null;
    },
    signal: AbortSignal,
  ): Promise<string> => {
    const replyToMessageId = args.replyToMessageId;
    const groupRoot = agentPhoneGroupRouteKey(args.conversationId);
    if (!replyToMessageId) {
      return groupRoot;
    }
    // Input contexts retain the route used by every prompt, including replies
    // to replies and messages accepted before per-message group routing.
    const [parent] = await get(db$)
      .select({ rootMessageId: agentphoneChatThreadRoutes.rootMessageId })
      .from(agentphoneChatThreadRoutes)
      .innerJoin(
        chatAgentphoneContext,
        and(
          eq(
            chatAgentphoneContext.chatThreadId,
            agentphoneChatThreadRoutes.chatThreadId,
          ),
          eq(
            chatAgentphoneContext.rootMessageId,
            agentphoneChatThreadRoutes.rootMessageId,
          ),
        ),
      )
      .where(
        and(
          eq(agentphoneChatThreadRoutes.agentphoneUserLinkId, args.userLinkId),
          eq(agentphoneChatThreadRoutes.conversationId, args.conversationId),
          eq(chatAgentphoneContext.userLinkId, args.userLinkId),
          eq(chatAgentphoneContext.conversationId, args.conversationId),
          eq(chatAgentphoneContext.messageId, replyToMessageId),
          eq(chatAgentphoneContext.channel, "imessage"),
          eq(chatAgentphoneContext.isGroup, true),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    // Only replies already inside a branch reuse it. Replies to the main
    // conversation or an ambient message fork at the quoted provider message.
    if (parent && parent.rootMessageId !== groupRoot) {
      return parent.rootMessageId;
    }
    if (!parent) {
      const sentReplyRoot = agentPhoneGroupMessageRouteKey(
        args.conversationId,
        replyToMessageId,
      );
      const routes = await get(db$)
        .select({
          rootMessageId: agentphoneChatThreadRoutes.rootMessageId,
          chatThreadId: agentphoneChatThreadRoutes.chatThreadId,
        })
        .from(agentphoneChatThreadRoutes)
        .where(
          and(
            eq(
              agentphoneChatThreadRoutes.agentphoneUserLinkId,
              args.userLinkId,
            ),
            eq(agentphoneChatThreadRoutes.conversationId, args.conversationId),
            inArray(agentphoneChatThreadRoutes.rootMessageId, [
              groupRoot,
              sentReplyRoot,
            ]),
          ),
        );
      signal.throwIfAborted();
      const main = routes.find((route) => {
        return route.rootMessageId === groupRoot;
      });
      const sent = routes.find((route) => {
        return route.rootMessageId === sentReplyRoot;
      });
      // Keep sent branch answers and historical routes usable. An older API
      // callback may have aliased a main-thread answer during request drain;
      // its reply must still fork instead of following that alias to the main.
      if (sent && sent.chatThreadId !== main?.chatThreadId) {
        return sent.rootMessageId;
      }
    }
    return agentPhoneGroupReplyRouteKey(args.conversationId, replyToMessageId);
  },
);

function routeWhere(key: AgentPhoneChatThreadRouteKey) {
  return and(
    eq(agentPhoneRouteLinkColumn(key.channel), key.agentphoneUserLinkId),
    eq(agentphoneChatThreadRoutes.rootMessageId, key.rootMessageId),
  );
}

const ROUTE_COLUMNS = {
  id: agentphoneChatThreadRoutes.id,
  conversationId: agentphoneChatThreadRoutes.conversationId,
  chatThreadId: agentphoneChatThreadRoutes.chatThreadId,
} as const;

const routeRowSchema = object({
  id: uuid(),
  conversationId: string().nullable(),
  chatThreadId: uuid(),
});

/**
 * The unique route and its new thread/event commit in this command alone.
 * One `INSERT … ON CONFLICT DO NOTHING` decides a concurrent create; the loser
 * reads the committed winner once. The thread row is inserted by the same
 * statement only when the route insert wins.
 */
export const ensureAgentPhoneChatThreadRoute$ = command(
  async (
    { set },
    args: AgentPhoneChatThreadRouteKey & AgentPhoneChatThreadCreateArgs,
    signal: AbortSignal,
  ): Promise<AgentPhoneChatThreadBinding> => {
    const defaults = await set(
      loadNewChatThreadDefaults$,
      { orgId: args.orgId, userId: args.userId },
      signal,
    );
    const candidateId = randomUUID();
    const db = set(writeDb$);
    const [existing] = await db
      .select(ROUTE_COLUMNS)
      .from(agentphoneChatThreadRoutes)
      .innerJoin(
        chatThreads,
        eq(chatThreads.id, agentphoneChatThreadRoutes.chatThreadId),
      )
      .where(routeWhere(args))
      .limit(1);
    signal.throwIfAborted();
    if (existing) {
      if (existing.conversationId !== args.conversationId) {
        await db
          .update(agentphoneChatThreadRoutes)
          .set({ conversationId: args.conversationId })
          .where(eq(agentphoneChatThreadRoutes.id, existing.id));
      }
      signal.throwIfAborted();
      return existing;
    }
    const thread = integrationChatThreadValues(args, candidateId, defaults);
    const insertRoute = db
      .insert(agentphoneChatThreadRoutes)
      .values({
        agentphoneUserLinkId:
          args.channel === "whatsapp" ? null : args.agentphoneUserLinkId,
        whatsappUserLinkId:
          args.channel === "whatsapp" ? args.agentphoneUserLinkId : null,
        rootMessageId: args.rootMessageId,
        conversationId: args.conversationId,
        chatThreadId: thread.id,
        createdAt: args.currentTime,
      })
      .onConflictDoNothing({
        target: [
          agentPhoneRouteLinkColumn(args.channel),
          agentphoneChatThreadRoutes.rootMessageId,
        ],
      })
      .returning(ROUTE_COLUMNS);
    const insertedRoute = db.$with("inserted_agentphone_route").as(insertRoute);
    const insertThread = sql`${integrationChatThreadInsertFromRouteSql(thread, insertedRoute)}
      RETURNING ${chatThreads.agentId}`;
    // Thread RETURNING gates the existing lifecycle sequence reservation. The
    // final result depends on event publication, not a base-table snapshot.
    const [route] = parseRawRows(
      routeRowSchema,
      await db.execute(
        integrationThreadCreatedEventSql(args.orgId, thread, {
          cte: sql`inserted_agentphone_route AS (${insertRoute.getSQL()}),
            inserted_agentphone_thread AS (${insertThread})`,
          gate: sql`EXISTS (SELECT 1 FROM inserted_agentphone_thread)`,
          agentId: sql`(SELECT agent_id FROM inserted_agentphone_thread)`,
          result: sql`SELECT id, conversation_id AS "conversationId",
            chat_thread_id AS "chatThreadId" FROM inserted_agentphone_route
            WHERE EXISTS (SELECT 1 FROM inserted)`,
        }),
      ),
    );
    if (route) {
      // A successful statement has committed before cancellation propagates.
      signal.throwIfAborted();
      return route;
    }
    // ON CONFLICT waited for the winner's commit. A new statement sees it;
    // the losing statement's original snapshot cannot resolve that winner.
    const [winner] = await db
      .select(ROUTE_COLUMNS)
      .from(agentphoneChatThreadRoutes)
      .innerJoin(
        chatThreads,
        eq(chatThreads.id, agentphoneChatThreadRoutes.chatThreadId),
      )
      .where(routeWhere(args))
      .limit(1);
    if (signal.aborted) {
      // A missing winner retains its original error ahead of cancellation.
      if (winner) {
        signal.throwIfAborted();
      }
    }
    if (!winner) {
      throw new Error(
        "Failed to resolve AgentPhone chat thread route after conflict",
      );
    }
    if (winner.conversationId !== args.conversationId) {
      await db
        .update(agentphoneChatThreadRoutes)
        .set({ conversationId: args.conversationId })
        .where(eq(agentphoneChatThreadRoutes.id, winner.id));
    }
    signal.throwIfAborted();
    return winner;
  },
);
