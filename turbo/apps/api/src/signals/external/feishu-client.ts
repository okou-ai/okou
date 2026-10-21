import {
  feishuInstallationAvailabilityReadPlan,
  feishuInstallationEnabledFromRows,
} from "../services/feishu-config";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import {
  FEISHU_PLATFORMS,
  type FeishuPlatform,
} from "@okouai/core/feishu-platform";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";

import { db$, writeDb$ } from "./db";
import { command } from "ccstate";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { loadUserFeatureSwitchContext$ } from "../services/feature-switches.service";
import { nowDate } from "../../lib/time";
import {
  decryptPersistentSecretValue,
  encryptPersistentSecretValue,
} from "../services/crypto.utils";

const TOKEN_REFRESH_WINDOW_MS = 3 * 60 * 1000;

const tenantAccessTokenResponseSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  tenant_access_token: z.string().optional(),
  expire: z.number().optional(),
});

const feishuBotInfoSchema = z.object({
  open_id: z.string().optional(),
  app_name: z.string().optional(),
  avatar_url: z.string().optional(),
});

const feishuBotInfoResponseSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  bot: feishuBotInfoSchema.optional(),
  data: z.object({ bot: feishuBotInfoSchema.optional() }).optional(),
});

const feishuOAuthTokenResponseSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
  access_token: z.string().optional(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
});

const feishuUserInfoResponseSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  data: z
    .object({
      name: z.string().optional(),
      open_id: z.string().optional(),
      tenant_key: z.string().optional(),
    })
    .optional(),
});

const feishuResponseSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
});

const feishuMessageResponseSchema = feishuResponseSchema.extend({
  data: z
    .object({
      message_id: z.string().optional(),
      chat_id: z.string().optional(),
    })
    .optional(),
});

const feishuFileResponseSchema = feishuResponseSchema.extend({
  data: z.object({ file_key: z.string().optional() }).optional(),
});

const feishuReactionResponseSchema = feishuResponseSchema.extend({
  data: z.object({ reaction_id: z.string().optional() }).optional(),
});

const feishuHistoryMessageSchema = z.object({
  message_id: z.string(),
  root_id: z.string().optional(),
  parent_id: z.string().optional(),
  thread_id: z.string().optional(),
  msg_type: z.string(),
  create_time: z.string().optional(),
  deleted: z.boolean().optional(),
  chat_id: z.string().optional(),
  sender: z
    .object({
      id: z.string().optional(),
      id_type: z.string().optional(),
      sender_type: z.string().optional(),
      sender_name: z.string().optional(),
    })
    .optional(),
  body: z.object({ content: z.string().optional() }).optional(),
  mentions: z
    .array(
      z.object({
        key: z.string().optional(),
        id: z.string().optional(),
        name: z.string().optional(),
      }),
    )
    .optional(),
});

const feishuMessageHistoryResponseSchema = feishuResponseSchema.extend({
  data: z
    .object({
      items: z.array(feishuHistoryMessageSchema).optional(),
      has_more: z.boolean().optional(),
      page_token: z.string().optional(),
    })
    .optional(),
});

interface FeishuTenantAccessToken {
  readonly token: string;
  readonly expiresInSeconds: number;
}

interface FeishuBotInfo {
  readonly openId: string;
  readonly name: string;
  readonly avatarUrl: string | null;
}

export interface FeishuOutboundMessage {
  readonly msgType: "file" | "interactive" | "text";
  readonly content: Readonly<Record<string, unknown>>;
}

export interface FeishuSentMessage {
  readonly messageId: string;
  readonly chatId: string | null;
}

export type FeishuHistoryMessage = z.infer<typeof feishuHistoryMessageSchema>;

export interface FeishuUserInfo {
  readonly name: string | null;
  readonly openId: string;
  readonly tenantKey: string | null;
}

interface FeishuOAuthToken {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresInSeconds: number;
}

export class FeishuApiError extends Error {
  constructor(
    message: string,
    readonly routeStatus: 400 | 403 | 502,
    readonly upstreamStatusCode?: number,
  ) {
    super(message);
  }
}

export class InvalidFeishuCredentialsError extends FeishuApiError {
  constructor(message: string) {
    super(message, 400);
  }
}

export class FeishuOAuthTokenError extends FeishuApiError {
  constructor(
    message: string,
    routeStatus: 400 | 502,
    readonly code: number,
    readonly oauthError: string | undefined,
  ) {
    super(message, routeStatus);
  }
}

