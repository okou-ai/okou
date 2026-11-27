import {
  customConnectorByIdContract,
  customConnectorsContract,
  type UpdateCustomConnectorBody,
  customConnectorOAuth2Contract,
  customConnectorValuesContract,
  type CustomConnectorHttpResponse,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import {
  click,
  fill,
  setupPage,
  startPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import {
  customConnector,
  mcpCustomConnector,
  mockSavedConnectorAccounts,
  getConnectorCard,
  mockCustomConnectorStory,
  customConnectorAccount,
  chooseConnectorAuthentication,
  mockPublicConnectorStatus,
  publicStatusItem,
  mockOAuthCompletions,
} from "./connector-page-test-helpers.ts";
import { findButton, queryButton } from "./chat-run-test-fixtures.ts";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { DetachedBrowserContext } from "happy-dom";
import {
  getAction,
  findAction,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();

const path = "/connectors?scope=custom";

test("connectors-custom-003 switching HTTP authentication preserves its draft before creating a public connector", async () => {
  mockCustomConnectorStory(context);
  await setupPage({ context, path });
  click(await findFastControl("button", "New custom connector"));
  const form = await screen.findByRole("dialog", {
    name: "New custom connector",
  });
  await fill(within(form).getByPlaceholderText("Acme API"), "Guest data");
  await fill(
    within(form).getByPlaceholderText("https://api.acme.com/v1/"),
    "https://public.example.test/",
  );
  await chooseConnectorAuthentication(form, "API authentication");
  const header = within(form).getByPlaceholderText("Authorization");
  await fill(header, "X-Public-Key");
  click(within(form).getByRole("combobox", { name: "Authentication" }));
  expect(
    screen.queryByRole("option", { name: "Automatic" }),
  ).not.toBeInTheDocument();
  click(await screen.findByRole("option", { name: "No authentication" }));
  expect(
    within(form).queryByPlaceholderText("Authorization"),
  ).not.toBeInTheDocument();
  await chooseConnectorAuthentication(form, "API authentication");
  expect(within(form).getByPlaceholderText("Authorization")).toHaveValue(
    "X-Public-Key",
  );
  await chooseConnectorAuthentication(form, "No authentication");
  const create = await findFastControl("button", "Create", form);
  expect(create).toBeEnabled();
  click(create);
  await screen.findByText("Guest data");
});
test("connectors-custom-011 renaming the connected API preserves its prefix until deletion", async () => {
  const api = customConnector({ displayName: "Acme API" });
  mockCustomConnectorStory(context, [
    { connector: api, account: customConnectorAccount(api.id) },
  ]);
  await setupPage({ context, path });
  await screen.findByText("Acme API");
  click(await findFastControl("button", "More options"));
  click(await screen.findByText("Edit", { selector: '[role="menuitem"]' }));
  const form = await screen.findByRole("dialog");
  await fill(within(form).getByPlaceholderText("Acme API"), "Acme Billing API");
  click(await findFastControl("button", "Save", form));
  await screen.findByText("Acme Billing API");
  const card = getConnectorCard("Acme Billing API");
  expect(card).toHaveTextContent("Connected");
  expect(card).toHaveTextContent("https://api.acme.test/v1/");
  click(await findFastControl("button", "More options"));
  click(await screen.findByText("Delete", { selector: '[role="menuitem"]' }));
  click(
    await findFastControl(
      "button",
      "Delete",
      await screen.findByRole("dialog"),
    ),
  );
  await screen.findByText(
    "Add an HTTP API or MCP server for your organization to use.",
  );
});
test("connectors-custom-021 saving the advanced query-key definition retains its injection", async () => {
  let update: { id: string; body: UpdateCustomConnectorBody } | undefined;
  const api = customConnector({
    headerInjections: [],
    queryInjections: [{ name: "api_key", valueTemplate: "{{secrets.secret}}" }],
  });
  mockCustomConnectorStory(context, [{ connector: api }]);
  context.mocks.api(
    customConnectorByIdContract.update,
    ({ params, body, respond }) => {
      update = { id: params.id, body };
      return respond(200, api);
    },
  );
  await setupPage({ context, path });
  await screen.findByText(api.displayName);
  click(await findFastControl("button", "More options"));
  click(await screen.findByText("Edit", { selector: '[role="menuitem"]' }));
  const editor = await screen.findByRole("dialog");
  await within(editor).findByText(
    "Advanced API fields and injections are preserved when you save.",
  );
  click(await findFastControl("button", "Save", editor));
  await waitFor(() => {
    return expect(editor).not.toBeInTheDocument();
  });
  expect(update).toMatchObject({
    id: api.id,
    body: {
      prefixTemplates: api.prefixTemplates,
      headerInjections: [],
      queryInjections: api.queryInjections,
    },
  });
});
test("connectors-custom-024 the unconnected API separates card activation from definition actions", async () => {
  const api = customConnector();
  mockCustomConnectorStory(context, [{ connector: api }]);
  await setupPage({ context, path });
  await screen.findByText(api.displayName);
  const card = getConnectorCard(api.displayName);
  expect(card).toHaveTextContent("HTTP API");
  expect(card).toHaveTextContent("No accounts");
  expect(card).toHaveTextContent(api.prefixTemplates[0]!);
  await expect(
    findFastControl("button", "Connect Acme Search", card),
  ).resolves.toBeEnabled();
  expect(
    within(card).queryByLabelText("Manage Acme Search access"),
  ).not.toBeInTheDocument();
  click(await findFastControl("button", "More options"));
  const menu = await screen.findByRole("menu");
  expect(within(menu).getByText("Edit")).toBeInTheDocument();
  expect(within(menu).getByText("Delete")).toBeInTheDocument();
  expect(within(menu).queryByText("Connect")).not.toBeInTheDocument();
});

test("connectors-custom-017 connected filters retain a service whose nondefault OAuth accounts are healthy", async () => {
  const configured = mcpCustomConnector();
  const empty = mcpCustomConnector({
    id: crypto.randomUUID(),
    slug: "_empty",
    displayName: "Empty MCP",
  });
  const primary = customConnectorAccount(configured.id, {
    authMethod: "oauth",
    displayName: "Original default",
    connectionStatus: "reconnect-required",
    reconnectReason: "authorization_expired_or_revoked",
  });
  context.mocks.data.org({ id: "org_1", name: "Test Org", role: "admin" });
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: [configured, empty] });
  });
  const accounts = [
    primary,
    ...["Work", "Personal"].map((displayName) => {
      return customConnectorAccount(configured.id, {
        authMethod: "oauth",
        displayName,
        isDefault: false,
      });
    }),
  ];
  mockSavedConnectorAccounts(context, () => {
    return accounts;
  });
  await setupPage({ context, path });
  await screen.findByText("Empty MCP");
  const unused = getConnectorCard("Empty MCP");
  expect(unused).toHaveTextContent("No accounts");
  await expect(
    findFastControl("button", "Connect Empty MCP", unused),
  ).resolves.toBeEnabled();
  expect(getConnectorCard("Acme MCP")).toHaveTextContent("Connected");
  click(await findFastControl("radio", /^Connected/));
  await waitFor(() => {
    return expect(screen.queryByText("Empty MCP")).toBeNull();
  });
  const service = getConnectorCard("Acme MCP");
  click(await findFastControl("button", /manage.*accounts/i, service));
  const dialog = within(await screen.findByRole("dialog"));
  const row = await dialog.findByRole("group", { name: "Original default" });
  expect(row).toHaveTextContent(/default/i);
  await expect(
    findFastControl("button", "Reconnect", row),
  ).resolves.toBeEnabled();
  for (const name of ["Work", "Personal"]) {
    expect(dialog.getByText(name)).toBeInTheDocument();
  }
});

