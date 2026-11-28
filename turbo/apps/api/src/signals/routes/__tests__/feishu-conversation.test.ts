import {
  createCipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { createStore } from "ccstate";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { array, object, optional, string } from "zod";
import { feishuBrowserConnectContract } from "@okouai/api-contracts/contracts/feishu-browser-connect";
import { feishuConnectContract } from "@okouai/api-contracts/contracts/feishu-connect";
import { feishuOauthContract } from "@okouai/api-contracts/contracts/feishu-oauth";
import { logsListContract } from "@okouai/api-contracts/contracts/logs";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { feishuBrowserConnectRoutes } from "../feishu-browser-connect";
import { feishuConnectRoutes } from "../feishu-connect";
import { feishuEventsRoutes } from "../feishu-events";
import { feishuOauthRoutes } from "../feishu-oauth";
import { logsRoutes } from "../logs";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const SESSION = Object.freeze({ authorization: "Bearer clerk-session" });
const APP_URL = "https://app.okou.ai";
const FEISHU_API = "https://open.feishu.cn";

const app = setupApp({
  context,
  routes: [
    ...feishuConnectRoutes,
    ...feishuBrowserConnectRoutes,
    ...feishuOauthRoutes,
    ...logsRoutes,
  ],
});

interface Actor {
  readonly userId: string;
  readonly orgId: string;
  readonly role: "org:admin" | "org:member";
}

function signIn(actor: Actor) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.role,
  );
  return SESSION;
}

const outboundSchema = object({
  msg_type: string(),
  content: string(),
});

const cardSchema = object({
  body: object({
    elements: array(
      object({
        behaviors: optional(
          array(
            object({
              default_url: optional(string()),
            }),
          ),
        ),
      }),
    ),
  }),
});

interface OutboundReply {
  readonly msgType: string;
  readonly content: string;
}

interface InstalledFeishuBot {
  readonly admin: Actor;
  readonly appId: string;
  readonly botOpenId: string;
  readonly installationId: string;
  readonly callbackUrl: string;
  readonly verificationToken: string;
  readonly encryptKey: string;
  readonly sent: OutboundReply[];
}

