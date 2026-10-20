import {
  connectorAccountsContract,
  type ConnectorAccountConnection,
  type ConnectorAccountMutationIntent,
} from "@okouai/api-contracts/contracts/connector-accounts";
import {
  customConnectorAccount,
  mockConnectorAgentAccess,
  mockOAuthCompletions,
} from "./connector-page-test-helpers.ts";
import {
  agentCustomConnectorsContract,
  type AgentCustomConnectorGrant,
} from "@okouai/api-contracts/contracts/agent-custom-connectors";
import {
  bankingUserContract,
  type BankingAccessRequestStatusResponse,
} from "@okouai/api-contracts/contracts/banking";
import { connectorCatalogReaderContract } from "@okouai/api-contracts/contracts/connector-catalog-readers";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import {
  builtinConnectorsMainContract,
  builtinConnectorNoAuthGrantContract,
  builtinConnectorOauthStartContract,
} from "@okouai/api-contracts/contracts/connectors";
import {
  customConnectorsContract,
  customConnectorValuesContract,
  type CustomConnectorResponse,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { customConnectorsReaderContract } from "@okouai/api-contracts/contracts/custom-connector-readers";
import { userBuiltinConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, describe, beforeEach, it } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  CAPABILITY_AGENT_ID,
  context,
  completedConversation,
  type CapturedChatSend,
  installCapabilityChat,
  readyChat,
  RUN_PATH,
} from "./chat-capability-test-helpers.ts";
import {
  bankingActionUrl,
  browserAuthMethod,
  catalogConnector,
  connectedConnectorResponse,
  connectorActionUrl,
  CONNECTOR_CONNECTION_ID,
  customConnector,
  CUSTOM_CONNECTOR_ID,
  noAuthMethod,
} from "./chat-capability-connector-test-helpers.ts";

const BANK_ACCOUNT_ID = "e0000000-0000-4000-a000-000000000911";
const BANK_CONNECTION_ID = "e0000000-0000-4000-a000-000000000912";
const BANK_SESSION_ID = "e0000000-0000-4000-a000-000000000913";

function installActionConversation(args: {
  readonly lines: readonly string[];
  readonly sends?: CapturedChatSend[];
}): void {
  installCapabilityChat({
    events: completedConversation(args.lines.join("\n\n")),
    onSend(send) {
      args.sends?.push(send);
    },
  });
}

function normalizedText(element: HTMLElement): string {
  return element.textContent?.replace(/\s+/gu, " ").trim() ?? "";
}

function queryControl(
  role: "button" | "link",
  name: string,
  container: ParentNode = document.body,
): HTMLElement | null {
  return (
    queryAllByRoleFast(role, container).find((element) => {
      return (
        element.getAttribute("aria-label") === name ||
        normalizedText(element) === name
      );
    }) ?? null
  );
}

function getControl(
  role: "button" | "link",
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const control = queryControl(role, name, container);
  if (!control) {
    throw new Error(`${name} ${role} was not available`);
  }
  return control;
}

function getButton(name: string, container?: ParentNode): HTMLElement {
  return getControl("button", name, container);
}

function sentPrompts(sends: readonly CapturedChatSend[]): string[] {
  return sends.map((send) => {
    return send.prompt;
  });
}

function installCatalogLookup(
  lookup: (slug: ConnectorSlug) => ReturnType<typeof catalogConnector> | null,
): void {
  const accountFor = (
    slug: ConnectorSlug,
  ): ConnectorAccountConnection | null => {
    const item = lookup(slug);
    if (!item?.connection) {
      return null;
    }
    return {
      id: item.connection.id ?? CONNECTOR_CONNECTION_ID,
      target: { kind: "builtin", connectorSlug: slug },
      authMethod: item.connection.authMethod,
      displayName: null,
      isDefault: true,
      externalId: null,
      externalUsername: item.connection.externalUsername,
      externalEmail: item.connection.externalEmail,
      oauthScopes: [],
      connectionStatus:
        item.connectionStatus === "reconnect-required"
          ? "reconnect-required"
          : "connected",
      reconnectReason: item.connection.reconnectReason,
      tokenExpiresAt: item.tokenExpiresAt,
      setupStatus: "complete",
      scopeMismatch: item.scopeMismatch,
      missingRequiredFields: [],
      configuredFieldKeys: [],
      createdAt: "2026-08-01T08:00:00.000Z",
      updatedAt: "2026-08-01T09:00:00.000Z",
    };
  };
  context.mocks.api(
    connectorAccountsContract.connection,
    ({ query, params, respond }) => {
      const account =
        query.kind === "builtin" ? accountFor(query.connectorSlug) : null;
      return account?.id === params.connectionId
        ? respond(200, account)
        : respond(404, {
            error: { code: "NOT_FOUND", message: "Account not found" },
          });
    },
  );
  context.mocks.api(
    connectorAccountsContract.connections,
    ({ query, respond }) => {
      const account =
        query.kind === "builtin" ? accountFor(query.connectorSlug) : null;
      return respond(200, {
        connections: account ? [account] : [],
        defaultConnection: account,
        nextCursor: null,
      });
    },
  );
  context.mocks.api(connectorCatalogContract.get, ({ params, respond }) => {
    const connector = lookup(params.connectorSlug);
    return connector
      ? respond(200, { connector })
      : respond(404, {
          error: { code: "NOT_FOUND", message: "Connector not found" },
        });
  });
}

