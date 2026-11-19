import {
  type ConnectorAccountConnection,
  connectorAccountTargetKey,
  connectorAccountsContract,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { chatConnectorAccessContract } from "@okouai/api-contracts/contracts/chat-connector-access";
import { connectedConnectorsContract } from "@okouai/api-contracts/contracts/connected-connectors";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { getConnectorAction } from "./connector-page-test-helpers.ts";

const context = testContext();

type Modality = "keyboard" | "pointer";

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

interface AccountServer {
  readonly accounts: ConnectorAccountConnection[];
  readonly renames: { connectionId: string; displayName: string | null }[];
  /** Hold the next rename response until the returned gate opens. */
  holdNextRename: () => {
    readonly received: Promise<void>;
    readonly release: () => void;
    readonly answered: Promise<void>;
  };
  /** Hold the next account list response until the returned gate opens. */
  holdNextList: () => {
    readonly requested: Promise<void>;
    readonly release: () => void;
  };
}

function githubAccount(
  displayName: string,
  isDefault: boolean,
): ConnectorAccountConnection {
  return {
    id: crypto.randomUUID(),
    target: { kind: "builtin", connectorSlug: "github" },
    authMethod: "oauth",
    displayName,
    isDefault,
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
  };
}

function deferred(): Deferred {
  const gate = context.mocks.deferred<void>();
  return {
    promise: gate.promise,
    resolve: () => {
      gate.resolve();
    },
  };
}

/** Saved GitHub accounts behind the connector accounts API. */
function mockGithubAccounts(): AccountServer {
  const accounts = [
    githubAccount("Work 1", true),
    githubAccount("Work 2", false),
  ];
  const renames: AccountServer["renames"] = [];
  let renameHold: {
    received: Deferred;
    gate: Deferred;
    answered: Deferred;
  } | null = null;
  let listHold: { requested: Deferred; gate: Deferred } | null = null;

  context.mocks.api(connectedConnectorsContract.list, ({ respond }) => {
    return respond(200, {
      builtinConnectors: [
        {
          slug: "github",
          label: "GitHub",
          icon: {
            url: "https://icons.example.test/github.svg",
            invertInDarkMode: false,
          },
          hasPermissions: true,
        },
      ],
      customConnectors: [],
    });
  });
  context.mocks.api(
    connectorAccountsContract.connections,
    async ({ query, respond }) => {
      const hold = listHold;
      listHold = null;
      if (hold) {
        hold.requested.resolve();
        await hold.gate.promise;
      }
      const search = query.search?.toLowerCase() ?? "";
      return respond(200, {
        connections: accounts.filter((account) => {
          return (
            connectorAccountTargetKey(account.target) ===
              connectorAccountTargetKey(query) &&
            (account.displayName ?? "").toLowerCase().includes(search)
          );
        }),
        nextCursor: null,
        defaultConnection:
          accounts.find((account) => {
            return account.isDefault;
          }) ?? null,
      });
    },
  );
  context.mocks.api(
    chatConnectorAccessContract.accountDefaults,
    ({ respond }) => {
      return respond(
        200,
        accounts.map((account) => {
          return {
            connectionId: account.id,
            displayName: account.displayName,
            defaultEnabled: true,
            isDefault: account.isDefault,
          };
        }),
      );
    },
  );
  context.mocks.api(
    connectorAccountsContract.rename,
    async ({ params, body, respond }) => {
      renames.push({
        connectionId: params.connectionId,
        displayName: body.displayName,
      });
      const hold = renameHold;
      renameHold = null;
      if (hold) {
        hold.received.resolve();
        await hold.gate.promise;
      }
      const index = accounts.findIndex((account) => {
        return account.id === params.connectionId;
      });
      const account = accounts[index];
      if (!account) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "Account not found" },
        });
      }
      const renamed = { ...account, displayName: body.displayName };
      accounts[index] = renamed;
      hold?.answered.resolve();
      return respond(200, renamed);
    },
  );

  return {
    accounts,
    renames,
    holdNextRename: () => {
      const hold = {
        received: deferred(),
        gate: deferred(),
        answered: deferred(),
      };
      renameHold = hold;
      return {
        received: hold.received.promise,
        release: hold.gate.resolve,
        answered: hold.answered.promise,
      };
    },
    holdNextList: () => {
      const hold = { requested: deferred(), gate: deferred() };
      listHold = hold;
      return {
        requested: hold.requested.promise,
        release: hold.gate.resolve,
      };
    },
  };
}

