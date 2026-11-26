import {
  createCipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { createStore } from "ccstate";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { boolean, object, optional, string } from "zod";
import { feishuBrowserConnectContract } from "@okouai/api-contracts/contracts/feishu-browser-connect";
import {
  FEISHU_OAUTH_SCOPES,
  feishuConnectContract,
  larkConnectContract,
} from "@okouai/api-contracts/contracts/feishu-connect";
import { connectorPermissionsContract } from "@okouai/api-contracts/contracts/connector-permissions";
import { customConnectorsContract } from "@okouai/api-contracts/contracts/custom-connectors";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { feishuOauthContract } from "@okouai/api-contracts/contracts/feishu-oauth";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { connectorPermissionsRoutes } from "../connector-permissions";
import { customConnectorsRoutes } from "../custom-connectors";
import { featureSwitchesRoutes } from "../feature-switches";
import { feishuBrowserConnectRoutes } from "../feishu-browser-connect";
import { feishuConnectRoutes } from "../feishu-connect";
import { feishuEventsRoutes } from "../feishu-events";
import { feishuOauthRoutes } from "../feishu-oauth";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { countPublishedTo } from "./helpers/realtime-publications";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const SESSION = Object.freeze({ authorization: "Bearer clerk-session" });
const APP_URL = "https://app.okou.ai";

type Platform = "feishu" | "lark";

const PLATFORMS = {
  feishu: {
    apiOrigin: "https://open.feishu.cn",
    contract: feishuConnectContract,
    featureSwitch: FeatureSwitchKey.FeishuIntegration,
  },
  lark: {
    apiOrigin: "https://open.larksuite.com",
    contract: larkConnectContract,
    featureSwitch: FeatureSwitchKey.LarkIntegration,
  },
} as const;

const app = setupApp({
  context,
  routes: [
    ...feishuConnectRoutes,
    ...feishuBrowserConnectRoutes,
    ...feishuOauthRoutes,
    ...customConnectorsRoutes,
    ...connectorPermissionsRoutes,
    ...featureSwitchesRoutes,
  ],
});

const rawFeishuEvents = setupRawAppRequest({
  context,
  routes: feishuEventsRoutes,
});

function integrations(platform: Platform) {
  return app(PLATFORMS[platform].contract);
}

interface Admin {
  readonly userId: string;
  readonly orgId: string;
}

function signIn(admin: Admin) {
  createRouteMocks(context).clerk.session(
    admin.userId,
    admin.orgId,
    "org:admin",
  );
  return SESSION;
}

interface ProviderMessage {
  readonly path: string;
  readonly msgType: string;
  readonly content: string;
  readonly replyInThread: boolean;
  readonly uuid: string | undefined;
  readonly receiveId: string | undefined;
}

const outboundSchema = object({
  msg_type: string(),
  content: string(),
  reply_in_thread: optional(boolean()),
  uuid: optional(string()),
  receive_id: optional(string()),
});

interface Bot {
  readonly platform: Platform;
  readonly admin: Admin;
  readonly appId: string;
  readonly installationId: string;
  readonly callbackUrl: string;
  readonly verificationToken: string;
  readonly encryptKey: string;
  /** Every message the bot sent through the provider API. */
  readonly sent: ProviderMessage[];
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

async function deliver(bot: Bot, body: string) {
  const timestamp = String(Math.floor(now() / 1000));
  const nonce = randomUUID();
  const signature = createHash("sha256")
    .update(`${timestamp}${nonce}${bot.encryptKey}${body}`)
    .digest("hex");
  const request = setupRawAppRequest({ context, routes: feishuEventsRoutes });
  const response = await request(bot.callbackUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-lark-request-timestamp": timestamp,
      "x-lark-request-nonce": nonce,
      "x-lark-signature": signature,
    },
    body,
  });
  await flushWaitUntilForTest();
  return response;
}

/** The provider API as the installed app's tenant sees it. */
function serveProvider(
  platform: Platform,
  identity: { botName: string; avatarUrl: string },
): ProviderMessage[] {
  const apiOrigin = PLATFORMS[platform].apiOrigin;
  const sent: ProviderMessage[] = [];
  const record = async (request: Request) => {
    const body = outboundSchema.parse(await request.json());
    sent.push({
      path: new URL(request.url).pathname,
      msgType: body.msg_type,
      content: body.content,
      replyInThread: body.reply_in_thread ?? false,
      uuid: body.uuid,
      receiveId: body.receive_id,
    });
    return HttpResponse.json({
      code: 0,
      data: { message_id: `om_${randomUUID()}`, chat_id: "oc_dm" },
    });
  };
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
        bot: {
          open_id: `ou_bot_${randomUUID()}`,
          app_name: identity.botName,
          avatar_url: identity.avatarUrl,
        },
      });
    }),
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
  return sent;
}

