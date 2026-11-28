import { randomUUID } from "node:crypto";

import { customConnectorsContract } from "@okouai/api-contracts/contracts/custom-connectors";
import {
  feishuConnectContract,
  larkConnectContract,
} from "@okouai/api-contracts/contracts/feishu-connect";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { customConnectorsRoutes } from "../custom-connectors";
import { feishuConnectRoutes } from "../feishu-connect";
import { feishuEventsRoutes } from "../feishu-events";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

type Platform = "feishu" | "lark";

const PLATFORMS = {
  feishu: {
    name: "Feishu",
    contract: feishuConnectContract,
    apiOrigin: "https://open.feishu.cn",
    featureSwitch: FeatureSwitchKey.FeishuIntegration,
  },
  lark: {
    name: "Lark",
    contract: larkConnectContract,
    apiOrigin: "https://open.larksuite.com",
    featureSwitch: FeatureSwitchKey.LarkIntegration,
  },
} as const;

interface Actor {
  readonly userId: string;
  readonly orgId: string;
}

function newActor(): Actor {
  return { userId: `user_${randomUUID()}`, orgId: `org_${randomUUID()}` };
}

function signIn(
  actor: Actor,
  role: "org:admin" | "org:member" = "org:admin",
): { authorization: string } {
  createRouteMocks(context).clerk.session(actor.userId, actor.orgId, role);
  return { authorization: "Bearer clerk-session" };
}

function connectClient(platform: Platform) {
  return setupApp({ context, routes: feishuConnectRoutes })(
    PLATFORMS[platform].contract,
  );
}

async function enableIntegration(
  actor: Actor,
  platform: Platform,
): Promise<void> {
  await updateFeatureSwitchesForUser(context, actor, {
    [PLATFORMS[platform].featureSwitch]: true,
  });
}

function acceptStorageWrites(): void {
  context.mocks.s3.send.mockResolvedValue({ ETag: "fixture-etag" });
}

function tenantTokenEndpoint(platform: Platform, status: 200 | 503) {
  return http.post(
    `${PLATFORMS[platform].apiOrigin}/open-apis/auth/v3/tenant_access_token/internal`,
    () => {
      return status === 200
        ? HttpResponse.json({
            code: 0,
            tenant_access_token: `tenant-${randomUUID()}`,
            expire: 7200,
          })
        : HttpResponse.json({ msg: "unavailable" }, { status: 503 });
    },
  );
}

function appId(): string {
  return `cli_${randomUUID()}`;
}

async function postPlaintextChallenge(
  callbackUrl: string,
  token: string,
  challenge: string,
) {
  const request = setupRawAppRequest({ context, routes: feishuEventsRoutes });
  return await request(callbackUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "url_verification", challenge, token }),
  });
}

async function disabledStatusError(platform: Platform) {
  const admin = newActor();
  const response = await accept(
    connectClient(platform).getStatus({ headers: signIn(admin) }),
    [403],
  );
  return response.body.error;
}

