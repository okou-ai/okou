import {
  httpConnectorFixture,
  mcpConnectorFixture,
} from "../../../mocks/handlers/connector-account-fixtures.ts";
import {
  agentCustomConnectorsContract,
  type AgentCustomConnectorGrant,
} from "@okouai/api-contracts/contracts/agent-custom-connectors";
import {
  connectorAccountsContract,
  type ConnectorAccountConnection,
  type ConnectorAccountMutationIntent,
} from "@okouai/api-contracts/contracts/connector-accounts";
import {
  type CreateCustomConnectorBody,
  type CustomConnectorOAuthConfig,
  type CustomConnectorResponse,
  type UpdateCustomConnectorBody,
  customConnectorByIdContract,
  customConnectorOAuth2Contract,
  customConnectorValuesContract,
  customConnectorsContract,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  chooseConnectorAuthentication,
  customConnector,
  customConnectorAccount,
  getConnectorAction,
  getConnectorCard,
  listAgent,
  mcpCustomConnector,
  mockOAuthCompletions,
  mockSavedConnectorAccounts,
  queryConnectorAction,
  queryConnectorCard,
} from "./connector-page-test-helpers.ts";

const context = testContext();

const OAUTH_CONFIG = {
  providerAdapter: "standard",
  clientId: "acme-client",
  authorizationUrl: "https://acme.test/oauth/authorize",
  tokenUrl: "https://acme.test/oauth/token",
  tokenEndpointAuthMethod: "client_secret_post",
  pkceMethod: "S256",
  scopes: ["search.read", "search.write"],
  authorizationParams: {},
} as const satisfies CustomConnectorOAuthConfig;

const OAUTH_HEADER = {
  name: "Authorization",
  valueTemplate: "Bearer {{oauth.access_token}}",
} as const;

interface ConnectorStore {
  connectors: CustomConnectorResponse[];
  accounts: ConnectorAccountConnection[];
  readonly creates: CreateCustomConnectorBody[];
  readonly updates: UpdateCustomConnectorBody[];
  readonly grants: AgentCustomConnectorGrant[][];
}

function definitionFor(
  base: Record<string, unknown>,
  kind: CustomConnectorResponse["kind"],
): CustomConnectorResponse {
  return kind === "mcp"
    ? mcpConnectorFixture({ ...base, kind: "mcp" })
    : httpConnectorFixture({ ...base, kind: "http" });
}

function publicOAuthConfig(
  config: CreateCustomConnectorBody["oauthConfig"],
): Record<string, unknown> {
  if (!config) {
    return {};
  }
  const { clientSecret: _clientSecret, ...oauthConfig } = config;
  return { oauthConfig };
}