function installCustomConnectorApi(args: {
  readonly connector: () => CustomConnectorResponse;
  readonly grants?: AgentCustomConnectorGrant[];
  readonly authorizationUpdates?: AgentCustomConnectorGrant[][];
}): void {
  let grants = args.grants ?? [];
  const account = () => {
    return args.connector().connected
      ? customConnectorAccount(CUSTOM_CONNECTOR_ID, {
          id: CONNECTOR_CONNECTION_ID,
          configuredFieldKeys: ["apiSecret"],
        })
      : null;
  };
  context.mocks.api(
    connectorAccountsContract.connection,
    ({ params, respond }) => {
      const current = account();
      return current?.id === params.connectionId
        ? respond(200, current)
        : respond(404, {
            error: { code: "NOT_FOUND", message: "Account not found" },
          });
    },
  );
  context.mocks.api(connectorAccountsContract.connections, ({ respond }) => {
    const current = account();
    return respond(200, {
      connections: current ? [current] : [],
      defaultConnection: current,
      nextCursor: null,
    });
  });
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: [args.connector()] });
  });
  context.mocks.api(agentCustomConnectorsContract.get, ({ respond }) => {
    return respond(200, { grants });
  });
  mockConnectorAgentAccess(context, () => {
    return { grants };
  });
  context.mocks.api(
    agentCustomConnectorsContract.update,
    ({ body, respond }) => {
      args.authorizationUpdates?.push([...body.grants]);
      grants = [...body.grants];
      return respond(200, { grants });
    },
  );
}

function mockOpenedWindow(): {
  readonly calls: ReturnType<typeof context.mocks.browser.open>["calls"];
  readonly navigations: string[];
  readonly openedWindow: ReturnType<typeof context.mocks.browser.authWindow>;
} {
  const navigations: string[] = [];
  const openedWindow = context.mocks.browser.authWindow();
  const location = {
    _href: "about:blank",
    get href(): string {
      return this._href;
    },
    set href(value: string) {
      this._href = value;
      navigations.push(value);
    },
    replace(value: string | URL): void {
      this._href = String(value);
      navigations.push(String(value));
    },
  };
  Object.defineProperty(openedWindow, "location", {
    configurable: true,
    value: location,
  });
  const browserOpen = context.mocks.browser.open(openedWindow);
  return { calls: browserOpen.calls, navigations, openedWindow };
}

function emptyBankingStatus(): BankingAccessRequestStatusResponse {
  return {
    agent: { id: CAPABILITY_AGENT_ID, name: "Finance Assistant" },
    connection: null,
    session: null,
    grant: null,
  };
}

function connectedBankingStatus(
  grant: BankingAccessRequestStatusResponse["grant"] = null,
): BankingAccessRequestStatusResponse {
  return {
    agent: { id: CAPABILITY_AGENT_ID, name: "Finance Assistant" },
    connection: {
      id: BANK_CONNECTION_ID,
      status: "active",
      accounts: [
        {
          id: BANK_ACCOUNT_ID,
          name: "Operating account",
          institutionName: "Example Bank",
          type: "checking",
          last4: "4321",
          repairRequired: false,
        },
      ],
      repairInstitutions: [],
    },
    session: {
      id: BANK_SESSION_ID,
      mode: "connect",
      status: "completed",
      institutionLoginId: null,
    },
    grant,
  };
}

