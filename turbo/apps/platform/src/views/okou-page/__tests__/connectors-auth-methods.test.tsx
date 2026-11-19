import {
  type ConnectorAccountConnection,
  connectorAccountsContract,
} from "@okouai/api-contracts/contracts/connector-accounts";
import {
  connectorCatalogContract,
  type PublicConnectorCatalogAuthMethodDetail,
  type PublicConnectorCatalogStatusItem,
} from "@okouai/api-contracts/contracts/connector-catalog";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import {
  builtinConnectorAutomaticContract,
  builtinConnectorExternalCodeSessionContract,
  builtinConnectorManualGrantContract,
  builtinConnectorOauthDeviceAuthSessionContract,
  builtinConnectorOauthStartContract,
  builtinConnectorOpenIdStartContract,
} from "@okouai/api-contracts/contracts/connectors";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getConnectorAction,
  getConnectorCard,
  getConnectorIcon,
  mockOAuthCompletions,
  mockSavedConnectorAccounts,
  publicStatusItem,
  queryConnectorAction,
} from "./connector-page-test-helpers.ts";

const context = testContext();

function method(
  detail: Pick<PublicConnectorCatalogAuthMethodDetail, "id" | "grantKind"> &
    Partial<PublicConnectorCatalogAuthMethodDetail>,
): PublicConnectorCatalogAuthMethodDetail {
  return {
    label: detail.id,
    description: null,
    supportsRefresh: true,
    manualFields: [],
    startOptions: [],
    ...detail,
  };
}

function ahrefsToken(): PublicConnectorCatalogAuthMethodDetail {
  return method({
    id: "api-token",
    label: "API Token",
    grantKind: "manual",
    supportsRefresh: false,
    manualFields: [
      {
        id: "apiToken",
        label: "API token",
        required: true,
        placeholder: "Paste the Ahrefs API token",
        inputType: "password",
      },
    ],
  });
}

function mockCatalog(items: readonly PublicConnectorCatalogStatusItem[]): void {
  context.mocks.api(connectorCatalogContract.discovery, ({ respond }) => {
    return respond(200, {
      connectors: [...items],
      totalConnectorCount: items.length,
    });
  });
}

/** Saved accounts behind the connected list and the single-account read. */
function mockAccountStore() {
  const accounts: ConnectorAccountConnection[] = [];
  mockSavedConnectorAccounts(context, () => {
    return accounts;
  });
  context.mocks.api(
    connectorAccountsContract.connection,
    ({ params, respond }) => {
      const account = accounts.find((candidate) => {
        return candidate.id === params.connectionId;
      });
      return account
        ? respond(200, account)
        : respond(404, {
            error: { code: "NOT_FOUND", message: "Account not found" },
          });
    },
  );
  return {
    accounts,
    add: (
      connectorSlug: ConnectorSlug,
      overrides: Partial<Omit<ConnectorAccountConnection, "target">> = {},
    ): ConnectorAccountConnection => {
      const account: ConnectorAccountConnection = {
        id: crypto.randomUUID(),
        target: { kind: "builtin", connectorSlug },
        authMethod: "oauth",
        displayName: null,
        isDefault: accounts.length === 0,
        externalId: null,
        externalUsername: null,
        externalEmail: null,
        oauthScopes: null,
        connectionStatus: "connected",
        missingRequiredFields: [],
        configuredFieldKeys: [],
        reconnectReason: null,
        tokenExpiresAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        ...overrides,
      };
      accounts.push(account);
      // The API announces every saved connection on the realtime channel.
      queueMicrotask(() => {
        context.mocks.ably.trigger("connector:changed", { connectorSlug });
      });
      return account;
    },
  };
}

/** The provider window the app opens for browser authorization. */
function mockAuthorizationWindow(closed: boolean) {
  const authWindow = context.mocks.browser.authWindow();
  authWindow.closed = closed;
  Object.defineProperty(authWindow, "location", {
    value: { href: "" },
    configurable: true,
  });
  const opened = context.mocks.browser.open(authWindow);
  return { authWindow, opened };
}

