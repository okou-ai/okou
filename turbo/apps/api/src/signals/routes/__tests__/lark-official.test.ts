import {
  createCipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { feishuOauthContract } from "@okouai/api-contracts/contracts/feishu-oauth";
import {
  larkOfficialContract,
  larkOfficialEventsContract,
} from "@okouai/api-contracts/contracts/lark-official";
import { larkOfficialReadContract } from "@okouai/api-contracts/contracts/lark-official-read";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { feishuOauthRoutes } from "../feishu-oauth";
import { larkOfficialRoutes } from "../lark-official";
import { larkOfficialEventsRoutes } from "../lark-official-events";
import { larkOfficialReadRoutes } from "../lark-official-read";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

const LARK_API = "https://open.larksuite.com";
const OFFICIAL = {
  appId: "cli_official_lark",
  appSecret: "official-secret",
  verificationToken: "official-verification",
  encryptKey: "official-encrypt-key",
} as const;

interface Member {
  readonly userId: string;
  readonly orgId: string;
}

function signIn(member: Member): { authorization: string } {
  createRouteMocks(context).clerk.session(member.userId, member.orgId);
  return { authorization: "Bearer clerk-session" };
}

function officialClient() {
  return setupApp({ context, routes: larkOfficialRoutes })(
    larkOfficialContract,
  );
}

function readClient() {
  return setupApp({ context, routes: larkOfficialReadRoutes })(
    larkOfficialReadContract,
  );
}

function oauthClient() {
  return setupApp({ context, routes: feishuOauthRoutes })(feishuOauthContract);
}

/** Lark delivers an encrypted, signed Official app event. */
async function deliverOfficialEvent(payload: unknown) {
  const iv = randomBytes(16);
  const cipher = createCipheriv(
    "aes-256-cbc",
    createHash("sha256").update(OFFICIAL.encryptKey).digest(),
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
  const request = setupRawAppRequest({
    context,
    routes: larkOfficialEventsRoutes,
  });
  return await request(larkOfficialEventsContract.post.path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-lark-request-timestamp": timestamp,
      "x-lark-request-nonce": nonce,
      "x-lark-signature": createHash("sha256")
        .update(`${timestamp}${nonce}${OFFICIAL.encryptKey}${body}`)
        .digest("hex"),
    },
    body,
  });
}

/** The Official app is configured and Lark has delivered its app ticket. */
async function configureOfficialApp(): Promise<void> {
  mockEnv("LARK_OFFICIAL_APP_ID", OFFICIAL.appId);
  mockEnv("LARK_OFFICIAL_APP_SECRET", OFFICIAL.appSecret);
  mockEnv("LARK_OFFICIAL_VERIFICATION_TOKEN", OFFICIAL.verificationToken);
  mockEnv("LARK_OFFICIAL_ENCRYPT_KEY", OFFICIAL.encryptKey);
  const ticket = await deliverOfficialEvent({
    ts: String(now() / 1000),
    token: OFFICIAL.verificationToken,
    event: {
      type: "app_ticket",
      app_id: OFFICIAL.appId,
      app_ticket: "official-app-ticket",
    },
  });
  if (ticket.status !== 200) {
    throw new Error(`Expected the app ticket to be accepted: ${ticket.status}`);
  }
}

