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
import {
  readCustomConnectorCredentialStorageParent,
  setCustomConnectorCredentialStorageState,
} from "./helpers/connector-credential-storage-state";
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
  claimChatRun,
  completeChatRunOk,
  cancelChatRun,
  sessionHeaders,
} = createChatEventsFixture(context);

// Connector selection tests observe claimable native runs; Sonnet's Pi route
// can finish API-first before these Runner assertions execute.
async function entitledChatActor() {
  const result = await createEntitledChatActor();
  await api.updateUserModelPreference(result.actor, "claude-fable-5-1");
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
): Promise<SelectedThreadConnectorFixture> {
  const entitled = await entitledChatActor();
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

describe("chat eager connector credentials", () => {
  it("does not decrypt firewall-only credentials at launch", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
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
    expect(kms.decryptCalls).toBe(0);
    const { claim, sandboxHeaders } = await claimChatRun(
      runnerGroup,
      run.runId,
    );
    expect(claim.environment).toMatchObject({
      FIGMA_TOKEN: "fixture-figma-token",
    });
    expect(claim.secretConnectorMetadataMap?.FIGMA_TOKEN).toMatchObject({
      sourceId: figma.id,
      sourceType: "connector",
    });
    await cancelChatRun(actor, run.runId, sandboxHeaders);
  });

  it("decrypts only the eager connector and delivers its plaintext to the runner", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const openai = await connectors.connectManualGrant(
      actor,
      "openai",
      "api-token",
      { apiKey: "eager-openai-token" },
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
      prompt: "Use eager and deferred connector credentials",
    });
    expect(kms.decryptCalls).toBe(1);
    const { claim, sandboxHeaders } = await claimChatRun(
      runnerGroup,
      run.runId,
    );
    expect(claim.environment).toMatchObject({
      OPENAI_TOKEN: "eager-openai-token",
      FIGMA_TOKEN: "fixture-figma-token",
    });
    expect(claim.secretConnectorMetadataMap?.OPENAI_TOKEN).toMatchObject({
      sourceId: openai.id,
    });
    if (!claim.encryptedSecrets) {
      throw new Error("Expected runner launch secrets");
    }
    const plaintext = await createFirewallApi(context).requestFirewallAuth(
      sandboxHeaders,
      {
        encryptedSecrets: claim.encryptedSecrets,
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("OPENAI_TOKEN")}`,
        },
      },
      [200],
    );
    expect(plaintext.body).toMatchObject({
      headers: { Authorization: "Bearer eager-openai-token" },
    });
    const deferred = await createFirewallApi(context).requestFirewallAuth(
      sandboxHeaders,
      {
        encryptedSecrets: claim.encryptedSecrets,
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("FIGMA_TOKEN")}`,
        },
        secretConnectorMap: claim.secretConnectorMap ?? undefined,
        secretConnectorMetadataMap:
          claim.secretConnectorMetadataMap ?? undefined,
      },
      [200],
    );
    expect(deferred.body).toMatchObject({
      headers: { Authorization: "Bearer deferred-figma-token" },
    });
    await cancelChatRun(actor, run.runId, sandboxHeaders);
  });

  it("isolates an undecryptable unselected account from the selected eager account", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
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
    expect(kms.decryptCalls - beforeLaunch).toBe(1);
    const { claim, sandboxHeaders } = await claimChatRun(
      runnerGroup,
      run.runId,
    );
    expect(claim.secretConnectorMetadataMap?.OPENAI_TOKEN).toMatchObject({
      sourceId: good.id,
    });
    if (!claim.encryptedSecrets) {
      throw new Error("Expected runner launch secrets");
    }
    const resolved = await createFirewallApi(context).requestFirewallAuth(
      sandboxHeaders,
      {
        encryptedSecrets: claim.encryptedSecrets,
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
    const claimed = await claimChatRun(fixture.runnerGroup, run.runId);
    expect(
      claimed.claim.secretConnectorMetadataMap?.OPENAI_TOKEN,
    ).toMatchObject({ sourceId: fixture.connectionId });
    await cancelChatRun(fixture.actor, run.runId, claimed.sandboxHeaders);
  });

  describe("with a thread with a selected connector", () => {
    async function prepareScenario() {
      const fixture = await selectedThreadConnectorFixture(
        "Out-of-scope thread catalog selection",
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
      const claimed = await claimChatRun(fixture.runnerGroup, run.runId);
      expect(
        claimed.claim.secretConnectorMetadataMap?.OPENAI_TOKEN,
      ).toBeUndefined();
      await cancelChatRun(fixture.actor, run.runId, claimed.sandboxHeaders);
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
      const reauthorizedClaim = await claimChatRun(
        fixture.runnerGroup,
        reauthorized.runId,
      );
      expect(
        reauthorizedClaim.claim.secretConnectorMetadataMap?.OPENAI_TOKEN,
      ).toMatchObject({ sourceId: fixture.connectionId });
      await cancelChatRun(
        fixture.actor,
        reauthorized.runId,
        reauthorizedClaim.sandboxHeaders,
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
    const claimed = await claimChatRun(fixture.runnerGroup, run.runId);
    expect(claimed.claim.environment).toMatchObject({
      ANTHROPIC_MODEL: "claude-fable-5-1",
    });
    expect(
      claimed.claim.secretConnectorMetadataMap?.OPENAI_TOKEN,
    ).toMatchObject({ sourceId: fixture.connectionId });
    await cancelChatRun(fixture.actor, run.runId, claimed.sandboxHeaders);
  });

  it.each(["revocation", "reauthorization"] as const)(
    "uses the default connector account across %s without an override",
    async (transition) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
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
        const { claim, sandboxHeaders } = await claimChatRun(
          runnerGroup,
          authorized.runId,
        );
        expect(claim.secretConnectorMetadataMap?.OPENAI_TOKEN).toMatchObject({
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
      const unauthorizedClaim = await claimChatRun(
        runnerGroup,
        unauthorized.runId,
      );
      expect(
        unauthorizedClaim.claim.secretConnectorMetadataMap?.OPENAI_TOKEN,
      ).toBeUndefined();
      await completeChatRunOk(
        unauthorized.runId,
        unauthorizedClaim.sandboxHeaders,
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
      const reauthorizedClaim = await claimChatRun(
        runnerGroup,
        reauthorized.runId,
      );
      expect(
        reauthorizedClaim.claim.secretConnectorMetadataMap?.OPENAI_TOKEN,
      ).toMatchObject({ sourceId: connection.id });
      await cancelChatRun(actor, reauthorized.runId);
    },
  );

  it("uses default custom HTTP and MCP accounts without persisting overrides", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
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
    const claimed = await claimChatRun(runnerGroup, run.runId);
    cleanupRun = async () => {
      await cancelChatRun(actor, run.runId, claimed.sandboxHeaders);
    };
    expect(claimed.claim.connectorRuntimeTargets).toContainEqual({
      kind: "custom",
      customConnectorId: httpConnector.id,
      baseUrlVars: {},
      sourceId: httpConnectorId,
    });
    expect(claimed.claim.connectorRuntimeTargets).toContainEqual({
      kind: "custom",
      customConnectorId: mcpConnector.id,
      baseUrlVars: {},
      sourceId: mcpConnectorId,
    });
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

  it("starts the run when a selected custom connector becomes unavailable", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("Expected an organization-scoped chat actor");
    }
    const customConnector = await connectors.createCustomConnector(
      actor,
      manualHttpCustomConnectorCreateBody({
        slug: `_thread-runtime-${randomUUID()}`,
        displayName: "Thread runtime connector",
        prefixTemplates: ["https://thread-runtime.example.test/v1/"],
      }),
    );
    await connectors.setCustomConnectorSecret(
      actor,
      customConnector.id,
      "thread-runtime-secret",
    );
    await connectors.updateAgentCustomConnectors(actor, agentId, [
      customConnector.id,
    ]);
    const connection = await readCustomConnectorCredentialStorageParent(
      context,
      {
        orgId,
        userId: actor.userId,
        customConnectorId: customConnector.id,
      },
    );
    const connectorId = connection.connector?.id;
    const storageVersion = connection.connector?.storage_version;
    if (!connectorId || storageVersion === undefined) {
      throw new Error("Expected a custom connector account");
    }

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "Use my default custom connector account",
    });
    await accept(
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
    const availableSelection = await accept(
      chatThreadConnectorSelectionsClient().get({
        headers: sessionHeaders(actor),
        params: { id: first.threadId },
      }),
      [200],
    );
    expect(availableSelection.body.selectedConnections).toMatchObject([
      {
        id: connectorId,
        target: { kind: "custom", customConnectorId: customConnector.id },
        connectionStatus: "connected",
      },
    ]);
    await cancelChatRun(actor, first.runId);
    await setCustomConnectorCredentialStorageState(context, {
      orgId,
      userId: actor.userId,
      customConnectorId: customConnector.id,
      authMethod: "manual",
      storageVersion,
      needsReconnect: true,
    });

    const fallback = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "Continue despite the unavailable connector account",
    });
    const claimed = await claimChatRun(runnerGroup, fallback.runId);
    expect(claimed.claim.connectorRuntimeTargets).not.toContainEqual(
      expect.objectContaining({ customConnectorId: customConnector.id }),
    );
    const selections = await accept(
      chatThreadConnectorSelectionsClient().get({
        headers: sessionHeaders(actor),
        params: { id: first.threadId },
      }),
      [200],
    );
    expect(selections.body.selections).toContainEqual({
      connectionId: connectorId,
      target: { kind: "custom", customConnectorId: customConnector.id },
    });
    await cancelChatRun(actor, fallback.runId, claimed.sandboxHeaders);
  });
});
