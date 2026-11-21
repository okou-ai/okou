import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { connectorAccountFixture } from "../../../mocks/handlers/connector-account-fixtures.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findButton, queryButton } from "./chat-run-test-fixtures.ts";
import { mockSavedConnectorAccounts } from "./connector-page-test-helpers.ts";

const context = testContext();
const managerName = "Manage GitHub accounts";
const accountName = "Account name";

async function openAccountList() {
  click(await findButton(managerName));
  return screen.findByRole("dialog", { name: managerName });
}

async function accountActions(label: string) {
  const row = await screen.findByRole("group", { name: label });
  const button = queryButton("Account actions", row);
  if (!button) {
    throw new Error("Missing account actions for " + label);
  }
  return button;
}

function accounts() {
  return ["Work 1", "Work 2"].map((displayName, index) => {
    return connectorAccountFixture(
      { kind: "builtin", connectorSlug: "github" },
      { displayName, isDefault: index === 0 },
    );
  });
}

async function chooseRenameWithKeys(actions: HTMLElement) {
  const dialog = screen.getByRole("dialog", { name: managerName });
  for (
    let i = 0;
    i < dialog.querySelectorAll("button,input").length + 2 &&
    document.activeElement !== actions;
    i++
  ) {
    await userEvent.tab();
  }
  expect(actions).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  const rename = await screen.findByText("Rename", {
    selector: '[role="menuitem"]',
  });
  await userEvent.keyboard("{Home}{ArrowDown}");
  expect(rename).toHaveFocus();
  await userEvent.keyboard("{Enter}");
}

async function beginEdit(label: string, input: "pointer" | "keyboard") {
  const actions = await accountActions(label);
  if (input === "keyboard") {
    await chooseRenameWithKeys(actions);
  } else {
    await userEvent.click(actions);
    await userEvent.click(
      await screen.findByText("Rename", { selector: '[role="menuitem"]' }),
    );
  }
  return screen.findByRole("textbox", { name: accountName });
}

test.each([
  ["001", "keyboard"],
  ["002", "pointer"],
] as const)(
  "connectors-account-rename-focus-%s tab navigation after %s rename",
  async (_id, input) => {
    const saved = accounts();
    mockSavedConnectorAccounts(context, () => {
      return saved;
    });
    await setupPage({ context, path: "/connectors" });
    const manager = await openAccountList();
    const field = await beginEdit("Work 1", input);
    await fill(field, "Work 1x");
    expect(field).toHaveValue("Work 1x");
    await userEvent.tab();
    expect(queryButton("Cancel", manager)).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(field).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(manager).toContainElement(document.activeElement as HTMLElement);
    expect(field).not.toHaveFocus();
    await userEvent.tab();
    expect(field).toHaveFocus();
  },
);

test("connectors-account-rename-focus-009 the refreshed Research row takes focus when it arrives", async () => {
  const saved = accounts();
  const patch = context.mocks.deferred<void>();
  const requestedList = context.mocks.deferred<void>();
  const refresh = context.mocks.deferred<void>();
  let changed = false;
  mockSavedConnectorAccounts(context, async () => {
    if (changed) {
      if (!requestedList.settled()) {
        requestedList.resolve();
      }
      await refresh.promise;
    }
    return saved;
  });
  context.mocks.api(
    connectorAccountsContract.rename,
    async ({ params, body, respond }) => {
      await patch.promise;
      const row = saved.find((item) => {
        return item.id === params.connectionId;
      })!;
      row.displayName = body.displayName;
      changed = true;
      return respond(200, row);
    },
  );
  await setupPage({ context, path: "/connectors" });
  const manager = await openAccountList();
  const field = await beginEdit("Work 1", "pointer");
  await fill(field, "Research");
  await userEvent.keyboard("{Enter}");
  patch.resolve();
  await requestedList.promise;
  expect(field).toHaveFocus();
  expect(queryButton("Save", manager)).toBeDisabled();
  expect(
    within(manager).queryByRole("group", { name: "Research" }),
  ).not.toBeInTheDocument();
  refresh.resolve();
  const actions = await accountActions("Research");
  await waitFor(() => {
    return expect(actions).toHaveFocus();
  });
  await userEvent.keyboard("{Enter}");
  await expect(screen.findByRole("menu")).resolves.toBeInTheDocument();
});
