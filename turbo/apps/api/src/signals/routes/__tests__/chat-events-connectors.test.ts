import { randomUUID } from "node:crypto";
import { chatThreadConnectorSelectionContract } from "@okouai/api-contracts/contracts/chat-threads";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { describe, expect, it, onTestFinished, beforeEach } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { holdChatThreadRowLockFixture } from "../../../test-fixtures/chat-events";
import {
  API_TEST_CONNECTOR_CATALOG,
  apiTestConnectorCatalogValidationAuthority,
  clearApiTestConnectorCatalogExternalReaderIdentityReplacements,
  clearApiTestConnectorCatalogRuntimeProjectionIdentityReplacements,
  deleteApiTestConnectorCatalogRuntimeProjectionRow,
  deleteApiTestConnectorCatalogRuntimeProjectionSet,
  installApiTestConnectorCatalog,
  replaceApiTestConnectorCatalogStoredBytes,
  setApiTestConnectorCatalogExternalReaderIdentityReadHook,
  setApiTestConnectorCatalogRuntimeProjectionIdentityReadHook,
} from "../../../test-fixtures/connector-catalog";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { chatThreadRoutes } from "../chat-threads";
import { connectorAccountRoutes } from "../connector-accounts";
import type { ApiTestUser } from "./helpers/api-bdd";
import { manualHttpCustomConnectorCreateBody } from "./helpers/api-bdd-connectors";
import {
  readCustomConnectorCredentialStorageParent,
  setCustomConnectorCredentialStorageState,
} from "./helpers/connector-credential-storage-state";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import {
  createChatEventsFixture,
  type EntitledChatActor,
} from "./helpers/chat-events-fixture";

const context = testContext();
const {
  api,
  chat,
  connectors,
  entitledChatActor,
  sendChatRun,
  claimChatRun,
  completeChatRunOk,
  cancelChatRun,
  modelProviderConnectionsClient,
  chatThreadsClient,
  sessionHeaders,
} = createChatEventsFixture(context);

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
  // A unique version still shares the active source with other test files.
  // Own the source so their catalog setup cannot invalidate this projection.
  mockEnv(
    "R2_USER_STORAGES_BUCKET_NAME",
    `test-thread-runtime-context-${randomUUID()}`,
  );
  await installApiTestConnectorCatalog({
    catalogVersion: `api-test-thread-runtime-overlap-${randomUUID()}`,
    runtimeProjection: true,
  });
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

async function configureRuntimeContextGateway(
  actor: ApiTestUser,
): Promise<void> {
  const gateway = await accept(
    modelProviderConnectionsClient().create({
      headers: sessionHeaders(actor),
      body: {
        displayName: "Runtime context priority gateway",
        secret: "runtime-context-priority-secret",
        surfaces: [
          {
            protocol: "anthropic-messages",
            apiBaseUrl:
              "https://runtime-context-priority.example.com/anthropic",
            authHeaderName: "Authorization",
            authHeaderTemplate: "Bearer {{secret}}",
            modelMappings: {
              "claude-sonnet-5": "anthropic/claude-sonnet-4.6",
            },
          },
        ],
      },
    }),
    [201],
  );
  const surfaceId = gateway.body.surfaces[0]?.id;
  if (!surfaceId) {
    throw new Error("Expected the runtime context gateway to have a surface");
  }
  await api.updateOrgModelPolicies(actor, [
    {
      model: "claude-sonnet-5",
      isDefault: true,
      defaultProviderType: "custom-anthropic-messages",
      credentialScope: "org",
      modelProviderId: null,
      modelProviderSurfaceId: surfaceId,
    },
  ]);
}

function setThreadConnectorCatalogReadHook(hook: () => Promise<void>): void {
  // Admission first reads the run scope's projection and passes that result
  // into preparation. Inject the failure/barrier only on the subsequent
  // current-authority read for the stored thread account.
  let admissionRead = true;
  setApiTestConnectorCatalogRuntimeProjectionIdentityReadHook(() => {
    if (admissionRead) {
      admissionRead = false;
      return Promise.resolve();
    }
    return hook();
  });
}

