import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  chatConnectorAccessContract,
  type ChatConnectorAccess,
} from "@okouai/api-contracts/contracts/chat-connector-access";
import { connectorPermissionsContract } from "@okouai/api-contracts/contracts/connector-permissions";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { customConnectorByIdContract } from "@okouai/api-contracts/contracts/custom-connectors";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { remotesContract } from "@okouai/api-contracts/contracts/remotes";
import { chatRemoteAccessContract } from "@okouai/api-contracts/contracts/chat-remote-access";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  builtinConnector,
  httpConnector,
  ACME_CONNECTOR_ID,
  connectorAccount,
  createComposerConnectorHelpers,
  permissionDetail,
  SCOUT_AGENT_ID,
  SCOUT_THREAD_ID,
  OTHER_THREAD_ID,
  chatConnectorOverviewFixture,
} from "./chat-composer-connectors-test-helpers.ts";
import {
  findComposer,
  findFastControl,
} from "./chat-message-experience-test-helpers.ts";

const context = testContext();
const { installComposerConnectorFixture } =
  createComposerConnectorHelpers(context);
const target = Object.freeze({
  kind: "builtin" as const,
  connectorSlug: "github",
});
const work = connectorAccount({
  id: "f0000000-0000-4000-a000-000000000091",
  target,
  displayName: "Work",
  isDefault: true,
});
const personal = connectorAccount({
  id: "f0000000-0000-4000-a000-000000000092",
  target,
  displayName: "Personal",
  isDefault: false,
});

