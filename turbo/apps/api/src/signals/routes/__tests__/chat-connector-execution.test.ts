import { randomUUID } from "node:crypto";
import { describe, expect, it, onTestFinished } from "vitest";
import { runConnectorAccountsContract } from "@okouai/api-contracts/contracts/run-connector-accounts";
import { chatConnectorAccessContract } from "@okouai/api-contracts/contracts/chat-connector-access";
import { connectorPermissionsContract } from "@okouai/api-contracts/contracts/connector-permissions";
import { mcpConnectorsContract } from "@okouai/api-contracts/contracts/mcp-connectors";
import type { ConnectorAccountTarget } from "@okouai/api-contracts/contracts/connector-accounts";
import { UNKNOWN_PERMISSION_GRANT } from "@okouai/connectors/firewall-types";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { runConnectorAccountRoutes } from "../run-connector-accounts";
import { chatConnectorAccessRoutes } from "../chat-connector-access";
import { connectorPermissionsRoutes } from "../connector-permissions";
import { mcpConnectorsRoutes } from "../mcp-connectors";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  manualHttpCustomConnectorCreateBody,
} from "./helpers/api-bdd-connectors";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);
const chat = createChatFilesBddApi(context);
const runs = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);
const mocks = createRouteMocks(context);
const sessionHeaders = { authorization: "Bearer clerk-session" } as const;
const builtin = { kind: "builtin", connectorSlug: "manual-mcp" } as const;
const client = () => {
  return setupApp({ context, routes: runConnectorAccountRoutes })(
    runConnectorAccountsContract,
  );
};
const access = () => {
  return setupApp({ context, routes: chatConnectorAccessRoutes })(
    chatConnectorAccessContract,
  );
};
const permissions = () => {
  return setupApp({ context, routes: connectorPermissionsRoutes })(
    connectorPermissionsContract,
  );
};
const mcp = () => {
  return setupApp({ context, routes: mcpConnectorsRoutes })(
    mcpConnectorsContract,
  );
};
function session(actor: ApiTestUser) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
}

async function owner(enabled = true) {
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  const runnerGroup = runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor);
  await runs.ensurePersonalSubscriptionModel(actor);
  if (enabled) {
    await connectors.updateFeatureSwitches(actor, {
      connectorChatAccountAccess: true,
    });
  }
  const { agentId } = await bdd.createAgent(actor, { visibility: "private" });
  const thread = await chat.createThread(actor, { agentId });
  return { actor, agentId, threadId: thread.id, runnerGroup };
}
async function start(value: Awaited<ReturnType<typeof owner>>) {
  const run = await runs.createThreadRun(value.actor, {
    agentId: value.agentId,
    threadId: value.threadId,
    prompt: "Use this Chat's current connector account",
  });
  const receipt: { sandboxToken?: string; completed: boolean } = {
    completed: false,
  };
  onTestFinished(async () => {
    if (receipt.completed) {
      return;
    }
    await runs.requestCancelRun(value.actor, run.runId, [200]);
    if (receipt.sandboxToken) {
      await webhooks.requestAgentComplete(
        { runId: run.runId, exitCode: 1, error: "Test cleanup" },
        { authorization: `Bearer ${receipt.sandboxToken}` },
        [200],
      );
    }
  });
  await runs.heartbeatRunner(value.runnerGroup);
  const claim = await runs.claimRunnerJob(run.runId);
  receipt.sandboxToken = claim.sandboxToken;
  const token = claim.platformEnvironment.OKOU_TOKEN;
  if (!token) {
    throw new Error("Runner claim did not issue an Okou token");
  }
  return {
    ...run,
    claim,
    headers: { authorization: `Bearer ${token}` },
    receipt,
  };
}
async function addAccount(actor: ApiTestUser, name: string) {
  return await connectors.connectManualGrant(
    actor,
    "manual-mcp",
    "api-token",
    { apiKey: `key-${name}` },
    undefined,
    { intent: "add", displayName: name },
  );
}
async function current(
  value: Awaited<ReturnType<typeof owner>>,
  target: ConnectorAccountTarget,
) {
  session(value.actor);
  return (
    await accept(
      access().getThread({
        headers: sessionHeaders,
        params: { threadId: value.threadId },
        query: target,
      }),
      [200],
    )
  ).body;
}

