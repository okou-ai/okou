import { customConnectorsContract } from "@okouai/api-contracts/contracts/custom-connectors";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import { vncConnectionsContract } from "@okouai/api-contracts/contracts/vnc-connections";
import { vncCredentialsContract } from "@okouai/api-contracts/contracts/vnc-credentials";
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

test("Legacy tabs open remote and private management with directory disabled", async () => {
  installCustomDirectory();
  context.mocks.api(vncConnectionsContract.list, () => {
    throw new Error("VNC connections must stay disabled");
  });
  context.mocks.api(vncCredentialsContract.list, () => {
    throw new Error("VNC credentials must stay disabled");
  });
  await setupPage({
    context,
    path: "/connectors?tab=custom",
    featureSwitches: {
      [FeatureSwitchKey.ConnectorDirectory]: false,
      [FeatureSwitchKey.VncAccess]: false,
    },
  });
  await screen.findByText("Acme Reports");

  click(getConnectorAction("tab", "Remote control"));
  await screen.findByRole("heading", { name: "SSH" });
  expect(locationSearch()).toBe("?scope=remote-control");
  expect(screen.queryByRole("heading", { name: "VNC" })).toBeNull();
  expect(getConnectorAction("button", "Type: All")).toBeVisible();
  click(getConnectorAction("button", "Type: All"));
  const menu = await screen.findByRole("menu");
  expect(queryConnectorAction("menuitem", "VNC", menu)).toBeNull();

  click(getConnectorAction("tab", "Private network"));
  await screen.findByRole("heading", { name: "Cloudflare Access" });
  expect(locationSearch()).toBe("?scope=private-network");
  expect(screen.queryByRole("heading", { name: "SSH" })).toBeNull();

  click(getConnectorAction("tab", "Custom"));
  await screen.findByText("Acme Reports");
  expect(locationSearch()).toBe("?tab=custom");

  click(getConnectorAction("tab", "Built-in"));
  await screen.findByRole("heading", { name: "Remote access" });
  expect(locationSearch()).toBe("");
});

test("Legacy tab navigation returns directly to Remote control", async () => {
  installCustomDirectory();
  await setupPage({
    context,
    path: "/connectors",
    featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: false },
  });
  click(getConnectorAction("tab", "Remote control"));
  await screen.findByRole("heading", { name: "SSH" });
  click(getConnectorAction("tab", "Custom"));
  await screen.findByText("Acme Reports");
  expect(locationSearch()).toBe("?tab=custom");

  window.history.back();
  await waitFor(() => {
    expect(locationSearch()).toBe("?scope=remote-control");
    expect(getConnectorAction("tab", "Remote control")).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});

test("Legacy Remote control tab includes VNC when its switch is enabled", async () => {
  installCustomDirectory();
  context.mocks.api(vncConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 0 });
  });
  context.mocks.api(vncConnectionsContract.list, ({ respond }) => {
    return respond(200, { connections: [] });
  });
  context.mocks.api(vncCredentialsContract.list, ({ respond }) => {
    return respond(200, { credentials: [] });
  });
  await setupPage({
    context,
    path: "/connectors",
    featureSwitches: {
      [FeatureSwitchKey.ConnectorDirectory]: false,
      [FeatureSwitchKey.VncAccess]: true,
    },
  });

  click(getConnectorAction("tab", "Remote control"));
  await screen.findByRole("heading", { name: "VNC" });
  click(getConnectorAction("button", "Type: All"));
  const menu = await screen.findByRole("menu");
  expect(getConnectorAction("menuitem", "VNC", menu)).toBeVisible();
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

test("Keep Remote control and Custom in separate scopes", async () => {
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
  await screen.findByTestId("connectors-scope-remote-control");
  expect(screen.queryByTestId("connector-category-remote-access")).toBeNull();
  expect(screen.queryByRole("region", { name: "Custom" })).toBeNull();
  click(screen.getByTestId("connectors-scope-remote-control"));
  await waitFor(() => {
    expect(locationSearch()).toContain("scope=remote-control");
  });
  await waitFor(() => {
    return getConnectorAction("button", "Add host");
  });
  expect(screen.queryByRole("region", { name: "Custom" })).toBeNull();
  expect(queryConnectorAction("button", "New custom connector")).toBeNull();
});

test("Cancel and create a custom connector from the Custom scope", async () => {
  mockCustomConnectorStory(context);
  mockPublicConnectorStatus(context, []);
  await setupPage({
    context,
    path: "/connectors?scope=custom&keywords=missing",
    featureSwitches: { [FeatureSwitchKey.ConnectorDirectory]: true },
  });
  const label = "New custom connector";
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
  await fill(within(create).getByLabelText("Display name"), "Created Service");
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
  expect(locationSearch()).toContain("scope=custom");
});

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
