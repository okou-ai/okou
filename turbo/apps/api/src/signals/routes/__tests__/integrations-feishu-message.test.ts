import { privateIntegrationArtifact } from "./helpers/integration-output-artifacts";
import { randomUUID } from "node:crypto";

import { GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import {
  integrationsFeishuMessageContract,
  integrationsLarkMessageContract,
  integrationsLarkUploadCompleteContract,
  integrationsLarkUploadInitContract,
  integrationsFeishuUploadCompleteContract,
  integrationsFeishuUploadInitContract,
} from "@okouai/api-contracts/contracts/integrations";
import {
  feishuConnectContract,
  larkConnectContract,
} from "@okouai/api-contracts/contracts/feishu-connect";
import { feishuOauthContract } from "@okouai/api-contracts/contracts/feishu-oauth";
import {
  FEISHU_PLATFORMS,
  type FeishuPlatform,
} from "@okouai/core/feishu-platform";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { now } from "../../../lib/time";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";
import { feishuConnectRoutes } from "../feishu-connect";
import { feishuOauthRoutes } from "../feishu-oauth";
import { integrationsFeishuFileRoutes } from "../integrations-feishu-files";
import { integrationsFeishuMessageRoutes } from "../integrations-feishu-message";

const TEST_APP_ROUTES = Object.freeze([
  ...feishuConnectRoutes,
  ...feishuOauthRoutes,
  ...integrationsFeishuFileRoutes,
  ...integrationsFeishuMessageRoutes,
]);

const context = testContext();
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

function okouToken(args: {
  readonly platform?: FeishuPlatform;
  readonly userId: string;
  readonly orgId: string;
  readonly runId?: string;
}): string {
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "okou",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId ?? `run_${randomUUID()}`,
    capabilities: [args.platform === "lark" ? "lark:write" : "feishu:write"],
    iat: seconds,
    exp: seconds + 60,
  });
}

function sandboxToken(args: {
  readonly userId: string;
  readonly orgId: string;
}): string {
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "sandbox",
    userId: args.userId,
    orgId: args.orgId,
    runId: `run_${randomUUID()}`,
    iat: seconds,
    exp: seconds + 60,
  });
}

interface FeishuTestActor extends ApiTestUser {
  readonly orgId: string;
  readonly orgRole: "org:admin";
}

async function setupFeishuInstallation(
  actorOverride?: FeishuTestActor,
  platform: FeishuPlatform = "feishu",
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
  const agent = await authOrgApi.createAgent(actor, {
    displayName: "Feishu CLI agent",
    visibility: "public",
  });
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
        defaultAgentId: agent.agentId,
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
        defaultAgentId: agent.agentId,
        setupCompleted: true,
      },
    }),
    [200],
  );
  mockClerkMembership(context, actor, "org:admin");
  return { actor, agentId: agent.agentId, installationId };
}

function requireTestValue<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
  return value;
}

