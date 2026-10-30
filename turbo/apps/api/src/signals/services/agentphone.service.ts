import { INTEGRATION_SETTINGS_PATHS } from "@okouai/core/integration-routes";
import { GET_STARTED_REWARDS_CHANGED_EVENT } from "@okouai/api-contracts/contracts/get-started";
import { BRAND_PRESENTATION } from "@okouai/core/brand-presentation";
import { agents } from "@okouai/db/schema/agent";
import { agentphoneGroupMessageReceipts } from "@okouai/db/schema/agentphone-group-message-receipt";
import { agentphoneMessages } from "@okouai/db/schema/agentphone-message";
import { agentphoneMessageVisibility } from "@okouai/db/schema/agentphone-message-visibility";
import { agentphoneUserLinks } from "@okouai/db/schema/agentphone-user-link";
import { command } from "ccstate";
import {
  and,
  desc,
  eq,
  exists,
  inArray,
  isNull,
  lte,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { v5 as uuidv5 } from "uuid";
import { pgBooleanDecoder } from "../../lib/db-structured-result";
import { env } from "../../lib/env";
import { INTEGRATION_DM_SESSION_KEY } from "../../lib/integration-dm-session";
import { inferMimetype } from "../../lib/mimetype";
import { now, nowDate } from "../../lib/time";
import { waitUntil } from "../context/wait-until";
import {
  isAgentPhoneApiError,
  sendAgentPhoneMessage,
} from "../external/agentphone-client";
import { db$, writeDb$ } from "../external/db";
import { clerk$, isClerkResourceNotFound } from "../external/clerk";
import {
  publishChatThreadMessageCreatedSafely,
  publishThreadListChangedSafely,
  publishUserSignal,
} from "../external/realtime";
import { safeUrlParse, settle, tapError } from "../utils";
import {
  AGENTPHONE_TYPING_REQUEST_TIMEOUT_MS,
  sendAgentPhoneRunTyping,
} from "./agentphone-run-typing.service";
import {
  ensureAgentPhoneChatThreadRoute$,
  resolveAgentPhoneGroupChatRoot$,
} from "./agentphone-chat-ingress.service";
import {
  agentPhoneChannelForLinkedHandle,
  agentPhoneUserLinksForChannel,
  agentPhoneMessageLinkColumn,
  agentPhoneReplyChunks,
  agentPhoneReplyDestination,
  describeAgentPhoneHandleShape,
  isAgentPhoneChannel,
  isValidAgentPhoneHandle,
  normalizeAgentPhoneHandle,
  resolveAgentPhoneConversationVisibilityRecipients$,
  resolveOrgDefaultComposeId$,
  storeOutboundAgentPhoneMessage$,
  type AgentPhoneChannel,
  type AgentPhoneUserLink,
} from "./agentphone-shared.service";
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
  canonicalInputFilePrompt,
  integrationInputMessageFiles,
  materializeIntegrationInputAssets$,
  readyIntegrationInputAsset,
  type IntegrationInputFile,
} from "./integration-input-assets.service";
import { resolveDefaultModelFirstPin$ } from "./model-selection.service";
import { touchNativeChatThread$ } from "./native-chat-event-write.service";
import { loadOptionalChatEnrichment } from "./queued-launch-enrichment.service";
const MAX_CONNECT_AGE_SECONDS = 600;
const MAX_WEBHOOK_AGE_SECONDS = 300;
const SIGNATURE_PREFIX = "sha256=";
const MAX_CONTEXT_MESSAGES = 10;
const AGENTPHONE_SMS_MMS_SLASH_COMMAND_RISK_MESSAGE =
  "Note: SMS and MMS replies may not be delivered reliably. For the most reliable experience, use iMessage with this number.";
const AGENTPHONE_GROUP_ACCOUNT_COMMAND_MESSAGE =
  "Only the linked sender can disconnect or switch accounts. Message this number directly to manage your link.";
const AGENTPHONE_CHAT_MESSAGE_ID_NAMESPACE =
  "3208d609-59a7-4b0e-9c3b-3db20e9c924f";

