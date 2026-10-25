import {
  type ConnectorAccountConnection,
  connectorAccountsContract,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { builtinConnectorOauthStartContract } from "@okouai/api-contracts/contracts/connectors";
import { userBuiltinConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import { userPermissionGrantsContract } from "@okouai/api-contracts/contracts/user-permission-grants";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getConnectorAction,
  getConnectorCard,
  getConnectorSwitch,
  listAgent,
  mockConnectors,
  mockSavedConnectorAccounts,
  mockGithubAccounts,
  mockOAuthCompletions,
  mockPublicConnectorStatus,
  publicStatusItem,
  queryConnectorAction,
  mockConnectorAgentAccess,
} from "./connector-page-test-helpers.ts";

const context = testContext();

function createAuthWindow(): Window {
  const authWindow = context.mocks.browser.authWindow();
  Object.defineProperty(authWindow, "location", {
    configurable: true,
    value: { href: "" },
  });
  return authWindow;
}

function accountActions(container: ParentNode): HTMLElement[] {
  return queryAllByRoleFast("button", container).filter((candidate) => {
    return candidate.getAttribute("aria-label") === "Account actions";
  });
}

function builtinAccount(args: {
  readonly id: string;
  readonly slug?: "github" | "mercury" | "stripe";
  readonly authMethod?: string;
  readonly displayName: string | null;
  readonly isDefault: boolean;
  readonly externalUsername: string | null;
  readonly status?: ConnectorAccountConnection["connectionStatus"];
  readonly scopeMismatch?: boolean;
}): ConnectorAccountConnection {
  return {
    id: args.id,
    target: {
      kind: "builtin",
      connectorSlug: args.slug ?? "github",
    },
    authMethod: args.authMethod ?? "oauth",
    displayName: args.displayName,
    isDefault: args.isDefault,
    externalId: null,
    externalUsername: args.externalUsername,
    externalEmail: null,
    oauthScopes: [],
    scopeMismatch: args.scopeMismatch ?? false,
    connectionStatus: args.status ?? "connected",
    missingRequiredFields: [],
    configuredFieldKeys: [],
    reconnectReason:
      args.status === "reconnect-required"
        ? "authorization_expired_or_revoked"
        : null,
    tokenExpiresAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function setupAccountsPage(): Promise<void> {
  return setupPage({
    context,
    path: "/connectors",
  });
}

test("Keep the exact account and current reconnect UI when future setup metadata is present", async () => {
  mockConnectors(context, [{ connectorSlug: "github" }]);
  const account = {
    ...builtinAccount({
      id: "11111111-1111-4111-8111-111111111111",
      displayName: "Prepared work account",
      isDefault: true,
      externalUsername: "work-user",
      status: "reconnect-required",
    }),
    missingRequiredFields: [],
    configuredFieldKeys: ["accessToken"],
  };
  const accountsResponse = context.mocks.deferred<void>();
  mockSavedConnectorAccounts(context, () => {
    return [account];
  });
  context.mocks.api(
    connectorAccountsContract.connections,
    async ({ respond }) => {
      await accountsResponse.promise;
      return respond(200, {
        connections: [account],
        nextCursor: null,
        defaultConnection: account,
      });
    },
  );

  await setupAccountsPage();
  const card = await waitFor(() => {
    return getConnectorCard("GitHub");
  });
  await expect(
    within(card).findByText("Connected"),
  ).resolves.toBeInTheDocument();
  click(getConnectorAction("button", "Manage GitHub accounts", card));
  const manager = await screen.findByRole("dialog", {
    name: "Manage GitHub accounts",
  });
  expect(manager).toHaveTextContent("Loading accounts…");
  accountsResponse.resolve();
  await expect(
    within(manager).findByText("Prepared work account"),
  ).resolves.toBeInTheDocument();
  expect(getConnectorAction("button", "Reconnect", manager)).toBeEnabled();
});

test("Show Mercury disclosures while managing its accounts", async () => {
  const [connector] = mockConnectors(context, [
    { connectorSlug: "mercury", externalUsername: "Not A Real Company Inc." },
  ]);
  if (!connector) {
    throw new Error("Expected Mercury connector");
  }
  const account = builtinAccount({
    id: connector.id,
    slug: "mercury",
    displayName: "Sandbox",
    isDefault: true,
    externalUsername: "Not A Real Company Inc.",
  });
  mockPublicConnectorStatus(context, [
    publicStatusItem({
      connectorSlug: "mercury",
      label: "Mercury",
      account: {
        id: connector.id,
        authMethod: "oauth",
        externalUsername: "Not A Real Company Inc.",
        externalEmail: null,
        reconnectReason: null,
        connectionStatus: "connected",
      },
    }),
  ]);
  mockSavedConnectorAccounts(context, () => {
    return [account];
  });
  context.mocks.api(connectorAccountsContract.connections, ({ respond }) => {
    return respond(200, {
      connections: [account],
      nextCursor: null,
      defaultConnection: account,
    });
  });
  await setupPage({ context, path: "/connectors?keywords=mercury" });

  const card = await waitFor(() => {
    return getConnectorCard("Mercury");
  });
  expect(
    getConnectorAction("link", "Powered by Mercury", card),
  ).toHaveAttribute("href", "https://mercury.com");

  click(
    await waitFor(() => {
      return getConnectorAction("button", "Manage Mercury accounts", card);
    }),
  );
  const manager = await screen.findByRole("dialog", {
    name: "Manage Mercury accounts",
  });
  expect(
    getConnectorAction("link", "Powered by Mercury", manager),
  ).toHaveAttribute("href", "https://mercury.com");
  expect(manager).toHaveTextContent(
    "Mercury is a fintech company, not an FDIC-insured bank. Banking services provided through Choice Financial Group and Column N.A., Members FDIC.",
  );

  click(getConnectorAction("button", "Close", manager));
  await waitFor(() => {
    expect(manager).not.toBeInTheDocument();
  });
  click(getConnectorAction("button", "Manage Mercury access", card));
  const access = await screen.findByRole("dialog", {
    name: "Manage Mercury access",
  });
  expect(
    getConnectorAction("link", "Powered by Mercury", access),
  ).toHaveAttribute("href", "https://mercury.com");
});

async function openConnectorAccessSummary() {
  const ids = [
    "c0000000-0000-4000-a000-000000000001",
    "c0000000-0000-4000-a000-000000000002",
    "c0000000-0000-4000-a000-000000000003",
    "c0000000-0000-4000-a000-000000000004",
  ];
  const longName = "Research Operations for International Partnerships";
  const enabled = new Map<string, string[]>(
    ids.map((id) => {
      return [id, []];
    }),
  );
  mockConnectors(context, [
    { connectorSlug: "github", externalUsername: "octocat" },
  ]);
  context.mocks.data.agents([
    listAgent(ids[0] ?? "", longName),
    listAgent(ids[1] ?? "", "Support"),
    listAgent(ids[2] ?? "", "Growth"),
    listAgent(ids[3] ?? "", "Ops"),
  ]);
  context.mocks.api(
    userBuiltinConnectorsContract.get,
    ({ params, respond }) => {
      return respond(200, {
        enabledConnectorSlugs: enabled.get(params.id) ?? [],
      });
    },
  );
  mockConnectorAgentAccess(context, (agentId) => {
    return { enabledConnectorSlugs: enabled.get(agentId) ?? [] };
  });
  context.mocks.api(
    userBuiltinConnectorsContract.update,
    ({ params, body, respond }) => {
      const next = body.operation === "remove" ? [] : ["github"];
      enabled.set(params.id, next);
      context.mocks.ably.trigger("composerAgentConnectorsChanged", {
        agentId: params.id,
      });
      return respond(200, { enabledConnectorSlugs: next });
    },
  );
  context.mocks.api(userPermissionGrantsContract.list, ({ respond }) => {
    return respond(200, []);
  });
  await setupPage({ context, path: "/connectors" });
  const card = await waitFor(() => {
    return getConnectorCard("GitHub");
  });
  return { card, longName };
}

test("Show the full agent name after granting the first connector access", async () => {
  const { card, longName } = await openConnectorAccessSummary();
  expect(
    getConnectorAction("button", "Manage GitHub access", card),
  ).toHaveTextContent("Add access");

  click(
    getConnectorAction(
      "button",
      "Manage GitHub access",
      getConnectorCard("GitHub"),
    ),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Manage GitHub access",
  });
  click(
    await waitFor(() => {
      return getConnectorSwitch(
        `Authorize GitHub access for ${longName}`,
        dialog,
      );
    }),
  );
  click(getConnectorAction("button", "Close", dialog));
  await waitFor(() => {
    const access = getConnectorAction(
      "button",
      "Manage GitHub access",
      getConnectorCard("GitHub"),
    );
    expect(access).toHaveTextContent(`Used by ${longName}`);
  });
});

async function openDefaultAccountManager(rejectFirst = false) {
  const save = context.mocks.deferred<void>();
  let rejectNext = rejectFirst;
  const [connector] = mockConnectors(context, [
    { connectorSlug: "github", externalUsername: "work" },
  ]);
  if (!connector) {
    throw new Error("Expected GitHub connector");
  }
  const work = builtinAccount({
    id: connector.id,
    displayName: "Work",
    isDefault: true,
    externalUsername: "work",
  });
  const personal = builtinAccount({
    id: crypto.randomUUID(),
    displayName: "Personal",
    isDefault: false,
    externalUsername: "personal",
  });
  let defaultId = work.id;
  const accounts = (): ConnectorAccountConnection[] => {
    return [work, personal].map((account) => {
      return {
        ...account,
        isDefault: account.id === defaultId,
      };
    });
  };
  mockSavedConnectorAccounts(context, accounts);
  context.mocks.api(connectorAccountsContract.connections, ({ respond }) => {
    return respond(200, {
      connections: accounts(),
      nextCursor: null,
      defaultConnection:
        accounts().find((account) => {
          return account.isDefault;
        }) ?? null,
    });
  });
  context.mocks.api(
    connectorAccountsContract.setDefault,
    async ({ params, respond }) => {
      await save.promise;
      if (rejectNext) {
        rejectNext = false;
        return respond(403, {
          error: { message: "Permission denied", code: "FORBIDDEN" },
        });
      }
      defaultId = params.connectionId;
      const updated = accounts().find((account) => {
        return account.id === defaultId;
      });
      if (!updated) {
        return respond(404, {
          error: { message: "Account not found", code: "NOT_FOUND" },
        });
      }
      return respond(200, updated);
    },
  );
  await setupAccountsPage();
  click(
    await waitFor(() => {
      return getConnectorAction("button", "Manage GitHub accounts");
    }),
  );
  const manager = await screen.findByRole("dialog", {
    name: "Manage GitHub accounts",
  });
  return { manager, save };
}

function accountRadio(manager: HTMLElement, name: string): HTMLElement {
  const row = within(manager).getByRole("group", { name });
  const radio = queryAllByRoleFast("radio", row)[0];
  if (!radio) {
    throw new Error(`Expected default account radio for ${name}`);
  }
  return radio;
}

test.each(["pointer", "Space", "ArrowDown"] as const)(
  "Make another connector account the default with %s",
  async (activation) => {
    const { manager, save } = await openDefaultAccountManager();
    const user = userEvent.setup();
    const workRadio = accountRadio(manager, "Work");
    const personalRadio = accountRadio(manager, "Personal");
    expect(workRadio).toBeChecked();

    if (activation === "pointer") {
      await user.click(personalRadio);
    } else {
      act(() => {
        (activation === "Space" ? personalRadio : workRadio).focus();
      });
      await user.keyboard(activation === "Space" ? " " : "{ArrowDown}");
    }

    await waitFor(() => {
      expect(personalRadio).toHaveAttribute("aria-disabled", "true");
    });
    expect(workRadio).toHaveAttribute("aria-disabled", "true");
    expect(workRadio).toBeChecked();
    expect(personalRadio).not.toBeChecked();
    await user.click(workRadio);
    await user.keyboard(" {ArrowDown}");
    save.resolve();

    await waitFor(() => {
      expect(accountRadio(manager, "Personal")).toBeChecked();
    });
    expect(accountRadio(manager, "Work")).not.toBeChecked();
    expect(accountRadio(manager, "Personal")).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(within(manager).getAllByText("Work")).toHaveLength(1);
    expect(getConnectorCard("GitHub")).toHaveTextContent("Connected");

    await user.click(accountRadio(manager, "Personal"));
    await user.keyboard(" ");
    expect(accountRadio(manager, "Personal")).toBeChecked();
    expect(accountRadio(manager, "Work")).not.toBeChecked();
  },
);

test.each(["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"] as const)(
  "Keep %s navigation on the focused account after default-first reordering",
  async (key) => {
    const { manager, save } = await openDefaultAccountManager();
    const user = userEvent.setup();
    save.resolve();
    act(() => {
      accountRadio(manager, "Work").focus();
    });

    for (const selected of ["Personal", "Work"] as const) {
      await user.keyboard(`{${key}}`);
      await waitFor(() => {
        expect(accountRadio(manager, selected)).toBeChecked();
        expect(accountRadio(manager, selected)).toHaveAttribute(
          "tabindex",
          "0",
        );
      });
      expect(accountRadio(manager, selected)).toHaveFocus();
      const rows = within(manager).getAllByRole("group");
      expect(rows[0]).toHaveAttribute("aria-label", selected);
    }
  },
);

test("Keep the saved default account after a rejected change and allow retry", async () => {
  const { manager, save } = await openDefaultAccountManager(true);
  const user = userEvent.setup();
  const workRadio = accountRadio(manager, "Work");
  const personalRadio = accountRadio(manager, "Personal");
  act(() => {
    workRadio.focus();
  });
  await user.keyboard("{ArrowDown}");
  await waitFor(() => {
    expect(personalRadio).toHaveAttribute("aria-disabled", "true");
  });
  save.resolve();

  await waitFor(() => {
    expect(personalRadio).not.toHaveAttribute("aria-disabled", "true");
  });
  expect(workRadio).toBeChecked();
  expect(workRadio).toHaveAttribute("aria-label", "Default");
  expect(personalRadio).not.toBeChecked();
  expect(personalRadio).toHaveAttribute("aria-label", "Make default");

  await user.click(personalRadio);
  await waitFor(() => {
    expect(accountRadio(manager, "Personal")).toBeChecked();
  });
  expect(accountRadio(manager, "Work")).not.toBeChecked();
});

test("Grant and revoke connector access for agents", async () => {
  const researchId = "c0000000-0000-4000-a000-000000000001";
  const supportId = "c0000000-0000-4000-a000-000000000002";
  const enabled = new Map<string, string[]>([
    [researchId, ["github"]],
    [supportId, []],
  ]);
  mockConnectors(context, [
    { connectorSlug: "github", externalUsername: "octocat" },
  ]);
  context.mocks.data.agents([
    listAgent(researchId, "Research Agent"),
    listAgent(supportId, "Support Agent"),
  ]);
  context.mocks.api(
    userBuiltinConnectorsContract.get,
    ({ params, respond }) => {
      return respond(200, {
        enabledConnectorSlugs: enabled.get(params.id) ?? [],
      });
    },
  );
  mockConnectorAgentAccess(context, (agentId) => {
    return { enabledConnectorSlugs: enabled.get(agentId) ?? [] };
  });
  context.mocks.api(
    userBuiltinConnectorsContract.update,
    ({ params, body, respond }) => {
      const current = enabled.get(params.id) ?? [];
      const next =
        body.operation === "remove"
          ? current.filter((slug) => {
              return !body.enabledConnectorSlugs.includes(slug);
            })
          : [...new Set([...current, ...body.enabledConnectorSlugs])];
      enabled.set(params.id, next);
      context.mocks.ably.trigger("composerAgentConnectorsChanged", {
        agentId: params.id,
      });
      return respond(200, { enabledConnectorSlugs: next });
    },
  );
  context.mocks.api(userPermissionGrantsContract.list, ({ respond }) => {
    return respond(200, []);
  });
  await setupPage({ context, path: "/connectors" });
  const card = await waitFor(() => {
    return getConnectorCard("GitHub");
  });
  click(getConnectorAction("button", "Manage GitHub access", card));
  const dialog = await screen.findByRole("dialog", {
    name: "Manage GitHub access",
  });
  expect(within(dialog).getByText("Research Agent")).toBeInTheDocument();
  expect(within(dialog).getByText("Support Agent")).toBeInTheDocument();
  await expect(
    waitFor(() => {
      return getConnectorSwitch(
        "Revoke GitHub access for Research Agent",
        dialog,
      );
    }),
  ).resolves.toBeInTheDocument();

  click(
    await waitFor(() => {
      return getConnectorSwitch(
        "Authorize GitHub access for Support Agent",
        dialog,
      );
    }),
  );

  await waitFor(() => {
    expect(
      getConnectorSwitch("Revoke GitHub access for Support Agent", dialog),
    ).toBeInTheDocument();
  });
});

test("Load connector accounts progressively", async () => {
  const accounts = mockGithubAccounts(context, 8);
  const serverPageSize = 3;
  context.mocks.api(
    connectorAccountsContract.connections,
    ({ query, respond }) => {
      const start = query.cursor ? Number(query.cursor) : 0;
      const page = accounts.slice(start, start + serverPageSize);
      const next = start + page.length;
      return respond(200, {
        connections: page,
        defaultConnection:
          accounts.find((account) => {
            return account.isDefault;
          }) ?? null,
        nextCursor: next < accounts.length ? String(next) : null,
      });
    },
  );
  await setupAccountsPage();
  click(
    await waitFor(() => {
      return getConnectorAction("button", "Manage GitHub accounts");
    }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Manage GitHub accounts",
  });
  expect(within(dialog).getByText("Work 7")).toBeInTheDocument();
  expect(within(dialog).queryByText("Work 4")).not.toBeInTheDocument();

  click(getConnectorAction("button", "Load more", dialog));
  await expect(
    within(dialog).findByText("Work 4"),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).getByText("Work 7")).toBeInTheDocument();

  click(
    await waitFor(() => {
      const loadMore = getConnectorAction("button", "Load more", dialog);
      expect(loadMore).toBeEnabled();
      return loadMore;
    }),
  );
  await expect(
    within(dialog).findByText("Work 1"),
  ).resolves.toBeInTheDocument();
  expect(queryConnectorAction("button", "Load more", dialog)).toBeNull();
  expect(within(dialog).getAllByText("Unnamed account")).toHaveLength(1);
  expect(accountActions(dialog)).toHaveLength(8);
});

async function openNamedConnectorAccountRename({
  failFirstDelete = false,
  deletionPending,
}: {
  failFirstDelete?: boolean;
  deletionPending?: Promise<void>;
} = {}) {
  const [connector] = mockConnectors(context, [
    { connectorSlug: "github", externalUsername: "octocat" },
  ]);
  if (!connector) {
    throw new Error("Expected GitHub connector");
  }
  let account: ConnectorAccountConnection | null = builtinAccount({
    id: connector.id,
    displayName: "Work",
    isDefault: true,
    externalUsername: "octocat",
  });
  context.mocks.api(connectorAccountsContract.connections, ({ respond }) => {
    return respond(200, {
      connections: account ? [account] : [],
      defaultConnection: account,
      nextCursor: null,
    });
  });
  context.mocks.api(
    connectorAccountsContract.rename,
    ({ params, body, respond }) => {
      if (!account || params.connectionId !== account.id) {
        return respond(404, {
          error: { message: "Account not found", code: "NOT_FOUND" },
        });
      }
      account = { ...account, displayName: body.displayName };
      return respond(200, account);
    },
  );
  context.mocks.api(
    connectorAccountsContract.deletionImpact,
    ({ params, respond }) => {
      return respond(200, {
        connectionId: params.connectionId,
        explicitSelectionCount: 2,
        hasSibling: false,
      });
    },
  );
  context.mocks.api(
    connectorAccountsContract.delete,
    async ({ params, respond }) => {
      await deletionPending;
      if (failFirstDelete) {
        failFirstDelete = false;
        return respond(500, {
          error: {
            message: "Disconnect failed",
            code: "INTERNAL_SERVER_ERROR",
          },
        });
      }
      account = null;
      context.mocks.data.connectors([]);
      return respond(200, {
        deletedConnectionId: params.connectionId,
        resolvedSelectionCount: 2,
        promotedDefaultConnectionId: null,
      });
    },
  );
  await setupPage({ context, path: "/connectors?keywords=github" });
  click(
    await waitFor(() => {
      return getConnectorAction("button", "Manage GitHub accounts");
    }),
  );
  const manager = await screen.findByRole("dialog", {
    name: "Manage GitHub accounts",
  });
  click(
    await waitFor(() => {
      const action = accountActions(manager)[0];
      if (!action) {
        throw new Error("Expected Work account actions");
      }
      return action;
    }),
  );
  click(
    await waitFor(() => {
      return getConnectorAction("menuitem", "Rename");
    }),
  );
  return manager;
}

test("Rename a specific connector account to a new label", async () => {
  const manager = await openNamedConnectorAccountRename();
  await fill(await within(manager).findByLabelText("Account name"), "Personal");
  click(getConnectorAction("button", "Save", manager));
  await waitFor(() => {
    expect(
      within(
        screen.getByRole("dialog", { name: "Manage GitHub accounts" }),
      ).getByText("Personal"),
    ).toBeInTheDocument();
  });
});

test("Keep a failed connector disconnect open and finish a successful retry", async () => {
  const deletionResponse = context.mocks.deferred<void>();
  const manager = await openNamedConnectorAccountRename({
    failFirstDelete: true,
    deletionPending: deletionResponse.promise,
  });
  await fill(await within(manager).findByLabelText("Account name"), " ");
  click(getConnectorAction("button", "Save", manager));
  await waitFor(() => {
    expect(within(manager).getAllByText("octocat")).toHaveLength(1);
  });

  click(
    await waitFor(() => {
      const action = accountActions(manager)[0];
      if (!action) {
        throw new Error("Expected octocat account actions");
      }
      return action;
    }),
  );
  click(
    await waitFor(() => {
      return getConnectorAction("menuitem", "Disconnect");
    }),
  );
  const confirmation = await screen.findByRole("dialog", {
    name: "Disconnect octocat?",
  });
  expect(
    within(confirmation).getByText(
      "This disconnects the account from Okou. 2 threads will return to default inheritance. The provider account will not be deleted.",
    ),
  ).toBeInTheDocument();
  click(getConnectorAction("button", "Disconnect account", confirmation));
  await waitFor(() => {
    expect(
      getConnectorAction("button", "Disconnecting...", confirmation),
    ).toBeDisabled();
  });
  deletionResponse.resolve();
  await expect(
    screen.findByText("Disconnect failed"),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(
      getConnectorAction("button", "Disconnect account", confirmation),
    ).toBeEnabled();
  });
  expect(confirmation).toBeInTheDocument();
  click(getConnectorAction("button", "Disconnect account", confirmation));
  await waitFor(() => {
    expect(within(manager).getByText("No accounts found")).toBeInTheDocument();
    expect(getConnectorAction("button", "Add account", manager)).toBeEnabled();
    expect(
      screen.queryByRole("dialog", { name: "Disconnect octocat?" }),
    ).not.toBeInTheDocument();
  });
});

