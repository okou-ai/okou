import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { command, computed } from "ccstate";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import {
  DEFAULT_AGENT_DISPLAY_NAME,
  PUBLIC_BRAND_PRESENTATION,
  agentDisplayName,
  PUBLIC_BRAND,
} from "@okouai/core/public-brand";
import { v5 as uuidv5 } from "uuid";
import {
  getCanonicalModelDisplayName,
  getBuiltInVisibleModels,
  isSupportedRunModel,
  normalizeRunModelId,
  type SupportedRunModel,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  OFFICIAL_TELEGRAM_BOT_ID,
  integrationsTelegramContract,
} from "@okouai/api-contracts/contracts/integrations-telegram";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import {
  telegramMessages,
  type TelegramMessageEntity,
} from "@okouai/db/schema/telegram-message";
import { telegramChatThreadRoutes } from "@okouai/db/schema/telegram-chat-thread-route";
import { telegramInstallations } from "@okouai/db/schema/telegram-installation";
import { telegramOfficialUserLinks } from "@okouai/db/schema/telegram-official-user-link";
import { telegramUserAgentPreferences } from "@okouai/db/schema/telegram-user-agent-preference";
import { telegramUserLinks } from "@okouai/db/schema/telegram-user-link";
import { and, desc, eq, isNull, like, notExists, or } from "drizzle-orm";
import {
  INTEGRATION_DM_SESSION_PREFIX,
  integrationDmSessionKey,
} from "../../lib/integration-dm-session";
import { alias } from "drizzle-orm/pg-core";
import { escapeHtml } from "../../lib/telegram-format";
import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { webUrl } from "../../lib/web-url";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { request$ } from "../context/hono";
import { waitUntil } from "../context/wait-until";
import { writeDb$, type Db } from "../external/db";
import {
  publishChatThreadMessageCreatedSafely,
  publishOrgSignal,
  publishThreadListChanged,
} from "../external/realtime";
import { checkTelegramDomain } from "../external/telegram-domain";
import {
  buildFileDownloadUrl,
  getFile,
  getMe,
  isTelegramApiError,
  sendChatAction,
  sendMessage,
  setMyCommands,
  setWebhook,
  type TelegramReplyMarkup,
} from "../external/telegram-client";
import {
  getOfficialTelegramBotConfig,
  isOfficialTelegramBotId,
} from "../external/telegram-official";
import { now, nowDate } from "../../lib/time";
import { safeJsonParse, safeUrlParse, tapError } from "../utils";
import {
  decryptPersistentSecretValue,
  encryptPersistentSecretValue,
} from "./crypto.utils";
import {
  resolveIntegrationModelRouteForUser$,
  type IntegrationModelRoutePin,
} from "./integration-model-route.service";
import { listOrgModelPolicies$ } from "./model-policy.service";
import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import { drainChatThreadQueueForThread$ } from "./chat-thread-queue-drain.service";
import {
  bindTelegramReplyMessageRoute,
  createTelegramChatThread,
  ensureTelegramChatThreadRoute,
  type TelegramOwnerLink,
} from "./telegram-chat-ingress.service";
import { touchChatThreadLastMessageAt } from "./chat-event-shared.service";
import { insertChatEvent } from "./chat-event.service";
import { createChatEventSourcePart } from "./chat-event-annotation.service";
import { createUserMessageDocument } from "./chat-user-message.service";
import {
  InputFileImportError,
  type CanonicalInputAsset,
} from "./canonical-asset.service";
import {
  canonicalInputFilePrompt,
  integrationInputMessageFiles,
  materializeIntegrationInputAssets$,
  readyIntegrationInputAsset,
  type IntegrationInputFile,
} from "./integration-input-assets.service";
import {
  chatEventTypeIn,
  chatInputPromptDispatchCondition,
} from "./chat-event-type.service";
import { telegramIntegrationBotStatus } from "./telegram-data.service";
import {
  formatTelegramUserDisplayName,
  linkOfficialTelegramUser$,
  linkTelegramUser$,
} from "./telegram-link.service";
import {
  updateUserModelPreference$,
  userModelPreference,
} from "./user-data.service";
import { userFeatureSwitchContext } from "./feature-switches.service";
import type { ApiOrgRole, AuthTokenType } from "../../types/auth";

const log = logger("api:telegram:post");
const MAX_CONTEXT_MESSAGES = 10;
const MAX_TELEGRAM_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const PENDING_TELEGRAM_USER_ID = "pending";
const QUEUED_MESSAGE =
  "Run queued - concurrency limit reached. Will start automatically when a slot is available.";
const TELEGRAM_CHAT_MESSAGE_ID_NAMESPACE =
  "f2233eb8-9b2f-41b2-9240-b34983f595af";
const telegramQueueEventRevoker = alias(
  chatEvents,
  "telegram_queue_event_revoker",
);

interface OrganizationAuth {
  readonly tokenType: AuthTokenType;
  readonly userId: string;
  readonly orgId: string;
  readonly orgRole?: ApiOrgRole;
}
type TelegramInstallation = typeof telegramInstallations.$inferSelect;
type CanonicalTelegramInstallation = TelegramInstallation & {
  readonly defaultAgentId: string;
};
type TelegramUserLink = typeof telegramUserLinks.$inferSelect;
type OfficialTelegramUserLink = typeof telegramOfficialUserLinks.$inferSelect;

interface TelegramPhotoSize {
  readonly file_id: string;
  readonly file_unique_id: string;
  readonly width: number;
  readonly height: number;
  readonly file_size?: number;
}

interface TelegramFileBase {
  readonly file_id: string;
  readonly file_unique_id: string;
  readonly file_size?: number;
}

interface TelegramDocument extends TelegramFileBase {
  readonly file_name?: string;
  readonly mime_type?: string;
}

interface TelegramVideo extends TelegramDocument {
  readonly width: number;
  readonly height: number;
  readonly duration: number;
}

interface TelegramAudio extends TelegramDocument {
  readonly duration: number;
  readonly performer?: string;
  readonly title?: string;
}

interface TelegramVoice extends TelegramFileBase {
  readonly duration: number;
  readonly mime_type?: string;
}

interface TelegramAnimation extends TelegramDocument {
  readonly width: number;
  readonly height: number;
  readonly duration: number;
}

interface TelegramVideoNote extends TelegramFileBase {
  readonly length: number;
  readonly duration: number;
}

interface TelegramSticker extends TelegramFileBase {
  readonly type?: string;
  readonly width: number;
  readonly height: number;
  readonly emoji?: string;
}

interface TelegramMessage {
  readonly message_id: number;
  readonly message_thread_id?: number;
  readonly chat: { readonly id: number; readonly type: string };
  readonly from?: {
    readonly id: number;
    readonly username?: string;
    readonly first_name?: string;
    readonly last_name?: string;
    readonly language_code?: string;
    readonly is_bot?: boolean;
  };
  readonly text?: string;
  readonly caption?: string;
  readonly photo?: readonly TelegramPhotoSize[];
  readonly document?: TelegramDocument;
  readonly video?: TelegramVideo;
  readonly audio?: TelegramAudio;
  readonly voice?: TelegramVoice;
  readonly animation?: TelegramAnimation;
  readonly video_note?: TelegramVideoNote;
  readonly sticker?: TelegramSticker;
  readonly entities?: readonly TelegramMessageEntity[];
  readonly caption_entities?: readonly TelegramMessageEntity[];
  readonly reply_to_message?: {
    readonly message_id: number;
    readonly from?: {
      readonly id: number;
      readonly is_bot?: boolean;
      readonly username?: string;
      readonly first_name?: string;
    };
    readonly text?: string;
    readonly caption?: string;
  };
}

interface TelegramWebhookUpdate {
  readonly update_id?: number;
  readonly message?: TelegramMessage;
}

type TelegramMessageScope =
  | { readonly kind: "custom"; readonly installationId: string }
  | {
      readonly kind: "official";
      readonly orgId: string;
      readonly userLinkId: string | null;
    };

interface TelegramFileContext {
  readonly file_id: string;
  readonly file_type:
    | "photo"
    | "document"
    | "video"
    | "audio"
    | "voice"
    | "animation"
    | "video_note"
    | "sticker";
  readonly file_name?: string;
  readonly mime_type?: string;
  readonly file_size?: number;
  readonly width?: number;
  readonly height?: number;
  readonly duration?: number;
}

interface TelegramInboundFileContext extends TelegramFileContext {
  readonly file_unique_id: string;
}

interface WorkspaceAgent {
  readonly composeId: string;
  readonly agentId: string;
  readonly name: string;
  readonly displayName: string | null;
}

type ModelRoutePin = IntegrationModelRoutePin;

interface TelegramUserInfoExtras {
  readonly telegramDisplayName?: string;
  readonly telegramUsername?: string;
  readonly telegramUserId?: string;
  readonly telegramLanguage?: string;
}

type TelegramMessageDispatchResult =
  | { readonly kind: "ignored" }
  | {
      readonly kind: "accepted" | "queued";
      readonly runId?: string;
    };

function apiError<Status extends 400 | 403 | 404 | 409 | 500 | 502>(
  status: Status,
  message: string,
  code:
    | "BAD_REQUEST"
    | "FORBIDDEN"
    | "NOT_FOUND"
    | "CONFLICT"
    | "INTERNAL"
    | "BAD_GATEWAY",
) {
  return {
    status,
    body: { error: { message, code } },
  };
}

function badRequest(message: string) {
  return apiError(400, message, "BAD_REQUEST");
}

function forbidden(message: string) {
  return apiError(403, message, "FORBIDDEN");
}

function notFound(message: string) {
  return apiError(404, message, "NOT_FOUND");
}

function conflict(message: string) {
  return apiError(409, message, "CONFLICT");
}

function internalError(message: string) {
  return apiError(500, message, "INTERNAL");
}

function badGateway(message: string) {
  return apiError(502, message, "BAD_GATEWAY");
}

function textResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

function okText(): Response {
  return textResponse("OK", 200);
}

function generateCallbackSecret(): string {
  return randomBytes(32).toString("hex");
}

function buildTelegramWebhookUrl(telegramBotId: string): string {
  return `${webUrl()}/api/telegram/webhook/${telegramBotId}`;
}

function normalizeTelegramUsername(
  telegramUsername: string | null | undefined,
): string | null {
  const value = telegramUsername?.trim().replace(/^@+/, "");
  return value || null;
}

function normalizeTelegramDisplayName(
  telegramDisplayName: string | null | undefined,
): string | null {
  const value = telegramDisplayName?.trim().replace(/\s+/g, " ");
  return value ? value.slice(0, 255) : null;
}

function displayLabel(row: {
  readonly displayName: string | null;
  readonly name: string | null;
}): string {
  return (
    row.displayName?.trim() || row.name?.trim() || DEFAULT_AGENT_DISPLAY_NAME
  );
}

