import { agentphoneChatThreadRoutes } from "@okouai/db/schema/agentphone-chat-thread-route";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { and, eq, sql } from "drizzle-orm";
import * as z from "zod";

import { writeDb$ } from "../external/db";
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
  readonly rootMessageId: string;
}

interface AgentPhoneChatThreadBinding {
  readonly chatThreadId: string;
}

interface AgentPhoneChatThreadCreateArgs extends IntegrationChatThreadCreation {
  readonly conversationId: string | null;
}

function routeWhere(key: AgentPhoneChatThreadRouteKey) {
  return and(
    eq(
      agentphoneChatThreadRoutes.agentphoneUserLinkId,
      key.agentphoneUserLinkId,
    ),
    eq(agentphoneChatThreadRoutes.rootMessageId, key.rootMessageId),
  );
}

const ROUTE_COLUMNS = {
  id: agentphoneChatThreadRoutes.id,
  conversationId: agentphoneChatThreadRoutes.conversationId,
  chatThreadId: agentphoneChatThreadRoutes.chatThreadId,
} as const;

const routeRowSchema = z.object({
  id: z.uuid(),
  conversationId: z.string().nullable(),
  chatThreadId: z.uuid(),
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
        agentphoneUserLinkId: args.agentphoneUserLinkId,
        rootMessageId: args.rootMessageId,
        conversationId: args.conversationId,
        chatThreadId: thread.id,
        createdAt: args.currentTime,
      })
      .onConflictDoNothing({
        target: [
          agentphoneChatThreadRoutes.agentphoneUserLinkId,
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