describe("Chat connector execution", () => {
  it("retains Agent-gated startup and hides the new approval and switch APIs when disabled", async () => {
    const value = await owner(false);
    const account = await addAccount(value.actor, "A");
    const run = await start(value);
    expect(run.claim.connectorRuntimeTargets ?? []).toStrictEqual([]);
    await accept(client().list({ headers: run.headers }), [403]);
    session(value.actor);
    await accept(
      client().approve({
        headers: sessionHeaders,
        params: { threadId: value.threadId },
        body: { target: builtin, connectionId: account.id },
      }),
      [404],
    );
  });

  it("starts without Agent grants, switches HTTP identity and persists the Chat current account for the next Run", async () => {
    const value = await owner();
    const a = await addAccount(value.actor, "A");
    const b = await addAccount(value.actor, "B");
    session(value.actor);
    await accept(
      access().setThreadCurrent({
        headers: sessionHeaders,
        params: { threadId: value.threadId },
        body: { target: builtin, connectionId: b.id },
      }),
      [200],
    );
    const run = await start(value);
    expect(run.claim.connectorRuntimeTargets).toContainEqual(
      expect.objectContaining({
        kind: "builtin",
        connectorSlug: "manual-mcp",
        sourceId: b.id,
      }),
    );
    const inventory = await accept(
      client().list({ headers: run.headers }),
      [200],
    );
    expect(inventory.body.accounts).toContainEqual({
      target: builtin,
      connectionId: b.id,
      displayName: "B",
      enabled: true,
      isCurrent: true,
      isDefault: false,
    });
    expect(JSON.stringify(inventory.body)).not.toContain("key-B");
    expect(
      (await accept(mcp().list({ headers: run.headers }), [200])).body
        .connectors,
    ).toContainEqual(
      expect.objectContaining({ target: builtin, connectionId: b.id }),
    );
    session(value.actor);
    await accept(
      permissions().apply({
        headers: sessionHeaders,
        body: {
          target: builtin,
          mode: "patch",
          grants: [{ permission: UNKNOWN_PERMISSION_GRANT, action: "deny" }],
        },
      }),
      [200],
    );
    await accept(
      client().select({
        headers: run.headers,
        body: { target: builtin, connectionId: a.id },
      }),
      [200],
    );
    const results = await runs.syncConnectorRuntime(run.runId, {
      targets: [
        { kind: "builtin", connectorSlug: "manual-mcp", sourceId: b.id },
      ],
    });
    expect(results).toContainEqual(
      expect.objectContaining({
        target: builtin,
        state: "available",
        accountBinding: { connectionId: a.id, baseUrlVars: {} },
        networkPolicy: expect.objectContaining({ unknownPolicy: "deny" }),
      }),
    );
    const firewall = createFirewallApi(context);
    const metadata = Object.fromEntries(
      Object.entries(run.claim.secretConnectorMetadataMap ?? {}).map(
        ([key, entry]) => {
          return [
            key,
            entry.sourceType === "connector" && entry.sourceId === b.id
              ? { ...entry, sourceId: a.id }
              : entry,
          ];
        },
      ),
    );
    const auth = await firewall.requestFirewallAuth(
      { authorization: `Bearer ${run.claim.sandboxToken}` },
      {
        encryptedSecrets:
          run.claim.encryptedSecrets || firewall.encryptedSecretsBody({}),
        secretConnectorMap: run.claim.secretConnectorMap ?? undefined,
        secretConnectorMetadataMap: metadata,
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("MCP_API_KEY")}`,
        },
        matchedFirewall: {
          name: "manual-mcp",
          apiId: "manual-mcp:0",
          base: "https://manual-mcp.example.test/server",
          connectorSlug: "manual-mcp",
          sourceId: a.id,
          routingVariables: {},
        },
      },
      [200],
    );
    if (auth.status !== 200) {
      throw new Error("Expected firewall credentials");
    }
    expect(auth.body.headers.Authorization).toBe("Bearer key-A");
    expect(
      (await accept(mcp().list({ headers: run.headers }), [200])).body
        .connectors,
    ).toContainEqual(
      expect.objectContaining({ target: builtin, connectionId: a.id }),
    );
    expect(
      (
        await accept(
          mcp().reauthorizeOAuth({
            headers: run.headers,
            body: { target: builtin, scopes: ["read"] },
          }),
          [200],
        )
      ).body,
    ).toMatchObject({
      kind: "reconnect",
      connectionId: a.id,
      authorizationUrl: expect.stringContaining(`/reconnect/${a.id}`),
    });
    expect((await current(value, builtin)).currentConnectionId).toBe(a.id);
    await webhooks.requestAgentComplete(
      {
        runId: run.runId,
        exitCode: 0,
        lastEventSequence: 0,
        completion: {
          cliAgentType: run.claim.cliAgentType,
          cliAgentSessionId: run.runId,
          cliAgentSessionHistoryDisposition: "native_only",
        },
      },
      { authorization: `Bearer ${run.claim.sandboxToken}` },
      [200],
    );
    run.receipt.completed = true;
    const next = await start(value);
    expect(next.claim.connectorRuntimeTargets).toContainEqual(
      expect.objectContaining({
        kind: "builtin",
        connectorSlug: "manual-mcp",
        sourceId: a.id,
      }),
    );
  });

  it("shows denied accounts, rejects self-grants and foreign ownership, and accepts exact owner confirmation only in that Chat", async () => {
    const value = await owner();
    const a = await addAccount(value.actor, "A");
    const b = await addAccount(value.actor, "B");
    const otherThread = await chat.createThread(value.actor, {
      agentId: value.agentId,
    });
    session(value.actor);
    await accept(
      access().setThreadOverride({
        headers: sessionHeaders,
        params: { threadId: value.threadId, connectionId: b.id },
        body: { target: builtin, enabled: false },
      }),
      [200],
    );
    const run = await start(value);
    const inventory = (
      await accept(client().list({ headers: run.headers }), [200])
    ).body;
    expect(inventory.accounts).toContainEqual(
      expect.objectContaining({
        connectionId: b.id,
        enabled: false,
        isCurrent: false,
      }),
    );
    expect(run.claim.connectorRuntimeTargets).toContainEqual(
      expect.objectContaining({ sourceId: a.id }),
    );
    await accept(
      client().select({
        headers: run.headers,
        body: { target: builtin, connectionId: b.id },
      }),
      [400],
    );
    await accept(
      client().approve({
        headers: run.headers,
        params: { threadId: value.threadId },
        body: { target: builtin, connectionId: b.id },
      }),
      [403],
    );
    const foreign = bdd.user();
    await connectors.updateFeatureSwitches(foreign, {
      connectorChatAccountAccess: true,
    });
    const foreignAccount = await addAccount(foreign, "foreign");
    await accept(
      client().select({
        headers: run.headers,
        body: { target: builtin, connectionId: foreignAccount.id },
      }),
      [400],
    );
    session(foreign);
    await accept(
      client().approve({
        headers: sessionHeaders,
        params: { threadId: value.threadId },
        body: { target: builtin, connectionId: foreignAccount.id },
      }),
      [404],
    );
    session(value.actor);
    await accept(
      client().approve({
        headers: sessionHeaders,
        params: { threadId: value.threadId },
        body: { target: builtin, connectionId: b.id },
      }),
      [200],
    );
    expect((await current(value, builtin)).currentConnectionId).toBe(b.id);
    expect(
      (await current({ ...value, threadId: otherThread.id }, builtin))
        .currentConnectionId,
    ).toBe(a.id);
    expect(
      (await current(value, builtin)).accounts.find((entry) => {
        return entry.connectionId === b.id;
      }),
    ).toMatchObject({ enabled: true, defaultEnabled: true, isDefault: false });
  });

  it.each(["http", "mcp"] as const)(
    "rebinds custom %s accounts without Agent grants and retains shared permission expiry",
    async (kind) => {
      const value = await owner();
      const definition = await connectors.createCustomConnector(
        value.actor,
        kind === "http"
          ? manualHttpCustomConnectorCreateBody({
              slug: `_chat-${randomUUID()}`,
              displayName: "Chat HTTP",
              prefixTemplates: ["https://chat-connector.example.test/"],
              permissionBundleRef: "builtin:slack@1",
            })
          : {
              kind: "mcp",
              slug: `_chat-${randomUUID()}`,
              displayName: "Chat MCP",
              endpoint: "https://chat-connector.example.test/mcp",
              transport: "streamable-http",
              fields: [
                {
                  key: "secret",
                  label: "Secret",
                  kind: "secret",
                  required: true,
                },
              ],
              headerInjections: [
                {
                  name: "Authorization",
                  valueTemplate: "Bearer {{secrets.secret}}",
                },
              ],
              queryInjections: [],
              authMode: "manual",
            },
      );
      const a = await connectors.setCustomConnectorValues(
        value.actor,
        definition.id,
        [{ key: "secret", kind: "secret", value: "secret-A" }],
        { intent: "add", displayName: "A" },
      );
      const b = await connectors.setCustomConnectorValues(
        value.actor,
        definition.id,
        [{ key: "secret", kind: "secret", value: "secret-B" }],
        { intent: "add", displayName: "B" },
      );
      const target = {
        kind: "custom",
        customConnectorId: definition.id,
      } as const;
      session(value.actor);
      const expiry =
        kind === "http"
          ? (
              await accept(
                permissions().apply({
                  headers: sessionHeaders,
                  body: {
                    target,
                    mode: "patch",
                    grants: [
                      {
                        permission: "conversations:read",
                        action: "allow",
                        expiresIn: "1h",
                      },
                      { permission: "chat:write", action: "deny" },
                    ],
                  },
                }),
                [200],
              )
            ).body.grants.find((rule) => {
              return rule.permission === "conversations:read";
            })?.expiresAt
          : undefined;
      const run = await start(value);
      expect(run.claim.connectorRuntimeTargets).toContainEqual(
        expect.objectContaining({
          kind: "custom",
          customConnectorId: definition.id,
          sourceId: a.connectionId,
        }),
      );
      if (kind === "mcp") {
        expect(
          (await accept(mcp().list({ headers: run.headers }), [200])).body
            .connectors,
        ).toContainEqual(
          expect.objectContaining({ target, connectionId: a.connectionId }),
        );
      }
      await accept(
        client().select({
          headers: run.headers,
          body: { target, connectionId: b.connectionId },
        }),
        [200],
      );
      const synced = await runs.syncConnectorRuntime(run.runId, {
        targets: [
          {
            kind: "custom",
            customConnectorId: definition.id,
            sourceId: a.connectionId,
            baseUrlVars: {},
          },
        ],
      });
      expect(synced).toContainEqual(
        expect.objectContaining({
          target,
          state: "available",
          accountBinding: { connectionId: b.connectionId, baseUrlVars: {} },
          firewall: expect.objectContaining({ sourceId: b.connectionId }),
        }),
      );
      const published = synced.find((result) => {
        return "firewall" in result;
      });
      if (!published || !("firewall" in published)) {
        throw new Error("Expected an available custom firewall");
      }
      const api = published.firewall.firewall.apis[0];
      if (!api) {
        throw new Error("Expected a custom API route");
      }
      const firewall = createFirewallApi(context);
      const authenticated = await firewall.requestFirewallAuth(
        { authorization: `Bearer ${run.claim.sandboxToken}` },
        {
          encryptedSecrets:
            run.claim.encryptedSecrets || firewall.encryptedSecretsBody({}),
          authHeaders: api.auth.headers ?? {},
          matchedFirewall: {
            name: published.firewall.firewall.name,
            apiId: `${published.firewall.firewall.name}:0`,
            base: api.base,
            customConnectorId: definition.id,
            sourceId: b.connectionId,
            routingVariables: published.baseUrlVars,
          },
        },
        [200],
      );
      if (authenticated.status !== 200) {
        throw new Error("Expected custom firewall credentials");
      }
      expect(authenticated.body.headers.Authorization).toBe("Bearer secret-B");
      if (kind === "http") {
        expect(synced).toContainEqual(
          expect.objectContaining({
            nextSyncAt: expiry,
            networkPolicy: expect.objectContaining({
              allow: expect.arrayContaining(["conversations:read"]),
              deny: expect.arrayContaining(["chat:write"]),
            }),
          }),
        );
      } else {
        expect(
          (await accept(mcp().list({ headers: run.headers }), [200])).body
            .connectors,
        ).toContainEqual(
          expect.objectContaining({ target, connectionId: b.connectionId }),
        );
      }
    },
  );

  it("does not substitute a healthy default for the Chat's current account when its credentials need reconnecting", async () => {
    const value = await owner();
    const body = manualHttpCustomConnectorCreateBody({
      slug: `_chat-${randomUUID()}`,
      displayName: "Pinned account",
      prefixTemplates: ["https://pinned-account.example.test/"],
    });
    const definition = await connectors.createCustomConnector(
      value.actor,
      body,
    );
    const a = await connectors.setCustomConnectorValues(
      value.actor,
      definition.id,
      [{ key: "secret", kind: "secret", value: "secret-A" }],
      { intent: "add", displayName: "A" },
    );
    const b = await connectors.setCustomConnectorValues(
      value.actor,
      definition.id,
      [{ key: "secret", kind: "secret", value: "secret-B" }],
      { intent: "add", displayName: "B" },
    );
    await connectors.updateCustomConnector(value.actor, definition.id, {
      ...body,
      storageVersion: 2,
    });
    await connectors.setCustomConnectorValues(
      value.actor,
      definition.id,
      [{ key: "secret", kind: "secret", value: "reconnected-A" }],
      { intent: "reconnect", connectionId: a.connectionId },
    );
    const target = {
      kind: "custom",
      customConnectorId: definition.id,
    } as const;
    session(value.actor);
    await accept(
      access().setThreadCurrent({
        headers: sessionHeaders,
        params: { threadId: value.threadId },
        body: { target, connectionId: b.connectionId },
      }),
      [200],
    );
    const run = await start(value);
    expect(run.claim.connectorRuntimeTargets).not.toContainEqual(
      expect.objectContaining(target),
    );
    expect(
      (await accept(client().list({ headers: run.headers }), [200])).body
        .accounts,
    ).toContainEqual(
      expect.objectContaining({
        target,
        connectionId: b.connectionId,
        isCurrent: true,
      }),
    );
  });
});