describe("with an unconnected banking conversation", () => {
  async function prepareScenario() {
    const sends: CapturedChatSend[] = [];
    const purpose = "Review recent cash-flow activity";
    const continuation = "Continue the banking review";
    let status = emptyBankingStatus();
    const popup = mockOpenedWindow();
    installActionConversation({
      lines: [
        "Banking access is needed for this task.",
        bankingActionUrl({ reason: purpose, callbackPrompt: continuation }),
      ],
      sends,
    });
    context.mocks.api(
      bankingUserContract.accessRequestStatus,
      ({ respond }) => {
        return respond(200, status);
      },
    );
    context.mocks.api(
      bankingUserContract.createConnectSession,
      ({ body, respond }) => {
        expect(body).toStrictEqual({
          agentId: CAPABILITY_AGENT_ID,
          mode: "connect",
        });
        status = {
          ...emptyBankingStatus(),
          session: {
            id: BANK_SESSION_ID,
            mode: "connect",
            status: "pending",
            institutionLoginId: null,
          },
        };
        return respond(200, {
          sessionId: BANK_SESSION_ID,
          url: "https://bank.example.test/connect",
        });
      },
    );

    await setupPage({ context, host: "app.okou.ai", path: RUN_PATH });
    await readyChat();
    return {
      purpose,
      popup,
      get status() {
        return status;
      },
      set status(next: typeof status) {
        status = next;
      },
    };
  }
  let preparedScenario: Awaited<ReturnType<typeof prepareScenario>>;
  beforeEach(async () => {
    preparedScenario = await prepareScenario();
  });
  it("connect banking and expose the connected accounts", async () => {
    const { purpose, popup } = preparedScenario;
    const summary = await screen.findByTestId("banking-action-card");
    expect(within(summary).getByText(purpose)).toBeInTheDocument();
    click(getButton("View details", summary));
    const card = await screen.findByRole("dialog", {
      name: "Banking access request",
    });
    expect(within(card).getByText(purpose)).toBeInTheDocument();
    click(getButton("Connect a bank", card));

    expect(popup.calls).toStrictEqual([
      { url: "about:blank", target: "_blank", features: null },
    ]);
    await waitFor(() => {
      expect(popup.navigations).toContain("https://bank.example.test/connect");
    });
    const waitingNotice = await within(card).findByText(
      "Waiting for Mastercard Data Connect. Finish there, then return to Chat.",
    );
    expect(waitingNotice).toBeVisible();

    preparedScenario.status = connectedBankingStatus();
    const account = await within(card).findByRole("checkbox", {
      name: /Operating account/u,
    });
    expect(account).toBeVisible();
  });
});

describe("with connected accounts awaiting a banking grant", () => {
  async function prepareScenario() {
    const sends: CapturedChatSend[] = [];
    const purpose = "Review recent cash-flow activity";
    const continuation = "Continue the banking review";
    let status = connectedBankingStatus();
    const savedRequests: {
      readonly accountIds: string[];
      readonly agentId: string;
      readonly duration: "1h" | "24h" | "7d" | "30d";
      readonly purpose: string;
    }[] = [];
    installActionConversation({
      lines: [
        "Banking access is needed for this task.",
        bankingActionUrl({ reason: purpose, callbackPrompt: continuation }),
      ],
      sends,
    });
    context.mocks.api(
      bankingUserContract.accessRequestStatus,
      ({ respond }) => {
        return respond(200, status);
      },
    );
    context.mocks.api(
      bankingUserContract.saveAgentGrant,
      ({ body, respond }) => {
        savedRequests.push(body);
        status = connectedBankingStatus({
          status: "active",
          accountIds: [...body.accountIds],
          purpose: body.purpose,
          expiresAt: "2026-08-08T10:00:00.000Z",
        });
        return respond(200, status);
      },
    );

    await setupPage({ context, host: "app.okou.ai", path: RUN_PATH });
    await readyChat();
    return { savedRequests, purpose, sends, continuation };
  }
  let preparedScenario: Awaited<ReturnType<typeof prepareScenario>>;
  beforeEach(async () => {
    preparedScenario = await prepareScenario();
  });
  it("grant connected banking access and continue", async () => {
    const { savedRequests, purpose, sends, continuation } = preparedScenario;
    const summary = await screen.findByTestId("banking-action-card");
    click(getButton("View details", summary));
    const card = await screen.findByRole("dialog", {
      name: "Banking access request",
    });
    const account = await within(card).findByRole("checkbox", {
      name: /Operating account/u,
    });
    await userEvent.setup({ delay: null }).click(account);
    await waitFor(() => {
      expect(
        within(card).getByRole("checkbox", { name: /Operating account/u }),
      ).toBeChecked();
    });
    expect(
      within(card).getByRole("combobox", { name: "Access duration" }),
    ).toHaveTextContent("7 days");
    click(getButton("Grant access", card));

    const activeAccess = await within(card).findByText(
      "Access active for 1 account",
    );
    expect(activeAccess).toBeVisible();
    expect(savedRequests).toStrictEqual([
      {
        accountIds: [BANK_ACCOUNT_ID],
        agentId: CAPABILITY_AGENT_ID,
        duration: "7d",
        purpose,
      },
    ]);
    click(getButton("Continue", card));
    await waitFor(() => {
      expect(sentPrompts(sends)).toStrictEqual([continuation]);
    });
  });
});