test("Keep another account's confirmation open when an earlier disconnect finishes", async () => {
  const deletionResponse = context.mocks.deferred<void>();
  const [connector] = mockConnectors(context, [
    { connectorSlug: "github", externalUsername: "work" },
  ]);
  if (!connector) {
    throw new Error("Expected GitHub connector");
  }
  const work = builtinAccount({
    id: connector.id,
    displayName: "Work",
    isDefault: true,
    externalUsername: "work",
  });
  const personal = builtinAccount({
    id: crypto.randomUUID(),
    displayName: "Personal",
    isDefault: false,
    externalUsername: "personal",
  });
  let accounts = [work, personal];
  mockSavedConnectorAccounts(context, () => {
    return accounts;
  });
  context.mocks.api(
    connectorAccountsContract.deletionImpact,
    ({ params, respond }) => {
      return respond(200, {
        connectionId: params.connectionId,
        explicitSelectionCount: 0,
        hasSibling: accounts.length > 1,
      });
    },
  );
  context.mocks.api(
    connectorAccountsContract.delete,
    async ({ params, respond }) => {
      await deletionResponse.promise;
      accounts = accounts
        .filter((account) => {
          return account.id !== params.connectionId;
        })
        .map((account) => {
          return { ...account, isDefault: true };
        });
      return respond(200, {
        deletedConnectionId: params.connectionId,
        resolvedSelectionCount: 0,
        promotedDefaultConnectionId: accounts[0]?.id ?? null,
      });
    },
  );

  await setupAccountsPage();
  click(
    await waitFor(() => {
      return getConnectorAction("button", "Manage GitHub accounts");
    }),
  );
  const manager = await screen.findByRole("dialog", {
    name: "Manage GitHub accounts",
  });
  const workRow = await within(manager).findByRole("group", { name: "Work" });
  click(getConnectorAction("button", "Account actions", workRow));
  click(
    await waitFor(() => {
      return getConnectorAction("menuitem", "Disconnect");
    }),
  );
  const workConfirmation = await screen.findByRole("dialog", {
    name: "Disconnect Work?",
  });
  click(getConnectorAction("button", "Disconnect account", workConfirmation));
  await waitFor(() => {
    expect(
      getConnectorAction("button", "Disconnecting...", workConfirmation),
    ).toBeDisabled();
  });
  click(getConnectorAction("button", "Cancel", workConfirmation));

  const personalRow = await within(manager).findByRole("group", {
    name: "Personal",
  });
  click(getConnectorAction("button", "Account actions", personalRow));
  click(
    await waitFor(() => {
      return getConnectorAction("menuitem", "Disconnect");
    }),
  );
  const personalConfirmation = await screen.findByRole("dialog", {
    name: "Disconnect Personal?",
  });
  expect(
    getConnectorAction("button", "Disconnecting...", personalConfirmation),
  ).toBeDisabled();

  deletionResponse.resolve();
  await waitFor(() => {
    const confirmation = screen.getByRole("dialog", {
      name: "Disconnect Personal?",
    });
    expect(
      getConnectorAction("button", "Disconnect account", confirmation),
    ).toBeEnabled();
    expect(within(manager).getByText("Personal")).toBeInTheDocument();
    expect(within(manager).queryByText("Work")).not.toBeInTheDocument();
  });
});

