import { chatConnectorAccessContract } from "@okouai/api-contracts/contracts/chat-connector-access";
import {
  connectorAccountsContract,
  type ConnectorAccountConnection,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  builtinConnector,
  chatConnectorOverviewFixture,
  connectorAccount,
  SCOUT_THREAD_ID,
  createComposerConnectorHelpers,
} from "./chat-composer-connectors-test-helpers.ts";
import {
  findComposer,
  findFastControl,
} from "./chat-message-experience-test-helpers.ts";

const context = testContext();
const { installComposerConnectorFixture } =
  createComposerConnectorHelpers(context);

const GITHUB_SLUG = "github" as ConnectorSlug;

function target(): ConnectorAccountTarget {
  return { kind: "builtin", connectorSlug: GITHUB_SLUG };
}

function accounts(names: readonly string[]) {
  return names.map((displayName, index) => {
    return connectorAccount({
      id: `f0000000-0000-4000-a000-${(index + 191)
        .toString()
        .padStart(12, "0")}`,
      target: target(),
      displayName,
      isDefault: index === 0,
    });
  });
}

function installAccounts(
  connections: readonly ConnectorAccountConnection[],
  selectedConnection?: ConnectorAccountConnection,
): void {
  installComposerConnectorFixture({
    catalog: [builtinConnector({ slug: GITHUB_SLUG, label: "GitHub" })],
    accounts: connections,
    threadId: SCOUT_THREAD_ID,
  });
  if (selectedConnection) {
    context.mocks.api(chatConnectorAccessContract.overview, ({ respond }) => {
      return respond(200, [
        {
          ...chatConnectorOverviewFixture({
            target: target(),
            label: "GitHub",
            accounts: connections,
          }),
          currentConnectionId: selectedConnection.id,
        },
      ]);
    });
  }
}

async function openChooser(
  user: ReturnType<typeof userEvent.setup>,
): Promise<HTMLElement> {
  await user.click(await findFastControl("button", /^GitHub/u));
  return await screen.findByRole("group", { name: "GitHub" });
}

async function setupChooser(
  user: ReturnType<typeof userEvent.setup>,
): Promise<HTMLElement> {
  await setupPage({
    locale: "en-US",
    context,
    path: `/chats/${SCOUT_THREAD_ID}`,
  });
  await findComposer();
  click(await findFastControl("button", "Connectors"));
  await findFastControl("button", "Add connectors");
  return await openChooser(user);
}

test("Accounts retain their identity when reconnection is required", async () => {
  const user = userEvent.setup({ delay: null });
  const connections = accounts(["Work", "Personal", "Client"]).map(
    (connection) => {
      return connection.isDefault
        ? connection
        : { ...connection, connectionStatus: "reconnect-required" as const };
    },
  );
  installAccounts(connections, connections[1]);
  const chooser = await setupChooser(user);

  const rows = new Map<string, HTMLElement>();
  for (const name of ["Work", "Personal", "Client"]) {
    const access = await within(chooser).findByRole("switch", {
      name: `${name} access`,
    });
    expect(access).toBeChecked();
    const row = access.parentElement;
    if (!row) {
      throw new Error(`Missing ${name} account row`);
    }
    rows.set(name, row);
  }
  expect(rows.get("Personal")).toHaveTextContent("Reconnect required");
  expect(rows.get("Client")).toHaveTextContent("Reconnect required");
  expect(rows.get("Work")).not.toHaveTextContent("Reconnect required");
});

test("Open a single-account chooser and read fresh target accounts on reopen", async () => {
  const user = userEvent.setup({ delay: null });
  const connections = accounts(["Work"]);
  installAccounts(connections);
  let displayName = "Work";
  context.mocks.api(connectorAccountsContract.connections, ({ respond }) => {
    const account = { ...connections[0]!, displayName };
    return respond(200, {
      connections: [account],
      defaultConnection: account,
      nextCursor: null,
    });
  });
  const chooser = await setupChooser(user);
  await expect(
    within(chooser).findByRole("switch", { name: "Work access" }),
  ).resolves.toBeInTheDocument();

  await user.keyboard("{Escape}");
  const trigger = await findFastControl("button", /^GitHub/u);
  await waitFor(() => {
    expect(screen.queryByRole("group", { name: "GitHub" })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  displayName = "Renamed account";
  const reopened = await openChooser(user);
  await expect(
    within(reopened).findByRole("switch", { name: "Renamed account access" }),
  ).resolves.toBeVisible();
  expect(
    within(reopened).queryByRole("switch", { name: "Work access" }),
  ).not.toBeInTheDocument();
});
