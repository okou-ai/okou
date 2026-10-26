import { INTEGRATION_DM_SESSION_KEY } from "../../lib/integration-dm-session";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { teamsChatThreadRoutes } from "@okouai/db/schema/teams-chat-thread-route";
import { and, eq, sql } from "drizzle-orm";
import { object, string, uuid } from "zod";
import { parseRawRows } from "../../lib/db-raw-rows";

import { writeDb$ } from "../external/db";
import { command } from "ccstate";
import { randomUUID } from "node:crypto";
import { loadNewChatThreadDefaults$ } from "./chat-thread-defaults.service";
import {
  integrationChatThreadInsertFromRouteSql,
  integrationChatThreadValues,
  integrationThreadCreatedEventSql,
  type IntegrationChatThreadCreation,
} from "./integration-chat-thread-publication";

interface TeamsChatThreadRouteKey {
  readonly connectionId: string;
  readonly conversationId: string;
  readonly threadId: string;
  readonly userId: string;
}

interface TeamsChatThreadRouteBinding extends TeamsChatThreadRouteKey {
  readonly id: string;
  readonly chatThreadId: string;
}

function routeWhere(key: TeamsChatThreadRouteKey) {
  return and(
    eq(teamsChatThreadRoutes.connectionId, key.connectionId),
    key.threadId === INTEGRATION_DM_SESSION_KEY
      ? undefined
      : eq(teamsChatThreadRoutes.conversationId, key.conversationId),
    eq(teamsChatThreadRoutes.threadId, key.threadId),
    eq(teamsChatThreadRoutes.userId, key.userId),
  );
}

const ROUTE_COLUMNS = {
  id: teamsChatThreadRoutes.id,
  connectionId: teamsChatThreadRoutes.connectionId,
  conversationId: teamsChatThreadRoutes.conversationId,
  threadId: teamsChatThreadRoutes.threadId,
  userId: teamsChatThreadRoutes.userId,
  chatThreadId: teamsChatThreadRoutes.chatThreadId,
} as const;

/** Check the returned outcome before propagating a later cancellation. */
function requiredRouteRow<TRow>(rows: readonly TRow[], message: string): TRow {
  const [row] = rows;
  if (!row) {
    throw new Error(message);
  }
  return row;
}

const createdRouteSchema = object({
  id: uuid(),
  connectionId: uuid(),
  conversationId: string(),
  threadId: string(),
  userId: string(),
  chatThreadId: uuid(),
});

/**
 * The unique route and its new thread/event commit in this command alone.
 * One `INSERT … ON CONFLICT DO NOTHING` decides a concurrent create; the loser
 * reads the committed winner once. The thread row is inserted by the same
 * statement only when the route insert wins.
 */
export const ensureTeamsChatThreadRoute$ = command(
  async (
    { set },
    args: TeamsChatThreadRouteKey & IntegrationChatThreadCreation,
    signal: AbortSignal,
  ): Promise<TeamsChatThreadRouteBinding> => {
    const defaults = await set(
      loadNewChatThreadDefaults$,
      { orgId: args.orgId, userId: args.userId },
      signal,
    );
    const candidateId = randomUUID();
    const db = set(writeDb$);
    const [existing] = await db
      .select(ROUTE_COLUMNS)
      .from(teamsChatThreadRoutes)
      .innerJoin(
        chatThreads,
        eq(chatThreads.id, teamsChatThreadRoutes.chatThreadId),
      )
      .where(routeWhere(args))
      .limit(1);
    signal.throwIfAborted();
    if (existing) {
      if (
        args.threadId !== INTEGRATION_DM_SESSION_KEY ||
        existing.conversationId === args.conversationId
      ) {
        return existing;
      }
      const updated = requiredRouteRow(
        await db
          .update(teamsChatThreadRoutes)
          .set({ conversationId: args.conversationId })
          .where(
            and(eq(teamsChatThreadRoutes.id, existing.id), routeWhere(args)),
          )
          .returning({ conversationId: teamsChatThreadRoutes.conversationId }),
        "Failed to update Teams DM route destination",
      );
      signal.throwIfAborted();
      return { ...existing, ...updated };
    }
    const thread = integrationChatThreadValues(args, candidateId, defaults);
    const routeInsert = db
      .insert(teamsChatThreadRoutes)
      .values({
        connectionId: args.connectionId,
        conversationId: args.conversationId,
        threadId: args.threadId,
        userId: args.userId,
        chatThreadId: thread.id,
        createdAt: args.currentTime,
      })
      .onConflictDoNothing({
        target: [
          teamsChatThreadRoutes.connectionId,
          teamsChatThreadRoutes.conversationId,
          teamsChatThreadRoutes.threadId,
          teamsChatThreadRoutes.userId,
        ],
      })
      .returning(ROUTE_COLUMNS);
    const insertedRoute = db.$with("inserted_teams_route").as(routeInsert);
    const threadInsert = integrationChatThreadInsertFromRouteSql(
      thread,
      insertedRoute,
    );
    // The thread's RETURNING gates reservation/publication. The base-table
    // snapshot cannot see a thread inserted by another CTE in this statement.
    const [route] = parseRawRows(
      createdRouteSchema,
      await db.execute(
        integrationThreadCreatedEventSql(args.orgId, thread, {
          cte: sql`inserted_teams_route AS (${routeInsert.getSQL()}),
            inserted_teams_thread AS (
              ${threadInsert} RETURNING ${chatThreads.agentId}
            )`,
          gate: sql`EXISTS (SELECT 1 FROM inserted_teams_thread)`,
          agentId: sql`(SELECT agent_id FROM inserted_teams_thread)`,
          result: sql`SELECT id, connection_id AS "connectionId",
            conversation_id AS "conversationId", thread_id AS "threadId",
            user_id AS "userId", chat_thread_id AS "chatThreadId"
            FROM inserted_teams_route`,
        }),
      ),
    );
    signal.throwIfAborted();
    if (route) {
      return route;
    }
    // ON CONFLICT waited for the winner's commit; read it once.
    const winner = requiredRouteRow(
      await db
        .select(ROUTE_COLUMNS)
        .from(teamsChatThreadRoutes)
        .innerJoin(
          chatThreads,
          eq(chatThreads.id, teamsChatThreadRoutes.chatThreadId),
        )
        .where(routeWhere(args))
        .limit(1),
      "Failed to resolve Teams chat thread route after conflict",
    );
    signal.throwIfAborted();
    if (
      args.threadId !== INTEGRATION_DM_SESSION_KEY ||
      winner.conversationId === args.conversationId
    ) {
      return winner;
    }
    const updated = requiredRouteRow(
      await db
        .update(teamsChatThreadRoutes)
        .set({ conversationId: args.conversationId })
        .where(and(eq(teamsChatThreadRoutes.id, winner.id), routeWhere(args)))
        .returning({ conversationId: teamsChatThreadRoutes.conversationId }),
      "Failed to update Teams DM route destination",
    );
    signal.throwIfAborted();
    return { ...winner, ...updated };
  },
);