async function connectFromCard(label: string): Promise<void> {
  const action = await waitFor(() => {
    const candidate = getConnectorAction("button", `Connect ${label}`);
    expect(candidate).toBeEnabled();
    return candidate;
  });
  click(action);
}

async function skipAccountName(label: string): Promise<void> {
  const naming = await screen.findByRole("dialog", {
    name: `Name your ${label} account`,
  });
  click(getConnectorAction("button", "Skip", naming));
  await waitFor(() => {
    expect(naming).not.toBeInTheDocument();
  });
}

async function expectConnected(label: string): Promise<void> {
  await waitFor(() => {
    const card = getConnectorCard(label);
    expect(within(card).getByText("Connected")).toBeInTheDocument();
    expect(
      queryConnectorAction("button", `Manage ${label} accounts`, card),
    ).toBeEnabled();
  });
}

async function addAhrefsAccount(token: string): Promise<HTMLElement> {
  const dialog = await screen.findByRole("dialog", { name: "Ahrefs" });
  await fill(
    within(dialog).getByPlaceholderText("Paste the Ahrefs API token"),
    token,
  );
  click(getConnectorAction("button", "Save", dialog));
  return await screen.findByRole("dialog", {
    name: "Name your Ahrefs account",
  });
}

test("Connect a builtin Automatic method resolving to oauth", async () => {
  mockCatalog([
    publicStatusItem({
      connectorSlug: "hubspot",
      label: "Public HubSpot",
      authMethods: [method({ id: "oauth", grantKind: "automatic" })],
    }),
  ]);
  const store = mockAccountStore();
  const completions = mockOAuthCompletions(context);
  const authorizationUrl = "https://hubspot.test/oauth/authorize";
  context.mocks.api(
    builtinConnectorAutomaticContract.start,
    ({ params, respond }) => {
      const oauthAttemptId = crypto.randomUUID();
      completions.set(oauthAttemptId, store.add(params.connectorSlug).id);
      return respond(200, {
        result: "authorization",
        authorizationUrl,
        oauthAttemptId,
      });
    },
  );
  const { authWindow } = mockAuthorizationWindow(true);
  await setupPage({ context, path: "/connectors" });

  await connectFromCard("Public HubSpot");

  await skipAccountName("Public HubSpot");
  expect(authWindow.location.href).toBe(authorizationUrl);
  await expectConnected("Public HubSpot");
});

test("Show Mercury disclosures before connecting an account", async () => {
  mockCatalog([
    publicStatusItem({
      connectorSlug: "mercury",
      label: "Mercury",
      authMethods: [
        method({
          id: "api-token",
          grantKind: "manual",
          manualFields: [
            {
              id: "apiToken",
              label: "API token",
              required: true,
              placeholder: "Paste the Mercury API token",
              inputType: "password",
            },
          ],
        }),
      ],
    }),
  ]);
  mockAccountStore();
  await setupPage({ context, path: "/connectors" });

  const disclosure =
    "Mercury is a fintech company, not an FDIC-insured bank. Banking services provided through Choice Financial Group and Column N.A., Members FDIC.";
  const card = await waitFor(() => {
    return getConnectorCard("Mercury");
  });
  expect(
    getConnectorAction("link", "Powered by Mercury", card),
  ).toHaveAttribute("href", "https://mercury.com");
  expect(within(card).getByText(disclosure)).toBeInTheDocument();

  await connectFromCard("Mercury");

  const dialog = await screen.findByRole("dialog", { name: "Mercury" });
  expect(
    getConnectorAction("link", "Powered by Mercury", dialog),
  ).toHaveAttribute("href", "https://mercury.com");
  expect(within(dialog).getByText(disclosure)).toBeInTheDocument();
});

