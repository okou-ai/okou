import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type { ConnectorAccountTarget } from "@okouai/api-contracts/contracts/connector-accounts";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import {
  ACME_CONNECTOR_ID,
  builtinConnector,
  connectorAccount,
  DEEPWIKI_CONNECTOR_ID,
  mcpConnector,
  httpConnector,
  manualAuthMethod,
  OTHER_AGENT_ID,
  OTHER_THREAD_ID,
  SCOUT_AGENT_ID,
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
  ).resolves.toBeEnabled();
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

test.each(["builtin", "custom"] as const)(
  "Configuration attention keeps the %s default out of healthy account fallbacks",
  async (kind) => {
    const user = userEvent.setup({ delay: null });
    const target: ConnectorAccountTarget =
      kind === "builtin"
        ? { kind, connectorSlug: "acme-cloud" }
        : { kind, customConnectorId: ACME_CONNECTOR_ID };
    const fields = [
      {
        key: "apiKey",
        label: "API key",
        kind: "secret" as const,
        required: true,
      },
      {
        key: "region",
        label: "Region",
        kind: "variable" as const,
        required: true,
      },
    ];
    const work = {
      ...connectorAccount({
        id: "f0000000-0000-4000-a000-000000000591",
        target,
        displayName: "Work",
        isDefault: true,
      }),
      authMethod: kind === "builtin" ? "api-token" : "manual",
      oauthScopes: null,
      connectionStatus: "reconnect-required" as const,
      reconnectReason: "configuration_incomplete" as const,
      missingRequiredFields: ["region"],
      configuredFieldKeys: ["apiKey"],
    };
    const personal = {
      ...work,
      id: "f0000000-0000-4000-a000-000000000592",
      displayName: "Personal",
      isDefault: false,
      reconnectReason: "authorization_expired_or_revoked" as const,
      missingRequiredFields: [],
      configuredFieldKeys: ["apiKey", "region"],
    };
    installComposerConnectorFixture({
      catalog:
        kind === "builtin"
          ? [
              builtinConnector({
                slug: "acme-cloud",
                label: "Acme",
                authMethods: [
                  {
                    ...manualAuthMethod(),
                    manualFields: fields.map((field) => {
                      return {
                        id: field.key,
                        label: field.label,
                        required: true,
                        placeholder: null,
                        inputType:
                          field.kind === "secret" ? "password" : "text",
                      };
                    }),
                  },
                ],
              }),
            ]
          : [],
      customConnectors:
        kind === "custom"
          ? [
              {
                ...httpConnector({
                  id: ACME_CONNECTOR_ID,
                  slug: "_acme-cloud",
                  displayName: "Acme",
                  hasAccount: true,
                }),
                fields,
                headerInjections: [
                  {
                    name: "Authorization",
                    valueTemplate: "Bearer {{secrets.apiKey}}",
                  },
                ],
              },
            ]
          : [],
      builtinAuthorizations:
        kind === "builtin" ? { [SCOUT_AGENT_ID]: ["acme-cloud"] } : {},
      customAuthorizations:
        kind === "custom"
          ? {
              [SCOUT_AGENT_ID]: [
                { customConnectorId: ACME_CONNECTOR_ID, permissionNames: [] },
              ],
            }
          : {},
      accounts: [work, personal],
      threadSelections: {
        [SCOUT_THREAD_ID]: [{ target, connectionId: personal.id }],
      },
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
      "Acme · Selected account: Personal",
    );
    expect(
      within(chooser).getByRole("option", {
        name: /^Work.*Reconnect required/u,
      }),
    ).toBeInTheDocument();
    expect(
      within(chooser).getByRole("option", {
        name: /^Use default.*Work.*Reconnect required/u,
      }),
    ).toBeInTheDocument();
    expect(
      within(chooser).getByRole("option", {
        name: /^Personal.*No usable account/u,
      }),
    ).toHaveAttribute("aria-selected", "true");
  },
);

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
  ).resolves.toBeEnabled();
  await expect(
    findFastControl("button", "Connectors", otherPane),
  ).resolves.toBeEnabled();
  return { user, fixture, scoutPane, otherPane, otherAuthorization };
}

test("A pending connector authorization does not borrow the other chat agent's access", async () => {
  const { user, scoutPane, otherPane, otherAuthorization } =
    await openAgentScopedConnectors(true);
  await openConnectors(scoutPane);
  await expect(screen.findByLabelText("Add Slack")).resolves.toBeEnabled();
  await user.keyboard("{Escape}");
  await openConnectors(otherPane);
  expect(screen.queryByLabelText("Remove Slack")).toBeNull();
  expect(screen.queryByLabelText("Add Slack")).toBeNull();

  otherAuthorization.resolve(undefined);
  await expect(screen.findByLabelText("Remove Slack")).resolves.toBeEnabled();
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
    "GitHub · Account for this chat",
  );
  await user.click(within(chooser).getByRole("option", { name: /Personal/u }));
  await expect(
    findFastControl("button", "GitHub · Selected account: Personal"),
  ).resolves.toBeVisible();
  click(await findFastControl("button", "Connectors"));
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Connectors" })).toBeNull();
  });
  await openConnectors();
  await expect(
    findFastControl("button", "GitHub · Selected account: Personal"),
  ).resolves.toBeVisible();
  await user.keyboard("{Escape}");
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
        hasAccount: true,
      }),
    ],
    customAuthorizations: {
      [SCOUT_AGENT_ID]: [
        { customConnectorId: DEEPWIKI_CONNECTOR_ID, permissionNames: [] },
      ],
    },
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
  const chooser = await openAccountChooser(
    user,
    "DeepWiki · Account for this chat",
  );
  await user.click(within(chooser).getByRole("option", { name: /Personal/u }));
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
    screen.getByRole("option", { name: /Use default.*Team/u }),
  ).toBeVisible();
});

test("Choose which connector account a chat uses", async () => {
  const user = userEvent.setup({ delay: null });
  const accounts = githubAccounts();
  const fixture = installComposerConnectorFixture({
    catalog: [builtinConnector({ slug: GITHUB_SLUG, label: "GitHub" })],
    builtinAuthorizations: { [SCOUT_AGENT_ID]: [GITHUB_SLUG] },
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
    "GitHub · Account for this chat",
  );
  await user.click(within(chooser).getByRole("option", { name: /Personal/u }));
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
    within(chooser).getByRole("option", { name: /Use default/u }),
  );
  await expect(
    findFastControl("button", "GitHub · Account for this chat"),
  ).resolves.toBeVisible();
  expect(fixture.builtinAuthorizationUpdates).toHaveLength(0);
  expect(fixture.clearedThreadSelections).toStrictEqual([
    { threadId: SCOUT_THREAD_ID, target: githubTarget() },
  ]);
});
