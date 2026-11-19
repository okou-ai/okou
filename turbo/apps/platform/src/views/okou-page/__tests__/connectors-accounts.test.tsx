import {
  type ConnectorAccountConnection,
  connectorAccountTargetKey,
  connectorAccountsContract,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { chatConnectorAccessContract } from "@okouai/api-contracts/contracts/chat-connector-access";
import { connectedConnectorsContract } from "@okouai/api-contracts/contracts/connected-connectors";
import { builtinConnectorOauthStartContract } from "@okouai/api-contracts/contracts/connectors";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getConnectorAction,
  mockPublicConnectorStatus,
  publicStatusItem,
} from "./connector-page-test-helpers.ts";

const context = testContext();

interface AccountStore {
  accounts: ConnectorAccountConnection[];
  readonly enabled: Map<string, boolean>;
}

function savedAccount(
  connectorSlug: ConnectorSlug,
  displayName: string | null,
  overrides: Partial<Omit<ConnectorAccountConnection, "target">> = {},
): ConnectorAccountConnection {
  return {
    id: crypto.randomUUID(),
    target: { kind: "builtin", connectorSlug },
    authMethod: "oauth",
    displayName,
    isDefault: false,
    externalId: null,
    externalUsername: null,
    externalEmail: null,
    oauthScopes: [],
    connectionStatus: "connected",
    missingRequiredFields: [],
    configuredFieldKeys: [],
    reconnectReason: null,
    tokenExpiresAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * The saved accounts API: the connected list, the per-target account pages
 * (with search), default availability, and disconnection.
 */
function mockAccountStore(
  initial: readonly {
    readonly account: ConnectorAccountConnection;
    readonly enabled: boolean;
  }[],
  options: {
    readonly beforeAccountPage?: () => Promise<void>;
  } = {},
): AccountStore {
  const store: AccountStore = {
    accounts: initial.map(({ account }) => {
      return account;
    }),
    enabled: new Map(
      initial.map(({ account, enabled }) => {
        return [account.id, enabled] as const;
      }),
    ),
  };
  context.mocks.api(connectedConnectorsContract.list, ({ respond }) => {
    const slugs = new Set(
      store.accounts.flatMap((account) => {
        return account.target.kind === "builtin"
          ? [account.target.connectorSlug]
          : [];
      }),
    );
    return respond(200, {
      builtinConnectors: [...slugs].map((slug) => {
        return {
          slug,
          label: slug,
          icon: {
            url: `https://icons.example.test/${slug}.svg`,
            invertInDarkMode: false,
          },
          hasPermissions: true,
        };
      }),
      customConnectors: [],
    });
  });
  context.mocks.api(
    connectorAccountsContract.connections,
    async ({ query, respond }) => {
      await options.beforeAccountPage?.();
      const search = query.search?.toLowerCase() ?? "";
      const connections = store.accounts.filter((account) => {
        return (
          connectorAccountTargetKey(account.target) ===
            connectorAccountTargetKey(query) &&
          (account.displayName ?? "").toLowerCase().includes(search)
        );
      });
      return respond(200, {
        connections,
        nextCursor: null,
        defaultConnection:
          store.accounts.find((account) => {
            return account.isDefault;
          }) ?? null,
      });
    },
  );
  context.mocks.api(
    chatConnectorAccessContract.accountDefaults,
    ({ query, respond }) => {
      return respond(
        200,
        store.accounts
          .filter((account) => {
            return (
              connectorAccountTargetKey(account.target) ===
              connectorAccountTargetKey(query)
            );
          })
          .map((account) => {
            return {
              connectionId: account.id,
              displayName: account.displayName,
              defaultEnabled: store.enabled.get(account.id) ?? false,
              isDefault: account.isDefault,
            };
          }),
      );
    },
  );
  context.mocks.api(
    chatConnectorAccessContract.updateAccountDefault,
    ({ params, body, respond }) => {
      const account = store.accounts.find((candidate) => {
        return candidate.id === params.connectionId;
      });
      if (!account) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "Account not found" },
        });
      }
      store.enabled.set(account.id, body.enabled);
      return respond(200, {
        connectionId: account.id,
        displayName: account.displayName,
        defaultEnabled: body.enabled,
        isDefault: account.isDefault,
      });
    },
  );
  return store;
}

