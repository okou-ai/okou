import {
  createCipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";

import { connectedConnectorsContract } from "@okouai/api-contracts/contracts/connected-connectors";
import {
  customConnectorByIdContract,
  customConnectorOAuth2Contract,
  customConnectorProposalContract,
  customConnectorsContract,
  customConnectorValuesContract,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { feishuBrowserConnectContract } from "@okouai/api-contracts/contracts/feishu-browser-connect";
import {
  FEISHU_OAUTH_SCOPES,
  feishuConnectContract,
  larkConnectContract,
} from "@okouai/api-contracts/contracts/feishu-connect";
import {
  feishuOauthCallbackQuerySchema,
  feishuOauthContract,
} from "@okouai/api-contracts/contracts/feishu-oauth";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { boolean, object, string } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { connectedConnectorsRoutes } from "../connected-connectors";
import { customConnectorsRoutes } from "../custom-connectors";
import { feishuBrowserConnectRoutes } from "../feishu-browser-connect";
import { feishuConnectRoutes } from "../feishu-connect";
import { feishuEventsRoutes } from "../feishu-events";
import { feishuOauthRoutes } from "../feishu-oauth";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

const FEISHU_API = "https://open.feishu.cn";

type Platform = "feishu" | "lark";

const PLATFORMS = {
  feishu: {
    apiOrigin: FEISHU_API,
    accountsOrigin: "https://accounts.feishu.cn",
    appLinkOrigin: "https://applink.feishu.cn",
    callbackPath: "/connectors/feishu/callback",
    contract: feishuConnectContract,
    featureSwitch: FeatureSwitchKey.FeishuIntegration,
  },
  lark: {
    apiOrigin: "https://open.larksuite.com",
    accountsOrigin: "https://accounts.larksuite.com",
    appLinkOrigin: "https://applink.larksuite.com",
    callbackPath: "/integrations/lark/callback",
    contract: larkConnectContract,
    featureSwitch: FeatureSwitchKey.LarkIntegration,
  },
} as const;

interface Actor {
  readonly userId: string;
  readonly orgId: string;
  readonly role?: "org:admin" | "org:member";
}

function signIn(actor: Actor): { authorization: string } {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.role,
  );
  return { authorization: "Bearer clerk-session" };
}

function encryptFor(encryptKey: string, payload: unknown): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv(
    "aes-256-cbc",
    createHash("sha256").update(encryptKey).digest(),
    iv,
  );
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return JSON.stringify({
    encrypt: Buffer.concat([iv, encrypted]).toString("base64"),
  });
}

interface SignedDelivery {
  readonly timestamp?: number;
  readonly signature?: string;
}

async function deliver(
  callbackUrl: string,
  body: string,
  encryptKey: string,
  delivery: SignedDelivery = {},
) {
  const timestamp = String(delivery.timestamp ?? Math.floor(now() / 1000));
  const nonce = randomUUID();
  const signature =
    delivery.signature ??
    createHash("sha256")
      .update(`${timestamp}${nonce}${encryptKey}${body}`)
      .digest("hex");
  const request = setupRawAppRequest({ context, routes: feishuEventsRoutes });
  return await request(callbackUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-lark-request-timestamp": timestamp,
      "x-lark-request-nonce": nonce,
      "x-lark-signature": signature,
    },
    body,
  });
}

