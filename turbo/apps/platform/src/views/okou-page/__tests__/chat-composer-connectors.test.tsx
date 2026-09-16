import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { userConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, describe, beforeEach, it } from "vitest";

import {
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  ACME_CONNECTOR_ID,
  accountSummary,
  builtinConnector,
  connectorAccount,
  DEEPWIKI_CONNECTOR_ID,
  FEISHU_CONNECTOR_ID,
  httpConnector,
  installComposerConnectorFixture,
  manualAuthMethod,
  mcpConnector,
  noAuthMethod,
  oauthAuthMethod,
  ORDINARY_CONNECTOR_ID,
  permissionDetail,
  SCOUT_AGENT_ID,
} from "./chat-composer-connectors-test-helpers.ts";
import { mockConnectorPopoverLayout } from "./chat-composer-connector-popover-layout-test-helpers.ts";
import {
  context,
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";

const GITHUB_SLUG = "github" as ConnectorSlug;
const GMAIL_SLUG = "gmail" as ConnectorSlug;
const AXIOM_SLUG = "axiom" as ConnectorSlug;
const GOOGLE_ANALYTICS_SLUG = "google-analytics" as ConnectorSlug;
const PUBLIC_STRIPE_SLUG = "stripe-public" as ConnectorSlug;

function searchableConnectorCatalog() {
  return [
    builtinConnector({ slug: GITHUB_SLUG, label: "GitHub" }),
    builtinConnector({ slug: GMAIL_SLUG, label: "Gmail" }),
    ...Array.from({ length: 19 }, (_, index) => {
      return builtinConnector({
        slug: `overflow-${index + 1}` as ConnectorSlug,
        label: `Overflow ${index + 1}`,
      });
    }),
  ];
}

async function loadComposer(): Promise<void> {
  await expect(screen.findByTestId("start-cards")).resolves.toBeVisible();
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

function accessRow(control: HTMLElement): HTMLElement {
  const row = control.closest(".flex.h-10");
  if (!(row instanceof HTMLElement)) {
    throw new Error("Connector access row not found");
  }
  return row;
}

function normalizedText(element: Element): string {
  return element.textContent?.replace(/\s+/gu, " ").trim() ?? "";
}

function buttonIndex(
  name: string,
  container: ParentNode = document.body,
): number {
  return queryAllByRoleFast("button", container).findIndex((button) => {
    return (
      button.getAttribute("aria-label") === name ||
      normalizedText(button) === name
    );
  });
}

function createAuthWindow(): Window {
  const authWindow = context.mocks.browser.authWindow();
  Object.defineProperty(authWindow, "location", {
    configurable: true,
    value: { href: "about:blank" },
  });
  return authWindow;
}

function popoverSide(
  popover: HTMLElement,
  trigger: HTMLElement,
): "bottom" | "overlapping" | "top" {
  const popoverRect = popover.getBoundingClientRect();
  const triggerRect = trigger.getBoundingClientRect();
  if (popoverRect.bottom <= triggerRect.top) {
    return "top";
  }
  if (popoverRect.top >= triggerRect.bottom) {
    return "bottom";
  }
  return "overlapping";
}

async function filterConnectorMenu(
  user: ReturnType<typeof userEvent.setup>,
  searchInput: HTMLElement,
  notifyResize: () => void,
): Promise<void> {
  await user.type(searchInput, "gmail");
  await waitFor(() => {
    expect(screen.queryByText("GitHub")).not.toBeInTheDocument();
    expect(screen.getByText("Gmail")).toBeInTheDocument();
  });
  act(notifyResize);
}

async function clearConnectorFilter(
  user: ReturnType<typeof userEvent.setup>,
  notifyResize: () => void,
): Promise<void> {
  await user.keyboard("{Control>}a{/Control}{Backspace}");
  await expect(screen.findByText("GitHub")).resolves.toBeVisible();
  act(notifyResize);
}

async function prepareScrollableDesktopConnectorMenu() {
  const user = userEvent.setup({ delay: null });
  const layout = mockConnectorPopoverLayout({
    viewport: { width: 1000, height: 520 },
    trigger: { x: 320, y: 320, width: 32, height: 32 },
  });
  installComposerConnectorFixture({
    catalog: searchableConnectorCatalog(),
    builtinAuthorizations: { [SCOUT_AGENT_ID]: [GITHUB_SLUG] },
  });
  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
  });
  await loadComposer();
  const trigger = await findFastControl("button", "Connectors");
  await openConnectors(user);
  const searchInput = await screen.findByPlaceholderText(/Find connectors/u);
  const popover = await screen.findByRole("dialog", { name: "Connectors" });
  act(layout.notifyResize);
  const connectorList = await screen.findByRole("list", {
    name: "Connectors",
  });
  const expandedListHeight = connectorList.clientHeight;
  await waitFor(() => {
    expect(popoverSide(popover, trigger)).toBe("top");
  });
  expect(connectorList.scrollHeight).toBeGreaterThan(
    connectorList.clientHeight,
  );
  return {
    user,
    searchInput,
    layout,
    popover,
    trigger,
    connectorList,
    expandedListHeight,
  };
}

