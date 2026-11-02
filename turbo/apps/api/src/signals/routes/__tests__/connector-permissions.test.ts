import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { chatConnectorAccessContract } from "@okouai/api-contracts/contracts/chat-connector-access";
import {
  connectorAccountsContract,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import {
  connectorPermissionsContract,
  type ApplyConnectorPermissions,
} from "@okouai/api-contracts/contracts/connector-permissions";
import { userPermissionGrantsContract } from "@okouai/api-contracts/contracts/user-permission-grants";
import { UNKNOWN_PERMISSION_GRANT } from "@okouai/connectors/firewall-types";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { chatConnectorAccessRoutes } from "../chat-connector-access";
import { connectorAccountRoutes } from "../connector-accounts";
import { connectorPermissionsRoutes } from "../connector-permissions";
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
const slack = { kind: "builtin", connectorSlug: "slack" } as const;
const openai = { kind: "builtin", connectorSlug: "openai" } as const;

function client() {
  return setupApp({ context, routes: connectorPermissionsRoutes })(
    connectorPermissionsContract,
  );
}
function access() {
  return setupApp({ context, routes: chatConnectorAccessRoutes })(
    chatConnectorAccessContract,
  );
}
function accounts() {
  return setupApp({ context, routes: connectorAccountRoutes })(
    connectorAccountsContract,
  );
}
function legacy() {
  return setupApp({ context, routes: userPermissionGrantsRoutes })(
    userPermissionGrantsContract,
  );
}
function session(actor: ReturnType<typeof bdd.user>) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
}
async function member(actor = bdd.user(), enabled = true) {
  if (enabled) {
    await connectors.updateFeatureSwitches(actor, {
      connectorChatAccountAccess: true,
    });
  }
  session(actor);
  return actor;
}
async function read(target: ConnectorAccountTarget) {
  return (await accept(client().get({ headers, query: target }), [200])).body;
}
async function save(body: ApplyConnectorPermissions) {
  return (await accept(client().apply({ headers, body }), [200])).body;
}
async function addOpenAi(actor: ReturnType<typeof bdd.user>) {
  await connectors.connectManualGrant(actor, "openai", "api-token", {
    apiKey: "test-permission-key",
  });
  session(actor);
}

