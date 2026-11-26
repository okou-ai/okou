import { randomUUID } from "node:crypto";
import { chatConnectorAccessContract } from "@okouai/api-contracts/contracts/chat-connector-access";
import {
  chatThreadConnectorSelectionContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  connectorAccountsContract,
  type ConnectorAccountSelection,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { builtinConnectorManualGrantContract } from "@okouai/api-contracts/contracts/connectors";
import {
  customConnectorByIdContract,
  customConnectorValuesContract,
  customConnectorsContract,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { runConnectorAccountsContract } from "@okouai/api-contracts/contracts/run-connector-accounts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { chatConnectorAccessRoutes } from "../chat-connector-access";
import { chatThreadConnectorSelectionRoutes } from "../chat-threads-connector-selections";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { connectedConnectorsRoutes } from "../connected-connectors";
import { connectorAccountRoutes } from "../connector-accounts";
import { builtinConnectorsRoutes } from "../connectors";
import { customConnectorsRoutes } from "../custom-connectors";
import { customConnectorsDeleteRoutes } from "../custom-connectors-delete";
import { customConnectorsValuesSetRoutes } from "../custom-connectors-values-set";
import { runConnectorAccountRoutes } from "../run-connector-accounts";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { manualHttpCustomConnectorCreateBody } from "./helpers/api-bdd-connectors";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const OPENAI_TARGET = Object.freeze({
  kind: "builtin" as const,
  connectorSlug: "openai" as const,
});

const app = setupApp({
  context,
  routes: [
    ...chatThreadCreateRoutes,
    ...chatThreadConnectorSelectionRoutes,
    ...chatConnectorAccessRoutes,
    ...connectedConnectorsRoutes,
    ...connectorAccountRoutes,
    ...builtinConnectorsRoutes,
    ...customConnectorsRoutes,
    ...customConnectorsDeleteRoutes,
    ...customConnectorsValuesSetRoutes,
    ...runConnectorAccountRoutes,
  ],
});
const threadsApi = app(chatThreadsContract);
const selectionsApi = app(chatThreadConnectorSelectionContract);
const accessApi = app(chatConnectorAccessContract);
const accountsApi = app(connectorAccountsContract);
const builtinManualGrantApi = app(builtinConnectorManualGrantContract);
const customConnectorsApi = app(customConnectorsContract);
const customConnectorByIdApi = app(customConnectorByIdContract);
const customValuesApi = app(customConnectorValuesContract);
const runConnectorAccountsApi = app(runConnectorAccountsContract);

function signIn(userId: string, orgId: string) {
  createRouteMocks(context).clerk.session(userId, orgId, "org:admin");
  return headers;
}

function manualMcpBody(displayName: string) {
  return {
    kind: "mcp" as const,
    displayName,
    endpoint: `https://mcp-${randomUUID()}.example.test/mcp`,
    transport: "streamable-http" as const,
    authMode: "manual" as const,
    fields: [
      {
        key: "secret",
        label: "Secret",
        kind: "secret" as const,
        required: true,
      },
    ],
    headerInjections: [
      { name: "Authorization", valueTemplate: "Bearer {{secrets.secret}}" },
    ],
    queryInjections: [],
  };
}

async function setupMcpAccounts(withSibling = true) {
  const orgId = `org_${randomUUID()}`;
  const ownerId = `user_${randomUUID()}`;
  const ownerHeaders = signIn(ownerId, orgId);

  const [requestingChat, siblingChat, mcpConnector] = await Promise.all([
    accept(
      threadsApi.create({ headers: ownerHeaders, body: { model: null } }),
      [201],
    ),
    withSibling
      ? accept(
          threadsApi.create({ headers: ownerHeaders, body: { model: null } }),
          [201],
        )
      : Promise.resolve(null),
    accept(
      customConnectorsApi.create({
        headers: ownerHeaders,
        body: manualMcpBody("Manual MCP"),
      }),
      [201],
    ),
  ]);

  const [fallbackAccount, requestedAccount] = await Promise.all([
    withSibling
      ? accept(
          customValuesApi.set({
            headers: ownerHeaders,
            params: { id: mcpConnector.body.id },
            body: {
              values: [
                { key: "secret", kind: "secret", value: `fb-${randomUUID()}` },
              ],
              account: { intent: "add", displayName: "Fallback" },
            },
          }),
          [200],
        )
      : Promise.resolve(null),
    accept(
      customValuesApi.set({
        headers: ownerHeaders,
        params: { id: mcpConnector.body.id },
        body: {
          values: [
            { key: "secret", kind: "secret", value: `req-${randomUUID()}` },
          ],
          account: { intent: "add", displayName: "Requested" },
        },
      }),
      [200],
    ),
  ]);

  const target = {
    kind: "custom" as const,
    customConnectorId: mcpConnector.body.id,
  };
  if (siblingChat && fallbackAccount) {
    await accept(
      selectionsApi.update({
        headers: ownerHeaders,
        params: { id: siblingChat.body.id },
        body: { target, connectionId: fallbackAccount.body.connectionId },
      }),
      [200],
    );
  }

  return {
    orgId,
    ownerId,
    ownerHeaders,
    requestingChatId: requestingChat.body.id,
    siblingChatId: siblingChat?.body.id ?? "",
    target,
    fallbackConnectionId: fallbackAccount?.body.connectionId ?? "",
    requestedConnectionId: requestedAccount.body.connectionId,
    requestedSelection: {
      target,
      connectionId: requestedAccount.body.connectionId,
    },
  };
}

describe("Chat connector execution", () => {
  it("chat-connector-execution-002 (1/3) rejects approval when switch is off, denies account, and rejects foreign Chat and mismatched target", async () => {
    const setup = await setupMcpAccounts(false);
    const otherId = `user_${randomUUID()}`;
    const mismatchedConnector = await accept(
      customConnectorsApi.create({
        headers: setup.ownerHeaders,
        body: manualMcpBody("Other MCP"),
      }),
      [201],
    );
    const otherChat = await accept(
      threadsApi.create({
        headers: signIn(otherId, setup.orgId),
        body: { model: null },
      }),
      [201],
    );

    const authHeaders = signIn(setup.ownerId, setup.orgId);
    await accept(
      runConnectorAccountsApi.approveMember({
        headers: authHeaders,
        params: { threadId: setup.requestingChatId },
        body: setup.requestedSelection,
      }),
      [404],
    );

    await updateFeatureSwitchesForUser(
      context,
      { userId: setup.ownerId, orgId: setup.orgId, orgRole: "org:admin" },
      { [FeatureSwitchKey.MemberConnectorAccountAccess]: true },
    );

    const denied = await accept(
      accessApi.updateAccountPolicy({
        headers: signIn(setup.ownerId, setup.orgId),
        params: { connectionId: setup.requestedConnectionId },
        body: { target: setup.target, policy: "deny" },
      }),
      [200],
    );
    expect(denied.body).toStrictEqual({
      connectionId: setup.requestedConnectionId,
      allowed: false,
      enabled: false,
      expiresAt: null,
    });

    await accept(
      runConnectorAccountsApi.approveMember({
        headers: authHeaders,
        params: { threadId: otherChat.body.id },
        body: setup.requestedSelection,
      }),
      [404],
    );
    await accept(
      runConnectorAccountsApi.approveMember({
        headers: authHeaders,
        params: { threadId: setup.requestingChatId },
        body: {
          target: {
            kind: "custom",
            customConnectorId: mismatchedConnector.body.id,
          },
          connectionId: setup.requestedConnectionId,
        },
      }),
      [404],
    );
  });

  it("chat-connector-execution-002 (2/3) approves the exact account member-wide with 1h expiry and selects it only in the requesting Chat", async () => {
    const setup = await setupMcpAccounts(true);
    await updateFeatureSwitchesForUser(
      context,
      { userId: setup.ownerId, orgId: setup.orgId, orgRole: "org:admin" },
      { [FeatureSwitchKey.MemberConnectorAccountAccess]: true },
    );
    const authHeaders = signIn(setup.ownerId, setup.orgId);
    await accept(
      accessApi.updateAccountPolicy({
        headers: authHeaders,
        params: { connectionId: setup.requestedConnectionId },
        body: { target: setup.target, policy: "deny" },
      }),
      [200],
    );

    const beforeApproveMs = now();
    const approved = await accept(
      runConnectorAccountsApi.approveMember({
        headers: authHeaders,
        params: { threadId: setup.requestingChatId },
        body: setup.requestedSelection,
      }),
      [200],
    );
    expect(approved.body).toStrictEqual(setup.requestedSelection);

    const [requestingOverview, siblingOverview, policiesAfterApprove] =
      await Promise.all([
        accept(
          accessApi.overviewTarget({
            headers: authHeaders,
            query: { threadId: setup.requestingChatId, ...setup.target },
          }),
          [200],
        ),
        accept(
          accessApi.overviewTarget({
            headers: authHeaders,
            query: { threadId: setup.siblingChatId, ...setup.target },
          }),
          [200],
        ),
        accept(
          accessApi.accountPolicies({
            headers: authHeaders,
            query: setup.target,
          }),
          [200],
        ),
      ]);

    expect(requestingOverview.body.connector?.currentConnectionId).toBe(
      setup.requestedConnectionId,
    );
    expect(siblingOverview.body.connector?.currentConnectionId).toBe(
      setup.fallbackConnectionId,
    );
    expect(siblingOverview.body.connector?.accounts).toContainEqual(
      expect.objectContaining({
        connectionId: setup.requestedConnectionId,
        enabled: true,
      }),
    );

    const oneHourPolicy = policiesAfterApprove.body.find((entry) => {
      return entry.connectionId === setup.requestedConnectionId;
    });
    expect(oneHourPolicy).toMatchObject({
      connectionId: setup.requestedConnectionId,
      allowed: true,
      enabled: true,
    });
    expect(oneHourPolicy?.expiresAt).toBeTruthy();
    const expiresMs = Date.parse(oneHourPolicy?.expiresAt ?? "");
    expect(expiresMs - beforeApproveMs).toBeGreaterThanOrEqual(3_590_000);
    expect(expiresMs - beforeApproveMs).toBeLessThanOrEqual(3_610_000);
  });

  it("chat-connector-execution-002 (3/3) preserves an existing 24-hour policy on subsequent approval", async () => {
    const setup = await setupMcpAccounts(false);
    await updateFeatureSwitchesForUser(
      context,
      { userId: setup.ownerId, orgId: setup.orgId, orgRole: "org:admin" },
      { [FeatureSwitchKey.MemberConnectorAccountAccess]: true },
    );
    const authHeaders = signIn(setup.ownerId, setup.orgId);

    const allow24h = await accept(
      accessApi.updateAccountPolicy({
        headers: authHeaders,
        params: { connectionId: setup.requestedConnectionId },
        body: { target: setup.target, policy: "allow-24h" },
      }),
      [200],
    );
    await accept(
      runConnectorAccountsApi.approveMember({
        headers: authHeaders,
        params: { threadId: setup.requestingChatId },
        body: setup.requestedSelection,
      }),
      [200],
    );
    const policiesAfter24h = await accept(
      accessApi.accountPolicies({
        headers: authHeaders,
        query: setup.target,
      }),
      [200],
    );
    const persisted24h = policiesAfter24h.body.find((entry) => {
      return entry.connectionId === setup.requestedConnectionId;
    });
    expect(persisted24h).toStrictEqual(allow24h.body);
  });

  it("chat-thread-connector-selection.ownership-001 (1/6) selects both accounts and rejects mismatched accounts and targets", async () => {
    const setup = await selectOwnedBoth(true);
    const { owner, threadId, openai, custom, initial } = setup;

    await expect(readThreadSelections(owner, threadId)).resolves.toStrictEqual(
      initial,
    );

    const invalid: ConnectorAccountSelection[] = [
      setup.peerOpenai,
      setup.foreignOpenai,
      { connectionId: openai.connectionId, target: custom.target },
      { connectionId: custom.connectionId, target: OPENAI_TARGET },
    ];
    const rejections = await Promise.all(
      invalid.map(async (selection) => {
        const [current] = await Promise.all([
          setOwnedCurrent(owner, threadId, selection, 400),
          selectOwned(owner, threadId, selection, 400),
          setOwnedOverride(owner, threadId, selection, false, 404),
        ]);
        return current.body;
      }),
    );
    for (const rejected of rejections) {
      expect(rejected).toMatchObject({ error: { code: "BAD_REQUEST" } });
    }
    await expect(readThreadSelections(owner, threadId)).resolves.toStrictEqual(
      initial,
    );
  });

  it("chat-thread-connector-selection.ownership-001 (2/6) answers other identities exactly like a missing thread", async () => {
    const setup = await selectOwnedBoth(true);
    const { owner, threadId, initial } = setup;

    for (const [outsider, ownAccount] of [
      [setup.peer, setup.peerOpenai],
      [setup.ownerElsewhere, setup.foreignOpenai],
    ] as const) {
      signInUser(outsider);
      await accept(
        selectionsApi.get({ headers, params: { id: threadId } }),
        [404],
      );
      const missingThreadId = randomUUID();
      const mutations = [
        (id: string) => {
          return selectionsApi.update({
            headers,
            params: { id },
            body: ownAccount,
          });
        },
        (id: string) => {
          return accessApi.setThreadCurrent({
            headers,
            params: { threadId: id },
            body: ownAccount,
          });
        },
        (id: string) => {
          return accessApi.setThreadOverride({
            headers,
            params: { threadId: id, connectionId: ownAccount.connectionId },
            body: { target: ownAccount.target, enabled: false },
          });
        },
      ];
      const outcomes = await Promise.all(
        mutations.map(async (mutate) => {
          const [foreign, missing] = await Promise.all([
            mutate(threadId),
            mutate(missingThreadId),
          ]);
          return { foreign, missing };
        }),
      );
      for (const { foreign, missing } of outcomes) {
        expect(foreign.status).toBeGreaterThanOrEqual(400);
        expect({ status: foreign.status, body: foreign.body }).toStrictEqual({
          status: missing.status,
          body: missing.body,
        });
      }
    }
    await expect(readThreadSelections(owner, threadId)).resolves.toStrictEqual(
      initial,
    );
  });

  it("chat-thread-connector-selection.ownership-001 (3/6) drops disabled accounts until their overrides are removed", async () => {
    const setup = await selectOwnedBoth(false);
    const { owner, threadId, openai, custom, initial } = setup;

    const disabled = await setOwnedOverrides(setup, false);
    expect(
      disabled.map((response) => {
        if (response.status !== 200) {
          throw new Error("Expected the override to be saved");
        }
        return response.body.currentConnectionId;
      }),
    ).toStrictEqual([null, null]);
    await expect(readThreadSelections(owner, threadId)).resolves.toStrictEqual({
      selections: [],
      descriptions: [],
    });
    await Promise.all(
      [openai, custom].map((selection) => {
        return setOwnedCurrent(owner, threadId, selection, 400);
      }),
    );
    await setOwnedOverrides(setup, null);
    await expect(readThreadSelections(owner, threadId)).resolves.toStrictEqual(
      initial,
    );
  });

  it("chat-thread-connector-selection.ownership-001 (4/6) shows the renamed OpenAI account while keeping the selection", async () => {
    const setup = await selectOwnedBoth(false);

    await renameOwnedOpenAi(setup);

    const renamed = await readThreadSelections(setup.owner, setup.threadId);
    expect(renamed.selections).toStrictEqual(setup.initial.selections);
    expect(renamed.descriptions).toContain(
      `${setup.openai.connectionId}:Renamed`,
    );
  });

  it("chat-thread-connector-selection.ownership-001 (5/6) removes the deleted OpenAI account while keeping the custom selection", async () => {
    const setup = await selectOwnedBoth(false);
    const { owner, threadId, openai, custom } = setup;
    await renameOwnedOpenAi(setup);

    signInUser(owner);
    await accept(
      accountsApi.delete({
        headers,
        params: { connectionId: openai.connectionId },
        body: { target: OPENAI_TARGET },
      }),
      [200],
    );
    await expect(readThreadSelections(owner, threadId)).resolves.toStrictEqual({
      selections: [custom.connectionId],
      descriptions: [setup.customDescription],
    });
  });

  it("chat-thread-connector-selection.ownership-001 (6/6) clears the remaining selection when the custom connector is deleted", async () => {
    const setup = await selectOwnedBoth(false);
    const { owner, threadId, openai } = setup;
    signInUser(owner);
    await accept(
      accountsApi.delete({
        headers,
        params: { connectionId: openai.connectionId },
        body: { target: OPENAI_TARGET },
      }),
      [200],
    );

    await accept(
      customConnectorByIdApi.delete({
        headers,
        params: { id: setup.connectorId },
      }),
      [204],
    );
    await expect(readThreadSelections(owner, threadId)).resolves.toStrictEqual({
      selections: [],
      descriptions: [],
    });
  });
});

function signInUser(actor: ApiTestUser): void {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
}

async function addOpenAiAccount(
  actor: ApiTestUser,
  displayName: string,
): Promise<ConnectorAccountSelection> {
  signInUser(actor);
  const connected = await accept(
    builtinManualGrantApi.connect({
      headers,
      params: { connectorSlug: "openai" },
      body: {
        authMethod: "api-token",
        values: { apiKey: `sk-test-${randomUUID()}` },
        account: { intent: "add", displayName },
      },
    }),
    [200],
  );
  return { connectionId: connected.body.connectionId, target: OPENAI_TARGET };
}

async function readThreadSelections(actor: ApiTestUser, threadId: string) {
  signInUser(actor);
  const response = await accept(
    selectionsApi.get({ headers, params: { id: threadId } }),
    [200],
  );
  return {
    selections: response.body.selections
      .map((selection) => {
        return selection.connectionId;
      })
      .sort(),
    descriptions: response.body.selectedConnections
      .map((connection) => {
        return `${connection.id}:${connection.displayName ?? ""}`;
      })
      .sort(),
  };
}

async function selectOwned(
  actor: ApiTestUser,
  threadId: string,
  selection: ConnectorAccountSelection,
  status: 200 | 400 | 404,
) {
  signInUser(actor);
  return await accept(
    selectionsApi.update({
      headers,
      params: { id: threadId },
      body: selection,
    }),
    [status],
  );
}

async function setOwnedCurrent(
  actor: ApiTestUser,
  threadId: string,
  selection: ConnectorAccountSelection,
  status: 200 | 400 | 404,
) {
  signInUser(actor);
  return await accept(
    accessApi.setThreadCurrent({
      headers,
      params: { threadId },
      body: { target: selection.target, connectionId: selection.connectionId },
    }),
    [status],
  );
}

async function setOwnedOverride(
  actor: ApiTestUser,
  threadId: string,
  selection: ConnectorAccountSelection,
  enabled: boolean | null,
  status: 200 | 404,
) {
  signInUser(actor);
  return await accept(
    accessApi.setThreadOverride({
      headers,
      params: { threadId, connectionId: selection.connectionId },
      body: { target: selection.target, enabled },
    }),
    [status],
  );
}

async function selectOwnedBoth(withOutsiders: boolean) {
  const owner = bdd.user();
  const peer = bdd.user({ orgId: owner.orgId, orgRole: "org:member" });
  const ownerElsewhere = bdd.user({ userId: owner.userId });
  signInUser(owner);
  const [thread, openai, connector] = await Promise.all([
    accept(threadsApi.create({ headers, body: { model: null } }), [201]),
    addOpenAiAccount(owner, "Primary"),
    accept(
      customConnectorsApi.create({
        headers,
        body: manualHttpCustomConnectorCreateBody({
          displayName: "Ledger",
          prefixTemplates: [`https://${randomUUID()}.example.test/api/`],
        }),
      }),
      [201],
    ),
  ]);
  const customSaved = await accept(
    customValuesApi.set({
      headers,
      params: { id: connector.body.id },
      body: {
        values: [
          { key: "secret", kind: "secret", value: `secret-${randomUUID()}` },
        ],
        account: { intent: "add", displayName: "Ledger Account" },
      },
    }),
    [200],
  );
  const custom: ConnectorAccountSelection = {
    connectionId: customSaved.body.connectionId,
    target: { kind: "custom", customConnectorId: connector.body.id },
  };
  const peerOpenai = withOutsiders
    ? await addOpenAiAccount(peer, "Peer")
    : openai;
  const foreignOpenai = withOutsiders
    ? await addOpenAiAccount(ownerElsewhere, "Elsewhere")
    : openai;
  const customDescription = `${custom.connectionId}:Ledger Account`;

  await Promise.all([
    setOwnedCurrent(owner, thread.body.id, openai, 200),
    setOwnedCurrent(owner, thread.body.id, custom, 200),
  ]);
  const initial = {
    selections: [openai.connectionId, custom.connectionId].sort(),
    descriptions: [`${openai.connectionId}:Primary`, customDescription].sort(),
  };
  return {
    owner,
    peer,
    ownerElsewhere,
    threadId: thread.body.id,
    openai,
    custom,
    connectorId: connector.body.id,
    customDescription,
    peerOpenai,
    foreignOpenai,
    initial,
  };
}

type OwnedSelectedChat = Awaited<ReturnType<typeof selectOwnedBoth>>;

async function setOwnedOverrides(
  setup: OwnedSelectedChat,
  enabled: false | null,
) {
  return await Promise.all(
    [setup.openai, setup.custom].map((selection) => {
      return setOwnedOverride(
        setup.owner,
        setup.threadId,
        selection,
        enabled,
        200,
      );
    }),
  );
}

async function renameOwnedOpenAi(setup: OwnedSelectedChat) {
  signInUser(setup.owner);
  await accept(
    accountsApi.rename({
      headers,
      params: { connectionId: setup.openai.connectionId },
      body: { target: OPENAI_TARGET, displayName: "Renamed" },
    }),
    [200],
  );
}
