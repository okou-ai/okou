import {
  connectorAccountsContract,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { customConnectorsContract } from "@okouai/api-contracts/contracts/custom-connectors";
import { customConnectorsReaderContract } from "@okouai/api-contracts/contracts/custom-connector-readers";
import { connectorCatalogReaderContract } from "@okouai/api-contracts/contracts/connector-catalog-readers";
import type { PublicConnectorCatalogStatusItem } from "@okouai/api-contracts/contracts/connector-catalog";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../__tests__/time.ts";
import {
  ACME_CONNECTOR_ID,
  FEISHU_CONNECTOR_ID,
  accountSummary,
  builtinConnector,
  connectorAccount,
  httpConnector,
  installComposerConnectorFixture,
  manualAuthMethod,
  SCOUT_AGENT_ID,
} from "./chat-composer-connectors-test-helpers.ts";
import {
  context,
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";

function savedAccounts(target: ConnectorAccountTarget, expired = false) {
  const defaultAccount = {
    ...connectorAccount({
      id: crypto.randomUUID(),
      target,
      displayName: "Work",
      isDefault: true,
    }),
    connectionStatus: expired
      ? ("reconnect-required" as const)
      : ("connected" as const),
    reconnectReason: expired
      ? ("authorization_expired_or_revoked" as const)
      : null,
  };
  return [
    defaultAccount,
    connectorAccount({
      id: crypto.randomUUID(),
      target,
      displayName: "Personal",
      isDefault: false,
    }),
  ];
}

function acme(connected = false) {
  return httpConnector({
    id: ACME_CONNECTOR_ID,
    slug: "_acme-search",
    displayName: "Acme Search",
    connected,
  });
}

async function openDirectory() {
  const user = userEvent.setup({ delay: null });
  await setupPage({ context, path: `/agents/${SCOUT_AGENT_ID}/chat` });
  await user.click(await findFastControl("button", "Connectors"));
  await user.click(await findFastControl("button", "Add connectors"));
  return screen.findByRole("dialog", { name: "Connectors" });
}

async function openCustom(dialog: HTMLElement) {
  click(await findFastControl("radio", "Custom", dialog));
}

function mockCanonicalBuiltinCatalog(
  catalog: readonly PublicConnectorCatalogStatusItem[],
) {
  const connectors = catalog.map(
    ({
      connected: _connected,
      connection: _connection,
      connectionStatus: _connectionStatus,
      scopeMismatch: _scopeMismatch,
      authMethodSupportsRefresh: _authMethodSupportsRefresh,
      tokenExpiresAt: _tokenExpiresAt,
      ...item
    }) => {
      return item;
    },
  );
  context.mocks.api(
    connectorCatalogReaderContract.get,
    ({ params, respond }) => {
      const connector = connectors.find((item) => {
        return item.slug === params.connectorSlug;
      });
      return connector
        ? respond(200, { connector })
        : respond(404, { error: { code: "NOT_FOUND", message: "Not found" } });
    },
  );
  context.mocks.api(
    connectorCatalogReaderContract.discovery,
    ({ query, respond }) => {
      const keyword = query.keyword?.toLowerCase() ?? "";
      return respond(200, {
        connectors: connectors.filter((item) => {
          return (
            item.slug.includes(keyword) ||
            item.label.toLowerCase().includes(keyword)
          );
        }),
        totalConnectorCount: connectors.length,
      });
    },
  );
}

test("Expired builtin and custom defaults with healthy siblings remain in Needs attention", async () => {
  const builtinTarget = { kind: "builtin", connectorSlug: "github" } as const;
  const customTarget = {
    kind: "custom",
    customConnectorId: ACME_CONNECTOR_ID,
  } as const;
  const builtinAccounts = savedAccounts(builtinTarget, true);
  const customAccounts = savedAccounts(customTarget, true);
  const fixture = installComposerConnectorFixture({
    catalog: [
      builtinConnector({ slug: "github", label: "GitHub", connected: false }),
    ],
    customConnectors: [acme()],
    accountSummaries: [
      accountSummary(builtinTarget, builtinAccounts),
      accountSummary(customTarget, customAccounts),
    ],
    accounts: [...builtinAccounts, ...customAccounts],
  });
  const dialog = await openDirectory();
  await within(dialog).findByText("Needs attention");
  await expect(
    findFastControl("button", "Open GitHub details", dialog),
  ).resolves.toHaveTextContent("1/2 need attention");
  await openCustom(dialog);
  await within(dialog).findByText("Needs attention");
  await expect(
    findFastControl("button", "Connect Acme Search", dialog),
  ).resolves.toHaveTextContent("1/2 need attention");
  expect(fixture.customValueRequests).toStrictEqual([]);
  expect(fixture.customAuthorizationUpdates).toStrictEqual([]);
  expect(fixture.manualConnectionRequests).toStrictEqual([]);
});

test.each(["current", "canonical"] as const)(
  "Healthy saved accounts with %s definitions stay connected while zero-account connectors remain available to add",
  async (definitionShape) => {
    const builtinTarget = { kind: "builtin", connectorSlug: "github" } as const;
    const customTarget = {
      kind: "custom",
      customConnectorId: ACME_CONNECTOR_ID,
    } as const;
    const catalog = [
      builtinConnector({ slug: "github", label: "GitHub" }),
      builtinConnector({ slug: "notion", label: "Notion", connected: false }),
    ];
    installComposerConnectorFixture({
      catalog,
      customConnectors: [acme(true)],
      accountSummaries: [
        accountSummary(builtinTarget, savedAccounts(builtinTarget)),
        accountSummary(customTarget, savedAccounts(customTarget)),
      ],
    });
    if (definitionShape === "canonical") {
      mockCanonicalBuiltinCatalog(catalog);
    }
    const {
      connected: _connected,
      connectedAccountId: _connectedAccountId,
      connectedAccountUpdatedAt: _connectedAccountUpdatedAt,
      missingRequiredFields: _missingRequiredFields,
      configuredFieldKeys: _configuredFieldKeys,
      ...definition
    } = acme(true);
    context.mocks.api(customConnectorsReaderContract.list, ({ respond }) => {
      return respond(200, {
        connectors: [definitionShape === "canonical" ? definition : acme(true)],
      });
    });
    const dialog = await openDirectory();
    await within(dialog).findByText("Notion");
    expect(within(dialog).queryByText("GitHub")).toBeNull();
    await fill(
      within(dialog).getByPlaceholderText("Find connectors..."),
      "github",
    );
    await expect(
      findFastControl("button", "Open GitHub details", dialog),
    ).resolves.toHaveTextContent("+1");
    await fill(within(dialog).getByPlaceholderText("Find connectors..."), "");
    await openCustom(dialog);
    await expect(
      findFastControl("button", "Connect Acme Search", dialog),
    ).resolves.toHaveTextContent("2 accounts");
    expect(within(dialog).queryByText("Needs attention")).toBeNull();
    expect(within(dialog).queryByText("Reconnect required")).toBeNull();
  },
);

async function openExpiringBuiltinDirectory(
  refreshable: boolean,
  shape: "current" | "canonical" | "conflicting",
) {
  const clock = { nowMs: new Date("2026-10-19T08:00:00.000Z").getTime() };
  mockNow(() => {
    return clock.nowMs;
  }, context.signal);
  const target = { kind: "builtin", connectorSlug: "github" } as const;
  const tokenExpiresAt = new Date(clock.nowMs + 60_000).toISOString();
  const catalog = builtinConnector({ slug: "github", label: "GitHub" });
  const account = {
    ...connectorAccount({
      id: catalog.connection!.id!,
      target,
      displayName: "Work",
      isDefault: true,
    }),
    tokenExpiresAt,
  };
  const accounts = [
    account,
    connectorAccount({
      id: crypto.randomUUID(),
      target,
      displayName: "Personal",
      isDefault: false,
    }),
  ];
  const response = {
    ...catalog,
    authMethods: catalog.authMethods.map((method) => {
      return {
        ...method,
        ...(shape === "current" ? {} : { supportsRefresh: refreshable }),
      };
    }),
    authMethodSupportsRefresh:
      shape === "conflicting" ? !refreshable : refreshable,
    tokenExpiresAt:
      shape === "conflicting" ? "2000-01-01T00:00:00Z" : tokenExpiresAt,
  };
  installComposerConnectorFixture({
    catalog: [response],
    accounts,
    accountSummaries: [accountSummary(target, accounts)],
  });
  if (shape === "canonical") {
    mockCanonicalBuiltinCatalog([response]);
  }
  const directory = await openDirectory();
  const search = within(directory).getByPlaceholderText("Find connectors...");
  await fill(search, "github");
  return { directory, search, clock };
}

test.each([true, false])(
  "Canonical scope mismatch %s overrides the opposite catalog projection",
  async (scopeMismatch) => {
    const target = { kind: "builtin", connectorSlug: "github" } as const;
    const catalog = builtinConnector({ slug: "github", label: "GitHub" });
    const account = {
      ...connectorAccount({
        id: catalog.connection!.id!,
        target,
        displayName: "Work",
        isDefault: true,
      }),
      scopeMismatch,
    };
    installComposerConnectorFixture({
      catalog: [{ ...catalog, scopeMismatch: !scopeMismatch }],
      accounts: [account],
      accountSummaries: [accountSummary(target, [account])],
    });
    const directory = await openDirectory();
    await fill(
      within(directory).getByPlaceholderText("Find connectors..."),
      "github",
    );
    const card = await findFastControl(
      "button",
      "Open GitHub details",
      directory,
    );
    expect(card).toHaveTextContent(
      scopeMismatch ? "Update permissions" : "Work",
    );
  },
);

test.each(["scope", "refresh"] as const)(
  "Missing canonical %s facts cannot borrow a different account's catalog projection",
  async (missingFact) => {
    const target = { kind: "builtin", connectorSlug: "github" } as const;
    const account = {
      ...connectorAccount({
        id: crypto.randomUUID(),
        target,
        displayName: "Work",
        isDefault: true,
      }),
      scopeMismatch: missingFact === "scope" ? undefined : false,
      tokenExpiresAt: missingFact === "refresh" ? "2099-01-01T00:00:00Z" : null,
    };
    const fixture = installComposerConnectorFixture({
      catalog: [builtinConnector({ slug: "github", label: "GitHub" })],
      accounts: [account],
      accountSummaries: [accountSummary(target, [account])],
    });
    const directory = await openDirectory();
    const card = await findFastControl(
      "button",
      "Open GitHub details",
      directory,
    );
    expect(card).toHaveTextContent("Account status unavailable");
    click(card);
    await findFastControl("link", "Manage GitHub accounts", directory);
    expect(queryFastControl("button", "Connect", directory)).toBeNull();
    expect(queryFastControl("button", "Reconnect", directory)).toBeNull();
    expect(fixture.oauthConnectionRequests).toStrictEqual([]);
  },
);

test.each(["current", "canonical", "conflicting"] as const)(
  "An open directory recognizes expiry of a saved non-refreshable builtin default with %s metadata",
  async (shape) => {
    const { directory, search, clock } = await openExpiringBuiltinDirectory(
      false,
      shape,
    );
    await expect(
      findFastControl("button", "Open GitHub details", directory),
    ).resolves.toHaveTextContent("Work");
    clock.nowMs += 120_000;
    await fill(search, "git");
    await within(directory).findByText("Needs attention");
    const expired = await findFastControl(
      "button",
      "Open GitHub details",
      directory,
    );
    expect(expired).toHaveTextContent("Connection expired");
    expect(expired).toHaveTextContent("1/2 need attention");
    await fill(search, "github");
    const current = await findFastControl(
      "button",
      "Open GitHub details",
      directory,
    );
    expect(current).toHaveTextContent("1/2 need attention");
    click(current);
    await expect(
      findFastControl("button", "Reconnect", directory),
    ).resolves.toBeEnabled();
  },
);

test.each(["current", "canonical", "conflicting"] as const)(
  "An open directory keeps a saved refreshable builtin default usable after token expiry with %s metadata",
  async (shape) => {
    const { directory, search, clock } = await openExpiringBuiltinDirectory(
      true,
      shape,
    );
    await expect(
      findFastControl("button", "Open GitHub details", directory),
    ).resolves.toHaveTextContent("Work");
    clock.nowMs += 120_000;
    await fill(search, "git");
    await expect(
      findFastControl("button", "Open GitHub details", directory),
    ).resolves.toHaveTextContent("Work");
    expect(within(directory).queryByText("Needs attention")).toBeNull();
  },
);

test("A saved custom account with incomplete setup is visible without claiming it is ready", async () => {
  const target = {
    kind: "custom",
    customConnectorId: ACME_CONNECTOR_ID,
  } as const;
  installComposerConnectorFixture({
    customConnectors: [acme()],
    accountSummaries: [
      {
        ...accountSummary(
          target,
          savedAccounts(target).map((account) => {
            return account.isDefault
              ? {
                  ...account,
                  setupStatus: "incomplete" as const,
                  missingRequiredFields: ["secret"],
                }
              : account;
          }),
        ),
        attentionCount: 1,
      },
    ],
  });
  const dialog = await openDirectory();
  await openCustom(dialog);
  await within(dialog).findByText("Needs attention");
  const card = await findFastControl("button", "Connect Acme Search", dialog);
  expect(card).toHaveTextContent("1/2 need attention");
});

test("Connecting a custom account updates the directory when it is reopened", async () => {
  installComposerConnectorFixture({ customConnectors: [acme()] });
  const directory = await openDirectory();
  await openCustom(directory);
  const card = await findFastControl(
    "button",
    "Connect Acme Search",
    directory,
  );
  expect(card).toHaveTextContent("No accounts");
  click(card);
  const connect = await screen.findByRole("dialog", {
    name: "Connect Acme Search",
  });
  await fill(within(connect).getByLabelText("Secret"), "replacement-secret");
  click(await findFastControl("button", "Save", connect));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  if (!queryFastControl("button", "Add connectors")) {
    click(await findFastControl("button", "Connectors"));
  }
  click(await findFastControl("button", "Add connectors"));
  const reopened = await screen.findByRole("dialog", { name: "Connectors" });
  await openCustom(reopened);
  await expect(
    findFastControl("button", "Connect Acme Search", reopened),
  ).resolves.toHaveTextContent("Unnamed account");
  expect(within(reopened).queryByText("No accounts")).toBeNull();
});

test("Realtime custom account expiry refreshes the directory attention state", async () => {
  const target = {
    kind: "custom",
    customConnectorId: ACME_CONNECTOR_ID,
  } as const;
  const healthyAccounts = savedAccounts(target);
  const expiredAccounts = [
    {
      ...healthyAccounts[0]!,
      connectionStatus: "reconnect-required" as const,
      reconnectReason: "authorization_expired_or_revoked" as const,
    },
    healthyAccounts[1]!,
  ];
  let expired = false;
  installComposerConnectorFixture({ customConnectors: [acme(true)] });
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: [acme(!expired)] });
  });
  context.mocks.api(connectorAccountsContract.summaries, ({ respond }) => {
    return respond(200, {
      summaries: [
        accountSummary(target, expired ? expiredAccounts : healthyAccounts),
      ],
    });
  });
  const directory = await openDirectory();
  await openCustom(directory);
  await expect(
    findFastControl("button", "Connect Acme Search", directory),
  ).resolves.toHaveTextContent("2 accounts");
  expect(within(directory).queryByText("Needs attention")).toBeNull();
  expired = true;
  context.mocks.ably.trigger("customConnectorListChanged");
  await within(directory).findByText("Needs attention");
  await expect(
    findFastControl("button", "Connect Acme Search", directory),
  ).resolves.toHaveTextContent("1/2 need attention");
});

