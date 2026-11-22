import { integrationsLarkMessageContract } from "@okouai/api-contracts/contracts/integrations";
import { integrationsFeishuMessageRoutes } from "../integrations-feishu-message";
import {
  createCipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { larkOfficialContract } from "@okouai/api-contracts/contracts/lark-official";
import { larkOfficialReadContract } from "@okouai/api-contracts/contracts/lark-official-read";
import { larkConnectContract } from "@okouai/api-contracts/contracts/feishu-connect";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createAppWithRoutes } from "../../../app-factory-core";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { larkOfficialRoutes } from "../lark-official";
import { larkOfficialEventsRoutes } from "../lark-official-events";
import { larkOfficialReadRoutes } from "../lark-official-read";
import { feishuOauthRoutes } from "../feishu-oauth";
import { feishuEventsRoutes } from "../feishu-events";
import { feishuConnectRoutes } from "../feishu-connect";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { createRouteMocks } from "./helpers/route-test";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

const context = testContext();
const mocks = createRouteMocks(context);
const authOrg = createAuthOrgAgentsBddApi(context);
describe("Okou Official Lark bot", () => {
  const headers = { authorization: "Bearer clerk-session" };
  let appId: string;
  const ENCRYPT_KEY = "official-event-encryption";
  const VERIFY_TOKEN = "official-verification-token";
  const ORIGIN = "https://open.larksuite.com/open-apis";
  const officialClient = () => {
    return setupApp({ context, routes: larkOfficialRoutes })(
      larkOfficialContract,
    );
  };
  const customClient = () => {
    return setupApp({ context, routes: feishuConnectRoutes })(
      larkConnectContract,
    );
  };
  const readClient = () => {
    return setupApp({ context, routes: larkOfficialReadRoutes })(
      larkOfficialReadContract,
    );
  };
  let oauthTenant: string;
  let oauthUser: string;
  let capturedTicket: string | undefined;
  let historyCalls: number;
  let botPresent: boolean;
  let userPresent: boolean;

  function configureApp() {
    mockEnv("LARK_OFFICIAL_APP_ID", appId);
    mockEnv("LARK_OFFICIAL_APP_SECRET", "official-secret");
    mockEnv("LARK_OFFICIAL_VERIFICATION_TOKEN", VERIFY_TOKEN);
    mockEnv("LARK_OFFICIAL_ENCRYPT_KEY", ENCRYPT_KEY);
  }
  async function createActor(enabled = true, customEnabled = true) {
    const actor = authOrg.user();
    if (!actor.orgId) {
      throw new Error("Expected workspace");
    }
    authOrg.acceptAgentStorageWrites();
    await authOrg.provisionWorkspace(actor);
    await authOrg.completeOnboarding(actor);
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: actor.orgId },
      {
        [FeatureSwitchKey.LarkOfficialBot]: enabled,
        [FeatureSwitchKey.LarkIntegration]: customEnabled,
      },
    );
    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    return actor;
  }
  function eventBody(payload: unknown) {
    const iv = randomBytes(16);
    const cipher = createCipheriv(
      "aes-256-cbc",
      createHash("sha256").update(ENCRYPT_KEY).digest(),
      iv,
    );
    return JSON.stringify({
      encrypt: Buffer.concat([
        iv,
        cipher.update(JSON.stringify(payload)),
        cipher.final(),
      ]).toString("base64"),
    });
  }
  function postEvent(
    payload: unknown,
    validSignature = true,
    path = "/api/webhooks/lark/official/events",
  ) {
    const body = eventBody(payload);
    const timestamp = String(Math.floor(now() / 1000));
    const nonce = randomUUID();
    const signature = createHash("sha256")
      .update(`${timestamp}${nonce}${ENCRYPT_KEY}${body}`)
      .digest("hex");
    return createAppWithRoutes({
      signal: context.signal,
      routes: [...larkOfficialEventsRoutes, ...feishuEventsRoutes],
    }).request(path, {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-lark-request-timestamp": timestamp,
        "x-lark-request-nonce": nonce,
        "x-lark-signature": validSignature ? signature : "invalid",
      },
    });
  }
  async function ticket(value = "official-ticket", timestamp = now() / 1000) {
    const response = await postEvent({
      ts: String(timestamp),
      token: VERIFY_TOKEN,
      type: "event_callback",
      event: { type: "app_ticket", app_id: appId, app_ticket: value },
    });
    expect(response.status).toBe(200);
  }
  async function authorization() {
    const started = await accept(officialClient().connect({ headers }), [200]);
    const response = await createAppWithRoutes({
      signal: context.signal,
      routes: feishuOauthRoutes,
    }).request(started.body.authorizationUrl);
    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    if (!location) {
      throw new Error("Expected Lark authorization redirect");
    }
    return new URL(location);
  }
  async function complete(url: URL) {
    const state = url.searchParams.get("state");
    if (!state) {
      throw new Error("Expected OAuth state");
    }
    const response = await createAppWithRoutes({
      signal: context.signal,
      routes: feishuOauthRoutes,
    }).request(
      `/api/integrations/feishu/oauth/callback?state=${encodeURIComponent(state)}&code=official-code&responseMode=json`,
    );
    await flushWaitUntilForTest();
    return response;
  }
  async function connect() {
    await ticket();
    const response = await complete(await authorization());
    expect(response.status).toBe(200);
    await expect(response.clone().json()).resolves.toStrictEqual({
      redirectUrl: `https://applink.larksuite.com/client/bot/open?appId=${appId}`,
    });
    return response;
  }

  beforeEach(() => {
    appId = `cli_okou_official_${randomUUID()}`;
    configureApp();
    mockEnv("APP_URL", "https://app.okou.ai");
    mockEnv("FEISHU_CALLBACK_BASE_URL", "https://api.okou.ai");
    oauthTenant = `tenant_official_${randomUUID()}`;
    oauthUser = "ou_official_a";
    capturedTicket = undefined;
    historyCalls = 0;
    botPresent = true;
    userPresent = true;
    server.use(
      http.post(`${ORIGIN}/auth/v3/app_access_token`, async ({ request }) => {
        const body = (await request.json()) as {
          app_id: string;
          app_secret: string;
          app_ticket: string;
        };
        if (body.app_id !== appId || body.app_secret !== "official-secret") {
          return HttpResponse.json({ code: 9999 }, { status: 401 });
        }
        capturedTicket = body.app_ticket;
        return HttpResponse.json({
          code: 0,
          app_access_token: "official-app-token",
          expire: 7200,
        });
      }),
      http.post(
        `${ORIGIN}/auth/v3/tenant_access_token`,
        async ({ request }) => {
          const body = (await request.json()) as {
            app_access_token: string;
            tenant_key: string;
          };
          if (
            body.app_access_token !== "official-app-token" ||
            body.tenant_key !== oauthTenant
          ) {
            return HttpResponse.json({ code: 9999 }, { status: 401 });
          }
          return HttpResponse.json({
            code: 0,
            tenant_access_token: `bot-token-${oauthTenant}`,
            expire: 7200,
          });
        },
      ),
      http.post(`${ORIGIN}/auth/v3/tenant_access_token/internal`, () => {
        return HttpResponse.json({
          code: 0,
          tenant_access_token: "custom-bot-token",
          expire: 7200,
        });
      }),
      http.post(`${ORIGIN}/authen/v2/oauth/token`, () => {
        return HttpResponse.json({
          code: 0,
          access_token: "official-user-token",
          refresh_token: "official-refresh-token",
          expires_in: 7200,
        });
      }),
      http.get(`${ORIGIN}/authen/v1/user_info`, () => {
        return HttpResponse.json({
          code: 0,
          data: {
            open_id: oauthUser,
            tenant_key: oauthTenant,
            name: "Official User",
          },
        });
      }),
      http.get(`${ORIGIN}/bot/v3/info`, () => {
        return HttpResponse.json({
          code: 0,
          bot: {
            open_id: "ou_official_bot",
            app_name: "Okou Official",
            avatar_url: "https://example.test/official.png",
          },
        });
      }),
      http.post(`${ORIGIN}/im/v1/messages`, () => {
        return HttpResponse.json({
          code: 0,
          data: { message_id: "om_welcome", chat_id: "oc_dm" },
        });
      }),
      http.get(`${ORIGIN}/im/v1/chats`, () => {
        return HttpResponse.json({
          code: 0,
          data: {
            items: [{ chat_id: "oc_shared", name: "Shared team" }],
            has_more: true,
            page_token: "next-page",
          },
        });
      }),
      http.get(`${ORIGIN}/im/v1/chats/:chat`, () => {
        return HttpResponse.json({
          code: 0,
          data: { chat_mode: "group", moderation_permission: "all_members" },
        });
      }),
      http.get(`${ORIGIN}/im/v1/chats/:chat/members/is_in_chat`, () => {
        return HttpResponse.json({ code: 0, data: { is_in_chat: botPresent } });
      }),
      http.get(`${ORIGIN}/im/v1/chats/:chat/members`, () => {
        return HttpResponse.json({
          code: 0,
          data: {
            items: userPresent
              ? [{ member_id: oauthUser, member_id_type: "open_id" }]
              : [],
            has_more: false,
          },
        });
      }),
      http.get(`${ORIGIN}/im/v1/messages`, ({ request }) => {
        if (
          request.headers.get("authorization") !==
          `Bearer bot-token-${oauthTenant}`
        ) {
          return HttpResponse.json({ code: 9999 }, { status: 401 });
        }
        historyCalls++;
        return HttpResponse.json({
          code: 0,
          data: {
            items: [
              {
                message_id: "om_history",
                msg_type: "text",
                body: { content: '{"text":"Team update"}' },
              },
            ],
            has_more: false,
          },
        });
      }),
    );
  });

  it("requires the feature switch and keeps an unconfigured app unavailable", async () => {
    await createActor(false);
    await accept(officialClient().getStatus({ headers }), [403]);
    await accept(officialClient().connect({ headers }), [403]);
    await createActor();
    mockEnv("LARK_OFFICIAL_APP_SECRET", undefined);
    const status = await accept(officialClient().getStatus({ headers }), [200]);
    expect(status.body).toStrictEqual({
      isConfigured: false,
      isConnected: false,
      connectedUserName: null,
      installationId: null,
    });
    await accept(officialClient().connect({ headers }), [503]);
    const custom = await accept(customClient().getStatus({ headers }), [200]);
    expect(custom.body.isInstalled).toBeFalsy();
  });

  it("connects with store scopes while leaving the custom bot and its setup unchanged", async () => {
    await createActor();
    const custom = await accept(
      customClient().setup({
        headers,
        body: {
          appId: `cli_custom_${randomUUID()}`,
          appSecret: "custom-secret",
          verificationToken: "custom-verify",
          encryptKey: "custom-encrypt",
          createNew: true,
        },
      }),
      [200],
    );
    await ticket();
    const url = await authorization();
    const scopes = url.searchParams.get("scope")?.split(" ") ?? [];
    expect(url.origin).toBe("https://accounts.larksuite.com");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.okou.ai/integrations/lark/callback",
    );
    expect(url.searchParams.get("client_id")).toBe(appId);
    expect(scopes).toContain("im:chat:read");
    expect(scopes).toContain("calendar:calendar.event:create");
    expect(scopes).not.toContain("drive:export:readonly");
    expect(scopes).not.toContain("contact:user.id:readonly");
    expect(scopes).not.toContain("im:chat");
    expect(scopes).not.toContain("im:message.group_msg:get_as_user");
    expect((await complete(url)).status).toBe(200);
    const official = await accept(
      officialClient().getStatus({ headers }),
      [200],
    );
    expect(official.body.isConnected).toBeTruthy();
    const unchanged = await accept(
      customClient().getStatus({ headers }),
      [200],
    );
    expect(unchanged.body.installations).toStrictEqual(
      custom.body.installations,
    );
    if (!official.body.installationId) {
      throw new Error("Missing Official installation ID");
    }
    await accept(
      customClient().updateInstallation({
        headers,
        params: { installationId: official.body.installationId },
        body: { setupCompleted: true },
      }),
      [404],
    );
    await accept(
      customClient().removeInstallation({
        headers,
        params: { installationId: official.body.installationId },
      }),
      [404],
    );
    await accept(
      customClient().setup({
        headers,
        body: {
          appId,
          appSecret: "try-overwrite",
          verificationToken: "try-overwrite",
          createNew: true,
        },
      }),
      [409],
    );
    await accept(officialClient().disconnect({ headers }), [200]);
    expect(
      (await accept(officialClient().getStatus({ headers }), [200])).body
        .isConnected,
    ).toBeFalsy();
    expect(
      (await accept(customClient().getStatus({ headers }), [200])).body
        .installations,
    ).toStrictEqual(custom.body.installations);
  });

  it("verifies ticket callbacks and prevents delayed tickets from replacing newer tickets", async () => {
    await createActor();
    const rejected = await postEvent(
      {
        ts: String(now() / 1000),
        token: VERIFY_TOKEN,
        event: { type: "app_ticket", app_id: appId, app_ticket: "forged" },
      },
      false,
    );
    expect(rejected.status).toBe(401);
    await ticket("new-ticket", now() / 1000);
    await ticket("old-ticket", now() / 1000 - 60);
    await expect(
      (await complete(await authorization())).json(),
    ).resolves.toStrictEqual({
      redirectUrl: `https://applink.larksuite.com/client/bot/open?appId=${appId}`,
    });
    expect(capturedTicket).toBe("new-ticket");
  });

  it("isolates tenants and rejects an OAuth account from another workspace tenant", async () => {
    await createActor();
    await connect();
    const pending = await authorization();
    oauthTenant = `tenant_wrong_${randomUUID()}`;
    oauthUser = "ou_wrong";
    const result = await complete(pending);
    await expect(result.json()).resolves.toMatchObject({
      redirectUrl: expect.stringContaining("tenant"),
    });
    const unchanged = await accept(
      officialClient().getStatus({ headers }),
      [200],
    );
    expect(unchanged.body.isConnected).toBeTruthy();
    await createActor();
    oauthTenant = `tenant_official_b_${randomUUID()}`;
    oauthUser = "ou_official_b";
    await expect(
      (await complete(await authorization())).json(),
    ).resolves.toStrictEqual({
      redirectUrl: `https://applink.larksuite.com/client/bot/open?appId=${appId}`,
    });
    expect(
      (await accept(officialClient().getStatus({ headers }), [200])).body
        .isConnected,
    ).toBeTruthy();
  });

  it("prevents one tenant from being bound to two workspaces", async () => {
    await createActor();
    await connect();
    await createActor();
    const result = await complete(await authorization());
    await expect(result.json()).resolves.toMatchObject({
      redirectUrl: expect.stringContaining("tenant"),
    });
    expect(
      (await accept(officialClient().getStatus({ headers }), [200])).body
        .isConnected,
    ).toBeFalsy();
  });

  it("reads shared groups with the bot token and checks both members before reading", async () => {
    await createActor(true, false);
    await connect();
    const chats = await accept(
      readClient().listChats({ headers, query: { limit: 20 } }),
      [200],
    );
    expect(chats.body.chats).toContainEqual(
      expect.objectContaining({ id: "oc_shared" }),
    );
    expect(chats.body.nextCursor).toBe("next-page");
    const history = await accept(
      readClient().history({
        headers,
        query: {
          chat: "oc_shared",
          limit: 20,
          startTime: "100",
          endTime: "200",
        },
      }),
      [200],
    );
    expect(history.body.messages[0]?.message_id).toBe("om_history");
    expect(historyCalls).toBe(1);
    botPresent = false;
    await accept(
      readClient().history({
        headers,
        query: { chat: "oc_shared", limit: 20 },
      }),
      [403],
    );
    botPresent = true;
    userPresent = false;
    await accept(
      readClient().history({
        headers,
        query: { chat: "oc_shared", limit: 20 },
      }),
      [403],
    );
    const empty = await accept(
      readClient().listChats({ headers, query: { limit: 20 } }),
      [200],
    );
    expect(empty.body.chats).toStrictEqual([]);
    expect(empty.body.nextCursor).toBe("next-page");
    expect(historyCalls).toBe(1);
    userPresent = true;
    server.use(
      http.get(`${ORIGIN}/im/v1/chats/:chat`, () => {
        return HttpResponse.json({ code: 0, data: { chat_mode: "p2p" } });
      }),
    );
    await accept(
      readClient().history({
        headers,
        query: { chat: "oc_private", limit: 20 },
      }),
      [403],
    );
    expect(historyCalls).toBe(1);
    await accept(officialClient().disconnect({ headers }), [200]);
    await accept(
      readClient().history({
        headers,
        query: { chat: "oc_shared", limit: 20 },
      }),
      [404],
    );
  });

  it("handles unavailable and empty Lark group lists", async () => {
    await createActor(true, false);
    await connect();
    server.use(
      http.get(`${ORIGIN}/im/v1/chats`, () => {
        return new HttpResponse(null, { status: 503 });
      }),
    );
    const response = await accept(
      readClient().listChats({ headers, query: { limit: 20 } }),
      [502],
    );
    expect(response.body.error.code).toBe("LARK_ERROR");
    server.use(
      http.get(`${ORIGIN}/im/v1/chats`, () => {
        return HttpResponse.json({ code: 0, data: { has_more: false } });
      }),
    );
    const empty = await accept(
      readClient().listChats({ headers, query: { limit: 20 } }),
      [200],
    );
    expect(empty.body.chats).toStrictEqual([]);
    expect(empty.body.hasMore).toBeFalsy();
  });

  it("stops access after the tenant disables the Official app and ignores older lifecycle events", async () => {
    await createActor();
    await connect();
    const at = now() / 1000;
    const response = await postEvent({
      ts: String(at),
      token: VERIFY_TOKEN,
      event: {
        type: "app_status_change",
        app_id: appId,
        tenant_key: oauthTenant,
        status: "stop_by_tenant",
      },
    });
    expect(response.status).toBe(200);
    await postEvent({
      ts: String(at - 60),
      token: VERIFY_TOKEN,
      event: {
        type: "app_status_change",
        app_id: appId,
        tenant_key: oauthTenant,
        status: "start_by_tenant",
      },
    });
    const status = await accept(officialClient().getStatus({ headers }), [200]);
    expect(status.body.isConnected).toBeFalsy();
    await accept(officialClient().connect({ headers }), [409]);
    await accept(
      readClient().history({
        headers,
        query: { chat: "oc_shared", limit: 20 },
      }),
      [404],
    );
  });
  it("keeps Official callbacks separate from custom callbacks and acknowledges unbound tenants without dispatch", async () => {
    await createActor();
    await connect();
    const status = await accept(officialClient().getStatus({ headers }), [200]);
    const body = {
      schema: "2.0",
      header: {
        event_id: randomUUID(),
        event_type: "unhandled.event",
        app_id: appId,
        tenant_key: oauthTenant,
        token: VERIFY_TOKEN,
      },
      event: {},
    };
    const own = await postEvent(body);
    expect(own.status).toBe(200);
    const unknown = await postEvent({
      ...body,
      header: { ...body.header, tenant_key: "tenant_unbound" },
    });
    expect(unknown.status).toBe(200);
    const foreignApp = await postEvent({
      ...body,
      header: { ...body.header, app_id: "cli_custom_foreign" },
    });
    expect(foreignApp.status).toBe(401);
    const wrongPath = await postEvent(
      body,
      true,
      `/api/webhooks/feishu/events/${status.body.installationId}`,
    );
    expect(wrongPath.status).toBe(404);
  });
  it("preserves the custom bot as the default and lets callers select Official explicitly", async () => {
    await createActor();
    const custom = await accept(
      customClient().setup({
        headers,
        body: {
          appId: `cli_custom_default_${randomUUID()}`,
          appSecret: "custom-secret",
          verificationToken: "custom-verify",
          encryptKey: "custom-encrypt",
          createNew: true,
        },
      }),
      [200],
    );
    if (!custom.body.installationId) {
      throw new Error("Expected custom installation");
    }
    await accept(
      customClient().updateInstallation({
        headers,
        params: { installationId: custom.body.installationId },
        body: { setupCompleted: true },
      }),
      [200],
    );
    await connect();
    const official = await accept(
      officialClient().getStatus({ headers }),
      [200],
    );
    if (!official.body.installationId) {
      throw new Error("Expected Official installation");
    }
    const messages = setupApp({
      context,
      routes: integrationsFeishuMessageRoutes,
    })(integrationsLarkMessageContract);
    // The default retains the custom bot's existing connection requirement.
    await accept(
      messages.sendMessage({
        headers,
        body: { chat: "oc_shared", text: "Default custom bot" },
      }),
      [403],
    );
    const sent = await accept(
      messages.sendMessage({
        headers,
        body: {
          chat: "oc_shared",
          text: "Selected Official bot",
          installationId: official.body.installationId,
        },
      }),
      [200],
    );
    expect(sent.body.ok).toBeTruthy();
  });
});