function tokenIsFresh(expiresAt: Date | null): boolean {
  return (
    expiresAt !== null &&
    expiresAt.getTime() > nowDate().getTime() + TOKEN_REFRESH_WINDOW_MS
  );
}

async function readJson(
  response: Response,
  providerName: string,
): Promise<unknown> {
  const body = await response.json();
  if (!response.ok) {
    throw new FeishuApiError(
      `${providerName} API returned HTTP ${response.status}`,
      response.status >= 500 ? 502 : 400,
    );
  }
  return body;
}

export { readJson as readFeishuResponseJson };

export async function fetchFeishuTenantAccessToken(
  args: {
    readonly appId: string;
    readonly platform?: FeishuPlatform;
    readonly appSecret: string;
  },
  signal: AbortSignal,
): Promise<FeishuTenantAccessToken> {
  const providerName = FEISHU_PLATFORMS[args.platform ?? "feishu"].name;
  const response = await fetch(
    `${FEISHU_PLATFORMS[args.platform ?? "feishu"].apiOrigin}/open-apis/auth/v3/tenant_access_token/internal`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        app_id: args.appId,
        app_secret: args.appSecret,
      }),
      signal,
    },
  );
  const parsed = tenantAccessTokenResponseSchema.parse(
    await readJson(response, providerName),
  );
  if (parsed.code !== 0) {
    throw new InvalidFeishuCredentialsError(
      parsed.msg ?? `${providerName} rejected the app credentials`,
    );
  }
  if (!parsed.tenant_access_token || !parsed.expire) {
    throw new FeishuApiError(
      `${providerName} tenant access token response is incomplete`,
      502,
    );
  }
  return {
    token: parsed.tenant_access_token,
    expiresInSeconds: parsed.expire,
  };
}

export async function fetchFeishuBotInfo(
  args: {
    readonly tenantAccessToken: string;
    readonly platform?: FeishuPlatform;
  },
  signal: AbortSignal,
): Promise<FeishuBotInfo> {
  const providerName = FEISHU_PLATFORMS[args.platform ?? "feishu"].name;
  const response = await fetch(
    `${FEISHU_PLATFORMS[args.platform ?? "feishu"].apiOrigin}/open-apis/bot/v3/info`,
    {
      headers: {
        authorization: `Bearer ${args.tenantAccessToken}`,
        "content-type": "application/json; charset=utf-8",
      },
      signal,
    },
  );
  const parsed = feishuBotInfoResponseSchema.parse(
    await readJson(response, providerName),
  );
  if (parsed.code !== 0) {
    throw new FeishuApiError(
      parsed.msg ?? `${providerName} bot info request failed`,
      400,
    );
  }
  const bot = parsed.bot ?? parsed.data?.bot;
  if (!bot?.open_id || !bot.app_name) {
    throw new FeishuApiError(
      `${providerName} bot info response is incomplete`,
      502,
    );
  }
  return {
    openId: bot.open_id,
    name: bot.app_name,
    avatarUrl: bot.avatar_url ?? null,
  };
}

export async function exchangeFeishuOAuthCode(
  args: {
    readonly appId: string;
    readonly platform?: FeishuPlatform;
    readonly appSecret: string;
    readonly code: string;
    readonly redirectUri: string;
  },
  signal: AbortSignal,
): Promise<FeishuOAuthToken> {
  const providerName = FEISHU_PLATFORMS[args.platform ?? "feishu"].name;
  const response = await fetch(
    `${FEISHU_PLATFORMS[args.platform ?? "feishu"].apiOrigin}/open-apis/authen/v2/oauth/token`,
    {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: args.appId,
        client_secret: args.appSecret,
        code: args.code,
        redirect_uri: args.redirectUri,
      }),
      signal,
    },
  );
  const parsed = feishuOAuthTokenResponseSchema.parse(await response.json());
  if (parsed.code !== 0) {
    throw new FeishuOAuthTokenError(
      parsed.error_description ??
        parsed.msg ??
        `${providerName} OAuth exchange failed`,
      response.status >= 500 ? 502 : 400,
      parsed.code,
      parsed.error,
    );
  }
  if (!response.ok || !parsed.access_token || parsed.expires_in === undefined) {
    throw new FeishuApiError(
      `${providerName} OAuth token response is incomplete`,
      502,
    );
  }
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token ?? null,
    expiresInSeconds: parsed.expires_in,
  };
}