async function rotatesCallbackCredentials(platform: Platform) {
  const admin = newActor();
  await enableIntegration(admin, platform);
  acceptStorageWrites();
  mockEnv("FEISHU_CALLBACK_BASE_URL", "https://tunnel-feishu.okou.test");
  server.use(tenantTokenEndpoint(platform, 200));
  const client = connectClient(platform);
  const app = appId();
  const credentials = {
    appId: app,
    appSecret: "app-secret",
    verificationToken: "original-token",
  };

  const created = await accept(
    client.setup({ headers: signIn(admin), body: credentials }),
    [200],
  );
  const installationId = created.body.installationId;
  const callbackUrl = created.body.callbackUrl;
  if (!installationId || !callbackUrl) {
    throw new Error("Expected a configured installation");
  }
  expect(new URL(callbackUrl).origin).toBe("https://tunnel-feishu.okou.test");

  const firstChallenge = await postPlaintextChallenge(
    callbackUrl,
    "original-token",
    "plaintext-challenge",
  );
  expect(firstChallenge.status).toBe(200);
  expect(firstChallenge.body).toStrictEqual({
    challenge: "plaintext-challenge",
  });
  await flushWaitUntilForTest();
  expect(context.mocks.ably.publish).toHaveBeenCalledWith(
    "feishu:changed",
    null,
  );

  const connectors = connectorsClient();
  const before = await accept(
    connectors.list({ headers: signIn(admin) }),
    [200],
  );
  expect(before.body.connectors).toHaveLength(1);
  const [managed] = before.body.connectors;

  server.use(tenantTokenEndpoint(platform, 503));
  const unchanged = await accept(
    client.setup({
      headers: signIn(admin),
      body: { ...credentials, installationId },
    }),
    [200],
  );
  expect(unchanged.body).toMatchObject({
    installationId,
    callbackUrl,
    callbackVerified: true,
  });

  server.use(tenantTokenEndpoint(platform, 200));
  const rotated = await accept(
    client.setup({
      headers: signIn(admin),
      body: {
        ...credentials,
        verificationToken: "rotated-token",
        installationId,
      },
    }),
    [200],
  );
  expect(rotated.body).toMatchObject({
    installationId,
    callbackUrl,
    callbackVerified: false,
  });

  const stale = await postPlaintextChallenge(
    callbackUrl,
    "original-token",
    "stale-callback",
  );
  expect(stale.status).toBe(401);
  const fresh = await postPlaintextChallenge(
    callbackUrl,
    "rotated-token",
    "rotated-callback",
  );
  expect(fresh.status).toBe(200);
  expect(fresh.body).toStrictEqual({ challenge: "rotated-callback" });

  const status = await accept(
    client.getStatus({ headers: signIn(admin) }),
    [200],
  );
  expect(status.body.callbackVerified).toBeTruthy();
  const after = await accept(
    connectors.list({ headers: signIn(admin) }),
    [200],
  );
  expect(
    after.body.connectors.map((connector) => {
      return {
        id: connector.id,
        storageVersion: connector.storageVersion,
      };
    }),
  ).toStrictEqual([
    { id: managed?.id, storageVersion: managed?.storageVersion },
  ]);

  const removed = await accept(
    client.remove({ headers: signIn(admin) }),
    [200],
  );
  return removed.body;
}

function connectorsClient() {
  return setupApp({ context, routes: customConnectorsRoutes })(
    customConnectorsContract,
  );
}

async function keepsOneAppPerOrganization(platform: Platform) {
  const admin = newActor();
  await enableIntegration(admin, platform);
  acceptStorageWrites();
  server.use(tenantTokenEndpoint(platform, 200));
  const client = connectClient(platform);
  const name = PLATFORMS[platform].name;
  const firstApp = appId();
  const secondApp = appId();
  const firstCredentials = {
    appId: firstApp,
    appSecret: "first-secret",
    verificationToken: "first-token",
  };

  const created = await accept(
    client.setup({
      headers: signIn(admin),
      body: { ...firstCredentials, createNew: true },
    }),
    [200],
  );
  const installationId = created.body.installationId;
  if (!installationId) {
    throw new Error("Expected a configured installation");
  }
  await accept(
    client.setup({ headers: signIn(admin), body: firstCredentials }),
    [200],
  );
  const second = await accept(
    client.setup({
      headers: signIn(admin),
      body: {
        appId: secondApp,
        appSecret: "second-secret",
        verificationToken: "second-token",
        createNew: true,
      },
    }),
    [409],
  );
  expect(second.body.error.message).toBe(
    `This workspace already has a ${name} bot`,
  );

  const registered = `This ${name} App ID is already registered in Okou`;
  const taken = await accept(
    client.checkAppId({ headers: signIn(admin), query: { appId: firstApp } }),
    [409],
  );
  expect(taken.body.error.message).toBe(registered);
  await accept(
    client.checkAppId({ headers: signIn(admin), query: { appId: appId() } }),
    [200],
  );

  const status = await accept(
    client.getStatus({ headers: signIn(admin) }),
    [200],
  );
  expect(
    status.body.installations?.map((installation) => {
      return installation.appId;
    }),
  ).toStrictEqual([firstApp]);

  const unknown = await accept(
    client.setup({
      headers: signIn(admin),
      body: { ...firstCredentials, installationId: randomUUID() },
    }),
    [409],
  );
  expect(unknown.body.error.message).toBe(registered);
  const changed = await accept(
    client.setup({
      headers: signIn(admin),
      body: {
        appId: secondApp,
        appSecret: "second-secret",
        verificationToken: "second-token",
        installationId,
      },
    }),
    [409],
  );
  expect(changed.body.error.message).toContain(
    "cannot be changed to a different App ID",
  );
  const replay = await accept(
    client.setup({
      headers: signIn(admin),
      body: { ...firstCredentials, installationId },
    }),
    [200],
  );
  expect(
    replay.body.installations?.map((installation) => {
      return { id: installation.id, appId: installation.appId };
    }),
  ).toStrictEqual([{ id: installationId, appId: firstApp }]);

  const removed = await accept(
    client.removeInstallation({
      headers: signIn(admin),
      params: { installationId },
    }),
    [200],
  );
  return removed.body;
}

