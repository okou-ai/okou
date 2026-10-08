import {
  type ConnectorAccountConnection,
  connectorAccountsContract,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { builtinConnectorOauthStartContract } from "@okouai/api-contracts/contracts/connectors";
import { userBuiltinConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import { userPermissionGrantsContract } from "@okouai/api-contracts/contracts/user-permission-grants";
import { act, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getConnectorAction,
  getConnectorCard,
  getConnectorSwitch,
  listAgent,
  mockConnectors,
  mockConnectorOverviewAccountSummaries,
  mockGithubAccounts,
  mockOAuthCompletions,
  mockPublicConnectorStatus,
  publicStatusItem,
  queryConnectorAction,
  mockConnectorAgentAccess,
} from "./connector-page-test-helpers.ts";

const context = testContext();

function createAuthWindow(): Window {
  const authWindow = context.mocks.browser.authWindow();
  Object.defineProperty(authWindow, "location", {
    configurable: true,
    value: { href: "" },
  });
  return authWindow;
}

function accountActions(container: ParentNode): HTMLElement[] {
  return queryAllByRoleFast("button", container).filter((candidate) => {
    return candidate.getAttribute("aria-label") === "Account actions";
  });
}

function builtinAccount(args: {
  readonly id: string;
  readonly slug?: "github" | "mercury" | "stripe";
  readonly authMethod?: string;
  readonly displayName: string | null;
  readonly isDefault: boolean;
  readonly externalUsername: string | null;
  readonly status?: ConnectorAccountConnection["connectionStatus"];
  readonly scopeMismatch?: boolean;
}): ConnectorAccountConnection {
  return {
    id: args.id,
    target: {
      kind: "builtin",
      connectorSlug: args.slug ?? "github",
    },
    authMethod: args.authMethod ?? "oauth",
    displayName: args.displayName,
    isDefault: args.isDefault,
    externalId: null,
    externalUsername: args.externalUsername,
    externalEmail: null,
    oauthScopes: [],
    scopeMismatch: args.scopeMismatch ?? false,
    connectionStatus: args.status ?? "connected",
    reconnectReason:
      args.status === "reconnect-required"
        ? "authorization_expired_or_revoked"
        : null,
    tokenExpiresAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function setupAccountsPage(): Promise<void> {
  return setupPage({
    context,
    path: "/connectors",
  });
}

test("Show Mercury disclosures while managing its accounts", async () => {
  const [connector] = mockConnectors(context, [
    { connectorSlug: "mercury", externalUsername: "Not A Real Company Inc." },
  ]);
  if (!connector) {
    throw new Error("Expected Mercury connector");
  }
  const account = builtinAccount({
    id: connector.id,
    slug: "mercury",
    displayName: "Sandbox",
    isDefault: true,
    externalUsername: "Not A Real Company Inc.",
  });
  mockPublicConnectorStatus(context, [
    publicStatusItem({
      connectorSlug: "mercury",
      label: "Mercury",
      connected: true,
      connectionStatus: "connected",
      connection: {
        id: connector.id,
        authMethod: "oauth",
        externalUsername: "Not A Real Company Inc.",
        externalEmail: null,
        reconnectReason: null,
      },
    }),
  ]);
  context.mocks.api(connectorAccountsContract.summaries, ({ respond }) => {
    return respond(200, {
      summaries: [
        {
          target: account.target,
          accountCount: 1,
          attentionCount: 0,
          defaultConnection: account,
        },
      ],
    });
  });
  context.mocks.api(connectorAccountsContract.connections, ({ respond }) => {
    return respond(200, { connections: [account], nextCursor: null });
  });
  await setupPage({ context, path: "/connectors?keywords=mercury" });

  const card = await waitFor(() => {
    return getConnectorCard("Mercury");
  });
  expect(
    getConnectorAction("link", "Powered by Mercury", card),
  ).toHaveAttribute("href", "https://mercury.com");

  click(getConnectorAction("button", "Manage Mercury accounts", card));
  const manager = await screen.findByRole("dialog", {
    name: "Manage Mercury accounts",
  });
  expect(
    getConnectorAction("link", "Powered by Mercury", manager),
  ).toHaveAttribute("href", "https://mercury.com");
  expect(manager).toHaveTextContent(
    "Mercury is a fintech company, not an FDIC-insured bank. Banking services provided through Choice Financial Group and Column N.A., Members FDIC.",
  );

  click(getConnectorAction("button", "Close", manager));
  await waitFor(() => {
    expect(manager).not.toBeInTheDocument();
  });
  click(getConnectorAction("button", "Manage Mercury access", card));
  const access = await screen.findByRole("dialog", {
    name: "Manage Mercury access",
  });
  expect(
    getConnectorAction("link", "Powered by Mercury", access),
  ).toHaveAttribute("href", "https://mercury.com");
});

async function openConnectorAccessSummary() {
  const ids = [
    "c0000000-0000-4000-a000-000000000001",
    "c0000000-0000-4000-a000-000000000002",
    "c0000000-0000-4000-a000-000000000003",
    "c0000000-0000-4000-a000-000000000004",
  ];
  const longName = "Research Operations for International Partnerships";
  const enabled = new Map<string, string[]>(
    ids.map((id) => {
      return [id, []];
    }),
  );
  mockConnectors(context, [
    { connectorSlug: "github", externalUsername: "octocat" },
  ]);
  context.mocks.data.agents([
    listAgent(ids[0] ?? "", longName),
    listAgent(ids[1] ?? "", "Support"),
    listAgent(ids[2] ?? "", "Growth"),
    listAgent(ids[3] ?? "", "Ops"),
  ]);
  context.mocks.api(
    userBuiltinConnectorsContract.get,
    ({ params, respond }) => {
      return respond(200, {
        enabledConnectorSlugs: enabled.get(params.id) ?? [],
      });
    },
  );
  mockConnectorAgentAccess(context, (agentId) => {
    return { enabledConnectorSlugs: enabled.get(agentId) ?? [] };
  });
  context.mocks.api(
    userBuiltinConnectorsContract.update,
    ({ params, body, respond }) => {
      const next = body.operation === "remove" ? [] : ["github"];
      enabled.set(params.id, next);
      return respond(200, { enabledConnectorSlugs: next });
    },
  );
  context.mocks.api(userPermissionGrantsContract.list, ({ respond }) => {
    return respond(200, []);
  });
  await setupPage({ context, path: "/connectors" });
  const card = await waitFor(() => {
    return getConnectorCard("GitHub");
  });
  return { card, longName };
}

test("Show the full agent name after granting the first connector access", async () => {
  const { card, longName } = await openConnectorAccessSummary();
  expect(
    getConnectorAction("button", "Manage GitHub access", card),
  ).toHaveTextContent("Add access");

  click(
    getConnectorAction(
      "button",
      "Manage GitHub access",
      getConnectorCard("GitHub"),
    ),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Manage GitHub access",
  });
  click(
    await waitFor(() => {
      return getConnectorSwitch(
        `Authorize GitHub access for ${longName}`,
        dialog,
      );
    }),
  );
  click(getConnectorAction("button", "Close", dialog));
  await waitFor(() => {
    const access = getConnectorAction(
      "button",
      "Manage GitHub access",
      getConnectorCard("GitHub"),
    );
    expect(access).toHaveTextContent(`Used by ${longName}`);
    expect(access).toHaveAttribute("title", longName);
  });
});

test("Make another connector account the default", async () => {
  const [connector] = mockConnectors(context, [
    { connectorSlug: "github", externalUsername: "work" },
  ]);
  if (!connector) {
    throw new Error("Expected GitHub connector");
  }
  const work = builtinAccount({
    id: connector.id,
    displayName: "Work",
    isDefault: true,
    externalUsername: "work",
  });
  const personal = builtinAccount({
    id: crypto.randomUUID(),
    displayName: "Personal",
    isDefault: false,
    externalUsername: "personal",
  });
  let defaultId = work.id;
  const accounts = (): ConnectorAccountConnection[] => {
    return [work, personal].map((account) => {
      return {
        ...account,
        isDefault: account.id === defaultId,
      };
    });
  };
  context.mocks.api(connectorAccountsContract.summaries, ({ respond }) => {
    const defaultConnection = accounts().find((account) => {
      return account.isDefault;
    });
    if (!defaultConnection) {
      throw new Error("Expected default account");
    }
    return respond(200, {
      summaries: [
        {
          target: work.target,
          accountCount: 2,
          attentionCount: 0,
          defaultConnection,
        },
      ],
    });
  });
  mockConnectorOverviewAccountSummaries(context, () => {
    const defaultConnection = accounts().find((account) => {
      return account.isDefault;
    });
    if (!defaultConnection) {
      throw new Error("Expected default account");
    }
    return [
      {
        target: work.target,
        accountCount: 2,
        attentionCount: 0,
        defaultConnection,
      },
    ];
  });
  context.mocks.api(connectorAccountsContract.connections, ({ respond }) => {
    return respond(200, { connections: accounts(), nextCursor: null });
  });
  context.mocks.api(
    connectorAccountsContract.setDefault,
    ({ params, respond }) => {
      defaultId = params.connectionId;
      const updated = accounts().find((account) => {
        return account.id === defaultId;
      });
      if (!updated) {
        return respond(404, {
          error: { message: "Account not found", code: "NOT_FOUND" },
        });
      }
      return respond(200, updated);
    },
  );
  await setupAccountsPage();
  click(
    await waitFor(() => {
      return getConnectorAction("button", "Manage GitHub accounts");
    }),
  );
  const manager = await screen.findByRole("dialog", {
    name: "Manage GitHub accounts",
  });
  const workRow = within(manager).getByRole("group", { name: "Work" });
  expect(within(workRow).getByRole("radio", { name: "Default" })).toBeChecked();

  const personalRow = within(manager).getByRole("group", { name: "Personal" });
  click(within(personalRow).getByRole("radio", { name: "Make default" }));

  await waitFor(() => {
    const updatedPersonalRow = within(manager).getByRole("group", {
      name: "Personal",
    });
    const updatedWorkRow = within(manager).getByRole("group", { name: "Work" });
    expect(
      within(updatedPersonalRow).getByRole("radio", { name: "Default" }),
    ).toBeChecked();
    expect(
      within(updatedWorkRow).getByRole("radio", { name: "Make default" }),
    ).not.toBeChecked();
    expect(within(manager).getAllByText("Work")).toHaveLength(1);
    expect(getConnectorCard("GitHub")).toHaveTextContent("2 accounts");
  });
});

test("Grant and revoke connector access for agents", async () => {
  const researchId = "c0000000-0000-4000-a000-000000000001";
  const supportId = "c0000000-0000-4000-a000-000000000002";
  const enabled = new Map<string, string[]>([
    [researchId, ["github"]],
    [supportId, []],
  ]);
  mockConnectors(context, [
    { connectorSlug: "github", externalUsername: "octocat" },
  ]);
  context.mocks.data.agents([
    listAgent(researchId, "Research Agent"),
    listAgent(supportId, "Support Agent"),
  ]);
  context.mocks.api(
    userBuiltinConnectorsContract.get,
    ({ params, respond }) => {
      return respond(200, {
        enabledConnectorSlugs: enabled.get(params.id) ?? [],
      });
    },
  );
  mockConnectorAgentAccess(context, (agentId) => {
    return { enabledConnectorSlugs: enabled.get(agentId) ?? [] };
  });
  context.mocks.api(
    userBuiltinConnectorsContract.update,
    ({ params, body, respond }) => {
      const current = enabled.get(params.id) ?? [];
      const next =
        body.operation === "remove"
          ? current.filter((slug) => {
              return !body.enabledConnectorSlugs.includes(slug);
            })
          : [...new Set([...current, ...body.enabledConnectorSlugs])];
      enabled.set(params.id, next);
      return respond(200, { enabledConnectorSlugs: next });
    },
  );
  context.mocks.api(userPermissionGrantsContract.list, ({ respond }) => {
    return respond(200, []);
  });
  await setupPage({ context, path: "/connectors" });
  const card = await waitFor(() => {
    return getConnectorCard("GitHub");
  });
  click(getConnectorAction("button", "Manage GitHub access", card));
  const dialog = await screen.findByRole("dialog", {
    name: "Manage GitHub access",
  });
  expect(within(dialog).getByText("Research Agent")).toBeInTheDocument();
  expect(within(dialog).getByText("Support Agent")).toBeInTheDocument();
  await expect(
    waitFor(() => {
      return getConnectorSwitch(
        "Revoke GitHub access for Research Agent",
        dialog,
      );
    }),
  ).resolves.toBeInTheDocument();

  click(
    await waitFor(() => {
      return getConnectorSwitch(
        "Authorize GitHub access for Support Agent",
        dialog,
      );
    }),
  );

  await waitFor(() => {
    expect(
      getConnectorSwitch("Revoke GitHub access for Support Agent", dialog),
    ).toBeInTheDocument();
  });
});

test("Load connector accounts progressively", async () => {
  const accounts = mockGithubAccounts(context, 8);
  const serverPageSize = 3;
  context.mocks.api(
    connectorAccountsContract.connections,
    ({ query, respond }) => {
      const start = query.cursor ? Number(query.cursor) : 0;
      const page = accounts.slice(start, start + serverPageSize);
      const next = start + page.length;
      return respond(200, {
        connections: page,
        nextCursor: next < accounts.length ? String(next) : null,
      });
    },
  );
  await setupAccountsPage();
  click(
    await waitFor(() => {
      return getConnectorAction("button", "Manage GitHub accounts");
    }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Manage GitHub accounts",
  });
  expect(within(dialog).getByText("Work 7")).toBeInTheDocument();
  expect(within(dialog).queryByText("Work 4")).not.toBeInTheDocument();

  click(getConnectorAction("button", "Load more", dialog));
  await expect(
    within(dialog).findByText("Work 4"),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).getByText("Work 7")).toBeInTheDocument();

  click(
    await waitFor(() => {
      const loadMore = getConnectorAction("button", "Load more", dialog);
      expect(loadMore).toBeEnabled();
      return loadMore;
    }),
  );
  await expect(
    within(dialog).findByText("Work 1"),
  ).resolves.toBeInTheDocument();
  expect(queryConnectorAction("button", "Load more", dialog)).toBeNull();
  expect(within(dialog).getAllByText("Unnamed account")).toHaveLength(1);
  expect(accountActions(dialog)).toHaveLength(8);
});

async function openNamedConnectorAccountRename() {
  const [connector] = mockConnectors(context, [
    { connectorSlug: "github", externalUsername: "octocat" },
  ]);
  if (!connector) {
    throw new Error("Expected GitHub connector");
  }
  let account: ConnectorAccountConnection | null = builtinAccount({
    id: connector.id,
    displayName: "Work",
    isDefault: true,
    externalUsername: "octocat",
  });
  context.mocks.api(connectorAccountsContract.summaries, ({ respond }) => {
    return respond(200, {
      summaries: account
        ? [
            {
              target: account.target,
              accountCount: 1,
              attentionCount: 0,
              defaultConnection: account,
            },
          ]
        : [],
    });
  });
  context.mocks.api(connectorAccountsContract.connections, ({ respond }) => {
    return respond(200, {
      connections: account ? [account] : [],
      nextCursor: null,
    });
  });
  context.mocks.api(
    connectorAccountsContract.rename,
    ({ params, body, respond }) => {
      if (!account || params.connectionId !== account.id) {
        return respond(404, {
          error: { message: "Account not found", code: "NOT_FOUND" },
        });
      }
      account = { ...account, displayName: body.displayName };
      return respond(200, account);
    },
  );
  context.mocks.api(
    connectorAccountsContract.deletionImpact,
    ({ params, respond }) => {
      return respond(200, {
        connectionId: params.connectionId,
        explicitSelectionCount: 2,
        hasSibling: false,
      });
    },
  );
  context.mocks.api(connectorAccountsContract.delete, ({ params, respond }) => {
    account = null;
    context.mocks.data.connectors([]);
    return respond(200, {
      deletedConnectionId: params.connectionId,
      resolvedSelectionCount: 2,
      promotedDefaultConnectionId: null,
    });
  });
  await setupPage({ context, path: "/connectors?keywords=github" });
  click(
    await waitFor(() => {
      return getConnectorAction("button", "Manage GitHub accounts");
    }),
  );
  const manager = await screen.findByRole("dialog", {
    name: "Manage GitHub accounts",
  });
  click(
    await waitFor(() => {
      const action = accountActions(manager)[0];
      if (!action) {
        throw new Error("Expected Work account actions");
      }
      return action;
    }),
  );
  click(
    await waitFor(() => {
      return getConnectorAction("menuitem", "Rename");
    }),
  );
  return manager;
}

test("Rename a specific connector account to a new label", async () => {
  const manager = await openNamedConnectorAccountRename();
  await fill(await within(manager).findByLabelText("Account name"), "Personal");
  click(getConnectorAction("button", "Save", manager));
  await waitFor(() => {
    expect(
      within(
        screen.getByRole("dialog", { name: "Manage GitHub accounts" }),
      ).getByText("Personal"),
    ).toBeInTheDocument();
  });
});

test("Clear a connector account label and disconnect its fallback identity", async () => {
  const manager = await openNamedConnectorAccountRename();
  await fill(await within(manager).findByLabelText("Account name"), " ");
  click(getConnectorAction("button", "Save", manager));
  await waitFor(() => {
    expect(within(manager).getAllByText("octocat")).toHaveLength(1);
  });

  click(
    await waitFor(() => {
      const action = accountActions(manager)[0];
      if (!action) {
        throw new Error("Expected octocat account actions");
      }
      return action;
    }),
  );
  click(
    await waitFor(() => {
      return getConnectorAction("menuitem", "Disconnect");
    }),
  );
  const confirmation = await screen.findByRole("dialog", {
    name: "Disconnect octocat?",
  });
  expect(
    within(confirmation).getByText(
      "This disconnects the account from Okou. 2 threads will return to default inheritance. The provider account will not be deleted.",
    ),
  ).toBeInTheDocument();
  click(getConnectorAction("button", "Disconnect account", confirmation));
  await waitFor(() => {
    expect(within(manager).getByText("No accounts found")).toBeInTheDocument();
    expect(getConnectorAction("button", "Add account", manager)).toBeEnabled();
  });
});

test("Review and reconnect the connector account the user selected", async () => {
  const [connector] = mockConnectors(context, [
    { connectorSlug: "github", externalUsername: "work" },
  ]);
  if (!connector) {
    throw new Error("Expected GitHub connector");
  }
  const work = builtinAccount({
    id: connector.id,
    displayName: "Work",
    isDefault: true,
    externalUsername: "work",
  });
  const personal = builtinAccount({
    id: crypto.randomUUID(),
    displayName: "Personal",
    isDefault: false,
    externalUsername: "personal",
    scopeMismatch: true,
  });
  context.mocks.api(connectorAccountsContract.summaries, ({ respond }) => {
    return respond(200, {
      summaries: [
        {
          target: work.target,
          accountCount: 2,
          attentionCount: 1,
          defaultConnection: work,
        },
      ],
    });
  });
  context.mocks.api(
    connectorAccountsContract.scopeDiff,
    ({ params, respond }) => {
      expect(params.connectionId).toBe(personal.id);
      return respond(200, {
        addedScopes: ["read:user"],
        removedScopes: [],
        currentScopes: ["read:user"],
        storedScopes: [],
      });
    },
  );
  context.mocks.api(connectorAccountsContract.connections, ({ respond }) => {
    return respond(200, {
      connections: [work, personal],
      nextCursor: null,
      defaultConnection: work,
    });
  });
  let submittedAccount: unknown;
  mockOAuthCompletions(context);
  context.mocks.api(
    builtinConnectorOauthStartContract.start,
    ({ body, respond }) => {
      submittedAccount = body.account;
      return respond(200, {
        authorizationUrl: "https://oauth.test/github/authorize",
        oauthAttemptId: crypto.randomUUID(),
      });
    },
  );
  const authWindow = createAuthWindow();
  context.mocks.browser.open(authWindow);
  await setupAccountsPage();

  click(
    await waitFor(() => {
      return getConnectorAction("button", "Manage GitHub accounts");
    }),
  );
  const manager = await screen.findByRole("dialog", {
    name: "Manage GitHub accounts",
  });
  const personalRow = within(manager).getByRole("group", { name: "Personal" });
  expect(within(personalRow).getByText("Update permissions")).toBeVisible();
  click(getConnectorAction("button", "Account actions", personalRow));
  click(getConnectorAction("menuitem", "Review permissions"));

  const review = await screen.findByRole("dialog", {
    name: "GitHub permissions update",
  });
  expect(within(review).getByText("read:user")).toBeVisible();
  click(getConnectorAction("button", "Reconnect", review));

  const reconnect = await waitFor(() => {
    const dialog = screen
      .getAllByRole("dialog", { name: "GitHub" })
      .find((candidate) => {
        return queryConnectorAction("button", "Reconnect", candidate);
      });
    if (!dialog) {
      throw new Error("Expected GitHub reconnect dialog");
    }
    return dialog;
  });
  click(getConnectorAction("button", "Reconnect", reconnect));

  await waitFor(() => {
    expect(authWindow.location.href).toBe(
      "https://oauth.test/github/authorize",
    );
  });
  expect(submittedAccount).toStrictEqual({
    intent: "reconnect",
    connectionId: personal.id,
  });
});

test("Let account search own the entire manager result list", async () => {
  const accounts = mockGithubAccounts(context, 7).map((account) => {
    return account.isDefault ? { ...account, displayName: "Primary" } : account;
  });
  context.mocks.api(
    connectorAccountsContract.connections,
    ({ query, respond }) => {
      const search = query.search?.toLowerCase();
      const connections = search
        ? accounts.filter((account) => {
            return account.displayName?.toLowerCase().includes(search);
          })
        : accounts;
      return respond(200, { connections, nextCursor: null });
    },
  );
  await setupAccountsPage();
  click(
    await waitFor(() => {
      return getConnectorAction("button", "Manage GitHub accounts");
    }),
  );
  const manager = await screen.findByRole("dialog", {
    name: "Manage GitHub accounts",
  });
  const input = await within(manager).findByPlaceholderText("Find accounts");

  await fill(input, "No matching account");
  await waitFor(() => {
    expect(within(manager).getByText("No accounts found")).toBeInTheDocument();
  });
  expect(within(manager).queryByText("Primary")).not.toBeInTheDocument();

  await fill(input, "Primary");
  await waitFor(() => {
    expect(within(manager).getByText("Primary")).toBeInTheDocument();
    expect(
      within(manager).queryByText("No accounts found"),
    ).not.toBeInTheDocument();
  });
});

test("Manage connector accounts and agent access independently", async () => {
  const accounts = mockGithubAccounts(context, 7);
  context.mocks.api(connectorAccountsContract.connections, ({ respond }) => {
    return respond(200, { connections: accounts, nextCursor: null });
  });
  await setupAccountsPage();
  const card = await waitFor(() => {
    return getConnectorCard("GitHub");
  });
  expect(card).toHaveTextContent("1/7 need attention");
  const manageAccounts = getConnectorAction(
    "button",
    "Manage GitHub accounts",
    card,
  );
  const manageAccess = getConnectorAction(
    "button",
    "Manage GitHub access",
    card,
  );

  click(manageAccess);

  const access = await screen.findByRole("dialog", {
    name: "Manage GitHub access",
  });
  expect(
    screen.queryByRole("dialog", { name: "Manage GitHub accounts" }),
  ).not.toBeInTheDocument();
  click(getConnectorAction("button", "Close", access));
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Manage GitHub access" }),
    ).not.toBeInTheDocument();
  });

  click(manageAccounts);

  const manager = await screen.findByRole("dialog", {
    name: "Manage GitHub accounts",
  });
  const defaultRow = within(manager).getByRole("group", {
    name: "Unnamed account",
  });
  expect(
    within(defaultRow).getByRole("radio", { name: "Default" }),
  ).toBeChecked();
  expect(
    within(defaultRow).getByText("Reconnect required"),
  ).toBeInTheDocument();
  expect(within(manager).getAllByText("Unnamed account")).toHaveLength(1);
});

