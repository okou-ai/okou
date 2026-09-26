import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getConnectorAction,
  getConnectorCard,
  mockGithubAccounts,
} from "./connector-page-test-helpers.ts";

const context = testContext();
type User = ReturnType<typeof userEvent.setup>;

function mockRenameAccounts({
  accountCount = 3,
  renameResponse,
  refreshResponse,
  failFirstRefresh = false,
}: {
  readonly accountCount?: number;
  readonly renameResponse?: Promise<"success" | "error">;
  readonly refreshResponse?: Promise<void>;
  readonly failFirstRefresh?: boolean;
} = {}) {
  let accounts = mockGithubAccounts(context, accountCount);
  let renamed = false;
  let refreshFailed = false;
  let submittedRename: {
    readonly connectionId: string;
    readonly displayName: string | null;
  } | null = null;
  const renameStarted = context.mocks.deferred<void>();
  const renameReturned = context.mocks.deferred<void>();
  const refreshStarted = context.mocks.deferred<void>();
  context.mocks.api(
    connectorAccountsContract.connections,
    async ({ query, respond }) => {
      if (renamed) {
        if (!refreshStarted.settled()) {
          refreshStarted.resolve();
        }
        await refreshResponse;
        if (failFirstRefresh && !refreshFailed) {
          refreshFailed = true;
          return respond(400, {
            error: { code: "UNAVAILABLE", message: "Account list unavailable" },
          });
        }
      }
      const search = query.search?.toLowerCase();
      return respond(200, {
        connections: search
          ? accounts.filter((account) => {
              return account.displayName?.toLowerCase().includes(search);
            })
          : accounts,
        nextCursor: null,
      });
    },
  );
  context.mocks.api(
    connectorAccountsContract.rename,
    async ({ params, body, respond }) => {
      submittedRename = {
        connectionId: params.connectionId,
        displayName: body.displayName,
      };
      if (!renameStarted.settled()) {
        renameStarted.resolve();
      }
      const result = await renameResponse;
      if (result === "error") {
        if (!renameReturned.settled()) {
          renameReturned.resolve();
        }
        return respond(400, {
          error: { code: "UNAVAILABLE", message: "Account rename unavailable" },
        });
      }
      const account = accounts.find((candidate) => {
        return candidate.id === params.connectionId;
      });
      if (!account) {
        throw new Error("Expected an existing account to rename");
      }
      const updated = { ...account, displayName: body.displayName };
      accounts = accounts.map((candidate) => {
        return candidate.id === account.id ? updated : candidate;
      });
      renamed = true;
      if (!renameReturned.settled()) {
        renameReturned.resolve();
      }
      return respond(200, updated);
    },
  );
  return {
    renameStarted: renameStarted.promise,
    renameReturned: renameReturned.promise,
    refreshStarted: refreshStarted.promise,
    submittedRename: () => {
      return submittedRename;
    },
  };
}

async function openManager(user: User): Promise<HTMLElement> {
  const trigger = await waitFor(() => {
    return getConnectorAction(
      "button",
      "Manage GitHub accounts",
      getConnectorCard("GitHub"),
    );
  });
  await user.click(trigger);
  const manager = await screen.findByRole("dialog", {
    name: "Manage GitHub accounts",
  });
  await within(manager).findByRole("group", { name: "Work 1" });
  return manager;
}

function accountActions(manager: HTMLElement, accountName: string) {
  return getConnectorAction(
    "button",
    "Account actions",
    within(manager).getByRole("group", { name: accountName }),
  );
}

async function tabTo(user: User, target: HTMLElement): Promise<void> {
  for (
    let index = 0;
    index < 30 && document.activeElement !== target;
    index++
  ) {
    await user.tab();
  }
  expect(target).toHaveFocus();
}

async function activateRenameWithKeyboard(
  user: User,
  trigger: HTMLElement,
): Promise<void> {
  await tabTo(user, trigger);
  await user.keyboard("{Enter}");
  const menu = await screen.findByRole("menu");
  await waitFor(() => {
    expect(getConnectorAction("menuitem", "Reconnect", menu)).toHaveFocus();
  });
  await user.keyboard("{ArrowDown}");
  expect(getConnectorAction("menuitem", "Rename", menu)).toHaveFocus();
  await user.keyboard("{Enter}");
}