async function selectScope(label: string) {
  const radio = await screen.findByText(label, { selector: '[role="radio"]' });
  click(radio);
}
function reports() {
  const connector = customConnector({ displayName: "Acme Reports" });
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: [connector] });
  });
}
test("connectors-directory-custom-004 a member can inspect the empty Custom scope", async () => {
  context.mocks.data.org({ role: "member" });
  await setupPage({ context, path: "/connectors" });
  await findButton("Connect GitHub");
  await selectScope("Custom");
  await screen.findByText(
    "Your org hasn't registered any custom connectors yet.",
  );
  expect(screen.getByRole("heading", { name: "Custom" })).toBeInTheDocument();
  expect(new URL(window.location.href).searchParams.get("scope")).toBe(
    "custom",
  );
  expect(screen.queryByText("GitHub")).not.toBeInTheDocument();
  expect(queryButton("New custom connector")).toBeNull();
});

test("connectors-directory-custom-007 Back from the custom catalog returns to the remote directory", async () => {
  reports();
  await setupPage({ context, path: "/connectors" });
  await findButton("Connect GitHub");
  await selectScope("Remote devices");
  await findButton("Add connection");
  await selectScope("Custom");
  await screen.findByText("Acme Reports");
  expect(window.location.search).toBe("?scope=custom");
  window.history.back();
  await waitFor(() => {
    return expect(new URL(window.location.href).searchParams.get("scope")).toBe(
      "remote-control",
    );
  });
  await findButton("Add connection");
  expect(screen.queryByText("Acme Reports")).not.toBeInTheDocument();
});

