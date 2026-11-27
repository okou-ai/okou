import { chatConnectorAccessContract } from "@okouai/api-contracts/contracts/chat-connector-access";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import userEvent from "@testing-library/user-event";
import {
  namedMenuAccounts,
  openChatMenu,
} from "./composer-menu-page-fixture.ts";
import { screen, within, waitFor, fireEvent } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage, fill } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  SCOUT_THREAD_ID,
  builtinConnector,
  chatConnectorOverviewFixture,
  connectorAccount,
  createComposerConnectorHelpers,
  ACME_CONNECTOR_ID,
  FEISHU_CONNECTOR_ID,
  httpConnector,
  manualAuthMethod,
} from "./chat-composer-connectors-test-helpers.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import { connectedConnectorsContract } from "@okouai/api-contracts/contracts/connected-connectors";

const context = testContext();

const github = { kind: "builtin", connectorSlug: "github" } as const;
function githubAccounts() {
  const accounts = ["Work", "Personal", "Client"].map((name, i) => {
    return connectorAccount({
      id: "f0000000-0000-4000-a000-00000007820" + i,
      target: github,
      displayName: name,
      isDefault: i === 0,
    });
  });
  createComposerConnectorHelpers(context).installComposerConnectorFixture({
    catalog: [builtinConnector({ slug: "github", label: "GitHub" })],
    accounts,
  });
  return accounts;
}

test("chat-composer-connector-overview-008 opening account choices fetches details for the selected off-page account", async () => {
  const accounts = githubAccounts(),
    selected = accounts[1]!;
  const requested = context.mocks.deferred<string>();
  context.mocks.api(chatConnectorAccessContract.overview, ({ respond }) => {
    return respond(200, [
      {
        ...chatConnectorOverviewFixture({
          target: github,
          label: "GitHub",
          accounts,
        }),
        currentConnectionId: selected.id,
      },
    ]);
  });
  context.mocks.api(connectorAccountsContract.connections, ({ respond }) => {
    return respond(200, {
      connections: [accounts[0]!],
      defaultConnection: accounts[0]!,
      nextCursor: "page-two",
    });
  });
  context.mocks.api(
    connectorAccountsContract.connection,
    ({ params, respond }) => {
      if (!requested.settled()) {
        requested.resolve(params.connectionId);
      }
      return respond(200, {
        ...selected,
        connectionStatus: "reconnect-required",
      });
    },
  );
  await setupPage({ context, path: "/chats/" + SCOUT_THREAD_ID });
  click(await findFastControl("button", "Connectors"));
  const githubRow = await findFastControl("button", /GitHub/);
  expect(requested.settled()).toBeFalsy();
  click(githubRow);
  await expect(requested.promise).resolves.toBe(selected.id);
  const ui = within(await screen.findByRole("group", { name: "GitHub" }));
  await expect(
    ui.findByRole("switch", { name: /Personal/ }),
  ).resolves.toBeChecked();
  await expect(
    ui.findByText("Reconnect required"),
  ).resolves.toBeInTheDocument();
});

test("chat-composer-connector-overview-001 The same twenty connector choices remain available after closing the panel", async () => {
  const entries = namedMenuAccounts(context, "Connected tool", 20);
  let catalogAvailable = true;
  context.mocks.api(chatConnectorAccessContract.overview, ({ respond }) => {
    return catalogAvailable
      ? respond(200, entries)
      : respond(503, {
          error: {
            code: "UNAVAILABLE",
            message: "Directory currently unavailable",
          },
        });
  });
  const launcher = await openChatMenu(context);
  async function allChoices() {
    const menu = await screen.findByRole("dialog", { name: "Connectors" });
    await findFastControl("button", /Connected tool 19\b/, menu);
    for (const entry of entries) {
      expect(
        within(menu).getByText(entry.label, { exact: true }),
      ).toBeVisible();
    }
  }
  await allChoices();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(launcher).toHaveFocus();
  });
  catalogAvailable = false;
  click(launcher);
  await allChoices();
  expect(queryFastControl("button", "Try again")).toBeNull();
});

