import { randomUUID } from "node:crypto";
import { captureConnectorExternalState } from "./helpers/public-connector-actor";
import { publicRunOwner } from "./helpers/public-run-owner";
import { installSharedThreadStorage } from "./helpers/shared-thread-storage";

import {
  feishuConnectContract,
  larkConnectContract,
} from "@okouai/api-contracts/contracts/feishu-connect";
import { feishuOauthContract } from "@okouai/api-contracts/contracts/feishu-oauth";
import {
  integrationsFeishuMessageContract,
  integrationsFeishuUploadCompleteContract,
  integrationsFeishuUploadInitContract,
  integrationsLarkUploadCompleteContract,
  integrationsLarkUploadInitContract,
} from "@okouai/api-contracts/contracts/integrations";
import {
  FEISHU_PLATFORMS,
  type FeishuPlatform,
} from "@okouai/core/feishu-platform";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { feishuConnectRoutes } from "../feishu-connect";
import { feishuOauthRoutes } from "../feishu-oauth";
import { integrationsFeishuFileRoutes } from "../integrations-feishu-files";
import { integrationsFeishuMessageRoutes } from "../integrations-feishu-message";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createClaimedRunCredentials } from "./helpers/claimed-run-credentials";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";

const TEST_APP_ROUTES = Object.freeze([
  ...feishuConnectRoutes,
  ...feishuOauthRoutes,
  ...integrationsFeishuFileRoutes,
  ...integrationsFeishuMessageRoutes,
]);

const context = testContext();
const credentials = createClaimedRunCredentials(context);
const mocks = createRouteMocks(context);
const authOrgApi = createAuthOrgAgentsBddApi(context);
const chatApi = createChatFilesBddApi(context);
const runsApi = createRunsApi(context);

interface CapturedRequest {
  readonly kind: "reply" | "send";
  readonly receiveIdType: string | null;
  readonly target: string;
  readonly msgType: string;
  readonly content: Readonly<Record<string, unknown>>;
  readonly replyInThread: boolean;
}

interface FeishuRequestBody {
  readonly receive_id?: string;
  readonly msg_type: string;
  readonly content: string;
  readonly reply_in_thread?: boolean;
}

interface FeishuTestActor extends ApiTestUser {
  readonly orgId: string;
  readonly orgRole: "org:admin";
}

async function createOnboardedFeishuInstallation(
  actorOverride?: FeishuTestActor,
  platform: FeishuPlatform = "feishu",
  connected = true,
): Promise<{
  readonly actor: FeishuTestActor;
  readonly agentId: string;
  readonly installationId: string;
}> {
  const userId = `user_${randomUUID()}`;
  const actor: FeishuTestActor = actorOverride ?? {
    userId,
    orgId: `org_${randomUUID()}`,
    orgRole: "org:admin",
    email: `${userId}@example.test`,
  };
  await updateFeatureSwitchesForUser(context, actor, {
    [FEISHU_PLATFORMS[platform].featureSwitch]: true,
  });
  authOrgApi.acceptAgentStorageWrites();
  const bootstrap = await authOrgApi.bootstrapLimitedFreeOnboarding(actor, {
    displayName: "Feishu CLI agent",
  });
  const agent = await authOrgApi.readAgent(actor, bootstrap.body.agentId);
  await runsApi.grantProEntitlement(actor);
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  const client = setupApp({ context, routes: feishuConnectRoutes })(
    platform === "lark" ? larkConnectContract : feishuConnectContract,
  );
  const setup = await accept(
    client.setup({
      headers: { authorization: "Bearer clerk-session" },
      body: {
        appId: `cli_${randomUUID()}`,
        appSecret: "feishu-cli-secret",
        verificationToken: `verification_${randomUUID()}`,
        createNew: true,
      },
    }),
    [200],
  );
  const installationId = setup.body.installationId;
  if (!installationId) {
    throw new Error("Expected Feishu installation ID");
  }
  await accept(
    client.updateInstallation({
      headers: { authorization: "Bearer clerk-session" },
      params: { installationId },
      body: {
        setupCompleted: true,
      },
    }),
    [200],
  );
  mockClerkMembership(context, actor, "org:admin");
  if (connected) {
    await connectCurrentFeishuUser(actor, platform);
  }
  return { actor, agentId: agent.agentId, installationId };
}

