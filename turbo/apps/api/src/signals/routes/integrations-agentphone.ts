import { integrationsAgentPhoneContract } from "@okouai/api-contracts/contracts/integrations-agentphone";
import { agentphoneVerificationSendCooldowns } from "@okouai/db/schema/agentphone-verification-send-cooldown";
import { agentphoneUserLinks } from "@okouai/db/schema/agentphone-user-link";
import {
  PUBLIC_BRAND_PRESENTATION,
  PUBLIC_BRAND,
} from "@okouai/core/public-brand";
import { command, computed } from "ccstate";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { env, optionalEnv } from "../../lib/env";
import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { logger } from "../../lib/log";
import { now } from "../../lib/time";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { request$ } from "../context/hono";
import { waitUntil } from "../context/wait-until";
import { db$, writeDb$, type Db } from "../external/db";
import { sendAgentPhoneMessage } from "../external/agentphone-client";
import type { RouteEntry } from "../route-entry";
import {
  consumeAgentPhoneConnectionCode,
  createAgentPhoneConnectionCode,
  isAgentPhoneConnectionCodeMessage,
  type AgentPhoneConnectionCodeConsumeResult,
} from "../services/agentphone-connection-code.service";
import {
  buildAgentPhoneConnectUrl,
  describeAgentPhoneHandleShape,
  handleAgentPhoneMessage$,
  isAgentPhoneChannel,
  isValidAgentPhoneHandle,
  linkAgentPhoneUser,
  normalizeAgentPhoneHandle,
  publishAgentPhoneUserChanged,
  resolveAgentPhoneUserLinkForEvent,
  sendAgentPhoneText,
  storeInboundAgentPhoneMessage,
  verifyAgentPhoneConnectSignature,
  verifyAgentPhoneWebhook,
  type AgentPhoneRecentHistoryMessage,
  type AgentPhoneChannel,
  type AgentPhoneMessageEvent,
} from "../services/agentphone.service";
import {
  isAgentPhoneMentionText,
  type AgentPhoneUserLink,
} from "../services/agentphone-shared.service";
import { safeJsonParse, tapError } from "../utils";

interface AgentPhoneConfig {
  readonly agentphoneAgentId: string | null;
  readonly agentPhoneNumber: string | null;
  readonly apiBaseUrl: string | null;
  readonly apiKey: string | null;
  readonly configured: boolean;
}

interface ConfiguredAgentPhoneConfig extends AgentPhoneConfig {
  readonly agentphoneAgentId: string;
  readonly apiBaseUrl: string;
  readonly apiKey: string;
}

const agentPhoneAuthOptions = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const VERIFICATION_SEND_COOLDOWN_MS = 60_000;
const log = logger("api:agentphone:link");

const startLinkBody$ = bodyResultOf(integrationsAgentPhoneContract.startLink);
const connectBody$ = bodyResultOf(
  integrationsAgentPhoneContract.connectAgentPhone,
);

const webhookBodySchema = z.record(z.string(), z.unknown());

type VerificationSendCooldownScope = "phone" | "user_org";

interface VerificationSendCooldownKey {
  readonly scope: VerificationSendCooldownScope;
  readonly scopeKey: string;
}

function notConfigured() {
  return {
    status: 503 as const,
    body: {
      error: {
        message: "AgentPhone is not configured",
        code: "NOT_CONFIGURED",
      },
    },
  };
}

function unavailable() {
  return {
    status: 503 as const,
    body: {
      error: {
        message: "AgentPhone verification text could not be sent",
        code: "PROVIDER_UNAVAILABLE",
      },
    },
  };
}

function tooManyVerificationTexts() {
  return {
    status: 429 as const,
    body: {
      error: {
        message:
          "Verification text was just sent. Wait a minute before trying again.",
        code: "TOO_MANY_REQUESTS",
      },
    },
  };
}

