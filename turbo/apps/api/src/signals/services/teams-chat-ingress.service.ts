import { INTEGRATION_DM_SESSION_KEY } from "../../lib/integration-dm-session";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { teamsChatThreadRoutes } from "@okouai/db/schema/teams-chat-thread-route";
import { and, eq } from "drizzle-orm";

import { writeDb$ } from "../external/db";
import { command } from "ccstate";
import { randomUUID } from "node:crypto";
import { loadNewChatThreadDefaults$ } from "./chat-thread-defaults.service";
import {
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

/** The unique route and its new thread/event commit in this command alone. */
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
    const result = await db.transaction(async (tx) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const [existing] = await tx
          .select(ROUTE_COLUMNS)
          .from(teamsChatThreadRoutes)
          .innerJoin(
            chatThreads,
            eq(chatThreads.id, teamsChatThreadRoutes.chatThreadId),
          )
          .where(routeWhere(args))
          .limit(1)
          .for("update");
        if (existing) {
          if (
            args.threadId === INTEGRATION_DM_SESSION_KEY &&
            existing.conversationId !== args.conversationId
          ) {
            const [updated] = await tx
              .update(teamsChatThreadRoutes)
              .set({ conversationId: args.conversationId })
              .where(
                and(
                  eq(teamsChatThreadRoutes.id, existing.id),
                  routeWhere(args),
                ),
              )
              .returning({
                conversationId: teamsChatThreadRoutes.conversationId,
              });
            if (!updated) {
              throw new Error("Failed to update Teams DM route destination");
            }
            return { ...existing, ...updated };
          }
          return existing;
        }
        if (attempt === 1) {
          break;
        }
        const thread = integrationChatThreadValues(args, candidateId, defaults);
        await tx.insert(chatThreads).values(thread);
        const [route] = await tx
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
        if (route) {
          await tx.execute(
            integrationThreadCreatedEventSql(args.orgId, thread),
          );
          signal.throwIfAborted();
          return route;
        }
        await tx.delete(chatThreads).where(eq(chatThreads.id, thread.id));
      }
      throw new Error(
        "Failed to resolve Teams chat thread route after conflict",
      );
    });
    signal.throwIfAborted();
    return result;
  },
);
