import { command, computed } from "ccstate";
import { integrationsSlackReadContract } from "@okouai/api-contracts/contracts/integrations-slack-read";
import { createErrorResponse } from "@okouai/api-contracts/contracts/errors";

import {
  isSlackApiClientError,
  isSlackConversationShared,
  listSharedSlackChannelsPage,
  readSlackHistoryPage,
  readSlackRepliesPage,
} from "../../lib/slack-client";
import { OFFICIAL_SLACK_APP_NAME } from "../../lib/slack-official-app";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import { slackUserInstallation } from "../services/slack-data.service";
import type { RouteEntry } from "../route-entry";
import { settle } from "../utils";

const readInstallation$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const installation = await get(
    slackUserInstallation({ orgId: auth.orgId, userId: auth.userId }),
  );
  if (installation.kind === "not-installed") {
    return createErrorResponse(
      "NOT_FOUND",
      "No Slack installation found for this organization. Install Okou from Settings > Slack first.",
    );
  }
  if (installation.kind === "not-connected") {
    return createErrorResponse(
      "NOT_FOUND",
      "Your Slack account is not connected to this organization. Connect it from Settings > Slack before reading conversations.",
    );
  }
  return installation;
});

function channelLink(workspaceId: string, channel: string): string {
  const url = new URL("https://slack.com/app_redirect");
  url.searchParams.set("team", workspaceId);
  url.searchParams.set("channel", channel);
  return url.toString();
}

function slackRateLimitResponse(retryAfterSeconds?: number) {
  return new Response(
    JSON.stringify({
      error: {
        code: "SLACK_RATE_LIMITED",
        message:
          retryAfterSeconds === undefined
            ? "Slack rate limit reached. Wait before requesting the next page."
            : `Slack rate limit reached. Retry after ${retryAfterSeconds} seconds.`,
        ...(retryAfterSeconds !== undefined && { retryAfterSeconds }),
      },
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        ...(retryAfterSeconds !== undefined && {
          "Retry-After": String(retryAfterSeconds),
        }),
      },
    },
  );
}

function slackReadError(error: unknown, channel?: { id: string; url: string }) {
  if (!isSlackApiClientError(error)) {
    throw error;
  }
  if (error.statusCode === 429 || error.code === "ratelimited") {
    return slackRateLimitResponse(error.retryAfterSeconds);
  }
  if (error.code === "missing_scope") {
    return {
      status: 403 as const,
      body: {
        error: {
          code: "SLACK_MISSING_SCOPE",
          message:
            "The organization's Slack bot lacks a required OAuth scope. Ask a workspace admin to update the Okou app installation. Inviting the bot to a channel does not add OAuth scopes.",
        },
      },
    };
  }
  if (error.code === "thread_not_found") {
    return {
      status: 404 as const,
      body: {
        error: {
          code: "SLACK_THREAD_NOT_FOUND",
          message:
            "Slack could not find a thread for this timestamp. Check --channel and use the parent message's ts for --thread; some message subtypes cannot have replies.",
        },
      },
    };
  }
  if (error.code === "invalid_ts" || error.code === "invalid_timestamp") {
    return createErrorResponse(
      "BAD_REQUEST",
      "Slack rejected the message timestamp. Use the parent message's ts for --thread.",
    );
  }
  if (error.code === "no_permission") {
    return createErrorResponse(
      "FORBIDDEN",
      "Slack denied the bot access to this conversation. Check the app's conversation membership and workspace access policies.",
    );
  }
  if (error.code === "method_not_supported_for_channel_type") {
    return createErrorResponse(
      "BAD_REQUEST",
      "Slack does not support this read operation for the selected conversation type.",
    );
  }
  if (
    channel &&
    (error.code === "not_in_channel" || error.code === "channel_not_found")
  ) {
    if (channel.id.startsWith("D")) {
      return createErrorResponse(
        "NOT_FOUND",
        "This DM does not exist or is not accessible to the bot. Only direct messages involving Okou can be read; use that conversation's D-prefixed ID.",
      );
    }
    const message =
      error.code === "not_in_channel"
        ? `${OFFICIAL_SLACK_APP_NAME} has not joined this channel.`
        : "This channel does not exist or is not accessible to the bot. Check the channel ID.";
    return {
      status: error.code === "not_in_channel" ? (403 as const) : (404 as const),
      body: {
        error: {
          code:
            error.code === "not_in_channel"
              ? "BOT_NOT_IN_CHANNEL"
              : "SLACK_CHANNEL_NOT_FOUND",
          message: `${message} Open ${channel.url} and select the channel name > Agents & apps to add ${OFFICIAL_SLACK_APP_NAME}, then retry. This link opens the channel; it does not invite the bot automatically.`,
          channelUrl: channel.url,
        },
      },
    };
  }
  if (
    error.code === "invalid_cursor" ||
    error.code === "invalid_ts_latest" ||
    error.code === "invalid_ts_oldest"
  ) {
    return createErrorResponse(
      "BAD_REQUEST",
      `Slack rejected the pagination or time range: ${error.code}. Check the timestamps or start again without --cursor.`,
    );
  }
  return {
    status: 502 as const,
    body: {
      error: { code: "SLACK_ERROR", message: `Slack API error: ${error.code}` },
    },
  };
}

