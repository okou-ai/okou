import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  chatConnectorAccessContract,
  type ChatConnectorAccess,
} from "@okouai/api-contracts/contracts/chat-connector-access";
import { connectorPermissionsContract } from "@okouai/api-contracts/contracts/connector-permissions";
import { customConnectorByIdContract } from "@okouai/api-contracts/contracts/custom-connectors";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { userBuiltinConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import { agentCustomConnectorsContract } from "@okouai/api-contracts/contracts/agent-custom-connectors";
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
  noAuthMethod,
  SCOUT_AGENT_ID,
  SCOUT_THREAD_ID,
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
  } = {},
) {
  const accessTarget = options.custom
    ? { kind: "custom" as const, customConnectorId: ACME_CONNECTOR_ID }
    : target;
  installComposerConnectorFixture({
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
      return { ...account, target: accessTarget };
    }),
    permissionDetails: new Map([
      [
        "github",
        permissionDetail("github", "GitHub", ["repos|read", "repos|write"]),
      ],
    ]),
  });
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
    ({ params, body, respond }) => {
      access(params.threadId);
      const chat = chats.get(params.threadId)!;
      if (body.enabled === null) {
        chat.overrides.delete(params.connectionId);
      } else {
        chat.overrides.set(params.connectionId, body.enabled);
      }
      return respond(200, access(params.threadId));
    },
  );
  context.mocks.api(
    chatConnectorAccessContract.setThreadCurrent,
    ({ params, body, respond }) => {
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
    selectFromRun: (threadId: string, connectionId: string) => {
      access(threadId);
      chats.get(threadId)!.current = connectionId;
    },
  };
}

async function setup(path = `/chats/${SCOUT_THREAD_ID}`) {
  await setupPage({
    context,
    path,
    locale: "en-US",
    featureSwitches: { [FeatureSwitchKey.ConnectorChatAccountAccess]: true },
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
  await user.click(
    await screen.findByRole("combobox", { name: `${account} access` }),
  );
  await user.click(await screen.findByRole("option", { name: value }));
}

async function openDirectory(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await findFastControl("button", "Connectors"));
  await user.click(await findFastControl("button", "Add connectors"));
  return await screen.findByRole("dialog", { name: "Connectors" });
}

test("Directory permissions use the same connector rules without enabling accounts", async () => {
  const user = userEvent.setup({ delay: null });
  installAccess({ allOff: true });
  await setup();
  const trigger = await findFastControl("button", "Connectors");
  await user.click(trigger);
  click(await findFastControl("button", "Add connectors"));
  const directory = await screen.findByRole("dialog", { name: "Connectors" });
  await fill(
    within(directory).getByPlaceholderText("Find connectors..."),
    "GitHub",
  );
  click(await findFastControl("button", "Open GitHub details", directory));
  click(await findFastControl("button", "Configure", directory));
  const editor = await screen.findByRole("dialog", {
    name: "GitHub permissions",
  });
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
  expect(row).toHaveTextContent("0 enabled");
  click(row);
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
  await user.keyboard("{Escape}");
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
  await within(popup).findByRole("combobox", { name: "Work access" });
  expect(
    within(popup).getByRole("switch", { name: "Cloud browser" }),
  ).toBeEnabled();
  expect(within(popup).getByText("Your computer")).toBeInTheDocument();
  await findFastControl("button", "Connect my computer", popup);
  click(await within(popup).findByText("Remote access"));
  const remote = await screen.findByRole("dialog", { name: "Remote access" });
  await within(remote).findByRole("combobox", { name: "SSH Build host" });
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(trigger).toHaveFocus();
  });
  click(await openMenu());
  const reopened = await screen.findByRole("dialog", { name: "Connectors" });
  await within(reopened).findByRole("combobox", { name: "Work access" });
  click(await findFastControl("button", "Add connectors", reopened));
  await screen.findByRole("heading", { name: "Connectors" });
  await screen.findByPlaceholderText("Find connectors...");
});

test("Directory details omit unavailable permission configuration", async () => {
  const user = userEvent.setup({ delay: null });
  installAccess({ noPermissions: true });
  await setup();
  const directory = await openDirectory(user);
  await fill(
    within(directory).getByPlaceholderText("Find connectors..."),
    "GitHub",
  );
  await user.click(
    await findFastControl("button", "Open GitHub details", directory),
  );
  expect(within(directory).queryByText("Permissions")).toBeNull();
  expect(within(directory).queryByText("Configure")).toBeNull();
});

