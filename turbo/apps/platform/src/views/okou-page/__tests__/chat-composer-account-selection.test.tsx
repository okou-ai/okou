import { chatThreadConnectorSelectionContract } from "@okouai/api-contracts/contracts/chat-threads";
import {
  connectorAccountsContract,
  type ConnectorAccountConnection,
  type ConnectorAccountSelection,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
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
  queryFastControl,
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

test("Browsing account options does not save until Enter activates one option", async () => {
  const user = userEvent.setup({ delay: null });
  const connections = accounts();
  const fixture = installAccounts(connections);
  const chooser = await setupChooser(user);
  const list = await within(chooser).findByRole("listbox", { name: "GitHub" });
  const personal = await within(chooser).findByRole("option", {
    name: /^Personal/u,
  });
  const defaultOption = within(chooser).getByRole("option", {
    name: /^Use default/u,
  });

  await user.click(list);
  await user.keyboard("{Home}");
  expect(list).toHaveAttribute("aria-activedescendant", defaultOption.id);
  await user.keyboard("{End}");
  expect(list).toHaveAttribute("aria-activedescendant", personal.id);
  await user.keyboard("{ArrowUp}");
  expect(list).toHaveAttribute(
    "aria-activedescendant",
    within(chooser).getByRole("option", { name: /^Work/u }).id,
  );
  await user.keyboard("{ArrowDown}");
  expect(list).toHaveAttribute("aria-activedescendant", personal.id);
  expect(defaultOption).toHaveAttribute("aria-selected", "true");
  expect(personal).toHaveAttribute("aria-selected", "false");
  expect(fixture.threadSelectionUpdates).toStrictEqual([]);
  expect(fixture.clearedThreadSelections).toStrictEqual([]);

  await user.keyboard("{Enter}");
  await expectClosedWithFocus("GitHub · Selected account: Personal");
  expect(fixture.threadSelectionUpdates).toStrictEqual([
    {
      threadId: SCOUT_THREAD_ID,
      selection: { target: target(), connectionId: connections[1]!.id },
    },
  ]);
  expect(queryFastControl("button", "Add connectors")).toBeInTheDocument();
});

test("Account search keeps text editing and IME Enter separate from selection", async () => {
  const user = userEvent.setup({ delay: null });
  const connections = accounts([
    "Work",
    "Personal Team",
    "Client",
    "Research",
    "Open Source",
    "Team A",
    "Team B",
  ]);
  const fixture = installAccounts(connections);
  const chooser = await setupChooser(user);
  const input = await within(chooser).findByRole("textbox", {
    name: "Find accounts",
  });
  await user.type(input, "Personal Team");
  const personal = await waitFor(() => {
    const option = within(chooser).getByRole("option", {
      name: /^Personal Team/u,
    });
    expect(
      within(chooser).queryByRole("option", { name: /^Client/u }),
    ).toBeNull();
    return option;
  });
  expect(input).toHaveValue("Personal Team");
  await user.keyboard("{Home}");
  expect(input).toHaveProperty("selectionStart", 0);
  expect(input).not.toHaveAttribute("aria-activedescendant");
  await user.keyboard("{End}");
  expect(input).toHaveProperty("selectionStart", "Personal Team".length);
  expect(input).not.toHaveAttribute("aria-activedescendant");
  await user.keyboard("{ArrowLeft}");
  expect(input).toHaveProperty("selectionStart", "Personal Team".length - 1);

  fireEvent.compositionStart(input);
  fireEvent.keyDown(input, {
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    which: 13,
    isComposing: true,
  });
  fireEvent.compositionEnd(input);
  expect(input).toHaveValue("Personal Team");
  expect(personal).toHaveAttribute("aria-selected", "false");
  expect(fixture.threadSelectionUpdates).toStrictEqual([]);
  expect(fixture.clearedThreadSelections).toStrictEqual([]);

  await user.keyboard("{Tab}");
  const list = within(chooser).getByRole("listbox", { name: "GitHub" });
  expect(list).toHaveFocus();
  await user.keyboard("{Home}");
  expect(list).toHaveAttribute(
    "aria-activedescendant",
    within(chooser).getByRole("option", { name: /^Use default/u }).id,
  );
  await user.keyboard("{ArrowDown}");
  expect(list).toHaveAttribute("aria-activedescendant", personal.id);
  expect(fixture.threadSelectionUpdates).toStrictEqual([]);

  await user.keyboard("{Enter}");
  await expectClosedWithFocus("GitHub · Selected account: Personal Team");
  expect(fixture.threadSelectionUpdates).toStrictEqual([
    {
      threadId: SCOUT_THREAD_ID,
      selection: { target: target(), connectionId: connections[1]!.id },
    },
  ]);
});

test("Failed account saves keep the old selection and allow a single retry", async () => {
  const user = userEvent.setup({ delay: null });
  const connections = accounts();
  installAccounts(connections);
  const firstSaveStarted = context.mocks.deferred<void>();
  const firstSaveResponse = context.mocks.deferred<void>();
  const writes: ConnectorAccountSelection[] = [];
  let saved: ConnectorAccountSelection | undefined;
  context.mocks.api(chatThreadConnectorSelectionContract.get, ({ respond }) => {
    return respond(200, {
      selections: saved ? [saved] : [],
      selectedConnections: connections.filter((connection) => {
        return connection.id === saved?.connectionId;
      }),
    });
  });
  context.mocks.api(
    chatThreadConnectorSelectionContract.update,
    async ({ body, respond }) => {
      writes.push(body);
      if (writes.length === 1) {
        firstSaveStarted.resolve();
        await firstSaveResponse.promise;
        return respond(403, {
          error: { code: "FORBIDDEN", message: "Account save was rejected" },
        });
      }
      saved = body;
      return respond(200, body);
    },
  );
  const chooser = await setupChooser(user);
  const list = await within(chooser).findByRole("listbox", { name: "GitHub" });
  const personal = await within(chooser).findByRole("option", {
    name: /^Personal/u,
  });
  const defaultOption = within(chooser).getByRole("option", {
    name: /^Use default/u,
  });

  await user.click(personal);
  await firstSaveStarted.promise;
  expect(list).toHaveAttribute("aria-busy", "true");
  expect(personal).toHaveAttribute("aria-disabled", "true");
  expect(personal).toHaveAttribute("aria-selected", "false");
  expect(defaultOption).toHaveAttribute("aria-selected", "true");
  await user.click(personal);
  await user.click(within(chooser).getByRole("option", { name: /^Work/u }));
  await user.click(list);
  await user.keyboard("{End}{Enter}");
  expect(writes).toStrictEqual([
    { target: target(), connectionId: connections[1]!.id },
  ]);

  firstSaveResponse.resolve();
  await waitFor(() => {
    expect(list).toHaveAttribute("aria-busy", "false");
    expect(personal).not.toHaveAttribute("aria-disabled", "true");
  });
  expect(defaultOption).toHaveAttribute("aria-selected", "true");
  expect(personal).toHaveAttribute("aria-selected", "false");
  await user.click(personal);
  await expectClosedWithFocus("GitHub · Selected account: Personal");
  expect(writes).toStrictEqual([
    { target: target(), connectionId: connections[1]!.id },
    { target: target(), connectionId: connections[1]!.id },
  ]);
});

test("Use default waits for the override to be cleared before closing", async () => {
  const user = userEvent.setup({ delay: null });
  const connections = accounts();
  const fixture = installAccounts(connections, connections[1]);
  const clearStarted = context.mocks.deferred<void>();
  const clearResponse = context.mocks.deferred<void>();
  const clears: { threadId: string; target: ConnectorAccountTarget }[] = [];
  let saved: ConnectorAccountSelection | undefined = {
    target: target(),
    connectionId: connections[1]!.id,
  };
  context.mocks.api(chatThreadConnectorSelectionContract.get, ({ respond }) => {
    return respond(200, {
      selections: saved ? [saved] : [],
      selectedConnections: saved ? [connections[1]!] : [],
    });
  });
  context.mocks.api(
    chatThreadConnectorSelectionContract.clear,
    async ({ body, params, respond }) => {
      clears.push({ threadId: params.id, target: body });
      clearStarted.resolve();
      await clearResponse.promise;
      saved = undefined;
      return respond(204);
    },
  );
  const chooser = await setupChooser(
    user,
    "GitHub · Selected account: Personal",
  );
  const defaultOption = within(chooser).getByRole("option", {
    name: /^Use default/u,
  });
  await user.click(defaultOption);
  await clearStarted.promise;
  expect(defaultOption).toHaveAttribute("aria-selected", "false");
  expect(
    within(chooser).getByRole("option", { name: /^Personal/u }),
  ).toHaveAttribute("aria-selected", "true");
  expect(within(chooser).getByRole("listbox")).toHaveAttribute(
    "aria-busy",
    "true",
  );
  await user.click(defaultOption);

  clearResponse.resolve();
  await expectClosedWithFocus(DEFAULT_ACCOUNT_LABEL);
  expect(clears).toStrictEqual([
    { threadId: SCOUT_THREAD_ID, target: target() },
  ]);
  expect(fixture.threadSelectionUpdates).toStrictEqual([]);
});

test.each(["Escape", "Back", "outside"] as const)(
  "%s cancels a pending account save without closing the next chooser session",
  async (dismissal) => {
    const user = userEvent.setup({ delay: null });
    const connections = accounts();
    installAccounts(connections);
    const saveStarted = context.mocks.deferred<void>();
    const saveAborted = context.mocks.deferred<void>();
    const staleResponse = context.mocks.deferred<void>();
    const staleResponseReturned = context.mocks.deferred<void>();
    const writes: ConnectorAccountSelection[] = [];
    let saved: ConnectorAccountSelection | undefined;
    context.mocks.api(
      chatThreadConnectorSelectionContract.get,
      ({ respond }) => {
        return respond(200, {
          selections: saved ? [saved] : [],
          selectedConnections: connections.filter((connection) => {
            return connection.id === saved?.connectionId;
          }),
        });
      },
    );
    context.mocks.api(
      chatThreadConnectorSelectionContract.update,
      async ({ body, request, respond }) => {
        writes.push(body);
        if (writes.length === 1) {
          request.signal.addEventListener(
            "abort",
            () => {
              saveAborted.resolve();
            },
            { once: true },
          );
          saveStarted.resolve();
          await staleResponse.promise;
          staleResponseReturned.resolve();
          return respond(200, body);
        }
        saved = body;
        return respond(200, body);
      },
    );
    const chooser = await setupChooser(user);
    await user.click(
      await within(chooser).findByRole("option", { name: /^Personal/u }),
    );
    await saveStarted.promise;
    expect(within(chooser).getByRole("listbox")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    if (dismissal === "Escape") {
      await user.keyboard("{Escape}");
    } else if (dismissal === "Back") {
      await user.click(await findFastControl("button", "Back", chooser));
    } else {
      await user.click(await findComposer());
    }
    await waitFor(() => {
      expect(screen.queryByLabelText("Account for this chat")).toBeNull();
    });
    await saveAborted.promise;
    expect(queryFastControl("button", "Add connectors")).toBeInTheDocument();
    const reopened = await openChooser(user);
    const work = await within(reopened).findByRole("option", {
      name: /^Work/u,
    });
    expect(work).not.toHaveAttribute("aria-disabled", "true");
    expect(within(reopened).getByRole("listbox")).toHaveAttribute(
      "aria-busy",
      "false",
    );

    staleResponse.resolve();
    await staleResponseReturned.promise;
    expect(reopened).toBeInTheDocument();
    await user.click(work);
    await expectClosedWithFocus("GitHub · Selected account: Work");
    expect(writes).toStrictEqual([
      { target: target(), connectionId: connections[1]!.id },
      { target: target(), connectionId: connections[0]!.id },
    ]);
  },
);

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

test.each([true, false])(
  "Unavailable selected accounts retain their identity and fallback when account service availability is %s",
  async (available) => {
    const user = userEvent.setup({ delay: null });
    const connections = accounts(["Work", "Personal", "Client"]).map(
      (connection) => {
        return connection.isDefault
          ? connection
          : { ...connection, connectionStatus: "reconnect-required" as const };
      },
    );
    const fixture = installAccounts(connections, connections[1]);
    if (!available) {
      context.mocks.api(
        connectorAccountsContract.connections,
        ({ respond }) => {
          return respond(404, {
            error: {
              code: "NOT_FOUND",
              message: "Account listing is unavailable",
            },
          });
        },
      );
    }
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
    if (available) {
      await within(chooser).findByRole("option", {
        name: /^Client.*Reconnect required/u,
      });
    } else {
      await within(chooser).findByText(
        "Accounts are unavailable for this connector.",
      );
    }
    expect(fixture.threadSelectionUpdates).toStrictEqual([]);
    expect(fixture.clearedThreadSelections).toStrictEqual([]);
  },
);