describe("with an active banking grant", () => {
  async function prepareScenario() {
    const sends: CapturedChatSend[] = [];
    const purpose = "Review recent cash-flow activity";
    const continuation = "Continue the banking review";
    let status = connectedBankingStatus({
      status: "active",
      accountIds: [BANK_ACCOUNT_ID],
      purpose,
      expiresAt: "2026-08-08T10:00:00.000Z",
    });
    let revokeCount = 0;
    installActionConversation({
      lines: [
        "Banking access is needed for this task.",
        bankingActionUrl({ reason: purpose, callbackPrompt: continuation }),
      ],
      sends,
    });
    context.mocks.api(
      bankingUserContract.accessRequestStatus,
      ({ respond }) => {
        return respond(200, status);
      },
    );
    context.mocks.api(bankingUserContract.revokeAgentGrant, ({ respond }) => {
      revokeCount += 1;
      status = connectedBankingStatus(null);
      return respond(200, status);
    });

    await setupPage({ context, host: "app.okou.ai", path: RUN_PATH });
    await readyChat();
    return {
      sends,
      continuation,
      get revokeCount() {
        return revokeCount;
      },
      set revokeCount(next: typeof revokeCount) {
        revokeCount = next;
      },
    };
  }
  let preparedScenario: Awaited<ReturnType<typeof prepareScenario>>;
  beforeEach(async () => {
    preparedScenario = await prepareScenario();
  });
  it("revoke active banking access after continuing the conversation", async () => {
    const { sends, continuation } = preparedScenario;
    const summary = await screen.findByTestId("banking-action-card");
    click(getButton("View details", summary));
    const card = await screen.findByRole("dialog", {
      name: "Banking access request",
    });
    const activeAccess = await within(card).findByText(
      "Access active for 1 account",
    );
    expect(activeAccess).toBeVisible();
    click(getButton("Continue", card));
    await waitFor(() => {
      expect(sentPrompts(sends)).toStrictEqual([continuation]);
    });

    click(getButton("Revoke", card));
    expect(
      within(card).getByText("Revoke this Agent's banking access?"),
    ).toBeVisible();
    click(getButton("Revoke", card));

    const accountSelection = await within(card).findByText("Select accounts");
    expect(accountSelection).toBeVisible();
    expect(preparedScenario.revokeCount).toBe(1);
    expect(within(card).getByRole("checkbox")).not.toBeChecked();
    expect(getButton("Grant access", card)).toBeDisabled();
  });
});

test.each(["connected", "reconnect-required", "incomplete"] as const)(
  "Read a canonical custom default only on action activation (%s)",
  async (status) => {
    const sends: CapturedChatSend[] = [];
    const authorizationUpdates: AgentCustomConnectorGrant[][] = [];
    const connector = customConnector({
      slug: "_workspace-search",
      displayName: "Workspace Search",
      connected: true,
      kind: "mcp",
    });
    installCustomConnectorApi({
      connector: () => {
        return connector;
      },
      authorizationUpdates,
    });
    const {
      connected: _connected,
      connectedAccountId: _connectedAccountId,
      connectedAccountUpdatedAt: _connectedAccountUpdatedAt,
      missingRequiredFields: _missingRequiredFields,
      configuredFieldKeys: _configuredFieldKeys,
      ...definition
    } = connector;
    context.mocks.api(customConnectorsReaderContract.list, ({ respond }) => {
      return respond(200, { connectors: [definition] });
    });
    let accountReads = 0;
    context.mocks.api(
      connectorAccountsContract.connections,
      ({ query, respond }) => {
        accountReads += 1;
        expect(query).toMatchObject({
          kind: "custom",
          customConnectorId: connector.id,
        });
        const account = customConnectorAccount(connector.id, {
          connectionStatus:
            status === "reconnect-required" ? status : "connected",
          setupStatus: status === "incomplete" ? status : "complete",
        });
        return respond(200, {
          connections: [account],
          defaultConnection: account,
          nextCursor: null,
        });
      },
    );
    installActionConversation({
      lines: [
        connectorActionUrl({
          slug: "_workspace-search",
          callbackPrompt: "Resume workspace search",
        }),
      ],
      sends,
    });
    await setupPage({ context, host: "app.okou.ai", path: RUN_PATH });
    await readyChat();
    const card = await screen.findByTestId("connector-action-card");
    await waitFor(() => {
      expect(getButton("Connect", card)).toBeEnabled();
    });
    expect(accountReads).toBe(0);
    click(getButton("Connect", card));
    if (status === "connected") {
      await waitFor(() => {
        return getButton("Authorized", card);
      });
    } else {
      await screen.findByRole("dialog", { name: "Connect Workspace Search" });
    }
    await waitFor(() => {
      expect(sentPrompts(sends)).toStrictEqual(
        status === "connected" ? ["Resume workspace search"] : [],
      );
      expect(authorizationUpdates).toHaveLength(status === "connected" ? 1 : 0);
      expect(
        queryControl("button", "Authorized", card)?.matches(":disabled") ??
          false,
      ).toBe(status === "connected");
    });
    expect(screen.queryAllByRole("dialog")).toHaveLength(
      status === "connected" ? 0 : 1,
    );
    expect(accountReads).toBeGreaterThan(0);
  },
);

