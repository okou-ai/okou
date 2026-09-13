import { agentphoneChatThreadRoutes } from "@okouai/db/schema/agentphone-chat-thread-route";
import type { ChatThreadServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import { agents } from "@okouai/db/schema/agent";
import { chatThreads } from "@okouai/db/schema/chat-thread";
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
  readonly agentId: string;
  readonly selectedModel: string | null;
  readonly codexServiceTier: "fast" | null;
  readonly computerUseHostId: string | null;
}

interface AgentPhoneChatThreadCreateArgs {
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly selectedModel: string | null;
  readonly serviceTier: ChatThreadServiceTier | null;
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

async function loadRoute(
  db: Pick<Db, "select">,
  key: AgentPhoneChatThreadRouteKey,
): Promise<LoadedAgentPhoneChatThreadRoute | undefined> {
  const [route] = await db
    .select({
      id: agentphoneChatThreadRoutes.id,
      conversationId: agentphoneChatThreadRoutes.conversationId,
      chatThreadId: agentphoneChatThreadRoutes.chatThreadId,
      agentId: agents.id,
      selectedModel: chatThreads.selectedModel,
      codexServiceTier: chatThreads.codexServiceTier,
      computerUseHostId: chatThreads.computerUseHostId,
    })
    .from(agentphoneChatThreadRoutes)
    .innerJoin(
      chatThreads,
      eq(chatThreads.id, agentphoneChatThreadRoutes.chatThreadId),
    )
    .innerJoin(agents, eq(agents.id, chatThreads.agentId))
    .where(routeWhere(key))
    .limit(1)
    .for("update");
  return route;
}

interface CreatedAgentPhoneChatThread {
  readonly id: string;
  readonly createdAt: Date;
  readonly mediaModels: NewChatThreadMediaModels;
  readonly modelSettings: ModelSettings;
}

async function createCanonicalAgentPhoneChatThread(
  tx: AgentPhoneChatThreadTransaction,
  args: AgentPhoneChatThreadCreateArgs,
  computerUseHostId: string | null = null,
): Promise<CreatedAgentPhoneChatThread> {
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
      computerUseHostId,
      selectedModel: args.selectedModel,
      modelSettings,
      codexServiceTier: args.serviceTier === "priority" ? "fast" : null,
      title: null,
      lastReadAt: args.currentTime,
      lastMessageAt: args.currentTime,
      createdAt: args.currentTime,
      updatedAt: args.currentTime,
      selectedVideoModel: mediaModels.selectedVideoModel,
      selectedImageModel: mediaModels.selectedImageModel,
    })
    .returning({ id: chatThreads.id, createdAt: chatThreads.createdAt });
  if (!thread) {
    throw new Error("Failed to create canonical AgentPhone chat thread");
  }
  return { ...thread, mediaModels, modelSettings };
}

async function appendCanonicalAgentPhoneChatThreadCreatedEvent(
  tx: AgentPhoneChatThreadTransaction,
  args: AgentPhoneChatThreadCreateArgs,
  thread: CreatedAgentPhoneChatThread,
  computerUseHostId: string | null | undefined,
): Promise<void> {
  await appendChatThreadEvent(tx, {
    kind: "created",
    userId: args.userId,
    orgId: args.orgId,
    chatThreadId: thread.id,
    agentId: args.agentId,
    title: null,
    selectedModel: args.selectedModel,
    modelSettings: thread.modelSettings,
    serviceTier: args.serviceTier,
    computerUseHostId,
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

async function reconcileExistingRoute(
  tx: AgentPhoneChatThreadTransaction,
  args: AgentPhoneChatThreadRouteKey & AgentPhoneChatThreadCreateArgs,
  existing: LoadedAgentPhoneChatThreadRoute,
): Promise<AgentPhoneChatThreadBinding> {
  if (existing.agentId !== args.agentId) {
    const thread = await createCanonicalAgentPhoneChatThread(
      tx,
      args,
      existing.computerUseHostId,
    );
    const [route] = await tx
      .update(agentphoneChatThreadRoutes)
      .set({
        chatThreadId: thread.id,
        conversationId: args.conversationId,
      })
      .where(
        and(
          eq(agentphoneChatThreadRoutes.id, existing.id),
          eq(agentphoneChatThreadRoutes.chatThreadId, existing.chatThreadId),
        ),
      )
      .returning({ chatThreadId: agentphoneChatThreadRoutes.chatThreadId });
    if (!route) {
      throw new Error("Failed to rebind AgentPhone chat thread route");
    }
    await appendCanonicalAgentPhoneChatThreadCreatedEvent(
      tx,
      args,
      thread,
      existing.computerUseHostId,
    );
    return route;
  }

  await updateRouteConversationContext(tx, existing, args.conversationId);
  const selectedModelChanged = existing.selectedModel !== args.selectedModel;
  const codexServiceTier = args.serviceTier === "priority" ? "fast" : null;
  const serviceTierChanged = existing.codexServiceTier !== codexServiceTier;
  if (selectedModelChanged || serviceTierChanged) {
    const [thread] = await tx
      .update(chatThreads)
      .set({
        ...(selectedModelChanged
          ? {
              modelProviderId: null,
              modelProviderType: null,
              modelProviderCredentialScope: null,
              selectedModel: args.selectedModel,
            }
          : {}),
        codexServiceTier,
        updatedAt: args.currentTime,
      })
      .where(eq(chatThreads.id, existing.chatThreadId))
      .returning({ id: chatThreads.id });
    if (!thread) {
      throw new Error("Failed to update canonical AgentPhone thread model");
    }
    if (selectedModelChanged) {
      await appendChatThreadEvent(tx, {
        kind: "model_selection_updated",
        userId: args.userId,
        orgId: args.orgId,
        chatThreadId: existing.chatThreadId,
        agentId: existing.agentId,
        selectedModel: args.selectedModel,
        createdAt: args.currentTime,
      });
    }
    if (serviceTierChanged) {
      await appendChatThreadEvent(tx, {
        kind: "service_tier_updated",
        userId: args.userId,
        orgId: args.orgId,
        chatThreadId: existing.chatThreadId,
        agentId: existing.agentId,
        serviceTier: args.serviceTier,
        createdAt: args.currentTime,
      });
    }
  }
  return existing;
}

export async function ensureAgentPhoneChatThreadRoute(
  db: Db,
  args: AgentPhoneChatThreadRouteKey & AgentPhoneChatThreadCreateArgs,
): Promise<AgentPhoneChatThreadBinding> {
  return await db.transaction(async (tx) => {
    const existing = await loadRoute(tx, args);
    if (existing) {
      return await reconcileExistingRoute(tx, args, existing);
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
      return await reconcileExistingRoute(tx, args, conflicted);
    }

    await appendCanonicalAgentPhoneChatThreadCreatedEvent(
      tx,
      args,
      thread,
      null,
    );
    return route;
  });
}