export async function refreshFeishuOAuthToken(
  args: {
    readonly appId: string;
    readonly platform?: FeishuPlatform;
    readonly appSecret: string;
    readonly refreshToken: string;
  },
  signal: AbortSignal,
): Promise<FeishuOAuthToken> {
  const providerName = FEISHU_PLATFORMS[args.platform ?? "feishu"].name;
  const response = await fetch(
    `${FEISHU_PLATFORMS[args.platform ?? "feishu"].apiOrigin}/open-apis/authen/v2/oauth/token`,
    {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: args.appId,
        client_secret: args.appSecret,
        refresh_token: args.refreshToken,
      }),
      signal,
    },
  );
  const parsed = feishuOAuthTokenResponseSchema.parse(await response.json());
  if (parsed.code !== 0) {
    throw new FeishuOAuthTokenError(
      parsed.error_description ??
        parsed.msg ??
        `${providerName} OAuth token refresh failed`,
      response.status >= 500 ? 502 : 400,
      parsed.code,
      parsed.error,
    );
  }
  if (!response.ok || !parsed.access_token || parsed.expires_in === undefined) {
    throw new FeishuApiError(
      `${providerName} OAuth token response is incomplete`,
      502,
    );
  }
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token ?? null,
    expiresInSeconds: parsed.expires_in,
  };
}

export async function fetchFeishuUserInfo(
  args: {
    readonly userAccessToken: string;
    readonly platform?: FeishuPlatform;
  },
  signal: AbortSignal,
): Promise<FeishuUserInfo> {
  const providerName = FEISHU_PLATFORMS[args.platform ?? "feishu"].name;
  const response = await fetch(
    `${FEISHU_PLATFORMS[args.platform ?? "feishu"].apiOrigin}/open-apis/authen/v1/user_info`,
    {
      headers: {
        authorization: `Bearer ${args.userAccessToken}`,
        "content-type": "application/json; charset=utf-8",
      },
      signal,
    },
  );
  const parsed = feishuUserInfoResponseSchema.parse(
    await readJson(response, providerName),
  );
  if (parsed.code !== 0) {
    throw new FeishuApiError(
      parsed.msg ?? `${providerName} user info request failed`,
      400,
    );
  }
  if (!parsed.data?.open_id) {
    throw new FeishuApiError(
      `${providerName} user info response is incomplete`,
      502,
    );
  }
  return {
    name: parsed.data.name ?? null,
    openId: parsed.data.open_id,
    tenantKey: parsed.data.tenant_key ?? null,
  };
}

interface FeishuRequestCredentials {
  readonly context: {
    readonly token: string;
    readonly apiOrigin: string;
    readonly providerName: string;
  };
  readonly refreshedToken?: {
    readonly encryptedTenantAccessToken: string;
    readonly expiresInSeconds: number;
  };
}

export async function resolveFeishuRequestCredentials(
  installation: typeof feishuOrgInstallations.$inferSelect,
  signal: AbortSignal,
): Promise<FeishuRequestCredentials> {
  const context = { orgId: installation.orgId };
  const platform = FEISHU_PLATFORMS[installation.platform];
  if (
    installation.encryptedTenantAccessToken &&
    tokenIsFresh(installation.tenantAccessTokenExpiresAt)
  ) {
    return {
      context: {
        token: await decryptPersistentSecretValue(
          installation.encryptedTenantAccessToken,
          context,
        ),
        apiOrigin: platform.apiOrigin,
        providerName: platform.name,
      },
    };
  }
  const appSecret = await decryptPersistentSecretValue(
    installation.encryptedAppSecret,
    context,
  );
  const token = await fetchFeishuTenantAccessToken(
    { appId: installation.appId, platform: installation.platform, appSecret },
    signal,
  );
  const encryptedToken = await encryptPersistentSecretValue(
    token.token,
    context,
  );
  return {
    context: {
      token: token.token,
      apiOrigin: platform.apiOrigin,
      providerName: platform.name,
    },
    refreshedToken: {
      encryptedTenantAccessToken: encryptedToken,
      expiresInSeconds: token.expiresInSeconds,
    },
  };
}

export function feishuTokenUpdateValues(
  token: NonNullable<FeishuRequestCredentials["refreshedToken"]>,
) {
  return {
    encryptedTenantAccessToken: token.encryptedTenantAccessToken,
    tenantAccessTokenExpiresAt: new Date(
      nowDate().getTime() + token.expiresInSeconds * 1000,
    ),
    updatedAt: nowDate(),
  };
}