async function enterRename(
  user: User,
  manager: HTMLElement,
  activation: "keyboard" | "pointer",
  accountName = "Work 1",
): Promise<HTMLElement> {
  const trigger = accountActions(manager, accountName);
  if (activation === "keyboard") {
    await activateRenameWithKeyboard(user, trigger);
  } else {
    await user.click(trigger);
    const menu = await screen.findByRole("menu");
    await user.click(getConnectorAction("menuitem", "Rename", menu));
  }
  const input = await within(manager).findByLabelText("Account name");
  await waitFor(() => {
    expect(input).toHaveFocus();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
  return input;
}

test.each(["keyboard", "pointer"] as const)(
  "Type immediately after %s rename, navigate the form, and cancel back to the same account",
  async (activation) => {
    const fixture = mockRenameAccounts();
    const user = userEvent.setup({ delay: null });
    await setupPage({ context, path: "/connectors?keywords=github" });
    const manager = await openManager(user);
    const input = await enterRename(user, manager, activation);

    await user.keyboard("{End}x");
    expect(input).toHaveValue("Work 1x");
    expect(input).toHaveFocus();
    await user.tab();
    expect(getConnectorAction("button", "Cancel", manager)).toHaveFocus();
    await user.tab({ shift: true });
    expect(input).toHaveFocus();
    await user.tab({ shift: true });
    expect(manager.contains(document.activeElement)).toBeTruthy();
    await user.tab();
    expect(input).toHaveFocus();
    await user.tab();
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(accountActions(manager, "Work 1")).toHaveFocus();
    });
    expect(fixture.submittedRename()).toBeNull();
    await user.keyboard("{Enter}");
    await screen.findByRole("menu");
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(accountActions(manager, "Work 1")).toHaveFocus();
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
    expect(manager).toBeInTheDocument();
    await user.tab();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(manager).not.toBeInTheDocument();
      expect(
        getConnectorAction("button", "Manage GitHub accounts"),
      ).toHaveFocus();
    });
  },
);

test("An ordinary account menu dismissal preserves focus on account search", async () => {
  mockRenameAccounts({ accountCount: 7 });
  const user = userEvent.setup({ delay: null });
  await setupPage({ context, path: "/connectors?keywords=github" });
  const manager = await openManager(user);
  await tabTo(user, accountActions(manager, "Work 1"));
  await user.keyboard("{Enter}");
  await screen.findByRole("menu");
  const search = within(manager).getByPlaceholderText("Find accounts");

  await user.click(search);
  await waitFor(() => {
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(search).toHaveFocus();
  });
  await user.keyboard("Work 1");
  expect(search).toHaveValue("Work 1");
  await waitFor(() => {
    expect(
      within(manager).queryByRole("group", { name: "Work 2" }),
    ).not.toBeInTheDocument();
  });
  expect(
    within(manager).getByRole("group", { name: "Work 1" }),
  ).toBeInTheDocument();
});

test("Restore the renamed account actions only after the refreshed list arrives", async () => {
  const response = context.mocks.deferred<"success" | "error">();
  const refresh = context.mocks.deferred<void>();
  const fixture = mockRenameAccounts({
    renameResponse: response.promise,
    refreshResponse: refresh.promise,
  });
  const user = userEvent.setup({ delay: null });
  await setupPage({ context, path: "/connectors?keywords=github" });
  const manager = await openManager(user);
  const input = await enterRename(user, manager, "keyboard");
  await user.keyboard("{Control>}a{/Control}Research");
  expect(input).toHaveValue("Research");
  await user.tab();
  await user.tab();
  expect(getConnectorAction("button", "Save", manager)).toHaveFocus();
  await user.keyboard("{Enter}");
  await fixture.renameStarted;
  expect(getConnectorAction("button", "Save", manager)).toBeDisabled();

  response.resolve("success");
  await fixture.refreshStarted;
  expect(manager.contains(document.activeElement)).toBeTruthy();
  expect(
    within(manager).queryByRole("group", { name: "Research" }),
  ).not.toBeInTheDocument();
  refresh.resolve();

  await waitFor(() => {
    expect(accountActions(manager, "Research")).toHaveFocus();
  });
  expect(accountActions(manager, "Work 2")).not.toHaveFocus();
  await user.keyboard("{Enter}");
  await screen.findByRole("menu");
});