describe("Member connector permissions", () => {
  it("starts from connector defaults, shares rules across Chats/Agents and preserves deny, expiry and reset", async () => {
    const actor = await member();
    bdd.acceptAgentStorageWrites();
    const first = await bdd.createAgent(actor);
    const second = await bdd.createAgent(actor);
    const firstChat = await chat.createThread(actor, {
      agentId: first.agentId,
    });
    const secondChat = await chat.createThread(actor, {
      agentId: second.agentId,
    });
    mockSlackConnectorOAuth();
    const start = await connectors.startOauth(
      actor,
      "slack",
      "oauth",
      first.agentId,
    );
    const state = new URL(start.authorizationUrl).searchParams.get("state");
    if (!state) {
      throw new Error("Expected OAuth state");
    }
    await connectors.completeOauthCallback("slack", {
      state,
      code: "member-permission-code",
    });
    const account = await connectors.readDefaultBuiltinAccount(actor, "slack");
    if (!account) {
      throw new Error("Expected the saved Slack account");
    }
    session(actor);
    mockNow(new Date("2026-11-02T12:00:00Z"));
    for (const [agentId, action] of [
      [first.agentId, "allow"],
      [second.agentId, "deny"],
    ] as const) {
      await accept(
        legacy().apply({
          headers,
          body: {
            agentId,
            connectorSlug: "slack",
            mode: "replace",
            grants: [{ permission: "conversations:read", action }],
          },
        }),
        [200],
      );
    }
    await expect(read(slack)).resolves.toStrictEqual({
      target: slack,
      grants: [],
    });
    const initial = await save({
      target: slack,
      mode: "replace",
      grants: [
        { permission: "conversations:read", action: "allow", expiresIn: "1h" },
        { permission: "chat:write", action: "deny" },
        { permission: UNKNOWN_PERMISSION_GRANT, action: "deny" },
      ],
    });
    expect(initial.grants).toHaveLength(3);
    expect(initial.grants).toStrictEqual(
      expect.arrayContaining([
        {
          permission: "conversations:read",
          action: "allow",
          expiresAt: "2026-11-02T13:00:00.000Z",
        },
        { permission: "chat:write", action: "deny", expiresAt: null },
        {
          permission: UNKNOWN_PERMISSION_GRANT,
          action: "deny",
          expiresAt: null,
        },
      ]),
    );
    await accept(
      access().setThreadOverride({
        headers,
        params: { threadId: firstChat.id, connectionId: account.id },
        body: { target: slack, enabled: false },
      }),
      [200],
    );
    expect(
      (
        await accept(
          access().getThread({
            headers,
            params: { threadId: firstChat.id },
            query: slack,
          }),
          [200],
        )
      ).body.available,
    ).toBeFalsy();
    expect(
      (
        await accept(
          access().getThread({
            headers,
            params: { threadId: secondChat.id },
            query: slack,
          }),
          [200],
        )
      ).body.available,
    ).toBeTruthy();
    await expect(read(slack)).resolves.toStrictEqual(initial);
    await accept(
      legacy().apply({
        headers,
        body: {
          agentId: first.agentId,
          connectorSlug: "slack",
          mode: "replace",
          grants: [
            { permission: "chat:write", action: "allow", expiresIn: "24h" },
          ],
        },
      }),
      [200],
    );
    await expect(read(slack)).resolves.toStrictEqual(initial);
    mockNow(new Date("2026-11-02T12:15:00Z"));
    const edited = await save({
      target: slack,
      mode: "patch",
      grants: [{ permission: "chat:write", action: "allow", expiresIn: "1h" }],
    });
    expect(edited.grants).toContainEqual({
      permission: "conversations:read",
      action: "allow",
      expiresAt: "2026-11-02T13:00:00.000Z",
    });
    mockNow(new Date("2026-11-02T13:01:00Z"));
    const expired = await read(slack);
    expect(expired.grants).toHaveLength(2);
    expect(expired.grants).toStrictEqual(
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
    await expect(
      save({ target: slack, mode: "replace", grants: [] }),
    ).resolves.toStrictEqual({ target: slack, grants: [] });
    await expect(read(slack)).resolves.toStrictEqual({
      target: slack,
      grants: [],
    });
  });

  it("shares custom rules across accounts and permits editing with all accounts disabled", async () => {
    const actor = await member();
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(actor);
    const thread = await chat.createThread(actor, { agentId: agent.agentId });
    const definition = await connectors.createCustomConnector(
      actor,
      manualHttpCustomConnectorCreateBody({
        displayName: "Member permissions",
        slug: `_member-permissions-${randomUUID()}`,
        prefixTemplates: ["https://member-permissions.example.test/"],
        permissionBundleRef: "builtin:slack@1",
      }),
    );
    const target = {
      kind: "custom",
      customConnectorId: definition.id,
    } as const;
    const first = await connectors.setCustomConnectorValues(
      actor,
      definition.id,
      [{ key: "secret", kind: "secret", value: "custom-A" }],
      { intent: "add" },
    );
    const second = await connectors.setCustomConnectorValues(
      actor,
      definition.id,
      [{ key: "secret", kind: "secret", value: "custom-B" }],
      { intent: "add" },
    );
    await connectors.requestUpdateAgentCustomConnectorGrants(
      actor,
      agent.agentId,
      [{ customConnectorId: definition.id, permissionNames: ["chat:write"] }],
      [200],
    );
    session(actor);
    await expect(read(target)).resolves.toStrictEqual({ target, grants: [] });
    const rules = await save({
      target,
      mode: "replace",
      grants: [{ permission: "chat:write", action: "deny" }],
    });
    await accept(
      access().setThreadCurrent({
        headers,
        params: { threadId: thread.id },
        body: { target, connectionId: second.connectionId },
      }),
      [200],
    );
    expect(
      (
        await accept(
          access().getThread({
            headers,
            params: { threadId: thread.id },
            query: target,
          }),
          [200],
        )
      ).body.currentConnectionId,
    ).toBe(second.connectionId);
    await expect(read(target)).resolves.toStrictEqual(rules);
    await accept(
      access().updateAccountDefault({
        headers,
        params: { connectionId: second.connectionId },
        body: { target, enabled: false },
      }),
      [200],
    );
    const removed = await accept(
      accounts().delete({
        headers,
        params: { connectionId: first.connectionId },
        body: { target },
      }),
      [200],
    );
    expect(removed.body.promotedDefaultConnectionId).toBeNull();
    expect(
      (
        await accept(
          access().getThread({
            headers,
            params: { threadId: thread.id },
            query: target,
          }),
          [200],
        )
      ).body.available,
    ).toBeFalsy();
    await expect(read(target)).resolves.toStrictEqual(rules);
    const edited = await save({
      target,
      mode: "replace",
      grants: [{ permission: "conversations:read", action: "allow" }],
    });
    expect(edited).toStrictEqual({
      target,
      grants: [
        { permission: "conversations:read", action: "allow", expiresAt: null },
      ],
    });
    await accept(
      client().apply({
        headers,
        body: {
          target,
          mode: "patch",
          grants: [{ permission: "not-a-slack-permission", action: "allow" }],
        },
      }),
      [400],
    );
    await expect(read(target)).resolves.toStrictEqual(edited);
    expect(
      (
        await accept(
          access().getThread({
            headers,
            params: { threadId: thread.id },
            query: target,
          }),
          [200],
        )
      ).body.available,
    ).toBeFalsy();
  });

  it("isolates member and organization grants for the same connector without requiring a Chat", async () => {
    const actor = await member();
    await addOpenAi(actor);
    const own = await save({
      target: openai,
      mode: "replace",
      grants: [{ permission: UNKNOWN_PERMISSION_GRANT, action: "deny" }],
    });
    const otherMember = await member(bdd.user({ orgId: actor.orgId }));
    await addOpenAi(otherMember);
    const otherRules = await save({
      target: openai,
      mode: "replace",
      grants: [
        {
          permission: UNKNOWN_PERMISSION_GRANT,
          action: "allow",
          expiresIn: "1h",
        },
      ],
    });
    const otherOrg = await member(bdd.user({ userId: actor.userId }));
    await addOpenAi(otherOrg);
    const orgRules = await save({
      target: openai,
      mode: "replace",
      grants: [
        {
          permission: UNKNOWN_PERMISSION_GRANT,
          action: "allow",
          expiresIn: "24h",
        },
      ],
    });
    session(actor);
    await expect(read(openai)).resolves.toStrictEqual(own);
    session(otherMember);
    await expect(read(openai)).resolves.toStrictEqual(otherRules);
    session(otherOrg);
    await expect(read(openai)).resolves.toStrictEqual(orgRules);
    await member();
    await accept(client().get({ headers, query: openai }), [404]);
    await accept(
      client().apply({
        headers,
        body: { target: openai, mode: "replace", grants: [] },
      }),
      [404],
    );
  });

  it("gates configuration and rejects a real Run credential before it can change shared rules", async () => {
    const actor = await member(bdd.user(), false);
    await addOpenAi(actor);
    await accept(client().get({ headers, query: openai }), [404]);
    await connectors.updateFeatureSwitches(actor, {
      connectorChatAccountAccess: true,
    });
    bdd.acceptAgentStorageWrites();
    const token = await tokenFor(actor);
    await accept(
      client().apply({
        headers: { authorization: `Bearer ${token}` },
        body: {
          target: openai,
          mode: "replace",
          grants: [{ permission: UNKNOWN_PERMISSION_GRANT, action: "allow" }],
        },
      }),
      [403],
    );
    session(actor);
    await expect(read(openai)).resolves.toStrictEqual({
      target: openai,
      grants: [],
    });
    expect(
      (
        await save({
          target: openai,
          mode: "replace",
          grants: [{ permission: UNKNOWN_PERMISSION_GRANT, action: "deny" }],
        })
      ).grants,
    ).toStrictEqual([
      { permission: UNKNOWN_PERMISSION_GRANT, action: "deny", expiresAt: null },
    ]);
  });
});
