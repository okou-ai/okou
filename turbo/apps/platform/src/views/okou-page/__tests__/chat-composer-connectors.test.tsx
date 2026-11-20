import { testContext } from "../../../signals/__tests__/test-helpers.ts";

import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import {
  builtinConnector,
  connectorAccount,
  FEISHU_CONNECTOR_ID,
  httpConnector,
  manualAuthMethod,
  noAuthMethod,
  oauthAuthMethod,
  ORDINARY_CONNECTOR_ID,
  permissionDetail,
  SCOUT_AGENT_ID,
  createComposerConnectorHelpers,
} from "./chat-composer-connectors-test-helpers.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";

const context = testContext();
const { installComposerConnectorFixture } =
  createComposerConnectorHelpers(context);

const GITHUB_SLUG = "github" as ConnectorSlug;
const AXIOM_SLUG = "axiom" as ConnectorSlug;
const GOOGLE_ANALYTICS_SLUG = "google-analytics" as ConnectorSlug;
const PUBLIC_STRIPE_SLUG = "stripe-public" as ConnectorSlug;

async function loadComposer(): Promise<void> {
  await expect(findFastControl("button", "Connectors")).resolves.toBeVisible();
}

async function openConnectors(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  await user.click(await findFastControl("button", "Connectors"));
  await expect(
    findFastControl("button", "Add connectors"),
  ).resolves.toBeVisible();
}

async function ensureConnectorsOpen(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  if (!queryFastControl("button", "Add connectors")) {
    await openConnectors(user);
  }
}

async function openAddConnectors(
  user: ReturnType<typeof userEvent.setup>,
): Promise<HTMLElement> {
  await user.click(await findFastControl("button", "Add connectors"));
  const search = await screen.findByPlaceholderText("Find connectors...");
  const dialog = search.closest('[role="dialog"]');
  if (!(dialog instanceof HTMLElement)) {
    throw new Error("Available connector dialog not found");
  }
  return dialog;
}

async function openCustomConnectors(
  user: ReturnType<typeof userEvent.setup>,
): Promise<HTMLElement> {
  const dialog = await openAddConnectors(user);
  await user.click(within(dialog).getByRole("radio", { name: "Custom" }));
  return dialog;
}

function createAuthWindow(): Window {
  const authWindow = context.mocks.browser.authWindow();
  Object.defineProperty(authWindow, "location", {
    configurable: true,
    value: { href: "about:blank" },
  });
  return authWindow;
}

test("Configure connector permissions from the composer", async () => {
  const axiom = builtinConnector({
    slug: AXIOM_SLUG,
    label: "Axiom",
    hasPermissions: true,
  });
  installComposerConnectorFixture({
    catalog: [axiom],
    permissionDetails: new Map([
      [
        AXIOM_SLUG,
        permissionDetail(AXIOM_SLUG, "Axiom", ["annotations|create"]),
      ],
    ]),
  });

  await setupPage({ context, path: `/agents/${SCOUT_AGENT_ID}/chat` });

  click(await findFastControl("button", "Connectors"));
  click(await findFastControl("button", /^Axiom/u));
  click(await findFastControl("button", "Permissions"));
  const dialog = await screen.findByRole("dialog", {
    name: "Axiom permissions",
  });
  expect(queryFastControl("button", "Add connectors")).toBeNull();
  const permission = within(dialog).getByText("annotations|create");
  const row = permission.closest(".flex.items-center");
  if (!(row instanceof HTMLElement)) {
    throw new Error("Permission row not found");
  }
  click(await findFastControl("button", "Deny", row));
  await expect(
    findFastControl("button", "Apply", dialog),
  ).resolves.toBeEnabled();
  click(await findFastControl("button", "Cancel", dialog));
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Axiom permissions" }),
    ).toBeNull();
    expect(queryFastControl("button", "Add connectors")).toBeNull();
  });
});