function mockDeletion(
  store: AccountStore,
  options: {
    readonly explicitSelectionCount?: number;
    readonly beforeDelete?: (connectionId: string) => Promise<boolean>;
  } = {},
): void {
  context.mocks.api(
    connectorAccountsContract.deletionImpact,
    ({ params, respond }) => {
      return respond(200, {
        connectionId: params.connectionId,
        explicitSelectionCount: options.explicitSelectionCount ?? 0,
        hasSibling: store.accounts.length > 1,
      });
    },
  );
  context.mocks.api(
    connectorAccountsContract.delete,
    async ({ params, respond }) => {
      const succeed =
        (await options.beforeDelete?.(params.connectionId)) ?? true;
      if (!succeed) {
        return respond(500, {
          error: { code: "INTERNAL_ERROR", message: "Disconnect failed" },
        });
      }
      store.accounts = store.accounts.filter((account) => {
        return account.id !== params.connectionId;
      });
      return respond(200, {
        deletedConnectionId: params.connectionId,
        resolvedSelectionCount: options.explicitSelectionCount ?? 0,
        promotedDefaultConnectionId: null,
      });
    },
  );
}

async function findAction(
  role: "button" | "link" | "menuitem",
  name: string,
  container: ParentNode = document.body,
): Promise<HTMLElement> {
  return await waitFor(() => {
    return getConnectorAction(role, name, container);
  });
}

async function openAccountManager(connector: string): Promise<HTMLElement> {
  const manage = await findAction("button", `Manage ${connector} accounts`);
  await waitFor(() => {
    expect(manage).toBeEnabled();
  });
  click(manage);
  return await screen.findByRole("dialog", {
    name: `Manage ${connector} accounts`,
  });
}

function accountRow(manager: HTMLElement, label: string): HTMLElement {
  return within(manager).getByRole("group", { name: label });
}

async function findAccountRow(
  manager: HTMLElement,
  label: string,
): Promise<HTMLElement> {
  return await within(manager).findByRole("group", { name: label });
}

async function chooseAccountAction(
  row: HTMLElement,
  action: string,
): Promise<void> {
  click(getConnectorAction("button", "Account actions", row));
  click(await findAction("menuitem", action));
}

test("Manage each saved account's default availability independently", async () => {
  const work = savedAccount("github", "Work", { isDefault: true });
  const personal = savedAccount("github", "Personal");
  const store = mockAccountStore([
    { account: work, enabled: true },
    { account: personal, enabled: true },
  ]);
  await setupPage({ context, path: "/connectors?scope=connected" });

  const manager = await openAccountManager("GitHub");
  const workSwitch = await within(manager).findByRole("switch", {
    name: "Enable Work by default",
  });
  await waitFor(() => {
    expect(workSwitch).toBeEnabled();
  });
  expect(workSwitch).toBeChecked();
  click(workSwitch);

  await waitFor(() => {
    expect(
      within(manager).getByRole("switch", { name: "Enable Work by default" }),
    ).not.toBeChecked();
  });
  expect(store.enabled.get(work.id)).toBeFalsy();
  expect(
    within(manager).getByRole("switch", { name: "Enable Personal by default" }),
  ).toBeChecked();
  expect(
    within(manager).getByText(
      "Choose which GitHub accounts Okou can use across your chats. You can change access in each chat.",
    ),
  ).toBeInTheDocument();
});

test("Disconnect an account while retaining another enabled account", async () => {
  const work = savedAccount("github", "Work", { isDefault: true });
  const personal = savedAccount("github", "Personal");
  const store = mockAccountStore([
    { account: work, enabled: true },
    { account: personal, enabled: false },
  ]);
  mockDeletion(store);
  await setupPage({ context, path: "/connectors?scope=connected" });

  const manager = await openAccountManager("GitHub");
  const personalSwitch = await within(manager).findByRole("switch", {
    name: "Enable Personal by default",
  });
  await waitFor(() => {
    expect(personalSwitch).toBeEnabled();
  });
  expect(personalSwitch).not.toBeChecked();
  click(personalSwitch);
  await waitFor(() => {
    expect(
      within(manager).getByRole("switch", {
        name: "Enable Personal by default",
      }),
    ).toBeChecked();
  });

  await chooseAccountAction(accountRow(manager, "Work"), "Disconnect");
  const confirmation = await screen.findByRole("dialog", {
    name: "Disconnect Work?",
  });
  click(getConnectorAction("button", "Disconnect account", confirmation));
  await waitFor(() => {
    expect(confirmation).not.toBeInTheDocument();
  });

  await waitFor(() => {
    expect(
      within(manager).queryByRole("group", { name: "Work" }),
    ).not.toBeInTheDocument();
  });
  expect(accountRow(manager, "Personal")).toBeInTheDocument();
  expect(
    within(manager).getByRole("switch", { name: "Enable Personal by default" }),
  ).toBeChecked();
});

