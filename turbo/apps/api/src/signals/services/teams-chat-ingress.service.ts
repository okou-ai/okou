import type { DefaultModelFirstPin } from "./model-selection.service";
import { INTEGRATION_DM_SESSION_KEY } from "../../lib/integration-dm-session";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { teamsChatThreadRoutes } from "@okouai/db/schema/teams-chat-thread-route";
import { and, eq } from "drizzle-orm";

import type { Db } from "../external/db";
import {
  appendChatThreadCreatedEvent,
  insertChatThread,
} from "./chat-thread-create.service";
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

async function createCanonicalTeamsChatThread(
  tx: TeamsChatThreadTransaction,
  args: TeamsChatThreadRouteKey & {
    readonly orgId: string;
    readonly agentId: string;
    readonly currentTime: Date;
    readonly initialModel: DefaultModelFirstPin;
  },
): Promise<NonNullable<Awaited<ReturnType<typeof insertChatThread>>>> {
  const { initialModel } = args;
  if (!initialModel.selectedModel) {
    throw new Error("A model selection is required");
  }
  const thread = await insertChatThread(tx, {
    orgId: args.orgId,
    userId: args.userId,
    agentId: args.agentId,
    selectedModel: initialModel.selectedModel,
    codexServiceTier: initialModel.serviceTier === "priority" ? "fast" : null,
    title: null,
    lastReadAt: args.currentTime,
    lastMessageAt: args.currentTime,
    createdAt: args.currentTime,
    updatedAt: args.currentTime,
  });
  if (!thread) {
    throw new Error("Failed to create canonical Teams chat thread");
  }
  return thread;
}

export async function ensureTeamsChatThreadRoute(
  db: Db,
  args: TeamsChatThreadRouteKey & {
    readonly orgId: string;
    readonly agentId: string;
    readonly currentTime: Date;
    readonly initialModel: DefaultModelFirstPin;
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

    await appendChatThreadCreatedEvent(tx, { orgId: args.orgId, thread });
    return route;
  });
}
