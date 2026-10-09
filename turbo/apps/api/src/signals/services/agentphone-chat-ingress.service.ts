import { agentphoneChatThreadRoutes } from "@okouai/db/schema/agentphone-chat-thread-route";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
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

/** Read the chat thread an AgentPhone conversation already routes to. */
export const findAgentPhoneRoutedChatThreadId$ = command(
  async (
    { set },
    key: AgentPhoneChatThreadRouteKey,
    signal?: AbortSignal,
  ): Promise<string | undefined> => {
    const db = set(writeDb$);
    const [route] = await db
      .select({ chatThreadId: agentphoneChatThreadRoutes.chatThreadId })
      .from(agentphoneChatThreadRoutes)
      .where(routeWhere(key))
      .limit(1);
    signal?.throwIfAborted();
    return route?.chatThreadId;
  },
);

const ROUTE_COLUMNS = {
  id: agentphoneChatThreadRoutes.id,
  conversationId: agentphoneChatThreadRoutes.conversationId,
  chatThreadId: agentphoneChatThreadRoutes.chatThreadId,
} as const;

type AgentPhoneChatThreadRouteRow = Awaited<
  ReturnType<typeof loadAgentPhoneChatThreadRoute>
>;

async function loadAgentPhoneChatThreadRoute(
  tx: Tx,
  key: AgentPhoneChatThreadRouteKey,
) {
  const [route] = await tx
    .select(ROUTE_COLUMNS)
    .from(agentphoneChatThreadRoutes)
    .innerJoin(
      chatThreads,
      eq(chatThreads.id, agentphoneChatThreadRoutes.chatThreadId),
    )
    .where(routeWhere(key))
    .limit(1);
  return route;
}

/** Conditional context refresh; no row lock, the route id pins the row. */
async function refreshAgentPhoneRouteConversation(
  tx: Tx,
  route: NonNullable<AgentPhoneChatThreadRouteRow>,
  conversationId: string | null,
): Promise<void> {
  if (route.conversationId === conversationId) {
    return;
  }
  await tx
    .update(agentphoneChatThreadRoutes)
    .set({ conversationId })
    .where(eq(agentphoneChatThreadRoutes.id, route.id));
}

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
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0051; new non-billing transactions are prohibited.
    const result = await db.transaction(async (tx) => {
      const existing = await loadAgentPhoneChatThreadRoute(tx, args);
      if (existing) {
        await refreshAgentPhoneRouteConversation(
          tx,
          existing,
          args.conversationId,
        );
        return existing;
      }
      const thread = integrationChatThreadValues(args, candidateId, defaults);
      const insertedRoute = tx.$with("inserted_agentphone_route").as(
        tx
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
          .returning(ROUTE_COLUMNS),
      );
      const insertedThread = tx
        .$with("inserted_agentphone_thread", {})
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
      const winner = await loadAgentPhoneChatThreadRoute(tx, args);
      if (!winner) {
        throw new Error(
          "Failed to resolve AgentPhone chat thread route after conflict",
        );
      }
      await refreshAgentPhoneRouteConversation(tx, winner, args.conversationId);
      return winner;
    });
    signal.throwIfAborted();
    return result;
  },
);