export {
  agentPhoneChannelForLinkedHandle,
  describeAgentPhoneHandleShape,
  isAgentPhoneChannel,
  isValidAgentPhoneHandle,
  normalizeAgentPhoneHandle,
  storeOutboundAgentPhoneMessage$,
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
  readonly replyToMessageId: string | null;
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

const agentPhoneChatRouteRootMessageId$ = command(
  async (
    { set },
    event: AgentPhoneMessageEvent,
    userLinkId: string,
    signal: AbortSignal,
  ): Promise<string> => {
    if (!isAgentPhoneGroupEvent(event)) {
      return INTEGRATION_DM_SESSION_KEY;
    }
    if (!event.conversationId) {
      throw new Error("AgentPhone group message is missing a conversation id");
    }
    return await set(
      resolveAgentPhoneGroupChatRoot$,
      {
        userLinkId,
        conversationId: event.conversationId,
        replyToMessageId: event.replyToMessageId,
      },
      signal,
    );
  },
);

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
    (commandName === "disconnect" || commandName === "switch")
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
  const pathname =
    params.channel === "whatsapp"
      ? INTEGRATION_SETTINGS_PATHS.whatsapp
      : INTEGRATION_SETTINGS_PATHS.agentphone;
  return `${env("APP_URL")}${pathname}?${query.toString()}`;
}

function inboundAgentPhoneMessageValues(
  event: AgentPhoneMessageEvent,
  userLinkId: string | null | undefined,
) {
  const isGroup = isAgentPhoneGroupEvent(event);
  return {
    webhookId: event.webhookId,
    agentphoneMessageId: event.messageId,
    conversationId: event.conversationId,
    groupId: isGroup ? event.groupId : null,
    agentphoneAgentId: event.agentphoneAgentId,
    agentphoneUserLinkId:
      event.channel === "whatsapp" ? null : (userLinkId ?? null),
    whatsappUserLinkId:
      event.channel === "whatsapp" ? (userLinkId ?? null) : null,
    phoneHandle: normalizeAgentPhoneHandle(event.fromNumber, event.channel),
    fromNumber: normalizeAgentPhoneHandle(
      event.senderIdentifier ?? event.fromNumber,
      event.channel,
    ),
    toNumber: event.groupId ?? normalizeAgentPhoneHandle(event.toNumber, "sms"),
    direction: "inbound",
    channel: event.channel,
    body: event.body || null,
    mediaUrl: event.mediaUrl,
    isBot: false,
    receivedAt: event.receivedAt,
  };
}

function agentPhoneGroupParticipantHandles(participants: readonly string[]) {
  return [
    ...new Set(
      participants
        .map((handle) => {
          return normalizeAgentPhoneHandle(handle, "imessage");
        })
        .filter((handle) => {
          return isValidAgentPhoneHandle(handle, "imessage");
        }),
    ),
  ];
}

