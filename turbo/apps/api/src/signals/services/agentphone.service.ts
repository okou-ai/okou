import { GET_STARTED_REWARDS_CHANGED_EVENT } from "@okouai/api-contracts/contracts/get-started";
import { BRAND_PRESENTATION } from "@okouai/core/brand-presentation";
import { agents } from "@okouai/db/schema/agent";
import { agentphoneGroupMessageReceipts } from "@okouai/db/schema/agentphone-group-message-receipt";
import { agentphoneMessages } from "@okouai/db/schema/agentphone-message";
import { agentphoneMessageVisibility } from "@okouai/db/schema/agentphone-message-visibility";
import { agentphoneUserLinks } from "@okouai/db/schema/agentphone-user-link";
import { command } from "ccstate";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { v5 as uuidv5 } from "uuid";
import { env } from "../../lib/env";
import { INTEGRATION_DM_SESSION_KEY } from "../../lib/integration-dm-session";
import { inferMimetype } from "../../lib/mimetype";
import { now, nowDate } from "../../lib/time";
import { waitUntil } from "../context/wait-until";
import {
  sendAgentPhoneMessage,
  sendAgentPhoneTypingIndicator,
} from "../external/agentphone-client";
import { writeDb$, type Db, type ReadonlyDb } from "../external/db";
import {
  publishChatThreadMessageCreatedSafely,
  publishThreadListChangedSafely,
  publishUserSignal,
} from "../external/realtime";
import { bestEffort, safeUrlParse, settle } from "../utils";
import {
  ensureAgentPhoneChatThreadRoute$,
  findAgentPhoneRoutedChatThreadId$,
} from "./agentphone-chat-ingress.service";
import {
  agentPhoneChannelForLinkedHandle,
  agentPhoneReplyDestination,
  describeAgentPhoneHandleShape,
  isAgentPhoneChannel,
  isValidAgentPhoneHandle,
  normalizeAgentPhoneHandle,
  resolveAgentPhoneConversationVisibilityRecipients,
  resolveAgentPhoneMessageVisibilityRecipients,
  resolveAgentPhoneUserLink,
  resolveOrgDefaultComposeId,
  storeOutboundAgentPhoneMessage,
  type AgentPhoneChannel,
  type AgentPhoneMessageVisibilityRecipient,
  type AgentPhoneUserLink,
} from "./agentphone-shared.service";
import { InputFileImportError } from "./canonical-asset.service";
import { createChatEventSourcePart } from "./chat-event-annotation.service";
import { resolveEnqueuedChatInputModel$ } from "./chat-input-model.service";
import { chatQueueWaitNotice } from "./chat-queue-wait-notice";
import type { ChatQueueWaitReason } from "./chat-queue-wait-reason";
import {
  enqueuedChatQueueWaitReason$,
  notifyRunningChatRunOfPendingInput$,
  pickEnqueuedChatThread$,
} from "./chat-thread-queue-drain.service";
import { createUserMessageDocument } from "./chat-user-message.service";
import { enqueueIntegrationChatInput$ } from "./integration-chat-queue.service";
import {
  readIntegrationChatThreadModel$,
  updateIntegrationChatThreadModel$,
} from "./integration-chat-thread-model.service";
import {
  canonicalInputFilePrompt,
  integrationInputMessageFiles,
  materializeIntegrationInputAssets$,
  readyIntegrationInputAsset,
  type IntegrationInputFile,
} from "./integration-input-assets.service";
import { resolveDefaultModelFirstPin$ } from "./model-selection.service";
import { touchNativeChatThread$ } from "./native-chat-event-write.service";
import { loadOptionalChatEnrichment } from "./queued-launch-enrichment.service";
import { listAvailableRunModelsWithDefault$ } from "./run-models.service";
const MAX_CONNECT_AGE_SECONDS = 600;
const MAX_WEBHOOK_AGE_SECONDS = 300;
const SIGNATURE_PREFIX = "sha256=";
const MAX_CONTEXT_MESSAGES = 10;
const AGENTPHONE_SMS_MMS_SLASH_COMMAND_RISK_MESSAGE =
  "Note: SMS and MMS replies may not be delivered reliably. For the most reliable experience, use iMessage with this number.";
const AGENTPHONE_GROUP_CONNECT_IN_DM_MESSAGE =
  "To connect this phone number, message this number directly in a 1:1 iMessage conversation.";
const AGENTPHONE_GROUP_ACCOUNT_COMMAND_MESSAGE =
  "Only the linked sender can use account commands in a group. Message this number directly to connect or manage your link.";
const AGENTPHONE_CHAT_MESSAGE_ID_NAMESPACE =
  "3208d609-59a7-4b0e-9c3b-3db20e9c924f";

const AGENTPHONE_DM_ROOT_MESSAGE_ID = "dm";

export {
  agentPhoneChannelForLinkedHandle,
  describeAgentPhoneHandleShape,
  isAgentPhoneChannel,
  isValidAgentPhoneHandle,
  normalizeAgentPhoneHandle,
  storeOutboundAgentPhoneMessage,
  type AgentPhoneChannel,
};

export interface AgentPhoneRecentHistoryMessage {
  readonly messageId?: string | null;
  readonly content: string | null;
  readonly direction: string | null;
  readonly channel: string | null;
  readonly fromNumber?: string | null;
  readonly toNumber?: string | null;
  readonly at?: string | null;
}

export interface AgentPhoneMessageEvent {
  readonly webhookId: string | null;
  readonly channel: AgentPhoneChannel;
  readonly messageId: string;
  readonly conversationId: string | null;
  readonly groupId: string | null;
  readonly isGroup: boolean;
  readonly participants: readonly string[];
  readonly senderIdentifier?: string | null;
  readonly mentioned: boolean;
  readonly agentphoneAgentId: string;
  readonly fromNumber: string;
  readonly toNumber: string;
  readonly body: string;
  readonly mediaUrl: string | null;
  readonly receivedAt: Date | null;
  readonly recentHistory: readonly AgentPhoneRecentHistoryMessage[];
}

interface WorkspaceAgent {
  readonly composeId: string;
  readonly agentId: string;
  readonly name: string;
  readonly displayName: string | null;
}

function isAgentPhoneGroupEvent(event: AgentPhoneMessageEvent): boolean {
  return event.channel === "imessage" && event.isGroup;
}

