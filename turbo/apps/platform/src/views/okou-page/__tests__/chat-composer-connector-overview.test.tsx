import { chatConnectorAccessContract } from "@okouai/api-contracts/contracts/chat-connector-access";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import userEvent from "@testing-library/user-event";
import {
  namedMenuAccounts,
  openChatMenu,
} from "./composer-menu-page-fixture.ts";
import { screen, within, waitFor } from "@testing-library/react";
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
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";

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

test("The same twenty connector choices remain available after closing the panel", async () => {
  const entries = namedMenuAccounts(context, "Connected tool", 20);
  context.mocks.api(chatConnectorAccessContract.overview, ({ respond }) => {
    return respond(200, entries);
  });
  const launcher = await openChatMenu(context);
  async function allChoices() {
    const menu = await screen.findByRole("dialog", { name: "Connectors" });
    await findFastControl("button", /Connected tool 19\b/, menu);
    for (const entry of entries) {
      expect(
        within(menu).getByText(entry.label, { exact: true }),
      ).toBeVisible();
    }
  }
  await allChoices();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(launcher).toHaveFocus();
  });
  click(launcher);
  await allChoices();
});

function twoProbeConnectors() {
  const targets = [
    github,
    { kind: "builtin", connectorSlug: "slack" },
  ] as const;
  const accounts = targets.map((target, index) => {
    return connectorAccount({
      id: crypto.randomUUID(),
      target,
      displayName: "Office " + (index + 1),
      isDefault: true,
    });
  });
  createComposerConnectorHelpers(context).installComposerConnectorFixture({
    threadId: SCOUT_THREAD_ID,
    accounts,
    catalog: targets.map((target, i) => {
      return builtinConnector({
        slug: target.connectorSlug,
        label: "Probe " + (i + 1),
      });
    }),
  });
  function entry(index: 0 | 1) {
    return chatConnectorOverviewFixture({
      target: targets[index],
      label: "Probe " + (index + 1),
      accounts,
    });
  }
  return [entry(0), entry(1)] as const;
}

test("chat-composer-connector-overview-003 a targeted account update, removal and continuity gap restore the current directory", async () => {
  const [first, second] = twoProbeConnectors();
  const off = {
    ...first,
    accounts: first.accounts.map((account) => {
      return {
        ...account,
        enabled: false,
        overrideEnabled: false,
      };
    }),
    currentConnectionId: null,
  };
  const recovered = { ...second, label: "Probe 2 after reconnect" };
  const updates: string[] = [];
  let remove = false;
  let afterGap = false;
  context.mocks.api(chatConnectorAccessContract.overview, ({ respond }) => {
    return respond(200, afterGap ? [recovered] : [first, second]);
  });
  context.mocks.api(
    chatConnectorAccessContract.overviewTarget,
    ({ query, respond }) => {
      if (query.kind !== "builtin") {
        return respond(200, { connector: null });
      }
      updates.push(query.connectorSlug);
      return respond(200, {
        connector:
          query.connectorSlug === "github" ? (remove ? null : off) : second,
      });
    },
  );
  const trigger = await openChatMenu(context);
  await findFastControl("button", /^Probe 1\b/);
  await findFastControl("button", /^Probe 2\b/);
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(trigger).toHaveFocus();
  });
  context.mocks.ably.trigger("connector:changed", { connectorSlug: "github" });
  await waitFor(() => {
    expect(updates).toContain("github");
  });
  click(trigger);
  click(await findFastControl("button", /^Probe 1\b/));
  const account = await screen.findByRole("switch", {
    name: "Office 1 access",
  });
  await waitFor(() => {
    expect(account).not.toBeChecked();
  });
  expect(new Set(updates)).toStrictEqual(new Set(["github"]));
  await userEvent.keyboard("{Escape}");
  remove = true;
  context.mocks.ably.trigger("connector:changed", { connectorSlug: "github" });
  await waitFor(() => {
    expect(queryFastControl("button", /^Probe 1\b/)).toBeNull();
    expect(queryFastControl("button", /^Probe 2\b/)).toBeVisible();
  });
  afterGap = true;
  context.mocks.ably.triggerSharedWorkerChannelGap("user:test-user-123");
  await findFastControl("button", "Probe 2 after reconnect");
  expect(queryFastControl("button", /^Probe 1\b/)).toBeNull();
});

test("A failed account refresh can be retried while the other connector continues receiving updates", async () => {
  const [githubRow, slackRow] = twoProbeConnectors();
  let recovered = false;
  let changed = false;
  let disabled = false;
  const slack = () => {
    return {
      ...slackRow,
      label: changed ? "Probe 2 updated" : "Probe 2",
    };
  };
  context.mocks.api(chatConnectorAccessContract.overview, ({ respond }) => {
    return respond(200, [githubRow, slack()]);
  });
  context.mocks.api(
    chatConnectorAccessContract.overviewTarget,
    ({ query, respond }) => {
      if (query.kind === "builtin" && query.connectorSlug === "slack") {
        return respond(200, { connector: slack() });
      }
      if (!recovered) {
        return respond(503, {
          error: {
            code: "UNAVAILABLE",
            message: "Probe 1 refresh unavailable",
          },
        });
      }
      return respond(200, {
        connector: {
          ...githubRow,
          accounts: githubRow.accounts.map((a) => {
            return {
              ...a,
              enabled: !disabled,
              overrideEnabled: !disabled,
            };
          }),
          currentConnectionId: disabled ? null : githubRow.currentConnectionId,
        },
      });
    },
  );
  await openChatMenu(context);
  await findFastControl("button", /^Probe 1/);
  context.mocks.ably.trigger("connector:changed", { connectorSlug: "github" });
  const retry = await findFastControl("button", "Try again");
  await expect(findFastControl("button", /^Probe 1/)).resolves.toBeVisible();
  changed = true;
  context.mocks.ably.trigger("connector:changed", { connectorSlug: "slack" });
  await findFastControl("button", "Probe 2 updated");
  recovered = true;
  click(retry);
  await waitFor(() => {
    expect(retry).not.toBeInTheDocument();
  });
  disabled = true;
  context.mocks.ably.trigger("connector:changed", { connectorSlug: "github" });
  click(await findFastControl("button", /^Probe 1/));
  const toggle = await screen.findByRole("switch", { name: "Office 1 access" });
  await waitFor(() => {
    expect(toggle).not.toBeChecked();
  });
});