function installAccess(
  options: {
    allOff?: boolean;
    personalOff?: boolean;
    rejectSelection?: boolean;
    custom?: boolean;
    noPermissions?: boolean;
    secondPane?: boolean;
    outsideDiscovery?: boolean;
    beforeSaveResponse?: (signal: AbortSignal) => Promise<void>;
  } = {},
) {
  const accessTarget = options.custom
    ? { kind: "custom" as const, customConnectorId: ACME_CONNECTOR_ID }
    : target;
  installComposerConnectorFixture({
    ...(options.secondPane
      ? {
          threads: [
            {
              id: SCOUT_THREAD_ID,
              title: "Scout chat",
              agentId: SCOUT_AGENT_ID,
            },
            {
              id: OTHER_THREAD_ID,
              title: "Other chat",
              agentId: SCOUT_AGENT_ID,
            },
          ],
          threadId: SCOUT_THREAD_ID,
        }
      : {}),
    ...(options.outsideDiscovery ? { featuredConnectorSlugs: [] } : {}),
    catalog: options.custom
      ? []
      : [
          builtinConnector({
            slug: "github",
            label: "GitHub",
            hasPermissions: !options.noPermissions,
          }),
        ],
    customConnectors: options.custom
      ? [
          {
            ...httpConnector({
              id: ACME_CONNECTOR_ID,
              slug: "acme",
              displayName: "Acme",
              hasAccount: true,
            }),
            permissionBundleRef: "builtin:github@1",
          },
        ]
      : [],
    accounts: [work, personal].map((account) => {
      return {
        ...account,
        target: accessTarget,
        scopeMismatch: Boolean(options.outsideDiscovery),
      };
    }),
    permissionDetails: new Map([
      [
        "github",
        permissionDetail("github", "GitHub", ["repos|read", "repos|write"]),
      ],
    ]),
  });
  if (options.custom) {
    context.mocks.api(customConnectorByIdContract.get, ({ respond }) => {
      return respond(200, {
        ...httpConnector({
          id: ACME_CONNECTOR_ID,
          slug: "acme",
          displayName: "Acme",
          hasAccount: true,
        }),
        permissionBundleRef: "builtin:github@1",
      });
    });
  }
  context.mocks.api(customConnectorByIdContract.permissions, ({ respond }) => {
    return respond(200, {
      ref: "builtin:github@1",
      permissions: [{ name: "repos|read" }, { name: "repos|write" }],
      defaultPolicies: { "repos|read": "deny", "repos|write": "allow" },
    });
  });
  const defaults = [work, personal].map((account) => {
    return {
      connectionId: account.id,
      displayName: account.displayName,
      defaultEnabled:
        !options.allOff && (!options.personalOff || account.id !== personal.id),
      isDefault: account.isDefault,
    };
  });
  const chats = new Map<
    string,
    { current: string | null; overrides: Map<string, boolean> }
  >();
  let rejectSelection = options.rejectSelection ?? false;
  let grants: {
    permission: string;
    action: "allow" | "deny";
    expiresAt: string | null;
  }[] = [];
  const access = (threadId: string): ChatConnectorAccess => {
    const chat = chats.get(threadId) ?? {
      current: work.id,
      overrides: new Map<string, boolean>(),
    };
    chats.set(threadId, chat);
    const accounts = defaults.map((account) => {
      return {
        ...account,
        overrideEnabled: chat.overrides.get(account.connectionId) ?? null,
        enabled:
          chat.overrides.get(account.connectionId) ?? account.defaultEnabled,
      };
    });
    const allowed = accounts.filter((account) => {
      return account.enabled;
    });
    chat.current =
      allowed.find((account) => {
        return account.connectionId === chat.current;
      })?.connectionId ??
      allowed.find((account) => {
        return account.isDefault;
      })?.connectionId ??
      allowed[0]?.connectionId ??
      null;
    return {
      target: accessTarget,
      accounts,
      currentConnectionId: chat.current,
      available: allowed.length > 0,
    };
  };
  const overview = (threadId?: string) => {
    return chatConnectorOverviewFixture({
      target: accessTarget,
      label: options.custom ? "Acme" : "GitHub",
      accounts: [work, personal].map((account) => {
        return {
          ...account,
          target: accessTarget,
        };
      }),
      access: access(threadId ?? "draft"),
      hasPermissions: !options.custom && !options.noPermissions,
    });
  };
  context.mocks.api(
    chatConnectorAccessContract.overview,
    ({ query, respond }) => {
      return respond(200, [overview(query.threadId)]);
    },
  );
  context.mocks.api(
    chatConnectorAccessContract.overviewTarget,
    ({ query, respond }) => {
      return respond(200, { connector: overview(query.threadId) });
    },
  );
  context.mocks.api(
    chatConnectorAccessContract.accountDefaults,
    ({ respond }) => {
      return respond(200, defaults);
    },
  );
  context.mocks.api(
    chatConnectorAccessContract.getThread,
    ({ params, respond }) => {
      return respond(200, access(params.threadId));
    },
  );
  context.mocks.api(
    chatConnectorAccessContract.setThreadOverride,
    async ({ request, params, body, respond }) => {
      access(params.threadId);
      const chat = chats.get(params.threadId)!;
      if (body.enabled === null) {
        chat.overrides.delete(params.connectionId);
      } else {
        chat.overrides.set(params.connectionId, body.enabled);
      }
      await options.beforeSaveResponse?.(request.signal);
      return respond(200, access(params.threadId));
    },
  );
  context.mocks.api(
    chatConnectorAccessContract.setThreadCurrent,
    async ({ request, params, body, respond }) => {
      if (rejectSelection) {
        rejectSelection = false;
        return respond(403, {
          error: {
            code: "FORBIDDEN",
            message: "Account access could not be saved",
          },
        });
      }
      access(params.threadId);
      chats.get(params.threadId)!.current = body.connectionId;
      await options.beforeSaveResponse?.(request.signal);
      return respond(200, access(params.threadId));
    },
  );
  context.mocks.api(connectorPermissionsContract.get, ({ respond }) => {
    return respond(200, { target: accessTarget, grants });
  });
  context.mocks.api(connectorPermissionsContract.apply, ({ body, respond }) => {
    grants = body.grants.map((grant) => {
      return {
        permission: grant.permission,
        action: grant.action,
        expiresAt: null,
      };
    });
    return respond(200, { target: accessTarget, grants });
  });
  return {
    access,
  };
}

async function setup(path = `/chats/${SCOUT_THREAD_ID}`, singleAgent = false) {
  await setupPage({
    context,
    path,
    locale: "en-US",
    featureSwitches: { [FeatureSwitchKey.SingleAgent]: singleAgent },
  });
  await findComposer();
}

async function openMenu(label = "GitHub") {
  click(await findFastControl("button", "Connectors"));
  return await waitFor(() => {
    const row = queryAllByRoleFast("button").find((button) => {
      return button.textContent?.includes(label);
    });
    if (!row) {
      throw new Error(`${label} account row not found`);
    }
    return row;
  });
}

async function chooseAccess(
  user: ReturnType<typeof userEvent.setup>,
  account: string,
  value: string,
) {
  const control = await screen.findByRole("switch", {
    name: `${account} access`,
  });
  expect(control).toHaveAttribute(
    "aria-checked",
    value === "On" ? "false" : "true",
  );
  await user.click(control);
  await waitFor(() => {
    expect(control).toHaveAttribute(
      "aria-checked",
      value === "On" ? "true" : "false",
    );
  });
}

