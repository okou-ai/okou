import { createHash } from "node:crypto";
import { command, createStore } from "ccstate";
import {
  and,
  asc,
  countDistinct,
  eq,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import { agents } from "@okouai/db/schema/agent";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { discordChatDeliveries } from "@okouai/db/schema/discord-chat-delivery";
import { discordChatIngress } from "@okouai/db/schema/discord-chat-ingress";
import { discordChatThreadRoutes } from "@okouai/db/schema/discord-chat-thread-route";
import { discordOrgConnections } from "@okouai/db/schema/discord-org-connection";
import { discordOrgInstallations } from "@okouai/db/schema/discord-org-installation";
import type { DiscordChatDeliveryParts } from "@okouai/db/jsonb-contracts/discord-chat-delivery";
import { splitDiscordMessage } from "../../lib/discord-message";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import { discordClient } from "../external/discord-client";
import { settleIncludingAbort } from "../utils";
import { canonicalChatEventContent } from "./canonical-chat-event-read.service";
import { chatEventTypeIn } from "./chat-event-type.service";
import { requireDiscordConversationAccess$ } from "./discord-access.service";
import type { DiscordDeliveryTarget } from "./discord-chat-callback-payload";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { resolveIntegrationAgentResponsePresentation } from "./integration-agent-response-presentation.service";

const L = logger("DiscordChatDelivery");
const DELIVERY_LEASE_MS = 120_000;
const DELIVERY_DEADLINE_MS = 60_000;
const MAX_DELIVERY_ATTEMPTS = 5;
const deliveryPartsSchema = z.array(
  z.object({
    content: z.string(),
    nonce: z.string().min(1),
    attemptedAt: z.string().datetime().nullable(),
    messageId: z.string().nullable(),
  }),
);

type Delivery = typeof discordChatDeliveries.$inferSelect;

class DiscordDeliveryFailure extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "DiscordDeliveryFailure";
  }
}

function recoverableDeliveryCondition() {
  const currentTime = nowDate();
  return and(
    inArray(discordChatDeliveries.status, ["pending", "failed"]),
    lt(discordChatDeliveries.attempts, MAX_DELIVERY_ATTEMPTS),
    or(
      isNull(discordChatDeliveries.lastAttemptAt),
      lt(
        discordChatDeliveries.lastAttemptAt,
        new Date(currentTime.getTime() - DELIVERY_LEASE_MS),
      ),
    ),
    or(
      isNull(discordChatDeliveries.retryAt),
      lte(discordChatDeliveries.retryAt, currentTime),
    ),
  );
}

interface CanonicalDiscordDeliveryInput {
  readonly chatEventId: string;
  readonly chatThreadId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly target: DiscordDeliveryTarget;
}

