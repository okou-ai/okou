import { accept, HttpStatusError } from "@okouai/connectors/accept";
import { array, boolean, object, string } from "zod";
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

  const [responseResult] = await Promise.allSettled([
    accept(
      fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        signal,
      }),
      [200],
    ),
  ]);
  if (responseResult.status === "rejected") {
    const error: unknown = responseResult.reason;
    if (!(error instanceof HttpStatusError)) {
      throw error;
    }
    const response = error.response;
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
  const response = responseResult.value;

  const data: unknown = await response.json();
  signal?.throwIfAborted();

  if (isSlackApiError(data)) {
    throw new SlackApiClientError(method, data.error);
  }

  return data as T;
}

const sharedChannelPageSchema = object({
  channels: array(
    object({
      id: string(),
      name: string(),
      is_private: boolean(),
      /**
       * Whether the calling token's own identity is in the conversation.
       *
       * Slack renders this against the authed identity rather than the `user`
       * the enumeration is for, and every conversation a `user` enumeration
       * lists is one that user belongs to — so an explicit `false` can only
       * describe the caller. It stays optional because Slack does not document
       * the field for every conversation shape, and an absent value must not be
       * read as either membership or its absence.
       */
      is_member: boolean().optional(),
    }),
  ),
  response_metadata: object({ next_cursor: string().optional() }).optional(),
});

const sharedConversationPageSchema = object({
  channels: array(object({ id: string() })),
  response_metadata: object({ next_cursor: string().optional() }).optional(),
});

const historyPageSchema = object({
  messages: array(slackHistoryMessageSchema),
  has_more: boolean().optional(),
  response_metadata: object({ next_cursor: string().optional() }).optional(),
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

/** Verify only the input conversation, including external Slack Connect users. */
export async function isSlackConversationSharedByMembers(
  args: {
    readonly token: string;
    readonly slackUserId: string;
    readonly botUserId: string;
    readonly channelId: string;
  },
  signal: AbortSignal,
): Promise<boolean> {
  let cursor: string | undefined;
  let userPresent = false;
  let botPresent = false;
  do {
    const page = object({
      members: array(string()),
      response_metadata: object({
        next_cursor: string().optional(),
      }).optional(),
    }).parse(
      await callSlackApi<unknown>(
        args.token,
        "conversations.members",
        {
          channel: args.channelId,
          limit: 200,
          cursor,
        },
        signal,
      ),
    );
    userPresent ||= page.members.includes(args.slackUserId);
    botPresent ||= page.members.includes(args.botUserId);
    if (userPresent && botPresent) {
      return true;
    }
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return false;
}

const slackPostingRestrictionSchema = object({
  type: array(string()).optional(),
  user: array(string()).optional(),
  subteam: array(string()).optional(),
});

async function hasSlackPostingRole(
  args: {
    token: string;
    slackUserId: string;
    roles: readonly string[];
    external: boolean;
    hostId?: string;
  },
  signal: AbortSignal,
): Promise<boolean> {
  const { roles } = args;
  if (roles.includes("ra")) {
    return true;
  }
  if (
    !roles.some((role) => {
      return ["admin", "owner", "regular"].includes(role);
    })
  ) {
    return false;
  }
  const current = object({
    user: object({
      id: string(),
      team_id: string().optional(),
      deleted: boolean().optional(),
      is_admin: boolean().optional(),
      is_owner: boolean().optional(),
      is_restricted: boolean().optional(),
      is_ultra_restricted: boolean().optional(),
    }),
  }).parse(
    await callSlackApi<unknown>(
      args.token,
      "users.info",
      { user: args.slackUserId },
      signal,
    ),
  );
  const user = current.user;
  if (user.id !== args.slackUserId || user.deleted === true) {
    return false;
  }
  // Slack Connect role grants apply only to the channel's home workspace.
  if (args.external && (!args.hostId || user.team_id !== args.hostId)) {
    return false;
  }
  return roles.some((role) => {
    if (role === "admin") {
      return user.is_admin === true;
    }
    if (role === "owner") {
      return user.is_owner === true;
    }
    return (
      role === "regular" &&
      user.is_restricted === false &&
      user.is_ultra_restricted === false
    );
  });
}

function isSlackDmRecipient(
  channel: { is_im?: boolean; is_mpim?: boolean; user?: string },
  recipientId: string | undefined,
): boolean {
  return (
    channel.is_im === true &&
    channel.is_mpim !== true &&
    Boolean(channel.user) &&
    (!recipientId || channel.user === recipientId)
  );
}

/** Check bot DM recipients and the caller's group posting privileges. */
export async function isSlackConversationWritable(
  args: {
    token: string;
    slackUserId: string;
    channelId: string;
    thread: boolean;
    recipientId?: string;
  },
  signal: AbortSignal,
): Promise<boolean> {
  const response = object({
    channel: object({
      id: string(),
      is_im: boolean().optional(),
      is_mpim: boolean().optional(),
      user: string().optional(),
      is_archived: boolean().optional(),
      is_read_only: boolean().optional(),
      is_ext_shared: boolean().optional(),
      conversation_host_id: string().optional(),
      properties: object({
        posting_restricted_to: slackPostingRestrictionSchema.optional(),
        threads_restricted_to: slackPostingRestrictionSchema.optional(),
      }).optional(),
    }),
  }).parse(
    await callSlackApi<unknown>(
      args.token,
      "conversations.info",
      { channel: args.channelId },
      signal,
    ),
  );
  const channel = response.channel;
  if (
    channel.id !== args.channelId ||
    channel.is_archived === true ||
    channel.is_read_only === true
  ) {
    return false;
  }
  if (args.channelId.startsWith("D")) {
    return isSlackDmRecipient(channel, args.recipientId);
  }
  if (args.recipientId) {
    return false;
  }
  const restriction = args.thread
    ? (channel.properties?.threads_restricted_to ??
      channel.properties?.posting_restricted_to)
    : channel.properties?.posting_restricted_to;
  if (!restriction) {
    return true;
  }
  if (restriction.user?.includes(args.slackUserId)) {
    return true;
  }
  if (
    await hasSlackPostingRole(
      {
        ...args,
        roles: restriction.type ?? [],
        external: channel.is_ext_shared === true,
        hostId: channel.conversation_host_id,
      },
      signal,
    )
  ) {
    return true;
  }
  for (const group of restriction.subteam ?? []) {
    const members = object({ users: array(string()) }).parse(
      await callSlackApi<unknown>(
        args.token,
        "usergroups.users.list",
        { usergroup: group },
        signal,
      ),
    );
    if (members.users.includes(args.slackUserId)) {
      return true;
    }
  }
  return false;
}

interface SlackFileInfo {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  url_private_download?: string;
  url_private?: string;
  channels?: string[];
  groups?: string[];
  ims?: string[];
}

/** A bot-visible file is readable only through a conversation shared with its caller. */
export async function isSlackFileShared(
  token: string,
  slackUserId: string,
  file: SlackFileInfo,
  signal: AbortSignal,
): Promise<boolean> {
  for (const channelId of new Set([
    ...(file.channels ?? []),
    ...(file.groups ?? []),
    ...(file.ims ?? []),
  ])) {
    if (
      await isSlackConversationShared(token, slackUserId, channelId, signal)
    ) {
      return true;
    }
  }
  return false;
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