test("Add an AWS account through external-code authorization", async () => {
  mockCatalog([
    publicStatusItem({
      connectorSlug: "aws",
      label: "AWS",
      authMethods: [
        method({
          id: "cli",
          label: "Sign in with AWS",
          description:
            "Sign in with AWS and paste the authorization code. This temporary AWS connector expires after up to 12 hours.",
          grantKind: "external-code",
        }),
      ],
    }),
  ]);
  const store = mockAccountStore();
  const sessionId = crypto.randomUUID();
  const authorizationUrl = "https://aws.test/sign-in";
  context.mocks.api(
    builtinConnectorExternalCodeSessionContract.create,
    ({ params, respond }) => {
      return respond(200, {
        sessionId,
        sessionToken: "aws-session-token",
        connectorSlug: params.connectorSlug,
        status: "pending",
        authorizationUrl,
        expiresIn: 600,
      });
    },
  );
  const codes: string[] = [];
  context.mocks.api(
    builtinConnectorExternalCodeSessionContract.complete,
    ({ body, params, respond }) => {
      codes.push(body.code);
      const account = store.add(params.connectorSlug, { authMethod: "cli" });
      return respond(200, { status: "complete", connectionId: account.id });
    },
  );
  const { opened } = mockAuthorizationWindow(false);
  await setupPage({ context, path: "/connectors" });

  await connectFromCard("AWS");
  const dialog = await screen.findByRole("dialog", { name: "AWS" });
  expect(
    within(dialog).getByText(
      /This temporary AWS connector expires after up to 12 hours\./u,
    ),
  ).toBeInTheDocument();
  click(getConnectorAction("button", "Start AWS sign-in", dialog));
  click(
    await waitFor(() => {
      return getConnectorAction("button", "Open AWS sign-in", dialog);
    }),
  );
  await waitFor(() => {
    expect(opened.calls.at(-1)?.url).toBe(authorizationUrl);
  });
  await fill(within(dialog).getByPlaceholderText("Code"), "aws-code");
  click(getConnectorAction("button", "Complete connection", dialog));

  await skipAccountName("AWS");
  expect(codes).toStrictEqual(["aws-code"]);
  expect(dialog).not.toBeInTheDocument();
  await expectConnected("AWS");
});

test("Add an account through OpenID", async () => {
  const icon = {
    url: "https://icons.example.test/partner-steam.svg",
    invertInDarkMode: false,
  };
  mockCatalog([
    publicStatusItem({
      connectorSlug: "steam",
      label: "Partner Steam",
      icon,
      authMethods: [method({ id: "openid", grantKind: "openid-auth" })],
    }),
  ]);
  const store = mockAccountStore();
  const completions = mockOAuthCompletions(context);
  const authorizationUrl = "https://steamcommunity.test/openid/login";
  context.mocks.api(
    builtinConnectorOpenIdStartContract.start,
    ({ params, respond }) => {
      const oauthAttemptId = crypto.randomUUID();
      completions.set(
        oauthAttemptId,
        store.add(params.connectorSlug, { authMethod: "openid" }).id,
      );
      return respond(200, { authorizationUrl, oauthAttemptId });
    },
  );
  const { authWindow } = mockAuthorizationWindow(true);
  await setupPage({ context, path: "/connectors" });

  await waitFor(() => {
    expect(getConnectorIcon("Partner Steam")).toHaveAttribute("src", icon.url);
  });
  await connectFromCard("Partner Steam");

  await skipAccountName("Partner Steam");
  expect(authWindow.location.href).toBe(authorizationUrl);
  await expectConnected("Partner Steam");
});

test("Reject device-auth completion when account setup is configuration_invalid", async () => {
  mockCatalog([
    publicStatusItem({
      connectorSlug: "base44",
      label: "Base44",
      authMethods: [method({ id: "oauth", grantKind: "device-auth" })],
    }),
  ]);
  const store = mockAccountStore();
  const sessionId = crypto.randomUUID();
  context.mocks.api(
    builtinConnectorOauthDeviceAuthSessionContract.create,
    ({ params, respond }) => {
      return respond(200, {
        sessionId,
        sessionToken: "base44-session-token",
        connectorSlug: params.connectorSlug,
        status: "pending",
        userCode: "BASE-4444",
        verificationUri: "https://base44.test/device",
        expiresIn: 300,
        interval: 1,
      });
    },
  );
  context.mocks.api(
    builtinConnectorOauthDeviceAuthSessionContract.poll,
    ({ params, respond }) => {
      const account = store.add(params.connectorSlug, {
        connectionStatus: "reconnect-required",
        reconnectReason: "configuration_invalid",
      });
      return respond(200, { status: "complete", connectionId: account.id });
    },
  );
  await setupPage({ context, path: "/connectors" });

  await connectFromCard("Base44");
  const dialog = await screen.findByRole("dialog", { name: "Base44" });
  click(getConnectorAction("button", "Connect Base44", dialog));

  const alert = await within(dialog).findByRole("alert");
  expect(alert).toHaveTextContent(
    /This account needs additional setup\. Review its connector settings and try again\./u,
  );
  expect(
    screen.queryByRole("dialog", { name: "Name your Base44 account" }),
  ).toBeNull();
  expect(store.accounts).toHaveLength(1);
});