function twoProbeConnectors() {
  const targets = [
    github,
    { kind: "builtin", connectorSlug: "slack" },
  ] as const;
  const accounts = targets.map((target, index) => {
    return connectorAccount({
      id: crypto.randomUUID(),
      target,
      displayName: "Office " + (index + 1),
      isDefault: true,
    });
  });
  createComposerConnectorHelpers(context).installComposerConnectorFixture({
    threadId: SCOUT_THREAD_ID,
    accounts,
    catalog: targets.map((target, i) => {
      return builtinConnector({
        slug: target.connectorSlug,
        label: "Probe " + (i + 1),
      });
    }),
  });
  function entry(index: 0 | 1) {
    return chatConnectorOverviewFixture({
      target: targets[index],
      label: "Probe " + (index + 1),
      accounts,
    });
  }
  return [entry(0), entry(1)] as const;
}

test("chat-composer-connector-overview-003 a targeted account update, removal and continuity gap restore the current directory", async () => {
  const [first, second] = twoProbeConnectors();
  const off = {
    ...first,
    accounts: first.accounts.map((account) => {
      return {
        ...account,
        enabled: false,
        overrideEnabled: false,
      };
    }),
    currentConnectionId: null,
  };
  const recovered = { ...second, label: "Probe 2 after reconnect" };
  const updates: string[] = [];
  let remove = false;
  let afterGap = false;
  context.mocks.api(chatConnectorAccessContract.overview, ({ respond }) => {
    return respond(200, afterGap ? [recovered] : [first, second]);
  });
  context.mocks.api(
    chatConnectorAccessContract.overviewTarget,
    ({ query, respond }) => {
      if (query.kind !== "builtin") {
        return respond(200, { connector: null });
      }
      updates.push(query.connectorSlug);
      return respond(200, {
        connector:
          query.connectorSlug === "github" ? (remove ? null : off) : second,
      });
    },
  );
  const trigger = await openChatMenu(context);
  await findFastControl("button", /^Probe 1\b/);
  await findFastControl("button", /^Probe 2\b/);
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(trigger).toHaveFocus();
  });
  context.mocks.ably.trigger("connector:changed", { connectorSlug: "github" });
  await waitFor(() => {
    expect(updates).toContain("github");
  });
  click(trigger);
  click(await findFastControl("button", /^Probe 1\b/));
  const account = await screen.findByRole("switch", {
    name: "Office 1 access",
  });
  await waitFor(() => {
    expect(account).not.toBeChecked();
  });
  expect(new Set(updates)).toStrictEqual(new Set(["github"]));
  await userEvent.keyboard("{Escape}");
  remove = true;
  context.mocks.ably.trigger("connector:changed", { connectorSlug: "github" });
  await waitFor(() => {
    expect(queryFastControl("button", /^Probe 1\b/)).toBeNull();
    expect(queryFastControl("button", /^Probe 2\b/)).toBeVisible();
  });
  afterGap = true;
  context.mocks.ably.triggerChannelGap("user:test-user-123");
  await findFastControl("button", "Probe 2 after reconnect");
  expect(queryFastControl("button", /^Probe 1\b/)).toBeNull();
});

test("chat-composer-connector-overview-007 A failed account refresh can be retried while the other connector continues receiving updates", async () => {
  const [githubRow, slackRow] = twoProbeConnectors();
  let recovered = false;
  let changed = false;
  let disabled = false;
  const slack = () => {
    return {
      ...slackRow,
      label: changed ? "Probe 2 updated" : "Probe 2",
    };
  };
  context.mocks.api(chatConnectorAccessContract.overview, ({ respond }) => {
    return respond(200, [
      recovered ? { ...githubRow, label: "Probe 1 recovered" } : githubRow,
      slack(),
    ]);
  });
  context.mocks.api(
    chatConnectorAccessContract.overviewTarget,
    ({ query, respond }) => {
      if (query.kind === "builtin" && query.connectorSlug === "slack") {
        return respond(200, { connector: slack() });
      }
      if (!recovered) {
        return respond(503, {
          error: {
            code: "UNAVAILABLE",
            message: "Probe 1 refresh unavailable",
          },
        });
      }
      return respond(200, {
        connector: {
          ...githubRow,
          accounts: githubRow.accounts.map((a) => {
            return {
              ...a,
              enabled: !disabled,
              overrideEnabled: !disabled,
            };
          }),
          currentConnectionId: disabled ? null : githubRow.currentConnectionId,
        },
      });
    },
  );
  await openChatMenu(context);
  await findFastControl("button", /^Probe 1/);
  context.mocks.ably.trigger("connector:changed", { connectorSlug: "github" });
  await findFastControl("button", "Try again");
  await expect(findFastControl("button", /^Probe 1/)).resolves.toBeVisible();
  changed = true;
  context.mocks.ably.trigger("connector:changed", { connectorSlug: "slack" });
  await findFastControl("button", "Probe 2 updated");
  recovered = true;
  click(await findFastControl("button", "Try again"));
  await waitFor(() => {
    expect(queryFastControl("button", "Try again")).toBeNull();
  });
  await findFastControl("button", /^Probe 1 recovered/);
  disabled = true;
  context.mocks.ably.trigger("connector:changed", { connectorSlug: "github" });
  click(await findFastControl("button", /^Probe 1/));
  const toggle = await screen.findByRole("switch", { name: "Office 1 access" });
  await waitFor(() => {
    expect(toggle).not.toBeChecked();
  });
});