/** Lark's account, token and bot APIs for an Official authorization. */
function acceptLarkAuthorization(tenantKey: string, openId: string): void {
  server.use(
    http.post(`${LARK_API}/open-apis/authen/v2/oauth/token`, () => {
      return HttpResponse.json({
        code: 0,
        access_token: `u-${randomUUID()}`,
        refresh_token: `r-${randomUUID()}`,
        expires_in: 7200,
      });
    }),
    http.get(`${LARK_API}/open-apis/authen/v1/user_info`, () => {
      return HttpResponse.json({
        code: 0,
        data: {
          open_id: openId,
          name: "Lark Member",
          tenant_key: tenantKey,
        },
      });
    }),
    http.post(`${LARK_API}/open-apis/auth/v3/app_access_token`, () => {
      return HttpResponse.json({ code: 0, app_access_token: "official-app" });
    }),
    http.post(`${LARK_API}/open-apis/auth/v3/tenant_access_token`, () => {
      return HttpResponse.json({
        code: 0,
        tenant_access_token: `tenant-${tenantKey}`,
        expire: 7200,
      });
    }),
    http.get(`${LARK_API}/open-apis/bot/v3/info`, () => {
      return HttpResponse.json({
        code: 0,
        bot: { open_id: "ou_official_bot", app_name: "Okou Official" },
      });
    }),
    http.post(`${LARK_API}/open-apis/im/v1/messages`, () => {
      return HttpResponse.json({
        code: 0,
        data: { message_id: "om_welcome", chat_id: "oc_welcome" },
      });
    }),
  );
}

/** Starts the Official connect and completes Lark OAuth for the tenant. */
async function authorizeOfficial(
  member: Member,
  tenantKey: string,
  openId = `ou_${randomUUID().replaceAll("-", "")}`,
) {
  acceptLarkAuthorization(tenantKey, openId);
  const started = await accept(
    officialClient().connect({ headers: signIn(member) }),
    [200],
  );
  const redirect = await accept(
    oauthClient().connect({
      query: {
        state:
          new URL(started.body.authorizationUrl).searchParams.get("state") ??
          "",
      },
    }),
    [307],
  );
  const authorize = new URL(redirect.headers.get("location") ?? "");
  const completed = await accept(
    oauthClient().callback({
      query: {
        state: authorize.searchParams.get("state") ?? "",
        code: `code-${randomUUID()}`,
        responseMode: "json",
      },
    }),
    [200],
  );
  await flushWaitUntilForTest();
  return { authorize, completed: completed.body };
}

/** A member with the Official switch enabled who connected their tenant. */
async function connectedMember(tenantKey = `tenant_${randomUUID()}`) {
  const member = {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
  };
  await configureOfficialApp();
  await updateFeatureSwitchesForUser(context, member, {
    [FeatureSwitchKey.LarkOfficialBot]: true,
  });
  const openId = `ou_${randomUUID().replaceAll("-", "")}`;
  await authorizeOfficial(member, tenantKey, openId);
  return { member, tenantKey, openId };
}

async function readStatus(member: Member) {
  const status = await accept(
    officialClient().getStatus({ headers: signIn(member) }),
    [200],
  );
  return status.body;
}

describe("Okou Official Lark bot", () => {
  it("lark-official-008 stops access after the tenant disables the Official app and ignores older lifecycle events", async () => {
    const { member, tenantKey } = await connectedMember();
    await expect(readStatus(member)).resolves.toMatchObject({
      isConnected: true,
    });
    const seconds = now() / 1000;

    const stopped = await deliverOfficialEvent({
      ts: String(seconds),
      token: OFFICIAL.verificationToken,
      event: {
        type: "app_status_change",
        app_id: OFFICIAL.appId,
        tenant_key: tenantKey,
        status: "stop_by_tenant",
      },
    });
    await deliverOfficialEvent({
      ts: String(seconds - 60),
      token: OFFICIAL.verificationToken,
      event: {
        type: "app_status_change",
        app_id: OFFICIAL.appId,
        tenant_key: tenantKey,
        status: "start_by_tenant",
      },
    });

    expect(stopped.status).toBe(200);
    await expect(readStatus(member)).resolves.toMatchObject({
      isConnected: false,
    });
    await expect(
      accept(officialClient().connect({ headers: signIn(member) }), [409]),
    ).resolves.toMatchObject({ status: 409 });
    await expect(
      accept(
        readClient().history({
          headers: signIn(member),
          query: { chat: "oc_shared", limit: 20 },
        }),
        [404],
      ),
    ).resolves.toMatchObject({ status: 404 });
  });
});
