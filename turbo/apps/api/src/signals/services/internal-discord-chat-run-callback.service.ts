import { command } from "ccstate";
import { and, countDistinct, eq, isNull, or } from "drizzle-orm";
import { agents } from "@okouai/db/schema/agent";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { getRunModelDisplayName } from "@okouai/core/model-display-name";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { discordChatIngress } from "@okouai/db/schema/discord-chat-ingress";
import { discordChatThreadRoutes } from "@okouai/db/schema/discord-chat-thread-route";
import { discordOrgConnections } from "@okouai/db/schema/discord-org-connection";
import { discordOauthStates } from "@okouai/db/schema/discord-oauth-state";
import { splitDiscordMessage } from "../../lib/discord-message";
import { logger } from "../../lib/log";
import { db$ } from "../external/db";
import { discordClient } from "../external/discord-client";
import { settle } from "../utils";
import { canonicalChatEventContent } from "./canonical-chat-event-read.service";
import { chatEventTypeIn } from "./chat-event-type.service";
import { requireDiscordOutputAccess$ } from "./discord-output-destination.service";
import type { DiscordDeliveryTarget } from "./discord-chat-callback-payload";
import {
  integrationAdmissionFailurePresentation,
  integrationAgentResponsePresentation,
} from "./integration-agent-response-presentation.service";
import {
  runModelSelectionColumns,
  runModelSelectionCondition,
  runModelSelectionFromRow,
} from "./run-model-selection.service";

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

const currentDestinationAccess$ = command(
  async ({ get, set }, destination: Destination, signal: AbortSignal) => {
    const db = get(db$);
    const [connection] = await db
      .select({
        discordUserId: discordOrgConnections.discordUserId,
      })
      .from(discordOrgConnections)
      .innerJoin(
        discordOauthStates,
        eq(discordOauthStates.id, discordOrgConnections.oauthGrantId),
      )
      .where(
        and(
          eq(discordOrgConnections.id, destination.connectionId),
          eq(discordOrgConnections.userId, destination.userId),
          eq(discordOauthStates.orgId, destination.orgId),
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
            or(
              eq(
                discordChatThreadRoutes.destinationChannelId,
                destination.channelId,
              ),
              and(
                isNull(discordChatThreadRoutes.destinationChannelId),
                eq(discordChatThreadRoutes.sessionKey, destination.channelId),
              ),
            ),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      if (!route) {
        return null;
      }
    }
    const access = await set(
      requireDiscordOutputAccess$,
      {
        orgId: destination.orgId,
        userId: destination.userId,
        channelId: destination.channelId,
        createThread: destination.routeId !== null,
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
  },
);

/**
 * Posts each part once, in order. A failed part ends the send: there is no
 * retry, replay or later redelivery, so a lost reply stays lost and is only
 * logged. The reply remains readable in the Okou chat.
 */
async function postParts(
  botToken: string,
  channelId: string,
  content: string,
  replyToMessageId: string | undefined,
  signal: AbortSignal,
): Promise<void> {
  let reference = replyToMessageId;
  for (const part of splitDiscordMessage(content)) {
    const result = await discordClient.createDiscordMessage(
      { botToken, channelId, content: part, replyToMessageId: reference },
      signal,
    );
    signal.throwIfAborted();
    reference = undefined;
    if (result.kind !== "ok") {
      throw new Error(
        result.kind === "unavailable"
          ? "Discord is unavailable"
          : `Discord message delivery failed: ${result.status}`,
      );
    }
  }
}

const readDiscordResponsePresentation$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly agentId: string;
      readonly runId: string | null;
      readonly replyToMention?: string;
    },
    signal: AbortSignal,
  ) => {
    const db = get(db$);
    const [agentLabel, runModel] = await Promise.all([
      (async () => {
        const [org] = await db
          .select({ defaultAgentId: orgMetadata.defaultAgentId })
          .from(orgMetadata)
          .where(eq(orgMetadata.orgId, args.orgId))
          .limit(1);
        signal.throwIfAborted();
        if (args.agentId === org?.defaultAgentId) {
          return undefined;
        }
        const [agent] = await db
          .select({ displayName: agents.displayName, name: agents.name })
          .from(agents)
          .where(eq(agents.id, args.agentId))
          .limit(1);
        signal.throwIfAborted();
        return agent?.displayName ?? agent?.name;
      })(),
      (async () => {
        if (args.runId === null) {
          return undefined;
        }
        const [row] = await db
          .select(runModelSelectionColumns())
          .from(agentRuns)
          .where(runModelSelectionCondition(args.runId))
          .limit(1);
        signal.throwIfAborted();
        return runModelSelectionFromRow(row);
      })(),
    ]);
    signal.throwIfAborted();
    // Admission failures have no run and omit the model label.
    if (args.runId === null) {
      return integrationAdmissionFailurePresentation({
        agentLabel,
        replyToMention: args.replyToMention,
      });
    }
    return integrationAgentResponsePresentation({
      agentLabel,
      modelLabel: runModel?.selectedModel
        ? getRunModelDisplayName(
            runModel.selectedModel,
            runModel.codexServiceTier,
          )
        : undefined,
      replyToMention: args.replyToMention,
    });
  },
);