function agentPhoneThreadRootMessageId(event: AgentPhoneMessageEvent): string {
  if (!isAgentPhoneGroupEvent(event)) {
    return AGENTPHONE_DM_ROOT_MESSAGE_ID;
  }
  if (!event.conversationId) {
    throw new Error("AgentPhone group message is missing a conversation id");
  }

  const root = `group:${event.conversationId}`;
  if (root.length <= 255) {
    return root;
  }

  return `group:${createHash("sha256")
    .update(event.conversationId)
    .digest("hex")}`;
}

/** Chat thread route key: group conversations by id, DMs share the main key. */
function agentPhoneChatRouteRootMessageId(
  event: AgentPhoneMessageEvent,
): string {
  return isAgentPhoneGroupEvent(event)
    ? agentPhoneThreadRootMessageId(event)
    : INTEGRATION_DM_SESSION_KEY;
}

function shouldIgnoreAgentPhoneGroupMessage(
  event: AgentPhoneMessageEvent,
): boolean {
  return isAgentPhoneGroupEvent(event) && !event.mentioned;
}

function isAgentPhoneGroupAccountCommand(
  event: AgentPhoneMessageEvent,
  commandName: string | undefined,
): boolean {
  return (
    isAgentPhoneGroupEvent(event) &&
    (commandName === "connect" ||
      commandName === "disconnect" ||
      commandName === "model")
  );
}

function normalizeHandleForConnect(handle: string): string {
  return handle.trim();
}

function signAgentPhoneConnectParams(params: {
  readonly phoneHandle: string;
  readonly agentphoneAgentId: string;
  readonly timestamp: number;
  readonly channel: AgentPhoneChannel;
  readonly secret: string;
}): string {
  return createHmac("sha256", params.secret)
    .update(
      `${normalizeHandleForConnect(params.phoneHandle)}:${
        params.agentphoneAgentId
      }:${String(params.timestamp)}:${params.channel}`,
    )
    .digest("hex");
}

function safeHexSignatureEqual(expected: string, actual: string): boolean {
  if (actual.length !== expected.length || !/^[0-9a-f]+$/iu.test(actual)) {
    return false;
  }

  const expectedBuffer = Buffer.from(expected, "hex");
  const signatureBuffer = Buffer.from(actual, "hex");
  if (expectedBuffer.length !== signatureBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, signatureBuffer);
}

export function verifyAgentPhoneConnectSignature(params: {
  readonly phoneHandle: string;
  readonly agentphoneAgentId: string;
  readonly timestamp: number;
  readonly channel: AgentPhoneChannel;
  readonly signature: string;
  readonly secret: string;
}): boolean {
  const nowSeconds = Math.floor(now() / 1000);
  if (Math.abs(nowSeconds - params.timestamp) > MAX_CONNECT_AGE_SECONDS) {
    return false;
  }

  return safeHexSignatureEqual(
    signAgentPhoneConnectParams({
      phoneHandle: params.phoneHandle,
      agentphoneAgentId: params.agentphoneAgentId,
      timestamp: params.timestamp,
      channel: params.channel,
      secret: params.secret,
    }),
    params.signature,
  );
}

export function verifyAgentPhoneWebhook(params: {
  readonly rawBody: string;
  readonly signature: string | null;
  readonly timestamp: string | null;
  readonly secret: string;
}): boolean {
  if (!params.signature || !params.timestamp) {
    return false;
  }

  const timestamp = Number(params.timestamp);
  if (!Number.isFinite(timestamp)) {
    return false;
  }

  const nowSeconds = Math.floor(now() / 1000);
  if (Math.abs(nowSeconds - timestamp) > MAX_WEBHOOK_AGE_SECONDS) {
    return false;
  }

  const expectedDigest = createHmac("sha256", params.secret)
    .update(`${params.timestamp}.${params.rawBody}`)
    .digest("hex");
  const expected = `${SIGNATURE_PREFIX}${expectedDigest}`;
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(params.signature);
  if (expectedBuffer.length !== signatureBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, signatureBuffer);
}

export function buildAgentPhoneConnectUrl(params: {
  readonly phoneHandle: string;
  readonly agentphoneAgentId: string;
  readonly channel: AgentPhoneChannel;
  readonly secret: string;
}): string {
  const timestamp = Math.floor(now() / 1000);
  const phoneHandle = normalizeAgentPhoneHandle(
    params.phoneHandle,
    params.channel,
  );
  const query = new URLSearchParams({
    handle: phoneHandle,
    agent: params.agentphoneAgentId,
    ts: String(timestamp),
    sig: signAgentPhoneConnectParams({
      phoneHandle,
      agentphoneAgentId: params.agentphoneAgentId,
      timestamp,
      channel: params.channel,
      secret: params.secret,
    }),
    channel: params.channel,
  });
  return `${env("APP_URL")}/agentphone/connect?${query.toString()}`;
}

/**
 * The sender's own phone link. Group conversations never borrow another
 * participant's link: an unlinked sender is treated as unlinked even when the
 * conversation already has a route owned by someone else.
 */
export function resolveAgentPhoneUserLinkForEvent(
  db: Db,
  event: AgentPhoneMessageEvent,
): Promise<AgentPhoneUserLink | null> {
  return resolveAgentPhoneUserLink(db, event.fromNumber, event.channel);
}

/**
 * The member's own phone link. A member has at most one link per organization,
 * so proactive sends address it directly instead of trusting a caller-supplied
 * handle.
 */
export async function resolveAgentPhoneUserLinkForMember(
  db: ReadonlyDb,
  params: {
    readonly userId: string;
    readonly orgId: string;
  },
): Promise<AgentPhoneUserLink | null> {
  const [userLink] = await db
    .select()
    .from(agentphoneUserLinks)
    .where(
      and(
        eq(agentphoneUserLinks.userId, params.userId),
        eq(agentphoneUserLinks.orgId, params.orgId),
      ),
    )
    .limit(1);

  return userLink ?? null;
}