export const downloadFeishuMessageResource$ = command(
  async (
    { get, set },
    args: {
      readonly installationId: string;
      readonly messageId: string;
      readonly fileKey: string;
      readonly resourceType: "file" | "image";
    },
    signal: AbortSignal,
  ): Promise<Response> => {
    const [installation] = await get(db$)
      .select()
      .from(feishuOrgInstallations)
      .where(eq(feishuOrgInstallations.id, args.installationId))
      .limit(1);
    signal.throwIfAborted();
    if (!installation) {
      throw new Error("Bot installation not found");
    }
    if (installation.platform === "lark") {
      if (!installation.ownerUserId) {
        throw new FeishuApiError("Lark integration is not enabled", 403);
      }
      const context = await set(
        loadUserFeatureSwitchContext$,
        installation.orgId,
        installation.ownerUserId,
        signal,
      );
      signal.throwIfAborted();
      if (!isFeatureEnabled(FEISHU_PLATFORMS.lark.featureSwitch, context)) {
        throw new FeishuApiError("Lark integration is not enabled", 403);
      }
    }
    const credentials = await resolveFeishuRequestCredentials(
      installation,
      signal,
    );
    signal.throwIfAborted();
    if (credentials.refreshedToken) {
      await set(writeDb$)
        .update(feishuOrgInstallations)
        .set(feishuTokenUpdateValues(credentials.refreshedToken))
        .where(eq(feishuOrgInstallations.id, args.installationId));
      signal.throwIfAborted();
    }
    const { token, apiOrigin, providerName } = credentials.context;
    const url = new URL(
      `${apiOrigin}/open-apis/im/v1/messages/${encodeURIComponent(args.messageId)}/resources/${encodeURIComponent(args.fileKey)}`,
    );
    url.searchParams.set("type", args.resourceType);
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal,
    });
    signal.throwIfAborted();
    if (!response.ok) {
      throw new FeishuApiError(
        `${providerName} file download returned HTTP ${response.status}`,
        response.status >= 500 ? 502 : 400,
        response.status,
      );
    }
    return response;
  },
);

export function feishuFileUploadForm(args: {
  readonly filename: string;
  readonly contentType: string;
  readonly content: Buffer;
}): FormData {
  const form = new FormData();
  form.set("file_type", "stream");
  form.set("file_name", args.filename);
  form.set(
    "file",
    new Blob([Uint8Array.from(args.content)], { type: args.contentType }),
    args.filename,
  );
  return form;
}

export function parseFeishuFileUploadResponse(
  value: unknown,
  providerName: string,
): string {
  const parsed = feishuFileResponseSchema.parse(value);
  if (parsed.code !== 0) {
    throw new FeishuApiError(
      parsed.msg ?? `${providerName} file upload failed`,
      400,
    );
  }
  if (!parsed.data?.file_key) {
    throw new FeishuApiError(
      `${providerName} file upload response is incomplete`,
      502,
    );
  }
  return parsed.data.file_key;
}

function messagePayload(message: FeishuOutboundMessage): {
  readonly msg_type: FeishuOutboundMessage["msgType"];
  readonly content: string;
} {
  return {
    msg_type: message.msgType,
    content: JSON.stringify(message.content),
  };
}

function parseSentMessage(
  body: unknown,
  fallbackError: string,
  providerName: string,
): FeishuSentMessage {
  const parsed = feishuMessageResponseSchema.parse(body);
  if (parsed.code !== 0) {
    throw new FeishuApiError(parsed.msg ?? fallbackError, 400);
  }
  if (!parsed.data?.message_id) {
    throw new FeishuApiError(
      `${providerName} message response is incomplete`,
      502,
    );
  }
  return {
    messageId: parsed.data.message_id,
    chatId: parsed.data.chat_id ?? null,
  };
}

export {
  messagePayload as feishuMessagePayload,
  parseSentMessage as parseFeishuSentMessage,
};

export function feishuMessageSendUrl(apiOrigin: string): URL {
  return new URL(`${apiOrigin}/open-apis/im/v1/messages`);
}

export function feishuMessageSendBody(
  receiveId: string,
  payload: ReturnType<typeof messagePayload>,
  idempotencyKey?: string,
) {
  return {
    receive_id: receiveId,
    ...payload,
    ...(idempotencyKey ? { uuid: idempotencyKey } : {}),
  };
}