test("connectors-directory-custom-008 failed custom search reports its service failure", async () => {
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(500, {
      error: { code: "UNAVAILABLE", message: "Catalog unavailable" },
    });
  });
  await setupPage({ context, path: "/connectors?keywords=recovered" });
  await screen.findByText("Couldn't load custom connectors.");
  expect(
    screen.queryByText('No connectors matching "recovered"'),
  ).not.toBeInTheDocument();
});

test("connectors-directory-custom-002 searching Acme groups both connectors by source", async () => {
  reports();
  mockPublicConnectorStatus(context, [
    publicStatusItem({ connectorSlug: "github", label: "Acme Reports" }),
  ]);
  await setupPage({ context, path: "/connectors" });
  const field = await screen.findByPlaceholderText("Find connectors");
  await fill(field, "acme");
  const built = await screen.findByText("Built-in connectors", {
    selector: "h2,h3",
  });
  const custom = await screen.findByText("Custom", { selector: "h2,h3" });
  for (const heading of [built, custom]) {
    const section = heading.closest("section")!;
    await within(section).findByText("Acme Reports");
  }
  expect(screen.queryByText(/No connectors matching/)).not.toBeInTheDocument();
});
test("connectors-directory-custom-009 Remote devices keeps the custom directory off both surfaces", async () => {
  reports();
  await setupPage({ context, path: "/connectors" });
  await findButton("Connect GitHub");
  const customHeading = () => {
    return screen.queryByRole("heading", { name: "Custom" });
  };
  expect(customHeading()).not.toBeInTheDocument();
  expect(queryButton("New custom connector")).toBeNull();
  await selectScope("Remote devices");
  await findButton("Add connection");
  expect(new URL(location.href).searchParams.get("scope")).toBe(
    "remote-control",
  );
  expect(customHeading()).not.toBeInTheDocument();
  expect(queryButton("New custom connector")).toBeNull();
});
test("connectors-directory-custom-010 cancelling keeps the search and creating reveals the new service", async () => {
  mockCustomConnectorStory(context);
  await setupPage({
    context,
    path: "/connectors?scope=custom&keywords=missing",
  });
  const search = await screen.findByPlaceholderText("Find custom connectors");
  click(await findButton("New custom connector"));
  const cancelled = await screen.findByRole("dialog");
  click(await findButton("Cancel"));
  await waitFor(() => {
    return expect(cancelled).not.toBeInTheDocument();
  });
  expect(search).toHaveValue("missing");
  expect(new URL(location.href).searchParams.get("keywords")).toBe("missing");
  click(await findButton("New custom connector"));
  const form = await screen.findByRole("dialog");
  await fill(within(form).getByPlaceholderText("Acme API"), "Created Service");
  await fill(
    within(form).getByPlaceholderText("https://api.acme.com/v1/"),
    "https://created.example.test/",
  );
  await chooseConnectorAuthentication(form, "API authentication");
  click(await findButton("Create"));
  await screen.findByText("Created Service");
  expect(getConnectorCard("Created Service")).toHaveTextContent("No accounts");
  expect(new URL(location.href).searchParams.get("scope")).toBe("custom");
});

