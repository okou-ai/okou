import { randomUUID } from "node:crypto";
import { chatThreadConnectorSelectionContract } from "@okouai/api-contracts/contracts/chat-threads";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { describe, expect, it, beforeEach, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { env, mockEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatThreadRoutes } from "../chat-threads";
import { connectorAccountRoutes } from "../connector-accounts";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { manualHttpCustomConnectorCreateBody } from "./helpers/api-bdd-connectors";
import { publicChatActor } from "./helpers/public-chat-actor";
import {
  createChatEventsFixture,
  type EntitledChatActor,
} from "./helpers/chat-events-fixture";

const context = testContext();
const {
  api,
  chat,
  connectors,
  entitledChatActor: createEntitledChatActor,
  sendChatRun,
  runExecution,
  completeChatRunOk,
  cancelAndCompleteChatRun,
  cancelChatRun,
  sessionHeaders,
} = createChatEventsFixture(context);

// Connector selection tests observe claimable native runs; Sonnet's Pi route
// can finish API-first before these Runner assertions execute.
async function entitledChatActor({ legacyConnectorScope = false } = {}) {
  const result = await createEntitledChatActor();
  await api.updateUserModelPreference(result.actor, "claude-fable-5-1");
  if (legacyConnectorScope) {
    await connectors.updateFeatureSwitches(result.actor, {
      connectorChatAccountAccess: false,
    });
  }
  return result;
}

function chatThreadConnectorSelectionsClient() {
  return setupApp({ context, routes: chatThreadRoutes })(
    chatThreadConnectorSelectionContract,
  );
}

interface SelectedThreadConnectorFixture extends EntitledChatActor {
  readonly connectionId: string;
  readonly threadId: string;
}

async function selectedThreadConnectorFixture(
  title: string,
  options?: { readonly legacyConnectorScope?: boolean },
): Promise<SelectedThreadConnectorFixture> {
  const entitled = await entitledChatActor(options);
  const connection = await connectors.connectManualGrant(
    entitled.actor,
    "openai",
    "api-token",
    { apiKey: `thread-runtime-overlap-${randomUUID()}` },
    entitled.agentId,
  );
  const thread = await chat.createThread(entitled.actor, {
    agentId: entitled.agentId,
    title,
  });
  await accept(
    chatThreadConnectorSelectionsClient().update({
      headers: sessionHeaders(entitled.actor),
      params: { id: thread.id },
      body: {
        connectionId: connection.id,
        target: { kind: "builtin", connectorSlug: "openai" },
      },
    }),
    [200],
  );
  return {
    ...entitled,
    connectionId: connection.id,
    threadId: thread.id,
  };
}

async function configurePersonalRuntimeContext(
  actor: ApiTestUser,
): Promise<void> {
  await api.ensurePersonalSubscriptionModel(actor, {
    model: "claude-fable-5-1",
  });
}

describe("chat connector credential placeholders", () => {
  it("keeps firewall-only credentials deferred during Run preparation", async () => {
    const { actor, agentId } = await entitledChatActor();
    const figma = await connectors.connectManualGrant(
      actor,
      "figma",
      "api-token",
      { accessToken: "firewall-figma" },
      agentId,
    );
    await connectors.connectManualGrant(
      actor,
      "gitlab",
      "api-token",
      { accessToken: "firewall-gitlab" },
      agentId,
    );
    const kms = useSecretKmsProbe();
    const run = await sendChatRun(actor, {
      agentId,
      model: "claude-fable-5-1",
      prompt: "Use my firewall-only connectors",
    });
    const { execution, sandboxHeaders } = await runExecution(run.runId);
    expect(kms.decryptCalls).toBe(0);
    expect(execution.environment).toMatchObject({
      FIGMA_TOKEN: "fixture-figma-token",
    });
    expect(execution.secretConnectorMetadataMap?.FIGMA_TOKEN).toMatchObject({
      sourceId: figma.id,
      sourceType: "connector",
    });
    await cancelChatRun(actor, run.runId, sandboxHeaders);
  });

  it("dispatches every connector secret as a placeholder and resolves values on demand", async () => {
    const { actor, agentId } = await entitledChatActor();
    const openai = await connectors.connectManualGrant(
      actor,
      "openai",
      "api-token",
      { apiKey: "request-time-openai-token" },
      agentId,
    );
    await connectors.connectManualGrant(
      actor,
      "figma",
      "api-token",
      { accessToken: "deferred-figma-token" },
      agentId,
    );
    const kms = useSecretKmsProbe();
    const run = await sendChatRun(actor, {
      agentId,
      model: "claude-fable-5-1",
      prompt: "Use request-time connector credentials",
    });
    const { execution, sandboxHeaders } = await runExecution(run.runId);
    expect(kms.decryptCalls).toBe(0);
    expect(execution.environment).toMatchObject({
      OPENAI_TOKEN: expect.stringMatching(/.+/),
      FIGMA_TOKEN: "fixture-figma-token",
    });
    expect(JSON.stringify(execution)).not.toContain(
      "request-time-openai-token",
    );
    expect(execution.secretConnectorMetadataMap?.OPENAI_TOKEN).toMatchObject({
      sourceId: openai.id,
    });
    const resolved = await createFirewallApi(context).requestFirewallAuth(
      { authorization: `Bearer ${execution.firewallToken}` },
      {
        secretConnectorMap: execution.secretConnectorMap ?? undefined,
        secretConnectorMetadataMap:
          execution.secretConnectorMetadataMap ?? undefined,
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("OPENAI_TOKEN")}`,
        },
      },
      [200],
    );
    expect(resolved.body).toMatchObject({
      headers: { Authorization: "Bearer request-time-openai-token" },
    });
    const deferred = await createFirewallApi(context).requestFirewallAuth(
      { authorization: `Bearer ${execution.firewallToken}` },
      {
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("FIGMA_TOKEN")}`,
        },
        secretConnectorMap: execution.secretConnectorMap ?? undefined,
        secretConnectorMetadataMap:
          execution.secretConnectorMetadataMap ?? undefined,
      },
      [200],
    );
    expect(deferred.body).toMatchObject({
      headers: { Authorization: "Bearer deferred-figma-token" },
    });
    await cancelChatRun(actor, run.runId, sandboxHeaders);
  });

  it("isolates an undecryptable unselected account from request-time selected account auth", async () => {
    const { actor, agentId } = await entitledChatActor();
    let badAccount = true;
    const kms = useSecretKmsProbe(
      (request) => {
        return badAccount
          ? Promise.resolve({
              keyId: request.keyId,
              plaintext: Buffer.from("0123456789abcdef0123456789abcdef"),
              encryptedDataKey: Buffer.from("unavailable-account-key"),
            })
          : undefined;
      },
      (request) => {
        return Buffer.from(request.ciphertext).toString() ===
          "unavailable-account-key"
          ? Promise.reject(new Error("KMS account key unavailable"))
          : undefined;
      },
    );
    await connectors.connectManualGrant(
      actor,
      "openai",
      "api-token",
      { apiKey: "bad-account-token" },
      agentId,
    );
    badAccount = false;
    const good = await connectors.connectManualGrant(
      actor,
      "openai",
      "api-token",
      { apiKey: "good-account-token" },
      agentId,
    );
    const thread = await chat.createThread(actor, {
      agentId,
      title: "Credential failure isolation",
    });
    await accept(
      chatThreadConnectorSelectionsClient().update({
        headers: sessionHeaders(actor),
        params: { id: thread.id },
        body: {
          connectionId: good.id,
          target: { kind: "builtin", connectorSlug: "openai" },
        },
      }),
      [200],
    );
    const beforeLaunch = kms.decryptCalls;
    const run = await sendChatRun(actor, {
      agentId,
      threadId: thread.id,
      model: "claude-fable-5-1",
      prompt: "Use only my selected healthy account",
    });
    const { execution, sandboxHeaders } = await runExecution(run.runId);
    expect(kms.decryptCalls).toBe(beforeLaunch);
    expect(execution.secretConnectorMetadataMap?.OPENAI_TOKEN).toMatchObject({
      sourceId: good.id,
    });
    const resolved = await createFirewallApi(context).requestFirewallAuth(
      { authorization: `Bearer ${execution.firewallToken}` },
      {
        secretConnectorMap: execution.secretConnectorMap ?? undefined,
        secretConnectorMetadataMap:
          execution.secretConnectorMetadataMap ?? undefined,
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("OPENAI_TOKEN")}`,
        },
      },
      [200],
    );
    expect(resolved.body).toMatchObject({
      headers: { Authorization: "Bearer good-account-token" },
    });
    await cancelChatRun(actor, run.runId, sandboxHeaders);
  });
});

describe("CHAT-02: thread connector account selection", () => {
  it("inspects and runs with the thread's selected builtin account", async () => {
    const fixture = await selectedThreadConnectorFixture(
      "Scoped thread catalog selection",
    );

    const selections = await accept(
      chatThreadConnectorSelectionsClient().get({
        headers: sessionHeaders(fixture.actor),
        params: { id: fixture.threadId },
      }),
      [200],
    );
    expect(selections.body.selections).toStrictEqual([
      {
        connectionId: fixture.connectionId,
        target: { kind: "builtin", connectorSlug: "openai" },
      },
    ]);
    const inspection = await accept(
      setupApp({ context, routes: connectorAccountRoutes })(
        connectorAccountsContract,
      ).inspect({
        headers: sessionHeaders(fixture.actor),
        body: { selections: selections.body.selections },
      }),
      [200],
    );
    expect(inspection.body.results).toMatchObject([
      {
        kind: "available",
        connectionId: fixture.connectionId,
        target: { kind: "builtin", connectorSlug: "openai" },
      },
    ]);
    const run = await sendChatRun(fixture.actor, {
      agentId: fixture.agentId,
      threadId: fixture.threadId,
      prompt: "Use the selected account from its current projection",
    });
    const execution = await runExecution(run.runId);
    expect(
      execution.execution.secretConnectorMetadataMap?.OPENAI_TOKEN,
    ).toMatchObject({ sourceId: fixture.connectionId });
    await cancelChatRun(fixture.actor, run.runId, execution.sandboxHeaders);
  });

  describe("with a thread with a selected connector", () => {
    async function prepareScenario() {
      const fixture = await selectedThreadConnectorFixture(
        "Out-of-scope thread catalog selection",
        { legacyConnectorScope: true },
      );
      return { fixture };
    }
    let preparedScenario: Awaited<ReturnType<typeof prepareScenario>>;
    beforeEach(async () => {
      preparedScenario = await prepareScenario();
    });
    it("keeps an out-of-scope thread choice and uses it again after reauthorization", async () => {
      const { fixture } = preparedScenario;
      await api.enableAgentConnectors(fixture.actor, fixture.agentId, []);
      const run = await sendChatRun(fixture.actor, {
        agentId: fixture.agentId,
        threadId: fixture.threadId,
        prompt: "Do not use the connector removed from the agent scope",
      });
      const execution = await runExecution(run.runId);
      expect(
        execution.execution.secretConnectorMetadataMap?.OPENAI_TOKEN,
      ).toBeUndefined();
      await cancelChatRun(fixture.actor, run.runId, execution.sandboxHeaders);
      await api.enableAgentConnectors(fixture.actor, fixture.agentId, [
        "openai",
      ]);
      const selections = await accept(
        chatThreadConnectorSelectionsClient().get({
          headers: sessionHeaders(fixture.actor),
          params: { id: fixture.threadId },
        }),
        [200],
      );
      expect(selections.body.selections).toStrictEqual([
        {
          connectionId: fixture.connectionId,
          target: { kind: "builtin", connectorSlug: "openai" },
        },
      ]);
      const reauthorized = await sendChatRun(fixture.actor, {
        agentId: fixture.agentId,
        threadId: fixture.threadId,
        prompt: "Use the preserved account after reauthorization",
      });
      const reauthorizedExecution = await runExecution(reauthorized.runId);
      expect(
        reauthorizedExecution.execution.secretConnectorMetadataMap
          ?.OPENAI_TOKEN,
      ).toMatchObject({ sourceId: fixture.connectionId });
      await cancelChatRun(
        fixture.actor,
        reauthorized.runId,
        reauthorizedExecution.sandboxHeaders,
      );
    });
  });

  it("uses the selected connector with the personal subscription model", async () => {
    const fixture = await selectedThreadConnectorFixture(
      "Runtime context thread",
    );
    await configurePersonalRuntimeContext(fixture.actor);
    const run = await sendChatRun(fixture.actor, {
      agentId: fixture.agentId,
      threadId: fixture.threadId,
      prompt: "Use the selected connector with my subscription",
    });
    const execution = await runExecution(run.runId);
    expect(execution.execution.environment).toMatchObject({
      ANTHROPIC_MODEL: "claude-fable-5-1",
    });
    expect(
      execution.execution.secretConnectorMetadataMap?.OPENAI_TOKEN,
    ).toMatchObject({ sourceId: fixture.connectionId });
    await cancelChatRun(fixture.actor, run.runId, execution.sandboxHeaders);
  });

  it.each(["revocation", "reauthorization"] as const)(
    "uses the default connector account across %s without an override",
    async (transition) => {
      const { actor, agentId } = await entitledChatActor({
        legacyConnectorScope: true,
      });
      if (!actor.orgId) {
        throw new Error("Expected an organization-scoped chat actor");
      }
      const connection = await connectors.connectManualGrant(
        actor,
        "openai",
        "api-token",
        { apiKey: "thread-selected-openai-key" },
        agentId,
      );

      let threadId: string;
      if (transition === "revocation") {
        context.mocks.ably.publish.mockClear();
        const authorized = await sendChatRun(actor, {
          agentId,
          prompt: "Use my OpenAI connector account",
        });
        const { execution, sandboxHeaders } = await runExecution(
          authorized.runId,
        );
        expect(
          execution.secretConnectorMetadataMap?.OPENAI_TOKEN,
        ).toMatchObject({
          sourceId: connection.id,
        });

        const selections = await accept(
          chatThreadConnectorSelectionsClient().get({
            headers: sessionHeaders(actor),
            params: { id: authorized.threadId },
          }),
          [200],
        );
        expect(selections.body.selections).toStrictEqual([]);
        expect(context.mocks.ably.publish).not.toHaveBeenCalledWith(
          `chatThreadDetailChanged:${authorized.threadId}`,
          null,
        );

        await completeChatRunOk(authorized.runId, sandboxHeaders);
        await flushWaitUntilForTest();
        threadId = authorized.threadId;
      } else {
        const thread = await chat.createThread(actor, {
          agentId,
          title: "Connector reauthorization",
        });
        threadId = thread.id;
      }

      await api.enableAgentConnectors(actor, agentId, []);
      const unauthorized = await sendChatRun(actor, {
        agentId,
        threadId,
        prompt: "Continue while OpenAI is unauthorized",
      });
      const unauthorizedExecution = await runExecution(unauthorized.runId);
      expect(
        unauthorizedExecution.execution.secretConnectorMetadataMap
          ?.OPENAI_TOKEN,
      ).toBeUndefined();
      await completeChatRunOk(
        unauthorized.runId,
        unauthorizedExecution.sandboxHeaders,
      );
      await flushWaitUntilForTest();

      if (transition === "revocation") {
        return;
      }

      await api.enableAgentConnectors(actor, agentId, ["openai"]);
      const reauthorized = await sendChatRun(actor, {
        agentId,
        threadId,
        prompt: "Continue after OpenAI is authorized again",
      });
      const reauthorizedExecution = await runExecution(reauthorized.runId);
      expect(
        reauthorizedExecution.execution.secretConnectorMetadataMap
          ?.OPENAI_TOKEN,
      ).toMatchObject({ sourceId: connection.id });
      await cancelAndCompleteChatRun(actor, reauthorized.runId);
    },
  );

  it("uses default custom HTTP and MCP accounts without persisting overrides", async () => {
    const { actor, agentId } = await entitledChatActor();
    const storage = context.mocks.s3.send.getMockImplementation();
    const storageBucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const kmsKeyId = env("SECRETS_KMS_KEY_ID");
    const connectorIds: string[] = [];
    let cleanupRun: (() => Promise<void>) | undefined;
    let cleaned = false;
    const cleanup = async () => {
      if (cleaned) {
        return;
      }
      if (!storage) {
        throw new Error("Expected the owned Agent's storage implementation");
      }
      context.mocks.s3.send.mockImplementation(storage);
      mockEnv("R2_USER_STORAGES_BUCKET_NAME", storageBucket);
      mockEnv("SECRETS_KMS_KEY_ID", kmsKeyId);
      await cleanupRun?.();
      for (const connectorId of connectorIds) {
        await connectors.deleteCustomConnector(actor, connectorId);
      }
      await createBddApi(context).deleteAgent(actor, agentId);
      cleaned = true;
    };
    onTestFinished(cleanup);
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("Expected an organization-scoped chat actor");
    }
    const httpConnector = await connectors.createCustomConnector(
      actor,
      manualHttpCustomConnectorCreateBody({
        slug: `_thread-http-runtime-${randomUUID()}`,
        displayName: "Thread HTTP runtime connector",
        prefixTemplates: ["https://thread-http-runtime.example.test/v1/"],
        permissionBundleRef: "builtin:slack@1",
      }),
    );
    connectorIds.push(httpConnector.id);
    const mcpConnector = await connectors.createCustomConnector(actor, {
      kind: "mcp",
      slug: `_thread-mcp-runtime-${randomUUID()}`,
      displayName: "Thread MCP runtime connector",
      endpoint: "https://thread-mcp-runtime.example.test/server",
      transport: "streamable-http",
      fields: [
        {
          key: "secret",
          label: "API token",
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
    });
    connectorIds.push(mcpConnector.id);
    await connectors.setCustomConnectorSecret(
      actor,
      httpConnector.id,
      "thread-http-runtime-secret",
    );
    await connectors.setCustomConnectorSecret(
      actor,
      mcpConnector.id,
      "thread-mcp-runtime-secret",
    );
    await connectors.updateAgentCustomConnectors(actor, agentId, [
      httpConnector.id,
      mcpConnector.id,
    ]);
    const httpAccounts = await connectors.listCustomConnectorAccounts(
      actor,
      httpConnector.id,
    );
    const mcpAccounts = await connectors.listCustomConnectorAccounts(
      actor,
      mcpConnector.id,
    );
    const httpConnectorId = httpAccounts.find((account) => {
      return account.isDefault;
    })?.id;
    const mcpConnectorId = mcpAccounts.find((account) => {
      return account.isDefault;
    })?.id;
    if (!httpConnectorId || !mcpConnectorId) {
      throw new Error("Expected custom HTTP and MCP connector accounts");
    }

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "Use my selected HTTP and MCP connector accounts",
    });
    cleanupRun = async () => {
      await api.requestCancelRun(actor, run.runId, [200]);
      await flushWaitUntilForTest();
    };
    const execution = await runExecution(run.runId);
    cleanupRun = async () => {
      await cancelChatRun(actor, run.runId, execution.sandboxHeaders);
    };
    const targets = [
      {
        kind: "custom",
        customConnectorId: httpConnector.id,
        baseUrlVars: {},
        sourceId: httpConnectorId,
      },
      {
        kind: "custom",
        customConnectorId: mcpConnector.id,
        baseUrlVars: {},
        sourceId: mcpConnectorId,
      },
    ].sort((left, right) => {
      return left.customConnectorId.localeCompare(right.customConnectorId);
    });
    expect(execution.execution.connectorRuntimeTargets).toStrictEqual(targets);
    const firewalls = execution.execution.firewalls?.filter((entry) => {
      return entry.kind === "inline" && entry.customConnectorId;
    });
    expect(firewalls).toMatchObject(
      targets.map((target) => {
        return {
          kind: "inline",
          customConnectorId: target.customConnectorId,
          sourceId: target.sourceId,
        };
      }),
    );
    const firewall = createFirewallApi(context);
    for (const entry of firewalls ?? []) {
      if (entry.kind !== "inline") {
        throw new Error("Expected a custom inline firewall");
      }
      const api = entry.firewall.apis[0];
      if (!api?.id) {
        throw new Error("Expected the custom firewall API identity");
      }
      const auth = await firewall.requestFirewallAuth(
        { authorization: `Bearer ${execution.execution.firewallToken}` },
        {
          authHeaders: api.auth.headers ?? {},
          matchedFirewall: {
            name: entry.firewall.name,
            apiId: api.id,
            customConnectorId: entry.customConnectorId,
            sourceId: entry.sourceId,
            routingVariables: {},
          },
        },
        [200],
      );
      expect(auth.body).toMatchObject({
        headers: {
          Authorization:
            entry.customConnectorId === httpConnector.id
              ? "Bearer thread-http-runtime-secret"
              : "Bearer thread-mcp-runtime-secret",
        },
      });
    }
    expect(
      execution.execution.networkPolicies?.[
        `custom_connector_${httpConnector.id.replaceAll("-", "")}`
      ],
    ).toMatchObject({ unknownPolicy: "deny" });
    const selections = await accept(
      chatThreadConnectorSelectionsClient().get({
        headers: sessionHeaders(actor),
        params: { id: run.threadId },
      }),
      [200],
    );
    expect(selections.body.selections).toStrictEqual([]);
    await cleanup();
  });

  it("uses the default custom account when a preferred account cannot render the updated host template", async () => {
    const fixture = await publicChatActor(context);
    const { actor, agentId, run: own } = fixture;
    fixture.ownsFeatureSwitches();
    await own(() => {
      return connectors.updateFeatureSwitches(actor, {
        connectorChatAccountAccess: false,
      });
    });
    const body = {
      ...manualHttpCustomConnectorCreateBody({
        slug: `_host-fallback-${randomUUID()}`,
        displayName: "Host template fallback",
        prefixTemplates: ["https://fallback.example.test/"],
      }),
      fields: [
        { key: "secret", label: "Secret", kind: "secret", required: true },
        { key: "tenant", label: "Tenant", kind: "variable", required: true },
      ],
    } satisfies Parameters<typeof connectors.createCustomConnector>[1];
    const custom = await own(() => {
      return connectors.createCustomConnector(actor, body);
    });
    const fallback = await own(() => {
      return connectors.setCustomConnectorValues(actor, custom.id, [
        { key: "secret", kind: "secret", value: "fallback-account-secret" },
        { key: "tenant", kind: "variable", value: "healthy" },
      ]);
    });
    const preferred = await own(() => {
      return connectors.setCustomConnectorValues(
        actor,
        custom.id,
        [
          { key: "secret", kind: "secret", value: "preferred-account-secret" },
          { key: "tenant", kind: "variable", value: "not/a/hostname" },
        ],
        { intent: "add", displayName: "Preferred account" },
      );
    });
    await own(() => {
      return connectors.updateAgentCustomConnectors(actor, agentId, [
        custom.id,
      ]);
    });
    const thread = await own(() => {
      return chat.createThread(actor, { agentId });
    });
    await own(() => {
      return accept(
        chatThreadConnectorSelectionsClient().update({
          headers: sessionHeaders(actor),
          params: { id: thread.id },
          body: {
            connectionId: preferred.connectionId,
            target: { kind: "custom", customConnectorId: custom.id },
          },
        }),
        [200],
      );
    });
    await own(() => {
      return connectors.updateCustomConnector(actor, custom.id, {
        ...body,
        prefixTemplates: [
          "https://{{variables.tenant}}.fallback.example.test/",
        ],
      });
    });
    await own(() => {
      return connectors.updateAgentCustomConnectors(actor, agentId, [
        custom.id,
      ]);
    });
    const run = await fixture.sendChatRun(actor, {
      agentId,
      threadId: thread.id,
      model: "claude-fable-5-1",
      prompt: "Use the available custom account after the host template update",
    });
    const { execution } = await fixture.runExecution(run.runId);
    expect(execution.connectorRuntimeTargets).toContainEqual({
      kind: "custom",
      customConnectorId: custom.id,
      sourceId: fallback.connectionId,
      baseUrlVars: { tenant: "healthy" },
    });
    expect(execution.firewalls).toContainEqual(
      expect.objectContaining({
        kind: "inline",
        customConnectorId: custom.id,
        sourceId: fallback.connectionId,
        firewall: expect.objectContaining({
          apis: [
            expect.objectContaining({
              base: "https://healthy.fallback.example.test/",
            }),
          ],
        }),
      }),
    );
  });

  it("starts the run when a selected custom connector becomes unavailable", async () => {
    const fixture = await publicChatActor(context);
    const { actor, agentId, run: own } = fixture;
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("Expected an organization-scoped chat actor");
    }
    const customConnector = await own(() => {
      return connectors.createCustomConnector(
        actor,
        manualHttpCustomConnectorCreateBody({
          slug: `_thread-runtime-${randomUUID()}`,
          displayName: "Thread runtime connector",
          prefixTemplates: ["https://thread-runtime.example.test/v1/"],
        }),
      );
    });
    await own(() => {
      return connectors.setCustomConnectorSecret(
        actor,
        customConnector.id,
        "thread-runtime-secret",
      );
    });
    await own(() => {
      return connectors.updateAgentCustomConnectors(actor, agentId, [
        customConnector.id,
      ]);
    });
    const [connection] = await own(() => {
      return connectors.listCustomConnectorAccounts(actor, customConnector.id);
    });
    if (!connection) {
      throw new Error("Expected the public custom connector account");
    }
    const connectorId = connection.id;

    const first = await fixture.sendChatRun(actor, {
      agentId,
      prompt: "Use my default custom connector account",
    });
    await own(() => {
      return accept(
        chatThreadConnectorSelectionsClient().update({
          headers: sessionHeaders(actor),
          params: { id: first.threadId },
          body: {
            connectionId: connectorId,
            target: {
              kind: "custom",
              customConnectorId: customConnector.id,
            },
          },
        }),
        [200],
      );
    });
    const availableSelection = await own(() => {
      return accept(
        chatThreadConnectorSelectionsClient().get({
          headers: sessionHeaders(actor),
          params: { id: first.threadId },
        }),
        [200],
      );
    });
    expect(availableSelection.body.selectedConnections).toMatchObject([
      {
        id: connectorId,
        target: { kind: "custom", customConnectorId: customConnector.id },
        connectionStatus: "connected",
      },
    ]);
    const firstExecution = await fixture.runExecution(first.runId);
    await own(() => {
      return cancelChatRun(actor, first.runId, firstExecution.sandboxHeaders);
    });
    await own(() => {
      return connectors.updateCustomConnector(actor, customConnector.id, {
        ...manualHttpCustomConnectorCreateBody({
          slug: `_thread-runtime-${randomUUID()}`,
          displayName: "Thread runtime connector",
          prefixTemplates: ["https://thread-runtime.example.test/v1/"],
        }),
        fields: [
          {
            key: "replacement_key",
            label: "Replacement key",
            kind: "secret",
            required: true,
          },
        ],
        headerInjections: [
          {
            name: "Authorization",
            valueTemplate: "Bearer {{secrets.replacement_key}}",
          },
        ],
      });
    });

    const fallback = await fixture.sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "Continue despite the unavailable connector account",
    });
    const execution = await fixture.runExecution(fallback.runId);
    expect(execution.execution.connectorRuntimeTargets).not.toContainEqual(
      expect.objectContaining({ customConnectorId: customConnector.id }),
    );
    const selections = await own(() => {
      return accept(
        chatThreadConnectorSelectionsClient().get({
          headers: sessionHeaders(actor),
          params: { id: first.threadId },
        }),
        [200],
      );
    });
    expect(selections.body.selections).toContainEqual({
      connectionId: connectorId,
      target: { kind: "custom", customConnectorId: customConnector.id },
    });
    await own(() => {
      return cancelChatRun(actor, fallback.runId, execution.sandboxHeaders);
    });
  });
});