/** Call in the transaction that inserts the canonical event. */
export async function enqueueDiscordChatDelivery(
  db: Pick<Db, "select" | "insert">,
  args: CanonicalDiscordDeliveryInput,
): Promise<string | null> {
  const [event] = await db
    .select({ content: canonicalChatEventContent() })
    .from(chatEvents)
    .innerJoin(chatThreads, eq(chatThreads.id, chatEvents.chatThreadId))
    .innerJoin(agents, eq(agents.id, chatThreads.agentId))
    .where(
      and(
        eq(chatEvents.id, args.chatEventId),
        eq(chatEvents.chatThreadId, args.chatThreadId),
        eq(chatThreads.userId, args.userId),
        eq(agents.orgId, args.orgId),
        chatEventTypeIn([
          "output.message",
          "output.error",
          "run.failed",
          "run.cancelled",
        ]),
      ),
    )
    .limit(1);
  if (!event?.content) {
    throw new Error("Discord delivery canonical event is unavailable");
  }
  const [route] = await db
    .select({ id: discordChatThreadRoutes.id })
    .from(discordChatThreadRoutes)
    .where(
      and(
        eq(discordChatThreadRoutes.id, args.target.routeId),
        eq(discordChatThreadRoutes.chatThreadId, args.chatThreadId),
        eq(discordChatThreadRoutes.connectionId, args.target.connectionId),
        eq(discordChatThreadRoutes.userId, args.userId),
        eq(discordChatThreadRoutes.sessionKey, args.target.sessionKey),
        eq(discordChatThreadRoutes.destinationChannelId, args.target.channelId),
      ),
    )
    .limit(1)
    .for("key share");
  if (!route) {
    return null;
  }
  const [inserted] = await db
    .insert(discordChatDeliveries)
    .values({
      connectionId: args.target.connectionId,
      chatEventId: args.chatEventId,
      chatThreadId: args.chatThreadId,
      routeId: route.id,
      orgId: args.orgId,
      userId: args.userId,
      channelId: args.target.channelId,
      content: event.content,
      createdAt: nowDate(),
    })
    .onConflictDoNothing({ target: discordChatDeliveries.chatEventId })
    .returning({ id: discordChatDeliveries.id });
  if (inserted) {
    return inserted.id;
  }
  const [existing] = await db
    .select({ id: discordChatDeliveries.id })
    .from(discordChatDeliveries)
    .where(
      and(
        eq(discordChatDeliveries.chatEventId, args.chatEventId),
        eq(discordChatDeliveries.connectionId, args.target.connectionId),
        eq(discordChatDeliveries.userId, args.userId),
        eq(discordChatDeliveries.orgId, args.orgId),
      ),
    )
    .limit(1);
  if (!existing) {
    throw new Error("Discord delivery receipt ownership mismatch");
  }
  return existing.id;
}

/** Call in the transaction that rejects ingress before a canonical route exists. */
export async function enqueueDiscordIngressFailure(
  db: Pick<Db, "select" | "insert">,
  args: {
    readonly ingressId: string;
    readonly connectionId: string;
    readonly channelId: string;
    readonly content: string;
  },
): Promise<string | null> {
  const [owner] = await db
    .select({
      userId: discordOrgConnections.userId,
      orgId: discordOrgInstallations.orgId,
    })
    .from(discordChatIngress)
    .innerJoin(
      discordOrgConnections,
      eq(discordOrgConnections.id, discordChatIngress.connectionId),
    )
    .innerJoin(
      discordOrgInstallations,
      eq(discordOrgInstallations.guildId, discordOrgConnections.guildId),
    )
    .where(
      and(
        eq(discordChatIngress.id, args.ingressId),
        eq(discordChatIngress.connectionId, args.connectionId),
      ),
    )
    .limit(1);
  if (!owner) {
    return null;
  }
  const [inserted] = await db
    .insert(discordChatDeliveries)
    .values({
      ingressId: args.ingressId,
      connectionId: args.connectionId,
      orgId: owner.orgId,
      userId: owner.userId,
      channelId: args.channelId,
      content: args.content,
      createdAt: nowDate(),
    })
    .onConflictDoNothing({ target: discordChatDeliveries.ingressId })
    .returning({ id: discordChatDeliveries.id });
  if (inserted) {
    return inserted.id;
  }
  const [existing] = await db
    .select({ id: discordChatDeliveries.id })
    .from(discordChatDeliveries)
    .where(
      and(
        eq(discordChatDeliveries.ingressId, args.ingressId),
        eq(discordChatDeliveries.connectionId, args.connectionId),
      ),
    )
    .limit(1);
  if (!existing) {
    throw new Error("Discord ingress delivery receipt disappeared");
  }
  return existing.id;
}