test("Pending account summaries do not expose an ordinary add action as if no account exists", async () => {
  const gate = context.mocks.deferred<void>();
  installComposerConnectorFixture({
    customConnectors: [acme()],
    accountSummaries: [],
  });
  context.mocks.api(
    connectorAccountsContract.summaries,
    async ({ respond }) => {
      await gate.promise;
      return respond(200, { summaries: [] });
    },
  );
  const dialog = await openDirectory();
  await openCustom(dialog);
  await within(dialog).findByText("Loading connectors…");
  expect(queryFastControl("button", "Connect Acme Search", dialog)).toBeNull();
  expect(within(dialog).queryByText("No accounts")).toBeNull();
  gate.resolve();
  await expect(
    findFastControl("button", "Connect Acme Search", dialog),
  ).resolves.toHaveTextContent("No accounts");
});

test("Account-summary failure is retryable and leaves managed Feishu in its own lifecycle", async () => {
  const target = {
    kind: "custom",
    customConnectorId: ACME_CONNECTOR_ID,
  } as const;
  const summary = accountSummary(target, savedAccounts(target));
  const fixture = installComposerConnectorFixture({
    customConnectors: [
      acme(),
      httpConnector({
        id: FEISHU_CONNECTOR_ID,
        slug: "_feishu",
        displayName: "Feishu",
        connected: true,
        authMode: "oauth",
        providerAdapter: "feishu",
      }),
    ],
    accountSummaries: [summary],
  });
  context.mocks.api(connectorAccountsContract.summaries, ({ respond }) => {
    return respond(500, {
      error: { code: "INTERNAL_ERROR", message: "Summaries unavailable" },
    });
  });
  const dialog = await openDirectory();
  await within(dialog).findByText(
    "Accounts are unavailable for this connector.",
  );
  await openCustom(dialog);
  await findFastControl("button", "Connect Feishu", dialog);
  expect(queryFastControl("button", "Connect Acme Search", dialog)).toBeNull();
  expect(within(dialog).queryByText("No accounts")).toBeNull();
  context.mocks.api(connectorAccountsContract.summaries, ({ respond }) => {
    return respond(200, { summaries: [summary] });
  });
  click(await findFastControl("button", "Try again", dialog));
  await findFastControl("button", "Connect Acme Search", dialog);
  expect(fixture.customAuthorizationUpdates).toStrictEqual([]);
});

