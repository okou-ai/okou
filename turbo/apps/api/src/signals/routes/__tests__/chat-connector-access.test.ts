import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { chatConnectorAccessContract } from "@okouai/api-contracts/contracts/chat-connector-access";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { userPermissionGrantsContract } from "@okouai/api-contracts/contracts/user-permission-grants";
import { UNKNOWN_PERMISSION_GRANT } from "@okouai/connectors/firewall-types";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { chatConnectorAccessRoutes } from "../chat-connector-access";
import { connectorAccountRoutes } from "../connector-accounts";
import { userPermissionGrantsRoutes } from "../user-permission-grants";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import {
  createConnectorBddApi,
  manualHttpCustomConnectorCreateBody,
  mockSlackConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createClaimedRunCredentials } from "./helpers/claimed-run-credentials";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const connectors = createConnectorBddApi(context);
const tokenFor = createClaimedRunCredentials(context).okouToken;
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const target = { kind: "builtin", connectorSlug: "openai" } as const;

function client() {
  return setupApp({ context, routes: chatConnectorAccessRoutes })(
    chatConnectorAccessContract,
  );
}
function accounts() {
  return setupApp({ context, routes: connectorAccountRoutes })(
    connectorAccountsContract,
  );
}
function legacyPermissions() {
  return setupApp({ context, routes: userPermissionGrantsRoutes })(
    userPermissionGrantsContract,
  );
}
async function ownerWithThread(enabled = true, actor = bdd.user()) {
  bdd.acceptAgentStorageWrites();
  const agent = await bdd.createAgent(actor);
  const thread = await chat.createThread(actor, { agentId: agent.agentId });
  if (enabled) {
    await connectors.updateFeatureSwitches(actor, {
      connectorChatAccountAccess: true,
    });
  }
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { actor, agentId: agent.agentId, threadId: thread.id };
}
async function addAccount(actor: ReturnType<typeof bdd.user>, name: string) {
  return await connectors.connectManualGrant(
    actor,
    "openai",
    "api-token",
    { apiKey: `key-${name}` },
    undefined,
    { intent: "add", displayName: name },
  );
}
async function setDefaultEnabled(connectionId: string, enabled: boolean) {
  return await accept(
    client().updateAccountDefault({
      headers,
      params: { connectionId },
      body: { target, enabled },
    }),
    [200],
  );
}
async function threadAccess(threadId: string) {
  return (
    await accept(
      client().getThread({ headers, params: { threadId }, query: target }),
      [200],
    )
  ).body;
}

