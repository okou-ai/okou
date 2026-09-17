import { customConnectorsContract } from "@okouai/api-contracts/contracts/custom-connectors";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { search as locationSearch } from "../../../signals/location.ts";
import {
  customConnector,
  getConnectorAction,
  getConnectorCard,
  mockConnectors,
  mockCustomConnectorStory,
  mockPublicConnectorStatus,
  publicStatusItem,
  queryConnectorAction,
  queryConnectorCard,
} from "./connector-page-test-helpers.ts";

const context = testContext();

function installCustomDirectory() {
  mockCustomConnectorStory(context);
  mockConnectors(context, []);
  mockPublicConnectorStatus(context, []);
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, {
      connectors: [
        customConnector({ displayName: "Acme Reports", slug: "hidden-slug" }),
        customConnector({
          id: "55555555-5555-4555-8555-555555555555",
          displayName: "Other Service",
          prefixTemplates: ["https://acme-reports.test/"],
        }),
      ],
    });
  });
}

test("Show Custom and contextual creation without built-in shelves", async () => {
  installCustomDirectory();
  await setupPage({
    context,
    path: "/connectors?scope=custom",
    featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: true },
  });
  const section = await screen.findByRole("region", {
    name: "Custom",
  });
  expect(within(section).getByText("Acme Reports")).toBeVisible();
  expect(getConnectorAction("button", "New custom connector")).toBeVisible();
  expect(queryConnectorAction("button", "New connector")).toBeNull();
});

test("Separate same-name built-in and custom search results", async () => {
  installCustomDirectory();
  mockPublicConnectorStatus(context, [
    publicStatusItem({ connectorSlug: "github", label: "Acme Reports" }),
  ]);
  await setupPage({
    context,
    path: "/connectors?keywords=acme",
    featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: true },
  });
  const builtin = await screen.findByRole("region", {
    name: "Built-in connectors",
  });
  const custom = await screen.findByRole("region", {
    name: "Custom",
  });
  expect(within(builtin).getByText("Acme Reports")).toBeVisible();
  expect(within(custom).getByText("Acme Reports")).toBeVisible();
  expect(screen.queryByText(/No connectors matching/u)).toBeNull();
});

test.each(["admin", "member"] as const)(
  "Keep zero-custom navigation and role-specific creation for %s",
  async (role) => {
    mockCustomConnectorStory(context);
    context.mocks.data.org({ id: "org_1", name: "Test Org", role });
    mockPublicConnectorStatus(context, [
      publicStatusItem({ connectorSlug: "github", label: "GitHub" }),
    ]);
    await setupPage({
      context,
      path: "/connectors",
      featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: true },
    });
    await waitFor(() => {
      expect(getConnectorCard("GitHub")).toBeVisible();
    });
    // Browsing the catalog no longer trails a Custom block, whatever the role.
    expect(screen.queryByRole("region", { name: "Custom" })).toBeNull();
    click(screen.getByTestId("connectors-scope-custom"));
    await expect(
      screen.findByRole("region", { name: "Custom" }),
    ).resolves.toBeVisible();
    expect(locationSearch()).toContain("scope=custom");
    expect(queryConnectorCard("GitHub")).toBeNull();
    expect(
      screen.getByText(
        role === "admin"
          ? "Add an HTTP API or MCP server for your organization to use."
          : "Your org hasn't registered any custom connectors yet.",
      ),
    ).toBeVisible();
    expect(
      Boolean(queryConnectorAction("button", "New custom connector")),
    ).toBe(role === "admin");
  },
);

test("Honor Custom deep links, scoped search, and returning to All", async () => {
  installCustomDirectory();
  mockPublicConnectorStatus(context, [
    publicStatusItem({ connectorSlug: "github", label: "GitHub" }),
  ]);
  await setupPage({
    context,
    path: "/connectors?scope=custom&category=other&keywords=acme",
    featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: true },
  });
  await waitFor(() => {
    expect(getConnectorCard("Acme Reports")).toBeVisible();
  });
  expect(queryConnectorCard("GitHub")).toBeNull();
  // The segment says which scope is open, so the scope carries no breadcrumb.
  expect(screen.getByTestId("connectors-scope-custom")).toHaveAttribute(
    "data-checked",
  );
  expect(screen.queryByText("Discover / Custom")).toBeNull();
  await fill(screen.getByPlaceholderText("Find custom connectors"), "missing");
  await expect(
    screen.findByText("No custom connectors match your search."),
  ).resolves.toBeVisible();
  expect(getConnectorAction("button", "New custom connector")).toBeVisible();
  // Leaving a scope drops the controls that belonged to it, search included.
  click(screen.getByTestId("connectors-scope-discover"));
  await waitFor(() => {
    expect(getConnectorCard("GitHub")).toBeInTheDocument();
  });
  expect(locationSearch()).not.toContain("scope=");
  expect(locationSearch()).not.toContain("keywords=");
  expect(locationSearch()).not.toContain("category=");
  window.history.back();
  await expect(
    screen.findByText("No custom connectors match your search."),
  ).resolves.toBeVisible();
  expect(locationSearch()).toContain("scope=custom");
});

