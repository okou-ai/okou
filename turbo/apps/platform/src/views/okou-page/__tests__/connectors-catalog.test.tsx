import type { ConnectorAccountConnection } from "@okouai/api-contracts/contracts/connector-accounts";
import {
  connectorCatalogContract,
  type PublicConnectorCatalogStatusItem,
} from "@okouai/api-contracts/contracts/connector-catalog";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { builtinConnectorOauthStartContract } from "@okouai/api-contracts/contracts/connectors";
import { customConnectorsContract } from "@okouai/api-contracts/contracts/custom-connectors";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  customConnector,
  getConnectorCard,
  mockSavedConnectorAccounts,
  publicStatusItem,
  queryConnectorAction,
  queryConnectorCard,
} from "./connector-page-test-helpers.ts";

const context = testContext();

function builtinAccount(
  connectorSlug: ConnectorSlug,
  overrides: Partial<Omit<ConnectorAccountConnection, "target">> = {},
): ConnectorAccountConnection {
  return {
    id: crypto.randomUUID(),
    target: { kind: "builtin", connectorSlug },
    authMethod: "oauth",
    displayName: null,
    isDefault: true,
    externalId: null,
    externalUsername: null,
    externalEmail: null,
    oauthScopes: [],
    connectionStatus: "connected",
    missingRequiredFields: [],
    configuredFieldKeys: [],
    reconnectReason: null,
    tokenExpiresAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Discovery answers a keyword with the connectors whose name contains it. */
function mockDiscovery(
  connectors: readonly PublicConnectorCatalogStatusItem[],
  options: {
    readonly totalConnectorCount?: number;
    readonly categoryConnectorCounts?: Readonly<Record<string, number>>;
    readonly respond?: (
      keyword: string | undefined,
    ) => readonly PublicConnectorCatalogStatusItem[];
  } = {},
): (string | undefined)[] {
  const keywords: (string | undefined)[] = [];
  context.mocks.api(
    connectorCatalogContract.discovery,
    ({ query, respond }) => {
      keywords.push(query.keyword);
      const keyword = query.keyword?.toLowerCase();
      const matching =
        options.respond?.(query.keyword) ??
        connectors.filter((connector) => {
          return (
            !keyword ||
            connector.label.toLowerCase().includes(keyword) ||
            connector.slug.includes(keyword)
          );
        });
      return respond(200, {
        connectors: [...matching],
        totalConnectorCount: options.totalConnectorCount ?? connectors.length,
        ...(options.categoryConnectorCounts
          ? { categoryConnectorCounts: options.categoryConnectorCounts }
          : {}),
      });
    },
  );
  return keywords;
}

function oauthItem(
  connectorSlug: ConnectorSlug,
  label: string,
  options: { readonly description?: string; readonly rank?: number } = {},
): PublicConnectorCatalogStatusItem {
  return publicStatusItem({
    connectorSlug,
    label,
    description: options.description,
    popularityRank: options.rank,
    category: "communication-collaboration",
    authMethods: [
      {
        id: "oauth",
        label: "OAuth",
        description: null,
        grantKind: "auth-code",
        supportsRefresh: true,
        manualFields: [],
        startOptions: [],
      },
    ],
    singleAuthCodeAuthMethodId: "oauth",
  });
}

function searchParam(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}

function scope(name: "Connected" | "Custom" | "Discover"): HTMLElement {
  return screen.getByRole("radio", {
    name: (accessibleName) => {
      return accessibleName.startsWith(name);
    },
  });
}

test("Search connectors and keep the query in the URL", async () => {
  mockDiscovery([oauthItem("axiom", "Axiom"), oauthItem("github", "GitHub")]);
  mockSavedConnectorAccounts(context, () => {
    return [];
  });
  await setupPage({ context, path: "/connectors?keywords=axiom" });

  const search = await screen.findByPlaceholderText("Find connectors");
  expect(search).toHaveValue("axiom");
  await waitFor(() => {
    expect(queryConnectorCard("Axiom")).toBeInTheDocument();
  });
  expect(queryConnectorCard("GitHub")).toBeNull();

  await fill(search, "github");
  await waitFor(() => {
    expect(queryConnectorCard("GitHub")).toBeInTheDocument();
    expect(queryConnectorCard("Axiom")).toBeNull();
  });
  expect(searchParam("keywords")).toBe("github");

  await fill(search, "missing-service");
  await expect(
    screen.findByText('No connectors matching "missing-service"'),
  ).resolves.toBeInTheDocument();
});

test("Search the full connector catalog", async () => {
  const github = oauthItem("github", "GitHub");
  const slack = oauthItem("slack", "Slack");
  const keywords = mockDiscovery([github, slack], {
    totalConnectorCount: 1234,
    respond: (keyword) => {
      return keyword ? [slack] : [github];
    },
  });
  mockSavedConnectorAccounts(context, () => {
    return [];
  });
  await setupPage({ context, path: "/connectors" });
  await waitFor(() => {
    expect(queryConnectorCard("GitHub")).toBeInTheDocument();
  });
  expect(
    screen.getByText("Connect 1,234 services for your agents to use."),
  ).toBeInTheDocument();

  await fill(screen.getByPlaceholderText("Find connectors"), "Slack");

  await waitFor(() => {
    expect(queryConnectorCard("Slack")).toBeInTheDocument();
    expect(queryConnectorCard("GitHub")).toBeNull();
  });
  expect(keywords.at(-1)).toBe("Slack");
  expect(
    screen.getByText("Connect 1,234 services for your agents to use."),
  ).toBeInTheDocument();
});

test("Present a connector with no accounts and start direct OAuth", async () => {
  mockDiscovery([
    oauthItem("github", "GitHub", {
      description: "Work with repositories and pull requests",
    }),
  ]);
  mockSavedConnectorAccounts(context, () => {
    return [];
  });
  const authorizationUrl = "https://github.test/login/oauth/authorize";
  const started: ConnectorSlug[] = [];
  context.mocks.api(
    builtinConnectorOauthStartContract.start,
    ({ params, respond }) => {
      started.push(params.connectorSlug);
      return respond(200, {
        authorizationUrl,
        oauthAttemptId: crypto.randomUUID(),
      });
    },
  );
  const authWindow = context.mocks.browser.authWindow();
  authWindow.closed = false;
  Object.defineProperty(authWindow, "location", {
    value: { href: "" },
    configurable: true,
  });
  const opened = context.mocks.browser.open(authWindow);
  await setupPage({ context, path: "/connectors" });

  const connect = await waitFor(() => {
    const action = queryConnectorAction(
      "button",
      "Connect GitHub",
      getConnectorCard("GitHub"),
    );
    expect(action).toBeEnabled();
    return action;
  });
  const card = getConnectorCard("GitHub");
  expect(
    within(card).getByText("Work with repositories and pull requests"),
  ).toBeInTheDocument();
  expect(within(card).queryByText("No accounts")).toBeNull();
  expect(
    queryConnectorAction("button", "Manage GitHub accounts", card),
  ).toBeNull();
  expect(queryConnectorAction("button", "Permissions", card)).toBeNull();

  click(connect!);

  await waitFor(() => {
    expect(authWindow.location.href).toBe(authorizationUrl);
  });
  expect(started).toStrictEqual(["github"]);
  expect(opened.calls).toHaveLength(1);
});

test("Land on Discover, then switch to the connectors this workspace has", async () => {
  mockDiscovery(
    [
      oauthItem("gmail", "Gmail", { rank: 1 }),
      oauthItem("outlook-mail", "Outlook Mail", { rank: 2 }),
      oauthItem("slack", "Slack", { rank: 3 }),
      oauthItem("zoom", "Zoom", { rank: 4 }),
    ],
    { categoryConnectorCounts: { "communication-collaboration": 4 } },
  );
  const accounts = [builtinAccount("gmail"), builtinAccount("outlook-mail")];
  mockSavedConnectorAccounts(context, () => {
    return accounts;
  });
  await setupPage({ context, path: "/connectors" });

  await waitFor(() => {
    expect(within(scope("Connected")).getByText("2")).toBeInTheDocument();
    expect(
      queryConnectorAction("button", "Manage Gmail accounts"),
    ).toBeEnabled();
  });
  const gmail = getConnectorCard("Gmail");
  expect(gmail.closest('[data-testid^="connector-shelf-"]')).not.toBeNull();
  expect(queryConnectorAction("button", "Connect Gmail")).toBeNull();
  expect(
    queryConnectorAction("button", "Filter connectors"),
  ).toBeInTheDocument();

  click(scope("Connected"));

  await waitFor(() => {
    expect(screen.getByTestId("connectors-connected-grid")).toBeInTheDocument();
  });
  expect(
    screen.getAllByTestId("connector-card-label").map((label) => {
      return label.textContent;
    }),
  ).toStrictEqual(["Gmail", "Outlook Mail"]);
  expect(searchParam("scope")).toBe("connected");
  expect(queryConnectorAction("button", "Filter connectors")).toBeNull();
  expect(queryConnectorAction("menuitem", "All agents")).toBeNull();
});

test("Keep a saved connector in Connected when its account needs a reconnect", async () => {
  mockDiscovery([oauthItem("gmail", "Gmail"), oauthItem("slack", "Slack")]);
  const accounts = [
    builtinAccount("gmail", {
      connectionStatus: "reconnect-required",
      reconnectReason: "authorization_expired_or_revoked",
    }),
  ];
  mockSavedConnectorAccounts(context, () => {
    return accounts;
  });
  await setupPage({ context, path: "/connectors?scope=connected" });

  await waitFor(() => {
    expect(within(scope("Connected")).getByText("1")).toBeInTheDocument();
    expect(
      queryConnectorAction("button", "Manage Gmail accounts"),
    ).toBeEnabled();
  });
  expect(queryConnectorCard("Slack")).toBeNull();
});

test("Reach the connectors this workspace built from their own segment", async () => {
  context.mocks.data.org({ id: "org_1", name: "Test Org", role: "admin" });
  mockDiscovery([oauthItem("gmail", "Gmail"), oauthItem("slack", "Slack")], {
    categoryConnectorCounts: { "communication-collaboration": 2 },
  });
  const acme = customConnector();
  mockSavedConnectorAccounts(context, () => {
    return [builtinAccount("gmail")];
  });
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: [acme] });
  });
  await setupPage({ context, path: "/connectors" });

  await waitFor(() => {
    expect(queryConnectorCard("Gmail")).toBeInTheDocument();
  });
  expect(queryConnectorCard("Acme Search")).toBeNull();

  click(scope("Custom"));

  await waitFor(() => {
    expect(queryConnectorCard("Acme Search")).toBeInTheDocument();
  });
  expect(searchParam("scope")).toBe("custom");
  expect(queryConnectorAction("button", "Filter connectors")).toBeNull();
  expect(screen.queryByTestId(/^connector-shelf-/u)).toBeNull();
  expect(
    queryConnectorAction("button", "New custom connector"),
  ).toBeInTheDocument();
});
