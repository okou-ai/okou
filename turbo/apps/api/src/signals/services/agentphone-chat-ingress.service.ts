import { resolveRequiredDefaultChatThreadModelPin } from "./chat-thread-model.service";
import { agentphoneChatThreadRoutes } from "@okouai/db/schema/agentphone-chat-thread-route";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { and, eq } from "drizzle-orm";

import type { Db } from "../external/db";
import {
  appendChatThreadCreatedEvent,
  insertChatThread,
} from "./chat-thread-create.service";
import type { Tx } from "../../lib/db-types";

interface AgentPhoneChatThreadRouteKey {
  readonly agentphoneUserLinkId: string;
  readonly rootMessageId: string;
}

interface AgentPhoneChatThreadBinding {
  readonly chatThreadId: string;
}

interface LoadedAgentPhoneChatThreadRoute extends AgentPhoneChatThreadBinding {
  readonly id: string;
  readonly conversationId: string | null;
}

interface AgentPhoneChatThreadCreateArgs {
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly conversationId: string | null;
  readonly currentTime: Date;
}

type AgentPhoneChatThreadTransaction = Tx;

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
export async function findAgentPhoneRoutedChatThreadId(
  db: Pick<Db, "select">,
  key: AgentPhoneChatThreadRouteKey,
): Promise<string | undefined> {
  const [route] = await db
    .select({ chatThreadId: agentphoneChatThreadRoutes.chatThreadId })
    .from(agentphoneChatThreadRoutes)
    .where(routeWhere(key))
    .limit(1);
  return route?.chatThreadId;
}

async function loadRoute(
  db: Pick<Db, "select">,
  key: AgentPhoneChatThreadRouteKey,
): Promise<LoadedAgentPhoneChatThreadRoute | undefined> {
  const [route] = await db
    .select({
      id: agentphoneChatThreadRoutes.id,
      conversationId: agentphoneChatThreadRoutes.conversationId,
      chatThreadId: agentphoneChatThreadRoutes.chatThreadId,
    })
    .from(agentphoneChatThreadRoutes)
    .innerJoin(
      chatThreads,
      eq(chatThreads.id, agentphoneChatThreadRoutes.chatThreadId),
    )
    .where(routeWhere(key))
    .limit(1)
    .for("update");
  return route;
}

async function createCanonicalAgentPhoneChatThread(
  tx: AgentPhoneChatThreadTransaction,
  args: AgentPhoneChatThreadCreateArgs,
): Promise<NonNullable<Awaited<ReturnType<typeof insertChatThread>>>> {
  const initialModel = await resolveRequiredDefaultChatThreadModelPin(tx, args);
  const thread = await insertChatThread(tx, {
    orgId: args.orgId,
    userId: args.userId,
    agentId: args.agentId,
    selectedModel: initialModel.selectedModel,
    codexServiceTier:
      initialModel.serviceTier === "priority"
        ? "fast"
        : initialModel.serviceTier === "ultrafast"
          ? "ultrafast"
          : null,
    title: null,
    lastReadAt: args.currentTime,
    lastMessageAt: args.currentTime,
    createdAt: args.currentTime,
    updatedAt: args.currentTime,
  });
  if (!thread) {
    throw new Error("Failed to create canonical AgentPhone chat thread");
  }
  return thread;
}

async function updateRouteConversationContext(
  tx: AgentPhoneChatThreadTransaction,
  route: LoadedAgentPhoneChatThreadRoute,
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

export async function ensureAgentPhoneChatThreadRoute(
  db: Db,
  args: AgentPhoneChatThreadRouteKey & AgentPhoneChatThreadCreateArgs,
): Promise<AgentPhoneChatThreadBinding> {
  return await db.transaction(async (tx) => {
    const existing = await loadRoute(tx, args);
    if (existing) {
      await updateRouteConversationContext(tx, existing, args.conversationId);
      return existing;
    }

    const thread = await createCanonicalAgentPhoneChatThread(tx, args);
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
      .returning({ chatThreadId: agentphoneChatThreadRoutes.chatThreadId });
    if (!route) {
      await tx.delete(chatThreads).where(eq(chatThreads.id, thread.id));
      const conflicted = await loadRoute(tx, args);
      if (!conflicted) {
        throw new Error(
          "Failed to resolve AgentPhone chat thread route after conflict",
        );
      }
      await updateRouteConversationContext(tx, conflicted, args.conversationId);
      return conflicted;
    }

    await appendChatThreadCreatedEvent(tx, { orgId: args.orgId, thread });
    return route;
  });
}