async function postUnsigned(callbackUrl: string, body: string) {
  const request = setupRawAppRequest({ context, routes: feishuEventsRoutes });
  return await request(callbackUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

interface InstalledBot {
  readonly admin: Actor;
  readonly appId: string;
  readonly installationId: string;
  readonly callbackUrl: string;
  readonly verificationToken: string;
  readonly encryptKey: string;
  readonly botOpenId: string;
}

async function installFeishuBot(
  platform: Platform = "feishu",
): Promise<InstalledBot> {
  const apiOrigin = PLATFORMS[platform].apiOrigin;
  const admin = {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
  };
  const appId = `cli_${randomUUID()}`;
  const botOpenId = `ou_bot_${randomUUID()}`;
  const verificationToken = `token-${randomUUID()}`;
  const encryptKey = `encrypt-${randomUUID()}`;
  server.use(
    http.post(
      `${apiOrigin}/open-apis/auth/v3/tenant_access_token/internal`,
      () => {
        return HttpResponse.json({
          code: 0,
          tenant_access_token: `tenant-${randomUUID()}`,
          expire: 7200,
        });
      },
    ),
    http.get(`${apiOrigin}/open-apis/bot/v3/info`, () => {
      return HttpResponse.json({
        code: 0,
        bot: { open_id: botOpenId, app_name: "Okou Feishu" },
      });
    }),
  );
  context.mocks.s3.send.mockResolvedValue({ ETag: "fixture-etag" });
  await updateFeatureSwitchesForUser(context, admin, {
    [PLATFORMS[platform].featureSwitch]: true,
  });
  const configured = await accept(
    feishuClient(platform).setup({
      headers: signIn(admin),
      body: {
        appId,
        appSecret: "app-secret",
        verificationToken,
        encryptKey,
      },
    }),
    [200],
  );
  const { installationId, callbackUrl } = configured.body;
  if (!installationId || !callbackUrl) {
    throw new Error("Expected a configured Feishu installation");
  }
  return {
    admin,
    appId,
    installationId,
    callbackUrl,
    verificationToken,
    encryptKey,
    botOpenId,
  };
}

function feishuClient(platform: Platform = "feishu") {
  return setupApp({ context, routes: feishuConnectRoutes })(
    PLATFORMS[platform].contract,
  );
}

async function completeSetup(
  bot: InstalledBot,
  platform: Platform = "feishu",
): Promise<void> {
  await accept(
    feishuClient(platform).updateInstallation({
      headers: signIn(bot.admin),
      params: { installationId: bot.installationId },
      body: { setupCompleted: true },
    }),
    [200],
  );
}

async function readStatus(admin: Actor) {
  const status = await accept(
    feishuClient().getStatus({ headers: signIn(admin) }),
    [200],
  );
  return status.body;
}

const ORIGINS = {
  app: "https://app.okou-origin.test",
  api: "https://api.okou-origin.test",
  web: "https://www.okou-origin.test",
} as const;

function useSeparateOrigins(): void {
  mockEnv("APP_URL", ORIGINS.app);
  mockEnv("OKOU_API_BACKEND_URL", ORIGINS.api);
  mockEnv("OKOU_WEB_URL", ORIGINS.web);
}

function oauthClient() {
  return setupApp({ context, routes: feishuOauthRoutes })(feishuOauthContract);
}

async function startAuthorization(connectUrl: string): Promise<URL> {
  const started = await accept(
    oauthClient().connect({
      query: { state: new URL(connectUrl).searchParams.get("state") ?? "" },
    }),
    [307],
  );
  return new URL(started.headers.get("location") ?? "");
}

type CallbackQuery = ReturnType<typeof feishuOauthCallbackQuerySchema.parse>;

async function completeAuthorization(query: CallbackQuery) {
  return await accept(oauthClient().callback({ query }), [200, 307]);
}

interface TokenExchange {
  readonly redirectUri: unknown;
}

function acceptFeishuAuthorization(
  platform: Platform,
  openId: string,
  tenantKey = "tenant_member",
): TokenExchange[] {
  const apiOrigin = PLATFORMS[platform].apiOrigin;
  const exchanges: TokenExchange[] = [];
  server.use(
    http.post(
      `${apiOrigin}/open-apis/authen/v2/oauth/token`,
      async ({ request }) => {
        const body = object({ redirect_uri: string() }).parse(
          await request.json(),
        );
        exchanges.push({ redirectUri: body.redirect_uri });
        return HttpResponse.json({
          code: 0,
          access_token: `u-${randomUUID()}`,
          refresh_token: `r-${randomUUID()}`,
          expires_in: 7200,
        });
      },
    ),
    http.get(`${apiOrigin}/open-apis/authen/v1/user_info`, () => {
      return HttpResponse.json({
        code: 0,
        data: { open_id: openId, name: "Feishu Member", tenant_key: tenantKey },
      });
    }),
    http.post(`${apiOrigin}/open-apis/im/v1/messages`, () => {
      return HttpResponse.json({
        code: 0,
        data: { message_id: `om_${randomUUID()}`, chat_id: "oc_welcome" },
      });
    }),
  );
  return exchanges;
}

interface ProviderMessage {
  readonly content: string;
}

function captureBotMessages(platform: Platform): ProviderMessage[] {
  const apiOrigin = PLATFORMS[platform].apiOrigin;
  const messages: ProviderMessage[] = [];
  const record = async (request: Request) => {
    const body = object({ content: string() }).parse(await request.json());
    messages.push({ content: body.content });
    return HttpResponse.json({
      code: 0,
      data: { message_id: `om_${randomUUID()}`, chat_id: "oc_dm" },
    });
  };
  server.use(
    http.post(`${apiOrigin}/open-apis/im/v1/messages`, ({ request }) => {
      return record(request);
    }),
    http.post(
      `${apiOrigin}/open-apis/im/v1/messages/:messageId/reply`,
      ({ request }) => {
        return record(request);
      },
    ),
  );
  return messages;
}

function sendDirectMessage(
  bot: InstalledBot,
  sender: { readonly openId: string; readonly tenantKey: string },
) {
  return deliver(
    bot.callbackUrl,
    encryptFor(bot.encryptKey, {
      schema: "2.0",
      header: {
        event_id: randomUUID(),
        event_type: "im.message.receive_v1",
        tenant_key: sender.tenantKey,
        app_id: bot.appId,
        token: bot.verificationToken,
      },
      event: {
        sender: {
          sender_id: { open_id: sender.openId },
          sender_type: "user",
        },
        message: {
          message_id: `om_${randomUUID()}`,
          chat_id: `oc_dm_${randomUUID()}`,
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "hello" }),
        },
      },
    }),
    bot.encryptKey,
  );
}