describe("with an open desktop connector menu", () => {
  async function prepareScenario() {
    const {
      user,
      searchInput,
      layout,
      popover,
      trigger,
      connectorList,
      expandedListHeight,
    } = await prepareScrollableDesktopConnectorMenu();
    return {
      user,
      searchInput,
      layout,
      popover,
      trigger,
      connectorList,
      expandedListHeight,
    };
  }
  let preparedScenario: Awaited<ReturnType<typeof prepareScenario>>;
  beforeEach(async () => {
    preparedScenario = await prepareScenario();
  });
  it("keep the desktop connector menu above while filtering", async () => {
    const {
      user,
      searchInput,
      layout,
      popover,
      trigger,
      connectorList,
      expandedListHeight,
    } = preparedScenario;
    await filterConnectorMenu(user, searchInput, layout.notifyResize);
    await waitFor(() => {
      expect(popoverSide(popover, trigger)).toBe("top");
      expect(connectorList.clientHeight).toBe(expandedListHeight);
      expect(connectorList.scrollHeight).toBe(connectorList.clientHeight);
      expect(screen.getByText("Add connectors")).toBeInTheDocument();
    });
  });
});

test("Keep the desktop connector menu above after clearing its filter", async () => {
  const { user, searchInput, layout, popover, trigger, connectorList } =
    await prepareScrollableDesktopConnectorMenu();
  await filterConnectorMenu(user, searchInput, layout.notifyResize);
  await waitFor(() => {
    expect(connectorList.scrollHeight).toBe(connectorList.clientHeight);
  });
  await clearConnectorFilter(user, layout.notifyResize);
  await waitFor(() => {
    expect(popoverSide(popover, trigger)).toBe("top");
    expect(connectorList.scrollHeight).toBeGreaterThan(
      connectorList.clientHeight,
    );
  });
});

test("Keep collision-selected connector menu below while filtering on mobile", async () => {
  const user = userEvent.setup({ delay: null });
  const layout = mockConnectorPopoverLayout({
    viewport: { width: 390, height: 700 },
    trigger: { x: 24, y: 220, width: 32, height: 32 },
  });
  installComposerConnectorFixture({
    catalog: searchableConnectorCatalog(),
    builtinAuthorizations: { [SCOUT_AGENT_ID]: [GITHUB_SLUG] },
  });

  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
  });

  await loadComposer();
  const trigger = await findFastControl("button", "Connectors");
  await openConnectors(user);
  const searchInput = await screen.findByPlaceholderText(/Find connectors/u);
  const popover = await screen.findByRole("dialog", { name: "Connectors" });
  act(layout.notifyResize);
  await waitFor(() => {
    expect(popoverSide(popover, trigger)).toBe("bottom");
  });

  await filterConnectorMenu(user, searchInput, layout.notifyResize);
  await waitFor(() => {
    expect(popoverSide(popover, trigger)).toBe("bottom");
  });

  await clearConnectorFilter(user, layout.notifyResize);
  await waitFor(() => {
    expect(popoverSide(popover, trigger)).toBe("bottom");
  });
});