test.each([false, true])(
  "Connect an account without Agent authorization, custom=%s",
  async (custom) => {
    const user = userEvent.setup({ delay: null });
    const label = custom ? "Public Custom" : "Public Tools";
    const fixture = installComposerConnectorFixture({
      catalog: custom
        ? []
        : [
            builtinConnector({
              slug: "public-tools",
              label,
              hasAccount: false,
              authMethods: [noAuthMethod()],
            }),
          ],
      customConnectors: custom
        ? [
            httpConnector({
              id: ACME_CONNECTOR_ID,
              slug: "public-custom",
              displayName: label,
              authMode: "none",
              hasAccount: false,
            }),
          ]
        : [],
    });
    context.mocks.api(userBuiltinConnectorsContract.update, ({ respond }) => {
      return respond(403, {
        error: {
          code: "FORBIDDEN",
          message: "Agent connector settings unavailable",
        },
      });
    });
    context.mocks.api(agentCustomConnectorsContract.update, ({ respond }) => {
      return respond(403, {
        error: {
          code: "FORBIDDEN",
          message: "Agent connector settings unavailable",
        },
      });
    });
    await setup(`/agents/${SCOUT_AGENT_ID}/chat`);
    const directory = await openDirectory(user);
    if (custom) {
      await user.click(await findFastControl("radio", "Custom", directory));
    }
    await user.click(
      await findFastControl("button", `Connect ${label}`, directory),
    );
    if (custom) {
      const dialog = await screen.findByRole("dialog", {
        name: `Connect ${label}`,
      });
      await user.click(await findFastControl("button", "Connect", dialog));
    }
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    await expect(openMenu(label)).resolves.toHaveTextContent("1 enabled");
    expect(fixture.noAuthConnectionRequests).toStrictEqual(
      custom
        ? []
        : [
            {
              connectorSlug: "public-tools",
              authMethod: "public",
              agentId: undefined,
              authorizeAgent: undefined,
            },
          ],
    );
  },
);

test("Refresh the displayed account after a Run changes the Chat selection", async () => {
  const fixture = installAccess();
  await setup();
  const row = await openMenu();
  expect(row).toHaveTextContent("Work");
  fixture.selectFromRun(SCOUT_THREAD_ID, personal.id);
  context.mocks.ably.trigger(`chatThreadDetailChanged:${SCOUT_THREAD_ID}`);
  await waitFor(() => {
    expect(row).toHaveTextContent("Personal");
  });
});

test("Persist current account and nullable Chat overrides across menu reopening", async () => {
  const user = userEvent.setup({ delay: null });
  installAccess();
  await setup();
  const row = await openMenu();
  expect(row).toHaveTextContent("Work");
  expect(row).toHaveTextContent("2 enabled");
  await user.click(row);
  await user.click(await findFastControl("radio", "Personal"));
  await waitFor(() => {
    return expect(
      queryAllByRoleFast("radio").find((radio) => {
        return radio.getAttribute("aria-label") === "Personal";
      }),
    ).toBeChecked();
  });
  await chooseAccess(user, "Personal", "Off");
  await waitFor(() => {
    return expect(
      queryAllByRoleFast("radio").find((radio) => {
        return radio.getAttribute("aria-label") === "Work";
      }),
    ).toBeChecked();
  });
  await user.keyboard("{Escape}");
  const reopened = await openMenu();
  expect(reopened).toHaveTextContent("Work");
  expect(reopened).toHaveTextContent("1 enabled");
  await user.click(reopened);
  await expect(
    screen.findByRole("combobox", { name: "Personal access" }),
  ).resolves.toHaveTextContent("Off");
  await chooseAccess(user, "Personal", "Default (On)");
  await user.click(await findFastControl("radio", "Personal"));
  await waitFor(() => {
    return expect(
      queryAllByRoleFast("radio").find((radio) => {
        return radio.getAttribute("aria-label") === "Personal";
      }),
    ).toBeChecked();
  });
});

