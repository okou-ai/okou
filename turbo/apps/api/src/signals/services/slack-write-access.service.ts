import { command } from "ccstate";
import { and, eq, isNull, notExists, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatSlackContext } from "@okouai/db/schema/chat-slack-context";
import { slackChatThreadRoutes } from "@okouai/db/schema/slack-chat-thread-route";
import { slackOrgConnections } from "@okouai/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";

import { notFound } from "../../lib/error";
import { db$ } from "../external/db";
import {
  createSlackClient,
  type SlackClient,
} from "../external/slack-message-client";
import { decryptPersistentSecretValue } from "./crypto.utils";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";
import {
  authorizeSlackChannel$,
  resolveSlackTargetChannel$,
} from "./slack-message-context.service";

interface SlackWriteTarget {
  readonly userId: string;
  readonly orgId: string;
  readonly runId?: string;
  readonly channel?: string;
  readonly user?: string;
  readonly threadTs?: string;
  /** A persisted upload destination pins its installation across retries. */
  readonly workspaceId?: string;
  readonly allowSource?: boolean;
}

const revokedInputs = alias(chatEvents, "slack_write_revoked_inputs");

const sourceChannel$ = command(
  async (
    { get },
    args: SlackWriteTarget & {
      readonly runId: string;
      readonly channel: string;
    },
    signal: AbortSignal,
  ) => {
    const db = get(db$);
    const [source] = await db
      .select({
        installation: slackOrgInstallations,
        slackUserId: slackOrgConnections.slackUserId,
        identityWorkspaceId: slackOrgConnections.slackWorkspaceId,
        senderUserId: chatSlackContext.senderUserId,
      })
      .from(agentRuns)
      .innerJoin(
        chatEvents,
        and(
          eq(chatEvents.runId, agentRuns.id),
          eq(chatEvents.chatThreadId, agentRuns.chatThreadId),
          eq(chatEvents.eventType, "input.prompt"),
          eq(chatEvents.contextType, "slack"),
        ),
      )
      .innerJoin(
        chatSlackContext,
        and(
          eq(chatSlackContext.id, chatEvents.contextId),
          eq(chatSlackContext.chatThreadId, chatEvents.chatThreadId),
        ),
      )
      .innerJoin(
        slackChatThreadRoutes,
        and(
          eq(slackChatThreadRoutes.chatThreadId, chatEvents.chatThreadId),
          eq(slackChatThreadRoutes.userId, args.userId),
          eq(slackChatThreadRoutes.channelId, chatSlackContext.channelId),
          or(
            eq(slackChatThreadRoutes.threadTs, chatSlackContext.routeThreadTs),
            and(
              isNull(chatSlackContext.routeThreadTs),
              eq(slackChatThreadRoutes.threadTs, chatSlackContext.threadTs),
            ),
          ),
        ),
      )
      .innerJoin(
        slackOrgConnections,
        and(
          eq(slackOrgConnections.id, slackChatThreadRoutes.connectionId),
          eq(slackOrgConnections.userId, args.userId),
        ),
      )
      .innerJoin(
        slackOrgInstallations,
        and(
          eq(
            slackOrgInstallations.slackWorkspaceId,
            chatSlackContext.workspaceId,
          ),
          eq(slackOrgInstallations.botUserId, chatSlackContext.botUserId),
        ),
      )
      .where(
        and(
          eq(agentRuns.id, args.runId),
          eq(agentRuns.userId, args.userId),
          eq(agentRuns.orgId, args.orgId),
          eq(chatSlackContext.channelId, args.channel),
          notExists(
            db
              .select({ id: revokedInputs.id })
              .from(revokedInputs)
              .where(eq(revokedInputs.revokesEventId, chatEvents.id)),
          ),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return source;
  },
);

const verifySourceSender$ = command(
  async (
    _context,
    source: {
      readonly client: SlackClient;
      readonly senderUserId: string | null;
      readonly slackUserId: string;
      readonly identityWorkspaceId: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (!source.senderUserId) {
      return false;
    }
    const identity = await source.client.fetchUserIdentity(source.senderUserId);
    signal.throwIfAborted();
    return Boolean(
      identity &&
      identity.id === source.slackUserId &&
      identity.teamId === source.identityWorkspaceId &&
      !identity.deleted &&
      !identity.isBot,
    );
  },
);

/** Choose an organization's bot or the current Run's exact input channel. */
export const resolveSlackWriteTarget$ = command(
  async ({ get, set }, args: SlackWriteTarget, signal: AbortSignal) => {
    const features = await set(
      loadUserFeatureSwitchContext$,
      args.orgId,
      args.userId,
      signal,
    );
    const source =
      args.allowSource !== false && args.runId && args.channel && !args.user
        ? await set(
            sourceChannel$,
            { ...args, runId: args.runId, channel: args.channel },
            signal,
          )
        : undefined;
    const [organizationInstallation] = source
      ? []
      : await get(db$)
          .select()
          .from(slackOrgInstallations)
          .where(eq(slackOrgInstallations.orgId, args.orgId))
          .limit(1);
    signal.throwIfAborted();
    const installation = source?.installation ?? organizationInstallation;
    if (
      !installation ||
      (args.workspaceId && args.workspaceId !== installation.slackWorkspaceId)
    ) {
      return notFound(
        "No Slack installation found for this authorized destination",
      );
    }
    const botToken = await decryptPersistentSecretValue(
      installation.encryptedBotToken,
      source
        ? installation.orgId
          ? { orgId: installation.orgId }
          : {}
        : features,
    );
    signal.throwIfAborted();
    const client = createSlackClient(botToken, { automaticRetries: false });
    if (
      source &&
      !(await set(verifySourceSender$, { ...source, client }, signal))
    ) {
      return notFound(
        "The Slack input sender no longer matches your connected account",
      );
    }
    const target =
      source && args.channel
        ? await set(
            authorizeSlackChannel$,
            {
              botToken,
              connectedUser: source.slackUserId,
              channelId: args.channel,
              threadTs: args.threadTs,
              sourceBotUserId: source.installation.botUserId,
              ...(args.channel.startsWith("D")
                ? { recipientId: source.slackUserId }
                : {}),
            },
            signal,
          )
        : await set(
            resolveSlackTargetChannel$,
            {
              ...args,
              client,
              botToken,
              workspaceId: installation.slackWorkspaceId,
            },
            signal,
          );
    if ("status" in target) {
      return target;
    }
    return {
      ...target,
      client,
      workspaceId: installation.slackWorkspaceId,
    };
  },
);
