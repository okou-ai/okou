import {
  createCipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";

import {
  feishuConnectContract,
  larkConnectContract,
} from "@okouai/api-contracts/contracts/feishu-connect";
import { feishuEventsContract } from "@okouai/api-contracts/contracts/feishu-events";
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
import { feishuEventsRoutes } from "../feishu-events";
import { feishuConnectRoutes } from "../feishu-connect";
import { feishuOauthRoutes } from "../feishu-oauth";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

const API_ORIGINS = {
  feishu: "https://open.feishu.cn",
  lark: "https://open.larksuite.com",
} as const;

interface Admin {
  readonly userId: string;
  readonly orgId: string;
}

function signIn(admin: Admin): { authorization: string } {
  createRouteMocks(context).clerk.session(admin.userId, admin.orgId);
  return { authorization: "Bearer clerk-session" };
}

function connectClient(platform: "feishu" | "lark") {
  return setupApp({ context, routes: feishuConnectRoutes })(
    platform === "lark" ? larkConnectContract : feishuConnectContract,
  );
}

function acceptBotCredentials(platform: "feishu" | "lark"): void {
  server.use(
    http.post(
      `${API_ORIGINS[platform]}/open-apis/auth/v3/tenant_access_token/internal`,
      () => {
        return HttpResponse.json({
          code: 0,
          tenant_access_token: `${platform}-tenant-token`,
          expire: 7200,
        });
      },
    ),
    http.get(`${API_ORIGINS[platform]}/open-apis/bot/v3/info`, () => {
      return HttpResponse.json({
        code: 0,
        bot: { open_id: `ou_${platform}_bot`, app_name: `${platform} bot` },
      });
    }),
  );
}

interface Installation {
  readonly installationId: string;
  readonly appId: string;
  readonly verificationToken: string;
  readonly encryptKey: string;
}

/** The admin sets up and completes one installation on the platform. */
async function installCompleted(
  admin: Admin,
  platform: "feishu" | "lark",
): Promise<Installation> {
  acceptBotCredentials(platform);
  context.mocks.s3.send.mockResolvedValue({ ETag: "fixture-etag" });
  const appId = `cli_${platform}_${randomUUID()}`;
  const verificationToken = `${platform}-token-${randomUUID()}`;
  const encryptKey = `${platform}-encrypt-${randomUUID()}`;
  const configured = await accept(
    connectClient(platform).setup({
      headers: signIn(admin),
      body: {
        appId,
        appSecret: `${platform}-secret`,
        verificationToken,
        encryptKey,
      },
    }),
    [200],
  );
  const installationId = configured.body.installationId;
  if (!installationId) {
    throw new Error(`Expected a configured ${platform} installation`);
  }
  await accept(
    connectClient(platform).updateInstallation({
      headers: signIn(admin),
      params: { installationId },
      body: { setupCompleted: true },
    }),
    [200],
  );
  return { installationId, appId, verificationToken, encryptKey };
}

function oauthClient() {
  return setupApp({ context, routes: feishuOauthRoutes })(feishuOauthContract);
}

/** Lark delivers an encrypted, signed event to the installation's callback. */
async function deliverEvent(installation: Installation, payload: unknown) {
  const iv = randomBytes(16);
  const cipher = createCipheriv(
    "aes-256-cbc",
    createHash("sha256").update(installation.encryptKey).digest(),
    iv,
  );
  const body = JSON.stringify({
    encrypt: Buffer.concat([
      iv,
      cipher.update(JSON.stringify(payload), "utf8"),
      cipher.final(),
    ]).toString("base64"),
  });
  const timestamp = String(Math.floor(now() / 1000));
  const nonce = randomUUID();
  return await setupRawAppRequest({ context, routes: feishuEventsRoutes })(
    feishuEventsContract.post.path.replace(
      ":installationId",
      installation.installationId,
    ),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-lark-request-timestamp": timestamp,
        "x-lark-request-nonce": nonce,
        "x-lark-signature": createHash("sha256")
          .update(`${timestamp}${nonce}${installation.encryptKey}${body}`)
          .digest("hex"),
      },
      body,
    },
  );
}

