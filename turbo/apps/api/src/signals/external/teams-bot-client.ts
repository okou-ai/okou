import { Buffer } from "node:buffer";

import { z } from "zod";

import { env, optionalEnv } from "../../lib/env";
import { safeJsonParse, safeUrlParse, settle } from "../utils";

const BOT_FRAMEWORK_SCOPE = "https://api.botframework.com/.default";
const MICROSOFT_GRAPH_SCOPE = "https://graph.microsoft.com/.default";
const DEFAULT_MICROSOFT_GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

const teamsTokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    token_type: z.string().optional(),
    expires_in: z.union([z.number(), z.string()]).optional(),
  })
  .passthrough();

const teamsActivityResponseSchema = z
  .object({
    id: z.string().optional(),
  })
  .passthrough();

const teamsConversationResponseSchema = z
  .object({
    id: z.string().min(1),
  })
  .passthrough();

const teamsGraphIdentitySchema = z
  .object({
    id: z.string().nullable().optional(),
    displayName: z.string().nullable().optional(),
    userPrincipalName: z.string().nullable().optional(),
    mail: z.string().nullable().optional(),
  })
  .passthrough();

const teamsGraphAttachmentSchema = z
  .object({
    id: z.string().nullable().optional(),
    contentType: z.string().nullable().optional(),
    contentUrl: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    content: z.unknown().optional(),
  })
  .passthrough();

const teamsGraphMentionSchema = z
  .object({
    id: z.number().optional(),
    mentionText: z.string().nullable().optional(),
    mentioned: z
      .object({
        user: teamsGraphIdentitySchema.nullable().optional(),
        application: teamsGraphIdentitySchema.nullable().optional(),
        device: teamsGraphIdentitySchema.nullable().optional(),
      })
      .nullable()
      .optional(),
  })
  .passthrough();