async function attemptCustomMcpConnection(
  hasSavedAccount: boolean,
  complete: boolean,
  canonicalDefinition = false,
) {
  const sends: CapturedChatSend[] = [];
  const submittedAccounts: ConnectorAccountMutationIntent[] = [];
  const authorizationUpdates: AgentCustomConnectorGrant[][] = [];
  let connected = false;
  const connector = () => {
    return customConnector({
      slug: "_workspace-search",
      displayName: "Workspace Search",
      connected,
      kind: "mcp",
    });
  };
  installCustomConnectorApi({ connector, authorizationUpdates });
  if (canonicalDefinition) {
    context.mocks.api(customConnectorsReaderContract.list, ({ respond }) => {
      const {
        connected: _connected,
        connectedAccountId: _connectedAccountId,
        connectedAccountUpdatedAt: _connectedAccountUpdatedAt,
        missingRequiredFields: _missingRequiredFields,
        configuredFieldKeys: _configuredFieldKeys,
        ...definition
      } = connector();
      return respond(200, { connectors: [definition] });
    });
  }
  const account = customConnectorAccount(CUSTOM_CONNECTOR_ID, {
    id: CONNECTOR_CONNECTION_ID,
    connectionStatus: "reconnect-required",
    reconnectReason: "authorization_expired_or_revoked",
  });
  context.mocks.api(connectorAccountsContract.connections, ({ respond }) => {
    const current =
      hasSavedAccount || connected
        ? {
            ...account,
            connectionStatus: connected
              ? ("connected" as const)
              : ("reconnect-required" as const),
            reconnectReason: connected ? null : account.reconnectReason,
          }
        : null;
    return respond(200, {
      connections: current ? [current] : [],
      defaultConnection: current,
      nextCursor: null,
    });
  });
  context.mocks.api(customConnectorValuesContract.set, ({ body, respond }) => {
    submittedAccounts.push(body.account);
    expect(body.values).toStrictEqual([
      { key: "apiSecret", kind: "secret", value: "secret-value" },
    ]);
    connected = complete;
    return respond(200, connector());
  });
  installActionConversation({
    lines: [
      connectorActionUrl({
        slug: "_workspace-search",
        callbackPrompt: "Resume workspace search",
      }),
    ],
    sends,
  });
  await setupPage({ context, host: "app.okou.ai", path: RUN_PATH });
  await readyChat();
  const card = await screen.findByTestId("connector-action-card");
  click(getButton("Connect", card));
  const dialog = await screen.findByRole("dialog", {
    name: "Connect Workspace Search",
  });
  await fill(within(dialog).getByLabelText("API secret"), "secret-value");
  click(getButton("Save", dialog));
  await waitFor(() => {
    expect(submittedAccounts).toStrictEqual([
      hasSavedAccount
        ? { intent: "reconnect", connectionId: account.id }
        : { intent: "add" },
    ]);
  });
  return { card, dialog, sends, authorizationUpdates };
}

test.each([false, true])(
  "Connect or reconnect a custom MCP default before resuming (%s)",
  async (hasSavedAccount) => {
    const { card, sends, authorizationUpdates } =
      await attemptCustomMcpConnection(hasSavedAccount, true);
    await waitFor(() => {
      expect(getButton("Authorized", card)).toBeDisabled();
    });
    expect(authorizationUpdates).toStrictEqual([
      [{ customConnectorId: CUSTOM_CONNECTOR_ID, permissionNames: [] }],
    ]);
    expect(screen.queryByText("Permissions")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(sentPrompts(sends)).toStrictEqual(["Resume workspace search"]);
    });
  },
);