test("Manage access for a connector without configurable permissions", async () => {
  const mediaId = "c0000000-0000-4000-a000-000000000003";
  mockConnectors(context, [
    {
      connectorSlug: "cloudinary",
      authMethod: "api-token",
      externalUsername: "demo-cloud",
    },
  ]);
  context.mocks.data.agents([listAgent(mediaId, "Media Agent")]);
  context.mocks.api(userBuiltinConnectorsContract.get, ({ respond }) => {
    return respond(200, { enabledConnectorSlugs: ["cloudinary"] });
  });
  mockConnectorAgentAccess(context, () => {
    return { enabledConnectorSlugs: ["cloudinary"] };
  });
  context.mocks.api(userPermissionGrantsContract.list, ({ respond }) => {
    return respond(200, []);
  });
  await setupPage({ context, path: "/connectors" });
  const card = await waitFor(() => {
    return getConnectorCard("Cloudinary");
  });

  click(getConnectorAction("button", "Manage Cloudinary access", card));

  const dialog = await screen.findByRole("dialog", {
    name: "Manage Cloudinary access",
  });
  expect(within(dialog).getByText("Media Agent")).toBeInTheDocument();
  await expect(
    waitFor(() => {
      return getConnectorSwitch(
        "Revoke Cloudinary access for Media Agent",
        dialog,
      );
    }),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).queryByText("Allowed")).not.toBeInTheDocument();
  expect(
    within(dialog).queryByText("No configurable permissions"),
  ).not.toBeInTheDocument();
  expect(queryConnectorAction("button", "Manage", dialog)).toBeNull();
});