/**
 * Fire and forget: call after the transaction that created the event commits,
 * and only from the attempt that created it, so replays never post twice.
 * Failures are logged and never propagate to the caller.
 */
export const sendDiscordChatReply$ = command(
  async (
    { get, set },
    request: DiscordReplyRequest,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = get(db$);
    const sent = await settle(
      (async (): Promise<void> => {
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
        const access = await set(
          currentDestinationAccess$,
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
        const binding = access.binding;
        const [mentionerCount] = await db
          .select({ count: countDistinct(discordChatThreadRoutes.userId) })
          .from(discordChatThreadRoutes)
          .innerJoin(
            discordOrgConnections,
            eq(discordOrgConnections.id, discordChatThreadRoutes.connectionId),
          )
          .where(
            and(
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
        const presentation = await set(
          readDiscordResponsePresentation$,
          {
            orgId: request.orgId,
            agentId: event.agentId,
            runId: event.runId,
            replyToMention:
              mentionerCount.count > 1
                ? `<@${binding.discordUserId}>`
                : undefined,
          },
          signal,
        );
        signal.throwIfAborted();
        const content = presentation.footerText
          ? `${event.content}\n\n_${presentation.footerText}_`
          : event.content;
        await postParts(
          access.botToken,
          request.target.channelId,
          content,
          undefined,
          signal,
        );
      })(),
      signal,
    );
    if (!sent.ok) {
      L.warn("Discord reply was not delivered", {
        chatEventId: request.chatEventId,
        error: sent.error,
      });
    }
  },
);

/**
 * Fire and forget: call once, after the ingress became terminal or its input
 * was enqueued. Failures are logged and never propagate to the caller.
 */
export const sendDiscordIngressNotice$ = command(
  async (
    { get, set },
    notice: DiscordIngressNotice,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = get(db$);
    const sent = await settle(
      (async (): Promise<void> => {
        const [owner] = await db
          .select({
            messageId: discordChatIngress.messageId,
            userId: discordOrgConnections.userId,
            orgId: discordOauthStates.orgId,
          })
          .from(discordChatIngress)
          .innerJoin(
            discordOrgConnections,
            eq(discordOrgConnections.id, discordChatIngress.connectionId),
          )
          .innerJoin(
            discordOauthStates,
            eq(discordOauthStates.id, discordOrgConnections.oauthGrantId),
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
        // A thread's starter has the thread ID but belongs to its parent.
        const replyToMessageId =
          notice.channelId === owner.messageId ? undefined : owner.messageId;
        const access = await set(
          currentDestinationAccess$,
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
        await postParts(
          access.botToken,
          notice.channelId,
          notice.content,
          replyToMessageId,
          signal,
        );
      })(),
      signal,
    );
    if (!sent.ok) {
      L.warn("Discord ingress notice was not delivered", {
        ingressId: notice.ingressId,
        error: sent.error,
      });
    }
  },
);
