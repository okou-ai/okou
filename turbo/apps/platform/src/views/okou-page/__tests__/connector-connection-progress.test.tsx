import {
  connectorAccountsContract,
  type ConnectorAccountConnection,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import {
  builtinConnectorOauthStartContract,
  builtinConnectorOpenIdStartContract,
} from "@okouai/api-contracts/contracts/connectors";
import { userBuiltinConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import { agentCustomConnectorsContract } from "@okouai/api-contracts/contracts/agent-custom-connectors";
import {
  customConnectorOAuth2Contract,
  customConnectorsContract,
  type CustomConnectorOAuthConfig,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  customConnector,
  getConnectorAction,
  listAgent,
  mcpCustomConnector,
  mockConnectorOverviewAccountSummaries,
  mockConnectors,
  mockOAuthCompletions,
  mockPublicConnectorStatus,
  publicStatusItem,
} from "./connector-page-test-helpers.ts";

const context = testContext();
const AGENT_ID = "c0000000-0000-4000-a000-000000000051";
const PROGRESS = "Connecting your account";

function customOAuthConfig(): CustomConnectorOAuthConfig {
  return {
    providerAdapter: "standard",
    clientId: "acme-client",
    authorizationUrl: "https://oauth.acme.test/authorize",
    tokenUrl: "https://oauth.acme.test/token",
    tokenEndpointAuthMethod: "client_secret_post",
    pkceMethod: "none",
    scopes: ["search.read"],
    authorizationParams: {},
  };
}

function connectedAccount(
  target: ConnectorAccountTarget,
): ConnectorAccountConnection {
  return {
    id: crypto.randomUUID(),
    target,
    authMethod: "oauth",
    displayName: null,
    isDefault: true,
    externalId: null,
    externalUsername: "alice",
    externalEmail: null,
    oauthScopes: [],
    connectionStatus: "connected",
    reconnectReason: null,
    tokenExpiresAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function authorizationWindow(): Window {
  const popup = context.mocks.browser.authWindow();
  Object.defineProperty(popup, "location", {
    configurable: true,
    value: { href: "" },
  });
  context.mocks.browser.open(popup);
  return popup;
}

async function expectProgressDialog(name = PROGRESS): Promise<HTMLElement> {
  const dialog = await screen.findByRole("dialog", { name });
  await expect(within(dialog).findByRole("status")).resolves.toHaveTextContent(
    "Please wait while we finish setting up your connection.",
  );
  await waitFor(() => {
    expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(1);
  });
  expect(within(dialog).getByLabelText("Close")).toBeEnabled();
  return dialog;
}

async function dismissProgress(dialog: HTMLElement): Promise<void> {
  await userEvent.setup().click(within(dialog).getByLabelText("Close"));
  await waitFor(() => {
    expect(screen.queryAllByRole("dialog")).toHaveLength(0);
  });
}

async function expectCancelledConnection(popup: Window, connect: HTMLElement) {
  expect(popup.closed).toBeTruthy();
  await waitFor(() => {
    expect(connect).toBeEnabled();
  });
  expect(screen.queryByRole("dialog")).toBeNull();
}

test.each([
  { grantKind: "auth-code", cancel: false },
  { grantKind: "openid-auth", cancel: false },
  { grantKind: "auth-code", cancel: true },
] as const)(
  "Keep $grantKind feedback through naming, or cancel explicitly (cancel: $cancel)",
  async ({ grantKind, cancel }) => {
    const account = connectedAccount({
      kind: "builtin",
      connectorSlug: "stripe",
    });
    const permissions = context.mocks.deferred<void>();
    const permissionRequest = context.mocks.deferred<void>();
    const details = context.mocks.deferred<void>();
    const detailRequest = context.mocks.deferred<void>();
    const completedAttempts = mockOAuthCompletions(context);
    const oauthAttemptId = crypto.randomUUID();
    let authorized = false;
    let granting = false;
    mockConnectors(context, []);
    context.mocks.data.agents([listAgent(AGENT_ID, "Research")]);
    mockPublicConnectorStatus(context, [
      publicStatusItem({
        connectorSlug: "stripe",
        label: "Stripe",
        singleAuthCodeAuthMethodId: grantKind === "auth-code" ? "oauth" : null,
        authMethods: [
          {
            id: "oauth",
            label: "OAuth",
            description: null,
            grantKind,
            manualFields: [],
            startOptions: [],
          },
        ],
      }),
    ]);
    const popup = authorizationWindow();
    const start = {
      authorizationUrl: "https://oauth.test/stripe/authorize",
      oauthAttemptId,
      connectionId: account.id,
    };
    context.mocks.api(
      builtinConnectorOauthStartContract.start,
      ({ respond }) => {
        return respond(200, start);
      },
    );
    context.mocks.api(
      builtinConnectorOpenIdStartContract.start,
      ({ respond }) => {
        return respond(200, start);
      },
    );
    context.mocks.api(userBuiltinConnectorsContract.get, ({ respond }) => {
      return respond(200, {
        enabledConnectorSlugs: granting ? ["stripe"] : [],
      });
    });
    context.mocks.api(
      userBuiltinConnectorsContract.update,
      async ({ respond }) => {
        granting = true;
        permissionRequest.resolve();
        await permissions.promise;
        return respond(200, { enabledConnectorSlugs: ["stripe"] });
      },
    );
    context.mocks.api(
      connectorAccountsContract.connection,
      async ({ respond }) => {
        if (!authorized) {
          return respond(404, {
            error: { code: "NOT_FOUND", message: "Not connected" },
          });
        }
        if (granting) {
          detailRequest.resolve();
          await details.promise;
        }
        return respond(200, account);
      },
    );
    await setupPage({ context, path: "/connectors?keywords=stripe" });
    const connect = await waitFor(() => {
      return getConnectorAction("button", "Connect Stripe");
    });
    click(connect);
    await expect(screen.findByRole("status")).resolves.toBeVisible();
    expect(screen.queryAllByRole("dialog", { hidden: true })).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: PROGRESS })).toBeVisible();
    expect(connect).toBeDisabled();
    await waitFor(() => {
      return expect(popup.location.href).toBe(start.authorizationUrl);
    });
    if (cancel) {
      await dismissProgress(screen.getByRole("dialog", { name: PROGRESS }));
      await expectCancelledConnection(popup, connect);
      permissions.resolve();
      details.resolve();
      return;
    }
    expect(popup.closed).toBeFalsy();
    expect(connect).toBeDisabled();

    authorized = true;
    completedAttempts.set(oauthAttemptId, account.id);
    context.mocks.data.connectors([{ ...account, slug: "stripe" }]);
    popup.close();
    await permissionRequest.promise;
    expect(screen.queryAllByRole("dialog", { hidden: true })).toHaveLength(1);
    expect(screen.getByRole("status")).toBeVisible();
    expect(
      screen.queryByRole("dialog", { name: "Name your Stripe account" }),
    ).toBeNull();
    permissions.resolve();
    await detailRequest.promise;
    expect(screen.queryAllByRole("dialog", { hidden: true })).toHaveLength(1);
    expect(screen.getByRole("status")).toBeVisible();
    details.resolve();
    const naming = await screen.findByRole("dialog", {
      name: "Name your Stripe account",
    });
    expect(within(naming).getByLabelText("Account name")).toHaveAttribute(
      "placeholder",
      "alice",
    );
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: PROGRESS })).toBeNull();
      expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(1);
      expect(within(naming).getByLabelText("Account name")).toHaveFocus();
    });
    click(getConnectorAction("button", "Skip", naming));
    await waitFor(() => {
      return expect(
        getConnectorAction("button", "Manage Stripe accounts"),
      ).toBeEnabled();
    });
  },
);