export async function resolveAgentPhoneAgentIdForUserLink(
  db: ReadonlyDb,
  params: {
    readonly userLinkId: string;
    readonly phoneHandle: string;
    readonly channel: AgentPhoneChannel;
    readonly agentphoneAgentId?: string | null;
  },
): Promise<string | null> {
  if (params.agentphoneAgentId) {
    return params.agentphoneAgentId;
  }

  const [message] = await db
    .select({ agentphoneAgentId: agentphoneMessages.agentphoneAgentId })
    .from(agentphoneMessages)
    .where(
      and(
        eq(agentphoneMessages.agentphoneUserLinkId, params.userLinkId),
        eq(
          agentphoneMessages.phoneHandle,
          normalizeAgentPhoneHandle(params.phoneHandle, params.channel),
        ),
      ),
    )
    .orderBy(desc(agentphoneMessages.createdAt))
    .limit(1);

  return message?.agentphoneAgentId ?? null;
}

export async function storeInboundAgentPhoneMessage(
  db: Db,
  params: {
    readonly event: AgentPhoneMessageEvent;
    readonly userLinkId?: string | null;
  },
): Promise<{ readonly inserted: boolean; readonly dispatch: boolean }> {
  const isGroup = isAgentPhoneGroupEvent(params.event);
  return await db.transaction(async (tx) => {
    let visibilityRecipients: readonly AgentPhoneMessageVisibilityRecipient[] =
      [];
    if (isGroup) {
      const receivedAt = params.event.receivedAt;
      if (receivedAt === null) {
        throw new Error("AgentPhone group message is missing receivedAt");
      }

      const existingConditions = [
        eq(agentphoneMessages.agentphoneMessageId, params.event.messageId),
      ];
      if (params.event.webhookId) {
        existingConditions.push(
          eq(agentphoneMessages.webhookId, params.event.webhookId),
        );
      }
      const [existing] = await tx
        .select({ id: agentphoneMessages.id })
        .from(agentphoneMessages)
        .where(or(...existingConditions))
        .limit(1);
      if (existing) {
        return { inserted: false, dispatch: false };
      }

      const receiptInserted = await tx.transaction(async (receiptTx) => {
        const [receipt] = await receiptTx
          .insert(agentphoneGroupMessageReceipts)
          .values({
            agentphoneMessageId: params.event.messageId,
            webhookId: params.event.webhookId,
          })
          .onConflictDoNothing()
          .returning({
            agentphoneMessageId:
              agentphoneGroupMessageReceipts.agentphoneMessageId,
          });
        return receipt !== undefined;
      });
      if (!receiptInserted) {
        return { inserted: false, dispatch: false };
      }

      visibilityRecipients = await resolveAgentPhoneMessageVisibilityRecipients(
        tx,
        params.event.participants,
        "imessage",
        receivedAt,
      );
    }
    if (isGroup && visibilityRecipients.length === 0) {
      return { inserted: false, dispatch: true };
    }

    const [inserted] = await tx
      .insert(agentphoneMessages)
      .values({
        webhookId: params.event.webhookId,
        agentphoneMessageId: params.event.messageId,
        conversationId: params.event.conversationId,
        groupId: isGroup ? params.event.groupId : null,
        agentphoneAgentId: params.event.agentphoneAgentId,
        agentphoneUserLinkId: params.userLinkId ?? null,
        phoneHandle: normalizeAgentPhoneHandle(
          params.event.fromNumber,
          params.event.channel,
        ),
        fromNumber: normalizeAgentPhoneHandle(
          params.event.senderIdentifier ?? params.event.fromNumber,
          params.event.channel,
        ),
        toNumber:
          params.event.groupId ??
          normalizeAgentPhoneHandle(params.event.toNumber, "sms"),
        direction: "inbound",
        channel: params.event.channel,
        body: params.event.body || null,
        mediaUrl: params.event.mediaUrl,
        isBot: false,
        receivedAt: params.event.receivedAt,
      })
      .onConflictDoNothing()
      .returning({ id: agentphoneMessages.id });

    if (inserted && isGroup) {
      await tx
        .insert(agentphoneMessageVisibility)
        .values(
          visibilityRecipients.map((recipient) => {
            return {
              messageId: inserted.id,
              orgId: recipient.orgId,
              userId: recipient.userId,
            };
          }),
        )
        .onConflictDoNothing();
    }

    return {
      inserted: Boolean(inserted),
      dispatch: Boolean(inserted),
    };
  });
}

async function getWorkspaceAgent(
  db: ReadonlyDb,
  composeId: string,
): Promise<WorkspaceAgent | null> {
  const [row] = await db
    .select({
      composeId: agents.id,
      name: agents.name,
      displayName: agents.displayName,
    })
    .from(agents)
    .where(eq(agents.id, composeId))
    .limit(1);

  if (!row) {
    return null;
  }

  return {
    composeId: row.composeId,
    agentId: row.composeId,
    name: row.name,
    displayName: row.displayName,
  };
}

async function resolveAgentPhoneAgent(
  db: ReadonlyDb,
  userLink: AgentPhoneUserLink,
): Promise<WorkspaceAgent | undefined> {
  const composeId = await resolveOrgDefaultComposeId(db, userLink.orgId);
  if (!composeId) {
    return undefined;
  }

  return (await getWorkspaceAgent(db, composeId)) ?? undefined;
}

export function agentPhoneFilenameFromMediaUrl(
  mediaUrl: string,
  fallback: string,
): string {
  const url = safeUrlParse(mediaUrl);
  if (!url) {
    return fallback;
  }
  const filename = url.pathname.split("/").filter(Boolean).pop();
  return filename ? decodePathSegment(filename) : fallback;
}

function parseHexByte(input: string): number | undefined {
  return /^[0-9a-fA-F]{2}$/u.test(input)
    ? Number.parseInt(input, 16)
    : undefined;
}

function decodePathSegment(input: string): string {
  const decoder = new TextDecoder();
  let output = "";
  let index = 0;

  while (index < input.length) {
    const char = input[index];
    if (char !== "%") {
      output += char ?? "";
      index += 1;
      continue;
    }

    const bytes: number[] = [];
    let cursor = index;
    while (cursor + 2 < input.length && input[cursor] === "%") {
      const byte = parseHexByte(input.slice(cursor + 1, cursor + 3));
      if (byte === undefined) {
        break;
      }
      bytes.push(byte);
      cursor += 3;
    }

    if (bytes.length === 0) {
      output += "%";
      index += 1;
      continue;
    }

    output += decoder.decode(Uint8Array.from(bytes));
    index = cursor;
  }

  return output;
}

