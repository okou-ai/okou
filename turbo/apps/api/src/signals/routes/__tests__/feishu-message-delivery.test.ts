import {
  createCipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { customConnectorsContract } from "@okouai/api-contracts/contracts/custom-connectors";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { feishuBrowserConnectContract } from "@okouai/api-contracts/contracts/feishu-browser-connect";
import {
  feishuConnectContract,
  larkConnectContract,
} from "@okouai/api-contracts/contracts/feishu-connect";
import { feishuOauthContract } from "@okouai/api-contracts/contracts/feishu-oauth";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { customConnectorsRoutes } from "../custom-connectors";
import { featureSwitchesRoutes } from "../feature-switches";
import { feishuBrowserConnectRoutes } from "../feishu-browser-connect";
import { feishuConnectRoutes } from "../feishu-connect";
import { feishuEventsRoutes } from "../feishu-events";
import { feishuOauthRoutes } from "../feishu-oauth";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

const feishuConnectClient = setupApp({
  context,
  routes: feishuConnectRoutes,
})(feishuConnectContract);
const larkConnectClient = setupApp({
  context,
  routes: feishuConnectRoutes,
})(larkConnectContract);
const feishuBrowserClient = setupApp({
  context,
  routes: feishuBrowserConnectRoutes,
})(feishuBrowserConnectContract);
const feishuOauthClient = setupApp({
  context,
  routes: feishuOauthRoutes,
})(feishuOauthContract);
const customConnectorsClient = setupApp({
  context,
  routes: customConnectorsRoutes,
})(customConnectorsContract);
const featureSwitchClient = setupApp({
  context,
  routes: featureSwitchesRoutes,
})(featureSwitchesContract);
const feishuEventsRequest = setupRawAppRequest({
  context,
  routes: feishuEventsRoutes,
});
const feishuBrowserRawRequest = setupRawAppRequest({
  context,
  routes: feishuBrowserConnectRoutes,
});

type Platform = "feishu" | "lark";

function platformConfig(platform: Platform) {
  if (platform === "feishu") {
    return {
      client: feishuConnectClient,
      apiOrigin: "https://open.feishu.cn",
      featureSwitch: FeatureSwitchKey.FeishuIntegration,
    };
  }
  return {
    client: larkConnectClient,
    apiOrigin: "https://open.larksuite.com",
    featureSwitch: FeatureSwitchKey.LarkIntegration,
  };
}

interface Actor {
  readonly userId: string;
  readonly orgId: string;
}

interface SentMessage {
  readonly url: string;
  readonly body: unknown;
}

function signIn(actor: Actor) {
  createRouteMocks(context).clerk.session(actor.userId, actor.orgId);
  return { authorization: "Bearer clerk-session" } as const;
}

function stripPrefix(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

/** Feishu's Open Platform as seen by Okou; outbound messages are captured. */
function mockFeishuPlatform(platform: Platform, tenantKey: string) {
  const origin = platformConfig(platform).apiOrigin;
  const sent: SentMessage[] = [];
  server.use(
    http.post(
      `${origin}/open-apis/auth/v3/tenant_access_token/internal`,
      () => {
        return HttpResponse.json({
          code: 0,
          tenant_access_token: `tenant-${randomUUID()}`,
          expire: 7200,
        });
      },
    ),
    http.get(`${origin}/open-apis/bot/v3/info`, () => {
      return HttpResponse.json({
        code: 0,
        bot: { open_id: "ou_bot", app_name: "Okou Bot", avatar_url: "" },
      });
    }),
    http.post(
      `${origin}/open-apis/authen/v2/oauth/token`,
      async ({ request }) => {
        const body: unknown = await request.json();
        const code =
          typeof body === "object" && body !== null && "code" in body
            ? String(body.code)
            : "";
        return HttpResponse.json({
          code: 0,
          access_token: `uat-${stripPrefix(code, "code-")}`,
          refresh_token: `urt-${randomUUID()}`,
          expires_in: 7200,
        });
      },
    ),
    http.get(`${origin}/open-apis/authen/v1/user_info`, ({ request }) => {
      const auth = request.headers.get("authorization") ?? "";
      const openId = stripPrefix(auth, "Bearer uat-");
      return HttpResponse.json({
        code: 0,
        data: { name: "Feishu Member", open_id: openId, tenant_key: tenantKey },
      });
    }),
    http.post(`${origin}/open-apis/im/v1/messages`, async ({ request }) => {
      sent.push({ url: request.url, body: await request.json() });
      return HttpResponse.json({
        code: 0,
        data: { message_id: `om_${randomUUID()}` },
      });
    }),
    http.post(
      `${origin}/open-apis/im/v1/messages/:messageId/reply`,
      async ({ request }) => {
        sent.push({ url: request.url, body: await request.json() });
        return HttpResponse.json({
          code: 0,
          data: { message_id: `om_${randomUUID()}` },
        });
      },
    ),
  );
  return { sent };
}

function findUrlInCard(
  value: unknown,
  expectedOpenId?: string,
): string | undefined {
  if (typeof value === "string") {
    if (value.startsWith("http://") || value.startsWith("https://")) {
      const parsed = new URL(value);
      if (
        parsed.searchParams.has("installationId") &&
        (expectedOpenId === undefined ||
          parsed.searchParams.get("openId") === expectedOpenId)
      ) {
        return value;
      }
    }
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findUrlInCard(item, expectedOpenId);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) {
      const found = findUrlInCard(entry, expectedOpenId);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

/** Reads the signed connection link out of the bot's connection prompt card. */
function connectionToken(
  messages: readonly SentMessage[],
  expectedOpenId?: string,
) {
  for (const message of messages) {
    if (
      typeof message.body === "object" &&
      message.body !== null &&
      "content" in message.body &&
      typeof message.body.content === "string"
    ) {
      const card: unknown = JSON.parse(message.body.content);
      const found = findUrlInCard(card, expectedOpenId);
      if (found) {
        const params = new URL(found).searchParams;
        const value = (name: string) => {
          const param = params.get(name);
          if (!param) {
            throw new Error(`Expected ${name} in the connection link`);
          }
          return param;
        };
        return {
          installationId: value("installationId"),
          openId: value("openId"),
          chatId: value("chatId"),
          ts: Number(value("ts")),
          sig: value("sig"),
        };
      }
    }
  }
  throw new Error(
    `Expected a connection prompt, got ${JSON.stringify(messages)}`,
  );
}

/** A configured custom app whose events are encrypted with its Encrypt Key. */
async function configuredBot(platform: Platform) {
  const admin = {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
  };
  const config = platformConfig(platform);
  await accept(
    featureSwitchClient.update({
      headers: signIn(admin),
      body: { switches: { [config.featureSwitch]: true } },
    }),
    [200],
  );
  context.mocks.s3.send.mockResolvedValue({ ETag: "fixture-etag" });
  mockEnv("FEISHU_CALLBACK_BASE_URL", "https://tunnel-feishu.okou.test");
  const tenantKey = `tenant_${randomUUID()}`;
  const provider = mockFeishuPlatform(platform, tenantKey);
  const app = {
    appId: `cli_${randomUUID()}`,
    appSecret: "app-secret",
    verificationToken: `token-${randomUUID()}`,
    encryptKey: randomBytes(16).toString("hex"),
  };
  const created = await accept(
    config.client.setup({ headers: signIn(admin), body: app }),
    [200],
  );
  const { callbackUrl, installationId } = created.body;
  if (!callbackUrl || !installationId) {
    throw new Error("Expected a configured Feishu installation");
  }
  const callbackPath = new URL(callbackUrl).pathname;

  await accept(
    config.client.updateInstallation({
      headers: signIn(admin),
      params: { installationId },
      body: { setupCompleted: true },
    }),
    [200],
  );

  async function post(event: Readonly<Record<string, unknown>>) {
    const iv = randomBytes(16);
    const cipher = createCipheriv(
      "aes-256-cbc",
      createHash("sha256").update(app.encryptKey).digest(),
      iv,
    );
    const encrypt = Buffer.concat([
      iv,
      cipher.update(JSON.stringify(event), "utf8"),
      cipher.final(),
    ]).toString("base64");
    const body = JSON.stringify({ encrypt });
    const timestamp = String(Math.floor(now() / 1000));
    const nonce = randomUUID();
    const signature = createHash("sha256")
      .update(`${timestamp}${nonce}${app.encryptKey}${body}`)
      .digest("hex");
    const response = await feishuEventsRequest(callbackPath, {
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

  async function dmMessages(openId: string, text: string) {
    const before = provider.sent.length;
    const response = await post({
      schema: "2.0",
      header: {
        event_id: randomUUID(),
        event_type: "im.message.receive_v1",
        tenant_key: tenantKey,
        app_id: app.appId,
        token: app.verificationToken,
      },
      event: {
        sender: { sender_id: { open_id: openId }, sender_type: "user" },
        message: {
          message_id: `om_${randomUUID()}`,
          chat_id: `oc_${openId}`,
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text }),
        },
      },
    });
    expect(response.status).toBe(200);
    return provider.sent.slice(before);
  }

  async function dm(openId: string, text: string) {
    return JSON.stringify(await dmMessages(openId, text));
  }

  return {
    admin,
    app,
    client: config.client,
    provider,
    tenantKey,
    dm,
    dmMessages,
  };
}

/** Feishu returns the user to Okou with a code for `openId`. */
async function completeOauth(authorizationUrl: string, openId: string) {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected Feishu OAuth state");
  }
  const response = await accept(
    feishuOauthClient.callback({
      query: { code: `code-${openId}`, state, responseMode: "json" },
    }),
    [200],
  );
  return response.body.redirectUrl;
}

/** The workspace user connects their Feishu identity from the product app. */
async function connectedMember(platform: Platform) {
  const bot = await configuredBot(platform);
  const openId = `ou_${randomUUID()}`;
  const token = connectionToken(await bot.dmMessages(openId, "hello"));
  const started = await accept(
    feishuBrowserClient.connectFromApp({
      headers: signIn(bot.admin),
      body: token,
    }),
    [200],
  );
  await completeOauth(started.body.openUrl, openId);
  return { ...bot, openId, token };
}

/** Another workspace member completes OAuth with the already-bound identity. */
async function rebindAttempt(platform: Platform) {
  const member = await connectedMember(platform);
  const other = { userId: `user_${randomUUID()}`, orgId: member.admin.orgId };
  const started = await accept(
    feishuBrowserClient.connectFromApp({
      headers: signIn(other),
      body: member.token,
    }),
    [200],
  );
  return await completeOauth(started.body.openUrl, member.openId);
}

async function managedConnectorIds(member: { readonly admin: Actor }) {
  const response = await accept(
    customConnectorsClient.list({ headers: signIn(member.admin) }),
    [200],
  );
  return response.body.connectors.map((connector) => {
    return connector.id;
  });
}

/** The owner connects a new identity through its legacy browser link. */
async function replaceIdentityFromToken(
  member: Awaited<ReturnType<typeof connectedMember>>,
  newOpenId: string,
  token: ReturnType<typeof connectionToken>,
) {
  const legacy = await feishuBrowserRawRequest(
    `/api/feishu/connect?${new URLSearchParams({ ...token, ts: String(token.ts) }).toString()}`,
    { method: "GET", headers: signIn(member.admin) },
  );
  const location = legacy.headers.get("location") ?? "";
  const redirect = await completeOauth(location, newOpenId);
  return { newOpenId, legacyStatus: legacy.status, location, redirect };
}

async function replacedMember(platform: Platform) {
  const bot = await configuredBot(platform);
  const openId = `ou_${randomUUID()}`;
  const newOpenId = `ou_${randomUUID()}`;
  const [firstPrompt, secondPrompt] = await Promise.all([
    bot.dmMessages(openId, "hello"),
    bot.dmMessages(newOpenId, "hello"),
  ]);
  const token = connectionToken(firstPrompt, openId);
  const started = await accept(
    feishuBrowserClient.connectFromApp({
      headers: signIn(bot.admin),
      body: token,
    }),
    [200],
  );
  await completeOauth(started.body.openUrl, openId);
  const member = { ...bot, openId, token };
  const replacement = await replaceIdentityFromToken(
    member,
    newOpenId,
    connectionToken(secondPrompt, newOpenId),
  );
  return { ...member, ...replacement };
}

/** The bot's reply to one DM command from a connected member. */
async function commandReply(
  platform: Platform,
  command: string,
  given: "connected" | "disconnected" = "connected",
) {
  const member = await connectedMember(platform);
  if (given === "disconnected") {
    await member.dm(member.openId, "/disconnect");
  }
  return await member.dm(member.openId, command);
}

async function statusAfterDisconnect(platform: Platform) {
  const member = await connectedMember(platform);
  await member.dm(member.openId, "/disconnect");
  const status = await accept(
    member.client.getStatus({ headers: signIn(member.admin) }),
    [200],
  );
  return status.body;
}

describe("feishu integration", () => {
  it("feishu-message-delivery-003 (1/6) answers /help with text command help", async () => {
    await expect(commandReply("feishu", "/help")).resolves.toContain(
      "Okou Bot commands",
    );
  });

  it("feishu-message-delivery-003 (2/6) answers /connect with already connected", async () => {
    await expect(commandReply("feishu", "/connect")).resolves.toContain(
      "Already connected",
    );
  });

  it("feishu-message-delivery-003 (3/6) answers an unknown command with text command help", async () => {
    await expect(commandReply("feishu", "/unknown")).resolves.toContain(
      "Okou Bot commands",
    );
  });

  it("feishu-message-delivery-003 (4/6) confirms the first disconnect", async () => {
    await expect(commandReply("feishu", "/disconnect")).resolves.toContain(
      "has been disconnected",
    );
  });

  it("feishu-message-delivery-003 (5/6) reports a second disconnect as not connected", async () => {
    await expect(
      commandReply("feishu", "/disconnect", "disconnected"),
    ).resolves.toContain("You are not connected.");
  });

  it("feishu-message-delivery-003 (6/6) keeps the installation while the current user is disconnected", async () => {
    await expect(statusAfterDisconnect("feishu")).resolves.toMatchObject({
      isInstalled: true,
      isConnected: false,
    });
  });
});

describe("lark integration", () => {
  it("feishu-message-delivery-011 (1/6) answers /help with text command help", async () => {
    await expect(commandReply("lark", "/help")).resolves.toContain(
      "Okou Bot commands",
    );
  });

  it("feishu-message-delivery-011 (2/6) answers /connect with already connected", async () => {
    await expect(commandReply("lark", "/connect")).resolves.toContain(
      "Already connected",
    );
  });

  it("feishu-message-delivery-011 (3/6) answers an unknown command with text command help", async () => {
    await expect(commandReply("lark", "/unknown")).resolves.toContain(
      "Okou Bot commands",
    );
  });

  it("feishu-message-delivery-011 (4/6) confirms the first disconnect", async () => {
    await expect(commandReply("lark", "/disconnect")).resolves.toContain(
      "has been disconnected",
    );
  });

  it("feishu-message-delivery-011 (5/6) reports a second disconnect as not connected", async () => {
    await expect(
      commandReply("lark", "/disconnect", "disconnected"),
    ).resolves.toContain("You are not connected.");
  });

  it("feishu-message-delivery-011 (6/6) keeps the installation while the current user is disconnected", async () => {
    await expect(statusAfterDisconnect("lark")).resolves.toMatchObject({
      isInstalled: true,
      isConnected: false,
    });
  });
});

describe("feishu identity replacement", () => {
  it("feishu-message-delivery-002 (1/5) rejects another member rebinding the connected Feishu account", async () => {
    const redirect = new URL(await rebindAttempt("feishu"));

    expect(redirect.pathname).toBe("/settings/feishu");
    expect(redirect.searchParams.get("error")).toBe(
      "This Feishu account is already connected.",
    );
  });

  it("feishu-message-delivery-002 (2/5) replaces the identity through the legacy link and keeps the managed connector", async () => {
    const member = await connectedMember("feishu");
    const newOpenId = `ou_${randomUUID()}`;
    const [before, promptMessages] = await Promise.all([
      managedConnectorIds(member),
      member.dmMessages(newOpenId, "hello"),
    ]);

    const replacement = await replaceIdentityFromToken(
      member,
      newOpenId,
      connectionToken(promptMessages),
    );

    expect(replacement.legacyStatus).toBe(307);
    expect(new URL(replacement.location).origin).toBe(
      "https://accounts.feishu.cn",
    );
    expect(new URL(replacement.redirect).searchParams.get("error")).toBeNull();
    await expect(managedConnectorIds(member)).resolves.toStrictEqual(before);
  });

  it("feishu-message-delivery-002 (3/5) prompts the replaced identity to connect", async () => {
    const member = await replacedMember("feishu");

    const reply = await member.dm(member.openId, "hello");

    expect(reply).toContain("Connect your account");
  });

  it("feishu-message-delivery-002 (4/5) gives the new identity command help", async () => {
    const member = await replacedMember("feishu");

    const reply = await member.dm(member.newOpenId, "/help");

    expect(reply).toContain("Okou Bot commands");
  });

  it("feishu-message-delivery-002 (5/5) keeps the installation connected and verified for the original app and tenant", async () => {
    const member = await replacedMember("feishu");

    const status = await accept(
      member.client.getStatus({ headers: signIn(member.admin) }),
      [200],
    );

    expect(status.body).toMatchObject({
      isInstalled: true,
      isConnected: true,
      callbackVerified: true,
      appId: member.app.appId,
      tenantKey: member.tenantKey,
    });
  });
});

describe("lark identity replacement", () => {
  it("feishu-message-delivery-010 (1/5) rejects another member rebinding the connected Lark account", async () => {
    const redirect = new URL(await rebindAttempt("lark"));

    expect(redirect.pathname).toBe("/settings/lark");
    expect(redirect.searchParams.get("error")).toBe(
      "This Lark account is already connected.",
    );
  });

  it("feishu-message-delivery-010 (2/5) replaces the identity through the legacy link and keeps the managed connector", async () => {
    const bot = await configuredBot("lark");
    const openId = `ou_${randomUUID()}`;
    const newOpenId = `ou_${randomUUID()}`;
    const [firstPrompt, secondPrompt] = await Promise.all([
      bot.dmMessages(openId, "hello"),
      bot.dmMessages(newOpenId, "hello"),
    ]);
    const token = connectionToken(firstPrompt, openId);
    const started = await accept(
      feishuBrowserClient.connectFromApp({
        headers: signIn(bot.admin),
        body: token,
      }),
      [200],
    );
    await completeOauth(started.body.openUrl, openId);
    const member = { ...bot, openId, token };
    const before = await managedConnectorIds(member);

    const replacement = await replaceIdentityFromToken(
      member,
      newOpenId,
      connectionToken(secondPrompt, newOpenId),
    );

    expect(replacement.legacyStatus).toBe(307);
    expect(new URL(replacement.location).origin).toBe(
      "https://accounts.larksuite.com",
    );
    expect(new URL(replacement.redirect).searchParams.get("error")).toBeNull();
    await expect(managedConnectorIds(member)).resolves.toStrictEqual(before);
  });

  it("feishu-message-delivery-010 (3/5) prompts the replaced identity to connect", async () => {
    const member = await replacedMember("lark");

    const reply = await member.dm(member.openId, "hello");

    expect(reply).toContain("Connect your account");
  });

  it("feishu-message-delivery-010 (4/5) gives the new identity command help", async () => {
    const member = await replacedMember("lark");

    const reply = await member.dm(member.newOpenId, "/help");

    expect(reply).toContain("Okou Bot commands");
  });

  it("feishu-message-delivery-010 (5/5) keeps the installation connected and verified for the original app and tenant", async () => {
    const member = await replacedMember("lark");

    const status = await accept(
      member.client.getStatus({ headers: signIn(member.admin) }),
      [200],
    );

    expect(status.body).toMatchObject({
      isInstalled: true,
      isConnected: true,
      callbackVerified: true,
      appId: member.app.appId,
      tenantKey: member.tenantKey,
    });
  });
});