test("A real custom connection completes its canonical action card and continues once", async () => {
  const { card, sends, authorizationUpdates } =
    await attemptCustomMcpConnection(false, true, true);
  await waitFor(() => {
    expect(getButton("Authorized", card)).toBeDisabled();
    expect(sentPrompts(sends)).toStrictEqual(["Resume workspace search"]);
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(authorizationUpdates).toStrictEqual([
    [{ customConnectorId: CUSTOM_CONNECTOR_ID, permissionNames: [] }],
  ]);
});

test("Keep an incomplete custom MCP reconnect unauthorized without resuming", async () => {
  const { dialog, sends, authorizationUpdates } =
    await attemptCustomMcpConnection(true, false);
  await waitFor(() => {
    expect(getButton("Save", dialog)).toBeEnabled();
  });
  expect(authorizationUpdates).toStrictEqual([]);
  expect(sentPrompts(sends)).toStrictEqual([]);
  expect(dialog).toBeInTheDocument();
});

test("Connect a single available connector without an unnecessary chooser", async () => {
  const completedAttempts = mockOAuthCompletions(context);
  const oauthAttemptId = crypto.randomUUID();
  const sends: CapturedChatSend[] = [];
  const slug = "drive-demo";
  const method = browserAuthMethod();
  let connected = false;
  const popup = mockOpenedWindow();
  const item = () => {
    return catalogConnector({
      slug,
      label: "Drive Demo",
      method,
      connected,
    });
  };
  installCatalogLookup((requestedSlug) => {
    return requestedSlug === slug ? item() : null;
  });
  context.mocks.data.connectors([]);
  context.mocks.api(builtinConnectorOauthStartContract.start, ({ respond }) => {
    return respond(200, {
      authorizationUrl: "https://provider.example.test/authorize-drive",
      oauthAttemptId,
      connectionId: CONNECTOR_CONNECTION_ID,
    });
  });
  context.mocks.api(userBuiltinConnectorsContract.get, ({ respond }) => {
    return respond(200, { enabledConnectorSlugs: [slug] });
  });
  mockConnectorAgentAccess(context, () => {
    return { enabledConnectorSlugs: [slug] };
  });
  installActionConversation({
    lines: [
      connectorActionUrl({
        slug,
        callbackPrompt: "Resume after Drive authorization",
      }),
    ],
    sends,
  });

  await setupPage({ context, host: "app.okou.ai", path: RUN_PATH });

  await readyChat();
  const card = await screen.findByTestId("connector-action-card");
  click(getButton("Connect", card));
  await waitFor(() => {
    expect(popup.navigations).toContain(
      "https://provider.example.test/authorize-drive",
    );
  });
  expect(
    screen.getByRole("dialog", { name: "Connecting your account" }),
  ).toBeVisible();

  connected = true;
  context.mocks.data.connectors([
    connectedConnectorResponse({ slug, authMethod: method.id }),
  ]);
  completedAttempts.set(oauthAttemptId, CONNECTOR_CONNECTION_ID);
  popup.openedWindow.close();
  await waitFor(() => {
    expect(sentPrompts(sends)).toStrictEqual([
      "Resume after Drive authorization",
    ]);
  });
});

test("Authorize a healthy canonical builtin only after reading its target default", async () => {
  const sends: CapturedChatSend[] = [];
  const slug = "canonical-drive";
  const item = catalogConnector({
    slug,
    label: "Canonical Drive",
    method: browserAuthMethod(),
    connected: true,
  });
  const {
    connected: _connected,
    connection: _connection,
    connectionStatus: _connectionStatus,
    scopeMismatch: _scopeMismatch,
    authMethodSupportsRefresh: _authMethodSupportsRefresh,
    tokenExpiresAt: _tokenExpiresAt,
    ...definition
  } = item;
  context.mocks.api(connectorCatalogReaderContract.get, ({ respond }) => {
    return respond(200, { connector: definition });
  });
  let accountReads = 0;
  context.mocks.api(
    connectorAccountsContract.connections,
    ({ query, respond }) => {
      accountReads += 1;
      expect(query).toMatchObject({
        kind: "builtin",
        connectorSlug: slug,
        includeScopeMismatch: "true",
      });
      const { slug: _slug, ...connection } = connectedConnectorResponse({
        slug,
        authMethod: "oauth",
      });
      const account = {
        ...connection,
        id: CONNECTOR_CONNECTION_ID,
        target: { kind: "builtin" as const, connectorSlug: slug },
        displayName: null,
        isDefault: true,
        setupStatus: "complete" as const,
        scopeMismatch: false,
        missingRequiredFields: [],
        configuredFieldKeys: [],
      };
      return respond(200, {
        connections: [account],
        defaultConnection: account,
        nextCursor: null,
      });
    },
  );
  let authorized = false;
  context.mocks.api(userBuiltinConnectorsContract.get, ({ respond }) => {
    return respond(200, { enabledConnectorSlugs: authorized ? [slug] : [] });
  });
  context.mocks.api(
    userBuiltinConnectorsContract.update,
    ({ body, respond }) => {
      expect(body.enabledConnectorSlugs).toStrictEqual([slug]);
      authorized = true;
      return respond(200, { enabledConnectorSlugs: [slug] });
    },
  );
  mockConnectorAgentAccess(context, () => {
    return { enabledConnectorSlugs: authorized ? [slug] : [] };
  });
  installActionConversation({
    lines: [
      connectorActionUrl({ slug, callbackPrompt: "Resume canonical drive" }),
    ],
    sends,
  });
  await setupPage({ context, host: "app.okou.ai", path: RUN_PATH });
  await readyChat();
  const card = await screen.findByTestId("connector-action-card");
  await waitFor(() => {
    expect(getButton("Connect", card)).toBeEnabled();
  });
  expect(accountReads).toBe(0);
  click(getButton("Connect", card));
  await waitFor(() => {
    expect(authorized).toBeTruthy();
    expect(sentPrompts(sends)).toStrictEqual(["Resume canonical drive"]);
  });
  await waitFor(() => {
    expect(card).toHaveTextContent("Authorized");
  });
  expect(getButton("Authorized", card)).toBeDisabled();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(accountReads).toBe(1);
});

test.each(["current", "canonical"] as const)(
  "Enable a single no-auth connector from a %s definition without an unnecessary dialog",
  async (shape) => {
    const sends: CapturedChatSend[] = [];
    const slug = "public-data-demo";
    const method = noAuthMethod();
    let connected = false;
    const item = () => {
      return catalogConnector({
        slug,
        label: "Public Data Demo",
        method,
        connected,
      });
    };
    installCatalogLookup((requestedSlug) => {
      return requestedSlug === slug ? item() : null;
    });
    if (shape === "canonical") {
      context.mocks.api(connectorCatalogReaderContract.get, ({ respond }) => {
        const {
          connected: _connected,
          connection: _connection,
          connectionStatus: _connectionStatus,
          scopeMismatch: _scopeMismatch,
          authMethodSupportsRefresh: _authMethodSupportsRefresh,
          tokenExpiresAt: _tokenExpiresAt,
          ...definition
        } = item();
        return respond(200, { connector: definition });
      });
    }
    context.mocks.api(
      builtinConnectorNoAuthGrantContract.connect,
      ({ respond }) => {
        connected = true;
        return respond(
          200,
          connectedConnectorResponse({ slug, authMethod: method.id }),
        );
      },
    );
    installActionConversation({
      lines: [
        connectorActionUrl({
          slug,
          callbackPrompt: "Resume with public data",
        }),
      ],
      sends,
    });

    await setupPage({ context, host: "app.okou.ai", path: RUN_PATH });

    await readyChat();
    const card = await screen.findByTestId("connector-action-card");
    click(getButton("Connect", card));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(sentPrompts(sends)).toStrictEqual(["Resume with public data"]);
    });
  },
);

