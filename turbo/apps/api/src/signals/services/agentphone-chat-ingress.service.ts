import { resolveRequiredDefaultChatThreadModelPin } from "./chat-thread-model.service";
import { agentphoneChatThreadRoutes } from "@okouai/db/schema/agentphone-chat-thread-route";
import type { ChatThreadServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { and, eq } from "drizzle-orm";

import type { Db } from "../external/db";
import { appendChatThreadEvent } from "./chat-thread-event.service";
import {
  loadNewChatThreadMediaModels,
  type NewChatThreadMediaModels,
} from "./chat-thread-media-model.service";
import { loadNewChatThreadModelSettings } from "./chat-thread-model-settings.service";
import type { ModelSettings } from "@okouai/api-contracts/contracts/model-reasoning-effort";
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

interface CreatedAgentPhoneChatThread {
  readonly selectedModel: string | null;
  readonly serviceTier: ChatThreadServiceTier | null;
  readonly id: string;
  readonly createdAt: Date;
  readonly mediaModels: NewChatThreadMediaModels;
  readonly modelSettings: ModelSettings;
}

async function createCanonicalAgentPhoneChatThread(
  tx: AgentPhoneChatThreadTransaction,
  args: AgentPhoneChatThreadCreateArgs,
): Promise<CreatedAgentPhoneChatThread> {
  const initialModel = await resolveRequiredDefaultChatThreadModelPin(tx, args);
  const mediaModels = await loadNewChatThreadMediaModels(tx, {
    orgId: args.orgId,
    userId: args.userId,
  });
  const modelSettings = await loadNewChatThreadModelSettings(tx, {
    orgId: args.orgId,
    userId: args.userId,
  });
  const [thread] = await tx
    .insert(chatThreads)
    .values({
      userId: args.userId,
      agentId: args.agentId,
      computerUseHostId: null,
      cloudBrowserEnabled: false,
      selectedModel: initialModel.selectedModel,
      modelSettings,
      codexServiceTier: initialModel.serviceTier === "priority" ? "fast" : null,
      title: null,
      lastReadAt: args.currentTime,
      lastMessageAt: args.currentTime,
      createdAt: args.currentTime,
      updatedAt: args.currentTime,
      selectedImageModel: mediaModels.selectedImageModel,
    })
    .returning({ id: chatThreads.id, createdAt: chatThreads.createdAt });
  if (!thread) {
    throw new Error("Failed to create canonical AgentPhone chat thread");
  }
  return {
    ...thread,
    mediaModels,
    modelSettings,
    selectedModel: initialModel.selectedModel,
    serviceTier: initialModel.serviceTier,
  };
}

async function appendCanonicalAgentPhoneChatThreadCreatedEvent(
  tx: AgentPhoneChatThreadTransaction,
  args: AgentPhoneChatThreadCreateArgs,
  thread: CreatedAgentPhoneChatThread,
): Promise<void> {
  await appendChatThreadEvent(tx, {
    kind: "created",
    userId: args.userId,
    orgId: args.orgId,
    chatThreadId: thread.id,
    agentId: args.agentId,
    title: null,
    selectedModel: thread.selectedModel,
    modelSettings: thread.modelSettings,
    serviceTier: thread.serviceTier,
    computerUseHostId: null,
    ...thread.mediaModels,
    createdAt: thread.createdAt,
  });
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

    await appendCanonicalAgentPhoneChatThreadCreatedEvent(tx, args, thread);
    return route;
  });
}
