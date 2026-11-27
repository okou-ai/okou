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
import {
  setupApp,
  setupRawAppRequest,
} from "../../../../__tests__/test-helpers";
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

type ConnectClients = ReturnType<typeof createConnectClients>;

function createConnectClients(context: TestContext) {
  const connectApp = setupApp({ context, routes: feishuConnectRoutes });
  return {
    feishuConnect: connectApp(feishuConnectContract),
    larkConnect: connectApp(larkConnectContract),
    events: setupRawAppRequest({ context, routes: feishuEventsRoutes }),
    browser: setupRawAppRequest({
      context,
      routes: feishuBrowserConnectRoutes,
    }),
    oauth: setupRawAppRequest({ context, routes: feishuOauthRoutes }),
  };
}

export function createArtifactFeishuInstaller(context: TestContext) {
  const clients = createConnectClients(context);
  return {
    install: (
      actor: ApiTestUser & { readonly orgId: string },
      platform: FeishuPlatform = "feishu",
      options: {
        readonly extraSwitches?: Record<string, boolean>;
        readonly bindOwner?: boolean;
        readonly extraMembers?: readonly {
          readonly user: ApiTestUser;
          readonly openId: string;
        }[];
      } = {},
    ) => {
      return installArtifactFeishuWithClients(
        context,
        clients,
        actor,
        platform,
        options,
      );
    },
  };
}

function installClerkSessionRouter(
  context: TestContext,
  defaultActor: ApiTestUser,
  actorsById: ReadonlyMap<string, ApiTestUser>,
) {
  createRouteMocks(context).clerk.session(
    defaultActor.userId,
    defaultActor.orgId,
    defaultActor.orgRole,
  );
  context.mocks.clerk.authenticateRequest.mockImplementation(
    (request: unknown) => {
      const cookie =
        request instanceof Request ? (request.headers.get("cookie") ?? "") : "";
      const match = /__session=([^;\s]+)/u.exec(cookie);
      const actor =
        (match?.[1] ? actorsById.get(match[1]) : undefined) ?? defaultActor;
      return Promise.resolve({
        isAuthenticated: true,
        toAuth: () => {
          return {
            userId: actor.userId,
            orgId: actor.orgId,
            orgRole: actor.orgRole ?? (actor.orgId ? "org:admin" : undefined),
          };
        },
      });
    },
  );
}

async function installArtifactFeishuWithClients(
  context: TestContext,
  clients: ConnectClients,
  actor: ApiTestUser & { readonly orgId: string },
  platform: FeishuPlatform = "feishu",
  options: {
    readonly extraSwitches?: Record<string, boolean>;
    readonly bindOwner?: boolean;
    readonly extraMembers?: readonly {
      readonly user: ApiTestUser;
      readonly openId: string;
    }[];
  } = {},
) {
  const appId = `cli_${randomUUID()}`;
  const ownerOpenId = `ou_${randomUUID()}`;
  const tenantKey = `tenant_${randomUUID()}`;
  const encryptKey = "annotation-feishu-encrypt-key";
  const verificationToken = "annotation-feishu-verification-token";
  const apiOrigin = FEISHU_PLATFORMS[platform].apiOrigin;
  const repliesByMessage = new Map<string, string[]>();
  const openIdByCode = new Map<string, string>();
  const actorsById = new Map<string, ApiTestUser>([[actor.userId, actor]]);
  for (const extra of options.extraMembers ?? []) {
    actorsById.set(extra.user.userId, extra.user);
  }
  installClerkSessionRouter(context, actor, actorsById);
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
    http.post(
      `${apiOrigin}/open-apis/authen/v2/oauth/token`,
      async ({ request }) => {
        const body = object({ code: string() }).parse(await request.json());
        return HttpResponse.json({
          code: 0,
          access_token: body.code,
          refresh_token: "annotation-feishu-refresh",
          expires_in: 7200,
        });
      },
    ),
    http.get(`${apiOrigin}/open-apis/authen/v1/user_info`, ({ request }) => {
      const auth = request.headers.get("authorization") ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      return HttpResponse.json({
        code: 0,
        data: {
          name: "Annotation owner",
          open_id: openIdByCode.get(token) ?? ownerOpenId,
          tenant_key: tenantKey,
        },
      });
    }),
    http.post(
      `${apiOrigin}/open-apis/im/v1/messages/:messageId/reply`,
      async ({ params, request }) => {
        const body = object({ content: string() }).parse(await request.json());
        const messageId = String(params.messageId);
        const list = repliesByMessage.get(messageId) ?? [];
        list.push(body.content);
        repliesByMessage.set(messageId, list);
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
    ...options.extraSwitches,
  });
  installClerkSessionRouter(context, actor, actorsById);
  const client =
    platform === "lark" ? clients.larkConnect : clients.feishuConnect;
  const configured = await accept(
    client.setup({
      headers: { authorization: "Bearer clerk-session" },
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
    const response = await clients.events(callbackAddress, {
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
  async function message(senderOpenId: string, text: string) {
    const messageId = `om_${randomUUID()}`;
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
        sender: { sender_id: { open_id: senderOpenId }, sender_type: "user" },
        message: {
          message_id: messageId,
          chat_id: "oc_123",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text }),
        },
      },
    });
    return messageId;
  }
  async function prepareBind(user: ApiTestUser, memberOpenId: string) {
    actorsById.set(user.userId, user);
    const messageId = await message(memberOpenId, "connect artifact viewer");
    return { user, memberOpenId, messageId };
  }
  async function startBindOauth(prepared: {
    readonly user: ApiTestUser;
    readonly memberOpenId: string;
    readonly messageId: string;
  }) {
    const connectUrlText = (repliesByMessage.get(prepared.messageId) ?? [])
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
    const connecting = await clients.browser("/api/feishu/connect", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `__session=${prepared.user.userId}`,
        origin: connectUrl.origin,
      },
      body: JSON.stringify(connectBody),
    });
    expect(connecting.status).toBe(200);
    const authorization = object({ openUrl: string() }).parse(connecting.body);
    const state = new URL(authorization.openUrl).searchParams.get("state");
    if (!state) {
      throw new Error("Expected the public Feishu OAuth state");
    }
    return { memberOpenId: prepared.memberOpenId, state };
  }
  async function finishBindOauth(started: {
    readonly memberOpenId: string;
    readonly state: string;
  }) {
    const code = `annotation-${randomUUID()}`;
    openIdByCode.set(code, started.memberOpenId);
    const callback = await clients.oauth(
      `${feishuOauthContract.callback.path}?${new URLSearchParams({ code, responseMode: "json", state: started.state })}`,
      { method: "GET" },
    );
    expect(callback.status).toBe(200);
  }
  async function bind(user: ApiTestUser, memberOpenId: string) {
    const prepared = await prepareBind(user, memberOpenId);
    await flushWaitUntilForTest();
    const started = await startBindOauth(prepared);
    await finishBindOauth(started);
  }
  const membersToBind = [
    ...(options.bindOwner === false
      ? []
      : [{ user: actor, openId: ownerOpenId }]),
    ...(options.extraMembers ?? []),
  ];
  const [, ...preparedMembers] = await Promise.all([
    accept(
      client.updateInstallation({
        headers: { authorization: "Bearer clerk-session" },
        params: { installationId },
        body: { setupCompleted: true },
      }),
      [200],
    ),
    ...membersToBind.map((entry) => {
      return prepareBind(entry.user, entry.openId);
    }),
  ]);
  await flushWaitUntilForTest();
  for (const prepared of preparedMembers) {
    const started = await startBindOauth(prepared);
    await finishBindOauth(started);
  }
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