test("Require an explicit permission selection for a custom connector", async () => {
  const sends: CapturedChatSend[] = [];
  let connected = false;
  const connector = () => {
    return customConnector({
      slug: "_permissioned-search",
      displayName: "Permissioned Search",
      connected,
      permissionBundleRef: "builtin:permissioned-search@1",
      kind: "http",
    });
  };
  installCustomConnectorApi({ connector });
  context.mocks.api(customConnectorValuesContract.set, ({ respond }) => {
    connected = true;
    return respond(200, connector());
  });
  installActionConversation({
    lines: [
      connectorActionUrl({
        slug: "_permissioned-search",
        callbackPrompt: "Resume permissioned search",
      }),
    ],
    sends,
  });

  await setupPage({ context, host: "app.okou.ai", path: RUN_PATH });

  await readyChat();
  const card = await screen.findByTestId("connector-action-card");
  click(getButton("Connect", card));
  await fill(await screen.findByLabelText("API secret"), "permission-secret");
  click(getButton("Save"));
  const authorize = await waitFor(() => {
    return getButton("Authorize", card);
  });
  click(authorize);

  await waitFor(() => {
    expect(getButton("Authorize", card)).toBeEnabled();
  });
  expect(sends).toHaveLength(0);
});

test("Preserve an existing custom connector permission during reconnection", async () => {
  const sends: CapturedChatSend[] = [];
  let connected = false;
  const existingGrant = {
    customConnectorId: CUSTOM_CONNECTOR_ID,
    permissionNames: ["documents.read"],
  } satisfies AgentCustomConnectorGrant;
  const connector = () => {
    return customConnector({
      slug: "_permissioned-documents",
      displayName: "Permissioned Documents",
      connected,
      permissionBundleRef: "builtin:permissioned-documents@1",
      kind: "http",
    });
  };
  installCustomConnectorApi({ connector, grants: [existingGrant] });
  context.mocks.api(customConnectorValuesContract.set, ({ respond }) => {
    connected = true;
    return respond(200, connector());
  });
  installActionConversation({
    lines: [
      connectorActionUrl({
        slug: "_permissioned-documents",
        callbackPrompt: "Resume document lookup",
      }),
    ],
    sends,
  });

  await setupPage({ context, host: "app.okou.ai", path: RUN_PATH });

  await readyChat();
  const card = await screen.findByTestId("connector-action-card");
  click(getButton("Connect", card));
  await fill(await screen.findByLabelText("API secret"), "replacement-secret");
  click(getButton("Save"));

  await waitFor(() => {
    expect(getButton("Authorized", card)).toBeDisabled();
  });
  expect(sentPrompts(sends)).toStrictEqual(["Resume document lookup"]);
});