const teamsGraphMessageSchema = z
  .object({
    id: z.string().optional(),
    replyToId: z.string().nullable().optional(),
    createdDateTime: z.string().nullable().optional(),
    messageType: z.string().nullable().optional(),
    from: z
      .object({
        user: teamsGraphIdentitySchema.nullable().optional(),
        application: teamsGraphIdentitySchema.nullable().optional(),
        device: teamsGraphIdentitySchema.nullable().optional(),
      })
      .nullable()
      .optional(),
    body: z
      .object({
        content: z.string().nullable().optional(),
        contentType: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
    attachments: z.array(teamsGraphAttachmentSchema).optional(),
    mentions: z.array(teamsGraphMentionSchema).optional(),
  })
  .passthrough();

const teamsGraphMessagesResponseSchema = z
  .object({
    value: z.array(teamsGraphMessageSchema),
  })
  .passthrough();

const teamsGraphChatSchema = z
  .object({
    id: z.string().min(1),
    chatType: z.string().nullable().optional(),
  })
  .passthrough();

const teamsGraphUserInstalledAppSchema = z
  .object({
    id: z.string().min(1),
    teamsApp: z
      .object({
        externalId: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
  })
  .passthrough();

const teamsGraphUserInstalledAppsResponseSchema = z
  .object({
    value: z.array(teamsGraphUserInstalledAppSchema),
  })
  .passthrough();

const teamsGraphUserSchema = z
  .object({
    id: z.string().optional(),
    displayName: z.string().nullable().optional(),
    userPrincipalName: z.string().nullable().optional(),
    mail: z.string().nullable().optional(),
  })
  .passthrough();

type TeamsApiErrorResult = {
  readonly kind: "teams-error";
  readonly status: number;
  readonly error: string;
};

type SendTeamsActivityResult =
  | { readonly kind: "ok"; readonly activityId: string | undefined }
  | TeamsApiErrorResult;

type SendTeamsReactionResult = { readonly kind: "ok" } | TeamsApiErrorResult;

type CreateTeamsConversationResult =
  | { readonly kind: "ok"; readonly conversationId: string }
  | TeamsApiErrorResult;

type FetchTeamsGraphMessageResult =
  | { readonly kind: "ok"; readonly message: TeamsGraphMessage }
  | TeamsApiErrorResult;

type FetchTeamsGraphMessagesResult =
  | { readonly kind: "ok"; readonly messages: readonly TeamsGraphMessage[] }
  | TeamsApiErrorResult;

type FetchTeamsFileResult =
  | { readonly kind: "ok"; readonly response: Response }
  | TeamsApiErrorResult;

export type TeamsGraphMessage = z.infer<typeof teamsGraphMessageSchema>;
export type TeamsGraphAttachment = z.infer<typeof teamsGraphAttachmentSchema>;

export interface TeamsGraphUserInfo {
  readonly id: string;
  readonly displayName: string | null;
  readonly userPrincipalName: string | null;
}

interface TeamsBotCredentials {
  readonly appId: string;
  readonly appPassword: string;
}

export interface TeamsAdaptiveCard {
  readonly type: "AdaptiveCard";
  readonly version: string;
  readonly body?: readonly Readonly<Record<string, unknown>>[];
  readonly actions?: readonly Readonly<Record<string, unknown>>[];
}

interface TeamsAdaptiveCardAttachment {
  readonly contentType: "application/vnd.microsoft.card.adaptive";
  readonly content: TeamsAdaptiveCard;
}

interface TeamsFileAttachment {
  readonly contentType: string;
  readonly contentUrl?: string;
  readonly name?: string;
}

type TeamsActivityAttachment =
  | TeamsAdaptiveCardAttachment
  | TeamsFileAttachment;

export interface TeamsMentionEntity {
  readonly type: "mention";
  readonly text: string;
  readonly mentioned: {
    readonly id: string;
    readonly name?: string;
  };
}

interface TeamsActivityBody {
  readonly type: "message" | "typing";
  readonly text?: string;
  readonly textFormat?: "markdown";
  readonly summary?: string;
  readonly replyToId?: string;
  readonly entities?: readonly TeamsMentionEntity[];
  readonly attachments?: readonly TeamsActivityAttachment[];
  readonly channelData?: {
    readonly tenant?: { readonly id: string };
  };
}

interface TeamsConversationIdentity {
  readonly id: string;
  readonly name?: string;
}

interface TeamsCreateConversationBody {
  readonly bot: TeamsConversationIdentity;
  readonly members: readonly TeamsConversationIdentity[];
  readonly isGroup: false;
  readonly channelData: {
    readonly tenant: { readonly id: string };
  };
}

function teamsBotCredentials(): TeamsBotCredentials | undefined {
  const appId = env("MICROSOFT_TEAMS_BOT_APP_ID");
  const appPassword = env("MICROSOFT_TEAMS_BOT_APP_PASSWORD");
  if (!appId || !appPassword) {
    return undefined;
  }
  return { appId, appPassword };
}

function tenantTokenUrl(tenantId: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(
    tenantId,
  )}/oauth2/v2.0/token`;
}

function botTokenUrl(): string | undefined {
  const configured = optionalEnv("MICROSOFT_TEAMS_BOT_TOKEN_URL");
  if (configured) {
    return configured;
  }
  const appTenantId = env("MICROSOFT_TEAMS_APP_TENANT_ID");
  return appTenantId ? tenantTokenUrl(appTenantId) : undefined;
}

function graphTokenUrl(tenantId: string): string {
  const configured = optionalEnv("MICROSOFT_TEAMS_GRAPH_TOKEN_URL");
  if (configured) {
    return configured;
  }
  return tenantTokenUrl(tenantId);
}

function graphBaseUrl(): string {
  const configured = optionalEnv("MICROSOFT_GRAPH_BASE_URL");
  if (configured) {
    return configured.replace(/\/+$/u, "");
  }
  return DEFAULT_MICROSOFT_GRAPH_BASE_URL;
}

function networkErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Network request failed";
}

function teamsApiError(status: number, error: string): TeamsApiErrorResult {
  return { kind: "teams-error", status, error };
}

async function fetchClientCredentialsAccessToken(
  args: {
    readonly tokenUrl: string;
    readonly scope: string;
  },
  signal: AbortSignal,
): Promise<
  { readonly kind: "ok"; readonly accessToken: string } | TeamsApiErrorResult
> {
  const credentials = teamsBotCredentials();
  if (!credentials) {
    return teamsApiError(
      502,
      "Microsoft Teams bot credentials are not configured",
    );
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: credentials.appId,
    client_secret: credentials.appPassword,
    scope: args.scope,
  });

  const responseResult = await settle(
    fetch(args.tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
      signal,
    }),
    signal,
  );
  if (!responseResult.ok) {
    return teamsApiError(502, networkErrorMessage(responseResult.error));
  }

  const response = responseResult.value;
  if (!response.ok) {
    const text = await response.text();
    signal.throwIfAborted();
    return teamsApiError(
      502,
      text || `OAuth token request failed with HTTP ${response.status}`,
    );
  }

  const parsed = teamsTokenResponseSchema.safeParse(
    safeJsonParse(await response.text()),
  );
  signal.throwIfAborted();
  if (!parsed.success) {
    return teamsApiError(502, "Invalid OAuth token response");
  }

  return { kind: "ok", accessToken: parsed.data.access_token };
}

function fetchTeamsBotAccessToken(
  signal: AbortSignal,
): Promise<
  { readonly kind: "ok"; readonly accessToken: string } | TeamsApiErrorResult
> {
  const tokenUrl = botTokenUrl();
  if (!tokenUrl) {
    return Promise.resolve(
      teamsApiError(502, "Microsoft Teams bot app tenant is not configured"),
    );
  }
  return fetchClientCredentialsAccessToken(
    {
      tokenUrl,
      scope: BOT_FRAMEWORK_SCOPE,
    },
    signal,
  );
}

function fetchTeamsGraphAccessToken(
  args: {
    readonly tenantId: string;
  },
  signal: AbortSignal,
): Promise<
  { readonly kind: "ok"; readonly accessToken: string } | TeamsApiErrorResult
> {
  return fetchClientCredentialsAccessToken(
    {
      tokenUrl: graphTokenUrl(args.tenantId),
      scope: MICROSOFT_GRAPH_SCOPE,
    },
    signal,
  );
}

function teamsConversationActivityUrl(args: {
  readonly serviceUrl: string;
  readonly conversationId: string;
  readonly activityId: string | undefined;
}): string | undefined {
  const parsed = safeUrlParse(args.serviceUrl);
  if (
    !parsed ||
    (parsed.protocol !== "https:" && parsed.protocol !== "http:")
  ) {
    return undefined;
  }

  const serviceUrl = parsed.href.replace(/\/+$/u, "");
  const conversationId = encodeURIComponent(args.conversationId);
  const base = `${serviceUrl}/v3/conversations/${conversationId}/activities`;
  return args.activityId
    ? `${base}/${encodeURIComponent(args.activityId)}`
    : base;
}

function teamsConversationReactionUrl(args: {
  readonly serviceUrl: string;
  readonly conversationId: string;
  readonly activityId: string;
  readonly reactionType: string;
}): string | undefined {
  const activityUrl = teamsConversationActivityUrl({
    serviceUrl: args.serviceUrl,
    conversationId: args.conversationId,
    activityId: args.activityId,
  });
  if (!activityUrl) {
    return undefined;
  }
  return `${activityUrl}/reactions/${encodeURIComponent(args.reactionType)}`;
}

function teamsConversationsUrl(serviceUrl: string): string | undefined {
  const parsed = safeUrlParse(serviceUrl);
  if (
    !parsed ||
    (parsed.protocol !== "https:" && parsed.protocol !== "http:")
  ) {
    return undefined;
  }

  return `${parsed.href.replace(/\/+$/u, "")}/v3/conversations`;
}

function teamsGraphChannelMessageUrl(args: {
  readonly teamId: string;
  readonly channelId: string;
  readonly messageId?: string;
  readonly replies?: boolean;
  readonly limit?: number;
}): string {
  const base = `${graphBaseUrl()}/teams/${encodeURIComponent(
    args.teamId,
  )}/channels/${encodeURIComponent(args.channelId)}/messages`;
  const path = args.messageId
    ? `${base}/${encodeURIComponent(args.messageId)}${
        args.replies ? "/replies" : ""
      }`
    : base;
  const url = new URL(path);
  if (args.limit) {
    url.searchParams.set("$top", String(args.limit));
  }
  return url.toString();
}

function teamsGraphChatMessagesUrl(args: {
  readonly chatId: string;
  readonly limit: number;
}): string {
  const url = new URL(
    `${graphBaseUrl()}/chats/${encodeURIComponent(args.chatId)}/messages`,
  );
  url.searchParams.set("$top", String(args.limit));
  url.searchParams.set("$orderby", "createdDateTime desc");
  return url.toString();
}

function teamsGraphUserInstalledAppsUrl(args: {
  readonly userId: string;
  readonly teamsAppId: string;
}): string {
  const url = new URL(
    `${graphBaseUrl()}/users/${encodeURIComponent(args.userId)}/teamwork/installedApps`,
  );
  const teamsAppId = args.teamsAppId.replaceAll("'", "''");
  url.searchParams.set("$filter", `teamsApp/externalId eq '${teamsAppId}'`);
  url.searchParams.set("$expand", "teamsApp");
  return url.toString();
}

function teamsGraphUserInstalledAppChatUrl(args: {
  readonly userId: string;
  readonly installationId: string;
}): string {
  return `${graphBaseUrl()}/users/${encodeURIComponent(
    args.userId,
  )}/teamwork/installedApps/${encodeURIComponent(args.installationId)}/chat`;
}

function teamsGraphUserUrl(userId: string): string {
  const url = new URL(`${graphBaseUrl()}/users/${encodeURIComponent(userId)}`);
  url.searchParams.set("$select", "id,displayName,userPrincipalName,mail");
  return url.toString();
}

function teamsGraphShareContentUrl(sharedUrl: string): string {
  const shareId = `u!${Buffer.from(sharedUrl, "utf8").toString("base64url")}`;
  return `${graphBaseUrl()}/shares/${encodeURIComponent(shareId)}/driveItem/content`;
}

function shouldAuthorizeTeamsFileDownload(url: string): boolean {
  const parsed = safeUrlParse(url);
  if (!parsed) {
    return false;
  }
  return (
    parsed.hostname.toLowerCase().endsWith(".trafficmanager.net") &&
    parsed.pathname.includes("/v3/attachments/")
  );
}

async function fetchTeamsGraphJson<T>(
  args: {
    readonly tenantId: string;
    readonly url: string;
    readonly schema: z.ZodType<T>;
  },
  signal: AbortSignal,
): Promise<{ readonly kind: "ok"; readonly data: T } | TeamsApiErrorResult> {
  const accessToken = await fetchTeamsGraphAccessToken(
    {
      tenantId: args.tenantId,
    },
    signal,
  );
  if (accessToken.kind === "teams-error") {
    return accessToken;
  }

  const responseResult = await settle(
    fetch(args.url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${accessToken.accessToken}`,
      },
      signal,
    }),
    signal,
  );
  if (!responseResult.ok) {
    return teamsApiError(502, networkErrorMessage(responseResult.error));
  }

  const response = responseResult.value;
  const responseText = await response.text();
  signal.throwIfAborted();
  if (!response.ok) {
    return teamsApiError(
      response.status,
      responseText || `Microsoft Graph API returned HTTP ${response.status}`,
    );
  }

  const parsed = args.schema.safeParse(safeJsonParse(responseText));
  if (!parsed.success) {
    return teamsApiError(502, "Invalid Microsoft Graph response");
  }
  return { kind: "ok", data: parsed.data };
}