function encryptPayload(encryptKey: string, payload: unknown): string {
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

async function deliverEvent(bot: InstalledFeishuBot, payload: unknown) {
  const body = encryptPayload(bot.encryptKey, payload);
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

async function installFeishuBot(): Promise<InstalledFeishuBot> {
  mockEnv("APP_URL", APP_URL);
  const orgId = `org_${randomUUID()}`;
  const admin: Actor = {
    userId: `user_${randomUUID()}`,
    orgId,
    role: "org:admin",
  };
  await createStore().set(
    seedOrgMembership$,
    {
      userId: admin.userId,
      orgId: admin.orgId,
      role: "admin",
      name: "Feishu workspace",
    },
    context.signal,
  );

  const botOpenId = `ou_bot_${randomUUID()}`;
  const sent: OutboundReply[] = [];
  const recordOutbound = async (request: Request) => {
    const parsed = outboundSchema.parse(await request.json());
    sent.push({ msgType: parsed.msg_type, content: parsed.content });
    return HttpResponse.json({
      code: 0,
      data: { message_id: `om_${randomUUID()}`, chat_id: "oc_feishu_group" },
    });
  };

  server.use(
    http.post(
      `${FEISHU_API}/open-apis/auth/v3/tenant_access_token/internal`,
      () => {
        return HttpResponse.json({
          code: 0,
          tenant_access_token: `tenant-${randomUUID()}`,
          expire: 7200,
        });
      },
    ),
    http.get(`${FEISHU_API}/open-apis/bot/v3/info`, () => {
      return HttpResponse.json({
        code: 0,
        bot: { open_id: botOpenId, app_name: "Okou Feishu" },
      });
    }),
    http.post(`${FEISHU_API}/open-apis/im/v1/messages`, ({ request }) => {
      return recordOutbound(request);
    }),
    http.post(
      `${FEISHU_API}/open-apis/im/v1/messages/:messageId/reply`,
      ({ request }) => {
        return recordOutbound(request);
      },
    ),
  );

  context.mocks.s3.send.mockResolvedValue({ ETag: "fixture-etag" });
  await updateFeatureSwitchesForUser(context, admin, {
    [FeatureSwitchKey.FeishuIntegration]: true,
  });

  const appId = `cli_${randomUUID()}`;
  const verificationToken = `token-${randomUUID()}`;
  const encryptKey = `encrypt-${randomUUID()}`;

  const configured = await accept(
    app(feishuConnectContract).setup({
      headers: signIn(admin),
      body: { appId, appSecret: "app-secret", verificationToken, encryptKey },
    }),
    [200],
  );
  const { installationId, callbackUrl } = configured.body;
  if (!installationId || !callbackUrl) {
    throw new Error("Expected a configured Feishu installation");
  }
  await accept(
    app(feishuConnectContract).updateInstallation({
      headers: signIn(admin),
      params: { installationId },
      body: { setupCompleted: true },
    }),
    [200],
  );

  return {
    admin,
    appId,
    botOpenId,
    installationId,
    callbackUrl,
    verificationToken,
    encryptKey,
    sent,
  };
}

function extractConnectUrl(reply: OutboundReply): URL {
  const card = cardSchema.parse(JSON.parse(reply.content));
  for (const element of card.body.elements) {
    for (const behavior of element.behaviors ?? []) {
      if (behavior.default_url) {
        return new URL(behavior.default_url);
      }
    }
  }
  throw new Error("Expected a connect URL inside the Feishu interactive card");
}

async function completeConnectFromCard(
  actor: Actor,
  openId: string,
  connectUrl: URL,
): Promise<void> {
  server.use(
    http.post(`${FEISHU_API}/open-apis/authen/v2/oauth/token`, () => {
      return HttpResponse.json({
        code: 0,
        access_token: `access-${randomUUID()}`,
        refresh_token: `refresh-${randomUUID()}`,
        expires_in: 7200,
      });
    }),
    http.get(`${FEISHU_API}/open-apis/authen/v1/user_info`, () => {
      return HttpResponse.json({
        code: 0,
        data: {
          open_id: openId,
          name: "Feishu Member",
          tenant_key: "tenant_feishu",
        },
      });
    }),
  );

  const linkBody = {
    installationId: connectUrl.searchParams.get("installationId") ?? "",
    openId: connectUrl.searchParams.get("openId") ?? "",
    chatId: connectUrl.searchParams.get("chatId") ?? "",
    ts: Number(connectUrl.searchParams.get("ts")),
    sig: connectUrl.searchParams.get("sig") ?? "",
  };
  const connected = await accept(
    app(feishuBrowserConnectContract).connectFromApp({
      headers: signIn(actor),
      body: linkBody,
    }),
    [200],
  );
  const authorizationUrl = new URL(connected.body.openUrl);
  await accept(
    app(feishuOauthContract).callback({
      query: {
        state: authorizationUrl.searchParams.get("state") ?? "",
        code: `code-${randomUUID()}`,
        responseMode: "json",
      },
    }),
    [200],
  );
}

function messageEnvelope(
  bot: InstalledFeishuBot,
  event: {
    readonly openId: string;
    readonly senderType?: string;
    readonly chatId: string;
    readonly chatType: string;
    readonly messageType: string;
    readonly content: string;
    readonly mentions?: readonly {
      readonly key: string;
      readonly openId: string;
      readonly name: string;
    }[];
  },
) {
  return {
    schema: "2.0",
    header: {
      event_id: randomUUID(),
      event_type: "im.message.receive_v1",
      tenant_key: "tenant_feishu",
      app_id: bot.appId,
      token: bot.verificationToken,
    },
    event: {
      sender: {
        sender_id: { open_id: event.openId },
        sender_type: event.senderType ?? "user",
      },
      message: {
        message_id: `om_${randomUUID()}`,
        chat_id: event.chatId,
        chat_type: event.chatType,
        message_type: event.messageType,
        content: event.content,
        mentions: event.mentions?.map((mention) => {
          return {
            key: mention.key,
            id: { open_id: mention.openId },
            name: mention.name,
          };
        }),
      },
    },
  };
}

async function listActiveRunPrompts(actor: Actor): Promise<string[]> {
  const listed = await accept(
    app(logsListContract).list({
      headers: signIn(actor),
      query: { limit: 50 },
    }),
    [200],
  );
  return listed.body.data
    .filter((entry) => {
      return entry.status === "pending" || entry.status === "running";
    })
    .map((entry) => {
      return entry.prompt;
    });
}

async function setupMember(orgId: string): Promise<Actor> {
  const member: Actor = {
    userId: `user_${randomUUID()}`,
    orgId,
    role: "org:member",
  };
  await createStore().set(
    seedOrgMembership$,
    {
      userId: member.userId,
      orgId: member.orgId,
      role: "member",
      name: "Feishu workspace",
    },
    context.signal,
  );
  await updateFeatureSwitchesForUser(context, member, {
    [FeatureSwitchKey.FeishuIntegration]: true,
  });
  return member;
}

describe("feishu conversation", () => {
  it("feishu-conversation-006 ignores unmentioned group messages, app messages and system notifications", async () => {
    const bot = await installFeishuBot();
    const adminOpenId = "ou_feishu_user";

    const beforeConnect = bot.sent.length;
    const promptConnect = await deliverEvent(
      bot,
      messageEnvelope(bot, {
        openId: adminOpenId,
        chatId: "oc_feishu_dm",
        chatType: "p2p",
        messageType: "text",
        content: JSON.stringify({ text: "hello" }),
      }),
    );
    expect(promptConnect.status).toBe(200);
    const connectCard = bot.sent[beforeConnect];
    if (!connectCard) {
      throw new Error("Expected connect card for unconnected Feishu admin");
    }
    await completeConnectFromCard(
      bot.admin,
      adminOpenId,
      extractConnectUrl(connectCard),
    );

    const unmentionedGroup = await deliverEvent(
      bot,
      messageEnvelope(bot, {
        openId: adminOpenId,
        chatId: "oc_feishu_group",
        chatType: "group",
        messageType: "text",
        content: JSON.stringify({ text: "ignore unmentioned group message" }),
      }),
    );
    const otherBotMention = await deliverEvent(
      bot,
      messageEnvelope(bot, {
        openId: adminOpenId,
        chatId: "oc_feishu_group",
        chatType: "group",
        messageType: "text",
        content: JSON.stringify({
          text: "@_user_1 ignore another bot mention",
        }),
        mentions: [
          { key: "@_user_1", openId: "ou_another_bot", name: "OtherBot" },
        ],
      }),
    );
    const appAuthored = await deliverEvent(
      bot,
      messageEnvelope(bot, {
        openId: adminOpenId,
        senderType: "app",
        chatId: "oc_feishu_group",
        chatType: "group",
        messageType: "text",
        content: JSON.stringify({ text: "@_user_1 ignore app message" }),
        mentions: [{ key: "@_user_1", openId: bot.botOpenId, name: "Nova" }],
      }),
    );
    const systemNotification = await deliverEvent(
      bot,
      messageEnvelope(bot, {
        openId: adminOpenId,
        chatId: "oc_feishu_dm",
        chatType: "p2p",
        messageType: "system",
        content: JSON.stringify({ text: "ignore system notification" }),
      }),
    );

    expect(unmentionedGroup.status).toBe(200);
    expect(otherBotMention.status).toBe(200);
    expect(appAuthored.status).toBe(200);
    expect(systemNotification.status).toBe(200);

    const activePrompts = await listActiveRunPrompts(bot.admin);
    expect(
      activePrompts.some((prompt) => {
        return prompt.includes("ignore ");
      }),
    ).toBeFalsy();
  });

  it("feishu-conversation-004 (1/2) prompts unconnected group mentions to connect without starting a run", async () => {
    const bot = await installFeishuBot();
    const memberOpenId = "ou_feishu_canonical_group_user";
    const member = await setupMember(bot.admin.orgId);

    const beforeFirst = bot.sent.length;
    const unconnectedMention = await deliverEvent(
      bot,
      messageEnvelope(bot, {
        openId: memberOpenId,
        chatId: "oc_feishu_group",
        chatType: "group",
        messageType: "text",
        content: JSON.stringify({ text: "@_user_1 unconnected group task" }),
        mentions: [{ key: "@_user_1", openId: bot.botOpenId, name: "Nova" }],
      }),
    );
    expect(unconnectedMention.status).toBe(200);

    const firstReplies = bot.sent.slice(beforeFirst);
    expect(
      firstReplies.some((reply) => {
        return reply.content.includes("Connect your account");
      }),
    ).toBeTruthy();

    const activePrompts = await listActiveRunPrompts(member);
    expect(activePrompts).not.toContain("@Nova unconnected group task");
  });

  it("feishu-conversation-004 (2/2) answers connected group /help mentions without starting a run", async () => {
    const bot = await installFeishuBot();
    const memberOpenId = "ou_feishu_canonical_group_user";
    const member = await setupMember(bot.admin.orgId);

    const beforeConnect = bot.sent.length;
    const promptConnect = await deliverEvent(
      bot,
      messageEnvelope(bot, {
        openId: memberOpenId,
        chatId: "oc_feishu_group",
        chatType: "group",
        messageType: "text",
        content: JSON.stringify({ text: "@_user_1 unconnected group task" }),
        mentions: [{ key: "@_user_1", openId: bot.botOpenId, name: "Nova" }],
      }),
    );
    expect(promptConnect.status).toBe(200);
    const connectReply = bot.sent.slice(beforeConnect).find((reply) => {
      return reply.content.includes("Connect your account");
    });
    if (!connectReply) {
      throw new Error("Expected a Connect your account reply");
    }

    await completeConnectFromCard(
      member,
      memberOpenId,
      extractConnectUrl(connectReply),
    );

    const beforeHelp = bot.sent.length;
    const helpMention = await deliverEvent(
      bot,
      messageEnvelope(bot, {
        openId: memberOpenId,
        chatId: "oc_feishu_group",
        chatType: "group",
        messageType: "text",
        content: JSON.stringify({ text: "@_user_1 /help" }),
        mentions: [{ key: "@_user_1", openId: bot.botOpenId, name: "Nova" }],
      }),
    );
    expect(helpMention.status).toBe(200);

    const helpReplies = bot.sent.slice(beforeHelp);
    expect(
      helpReplies.some((reply) => {
        return reply.content.includes("Okou Feishu commands");
      }),
    ).toBeTruthy();

    const activePrompts = await listActiveRunPrompts(member);
    expect(activePrompts).not.toContain("@Nova /help");
  });
});