test("Reconnect an expired connector before resuming the task", async () => {
  const sends: CapturedChatSend[] = [];
  const slug = "expired-drive";
  const method = browserAuthMethod();
  const originalConnection = connectedConnectorResponse({
    slug,
    authMethod: method.id,
    reconnectRequired: true,
    updatedAt: "2026-08-01T09:00:00.000Z",
  });
  let restored = false;
  let completionReads = 0;
  const oauthAttemptId = crypto.randomUUID();
  context.mocks.api(
    connectorAccountsContract.oauthCompletion,
    ({ params, respond }) => {
      expect(params.attemptId).toBe(oauthAttemptId);
      completionReads += 1;
      return restored
        ? respond(200, { connectionId: CONNECTOR_CONNECTION_ID })
        : respond(404, {
            error: { code: "NOT_FOUND", message: "OAuth completion not found" },
          });
    },
  );
  const popup = mockOpenedWindow();
  installCatalogLookup((requestedSlug) => {
    return requestedSlug === slug
      ? catalogConnector({
          slug,
          label: "Expired Drive",
          method,
          connected: true,
          reconnectRequired: !restored,
          connectionId: CONNECTOR_CONNECTION_ID,
          tokenExpiresAt: restored ? null : "2026-07-01T00:00:00.000Z",
        })
      : null;
  });
  context.mocks.api(builtinConnectorOauthStartContract.start, ({ respond }) => {
    return respond(200, {
      authorizationUrl: "https://provider.example.test/reconnect-drive",
      oauthAttemptId,
      connectionId: CONNECTOR_CONNECTION_ID,
    });
  });
  context.mocks.api(builtinConnectorsMainContract.list, ({ respond }) => {
    return respond(200, {
      connectors: [
        restored
          ? connectedConnectorResponse({
              slug,
              authMethod: method.id,
              updatedAt: "2026-08-01T10:00:00.000Z",
            })
          : originalConnection,
      ],
      connectorProvidedBindings: [],
    });
  });
  context.mocks.api(userBuiltinConnectorsContract.get, ({ respond }) => {
    return respond(200, { enabledConnectorSlugs: [slug] });
  });
  mockConnectorAgentAccess(context, () => {
    return { enabledConnectorSlugs: [slug] };
  });
  installActionConversation({
    lines: [
      "Your Drive authorization expired. Reconnect it before I continue the report.",
      connectorActionUrl({
        slug,
        callbackPrompt: "Continue the report after reconnection",
      }),
    ],
    sends,
  });

  await setupPage({ context, host: "app.okou.ai", path: RUN_PATH });

  await readyChat();
  expect(
    screen.getByText(
      "Your Drive authorization expired. Reconnect it before I continue the report.",
    ),
  ).toBeVisible();
  const card = await screen.findByTestId("connector-action-card");
  click(getButton("Reconnect", card));
  await waitFor(() => {
    expect(popup.navigations).toContain(
      "https://provider.example.test/reconnect-drive",
    );
  });

  const callsBeforeEarlyReturn = completionReads;
  context.mocks.ably.trigger("connector:changed", { connectorSlug: slug });
  await waitFor(() => {
    expect(completionReads).toBeGreaterThan(callsBeforeEarlyReturn);
    expect(sends).toHaveLength(0);
  });

  restored = true;
  context.mocks.ably.trigger("connector:changed", { connectorSlug: slug });
  await waitFor(() => {
    expect(sentPrompts(sends)).toStrictEqual([
      "Continue the report after reconnection",
    ]);
  });
});