test("Review and reconnect the connector account the user selected", async () => {
  const [connector] = mockConnectors(context, [
    { connectorSlug: "github", externalUsername: "work" },
  ]);
  if (!connector) {
    throw new Error("Expected GitHub connector");
  }
  const work = builtinAccount({
    id: connector.id,
    displayName: "Work",
    isDefault: true,
    externalUsername: "work",
  });
  const personal = builtinAccount({
    id: crypto.randomUUID(),
    displayName: "Personal",
    isDefault: false,
    externalUsername: "personal",
    scopeMismatch: true,
  });
  context.mocks.api(
    connectorAccountsContract.scopeDiff,
    ({ params, respond }) => {
      expect(params.connectionId).toBe(personal.id);
      return respond(200, {
        addedScopes: ["read:user"],
        removedScopes: [],
        currentScopes: ["read:user"],
        storedScopes: [],
      });
    },
  );
  context.mocks.api(connectorAccountsContract.connections, ({ respond }) => {
    return respond(200, {
      connections: [work, personal],
      nextCursor: null,
      defaultConnection: work,
    });
  });
  let submittedAccount: unknown;
  mockOAuthCompletions(context);
  context.mocks.api(
    builtinConnectorOauthStartContract.start,
    ({ body, respond }) => {
      submittedAccount = body.account;
      return respond(200, {
        authorizationUrl: "https://oauth.test/github/authorize",
        oauthAttemptId: crypto.randomUUID(),
      });
    },
  );
  const authWindow = createAuthWindow();
  context.mocks.browser.open(authWindow);
  await setupAccountsPage();

  click(
    await waitFor(() => {
      return getConnectorAction("button", "Manage GitHub accounts");
    }),
  );
  const manager = await screen.findByRole("dialog", {
    name: "Manage GitHub accounts",
  });
  const personalRow = within(manager).getByRole("group", { name: "Personal" });
  expect(within(personalRow).getByText("Update permissions")).toBeVisible();
  click(getConnectorAction("button", "Account actions", personalRow));
  click(getConnectorAction("menuitem", "Review permissions"));

  const review = await screen.findByRole("dialog", {
    name: "GitHub permissions update",
  });
  expect(within(review).getByText("read:user")).toBeVisible();
  click(getConnectorAction("button", "Reconnect", review));

  const reconnect = await waitFor(() => {
    const dialog = screen
      .getAllByRole("dialog", { name: "GitHub" })
      .find((candidate) => {
        return queryConnectorAction("button", "Reconnect", candidate);
      });
    if (!dialog) {
      throw new Error("Expected GitHub reconnect dialog");
    }
    return dialog;
  });
  click(getConnectorAction("button", "Reconnect", reconnect));

  await waitFor(() => {
    expect(authWindow.location.href).toBe(
      "https://oauth.test/github/authorize",
    );
  });
  expect(submittedAccount).toStrictEqual({
    intent: "reconnect",
    connectionId: personal.id,
  });
});