/** Admin org whose custom connector API keeps definitions and accounts. */
function mockConnectorStore(
  initial: {
    readonly connectors?: readonly CustomConnectorResponse[];
    readonly accounts?: readonly ConnectorAccountConnection[];
  } = {},
): ConnectorStore {
  context.mocks.data.org({ id: "org_1", name: "Test Org", role: "admin" });
  context.mocks.data.agents([
    listAgent("research-agent", "Research"),
    listAgent("support-agent", "Support"),
  ]);
  const store: ConnectorStore = {
    connectors: [...(initial.connectors ?? [])],
    accounts: [...(initial.accounts ?? [])],
    creates: [],
    updates: [],
    grants: [],
  };
  const find = (id: string): CustomConnectorResponse => {
    const connector = store.connectors.find((candidate) => {
      return candidate.id === id;
    });
    if (!connector) {
      throw new Error(`Expected custom connector ${id}`);
    }
    return connector;
  };
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: store.connectors });
  });
  mockSavedConnectorAccounts(context, () => {
    return store.accounts;
  });
  context.mocks.api(
    connectorAccountsContract.connection,
    ({ params, respond }) => {
      const account = store.accounts.find((candidate) => {
        return candidate.id === params.connectionId;
      });
      return account
        ? respond(200, account)
        : respond(404, {
            error: { code: "NOT_FOUND", message: "Account not found" },
          });
    },
  );
  context.mocks.api(customConnectorsContract.create, ({ body, respond }) => {
    store.creates.push(body);
    const created = definitionFor(
      {
        ...body,
        id: crypto.randomUUID(),
        slug: `_${body.displayName.toLowerCase().replaceAll(" ", "-")}`,
        ...(body.kind === "mcp"
          ? { prefixTemplates: [], permissionBundleRef: null }
          : {}),
        ...publicOAuthConfig(body.oauthConfig),
        createdAt: "2026-02-01T00:00:00Z",
        updatedAt: "2026-02-01T00:00:00Z",
      },
      body.kind === "mcp" ? "mcp" : "http",
    );
    store.connectors = [...store.connectors, created];
    return respond(201, created);
  });
  context.mocks.api(
    customConnectorValuesContract.set,
    ({ params, body, respond }) => {
      const connector = find(params.id);
      const connectionId =
        body.account.intent === "reconnect"
          ? body.account.connectionId
          : crypto.randomUUID();
      const account = customConnectorAccount(connector.id, {
        id: connectionId,
        isDefault: store.accounts.every((candidate) => {
          return candidate.target.kind !== "custom" ||
            candidate.target.customConnectorId !== connector.id
            ? true
            : candidate.id === connectionId;
        }),
        configuredFieldKeys: body.values.map((value) => {
          return value.key;
        }),
      });
      store.accounts = [
        ...store.accounts.filter((candidate) => {
          return candidate.id !== connectionId;
        }),
        account,
      ];
      return respond(200, { ...connector, connectionId });
    },
  );
  context.mocks.api(
    customConnectorByIdContract.update,
    ({ params, body, respond }) => {
      store.updates.push(body);
      const current = find(params.id);
      const updated = definitionFor(
        {
          ...current,
          ...body,
          ...(body.oauthConfig ? publicOAuthConfig(body.oauthConfig) : {}),
        },
        current.kind,
      );
      if (current.authMode === "oauth") {
        // Saved OAuth changes disconnect every OAuth account of the connector.
        store.accounts = store.accounts.filter((account) => {
          return (
            account.target.kind !== "custom" ||
            account.target.customConnectorId !== current.id
          );
        });
      }
      store.connectors = store.connectors.map((connector) => {
        return connector.id === current.id ? updated : connector;
      });
      return respond(200, updated);
    },
  );
  context.mocks.api(
    customConnectorByIdContract.delete,
    ({ params, respond }) => {
      store.connectors = store.connectors.filter((connector) => {
        return connector.id !== params.id;
      });
      return respond(204);
    },
  );
  context.mocks.api(
    agentCustomConnectorsContract.update,
    ({ body, respond }) => {
      store.grants.push(body.grants);
      return respond(200, { grants: body.grants });
    },
  );
  return store;
}

/** OAuth starts that open a provider window and complete on request. */
function mockConnectorAuthorization(store: ConnectorStore) {
  const completions = mockOAuthCompletions(context);
  const starts: ConnectorAccountMutationIntent[] = [];
  let attempt: {
    readonly attemptId: string;
    readonly connectorId: string;
    readonly account: ConnectorAccountMutationIntent;
  } | null = null;
  context.mocks.api(
    customConnectorOAuth2Contract.start,
    ({ params, body, respond }) => {
      starts.push(body.account);
      const attemptId = crypto.randomUUID();
      attempt = { attemptId, connectorId: params.id, account: body.account };
      return respond(200, {
        result: "authorization",
        oauthAttemptId: attemptId,
        authorizationUrl: "https://acme.test/oauth/authorize",
        ...(body.account.intent === "reconnect"
          ? { connectionId: body.account.connectionId }
          : {}),
      });
    },
  );
  return {
    starts,
    /** The provider redirects back with a connected account. */
    complete: (): string => {
      if (!attempt) {
        throw new Error("Expected an OAuth attempt");
      }
      const { attemptId, connectorId, account } = attempt;
      const connectionId =
        account.intent === "reconnect"
          ? account.connectionId
          : crypto.randomUUID();
      const existing = store.accounts.find((candidate) => {
        return candidate.id === connectionId;
      });
      store.accounts = [
        ...store.accounts.filter((candidate) => {
          return candidate.id !== connectionId;
        }),
        existing
          ? {
              ...existing,
              connectionStatus: "connected",
              reconnectReason: null,
            }
          : customConnectorAccount(connectorId, {
              id: connectionId,
              authMethod: "oauth",
            }),
      ];
      completions.set(attemptId, connectionId);
      return connectionId;
    },
  };
}

