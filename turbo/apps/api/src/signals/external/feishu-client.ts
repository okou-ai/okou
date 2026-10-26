import { accept, HttpStatusError } from "@okouai/connectors/accept";
import { settle } from "../utils";
import {
  feishuInstallationAvailabilityReadPlan,
  feishuInstallationEnabledFromRows,
} from "../services/feishu-config";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import {
  FEISHU_PLATFORMS,
  type FeishuPlatform,
} from "@okouai/core/feishu-platform";
import {
  array,
  boolean,
  number,
  object,
  string,
  type infer as zInfer,
} from "zod";

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

const tenantAccessTokenResponseSchema = object({
  code: number(),
  msg: string().optional(),
  tenant_access_token: string().optional(),
  expire: number().optional(),
});

const feishuBotInfoSchema = object({
  open_id: string().optional(),
  app_name: string().optional(),
  avatar_url: string().optional(),
});

const feishuBotInfoResponseSchema = object({
  code: number(),
  msg: string().optional(),
  bot: feishuBotInfoSchema.optional(),
  data: object({ bot: feishuBotInfoSchema.optional() }).optional(),
});

const feishuOAuthTokenResponseSchema = object({
  code: number(),
  msg: string().optional(),
  error: string().optional(),
  error_description: string().optional(),
  access_token: string().optional(),
  refresh_token: string().optional(),
  expires_in: number().optional(),
});

const feishuUserInfoResponseSchema = object({
  code: number(),
  msg: string().optional(),
  data: object({
    name: string().optional(),
    open_id: string().optional(),
    tenant_key: string().optional(),
  }).optional(),
});

const feishuResponseSchema = object({
  code: number(),
  msg: string().optional(),
});

const feishuMessageResponseSchema = feishuResponseSchema.extend({
  data: object({
    message_id: string().optional(),
    chat_id: string().optional(),
  }).optional(),
});

const feishuFileResponseSchema = feishuResponseSchema.extend({
  data: object({ file_key: string().optional() }).optional(),
});

const feishuReactionResponseSchema = feishuResponseSchema.extend({
  data: object({ reaction_id: string().optional() }).optional(),
});

const feishuHistoryMessageSchema = object({
  message_id: string(),
  root_id: string().optional(),
  parent_id: string().optional(),
  thread_id: string().optional(),
  msg_type: string(),
  create_time: string().optional(),
  deleted: boolean().optional(),
  chat_id: string().optional(),
  sender: object({
    id: string().optional(),
    id_type: string().optional(),
    sender_type: string().optional(),
    sender_name: string().optional(),
  }).optional(),
  body: object({ content: string().optional() }).optional(),
  mentions: array(
    object({
      key: string().optional(),
      id: string().optional(),
      name: string().optional(),
    }),
  ).optional(),
});

const feishuMessageHistoryResponseSchema = feishuResponseSchema.extend({
  data: object({
    items: array(feishuHistoryMessageSchema).optional(),
    has_more: boolean().optional(),
    page_token: string().optional(),
  }).optional(),
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

export type FeishuHistoryMessage = zInfer<typeof feishuHistoryMessageSchema>;

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

async function readFeishuOAuthToken(
  pending: Promise<Response>,
  providerName: string,
  operation: "exchange" | "token refresh",
): Promise<FeishuOAuthToken> {
  const result = await settle(accept(pending, [200]));
  let response: Response;
  if (result.ok) {
    response = result.value;
  } else if (result.error instanceof HttpStatusError) {
    response = result.error.response;
  } else {
    throw result.error;
  }
  const parsed = feishuOAuthTokenResponseSchema.parse(await response.json());
  if (parsed.code !== 0) {
    throw new FeishuOAuthTokenError(
      parsed.error_description ??
        parsed.msg ??
        `${providerName} OAuth ${operation} failed`,
      response.status >= 500 ? 502 : 400,
      parsed.code,
      parsed.error,
    );
  }
  if (!result.ok || !parsed.access_token || parsed.expires_in === undefined) {
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

function tokenIsFresh(expiresAt: Date | null): boolean {
  return (
    expiresAt !== null &&
    expiresAt.getTime() > nowDate().getTime() + TOKEN_REFRESH_WINDOW_MS
  );
}

async function readJson(
  response: Response | Promise<Response>,
  providerName: string,
): Promise<unknown> {
  const result = await settle(accept(Promise.resolve(response), [200]));
  if (!result.ok) {
    if (result.error instanceof HttpStatusError) {
      throw new FeishuApiError(
        `${providerName} API returned HTTP ${result.error.status}`,
        result.error.status >= 500 ? 502 : 400,
      );
    }
    throw result.error;
  }
  return result.value.json();
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
  const response = fetch(
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
  const response = fetch(
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
  const response = fetch(
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
  return await readFeishuOAuthToken(response, providerName, "exchange");
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
  const response = fetch(
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
  return await readFeishuOAuthToken(response, providerName, "token refresh");
}

export async function fetchFeishuUserInfo(
  args: {
    readonly userAccessToken: string;
    readonly platform?: FeishuPlatform;
  },
  signal: AbortSignal,
): Promise<FeishuUserInfo> {
  const providerName = FEISHU_PLATFORMS[args.platform ?? "feishu"].name;
  const response = fetch(
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
    const result = await settle(
      accept(
        fetch(url, {
          headers: { authorization: `Bearer ${token}` },
          signal,
        }),
        [200],
      ),
      signal,
    );
    signal.throwIfAborted();
    if (!result.ok) {
      if (result.error instanceof HttpStatusError) {
        throw new FeishuApiError(
          `${providerName} file download returned HTTP ${result.error.status}`,
          result.error.status >= 500 ? 502 : 400,
          result.error.status,
        );
      }
      throw result.error;
    }
    return result.value;
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
    const response = fetch(
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
