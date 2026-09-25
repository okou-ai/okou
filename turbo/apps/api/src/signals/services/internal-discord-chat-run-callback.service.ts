import { createStore } from "ccstate";
import { and, countDistinct, eq } from "drizzle-orm";
import { agents } from "@okouai/db/schema/agent";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { discordChatIngress } from "@okouai/db/schema/discord-chat-ingress";
import { discordChatThreadRoutes } from "@okouai/db/schema/discord-chat-thread-route";
import { discordOrgConnections } from "@okouai/db/schema/discord-org-connection";
import { discordOrgInstallations } from "@okouai/db/schema/discord-org-installation";
import { splitDiscordMessage } from "../../lib/discord-message";
import { logger } from "../../lib/log";
import type { Db } from "../external/db";
import { discordClient } from "../external/discord-client";
import { settle } from "../utils";
import { canonicalChatEventContent } from "./canonical-chat-event-read.service";
import { chatEventTypeIn } from "./chat-event-type.service";
import { requireDiscordConversationAccess$ } from "./discord-access.service";
import type { DiscordDeliveryTarget } from "./discord-chat-callback-payload";
import {
  resolveIntegrationAdmissionFailurePresentation,
  resolveIntegrationAgentResponsePresentation,
} from "./integration-agent-response-presentation.service";

const L = logger("DiscordChatDelivery");

/** A canonical chat event to post to the Discord conversation it answers. */
export interface DiscordReplyRequest {
  readonly chatEventId: string;
  readonly chatThreadId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly target: DiscordDeliveryTarget;
}

/** A notice for Discord ingress that was rejected before a route existed. */
export interface DiscordIngressNotice {
  readonly ingressId: string;
  readonly connectionId: string;
  readonly channelId: string;
  readonly content: string;
}

interface Destination {
  readonly connectionId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly channelId: string;
  readonly routeId: string | null;
}

async function currentDestinationAccess(
  db: Db,
  destination: Destination,
  signal: AbortSignal,
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
        eq(discordOrgConnections.id, destination.connectionId),
        eq(discordOrgConnections.userId, destination.userId),
        eq(discordOrgInstallations.orgId, destination.orgId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!connection) {
    return null;
  }
  if (destination.routeId !== null) {
    const [route] = await db
      .select({ id: discordChatThreadRoutes.id })
      .from(discordChatThreadRoutes)
      .where(
        and(
          eq(discordChatThreadRoutes.id, destination.routeId),
          eq(discordChatThreadRoutes.connectionId, destination.connectionId),
          eq(discordChatThreadRoutes.userId, destination.userId),
          eq(
            discordChatThreadRoutes.destinationChannelId,
            destination.channelId,
          ),
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
      orgId: destination.orgId,
      userId: destination.userId,
      guildId: connection.guildId,
      channelId: destination.channelId,
      mode: "write",
    },
    signal,
  );
  signal.throwIfAborted();
  if (access.kind === "denied") {
    // Lost access suppresses the send; any other denial is a failed send.
    if (access.response.status === 403 || access.response.status === 404) {
      return null;
    }
    throw new Error(
      `Discord delivery access check failed: ${access.response.status}`,
    );
  }
  if (
    access.binding.connectionId !== destination.connectionId ||
    access.binding.discordUserId !== connection.discordUserId
  ) {
    return null;
  }
  return access;
}

async function replyContent(
  db: Db,
  request: DiscordReplyRequest,
  binding: { readonly discordUserId: string; readonly guildId: string },
  signal: AbortSignal,
): Promise<string> {
  const [event] = await db
    .select({
      content: canonicalChatEventContent(),
      runId: chatEvents.runId,
      agentId: agents.id,
    })
    .from(chatEvents)
    .innerJoin(chatThreads, eq(chatThreads.id, chatEvents.chatThreadId))
    .innerJoin(agents, eq(agents.id, chatThreads.agentId))
    .where(
      and(
        eq(chatEvents.id, request.chatEventId),
        eq(chatEvents.chatThreadId, request.chatThreadId),
        eq(chatThreads.userId, request.userId),
        eq(agents.orgId, request.orgId),
        chatEventTypeIn([
          "output.message",
          "output.error",
          "run.failed",
          "run.cancelled",
        ]),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!event?.content) {
    throw new Error("Discord reply canonical event is unavailable");
  }
  const [mentionerCount] = await db
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
          request.target.channelId,
        ),
      ),
    );
  signal.throwIfAborted();
  if (!mentionerCount) {
    throw new Error("Discord reply mentioner count is unavailable");
  }
  const presentationArgs = {
    db,
    orgId: request.orgId,
    agentId: event.agentId,
    replyToMention:
      mentionerCount.count > 1 ? `<@${binding.discordUserId}>` : undefined,
  };
  // An admission failure has no run, so its footer omits the model.
  const presentation =
    event.runId === null
      ? await resolveIntegrationAdmissionFailurePresentation(
          presentationArgs,
          signal,
        )
      : await resolveIntegrationAgentResponsePresentation(
          { ...presentationArgs, runId: event.runId },
          signal,
        );
  signal.throwIfAborted();
  return presentation.footerText
    ? `${event.content}\n\n_${presentation.footerText}_`
    : event.content;
}