test("Keep category search scoped and offer All for a custom-only match", async () => {
  installCustomDirectory();
  await setupPage({
    context,
    path: "/connectors?category=engineering&keywords=acme",
    featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: true },
  });
  await expect(
    screen.findByText("No connectors match in this category."),
  ).resolves.toBeVisible();
  expect(queryConnectorCard("Acme Reports")).toBeNull();
  expect(queryConnectorAction("button", "New custom connector")).toBeNull();
  click(getConnectorAction("button", "Search all connectors"));
  await waitFor(() => {
    expect(getConnectorCard("Acme Reports")).toBeVisible();
  });
  expect(locationSearch()).toContain("keywords=acme");
});

test("Ignore obsolete connection filters in directory mode", async () => {
  installCustomDirectory();
  mockPublicConnectorStatus(context, [
    publicStatusItem({
      connectorSlug: "github",
      label: "GitHub",
      connected: false,
    }),
  ]);
  await setupPage({
    context,
    path: "/connectors?connection=connected",
    featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: true },
  });
  await waitFor(() => {
    expect(getConnectorCard("GitHub")).toBeVisible();
  });
  click(screen.getByTestId("connectors-scope-custom"));
  await waitFor(() => {
    expect(locationSearch()).toContain("scope=custom");
  });
  expect(getConnectorCard("Acme Reports")).toBeInTheDocument();
  expect(locationSearch()).not.toContain("connection=");
});

test("Preserve old connection filters and Custom tabs with directory disabled", async () => {
  installCustomDirectory();
  mockPublicConnectorStatus(context, [
    publicStatusItem({
      connectorSlug: "github",
      label: "GitHub",
      connected: false,
    }),
  ]);
  await setupPage({
    context,
    path: "/connectors?connection=connected",
    featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: false },
  });
  await expect(
    screen.findByText("No connected connectors"),
  ).resolves.toBeVisible();
  click(getConnectorAction("tab", "Custom"));
  await waitFor(() => {
    expect(getConnectorCard("Acme Reports")).toBeVisible();
  });
  expect(getConnectorAction("button", "New connector")).toBeVisible();
  expect(queryConnectorAction("button", "New custom connector")).toBeNull();
  expect(screen.queryByPlaceholderText("Find connectors")).toBeNull();
});

test("Keep Custom usable while catalog loading fails, then recover", async () => {
  installCustomDirectory();
  let failing = true;
  context.mocks.api(connectorCatalogContract.discovery, ({ respond }) => {
    return failing
      ? respond(500, {
          error: {
            code: "INTERNAL_SERVER_ERROR",
            message: "Catalog unavailable",
          },
        })
      : respond(200, {
          connectors: [
            publicStatusItem({ connectorSlug: "github", label: "GitHub" }),
          ],
          totalConnectorCount: 1,
        });
  });
  await setupPage({
    context,
    path: "/connectors",
    featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: true },
  });
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Couldn't load built-in connectors.");
  // The other scope is a different page and does not go down with the catalog.
  click(screen.getByTestId("connectors-scope-custom"));
  await waitFor(() => {
    expect(getConnectorCard("Acme Reports")).toBeInTheDocument();
  });
  click(screen.getByTestId("connectors-scope-discover"));
  failing = false;
  const stillFailing = await screen.findByRole("alert");
  click(getConnectorAction("button", "Retry", stillFailing));
  await waitFor(() => {
    expect(getConnectorCard("GitHub")).toBeVisible();
  });
  expect(screen.queryByText("Couldn't load built-in connectors.")).toBeNull();
});

test("Do not turn Custom loading failure into an empty search result", async () => {
  installCustomDirectory();
  let failing = true;
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return failing
      ? respond(500, {
          error: {
            code: "INTERNAL_SERVER_ERROR",
            message: "Custom unavailable",
          },
        })
      : respond(200, {
          connectors: [customConnector({ displayName: "Recovered Service" })],
        });
  });
  await setupPage({
    context,
    path: "/connectors?keywords=recovered",
    featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: true },
  });
  const section = await screen.findByRole("region", {
    name: "Custom",
  });
  await expect(
    within(section).findByText("Couldn't load custom connectors."),
  ).resolves.toBeVisible();
  expect(screen.queryByText(/No connectors matching/u)).toBeNull();
  failing = false;
  click(getConnectorAction("button", "Retry", section));
  await waitFor(() => {
    expect(getConnectorCard("Recovered Service")).toBeVisible();
  });
});