async function findDirectory() {
  return await waitFor(() => {
    const directory = screen
      .getAllByRole("dialog", { name: "Connectors" })
      .find((dialog) => {
        return within(dialog).queryByRole("radio", { name: "Custom" }) !== null;
      });
    if (!directory) {
      throw new Error("Connector directory has not opened");
    }
    return directory;
  });
}

test("Directory permissions preserve connector-wide rules and disabled accounts with personal mode false", async () => {
  // Keep pointer/focus behavior without hovering before the roundtrip's clicks.
  const user = userEvent.setup({ delay: null, skipHover: true });
  installAccess({ allOff: true });
  await setup();
  const trigger = await findFastControl("button", "Connectors");
  await user.click(trigger);
  click(await findFastControl("button", "Add connectors"));
  const directory = await findDirectory();
  await fill(
    within(directory).getByPlaceholderText("Find connectors..."),
    "GitHub",
  );
  click(await findFastControl("button", "Open GitHub details", directory));
  click(await findFastControl("button", "Configure", directory));
  const editor = await screen.findByRole("dialog", {
    name: "GitHub permissions",
  });
  expect(
    within(editor).getByText(
      "These rules apply to this connector across your chats and accounts.",
    ),
  ).toBeInTheDocument();
  const permission = await within(editor).findByLabelText("repos|write", {
    selector: '[role="group"]',
  });
  await waitFor(() => {
    expect(editor.contains(document.activeElement)).toBeTruthy();
  });
  click(await findFastControl("button", "Deny", permission));
  await user.click(await findFastControl("button", "Apply", editor));
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "GitHub permissions" }),
    ).toBeNull();
    expect(trigger).toHaveFocus();
  });
  const row = await openMenu();
  expect(row).toHaveTextContent("2 accounts");
  click(row);
  await expect(
    screen.findByRole("switch", { name: "Work access" }),
  ).resolves.not.toBeChecked();
  expect(
    screen.getByRole("switch", { name: "Personal access" }),
  ).not.toBeChecked();
  click(await findFastControl("button", "Permissions"));
  const saved = await screen.findByRole("dialog", {
    name: "GitHub permissions",
  });
  const savedPermission = await within(saved).findByLabelText("repos|write", {
    selector: '[role="group"]',
  });
  await expect(
    findFastControl("button", "Deny", savedPermission),
  ).resolves.toHaveAttribute("aria-pressed", "true");
  await user.keyboard("{Escape}{Escape}");
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "GitHub permissions" }),
    ).toBeNull();
    expect(trigger).toHaveFocus();
  });
});

test("Account navigation retains computer controls, Remote access and Add connectors", async () => {
  const user = userEvent.setup({ delay: null });
  installAccess();
  const host = {
    connectionId: "f0000000-0000-4000-a000-000000000093",
    displayName: "Build host",
    defaultEnabled: true,
  };
  context.mocks.api(remotesContract.overview, ({ respond }) => {
    return respond(200, {
      cloudBrowserAvailable: true,
      cloudBrowserEnabledByDefault: true,
      computerUseHosts: [],
      sshHosts: [host],
      vncHosts: [],
    });
  });
  context.mocks.api(
    chatRemoteAccessContract.listThreadAccess,
    ({ respond }) => {
      return respond(200, {
        ssh: [
          {
            ...host,
            overrideEnabled: null,
            enabled: true,
            source: "default",
          },
        ],
        vnc: [],
      });
    },
  );
  await setup();
  const trigger = await findFastControl("button", "Connectors");
  click(await openMenu());
  const popup = await screen.findByRole("dialog", { name: "Connectors" });
  await screen.findByRole("switch", { name: "Work access" });
  expect(
    within(popup).getByRole("switch", { name: "Cloud browser" }),
  ).toBeEnabled();
  expect(within(popup).getByText("Your computer")).toBeInTheDocument();
  await findFastControl("button", "Connect my computer", popup);
  click(await within(popup).findByText("Remote access"));
  const remote = await screen.findByRole("dialog", { name: "Remote access" });
  await within(remote).findByRole("combobox", { name: "SSH Build host" });
  await user.keyboard("{Escape}{Escape}");
  await waitFor(() => {
    expect(trigger).toHaveFocus();
  });
  click(await openMenu());
  const reopened = await screen.findByRole("dialog", { name: "Connectors" });
  await screen.findByRole("switch", { name: "Work access" });
  click(await findFastControl("button", "Add connectors", reopened));
  await screen.findByRole("heading", { name: "Connectors" });
  await screen.findByPlaceholderText("Find connectors...");
});

