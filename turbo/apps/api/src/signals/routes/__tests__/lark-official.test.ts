import {
  createCipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { larkConnectContract } from "@okouai/api-contracts/contracts/feishu-connect";
import { feishuOauthContract } from "@okouai/api-contracts/contracts/feishu-oauth";
import { integrationsLarkMessageContract } from "@okouai/api-contracts/contracts/integrations";
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
import { feishuConnectRoutes } from "../feishu-connect";
import { feishuOauthRoutes } from "../feishu-oauth";
import { integrationsFeishuMessageRoutes } from "../integrations-feishu-message";
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

function customClient() {
  return setupApp({ context, routes: feishuConnectRoutes })(
    larkConnectContract,
  );
}

function larkMessageClient() {
  return setupApp({ context, routes: integrationsFeishuMessageRoutes })(
    integrationsLarkMessageContract,
  );
}

/** The member sets up (and optionally completes) a custom Lark bot without connecting. */
async function setupCustomBot(
  member: Member,
  completed: boolean,
): Promise<string> {
  server.use(
    http.post(
      `${LARK_API}/open-apis/auth/v3/tenant_access_token/internal`,
      () => {
        return HttpResponse.json({
          code: 0,
          tenant_access_token: "custom-tenant-token",
          expire: 7200,
        });
      },
    ),
    http.get(`${LARK_API}/open-apis/bot/v3/info`, () => {
      return HttpResponse.json({
        code: 0,
        bot: { open_id: "ou_custom_bot", app_name: "Custom Lark bot" },
      });
    }),
  );
  context.mocks.s3.send.mockResolvedValue({ ETag: "fixture-etag" });
  const configured = await accept(
    customClient().setup({
      headers: signIn(member),
      body: {
        appId: `cli_custom_${randomUUID()}`,
        appSecret: "custom-secret",
        verificationToken: `custom-token-${randomUUID()}`,
        encryptKey: `custom-encrypt-${randomUUID()}`,
      },
    }),
    [200],
  );
  const installationId = configured.body.installationId;
  if (!installationId) {
    throw new Error("Expected a configured custom Lark installation");
  }
  if (!completed) {
    return installationId;
  }
  await accept(
    customClient().updateInstallation({
      headers: signIn(member),
      params: { installationId },
      body: { setupCompleted: true },
    }),
    [200],
  );
  return installationId;
}

/**
 * Given of lark-official-002 and -010: an onboarded member with the Official
 * and custom Lark switches enabled has set up a custom Lark bot (completed for
 * 010), and Lark delivered the Official app ticket.
 */
async function customBotMember(completed: boolean): Promise<Member> {
  const member = {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
  };
  await configureOfficialApp();
  await updateFeatureSwitchesForUser(context, member, {
    [FeatureSwitchKey.LarkIntegration]: true,
    [FeatureSwitchKey.LarkOfficialBot]: true,
  });
  await setupCustomBot(member, completed);
  return member;
}

/** The custom installations as the custom Lark status route reports them. */
async function customInstallations(member: Member) {
  const status = await accept(
    customClient().getStatus({ headers: signIn(member) }),
    [200],
  );
  // The connect URL carries a fresh signed state on every read.
  return (status.body.installations ?? []).map((installation) => {
    return {
      id: installation.id,
      appId: installation.appId,
      isConnected: installation.isConnected,
      setupCompleted: installation.setupCompleted,
      callbackVerified: installation.callbackVerified,
      botName: installation.botName,
      tenantKey: installation.tenantKey,
    };
  });
}

/** Lark's view of shared group `oc_shared`, its members and its history. */
function mockSharedGroup(openId: string) {
  const conversation = {
    botIn: true,
    userIn: true,
    mode: "group",
    historyTokens: [] as (string | null)[],
  };
  const chatBase = `${LARK_API}/open-apis/im/v1/chats/:chatId`;
  server.use(
    http.get(`${LARK_API}/open-apis/im/v1/chats`, () => {
      return HttpResponse.json({
        code: 0,
        data: {
          items: [{ chat_id: "oc_shared", name: "Shared group" }],
          has_more: true,
          page_token: "next-page",
        },
      });
    }),
    http.get(chatBase, () => {
      return HttpResponse.json({
        code: 0,
        data: { chat_mode: conversation.mode },
      });
    }),
    http.get(`${chatBase}/members/is_in_chat`, () => {
      return HttpResponse.json({
        code: 0,
        data: { is_in_chat: conversation.botIn },
      });
    }),
    http.get(`${chatBase}/members`, () => {
      return HttpResponse.json({
        code: 0,
        data: {
          items: conversation.userIn
            ? [{ member_id: openId, member_id_type: "open_id" }]
            : [],
          has_more: false,
        },
      });
    }),
    http.get(`${LARK_API}/open-apis/im/v1/messages`, ({ request }) => {
      conversation.historyTokens.push(request.headers.get("authorization"));
      return HttpResponse.json({
        code: 0,
        data: {
          items: [
            {
              message_id: "om_history",
              msg_type: "text",
              body: { content: '{"text":"hello"}' },
            },
          ],
          has_more: false,
        },
      });
    }),
  );
  return conversation;
}

async function readSharedHistory(
  member: Member,
  statuses: readonly (200 | 403 | 404)[],
) {
  return await accept(
    readClient().history({
      headers: signIn(member),
      query: {
        chat: "oc_shared",
        limit: 20,
        startTime: "1700000000",
        endTime: "1700003600",
      },
    }),
    statuses,
  );
}

async function listSharedChats(member: Member) {
  return await accept(
    readClient().listChats({
      headers: signIn(member),
      query: { limit: 20 },
    }),
    [200],
  );
}

/** Lark reports the bot and the member in group `oc_shared`. */
function mockMemberInSharedGroup(openId: string): void {
  const chatBase = `${LARK_API}/open-apis/im/v1/chats/:chatId`;
  server.use(
    http.get(chatBase, () => {
      return HttpResponse.json({
        code: 0,
        data: { chat_mode: "group", moderation_permission: "all_members" },
      });
    }),
    http.get(`${chatBase}/members/is_in_chat`, () => {
      return HttpResponse.json({ code: 0, data: { is_in_chat: true } });
    }),
    http.get(`${chatBase}/members`, () => {
      return HttpResponse.json({
        code: 0,
        data: {
          items: [{ member_id: openId, member_id_type: "open_id" }],
          has_more: false,
        },
      });
    }),
  );
}

async function sendToSharedGroup(
  member: Member,
  installationId: string | undefined,
  statuses: readonly (200 | 403)[],
) {
  return await accept(
    larkMessageClient().sendMessage({
      headers: signIn(member),
      body: {
        chat: "oc_shared",
        text: "hello from Okou",
        ...(installationId ? { installationId } : {}),
      },
    }),
    statuses,
  );
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

  it("lark-official-006 (1/3) lists shared groups and reads history with the bot token", async () => {
    const { member, tenantKey, openId } = await connectedMember();
    const conversation = mockSharedGroup(openId);

    const listed = await listSharedChats(member);
    const read = await readSharedHistory(member, [200]);

    expect(
      listed.body.chats.map((chat) => {
        return chat.id;
      }),
    ).toContain("oc_shared");
    expect(listed.body.nextCursor).toBe("next-page");
    expect(
      "messages" in read.body
        ? read.body.messages.map((message) => {
            return message.message_id;
          })
        : [],
    ).toStrictEqual(["om_history"]);
    expect(conversation.historyTokens).toStrictEqual([
      `Bearer tenant-${tenantKey}`,
    ]);
  });

  it("lark-official-006 (2/3) refuses history unless both bot and member are in a group chat", async () => {
    const { member, openId } = await connectedMember();
    const conversation = mockSharedGroup(openId);

    conversation.botIn = false;
    const botAbsent = await readSharedHistory(member, [403]);
    conversation.botIn = true;
    conversation.userIn = false;
    const userAbsent = await readSharedHistory(member, [403]);
    const listedWithoutUser = await listSharedChats(member);
    conversation.userIn = true;
    conversation.mode = "p2p";
    const privateChat = await readSharedHistory(member, [403]);

    expect([
      botAbsent.status,
      userAbsent.status,
      privateChat.status,
    ]).toStrictEqual([403, 403, 403]);
    expect(listedWithoutUser.body.chats).toStrictEqual([]);
    expect(listedWithoutUser.body.nextCursor).toBe("next-page");
    expect(conversation.historyTokens).toStrictEqual([]);
  });

  it("lark-official-006 (3/3) stops reading history after disconnect", async () => {
    const { member, openId } = await connectedMember();
    mockSharedGroup(openId);

    await accept(
      officialClient().disconnect({ headers: signIn(member) }),
      [200],
    );
    const disconnected = await readSharedHistory(member, [404]);

    expect(disconnected.status).toBe(404);
  });

  it("lark-official-004 (1/2) rejects an OAuth account from another tenant and keeps the connection", async () => {
    const { member } = await connectedMember();

    const wrongTenant = await authorizeOfficial(
      member,
      `tenant_${randomUUID()}`,
    );
    const firstStatus = await readStatus(member);

    expect(wrongTenant.completed.redirectUrl).toContain("tenant");
    expect(firstStatus.isConnected).toBeTruthy();
  });

  it("lark-official-004 (2/2) connects a member of another workspace to a new tenant", async () => {
    await connectedMember();
    const other = {
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
    };
    await updateFeatureSwitchesForUser(context, other, {
      [FeatureSwitchKey.LarkOfficialBot]: true,
    });

    const otherWorkspace = await authorizeOfficial(
      other,
      `tenant_${randomUUID()}`,
    );
    const otherStatus = await readStatus(other);

    expect(new URL(otherWorkspace.completed.redirectUrl).origin).toBe(
      "https://applink.larksuite.com",
    );
    expect(otherStatus.isConnected).toBeTruthy();
  });

  it("lark-official-002 (1/4) sends the member to Lark with the Official app and store scopes", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    const member = await customBotMember(false);
    acceptLarkAuthorization(`tenant_${randomUUID()}`, `ou_${randomUUID()}`);

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
    const scopes = (authorize.searchParams.get("scope") ?? "").split(" ");
    expect(authorize.origin).toBe("https://accounts.larksuite.com");
    expect(authorize.searchParams.get("redirect_uri")).toBe(
      "https://app.okou.ai/integrations/lark/callback",
    );
    expect(authorize.searchParams.get("client_id")).toBe(OFFICIAL.appId);
    expect(scopes).toStrictEqual(
      expect.arrayContaining([
        "im:chat:read",
        "calendar:calendar.event:create",
      ]),
    );
    for (const excluded of [
      "drive:export:readonly",
      "contact:user.id:readonly",
      "im:chat",
      "im:message.group_msg:get_as_user",
    ]) {
      expect(scopes).not.toContain(excluded);
    }
  });

  it("lark-official-002 (2/4) completes the Official callback and leaves the custom bot unchanged", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    const member = await customBotMember(false);
    const customBefore = await customInstallations(member);

    await authorizeOfficial(member, `tenant_${randomUUID()}`);
    const connected = await readStatus(member);

    expect(connected.isConnected).toBeTruthy();
    expect(customBefore).toHaveLength(1);
    await expect(customInstallations(member)).resolves.toStrictEqual(
      customBefore,
    );
  });

  it("lark-official-002 (3/4) refuses to manage the Official installation through custom routes", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    const member = await customBotMember(false);
    await authorizeOfficial(member, `tenant_${randomUUID()}`);
    const officialId = (await readStatus(member)).installationId ?? "";

    const [updated, removed, duplicate] = await Promise.all([
      accept(
        customClient().updateInstallation({
          headers: signIn(member),
          params: { installationId: officialId },
          body: { setupCompleted: true },
        }),
        [404],
      ),
      accept(
        customClient().removeInstallation({
          headers: signIn(member),
          params: { installationId: officialId },
        }),
        [404],
      ),
      accept(
        customClient().setup({
          headers: signIn(member),
          body: {
            appId: OFFICIAL.appId,
            appSecret: "copied-secret",
            verificationToken: "copied-token",
            encryptKey: "copied-encrypt",
          },
        }),
        [409],
      ),
    ]);

    expect([updated.status, removed.status, duplicate.status]).toStrictEqual([
      404, 404, 409,
    ]);
  });

  it("lark-official-002 (4/4) disconnects Official and keeps the custom bot unchanged", async () => {
    mockEnv("APP_URL", "https://app.okou.ai");
    const member = await customBotMember(false);
    const customBefore = await customInstallations(member);
    await authorizeOfficial(member, `tenant_${randomUUID()}`);

    const disconnected = await accept(
      officialClient().disconnect({ headers: signIn(member) }),
      [200],
    );
    const afterDisconnect = await readStatus(member);

    expect(disconnected.status).toBe(200);
    expect(afterDisconnect.isConnected).toBeFalsy();
    await expect(customInstallations(member)).resolves.toStrictEqual(
      customBefore,
    );
  });

  it("lark-official-010 (1/2) keeps the custom bot as the default sender", async () => {
    const member = await customBotMember(true);
    const openId = `ou_${randomUUID().replaceAll("-", "")}`;
    await authorizeOfficial(member, `tenant_${randomUUID()}`, openId);
    mockMemberInSharedGroup(openId);

    const defaultSend = await sendToSharedGroup(member, undefined, [403]);

    expect(defaultSend.status).toBe(403);
  });

  it("lark-official-010 (2/2) sends through Official when the caller selects it", async () => {
    const member = await customBotMember(true);
    const openId = `ou_${randomUUID().replaceAll("-", "")}`;
    await authorizeOfficial(member, `tenant_${randomUUID()}`, openId);
    mockMemberInSharedGroup(openId);
    await sendToSharedGroup(member, undefined, [403]);
    const official = await readStatus(member);

    const officialSend = await sendToSharedGroup(
      member,
      official.installationId ?? undefined,
      [200],
    );

    expect(officialSend.body).toMatchObject({ ok: true });
  });
});