test.each(["http", "mcp", "automatic"] as const)(
  "Keep custom %s progress until naming is ready",
  async (kind) => {
    let connector =
      kind === "http"
        ? customConnector({
            authMode: "oauth",
            oauthConfig: customOAuthConfig(),
            fields: [],
            missingRequiredFields: ["oauth"],
          })
        : mcpCustomConnector({
            ...(kind === "automatic"
              ? { authMode: "automatic" }
              : { authMode: "oauth", oauthConfig: customOAuthConfig() }),
            connected: false,
            fields: [],
            missingRequiredFields: ["oauth"],
            configuredFieldKeys: [],
          });
    const account = connectedAccount({
      kind: "custom",
      customConnectorId: connector.id,
    });
    const confirmation = context.mocks.deferred<void>();
    const confirmRequest = context.mocks.deferred<void>();
    const details = context.mocks.deferred<void>();
    const detailRequest = context.mocks.deferred<void>();
    const oauthAttemptId = crypto.randomUUID();
    context.mocks.api(
      connectorAccountsContract.oauthCompletion,
      async ({ params, respond }) => {
        expect(params.attemptId).toBe(oauthAttemptId);
        confirmRequest.resolve();
        await confirmation.promise;
        return respond(200, { connectionId: account.id });
      },
    );
    let authorized = false;
    let granting = false;
    context.mocks.data.agents([listAgent(AGENT_ID, "Research")]);
    context.mocks.api(customConnectorsContract.list, ({ respond }) => {
      return respond(200, { connectors: [connector] });
    });
    context.mocks.api(connectorAccountsContract.summaries, ({ respond }) => {
      return respond(200, {
        summaries: authorized
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
    mockConnectorOverviewAccountSummaries(context, () => {
      return authorized
        ? [
            {
              target: account.target,
              accountCount: 1,
              attentionCount: 0,
              defaultConnection: account,
            },
          ]
        : [];
    });
    context.mocks.api(agentCustomConnectorsContract.get, ({ respond }) => {
      return respond(200, { grants: [] });
    });
    context.mocks.api(
      agentCustomConnectorsContract.update,
      ({ body, respond }) => {
        granting = true;
        return respond(200, { grants: body.grants });
      },
    );
    context.mocks.api(
      connectorAccountsContract.connection,
      async ({ respond }) => {
        if (!authorized) {
          return respond(404, {
            error: { code: "NOT_FOUND", message: "Not connected" },
          });
        }
        if (granting) {
          detailRequest.resolve();
          await details.promise;
        }
        return respond(200, account);
      },
    );
    const popup = authorizationWindow();
    const start = {
      result: "authorization" as const,
      authorizationUrl: "https://oauth.test/custom/authorize",
      oauthAttemptId,
      connectionId: account.id,
    };
    context.mocks.api(customConnectorOAuth2Contract.start, ({ respond }) => {
      return respond(200, start);
    });
    await setupPage({
      context,
      path: "/connectors?tab=custom",
    });
    const connect = await waitFor(() => {
      return getConnectorAction("button", `Connect ${connector.displayName}`);
    });
    click(connect);
    await expectProgressDialog();
    expect(connect).toBeDisabled();
    await waitFor(() => {
      return expect(popup.location.href).toBe(start.authorizationUrl);
    });
    authorized = true;
    connector = {
      ...connector,
      connected: true,
      connectedAccountId: account.id,
      missingRequiredFields: [],
    };
    popup.close();
    await confirmRequest.promise;
    expect(screen.queryAllByRole("dialog", { name: PROGRESS })).toHaveLength(1);
    confirmation.resolve();
    await detailRequest.promise;
    expect(screen.queryAllByRole("dialog", { name: PROGRESS })).toHaveLength(1);
    expect(
      screen.queryByRole("dialog", {
        name: `Name your ${connector.displayName} account`,
      }),
    ).toBeNull();
    details.resolve();
    const naming = await screen.findByRole("dialog", {
      name: `Name your ${connector.displayName} account`,
    });
    expect(within(naming).getByLabelText("Account name")).toHaveAttribute(
      "placeholder",
      "alice",
    );
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: PROGRESS })).toBeNull();
      expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(1);
      expect(within(naming).getByLabelText("Account name")).toHaveFocus();
    });
  },
);