/** An admin configured the app, finished setup and passed URL verification. */
async function installedBot(
  platform: Platform,
  botName = "Owner Managed Bot",
  verifyCallback = true,
): Promise<Bot> {
  mockEnv("APP_URL", APP_URL);
  const admin = {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
  };
  await createStore().set(
    seedOrgMembership$,
    { ...admin, role: "admin", name: "Feishu workspace" },
    context.signal,
  );
  const sent = serveProvider(platform, {
    botName,
    avatarUrl: "https://example.com/okou-feishu.png",
  });
  context.mocks.s3.send.mockResolvedValue({ ETag: "fixture-etag" });
  await updateFeatureSwitchesForUser(context, admin, {
    [PLATFORMS[platform].featureSwitch]: true,
  });
  const appId = `cli_${randomUUID()}`;
  const verificationToken = `token-${randomUUID()}`;
  const encryptKey = `encrypt-${randomUUID()}`;
  const configured = await accept(
    integrations(platform).setup({
      headers: signIn(admin),
      body: { appId, appSecret: "app-secret", verificationToken, encryptKey },
    }),
    [200],
  );
  const { installationId, callbackUrl } = configured.body;
  if (!installationId || !callbackUrl) {
    throw new Error("Expected a configured installation");
  }
  await accept(
    integrations(platform).updateInstallation({
      headers: signIn(admin),
      params: { installationId },
      body: { setupCompleted: true },
    }),
    [200],
  );
  const bot: Bot = {
    platform,
    admin,
    appId,
    installationId,
    callbackUrl,
    verificationToken,
    encryptKey,
    sent,
  };
  if (!verifyCallback) {
    return bot;
  }
  const challenge = `challenge-${randomUUID()}`;
  const verified = await deliver(
    bot,
    encryptFor(encryptKey, {
      type: "url_verification",
      challenge,
      token: verificationToken,
    }),
  );
  if (verified.status !== 200) {
    throw new Error("Expected the callback URL verification to pass");
  }
  return bot;
}

function directMessage(
  bot: Bot,
  text: string,
  options: { openId?: string; messageId?: string } = {},
): string {
  return encryptFor(bot.encryptKey, {
    schema: "2.0",
    header: {
      event_id: randomUUID(),
      event_type: "im.message.receive_v1",
      tenant_key: "tenant_member",
      app_id: bot.appId,
      token: bot.verificationToken,
    },
    event: {
      sender: {
        sender_id: { open_id: options.openId ?? "ou_feishu_user" },
        sender_type: "user",
      },
      message: {
        message_id: options.messageId ?? `om_${randomUUID()}`,
        chat_id: "oc_dm_feishu_user",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text }),
      },
    },
  });
}

async function removeInstallation(bot: Bot) {
  return await accept(
    integrations(bot.platform).removeInstallation({
      headers: signIn(bot.admin),
      params: { installationId: bot.installationId },
    }),
    [200],
  );
}

function feishuChanged(admin: Admin): number {
  return countPublishedTo(context.mocks, {
    channel: `user:${admin.userId}`,
    topic: "feishu:changed",
  });
}