export async function fetchTeamsFile(
  args: {
    readonly tenantId: string;
    readonly url: string;
    readonly downloadMode?: "graph";
  },
  signal: AbortSignal,
): Promise<FetchTeamsFileResult> {
  const headers: Record<string, string> = {
    accept: "application/octet-stream",
  };
  let url = args.url;

  if (args.downloadMode === "graph") {
    const accessToken = await fetchTeamsGraphAccessToken(
      {
        tenantId: args.tenantId,
      },
      signal,
    );
    if (accessToken.kind === "teams-error") {
      return accessToken;
    }
    url = teamsGraphShareContentUrl(args.url);
    headers.authorization = `Bearer ${accessToken.accessToken}`;
  } else if (shouldAuthorizeTeamsFileDownload(args.url)) {
    const accessToken = await fetchTeamsBotAccessToken(signal);
    if (accessToken.kind === "teams-error") {
      return accessToken;
    }
    headers.authorization = `Bearer ${accessToken.accessToken}`;
  }

  const responseResult = await settle(
    fetch(url, {
      method: "GET",
      headers,
      signal,
    }),
    signal,
  );
  if (!responseResult.ok) {
    return teamsApiError(502, networkErrorMessage(responseResult.error));
  }

  return { kind: "ok", response: responseResult.value };
}