function requireTestValue<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
  return value;
}

async function connectCurrentFeishuUser(
  actor: FeishuTestActor,
  platform: FeishuPlatform = "feishu",
): Promise<void> {
  const statusClient = setupApp({ context, routes: feishuConnectRoutes })(
    platform === "lark" ? larkConnectContract : feishuConnectContract,
  );
  const status = await accept(
    statusClient.getStatus({
      headers: { authorization: "Bearer clerk-session" },
    }),
    [200],
  );
  const connectUrl = requireTestValue(
    status.body.installations?.[0]?.connectUrl,
    "Expected Feishu OAuth connect URL",
  );
  const state = requireTestValue(
    new URL(connectUrl).searchParams.get("state"),
    "Expected Feishu OAuth state",
  );
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  const oauthClient = setupApp({ context, routes: feishuOauthRoutes })(
    feishuOauthContract,
  );
  await accept(
    oauthClient.callback({
      query: { code: "feishu-cli-oauth-code", state },
      extraHeaders: { cookie: "__session=opaque" },
    }),
    [307],
  );
  await flushWaitUntilForTest();
}

describe("POST /api/integrations/feishu/message", () => {
  let captured: CapturedRequest[];

  beforeEach(() => {
    captured = [];
    mockEnv("OKOU_WEB_URL", "https://www.okou.test");
    mockEnv("APP_URL", "https://app.okou.test");
    mockEnv("FEISHU_CALLBACK_BASE_URL", "https://www.okou.test");
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    context.mocks.ably.publish.mockResolvedValue(undefined);

    for (const origin of [
      "https://open.feishu.cn",
      "https://open.larksuite.com",
    ]) {
      server.use(
        http.get(
          `${origin}/open-apis/im/v1/messages/:messageId`,
          ({ params }) => {
            return HttpResponse.json({
              code: 0,
              data: {
                items: [
                  { message_id: params.messageId, chat_id: "oc_target_chat" },
                ],
              },
            });
          },
        ),
        http.get(`${origin}/open-apis/im/v1/chats/:chatId`, () => {
          return HttpResponse.json({
            code: 0,
            data: { chat_mode: "group", moderation_permission: "all_members" },
          });
        }),
        http.get(
          `${origin}/open-apis/im/v1/chats/:chatId/members/is_in_chat`,
          () => {
            return HttpResponse.json({ code: 0, data: { is_in_chat: true } });
          },
        ),
        http.get(`${origin}/open-apis/im/v1/chats/:chatId/members`, () => {
          return HttpResponse.json({
            code: 0,
            data: {
              items: [
                { member_id: "ou_current_user", member_id_type: "open_id" },
              ],
              has_more: false,
            },
          });
        }),
        http.post(
          `${origin}/open-apis/auth/v3/tenant_access_token/internal`,
          () => {
            return HttpResponse.json({
              code: 0,
              tenant_access_token: "tenant-access-token",
              expire: 7200,
            });
          },
        ),
        http.get(`${origin}/open-apis/bot/v3/info`, () => {
          return HttpResponse.json({
            code: 0,
            bot: {
              open_id: "ou_feishu_cli_bot",
              app_name: "Feishu CLI Bot",
            },
          });
        }),
        http.post(`${origin}/open-apis/authen/v2/oauth/token`, () => {
          return HttpResponse.json({
            code: 0,
            access_token: "feishu-cli-user-access-token",
            refresh_token: "feishu-cli-user-refresh-token",
            expires_in: 7200,
          });
        }),
        http.get(`${origin}/open-apis/authen/v1/user_info`, () => {
          return HttpResponse.json({
            code: 0,
            data: {
              name: "Feishu CLI User",
              open_id: "ou_current_user",
              tenant_key: "tenant_feishu_cli",
            },
          });
        }),
        http.post(`${origin}/open-apis/im/v1/messages`, async ({ request }) => {
          const body = (await request.json()) as FeishuRequestBody;
          const url = new URL(request.url);
          captured.push({
            kind: "send",
            receiveIdType: url.searchParams.get("receive_id_type"),
            target: body.receive_id ?? "",
            msgType: body.msg_type,
            content: JSON.parse(body.content) as Readonly<
              Record<string, unknown>
            >,
            replyInThread: false,
          });
          return HttpResponse.json({
            code: 0,
            data: {
              message_id: `om_${captured.length}`,
              chat_id: "oc_feishu_cli",
            },
          });
        }),
        http.post(
          `${origin}/open-apis/im/v1/messages/:messageId/reply`,
          async ({ params, request }) => {
            const body = (await request.json()) as FeishuRequestBody;
            captured.push({
              kind: "reply",
              receiveIdType: null,
              target: String(params.messageId),
              msgType: body.msg_type,
              content: JSON.parse(body.content) as Readonly<
                Record<string, unknown>
              >,
              replyInThread: body.reply_in_thread ?? false,
            });
            return HttpResponse.json({
              code: 0,
              data: {
                message_id: `om_${captured.length}`,
                chat_id: "oc_feishu_cli",
              },
            });
          },
        ),
      );
    }
  });

  it("requires authentication and the feishu:write capability", async () => {
    const client = setupApp({
      context,
      routes: integrationsFeishuMessageRoutes,
    })(integrationsFeishuMessageContract);
    const unauthenticated = await accept(
      client.sendMessage({
        headers: {},
        body: { chat: "oc_chat", text: "hello" },
      }),
      [401],
    );
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const forbidden = await accept(
      client.sendMessage({
        headers: {
          authorization: `Bearer ${await credentials.sandboxToken({ userId: `user_${randomUUID()}`, orgId: `org_${randomUUID()}` })}`,
        },
        body: { chat: "oc_chat", text: "hello" },
      }),
      [403],
    );
    expect(forbidden.body.error.message).toContain("feishu:write");
  });

  it("sends chat, current-user, and threaded reply messages", async () => {
    const { actor, installationId } = await createOnboardedFeishuInstallation();
    captured = [];
    const token = await credentials.okouToken(actor);
    const client = setupApp({
      context,
      routes: integrationsFeishuMessageRoutes,
    })(integrationsFeishuMessageContract);

    const chat = await accept(
      client.sendMessage({
        headers: { authorization: `Bearer ${token}` },
        body: {
          installationId,
          chat: "oc_target_chat",
          text: "Hello chat",
        },
      }),
      [200],
    );
    expect(chat.body).toStrictEqual({
      ok: true,
      messageId: "om_1",
      chatId: "oc_feishu_cli",
    });

    await accept(
      client.sendMessage({
        headers: { authorization: `Bearer ${token}` },
        body: {
          installationId,
          user: "me",
          card: {
            schema: "2.0",
            body: { elements: [] },
          },
        },
      }),
      [200],
    );
    await accept(
      client.sendMessage({
        headers: { authorization: `Bearer ${token}` },
        body: {
          installationId,
          replyToMessageId: "om_parent",
          replyInThread: true,
          text: "Thread reply",
        },
      }),
      [200],
    );

    expect(captured).toStrictEqual([
      {
        kind: "send",
        receiveIdType: "chat_id",
        target: "oc_target_chat",
        msgType: "text",
        content: { text: "Hello chat" },
        replyInThread: false,
      },
      {
        kind: "send",
        receiveIdType: "open_id",
        target: "ou_current_user",
        msgType: "interactive",
        content: {
          schema: "2.0",
          body: { elements: [] },
        },
        replyInThread: false,
      },
      {
        kind: "reply",
        receiveIdType: null,
        target: "om_parent",
        msgType: "text",
        content: { text: "Thread reply" },
        replyInThread: true,
      },
    ]);
  });

  it("maps Feishu request and response failures to contract errors", async () => {
    const { actor, installationId } = await createOnboardedFeishuInstallation();
    let requestCount = 0;
    server.use(
      http.post("https://open.feishu.cn/open-apis/im/v1/messages", () => {
        requestCount += 1;
        return requestCount === 1
          ? HttpResponse.json({ code: 230_001, msg: "chat not found" })
          : HttpResponse.json({ code: 0, data: {} });
      }),
    );
    const client = setupApp({
      context,
      routes: integrationsFeishuMessageRoutes,
    })(integrationsFeishuMessageContract);
    const headers = {
      authorization: `Bearer ${await credentials.okouToken(actor)}`,
    };
    const body = {
      installationId,
      chat: "oc_missing",
      text: "Hello",
    } as const;

    const rejected = await accept(client.sendMessage({ headers, body }), [400]);
    expect(rejected.body.error).toStrictEqual({
      code: "FEISHU_ERROR",
      message: "Feishu API error: chat not found",
    });

    const incomplete = await accept(
      client.sendMessage({ headers, body }),
      [502],
    );
    expect(incomplete.body.error).toStrictEqual({
      code: "FEISHU_ERROR",
      message: "Feishu API error: Feishu message response is incomplete",
    });
  });

  it.each(["feishu", "lark"] as const)(
    "denies %s writes and downloads after the user leaves the chat",
    async (platform) => {
      const { actor, installationId } = await createOnboardedFeishuInstallation(
        undefined,
        platform,
      );
      captured = [];
      const origin = FEISHU_PLATFORMS[platform].apiOrigin;
      server.use(
        http.get(`${origin}/open-apis/im/v1/chats/:chatId/members`, () => {
          return HttpResponse.json({
            code: 0,
            data: {
              items: [
                { member_id: "ou_someone_else", member_id_type: "open_id" },
              ],
              has_more: false,
            },
          });
        }),
      );
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const headers = {
        authorization: `Bearer ${await credentials.okouToken(actor)}`,
        "content-type": "application/json",
      };
      for (const target of [
        { chat: "oc_target_chat" },
        { replyToMessageId: "om_parent" },
      ]) {
        const response = await app.request(
          `/api/integrations/${platform}/message`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              installationId,
              ...target,
              text: "blocked",
            }),
          },
        );
        expect(response.status).toBe(403);
      }
      const query = new URLSearchParams({
        installation_id: installationId,
        message_id: "om_parent",
        file_key: "file_private",
        type: "file",
      });
      const response = await app.request(
        `/api/integrations/${platform}/download-file?${query}`,
        { headers },
      );
      expect(response.status).toBe(403);
      expect(captured).toStrictEqual([]);
    },
  );

  it.each(["feishu", "lark"] as const)(
    "allows outbound %s DMs without granting private file access",
    async (platform) => {
      const { actor, installationId } = await createOnboardedFeishuInstallation(
        undefined,
        platform,
      );
      captured = [];
      const origin = FEISHU_PLATFORMS[platform].apiOrigin;
      server.use(
        http.get(`${origin}/open-apis/im/v1/chats/:chatId`, () => {
          return HttpResponse.json({ code: 0, data: { chat_mode: "p2p" } });
        }),
        http.get(`${origin}/open-apis/im/v1/chats/:chatId/members`, () => {
          return HttpResponse.json({
            code: 0,
            data: {
              items: [{ member_id: "ou_recipient", member_id_type: "open_id" }],
              has_more: false,
            },
          });
        }),
      );
      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const headers = {
        authorization: `Bearer ${await credentials.okouToken(actor)}`,
        "content-type": "application/json",
      };
      for (const target of [
        { user: "ou_recipient" },
        { chat: "oc_target_chat" },
        { replyToMessageId: "om_parent" },
      ]) {
        const response = await app.request(
          `/api/integrations/${platform}/message`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              installationId,
              ...target,
              text: "Hello recipient",
            }),
          },
        );
        expect(response.status).toBe(200);
      }
      expect(captured[0]).toMatchObject({
        receiveIdType: "open_id",
        target: "ou_recipient",
      });
      expect(captured).toHaveLength(3);
      const query = new URLSearchParams({
        installation_id: installationId,
        message_id: "om_parent",
        file_key: "private-file",
        type: "file",
      });
      const denied = await app.request(
        `/api/integrations/${platform}/download-file?${query}`,
        { headers },
      );
      expect(denied.status).toBe(403);
    },
  );

  it("checks every Feishu membership page before allowing a shared chat", async () => {
    const { actor, installationId } = await createOnboardedFeishuInstallation();
    captured = [];
    const pages: (string | null)[] = [];
    server.use(
      http.get(
        "https://open.feishu.cn/open-apis/im/v1/chats/:chatId/members",
        ({ request }) => {
          const page = new URL(request.url).searchParams.get("page_token");
          pages.push(page);
          return HttpResponse.json({
            code: 0,
            data: page
              ? {
                  items: [
                    { member_id: "ou_current_user", member_id_type: "open_id" },
                  ],
                  has_more: false,
                }
              : { items: [], has_more: true, page_token: "second-page" },
          });
        },
      ),
    );
    await accept(
      setupApp({ context, routes: integrationsFeishuMessageRoutes })(
        integrationsFeishuMessageContract,
      ).sendMessage({
        headers: {
          authorization: `Bearer ${await credentials.okouToken(actor)}`,
        },
        body: { installationId, chat: "oc_target_chat", text: "allowed" },
      }),
      [200],
    );
    expect(pages).toStrictEqual([null, "second-page"]);
    expect(captured).toHaveLength(1);
  });

  it.each(["absent bot", "provider unavailable", "invalid provider data"])(
    "denies a Feishu write with %s",
    async (reason) => {
      const { actor, installationId } =
        await createOnboardedFeishuInstallation();
      captured = [];
      server.use(
        http.get(
          "https://open.feishu.cn/open-apis/im/v1/chats/:chatId/members/is_in_chat",
          () => {
            if (reason === "provider unavailable") {
              return new HttpResponse(null, { status: 503 });
            }
            return HttpResponse.json({
              code: 0,
              data: reason === "absent bot" ? { is_in_chat: false } : {},
            });
          },
        ),
      );
      const response = await accept(
        setupApp({ context, routes: integrationsFeishuMessageRoutes })(
          integrationsFeishuMessageContract,
        ).sendMessage({
          headers: {
            authorization: `Bearer ${await credentials.okouToken(actor)}`,
          },
          body: { installationId, chat: "oc_target_chat", text: "blocked" },
        }),
        [403, 502],
      );
      expect(response.status).toBe(reason === "absent bot" ? 403 : 502);
      expect(captured).toStrictEqual([]);
    },
  );

  it("requires a verified Feishu identity for raw chat and user IDs", async () => {
    const { actor, installationId } = await createOnboardedFeishuInstallation(
      undefined,
      "feishu",
      false,
    );
    captured = [];
    const token = await credentials.okouToken(actor);
    const client = setupApp({
      context,
      routes: integrationsFeishuMessageRoutes,
    })(integrationsFeishuMessageContract);
    for (const target of [
      { chat: "oc_target_chat" },
      { user: "ou_current_user" },
    ]) {
      const response = await accept(
        client.sendMessage({
          headers: { authorization: `Bearer ${token}` },
          body: { installationId, ...target, text: "blocked" },
        }),
        [403],
      );
      expect(response.body.error.code).toBe("FEISHU_ERROR");
    }
    expect(captured).toStrictEqual([]);
  });

  it("does not borrow a bot's posting permission in a restricted Feishu group", async () => {
    const { actor, installationId } = await createOnboardedFeishuInstallation();
    captured = [];
    server.use(
      http.get("https://open.feishu.cn/open-apis/im/v1/chats/:chatId", () => {
        return HttpResponse.json({
          code: 0,
          data: {
            chat_mode: "group",
            moderation_permission: "only_owner",
            owner_id: "ou_owner",
            user_manager_id_list: [],
          },
        });
      }),
    );
    const response = await accept(
      setupApp({ context, routes: integrationsFeishuMessageRoutes })(
        integrationsFeishuMessageContract,
      ).sendMessage({
        headers: {
          authorization: `Bearer ${await credentials.okouToken(actor)}`,
        },
        body: { installationId, chat: "oc_target_chat", text: "blocked" },
      }),
      [403],
    );
    expect(response.body.error.code).toBe("FEISHU_ERROR");
    expect(captured).toStrictEqual([]);
  });

  it.each(["owner", "manager", "moderator", "other"] as const)(
    "checks the Feishu caller's restricted-group role: %s",
    async (role) => {
      const { actor, installationId } =
        await createOnboardedFeishuInstallation();
      captured = [];
      server.use(
        http.get("https://open.feishu.cn/open-apis/im/v1/chats/:chatId", () => {
          return HttpResponse.json({
            code: 0,
            data: {
              chat_mode: "group",
              moderation_permission: "moderator_list",
              owner_id: role === "owner" ? "ou_current_user" : "ou_owner",
              user_manager_id_list:
                role === "manager" ? ["ou_current_user"] : [],
            },
          });
        }),
        http.get(
          "https://open.feishu.cn/open-apis/im/v1/chats/:chatId/moderation",
          () => {
            return HttpResponse.json({
              code: 0,
              data: {
                moderation_setting: "moderator_list",
                items: [
                  {
                    user_id:
                      role === "moderator"
                        ? "ou_current_user"
                        : "ou_someone_else",
                    user_id_type: "open_id",
                  },
                ],
                has_more: false,
              },
            });
          },
        ),
      );
      const response = await accept(
        setupApp({ context, routes: integrationsFeishuMessageRoutes })(
          integrationsFeishuMessageContract,
        ).sendMessage({
          headers: {
            authorization: `Bearer ${await credentials.okouToken(actor)}`,
          },
          body: {
            installationId,
            chat: "oc_target_chat",
            text: "role-checked",
          },
        }),
        [200, 403],
      );
      expect(response.status).toBe(role === "other" ? 403 : 200);
      expect(captured).toHaveLength(role === "other" ? 0 : 1);
    },
  );

  it.each(["feishu", "lark"] as const)(
    "downloads a resource from a %s message",
    async (platform) => {
      const { actor, installationId } = await createOnboardedFeishuInstallation(
        undefined,
        platform,
      );
      const payload = Buffer.from("feishu resource bytes");
      server.use(
        http.get(
          `${FEISHU_PLATFORMS[platform].apiOrigin}/open-apis/im/v1/messages/:messageId/resources/:fileKey`,
          ({ params, request }) => {
            expect(params.messageId).toBe("om_resource");
            expect(params.fileKey).toBe("file_resource");
            expect(new URL(request.url).searchParams.get("type")).toBe("file");
            expect(request.headers.get("authorization")).toBe(
              "Bearer tenant-access-token",
            );
            return new HttpResponse(payload, {
              status: 200,
              headers: {
                "content-type": "application/pdf",
                "content-length": String(payload.length),
                "content-disposition": 'attachment; filename="report.pdf"',
              },
            });
          },
        ),
      );

      const app = createApp({
        signal: context.signal,
        routes: TEST_APP_ROUTES,
      });
      const query = new URLSearchParams({
        installation_id: installationId,
        message_id: "om_resource",
        file_key: "file_resource",
        type: "file",
      });
      const response = await app.request(
        `/api/integrations/${platform}/download-file?${query.toString()}`,
        {
          headers: {
            authorization: `Bearer ${await credentials.okouToken({ ...actor })}`,
          },
        },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/pdf");
      expect(response.headers.get("x-file-name")).toBe("report.pdf");
      expect(response.headers.get("x-file-mimetype")).toBe("application/pdf");
      expect(
        Buffer.from(await response.arrayBuffer()).equals(payload),
      ).toBeTruthy();
    },
  );

  it.each([
    ["feishu", false, false],
    ["lark", false, false],
    ["feishu", true, false],
    ["lark", true, false],
    ["feishu", false, true],
    ["lark", false, true],
  ] as const)(
    "authorizes a stored %s file (membership revoked: %s; other recipient DM: %s)",
    async (platform, revokeDuringUpload, otherRecipient) => {
      const { actor, agentId, installationId } =
        await createOnboardedFeishuInstallation(undefined, platform);
      await runsApi.grantProEntitlement(actor);
      await runsApi.ensurePersonalSubscriptionModel(actor);
      const runnerGroup = runsApi.configureRunnerGroup();
      await runsApi.heartbeatRunner(runnerGroup);
      const owner = publicRunOwner(context, actor, {
        restoreEnvironment: captureConnectorExternalState(context),
      });
      const sent = await owner.run(() => {
        return chatApi.sendAndLaunch(actor, {
          agentId,
          prompt: "Create a run for Feishu file upload completion",
        });
      });
      const claim = await owner.run(() => {
        return owner.claim(sent.runId);
      });
      const token = claim.platformEnvironment?.OKOU_TOKEN;
      if (!token) {
        throw new Error("Expected the claimed Okou token");
      }
      const content = Buffer.from("feishu upload bytes");
      installSharedThreadStorage(context);
      const initClient = setupApp({
        context,
        routes: integrationsFeishuFileRoutes,
      })(
        platform === "lark"
          ? integrationsLarkUploadInitContract
          : integrationsFeishuUploadInitContract,
      );
      const initialized = await accept(
        initClient.init({
          headers: { authorization: `Bearer ${token}` },
          body: {
            filename: "report.pdf",
            contentType: "application/pdf",
            length: content.length,
          },
        }),
        [200],
      );
      const uploaded = await fetch(initialized.body.uploadUrl, {
        method: "PUT",
        headers: initialized.body.uploadHeaders,
        body: content,
      });
      expect(uploaded.status).toBe(200);

      let memberPresent = true;
      server.use(
        http.get(
          `${FEISHU_PLATFORMS[platform].apiOrigin}/open-apis/im/v1/chats/:chatId/members`,
          () => {
            return HttpResponse.json({
              code: 0,
              data: {
                items: memberPresent
                  ? [
                      {
                        member_id: "ou_current_user",
                        member_id_type: "open_id",
                      },
                    ]
                  : [],
                has_more: false,
              },
            });
          },
        ),
        http.post(
          `${FEISHU_PLATFORMS[platform].apiOrigin}/open-apis/im/v1/files`,
          async ({ request }) => {
            expect(request.headers.get("authorization")).toBe(
              "Bearer tenant-access-token",
            );
            const form = await request.formData();
            expect(form.get("file_type")).toBe("stream");
            expect(form.get("file_name")).toBe("report.pdf");
            const file = form.get("file");
            if (!(file instanceof Blob)) {
              throw new Error("Expected Feishu upload to include file bytes");
            }
            await expect(file.text()).resolves.toBe(content.toString());
            memberPresent = !revokeDuringUpload;
            return HttpResponse.json({
              code: 0,
              data: { file_key: "file_uploaded" },
            });
          },
        ),
      );
      captured = [];
      const completeClient = setupApp({
        context,
        routes: integrationsFeishuFileRoutes,
      })(
        platform === "lark"
          ? integrationsLarkUploadCompleteContract
          : integrationsFeishuUploadCompleteContract,
      );
      const completed = await accept(
        completeClient.complete({
          headers: { authorization: `Bearer ${token}` },
          body: {
            uploadId: initialized.body.uploadId,
            installationId,
            ...(otherRecipient
              ? { user: "ou_recipient" }
              : { chat: "oc_file_target" }),
            contentType: "application/pdf",
          },
        }),
        [200, 403],
      );

      if (revokeDuringUpload) {
        expect(completed.status).toBe(403);
        expect(captured).toStrictEqual([]);
        return;
      }
      if (completed.status !== 200) {
        throw new Error("Expected an authorized Feishu file delivery");
      }
      expect(completed.body).toMatchObject({
        messageId: "om_1",
        chatId: "oc_feishu_cli",
        fileKey: "file_uploaded",
        filename: "report.pdf",
        mimetype: "application/pdf",
        size: content.length,
      });
      expect(completed.body.url).toBe(initialized.body.fileUrl);
      expect(completed.body.url).toMatch(
        /^https?:\/\/[^/]+\/artifacts\/[a-z0-9]{10}\.pdf$/u,
      );
      expect(captured).toStrictEqual([
        {
          kind: "send",
          receiveIdType: otherRecipient ? "open_id" : "chat_id",
          target: otherRecipient ? "ou_recipient" : "oc_file_target",
          msgType: "file",
          content: { file_key: "file_uploaded" },
          replyInThread: false,
        },
      ]);
      const artifacts = await chatApi.listThreadArtifacts(actor, sent.threadId);
      const files =
        artifacts.runs.find((run) => {
          return run.runId === sent.runId;
        })?.files ?? [];
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({
        id: "om_1",
        filename: "report.pdf",
        contentType: "application/pdf",
        size: content.length,
        url: completed.body.url,
      });
    },
  );
});
