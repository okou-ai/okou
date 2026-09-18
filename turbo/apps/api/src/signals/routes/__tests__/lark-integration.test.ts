import { createDeferredPromise } from "../../utils";
import { randomUUID } from "node:crypto";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import {
  feishuConnectContract,
  larkConnectContract,
} from "@okouai/api-contracts/contracts/feishu-connect";
import { feishuOauthContract } from "@okouai/api-contracts/contracts/feishu-oauth";
import { logsListContract } from "@okouai/api-contracts/contracts/logs";
import {
  integrationsFeishuMessageContract,
  integrationsLarkMessageContract,
  integrationsLarkUploadInitContract,
} from "@okouai/api-contracts/contracts/integrations";
import {
  FEISHU_PLATFORMS,
  type FeishuPlatform,
} from "@okouai/core/feishu-platform";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createAppWithRoutes } from "../../../app-factory-core";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { feishuConnectRoutes } from "../feishu-connect";
import { feishuEventsRoutes } from "../feishu-events";
import { feishuOauthRoutes } from "../feishu-oauth";
import { integrationsFeishuMessageRoutes } from "../integrations-feishu-message";
import { integrationsFeishuFileRoutes } from "../integrations-feishu-files";
import { logsRoutes } from "../logs";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import { createRouteMocks } from "./helpers/route-test";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRunsApi } from "./helpers/api-bdd-runs";

