import {
  type ConnectorAccountConnection,
  connectorAccountsContract,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { connectorOauthStartContract } from "@okouai/api-contracts/contracts/connectors";
import { customConnectorsContract } from "@okouai/api-contracts/contracts/custom-connectors";
import { userConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import { userPermissionGrantsContract } from "@okouai/api-contracts/contracts/user-permission-grants";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  customConnector,
  getConnectorAction,
  getConnectorCard,
  getConnectorSwitch,
  listAgent,
  mockConnectors,
  mockGithubAccounts,
  mockOAuthCompletions,
  mockPublicConnectorStatus,
  publicStatusItem,
  queryConnectorAction,
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

test("Show account attention when agent access is unavailable", async () => {
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
    status: "reconnect-required",
  });
  context.mocks.api(connectorAccountsContract.summaries, ({ respond }) => {
    return respond(200, {
      summaries: [
        {
          target: account.target,
          accountCount: 2,
          attentionCount: 1,
          defaultConnection: account,
        },
      ],
    });
  });
  context.mocks.data.agents([
    listAgent("c0000000-0000-4000-a000-000000000001", "Research"),
  ]);
  context.mocks.api(userConnectorsContract.get, ({ respond }) => {
    return respond(500, {
      error: { message: "Agent access unavailable", code: "UNAVAILABLE" },
    });
  });
  await setupAccountsPage();

  const card = await waitFor(() => {
    return getConnectorCard("GitHub");
  });
  expect(within(card).getByText("1/2 need attention")).toBeInTheDocument();
  expect(within(card).getByText("Access unavailable")).toBeInTheDocument();
  expect(
    getConnectorAction("button", "Manage GitHub access", card),
  ).toBeDisabled();
});

test("Show when every connector account needs attention", async () => {
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
    status: "reconnect-required",
  });
  context.mocks.api(connectorAccountsContract.summaries, ({ respond }) => {
    return respond(200, {
      summaries: [
        {
          target: account.target,
          accountCount: 2,
          attentionCount: 2,
          defaultConnection: account,
        },
      ],
    });
  });
  await setupAccountsPage();

  const card = await waitFor(() => {
    return getConnectorCard("GitHub");
  });
  expect(within(card).getByText("2/2 need attention")).toBeInTheDocument();
});

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

test("Distinguish unavailable account information from no accounts", async () => {
  mockConnectors(context, []);
  const connector = customConnector();
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: [connector] });
  });
  const summariesReady = context.mocks.deferred<void>();
  context.mocks.api(
    connectorAccountsContract.summaries,
    async ({ respond }) => {
      await summariesReady.promise;
      return respond(404, {
        error: { message: "Account summaries unavailable", code: "NOT_FOUND" },
      });
    },
  );
  await setupAccountsPage();

  const ahrefs = await waitFor(() => {
    return getConnectorCard("Ahrefs");
  });
  expect(within(ahrefs).getByText("Loading accounts…")).toBeInTheDocument();
  expect(within(ahrefs).queryByText("No accounts")).not.toBeInTheDocument();

  summariesReady.resolve();

  await expect(
    within(ahrefs).findByText("Accounts are unavailable for this connector."),
  ).resolves.toBeInTheDocument();
  expect(within(ahrefs).queryByText("No accounts")).not.toBeInTheDocument();
  click(getConnectorAction("tab", "Custom"));
  const custom = await waitFor(() => {
    return getConnectorCard("Acme Search");
  });
  expect(
    within(custom).getByText("Accounts are unavailable for this connector."),
  ).toBeInTheDocument();
  expect(within(custom).queryByText("No accounts")).not.toBeInTheDocument();
});