test("chat-composer-connector-overview-009 Browser back restores the connector directory for the original chat", async () => {
  const [account] = twoProbeConnectors();
  let title = "Probe 1";
  context.mocks.api(chatConnectorAccessContract.overview, ({ respond }) => {
    return respond(200, [{ ...account, label: title }]);
  });
  await openChatMenu(context);
  await findFastControl("button", /^Probe 1\b/);
  await userEvent.keyboard("{Escape}");
  const original = window.location.pathname;
  click(await findFastControl("link", /^New chat/));
  await waitFor(() => {
    expect(window.location.pathname).toBe("/");
  });
  title = "Probe 1 after return";
  context.mocks.ably.trigger("connector:changed", { connectorSlug: "github" });
  window.history.back();
  await waitFor(() => {
    expect(window.location.pathname).toBe(original);
  });
  click(await findFastControl("button", "Connectors"));
  await expect(
    findFastControl("button", /^Probe 1 after return/),
  ).resolves.toBeVisible();
});

function scrollTo(view: HTMLElement, position: number) {
  view.scrollTop = position;
  fireEvent.scroll(view);
}
async function accounts(n: number) {
  const label = `Scroll ${n}`;
  const overview = screen.getByRole("list", { name: "Connectors" });
  const text = await within(overview).findByText(label, { exact: true });
  const target = text.closest("button");
  if (!target) {
    throw new Error(`No account button contains ${label}`);
  }
  click(target);
  const panel = await screen.findByRole("group", { name: label });
  return { target, panel };
}
test("chat-composer-connector-scroll-001 Returning to either account panel starts at the top and preserves the overview position", async () => {
  namedMenuAccounts(context, "Scroll", 12);
  await openChatMenu(context);
  const overview = await screen.findByRole("list", { name: "Connectors" });
  scrollTo(overview, 180);
  const first = await accounts(7);
  expect(first.panel.scrollTop).toBe(0);
  scrollTo(first.panel, 140);
  expect(first.panel.scrollTop).toBe(140);
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    return expect(first.target).toHaveFocus();
  });
  expect(overview.scrollTop).toBe(180);
  expect((await accounts(7)).panel.scrollTop).toBe(0);
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    return expect(first.target).toHaveFocus();
  });
  expect(overview.scrollTop).toBe(180);
  scrollTo(overview, 220);
  expect((await accounts(8)).panel.scrollTop).toBe(0);
  expect(overview.scrollTop).toBe(220);
});
test("chat-composer-connector-scroll-003 A filtered result list starts at the top with focus in search", async () => {
  namedMenuAccounts(context, "Scroll", 30);
  await openChatMenu(context);
  const list = await screen.findByRole("list", { name: "Connectors" });
  scrollTo(list, 180);
  const { panel } = await accounts(7);
  expect(panel).toBeVisible();
  const search = screen.getByRole("textbox", { name: "Find connectors..." });
  await fill(search, "Scroll 2");
  await expect(findFastControl("button", /Scroll 2\b/)).resolves.toBeVisible();
  expect(screen.queryByRole("group", { name: "Scroll 7" })).toBeNull();
  expect(search).toHaveFocus();
  expect(screen.getByRole("list", { name: "Connectors" }).scrollTop).toBe(0);
});
async function reopenRestoredAccount(companions: number) {
  const connector = builtinConnector({
    slug: "github",
    label: "Review archive",
  });
  createComposerConnectorHelpers(context).installComposerConnectorFixture({
    threadId: SCOUT_THREAD_ID,
    catalog: [connector],
  });
  const target = { kind: "builtin", connectorSlug: "github" } as const;
  const restored = chatConnectorOverviewFixture({
    target,
    label: "Review archive",
    accounts: [
      connectorAccount({
        target,
        id: crypto.randomUUID(),
        displayName: "Review team",
        isDefault: true,
      }),
    ],
  });
  const neighbors = Array.from({ length: companions }, (_, index) => {
    const neighbor = {
      kind: "custom",
      customConnectorId: crypto.randomUUID(),
    } as const;
    const label = `Archive companion ${index}`;
    return chatConnectorOverviewFixture({
      target: neighbor,
      label,
      accounts: [
        connectorAccount({
          target: neighbor,
          id: crypto.randomUUID(),
          displayName: label,
          isDefault: true,
        }),
      ],
    });
  });
  context.mocks.api(chatConnectorAccessContract.overview, ({ respond }) => {
    return respond(200, [...neighbors, restored]);
  });
  let available = false;
  context.mocks.api(
    chatConnectorAccessContract.overviewTarget,
    ({ respond }) => {
      return respond(200, { connector: available ? restored : null });
    },
  );
  await openChatMenu(context);
  const row = await findFastControl("button", "Review archive");
  const directory = await screen.findByRole("list", { name: "Connectors" });
  expect(within(directory).queryAllByText(/^Archive companion /u)).toHaveLength(
    companions,
  );
  click(row);
  await expect(
    screen.findByRole("group", { name: "Review archive" }),
  ).resolves.toBeVisible();
  context.mocks.ably.trigger("connector:changed", { connectorSlug: "github" });
  await waitFor(() => {
    return expect(queryFastControl("button", "Review archive")).toBeNull();
  });
  expect(screen.queryByRole("group", { name: "Review archive" })).toBeNull();
  await expect(
    findFastControl("button", "Add connectors"),
  ).resolves.toBeVisible();
  available = true;
  context.mocks.ably.trigger("connector:changed", { connectorSlug: "github" });
  const returned = await findFastControl("button", "Review archive");
  expect(returned).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("group", { name: "Review archive" })).toBeNull();
  click(returned);
  return screen.findByRole("dialog", { name: "Review archive" });
}

