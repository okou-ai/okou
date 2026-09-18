import { WebClient } from "@slack/web-api";

import type { ChatSlackMessageFile } from "@okouai/db/jsonb-contracts/chat-slack-context";
import type { SlackAnyBlock, SlackView } from "./slack-block-kit";
import { optionalEnv } from "../../lib/env";
import { settle } from "../utils";

type OpenDmResult =
  | { readonly kind: "ok"; readonly channelId: string }
  | { readonly kind: "slack_error"; readonly error: string };

type PostMessageResult =
  | {
      readonly kind: "ok";
      readonly ts: string | undefined;
      readonly channel: string | undefined;
    }
  | { readonly kind: "slack_error"; readonly error: string };

type GetMessagePermalinkResult =
  | { readonly kind: "ok"; readonly permalink: string }
  | { readonly kind: "slack_error"; readonly error: string };

type PostEphemeralResult =
  | { readonly kind: "ok"; readonly ts: string | undefined }
  | { readonly kind: "slack_error"; readonly error: string };

type GetUploadUrlResult =
  | {
      readonly kind: "ok";
      readonly uploadUrl: string;
      readonly fileId: string;
    }
  | { readonly kind: "slack_error"; readonly error: string };

type CompleteUploadResult =
  | { readonly kind: "ok" }
  | { readonly kind: "slack_error"; readonly error: string };

type GetFileInfoResult =
  | { readonly kind: "ok"; readonly file: SlackFileInfo | undefined }
  | { readonly kind: "slack_error"; readonly error: string };

export interface SlackFileInfo {
  readonly id?: string;
  readonly name?: string;
  readonly title?: string;
  readonly mimetype?: string;
  readonly filetype?: string;
  readonly size?: number;
  readonly permalink?: string;
}

export interface SlackUserInfo {
  readonly id: string;
  readonly name?: string;
  readonly email?: string;
  readonly timezone?: string;
}

export interface SlackUserInfoResolverStats {
  readonly requestedCount: number;
  readonly cacheHitCount: number;
  readonly missCount: number;
  readonly inFlightHitCount: number;
}

export interface SlackUserInfoResolver {
  readonly resolveMany: (
    userIds: readonly string[],
  ) => Promise<Map<string, SlackUserInfo>>;
  readonly stats: () => SlackUserInfoResolverStats;
}

export interface SlackRichTextStyle {
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly strike?: boolean;
  readonly code?: boolean;
}

export interface SlackRichTextElement {
  readonly type: string;
  readonly text?: string;
  readonly url?: string;
  readonly name?: string;
  readonly unicode?: string;
  readonly user_id?: string;
  readonly usergroup_id?: string;
  readonly channel_id?: string;
  readonly range?: string;
  readonly style?: SlackRichTextStyle | string;
  readonly indent?: number;
  readonly offset?: number;
  readonly language?: string;
  readonly elements?: readonly SlackRichTextElement[];
}

export interface SlackMessageBlock {
  readonly type: string;
  readonly elements?: readonly SlackRichTextElement[];
}

export interface SlackMessageAttachment {
  readonly image_url?: string;
  readonly image_width?: number;
  readonly image_height?: number;
  readonly thumb_url?: string;
  readonly title?: string;
  readonly fallback?: string;
}

export interface SlackConversationMessage {
  readonly user?: string;
  readonly text?: string;
  readonly ts?: string;
  readonly bot_id?: string;
  readonly files?: readonly ChatSlackMessageFile[];
  readonly attachments?: readonly SlackMessageAttachment[];
  readonly blocks?: readonly SlackMessageBlock[];
}

/**
 * The Slack operations this API performs, exposed as a handle so no caller
 * outside this module names an SDK type. See `tsconfig.gateways.json`.
 */