async function larkAdmin(): Promise<Admin> {
  mockEnv("APP_URL", "https://app.okou.ai");
  const admin = {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
  };
  await updateFeatureSwitchesForUser(context, admin, {
    [FeatureSwitchKey.LarkIntegration]: true,
    [FeatureSwitchKey.FeishuIntegration]: true,
  });
  return admin;
}

async function readStatus(admin: Admin, platform: "feishu" | "lark") {
  const status = await accept(
    connectClient(platform).getStatus({ headers: signIn(admin) }),
    [200],
  );
  return status.body;
}

describe("Lark integration", () => {
  it("lark-integration-007 answers an incoming Lark message with a Lark account-connect card", async () => {
    const admin = await larkAdmin();
    const installation = await installCompleted(admin, "lark");
    const replies: { messageId: string; body: unknown }[] = [];
    server.use(
      http.post(
        `${API_ORIGINS.lark}/open-apis/im/v1/messages/:messageId/reply`,
        async ({ request, params }) => {
          replies.push({
            messageId: String(params.messageId),
            body: await request.json(),
          });
          return HttpResponse.json({
            code: 0,
            data: { message_id: "om_connect_card", chat_id: "oc_private" },
          });
        },
      ),
    );

    const response = await deliverEvent(installation, {
      schema: "2.0",
      header: {
        event_id: `evt_${randomUUID()}`,
        event_type: "im.message.receive_v1",
        create_time: String(now()),
        token: installation.verificationToken,
        app_id: installation.appId,
        tenant_key: "lark-tenant",
      },
      event: {
        sender: {
          sender_id: { open_id: "ou_unconnected" },
          sender_type: "user",
          tenant_key: "lark-tenant",
        },
        message: {
          message_id: "om_hello",
          chat_id: "oc_private",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "Hello" }),
          create_time: String(now()),
        },
      },
    });
    await flushWaitUntilForTest();

    expect(response.status).toBe(200);
    const reply = replies.find((candidate) => {
      return candidate.messageId === "om_hello";
    });
    if (!reply) {
      throw new Error("Expected a reply to the incoming Lark message");
    }
    const card = JSON.stringify(reply.body);
    expect(reply.body).toMatchObject({
      msg_type: "interactive",
      reply_in_thread: true,
    });
    expect(card).toContain("in Lark");
    expect(card).toContain("/settings/lark?");
    expect(card).not.toContain("/settings/feishu");
  });

  it("lark-integration-004 uses Lark for OAuth, user identity and the bot deep link", async () => {
    const admin = await larkAdmin();
    const { installationId } = await installCompleted(admin, "lark");
    const tokenRequests: unknown[] = [];
    const userInfoAuthorizations: (string | null)[] = [];
    server.use(
      http.post(
        `${API_ORIGINS.lark}/open-apis/authen/v2/oauth/token`,
        async ({ request }) => {
          tokenRequests.push(await request.json());
          return HttpResponse.json({
            code: 0,
            access_token: "lark-user-access",
            refresh_token: "lark-user-refresh",
            expires_in: 7200,
          });
        },
      ),
      http.get(
        `${API_ORIGINS.lark}/open-apis/authen/v1/user_info`,
        ({ request }) => {
          userInfoAuthorizations.push(request.headers.get("authorization"));
          return HttpResponse.json({
            code: 0,
            data: {
              open_id: "ou_lark_user",
              name: "Lark User",
              tenant_key: "lark-tenant",
            },
          });
        },
      ),
      http.post(`${API_ORIGINS.lark}/open-apis/im/v1/messages`, () => {
        return HttpResponse.json({
          code: 0,
          data: { message_id: "om_welcome", chat_id: "oc_welcome" },
        });
      }),
    );
    const before = await readStatus(admin, "lark");
    const installation = (before.installations ?? []).find((candidate) => {
      return candidate.id === installationId;
    });
    if (!installation?.connectUrl) {
      throw new Error("Expected a connect URL on the Lark installation");
    }

    const redirect = await accept(
      oauthClient().connect({
        query: {
          state:
            new URL(installation.connectUrl).searchParams.get("state") ?? "",
        },
      }),
      [307],
    );
    const authorize = new URL(redirect.headers.get("location") ?? "");
    const callback = await accept(
      oauthClient().callback({
        query: {
          state: authorize.searchParams.get("state") ?? "",
          code: "lark-code",
          responseMode: "json",
        },
      }),
      [200],
    );
    const after = await readStatus(admin, "lark");

    const redirectUri = "https://app.okou.ai/integrations/lark/callback";
    expect(authorize.origin).toBe("https://accounts.larksuite.com");
    expect(authorize.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(callback.body).toStrictEqual({
      redirectUrl: `https://applink.larksuite.com/client/bot/open?appId=${installation.appId}`,
    });
    expect(tokenRequests).toContainEqual(
      expect.objectContaining({
        grant_type: "authorization_code",
        code: "lark-code",
        redirect_uri: redirectUri,
      }),
    );
    expect(userInfoAuthorizations).toContain("Bearer lark-user-access");
    expect(after.connectedUserName).toBe("Lark User");
  });

  it("lark-integration-003 rejects an App ID already registered on the other platform", async () => {
    const admin = await larkAdmin();
    const feishuInstallation = await installCompleted(admin, "feishu");

    const checked = await accept(
      connectClient("lark").checkAppId({
        headers: signIn(admin),
        query: { appId: feishuInstallation.appId },
      }),
      [409],
    );

    expect(checked.body.error.code).toBe("CONFLICT");
  });

  it("lark-integration-001 (1/2) lists each platform's installation separately and refuses a cross-platform delete", async () => {
    const admin = await larkAdmin();
    const [feishuInstallation, larkInstallation] = await Promise.all([
      installCompleted(admin, "feishu"),
      installCompleted(admin, "lark"),
    ]);
    const feishuInstallationId = feishuInstallation.installationId;
    const larkInstallationId = larkInstallation.installationId;

    const feishuStatus = await readStatus(admin, "feishu");
    const larkStatus = await readStatus(admin, "lark");
    const crossDelete = await accept(
      connectClient("feishu").removeInstallation({
        headers: signIn(admin),
        params: { installationId: larkInstallationId },
      }),
      [404],
    );

    expect(
      (feishuStatus.installations ?? []).map((installation) => {
        return installation.id;
      }),
    ).toStrictEqual([feishuInstallationId]);
    expect(larkStatus.installations).toStrictEqual([
      expect.objectContaining({
        id: larkInstallationId,
        oauthRedirectUrl: "https://app.okou.ai/integrations/lark/callback",
      }),
    ]);
    expect(crossDelete.status).toBe(404);
  });

  it("lark-integration-001 (2/2) removes the Lark installation once under concurrent deletes and keeps Feishu", async () => {
    const admin = await larkAdmin();
    const [feishuInstallation, larkInstallation] = await Promise.all([
      installCompleted(admin, "feishu"),
      installCompleted(admin, "lark"),
    ]);
    const feishuInstallationId = feishuInstallation.installationId;
    const larkInstallationId = larkInstallation.installationId;

    const headers = signIn(admin);
    const concurrentDeletes = await Promise.all([
      accept(
        connectClient("lark").removeInstallation({
          headers,
          params: { installationId: larkInstallationId },
        }),
        [200, 404],
      ),
      accept(
        connectClient("lark").removeInstallation({
          headers,
          params: { installationId: larkInstallationId },
        }),
        [200, 404],
      ),
    ]);
    const feishuAfter = await readStatus(admin, "feishu");
    const larkAfter = await readStatus(admin, "lark");

    expect(
      concurrentDeletes
        .map((response) => {
          return response.status;
        })
        .sort(),
    ).toStrictEqual([200, 404]);
    expect(larkAfter.isInstalled).toBeFalsy();
    expect(larkAfter.installations ?? []).toStrictEqual([]);
    expect(
      (feishuAfter.installations ?? []).map((installation) => {
        return installation.id;
      }),
    ).toStrictEqual([feishuInstallationId]);
  });
});