test.each([{ label: "GitHub", custom: false }])(
  "Edit $label permissions with all accounts off and keep account access off",
  async ({ label, custom }) => {
    const user = userEvent.setup({ delay: null });
    installAccess({ allOff: true, custom });
    await setup();
    const row = await openMenu(label);
    expect(row).toHaveTextContent("No account selected");
    expect(row).toHaveTextContent("0 enabled");
    await user.click(row);
    await screen.findByText("No account is on for this chat");
    await user.click(await findFastControl("button", "Permissions"));
    const dialog = await screen.findByRole("dialog", {
      name: `${label} permissions`,
    });
    const permissionRow = await within(dialog).findByRole("group", {
      name: "repos|write",
    });
    await user.click(await findFastControl("button", "Deny", permissionRow));
    await user.click(await findFastControl("button", "Apply", dialog));
    await waitFor(() => {
      return expect(
        screen.queryByRole("dialog", { name: `${label} permissions` }),
      ).toBeNull();
    });
    const reopened = await openMenu(label);
    expect(reopened).toHaveTextContent("0 enabled");
    await user.click(reopened);
    await user.click(await findFastControl("button", "Permissions"));
    const savedDialog = await screen.findByRole("dialog", {
      name: `${label} permissions`,
    });
    const savedRow = await within(savedDialog).findByRole("group", {
      name: "repos|write",
    });
    await expect(
      findFastControl("button", "Deny", savedRow),
    ).resolves.toHaveAttribute("aria-pressed", "true");
  },
);

test.each([
  { label: "GitHub", custom: false },
  { label: "Acme", custom: true },
])(
  "Hide unsupported $label permissions while keeping account controls",
  async ({ label, custom }) => {
    const user = userEvent.setup({ delay: null });
    installAccess({ custom, noPermissions: true });
    await setup();
    await user.click(await openMenu(label));
    await screen.findByRole("combobox", { name: "Work access" });
    expect(
      queryAllByRoleFast("button").filter((button) => {
        return button.textContent?.trim() === "Permissions";
      }),
    ).toHaveLength(0);
    await user.click(await findFastControl("link", "Manage accounts"));
    await waitFor(() => {
      expect(window.location.pathname).toBe("/connectors");
    });
    await findFastControl("button", `Manage ${label} accounts`);
    expect(
      queryAllByRoleFast("button").filter((button) => {
        return button.textContent?.trim() === "Permissions";
      }),
    ).toHaveLength(0);
  },
);

function expectRetainedDraft(path: string, composer: HTMLElement) {
  expect(window.location.pathname).toBe(path);
  expect(composer).toHaveTextContent("Use my personal GitHub account");
}

test("Keep the displayed current account when enabling several accounts before the first Run", async () => {
  const user = userEvent.setup({ delay: null });
  const fixture = installAccess({ allOff: true });
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    if (!body.threadId) {
      throw new Error("Expected Chat identity");
    }
    if (fixture.access(body.threadId).currentConnectionId !== personal.id) {
      throw new Error("First Run used a different account from the composer");
    }
    return respond(201, {
      threadId: body.threadId,
      createdAt: "2026-11-03T00:00:00Z",
    });
  });
  await setup(`/agents/${SCOUT_AGENT_ID}/chat`);
  await user.click(await openMenu());
  await chooseAccess(user, "Personal", "On");
  await waitFor(() => {
    expect(
      queryAllByRoleFast("radio").find((radio) => {
        return radio.getAttribute("aria-label") === "Personal";
      }),
    ).toBeChecked();
  });
  await chooseAccess(user, "Work", "On");
  await waitFor(() => {
    expect(
      queryAllByRoleFast("radio").find((radio) => {
        return radio.getAttribute("aria-label") === "Personal";
      }),
    ).toBeChecked();
  });
  await user.keyboard("{Escape}");
  await fill(await findComposer(), "Use the account shown in the menu");
  click(await findFastControl("button", "Send"));
  await waitFor(() => {
    expect(window.location.pathname).toMatch(/^\/chats\//u);
  });
  await expect(openMenu()).resolves.toHaveTextContent("Personal");
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
      screen.findByRole("combobox", { name: "Personal access" }),
    ).resolves.toHaveTextContent("Default (Off)");
    await chooseAccess(user, "Personal", "On");
    await user.click(await findFastControl("radio", "Personal"));
    await user.keyboard("{Escape}");
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
    expect(row).toHaveTextContent("Personal");
    expect(row).toHaveTextContent("2 enabled");
  },
);