export interface SlackClient {
  readonly openDMChannel: (userId: string) => Promise<OpenDmResult>;
  readonly postMessage: (
    channel: string,
    text: string,
    options?: {
      readonly threadTs?: string;
      readonly blocks?: SlackAnyBlock[];
    },
  ) => Promise<PostMessageResult>;
  readonly getMessagePermalink: (
    channel: string,
    messageTs: string,
  ) => Promise<GetMessagePermalinkResult>;
  readonly setThreadStatus: (
    channel: string,
    threadTs: string,
    status: string,
  ) => Promise<void>;
  readonly publishAppHome: (userId: string, view: SlackView) => Promise<void>;
  readonly openView: (
    triggerId: string,
    view: SlackView,
  ) => Promise<{ readonly viewId: string | undefined }>;
  readonly postEphemeral: (options: {
    readonly channel: string;
    readonly user: string;
    readonly text: string;
    readonly threadTs?: string;
    readonly blocks?: SlackAnyBlock[];
  }) => Promise<PostEphemeralResult>;
  readonly getUploadUrlExternal: (args: {
    readonly filename: string;
    readonly length: number;
  }) => Promise<GetUploadUrlResult>;
  readonly completeUploadExternal: (args: {
    readonly fileId: string;
    readonly channel: string;
    readonly threadTs?: string;
    readonly title?: string;
    readonly initialComment?: string;
  }) => Promise<CompleteUploadResult>;
  readonly getFileInfo: (fileId: string) => Promise<GetFileInfoResult>;
  readonly createUserInfoResolver: () => SlackUserInfoResolver;
  readonly fetchUserInfoMap: (
    userIds: readonly string[],
    resolver?: SlackUserInfoResolver,
  ) => Promise<Map<string, SlackUserInfo>>;
  readonly fetchThreadMessages: (
    channel: string,
    threadTs: string,
  ) => Promise<readonly SlackConversationMessage[]>;
  readonly fetchChannelMessages: (
    channel: string,
    limit: number,
    latest?: string,
  ) => Promise<readonly SlackConversationMessage[]>;
}

function resolveSlackApiUrl(): string | undefined {
  return optionalEnv("SLACK_API_URL");
}

function buildWebClient(token: string): WebClient {
  const slackApiUrl = resolveSlackApiUrl();
  if (!slackApiUrl) {
    return new WebClient(token);
  }

  return new WebClient(token, {
    slackApiUrl,
    retryConfig: { retries: 1 },
    timeout: 5000,
  });
}

function isSlackPlatformError(
  err: unknown,
): err is Error & { data: { error: string } } {
  if (!(err instanceof Error) || !("data" in err)) {
    return false;
  }
  const { data } = err as { data: unknown };
  return (
    typeof data === "object" &&
    data !== null &&
    "error" in data &&
    typeof (data as { error: unknown }).error === "string"
  );
}

const SLACK_REQUEST_ERROR = "slack_webapi_request_error";
const SLACK_HTTP_ERROR = "slack_webapi_http_error";
const SLACK_RATE_LIMITED_ERROR = "slack_webapi_rate_limited_error";

function isRetryableSlackPlatformError(code: string): boolean {
  return (
    code === "internal_error" ||
    code === "ratelimited" ||
    code === "request_timeout" ||
    code === "service_unavailable"
  );
}

function isOptionalContextAuthorizationError(code: string): boolean {
  return (
    code === "channel_not_found" ||
    code === "missing_scope" ||
    code === "no_permission" ||
    code === "not_in_channel"
  );
}

class SlackMessageClientError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;

  constructor(
    error: unknown,
    args: {
      readonly code: string;
      readonly retryable: boolean;
      readonly retryAfterMs?: number;
    },
  ) {
    super(error instanceof Error ? error.message : "Slack request failed", {
      cause: error,
    });
    this.name = "SlackMessageClientError";
    this.code = args.code;
    this.retryable = args.retryable;
    this.retryAfterMs = args.retryAfterMs ?? null;
  }
}

interface SlackMessageClientFailure {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
}

export function slackMessageClientFailure(
  error: unknown,
): SlackMessageClientFailure | null {
  if (!(error instanceof SlackMessageClientError)) {
    return null;
  }
  return {
    code: error.code,
    retryable: error.retryable,
    retryAfterMs: error.retryAfterMs,
  };
}

export function isOptionalSlackConversationContextFailure(
  error: unknown,
): boolean {
  const failure = slackMessageClientFailure(error);
  return Boolean(failure && isOptionalContextAuthorizationError(failure.code));
}