const customReconnectPath = "/connectors?scope=custom",
  label = "Harbor Records";
function records() {
  return customConnector({ slug: "_harbor-records", displayName: label });
}
function accountChanges() {
  const changed = new Map<string, unknown>();
  context.mocks.api(
    customConnectorValuesContract.set,
    ({ params, body, respond }) => {
      changed.set(params.id, body.account);
      return respond(400, {
        error: {
          code: "UNEXPECTED_CHANGE",
          message: "Unexpected account update",
        },
      });
    },
  );
  context.mocks.api(
    customConnectorOAuth2Contract.start,
    ({ params, body, respond }) => {
      changed.set(params.id, body.account);
      return respond(400, {
        error: {
          code: "UNEXPECTED_CHANGE",
          message: "Unexpected account authorization",
        },
      });
    },
  );
  return changed;
}
test("custom-default-reconnect-004 the inventory gates Connect until an empty account list settles", async () => {
  const connector = records();
  mockCustomConnectorStory(context, [{ connector }]);
  const changed = accountChanges(),
    gate = context.mocks.deferred<void>(),
    asked = context.mocks.deferred<void>();
  mockSavedConnectorAccounts(context, async () => {
    if (!asked.settled()) {
      asked.resolve();
    }
    await gate.promise;
    return [];
  });
  const app = await startPage({ context, path: customReconnectPath });
  await asked.promise;
  await screen.findByText(label);
  const before = queryFastControl("button", "Connect " + label);
  expect(before).toBeNull();
  gate.resolve();
  await app.ready;
  await screen.findByText(label);
  const card = getConnectorCard(label);
  const button = await findFastControl("button", "Connect " + label, card);
  expect(button).toBeEnabled();
  expect(card).toHaveTextContent(/no accounts|not connected|0 accounts/i);
  expect(changed.has(connector.id)).toBeFalsy();
});
test("custom-default-reconnect-003 replacing the default secret keeps the healthy sibling on its own account", async () => {
  const connector = records(),
    primary = customConnectorAccount(connector.id, {
      displayName: "Harbor Main",
    }),
    sibling = customConnectorAccount(connector.id, {
      displayName: "Harbor Archive",
      isDefault: false,
    });
  mockCustomConnectorStory(context, [{ connector, account: primary }]);
  mockSavedConnectorAccounts(context, () => {
    return [primary, sibling];
  });
  const saved = context.mocks.deferred<unknown>();
  context.mocks.api(customConnectorValuesContract.set, ({ body, respond }) => {
    saved.resolve(body);
    return respond(200, { ...connector, connectionId: primary.id });
  });
  await setupPage({
    context,
    path: "/connectors/" + connector.slug + "/connect",
  });
  click(await findFastControl("button", "Reconnect"));
  const dialog = await screen.findByRole("dialog");
  const secret = await within(dialog).findByLabelText("Secret", {
    exact: false,
  });
  await fill(secret, "local-replacement");
  click(await findFastControl("button", /save|connect/i, dialog));
  await expect(saved.promise).resolves.toMatchObject({
    account: { intent: "reconnect", connectionId: primary.id },
    values: [{ key: "secret", value: "local-replacement" }],
  });
  await waitFor(() => {
    return expect(dialog).not.toBeInTheDocument();
  });
});
const provider = "https://provider.example.test/consent/local",
  oauthPath = "/connectors/_harbor-records/connect";