export const storeInboundAgentPhoneMessage$ = command(
  async (
    { set },
    params: {
      readonly event: AgentPhoneMessageEvent;
      readonly userLinkId?: string | null;
    },
    signal: AbortSignal,
  ): Promise<{ readonly inserted: boolean; readonly dispatch: boolean }> => {
    signal.throwIfAborted();
    const db = set(writeDb$);
    const event = params.event;
    const isGroup = isAgentPhoneGroupEvent(event);
    const values = inboundAgentPhoneMessageValues(event, params.userLinkId);
    if (!isGroup) {
      const [inserted] = await db
        .insert(agentphoneMessages)
        .values(values)
        .onConflictDoNothing()
        .returning({ id: agentphoneMessages.id });
      signal.throwIfAborted();
      return { inserted: Boolean(inserted), dispatch: Boolean(inserted) };
    }

    const receivedAt = event.receivedAt;
    if (receivedAt === null) {
      throw new Error("AgentPhone group message is missing receivedAt");
    }
    const existingConditions = [
      eq(agentphoneMessages.agentphoneMessageId, event.messageId),
    ];
    if (event.webhookId) {
      existingConditions.push(
        eq(agentphoneMessages.webhookId, event.webhookId),
      );
    }
    const existingMessage = db
      .select({ id: agentphoneMessages.id })
      .from(agentphoneMessages)
      .where(or(...existingConditions));
    const receipt = db.$with("accepted_receipt").as(
      db
        .insert(agentphoneGroupMessageReceipts)
        .select(
          sql`SELECT ${event.messageId}, ${event.webhookId}
          WHERE ${notExists(existingMessage)}`,
        )
        .onConflictDoNothing()
        .returning({
          agentphoneMessageId:
            agentphoneGroupMessageReceipts.agentphoneMessageId,
        }),
    );
    const handles = agentPhoneGroupParticipantHandles(event.participants);
    const recipients = db.$with("eligible_recipients").as(
      db
        .selectDistinct({
          orgId: agentphoneUserLinks.orgId,
          userId: agentphoneUserLinks.userId,
        })
        .from(agentphoneUserLinks)
        .where(
          and(
            inArray(agentphoneUserLinks.phoneHandle, handles),
            lte(agentphoneUserLinks.createdAt, receivedAt),
            exists(db.select().from(receipt)),
          ),
        ),
    );
    // INSERT SELECT needs every schema column in order in Drizzle 0.45.2.
    // The receipt gates the message, and the message's returned id gates grants.
    const message = db.$with("inserted_message").as(
      db
        .insert(agentphoneMessages)
        .select(
          sql`SELECT gen_random_uuid(),
          ${values.webhookId}, ${values.agentphoneMessageId},
          ${values.conversationId}, ${values.groupId}, ${values.agentphoneAgentId},
          ${values.agentphoneUserLinkId}, ${values.phoneHandle},
          ${values.whatsappUserLinkId},
          ${values.fromNumber}, ${values.toNumber}, ${values.direction},
          ${values.channel}, ${values.body}, ${values.mediaUrl}, ${values.isBot},
          ${sql.param(receivedAt, agentphoneMessages.receivedAt)}, now()
          FROM ${receipt}
          WHERE ${exists(db.select().from(recipients))}`,
        )
        .onConflictDoNothing()
        .returning({ id: agentphoneMessages.id }),
    );
    const visibility = db.$with("inserted_visibility").as(
      db
        .insert(agentphoneMessageVisibility)
        .select(
          db
            .select({
              messageId: message.id,
              orgId: recipients.orgId,
              userId: recipients.userId,
            })
            .from(message)
            .crossJoin(recipients),
        )
        .onConflictDoNothing()
        .returning({ messageId: agentphoneMessageVisibility.messageId }),
    );
    const inserted = exists(db.select().from(message));
    // A receipt without eligible recipients is retained for privacy and replay,
    // while the new event still reaches the normal unlinked-sender dispatch path.
    const [result] = await db
      .with(receipt, recipients, message, visibility)
      .select({
        inserted: inserted.mapWith(pgBooleanDecoder),
        receiptAccepted: exists(db.select().from(receipt)).mapWith(
          pgBooleanDecoder,
        ),
        hasRecipients: exists(db.select().from(recipients)).mapWith(
          pgBooleanDecoder,
        ),
      })
      .from(sql`(SELECT 1) AS outcome`);
    signal.throwIfAborted();
    if (!result) {
      throw new Error("AgentPhone inbound persistence returned no outcome");
    }
    return {
      inserted: result.inserted,
      dispatch:
        result.inserted || (result.receiptAccepted && !result.hasRecipients),
    };
  },
);

const resolveAgentPhoneAgent$ = command(
  async (
    { get, set },
    userLink: AgentPhoneUserLink,
  ): Promise<WorkspaceAgent | undefined> => {
    const db = get(db$);
    const composeId = await set(resolveOrgDefaultComposeId$, userLink.orgId);
    if (!composeId) {
      return undefined;
    }

    return (
      (await (async (): Promise<WorkspaceAgent | null> => {
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
      })()) ?? undefined
    );
  },
);

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

