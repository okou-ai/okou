import {
  FEISHU_PLATFORMS,
  type FeishuPlatform,
} from "@okouai/core/feishu-platform";
import {
  createCipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { Buffer } from "node:buffer";

import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import {
  chatThreadConnectorSelectionContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  connectorAccountsContract,
  type ConnectorAccountMutationIntent,
} from "@okouai/api-contracts/contracts/connector-accounts";
import {
  customConnectorByIdContract,
  customConnectorOAuth2Contract,
  customConnectorProposalContract,
  customConnectorValuesContract,
  customConnectorsContract,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { agentCustomConnectorsContract } from "@okouai/api-contracts/contracts/agent-custom-connectors";
import {
  feishuConnectContract,
  larkConnectContract,
} from "@okouai/api-contracts/contracts/feishu-connect";
import { feishuOauthContract } from "@okouai/api-contracts/contracts/feishu-oauth";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { getCustomConnectorSkillStorageName } from "@okouai/core/storage-names";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createAppWithRoutes } from "../../../app-factory-core";
import { env, mockEnv, mockOptionalEnv } from "../../../lib/env";
import { extractFileFromTarGz } from "../../../lib/tar";
import { server } from "../../../mocks/server";
import {
  findFeishuChatEventByPromptFixture,
  findPendingChatEventByPromptFixture,
  readChatEventContextFixture,
  seedLegacyFeishuIngressFixture,
} from "../../../test-fixtures/chat-events";
import { upsertOrgPlanEntitlementFixture } from "../../../test-fixtures/org-plan-entitlement";
import { seedOrgMetadata } from "../../../test-fixtures/system-config-seeds";
import { seedLegacyPrivateDefaultAgentFixture } from "../../../test-fixtures/legacy-default-agent";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { now } from "../../../lib/time";
import { createDeferredPromise } from "../../utils";
import { feishuBrowserConnectRoutes } from "../feishu-browser-connect";
import { feishuEventsRoutes } from "../feishu-events";
import { feishuOauthRoutes } from "../feishu-oauth";
import { integrationsFeishuFileRoutes } from "../integrations-feishu-files";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import { createStoragesBddApi } from "./helpers/api-bdd-storages";
import {
  createRunsApi,
  expectCanonicalStorageManifest,
} from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import {
  captureIntegrationInputUploads,
  expectIntegrationInputPreview,
  listIntegrationInputFileParts,
} from "./helpers/integration-input-assets";
import { readProjectedChatEvents } from "./helpers/chat-event-test-reader";
import {
  clearFeishuConnectorOwnership,
  readConnectorOAuthAccountMutation,
  readCustomConnectorCredentialStorageParent,
  readFeishuMemberConnectorState,
  seedConnectorStorageRow,
  seedCustomConnectorOAuthStateContext,
  seedCustomThreadConnectorSelection,
  setConnectorExternalIdState,
  setFeishuMemberConnectorLink,
} from "./helpers/connector-credential-storage-state";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";
import { agentsRoutes } from "../agents";
import { chatThreadRoutes } from "../chat-threads";
import { connectorAccountRoutes } from "../connector-accounts";
import { customConnectorsRoutes } from "../custom-connectors";
import { customConnectorsDeleteRoutes } from "../custom-connectors-delete";
import { customConnectorsGetRoutes } from "../custom-connectors-get";
import { customConnectorOAuth2Routes } from "../custom-connectors-oauth2";
import { customConnectorProposalRoutes } from "../custom-connectors-proposal";
import { customConnectorsUpdateRoutes } from "../custom-connectors-update";
import { customConnectorsValuesSetRoutes } from "../custom-connectors-values-set";
import { feishuConnectRoutes } from "../feishu-connect";
import { privateIntegrationArtifact } from "./helpers/integration-output-artifacts";

const customConnectorByIdTestRoutes = Object.freeze([
  ...customConnectorsDeleteRoutes,
  ...customConnectorsGetRoutes,
  ...customConnectorsUpdateRoutes,
]);

const context = testContext();
const mocks = createRouteMocks(context);
const authOrgApi = createAuthOrgAgentsBddApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const runsApi = createRunsApi(context);
const storagesApi = createStoragesBddApi(context);
const webhooksApi = createWebhookCallbackApi(context);
const APP_ORIGIN = "https://app.okou.ai";
const FEISHU_CALLBACK_ORIGIN = "https://api.okou.ai";
const ENCRYPT_KEY = "feishu-test-encrypt-key";
const VERIFICATION_TOKEN = "feishu-test-verification-token";
const APP_SECRET = "feishu-test-secret";
const TENANT_KEY = "tenant_feishu_integration_test";
const BOT_OPEN_ID = "ou_feishu_bot";

function feishuConnectClient(platform: FeishuPlatform) {
  return setupApp({ context, routes: feishuConnectRoutes })(
    platform === "lark" ? larkConnectContract : feishuConnectContract,
  );
}

function chatThreadConnectorSelectionsClient() {
  return setupApp({ context, routes: chatThreadRoutes })(
    chatThreadConnectorSelectionContract,
  );
}

function connectorAccountsClient() {
  return setupApp({ context, routes: connectorAccountRoutes })(
    connectorAccountsContract,
  );
}

type FeishuConnectClient = ReturnType<typeof feishuConnectClient>;

function mockAuthoritativeOrganizationMembers(
  actors: readonly ApiTestUser[],
): void {
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: actors.map((actor) => {
        return { publicUserData: { userId: actor.userId } };
      }),
    },
  );
}

function clearConnectorInvalidationMocks(): void {
  context.mocks.ably.channelGet.mockClear();
  context.mocks.ably.publish.mockClear();
}

function expectCustomConnectorInvalidations(userIds: readonly string[]): void {
  const channels = context.mocks.ably.publish.mock.calls.flatMap(
    ([topic], index) => {
      if (topic !== "customConnectorListChanged") {
        return [];
      }
      const channelName = context.mocks.ably.channelGet.mock.calls[index]?.[0];
      if (!channelName) {
        throw new Error("Expected every Ably publication to select a channel");
      }
      return [channelName];
    },
  );
  expect(channels.sort()).toStrictEqual(
    userIds
      .map((userId) => {
        return `user:${userId}`;
      })
      .sort(),
  );
}

const EXPECTED_FEISHU_OAUTH_SCOPES = [
  "offline_access",
  "contact:contact.base:readonly",
  "contact:user.base:readonly",
  "contact:user.id:readonly",
  "contact:user:search",
  "im:chat",
  "im:chat:create_by_user",
  "im:chat.members:read",
  "im:chat.members:write_only",
  "im:message",
  "im:message.p2p_msg:get_as_user",
  "im:message.group_msg:get_as_user",
  "im:message.send_as_user",
  "im:message.reactions:read",
  "im:message.reactions:write_only",
  "im:resource",
  "drive:drive",
  "drive:file",
  "drive:export:readonly",
  "docx:document",
  "docx:document.block:convert",
  "docs:document:import",
  "docs:document.media:upload",
  "docs:document.media:download",
  "docs:document.comment:create",
  "docs:document.comment:read",
  "docs:document.comment:write_only",
  "sheets:spreadsheet",
  "bitable:app",
  "wiki:wiki",
  "search:docs:read",
  "slides:presentation:read",
  "slides:presentation:write_only",
  "board:whiteboard:node:read",
  "board:whiteboard:node:create",
  "calendar:calendar",
  "calendar:calendar:read",
  "task:task:write",
  "task:tasklist:write",
  "task:comment:write",
  "task:section:write",
] as const;

interface CapturedFeishuMessage {
  readonly kind: "reply" | "send";
  readonly target: string;
  readonly msgType: "interactive" | "text";
  readonly content: Readonly<Record<string, unknown>>;
  readonly replyInThread: boolean;
  readonly idempotencyKey?: string;
}

interface FeishuMessageRequestBody {
  readonly receive_id?: string;
  readonly msg_type: "interactive" | "text";
  readonly content: string;
  readonly reply_in_thread?: boolean;
  readonly uuid?: string;
}

interface FeishuRunFixture {
  readonly actor: ApiTestUser;
  readonly runnerGroup: string;
  readonly appId: string;
  readonly callbackUrl: string;
  readonly installationId: string;
  readonly defaultAgentId: string;
  readonly alternateAgentId: string;
}

function messageContent(message: CapturedFeishuMessage): string {
  return JSON.stringify(message.content);
}

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
  return value;
}

async function expectExactFeishuMemberConnector(args: {
  readonly client: FeishuConnectClient;
  readonly installationId: string;
  readonly member: ApiTestUser;
  readonly expectedOpenId: string;
}): Promise<void> {
  const connected = await accept(
    args.client.getStatus({
      headers: { authorization: "Bearer clerk-session" },
    }),
    [200],
  );
  expect(connected.body.installations?.[0]?.isConnected).toBeTruthy();
  expect(connected.body.installations?.[0]?.connectedUserName).toBe(
    "Feishu User",
  );
  const connectUrl = requireValue(
    connected.body.installations?.[0]?.connectUrl,
    "Expected Feishu OAuth connect URL",
  );
  const appConnectUrl = new URL(connectUrl);
  appConnectUrl.searchParams.set("callbackTarget", "app");
  const oauthApp = createAppWithRoutes({
    signal: context.signal,
    routes: feishuOauthRoutes,
  });
  const orgId = requireValue(args.member.orgId, "Expected an organization");
  const memberConnection = await readFeishuMemberConnectorState(context, {
    orgId,
    userId: args.member.userId,
    installationId: args.installationId,
  });
  expect(memberConnection.feishu_member_connection).toMatchObject({
    connector_external_id: args.expectedOpenId,
    open_id: args.expectedOpenId,
  });
  const memberConnectorId = requireValue(
    memberConnection.feishu_member_connection?.connector_id,
    "Expected Feishu OAuth to persist exact account ownership",
  );

  await setConnectorExternalIdState(context, {
    orgId,
    userId: args.member.userId,
    connectorId: memberConnectorId,
    externalId: "ou_wrong_account",
  });
  const identityMismatch = await accept(
    args.client.getStatus({
      headers: { authorization: "Bearer clerk-session" },
    }),
    [200],
  );
  expect(identityMismatch.body.installations?.[0]?.isConnected).toBeFalsy();

  await setConnectorExternalIdState(context, {
    orgId,
    userId: args.member.userId,
    connectorId: memberConnectorId,
    externalId: null,
  });
  const missingExternalIdentity = await accept(
    args.client.getStatus({
      headers: { authorization: "Bearer clerk-session" },
    }),
    [200],
  );
  expect(
    missingExternalIdentity.body.installations?.[0]?.isConnected,
  ).toBeFalsy();

  await setConnectorExternalIdState(context, {
    orgId,
    userId: args.member.userId,
    connectorId: memberConnectorId,
    externalId: args.expectedOpenId,
  });

  const foreignConnectorId = await seedConnectorStorageRow(context, {
    orgId,
    userId: args.member.userId,
    connectorSlug: "github",
    authMethod: "oauth",
    storageVersion: 1,
  });
  await setFeishuMemberConnectorLink(context, {
    userId: args.member.userId,
    installationId: args.installationId,
    connectorId: foreignConnectorId,
  });
  const foreignLinkStart = await oauthApp.request(appConnectUrl);
  expect(foreignLinkStart.status).toBe(400);
  await expect(foreignLinkStart.json()).resolves.toStrictEqual({
    error: "Connector account not found",
  });
  const mismatched = await accept(
    args.client.getStatus({
      headers: { authorization: "Bearer clerk-session" },
    }),
    [200],
  );
  expect(mismatched.body.installations?.[0]?.isConnected).toBeFalsy();

  await setFeishuMemberConnectorLink(context, {
    userId: args.member.userId,
    installationId: args.installationId,
    connectorId: memberConnectorId,
  });
  const relinked = await accept(
    args.client.getStatus({
      headers: { authorization: "Bearer clerk-session" },
    }),
    [200],
  );
  expect(relinked.body.installations?.[0]?.isConnected).toBeTruthy();

  await setFeishuMemberConnectorLink(context, {
    userId: args.member.userId,
    installationId: args.installationId,
    connectorId: null,
  });
  const unlinkedStart = await oauthApp.request(appConnectUrl);
  expect(unlinkedStart.status).toBe(400);
  await expect(unlinkedStart.json()).resolves.toStrictEqual({
    error: "This connector does not support additional accounts",
  });
  const unlinked = await accept(
    args.client.getStatus({
      headers: { authorization: "Bearer clerk-session" },
    }),
    [200],
  );
  expect(unlinked.body.installations?.[0]?.isConnected).toBeFalsy();

  await setFeishuMemberConnectorLink(context, {
    userId: args.member.userId,
    installationId: args.installationId,
    connectorId: memberConnectorId,
  });
  const restored = await accept(
    args.client.getStatus({
      headers: { authorization: "Bearer clerk-session" },
    }),
    [200],
  );
  expect(restored.body.installations?.[0]?.isConnected).toBeTruthy();
}

function feishuConnectBody(connectUrl: string) {
  const url = new URL(connectUrl);
  return {
    installationId: requireValue(
      url.searchParams.get("installationId"),
      "Expected installationId in Feishu connect URL",
    ),
    openId: requireValue(
      url.searchParams.get("openId"),
      "Expected openId in Feishu connect URL",
    ),
    chatId: requireValue(
      url.searchParams.get("chatId"),
      "Expected chatId in Feishu connect URL",
    ),
    ts: Number(
      requireValue(
        url.searchParams.get("ts"),
        "Expected timestamp in Feishu connect URL",
      ),
    ),
    sig: requireValue(
      url.searchParams.get("sig"),
      "Expected signature in Feishu connect URL",
    ),
  };
}

function commandInput(command: unknown): Record<string, unknown> {
  if (
    typeof command === "object" &&
    command !== null &&
    "input" in command &&
    typeof command.input === "object" &&
    command.input !== null
  ) {
    return command.input as Record<string, unknown>;
  }
  return {};
}

function uploadedSkillMarkdown(): string {
  for (const [command] of context.mocks.s3.send.mock.calls) {
    const input = commandInput(command);
    if (
      !String(input.Key).endsWith("/archive.tar.gz") ||
      !Buffer.isBuffer(input.Body)
    ) {
      continue;
    }
    const skillMarkdown = extractFileFromTarGz(input.Body, "SKILL.md");
    if (skillMarkdown !== null) {
      return skillMarkdown;
    }
  }
  throw new Error("Expected an uploaded SKILL.md");
}

function legacyFeishuAppOAuthState(args: {
  readonly installationId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly publicBrand: PublicBrand;
  readonly redirectUri: string;
}): string {
  const encodedPayload = Buffer.from(
    JSON.stringify({
      ...args,
      callbackTarget: "app",
      timestamp: Math.floor(now() / 1000),
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update(encodedPayload)
    .digest("base64url");
  return `${encodedPayload}.${signature}`;
}

function encryptPayload(payload: unknown): string {
  const key = createHash("sha256").update(ENCRYPT_KEY).digest();
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return JSON.stringify({
    encrypt: Buffer.concat([iv, encrypted]).toString("base64"),
  });
}

function signedHeaders(
  body: string,
  timestamp: number,
): Record<string, string> {
  const nonce = randomUUID();
  const signature = createHash("sha256")
    .update(`${String(timestamp)}${nonce}${ENCRYPT_KEY}${body}`)
    .digest("hex");
  return {
    "content-type": "application/json",
    "x-lark-request-timestamp": String(timestamp),
    "x-lark-request-nonce": nonce,
    "x-lark-signature": signature,
  };
}

async function postEvent(
  callbackUrl: string,
  payload: unknown,
  options: {
    readonly encrypted?: boolean;
    readonly signed?: boolean;
    readonly validSignature?: boolean;
    readonly timestamp?: number;
  } = {},
): Promise<Response> {
  const body = options.encrypted
    ? encryptPayload(payload)
    : JSON.stringify(payload);
  const headers = new Headers(
    options.signed === false
      ? { "content-type": "application/json" }
      : signedHeaders(body, options.timestamp ?? Math.floor(now() / 1000)),
  );
  if (options.validSignature === false) {
    headers.set("x-lark-signature", "invalid");
  }
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: feishuEventsRoutes,
  });
  return await app.request(callbackUrl, {
    method: "POST",
    headers,
    body,
  });
}

async function requestFeishuConfigurationFailure(args: {
  readonly method: "POST" | "PATCH";
  readonly path: string;
  readonly body: unknown;
}): Promise<Response> {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: feishuConnectRoutes,
  });
  return await app.request(args.path, {
    method: args.method,
    headers: {
      authorization: "Bearer clerk-session",
      "content-type": "application/json",
    },
    body: JSON.stringify(args.body),
  });
}

function v2Event(
  appId: string,
  eventType: string,
  event: unknown,
  eventId: string = randomUUID(),
  verificationToken: string = VERIFICATION_TOKEN,
): unknown {
  return {
    schema: "2.0",
    header: {
      event_id: eventId,
      event_type: eventType,
      tenant_key: TENANT_KEY,
      app_id: appId,
      token: verificationToken,
    },
    event,
  };
}

function directMessage(
  appId: string,
  text: string,
  openId = "ou_feishu_user",
  options: {
    readonly chatId?: string;
    readonly messageId?: string;
    readonly eventId?: string;
    readonly rootId?: string;
    readonly threadId?: string;
    readonly verificationToken?: string;
  } = {},
): unknown {
  return v2Event(
    appId,
    "im.message.receive_v1",
    {
      sender: {
        sender_id: { open_id: openId },
        sender_type: "user",
      },
      message: {
        message_id: options.messageId ?? `om_${randomUUID()}`,
        root_id: options.rootId,
        thread_id: options.threadId,
        chat_id: options.chatId ?? "oc_feishu_dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text }),
      },
    },
    options.eventId,
    options.verificationToken,
  );
}

function directFileMessage(
  appId: string,
  options: {
    readonly messageId: string;
    readonly fileKey: string;
    readonly filename: string;
  },
): unknown {
  return v2Event(appId, "im.message.receive_v1", {
    sender: {
      sender_id: { open_id: "ou_feishu_user" },
      sender_type: "user",
    },
    message: {
      message_id: options.messageId,
      chat_id: "oc_feishu_dm",
      chat_type: "p2p",
      message_type: "file",
      content: JSON.stringify({
        file_key: options.fileKey,
        file_name: options.filename,
      }),
    },
  });
}

function groupMessage(
  appId: string,
  text: string,
  options: {
    readonly mentionBot?: boolean;
    readonly mentionOpenId?: string;
    readonly messageId?: string;
    readonly rootId?: string;
    readonly senderType?: string;
    readonly threadId?: string;
    readonly openId?: string;
  } = {},
): unknown {
  const mentionKey = "@_user_1";
  const mentionBot = options.mentionBot ?? true;
  return v2Event(appId, "im.message.receive_v1", {
    sender: {
      sender_id: { open_id: options.openId ?? "ou_feishu_user" },
      sender_type: options.senderType ?? "user",
    },
    message: {
      message_id: options.messageId ?? `om_${randomUUID()}`,
      chat_id: "oc_feishu_group",
      chat_type: "group",
      root_id: options.rootId,
      thread_id: options.threadId,
      message_type: "text",
      content: JSON.stringify({
        text: mentionBot ? `${mentionKey} ${text}` : text,
      }),
      mentions: mentionBot
        ? [
            {
              key: mentionKey,
              id: { open_id: options.mentionOpenId ?? BOT_OPEN_ID },
              name: "Nova",
            },
          ]
        : [],
    },
  });
}

async function enableFeishuIntegration(
  platform: FeishuPlatform,
  actor: {
    readonly userId: string;
    readonly orgId: string | null;
  },
  extraSwitches: Readonly<Record<string, boolean>> = {},
): Promise<void> {
  if (!actor.orgId) {
    throw new Error("Feishu integration tests require an organization");
  }
  await updateFeatureSwitchesForUser(
    context,
    { userId: actor.userId, orgId: actor.orgId },
    {
      [FEISHU_PLATFORMS[platform].featureSwitch]: true,
      ...extraSwitches,
    },
  );
}

