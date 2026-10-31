import { accept, HttpStatusError } from "@okouai/connectors/accept";
import {
  linkAgentPhoneIdentity$,
  switchAgentPhoneIdentity$,
} from "../services/agentphone-link.service";
import { sendAgentPhoneConnectedMessages$ } from "../services/agentphone-connected-messages.service";
import {
  integrationsAgentPhoneContract,
  type AgentPhoneConnectRequest,
  type AgentPhoneConnectStatus,
} from "@okouai/api-contracts/contracts/integrations-agentphone";
import { agentphoneMessages } from "@okouai/db/schema/agentphone-message";
import { agentphoneMessageVisibility } from "@okouai/db/schema/agentphone-message-visibility";
import { agentphoneVerificationSendCooldowns } from "@okouai/db/schema/agentphone-verification-send-cooldown";
import { agentphoneUserLinks } from "@okouai/db/schema/agentphone-user-link";
import { BRAND_PRESENTATION } from "@okouai/core/brand-presentation";
import { command, computed } from "ccstate";
import {
  and,
  asc,
  DrizzleQueryError,
  eq,
  gt,
  gte,
  ilike,
  lte,
  or,
  sql,
} from "drizzle-orm";
import {
  iso,
  literal,
  object,
  record,
  string,
  uuid,
  unknown as zUnknown,
  type infer as zInfer,
} from "zod";

import { env, optionalEnv } from "../../lib/env";
import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { logger } from "../../lib/log";
import { now } from "../../lib/time";
import { parseRawRows } from "../../lib/db-raw-rows";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, queryOf } from "../context/request";
import { request$ } from "../context/hono";
import { waitUntil } from "../context/wait-until";
import { db$, writeDb$ } from "../external/db";
import { isAgentPhoneApiError } from "../external/agentphone-client";
import type { RouteEntry } from "../route-entry";
import {
  consumeAgentPhoneConnectionCode$,
  createAgentPhoneConnectionCode$,
  isAgentPhoneConnectionCodeMessage,
  type AgentPhoneConnectionCodeConsumeResult,
} from "../services/agentphone-connection-code.service";
import {
  buildAgentPhoneConnectUrl,
  describeAgentPhoneHandleShape,
  handleAgentPhoneMessage$,
  isAgentPhoneChannel,
  isValidAgentPhoneHandle,
  normalizeAgentPhoneHandle,
  publishAgentPhoneUserChanged,
  publishAgentPhoneUserLinked,
  sendAgentPhoneText$,
  storeInboundAgentPhoneMessage$,
  verifyAgentPhoneConnectSignature,
  verifyAgentPhoneWebhook,
  type AgentPhoneRecentHistoryMessage,
  type AgentPhoneChannel,
  type AgentPhoneMessageEvent,
} from "../services/agentphone.service";
import {
  agentPhoneUserLinksForChannel,
  isAgentPhoneMentionText,
  type AgentPhoneUserLink,
} from "../services/agentphone-shared.service";
import {
  isWhatsappSupportedHandle,
  whatsappEnabled$,
} from "../services/whatsapp-config";
import { safeJsonParse, settle, tapError } from "../utils";

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
const agentPhoneGroupHistoryAuthOptions = {
  ...agentPhoneAuthOptions,
  requiredCapability: "phone:read",
} as const;

const VERIFICATION_SEND_COOLDOWN_MS = 60_000;
const log = logger("api:agentphone:link");

const startLinkBody$ = bodyResultOf(integrationsAgentPhoneContract.startLink);
const groupHistoryQuery$ = queryOf(integrationsAgentPhoneContract.groupHistory);
const connectBody$ = bodyResultOf(
  integrationsAgentPhoneContract.connectAgentPhone,
);
const connectStatusQuery$ = queryOf(
  integrationsAgentPhoneContract.getConnectStatus,
);

const webhookBodySchema = record(string(), zUnknown());
const groupHistoryCursorSchema = object({
  groupId: string(),
  receivedAt: iso.datetime(),
  id: uuid(),
});

type VerificationSendCooldownScope = "phone" | "user_org";

interface VerificationSendCooldownKey {
  readonly scope: VerificationSendCooldownScope;
  readonly scopeKey: string;
}