test("Summarize connector access on its card", async () => {
  const ids = [
    "c0000000-0000-4000-a000-000000000001",
    "c0000000-0000-4000-a000-000000000002",
    "c0000000-0000-4000-a000-000000000003",
    "c0000000-0000-4000-a000-000000000004",
  ];
  const longName = "Research Operations for International Partnerships";
  const enabled = new Map(
    ids.map((id) => {
      return [id, [] as string[]];
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
  context.mocks.api(userConnectorsContract.get, ({ params, respond }) => {
    return respond(200, {
      enabledConnectorSlugs: enabled.get(params.id) ?? [],
    });
  });
  context.mocks.api(
    userConnectorsContract.update,
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

  click(
    getConnectorAction(
      "button",
      "Manage GitHub access",
      getConnectorCard("GitHub"),
    ),
  );
  const reopened = await screen.findByRole("dialog", {
    name: "Manage GitHub access",
  });
  for (const name of ["Support", "Growth", "Ops"]) {
    click(
      await waitFor(() => {
        return getConnectorSwitch(
          `Authorize GitHub access for ${name}`,
          reopened,
        );
      }),
    );
  }
  click(getConnectorAction("button", "Close", reopened));

  await waitFor(() => {
    expect(
      getConnectorAction(
        "button",
        "Manage GitHub access",
        getConnectorCard("GitHub"),
      ),
    ).toHaveTextContent("Used by 4 agents");
  });
  expect(
    getConnectorAction(
      "button",
      "Manage GitHub access",
      getConnectorCard("GitHub"),
    ),
  ).toBeEnabled();
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

test("Discard a pending account deletion when its manager closes", async () => {
  const [connector] = mockConnectors(context, [
    { connectorSlug: "github", externalUsername: "octocat" },
  ]);
  if (!connector) {
    throw new Error("Expected GitHub connector");
  }
  const account = builtinAccount({
    id: connector.id,
    displayName: "Work",
    isDefault: true,
    externalUsername: "octocat",
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
    return respond(200, { connections: [account], nextCursor: null });
  });
  const impactReady = context.mocks.deferred<void>();
  let impactStarted = false;
  context.mocks.api(
    connectorAccountsContract.deletionImpact,
    async ({ params, respond }) => {
      impactStarted = true;
      await impactReady.promise;
      return respond(200, {
        connectionId: params.connectionId,
        explicitSelectionCount: 1,
        hasSibling: false,
      });
    },
  );
  await setupAccountsPage();
  click(
    await waitFor(() => {
      return getConnectorAction("button", "Manage GitHub accounts");
    }),
  );
  const first = await screen.findByRole("dialog", {
    name: "Manage GitHub accounts",
  });
  click(accountActions(first)[0] ?? first);
  click(getConnectorAction("menuitem", "Disconnect"));
  await waitFor(() => {
    return expect(impactStarted).toBeTruthy();
  });

  click(getConnectorAction("button", "Close", first));
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Manage GitHub accounts" }),
    ).not.toBeInTheDocument();
  });
  click(getConnectorAction("button", "Manage GitHub accounts"));
  await screen.findByRole("dialog", { name: "Manage GitHub accounts" });
  impactReady.resolve();

  await waitFor(() => {
    expect(screen.queryByText("Disconnect Work?")).not.toBeInTheDocument();
  });
});

test("Exclude deleted agents from connector access", async () => {
  const activeId = "c0000000-0000-4000-a000-000000000001";
  const deletedId = "c0000000-0000-4000-a000-000000000002";
  mockConnectors(context, [
    { connectorSlug: "github", externalUsername: "octocat" },
  ]);
  context.mocks.data.agents([
    listAgent(activeId, "Research Agent"),
    listAgent(deletedId, "Deleted Agent"),
  ]);
  context.mocks.api(userConnectorsContract.get, ({ params, respond }) => {
    if (params.id === deletedId) {
      return respond(404, {
        error: { message: "Agent not found", code: "NOT_FOUND" },
      });
    }
    return respond(200, { enabledConnectorSlugs: ["github"] });
  });
  context.mocks.api(userPermissionGrantsContract.list, ({ query, respond }) => {
    if (query.agentId === deletedId) {
      return respond(404, {
        error: { message: "Agent not found", code: "NOT_FOUND" },
      });
    }
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
  expect(within(dialog).queryByText("Deleted Agent")).not.toBeInTheDocument();
  expect(
    within(dialog).queryByText("Loading agents..."),
  ).not.toBeInTheDocument();
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
  context.mocks.api(userConnectorsContract.get, ({ params, respond }) => {
    return respond(200, {
      enabledConnectorSlugs: enabled.get(params.id) ?? [],
    });
  });
  context.mocks.api(
    userConnectorsContract.update,
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

test("Reconnect the selected non-default account after cancellation", async () => {
  const completedAttempts = mockOAuthCompletions(context);
  let oauthAttemptId = crypto.randomUUID();
  const agentIds = [
    "c0000000-0000-4000-a000-000000000001",
    "c0000000-0000-4000-a000-000000000002",
  ];
  context.mocks.data.agents(
    agentIds.map((id) => {
      return listAgent(id, id);
    }),
  );
  const authorizedAgents = new Set<string>();
  context.mocks.api(userConnectorsContract.get, ({ params, respond }) => {
    return respond(200, {
      enabledConnectorSlugs: authorizedAgents.has(params.id) ? ["stripe"] : [],
    });
  });
  context.mocks.api(
    userConnectorsContract.update,
    ({ params, body, respond }) => {
      if (
        body.operation === "add" &&
        body.enabledConnectorSlugs.includes("stripe")
      ) {
        authorizedAgents.add(params.id);
      }
      return respond(200, {
        enabledConnectorSlugs: authorizedAgents.has(params.id)
          ? ["stripe"]
          : [],
      });
    },
  );
  const [connector] = mockConnectors(context, [
    {
      connectorSlug: "stripe",
      authMethod: "api-token",
      externalUsername: "work",
    },
  ]);
  if (!connector) {
    throw new Error("Expected Stripe connector");
  }
  const work = builtinAccount({
    id: connector.id,
    slug: "stripe",
    authMethod: "api-token",
    displayName: "Work",
    isDefault: true,
    externalUsername: "work",
  });
  let personal = builtinAccount({
    id: crypto.randomUUID(),
    slug: "stripe",
    displayName: "Personal",
    isDefault: false,
    externalUsername: "personal",
    status: "reconnect-required",
  });
  context.mocks.api(connectorAccountsContract.summaries, ({ respond }) => {
    return respond(200, {
      summaries: [
        {
          target: work.target,
          accountCount: 2,
          attentionCount:
            personal.connectionStatus === "reconnect-required" ? 1 : 0,
          defaultConnection: work,
        },
      ],
    });
  });
  context.mocks.api(
    connectorAccountsContract.connection,
    ({ params, respond }) => {
      if (params.connectionId !== personal.id) {
        return respond(404, {
          error: { message: "Account not found", code: "NOT_FOUND" },
        });
      }
      return respond(200, personal);
    },
  );
  // Register the static collection route after the parameterized item route so
  // `/connections` cannot be interpreted as a connection ID by MSW.
  context.mocks.api(connectorAccountsContract.connections, ({ respond }) => {
    return respond(200, { connections: [work, personal], nextCursor: null });
  });
  let submitted: unknown;
  context.mocks.api(connectorOauthStartContract.start, ({ body, respond }) => {
    submitted = body.account;
    oauthAttemptId = crypto.randomUUID();
    expect(body.authorizeAgent).not.toBeTruthy();
    return respond(200, {
      oauthAttemptId,
      connectionId: personal.id,
      authorizationUrl: "https://oauth.test/stripe/authorize",
    });
  });
  let authWindow = createAuthWindow();
  context.mocks.browser.open(authWindow);
  await setupPage({
    context,
    path: "/connectors?keywords=stripe",
    sharedWorkerTestTransport: "message-port",
  });
  click(
    await waitFor(() => {
      return getConnectorAction("button", "Manage Stripe accounts");
    }),
  );
  const manager = await screen.findByRole("dialog", {
    name: "Manage Stripe accounts",
  });
  const personalRow = await within(manager).findByRole("group", {
    name: "Personal",
  });
  click(getConnectorAction("button", "Reconnect", personalRow));
  const connect = await waitFor(() => {
    const reconnectDialog = screen
      .getAllByRole("dialog", { name: "Stripe" })
      .find((candidate) => {
        return queryConnectorAction("button", "Reconnect", candidate);
      });
    if (!reconnectDialog) {
      throw new Error("Expected Stripe reconnect dialog");
    }
    return reconnectDialog;
  });

  click(getConnectorAction("button", "Reconnect", connect));
  await waitFor(() => {
    expect(authWindow.location.href).toBe(
      "https://oauth.test/stripe/authorize",
    );
  });
  personal = {
    ...personal,
    displayName: "Renamed in another tab",
    updatedAt: "2026-01-01T00:00:00.500Z",
  };
  const cancelledAttemptId = oauthAttemptId;
  authWindow.close();
  await waitFor(() => {
    expect(getConnectorAction("button", "Reconnect", connect)).toBeEnabled();
  });
  expect(connect).toBeInTheDocument();
  expect(getConnectorCard("Stripe")).toHaveTextContent("Add access");

  authWindow = createAuthWindow();
  context.mocks.browser.open(authWindow);
  click(getConnectorAction("button", "Reconnect", connect));

  await waitFor(() => {
    expect(authWindow.location.href).toBe(
      "https://oauth.test/stripe/authorize",
    );
  });
  expect(submitted).toStrictEqual({
    intent: "reconnect",
    connectionId: personal.id,
  });
  personal = {
    ...personal,
    connectionStatus: "connected",
    reconnectReason: null,
    updatedAt: "2026-01-01T00:00:01.000Z",
  };
  expect(oauthAttemptId).not.toBe(cancelledAttemptId);
  completedAttempts.set(oauthAttemptId, personal.id);
  context.mocks.ably.trigger("connector:changed", {
    connectorSlug: "stripe",
  });

  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Stripe" }),
    ).not.toBeInTheDocument();
  });
  expect(
    screen.queryByRole("dialog", { name: "Name your Stripe account" }),
  ).not.toBeInTheDocument();
  expect(
    getConnectorAction("button", "Manage Stripe access"),
  ).toHaveTextContent("Add access");
  click(getConnectorAction("button", "Manage Stripe accounts"));
  const reopenedManager = await screen.findByRole("dialog", {
    name: "Manage Stripe accounts",
  });
  const workRow = within(reopenedManager).getByRole("group", {
    name: "Work",
  });
  expect(within(workRow).getByRole("radio", { name: "Default" })).toBeChecked();
  expect(within(workRow).queryByText("Reconnect required")).toBeNull();
});

test("Rename and disconnect a specific connector account", async () => {
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
  await fill(await within(manager).findByLabelText("Account name"), "Personal");
  click(getConnectorAction("button", "Save", manager));
  await waitFor(() => {
    expect(
      within(
        screen.getByRole("dialog", { name: "Manage GitHub accounts" }),
      ).getByText("Personal"),
    ).toBeInTheDocument();
  });

  click(
    await waitFor(() => {
      const action = accountActions(manager)[0];
      if (!action) {
        throw new Error("Expected Personal account actions");
      }
      return action;
    }),
  );
  click(
    await waitFor(() => {
      return getConnectorAction("menuitem", "Rename");
    }),
  );
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
  context.mocks.api(connectorOauthStartContract.start, ({ body, respond }) => {
    submittedAccount = body.account;
    return respond(200, {
      authorizationUrl: "https://oauth.test/github/authorize",
      oauthAttemptId: crypto.randomUUID(),
    });
  });
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

test("Keep account search results aligned with the latest query", async () => {
  const accounts = mockGithubAccounts(context, 7);
  const stale = {
    ...accounts[0],
    id: crypto.randomUUID(),
    displayName: "Stale result",
    isDefault: false,
  } satisfies ConnectorAccountConnection;
  const staleReady = context.mocks.deferred<void>();
  const staleStarted = context.mocks.deferred<void>();
  const clearStarted = context.mocks.deferred<void>();
  let awaitingClear = false;
  const searches: (string | null)[] = [];
  context.mocks.api(
    connectorAccountsContract.connections,
    async ({ query, respond }) => {
      searches.push(query.search ?? null);
      if (query.search === "Stale") {
        staleStarted.resolve();
        await staleReady.promise;
        return respond(200, { connections: [stale], nextCursor: null });
      }
      if (!query.search && awaitingClear) {
        clearStarted.resolve();
      }
      const filtered = query.search
        ? accounts.filter((account) => {
            return account.displayName
              ?.toLowerCase()
              .includes(query.search?.toLowerCase() ?? "");
          })
        : accounts;
      return respond(200, { connections: filtered, nextCursor: null });
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
  const initialCount = searches.length;

  fireEvent.input(input, { target: { value: "W" } });
  fireEvent.input(input, { target: { value: "Work" } });
  fireEvent.input(input, { target: { value: "Work 2" } });

  await waitFor(() => {
    expect(searches.slice(initialCount)).toStrictEqual(["Work 2"]);
    expect(within(manager).getByText("Work 2")).toBeInTheDocument();
  });

  fireEvent.input(input, { target: { value: "Stale" } });
  await staleStarted.promise;
  awaitingClear = true;
  fireEvent.input(input, { target: { value: "" } });
  await clearStarted.promise;
  staleReady.resolve();
  await waitFor(() => {
    expect(within(manager).queryByText("Stale result")).not.toBeInTheDocument();
    expect(within(manager).getByText("Work 1")).toBeInTheDocument();
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

test("Show one connector account without a contradictory empty state", async () => {
  const accounts = mockGithubAccounts(context, 1);
  context.mocks.api(connectorAccountsContract.connections, ({ respond }) => {
    return respond(200, { connections: accounts, nextCursor: null });
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
    within(manager).findByText("Unnamed account"),
  ).resolves.toBeVisible();
  expect(
    within(manager).queryByText("No accounts found"),
  ).not.toBeInTheDocument();
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
  context.mocks.api(userConnectorsContract.get, ({ respond }) => {
    return respond(200, { enabledConnectorSlugs: ["cloudinary"] });
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