describe.each(["feishu", "lark"] as const)("%s integration", (platform) => {
  const provider = FEISHU_PLATFORMS[platform];
  const connectContract =
    platform === "lark" ? larkConnectContract : feishuConnectContract;
  let oauthUserOpenId: string;
  let outboundMessages: CapturedFeishuMessage[];
  let addedReactions: string[];
  let removedReactions: string[];
  let historyMessages: readonly Readonly<Record<string, unknown>>[];
  let threadHistoryMessages: Map<
    string,
    readonly Readonly<Record<string, unknown>>[]
  >;
  let failedSendTargets: string[];
  let failedSendContentFragments: string[];
  let oauthTokenExpiresInSeconds: number;
  let oauthTokenGrantTypes: string[];
  let oauthTokenRedirectUris: string[];
  let oauthRefreshTokens: string[];

  beforeEach(() => {
    oauthUserOpenId = "ou_oauth_user";
    mockEnv("APP_URL", APP_ORIGIN);
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.test");
    mockEnv("OKOU_WEB_URL", "https://www.okou.test");
    mockEnv("FEISHU_CALLBACK_BASE_URL", FEISHU_CALLBACK_ORIGIN);
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
    context.mocks.axiom.query.mockResolvedValue([]);
    context.mocks.ably.publish.mockResolvedValue(undefined);

    server.use(
      http.get(
        `${provider.apiOrigin}/open-apis/im/v1/messages/:messageId/resources/:fileKey`,
        () => {
          return new HttpResponse(null, { status: 503 });
        },
      ),
      http.post(
        `${provider.apiOrigin}/open-apis/auth/v3/tenant_access_token/internal`,
        () => {
          return HttpResponse.json({
            code: 0,
            tenant_access_token: "tenant-access-token",
            expire: 7200,
          });
        },
      ),
      http.get(`${provider.apiOrigin}/open-apis/bot/v3/info`, () => {
        return HttpResponse.json({
          code: 0,
          bot: {
            open_id: BOT_OPEN_ID,
            app_name: "Okou Feishu",
            avatar_url: "https://example.com/okou-feishu.png",
          },
        });
      }),
      http.get(`${provider.apiOrigin}/open-apis/authen/v1/user_info`, () => {
        return HttpResponse.json({
          code: 0,
          data: {
            name: "Feishu User",
            open_id: oauthUserOpenId,
            tenant_key: TENANT_KEY,
          },
        });
      }),
    );

    outboundMessages = [];
    addedReactions = [];
    removedReactions = [];
    historyMessages = [];
    threadHistoryMessages = new Map();
    failedSendTargets = [];
    failedSendContentFragments = [];
    oauthTokenExpiresInSeconds = 7200;
    oauthTokenGrantTypes = [];
    oauthTokenRedirectUris = [];
    oauthRefreshTokens = [];
    server.use(
      http.post(
        `${provider.apiOrigin}/open-apis/authen/v2/oauth/token`,
        async ({ request }) => {
          const body: unknown = await request.json();
          if (
            typeof body !== "object" ||
            body === null ||
            !("grant_type" in body) ||
            typeof body.grant_type !== "string"
          ) {
            throw new Error("Expected Feishu OAuth grant type");
          }
          oauthTokenGrantTypes.push(body.grant_type);
          if (body.grant_type === "authorization_code") {
            if (
              !("redirect_uri" in body) ||
              typeof body.redirect_uri !== "string"
            ) {
              throw new Error("Expected Feishu OAuth redirect URI");
            }
            oauthTokenRedirectUris.push(body.redirect_uri);
          } else if (body.grant_type === "refresh_token") {
            if (
              !("refresh_token" in body) ||
              typeof body.refresh_token !== "string"
            ) {
              throw new Error("Expected Feishu OAuth refresh token");
            }
            oauthRefreshTokens.push(body.refresh_token);
          }
          return HttpResponse.json({
            code: 0,
            access_token:
              body.grant_type === "refresh_token"
                ? "feishu-refreshed-access-token"
                : "feishu-user-access-token",
            refresh_token:
              body.grant_type === "refresh_token"
                ? "feishu-rotated-refresh-token"
                : "feishu-user-refresh-token",
            expires_in:
              body.grant_type === "refresh_token"
                ? 7200
                : oauthTokenExpiresInSeconds,
          });
        },
      ),
      http.post(
        `${provider.apiOrigin}/open-apis/im/v1/messages/:messageId/reply`,
        async ({ params, request }) => {
          const body = (await request.json()) as FeishuMessageRequestBody;
          const failedTargetIndex = failedSendTargets.indexOf(
            String(params.messageId),
          );
          const failedContentIndex = failedSendContentFragments.findIndex(
            (fragment) => {
              return body.content.includes(fragment);
            },
          );
          if (failedTargetIndex !== -1 || failedContentIndex !== -1) {
            if (failedTargetIndex !== -1) {
              failedSendTargets.splice(failedTargetIndex, 1);
            }
            if (failedContentIndex !== -1) {
              failedSendContentFragments.splice(failedContentIndex, 1);
            }
            return HttpResponse.json({
              code: 1,
              msg: "temporary message failure",
            });
          }
          outboundMessages.push({
            kind: "reply",
            target: String(params.messageId),
            msgType: body.msg_type,
            content: JSON.parse(body.content) as Readonly<
              Record<string, unknown>
            >,
            replyInThread: body.reply_in_thread ?? false,
            idempotencyKey: body.uuid,
          });
          return HttpResponse.json({
            code: 0,
            msg: "success",
            data: {
              message_id: `om_reply_${randomUUID()}`,
              chat_id: "oc_feishu_dm",
            },
          });
        },
      ),
      http.post(
        `${provider.apiOrigin}/open-apis/im/v1/messages`,
        async ({ request }) => {
          const body = (await request.json()) as FeishuMessageRequestBody;
          const failedContentIndex = failedSendContentFragments.findIndex(
            (fragment) => {
              return body.content.includes(fragment);
            },
          );
          if (failedContentIndex !== -1) {
            failedSendContentFragments.splice(failedContentIndex, 1);
            return HttpResponse.json({
              code: 1,
              msg: "temporary message failure",
            });
          }
          const failedTargetIndex = failedSendTargets.indexOf(
            body.receive_id ?? "",
          );
          if (failedTargetIndex !== -1) {
            failedSendTargets.splice(failedTargetIndex, 1);
            return HttpResponse.json({
              code: 1,
              msg: "temporary message failure",
            });
          }
          outboundMessages.push({
            kind: "send",
            target: body.receive_id ?? "",
            msgType: body.msg_type,
            content: JSON.parse(body.content) as Readonly<
              Record<string, unknown>
            >,
            replyInThread: false,
            ...(body.uuid ? { idempotencyKey: body.uuid } : {}),
          });
          return HttpResponse.json({
            code: 0,
            msg: "success",
            data: {
              message_id: `om_send_${randomUUID()}`,
              chat_id: "oc_feishu_dm",
            },
          });
        },
      ),
      http.get(
        `${provider.apiOrigin}/open-apis/im/v1/messages`,
        ({ request }) => {
          const query = new URL(request.url).searchParams;
          const containerType = query.get("container_id_type");
          if (containerType !== "chat" && containerType !== "thread") {
            throw new Error("Expected a chat or thread history container");
          }
          const messages =
            containerType === "thread"
              ? (threadHistoryMessages.get(query.get("container_id") ?? "") ??
                [])
              : historyMessages;
          return HttpResponse.json({
            code: 0,
            data: { items: messages, has_more: false },
          });
        },
      ),
      http.post(
        `${provider.apiOrigin}/open-apis/im/v1/messages/:messageId/reactions`,
        ({ params }) => {
          addedReactions.push(String(params.messageId));
          return HttpResponse.json({
            code: 0,
            data: { reaction_id: `reaction_${randomUUID()}` },
          });
        },
      ),
      http.delete(
        `${provider.apiOrigin}/open-apis/im/v1/messages/:messageId/reactions/:reactionId`,
        ({ params }) => {
          removedReactions.push(String(params.messageId));
          return HttpResponse.json({ code: 0 });
        },
      ),
    );
  });

  async function setupFeishuRunFixture(
    options: {
      readonly useAlternateInstallationDefault?: boolean;
      readonly useSystemDefaultIdentity?: boolean;
    } = {},
  ): Promise<FeishuRunFixture> {
    const appId = `cli_${randomUUID()}`;
    const actor = authOrgApi.user({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      orgRole: "org:admin",
    });
    const runnerGroup = runsApi.configureRunnerGroup();
    await enableFeishuIntegration(platform, actor, {
      [FeatureSwitchKey.OkouDebug]: true,
    });
    authOrgApi.acceptAgentStorageWrites();
    runsApi.acceptStorageDownloads();
    runsApi.acceptTelemetryIngest();
    const defaultAgentBootstrap = options.useSystemDefaultIdentity
      ? await authOrgApi.readOnboardingStatus(actor)
      : await authOrgApi.bootstrapLimitedFreeOnboarding(actor, {
          displayName: "Feishu default agent",
        });
    const defaultAgentId =
      "body" in defaultAgentBootstrap
        ? defaultAgentBootstrap.body.agentId
        : defaultAgentBootstrap.defaultAgentId;
    if (!defaultAgentId) {
      throw new Error("Expected Feishu fixture to create a default agent");
    }
    const [defaultAgent, alternateAgent] = await Promise.all([
      authOrgApi.updateAgentMetadata(actor, defaultAgentId, {
        visibility: "public",
      }),
      authOrgApi.createAgent(actor, {
        displayName: "Feishu alternate agent",
        visibility: "public",
      }),
    ]);
    const installationDefaultAgent = options.useAlternateInstallationDefault
      ? alternateAgent
      : defaultAgent;
    const otherAgent = options.useAlternateInstallationDefault
      ? defaultAgent
      : alternateAgent;
    await runsApi.grantProEntitlement(actor);
    await runsApi.ensureOrgModelProvider(actor);
    mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
    const client = setupApp({ context, routes: feishuConnectRoutes })(
      connectContract,
    );
    const configured = await accept(
      client.setup({
        headers: { authorization: "Bearer clerk-session" },
        extraHeaders: { origin: "https://app.okou.ai" },
        body: {
          appId,
          appSecret: APP_SECRET,
          verificationToken: VERIFICATION_TOKEN,
          encryptKey: ENCRYPT_KEY,
          defaultAgentId: installationDefaultAgent.agentId,
        },
      }),
      [200],
    );
    const callbackUrl = requireValue(
      configured.body.callbackUrl,
      "Expected Feishu setup to return a callback URL",
    );
    const installationId = requireValue(
      configured.body.installationId,
      "Expected Feishu setup to return an installation ID",
    );
    await accept(
      client.updateInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId },
        body: {
          defaultAgentId: installationDefaultAgent.agentId,
          setupCompleted: true,
        },
      }),
      [200],
    );
    await postEvent(
      callbackUrl,
      {
        type: "url_verification",
        challenge: "configured",
        token: VERIFICATION_TOKEN,
      },
      { encrypted: true },
    );
    context.mocks.ably.publish.mockClear();
    return {
      actor,
      runnerGroup,
      appId,
      callbackUrl,
      installationId,
      defaultAgentId: installationDefaultAgent.agentId,
      alternateAgentId: otherAgent.agentId,
    };
  }

  async function feishuAuthorizationUrlFromResponse(
    response: Response,
  ): Promise<URL> {
    expect(response.status).toBe(200);
    const responseBody: unknown = await response.json();
    if (
      typeof responseBody !== "object" ||
      responseBody === null ||
      !("openUrl" in responseBody) ||
      typeof responseBody.openUrl !== "string"
    ) {
      throw new Error("Expected Feishu OAuth authorization URL");
    }
    const authorizationUrl = new URL(responseBody.openUrl);
    expect(authorizationUrl.origin).toBe(`${provider.accountsOrigin}`);
    return authorizationUrl;
  }

  async function completeFeishuAuthorization(
    authorizationUrl: URL,
    openId: string,
    expectedAccountMutation: ConnectorAccountMutationIntent,
  ): Promise<URL> {
    const state = requireValue(
      authorizationUrl.searchParams.get("state"),
      "Expected Feishu OAuth state",
    );
    await expect(
      readConnectorOAuthAccountMutation(context, state),
    ).resolves.toMatchObject({
      account_mutation: expectedAccountMutation,
    });
    oauthUserOpenId = openId;
    const oauthApp = createAppWithRoutes({
      signal: context.signal,
      routes: feishuOauthRoutes,
    });
    const callbackResponse = await oauthApp.request(
      `${feishuOauthContract.callback.path}?${new URLSearchParams({
        code: `feishu-oauth-${randomUUID()}`,
        responseMode: "json",
        state,
      })}`,
    );
    expect(callbackResponse.status).toBe(200);
    const responseBody: unknown = await callbackResponse.json();
    if (
      typeof responseBody !== "object" ||
      responseBody === null ||
      !("redirectUrl" in responseBody) ||
      typeof responseBody.redirectUrl !== "string"
    ) {
      throw new Error("Expected Feishu OAuth completion URL");
    }
    return new URL(responseBody.redirectUrl);
  }

  async function requestFeishuConnectUrl(
    fixture: FeishuRunFixture,
    actor = fixture.actor,
    openId = "ou_feishu_user",
  ): Promise<string> {
    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    await postEvent(
      fixture.callbackUrl,
      directMessage(fixture.appId, "connect this Feishu user", openId),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    const loginReply = requireValue(
      outboundMessages.find((message) => {
        return (
          message.kind === "reply" &&
          messageContent(message).includes("Connect your account")
        );
      }),
      "Expected Feishu login reply",
    );
    const connectUrl = requireValue(
      messageContent(loginReply).match(/https:\/\/[^"]+/u)?.[0],
      "Expected Feishu connect URL",
    );
    return connectUrl;
  }

  async function connectFixtureUser(
    fixture: FeishuRunFixture,
    actor = fixture.actor,
    openId = "ou_feishu_user",
  ): Promise<string> {
    const connectUrl = await requestFeishuConnectUrl(fixture, actor, openId);
    const connectApp = createAppWithRoutes({
      signal: context.signal,
      routes: feishuBrowserConnectRoutes,
    });
    const response = await connectApp.request("/api/feishu/connect", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "__session=opaque",
        origin: new URL(connectUrl).origin,
      },
      body: JSON.stringify(feishuConnectBody(connectUrl)),
    });
    const authorizationUrl = await feishuAuthorizationUrlFromResponse(response);
    const completionUrl = await completeFeishuAuthorization(
      authorizationUrl,
      openId,
      { intent: "add" },
    );
    expect(completionUrl.toString()).toBe(
      `${provider.appLinkOrigin}/client/bot/open?appId=${fixture.appId}`,
    );
    const connectBody = feishuConnectBody(connectUrl);
    const statusResponse = await connectApp.request(
      `/api/feishu/connect/status?${new URLSearchParams(
        Object.entries(connectBody).map(([key, value]): [string, string] => {
          return [key, String(value)];
        }),
      )}`,
      {
        headers: { cookie: "__session=opaque" },
      },
    );
    expect(statusResponse.status).toBe(200);
    await expect(statusResponse.json()).resolves.toMatchObject({
      isConnected: true,
    });
    outboundMessages = [];
    return connectUrl;
  }

  async function completeRunSession(args: {
    readonly runId: string;
    readonly sandboxToken: string;
    readonly sessionId: string;
    readonly history: string;
    readonly assistantText?: string;
  }): Promise<void> {
    const historyHash = createHash("sha256").update(args.history).digest("hex");
    const historySize = Buffer.byteLength(args.history, "utf8");
    const headers = {
      authorization: `Bearer ${args.sandboxToken}`,
    };
    await webhooksApi.requestAgentCheckpointPrepareHistory(
      {
        runId: args.runId,
        hash: historyHash,
        rawSize: historySize,
        encodedSize: historySize,
        encoding: "identity",
      },
      headers,
      [200],
    );
    if (args.assistantText !== undefined) {
      const assistantEvent = {
        type: "assistant" as const,
        sequenceNumber: 0,
        message: {
          id: `msg_bdd_feishu_${args.runId}`,
          content: [{ type: "text" as const, text: args.assistantText }],
        },
      };
      chatCallbacks.mockChatOutputEvents([
        {
          eventType: assistantEvent.type,
          sequenceNumber: assistantEvent.sequenceNumber,
          eventData: { message: assistantEvent.message },
        },
      ]);
      await webhooksApi.requestAgentEvents(
        { runId: args.runId, events: [assistantEvent] },
        headers,
        [200],
      );
    }
    await webhooksApi.requestAgentComplete(
      {
        runId: args.runId,
        exitCode: 0,
        checkpoint: {
          cliAgentType: "claude-code",
          cliAgentSessionId: args.sessionId,
          cliAgentSessionHistoryHash: historyHash,
        },
        ...(args.assistantText === undefined ? {} : { lastEventSequence: 0 }),
      },
      headers,
      [200],
    );
    await flushWaitUntilForTest();
    chatCallbacks.mockChatOutputEvents([]);
  }

  async function findRun(
    actor: ApiTestUser,
    prompt: string,
  ): Promise<
    Awaited<ReturnType<typeof runsApi.listAgentRuns>>["runs"][number]
  > {
    const listed = await runsApi.listAgentRuns(actor, { limit: 20 });
    return requireValue(
      listed.runs.find((candidate) => {
        return candidate.prompt === prompt;
      }),
      `Expected Feishu run for prompt: ${prompt}`,
    );
  }

  async function removeFeishuInstallation(
    fixture: FeishuRunFixture,
  ): Promise<void> {
    mocks.clerk.session(
      fixture.actor.userId,
      fixture.actor.orgId,
      fixture.actor.orgRole,
    );
    const client = setupApp({ context, routes: feishuConnectRoutes })(
      connectContract,
    );
    await accept(
      client.removeInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId: fixture.installationId },
      }),
      [200],
    );
  }

  async function expectFeishuResourceDownloads(args: {
    readonly actor: ApiTestUser;
    readonly runId: string;
    readonly prompt: string;
    readonly resources: readonly {
      readonly messageId: string;
      readonly fileKey: string;
      readonly type: "image" | "file";
    }[];
  }): Promise<void> {
    const fileIds = [
      ...args.prompt.matchAll(/ {3}\[FILE_KEY\] ([^\n]+)/gu),
    ].map((match) => {
      return requireValue(match[1], "Expected an opaque resource reference");
    });
    expect(fileIds).toHaveLength(args.resources.length);
    const app = createAppWithRoutes({
      signal: context.signal,
      routes: integrationsFeishuFileRoutes,
    });
    for (const [index, resource] of args.resources.entries()) {
      server.use(
        http.get(
          `${provider.apiOrigin}/open-apis/im/v1/messages/${resource.messageId}/resources/${resource.fileKey}`,
          ({ request }) => {
            expect(new URL(request.url).searchParams.get("type")).toBe(
              resource.type,
            );
            return new HttpResponse(resource.fileKey, {
              headers: { "content-type": "application/octet-stream" },
            });
          },
        ),
      );
      const fileId = requireValue(fileIds[index], "Expected a file reference");
      expect(fileId).toMatch(/^feishu_file_[A-Za-z0-9_-]{22}$/u);
      expect(args.prompt).not.toContain(resource.fileKey);
      const response = await app.request(
        `/api/integrations/${platform}/download-file?${new URLSearchParams({
          message_id: resource.messageId,
          file_key: fileId,
          type: resource.type,
        })}`,
        {
          headers: {
            authorization: `Bearer ${runsApi.okouTokenForRunWithCapabilities(
              args.actor,
              args.runId,
              [`${platform}:write`],
            )}`,
          },
        },
      );
      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe(resource.fileKey);
    }
  }

  async function startFeishuDmSession(fixture: FeishuRunFixture): Promise<{
    readonly firstMessageId: string;
    readonly mainSessionId: string;
  }> {
    const { actor, runnerGroup, appId, callbackUrl } = fixture;
    await connectFixtureUser(fixture);
    const firstMessageId = `om_${randomUUID()}`;
    await postEvent(
      callbackUrl,
      directMessage(appId, "start the Feishu DM session", "ou_feishu_user", {
        messageId: firstMessageId,
      }),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    const initialRun = await findRun(actor, "start the Feishu DM session");
    await runsApi.heartbeatRunner(runnerGroup);
    const initialClaim = await runsApi.claimRunnerJob(initialRun.id);
    expect(initialClaim.resumeSession).toBeNull();
    const mainSessionId = randomUUID();
    await completeRunSession({
      runId: initialRun.id,
      sandboxToken: initialClaim.sandboxToken,
      sessionId: mainSessionId,
      history: `bdd initial feishu history ${initialRun.id}`,
      assistantText: "Initial Feishu DM answer",
    });
    return { firstMessageId, mainSessionId };
  }

  it("removes only the deleted user's Feishu connection mapping", async () => {
    const fixture = await setupFeishuRunFixture();
    const survivor = fixture.actor;
    await connectFixtureUser(fixture, survivor, "ou_feishu_survivor");

    const doomed = authOrgApi.user({
      userId: `user_${randomUUID()}`,
      orgId: survivor.orgId,
      orgRole: "org:member",
    });
    await enableFeishuIntegration(platform, doomed);
    await connectFixtureUser(fixture, doomed, "ou_feishu_doomed");

    const client = setupApp({ context, routes: feishuConnectRoutes })(
      connectContract,
    );
    mocks.clerk.session(doomed.userId, doomed.orgId, "org:member");
    const connectedBeforeDeletion = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(connectedBeforeDeletion.body).toMatchObject({
      isConnected: true,
      connectedUserName: "Feishu User",
    });

    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [{ publicUserData: { userId: survivor.userId } }],
      },
    );
    webhooksApi.configureClerkWebhookSecret();
    webhooksApi.verifyNextClerkWebhook({
      type: "user.deleted",
      data: { id: doomed.userId },
    });
    const response = await webhooksApi.requestClerkWebhook("{}", {}, [200]);
    expect(response.body).toBe("OK");
    await flushWaitUntilForTest();

    mocks.clerk.session(doomed.userId, doomed.orgId, "org:member");
    const deletedUserStatus = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(deletedUserStatus.body.isConnected).toBeFalsy();

    mocks.clerk.session(survivor.userId, survivor.orgId, "org:admin");
    const survivorStatus = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(survivorStatus.body).toMatchObject({
      isConnected: true,
      connectedUserName: "Feishu User",
      installations: [expect.objectContaining({ id: fixture.installationId })],
    });
  });

  it("rejects configuration API access when the feature switch is disabled", async () => {
    const actor = authOrgApi.user({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      orgRole: "org:admin",
    });
    mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
    const client = setupApp({ context, routes: feishuConnectRoutes })(
      connectContract,
    );

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [403],
    );

    expect(response.body.error).toStrictEqual({
      code: "FORBIDDEN",
      message: `${provider.name} integration is not enabled`,
    });
  });

  it("uses the public callback origin and accepts plaintext URL verification without an Encrypt Key", async () => {
    const callbackOrigin = "https://tunnel-feishu.okou.test";
    mockEnv("FEISHU_CALLBACK_BASE_URL", callbackOrigin);
    const appId = `cli_${randomUUID()}`;
    const actor = authOrgApi.user({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      orgRole: "org:admin",
    });
    authOrgApi.acceptAgentStorageWrites();
    await enableFeishuIntegration(platform, actor);
    const agent = await authOrgApi.createAgent(actor, {
      displayName: "Feishu plaintext callback agent",
      visibility: "public",
    });
    mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
    const client = setupApp({ context, routes: feishuConnectRoutes })(
      connectContract,
    );
    const configured = await accept(
      client.setup({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          appId,
          appSecret: APP_SECRET,
          verificationToken: VERIFICATION_TOKEN,
          defaultAgentId: agent.agentId,
        },
      }),
      [200],
    );
    const callbackUrl = configured.body.callbackUrl;
    expect(callbackUrl).not.toBeNull();
    if (!callbackUrl) {
      throw new Error("Expected Feishu setup to return a callback URL");
    }
    expect(new URL(callbackUrl).origin).toBe(callbackOrigin);

    const response = await postEvent(
      callbackUrl,
      {
        type: "url_verification",
        challenge: "plaintext-challenge",
        token: VERIFICATION_TOKEN,
      },
      { signed: false },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      challenge: "plaintext-challenge",
    });
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "feishu:changed",
      null,
    );

    await accept(
      client.remove({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
  });

  it("keeps one Feishu app installed per organization", async () => {
    const firstAppId = `cli_${randomUUID()}`;
    const secondAppId = `cli_${randomUUID()}`;
    const actor = authOrgApi.user({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      orgRole: "org:admin",
    });
    authOrgApi.acceptAgentStorageWrites();
    await enableFeishuIntegration(platform, actor);
    const agent = await authOrgApi.createAgent(actor, {
      displayName: "Feishu single-bot agent",
      visibility: "public",
    });
    mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
    const client = setupApp({ context, routes: feishuConnectRoutes })(
      connectContract,
    );

    await accept(
      client.setup({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          appId: firstAppId,
          appSecret: APP_SECRET,
          verificationToken: VERIFICATION_TOKEN,
          defaultAgentId: agent.agentId,
          createNew: true,
        },
      }),
      [200],
    );
    await accept(
      client.setup({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          appId: firstAppId,
          appSecret: APP_SECRET,
          verificationToken: VERIFICATION_TOKEN,
          defaultAgentId: agent.agentId,
        },
      }),
      [200],
    );
    const secondSetup = await accept(
      client.setup({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          appId: secondAppId,
          appSecret: APP_SECRET,
          verificationToken: VERIFICATION_TOKEN,
          defaultAgentId: agent.agentId,
          createNew: true,
        },
      }),
      [409],
    );
    expect(secondSetup.body.error.message).toBe(
      `This workspace already has a ${provider.name} bot`,
    );
    const conflict = await accept(
      client.checkAppId({
        headers: { authorization: "Bearer clerk-session" },
        query: { appId: firstAppId },
      }),
      [409],
    );
    expect(conflict.body.error.message).toBe(
      `This ${provider.name} App ID is already registered in Okou`,
    );
    await accept(
      client.checkAppId({
        headers: { authorization: "Bearer clerk-session" },
        query: { appId: `cli_${randomUUID()}` },
      }),
      [200],
    );

    const status = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(status.body.installations).toHaveLength(1);
    expect(
      status.body.installations?.map((installation) => {
        return installation.appId;
      }),
    ).toStrictEqual([firstAppId]);
    const installation = status.body.installations?.[0];
    if (!installation) {
      throw new Error("Expected one Feishu installation");
    }
    await accept(
      client.removeInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId: installation.id },
      }),
      [200],
    );
  });

  it("serializes concurrent Feishu app creation per organization", async () => {
    const actor = authOrgApi.user({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      orgRole: "org:admin",
    });
    authOrgApi.acceptAgentStorageWrites();
    await enableFeishuIntegration(platform, actor);
    const agent = await authOrgApi.createAgent(actor, {
      displayName: "Feishu concurrent setup agent",
      visibility: "public",
    });
    mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
    const client = setupApp({ context, routes: feishuConnectRoutes })(
      connectContract,
    );
    const bothTokenRequestsStarted = createDeferredPromise<void>(
      context.signal,
    );
    const releaseTokenRequests = createDeferredPromise<void>(context.signal);
    let tokenRequestCount = 0;
    server.use(
      http.post(
        `${provider.apiOrigin}/open-apis/auth/v3/tenant_access_token/internal`,
        async () => {
          tokenRequestCount += 1;
          if (tokenRequestCount === 2) {
            bothTokenRequestsStarted.resolve();
          }
          await releaseTokenRequests.promise;
          return HttpResponse.json({
            code: 0,
            tenant_access_token: "tenant-access-token",
            expire: 7200,
          });
        },
      ),
    );

    const setupResponsesPromise = Promise.all(
      [`cli_${randomUUID()}`, `cli_${randomUUID()}`].map((appId) => {
        return client.setup({
          headers: { authorization: "Bearer clerk-session" },
          body: {
            appId,
            appSecret: APP_SECRET,
            verificationToken: VERIFICATION_TOKEN,
            defaultAgentId: agent.agentId,
            createNew: true,
          },
        });
      }),
    );
    await bothTokenRequestsStarted.promise;
    releaseTokenRequests.resolve();
    const setupResponses = await setupResponsesPromise;

    expect(
      setupResponses.map((response) => {
        return response.status;
      }),
    ).toContain(200);
    expect(
      setupResponses.map((response) => {
        return response.status;
      }),
    ).toContain(409);

    const status = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(status.body.installations).toHaveLength(1);
    const installation = status.body.installations?.[0];
    if (!installation) {
      throw new Error("Expected one Feishu installation");
    }
    await accept(
      client.removeInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId: installation.id },
      }),
      [200],
    );
  });

  it("converges concurrent managed connector retries after skill publication fails", async () => {
    const actor = authOrgApi.user({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      orgRole: "org:admin",
    });
    authOrgApi.acceptAgentStorageWrites();
    await enableFeishuIntegration(platform, actor);
    const agent = await authOrgApi.createAgent(actor, {
      displayName: "Feishu connector retry agent",
      visibility: "public",
    });
    mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
    const client = setupApp({ context, routes: feishuConnectRoutes })(
      connectContract,
    );
    context.mocks.s3.send.mockRejectedValue(
      new Error("Managed connector skill upload failed"),
    );

    const failedSetup = await requestFeishuConfigurationFailure({
      method: "POST",
      path: connectContract.setup.path,
      body: {
        appId: `cli_${randomUUID()}`,
        appSecret: APP_SECRET,
        verificationToken: VERIFICATION_TOKEN,
        defaultAgentId: agent.agentId,
        createNew: true,
      },
    });
    expect(failedSetup.status).toBe(500);

    const customConnectorClient = setupApp({
      context,
      routes: customConnectorsRoutes,
    })(customConnectorsContract);
    const connectorsAfterFailure = await accept(
      customConnectorClient.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(connectorsAfterFailure.body.connectors).toStrictEqual([]);
    const status = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const installation = requireValue(
      status.body.installations?.[0],
      "Expected the failed setup to retain its Feishu installation",
    );

    const bothSkillUploadsStarted = createDeferredPromise<void>(context.signal);
    const releaseSkillUploads = createDeferredPromise<void>(context.signal);
    const archiveKeys: string[] = [];
    context.mocks.s3.send.mockImplementation(async (command: unknown) => {
      const input = commandInput(command);
      if (
        String(input.Key).endsWith("/archive.tar.gz") &&
        Buffer.isBuffer(input.Body)
      ) {
        archiveKeys.push(String(input.Key));
        if (archiveKeys.length === 2) {
          bothSkillUploadsStarted.resolve();
        }
        if (archiveKeys.length <= 2) {
          await releaseSkillUploads.promise;
        }
      }
      return { ContentLength: 1024 };
    });

    const updateResponsesPromise = Promise.all([
      client.updateInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId: installation.id },
        body: { defaultAgentId: agent.agentId, setupCompleted: true },
      }),
      client.updateInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId: installation.id },
        body: { defaultAgentId: agent.agentId, setupCompleted: true },
      }),
    ]);
    await bothSkillUploadsStarted.promise;
    releaseSkillUploads.resolve();
    const updateResponses = await updateResponsesPromise;

    expect(
      updateResponses.map((response) => {
        return response.status;
      }),
    ).toStrictEqual([200, 200]);
    expect(new Set(archiveKeys).size).toBe(2);
    const connectorList = await accept(
      customConnectorClient.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(connectorList.body.connectors).toHaveLength(1);
    const managedConnector = requireValue(
      connectorList.body.connectors[0],
      "Expected concurrent retries to converge on one connector",
    );
    await expect(
      storagesApi.downloadStorage(actor, {
        name: getCustomConnectorSkillStorageName(managedConnector.id),
        owner: "organization",
      }),
    ).resolves.toMatchObject({ fileCount: 1 });

    await accept(
      client.removeInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId: installation.id },
      }),
      [200],
    );
  });

  it("preserves an unlinked connector when removing its installation", async () => {
    const actor = authOrgApi.user({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      orgRole: "org:admin",
    });
    authOrgApi.acceptAgentStorageWrites();
    await enableFeishuIntegration(platform, actor);
    const agent = await authOrgApi.createAgent(actor, {
      displayName: "Feishu unlinked removal agent",
      visibility: "public",
    });
    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const client = setupApp({ context, routes: feishuConnectRoutes })(
      connectContract,
    );
    const configured = await accept(
      client.setup({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          appId: `cli_${randomUUID()}`,
          appSecret: APP_SECRET,
          verificationToken: VERIFICATION_TOKEN,
          defaultAgentId: agent.agentId,
          createNew: true,
        },
      }),
      [200],
    );
    const installationId = requireValue(
      configured.body.installationId,
      "Expected Feishu setup to return an installation id",
    );
    const customConnectorClient = setupApp({
      context,
      routes: customConnectorsRoutes,
    })(customConnectorsContract);
    const connectorBeforeRemoval = requireValue(
      (
        await accept(
          customConnectorClient.list({
            headers: { authorization: "Bearer clerk-session" },
          }),
          [200],
        )
      ).body.connectors[0],
      "Expected Feishu setup to create a managed connector",
    );

    // Production APIs cannot clear this relationship. This scoped test-only
    // transition models historical ownership loss before exercising removal
    // and verification through production routes.
    await clearFeishuConnectorOwnership(context, {
      orgId: requireValue(actor.orgId, "Expected an organization"),
      installationId,
    });

    await accept(
      client.removeInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId },
      }),
      [200],
    );

    const connectorsAfterRemoval = await accept(
      customConnectorClient.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(connectorsAfterRemoval.body.connectors).toMatchObject([
      { id: connectorBeforeRemoval.id },
    ]);
  });

  it("keeps the managed connector and skill HEAD active when repair publication fails", async () => {
    const actor = authOrgApi.user({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      orgRole: "org:admin",
    });
    authOrgApi.acceptAgentStorageWrites();
    await enableFeishuIntegration(platform, actor);
    const agent = await authOrgApi.createAgent(actor, {
      displayName: "Feishu connector repair agent",
      visibility: "public",
    });
    mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
    const client = setupApp({ context, routes: feishuConnectRoutes })(
      connectContract,
    );
    const configured = await accept(
      client.setup({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          appId: `cli_${randomUUID()}`,
          appSecret: APP_SECRET,
          verificationToken: VERIFICATION_TOKEN,
          defaultAgentId: agent.agentId,
          createNew: true,
        },
      }),
      [200],
    );
    const installationId = requireValue(
      configured.body.installationId,
      "Expected Feishu setup to return an installation id",
    );
    const customConnectorClient = setupApp({
      context,
      routes: customConnectorsRoutes,
    })(customConnectorsContract);
    const initialList = await accept(
      customConnectorClient.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const initialConnector = requireValue(
      initialList.body.connectors[0],
      "Expected Feishu setup to activate a managed connector",
    );
    const storageName = getCustomConnectorSkillStorageName(initialConnector.id);
    const initialHead = await storagesApi.downloadStorage(actor, {
      name: storageName,
      owner: "organization",
    });
    context.mocks.s3.send.mockRejectedValue(
      new Error("Managed connector repair skill upload failed"),
    );

    const failedRepair = await requestFeishuConfigurationFailure({
      method: "PATCH",
      path: connectContract.updateInstallation.path.replace(
        ":installationId",
        installationId,
      ),
      body: { defaultAgentId: agent.agentId, setupCompleted: true },
    });

    expect(failedRepair.status).toBe(500);
    context.mocks.s3.send.mockResolvedValue({ ContentLength: 1024 });
    const connectorAfterFailure = await accept(
      customConnectorClient.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(connectorAfterFailure.body.connectors).toMatchObject([
      {
        id: initialConnector.id,
        displayName: initialConnector.displayName,
        skillMarkdown: initialConnector.skillMarkdown,
      },
    ]);
    await expect(
      storagesApi.downloadStorage(actor, {
        name: storageName,
        owner: "organization",
      }),
    ).resolves.toMatchObject({ versionId: initialHead.versionId });

    await accept(
      client.removeInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId },
      }),
      [200],
    );
  });

  it("requires organization admins even when the user created the bot", async () => {
    const actor = authOrgApi.user({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      orgRole: "org:admin",
    });
    authOrgApi.acceptAgentStorageWrites();
    await enableFeishuIntegration(platform, actor);
    const agent = await authOrgApi.createAgent(actor, {
      displayName: "Feishu managed bot agent",
      visibility: "public",
    });
    mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
    const client = setupApp({ context, routes: feishuConnectRoutes })(
      connectContract,
    );

    const configured = await accept(
      client.setup({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          appId: `cli_${randomUUID()}`,
          appSecret: APP_SECRET,
          verificationToken: VERIFICATION_TOKEN,
          defaultAgentId: agent.agentId,
          createNew: true,
        },
      }),
      [200],
    );
    const installationId = configured.body.installationId;
    if (!installationId) {
      throw new Error("Expected one Feishu installation");
    }

    mocks.clerk.session(actor.userId, actor.orgId, "org:member");
    const memberStatus = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(memberStatus.body.isAdmin).toBeFalsy();
    await accept(
      client.checkAppId({
        headers: { authorization: "Bearer clerk-session" },
        query: { appId: `cli_${randomUUID()}` },
      }),
      [403],
    );
    await accept(
      client.setup({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          appId: `cli_${randomUUID()}`,
          appSecret: APP_SECRET,
          verificationToken: VERIFICATION_TOKEN,
          defaultAgentId: agent.agentId,
          createNew: true,
        },
      }),
      [403],
    );
    await accept(
      client.updateInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId },
        body: { defaultAgentId: agent.agentId, setupCompleted: true },
      }),
      [403],
    );
    await accept(
      client.removeInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId },
      }),
      [403],
    );

    mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
    const completed = await accept(
      client.updateInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId },
        body: {
          defaultAgentId: agent.agentId,
          setupCompleted: true,
        },
      }),
      [200],
    );
    expect(completed.body.setupCompleted).toBeTruthy();
    expect(completed.body.botName).toBe("Okou Feishu");
    expect(completed.body.botAvatarUrl).toBe(
      "https://example.com/okou-feishu.png",
    );
    await accept(
      client.removeInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId },
      }),
      [200],
    );
  });

  it("connects the current Feishu user through signed OAuth state", async () => {
    const appId = `cli_${randomUUID()}`;
    const admin = authOrgApi.user({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      orgRole: "org:admin",
    });
    const member = authOrgApi.user({
      userId: `user_${randomUUID()}`,
      orgId: admin.orgId,
      orgRole: "org:member",
    });
    authOrgApi.acceptAgentStorageWrites();
    await enableFeishuIntegration(platform, admin);
    await enableFeishuIntegration(platform, member);
    const agent = await authOrgApi.createAgent(admin, {
      displayName: "Feishu OAuth agent",
      visibility: "public",
    });
    mockAuthoritativeOrganizationMembers([admin, member]);
    mocks.clerk.session(admin.userId, admin.orgId, "org:admin");
    const client = setupApp({ context, routes: feishuConnectRoutes })(
      connectContract,
    );
    clearConnectorInvalidationMocks();
    const configured = await accept(
      client.setup({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          appId,
          appSecret: APP_SECRET,
          verificationToken: VERIFICATION_TOKEN,
          defaultAgentId: agent.agentId,
          createNew: true,
        },
      }),
      [200],
    );
    expectCustomConnectorInvalidations([admin.userId, member.userId]);
    const installationId = configured.body.installationId;
    if (!installationId) {
      throw new Error("Expected Feishu setup to return an installation id");
    }
    clearConnectorInvalidationMocks();
    await accept(
      client.updateInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId },
        body: {
          defaultAgentId: agent.agentId,
          setupCompleted: true,
        },
      }),
      [200],
    );
    expectCustomConnectorInvalidations([admin.userId, member.userId]);

    const customConnectorClient = setupApp({
      context,
      routes: customConnectorsRoutes,
    })(customConnectorsContract);
    const connectorList = await accept(
      customConnectorClient.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(connectorList.body.connectors).toHaveLength(1);
    const managedConnector = requireValue(
      connectorList.body.connectors[0],
      "Expected setup to create a managed Feishu custom connector",
    );
    expect(managedConnector).toMatchObject({
      slug: `_${platform}-${installationId}`,
      displayName: `${provider.name}-Okou Feishu`,
      prefixTemplates: [`${provider.apiOrigin}/open-apis/`],
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate: "Bearer {{oauth.access_token}}",
        },
      ],
      authMode: "oauth",
      storageVersion: 1,
      permissionBundleRef: "builtin:feishu@1",
      connected: false,
      oauthConfig: {
        providerAdapter: "feishu",
        clientId: appId,
        authorizationUrl: `${provider.accountsOrigin}/open-apis/authen/v1/authorize`,
        tokenUrl: `${provider.apiOrigin}/open-apis/authen/v2/oauth/token`,
        tokenEndpointAuthMethod: "client_secret_post",
        pkceMethod: "none",
        scopes: [...EXPECTED_FEISHU_OAUTH_SCOPES],
      },
    });
    expect(managedConnector.skillMarkdown).toContain("Available capabilities");
    expect(managedConnector.skillMarkdown).toContain(
      "Every request runs with the connected user's identity",
    );
    expect(managedConnector.skillMarkdown).toContain(
      "does not grant whiteboard node update or delete scopes",
    );
    const managedSkillStorageName = getCustomConnectorSkillStorageName(
      managedConnector.id,
    );
    const managedSkillHead = await storagesApi.downloadStorage(admin, {
      name: managedSkillStorageName,
      owner: "organization",
    });
    const skillMarkdown = uploadedSkillMarkdown();
    expect(skillMarkdown).toContain(`---\nname: ${platform}\n`);
    expect(skillMarkdown).toContain(
      `description: ${provider.name} OpenAPI for user-authorized messaging, people search, cloud`,
    );
    expect(skillMarkdown).toContain(
      `documents, calendars, and tasks. Use when the user asks to work with ${provider.name}.`,
    );
    expect(skillMarkdown).not.toContain("Okou Feishu");
    expect(skillMarkdown).not.toContain(managedConnector.id);
    const permissionBundle = await accept(
      setupApp({ context, routes: customConnectorByIdTestRoutes })(
        customConnectorByIdContract,
      ).permissions({
        headers: { authorization: "Bearer clerk-session" },
        params: { id: managedConnector.id },
      }),
      [200],
    );
    expect(permissionBundle.body).toMatchObject({
      ref: "builtin:feishu@1",
      defaultPolicies: {
        "standard:use": "allow",
        "messages:send-as-user": "deny",
        "resources:delete": "deny",
        "sharing:manage": "allow",
        "chats:manage": "deny",
        "comments:write": "allow",
        "calendar:write": "allow",
        "tasks:write": "allow",
      },
    });

    const customConnectorOAuthClient = setupApp({
      context,
      routes: customConnectorOAuth2Routes,
    })(customConnectorOAuth2Contract);
    const managedOAuthStart = await accept(
      customConnectorOAuthClient.start({
        headers: { authorization: "Bearer clerk-session" },
        params: { id: managedConnector.id },
        body: { account: { intent: "add" } },
      }),
      [403],
    );
    expect(managedOAuthStart.body.error.message).toBe(
      "This connector is managed by its integration",
    );

    const genericState = `generic-feishu-${randomUUID()}`;
    await seedCustomConnectorOAuthStateContext(context, {
      state: genericState,
      orgId: requireValue(admin.orgId, "Expected an organization"),
      userId: admin.userId,
      customConnectorId: managedConnector.id,
      storageVersion: managedConnector.storageVersion,
      redirectUri: `${APP_ORIGIN}${provider.callbackPath}`,
      oauthContext: {
        version: 2,
        authMode: "oauth",
        connectorId: managedConnector.id,
        storageVersion: managedConnector.storageVersion,
        providerContext: {
          provider: "feishu",
          completionTarget: "custom",
        },
      },
    });
    const genericCallbackResponse = await createAppWithRoutes({
      signal: context.signal,
      routes: feishuOauthRoutes,
    }).request(
      `${feishuOauthContract.callback.path}?${new URLSearchParams({
        code: "generic-feishu-code",
        responseMode: "json",
        state: genericState,
      })}`,
    );
    expect(genericCallbackResponse.status).toBe(400);
    await expect(genericCallbackResponse.json()).resolves.toStrictEqual({
      error: "Invalid or expired connect state",
    });
    expect(oauthTokenRedirectUris).toStrictEqual([]);

    const customConnectorByIdClient = setupApp({
      context,
      routes: customConnectorByIdTestRoutes,
    })(customConnectorByIdContract);
    const managedUpdate = await accept(
      customConnectorByIdClient.update({
        headers: { authorization: "Bearer clerk-session" },
        params: { id: managedConnector.id },
        body: {
          displayName: managedConnector.displayName,
          prefixTemplates: managedConnector.prefixTemplates,
          fields: managedConnector.fields,
          headerInjections: managedConnector.headerInjections,
          queryInjections: managedConnector.queryInjections,
        },
      }),
      [403],
    );
    expect(managedUpdate.body.error.message).toBe(
      "This connector is managed by its integration",
    );
    const managedDelete = await accept(
      customConnectorByIdClient.delete({
        headers: { authorization: "Bearer clerk-session" },
        params: { id: managedConnector.id },
      }),
      [403],
    );
    expect(managedDelete.body.error.message).toBe(
      "This connector is managed by its integration",
    );

    const managedValues = await accept(
      setupApp({ context, routes: customConnectorsValuesSetRoutes })(
        customConnectorValuesContract,
      ).set({
        headers: { authorization: "Bearer clerk-session" },
        params: { id: managedConnector.id },
        body: {
          values: [],
          account: { intent: "add" },
        },
      }),
      [403],
    );
    expect(managedValues.body.error.message).toBe(
      "This connector is managed by its integration",
    );

    const managedProposal = await accept(
      setupApp({ context, routes: customConnectorProposalRoutes })(
        customConnectorProposalContract,
      ).save({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          proposal: {
            operation: "update",
            connectorId: managedConnector.id,
            displayName: managedConnector.displayName,
            prefixTemplates: managedConnector.prefixTemplates,
            fields: [
              {
                key: "token",
                label: "Token",
                kind: "secret",
                required: true,
              },
            ],
            headerInjections: [
              {
                name: "Authorization",
                valueTemplate: "Bearer {{secrets.token}}",
              },
            ],
            queryInjections: managedConnector.queryInjections,
          },
          values: [],
        },
      }),
      [403],
    );
    expect(managedProposal.body.error.message).toBe(
      "This connector is managed by its integration",
    );

    const unchangedConnectorList = await accept(
      customConnectorClient.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(unchangedConnectorList.body.connectors[0]).toMatchObject({
      id: managedConnector.id,
      connected: false,
    });
    const adminFeishuStatus = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(adminFeishuStatus.body.isConnected).toBeFalsy();
    oauthTokenRedirectUris = [];
    oauthUserOpenId = "ou_oauth_user";
    outboundMessages = [];

    const oauthApp = createAppWithRoutes({
      signal: context.signal,
      routes: feishuOauthRoutes,
    });

    mocks.clerk.session(member.userId, member.orgId, "org:member");
    mockClerkMembership(context, member, "org:member");
    const status = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const connectUrl = status.body.installations?.[0]?.connectUrl;
    expect(connectUrl).toBeDefined();
    expect(status.body.oauthRedirectUrl).toBe(
      `${APP_ORIGIN}${provider.callbackPath}`,
    );
    expect(status.body.oauthScopes).toStrictEqual([
      ...EXPECTED_FEISHU_OAUTH_SCOPES,
    ]);
    if (!connectUrl) {
      throw new Error("Expected Feishu status to return an OAuth connect URL");
    }
    const signedState = requireValue(
      new URL(connectUrl).searchParams.get("state"),
      "Expected signed Feishu connect state",
    );
    const [encodedState] = signedState.split(".");
    expect(
      JSON.parse(Buffer.from(encodedState ?? "", "base64url").toString()),
    ).toMatchObject({ publicBrand: "okou" });
    expect(new URL(connectUrl).origin).toBe("https://api.okou.test");

    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const legacyConnectResponse = await oauthApp.request(connectUrl);
    expect(legacyConnectResponse.status).toBe(307);
    // New signed state carries the exact app callback URI, so an omitted or
    // tampered callbackTarget query cannot change the provider redirect.
    expect(
      new URL(
        legacyConnectResponse.headers.get("location") ?? "",
      ).searchParams.get("redirect_uri"),
    ).toBe(`${APP_ORIGIN}${provider.callbackPath}`);

    const appConnectUrl = new URL(connectUrl);
    appConnectUrl.searchParams.set("callbackTarget", "app");
    const connectResponse = await oauthApp.request(appConnectUrl);
    expect(connectResponse.status).toBe(307);
    const authorizationUrl = new URL(
      connectResponse.headers.get("location") ?? "",
    );
    expect(authorizationUrl.origin).toBe(`${provider.accountsOrigin}`);
    expect(authorizationUrl.searchParams.get("client_id")).toBe(appId);
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      `${APP_ORIGIN}${provider.callbackPath}`,
    );
    expect(
      authorizationUrl.searchParams.get("scope")?.split(" "),
    ).toStrictEqual([...EXPECTED_FEISHU_OAUTH_SCOPES]);
    const state = authorizationUrl.searchParams.get("state");
    if (!state) {
      throw new Error("Expected Feishu authorization URL to include state");
    }
    await expect(
      readConnectorOAuthAccountMutation(context, state),
    ).resolves.toMatchObject({
      account_mutation: { intent: "add" },
    });

    const handoffResponse = await oauthApp.request(
      `${feishuOauthContract.callback.path}?${new URLSearchParams({
        code: "feishu-oauth-code",
        state,
      })}`,
    );
    expect(handoffResponse.status).toBe(307);
    const handoffUrl = new URL(handoffResponse.headers.get("location") ?? "");
    expect(handoffUrl.origin).toBe(APP_ORIGIN);
    expect(handoffUrl.pathname).toBe(`${provider.callbackPath}`);
    expect(handoffUrl.searchParams.get("code")).toBe("feishu-oauth-code");
    expect(handoffUrl.searchParams.get("state")).toBe(state);

    clearConnectorInvalidationMocks();
    const callbackResponse = await oauthApp.request(
      `${feishuOauthContract.callback.path}?${new URLSearchParams({
        code: "feishu-oauth-code",
        responseMode: "json",
        state,
      })}`,
    );
    expect(callbackResponse.status).toBe(200);
    expectCustomConnectorInvalidations([member.userId]);
    await expect(callbackResponse.json()).resolves.toStrictEqual({
      redirectUrl: `${provider.appLinkOrigin}/client/bot/open?appId=${appId}`,
    });
    expect(oauthTokenRedirectUris).toStrictEqual([
      `${APP_ORIGIN}${provider.callbackPath}`,
    ]);

    const linkedMemberState = await readFeishuMemberConnectorState(context, {
      orgId: requireValue(member.orgId, "Expected an organization"),
      userId: member.userId,
      installationId,
    });
    const linkedConnectorId = requireValue(
      linkedMemberState.feishu_member_connection?.connector_id,
      "Expected linked Feishu connector account",
    );
    const reconnectResponse = await oauthApp.request(appConnectUrl);
    expect(reconnectResponse.status).toBe(307);
    const reconnectState = requireValue(
      new URL(reconnectResponse.headers.get("location") ?? "").searchParams.get(
        "state",
      ),
      "Expected reconnect OAuth state",
    );
    await expect(
      readConnectorOAuthAccountMutation(context, reconnectState),
    ).resolves.toMatchObject({
      account_mutation: {
        intent: "reconnect",
        connectionId: linkedConnectorId,
      },
    });

    const legacyReplacementOpenId = "ou_legacy_replacement_user";
    oauthUserOpenId = legacyReplacementOpenId;
    clearConnectorInvalidationMocks();
    const legacyCallbackResponse = await oauthApp.request(
      `${feishuOauthContract.callback.path}?${new URLSearchParams({
        code: "legacy-feishu-oauth-code",
        responseMode: "json",
        state: legacyFeishuAppOAuthState({
          installationId,
          orgId: requireValue(member.orgId, "Expected an organization"),
          userId: member.userId,
          publicBrand: "vm0",
          redirectUri: `${FEISHU_CALLBACK_ORIGIN}/api/integrations/feishu/oauth/callback`,
        }),
      })}`,
    );
    expect(legacyCallbackResponse.status).toBe(200);
    expectCustomConnectorInvalidations([member.userId]);
    expect(oauthTokenRedirectUris).toStrictEqual([
      `${APP_ORIGIN}${provider.callbackPath}`,
      `${FEISHU_CALLBACK_ORIGIN}/api/integrations/feishu/oauth/callback`,
    ]);
    await expect(
      readFeishuMemberConnectorState(context, {
        orgId: requireValue(member.orgId, "Expected an organization"),
        userId: member.userId,
        installationId,
      }),
    ).resolves.toMatchObject({
      feishu_member_connection: {
        connector_id: linkedConnectorId,
        open_id: legacyReplacementOpenId,
      },
    });
    await flushWaitUntilForTest();

    mocks.clerk.session(member.userId, member.orgId, member.orgRole);
    await expectExactFeishuMemberConnector({
      client,
      installationId,
      member,
      expectedOpenId: legacyReplacementOpenId,
    });
    const connectedConnectorList = await accept(
      customConnectorClient.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(connectedConnectorList.body.connectors).toMatchObject([
      {
        id: managedConnector.id,
        connected: true,
      },
    ]);
    const welcome = outboundMessages.find((message) => {
      return (
        message.kind === "send" &&
        message.target === "ou_oauth_user" &&
        messageContent(message).includes("You're connected!")
      );
    });
    expect(welcome?.msgType).toBe("interactive");

    clearConnectorInvalidationMocks();
    await accept(
      client.disconnectInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId },
      }),
      [200],
    );
    expectCustomConnectorInvalidations([member.userId]);
    await expect(
      readCustomConnectorCredentialStorageParent(context, {
        orgId: requireValue(
          member.orgId,
          "Expected Feishu member to have an organization",
        ),
        userId: member.userId,
        customConnectorId: managedConnector.id,
      }),
    ).resolves.toMatchObject({ connector: null });
    const disconnectedConnectorList = await accept(
      customConnectorClient.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(disconnectedConnectorList.body.connectors).toMatchObject([
      {
        id: managedConnector.id,
        connected: false,
      },
    ]);
    const disconnectedMemberStatus = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(disconnectedMemberStatus.body.installations).toMatchObject([
      {
        id: installationId,
        isConnected: false,
      },
    ]);

    mocks.clerk.session(admin.userId, admin.orgId, admin.orgRole);
    mockAuthoritativeOrganizationMembers([admin, member]);
    clearConnectorInvalidationMocks();
    await accept(
      client.removeInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId },
      }),
      [200],
    );
    expectCustomConnectorInvalidations([admin.userId, member.userId]);
    const removedConnectorList = await accept(
      customConnectorClient.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(removedConnectorList.body.connectors).toStrictEqual([]);
    await expect(
      storagesApi.downloadStorage(admin, {
        name: managedSkillStorageName,
        owner: "organization",
        version: managedSkillHead.versionId,
      }),
    ).resolves.toMatchObject({ versionId: managedSkillHead.versionId });
  });

  it("uses the configured Okou origins for Feishu OAuth", async () => {
    const appOrigin = "https://app.okou.ai";
    const apiOrigin = "https://api.okou.ai";
    mockEnv("APP_URL", "https://app.okou.ai");
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
    mockEnv("FEISHU_CALLBACK_BASE_URL", "https://api.okou.ai");

    const fixture = await setupFeishuRunFixture();
    expect(new URL(fixture.callbackUrl).origin).toBe(apiOrigin);
    mocks.clerk.session(
      fixture.actor.userId,
      fixture.actor.orgId,
      fixture.actor.orgRole,
    );
    const client = setupApp({ context, routes: feishuConnectRoutes })(
      connectContract,
    );
    const status = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
        extraHeaders: { origin: appOrigin },
      }),
      [200],
    );
    const appCallbackUrl = `${appOrigin}${provider.callbackPath}`;
    expect(status.body.oauthRedirectUrl).toBe(appCallbackUrl);
    expect(status.body.installations?.[0]?.oauthRedirectUrl).toBe(
      appCallbackUrl,
    );
    const connectUrl = requireValue(
      status.body.connectUrl,
      "Expected Okou Feishu connect URL",
    );
    expect(new URL(connectUrl).origin).toBe(apiOrigin);
    const signedState = requireValue(
      new URL(connectUrl).searchParams.get("state"),
      "Expected signed Okou Feishu state",
    );
    const [encodedState] = signedState.split(".");
    expect(
      JSON.parse(Buffer.from(encodedState ?? "", "base64url").toString()),
    ).toMatchObject({ publicBrand: "okou", redirectUri: appCallbackUrl });

    const oauthApp = createAppWithRoutes({
      signal: context.signal,
      routes: feishuOauthRoutes,
    });
    const connectResponse = await oauthApp.request(connectUrl);
    expect(connectResponse.status).toBe(307);
    const authorizationUrl = new URL(
      connectResponse.headers.get("location") ?? "",
    );
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      appCallbackUrl,
    );
    const connectorState = requireValue(
      authorizationUrl.searchParams.get("state"),
      "Expected persisted Okou connector state",
    );
    expect(connectorState).toMatch(/^[0-9a-f]{64}$/u);

    const providerError = {
      error: "access_denied",
      error_description: "Provider denied access",
      state: connectorState,
    };
    const handoffResponse = await oauthApp.request(
      `${feishuOauthContract.callback.path}?${new URLSearchParams(providerError)}`,
    );
    expect(handoffResponse.status).toBe(307);
    const handoffUrl = new URL(handoffResponse.headers.get("location") ?? "");
    expect(handoffUrl.origin).toBe(appOrigin);
    expect(handoffUrl.pathname).toBe(`${provider.callbackPath}`);

    const failureResponse = await oauthApp.request(
      `${feishuOauthContract.callback.path}?${new URLSearchParams({
        ...providerError,
        responseMode: "json",
      })}`,
    );
    expect(failureResponse.status).toBe(200);
    const failureBody = (await failureResponse.json()) as {
      readonly redirectUrl: string;
    };
    const failureUrl = new URL(failureBody.redirectUrl);
    expect(failureUrl.origin).toBe(appOrigin);
    expect(failureUrl.pathname).toBe(`${provider.settingsPath}`);
    expect(failureUrl.searchParams.get("error")).toBe("Provider denied access");

    const retryResponse = await oauthApp.request(connectUrl);
    expect(retryResponse.status).toBe(307);
    const retryAuthorizationUrl = new URL(
      retryResponse.headers.get("location") ?? "",
    );
    const completionUrl = await completeFeishuAuthorization(
      retryAuthorizationUrl,
      "ou_oauth_user",
      { intent: "add" },
    );
    expect(completionUrl.toString()).toBe(
      `${provider.appLinkOrigin}/client/bot/open?appId=${fixture.appId}`,
    );
    expect(oauthTokenRedirectUris).toStrictEqual([appCallbackUrl]);
  });

  it("uses the configured Okou origins for Feishu message-link OAuth", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
    mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
    mockEnv("FEISHU_CALLBACK_BASE_URL", "https://api.okou.ai");

    const fixture = await setupFeishuRunFixture();
    mocks.clerk.session(
      fixture.actor.userId,
      fixture.actor.orgId,
      fixture.actor.orgRole,
    );
    await postEvent(
      fixture.callbackUrl,
      directMessage(fixture.appId, "connect with persisted Okou branding"),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    const loginReply = requireValue(
      outboundMessages.find((message) => {
        return messageContent(message).includes("Connect your account");
      }),
      "Expected Feishu login reply",
    );
    const connectUrl = requireValue(
      messageContent(loginReply).match(/https:\/\/[^"]+/u)?.[0],
      "Expected Feishu connect URL",
    );
    expect(new URL(connectUrl).origin).toBe("https://app.okou.ai");

    const response = await createAppWithRoutes({
      signal: context.signal,
      routes: feishuBrowserConnectRoutes,
    }).request("/api/feishu/connect", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "__session=opaque",
        origin: "https://app.okou.ai",
      },
      body: JSON.stringify(feishuConnectBody(connectUrl)),
    });
    const authorizationUrl = await feishuAuthorizationUrlFromResponse(response);
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      `https://app.okou.ai${provider.callbackPath}`,
    );
    expect(authorizationUrl.searchParams.get("state")).toMatch(
      /^[0-9a-f]{64}$/u,
    );
    const completionUrl = await completeFeishuAuthorization(
      authorizationUrl,
      "ou_feishu_user",
      { intent: "add" },
    );
    expect(completionUrl.toString()).toBe(
      `${provider.appLinkOrigin}/client/bot/open?appId=${fixture.appId}`,
    );
    expect(oauthTokenRedirectUris).toStrictEqual([
      `https://app.okou.ai${provider.callbackPath}`,
    ]);
  });

  it("verifies and decrypts URL verification callbacks", async () => {
    const appId = `cli_${randomUUID()}`;
    const actor = authOrgApi.user({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      orgRole: "org:admin",
    });
    authOrgApi.acceptAgentStorageWrites();
    await enableFeishuIntegration(platform, actor);
    const agent = await authOrgApi.createAgent(actor, {
      displayName: "Feishu callback agent",
      visibility: "public",
    });
    mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
    const client = setupApp({ context, routes: feishuConnectRoutes })(
      connectContract,
    );
    const configured = await accept(
      client.setup({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          appId,
          appSecret: APP_SECRET,
          verificationToken: VERIFICATION_TOKEN,
          encryptKey: ENCRYPT_KEY,
          defaultAgentId: agent.agentId,
        },
      }),
      [200],
    );
    const callbackUrl = configured.body.callbackUrl;
    expect(callbackUrl).not.toBeNull();
    if (!callbackUrl) {
      throw new Error("Expected Feishu setup to return a callback URL");
    }
    const payload = {
      type: "url_verification",
      challenge: "challenge-value",
      token: VERIFICATION_TOKEN,
    };

    const plaintextResponse = await postEvent(callbackUrl, payload, {
      signed: false,
    });
    expect(plaintextResponse.status).toBe(200);
    await expect(plaintextResponse.json()).resolves.toStrictEqual({
      challenge: "challenge-value",
    });

    const response = await postEvent(callbackUrl, payload, {
      encrypted: true,
      signed: false,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      challenge: "challenge-value",
    });

    const event = v2Event(appId, "unknown.event", {});
    const rejected = await postEvent(callbackUrl, event, {
      encrypted: true,
      validSignature: false,
    });
    expect(rejected.status).toBe(401);

    const stale = await postEvent(callbackUrl, event, {
      encrypted: true,
      timestamp: 0,
    });
    expect(stale.status).toBe(401);
    const status = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(status.body.callbackVerified).toBeTruthy();
    await accept(
      client.remove({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
  });

  it("backfills bot identity before handling a group mention", async () => {
    const appId = `cli_${randomUUID()}`;
    const actor = authOrgApi.user({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      orgRole: "org:admin",
    });
    authOrgApi.acceptAgentStorageWrites();
    await enableFeishuIntegration(platform, actor);
    const agent = await authOrgApi.createAgent(actor, {
      displayName: "Feishu compatibility agent",
      visibility: "public",
    });
    mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
    const client = setupApp({ context, routes: feishuConnectRoutes })(
      connectContract,
    );
    const configured = await accept(
      client.setup({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          appId,
          appSecret: APP_SECRET,
          verificationToken: VERIFICATION_TOKEN,
          encryptKey: ENCRYPT_KEY,
          defaultAgentId: agent.agentId,
        },
      }),
      [200],
    );
    const callbackUrl = configured.body.callbackUrl;
    if (!callbackUrl) {
      throw new Error("Expected Feishu callback URL");
    }

    await postEvent(
      callbackUrl,
      groupMessage(appId, "group task after upgrade"),
      { encrypted: true },
    );
    await flushWaitUntilForTest();

    const loginReply = outboundMessages.find((message) => {
      return (
        message.kind === "reply" &&
        messageContent(message).includes("Connect your account")
      );
    });
    expect(loginReply?.replyInThread).toBeTruthy();
    const status = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(status.body.installations?.[0]?.botName).toBe("Okou Feishu");

    await accept(
      client.remove({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
  });

  it("emits the final path and serves it", async () => {
    const fixture = await setupFeishuRunFixture();
    expect(fixture.callbackUrl).toBe(
      `${FEISHU_CALLBACK_ORIGIN}/api/webhooks/feishu/events/${fixture.installationId}`,
    );
    const event = v2Event(fixture.appId, "unknown.event", {});
    const url = new URL(
      `/api/webhooks/feishu/events/${fixture.installationId}`,
      fixture.callbackUrl,
    ).toString();

    const accepted = await postEvent(url, event, { encrypted: true });
    expect(accepted.status).toBe(200);
    await expect(accepted.text()).resolves.toBe("OK");

    const rejected = await postEvent(url, event, {
      encrypted: true,
      validSignature: false,
    });
    expect(rejected.status).toBe(401);
    await expect(rejected.json()).resolves.toStrictEqual({
      error: "Invalid Feishu signature",
    });
  });

  it("retries a durably admitted Feishu event after dispatch fails", async () => {
    const fixture = await setupFeishuRunFixture();
    const { appId, callbackUrl } = fixture;
    const messageId = `om_${randomUUID()}`;
    const event = directMessage(appId, "retry this Feishu event", undefined, {
      messageId,
    });
    failedSendTargets.push(messageId);

    const firstResponse = await postEvent(callbackUrl, event, {
      encrypted: true,
    });
    expect(firstResponse.status).toBe(200);
    await flushWaitUntilForTest();
    expect(outboundMessages).toHaveLength(0);

    const retryResponse = await postEvent(callbackUrl, event, {
      encrypted: true,
    });
    expect(retryResponse.status).toBe(200);
    await flushWaitUntilForTest();
    const loginReplies = outboundMessages.filter((message) => {
      return messageContent(message).includes("Connect your account");
    });
    expect(loginReplies).toHaveLength(1);
  });

  it.each([
    "installation status",
    "unconnected commands",
    "connected commands",
  ] as const)(
    "uses Okou branding for %s without renaming the provider bot",
    async (phase) => {
      mockEnv("APP_URL", "https://app.okou.ai");
      server.use(
        http.get(`${provider.apiOrigin}/open-apis/bot/v3/info`, () => {
          return HttpResponse.json({
            code: 0,
            bot: {
              open_id: BOT_OPEN_ID,
              app_name: "Owner Managed Bot",
              avatar_url: "https://example.com/owner-managed-bot.png",
            },
          });
        }),
      );
      const fixture = await setupFeishuRunFixture();
      mocks.clerk.session(
        fixture.actor.userId,
        fixture.actor.orgId,
        fixture.actor.orgRole,
      );
      const client = setupApp({ context, routes: feishuConnectRoutes })(
        connectContract,
      );

      if (phase === "installation status") {
        const status = await accept(
          client.getStatus({
            headers: { authorization: "Bearer clerk-session" },
            extraHeaders: { origin: "https://app.okou.ai" },
          }),
          [200],
        );
        expect(status.body.publicBrand).toBe("okou");
        expect(status.body.installations?.[0]).toMatchObject({
          publicBrand: "okou",
          botName: "Owner Managed Bot",
          callbackUrl: fixture.callbackUrl,
        });
      } else if (phase === "unconnected commands") {
        await postEvent(
          fixture.callbackUrl,
          directMessage(fixture.appId, "/help", "ou_feishu_unconnected"),
          { encrypted: true },
        );
        await postEvent(
          fixture.callbackUrl,
          directMessage(fixture.appId, "hello", "ou_feishu_unconnected"),
          { encrypted: true },
        );
        await flushWaitUntilForTest();
        const unconnectedContent = outboundMessages
          .map(messageContent)
          .join("\n");
        expect(unconnectedContent).toContain("Owner Managed Bot commands");
        expect(unconnectedContent).toContain(`To use Okou in ${provider.name}`);
        const connectUrl = requireValue(
          unconnectedContent.match(/https:\/\/[^"\\]+/u)?.[0],
          "Expected branded Feishu connect URL",
        );
        expect(new URL(connectUrl).hostname).toBe("app.okou.ai");
      } else {
        outboundMessages = [];
        await connectFixtureUser(fixture);
        await postEvent(
          fixture.callbackUrl,
          directMessage(fixture.appId, "/help"),
          { encrypted: true },
        );
        await postEvent(
          fixture.callbackUrl,
          directMessage(fixture.appId, "/connect"),
          { encrypted: true },
        );
        await flushWaitUntilForTest();
        const connectedContent = outboundMessages
          .map(messageContent)
          .join("\n");
        expect(connectedContent).toContain("Owner Managed Bot commands");
        expect(connectedContent).toContain(
          `Your ${provider.name} account is already connected to Okou`,
        );
      }
      mocks.clerk.session(
        fixture.actor.userId,
        fixture.actor.orgId,
        fixture.actor.orgRole,
      );
      await accept(
        client.removeInstallation({
          headers: { authorization: "Bearer clerk-session" },
          params: { installationId: fixture.installationId },
        }),
        [200],
      );
    },
  );

  it.each(["input context", "asynchronous delivery"] as const)(
    "uses Okou for Feishu %s",
    async (phase) => {
      const fixture = await setupFeishuRunFixture({
        useSystemDefaultIdentity: true,
      });
      await connectFixtureUser(fixture);
      const prompt = "run with the Okou default identity";

      await postEvent(
        fixture.callbackUrl,
        directMessage(fixture.appId, prompt),
        {
          encrypted: true,
        },
      );
      await flushWaitUntilForTest();

      const run = await findRun(fixture.actor, prompt);

      if (phase === "input context") {
        const inputEvent = requireValue(
          await findFeishuChatEventByPromptFixture({
            userId: fixture.actor.userId,
            prompt,
          }),
          "Expected the Host-branded Feishu input event",
        );
        await expect(
          readChatEventContextFixture(inputEvent.eventId),
        ).resolves.toMatchObject({ feishuPublicBrand: "okou" });

        await runsApi.requestCancelRun(fixture.actor, run.id, [200]);
      } else {
        await runsApi.heartbeatRunner(fixture.runnerGroup);
        const claim = await runsApi.claimRunnerJob(run.id);
        expect(claim.appendSystemPrompt).toContain("Your name is Okou.");
        outboundMessages = [];
        await completeRunSession({
          runId: run.id,
          sandboxToken: claim.sandboxToken,
          sessionId: `bdd-feishu-host-brand-${run.id}`,
          history: `bdd Feishu host brand history ${run.id}`,
          assistantText: "Host-branded Feishu response",
        });
        await flushWaitUntilForTest();
        const delivered = requireValue(
          outboundMessages.find((message) => {
            return messageContent(message).includes(
              "Host-branded Feishu response",
            );
          }),
          "Expected the asynchronous Feishu response",
        );
        expect(messageContent(delivered)).toContain('"content":"Okou"');
      }
    },
  );

  it.each(["input context", "claimed run"] as const)(
    "restores the legacy Feishu brand in %s",
    async (phase) => {
      const fixture = await setupFeishuRunFixture({
        useSystemDefaultIdentity: true,
      });
      await connectFixtureUser(fixture);
      const eventId = `evt_legacy_brand_${randomUUID()}`;
      const messageId = `om_legacy_brand_${randomUUID()}`;
      const prompt = `legacy Okou ingress ${randomUUID()}`;
      const providerEvent = directMessage(
        fixture.appId,
        prompt,
        "ou_feishu_user",
        { eventId, messageId },
      );
      await seedLegacyFeishuIngressFixture({
        installationId: fixture.installationId,
        eventId,
        payload: JSON.stringify({
          installationId: fixture.installationId,
          eventId,
          tenantKey: TENANT_KEY,
          appId: fixture.appId,
          messageId,
          chatId: "oc_feishu_dm",
          chatType: "p2p",
          rootId: null,
          parentId: null,
          threadId: null,
          openId: "ou_feishu_user",
          text: prompt,
          promptText: prompt,
          files: [],
        }),
      });

      const retried = await postEvent(fixture.callbackUrl, providerEvent, {
        encrypted: true,
      });
      expect(retried.status).toBe(200);
      await flushWaitUntilForTest();

      const run = await findRun(fixture.actor, prompt);

      if (phase === "input context") {
        const inputEvent = requireValue(
          await findFeishuChatEventByPromptFixture({
            userId: fixture.actor.userId,
            prompt,
          }),
          "Expected the legacy Feishu ingress to become a canonical event",
        );
        await expect(
          readChatEventContextFixture(inputEvent.eventId),
        ).resolves.toMatchObject({ feishuPublicBrand: "okou" });
      } else {
        await runsApi.heartbeatRunner(fixture.runnerGroup);
        const claim = await runsApi.claimRunnerJob(run.id);
        expect(claim.appendSystemPrompt).toContain("Your name is Okou.");
      }
      await runsApi.requestCancelRun(fixture.actor, run.id, [200]);
    },
  );

  it.each(["connection identity", "rotated callback"] as const)(
    "preserves the custom Feishu app's %s when credentials rotate",
    async (phase) => {
      const fixture = await setupFeishuRunFixture();
      await connectFixtureUser(fixture);
      const orgId = requireValue(
        fixture.actor.orgId,
        "Expected an organization",
      );
      const connectionBefore = await readFeishuMemberConnectorState(context, {
        orgId,
        userId: fixture.actor.userId,
        installationId: fixture.installationId,
      });
      const rotatedVerificationToken = `rotated-${randomUUID()}`;
      mocks.clerk.session(
        fixture.actor.userId,
        fixture.actor.orgId,
        fixture.actor.orgRole,
      );
      const client = setupApp({ context, routes: feishuConnectRoutes })(
        connectContract,
      );
      const customConnectorClient = setupApp({
        context,
        routes: customConnectorsRoutes,
      })(customConnectorsContract);
      const before = await accept(
        customConnectorClient.list({
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );
      const connectorBefore = requireValue(
        before.body.connectors[0],
        "Expected the managed Feishu connector",
      );

      const retried = await accept(
        client.setup({
          headers: { authorization: "Bearer clerk-session" },
          extraHeaders: { origin: "https://app.okou.ai" },
          body: {
            installationId: fixture.installationId,
            appId: fixture.appId,
            appSecret: APP_SECRET,
            verificationToken: rotatedVerificationToken,
            encryptKey: ENCRYPT_KEY,
            defaultAgentId: fixture.defaultAgentId,
          },
        }),
        [200],
      );
      expect(retried.body.publicBrand).toBe("okou");
      expect(retried.body.installations?.[0]).toMatchObject({
        id: fixture.installationId,
        publicBrand: "okou",
        botName: "Okou Feishu",
        callbackUrl: fixture.callbackUrl,
        callbackVerified: false,
        setupCompleted: true,
        isConnected: true,
      });

      if (phase === "connection identity") {
        const after = await accept(
          customConnectorClient.list({
            headers: { authorization: "Bearer clerk-session" },
          }),
          [200],
        );
        expect(after.body.connectors).toStrictEqual([
          expect.objectContaining({
            id: connectorBefore.id,
            storageVersion: connectorBefore.storageVersion,
            oauthConfig: expect.objectContaining({ clientId: fixture.appId }),
          }),
        ]);
        await expect(
          readFeishuMemberConnectorState(context, {
            orgId,
            userId: fixture.actor.userId,
            installationId: fixture.installationId,
          }),
        ).resolves.toStrictEqual(connectionBefore);
      } else {
        const prompt = `use the existing Feishu connection ${randomUUID()}`;
        const eventResponse = await postEvent(
          fixture.callbackUrl,
          directMessage(fixture.appId, prompt, "ou_feishu_user", {
            verificationToken: rotatedVerificationToken,
          }),
          { encrypted: true },
        );
        expect(eventResponse.status).toBe(200);
        await flushWaitUntilForTest();
        const run = await findRun(fixture.actor, prompt);
        await runsApi.requestCancelRun(fixture.actor, run.id, [200]);
      }
      await accept(
        client.removeInstallation({
          headers: { authorization: "Bearer clerk-session" },
          params: { installationId: fixture.installationId },
        }),
        [200],
      );
    },
  );

  it.each(["installation state", "original callback"] as const)(
    "preserves the %s after rejecting a replacement Feishu app",
    async (phase) => {
      const fixture = await setupFeishuRunFixture();
      await connectFixtureUser(fixture);
      mocks.clerk.session(
        fixture.actor.userId,
        fixture.actor.orgId,
        fixture.actor.orgRole,
      );
      const client = feishuConnectClient(platform);
      const customConnectorClient = setupApp({
        context,
        routes: customConnectorsRoutes,
      })(customConnectorsContract);
      const connectorsBefore = await accept(
        customConnectorClient.list({
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );

      const rejected = await accept(
        client.setup({
          headers: { authorization: "Bearer clerk-session" },
          extraHeaders: { origin: "https://app.okou.ai" },
          body: {
            installationId: fixture.installationId,
            appId: `cli_replacement_${randomUUID()}`,
            appSecret: "replacement-app-secret",
            verificationToken: "replacement-verification-token",
            encryptKey: "replacement-encrypt-key",
            defaultAgentId: fixture.alternateAgentId,
          },
        }),
        [409],
      );
      expect(rejected.body.error.message).toContain(
        "cannot be changed to a different App ID",
      );

      if (phase === "installation state") {
        const status = await accept(
          client.getStatus({
            headers: { authorization: "Bearer clerk-session" },
          }),
          [200],
        );
        expect(status.body.installations?.[0]).toMatchObject({
          id: fixture.installationId,
          appId: fixture.appId,
          botName: "Okou Feishu",
          botAvatarUrl: "https://example.com/okou-feishu.png",
          callbackUrl: fixture.callbackUrl,
          callbackVerified: true,
          setupCompleted: true,
          isConnected: true,
          tenantKey: TENANT_KEY,
          defaultAgentId: fixture.defaultAgentId,
        });
        const connectorsAfter = await accept(
          customConnectorClient.list({
            headers: { authorization: "Bearer clerk-session" },
          }),
          [200],
        );
        expect(connectorsAfter.body.connectors).toStrictEqual(
          connectorsBefore.body.connectors,
        );
      } else {
        outboundMessages = [];
        const oldProviderEvent = await postEvent(
          fixture.callbackUrl,
          directMessage(fixture.appId, "/help"),
          { encrypted: true },
        );
        expect(oldProviderEvent.status).toBe(200);
        await flushWaitUntilForTest();
        expect(outboundMessages.map(messageContent).join("\n")).toContain(
          "Okou Feishu commands",
        );
      }
      await accept(
        client.removeInstallation({
          headers: { authorization: "Bearer clerk-session" },
          params: { installationId: fixture.installationId },
        }),
        [200],
      );
    },
  );

  it("rejects an in-place setup update that resolves to a different provider bot", async () => {
    const fixture = await setupFeishuRunFixture();
    server.use(
      http.get(`${provider.apiOrigin}/open-apis/bot/v3/info`, () => {
        return HttpResponse.json({
          code: 0,
          bot: {
            open_id: "ou_replacement_bot",
            app_name: "Replacement Bot",
            avatar_url: "https://example.com/replacement-bot.png",
          },
        });
      }),
    );
    mocks.clerk.session(
      fixture.actor.userId,
      fixture.actor.orgId,
      fixture.actor.orgRole,
    );
    const client = setupApp({ context, routes: feishuConnectRoutes })(
      connectContract,
    );
    const rejected = await accept(
      client.updateInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId: fixture.installationId },
        body: {
          defaultAgentId: fixture.defaultAgentId,
          setupCompleted: true,
        },
      }),
      [409],
    );
    expect(rejected.body.error.message).toContain("different bot identity");
    const status = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(status.body.installations?.[0]).toMatchObject({
      botName: "Okou Feishu",
      botAvatarUrl: "https://example.com/okou-feishu.png",
    });
    await accept(
      client.removeInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId: fixture.installationId },
      }),
      [200],
    );
  });

  it("deduplicates unconnected messages and sends one connect link", async () => {
    const fixture = await setupFeishuRunFixture();
    const { appId, callbackUrl } = fixture;

    const firstMessageId = `om_${randomUUID()}`;
    const firstEvent = directMessage(appId, "hello", undefined, {
      messageId: firstMessageId,
    });
    const firstMessage = await postEvent(callbackUrl, firstEvent, {
      encrypted: true,
    });
    const duplicateMessage = await postEvent(callbackUrl, firstEvent, {
      encrypted: true,
    });
    expect(firstMessage.status).toBe(200);
    expect(duplicateMessage.status).toBe(200);
    await flushWaitUntilForTest();
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "feishu:changed",
      null,
    );
    const loginReplies = outboundMessages.filter((message) => {
      return message.kind === "reply";
    });
    expect(loginReplies).toHaveLength(1);
    const firstReply = loginReplies[0];
    expect(firstReply?.target).toBe(firstMessageId);
    expect(firstReply?.replyInThread).toBeTruthy();
    expect(firstReply?.msgType).toBe("interactive");
    const firstReplyContent = firstReply ? messageContent(firstReply) : "";
    expect(firstReplyContent).toContain("Connect your account");
    expect(firstReplyContent).toContain(
      `To use Okou in ${provider.name}, please connect your account first.`,
    );
    const connectUrl = requireValue(
      firstReplyContent.match(/https:\/\/[^"]+/u)?.[0],
      "Expected Feishu to send a connect URL",
    );
    expect(`${new URL(connectUrl).origin}${new URL(connectUrl).pathname}`).toBe(
      `${APP_ORIGIN}${provider.settingsPath}`,
    );
  });

  it("preserves agent access and retries welcome when reconnecting", async () => {
    const fixture = await setupFeishuRunFixture();
    const { actor, appId, defaultAgentId } = fixture;
    const client = setupApp({ context, routes: feishuConnectRoutes })(
      connectContract,
    );
    const connectUrl = await requestFeishuConnectUrl(fixture);

    const connectApp = createAppWithRoutes({
      signal: context.signal,
      routes: feishuBrowserConnectRoutes,
    });
    failedSendTargets.push("ou_feishu_user");
    context.mocks.ably.publish.mockClear();
    const connectResponse = await connectApp.request("/api/feishu/connect", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "__session=opaque",
      },
      body: JSON.stringify(feishuConnectBody(connectUrl)),
    });
    const authorizationUrl =
      await feishuAuthorizationUrlFromResponse(connectResponse);
    expect(
      authorizationUrl.searchParams.get("scope")?.split(" "),
    ).toStrictEqual([...EXPECTED_FEISHU_OAUTH_SCOPES]);
    const completionUrl = await completeFeishuAuthorization(
      authorizationUrl,
      "ou_feishu_user",
      { intent: "add" },
    );
    expect(completionUrl.toString()).toBe(
      `${provider.appLinkOrigin}/client/bot/open?appId=${appId}`,
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "feishu:changed",
      null,
    );
    const connectedStatus = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(connectedStatus.body.installations?.[0]?.connectedUserName).toBe(
      "Feishu User",
    );
    await flushWaitUntilForTest();
    expect(
      outboundMessages.some((message) => {
        return (
          message.target === "ou_feishu_user" &&
          messageContent(message).includes("You're connected!")
        );
      }),
    ).toBeFalsy();
    const managedConnector = requireValue(
      (await authOrgApi.listCustomConnectors(actor)).connectors.find(
        (connector) => {
          return connector.permissionBundleRef === "builtin:feishu@1";
        },
      ),
      "Expected managed Feishu custom connector",
    );
    const agentAccessClient = setupApp({ context, routes: agentsRoutes })(
      agentCustomConnectorsContract,
    );
    const selectedPermissions = ["messages:send-as-user"];
    await accept(
      agentAccessClient.update({
        headers: { authorization: "Bearer clerk-session" },
        params: { id: defaultAgentId },
        body: {
          grants: [
            {
              customConnectorId: managedConnector.id,
              permissionNames: selectedPermissions,
            },
          ],
          operation: "add",
        },
      }),
      [200],
    );
    const retryConnectResponse = await connectApp.request(
      "/api/feishu/connect",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "__session=opaque",
        },
        body: JSON.stringify(feishuConnectBody(connectUrl)),
      },
    );
    const retryAuthorizationUrl =
      await feishuAuthorizationUrlFromResponse(retryConnectResponse);
    const memberState = await readFeishuMemberConnectorState(context, {
      orgId: requireValue(actor.orgId, "Expected an organization"),
      userId: actor.userId,
      installationId: fixture.installationId,
    });
    const memberConnectorId = requireValue(
      memberState.feishu_member_connection?.connector_id,
      "Expected Feishu member connector linkage",
    );
    await completeFeishuAuthorization(retryAuthorizationUrl, "ou_feishu_user", {
      intent: "reconnect",
      connectionId: memberConnectorId,
    });
    const preservedAccess = await accept(
      agentAccessClient.get({
        headers: { authorization: "Bearer clerk-session" },
        params: { id: defaultAgentId },
      }),
      [200],
    );
    expect(preservedAccess.body.grants).toContainEqual({
      customConnectorId: managedConnector.id,
      permissionNames: selectedPermissions,
    });
    await flushWaitUntilForTest();
    const welcome = outboundMessages.find((message) => {
      return (
        message.kind === "send" &&
        message.target === "ou_feishu_user" &&
        messageContent(message).includes("You're connected!")
      );
    });
    expect(welcome?.msgType).toBe("interactive");
    expect(welcome ? messageContent(welcome) : "").toContain("Okou");
  });

  it("rejects account rebinding and replaces the connected identity", async () => {
    const fixture = await setupFeishuRunFixture();
    const { actor, appId, callbackUrl, defaultAgentId } = fixture;
    const connectUrl = await connectFixtureUser(fixture);
    const client = setupApp({ context, routes: feishuConnectRoutes })(
      connectContract,
    );
    const connectApp = createAppWithRoutes({
      signal: context.signal,
      routes: feishuBrowserConnectRoutes,
    });
    const memberState = await readFeishuMemberConnectorState(context, {
      orgId: requireValue(actor.orgId, "Expected an organization"),
      userId: actor.userId,
      installationId: fixture.installationId,
    });
    const memberConnectorId = requireValue(
      memberState.feishu_member_connection?.connector_id,
      "Expected Feishu member connector linkage",
    );

    const otherActor = authOrgApi.user({
      userId: `user_${randomUUID()}`,
      orgId: actor.orgId,
      orgRole: "org:member",
    });
    mocks.clerk.session(otherActor.userId, otherActor.orgId, "org:member");
    const rebindResponse = await connectApp.request("/api/feishu/connect", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "__session=opaque",
      },
      body: JSON.stringify(feishuConnectBody(connectUrl)),
    });
    const rebindAuthorizationUrl =
      await feishuAuthorizationUrlFromResponse(rebindResponse);
    const rebindCompletionUrl = await completeFeishuAuthorization(
      rebindAuthorizationUrl,
      "ou_feishu_user",
      { intent: "add" },
    );
    expect(rebindCompletionUrl.pathname).toBe(`${provider.settingsPath}`);
    expect(rebindCompletionUrl.searchParams.get("error")).toBe(
      `This ${provider.name} account is already connected.`,
    );
    mocks.clerk.session(actor.userId, actor.orgId, "org:admin");

    outboundMessages = [];
    const replacementOpenId = "ou_feishu_replacement_user";
    await postEvent(
      callbackUrl,
      directMessage(appId, "connect replacement identity", replacementOpenId),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    const replacementLogin = requireValue(
      outboundMessages.find((message) => {
        return messageContent(message).includes("Connect your account");
      }),
      "Expected replacement Feishu identity to receive a connect link",
    );
    const replacementConnectUrl = requireValue(
      messageContent(replacementLogin).match(/https:\/\/[^"]+/u)?.[0],
      "Expected replacement Feishu connect URL",
    );
    const legacyReplacementConnectUrl = new URL(
      "/api/feishu/connect",
      "https://www.okou.test",
    );
    legacyReplacementConnectUrl.search = new URL(replacementConnectUrl).search;
    const replacementResponse = await connectApp.request(
      legacyReplacementConnectUrl.toString(),
      {
        headers: { cookie: "__session=opaque" },
      },
    );
    expect(replacementResponse.status).toBe(307);
    const replacementAuthorizationUrl = new URL(
      requireValue(
        replacementResponse.headers.get("location"),
        "Expected replacement Feishu authorization URL",
      ),
    );
    expect(replacementAuthorizationUrl.origin).toBe(
      `${provider.accountsOrigin}`,
    );
    await completeFeishuAuthorization(
      replacementAuthorizationUrl,
      replacementOpenId,
      { intent: "reconnect", connectionId: memberConnectorId },
    );
    await expect(
      readFeishuMemberConnectorState(context, {
        orgId: requireValue(actor.orgId, "Expected an organization"),
        userId: actor.userId,
        installationId: fixture.installationId,
      }),
    ).resolves.toMatchObject({
      feishu_member_connection: {
        connector_id: memberConnectorId,
        open_id: replacementOpenId,
      },
    });
    await flushWaitUntilForTest();

    outboundMessages = [];
    await postEvent(
      callbackUrl,
      directMessage(appId, "old identity should reconnect"),
      {
        encrypted: true,
      },
    );
    await postEvent(
      callbackUrl,
      directMessage(appId, "/help", replacementOpenId),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    const replacementResults = outboundMessages.map(messageContent);
    expect(replacementResults).toStrictEqual(
      expect.arrayContaining([
        expect.stringContaining("Connect your account"),
        expect.stringContaining("Okou Feishu commands"),
      ]),
    );

    const status = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(status.body).toMatchObject({
      isInstalled: true,
      isConnected: true,
      isAdmin: true,
      appId,
      callbackVerified: true,
      messageReceived: true,
      tenantKey: TENANT_KEY,
      defaultAgentId,
    });
    await accept(
      client.removeInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId: fixture.installationId },
      }),
      [200],
    );
  });

  it("handles connected commands and disconnects the current user", async () => {
    const fixture = await setupFeishuRunFixture();
    const { appId, callbackUrl } = fixture;
    await connectFixtureUser(fixture);
    const client = setupApp({ context, routes: feishuConnectRoutes })(
      connectContract,
    );
    for (const command of [
      "/help",
      "/connect",
      "/switch",
      "/model",
      "/unknown",
    ]) {
      await postEvent(callbackUrl, directMessage(appId, command), {
        encrypted: true,
      });
      await flushWaitUntilForTest();
    }
    const commandReplies = outboundMessages
      .filter((message) => {
        return message.kind === "reply";
      })
      .map(messageContent);
    const helpReply = requireValue(
      outboundMessages.find((message) => {
        return messageContent(message).includes("Okou Feishu commands");
      }),
      "Expected Feishu help reply",
    );
    expect(helpReply.msgType).toBe("text");
    expect(
      commandReplies.some((content) => {
        return content.includes("Okou Feishu commands");
      }),
    ).toBeTruthy();
    expect(
      commandReplies.some((content) => {
        return content.includes("Already connected");
      }),
    ).toBeTruthy();
    expect(
      commandReplies.some((content) => {
        return content.includes("Choose an agent");
      }),
    ).toBeTruthy();
    expect(
      commandReplies.some((content) => {
        return content.includes("Choose a model");
      }),
    ).toBeTruthy();
    clearConnectorInvalidationMocks();
    await postEvent(callbackUrl, directMessage(appId, "/disconnect"), {
      encrypted: true,
    });
    await flushWaitUntilForTest();
    expectCustomConnectorInvalidations([fixture.actor.userId]);
    expect(
      outboundMessages.some((message) => {
        return messageContent(message).includes("Disconnected");
      }),
    ).toBeTruthy();
    clearConnectorInvalidationMocks();
    await postEvent(callbackUrl, directMessage(appId, "/disconnect"), {
      encrypted: true,
    });
    await flushWaitUntilForTest();
    expectCustomConnectorInvalidations([]);
    expect(
      outboundMessages.some((message) => {
        return messageContent(message).includes("You are not connected.");
      }),
    ).toBeTruthy();
    const disconnectedStatus = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(disconnectedStatus.body).toMatchObject({
      isInstalled: true,
      isConnected: false,
    });
    await accept(
      client.removeInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId: fixture.installationId },
      }),
      [200],
    );
  });

  it.each([
    { type: "image", privateFiles: false },
    { type: "file", privateFiles: false },
    { type: "image", privateFiles: true },
    { type: "file", privateFiles: true },
  ] as const)(
    "imports a Feishu $type before dispatch (private=$privateFiles)",
    async ({ type, privateFiles }) => {
      const fixture = await setupFeishuRunFixture();
      await connectFixtureUser(fixture);
      const { actor, runnerGroup, appId, callbackUrl } = fixture;
      const flagActor = {
        ...actor,
        orgId: requireValue(actor.orgId, "Expected organization"),
      };
      await updateFeatureSwitchesForUser(context, flagActor, {
        [FeatureSwitchKey.PrivateArtifacts]: privateFiles,
      });
      const uploads = captureIntegrationInputUploads(context);
      const messageId = `om_${randomUUID()}`;
      const fileKey = `file_${randomUUID()}`;
      const bytes = Buffer.from(`canonical ${type} bytes`);
      const contentType = type === "image" ? "image/png" : "application/pdf";
      let downloads = 0;
      server.use(
        http.get(
          `${provider.apiOrigin}/open-apis/im/v1/messages/${messageId}/resources/${fileKey}`,
          ({ request }) => {
            expect(new URL(request.url).searchParams.get("type")).toBe(type);
            expect(request.headers.get("authorization")).toBe(
              "Bearer tenant-access-token",
            );
            downloads += 1;
            return new HttpResponse(bytes, {
              headers: { "content-type": contentType },
            });
          },
        ),
      );
      const eventData = {
        sender: {
          sender_id: { open_id: "ou_feishu_user" },
          sender_type: "user",
        },
        message: {
          message_id: messageId,
          chat_id: "oc_feishu_dm",
          chat_type: "p2p",
          message_type: type,
          content: JSON.stringify(
            type === "image"
              ? { image_key: fileKey }
              : { file_key: fileKey, file_name: "report.pdf" },
          ),
        },
      };
      const event = v2Event(appId, "im.message.receive_v1", eventData);
      await postEvent(callbackUrl, event, { encrypted: true });
      await flushWaitUntilForTest();
      const listed = await runsApi.listAgentRuns(actor, { limit: 20 });
      const run = requireValue(
        listed.runs.find((candidate) => {
          return candidate.prompt.includes("[Web file]");
        }),
        "Expected imported file run",
      );
      await runsApi.heartbeatRunner(runnerGroup);
      const claim = await runsApi.claimRunnerJob(run.id);
      const fileId = requireValue(
        claim.prompt.match(/ {3}\[ID\] ([^\n]+)/u)?.[1],
        "Expected canonical file id",
      );
      expect(claim.prompt).not.toContain(fileKey);
      await updateFeatureSwitchesForUser(context, flagActor, {
        [FeatureSwitchKey.PrivateArtifacts]: !privateFiles,
      });
      await expectIntegrationInputPreview(context, {
        privateFiles,
        actor,
        fileId,
        bytes,
        contentType,
        uploads,
        okouToken: claim.platformEnvironment.OKOU_TOKEN,
      });
      await postEvent(callbackUrl, event, { encrypted: true });
      await flushWaitUntilForTest();
      await postEvent(
        callbackUrl,
        v2Event(appId, "im.message.receive_v1", {
          ...eventData,
          message: { ...eventData.message, message_id: `om_${randomUUID()}` },
        }),
        { encrypted: true },
      );
      await flushWaitUntilForTest();
      expect(downloads).toBe(1);
      expect(uploads).toHaveLength(1);
      await expect(
        listIntegrationInputFileParts(context, actor),
      ).resolves.toStrictEqual([
        expect.objectContaining({ fileId }),
        expect.objectContaining({ fileId }),
      ]);
    },
  );

  it.each([403, 429, 503])(
    "applies Slack retry policy to Feishu file HTTP %s across messages",
    async (status) => {
      const fixture = await setupFeishuRunFixture();
      await connectFixtureUser(fixture);
      const { actor, runnerGroup, appId, callbackUrl } = fixture;
      const uploads = captureIntegrationInputUploads(context);
      const fileKey = `file_${randomUUID()}`;
      const bytes = Buffer.from("recovered Feishu input");
      let upstreamFailed = true;
      let downloads = 0;
      server.use(
        http.get(
          `${provider.apiOrigin}/open-apis/im/v1/messages/:messageId/resources/${fileKey}`,
          () => {
            downloads += 1;
            return upstreamFailed
              ? new HttpResponse(null, { status })
              : new HttpResponse(bytes, {
                  headers: { "content-type": "application/pdf" },
                });
          },
        ),
      );
      const postFile = async () => {
        await postEvent(
          callbackUrl,
          v2Event(appId, "im.message.receive_v1", {
            sender: {
              sender_id: { open_id: "ou_feishu_user" },
              sender_type: "user",
            },
            message: {
              message_id: `om_${randomUUID()}`,
              chat_id: "oc_feishu_dm",
              chat_type: "p2p",
              message_type: "file",
              content: JSON.stringify({
                file_key: fileKey,
                file_name: "retry-policy.pdf",
              }),
            },
          }),
          { encrypted: true },
        );
        await flushWaitUntilForTest();
      };
      await postFile();
      const firstParts = await listIntegrationInputFileParts(context, actor);
      expect(firstParts).toHaveLength(1);
      const fileId = requireValue(
        firstParts[0]?.fileId,
        "Expected failed file item",
      );
      expect(fileId).toMatch(/^[0-9a-f-]{36}$/u);
      const listed = await runsApi.listAgentRuns(actor, { limit: 20 });
      const run = requireValue(listed.runs[0], "Expected native file run");
      await runsApi.heartbeatRunner(runnerGroup);
      const claim = await runsApi.claimRunnerJob(run.id);
      expect(claim.prompt).not.toContain("[Web file]");
      upstreamFailed = false;
      await postFile();
      await expect(
        listIntegrationInputFileParts(context, actor),
      ).resolves.toStrictEqual([
        expect.objectContaining({ fileId }),
        expect.objectContaining({ fileId }),
      ]);
      const delivery = await runsApi.reserveRunnerActiveInputs(
        claim.sandboxToken,
        run.id,
      );
      if (delivery.outcome !== "reserved") {
        throw new Error("Expected the next Feishu file message");
      }
      const retryable = status === 429 || status >= 500;
      expect(downloads).toBe(retryable ? 2 : 1);
      expect(uploads).toHaveLength(retryable ? 1 : 0);
      if (retryable) {
        expect(delivery.prompt).toContain(`[ID] ${fileId}`);
        await expectIntegrationInputPreview(context, {
          actor,
          fileId,
          bytes,
          contentType: "application/pdf",
          uploads,
          okouToken: claim.platformEnvironment.OKOU_TOKEN,
        });
      } else {
        expect(delivery.prompt).not.toContain("[Web file]");
      }
    },
  );

  it("runs a Feishu DM file with downloadable resource context", async () => {
    const fixture = await setupFeishuRunFixture();
    const { actor, runnerGroup, appId, callbackUrl, defaultAgentId } = fixture;
    oauthTokenExpiresInSeconds = 0;
    await connectFixtureUser(fixture);
    const customConnectorClient = setupApp({
      context,
      routes: customConnectorsRoutes,
    })(customConnectorsContract);
    const connectorList = await accept(
      customConnectorClient.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    const managedConnector = requireValue(
      connectorList.body.connectors[0],
      "Expected connected Feishu custom connector",
    );
    const managedSkill = await storagesApi.downloadStorage(actor, {
      name: getCustomConnectorSkillStorageName(managedConnector.id),
      owner: "organization",
    });
    const customConnectorGrants = await accept(
      setupApp({ context, routes: agentsRoutes })(
        agentCustomConnectorsContract,
      ).get({
        headers: { authorization: "Bearer clerk-session" },
        params: { id: defaultAgentId },
      }),
      [200],
    );
    expect(customConnectorGrants.body.grants).toStrictEqual([
      {
        customConnectorId: managedConnector.id,
        permissionNames: [],
      },
    ]);
    const fileKey = `file_v2_${"a".repeat(1400)}`;
    await postEvent(
      callbackUrl,
      directFileMessage(appId, {
        messageId: "om_file_message",
        fileKey,
        filename: "quarterly-report.pdf",
      }),
      { encrypted: true },
    );
    await flushWaitUntilForTest();

    const feishuFilePrompt = `[${provider.name} file] quarterly-report.pdf`;
    const listed = await runsApi.listAgentRuns(actor, { limit: 20 });
    const run = requireValue(
      listed.runs.find((candidate) => {
        return candidate.prompt.includes(feishuFilePrompt);
      }),
      "Expected Feishu file run",
    );
    await runsApi.heartbeatRunner(runnerGroup);
    const claim = await runsApi.claimRunnerJob(run.id);
    expect(claim.prompt).toBe(run.prompt);
    expect(oauthTokenGrantTypes).toStrictEqual(["authorization_code"]);
    expect(oauthRefreshTokens).toStrictEqual([]);
    const internalName = `custom_connector_${managedConnector.id.replaceAll(
      "-",
      "",
    )}`;
    expect(
      claim.firewalls?.find((entry) => {
        return entry.kind === "inline"
          ? entry.firewall.name === internalName
          : entry.name === internalName;
      }),
    ).toMatchObject({
      kind: "inline",
      firewall: {
        name: internalName,
        apis: [
          {
            base: `${provider.apiOrigin}/open-apis/`,
            auth: {
              headers: {
                Authorization: expect.stringContaining("secrets."),
              },
            },
            permissions: expect.arrayContaining([
              expect.objectContaining({
                name: "standard:use",
                rules: expect.arrayContaining([
                  "GET /authen/v1/user_info",
                  "GET /docx/{path*}",
                ]),
              }),
              expect.objectContaining({
                name: "messages:send-as-user",
                rules: expect.arrayContaining([
                  "POST /im/v1/messages",
                  "POST /im/v1/messages/{message_id}/forward",
                  "DELETE /im/v1/messages/{message_id}",
                ]),
              }),
              expect.objectContaining({
                name: "resources:delete",
                rules: expect.arrayContaining([
                  "DELETE /drive/{path*}",
                  "DELETE /docx/{path*}",
                  "POST /bitable/v1/apps/{app_token}/tables/batch_delete",
                ]),
              }),
              expect.objectContaining({
                name: "sharing:manage",
                rules: expect.arrayContaining([
                  "PATCH /drive/v2/permissions/{path*}",
                ]),
              }),
              expect.objectContaining({
                name: "chats:manage",
                rules: expect.arrayContaining([
                  "POST /im/v1/chats/{chat_id}/members",
                  "POST /im/v1/chats/{chat_id}/{path*}",
                  "PATCH /im/v1/chats/{chat_id}/{path*}",
                ]),
              }),
              expect.objectContaining({
                name: "comments:write",
                rules: expect.arrayContaining([
                  "POST /drive/v1/files/{file_token}/comments",
                ]),
              }),
              expect.objectContaining({
                name: "calendar:write",
                rules: expect.arrayContaining([
                  "POST /calendar/v4/calendars/{calendar_id}/events",
                ]),
              }),
              expect.objectContaining({
                name: "tasks:write",
                rules: expect.arrayContaining(["POST /task/v2/{path*}"]),
              }),
            ]),
          },
        ],
      },
    });
    expect(claim.networkPolicies?.[internalName]).toStrictEqual({
      allow: [
        "standard:use",
        "sharing:manage",
        "comments:write",
        "calendar:write",
        "tasks:write",
      ],
      deny: ["messages:send-as-user", "resources:delete", "chats:manage"],
      ask: [],
      unknownPolicy: "deny",
    });
    const permissionGrant = await accept(
      setupApp({ context, routes: agentsRoutes })(
        agentCustomConnectorsContract,
      ).update({
        headers: { authorization: "Bearer clerk-session" },
        params: { id: defaultAgentId },
        body: {
          grants: [
            {
              customConnectorId: managedConnector.id,
              permissionNames: ["messages:send-as-user"],
            },
          ],
          operation: "replace",
        },
      }),
      [200],
    );
    expect(permissionGrant.body.grants).toStrictEqual([
      {
        customConnectorId: managedConnector.id,
        permissionNames: ["messages:send-as-user"],
      },
    ]);
    const managedSkillMount = expectCanonicalStorageManifest(
      claim.storageManifest,
    )?.storageMounts.find((storage) => {
      return (
        storage.name === getCustomConnectorSkillStorageName(managedConnector.id)
      );
    });
    expect(managedSkillMount?.versionId).toBe(managedSkill.versionId);
    expect(claim.prompt).toContain(feishuFilePrompt);
    expect(claim.prompt).toContain("   [MESSAGE_ID] om_file_message");
    expect(claim.prompt).toContain("   [TYPE] file");
    const fileId = claim.prompt.match(/ {3}\[FILE_KEY\] ([^\n]+)/u)?.[1];
    expect(fileId).toMatch(/^feishu_file_[A-Za-z0-9_-]{22}$/u);
    expect(fileId?.length).toBeLessThan(64);
    expect(claim.prompt).not.toContain(fileKey);
    expect(claim.prompt).toContain(`   [FILE_KEY] ${fileId}`);
    expect(claim.appendSystemPrompt).toContain(
      `okou ${platform} download-file -h`,
    );
    expect(claim.appendSystemPrompt).toContain(
      `okou ${platform} upload-file -h`,
    );

    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const threadEvents = await accept(
      setupApp({ context, routes: chatThreadRoutes })(
        chatThreadsContract,
      ).events({
        headers: { authorization: "Bearer clerk-session" },
        query: {},
      }),
      [200],
    );
    const chatThreadCreated = requireValue(
      threadEvents.body.events.find((event) => {
        return event.kind === "created" && event.agentId === defaultAgentId;
      }),
      "Expected the canonical Feishu file chat thread",
    );
    const threadEventsPage = await readProjectedChatEvents(context, {
      threadId: chatThreadCreated.chatThreadId,
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(threadEventsPage).toContainEqual(
      expect.objectContaining({
        content: null,
        userMessage: {
          version: 1,
          parts: [
            expect.objectContaining({
              type: "file",
              filenameSnapshot: "quarterly-report.pdf",
            }),
            { type: "text", text: expect.stringContaining(feishuFilePrompt) },
            {
              type: "source",
              kind: "feishu",
              href: `${provider.appLinkOrigin}/client/chat/open?openChatId=oc_feishu_dm`,
            },
          ],
        },
      }),
    );

    const fileBytes = Buffer.from("feishu file bytes");
    server.use(
      http.get(
        `${provider.apiOrigin}/open-apis/im/v1/messages/:messageId/resources/:fileKey`,
        ({ params, request }) => {
          expect(params.messageId).toBe("om_file_message");
          expect(params.fileKey).toBe(fileKey);
          expect(new URL(request.url).searchParams.get("type")).toBe("file");
          return new HttpResponse(fileBytes, {
            status: 200,
            headers: {
              "content-type": "application/pdf",
              "content-length": String(fileBytes.length),
              "content-disposition":
                'attachment; filename="quarterly-report.pdf"',
            },
          });
        },
      ),
    );
    const app = createAppWithRoutes({
      signal: context.signal,
      routes: integrationsFeishuFileRoutes,
    });
    const downloadResponse = await app.request(
      `/api/integrations/${platform}/download-file?${new URLSearchParams({
        message_id: "om_misquoted_by_model",
        file_key: fileId ?? "",
        type: "image",
      }).toString()}`,
      {
        headers: {
          authorization: `Bearer ${runsApi.okouTokenForRunWithCapabilities(
            actor,
            run.id,
            [`${platform}:write`],
          )}`,
        },
      },
    );
    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.headers.get("x-file-name")).toBe(
      "quarterly-report.pdf",
    );
    expect(
      Buffer.from(await downloadResponse.arrayBuffer()).equals(fileBytes),
    ).toBeTruthy();

    const wrongRunResponse = await app.request(
      `/api/integrations/${platform}/download-file?${new URLSearchParams({
        message_id: "om_file_message",
        file_key: fileId ?? "",
        type: "file",
      }).toString()}`,
      {
        headers: {
          authorization: `Bearer ${runsApi.okouTokenForRunWithCapabilities(
            actor,
            randomUUID(),
            [`${platform}:write`],
          )}`,
        },
      },
    );
    expect(wrongRunResponse.status).toBe(400);
  });

  it.each(["p2p", "group"] as const)(
    "runs a rich post with imported and native images in %s",
    async (chatType) => {
      const fixture = await setupFeishuRunFixture();
      const { actor, runnerGroup, appId, callbackUrl, defaultAgentId } =
        fixture;
      await connectFixtureUser(fixture);
      const messageId = `om_post_${randomUUID()}`;
      const uploads = captureIntegrationInputUploads(context);
      const imageBytes = Buffer.from("first rich post image");
      server.use(
        http.get(
          `${provider.apiOrigin}/open-apis/im/v1/messages/${messageId}/resources/img_post_first`,
          () => {
            return new HttpResponse(imageBytes, {
              headers: { "content-type": "image/png" },
            });
          },
        ),
      );
      const rows = [
        [
          ...(chatType === "group" ? [{ tag: "at", user_id: "@_user_1" }] : []),
          { tag: "text", text: "Compare these images with " },
          { tag: "a", text: "the brief", href: "https://example.com/brief" },
        ],
        [{ tag: "img", image_key: "img_post_first", width: 720, height: 1080 }],
        [{ tag: "img", image_key: "img_post_second" }],
        [{ tag: "img", image_key: "img_post_first" }],
      ];
      const message = {
        message_id: messageId,
        chat_id: chatType === "p2p" ? "oc_feishu_dm" : "oc_feishu_group",
        chat_type: chatType,
        message_type: "post",
        content: JSON.stringify({
          title: "Image comparison",
          content: rows,
          content_v2: rows,
        }),
      };
      const sender = {
        sender_id: { open_id: "ou_feishu_user" },
        sender_type: "user",
      };
      if (chatType === "group") {
        await postEvent(
          callbackUrl,
          v2Event(appId, "im.message.receive_v1", {
            sender,
            message: {
              ...message,
              message_id: `om_unmentioned_${randomUUID()}`,
            },
          }),
          { encrypted: true },
        );
        await flushWaitUntilForTest();
        expect(
          (await runsApi.listAgentRuns(actor, { limit: 20 })).runs,
        ).toHaveLength(0);
      }
      const event = v2Event(appId, "im.message.receive_v1", {
        sender,
        message: {
          ...message,
          mentions:
            chatType === "group"
              ? [
                  {
                    key: "@_user_1",
                    id: { open_id: BOT_OPEN_ID },
                    name: "Nova",
                  },
                ]
              : [],
        },
      });
      expect(
        (await postEvent(callbackUrl, event, { encrypted: true })).status,
      ).toBe(200);
      await postEvent(callbackUrl, event, { encrypted: true });
      await flushWaitUntilForTest();
      const listed = await runsApi.listAgentRuns(actor, { limit: 20 });
      expect(listed.runs).toHaveLength(1);
      const run = requireValue(listed.runs[0], "Expected a rich post run");
      await runsApi.heartbeatRunner(runnerGroup);
      const claim = await runsApi.claimRunnerJob(run.id);
      expect(claim.prompt).toContain("Image comparison\n");
      expect(claim.prompt).toContain(
        "Compare these images with [the brief](https://example.com/brief)",
      );
      if (chatType === "group") {
        expect(claim.prompt).toContain("@Nova");
      }
      const importedFileId = requireValue(
        claim.prompt.match(/ {3}\[ID\] ([^\n]+)/u)?.[1],
        "Expected the imported rich post image",
      );
      expect(uploads).toHaveLength(1);
      await expectIntegrationInputPreview(context, {
        actor,
        fileId: importedFileId,
        bytes: imageBytes,
        contentType: "image/png",
        uploads,
        okouToken: claim.platformEnvironment.OKOU_TOKEN,
      });
      await expectFeishuResourceDownloads({
        actor,
        runId: run.id,
        prompt: claim.prompt,
        resources: [{ messageId, fileKey: "img_post_second", type: "image" }],
      });

      const threads = await accept(
        setupApp({ context, routes: chatThreadRoutes })(
          chatThreadsContract,
        ).events({
          headers: { authorization: "Bearer clerk-session" },
          query: {},
        }),
        [200],
      );
      const thread = requireValue(
        threads.body.events.find((event) => {
          return event.kind === "created" && event.agentId === defaultAgentId;
        }),
        "Expected a canonical rich post thread",
      );
      const events = await readProjectedChatEvents(context, {
        threadId: thread.chatThreadId,
        headers: { authorization: "Bearer clerk-session" },
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          userMessage: {
            version: 1,
            parts: [
              expect.objectContaining({
                type: "file",
                fileId: importedFileId,
                filenameSnapshot: "image",
              }),
              expect.objectContaining({
                type: "file",
                filenameSnapshot: "image",
              }),
              {
                type: "text",
                text: expect.stringContaining(
                  "Image comparison\nCompare these images with [the brief](https://example.com/brief)",
                ),
              },
              expect.objectContaining({ type: "source", kind: "feishu" }),
            ],
          },
        }),
      );
      await completeRunSession({
        runId: run.id,
        sandboxToken: claim.sandboxToken,
        sessionId: `rich-post-${run.id}`,
        history: `rich post history ${run.id}`,
        assistantText: "Here is the image comparison.",
      });
      const reply = outboundMessages.find((outbound) => {
        return messageContent(outbound).includes(
          "Here is the image comparison.",
        );
      });
      expect(reply).toMatchObject({
        kind: "reply",
        target: messageId,
        replyInThread: true,
      });
      await removeFeishuInstallation(fixture);
    },
  );

  it("preserves agent card replies, artifact links and rich post resources in history", async () => {
    const fixture = await setupFeishuRunFixture();
    const { actor, runnerGroup, appId, callbackUrl } = fixture;
    await connectFixtureUser(fixture);
    const artifacts = {
      deck: "https://example.com/artifacts/deck.html?version=2",
      source: "https://example.com/artifacts/source.pptx",
      report: "https://example.com/artifacts/report.pdf",
    };
    historyMessages = [
      {
        message_id: "om_history_post",
        msg_type: "post",
        create_time: "1",
        sender: {
          id: "ou_feishu_user",
          sender_name: "Linghan",
          sender_type: "user",
        },
        mentions: [{ key: "@_user_1", id: "ou_reviewer", name: "Reviewer" }],
        body: {
          content: JSON.stringify({
            title: "Review request",
            content: [
              [
                { tag: "at", user_id: "@_user_1" },
                { tag: "text", text: " check this screenshot" },
              ],
              [{ tag: "img", image_key: "img_history_post" }],
            ],
          }),
        },
      },
      {
        message_id: "om_history_legacy_card",
        msg_type: "interactive",
        create_time: "2",
        sender: { id: BOT_OPEN_ID, sender_name: "Okou", sender_type: "app" },
        body: {
          content: JSON.stringify({
            header: { title: { tag: "plain_text", content: "Okou" } },
            elements: [
              {
                tag: "div",
                text: {
                  tag: "lark_md",
                  content: "The earlier report is ready.",
                },
              },
              {
                tag: "action",
                actions: [
                  {
                    tag: "button",
                    text: { tag: "plain_text", content: "Download report" },
                    multi_url: { url: artifacts.report },
                  },
                ],
              },
            ],
          }),
        },
      },
      {
        message_id: "om_history_card",
        msg_type: "interactive",
        create_time: "3",
        sender: { id: BOT_OPEN_ID, sender_name: "Okou", sender_type: "app" },
        body: {
          content: JSON.stringify({
            schema: "2.0",
            header: { title: { tag: "plain_text", content: "Okou" } },
            body: {
              elements: [
                {
                  tag: "markdown",
                  content: `I fixed the chart and created the [deck](${artifacts.deck}).`,
                },
                {
                  tag: "column_set",
                  columns: [
                    {
                      tag: "column",
                      elements: [
                        {
                          tag: "button",
                          text: {
                            tag: "plain_text",
                            content: "Download source",
                          },
                          behaviors: [
                            { type: "open_url", default_url: artifacts.source },
                          ],
                        },
                      ],
                    },
                  ],
                },
                {
                  tag: "img",
                  img_key: "img_history_card",
                  alt: { tag: "plain_text", content: "Chart preview" },
                },
              ],
            },
          }),
        },
      },
      {
        message_id: "om_history_file",
        msg_type: "file",
        create_time: "4",
        sender: { id: BOT_OPEN_ID, sender_name: "Okou", sender_type: "app" },
        body: {
          content: JSON.stringify({
            file_key: "file_history_deck",
            file_name: "source.pptx",
          }),
        },
      },
    ];
    server.use(
      http.get(
        `${provider.apiOrigin}/open-apis/im/v1/messages`,
        ({ request }) => {
          const originalCards =
            new URL(request.url).searchParams.get("card_msg_content_type") ===
            "user_card_content";
          return HttpResponse.json({
            code: 0,
            data: {
              items: historyMessages.map((message) => {
                return message.msg_type === "interactive" && !originalCards
                  ? {
                      ...message,
                      body: {
                        content: JSON.stringify({
                          title: "Okou",
                          elements: [
                            [{ tag: "img", image_key: "img_rendered_preview" }],
                          ],
                        }),
                      },
                    }
                  : message;
              }),
              has_more: false,
            },
          });
        },
      ),
    );
    const prompt = "Revise the deck using the previous answer and screenshot";
    await postEvent(callbackUrl, directMessage(appId, prompt), {
      encrypted: true,
    });
    await flushWaitUntilForTest();
    const run = await findRun(actor, prompt);
    await runsApi.heartbeatRunner(runnerGroup);
    const claim = await runsApi.claimRunnerJob(run.id);
    const history = requireValue(
      claim.appendSystemPrompt,
      "Expected conversation history",
    );
    expect(history).toContain(`- SENDER: {id: ${BOT_OPEN_ID}, name: Okou}`);
    expect(history).toContain("- SENDER: {id: ou_feishu_user, name: Linghan}");
    expect(history).toContain("@Reviewer (ou_reviewer) check this screenshot");
    expect(history).toContain("The earlier report is ready.");
    expect(history).toContain(
      `I fixed the chart and created the [deck](${artifacts.deck}).`,
    );
    expect(history).toContain(`[Download source](${artifacts.source})`);
    expect(history).toContain(`[Download report](${artifacts.report})`);
    expect(history).toContain("Chart preview");
    expect(history).toContain(`[${provider.name} file] source.pptx`);
    expect(history).toContain("- RELATIVE_INDEX: -4");
    expect(history).toContain("- RELATIVE_INDEX: -1");
    expect(history).not.toContain("[interactive message]");
    await expectFeishuResourceDownloads({
      actor,
      runId: run.id,
      prompt: history,
      resources: [
        {
          messageId: "om_history_post",
          fileKey: "img_history_post",
          type: "image",
        },
        {
          messageId: "om_history_card",
          fileKey: "img_history_card",
          type: "image",
        },
        {
          messageId: "om_history_file",
          fileKey: "file_history_deck",
          type: "file",
        },
      ],
    });
    await runsApi.requestCancelRun(actor, run.id, [200]);
    await flushWaitUntilForTest();
    await removeFeishuInstallation(fixture);
  });

  it("renders system message history and retains unreadable message placeholders", async () => {
    const fixture = await setupFeishuRunFixture();
    const { actor, runnerGroup, appId, callbackUrl } = fixture;
    await connectFixtureUser(fixture);
    const messages = [
      {
        content: JSON.stringify({
          template: "{from_user} invited {to_chatters} to this chat.",
          from_user: ["Ada"],
          to_chatters: ["Sam", "John", "Mary"],
        }),
        expected: "Ada invited Sam, John, Mary to this chat.",
      },
      {
        content: JSON.stringify({
          template: "{from_user} invited {to_chatters}. Thanks, {from_user}.",
          from_user: ["{to_chatters} $&"],
          to_chatters: ["Sam"],
        }),
        expected: "{to_chatters} $& invited Sam. Thanks, {to_chatters} $&.",
      },
      {
        content: JSON.stringify({
          template: "{from_user}邀请{to_chatters}加入了群聊。",
          from_user: ["小明"],
          to_chatters: ["小红", "小李"],
        }),
        expected: "小明邀请小红, 小李加入了群聊。",
      },
      {
        content: JSON.stringify({
          template: "{from_user} updated {missing_field}.",
          from_user: ["Ada"],
        }),
        expected: "Ada updated {missing_field}.",
      },
      {
        content: JSON.stringify({ template: "Group settings changed." }),
        expected: "Group settings changed.",
      },
      { content: "not JSON", expected: "[system message]" },
      {
        content: JSON.stringify({ template: "{from_user}", from_user: [123] }),
        expected: "[system message]",
      },
      {
        content: JSON.stringify({ template: "{from_user}", from_user: [] }),
        expected: "[system message]",
      },
    ];
    historyMessages = messages.map((message, index) => {
      return {
        message_id: `om_system_history_${index}`,
        msg_type: "system",
        create_time: String(index + 1),
        body: { content: message.content },
      };
    });

    const prompt = "Explain the recent chat membership changes";
    await postEvent(callbackUrl, directMessage(appId, prompt), {
      encrypted: true,
    });
    await flushWaitUntilForTest();
    const run = await findRun(actor, prompt);
    await runsApi.heartbeatRunner(runnerGroup);
    const claim = await runsApi.claimRunnerJob(run.id);
    const history = requireValue(
      claim.appendSystemPrompt,
      "Expected conversation history",
    );
    for (const message of messages) {
      expect(history).toContain(message.expected);
    }
    expect(history.match(/\[system message\]/gu)).toHaveLength(3);
    await runsApi.requestCancelRun(actor, run.id, [200]);
    await flushWaitUntilForTest();
    await removeFeishuInstallation(fixture);
  });

  it("claims a Feishu message when conversation history loading fails", async () => {
    const fixture = await setupFeishuRunFixture();
    const { actor, runnerGroup, appId, callbackUrl } = fixture;
    await connectFixtureUser(fixture);
    server.use(
      http.get(`${provider.apiOrigin}/open-apis/im/v1/messages`, () => {
        return HttpResponse.json(
          { code: 99_999, msg: "history unavailable" },
          { status: 500 },
        );
      }),
    );

    const prompt = "continue without Feishu history";
    await postEvent(
      callbackUrl,
      directMessage(appId, prompt, "ou_feishu_user"),
      { encrypted: true },
    );
    await flushWaitUntilForTest();

    const run = await findRun(actor, prompt);
    await runsApi.heartbeatRunner(runnerGroup);
    const claim = await runsApi.claimRunnerJob(run.id);
    expect(claim.prompt).toBe(prompt);
    expect(claim.appendSystemPrompt).toContain("Scope: Direct message");
    expect(claim.appendSystemPrompt).not.toContain("# Recent Channel Messages");
    expect(claim.appendSystemPrompt).not.toContain(
      `# ${provider.name} Thread Context`,
    );
    await runsApi.requestCancelRun(actor, run.id, [200]);
    await flushWaitUntilForTest();
  });

  it("uses the exact Feishu source without persisting a thread override", async () => {
    const fixture = await setupFeishuRunFixture();
    const { actor, runnerGroup, appId, callbackUrl } = fixture;
    await enableFeishuIntegration(platform, actor, {
      [FeatureSwitchKey.OkouDebug]: true,
    });
    await connectFixtureUser(fixture);
    const orgId = requireValue(actor.orgId, "Expected an organization");
    const connectionState = await readFeishuMemberConnectorState(context, {
      orgId,
      userId: actor.userId,
      installationId: fixture.installationId,
    });
    const connectorId = requireValue(
      connectionState.feishu_member_connection?.connector_id,
      "Expected an exact Feishu member connector",
    );
    const customConnectors = await accept(
      setupApp({ context, routes: customConnectorsRoutes })(
        customConnectorsContract,
      ).list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    const customConnector = requireValue(
      customConnectors.body.connectors[0],
      "Expected the managed Feishu custom connector",
    );
    const accountSummaries = await accept(
      connectorAccountsClient().summaries({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(accountSummaries.body.summaries).not.toContainEqual(
      expect.objectContaining({
        target: {
          kind: "custom",
          customConnectorId: customConnector.id,
        },
      }),
    );
    await accept(
      connectorAccountsClient().connections({
        headers: { authorization: "Bearer clerk-session" },
        query: {
          kind: "custom",
          customConnectorId: customConnector.id,
          limit: 100,
        },
      }),
      [404],
    );
    await accept(
      connectorAccountsClient().connection({
        headers: { authorization: "Bearer clerk-session" },
        params: { connectionId: connectorId },
        query: {
          kind: "custom",
          customConnectorId: customConnector.id,
        },
      }),
      [404],
    );
    await accept(
      connectorAccountsClient().rename({
        headers: { authorization: "Bearer clerk-session" },
        params: { connectionId: connectorId },
        body: {
          target: {
            kind: "custom",
            customConnectorId: customConnector.id,
          },
          displayName: "Generic lifecycle must not rename Feishu",
        },
      }),
      [404],
    );

    const prompt = "use this Feishu connector account";
    context.mocks.ably.publish.mockClear();
    await postEvent(callbackUrl, directMessage(appId, prompt), {
      encrypted: true,
    });
    await flushWaitUntilForTest();
    const run = await findRun(actor, prompt);
    await runsApi.heartbeatRunner(runnerGroup);
    const claim = await runsApi.claimRunnerJob(run.id);
    expect(claim.connectorRuntimeTargets).toContainEqual({
      kind: "custom",
      customConnectorId: customConnector.id,
      baseUrlVars: {},
      sourceId: connectorId,
    });

    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const lifecycle = await accept(
      setupApp({ context, routes: chatThreadRoutes })(
        chatThreadsContract,
      ).events({
        headers: { authorization: "Bearer clerk-session" },
        query: {},
      }),
      [200],
    );
    const created = requireValue(
      lifecycle.body.events.find((event) => {
        return event.kind === "created";
      }),
      "Expected the canonical Feishu chat thread",
    );
    await seedCustomThreadConnectorSelection(context, {
      chatThreadId: created.chatThreadId,
      connectorId,
      customConnectorId: customConnector.id,
    });
    const selections = await accept(
      chatThreadConnectorSelectionsClient().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { id: created.chatThreadId },
      }),
      [200],
    );
    expect(selections.body.selections).toStrictEqual([]);
    expect(selections.body.selectedConnections).toStrictEqual([]);
    await accept(
      chatThreadConnectorSelectionsClient().update({
        headers: { authorization: "Bearer clerk-session" },
        params: { id: created.chatThreadId },
        body: {
          connectionId: connectorId,
          target: {
            kind: "custom",
            customConnectorId: customConnector.id,
          },
        },
      }),
      [400],
    );
    const genericCreate = await accept(
      setupApp({ context, routes: chatThreadRoutes })(
        chatThreadsContract,
      ).create({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          agentId: fixture.defaultAgentId,
          model: "claude-sonnet-5",
          connectorSelections: [
            {
              connectionId: connectorId,
              target: {
                kind: "custom",
                customConnectorId: customConnector.id,
              },
            },
          ],
        },
      }),
      [400],
    );
    expect(genericCreate.body.error.message).toBe(
      "Connector account is unavailable for thread selection",
    );
    expect(context.mocks.ably.publish).not.toHaveBeenCalledWith(
      `chatThreadDetailChanged:${created.chatThreadId}`,
      null,
    );
  });

  it("delivers a readable snapshot of private artifacts in the final reply", async () => {
    const fixture = await setupFeishuRunFixture();
    const { actor, runnerGroup, appId, callbackUrl } = fixture;
    await connectFixtureUser(fixture);
    const artifact = await privateIntegrationArtifact(context, actor);
    outboundMessages = [];
    await postEvent(
      callbackUrl,
      directMessage(appId, "generate a private report"),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    const run = await findRun(actor, "generate a private report");
    await runsApi.heartbeatRunner(runnerGroup);
    const claim = await runsApi.claimRunnerJob(run.id);
    await completeRunSession({
      runId: run.id,
      sandboxToken: claim.sandboxToken,
      sessionId: `artifact-${run.id}`,
      history: `artifact history ${run.id}`,
      assistantText: `Report: [download](${artifact.url})`,
    });
    expect(outboundMessages.at(-1)?.msgType).toBe("interactive");
    await artifact.expectDelivered(
      outboundMessages.map(messageContent).join("\n"),
    );
  });

  it("builds Feishu DM context and canonical response metadata", async () => {
    const fixture = await setupFeishuRunFixture({
      useAlternateInstallationDefault: true,
    });
    const { actor, runnerGroup, appId, callbackUrl, alternateAgentId } =
      fixture;
    await connectFixtureUser(fixture);
    await postEvent(
      callbackUrl,
      directMessage(appId, `/switch ${alternateAgentId}`),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    outboundMessages = [];
    context.mocks.ably.publish.mockClear();
    const historyFileKey = `file_v2_${"b".repeat(200)}`;
    historyMessages = [
      {
        message_id: "om_history_context",
        msg_type: "text",
        create_time: "1",
        sender: {
          id: "ou_previous_user",
          sender_name: "Previous User",
          sender_type: "user",
        },
        body: {
          content: JSON.stringify({
            text: "Earlier Feishu conversation context",
          }),
        },
      },
      {
        message_id: "om_history_file",
        msg_type: "file",
        create_time: "2",
        sender: {
          id: "ou_previous_user",
          sender_name: "Previous User",
          sender_type: "user",
        },
        body: {
          content: JSON.stringify({
            file_key: historyFileKey,
            file_name: "history-report.pdf",
          }),
        },
      },
    ];
    const firstMessageId = `om_${randomUUID()}`;
    await postEvent(
      callbackUrl,
      directMessage(appId, "do the Feishu task", "ou_feishu_user", {
        messageId: firstMessageId,
      }),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    expect(addedReactions).toHaveLength(1);
    expect(context.mocks.ably.publish).not.toHaveBeenCalledWith(
      "feishu:changed",
      null,
    );
    const run = await findRun(actor, "do the Feishu task");
    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const threadEvents = await accept(
      setupApp({ context, routes: chatThreadRoutes })(
        chatThreadsContract,
      ).events({
        headers: { authorization: "Bearer clerk-session" },
        query: {},
      }),
      [200],
    );
    const chatThreadCreated = requireValue(
      threadEvents.body.events.find((event) => {
        return event.kind === "created" && event.agentId === alternateAgentId;
      }),
      "Expected the canonical Feishu chat thread",
    );
    const threadMessages = await readProjectedChatEvents(context, {
      threadId: chatThreadCreated.chatThreadId,
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(threadMessages).toContainEqual(
      expect.objectContaining({
        content: null,
        userMessage: {
          version: 1,
          parts: [
            { type: "text", text: "do the Feishu task" },
            {
              type: "source",
              kind: "feishu",
              href: `${provider.appLinkOrigin}/client/chat/open?openChatId=oc_feishu_dm`,
            },
          ],
        },
      }),
    );
    await runsApi.heartbeatRunner(runnerGroup);
    const claim = await runsApi.claimRunnerJob(run.id);
    expect(claim.prompt).toBe("do the Feishu task");
    expect(claim.platformEnvironment.OKOU_AGENT_ID).toBe(alternateAgentId);
    expect(claim.appendSystemPrompt).toContain(
      `You are currently running inside: ${provider.name}`,
    );
    expect(claim.appendSystemPrompt).toContain("# Current User Info");
    expect(claim.appendSystemPrompt).toContain(
      `${provider.name} messaging and files: use \`okou ${platform} --help\``,
    );
    expect(claim.appendSystemPrompt).not.toContain(
      `${platform === "lark" ? "Feishu" : "Lark"} messaging and files:`,
    );
    expect(claim.appendSystemPrompt).not.toContain(
      `${platform === "lark" ? "Feishu" : "Lark"} open ID:`,
    );
    expect(claim.appendSystemPrompt).toContain(
      `${provider.name} display name: Feishu User`,
    );
    expect(claim.appendSystemPrompt).toContain(
      `${provider.name} open ID: ou_feishu_user`,
    );
    expect(claim.appendSystemPrompt).toContain("Scope: Direct message");
    expect(claim.appendSystemPrompt).toContain(`Tenant key: ${TENANT_KEY}`);
    expect(claim.appendSystemPrompt).toContain("Chat ID: oc_feishu_dm");
    expect(claim.appendSystemPrompt).not.toContain("Group ID:");
    expect(claim.appendSystemPrompt).toContain(
      `Installation ID: ${fixture.installationId}`,
    );
    expect(claim.appendSystemPrompt).toContain(
      "Earlier Feishu conversation context",
    );
    expect(claim.appendSystemPrompt).toContain(
      `[${provider.name} file] history-report.pdf`,
    );
    const historyFileId = (claim.appendSystemPrompt ?? "").match(
      / {3}\[FILE_KEY\] (feishu_file_[A-Za-z0-9_-]{22})/u,
    )?.[1];
    expect(historyFileId).toBeTruthy();
    expect(claim.appendSystemPrompt).not.toContain(historyFileKey);
    expect(claim.appendSystemPrompt).toContain(
      `# ${provider.name} Thread Context`,
    );
    expect(claim.appendSystemPrompt).toContain(
      `The messages below are from a ${provider.name} conversation`,
    );
    expect(claim.appendSystemPrompt).toContain("- RELATIVE_INDEX: -1");
    expect(claim.appendSystemPrompt).toContain(
      "- SENDER: {id: ou_previous_user, name: Previous User}",
    );
    expect(claim.appendSystemPrompt).toContain(
      `okou ${platform} message send --help`,
    );
    expect(claim.appendSystemPrompt).toContain(
      `okou ${platform} download-file -h`,
    );
    expect(claim.appendSystemPrompt).toContain(
      `okou ${platform} upload-file -h`,
    );

    const cliAgentSessionId = `bdd-feishu-cli-${run.id}`;
    await completeRunSession({
      runId: run.id,
      sandboxToken: claim.sandboxToken,
      sessionId: cliAgentSessionId,
      history: `bdd feishu history ${run.id}`,
      assistantText: "Canonical Feishu answer",
    });
    const claimedThreadMessages = await readProjectedChatEvents(context, {
      threadId: chatThreadCreated.chatThreadId,
      headers: { authorization: "Bearer clerk-session" },
    });
    const claimedFeishuMessage = claimedThreadMessages.find((event) => {
      return (
        event.eventType === "input.prompt" &&
        event.revokesEventId !== undefined &&
        event.userMessage.parts.some((part) => {
          return (
            part.type === "source" &&
            part.kind === "feishu" &&
            part.href ===
              `${provider.appLinkOrigin}/client/chat/open?openChatId=oc_feishu_dm`
          );
        })
      );
    });
    if (!claimedFeishuMessage?.revokesEventId) {
      throw new Error("Expected the claimed Feishu message");
    }
    const claimedFeishuContext = await readChatEventContextFixture(
      claimedFeishuMessage.id,
    );
    const pendingFeishuContext = await readChatEventContextFixture(
      claimedFeishuMessage.revokesEventId,
    );
    expect(claimedFeishuContext).toMatchObject({
      contextType: "feishu",
      contextId: expect.any(String),
      feishuMessageText: "do the Feishu task",
      feishuMessageFiles: [
        {
          fileId: expect.any(String),
          messageId: "om_history_file",
          fileKey: historyFileKey,
          type: "file",
        },
      ],
      feishuChatType: "p2p",
      feishuChatId: "oc_feishu_dm",
      feishuMessageId: firstMessageId,
      feishuThreadId: firstMessageId,
      feishuReplyInThread: true,
      feishuReactionId: expect.any(String),
      feishuSenderOpenId: "ou_feishu_user",
      feishuConnectionId: expect.any(String),
      feishuInstallationId: fixture.installationId,
    });
    expect(claimedFeishuContext?.feishuConversationHistory).toContain(
      "Earlier Feishu conversation context",
    );
    expect(pendingFeishuContext).toMatchObject({
      contextType: "feishu",
      contextId: claimedFeishuContext?.contextId,
    });
    const completedReply = [...outboundMessages].reverse().find((message) => {
      return (
        message.kind === "reply" &&
        messageContent(message).includes("Canonical Feishu answer")
      );
    });
    expect(completedReply?.msgType).toBe("interactive");
    expect(completedReply?.target).toBe(firstMessageId);
    expect(completedReply?.replyInThread).toBeTruthy();
    const completedReplyContent = completedReply
      ? messageContent(completedReply)
      : "";
    expect(completedReplyContent).toContain("Audit");
    expect(completedReplyContent).toContain("Okou");
    expect(completedReplyContent).toContain(
      `https://app.okou.ai/activities/${run.id}`,
    );
    expect(completedReplyContent).toContain("Claude Sonnet");
    expect(completedReplyContent).toContain("Responded by Okou");
    expect(removedReactions).toHaveLength(1);

    const client = setupApp({ context, routes: feishuConnectRoutes })(
      connectContract,
    );
    await accept(
      client.removeInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId: fixture.installationId },
      }),
      [200],
    );
  });

  it("resumes Feishu DM sessions across messages", async () => {
    const fixture = await setupFeishuRunFixture();
    const { actor, runnerGroup, appId, callbackUrl } = fixture;
    const { mainSessionId } = await startFeishuDmSession(fixture);

    await postEvent(
      callbackUrl,
      directMessage(appId, "continue the Feishu DM session"),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    const followUpRun = await findRun(actor, "continue the Feishu DM session");
    await runsApi.heartbeatRunner(runnerGroup);
    const followUpClaim = await runsApi.claimRunnerJob(followUpRun.id);
    expect(followUpClaim.resumeSession?.sessionId).toBe(mainSessionId);
    await completeRunSession({
      runId: followUpRun.id,
      sandboxToken: followUpClaim.sandboxToken,
      sessionId: mainSessionId,
      history: `bdd continued feishu history ${followUpRun.id}`,
      assistantText: "Continued Feishu DM answer",
    });

    const client = setupApp({ context, routes: feishuConnectRoutes })(
      connectContract,
    );
    await accept(
      client.removeInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId: fixture.installationId },
      }),
      [200],
    );
  });

  it("keeps quoted Feishu DM input on the main session and replies in a thread", async () => {
    const fixture = await setupFeishuRunFixture();
    const { actor, runnerGroup, appId, callbackUrl } = fixture;
    const { firstMessageId, mainSessionId } =
      await startFeishuDmSession(fixture);

    const quotedReplyMessageId = `om_${randomUUID()}`;
    await postEvent(
      callbackUrl,
      directMessage(
        appId,
        "reply without opening a Feishu thread",
        "ou_feishu_user",
        {
          messageId: quotedReplyMessageId,
          rootId: firstMessageId,
        },
      ),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    const quotedReplyRun = await findRun(
      actor,
      "reply without opening a Feishu thread",
    );
    await runsApi.heartbeatRunner(runnerGroup);
    const quotedReplyClaim = await runsApi.claimRunnerJob(quotedReplyRun.id);
    expect(quotedReplyClaim.resumeSession?.sessionId).toBe(mainSessionId);
    await completeRunSession({
      runId: quotedReplyRun.id,
      sandboxToken: quotedReplyClaim.sandboxToken,
      sessionId: mainSessionId,
      history: `bdd quoted feishu history ${quotedReplyRun.id}`,
      assistantText: "Feishu quoted reply answer",
    });
    const completedQuotedReply = [...outboundMessages]
      .reverse()
      .find((message) => {
        return (
          message.kind === "reply" &&
          messageContent(message).includes("Feishu quoted reply answer")
        );
      });
    expect(completedQuotedReply?.replyInThread).toBeTruthy();
    expect(completedQuotedReply?.target).toBe(quotedReplyMessageId);

    const client = setupApp({ context, routes: feishuConnectRoutes })(
      connectContract,
    );
    await accept(
      client.removeInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId: fixture.installationId },
      }),
      [200],
    );
  });

  it("resets Feishu DM sessions when switching agents", async () => {
    const fixture = await setupFeishuRunFixture();
    const { actor, runnerGroup, appId, callbackUrl, alternateAgentId } =
      fixture;
    await startFeishuDmSession(fixture);

    await postEvent(
      callbackUrl,
      directMessage(appId, `/switch ${alternateAgentId}`),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    await postEvent(
      callbackUrl,
      directMessage(appId, "use the switched Feishu agent"),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    const switchedAgentRun = await findRun(
      actor,
      "use the switched Feishu agent",
    );
    await runsApi.heartbeatRunner(runnerGroup);
    const switchedAgentClaim = await runsApi.claimRunnerJob(
      switchedAgentRun.id,
    );
    expect(switchedAgentClaim.platformEnvironment.OKOU_AGENT_ID).toBe(
      alternateAgentId,
    );
    expect(switchedAgentClaim.resumeSession).toBeNull();
    await runsApi.requestCancelRun(actor, switchedAgentRun.id, [200]);
    await flushWaitUntilForTest();

    const client = setupApp({ context, routes: feishuConnectRoutes })(
      connectContract,
    );
    await accept(
      client.removeInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId: fixture.installationId },
      }),
      [200],
    );
  });

  it("forks Feishu DM threads without replacing the main session", async () => {
    const fixture = await setupFeishuRunFixture();
    const { actor, runnerGroup, appId, callbackUrl } = fixture;
    await connectFixtureUser(fixture);
    const mainMessageId = `om_${randomUUID()}`;
    await postEvent(
      callbackUrl,
      directMessage(appId, "start the main Feishu DM", "ou_feishu_user", {
        messageId: mainMessageId,
      }),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    const initialRun = await findRun(actor, "start the main Feishu DM");
    await runsApi.heartbeatRunner(runnerGroup);
    const initialClaim = await runsApi.claimRunnerJob(initialRun.id);
    expect(initialClaim.resumeSession).toBeNull();
    const mainSessionId = randomUUID();
    await completeRunSession({
      runId: initialRun.id,
      sandboxToken: initialClaim.sandboxToken,
      sessionId: mainSessionId,
      history: `bdd main feishu history ${initialRun.id}`,
    });

    const feishuThreadId = `omt_${randomUUID()}`;
    const threadMessageId = `om_${randomUUID()}`;
    await postEvent(
      callbackUrl,
      directMessage(appId, "open a new Feishu thread", "ou_feishu_user", {
        messageId: threadMessageId,
        rootId: mainMessageId,
        threadId: feishuThreadId,
      }),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    const threadRun = await findRun(actor, "open a new Feishu thread");
    await runsApi.heartbeatRunner(runnerGroup);
    const threadClaim = await runsApi.claimRunnerJob(threadRun.id);
    expect(threadClaim.resumeSession).toBeNull();
    const threadSessionId = randomUUID();
    await completeRunSession({
      runId: threadRun.id,
      sandboxToken: threadClaim.sandboxToken,
      sessionId: threadSessionId,
      history: `bdd feishu thread history ${threadRun.id}`,
    });

    await postEvent(
      callbackUrl,
      directMessage(appId, "return to the main Feishu DM"),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    const mainDmRun = await findRun(actor, "return to the main Feishu DM");
    await runsApi.heartbeatRunner(runnerGroup);
    const mainDmClaim = await runsApi.claimRunnerJob(mainDmRun.id);
    expect(mainDmClaim.resumeSession?.sessionId).toBe(mainSessionId);
    await runsApi.requestCancelRun(actor, mainDmRun.id, [200]);
    await flushWaitUntilForTest();

    const client = setupApp({ context, routes: feishuConnectRoutes })(
      connectContract,
    );
    await accept(
      client.removeInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId: fixture.installationId },
      }),
      [200],
    );
  });

  it("resumes Feishu DM thread sessions and keeps control replies in-thread", async () => {
    const fixture = await setupFeishuRunFixture();
    const { actor, runnerGroup, appId, callbackUrl } = fixture;
    await connectFixtureUser(fixture);
    const rootMessageId = `om_${randomUUID()}`;
    const feishuThreadId = `omt_${randomUUID()}`;
    const threadMessageId = `om_${randomUUID()}`;
    await postEvent(
      callbackUrl,
      directMessage(appId, "start a Feishu thread session", "ou_feishu_user", {
        messageId: threadMessageId,
        rootId: rootMessageId,
        threadId: feishuThreadId,
      }),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    const threadRun = await findRun(actor, "start a Feishu thread session");
    await runsApi.heartbeatRunner(runnerGroup);
    const threadClaim = await runsApi.claimRunnerJob(threadRun.id);
    expect(threadClaim.resumeSession).toBeNull();
    const threadSessionId = randomUUID();
    await completeRunSession({
      runId: threadRun.id,
      sandboxToken: threadClaim.sandboxToken,
      sessionId: threadSessionId,
      history: `bdd resumed feishu thread history ${threadRun.id}`,
      assistantText: "Initial resumed Feishu thread answer",
    });
    const completedThreadReply = [...outboundMessages]
      .reverse()
      .find((message) => {
        return (
          message.kind === "reply" &&
          message.target === threadMessageId &&
          messageContent(message).includes(
            "Initial resumed Feishu thread answer",
          )
        );
      });
    expect(completedThreadReply?.replyInThread).toBeTruthy();

    const threadHelpMessageId = `om_${randomUUID()}`;
    await postEvent(
      callbackUrl,
      directMessage(appId, "/help", "ou_feishu_user", {
        messageId: threadHelpMessageId,
        rootId: rootMessageId,
        threadId: feishuThreadId,
      }),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    const threadHelpReply = [...outboundMessages].reverse().find((message) => {
      return (
        message.kind === "reply" &&
        message.target === threadHelpMessageId &&
        messageContent(message).includes("Okou Feishu commands")
      );
    });
    expect(threadHelpReply?.replyInThread).toBeTruthy();

    await postEvent(
      callbackUrl,
      directMessage(
        appId,
        "continue the Feishu thread session",
        "ou_feishu_user",
        {
          threadId: feishuThreadId,
        },
      ),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    const threadFollowUpRun = await findRun(
      actor,
      "continue the Feishu thread session",
    );
    await runsApi.heartbeatRunner(runnerGroup);
    const threadFollowUpClaim = await runsApi.claimRunnerJob(
      threadFollowUpRun.id,
    );
    expect(threadFollowUpClaim.resumeSession?.sessionId).toBe(threadSessionId);
    await runsApi.requestCancelRun(actor, threadFollowUpRun.id, [200]);
    await flushWaitUntilForTest();

    const client = setupApp({ context, routes: feishuConnectRoutes })(
      connectContract,
    );
    await accept(
      client.removeInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId: fixture.installationId },
      }),
      [200],
    );
  });

  it("shows the run queue link when Feishu reaches the concurrency limit", async () => {
    const fixture = await setupFeishuRunFixture();
    const { actor, appId, callbackUrl } = fixture;
    await connectFixtureUser(fixture);
    const prompts = [
      "first concurrent Feishu task",
      "second concurrent Feishu task",
      "queued Feishu task",
    ] as const;
    const queuedMessageId = `om_${randomUUID()}`;
    for (const [index, prompt] of prompts.entries()) {
      await postEvent(
        callbackUrl,
        directMessage(appId, prompt, "ou_feishu_user", {
          chatId: `oc_feishu_concurrent_${index}`,
          ...(index === 2
            ? {
                messageId: queuedMessageId,
                rootId: `om_${randomUUID()}`,
                threadId: `omt_${randomUUID()}`,
              }
            : {}),
        }),
        {
          encrypted: true,
        },
      );
      await flushWaitUntilForTest();
    }

    const queueNotice = outboundMessages.find((message) => {
      return messageContent(message).includes("Run queued");
    });
    expect(queueNotice).toMatchObject({
      kind: "reply",
      target: queuedMessageId,
      replyInThread: true,
    });
    expect(queueNotice?.msgType).toBe("interactive");
    const queueNoticeContent = queueNotice ? messageContent(queueNotice) : "";
    expect(queueNoticeContent).toContain("Concurrency limit reached");
    expect(queueNoticeContent).toContain("Will start automatically");
    expect(queueNoticeContent).toContain(
      `[View queue](${APP_ORIGIN}/?queue=1)`,
    );

    const runs = await Promise.all(
      prompts.map(async (prompt) => {
        return await findRun(actor, prompt);
      }),
    );
    expect(runs[2]?.status).toBe("queued");
    for (const run of [...runs].reverse()) {
      await runsApi.requestCancelRun(actor, run.id, [200]);
    }
    await flushWaitUntilForTest();
    const client = setupApp({ context, routes: feishuConnectRoutes })(
      connectContract,
    );
    await accept(
      client.removeInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId: fixture.installationId },
      }),
      [200],
    );
  });

  it("terminalizes and delivers a queued Feishu admission failure exactly once", async () => {
    const fixture = await setupFeishuRunFixture();
    const { actor, runnerGroup, appId, callbackUrl, defaultAgentId } = fixture;
    if (!actor.orgId) {
      throw new Error("Expected an org-scoped Feishu actor");
    }
    await connectFixtureUser(fixture);
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [
        {
          organization: { id: actor.orgId },
          role: "org:admin",
        },
      ],
    });

    const firstPrompt = "finish before queued Feishu credit loss";
    const firstMessageId = `om_${randomUUID()}`;
    await postEvent(
      callbackUrl,
      directMessage(appId, firstPrompt, "ou_feishu_user", {
        messageId: firstMessageId,
      }),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    const firstRun = await findRun(actor, firstPrompt);
    await runsApi.heartbeatRunner(runnerGroup);
    const firstClaim = await runsApi.claimRunnerJob(firstRun.id);

    const queuedPrompt = `reject this queued Feishu message after credit loss ${randomUUID()}`;
    const queuedMessageId = `om_${randomUUID()}`;
    const queuedPayload = directMessage(appId, queuedPrompt, "ou_feishu_user", {
      messageId: queuedMessageId,
    });
    await postEvent(callbackUrl, queuedPayload, { encrypted: true });
    await flushWaitUntilForTest();
    const queuedEvent = await findPendingChatEventByPromptFixture({
      userId: fixture.actor.userId,
      prompt: queuedPrompt,
    });
    if (!queuedEvent) {
      throw new Error("Expected the queued Feishu input event");
    }
    expect(
      (await runsApi.listAgentRuns(actor, { limit: 20 })).runs.filter((run) => {
        return run.prompt === queuedPrompt;
      }),
    ).toHaveLength(0);

    await seedOrgMetadata({
      orgId: actor.orgId,
      tier: "pro-suspend",
      credits: 0,
    });
    await upsertOrgPlanEntitlementFixture({
      orgId: actor.orgId,
      status: "suspended",
      canBuyCredits: true,
    });
    outboundMessages = [];
    context.mocks.ably.publish.mockClear();
    context.mocks.ably.publish.mockRejectedValue(
      new Error("Injected queued Feishu admission realtime failure"),
    );
    await completeRunSession({
      runId: firstRun.id,
      sandboxToken: firstClaim.sandboxToken,
      sessionId: `bdd-feishu-admission-${firstRun.id}`,
      history: `bdd Feishu admission history ${firstRun.id}`,
      assistantText: "First Feishu task completed",
    });
    context.mocks.ably.publish.mockResolvedValue(undefined);

    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const threadEvents = await accept(
      setupApp({ context, routes: chatThreadRoutes })(
        chatThreadsContract,
      ).events({
        headers: { authorization: "Bearer clerk-session" },
        query: {},
      }),
      [200],
    );
    const thread = requireValue(
      threadEvents.body.events.find((event) => {
        return event.kind === "created" && event.agentId === defaultAgentId;
      }),
      "Expected the queued Feishu chat thread",
    );
    const messages = await readProjectedChatEvents(context, {
      threadId: thread.chatThreadId,
      headers: { authorization: "Bearer clerk-session" },
    });
    const original = messages.find((event) => {
      return event.id === queuedEvent.eventId;
    });
    if (!original || original.eventType !== "input.prompt") {
      throw new Error("Expected the original queued Feishu prompt");
    }
    expect(original.runId).toBeUndefined();
    expect(original.userMessage.parts).toContainEqual({
      type: "text",
      text: queuedPrompt,
    });
    const replacements = messages.filter((event) => {
      return event.revokesEventId === queuedEvent.eventId;
    });
    expect(replacements).toStrictEqual([
      expect.objectContaining({
        eventType: "input.rejected",
        error: "insufficient_credits",
      }),
    ]);
    const errors = messages.filter((event) => {
      return (
        event.eventType === "output.error" &&
        event.error === "insufficient_credits"
      );
    });
    expect(errors).toHaveLength(1);
    const errorEvent = requireValue(
      errors[0],
      "Expected the queued Feishu output error",
    );
    expect(errorEvent.content).toContain("Add credits");
    const deliveredErrors = outboundMessages.filter((message) => {
      return messageContent(message).includes("Add credits");
    });
    expect(deliveredErrors).toStrictEqual([
      expect.objectContaining({
        kind: "reply",
        target: queuedMessageId,
        replyInThread: true,
        idempotencyKey: errorEvent.id,
      }),
    ]);
    expect(
      removedReactions.filter((messageId) => {
        return messageId === queuedMessageId;
      }),
    ).toHaveLength(1);
    expect(
      (await runsApi.listAgentRuns(actor, { limit: 20 })).runs.filter((run) => {
        return run.prompt === queuedPrompt;
      }),
    ).toHaveLength(0);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadMessageCreated:${thread.chatThreadId}`,
      null,
    );
    await postEvent(callbackUrl, queuedPayload, { encrypted: true });
    await flushWaitUntilForTest();
    expect(
      outboundMessages.filter((message) => {
        return messageContent(message).includes("Add credits");
      }),
    ).toHaveLength(1);
    const afterReplay = await readProjectedChatEvents(context, {
      threadId: thread.chatThreadId,
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(
      afterReplay.filter((event) => {
        return event.revokesEventId === queuedEvent.eventId;
      }),
    ).toHaveLength(1);
    expect(
      afterReplay.filter((event) => {
        return (
          event.eventType === "output.error" &&
          event.error === "insufficient_credits"
        );
      }),
    ).toHaveLength(1);
  });

  it("persists a queued Feishu admission failure when delivery fails", async () => {
    const fixture = await setupFeishuRunFixture();
    const { actor, runnerGroup, appId, callbackUrl, defaultAgentId } = fixture;
    if (!actor.orgId) {
      throw new Error("Expected an org-scoped Feishu actor");
    }
    await connectFixtureUser(fixture);
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [
        {
          organization: { id: actor.orgId },
          role: "org:admin",
        },
      ],
    });
    const failedDeliveryAnchorPrompt =
      "finish before queued Feishu delivery failure";
    await postEvent(
      callbackUrl,
      directMessage(appId, failedDeliveryAnchorPrompt, "ou_feishu_user", {
        messageId: `om_${randomUUID()}`,
      }),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    const failedDeliveryAnchor = await findRun(
      actor,
      failedDeliveryAnchorPrompt,
    );
    await runsApi.heartbeatRunner(runnerGroup);
    const failedDeliveryAnchorClaim = await runsApi.claimRunnerJob(
      failedDeliveryAnchor.id,
    );

    const failedDeliveryPrompt = `persist this queued Feishu failure before delivery fails ${randomUUID()}`;
    const failedDeliveryMessageId = `om_${randomUUID()}`;
    await postEvent(
      callbackUrl,
      directMessage(appId, failedDeliveryPrompt, "ou_feishu_user", {
        messageId: failedDeliveryMessageId,
      }),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    const failedDeliveryEvent = await findPendingChatEventByPromptFixture({
      userId: fixture.actor.userId,
      prompt: failedDeliveryPrompt,
    });
    if (!failedDeliveryEvent) {
      throw new Error("Expected the failed-delivery Feishu input event");
    }
    await seedOrgMetadata({
      orgId: actor.orgId,
      tier: "pro-suspend",
      credits: 0,
    });
    await upsertOrgPlanEntitlementFixture({
      orgId: actor.orgId,
      status: "suspended",
      canBuyCredits: true,
    });
    outboundMessages = [];
    failedSendContentFragments.push("Add credits");
    await completeRunSession({
      runId: failedDeliveryAnchor.id,
      sandboxToken: failedDeliveryAnchorClaim.sandboxToken,
      sessionId: `bdd-feishu-delivery-failure-${failedDeliveryAnchor.id}`,
      history: `bdd Feishu delivery failure history ${failedDeliveryAnchor.id}`,
      assistantText: "Second Feishu task completed",
    });

    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const threadEvents = await accept(
      setupApp({ context, routes: chatThreadRoutes })(
        chatThreadsContract,
      ).events({
        headers: { authorization: "Bearer clerk-session" },
        query: {},
      }),
      [200],
    );
    const thread = requireValue(
      threadEvents.body.events.find((event) => {
        return event.kind === "created" && event.agentId === defaultAgentId;
      }),
      "Expected the failed-delivery Feishu chat thread",
    );
    const afterDeliveryFailure = await readProjectedChatEvents(context, {
      threadId: thread.chatThreadId,
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(
      afterDeliveryFailure.filter((event) => {
        return (
          event.eventType === "input.rejected" &&
          event.revokesEventId === failedDeliveryEvent.eventId &&
          event.error === "insufficient_credits"
        );
      }),
    ).toHaveLength(1);
    expect(
      afterDeliveryFailure.filter((event) => {
        return (
          event.eventType === "output.error" &&
          event.error === "insufficient_credits"
        );
      }),
    ).toHaveLength(1);
    expect(
      (await runsApi.listAgentRuns(actor, { limit: 20 })).runs.filter((run) => {
        return run.prompt === failedDeliveryPrompt;
      }),
    ).toHaveLength(0);
    expect(
      removedReactions.filter((messageId) => {
        return messageId === failedDeliveryMessageId;
      }),
    ).toHaveLength(1);
    expect(failedSendContentFragments).toHaveLength(0);
  });

  it("keeps Feishu group control cases out of runs and resumes queued tasks through the canonical session", async () => {
    const fixture = await setupFeishuRunFixture();
    const { actor, runnerGroup, appId, callbackUrl, defaultAgentId } = fixture;
    const secondOpenId = "ou_feishu_canonical_group_user";
    const secondActor = authOrgApi.user({
      userId: `user_${randomUUID()}`,
      orgId: actor.orgId,
      orgRole: "org:member",
    });
    await enableFeishuIntegration(platform, secondActor, {
      [FeatureSwitchKey.OkouDebug]: true,
    });

    await postEvent(
      callbackUrl,
      groupMessage(appId, "unconnected group task", {
        openId: secondOpenId,
      }),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    expect(
      outboundMessages.some((message) => {
        return (
          message.kind === "reply" &&
          messageContent(message).includes("Connect your account")
        );
      }),
    ).toBeTruthy();
    expect(
      (await runsApi.listAgentRuns(secondActor, { limit: 20 })).runs.some(
        (run) => {
          return run.prompt === "@Nova unconnected group task";
        },
      ),
    ).toBeFalsy();
    await connectFixtureUser(fixture, secondActor, secondOpenId);
    await postEvent(
      callbackUrl,
      groupMessage(appId, "/help", { openId: secondOpenId }),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    expect(
      outboundMessages.some((message) => {
        return messageContent(message).includes("Okou Feishu commands");
      }),
    ).toBeTruthy();

    // Retain access-denial coverage for historical private defaults; current
    // agent APIs reject this state, so it requires an explicit legacy fixture.
    await seedLegacyPrivateDefaultAgentFixture(defaultAgentId);
    await postEvent(
      callbackUrl,
      groupMessage(appId, "unavailable group task", {
        openId: secondOpenId,
      }),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    expect(
      outboundMessages.some((message) => {
        return messageContent(message).includes("Agent unavailable");
      }),
    ).toBeTruthy();
    const controlRuns = await runsApi.listAgentRuns(secondActor, { limit: 20 });
    expect(
      controlRuns.runs.some((run) => {
        return [
          "@Nova unconnected group task",
          "@Nova /help",
          "@Nova unavailable group task",
        ].includes(run.prompt);
      }),
    ).toBeFalsy();

    await authOrgApi.updateAgentMetadata(actor, defaultAgentId, {
      visibility: "public",
    });
    outboundMessages = [];
    const firstMessageId = `om_${randomUUID()}`;
    const firstPrompt = "first canonical group task";
    const secondPrompt = "second queued canonical group task";
    await postEvent(
      callbackUrl,
      groupMessage(appId, firstPrompt, {
        messageId: firstMessageId,
        openId: secondOpenId,
      }),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    const firstRun = await findRun(secondActor, `@Nova ${firstPrompt}`);

    await postEvent(
      callbackUrl,
      groupMessage(appId, secondPrompt, {
        rootId: firstMessageId,
        threadId: `omt_${randomUUID()}`,
        openId: secondOpenId,
      }),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    expect(
      (await runsApi.listAgentRuns(secondActor, { limit: 20 })).runs.some(
        (run) => {
          return run.prompt === `@Nova ${secondPrompt}`;
        },
      ),
    ).toBeFalsy();
    const queuedFeishuParams = await findPendingChatEventByPromptFixture({
      userId: secondActor.userId,
      prompt: `@Nova ${secondPrompt}`,
    });
    expect(queuedFeishuParams).toMatchObject({
      eventId: expect.any(String),
    });
    if (!queuedFeishuParams) {
      throw new Error("Expected queued canonical Feishu event");
    }
    await runsApi.heartbeatRunner(runnerGroup);
    const firstClaim = await runsApi.claimRunnerJob(firstRun.id);
    const firstCliSessionId = `bdd-feishu-canonical-group-${firstRun.id}`;
    await completeRunSession({
      runId: firstRun.id,
      sandboxToken: firstClaim.sandboxToken,
      sessionId: firstCliSessionId,
      history: `bdd feishu canonical group history ${firstRun.id}`,
      assistantText: "First canonical group answer",
    });

    const secondRun = await findRun(secondActor, `@Nova ${secondPrompt}`);
    await runsApi.heartbeatRunner(runnerGroup);
    const secondClaim = await runsApi.claimRunnerJob(secondRun.id);
    expect(secondClaim.prompt).toBe(`@Nova ${secondPrompt}`);
    expect(secondClaim.appendSystemPrompt).toContain("Scope: Group mention");
    expect(secondClaim.resumeSession?.sessionId).toBe(firstCliSessionId);
    await runsApi.requestCancelRun(secondActor, secondRun.id, [200]);
    await flushWaitUntilForTest();

    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const client = setupApp({ context, routes: feishuConnectRoutes })(
      connectContract,
    );
    await accept(
      client.removeInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId: fixture.installationId },
      }),
      [200],
    );
  });

  it("ignores unmentioned group messages, app messages and system notifications", async () => {
    const fixture = await setupFeishuRunFixture();
    const { actor, appId, callbackUrl } = fixture;
    await connectFixtureUser(fixture);
    await postEvent(
      callbackUrl,
      groupMessage(appId, "ignore this group message", {
        mentionBot: false,
      }),
      { encrypted: true },
    );
    await postEvent(
      callbackUrl,
      groupMessage(appId, "ignore a mention for another bot", {
        mentionOpenId: "ou_another_bot",
      }),
      { encrypted: true },
    );
    await postEvent(
      callbackUrl,
      groupMessage(appId, "ignore an app-authored message", {
        senderType: "app",
      }),
      { encrypted: true },
    );
    await postEvent(
      callbackUrl,
      v2Event(appId, "im.message.receive_v1", {
        sender: {
          sender_id: { open_id: "ou_feishu_user" },
          sender_type: "user",
        },
        message: {
          message_id: `om_${randomUUID()}`,
          chat_id: "oc_feishu_dm",
          chat_type: "p2p",
          message_type: "system",
          content: JSON.stringify({
            template: "ignore the system notification from {from_user}",
            from_user: ["Ada"],
          }),
        },
      }),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    const afterUnmentioned = await runsApi.listAgentRuns(actor, { limit: 20 });
    expect(
      afterUnmentioned.runs.some((candidate) => {
        return candidate.prompt.includes("ignore ");
      }),
    ).toBeFalsy();

    await removeFeishuInstallation(fixture);
  });

  it("runs mention-only group requests with thread history and dedupe", async () => {
    const fixture = await setupFeishuRunFixture();
    const { actor, runnerGroup, appId, callbackUrl } = fixture;
    await connectFixtureUser(fixture);
    const groupMessageId = `om_${randomUUID()}`;
    const groupRootId = `om_${randomUUID()}`;
    const groupThreadId = `omt_${randomUUID()}`;
    const rootMessage = {
      message_id: groupRootId,
      thread_id: groupThreadId,
      msg_type: "text",
      create_time: "1",
      body: { content: JSON.stringify({ text: "Thread root question" }) },
    };
    historyMessages = [
      {
        message_id: "om_group_recent",
        msg_type: "text",
        create_time: "2",
        sender: {
          id: "ou_recent_user",
          sender_name: "Recent User",
          sender_type: "user",
        },
        body: {
          content: JSON.stringify({ text: "Recent group context" }),
        },
      },
      rootMessage,
    ];
    threadHistoryMessages.set(groupThreadId, [
      {
        message_id: groupMessageId,
        msg_type: "text",
        create_time: "5",
        body: { content: JSON.stringify({ text: "Current message copy" }) },
      },
      {
        message_id: "om_group_file",
        msg_type: "file",
        create_time: "4",
        body: {
          content: JSON.stringify({
            file_key: "file_topic_context",
            file_name: "topic-context.pdf",
          }),
        },
      },
      {
        message_id: "om_group_thread",
        root_id: groupRootId,
        thread_id: groupThreadId,
        msg_type: "text",
        create_time: "3",
        sender: {
          id: "ou_thread_user",
          sender_name: "Thread User",
          sender_type: "user",
        },
        body: {
          content: JSON.stringify({
            text: "Check https://example.com/broken-article",
          }),
        },
      },
      {
        message_id: "om_deleted_reply",
        msg_type: "text",
        create_time: "2",
        deleted: true,
        body: { content: JSON.stringify({ text: "Deleted thread reply" }) },
      },
      rootMessage,
    ]);
    const mentioned = groupMessage(appId, "", {
      messageId: groupMessageId,
      rootId: groupRootId,
      threadId: groupThreadId,
    });
    await postEvent(callbackUrl, mentioned, { encrypted: true });
    await postEvent(callbackUrl, mentioned, { encrypted: true });
    await flushWaitUntilForTest();
    const groupRuns = await runsApi.listAgentRuns(actor, { limit: 20 });
    const matchingGroupRuns = groupRuns.runs.filter((candidate) => {
      return candidate.prompt === "@Nova";
    });
    expect(matchingGroupRuns).toHaveLength(1);
    const groupRun = requireValue(
      matchingGroupRuns[0],
      "Expected a group mention to create an agent run",
    );
    await runsApi.heartbeatRunner(runnerGroup);
    const groupClaim = await runsApi.claimRunnerJob(groupRun.id);
    const history = requireValue(
      groupClaim.appendSystemPrompt,
      "Expected group and thread history",
    );
    expect(groupClaim.prompt).toBe("@Nova");
    expect(groupClaim.appendSystemPrompt).toContain("Scope: Group mention");
    expect(groupClaim.appendSystemPrompt).toContain(
      `Tenant key: ${TENANT_KEY}`,
    );
    expect(groupClaim.appendSystemPrompt).toContain("Chat ID: oc_feishu_group");
    expect(groupClaim.appendSystemPrompt).toContain(
      `Group ID: oc_feishu_group (same as Chat ID; use it directly as the \`--chat\` value for \`okou ${platform} message send\`)`,
    );
    expect(groupClaim.appendSystemPrompt).toContain(
      "# Recent Channel Messages",
    );
    expect(groupClaim.appendSystemPrompt).toContain(
      `# ${provider.name} Thread Context`,
    );
    expect(groupClaim.appendSystemPrompt).toContain(
      "- SENDER: {id: ou_recent_user, name: Recent User}",
    );
    expect(groupClaim.appendSystemPrompt).toContain(
      "- SENDER: {id: ou_thread_user, name: Thread User}",
    );
    expect(groupClaim.appendSystemPrompt).toContain("Recent group context");
    expect(groupClaim.appendSystemPrompt).toContain(
      "https://example.com/broken-article",
    );
    expect(groupClaim.appendSystemPrompt).toContain(
      `Thread ID: ${groupThreadId}`,
    );
    expect(history.match(/Thread root question/gu)).toHaveLength(1);
    expect(history).not.toContain("Current message copy");
    expect(history).not.toContain("Deleted thread reply");
    const threadContext = requireValue(
      history.split(`# ${provider.name} Thread Context`)[1],
      "Expected topic replies in thread context",
    );
    expect(threadContext).toContain("Thread root question");
    expect(threadContext).toContain("https://example.com/broken-article");
    expect(threadContext).toContain("topic-context.pdf");
    expect(threadContext.indexOf("Thread root question")).toBeLessThan(
      threadContext.indexOf("https://example.com/broken-article"),
    );
    expect(
      threadContext.indexOf("https://example.com/broken-article"),
    ).toBeLessThan(threadContext.indexOf("topic-context.pdf"));
    await expectFeishuResourceDownloads({
      actor,
      runId: groupRun.id,
      prompt: history,
      resources: [
        {
          messageId: "om_group_file",
          fileKey: "file_topic_context",
          type: "file",
        },
      ],
    });
    const groupCliSessionId = `bdd-feishu-group-cli-${groupRun.id}`;
    await completeRunSession({
      runId: groupRun.id,
      sandboxToken: groupClaim.sandboxToken,
      sessionId: groupCliSessionId,
      history: `bdd feishu group history ${groupRun.id}`,
      assistantText: "Canonical Feishu group answer",
    });
    const groupReply = [...outboundMessages].reverse().find((message) => {
      return message.kind === "reply" && message.target === groupMessageId;
    });
    expect(groupReply?.replyInThread).toBeTruthy();
    expect(groupReply ? messageContent(groupReply) : "").not.toContain(
      "Reply to",
    );

    await removeFeishuInstallation(fixture);
  });

  it.each(["chat", "thread"] as const)(
    "keeps available conversation context when %s history fails",
    async (failedContainer) => {
      const fixture = await setupFeishuRunFixture();
      const { actor, runnerGroup, appId, callbackUrl } = fixture;
      await connectFixtureUser(fixture);
      const groupRootId = `om_${randomUUID()}`;
      const groupThreadId = `omt_${randomUUID()}`;
      server.use(
        http.get(
          `${provider.apiOrigin}/open-apis/im/v1/messages`,
          ({ request }) => {
            const query = new URL(request.url).searchParams;
            const containerType = query.get("container_id_type");
            if (containerType === failedContainer) {
              return HttpResponse.json(
                { code: 99_999, msg: "history unavailable" },
                { status: 500 },
              );
            }
            const containerId = query.get("container_id");
            if (
              (containerType === "chat" && containerId !== "oc_feishu_group") ||
              (containerType === "thread" && containerId !== groupThreadId)
            ) {
              return HttpResponse.json({
                code: 23_000,
                msg: "invalid container",
              });
            }
            return HttpResponse.json({
              code: 0,
              data: {
                items: [
                  {
                    message_id:
                      containerType === "chat" ? "om_recent_chat" : groupRootId,
                    msg_type: "text",
                    create_time: "1",
                    body: {
                      content: JSON.stringify({
                        text:
                          containerType === "chat"
                            ? "Recent chat survived"
                            : "Thread history survived",
                      }),
                    },
                  },
                ],
                has_more: false,
              },
            });
          },
        ),
      );
      await postEvent(
        callbackUrl,
        groupMessage(appId, "continue this topic", {
          rootId: groupRootId,
          threadId: groupThreadId,
        }),
        { encrypted: true },
      );
      await flushWaitUntilForTest();
      const run = await findRun(actor, "@Nova continue this topic");
      await runsApi.heartbeatRunner(runnerGroup);
      const claim = await runsApi.claimRunnerJob(run.id);
      expect(claim.appendSystemPrompt).toContain(
        failedContainer === "chat"
          ? "Thread history survived"
          : "Recent chat survived",
      );
      expect(claim.appendSystemPrompt).not.toContain(
        failedContainer === "chat"
          ? "Recent chat survived"
          : "Thread history survived",
      );
      await runsApi.requestCancelRun(actor, run.id, [200]);
      await flushWaitUntilForTest();
      await removeFeishuInstallation(fixture);
    },
  );

  it("attributes mentioned group replies to the triggering user", async () => {
    const fixture = await setupFeishuRunFixture();
    const { actor, runnerGroup, appId, callbackUrl } = fixture;
    await connectFixtureUser(fixture);
    const groupMessageId = `om_${randomUUID()}`;
    const groupThreadId = `omt_${randomUUID()}`;
    await postEvent(
      callbackUrl,
      groupMessage(appId, "establish group reply attribution", {
        messageId: groupMessageId,
      }),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    const initialGroupRun = await findRun(
      actor,
      "@Nova establish group reply attribution",
    );
    await runsApi.heartbeatRunner(runnerGroup);
    await runsApi.claimRunnerJob(initialGroupRun.id);
    await runsApi.requestCancelRun(actor, initialGroupRun.id, [200]);
    await flushWaitUntilForTest();

    const secondOpenId = "ou_feishu_second_user";
    const secondActor = authOrgApi.user({
      userId: `user_${randomUUID()}`,
      orgId: fixture.actor.orgId,
      orgRole: "org:member",
    });
    await enableFeishuIntegration(platform, secondActor, {
      [FeatureSwitchKey.OkouDebug]: true,
    });
    await connectFixtureUser(fixture, secondActor, secondOpenId);
    await postEvent(
      callbackUrl,
      groupMessage(appId, "handle this group task as another user", {
        rootId: groupMessageId,
        threadId: groupThreadId,
        openId: secondOpenId,
      }),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    const secondGroupRun = await findRun(
      secondActor,
      "@Nova handle this group task as another user",
    );
    await runsApi.heartbeatRunner(runnerGroup);
    const secondGroupClaim = await runsApi.claimRunnerJob(secondGroupRun.id);
    await completeRunSession({
      runId: secondGroupRun.id,
      sandboxToken: secondGroupClaim.sandboxToken,
      sessionId: `bdd-feishu-second-group-cli-${secondGroupRun.id}`,
      history: `bdd feishu second group history ${secondGroupRun.id}`,
      assistantText: "Canonical Feishu second group answer",
    });
    const secondGroupReply = [...outboundMessages].reverse().find((message) => {
      return (
        message.kind === "reply" &&
        messageContent(message).includes("Canonical Feishu second group answer")
      );
    });
    expect(secondGroupReply ? messageContent(secondGroupReply) : "").toContain(
      `Reply to <at id=${secondOpenId}></at>`,
    );

    await removeFeishuInstallation(fixture);
  });

  it("resumes mentioned group tasks in the same thread session", async () => {
    const fixture = await setupFeishuRunFixture();
    const { actor, runnerGroup, appId, callbackUrl } = fixture;
    await connectFixtureUser(fixture);
    const groupMessageId = `om_${randomUUID()}`;
    const groupThreadId = `omt_${randomUUID()}`;
    await postEvent(
      callbackUrl,
      groupMessage(appId, "handle this group task", {
        messageId: groupMessageId,
      }),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    const groupRun = await findRun(actor, "@Nova handle this group task");
    await runsApi.heartbeatRunner(runnerGroup);
    const groupClaim = await runsApi.claimRunnerJob(groupRun.id);
    const groupCliSessionId = `bdd-feishu-group-cli-${groupRun.id}`;
    await completeRunSession({
      runId: groupRun.id,
      sandboxToken: groupClaim.sandboxToken,
      sessionId: groupCliSessionId,
      history: `bdd feishu group history ${groupRun.id}`,
    });
    await postEvent(
      callbackUrl,
      groupMessage(appId, "continue this group task", {
        rootId: groupMessageId,
        threadId: groupThreadId,
      }),
      { encrypted: true },
    );
    await flushWaitUntilForTest();
    const groupFollowUp = await findRun(
      actor,
      "@Nova continue this group task",
    );
    await runsApi.heartbeatRunner(runnerGroup);
    const groupFollowUpClaim = await runsApi.claimRunnerJob(groupFollowUp.id);
    expect(groupFollowUpClaim.resumeSession?.sessionId).toBe(groupCliSessionId);
    await runsApi.requestCancelRun(actor, groupFollowUp.id, [200]);
    await flushWaitUntilForTest();

    await removeFeishuInstallation(fixture);
  });
});