const COOLDOWN_RESERVATION_DENIED = "__TX0019_COOLDOWN_DENIED__";
const cooldownReservationRowSchema = object({ guard: literal(0) });

function verificationCooldownReservationSql(
  keys: readonly VerificationSendCooldownKey[],
  attemptedAt: Date,
) {
  const table = agentphoneVerificationSendCooldowns;
  const input = keys.map((key, ordinal) => {
    return { ...key, ordinal };
  });
  const cutoff = new Date(
    attemptedAt.getTime() - VERIFICATION_SEND_COOLDOWN_MS,
  );
  return sql`WITH keys AS MATERIALIZED (
    SELECT DISTINCT ON (scope, "scopeKey") scope, "scopeKey", ordinal
    FROM jsonb_to_recordset(${JSON.stringify(input)}::jsonb)
      AS input(scope text, "scopeKey" text, ordinal integer)
    ORDER BY scope, "scopeKey", ordinal
  ), reserved AS (
    INSERT INTO ${table} (scope, scope_key, last_sent_at, updated_at)
    SELECT scope, "scopeKey", ${sql.param(attemptedAt, table.lastSentAt)},
      ${sql.param(attemptedAt, table.updatedAt)}
    FROM keys ORDER BY ordinal
    ON CONFLICT (scope, scope_key) DO UPDATE
      SET last_sent_at = EXCLUDED.last_sent_at,
          updated_at = EXCLUDED.updated_at
      WHERE ${table.lastSentAt} IS NULL
        OR date_trunc('milliseconds', ${table.lastSentAt})
          <= ${sql.param(cutoff, table.lastSentAt)}
    RETURNING scope
  ) SELECT (CASE
    WHEN (SELECT count(*) FROM reserved) = (SELECT count(*) FROM keys)
      THEN '0' ELSE ${COOLDOWN_RESERVATION_DENIED}
    END)::integer AS guard`;
}

function isCooldownReservationDenied(error: unknown): boolean {
  return (
    error instanceof DrizzleQueryError &&
    error.cause instanceof Error &&
    "code" in error.cause &&
    error.cause.code === "22P02" &&
    error.cause.message ===
      `invalid input syntax for type integer: "${COOLDOWN_RESERVATION_DENIED}"`
  );
}

