import { agentphoneChatThreadRoutes } from "@okouai/db/schema/agentphone-chat-thread-route";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
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

/** The unique route and its new thread/event commit in this command alone. */
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
    const result = await db.transaction(async (tx) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const [existing] = await tx
          .select(ROUTE_COLUMNS)
          .from(agentphoneChatThreadRoutes)
          .innerJoin(
            chatThreads,
            eq(chatThreads.id, agentphoneChatThreadRoutes.chatThreadId),
          )
          .where(routeWhere(args))
          .limit(1)
          .for("update");
        if (existing) {
          if (existing.conversationId !== args.conversationId) {
            await tx
              .update(agentphoneChatThreadRoutes)
              .set({ conversationId: args.conversationId })
              .where(eq(agentphoneChatThreadRoutes.id, existing.id));
          }
          return existing;
        }
        if (attempt === 1) {
          break;
        }
        const thread = integrationChatThreadValues(args, candidateId, defaults);
        await tx.insert(chatThreads).values(thread);
        const [route] = await tx
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
        "Failed to resolve AgentPhone chat thread route after conflict",
      );
    });
    signal.throwIfAborted();
    return result;
  },
);
