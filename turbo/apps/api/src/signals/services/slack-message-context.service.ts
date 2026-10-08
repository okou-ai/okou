import { command, computed, type Computed } from "ccstate";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { slackOrgConnections } from "@okouai/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";
import { and, eq } from "drizzle-orm";

import { db$, type ReadonlyDb } from "../external/db";
import type { SlackClient } from "../external/slack-message-client";
import { tapError } from "../utils";
import { integrationMessageSendLabels } from "./integration-message-context.service";

async function resolveUserMention(
  db: ReadonlyDb,
  runId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ slackUserId: slackOrgConnections.slackUserId })
    .from(agentRuns)
    .innerJoin(
      slackOrgInstallations,
      eq(slackOrgInstallations.orgId, agentRuns.orgId),
    )
    .innerJoin(
      slackOrgConnections,
      and(
        eq(slackOrgConnections.userId, agentRuns.userId),
        eq(
          slackOrgConnections.slackWorkspaceId,
          slackOrgInstallations.slackWorkspaceId,
        ),
      ),
    )
    .where(eq(agentRuns.id, runId))
    .limit(1);
  return row ? `<@${row.slackUserId}>` : undefined;
}

/**
 * Resolve the attribution footer text appended to user-initiated Slack messages.
 *
 * Mirrors the Slack message route footer resolver. Each resolver swallows its
 * own errors so any single lookup failure degrades the footer gracefully.
 */
export function slackMessageSendFooterText(args: {
  readonly authRunId: string | undefined;
}): Computed<Promise<string | undefined>> {
  return computed(async (get): Promise<string | undefined> => {
    if (!args.authRunId) {
      return undefined;
    }
    const db = get(db$);
    const runId = args.authRunId;

    const noop = (): void => {};
    const [{ agentLabel, modelLabel }, userMention] = await Promise.all([
      get(integrationMessageSendLabels(args)),
      tapError(resolveUserMention(db, runId), noop),
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
  });
}

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
 * Resolve a Slack delivery target to a channel ID. A `channel` is used as-is;
 * a `user` (Slack user ID, or `"me"` for the caller's connected Slack user)
 * is resolved to the bot's DM channel with that user.
 */
export const resolveSlackTargetChannel$ = command(
  async (
    { get },
    args: {
      readonly client: SlackClient;
      readonly userId: string;
      readonly orgId: string;
      readonly channel?: string;
      readonly user?: string;
    },
    signal: AbortSignal,
  ) => {
    if (!args.user) {
      if (!args.channel) {
        throw new Error("Slack target requires a channel or user");
      }
      return { channelId: args.channel };
    }

    let slackUserId = args.user;
    if (slackUserId === "me") {
      const resolved = await get(
        resolveCurrentUserSlackId({ userId: args.userId, orgId: args.orgId }),
      );
      signal.throwIfAborted();
      if (!resolved) {
        return noUserConnection;
      }
      slackUserId = resolved;
    }

    const dm = await args.client.openDMChannel(slackUserId);
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
    return { channelId: dm.channelId };
  },
);
