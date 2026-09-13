import { randomUUID } from "node:crypto";

import {
  chatThreadConnectorSelectionContract,
  chatThreadMetadataContract,
  chatThreadRenameContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  manualHttpCustomConnectorCreateBody,
} from "./helpers/api-bdd-connectors";
import { readCustomConnectorCredentialStorageParent } from "./helpers/connector-credential-storage-state";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { seedRun$ } from "./helpers/usage-state";
import { createRouteMocks } from "./helpers/route-test";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { chatThreadRoutes } from "../chat-threads";
import { chatThreadGetRoutes } from "../chat-threads-get";
import { chatThreadRenameRoutes } from "../chat-threads-rename";
import { connectorAccountRoutes } from "../connector-accounts";
import { userModelPreferenceRoutes } from "../user-model-preference";

const context = testContext();
const store = createStore();
const bdd = createBddApi(context);
const api = createRunsApi(context);
const connectorApi = createConnectorBddApi(context);

const WORKSPACE_DEFAULT_MODEL = "claude-sonnet-5";
const OTHER_WORKSPACE_MODEL = "claude-opus-4-8";
const PRIORITY_MODEL = "gpt-5.6-sol";
const EXPLICIT_VIDEO_MODEL = "fal-ai/veo3.1/fast";
const INHERITED_VIDEO_MODEL = "MiniMax-H3";
const EXPLICIT_IMAGE_MODEL = "fal-ai/qwen-image";
const INHERITED_IMAGE_MODEL = "gpt-image-2";
const MEMBER_VIDEO_MODEL = "seedance-1-5-pro-251215";
const MEMBER_IMAGE_MODEL = "fal-ai/flux-pro/v1.1";

interface AgentFixture {
  readonly actor: ApiTestUser;
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
}

/** Creates an agent whose workspace allows both policy models. */
async function seedAgent(): Promise<AgentFixture> {
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  const { providerId } = await api.ensureOrgModelProvider(actor);
  await api.updateOrgModelPolicies(actor, [
    {
      model: WORKSPACE_DEFAULT_MODEL,
      isDefault: true,
      defaultProviderType: "anthropic-api-key",
      credentialScope: "org",
      modelProviderId: providerId,
    },
    {
      model: OTHER_WORKSPACE_MODEL,
      isDefault: false,
      defaultProviderType: "anthropic-api-key",
      credentialScope: "org",
      modelProviderId: providerId,
    },
    {
      model: PRIORITY_MODEL,
      isDefault: false,
      defaultProviderType: "codex-oauth-token",
      credentialScope: "member",
      modelProviderId: null,
    },
  ]);
  const agent = await bdd.createAgent(actor, {
    displayName: "Chat thread create agent",
    visibility: "private",
  });
  if (!actor.orgId) {
    throw new Error("Expected the seeded actor to belong to an org");
  }
  await store.set(
    seedOrgMembership$,
    { orgId: actor.orgId, userId: actor.userId },
    context.signal,
  );
  return {
    actor,
    userId: actor.userId,
    orgId: actor.orgId,
    agentId: agent.agentId,
  };
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function okouToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly capabilities: readonly Capability[];
  readonly runId?: string;
}): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "okou",
    userId: args.userId,
    orgId: args.orgId,
    // Run tokens always carry a real run id, and thread creation reads that
    // run's model, so an unrelated id still has to be a uuid.
    runId: args.runId ?? randomUUID(),
    capabilities: [...args.capabilities],
    iat: seconds,
    exp: seconds + 600,
  });
}

function threadsClient() {
  return setupApp({ context, routes: chatThreadRoutes })(chatThreadsContract);
}

function metadataClient() {
  return setupApp({ context, routes: chatThreadGetRoutes })(
    chatThreadMetadataContract,
  );
}

function preferenceClient() {
  return setupApp({ context, routes: userModelPreferenceRoutes })(
    userModelPreferenceContract,
  );
}

/** The preference route only accepts a session, so Okou run tokens cannot seed it. */
async function setMemberMediaDefaults(fixture: AgentFixture): Promise<void> {
  createRouteMocks(context).clerk.session(fixture.userId, fixture.orgId);
  await accept(
    preferenceClient().update({
      headers: { authorization: "Bearer clerk-session" },
      body: {
        selectedModel: null,
        serviceTier: null,
        selectedVideoModel: MEMBER_VIDEO_MODEL,
        selectedImageModel: MEMBER_IMAGE_MODEL,
      },
    }),
    [200],
  );
}

function connectorSelectionsClient() {
  return setupApp({ context, routes: chatThreadRoutes })(
    chatThreadConnectorSelectionContract,
  );
}

