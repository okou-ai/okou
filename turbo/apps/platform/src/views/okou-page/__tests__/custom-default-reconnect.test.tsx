import {
  httpConnectorFixture,
  connectorFixtureAccount,
} from "../../../mocks/handlers/connector-account-fixtures.ts";
import {
  agentCustomConnectorsContract,
  type AgentCustomConnectorGrant,
} from "@okouai/api-contracts/contracts/agent-custom-connectors";
import {
  connectorAccountTargetKey,
  connectorAccountsContract,
  type ConnectorAccountConnection,
  type ConnectorAccountMutationIntent,
} from "@okouai/api-contracts/contracts/connector-accounts";
import {
  customConnectorOAuth2Contract,
  customConnectorValuesContract,
  customConnectorsContract,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  customConnector,
  customConnectorAccount,
  getConnectorAction,
  mockOAuthCompletions,
  queryConnectorAction,
} from "./connector-page-test-helpers.ts";

const context = testContext();
const AGENT_ID = "00000000-0000-0000-0000-000000000001";

function mockAccountReads(
  read: () => readonly ConnectorAccountConnection[],
): void {
  context.mocks.api(
    connectorAccountsContract.connections,
    ({ query, respond }) => {
      const accounts = read().filter((account) => {
        return (
          connectorAccountTargetKey(account.target) ===
          connectorAccountTargetKey(query)
        );
      });
      return respond(200, {
        connections: accounts,
        nextCursor: null,
        defaultConnection:
          accounts.find((account) => {
            return account.isDefault;
          }) ?? null,
      });
    },
  );
  context.mocks.api(
    connectorAccountsContract.connection,
    ({ params, query, respond }) => {
      const account = read().find((account) => {
        return (
          account.id === params.connectionId &&
          connectorAccountTargetKey(account.target) ===
            connectorAccountTargetKey(query)
        );
      });
      return account
        ? respond(200, account)
        : respond(404, {
            error: { code: "NOT_FOUND", message: "Account not found" },
          });
    },
  );
}

async function openConnection(
  connector: ReturnType<typeof customConnector>,
): Promise<HTMLElement> {
  await setupPage({
    context,
    path: `/connectors/${connector.slug}/connect?agentId=${AGENT_ID}`,
  });
  await screen.findByText(
    connectorFixtureAccount(connector) !== undefined
      ? `${connector.displayName} connected`
      : `Okou needs ${connector.displayName} to proceed`,
  );
  click(
    getConnectorAction(
      "button",
      connectorFixtureAccount(connector) !== undefined
        ? "Reconnect"
        : "Connect",
    ),
  );
  return await screen.findByRole("dialog", {
    name: `Connect ${connector.displayName}`,
  });
}

test.each([1, 2])(
  "Reconnect an expired custom default with %i saved accounts",
  async (accountCount) => {
    let connector = customConnector({
      slug: "_acme-search",
      configuredFieldKeys: ["secret"],
    });
    let account = customConnectorAccount(connector.id, {
      connectionStatus: "reconnect-required",
      reconnectReason: "authorization_expired_or_revoked",
      configuredFieldKeys: ["secret"],
    });
    const siblingAccountIds = Array.from({ length: accountCount - 1 }, () => {
      return crypto.randomUUID();
    });
    mockAccountReads(() => {
      return [
        account,
        ...siblingAccountIds.map((id) => {
          return {
            ...account,
            id,
            isDefault: false,
          };
        }),
      ];
    });
    context.mocks.api(customConnectorsContract.list, ({ respond }) => {
      return respond(200, { connectors: [connector] });
    });
    const mutations: ConnectorAccountMutationIntent[] = [];
    context.mocks.api(
      customConnectorValuesContract.set,
      ({ body, respond }) => {
        mutations.push(body.account);
        account = {
          ...account,
          connectionStatus: "connected",
          reconnectReason: null,
        };
        connector = httpConnectorFixture({
          ...connector,
          connected: true,
          connectedAccountId: account.id,
          missingRequiredFields: [],
        });
        return respond(200, { ...connector, connectionId: account.id });
      },
    );
    let grants: AgentCustomConnectorGrant[] = [];
    context.mocks.api(
      agentCustomConnectorsContract.update,
      ({ body, respond }) => {
        grants = body.grants;
        return respond(200, { grants });
      },
    );

    const dialog = await openConnection(connector);
    expect(getConnectorAction("button", "Save", dialog)).toBeDisabled();
    await fill(within(dialog).getByLabelText("Secret"), "replacement-secret");
    click(getConnectorAction("button", "Save", dialog));

    await screen.findByText(`${connector.displayName} connected`);
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", {
          name: `Connect ${connector.displayName}`,
        }),
      ).toBeNull();
    });
    expect(mutations).toStrictEqual([
      { intent: "reconnect", connectionId: account.id },
    ]);
    expect(grants).toStrictEqual([
      { customConnectorId: connector.id, permissionNames: [] },
    ]);
  },
);