test("Let account search own the entire manager result list", async () => {
  const accounts = mockGithubAccounts(context, 7).map((account) => {
    return account.isDefault ? { ...account, displayName: "Primary" } : account;
  });
  context.mocks.api(
    connectorAccountsContract.connections,
    ({ query, respond }) => {
      const search = query.search?.toLowerCase();
      const connections = search
        ? accounts.filter((account) => {
            return account.displayName?.toLowerCase().includes(search);
          })
        : accounts;
      return respond(200, {
        connections,
        nextCursor: null,
        defaultConnection:
          accounts.find((account) => {
            return account.isDefault;
          }) ?? null,
      });
    },
  );
  await setupAccountsPage();
  click(
    await waitFor(() => {
      return getConnectorAction("button", "Manage GitHub accounts");
    }),
  );
  const manager = await screen.findByRole("dialog", {
    name: "Manage GitHub accounts",
  });
  const input = await within(manager).findByPlaceholderText("Find accounts");

  await fill(input, "No matching account");
  await waitFor(() => {
    expect(within(manager).getByText("No accounts found")).toBeInTheDocument();
  });
  expect(within(manager).queryByText("Primary")).not.toBeInTheDocument();

  await fill(input, "Primary");
  await waitFor(() => {
    expect(within(manager).getByText("Primary")).toBeInTheDocument();
    expect(
      within(manager).queryByText("No accounts found"),
    ).not.toBeInTheDocument();
  });
});