test("Prevent account additions when a connector target is unavailable", async () => {
  const [connector] = mockConnectors(context, [
    { connectorSlug: "github", externalUsername: "work" },
  ]);
  if (!connector) {
    throw new Error("Expected GitHub connector");
  }
  const account = builtinAccount({
    id: connector.id,
    displayName: "Work",
    isDefault: true,
    externalUsername: "work",
  });
  context.mocks.api(connectorAccountsContract.summaries, ({ respond }) => {
    return respond(200, {
      summaries: [
        {
          target: account.target,
          accountCount: 1,
          attentionCount: 0,
          defaultConnection: account,
        },
      ],
    });
  });
  context.mocks.api(connectorAccountsContract.connections, ({ respond }) => {
    return respond(404, {
      error: { message: "Target unavailable", code: "NOT_FOUND" },
    });
  });
  await setupAccountsPage();
  click(
    await waitFor(() => {
      return getConnectorAction("button", "Manage GitHub accounts");
    }),
  );
  const manager = await screen.findByRole("dialog", {
    name: "Manage GitHub accounts",
  });

  await expect(
    within(manager).findByText("Accounts are unavailable for this connector."),
  ).resolves.toBeInTheDocument();
  expect(getConnectorAction("button", "Add account", manager)).toBeDisabled();
  expect(within(manager).queryByRole("group", { name: "Default" })).toBeNull();
});