test("chat-composer-connector-scroll-005 A removed account panel stays closed when its connector returns", async () => {
  await expect(reopenRestoredAccount(0)).resolves.toBeVisible();
});

test("Restoring an account among 29 neighbors leaves its panel closed until selected", async () => {
  await expect(reopenRestoredAccount(29)).resolves.toBeVisible();
});

function directoryData(saved: boolean, reconnect = false) {
  createComposerConnectorHelpers(context).installComposerConnectorFixture({
    threadId: SCOUT_THREAD_ID,
    ...(reconnect
      ? {
          accounts: [
            { kind: "builtin", connectorSlug: "github" } as const,
            { kind: "custom", customConnectorId: ACME_CONNECTOR_ID } as const,
          ].map((target) => {
            return {
              ...connectorAccount({
                id: crypto.randomUUID(),
                target,
                displayName: "Needs reconnection",
                isDefault: true,
              }),
              connectionStatus: "reconnect-required" as const,
              reconnectReason: "credential_expired",
            };
          }),
        }
      : {}),
    catalog: [
      builtinConnector({ slug: "github", label: "GitHub" }),
      builtinConnector({ slug: "notion", label: "Notion", hasAccount: false }),
    ],
    customConnectors: [
      httpConnector({
        id: FEISHU_CONNECTOR_ID,
        slug: "feishu",
        displayName: "Feishu",
        authMode: "oauth",
        providerAdapter: "feishu",
        hasAccount: true,
      }),
      httpConnector({
        id: ACME_CONNECTOR_ID,
        slug: "acme-search",
        displayName: "Acme Search",
        hasAccount: saved,
      }),
    ],
  });
}
async function directory() {
  await openChatMenu(context);
  click(await findFastControl("button", "Add connectors"));
  return await screen.findByRole("dialog", { name: "Connectors" });
}
async function customTab() {
  click(await screen.findByRole("radio", { name: "Custom" }));
}
function acme() {
  return findFastControl("button", "Connect Acme Search");
}
test("chat-composer-connector-status-002 The directory distinguishes saved accounts from an available Notion connection", async () => {
  directoryData(true);
  const catalog = await directory();
  await expect(
    findFastControl("button", "Connect Notion", catalog),
  ).resolves.toBeVisible();
  await fill(within(catalog).getByRole("textbox"), "GitHub");
  const github = await findFastControl(
    "button",
    "Open GitHub details",
    catalog,
  );
  expect(github).toHaveTextContent("Connected");
  await fill(within(catalog).getByRole("textbox"), "");
  await customTab();
  await expect(acme()).resolves.toHaveTextContent("Connected");
});
test("chat-composer-connector-status-003 The saved custom search account remains actionable in Custom", async () => {
  directoryData(true);
  await directory();
  await customTab();
  const card = await acme();
  expect(card).toBeEnabled();
  expect(card).toHaveTextContent("Connected");
  click(card);
  const manager = await screen.findByRole("dialog");
  expect(manager).toHaveTextContent("Acme Search");
  expect(within(manager).getByLabelText("Secret")).toBeVisible();
});
test("chat-composer-connector-status-004 Saving a credential changes the status on a fresh directory visit", async () => {
  directoryData(false);
  await directory();
  await customTab();
  const card = await acme();
  expect(card).toHaveTextContent("No accounts");
  click(card);
  await fill(await screen.findByLabelText("Secret"), "local-search-token");
  click(await findFastControl("button", "Save"));
  const trigger = await findFastControl("button", "Connectors");
  click(trigger);
  click(await findFastControl("button", "Add connectors"));
  await customTab();
  const refreshed = await acme();
  expect(refreshed).toHaveTextContent("Connected");
  expect(refreshed).not.toHaveTextContent("No accounts");
});
test("chat-composer-connector-status-005 Waiting for account inventory withholds the ordinary custom card", async () => {
  directoryData(false);
  const inventory = context.mocks.deferred<void>();
  const requested = context.mocks.deferred<void>();
  context.mocks.api(connectedConnectorsContract.list, async ({ respond }) => {
    if (!requested.settled()) {
      requested.resolve();
    }
    await inventory.promise;
    return respond(200, { builtinConnectors: [], customConnectors: [] });
  });
  await directory();
  await customTab();
  await requested.promise;
  // The integration-managed card uses the same directory response as Acme.
  await expect(
    findFastControl("button", "Connect Feishu"),
  ).resolves.toBeVisible();
  expect(
    screen.getByRole("radio", { name: "Custom", checked: true }),
  ).toBeVisible();
  expect(queryFastControl("button", "Connect Acme Search")).toBeNull();
  expect(screen.queryByText("No accounts")).toBeNull();
  inventory.resolve();
  await expect(acme()).resolves.toHaveTextContent("No accounts");
});