function connectLinkIn(messages: readonly ProviderMessage[]): URL {
  const escapedOrigin = ORIGINS.app.replaceAll(".", String.raw`\.`);
  for (const message of messages) {
    const match = new RegExp(`${escapedOrigin}[^"\\s)]*`).exec(
      message.content.replaceAll(String.raw`\u0026`, "&"),
    );
    if (match) {
      return new URL(match[0]);
    }
  }
  throw new Error("Expected a connection link from the bot");
}

function browserConnectClient() {
  return setupApp({ context, routes: feishuBrowserConnectRoutes })(
    feishuBrowserConnectContract,
  );
}

async function connectFromMessageLink(platform: Platform) {
  useSeparateOrigins();
  const bot = await installFeishuBot(platform);
  await completeSetup(bot, platform);
  const sender = {
    openId: `ou_${randomUUID()}`,
    tenantKey: `tenant_${randomUUID()}`,
  };
  const messages = captureBotMessages(platform);
  const exchanges = acceptFeishuAuthorization(
    platform,
    sender.openId,
    sender.tenantKey,
  );

  const delivered = await sendDirectMessage(bot, sender);
  expect(delivered.status).toBe(200);
  await flushWaitUntilForTest();
  const link = connectLinkIn(messages);

  const connected = await accept(
    browserConnectClient().connectFromApp({
      headers: signIn(bot.admin),
      body: {
        installationId: link.searchParams.get("installationId") ?? "",
        openId: link.searchParams.get("openId") ?? "",
        chatId: link.searchParams.get("chatId") ?? "",
        ts: Number(link.searchParams.get("ts")),
        sig: link.searchParams.get("sig") ?? "",
      },
    }),
    [200],
  );
  const authorize = new URL(connected.body.openUrl);
  const state = authorize.searchParams.get("state") ?? "";

  const completed = await completeAuthorization({
    state,
    code: "authorization-code",
    responseMode: "json",
  });
  if (completed.status !== 200) {
    throw new Error("Expected a JSON completion redirect");
  }
  return {
    linkOrigin: link.origin,
    authorizeOrigin: authorize.origin,
    authorizeRedirectUri: authorize.searchParams.get("redirect_uri"),
    hexState: /^[0-9a-f]{64}$/.test(state),
    completionOrigin: new URL(completed.body.redirectUrl).origin,
    exchanges,
  };
}

function customConnectorsClient() {
  return setupApp({ context, routes: customConnectorsRoutes })(
    customConnectorsContract,
  );
}

function customConnectorByIdClient() {
  return setupApp({ context, routes: customConnectorsRoutes })(
    customConnectorByIdContract,
  );
}

function customConnectorValuesClient() {
  return setupApp({ context, routes: customConnectorsRoutes })(
    customConnectorValuesContract,
  );
}

function customConnectorOAuth2Client() {
  return setupApp({ context, routes: customConnectorsRoutes })(
    customConnectorOAuth2Contract,
  );
}

function customConnectorProposalClient() {
  return setupApp({ context, routes: customConnectorsRoutes })(
    customConnectorProposalContract,
  );
}

function connectedConnectorsClient() {
  return setupApp({ context, routes: connectedConnectorsRoutes })(
    connectedConnectorsContract,
  );
}

interface WelcomeDelivery {
  readonly receiveIdType: string | null;
  readonly receiveId: string;
  readonly msgType: string;
}

function acceptFeishuAuthorizationWithWelcome(
  platform: Platform,
  openId: string,
  tenantKey = "tenant_member",
): {
  readonly exchanges: TokenExchange[];
  readonly welcomes: WelcomeDelivery[];
} {
  const apiOrigin = PLATFORMS[platform].apiOrigin;
  const exchanges: TokenExchange[] = [];
  const welcomes: WelcomeDelivery[] = [];
  server.use(
    http.post(
      `${apiOrigin}/open-apis/authen/v2/oauth/token`,
      async ({ request }) => {
        const body = object({ redirect_uri: string() }).parse(
          await request.json(),
        );
        exchanges.push({ redirectUri: body.redirect_uri });
        return HttpResponse.json({
          code: 0,
          access_token: `u-${randomUUID()}`,
          refresh_token: `r-${randomUUID()}`,
          expires_in: 7200,
        });
      },
    ),
    http.get(`${apiOrigin}/open-apis/authen/v1/user_info`, () => {
      return HttpResponse.json({
        code: 0,
        data: { open_id: openId, name: "Feishu Member", tenant_key: tenantKey },
      });
    }),
    http.post(`${apiOrigin}/open-apis/im/v1/messages`, async ({ request }) => {
      const body = object({
        receive_id: string(),
        msg_type: string(),
      }).parse(await request.json());
      welcomes.push({
        receiveIdType: new URL(request.url).searchParams.get("receive_id_type"),
        receiveId: body.receive_id,
        msgType: body.msg_type,
      });
      return HttpResponse.json({
        code: 0,
        data: { message_id: `om_${randomUUID()}`, chat_id: "oc_welcome" },
      });
    }),
  );
  return { exchanges, welcomes };
}