function providerSetup() {
  return customConnector({
    slug: "_harbor-records",
    displayName: label,
    authMode: "oauth",
    oauthConfig: {
      providerAdapter: "standard",
      clientId: "local-client",
      authorizationUrl: provider,
      tokenUrl: "https://provider.example.test/token",
      tokenEndpointAuthMethod: "client_secret_basic",
      pkceMethod: "S256",
      scopes: [],
      authorizationParams: {},
    },
  });
}
function captureAuthorizationTabs() {
  const pages = vi.spyOn(DetachedBrowserContext.prototype, "newPage");
  const nativeOpen = window.open.bind(window);
  vi.spyOn(window, "open").mockImplementation((url, target, features) => {
    const child = nativeOpen(url, target, features);
    // Happy DOM exposes opener as getter-only. Browsers allow removing it.
    const page = pages.mock.results.at(-1)?.value;
    if (child && page) {
      Object.defineProperty(child, "opener", {
        value: child.opener,
        writable: true,
        configurable: true,
      });
      // The WindowProxy stays open across document replacement until its page closes.
      return new Proxy(child, {
        get(documentWindow, property) {
          if (property === "closed") {
            return page.closed;
          }
          if (property === "close") {
            return documentWindow.close.bind(documentWindow);
          }
          return Reflect.get(documentWindow, property, documentWindow);
        },
      });
    }
    return child;
  });
  return pages;
}
async function connect() {
  click(await findFastControl("button", "Connect"));
  return await screen.findByRole("dialog");
}
test("custom-default-reconnect-009 a saved account without a default explains why provider authorization cannot proceed", async () => {
  const definition = providerSetup(),
    orphan = customConnectorAccount(definition.id, {
      authMethod: "oauth",
      displayName: "Archive",
      isDefault: false,
    }),
    popup = context.mocks.browser.authWindow();
  Object.defineProperty(popup, "location", { value: { href: "about:blank" } });
  context.mocks.browser.open(popup);
  mockCustomConnectorStory(context, [{ connector: definition }]);
  mockSavedConnectorAccounts(context, () => {
    return [orphan];
  });
  const changed = accountChanges();
  await setupPage({ context, path: oauthPath });
  const dialog = await connect();
  click(await findFastControl("button", "Continue", dialog));
  await expect(
    screen.findByText(/saved accounts.*no default|no default.*saved account/i),
  ).resolves.toBeVisible();
  expect(popup.closed).toBeTruthy();
  expect(popup.location.href).toBe("about:blank");
  expect(changed.has(definition.id)).toBeFalsy();
});

test("custom-default-reconnect-006 closing the provider tab releases the first-account consent action", async () => {
  const service = providerSetup();
  mockCustomConnectorStory(context, [{ connector: service }]);
  mockSavedConnectorAccounts(context, () => {
    return [];
  });
  mockOAuthCompletions(context);
  context.mocks.http.get(provider, () => {
    return new Response("<title>Provider consent</title>", {
      headers: { "Content-Type": "text/html" },
    });
  });
  const intent = context.mocks.deferred<unknown>();
  context.mocks.api(
    customConnectorOAuth2Contract.start,
    ({ body, respond }) => {
      intent.resolve(body.account);
      return respond(200, {
        result: "authorization",
        authorizationUrl: provider,
        oauthAttemptId: crypto.randomUUID(),
      });
    },
  );
  await setupPage({ context, path: oauthPath });
  const prompt = await connect();
  const proceed = await findFastControl("button", "Continue", prompt);
  const pages = captureAuthorizationTabs();
  click(proceed);
  await waitFor(() => {
    return expect(intent.settled()).toBeTruthy();
  });
  await expect(intent.promise).resolves.toMatchObject({ intent: "add" });
  const tab = pages.mock.results.at(-1)?.value;
  if (!tab) {
    throw new Error("Authorization did not open a browser tab");
  }
  try {
    await waitFor(() => {
      return expect(tab.url).toBe(provider);
    });
    await waitFor(() => {
      return expect(
        within(prompt).getByText(/connecting/i, { selector: "button" }),
      ).toBeDisabled();
    });
  } finally {
    await tab.close();
  }
  await expect(
    findFastControl("button", "Continue", prompt),
  ).resolves.toBeEnabled();
});