export async function fetchTeamsUsers(
  args: {
    readonly tenantId: string;
    readonly userIds: readonly string[];
  },
  signal: AbortSignal,
): Promise<
  | {
      readonly kind: "ok";
      readonly users: ReadonlyMap<string, TeamsGraphUserInfo>;
    }
  | TeamsApiErrorResult
> {
  const accessToken = await fetchTeamsGraphAccessToken(
    {
      tenantId: args.tenantId,
    },
    signal,
  );
  if (accessToken.kind === "teams-error") {
    return accessToken;
  }

  const users = new Map<string, TeamsGraphUserInfo>();
  for (const userId of [...new Set(args.userIds)].slice(0, 20)) {
    const responseResult = await settle(
      fetch(teamsGraphUserUrl(userId), {
        method: "GET",
        headers: {
          authorization: `Bearer ${accessToken.accessToken}`,
        },
        signal,
      }),
      signal,
    );
    if (!responseResult.ok) {
      return teamsApiError(502, networkErrorMessage(responseResult.error));
    }

    const response = responseResult.value;
    const responseText = await response.text();
    signal.throwIfAborted();
    if (response.status === 404) {
      continue;
    }
    if (!response.ok) {
      return teamsApiError(
        response.status,
        responseText || `Microsoft Graph API returned HTTP ${response.status}`,
      );
    }

    const parsed = teamsGraphUserSchema.safeParse(safeJsonParse(responseText));
    if (!parsed.success || !parsed.data.id) {
      continue;
    }
    users.set(parsed.data.id, {
      id: parsed.data.id,
      displayName: parsed.data.displayName ?? null,
      userPrincipalName:
        parsed.data.userPrincipalName ?? parsed.data.mail ?? null,
    });
  }

  return { kind: "ok", users };
}

