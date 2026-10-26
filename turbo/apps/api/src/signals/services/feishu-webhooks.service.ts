import { decryptPersistentSecretValue } from "./crypto.utils";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";

import { command } from "ccstate";
import { eq } from "drizzle-orm";
import {
  array,
  literal,
  object,
  string,
  unknown as zUnknown,
  type infer as zInfer,
} from "zod";

import { feishuEventsContract } from "@okouai/api-contracts/contracts/feishu-events";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";

import { logger } from "../../lib/log";
import { request$ } from "../context/hono";
import { pathParamsOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import {
  fetchFeishuBotInfo,
  FeishuApiError,
  resolveFeishuRequestCredentials,
  feishuTokenUpdateValues,
} from "../external/feishu-client";
import { writeDb$ } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import { now, nowDate } from "../../lib/time";
import { safeSync, tapError } from "../utils";
import { processCanonicalFeishuIngress$ } from "./canonical-feishu-ingress-processor.service";
import { admitFeishuChatEvent$ } from "./feishu-chat-ingress.service";
import {
  feishuInstallationConfigReadPlan,
  feishuInstallationConfigFromSecrets,
  feishuInstallationAvailabilityReadPlan,
  feishuInstallationEnabledFromRows,
  type FeishuInstallationConfig,
} from "./feishu-config";
import type { FeishuInboundMessage } from "./feishu-dispatch.service";
import {
  formatFeishuMessageContent,
  parseFeishuMessageContent,
} from "../../lib/feishu-message-content";
import {
  feishuOrgChangedAdminReadPlan,
  feishuOrgChangedUserIds,
} from "./feishu-realtime.service";

const L = logger("FeishuWebhooks");

const encryptedBodySchema = object({ encrypt: string() });
const challengeSchema = object({
  type: literal("url_verification"),
  challenge: string(),
  token: string(),
});
const v2EnvelopeSchema = object({
  schema: literal("2.0"),
  header: object({
    event_id: string(),
    event_type: string(),
    tenant_key: string(),
    app_id: string(),
    token: string(),
  }),
  event: zUnknown(),
});
const v2MessageEventSchema = object({
  sender: object({
    sender_id: object({ open_id: string() }),
    sender_type: string().optional(),
  }),
  message: object({
    message_id: string(),
    root_id: string().optional(),
    parent_id: string().optional(),
    thread_id: string().optional(),
    chat_id: string(),
    chat_type: string(),
    message_type: string(),
    content: string(),
    mentions: array(
      object({
        key: string(),
        id: object({ open_id: string().optional() }),
        name: string().optional(),
      }),
    ).optional(),
  }),
});
const FEISHU_REPLAY_WINDOW_SECONDS = 60 * 5;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(text: string): Response {
  return new Response(text, { status: 200 });
}

const markCallbackVerified$ = command(
  async (
    { set },
    args: {
      readonly config: FeishuInstallationConfig;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    if (args.config.callbackVerified) {
      return;
    }
    await db
      .update(feishuOrgInstallations)
      .set({ callbackVerifiedAt: nowDate(), updatedAt: nowDate() })
      .where(eq(feishuOrgInstallations.id, args.config.id));
    signal.throwIfAborted();
    await (async () => {
      const plan = feishuOrgChangedAdminReadPlan(args.config.orgId);
      const admins = await db
        .select(plan.columns)
        .from(orgMembersCache)
        .where(plan.condition);
      const userIds = feishuOrgChangedUserIds(admins, args.config.ownerUserId);
      if (userIds.length === 0) {
        return;
      }
      await publishUserSignal(userIds, "feishu:changed");
    })();
  },
);

function verifySignature(args: {
  readonly rawBody: string;
  readonly timestamp: string | undefined;
  readonly nonce: string | undefined;
  readonly signature: string | undefined;
  readonly encryptKey: string;
}): boolean {
  if (!args.timestamp || !args.nonce || !args.signature) {
    return false;
  }
  const requestTime = Number(args.timestamp);
  const currentTime = Math.floor(now() / 1000);
  if (
    !Number.isSafeInteger(requestTime) ||
    Math.abs(currentTime - requestTime) > FEISHU_REPLAY_WINDOW_SECONDS
  ) {
    return false;
  }
  const expected = Buffer.from(
    createHash("sha256")
      .update(`${args.timestamp}${args.nonce}${args.encryptKey}${args.rawBody}`)
      .digest("hex"),
    "utf8",
  );
  const actual = Buffer.from(args.signature, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function decryptPayload(encrypted: string, encryptKey: string): unknown {
  const key = createHash("sha256").update(encryptKey).digest();
  const payload = Buffer.from(encrypted, "base64");
  if (payload.length <= 16) {
    throw new Error("Invalid encrypted Feishu payload");
  }
  const decipher = createDecipheriv(
    "aes-256-cbc",
    key,
    payload.subarray(0, 16),
  );
  const decrypted = Buffer.concat([
    decipher.update(payload.subarray(16)),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(decrypted) as unknown;
}

function inboundMessage(
  config: FeishuInstallationConfig,
  envelope: zInfer<typeof v2EnvelopeSchema>,
): FeishuInboundMessage | null {
  if (envelope.header.event_type !== "im.message.receive_v1") {
    return null;
  }
  const event = v2MessageEventSchema.safeParse(envelope.event);
  if (
    !event.success ||
    event.data.sender.sender_type === "app" ||
    event.data.message.message_type === "system"
  ) {
    return null;
  }
  const chatType = event.data.message.chat_type;
  if (
    chatType !== "p2p" &&
    chatType !== "group" &&
    chatType !== "topic_group"
  ) {
    return null;
  }
  const botMention =
    chatType === "p2p"
      ? undefined
      : event.data.message.mentions?.find((mention) => {
          return mention.id.open_id === config.botOpenId;
        });
  if (chatType !== "p2p" && !botMention) {
    return null;
  }
  const content = parseFeishuMessageContent({
    messageId: event.data.message.message_id,
    messageType: event.data.message.message_type,
    content: event.data.message.content,
  });
  if (!content) {
    return null;
  }
  const text = (
    botMention ? content.text.replaceAll(botMention.key, "") : content.text
  ).trim();
  const promptText = formatFeishuMessageContent(
    {
      text: botMention
        ? content.text.replaceAll(
            botMention.key,
            botMention.name ? `@${botMention.name}` : botMention.key,
          )
        : content.text,
      files: content.files,
    },
    config.platform,
  ).trim();
  if (!promptText) {
    return null;
  }
  return {
    installationId: config.id,
    platform: config.platform,
    eventId: envelope.header.event_id,
    tenantKey: envelope.header.tenant_key,
    appId: envelope.header.app_id,
    messageId: event.data.message.message_id,
    chatId: event.data.message.chat_id,
    chatType,
    rootId: event.data.message.root_id ?? null,
    parentId: event.data.message.parent_id ?? null,
    threadId: event.data.message.thread_id ?? null,
    openId: event.data.sender.sender_id.open_id,
    text,
    promptText,
    files: content.files,
  };
}

const ensureInboundBotIdentity$ = command(
  async (
    { set },
    args: {
      readonly config: FeishuInstallationConfig;
      readonly envelope: zInfer<typeof v2EnvelopeSchema>;
    },
    signal: AbortSignal,
  ): Promise<FeishuInstallationConfig> => {
    const db = set(writeDb$);
    if (args.config.botOpenId) {
      return args.config;
    }
    const event = v2MessageEventSchema.safeParse(args.envelope.event);
    if (
      !event.success ||
      (event.data.message.chat_type !== "group" &&
        event.data.message.chat_type !== "topic_group")
    ) {
      return args.config;
    }
    const bot = await tapError(
      (async () => {
        const inboundContextArgs = {
          db,
          installationId: args.config.id,
        };
        const inboundContextSignal = signal;
        const inboundContextRead = (async () => {
          const [installation] = await inboundContextArgs.db
            .select()
            .from(feishuOrgInstallations)
            .where(
              eq(feishuOrgInstallations.id, inboundContextArgs.installationId),
            )
            .limit(1);
          inboundContextSignal.throwIfAborted();
          if (!installation) {
            throw new Error("Bot installation not found");
          }
          if (
            !(await (async () => {
              const plan = feishuInstallationAvailabilityReadPlan(installation);
              if (plan.kind === "resolved") {
                return plan.enabled;
              }
              const rows = await inboundContextArgs.db
                .select(plan.columns)
                .from(userFeatureSwitches)
                .where(plan.condition);
              return feishuInstallationEnabledFromRows(plan.scope, rows);
            })())
          ) {
            throw new FeishuApiError("Lark integration is not enabled", 403);
          }
          const credentials = await resolveFeishuRequestCredentials(
            installation,
            inboundContextSignal,
          );
          if (credentials.refreshedToken) {
            await inboundContextArgs.db
              .update(feishuOrgInstallations)
              .set(feishuTokenUpdateValues(credentials.refreshedToken))
              .where(
                eq(
                  feishuOrgInstallations.id,
                  inboundContextArgs.installationId,
                ),
              );
            inboundContextSignal.throwIfAborted();
          }
          return credentials.context;
        })();
        const tenantAccessToken = await (async () => {
          return (await inboundContextRead).token;
        })();
        return await fetchFeishuBotInfo(
          {
            platform: args.config.platform,
            tenantAccessToken,
          },
          signal,
        );
      })(),
      (error) => {
        L.warn("Failed to backfill Feishu bot identity", {
          error,
          installationId: args.config.id,
        });
      },
    );
    signal.throwIfAborted();
    if (!bot) {
      return args.config;
    }
    await db
      .update(feishuOrgInstallations)
      .set({
        botOpenId: bot.openId,
        botName: bot.name,
        botAvatarUrl: bot.avatarUrl,
        updatedAt: nowDate(),
      })
      .where(eq(feishuOrgInstallations.id, args.config.id));
    signal.throwIfAborted();
    return { ...args.config, botOpenId: bot.openId };
  },
);

const admitInboundFeishuMessage$ = command(
  async (
    { set },
    message: FeishuInboundMessage,
    signal: AbortSignal,
  ): Promise<void> => {
    const admittedAt = nowDate();
    const ingress = await set(
      admitFeishuChatEvent$,
      {
        installationId: message.installationId,
        eventId: message.eventId,
        payload: JSON.stringify(message),
        currentTime: admittedAt,
      },
      signal,
    );
    signal.throwIfAborted();
    L.debug("Canonical Feishu ingress admitted", {
      type: "canonical_feishu_ingress_admission",
      eventId: message.eventId,
      outcome: ingress?.inserted ? "accepted" : "deduplicated",
      status: ingress?.status ?? "legacy_deduplicated",
      retryCount: ingress?.retryCount ?? 0,
    });
    if (!ingress || ingress.status === "processed") {
      return;
    }
    const backgroundSignal = new AbortController().signal;
    waitUntil(
      tapError(
        set(
          processCanonicalFeishuIngress$,
          { ingressId: ingress.id },
          backgroundSignal,
        ),
        (error) => {
          L.error("Canonical Feishu ingress processing failed", {
            ingressId: ingress.id,
            eventId: message.eventId,
            error,
          });
        },
      ),
    );
  },
);

function validatedFeishuEventEnvelope(
  payload: unknown,
  config: FeishuInstallationConfig,
) {
  const v2 = v2EnvelopeSchema.safeParse(payload);
  if (!v2.success) {
    L.warn("Rejected Feishu callback with an invalid payload", {
      installationId: config.id,
    });
    return { response: jsonResponse({ error: "Invalid Feishu event" }, 400) };
  }
  if (
    v2.data.header.app_id !== config.appId ||
    v2.data.header.token !== config.verificationToken
  ) {
    L.warn("Rejected Feishu event with invalid app credentials", {
      installationId: config.id,
    });
    return { response: jsonResponse({ error: "Invalid Feishu token" }, 401) };
  }
  return { envelope: v2.data };
}

export const handleFeishuEvents$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<Response> => {
    const request = get(request$);
    const params = get(pathParamsOf(feishuEventsContract.post));
    const db = set(writeDb$);
    const config = await (async () => {
      const plan = feishuInstallationConfigReadPlan(params.installationId);
      const [installation] = await db
        .select(plan.columns)
        .from(feishuOrgInstallations)
        .where(plan.condition)
        .limit(1);
      if (
        !installation ||
        !(await (async () => {
          const availability =
            feishuInstallationAvailabilityReadPlan(installation);
          if (availability.kind === "resolved") {
            return availability.enabled;
          }
          const rows = await db
            .select(availability.columns)
            .from(userFeatureSwitches)
            .where(availability.condition);
          return feishuInstallationEnabledFromRows(availability.scope, rows);
        })())
      ) {
        return null;
      }
      const context = { orgId: installation.orgId };
      const secrets = await Promise.all([
        decryptPersistentSecretValue(installation.encryptedAppSecret, context),
        decryptPersistentSecretValue(
          installation.encryptedVerificationToken,
          context,
        ),
        decryptPersistentSecretValue(installation.encryptedEncryptKey, context),
      ]);
      return feishuInstallationConfigFromSecrets(installation, secrets);
    })();
    signal.throwIfAborted();
    if (!config) {
      return jsonResponse({ error: "Feishu installation not found" }, 404);
    }
    L.debug("Received Feishu callback", {
      installationId: config.id,
    });
    const rawBody = await request.text();
    signal.throwIfAborted();
    const parsedOuterBody = safeSync(() => {
      return JSON.parse(rawBody) as unknown;
    });
    if ("error" in parsedOuterBody) {
      L.warn("Rejected Feishu callback with invalid JSON", {
        installationId: config.id,
      });
      return jsonResponse({ error: "Invalid Feishu payload" }, 400);
    }
    const encrypted = encryptedBodySchema.safeParse(parsedOuterBody.ok);
    if (encrypted.success && !config.encryptKey) {
      L.warn("Rejected encrypted Feishu callback without an Encrypt Key", {
        installationId: config.id,
      });
      return jsonResponse({ error: "Invalid Feishu payload" }, 400);
    }
    const decryptedBody = encrypted.success
      ? safeSync(() => {
          return decryptPayload(encrypted.data.encrypt, config.encryptKey);
        })
      : { ok: parsedOuterBody.ok };
    if ("error" in decryptedBody) {
      return jsonResponse({ error: "Invalid Feishu payload" }, 400);
    }
    const payload = decryptedBody.ok;
    const challenge = challengeSchema.safeParse(payload);
    if (challenge.success) {
      if (challenge.data.token !== config.verificationToken) {
        L.warn("Rejected Feishu URL verification with an invalid token", {
          installationId: config.id,
        });
        return jsonResponse({ error: "Invalid Feishu token" }, 401);
      }
      await set(markCallbackVerified$, { config }, signal);
      L.debug("Verified Feishu callback URL", {
        installationId: config.id,
      });
      return jsonResponse({ challenge: challenge.data.challenge });
    }

    if (
      encrypted.success &&
      !verifySignature({
        rawBody,
        timestamp: request.header("x-lark-request-timestamp"),
        nonce: request.header("x-lark-request-nonce"),
        signature: request.header("x-lark-signature"),
        encryptKey: config.encryptKey,
      })
    ) {
      L.warn("Rejected encrypted Feishu event with an invalid signature", {
        installationId: config.id,
        hasTimestamp: Boolean(request.header("x-lark-request-timestamp")),
        hasNonce: Boolean(request.header("x-lark-request-nonce")),
        hasSignature: Boolean(request.header("x-lark-signature")),
      });
      return jsonResponse({ error: "Invalid Feishu signature" }, 401);
    }

    const validated = validatedFeishuEventEnvelope(payload, config);
    if (validated.response) {
      return validated.response;
    }
    await set(markCallbackVerified$, { config }, signal);
    const dispatchConfig = await set(
      ensureInboundBotIdentity$,
      {
        config,
        envelope: validated.envelope,
      },
      signal,
    );
    const message = inboundMessage(dispatchConfig, validated.envelope);
    if (message) {
      await set(admitInboundFeishuMessage$, message, signal);
      signal.throwIfAborted();
    }
    return textResponse("OK");
  },
);