function formatAgentPhoneFileForContext(params: {
  readonly messageId: string;
  readonly mediaUrl: string;
}): string {
  const name = agentPhoneFilenameFromMediaUrl(params.mediaUrl, "phone-media");
  const mimetype = inferMimetype(name);
  return [
    `[Phone file] ${name} (${mimetype})`,
    `   [ID] ${params.messageId}`,
  ].join("\n");
}

async function fetchAgentPhoneContext(
  db: ReadonlyDb,
  params: {
    readonly userLinkId: string;
    readonly userId: string;
    readonly orgId: string;
    readonly phoneHandle: string;
    readonly channel: AgentPhoneChannel;
    readonly conversationId: string | null;
    readonly groupId: string | null;
    readonly agentphoneAgentId: string;
    readonly isGroup: boolean;
    readonly recentHistory: readonly AgentPhoneRecentHistoryMessage[];
    readonly currentMessageId?: string;
  },
): Promise<{ readonly executionContext: string }> {
  const phoneHandle = normalizeAgentPhoneHandle(
    params.phoneHandle,
    params.channel,
  );
  const providerContext = params.isGroup
    ? ""
    : formatAgentPhoneRecentHistoryContext(
        params.recentHistory,
        params.currentMessageId,
        false,
      );
  if (providerContext) {
    return { executionContext: providerContext };
  }

  const messages =
    params.isGroup && params.groupId
      ? await db
          .select({
            messageId: agentphoneMessages.agentphoneMessageId,
            body: agentphoneMessages.body,
            mediaUrl: agentphoneMessages.mediaUrl,
            isBot: agentphoneMessages.isBot,
            direction: agentphoneMessages.direction,
            fromNumber: agentphoneMessages.fromNumber,
          })
          .from(agentphoneMessages)
          .innerJoin(
            agentphoneMessageVisibility,
            eq(agentphoneMessageVisibility.messageId, agentphoneMessages.id),
          )
          .where(
            and(
              eq(
                agentphoneMessages.agentphoneAgentId,
                params.agentphoneAgentId,
              ),
              eq(agentphoneMessages.groupId, params.groupId),
              eq(agentphoneMessageVisibility.orgId, params.orgId),
              eq(agentphoneMessageVisibility.userId, params.userId),
            ),
          )
          .orderBy(desc(agentphoneMessages.receivedAt))
          .limit(MAX_CONTEXT_MESSAGES)
      : await db
          .select({
            messageId: agentphoneMessages.agentphoneMessageId,
            body: agentphoneMessages.body,
            mediaUrl: agentphoneMessages.mediaUrl,
            isBot: agentphoneMessages.isBot,
            direction: agentphoneMessages.direction,
            fromNumber: agentphoneMessages.fromNumber,
          })
          .from(agentphoneMessages)
          .where(
            and(
              eq(agentphoneMessages.agentphoneUserLinkId, params.userLinkId),
              eq(agentphoneMessages.phoneHandle, phoneHandle),
              isNull(agentphoneMessages.groupId),
            ),
          )
          .orderBy(desc(agentphoneMessages.createdAt))
          .limit(MAX_CONTEXT_MESSAGES);

  return {
    executionContext: formatAgentPhoneStoredContext({
      messages,
      currentMessageId: params.currentMessageId,
      fallbackSender: phoneHandle,
      isGroup: params.isGroup,
    }),
  };
}

function formatAgentPhoneStoredContext(params: {
  readonly messages: readonly {
    readonly messageId: string;
    readonly body: string | null;
    readonly mediaUrl: string | null;
    readonly isBot: boolean;
    readonly direction: string;
    readonly fromNumber: string;
  }[];
  readonly currentMessageId?: string;
  readonly fallbackSender: string;
  readonly isGroup: boolean;
}): string {
  const chronological = [...params.messages].reverse().filter((message) => {
    return (
      !params.currentMessageId || message.messageId !== params.currentMessageId
    );
  });
  if (chronological.length === 0) {
    return "";
  }

  const total = chronological.length;
  const formatted = chronological.map((message, index) => {
    const sender = message.isBot
      ? "BOT"
      : params.isGroup
        ? message.fromNumber
        : params.fallbackSender;
    const parts = [
      "---",
      "",
      `- RELATIVE_INDEX: ${index - total}`,
      `- MSG_ID: ${message.messageId}`,
      `- SENDER: {id: ${sender}}`,
      `- DIRECTION: ${message.direction}`,
      "",
      message.body ?? "",
    ];
    if (message.mediaUrl) {
      parts.push(
        "",
        formatAgentPhoneFileForContext({
          messageId: message.messageId,
          mediaUrl: message.mediaUrl,
        }),
      );
    }
    return parts.join("\n");
  });

  return buildAgentPhoneContextBlock(formatted, params.isGroup);
}

function formatAgentPhoneRecentHistoryContext(
  recentHistory: readonly AgentPhoneRecentHistoryMessage[],
  currentMessageId: string | undefined,
  isGroup: boolean,
): string {
  const chronological = recentHistory
    .filter((message) => {
      return !currentMessageId || message.messageId !== currentMessageId;
    })
    .slice(-MAX_CONTEXT_MESSAGES);

  if (chronological.length === 0) {
    return "";
  }

  const total = chronological.length;
  const formatted = chronological.map((message, index) => {
    const senderParts = message.fromNumber ? [`id: ${message.fromNumber}`] : [];
    return [
      "---",
      "",
      `- RELATIVE_INDEX: ${index - total}`,
      message.messageId ? `- MSG_ID: ${message.messageId}` : null,
      `- SENDER: {${senderParts.join(", ")}}`,
      message.direction ? `- DIRECTION: ${message.direction}` : null,
      message.channel ? `- CHANNEL: ${message.channel}` : null,
      message.at ? `- AT: ${message.at}` : null,
      "",
      message.content ?? "",
    ]
      .filter((part): part is string => {
        return part !== null;
      })
      .join("\n");
  });

  return buildAgentPhoneContextBlock(formatted, isGroup);
}