const fetchAgentPhoneContext$ = command(
  async (
    { get },
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
  ): Promise<{ readonly executionContext: string }> => {
    const db = get(db$);
    const phoneHandle = normalizeAgentPhoneHandle(
      params.phoneHandle,
      params.channel,
    );
    // WhatsApp context comes only from messages archived under the current
    // verified link. Provider history can predate a workspace rebind.
    const providerContext =
      params.isGroup || params.channel === "whatsapp"
        ? ""
        : formatAgentPhoneRecentHistoryContext(
            params.recentHistory.filter((message) => {
              return params.channel === "whatsapp"
                ? message.channel?.trim().toLowerCase() === "whatsapp"
                : message.channel?.trim().toLowerCase() !== "whatsapp";
            }),
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
                eq(
                  agentPhoneMessageLinkColumn(params.channel),
                  params.userLinkId,
                ),
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
        channel: params.channel,
      }),
    };
  },
);

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
  readonly channel: AgentPhoneChannel;
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

  return buildAgentPhoneContextBlock(formatted, params.isGroup, params.channel);
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
  channel?: AgentPhoneChannel,
): string {
  return [
    channel === "whatsapp"
      ? "# WhatsApp Message Context"
      : "# Phone Message Context",
    "",
    isGroup
      ? "The messages below are from an iMessage group conversation with the shared phone number. Messages closer to RELATIVE_INDEX 0 are more recent."
      : `The messages below are from the user's ${channel === "whatsapp" ? "WhatsApp" : "text message"} conversation with the shared phone number. Messages closer to RELATIVE_INDEX 0 are more recent.`,
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

export const sendAgentPhoneText$ = command(
  async (
    { get, set },
    event: AgentPhoneMessageEvent,
    body: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const isGroup = isAgentPhoneGroupEvent(event);
    if (isGroup && !event.conversationId) {
      throw new Error("AgentPhone group reply is missing a conversation id");
    }
    const visibilityRecipients = isGroup
      ? await set(
          resolveAgentPhoneConversationVisibilityRecipients$,
          event.conversationId!,
          nowDate(),
          signal,
        )
      : [];
    signal.throwIfAborted();
    const links = agentPhoneUserLinksForChannel(event.channel);
    const [userLink] =
      isGroup || event.channel !== "whatsapp"
        ? []
        : await get(db$)
            .select()
            .from(links)
            .where(
              eq(
                links.phoneHandle,
                normalizeAgentPhoneHandle(event.fromNumber, event.channel),
              ),
            )
            .limit(1);
    signal.throwIfAborted();
    for (const chunk of agentPhoneReplyChunks(body, event.channel)) {
      const sent = await sendAgentPhoneMessage(
        {
          ...(event.channel === "whatsapp"
            ? { channel: "whatsapp" as const }
            : {}),
          agentphoneAgentId: event.agentphoneAgentId,
          toNumber: agentPhoneReplyDestination({
            isGroup,
            groupId: event.groupId,
            phoneHandle: event.fromNumber,
          }),
          ...(event.channel === "imessage" || event.channel === "whatsapp"
            ? { replyToMessageId: event.messageId }
            : {}),
          body: chunk,
        },
        signal,
      );
      signal.throwIfAborted();

      if (isGroup || userLink) {
        await set(storeOutboundAgentPhoneMessage$, {
          agentphoneMessageId: sent.id,
          conversationId: event.conversationId,
          groupId: isGroup ? event.groupId : null,
          agentphoneAgentId: event.agentphoneAgentId,
          userLinkId: userLink?.id,
          phoneHandle: event.fromNumber,
          fromNumber: event.toNumber,
          toNumber: sent.toNumber,
          body: chunk,
          channel: event.channel,
          userChannel: event.channel,
          visibilityRecipients,
        });
      }
    }
  },
);

const sendAgentPhoneSlashCommandText$ = command(
  async (
    { set },
    event: AgentPhoneMessageEvent,
    body: string,
    signal: AbortSignal,
  ): Promise<void> => {
    await set(
      sendAgentPhoneText$,
      event,
      appendAgentPhoneSlashCommandRiskWarning(body, event.channel),
      signal,
    );
  },
);

function formatConnectPrompt(
  event: AgentPhoneMessageEvent,
  action: "link" | "reply" = "link",
): string {
  const { brandName } = BRAND_PRESENTATION;
  const nextStep =
    action === "reply"
      ? `Reply here and I'll send you the link to connect your ${brandName} account.`
      : `Click the link below to start using ${brandName}.\n\n${buildAgentPhoneConnectUrl(
          {
            phoneHandle: event.fromNumber,
            agentphoneAgentId: event.agentphoneAgentId,
            secret: env("SECRETS_ENCRYPTION_KEY"),
            channel: event.channel,
          },
        )}`;

  return [
    `Hi, I'm ${brandName}.`,
    "",
    "You can text me like a teammate and I'll actually do the work: research something, draft and send emails, summarize long documents, update spreadsheets, triage tickets, post to Slack, dig through your GitHub or Notion, and a lot more.",
    "",
    "I'm most useful once I'm connected to the tools you already use — GitHub, Gmail, Notion, Google Drive / Sheets / Docs / Calendar, Slack, Sentry, X, and 100+ others.",
    "",
    nextStep,
  ].join("\n");
}

function formatHelpMessage(channel: AgentPhoneChannel): string {
  const { brandName } = BRAND_PRESENTATION;
  const account = channel === "whatsapp" ? "WhatsApp account" : "phone number";
  return [
    `${brandName} ${channel === "whatsapp" ? "WhatsApp" : "text message"} commands`,
    "",
    `/connect - Connect this ${account} to ${brandName}`,
    `/disconnect - Disconnect this ${account} from ${brandName}`,
    `/switch - Switch to a different ${brandName} account or workspace`,
    "/help - Show these commands",
    "",
    "Send a message here after connecting.",
  ].join("\n");
}

const sendConnectPrompt$ = command(
  async (
    { set },
    event: AgentPhoneMessageEvent,
    options: { readonly slashCommand: boolean } | undefined,
    signal: AbortSignal,
  ): Promise<void> => {
    const body = formatConnectPrompt(event);
    if (isAgentPhoneGroupEvent(event)) {
      // The signed link proves ownership of the sender's handle. Deliver it
      // privately, without replying to a message from the group conversation.
      const recipient = {
        agentphoneAgentId: event.agentphoneAgentId,
        toNumber: normalizeAgentPhoneHandle(event.fromNumber, event.channel),
      };
      const sent = await settle(
        sendAgentPhoneMessage(
          {
            ...recipient,
            body,
          },
          signal,
        ),
        signal,
      );
      let groupNotice =
        "Please message this number directly to get your connection link.";
      if (sent.ok) {
        groupNotice = `I've sent you a private connection link. Open it and click Connect to link your number to ${BRAND_PRESENTATION.brandName}, then mention me here to start chatting.`;
      } else if (
        isAgentPhoneApiError(sent.error) &&
        sent.error.status === 422 &&
        sent.error.code === "CONVERSATION_CONTENT_RESTRICTED"
      ) {
        // Only a confirmed content rejection permits another send. A timeout
        // or server error can leave the first message's outcome unknown.
        const greeting = await settle(
          sendAgentPhoneMessage(
            {
              ...recipient,
              body: formatConnectPrompt(event, "reply"),
            },
            signal,
          ),
          signal,
        );
        if (greeting.ok) {
          groupNotice =
            "I've sent you a private message. Please reply there so I can send you your connection link.";
        }
      }
      await set(sendAgentPhoneText$, event, groupNotice, signal);
      return;
    }
    await set(
      sendAgentPhoneText$,
      event,
      options?.slashCommand
        ? appendAgentPhoneSlashCommandRiskWarning(body, event.channel)
        : body,
      signal,
    );
  },
);

const sendGroupAccountCommandBlockedMessage$ = command(
  async (
    { set },
    event: AgentPhoneMessageEvent,
    signal: AbortSignal,
  ): Promise<void> => {
    await set(
      sendAgentPhoneText$,
      event,
      AGENTPHONE_GROUP_ACCOUNT_COMMAND_MESSAGE,
      signal,
    );
  },
);

const blockUnauthorizedGroupAccountCommand$ = command(
  async (
    { set },
    args: {
      readonly event: AgentPhoneMessageEvent;
      readonly commandText: string | undefined;
      readonly userLink: AgentPhoneUserLink | null;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (
      !isAgentPhoneGroupAccountCommand(args.event, args.commandText) ||
      args.userLink
    ) {
      return false;
    }

    await set(sendGroupAccountCommandBlockedMessage$, args.event, signal);
    return true;
  },
);

const handleConnectCommand$ = command(
  async (
    { get, set },
    args: {
      readonly event: AgentPhoneMessageEvent;
      readonly userLink: AgentPhoneUserLink | null;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    if (args.userLink) {
      const { brandName } = BRAND_PRESENTATION;
      let body = `You are already connected. Send a message here to start using ${brandName}.`;
      if (!isAgentPhoneGroupEvent(args.event)) {
        const workspace = await settle(
          get(clerk$).organizations.getOrganization(
            { organizationId: args.userLink.orgId },
            undefined,
            signal,
          ),
          signal,
        );
        signal.throwIfAborted();
        if (!workspace.ok && !isClerkResourceNotFound(workspace.error)) {
          throw workspace.error;
        }
        body = workspace.ok
          ? `You are already connected to workspace "${workspace.value.name}". Send a message here to start using ${brandName}. Send /switch to change accounts or workspaces, or /disconnect to disconnect.`
          : "The workspace connected to this account is no longer available. Send /switch to connect a different account or workspace.";
      }
      await set(sendAgentPhoneSlashCommandText$, args.event, body, signal);
      return;
    }
    await set(sendConnectPrompt$, args.event, { slashCommand: true }, signal);
  },
);

const disconnectAgentPhoneUserLink$ = command(
  async (
    { set },
    args: {
      readonly userLink: AgentPhoneUserLink;
      readonly channel: AgentPhoneChannel;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const links = agentPhoneUserLinksForChannel(args.channel);
    await set(writeDb$).delete(links).where(eq(links.id, args.userLink.id));
    signal.throwIfAborted();
    await publishAgentPhoneUserChanged(args.userLink.userId);
    signal.throwIfAborted();
  },
);

const handleDisconnectCommand$ = command(
  async (
    { set },
    args: {
      readonly event: AgentPhoneMessageEvent;
      readonly userLink: AgentPhoneUserLink | null;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    if (!args.userLink) {
      await set(
        sendAgentPhoneSlashCommandText$,
        args.event,
        `${args.event.channel === "whatsapp" ? "This WhatsApp account" : "Error: This phone number"} is not connected. Send /connect to connect it.`,
        signal,
      );
      return;
    }

    await set(
      disconnectAgentPhoneUserLink$,
      { userLink: args.userLink, channel: args.event.channel },
      signal,
    );

    await set(
      sendAgentPhoneSlashCommandText$,
      args.event,
      `This ${args.event.channel === "whatsapp" ? "WhatsApp account" : "phone number"} has been disconnected from ${BRAND_PRESENTATION.brandName}. Send /connect to connect again.`,
      signal,
    );
  },
);

const handleSwitchCommand$ = command(
  async (
    { set },
    args: {
      readonly event: AgentPhoneMessageEvent;
      readonly userLink: AgentPhoneUserLink | null;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    if (isAgentPhoneGroupEvent(args.event)) {
      await set(
        sendAgentPhoneSlashCommandText$,
        args.event,
        "To switch accounts or workspaces, message this number directly in a 1:1 iMessage conversation and send /switch.",
        signal,
      );
      return;
    }

    if (args.userLink) {
      await set(
        disconnectAgentPhoneUserLink$,
        { userLink: args.userLink, channel: args.event.channel },
        signal,
      );
    }
    const connectInstructions = [
      `Open this link to connect to the ${BRAND_PRESENTATION.brandName} account and workspace you want to use:`,
      "",
      buildAgentPhoneConnectUrl({
        phoneHandle: args.event.fromNumber,
        agentphoneAgentId: args.event.agentphoneAgentId,
        secret: env("SECRETS_ENCRYPTION_KEY"),
        channel: args.event.channel,
      }),
    ].join("\n");
    await set(
      sendAgentPhoneSlashCommandText$,
      args.event,
      [
        ...(args.userLink
          ? [
              `Your ${args.event.channel === "whatsapp" ? "WhatsApp account" : "phone"} has been disconnected.`,
              "",
            ]
          : []),
        connectInstructions,
      ].join("\n"),
      signal,
    );
  },
);

const dispatchAgentPhoneCommand$ = command(
  async (
    { set },
    args: {
      readonly command: string | undefined;
      readonly event: AgentPhoneMessageEvent;
      readonly userLink: AgentPhoneUserLink | null;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    switch (args.command) {
      case "connect": {
        await set(
          handleConnectCommand$,
          {
            event: args.event,
            userLink: args.userLink,
          },
          signal,
        );
        return true;
      }
      case "disconnect": {
        await set(
          handleDisconnectCommand$,
          {
            event: args.event,
            userLink: args.userLink,
          },
          signal,
        );
        return true;
      }
      case "switch": {
        await set(
          handleSwitchCommand$,
          { event: args.event, userLink: args.userLink },
          signal,
        );
        return true;
      }
      case "help": {
        await set(
          sendAgentPhoneSlashCommandText$,
          args.event,
          formatHelpMessage(args.event.channel),
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
      await set(
        blockUnauthorizedGroupAccountCommand$,
        {
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
          resource: { provider: "agentphone", url: mediaUrl },
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
        channel: args.event.channel,
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
    const enqueuedModel = await set(
      resolveEnqueuedChatInputModel$,
      {
        threadId: route.chatThreadId,
        orgId: args.userLink.orgId,
        userId: args.userLink.userId,
      },
      signal,
    );
    const values = {
      id: chatEventId,
      chatThreadId: route.chatThreadId,
      eventType: "input.prompt",
      modelSelection: enqueuedModel.modelSelection,
      userMessage: createUserMessageDocument({
        text: canonicalAsset ? args.event.body.trim() : args.prompt,
        files: integrationInputMessageFiles(assets),
        nonContentPart: createChatEventSourcePart({
          kind: "agentphone",
          channel: args.event.channel,
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
      {
        orgId: args.userLink.orgId,
        input: values,
        threadModelReplacement: enqueuedModel.threadModelReplacement,
      },
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
      await set(sendAgentPhoneText$, event, notice, signal);
    }
  },
);

const runAgentForAgentPhone$ = command(
  async (
    { set },
    args: {
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
    if (shouldIgnoreAgentPhoneGroupMessage(params.event)) {
      return;
    }

    if (
      await set(
        handleAgentPhoneCommandIfPresent$,
        {
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
      await set(sendConnectPrompt$, params.event, undefined, signal);
      return;
    }

    signal.throwIfAborted();
    if (params.event.channel === "imessage" && params.event.conversationId) {
      // Ingress has verified the sender and persisted/deduplicated the message.
      // Start typing before agent/context reads, without delaying run dispatch.
      waitUntil(
        tapError(
          sendAgentPhoneRunTyping(
            {
              conversationId: params.event.conversationId,
              phase: "admission",
              messageId: params.event.messageId,
              apiStartTime: params.apiStartTime,
            },
            AbortSignal.timeout(AGENTPHONE_TYPING_REQUEST_TIMEOUT_MS),
          ),
        ),
      );
    }

    const agent = await set(resolveAgentPhoneAgent$, userLink);
    signal.throwIfAborted();
    if (!agent) {
      await set(
        sendAgentPhoneText$,
        params.event,
        `The workspace default agent is not configured. Please choose an agent in ${BRAND_PRESENTATION.brandName} first.`,
        signal,
      );
      return;
    }

    const isGroup = isAgentPhoneGroupEvent(params.event);
    const rootMessageId = await set(
      agentPhoneChatRouteRootMessageId$,
      params.event,
      userLink.id,
      signal,
    );
    const userLinkId = userLink.id;
    const contextRead = set(fetchAgentPhoneContext$, {
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
    const { executionContext } = await loadOptionalChatEnrichment(
      "agentphone",
      () => {
        return contextRead;
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
