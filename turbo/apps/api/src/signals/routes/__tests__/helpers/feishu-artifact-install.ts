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
import { feishuOauthContract } from "@okouai/api-contracts/contracts/feishu-oauth";
import {
  FEISHU_PLATFORMS,
  type FeishuPlatform,
} from "@okouai/core/feishu-platform";
import { HttpResponse, http } from "msw";
import { expect } from "vitest";
import { object, string } from "zod";
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
import type { ApiTestUser } from "./api-bdd";
import { updateFeatureSwitchesForUser } from "./feature-switches";
import { createRouteMocks } from "./route-test";

function authenticate(context: TestContext, actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}

export async function installArtifactFeishuForTest(
  context: TestContext,
  actor: ApiTestUser & { readonly orgId: string },
  platform: FeishuPlatform = "feishu",
) {
  const appId = `cli_${randomUUID()}`;
  const ownerOpenId = `ou_${randomUUID()}`;
  let openId = ownerOpenId;
  const tenantKey = `tenant_${randomUUID()}`;
  const encryptKey = "annotation-feishu-encrypt-key";
  const verificationToken = "annotation-feishu-verification-token";
  const apiOrigin = FEISHU_PLATFORMS[platform].apiOrigin;
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
        const body = object({ content: string() }).parse(await request.json());
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
    [FEISHU_PLATFORMS[platform].featureSwitch]: true,
  });
  const client = setupApp({ context, routes: feishuConnectRoutes })(
    platform === "lark" ? larkConnectContract : feishuConnectContract,
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
    return response;
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
  async function bind(user: ApiTestUser, memberOpenId: string) {
    openId = memberOpenId;
    const replyOffset = replies.length;
    await message("connect artifact viewer");
    await flushWaitUntilForTest();
    const connectUrlText = replies
      .slice(replyOffset)
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
    authenticate(context, user);
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
    const authorization = object({ openUrl: string() }).parse(
      await connecting.json(),
    );
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
    openId = ownerOpenId;
  }
  await bind(actor, ownerOpenId);
  return {
    ownerOpenId,
    installationId,
    apiOrigin,
    tenantKey,
    bind,
    event: (eventType: string, event: unknown, eventId = randomUUID()) => {
      return post({
        schema: "2.0",
        header: {
          event_id: eventId,
          event_type: eventType,
          tenant_key: tenantKey,
          app_id: appId,
          token: verificationToken,
        },
        event,
      });
    },
  };
}