test("Keep a failed rename draft and its keyboard focus usable", async () => {
  const response = context.mocks.deferred<"success" | "error">();
  const fixture = mockRenameAccounts({ renameResponse: response.promise });
  const user = userEvent.setup({ delay: null });
  await setupPage({ context, path: "/connectors?keywords=github" });
  const manager = await openManager(user);
  const input = await enterRename(user, manager, "keyboard");
  await user.keyboard("{End} draft{Enter}");
  await fixture.renameStarted;
  expect(getConnectorAction("button", "Save", manager)).toBeDisabled();
  response.resolve("error");

  await screen.findByText("Account rename unavailable");
  await waitFor(() => {
    expect(getConnectorAction("button", "Save", manager)).toBeEnabled();
  });
  expect(input).toHaveValue("Work 1 draft");
  expect(input).toHaveFocus();
  await user.keyboard("{End} retry");
  expect(input).toHaveValue("Work 1 draft retry");
  await user.tab();
  expect(getConnectorAction("button", "Cancel", manager)).toHaveFocus();
  await user.keyboard("{Enter}");
  await waitFor(() => {
    expect(accountActions(manager, "Work 1")).toHaveFocus();
  });
});

test("Focus account search when the saved name no longer matches its results", async () => {
  const fixture = mockRenameAccounts({ accountCount: 7 });
  const user = userEvent.setup({ delay: null });
  await setupPage({ context, path: "/connectors?keywords=github" });
  const manager = await openManager(user);
  const search = within(manager).getByPlaceholderText("Find accounts");
  await user.click(search);
  await user.keyboard("Work 1");
  await waitFor(() => {
    expect(
      within(manager).getByRole("group", { name: "Work 1" }),
    ).toBeInTheDocument();
    expect(
      within(manager).queryByRole("group", { name: "Work 2" }),
    ).not.toBeInTheDocument();
  });
  const input = await enterRename(user, manager, "keyboard");
  await user.keyboard("{Control>}a{/Control}Research{Enter}");

  await within(manager).findByText("No accounts found");
  expect(fixture.submittedRename()).toMatchObject({ displayName: "Research" });
  await waitFor(() => {
    expect(search).toHaveFocus();
  });
  expect(input).not.toBeInTheDocument();
  await user.keyboard("{Control>}a{/Control}Research");
  expect(search).toHaveValue("Research");
  await waitFor(() => {
    expect(
      within(manager).queryByLabelText("Account name"),
    ).not.toBeInTheDocument();
    expect(
      within(manager)
        .queryAllByRole("group")
        .map((row) => {
          return row.getAttribute("aria-label");
        }),
    ).toContain("Research");
  });
  expect(search).toHaveFocus();
  await user.tab();
  expect(manager.contains(document.activeElement)).toBeTruthy();
  await user.tab({ shift: true });
  expect(search).toHaveFocus();
});

test("Keep the rename form usable when refreshing the saved accounts fails", async () => {
  mockRenameAccounts({ failFirstRefresh: true });
  const user = userEvent.setup({ delay: null });
  await setupPage({ context, path: "/connectors?keywords=github" });
  const manager = await openManager(user);
  const input = await enterRename(user, manager, "keyboard");
  await user.keyboard("{End} draft");
  await user.keyboard("{Enter}");

  await within(manager).findByText(
    "Accounts are unavailable for this connector.",
  );
  await waitFor(() => {
    expect(getConnectorAction("button", "Save", manager)).toBeEnabled();
    expect(input).toHaveFocus();
  });
  expect(input).toHaveValue("Work 1 draft");
  await user.keyboard("{End} retry");
  await user.keyboard("{Enter}");
  await waitFor(() => {
    expect(accountActions(manager, "Work 1 draft retry")).toHaveFocus();
  });
});