test("Keep the canonical default visible when it is outside the loaded account page", async () => {
  const accounts = mockGithubAccounts(context, 8);
  const canonicalDefault = accounts.find((account) => {
    return account.isDefault;
  });
  if (!canonicalDefault) {
    throw new Error("Expected the saved default account");
  }
  const otherAccounts = accounts.filter((account) => {
    return account.id !== canonicalDefault.id;
  });
  context.mocks.api(
    connectorAccountsContract.connections,
    ({ query, respond }) => {
      return respond(200, {
        connections: query.search
          ? otherAccounts.filter((account) => {
              return account.displayName?.includes(query.search ?? "");
            })
          : otherAccounts,
        nextCursor: null,
        defaultConnection: canonicalDefault,
      });
    },
  );
  await setupAccountsPage();
  click(
    await waitFor(() => {
      return getConnectorAction("button", "Manage GitHub accounts");
    }),
  );
  const manager = await screen.findByRole("dialog", {
    name: "Manage GitHub accounts",
  });
  const defaultRow = await within(manager).findByRole("group", {
    name: "Unnamed account",
  });
  expect(
    within(defaultRow).getByRole("radio", { name: "Default" }),
  ).toBeChecked();
  await fill(within(manager).getByPlaceholderText("Find accounts"), "Work 1");
  await waitFor(() => {
    expect(within(manager).getByText("Work 1")).toBeInTheDocument();
    expect(
      within(manager).queryByText("Unnamed account"),
    ).not.toBeInTheDocument();
  });
});

