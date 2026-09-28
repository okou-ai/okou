import { resolveRequiredDefaultChatThreadModelPin } from "./chat-thread-model.service";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import {
  slackChatIngress,
  type SlackChatIngressStatus,
} from "@okouai/db/schema/slack-chat-ingress";
import { slackChatThreadRoutes } from "@okouai/db/schema/slack-chat-thread-route";
import { and, eq, sql } from "drizzle-orm";

import type { Db } from "../external/db";
import { appendChatThreadEvent } from "./chat-thread-event.service";
import { loadNewChatThreadMediaModels } from "./chat-thread-media-model.service";
import { loadNewChatThreadModelSettings } from "./chat-thread-model-settings.service";
import {
  INTEGRATION_DM_SESSION_KEY,
  isIntegrationDmSessionKey,
} from "../../lib/integration-dm-session";

interface SlackChatThreadRouteKey {
  readonly connectionId: string;
  readonly channelId: string;
  readonly threadTs: string;
  readonly userId: string;
}

interface SlackChatThreadRouteBinding extends SlackChatThreadRouteKey {
  readonly id: string;
  readonly chatThreadId: string;
}

export function slackSessionThreadTs(args: {
  readonly channelType: "channel" | "dm" | "group_dm";
  readonly messageTs: string;
  readonly threadTs?: string;
}): string {
  if (args.channelType === "dm" && !args.threadTs) {
    return INTEGRATION_DM_SESSION_KEY;
  }
  return args.threadTs ?? args.messageTs;
}

export function isSlackDirectMessageSessionThreadTs(threadTs: string): boolean {
  return isIntegrationDmSessionKey(threadTs);
}

function slackChatThreadRouteWhere(key: SlackChatThreadRouteKey) {
  return and(
    eq(slackChatThreadRoutes.connectionId, key.connectionId),
    key.threadTs === INTEGRATION_DM_SESSION_KEY
      ? undefined
      : eq(slackChatThreadRoutes.channelId, key.channelId),
    eq(slackChatThreadRoutes.threadTs, key.threadTs),
    eq(slackChatThreadRoutes.userId, key.userId),
  );
}

async function loadSlackChatThreadRoute(
  db: Pick<Db, "select" | "update">,
  key: SlackChatThreadRouteKey,
): Promise<SlackChatThreadRouteBinding | undefined> {
  const [route] = await db
    .select({
      id: slackChatThreadRoutes.id,
      connectionId: slackChatThreadRoutes.connectionId,
      channelId: slackChatThreadRoutes.channelId,
      threadTs: slackChatThreadRoutes.threadTs,
      userId: slackChatThreadRoutes.userId,
      chatThreadId: slackChatThreadRoutes.chatThreadId,
    })
    .from(slackChatThreadRoutes)
    .where(slackChatThreadRouteWhere(key))
    .limit(1);
  if (
    route &&
    key.threadTs === INTEGRATION_DM_SESSION_KEY &&
    route.channelId !== key.channelId
  ) {
    const [updated] = await db
      .update(slackChatThreadRoutes)
      .set({ channelId: key.channelId })
      .where(
        and(
          eq(slackChatThreadRoutes.id, route.id),
          slackChatThreadRouteWhere(key),
        ),
      )
      .returning({ channelId: slackChatThreadRoutes.channelId });
    if (!updated) {
      throw new Error("Failed to update Slack DM route destination");
    }
    return { ...route, ...updated };
  }
  return route;
}

export async function findSlackChatThreadRoute(
  db: Db,
  key: SlackChatThreadRouteKey,
): Promise<SlackChatThreadRouteBinding | undefined> {
  return await loadSlackChatThreadRoute(db, key);
}

/**
 * Read the main DM chat thread when `channelId` is the connection's DM
 * channel. Slash commands carry no thread timestamp, so only the main DM
 * conversation can be identified.
 */
export async function findSlackDirectMessageChatThreadId(
  db: Pick<Db, "select">,
  key: Omit<SlackChatThreadRouteKey, "threadTs">,
): Promise<string | undefined> {
  const [route] = await db
    .select({ chatThreadId: slackChatThreadRoutes.chatThreadId })
    .from(slackChatThreadRoutes)
    .where(
      and(
        slackChatThreadRouteWhere({
          ...key,
          threadTs: INTEGRATION_DM_SESSION_KEY,
        }),
        eq(slackChatThreadRoutes.channelId, key.channelId),
      ),
    )
    .limit(1);
  return route?.chatThreadId;
}

async function requireSlackChatThreadRoute(
  db: Pick<Db, "select" | "update">,
  key: SlackChatThreadRouteKey,
): Promise<SlackChatThreadRouteBinding> {
  const route = await loadSlackChatThreadRoute(db, key);
  if (!route) {
    throw new Error("Failed to resolve Slack chat thread route after conflict");
  }
  return route;
}