test("Keep connector actions available when search has no matches", async () => {
  const user = userEvent.setup({ delay: null });
  installComposerConnectorFixture({
    catalog: searchableConnectorCatalog(),
    builtinAuthorizations: { [SCOUT_AGENT_ID]: [GITHUB_SLUG] },
  });

  await setupPage({ context, path: `/agents/${SCOUT_AGENT_ID}/chat` });

  await loadComposer();
  await openConnectors(user);
  const searchInput = await screen.findByPlaceholderText(/Find connectors/u);
  await user.type(searchInput, "nonexistent connector");
  await waitFor(() => {
    expect(screen.queryByText("GitHub")).not.toBeInTheDocument();
    expect(screen.queryByText("Gmail")).not.toBeInTheDocument();
    expect(screen.getByText("Add connectors")).toBeVisible();
  });
  await user.click(await findFastControl("button", "Add connectors"));
  const catalog = await screen.findByRole("dialog", {
    name: /Available connectors/u,
  });
  expect(
    within(catalog).getByPlaceholderText("Find connectors..."),
  ).toBeVisible();
});

test("Show the filtered connector count in the add dialog", async () => {
  const user = userEvent.setup({ delay: null });
  installComposerConnectorFixture({
    catalog: [
      builtinConnector({
        slug: GITHUB_SLUG,
        label: "GitHub",
        connected: false,
      }),
      builtinConnector({
        slug: GMAIL_SLUG,
        label: "Gmail",
        connected: false,
      }),
    ],
    customConnectors: [
      httpConnector({
        id: ACME_CONNECTOR_ID,
        slug: "acme-search",
        displayName: "Acme Search",
        connected: false,
      }),
    ],
  });

  await setupPage({ context, path: `/agents/${SCOUT_AGENT_ID}/chat` });

  await loadComposer();
  await openConnectors(user);
  const catalog = await openAddConnectors(user);
  const search = within(catalog).getByPlaceholderText("Find connectors...");
  expect(
    within(catalog).getByRole("heading", {
      name: "Available connectors to connect (3)",
    }),
  ).toBeVisible();

  await fill(search, "Gmail");
  await waitFor(() => {
    expect(
      within(catalog).getByRole("heading", {
        name: "Available connectors to connect (1)",
      }),
    ).toBeVisible();
  });

  await fill(search, "Clueso");
  await waitFor(() => {
    expect(
      within(catalog).getByRole("heading", {
        name: "Available connectors to connect (0)",
      }),
    ).toBeVisible();
  });

  await fill(search, "");
  await waitFor(() => {
    expect(
      within(catalog).getByRole("heading", {
        name: "Available connectors to connect (3)",
      }),
    ).toBeVisible();
  });
});

test("Configure connector permissions from the composer", async () => {
  const user = userEvent.setup({ delay: null });
  const axiom = builtinConnector({
    slug: AXIOM_SLUG,
    label: "Axiom",
    hasPermissions: true,
  });
  installComposerConnectorFixture({
    catalog: [axiom],
    builtinAuthorizations: { [SCOUT_AGENT_ID]: [AXIOM_SLUG] },
    permissionDetails: new Map([
      [
        AXIOM_SLUG,
        permissionDetail(AXIOM_SLUG, "Axiom", ["annotations|create"]),
      ],
    ]),
  });

  await setupPage({ context, path: `/agents/${SCOUT_AGENT_ID}/chat` });

  await loadComposer();
  await openConnectors(user);
  await user.click(
    await findFastControl("button", "Configure Axiom permissions"),
  );
  const dialog = await screen.findByRole("dialog", {
    name: /Axiom permissions.*Scout/u,
  });
  expect(queryFastControl("button", "Add connectors")).toBeNull();
  const permission = within(dialog).getByText("annotations|create");
  const row = permission.closest(".flex.items-center");
  if (!(row instanceof HTMLElement)) {
    throw new Error("Permission row not found");
  }
  await user.click(await findFastControl("button", "Deny", row));
  await expect(
    findFastControl("button", "Apply", dialog),
  ).resolves.toBeEnabled();
  await user.click(await findFastControl("button", "Cancel", dialog));
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: /Axiom permissions.*Scout/u }),
    ).toBeNull();
    expect(queryFastControl("button", "Add connectors")).toBeNull();
  });
});