async function connectCurrentFeishuUser(actor: FeishuTestActor): Promise<void> {
  const statusClient = setupApp({ context, routes: feishuConnectRoutes })(
    feishuConnectContract,
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

  it.each(["feishu", "lark"] as const)(
    "snapshots %s text and nested cards before proactive sends",
    async (platform) => {
      const { actor, installationId } = await setupFeishuInstallation(
        undefined,
        platform,
      );
      const artifact = await privateIntegrationArtifact(context, actor);
      captured = [];
      const client = setupApp({
        context,
        routes: integrationsFeishuMessageRoutes,
      })(
        platform === "lark"
          ? integrationsLarkMessageContract
          : integrationsFeishuMessageContract,
      );
      const headers = { authorization: "Bearer clerk-session" };
      await accept(
        client.sendMessage({
          headers,
          body: { installationId, chat: "oc_report", text: artifact.url },
        }),
        [200],
      );
      await artifact.expectDelivered(JSON.stringify(captured[0]?.content));
      const action = "https://app.okou.test/api/connector/authorize?code=keep";
      await accept(
        client.sendMessage({
          headers,
          body: {
            installationId,
            replyToMessageId: "om_parent",
            replyInThread: true,
            card: {
              schema: "2.0",
              config: { wide_screen_mode: true },
              body: {
                elements: [
                  {
                    tag: "markdown",
                    content: `Report "quoted"\n${artifact.url}`,
                  },
                  { tag: "button", url: artifact.url },
                  { tag: "button", url: action },
                ],
              },
            },
          },
        }),
        [200],
      );
      const delivered = await artifact.expectDelivered(
        JSON.stringify(captured[1]?.content),
      );
      expect(captured[1]).toMatchObject({
        kind: "reply",
        target: "om_parent",
        replyInThread: true,
        msgType: "interactive",
        content: {
          schema: "2.0",
          config: { wide_screen_mode: true },
          body: {
            elements: [
              { tag: "markdown", content: `Report "quoted"\n${delivered}` },
              { tag: "button", url: delivered },
              { tag: "button", url: action },
            ],
          },
        },
      });
    },
  );

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
          authorization: `Bearer ${sandboxToken({
            userId: `user_${randomUUID()}`,
            orgId: `org_${randomUUID()}`,
          })}`,
        },
        body: { chat: "oc_chat", text: "hello" },
      }),
      [403],
    );
    expect(forbidden.body.error.message).toContain("feishu:write");
  });

  it("sends chat, current-user, and threaded reply messages", async () => {
    const { actor, installationId } = await setupFeishuInstallation();
    await connectCurrentFeishuUser(actor);
    captured = [];
    const token = okouToken(actor);
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
    const { actor, installationId } = await setupFeishuInstallation();
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
      authorization: `Bearer ${okouToken(actor)}`,
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
    "downloads a resource from a %s message",
    async (platform) => {
      const { actor, installationId } = await setupFeishuInstallation(
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
            authorization: `Bearer ${okouToken({ ...actor, platform })}`,
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

  it.each(["feishu", "lark"] as const)(
    "uploads a stored file and sends it as a %s message",
    async (platform) => {
      const { actor, agentId, installationId } = await setupFeishuInstallation(
        undefined,
        platform,
      );
      await runsApi.grantProEntitlement(actor);
      await runsApi.ensureOrgModelProvider(actor);
      const runnerGroup = runsApi.configureRunnerGroup();
      await runsApi.heartbeatRunner(runnerGroup);
      const sent = await chatApi.requestSendEvent(
        actor,
        {
          agentId,
          prompt: "Create a run for Feishu file upload completion",
        },
        [201],
      );
      if (sent.status !== 201 || sent.body.runId === null) {
        throw new Error("Expected chat send to create a run for Feishu upload");
      }
      const token = okouToken({ ...actor, platform, runId: sent.body.runId });
      const content = Buffer.from("feishu upload bytes");
      context.mocks.s3.getSignedUrl.mockResolvedValue(
        "https://storage.test/feishu-upload",
      );
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
      const key = `artifacts/${encodeURIComponent(actor.userId)}/${initialized.body.uploadId}/report.pdf`;
      context.mocks.s3.send.mockImplementation((command: unknown) => {
        if (command instanceof ListObjectsV2Command) {
          return Promise.resolve({
            Contents: [
              {
                Key: key,
                Size: content.length,
                LastModified: new Date("2026-01-01T00:00:00.000Z"),
              },
            ],
          });
        }
        if (command instanceof GetObjectCommand) {
          return Promise.resolve({
            ContentLength: content.length,
            Body: (async function* stream(): AsyncIterable<Uint8Array> {
              yield content;
            })(),
          });
        }
        return Promise.resolve({});
      });

      server.use(
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
            chat: "oc_file_target",
            contentType: "application/pdf",
          },
        }),
        [200],
      );

      expect(completed.body).toMatchObject({
        messageId: "om_1",
        chatId: "oc_feishu_cli",
        fileKey: "file_uploaded",
        filename: "report.pdf",
        mimetype: "application/pdf",
        size: content.length,
      });
      expect(completed.body.url).toContain(initialized.body.uploadId);
      expect(captured).toStrictEqual([
        {
          kind: "send",
          receiveIdType: "chat_id",
          target: "oc_file_target",
          msgType: "file",
          content: { file_key: "file_uploaded" },
          replyInThread: false,
        },
      ]);
      const artifacts = await chatApi.listThreadArtifacts(
        actor,
        sent.body.threadId,
      );
      const files =
        artifacts.runs.find((run) => {
          return run.runId === sent.body.runId;
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