async function installBotWithMember(platform: Platform) {
  useSeparateOrigins();
  const bot = await installFeishuBot(platform);
  await completeSetup(bot, platform);
  const member: Actor = {
    userId: `user_${randomUUID()}`,
    orgId: bot.admin.orgId,
    role: "org:member",
  };
  await updateFeatureSwitchesForUser(context, member, {
    [PLATFORMS[platform].featureSwitch]: true,
  });
  return {
    bot,
    member,
    appCallback: `${ORIGINS.app}${PLATFORMS[platform].callbackPath}`,
  };
}

async function assertManagedConnectorAndForbiddenMutations(platform: Platform) {
  const { bot } = await installBotWithMember(platform);
  const apiPrefix = `${PLATFORMS[platform].apiOrigin}/open-apis/`;

  const listed = await accept(
    customConnectorsClient().list({ headers: signIn(bot.admin) }),
    [200],
  );
  expect(listed.body.connectors).toHaveLength(1);
  const connector = listed.body.connectors[0];
  if (
    !connector ||
    connector.kind !== "http" ||
    connector.authMode !== "oauth"
  ) {
    throw new Error("Expected one integration-managed OAuth HTTP connector");
  }
  expect(connector.prefixTemplates).toStrictEqual([apiPrefix]);
  expect(connector.permissionBundleRef).toBe("builtin:feishu@1");
  expect(connector.oauthConfig.providerAdapter).toBe("feishu");
  expect(connector.oauthConfig.scopes).toStrictEqual([...FEISHU_OAUTH_SCOPES]);
  expect(connector.skillMarkdown).toContain(apiPrefix);
  expect("connected" in connector && connector.connected).toBeFalsy();

  const bundle = await accept(
    customConnectorByIdClient().permissions({
      headers: signIn(bot.admin),
      params: { id: connector.id },
    }),
    [200],
  );
  expect(bundle.body.ref).toBe("builtin:feishu@1");

  const adminBriefs = await accept(
    connectedConnectorsClient().list({ headers: signIn(bot.admin) }),
    [200],
  );
  expect(adminBriefs.body.customConnectors).toStrictEqual([]);

  const adminStatus = await accept(
    feishuClient(platform).getStatus({ headers: signIn(bot.admin) }),
    [200],
  );
  expect(adminStatus.body).toMatchObject({
    isInstalled: true,
    isConnected: false,
  });

  const expectedForbidden = {
    error: { message: "This connector is managed by its integration" },
  };
  const oauthStart = await accept(
    customConnectorOAuth2Client().start({
      headers: signIn(bot.admin),
      params: { id: connector.id },
      body: { account: { intent: "add" } },
    }),
    [403],
  );
  expect(oauthStart.body).toMatchObject(expectedForbidden);

  const updated = await accept(
    customConnectorByIdClient().update({
      headers: signIn(bot.admin),
      params: { id: connector.id },
      body: {
        kind: "http",
        displayName: "Renamed connector",
        prefixTemplates: [apiPrefix],
        fields: [],
        headerInjections: [],
        queryInjections: [],
        authMode: "none",
      },
    }),
    [403],
  );
  expect(updated.body).toMatchObject(expectedForbidden);

  const deleted = await accept(
    customConnectorByIdClient().delete({
      headers: signIn(bot.admin),
      params: { id: connector.id },
    }),
    [403],
  );
  expect(deleted.body).toMatchObject(expectedForbidden);

  const valuesSet = await accept(
    customConnectorValuesClient().set({
      headers: signIn(bot.admin),
      params: { id: connector.id },
      body: {
        values: [],
        account: { intent: "add" },
      },
    }),
    [403],
  );
  expect(valuesSet.body).toMatchObject(expectedForbidden);

  const proposalSaved = await accept(
    customConnectorProposalClient().save({
      headers: signIn(bot.admin),
      body: {
        proposal: {
          operation: "update",
          connectorId: connector.id,
          displayName: "Proposed connector",
          prefixTemplates: [apiPrefix],
          fields: [
            {
              key: "token",
              kind: "secret",
              label: "Token",
              required: true,
            },
          ],
          headerInjections: [
            {
              name: "Authorization",
              valueTemplate: "Bearer {{secrets.token}}",
            },
          ],
          queryInjections: [],
        },
        values: [{ key: "token", kind: "secret", value: "proposal-token" }],
      },
    }),
    [403],
  );
  expect(proposalSaved.body).toMatchObject(expectedForbidden);
  return {
    permissionBundleRef: connector.permissionBundleRef,
    adminConnected: adminStatus.body.isConnected,
    forbiddenStatuses: [
      oauthStart.status,
      updated.status,
      deleted.status,
      valuesSet.status,
      proposalSaved.status,
    ],
  };
}