test("Connect a custom connector for only the active agent", async () => {
  const user = userEvent.setup({ delay: null });
  const fixture = installComposerConnectorFixture({
    customConnectors: [
      httpConnector({
        id: ACME_CONNECTOR_ID,
        slug: "acme-search",
        displayName: "Acme Search",
        connected: false,
      }),
    ],
  });

  await setupPage({ context, path: `/agents/${SCOUT_AGENT_ID}/chat` });

  await loadComposer();
  await openConnectors(user);
  let catalog = await openAddConnectors(user);
  expect(within(catalog).getByText("https://api.example.test/")).toBeVisible();
  await user.click(
    await findFastControl("button", "Connect Acme Search", catalog),
  );
  let secret = await screen.findByLabelText("Secret");
  expect(secret).toHaveValue("");
  await user.type(secret, "discarded-secret");
  await user.click(await findFastControl("button", "Cancel"));

  await ensureConnectorsOpen(user);
  catalog = await openAddConnectors(user);
  await user.click(
    await findFastControl("button", "Connect Acme Search", catalog),
  );
  secret = await screen.findByLabelText("Secret");
  expect(secret).toHaveValue("");
  await user.type(secret, "scout-secret");
  await user.click(await findFastControl("button", "Save"));

  await waitFor(() => {
    expect(fixture.customValueRequests).toStrictEqual([
      {
        connectorId: ACME_CONNECTOR_ID,
        values: [{ key: "secret", kind: "secret", value: "scout-secret" }],
      },
    ]);
    expect(fixture.customAuthorizationUpdates).toStrictEqual([
      {
        agentId: SCOUT_AGENT_ID,
        grants: [
          {
            customConnectorId: ACME_CONNECTOR_ID,
            permissionNames: [],
          },
        ],
        operation: "add",
      },
    ]);
  });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  await ensureConnectorsOpen(user);
  await expect(
    screen.findByLabelText("Remove Acme Search"),
  ).resolves.toBeVisible();
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
    builtinAuthorizations: {
      [SCOUT_AGENT_ID]: [AXIOM_SLUG, GITHUB_SLUG],
    },
    accountSummaries: [
      accountSummary(axiomTarget, axiomAccounts),
      accountSummary(githubTarget, [githubAccount]),
    ],
    accounts: [...axiomAccounts, githubAccount],
  });

  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
  });

  await loadComposer();
  await openConnectors(user);
  const accountAction = await findFastControl(
    "button",
    "Axiom · Using default account: Work",
  );
  const permissionAction = await findFastControl(
    "button",
    "Configure Axiom permissions",
  );
  const axiomRow = accessRow(await screen.findByLabelText("Remove Axiom"));
  expect(axiomRow).toContainElement(accountAction);
  expect(axiomRow).toContainElement(permissionAction);
  expect(
    buttonIndex(accountAction.getAttribute("aria-label")!, axiomRow),
  ).toBeLessThan(buttonIndex("Configure Axiom permissions", axiomRow));
  const githubRow = accessRow(await screen.findByLabelText("Remove GitHub"));
  expect(queryAllByRoleFast("button", githubRow)).toHaveLength(0);

  await user.click(screen.getByLabelText("Remove Axiom"));
  await expect(screen.findByLabelText("Add Axiom")).resolves.toBeVisible();
  expect(
    screen.queryByRole("dialog", { name: /Axiom permissions/u }),
  ).toBeNull();
  expect(accessRow(screen.getByLabelText("Add Axiom"))).toBe(axiomRow);
});

