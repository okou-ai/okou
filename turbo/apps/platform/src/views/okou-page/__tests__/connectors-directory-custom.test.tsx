import {
  connectorCatalogContract,
  type PublicConnectorCatalogStatusItem,
} from "@okouai/api-contracts/contracts/connector-catalog";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import {
  type CustomConnectorResponse,
  customConnectorsContract,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  chooseConnectorAuthentication,
  customConnector,
  getConnectorAction,
  getConnectorCard,
  mockCustomConnectorStory,
  mockSavedConnectorAccounts,
  publicStatusItem,
  queryConnectorAction,
  queryConnectorCard,
} from "./connector-page-test-helpers.ts";

const context = testContext();

const GITHUB = "github" as ConnectorSlug;

function githubItem(label = "GitHub"): PublicConnectorCatalogStatusItem {
  return publicStatusItem({ connectorSlug: GITHUB, label });
}

function acmeReports(): CustomConnectorResponse {
  return customConnector({
    id: "55555555-5555-4555-8555-555555555555",
    slug: "acme-reports",
    displayName: "Acme Reports",
    prefixTemplates: ["https://api.acme-reports.test/"],
  });
}

/** Discovery answers a keyword with the connectors whose name contains it. */
function mockDiscovery(
  connectors: readonly PublicConnectorCatalogStatusItem[],
): void {
  context.mocks.api(
    connectorCatalogContract.discovery,
    ({ query, respond }) => {
      const keyword = query.keyword?.trim().toLowerCase();
      return respond(200, {
        connectors: connectors.filter((connector) => {
          return (
            !keyword ||
            connector.label.toLowerCase().includes(keyword) ||
            connector.slug.includes(keyword)
          );
        }),
        totalConnectorCount: connectors.length,
      });
    },
  );
}

function mockCustomConnectors(
  connectors: readonly CustomConnectorResponse[],
): void {
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: [...connectors] });
  });
}

function mockNoAccounts(): void {
  mockSavedConnectorAccounts(context, () => {
    return [];
  });
}

function scope(
  name: "Discover" | "Custom" | "Remote control" | "Connected",
): HTMLElement {
  return screen.getByRole("radio", {
    name: (accessibleName) => {
      return accessibleName.startsWith(name);
    },
  });
}

function searchParam(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}

async function findAction(
  role: "button" | "link",
  name: string,
  container: ParentNode = document.body,
): Promise<HTMLElement> {
  return await waitFor(() => {
    return getConnectorAction(role, name, container);
  });
}

test("Separate same-name built-in and custom search results", async () => {
  mockDiscovery([githubItem("Acme Reports")]);
  mockCustomConnectors([acmeReports()]);
  mockNoAccounts();
  await setupPage({ context, path: "/connectors" });

  await fill(await screen.findByPlaceholderText("Find connectors"), "acme");

  const builtin = await screen.findByRole("region", {
    name: "Built-in connectors",
  });
  const custom = await screen.findByRole("region", { name: "Custom" });
  await waitFor(() => {
    expect(
      within(builtin)
        .getAllByTestId("connector-card-label")
        .map((label) => {
          return label.textContent;
        }),
    ).toStrictEqual(["Acme Reports"]);
    expect(
      within(custom)
        .getAllByTestId("connector-card-label")
        .map((label) => {
          return label.textContent;
        }),
    ).toStrictEqual(["Acme Reports"]);
  });
  expect(screen.queryByText(/No connectors matching/u)).toBeNull();
});

test("Keep zero-custom navigation and role-specific creation for member", async () => {
  context.mocks.data.org({ id: "org_1", name: "Test Org", role: "member" });
  mockDiscovery([githubItem()]);
  mockCustomConnectors([]);
  mockNoAccounts();
  await setupPage({ context, path: "/connectors" });
  await waitFor(() => {
    expect(queryConnectorCard("GitHub")).toBeInTheDocument();
  });

  click(scope("Custom"));

  const custom = await screen.findByRole("region", { name: "Custom" });
  await expect(
    within(custom).findByText(
      "Your org hasn't registered any custom connectors yet.",
    ),
  ).resolves.toBeInTheDocument();
  expect(searchParam("scope")).toBe("custom");
  expect(queryConnectorCard("GitHub")).toBeNull();
  expect(queryConnectorAction("button", "New custom connector")).toBeNull();
});

