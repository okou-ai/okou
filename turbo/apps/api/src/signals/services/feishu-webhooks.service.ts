import type { FeishuPlatform } from "@okouai/core/feishu-platform";
import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";

import { command } from "ccstate";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { feishuEventsContract } from "@okouai/api-contracts/contracts/feishu-events";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";

import { logger } from "../../lib/log";
import { request$ } from "../context/hono";
import { pathParamsOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import {
  fetchFeishuBotInfo,
  getFeishuTenantAccessToken,
} from "../external/feishu-client";
import { writeDb$, type Db } from "../external/db";
import { now, nowDate } from "../../lib/time";
import { safeJsonParse, safeSync, tapError } from "../utils";
import { processCanonicalFeishuIngress$ } from "./canonical-feishu-ingress-processor.service";
import { admitFeishuChatEvent } from "./feishu-chat-ingress.service";
import {
  loadFeishuInstallationConfig,
  type FeishuInstallationConfig,
} from "./feishu-config";
import {
  feishuPromptFile,
  formatFeishuFileContext,
  type FeishuInboundMessage,
  type FeishuPromptFile,
} from "./feishu-dispatch.service";
import { publishFeishuOrgChanged } from "./feishu-realtime.service";
import { PUBLIC_BRAND } from "@okouai/core/public-brand";

const L = logger("FeishuWebhooks");

const encryptedBodySchema = z.object({ encrypt: z.string() });
const challengeSchema = z.object({
  type: z.literal("url_verification"),
  challenge: z.string(),
  token: z.string(),
});
const v2EnvelopeSchema = z.object({
  schema: z.literal("2.0"),
  header: z.object({
    event_id: z.string(),
    event_type: z.string(),
    tenant_key: z.string(),
    app_id: z.string(),
    token: z.string(),
  }),
  event: z.unknown(),
});
const v2MessageEventSchema = z.object({
  sender: z.object({
    sender_id: z.object({ open_id: z.string() }),
    sender_type: z.string().optional(),
  }),
  message: z.object({
    message_id: z.string(),
    root_id: z.string().optional(),
    parent_id: z.string().optional(),
    thread_id: z.string().optional(),
    chat_id: z.string(),
    chat_type: z.string(),
    message_type: z.string(),
    content: z.string(),
    mentions: z
      .array(
        z.object({
          key: z.string(),
          id: z.object({ open_id: z.string().optional() }),
          name: z.string().optional(),
        }),
      )
      .optional(),
  }),
});
const textContentSchema = z.object({ text: z.string() });
const FEISHU_REPLAY_WINDOW_SECONDS = 60 * 5;

type FeishuEventMessage = z.infer<typeof v2MessageEventSchema>["message"];
type FeishuEventMention = NonNullable<FeishuEventMessage["mentions"]>[number];

interface FeishuInboundContent {
  readonly text: string;
  readonly promptText: string;
  readonly file: FeishuPromptFile | null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(text: string): Response {
  return new Response(text, { status: 200 });
}

async function markCallbackVerified(
  args: {
    readonly db: Db;
    readonly config: FeishuInstallationConfig;
  },
  signal: AbortSignal,
): Promise<void> {
  if (args.config.callbackVerified) {
    return;
  }
  await args.db
    .update(feishuOrgInstallations)
    .set({ callbackVerifiedAt: nowDate(), updatedAt: nowDate() })
    .where(eq(feishuOrgInstallations.id, args.config.id));
  signal.throwIfAborted();
  await publishFeishuOrgChanged(
    args.db,
    args.config.orgId,
    args.config.ownerUserId,
  );
}

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

function inboundMessageContent(
  message: FeishuEventMessage,
  botMention: FeishuEventMention | undefined,
  platform: FeishuPlatform,
): FeishuInboundContent {
  if (message.message_type !== "text") {
    const file = feishuPromptFile({
      messageId: message.message_id,
      messageType: message.message_type,
      content: message.content,
    });
    const text = file ? formatFeishuFileContext(file, platform) : "";
    return { text, promptText: text, file };
  }
  const content = textContentSchema.safeParse(safeJsonParse(message.content));
  if (!content.success) {
    return { text: "", promptText: "", file: null };
  }
  return {
    promptText: botMention
      ? content.data.text.replaceAll(
          botMention.key,
          botMention.name ? `@${botMention.name}` : botMention.key,
        )
      : content.data.text,
    text: botMention
      ? content.data.text.replaceAll(botMention.key, "")
      : content.data.text,
    file: null,
  };
}

function inboundMessage(
  config: FeishuInstallationConfig,
  envelope: z.infer<typeof v2EnvelopeSchema>,
): FeishuInboundMessage | null {
  if (envelope.header.event_type !== "im.message.receive_v1") {
    return null;
  }
  const event = v2MessageEventSchema.safeParse(envelope.event);
  if (!event.success || event.data.sender.sender_type === "app") {
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
  const content = inboundMessageContent(
    event.data.message,
    botMention,
    config.platform,
  );
  const text = content.text.trim();
  if (!content.promptText.trim()) {
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
    promptText: content.promptText.trim(),
    file: content.file,
  };
}

async function ensureInboundBotIdentity(
  args: {
    readonly db: Db;
    readonly config: FeishuInstallationConfig;
    readonly envelope: z.infer<typeof v2EnvelopeSchema>;
  },
  signal: AbortSignal,
): Promise<FeishuInstallationConfig> {
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
      const tenantAccessToken = await getFeishuTenantAccessToken(
        {
          db: args.db,
          installationId: args.config.id,
        },
        signal,
      );
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
  await args.db
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
}

async function admitInboundFeishuMessage(
  args: {
    readonly db: Db;
    readonly message: FeishuInboundMessage;
    readonly publicBrand: PublicBrand;
    readonly processIngress: (
      ingressId: string,
      signal: AbortSignal,
    ) => Promise<boolean>;
  },
  signal: AbortSignal,
): Promise<void> {
  const admittedAt = nowDate();
  const ingress = await admitFeishuChatEvent(args.db, {
    installationId: args.message.installationId,
    eventId: args.message.eventId,
    payload: JSON.stringify(args.message),
    publicBrand: args.publicBrand,
    currentTime: admittedAt,
  });
  signal.throwIfAborted();
  L.debug("Canonical Feishu ingress admitted", {
    type: "canonical_feishu_ingress_admission",
    eventId: args.message.eventId,
    outcome: ingress?.inserted ? "accepted" : "deduplicated",
    status: ingress?.status ?? "legacy_deduplicated",
    retryCount: ingress?.retryCount ?? 0,
  });
  if (!ingress || ingress.status === "processed") {
    return;
  }
  const backgroundSignal = new AbortController().signal;
  waitUntil(
    tapError(args.processIngress(ingress.id, backgroundSignal), (error) => {
      L.error("Canonical Feishu ingress processing failed", {
        ingressId: ingress.id,
        eventId: args.message.eventId,
        error,
      });
    }),
  );
}

export const handleFeishuEvents$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<Response> => {
    const request = get(request$);
    const publicBrand = PUBLIC_BRAND;
    const params = get(pathParamsOf(feishuEventsContract.post));
    const db = set(writeDb$);
    const config = await loadFeishuInstallationConfig(
      db,
      params.installationId,
    );
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
      await markCallbackVerified({ db, config }, signal);
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

    const v2 = v2EnvelopeSchema.safeParse(payload);
    if (!v2.success) {
      L.warn("Rejected Feishu callback with an invalid payload", {
        installationId: config.id,
      });
      return jsonResponse({ error: "Invalid Feishu event" }, 400);
    }
    if (
      v2.data.header.app_id !== config.appId ||
      v2.data.header.token !== config.verificationToken
    ) {
      L.warn("Rejected Feishu event with invalid app credentials", {
        installationId: config.id,
      });
      return jsonResponse({ error: "Invalid Feishu token" }, 401);
    }
    await markCallbackVerified({ db, config }, signal);
    const dispatchConfig = await ensureInboundBotIdentity(
      {
        db,
        config,
        envelope: v2.data,
      },
      signal,
    );
    const message = inboundMessage(dispatchConfig, v2.data);
    if (message) {
      await admitInboundFeishuMessage(
        {
          db,
          message,
          publicBrand,
          processIngress: (ingressId, inputSignal) => {
            return set(
              processCanonicalFeishuIngress$,
              { ingressId },
              inputSignal,
            );
          },
        },
        signal,
      );
      signal.throwIfAborted();
    }
    return textResponse("OK");
  },
);
