import { command, computed, type Computed } from "ccstate";
import { slackOrgConnections } from "@okouai/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";
import { and, eq } from "drizzle-orm";

import { db$ } from "../external/db";
import type { SlackClient } from "../external/slack-message-client";
import { settle, tapError } from "../utils";
import {
  isSlackConversationShared,
  isSlackConversationWritable,
} from "../../lib/slack-client";
import { integrationMessageSendLabels$ } from "./integration-message-context.service";

const userMention$ = computed(async (get) => {
  const { runOwner } = await get(integrationMessageSendLabels$);
  if (!runOwner) {
    return undefined;
  }
  const [row] = await get(db$)
    .select({ slackUserId: slackOrgConnections.slackUserId })
    .from(slackOrgInstallations)
    .innerJoin(
      slackOrgConnections,
      and(
        eq(slackOrgConnections.userId, runOwner.userId),
        eq(
          slackOrgConnections.slackWorkspaceId,
          slackOrgInstallations.slackWorkspaceId,
        ),
      ),
    )
    .where(eq(slackOrgInstallations.orgId, runOwner.orgId))
    .limit(1);
  return row ? `<@${row.slackUserId}>` : undefined;
});

/**
 * Resolve the attribution footer text appended to user-initiated Slack messages.
 *
 * Mirrors the Slack message route footer resolver. Each resolver swallows its
 * own errors so any single lookup failure degrades the footer gracefully.
 */
export const slackMessageSendFooterText$ = computed(
  async (get): Promise<string | undefined> => {
    const noop = (): void => {};
    const [{ agentLabel, modelLabel }, userMention] = await Promise.all([
      get(integrationMessageSendLabels$),
      tapError(get(userMention$), noop),
    ]);

    const parts: string[] = [];
    if (agentLabel) {
      parts.push(`Sent via ${agentLabel}`);
    }
    if (userMention) {
      parts.push(`Triggered by ${userMention}`);
    }
    if (modelLabel) {
      parts.push(modelLabel);
    }

    return parts.length > 0 ? parts.join(" · ") : undefined;
  },
);

/**
 * Resolve the current user's Slack user ID via the org's Slack installation.
 * Used to expand `user: "me"` recipients in the send-message route.
 */
export function resolveCurrentUserSlackId(args: {
  readonly userId: string;
  readonly orgId: string;
}): Computed<Promise<string | null>> {
  return computed(async (get): Promise<string | null> => {
    const db = get(db$);
    const [row] = await db
      .select({ slackUserId: slackOrgConnections.slackUserId })
      .from(slackOrgConnections)
      .innerJoin(
        slackOrgInstallations,
        eq(
          slackOrgConnections.slackWorkspaceId,
          slackOrgInstallations.slackWorkspaceId,
        ),
      )
      .where(
        and(
          eq(slackOrgConnections.userId, args.userId),
          eq(slackOrgInstallations.orgId, args.orgId),
        ),
      )
      .limit(1);
    return row?.slackUserId ?? null;
  });
}

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

/**
 * Authorize shared group targets and outbound one-to-one bot DMs separately.
 */
export const resolveSlackTargetChannel$ = command(
  async (
    { get },
    args: {
      readonly client: SlackClient;
      readonly botToken: string;
      readonly userId: string;
      readonly orgId: string;
      readonly channel?: string;
      readonly user?: string;
      readonly threadTs?: string;
    },
    signal: AbortSignal,
  ): Promise<
    | { channelId: string }
    | { status: 400 | 404; body: { error: { code: string; message: string } } }
  > => {
    const connectedUser = await get(
      resolveCurrentUserSlackId({ userId: args.userId, orgId: args.orgId }),
    );
    signal.throwIfAborted();
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
        return {
          status: 404 as const,
          body: {
            error: {
              message: `Cannot open DM: ${dm.error}`,
              code: "NOT_FOUND",
            },
          },
        };
      }
      channelId = dm.channelId;
    }
    const shared = await settle(
      channelId.startsWith("D")
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
      return {
        status: 404 as const,
        body: {
          error: {
            code: "NOT_FOUND",
            message:
              "This Slack conversation is not shared by your connected account and Okou.",
          },
        },
      };
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
      return {
        status: 404,
        body: {
          error: {
            code: "NOT_FOUND",
            message:
              "This Slack conversation is not writable by your connected account and Okou.",
          },
        },
      };
    }
    return { channelId };
  },
);