async function requiresOrganizationAdmins(platform: Platform) {
  const user = newActor();
  await enableIntegration(user, platform);
  acceptStorageWrites();
  server.use(
    tenantTokenEndpoint(platform, 200),
    http.get(`${PLATFORMS[platform].apiOrigin}/open-apis/bot/v3/info`, () => {
      return HttpResponse.json({
        code: 0,
        bot: {
          open_id: `ou_bot_${randomUUID()}`,
          app_name: "Okou Feishu",
          avatar_url: "https://example.com/okou-feishu.png",
        },
      });
    }),
  );
  const client = connectClient(platform);
  const credentials = {
    appId: appId(),
    appSecret: "creator-secret",
    verificationToken: "creator-token",
  };
  const created = await accept(
    client.setup({
      headers: signIn(user),
      body: { ...credentials, createNew: true },
    }),
    [200],
  );
  const installationId = created.body.installationId;
  if (!installationId) {
    throw new Error("Expected a configured installation");
  }

  const memberStatus = await accept(
    client.getStatus({ headers: signIn(user, "org:member") }),
    [200],
  );
  expect(memberStatus.body.isAdmin).toBeFalsy();
  await accept(
    client.checkAppId({
      headers: signIn(user, "org:member"),
      query: { appId: appId() },
    }),
    [403],
  );
  await accept(
    client.setup({
      headers: signIn(user, "org:member"),
      body: { ...credentials, appId: appId(), createNew: true },
    }),
    [403],
  );
  await accept(
    client.updateInstallation({
      headers: signIn(user, "org:member"),
      params: { installationId },
      body: { setupCompleted: true },
    }),
    [403],
  );
  await accept(
    client.removeInstallation({
      headers: signIn(user, "org:member"),
      params: { installationId },
    }),
    [403],
  );

  const updated = await accept(
    client.updateInstallation({
      headers: signIn(user),
      params: { installationId },
      body: { setupCompleted: true },
    }),
    [200],
  );
  expect(updated.body).toMatchObject({
    setupCompleted: true,
    botName: "Okou Feishu",
    botAvatarUrl: "https://example.com/okou-feishu.png",
  });
  const removed = await accept(
    client.removeInstallation({
      headers: signIn(user),
      params: { installationId },
    }),
    [200],
  );
  return removed.body;
}

describe("feishu integration", () => {
  it("feishu-installation-001 rejects configuration access while the Feishu switch is off", async () => {
    await expect(disabledStatusError("feishu")).resolves.toStrictEqual({
      code: "FORBIDDEN",
      message: "Feishu integration is not enabled",
    });
  });

  it("feishu-installation-010 lets only organization admins manage the Feishu bot", async () => {
    await expect(requiresOrganizationAdmins("feishu")).resolves.toStrictEqual({
      success: true,
    });
  });

  it("feishu-installation-003 keeps one Feishu app per organization", async () => {
    await expect(keepsOneAppPerOrganization("feishu")).resolves.toStrictEqual({
      success: true,
    });
  });

  it("feishu-installation-002 uses the public callback origin and rotates the Feishu verification token", async () => {
    await expect(rotatesCallbackCredentials("feishu")).resolves.toStrictEqual({
      success: true,
    });
  });
});

describe("lark integration", () => {
  it("feishu-installation-011 rejects configuration access while the Lark switch is off", async () => {
    await expect(disabledStatusError("lark")).resolves.toStrictEqual({
      code: "FORBIDDEN",
      message: "Lark integration is not enabled",
    });
  });

  it("feishu-installation-020 lets only organization admins manage the Lark bot", async () => {
    await expect(requiresOrganizationAdmins("lark")).resolves.toStrictEqual({
      success: true,
    });
  });

  it("feishu-installation-013 keeps one Lark app per organization", async () => {
    await expect(keepsOneAppPerOrganization("lark")).resolves.toStrictEqual({
      success: true,
    });
  });

  it("feishu-installation-012 uses the public callback origin and rotates the Lark verification token", async () => {
    await expect(rotatesCallbackCredentials("lark")).resolves.toStrictEqual({
      success: true,
    });
  });
});