describe("CHAT-02: thread connector account selection", () => {
  it.each(["missing", "incomplete"] as const)(
    "reads the selected account when the catalog projection is %s",
    async (projectionState) => {
      const fixture = await selectedThreadConnectorFixture(
        "Thread catalog projection fallback",
      );
      // Advance authority so setup's cached selection cannot hide a missing row.
      await installApiTestConnectorCatalog({
        catalogVersion: `api-test-thread-fallback-${randomUUID()}`,
        runtimeProjection: true,
      });
      // Model an older/incomplete persisted projection through the external
      // database fixture; public APIs cannot create these rollout states.
      if (projectionState === "missing") {
        await deleteApiTestConnectorCatalogRuntimeProjectionSet();
      } else {
        await deleteApiTestConnectorCatalogRuntimeProjectionRow("openai");
      }
      const selections = await accept(
        chatThreadConnectorSelectionsClient().get({
          headers: sessionHeaders(fixture.actor),
          params: { id: fixture.threadId },
        }),
        [200],
      );
      expect(selections.body.selectedConnections).toMatchObject([
        {
          id: fixture.connectionId,
          target: { kind: "builtin", connectorSlug: "openai" },
          connectionStatus: "connected",
        },
      ]);
    },
  );

  it("uses a selected builtin account without reading the full catalog", async () => {
    const fixture = await selectedThreadConnectorFixture(
      "Scoped thread catalog selection",
    );
    onTestFinished(() => {
      clearApiTestConnectorCatalogExternalReaderIdentityReplacements();
    });
    // Reject the external full-snapshot read while leaving real scoped
    // PostgreSQL projections available to this API request.
    setApiTestConnectorCatalogExternalReaderIdentityReadHook(() => {
      return Promise.reject(new Error("Full catalog read is unavailable"));
    });

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
    it("preserves an out-of-scope choice without requiring its catalog", async () => {
      const { fixture } = preparedScenario;
      await api.enableAgentConnectors(fixture.actor, fixture.agentId, []);
      onTestFinished(() => {
        clearApiTestConnectorCatalogExternalReaderIdentityReplacements();
        clearApiTestConnectorCatalogRuntimeProjectionIdentityReplacements();
      });
      const rejectCatalogRead = () => {
        return Promise.reject(new Error("Connector catalog is unavailable"));
      };
      setApiTestConnectorCatalogExternalReaderIdentityReadHook(
        rejectCatalogRead,
      );
      setApiTestConnectorCatalogRuntimeProjectionIdentityReadHook(
        rejectCatalogRead,
      );
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

      clearApiTestConnectorCatalogExternalReaderIdentityReplacements();
      clearApiTestConnectorCatalogRuntimeProjectionIdentityReplacements();
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

  it("overlaps stored thread selection with model-provider resolution", async () => {
    const fixture = await selectedThreadConnectorFixture(
      "Runtime context overlap thread",
    );
    await configureRuntimeContextGateway(fixture.actor);
    onTestFinished(() => {
      clearApiTestConnectorCatalogRuntimeProjectionIdentityReplacements();
    });
    const threadCatalogReadStarted = createDeferredPromise<void>(
      context.signal,
    );
    onTestFinished(() => {
      if (!threadCatalogReadStarted.settled()) {
        threadCatalogReadStarted.resolve(undefined);
      }
    });
    setThreadConnectorCatalogReadHook(() => {
      if (!threadCatalogReadStarted.settled()) {
        threadCatalogReadStarted.resolve(undefined);
      }
      return Promise.resolve();
    });
    const kms = useSecretKmsProbe(undefined, async () => {
      await threadCatalogReadStarted.promise;
      return Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
    });

    const run = await sendChatRun(fixture.actor, {
      agentId: fixture.agentId,
      threadId: fixture.threadId,
      prompt: "Overlap stored thread selection with runtime context",
    });
    expect(threadCatalogReadStarted.settled()).toBeTruthy();
    clearApiTestConnectorCatalogRuntimeProjectionIdentityReplacements();
    const claimed = await claimChatRun(fixture.runnerGroup, run.runId);
    expect(kms.decryptCalls).toBeGreaterThan(0);
    expect(claimed.claim.environment).toMatchObject({
      ANTHROPIC_BASE_URL:
        "https://runtime-context-priority.example.com/anthropic",
      ANTHROPIC_MODEL: "anthropic/claude-sonnet-4.6",
    });
    expect(
      claimed.claim.secretConnectorMetadataMap?.OPENAI_TOKEN,
    ).toMatchObject({ sourceId: fixture.connectionId });
    await cancelChatRun(fixture.actor, run.runId, claimed.sandboxHeaders);
  });

  it("keeps abort priority over a concurrent thread-selection failure", async () => {
    const fixture = await selectedThreadConnectorFixture(
      "Runtime context abort priority thread",
    );
    onTestFinished(() => {
      clearApiTestConnectorCatalogRuntimeProjectionIdentityReplacements();
    });
    const abortError = new Error("runtime context priority abort");
    abortError.name = "AbortError";
    const abortThreadError = new Error("thread selection below abort");
    const abortController = new AbortController();
    setThreadConnectorCatalogReadHook(() => {
      abortController.abort(abortError);
      return Promise.reject(abortThreadError);
    });
    context.mocks.sentry.captureException.mockClear();
    await expect(
      chat.requestSendEvent(
        fixture.actor,
        {
          agentId: fixture.agentId,
          threadId: fixture.threadId,
          prompt: "Prefer abort over a thread-selection failure",
          clientEventId: randomUUID(),
        },
        [201],
        {},
        abortController.signal,
      ),
    ).rejects.toThrow("Unknown response status 500");
    expect(abortController.signal.reason).toBe(abortError);
    expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
  });

  it("keeps thread-selection failure priority over a concurrent provider failure", async () => {
    const fixture = await selectedThreadConnectorFixture(
      "Runtime context thread priority thread",
    );
    await configureRuntimeContextGateway(fixture.actor);
    onTestFinished(() => {
      clearApiTestConnectorCatalogRuntimeProjectionIdentityReplacements();
    });
    const providerFailureStarted = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!providerFailureStarted.settled()) {
        providerFailureStarted.resolve(undefined);
      }
    });
    const threadError = new Error("runtime thread selection priority failure");
    const providerError = new Error("model provider below thread failure");
    setThreadConnectorCatalogReadHook(async () => {
      await providerFailureStarted.promise;
      throw threadError;
    });
    const kms = useSecretKmsProbe(undefined, () => {
      if (!providerFailureStarted.settled()) {
        providerFailureStarted.resolve(undefined);
      }
      return Promise.reject(providerError);
    });
    context.mocks.sentry.captureException.mockClear();
    await expect(
      chat.requestSendEvent(
        fixture.actor,
        {
          agentId: fixture.agentId,
          threadId: fixture.threadId,
          prompt: "Prefer thread selection over provider failure",
          clientEventId: randomUUID(),
        },
        [201],
      ),
    ).rejects.toThrow("Unknown response status 500");
    expect(providerFailureStarted.settled()).toBeTruthy();
    expect(kms.decryptCalls).toBeGreaterThan(0);
    expect(context.mocks.sentry.captureException).toHaveBeenCalledWith(
      threadError,
    );
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
      const unauthorizedResponse = await chat.requestSendEvent(
        actor,
        {
          agentId,
          threadId,
          prompt: "Continue while OpenAI is unauthorized",
        },
        [201],
      );
      if (unauthorizedResponse.status !== 201) {
        throw new Error("Expected the unauthorized-connector send to succeed");
      }
      if (!unauthorizedResponse.body.runId) {
        throw new Error("Expected the unauthorized-connector run to start");
      }
      const unauthorized = {
        runId: unauthorizedResponse.body.runId,
        threadId: unauthorizedResponse.body.threadId,
      };
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

  it("does not persist connector overrides during concurrent first sends", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("Expected an organization-scoped chat actor");
    }
    const connection = await connectors.connectManualGrant(
      actor,
      "openai",
      "api-token",
      { apiKey: "concurrent-thread-selected-openai-key" },
      agentId,
    );
    const thread = await chat.createThread(actor, {
      agentId,
      title: "Concurrent connector selection thread",
    });
    const threadLock = await holdChatThreadRowLockFixture({
      threadId: thread.id,
      signal: context.signal,
    });
    onTestFinished(async () => {
      threadLock.release();
      await threadLock.done;
    });

    const clientEventIds = [randomUUID(), randomUUID()] as const;
    const sends = clientEventIds.map((clientEventId, index) => {
      return chat.requestSendEvent(
        actor,
        {
          agentId,
          threadId: thread.id,
          prompt: `Concurrent connector selection send ${index + 1}`,
          clientEventId,
        },
        [201],
      );
    });
    await expect.poll(threadLock.blockedWaiterCount).toBeGreaterThanOrEqual(2);
    threadLock.release();
    await threadLock.done;

    const responses = await Promise.all(sends);
    const responseBodies = responses.map((response) => {
      if (response.status !== 201) {
        throw new Error("Expected both concurrent sends to be accepted");
      }
      return response.body;
    });
    const activeIndexes = responseBodies.flatMap((body, index) => {
      return body.runId === null ? [] : [index];
    });
    expect(activeIndexes).toHaveLength(1);
    const activeIndex = activeIndexes[0];
    if (activeIndex === undefined) {
      throw new Error("Expected one concurrent send to start a run");
    }
    const activeRunId = responseBodies[activeIndex]?.runId;
    if (!activeRunId) {
      throw new Error("Expected the active concurrent send to have a run id");
    }
    const queuedEventId = clientEventIds.find((_, index) => {
      return index !== activeIndex;
    });
    if (!queuedEventId) {
      throw new Error("Expected one concurrent send to remain queued");
    }

    const claimed = await claimChatRun(runnerGroup, activeRunId);
    expect(
      claimed.claim.secretConnectorMetadataMap?.OPENAI_TOKEN,
    ).toMatchObject({ sourceId: connection.id });
    const selections = await accept(
      chatThreadConnectorSelectionsClient().get({
        headers: sessionHeaders(actor),
        params: { id: thread.id },
      }),
      [200],
    );
    expect(selections.body.selections).toStrictEqual([]);

    const recalled = await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: thread.id,
        revokesEventId: queuedEventId,
        clientEventId: randomUUID(),
      },
      [201],
    );
    if (recalled.status !== 201) {
      throw new Error("Expected the queued concurrent send to be recalled");
    }
    expect(recalled.body.runId).toBeNull();
    await cancelChatRun(actor, activeRunId, claimed.sandboxHeaders);
  });

  it("uses default custom HTTP and MCP accounts without persisting overrides", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
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
    const httpConnection = await readCustomConnectorCredentialStorageParent(
      context,
      {
        orgId,
        userId: actor.userId,
        customConnectorId: httpConnector.id,
      },
    );
    const mcpConnection = await readCustomConnectorCredentialStorageParent(
      context,
      {
        orgId,
        userId: actor.userId,
        customConnectorId: mcpConnector.id,
      },
    );
    const httpConnectorId = httpConnection.connector?.id;
    const mcpConnectorId = mcpConnection.connector?.id;
    if (!httpConnectorId || !mcpConnectorId) {
      throw new Error("Expected custom HTTP and MCP connector accounts");
    }

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "Use my selected HTTP and MCP connector accounts",
    });
    const claimed = await claimChatRun(runnerGroup, run.runId);
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
    await cancelChatRun(actor, run.runId, claimed.sandboxHeaders);
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
    onTestFinished(() => {
      clearApiTestConnectorCatalogExternalReaderIdentityReplacements();
      clearApiTestConnectorCatalogRuntimeProjectionIdentityReplacements();
    });
    const rejectBuiltinCatalogRead = () => {
      return Promise.reject(new Error("Builtin catalog is unavailable"));
    };
    setApiTestConnectorCatalogExternalReaderIdentityReadHook(
      rejectBuiltinCatalogRead,
    );
    setApiTestConnectorCatalogRuntimeProjectionIdentityReadHook(
      rejectBuiltinCatalogRead,
    );
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
    clearApiTestConnectorCatalogExternalReaderIdentityReplacements();
    clearApiTestConnectorCatalogRuntimeProjectionIdentityReplacements();
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

  it("starts the run when the runtime catalog no longer contains the selected built-in", async () => {
    // Catalog rows are global by source, so isolate mutations from parallel test files.
    mockEnv(
      "R2_USER_STORAGES_BUCKET_NAME",
      `test-chat-retired-catalog-connector-${randomUUID()}`,
    );
    await installApiTestConnectorCatalog({ runtimeProjection: true });
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("Expected an organization-scoped chat actor");
    }
    const connection = await connectors.connectManualGrant(
      actor,
      "openai",
      "api-token",
      { apiKey: "retired-thread-openai-key" },
      agentId,
    );
    const runtimeConnection = await connectors.connectManualGrant(
      actor,
      "runtime",
      "api-token",
      { apiKey: "retired-thread-runtime-key" },
      agentId,
    );
    const thread = await chat.createThread(actor, {
      agentId,
      title: "Retired catalog connector thread",
    });
    await accept(
      chatThreadConnectorSelectionsClient().update({
        headers: sessionHeaders(actor),
        params: { id: thread.id },
        body: {
          connectionId: connection.id,
          target: { kind: "builtin", connectorSlug: "openai" },
        },
      }),
      [200],
    );
    await accept(
      chatThreadConnectorSelectionsClient().update({
        headers: sessionHeaders(actor),
        params: { id: thread.id },
        body: {
          connectionId: runtimeConnection.id,
          target: { kind: "builtin", connectorSlug: "runtime" },
        },
      }),
      [200],
    );

    const catalogVersion = `api-test-without-openai-${randomUUID()}`;
    const catalogWithoutOpenAi = {
      ...API_TEST_CONNECTOR_CATALOG,
      catalogVersion,
      connectors: API_TEST_CONNECTOR_CATALOG.connectors.filter((connector) => {
        return connector.slug !== "openai";
      }),
    };
    await replaceApiTestConnectorCatalogStoredBytes({
      catalogVersion,
      rawBytes: Buffer.from(`${JSON.stringify(catalogWithoutOpenAi)}\n`),
      catalogValidationAuthority: apiTestConnectorCatalogValidationAuthority(),
    });

    const run = await sendChatRun(actor, {
      agentId,
      threadId: thread.id,
      prompt: "Continue after the selected connector leaves the catalog",
    });
    const claimed = await claimChatRun(runnerGroup, run.runId);
    expect(
      claimed.claim.secretConnectorMetadataMap?.OPENAI_TOKEN,
    ).toBeUndefined();

    const selections = await accept(
      chatThreadConnectorSelectionsClient().get({
        headers: sessionHeaders(actor),
        params: { id: thread.id },
      }),
      [200],
    );
    expect(selections.body.selections).toStrictEqual([
      {
        connectionId: runtimeConnection.id,
        target: { kind: "builtin", connectorSlug: "runtime" },
      },
    ]);
    await accept(
      chatThreadConnectorSelectionsClient().update({
        headers: sessionHeaders(actor),
        params: { id: thread.id },
        body: {
          connectionId: connection.id,
          target: { kind: "builtin", connectorSlug: "openai" },
        },
      }),
      [400],
    );
    await accept(
      chatThreadsClient().create({
        headers: sessionHeaders(actor),
        body: {
          agentId,
          model: "claude-sonnet-5",
          connectorSelections: [
            {
              connectionId: connection.id,
              target: { kind: "builtin", connectorSlug: "openai" },
            },
          ],
        },
      }),
      [400],
    );
    await accept(
      chatThreadConnectorSelectionsClient().clear({
        headers: sessionHeaders(actor),
        params: { id: thread.id },
        body: { kind: "builtin", connectorSlug: "openai" },
      }),
      [204],
    );
    await installApiTestConnectorCatalog();
    const restoredSelections = await accept(
      chatThreadConnectorSelectionsClient().get({
        headers: sessionHeaders(actor),
        params: { id: thread.id },
      }),
      [200],
    );
    expect(restoredSelections.body.selections).toStrictEqual(
      selections.body.selections,
    );
    await cancelChatRun(actor, run.runId, claimed.sandboxHeaders);
  });
});