describe("Chat connector account configuration", () => {
  it("starts accounts enabled, replaces defaults and promotes only enabled siblings on deletion", async () => {
    const owner = await ownerWithThread();
    const a = await addAccount(owner.actor, "A");
    const b = await addAccount(owner.actor, "B");
    expect(
      (
        await accept(
          client().accountDefaults({ headers, query: target }),
          [200],
        )
      ).body,
    ).toStrictEqual([
      {
        connectionId: a.id,
        displayName: "A",
        defaultEnabled: true,
        isDefault: true,
      },
      {
        connectionId: b.id,
        displayName: "B",
        defaultEnabled: true,
        isDefault: false,
      },
    ]);
    await setDefaultEnabled(a.id, false);
    expect(
      (
        await accept(
          accounts().connection({
            headers,
            params: { connectionId: b.id },
            query: target,
          }),
          [200],
        )
      ).body.isDefault,
    ).toBeTruthy();
    await accept(
      accounts().setDefault({
        headers,
        params: { connectionId: a.id },
        body: { target },
      }),
      [404],
    );
    await setDefaultEnabled(b.id, false);
    expect((await threadAccess(owner.threadId)).currentConnectionId).toBeNull();
    expect((await setDefaultEnabled(a.id, true)).body.isDefault).toBeTruthy();
    const deleted = await accept(
      accounts().delete({
        headers,
        params: { connectionId: a.id },
        body: { target },
      }),
      [200],
    );
    expect(deleted.body.promotedDefaultConnectionId).toBeNull();
    expect(
      (
        await accept(
          client().accountDefaults({ headers, query: target }),
          [200],
        )
      ).body,
    ).toStrictEqual([
      {
        connectionId: b.id,
        displayName: "B",
        defaultEnabled: false,
        isDefault: false,
      },
    ]);
    const c = await addAccount(owner.actor, "C");
    expect((await threadAccess(owner.threadId)).currentConnectionId).toBe(c.id);
    await setDefaultEnabled(b.id, true);
    const promoted = await accept(
      accounts().delete({
        headers,
        params: { connectionId: c.id },
        body: { target },
      }),
      [200],
    );
    expect(promoted.body.promotedDefaultConnectionId).toBe(b.id);
    expect((await threadAccess(owner.threadId)).currentConnectionId).toBe(b.id);
  });

  it("inherits live defaults, isolates Chat overrides and retains valid replacement selections", async () => {
    const owner = await ownerWithThread();
    const second = await chat.createThread(owner.actor, {
      agentId: owner.agentId,
    });
    const a = await addAccount(owner.actor, "A");
    const b = await addAccount(owner.actor, "B");
    const params = { threadId: owner.threadId };
    await accept(
      client().setThreadCurrent({
        headers,
        params,
        body: { target, connectionId: b.id },
      }),
      [200],
    );
    expect((await threadAccess(second.id)).currentConnectionId).toBe(a.id);
    await setDefaultEnabled(b.id, false);
    expect((await threadAccess(owner.threadId)).currentConnectionId).toBe(a.id);
    await setDefaultEnabled(b.id, true);
    expect((await threadAccess(owner.threadId)).currentConnectionId).toBe(a.id);
    const denied = await accept(
      client().setThreadOverride({
        headers,
        params: { ...params, connectionId: a.id },
        body: { target, enabled: false },
      }),
      [200],
    );
    expect(denied.body.currentConnectionId).toBe(b.id);
    expect(denied.body.accounts[0]).toMatchObject({
      overrideEnabled: false,
      enabled: false,
    });
    expect((await threadAccess(second.id)).currentConnectionId).toBe(a.id);
    await accept(
      client().setThreadCurrent({
        headers,
        params,
        body: { target, connectionId: a.id },
      }),
      [400],
    );
    await setDefaultEnabled(a.id, false);
    await accept(
      client().setThreadOverride({
        headers,
        params: { ...params, connectionId: a.id },
        body: { target, enabled: true },
      }),
      [200],
    );
    await accept(
      client().setThreadCurrent({
        headers,
        params,
        body: { target, connectionId: a.id },
      }),
      [200],
    );
    await setDefaultEnabled(b.id, false);
    expect((await threadAccess(owner.threadId)).currentConnectionId).toBe(a.id);
    await expect(threadAccess(second.id)).resolves.toMatchObject({
      currentConnectionId: null,
      available: false,
    });
    const inherited = await accept(
      client().setThreadOverride({
        headers,
        params: { ...params, connectionId: a.id },
        body: { target, enabled: null },
      }),
      [200],
    );
    expect(inherited.body).toMatchObject({
      currentConnectionId: null,
      available: false,
    });
    expect(inherited.body.accounts[0]).toMatchObject({
      overrideEnabled: null,
      defaultEnabled: false,
      enabled: false,
    });
  });

  it("copies built-in policy once, keeps absolute expiry and permits editing with every account disabled", async () => {
    const owner = await ownerWithThread();
    const slack = { kind: "builtin", connectorSlug: "slack" } as const;
    mockSlackConnectorOAuth();
    const start = await connectors.startOauth(
      owner.actor,
      "slack",
      "oauth",
      owner.agentId,
    );
    const state = new URL(start.authorizationUrl).searchParams.get("state");
    if (!state) {
      throw new Error("Expected OAuth state");
    }
    await connectors.completeOauthCallback("slack", {
      state,
      code: "chat-policy-code",
    });
    const account = await connectors.readDefaultBuiltinAccount(
      owner.actor,
      "slack",
    );
    if (!account) {
      throw new Error("Expected the saved Slack account");
    }
    mockNow(new Date("2026-11-02T12:00:00Z"));
    const legacy = await accept(
      legacyPermissions().apply({
        headers,
        body: {
          agentId: owner.agentId,
          connectorSlug: "slack",
          mode: "replace",
          grants: [
            {
              permission: "conversations:read",
              action: "allow",
              expiresIn: "1h",
            },
            { permission: "chat:write", action: "deny" },
            { permission: UNKNOWN_PERMISSION_GRANT, action: "deny" },
          ],
        },
      }),
      [200],
    );
    const params = { threadId: owner.threadId };
    const initial = await accept(
      client().getPermissions({ headers, params, query: slack }),
      [200],
    );
    expect(initial.body.grants).toHaveLength(legacy.body.length);
    expect(initial.body.grants).toStrictEqual(
      expect.arrayContaining(
        legacy.body.map(({ permission, action, expiresAt }) => {
          return {
            permission,
            action,
            expiresAt,
          };
        }),
      ),
    );
    mockNow(new Date("2026-11-02T12:15:00Z"));
    await accept(
      legacyPermissions().apply({
        headers,
        body: {
          agentId: owner.agentId,
          connectorSlug: "slack",
          mode: "replace",
          grants: [
            { permission: "chat:write", action: "allow", expiresIn: "24h" },
          ],
        },
      }),
      [200],
    );
    await accept(
      client().updateAccountDefault({
        headers,
        params: { connectionId: account.id },
        body: { target: slack, enabled: false },
      }),
      [200],
    );
    expect(
      (
        await accept(
          client().getPermissions({ headers, params, query: slack }),
          [200],
        )
      ).body,
    ).toStrictEqual(initial.body);
    const edited = await accept(
      client().setPermissions({
        headers,
        params,
        body: {
          target: slack,
          mode: "patch",
          grants: [
            { permission: "chat:write", action: "allow", expiresIn: "1h" },
          ],
        },
      }),
      [200],
    );
    expect(edited.body.grants).toContainEqual({
      permission: "conversations:read",
      action: "allow",
      expiresAt: "2026-11-02T13:00:00.000Z",
    });
    expect(
      (
        await accept(
          client().getThread({ headers, params, query: slack }),
          [200],
        )
      ).body,
    ).toMatchObject({ available: false, currentConnectionId: null });
    mockNow(new Date("2026-11-02T13:01:00Z"));
    const expired = await accept(
      client().getPermissions({ headers, params, query: slack }),
      [200],
    );
    expect(expired.body.grants).toHaveLength(2);
    expect(expired.body.grants).toStrictEqual(
      expect.arrayContaining([
        {
          permission: UNKNOWN_PERMISSION_GRANT,
          action: "deny",
          expiresAt: null,
        },
        {
          permission: "chat:write",
          action: "allow",
          expiresAt: "2026-11-02T13:15:00.000Z",
        },
      ]),
    );
    const cleared = await accept(
      client().setPermissions({
        headers,
        params,
        body: { target: slack, mode: "replace", grants: [] },
      }),
      [200],
    );
    expect(cleared.body.grants).toStrictEqual([]);
    expect(
      (
        await accept(
          client().getPermissions({ headers, params, query: slack }),
          [200],
        )
      ).body.grants,
    ).toStrictEqual([]);
  });

  it("keeps custom selected names shared across accounts and does not promote disabled custom siblings", async () => {
    const owner = await ownerWithThread();
    const definition = await connectors.createCustomConnector(
      owner.actor,
      manualHttpCustomConnectorCreateBody({
        displayName: "Custom Chat policy",
        slug: `_chat-policy-${randomUUID()}`,
        prefixTemplates: ["https://custom-chat.example.test/"],
        permissionBundleRef: "builtin:slack@1",
      }),
    );
    const custom = {
      kind: "custom",
      customConnectorId: definition.id,
    } as const;
    const first = await connectors.setCustomConnectorValues(
      owner.actor,
      definition.id,
      [{ key: "secret", kind: "secret", value: "custom-A" }],
      { intent: "add" },
    );
    const second = await connectors.setCustomConnectorValues(
      owner.actor,
      definition.id,
      [{ key: "secret", kind: "secret", value: "custom-B" }],
      { intent: "add" },
    );
    await connectors.requestUpdateAgentCustomConnectorGrants(
      owner.actor,
      owner.agentId,
      [{ customConnectorId: definition.id, permissionNames: ["chat:write"] }],
      [200],
    );
    const params = { threadId: owner.threadId };
    expect(
      (
        await accept(
          client().getPermissions({ headers, params, query: custom }),
          [200],
        )
      ).body.permissionNames,
    ).toStrictEqual(["chat:write"]);
    await connectors.requestUpdateAgentCustomConnectorGrants(
      owner.actor,
      owner.agentId,
      [{ customConnectorId: definition.id, permissionNames: [] }],
      [200],
    );
    await accept(
      client().setThreadCurrent({
        headers,
        params,
        body: { target: custom, connectionId: second.connectionId },
      }),
      [200],
    );
    expect(
      (
        await accept(
          client().getPermissions({ headers, params, query: custom }),
          [200],
        )
      ).body.permissionNames,
    ).toStrictEqual(["chat:write"]);
    await accept(
      client().updateAccountDefault({
        headers,
        params: { connectionId: second.connectionId },
        body: { target: custom, enabled: false },
      }),
      [200],
    );
    const removed = await accept(
      accounts().delete({
        headers,
        params: { connectionId: first.connectionId },
        body: { target: custom },
      }),
      [200],
    );
    expect(removed.body.promotedDefaultConnectionId).toBeNull();
    const edited = await accept(
      client().setPermissions({
        headers,
        params,
        body: {
          target: custom,
          mode: "replace",
          permissionNames: ["conversations:read"],
          grants: [{ permission: "chat:write", action: "deny" }],
        },
      }),
      [200],
    );
    expect(edited.body).toStrictEqual({
      target: custom,
      permissionNames: ["conversations:read"],
      grants: [{ permission: "chat:write", action: "deny", expiresAt: null }],
    });
    expect(
      (
        await accept(
          client().getThread({ headers, params, query: custom }),
          [200],
        )
      ).body.available,
    ).toBeFalsy();
  });

  it("gates owner configuration and rejects foreign accounts, Chats and mismatched targets", async () => {
    const owner = await ownerWithThread(false);
    const a = await addAccount(owner.actor, "Owner");
    await accept(client().accountDefaults({ headers, query: target }), [404]);
    expect(
      (
        await accept(
          accounts().connection({
            headers,
            params: { connectionId: a.id },
            query: target,
          }),
          [200],
        )
      ).body.id,
    ).toBe(a.id);
    await connectors.updateFeatureSwitches(owner.actor, {
      connectorChatAccountAccess: true,
    });
    const other = await ownerWithThread(
      true,
      bdd.user({ orgId: owner.actor.orgId }),
    );
    const foreign = await addAccount(other.actor, "Foreign");
    const otherOrg = await addAccount(
      bdd.user({ userId: owner.actor.userId }),
      "Other organization",
    );
    mocks.clerk.session(
      owner.actor.userId,
      owner.actor.orgId,
      owner.actor.orgRole,
    );
    for (const connectionId of [foreign.id, otherOrg.id, randomUUID()]) {
      await accept(
        client().updateAccountDefault({
          headers,
          params: { connectionId },
          body: { target, enabled: false },
        }),
        [404],
      );
      await accept(
        client().setThreadOverride({
          headers,
          params: { threadId: owner.threadId, connectionId },
          body: { target, enabled: true },
        }),
        [404],
      );
    }
    await accept(
      client().updateAccountDefault({
        headers,
        params: { connectionId: a.id },
        body: {
          target: { kind: "builtin", connectorSlug: "slack" },
          enabled: false,
        },
      }),
      [404],
    );
    await accept(
      client().getThread({
        headers,
        params: { threadId: other.threadId },
        query: target,
      }),
      [404],
    );
    await accept(
      client().getPermissions({
        headers,
        params: { threadId: other.threadId },
        query: target,
      }),
      [404],
    );
    expect((await threadAccess(owner.threadId)).currentConnectionId).toBe(a.id);
  });

  it("does not let an agent with a real Run credential self-enable an account", async () => {
    const owner = await ownerWithThread();
    const a = await addAccount(owner.actor, "Denied");
    await setDefaultEnabled(a.id, false);
    const token = await tokenFor(owner.actor);
    const rejected = await accept(
      client().setThreadOverride({
        headers: { authorization: `Bearer ${token}` },
        params: { threadId: owner.threadId, connectionId: a.id },
        body: { target, enabled: true },
      }),
      [403],
    );
    expect(rejected.body.error.code).toBe("FORBIDDEN");
    mocks.clerk.session(
      owner.actor.userId,
      owner.actor.orgId,
      owner.actor.orgRole,
    );
    await expect(threadAccess(owner.threadId)).resolves.toMatchObject({
      available: false,
      currentConnectionId: null,
    });
  });
});
