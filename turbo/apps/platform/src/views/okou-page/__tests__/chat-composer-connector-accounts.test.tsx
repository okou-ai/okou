import type { ConnectorAccountTarget } from "@okouai/api-contracts/contracts/connector-accounts";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import {
  accountSummary,
  builtinConnector,
  connectorAccount,
  DEEPWIKI_CONNECTOR_ID,
  installComposerConnectorFixture,
  mcpConnector,
  OTHER_AGENT_ID,
  OTHER_THREAD_ID,
  SCOUT_AGENT_ID,
  SCOUT_THREAD_ID,
  SECOND_SCOUT_THREAD_ID,
} from "./chat-composer-connectors-test-helpers.ts";
import {
  context,
  findComposer,
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";

const GITHUB_SLUG = "github" as ConnectorSlug;
const SLACK_SLUG = "slack" as ConnectorSlug;

function githubTarget(): ConnectorAccountTarget {
  return { kind: "builtin", connectorSlug: GITHUB_SLUG };
}

function deepWikiTarget(): ConnectorAccountTarget {
  return { kind: "custom", customConnectorId: DEEPWIKI_CONNECTOR_ID };
}

function pane(threadId: string): HTMLElement {
  const container = document.querySelector<HTMLElement>(
    `[data-chat-thread-container-id="${threadId}"]`,
  );
  if (!container) {
    throw new Error(`Chat pane ${threadId} not found`);
  }
  return container;
}

async function loadComposer(): Promise<void> {
  await expect(findComposer()).resolves.toBeVisible();
  await expect(findFastControl("button", "Connectors")).resolves.toBeVisible();
}

async function openConnectors(
  container: ParentNode = document.body,
): Promise<void> {
  click(await findFastControl("button", "Connectors", container));
  await expect(
    findFastControl("button", "Add connectors"),
  ).resolves.toBeVisible();
}

async function openAccountChooser(
  user: ReturnType<typeof userEvent.setup>,
  accessibleName: string,
  container: ParentNode = document.body,
): Promise<HTMLElement> {
  await user.click(await findFastControl("button", accessibleName, container));
  const heading = await screen.findByText("Account for this chat", {
    selector: "span",
  });
  const chooser = heading.closest('[aria-label="Account for this chat"]');
  if (!(chooser instanceof HTMLElement)) {
    throw new Error("Connector account chooser not found");
  }
  return chooser;
}

function githubAccounts(count = 2) {
  return Array.from({ length: count }, (_, index) => {
    const names = ["Work", "Personal", "Client", "Research", "Open Source"];
    return connectorAccount({
      id: `f0000000-0000-4000-a000-${(index + 91)
        .toString()
        .padStart(12, "0")}`,
      target: githubTarget(),
      displayName: names[index] ?? `Account ${index + 1}`,
      isDefault: index === 0,
    });
  });
}

async function openAgentScopedConnectors(pendingAuthorization: boolean) {
  const user = userEvent.setup({ delay: null });
  const otherAuthorization = context.mocks.deferred<void>();
  const fixture = installComposerConnectorFixture({
    catalog: [builtinConnector({ slug: SLACK_SLUG, label: "Slack" })],
    builtinAuthorizations: {
      [SCOUT_AGENT_ID]: [],
      [OTHER_AGENT_ID]: [SLACK_SLUG],
    },
    authorizationGates: pendingAuthorization
      ? { [OTHER_AGENT_ID]: otherAuthorization.promise }
      : {},
    threads: [
      { id: SCOUT_THREAD_ID, title: "Scout chat", agentId: SCOUT_AGENT_ID },
      { id: OTHER_THREAD_ID, title: "Other chat", agentId: OTHER_AGENT_ID },
    ],
    threadId: SCOUT_THREAD_ID,
  });

  await setupPage({
    locale: "en-US",
    context,
    path: `/chats/${SCOUT_THREAD_ID}?sidebar=${OTHER_THREAD_ID}`,
  });

  await waitFor(() => {
    expect(
      document.querySelectorAll("[data-chat-thread-container-id]"),
    ).toHaveLength(2);
  });
  const scoutPane = pane(SCOUT_THREAD_ID);
  const otherPane = pane(OTHER_THREAD_ID);
  await expect(
    findFastControl("button", "Connectors", scoutPane),
  ).resolves.toBeVisible();
  await expect(
    findFastControl("button", "Connectors", otherPane),
  ).resolves.toBeVisible();
  return { user, fixture, scoutPane, otherPane, otherAuthorization };
}

test("A pending connector authorization does not borrow the other chat agent's access", async () => {
  const { user, scoutPane, otherPane, otherAuthorization } =
    await openAgentScopedConnectors(true);
  await openConnectors(scoutPane);
  await expect(screen.findByLabelText("Add Slack")).resolves.toBeVisible();
  await user.keyboard("{Escape}");
  await openConnectors(otherPane);
  expect(screen.queryByLabelText("Remove Slack")).toBeNull();
  expect(screen.queryByLabelText("Add Slack")).toBeNull();

  otherAuthorization.resolve(undefined);
  await expect(screen.findByLabelText("Remove Slack")).resolves.toBeVisible();
});

test("Removing a connector updates only the selected chat agent's access", async () => {
  const { user, fixture, scoutPane, otherPane } =
    await openAgentScopedConnectors(false);
  await openConnectors(otherPane);
  await screen.findByLabelText("Remove Slack");
  await user.click(screen.getByLabelText("Remove Slack"));
  await expect(screen.findByLabelText("Add Slack")).resolves.toBeVisible();
  await user.keyboard("{Escape}");
  await openConnectors(scoutPane);
  expect(screen.getByLabelText("Add Slack")).toBeVisible();
  expect(fixture.builtinAuthorizationUpdates).toStrictEqual([
    {
      agentId: OTHER_AGENT_ID,
      connectorSlugs: [SLACK_SLUG],
      operation: "remove",
    },
  ]);
});

test("Carry a connector account choice into a new chat", async () => {
  const user = userEvent.setup({ delay: null });
  const accounts = githubAccounts();
  const fixture = installComposerConnectorFixture({
    catalog: [builtinConnector({ slug: GITHUB_SLUG, label: "GitHub" })],
    builtinAuthorizations: { [SCOUT_AGENT_ID]: [GITHUB_SLUG] },
    accountSummaries: [accountSummary(githubTarget(), accounts)],
    accounts,
  });

  await setupPage({
    locale: "en-US",
    context,
    path: `/agents/${SCOUT_AGENT_ID}/chat`,
  });

  await loadComposer();
  await openConnectors();
  const chooser = await openAccountChooser(
    user,
    "GitHub · Using default account: Work",
  );
  await user.click(within(chooser).getByRole("radio", { name: /Personal/u }));
  await expect(
    findFastControl("button", "GitHub · Selected account: Personal"),
  ).resolves.toBeVisible();
  const composer = await findComposer();
  await fill(composer, "Use my personal GitHub account");
  await user.keyboard("{Enter}");

  await waitFor(() => {
    expect(fixture.createdThreadRequests).toStrictEqual([
      {
        threadId: expect.any(String),
        connectorSelections: [
          {
            target: githubTarget(),
            connectionId: accounts[1]!.id,
          },
        ],
      },
    ]);
    expect(window.location.pathname).toBe(
      `/chats/${fixture.createdThreadRequests[0]!.threadId}`,
    );
  });
});

test("Preserve connector context across chats with the same agent", async () => {
  const user = userEvent.setup({ delay: null });
  installComposerConnectorFixture({
    catalog: [builtinConnector({ slug: GITHUB_SLUG, label: "GitHub" })],
    builtinAuthorizations: { [SCOUT_AGENT_ID]: [GITHUB_SLUG] },
    threads: [
      {
        id: SCOUT_THREAD_ID,
        title: "First Scout chat",
        agentId: SCOUT_AGENT_ID,
      },
      {
        id: SECOND_SCOUT_THREAD_ID,
        title: "Second Scout chat",
        agentId: SCOUT_AGENT_ID,
      },
    ],
    threadId: SCOUT_THREAD_ID,
  });

  await setupPage({
    locale: "en-US",
    context,
    path: `/chats/${SCOUT_THREAD_ID}`,
  });

  await loadComposer();
  await openConnectors();
  await expect(screen.findByLabelText("Remove GitHub")).resolves.toBeVisible();
  await user.click(await findFastControl("link", "Second Scout chat"));
  await waitFor(() => {
    expect(window.location.pathname).toBe(`/chats/${SECOND_SCOUT_THREAD_ID}`);
  });
  await user.click(await findFastControl("button", "Connectors"));
  expect(screen.getByLabelText("Remove GitHub")).toBeVisible();
  expect(screen.queryByText("Loading connectors")).toBeNull();
});

test("Choose an account for a custom MCP connector", async () => {
  const user = userEvent.setup({ delay: null });
  const accounts = [
    connectorAccount({
      id: "f0000000-0000-4000-a000-000000000101",
      target: deepWikiTarget(),
      displayName: "Team",
      isDefault: true,
    }),
    connectorAccount({
      id: "f0000000-0000-4000-a000-000000000102",
      target: deepWikiTarget(),
      displayName: "Personal",
      isDefault: false,
    }),
  ];
  const fixture = installComposerConnectorFixture({
    customConnectors: [
      mcpConnector({
        id: DEEPWIKI_CONNECTOR_ID,
        slug: "deepwiki",
        displayName: "DeepWiki",
        connected: true,
      }),
    ],
    customAuthorizations: {
      [SCOUT_AGENT_ID]: [
        { customConnectorId: DEEPWIKI_CONNECTOR_ID, permissionNames: [] },
      ],
    },
    accountSummaries: [accountSummary(deepWikiTarget(), accounts)],
    accounts,
    threadId: SCOUT_THREAD_ID,
  });

  await setupPage({
    locale: "en-US",
    context,
    path: `/chats/${SCOUT_THREAD_ID}`,
    featureSwitches: {
      [FeatureSwitchKey.CustomConnectorMcp]: true,
    },
  });

  await loadComposer();
  await openConnectors();
  const chooser = await openAccountChooser(
    user,
    "DeepWiki · Using default account: Team",
  );
  await user.click(within(chooser).getByRole("radio", { name: /Personal/u }));
  await waitFor(() => {
    expect(fixture.threadSelectionUpdates).toStrictEqual([
      {
        threadId: SCOUT_THREAD_ID,
        selection: {
          target: deepWikiTarget(),
          connectionId: accounts[1]!.id,
        },
      },
    ]);
  });
  await openAccountChooser(user, "DeepWiki · Selected account: Personal");
  expect(
    screen.getByRole("radio", { name: /Use default.*Team/u }),
  ).toBeVisible();
});

test("Keep the selected connector account visible during search", async () => {
  const user = userEvent.setup({ delay: null });
  const accounts = githubAccounts(7);
  const selection = {
    target: githubTarget(),
    connectionId: accounts[1]!.id,
  };
  installComposerConnectorFixture({
    catalog: [builtinConnector({ slug: GITHUB_SLUG, label: "GitHub" })],
    builtinAuthorizations: { [SCOUT_AGENT_ID]: [GITHUB_SLUG] },
    accountSummaries: [accountSummary(githubTarget(), accounts)],
    accounts,
    threadSelections: { [SCOUT_THREAD_ID]: [selection] },
    threadId: SCOUT_THREAD_ID,
  });

  await setupPage({
    locale: "en-US",
    context,
    path: `/chats/${SCOUT_THREAD_ID}`,
  });

  await loadComposer();
  await openConnectors();
  const chooser = await openAccountChooser(
    user,
    "GitHub · Selected account: Personal",
  );
  await user.type(
    within(chooser).getByPlaceholderText("Find accounts"),
    "missing",
  );
  await waitFor(() => {
    expect(within(chooser).getByText("No accounts found")).toBeVisible();
    expect(
      within(chooser).getByRole("radio", { name: /Personal/u }),
    ).toBeVisible();
    expect(
      within(chooser).getByRole("radio", { name: /Personal/u }),
    ).toHaveAttribute("aria-checked", "true");
  });
});

test("Choose which connector account a chat uses", async () => {
  const user = userEvent.setup({ delay: null });
  const accounts = githubAccounts();
  const fixture = installComposerConnectorFixture({
    catalog: [builtinConnector({ slug: GITHUB_SLUG, label: "GitHub" })],
    builtinAuthorizations: { [SCOUT_AGENT_ID]: [GITHUB_SLUG] },
    accountSummaries: [accountSummary(githubTarget(), accounts)],
    accounts,
    threadId: SCOUT_THREAD_ID,
  });

  await setupPage({
    locale: "en-US",
    context,
    path: `/chats/${SCOUT_THREAD_ID}`,
  });

  await loadComposer();
  await openConnectors();
  let chooser = await openAccountChooser(
    user,
    "GitHub · Using default account: Work",
  );
  await user.click(within(chooser).getByRole("radio", { name: /Personal/u }));
  await expect(
    findFastControl("button", "GitHub · Selected account: Personal"),
  ).resolves.toBeVisible();
  await expect(
    findFastControl("button", "Add connectors"),
  ).resolves.toBeVisible();

  chooser = await openAccountChooser(
    user,
    "GitHub · Selected account: Personal",
  );
  await user.click(
    within(chooser).getByRole("radio", { name: /Use default/u }),
  );
  await expect(
    findFastControl("button", "GitHub · Using default account: Work"),
  ).resolves.toBeVisible();
  expect(fixture.builtinAuthorizationUpdates).toHaveLength(0);
  expect(fixture.clearedThreadSelections).toStrictEqual([
    { threadId: SCOUT_THREAD_ID, target: githubTarget() },
  ]);

  chooser = await openAccountChooser(
    user,
    "GitHub · Using default account: Work",
  );
  await user.click(await findFastControl("button", "Back", chooser));
  await waitFor(() => {
    expect(screen.queryByLabelText("Account for this chat")).toBeNull();
    expect(queryFastControl("button", "Add connectors")).toBeVisible();
    expect(
      queryFastControl("button", "GitHub · Using default account: Work"),
    ).toBeVisible();
  });
});

test("Keep connector access synchronized across split chats for the same agent", async () => {
  const user = userEvent.setup({ delay: null });
  const fixture = installComposerConnectorFixture({
    catalog: [builtinConnector({ slug: SLACK_SLUG, label: "Slack" })],
    builtinAuthorizations: { [SCOUT_AGENT_ID]: [SLACK_SLUG] },
    threads: [
      { id: SCOUT_THREAD_ID, title: "Scout planning", agentId: SCOUT_AGENT_ID },
      {
        id: SECOND_SCOUT_THREAD_ID,
        title: "Scout research",
        agentId: SCOUT_AGENT_ID,
      },
    ],
    threadId: SCOUT_THREAD_ID,
  });

  await setupPage({
    locale: "en-US",
    context,
    path: `/chats/${SCOUT_THREAD_ID}?sidebar=${SECOND_SCOUT_THREAD_ID}`,
  });

  await waitFor(() => {
    expect(
      document.querySelectorAll("[data-chat-thread-container-id]"),
    ).toHaveLength(2);
  });
  const firstPane = pane(SCOUT_THREAD_ID);
  const secondPane = pane(SECOND_SCOUT_THREAD_ID);
  await expect(
    findFastControl("button", "Connectors", firstPane),
  ).resolves.toBeVisible();
  await expect(
    findFastControl("button", "Connectors", secondPane),
  ).resolves.toBeVisible();
  await openConnectors(firstPane);
  await expect(screen.findByLabelText("Remove Slack")).resolves.toBeVisible();
  await user.keyboard("{Escape}");
  await openConnectors(secondPane);
  await expect(screen.findByLabelText("Remove Slack")).resolves.toBeVisible();

  await user.click(screen.getByLabelText("Remove Slack"));
  await expect(screen.findByLabelText("Add Slack")).resolves.toBeVisible();
  await user.keyboard("{Escape}");
  await openConnectors(firstPane);
  expect(screen.getByLabelText("Add Slack")).toBeVisible();
  expect(fixture.builtinAuthorizationUpdates).toStrictEqual([
    {
      agentId: SCOUT_AGENT_ID,
      connectorSlugs: [SLACK_SLUG],
      operation: "remove",
    },
  ]);
});