test("Show only the connector actions that are useful in chat", async () => {
  const user = userEvent.setup({ delay: null });
  const axiom = builtinConnector({
    slug: AXIOM_SLUG,
    label: "Axiom",
    hasPermissions: true,
  });
  const github = builtinConnector({ slug: GITHUB_SLUG, label: "GitHub" });
  const axiomTarget = { kind: "builtin" as const, connectorSlug: AXIOM_SLUG };
  const githubTarget = {
    kind: "builtin" as const,
    connectorSlug: GITHUB_SLUG,
  };
  const axiomAccounts = [
    connectorAccount({
      id: "f0000000-0000-4000-a000-000000000071",
      target: axiomTarget,
      displayName: "Work",
      isDefault: true,
    }),
    connectorAccount({
      id: "f0000000-0000-4000-a000-000000000072",
      target: axiomTarget,
      displayName: "Personal",
      isDefault: false,
    }),
  ];
  const githubAccount = connectorAccount({
    id: "f0000000-0000-4000-a000-000000000073",
    target: githubTarget,
    displayName: "Work",
    isDefault: true,
  });
  installComposerConnectorFixture({
    catalog: [axiom, github],
    accounts: [...axiomAccounts, githubAccount],
  });

  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
  });

  await loadComposer();
  await openConnectors(user);
  await user.click(await findFastControl("button", /^Axiom/u));
  const axiomMenu = await screen.findByRole("dialog", { name: "Axiom" });
  expect(queryFastControl("button", "Permissions", axiomMenu)).toBeVisible();
  expect(
    within(axiomMenu).getByRole("switch", { name: "Work access" }),
  ).toBeChecked();
  expect(
    within(axiomMenu).getByRole("switch", { name: "Personal access" }),
  ).toBeChecked();
  await user.keyboard("{Escape}");
  await user.click(await findFastControl("button", /^GitHub/u));
  const githubMenu = await screen.findByRole("dialog", { name: "GitHub" });
  expect(queryFastControl("button", "Permissions", githubMenu)).toBeNull();
  expect(
    within(githubMenu).getByRole("switch", { name: "Work access" }),
  ).toBeVisible();
});

test("Start connector setup from chat", async () => {
  const user = userEvent.setup({ delay: null });
  const fixture = installComposerConnectorFixture({
    catalog: [
      builtinConnector({
        slug: GOOGLE_ANALYTICS_SLUG,
        label: "Google Analytics",
        hasAccount: false,
        authMethods: [oauthAuthMethod()],
      }),
    ],
  });
  const authWindow = createAuthWindow();
  const browserOpen = context.mocks.browser.open(authWindow);

  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
    featureSwitches: {},
  });

  await loadComposer();
  await openConnectors(user);
  const catalog = await openAddConnectors(user);
  await user.type(
    within(catalog).getByPlaceholderText("Find connectors..."),
    "Google Analytics",
  );
  const connect = await findFastControl(
    "button",
    "Connect Google Analytics",
    catalog,
  );
  expect(authWindow.location.href).toBe("about:blank");
  await user.click(connect);
  await waitFor(() => {
    expect(fixture.oauthConnectionRequests).toHaveLength(1);
    expect(fixture.oauthConnectionRequests[0]).toMatchObject({
      connectorSlug: GOOGLE_ANALYTICS_SLUG,
      authMethod: "oauth",
    });
    expect(authWindow.location.href).toBe(
      "https://accounts.example.test/google-analytics",
    );
  });
  expect(browserOpen.calls).toHaveLength(1);
  authWindow.close();
  await waitFor(() => {
    expect(
      queryFastControl("button", "Connect Google Analytics", catalog),
    ).toBeEnabled();
  });
  expect(
    within(catalog).getByPlaceholderText("Find connectors..."),
  ).toHaveValue("Google Analytics");
});

test("Complete connector authorization from chat", async () => {
  const user = userEvent.setup({ delay: null });
  const fixture = installComposerConnectorFixture({
    catalog: [
      builtinConnector({
        slug: GOOGLE_ANALYTICS_SLUG,
        label: "Google Analytics",
        hasAccount: false,
        authMethods: [oauthAuthMethod()],
      }),
    ],
  });
  const authWindow = createAuthWindow();
  const browserOpen = context.mocks.browser.open(authWindow);
  await setupPage({ context, path: `/agents/${SCOUT_AGENT_ID}/chat` });

  await loadComposer();
  await openConnectors(user);
  const catalog = await openAddConnectors(user);
  await fill(
    within(catalog).getByPlaceholderText("Find connectors..."),
    "Google Analytics",
  );
  await user.click(
    await findFastControl("button", "Connect Google Analytics", catalog),
  );
  await waitFor(() => {
    expect(authWindow.location.href).toBe(
      "https://accounts.example.test/google-analytics",
    );
  });
  expect(authWindow.closed).toBeFalsy();

  const account = connectorAccount({
    id: "f0000000-0000-4000-a000-000000000064",
    target: { kind: "builtin", connectorSlug: GOOGLE_ANALYTICS_SLUG },
    displayName: "Work",
    isDefault: true,
  });
  context.mocks.data.connectors([{ ...account, slug: GOOGLE_ANALYTICS_SLUG }]);
  fixture.completeOAuth(account.id);
  authWindow.close();
  await waitFor(() => {
    expect(catalog).not.toBeInTheDocument();
  });
  expect(browserOpen.calls).toHaveLength(1);
});