test("Use the shortest valid connector setup from chat", async () => {
  const user = userEvent.setup({ delay: null });
  const fixture = installComposerConnectorFixture({
    catalog: [
      builtinConnector({
        slug: GOOGLE_ANALYTICS_SLUG,
        label: "Google Analytics",
        connected: false,
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
  await user.type(
    within(catalog).getByPlaceholderText("Find connectors..."),
    "Google Analytics",
  );
  await user.click(
    await findFastControl("button", "Connect Google Analytics", catalog),
  );
  await waitFor(() => {
    expect(fixture.oauthConnectionRequests).toHaveLength(1);
    expect(fixture.oauthConnectionRequests[0]).toMatchObject({
      connectorSlug: GOOGLE_ANALYTICS_SLUG,
      authMethod: "oauth",
      agentId: SCOUT_AGENT_ID,
      authorizeAgent: true,
    });
    expect(authWindow.location.href).toBe(
      "https://accounts.example.test/google-analytics",
    );
  });
  expect(browserOpen.calls).toHaveLength(1);
  expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(1);
  expect(screen.queryByRole("dialog", { name: "Google Analytics" })).toBeNull();
  expect(within(catalog).getByRole("status")).toHaveTextContent(
    "Connecting...",
  );
  expect(
    within(catalog).getByPlaceholderText("Find connectors..."),
  ).toBeVisible();
  expect(
    screen.queryByRole("dialog", { name: "Connecting your account" }),
  ).toBeNull();
  authWindow.close();
  await waitFor(() => {
    expect(within(catalog).queryByRole("status")).toBeNull();
  });
  await expect(
    findFastControl("button", "Connect Google Analytics", catalog),
  ).resolves.toBeEnabled();
  expect(
    within(catalog).getByPlaceholderText("Find connectors..."),
  ).toHaveValue("Google Analytics");
});

test.each([null, "Close", "Escape", "backdrop"] as const)(
  "Keep chat OAuth in one dialog through completion (dismissal: %s)",
  async (dismissal) => {
    const user = userEvent.setup({ delay: null });
    const fixture = installComposerConnectorFixture({
      catalog: [
        builtinConnector({
          slug: GOOGLE_ANALYTICS_SLUG,
          label: "Google Analytics",
          connected: false,
          authMethods: [oauthAuthMethod()],
        }),
      ],
    });
    const authorizationStarted = context.mocks.deferred<void>();
    const authorization = context.mocks.deferred<void>();
    let connected = false;
    context.mocks.api(userConnectorsContract.get, ({ respond }) => {
      return respond(200, {
        enabledConnectorSlugs: connected ? [GOOGLE_ANALYTICS_SLUG] : [],
      });
    });
    context.mocks.api(
      userConnectorsContract.update,
      async ({ body, respond }) => {
        authorizationStarted.resolve();
        await authorization.promise;
        return respond(200, {
          enabledConnectorSlugs: body.enabledConnectorSlugs,
        });
      },
    );
    const authWindow = createAuthWindow();
    const browserOpen = context.mocks.browser.open(authWindow);
    await setupPage({ context, path: `/agents/${SCOUT_AGENT_ID}/chat` });

    await loadComposer();
    await openConnectors(user);
    const catalog = await openAddConnectors(user);
    await user.click(
      await findFastControl("button", "Connect Google Analytics", catalog),
    );
    await waitFor(() => {
      expect(authWindow.location.href).toBe(
        "https://accounts.example.test/google-analytics",
      );
    });
    expect(within(catalog).getByRole("status")).toHaveTextContent(
      "Connecting...",
    );
    expect(
      within(catalog).getByPlaceholderText("Find connectors..."),
    ).toBeVisible();
    expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(1);

    if (dismissal) {
      if (dismissal === "Close") {
        await user.click(within(catalog).getByLabelText("Close"));
      } else if (dismissal === "Escape") {
        await user.keyboard("{Escape}");
      } else {
        const viewport = catalog.closest('[data-slot="dialog-viewport"]');
        if (!(viewport instanceof HTMLElement)) {
          throw new Error("Expected the connector directory viewport");
        }
        await user.click(viewport);
      }
    }
    await waitFor(() => {
      expect(screen.queryAllByRole("dialog", { hidden: true })).toHaveLength(
        dismissal ? 0 : 1,
      );
    });
    expect(authWindow.closed).toBeFalsy();

    const account = connectorAccount({
      id: "f0000000-0000-4000-a000-000000000064",
      target: { kind: "builtin", connectorSlug: GOOGLE_ANALYTICS_SLUG },
      displayName: "Work",
      isDefault: true,
    });
    connected = true;
    context.mocks.data.connectors([
      { ...account, slug: GOOGLE_ANALYTICS_SLUG },
    ]);
    fixture.completeOAuth(account.id);
    authWindow.close();
    await authorizationStarted.promise;
    expect(screen.queryAllByRole("dialog", { hidden: true })).toHaveLength(
      dismissal ? 0 : 1,
    );
    expect(screen.queryAllByText("Connecting...")).toHaveLength(
      dismissal ? 0 : 1,
    );
    authorization.resolve();
    await expect(
      screen.findByText("Google Analytics connected and authorized for Scout"),
    ).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryAllByRole("dialog", { hidden: true })).toHaveLength(0);
    });
    expect(browserOpen.calls).toHaveLength(1);
  },
);

test("Keep a reopened connector directory usable while chat OAuth is pending", async () => {
  const user = userEvent.setup({ delay: null });
  installComposerConnectorFixture({
    catalog: [
      builtinConnector({
        slug: GOOGLE_ANALYTICS_SLUG,
        label: "Google Analytics",
        connected: false,
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
  await user.click(
    await findFastControl("button", "Connect Google Analytics", catalog),
  );
  await waitFor(() => {
    expect(authWindow.location.href).toBe(
      "https://accounts.example.test/google-analytics",
    );
  });
  await user.click(within(catalog).getByLabelText("Close"));
  await waitFor(() => {
    expect(screen.queryAllByRole("dialog", { hidden: true })).toHaveLength(0);
  });
  expect(authWindow.closed).toBeFalsy();

  await openConnectors(user);
  const reopened = await openAddConnectors(user);
  await waitFor(() => {
    expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(1);
  });
  const connect = await findFastControl(
    "button",
    "Connect Google Analytics",
    reopened,
  );
  expect(connect).toHaveAttribute("aria-disabled", "true");
  await user.click(connect);
  expect(browserOpen.calls).toHaveLength(1);
  expect(within(reopened).getByRole("status")).toHaveTextContent(
    "Connecting...",
  );

  authWindow.close();
  await waitFor(() => {
    expect(connect).not.toHaveAttribute("aria-disabled", "true");
  });
  expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(1);
});

test("Respect integration-managed connector availability in chat", async () => {
  const user = userEvent.setup({ delay: null });
  const feishu = httpConnector({
    id: FEISHU_CONNECTOR_ID,
    slug: "feishu",
    displayName: "Feishu",
    connected: true,
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
    customAuthorizations: {
      [SCOUT_AGENT_ID]: [
        { customConnectorId: FEISHU_CONNECTOR_ID, permissionNames: [] },
      ],
    },
    accountSummaries: [accountSummary(target, accounts)],
    accounts,
  });

  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
  });

  await loadComposer();
  await openConnectors(user);
  await expect(screen.findByLabelText("Remove Feishu")).resolves.toBeVisible();
  expect(
    queryFastControl("button", "Feishu · Using default account: Primary"),
  ).toBeNull();
});

test("Require a permission choice before adding a permissioned custom connector", async () => {
  const user = userEvent.setup({ delay: null });
  const fixture = installComposerConnectorFixture({
    customConnectors: [
      httpConnector({
        id: ACME_CONNECTOR_ID,
        slug: "acme-search",
        displayName: "Acme Search",
        connected: true,
        permissionBundleRef: "builtin:acme-search@1",
      }),
    ],
  });

  await setupPage({ context, path: `/agents/${SCOUT_AGENT_ID}/chat` });

  await loadComposer();
  await openConnectors(user);
  await user.click(screen.getByLabelText("Add Acme Search"));
  await waitFor(() => {
    expect(fixture.customAuthorizationUpdates).toHaveLength(0);
    expect(screen.getByLabelText("Add Acme Search")).toBeVisible();
  });
});

test.each(["manual", "multiple"] as const)(
  "Search beyond featured connectors from chat (%s auth)",
  async (auth) => {
    const user = userEvent.setup({ delay: null });
    installComposerConnectorFixture({
      catalog: [
        builtinConnector({
          slug: GITHUB_SLUG,
          label: "GitHub",
          connected: false,
        }),
        builtinConnector({
          slug: AXIOM_SLUG,
          label: "Axiom",
          connected: false,
          authMethods:
            auth === "manual"
              ? [manualAuthMethod()]
              : [oauthAuthMethod(), manualAuthMethod()],
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
    expect(catalog).not.toBeInTheDocument();
    expect(
      within(dialog).getByText("API Token", { selector: "label" }),
    ).toBeVisible();
  },
);

test("Add or remove a connected connector for the active agent", async () => {
  const user = userEvent.setup({ delay: null });
  const fixture = installComposerConnectorFixture({
    catalog: [builtinConnector({ slug: GITHUB_SLUG, label: "GitHub" })],
    customConnectors: [
      mcpConnector({
        id: DEEPWIKI_CONNECTOR_ID,
        slug: "deepwiki",
        displayName: "DeepWiki",
        connected: true,
      }),
    ],
    customAuthorizations: {
      [SCOUT_AGENT_ID]: [
        { customConnectorId: DEEPWIKI_CONNECTOR_ID, permissionNames: [] },
      ],
    },
  });

  await setupPage({
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.CustomConnectorMcp]: false },
  });

  await loadComposer();
  await openConnectors(user);
  await user.click(screen.getByLabelText("Add GitHub"));
  await expect(screen.findByLabelText("Remove GitHub")).resolves.toBeVisible();
  await user.click(screen.getByLabelText("Remove DeepWiki"));
  await waitFor(() => {
    expect(screen.queryByLabelText(/DeepWiki/u)).toBeNull();
  });
  expect(fixture.builtinAuthorizationUpdates).toStrictEqual([
    {
      agentId: SCOUT_AGENT_ID,
      connectorSlugs: [GITHUB_SLUG],
      operation: "add",
    },
  ]);
  expect(fixture.customAuthorizationUpdates).toStrictEqual([
    {
      agentId: SCOUT_AGENT_ID,
      grants: [
        { customConnectorId: DEEPWIKI_CONNECTOR_ID, permissionNames: [] },
      ],
      operation: "remove",
    },
  ]);
});

test("Exclude unconnected integration-managed connectors from chat setup", async () => {
  const user = userEvent.setup({ delay: null });
  installComposerConnectorFixture({
    customConnectors: [
      httpConnector({
        id: FEISHU_CONNECTOR_ID,
        slug: "feishu",
        displayName: "Feishu",
        connected: false,
        authMode: "oauth",
        providerAdapter: "feishu",
      }),
      httpConnector({
        id: ORDINARY_CONNECTOR_ID,
        slug: "acme-search",
        displayName: "Acme Search",
        connected: false,
      }),
    ],
  });

  await setupPage({ context, path: `/agents/${SCOUT_AGENT_ID}/chat` });

  await loadComposer();
  await openConnectors(user);
  const catalog = await openAddConnectors(user);
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
        connected: false,
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
        agentId: SCOUT_AGENT_ID,
        authorizeAgent: true,
      },
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  await ensureConnectorsOpen(user);
  await expect(
    screen.findByLabelText("Remove Public Stripe"),
  ).resolves.toBeVisible();
  expect(browserOpen.calls).toHaveLength(0);
});