function firstUrlIn(messages: readonly ProviderMessage[]): URL {
  for (const message of messages) {
    const match = /https:\/\/[^\s"\\)]+/u.exec(message.content);
    if (match) {
      return new URL(match[0]);
    }
  }
  throw new Error("Expected a URL in the bot replies");
}

/**
 * `ou_feishu_user` messages the bot and receives a signed connect link; the
 * returned step lets the admin open that link and finish the provider's OAuth.
 */
async function linkedSender(bot: Bot) {
  const apiOrigin = PLATFORMS[bot.platform].apiOrigin;
  server.use(
    http.post(`${apiOrigin}/open-apis/authen/v2/oauth/token`, () => {
      return HttpResponse.json({
        code: 0,
        access_token: `u-${randomUUID()}`,
        refresh_token: `r-${randomUUID()}`,
        expires_in: 7200,
      });
    }),
    http.get(`${apiOrigin}/open-apis/authen/v1/user_info`, () => {
      return HttpResponse.json({
        code: 0,
        data: {
          open_id: "ou_feishu_user",
          name: "Feishu User",
          tenant_key: "tenant_member",
        },
      });
    }),
  );
  const before = bot.sent.length;
  await deliver(bot, directMessage(bot, "hello"));
  const link = firstUrlIn(bot.sent.slice(before));
  const linkBody = {
    installationId: link.searchParams.get("installationId") ?? "",
    openId: link.searchParams.get("openId") ?? "",
    chatId: link.searchParams.get("chatId") ?? "",
    ts: Number(link.searchParams.get("ts")),
    sig: link.searchParams.get("sig") ?? "",
  };
  return async () => {
    const connected = await accept(
      app(feishuBrowserConnectContract).connectFromApp({
        headers: signIn(bot.admin),
        body: linkBody,
      }),
      [200],
    );
    const authorizationUrl = new URL(connected.body.openUrl);
    const callback = await accept(
      app(feishuOauthContract).callback({
        query: {
          state: authorizationUrl.searchParams.get("state") ?? "",
          code: "authorization-code",
          responseMode: "json",
        },
      }),
      [200],
    );
    return { authorizationUrl, location: callback.body.redirectUrl };
  };
}

async function connectSender(bot: Bot): Promise<void> {
  const authorize = await linkedSender(bot);
  await authorize();
}

/** The admin tries to point the installation at a different provider app. */
async function replaceApp(bot: Bot) {
  return await accept(
    integrations(bot.platform).setup({
      headers: signIn(bot.admin),
      body: {
        installationId: bot.installationId,
        appId: `cli_${randomUUID()}`,
        appSecret: "replacement-secret",
        verificationToken: `token-${randomUUID()}`,
        encryptKey: `encrypt-${randomUUID()}`,
      },
    }),
    [409],
  );
}

function contents(messages: readonly ProviderMessage[]): string {
  return messages
    .map((message) => {
      return message.content;
    })
    .join("\n");
}

describe("feishu integration", () => {
  it("feishu-branding-connection-001 uses Okou branding for installation status without renaming the provider bot", async () => {
    const bot = await installedBot("feishu");

    const status = await accept(
      integrations("feishu").getStatus({
        headers: signIn(bot.admin),
        extraHeaders: { origin: APP_URL },
      }),
      [200],
    );
    await removeInstallation(bot);

    expect(status.body.installations?.[0]).toMatchObject({
      botName: "Owner Managed Bot",
      callbackUrl: bot.callbackUrl,
    });
  });

  it("feishu-branding-connection-002 uses Okou branding for unconnected commands without renaming the provider bot", async () => {
    const bot = await installedBot("feishu");
    const before = bot.sent.length;

    await deliver(
      bot,
      directMessage(bot, "/help", { openId: "ou_feishu_unconnected" }),
    );
    await deliver(
      bot,
      directMessage(bot, "hello", { openId: "ou_feishu_unconnected" }),
    );
    await removeInstallation(bot);

    const replies = bot.sent.slice(before);
    expect(contents(replies)).toContain("Owner Managed Bot commands");
    expect(contents(replies)).toContain("To use Okou in Feishu");
    expect(firstUrlIn(replies).host).toBe("app.okou.ai");
  });

  it("feishu-branding-connection-003 (1/2) answers a connected user's help with the provider bot name", async () => {
    const bot = await installedBot("feishu");
    await connectSender(bot);
    const before = bot.sent.length;

    await deliver(bot, directMessage(bot, "/help"));

    expect(contents(bot.sent.slice(before))).toContain(
      "Owner Managed Bot commands",
    );
  });

  it("feishu-branding-connection-003 (2/2) tells a connected user they are already connected to Okou, then removes the installation", async () => {
    const bot = await installedBot("feishu");
    await connectSender(bot);
    const before = bot.sent.length;

    await deliver(bot, directMessage(bot, "/connect"));
    await removeInstallation(bot);

    expect(contents(bot.sent.slice(before))).toContain(
      "Your Feishu account is already connected to Okou",
    );
  });

  it("feishu-branding-connection-007 (1/2) rejects a replacement Feishu app and keeps the installation status", async () => {
    const bot = await installedBot("feishu", "Okou Feishu");
    await connectSender(bot);

    const rejected = await replaceApp(bot);
    const status = await accept(
      integrations("feishu").getStatus({ headers: signIn(bot.admin) }),
      [200],
    );

    expect(rejected.body.error.message).toContain(
      "cannot be changed to a different App ID",
    );
    expect(status.body.installations).toHaveLength(1);
    expect(status.body.installations?.[0]).toMatchObject({
      id: bot.installationId,
      appId: bot.appId,
      botName: "Okou Feishu",
      botAvatarUrl: "https://example.com/okou-feishu.png",
      callbackUrl: bot.callbackUrl,
      callbackVerified: true,
      setupCompleted: true,
      isConnected: true,
      tenantKey: "tenant_member",
    });
  });

  it("feishu-branding-connection-007 (2/2) keeps the custom connector list after the rejection and removes the installation", async () => {
    const bot = await installedBot("feishu", "Okou Feishu");
    await connectSender(bot);
    const connectors = await accept(
      app(customConnectorsContract).list({ headers: signIn(bot.admin) }),
      [200],
    );

    await replaceApp(bot);
    const connectorsAfter = await accept(
      app(customConnectorsContract).list({ headers: signIn(bot.admin) }),
      [200],
    );
    await removeInstallation(bot);

    expect(connectorsAfter.body).toStrictEqual(connectors.body);
  });

  it("feishu-branding-connection-013 (1/4) connects through Feishu OAuth without delivering the rejected welcome", async () => {
    const reconnecting = await connectWithRejectedWelcome("feishu");

    const connected = await connectOnce(reconnecting);

    expect(connected.scopes).toStrictEqual([...FEISHU_OAUTH_SCOPES]);
    expect(connected.location).toBe(
      `https://applink.feishu.cn/client/bot/open?appId=${reconnecting.bot.appId}`,
    );
    expect(connected.published).toBeGreaterThan(0);
    expect(connected.connectedUserName).toBe("Feishu User");
    expect(connected.replies).not.toContain("You're connected!");
  });

  it("feishu-branding-connection-013 (2/4) keeps the granted member permissions after reconnecting", async () => {
    const reconnecting = await connectWithRejectedWelcome("feishu", {
      loadManagedConnector: true,
    });

    const { granted, kept } = await permissionsAfterReconnect(reconnecting);

    expect(kept).toStrictEqual(granted);
    expect(kept).toMatchObject([
      { permission: "messages:send-as-user", action: "allow" },
    ]);
  });

  it("feishu-branding-connection-013 (3/4) retries the welcome card with the rejected idempotency key on reconnect", async () => {
    const reconnecting = await connectWithRejectedWelcome("feishu");

    const { welcome, rejectedKey } = await welcomeAfterReconnect(reconnecting);

    expect(rejectedKey).toBeDefined();
    expect(welcome).toHaveLength(1);
    expect(welcome[0]).toMatchObject({
      path: "/open-apis/im/v1/messages",
      receiveId: "ou_feishu_user",
      msgType: "interactive",
      uuid: rejectedKey,
    });
    expect(welcome[0]?.content).toContain("Okou");
  });

  it("feishu-branding-connection-013 (4/4) reports the reconnected Feishu installation status", async () => {
    const reconnecting = await connectWithRejectedWelcome("feishu");

    const installation = await statusAfterReconnect(reconnecting);

    expect(installation).toMatchObject({
      appId: reconnecting.bot.appId,
      isConnected: true,
      connectedUserName: "Feishu User",
    });
  });

  it("feishu-branding-connection-010 deduplicates unconnected messages and sends one connect link", async () => {
    const bot = await installedBot("feishu");
    const before = bot.sent.length;
    const published = feishuChanged(bot.admin);
    const event = directMessage(bot, "hello", { messageId: "om_fixed_hello" });

    const first = await deliver(bot, event);
    const second = await deliver(bot, event);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(feishuChanged(bot.admin)).toBeGreaterThan(published);
    const replies = bot.sent.slice(before);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      path: "/open-apis/im/v1/messages/om_fixed_hello/reply",
      msgType: "interactive",
      replyInThread: true,
    });
    expect(replies[0]?.content).toContain("Connect your account");
    expect(replies[0]?.content).toContain(
      "To use Okou in Feishu, please connect your account first.",
    );
    const link = firstUrlIn(replies);
    expect(`${link.origin}${link.pathname}`).toBe(
      "https://app.okou.ai/settings/feishu",
    );
  });

  it("feishu-branding-connection-011 offers connection to an unlinked sender before workspace onboarding", async () => {
    const bot = await installedBot("feishu");
    const before = bot.sent.length;

    const status = await accept(
      integrations("feishu").getStatus({ headers: signIn(bot.admin) }),
      [200],
    );
    const event = directMessage(bot, "hello before onboarding", {
      messageId: "om_before_onboarding",
    });
    const first = await deliver(bot, event);
    const second = await deliver(bot, event);

    expect(status.body).toMatchObject({
      isInstalled: true,
      callbackVerified: true,
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const replies = bot.sent.slice(before);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      path: "/open-apis/im/v1/messages/om_before_onboarding/reply",
      msgType: "interactive",
      replyInThread: true,
    });
    expect(replies[0]?.content).toContain("Connect your account");
  });
});

