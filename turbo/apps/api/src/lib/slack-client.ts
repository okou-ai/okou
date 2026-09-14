import { z } from "zod";
import {
  slackHistoryMessageSchema,
  type SlackChannelListQuery,
  type SlackHistoryQuery,
  type SlackRepliesQuery,
} from "@okouai/api-contracts/contracts/integrations-slack-read";

interface SlackApiError {
  ok: false;
  error: string;
}

class SlackApiClientError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
    readonly statusCode?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(
      statusCode
        ? `Slack API error: ${statusCode} ${code}`
        : `Slack API error: ${code}`,
    );
    this.name = "SlackApiClientError";
  }
}

export function isSlackApiClientError(
  error: unknown,
): error is SlackApiClientError {
  return error instanceof SlackApiClientError;
}

function isSlackApiError(value: unknown): value is SlackApiError {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    (value as SlackApiError).ok === false
  );
}

async function callSlackApi<T>(
  token: string,
  method: string,
  params: Record<string, string | number | boolean | undefined>,
  signal?: AbortSignal,
): Promise<T> {
  const url = new URL(`https://slack.com/api/${method}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    signal,
  });

  if (!response.ok) {
    const retryAfter = response.headers.get("retry-after");
    const retryAfterSeconds =
      retryAfter === null ? undefined : Number(retryAfter);
    throw new SlackApiClientError(
      method,
      response.statusText || "http_error",
      response.status,
      retryAfterSeconds !== undefined &&
        Number.isInteger(retryAfterSeconds) &&
        retryAfterSeconds >= 0
        ? retryAfterSeconds
        : undefined,
    );
  }

  const data: unknown = await response.json();
  signal?.throwIfAborted();

  if (isSlackApiError(data)) {
    throw new SlackApiClientError(method, data.error);
  }

  return data as T;
}

const sharedChannelPageSchema = z.object({
  channels: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      is_private: z.boolean(),
    }),
  ),
  response_metadata: z
    .object({ next_cursor: z.string().optional() })
    .optional(),
});

const sharedConversationPageSchema = z.object({
  channels: z.array(z.object({ id: z.string() })),
  response_metadata: z
    .object({ next_cursor: z.string().optional() })
    .optional(),
});

const historyPageSchema = z.object({
  messages: z.array(slackHistoryMessageSchema),
  has_more: z.boolean().optional(),
  response_metadata: z
    .object({ next_cursor: z.string().optional() })
    .optional(),
});

// For bot tokens, Slack defines `user` as an intersection with the bot's own
// memberships, including private conversations shared by both identities.
export async function listSharedSlackChannelsPage(
  token: string,
  slackUserId: string,
  query: SlackChannelListQuery,
  signal?: AbortSignal,
) {
  return sharedChannelPageSchema.parse(
    await callSlackApi<unknown>(
      token,
      "users.conversations",
      {
        ...query,
        user: slackUserId,
        types: "public_channel,private_channel",
        exclude_archived: true,
      },
      signal,
    ),
  );
}

export async function readSlackHistoryPage(
  token: string,
  query: SlackHistoryQuery,
  signal: AbortSignal,
) {
  return historyPageSchema.parse(
    await callSlackApi<unknown>(token, "conversations.history", query, signal),
  );
}

export async function readSlackRepliesPage(
  token: string,
  query: SlackRepliesQuery,
  signal: AbortSignal,
) {
  const { thread, ...params } = query;
  return historyPageSchema.parse(
    await callSlackApi<unknown>(
      token,
      "conversations.replies",
      { ...params, ts: thread },
      signal,
    ),
  );
}

export async function listSharedSlackChannels(
  token: string,
  slackUserId: string,
  signal?: AbortSignal,
): Promise<{ id: string; name: string }[]> {
  const channels: { id: string; name: string }[] = [];
  let cursor: string | undefined;

  do {
    const result = await listSharedSlackChannelsPage(
      token,
      slackUserId,
      { limit: 200, cursor },
      signal,
    );

    channels.push(
      ...result.channels.map((channel) => {
        return { id: channel.id, name: channel.name };
      }),
    );
    cursor = result.response_metadata?.next_cursor || undefined;
  } while (cursor);

  channels.sort((a, b) => {
    return a.name.localeCompare(b.name);
  });

  return channels;
}

export async function isSlackConversationShared(
  token: string,
  slackUserId: string,
  conversationId: string,
  signal: AbortSignal,
): Promise<boolean> {
  const types = conversationId.startsWith("D")
    ? "im"
    : "public_channel,private_channel";
  let cursor: string | undefined;

  do {
    const result = sharedConversationPageSchema.parse(
      await callSlackApi<unknown>(
        token,
        "users.conversations",
        {
          user: slackUserId,
          types,
          limit: 200,
          cursor,
        },
        signal,
      ),
    );
    if (
      result.channels.some((channel) => {
        return channel.id === conversationId;
      })
    ) {
      return true;
    }
    cursor = result.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return false;
}

interface SlackFileInfo {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  url_private_download?: string;
  url_private?: string;
}

interface FilesInfoResponse {
  ok: true;
  file: SlackFileInfo;
}

export async function getFileInfo(
  token: string,
  fileId: string,
  signal?: AbortSignal,
): Promise<SlackFileInfo> {
  const result = await callSlackApi<FilesInfoResponse>(
    token,
    "files.info",
    {
      file: fileId,
    },
    signal,
  );
  return result.file;
}