test("Follow provider-authored external-code instructions", async () => {
  mockCatalog([
    publicStatusItem({
      connectorSlug: "playstation",
      label: "PlayStation",
      authMethods: [
        method({
          id: "api",
          label: "PlayStation sign-in",
          description:
            "Sign in at [PlayStation](https://www.playstation.com/), then paste the npsso value.",
          grantKind: "external-code",
        }),
      ],
    }),
  ]);
  mockAccountStore();
  context.mocks.api(
    builtinConnectorExternalCodeSessionContract.create,
    ({ params, respond }) => {
      return respond(200, {
        sessionId: crypto.randomUUID(),
        sessionToken: "playstation-session-token",
        connectorSlug: params.connectorSlug,
        status: "pending",
        authorizationUrl: "https://ca.account.sony.test/sign-in",
        expiresIn: 600,
      });
    },
  );
  await setupPage({ context, path: "/connectors" });

  await connectFromCard("PlayStation");
  const dialog = await screen.findByRole("dialog", { name: "PlayStation" });
  click(getConnectorAction("button", "Start PlayStation sign-in", dialog));

  await waitFor(() => {
    expect(
      getConnectorAction("button", "Open PlayStation sign-in", dialog),
    ).toBeEnabled();
  });
  expect(getConnectorAction("link", "PlayStation", dialog)).toHaveAttribute(
    "href",
    "https://www.playstation.com/",
  );
  expect(within(dialog).getByPlaceholderText("Code")).toHaveValue("");
});

test("Complete OAuth only after the current attempt succeeds", async () => {
  mockCatalog([
    publicStatusItem({
      connectorSlug: "stripe",
      label: "Public Stripe",
      authMethods: [
        method({ id: "oauth", label: "OAuth", grantKind: "auth-code" }),
        method({
          id: "cli",
          label: "Sign in with Stripe",
          grantKind: "device-auth",
        }),
      ],
    }),
  ]);
  const store = mockAccountStore();
  const completions = mockOAuthCompletions(context);
  const attempts: string[] = [];
  context.mocks.api(
    builtinConnectorOauthStartContract.start,
    ({ params, respond }) => {
      const oauthAttemptId = crypto.randomUUID();
      attempts.push(oauthAttemptId);
      if (attempts.length === 2) {
        completions.set(oauthAttemptId, store.add(params.connectorSlug).id);
      }
      return respond(200, {
        authorizationUrl: `https://stripe.test/oauth/${attempts.length}`,
        oauthAttemptId,
      });
    },
  );
  const { authWindow } = mockAuthorizationWindow(false);
  await setupPage({ context, path: "/connectors" });

  await connectFromCard("Public Stripe");
  const dialog = await screen.findByRole("dialog", { name: "Public Stripe" });
  click(getConnectorAction("button", "Connect", dialog));
  await waitFor(() => {
    expect(authWindow.location.href).toBe("https://stripe.test/oauth/1");
  });
  authWindow.closed = true;

  await waitFor(() => {
    expect(getConnectorAction("button", "Connect", dialog)).toBeEnabled();
  });
  expect(store.accounts).toStrictEqual([]);
  expect(dialog).toBeInTheDocument();

  click(getConnectorAction("button", "Connect", dialog));

  await skipAccountName("Public Stripe");
  expect(attempts).toHaveLength(2);
  expect(authWindow.location.href).toBe("https://stripe.test/oauth/2");
  expect(dialog).not.toBeInTheDocument();
  await expectConnected("Public Stripe");
});