test("A directed Acme sign-in links the approved custom account and closes its dialog", async () => {
  const authorizationUrl = "https://acme.example.test/consent/workspace";
  const connector = providerSetup();
  Object.assign(connector, {
    slug: "_acme-consent",
    displayName: "Acme OAuth",
    oauthConfig: { ...connector.oauthConfig, authorizationUrl },
  });
  const account = customConnectorAccount(connector.id, {
    authMethod: "oauth",
    displayName: "Workspace Acme account",
  });
  const attemptId = crypto.randomUUID();
  let accepted = false;
  mockCustomConnectorStory(context, [{ connector }]);
  mockSavedConnectorAccounts(context, () => {
    return accepted ? [account] : [];
  });
  const completions = mockOAuthCompletions(context);
  context.mocks.api(
    connectorAccountsContract.connection,
    ({ params, respond }) => {
      expect(params.connectionId).toBe(account.id);
      return respond(200, account);
    },
  );
  context.mocks.api(
    customConnectorOAuth2Contract.start,
    ({ params, body, respond }) => {
      expect(params.id).toBe(connector.id);
      expect(body.account).toMatchObject({ intent: "add" });
      return respond(200, {
        result: "authorization",
        oauthAttemptId: attemptId,
        authorizationUrl,
      });
    },
  );
  context.mocks.http.get(authorizationUrl, () => {
    return new Response("<title>Acme consent</title>", {
      headers: { "content-type": "text/html" },
    });
  });
  await setupPage({
    context,
    path: "/connectors/_acme-consent/connect?agentId=" + crypto.randomUUID(),
  });
  const dialog = await connect();
  const pages = captureAuthorizationTabs();
  click(await findFastControl("button", "Continue", dialog));
  const child = await waitFor(() => {
    const entry = pages.mock.results.find((result) => {
      return result.value.url === authorizationUrl;
    });
    if (!entry) {
      throw new Error("Waiting for Acme consent in the authorization tab");
    }
    return entry.value;
  });
  try {
    accepted = true;
    completions.set(attemptId, account.id);
    await child.close();
    await screen.findByText("Acme OAuth connected");
    expect(screen.queryByRole("dialog")).toBeNull();
  } finally {
    if (!child.closed) {
      await child.close();
    }
  }
});

test.each([
  ["custom-default-reconnect-007", "deliver"],
  ["Withheld control", "withhold"],
] as const)(
  "%s %s the pending default-account lookup after cancelling Continue",
  async (_label, mode) => {
    const service = providerSetup();
    mockCustomConnectorStory(context, [{ connector: service }]);
    const lookup = context.mocks.deferred<void>();
    const finish = context.mocks.deferred<void>();
    const delivered = context.mocks.deferred<void>();
    let saving = false;
    mockSavedConnectorAccounts(context, () => {
      return [];
    });
    const decode = Response.prototype.json;
    vi.spyOn(Response.prototype, "json").mockImplementation(async function (
      this: Response,
    ) {
      const payload: unknown = await decode.call(this);
      if (
        saving &&
        new URL(this.url).pathname ===
          connectorAccountsContract.connections.path &&
        !lookup.settled()
      ) {
        lookup.resolve();
        await finish.promise;
        delivered.resolve();
      }
      return payload;
    });
    const changed = accountChanges();
    await setupPage({ context, path: oauthPath });
    const dialog = await connect();
    const continueButton = await findFastControl("button", "Continue", dialog);
    await waitFor(() => {
      return expect(continueButton).toBeEnabled();
    });
    const tabs = captureAuthorizationTabs();
    saving = true;
    click(continueButton);
    await lookup.promise;
    const opened = tabs.mock.results.at(-1)?.value;
    expect(opened?.url).toBe("about:blank");
    const cancel = await findFastControl("button", "Cancel", dialog);
    click(cancel);
    await waitFor(() => {
      return expect(dialog).not.toBeInTheDocument();
    });
    await waitFor(() => {
      return expect(opened?.closed).toBeTruthy();
    });
    if (mode === "deliver") {
      finish.resolve();
      await delivered.promise;
    }
    expect(delivered.settled()).toBe(mode === "deliver");
    await expect(findFastControl("button", "Connect")).resolves.toBeEnabled();
    expect(changed.has(service.id)).toBeFalsy();
  },
);

