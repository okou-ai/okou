import * as z from "zod";
import { discordIngressFailureSql } from "./discord-chat-ingress.service";
import { parseRawRows } from "../../lib/db-raw-rows";
import { discordGatewayEnvelopeSchema } from "@okouai/api-contracts/contracts/discord-gateway";
import { MAX_DISCORD_FILE_SIZE_BYTES } from "@okouai/api-contracts/contracts/integrations-discord-files";
import { discordChatIngress } from "@okouai/db/schema/discord-chat-ingress";
import { discordChatThreadRoutes } from "@okouai/db/schema/discord-chat-thread-route";
import { discordOrgConnections } from "@okouai/db/schema/discord-org-connection";
import { discordOauthStates } from "@okouai/db/schema/discord-oauth-state";
import { command } from "ccstate";
import { and, asc, eq, gte, lt, lte, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { resolveEnqueuedChatInputModel$ } from "./chat-input-model.service";
import { enqueueIntegrationChatInput$ } from "./integration-chat-queue.service";

import {
  CHANNEL_CONTEXT_MESSAGE_LIMIT,
  THREAD_CONTEXT_MESSAGE_LIMIT,
} from "../../lib/integration-conversation-context";
import {
  discordConversationContext,
  discordMessageContent,
} from "../../lib/discord-conversation-context";
import {
  discordMessageCreateSchema,
  type DiscordMessageCreate,
} from "../../lib/discord-gateway-event";
import { DiscordIngressFailure } from "../../lib/discord-ingress-failure";
import { discordMessageUrl } from "../../lib/discord-message";
import { safeSqlStateCode } from "../../lib/pg-errors";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import {
  discordClient,
  type DiscordApiResult,
  type DiscordChannel,
  type DiscordMessage,
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
import { safeJsonParse, settle, settleIncludingAbort } from "../utils";
import { waitUntil } from "../context/wait-until";
import {
  canonicalInputContentType,
  canonicalInputMessageFiles,
  canonicalInputImportSignals,
  canonicalInputImportOutcome,
  prepareCanonicalInputFile$,
  storeCanonicalInputFile$,
  completeCanonicalInputFile$,
  type CanonicalInputImportPlan,
  type CanonicalInputImportReady,
  InputFileImportError,
  type CanonicalInputAsset,
} from "./canonical-asset.service";
import { createChatEventSourcePart } from "./chat-event-annotation.service";
import { touchNativeChatThread$ } from "./native-chat-event-write.service";
import {
  type DiscordChatEventContext,
  prepareChatEvent,
} from "./chat-event.service";
import { chatQueueWaitNotice } from "./chat-queue-wait-notice";
import {
  pickEnqueuedChatThread$,
  enqueuedChatQueueWaitReason$,
  notifyRunningChatRunOfPendingInput$,
  type ChatQueuePick,
} from "./chat-thread-queue-drain.service";
import { createUserMessageDocument } from "./chat-user-message.service";
import {
  requireDiscordConversationAccess$,
  type DiscordConversationAccess,
} from "./discord-access.service";
import { getDiscordAppConfig } from "./discord-config";
import {
  readDiscordMessageWithAccess,
  readDiscordHistoryWithAccess,
} from "./discord-context.service";
import type { DiscordFailureResponse } from "./discord-api-response";
import type { DiscordVerifiedBinding } from "./discord-data.service";
import {
  prepareCanonicalDiscordIngressRoute$,
  type PreparedDiscordIngress,
} from "./discord-route-admission.service";
import { authorizeDiscordSnapshot } from "./discord-provider-access";
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
  readonly guildId?: string;
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

const importDiscordInputFile$ = command(
  async (
    { set },
    plan: CanonicalInputImportPlan,
    attachment: InputAttachmentDownload,
    signal: AbortSignal,
  ): Promise<CanonicalInputImportReady> => {
    const response = await set(downloadInputAttachment$, attachment, signal);
    signal.throwIfAborted();
    return await set(storeCanonicalInputFile$, plan, response, signal);
  },
);

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

function discordIngressClaimWritePlan(ingressId: string) {
  const currentTime = nowDate();
  const claimToken = randomUUID();
  return {
    claimToken,
    values: {
      status: "processing" as const,
      claimToken,
      claimedAt: currentTime,
      processingAttemptCount: sql`${discordChatIngress.processingAttemptCount} + 1`,
      retryAt: null,
      lastErrorClass: null,
      lastError: null,
      updatedAt: currentTime,
    },
    condition: and(
      eq(discordChatIngress.id, ingressId),
      claimableIngress(currentTime),
    ),
  };
}

type ClaimedIngress = Pick<
  typeof discordChatIngress.$inferSelect,
  "id" | "connectionId" | "messageId" | "payload" | "createdAt"
> &
  Pick<
    typeof discordChatThreadRoutes.$inferSelect,
    "chatThreadId" | "userId" | "destinationChannelId" | "sessionKey"
  > & {
    routeId: (typeof discordChatThreadRoutes.$inferSelect)["id"];
  };

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
    const enqueuedModel = await set(
      resolveEnqueuedChatInputModel$,
      {
        threadId: args.ingress.chatThreadId,
        orgId: args.orgId,
        userId: args.ingress.userId,
      },
      signal,
    );
    const values = {
      id: args.ingress.id,
      chatThreadId: args.ingress.chatThreadId,
      eventType: "input.prompt",
      modelSelection: enqueuedModel.modelSelection,
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
        threadModelReplacement: enqueuedModel.threadModelReplacement,
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
  "connectionId" | "orgId" | "userId"
> & { readonly guildId?: string };
type DiscordInputAsset = CanonicalInputAsset & {
  readonly discordAttachmentId: string;
};

/** Source and parent permissions come from the same ingress-owned provider reads. */
function ingressContextAccess(
  source: PreparedDiscordIngress["source"],
  channelId: string,
  messageContentEnabled: boolean,
): DiscordConversationAccess {
  const snapshot = source.snapshot;
  const selected =
    snapshot.channel.id === channelId
      ? snapshot
      : snapshot.permissionChannel.id === channelId
        ? { ...snapshot, channel: snapshot.permissionChannel }
        : null;
  if (!selected) {
    throw new Error(
      "Discord ingress context is outside its authorized source and parent",
    );
  }
  const access = authorizeDiscordSnapshot(selected, { mode: "read" });
  return access.kind === "denied"
    ? access
    : {
        kind: "allowed",
        binding: source.binding,
        botToken: source.botToken,
        channel: access.channel,
        messageContentEnabled,
      };
}

function throwTransientContextFailure(response: DiscordFailureResponse) {
  if (response.status >= 429) {
    throw new DiscordIngressFailure(
      `access:${response.status}`,
      true,
      (response.body.error.retryAfterSeconds ?? 0) * 1000,
      "Discord conversation history is temporarily unavailable",
    );
  }
}

async function readIngressParentContext(
  source: PreparedDiscordIngress["source"],
  thread: DiscordChannel,
  messageContentEnabled: boolean,
  signal: AbortSignal,
) {
  if (!thread.parent_id) {
    return null;
  }
  const access = ingressContextAccess(
    source,
    thread.parent_id,
    messageContentEnabled,
  );
  if (access.kind === "denied") {
    throwTransientContextFailure(access.response);
    return null;
  }
  const history = await readDiscordHistoryWithAccess(
    access,
    { before: thread.id, limit: CHANNEL_CONTEXT_MESSAGE_LIMIT },
    signal,
  );
  if (history.kind === "denied") {
    throwTransientContextFailure(history.response);
    return null;
  }
  // Message-created threads share the starter's ID. A standalone thread
  // legitimately has no starter message in its parent channel.
  const root = await readDiscordMessageWithAccess(access, thread.id, signal);
  if (root.kind === "denied") {
    throwTransientContextFailure(root.response);
  }
  return {
    channelId: history.channel.id,
    messages: history.messages,
    root: root.kind === "ok" ? root.message : null,
  };
}

function ingressContextReplyReference(
  message: DiscordMessageCreate,
  authorizedParentChannelId: string | undefined,
) {
  const reference = message.message_reference;
  const channelId = reference?.channel_id ?? message.channel_id;
  if (
    !reference?.message_id ||
    (reference.type !== undefined && reference.type !== 0) ||
    (reference.guild_id !== undefined &&
      reference.guild_id !== message.guild_id) ||
    (channelId !== message.channel_id &&
      channelId !== authorizedParentChannelId) ||
    BigInt(reference.message_id) >= BigInt(message.id)
  ) {
    return null;
  }
  return { channelId, messageId: reference.message_id };
}

const readIngressConversationContext$ = command(
  async (
    _context,
    args: {
      readonly source: PreparedDiscordIngress["source"];
      readonly message: DiscordMessageCreate;
      readonly messageContentEnabled: boolean;
    },
    signal: AbortSignal,
  ): Promise<string | null> => {
    const { source, message, messageContentEnabled } = args;
    if (!message.guild_id) {
      // Discord gives the bot one DM channel per user, shared by every org and
      // DM session that user starts. Like Slack DMs, read no channel history;
      // the canonical DM session carries its own continuity.
      return null;
    }
    if (!messageContentEnabled) {
      return "Ordinary guild history was not read because Discord MESSAGE_CONTENT is unavailable. Only the current message is included.";
    }
    const isThread = source.isThread;
    // READ_MESSAGE_HISTORY is optional for the current mention. Final
    // source view and destination write checks still revalidate live access.
    const access = ingressContextAccess(
      source,
      message.channel_id,
      messageContentEnabled,
    );
    if (access.kind === "denied") {
      return "Prior messages are unavailable because READ_MESSAGE_HISTORY is not permitted. Only the current message is included.";
    }
    const history = await readDiscordHistoryWithAccess(
      access,
      {
        before: message.id,
        limit: isThread
          ? THREAD_CONTEXT_MESSAGE_LIMIT
          : CHANNEL_CONTEXT_MESSAGE_LIMIT,
      },
      signal,
    );
    if (history.kind === "denied") {
      throwTransientContextFailure(history.response);
      return "Prior messages are unavailable because READ_MESSAGE_HISTORY is not permitted. Only the current message is included.";
    }
    const contextMessages: DiscordMessage[] = [...history.messages];
    let parentMessages: DiscordMessage[] = [];
    const priorityMessageIds: string[] = [];
    let referencedMessageId: string | undefined;
    let parentChannelId: string | undefined;
    if (isThread && history.channel.parent_id) {
      const parent = await readIngressParentContext(
        source,
        history.channel,
        messageContentEnabled,
        signal,
      );
      if (parent) {
        parentChannelId = parent.channelId;
        parentMessages = parent.messages;
        if (parent.root) {
          contextMessages.push(parent.root);
          priorityMessageIds.push(parent.root.id);
        }
      }
    }
    const reference = ingressContextReplyReference(message, parentChannelId);
    if (reference) {
      const referenceMessages =
        reference.channelId === parentChannelId
          ? parentMessages
          : contextMessages;
      const existing = [...contextMessages, ...parentMessages].find((entry) => {
        return (
          entry.id === reference.messageId &&
          entry.channel_id === reference.channelId
        );
      });
      if (existing) {
        referencedMessageId = existing.id;
        priorityMessageIds.push(existing.id);
      } else if (
        reference.channelId !== parentChannelId ||
        reference.messageId !== history.channel.id
      ) {
        // The starter was already read above, including a legitimate 404 for
        // a standalone thread. A reply reference must not fetch it twice.
        const quoteAccess = ingressContextAccess(
          source,
          reference.channelId,
          messageContentEnabled,
        );
        const quoted =
          quoteAccess.kind === "denied"
            ? quoteAccess
            : await readDiscordMessageWithAccess(
                quoteAccess,
                reference.messageId,
                signal,
              );
        if (quoted.kind === "ok") {
          referenceMessages.push(quoted.message);
          referencedMessageId = quoted.message.id;
          priorityMessageIds.push(quoted.message.id);
        } else {
          throwTransientContextFailure(quoted.response);
        }
      }
    }
    return [
      discordConversationContext({
        messages: parentMessages,
        contextType: "channel",
        priorityMessageIds,
        referencedMessageId,
      }),
      discordConversationContext({
        messages: contextMessages,
        contextType: isThread ? "thread" : "channel",
        priorityMessageIds,
        referencedMessageId,
      }),
    ]
      .filter(Boolean)
      .join("\n\n");
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
    const prepared = await set(
      prepareCanonicalInputFile$,
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
      },
      signal,
    );
    signal.throwIfAborted();
    let asset: CanonicalInputAsset;
    if (prepared.kind === "complete") {
      asset = prepared.asset;
    } else {
      const { importController, importSignal } =
        canonicalInputImportSignals(signal);
      const imported = await settleIncludingAbort(
        set(
          importDiscordInputFile$,
          prepared.plan,
          {
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
          importSignal,
        ),
      );
      signal.throwIfAborted();
      if (
        !imported.ok &&
        !importSignal.aborted &&
        imported.error instanceof DiscordAttachmentImportError
      ) {
        retryAfterMs = imported.error.retryAfterMs;
      }
      const outcome = canonicalInputImportOutcome(imported, importSignal);
      if (!imported.ok) {
        importController.abort();
      }
      asset = await set(
        completeCanonicalInputFile$,
        prepared.plan,
        outcome,
        signal,
      );
      signal.throwIfAborted();
    }
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
      readonly source: PreparedDiscordIngress["source"];
      readonly chatThreadId: string;
    },
    signal: AbortSignal,
  ): Promise<DiscordInputAsset[]> => {
    const { accessArgs, message, source, chatThreadId } = args;
    const { botToken } = source;
    const assets: DiscordInputAsset[] = [];
    if (message.attachments.length > 0) {
      const readAccess = ingressContextAccess(
        source,
        message.channel_id,
        false,
      );
      if (readAccess.kind === "denied") {
        throw new DiscordIngressFailure(
          "access:403",
          false,
          0,
          "Discord attachments are not currently accessible",
        );
      }
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
    threadId: message.guild_id ? ingress.destinationChannelId : null,
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

const persistClaimedIngress$ = command(
  async (
    { set },
    args: {
      readonly ingressId: string;
      readonly claimToken: string;
      readonly admittedBinding?: DiscordVerifiedBinding;
    },
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
    const { message, source, route } = routed;
    const { binding } = source;
    const ingress: ClaimedIngress = {
      ...routed.ingress,
      routeId: route.id,
      chatThreadId: route.chatThreadId,
      userId: route.userId,
      destinationChannelId: route.destinationChannelId,
      sessionKey: route.sessionKey,
    };
    const destinationChannelId = route.destinationChannelId ?? route.sessionKey;
    // Write access is established before history or attachment work begins.
    scheduleDiscordAdmissionTyping({
      botToken: source.botToken,
      channelId: route.destinationChannelId ?? message.channel_id,
    });
    const accessArgs = {
      connectionId: binding.connectionId,
      orgId: binding.orgId,
      userId: binding.userId,
      guildId: message.guild_id,
    };
    const messageContentEnabled = source.isDm
      ? false
      : discordResult(
          await discordClient.fetchDiscordCurrentApplication(
            { botToken: source.botToken, applicationId: source.applicationId },
            signal,
          ),
        ).messageContentEnabled;
    const conversationContext = await set(
      readIngressConversationContext$,
      {
        source,
        message,
        messageContentEnabled,
      },
      signal,
    );
    const assets = await set(
      materializeIngressAttachments$,
      {
        accessArgs,
        message,
        source,
        chatThreadId: ingress.chatThreadId,
      },
      signal,
    );
    const context = createIngressContext({
      binding,
      ingress,
      destinationChannelId,
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
    return persisted
      ? {
          orgId: binding.orgId,
          userId: binding.userId,
          chatThreadId: ingress.chatThreadId,
          connectionId: ingress.connectionId,
          destinationChannelId:
            ingress.destinationChannelId ?? message.channel_id,
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
  orgId: discordOauthStates.orgId,
  discordUserId: discordOrgConnections.discordUserId,
});

interface IngressFailureArgs {
  readonly ingressId: string;
  readonly claimToken: string;
  readonly attemptCount: number;
  readonly failure: DiscordIngressFailure;
}

function ingressFailurePlan(args: IngressFailureArgs) {
  const retry = args.failure.retryable && args.attemptCount < MAX_ATTEMPTS;
  const currentTime = nowDate();
  return {
    currentTime,
    notify:
      !retry &&
      !args.failure.errorClass.startsWith("binding:") &&
      ![
        "access:403",
        "access:404",
        "discord:unavailable",
        "discord:config_unavailable",
      ].includes(args.failure.errorClass),
    values: {
      status: retry ? ("retryable" as const) : ("terminal" as const),
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
    },
  };
}

function terminalIngressMessage(payload: string) {
  const envelope = discordGatewayEnvelopeSchema.safeParse(
    safeJsonParse(payload),
  );
  if (!envelope.success || envelope.data.eventType !== "MESSAGE_CREATE") {
    return null;
  }
  const message = discordMessageCreateSchema.safeParse(envelope.data.payload);
  return message.success ? message.data : null;
}

const TERMINAL_INGRESS_CONTENT =
  "I couldn't process this Discord message. Please send it again.";

type TerminalIngressRoute = Pick<
  typeof discordChatThreadRoutes.$inferSelect,
  "id" | "chatThreadId" | "userId" | "sessionKey" | "destinationChannelId"
> & { readonly orgId: string; readonly discordUserId: string };

function terminalIngressFailureResult(
  args: {
    readonly ingressId: string;
    readonly connectionId: string;
    readonly message: DiscordMessageCreate;
    readonly route: TerminalIngressRoute | undefined;
  },
  inserted: boolean,
): RecordedIngressFailure {
  const { ingressId, connectionId, message, route } = args;
  if (!route?.destinationChannelId) {
    return {
      reply: {
        kind: "notice",
        notice: {
          ingressId,
          connectionId,
          channelId: message.channel_id,
          content: TERMINAL_INGRESS_CONTENT,
        },
      },
      notification: null,
    };
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
              connectionId,
              guildId: message.guild_id ?? null,
              discordUserId: route.discordUserId,
              channelId: route.destinationChannelId,
              messageId: message.id,
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

const ingressFailureCommitSchema = z.object({
  claimed: z.boolean(),
  inserted: z.boolean(),
});

// Context preparation writes nothing. Only the same processing claim can
// publish; a reclaimed attempt performs no dependent write.
const recordIngressFailure$ = command(async function recordIngressFailure(
  { set },
  args: IngressFailureArgs,
  signal: AbortSignal,
): Promise<RecordedIngressFailure | null> {
  const plan = ingressFailurePlan(args);
  const db = set(writeDb$);
  const [claimed] = plan.notify
    ? await db
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
        .limit(1)
    : [];
  signal.throwIfAborted();
  const message = claimed ? terminalIngressMessage(claimed.payload) : null;
  const [route] =
    message && claimed?.routeId
      ? await db
          .select(terminalIngressRouteSelection)
          .from(discordChatThreadRoutes)
          .innerJoin(
            discordOrgConnections,
            eq(discordOrgConnections.id, discordChatThreadRoutes.connectionId),
          )
          .innerJoin(
            discordOauthStates,
            eq(discordOauthStates.id, discordOrgConnections.oauthGrantId),
          )
          .where(
            and(
              eq(discordChatThreadRoutes.id, claimed.routeId),
              eq(discordChatThreadRoutes.connectionId, claimed.connectionId),
            ),
          )
          .limit(1)
      : [];
  signal.throwIfAborted();
  const publication =
    route?.destinationChannelId && message
      ? {
          route,
          event: prepareChatEvent({
            id: args.ingressId,
            chatThreadId: route.chatThreadId,
            eventType: "output.error",
            runId: null,
            content: TERMINAL_INGRESS_CONTENT,
            error: TERMINAL_INGRESS_CONTENT,
            createdAt: plan.currentTime,
          }).row,
        }
      : null;
  const outcomes = parseRawRows(
    ingressFailureCommitSchema,
    await db.execute(
      discordIngressFailureSql({ ...args, ...plan, publication }),
    ),
  );
  signal.throwIfAborted();
  const [committed] = outcomes;
  if (outcomes.length !== 1 || !committed) {
    throw new Error("Expected one Discord ingress failure outcome");
  }
  if (!committed.claimed || !claimed || !message) {
    return null;
  }
  return terminalIngressFailureResult(
    {
      ingressId: args.ingressId,
      connectionId: claimed.connectionId,
      message,
      route,
    },
    committed.inserted,
  );
});

const finishRecordedIngressFailure$ = command(
  async (
    { set },
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
      await set(sendDiscordChatReply$, recorded.reply.request, signal);
    } else if (recorded?.reply?.kind === "notice") {
      await set(sendDiscordIngressNotice$, recorded.reply.notice, signal);
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
      await set(sendDiscordIngressNotice$, { ...target, content }, signal);
    }
  },
);

export const processCanonicalDiscordIngress$ = command(
  async (
    { set },
    args: {
      readonly ingressId: string;
      readonly admittedBinding?: DiscordVerifiedBinding;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    // Missing app configuration is an outage: leave ingress unclaimed.
    if (!getDiscordAppConfig()) {
      return false;
    }
    const db = set(writeDb$);
    const claim = await (async () => {
      const plan = discordIngressClaimWritePlan(args.ingressId);
      const [claimed] = await db
        .update(discordChatIngress)
        .set(plan.values)
        .where(plan.condition)
        .returning({ attemptCount: discordChatIngress.processingAttemptCount });
      return claimed ? { ...claimed, claimToken: plan.claimToken } : null;
    })();
    signal.throwIfAborted();
    if (!claim) {
      return false;
    }
    const result = await settle(
      set(
        persistClaimedIngress$,
        {
          ingressId: args.ingressId,
          claimToken: claim.claimToken,
          admittedBinding: args.admittedBinding,
        },
        signal,
      ),
      signal,
    );
    signal.throwIfAborted();
    if (!result.ok) {
      const recorded = await set(
        recordIngressFailure$,
        {
          ingressId: args.ingressId,
          ...claim,
          failure: ingressFailure(result.error),
        },
        signal,
      );
      await set(finishRecordedIngressFailure$, recorded, signal);
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

export const drainStaleCanonicalDiscordIngress$ = command(
  async ({ set }, signal: AbortSignal): Promise<number> => {
    // Without app configuration, neither exhaust attempts nor send notices.
    if (!getDiscordAppConfig()) {
      return 0;
    }
    const db = set(writeDb$);
    const currentTime = nowDate();
    const exhausted = await db
      .select({
        id: discordChatIngress.id,
        claimToken: discordChatIngress.claimToken,
        attemptCount: discordChatIngress.processingAttemptCount,
      })
      .from(discordChatIngress)
      .where(
        and(
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
      const recorded = await set(
        recordIngressFailure$,
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
      await set(finishRecordedIngressFailure$, recorded, signal);
    }
    const rows = await db
      .select({ id: discordChatIngress.id })
      .from(discordChatIngress)
      .where(claimableIngress(currentTime))
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