function buildAgentPhoneContextBlock(
  formattedMessages: readonly string[],
  isGroup: boolean,
): string {
  return [
    "# Phone Message Context",
    "",
    isGroup
      ? "The messages below are from an iMessage group conversation with the shared phone number. Messages closer to RELATIVE_INDEX 0 are more recent."
      : "The messages below are from the user's text message conversation with the shared phone number. Messages closer to RELATIVE_INDEX 0 are more recent.",
    "",
    formattedMessages.join("\n\n"),
    "",
    "---",
  ].join("\n");
}

function enrichAgentPhonePrompt(opts: {
  readonly prompt: string;
  readonly messageId: string;
  readonly mediaUrl: string | null;
}): string {
  const parts = [opts.prompt.trim()];
  if (opts.mediaUrl) {
    parts.push(
      formatAgentPhoneFileForContext({
        messageId: opts.messageId,
        mediaUrl: opts.mediaUrl,
      }),
    );
  }
  return parts.filter(Boolean).join("\n\n");
}

function parseAgentPhoneCommand(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }
  const firstWord = trimmed.split(/\s/u)[0];
  if (!firstWord) {
    return undefined;
  }
  return firstWord.slice(1).toLowerCase();
}

function isUnreliableAgentPhoneReplyChannel(
  channel: string | null | undefined,
): boolean {
  const normalized = channel?.trim().toLowerCase();
  return normalized === "sms" || normalized === "mms";
}

function appendAgentPhoneSlashCommandRiskWarning(
  body: string,
  channel: string | null | undefined,
): string {
  if (!isUnreliableAgentPhoneReplyChannel(channel)) {
    return body;
  }
  if (body.includes(AGENTPHONE_SMS_MMS_SLASH_COMMAND_RISK_MESSAGE)) {
    return body;
  }
  return [body, AGENTPHONE_SMS_MMS_SLASH_COMMAND_RISK_MESSAGE].join("\n\n");
}

export async function sendAgentPhoneText(
  event: AgentPhoneMessageEvent,
  body: string,
  db: Db | undefined,
  signal: AbortSignal,
): Promise<void> {
  const isGroup = isAgentPhoneGroupEvent(event);
  if (isGroup && !db) {
    throw new Error("AgentPhone group reply requires a database handle");
  }
  if (isGroup && !event.conversationId) {
    throw new Error("AgentPhone group reply is missing a conversation id");
  }
  const visibilityRecipients = isGroup
    ? await resolveAgentPhoneConversationVisibilityRecipients(
        db!,
        event.conversationId!,
        nowDate(),
        signal,
      )
    : [];
  signal.throwIfAborted();
  const sent = await sendAgentPhoneMessage(
    {
      agentphoneAgentId: event.agentphoneAgentId,
      toNumber: agentPhoneReplyDestination({
        isGroup,
        groupId: event.groupId,
        phoneHandle: event.fromNumber,
      }),
      ...(event.channel === "imessage"
        ? { replyToMessageId: event.messageId }
        : {}),
      body,
    },
    signal,
  );
  signal.throwIfAborted();

  if (isGroup) {
    await storeOutboundAgentPhoneMessage(db!, {
      agentphoneMessageId: sent.id,
      conversationId: event.conversationId,
      groupId: event.groupId,
      agentphoneAgentId: event.agentphoneAgentId,
      phoneHandle: event.fromNumber,
      fromNumber: event.toNumber,
      toNumber: sent.toNumber,
      body,
      channel: event.channel,
      userChannel: event.channel,
      visibilityRecipients,
    });
  }
}

async function sendAgentPhoneSlashCommandText(
  event: AgentPhoneMessageEvent,
  body: string,
  db: Db | undefined,
  signal: AbortSignal,
): Promise<void> {
  await sendAgentPhoneText(
    event,
    appendAgentPhoneSlashCommandRiskWarning(body, event.channel),
    db,
    signal,
  );
}

async function refreshTypingIfSupported(
  event: AgentPhoneMessageEvent,
  signal: AbortSignal,
): Promise<void> {
  if (event.channel !== "imessage") {
    return;
  }
  const conversationId = isAgentPhoneGroupEvent(event)
    ? event.groupId
    : event.conversationId;
  if (!conversationId) {
    return;
  }

  await bestEffort(
    sendAgentPhoneTypingIndicator({ conversationId }, signal),
    signal,
  );
}

function formatConnectPrompt(event: AgentPhoneMessageEvent): string {
  const { brandName } = BRAND_PRESENTATION;
  const connectUrl = buildAgentPhoneConnectUrl({
    phoneHandle: event.fromNumber,
    agentphoneAgentId: event.agentphoneAgentId,
    secret: env("SECRETS_ENCRYPTION_KEY"),
    channel: event.channel,
  });

  return [
    "You can text me like a teammate and I'll actually do the work: research something, draft and send emails, summarize long documents, update spreadsheets, triage tickets, post to Slack, dig through your GitHub or Notion, and a lot more.",
    "",
    "I'm most useful once I'm connected to the tools you already use — GitHub, Gmail, Notion, Google Drive / Sheets / Docs / Calendar, Slack, Sentry, X, and 100+ others.",
    "",
    `Click the link below to start using ${brandName}.`,
    "",
    connectUrl,
  ].join("\n");
}

function formatHelpMessage(): string {
  const { brandName } = BRAND_PRESENTATION;
  return [
    `${brandName} text message commands`,
    "",
    `/connect - Connect this phone number to ${brandName}`,
    "/model - Choose your model",
    `/disconnect - Disconnect this phone number from ${brandName}`,
    "/help - Show these commands",
    "",
    "Send a message here after connecting.",
  ].join("\n");
}

async function sendConnectPrompt(
  event: AgentPhoneMessageEvent,
  options: { readonly slashCommand: boolean } | undefined,
  db: Db | undefined,
  signal: AbortSignal,
): Promise<void> {
  const body = formatConnectPrompt(event);
  await sendAgentPhoneText(
    event,
    options?.slashCommand
      ? appendAgentPhoneSlashCommandRiskWarning(body, event.channel)
      : body,
    db,
    signal,
  );
}

async function sendGroupConnectInDmPrompt(
  event: AgentPhoneMessageEvent,
  db: Db | undefined,
  signal: AbortSignal,
): Promise<void> {
  await sendAgentPhoneText(
    event,
    AGENTPHONE_GROUP_CONNECT_IN_DM_MESSAGE,
    db,
    signal,
  );
}