test("Manage connector accounts and agent access independently", async () => {
  const accounts = mockGithubAccounts(context, 7);
  context.mocks.api(connectorAccountsContract.connections, ({ respond }) => {
    return respond(200, {
      connections: accounts,
      nextCursor: null,
      defaultConnection:
        accounts.find((account) => {
          return account.isDefault;
        }) ?? null,
    });
  });
  await setupAccountsPage();
  const card = await waitFor(() => {
    return getConnectorCard("GitHub");
  });
  expect(card).toHaveTextContent("Connected");
  const manageAccounts = getConnectorAction(
    "button",
    "Manage GitHub accounts",
    card,
  );
  const manageAccess = getConnectorAction(
    "button",
    "Manage GitHub access",
    card,
  );

  click(manageAccess);

  const access = await screen.findByRole("dialog", {
    name: "Manage GitHub access",
  });
  expect(
    screen.queryByRole("dialog", { name: "Manage GitHub accounts" }),
  ).not.toBeInTheDocument();
  click(getConnectorAction("button", "Close", access));
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Manage GitHub access" }),
    ).not.toBeInTheDocument();
  });

  click(manageAccounts);

  const manager = await screen.findByRole("dialog", {
    name: "Manage GitHub accounts",
  });
  const defaultRow = within(manager).getByRole("group", {
    name: "Unnamed account",
  });
  expect(
    within(defaultRow).getByRole("radio", { name: "Default" }),
  ).toBeChecked();
  expect(
    within(defaultRow).getByText("Reconnect required"),
  ).toBeInTheDocument();
  expect(within(manager).getAllByText("Unnamed account")).toHaveLength(1);
});

