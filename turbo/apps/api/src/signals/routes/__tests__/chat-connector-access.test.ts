import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { chatConnectorAccessContract } from "@okouai/api-contracts/contracts/chat-connector-access";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { chatConnectorAccessRoutes } from "../chat-connector-access";
import { connectorAccountRoutes } from "../connector-accounts";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
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