function getAgentPhoneConfig(): AgentPhoneConfig {
  const agentphoneAgentId = optionalEnv("AGENTPHONE_AGENT_ID") ?? null;
  const apiBaseUrl = optionalEnv("AGENTPHONE_API_BASE_URL") ?? null;
  const apiKey = optionalEnv("AGENTPHONE_API_KEY") ?? null;
  const agentPhoneNumber = optionalEnv("AGENTPHONE_PHONE_NUMBER") ?? null;

  return {
    agentphoneAgentId,
    agentPhoneNumber,
    apiBaseUrl,
    apiKey,
    configured: Boolean(
      agentphoneAgentId && apiBaseUrl && apiKey && agentPhoneNumber,
    ),
  };
}

function agentPhoneCooldownKeys(params: {
  readonly orgId: string;
  readonly userId: string;
  readonly phoneHandle: string;
}): readonly VerificationSendCooldownKey[] {
  const keys: VerificationSendCooldownKey[] = [
    {
      scope: "phone",
      scopeKey: params.phoneHandle,
    },
    {
      scope: "user_org",
      scopeKey: `${params.orgId}:${params.userId}`,
    },
  ];

  return keys.sort((left, right) => {
    return `${left.scope}:${left.scopeKey}`.localeCompare(
      `${right.scope}:${right.scopeKey}`,
    );
  });
}

function isValidPhoneHandle(value: string): boolean {
  return /^\+[1-9]\d{7,14}$/u.test(value);
}

function maskPhoneHandle(value: string): string {
  const normalized = value.trim().replace(/[^\d+]/gu, "");
  if (normalized.length <= 4) {
    return "[redacted]";
  }
  return `***${normalized.slice(-4)}`;
}

function truncateForLog(value: string): string {
  return value.length > 500 ? `${value.slice(0, 500)}...` : value;
}