function slackMessageClientError(error: unknown): SlackMessageClientError {
  if (error instanceof SlackMessageClientError) {
    return error;
  }
  if (isSlackPlatformError(error)) {
    return new SlackMessageClientError(error, {
      code: error.data.error,
      retryable: isRetryableSlackPlatformError(error.data.error),
    });
  }
  if (error instanceof Error && "code" in error) {
    const code = (error as { readonly code: unknown }).code;
    if (code === SLACK_RATE_LIMITED_ERROR) {
      const retryAfter =
        "retryAfter" in error && typeof error.retryAfter === "number"
          ? error.retryAfter
          : 0;
      return new SlackMessageClientError(error, {
        code,
        retryable: true,
        retryAfterMs: Math.max(0, retryAfter * 1000),
      });
    }
    if (code === SLACK_REQUEST_ERROR) {
      return new SlackMessageClientError(error, { code, retryable: true });
    }
    if (code === SLACK_HTTP_ERROR) {
      const statusCode =
        "statusCode" in error && typeof error.statusCode === "number"
          ? error.statusCode
          : 0;
      return new SlackMessageClientError(error, {
        code: `${code}:${statusCode || "unknown"}`,
        retryable: statusCode >= 500,
      });
    }
  }
  return new SlackMessageClientError(error, {
    code: "unknown_slack_error",
    retryable: false,
  });
}

async function readSlackConversation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const result = await settle(operation());
  if (!result.ok) {
    throw slackMessageClientError(result.error);
  }
  return result.value;
}

export function formatSenderBlock(info: SlackUserInfo): string {
  const parts = [`id: ${info.id}`];
  if (info.name) {
    parts.push(`name: ${info.name}`);
  }
  if (info.email) {
    parts.push(`email: ${info.email}`);
  }
  if (info.timezone) {
    parts.push(`timezone: ${info.timezone}`);
  }
  return `- SENDER: {${parts.join(", ")}}`;
}

async function fetchSlackUserInfo(
  client: WebClient,
  userId: string,
): Promise<SlackUserInfo | undefined> {
  const result = await client.users.info({ user: userId });
  if (!result.ok || !result.user) {
    return undefined;
  }

  const user = result.user;
  const name =
    user.profile?.display_name ||
    user.profile?.real_name ||
    user.real_name ||
    user.name;
  const email = user.profile?.email;
  const timezone = user.tz_label || user.tz;

  return {
    id: userId,
    name: name || undefined,
    email: email || undefined,
    timezone: timezone || undefined,
  };
}

function buildUserInfoResolver(client: WebClient): SlackUserInfoResolver {
  const cache = new Map<string, SlackUserInfo>();
  const inFlight = new Map<string, Promise<SlackUserInfo | undefined>>();
  let requestedCount = 0;
  let cacheHitCount = 0;
  let missCount = 0;
  let inFlightHitCount = 0;

  const startLookup = (userId: string): Promise<SlackUserInfo | undefined> => {
    const promise = (async () => {
      const info = await fetchSlackUserInfo(client, userId);
      if (info) {
        cache.set(userId, info);
      }
      return info;
    })().finally(() => {
      inFlight.delete(userId);
    });
    inFlight.set(userId, promise);
    return promise;
  };

  const resolveOne = async (
    userId: string,
  ): Promise<SlackUserInfo | undefined> => {
    const cached = cache.get(userId);
    if (cached) {
      cacheHitCount += 1;
      return cached;
    }

    const active = inFlight.get(userId);
    if (active) {
      inFlightHitCount += 1;
      return await active;
    }

    missCount += 1;
    return await startLookup(userId);
  };

  return {
    async resolveMany(userIds) {
      const map = new Map<string, SlackUserInfo>();
      const uniqueIds = [...new Set(userIds)];
      requestedCount += uniqueIds.length;
      const results = await Promise.allSettled(
        uniqueIds.map(async (id) => {
          const info = await resolveOne(id);
          return { id, info };
        }),
      );

      for (const result of results) {
        if (result.status === "fulfilled" && result.value.info) {
          map.set(result.value.id, result.value.info);
        }
      }

      return map;
    },
    stats() {
      return {
        requestedCount,
        cacheHitCount,
        missCount,
        inFlightHitCount,
      };
    },
  };
}