async function postTeamsActivity(
  args: {
    readonly serviceUrl: string;
    readonly conversationId: string;
    readonly activityId?: string;
    readonly tenantId: string;
    readonly activity: TeamsActivityBody;
  },
  signal: AbortSignal,
): Promise<SendTeamsActivityResult> {
  const accessToken = await fetchTeamsBotAccessToken(signal);
  if (accessToken.kind === "teams-error") {
    return accessToken;
  }

  const url = teamsConversationActivityUrl({
    serviceUrl: args.serviceUrl,
    conversationId: args.conversationId,
    activityId: args.activityId,
  });
  if (!url) {
    return teamsApiError(400, "Invalid Microsoft Teams serviceUrl");
  }

  const responseResult = await settle(
    fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(args.activity),
      signal,
    }),
    signal,
  );
  if (!responseResult.ok) {
    return teamsApiError(502, networkErrorMessage(responseResult.error));
  }

  const response = responseResult.value;
  const responseText = await response.text();
  signal.throwIfAborted();
  if (!response.ok) {
    return teamsApiError(
      response.status,
      responseText || `Microsoft Teams API returned HTTP ${response.status}`,
    );
  }

  if (!responseText) {
    return { kind: "ok", activityId: undefined };
  }

  const parsed = teamsActivityResponseSchema.safeParse(
    safeJsonParse(responseText),
  );
  return {
    kind: "ok",
    activityId: parsed.success ? parsed.data.id : undefined,
  };
}