test("Release a pending account save and its cached state when leaving the Chat", async () => {
  const user = userEvent.setup({ delay: null });
  const started = context.mocks.deferred<AbortSignal>();
  const response = context.mocks.deferred<void>();
  installAccess({
    beforeSaveResponse: (signal) => {
      started.resolve(signal);
      return response.promise;
    },
  });
  await setup();
  click(await openMenu());
  await user.click(await screen.findByRole("switch", { name: "Work access" }));
  const requestSignal = await started.promise;
  await user.keyboard("{Escape}{Escape}");
  click(await findFastControl("button", "New chat"));
  await waitFor(() => {
    expect(window.location.pathname).toBe(`/agents/${SCOUT_AGENT_ID}/chat`);
    expect(requestSignal.aborted).toBeTruthy();
  });
  response.resolve();
  await findComposer();
  const row = await openMenu();
  expect(row).toHaveTextContent("2 accounts");
  click(row);
  await expect(
    screen.findByRole("switch", { name: "Work access" }),
  ).resolves.toBeChecked();
  await expect(
    screen.findByRole("switch", { name: "Personal access" }),
  ).resolves.toBeChecked();
});

test("Manage GitHub accounts directly from Chat without losing the draft", async () => {
  const label = "GitHub";
  const user = userEvent.setup({ delay: null });
  installAccess({ noPermissions: true });
  await setup();
  const path = window.location.pathname;
  const composer = await findComposer();
  await fill(composer, "Use my personal GitHub account");
  await user.click(await openMenu(label));
  await screen.findByRole("switch", { name: "Work access" });
  expect(
    queryAllByRoleFast("button").filter((button) => {
      return button.textContent?.trim() === "Permissions";
    }),
  ).toHaveLength(0);
  await user.click(await findFastControl("button", "Manage accounts"));
  const dialog = await screen.findByRole("dialog", {
    name: `Manage ${label} accounts`,
  });
  await expect(within(dialog).findByText("Work")).resolves.toBeInTheDocument();
  expectRetainedDraft(path, composer);
  await expect(
    findFastControl("button", "Add account", dialog),
  ).resolves.toBeInTheDocument();
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: `Manage ${label} accounts` }),
    ).toBeNull();
  });
  await expect(findFastControl("button", "Connectors")).resolves.toHaveFocus();
  expectRetainedDraft(path, composer);
  await user.click(await openMenu(label));
  await expect(
    screen.findByRole("switch", { name: "Work access" }),
  ).resolves.toBeChecked();
});

function expectRetainedDraft(path: string, composer: HTMLElement) {
  expect(window.location.pathname).toBe(path);
  expect(composer).toHaveTextContent("Use my personal GitHub account");
}

test("Transfer the GitHub account manager between Chat panes with one dialog and the correct focus return", async () => {
  const label = "GitHub";
  const user = userEvent.setup({ delay: null, skipHover: true });
  installAccess({ secondPane: true });
  await setup(`/chats/${SCOUT_THREAD_ID}?sidebar=${OTHER_THREAD_ID}`);
  for (const threadId of [SCOUT_THREAD_ID, OTHER_THREAD_ID, SCOUT_THREAD_ID]) {
    const pane = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(
        `[data-chat-thread-container-id="${threadId}"]`,
      );
      if (!element) {
        throw new Error(`Chat pane ${threadId} not found`);
      }
      return element;
    });
    const trigger = await findFastControl("button", "Connectors", pane);
    await user.click(trigger);
    const menu = await screen.findByRole("dialog", { name: "Connectors" });
    await user.click(await within(menu).findByText(label));
    await user.click(await findFastControl("button", "Manage accounts"));
    const titles = await screen.findAllByText(`Manage ${label} accounts`);
    expect(titles).toHaveLength(1);
    const manager = await screen.findByRole("dialog", {
      name: `Manage ${label} accounts`,
    });
    await within(manager).findByText("Work");
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(trigger).toHaveFocus();
    });
  }
});