test("Keep connector account summaries while a realtime refresh loads", async () => {
  const [connector] = mockConnectors(context, [
    { connectorSlug: "github", externalUsername: "work" },
  ]);
  if (!connector) {
    throw new Error("Expected GitHub connector");
  }
  const work = builtinAccount({
    id: connector.id,
    displayName: "Work",
    isDefault: true,
    externalUsername: "work",
  });
  const refreshStarted = context.mocks.deferred<void>();
  const releaseRefresh = context.mocks.deferred<void>();
  let overviewRequests = 0;
  mockConnectorOverviewAccountSummaries(context, async () => {
    overviewRequests += 1;
    if (overviewRequests > 1) {
      refreshStarted.resolve();
      await releaseRefresh.promise;
    }
    return [
      {
        target: work.target,
        accountCount: 2,
        attentionCount: 0,
        defaultConnection: work,
      },
    ];
  });
  await setupAccountsPage();
  await waitFor(() => {
    expect(getConnectorCard("GitHub")).toHaveTextContent("2 accounts");
  });

  act(() => {
    context.mocks.ably.trigger("computerUseHostsChanged");
  });
  await refreshStarted.promise;

  const card = getConnectorCard("GitHub");
  expect(card).toHaveTextContent("2 accounts");
  expect(within(card).queryByText("Loading accounts…")).toBeNull();

  releaseRefresh.resolve();
  await waitFor(() => {
    expect(getConnectorCard("GitHub")).toHaveTextContent("2 accounts");
  });
});
