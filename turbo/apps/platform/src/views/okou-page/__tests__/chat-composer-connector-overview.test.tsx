import { chatConnectorAccessContract } from "@okouai/api-contracts/contracts/chat-connector-access";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  SCOUT_THREAD_ID,
  builtinConnector,
  chatConnectorOverviewFixture,
  connectorAccount,
  createComposerConnectorHelpers,
} from "./chat-composer-connectors-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";

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
      requested.resolve(params.connectionId);
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