function findConnectorAction(
  role: "button" | "menuitem",
  name: string,
): Promise<HTMLElement> {
  return waitFor(() => {
    return getConnectorAction(role, name);
  });
}

function openProviderWindow(): Window {
  const authWindow = context.mocks.browser.authWindow();
  Object.defineProperty(authWindow, "location", {
    value: { href: "about:blank" },
    configurable: true,
  });
  context.mocks.browser.open(authWindow);
  return authWindow;
}

async function openCustomScope(): Promise<void> {
  await setupPage({ context, path: "/connectors?scope=custom" });
  await findConnectorAction("button", "New custom connector");
}

async function openCreateDialog(): Promise<HTMLElement> {
  click(await findConnectorAction("button", "New custom connector"));
  return await screen.findByRole("dialog", { name: "New custom connector" });
}

async function chooseConnectorType(
  dialog: HTMLElement,
  type: "HTTP API" | "MCP · Streamable HTTP",
): Promise<void> {
  click(within(dialog).getByRole("combobox", { name: "Connector type" }));
  click(await screen.findByRole("option", { name: type }));
}

async function chooseCardOption(
  label: string,
  option: "Edit" | "Delete",
): Promise<void> {
  const row = getConnectorCard(label).parentElement;
  if (!row) {
    throw new Error(`Expected ${label} card row`);
  }
  click(getConnectorAction("button", "More options", row));
  click(await findConnectorAction("menuitem", option));
}

function cardText(label: string): string {
  return getConnectorCard(label).textContent?.replace(/\s+/gu, " ") ?? "";
}

async function waitForCard(label: string, text: string): Promise<void> {
  await waitFor(() => {
    expect(cardText(label)).toContain(text);
  });
}

async function connectWithSecret(label: string, secret: string) {
  click(await findConnectorAction("button", `Connect ${label}`));
  const dialog = await screen.findByRole("dialog", {
    name: `Connect ${label}`,
  });
  await fill(within(dialog).getByLabelText("Secret"), secret);
  click(getConnectorAction("button", "Save", dialog));
  return dialog;
}

async function skipAccountName(connector: string): Promise<HTMLElement> {
  const naming = await screen.findByRole("dialog", {
    name: `Name your ${connector} account`,
  });
  const nameInput = within(naming).getByRole("textbox");
  click(getConnectorAction("button", "Skip", naming));
  await waitFor(() => {
    expect(naming).not.toBeInTheDocument();
  });
  return nameInput;
}

test("Do not complete or authorize an exact account when required configuration is incomplete", async () => {
  const connector = customConnector();
  const store = mockConnectorStore({ connectors: [connector] });
  const incomplete = customConnectorAccount(connector.id, {
    connectionStatus: "reconnect-required",
    reconnectReason: "configuration_incomplete",
    missingRequiredFields: ["secret"],
  });
  context.mocks.api(customConnectorValuesContract.set, ({ respond }) => {
    store.accounts = [incomplete];
    return respond(200, { ...connector, connectionId: incomplete.id });
  });
  await openCustomScope();

  const dialog = await connectWithSecret("Acme Search", "partial-secret");

  await expect(within(dialog).findByRole("alert")).resolves.toHaveTextContent(
    "This account needs additional setup. Review its connector settings and try again.",
  );
  expect(dialog).toBeInTheDocument();
  expect(
    screen.queryByRole("dialog", { name: "Name your Acme Search account" }),
  ).toBeNull();
  expect(store.grants).toStrictEqual([]);
});