async function connectWithRejectedWelcome(
  platform: Platform,
  options: { readonly loadManagedConnector?: boolean } = {},
) {
  // The Given needs a set-up installation, not a verified callback URL.
  mockEnv("APP_URL", APP_URL);
  const admin = {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
  };
  const sent = serveProvider(platform, {
    botName: "Owner Managed Bot",
    avatarUrl: "https://example.com/okou-feishu.png",
  });
  context.mocks.s3.send.mockResolvedValue({ ETag: "fixture-etag" });
  const apiOrigin = PLATFORMS[platform].apiOrigin;
  let rejectedKey: string | undefined;
  server.use(
    http.post(`${apiOrigin}/open-apis/im/v1/messages`, async ({ request }) => {
      if (rejectedKey !== undefined) {
        return;
      }
      rejectedKey = outboundSchema.parse(await request.clone().json()).uuid;
      return HttpResponse.json(
        { code: 1500, msg: "temporarily unavailable" },
        { status: 503 },
      );
    }),
    http.post(`${apiOrigin}/open-apis/authen/v2/oauth/token`, () => {
      return HttpResponse.json({
        code: 0,
        access_token: `u-${randomUUID()}`,
        refresh_token: `r-${randomUUID()}`,
        expires_in: 7200,
      });
    }),
    http.get(`${apiOrigin}/open-apis/authen/v1/user_info`, () => {
      return HttpResponse.json({
        code: 0,
        data: {
          open_id: "ou_feishu_user",
          name: "Feishu User",
          tenant_key: "tenant_member",
        },
      });
    }),
  );
  await Promise.all([
    createStore().set(
      seedOrgMembership$,
      { ...admin, role: "admin", name: "Feishu workspace" },
      context.signal,
    ),
    accept(
      app(featureSwitchesContract).update({
        headers: signIn(admin),
        body: { switches: { [PLATFORMS[platform].featureSwitch]: true } },
      }),
      [200],
    ),
  ]);
  const appId = `cli_${randomUUID()}`;
  const verificationToken = `token-${randomUUID()}`;
  const encryptKey = `encrypt-${randomUUID()}`;
  const configured = await accept(
    integrations(platform).setup({
      headers: signIn(admin),
      body: { appId, appSecret: "app-secret", verificationToken, encryptKey },
    }),
    [200],
  );
  const { installationId, callbackUrl } = configured.body;
  if (!installationId || !callbackUrl) {
    throw new Error("Expected a configured installation");
  }
  const bot: Bot = {
    platform,
    admin,
    appId,
    installationId,
    callbackUrl,
    verificationToken,
    encryptKey,
    sent,
  };
  const beforeLink = bot.sent.length;
  const dmBody = directMessage(bot, "hello");
  const timestamp = String(Math.floor(now() / 1000));
  const nonce = randomUUID();
  const signature = createHash("sha256")
    .update(`${timestamp}${nonce}${bot.encryptKey}${dmBody}`)
    .digest("hex");
  const [listed] = await Promise.all([
    options.loadManagedConnector
      ? accept(
          app(customConnectorsContract).list({ headers: signIn(admin) }),
          [200],
        )
      : Promise.resolve(undefined),
    accept(
      integrations(platform).updateInstallation({
        headers: signIn(admin),
        params: { installationId },
        body: { setupCompleted: true },
      }),
      [200],
    ),
    (async () => {
      await rawFeishuEvents(bot.callbackUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-lark-request-timestamp": timestamp,
          "x-lark-request-nonce": nonce,
          "x-lark-signature": signature,
        },
        body: dmBody,
      });
      await flushWaitUntilForTest();
    })(),
  ]);
  const managed = listed?.body.connectors.find((connector) => {
    return connector.oauthConfig?.providerAdapter === "feishu";
  });
  if (options.loadManagedConnector && !managed) {
    throw new Error("Expected the managed Feishu connector");
  }
  const link = firstUrlIn(bot.sent.slice(beforeLink));
  const linkBody = {
    installationId: link.searchParams.get("installationId") ?? "",
    openId: link.searchParams.get("openId") ?? "",
    chatId: link.searchParams.get("chatId") ?? "",
    ts: Number(link.searchParams.get("ts")),
    sig: link.searchParams.get("sig") ?? "",
  };
  const startOauth = async () => {
    const connected = await accept(
      app(feishuBrowserConnectContract).connectFromApp({
        headers: signIn(bot.admin),
        body: linkBody,
      }),
      [200],
    );
    return new URL(connected.body.openUrl);
  };
  const finishOauth = async (authorizationUrl: URL) => {
    const callback = await accept(
      app(feishuOauthContract).callback({
        query: {
          state: authorizationUrl.searchParams.get("state") ?? "",
          code: "authorization-code",
          responseMode: "json",
        },
      }),
      [200],
    );
    return { authorizationUrl, location: callback.body.redirectUrl };
  };
  const authorize = async () => {
    const authorizationUrl = await startOauth();
    return await finishOauth(authorizationUrl);
  };
  return {
    bot,
    managedConnectorId: managed?.id,
    startOauth,
    finishOauth,
    authorize,
    rejectedKey: () => {
      return rejectedKey;
    },
  };
}