function connectorAccountsClient() {
  return setupApp({ context, routes: connectorAccountRoutes })(
    connectorAccountsContract,
  );
}

function renameClient() {
  return setupApp({ context, routes: chatThreadRenameRoutes })(
    chatThreadRenameContract,
  );
}

async function readCreatedThreadEvents(threadId: string, token: string) {
  const response = await accept(
    threadsClient().events({
      headers: { authorization: `Bearer ${token}` },
      query: {},
    }),
    [200],
  );
  return response.body.events.filter((candidate) => {
    return candidate.kind === "created" && candidate.chatThreadId === threadId;
  });
}

async function readCreatedThreadEvent(threadId: string, token: string) {
  const response = await accept(
    threadsClient().events({
      headers: { authorization: `Bearer ${token}` },
      query: {},
    }),
    [200],
  );
  const event = response.body.events.find((candidate) => {
    return candidate.kind === "created" && candidate.chatThreadId === threadId;
  });
  if (!event) {
    throw new Error(`Created event not found for thread ${threadId}`);
  }
  return event;
}

describe("POST /api/chat-threads", () => {
  it("resolves only sparse connector selections during account deletion", async () => {
    const fixture = await seedAgent();
    await updateFeatureSwitchesForUser(context, fixture, {});
    const firstResponse = await connectorApi.requestManualGrant(
      fixture.actor,
      "openai",
      "api-token",
      { apiKey: "first-openai-key" },
      {
        statuses: [200],
        agentId: fixture.agentId,
        authorizeAgent: true,
        account: { intent: "add", displayName: "First" },
      },
    );
    const secondResponse = await connectorApi.requestManualGrant(
      fixture.actor,
      "openai",
      "api-token",
      { apiKey: "second-openai-key" },
      {
        statuses: [200],
        agentId: fixture.agentId,
        authorizeAgent: true,
        account: { intent: "add", displayName: "Second" },
      },
    );
    if (firstResponse.status !== 200 || secondResponse.status !== 200) {
      throw new Error("Expected connector account creation to succeed");
    }
    const token = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:read", "chat-thread:write"],
    });
    const inheritedThread = await accept(
      threadsClient().create({
        headers: { authorization: `Bearer ${token}` },
        body: {
          agentId: fixture.agentId,
          model: WORKSPACE_DEFAULT_MODEL,
        },
      }),
      [201],
    );
    const selectedThread = await accept(
      threadsClient().create({
        headers: { authorization: `Bearer ${token}` },
        body: {
          agentId: fixture.agentId,
          model: WORKSPACE_DEFAULT_MODEL,
          connectorSelections: [
            {
              connectionId: secondResponse.body.id,
              target: { kind: "builtin", connectorSlug: "openai" },
            },
          ],
        },
      }),
      [201],
    );

    createRouteMocks(context).clerk.session(fixture.userId, fixture.orgId);
    const impact = await accept(
      connectorAccountsClient().deletionImpact({
        headers: { authorization: "Bearer clerk-session" },
        params: { connectionId: secondResponse.body.id },
        query: { kind: "builtin", connectorSlug: "openai" },
      }),
      [200],
    );
    expect(impact.body.explicitSelectionCount).toBe(1);

    const deletedSelectedAccount = await accept(
      connectorAccountsClient().delete({
        headers: { authorization: "Bearer clerk-session" },
        params: { connectionId: secondResponse.body.id },
        body: {
          target: { kind: "builtin", connectorSlug: "openai" },
        },
      }),
      [200],
    );
    expect(deletedSelectedAccount.body.resolvedSelectionCount).toBe(1);

    const selected = await accept(
      connectorSelectionsClient().get({
        headers: { authorization: `Bearer ${token}` },
        params: { id: selectedThread.body.id },
      }),
      [200],
    );
    expect(selected.body.selections).toStrictEqual([]);
    expect(selected.body.selectedConnections).toStrictEqual([]);
    const inherited = await accept(
      connectorSelectionsClient().get({
        headers: { authorization: `Bearer ${token}` },
        params: { id: inheritedThread.body.id },
      }),
      [200],
    );
    expect(inherited.body.selections).toStrictEqual([]);
    expect(inherited.body.selectedConnections).toStrictEqual([]);

    createRouteMocks(context).clerk.session(fixture.userId, fixture.orgId);
    const deletedRemainingAccount = await accept(
      connectorAccountsClient().delete({
        headers: { authorization: "Bearer clerk-session" },
        params: { connectionId: firstResponse.body.id },
        body: {
          target: { kind: "builtin", connectorSlug: "openai" },
        },
      }),
      [200],
    );
    expect(deletedRemainingAccount.body.resolvedSelectionCount).toBe(0);
    const afterClear = await accept(
      connectorSelectionsClient().get({
        headers: { authorization: `Bearer ${token}` },
        params: { id: selectedThread.body.id },
      }),
      [200],
    );
    expect(afterClear.body.selections).toStrictEqual([]);
    expect(afterClear.body.selectedConnections).toStrictEqual([]);

    const staleSelectionThread = await accept(
      threadsClient().create({
        headers: { authorization: `Bearer ${token}` },
        body: {
          agentId: fixture.agentId,
          model: WORKSPACE_DEFAULT_MODEL,
          connectorSelections: [
            {
              connectionId: firstResponse.body.id,
              target: { kind: "builtin", connectorSlug: "openai" },
            },
          ],
        },
      }),
      [201],
    );
    const staleSelection = await accept(
      connectorSelectionsClient().get({
        headers: { authorization: `Bearer ${token}` },
        params: { id: staleSelectionThread.body.id },
      }),
      [200],
    );
    expect(staleSelection.body).toStrictEqual({
      selections: [],
      selectedConnections: [],
    });
  });

  it("creates and reads an exact built-in connector account selection", async () => {
    const fixture = await seedAgent();
    await updateFeatureSwitchesForUser(context, fixture, {});
    const connection = await connectorApi.connectManualGrant(
      fixture.actor,
      "openai",
      "api-token",
      { apiKey: "selected-openai-key" },
      fixture.agentId,
    );
    const token = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:read", "chat-thread:write"],
    });

    const created = await accept(
      threadsClient().create({
        headers: { authorization: `Bearer ${token}` },
        body: {
          agentId: fixture.agentId,
          model: WORKSPACE_DEFAULT_MODEL,
          connectorSelections: [
            {
              connectionId: connection.id,
              target: { kind: "builtin", connectorSlug: "openai" },
            },
          ],
        },
      }),
      [201],
    );
    const selections = await accept(
      connectorSelectionsClient().get({
        headers: { authorization: `Bearer ${token}` },
        params: { id: created.body.id },
      }),
      [200],
    );
    expect(selections.body.selections).toStrictEqual([
      {
        connectionId: connection.id,
        target: { kind: "builtin", connectorSlug: "openai" },
      },
    ]);
    expect(selections.body.selectedConnections).toHaveLength(1);
    expect(selections.body.selectedConnections[0]).toMatchObject({
      id: connection.id,
      target: { kind: "builtin", connectorSlug: "openai" },
      connectionStatus: "connected",
    });
    const readToken = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:read"],
    });
    await accept(
      connectorSelectionsClient().get({
        headers: { authorization: `Bearer ${readToken}` },
        params: { id: created.body.id },
      }),
      [200],
    );
    await accept(
      connectorSelectionsClient().update({
        headers: { authorization: `Bearer ${readToken}` },
        params: { id: created.body.id },
        body: {
          connectionId: connection.id,
          target: { kind: "builtin", connectorSlug: "openai" },
        },
      }),
      [403],
    );

    const foreignActor = bdd.user({ orgId: fixture.orgId });
    await store.set(
      seedOrgMembership$,
      { orgId: fixture.orgId, userId: foreignActor.userId },
      context.signal,
    );
    const foreignConnection = await connectorApi.connectManualGrant(
      foreignActor,
      "openai",
      "api-token",
      { apiKey: "foreign-openai-key" },
    );
    await accept(
      threadsClient().create({
        headers: { authorization: `Bearer ${token}` },
        body: {
          agentId: fixture.agentId,
          model: WORKSPACE_DEFAULT_MODEL,
          connectorSelections: [
            {
              connectionId: foreignConnection.id,
              target: { kind: "builtin", connectorSlug: "openai" },
            },
          ],
        },
      }),
      [400],
    );
    const foreignToken = okouToken({
      userId: foreignActor.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:read", "chat-thread:write"],
    });
    await accept(
      connectorSelectionsClient().get({
        headers: { authorization: `Bearer ${foreignToken}` },
        params: { id: created.body.id },
      }),
      [404],
    );

    context.mocks.ably.publish.mockClear();
    const updated = await accept(
      connectorSelectionsClient().update({
        headers: { authorization: `Bearer ${token}` },
        params: { id: created.body.id },
        body: {
          connectionId: connection.id,
          target: { kind: "builtin", connectorSlug: "openai" },
        },
      }),
      [200],
    );
    expect(updated.body.connectionId).toBe(connection.id);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadDetailChanged:${created.body.id}`,
      null,
    );

    await api.enableAgentConnectors(fixture.actor, fixture.agentId, []);
    const preserved = await accept(
      connectorSelectionsClient().get({
        headers: { authorization: `Bearer ${token}` },
        params: { id: created.body.id },
      }),
      [200],
    );
    expect(preserved.body.selections).toStrictEqual(selections.body.selections);
    await accept(
      connectorSelectionsClient().update({
        headers: { authorization: `Bearer ${token}` },
        params: { id: created.body.id },
        body: {
          connectionId: connection.id,
          target: { kind: "builtin", connectorSlug: "openai" },
        },
      }),
      [400],
    );

    context.mocks.ably.publish.mockClear();
    await accept(
      connectorSelectionsClient().clear({
        headers: { authorization: `Bearer ${token}` },
        params: { id: created.body.id },
        body: { kind: "builtin", connectorSlug: "openai" },
      }),
      [204],
    );
    const cleared = await accept(
      connectorSelectionsClient().get({
        headers: { authorization: `Bearer ${token}` },
        params: { id: created.body.id },
      }),
      [200],
    );
    expect(cleared.body.selections).toStrictEqual([]);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      `chatThreadDetailChanged:${created.body.id}`,
      null,
    );

    await api.enableAgentConnectors(fixture.actor, fixture.agentId, ["openai"]);
    await accept(
      connectorSelectionsClient().update({
        headers: { authorization: `Bearer ${token}` },
        params: { id: created.body.id },
        body: {
          connectionId: connection.id,
          target: { kind: "builtin", connectorSlug: "github" },
        },
      }),
      [400],
    );
    await accept(
      connectorSelectionsClient().update({
        headers: { authorization: `Bearer ${token}` },
        params: { id: created.body.id },
        body: {
          connectionId: connection.id,
          target: { kind: "builtin", connectorSlug: "openai" },
        },
      }),
      [200],
    );
    createRouteMocks(context).clerk.session(fixture.userId, fixture.orgId);
    const [concurrentSelectionWrite, concurrentDisconnect] = await Promise.all([
      connectorSelectionsClient().update({
        headers: { authorization: `Bearer ${token}` },
        params: { id: created.body.id },
        body: {
          connectionId: connection.id,
          target: { kind: "builtin", connectorSlug: "openai" },
        },
      }),
      connectorAccountsClient().delete({
        headers: { authorization: "Bearer clerk-session" },
        params: { connectionId: connection.id },
        body: { target: { kind: "builtin", connectorSlug: "openai" } },
      }),
    ]);
    expect([200, 400]).toContain(concurrentSelectionWrite.status);
    expect(concurrentDisconnect.status).toBe(200);
    const afterDisconnect = await accept(
      connectorSelectionsClient().get({
        headers: { authorization: `Bearer ${token}` },
        params: { id: created.body.id },
      }),
      [200],
    );
    expect(afterDisconnect.body.selections).toStrictEqual([]);
  });

  it("creates exact custom HTTP and MCP connector selections", async () => {
    const fixture = await seedAgent();
    await updateFeatureSwitchesForUser(context, fixture, {
      [FeatureSwitchKey.CustomConnectorMcp]: true,
    });
    const httpConnector = await connectorApi.createCustomConnector(
      fixture.actor,
      manualHttpCustomConnectorCreateBody({
        slug: `_thread-http-${randomUUID()}`,
        displayName: "Thread HTTP connector",
        prefixTemplates: ["https://thread-http.example.test/v1/"],
      }),
    );
    const mcpConnector = await connectorApi.createCustomConnector(
      fixture.actor,
      {
        kind: "mcp",
        slug: `_thread-mcp-${randomUUID()}`,
        displayName: "Thread MCP connector",
        endpoint: "https://thread-mcp.example.test/server",
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
      },
    );
    await connectorApi.setCustomConnectorSecret(
      fixture.actor,
      httpConnector.id,
      "thread-http-secret",
    );
    await connectorApi.setCustomConnectorSecret(
      fixture.actor,
      mcpConnector.id,
      "thread-mcp-secret",
    );
    await connectorApi.updateAgentCustomConnectors(
      fixture.actor,
      fixture.agentId,
      [httpConnector.id, mcpConnector.id],
    );
    const httpState = await readCustomConnectorCredentialStorageParent(
      context,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        customConnectorId: httpConnector.id,
      },
    );
    const mcpState = await readCustomConnectorCredentialStorageParent(context, {
      orgId: fixture.orgId,
      userId: fixture.userId,
      customConnectorId: mcpConnector.id,
    });
    const httpConnectionId = httpState.connector?.id;
    const mcpConnectionId = mcpState.connector?.id;
    if (!httpConnectionId || !mcpConnectionId) {
      throw new Error("Expected custom connector account fixtures");
    }
    const token = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:read", "chat-thread:write"],
    });

    const created = await accept(
      threadsClient().create({
        headers: { authorization: `Bearer ${token}` },
        body: {
          agentId: fixture.agentId,
          model: WORKSPACE_DEFAULT_MODEL,
          connectorSelections: [
            {
              connectionId: httpConnectionId,
              target: {
                kind: "custom",
                customConnectorId: httpConnector.id,
              },
            },
            {
              connectionId: mcpConnectionId,
              target: {
                kind: "custom",
                customConnectorId: mcpConnector.id,
              },
            },
          ],
        },
      }),
      [201],
    );
    const selections = await accept(
      connectorSelectionsClient().get({
        headers: { authorization: `Bearer ${token}` },
        params: { id: created.body.id },
      }),
      [200],
    );
    expect(selections.body.selections).toHaveLength(2);
    expect(selections.body.selectedConnections).toHaveLength(2);
    expect(
      selections.body.selections.map((selection) => {
        return selection.connectionId;
      }),
    ).toStrictEqual(
      expect.arrayContaining([httpConnectionId, mcpConnectionId]),
    );

    createRouteMocks(context).clerk.session(fixture.userId, fixture.orgId);
    for (const [customConnectorId, connectionId] of [
      [httpConnector.id, httpConnectionId],
      [mcpConnector.id, mcpConnectionId],
    ] as const) {
      await accept(
        connectorAccountsClient().delete({
          headers: { authorization: "Bearer clerk-session" },
          params: { connectionId },
          body: {
            target: { kind: "custom", customConnectorId },
          },
        }),
        [200],
      );
    }
    const afterDisconnect = await accept(
      connectorSelectionsClient().get({
        headers: { authorization: `Bearer ${token}` },
        params: { id: created.body.id },
      }),
      [200],
    );
    expect(afterDisconnect.body.selections).toStrictEqual([]);
  });

  it("routes thread-list invalidations only to the user-org channel", async () => {
    const fixture = await seedAgent();
    const token = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:read", "chat-thread:write"],
    });

    await accept(
      threadsClient().create({
        headers: { authorization: `Bearer ${token}` },
        body: {
          agentId: fixture.agentId,
          model: WORKSPACE_DEFAULT_MODEL,
        },
      }),
      [201],
    );
    await flushWaitUntilForTest();
    expect(context.mocks.ably.channelGet.mock.calls).toStrictEqual([
      [`user-org:${fixture.userId}:${fixture.orgId}`],
    ]);
    expect(context.mocks.ably.publish).toHaveBeenCalledOnce();
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "threadListChanged",
      null,
    );
  });

  it("creates a titled thread with an Okou run token carrying chat-thread:write", async () => {
    const fixture = await seedAgent();
    const token = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:read", "chat-thread:write"],
    });

    const response = await accept(
      threadsClient().create({
        headers: { authorization: `Bearer ${token}` },
        body: {
          agentId: fixture.agentId,
          title: "Deep dive on P2",
          model: OTHER_WORKSPACE_MODEL,
          videoModel: EXPLICIT_VIDEO_MODEL,
          imageModel: EXPLICIT_IMAGE_MODEL,
        },
      }),
      [201],
    );
    expect(response.body).toStrictEqual({
      id: expect.any(String),
      title: "Deep dive on P2",
      createdAt: expect.any(String),
      selectedModel: OTHER_WORKSPACE_MODEL,
      serviceTier: null,
    });

    const metadataResponse = await accept(
      metadataClient().get({
        headers: { authorization: `Bearer ${token}` },
        params: { id: response.body.id },
      }),
      [200],
    );
    expect(metadataResponse.body).toStrictEqual({
      id: response.body.id,
      agentId: fixture.agentId,
      title: "Deep dive on P2",
      pinnedAt: null,
      selectedModel: OTHER_WORKSPACE_MODEL,
      modelSettings: {},
      serviceTier: null,
      computerUseHostId: null,
      cloudBrowserEnabled: false,
      selectedVideoModel: EXPLICIT_VIDEO_MODEL,
      selectedImageModel: EXPLICIT_IMAGE_MODEL,
    });
    await expect(
      readCreatedThreadEvent(response.body.id, token),
    ).resolves.toMatchObject({
      selectedVideoModel: EXPLICIT_VIDEO_MODEL,
      selectedImageModel: EXPLICIT_IMAGE_MODEL,
    });
  });

  it("inherits the model of the run that owns the token when model is omitted", async () => {
    const fixture = await seedAgent();
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId: fixture.agentId,
        triggerSource: "web",
        selectedModel: OTHER_WORKSPACE_MODEL,
      },
      context.signal,
    );
    const token = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:read", "chat-thread:write"],
      runId,
    });

    const response = await accept(
      threadsClient().create({
        headers: { authorization: `Bearer ${token}` },
        body: { agentId: fixture.agentId, title: "Inherited model" },
      }),
      [201],
    );
    expect(response.body.selectedModel).toBe(OTHER_WORKSPACE_MODEL);

    const metadataResponse = await accept(
      metadataClient().get({
        headers: { authorization: `Bearer ${token}` },
        params: { id: response.body.id },
      }),
      [200],
    );
    expect(metadataResponse.body.selectedModel).toBe(OTHER_WORKSPACE_MODEL);
    expect(metadataResponse.body.serviceTier).toBeNull();
  });

  it("inherits media models from the run's chat thread when omitted", async () => {
    const fixture = await seedAgent();
    const sourceToken = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:read", "chat-thread:write"],
    });
    const source = await accept(
      threadsClient().create({
        headers: { authorization: `Bearer ${sourceToken}` },
        body: {
          agentId: fixture.agentId,
          title: "Video model source",
          model: OTHER_WORKSPACE_MODEL,
          videoModel: INHERITED_VIDEO_MODEL,
          imageModel: INHERITED_IMAGE_MODEL,
        },
      }),
      [201],
    );
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId: fixture.agentId,
        triggerSource: "web",
        chatThreadId: source.body.id,
        selectedModel: OTHER_WORKSPACE_MODEL,
      },
      context.signal,
    );
    const inheritedToken = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:read", "chat-thread:write"],
      runId,
    });

    const inherited = await accept(
      threadsClient().create({
        headers: { authorization: `Bearer ${inheritedToken}` },
        body: {
          agentId: fixture.agentId,
          title: "Inherited media models",
        },
      }),
      [201],
    );

    await expect(
      readCreatedThreadEvent(inherited.body.id, inheritedToken),
    ).resolves.toMatchObject({
      selectedVideoModel: INHERITED_VIDEO_MODEL,
      selectedImageModel: INHERITED_IMAGE_MODEL,
    });
  });

  it("pins the member media defaults when the request omits them", async () => {
    const fixture = await seedAgent();
    await setMemberMediaDefaults(fixture);
    const token = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:read", "chat-thread:write"],
    });

    const response = await accept(
      threadsClient().create({
        headers: { authorization: `Bearer ${token}` },
        body: {
          agentId: fixture.agentId,
          title: "Member media defaults",
          model: OTHER_WORKSPACE_MODEL,
        },
      }),
      [201],
    );

    await expect(
      readCreatedThreadEvent(response.body.id, token),
    ).resolves.toMatchObject({
      selectedVideoModel: MEMBER_VIDEO_MODEL,
      selectedImageModel: MEMBER_IMAGE_MODEL,
    });
  });

  it.each([FeatureSwitchKey.CodexFastMode, FeatureSwitchKey.ModelPickerMenu])(
    "inherits priority from the run's chat thread and allows an explicit standard override with %s",
    async (fastSwitch) => {
      const fixture = await seedAgent();
      await updateFeatureSwitchesForUser(context, fixture, {
        [FeatureSwitchKey.CodexFastMode]: false,
        [fastSwitch]: true,
      });
      const sourceToken = okouToken({
        userId: fixture.userId,
        orgId: fixture.orgId,
        capabilities: ["chat-thread:read", "chat-thread:write"],
      });
      const source = await accept(
        threadsClient().create({
          headers: { authorization: `Bearer ${sourceToken}` },
          body: {
            agentId: fixture.agentId,
            title: "Priority source",
            model: PRIORITY_MODEL,
            serviceTier: "priority",
          },
        }),
        [201],
      );
      expect(source.body.serviceTier).toBe("priority");

      const { runId } = await store.set(
        seedRun$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          composeId: fixture.agentId,
          triggerSource: "web",
          chatThreadId: source.body.id,
          selectedModel: PRIORITY_MODEL,
        },
        context.signal,
      );
      const inheritedToken = okouToken({
        userId: fixture.userId,
        orgId: fixture.orgId,
        capabilities: ["chat-thread:read", "chat-thread:write"],
        runId,
      });

      const inherited = await accept(
        threadsClient().create({
          headers: { authorization: `Bearer ${inheritedToken}` },
          body: { agentId: fixture.agentId, title: "Inherited priority" },
        }),
        [201],
      );
      expect(inherited.body).toMatchObject({
        selectedModel: PRIORITY_MODEL,
        serviceTier: "priority",
      });
      const inheritedMetadata = await accept(
        metadataClient().get({
          headers: { authorization: `Bearer ${inheritedToken}` },
          params: { id: inherited.body.id },
        }),
        [200],
      );
      expect(inheritedMetadata.body.serviceTier).toBe("priority");

      const standard = await accept(
        threadsClient().create({
          headers: { authorization: `Bearer ${inheritedToken}` },
          body: {
            agentId: fixture.agentId,
            title: "Explicit standard",
            serviceTier: null,
          },
        }),
        [201],
      );
      expect(standard.body).toMatchObject({
        selectedModel: PRIORITY_MODEL,
        serviceTier: null,
      });
    },
  );

  it("rejects an omitted model when the token has no run model to inherit", async () => {
    const fixture = await seedAgent();
    const token = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:write"],
    });

    const response = await accept(
      threadsClient().create({
        headers: { authorization: `Bearer ${token}` },
        body: { agentId: fixture.agentId, title: "No model anywhere" },
      }),
      [400],
    );
    expect(response.body).toStrictEqual({
      error: {
        code: "BAD_REQUEST",
        message: "A model selection is required",
      },
    });
  });

  it("rejects an Okou run token without chat-thread:write", async () => {
    const fixture = await seedAgent();
    const token = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:read"],
    });

    const response = await accept(
      threadsClient().create({
        headers: { authorization: `Bearer ${token}` },
        body: {
          agentId: fixture.agentId,
          title: "Unauthorized thread",
          model: WORKSPACE_DEFAULT_MODEL,
        },
      }),
      [403],
    );
    expect(response.body).toStrictEqual({
      error: {
        code: "FORBIDDEN",
        message: "Missing required capability: chat-thread:write",
      },
    });
  });

  it("replays one thread when a create request is delivered twice", async () => {
    const fixture = await seedAgent();
    await updateFeatureSwitchesForUser(context, fixture, {});
    const connection = await connectorApi.connectManualGrant(
      fixture.actor,
      "openai",
      "api-token",
      { apiKey: "duplicate-delivery-openai-key" },
      fixture.agentId,
    );
    const token = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:read", "chat-thread:write"],
    });
    const clientThreadId = randomUUID();
    const eventId = randomUUID();

    const created = await accept(
      threadsClient().create({
        headers: { authorization: `Bearer ${token}` },
        body: {
          agentId: fixture.agentId,
          clientThreadId,
          eventId,
          title: "Duplicate delivery",
          model: OTHER_WORKSPACE_MODEL,
          connectorSelections: [
            {
              connectionId: connection.id,
              target: { kind: "builtin", connectorSlug: "openai" },
            },
          ],
        },
      }),
      [201],
    );
    expect(created.body.id).toBe(clientThreadId);

    // The same request, delivered a second time.
    const replayed = await accept(
      threadsClient().create({
        headers: { authorization: `Bearer ${token}` },
        body: {
          agentId: fixture.agentId,
          clientThreadId,
          eventId,
          title: "Duplicate delivery",
          model: OTHER_WORKSPACE_MODEL,
          connectorSelections: [
            {
              connectionId: connection.id,
              target: { kind: "builtin", connectorSlug: "openai" },
            },
          ],
        },
      }),
      [201],
    );
    expect(replayed.body).toStrictEqual(created.body);

    await expect(
      readCreatedThreadEvents(clientThreadId, token),
    ).resolves.toHaveLength(1);
    const selections = await accept(
      connectorSelectionsClient().get({
        headers: { authorization: `Bearer ${token}` },
        params: { id: clientThreadId },
      }),
      [200],
    );
    expect(selections.body.selections).toStrictEqual([
      {
        connectionId: connection.id,
        target: { kind: "builtin", connectorSlug: "openai" },
      },
    ]);
  });

  it("replays the stored thread instead of the repeated request body", async () => {
    const fixture = await seedAgent();
    const token = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:read", "chat-thread:write"],
    });
    const clientThreadId = randomUUID();

    const created = await accept(
      threadsClient().create({
        headers: { authorization: `Bearer ${token}` },
        body: {
          agentId: fixture.agentId,
          clientThreadId,
          title: "Title from the request",
          model: OTHER_WORKSPACE_MODEL,
        },
      }),
      [201],
    );
    await accept(
      renameClient().rename({
        headers: { authorization: `Bearer ${token}` },
        params: { id: clientThreadId },
        body: { title: "Title the member chose" },
      }),
      [204],
    );

    const replayed = await accept(
      threadsClient().create({
        headers: { authorization: `Bearer ${token}` },
        body: {
          agentId: fixture.agentId,
          clientThreadId,
          title: "Title from the request",
          model: OTHER_WORKSPACE_MODEL,
        },
      }),
      [201],
    );
    expect(replayed.body).toStrictEqual({
      id: clientThreadId,
      title: "Title the member chose",
      createdAt: created.body.createdAt,
      selectedModel: OTHER_WORKSPACE_MODEL,
      serviceTier: null,
    });

    const metadataResponse = await accept(
      metadataClient().get({
        headers: { authorization: `Bearer ${token}` },
        params: { id: clientThreadId },
      }),
      [200],
    );
    expect(metadataResponse.body.title).toBe("Title the member chose");
  });

  it("creates one thread when two deliveries race on a client thread id", async () => {
    const fixture = await seedAgent();
    const token = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:read", "chat-thread:write"],
    });
    const clientThreadId = randomUUID();
    const eventId = randomUUID();

    const [first, second] = await Promise.all([
      accept(
        threadsClient().create({
          headers: { authorization: `Bearer ${token}` },
          body: {
            agentId: fixture.agentId,
            clientThreadId,
            eventId,
            title: "Raced delivery",
            model: OTHER_WORKSPACE_MODEL,
          },
        }),
        [201],
      ),
      accept(
        threadsClient().create({
          headers: { authorization: `Bearer ${token}` },
          body: {
            agentId: fixture.agentId,
            clientThreadId,
            eventId,
            title: "Raced delivery",
            model: OTHER_WORKSPACE_MODEL,
          },
        }),
        [201],
      ),
    ]);
    expect(second.body).toStrictEqual(first.body);
    expect(first.body.id).toBe(clientThreadId);

    await expect(
      readCreatedThreadEvents(clientThreadId, token),
    ).resolves.toHaveLength(1);
  });

  it("answers a client thread id owned by another member like a missing thread", async () => {
    const owner = await seedAgent();
    const ownerToken = okouToken({
      userId: owner.userId,
      orgId: owner.orgId,
      capabilities: ["chat-thread:read", "chat-thread:write"],
    });
    const clientThreadId = randomUUID();
    await accept(
      threadsClient().create({
        headers: { authorization: `Bearer ${ownerToken}` },
        body: {
          agentId: owner.agentId,
          clientThreadId,
          title: "Owner thread",
          model: WORKSPACE_DEFAULT_MODEL,
        },
      }),
      [201],
    );

    const other = await seedAgent();
    const otherToken = okouToken({
      userId: other.userId,
      orgId: other.orgId,
      capabilities: ["chat-thread:read", "chat-thread:write"],
    });
    const collision = await accept(
      threadsClient().create({
        headers: { authorization: `Bearer ${otherToken}` },
        body: {
          agentId: other.agentId,
          clientThreadId,
          title: "Colliding thread",
          model: WORKSPACE_DEFAULT_MODEL,
        },
      }),
      [404],
    );
    expect(collision.body).toStrictEqual({
      error: { code: "NOT_FOUND", message: "Chat thread not found" },
    });

    const metadataResponse = await accept(
      metadataClient().get({
        headers: { authorization: `Bearer ${ownerToken}` },
        params: { id: clientThreadId },
      }),
      [200],
    );
    expect(metadataResponse.body).toMatchObject({
      agentId: owner.agentId,
      title: "Owner thread",
    });
  });

  it("answers a client thread id held by another agent like a missing thread", async () => {
    const fixture = await seedAgent();
    const token = okouToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:read", "chat-thread:write"],
    });
    const clientThreadId = randomUUID();
    await accept(
      threadsClient().create({
        headers: { authorization: `Bearer ${token}` },
        body: {
          agentId: fixture.agentId,
          clientThreadId,
          title: "First agent thread",
          model: WORKSPACE_DEFAULT_MODEL,
        },
      }),
      [201],
    );

    bdd.acceptAgentStorageWrites();
    const otherAgent = await bdd.createAgent(fixture.actor, {
      displayName: "Second chat thread agent",
      visibility: "private",
    });
    const collision = await accept(
      threadsClient().create({
        headers: { authorization: `Bearer ${token}` },
        body: {
          agentId: otherAgent.agentId,
          clientThreadId,
          title: "Colliding agent thread",
          model: WORKSPACE_DEFAULT_MODEL,
        },
      }),
      [404],
    );
    expect(collision.body).toStrictEqual({
      error: { code: "NOT_FOUND", message: "Chat thread not found" },
    });

    const metadataResponse = await accept(
      metadataClient().get({
        headers: { authorization: `Bearer ${token}` },
        params: { id: clientThreadId },
      }),
      [200],
    );
    expect(metadataResponse.body).toMatchObject({
      agentId: fixture.agentId,
      title: "First agent thread",
    });
  });
});