test("Keep the new account name after a failed save and close on retry", async () => {
  mockCatalog([
    publicStatusItem({
      connectorSlug: "ahrefs",
      label: "Ahrefs",
      authMethods: [ahrefsToken()],
    }),
  ]);
  const store = mockAccountStore();
  context.mocks.api(
    builtinConnectorManualGrantContract.connect,
    ({ params, respond }) => {
      const account = store.add(params.connectorSlug, {
        authMethod: "api-token",
      });
      return respond(200, { connectionId: account.id });
    },
  );
  const renames: { connectionId: string; displayName: string | null }[] = [];
  context.mocks.api(
    connectorAccountsContract.rename,
    ({ params, body, respond }) => {
      renames.push({
        connectionId: params.connectionId,
        displayName: body.displayName,
      });
      if (renames.length === 1) {
        return respond(500, {
          error: { code: "INTERNAL_SERVER_ERROR", message: "Rename failed" },
        });
      }
      const account = store.accounts.find((candidate) => {
        return candidate.id === params.connectionId;
      });
      if (!account) {
        throw new Error("Expected the newly added Ahrefs account");
      }
      return respond(200, { ...account, displayName: body.displayName });
    },
  );
  await setupPage({ context, path: "/connectors" });

  await connectFromCard("Ahrefs");
  const naming = await addAhrefsAccount("ahrefs-token");
  const name = within(naming).getByRole("textbox");
  await fill(name, " Work ");
  click(getConnectorAction("button", "Save", naming));

  await expect(screen.findByText("Rename failed")).resolves.toBeInTheDocument();
  expect(naming).toBeInTheDocument();
  expect(name).toHaveValue(" Work ");

  click(getConnectorAction("button", "Save", naming));

  await waitFor(() => {
    expect(naming).not.toBeInTheDocument();
  });
  expect(renames).toStrictEqual([
    { connectionId: store.accounts[0]!.id, displayName: "Work" },
    { connectionId: store.accounts[0]!.id, displayName: "Work" },
  ]);
});

test("Keep a replacement account name prompt when an earlier save completes", async () => {
  mockCatalog([
    publicStatusItem({
      connectorSlug: "ahrefs",
      label: "Ahrefs",
      authMethods: [ahrefsToken()],
    }),
  ]);
  const store = mockAccountStore();
  context.mocks.api(
    builtinConnectorManualGrantContract.connect,
    ({ params, respond }) => {
      const account = store.add(params.connectorSlug, {
        authMethod: "api-token",
      });
      return respond(200, { connectionId: account.id });
    },
  );
  const firstSave = context.mocks.deferred<void>();
  const renames: { connectionId: string; displayName: string | null }[] = [];
  context.mocks.api(
    connectorAccountsContract.rename,
    async ({ params, body, respond }) => {
      await firstSave.promise;
      const account = store.accounts.find((candidate) => {
        return candidate.id === params.connectionId;
      });
      if (!account) {
        throw new Error("Expected a newly added Ahrefs account");
      }
      account.displayName = body.displayName;
      renames.push({
        connectionId: params.connectionId,
        displayName: body.displayName,
      });
      return respond(200, account);
    },
  );
  await setupPage({ context, path: "/connectors" });

  await connectFromCard("Ahrefs");
  const firstPrompt = await addAhrefsAccount("first-token");
  await fill(within(firstPrompt).getByRole("textbox"), "First account");
  click(getConnectorAction("button", "Save", firstPrompt));
  click(getConnectorAction("button", "Skip", firstPrompt));
  await waitFor(() => {
    expect(firstPrompt).not.toBeInTheDocument();
  });

  click(
    await waitFor(() => {
      return getConnectorAction("button", "Manage Ahrefs accounts");
    }),
  );
  const manager = await screen.findByRole("dialog", {
    name: "Manage Ahrefs accounts",
  });
  click(getConnectorAction("button", "Add account", manager));
  const secondPrompt = await addAhrefsAccount("second-token");
  const draft = within(secondPrompt).getByRole("textbox");
  await fill(draft, "Second account draft");
  expect(getConnectorAction("button", "Save", secondPrompt)).toBeDisabled();

  firstSave.resolve();

  await waitFor(() => {
    expect(renames).toStrictEqual([
      { connectionId: store.accounts[0]!.id, displayName: "First account" },
    ]);
    expect(getConnectorAction("button", "Save", secondPrompt)).toBeEnabled();
  });
  expect(secondPrompt).toBeInTheDocument();
  expect(draft).toHaveValue("Second account draft");
});

