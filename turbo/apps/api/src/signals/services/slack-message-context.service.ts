import { command } from "ccstate";
import { slackOrgConnections } from "@okouai/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";
import { and, eq } from "drizzle-orm";

import { db$ } from "../external/db";
import { notFound } from "../../lib/error";
import type { SlackClient } from "../external/slack-message-client";
import { settle } from "../utils";
import {
  isSlackConversationShared,
  isSlackConversationSharedByMembers,
  isSlackConversationWritable,
} from "../../lib/slack-client";
import {
  integrationMessageSendLabels$,
  integrationMessageSendUserLabel$,
  integrationMessageSendFooterText,
} from "./integration-message-context.service";
import { slackAccountOwnerCondition } from "./slack-workspace-identity.service";
import { escapeSlackFooterLabel } from "../../lib/integration-message-footer";

/** The mention belongs to the authorized destination's workspace. */
export const resolveSlackMessageSendFooter$ = command(
  async (
    { get },
    workspaceId: string,
    signal: AbortSignal,
  ): Promise<string | undefined> => {
    const labels = await get(integrationMessageSendLabels$);
    signal.throwIfAborted();
    if (!labels.runOwner) {
      return undefined;
    }
    const rows = await get(db$)
      .select({ slackUserId: slackOrgConnections.slackUserId })
      .from(slackOrgConnections)
      .where(
        and(
          eq(slackOrgConnections.userId, labels.runOwner.userId),
          eq(slackOrgConnections.slackWorkspaceId, workspaceId),
        ),
      )
      .limit(2);
    signal.throwIfAborted();
    const sender = rows.length === 1 ? rows[0] : undefined;
    const userLabel = sender
      ? `<@${sender.slackUserId}>`
      : escapeSlackFooterLabel(await get(integrationMessageSendUserLabel$));
    signal.throwIfAborted();
    return integrationMessageSendFooterText({
      agentLabel: escapeSlackFooterLabel(labels.agentLabel),
      userLabel,
    });
  },
);

const noUserConnection = Object.freeze({
  status: 404 as const,
  body: Object.freeze({
    error: Object.freeze({
      message:
        "No Slack connection found for current user. Connect your Slack account first.",
      code: "NOT_FOUND",
    }),
  }),
});

interface SlackTargetChannelArgs {
  readonly client: SlackClient;
  readonly botToken: string;
  readonly userId: string;
  readonly orgId: string;
  readonly workspaceId: string;
  readonly channel?: string;
  readonly user?: string;
  readonly threadTs?: string;
}

type SlackTargetChannelResult =
  | { channelId: string }
  | { status: 400 | 404; body: { error: { code: string; message: string } } };

/**
 * Authorize shared group targets and outbound one-to-one bot DMs separately.
 */
export const resolveSlackTargetChannel$ = command(
  async (
    { get, set },
    args: SlackTargetChannelArgs,
    signal: AbortSignal,
  ): Promise<SlackTargetChannelResult> => {
    const db = get(db$);
    let connectedUser: string | null;
    const [row, additional] = await db
      .select({
        slackUserId: slackOrgConnections.slackUserId,
        workspaceId: slackOrgConnections.slackWorkspaceId,
      })
      .from(slackOrgConnections)
      .leftJoin(
        slackOrgInstallations,
        eq(
          slackOrgConnections.slackWorkspaceId,
          slackOrgInstallations.slackWorkspaceId,
        ),
      )
      .where(slackAccountOwnerCondition(args))
      .limit(2);
    signal.throwIfAborted();
    connectedUser =
      additional || row?.workspaceId !== args.workspaceId
        ? null
        : row.slackUserId;
    if (connectedUser) {
      const identity = await args.client.fetchUserIdentity(connectedUser);
      signal.throwIfAborted();
      if (
        !identity ||
        identity.deleted ||
        identity.isBot ||
        identity.teamId !== args.workspaceId
      ) {
        connectedUser = null;
      }
    }
    if (!connectedUser) {
      return noUserConnection;
    }
    const recipientId = args.user === "me" ? connectedUser : args.user;
    let channelId: string;
    if (!recipientId) {
      if (!args.channel) {
        throw new Error("Slack target requires a channel or user");
      }
      channelId = args.channel;
    } else {
      const dm = await args.client.openDMChannel(recipientId);
      signal.throwIfAborted();
      if (dm.kind === "slack_error") {
        return notFound(`Cannot open DM: ${dm.error}`);
      }
      channelId = dm.channelId;
    }
    return await set(
      authorizeSlackChannel$,
      {
        botToken: args.botToken,
        connectedUser,
        channelId,
        recipientId,
        threadTs: args.threadTs,
      },
      signal,
    );
  },
);

/** Source-channel permissions never inherit the ordinary outbound-DM exception. */
export const authorizeSlackChannel$ = command(
  async (
    _context,
    args: {
      readonly botToken: string;
      readonly connectedUser: string;
      readonly channelId: string;
      readonly recipientId?: string;
      readonly threadTs?: string;
      readonly sourceBotUserId?: string;
    },
    signal: AbortSignal,
  ): Promise<SlackTargetChannelResult> => {
    const { channelId, connectedUser, recipientId } = args;
    const shared = await settle(
      args.sourceBotUserId
        ? isSlackConversationSharedByMembers(
            {
              token: args.botToken,
              slackUserId: connectedUser,
              botUserId: args.sourceBotUserId,
              channelId,
            },
            signal,
          )
        : channelId.startsWith("D")
          ? Promise.resolve(true)
          : isSlackConversationShared(
              args.botToken,
              connectedUser,
              channelId,
              signal,
            ),
      signal,
    );
    if (!shared.ok) {
      return {
        status: 400 as const,
        body: {
          error: {
            code: "SLACK_ERROR",
            message:
              "Slack could not verify conversation access. Retry when Slack is available.",
          },
        },
      };
    }
    if (!shared.value) {
      return notFound(
        "This Slack conversation is not shared by your connected account and Okou.",
      );
    }
    const writable = await settle(
      isSlackConversationWritable(
        {
          token: args.botToken,
          slackUserId: connectedUser,
          channelId,
          recipientId,
          thread: args.threadTs !== undefined,
        },
        signal,
      ),
      signal,
    );
    if (!writable.ok) {
      return {
        status: 400,
        body: {
          error: {
            code: "SLACK_ERROR",
            message:
              "Slack could not verify posting permissions. Check the bot's conversation and user group read scopes.",
          },
        },
      };
    }
    if (!writable.value) {
      return notFound(
        "This Slack conversation is not writable by your connected account and Okou.",
      );
    }
    return { channelId };
  },
);