type Reconnecting = Awaited<ReturnType<typeof connectWithRejectedWelcome>>;

function installationStatus(bot: Bot) {
  return accept(
    integrations(bot.platform).getStatus({ headers: signIn(bot.admin) }),
    [200],
  );
}

/** The admin connects the user once; the welcome DM is rejected. */
async function connectOnce({ bot, authorize }: Reconnecting) {
  const published = feishuChanged(bot.admin);
  const before = bot.sent.length;
  const first = await authorize();
  const [, status] = await Promise.all([
    flushWaitUntilForTest(),
    installationStatus(bot),
  ]);
  return {
    scopes: first.authorizationUrl.searchParams.get("scope")?.split(" "),
    location: first.location,
    published: feishuChanged(bot.admin) - published,
    connectedUserName: status.body.installations?.[0]?.connectedUserName,
    replies: contents(bot.sent.slice(before)),
  };
}

/** Connect, grant a member permission, then connect again. */
async function permissionsAfterReconnect({
  bot,
  managedConnectorId,
  startOauth,
  finishOauth,
}: Reconnecting) {
  if (!managedConnectorId) {
    throw new Error("Expected managedConnectorId");
  }
  const target = {
    kind: "custom" as const,
    customConnectorId: managedConnectorId,
  };
  const [firstUrl, reconnectUrl] = await Promise.all([
    startOauth(),
    startOauth(),
  ]);
  await finishOauth(firstUrl);
  const granted = await accept(
    app(connectorPermissionsContract).apply({
      headers: signIn(bot.admin),
      body: {
        target,
        mode: "patch",
        grants: [
          {
            permission: "messages:send-as-user",
            action: "allow",
            expiresIn: "1h",
          },
        ],
      },
    }),
    [200],
  );
  await finishOauth(reconnectUrl);
  const [, permissions] = await Promise.all([
    flushWaitUntilForTest(),
    accept(
      app(connectorPermissionsContract).get({
        headers: signIn(bot.admin),
        query: target,
      }),
      [200],
    ),
  ]);
  return { granted: granted.body.grants, kept: permissions.body.grants };
}