export const replyWithFeishuMessage$ = command(
  async (
    { set },
    args: {
      readonly installationId: string;
      readonly messageId: string;
      readonly message: FeishuOutboundMessage;
      readonly replyInThread?: boolean;
      readonly idempotencyKey?: string;
    },
    signal: AbortSignal,
  ): Promise<FeishuSentMessage> => {
    const db = set(writeDb$);
    const replyContextArgs = args;
    const replyContextSignal = signal;
    const { token, apiOrigin, providerName } = await (async () => {
      const [installation] = await db
        .select()
        .from(feishuOrgInstallations)
        .where(eq(feishuOrgInstallations.id, replyContextArgs.installationId))
        .limit(1);
      replyContextSignal.throwIfAborted();
      if (!installation) {
        throw new Error("Bot installation not found");
      }
      if (
        !(await (async () => {
          const plan = feishuInstallationAvailabilityReadPlan(installation);
          if (plan.kind === "resolved") {
            return plan.enabled;
          }
          const rows = await db
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
        replyContextSignal,
      );
      if (credentials.refreshedToken) {
        await db
          .update(feishuOrgInstallations)
          .set(feishuTokenUpdateValues(credentials.refreshedToken))
          .where(
            eq(feishuOrgInstallations.id, replyContextArgs.installationId),
          );
        replyContextSignal.throwIfAborted();
      }
      return credentials.context;
    })();
    signal.throwIfAborted();
    const response = await fetch(
      `${apiOrigin}/open-apis/im/v1/messages/${encodeURIComponent(args.messageId)}/reply`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          ...messagePayload(args.message),
          ...(args.replyInThread ? { reply_in_thread: true } : {}),
          ...(args.idempotencyKey ? { uuid: args.idempotencyKey } : {}),
        }),
        signal,
      },
    );
    return parseSentMessage(
      await readJson(response, providerName),
      `${providerName} message reply failed`,
      providerName,
    );
  },
);

export function feishuReactionCreationUrl(
  apiOrigin: string,
  messageId: string,
): string {
  return `${apiOrigin}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`;
}

export function parseFeishuReactionCreationResponse(
  value: unknown,
  providerName: string,
): string {
  const parsed = feishuReactionResponseSchema.parse(value);
  if (parsed.code !== 0) {
    throw new FeishuApiError(
      parsed.msg ?? `${providerName} message reaction failed`,
      400,
    );
  }
  if (!parsed.data?.reaction_id) {
    throw new FeishuApiError(
      `${providerName} message reaction response is incomplete`,
      502,
    );
  }
  return parsed.data.reaction_id;
}

export function feishuReactionRemovalUrl(
  apiOrigin: string,
  messageId: string,
  reactionId: string,
): string {
  return `${apiOrigin}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(reactionId)}`;
}

export function parseFeishuReactionRemovalResponse(
  value: unknown,
  providerName: string,
): void {
  const parsed = feishuResponseSchema.parse(value);
  if (parsed.code !== 0) {
    throw new FeishuApiError(
      parsed.msg ?? `${providerName} message reaction removal failed`,
      400,
    );
  }
}

export function feishuMessageHistoryUrl(
  apiOrigin: string,
  args: {
    readonly containerType: "chat" | "thread";
    readonly containerId: string;
    readonly pageSize?: number;
  },
): URL {
  const url = new URL(`${apiOrigin}/open-apis/im/v1/messages`);
  url.searchParams.set("container_id_type", args.containerType);
  url.searchParams.set("container_id", args.containerId);
  url.searchParams.set("sort_type", "ByCreateTimeDesc");
  url.searchParams.set("page_size", String(args.pageSize ?? 50));
  url.searchParams.set("with_sender_name", "true");
  // The rendered card representation can replace Markdown and artifact links
  // with image previews. Read the original schema for conversation context.
  url.searchParams.set("card_msg_content_type", "user_card_content");
  return url;
}

export function parseFeishuMessageHistoryResponse(
  value: unknown,
  providerName: string,
): readonly FeishuHistoryMessage[] {
  const parsed = feishuMessageHistoryResponseSchema.parse(value);
  if (parsed.code !== 0) {
    throw new FeishuApiError(
      parsed.msg ?? `${providerName} message history request failed`,
      400,
    );
  }
  return parsed.data?.items ?? [];
}