test("Create a custom connector without authentication", async () => {
  const store = mockConnectorStore();
  await openCustomScope();
  const dialog = await openCreateDialog();
  await fill(within(dialog).getByLabelText("Display name"), "Open Status");
  await fill(
    within(dialog).getByLabelText(/^Prefixes/u),
    "https://status.acme.test/",
  );

  click(within(dialog).getByRole("combobox", { name: "Authentication" }));
  const options = await screen.findAllByRole("option");
  expect(
    options.map((option) => {
      return option.textContent;
    }),
  ).toStrictEqual([
    "No authentication",
    "API authentication",
    "Custom OAuth app",
  ]);
  click(screen.getByRole("option", { name: "Custom OAuth app" }));
  await fill(
    await within(dialog).findByLabelText("Authorization URL"),
    "https://status.acme.test/oauth/authorize",
  );
  await chooseConnectorAuthentication(dialog, "No authentication");
  await waitFor(() => {
    expect(within(dialog).queryByLabelText("Authorization URL")).toBeNull();
  });
  await chooseConnectorAuthentication(dialog, "Custom OAuth app");
  await expect(
    within(dialog).findByLabelText("Authorization URL"),
  ).resolves.toHaveValue("https://status.acme.test/oauth/authorize");
  await chooseConnectorAuthentication(dialog, "No authentication");
  await waitFor(() => {
    expect(within(dialog).queryByLabelText("Authorization URL")).toBeNull();
  });
  expect(within(dialog).queryByLabelText("Header name")).toBeNull();
  expect(getConnectorAction("button", "Create", dialog)).toBeEnabled();
  click(getConnectorAction("button", "Create", dialog));

  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
  await waitForCard("Open Status", "https://status.acme.test/");
  expect(store.creates).toMatchObject([
    {
      displayName: "Open Status",
      authMode: "none",
      fields: [],
      headerInjections: [],
      queryInjections: [],
      prefixTemplates: ["https://status.acme.test/"],
    },
  ]);
});

test("Manage a custom HTTP connector through creation and connection", async () => {
  const store = mockConnectorStore();
  await openCustomScope();
  const dialog = await openCreateDialog();
  await fill(within(dialog).getByLabelText("Display name"), "Acme API");
  await fill(
    within(dialog).getByLabelText(/^Prefixes/u),
    "https://api.acme.test/v1/",
  );
  await chooseConnectorAuthentication(dialog, "API authentication");
  expect(within(dialog).getByLabelText("Header name")).toHaveValue(
    "Authorization",
  );
  click(getConnectorAction("button", "Create", dialog));
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });

  await waitForCard("Acme API", "HTTP API·https://api.acme.test/v1/");
  await waitForCard("Acme API", "No accounts");
  expect(store.creates).toMatchObject([
    {
      displayName: "Acme API",
      authMode: "manual",
      prefixTemplates: ["https://api.acme.test/v1/"],
      headerInjections: [
        { name: "Authorization", valueTemplate: "Bearer {{secrets.secret}}" },
      ],
    },
  ]);

  const connect = await connectWithSecret("Acme API", "acme-secret");
  await skipAccountName("Acme API");
  expect(connect).not.toBeInTheDocument();
  await waitForCard("Acme API", "Connected");
});