test("Resolve the current default instead of stale definition identity", async () => {
  const staleConnectionId = crypto.randomUUID();
  let connector = customConnector({
    slug: "_acme-search",
    connected: true,
    connectedAccountId: staleConnectionId,
    configuredFieldKeys: ["secret"],
    missingRequiredFields: [],
  });
  const account = customConnectorAccount(connector.id, {
    configuredFieldKeys: ["secret"],
  });
  mockAccountReads(() => {
    return [account, { ...account, id: staleConnectionId, isDefault: false }];
  });
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: [connector] });
  });
  const mutations: ConnectorAccountMutationIntent[] = [];
  context.mocks.api(customConnectorValuesContract.set, ({ body, respond }) => {
    mutations.push(body.account);
    connector = httpConnectorFixture({
      ...connector,
      connectedAccountId: account.id,
    });
    return respond(200, { ...connector, connectionId: account.id });
  });
  const dialog = await openConnection(connector);
  await fill(within(dialog).getByLabelText("Secret"), "replacement-secret");
  click(getConnectorAction("button", "Save", dialog));
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", {
        name: `Connect ${connector.displayName}`,
      }),
    ).toBeNull();
  });
  expect(mutations).toStrictEqual([
    { intent: "reconnect", connectionId: account.id },
  ]);
});

type PreflightState = "zero" | "pending" | "failed" | "no-default" | "expired";

function installOAuthFlow(state: PreflightState, complete = false) {
  let connector = customConnector({
    slug: "_acme-search",
    authMode: "oauth",
    fields: [],
    headerInjections: [
      { name: "Authorization", valueTemplate: "Bearer {{oauth.access_token}}" },
    ],
    missingRequiredFields: ["oauth"],
    oauthConfig: {
      providerAdapter: "standard",
      clientId: "client-id",
      authorizationUrl: "https://acme.test/oauth/authorize",
      tokenUrl: "https://acme.test/oauth/token",
      tokenEndpointAuthMethod: "client_secret_post",
      pkceMethod: "S256",
      scopes: [],
      authorizationParams: {},
    },
  });
  let account = customConnectorAccount(connector.id, {
    authMethod: "oauth",
    connectionStatus: "reconnect-required",
    reconnectReason: "authorization_expired_or_revoked",
  });
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: [connector] });
  });
  const requested = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  let preflight = false;
  context.mocks.api(
    connectorAccountsContract.connections,
    async ({ query, respond }) => {
      expect(query).toMatchObject(account.target);
      if (preflight && !requested.settled()) {
        requested.resolve();
      }
      if (preflight && state === "pending") {
        await release.promise;
      }
      if (preflight && state === "failed") {
        return respond(403, {
          error: { code: "FORBIDDEN", message: "Account access unavailable" },
        });
      }
      return respond(200, {
        connections:
          state === "expired" || state === "no-default"
            ? [{ ...account, isDefault: state === "expired" }]
            : [],
        nextCursor: null,
        defaultConnection: state === "expired" ? account : null,
      });
    },
  );
  const completed = mockOAuthCompletions(context);
  context.mocks.api(
    connectorAccountsContract.connection,
    ({ params, query, respond }) => {
      return (state === "expired" ||
        connectorFixtureAccount(connector) !== undefined) &&
        params.connectionId === account.id &&
        connectorAccountTargetKey(query) ===
          connectorAccountTargetKey(account.target)
        ? respond(200, account)
        : respond(404, {
            error: { code: "NOT_FOUND", message: "Account not found" },
          });
    },
  );
  const attemptId = crypto.randomUUID();
  const mutations: ConnectorAccountMutationIntent[] = [];
  context.mocks.api(
    customConnectorOAuth2Contract.start,
    ({ body, respond }) => {
      mutations.push(body.account);
      if (complete || state === "expired") {
        completed.set(attemptId, account.id);
      }
      if (complete) {
        account = {
          ...account,
          connectionStatus: "connected",
          reconnectReason: null,
        };
        connector = httpConnectorFixture({
          ...connector,
          connected: true,
          connectedAccountId: account.id,
          missingRequiredFields: [],
        });
      }
      return respond(200, {
        result: "authorization",
        oauthAttemptId: attemptId,
        authorizationUrl: "https://acme.test/oauth/authorize",
        ...(body.account.intent === "reconnect"
          ? { connectionId: account.id }
          : {}),
      });
    },
  );
  const grants: AgentCustomConnectorGrant[][] = [];
  context.mocks.api(
    agentCustomConnectorsContract.update,
    ({ body, respond }) => {
      grants.push(body.grants);
      return respond(200, { grants: body.grants });
    },
  );
  const authWindow = context.mocks.browser.authWindow();
  Object.defineProperty(authWindow, "location", {
    value: { href: "about:blank" },
    configurable: true,
  });
  context.mocks.browser.open(authWindow);
  return {
    connector: () => {
      return connector;
    },
    account,
    requested,
    release,
    mutations,
    grants,
    authWindow,
    startPreflight: () => {
      preflight = true;
    },
  };
}