async function welcomeAfterReconnect({
  bot,
  startOauth,
  finishOauth,
  rejectedKey,
}: Reconnecting) {
  const [firstUrl, reconnectUrl] = await Promise.all([
    startOauth(),
    startOauth(),
  ]);
  await finishOauth(firstUrl);
  await flushWaitUntilForTest();
  const before = bot.sent.length;
  await finishOauth(reconnectUrl);
  await flushWaitUntilForTest();
  return {
    welcome: bot.sent.slice(before),
    rejectedKey: rejectedKey(),
  };
}

async function statusAfterReconnect({
  bot,
  startOauth,
  finishOauth,
}: Reconnecting) {
  const [firstUrl, reconnectUrl] = await Promise.all([
    startOauth(),
    startOauth(),
  ]);
  await finishOauth(firstUrl);
  await finishOauth(reconnectUrl);
  const [, status] = await Promise.all([
    flushWaitUntilForTest(),
    installationStatus(bot),
  ]);
  return status.body.installations?.[0];
}

describe("lark integration", () => {
  it("feishu-branding-connection-016 (1/3) answers a connected user's help with the provider bot name", async () => {
    const bot = await installedBot("lark");
    await connectSender(bot);
    const before = bot.sent.length;

    await deliver(bot, directMessage(bot, "/help"));

    expect(contents(bot.sent.slice(before))).toContain(
      "Owner Managed Bot commands",
    );
  });

  it("feishu-branding-connection-016 (2/3) tells a connected user they are already connected to Okou", async () => {
    const bot = await installedBot("lark");
    await connectSender(bot);
    const before = bot.sent.length;

    await deliver(bot, directMessage(bot, "/connect"));

    expect(contents(bot.sent.slice(before))).toContain(
      "Your Lark account is already connected to Okou",
    );
  });

  it("feishu-branding-connection-016 (3/3) removes the connected Lark installation", async () => {
    const bot = await installedBot("lark");
    await connectSender(bot);

    const removed = await removeInstallation(bot);

    expect(removed.status).toBe(200);
  });

  it("feishu-branding-connection-026 (1/4) connects through Lark OAuth without delivering the rejected welcome", async () => {
    const reconnecting = await connectWithRejectedWelcome("lark");

    const connected = await connectOnce(reconnecting);

    expect(connected.scopes).toStrictEqual([...FEISHU_OAUTH_SCOPES]);
    expect(connected.location).toBe(
      `https://applink.larksuite.com/client/bot/open?appId=${reconnecting.bot.appId}`,
    );
    expect(connected.published).toBeGreaterThan(0);
    expect(connected.connectedUserName).toBe("Feishu User");
    expect(connected.replies).not.toContain("You're connected!");
  });

  it("feishu-branding-connection-026 (2/4) keeps the granted member permissions after reconnecting", async () => {
    const reconnecting = await connectWithRejectedWelcome("lark", {
      loadManagedConnector: true,
    });

    const { granted, kept } = await permissionsAfterReconnect(reconnecting);

    expect(kept).toStrictEqual(granted);
    expect(kept).toMatchObject([
      { permission: "messages:send-as-user", action: "allow" },
    ]);
  });

  it("feishu-branding-connection-026 (3/4) retries the welcome card with the rejected idempotency key on reconnect", async () => {
    const reconnecting = await connectWithRejectedWelcome("lark");

    const { welcome, rejectedKey } = await welcomeAfterReconnect(reconnecting);

    expect(rejectedKey).toBeDefined();
    expect(welcome).toHaveLength(1);
    expect(welcome[0]).toMatchObject({
      path: "/open-apis/im/v1/messages",
      receiveId: "ou_feishu_user",
      msgType: "interactive",
      uuid: rejectedKey,
    });
    expect(welcome[0]?.content).toContain("Okou");
  });

  it("feishu-branding-connection-026 (4/4) reports the reconnected Lark installation status", async () => {
    const reconnecting = await connectWithRejectedWelcome("lark");

    const installation = await statusAfterReconnect(reconnecting);

    expect(installation).toMatchObject({
      appId: reconnecting.bot.appId,
      isConnected: true,
      connectedUserName: "Feishu User",
    });
  });

  it("feishu-branding-connection-023 deduplicates unconnected messages and sends one connect link", async () => {
    const bot = await installedBot("lark");
    const before = bot.sent.length;
    const published = feishuChanged(bot.admin);
    const event = directMessage(bot, "hello", { messageId: "om_fixed_hello" });

    const first = await deliver(bot, event);
    const second = await deliver(bot, event);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(feishuChanged(bot.admin)).toBeGreaterThan(published);
    const replies = bot.sent.slice(before);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      path: "/open-apis/im/v1/messages/om_fixed_hello/reply",
      msgType: "interactive",
      replyInThread: true,
    });
    expect(replies[0]?.content).toContain("Connect your account");
    expect(replies[0]?.content).toContain(
      "To use Okou in Lark, please connect your account first.",
    );
    const link = firstUrlIn(replies);
    expect(`${link.origin}${link.pathname}`).toBe(
      "https://app.okou.ai/settings/lark",
    );
  });
});