test("Manage a custom HTTP connector through rename and deletion", async () => {
  const connector = customConnector({
    displayName: "Acme API",
    prefixTemplates: ["https://api.acme.test/v1/"],
  });
  const store = mockConnectorStore({
    connectors: [connector],
    accounts: [customConnectorAccount(connector.id)],
  });
  await openCustomScope();
  await waitForCard("Acme API", "Connected");

  await chooseCardOption("Acme API", "Edit");
  const edit = await screen.findByRole("dialog", {
    name: "Edit custom connector",
  });
  await fill(within(edit).getByLabelText("Display name"), "Acme Billing API");
  click(getConnectorAction("button", "Save", edit));
  await waitFor(() => {
    expect(edit).not.toBeInTheDocument();
  });
  await waitForCard("Acme Billing API", "Connected");
  expect(cardText("Acme Billing API")).toContain("https://api.acme.test/v1/");
  expect(store.updates).toMatchObject([{ displayName: "Acme Billing API" }]);

  await chooseCardOption("Acme Billing API", "Delete");
  const confirm = await screen.findByRole("dialog", {
    name: "Delete Acme Billing API?",
  });
  click(getConnectorAction("button", "Delete", confirm));

  await expect(
    screen.findByText(
      "Add an HTTP API or MCP server for your organization to use.",
    ),
  ).resolves.toBeInTheDocument();
  expect(queryConnectorCard("Acme Billing API")).toBeNull();
});

test("Edit a custom HTTP connector without losing advanced configuration", async () => {
  const connector = customConnector({
    headerInjections: [],
    queryInjections: [{ name: "api_key", valueTemplate: "{{secrets.secret}}" }],
  });
  const store = mockConnectorStore({ connectors: [connector] });
  await openCustomScope();
  await waitForCard("Acme Search", "No accounts");

  await chooseCardOption("Acme Search", "Edit");
  const edit = await screen.findByRole("dialog", {
    name: "Edit custom connector",
  });
  expect(
    within(edit).getByText(
      "Advanced API fields and injections are preserved when you save.",
    ),
  ).toBeInTheDocument();
  click(getConnectorAction("button", "Save", edit));

  await waitFor(() => {
    expect(edit).not.toBeInTheDocument();
  });
  expect(store.updates).toMatchObject([
    {
      prefixTemplates: ["https://api.acme.test/v1/"],
      headerInjections: [],
      queryInjections: [
        { name: "api_key", valueTemplate: "{{secrets.secret}}" },
      ],
    },
  ]);
});

test("Do not grant access after an unsuccessful custom connection", async () => {
  const connector = customConnector({ displayName: "Acme Incomplete" });
  const store = mockConnectorStore({ connectors: [connector] });
  const incomplete = customConnectorAccount(connector.id, {
    connectionStatus: "reconnect-required",
    reconnectReason: "configuration_incomplete",
    missingRequiredFields: ["secret"],
  });
  let writable = false;
  context.mocks.api(customConnectorValuesContract.set, ({ respond }) => {
    if (!writable) {
      return respond(500, {
        error: { code: "INTERNAL_SERVER_ERROR", message: "Write unavailable" },
      });
    }
    store.accounts = [incomplete];
    return respond(200, { ...connector, connectionId: incomplete.id });
  });
  await openCustomScope();

  const dialog = await connectWithSecret("Acme Incomplete", "first-secret");
  await expect(within(dialog).findByRole("alert")).resolves.toHaveTextContent(
    "Write unavailable",
  );
  expect(dialog).toBeInTheDocument();

  writable = true;
  click(getConnectorAction("button", "Save", dialog));
  await waitFor(() => {
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "This account needs additional setup. Review its connector settings and try again.",
    );
  });
  expect(store.grants).toStrictEqual([]);
});

test("Manage a custom connector before it is connected", async () => {
  mockConnectorStore({ connectors: [customConnector()] });
  await openCustomScope();
  await waitForCard("Acme Search", "No accounts");

  expect(cardText("Acme Search")).toContain(
    "HTTP API·https://api.acme.test/v1/",
  );
  expect(getConnectorAction("button", "Connect Acme Search")).toBeEnabled();
  expect(
    queryConnectorAction("button", "Manage Acme Search accounts"),
  ).toBeNull();
  expect(
    queryAllByRoleFast("button", getConnectorCard("Acme Search")).map(
      (button) => {
        return button.getAttribute("aria-label");
      },
    ),
  ).toStrictEqual(["Connect Acme Search"]);

  const row = getConnectorCard("Acme Search").parentElement;
  if (!row) {
    throw new Error("Expected Acme Search card row");
  }
  click(getConnectorAction("button", "More options", row));
  const menu = await screen.findByRole("menu");
  expect(
    queryAllByRoleFast("menuitem", menu).map((item) => {
      return item.textContent;
    }),
  ).toStrictEqual(["Edit", "Delete"]);
});