const context = testContext();
const mocks = createRouteMocks(context);
const authOrgApi = createAuthOrgAgentsBddApi(context);
const runsApi = createRunsApi(context);
describe("Lark integration", () => {
  const headers = { authorization: "Bearer clerk-session" };
  let larkRequests: string[];
  let oauthRequests: unknown[];

  beforeEach(() => {
    mockEnv("APP_URL", "https://app.okou.ai");
    mockEnv("FEISHU_CALLBACK_BASE_URL", "https://api.okou.ai");
    mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.test");
    context.mocks.ably.publish.mockResolvedValue(undefined);
    context.mocks.axiom.query.mockResolvedValue([]);
    larkRequests = [];
    oauthRequests = [];
    for (const origin of [
      "https://open.larksuite.com",
      "https://open.feishu.cn",
    ]) {
      server.use(
        http.post(
          `${origin}/open-apis/auth/v3/tenant_access_token/internal`,
          () => {
            return HttpResponse.json({
              code: 0,
              tenant_access_token: "tenant-token",
              expire: 7200,
            });
          },
        ),
        http.get(`${origin}/open-apis/bot/v3/info`, () => {
          return HttpResponse.json({
            code: 0,
            bot: { open_id: "ou_bot", app_name: "Test bot" },
          });
        }),
      );
    }
    server.use(
      http.post(
        "https://open.larksuite.com/open-apis/authen/v2/oauth/token",
        async ({ request }) => {
          const body: unknown = await request.json();
          oauthRequests.push(body);
          larkRequests.push("oauth");
          return HttpResponse.json({
            code: 0,
            access_token: "lark-user-token",
            refresh_token: "lark-refresh",
            expires_in: 7200,
            scope: "offline_access",
          });
        },
      ),
      http.get(
        "https://open.larksuite.com/open-apis/authen/v1/user_info",
        () => {
          larkRequests.push("user-info");
          return HttpResponse.json({
            code: 0,
            data: {
              name: "Lark User",
              open_id: "ou_user",
              tenant_key: "lark-tenant",
            },
          });
        },
      ),
      http.post("https://open.larksuite.com/open-apis/im/v1/messages", () => {
        larkRequests.push("message");
        return HttpResponse.json({
          code: 0,
          data: { message_id: "om_lark", chat_id: "oc_lark" },
        });
      }),
    );
  });

  async function fixture() {
    const userId = `user_${randomUUID()}`;
    const actor = {
      userId,
      orgId: `org_${randomUUID()}`,
      orgRole: "org:admin" as const,
      email: `${userId}@example.test`,
    };
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.LarkIntegration]: true,
      [FeatureSwitchKey.FeishuIntegration]: true,
    });
    authOrgApi.acceptAgentStorageWrites();
    const agent = await authOrgApi.createAgent(actor, {
      displayName: "Bot agent",
      visibility: "public",
    });
    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const client = setupApp({ context, routes: feishuConnectRoutes })(
      feishuConnectContract,
    );
    const larkClient = setupApp({ context, routes: feishuConnectRoutes })(
      larkConnectContract,
    );
    const install = async (
      platform: FeishuPlatform,
      appId = `cli_${randomUUID()}`,
    ) => {
      const platformClient = platform === "lark" ? larkClient : client;
      const response = await accept(
        platformClient.setup({
          headers,
          body: {
            appId,
            appSecret: "test-secret",
            verificationToken: "test-verification",
            defaultAgentId: agent.agentId,
            createNew: true,
          },
        }),
        [200],
      );
      const installationId = response.body.installationId;
      if (!installationId) {
        throw new Error("Expected installation ID");
      }
      const complete = await accept(
        platformClient.updateInstallation({
          headers,
          params: { installationId },
          body: { defaultAgentId: agent.agentId, setupCompleted: true },
        }),
        [200],
      );
      return complete.body;
    };
    mockClerkMembership(context, actor, "org:admin");
    const token = signSandboxJwtForTests({
      scope: "okou",
      userId,
      orgId: actor.orgId,
      runId: `run_${randomUUID()}`,
      capabilities: ["feishu:write", "lark:write"],
      iat: Math.floor(now() / 1000),
      exp: Math.floor(now() / 1000) + 60,
    });
    return {
      actor,
      client,
      larkClient,
      install,
      token,
      defaultAgentId: agent.agentId,
    };
  }

  it("isolates agent selection and default resets between Feishu and Lark", async () => {
    const { actor, client, larkClient, install, defaultAgentId } =
      await fixture();
    runsApi.configureRunnerGroup();
    runsApi.acceptStorageDownloads();
    runsApi.acceptTelemetryIngest();
    await runsApi.grantProEntitlement(actor);
    await runsApi.ensureOrgModelProvider(actor);
    const feishuAgent = await authOrgApi.createAgent(actor, {
      displayName: "Feishu selected agent",
      visibility: "public",
    });
    const larkAgent = await authOrgApi.createAgent(actor, {
      displayName: "Lark selected agent",
      visibility: "public",
    });
    for (const platform of ["feishu", "lark"] as const) {
      const origin = FEISHU_PLATFORMS[platform].apiOrigin;
      server.use(
        http.post(`${origin}/open-apis/authen/v2/oauth/token`, () => {
          return HttpResponse.json({
            code: 0,
            access_token: `${platform}-user-token`,
            refresh_token: `${platform}-refresh`,
            expires_in: 7200,
            scope: "offline_access",
          });
        }),
        http.get(`${origin}/open-apis/authen/v1/user_info`, () => {
          return HttpResponse.json({
            code: 0,
            data: {
              name: `${platform} user`,
              open_id: "ou_user",
              tenant_key: `${platform}-tenant`,
            },
          });
        }),
        http.get(`${origin}/open-apis/im/v1/messages`, () => {
          return HttpResponse.json({
            code: 0,
            data: { items: [], has_more: false },
          });
        }),
        http.post(`${origin}/open-apis/im/v1/messages`, () => {
          return HttpResponse.json({
            code: 0,
            data: {
              message_id: `om_${randomUUID()}`,
              chat_id: `oc_${platform}`,
            },
          });
        }),
        http.post(`${origin}/open-apis/im/v1/messages/:messageId/reply`, () => {
          return HttpResponse.json({
            code: 0,
            data: {
              message_id: `om_${randomUUID()}`,
              chat_id: `oc_${platform}`,
            },
          });
        }),
        http.post(
          `${origin}/open-apis/im/v1/messages/:messageId/reactions`,
          () => {
            return HttpResponse.json({
              code: 0,
              data: { reaction_id: `reaction_${randomUUID()}` },
            });
          },
        ),
        http.delete(
          `${origin}/open-apis/im/v1/messages/:messageId/reactions/:reactionId`,
          () => {
            return HttpResponse.json({ code: 0 });
          },
        ),
      );
    }
    const installations = {
      feishu: await install("feishu"),
      lark: await install("lark"),
    };
    const oauthApp = createAppWithRoutes({
      signal: context.signal,
      routes: feishuOauthRoutes,
    });
    for (const installation of Object.values(installations)) {
      if (!installation.connectUrl) {
        throw new Error("Expected installation OAuth URL");
      }
      const start = await oauthApp.request(installation.connectUrl);
      expect(start.status).toBe(307);
      const state = new URL(
        start.headers.get("location") ?? "",
      ).searchParams.get("state");
      if (!state) {
        throw new Error("Expected OAuth state");
      }
      const result = await oauthApp.request(
        `${feishuOauthContract.callback.path}?${new URLSearchParams({ state, code: `code_${randomUUID()}`, responseMode: "json" })}`,
      );
      expect(result.status).toBe(200);
    }
    const eventsApp = createAppWithRoutes({
      signal: context.signal,
      routes: feishuEventsRoutes,
    });
    async function send(platform: FeishuPlatform, text: string) {
      const installation = installations[platform];
      const response = await eventsApp.request(installation.callbackUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schema: "2.0",
          header: {
            event_id: randomUUID(),
            event_type: "im.message.receive_v1",
            tenant_key: `${platform}-tenant`,
            app_id: installation.appId,
            token: "test-verification",
          },
          event: {
            sender: { sender_id: { open_id: "ou_user" }, sender_type: "user" },
            message: {
              message_id: `om_${randomUUID()}`,
              chat_id: `oc_${platform}`,
              chat_type: "p2p",
              message_type: "text",
              content: JSON.stringify({ text }),
            },
          },
        }),
      });
      expect(response.status).toBe(200);
      await flushWaitUntilForTest();
    }
    async function expectAgent(platform: FeishuPlatform, agentId: string) {
      const prompt = `Check ${platform} selection ${randomUUID()}`;
      await send(platform, prompt);
      mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
      const logs = await accept(
        setupApp({ context, routes: logsRoutes })(logsListContract).list({
          headers,
          query: { triggerSource: platform, limit: 20 },
        }),
        [200],
      );
      const run = logs.body.data.find((entry) => {
        return entry.prompt === prompt;
      });
      if (!run) {
        throw new Error("Expected integration run");
      }
      expect(run).toMatchObject({ agentId, triggerSource: platform });
      await runsApi.requestCancelRun(actor, run.id, [200]);
      await flushWaitUntilForTest();
    }
    await send("feishu", `/switch ${feishuAgent.agentId}`);
    await expectAgent("lark", defaultAgentId);
    await send("lark", `/switch ${larkAgent.agentId}`);
    await expectAgent("feishu", feishuAgent.agentId);
    await expectAgent("lark", larkAgent.agentId);
    await send("feishu", "/switch default");
    await expectAgent("feishu", defaultAgentId);
    await expectAgent("lark", larkAgent.agentId);
    await send("feishu", `/switch ${feishuAgent.agentId}`);
    await send("lark", "/switch default");
    await expectAgent("lark", defaultAgentId);
    await expectAgent("feishu", feishuAgent.agentId);
    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    await accept(
      client.removeInstallation({
        headers,
        params: { installationId: installations.feishu.id },
      }),
      [200],
    );
    await accept(
      larkClient.removeInstallation({
        headers,
        params: { installationId: installations.lark.id },
      }),
      [200],
    );
  });

  it("keeps Lark installations separate from the legacy Feishu default", async () => {
    const { client, larkClient, install } = await fixture();
    const feishu = await install("feishu");
    const lark = await install("lark");
    const legacy = await accept(client.getStatus({ headers }), [200]);
    const status = await accept(larkClient.getStatus({ headers }), [200]);
    expect(
      legacy.body.installations?.map((item) => {
        return item.id;
      }),
    ).toStrictEqual([feishu.id]);
    expect(
      status.body.installations?.map((item) => {
        return item.id;
      }),
    ).toStrictEqual([lark.id]);
    expect(status.body.oauthRedirectUrl).toBe(
      "https://app.okou.ai/integrations/lark/callback",
    );
    await accept(
      client.removeInstallation({
        headers,
        params: { installationId: lark.id },
      }),
      [404],
    );
    await accept(
      larkClient.removeInstallation({
        headers,
        params: { installationId: lark.id },
      }),
      [200],
    );
    expect(
      (await accept(client.getStatus({ headers }), [200])).body.installationId,
    ).toBe(feishu.id);
  });

  it("shares Lark rollout with other members of the installation organization", async () => {
    const { actor, larkClient, install } = await fixture();
    const installation = await install("lark");
    mocks.clerk.session(`user_${randomUUID()}`, actor.orgId, "org:member");
    const status = await accept(larkClient.getStatus({ headers }), [200]);
    expect(status.body.isAdmin).toBeFalsy();
    expect(status.body.installationId).toBe(installation.id);
  });

  it("rejects an App ID already registered on the other platform", async () => {
    const { larkClient, install } = await fixture();
    const existing = await install("feishu");
    const conflict = await accept(
      larkClient.checkAppId({
        headers,
        query: { appId: existing.appId },
      }),
      [409],
    );
    expect(conflict.body.error.code).toBe("CONFLICT");
  });

  it("uses Lark for OAuth, user identity, and the bot deep link", async () => {
    const { larkClient, install } = await fixture();
    const installation = await install("lark");
    if (!installation.connectUrl) {
      throw new Error("Expected OAuth URL");
    }
    const app = createAppWithRoutes({
      signal: context.signal,
      routes: feishuOauthRoutes,
    });
    const start = await app.request(installation.connectUrl);
    expect(start.status).toBe(307);
    const authorization = new URL(start.headers.get("location") ?? "");
    expect(authorization.origin).toBe("https://accounts.larksuite.com");
    expect(authorization.searchParams.get("redirect_uri")).toBe(
      "https://app.okou.ai/integrations/lark/callback",
    );
    const state = authorization.searchParams.get("state");
    if (!state) {
      throw new Error("Expected OAuth state");
    }
    const result = await app.request(
      `${feishuOauthContract.callback.path}?${new URLSearchParams({ state, code: "lark-code", responseMode: "json" })}`,
    );
    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toStrictEqual({
      redirectUrl: `https://applink.larksuite.com/client/bot/open?appId=${installation.appId}`,
    });
    expect(oauthRequests[0]).toMatchObject({
      grant_type: "authorization_code",
      redirect_uri: "https://app.okou.ai/integrations/lark/callback",
    });
    expect(larkRequests).toContain("oauth");
    expect(larkRequests).toContain("user-info");
    const status = await accept(larkClient.getStatus({ headers }), [200]);
    expect(status.body.connectedUserName).toBe("Lark User");
  });

  it("verifies Lark callbacks and rejects them after the owner disables Lark", async () => {
    const { actor, client, larkClient, install } = await fixture();
    const installation = await install("lark");
    const app = createAppWithRoutes({
      signal: context.signal,
      routes: feishuEventsRoutes,
    });
    const verify = () => {
      return app.request(installation.callbackUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "url_verification",
          challenge: "lark-challenge",
          token: "test-verification",
        }),
      });
    };
    const result = await verify();
    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toStrictEqual({
      challenge: "lark-challenge",
    });
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.LarkIntegration]: false,
      [FeatureSwitchKey.FeishuIntegration]: true,
    });
    expect((await verify()).status).toBe(404);
    await accept(larkClient.getStatus({ headers }), [403]);
    await accept(client.getStatus({ headers }), [200]);
  });

  it("sends through Lark only and blocks sends when the switch is disabled", async () => {
    const { actor, install, token } = await fixture();
    const installation = await install("lark");
    const client = setupApp({
      context,
      routes: integrationsFeishuMessageRoutes,
    })(integrationsLarkMessageContract);
    const request = {
      headers: { authorization: `Bearer ${token}` },
      body: {
        installationId: installation.id,
        chat: "oc_lark",
        text: "Hello Lark",
      },
    };
    const feishuOnlyToken = signSandboxJwtForTests({
      scope: "okou",
      userId: actor.userId,
      orgId: actor.orgId,
      runId: `run_${randomUUID()}`,
      capabilities: ["feishu:write"],
      iat: Math.floor(now() / 1000),
      exp: Math.floor(now() / 1000) + 60,
    });
    await accept(
      client.sendMessage({
        ...request,
        headers: { authorization: `Bearer ${feishuOnlyToken}` },
      }),
      [403],
    );
    await accept(client.sendMessage(request), [200]);
    expect(
      larkRequests.filter((value) => {
        return value === "message";
      }),
    ).toHaveLength(1);
    await accept(
      setupApp({ context, routes: integrationsFeishuMessageRoutes })(
        integrationsFeishuMessageContract,
      ).sendMessage(request),
      [404],
    );
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.LarkIntegration]: false,
    });
    await accept(client.sendMessage(request), [403]);
    const upload = await accept(
      setupApp({ context, routes: integrationsFeishuFileRoutes })(
        integrationsLarkUploadInitContract,
      ).init({
        headers: request.headers,
        body: { filename: "report.txt", contentType: "text/plain", length: 5 },
      }),
      [403],
    );
    expect(upload.body.error.code).toBe("FORBIDDEN");
    expect(
      larkRequests.filter((value) => {
        return value === "message";
      }),
    ).toHaveLength(1);
  });
  describe("with an installed Lark app", () => {
    async function prepareScenario() {
      const { install } = await fixture();
      const installation = await install("lark");
      return { installation };
    }
    let preparedScenario: Awaited<ReturnType<typeof prepareScenario>>;
    beforeEach(async () => {
      preparedScenario = await prepareScenario();
    });
    it("answers an incoming Lark message with a Lark account-connect card", async () => {
      const { installation } = preparedScenario;
      const sent = createDeferredPromise<unknown>(context.signal);
      server.use(
        http.post(
          "https://open.larksuite.com/open-apis/im/v1/messages/om_incoming/reply",
          async ({ request }) => {
            sent.resolve(await request.json());
            return HttpResponse.json({
              code: 0,
              data: { message_id: "om_connect", chat_id: "oc_lark" },
            });
          },
        ),
      );
      const app = createAppWithRoutes({
        signal: context.signal,
        routes: feishuEventsRoutes,
      });
      const response = await app.request(installation.callbackUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schema: "2.0",
          header: {
            event_id: randomUUID(),
            event_type: "im.message.receive_v1",
            tenant_key: "lark-tenant",
            app_id: installation.appId,
            token: "test-verification",
          },
          event: {
            sender: {
              sender_id: { open_id: "ou_new_lark_user" },
              sender_type: "user",
            },
            message: {
              message_id: "om_incoming",
              chat_id: "oc_lark",
              chat_type: "p2p",
              message_type: "text",
              content: JSON.stringify({ text: "Hello" }),
            },
          },
        }),
      });
      expect(response.status).toBe(200);
      const card = await sent.promise;
      expect(card).toMatchObject({
        reply_in_thread: true,
        msg_type: "interactive",
      });
      expect(JSON.stringify(card)).toContain("in Lark");
      expect(JSON.stringify(card)).toContain("/settings/lark?");
      expect(JSON.stringify(card)).not.toContain("/settings/feishu");
    });
  });
});