test("Wait for pending Custom results before declaring search empty", async () => {
  installCustomDirectory();
  const ready = context.mocks.deferred<void>();
  context.mocks.api(customConnectorsContract.list, async ({ respond }) => {
    await ready.promise;
    return respond(200, {
      connectors: [customConnector({ displayName: "Acme Reports" })],
    });
  });
  await setupPage({
    context,
    path: "/connectors?keywords=acme",
    featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: true },
  });
  await expect(screen.findByText("Loading connectors…")).resolves.toBeVisible();
  expect(screen.queryByText(/No connectors matching/u)).toBeNull();
  click(screen.getByTestId("connectors-scope-custom"));
  click(getConnectorAction("button", "New custom connector"));
  const dialog = await screen.findByRole("dialog", {
    name: "New custom connector",
  });
  ready.resolve();
  await waitFor(() => {
    expect(getConnectorCard("Acme Reports")).toBeInTheDocument();
  });
  expect(dialog).toBeVisible();
  // Cancelling leaves the location exactly as the scope left it.
  const beforeCancel = locationSearch();
  click(getConnectorAction("button", "Cancel", dialog));
  expect(locationSearch()).toBe(beforeCancel);
});

test("Keep SSH and Custom in separate sections and scope Remote access", async () => {
  installCustomDirectory();
  context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 0 });
  });
  await setupPage({
    context,
    path: "/connectors",
    featureSwitches: {
      [FeatureSwitchKey.ConnectorDirectory]: true,
    },
  });
  const remote = await screen.findByTestId("connector-category-remote-access");
  expect(within(remote).queryByText("Acme Reports")).toBeNull();
  expect(screen.queryByRole("region", { name: "Custom" })).toBeNull();
  click(getConnectorAction("button", "Filter connectors"));
  click(getConnectorAction("menuitem", "Remote access"));
  await waitFor(() => {
    expect(locationSearch()).toContain("category=remote-access");
  });
  expect(screen.getByTestId("connector-category-remote-access")).toBeVisible();
  expect(screen.queryByRole("region", { name: "Custom" })).toBeNull();
  expect(queryConnectorAction("button", "New custom connector")).toBeNull();
});

test.each([false, true])(
  "Cancel and create without changing off-mode navigation (%s)",
  async (directory) => {
    mockCustomConnectorStory(context);
    mockPublicConnectorStatus(context, []);
    await setupPage({
      context,
      path: directory
        ? "/connectors?scope=custom&keywords=missing"
        : "/connectors?tab=custom&keywords=missing",
      featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: directory },
    });
    const label = directory ? "New custom connector" : "New connector";
    const open = await waitFor(() => {
      return getConnectorAction("button", label);
    });
    click(open);
    const cancelled = await screen.findByRole("dialog", {
      name: "New custom connector",
    });
    click(getConnectorAction("button", "Cancel", cancelled));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(locationSearch()).toContain("keywords=missing");
    click(getConnectorAction("button", label));
    const create = await screen.findByRole("dialog", {
      name: "New custom connector",
    });
    await fill(
      within(create).getByLabelText("Display name"),
      "Created Service",
    );
    await fill(
      within(create).getByLabelText(/Prefixes/u),
      "https://created.test/",
    );
    click(getConnectorAction("button", "Add authentication", create));
    click(
      await waitFor(() => {
        return getConnectorAction("menuitem", "API authentication");
      }),
    );
    await waitFor(() => {
      expect(getConnectorAction("button", "Create", create)).toBeEnabled();
    });
    click(getConnectorAction("button", "Create", create));
    const card = await waitFor(() => {
      return getConnectorCard("Created Service");
    });
    expect(card).toHaveTextContent("No accounts");
    expect(locationSearch()).toContain(
      directory ? "scope=custom" : "tab=custom",
    );
    expect(locationSearch().includes("keywords=missing")).toBe(!directory);
    await waitFor(() => {
      expect(
        document.activeElement instanceof HTMLElement &&
          document.activeElement.dataset.customConnectorId !== undefined,
      ).toBe(directory);
    });
  },
);

test("Search custom display names without matching endpoints or slugs", async () => {
  installCustomDirectory();
  await setupPage({
    context,
    path: "/connectors?keywords=%20aCmE%20%20",
    featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: true },
  });
  await waitFor(() => {
    expect(getConnectorCard("Acme Reports")).toBeVisible();
  });
  expect(queryConnectorCard("Other Service")).toBeNull();
  expect(screen.queryByText(/No connectors matching/u)).toBeNull();
  await fill(screen.getByPlaceholderText("Find connectors"), "hidden-slug");
  await expect(
    screen.findByText(/No connectors matching/u),
  ).resolves.toBeVisible();
  expect(queryConnectorCard("Acme Reports")).toBeNull();
  click(getConnectorAction("button", "New custom connector"));
  await expect(
    screen.findByRole("dialog", { name: "New custom connector" }),
  ).resolves.toBeVisible();
});