async function assertSignedOutOAuthConnectAndWelcome(platform: Platform) {
  const { bot, member, appCallback } = await installBotWithMember(platform);
  const memberOpenId = `ou_member_${randomUUID()}`;
  const { exchanges, welcomes } = acceptFeishuAuthorizationWithWelcome(
    platform,
    memberOpenId,
  );

  const memberStatus = await accept(
    feishuClient(platform).getStatus({ headers: signIn(member) }),
    [200],
  );
  const connectUrl = memberStatus.body.connectUrl;
  if (!connectUrl) {
    throw new Error("Expected a signed connect URL for member");
  }
  const signedState = new URL(connectUrl).searchParams.get("state") ?? "";

  const startDefault = await accept(
    oauthClient().connect({ query: { state: signedState } }),
    [307],
  );
  const authorizeDefault = new URL(startDefault.headers.get("location") ?? "");
  expect(authorizeDefault.origin).toBe(PLATFORMS[platform].accountsOrigin);
  expect(authorizeDefault.searchParams.get("client_id")).toBe(bot.appId);
  expect(authorizeDefault.searchParams.get("redirect_uri")).toBe(appCallback);
  expect(
    (authorizeDefault.searchParams.get("scope") ?? "").split(" "),
  ).toStrictEqual([...FEISHU_OAUTH_SCOPES]);

  const startAppTarget = await accept(
    oauthClient().connect({
      query: { state: signedState, callbackTarget: "app" },
    }),
    [307],
  );
  const authorizeApp = new URL(startAppTarget.headers.get("location") ?? "");
  expect(authorizeApp.origin).toBe(PLATFORMS[platform].accountsOrigin);
  expect(authorizeApp.searchParams.get("redirect_uri")).toBe(appCallback);
  const oauthState = authorizeApp.searchParams.get("state") ?? "";

  const handoff = await completeAuthorization({
    code: "member-oauth-code",
    state: oauthState,
  });
  expect(handoff.status).toBe(307);
  const handoffUrl = new URL(handoff.headers.get("location") ?? "");
  expect(`${handoffUrl.origin}${handoffUrl.pathname}`).toBe(appCallback);
  expect(handoffUrl.searchParams.get("code")).toBe("member-oauth-code");
  expect(handoffUrl.searchParams.get("state")).toBe(oauthState);

  const completed = await completeAuthorization({
    code: "member-oauth-code",
    state: oauthState,
    responseMode: "json",
  });
  if (completed.status !== 200) {
    throw new Error("Expected JSON completion redirect");
  }
  const completedRedirect = new URL(completed.body.redirectUrl);
  expect(completedRedirect.origin).toBe(PLATFORMS[platform].appLinkOrigin);
  expect(completedRedirect.searchParams.get("appId")).toBe(bot.appId);
  expect(exchanges.at(-1)).toStrictEqual({ redirectUri: appCallback });

  await flushWaitUntilForTest();
  expect(welcomes).toStrictEqual([
    {
      receiveIdType: "open_id",
      receiveId: memberOpenId,
      msgType: "interactive",
    },
  ]);

  const customList = await accept(
    customConnectorsClient().list({ headers: signIn(member) }),
    [200],
  );
  expect(customList.body.connectors).toMatchObject([{ connected: true }]);
  const connectorId = customList.body.connectors[0]?.id;

  const briefs = await accept(
    connectedConnectorsClient().list({ headers: signIn(member) }),
    [200],
  );
  expect(briefs.body.customConnectors).toMatchObject([
    {
      id: connectorId,
      integrationManaged: true,
      permissionBundleRef: "builtin:feishu@1",
    },
  ]);
  return {
    completionOrigin: completedRedirect.origin,
    completionAppId: completedRedirect.searchParams.get("appId"),
    welcomes,
    connectedCustomBriefCount: briefs.body.customConnectors.length,
  };
}

async function completeMemberOAuth(connectUrl: string, code: string) {
  const authorize = await startAuthorization(connectUrl);
  const completed = await completeAuthorization({
    code,
    state: authorize.searchParams.get("state") ?? "",
    responseMode: "json",
  });
  if (completed.status !== 200) {
    throw new Error("Expected JSON completion redirect");
  }
  return { authorize, redirectUrl: completed.body.redirectUrl };
}