test("Reconnect the reviewed Chat account when its connector is outside directory discovery", async () => {
  const user = userEvent.setup({ delay: null });
  installAccess({ outsideDiscovery: true });
  context.mocks.api(connectorAccountsContract.scopeDiff, ({ respond }) => {
    return respond(200, {
      addedScopes: ["read:user"],
      removedScopes: [],
      currentScopes: ["read:user"],
      storedScopes: [],
    });
  });
  await setup();
  await user.click(await openMenu());
  await user.click(await findFastControl("button", "Manage accounts"));
  const manager = await screen.findByRole("dialog", {
    name: "Manage GitHub accounts",
  });
  const workRow = await within(manager).findByRole("group", { name: "Work" });
  await user.click(await findFastControl("button", "Account actions", workRow));
  await user.click(await screen.findByText("Review permissions"));
  const review = await screen.findByRole("dialog", {
    name: "GitHub permissions update",
  });
  await user.click(await findFastControl("button", "Reconnect", review));
  const reconnect = await screen.findByRole("dialog", { name: "GitHub" });
  await expect(
    findFastControl("button", "Reconnect", reconnect),
  ).resolves.toBeVisible();
});

test("Preserve the internally resolved account when enabling several accounts before the first Run", async () => {
  const user = userEvent.setup({ delay: null });
  const fixture = installAccess({ allOff: true });
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    if (!body.threadId) {
      throw new Error("Expected Chat identity");
    }
    if (fixture.access(body.threadId).currentConnectionId !== personal.id) {
      throw new Error(
        "First Run used a different account from allowance resolution",
      );
    }
    return respond(201, {
      threadId: body.threadId,
      createdAt: "2026-11-03T00:00:00Z",
    });
  });
  await setup(`/agents/${SCOUT_AGENT_ID}/chat`);
  await user.click(await openMenu());
  await chooseAccess(user, "Personal", "On");
  await expect(
    screen.findByRole("switch", { name: "Personal access" }),
  ).resolves.toBeChecked();
  await chooseAccess(user, "Work", "On");
  await expect(
    screen.findByRole("switch", { name: "Work access" }),
  ).resolves.toBeChecked();
  await user.keyboard("{Escape}{Escape}");
  await fill(await findComposer(), "Use my personal GitHub account");
  click(await findFastControl("button", "Send"));
  await waitFor(() => {
    expect(window.location.pathname).toMatch(/^\/chats\//u);
  });
  const row = await openMenu();
  expect(row).toHaveTextContent("2 accounts");
  click(row);
  await expect(
    screen.findByRole("switch", { name: "Work access" }),
  ).resolves.toBeChecked();
  await expect(
    screen.findByRole("switch", { name: "Personal access" }),
  ).resolves.toBeChecked();
});

test.each([false, true])(
  "Initialize new Chat access before first Run, including selection retry=%s",
  async (rejectSelection) => {
    const user = userEvent.setup({ delay: null });
    const fixture = installAccess({ personalOff: true, rejectSelection });
    context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
      if (!body.threadId) {
        throw new Error("Expected Chat identity");
      }
      const access = fixture.access(body.threadId);
      if (
        access.currentConnectionId !== personal.id ||
        !access.accounts.find((account) => {
          return account.connectionId === personal.id;
        })?.enabled
      ) {
        throw new Error("First Run started before Chat access was initialized");
      }
      return respond(201, {
        threadId: body.threadId,
        createdAt: "2026-11-03T00:00:00Z",
      });
    });
    const path = `/agents/${SCOUT_AGENT_ID}/chat`;
    await setup(path);
    await user.click(await openMenu());
    await expect(
      screen.findByRole("switch", { name: "Personal access" }),
    ).resolves.not.toBeChecked();
    await chooseAccess(user, "Personal", "On");
    await chooseAccess(user, "Work", "Off");
    await user.keyboard("{Escape}{Escape}");
    await user.click(await openMenu());
    await expect(
      screen.findByRole("switch", { name: "Personal access" }),
    ).resolves.toBeChecked();
    await expect(
      screen.findByRole("switch", { name: "Work access" }),
    ).resolves.not.toBeChecked();
    await user.keyboard("{Escape}{Escape}");
    const composer = await findComposer();
    await fill(composer, "Use my personal GitHub account");
    click(await findFastControl("button", "Send"));
    if (rejectSelection) {
      await screen.findByText("Account access could not be saved");
      expectRetainedDraft(path, composer);
      click(await findFastControl("button", "Send"));
    }
    await waitFor(() => {
      return expect(window.location.pathname).toMatch(/^\/chats\//u);
    });
    const row = await openMenu();
    expect(row).toHaveTextContent("2 accounts");
    click(row);
    await expect(
      screen.findByRole("switch", { name: "Work access" }),
    ).resolves.not.toBeChecked();
    await expect(
      screen.findByRole("switch", { name: "Personal access" }),
    ).resolves.toBeChecked();
  },
);