test("Manage custom HTTP OAuth through configuration update and connection", async () => {
  const connector = customConnector({
    authMode: "oauth",
    fields: [],
    headerInjections: [OAUTH_HEADER],
    oauthConfig: OAUTH_CONFIG,
  });
  const store = mockConnectorStore({
    connectors: [connector],
    accounts: [customConnectorAccount(connector.id, { authMethod: "oauth" })],
  });
  const authorization = mockConnectorAuthorization(store);
  await openCustomScope();
  await waitForCard("Acme Search", "Connected");

  await chooseCardOption("Acme Search", "Edit");
  const edit = await screen.findByRole("dialog", {
    name: "Edit custom connector",
  });
  await fill(
    within(edit).getByLabelText(/^Prefixes/u),
    "https://api.acme.test/v2/",
  );
  await fill(
    within(edit).getByLabelText(/^Scopes/u),
    "search.read\ncalendar.write",
  );
  click(getConnectorAction("button", "Save", edit));
  const confirm = await screen.findByRole("dialog", {
    name: "Disconnect existing OAuth connections?",
  });
  expect(confirm).toHaveTextContent(
    "These OAuth changes will disconnect every member currently connected with OAuth.",
  );
  expect(store.updates).toStrictEqual([]);
  click(getConnectorAction("button", "Save and disconnect", confirm));

  await waitFor(() => {
    expect(edit).not.toBeInTheDocument();
  });
  await waitForCard("Acme Search", "https://api.acme.test/v2/");
  expect(store.updates).toMatchObject([
    {
      prefixTemplates: ["https://api.acme.test/v2/"],
      oauthConfig: { scopes: ["search.read", "calendar.write"] },
    },
  ]);
  expect(store.updates[0]?.oauthConfig).not.toHaveProperty("clientSecret");

  const authWindow = openProviderWindow();
  await waitForCard("Acme Search", "No accounts");
  click(getConnectorAction("button", "Connect Acme Search"));
  await waitFor(() => {
    expect(authWindow.location.href).toBe("https://acme.test/oauth/authorize");
  });
  authorization.complete();
  authWindow.close();
  await skipAccountName("Acme Search");
  await waitForCard("Acme Search", "Connected");
});

test("Manage a manual MCP connector through its lifecycle", async () => {
  const store = mockConnectorStore();
  await openCustomScope();
  const dialog = await openCreateDialog();
  await chooseConnectorType(dialog, "MCP · Streamable HTTP");
  await chooseConnectorAuthentication(dialog, "API authentication");
  await fill(within(dialog).getByLabelText("Display name"), "Acme MCP");
  await fill(
    within(dialog).getByLabelText(/^MCP endpoint/u),
    "https://mcp.acme.test/server",
  );
  click(getConnectorAction("button", "Create", dialog));
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
  await waitForCard("Acme MCP", "MCP·https://mcp.acme.test/server");
  await waitForCard("Acme MCP", "No accounts");

  await connectWithSecret("Acme MCP", "mcp-secret");
  await skipAccountName("Acme MCP");
  await waitForCard("Acme MCP", "Connected");

  await chooseCardOption("Acme MCP", "Edit");
  const edit = await screen.findByRole("dialog", {
    name: "Edit custom connector",
  });
  await fill(within(edit).getByLabelText("Display name"), "Acme MCP v2");
  await fill(
    within(edit).getByLabelText(/^MCP endpoint/u),
    "https://mcp.acme.test/v2",
  );
  click(getConnectorAction("button", "Save", edit));
  await waitFor(() => {
    expect(edit).not.toBeInTheDocument();
  });

  await waitForCard("Acme MCP v2", "MCP·https://mcp.acme.test/v2");
  expect(store.updates).toMatchObject([
    {
      kind: "mcp",
      displayName: "Acme MCP v2",
      endpoint: "https://mcp.acme.test/v2",
      fields: [{ key: "secret", kind: "secret", required: true }],
      headerInjections: [
        { name: "Authorization", valueTemplate: "Bearer {{secrets.secret}}" },
      ],
    },
  ]);
});

