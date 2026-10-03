import {
  createCipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
} from "node:crypto";

import type { ChatEvent } from "@okouai/api-contracts/contracts/chat-threads";
import { feishuConnectContract } from "@okouai/api-contracts/contracts/feishu-connect";
import { feishuOauthContract } from "@okouai/api-contracts/contracts/feishu-oauth";
import {
  integrationsTelegramContract,
  OFFICIAL_TELEGRAM_BOT_ID,
} from "@okouai/api-contracts/contracts/integrations-telegram";
import { teamsConnectContract } from "@okouai/api-contracts/contracts/teams-connect";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse, http } from "msw";
import { expect } from "vitest";
import { z } from "zod";

import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { createAppWithRoutes } from "../../../../app-factory-core";
import { mockEnv } from "../../../../lib/env";
import { now } from "../../../../lib/time";
import { server } from "../../../../mocks/server";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { feishuBrowserConnectRoutes } from "../../feishu-browser-connect";
import { feishuConnectRoutes } from "../../feishu-connect";
import { feishuEventsRoutes } from "../../feishu-events";
import { feishuOauthRoutes } from "../../feishu-oauth";
import { integrationsTelegramRoutes } from "../../integrations-telegram";
import { teamsConnectRoutes } from "../../teams-connect";
import { createBddApi, type ApiTestUser } from "./api-bdd";
import { createChatFilesBddApi } from "./api-bdd-chat-files";
import { createBddIntegrationApi } from "./api-bdd-integrations";
import { createRunReadsApi } from "./api-bdd-run-reads";
import { createRunsApi } from "./api-bdd-runs";
import { findPendingInputEventByText } from "./chat-event-test-reader";
import { updateFeatureSwitchesForUser } from "./feature-switches";
import { createRouteMocks } from "./route-test";
import { uniqueSlackUserId } from "./slack-public-install";
import {
  installTeamsForTest,
  postTeamsActivityForTest,
  removeTeamsForTest,
  setupTeamsConnectTestEnv,
  teamsConnectFixture,
  teamsMessageActivityForTest,
} from "./teams-connect";

type RegisterCleanup = (cleanup: () => Promise<void>) => void;

function authenticate(context: TestContext, actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}