async function sendAgentPhoneVerificationMessage(
  params: {
    readonly config: ConfiguredAgentPhoneConfig;
    readonly toNumber: string;
    readonly body: string;
  },
  signal: AbortSignal,
): Promise<boolean> {
  const response = await fetch(`${params.config.apiBaseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      agent_id: params.config.agentphoneAgentId,
      to_number: params.toNumber,
      body: params.body,
    }),
    signal,
  });

  if (!response.ok) {
    log.warn("AgentPhone verification text provider rejected send", {
      agentphoneAgentId: params.config.agentphoneAgentId,
      phoneHandle: maskPhoneHandle(params.toNumber),
      status: response.status,
      statusText: response.statusText,
      body: truncateForLog(
        (await tapError(response.text())) ?? "[unavailable]",
      ),
    });
    return false;
  }

  return true;
}

// `startLink` only ever delivers via SMS, so we hard-code the channel for
// signing. New Platform -> old API compatibility for the full retained rollback
// lifetime, which has no fixed maximum evidenced, keeps the legacy signature
// over Provider identity while new links add a brand-bound signature. Remove it
// with #27750 after the old API is no longer serving or retained for rollback.
const APPS_API_CONNECT_CHANNEL: AgentPhoneChannel = "sms";

const getLinkStatus$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const requestPublicBrand = PUBLIC_BRAND;

  const config = getAgentPhoneConfig();
  const [link] = await get(db$)
    .select()
    .from(agentphoneUserLinks)
    .where(
      and(
        eq(agentphoneUserLinks.userId, auth.userId),
        eq(agentphoneUserLinks.orgId, auth.orgId),
      ),
    )
    .limit(1);

  if (link) {
    return {
      status: 200 as const,
      body: {
        linked: true as const,
        phoneHandle: link.phoneHandle,
        agentPhoneNumber: config.agentPhoneNumber,
        configured: config.configured,
        publicBrand: link.publicBrand,
      },
    };
  }

  return {
    status: 200 as const,
    body: {
      linked: false as const,
      agentPhoneNumber: config.agentPhoneNumber,
      configured: config.configured,
      publicBrand: requestPublicBrand,
    },
  };
});

const createLinkCode$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const config = getAgentPhoneConfig();
  if (!config.configured || !config.agentPhoneNumber) {
    return notConfigured();
  }

  const [currentLink] = await get(db$)
    .select({ id: agentphoneUserLinks.id })
    .from(agentphoneUserLinks)
    .where(
      and(
        eq(agentphoneUserLinks.userId, auth.userId),
        eq(agentphoneUserLinks.orgId, auth.orgId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();

  if (currentLink) {
    return connectConflict("org-linked");
  }

  const code = await createAgentPhoneConnectionCode(set(writeDb$), {
    userId: auth.userId,
    orgId: auth.orgId,
    publicBrand: PUBLIC_BRAND,
    secret: env("SECRETS_ENCRYPTION_KEY"),
  });
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: {
      code: code.code,
      expiresAt: code.expiresAt.toISOString(),
    },
  };
});

const sendAgentPhoneVerificationText$ = command(
  async (
    { set },
    params: {
      readonly config: ConfiguredAgentPhoneConfig;
      readonly cooldownKeys: readonly VerificationSendCooldownKey[];
      readonly phoneHandle: string;
      readonly connectUrl: string;
    },
    signal: AbortSignal,
  ) => {
    const sendResult = await set(writeDb$).transaction(async (tx) => {
      const sentAt = new Date(now());
      const cooldownCutoff = sentAt.getTime() - VERIFICATION_SEND_COOLDOWN_MS;

      for (const key of params.cooldownKeys) {
        await tx
          .insert(agentphoneVerificationSendCooldowns)
          .values({
            scope: key.scope,
            scopeKey: key.scopeKey,
          })
          .onConflictDoNothing();

        const [cooldown] = await tx
          .select({
            lastSentAt: agentphoneVerificationSendCooldowns.lastSentAt,
          })
          .from(agentphoneVerificationSendCooldowns)
          .where(
            and(
              eq(agentphoneVerificationSendCooldowns.scope, key.scope),
              eq(agentphoneVerificationSendCooldowns.scopeKey, key.scopeKey),
            ),
          )
          .for("update")
          .limit(1);
        signal.throwIfAborted();

        if (
          cooldown?.lastSentAt &&
          cooldown.lastSentAt.getTime() > cooldownCutoff
        ) {
          return { ok: false as const, response: tooManyVerificationTexts() };
        }
      }

      const sent =
        (await tapError(
          sendAgentPhoneVerificationMessage(
            {
              config: params.config,
              toNumber: params.phoneHandle,
              body: `Confirm this phone number for ${PUBLIC_BRAND_PRESENTATION.brandName}: ${params.connectUrl}`,
            },
            signal,
          ),
          (error) => {
            log.error("AgentPhone verification text send failed", {
              agentphoneAgentId: params.config.agentphoneAgentId,
              phoneHandle: maskPhoneHandle(params.phoneHandle),
              error,
            });
          },
        )) ?? false;
      signal.throwIfAborted();

      if (!sent) {
        return { ok: false as const, response: unavailable() };
      }

      for (const key of params.cooldownKeys) {
        await tx
          .update(agentphoneVerificationSendCooldowns)
          .set({ lastSentAt: sentAt, updatedAt: sentAt })
          .where(
            and(
              eq(agentphoneVerificationSendCooldowns.scope, key.scope),
              eq(agentphoneVerificationSendCooldowns.scopeKey, key.scopeKey),
            ),
          );
      }

      return { ok: true as const };
    });
    signal.throwIfAborted();

    return sendResult;
  },
);

const startLink$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);

  const bodyResult = await get(startLinkBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const phoneHandle = bodyResult.data.phoneHandle
    .trim()
    .replace(/[^\d+]/gu, "");
  if (!isValidPhoneHandle(phoneHandle)) {
    return badRequestMessage(
      "Enter a phone number with country code, like +1 555 555 1212",
    );
  }

  const config = getAgentPhoneConfig();
  const agentphoneAgentId = config.agentphoneAgentId;
  const apiBaseUrl = config.apiBaseUrl;
  const apiKey = config.apiKey;
  if (!config.configured || !agentphoneAgentId || !apiBaseUrl || !apiKey) {
    return notConfigured();
  }

  const readDb = get(db$);
  const [currentLink] = await readDb
    .select()
    .from(agentphoneUserLinks)
    .where(
      and(
        eq(agentphoneUserLinks.userId, auth.userId),
        eq(agentphoneUserLinks.orgId, auth.orgId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();

  if (currentLink) {
    return connectConflict("org-linked");
  }

  const [existingPhoneLink] = await readDb
    .select()
    .from(agentphoneUserLinks)
    .where(eq(agentphoneUserLinks.phoneHandle, phoneHandle))
    .limit(1);
  signal.throwIfAborted();

  if (existingPhoneLink) {
    return connectConflict("phone-handle-linked");
  }

  const connectUrl = buildAgentPhoneConnectUrl({
    phoneHandle,
    agentphoneAgentId,
    channel: APPS_API_CONNECT_CHANNEL,
    secret: env("SECRETS_ENCRYPTION_KEY"),
  });

  const cooldownKeys = agentPhoneCooldownKeys({
    orgId: auth.orgId,
    userId: auth.userId,
    phoneHandle,
  });
  const sendResult = await set(
    sendAgentPhoneVerificationText$,
    {
      config: {
        ...config,
        agentphoneAgentId,
        apiBaseUrl,
        apiKey,
      },
      cooldownKeys,
      phoneHandle,
      connectUrl,
    },
    signal,
  );

  if (!sendResult.ok) {
    return sendResult.response;
  }

  return {
    status: 200 as const,
    body: { phoneHandle, verificationSent: true as const },
  };
});

const unlink$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);

  const deleted = await set(writeDb$)
    .delete(agentphoneUserLinks)
    .where(
      and(
        eq(agentphoneUserLinks.userId, auth.userId),
        eq(agentphoneUserLinks.orgId, auth.orgId),
      ),
    )
    .returning({ id: agentphoneUserLinks.id });
  signal.throwIfAborted();

  if (deleted.length === 0) {
    return notFound("No linked AgentPhone account");
  }

  await publishAgentPhoneUserChanged(auth.userId);
  signal.throwIfAborted();

  return { status: 204 as const, body: undefined };
});

type LinkConflictReason = "phone-handle-linked" | "org-linked" | "conflict";

function agentPhoneLinkConflictMessage(reason: LinkConflictReason): string {
  const brandName = PUBLIC_BRAND_PRESENTATION.brandName;
  return reason === "phone-handle-linked"
    ? `This phone number is already connected to another ${brandName} account or organization. Disconnect it first.`
    : reason === "org-linked"
      ? `Your ${brandName} account is already connected to another phone number in this organization. Disconnect it first.`
      : "This phone number link already exists. Disconnect it first and try again.";
}

function connectConflict(reason: LinkConflictReason) {
  return conflict(agentPhoneLinkConflictMessage(reason));
}

function agentPhoneConnectedMessage(): string {
  return `Your phone number is now connected to ${PUBLIC_BRAND_PRESENTATION.brandName}.

You can text this number like a teammate and it will actually do the work: research something, draft and send emails, summarize long documents, update a spreadsheet, file or triage tickets, post to Slack, dig through your GitHub or Notion, and a lot more.

It is most useful once you connect the tools you already use. The ones people hook up most often are GitHub, Gmail, Notion, Google Drive / Sheets / Docs / Calendar, Slack, Sentry, and X. There are 100+ more available, and you can connect any of them whenever you need.

A few things to try right now:
- "Summarize my unread Gmail from today"
- "What's on my Google Calendar tomorrow?"
- "List the open issues in my GitHub repo"
- "Find my meeting notes in Notion"
- "Catch me up on my unread Slack messages"
- "Triage my latest Sentry error and open a GitHub PR to fix it"
- "What's trending on X about [topic]?"

No tool connected yet? Just ask me anything and I'll still help, then point you to whatever I need access to.

What would you like to start with?`;
}

const connectAgentPhone$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const publicBrand = PUBLIC_BRAND;
    const bodyResult = await get(connectBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const body = bodyResult.data;
    const channel: AgentPhoneChannel =
      body.channel && isAgentPhoneChannel(body.channel) ? body.channel : "sms";
    const phoneHandle = normalizeAgentPhoneHandle(body.phoneHandle, channel);
    if (
      !phoneHandle ||
      body.publicBrand !== publicBrand ||
      !verifyAgentPhoneConnectSignature({
        phoneHandle,
        agentphoneAgentId: body.agentphoneAgentId,
        timestamp: body.timestamp,
        channel,
        signature: body.signature,
        publicBrand: body.publicBrand,
        publicBrandSignature: body.publicBrandSignature,
        secret: env("SECRETS_ENCRYPTION_KEY"),
      })
    ) {
      return badRequestMessage(
        "Invalid or expired connection link. Send /connect again.",
      );
    }

    const writeDb = set(writeDb$);
    const result = await linkAgentPhoneUser(writeDb, {
      phoneHandle,
      channel,
      userId: auth.userId,
      orgId: auth.orgId,
      publicBrand,
    });
    signal.throwIfAborted();

    if (!result.ok) {
      return connectConflict(result.reason);
    }

    await publishAgentPhoneUserChanged(auth.userId);
    signal.throwIfAborted();

    await tapError(
      sendAgentPhoneMessage(
        {
          agentphoneAgentId: body.agentphoneAgentId,
          toNumber: phoneHandle,
          body: agentPhoneConnectedMessage(),
        },
        signal,
      ),
      (error) => {
        log.warn("Connected AgentPhone user but failed to send confirmation", {
          phoneHandle,
          userId: auth.userId,
          orgId: auth.orgId,
          error,
        });
      },
    );
    signal.throwIfAborted();

    return { status: 200 as const, body: { phoneHandle } };
  },
);

function textResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

function okText(): Response {
  return textResponse("OK", 200);
}

function agentPhoneConnectionCodeReply(
  result: Exclude<AgentPhoneConnectionCodeConsumeResult, { kind: "not-code" }>,
): string {
  switch (result.kind) {
    case "linked": {
      return agentPhoneConnectedMessage();
    }
    case "invalid": {
      return "This connection code is invalid or expired. Open Okou to get a new code.";
    }
    case "conflict": {
      return agentPhoneLinkConflictMessage(result.reason);
    }
  }
}

function valueObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(
  source: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function booleanValue(
  source: Record<string, unknown>,
  keys: readonly string[],
): boolean | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true" || normalized === "yes") {
        return true;
      }
      if (normalized === "false" || normalized === "no") {
        return false;
      }
    }
  }
  return undefined;
}

function arrayValue(source: Record<string, unknown>, keys: readonly string[]) {
  for (const key of keys) {
    const value = source[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function mentionMatchesAgentPhoneHandle(value: unknown): boolean {
  if (typeof value === "string") {
    return isAgentPhoneMentionText(value.startsWith("@") ? value : `@${value}`);
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const mention = value as Record<string, unknown>;
  return ["text", "name", "username", "handle", "value"].some((key) => {
    const field = mention[key];
    return typeof field === "string" && mentionMatchesAgentPhoneHandle(field);
  });
}

function extractAgentPhoneIsGroup(
  body: Record<string, unknown>,
  data: Record<string, unknown>,
): boolean {
  const explicit =
    booleanValue(data, ["isGroup", "is_group", "group"]) ??
    booleanValue(body, ["isGroup", "is_group", "group"]);
  if (explicit !== undefined) {
    return explicit;
  }

  const type = (
    stringValue(data, ["conversationType", "conversation_type", "chatType"]) ??
    stringValue(body, ["conversationType", "conversation_type", "chatType"]) ??
    ""
  ).toLowerCase();
  if (["group", "group_chat", "imessage_group"].includes(type)) {
    return true;
  }

  return (
    arrayValue(data, ["participants", "participantNumbers", "recipients"])
      .length > 2 ||
    arrayValue(body, ["participants", "participantNumbers", "recipients"])
      .length > 2
  );
}

function extractAgentPhoneMentioned(
  body: Record<string, unknown>,
  data: Record<string, unknown>,
  messageBody: string,
): boolean {
  const explicit =
    booleanValue(data, [
      "mentioned",
      "isMentioned",
      "is_mentioned",
      "mentionsAgent",
      "mentions_agent",
    ]) ??
    booleanValue(body, [
      "mentioned",
      "isMentioned",
      "is_mentioned",
      "mentionsAgent",
      "mentions_agent",
    ]);
  if (explicit !== undefined) {
    return explicit;
  }

  return (
    arrayValue(data, ["mentions", "mentionedUsers", "mentioned_users"]).some(
      mentionMatchesAgentPhoneHandle,
    ) ||
    arrayValue(body, ["mentions", "mentionedUsers", "mentioned_users"]).some(
      mentionMatchesAgentPhoneHandle,
    ) ||
    isAgentPhoneMentionText(messageBody)
  );
}

function recentHistoryMessage(
  value: unknown,
): AgentPhoneRecentHistoryMessage | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const item = value as Record<string, unknown>;
  const content =
    stringValue(item, ["content", "message", "body", "text"]) ?? null;
  const mediaUrl = stringValue(item, ["mediaUrl", "media_url"]);
  if (!content && !mediaUrl) {
    return null;
  }

  return {
    messageId: stringValue(item, ["messageId", "message_id", "id"]) ?? null,
    content: content ?? (mediaUrl ? `[AgentPhone file] ${mediaUrl}` : null),
    direction: stringValue(item, ["direction"]) ?? null,
    channel: stringValue(item, ["channel"]) ?? null,
    fromNumber:
      stringValue(item, ["from", "fromNumber", "from_number"]) ?? null,
    toNumber: stringValue(item, ["to", "toNumber", "to_number"]) ?? null,
    at: stringValue(item, ["at", "timestamp", "receivedAt"]) ?? null,
  };
}

function extractAgentPhoneRecentHistory(
  body: Record<string, unknown>,
  data: Record<string, unknown>,
): readonly AgentPhoneRecentHistoryMessage[] {
  return [
    ...arrayValue(body, ["recentHistory", "recent_history"]),
    ...arrayValue(data, ["recentHistory", "recent_history"]),
  ]
    .map(recentHistoryMessage)
    .filter((item): item is AgentPhoneRecentHistoryMessage => {
      return item !== null;
    });
}

function extractAgentPhoneEvent(
  body: Record<string, unknown>,
  webhookId: string | null,
  channel: AgentPhoneChannel,
): AgentPhoneMessageEvent | null {
  const data = valueObject(body.data);
  const messageId =
    stringValue(data, ["messageId", "id"]) ??
    stringValue(body, ["messageId", "id"]) ??
    webhookId;
  const agentphoneAgentId =
    stringValue(body, ["agentId", "agent_id"]) ??
    stringValue(data, ["agentId", "agent_id"]);
  const fromNumber = stringValue(data, ["from", "fromNumber", "from_number"]);
  const toNumber = stringValue(data, ["to", "toNumber", "to_number"]);
  const messageBody =
    stringValue(data, ["message", "body", "text"]) ??
    stringValue(body, ["message", "body", "text"]) ??
    "";
  const mediaUrl =
    stringValue(data, ["mediaUrl", "media_url"]) ??
    stringValue(body, ["mediaUrl", "media_url"]) ??
    null;
  const conversationId =
    stringValue(data, ["conversationId", "conversation_id"]) ??
    stringValue(body, ["conversationId", "conversation_id"]) ??
    null;
  const isGroup = extractAgentPhoneIsGroup(body, data);
  const mentioned = extractAgentPhoneMentioned(body, data, messageBody);
  const recentHistory = extractAgentPhoneRecentHistory(body, data);

  if (!messageId || !agentphoneAgentId || !fromNumber || !toNumber) {
    log.warn("Missing required fields in AgentPhone webhook", {
      webhookId,
      hasMessageId: Boolean(messageId),
      hasAgentId: Boolean(agentphoneAgentId),
      hasFromNumber: Boolean(fromNumber),
      hasToNumber: Boolean(toNumber),
      bodyKeys: Object.keys(body),
      dataKeys: Object.keys(data),
    });
    return null;
  }

  return {
    webhookId,
    channel,
    messageId,
    conversationId,
    isGroup,
    mentioned,
    agentphoneAgentId,
    fromNumber,
    toNumber,
    body: messageBody,
    mediaUrl,
    receivedAt:
      parseDate(data.receivedAt) ??
      parseDate(data.received_at) ??
      parseDate(body.timestamp),
    recentHistory,
  };
}

interface AgentPhoneWebhookConfig {
  readonly webhookSecret: string;
  readonly officialPhoneNumber: string;
}

function agentPhoneWebhookConfig(): AgentPhoneWebhookConfig | undefined {
  const webhookSecret = optionalEnv("AGENTPHONE_WEBHOOK_SECRET");
  const officialPhoneNumber = optionalEnv("AGENTPHONE_PHONE_NUMBER");
  if (!webhookSecret || !officialPhoneNumber) {
    return undefined;
  }
  return { webhookSecret, officialPhoneNumber };
}

function shouldAcceptAgentPhoneEvent(args: {
  readonly event: AgentPhoneMessageEvent;
  readonly config: AgentPhoneWebhookConfig;
  readonly channel: AgentPhoneChannel;
  readonly webhookId: string | null;
}): boolean {
  if (
    normalizeAgentPhoneHandle(args.event.toNumber, "sms") !==
    normalizeAgentPhoneHandle(args.config.officialPhoneNumber, "sms")
  ) {
    return false;
  }

  const normalizedFrom = normalizeAgentPhoneHandle(
    args.event.fromNumber,
    args.channel,
  );
  log.debug("AgentPhone webhook accepted", {
    webhookId: args.webhookId,
    channel: args.channel,
    fromShape: describeAgentPhoneHandleShape(args.event.fromNumber),
    fromHandleNormalized: Boolean(normalizedFrom),
    hasMedia: Boolean(args.event.mediaUrl),
  });

  if (
    !normalizedFrom ||
    !isValidAgentPhoneHandle(normalizedFrom, args.channel)
  ) {
    log.warn("AgentPhone webhook from-handle is not usable", {
      webhookId: args.webhookId,
      channel: args.channel,
      fromShape: describeAgentPhoneHandleShape(args.event.fromNumber),
    });
    return false;
  }

  return true;
}

function shouldDispatchAgentPhoneEvent(event: AgentPhoneMessageEvent): boolean {
  return !(event.channel === "imessage" && event.isGroup && !event.mentioned);
}

/** A connection code binds an unlinked sender, so a sender that already has a
 *  link keeps the normal prompt path even when the body looks like a code. */
function isAgentPhoneConnectionCodeCandidate(
  event: AgentPhoneMessageEvent,
  userLink: AgentPhoneUserLink | null,
): boolean {
  return (
    userLink === null &&
    !event.isGroup &&
    isAgentPhoneConnectionCodeMessage(event.body)
  );
}

function agentPhoneEventForStorage(
  event: AgentPhoneMessageEvent,
  userLink: AgentPhoneUserLink | null,
): AgentPhoneMessageEvent {
  if (!isAgentPhoneConnectionCodeCandidate(event, userLink)) {
    return event;
  }
  return { ...event, body: "[connection code redacted]" };
}

async function handleAgentPhoneConnectionCode(
  db: Db,
  event: AgentPhoneMessageEvent,
  userLink: AgentPhoneUserLink | null,
  signal: AbortSignal,
): Promise<boolean> {
  if (!isAgentPhoneConnectionCodeCandidate(event, userLink)) {
    return false;
  }

  const result = await consumeAgentPhoneConnectionCode(db, {
    message: event.body,
    phoneHandle: event.fromNumber,
    channel: event.channel,
    secret: env("SECRETS_ENCRYPTION_KEY"),
  });
  signal.throwIfAborted();
  if (result.kind === "not-code") {
    return false;
  }

  if (result.kind === "linked") {
    await publishAgentPhoneUserChanged(result.userId);
    signal.throwIfAborted();
  }

  await tapError(
    sendAgentPhoneText(event, agentPhoneConnectionCodeReply(result), signal),
    (error) => {
      log.warn("Handled AgentPhone connection code but reply failed", {
        result: result.kind,
        phoneHandle: maskPhoneHandle(event.fromNumber),
        error,
      });
    },
  );
  signal.throwIfAborted();
  return true;
}

const webhook$ = command(async ({ get, set }, signal: AbortSignal) => {
  const apiStartTime = now();
  const publicBrand = PUBLIC_BRAND;
  const config = agentPhoneWebhookConfig();
  if (!config) {
    return textResponse("Not Found", 404);
  }

  const request = get(request$);
  const rawBody = await request.text();
  signal.throwIfAborted();

  if (
    !verifyAgentPhoneWebhook({
      rawBody,
      signature: request.header("x-webhook-signature") ?? null,
      timestamp: request.header("x-webhook-timestamp") ?? null,
      secret: config.webhookSecret,
    })
  ) {
    return textResponse("Unauthorized", 401);
  }

  const jsonBody = safeJsonParse(rawBody);
  if (jsonBody === undefined) {
    return textResponse("Bad Request", 400);
  }

  const parsed = webhookBodySchema.safeParse(jsonBody);
  if (!parsed.success) {
    return textResponse("Bad Request", 400);
  }

  const body = parsed.data;
  const eventType =
    stringValue(body, ["event"]) ?? request.header("x-webhook-event");
  if (eventType !== "agent.message") {
    return okText();
  }

  const data = valueObject(body.data);
  const rawChannel = (
    stringValue(body, ["channel"]) ??
    stringValue(data, ["channel"]) ??
    ""
  ).toLowerCase();
  if (!isAgentPhoneChannel(rawChannel)) {
    return okText();
  }

  const webhookId = request.header("x-webhook-id") ?? null;
  const event = extractAgentPhoneEvent(body, webhookId, rawChannel);
  if (!event) {
    return okText();
  }

  if (
    !shouldAcceptAgentPhoneEvent({
      event,
      config,
      channel: rawChannel,
      webhookId,
    })
  ) {
    return okText();
  }

  const writeDb = set(writeDb$);
  const userLink = await resolveAgentPhoneUserLinkForEvent(writeDb, event);
  signal.throwIfAborted();

  const stored = await storeInboundAgentPhoneMessage(writeDb, {
    event: agentPhoneEventForStorage(event, userLink),
    userLinkId: userLink?.id ?? null,
    publicBrand,
  });
  signal.throwIfAborted();
  if (!stored.inserted) {
    return okText();
  }

  if (await handleAgentPhoneConnectionCode(writeDb, event, userLink, signal)) {
    return okText();
  }

  if (!shouldDispatchAgentPhoneEvent(event)) {
    return okText();
  }

  waitUntil(
    tapError(
      set(
        handleAgentPhoneMessage$,
        { event, userLink, apiStartTime, publicBrand },
        signal,
      ),
      (error) => {
        log.error("Error handling AgentPhone webhook", { error });
      },
    ),
  );

  return okText();
});

export const integrationsAgentPhoneRoutes: readonly RouteEntry[] = [
  {
    route: integrationsAgentPhoneContract.connectAgentPhone,
    handler: authRoute(agentPhoneAuthOptions, connectAgentPhone$),
  },
  {
    route: integrationsAgentPhoneContract.webhook,
    handler: webhook$,
  },
  {
    route: integrationsAgentPhoneContract.getLinkStatus,
    handler: authRoute(agentPhoneAuthOptions, getLinkStatus$),
  },
  {
    route: integrationsAgentPhoneContract.startLink,
    handler: authRoute(agentPhoneAuthOptions, startLink$),
  },
  {
    route: integrationsAgentPhoneContract.createLinkCode,
    handler: authRoute(agentPhoneAuthOptions, createLinkCode$),
  },
  {
    route: integrationsAgentPhoneContract.unlink,
    handler: authRoute(agentPhoneAuthOptions, unlink$),
  },
];