test("Create and connect an MCP server through automatic authorization", async () => {
  const store = mockConnectorStore();
  await openCustomScope();
  const dialog = await openCreateDialog();
  await chooseConnectorType(dialog, "MCP · Streamable HTTP");
  const authentication = within(dialog).getByRole("combobox", {
    name: "Authentication",
  });
  expect(authentication).toHaveTextContent("Automatic");
  expect(dialog).toHaveTextContent(
    "(Recommended) Let Okou discover whether this MCP server uses no authentication or OAuth.",
  );
  await chooseConnectorType(dialog, "HTTP API");
  await waitFor(() => {
    expect(authentication).toHaveTextContent("Select authentication");
  });
  await chooseConnectorType(dialog, "MCP · Streamable HTTP");
  await waitFor(() => {
    expect(authentication).toHaveTextContent("Automatic");
  });
  await fill(within(dialog).getByLabelText("Display name"), "Discovery MCP");
  await fill(
    within(dialog).getByLabelText(/^MCP endpoint/u),
    "https://discovery.acme.test/mcp",
  );
  click(getConnectorAction("button", "Create", dialog));
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
  expect(store.creates).toMatchObject([
    {
      kind: "mcp",
      authMode: "automatic",
      endpoint: "https://discovery.acme.test/mcp",
      fields: [],
      headerInjections: [],
      queryInjections: [],
    },
  ]);
  await waitForCard("Discovery MCP", "No accounts");

  const created = store.connectors[0];
  if (!created) {
    throw new Error("Expected the created connector");
  }
  context.mocks.api(customConnectorOAuth2Contract.start, ({ respond }) => {
    const account = customConnectorAccount(created.id, {
      authMethod: "automatic",
    });
    store.accounts = [account];
    return respond(200, {
      result: "connected",
      connector: created,
      connectionId: account.id,
    });
  });
  const authWindow = openProviderWindow();
  click(getConnectorAction("button", "Connect Discovery MCP"));

  await skipAccountName("Discovery MCP");
  expect(authWindow.closed).toBeTruthy();
  await waitForCard("Discovery MCP", "Connected");
});

test("Keep saved custom accounts manageable when only the default needs reconnect", async () => {
  const acme = mcpCustomConnector({
    authMode: "oauth",
    fields: [],
    headerInjections: [OAUTH_HEADER],
    oauthConfig: OAUTH_CONFIG,
  });
  const empty = mcpCustomConnector({
    id: "55555555-5555-4555-8555-555555555555",
    slug: "_empty-mcp",
    displayName: "Empty MCP",
    endpoint: "https://mcp.empty.test/server",
  });
  mockConnectorStore({
    connectors: [acme, empty],
    accounts: [
      customConnectorAccount(acme.id, {
        authMethod: "oauth",
        displayName: "Original default",
        connectionStatus: "reconnect-required",
        reconnectReason: "authorization_expired_or_revoked",
      }),
      customConnectorAccount(acme.id, {
        authMethod: "oauth",
        displayName: "Work",
        isDefault: false,
      }),
      customConnectorAccount(acme.id, {
        authMethod: "oauth",
        displayName: "Personal",
        isDefault: false,
      }),
    ],
  });
  await openCustomScope();
  await waitForCard("Acme MCP", "Connected");
  await waitForCard("Empty MCP", "No accounts");
  expect(getConnectorAction("button", "Connect Empty MCP")).toBeEnabled();

  click(screen.getByTestId("connectors-scope-connected"));
  await waitFor(() => {
    expect(queryConnectorCard("Empty MCP")).toBeNull();
  });
  await waitForCard("Acme MCP", "Connected");

  click(getConnectorAction("button", "Manage Acme MCP accounts"));
  const manager = await screen.findByRole("dialog", {
    name: "Manage Acme MCP accounts",
  });
  const original = await within(manager).findByRole("group", {
    name: "Original default",
  });
  expect(original).toHaveTextContent("Reconnect required");
  expect(getConnectorAction("button", "Reconnect", original)).toBeEnabled();
  expect(
    within(manager).getByRole("group", { name: "Work" }),
  ).toHaveTextContent("Connected");
  expect(
    within(manager).getByRole("group", { name: "Personal" }),
  ).toHaveTextContent("Connected");
});

