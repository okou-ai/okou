import { resolveRequiredDefaultChatThreadModelPin } from "./chat-thread-model.service";
import { INTEGRATION_DM_SESSION_KEY } from "../../lib/integration-dm-session";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import type { ChatThreadServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
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

type LoadedTeamsChatThreadRoute = TeamsChatThreadRouteBinding;

type TeamsChatThreadTransaction = Tx;

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
export async function findTeamsRoutedChatThreadId(
  db: Pick<Db, "select">,
  key: TeamsChatThreadRouteKey,
): Promise<string | undefined> {
  const [route] = await db
    .select({ chatThreadId: teamsChatThreadRoutes.chatThreadId })
    .from(teamsChatThreadRoutes)
    .where(routeWhere(key))
    .limit(1);
  return route?.chatThreadId;
}

async function loadRoute(
  db: Pick<Db, "select" | "update">,
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
    })
    .from(teamsChatThreadRoutes)
    .innerJoin(
      chatThreads,
      eq(chatThreads.id, teamsChatThreadRoutes.chatThreadId),
    )
    .where(routeWhere(key))
    .limit(1)
    .for("update");
  if (
    route &&
    key.threadId === INTEGRATION_DM_SESSION_KEY &&
    route.conversationId !== key.conversationId
  ) {
    const [updated] = await db
      .update(teamsChatThreadRoutes)
      .set({ conversationId: key.conversationId })
      .where(and(eq(teamsChatThreadRoutes.id, route.id), routeWhere(key)))
      .returning({ conversationId: teamsChatThreadRoutes.conversationId });
    if (!updated) {
      throw new Error("Failed to update Teams DM route destination");
    }
    return { ...route, ...updated };
  }
  return route;
}

interface CreatedTeamsChatThread {
  readonly selectedModel: string | null;
  readonly serviceTier: ChatThreadServiceTier | null;
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
    readonly currentTime: Date;
  },
): Promise<CreatedTeamsChatThread> {
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
    throw new Error("Failed to create canonical Teams chat thread");
  }
  return {
    ...thread,
    mediaModels,
    modelSettings,
    selectedModel: initialModel.selectedModel,
    serviceTier: initialModel.serviceTier,
  };
}

async function appendCanonicalTeamsChatThreadCreatedEvent(
  tx: TeamsChatThreadTransaction,
  args: TeamsChatThreadRouteKey & {
    readonly orgId: string;
    readonly agentId: string;
  },
  thread: CreatedTeamsChatThread,
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

export async function ensureTeamsChatThreadRoute(
  db: Db,
  args: TeamsChatThreadRouteKey & {
    readonly orgId: string;
    readonly agentId: string;
    readonly currentTime: Date;
  },
): Promise<TeamsChatThreadRouteBinding> {
  return await db.transaction(async (tx) => {
    const existing = await loadRoute(tx, args);
    if (existing) {
      return existing;
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
      return conflicted;
    }

    await appendCanonicalTeamsChatThreadCreatedEvent(tx, args, thread);
    return route;
  });
}