test("Keep the exact account and current reconnect UI when future setup metadata is present", async () => {
  const accountPage = context.mocks.deferred<void>();
  mockAccountStore(
    [
      {
        account: savedAccount("github", "Prepared work account", {
          isDefault: true,
          connectionStatus: "reconnect-required",
          reconnectReason: "authorization_expired_or_revoked",
          configuredFieldKeys: ["accessToken"],
          missingRequiredFields: [],
        }),
        enabled: true,
      },
    ],
    {
      beforeAccountPage: () => {
        return accountPage.promise;
      },
    },
  );
  await setupPage({ context, path: "/connectors?scope=connected" });

  const manage = await findAction("button", "Manage GitHub accounts");
  const card = manage.parentElement;
  if (!card) {
    throw new Error("GitHub card has no container");
  }
  await waitFor(() => {
    expect(within(card).getByText("Connected")).toBeInTheDocument();
  });
  const manager = await openAccountManager("GitHub");
  expect(
    within(manager).getByRole("status", { name: "Loading accounts…" }),
  ).toBeInTheDocument();

  accountPage.resolve();
  const row = await findAccountRow(manager, "Prepared work account");
  expect(getConnectorAction("button", "Reconnect", row)).toBeEnabled();
  expect(
    within(manager).queryByRole("status", { name: "Loading accounts…" }),
  ).not.toBeInTheDocument();
});

test("Show Mercury disclosures while managing its accounts", async () => {
  mockPublicConnectorStatus(context, [
    publicStatusItem({ connectorSlug: "mercury", label: "Mercury" }),
  ]);
  mockAccountStore([
    {
      account: savedAccount("mercury", "Operating", { isDefault: true }),
      enabled: true,
    },
  ]);
  await setupPage({ context, path: "/connectors?scope=connected" });

  const manage = await findAction("button", "Manage Mercury accounts");
  const card = manage.parentElement;
  if (!card) {
    throw new Error("Mercury card has no container");
  }
  expect(
    getConnectorAction("link", "Powered by Mercury", card),
  ).toHaveAttribute("href", "https://mercury.com");

  const manager = await openAccountManager("Mercury");
  const disclosure = within(manager).getByRole("region", {
    name: "Mercury banking disclosure",
  });
  expect(
    getConnectorAction("link", "Powered by Mercury", disclosure),
  ).toHaveAttribute("href", "https://mercury.com");
  expect(
    within(disclosure).getByText(
      "Mercury is a fintech company, not an FDIC-insured bank. Banking services provided through Choice Financial Group and Column N.A., Members FDIC.",
    ),
  ).toBeInTheDocument();
});