test("Reconnect an OAuth account after cancelled consent and metadata changes", async () => {
  const connector = customConnector({
    displayName: "Acme OAuth",
    authMode: "oauth",
    fields: [],
    headerInjections: [OAUTH_HEADER],
    oauthConfig: OAUTH_CONFIG,
  });
  const personal = customConnectorAccount(connector.id, {
    authMethod: "oauth",
    displayName: "Personal",
    isDefault: false,
    connectionStatus: "reconnect-required",
    reconnectReason: "authorization_expired_or_revoked",
  });
  const store = mockConnectorStore({
    connectors: [connector],
    accounts: [
      customConnectorAccount(connector.id, {
        authMethod: "oauth",
        displayName: "Work",
      }),
      personal,
    ],
  });
  const authorization = mockConnectorAuthorization(store);
  await openCustomScope();
  await waitForCard("Acme OAuth", "Connected");
  click(getConnectorAction("button", "Manage Acme OAuth accounts"));
  const manager = await screen.findByRole("dialog", {
    name: "Manage Acme OAuth accounts",
  });
  click(
    getConnectorAction(
      "button",
      "Reconnect",
      await within(manager).findByRole("group", { name: "Personal" }),
    ),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Connect Acme OAuth",
  });

  const firstWindow = openProviderWindow();
  click(getConnectorAction("button", "Continue", dialog));
  await waitFor(() => {
    expect(firstWindow.location.href).toBe("https://acme.test/oauth/authorize");
  });
  firstWindow.close();
  await waitFor(() => {
    expect(getConnectorAction("button", "Continue", dialog)).toBeEnabled();
  });
  expect(dialog).toBeInTheDocument();

  store.accounts = store.accounts.map((account) => {
    return account.id === personal.id
      ? {
          ...account,
          displayName: "Personal laptop",
          updatedAt: "2026-03-01T00:00:00.000Z",
        }
      : account;
  });
  const secondWindow = openProviderWindow();
  click(getConnectorAction("button", "Continue", dialog));
  await waitFor(() => {
    expect(secondWindow.location.href).toBe(
      "https://acme.test/oauth/authorize",
    );
  });
  authorization.complete();
  secondWindow.close();

  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
  expect(authorization.starts).toStrictEqual([
    { intent: "reconnect", connectionId: personal.id },
    { intent: "reconnect", connectionId: personal.id },
  ]);
  expect(
    screen.queryByRole("dialog", { name: "Name your Acme OAuth account" }),
  ).toBeNull();
});

test("Add and optionally name a custom OAuth account", async () => {
  const connector = customConnector({
    authMode: "oauth",
    fields: [],
    headerInjections: [OAUTH_HEADER],
    oauthConfig: OAUTH_CONFIG,
  });
  const store = mockConnectorStore({ connectors: [connector] });
  const authorization = mockConnectorAuthorization(store);
  const authWindow = openProviderWindow();
  await openCustomScope();
  await waitForCard("Acme Search", "No accounts");

  click(getConnectorAction("button", "Connect Acme Search"));
  await waitFor(() => {
    expect(authWindow.location.href).toBe("https://acme.test/oauth/authorize");
  });
  authorization.complete();
  authWindow.close();

  const nameInput = await skipAccountName("Acme Search");
  expect(nameInput).toHaveAttribute("placeholder", "Unnamed account");
  await waitForCard("Acme Search", "Connected");
  expect(authorization.starts).toStrictEqual([{ intent: "add" }]);
});