test("Keep focus outside a manager closed during a delayed rename", async () => {
  const response = context.mocks.deferred<"success" | "error">();
  const fixture = mockRenameAccounts({ renameResponse: response.promise });
  const user = userEvent.setup({ delay: null });
  await setupPage({ context, path: "/connectors?keywords=github" });
  const manager = await openManager(user);
  await enterRename(user, manager, "keyboard");
  await user.keyboard("{End} saved{Enter}");
  await fixture.renameStarted;
  await user.keyboard("{Escape}");
  const trigger = getConnectorAction("button", "Manage GitHub accounts");
  await waitFor(() => {
    expect(manager).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
  await user.tab();
  const outsideFocus = document.activeElement;
  expect(outsideFocus).not.toBe(document.body);

  await act(async () => {
    response.resolve("success");
    await fixture.renameReturned;
  });
  expect(outsideFocus).toHaveFocus();
  expect(
    screen.queryByRole("dialog", { name: "Manage GitHub accounts" }),
  ).not.toBeInTheDocument();
  await user.click(trigger);
  const reopened = await screen.findByRole("dialog", {
    name: "Manage GitHub accounts",
  });
  await within(reopened).findByRole("group", { name: "Work 1 saved" });
  expect(
    within(reopened).queryByLabelText("Account name"),
  ).not.toBeInTheDocument();
});

test("A search changed during save determines focus without a later stale handoff", async () => {
  const refresh = context.mocks.deferred<void>();
  const fixture = mockRenameAccounts({
    accountCount: 7,
    refreshResponse: refresh.promise,
  });
  const user = userEvent.setup({ delay: null });
  await setupPage({ context, path: "/connectors?keywords=github" });
  const manager = await openManager(user);
  await enterRename(user, manager, "keyboard");
  await user.keyboard("{Control>}a{/Control}Research");
  await user.keyboard("{Enter}");
  await fixture.refreshStarted;
  const search = within(manager).getByPlaceholderText("Find accounts");
  await user.click(search);
  await user.keyboard("No matching account");
  expect(search).toHaveValue("No matching account");

  refresh.resolve();
  await within(manager).findByText("No accounts found");
  expect(search).toHaveFocus();
  await user.keyboard("{Control>}a{/Control}Research");
  await within(manager).findByRole("group", { name: "Research" });
  expect(search).toHaveFocus();
  await user.keyboard("{End}x");
  expect(search).toHaveValue("Researchx");
});

test("An old rename response cannot clear or steal focus from a newly opened edit", async () => {
  const response = context.mocks.deferred<"success" | "error">();
  const fixture = mockRenameAccounts({ renameResponse: response.promise });
  const user = userEvent.setup({ delay: null });
  await setupPage({ context, path: "/connectors?keywords=github" });
  const manager = await openManager(user);
  await enterRename(user, manager, "keyboard");
  await user.keyboard("{End} saved{Enter}");
  await fixture.renameStarted;
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(manager).not.toBeInTheDocument();
  });
  const reopened = await openManager(user);
  const input = await enterRename(user, reopened, "keyboard", "Work 2");
  await user.keyboard("{End} new");

  await act(async () => {
    response.resolve("success");
    await fixture.renameReturned;
  });
  expect(input).toHaveFocus();
  expect(input).toHaveValue("Work 2 new");
  await user.keyboard("{End} draft");
  expect(input).toHaveValue("Work 2 new draft");
  expect(getConnectorAction("button", "Save", reopened)).toBeEnabled();
  await user.keyboard("{Enter}");
  await waitFor(() => {
    expect(fixture.submittedRename()).toMatchObject({
      displayName: "Work 2 new draft",
    });
    expect(
      within(reopened).queryByLabelText("Account name"),
    ).not.toBeInTheDocument();
    expect(
      within(reopened)
        .queryAllByRole("group")
        .map((row) => {
          return row.getAttribute("aria-label");
        }),
    ).toContain("Work 2 new draft");
  });
  expect(accountActions(reopened, "Work 2 new draft")).toHaveFocus();
  expect(
    within(reopened).queryByLabelText("Account name"),
  ).not.toBeInTheDocument();
});