test("Custom definition failure keeps an explicit retry instead of an empty directory", async () => {
  const connector = acme();
  installComposerConnectorFixture({ customConnectors: [connector] });
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(500, {
      error: { code: "INTERNAL_ERROR", message: "Definitions unavailable" },
    });
  });
  const dialog = await openDirectory();
  await openCustom(dialog);
  await within(dialog).findByText("Couldn't load custom connectors.");
  expect(queryFastControl("button", "Connect Acme Search", dialog)).toBeNull();
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: [connector] });
  });
  click(await findFastControl("button", "Try again", dialog));
  await findFastControl("button", "Connect Acme Search", dialog);
});

test("A builtin summary with no default sends the user to account management without inventing an account", async () => {
  const target = { kind: "builtin", connectorSlug: "github" } as const;
  const accounts = savedAccounts(target).map((account) => {
    return { ...account, isDefault: false };
  });
  const fixture = installComposerConnectorFixture({
    catalog: [
      builtinConnector({ slug: "github", label: "GitHub", connected: false }),
    ],
    accountSummaries: [accountSummary(target, accounts)],
    accounts,
  });
  const dialog = await openDirectory();
  click(await findFastControl("button", "Open GitHub details", dialog));
  const manage = await findFastControl(
    "link",
    "Manage GitHub accounts",
    dialog,
  );
  expect(manage).toHaveAttribute("href", "/connectors");
  expect(queryFastControl("button", "Connect", dialog)).toBeNull();
  expect(fixture.oauthConnectionRequests).toStrictEqual([]);
});