test("chat-composer-connector-status-001 Accounts requiring reconnection remain discoverable in both directory tabs", async () => {
  directoryData(true, true);
  const catalog = await directory();
  const search = within(catalog).getByRole("textbox");
  await fill(search, "GitHub");
  await expect(
    findFastControl("button", "Open GitHub details", catalog),
  ).resolves.toBeEnabled();
  await fill(search, "");
  await customTab();
  const account = await acme();
  expect(account).toBeEnabled();
  expect(screen.queryByLabelText("Secret")).toBeNull();
  click(account);
  await expect(screen.findByLabelText("Secret")).resolves.toBeEnabled();
});

test("Feishu still opens its managed connection flow when account inventory fails", async () => {
  directoryData(true);
  context.mocks.api(connectedConnectorsContract.list, ({ respond }) => {
    return respond(503, {
      error: { code: "UNAVAILABLE", message: "Saved account service offline" },
    });
  });
  const catalog = await directory();
  await customTab();
  await within(catalog).findByText(
    "Accounts are unavailable for this connector.",
  );
  expect(queryFastControl("button", "Connect Acme Search", catalog)).toBeNull();
  expect(within(catalog).queryByText("No accounts")).toBeNull();
  const search = within(catalog).getByRole("textbox");
  await fill(search, "Acme Search");
  expect(
    within(catalog).queryByText("Acme Search", { exact: true }),
  ).toBeNull();
  expect(queryFastControl("button", "Connect Acme Search", catalog)).toBeNull();
  await fill(search, "Feishu");
  const managed = await findFastControl("button", "Connect Feishu", catalog);
  click(managed);
  await screen.findByRole("dialog", { name: /Feishu/i });
});

