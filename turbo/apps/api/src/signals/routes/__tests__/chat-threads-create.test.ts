import { randomUUID } from "node:crypto";
import { chatConnectorAccessContract } from "@okouai/api-contracts/contracts/chat-connector-access";
import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import {
  chatThreadConnectorSelectionContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { builtinConnectorManualGrantContract } from "@okouai/api-contracts/contracts/connectors";
import {
  customConnectorValuesContract,
  customConnectorsContract,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { vncConnectionsContract } from "@okouai/api-contracts/contracts/vnc-connections";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { chatConnectorAccessRoutes } from "../chat-connector-access";
import { chatRemoteAccessRoutes } from "../chat-remote-access";
import { chatThreadConnectorSelectionRoutes } from "../chat-threads-connector-selections";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { builtinConnectorsRoutes } from "../connectors";
import { customConnectorsRoutes } from "../custom-connectors";
import { customConnectorsValuesSetRoutes } from "../custom-connectors-values-set";
import { sshConnectionsRoutes } from "../ssh-connections";
import { vncConnectionsRoutes } from "../vnc-connections";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import { inlineSshKey } from "./helpers/ssh-credential";
import { vncConnectionBody } from "./helpers/vnc-runtime";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

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

function signIn(userId: string, orgId: string) {
  createRouteMocks(context).clerk.session(userId, orgId, "org:admin");
  return headers;
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
});