test("Scope navigation returns directly to Remote control", async () => {
  mockDiscovery([githubItem()]);
  mockCustomConnectors([acmeReports()]);
  mockNoAccounts();
  await setupPage({ context, path: "/connectors" });
  await waitFor(() => {
    expect(queryConnectorCard("GitHub")).toBeInTheDocument();
  });

  click(scope("Remote control"));
  await expect(
    findAction("button", "Add connection"),
  ).resolves.toBeInTheDocument();

  click(scope("Custom"));
  await waitFor(() => {
    expect(queryConnectorCard("Acme Reports")).toBeInTheDocument();
  });
  expect(window.location.search).toBe("?scope=custom");

  window.history.back();

  await waitFor(() => {
    expect(searchParam("scope")).toBe("remote-control");
  });
  await expect(
    findAction("button", "Add connection"),
  ).resolves.toBeInTheDocument();
  expect(queryConnectorCard("Acme Reports")).toBeNull();
});

test("Do not turn Custom loading failure into an empty search result", async () => {
  mockDiscovery([githubItem()]);
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(500, {
      error: { code: "INTERNAL_SERVER_ERROR", message: "Unavailable" },
    });
  });
  mockNoAccounts();
  await setupPage({ context, path: "/connectors?keywords=recovered" });

  const custom = await screen.findByRole("region", { name: "Custom" });

  await expect(
    within(custom).findByText("Couldn't load custom connectors."),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText(/No connectors matching/u)).toBeNull();
  expect(
    screen.queryByText("No custom connectors match your search."),
  ).toBeNull();
});

test("Keep Remote control and Custom in separate scopes", async () => {
  mockDiscovery([githubItem()]);
  mockCustomConnectors([acmeReports()]);
  mockNoAccounts();
  await setupPage({ context, path: "/connectors" });
  await waitFor(() => {
    expect(queryConnectorCard("GitHub")).toBeInTheDocument();
  });
  expect(screen.queryByRole("region", { name: "Custom" })).toBeNull();
  expect(queryConnectorAction("button", "New custom connector")).toBeNull();

  click(scope("Remote control"));

  await expect(
    findAction("button", "Add connection"),
  ).resolves.toBeInTheDocument();
  expect(searchParam("scope")).toBe("remote-control");
  expect(screen.queryByRole("region", { name: "Custom" })).toBeNull();
  expect(queryConnectorAction("button", "New custom connector")).toBeNull();
  expect(queryConnectorCard("Acme Reports")).toBeNull();
});

test("Cancel and create a custom connector from the Custom scope", async () => {
  mockCustomConnectorStory(context, []);
  mockDiscovery([githubItem()]);
  await setupPage({
    context,
    path: "/connectors?scope=custom&keywords=missing",
  });
  const search = await screen.findByPlaceholderText("Find custom connectors");
  await expect(
    screen.findByText("No custom connectors match your search."),
  ).resolves.toBeInTheDocument();

  click(await findAction("button", "New custom connector"));
  const cancelled = await screen.findByRole("dialog", {
    name: "New custom connector",
  });
  click(getConnectorAction("button", "Cancel", cancelled));
  await waitFor(() => {
    expect(cancelled).not.toBeInTheDocument();
  });
  expect(search).toHaveValue("missing");
  expect(searchParam("keywords")).toBe("missing");

  click(await findAction("button", "New custom connector"));
  const dialog = await screen.findByRole("dialog", {
    name: "New custom connector",
  });
  await fill(within(dialog).getByLabelText("Display name"), "Created Service");
  await fill(
    within(dialog).getByLabelText(/^Prefixes/u),
    "https://api.created.test/",
  );
  await chooseConnectorAuthentication(dialog, "API authentication");
  click(getConnectorAction("button", "Create", dialog));

  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
  await waitFor(() => {
    expect(getConnectorCard("Created Service")).toHaveTextContent(
      "No accounts",
    );
  });
  expect(searchParam("scope")).toBe("custom");
});