const MANAGED_CONNECTION_ID = "f7000000-0000-4000-a000-000000000a41";
const ACCOUNT_LIST_ERROR = "Ordinary connector accounts are unavailable";
const ACCOUNT_LOOKUP_ERROR = "Connector account not found";

function managedWorkspace(updatedAt: string): CustomConnectorHttpResponse {
  return customConnector({
    id: "f7000000-0000-4000-a000-000000000a40",
    slug: "_managed-workspace",
    displayName: "Managed workspace",
    prefixTemplates: ["https://open.feishu.cn/open-apis/"],
    fields: [],
    headerInjections: [],
    authMode: "oauth",
    oauthConfig: {
      providerAdapter: "feishu",
      clientId: "cli_managed_workspace",
      authorizationUrl:
        "https://accounts.feishu.cn/open-apis/authen/v1/authorize",
      tokenUrl: "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
      tokenEndpointAuthMethod: "client_secret_post",
      pkceMethod: "S256",
      scopes: [],
      authorizationParams: {},
    },
    connected: true,
    connectedAccountId: MANAGED_CONNECTION_ID,
    connectedAccountUpdatedAt: updatedAt,
    missingRequiredFields: [],
    configuredFieldKeys: [],
  });
}

test("Preserve the feishu managed default connection lifecycle", async () => {
  const server = { connector: managedWorkspace("2026-03-01T00:00:00.000Z") };
  const reconnectIntent = context.mocks.deferred<unknown>();
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: [server.connector] });
  });
  context.mocks.api(connectorAccountsContract.connections, ({ respond }) => {
    return respond(403, {
      error: { code: "FORBIDDEN", message: ACCOUNT_LIST_ERROR },
    });
  });
  context.mocks.api(connectorAccountsContract.connection, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: ACCOUNT_LOOKUP_ERROR },
    });
  });
  context.mocks.api(
    customConnectorOAuth2Contract.start,
    ({ params, body, respond }) => {
      expect(params.id).toBe(server.connector.id);
      reconnectIntent.resolve(body.account);
      // The integration already holds the workspace grant, so the provider
      // refreshes the same managed account without a consent page.
      server.connector = managedWorkspace("2026-03-02T00:00:00.000Z");
      return respond(200, {
        result: "connected",
        connector: server.connector,
        connectionId: MANAGED_CONNECTION_ID,
      });
    },
  );
  const authWindow = context.mocks.browser.authWindow();
  context.mocks.browser.open(authWindow);
  await setupPage({ context, path: "/connectors/_managed-workspace/connect" });
  await expect(
    screen.findByRole("heading", { name: "Managed workspace connected" }),
  ).resolves.toBeInTheDocument();

  click(await findAction("button", "Reconnect"));
  const dialog = await screen.findByRole("dialog", {
    name: "Connect Managed workspace",
  });
  click(getAction("button", "Continue", dialog));

  await expect(reconnectIntent.promise).resolves.toStrictEqual({
    intent: "reconnect",
    connectionId: MANAGED_CONNECTION_ID,
  });
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
  expect(authWindow.closed).toBeTruthy();
  expect(
    screen.getByRole("heading", { name: "Managed workspace connected" }),
  ).toBeInTheDocument();
  expect(screen.queryByText(ACCOUNT_LIST_ERROR)).toBeNull();
  expect(screen.queryByText(ACCOUNT_LOOKUP_ERROR)).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});