async function getWorkspaceAgent(
  db: Db,
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

async function getWorkspaceAgentDisplayLabel(
  db: Db,
  composeId: string,
): Promise<string> {
  const agent = await getWorkspaceAgent(db, composeId);
  return agent ? displayLabel(agent) : DEFAULT_AGENT_DISPLAY_NAME;
}

async function getTelegramCommandAgentName(args: {
  readonly db: Db;
  readonly agentId: string;
  readonly orgId: string;
}): Promise<string> {
  const displayName = await getWorkspaceAgentDisplayLabel(
    args.db,
    args.agentId,
  );
  const [metadata] = await args.db
    .select({ defaultAgentId: orgMetadata.defaultAgentId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, args.orgId))
    .limit(1);
  return (
    agentDisplayName({
      agentId: args.agentId,
      defaultAgentId: metadata?.defaultAgentId ?? null,
      displayName,
    }) ?? displayName
  );
}

async function resolveDefaultAgentId(args: {
  readonly db: Db;
  readonly requestedAgentId: string | undefined;
  readonly fallbackAgentId: string | null | undefined;
  readonly orgId: string;
}): Promise<
  | { readonly ok: true; readonly agentId: string }
  | ReturnType<typeof badRequest>
  | ReturnType<typeof forbidden>
  | ReturnType<typeof notFound>
> {
  let defaultAgentId = args.requestedAgentId ?? args.fallbackAgentId;
  if (!defaultAgentId) {
    const [metadata] = await args.db
      .select({ defaultAgentId: orgMetadata.defaultAgentId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, args.orgId))
      .limit(1);
    defaultAgentId = metadata?.defaultAgentId ?? undefined;
  }

  if (!defaultAgentId) {
    return badRequest(
      "No default agent specified. Provide defaultAgentId or configure a default agent for the active organization.",
    );
  }

  const [agent] = await args.db
    .select({ id: agents.id, orgId: agents.orgId })
    .from(agents)
    .where(eq(agents.id, defaultAgentId))
    .limit(1);

  if (!agent) {
    return notFound("Agent not found");
  }
  if (agent.orgId !== args.orgId) {
    return forbidden(
      "Telegram bots can only be connected to agents in the active organization.",
    );
  }

  return { ok: true, agentId: agent.id };
}

async function configureTelegramBot(
  args: {
    readonly db: Db;
    readonly botToken: string;
    readonly telegramBotId: string;
    readonly webhookSecret: string;
    readonly agentId: string;
    readonly orgId: string;
  },
  signal: AbortSignal,
): Promise<ReturnType<typeof badGateway> | undefined> {
  const agentName = await getTelegramCommandAgentName({
    db: args.db,
    agentId: args.agentId,
    orgId: args.orgId,
  });
  signal.throwIfAborted();
  const webhookConfigured = await tapError(
    (async () => {
      await setWebhook(
        args.botToken,
        buildTelegramWebhookUrl(args.telegramBotId),
        args.webhookSecret,
      );
      return true;
    })(),
    (error) => {
      log.error("Failed to set Telegram webhook", { error });
    },
  );
  if (!webhookConfigured) {
    return badGateway("Failed to register webhook with Telegram");
  }

  await tapError(
    setMyCommands(args.botToken, [
      { command: "new_session", description: "Start a new conversation" },
      { command: "connect", description: `Connect to ${agentName}` },
      { command: "model", description: "Choose your model" },
      {
        command: "disconnect",
        description: `Disconnect from ${agentName}`,
      },
      { command: "help", description: "Show available commands" },
    ]),
    (error) => {
      log.warn("Failed to register Telegram bot commands", { error });
    },
  );

  return undefined;
}

async function publishTelegramOrgChanged(orgId: string): Promise<void> {
  await tapError(publishOrgSignal(orgId, "telegram:changed"), (error) => {
    log.warn("Failed to publish Telegram org change", { error });
  });
}

function buildStatusResponse(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly botId: string;
  readonly publicBrand: PublicBrand;
}) {
  return computed(async (get) => {
    const status = await get(
      telegramIntegrationBotStatus({
        orgId: args.orgId,
        userId: args.userId,
        botId: args.botId,
        publicBrand: args.publicBrand,
      }),
    );
    return status
      ? { status: 200 as const, body: status }
      : notFound("Telegram bot not found");
  });
}