export async function createTeamsPersonalConversation(
  args: {
    readonly serviceUrl: string;
    readonly tenantId: string;
    readonly botId: string;
    readonly botName?: string | null;
    readonly teamsUserId: string;
    readonly teamsUserDisplayName?: string | null;
  },
  signal: AbortSignal,
): Promise<CreateTeamsConversationResult> {
  const accessToken = await fetchTeamsBotAccessToken(signal);
  if (accessToken.kind === "teams-error") {
    return accessToken;
  }

  const url = teamsConversationsUrl(args.serviceUrl);
  if (!url) {
    return teamsApiError(400, "Invalid Microsoft Teams serviceUrl");
  }

  const body: TeamsCreateConversationBody = {
    bot: {
      id: args.botId,
      ...(args.botName ? { name: args.botName } : {}),
    },
    members: [
      {
        id: args.teamsUserId,
        ...(args.teamsUserDisplayName
          ? { name: args.teamsUserDisplayName }
          : {}),
      },
    ],
    isGroup: false,
    channelData: {
      tenant: { id: args.tenantId },
    },
  };

  const responseResult = await settle(
    fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    }),
    signal,
  );
  if (!responseResult.ok) {
    return teamsApiError(502, networkErrorMessage(responseResult.error));
  }

  const response = responseResult.value;
  const responseText = await response.text();
  signal.throwIfAborted();
  if (!response.ok) {
    return teamsApiError(
      response.status,
      responseText || `Microsoft Teams API returned HTTP ${response.status}`,
    );
  }

  const parsed = teamsConversationResponseSchema.safeParse(
    safeJsonParse(responseText),
  );
  if (!parsed.success) {
    return teamsApiError(502, "Invalid Microsoft Teams conversation response");
  }

  return { kind: "ok", conversationId: parsed.data.id };
}

async function requestTeamsReaction(
  args: {
    readonly method: "PUT" | "DELETE";
    readonly serviceUrl: string;
    readonly conversationId: string;
    readonly activityId: string;
    readonly tenantId: string;
    readonly reactionType: string;
  },
  signal: AbortSignal,
): Promise<SendTeamsReactionResult> {
  const accessToken = await fetchTeamsBotAccessToken(signal);
  if (accessToken.kind === "teams-error") {
    return accessToken;
  }

  const url = teamsConversationReactionUrl({
    serviceUrl: args.serviceUrl,
    conversationId: args.conversationId,
    activityId: args.activityId,
    reactionType: args.reactionType,
  });
  if (!url) {
    return teamsApiError(400, "Invalid Microsoft Teams serviceUrl");
  }

  const responseResult = await settle(
    fetch(url, {
      method: args.method,
      headers: {
        authorization: `Bearer ${accessToken.accessToken}`,
      },
      signal,
    }),
    signal,
  );
  if (!responseResult.ok) {
    return teamsApiError(502, networkErrorMessage(responseResult.error));
  }

  const response = responseResult.value;
  const responseText = await response.text();
  signal.throwIfAborted();
  if (!response.ok) {
    return teamsApiError(
      response.status,
      responseText || `Microsoft Teams API returned HTTP ${response.status}`,
    );
  }

  return { kind: "ok" };
}

