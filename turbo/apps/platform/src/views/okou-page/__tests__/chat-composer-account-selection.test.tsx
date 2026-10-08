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
import {
  accountSummary,
  builtinConnector,
  connectorAccount,
  installComposerConnectorFixture,
  SCOUT_AGENT_ID,
  SCOUT_THREAD_ID,
} from "./chat-composer-connectors-test-helpers.ts";
import {
  context,
  findComposer,
  findFastControl,
} from "./chat-message-experience-test-helpers.ts";

const GITHUB_SLUG = "github" as ConnectorSlug;
const DEFAULT_ACCOUNT_LABEL = "GitHub · Using default account: Work";

function target(): ConnectorAccountTarget {
  return { kind: "builtin", connectorSlug: GITHUB_SLUG };
}

function accounts(names: readonly string[] = ["Work", "Personal"]) {
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
) {
  return installComposerConnectorFixture({
    catalog: [builtinConnector({ slug: GITHUB_SLUG, label: "GitHub" })],
    builtinAuthorizations: { [SCOUT_AGENT_ID]: [GITHUB_SLUG] },
    accountSummaries: [accountSummary(target(), connections)],
    accounts: connections,
    threadSelections: selectedConnection
      ? {
          [SCOUT_THREAD_ID]: [
            { target: target(), connectionId: selectedConnection.id },
          ],
        }
      : {},
    threadId: SCOUT_THREAD_ID,
  });
}

async function openConnectors(): Promise<void> {
  click(await findFastControl("button", "Connectors"));
  await findFastControl("button", "Add connectors");
}

async function openChooser(
  user: ReturnType<typeof userEvent.setup>,
  accessibleName = DEFAULT_ACCOUNT_LABEL,
): Promise<HTMLElement> {
  await user.click(await findFastControl("button", accessibleName));
  return await screen.findByLabelText("Account for this chat");
}

async function setupChooser(
  user: ReturnType<typeof userEvent.setup>,
  accessibleName = DEFAULT_ACCOUNT_LABEL,
): Promise<HTMLElement> {
  await setupPage({
    locale: "en-US",
    context,
    path: `/chats/${SCOUT_THREAD_ID}`,
  });
  await findComposer();
  await openConnectors();
  return await openChooser(user, accessibleName);
}

async function expectClosedWithFocus(accessibleName: string): Promise<void> {
  const trigger = await findFastControl("button", accessibleName);
  await waitFor(() => {
    expect(screen.queryByLabelText("Account for this chat")).toBeNull();
    expect(trigger).toHaveFocus();
  });
}

test("Paged and remote search results keep the selected account once", async () => {
  const user = userEvent.setup({ delay: null });
  const connections = accounts([
    "Work",
    "Personal",
    "Client",
    "Research",
    "Open Source",
    "Team A",
    "Team B",
  ]);
  const fixture = installAccounts(connections, connections[1]);
  context.mocks.api(
    connectorAccountsContract.connections,
    ({ query, respond }) => {
      if (query.search === "remote") {
        return respond(200, {
          connections: [connections[3]!],
          nextCursor: null,
        });
      }
      return query.cursor
        ? respond(200, {
            connections: [connections[1]!, connections[2]!],
            nextCursor: null,
          })
        : respond(200, {
            connections: [connections[0]!, connections[1]!],
            nextCursor: "next-accounts",
          });
    },
  );
  const chooser = await setupChooser(
    user,
    "GitHub · Selected account: Personal",
  );
  await within(chooser).findByRole("option", { name: /^Personal/u });
  click(await findFastControl("button", "Load more", chooser));
  await within(chooser).findByRole("option", { name: /^Client/u });
  expect(
    within(chooser).getAllByRole("option", { name: /^Personal/u }),
  ).toHaveLength(1);
  expect(
    within(chooser).getByRole("option", { name: /^Personal/u }),
  ).toHaveAttribute("aria-selected", "true");
  const input = within(chooser).getByRole("textbox", {
    name: "Find accounts",
  });
  await user.type(input, "remote");
  await within(chooser).findByRole("option", { name: /^Research/u });
  expect(
    within(chooser).getAllByRole("option", { name: /^Personal/u }),
  ).toHaveLength(1);
  expect(
    within(chooser).getByRole("option", { name: /^Personal/u }),
  ).toHaveAttribute("aria-selected", "true");
  expect(
    within(chooser).queryByRole("option", { name: /^Client/u }),
  ).toBeNull();
  expect(fixture.threadSelectionUpdates).toStrictEqual([]);
  await user.click(within(chooser).getByRole("option", { name: /^Research/u }));
  await expectClosedWithFocus("GitHub · Selected account: Research");
  expect(fixture.threadSelectionUpdates).toStrictEqual([
    {
      threadId: SCOUT_THREAD_ID,
      selection: { target: target(), connectionId: connections[3]!.id },
    },
  ]);
});

test("Unavailable selected accounts retain their identity and fallback", async () => {
  const user = userEvent.setup({ delay: null });
  const connections = accounts(["Work", "Personal", "Client"]).map(
    (connection) => {
      return connection.isDefault
        ? connection
        : { ...connection, connectionStatus: "reconnect-required" as const };
    },
  );
  const fixture = installAccounts(connections, connections[1]);
  const chooser = await setupChooser(
    user,
    "GitHub · Selected account: Personal",
  );
  const personal = await within(chooser).findByRole("option", {
    name: /^Personal.*Falls back to Work/u,
  });
  expect(personal).toHaveAttribute("aria-selected", "true");
  expect(
    within(chooser).getByRole("option", { name: /^Use default.*Work/u }),
  ).toHaveAttribute("aria-selected", "false");
  await within(chooser).findByRole("option", {
    name: /^Client.*Reconnect required/u,
  });
  expect(fixture.threadSelectionUpdates).toStrictEqual([]);
  expect(fixture.clearedThreadSelections).toStrictEqual([]);
});