test("Manage access for a connector without configurable permissions", async () => {
  const mediaId = "c0000000-0000-4000-a000-000000000003";
  mockConnectors(context, [
    {
      connectorSlug: "cloudinary",
      authMethod: "api-token",
      externalUsername: "demo-cloud",
    },
  ]);
  context.mocks.data.agents([listAgent(mediaId, "Media Agent")]);
  context.mocks.api(userBuiltinConnectorsContract.get, ({ respond }) => {
    return respond(200, { enabledConnectorSlugs: ["cloudinary"] });
  });
  mockConnectorAgentAccess(context, () => {
    return { enabledConnectorSlugs: ["cloudinary"] };
  });
  context.mocks.api(userPermissionGrantsContract.list, ({ respond }) => {
    return respond(200, []);
  });
  await setupPage({ context, path: "/connectors" });
  const card = await waitFor(() => {
    return getConnectorCard("Cloudinary");
  });

  click(getConnectorAction("button", "Manage Cloudinary access", card));

  const dialog = await screen.findByRole("dialog", {
    name: "Manage Cloudinary access",
  });
  expect(within(dialog).getByText("Media Agent")).toBeInTheDocument();
  await expect(
    waitFor(() => {
      return getConnectorSwitch(
        "Revoke Cloudinary access for Media Agent",
        dialog,
      );
    }),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).queryByText("Allowed")).not.toBeInTheDocument();
  expect(queryConnectorAction("button", "Manage", dialog)).toBeNull();
});

