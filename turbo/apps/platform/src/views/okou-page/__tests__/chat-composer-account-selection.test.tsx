import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  SCOUT_THREAD_ID,
  builtinConnector,
  connectorAccount,
  createComposerConnectorHelpers,
} from "./chat-composer-connectors-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";

const context = testContext();

const github = { kind: "builtin", connectorSlug: "github" } as const;
function githubAccounts(size = 3) {
  const accounts = ["Work", "Personal", "Client"]
    .slice(0, size)
    .map((name, i) => {
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
async function openGitHub(path: string) {
  await setupPage({ context, path });
  click(await findFastControl("button", "Connectors"));
  const trigger = await findFastControl("button", /GitHub/i);
  click(trigger);
  await screen.findByRole("group", { name: "GitHub" });
  return trigger;
}
test("chat-composer-account-selection-004 reopening the account choices shows the renamed Work account", async () => {
  const accounts = githubAccounts(1);
  context.mocks.api(connectorAccountsContract.connections, ({ respond }) => {
    return respond(200, {
      connections: accounts,
      defaultConnection: accounts[0]!,
      nextCursor: null,
    });
  });
  const trigger = await openGitHub("/chats/" + SCOUT_THREAD_ID);
  await within(screen.getByRole("group", { name: "GitHub" })).findByText(
    "Work",
  );
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    return expect(trigger).toHaveFocus();
  });
  accounts[0]!.displayName = "Renamed account";
  click(trigger);
  const ui = within(await screen.findByRole("group", { name: "GitHub" }));
  await ui.findByText("Renamed account");
  expect(ui.queryByText("Work")).toBeNull();
});
