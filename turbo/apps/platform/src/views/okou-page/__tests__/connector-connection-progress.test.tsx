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
import { AUTH_FAILURE_DIAGNOSTICS_EXPIRES_AT } from "@okouai/core/temporary-auth-diagnostics";
import * as Sentry from "@sentry/browser";
import { agentCustomConnectorsContract } from "@okouai/api-contracts/contracts/agent-custom-connectors";
import {
  customConnectorOAuth2Contract,
  customConnectorsContract,
  type CustomConnectorOAuthConfig,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../lib/time.ts";
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

function oauthWaitDiagnostics() {
  return context.mocks.sentry().breadcrumbs.filter((breadcrumb) => {
    return breadcrumb.category === "connector.oauth.wait";
  });
}

function expectBoundedWaitDiagnostics(oauthAttemptId: string, enabled = true) {
  const breadcrumbs = oauthWaitDiagnostics();
  expect(breadcrumbs.length > 0).toBe(enabled);
  expect(breadcrumbs.length).toBeLessThanOrEqual(4);
  const started = expect.objectContaining({
    message: "started",
    data: expect.objectContaining({
      parent_aborted: false,
      wait_aborted: false,
      current: true,
      completion_verified: false,
    }),
  });
  expect(breadcrumbs.at(0)).toStrictEqual(enabled ? started : undefined);
  expect(
    new Set(
      breadcrumbs.map((entry) => {
        return entry.data?.flow_id;
      }),
    ).size,
  ).toBe(enabled ? 1 : 0);
  const allowed = new Set([
    "flow_id",
    "parent_aborted",
    "wait_aborted",
    "current",
    "completion_verified",
    "branch",
    "cleanup_owned",
    "accepted",
    "error_kind",
  ]);
  for (const entry of breadcrumbs) {
    expect(entry.data?.flow_id).toMatch(
      /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/u,
    );
    expect(
      Object.keys(entry.data ?? {}).filter((key) => {
        return !allowed.has(key);
      }),
    ).toStrictEqual([]);
  }
  const serialized = JSON.stringify(breadcrumbs);
  expect(serialized).not.toContain(oauthAttemptId);
  expect(serialized).not.toContain("https://");
  expect(serialized).not.toContain("stripe");
  expect(serialized).not.toContain("OAuth completion is unavailable");
  return breadcrumbs;
}

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
    setupStatus: "complete",
    missingRequiredFields: [],
    configuredFieldKeys: [],
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

async function expectCancelledConnection(
  popup: Window,
  connect: HTMLElement,
  oauthAttemptId: string,
) {
  expect(popup.closed).toBeTruthy();
  await waitFor(() => {
    expect(connect).toBeEnabled();
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => {
    expect(oauthWaitDiagnostics().at(-1)?.message).toBe("failed");
  });
  expectBoundedWaitDiagnostics(oauthAttemptId);
  expect(oauthWaitDiagnostics().at(-1)?.data).toMatchObject({
    parent_aborted: true,
    wait_aborted: true,
    error_kind: "aborted",
  });
  expect(
    oauthWaitDiagnostics().find((entry) => {
      return entry.message === "cleanup";
    })?.data,
  ).toMatchObject({
    cleanup_owned: false,
    parent_aborted: true,
    wait_aborted: true,
    current: false,
    completion_verified: false,
  });
}

test.each([
  { grantKind: "auth-code", cancel: false, diagnostics: "active" },
  { grantKind: "openid-auth", cancel: false, diagnostics: "active" },
  { grantKind: "auth-code", cancel: true, diagnostics: "active" },
  { grantKind: "auth-code", cancel: false, diagnostics: "expired" },
  { grantKind: "auth-code", cancel: false, diagnostics: "unavailable" },
] as const)(
  "Keep $grantKind feedback through naming, or cancel explicitly (cancel: $cancel, diagnostics: $diagnostics)",
  async ({ grantKind, cancel, diagnostics }) => {
    mockNow(
      diagnostics === "expired"
        ? AUTH_FAILURE_DIAGNOSTICS_EXPIRES_AT
        : AUTH_FAILURE_DIAGNOSTICS_EXPIRES_AT - 60_000,
      context.signal,
    );
    context.mocks.sentry();
    if (diagnostics === "unavailable") {
      vi.spyOn(Sentry, "addBreadcrumb").mockImplementation(() => {
        throw new Error("Diagnostic SDK is unavailable");
      });
    }
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
      await expectCancelledConnection(popup, connect, oauthAttemptId);
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
    const enabled = diagnostics === "active";
    const breadcrumbs = expectBoundedWaitDiagnostics(oauthAttemptId, enabled);
    const cleanup = expect.objectContaining({
      cleanup_owned: true,
      parent_aborted: false,
      wait_aborted: true,
      current: true,
    });
    expect(
      breadcrumbs.find((entry) => {
        return entry.message === "cleanup";
      })?.data,
    ).toStrictEqual(enabled ? cleanup : undefined);
    const accepted = expect.objectContaining({
      message: "finished",
      data: expect.objectContaining({
        accepted: true,
        completion_verified: true,
        parent_aborted: false,
        wait_aborted: true,
      }),
    });
    expect(breadcrumbs.at(-1)).toStrictEqual(enabled ? accepted : undefined);
    const winningBranches = enabled
      ? ["connectorChanged", "popupClosed"]
      : [undefined];
    expect(winningBranches).toContain(
      breadcrumbs.find((entry) => {
        return entry.message === "race-settled";
      })?.data?.branch,
    );
  },
);

test.each(["popup", "cancel", "forbidden"] as const)(
  "Preserve the pending OAuth receipt outcome when %s ends the wait",
  async (finish) => {
    mockNow(AUTH_FAILURE_DIAGNOSTICS_EXPIRES_AT - 60_000, context.signal);
    context.mocks.sentry();
    const receiptStarted = context.mocks.deferred<void>();
    const oauthAttemptId = crypto.randomUUID();
    let firstReceiptRead = true;
    mockConnectors(context, []);
    mockPublicConnectorStatus(context, [
      publicStatusItem({
        connectorSlug: "stripe",
        label: "Stripe",
        singleAuthCodeAuthMethodId: "oauth",
        authMethods: [
          {
            id: "oauth",
            label: "OAuth",
            description: null,
            grantKind: "auth-code",
            manualFields: [],
            startOptions: [],
          },
        ],
      }),
    ]);
    const popup = authorizationWindow();
    context.mocks.api(
      builtinConnectorOauthStartContract.start,
      ({ respond }) => {
        return respond(200, {
          authorizationUrl: "https://oauth.test/stripe/authorize",
          oauthAttemptId,
        });
      },
    );
    context.mocks.api(
      connectorAccountsContract.oauthCompletion,
      async ({ never, respond }) => {
        if (firstReceiptRead) {
          firstReceiptRead = false;
          receiptStarted.resolve();
          return await never();
        }
        return finish === "forbidden"
          ? respond(403, {
              error: {
                code: "FORBIDDEN",
                message: "OAuth completion is unavailable",
              },
            })
          : respond(404, {
              error: {
                code: "NOT_FOUND",
                message: "OAuth completion not found",
              },
            });
      },
    );
    await setupPage({ context, path: "/connectors?keywords=stripe" });
    const connect = await waitFor(() => {
      return getConnectorAction("button", "Connect Stripe");
    });
    click(connect);
    const progress = await expectProgressDialog();
    await receiptStarted.promise;
    if (finish === "cancel") {
      await dismissProgress(progress);
    } else {
      popup.close();
    }
    await waitFor(() => {
      return expect(connect).toBeEnabled();
    });
    await waitFor(() => {
      expect(oauthWaitDiagnostics().at(-1)?.message).toBe(
        finish === "popup" ? "finished" : "failed",
      );
    });
    const breadcrumbs = expectBoundedWaitDiagnostics(oauthAttemptId);
    expect(
      breadcrumbs.find((entry) => {
        return entry.message === "cleanup";
      })?.data,
    ).toMatchObject({
      cleanup_owned: finish !== "cancel",
      parent_aborted: finish === "cancel",
      wait_aborted: true,
      current: finish !== "cancel",
      completion_verified: false,
    });
    const popupBranch = expect.objectContaining({ branch: "popupClosed" });
    expect(
      breadcrumbs.find((entry) => {
        return entry.message === "race-settled";
      })?.data,
    ).toStrictEqual(finish === "cancel" ? undefined : popupBranch);
    const expectedOutcome = {
      popup: {
        accepted: false,
        completion_verified: false,
        parent_aborted: false,
      },
      cancel: { parent_aborted: true, error_kind: "aborted" },
      forbidden: { parent_aborted: false, error_kind: "error" },
    }[finish];
    expect(breadcrumbs.at(-1)?.data).toMatchObject(expectedOutcome);
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => {
      expect(
        screen.queryAllByText("OAuth completion is unavailable"),
      ).toHaveLength(finish === "forbidden" ? 1 : 0);
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
    await setupPage({ context, path: "/connectors?scope=custom" });
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