test("Prevent account additions when a connector target is unavailable", async () => {
  mockConnectors(context, [
    { connectorSlug: "github", externalUsername: "work" },
  ]);
  context.mocks.api(connectorAccountsContract.connections, ({ respond }) => {
    return respond(404, {
      error: { message: "Target unavailable", code: "NOT_FOUND" },
    });
  });
  await setupAccountsPage();
  click(
    await waitFor(() => {
      return getConnectorAction("button", "Manage GitHub accounts");
    }),
  );
  const manager = await screen.findByRole("dialog", {
    name: "Manage GitHub accounts",
  });

  await expect(
    within(manager).findByText("Accounts are unavailable for this connector."),
  ).resolves.toBeInTheDocument();
  expect(getConnectorAction("button", "Add account", manager)).toBeDisabled();
});

test("Read accounts only inside the manager and refresh them each time it opens", async () => {
  const [connector] = mockConnectors(context, [
    { connectorSlug: "github", externalUsername: "work" },
  ]);
  if (!connector) {
    throw new Error("Expected GitHub connector");
  }
  let work = builtinAccount({
    id: connector.id,
    displayName: "Work",
    isDefault: true,
    externalUsername: "work",
  });
  context.mocks.api(connectorAccountsContract.connections, ({ respond }) => {
    return respond(200, {
      connections: [work],
      defaultConnection: work,
      nextCursor: null,
    });
  });
  await setupAccountsPage();
  await waitFor(() => {
    expect(getConnectorCard("GitHub")).toHaveTextContent("Connected");
  });
  expect(screen.queryByText("Work")).not.toBeInTheDocument();
  click(getConnectorAction("button", "Manage GitHub accounts"));
  const manager = await screen.findByRole("dialog", {
    name: "Manage GitHub accounts",
  });
  await within(manager).findByText("Work");
  click(getConnectorAction("button", "Close", manager));
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", {
        name: "Manage GitHub accounts",
      }),
    ).not.toBeInTheDocument();
  });
  work = { ...work, displayName: "Updated elsewhere" };
  click(getConnectorAction("button", "Manage GitHub accounts"));
  const reopened = await screen.findByRole("dialog", {
    name: "Manage GitHub accounts",
  });
  await within(reopened).findByText("Updated elsewhere");
  expect(within(reopened).queryByText("Work")).not.toBeInTheDocument();
});
