import type { DefaultModelFirstPin } from "./model-selection.service";
import { INTEGRATION_DM_SESSION_KEY } from "../../lib/integration-dm-session";
import { createHash, randomUUID } from "node:crypto";
import { command } from "ccstate";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { discordGatewayReceipts } from "@okouai/db/schema/discord-gateway-receipt";
import {
  discordChatIngress,
  type DiscordChatIngressStatus,
} from "@okouai/db/schema/discord-chat-ingress";
import { discordChatThreadRoutes } from "@okouai/db/schema/discord-chat-thread-route";
import { and, eq } from "drizzle-orm";

import { writeDb$, type Db } from "../external/db";
import { loadNewChatThreadDefaults$ } from "./chat-thread-defaults.service";
import {
  integrationChatThreadValues,
  integrationThreadCreatedEventSql,
} from "./integration-chat-thread-publication";

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

export function discordChatThreadRouteWhere(key: DiscordChatThreadRouteKey) {
  return and(
    eq(discordChatThreadRoutes.connectionId, key.connectionId),
    key.sessionKey === INTEGRATION_DM_SESSION_KEY
      ? undefined
      : eq(discordChatThreadRoutes.channelId, key.channelId),
    eq(discordChatThreadRoutes.sessionKey, key.sessionKey),
    eq(discordChatThreadRoutes.userId, key.userId),
  );
}

export async function findDiscordChatThreadRoute(
  db: Db,
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
  if (!route) {
    return undefined;
  }
  const channelId = key.channelId;
  if (
    route.sessionKey !== INTEGRATION_DM_SESSION_KEY ||
    (route.channelId === channelId &&
      (route.destinationChannelId === null ||
        route.destinationChannelId === channelId))
  ) {
    return route;
  }
  const [updated] = await db
    .update(discordChatThreadRoutes)
    .set({ channelId, destinationChannelId: channelId })
    .where(
      and(
        eq(discordChatThreadRoutes.id, route.id),
        discordChatThreadRouteWhere(route),
      ),
    )
    .returning({
      channelId: discordChatThreadRoutes.channelId,
      destinationChannelId: discordChatThreadRoutes.destinationChannelId,
    });
  if (!updated) {
    throw new Error("Failed to update Discord DM route destination");
  }
  return { ...route, ...updated };
}

/**
 * Read the chat thread behind the Discord channel an interaction came from:
 * the main DM conversation for a DM, or the server thread whose route session
 * is that thread channel. Interactions in a parent channel match no route.
 */
export async function findDiscordInteractionChatThreadId(
  db: Pick<Db, "select">,
  args: {
    readonly connectionId: string;
    readonly userId: string;
    readonly channelId: string;
    readonly isDm: boolean;
  },
): Promise<string | undefined> {
  const [route] = await db
    .select({ chatThreadId: discordChatThreadRoutes.chatThreadId })
    .from(discordChatThreadRoutes)
    .where(
      and(
        eq(discordChatThreadRoutes.connectionId, args.connectionId),
        eq(discordChatThreadRoutes.userId, args.userId),
        eq(
          discordChatThreadRoutes.sessionKey,
          args.isDm ? INTEGRATION_DM_SESSION_KEY : args.channelId,
        ),
        eq(discordChatThreadRoutes.destinationChannelId, args.channelId),
      ),
    )
    .limit(1);
  return route?.chatThreadId;
}

interface CanonicalDiscordChatThreadRouteArgs extends DiscordChatThreadRouteKey {
  readonly orgId: string;
  readonly agentId: string;
  readonly currentTime: Date;
  readonly ingressId: string;
  readonly claimToken: string;
  readonly initialModel: DefaultModelFirstPin;
}

export const ensureCanonicalDiscordChatThreadRoute$ = command(
  async (
    { set },
    args: CanonicalDiscordChatThreadRouteArgs,
    signal: AbortSignal,
  ): Promise<DiscordChatThreadRouteBinding | undefined> => {
    const db = set(writeDb$);
    const defaults = await set(loadNewChatThreadDefaults$, args, signal);
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0149; new non-billing transactions are prohibited.
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
      signal.throwIfAborted();
      if (!claim) {
        return undefined;
      }
      let [route] = await tx
        .select()
        .from(discordChatThreadRoutes)
        .where(
          claim.routeId
            ? and(
                eq(discordChatThreadRoutes.id, claim.routeId),
                eq(discordChatThreadRoutes.connectionId, args.connectionId),
                eq(discordChatThreadRoutes.userId, args.userId),
              )
            : discordChatThreadRouteWhere(args),
        )
        .limit(1);
      signal.throwIfAborted();
      if (claim.routeId && !route) {
        throw new Error("Discord ingress has no assigned route");
      }
      if (!route) {
        const thread = integrationChatThreadValues(
          args,
          randomUUID(),
          defaults,
        );
        await tx.insert(chatThreads).values(thread);
        [route] = await tx
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
          .returning();
        signal.throwIfAborted();
        if (route) {
          await tx.execute(
            integrationThreadCreatedEventSql(args.orgId, thread),
          );
        } else {
          await tx.delete(chatThreads).where(eq(chatThreads.id, thread.id));
          [route] = await tx
            .select()
            .from(discordChatThreadRoutes)
            .where(discordChatThreadRouteWhere(args))
            .limit(1);
          if (!route) {
            throw new Error(
              "Failed to resolve Discord chat thread route after conflict",
            );
          }
        }
      }
      if (
        route.sessionKey === INTEGRATION_DM_SESSION_KEY &&
        (route.channelId !== args.channelId ||
          (route.destinationChannelId !== null &&
            route.destinationChannelId !== args.channelId))
      ) {
        const [updated] = await tx
          .update(discordChatThreadRoutes)
          .set({
            channelId: args.channelId,
            destinationChannelId: args.channelId,
          })
          .where(
            and(
              eq(discordChatThreadRoutes.id, route.id),
              discordChatThreadRouteWhere(route),
            ),
          )
          .returning();
        if (!updated) {
          throw new Error("Failed to update Discord DM route destination");
        }
        route = updated;
      }
      if (!claim.routeId) {
        await tx
          .update(discordChatIngress)
          .set({ routeId: route.id })
          .where(eq(discordChatIngress.id, args.ingressId));
      }
      signal.throwIfAborted();
      return route;
    });
  },
);

interface DiscordChatIngressAdmission {
  readonly id: string;
  readonly inserted: boolean;
  readonly status: DiscordChatIngressStatus;
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

export const admitCanonicalDiscordChatEvent$ = command(
  async (
    { set },
    args: {
      readonly applicationId: string;
      readonly connectionId: string;
      readonly messageId: string;
      readonly eventId: string;
      readonly payload: string;
      readonly currentTime: Date;
    },
    signal: AbortSignal,
  ): Promise<DiscordChatIngressAdmission | undefined> => {
    const db = set(writeDb$);
    const eventDigest = discordMessageReceiptDigest(
      args.applicationId,
      args.messageId,
    );
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0150; new non-billing transactions are prohibited.
    return await db.transaction(async (tx) => {
      // This identity-only digest survives connection/chat deletion. Raw payloads
      // still cascade, while a lost ACK cannot launch the same message again
      // after reconnecting or deleting its canonical chat.
      const [receipt] = await tx
        .insert(discordGatewayReceipts)
        .values({
          eventDigest,
          createdAt: args.currentTime,
        })
        .onConflictDoNothing()
        .returning({ eventDigest: discordGatewayReceipts.eventDigest });
      signal.throwIfAborted();
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
      signal.throwIfAborted();
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
      signal.throwIfAborted();
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
  },
);