test("Respect integration-managed connector availability in chat", async () => {
  const user = userEvent.setup({ delay: null });
  const feishu = httpConnector({
    id: FEISHU_CONNECTOR_ID,
    slug: "feishu",
    displayName: "Feishu",
    hasAccount: true,
    authMode: "oauth",
    providerAdapter: "feishu",
  });
  const target = {
    kind: "custom" as const,
    customConnectorId: FEISHU_CONNECTOR_ID,
  };
  const accounts = [
    connectorAccount({
      id: "f0000000-0000-4000-a000-000000000081",
      target,
      displayName: "Primary",
      isDefault: true,
    }),
    connectorAccount({
      id: "f0000000-0000-4000-a000-000000000082",
      target,
      displayName: "Secondary",
      isDefault: false,
    }),
  ];
  installComposerConnectorFixture({
    customConnectors: [feishu],
    accounts,
  });

  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
  });

  await loadComposer();
  await openConnectors(user);
  click(await screen.findByText("Feishu"));
  const menu = await screen.findByRole("dialog", { name: "Feishu" });
  await expect(
    within(menu).findByRole("switch", { name: "Primary access" }),
  ).resolves.toBeChecked();
  await expect(
    within(menu).findByRole("switch", { name: "Secondary access" }),
  ).resolves.toBeChecked();
});

test("Search beyond featured connectors from chat", async () => {
  const user = userEvent.setup({ delay: null });
  installComposerConnectorFixture({
    catalog: [
      builtinConnector({
        slug: GITHUB_SLUG,
        label: "GitHub",
        hasAccount: false,
      }),
      builtinConnector({
        slug: AXIOM_SLUG,
        label: "Axiom",
        hasAccount: false,
        authMethods: [manualAuthMethod()],
      }),
    ],
    featuredConnectorSlugs: [GITHUB_SLUG],
  });

  await setupPage({ context, path: `/agents/${SCOUT_AGENT_ID}/chat` });

  await loadComposer();
  await openConnectors(user);
  const catalog = await openAddConnectors(user);
  expect(queryFastControl("button", "Connect Axiom", catalog)).toBeNull();
  await user.type(
    within(catalog).getByPlaceholderText("Find connectors..."),
    "Axiom",
  );
  await user.click(await findFastControl("button", "Connect Axiom", catalog));
  const dialog = await screen.findByRole("dialog", { name: "Axiom" });
  expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(1);
  expect(
    within(dialog).getByText("API Token", { selector: "label" }),
  ).toBeVisible();
});

test("Exclude unconnected integration-managed connectors from chat setup", async () => {
  const user = userEvent.setup({ delay: null });
  installComposerConnectorFixture({
    customConnectors: [
      httpConnector({
        id: FEISHU_CONNECTOR_ID,
        slug: "feishu",
        displayName: "Feishu",
        hasAccount: false,
        authMode: "oauth",
        providerAdapter: "feishu",
      }),
      httpConnector({
        id: ORDINARY_CONNECTOR_ID,
        slug: "acme-search",
        displayName: "Acme Search",
        hasAccount: false,
      }),
    ],
  });

  await setupPage({ context, path: `/agents/${SCOUT_AGENT_ID}/chat` });

  await loadComposer();
  await openConnectors(user);
  const catalog = await openCustomConnectors(user);
  await expect(
    findFastControl("button", "Connect Acme Search", catalog),
  ).resolves.toBeVisible();
  expect(queryFastControl("button", "Connect Feishu", catalog)).toBeNull();
  expect(within(catalog).queryByText("Feishu")).toBeNull();
});

test("Enable a credential-free connector directly from chat", async () => {
  const user = userEvent.setup({ delay: null });
  const fixture = installComposerConnectorFixture({
    catalog: [
      builtinConnector({
        slug: PUBLIC_STRIPE_SLUG,
        label: "Public Stripe",
        hasAccount: false,
        authMethods: [noAuthMethod()],
      }),
    ],
  });
  const browserOpen = context.mocks.browser.open(null);

  await setupPage({ context, path: `/agents/${SCOUT_AGENT_ID}/chat` });

  await loadComposer();
  await openConnectors(user);
  const catalog = await openAddConnectors(user);
  await user.click(
    await findFastControl("button", "Connect Public Stripe", catalog),
  );
  await waitFor(() => {
    expect(fixture.noAuthConnectionRequests).toStrictEqual([
      {
        connectorSlug: PUBLIC_STRIPE_SLUG,
        authMethod: "public",
      },
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  await ensureConnectorsOpen(user);
  await expect(
    findFastControl("button", /^Public Stripe/u),
  ).resolves.toBeVisible();
  expect(browserOpen.calls).toHaveLength(0);
});