const managed = () => {
  return httpConnector({
    id: FEISHU_CONNECTOR_ID,
    slug: "_feishu",
    displayName: "Feishu",
    authMode: "oauth",
    providerAdapter: "feishu",
    hasAccount: false,
  });
};
const customAcmeConnector = () => {
  return httpConnector({
    id: ACME_CONNECTOR_ID,
    slug: "_acme-search",
    displayName: "Acme Search",
    hasAccount: false,
  });
};
const gateway = createComposerConnectorHelpers(context);
async function menu(
  options: Parameters<typeof gateway.installComposerConnectorFixture>[0],
) {
  const fixture = gateway.installComposerConnectorFixture({
    ...options,
    threadId: SCOUT_THREAD_ID,
  });
  await setupPage({ context, path: "/chats/" + SCOUT_THREAD_ID });
  const trigger = await findFastControl("button", "Connectors");
  click(trigger);
  return { fixture, trigger };
}
async function openConversationConnectorDirectory() {
  click(await findFastControl("button", "Add connectors"));
  const filter = await screen.findByPlaceholderText("Find connectors...");
  const dialog = filter.closest<HTMLElement>('[role="dialog"]');
  if (!dialog) {
    throw new Error("Missing directory dialog");
  }
  return dialog;
}
test("chat-composer-connectors-013 Searching beyond featured GitHub opens one manual Axiom setup", async () => {
  const featured = ["github", "calendar", "notes", "releases"];
  const catalog = featured.map((slug, i) => {
    return builtinConnector({
      slug,
      label: i === 0 ? "GitHub" : slug,
      hasAccount: false,
      popularityRank: i + 1,
    });
  });
  await menu({
    catalog: [
      ...catalog,
      builtinConnector({
        slug: "axiom",
        label: "Axiom",
        hasAccount: false,
        authMethods: [manualAuthMethod()],
      }),
    ],
    featuredConnectorSlugs: featured,
    categoryConnectorCounts: { productivity: 5 },
  });
  const browser = await openConversationConnectorDirectory();
  await within(browser).findByText("GitHub");
  expect(within(browser).queryByText("Axiom")).toBeNull();
  await fill(
    within(browser).getByPlaceholderText("Find connectors..."),
    "Axiom",
  );
  click(await findFastControl("button", "Connect Axiom", browser));
  const setup = await screen.findByRole("dialog", { name: /Axiom/i });
  await within(setup).findByText("API Token", { selector: "label" });
  expect(
    within(setup).getByText("API Token", { selector: "label" }),
  ).toBeVisible();
  expect(setup.querySelector('input[type="password"]')).toBeVisible();
  expect(screen.getAllByRole("dialog", { name: /Axiom/i })).toStrictEqual([
    setup,
  ]);
});
test("chat-composer-connectors-015 The custom directory offers Acme Search and excludes the integration-managed Feishu connection", async () => {
  await menu({ customConnectors: [managed(), customAcmeConnector()] });
  const browser = await openConversationConnectorDirectory();
  click(await findFastControl("radio", "Custom", browser));
  await expect(
    findFastControl("button", "Connect Acme Search", browser),
  ).resolves.toBeEnabled();
  expect(within(browser).queryByText("Feishu", { exact: true })).toBeNull();
  expect(queryFastControl("button", "Connect Feishu", browser)).toBeNull();
});

async function startAnalyticsSignIn() {
  const popup = context.mocks.browser.authWindow();
  Object.defineProperty(popup, "location", { value: { href: "about:blank" } });
  context.mocks.browser.open(popup);
  const { fixture } = await menu({
    catalog: [
      builtinConnector({
        slug: "google-analytics",
        label: "Google Analytics",
        hasAccount: false,
      }),
    ],
    featuredConnectorSlugs: ["google-analytics"],
  });
  const catalog = await openConversationConnectorDirectory();
  const filter = within(catalog).getByPlaceholderText("Find connectors...");
  await fill(filter, "Google Analytics");
  const submit = await findFastControl(
    "button",
    "Connect Google Analytics",
    catalog,
  );
  click(submit);
  await waitFor(() => {
    expect(popup.location.href).toBe(
      "https://accounts.example.test/google-analytics",
    );
  });
  return { popup, catalog, filter, submit, fixture };
}

test("chat-composer-connectors-007 closing member sign-in leaves the Analytics search available for retry", async () => {
  const { popup, filter, submit } = await startAnalyticsSignIn();
  expect(submit).toBeDisabled();
  popup.close();
  await waitFor(() => {
    expect(submit).toBeEnabled();
  });
  expect(filter).toHaveValue("Google Analytics");
});

test("chat-composer-connectors-009 the member finishes Analytics authorization from the open provider window", async () => {
  const { popup, catalog, fixture } = await startAnalyticsSignIn();
  expect(popup.closed).toBeFalsy();
  fixture.completeOAuth(crypto.randomUUID());
  expect(popup.closed).toBeFalsy();
  popup.close();
  await waitFor(() => {
    expect(catalog).not.toBeInTheDocument();
  });
  click(await findFastControl("button", "Connectors"));
  await expect(
    findFastControl("button", /^Google Analytics/u),
  ).resolves.toBeVisible();
});