const handleExistingInstallation$ = command(
  async (
    { get },
    args: {
      readonly db: Db;
      readonly existing: TelegramInstallation;
      readonly body: {
        readonly botToken: string;
        readonly defaultAgentId?: string;
        readonly reinstallBotId?: string;
      };
      readonly botInfo: { readonly username: string };
      readonly auth: OrganizationAuth;
      readonly publicBrand: PublicBrand;
    },
    signal: AbortSignal,
  ) => {
    if (!args.body.reinstallBotId) {
      return conflict(
        `This bot is already installed. Use /connect in Telegram (@${
          args.existing.botUsername ?? args.existing.telegramBotId
        }) to link your account.`,
      );
    }

    if (args.existing.orgId !== args.auth.orgId) {
      return conflict(
        "This Telegram bot is already installed in another workspace.",
      );
    }

    if (
      args.existing.ownerUserId !== args.auth.userId &&
      args.auth.orgRole !== "admin"
    ) {
      return forbidden(
        "Only the bot owner or an org admin can reinstall this bot",
      );
    }

    const resolvedAgent = await resolveDefaultAgentId({
      db: args.db,
      requestedAgentId: args.body.defaultAgentId,
      fallbackAgentId: args.existing.defaultAgentId,
      orgId: args.auth.orgId,
    });
    signal.throwIfAborted();
    if (!("ok" in resolvedAgent)) {
      return resolvedAgent;
    }

    const webhookSecret = generateCallbackSecret();
    const configureError = await configureTelegramBot(
      {
        db: args.db,
        botToken: args.body.botToken,
        telegramBotId: args.existing.telegramBotId,
        webhookSecret,
        agentId: resolvedAgent.agentId,
        orgId: args.auth.orgId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (configureError) {
      return configureError;
    }
    const featureSwitchContext = await get(
      userFeatureSwitchContext(args.auth.orgId, args.auth.userId),
    );
    signal.throwIfAborted();

    const [updated] = await args.db
      .update(telegramInstallations)
      .set({
        botUsername: args.botInfo.username,
        encryptedBotToken: await encryptPersistentSecretValue(
          args.body.botToken,
          featureSwitchContext,
        ),
        webhookSecret,
        defaultAgentId: resolvedAgent.agentId,
        publicBrand: args.publicBrand,
        updatedAt: nowDate(),
      })
      .where(
        eq(telegramInstallations.telegramBotId, args.existing.telegramBotId),
      )
      .returning();
    signal.throwIfAborted();

    await publishTelegramOrgChanged(args.auth.orgId);
    signal.throwIfAborted();

    return get(
      buildStatusResponse({
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        botId: updated?.telegramBotId ?? args.existing.telegramBotId,
        publicBrand: args.publicBrand,
      }),
    );
  },
);

function registerBodyError(message: string): ReturnType<typeof badRequest> {
  return badRequest(
    message.includes("defaultAgentId")
      ? "defaultAgentId must be non-empty"
      : "botToken is required",
  );
}

export const registerTelegramBot$ = command(
  async (
    { get, set },
    args: {
      readonly auth: OrganizationAuth;
      readonly publicBrand: PublicBrand;
    },
    signal: AbortSignal,
  ) => {
    const { auth } = args;
    const bodyResult = await get(
      bodyResultOf(integrationsTelegramContract.register),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return registerBodyError(bodyResult.response.body.error.message);
    }

    const botInfo = await tapError(getMe(bodyResult.data.botToken));
    signal.throwIfAborted();
    if (!botInfo) {
      return badRequest(
        "Invalid bot token. Please verify your token with @BotFather.",
      );
    }

    const db = set(writeDb$);
    const telegramBotId = String(botInfo.id);
    if (
      bodyResult.data.reinstallBotId &&
      bodyResult.data.reinstallBotId !== telegramBotId
    ) {
      return badRequest(
        "This token belongs to a different Telegram bot. Paste the token for the selected bot.",
      );
    }

    const [existing] = await db
      .select()
      .from(telegramInstallations)
      .where(eq(telegramInstallations.telegramBotId, telegramBotId))
      .limit(1);
    signal.throwIfAborted();

    if (existing) {
      return set(
        handleExistingInstallation$,
        {
          db,
          existing,
          body: bodyResult.data,
          botInfo,
          auth,
          publicBrand: args.publicBrand,
        },
        signal,
      );
    }

    if (bodyResult.data.reinstallBotId) {
      return notFound("Telegram bot not found");
    }

    const resolvedAgent = await resolveDefaultAgentId({
      db,
      requestedAgentId: bodyResult.data.defaultAgentId,
      fallbackAgentId: undefined,
      orgId: auth.orgId,
    });
    signal.throwIfAborted();
    if (!("ok" in resolvedAgent)) {
      return resolvedAgent;
    }

    const webhookSecret = generateCallbackSecret();
    const featureSwitchContext = await get(
      userFeatureSwitchContext(auth.orgId, auth.userId),
    );
    signal.throwIfAborted();
    const [installation] = await db
      .insert(telegramInstallations)
      .values({
        telegramBotId,
        botUsername: botInfo.username,
        encryptedBotToken: await encryptPersistentSecretValue(
          bodyResult.data.botToken,
          featureSwitchContext,
        ),
        webhookSecret,
        defaultAgentId: resolvedAgent.agentId,
        ownerUserId: auth.userId,
        orgId: auth.orgId,
        publicBrand: args.publicBrand,
      })
      .returning();
    signal.throwIfAborted();
    if (!installation) {
      return internalError("Failed to create installation");
    }

    const configureError = await configureTelegramBot(
      {
        db,
        botToken: bodyResult.data.botToken,
        telegramBotId: installation.telegramBotId,
        webhookSecret,
        agentId: resolvedAgent.agentId,
        orgId: auth.orgId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (configureError) {
      await db
        .delete(telegramInstallations)
        .where(
          eq(telegramInstallations.telegramBotId, installation.telegramBotId),
        );
      signal.throwIfAborted();
      return configureError;
    }

    await publishTelegramOrgChanged(auth.orgId);
    signal.throwIfAborted();

    const status = await get(
      telegramIntegrationBotStatus({
        orgId: auth.orgId,
        userId: auth.userId,
        botId: installation.telegramBotId,
        publicBrand: args.publicBrand,
      }),
    );
    signal.throwIfAborted();

    return status
      ? { status: 201 as const, body: status }
      : internalError("Failed to create installation");
  },
);

function resolveProbeOrigin(origin: string | undefined): string {
  const brandedOrigin = new URL(env("APP_URL")).origin;
  if (!origin) {
    return brandedOrigin;
  }

  const parsed = safeUrlParse(origin);
  if (
    parsed &&
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    parsed.origin === brandedOrigin
  ) {
    return parsed.origin;
  }

  return brandedOrigin;
}

function isInvalidTelegramTokenError(error: unknown): boolean {
  return (
    isTelegramApiError(error) &&
    (error.status === 401 ||
      /unauthorized|not found/i.test(error.description ?? ""))
  );
}

export const setupTelegramStatus$ = command(
  async (
    { get, set },
    args: {
      readonly auth: OrganizationAuth;
    },
    signal: AbortSignal,
  ) => {
    const bodyResult = await get(
      bodyResultOf(integrationsTelegramContract.setupStatus),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return badRequest("botToken is required");
    }

    const botInfo = await tapError(getMe(bodyResult.data.botToken), (error) => {
      if (!isInvalidTelegramTokenError(error)) {
        log.warn("Unable to verify Telegram setup status", { error });
      }
    });
    signal.throwIfAborted();
    if (!botInfo) {
      return badRequest(
        "Invalid bot token. Please verify your token with @BotFather.",
      );
    }

    const botId = String(botInfo.id);
    const db = set(writeDb$);
    const [existing] = await db
      .select({
        orgId: telegramInstallations.orgId,
        botUsername: telegramInstallations.botUsername,
      })
      .from(telegramInstallations)
      .where(eq(telegramInstallations.telegramBotId, botId))
      .limit(1);
    signal.throwIfAborted();

    if (existing) {
      return conflict(
        existing.orgId === args.auth.orgId
          ? `This bot is already installed. Use /connect in Telegram (@${
              existing.botUsername ?? botId
            }) to link your account.`
          : "This Telegram bot is already installed in another workspace.",
      );
    }

    const domainConfigured = await checkTelegramDomain(
      botId,
      resolveProbeOrigin(bodyResult.data.origin),
    );
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        id: botId,
        username: botInfo.username ?? null,
        domainConfigured,
        privacyDisabled: botInfo.can_read_all_group_messages === true,
      },
    };
  },
);

function verifyTelegramWebhook(
  request: Request,
  expectedSecret: string,
): boolean {
  const token = request.headers.get("x-telegram-bot-api-secret-token");
  if (!token) {
    return false;
  }

  const tokenBuffer = Buffer.from(token);
  const expectedBuffer = Buffer.from(expectedSecret);
  return (
    tokenBuffer.length === expectedBuffer.length &&
    timingSafeEqual(tokenBuffer, expectedBuffer)
  );
}

function isTelegramUpdate(value: unknown): value is TelegramWebhookUpdate {
  return typeof value === "object" && value !== null;
}

function messageText(message: TelegramMessage): string {
  return message.text ?? message.caption ?? "";
}

function extractEntities(
  message: TelegramMessage,
): readonly TelegramMessageEntity[] | undefined {
  const entities = [
    ...(message.entities ?? []),
    ...(message.caption_entities ?? []),
  ];
  return entities.length > 0 ? entities : undefined;
}

function selectLargestPhoto(
  photos: readonly TelegramPhotoSize[] | undefined,
): TelegramPhotoSize | undefined {
  return photos?.reduce<TelegramPhotoSize | undefined>((largest, photo) => {
    if (!largest) {
      return photo;
    }
    return photo.width * photo.height > largest.width * largest.height
      ? photo
      : largest;
  }, undefined);
}

function extractTelegramFileForContext(
  message: TelegramMessage,
): TelegramInboundFileContext | undefined {
  const photo = selectLargestPhoto(message.photo);
  if (photo) {
    return {
      file_id: photo.file_id,
      file_unique_id: photo.file_unique_id,
      file_type: "photo",
      file_size: photo.file_size,
      width: photo.width,
      height: photo.height,
    };
  }
  if (message.document) {
    return {
      file_id: message.document.file_id,
      file_unique_id: message.document.file_unique_id,
      file_type: "document",
      file_name: message.document.file_name,
      mime_type: message.document.mime_type,
      file_size: message.document.file_size,
    };
  }
  if (message.video) {
    return {
      file_id: message.video.file_id,
      file_unique_id: message.video.file_unique_id,
      file_type: "video",
      file_name: message.video.file_name,
      mime_type: message.video.mime_type,
      file_size: message.video.file_size,
      width: message.video.width,
      height: message.video.height,
      duration: message.video.duration,
    };
  }
  if (message.audio) {
    return {
      file_id: message.audio.file_id,
      file_unique_id: message.audio.file_unique_id,
      file_type: "audio",
      file_name: message.audio.file_name,
      mime_type: message.audio.mime_type,
      file_size: message.audio.file_size,
      duration: message.audio.duration,
    };
  }
  if (message.voice) {
    return {
      file_id: message.voice.file_id,
      file_unique_id: message.voice.file_unique_id,
      file_type: "voice",
      mime_type: message.voice.mime_type,
      file_size: message.voice.file_size,
      duration: message.voice.duration,
    };
  }
  if (message.animation) {
    return {
      file_id: message.animation.file_id,
      file_unique_id: message.animation.file_unique_id,
      file_type: "animation",
      file_name: message.animation.file_name,
      mime_type: message.animation.mime_type,
      file_size: message.animation.file_size,
      width: message.animation.width,
      height: message.animation.height,
      duration: message.animation.duration,
    };
  }
  if (message.video_note) {
    return {
      file_id: message.video_note.file_id,
      file_unique_id: message.video_note.file_unique_id,
      file_type: "video_note",
      file_size: message.video_note.file_size,
      width: message.video_note.length,
      height: message.video_note.length,
      duration: message.video_note.duration,
    };
  }
  if (message.sticker) {
    return {
      file_id: message.sticker.file_id,
      file_unique_id: message.sticker.file_unique_id,
      file_type: "sticker",
      file_size: message.sticker.file_size,
      width: message.sticker.width,
      height: message.sticker.height,
    };
  }
  return undefined;
}

function hasTelegramMessageContextContent(message: TelegramMessage): boolean {
  return Boolean(
    message.text ||
    message.caption ||
    extractTelegramFileForContext(message) ||
    extractEntities(message),
  );
}

function telegramFileDbValues(file: TelegramFileContext | undefined): {
  readonly fileId: string | null;
  readonly fileType: string | null;
  readonly fileName: string | null;
  readonly fileMimeType: string | null;
  readonly fileSize: number | null;
  readonly fileWidth: number | null;
  readonly fileHeight: number | null;
  readonly fileDuration: number | null;
} {
  return {
    fileId: file?.file_id ?? null,
    fileType: file?.file_type ?? null,
    fileName: file?.file_name ?? null,
    fileMimeType: file?.mime_type ?? null,
    fileSize: file?.file_size ?? null,
    fileWidth: file?.width ?? null,
    fileHeight: file?.height ?? null,
    fileDuration: file?.duration ?? null,
  };
}

async function storeTelegramMessage(args: {
  readonly db: Db;
  readonly scope: TelegramMessageScope;
  readonly chatId: string;
  readonly message: TelegramMessage;
}): Promise<void> {
  const file = extractTelegramFileForContext(args.message);
  await args.db
    .insert(telegramMessages)
    .values({
      installationId:
        args.scope.kind === "custom" ? args.scope.installationId : null,
      officialOrgId: args.scope.kind === "official" ? args.scope.orgId : null,
      officialUserLinkId:
        args.scope.kind === "official" ? args.scope.userLinkId : null,
      chatId: args.chatId,
      messageId: String(args.message.message_id),
      fromUserId: String(args.message.from?.id ?? 0),
      fromUsername: args.message.from?.username ?? null,
      fromDisplayName: formatTelegramUserDisplayName(args.message.from ?? {}),
      text: args.message.text ?? args.message.caption ?? null,
      ...telegramFileDbValues(file),
      entities: extractEntities(args.message)
        ? [...extractEntities(args.message)!]
        : null,
      isBot: args.message.from?.is_bot ?? false,
    })
    .onConflictDoNothing();
}

function formatTelegramFileForContext(
  file: TelegramFileContext,
  botId: string,
): string {
  const details = [
    `type=${file.file_type}`,
    file.file_name ? `name=${file.file_name}` : null,
    file.mime_type ? `mime=${file.mime_type}` : null,
    file.file_size ? `size=${file.file_size}` : null,
    file.width && file.height
      ? `dimensions=${file.width}x${file.height}`
      : null,
    file.duration ? `duration=${file.duration}s` : null,
  ].filter((part): part is string => {
    return part !== null;
  });
  return `[Telegram file]\n   [BOT_ID] ${botId}\n   [FILE_ID] ${file.file_id}\n   [DETAILS] ${details.join(", ")}`;
}

function appendTelegramMessageContext(
  prompt: string,
  message: TelegramMessage,
  botId: string,
  canonicalAsset?: CanonicalInputAsset,
): string {
  const file = extractTelegramFileForContext(message);
  if (!file) {
    return prompt;
  }
  const fileContext = canonicalAsset
    ? canonicalInputFilePrompt(canonicalAsset)
    : formatTelegramFileForContext(file, botId);
  return prompt ? `${prompt}\n\n${fileContext}` : fileContext;
}

function formatReplyQuote(
  replyMessage: TelegramMessage["reply_to_message"],
): string | undefined {
  const replyText = replyMessage?.text ?? replyMessage?.caption;
  if (!replyText) {
    return undefined;
  }
  const sender = replyMessage?.from?.username
    ? `@${replyMessage.from.username}`
    : (replyMessage?.from?.first_name ?? "Unknown");
  return `[Replying to ${sender}]\n> ${replyText}`;
}

function enrichTelegramPrompt(message: TelegramMessage): {
  readonly prompt: string;
  readonly userInfoExtras: TelegramUserInfoExtras;
} {
  const from = message.from;
  return {
    prompt: message.text ?? message.caption ?? "",
    userInfoExtras: from
      ? {
          telegramDisplayName: formatTelegramUserDisplayName(from) ?? undefined,
          telegramUsername: from.username ? `@${from.username}` : undefined,
          telegramUserId: String(from.id),
          telegramLanguage: from.language_code,
        }
      : {},
  };
}

function normalizedBotUsername(botUsername: string | null | undefined): string {
  return botUsername?.replace(/^@/, "").trim() ?? "";
}

function isTelegramReplyToBotId(
  message: TelegramMessage,
  botId: string,
): boolean {
  const replyFrom = message.reply_to_message?.from;
  return replyFrom?.is_bot === true && String(replyFrom.id) === botId;
}

function parseBotCommand(
  text: string | undefined,
  botUsername: string | null,
): string | undefined {
  if (!text?.startsWith("/")) {
    return undefined;
  }
  const firstWord = text.split(/\s/u)[0];
  if (!firstWord) {
    return undefined;
  }
  const atIndex = firstWord.indexOf("@");
  if (atIndex === -1) {
    return firstWord.slice(1).toLowerCase();
  }
  const targetUsername = firstWord.slice(atIndex + 1);
  if (
    botUsername &&
    targetUsername.toLowerCase() === botUsername.toLowerCase()
  ) {
    return firstWord.slice(1, atIndex).toLowerCase();
  }
  return undefined;
}

function hasBotMention(
  message: TelegramMessage,
  botUsername: string | null,
): boolean {
  if (!botUsername) {
    return false;
  }
  const source = messageText(message);
  return (extractEntities(message) ?? []).some((entity) => {
    return (
      entity.type === "mention" &&
      source
        .slice(entity.offset, entity.offset + entity.length)
        .toLowerCase() === `@${botUsername.toLowerCase()}`
    );
  });
}

function signConnectParams(args: {
  readonly installationId: string;
  readonly telegramUserId: string;
  readonly timestamp: number;
  readonly botToken: string;
  readonly telegramUsername?: string | null;
  readonly telegramDisplayName?: string | null;
}): string {
  const username = normalizeTelegramUsername(args.telegramUsername);
  const displayName = normalizeTelegramDisplayName(args.telegramDisplayName);
  let data = `${args.installationId}:${args.telegramUserId}:${args.timestamp}`;
  if (username || displayName) {
    data += `:${username ?? ""}`;
  }
  if (displayName) {
    data += `:${displayName}`;
  }
  return createHmac("sha256", args.botToken).update(data).digest("hex");
}

function buildConnectUrl(args: {
  readonly installationId: string;
  readonly telegramUserId: string;
  readonly botToken: string;
  readonly telegramUsername?: string | null;
  readonly telegramDisplayName?: string | null;
  readonly publicBrand: PublicBrand;
}): string {
  const timestamp = Math.floor(now() / 1000);
  const params = new URLSearchParams({
    bot: args.installationId,
    tgUser: args.telegramUserId,
    ts: String(timestamp),
    sig: signConnectParams({ ...args, timestamp }),
  });
  const username = normalizeTelegramUsername(args.telegramUsername);
  const displayName = normalizeTelegramDisplayName(args.telegramDisplayName);
  if (username) {
    params.set("tgUserName", username);
  }
  if (displayName) {
    params.set("tgDisplayName", displayName);
  }
  return `${env("APP_URL")}/telegram/connect?${params.toString()}`;
}

function buildTelegramConnectReplyMarkup(connectUrl: string) {
  return { inline_keyboard: [[{ text: "Connect", url: connectUrl }]] };
}

function buildTelegramPrivateConnectReplyMarkup(botUsername: string | null) {
  const username = normalizedBotUsername(botUsername);
  return username
    ? buildTelegramConnectReplyMarkup(
        `https://t.me/${encodeURIComponent(username)}?start=connect`,
      )
    : undefined;
}

function formatTelegramCommandSuccess(message: string): string {
  return `✅ ${escapeHtml(message)}`;
}

function formatTelegramCommandError(message: string): string {
  return `❌ <b>Error</b>\n${escapeHtml(message)}`;
}

function formatTelegramConnectPrompt(agentName: string): string {
  return `To use ${escapeHtml(agentName)} in Telegram, please connect your account first.`;
}

function formatTelegramPrivateConnectPrompt(
  botUsername: string | null,
  agentName: string,
): string {
  const username = normalizedBotUsername(botUsername);
  if (!username) {
    return `${formatTelegramConnectPrompt(agentName)}\n\nSend me /connect in a private message.`;
  }
  return formatTelegramConnectPrompt(agentName);
}

function formatTelegramAlreadyConnectedMessage(
  botUsername: string | null,
  agentName: string,
): string {
  const username = normalizedBotUsername(botUsername);
  const target = username
    ? `Mention @${username} in a group or send a DM`
    : "Send a DM";
  return `You are already connected.\n${target} to start chatting with ${agentName}.`;
}

function formatTelegramHelpMessage(
  botUsername: string | null,
  agentName: string,
): string {
  const username = normalizedBotUsername(botUsername);
  const label = escapeHtml(agentName);
  const botLabel = username
    ? `@${escapeHtml(username)} Telegram Bot Help`
    : "Telegram Bot Help";
  const groupUsage = username
    ? `• <code>@${escapeHtml(username)} &lt;message&gt;</code> - Send a message to ${label}\n`
    : "";

  return [
    `<b>${botLabel}</b>`,
    "",
    "<b>Commands</b>",
    `• <code>/connect</code> - Connect to ${label}`,
    "• <code>/new_session</code> - Start a new conversation",
    "• <code>/model</code> - Choose your model",
    `• <code>/disconnect</code> - Disconnect from ${label}`,
    "",
    "<b>Usage</b>",
    `${groupUsage}• Send a DM to chat with ${label}`,
  ].join("\n");
}

async function postTelegramMessage(args: {
  readonly botToken: string;
  readonly chatId: string;
  readonly text: string;
  readonly replyToMessageId?: number;
  readonly replyMarkup?: TelegramReplyMarkup;
}): Promise<void> {
  const result = await tapError(
    sendMessage(args.botToken, args.chatId, args.text, {
      replyToMessageId: args.replyToMessageId,
      replyMarkup: args.replyMarkup,
    }),
    (error) => {
      log.warn("Failed to send Telegram message", {
        chatId: args.chatId,
        error,
      });
    },
  );
  if (result?.kind === "telegram-error") {
    log.warn("Telegram rejected message", {
      chatId: args.chatId,
      status: result.status,
      description: result.description,
    });
  }
}

async function sendTypingActionSafely(
  botToken: string,
  chatId: string,
): Promise<void> {
  await tapError(sendChatAction(botToken, chatId, "typing"), (error) => {
    log.debug("Failed to send Telegram typing action", {
      chatId,
      error,
    });
  });
}

const resolveUserLink$ = command(
  async (
    { set },
    args: {
      readonly db: Db;
      readonly installationId: string;
      readonly telegramUserId: string;
      readonly telegramUsername?: string | null;
      readonly telegramDisplayName?: string | null;
    },
    signal: AbortSignal,
  ): Promise<TelegramUserLink | null> => {
    const [direct] = await args.db
      .select()
      .from(telegramUserLinks)
      .where(
        and(
          eq(telegramUserLinks.telegramUserId, args.telegramUserId),
          eq(telegramUserLinks.installationId, args.installationId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (direct) {
      const linked = await set(
        linkTelegramUser$,
        {
          installationId: args.installationId,
          telegramUserId: args.telegramUserId,
          telegramUsername: args.telegramUsername,
          telegramDisplayName: args.telegramDisplayName,
          userId: direct.userId,
        },
        signal,
      );
      signal.throwIfAborted();
      return linked.ok ? linked.userLink : direct;
    }

    const [pending] = await args.db
      .select()
      .from(telegramUserLinks)
      .where(
        and(
          eq(telegramUserLinks.installationId, args.installationId),
          eq(telegramUserLinks.telegramUserId, PENDING_TELEGRAM_USER_ID),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!pending) {
      return null;
    }

    const completed = await set(
      linkTelegramUser$,
      {
        installationId: args.installationId,
        telegramUserId: args.telegramUserId,
        telegramUsername: args.telegramUsername,
        telegramDisplayName: args.telegramDisplayName,
        userId: pending.userId,
      },
      signal,
    );
    signal.throwIfAborted();
    return completed.ok ? completed.userLink : null;
  },
);

const resolveOfficialUserLink$ = command(
  async (
    { set },
    args: {
      readonly db: Db;
      readonly telegramUserId: string;
      readonly telegramUsername?: string | null;
      readonly telegramDisplayName?: string | null;
    },
    signal: AbortSignal,
  ): Promise<OfficialTelegramUserLink | null> => {
    const [direct] = await args.db
      .select()
      .from(telegramOfficialUserLinks)
      .where(eq(telegramOfficialUserLinks.telegramUserId, args.telegramUserId))
      .limit(1);
    signal.throwIfAborted();
    if (!direct) {
      return null;
    }

    const linked = await set(
      linkOfficialTelegramUser$,
      {
        telegramUserId: args.telegramUserId,
        telegramUsername: args.telegramUsername,
        telegramDisplayName: args.telegramDisplayName,
        userId: direct.userId,
        orgId: direct.orgId,
        publicBrand: direct.publicBrand,
      },
      signal,
    );
    signal.throwIfAborted();
    return linked.ok ? linked.userLink : direct;
  },
);

async function sendConnectPrompt(args: {
  readonly botToken: string;
  readonly botId: string;
  readonly botUsername: string | null;
  readonly chatId: string;
  readonly chatType: string;
  readonly fromUserId: string;
  readonly telegramUsername?: string | null;
  readonly telegramDisplayName?: string | null;
  readonly agentName: string;
  readonly publicBrand: PublicBrand;
  readonly replyToMessageId?: number;
}): Promise<void> {
  if (args.chatType !== "private") {
    await postTelegramMessage({
      botToken: args.botToken,
      chatId: args.chatId,
      text: formatTelegramPrivateConnectPrompt(
        args.botUsername,
        args.agentName,
      ),
      replyToMessageId: args.replyToMessageId,
      replyMarkup: buildTelegramPrivateConnectReplyMarkup(args.botUsername),
    });
    return;
  }

  const connectUrl = buildConnectUrl({
    installationId: args.botId,
    telegramUserId: args.fromUserId,
    botToken: args.botToken,
    telegramUsername: args.telegramUsername,
    telegramDisplayName: args.telegramDisplayName,
    publicBrand: args.publicBrand,
  });
  await postTelegramMessage({
    botToken: args.botToken,
    chatId: args.chatId,
    text: formatTelegramConnectPrompt(args.agentName),
    replyMarkup: buildTelegramConnectReplyMarkup(connectUrl),
  });
}

function formatContextMessage(args: {
  readonly row: {
    readonly fromUsername: string | null;
    readonly fromDisplayName: string | null;
    readonly fromUserId: string;
    readonly text: string | null;
    readonly fileId: string | null;
    readonly fileType: string | null;
    readonly fileName: string | null;
    readonly fileMimeType: string | null;
    readonly fileSize: number | null;
    readonly fileWidth: number | null;
    readonly fileHeight: number | null;
    readonly fileDuration: number | null;
    readonly isBot: boolean;
    readonly messageId: string;
  };
  readonly relativeIndex: number;
  readonly botId: string;
}): string {
  const senderParts = args.row.isBot
    ? ["id: BOT"]
    : [`id: ${args.row.fromUserId}`];
  if (!args.row.isBot && args.row.fromUsername) {
    senderParts.push(`username: @${args.row.fromUsername}`);
  }
  if (!args.row.isBot && args.row.fromDisplayName) {
    senderParts.push(`name: ${args.row.fromDisplayName}`);
  }

  const parts = [
    "---",
    "",
    `- RELATIVE_INDEX: ${args.relativeIndex}`,
    `- MSG_ID: ${args.row.messageId}`,
    `- SENDER: {${senderParts.join(", ")}}`,
    "",
    args.row.text ?? "",
  ];
  if (args.row.fileId) {
    parts.push(
      formatTelegramFileForContext(
        {
          file_id: args.row.fileId,
          file_type: normalizeTelegramContextFileType(args.row.fileType),
          file_name: args.row.fileName ?? undefined,
          mime_type: args.row.fileMimeType ?? undefined,
          file_size: args.row.fileSize ?? undefined,
          width: args.row.fileWidth ?? undefined,
          height: args.row.fileHeight ?? undefined,
          duration: args.row.fileDuration ?? undefined,
        },
        args.botId,
      ),
    );
  }
  return parts.join("\n");
}

function normalizeTelegramContextFileType(
  fileType: string | null,
): TelegramFileContext["file_type"] {
  switch (fileType) {
    case "document":
    case "video":
    case "audio":
    case "voice":
    case "animation":
    case "video_note":
    case "sticker": {
      return fileType;
    }
    default: {
      return "photo";
    }
  }
}

async function fetchTelegramContext(args: {
  readonly db: Db;
  readonly scope: TelegramMessageScope;
  readonly chatId: string;
  readonly currentMessageId: string;
  readonly botId: string;
}): Promise<string> {
  const rows = await args.db
    .select({
      fromUsername: telegramMessages.fromUsername,
      fromDisplayName: telegramMessages.fromDisplayName,
      fromUserId: telegramMessages.fromUserId,
      text: telegramMessages.text,
      fileId: telegramMessages.fileId,
      fileType: telegramMessages.fileType,
      fileName: telegramMessages.fileName,
      fileMimeType: telegramMessages.fileMimeType,
      fileSize: telegramMessages.fileSize,
      fileWidth: telegramMessages.fileWidth,
      fileHeight: telegramMessages.fileHeight,
      fileDuration: telegramMessages.fileDuration,
      isBot: telegramMessages.isBot,
      messageId: telegramMessages.messageId,
    })
    .from(telegramMessages)
    .where(
      and(
        args.scope.kind === "custom"
          ? eq(telegramMessages.installationId, args.scope.installationId)
          : eq(telegramMessages.officialOrgId, args.scope.orgId),
        eq(telegramMessages.chatId, args.chatId),
      ),
    )
    .orderBy(desc(telegramMessages.createdAt))
    .limit(MAX_CONTEXT_MESSAGES);

  const chronological = rows.reverse().filter((row) => {
    return row.messageId !== args.currentMessageId;
  });
  if (chronological.length === 0) {
    return "";
  }

  const total = chronological.length;
  const blocks = chronological.map((row, index) => {
    return formatContextMessage({
      row,
      relativeIndex: index - total,
      botId: args.botId,
    });
  });

  return [
    "# Telegram Chat Context",
    "",
    "The messages below are from a Telegram conversation. Messages closer to RELATIVE_INDEX 0 are more recent.",
    "",
    blocks.join("\n\n"),
    "",
    "---",
  ].join("\n");
}

function agentMessageScope(args: {
  readonly userLinkKind: "custom" | "official";
  readonly botId: string;
  readonly orgId: string;
  readonly userLinkId: string;
}): TelegramMessageScope {
  return args.userLinkKind === "custom"
    ? { kind: "custom", installationId: args.botId }
    : {
        kind: "official",
        orgId: args.orgId,
        userLinkId: args.userLinkId,
      };
}

function rootMessageIdForAgentMessage(args: {
  readonly isDM: boolean;
  readonly message: TelegramMessage;
  readonly botId: string;
  readonly agentId: string;
  readonly modelRoute: ModelRoutePin | undefined;
}): string | undefined {
  if (args.isDM) {
    return args.message.reply_to_message
      ? String(args.message.reply_to_message.message_id)
      : integrationDmSessionKey({
          agentId: args.agentId,
          selectedModel: args.modelRoute?.selectedModel ?? null,
          serviceTier: args.modelRoute?.serviceTier ?? null,
        });
  }
  return isTelegramReplyToBotId(args.message, args.botId)
    ? String(args.message.reply_to_message?.message_id)
    : undefined;
}

function buildTelegramAgentPrompt(args: {
  readonly message: TelegramMessage;
  readonly botId: string;
  readonly canonicalAsset?: CanonicalInputAsset;
}): {
  readonly prompt: string;
  readonly text: string;
  readonly userInfoExtras: TelegramUserInfoExtras;
} {
  const enriched = enrichTelegramPrompt(args.message);
  const replyQuote = formatReplyQuote(args.message.reply_to_message);
  const promptWithReply = replyQuote
    ? `${replyQuote}\n\n${enriched.prompt}`
    : enriched.prompt;
  return {
    text: promptWithReply,
    prompt: appendTelegramMessageContext(
      promptWithReply,
      args.message,
      args.botId,
      args.canonicalAsset,
    ),
    userInfoExtras: enriched.userInfoExtras,
  };
}

interface TelegramAgentMessageArgs {
  readonly db: Db;
  readonly botToken: string;
  readonly botId: string;
  readonly botUsername: string | null;
  readonly orgId: string;
  readonly userLink: TelegramUserLink | OfficialTelegramUserLink;
  readonly userLinkKind: "custom" | "official";
  readonly publicBrand: PublicBrand;
  readonly composeId: string;
  readonly message: TelegramMessage;
  readonly isDM: boolean;
  readonly apiStartTime: number;
}

function telegramOwnerLink(
  args: Pick<TelegramAgentMessageArgs, "userLink" | "userLinkKind">,
): TelegramOwnerLink {
  return { kind: args.userLinkKind, id: args.userLink.id };
}

async function resetTelegramDmConversation(
  db: Db,
  ownerLink: TelegramOwnerLink,
  chatId: string,
): Promise<void> {
  await db
    .delete(telegramChatThreadRoutes)
    .where(
      and(
        ownerLink.kind === "custom"
          ? eq(telegramChatThreadRoutes.telegramUserLinkId, ownerLink.id)
          : eq(
              telegramChatThreadRoutes.telegramOfficialUserLinkId,
              ownerLink.id,
            ),
        eq(telegramChatThreadRoutes.chatId, chatId),
        or(
          eq(telegramChatThreadRoutes.rootMessageId, "dm"),
          like(
            telegramChatThreadRoutes.rootMessageId,
            `${INTEGRATION_DM_SESSION_PREFIX}%`,
          ),
        ),
      ),
    );
}

function telegramLaunchContext(args: {
  readonly source: TelegramAgentMessageArgs;
  readonly chatId: string;
  readonly rootMessageId: string | undefined;
  readonly context: string;
  readonly prompt: string;
  readonly userInfoExtras: TelegramUserInfoExtras;
}) {
  return {
    chatId: args.chatId,
    messageId: String(args.source.message.message_id),
    messageThreadId: args.source.message.message_thread_id ?? null,
    messageText: args.prompt,
    threadContext: args.context,
    rootMessageId: args.rootMessageId ?? null,
    thinkingMessageId: null,
    publicBrand: args.source.publicBrand,
    userLinkId: args.source.userLink.id,
    userLinkKind: args.source.userLinkKind,
    chatType: args.source.message.chat.type,
    senderUserId: args.userInfoExtras.telegramUserId ?? null,
    senderDisplayName: args.userInfoExtras.telegramDisplayName ?? null,
    senderUsername: args.userInfoExtras.telegramUsername ?? null,
    senderLanguage: args.userInfoExtras.telegramLanguage ?? null,
  };
}

function telegramChatMessageId(args: {
  readonly source: TelegramAgentMessageArgs;
  readonly chatId: string;
}): string {
  return uuidv5(
    [
      args.source.userLinkKind,
      args.source.userLink.id,
      args.chatId,
      args.source.message.message_id,
    ].join(":"),
    TELEGRAM_CHAT_MESSAGE_ID_NAMESPACE,
  );
}

function telegramInputFiles(
  source: TelegramAgentMessageArgs,
  chatId: string,
  file: TelegramInboundFileContext | undefined,
): readonly IntegrationInputFile[] {
  return file
    ? [
        {
          sourceId: file.file_id,
          filename:
            file.file_name ??
            `${file.file_type}-${source.message.message_id}${file.file_type === "photo" ? ".jpg" : ""}`,
          contentType:
            file.mime_type ??
            (file.file_type === "photo" ? "image/jpeg" : undefined),
          size: file.file_size,
          maxBytes: MAX_TELEGRAM_DOWNLOAD_BYTES,
          provenance: {
            provider: "telegram",
            installationId: source.botId,
            messageId: `${chatId}:${source.message.message_id}`,
            externalFileId: file.file_unique_id,
          },
          download: async (downloadSignal) => {
            const metadata = await getFile(
              source.botToken,
              file.file_id,
              downloadSignal,
            );
            if (!metadata.file_path) {
              throw new Error("Telegram file has no download path");
            }
            if ((metadata.file_size ?? 0) > MAX_TELEGRAM_DOWNLOAD_BYTES) {
              throw new InputFileImportError(
                "too-large",
                "Telegram file exceeds the download limit",
              );
            }
            return fetch(
              buildFileDownloadUrl(source.botToken, metadata.file_path),
              { signal: downloadSignal },
            );
          },
        },
      ]
    : [];
}

const persistTelegramChatMessage$ = command(
  async (
    { set },
    args: {
      readonly source: TelegramAgentMessageArgs;
      readonly chatId: string;
      readonly rootMessageId: string | undefined;
      readonly context: string;
      readonly prompt: string;
      readonly userInfoExtras: TelegramUserInfoExtras;
      readonly modelRoute: ModelRoutePin | undefined;
    },
    signal: AbortSignal,
  ): Promise<
    | {
        readonly inserted: true;
        readonly chatThreadId: string;
        readonly chatEventId: string;
      }
    | { readonly inserted: false }
  > => {
    const currentTime = new Date(args.source.apiStartTime);
    const chatEventId = telegramChatMessageId(args);
    const [existingMessage] = await args.source.db
      .select({ id: chatEvents.id })
      .from(chatEvents)
      .where(eq(chatEvents.id, chatEventId))
      .limit(1);
    signal.throwIfAborted();
    if (existingMessage) {
      return { inserted: false };
    }
    const threadArgs = {
      userId: args.source.userLink.userId,
      orgId: args.source.orgId,
      agentId: args.source.composeId,
      selectedModel: args.modelRoute?.selectedModel ?? null,
      serviceTier: args.modelRoute?.serviceTier ?? null,
      currentTime,
    };
    const binding =
      args.rootMessageId === undefined
        ? await createTelegramChatThread(args.source.db, threadArgs)
        : await ensureTelegramChatThreadRoute(args.source.db, {
            ...threadArgs,
            isDirectMessage: args.source.isDM,
            ownerLink: telegramOwnerLink(args.source),
            chatId: args.chatId,
            rootMessageId: args.rootMessageId,
          });
    signal.throwIfAborted();

    const file = extractTelegramFileForContext(args.source.message);
    const assets = await set(
      materializeIntegrationInputAssets$,
      {
        userId: args.source.userLink.userId,
        orgId: args.source.orgId,
        chatThreadId: binding.chatThreadId,
        publicBrand: args.source.publicBrand,
        files: telegramInputFiles(args.source, args.chatId, file),
      },
      signal,
    );
    const canonicalAsset = file
      ? readyIntegrationInputAsset(assets, file.file_id)
      : undefined;
    const runPrompt = buildTelegramAgentPrompt({
      ...args.source,
      canonicalAsset,
    });
    const inserted = await args.source.db.transaction(async (tx) => {
      const event = await insertChatEvent(
        tx,
        {
          id: chatEventId,
          chatThreadId: binding.chatThreadId,
          eventType: "input.prompt",
          content: null,
          userMessage: createUserMessageDocument({
            text: canonicalAsset ? runPrompt.text : args.prompt,
            files: integrationInputMessageFiles(assets),
            nonContentPart: createChatEventSourcePart({
              kind: "telegram",
              chatId: args.chatId,
              messageId: String(args.source.message.message_id),
              isDm: args.source.isDM,
            }),
          }),
          runId: null,
          telegramContext: telegramLaunchContext({
            ...args,
            prompt: runPrompt.prompt,
          }),
          createdAt: currentTime,
        },
        "id",
      );
      signal.throwIfAborted();
      if (!event) {
        return false;
      }
      if (args.source.isDM && args.source.message.reply_to_message) {
        await bindTelegramReplyMessageRoute(tx, {
          ownerLink: telegramOwnerLink(args.source),
          chatId: args.chatId,
          rootMessageId: String(args.source.message.message_id),
          chatThreadId: binding.chatThreadId,
          currentTime,
        });
        signal.throwIfAborted();
      }
      await touchChatThreadLastMessageAt(
        tx,
        binding.chatThreadId,
        currentTime,
        chatEventId,
      );
      return true;
    });
    signal.throwIfAborted();
    return inserted
      ? {
          inserted: true,
          chatThreadId: binding.chatThreadId,
          chatEventId,
        }
      : { inserted: false };
  },
);

async function telegramMessageDispatchState(
  db: Db,
  args: {
    readonly chatThreadId: string;
    readonly chatEventId: string;
  },
): Promise<TelegramMessageDispatchResult> {
  const [[run], [queued]] = await Promise.all([
    db
      .select({ runId: agentRuns.id, status: agentRuns.status })
      .from(chatEvents)
      .innerJoin(agentRuns, eq(agentRuns.id, chatEvents.runId))
      .where(
        chatInputPromptDispatchCondition({
          eventId: args.chatEventId,
          chatThreadId: args.chatThreadId,
        }),
      )
      .limit(1),
    db
      .select({ id: chatEvents.id })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.id, args.chatEventId),
          eq(chatEvents.chatThreadId, args.chatThreadId),
          chatEventTypeIn(["input.prompt"]),
          isNull(chatEvents.runId),
          notExists(
            db
              .select({ id: telegramQueueEventRevoker.id })
              .from(telegramQueueEventRevoker)
              .where(
                eq(telegramQueueEventRevoker.revokesEventId, chatEvents.id),
              ),
          ),
        ),
      )
      .limit(1),
  ]);
  if (queued || run?.status === "queued") {
    return {
      kind: "queued",
      ...(run ? { runId: run.runId } : {}),
    };
  }
  return {
    kind: "accepted",
    ...(run ? { runId: run.runId } : {}),
  };
}

const runAgentForTelegram$ = command(
  async (
    { set },
    args: {
      readonly source: TelegramAgentMessageArgs;
      readonly chatId: string;
      readonly rootMessageId: string | undefined;
      readonly context: string;
      readonly prompt: string;
      readonly userInfoExtras: TelegramUserInfoExtras;
      readonly modelRoute: ModelRoutePin | undefined;
    },
    signal: AbortSignal,
  ): Promise<TelegramMessageDispatchResult> => {
    const persisted = await set(
      persistTelegramChatMessage$,
      {
        ...args,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!persisted.inserted) {
      return { kind: "ignored" };
    }

    await publishChatThreadMessageCreatedSafely({
      userId: args.source.userLink.userId,
      orgId: args.source.orgId,
      threadId: persisted.chatThreadId,
    });
    signal.throwIfAborted();
    await publishThreadListChanged({
      userId: args.source.userLink.userId,
      orgId: args.source.orgId,
    });
    signal.throwIfAborted();
    await set(
      drainChatThreadQueueForThread$,
      {
        chatThreadId: persisted.chatThreadId,
        dispatchFailedCallbacks: dispatchFailedRunCallbacks,
      },
      signal,
    );
    signal.throwIfAborted();
    return await telegramMessageDispatchState(args.source.db, persisted);
  },
);

const handleTelegramAgentMessage$ = command(
  async (
    { set },
    args: TelegramAgentMessageArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    const chatId = String(args.message.chat.id);
    const agent = await getWorkspaceAgent(args.db, args.composeId);
    signal.throwIfAborted();
    if (!agent) {
      await postTelegramMessage({
        botToken: args.botToken,
        chatId,
        text:
          args.userLinkKind === "official"
            ? `The workspace default agent is not configured. Please choose an agent in ${PUBLIC_BRAND_PRESENTATION.brandName} first.`
            : "The agent is not available. Please contact the admin.",
        replyToMessageId: args.message.message_id,
      });
      signal.throwIfAborted();
      return;
    }

    await sendTypingActionSafely(args.botToken, chatId);
    signal.throwIfAborted();
    const scope = agentMessageScope({
      userLinkKind: args.userLinkKind,
      botId: args.botId,
      orgId: args.orgId,
      userLinkId: args.userLink.id,
    });
    await storeTelegramMessage({
      db: args.db,
      scope,
      chatId,
      message: args.message,
    });
    signal.throwIfAborted();

    const modelRoute = await set(
      resolveIntegrationModelRouteForUser$,
      {
        orgId: args.orgId,
        userId: args.userLink.userId,
      },
      signal,
    );
    signal.throwIfAborted();
    const rootMessageId = rootMessageIdForAgentMessage({
      ...args,
      agentId: args.composeId,
      modelRoute,
    });
    const context = await fetchTelegramContext({
      db: args.db,
      scope,
      chatId,
      currentMessageId: String(args.message.message_id),
      botId: args.botId,
    });
    signal.throwIfAborted();

    const runPrompt = buildTelegramAgentPrompt(args);
    const result = await set(
      runAgentForTelegram$,
      {
        source: args,
        chatId,
        rootMessageId,
        context,
        prompt: runPrompt.prompt,
        userInfoExtras: runPrompt.userInfoExtras,
        modelRoute,
      },
      signal,
    );
    signal.throwIfAborted();

    if (result.kind === "queued") {
      await postTelegramMessage({
        botToken: args.botToken,
        chatId,
        text: QUEUED_MESSAGE,
        replyToMessageId: args.message.message_id,
      });
      signal.throwIfAborted();
      return;
    }
  },
);

const handleModelCommand$ = command(
  async (
    { get, set },
    args: {
      readonly botToken: string;
      readonly message: TelegramMessage;
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const visibleModels = new Set(getBuiltInVisibleModels());
    const [policies, preference] = await Promise.all([
      set(
        listOrgModelPolicies$,
        { orgId: args.orgId, userId: args.userId },
        signal,
      ),
      get(userModelPreference({ orgId: args.orgId, userId: args.userId })),
    ]);
    signal.throwIfAborted();
    const options = policies.policies.flatMap((policy) => {
      if (
        !isSupportedRunModel(policy.model) ||
        !visibleModels.has(policy.model) ||
        policy.routeStatus !== "valid"
      ) {
        return [];
      }
      return {
        model: policy.model,
        label: policy.modelLabel,
        isDefault: policy.isDefault,
      };
    });
    const chatId = String(args.message.chat.id);
    const replyToMessageId =
      args.message.chat.type === "private"
        ? undefined
        : args.message.message_id;
    if (options.length === 0) {
      await postTelegramMessage({
        botToken: args.botToken,
        chatId,
        text: formatTelegramCommandError(
          "No models are configured for this workspace.",
        ),
        replyToMessageId,
      });
      signal.throwIfAborted();
      return;
    }

    const input = commandArgument(args.message.text ?? args.message.caption);
    if (!input) {
      await postTelegramMessage({
        botToken: args.botToken,
        chatId,
        text: formatTelegramModelOptionsMessage(
          options,
          preference.selectedModel,
        ),
        replyToMessageId,
      });
      signal.throwIfAborted();
      return;
    }

    const option = findModelOption(options, input);
    if (!option) {
      await postTelegramMessage({
        botToken: args.botToken,
        chatId,
        text: [
          formatTelegramCommandError(`Unknown model "${input}".`),
          "",
          formatTelegramModelOptionsMessage(options, preference.selectedModel),
        ].join("\n"),
        replyToMessageId,
      });
      signal.throwIfAborted();
      return;
    }

    await set(
      updateUserModelPreference$,
      {
        orgId: args.orgId,
        userId: args.userId,
        preference: { selectedModel: option.model, serviceTier: null },
      },
      signal,
    );
    signal.throwIfAborted();
    await postTelegramMessage({
      botToken: args.botToken,
      chatId,
      text: formatTelegramCommandSuccess(`Switched to ${option.label}.`),
      replyToMessageId,
    });
  },
);

function commandArgument(text: string | undefined): string {
  const trimmed = text?.trim();
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
    readonly model: SupportedRunModel;
    readonly label: string;
    readonly isDefault: boolean;
  }[],
  input: string,
) {
  const normalizedInput = normalizeRunModelId(input.trim());
  const inputKeys = new Set([
    lookupKey(input),
    lookupKey(normalizedInput),
    compactLookupKey(input),
    compactLookupKey(normalizedInput),
  ]);
  return options.find((option) => {
    return [
      option.model,
      normalizeRunModelId(option.model),
      option.label,
      getCanonicalModelDisplayName(option.model),
    ].some((value) => {
      return (
        inputKeys.has(lookupKey(value)) ||
        inputKeys.has(compactLookupKey(value))
      );
    });
  });
}

function formatTelegramModelOptionsMessage(
  options: readonly {
    readonly model: SupportedRunModel;
    readonly label: string;
    readonly isDefault: boolean;
  }[],
  currentSelectedModel: string | null,
): string {
  const optionLines = options.map((option) => {
    const markers = [
      option.model === currentSelectedModel ? "current" : null,
      option.isDefault ? "workspace default" : null,
    ].filter((marker): marker is string => {
      return marker !== null;
    });
    const suffix = markers.length > 0 ? ` (${markers.join(", ")})` : "";
    return `• <code>/model ${escapeHtml(option.model)}</code> - ${escapeHtml(
      option.label,
    )}${escapeHtml(suffix)}`;
  });

  const current = currentSelectedModel
    ? getCanonicalModelDisplayName(currentSelectedModel)
    : "workspace default";
  return [
    "<b>Available models</b>",
    "",
    `Current: <b>${escapeHtml(current)}</b>`,
    "",
    "Send one of these commands to switch:",
    ...optionLines,
  ].join("\n");
}

interface CustomCommandArgs {
  readonly db: Db;
  readonly installation: CanonicalTelegramInstallation;
  readonly botToken: string;
  readonly command: string;
  readonly message: TelegramMessage;
  readonly publicBrand: PublicBrand;
}

const handleCustomCommand$ = command(
  async (
    { set },
    args: CustomCommandArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    const chatId = String(args.message.chat.id);
    const fromUserId = String(args.message.from?.id ?? 0);
    const displayName = formatTelegramUserDisplayName(args.message.from ?? {});
    const replyToMessageId =
      args.message.chat.type === "private"
        ? undefined
        : args.message.message_id;
    const userLink = await set(
      resolveUserLink$,
      {
        db: args.db,
        installationId: args.installation.telegramBotId,
        telegramUserId: fromUserId,
        telegramUsername: args.message.from?.username ?? null,
        telegramDisplayName: displayName,
      },
      signal,
    );
    signal.throwIfAborted();
    const agentName = await getWorkspaceAgentDisplayLabel(
      args.db,
      args.installation.defaultAgentId,
    );
    signal.throwIfAborted();
    const reply = async (text: string, sig: AbortSignal): Promise<void> => {
      await postTelegramMessage({
        botToken: args.botToken,
        chatId,
        text,
        replyToMessageId,
      });
      sig.throwIfAborted();
    };
    const connectPrompt = (sig: AbortSignal): Promise<void> => {
      sig.throwIfAborted();
      return sendCustomConnectPrompt({
        db: args.db,
        botToken: args.botToken,
        installation: args.installation,
        message: args.message,
        chatId,
        displayName,
        fromUserId,
        agentName,
        publicBrand: args.publicBrand,
        replyToMessageId,
      });
    };

    if (args.command === "help") {
      await reply(
        formatTelegramHelpMessage(args.installation.botUsername, agentName),
        signal,
      );
      return;
    }

    if (args.command === "connect" || args.command === "start") {
      if (userLink) {
        await reply(
          formatTelegramCommandSuccess(
            formatTelegramAlreadyConnectedMessage(
              args.installation.botUsername,
              agentName,
            ),
          ),
          signal,
        );
        return;
      }
      await connectPrompt(signal);
      return;
    }

    if (!userLink) {
      await connectPrompt(signal);
      return;
    }

    if (args.command === "disconnect") {
      await args.db
        .delete(telegramUserLinks)
        .where(eq(telegramUserLinks.id, userLink.id));
      signal.throwIfAborted();
      await reply(
        formatTelegramCommandSuccess(
          `You have been disconnected and your access to ${agentName} has been revoked.`,
        ),
        signal,
      );
      return;
    }

    if (args.command === "new_session") {
      if (args.message.chat.type !== "private") {
        return;
      }
      await resetTelegramDmConversation(
        args.db,
        { kind: "custom", id: userLink.id },
        chatId,
      );
      signal.throwIfAborted();
      await reply(formatTelegramCommandSuccess("New session started."), signal);
      return;
    }

    if (args.command === "model") {
      await set(
        handleModelCommand$,
        {
          botToken: args.botToken,
          message: args.message,
          orgId: args.installation.orgId,
          userId: userLink.userId,
        },
        signal,
      );
    }
  },
);

async function resolveOfficialComposeId(
  db: Db,
  userLink: OfficialTelegramUserLink,
): Promise<string | null> {
  const [preference] = await db
    .select({
      selectedAgentId: telegramUserAgentPreferences.selectedAgentId,
    })
    .from(telegramUserAgentPreferences)
    .where(
      and(
        eq(telegramUserAgentPreferences.userId, userLink.userId),
        eq(telegramUserAgentPreferences.orgId, userLink.orgId),
      ),
    )
    .limit(1);
  if (preference?.selectedAgentId) {
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.id, preference.selectedAgentId),
          eq(agents.orgId, userLink.orgId),
        ),
      )
      .limit(1);
    if (agent) {
      return agent.id;
    }
  }
  const [metadata] = await db
    .select({ defaultAgentId: orgMetadata.defaultAgentId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, userLink.orgId))
    .limit(1);
  return metadata?.defaultAgentId ?? null;
}

const handleOfficialCommand$ = command(
  async (
    { set },
    args: {
      readonly db: Db;
      readonly botToken: string;
      readonly botUsername: string | null;
      readonly command: string;
      readonly message: TelegramMessage;
      readonly publicBrand: PublicBrand;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const chatId = String(args.message.chat.id);
    const fromUserId = String(args.message.from?.id ?? 0);
    const displayName = formatTelegramUserDisplayName(args.message.from ?? {});
    const replyToMessageId =
      args.message.chat.type === "private"
        ? undefined
        : args.message.message_id;
    const userLink = await set(
      resolveOfficialUserLink$,
      {
        db: args.db,
        telegramUserId: fromUserId,
        telegramUsername: args.message.from?.username ?? null,
        telegramDisplayName: displayName,
      },
      signal,
    );
    signal.throwIfAborted();
    const presentation = PUBLIC_BRAND_PRESENTATION;
    const assistantName = presentation.assistantName;
    const reply = async (text: string, sig: AbortSignal): Promise<void> => {
      await postTelegramMessage({
        botToken: args.botToken,
        chatId,
        text,
        replyToMessageId,
      });
      sig.throwIfAborted();
    };
    const connectPrompt = (sig: AbortSignal): Promise<void> => {
      sig.throwIfAborted();
      return sendConnectPrompt({
        botToken: args.botToken,
        botId: OFFICIAL_TELEGRAM_BOT_ID,
        botUsername: args.botUsername,
        chatId,
        chatType: args.message.chat.type,
        fromUserId,
        telegramUsername: args.message.from?.username ?? null,
        telegramDisplayName: displayName,
        agentName: assistantName,
        publicBrand: args.publicBrand,
        replyToMessageId,
      });
    };

    if (args.command === "help") {
      await reply(
        formatTelegramHelpMessage(args.botUsername, assistantName),
        signal,
      );
      return;
    }

    if (args.command === "connect" || args.command === "start") {
      if (userLink) {
        await reply(
          formatTelegramCommandSuccess(
            formatTelegramAlreadyConnectedMessage(
              args.botUsername,
              assistantName,
            ),
          ),
          signal,
        );
        return;
      }
      await connectPrompt(signal);
      return;
    }

    if (!userLink) {
      await connectPrompt(signal);
      return;
    }

    if (args.command === "disconnect") {
      await args.db
        .delete(telegramOfficialUserLinks)
        .where(eq(telegramOfficialUserLinks.id, userLink.id));
      signal.throwIfAborted();
      await reply(
        formatTelegramCommandSuccess(
          `Your ${presentation.brandName} account has been disconnected from this Telegram bot.`,
        ),
        signal,
      );
      return;
    }

    if (args.command === "new_session") {
      if (args.message.chat.type !== "private") {
        return;
      }
      await resetTelegramDmConversation(
        args.db,
        { kind: "official", id: userLink.id },
        chatId,
      );
      signal.throwIfAborted();
      await reply(formatTelegramCommandSuccess("New session started."), signal);
      return;
    }

    if (args.command === "model") {
      await set(
        handleModelCommand$,
        {
          botToken: args.botToken,
          message: args.message,
          orgId: userLink.orgId,
          userId: userLink.userId,
        },
        signal,
      );
    }
  },
);

interface CustomWebhookContext {
  readonly db: Db;
  readonly installation: CanonicalTelegramInstallation;
  readonly botToken: string;
  readonly message: TelegramMessage;
  readonly apiStartTime: number;
  readonly publicBrand: PublicBrand;
}

const resolveCustomMessageUserLink$ = command(
  async (
    { set },
    args: {
      readonly db: Db;
      readonly installationId: string;
      readonly message: TelegramMessage;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly userLink: TelegramUserLink | null;
    readonly displayName: string | null;
    readonly fromUserId: string;
  }> => {
    const displayName = formatTelegramUserDisplayName(args.message.from ?? {});
    const fromUserId = String(args.message.from?.id ?? 0);
    const userLink = await set(
      resolveUserLink$,
      {
        db: args.db,
        installationId: args.installationId,
        telegramUserId: fromUserId,
        telegramUsername: args.message.from?.username ?? null,
        telegramDisplayName: displayName,
      },
      signal,
    );
    signal.throwIfAborted();
    return { userLink, displayName, fromUserId };
  },
);

async function sendCustomConnectPrompt(args: {
  readonly db: Db;
  readonly botToken: string;
  readonly installation: CanonicalTelegramInstallation;
  readonly message: TelegramMessage;
  readonly chatId: string;
  readonly displayName: string | null;
  readonly fromUserId: string;
  readonly agentName?: string;
  readonly publicBrand: PublicBrand;
  readonly replyToMessageId?: number;
}): Promise<void> {
  const agentName =
    args.agentName ??
    (await getWorkspaceAgentDisplayLabel(
      args.db,
      args.installation.defaultAgentId,
    ));
  await sendConnectPrompt({
    botToken: args.botToken,
    botId: args.installation.telegramBotId,
    botUsername: args.installation.botUsername,
    chatId: args.chatId,
    chatType: args.message.chat.type,
    fromUserId: args.fromUserId,
    telegramUsername: args.message.from?.username ?? null,
    telegramDisplayName: args.displayName,
    agentName,
    publicBrand: args.publicBrand,
    replyToMessageId: args.replyToMessageId,
  });
}

const handleCustomPrivateWebhookMessage$ = command(
  async (
    { set },
    args: CustomWebhookContext,
    signal: AbortSignal,
  ): Promise<void> => {
    const chatId = String(args.message.chat.id);
    const resolved = await set(
      resolveCustomMessageUserLink$,
      {
        db: args.db,
        installationId: args.installation.telegramBotId,
        message: args.message,
      },
      signal,
    );
    if (!resolved.userLink) {
      await sendCustomConnectPrompt({ ...args, chatId, ...resolved });
      signal.throwIfAborted();
      return;
    }
    await set(
      handleTelegramAgentMessage$,
      {
        db: args.db,
        botToken: args.botToken,
        botId: args.installation.telegramBotId,
        botUsername: args.installation.botUsername,
        orgId: args.installation.orgId,
        userLink: resolved.userLink,
        userLinkKind: "custom",
        publicBrand: args.publicBrand,
        composeId: args.installation.defaultAgentId,
        message: args.message,
        isDM: true,
        apiStartTime: args.apiStartTime,
      },
      signal,
    );
  },
);

function isCustomGroupAddressed(
  message: TelegramMessage,
  botId: string,
  botUsername: string | null,
): boolean {
  return (
    hasBotMention(message, botUsername) ||
    isTelegramReplyToBotId(message, botId)
  );
}

const handleCustomAddressedGroupWebhookMessage$ = command(
  async (
    { set },
    args: CustomWebhookContext,
    signal: AbortSignal,
  ): Promise<void> => {
    const chatId = String(args.message.chat.id);
    const resolved = await set(
      resolveCustomMessageUserLink$,
      {
        db: args.db,
        installationId: args.installation.telegramBotId,
        message: args.message,
      },
      signal,
    );
    if (!resolved.userLink) {
      await sendCustomConnectPrompt({
        ...args,
        chatId,
        ...resolved,
        replyToMessageId: args.message.message_id,
      });
      signal.throwIfAborted();
      return;
    }
    await set(
      handleTelegramAgentMessage$,
      {
        db: args.db,
        botToken: args.botToken,
        botId: args.installation.telegramBotId,
        botUsername: args.installation.botUsername,
        orgId: args.installation.orgId,
        userLink: resolved.userLink,
        userLinkKind: "custom",
        publicBrand: args.publicBrand,
        composeId: args.installation.defaultAgentId,
        message: args.message,
        isDM: false,
        apiStartTime: args.apiStartTime,
      },
      signal,
    );
  },
);

const processCustomWebhookMessage$ = command(
  async (
    { get, set },
    args: {
      readonly telegramBotId: string;
      readonly message: TelegramMessage;
      readonly apiStartTime: number;
      readonly publicBrand: PublicBrand;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const [row] = await db
      .select({
        installation: telegramInstallations,
        defaultAgentId: agents.id,
      })
      .from(telegramInstallations)
      .innerJoin(
        agents,
        and(
          eq(agents.id, telegramInstallations.defaultAgentId),
          eq(agents.orgId, telegramInstallations.orgId),
        ),
      )
      .where(eq(telegramInstallations.telegramBotId, args.telegramBotId))
      .limit(1);
    signal.throwIfAborted();
    if (!row) {
      return;
    }
    const installation: CanonicalTelegramInstallation = {
      ...row.installation,
      defaultAgentId: row.defaultAgentId,
    };

    const botToken = await decryptPersistentSecretValue(
      installation.encryptedBotToken,
      await get(
        userFeatureSwitchContext(installation.orgId, installation.ownerUserId),
      ),
    );
    signal.throwIfAborted();
    const commandName = parseBotCommand(
      args.message.text ?? args.message.caption,
      installation.botUsername,
    );
    if (commandName) {
      await set(
        handleCustomCommand$,
        {
          db,
          installation,
          botToken,
          command: commandName,
          message: args.message,
          publicBrand: args.publicBrand,
        },
        signal,
      );
      return;
    }

    const chatId = String(args.message.chat.id);
    if (args.message.chat.type === "private") {
      await set(
        handleCustomPrivateWebhookMessage$,
        {
          db,
          installation,
          botToken,
          message: args.message,
          apiStartTime: args.apiStartTime,
          publicBrand: args.publicBrand,
        },
        signal,
      );
      return;
    }

    if (
      isCustomGroupAddressed(
        args.message,
        installation.telegramBotId,
        installation.botUsername,
      )
    ) {
      await set(
        handleCustomAddressedGroupWebhookMessage$,
        {
          db,
          installation,
          botToken,
          message: args.message,
          apiStartTime: args.apiStartTime,
          publicBrand: args.publicBrand,
        },
        signal,
      );
      return;
    }

    await storeTelegramMessage({
      db,
      scope: { kind: "custom", installationId: installation.telegramBotId },
      chatId,
      message: args.message,
    });
  },
);

async function storeUnaddressedOfficialMessage(
  args: {
    readonly db: Db;
    readonly userLink:
      | {
          readonly id: string;
          readonly orgId: string;
        }
      | null
      | undefined;
    readonly chatId: string;
    readonly message: TelegramMessage;
  },
  signal: AbortSignal,
): Promise<void> {
  if (!args.userLink) {
    return;
  }
  await storeTelegramMessage({
    db: args.db,
    scope: {
      kind: "official",
      orgId: args.userLink.orgId,
      userLinkId: args.userLink.id,
    },
    chatId: args.chatId,
    message: args.message,
  });
  signal.throwIfAborted();
}

function getRunnableOfficialTelegramBotConfig() {
  const config = getOfficialTelegramBotConfig();
  if (!config.botToken || !config.botId) {
    return null;
  }
  return { ...config, botToken: config.botToken, botId: config.botId };
}

const processOfficialWebhookMessage$ = command(
  async (
    { set },
    args: {
      readonly message: TelegramMessage;
      readonly apiStartTime: number;
      readonly publicBrand: PublicBrand;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const config = getRunnableOfficialTelegramBotConfig();
    if (!config) {
      return;
    }
    const db = set(writeDb$);
    const commandName = parseBotCommand(
      args.message.text ?? args.message.caption,
      config.botUsername,
    );
    if (commandName) {
      await set(
        handleOfficialCommand$,
        {
          db,
          botToken: config.botToken,
          botUsername: config.botUsername,
          command: commandName,
          message: args.message,
          publicBrand: args.publicBrand,
        },
        signal,
      );
      return;
    }

    const chatId = String(args.message.chat.id);
    const displayName = formatTelegramUserDisplayName(args.message.from ?? {});
    const userLink = await set(
      resolveOfficialUserLink$,
      {
        db,
        telegramUserId: String(args.message.from?.id ?? 0),
        telegramUsername: args.message.from?.username ?? null,
        telegramDisplayName: displayName,
      },
      signal,
    );
    signal.throwIfAborted();

    const isPrivateChat = args.message.chat.type === "private";
    const isAddressed =
      isPrivateChat ||
      hasBotMention(args.message, config.botUsername) ||
      isTelegramReplyToBotId(args.message, config.botId);
    if (!isAddressed) {
      await storeUnaddressedOfficialMessage(
        {
          db,
          userLink,
          chatId,
          message: args.message,
        },
        signal,
      );
      return;
    }

    if (!userLink) {
      await sendConnectPrompt({
        botToken: config.botToken,
        botId: OFFICIAL_TELEGRAM_BOT_ID,
        botUsername: config.botUsername,
        chatId,
        chatType: args.message.chat.type,
        fromUserId: String(args.message.from?.id ?? 0),
        telegramUsername: args.message.from?.username ?? null,
        telegramDisplayName: displayName,
        agentName: PUBLIC_BRAND_PRESENTATION.assistantName,
        publicBrand: args.publicBrand,
        replyToMessageId:
          args.message.chat.type === "private"
            ? undefined
            : args.message.message_id,
      });
      signal.throwIfAborted();
      return;
    }

    const composeId = await resolveOfficialComposeId(db, userLink);
    signal.throwIfAborted();
    if (!composeId) {
      await postTelegramMessage({
        botToken: config.botToken,
        chatId,
        text: `The workspace default agent is not configured. Please choose an agent in ${PUBLIC_BRAND_PRESENTATION.brandName} first.`,
        replyToMessageId:
          args.message.chat.type === "private"
            ? undefined
            : args.message.message_id,
      });
      signal.throwIfAborted();
      return;
    }

    await set(
      handleTelegramAgentMessage$,
      {
        db,
        botToken: config.botToken,
        botId: config.botId,
        botUsername: config.botUsername,
        orgId: userLink.orgId,
        userLink,
        userLinkKind: "official",
        publicBrand: args.publicBrand,
        composeId,
        message: args.message,
        isDM: args.message.chat.type === "private",
        apiStartTime: args.apiStartTime,
      },
      signal,
    );
  },
);

export const telegramWebhook$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<Response> => {
    const apiStartTime = now();
    const request = get(request$).raw;
    const publicBrand = PUBLIC_BRAND;
    const { telegramBotId } = get(
      pathParamsOf(integrationsTelegramContract.webhook),
    );

    if (isOfficialTelegramBotId(telegramBotId)) {
      const config = getOfficialTelegramBotConfig();
      if (!config.botToken || !config.webhookSecret) {
        return textResponse("Not Found", 404);
      }
      if (!verifyTelegramWebhook(request, config.webhookSecret)) {
        return textResponse("Unauthorized", 401);
      }
      const parsed = safeJsonParse(await request.text());
      signal.throwIfAborted();
      if (!isTelegramUpdate(parsed)) {
        return textResponse("Bad Request", 400);
      }
      const message = parsed.message;
      if (!message || !hasTelegramMessageContextContent(message)) {
        return okText();
      }
      waitUntil(
        tapError(
          set(
            processOfficialWebhookMessage$,
            { message, apiStartTime, publicBrand },
            signal,
          ),
          (error) => {
            log.error("Error handling official Telegram webhook", { error });
          },
        ),
      );
      return okText();
    }

    const db = set(writeDb$);
    const [installation] = await db
      .select({
        telegramBotId: telegramInstallations.telegramBotId,
        webhookSecret: telegramInstallations.webhookSecret,
      })
      .from(telegramInstallations)
      .where(eq(telegramInstallations.telegramBotId, telegramBotId))
      .limit(1);
    signal.throwIfAborted();
    if (!installation) {
      return textResponse("Not Found", 404);
    }
    if (!verifyTelegramWebhook(request, installation.webhookSecret)) {
      return textResponse("Unauthorized", 401);
    }

    const parsed = safeJsonParse(await request.text());
    signal.throwIfAborted();
    if (!isTelegramUpdate(parsed)) {
      return textResponse("Bad Request", 400);
    }

    const message = parsed.message;
    if (!message || !hasTelegramMessageContextContent(message)) {
      return okText();
    }

    waitUntil(
      tapError(
        set(
          processCustomWebhookMessage$,
          { telegramBotId, message, apiStartTime, publicBrand },
          signal,
        ),
        (error) => {
          log.error("Error handling Telegram webhook", {
            error,
            telegramBotId,
          });
        },
      ),
    );
    return okText();
  },
);
