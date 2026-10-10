import { INTEGRATION_DM_SESSION_KEY } from "../../lib/integration-dm-session";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { teamsChatThreadRoutes } from "@okouai/db/schema/teams-chat-thread-route";
import { and, eq } from "drizzle-orm";

import { writeDb$ } from "../external/db";
import { command } from "ccstate";
import { randomUUID } from "node:crypto";
import { loadNewChatThreadDefaults$ } from "./chat-thread-defaults.service";
import type { Tx } from "../../lib/db-types";
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

/** Read the chat thread a Teams conversation already routes to. */
export const findTeamsRoutedChatThreadId$ = command(
  async (
    { set },
    key: TeamsChatThreadRouteKey,
    signal?: AbortSignal,
  ): Promise<string | undefined> => {
    const db = set(writeDb$);
    const [route] = await db
      .select({ chatThreadId: teamsChatThreadRoutes.chatThreadId })
      .from(teamsChatThreadRoutes)
      .where(routeWhere(key))
      .limit(1);
    signal?.throwIfAborted();
    return route?.chatThreadId;
  },
);

const ROUTE_COLUMNS = {
  id: teamsChatThreadRoutes.id,
  connectionId: teamsChatThreadRoutes.connectionId,
  conversationId: teamsChatThreadRoutes.conversationId,
  threadId: teamsChatThreadRoutes.threadId,
  userId: teamsChatThreadRoutes.userId,
  chatThreadId: teamsChatThreadRoutes.chatThreadId,
} as const;

/** A DM route follows the latest destination through one conditional update. */
async function adoptTeamsChatThreadRoute(
  tx: Tx,
  existing: TeamsChatThreadRouteBinding,
  key: TeamsChatThreadRouteKey,
): Promise<TeamsChatThreadRouteBinding> {
  if (
    key.threadId !== INTEGRATION_DM_SESSION_KEY ||
    existing.conversationId === key.conversationId
  ) {
    return existing;
  }
  const [updated] = await tx
    .update(teamsChatThreadRoutes)
    .set({ conversationId: key.conversationId })
    .where(and(eq(teamsChatThreadRoutes.id, existing.id), routeWhere(key)))
    .returning({ conversationId: teamsChatThreadRoutes.conversationId });
  if (!updated) {
    throw new Error("Failed to update Teams DM route destination");
  }
  return { ...existing, ...updated };
}

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
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0258; new non-billing transactions are prohibited.
    const result = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select(ROUTE_COLUMNS)
        .from(teamsChatThreadRoutes)
        .innerJoin(
          chatThreads,
          eq(chatThreads.id, teamsChatThreadRoutes.chatThreadId),
        )
        .where(routeWhere(args))
        .limit(1);
      if (existing) {
        return await adoptTeamsChatThreadRoute(tx, existing, args);
      }
      const thread = integrationChatThreadValues(args, candidateId, defaults);
      const insertedRoute = tx.$with("inserted_teams_route").as(
        tx
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
          .returning(ROUTE_COLUMNS),
      );
      const insertedThread = tx
        .$with("inserted_teams_thread", {})
        .as(integrationChatThreadInsertFromRouteSql(thread, insertedRoute));
      const [route] = await tx
        .with(insertedRoute, insertedThread)
        .select()
        .from(insertedRoute);
      if (route) {
        await tx.execute(integrationThreadCreatedEventSql(args.orgId, thread));
        signal.throwIfAborted();
        return route;
      }
      // ON CONFLICT waited for the winner's commit; read it once.
      const [winner] = await tx
        .select(ROUTE_COLUMNS)
        .from(teamsChatThreadRoutes)
        .innerJoin(
          chatThreads,
          eq(chatThreads.id, teamsChatThreadRoutes.chatThreadId),
        )
        .where(routeWhere(args))
        .limit(1);
      if (!winner) {
        throw new Error(
          "Failed to resolve Teams chat thread route after conflict",
        );
      }
      return await adoptTeamsChatThreadRoute(tx, winner, args);
    });
    signal.throwIfAborted();
    return result;
  },
);