test("Submit a chosen device-authorization start option", async () => {
  mockCatalog([
    publicStatusItem({
      connectorSlug: "stripe",
      label: "Stripe",
      authMethods: [
        method({
          id: "cli",
          label: "Sign in with Stripe",
          grantKind: "device-auth",
          startOptions: [
            {
              id: "mode",
              kind: "select",
              label: "Mode",
              required: true,
              defaultValue: null,
              options: [
                { value: "test", label: "Test" },
                { value: "live", label: "Live" },
              ],
            },
          ],
        }),
      ],
    }),
  ]);
  mockAccountStore();
  const starts: (Record<string, string> | undefined)[] = [];
  context.mocks.api(
    builtinConnectorOauthDeviceAuthSessionContract.create,
    ({ body, params, respond }) => {
      starts.push(body.options);
      return respond(200, {
        sessionId: crypto.randomUUID(),
        sessionToken: "stripe-session-token",
        connectorSlug: params.connectorSlug,
        status: "pending",
        userCode: "STRIPE-1",
        verificationUri: "https://stripe.test/device",
        expiresIn: 300,
        interval: 1,
      });
    },
  );
  context.mocks.api(
    builtinConnectorOauthDeviceAuthSessionContract.poll,
    ({ respond }) => {
      return respond(200, {
        status: "error",
        errorCode: "unavailable",
        errorMessage: "Stripe device authorization is unavailable.",
      });
    },
  );
  await setupPage({ context, path: "/connectors" });

  await connectFromCard("Stripe");
  const dialog = await screen.findByRole("dialog", { name: "Stripe" });
  const connect = getConnectorAction("button", "Connect Stripe", dialog);
  expect(connect).toBeDisabled();
  click(within(dialog).getByRole("combobox", { name: "Mode" }));
  click(await screen.findByRole("option", { name: "Live" }));
  await waitFor(() => {
    expect(connect).toBeEnabled();
  });
  click(connect);

  await expect(
    within(dialog).findByText("Stripe device authorization is unavailable."),
  ).resolves.toBeInTheDocument();
  expect(starts).toStrictEqual([{ mode: "live" }]);
});

test("Start provider sign-in from catalog metadata", async () => {
  mockCatalog([
    publicStatusItem({
      connectorSlug: "notion",
      label: "Notion",
      authMethods: [
        method({ id: "oauth", label: "OAuth", grantKind: "auth-code" }),
      ],
      singleAuthCodeAuthMethodId: "oauth",
    }),
  ]);
  mockAccountStore();
  const starts: { connectorSlug: ConnectorSlug; callbackTarget?: string }[] =
    [];
  const authorizationUrl = "https://notion.test/oauth/authorize";
  context.mocks.api(
    builtinConnectorOauthStartContract.start,
    ({ body, params, respond }) => {
      starts.push({
        connectorSlug: params.connectorSlug,
        callbackTarget: body.callbackTarget,
      });
      return respond(200, {
        authorizationUrl,
        oauthAttemptId: crypto.randomUUID(),
      });
    },
  );
  const { authWindow, opened } = mockAuthorizationWindow(false);
  await setupPage({ context, path: "/connectors" });

  await connectFromCard("Notion");

  await waitFor(() => {
    expect(authWindow.location.href).toBe(authorizationUrl);
  });
  expect(starts).toStrictEqual([
    { connectorSlug: "notion", callbackTarget: "app" },
  ]);
  expect(opened.calls).toHaveLength(1);
  expect(screen.queryByRole("dialog", { name: "Notion" })).toBeNull();
});