const THREAD_CONTEXT_MESSAGE_LIMIT = 100;

async function openDMChannel(
  web: WebClient,
  userId: string,
): Promise<OpenDmResult> {
  const result = await settle(web.conversations.open({ users: userId }));
  if (!result.ok) {
    if (isSlackPlatformError(result.error)) {
      return { kind: "slack_error", error: result.error.data.error };
    }
    return { kind: "slack_error", error: "open_dm_failed" };
  }
  if (!result.value.channel?.id) {
    return { kind: "slack_error", error: "missing_channel_id" };
  }
  return { kind: "ok", channelId: result.value.channel.id };
}

async function postMessage(
  web: WebClient,
  channel: string,
  text: string,
  options?: {
    readonly threadTs?: string;
    readonly blocks?: SlackAnyBlock[];
  },
): Promise<PostMessageResult> {
  const result = await settle(
    web.chat.postMessage({
      channel,
      text,
      thread_ts: options?.threadTs,
      blocks: options?.blocks,
    }),
  );
  if (!result.ok) {
    if (isSlackPlatformError(result.error)) {
      return { kind: "slack_error", error: result.error.data.error };
    }
    throw result.error;
  }
  return { kind: "ok", ts: result.value.ts, channel: result.value.channel };
}

async function getMessagePermalink(
  web: WebClient,
  channel: string,
  messageTs: string,
): Promise<GetMessagePermalinkResult> {
  const result = await settle(
    web.chat.getPermalink({ channel, message_ts: messageTs }),
  );
  if (!result.ok) {
    if (isSlackPlatformError(result.error)) {
      return { kind: "slack_error", error: result.error.data.error };
    }
    return { kind: "slack_error", error: "get_permalink_failed" };
  }
  if (!result.value.permalink) {
    return { kind: "slack_error", error: "missing_permalink" };
  }
  return { kind: "ok", permalink: result.value.permalink };
}

async function setThreadStatus(
  web: WebClient,
  channel: string,
  threadTs: string,
  status: string,
): Promise<void> {
  await web.assistant.threads.setStatus({
    channel_id: channel,
    thread_ts: threadTs,
    status,
  });
}

async function publishAppHome(
  web: WebClient,
  userId: string,
  view: SlackView,
): Promise<void> {
  await web.views.publish({ user_id: userId, view });
}

async function openView(
  web: WebClient,
  triggerId: string,
  view: SlackView,
): Promise<{ readonly viewId: string | undefined }> {
  const result = await web.views.open({ trigger_id: triggerId, view });
  return { viewId: result.view?.id };
}

async function postEphemeral(
  web: WebClient,
  options: {
    readonly channel: string;
    readonly user: string;
    readonly text: string;
    readonly threadTs?: string;
    readonly blocks?: SlackAnyBlock[];
  },
): Promise<PostEphemeralResult> {
  const result = await settle(
    web.chat.postEphemeral({
      channel: options.channel,
      user: options.user,
      text: options.text,
      thread_ts: options.threadTs,
      blocks: options.blocks,
    }),
  );
  if (!result.ok) {
    if (isSlackPlatformError(result.error)) {
      return { kind: "slack_error", error: result.error.data.error };
    }
    return { kind: "slack_error", error: "post_ephemeral_failed" };
  }
  return { kind: "ok", ts: result.value.message_ts };
}

async function getUploadUrlExternal(
  web: WebClient,
  args: { readonly filename: string; readonly length: number },
): Promise<GetUploadUrlResult> {
  const result = await settle(
    web.files.getUploadURLExternal({
      filename: args.filename,
      length: args.length,
    }),
  );
  if (!result.ok) {
    if (isSlackPlatformError(result.error)) {
      return { kind: "slack_error", error: result.error.data.error };
    }
    throw result.error;
  }
  if (!result.value.ok || !result.value.upload_url || !result.value.file_id) {
    return {
      kind: "slack_error",
      error: result.value.error ?? "unknown error",
    };
  }
  return {
    kind: "ok",
    uploadUrl: result.value.upload_url,
    fileId: result.value.file_id,
  };
}