function notConfigured() {
  return {
    status: 503 as const,
    body: {
      error: {
        message: "Phone messaging is not configured",
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
        message:
          "Unable to confirm the verification text was sent. Wait a minute before trying again.",
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
          "A verification text was recently requested. Wait a minute before trying again.",
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
  const result = await settle(
    accept(
      fetch(`${params.config.apiBaseUrl}/v1/messages`, {
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
      }),
      [200, 201],
    ),
    signal,
  );

  if (!result.ok) {
    if (!(result.error instanceof HttpStatusError)) {
      throw result.error;
    }
    const response = result.error.response;
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
// signing.
const APPS_API_CONNECT_CHANNEL: AgentPhoneChannel = "sms";

function verifiedConnectParams(body: AgentPhoneConnectRequest): {
  readonly phoneHandle: string;
  readonly channel: Exclude<AgentPhoneChannel, "whatsapp">;
} | null {
  const channel = body.channel ?? "sms";
  if (!isAgentPhoneChannel(channel) || channel === "whatsapp") {
    return null;
  }
  const phoneHandle = normalizeAgentPhoneHandle(body.phoneHandle, channel);
  return phoneHandle &&
    verifyAgentPhoneConnectSignature({
      phoneHandle,
      agentphoneAgentId: body.agentphoneAgentId,
      timestamp: body.timestamp,
      channel,
      signature: body.signature,
      secret: env("SECRETS_ENCRYPTION_KEY"),
    })
    ? { phoneHandle, channel }
    : null;
}

const getConnectStatus$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const verified = verifiedConnectParams(get(connectStatusQuery$));
  if (!verified) {
    return badRequestMessage(
      "Invalid or expired connection link. Send /connect again.",
    );
  }
  const { phoneHandle } = verified;
  const rows = await get(db$)
    .select()
    .from(agentphoneUserLinks)
    .where(
      or(
        eq(agentphoneUserLinks.phoneHandle, phoneHandle),
        and(
          eq(agentphoneUserLinks.userId, auth.userId),
          eq(agentphoneUserLinks.orgId, auth.orgId),
        ),
      ),
    )
    .limit(2);
  const requested = rows.find((row) => {
    return row.phoneHandle === phoneHandle;
  });
  const current = rows.find((row) => {
    return row.userId === auth.userId && row.orgId === auth.orgId;
  });
  const body: AgentPhoneConnectStatus = requested
    ? requested === current
      ? { kind: "connected", phoneHandle }
      : { kind: "phone_in_use" }
    : current
      ? { kind: "phone_mismatch", currentPhoneHandle: current.phoneHandle }
      : { kind: "connect" };
  return { status: 200 as const, body };
});

const getLinkStatus$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);

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
      },
    };
  }

  return {
    status: 200 as const,
    body: {
      linked: false as const,
      agentPhoneNumber: config.agentPhoneNumber,
      configured: config.configured,
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

  const code = await set(
    createAgentPhoneConnectionCode$,
    {
      userId: auth.userId,
      orgId: auth.orgId,
      secret: env("SECRETS_ENCRYPTION_KEY"),
    },
    signal,
  );
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
    const db = set(writeDb$);
    const attemptedAt = new Date(now());
    // ON CONFLICT checks the current row after waits. The guard rolls back
    // every reservation if either scope is cooling down; key order is retained.
    signal.throwIfAborted();
    const reservation = await settle(
      (async () => {
        const rows = parseRawRows(
          cooldownReservationRowSchema,
          await db.execute(
            verificationCooldownReservationSql(
              params.cooldownKeys,
              attemptedAt,
            ),
          ),
        );
        signal.throwIfAborted();
        if (rows.length !== 1) {
          throw new Error(
            "Verification cooldown reservation returned no guard",
          );
        }
      })(),
      signal,
    );
    signal.throwIfAborted();
    if (!reservation.ok) {
      if (isCooldownReservationDenied(reservation.error)) {
        return { ok: false as const, response: tooManyVerificationTexts() };
      }
      throw reservation.error;
    }

    // Keep the committed cooldown even if delivery fails or is uncertain.
    const sent =
      (await tapError(
        sendAgentPhoneVerificationMessage(
          {
            config: params.config,
            toNumber: params.phoneHandle,
            body: `Confirm this phone number for ${BRAND_PRESENTATION.brandName}: ${params.connectUrl}`,
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

    return sent
      ? { ok: true as const }
      : { ok: false as const, response: unavailable() };
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
    return notFound("No linked phone number");
  }

  await publishAgentPhoneUserChanged(auth.userId);
  signal.throwIfAborted();

  return { status: 204 as const, body: undefined };
});

type LinkConflictReason = "phone-handle-linked" | "org-linked" | "conflict";

function agentPhoneLinkConflictMessage(reason: LinkConflictReason): string {
  const brandName = BRAND_PRESENTATION.brandName;
  return reason === "phone-handle-linked"
    ? `This phone number is already connected to another ${brandName} account or organization. Disconnect it first.`
    : reason === "org-linked"
      ? `Your ${brandName} account is already connected to another phone number in this organization. Disconnect it first.`
      : "This phone number link already exists. Disconnect it first and try again.";
}

function connectConflict(reason: LinkConflictReason) {
  return conflict(agentPhoneLinkConflictMessage(reason));
}

const connectAgentPhone$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(connectBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const body = bodyResult.data;
    const verified = verifiedConnectParams(body);
    if (!verified) {
      return badRequestMessage(
        "Invalid or expired connection link. Send /connect again.",
      );
    }
    const { phoneHandle, channel } = verified;

    const result = body.replacePhoneHandle
      ? await set(
          switchAgentPhoneIdentity$,
          {
            orgId: auth.orgId,
            userId: auth.userId,
            phoneHandle,
            replacePhoneHandle: body.replacePhoneHandle,
          },
          signal,
        )
      : await set(
          linkAgentPhoneIdentity$,
          {
            phoneHandle,
            channel,
            source: { kind: "direct", userId: auth.userId, orgId: auth.orgId },
          },
          signal,
        );
    signal.throwIfAborted();

    if (result.kind === "stale") {
      return conflict(
        "Your phone connection changed. Reload this page and try again.",
      );
    }
    if (result.kind !== "linked") {
      return connectConflict(
        result.kind === "conflict" ? result.reason : "conflict",
      );
    }

    await publishAgentPhoneUserLinked(auth.userId);
    signal.throwIfAborted();

    await tapError(
      set(
        sendAgentPhoneConnectedMessages$,
        {
          userLinkId: result.userLink.id,
          agentphoneAgentId: body.agentphoneAgentId,
          toNumber: phoneHandle,
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

function agentPhoneConnectionCodeFailureReply(
  result: Extract<
    AgentPhoneConnectionCodeConsumeResult,
    { kind: "invalid" | "conflict" }
  >,
): string {
  switch (result.kind) {
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
  const parsed = iso.datetime().safeParse(value);
  return parsed.success ? new Date(parsed.data) : null;
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
  const groupMarkers = [
    "group",
    "groupId",
    "group_id",
    "senderIdentifier",
    "sender_identifier",
  ];
  if (
    groupMarkers.some((key) => {
      return Object.prototype.hasOwnProperty.call(data, key);
    }) ||
    groupMarkers.some((key) => {
      return Object.prototype.hasOwnProperty.call(body, key);
    })
  ) {
    return true;
  }

  const explicit =
    booleanValue(data, ["isGroup", "is_group", "group"]) ??
    booleanValue(body, ["isGroup", "is_group", "group"]);
  if (explicit === true) {
    return true;
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

function extractAgentPhoneParticipants(
  data: Record<string, unknown>,
): readonly string[] {
  const participants = arrayValue(valueObject(data.group), ["participants"])
    .map((participant) => {
      return stringValue(valueObject(participant), ["identifier"]);
    })
    .filter((participant): participant is string => {
      return Boolean(participant?.trim());
    });
  return [...new Set(participants)];
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
    content: content ?? (mediaUrl ? `[Phone file] ${mediaUrl}` : null),
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

function extractAgentPhoneMessageFields(
  body: Record<string, unknown>,
  data: Record<string, unknown>,
) {
  const isGroup = extractAgentPhoneIsGroup(body, data);
  const messageId = stringValue(data, ["messageId"]);
  const agentphoneAgentId = stringValue(body, ["agentId"]);
  const senderIdentifier = stringValue(data, ["senderIdentifier"]);
  const fromNumber = isGroup ? senderIdentifier : stringValue(data, ["from"]);
  const toNumber = stringValue(data, ["to"]);
  const messageBody = stringValue(data, ["message"]) ?? "";

  return {
    messageId,
    agentphoneAgentId,
    isGroup,
    senderIdentifier,
    fromNumber,
    toNumber,
    messageBody,
  };
}

function extractAgentPhoneEvent(
  body: Record<string, unknown>,
  webhookId: string | null,
  channel: AgentPhoneChannel,
): AgentPhoneMessageEvent | null {
  const data = valueObject(body.data);
  const fields = extractAgentPhoneMessageFields(body, data);
  const { messageId, agentphoneAgentId, fromNumber, toNumber, messageBody } =
    fields;
  const group = valueObject(data.group);
  const mediaUrl = stringValue(data, ["mediaUrl"]) ?? null;
  const conversationId = stringValue(data, ["conversationId"]) ?? null;
  const groupId = stringValue(group, ["groupId"]) ?? null;
  const participantHandles = extractAgentPhoneParticipants(data);
  const senderHandle = fields.isGroup
    ? fields.senderIdentifier
    : fields.fromNumber;
  const participants =
    fields.isGroup && senderHandle
      ? [...new Set([...participantHandles, senderHandle])]
      : participantHandles;
  const mentioned = extractAgentPhoneMentioned(body, data, messageBody);
  const recentHistory = extractAgentPhoneRecentHistory(body, data);

  if (
    !messageId ||
    !agentphoneAgentId ||
    !fromNumber ||
    !toNumber ||
    (!messageBody.trim() && !mediaUrl)
  ) {
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
    replyToMessageId:
      stringValue(valueObject(data.replyTo), ["messageId"]) ?? null,
    conversationId,
    groupId,
    isGroup: fields.isGroup,
    participants,
    senderIdentifier: fields.senderIdentifier ?? null,
    mentioned,
    agentphoneAgentId,
    fromNumber,
    toNumber,
    body: messageBody,
    mediaUrl,
    receivedAt: parseDate(data.receivedAt) ?? parseDate(body.timestamp),
    recentHistory,
  };
}

function missingAgentPhoneRequiredFieldResponse(
  body: Record<string, unknown>,
  channel: AgentPhoneChannel,
  officialPhoneNumber: string,
) {
  const fields = extractAgentPhoneMessageFields(body, valueObject(body.data));
  const normalizedToNumber = fields.toNumber
    ? normalizeAgentPhoneHandle(fields.toNumber, "sms")
    : null;
  const normalizedOfficialNumber = normalizeAgentPhoneHandle(
    officialPhoneNumber,
    "sms",
  );
  if (
    normalizedToNumber &&
    normalizedOfficialNumber &&
    normalizedToNumber !== normalizedOfficialNumber
  ) {
    return null;
  }

  const missingField = !fields.messageId
    ? "message id"
    : !fields.agentphoneAgentId
      ? "agent id"
      : !fields.fromNumber
        ? "sender identity"
        : !normalizedToNumber
          ? "recipient"
          : !fields.messageBody.trim() &&
              !stringValue(valueObject(body.data), ["mediaUrl"])
            ? "message content"
            : null;
  if (!missingField) {
    return null;
  }

  const eventKind =
    channel === "imessage" && fields.isGroup
      ? "iMessage group"
      : "AgentPhone message";
  return textResponse(`${eventKind} webhook is missing ${missingField}`, 500);
}

function agentPhoneInvalidEventResponse(
  body: Record<string, unknown>,
  channel: AgentPhoneChannel,
  officialPhoneNumber: string,
) {
  return (
    missingAgentPhoneRequiredFieldResponse(
      body,
      channel,
      officialPhoneNumber,
    ) ?? okText()
  );
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

type AgentPhoneEventAcceptance =
  | "accept"
  | "ignore"
  | "invalid-recipient"
  | "invalid-sender"
  | "missing-group-id"
  | "invalid-group-id"
  | "missing-conversation-id";

function classifyAgentPhoneEvent(args: {
  readonly event: AgentPhoneMessageEvent;
  readonly config: AgentPhoneWebhookConfig;
  readonly channel: AgentPhoneChannel;
  readonly webhookId: string | null;
}): AgentPhoneEventAcceptance {
  const normalizedToNumber = normalizeAgentPhoneHandle(
    args.event.toNumber,
    "sms",
  );
  const normalizedOfficialNumber = normalizeAgentPhoneHandle(
    args.config.officialPhoneNumber,
    "sms",
  );
  if (!normalizedToNumber || !normalizedOfficialNumber) {
    return "invalid-recipient";
  }
  if (normalizedToNumber !== normalizedOfficialNumber) {
    return "ignore";
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
    return "invalid-sender";
  }

  if (
    args.channel === "imessage" &&
    args.event.isGroup &&
    !args.event.groupId
  ) {
    log.warn("AgentPhone group webhook is missing a provider group id", {
      webhookId: args.webhookId,
    });
    return "missing-group-id";
  }

  if (
    args.channel === "imessage" &&
    args.event.isGroup &&
    !/^grp_.+$/u.test(args.event.groupId ?? "")
  ) {
    log.warn("AgentPhone group webhook has an invalid provider group id", {
      webhookId: args.webhookId,
    });
    return "invalid-group-id";
  }

  if (
    args.channel === "imessage" &&
    args.event.isGroup &&
    !args.event.conversationId
  ) {
    log.warn("AgentPhone group webhook is missing a provider conversation id", {
      webhookId: args.webhookId,
    });
    return "missing-conversation-id";
  }

  return "accept";
}

function agentPhoneWebhookAdmissionResponse(args: {
  readonly event: AgentPhoneMessageEvent;
  readonly config: AgentPhoneWebhookConfig;
  readonly channel: AgentPhoneChannel;
  readonly webhookId: string | null;
}) {
  switch (classifyAgentPhoneEvent(args)) {
    case "ignore": {
      return okText();
    }
    case "invalid-recipient": {
      return textResponse(
        "AgentPhone message webhook has an invalid recipient",
        500,
      );
    }
    case "invalid-sender": {
      return textResponse(
        "AgentPhone message webhook has an invalid sender",
        500,
      );
    }
    case "missing-group-id": {
      return textResponse("iMessage group webhook is missing groupId", 500);
    }
    case "invalid-group-id": {
      return textResponse("iMessage group webhook has an invalid groupId", 500);
    }
    case "missing-conversation-id": {
      return textResponse(
        "iMessage group webhook is missing conversationId",
        500,
      );
    }
    case "accept": {
      return isMissingAgentPhoneGroupTimestamp(args.event)
        ? textResponse("iMessage group webhook is missing receivedAt", 500)
        : null;
    }
  }
}

function shouldDispatchAgentPhoneEvent(event: AgentPhoneMessageEvent): boolean {
  return !(event.channel === "imessage" && event.isGroup && !event.mentioned);
}

function isMissingAgentPhoneGroupTimestamp(
  event: AgentPhoneMessageEvent,
): boolean {
  return (
    event.channel === "imessage" && event.isGroup && event.receivedAt === null
  );
}

function isIdlessAgentPhoneTestWebhook(body: Record<string, unknown>): boolean {
  return (
    valueObject(body.conversationState).testMode === true &&
    !stringValue(valueObject(body.data), ["messageId"])
  );
}

type AgentPhoneWebhookRoutingResult =
  | { readonly kind: "ignore" }
  | { readonly kind: "error"; readonly response: Response }
  | { readonly kind: "message"; readonly channel: AgentPhoneChannel };

function parseAgentPhoneWebhookRouting(
  body: Record<string, unknown>,
  eventHeader: string | undefined,
): AgentPhoneWebhookRoutingResult {
  const eventType = stringValue(body, ["event"]) ?? eventHeader;
  if (!eventType) {
    return {
      kind: "error",
      response: textResponse("AgentPhone webhook is missing event type", 500),
    };
  }
  if (eventType !== "agent.message") {
    return { kind: "ignore" };
  }

  const rawChannel = stringValue(body, ["channel"])?.trim().toLowerCase();
  if (!rawChannel) {
    return {
      kind: "error",
      response: textResponse(
        "AgentPhone message webhook is missing channel",
        500,
      ),
    };
  }
  if (!isAgentPhoneChannel(rawChannel)) {
    return { kind: "ignore" };
  }
  return { kind: "message", channel: rawChannel };
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

const handleAgentPhoneConnectionCode$ = command(
  async (
    { set },
    event: AgentPhoneMessageEvent,
    userLink: AgentPhoneUserLink | null,
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (!isAgentPhoneConnectionCodeCandidate(event, userLink)) {
      return false;
    }

    const result = await set(
      consumeAgentPhoneConnectionCode$,
      {
        message: event.body,
        phoneHandle: event.fromNumber,
        channel: event.channel,
        secret: env("SECRETS_ENCRYPTION_KEY"),
      },
      signal,
    );
    signal.throwIfAborted();
    if (result.kind === "not-code") {
      return false;
    }

    if (result.kind === "linked") {
      await publishAgentPhoneUserLinked(result.userId);
      signal.throwIfAborted();
    }

    await tapError(
      result.kind === "linked"
        ? set(
            sendAgentPhoneConnectedMessages$,
            {
              userLinkId: result.userLinkId,
              agentphoneAgentId: event.agentphoneAgentId,
              toNumber: event.fromNumber,
              channel: event.channel,
              ...(event.channel === "imessage" || event.channel === "whatsapp"
                ? { replyToMessageId: event.messageId }
                : {}),
            },
            signal,
          )
        : set(
            sendAgentPhoneText$,
            event,
            agentPhoneConnectionCodeFailureReply(result),
            signal,
          ),
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
  },
);

const handleUnsupportedWhatsappEvent$ = command(
  async ({ set }, event: AgentPhoneMessageEvent, signal: AbortSignal) => {
    if (event.channel !== "whatsapp") {
      return false;
    }
    if (event.isGroup) {
      return true;
    }
    if (
      isWhatsappSupportedHandle(
        normalizeAgentPhoneHandle(event.fromNumber, "whatsapp"),
      )
    ) {
      return false;
    }
    const stored = await set(
      storeInboundAgentPhoneMessage$,
      { event: agentPhoneEventForStorage(event, null) },
      signal,
    );
    signal.throwIfAborted();
    if (!stored.dispatch) {
      return true;
    }
    const sent = await settle(
      set(
        sendAgentPhoneText$,
        event,
        `Okou isn't available on WhatsApp for your phone number's country or region. Please use Okou on the web: ${env("APP_URL")}`,
        signal,
      ),
      signal,
    );
    if (!sent.ok) {
      if (
        !isAgentPhoneApiError(sent.error) &&
        !(sent.error instanceof TypeError) &&
        !(sent.error instanceof SyntaxError)
      ) {
        throw sent.error;
      }
      log.warn("Unsupported WhatsApp country reply failed", {
        phoneHandle: maskPhoneHandle(event.fromNumber),
        error: sent.error,
      });
    }
    return true;
  },
);

const loadAgentPhoneSenderLink$ = command(
  async ({ get }, event: AgentPhoneMessageEvent, signal: AbortSignal) => {
    const links = agentPhoneUserLinksForChannel(event.channel);
    const [link] = await get(db$)
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
    return link ?? null;
  },
);

const acceptsWhatsappSender$ = command(
  async (
    { set },
    event: AgentPhoneMessageEvent,
    userLink: AgentPhoneUserLink | null,
    signal: AbortSignal,
  ) => {
    if (event.channel !== "whatsapp") {
      return true;
    }
    if (userLink) {
      return await set(
        whatsappEnabled$,
        userLink.orgId,
        userLink.userId,
        signal,
      );
    }
    // The authenticated connect page owns the feature check for a new sender.
    // Ordinary messages and slash commands must reach the connection guide.
    return true;
  },
);

const webhook$ = command(async ({ get, set }, signal: AbortSignal) => {
  const apiStartTime = now();
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
  const routing = parseAgentPhoneWebhookRouting(
    body,
    request.header("x-webhook-event"),
  );
  if (routing.kind === "error") {
    return routing.response;
  }
  if (routing.kind === "ignore") {
    return okText();
  }
  const rawChannel = routing.channel;
  if (isIdlessAgentPhoneTestWebhook(body)) {
    return okText();
  }

  const webhookId = request.header("x-webhook-id") ?? null;
  const event = extractAgentPhoneEvent(body, webhookId, rawChannel);
  if (!event) {
    return agentPhoneInvalidEventResponse(
      body,
      rawChannel,
      config.officialPhoneNumber,
    );
  }

  const admissionResponse = agentPhoneWebhookAdmissionResponse({
    event,
    config,
    channel: rawChannel,
    webhookId,
  });
  if (admissionResponse) {
    return admissionResponse;
  }

  if (await set(handleUnsupportedWhatsappEvent$, event, signal)) {
    return okText();
  }
  // A group sender never borrows a participant's or route owner's link.
  const userLink = await set(loadAgentPhoneSenderLink$, event, signal);
  if (!(await set(acceptsWhatsappSender$, event, userLink, signal))) {
    return okText();
  }

  const stored = await set(
    storeInboundAgentPhoneMessage$,
    {
      event: agentPhoneEventForStorage(event, userLink),
      userLinkId: userLink?.id ?? null,
    },
    signal,
  );
  signal.throwIfAborted();
  if (!stored.dispatch) {
    return okText();
  }

  if (await set(handleAgentPhoneConnectionCode$, event, userLink, signal)) {
    return okText();
  }

  if (!shouldDispatchAgentPhoneEvent(event)) {
    return okText();
  }

  waitUntil(
    tapError(
      set(handleAgentPhoneMessage$, { event, userLink, apiStartTime }, signal),
      (error) => {
        log.error("Error handling AgentPhone webhook", { error });
      },
    ),
  );

  return okText();
});

const groupHistory$ = command(async ({ get }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const query = get(groupHistoryQuery$);
  const config = getAgentPhoneConfig();
  if (!config.agentphoneAgentId) {
    return notFound("iMessage group history is not available");
  }

  const messageAt = agentphoneMessages.receivedAt;
  const conditions = [
    eq(agentphoneMessages.agentphoneAgentId, config.agentphoneAgentId),
    eq(agentphoneMessages.groupId, query.groupId),
    eq(agentphoneMessages.channel, "imessage"),
    eq(agentphoneMessageVisibility.orgId, auth.orgId),
    eq(agentphoneMessageVisibility.userId, auth.userId),
  ];
  let cursor: zInfer<typeof groupHistoryCursorSchema> | undefined;
  if (query.cursor) {
    const parsed = groupHistoryCursorSchema.safeParse(
      safeJsonParse(Buffer.from(query.cursor, "base64url").toString("utf8")),
    );
    if (parsed.success && parsed.data.groupId === query.groupId) {
      cursor = parsed.data;
    }
    if (!cursor) {
      return badRequestMessage("Invalid history cursor");
    }
    const cursorAt = new Date(cursor.receivedAt);
    const cursorCondition = or(
      gt(messageAt, cursorAt),
      and(eq(messageAt, cursorAt), gt(agentphoneMessages.id, cursor.id)),
    );
    if (cursorCondition) {
      conditions.push(cursorCondition);
    }
  }
  if (query.after) {
    conditions.push(gte(messageAt, new Date(query.after)));
  }
  if (query.before) {
    conditions.push(lte(messageAt, new Date(query.before)));
  }
  if (query.query) {
    const pattern = `%${query.query.replace(/[\\%_]/gu, String.raw`\$&`)}%`;
    conditions.push(ilike(agentphoneMessages.body, pattern));
  }

  const rows = await get(db$)
    .select({
      id: agentphoneMessages.agentphoneMessageId,
      cursorId: agentphoneMessages.id,
      conversationId: agentphoneMessages.conversationId,
      fromNumber: agentphoneMessages.fromNumber,
      toNumber: agentphoneMessages.toNumber,
      direction: agentphoneMessages.direction,
      channel: agentphoneMessages.channel,
      body: agentphoneMessages.body,
      mediaUrl: agentphoneMessages.mediaUrl,
      receivedAt: messageAt,
    })
    .from(agentphoneMessages)
    .innerJoin(
      agentphoneMessageVisibility,
      eq(agentphoneMessageVisibility.messageId, agentphoneMessages.id),
    )
    .where(and(...conditions))
    .orderBy(asc(messageAt), asc(agentphoneMessages.id))
    .limit(query.limit + 1);
  signal.throwIfAborted();

  const page = rows.slice(0, query.limit);
  const receivedAtFor = (message: (typeof rows)[number]): Date => {
    if (message.receivedAt === null) {
      throw new Error(
        `AgentPhone group message ${message.cursorId} is missing receivedAt`,
      );
    }
    return message.receivedAt;
  };
  const last = page.at(-1);
  const nextCursor =
    rows.length > query.limit && last
      ? Buffer.from(
          JSON.stringify({
            groupId: query.groupId,
            receivedAt: receivedAtFor(last).toISOString(),
            id: last.cursorId,
          }),
        ).toString("base64url")
      : null;
  return {
    status: 200 as const,
    body: {
      groupId: query.groupId,
      messages: page.map((message) => {
        const { cursorId: _cursorId, ...responseMessage } = message;
        return {
          ...responseMessage,
          receivedAt: receivedAtFor(message).toISOString(),
        };
      }),
      hasMore: rows.length > query.limit,
      nextCursor,
    },
  };
});

export const integrationsAgentPhoneRoutes: readonly RouteEntry[] = [
  {
    route: integrationsAgentPhoneContract.getConnectStatus,
    handler: authRoute(agentPhoneAuthOptions, getConnectStatus$),
  },
  {
    route: integrationsAgentPhoneContract.connectAgentPhone,
    handler: authRoute(agentPhoneAuthOptions, connectAgentPhone$),
  },
  {
    route: integrationsAgentPhoneContract.webhook,
    handler: webhook$,
  },
  {
    route: integrationsAgentPhoneContract.groupHistory,
    handler: authRoute(agentPhoneGroupHistoryAuthOptions, groupHistory$),
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