async function openOAuthConnection(
  flow: ReturnType<typeof installOAuthFlow>,
): Promise<HTMLElement> {
  const dialog = await openConnection(flow.connector());
  flow.startPreflight();
  return dialog;
}

test("Wait for the initial account inventory before offering a custom connection", async () => {
  const flow = installOAuthFlow("pending");
  flow.startPreflight();
  await setupPage({
    context,
    path: `/connectors/${flow.connector().slug}/connect?agentId=${AGENT_ID}`,
  });
  await flow.requested.promise;
  expect(queryConnectorAction("button", "Connect")).toBeNull();
  flow.release.resolve();
  await screen.findByText("Okou needs Acme Search to proceed");
  expect(getConnectorAction("button", "Connect")).toBeEnabled();
  expect(flow.mutations).toStrictEqual([]);
});

test("Keep a failed initial account inventory from offering a custom connection", async () => {
  const flow = installOAuthFlow("failed");
  flow.startPreflight();
  await setupPage({
    context,
    path: `/connectors/${flow.connector().slug}/connect?agentId=${AGENT_ID}`,
  });
  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    "Account access unavailable",
  );
  expect(getConnectorAction("button", "Connect")).toBeDisabled();
  expect(flow.mutations).toStrictEqual([]);
});

test("Add the first custom OAuth account after confirming zero accounts", async () => {
  const flow = installOAuthFlow("zero");
  const dialog = await openOAuthConnection(flow);
  click(getConnectorAction("button", "Continue", dialog));
  await waitFor(() => {
    expect(flow.authWindow.location.href).toBe(
      "https://acme.test/oauth/authorize",
    );
  });
  expect(flow.mutations).toStrictEqual([{ intent: "add" }]);
  flow.authWindow.close();
  await waitFor(() => {
    expect(getConnectorAction("button", "Continue", dialog)).toBeEnabled();
  });
});

test("Cancel a pending default lookup before starting provider authorization", async () => {
  const flow = installOAuthFlow("pending");
  const dialog = await openOAuthConnection(flow);
  click(getConnectorAction("button", "Continue", dialog));
  await flow.requested.promise;
  expect(flow.authWindow.location.href).toBe("about:blank");
  expect(flow.mutations).toStrictEqual([]);
  click(getConnectorAction("button", "Close", dialog));
  await waitFor(() => {
    expect(flow.authWindow.closed).toBeTruthy();
  });
  flow.release.resolve();
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Connect Acme Search" }),
    ).toBeNull();
  });
  expect(flow.mutations).toStrictEqual([]);
});

test.each([
  { state: "failed" as const, error: /Account access unavailable/u },
  { state: "no-default" as const, error: /saved accounts but no default/u },
])(
  "Keep a $state default lookup from creating another account",
  async ({ state, error }) => {
    const flow = installOAuthFlow(state);
    const dialog = await openOAuthConnection(flow);
    click(getConnectorAction("button", "Continue", dialog));
    await within(dialog).findByText(error);
    expect(flow.authWindow.closed).toBeTruthy();
    expect(flow.authWindow.location.href).toBe("about:blank");
    expect(flow.mutations).toStrictEqual([]);
  },
);

test("Authorize an expired OAuth default only after ready completion", async () => {
  const flow = installOAuthFlow("expired", true);
  const dialog = await openOAuthConnection(flow);
  click(getConnectorAction("button", "Continue", dialog));
  await waitFor(() => {
    expect(flow.authWindow.location.href).toBe(
      "https://acme.test/oauth/authorize",
    );
  });
  flow.authWindow.close();
  await screen.findByText("Acme Search connected");
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Connect Acme Search" }),
    ).toBeNull();
  });
  expect(flow.grants).toStrictEqual([
    [{ customConnectorId: flow.connector().id, permissionNames: [] }],
  ]);
  expect(flow.mutations).toStrictEqual([
    { intent: "reconnect", connectionId: flow.account.id },
  ]);
});

test("Keep an incomplete OAuth reconnect unauthorized", async () => {
  const flow = installOAuthFlow("expired");
  const dialog = await openOAuthConnection(flow);
  click(getConnectorAction("button", "Continue", dialog));
  await waitFor(() => {
    expect(flow.authWindow.location.href).toBe(
      "https://acme.test/oauth/authorize",
    );
  });
  flow.authWindow.close();
  await waitFor(() => {
    expect(getConnectorAction("button", "Continue", dialog)).toBeEnabled();
  });
  expect(flow.mutations).toStrictEqual([
    { intent: "reconnect", connectionId: flow.account.id },
  ]);
  expect(flow.grants).toStrictEqual([]);
  expect(screen.queryByText("Acme Search connected")).toBeNull();
});