async function memberConnectUrl(platform: Platform, member: Actor) {
  const status = await accept(
    feishuClient(platform).getStatus({ headers: signIn(member) }),
    [200],
  );
  const connectUrl = status.body.connectUrl;
  if (!connectUrl) {
    throw new Error("Expected member connect URL");
  }
  return connectUrl;
}

async function assertReconnectWithPinnedUri(platform: Platform) {
  const { member, appCallback } = await installBotWithMember(platform);
  const memberOpenId = `ou_member_${randomUUID()}`;
  const { exchanges } = acceptFeishuAuthorizationWithWelcome(
    platform,
    memberOpenId,
  );
  const connectUrl = await memberConnectUrl(platform, member);
  await completeMemberOAuth(connectUrl, "initial-code");

  const reconnected = await completeMemberOAuth(connectUrl, "reconnect-code");
  await flushWaitUntilForTest();
  expect(reconnected.authorize.searchParams.get("redirect_uri")).toBe(
    appCallback,
  );
  return {
    reconnectOrigin: new URL(reconnected.redirectUrl).origin,
    latestExchangeRedirectUri: exchanges.at(-1)?.redirectUri,
  };
}

async function assertDisconnectAndRemoveInstallation(platform: Platform) {
  const { bot, member } = await installBotWithMember(platform);
  const memberOpenId = `ou_member_${randomUUID()}`;
  acceptFeishuAuthorizationWithWelcome(platform, memberOpenId);
  const connectUrl = await memberConnectUrl(platform, member);
  await completeMemberOAuth(connectUrl, "initial-code");
  await flushWaitUntilForTest();

  await accept(
    feishuClient(platform).disconnect({ headers: signIn(member) }),
    [200],
  );
  const afterDisconnect = await accept(
    feishuClient(platform).getStatus({ headers: signIn(member) }),
    [200],
  );
  expect(afterDisconnect.body).toMatchObject({
    isInstalled: true,
    isConnected: false,
  });
  const connectorsAfterDisconnect = await accept(
    customConnectorsClient().list({ headers: signIn(member) }),
    [200],
  );
  expect(connectorsAfterDisconnect.body.connectors).toMatchObject([
    { connected: false },
  ]);
  const briefsAfterDisconnect = await accept(
    connectedConnectorsClient().list({ headers: signIn(member) }),
    [200],
  );
  expect(briefsAfterDisconnect.body.customConnectors).toStrictEqual([]);

  await accept(
    feishuClient(platform).remove({ headers: signIn(bot.admin) }),
    [200],
  );
  const afterRemove = await accept(
    feishuClient(platform).getStatus({ headers: signIn(bot.admin) }),
    [200],
  );
  expect(afterRemove.body).toMatchObject({
    isInstalled: false,
    installations: [],
  });
  const connectorsAfterRemove = await accept(
    customConnectorsClient().list({ headers: signIn(bot.admin) }),
    [200],
  );
  expect(connectorsAfterRemove.body.connectors).toStrictEqual([]);
  return {
    afterDisconnectInstalled: afterDisconnect.body.isInstalled,
    afterDisconnectConnected: afterDisconnect.body.isConnected,
    afterRemoveInstalled: afterRemove.body.isInstalled,
    afterRemoveConnectors: connectorsAfterRemove.body.connectors,
  };
}

