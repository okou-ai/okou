import { chatThreads } from "@okouai/db/schema/chat-thread";
import type { ChatThreadServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import { agents } from "@okouai/db/schema/agent";
import { teamsChatThreadRoutes } from "@okouai/db/schema/teams-chat-thread-route";
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

interface LoadedTeamsChatThreadRoute extends TeamsChatThreadRouteBinding {
  readonly agentId: string;
  readonly selectedModel: string | null;
  readonly codexServiceTier: "fast" | null;
  readonly computerUseHostId: string | null;
}

type TeamsChatThreadTransaction = Tx;

function routeWhere(key: TeamsChatThreadRouteKey) {
  return and(
    eq(teamsChatThreadRoutes.connectionId, key.connectionId),
    eq(teamsChatThreadRoutes.conversationId, key.conversationId),
    eq(teamsChatThreadRoutes.threadId, key.threadId),
    eq(teamsChatThreadRoutes.userId, key.userId),
  );
}

async function loadRoute(
  db: Pick<Db, "select">,
  key: TeamsChatThreadRouteKey,
): Promise<LoadedTeamsChatThreadRoute | undefined> {
  const [route] = await db
    .select({
      id: teamsChatThreadRoutes.id,
      connectionId: teamsChatThreadRoutes.connectionId,
      conversationId: teamsChatThreadRoutes.conversationId,
      threadId: teamsChatThreadRoutes.threadId,
      userId: teamsChatThreadRoutes.userId,
      chatThreadId: teamsChatThreadRoutes.chatThreadId,
      agentId: agents.id,
      selectedModel: chatThreads.selectedModel,
      codexServiceTier: chatThreads.codexServiceTier,
      computerUseHostId: chatThreads.computerUseHostId,
    })
    .from(teamsChatThreadRoutes)
    .innerJoin(
      chatThreads,
      eq(chatThreads.id, teamsChatThreadRoutes.chatThreadId),
    )
    .innerJoin(agents, eq(agents.id, chatThreads.agentId))
    .where(routeWhere(key))
    .limit(1)
    .for("update");
  return route;
}

interface CreatedTeamsChatThread {
  readonly id: string;
  readonly createdAt: Date;
  readonly mediaModels: NewChatThreadMediaModels;
  readonly modelSettings: ModelSettings;
}

async function createCanonicalTeamsChatThread(
  tx: TeamsChatThreadTransaction,
  args: TeamsChatThreadRouteKey & {
    readonly orgId: string;
    readonly agentId: string;
    readonly selectedModel: string | null;
    readonly serviceTier: ChatThreadServiceTier | null;
    readonly currentTime: Date;
  },
  computerUseHostId: string | null = null,
): Promise<CreatedTeamsChatThread> {
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
    throw new Error("Failed to create canonical Teams chat thread");
  }
  return { ...thread, mediaModels, modelSettings };
}

async function appendCanonicalTeamsChatThreadCreatedEvent(
  tx: TeamsChatThreadTransaction,
  args: TeamsChatThreadRouteKey & {
    readonly orgId: string;
    readonly agentId: string;
    readonly selectedModel: string | null;
    readonly serviceTier: ChatThreadServiceTier | null;
  },
  thread: CreatedTeamsChatThread,
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

async function reconcileExistingRoute(
  tx: TeamsChatThreadTransaction,
  args: TeamsChatThreadRouteKey & {
    readonly orgId: string;
    readonly agentId: string;
    readonly selectedModel: string | null;
    readonly serviceTier: ChatThreadServiceTier | null;
    readonly currentTime: Date;
  },
  existing: LoadedTeamsChatThreadRoute,
): Promise<TeamsChatThreadRouteBinding> {
  if (existing.agentId !== args.agentId) {
    const thread = await createCanonicalTeamsChatThread(
      tx,
      args,
      existing.computerUseHostId,
    );
    const [route] = await tx
      .update(teamsChatThreadRoutes)
      .set({ chatThreadId: thread.id })
      .where(
        and(
          eq(teamsChatThreadRoutes.id, existing.id),
          eq(teamsChatThreadRoutes.chatThreadId, existing.chatThreadId),
        ),
      )
      .returning({
        id: teamsChatThreadRoutes.id,
        connectionId: teamsChatThreadRoutes.connectionId,
        conversationId: teamsChatThreadRoutes.conversationId,
        threadId: teamsChatThreadRoutes.threadId,
        userId: teamsChatThreadRoutes.userId,
        chatThreadId: teamsChatThreadRoutes.chatThreadId,
      });
    if (!route) {
      throw new Error("Failed to rebind Teams chat thread route");
    }
    await appendCanonicalTeamsChatThreadCreatedEvent(
      tx,
      args,
      thread,
      existing.computerUseHostId,
    );
    return route;
  }

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
      throw new Error("Failed to update canonical Teams chat thread model");
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

export async function ensureTeamsChatThreadRoute(
  db: Db,
  args: TeamsChatThreadRouteKey & {
    readonly orgId: string;
    readonly agentId: string;
    readonly selectedModel: string | null;
    readonly serviceTier: ChatThreadServiceTier | null;
    readonly currentTime: Date;
  },
): Promise<TeamsChatThreadRouteBinding> {
  return await db.transaction(async (tx) => {
    const existing = await loadRoute(tx, args);
    if (existing) {
      return await reconcileExistingRoute(tx, args, existing);
    }

    const thread = await createCanonicalTeamsChatThread(tx, args);

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
      .returning({
        id: teamsChatThreadRoutes.id,
        connectionId: teamsChatThreadRoutes.connectionId,
        conversationId: teamsChatThreadRoutes.conversationId,
        threadId: teamsChatThreadRoutes.threadId,
        userId: teamsChatThreadRoutes.userId,
        chatThreadId: teamsChatThreadRoutes.chatThreadId,
      });

    if (!route) {
      await tx.delete(chatThreads).where(eq(chatThreads.id, thread.id));
      const conflicted = await loadRoute(tx, args);
      if (!conflicted) {
        throw new Error(
          "Failed to resolve Teams chat thread route after conflict",
        );
      }
      return await reconcileExistingRoute(tx, args, conflicted);
    }

    await appendCanonicalTeamsChatThreadCreatedEvent(tx, args, thread, null);
    return route;
  });
}