test("An empty summary with a stale builtin account identity keeps account management available", async () => {
  const fixture = installComposerConnectorFixture({
    catalog: [
      builtinConnector({
        slug: "github",
        label: "GitHub",
        authMethods: [manualAuthMethod()],
      }),
    ],
    accountSummaries: [],
  });
  const directory = await openDirectory();
  click(await findFastControl("button", "Connect GitHub", directory));
  const manage = await findFastControl("link", "Manage GitHub accounts");
  expect(manage).toHaveAttribute("href", "/connectors");
  expect(screen.getByText("No accounts")).toBeInTheDocument();
  expect(fixture.manualConnectionRequests).toStrictEqual([]);
});

test.each([true, false])(
  "Conflicting builtin credential snapshots keep an account-management action (summary expired: %s)",
  async (expired) => {
    const target = { kind: "builtin", connectorSlug: "github" } as const;
    const accounts = savedAccounts(target, expired);
    const catalog = builtinConnector({ slug: "github", label: "GitHub" });
    const fixture = installComposerConnectorFixture({
      catalog: [
        {
          ...catalog,
          connected: expired,
          connectionStatus: expired ? "connected" : "reconnect-required",
          connection: {
            ...catalog.connection!,
            id: accounts[0]!.id,
            reconnectReason: expired
              ? null
              : "authorization_expired_or_revoked",
          },
        },
      ],
      accountSummaries: [accountSummary(target, accounts)],
      accounts,
    });
    const dialog = await openDirectory();
    await fill(
      within(dialog).getByPlaceholderText("Find connectors..."),
      "github",
    );
    click(await findFastControl("button", "Open GitHub details", dialog));
    const manage = await findFastControl(
      "link",
      "Manage GitHub accounts",
      dialog,
    );
    expect(manage).toHaveAttribute("href", "/connectors");
    expect(queryFastControl("button", "Connect", dialog)).toBeNull();
    expect(queryFastControl("button", "Reconnect", dialog)).toBeNull();
    expect(fixture.oauthConnectionRequests).toStrictEqual([]);
  },
);