describe("feishu integration", () => {
  it("feishu-oauth-events-004 verifies plaintext and encrypted URL challenges and rejects forged or stale events", async () => {
    const bot = await installFeishuBot();
    const challengeFor = (challenge: string) => {
      return {
        type: "url_verification",
        challenge,
        token: bot.verificationToken,
      };
    };

    const plaintext = await postUnsigned(
      bot.callbackUrl,
      JSON.stringify(challengeFor("plain-challenge")),
    );
    expect(plaintext.body).toStrictEqual({ challenge: "plain-challenge" });
    const encrypted = await postUnsigned(
      bot.callbackUrl,
      encryptFor(bot.encryptKey, challengeFor("encrypted-challenge")),
    );
    expect(encrypted.body).toStrictEqual({ challenge: "encrypted-challenge" });
    await expect(readStatus(bot.admin)).resolves.toMatchObject({
      callbackVerified: true,
    });

    const event = encryptFor(bot.encryptKey, {
      schema: "2.0",
      header: {
        event_id: randomUUID(),
        event_type: "im.chat.updated_v1",
        tenant_key: `tenant_${randomUUID()}`,
        app_id: bot.appId,
        token: bot.verificationToken,
      },
      event: {},
    });
    const forged = await deliver(bot.callbackUrl, event, bot.encryptKey, {
      signature: "0".repeat(64),
    });
    expect(forged.status).toBe(401);
    const stale = await deliver(bot.callbackUrl, event, bot.encryptKey, {
      timestamp: Math.floor(now() / 1000) - 3600,
    });
    expect(stale.status).toBe(401);
    await expect(readStatus(bot.admin)).resolves.toMatchObject({
      callbackVerified: true,
    });
  });

  it("feishu-oauth-events-005 backfills the bot identity before inviting an unconnected group sender", async () => {
    const bot = await installFeishuBot();
    const replies: { messageId: string; body: unknown }[] = [];
    server.use(
      http.post(
        `${FEISHU_API}/open-apis/im/v1/messages/:messageId/reply`,
        async ({ params, request }) => {
          replies.push({
            messageId: String(params.messageId),
            body: await request.json(),
          });
          return HttpResponse.json({
            code: 0,
            data: { message_id: `om_${randomUUID()}`, chat_id: "oc_group" },
          });
        },
      ),
    );
    const messageId = `om_${randomUUID()}`;

    const response = await deliver(
      bot.callbackUrl,
      encryptFor(bot.encryptKey, {
        schema: "2.0",
        header: {
          event_id: randomUUID(),
          event_type: "im.message.receive_v1",
          tenant_key: `tenant_${randomUUID()}`,
          app_id: bot.appId,
          token: bot.verificationToken,
        },
        event: {
          sender: {
            sender_id: { open_id: `ou_${randomUUID()}` },
            sender_type: "user",
          },
          message: {
            message_id: messageId,
            chat_id: "oc_group",
            chat_type: "group",
            message_type: "text",
            content: JSON.stringify({ text: "@_user_1 help me" }),
            mentions: [
              {
                key: "@_user_1",
                id: { open_id: bot.botOpenId },
                name: "Okou Feishu",
              },
            ],
          },
        },
      }),
      bot.encryptKey,
    );
    expect(response.status).toBe(200);
    await flushWaitUntilForTest();

    const reply = object({ content: string(), reply_in_thread: boolean() });
    expect(
      replies.map((sent) => {
        const parsed = reply.parse(sent.body);
        return {
          messageId: sent.messageId,
          inThread: parsed.reply_in_thread,
          invitesToConnect: parsed.content.includes("Connect your account"),
        };
      }),
    ).toStrictEqual([{ messageId, inThread: true, invitesToConnect: true }]);
    await expect(readStatus(bot.admin)).resolves.toMatchObject({
      botName: "Okou Feishu",
      callbackVerified: true,
    });
  });

  it("feishu-oauth-events-002 keeps Feishu OAuth on the configured app and API origins", async () => {
    useSeparateOrigins();
    const bot = await installFeishuBot();
    await completeSetup(bot);
    const exchanges = acceptFeishuAuthorization("feishu", `ou_${randomUUID()}`);
    const appCallback = `${ORIGINS.app}/connectors/feishu/callback`;

    const status = await readStatus(bot.admin);
    expect(status.oauthRedirectUrl).toBe(appCallback);
    expect(status.installations?.[0]).toMatchObject({
      oauthRedirectUrl: appCallback,
    });
    const connectUrl = status.connectUrl;
    if (!connectUrl) {
      throw new Error("Expected a connect URL");
    }
    expect(new URL(connectUrl).origin).toBe(ORIGINS.api);

    const authorize = await startAuthorization(connectUrl);
    expect(authorize.origin).toBe("https://accounts.feishu.cn");
    expect(authorize.searchParams.get("client_id")).toBe(bot.appId);
    expect(authorize.searchParams.get("redirect_uri")).toBe(appCallback);
    const deniedState = authorize.searchParams.get("state") ?? "";
    expect(deniedState).toMatch(/^[0-9a-f]{64}$/);

    const denial = {
      state: deniedState,
      error: "access_denied",
      error_description: "The user declined",
    };
    const browser = await completeAuthorization(denial);
    expect(browser.status).toBe(307);
    const handoff = new URL(browser.headers.get("location") ?? "");
    expect(`${handoff.origin}${handoff.pathname}`).toBe(appCallback);
    const denied = await completeAuthorization({
      ...denial,
      responseMode: "json",
    });
    if (denied.status !== 200) {
      throw new Error("Expected a JSON redirect for the denial");
    }
    const deniedRedirect = new URL(denied.body.redirectUrl);
    expect(`${deniedRedirect.origin}${deniedRedirect.pathname}`).toBe(
      `${ORIGINS.app}/settings/feishu`,
    );
    expect(deniedRedirect.search).toContain("The+user+declined");

    const retry = await startAuthorization(connectUrl);
    const completed = await completeAuthorization({
      state: retry.searchParams.get("state") ?? "",
      code: "authorization-code",
      responseMode: "json",
    });
    if (completed.status !== 200) {
      throw new Error("Expected a JSON completion redirect");
    }
    expect(new URL(completed.body.redirectUrl).origin).toBe(
      "https://applink.feishu.cn",
    );
    expect(exchanges).toStrictEqual([{ redirectUri: appCallback }]);
  });

  it("feishu-oauth-events-003 connects a DM sender through the app-origin message link", async () => {
    const appCallback = `${ORIGINS.app}${PLATFORMS.feishu.callbackPath}`;

    await expect(connectFromMessageLink("feishu")).resolves.toStrictEqual({
      linkOrigin: ORIGINS.app,
      authorizeOrigin: PLATFORMS.feishu.accountsOrigin,
      authorizeRedirectUri: appCallback,
      hexState: true,
      completionOrigin: PLATFORMS.feishu.appLinkOrigin,
      exchanges: [{ redirectUri: appCallback }],
    });
  });

  it("feishu-oauth-events-001 (1/4) publishes the managed Feishu connector and rejects general custom-connector mutations", async () => {
    await expect(
      assertManagedConnectorAndForbiddenMutations("feishu"),
    ).resolves.toStrictEqual({
      permissionBundleRef: "builtin:feishu@1",
      adminConnected: false,
      forbiddenStatuses: [403, 403, 403, 403, 403],
    });
  });

  it("feishu-oauth-events-001 (2/4) connects a signed-out Feishu member with pinned callback and sends interactive welcome", async () => {
    await expect(
      assertSignedOutOAuthConnectAndWelcome("feishu"),
    ).resolves.toMatchObject({
      completionOrigin: PLATFORMS.feishu.appLinkOrigin,
      connectedCustomBriefCount: 1,
    });
  });

  it("feishu-oauth-events-001 (3/4) reconnects the Feishu member using the pinned app callback URI", async () => {
    await expect(assertReconnectWithPinnedUri("feishu")).resolves.toStrictEqual(
      {
        reconnectOrigin: PLATFORMS.feishu.appLinkOrigin,
        latestExchangeRedirectUri: `${ORIGINS.app}${PLATFORMS.feishu.callbackPath}`,
      },
    );
  });

  it("feishu-oauth-events-001 (4/4) disconnects the Feishu member and removes the installation", async () => {
    await expect(
      assertDisconnectAndRemoveInstallation("feishu"),
    ).resolves.toStrictEqual({
      afterDisconnectInstalled: true,
      afterDisconnectConnected: false,
      afterRemoveInstalled: false,
      afterRemoveConnectors: [],
    });
  });
});

