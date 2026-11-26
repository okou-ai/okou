import { randomUUID } from "node:crypto";
import { chatConnectorAccessContract } from "@okouai/api-contracts/contracts/chat-connector-access";
import { connectorPermissionsContract } from "@okouai/api-contracts/contracts/connector-permissions";
import {
  connectorAccountsContract,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { chatConnectorAccessRoutes } from "../chat-connector-access";
import { connectorAccountRoutes } from "../connector-accounts";
import { connectorPermissionsRoutes } from "../connector-permissions";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import {
  createConnectorBddApi,
  manualHttpCustomConnectorCreateBody,
  mockSlackConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createChatConnectorAccessApi } from "./helpers/chat-connector-access";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);
const chats = createChatFilesBddApi(context);
const access = createChatConnectorAccessApi(context);

const FALLBACK = "__unknown__";
const openaiTarget: ConnectorAccountTarget = Object.freeze({
  kind: "builtin",
  connectorSlug: "openai",
});

function permissionsClient() {
  return setupApp({ context, routes: connectorPermissionsRoutes })(
    connectorPermissionsContract,
  );
}

function sessionHeaders(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}

async function connectOpenAi(actor: ApiTestUser) {
  await connectors.requestManualGrant(
    actor,
    "openai",
    "api-token",
    { apiKey: `sk-${randomUUID()}` },
    { statuses: [200] },
  );
}

async function readGrants(actor: ApiTestUser, target: ConnectorAccountTarget) {
  const response = await accept(
    permissionsClient().get({ headers: sessionHeaders(actor), query: target }),
    [200],
  );
  return response.body.grants;
}

async function readThreadAccess(
  actor: ApiTestUser,
  threadId: string,
  target: ConnectorAccountTarget,
) {
  const response = await accept(
    setupApp({ context, routes: chatConnectorAccessRoutes })(
      chatConnectorAccessContract,
    ).getThread({
      headers: sessionHeaders(actor),
      params: { threadId },
      query: target,
    }),
    [200],
  );
  return response.body;
}

