import { randomUUID } from "node:crypto";
import { chatConnectorAccessContract } from "@okouai/api-contracts/contracts/chat-connector-access";
import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import {
  chatThreadConnectorSelectionContract,
  chatThreadMetadataContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { builtinConnectorManualGrantContract } from "@okouai/api-contracts/contracts/connectors";
import {
  customConnectorValuesContract,
  customConnectorsContract,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";
import { vncConnectionsContract } from "@okouai/api-contracts/contracts/vnc-connections";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatConnectorAccessRoutes } from "../chat-connector-access";
import { chatRemoteAccessRoutes } from "../chat-remote-access";
import { chatThreadRoutes } from "../chat-threads";
import { chatThreadConnectorSelectionRoutes } from "../chat-threads-connector-selections";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { chatThreadGetRoutes } from "../chat-threads-get";
import { connectorAccountRoutes } from "../connector-accounts";
import { builtinConnectorsRoutes } from "../connectors";
import { customConnectorsRoutes } from "../custom-connectors";
import { customConnectorsValuesSetRoutes } from "../custom-connectors-values-set";
import { sshConnectionsRoutes } from "../ssh-connections";
import { userPreferencesRoutes } from "../user-preferences";
import { vncConnectionsRoutes } from "../vnc-connections";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { channelsPublishedTo } from "./helpers/realtime-publications";
import { createRouteMocks } from "./helpers/route-test";
import { createRunExecutionCredentials } from "./helpers/run-execution-credentials";
import { inlineSshKey } from "./helpers/ssh-credential";
import { vncConnectionBody } from "./helpers/vnc-runtime";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const openaiTarget = Object.freeze({
  kind: "builtin" as const,
  connectorSlug: "openai" as const,
});
const chatThreadEventsRoutes = Object.freeze(
  chatThreadRoutes.filter(({ route }) => {
    return route === chatThreadsContract.events;
  }),
);
const runCredentials = createRunExecutionCredentials(context, {
  plan: "limited-free",
});

const app = setupApp({
  context,
  routes: [
    ...chatThreadCreateRoutes,
    ...chatRemoteAccessRoutes,
    ...sshConnectionsRoutes,
    ...vncConnectionsRoutes,
    ...builtinConnectorsRoutes,
    ...customConnectorsRoutes,
    ...customConnectorsValuesSetRoutes,
    ...chatThreadConnectorSelectionRoutes,
    ...chatConnectorAccessRoutes,
  ],
});
const threadsApi = app(chatThreadsContract);
const remoteAccessApi = app(chatRemoteAccessContract);
const sshApi = app(sshConnectionsContract);
const vncApi = app(vncConnectionsContract);
const builtinConnectApi = app(builtinConnectorManualGrantContract);
const customConnectorsApi = app(customConnectorsContract);
const customValuesApi = app(customConnectorValuesContract);
const selectionsApi = app(chatThreadConnectorSelectionContract);
const connectorAccessApi = app(chatConnectorAccessContract);

const runThreadsApi = setupApp({
  context,
  routes: chatThreadCreateRoutes,
})(chatThreadsContract);
const threadEventsApi = setupApp({
  context,
  routes: chatThreadEventsRoutes,
})(chatThreadsContract);
const metadataApi = setupApp({
  context,
  routes: chatThreadGetRoutes,
})(chatThreadMetadataContract);
const runSelectionsApi = setupApp({
  context,
  routes: chatThreadConnectorSelectionRoutes,
})(chatThreadConnectorSelectionContract);
const runBuiltinConnectApi = setupApp({
  context,
  routes: builtinConnectorsRoutes,
})(builtinConnectorManualGrantContract);
const connectorAccountsApi = setupApp({
  context,
  routes: connectorAccountRoutes,
})(connectorAccountsContract);
const userPreferencesApi = setupApp({
  context,
  routes: userPreferencesRoutes,
})(userPreferencesContract);

function signIn(userId: string, orgId: string) {
  createRouteMocks(context).clerk.session(userId, orgId, "org:admin");
  return headers;
}

function bearerHeaders(token: string) {
  return { authorization: `Bearer ${token}` };
}

function requireOrgId(actor: ApiTestUser): string {
  if (!actor.orgId) {
    throw new Error("Expected an organization member");
  }
  return actor.orgId;
}

async function connectOpenAiAccount(
  authHeaders: { readonly authorization: string },
  displayName: string,
) {
  const connected = await accept(
    runBuiltinConnectApi.connect({
      headers: authHeaders,
      params: { connectorSlug: "openai" },
      body: {
        authMethod: "api-token",
        values: { apiKey: `sk-test-${randomUUID()}` },
        account: { intent: "add", displayName },
      },
    }),
    [200],
  );
  return connected.body.connectionId;
}

async function createdEventsFor(
  authHeaders: { readonly authorization: string },
  threadId: string,
) {
  const response = await accept(
    threadEventsApi.events({ headers: authHeaders, query: {} }),
    [200],
  );
  return response.body.events.filter((event) => {
    return event.chatThreadId === threadId && event.kind === "created";
  });
}

async function setupRemoteAccessChat() {
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  await createStore().set(
    seedOrgMembership$,
    { userId, orgId, role: "admin" },
    context.signal,
  );
  const authHeaders = signIn(userId, orgId);
  const sshId = randomUUID();
  const [ssh, vnc] = await Promise.all([
    accept(
      sshApi.create({
        headers: authHeaders,
        body: {
          id: sshId,
          displayName: "Selected host",
          host: `host-${sshId.slice(0, 8)}.example.test`,
          credential: inlineSshKey("deploy", `key-${randomUUID()}`),
        },
      }),
      [201],
    ),
    accept(
      vncApi.create({
        headers: authHeaders,
        body: vncConnectionBody(),
      }),
      [201],
    ),
  ]);
  await accept(
    remoteAccessApi.updateHostDefault({
      headers: authHeaders,
      params: { protocol: "ssh", connectionId: ssh.body.id },
      body: { enabled: true },
    }),
    [200],
  );
  const clientThreadId = randomUUID();
  const created = await accept(
    threadsApi.create({
      headers: authHeaders,
      body: {
        clientThreadId,
        model: null,
        initialRemoteAccessOverrides: [
          { protocol: "ssh", connectionId: ssh.body.id, enabled: false },
          { protocol: "vnc", connectionId: vnc.body.id, enabled: true },
        ],
      },
    }),
    [201],
  );
  return {
    authHeaders,
    sshId: ssh.body.id,
    sshGeneration: ssh.body.generation,
    vncId: vnc.body.id,
    clientThreadId,
    threadId: created.body.id,
  };
}

async function setupConnectorSelectionChat() {
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  const authHeaders = signIn(userId, orgId);

  const openai = await accept(
    builtinConnectApi.connect({
      headers: authHeaders,
      params: { connectorSlug: "openai" },
      body: {
        authMethod: "api-token",
        values: { apiKey: `sk-test-${randomUUID()}` },
        account: { intent: "add", displayName: "OpenAI work" },
      },
    }),
    [200],
  );
  const customConnector = await accept(
    customConnectorsApi.create({
      headers: authHeaders,
      body: {
        displayName: "Custom HTTP",
        prefixTemplates: [`https://${randomUUID()}.example.test/api`],
        authMode: "none",
        fields: [],
        headerInjections: [],
        queryInjections: [],
      },
    }),
    [201],
  );
  const customAccount = await accept(
    customValuesApi.set({
      headers: authHeaders,
      params: { id: customConnector.body.id },
      body: {
        values: [],
        account: { intent: "add", displayName: "Custom account" },
      },
    }),
    [200],
  );
  const thread = await accept(
    threadsApi.create({
      headers: authHeaders,
      body: { model: null },
    }),
    [201],
  );
  const threadId = thread.body.id;

  const targets = [
    {
      target: { kind: "builtin" as const, connectorSlug: "openai" },
      connectionId: openai.body.connectionId,
    },
    {
      target: {
        kind: "custom" as const,
        customConnectorId: customConnector.body.id,
      },
      connectionId: customAccount.body.connectionId,
    },
  ];
  for (const selection of targets) {
    await accept(
      selectionsApi.update({
        headers: authHeaders,
        params: { id: threadId },
        body: selection,
      }),
      [200],
    );
  }
  const initial = await accept(
    selectionsApi.get({
      headers: authHeaders,
      params: { id: threadId },
    }),
    [200],
  );
  return { authHeaders, threadId, targets, initial: initial.body };
}

describe("POST /api/chat-threads", () => {
  it("chat-threads-create-003 (1/2) creates initial SSH and VNC overrides, preserves them on inverted replay, and rejects unknown hosts", async () => {
    const { authHeaders, sshId, vncId, clientThreadId, threadId } =
      await setupRemoteAccessChat();

    const access = await accept(
      remoteAccessApi.listThreadAccess({
        headers: authHeaders,
        params: { threadId },
      }),
      [200],
    );
    expect(access.body.ssh).toContainEqual(
      expect.objectContaining({
        connectionId: sshId,
        enabled: false,
        overrideEnabled: false,
        source: "override",
      }),
    );
    expect(access.body.vnc).toContainEqual(
      expect.objectContaining({
        connectionId: vncId,
        enabled: true,
        overrideEnabled: true,
        source: "override",
      }),
    );

    const replayedInverted = await accept(
      threadsApi.create({
        headers: authHeaders,
        body: {
          clientThreadId,
          model: null,
          initialRemoteAccessOverrides: [
            { protocol: "ssh", connectionId: sshId, enabled: true },
            { protocol: "vnc", connectionId: vncId, enabled: false },
          ],
        },
      }),
      [201],
    );
    expect(replayedInverted.body.id).toBe(threadId);
    const afterInverted = await accept(
      remoteAccessApi.listThreadAccess({
        headers: authHeaders,
        params: { threadId },
      }),
      [200],
    );
    expect(afterInverted.body).toStrictEqual(access.body);

    const unknownChatId = randomUUID();
    await accept(
      threadsApi.create({
        headers: authHeaders,
        body: {
          clientThreadId: unknownChatId,
          model: null,
          initialRemoteAccessOverrides: [
            { protocol: "ssh", connectionId: randomUUID(), enabled: true },
          ],
        },
      }),
      [400],
    );
    await accept(
      remoteAccessApi.listThreadAccess({
        headers: authHeaders,
        params: { threadId: unknownChatId },
      }),
      [404],
    );
  });

  it("chat-threads-create-003 (2/2) replays the created chat after deleting the overridden SSH host", async () => {
    const {
      authHeaders,
      sshId,
      sshGeneration,
      vncId,
      clientThreadId,
      threadId,
    } = await setupRemoteAccessChat();

    await accept(
      sshApi.delete({
        headers: authHeaders,
        params: { connectionId: sshId },
        body: { expectedGeneration: sshGeneration },
      }),
      [204],
    );

    const replayedAfterDelete = await accept(
      threadsApi.create({
        headers: authHeaders,
        body: {
          clientThreadId,
          model: null,
          initialRemoteAccessOverrides: [
            { protocol: "ssh", connectionId: sshId, enabled: false },
            { protocol: "vnc", connectionId: vncId, enabled: true },
          ],
        },
      }),
      [201],
    );
    expect(replayedAfterDelete.body.id).toBe(threadId);
  });

  it("chat-threads-create-006 (1/2) stores builtin and custom selections and rejects them while disallowed in the Chat", async () => {
    const { authHeaders, threadId, targets, initial } =
      await setupConnectorSelectionChat();
    expect(initial.selections).toHaveLength(2);

    for (const selection of targets) {
      await accept(
        connectorAccessApi.setThreadOverride({
          headers: authHeaders,
          params: { threadId, connectionId: selection.connectionId },
          body: { target: selection.target, enabled: false },
        }),
        [200],
      );
      const rejected = await accept(
        selectionsApi.update({
          headers: authHeaders,
          params: { id: threadId },
          body: selection,
        }),
        [400],
      );
      expect(rejected.body).toStrictEqual({
        error: {
          code: "BAD_REQUEST",
          message: "Account is unavailable or not allowed in this Chat",
        },
      });
    }

    const disallowed = await accept(
      selectionsApi.get({
        headers: authHeaders,
        params: { id: threadId },
      }),
      [200],
    );
    expect(disallowed.body.selections).toStrictEqual([]);
  });

  it("chat-threads-create-006 (2/2) restores builtin and custom selections after re-allowing them in the Chat", async () => {
    const { authHeaders, threadId, targets, initial } =
      await setupConnectorSelectionChat();

    for (const selection of targets) {
      await accept(
        connectorAccessApi.setThreadOverride({
          headers: authHeaders,
          params: { threadId, connectionId: selection.connectionId },
          body: { target: selection.target, enabled: false },
        }),
        [200],
      );
      await accept(
        connectorAccessApi.setThreadOverride({
          headers: authHeaders,
          params: { threadId, connectionId: selection.connectionId },
          body: { target: selection.target, enabled: true },
        }),
        [200],
      );
      const restored = await accept(
        selectionsApi.update({
          headers: authHeaders,
          params: { id: threadId },
          body: selection,
        }),
        [200],
      );
      expect(restored.body).toStrictEqual(selection);
    }

    const final = await accept(
      selectionsApi.get({
        headers: authHeaders,
        params: { id: threadId },
      }),
      [200],
    );
    expect(final.body).toStrictEqual(initial);
  });

  it(
    "chat-threads-create-020 answers a client thread id owned by another member like a missing thread",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const bdd = createBddApi(context);
      const owner = bdd.user();
      const otherWorkspaceMember = bdd.user();
      const ownerTokenHeaders = bearerHeaders(
        await runCredentials.okouToken(owner),
      );
      const otherTokenHeaders = bearerHeaders(
        await runCredentials.okouToken(otherWorkspaceMember),
      );

      const clientThreadId = randomUUID();
      await accept(
        runThreadsApi.create({
          headers: ownerTokenHeaders,
          body: {
            clientThreadId,
            title: "Owner thread",
            model: null,
          },
        }),
        [201],
      );

      const colliding = await accept(
        runThreadsApi.create({
          headers: otherTokenHeaders,
          body: {
            clientThreadId,
            title: "Colliding thread",
            model: null,
          },
        }),
        [404],
      );
      expect(colliding.body).toStrictEqual({
        error: {
          code: "NOT_FOUND",
          message: "Chat thread not found",
        },
      });

      const ownerMetadata = await accept(
        metadataApi.get({
          headers: ownerTokenHeaders,
          params: { id: clientThreadId },
        }),
        [200],
      );
      expect(ownerMetadata.body.title).toBe("Owner thread");
    },
  );

  it(
    "chat-threads-create-001 snapshots the member's cloud browser preference (true) and preserves it on replay",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const actor = createBddApi(context).user();
      const orgId = requireOrgId(actor);
      const tokenHeaders = bearerHeaders(await runCredentials.okouToken(actor));
      await createRunsApi(context).ensurePersonalSubscriptionModel(actor, {
        model: "claude-sonnet-5-5",
      });
      await accept(
        userPreferencesApi.update({
          headers: signIn(actor.userId, orgId),
          body: { cloudBrowserEnabledByDefault: true },
        }),
        [200],
      );

      const firstClientThreadId = randomUUID();
      const firstCreated = await accept(
        runThreadsApi.create({
          headers: tokenHeaders,
          body: { clientThreadId: firstClientThreadId },
        }),
        [201],
      );
      const firstEvents = await createdEventsFor(
        tokenHeaders,
        firstCreated.body.id,
      );
      expect(firstEvents).toHaveLength(1);
      expect(firstEvents).toMatchObject([{ cloudBrowserEnabled: true }]);

      await accept(
        userPreferencesApi.update({
          headers: signIn(actor.userId, orgId),
          body: { cloudBrowserEnabledByDefault: false },
        }),
        [200],
      );

      const replayed = await accept(
        runThreadsApi.create({
          headers: tokenHeaders,
          body: { clientThreadId: firstClientThreadId },
        }),
        [201],
      );
      expect(replayed.body.id).toBe(firstCreated.body.id);
      const [firstMetadata, replayedEvents] = await Promise.all([
        accept(
          metadataApi.get({
            headers: tokenHeaders,
            params: { id: firstCreated.body.id },
          }),
          [200],
        ),
        createdEventsFor(tokenHeaders, firstCreated.body.id),
      ]);
      expect(firstMetadata.body).toMatchObject({ cloudBrowserEnabled: true });
      expect(replayedEvents).toHaveLength(1);

      const secondClientThreadId = randomUUID();
      const secondCreated = await accept(
        runThreadsApi.create({
          headers: tokenHeaders,
          body: { clientThreadId: secondClientThreadId },
        }),
        [201],
      );
      const [secondMetadata, secondEvents] = await Promise.all([
        accept(
          metadataApi.get({
            headers: tokenHeaders,
            params: { id: secondCreated.body.id },
          }),
          [200],
        ),
        createdEventsFor(tokenHeaders, secondCreated.body.id),
      ]);
      expect(secondMetadata.body).toMatchObject({ cloudBrowserEnabled: false });
      expect(secondEvents).toHaveLength(1);
      expect(secondEvents).toMatchObject([{ cloudBrowserEnabled: false }]);
    },
  );

  it(
    "chat-threads-create-004 does not let a run token choose access to a host when creating a chat",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const actor = createBddApi(context).user();
      const orgId = requireOrgId(actor);
      const tokenHeaders = bearerHeaders(await runCredentials.okouToken(actor));
      await createStore().set(
        seedOrgMembership$,
        { userId: actor.userId, orgId, role: "admin" },
        context.signal,
      );
      const authHeaders = signIn(actor.userId, orgId);
      const sshId = randomUUID();
      const ssh = await accept(
        sshApi.create({
          headers: authHeaders,
          body: {
            id: sshId,
            displayName: "Disabled host",
            host: `host-${sshId.slice(0, 8)}.example.test`,
            credential: inlineSshKey("deploy", `key-${randomUUID()}`),
          },
        }),
        [201],
      );
      await accept(
        remoteAccessApi.updateHostDefault({
          headers: authHeaders,
          params: { protocol: "ssh", connectionId: ssh.body.id },
          body: { enabled: false },
        }),
        [200],
      );

      const clientThreadId = randomUUID();
      const rejected = await accept(
        runThreadsApi.create({
          headers: tokenHeaders,
          body: {
            clientThreadId,
            model: null,
            initialRemoteAccessOverrides: [
              { protocol: "ssh", connectionId: ssh.body.id, enabled: true },
            ],
          },
        }),
        [403],
      );
      expect(rejected.body.error.code).toBe("FORBIDDEN");

      await accept(
        remoteAccessApi.listThreadAccess({
          headers: signIn(actor.userId, orgId),
          params: { threadId: clientThreadId },
        }),
        [404],
      );
    },
  );

  it(
    "chat-threads-create-005 repairs selected and inherited accounts during deletion",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const actor = createBddApi(context).user();
      const orgId = requireOrgId(actor);
      const tokenHeaders = bearerHeaders(await runCredentials.okouToken(actor));
      const [firstId, unselectedChat, selectedChat] = await Promise.all([
        connectOpenAiAccount(signIn(actor.userId, orgId), "First"),
        accept(
          runThreadsApi.create({
            headers: tokenHeaders,
            body: { model: null },
          }),
          [201],
        ),
        accept(
          runThreadsApi.create({
            headers: tokenHeaders,
            body: { model: null },
          }),
          [201],
        ),
      ]);
      const secondId = await connectOpenAiAccount(
        signIn(actor.userId, orgId),
        "Second",
      );
      await accept(
        runSelectionsApi.update({
          headers: tokenHeaders,
          params: { id: selectedChat.body.id },
          body: { target: openaiTarget, connectionId: secondId },
        }),
        [200],
      );

      const impact = await accept(
        connectorAccountsApi.deletionImpact({
          headers: signIn(actor.userId, orgId),
          params: { connectionId: secondId },
          query: openaiTarget,
        }),
        [200],
      );
      expect(impact.body).toStrictEqual({
        connectionId: secondId,
        explicitSelectionCount: 1,
        hasSibling: true,
      });

      const deletedSecond = await accept(
        connectorAccountsApi.delete({
          headers: signIn(actor.userId, orgId),
          params: { connectionId: secondId },
          body: { target: openaiTarget },
        }),
        [200],
      );
      expect(deletedSecond.body).toStrictEqual({
        deletedConnectionId: secondId,
        resolvedSelectionCount: 1,
        promotedDefaultConnectionId: null,
      });

      const [repairedSelected, stillUnselected] = await Promise.all([
        accept(
          runSelectionsApi.get({
            headers: tokenHeaders,
            params: { id: selectedChat.body.id },
          }),
          [200],
        ),
        accept(
          runSelectionsApi.get({
            headers: tokenHeaders,
            params: { id: unselectedChat.body.id },
          }),
          [200],
        ),
      ]);
      expect(repairedSelected.body.selections).toStrictEqual([
        { target: openaiTarget, connectionId: firstId },
      ]);
      expect(repairedSelected.body.selectedConnections).toMatchObject([
        { id: firstId },
      ]);
      expect(stillUnselected.body).toStrictEqual({
        selections: [],
        selectedConnections: [],
      });

      const deletedFirst = await accept(
        connectorAccountsApi.delete({
          headers: signIn(actor.userId, orgId),
          params: { connectionId: firstId },
          body: { target: openaiTarget },
        }),
        [200],
      );
      expect(deletedFirst.body).toStrictEqual({
        deletedConnectionId: firstId,
        resolvedSelectionCount: 1,
        promotedDefaultConnectionId: null,
      });

      const [clearedSelected, replayed] = await Promise.all([
        accept(
          runSelectionsApi.get({
            headers: tokenHeaders,
            params: { id: selectedChat.body.id },
          }),
          [200],
        ),
        accept(
          runThreadsApi.create({
            headers: tokenHeaders,
            body: { clientThreadId: selectedChat.body.id, model: null },
          }),
          [201],
        ),
      ]);
      expect(clearedSelected.body).toStrictEqual({
        selections: [],
        selectedConnections: [],
      });
      expect(replayed.body).toStrictEqual(selectedChat.body);
      await expect(
        createdEventsFor(tokenHeaders, selectedChat.body.id),
      ).resolves.toHaveLength(1);
    },
  );

  it(
    "chat-threads-create-007 (1/4) selects an owned built-in account, rejects foreign or mismatched targets, and publishes detail changes on reselect",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const bdd = createBddApi(context);
      const member = bdd.user();
      const orgId = requireOrgId(member);
      const otherMember = bdd.user({ orgId });
      const tokenHeaders = bearerHeaders(
        await runCredentials.okouToken(member),
      );
      const memberConnectionId = await connectOpenAiAccount(
        signIn(member.userId, orgId),
        "Member OpenAI",
      );
      const otherConnectionId = await connectOpenAiAccount(
        signIn(otherMember.userId, orgId),
        "Other OpenAI",
      );

      const created = await accept(
        runThreadsApi.create({ headers: tokenHeaders, body: { model: null } }),
        [201],
      );
      const threadId = created.body.id;

      await accept(
        runSelectionsApi.update({
          headers: tokenHeaders,
          params: { id: threadId },
          body: { target: openaiTarget, connectionId: memberConnectionId },
        }),
        [200],
      );
      const readBack = await accept(
        runSelectionsApi.get({
          headers: tokenHeaders,
          params: { id: threadId },
        }),
        [200],
      );
      expect(readBack.body.selections).toStrictEqual([
        { target: openaiTarget, connectionId: memberConnectionId },
      ]);
      expect(readBack.body.selectedConnections).toMatchObject([
        { id: memberConnectionId, connectionStatus: "connected" },
      ]);

      await accept(
        runSelectionsApi.update({
          headers: tokenHeaders,
          params: { id: threadId },
          body: { target: openaiTarget, connectionId: otherConnectionId },
        }),
        [400],
      );

      await flushWaitUntilForTest();
      context.mocks.ably.channelGet.mockClear();
      context.mocks.ably.publish.mockClear();
      const reselected = await accept(
        runSelectionsApi.update({
          headers: tokenHeaders,
          params: { id: threadId },
          body: { target: openaiTarget, connectionId: memberConnectionId },
        }),
        [200],
      );
      expect(reselected.body).toStrictEqual({
        target: openaiTarget,
        connectionId: memberConnectionId,
      });
      await flushWaitUntilForTest();
      expect(
        channelsPublishedTo(
          context.mocks,
          `chatThreadDetailChanged:${threadId}`,
        ),
      ).toStrictEqual([`user:${member.userId}`]);

      await accept(
        runSelectionsApi.update({
          headers: tokenHeaders,
          params: { id: threadId },
          body: {
            target: { kind: "builtin", connectorSlug: "github" },
            connectionId: memberConnectionId,
          },
        }),
        [400],
      );
    },
  );

  it(
    "chat-threads-create-007 (2/4) leaves no selection when reselecting an account concurrently with deletion",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const member = createBddApi(context).user();
      const orgId = requireOrgId(member);
      const tokenHeaders = bearerHeaders(
        await runCredentials.okouToken(member),
      );
      const [memberConnectionId, created] = await Promise.all([
        connectOpenAiAccount(signIn(member.userId, orgId), "Member OpenAI"),
        accept(
          runThreadsApi.create({
            headers: tokenHeaders,
            body: { model: null },
          }),
          [201],
        ),
      ]);
      const threadId = created.body.id;

      await accept(
        runSelectionsApi.update({
          headers: tokenHeaders,
          params: { id: threadId },
          body: { target: openaiTarget, connectionId: memberConnectionId },
        }),
        [200],
      );

      const memberSessionHeaders = signIn(member.userId, orgId);
      const [racedSelect, racedDelete] = await Promise.all([
        accept(
          runSelectionsApi.update({
            headers: tokenHeaders,
            params: { id: threadId },
            body: { target: openaiTarget, connectionId: memberConnectionId },
          }),
          [200, 400],
        ),
        accept(
          connectorAccountsApi.delete({
            headers: memberSessionHeaders,
            params: { connectionId: memberConnectionId },
            body: { target: openaiTarget },
          }),
          [200],
        ),
      ]);
      expect([200, 400]).toContain(racedSelect.status);
      expect(racedDelete.body.deletedConnectionId).toBe(memberConnectionId);

      const afterRace = await accept(
        runSelectionsApi.get({
          headers: tokenHeaders,
          params: { id: threadId },
        }),
        [200],
      );
      expect(afterRace.body).toStrictEqual({
        selections: [],
        selectedConnections: [],
      });
    },
  );

  it(
    "chat-threads-create-007 (3/4) hides thread connector selections from another organization member's run token",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const bdd = createBddApi(context);
      const runs = createRunsApi(context);
      const member = bdd.user();
      const orgId = requireOrgId(member);
      const otherMember = bdd.user({ orgId });
      bdd.acceptStorageWrites();
      runs.acceptStorageDownloads();
      runs.acceptTelemetryIngest();
      await runs.grantProEntitlement(member);

      const memberTokenHeaders = bearerHeaders(
        await runCredentials.okouToken(member),
      );
      const otherTokenHeaders = bearerHeaders(
        await runCredentials.okouToken(otherMember),
      );
      const [connectionId, created] = await Promise.all([
        connectOpenAiAccount(signIn(member.userId, orgId), "Member OpenAI"),
        accept(
          runThreadsApi.create({
            headers: memberTokenHeaders,
            body: { model: null },
          }),
          [201],
        ),
      ]);
      await accept(
        runSelectionsApi.update({
          headers: memberTokenHeaders,
          params: { id: created.body.id },
          body: { target: openaiTarget, connectionId },
        }),
        [200],
      );

      const foreignRead = await accept(
        runSelectionsApi.get({
          headers: otherTokenHeaders,
          params: { id: created.body.id },
        }),
        [404],
      );
      expect(foreignRead.body.error.code).toBe("NOT_FOUND");
    },
  );

  it(
    "chat-threads-create-007 (4/4) hides thread connector selections from the member's run token in another organization",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const bdd = createBddApi(context);
      const member = bdd.user();
      const orgId = requireOrgId(member);
      const secondOrgMember = bdd.user({ userId: member.userId });
      const memberTokenHeaders = bearerHeaders(
        await runCredentials.okouToken(member),
      );
      const secondOrgTokenHeaders = bearerHeaders(
        await runCredentials.okouToken(secondOrgMember),
      );
      const [connectionId, created] = await Promise.all([
        connectOpenAiAccount(signIn(member.userId, orgId), "Member OpenAI"),
        accept(
          runThreadsApi.create({
            headers: memberTokenHeaders,
            body: { model: null },
          }),
          [201],
        ),
      ]);
      await accept(
        runSelectionsApi.update({
          headers: memberTokenHeaders,
          params: { id: created.body.id },
          body: { target: openaiTarget, connectionId },
        }),
        [200],
      );

      const foreignRead = await accept(
        runSelectionsApi.get({
          headers: secondOrgTokenHeaders,
          params: { id: created.body.id },
        }),
        [404],
      );
      expect(foreignRead.body.error.code).toBe("NOT_FOUND");
    },
  );

  it(
    "chat-threads-create-013 creates a titled thread with an Okou run token carrying chat-thread:write",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const actor = createBddApi(context).user();
      const tokenHeaders = bearerHeaders(await runCredentials.okouToken(actor));
      await createRunsApi(context).ensurePersonalSubscriptionModel(actor, {
        model: "claude-sonnet-5-5",
      });

      const created = await accept(
        runThreadsApi.create({
          headers: tokenHeaders,
          body: {
            title: "Deep dive on P2",
            model: "claude-opus-5-5",
          },
        }),
        [201],
      );
      expect(created.body).toStrictEqual({
        id: expect.any(String),
        title: "Deep dive on P2",
        createdAt: expect.any(String),
        selectedModel: "claude-opus-5-5",
        serviceTier: null,
      });

      const metadata = await accept(
        metadataApi.get({
          headers: tokenHeaders,
          params: { id: created.body.id },
        }),
        [200],
      );
      expect(metadata.body).toStrictEqual({
        id: created.body.id,
        title: "Deep dive on P2",
        selectedModel: "claude-opus-5-5",
        modelSettings: {},
        serviceTier: null,
        pinnedAt: null,
        archived: false,
        hidden: false,
        muted: false,
        computerUseHostId: null,
        cloudBrowserEnabled: true,
      });
    },
  );

  it(
    "chat-threads-create-016 uses the workspace default when the request omits a model",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const actor = createBddApi(context).user();
      const tokenHeaders = bearerHeaders(await runCredentials.okouToken(actor));
      await createRunsApi(context).ensurePersonalSubscriptionModel(actor, {
        model: "claude-sonnet-5-5",
      });

      const created = await accept(
        runThreadsApi.create({
          headers: tokenHeaders,
          body: { title: "No model anywhere" },
        }),
        [201],
      );
      expect(created.body.title).toBe("No model anywhere");
      expect(created.body.selectedModel).toBe("claude-sonnet-5-5");
      expect(created.body.serviceTier).toBeNull();
    },
  );

  it(
    "chat-threads-create-017 replays one thread when a create request is delivered twice",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const actor = createBddApi(context).user();
      const tokenHeaders = bearerHeaders(await runCredentials.okouToken(actor));
      await createRunsApi(context).ensurePersonalSubscriptionModel(actor);

      const clientThreadId = randomUUID();
      const eventId = randomUUID();
      const requestBody = {
        clientThreadId,
        eventId,
        title: "Duplicate delivery",
        model: "claude-opus-5-5",
      };

      const first = await accept(
        runThreadsApi.create({ headers: tokenHeaders, body: requestBody }),
        [201],
      );
      const second = await accept(
        runThreadsApi.create({ headers: tokenHeaders, body: requestBody }),
        [201],
      );

      expect(first.body.id).toBe(clientThreadId);
      expect(second.body).toStrictEqual(first.body);
      const createdEvents = await createdEventsFor(
        tokenHeaders,
        clientThreadId,
      );
      expect(createdEvents).toHaveLength(1);
      expect(createdEvents[0]?.id).toBe(eventId);
    },
  );
});