const listChannels$ = command(async ({ get }, signal: AbortSignal) => {
  const query = get(queryOf(integrationsSlackReadContract.listChannels));
  const installation = await get(readInstallation$);
  signal.throwIfAborted();
  if ("status" in installation) {
    return installation;
  }

  const result = await settle(
    listSharedSlackChannelsPage(
      installation.botToken,
      installation.slackUserId,
      query,
      signal,
    ),
  );
  signal.throwIfAborted();
  if (!result.ok) {
    return slackReadError(result.error);
  }
  return {
    status: 200 as const,
    body: {
      channels: result.value.channels.map((channel) => {
        return {
          id: channel.id,
          name: channel.name,
          isPrivate: channel.is_private,
          isMember: true,
          channelUrl: channelLink(installation.workspaceId, channel.id),
        };
      }),
      nextCursor: result.value.response_metadata?.next_cursor || null,
    },
  };
});

const sharedInstallation$ = command(
  async ({ get }, channel: string, signal: AbortSignal) => {
    const installation = await get(readInstallation$);
    signal.throwIfAborted();
    if ("status" in installation) {
      return installation;
    }

    const shared = await settle(
      isSlackConversationShared(
        installation.botToken,
        installation.slackUserId,
        channel,
        signal,
      ),
    );
    signal.throwIfAborted();
    if (!shared.ok) {
      return slackReadError(shared.error);
    }
    if (!shared.value) {
      return createErrorResponse(
        "NOT_FOUND",
        "This Slack conversation does not exist or is not shared by your connected Slack account and Okou.",
      );
    }
    return installation;
  },
);

const history$ = command(async ({ get, set }, signal: AbortSignal) => {
  const query = get(queryOf(integrationsSlackReadContract.history));
  const installation = await set(sharedInstallation$, query.channel, signal);
  signal.throwIfAborted();
  if ("status" in installation) {
    return installation;
  }

  const channelUrl = channelLink(installation.workspaceId, query.channel);
  const result = await settle(
    readSlackHistoryPage(installation.botToken, query, signal),
  );
  signal.throwIfAborted();
  if (!result.ok) {
    return slackReadError(result.error, { id: query.channel, url: channelUrl });
  }
  const nextCursor = result.value.response_metadata?.next_cursor || null;
  return {
    status: 200 as const,
    body: {
      channel: query.channel,
      channelUrl,
      messages: result.value.messages,
      hasMore: result.value.has_more === true || nextCursor !== null,
      nextCursor,
    },
  };
});

const replies$ = command(async ({ get, set }, signal: AbortSignal) => {
  const query = get(queryOf(integrationsSlackReadContract.replies));
  const installation = await set(sharedInstallation$, query.channel, signal);
  signal.throwIfAborted();
  if ("status" in installation) {
    return installation;
  }

  const channelUrl = channelLink(installation.workspaceId, query.channel);
  const result = await settle(
    readSlackRepliesPage(installation.botToken, query, signal),
  );
  signal.throwIfAborted();
  if (!result.ok) {
    return slackReadError(result.error, { id: query.channel, url: channelUrl });
  }
  const nextCursor = result.value.response_metadata?.next_cursor || null;
  return {
    status: 200 as const,
    body: {
      channel: query.channel,
      channelUrl,
      thread: query.thread,
      messages: result.value.messages,
      hasMore: result.value.has_more === true || nextCursor !== null,
      nextCursor,
    },
  };
});

const slackReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "slack:read",
} as const;

export const integrationsSlackReadRoutes: readonly RouteEntry[] = [
  {
    route: integrationsSlackReadContract.listChannels,
    handler: authRoute(slackReadAuth, listChannels$),
  },
  {
    route: integrationsSlackReadContract.history,
    handler: authRoute(slackReadAuth, history$),
  },
  {
    route: integrationsSlackReadContract.replies,
    handler: authRoute(slackReadAuth, replies$),
  },
];