export function sendTeamsMessageReply(
  args: {
    readonly serviceUrl: string;
    readonly conversationId: string;
    readonly activityId?: string;
    readonly tenantId: string;
    readonly text: string;
    readonly card?: TeamsAdaptiveCard;
    readonly entities?: readonly TeamsMentionEntity[];
  },
  signal: AbortSignal,
): Promise<SendTeamsActivityResult> {
  return sendTeamsMessage(
    {
      serviceUrl: args.serviceUrl,
      conversationId: args.conversationId,
      activityId: args.activityId,
      tenantId: args.tenantId,
      text: args.text,
      card: args.card,
      ...(args.entities ? { entities: args.entities } : {}),
    },
    signal,
  );
}

export function sendTeamsMessage(
  args: {
    readonly serviceUrl: string;
    readonly conversationId: string;
    readonly activityId?: string;
    readonly tenantId: string;
    readonly text: string;
    readonly card?: TeamsAdaptiveCard;
    readonly entities?: readonly TeamsMentionEntity[];
    readonly attachments?: readonly TeamsActivityAttachment[];
  },
  signal: AbortSignal,
): Promise<SendTeamsActivityResult> {
  const attachments: readonly TeamsActivityAttachment[] = [
    ...(args.card
      ? [
          {
            contentType: "application/vnd.microsoft.card.adaptive" as const,
            content: args.card,
          },
        ]
      : []),
    ...(args.attachments ?? []),
  ];

  return postTeamsActivity(
    {
      serviceUrl: args.serviceUrl,
      conversationId: args.conversationId,
      activityId: args.activityId,
      tenantId: args.tenantId,
      activity: {
        type: "message",
        ...(args.card
          ? { summary: args.text }
          : { text: args.text, textFormat: "markdown" }),
        replyToId: args.activityId,
        ...(args.entities ? { entities: args.entities } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        channelData: {
          tenant: { id: args.tenantId },
        },
      },
    },
    signal,
  );
}

export function sendTeamsReaction(
  args: {
    readonly serviceUrl: string;
    readonly conversationId: string;
    readonly activityId: string;
    readonly tenantId: string;
    readonly reactionType: string;
  },
  signal: AbortSignal,
): Promise<SendTeamsReactionResult> {
  return requestTeamsReaction(
    {
      method: "PUT",
      ...args,
    },
    signal,
  );
}

export function deleteTeamsReaction(
  args: {
    readonly serviceUrl: string;
    readonly conversationId: string;
    readonly activityId: string;
    readonly tenantId: string;
    readonly reactionType: string;
  },
  signal: AbortSignal,
): Promise<SendTeamsReactionResult> {
  return requestTeamsReaction(
    {
      method: "DELETE",
      ...args,
    },
    signal,
  );
}

export function sendTeamsTypingActivity(
  args: {
    readonly serviceUrl: string;
    readonly conversationId: string;
    readonly tenantId: string;
  },
  signal: AbortSignal,
): Promise<SendTeamsActivityResult> {
  return postTeamsActivity(
    {
      serviceUrl: args.serviceUrl,
      conversationId: args.conversationId,
      tenantId: args.tenantId,
      activity: {
        type: "typing",
        channelData: {
          tenant: { id: args.tenantId },
        },
      },
    },
    signal,
  );
}

export async function fetchTeamsChannelMessages(
  args: {
    readonly tenantId: string;
    readonly teamId: string;
    readonly channelId: string;
    readonly limit: number;
  },
  signal: AbortSignal,
): Promise<FetchTeamsGraphMessagesResult> {
  const result = await fetchTeamsGraphJson(
    {
      tenantId: args.tenantId,
      url: teamsGraphChannelMessageUrl({
        teamId: args.teamId,
        channelId: args.channelId,
        limit: args.limit,
      }),
      schema: teamsGraphMessagesResponseSchema,
    },
    signal,
  );
  if (result.kind === "teams-error") {
    return result;
  }
  return { kind: "ok", messages: result.data.value };
}

async function fetchTeamsChatMessages(
  args: {
    readonly tenantId: string;
    readonly chatId: string;
    readonly limit: number;
  },
  signal: AbortSignal,
): Promise<FetchTeamsGraphMessagesResult> {
  const result = await fetchTeamsGraphJson(
    {
      tenantId: args.tenantId,
      url: teamsGraphChatMessagesUrl({
        chatId: args.chatId,
        limit: args.limit,
      }),
      schema: teamsGraphMessagesResponseSchema,
    },
    signal,
  );
  if (result.kind === "teams-error") {
    return result;
  }
  return { kind: "ok", messages: [...result.data.value].reverse() };
}

export async function fetchTeamsPersonalChatMessages(
  args: {
    readonly tenantId: string;
    readonly userId: string;
    readonly teamsAppId: string;
    readonly limit: number;
  },
  signal: AbortSignal,
): Promise<FetchTeamsGraphMessagesResult> {
  const installedAppsResult = await fetchTeamsGraphJson(
    {
      tenantId: args.tenantId,
      url: teamsGraphUserInstalledAppsUrl({
        userId: args.userId,
        teamsAppId: args.teamsAppId,
      }),
      schema: teamsGraphUserInstalledAppsResponseSchema,
    },
    signal,
  );
  if (installedAppsResult.kind === "teams-error") {
    return installedAppsResult;
  }
  const installedApp = installedAppsResult.data.value.find((candidate) => {
    return candidate.teamsApp?.externalId === args.teamsAppId;
  });
  if (!installedApp) {
    return teamsApiError(404, "Microsoft Teams personal app not installed");
  }
  const chatResult = await fetchTeamsGraphJson(
    {
      tenantId: args.tenantId,
      url: teamsGraphUserInstalledAppChatUrl({
        userId: args.userId,
        installationId: installedApp.id,
      }),
      schema: teamsGraphChatSchema,
    },
    signal,
  );
  if (chatResult.kind === "teams-error") {
    return chatResult;
  }
  if (chatResult.data.chatType !== "oneOnOne") {
    return teamsApiError(404, "Microsoft Teams personal chat not found");
  }
  return await fetchTeamsChatMessages(
    {
      tenantId: args.tenantId,
      chatId: chatResult.data.id,
      limit: args.limit,
    },
    signal,
  );
}

export async function fetchTeamsChannelMessage(
  args: {
    readonly tenantId: string;
    readonly teamId: string;
    readonly channelId: string;
    readonly messageId: string;
  },
  signal: AbortSignal,
): Promise<FetchTeamsGraphMessageResult> {
  const result = await fetchTeamsGraphJson(
    {
      tenantId: args.tenantId,
      url: teamsGraphChannelMessageUrl({
        teamId: args.teamId,
        channelId: args.channelId,
        messageId: args.messageId,
      }),
      schema: teamsGraphMessageSchema,
    },
    signal,
  );
  if (result.kind === "teams-error") {
    return result;
  }
  return { kind: "ok", message: result.data };
}

export async function fetchTeamsChannelMessageReplies(
  args: {
    readonly tenantId: string;
    readonly teamId: string;
    readonly channelId: string;
    readonly messageId: string;
    readonly limit: number;
  },
  signal: AbortSignal,
): Promise<FetchTeamsGraphMessagesResult> {
  const result = await fetchTeamsGraphJson(
    {
      tenantId: args.tenantId,
      url: teamsGraphChannelMessageUrl({
        teamId: args.teamId,
        channelId: args.channelId,
        messageId: args.messageId,
        replies: true,
        limit: args.limit,
      }),
      schema: teamsGraphMessagesResponseSchema,
    },
    signal,
  );
  if (result.kind === "teams-error") {
    return result;
  }
  return { kind: "ok", messages: result.data.value };
}
