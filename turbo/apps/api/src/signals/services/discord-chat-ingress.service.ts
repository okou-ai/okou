import { createHash } from "node:crypto";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { discordGatewayReceipts } from "@okouai/db/schema/discord-gateway-receipt";
import type { ChatThreadServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import {
  discordChatIngress,
  type DiscordChatIngressStatus,
} from "@okouai/db/schema/discord-chat-ingress";
import { discordChatThreadRoutes } from "@okouai/db/schema/discord-chat-thread-route";
import { and, eq } from "drizzle-orm";

import type { Db } from "../external/db";
import { appendChatThreadEvent } from "./chat-thread-event.service";
import { loadNewChatThreadMediaModels } from "./chat-thread-media-model.service";
import { loadNewChatThreadModelSettings } from "./chat-thread-model-settings.service";
import type { Tx } from "../../lib/db-types";

interface DiscordChatThreadRouteKey {
  readonly connectionId: string;
  readonly channelId: string;
  readonly sessionKey: string;
  readonly userId: string;
}

export interface DiscordChatThreadRouteBinding extends DiscordChatThreadRouteKey {
  readonly id: string;
  readonly chatThreadId: string;
  readonly destinationChannelId: string | null;
}

function discordChatThreadRouteWhere(key: DiscordChatThreadRouteKey) {
  return and(
    eq(discordChatThreadRoutes.connectionId, key.connectionId),
    eq(discordChatThreadRoutes.channelId, key.channelId),
    eq(discordChatThreadRoutes.sessionKey, key.sessionKey),
    eq(discordChatThreadRoutes.userId, key.userId),
  );
}

async function loadDiscordChatThreadRoute(
  db: Pick<Db, "select">,
  key: DiscordChatThreadRouteKey,
): Promise<DiscordChatThreadRouteBinding | undefined> {
  const [route] = await db
    .select({
      id: discordChatThreadRoutes.id,
      connectionId: discordChatThreadRoutes.connectionId,
      channelId: discordChatThreadRoutes.channelId,
      sessionKey: discordChatThreadRoutes.sessionKey,
      userId: discordChatThreadRoutes.userId,
      chatThreadId: discordChatThreadRoutes.chatThreadId,
      destinationChannelId: discordChatThreadRoutes.destinationChannelId,
    })
    .from(discordChatThreadRoutes)
    .where(discordChatThreadRouteWhere(key))
    .limit(1);
  return route;
}

export async function findDiscordChatThreadRoute(
  db: Db,
  key: DiscordChatThreadRouteKey,
): Promise<DiscordChatThreadRouteBinding | undefined> {
  return await loadDiscordChatThreadRoute(db, key);
}

async function requireDiscordChatThreadRoute(
  db: Pick<Db, "select">,
  key: DiscordChatThreadRouteKey,
): Promise<DiscordChatThreadRouteBinding> {
  const route = await loadDiscordChatThreadRoute(db, key);
  if (!route) {
    throw new Error(
      "Failed to resolve Discord chat thread route after conflict",
    );
  }
  return route;
}

export async function ensureCanonicalDiscordChatThreadRoute(
  db: Db,
  args: DiscordChatThreadRouteKey & {
    readonly orgId: string;
    readonly agentId: string;
    readonly selectedModel: string | null;
    readonly serviceTier: ChatThreadServiceTier | null;
    readonly currentTime: Date;
    readonly ingressId: string;
    readonly claimToken: string;
  },
): Promise<DiscordChatThreadRouteBinding | undefined> {
  return await db.transaction(async (tx) => {
    const [claim] = await tx
      .select({ routeId: discordChatIngress.routeId })
      .from(discordChatIngress)
      .where(
        and(
          eq(discordChatIngress.id, args.ingressId),
          eq(discordChatIngress.connectionId, args.connectionId),
          eq(discordChatIngress.claimToken, args.claimToken),
          eq(discordChatIngress.status, "processing"),
        ),
      )
      .for("update")
      .limit(1);
    if (!claim) {
      return undefined;
    }
    if (claim.routeId) {
      const [assigned] = await tx
        .select()
        .from(discordChatThreadRoutes)
        .where(eq(discordChatThreadRoutes.id, claim.routeId))
        .limit(1);
      if (!assigned) {
        throw new Error("Discord ingress has no assigned route");
      }
      return assigned;
    }
    const existing = await loadDiscordChatThreadRoute(tx, args);
    if (existing) {
      await attachIngressRoute(tx, args.ingressId, existing.id);
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
      throw new Error("Failed to create canonical Discord chat thread");
    }

    const [route] = await tx
      .insert(discordChatThreadRoutes)
      .values({
        connectionId: args.connectionId,
        channelId: args.channelId,
        sessionKey: args.sessionKey,
        userId: args.userId,
        chatThreadId: thread.id,
        createdAt: args.currentTime,
      })
      .onConflictDoNothing({
        target: [
          discordChatThreadRoutes.connectionId,
          discordChatThreadRoutes.channelId,
          discordChatThreadRoutes.sessionKey,
          discordChatThreadRoutes.userId,
        ],
      })
      .returning({
        id: discordChatThreadRoutes.id,
        connectionId: discordChatThreadRoutes.connectionId,
        channelId: discordChatThreadRoutes.channelId,
        sessionKey: discordChatThreadRoutes.sessionKey,
        userId: discordChatThreadRoutes.userId,
        chatThreadId: discordChatThreadRoutes.chatThreadId,
        destinationChannelId: discordChatThreadRoutes.destinationChannelId,
      });

    if (!route) {
      await tx.delete(chatThreads).where(eq(chatThreads.id, thread.id));
      const winner = await requireDiscordChatThreadRoute(tx, args);
      await attachIngressRoute(tx, args.ingressId, winner.id);
      return winner;
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
    await attachIngressRoute(tx, args.ingressId, route.id);
    return route;
  });
}

async function attachIngressRoute(tx: Tx, ingressId: string, routeId: string) {
  await tx
    .update(discordChatIngress)
    .set({ routeId })
    .where(eq(discordChatIngress.id, ingressId));
}

interface DiscordChatIngressAdmission {
  readonly id: string;
  readonly inserted: boolean;
  readonly status: DiscordChatIngressStatus;
}

export async function findCanonicalDiscordIngressByMessage(
  db: Db,
  messageId: string,
) {
  const [ingress] = await db
    .select({
      id: discordChatIngress.id,
      payload: discordChatIngress.payload,
    })
    .from(discordChatIngress)
    .where(eq(discordChatIngress.messageId, messageId))
    .limit(1);
  return ingress;
}

function discordMessageReceiptDigest(applicationId: string, messageId: string) {
  return createHash("sha256")
    .update(JSON.stringify([applicationId, "MESSAGE_CREATE", messageId]))
    .digest("hex");
}

export async function hasCanonicalDiscordMessageReceipt(
  db: Db,
  applicationId: string,
  messageId: string,
): Promise<boolean> {
  const [receipt] = await db
    .select({ eventDigest: discordGatewayReceipts.eventDigest })
    .from(discordGatewayReceipts)
    .where(
      eq(
        discordGatewayReceipts.eventDigest,
        discordMessageReceiptDigest(applicationId, messageId),
      ),
    )
    .limit(1);
  return Boolean(receipt);
}

export async function admitCanonicalDiscordChatEvent(
  db: Db,
  args: {
    readonly applicationId: string;
    readonly connectionId: string;
    readonly messageId: string;
    readonly eventId: string;
    readonly payload: string;
    readonly publicBrand: PublicBrand;
    readonly currentTime: Date;
  },
): Promise<DiscordChatIngressAdmission | undefined> {
  return await db.transaction(async (tx) => {
    // This identity-only digest survives connection/chat deletion. Raw payloads
    // still cascade, while a lost ACK cannot launch the same message again
    // after reconnecting or deleting its canonical chat.
    const [receipt] = await tx
      .insert(discordGatewayReceipts)
      .values({
        eventDigest: discordMessageReceiptDigest(
          args.applicationId,
          args.messageId,
        ),
        createdAt: args.currentTime,
      })
      .onConflictDoNothing()
      .returning({ eventDigest: discordGatewayReceipts.eventDigest });
    if (!receipt) {
      return undefined;
    }
    const [inserted] = await tx
      .insert(discordChatIngress)
      .values({
        connectionId: args.connectionId,
        messageId: args.messageId,
        eventId: args.eventId,
        payload: args.payload,
        publicBrand: args.publicBrand,
        status: "pending",
        createdAt: args.currentTime,
        updatedAt: args.currentTime,
      })
      .onConflictDoNothing({ target: discordChatIngress.messageId })
      .returning({
        id: discordChatIngress.id,
        connectionId: discordChatIngress.connectionId,
        status: discordChatIngress.status,
      });
    if (inserted) {
      return { ...inserted, inserted: true };
    }

    const [existing] = await tx
      .select({
        id: discordChatIngress.id,
        connectionId: discordChatIngress.connectionId,
        status: discordChatIngress.status,
      })
      .from(discordChatIngress)
      .where(eq(discordChatIngress.messageId, args.messageId))
      .limit(1);
    if (!existing) {
      throw new Error("Failed to resolve canonical Discord ingress event");
    }
    if (existing.connectionId !== args.connectionId) {
      throw new Error(
        "Discord message ID is already bound to another connection",
      );
    }
    return { ...existing, inserted: false };
  });
}