async function sendGroupAccountCommandBlockedMessage(
  event: AgentPhoneMessageEvent,
  db: Db | undefined,
  signal: AbortSignal,
): Promise<void> {
  await sendAgentPhoneText(
    event,
    AGENTPHONE_GROUP_ACCOUNT_COMMAND_MESSAGE,
    db,
    signal,
  );
}

async function blockUnauthorizedGroupAccountCommand(
  args: {
    readonly db: Db;
    readonly event: AgentPhoneMessageEvent;
    readonly commandText: string | undefined;
    readonly userLink: AgentPhoneUserLink | null;
  },
  signal: AbortSignal,
): Promise<boolean> {
  if (
    !isAgentPhoneGroupAccountCommand(args.event, args.commandText) ||
    args.userLink
  ) {
    return false;
  }

  await sendGroupAccountCommandBlockedMessage(args.event, args.db, signal);
  return true;
}

async function handleConnectCommand(
  args: {
    readonly db: Db;
    readonly event: AgentPhoneMessageEvent;
    readonly userLink: AgentPhoneUserLink | null;
  },
  signal: AbortSignal,
): Promise<void> {
  if (args.userLink) {
    const { brandName } = BRAND_PRESENTATION;
    await sendAgentPhoneSlashCommandText(
      args.event,
      `You are already connected. Send a message here to start using ${brandName}.`,
      args.db,
      signal,
    );
    return;
  }
  await sendConnectPrompt(args.event, { slashCommand: true }, args.db, signal);
}

async function handleDisconnectCommand(
  args: {
    readonly db: Db;
    readonly event: AgentPhoneMessageEvent;
    readonly userLink: AgentPhoneUserLink | null;
  },
  signal: AbortSignal,
): Promise<void> {
  if (!args.userLink) {
    await sendAgentPhoneSlashCommandText(
      args.event,
      "Error: This phone number is not connected.",
      args.db,
      signal,
    );
    return;
  }

  await args.db
    .delete(agentphoneUserLinks)
    .where(eq(agentphoneUserLinks.id, args.userLink.id));
  signal.throwIfAborted();

  await sendAgentPhoneSlashCommandText(
    args.event,
    `This phone number has been disconnected from ${BRAND_PRESENTATION.brandName}.`,
    args.db,
    signal,
  );
}

function commandArgument(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  const firstWhitespaceIndex = trimmed.search(/\s/u);
  if (firstWhitespaceIndex === -1) {
    return "";
  }
  return trimmed.slice(firstWhitespaceIndex).trim();
}

function lookupKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/gu, "-");
}

function compactLookupKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, "");
}

function findModelOption(
  options: readonly {
    readonly model: string;
    readonly label: string;
    readonly isDefault: boolean;
  }[],
  input: string,
) {
  const inputKeys = new Set([lookupKey(input), compactLookupKey(input)]);
  return options.find((option) => {
    return [option.model, option.label].some((value) => {
      return (
        inputKeys.has(lookupKey(value)) ||
        inputKeys.has(compactLookupKey(value))
      );
    });
  });
}

function formatAgentPhoneModelOptionsMessage(
  options: readonly {
    readonly model: string;
    readonly label: string;
    readonly isDefault: boolean;
  }[],
  currentSelectedModel: string | null,
): string {
  const optionLines = options.map((option) => {
    const markers = [
      option.model === currentSelectedModel ? "current" : null,
      option.isDefault ? "default" : null,
    ].filter((marker): marker is string => {
      return marker !== null;
    });
    const suffix = markers.length > 0 ? ` (${markers.join(", ")})` : "";
    return `/model ${option.model} - ${option.label}${suffix}`;
  });

  const current = currentSelectedModel
    ? (options.find((option) => {
        return option.model === currentSelectedModel;
      })?.label ?? currentSelectedModel)
    : "default";
  return [
    "Available models",
    "",
    `Current: ${current}`,
    "",
    "Send one of these commands to switch:",
    ...optionLines,
  ].join("\n");
}