async function findAction(
  role: "button" | "menuitem",
  name: string,
  container: ParentNode = document.body,
): Promise<HTMLElement> {
  return await waitFor(() => {
    return getConnectorAction(role, name, container);
  });
}

async function openGithubManager(): Promise<HTMLElement> {
  const manage = await findAction("button", "Manage GitHub accounts");
  await waitFor(() => {
    expect(manage).toBeEnabled();
  });
  click(manage);
  const manager = await screen.findByRole("dialog", {
    name: "Manage GitHub accounts",
  });
  await within(manager).findByRole("group", { name: "Work 1" });
  return manager;
}

function accountActions(manager: HTMLElement, account: string): HTMLElement {
  return getConnectorAction(
    "button",
    "Account actions",
    within(manager).getByRole("group", { name: account }),
  );
}

async function openAccountMenu(
  trigger: HTMLElement,
  modality: Modality,
): Promise<HTMLElement> {
  if (modality === "keyboard") {
    trigger.focus();
    await userEvent.setup().keyboard("{Enter}");
  } else {
    click(trigger);
  }
  return await screen.findByRole("menu");
}

/** The menu opens on its first item; move down to the target and press Enter. */
async function chooseWithKeyboard(item: HTMLElement): Promise<void> {
  const user = userEvent.setup();
  await user.keyboard("{ArrowDown}");
  await waitFor(() => {
    expect(item).toHaveFocus();
  });
  await user.keyboard("{Enter}");
}

async function startRename(
  manager: HTMLElement,
  account: string,
  modality: Modality,
): Promise<HTMLInputElement> {
  const menu = await openAccountMenu(
    accountActions(manager, account),
    modality,
  );
  const rename = await findAction("menuitem", "Rename", menu);
  await (modality === "keyboard"
    ? chooseWithKeyboard(rename)
    : Promise.resolve(click(rename)));
  const input = await within(manager).findByRole("textbox", {
    name: "Account name",
  });
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("Account name is not an input");
  }
  await waitFor(() => {
    expect(input).toHaveFocus();
  });
  return input;
}

test.each(["keyboard", "pointer"] as const)(
  "Keep input navigation focus after %s account rename",
  async (modality) => {
    const server = mockGithubAccounts();
    await setupPage({ context, path: "/connectors?scope=connected" });
    const manager = await openGithubManager();
    const user = userEvent.setup();

    const input = await startRename(manager, "Work 1", modality);
    await user.keyboard("x");
    expect(input).toHaveValue("Work 1x");

    await user.tab();
    expect(getConnectorAction("button", "Cancel", manager)).toHaveFocus();
    await user.tab({ shift: true });
    expect(input).toHaveFocus();

    await user.tab({ shift: true });
    expect(input).not.toHaveFocus();
    expect(manager).toContainElement(
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null,
    );

    await user.tab();
    expect(input).toHaveFocus();
    expect(input).toHaveValue("Work 1x");
    expect(server.renames).toStrictEqual([]);
  },
);

test.each(["keyboard", "pointer"] as const)(
  "Keep account menu focus after %s account rename",
  async (modality) => {
    const server = mockGithubAccounts();
    await setupPage({ context, path: "/connectors?scope=connected" });
    const manager = await openGithubManager();
    const user = userEvent.setup();

    await startRename(manager, "Work 1", modality);
    await user.tab();
    const cancel = getConnectorAction("button", "Cancel", manager);
    expect(cancel).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(accountActions(manager, "Work 1")).toHaveFocus();
    });

    const menu = await openAccountMenu(
      accountActions(manager, "Work 1"),
      modality,
    );
    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(menu).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(accountActions(manager, "Work 1")).toHaveFocus();
    });
    expect(manager).toBeInTheDocument();
    expect(
      within(manager).queryByRole("textbox", { name: "Account name" }),
    ).not.toBeInTheDocument();
    expect(server.renames).toStrictEqual([]);
  },
);

