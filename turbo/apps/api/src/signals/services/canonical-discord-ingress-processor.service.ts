import { chatEventCommandResultSchema } from "./chat-event-append.service";
import { parseRawRows } from "../../lib/db-raw-rows";
import { discordGatewayEnvelopeSchema } from "@okouai/api-contracts/contracts/discord-gateway";
import { MAX_DISCORD_FILE_SIZE_BYTES } from "@okouai/api-contracts/contracts/integrations-discord-files";
import { discordChatIngress } from "@okouai/db/schema/discord-chat-ingress";
import { discordChatThreadRoutes } from "@okouai/db/schema/discord-chat-thread-route";
import { discordOrgConnections } from "@okouai/db/schema/discord-org-connection";
import { discordOrgInstallations } from "@okouai/db/schema/discord-org-installation";
import { command } from "ccstate";
import { and, asc, eq, gte, inArray, lt, lte, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { resolveEnqueuedChatInputModel$ } from "./chat-input-model.service";
import { enqueueIntegrationChatInput$ } from "./integration-chat-queue.service";

import type { Tx } from "../../lib/db-types";
import {
  discordConversationContext,
  discordMessageContent,
} from "../../lib/discord-conversation-context";
import {
  discordMessageCreateSchema,
  isDiscordUserMessage,
  type DiscordMessageCreate,
} from "../../lib/discord-gateway-event";
import { DiscordIngressFailure } from "../../lib/discord-ingress-failure";
import { discordMessageUrl } from "../../lib/discord-message";
import { safeSqlStateCode } from "../../lib/pg-errors";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import {
  discordClient,
  type DiscordApiResult,
} from "../external/discord-client";
import {
  DiscordFileFetchError,
  fetchDiscordAttachment,
  type DiscordAttachmentDownload,
} from "../external/discord-file-fetcher";
import {
  publishChatThreadMessageCreatedSafely,
  publishThreadListChanged,
} from "../external/realtime";
import { safeJsonParse, settle } from "../utils";
import { waitUntil } from "../context/wait-until";
import {
  canonicalInputContentType,
  canonicalInputMessageFiles,
  createCanonicalInputFileCommands,
  InputFileImportError,
  type CanonicalInputAsset,
} from "./canonical-asset.service";
import { createChatEventSourcePart } from "./chat-event-annotation.service";
import {
  chatThreadLastMessageTouchSql,
  chatThreadLastMessageTouchSchema,
  chatThreadLastMessageSortSql,
} from "./chat-event-shared.service";
import { touchNativeChatThread$ } from "./native-chat-event-write.service";
import {
  type DiscordChatEventContext,
  chatEventInsertSql,
} from "./chat-event.service";
import { chatQueueWaitNotice } from "./chat-queue-wait-notice";
import {
  pickEnqueuedChatThread$,
  enqueuedChatQueueWaitReason$,
  notifyRunningChatRunOfPendingInput$,
  type ChatQueuePick,
} from "./chat-thread-queue-drain.service";
import { createUserMessageDocument } from "./chat-user-message.service";
import { requireDiscordConversationAccess$ } from "./discord-access.service";
import { getDiscordAppConfig } from "./discord-config";
import { readDiscordHistoryPage$ } from "./discord-context.service";
import {
  discordIngressSenderBindings,
  type DiscordVerifiedBinding,
} from "./discord-data.service";
import { prepareCanonicalDiscordIngressRoute$ } from "./discord-route-admission.service";
import { scheduleDiscordAdmissionTyping } from "./discord-run-typing.service";
import {
  sendDiscordChatReply$,
  sendDiscordIngressNotice$,
  type DiscordIngressNotice,
  type DiscordReplyRequest,
} from "./internal-discord-chat-run-callback.service";

const STALE_AFTER_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const SWEEP_LIMIT = 20;

/** Preserve a provider cooldown while the canonical importer records its failure. */
class DiscordAttachmentImportError extends InputFileImportError {
  constructor(
    message: string,
    statusCode: number,
    readonly retryAfterMs: number,
  ) {
    super("download-failed", message, statusCode);
    this.name = "DiscordAttachmentImportError";
  }
}

interface InputAttachmentDownload {
  readonly connectionId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly guildId: string;
  readonly discordUserId: string;
  readonly messageId: string;
  readonly attachment: DiscordAttachmentDownload;
}

const downloadInputAttachment$ = command(
  async (
    { set },
    args: InputAttachmentDownload,
    signal: AbortSignal,
  ): Promise<Response> => {
    const first = await settle(
      fetchDiscordAttachment(args.attachment, signal),
      signal,
    );
    if (first.ok) {
      return new Response(new Uint8Array(first.value.bytes).buffer, {
        headers: { "content-type": first.value.contentType },
      });
    }
    if (
      !(first.error instanceof DiscordFileFetchError) ||
      (first.error.statusCode !== 403 && first.error.statusCode !== 404)
    ) {
      throw first.error;
    }
    // A CDN capability can expire after lookup. Recheck binding, membership
    // and both parties' access before refreshing it once.
    const access = await set(
      requireDiscordConversationAccess$,
      {
        orgId: args.orgId,
        userId: args.userId,
        guildId: args.guildId,
        channelId: args.attachment.channelId,
        mode: "read",
      },
      signal,
    );
    if (access.kind === "denied") {
      throw new DiscordAttachmentImportError(
        "Discord file access could not be verified",
        access.response.status,
        (access.response.body.error.retryAfterSeconds ?? 0) * 1000,
      );
    }
    if (
      access.binding.connectionId !== args.connectionId ||
      access.binding.discordUserId !== args.discordUserId
    ) {
      throw new InputFileImportError(
        "download-failed",
        "Discord connection changed before file refresh",
        403,
      );
    }
    const refreshed = await discordClient.fetchDiscordMessage(
      {
        botToken: access.botToken,
        channelId: args.attachment.channelId,
        messageId: args.messageId,
      },
      signal,
    );
    if (refreshed.kind !== "ok") {
      throw new DiscordAttachmentImportError(
        "Discord attachment metadata is unavailable",
        refreshed.status,
        refreshed.kind === "discord-error" ? (refreshed.retryAfterMs ?? 0) : 0,
      );
    }
    if (
      refreshed.data.id !== args.messageId ||
      refreshed.data.channel_id !== args.attachment.channelId ||
      refreshed.data.author.id !== args.discordUserId
    ) {
      throw new InputFileImportError(
        "invalid-url",
        "Discord attachment message identity changed",
      );
    }
    const attachment = refreshed.data.attachments.find((file) => {
      return file.id === args.attachment.attachmentId;
    });
    if (!attachment) {
      throw new InputFileImportError(
        "download-failed",
        "Discord attachment is no longer available",
        404,
      );
    }
    if (
      attachment.filename !== args.attachment.filename ||
      attachment.size !== args.attachment.size
    ) {
      throw new InputFileImportError(
        "invalid-url",
        "Discord attachment identity changed during refresh",
      );
    }
    const file = await fetchDiscordAttachment(
      {
        channelId: args.attachment.channelId,
        attachmentId: attachment.id,
        filename: attachment.filename,
        size: attachment.size,
        contentType: attachment.content_type,
        url: attachment.url,
      },
      signal,
    );
    return new Response(new Uint8Array(file.bytes).buffer, {
      headers: { "content-type": file.contentType },
    });
  },
);

const downloadIngressAttachment$ = command(
  async (
    { set },
    args: {
      readonly attachment: InputAttachmentDownload;
      readonly onError: (error: unknown) => void;
    },
    signal: AbortSignal,
  ): Promise<Response> => {
    const downloaded = await settle(
      set(downloadInputAttachment$, args.attachment, signal),
      signal,
    );
    if (!downloaded.ok) {
      args.onError(downloaded.error);
      // The canonical importer must still persist the original failure.
      throw downloaded.error;
    }
    return downloaded.value;
  },
);

const { materializeCanonicalInputFile$: materializeDiscordInputFile$ } =
  createCanonicalInputFileCommands(downloadIngressAttachment$);

function discordResult<T>(result: DiscordApiResult<T>): T {
  if (result.kind === "ok") {
    return result.data;
  }
  if (result.kind === "unavailable") {
    throw new DiscordIngressFailure(
      "discord:unavailable",
      false,
      0,
      "Discord message is no longer accessible",
    );
  }
  throw new DiscordIngressFailure(
    `discord:${result.status}`,
    result.status === 429 || result.status >= 500,
    result.retryAfterMs ?? 0,
    "Discord could not provide the message context",
  );
}

function claimableIngress(currentTime: Date) {
  return or(
    and(
      eq(discordChatIngress.status, "pending"),
      lt(discordChatIngress.processingAttemptCount, MAX_ATTEMPTS),
    ),
    and(
      eq(discordChatIngress.status, "retryable"),
      lte(discordChatIngress.retryAt, currentTime),
      lt(discordChatIngress.processingAttemptCount, MAX_ATTEMPTS),
    ),
    and(
      eq(discordChatIngress.status, "processing"),
      lt(
        discordChatIngress.claimedAt,
        new Date(currentTime.getTime() - STALE_AFTER_MS),
      ),
      lt(discordChatIngress.processingAttemptCount, MAX_ATTEMPTS),
    ),
  );
}

async function claimIngress(db: Db, ingressId: string) {
  const currentTime = nowDate();
  const claimToken = randomUUID();
  const [claimed] = await db
    .update(discordChatIngress)
    .set({
      status: "processing",
      claimToken,
      claimedAt: currentTime,
      processingAttemptCount: sql`${discordChatIngress.processingAttemptCount} + 1`,
      retryAt: null,
      lastErrorClass: null,
      lastError: null,
      updatedAt: currentTime,
    })
    .where(
      and(eq(discordChatIngress.id, ingressId), claimableIngress(currentTime)),
    )
    .returning({ attemptCount: discordChatIngress.processingAttemptCount });
  return claimed ? { ...claimed, claimToken } : null;
}

async function loadClaimedIngress(
  db: Db,
  ingressId: string,
  claimToken: string,
) {
  const [row] = await db
    .select({
      id: discordChatIngress.id,
      connectionId: discordChatIngress.connectionId,
      messageId: discordChatIngress.messageId,
      payload: discordChatIngress.payload,
      createdAt: discordChatIngress.createdAt,
      routeId: discordChatThreadRoutes.id,
      chatThreadId: discordChatThreadRoutes.chatThreadId,
      userId: discordChatThreadRoutes.userId,
      destinationChannelId: discordChatThreadRoutes.destinationChannelId,
      sessionKey: discordChatThreadRoutes.sessionKey,
    })
    .from(discordChatIngress)
    .innerJoin(
      discordChatThreadRoutes,
      and(
        eq(discordChatIngress.routeId, discordChatThreadRoutes.id),
        eq(
          discordChatIngress.connectionId,
          discordChatThreadRoutes.connectionId,
        ),
      ),
    )
    .where(
      and(
        eq(discordChatIngress.id, ingressId),
        eq(discordChatIngress.status, "processing"),
        eq(discordChatIngress.claimToken, claimToken),
      ),
    )
    .limit(1);
  return row;
}

type ClaimedIngress = NonNullable<
  Awaited<ReturnType<typeof loadClaimedIngress>>
>;

const requireIngressAccess$ = command(
  async (
    { set },
    args: {
      readonly connectionId: string;
      readonly orgId: string;
      readonly userId: string;
      readonly guildId: string;
      readonly channelId: string;
      readonly mode: "view" | "read" | "write";
    },
    signal: AbortSignal,
  ) => {
    const access = await set(requireDiscordConversationAccess$, args, signal);
    if (access.kind === "denied") {
      throw new DiscordIngressFailure(
        `access:${access.response.status}`,
        access.response.status === 429 || access.response.status >= 500,
        (access.response.body.error.retryAfterSeconds ?? 0) * 1000,
        "Discord conversation is not currently accessible",
      );
    }
    if (access.binding.connectionId !== args.connectionId) {
      throw new DiscordIngressFailure(
        "binding:replaced",
        false,
        0,
        "Discord connection changed before message processing",
      );
    }
    return access;
  },
);

/**
 * Enqueue the accepted input in one transaction with the claim's
 * acknowledgement. The claim is fenced by a conditional update, so a
 * reclaimed ingress appends nothing; the Discord context row commits with the
 * input it belongs to.
 */
const enqueueMessage$ = command(
  async (
    { set },
    args: {
      readonly ingress: ClaimedIngress;
      readonly claimToken: string;
      readonly orgId: string;
      readonly context: DiscordChatEventContext;
      readonly assets: readonly CanonicalInputAsset[];
      readonly messagePermalink: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const values = {
      id: args.ingress.id,
      chatThreadId: args.ingress.chatThreadId,
      eventType: "input.prompt",
      modelSelection: await set(
        resolveEnqueuedChatInputModel$,
        {
          threadId: args.ingress.chatThreadId,
          orgId: args.orgId,
          userId: args.ingress.userId,
        },
        signal,
      ),
      runId: null,
      userMessage: createUserMessageDocument({
        text: args.context.messageText,
        files: canonicalInputMessageFiles(args.assets),
        nonContentPart: createChatEventSourcePart({
          kind: "discord",
          messagePermalink: args.messagePermalink,
        }),
      }),
      discordContext: args.context,
      createdAt: args.ingress.createdAt,
    } as const;
    const eventId = await set(
      enqueueIntegrationChatInput$,
      {
        orgId: args.orgId,
        input: values,
        ingress: {
          kind: "discord",
          ingressId: args.ingress.id,
          routeId: args.ingress.routeId,
          claimToken: args.claimToken,
        },
      },
      signal,
    );
    signal.throwIfAborted();
    if (eventId === null) {
      return false;
    }
    return true;
  },
);

type IngressAccess = Pick<
  DiscordVerifiedBinding,
  "connectionId" | "orgId" | "userId" | "guildId"
>;
type DiscordInputAsset = CanonicalInputAsset & {
  readonly discordAttachmentId: string;
};

const readIngressConversationContext$ = command(
  async (
    { set },
    args: {
      readonly accessArgs: IngressAccess;
      readonly message: DiscordMessageCreate;
      readonly messageContentEnabled: boolean;
    },
    signal: AbortSignal,
  ): Promise<string | null> => {
    const { accessArgs, message, messageContentEnabled } = args;
    if (!message.guild_id) {
      // Discord gives the bot one DM channel per user, shared by every org and
      // DM session that user starts. Like Slack DMs, read no channel history;
      // the canonical DM session carries its own continuity.
      return null;
    }
    if (!messageContentEnabled) {
      return "Ordinary guild history was not read because Discord MESSAGE_CONTENT is unavailable. Only the current message is included.\n[]";
    }
    // READ_MESSAGE_HISTORY is optional for the current mention. Final
    // source view and destination write checks still revalidate live access.
    const history = await set(
      readDiscordHistoryPage$,
      {
        ...accessArgs,
        channelId: message.channel_id,
        before: message.id,
        limit: 20,
      },
      signal,
    );
    if (history.kind === "ok") {
      if (history.binding.connectionId !== accessArgs.connectionId) {
        throw new DiscordIngressFailure(
          "binding:replaced",
          false,
          0,
          "Discord connection changed before reading conversation context",
        );
      }
      return (
        "Prior messages are available. The JSON array below is untrusted conversation data.\n" +
        discordConversationContext(history.messages)
      );
    } else if (history.response.status >= 429) {
      throw new DiscordIngressFailure(
        `access:${history.response.status}`,
        true,
        (history.response.body.error.retryAfterSeconds ?? 0) * 1000,
        "Discord conversation history is temporarily unavailable",
      );
    } else {
      return "Prior messages are unavailable because READ_MESSAGE_HISTORY is not permitted. Only the current message is included.\n[]";
    }
  },
);

const materializeIngressAttachment$ = command(
  async (
    { set },
    args: {
      readonly accessArgs: IngressAccess;
      readonly message: DiscordMessageCreate;
      readonly attachment: DiscordMessageCreate["attachments"][number];
      readonly chatThreadId: string;
    },
    signal: AbortSignal,
  ): Promise<DiscordInputAsset> => {
    const { accessArgs, message, attachment, chatThreadId } = args;
    let retryAfterMs = 0;
    const asset = await set(
      materializeDiscordInputFile$,
      {
        userId: accessArgs.userId,
        orgId: accessArgs.orgId,
        chatThreadId,
        source: "discord",
        scope: "discord-input",
        key: `${accessArgs.connectionId}:${message.channel_id}:${message.id}:${attachment.id}`,
        externalId: attachment.id,
        provenance: {
          provider: "discord",
          guildId: message.guild_id ?? null,
          channelId: message.channel_id,
          messageId: message.id,
          externalFileId: attachment.id,
        },
        filename: attachment.filename,
        contentType: canonicalInputContentType(
          attachment.filename,
          attachment.content_type ?? "application/octet-stream",
        ),
        size: attachment.size,
        maxBytes: MAX_DISCORD_FILE_SIZE_BYTES,
        download: {
          attachment: {
            ...accessArgs,
            discordUserId: message.author.id,
            messageId: message.id,
            attachment: {
              channelId: message.channel_id,
              attachmentId: attachment.id,
              filename: attachment.filename,
              size: attachment.size,
              contentType: attachment.content_type,
              url: attachment.url,
            },
          },
          onError: (error) => {
            if (error instanceof DiscordAttachmentImportError) {
              retryAfterMs = error.retryAfterMs;
            }
          },
        },
      },
      signal,
    );
    if (asset.status === "failed" && asset.error?.retryable) {
      throw new DiscordIngressFailure(
        `attachment:${asset.error.code}`,
        true,
        retryAfterMs,
        "Discord attachment import is temporarily unavailable",
      );
    }
    return { ...asset, discordAttachmentId: attachment.id };
  },
);

const materializeIngressAttachments$ = command(
  async (
    { set },
    args: {
      readonly accessArgs: IngressAccess;
      readonly message: DiscordMessageCreate;
      readonly botToken: string;
      readonly chatThreadId: string;
    },
    signal: AbortSignal,
  ): Promise<DiscordInputAsset[]> => {
    const { accessArgs, message, botToken, chatThreadId } = args;
    const assets: DiscordInputAsset[] = [];
    if (message.attachments.length > 0) {
      await set(
        requireIngressAccess$,
        { ...accessArgs, channelId: message.channel_id, mode: "read" },
        signal,
      );
      // Refresh expiring CDN URLs from the authorized message, never from callers.
      const currentMessage = discordResult(
        await discordClient.fetchDiscordMessage(
          {
            botToken,
            channelId: message.channel_id,
            messageId: message.id,
          },
          signal,
        ),
      );
      if (
        currentMessage.id !== message.id ||
        currentMessage.channel_id !== message.channel_id ||
        currentMessage.author.id !== message.author.id
      ) {
        throw new Error("Discord attachment message identity changed");
      }
      for (const originalAttachment of message.attachments) {
        const attachment = currentMessage.attachments.find((candidate) => {
          return candidate.id === originalAttachment.id;
        });
        if (!attachment) {
          throw new DiscordIngressFailure(
            "attachment:unavailable",
            false,
            0,
            "Discord attachment is no longer available",
          );
        }
        const asset = await set(
          materializeIngressAttachment$,
          { accessArgs, message, attachment, chatThreadId },
          signal,
        );
        assets.push(asset);
      }
    }
    return assets;
  },
);

function createIngressContext(args: {
  readonly binding: DiscordVerifiedBinding;
  readonly ingress: ClaimedIngress;
  readonly destinationChannelId: string;
  readonly message: DiscordMessageCreate;
  readonly channelType: number;
  readonly conversationContext: string | null;
  readonly assets: readonly DiscordInputAsset[];
}): DiscordChatEventContext {
  const {
    binding,
    ingress,
    destinationChannelId,
    message,
    channelType,
    conversationContext,
    assets,
  } = args;
  const messageContent = discordMessageContent(message);
  return {
    connectionId: binding.connectionId,
    routeId: ingress.routeId,
    guildId: message.guild_id ?? null,
    channelId: message.channel_id,
    destinationChannelId,
    messageId: message.id,
    botUserId: binding.botUserId,
    senderUserId: message.author.id,
    senderDisplayName: message.author.global_name ?? message.author.username,
    channelType: message.guild_id
      ? [10, 11, 12].includes(channelType)
        ? "thread"
        : "channel"
      : "dm",
    threadId: message.guild_id ? destinationChannelId : null,
    conversationContext,
    messageText: messageContent.displayContent,
    messageFiles: message.attachments,
    mentionDisplayNames: messageContent.mentionDisplayNames,
    messageAssets: assets.map((asset) => {
      return {
        assetId: asset.assetId,
        discordAttachmentId: asset.discordAttachmentId,
        filename: asset.filename,
        contentType: asset.contentType,
        status: asset.status,
      };
    }),
  };
}

function claimedIngressMessage(ingress: ClaimedIngress): DiscordMessageCreate {
  const envelope = discordGatewayEnvelopeSchema.parse(
    JSON.parse(ingress.payload) as unknown,
  );
  const message = discordMessageCreateSchema.parse(envelope.payload);
  if (
    envelope.eventType !== "MESSAGE_CREATE" ||
    message.id !== ingress.messageId ||
    !isDiscordUserMessage(message)
  ) {
    throw new Error(
      "Canonical Discord ingress message does not match its receipt",
    );
  }
  return message;
}

/** The sender's still-verified binding for the connection that claimed it. */
function requireClaimedIngressBinding(
  bindings: readonly DiscordVerifiedBinding[],
  ingress: ClaimedIngress,
): DiscordVerifiedBinding {
  const binding = bindings.find((candidate) => {
    return (
      candidate.connectionId === ingress.connectionId &&
      candidate.userId === ingress.userId
    );
  });
  if (!binding) {
    throw new DiscordIngressFailure(
      "binding:revoked",
      false,
      0,
      "Discord connection is no longer available",
    );
  }
  return binding;
}

const persistClaimedIngress$ = command(
  async (
    { get, set },
    args: { readonly ingressId: string; readonly claimToken: string },
    signal: AbortSignal,
  ) => {
    const routed = await set(
      prepareCanonicalDiscordIngressRoute$,
      args,
      signal,
    );
    if (!routed) {
      return null;
    }
    const db = set(writeDb$);
    const ingress = await loadClaimedIngress(
      db,
      args.ingressId,
      args.claimToken,
    );
    signal.throwIfAborted();
    if (!ingress) {
      return null;
    }
    if (!ingress.destinationChannelId) {
      throw new Error("Canonical Discord ingress destination is missing");
    }
    const message = claimedIngressMessage(ingress);
    const bindings = await get(discordIngressSenderBindings(message.author.id));
    signal.throwIfAborted();
    const binding = requireClaimedIngressBinding(bindings, ingress);
    const accessArgs = {
      connectionId: binding.connectionId,
      orgId: binding.orgId,
      userId: binding.userId,
      guildId: binding.guildId,
    };
    // Route admission verified both channels; this one check binds the
    // source channel's current access to this claim. The pick revalidates
    // the route before it launches.
    const source = await set(
      requireIngressAccess$,
      { ...accessArgs, channelId: message.channel_id, mode: "view" },
      signal,
    );
    const conversationContext = await set(
      readIngressConversationContext$,
      {
        accessArgs,
        message,
        messageContentEnabled: source.messageContentEnabled,
      },
      signal,
    );
    const assets = await set(
      materializeIngressAttachments$,
      {
        accessArgs,
        message,
        botToken: source.botToken,
        chatThreadId: ingress.chatThreadId,
      },
      signal,
    );
    const context = createIngressContext({
      binding,
      ingress,
      destinationChannelId: ingress.destinationChannelId,
      message,
      channelType: source.channel.type,
      conversationContext,
      assets,
    });
    const persisted = await set(
      enqueueMessage$,
      {
        ingress,
        claimToken: args.claimToken,
        orgId: binding.orgId,
        context,
        assets,
        messagePermalink: discordMessageUrl({
          guildId: message.guild_id,
          channelId: message.channel_id,
          messageId: message.id,
        }),
      },
      signal,
    );
    if (persisted) {
      scheduleDiscordAdmissionTyping({
        botToken: source.botToken,
        channelId: ingress.destinationChannelId,
      });
    }
    return persisted
      ? {
          orgId: binding.orgId,
          userId: binding.userId,
          chatThreadId: ingress.chatThreadId,
          connectionId: ingress.connectionId,
          destinationChannelId: ingress.destinationChannelId,
          createdAt: ingress.createdAt,
        }
      : null;
  },
);

function ingressFailure(error: unknown) {
  if (error instanceof DiscordIngressFailure) {
    return error;
  }
  if (
    error instanceof DiscordFileFetchError ||
    error instanceof InputFileImportError
  ) {
    return new DiscordIngressFailure(
      `attachment:${error.code}`,
      error.code === "download-failed" &&
        ((error instanceof DiscordFileFetchError &&
          error.statusCode === undefined) ||
          error.statusCode === 429 ||
          (error.statusCode ?? 0) >= 500),
      0,
      "Discord attachment import failed",
    );
  }
  const code =
    safeSqlStateCode(error) ??
    (error instanceof Error && "code" in error ? error.code : null);
  const retryable =
    typeof code === "string" &&
    (code.startsWith("08") ||
      [
        "40001",
        "40P01",
        "53300",
        "57P01",
        "57P03",
        "EAI_AGAIN",
        "ECONNREFUSED",
        "ECONNRESET",
        "EPIPE",
        "ETIMEDOUT",
        "UND_ERR_CONNECT_TIMEOUT",
      ].includes(code));
  return new DiscordIngressFailure(
    typeof code === "string" ? `system:${code}` : "unclassified",
    retryable ||
      (error instanceof TypeError && error.message === "fetch failed"),
    0,
    "Discord message processing failed",
  );
}

interface RecordedIngressFailure {
  readonly reply:
    | { readonly kind: "chat"; readonly request: DiscordReplyRequest }
    | { readonly kind: "notice"; readonly notice: DiscordIngressNotice }
    | null;
  readonly notification: {
    readonly userId: string;
    readonly orgId: string;
    readonly threadId: string;
  } | null;
}

const terminalIngressRouteSelection = Object.freeze({
  id: discordChatThreadRoutes.id,
  chatThreadId: discordChatThreadRoutes.chatThreadId,
  userId: discordChatThreadRoutes.userId,
  sessionKey: discordChatThreadRoutes.sessionKey,
  destinationChannelId: discordChatThreadRoutes.destinationChannelId,
  orgId: discordOrgInstallations.orgId,
  guildId: discordOrgConnections.guildId,
  discordUserId: discordOrgConnections.discordUserId,
});

async function recordTerminalIngressFailure(
  tx: Tx,
  args: {
    readonly ingressId: string;
    readonly currentTime: Date;
    readonly claimed: {
      readonly connectionId: string;
      readonly routeId: string | null;
      readonly payload: string;
    };
  },
  signal: AbortSignal,
): Promise<RecordedIngressFailure | null> {
  const { ingressId, currentTime, claimed } = args;
  const envelope = discordGatewayEnvelopeSchema.safeParse(
    safeJsonParse(claimed.payload),
  );
  if (!envelope.success || envelope.data.eventType !== "MESSAGE_CREATE") {
    return null;
  }
  const message = discordMessageCreateSchema.safeParse(envelope.data.payload);
  if (!message.success) {
    return null;
  }
  const content =
    "I couldn't process this Discord message. Please send it again.";
  if (claimed.routeId !== null) {
    const [route] = await tx
      .select(terminalIngressRouteSelection)
      .from(discordChatThreadRoutes)
      .innerJoin(
        discordOrgConnections,
        eq(discordOrgConnections.id, discordChatThreadRoutes.connectionId),
      )
      .innerJoin(
        discordOrgInstallations,
        eq(discordOrgInstallations.guildId, discordOrgConnections.guildId),
      )
      .where(
        and(
          eq(discordChatThreadRoutes.id, claimed.routeId),
          eq(discordChatThreadRoutes.connectionId, claimed.connectionId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (route?.destinationChannelId) {
      const inserted =
        parseRawRows(
          chatEventCommandResultSchema,
          await tx.execute(
            chatEventInsertSql(
              {
                id: ingressId,
                chatThreadId: route.chatThreadId,
                eventType: "output.error",
                runId: null,
                content,
                error: content,
                createdAt: currentTime,
              },
              "id",
            ),
          ),
        )[0] ?? null;
      signal.throwIfAborted();
      if (inserted) {
        const threadTouchRows = parseRawRows(
          chatThreadLastMessageTouchSchema,
          await tx.execute(
            chatThreadLastMessageTouchSql(route.chatThreadId, currentTime, {
              userId: route.userId,
              orgId: route.orgId,
            }),
          ),
        );
        const threadSortSql = chatThreadLastMessageSortSql(
          threadTouchRows,
          ingressId,
          { userId: route.userId, orgId: route.orgId },
        );
        if (threadSortSql) {
          await tx.execute(threadSortSql);
        }
        signal.throwIfAborted();
      }
      return {
        reply: inserted
          ? {
              kind: "chat",
              request: {
                chatEventId: ingressId,
                chatThreadId: route.chatThreadId,
                userId: route.userId,
                orgId: route.orgId,
                target: {
                  routeId: route.id,
                  connectionId: claimed.connectionId,
                  guildId: route.guildId,
                  discordUserId: route.discordUserId,
                  channelId: route.destinationChannelId,
                  messageId: message.data.id,
                  sessionKey: route.sessionKey,
                },
              },
            }
          : null,
        notification: {
          userId: route.userId,
          orgId: route.orgId,
          threadId: route.chatThreadId,
        },
      };
    }
  }
  return {
    reply: {
      kind: "notice",
      notice: {
        ingressId,
        connectionId: claimed.connectionId,
        channelId: message.data.channel_id,
        content,
      },
    },
    notification: null,
  };
}

function recordIngressFailure(
  db: Db,
  args: {
    readonly ingressId: string;
    readonly claimToken: string;
    readonly attemptCount: number;
    readonly failure: DiscordIngressFailure;
  },
  signal: AbortSignal,
): Promise<RecordedIngressFailure | null> {
  const retry = args.failure.retryable && args.attemptCount < MAX_ATTEMPTS;
  const currentTime = nowDate();
  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .select({
        connectionId: discordChatIngress.connectionId,
        routeId: discordChatIngress.routeId,
        payload: discordChatIngress.payload,
      })
      .from(discordChatIngress)
      .where(
        and(
          eq(discordChatIngress.id, args.ingressId),
          eq(discordChatIngress.status, "processing"),
          eq(discordChatIngress.claimToken, args.claimToken),
        ),
      )
      .for("update");
    signal.throwIfAborted();
    if (!claimed) {
      return null;
    }
    await tx
      .update(discordChatIngress)
      .set({
        status: retry ? "retryable" : "terminal",
        claimToken: null,
        claimedAt: null,
        retryAt: retry
          ? new Date(
              currentTime.getTime() +
                Math.max(
                  60_000 * 5 ** (args.attemptCount - 1),
                  args.failure.retryAfterMs,
                ),
            )
          : null,
        lastErrorClass:
          args.failure.retryable && !retry
            ? "attempts_exhausted"
            : args.failure.errorClass,
        lastError: args.failure.message,
        updatedAt: currentTime,
      })
      .where(eq(discordChatIngress.id, args.ingressId));
    signal.throwIfAborted();
    if (
      retry ||
      args.failure.errorClass.startsWith("binding:") ||
      args.failure.errorClass === "access:403" ||
      args.failure.errorClass === "access:404" ||
      args.failure.errorClass === "discord:unavailable" ||
      // A notice cannot be delivered without app configuration either.
      args.failure.errorClass === "discord:config_unavailable"
    ) {
      return null;
    }
    return recordTerminalIngressFailure(
      tx,
      { ingressId: args.ingressId, currentTime, claimed },
      signal,
    );
  });
}

const finishRecordedIngressFailure$ = command(
  async (
    { set },
    db: Db,
    recorded: RecordedIngressFailure | null,
    signal: AbortSignal,
  ): Promise<void> => {
    if (recorded?.notification) {
      await publishChatThreadMessageCreatedSafely(recorded.notification);
      signal.throwIfAborted();
      await publishThreadListChanged(recorded.notification);
      signal.throwIfAborted();
    }
    if (recorded?.reply?.kind === "chat") {
      await set(sendDiscordChatReply$, db, recorded.reply.request, signal);
    } else if (recorded?.reply?.kind === "notice") {
      await set(sendDiscordIngressNotice$, db, recorded.reply.notice, signal);
    }
  },
);

const sendIngressQueueWaitNotice$ = command(
  async (
    { set },
    target: Omit<DiscordIngressNotice, "content">,
    pick: ChatQueuePick,
    signal: AbortSignal,
  ): Promise<void> => {
    const content = chatQueueWaitNotice(pick.reason);
    if (content) {
      await set(
        sendDiscordIngressNotice$,
        set(writeDb$),
        { ...target, content },
        signal,
      );
    }
  },
);

export const processCanonicalDiscordIngress$ = command(
  async (
    { set },
    args: { readonly ingressId: string },
    signal: AbortSignal,
  ): Promise<boolean> => {
    // Missing app configuration is an outage: leave ingress unclaimed.
    if (!getDiscordAppConfig()) {
      return false;
    }
    const db = set(writeDb$);
    const claim = await claimIngress(db, args.ingressId);
    signal.throwIfAborted();
    if (!claim) {
      return false;
    }
    const result = await settle(
      set(
        persistClaimedIngress$,
        { ingressId: args.ingressId, claimToken: claim.claimToken },
        signal,
      ),
      signal,
    );
    signal.throwIfAborted();
    if (!result.ok) {
      const recorded = await recordIngressFailure(
        db,
        {
          ingressId: args.ingressId,
          ...claim,
          failure: ingressFailure(result.error),
        },
        signal,
      );
      await set(finishRecordedIngressFailure$, db, recorded, signal);
      throw result.error;
    }
    if (!result.value) {
      return false;
    }
    const ingress = result.value;
    waitUntil(
      (async () => {
        const picked = await settle(
          set(
            pickEnqueuedChatThread$,
            {
              orgId: ingress.orgId,
              chatThreadId: ingress.chatThreadId,
            },
            signal,
          ),
        );
        await set(
          touchNativeChatThread$,
          {
            chatThreadId: ingress.chatThreadId,
            createdAt: ingress.createdAt,
            eventId: args.ingressId,
            authorizedScope: { userId: ingress.userId, orgId: ingress.orgId },
          },
          signal,
        );
        await publishThreadListChanged({
          userId: ingress.userId,
          orgId: ingress.orgId,
        });
        await publishChatThreadMessageCreatedSafely({
          userId: ingress.userId,
          orgId: ingress.orgId,
          threadId: ingress.chatThreadId,
        });
        const noticed = await settle(
          (async () => {
            const pick = await set(
              enqueuedChatQueueWaitReason$,
              {
                orgId: ingress.orgId,
                chatThreadId: ingress.chatThreadId,
                eventId: args.ingressId,
              },
              signal,
            );
            await set(
              sendIngressQueueWaitNotice$,
              {
                ingressId: args.ingressId,
                connectionId: ingress.connectionId,
                channelId: ingress.destinationChannelId,
              },
              pick,
              signal,
            );
          })(),
        );
        if (!picked.ok && !noticed.ok) {
          throw new AggregateError(
            [picked.error, noticed.error],
            "Enqueued chat thread pick and wait notice failed",
          );
        }
        if (!picked.ok) {
          throw picked.error;
        }
        if (!noticed.ok) {
          throw noticed.error;
        }
      })(),
    );
    waitUntil(
      set(notifyRunningChatRunOfPendingInput$, ingress.chatThreadId, signal),
    );
    return true;
  },
);

const drainCanonicalDiscordIngress$ = command(
  async (
    { set },
    connectionIds: readonly string[] | undefined,
    signal: AbortSignal,
  ): Promise<number> => {
    // Without app configuration, neither exhaust attempts nor send notices.
    if (!getDiscordAppConfig()) {
      return 0;
    }
    const db = set(writeDb$);
    const currentTime = nowDate();
    const scope = connectionIds
      ? inArray(discordChatIngress.connectionId, [...connectionIds])
      : undefined;
    const exhausted = await db
      .select({
        id: discordChatIngress.id,
        claimToken: discordChatIngress.claimToken,
        attemptCount: discordChatIngress.processingAttemptCount,
      })
      .from(discordChatIngress)
      .where(
        and(
          scope,
          eq(discordChatIngress.status, "processing"),
          lt(
            discordChatIngress.claimedAt,
            new Date(currentTime.getTime() - STALE_AFTER_MS),
          ),
          gte(discordChatIngress.processingAttemptCount, MAX_ATTEMPTS),
        ),
      )
      .limit(SWEEP_LIMIT);
    signal.throwIfAborted();
    for (const row of exhausted) {
      if (row.claimToken === null) {
        throw new Error("Processing Discord ingress has no claim token");
      }
      const recorded = await recordIngressFailure(
        db,
        {
          ingressId: row.id,
          claimToken: row.claimToken,
          attemptCount: row.attemptCount,
          failure: new DiscordIngressFailure(
            "attempts_exhausted",
            true,
            0,
            "Discord message processing attempts exhausted",
          ),
        },
        signal,
      );
      await set(finishRecordedIngressFailure$, db, recorded, signal);
    }
    const rows = await db
      .select({ id: discordChatIngress.id })
      .from(discordChatIngress)
      .where(and(scope, claimableIngress(currentTime)))
      .orderBy(
        asc(discordChatIngress.updatedAt),
        asc(discordChatIngress.createdAt),
        asc(discordChatIngress.id),
      )
      .limit(SWEEP_LIMIT);
    signal.throwIfAborted();
    let processed = 0;
    for (const row of rows) {
      const result = await settle(
        set(processCanonicalDiscordIngress$, { ingressId: row.id }, signal),
        signal,
      );
      signal.throwIfAborted();
      if (result.ok && result.value) {
        processed++;
      }
    }
    return processed;
  },
);

export const drainStaleCanonicalDiscordIngress$ = command(
  ({ set }, signal: AbortSignal): Promise<number> => {
    return set(drainCanonicalDiscordIngress$, undefined, signal);
  },
);

/** The scoped test driver runs the same recovery path for its owned connections. */
export const drainCanonicalDiscordIngressForConnections$ = command(
  (
    { set },
    connectionIds: readonly string[],
    signal: AbortSignal,
  ): Promise<number> => {
    if (connectionIds.length === 0) {
      return Promise.resolve(0);
    }
    return set(drainCanonicalDiscordIngress$, connectionIds, signal);
  },
);