export async function ensureCanonicalSlackChatThreadRoute(
  db: Db,
  args: SlackChatThreadRouteKey & {
    readonly orgId: string;
    readonly agentId: string;
    readonly currentTime: Date;
  },
): Promise<SlackChatThreadRouteBinding> {
  return await db.transaction(async (tx) => {
    const existing = await loadSlackChatThreadRoute(tx, args);
    if (existing) {
      return existing;
    }

    const initialModel = await resolveRequiredDefaultChatThreadModelPin(
      tx,
      args,
    );
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
        selectedModel: initialModel.selectedModel,
        modelSettings,
        codexServiceTier:
          initialModel.serviceTier === "priority" ? "fast" : null,
        title: null,
        lastReadAt: args.currentTime,
        lastMessageAt: args.currentTime,
        createdAt: args.currentTime,
        updatedAt: args.currentTime,
        selectedImageModel: mediaModels.selectedImageModel,
      })
      .returning({ id: chatThreads.id, createdAt: chatThreads.createdAt });
    if (!thread) {
      throw new Error("Failed to create canonical Slack chat thread");
    }

    const [route] = await tx
      .insert(slackChatThreadRoutes)
      .values({
        connectionId: args.connectionId,
        channelId: args.channelId,
        threadTs: args.threadTs,
        userId: args.userId,
        chatThreadId: thread.id,
        createdAt: args.currentTime,
      })
      .onConflictDoNothing({
        target: [
          slackChatThreadRoutes.connectionId,
          slackChatThreadRoutes.channelId,
          slackChatThreadRoutes.threadTs,
          slackChatThreadRoutes.userId,
        ],
      })
      .returning({
        id: slackChatThreadRoutes.id,
        connectionId: slackChatThreadRoutes.connectionId,
        channelId: slackChatThreadRoutes.channelId,
        threadTs: slackChatThreadRoutes.threadTs,
        userId: slackChatThreadRoutes.userId,
        chatThreadId: slackChatThreadRoutes.chatThreadId,
      });

    if (!route) {
      await tx.delete(chatThreads).where(eq(chatThreads.id, thread.id));
      return await requireSlackChatThreadRoute(tx, args);
    }

    await appendChatThreadEvent(tx, {
      kind: "created",
      userId: args.userId,
      orgId: args.orgId,
      chatThreadId: thread.id,
      agentId: args.agentId,
      title: null,
      selectedModel: initialModel.selectedModel,
      modelSettings,
      serviceTier: initialModel.serviceTier,
      ...mediaModels,
      createdAt: thread.createdAt,
    });
    return route;
  });
}

interface SlackChatIngressAdmission {
  readonly id: string;
  readonly inserted: boolean;
  readonly status: SlackChatIngressStatus;
  readonly retryCount: number;
}

export async function admitCanonicalSlackChatEvent(
  db: Db,
  args: {
    readonly routeId: string;
    readonly eventId: string;
    readonly payload: string;
    readonly isRetry: boolean;
    readonly currentTime: Date;
  },
): Promise<SlackChatIngressAdmission> {
  return await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(slackChatIngress)
      .values({
        routeId: args.routeId,
        eventId: args.eventId,
        payload: args.payload,
        status: "pending",
        retryCount: args.isRetry ? 1 : 0,
        createdAt: args.currentTime,
        updatedAt: args.currentTime,
      })
      .onConflictDoNothing({ target: slackChatIngress.eventId })
      .returning({
        id: slackChatIngress.id,
        routeId: slackChatIngress.routeId,
        status: slackChatIngress.status,
        retryCount: slackChatIngress.retryCount,
      });
    if (inserted) {
      return { ...inserted, inserted: true };
    }

    const [existing] = await tx
      .select({
        id: slackChatIngress.id,
        routeId: slackChatIngress.routeId,
        status: slackChatIngress.status,
        retryCount: slackChatIngress.retryCount,
      })
      .from(slackChatIngress)
      .where(eq(slackChatIngress.eventId, args.eventId))
      .limit(1);
    if (!existing) {
      throw new Error("Failed to resolve canonical Slack ingress event");
    }
    if (existing.routeId !== args.routeId) {
      throw new Error("Slack event ID is already bound to another route");
    }
    if (!args.isRetry) {
      return { ...existing, inserted: false };
    }

    const [retried] = await tx
      .update(slackChatIngress)
      .set({
        retryCount: sql`${slackChatIngress.retryCount} + 1`,
        updatedAt: args.currentTime,
      })
      .where(eq(slackChatIngress.id, existing.id))
      .returning({
        id: slackChatIngress.id,
        status: slackChatIngress.status,
        retryCount: slackChatIngress.retryCount,
      });
    if (!retried) {
      throw new Error("Failed to record canonical Slack ingress retry");
    }
    return { ...retried, inserted: false };
  });
}