const handleModelCommand$ = command(
  async (
    { set },
    args: {
      readonly db: Db;
      readonly event: AgentPhoneMessageEvent;
      readonly userLinkId: string;
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const chatThreadId = await set(
      findAgentPhoneRoutedChatThreadId$,
      {
        agentphoneUserLinkId: args.userLinkId,
        rootMessageId: agentPhoneChatRouteRootMessageId(args.event),
      },
      signal,
    );
    signal.throwIfAborted();
    const currentSelectedModel = await set(
      readIntegrationChatThreadModel$,
      {
        orgId: args.orgId,
        userId: args.userId,
        chatThreadId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!currentSelectedModel) {
      await sendAgentPhoneSlashCommandText(
        args.event,
        "Error: Start or enter an existing Okou conversation before using /model.",
        args.db,
        signal,
      );
      return;
    }
    const { response: runModels, systemDefaultModel } = await set(
      listAvailableRunModelsWithDefault$,
      { orgId: args.orgId, userId: args.userId },
      signal,
    );
    signal.throwIfAborted();

    const options = runModels.models.map((runModel) => {
      return {
        model: runModel.model,
        label: runModel.modelLabel,
        isDefault: runModel.model === systemDefaultModel,
      };
    });

    if (options.length === 0) {
      await sendAgentPhoneSlashCommandText(
        args.event,
        "Error: No models are configured for this workspace.",
        args.db,
        signal,
      );
      return;
    }

    const input = commandArgument(args.event.body);
    if (!input) {
      await sendAgentPhoneSlashCommandText(
        args.event,
        formatAgentPhoneModelOptionsMessage(options, currentSelectedModel),
        args.db,
        signal,
      );
      return;
    }

    const option = findModelOption(options, input);
    if (!option) {
      await sendAgentPhoneSlashCommandText(
        args.event,
        [
          `Error: Unknown model "${input}".`,
          "",
          formatAgentPhoneModelOptionsMessage(options, currentSelectedModel),
        ].join("\n"),
        args.db,
        signal,
      );
      return;
    }

    const threadModel = await set(
      updateIntegrationChatThreadModel$,
      {
        orgId: args.orgId,
        userId: args.userId,
        chatThreadId,
        model: option.model,
      },
      signal,
    );
    if (threadModel.kind !== "updated") {
      await sendAgentPhoneSlashCommandText(
        args.event,
        threadModel.kind === "no_thread"
          ? "Error: Start or enter an existing Okou conversation before using /model."
          : "Error: You don't have access to that model.",
        args.db,
        signal,
      );
      return;
    }
    signal.throwIfAborted();
    await sendAgentPhoneSlashCommandText(
      args.event,
      `Switched to ${option.label}.`,
      args.db,
      signal,
    );
  },
);

const dispatchAgentPhoneCommand$ = command(
  async (
    { set },
    args: {
      readonly db: Db;
      readonly command: string | undefined;
      readonly event: AgentPhoneMessageEvent;
      readonly userLink: AgentPhoneUserLink | null;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    switch (args.command) {
      case "connect": {
        await handleConnectCommand(
          {
            db: args.db,
            event: args.event,
            userLink: args.userLink,
          },
          signal,
        );
        return true;
      }
      case "disconnect": {
        await handleDisconnectCommand(
          {
            db: args.db,
            event: args.event,
            userLink: args.userLink,
          },
          signal,
        );
        return true;
      }
      case "help": {
        await sendAgentPhoneSlashCommandText(
          args.event,
          formatHelpMessage(),
          args.db,
          signal,
        );
        return true;
      }
      case "model": {
        if (!args.userLink) {
          await sendConnectPrompt(
            args.event,
            { slashCommand: true },
            args.db,
            signal,
          );
          return true;
        }
        await set(
          handleModelCommand$,
          {
            db: args.db,
            event: args.event,
            userLinkId: args.userLink.id,
            orgId: args.userLink.orgId,
            userId: args.userLink.userId,
          },
          signal,
        );
        return true;
      }
      default: {
        return false;
      }
    }
  },
);

const handleAgentPhoneCommandIfPresent$ = command(
  async (
    { set },
    args: {
      readonly db: Db;
      readonly event: AgentPhoneMessageEvent;
      readonly userLink: AgentPhoneUserLink | null;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const commandText = parseAgentPhoneCommand(args.event.body);
    if (commandText === undefined) {
      return false;
    }

    if (
      await blockUnauthorizedGroupAccountCommand(
        {
          db: args.db,
          event: args.event,
          commandText,
          userLink: args.userLink,
        },
        signal,
      )
    ) {
      return true;
    }

    return set(
      dispatchAgentPhoneCommand$,
      {
        db: args.db,
        command: commandText,
        event: args.event,
        userLink: args.userLink,
      },
      signal,
    );
  },
);

function agentPhoneChatMessageId(args: {
  readonly event: AgentPhoneMessageEvent;
  readonly userLinkId: string;
  readonly rootMessageId: string;
}): string {
  return uuidv5(
    [args.userLinkId, args.rootMessageId, args.event.messageId].join(":"),
    AGENTPHONE_CHAT_MESSAGE_ID_NAMESPACE,
  );
}

function agentPhoneInputFiles(
  event: AgentPhoneMessageEvent,
  userLinkId: string,
): readonly IntegrationInputFile[] {
  const mediaUrl = event.mediaUrl;
  return mediaUrl
    ? [
        {
          sourceId: event.messageId,
          filename: agentPhoneFilenameFromMediaUrl(mediaUrl, event.messageId),
          provenance: {
            provider: "agentphone",
            installationId: userLinkId,
            messageId: event.messageId,
            externalFileId: createHash("sha256").update(mediaUrl).digest("hex"),
          },
          download: (downloadSignal) => {
            if (safeUrlParse(mediaUrl)?.protocol !== "https:") {
              throw new InputFileImportError(
                "invalid-url",
                "Phone media URL must use HTTPS",
              );
            }
            return fetch(mediaUrl, { signal: downloadSignal });
          },
        },
      ]
    : [];
}

type PersistedAgentPhoneChatMessage =
  | {
      readonly inserted: true;
      readonly chatThreadId: string;
      readonly chatEventId: string;
    }
  | { readonly inserted: false };

const persistAgentPhoneChatMessage$ = command(
  async (
    { set },
    args: {
      readonly db: Db;
      readonly userLink: AgentPhoneUserLink;
      readonly agent: WorkspaceAgent;
      readonly event: AgentPhoneMessageEvent;
      readonly rootMessageId: string;
      readonly prompt: string;
      readonly threadContext: string;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<PersistedAgentPhoneChatMessage> => {
    const currentTime = new Date(args.apiStartTime);
    const route = await set(
      ensureAgentPhoneChatThreadRoute$,
      {
        initialModel: await set(
          resolveDefaultModelFirstPin$,
          {
            orgId: args.userLink.orgId,
            userId: args.userLink.userId,
            orgPlanCapabilities: undefined,
          },
          signal,
        ),
        agentphoneUserLinkId: args.userLink.id,
        rootMessageId: args.rootMessageId,
        conversationId: args.event.conversationId,
        userId: args.userLink.userId,
        orgId: args.userLink.orgId,
        agentId: args.agent.composeId,
        currentTime,
      },
      signal,
    );
    signal.throwIfAborted();

    const chatEventId = agentPhoneChatMessageId({
      event: args.event,
      userLinkId: args.userLink.id,
      rootMessageId: args.rootMessageId,
    });
    const assets = await set(
      materializeIntegrationInputAssets$,
      {
        userId: args.userLink.userId,
        orgId: args.userLink.orgId,
        chatThreadId: route.chatThreadId,
        files: agentPhoneInputFiles(args.event, args.userLink.id),
      },
      signal,
    );
    const canonicalAsset = readyIntegrationInputAsset(
      assets,
      args.event.messageId,
    );
    const prompt = canonicalAsset
      ? [args.event.body.trim(), canonicalInputFilePrompt(canonicalAsset)]
          .filter(Boolean)
          .join("\n\n")
      : args.prompt;
    const values = {
      id: chatEventId,
      chatThreadId: route.chatThreadId,
      eventType: "input.prompt",
      modelSelection: await set(
        resolveEnqueuedChatInputModel$,
        {
          threadId: route.chatThreadId,
          orgId: args.userLink.orgId,
          userId: args.userLink.userId,
        },
        signal,
      ),
      userMessage: createUserMessageDocument({
        text: canonicalAsset ? args.event.body.trim() : args.prompt,
        files: integrationInputMessageFiles(assets),
        nonContentPart: createChatEventSourcePart({
          kind: "agentphone",
          toNumber: normalizeAgentPhoneHandle(args.event.toNumber, "sms"),
          isGroup: args.event.isGroup,
        }),
      }),
      runId: null,
      agentphoneContext: {
        messageText: prompt,
        threadContext: args.threadContext,
        messageId: args.event.messageId,
        rootMessageId: args.rootMessageId,
        conversationId: args.event.conversationId,
        groupId: args.event.groupId,
        channel: args.event.channel,
        isGroup: isAgentPhoneGroupEvent(args.event),
        phoneHandle: args.event.fromNumber,
        fromNumber: args.event.fromNumber,
        toNumber: args.event.toNumber,
        userLinkId: args.userLink.id,
        agentphoneAgentId: args.event.agentphoneAgentId,
      },
      createdAt: currentTime,
    } as const;
    const eventId = await set(
      enqueueIntegrationChatInput$,
      { orgId: args.userLink.orgId, input: values },
      signal,
    );
    signal.throwIfAborted();
    if (eventId === null) {
      return { inserted: false };
    }
    return { inserted: true, chatThreadId: route.chatThreadId, chatEventId };
  },
);

const replyAgentPhoneChatQueueWait$ = command(
  async (
    { set },
    event: AgentPhoneMessageEvent,
    reason: ChatQueueWaitReason,
    signal: AbortSignal,
  ): Promise<void> => {
    const notice = chatQueueWaitNotice(reason);
    if (notice) {
      await sendAgentPhoneText(event, notice, set(writeDb$), signal);
    }
  },
);

const runAgentForAgentPhone$ = command(
  async (
    { set },
    args: {
      readonly db: Db;
      readonly userLink: AgentPhoneUserLink;
      readonly agent: WorkspaceAgent;
      readonly event: AgentPhoneMessageEvent;
      readonly rootMessageId: string;
      readonly prompt: string;
      readonly threadContext: string;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const persisted = await set(
      persistAgentPhoneChatMessage$,
      {
        ...args,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!persisted.inserted) {
      return;
    }

    waitUntil(
      (async () => {
        const picked = await settle(
          set(
            pickEnqueuedChatThread$,
            {
              orgId: args.userLink.orgId,
              chatThreadId: persisted.chatThreadId,
            },
            signal,
          ),
        );
        await set(
          touchNativeChatThread$,
          {
            chatThreadId: persisted.chatThreadId,
            createdAt: new Date(args.apiStartTime),
            eventId: persisted.chatEventId,
          },
          signal,
        );
        await publishThreadListChangedSafely({
          userId: args.userLink.userId,
          orgId: args.userLink.orgId,
        });
        await publishChatThreadMessageCreatedSafely({
          userId: args.userLink.userId,
          orgId: args.userLink.orgId,
          threadId: persisted.chatThreadId,
        });
        const noticed = await settle(
          (async () => {
            const pick = await set(
              enqueuedChatQueueWaitReason$,
              {
                orgId: args.userLink.orgId,
                chatThreadId: persisted.chatThreadId,
                eventId: persisted.chatEventId,
              },
              signal,
            );
            await set(
              replyAgentPhoneChatQueueWait$,
              args.event,
              pick.reason,
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
      set(notifyRunningChatRunOfPendingInput$, persisted.chatThreadId, signal),
    );
  },
);

export const handleAgentPhoneMessage$ = command(
  async (
    { set },
    params: {
      readonly event: AgentPhoneMessageEvent;
      readonly userLink: AgentPhoneUserLink | null;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    if (shouldIgnoreAgentPhoneGroupMessage(params.event)) {
      return;
    }

    if (
      await set(
        handleAgentPhoneCommandIfPresent$,
        {
          db,
          event: params.event,
          userLink: params.userLink,
        },
        signal,
      )
    ) {
      return;
    }

    const userLink = params.userLink;
    if (!userLink) {
      if (isAgentPhoneGroupEvent(params.event)) {
        await sendGroupConnectInDmPrompt(params.event, db, signal);
        return;
      }

      await sendConnectPrompt(params.event, undefined, db, signal);
      return;
    }

    const agent = await resolveAgentPhoneAgent(db, userLink);
    signal.throwIfAborted();
    if (!agent) {
      await sendAgentPhoneText(
        params.event,
        `The workspace default agent is not configured. Please choose an agent in ${BRAND_PRESENTATION.brandName} first.`,
        db,
        signal,
      );
      return;
    }

    await refreshTypingIfSupported(params.event, signal);
    signal.throwIfAborted();

    const isGroup = isAgentPhoneGroupEvent(params.event);
    const rootMessageId = agentPhoneChatRouteRootMessageId(params.event);
    const userLinkId = userLink.id;
    const { executionContext } = await loadOptionalChatEnrichment(
      "agentphone",
      () => {
        return fetchAgentPhoneContext(db, {
          userLinkId,
          userId: userLink.userId,
          orgId: userLink.orgId,
          phoneHandle: params.event.fromNumber,
          channel: params.event.channel,
          conversationId: params.event.conversationId,
          groupId: params.event.groupId,
          agentphoneAgentId: params.event.agentphoneAgentId,
          isGroup,
          recentHistory: params.event.recentHistory,
          currentMessageId: params.event.messageId,
        });
      },
      () => {
        return { executionContext: "" };
      },
      signal,
    );
    signal.throwIfAborted();

    const prompt = enrichAgentPhonePrompt({
      prompt: params.event.body,
      messageId: params.event.messageId,
      mediaUrl: params.event.mediaUrl,
    });

    await set(
      runAgentForAgentPhone$,
      {
        db,
        userLink,
        agent,
        rootMessageId,
        prompt,
        threadContext: executionContext,
        event: params.event,
        apiStartTime: params.apiStartTime,
      },
      signal,
    );
    signal.throwIfAborted();
  },
);

export async function publishAgentPhoneUserChanged(
  userId: string,
): Promise<void> {
  await publishUserSignal([userId], "agentphone:changed");
}

/** A new link may also have completed the Get started iMessage quest. */
export async function publishAgentPhoneUserLinked(
  userId: string,
): Promise<void> {
  await publishAgentPhoneUserChanged(userId);
  await publishUserSignal([userId], GET_STARTED_REWARDS_CHANGED_EVENT);
}