describe("member connector permissions", () => {
  it("connector-permissions-004 keeps fallback rules separate per member and organization without a Chat", async () => {
    const start = Date.parse("2026-06-01T08:00:00.000Z");
    mockNow(start);
    const original = bdd.user();
    const colleague = bdd.user({
      orgId: original.orgId,
      orgRole: "org:member",
    });
    const elsewhere = bdd.user({ userId: original.userId });
    const unconnected = bdd.user({
      orgId: original.orgId,
      orgRole: "org:member",
    });
    await connectOpenAi(original);
    await connectOpenAi(colleague);
    await connectOpenAi(elsewhere);

    const choices = [
      [original, { permission: FALLBACK, action: "deny" }],
      [colleague, { permission: FALLBACK, action: "allow", expiresIn: "1h" }],
      [elsewhere, { permission: FALLBACK, action: "allow", expiresIn: "24h" }],
    ] as const;
    for (const [actor, grant] of choices) {
      await accept(
        permissionsClient().apply({
          headers: sessionHeaders(actor),
          body: { target: openaiTarget, mode: "replace", grants: [grant] },
        }),
        [200],
      );
    }

    await expect(readGrants(original, openaiTarget)).resolves.toStrictEqual([
      { permission: FALLBACK, action: "deny", expiresAt: null },
    ]);
    await expect(readGrants(colleague, openaiTarget)).resolves.toStrictEqual([
      {
        permission: FALLBACK,
        action: "allow",
        expiresAt: new Date(start + 60 * 60 * 1000).toISOString(),
      },
    ]);
    await expect(readGrants(elsewhere, openaiTarget)).resolves.toStrictEqual([
      {
        permission: FALLBACK,
        action: "allow",
        expiresAt: new Date(start + 24 * 60 * 60 * 1000).toISOString(),
      },
    ]);

    const missingRead = await accept(
      permissionsClient().get({
        headers: sessionHeaders(unconnected),
        query: openaiTarget,
      }),
      [404],
    );
    expect(missingRead.status).toBe(404);
    const missingWrite = await accept(
      permissionsClient().apply({
        headers: sessionHeaders(unconnected),
        body: {
          target: openaiTarget,
          mode: "replace",
          grants: [{ permission: FALLBACK, action: "deny" }],
        },
      }),
      [404],
    );
    expect(missingWrite.status).toBe(404);
  });

  it("connector-permissions-003 keeps custom connector rules editable when every account is unavailable", async () => {
    const admin = bdd.user();
    const member = bdd.user({ orgId: admin.orgId, orgRole: "org:member" });
    const connector = await connectors.createCustomConnector(
      admin,
      manualHttpCustomConnectorCreateBody({
        displayName: "Slack bundle relay",
        prefixTemplates: ["https://slack-relay.example.test/"],
        permissionBundleRef: "builtin:slack@1",
      }),
    );
    const target: ConnectorAccountTarget = {
      kind: "custom",
      customConnectorId: connector.id,
    };
    const firstAccount = await connectors.setCustomConnectorValues(
      member,
      connector.id,
      [{ key: "secret", kind: "secret", value: `first-${randomUUID()}` }],
    );
    const secondAccount = await connectors.setCustomConnectorValues(
      member,
      connector.id,
      [{ key: "secret", kind: "secret", value: `second-${randomUUID()}` }],
      { intent: "add" },
    );
    const thread = await chats.createThread(member, { model: null });
    await expect(readGrants(member, target)).resolves.toStrictEqual([]);

    const deny = [
      { permission: "chat:write", action: "deny", expiresAt: null },
    ];
    const saved = await access.applyPermissions(member, {
      target,
      mode: "replace",
      grants: [{ permission: "chat:write", action: "deny" }],
    });
    expect(saved.grants).toStrictEqual(deny);

    const second = { connectionId: secondAccount.connectionId, target };
    const selected = await accept(
      setupApp({ context, routes: chatConnectorAccessRoutes })(
        chatConnectorAccessContract,
      ).setThreadCurrent({
        headers: sessionHeaders(member),
        params: { threadId: thread.id },
        body: second,
      }),
      [200],
    );
    expect(selected.body.currentConnectionId).toBe(second.connectionId);
    await expect(readGrants(member, target)).resolves.toStrictEqual(deny);

    await access.setDefault(member, second, false);
    const removed = await accept(
      setupApp({ context, routes: connectorAccountRoutes })(
        connectorAccountsContract,
      ).delete({
        headers: sessionHeaders(member),
        params: { connectionId: firstAccount.connectionId },
        body: { target },
      }),
      [200],
    );
    expect(removed.body.promotedDefaultConnectionId).toBeNull();
    await expect(readGrants(member, target)).resolves.toStrictEqual(deny);

    const allow = [
      { permission: "conversations:read", action: "allow", expiresAt: null },
    ];
    const replaced = await access.applyPermissions(member, {
      target,
      mode: "replace",
      grants: [{ permission: "conversations:read", action: "allow" }],
    });
    expect(replaced.grants).toStrictEqual(allow);
    const rejected = await accept(
      permissionsClient().apply({
        headers: sessionHeaders(member),
        body: {
          target,
          mode: "patch",
          grants: [{ permission: "slack:not-a-permission", action: "allow" }],
        },
      }),
      [400],
    );
    expect(rejected.status).toBe(400);
    await expect(readGrants(member, target)).resolves.toStrictEqual(allow);
    expect(
      (await readThreadAccess(member, thread.id, target)).available,
    ).toBeFalsy();
  });

  it("connector-permissions-002 (1/2) shares the saved Slack rules across Chats while one Chat disables the account", async () => {
    const { owner, secondChat, saved, overridden } =
      await slackRulesWithFirstChatDisabled();

    expect(byPermission(saved.grants)).toStrictEqual(INITIAL_SLACK_GRANTS);
    expect(overridden.available).toBeFalsy();
    const secondAccess = await readThreadAccess(
      owner,
      secondChat.id,
      slackTarget,
    );
    expect(secondAccess.available).toBeTruthy();
    expect(byPermission(await readGrants(owner, slackTarget))).toStrictEqual(
      INITIAL_SLACK_GRANTS,
    );
  });

  it("connector-permissions-002 (2/2) keeps the read deadline on patch, drops it after expiry and clears every grant", async () => {
    const { owner } = await slackRulesWithFirstChatDisabled();

    const patched = await patchLaterChatWrite(owner);
    expect(byPermission(patched.grants)).toStrictEqual(
      byPermission([
        { permission: FALLBACK, action: "deny", expiresAt: null },
        LATER_CHAT_WRITE,
        READ_ALLOW,
      ]),
    );

    mockNow(SLACK_RULES_START + HOUR + 1);
    expect(byPermission(await readGrants(owner, slackTarget))).toStrictEqual(
      byPermission([
        { permission: FALLBACK, action: "deny", expiresAt: null },
        LATER_CHAT_WRITE,
      ]),
    );

    const cleared = await access.applyPermissions(owner, {
      target: slackTarget,
      mode: "replace",
      grants: [],
    });
    expect(cleared.grants).toStrictEqual([]);
    await expect(readGrants(owner, slackTarget)).resolves.toStrictEqual([]);
  });
});