async function currentDeliveryAccess(
  db: Db,
  delivery: Delivery,
  signal: AbortSignal,
  mode: "read" | "write",
) {
  const [connection] = await db
    .select({
      guildId: discordOrgConnections.guildId,
      discordUserId: discordOrgConnections.discordUserId,
    })
    .from(discordOrgConnections)
    .innerJoin(
      discordOrgInstallations,
      eq(discordOrgInstallations.guildId, discordOrgConnections.guildId),
    )
    .where(
      and(
        eq(discordOrgConnections.id, delivery.connectionId),
        eq(discordOrgConnections.userId, delivery.userId),
        eq(discordOrgInstallations.orgId, delivery.orgId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!connection) {
    return null;
  }
  if (delivery.routeId !== null) {
    const [route] = await db
      .select({ id: discordChatThreadRoutes.id })
      .from(discordChatThreadRoutes)
      .where(
        and(
          eq(discordChatThreadRoutes.id, delivery.routeId),
          eq(discordChatThreadRoutes.connectionId, delivery.connectionId),
          eq(discordChatThreadRoutes.userId, delivery.userId),
          eq(discordChatThreadRoutes.destinationChannelId, delivery.channelId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!route) {
      return null;
    }
  }
  const access = await createStore().set(
    requireDiscordConversationAccess$,
    {
      orgId: delivery.orgId,
      userId: delivery.userId,
      guildId: connection.guildId,
      channelId: delivery.channelId,
      mode,
    },
    signal,
  );
  signal.throwIfAborted();
  if (access.kind === "denied") {
    if (access.response.status === 403 || access.response.status === 404) {
      return null;
    }
    const retryAfterSeconds = access.response.body.error.retryAfterSeconds;
    throw new DiscordDeliveryFailure(
      `Discord delivery access check failed: ${access.response.status}`,
      retryAfterSeconds === undefined ? undefined : retryAfterSeconds * 1000,
    );
  }
  if (
    access.binding.connectionId !== delivery.connectionId ||
    access.binding.discordUserId !== connection.discordUserId
  ) {
    return null;
  }
  return access;
}

async function renderDeliveryParts(
  db: Db,
  delivery: Delivery,
  binding: { readonly discordUserId: string; readonly guildId: string },
  signal: AbortSignal,
): Promise<DiscordChatDeliveryParts> {
  if (delivery.parts !== null) {
    return deliveryPartsSchema.parse(delivery.parts);
  }
  let content = delivery.content;
  if (delivery.chatEventId !== null && delivery.chatThreadId !== null) {
    const [event] = await db
      .select({ runId: chatEvents.runId, agentId: chatThreads.agentId })
      .from(chatEvents)
      .innerJoin(chatThreads, eq(chatThreads.id, chatEvents.chatThreadId))
      .where(
        and(
          eq(chatEvents.id, delivery.chatEventId),
          eq(chatThreads.id, delivery.chatThreadId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!event) {
      throw new Error("Discord delivery canonical event is unavailable");
    }
    if (event.runId !== null && event.agentId !== null) {
      const [featureContext, mentioners] = await Promise.all([
        loadUserFeatureSwitchContext(db, delivery.orgId, delivery.userId),
        db
          .select({ count: countDistinct(discordChatThreadRoutes.userId) })
          .from(discordChatThreadRoutes)
          .innerJoin(
            discordOrgConnections,
            eq(discordOrgConnections.id, discordChatThreadRoutes.connectionId),
          )
          .where(
            and(
              eq(discordOrgConnections.guildId, binding.guildId),
              eq(
                discordChatThreadRoutes.destinationChannelId,
                delivery.channelId,
              ),
            ),
          ),
      ]);
      signal.throwIfAborted();
      const presentation = await resolveIntegrationAgentResponsePresentation(
        {
          db,
          orgId: delivery.orgId,
          userId: delivery.userId,
          runId: event.runId,
          agentId: event.agentId,
          replyToMention:
            (mentioners[0]?.count ?? 0) > 1
              ? `<@${binding.discordUserId}>`
              : undefined,
          getFeatureOverrides: () => {
            return Promise.resolve(featureContext.overrides ?? {});
          },
        },
        signal,
      );
      signal.throwIfAborted();
      content = [
        content,
        presentation.logsUrl ? `[Audit](${presentation.logsUrl})` : undefined,
        presentation.footerText ? `_${presentation.footerText}_` : undefined,
      ]
        .filter((part) => {
          return part !== undefined;
        })
        .join("\n\n");
    }
  }
  return splitDiscordMessage(content).map((part, index) => {
    return {
      content: part,
      nonce: createHash("sha256")
        .update(`${delivery.id}:${index}`)
        .digest("hex")
        .slice(0, 25),
      attemptedAt: null,
      messageId: null,
    };
  });
}

async function persistParts(
  db: Db,
  delivery: Delivery,
  parts: DiscordChatDeliveryParts,
  retryAt?: Date,
): Promise<void> {
  const [owned] = await db
    .update(discordChatDeliveries)
    .set({ parts, ...(retryAt === undefined ? {} : { retryAt }) })
    .where(
      and(
        eq(discordChatDeliveries.id, delivery.id),
        eq(discordChatDeliveries.attempts, delivery.attempts),
        eq(discordChatDeliveries.status, "pending"),
      ),
    )
    .returning({ id: discordChatDeliveries.id });
  if (!owned) {
    throw new Error("Discord delivery claim was lost");
  }
}

async function reconcileAttemptedPart(
  db: Db,
  delivery: Delivery,
  nonce: string,
  signal: AbortSignal,
): Promise<string | null> {
  let before: string | undefined;
  for (let page = 0; page < 5; page += 1) {
    const access = await currentDeliveryAccess(db, delivery, signal, "read");
    if (!access) {
      return null;
    }
    const result = await discordClient.fetchDiscordMessages(
      {
        botToken: access.botToken,
        channelId: delivery.channelId,
        before,
        limit: 100,
      },
      signal,
    );
    signal.throwIfAborted();
    if (result.kind === "unavailable") {
      return null;
    }
    if (result.kind === "discord-error") {
      throw new DiscordDeliveryFailure(
        `Discord delivery reconciliation failed: ${result.status}`,
        result.retryAfterMs,
      );
    }
    const found = result.data.find((message) => {
      return (
        message.nonce === nonce &&
        message.channel_id === delivery.channelId &&
        message.author.id === access.binding.botUserId
      );
    });
    if (found) {
      return found.id;
    }
    if (result.data.length < 100) {
      break;
    }
    const lastMessage = result.data.at(-1);
    if (!lastMessage) {
      break;
    }
    before = lastMessage.id;
  }
  return null;
}

async function deliverClaimedDiscordChat(
  db: Db,
  delivery: Delivery,
  signal: AbortSignal,
): Promise<"delivered" | "suppressed"> {
  if (delivery.parts !== null) {
    const recorded = deliveryPartsSchema.parse(delivery.parts);
    if (
      recorded.length > 0 &&
      recorded.every((part) => {
        return part.messageId !== null;
      })
    ) {
      return "delivered";
    }
  }
  const initialAccess = await currentDeliveryAccess(
    db,
    delivery,
    signal,
    "write",
  );
  if (!initialAccess) {
    return "suppressed";
  }
  const parts = [
    ...(await renderDeliveryParts(db, delivery, initialAccess.binding, signal)),
  ];
  await persistParts(db, delivery, parts);
  for (const [index, part] of parts.entries()) {
    signal.throwIfAborted();
    if (part.messageId !== null) {
      continue;
    }
    if (part.attemptedAt !== null) {
      const messageId = await reconcileAttemptedPart(
        db,
        delivery,
        part.nonce,
        signal,
      );
      if (messageId === null) {
        throw new Error(
          "Discord delivery outcome is unconfirmed; the previous send was not replayed",
        );
      }
      parts[index] = { ...part, messageId };
      await persistParts(db, delivery, parts);
      continue;
    }
    const access = await currentDeliveryAccess(db, delivery, signal, "write");
    if (!access) {
      return "suppressed";
    }
    const attemptedPart = { ...part, attemptedAt: nowDate().toISOString() };
    parts[index] = attemptedPart;
    await persistParts(db, delivery, parts);
    signal.throwIfAborted();
    const result = await discordClient.createDiscordMessage(
      {
        botToken: access.botToken,
        channelId: delivery.channelId,
        content: part.content,
        nonce: part.nonce,
      },
      signal,
    );
    signal.throwIfAborted();
    if (result.kind === "unavailable") {
      return "suppressed";
    }
    if (result.kind === "discord-error") {
      // An explicit client rejection confirms that no message was accepted.
      // A timeout/network/5xx response stays uncertain and is reconciled by nonce.
      if (result.status >= 400 && result.status < 500) {
        parts[index] = { ...part, attemptedAt: null };
        await persistParts(
          db,
          delivery,
          parts,
          result.retryAfterMs === undefined
            ? undefined
            : new Date(nowDate().getTime() + result.retryAfterMs),
        );
      }
      throw new DiscordDeliveryFailure(
        `Discord message delivery failed: ${result.status}`,
        result.retryAfterMs,
      );
    }
    if (
      result.data.channel_id !== delivery.channelId ||
      result.data.author.id !== access.binding.botUserId ||
      (result.data.nonce !== undefined && result.data.nonce !== part.nonce)
    ) {
      throw new Error(
        "Discord delivery response does not match its destination",
      );
    }
    parts[index] = { ...attemptedPart, messageId: result.data.id };
    await persistParts(db, delivery, parts);
  }
  return "delivered";
}

export async function dispatchDiscordChatDeliveryOnce(
  db: Db,
  deliveryId: string,
  signal: AbortSignal,
): Promise<void> {
  const [delivery] = await db
    .update(discordChatDeliveries)
    .set({
      status: "pending",
      attempts: sql`${discordChatDeliveries.attempts} + 1`,
      lastAttemptAt: nowDate(),
      retryAt: null,
      lastError: null,
    })
    .where(
      and(
        eq(discordChatDeliveries.id, deliveryId),
        recoverableDeliveryCondition(),
      ),
    )
    .returning();
  if (!delivery) {
    return;
  }
  const outcome = await settleIncludingAbort(
    deliverClaimedDiscordChat(
      db,
      delivery,
      AbortSignal.any([signal, AbortSignal.timeout(DELIVERY_DEADLINE_MS)]),
    ),
  );
  await db
    .update(discordChatDeliveries)
    .set(
      outcome.ok
        ? {
            status: outcome.value,
            deliveredAt: outcome.value === "delivered" ? nowDate() : null,
            retryAt: null,
            lastError: null,
          }
        : {
            status: "failed",
            ...(outcome.error instanceof DiscordDeliveryFailure &&
            outcome.error.retryAfterMs !== undefined
              ? {
                  retryAt: new Date(
                    nowDate().getTime() + outcome.error.retryAfterMs,
                  ),
                }
              : {}),
            lastError:
              outcome.error instanceof Error
                ? outcome.error.message.slice(0, 4000)
                : "Discord delivery failed",
          },
    )
    .where(
      and(
        eq(discordChatDeliveries.id, delivery.id),
        eq(discordChatDeliveries.attempts, delivery.attempts),
      ),
    );
  if (!outcome.ok) {
    L.warn("Discord reply delivery failed", {
      deliveryId: delivery.id,
      error: outcome.error,
    });
  }
}

export async function deliverDiscordChatAdmissionFailure(
  args: CanonicalDiscordDeliveryInput & { readonly db: Db },
  signal: AbortSignal,
): Promise<void> {
  const deliveryId = await enqueueDiscordChatDelivery(args.db, args);
  signal.throwIfAborted();
  if (deliveryId !== null) {
    await dispatchDiscordChatDeliveryOnce(args.db, deliveryId, signal);
  }
}

async function drainPendingDiscordChatDeliveries(
  db: Db,
  connectionIds: readonly string[] | undefined,
  signal: AbortSignal,
): Promise<void> {
  const rows = await db
    .select({ id: discordChatDeliveries.id })
    .from(discordChatDeliveries)
    .where(
      and(
        connectionIds === undefined
          ? undefined
          : inArray(discordChatDeliveries.connectionId, connectionIds),
        recoverableDeliveryCondition(),
      ),
    )
    .orderBy(asc(discordChatDeliveries.createdAt))
    .limit(20);
  signal.throwIfAborted();
  for (const row of rows) {
    await dispatchDiscordChatDeliveryOnce(db, row.id, signal);
    signal.throwIfAborted();
  }
}

export const drainPendingDiscordChatDeliveries$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    await drainPendingDiscordChatDeliveries(set(writeDb$), undefined, signal);
  },
);

export const drainDiscordChatDeliveriesForConnections$ = command(
  async (
    { set },
    connectionIds: readonly string[],
    signal: AbortSignal,
  ): Promise<void> => {
    await drainPendingDiscordChatDeliveries(
      set(writeDb$),
      connectionIds,
      signal,
    );
  },
);