test("Keep a failed connector disconnect open and finish a successful retry", async () => {
  const octocat = savedAccount("github", "octocat", { isDefault: true });
  const store = mockAccountStore([{ account: octocat, enabled: true }]);
  const firstAttempt = context.mocks.deferred<boolean>();
  let attempts = 0;
  mockDeletion(store, {
    explicitSelectionCount: 2,
    beforeDelete: () => {
      attempts += 1;
      return attempts === 1 ? firstAttempt.promise : Promise.resolve(true);
    },
  });
  await setupPage({ context, path: "/connectors?scope=connected" });

  const manager = await openAccountManager("GitHub");
  await chooseAccountAction(
    await findAccountRow(manager, "octocat"),
    "Disconnect",
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

  firstAttempt.resolve(false);
  await expect(
    screen.findByText("Disconnect failed"),
  ).resolves.toBeInTheDocument();
  expect(confirmation).toBeInTheDocument();
  const retry = getConnectorAction(
    "button",
    "Disconnect account",
    confirmation,
  );
  expect(retry).toBeEnabled();

  click(retry);
  await waitFor(() => {
    expect(confirmation).not.toBeInTheDocument();
  });
  await expect(
    within(manager).findByText("No accounts found"),
  ).resolves.toBeInTheDocument();
  expect(
    within(manager).queryByRole("group", { name: "octocat" }),
  ).not.toBeInTheDocument();
  expect(getConnectorAction("button", "Add account", manager)).toBeEnabled();
});

test("Keep another account's confirmation open when an earlier disconnect finishes", async () => {
  const work = savedAccount("github", "Work", { isDefault: true });
  const personal = savedAccount("github", "Personal");
  const store = mockAccountStore([
    { account: work, enabled: true },
    { account: personal, enabled: true },
  ]);
  const workDeletion = context.mocks.deferred<boolean>();
  mockDeletion(store, {
    beforeDelete: (connectionId) => {
      return connectionId === work.id
        ? workDeletion.promise
        : Promise.resolve(true);
    },
  });
  await setupPage({ context, path: "/connectors?scope=connected" });

  const manager = await openAccountManager("GitHub");
  await chooseAccountAction(
    await findAccountRow(manager, "Work"),
    "Disconnect",
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
  await waitFor(() => {
    expect(workConfirmation).not.toBeInTheDocument();
  });

  await chooseAccountAction(accountRow(manager, "Personal"), "Disconnect");
  const personalConfirmation = await screen.findByRole("dialog", {
    name: "Disconnect Personal?",
  });
  workDeletion.resolve(true);

  await waitFor(() => {
    expect(
      getConnectorAction("button", "Disconnect account", personalConfirmation),
    ).toBeEnabled();
  });
  // The open confirmation makes the manager inert, so its rows are read as
  // hidden content.
  await waitFor(() => {
    expect(
      within(manager).queryByRole("group", { name: "Work", hidden: true }),
    ).not.toBeInTheDocument();
  });
  expect(personalConfirmation).toBeInTheDocument();
  expect(
    within(manager).getByRole("group", { name: "Personal", hidden: true }),
  ).toBeInTheDocument();
});

test("Review and reconnect the connector account the user selected", async () => {
  const work = savedAccount("github", "Work", { isDefault: true });
  const personal = savedAccount("github", "Personal", { scopeMismatch: true });
  mockAccountStore([
    { account: work, enabled: true },
    { account: personal, enabled: true },
  ]);
  let reviewedConnectionId: string | null = null;
  context.mocks.api(
    connectorAccountsContract.scopeDiff,
    ({ params, respond }) => {
      reviewedConnectionId = params.connectionId;
      return respond(200, {
        addedScopes: ["read:user"],
        removedScopes: [],
        currentScopes: ["repo", "read:user"],
        storedScopes: ["repo"],
      });
    },
  );
  let reconnectAccount: unknown = null;
  context.mocks.api(
    builtinConnectorOauthStartContract.start,
    ({ body, respond }) => {
      reconnectAccount = body.account;
      return respond(200, {
        authorizationUrl: "https://oauth.test/github/reconnect",
        oauthAttemptId: crypto.randomUUID(),
      });
    },
  );
  const authWindow = context.mocks.browser.authWindow();
  Object.defineProperty(authWindow, "location", {
    configurable: true,
    value: { href: "about:blank" },
  });
  context.mocks.browser.open(authWindow);
  await setupPage({ context, path: "/connectors?scope=connected" });

  const manager = await openAccountManager("GitHub");
  const personalRow = await findAccountRow(manager, "Personal");
  expect(within(personalRow).getByText("Update permissions")).toBeVisible();
  await chooseAccountAction(personalRow, "Review permissions");
  const review = await screen.findByRole("dialog", {
    name: "GitHub permissions update",
  });
  await expect(within(review).findByText("read:user")).resolves.toBeVisible();
  expect(reviewedConnectionId).toBe(personal.id);

  click(getConnectorAction("button", "Reconnect", review));
  const connect = await screen.findByRole("dialog", { name: "GitHub" });
  click(getConnectorAction("button", "Reconnect", connect));

  await waitFor(() => {
    expect(authWindow.location.href).toBe(
      "https://oauth.test/github/reconnect",
    );
  });
  expect(reconnectAccount).toStrictEqual({
    intent: "reconnect",
    connectionId: personal.id,
  });
});

test("Let account search own the entire manager result list", async () => {
  mockAccountStore(
    ["Primary", "Work 1", "Work 2", "Work 3", "Work 4", "Work 5", "Work 6"].map(
      (name, index) => {
        return {
          account: savedAccount("github", name, { isDefault: index === 0 }),
          enabled: true,
        };
      },
    ),
  );
  await setupPage({ context, path: "/connectors?scope=connected" });

  const manager = await openAccountManager("GitHub");
  const search = await within(manager).findByRole("textbox", {
    name: "Find accounts",
  });
  await findAccountRow(manager, "Primary");
  await fill(search, "Nobody");
  await expect(
    within(manager).findByText("No accounts found"),
  ).resolves.toBeInTheDocument();
  expect(
    within(manager).queryByRole("group", { name: "Primary" }),
  ).not.toBeInTheDocument();

  await fill(search, "Primary");
  await findAccountRow(manager, "Primary");
  expect(
    within(manager).queryByText("No accounts found"),
  ).not.toBeInTheDocument();
});

test("Read accounts only inside the manager and refresh them each time it opens", async () => {
  const work = savedAccount("github", "Work", { isDefault: true });
  const store = mockAccountStore([{ account: work, enabled: true }]);
  await setupPage({ context, path: "/connectors?scope=connected" });

  await findAction("button", "Manage GitHub accounts");
  expect(screen.queryByText("Work")).not.toBeInTheDocument();
  const first = await openAccountManager("GitHub");
  await findAccountRow(first, "Work");
  click(getConnectorAction("button", "Close", first));
  await waitFor(() => {
    expect(first).not.toBeInTheDocument();
  });

  store.accounts = [{ ...work, displayName: "Updated elsewhere" }];
  const reopened = await openAccountManager("GitHub");
  await findAccountRow(reopened, "Updated elsewhere");
  expect(
    within(reopened).queryByRole("group", { name: "Work" }),
  ).not.toBeInTheDocument();
});