test("Restore the renamed account actions only after the refreshed list arrives", async () => {
  const server = mockGithubAccounts();
  await setupPage({ context, path: "/connectors?scope=connected" });
  const manager = await openGithubManager();

  const input = await startRename(manager, "Work 1", "pointer");
  await fill(input, "Research");
  const renameResponse = server.holdNextRename();
  click(getConnectorAction("button", "Save", manager));
  await renameResponse.received;
  const refreshedList = server.holdNextList();
  renameResponse.release();
  await refreshedList.requested;

  expect(getConnectorAction("button", "Save", manager)).toBeDisabled();
  expect(input).toHaveFocus();
  expect(
    within(manager).queryByRole("group", { name: "Research" }),
  ).not.toBeInTheDocument();

  refreshedList.release();
  await waitFor(() => {
    expect(accountActions(manager, "Research")).toHaveFocus();
  });
  const menu = await openAccountMenu(
    accountActions(manager, "Research"),
    "pointer",
  );
  expect(getConnectorAction("menuitem", "Rename", menu)).toBeInTheDocument();
  expect(server.renames).toStrictEqual([
    { connectionId: server.accounts[0]?.id, displayName: "Research" },
  ]);
});

test("Keep focus outside a manager closed during a delayed rename", async () => {
  const server = mockGithubAccounts();
  await setupPage({ context, path: "/connectors?scope=connected" });
  const manager = await openGithubManager();
  const user = userEvent.setup();

  const input = await startRename(manager, "Work 1", "pointer");
  await fill(input, "Research");
  const renameResponse = server.holdNextRename();
  click(getConnectorAction("button", "Save", manager));
  await renameResponse.received;

  click(getConnectorAction("button", "Close", manager));
  await waitFor(() => {
    expect(manager).not.toBeInTheDocument();
  });
  const elsewhere = screen.getByPlaceholderText("Find connected connectors");
  await user.click(elsewhere);
  expect(elsewhere).toHaveFocus();

  renameResponse.release();
  await renameResponse.answered;

  await waitFor(() => {
    expect(elsewhere).toHaveFocus();
  });
  expect(
    screen.queryByRole("dialog", { name: "Manage GitHub accounts" }),
  ).not.toBeInTheDocument();

  click(getConnectorAction("button", "Manage GitHub accounts"));
  const reopened = await screen.findByRole("dialog", {
    name: "Manage GitHub accounts",
  });
  await expect(
    within(reopened).findByRole("group", { name: "Research" }),
  ).resolves.toBeInTheDocument();
  expect(
    within(reopened).queryByRole("textbox", { name: "Account name" }),
  ).not.toBeInTheDocument();
});

test("An old rename response cannot clear or steal focus from a newly opened edit", async () => {
  const server = mockGithubAccounts();
  await setupPage({ context, path: "/connectors?scope=connected" });
  const manager = await openGithubManager();
  const user = userEvent.setup();

  const first = await startRename(manager, "Work 1", "pointer");
  await fill(first, "Research");
  const oldResponse = server.holdNextRename();
  click(getConnectorAction("button", "Save", manager));
  await oldResponse.received;
  click(getConnectorAction("button", "Close", manager));
  await waitFor(() => {
    expect(manager).not.toBeInTheDocument();
  });

  const reopened = await openGithubManager();
  const input = await startRename(reopened, "Work 2", "pointer");
  await fill(input, "Work 2 new");

  oldResponse.release();
  await oldResponse.answered;

  await waitFor(() => {
    expect(input).toHaveFocus();
  });
  expect(input).toHaveValue("Work 2 new");
  await user.keyboard(" draft");
  expect(input).toHaveValue("Work 2 new draft");
  click(getConnectorAction("button", "Save", reopened));

  await waitFor(() => {
    expect(accountActions(reopened, "Work 2 new draft")).toHaveFocus();
  });
  expect(server.renames.at(-1)).toStrictEqual({
    connectionId: server.accounts[1]?.id,
    displayName: "Work 2 new draft",
  });
});