async function completeUploadExternal(
  web: WebClient,
  args: {
    readonly fileId: string;
    readonly channel: string;
    readonly threadTs?: string;
    readonly title?: string;
    readonly initialComment?: string;
  },
): Promise<CompleteUploadResult> {
  const result = await settle(
    web.files.completeUploadExternal({
      files: [{ id: args.fileId, title: args.title }],
      channel_id: args.channel,
      thread_ts: args.threadTs,
      initial_comment: args.initialComment,
    }),
  );
  if (!result.ok) {
    if (isSlackPlatformError(result.error)) {
      return { kind: "slack_error", error: result.error.data.error };
    }
    throw result.error;
  }
  return { kind: "ok" };
}

async function getFileInfo(
  web: WebClient,
  fileId: string,
): Promise<GetFileInfoResult> {
  const result = await settle(web.files.info({ file: fileId }));
  if (!result.ok) {
    if (isSlackPlatformError(result.error)) {
      return { kind: "slack_error", error: result.error.data.error };
    }
    throw result.error;
  }
  const file = result.value.file as SlackFileInfo | undefined;
  return { kind: "ok", file };
}

async function fetchUserInfoMap(
  web: WebClient,
  userIds: readonly string[],
  resolver?: SlackUserInfoResolver,
): Promise<Map<string, SlackUserInfo>> {
  if (resolver) {
    return await resolver.resolveMany(userIds);
  }

  const map = new Map<string, SlackUserInfo>();
  const uniqueIds = [...new Set(userIds)];
  await Promise.allSettled(
    uniqueIds.map(async (id) => {
      const info = await fetchSlackUserInfo(web, id);
      if (info) {
        map.set(id, info);
      }
    }),
  );

  return map;
}

async function fetchThreadMessages(
  web: WebClient,
  channel: string,
  threadTs: string,
): Promise<readonly SlackConversationMessage[]> {
  const result = await readSlackConversation(async () => {
    return await web.conversations.replies({
      channel,
      ts: threadTs,
      limit: THREAD_CONTEXT_MESSAGE_LIMIT,
    });
  });
  return (result.messages ?? []) as SlackConversationMessage[];
}

async function fetchChannelMessages(
  web: WebClient,
  channel: string,
  limit: number,
  latest?: string,
): Promise<readonly SlackConversationMessage[]> {
  const result = await readSlackConversation(async () => {
    return await web.conversations.history({
      channel,
      limit,
      ...(latest && { latest }),
    });
  });
  return [...((result.messages ?? []) as SlackConversationMessage[])].reverse();
}

export function createSlackClient(token: string): SlackClient {
  const web = buildWebClient(token);

  return {
    openDMChannel: (userId) => {
      return openDMChannel(web, userId);
    },
    postMessage: (channel, text, options) => {
      return postMessage(web, channel, text, options);
    },
    getMessagePermalink: (channel, messageTs) => {
      return getMessagePermalink(web, channel, messageTs);
    },
    setThreadStatus: (channel, threadTs, status) => {
      return setThreadStatus(web, channel, threadTs, status);
    },
    publishAppHome: (userId, view) => {
      return publishAppHome(web, userId, view);
    },
    openView: (triggerId, view) => {
      return openView(web, triggerId, view);
    },
    postEphemeral: (options) => {
      return postEphemeral(web, options);
    },
    getUploadUrlExternal: (args) => {
      return getUploadUrlExternal(web, args);
    },
    completeUploadExternal: (args) => {
      return completeUploadExternal(web, args);
    },
    getFileInfo: (fileId) => {
      return getFileInfo(web, fileId);
    },
    createUserInfoResolver: () => {
      return buildUserInfoResolver(web);
    },
    fetchUserInfoMap: (userIds, resolver) => {
      return fetchUserInfoMap(web, userIds, resolver);
    },
    fetchThreadMessages: (channel, threadTs) => {
      return fetchThreadMessages(web, channel, threadTs);
    },
    fetchChannelMessages: (channel, limit, latest) => {
      return fetchChannelMessages(web, channel, limit, latest);
    },
  };
}