async function connectFeishu(
  context: TestContext,
  actor: ApiTestUser & { readonly orgId: string },
  registerCleanup: RegisterCleanup,
) {
  const appId = `cli_${randomUUID()}`;
  const openId = `ou_${randomUUID()}`;
  const tenantKey = `tenant_${randomUUID()}`;
  const encryptKey = "annotation-feishu-encrypt-key";
  const verificationToken = "annotation-feishu-verification-token";
  const apiOrigin = "https://open.feishu.cn";
  const replies: string[] = [];
  mockEnv("APP_URL", "https://app.okou.ai");
  mockEnv("OKOU_WEB_URL", "https://app.okou.ai");
  mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
  mockEnv("FEISHU_CALLBACK_BASE_URL", "https://api.okou.ai");
  server.use(
    http.post(
      `${apiOrigin}/open-apis/auth/v3/tenant_access_token/internal`,
      () => {
        return HttpResponse.json({
          code: 0,
          tenant_access_token: "annotation-tenant-token",
          expire: 7200,
        });
      },
    ),
    http.get(`${apiOrigin}/open-apis/bot/v3/info`, () => {
      return HttpResponse.json({
        code: 0,
        bot: { open_id: `ou_bot_${appId}`, app_name: "Annotation bot" },
      });
    }),
    http.post(`${apiOrigin}/open-apis/authen/v2/oauth/token`, () => {
      return HttpResponse.json({
        code: 0,
        access_token: "annotation-feishu-token",
        refresh_token: "annotation-feishu-refresh",
        expires_in: 7200,
      });
    }),
    http.get(`${apiOrigin}/open-apis/authen/v1/user_info`, () => {
      return HttpResponse.json({
        code: 0,
        data: {
          name: "Annotation owner",
          open_id: openId,
          tenant_key: tenantKey,
        },
      });
    }),
    http.post(
      `${apiOrigin}/open-apis/im/v1/messages/:messageId/reply`,
      async ({ request }) => {
        const body = z
          .object({ content: z.string() })
          .parse(await request.json());
        replies.push(body.content);
        return HttpResponse.json({
          code: 0,
          data: { message_id: `om_${randomUUID()}`, chat_id: "oc_123" },
        });
      },
    ),
    http.post(`${apiOrigin}/open-apis/im/v1/messages`, () => {
      return HttpResponse.json({
        code: 0,
        data: { message_id: `om_${randomUUID()}`, chat_id: "oc_123" },
      });
    }),
    http.get(`${apiOrigin}/open-apis/im/v1/messages`, () => {
      return HttpResponse.json({
        code: 0,
        data: { items: [], has_more: false },
      });
    }),
    http.post(
      `${apiOrigin}/open-apis/im/v1/messages/:messageId/reactions`,
      () => {
        return HttpResponse.json({
          code: 0,
          data: { reaction_id: randomUUID() },
        });
      },
    ),
    http.delete(
      `${apiOrigin}/open-apis/im/v1/messages/:messageId/reactions/:reactionId`,
      () => {
        return HttpResponse.json({ code: 0 });
      },
    ),
  );
  await updateFeatureSwitchesForUser(context, actor, {
    [FeatureSwitchKey.FeishuIntegration]: true,
  });
  const client = setupApp({ context, routes: feishuConnectRoutes })(
    feishuConnectContract,
  );
  const configured = await accept(
    client.setup({
      headers: authenticate(context, actor),
      extraHeaders: { origin: "https://app.okou.ai" },
      body: {
        appId,
        appSecret: "annotation-feishu-secret",
        verificationToken,
        encryptKey,
      },
    }),
    [200],
  );
  const { callbackUrl, installationId } = configured.body;
  if (!callbackUrl || !installationId) {
    throw new Error("Expected the public Feishu installation");
  }
  registerCleanup(async () => {
    await accept(
      client.removeInstallation({
        headers: authenticate(context, actor),
        params: { installationId },
      }),
      [200],
    );
  });
  await accept(
    client.updateInstallation({
      headers: authenticate(context, actor),
      params: { installationId },
      body: { setupCompleted: true },
    }),
    [200],
  );

  const callbackAddress = callbackUrl;
  async function post(payload: unknown) {
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
    const body = JSON.stringify({
      encrypt: Buffer.concat([iv, encrypted]).toString("base64"),
    });
    const timestamp = String(Math.floor(now() / 1000));
    const nonce = randomUUID();
    const signature = createHash("sha256")
      .update(`${timestamp}${nonce}${encryptKey}${body}`)
      .digest("hex");
    const response = await createAppWithRoutes({
      signal: context.signal,
      routes: feishuEventsRoutes,
    }).request(callbackAddress, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-lark-request-timestamp": timestamp,
        "x-lark-request-nonce": nonce,
        "x-lark-signature": signature,
      },
      body,
    });
    expect(response.status).toBe(200);
    await response.text();
  }
  async function message(text: string) {
    await post({
      schema: "2.0",
      header: {
        event_id: randomUUID(),
        event_type: "im.message.receive_v1",
        tenant_key: tenantKey,
        app_id: appId,
        token: verificationToken,
      },
      event: {
        sender: { sender_id: { open_id: openId }, sender_type: "user" },
        message: {
          message_id: `om_${randomUUID()}`,
          chat_id: "oc_123",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text }),
        },
      },
    });
  }
  await post({
    type: "url_verification",
    challenge: "annotation",
    token: verificationToken,
  });
  await message("connect annotation owner");
  await flushWaitUntilForTest();
  const connectUrlText = replies
    .find((reply) => {
      return reply.includes("Connect your account");
    })
    ?.match(/https:\/\/[^"\s]+/u)?.[0];
  if (!connectUrlText) {
    throw new Error("Expected the real Feishu browser-connect link");
  }
  const connectUrl = new URL(connectUrlText);
  const requiredQuery = (key: string) => {
    const value = connectUrl.searchParams.get(key);
    if (!value) {
      throw new Error(`Expected Feishu connect ${key}`);
    }
    return value;
  };
  const connectBody = {
    installationId: requiredQuery("installationId"),
    openId: requiredQuery("openId"),
    chatId: requiredQuery("chatId"),
    ts: Number(requiredQuery("ts")),
    sig: requiredQuery("sig"),
  };
  authenticate(context, actor);
  const browser = createAppWithRoutes({
    signal: context.signal,
    routes: feishuBrowserConnectRoutes,
  });
  const connecting = await browser.request("/api/feishu/connect", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: "__session=opaque",
      origin: connectUrl.origin,
    },
    body: JSON.stringify(connectBody),
  });
  expect(connecting.status).toBe(200);
  const authorization = z
    .object({ openUrl: z.string() })
    .parse(await connecting.json());
  const state = new URL(authorization.openUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected the public Feishu OAuth state");
  }
  const callback = await createAppWithRoutes({
    signal: context.signal,
    routes: feishuOauthRoutes,
  }).request(
    `${feishuOauthContract.callback.path}?${new URLSearchParams({ code: `annotation-${randomUUID()}`, responseMode: "json", state })}`,
  );
  expect(callback.status).toBe(200);
  await callback.json();
  const status = await browser.request(
    `/api/feishu/connect/status?${new URLSearchParams(
      Object.entries(connectBody).map(([key, value]): [string, string] => {
        return [key, String(value)];
      }),
    )}`,
    { headers: { cookie: "__session=opaque" } },
  );
  expect(status.status).toBe(200);
  await expect(status.json()).resolves.toMatchObject({ isConnected: true });
  return { message };
}