describe("lark integration", () => {
  it("feishu-oauth-events-010 connects a Lark DM sender through the app-origin message link", async () => {
    const appCallback = `${ORIGINS.app}${PLATFORMS.lark.callbackPath}`;

    await expect(connectFromMessageLink("lark")).resolves.toStrictEqual({
      linkOrigin: ORIGINS.app,
      authorizeOrigin: PLATFORMS.lark.accountsOrigin,
      authorizeRedirectUri: appCallback,
      hexState: true,
      completionOrigin: PLATFORMS.lark.appLinkOrigin,
      exchanges: [{ redirectUri: appCallback }],
    });
  });

  it("feishu-oauth-events-008 (1/4) publishes the managed Lark connector and rejects general custom-connector mutations", async () => {
    await expect(
      assertManagedConnectorAndForbiddenMutations("lark"),
    ).resolves.toStrictEqual({
      permissionBundleRef: "builtin:feishu@1",
      adminConnected: false,
      forbiddenStatuses: [403, 403, 403, 403, 403],
    });
  });

  it("feishu-oauth-events-008 (2/4) connects a signed-out Lark member with pinned callback and sends interactive welcome", async () => {
    await expect(
      assertSignedOutOAuthConnectAndWelcome("lark"),
    ).resolves.toMatchObject({
      completionOrigin: PLATFORMS.lark.appLinkOrigin,
      connectedCustomBriefCount: 1,
    });
  });

  it("feishu-oauth-events-008 (3/4) reconnects the Lark member using the pinned app callback URI", async () => {
    await expect(assertReconnectWithPinnedUri("lark")).resolves.toStrictEqual({
      reconnectOrigin: PLATFORMS.lark.appLinkOrigin,
      latestExchangeRedirectUri: `${ORIGINS.app}${PLATFORMS.lark.callbackPath}`,
    });
  });

  it("feishu-oauth-events-008 (4/4) disconnects the Lark member and removes the installation", async () => {
    await expect(
      assertDisconnectAndRemoveInstallation("lark"),
    ).resolves.toStrictEqual({
      afterDisconnectInstalled: true,
      afterDisconnectConnected: false,
      afterRemoveInstalled: false,
      afterRemoveConnectors: [],
    });
  });
});