/**
 * Posts each part once, in order. A failed part ends the send: there is no
 * retry, replay or later redelivery, so a lost reply stays lost and is only
 * logged. The reply remains readable in the Okou chat.
 */
async function postParts(
  botToken: string,
  channelId: string,
  content: string,
  signal: AbortSignal,
): Promise<void> {
  for (const part of splitDiscordMessage(content)) {
    const result = await discordClient.createDiscordMessage(
      { botToken, channelId, content: part },
      signal,
    );
    signal.throwIfAborted();
    if (result.kind !== "ok") {
      throw new Error(
        result.kind === "unavailable"
          ? "Discord is unavailable"
          : `Discord message delivery failed: ${result.status}`,
      );
    }
  }
}

async function sendReply(
  db: Db,
  request: DiscordReplyRequest,
  signal: AbortSignal,
): Promise<void> {
  const access = await currentDestinationAccess(
    db,
    {
      connectionId: request.target.connectionId,
      orgId: request.orgId,
      userId: request.userId,
      channelId: request.target.channelId,
      routeId: request.target.routeId,
    },
    signal,
  );
  if (!access) {
    return;
  }
  const content = await replyContent(db, request, access.binding, signal);
  await postParts(access.botToken, request.target.channelId, content, signal);
}

/**
 * Fire and forget: call after the transaction that created the event commits,
 * and only from the attempt that created it, so replays never post twice.
 * Failures are logged and never propagate to the caller.
 */
export async function sendDiscordChatReply(
  db: Db,
  request: DiscordReplyRequest,
  signal: AbortSignal,
): Promise<void> {
  const sent = await settle(sendReply(db, request, signal), signal);
  if (!sent.ok) {
    L.warn("Discord reply was not delivered", {
      chatEventId: request.chatEventId,
      error: sent.error,
    });
  }
}

async function sendIngressNotice(
  db: Db,
  notice: DiscordIngressNotice,
  signal: AbortSignal,
): Promise<void> {
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
        eq(discordChatIngress.id, notice.ingressId),
        eq(discordChatIngress.connectionId, notice.connectionId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!owner) {
    return;
  }
  const access = await currentDestinationAccess(
    db,
    {
      connectionId: notice.connectionId,
      orgId: owner.orgId,
      userId: owner.userId,
      channelId: notice.channelId,
      routeId: null,
    },
    signal,
  );
  if (!access) {
    return;
  }
  await postParts(access.botToken, notice.channelId, notice.content, signal);
}

/**
 * Fire and forget: call once, after the ingress became terminal. Failures are
 * logged and never propagate to the caller.
 */
export async function sendDiscordIngressNotice(
  db: Db,
  notice: DiscordIngressNotice,
  signal: AbortSignal,
): Promise<void> {
  const sent = await settle(sendIngressNotice(db, notice, signal), signal);
  if (!sent.ok) {
    L.warn("Discord ingress notice was not delivered", {
      ingressId: notice.ingressId,
      error: sent.error,
    });
  }
}