/** Prepare one owned actor and create only the ingress requested by a test. */
export async function createPublicAnnotationIngress(
  context: TestContext,
  registerCleanup: RegisterCleanup,
) {
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  const reads = createRunReadsApi(context);
  const chat = createChatFilesBddApi(context);
  const integrations = createBddIntegrationApi(context);
  const candidate = bdd.user({ orgRole: "org:admin" });
  if (!candidate.orgId) {
    throw new Error("Expected the annotation owner's organization");
  }
  const actor = { ...candidate, orgId: candidate.orgId };
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  const group = runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor);
  await runs.ensureOrgModelProvider(actor, { model: "claude-fable-5-1" });
  const { defaultAgentId } = await bdd.readOnboardingStatus(actor);
  if (!defaultAgentId) {
    throw new Error("Expected the annotation owner's Agent");
  }
  const agentId = defaultAgentId;
  await runs.heartbeatRunner(group);

  async function cancelOwnedRuns() {
    const listed = await reads.requestListLogs(actor, { limit: 100 }, [200]);
    for (const run of listed.body.data) {
      if (run.status === "pending" || run.status === "running") {
        await runs.requestCancelRun(actor, run.id, [200]);
      }
    }
    await flushWaitUntilForTest();
  }
  registerCleanup(cancelOwnedRuns);
  async function readInput(text: string): Promise<readonly ChatEvent[]> {
    await flushWaitUntilForTest();
    const input = await findPendingInputEventByText(context, { actor, text });
    if (!input) {
      throw new Error(`Expected the public annotation input: ${text}`);
    }
    const { events } = await chat.listThreadEvents(actor, input.threadId);
    await cancelOwnedRuns();
    return events;
  }

  async function slackInput() {
    integrations.configureSlackAppMocks();
    const slackUserId = uniqueSlackUserId();
    const slack = await integrations.installSlackWorkspace(actor, {
      installerSlackUserId: slackUserId,
    });
    registerCleanup(async () => {
      await integrations.requestSlackDisconnect(actor, "uninstall", [200]);
    });
    await integrations.postSlackEvent(slack.teamId, {
      type: "app_mention",
      user: slackUserId,
      channel: "C123",
      channel_type: "channel",
      ts: "1753257600.000100",
      text: `<@${slack.botUserId}> slack linked`,
    });
    return await readInput("@Slack User slack linked");
  }

  async function feishuInput() {
    const feishu = await connectFeishu(context, actor, registerCleanup);
    await feishu.message("feishu linked");
    return await readInput("feishu linked");
  }

  async function teamsInput(personal: boolean) {
    setupTeamsConnectTestEnv();
    mockEnv("MICROSOFT_TEAMS_BOT_APP_PASSWORD", "annotation-teams-password");
    server.use(
      http.post(
        "https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/oauth2/v2.0/token",
        () => {
          return HttpResponse.json({
            access_token: "annotation-teams-token",
            token_type: "Bearer",
            expires_in: 3600,
          });
        },
      ),
      http.post("https://smba.trafficmanager.net/amer/v3/conversations", () => {
        return HttpResponse.json({ id: `welcome-${randomUUID()}` });
      }),
      http.post(
        "https://smba.trafficmanager.net/amer/v3/conversations/:conversationId/activities",
        () => {
          return HttpResponse.json({ id: randomUUID() });
        },
      ),
      http.post(
        "https://smba.trafficmanager.net/amer/v3/conversations/:conversationId/activities/:activityId",
        () => {
          return HttpResponse.json({ id: randomUUID() });
        },
      ),
      http.put(
        "https://smba.trafficmanager.net/amer/v3/conversations/:conversationId/activities/:activityId/reactions/:reactionType",
        () => {
          return new HttpResponse(null, { status: 200 });
        },
      ),
      http.delete(
        "https://smba.trafficmanager.net/amer/v3/conversations/:conversationId/activities/:activityId/reactions/:reactionType",
        () => {
          return new HttpResponse(null, { status: 200 });
        },
      ),
    );
    const fixture = teamsConnectFixture({
      orgId: actor.orgId,
      userId: actor.userId,
      teamsChannelId: "19:channel@thread.tacv2",
      teamsActivityId: "activity-1",
    });
    const graphChannel = `https://graph.microsoft.com/v1.0/teams/${encodeURIComponent(fixture.teamsTeamAadGroupId)}/channels/${encodeURIComponent(fixture.teamsChannelId)}/messages`;
    const graphUser = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(fixture.teamsAadObjectId)}`;
    const graphInstallationId = `annotation-installation-${fixture.fixtureId}`;
    const graphChatId = `19:annotation-${fixture.fixtureId}@thread.v2`;
    server.use(
      http.post(
        `https://login.microsoftonline.com/${encodeURIComponent(fixture.teamsTenantId)}/oauth2/v2.0/token`,
        () => {
          return HttpResponse.json({
            access_token: "annotation-graph-token",
            token_type: "Bearer",
            expires_in: 3600,
          });
        },
      ),
      http.get(graphChannel, () => {
        return HttpResponse.json({ value: [] });
      }),
      http.get(
        `${graphChannel}/${encodeURIComponent(fixture.teamsThreadId)}`,
        () => {
          return HttpResponse.json({
            id: fixture.teamsThreadId,
            replyToId: null,
            createdDateTime: new Date(now()).toISOString(),
            messageType: "message",
            from: {
              user: {
                id: fixture.teamsAadObjectId,
                displayName: "Ada Lovelace",
                userPrincipalName: fixture.teamsUserPrincipalName,
              },
            },
            body: { contentType: "html", content: "<p>Annotation thread</p>" },
          });
        },
      ),
      http.get(
        `${graphChannel}/${encodeURIComponent(fixture.teamsThreadId)}/replies`,
        () => {
          return HttpResponse.json({ value: [] });
        },
      ),
      http.get(graphUser, () => {
        return HttpResponse.json({
          id: fixture.teamsAadObjectId,
          displayName: "Ada Lovelace",
          userPrincipalName: fixture.teamsUserPrincipalName,
        });
      }),
      http.get(`${graphUser}/teamwork/installedApps`, () => {
        return HttpResponse.json({
          value: [
            {
              id: graphInstallationId,
              teamsApp: { externalId: fixture.teamsAppId },
            },
          ],
        });
      }),
      http.get(
        `${graphUser}/teamwork/installedApps/${graphInstallationId}/chat`,
        () => {
          return HttpResponse.json({ id: graphChatId, chatType: "oneOnOne" });
        },
      ),
      http.get(
        `https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(graphChatId)}/messages`,
        () => {
          return HttpResponse.json({ value: [] });
        },
      ),
    );
    const personalFields = {
      recipient: undefined,
      entities: [],
      replyToId: undefined,
      conversation: {
        id: `a:personal-${fixture.fixtureId}`,
        conversationType: "personal",
      },
      channelData: {
        tenant: { id: fixture.teamsTenantId },
        teamsAppId: fixture.teamsAppId,
      },
    };
    if (personal) {
      // The first recorded installation must never acquire a bot recipient.
      const installed = await postTeamsActivityForTest({
        signal: context.signal,
        activity: teamsMessageActivityForTest(fixture, {
          ...personalFields,
          id: `install-${fixture.fixtureId}`,
          text: "installation seed",
        }),
      });
      expect(installed.status).toBe(200);
      await installed.text();
    } else {
      await installTeamsForTest(context.signal, fixture);
    }
    let removed = false;
    const removeInstallation = async () => {
      if (!removed) {
        await removeTeamsForTest(context.signal, fixture);
        removed = true;
      }
    };
    registerCleanup(removeInstallation);
    await flushWaitUntilForTest();
    await accept(
      setupApp({ context, routes: teamsConnectRoutes })(
        teamsConnectContract,
      ).connect({
        headers: authenticate(context, actor),
        body: {
          tenantId: fixture.teamsTenantId,
          teamsUserId: fixture.teamsUserId,
          teamsAadObjectId: fixture.teamsAadObjectId,
          teamsUserDisplayName: "Ada Lovelace",
          teamsUserPrincipalName: fixture.teamsUserPrincipalName,
        },
      }),
      [200],
    );
    await flushWaitUntilForTest();
    const response = await postTeamsActivityForTest({
      signal: context.signal,
      activity: teamsMessageActivityForTest(
        fixture,
        personal
          ? { ...personalFields, text: "teams personal unlinked" }
          : { text: "<at>Nova</at> teams channel linked" },
      ),
    });
    expect(response.status).toBe(200);
    await response.text();
    const events = await readInput(
      personal ? "teams personal unlinked" : "@Nova teams channel linked",
    );
    return { events, tenantId: fixture.teamsTenantId };
  }

  async function telegramInput(type: "supergroup" | "private" | "group") {
    const botToken = "987654:annotation-telegram-token";
    const webhookSecret = "annotation-telegram-secret";
    mockEnv("TELEGRAM_OFFICIAL_BOT_TOKEN", botToken);
    mockEnv("TELEGRAM_OFFICIAL_WEBHOOK_SECRET", webhookSecret);
    // The public account-link endpoint requires the configured bot username.
    mockEnv("TELEGRAM_OFFICIAL_BOT_USERNAME", "annotation_bot");
    let replyId = 700;
    server.use(
      http.post(
        `https://api.telegram.org/bot${botToken}/sendChatAction`,
        () => {
          return HttpResponse.json({ ok: true, result: true });
        },
      ),
      http.post(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        async ({ request }) => {
          const body = z
            .object({
              chat_id: z.union([z.string(), z.number()]),
              text: z.string(),
            })
            .parse(await request.json());
          return HttpResponse.json({
            ok: true,
            result: {
              message_id: replyId++,
              chat: { id: Number(body.chat_id) },
              text: body.text,
            },
          });
        },
      ),
      http.post(`https://api.telegram.org/bot${botToken}/deleteMessage`, () => {
        return HttpResponse.json({ ok: true, result: true });
      }),
    );
    const telegram = setupApp({ context, routes: integrationsTelegramRoutes })(
      integrationsTelegramContract,
    );
    const telegramAuth = {
      id: randomInt(1_000_000_000, 9_000_000_000),
      auth_date: Math.floor(now() / 1000),
      first_name: "Annotation owner",
    };
    const authData = Object.entries(telegramAuth)
      .sort(([left], [right]) => {
        return left.localeCompare(right);
      })
      .map(([key, value]) => {
        return `${key}=${value}`;
      })
      .join("\n");
    const hash = createHmac(
      "sha256",
      createHash("sha256").update(botToken).digest(),
    )
      .update(authData)
      .digest("hex");
    await accept(
      telegram.link({
        headers: authenticate(context, actor),
        body: {
          telegramBotId: OFFICIAL_TELEGRAM_BOT_ID,
          telegramAuth: { ...telegramAuth, hash },
        },
      }),
      [200],
    );
    registerCleanup(async () => {
      await accept(
        telegram.unlink({
          headers: authenticate(context, actor),
          query: { botId: OFFICIAL_TELEGRAM_BOT_ID },
        }),
        [204],
      );
    });
    // Ingress still has the token, numeric bot ID and webhook secret. Only the
    // optional username is now absent, preserving the private-chat no-href case.
    mockEnv("TELEGRAM_OFFICIAL_BOT_USERNAME", undefined);
    const { chatId, messageId, text } = {
      supergroup: {
        chatId: -1_001_234_567_890,
        messageId: 42,
        text: "telegram supergroup linked",
      },
      private: {
        chatId: telegramAuth.id,
        messageId: 43,
        text: "telegram dm unlinked",
      },
      group: {
        chatId: -123_456_789,
        messageId: 44,
        text: "telegram group unlinked",
      },
    }[type];
    const response = await createAppWithRoutes({
      signal: context.signal,
      routes: integrationsTelegramRoutes,
    }).request(`/api/telegram/webhook/${OFFICIAL_TELEGRAM_BOT_ID}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": webhookSecret,
      },
      body: JSON.stringify({
        update_id: randomInt(1, 2_000_000_000),
        message: {
          message_id: messageId,
          date: Math.floor(now() / 1000),
          text,
          chat: { id: chatId, type },
          from: {
            id: telegramAuth.id,
            is_bot: false,
            first_name: "Annotation owner",
          },
          ...(type === "private"
            ? {}
            : {
                reply_to_message: {
                  message_id: 7,
                  from: {
                    id: 987_654,
                    is_bot: true,
                    first_name: "Annotation bot",
                  },
                },
              }),
        },
      }),
    });
    expect(response.status).toBe(200);
    await response.text();
    return await readInput(text);
  }
  async function githubInput(text: string, href: string) {
    await chat.sendAndLaunch(actor, {
      agentId,
      prompt: text,
      userMessage: {
        version: 1,
        parts: [
          { type: "text", text },
          { type: "source", kind: "github", href },
        ],
      },
    });
    return await readInput(text);
  }
  return {
    slackInput,
    feishuInput,
    teamsInput,
    telegramInput,
    githubInput,
  };
}