const slackTarget: ConnectorAccountTarget = Object.freeze({
  kind: "builtin",
  connectorSlug: "slack",
});
const HOUR = 60 * 60 * 1000;
const SLACK_RULES_START = Date.parse("2026-06-01T08:00:00.000Z");
const PATCHED_AT = SLACK_RULES_START + 10 * 60 * 1000;
const READ_ALLOW = Object.freeze({
  permission: "conversations:read",
  action: "allow",
  expiresAt: new Date(SLACK_RULES_START + HOUR).toISOString(),
});
const LATER_CHAT_WRITE = Object.freeze({
  permission: "chat:write",
  action: "allow",
  expiresAt: new Date(PATCHED_AT + HOUR).toISOString(),
});
const INITIAL_SLACK_GRANTS = byPermission([
  { permission: FALLBACK, action: "deny", expiresAt: null },
  { permission: "chat:write", action: "deny", expiresAt: null },
  READ_ALLOW,
]);

function byPermission<T extends { readonly permission: string }>(
  grants: readonly T[],
): T[] {
  return [...grants].sort((left, right) => {
    return left.permission.localeCompare(right.permission);
  });
}

async function connectSlack(actor: ApiTestUser) {
  mockSlackConnectorOAuth();
  const started = await connectors.startOauth(actor, "slack", "oauth");
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected Slack authorization state");
  }
  const completed = await connectors.completeOauthCallbackResult("slack", {
    state,
    code: `code-${randomUUID()}`,
  });
  expect(completed.body.status).toBe("success");
  return await connectors.readDefaultBuiltinAccount(actor, "slack");
}

/** A member with two Chats and a Slack account saves rules, then disables it in the first Chat. */
async function slackRulesWithFirstChatDisabled() {
  mockNow(SLACK_RULES_START);
  const owner = bdd.user();
  const [account, firstChat, secondChat] = await Promise.all([
    connectSlack(owner),
    chats.createThread(owner, { model: null }),
    chats.createThread(owner, { model: null }),
  ]);
  const saved = await access.applyPermissions(owner, {
    target: slackTarget,
    mode: "replace",
    grants: [
      { permission: "conversations:read", action: "allow", expiresIn: "1h" },
      { permission: "chat:write", action: "deny" },
      { permission: FALLBACK, action: "deny" },
    ],
  });
  const overridden = await access.setThreadOverride(
    owner,
    firstChat.id,
    { target: slackTarget, connectionId: account.id },
    false,
  );
  return { owner, secondChat, saved, overridden };
}

async function patchLaterChatWrite(owner: ApiTestUser) {
  mockNow(PATCHED_AT);
  return await access.applyPermissions(owner, {
    target: slackTarget,
    mode: "patch",
    grants: [{ permission: "chat:write", action: "allow", expiresIn: "1h" }],
  });
}
