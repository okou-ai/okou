import {
  type ConnectorAccountConnection,
  connectorAccountsContract,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { builtinConnectorOauthStartContract } from "@okouai/api-contracts/contracts/connectors";

import { chatConnectorAccessContract } from "@okouai/api-contracts/contracts/chat-connector-access";

import { screen, waitFor, within } from "@testing-library/react";

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
  mockConnectors,
  mockSavedConnectorAccounts,
  mockGithubAccounts,
  mockOAuthCompletions,
  mockPublicConnectorStatus,
  publicStatusItem,
  queryConnectorAction,
} from "./connector-page-test-helpers.ts";

const context = testContext();

async function openAccountAvailabilityManager({
  defaultAccount,
  enabledAccounts,
}: {
  readonly defaultAccount: "Work" | "Personal";
  readonly enabledAccounts: readonly ("Work" | "Personal")[];
}) {
  const [connector] = mockConnectors(context, [
    { connectorSlug: "github", externalUsername: "work" },
  ]);
  if (!connector) {
    throw new Error("Expected GitHub connector");
  }
  let accounts = [
    builtinAccount({
      id: connector.id,
      displayName: "Work",
      isDefault: defaultAccount === "Work",
      externalUsername: "work",
    }),
    builtinAccount({
      id: crypto.randomUUID(),
      displayName: "Personal",
      isDefault: defaultAccount === "Personal",
      externalUsername: "personal",
    }),
  ];
  const enabled = new Set(
    accounts
      .filter((account) => {
        return enabledAccounts.some((name) => {
          return account.displayName === name;
        });
      })
      .map((account) => {
        return account.id;
      }),
  );
  const readDefault = (connectionId: string) => {
    const account = accounts.find((candidate) => {
      return candidate.id === connectionId;
    });
    if (!account) {
      throw new Error("Expected saved account");
    }
    return {
      connectionId: account.id,
      displayName: account.displayName,
      defaultEnabled: enabled.has(account.id),
      isDefault: account.isDefault,
    };
  };
  const repairDefault = () => {
    const current =
      accounts.find((account) => {
        return account.isDefault && enabled.has(account.id);
      }) ??
      accounts.find((account) => {
        return enabled.has(account.id);
      });
    accounts = accounts.map((account) => {
      return { ...account, isDefault: account.id === current?.id };
    });
  };
  mockSavedConnectorAccounts(context, () => {
    return accounts;
  });
  context.mocks.api(
    chatConnectorAccessContract.accountDefaults,
    ({ respond }) => {
      return respond(
        200,
        accounts.map((account) => {
          return readDefault(account.id);
        }),
      );
    },
  );
  context.mocks.api(
    chatConnectorAccessContract.updateAccountDefault,
    ({ params, body, respond }) => {
      if (body.enabled) {
        enabled.add(params.connectionId);
      } else {
        enabled.delete(params.connectionId);
      }
      repairDefault();
      return respond(200, readDefault(params.connectionId));
    },
  );
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
  context.mocks.api(connectorAccountsContract.delete, ({ params, respond }) => {
    accounts = accounts.filter((account) => {
      return account.id !== params.connectionId;
    });
    repairDefault();
    return respond(200, {
      deletedConnectionId: params.connectionId,
      resolvedSelectionCount: 0,
      promotedDefaultConnectionId:
        accounts.find((account) => {
          return account.isDefault;
        })?.id ?? null,
    });
  });
  await setupPage({
    context,
    path: "/connectors",
    locale: "en-US",
    featureSwitches: {},
  });
  click(
    await waitFor(() => {
      return getConnectorAction("button", "Manage GitHub accounts");
    }),
  );
  const manager = await screen.findByRole("dialog", {
    name: "Manage GitHub accounts",
  });
  const toggle = (name: string) => {
    return waitFor(() => {
      const control = within(manager).getByRole("switch", {
        name: `Enable ${name} by default`,
      });
      expect(control).toBeEnabled();
      return control;
    });
  };
  return { manager, toggle };
}

test("Manage each saved account's default availability independently", async () => {
  const { manager, toggle } = await openAccountAvailabilityManager({
    defaultAccount: "Work",
    enabledAccounts: ["Work", "Personal"],
  });
  await expect(toggle("Work")).resolves.toBeChecked();
  await expect(toggle("Personal")).resolves.toBeChecked();
  expect(
    within(manager).getByText(
      "Choose which GitHub accounts Okou can use across your chats. You can change access in each chat.",
    ),
  ).toBeInTheDocument();
  click(await toggle("Work"));
  await expect(toggle("Work")).resolves.not.toBeChecked();
  await expect(toggle("Personal")).resolves.toBeChecked();
});

test("Disable all saved accounts and enable an account again", async () => {
  const { toggle } = await openAccountAvailabilityManager({
    defaultAccount: "Personal",
    enabledAccounts: ["Personal"],
  });
  await expect(toggle("Personal")).resolves.toBeChecked();
  click(await toggle("Personal"));
  await expect(toggle("Personal")).resolves.not.toBeChecked();
  await expect(toggle("Work")).resolves.not.toBeChecked();
  click(await toggle("Work"));
  await expect(toggle("Work")).resolves.toBeChecked();
});

test("Disconnect an account while retaining another enabled account", async () => {
  const { manager, toggle } = await openAccountAvailabilityManager({
    defaultAccount: "Work",
    enabledAccounts: ["Work"],
  });
  await expect(toggle("Work")).resolves.toBeChecked();
  click(await toggle("Personal"));
  await waitFor(() => {
    expect(
      within(manager).getByRole("switch", {
        name: "Enable Personal by default",
      }),
    ).toBeChecked();
  });
  const workRow = within(manager).getByRole("group", { name: "Work" });
  click(getConnectorAction("button", "Account actions", workRow));
  click(
    await waitFor(() => {
      return getConnectorAction("menuitem", "Disconnect");
    }),
  );
  const confirmation = await screen.findByRole("dialog", {
    name: "Disconnect Work?",
  });
  click(getConnectorAction("button", "Disconnect account", confirmation));
  await waitFor(() => {
    expect(within(manager).queryByRole("group", { name: "Work" })).toBeNull();
  });
  await expect(toggle("Personal")).resolves.toBeChecked();
});

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
  expect(
    within(manager).getByRole("status", { name: "Loading accounts…" }),
  ).toBeInTheDocument();
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
