import { chatThreads } from "@okouai/db/schema/chat-thread";
import type { ChatThreadServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import {
  feishuChatIngress,
  type FeishuChatIngressStatus,
} from "@okouai/db/schema/feishu-chat-ingress";
import { feishuChatThreadRoutes } from "@okouai/db/schema/feishu-chat-thread-route";
import { feishuOrgEvents } from "@okouai/db/schema/feishu-org-event";
import { and, eq, sql } from "drizzle-orm";

import type { Db } from "../external/db";
import { appendChatThreadEvent } from "./chat-thread-event.service";
import { loadNewChatThreadMediaModels } from "./chat-thread-media-model.service";
import { loadNewChatThreadModelSettings } from "./chat-thread-model-settings.service";

interface FeishuChatThreadRouteKey {
  readonly connectionId: string;
  readonly chatId: string;
  readonly threadId: string;
  readonly userId: string;
}

interface FeishuChatThreadRouteBinding extends FeishuChatThreadRouteKey {
  readonly id: string;
  readonly chatThreadId: string;
}

function routeWhere(key: FeishuChatThreadRouteKey) {
  return and(
    eq(feishuChatThreadRoutes.connectionId, key.connectionId),
    eq(feishuChatThreadRoutes.chatId, key.chatId),
    eq(feishuChatThreadRoutes.threadId, key.threadId),
    eq(feishuChatThreadRoutes.userId, key.userId),
  );
}

async function loadRoute(
  db: Pick<Db, "select">,
  key: FeishuChatThreadRouteKey,
): Promise<FeishuChatThreadRouteBinding | undefined> {
  const [route] = await db
    .select({
      id: feishuChatThreadRoutes.id,
      connectionId: feishuChatThreadRoutes.connectionId,
      chatId: feishuChatThreadRoutes.chatId,
      threadId: feishuChatThreadRoutes.threadId,
      userId: feishuChatThreadRoutes.userId,
      chatThreadId: feishuChatThreadRoutes.chatThreadId,
    })
    .from(feishuChatThreadRoutes)
    .where(routeWhere(key))
    .limit(1);
  return route;
}

export async function ensureFeishuChatThreadRoute(
  db: Db,
  args: FeishuChatThreadRouteKey & {
    readonly orgId: string;
    readonly agentId: string;
    readonly selectedModel: string | null;
    readonly serviceTier: ChatThreadServiceTier | null;
    readonly currentTime: Date;
  },
): Promise<FeishuChatThreadRouteBinding> {
  return await db.transaction(async (tx) => {
    const existing = await loadRoute(tx, args);
    if (existing) {
      return existing;
    }

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
      throw new Error("Failed to create canonical Feishu chat thread");
    }

    const [route] = await tx
      .insert(feishuChatThreadRoutes)
      .values({
        connectionId: args.connectionId,
        chatId: args.chatId,
        threadId: args.threadId,
        userId: args.userId,
        chatThreadId: thread.id,
        createdAt: args.currentTime,
      })
      .onConflictDoNothing({
        target: [
          feishuChatThreadRoutes.connectionId,
          feishuChatThreadRoutes.chatId,
          feishuChatThreadRoutes.threadId,
          feishuChatThreadRoutes.userId,
        ],
      })
      .returning({
        id: feishuChatThreadRoutes.id,
        connectionId: feishuChatThreadRoutes.connectionId,
        chatId: feishuChatThreadRoutes.chatId,
        threadId: feishuChatThreadRoutes.threadId,
        userId: feishuChatThreadRoutes.userId,
        chatThreadId: feishuChatThreadRoutes.chatThreadId,
      });

    if (!route) {
      await tx.delete(chatThreads).where(eq(chatThreads.id, thread.id));
      const conflicted = await loadRoute(tx, args);
      if (!conflicted) {
        throw new Error(
          "Failed to resolve Feishu chat thread route after conflict",
        );
      }
      return conflicted;
    }

    await appendChatThreadEvent(tx, {
      kind: "created",
      userId: args.userId,
      orgId: args.orgId,
      chatThreadId: thread.id,
      agentId: args.agentId,
      title: null,
      selectedModel: args.selectedModel,
      modelSettings,
      serviceTier: args.serviceTier,
      ...mediaModels,
      createdAt: thread.createdAt,
    });
    return route;
  });
}

interface FeishuChatIngressAdmission {
  readonly id: string;
  readonly inserted: boolean;
  readonly status: FeishuChatIngressStatus;
  readonly retryCount: number;
}

export async function admitFeishuChatEvent(
  db: Db,
  args: {
    readonly installationId: string;
    readonly eventId: string;
    readonly payload: string;
    readonly publicBrand: PublicBrand;
    readonly currentTime: Date;
  },
): Promise<FeishuChatIngressAdmission | null> {
  return await db.transaction(async (tx) => {
    const [receipt] = await tx
      .insert(feishuOrgEvents)
      .values({
        installationId: args.installationId,
        eventId: args.eventId,
        receivedAt: args.currentTime,
      })
      .onConflictDoNothing({
        target: [feishuOrgEvents.installationId, feishuOrgEvents.eventId],
      })
      .returning({ eventId: feishuOrgEvents.eventId });

    if (receipt) {
      const [inserted] = await tx
        .insert(feishuChatIngress)
        .values({
          installationId: args.installationId,
          eventId: args.eventId,
          payload: args.payload,
          publicBrand: args.publicBrand,
          status: "pending",
          createdAt: args.currentTime,
          updatedAt: args.currentTime,
        })
        .returning({
          id: feishuChatIngress.id,
          status: feishuChatIngress.status,
          retryCount: feishuChatIngress.retryCount,
        });
      if (!inserted) {
        throw new Error("Failed to persist Feishu ingress event");
      }
      return { ...inserted, inserted: true };
    }

    const [existing] = await tx
      .select({
        id: feishuChatIngress.id,
        status: feishuChatIngress.status,
        retryCount: feishuChatIngress.retryCount,
      })
      .from(feishuChatIngress)
      .where(
        and(
          eq(feishuChatIngress.installationId, args.installationId),
          eq(feishuChatIngress.eventId, args.eventId),
        ),
      )
      .limit(1);
    if (!existing) {
      return null;
    }
    const [retried] = await tx
      .update(feishuChatIngress)
      .set({
        retryCount: sql`${feishuChatIngress.retryCount} + 1`,
        updatedAt: args.currentTime,
      })
      .where(eq(feishuChatIngress.id, existing.id))
      .returning({
        id: feishuChatIngress.id,
        status: feishuChatIngress.status,
        retryCount: feishuChatIngress.retryCount,
      });
    if (!retried) {
      throw new Error("Failed to record Feishu ingress retry");
    }
    return { ...retried, inserted: false };
  });
}
