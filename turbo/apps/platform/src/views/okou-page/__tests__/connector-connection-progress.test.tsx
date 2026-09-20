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
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  customConnector,
  getConnectorAction,
  listAgent,
  mcpCustomConnector,
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

async function dismissProgress(
  dialog: HTMLElement,
  method: "Close" | "Escape" | "backdrop",
): Promise<void> {
  const user = userEvent.setup();
  if (method === "Close") {
    await user.click(within(dialog).getByLabelText("Close"));
  } else if (method === "Escape") {
    await user.keyboard("{Escape}");
  } else {
    const viewport = dialog.closest('[data-slot="dialog-viewport"]');
    if (!(viewport instanceof HTMLElement)) {
      throw new Error("Expected the connection dialog viewport");
    }
    await user.click(viewport);
  }
  await waitFor(() => {
    expect(screen.queryAllByRole("dialog")).toHaveLength(
      method === "backdrop" ? 1 : 0,
    );
  });
}

async function expectCancelledConnection(popup: Window, connect: HTMLElement) {
  expect(popup.closed).toBeTruthy();
  await waitFor(() => {
    expect(connect).toBeEnabled();
  });
  expect(screen.queryByRole("dialog")).toBeNull();
}

async function closeCompletedConnection(
  dialog: HTMLElement,
  connectorLabel: string,
  releaseDetails: () => void,
) {
  click(within(dialog).getByLabelText("Close"));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  releaseDetails();
  await waitFor(() => {
    expect(
      getConnectorAction("button", `Manage ${connectorLabel} accounts`),
    ).toBeEnabled();
  });
  expect(
    screen.queryByRole("dialog", {
      name: `Name your ${connectorLabel} account`,
    }),
  ).toBeNull();
}

async function expectAuthorizationPage(popup: Window, url: string) {
  await waitFor(() => {
    expect(popup.location.href).toBe(url);
  });
}

test.each([
  { grantKind: "auth-code", existing: false, dismiss: null },
  { grantKind: "openid-auth", existing: false, dismiss: null },
  { grantKind: "auth-code", existing: true, dismiss: null },
  { grantKind: "auth-code", existing: true, dismiss: "Close" },
  { grantKind: "auth-code", existing: true, dismiss: "Escape" },
  { grantKind: "auth-code", existing: false, dismiss: "details" },
  { grantKind: "openid-auth", existing: true, dismiss: "details" },
] as const)(
  "Keep $grantKind feedback through naming, or cancel explicitly (dialog: $existing, dismissal: $dismiss)",
  async ({ grantKind, existing, dismiss }) => {
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
        singleAuthCodeAuthMethodId:
          !existing && grantKind === "auth-code" ? "oauth" : null,
        authMethods: [
          {
            id: "oauth",
            label: "OAuth",
            description: null,
            grantKind,
            manualFields: [],
            startOptions: [],
          },
          ...(existing
            ? [
                {
                  id: "api-token",
                  label: "API token",
                  description: null,
                  grantKind: "manual" as const,
                  manualFields: [],
                  startOptions: [],
                },
              ]
            : []),
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
    if (existing) {
      const chooser = await screen.findByRole("dialog", { name: "Stripe" });
      click(getConnectorAction("button", "Connect", chooser));
    }
    await expect(screen.findByRole("status")).resolves.toBeVisible();
    expect(screen.queryAllByRole("dialog", { hidden: true })).toHaveLength(1);
    expect(
      screen.getByRole("dialog", { name: existing ? "Stripe" : PROGRESS }),
    ).toBeVisible();
    expect(connect).toBeDisabled();
    await waitFor(() => {
      return expect(popup.location.href).toBe(start.authorizationUrl);
    });
    if (dismiss && dismiss !== "details") {
      await dismissProgress(
        screen.getByRole("dialog", { name: "Stripe" }),
        dismiss,
      );
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
    if (dismiss === "details") {
      const progress = screen.getByRole("dialog", {
        name: existing ? "Stripe" : PROGRESS,
      });
      await closeCompletedConnection(progress, "Stripe", () => {
        return details.resolve();
      });
      return;
    }
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

test.each([false, true])(
  "Keep a later access dialog usable after cancelling authorization (existing dialog: %s)",
  async (existing) => {
    const account = connectedAccount({
      kind: "builtin",
      connectorSlug: "stripe",
    });
    const completedAttempts = mockOAuthCompletions(context);
    const oauthAttemptId = crypto.randomUUID();
    let authorized = false;
    const existingAccounts = mockConnectors(context, [
      { connectorSlug: "axiom", authMethod: "api-token" },
    ]);
    mockPublicConnectorStatus(context, [
      publicStatusItem({
        connectorSlug: "stripe",
        label: "Stripe",
        singleAuthCodeAuthMethodId: existing ? null : "oauth",
        authMethods: [
          {
            id: "oauth",
            label: "OAuth",
            description: null,
            grantKind: "auth-code",
            manualFields: [],
            startOptions: [],
          },
          ...(existing
            ? [
                {
                  id: "api-token",
                  label: "API token",
                  description: null,
                  grantKind: "manual" as const,
                  manualFields: [],
                  startOptions: [],
                },
              ]
            : []),
        ],
      }),
      publicStatusItem({
        connectorSlug: "axiom",
        label: "Axiom",
        authMethods: [
          {
            id: "api-token",
            label: "API token",
            description: null,
            grantKind: "manual",
            manualFields: [],
            startOptions: [],
          },
        ],
      }),
    ]);
    const popup = authorizationWindow();
    const authorizationUrl = "https://oauth.test/stripe/authorize";
    context.mocks.api(
      builtinConnectorOauthStartContract.start,
      ({ respond }) => {
        return respond(200, {
          authorizationUrl,
          connectionId: account.id,
          oauthAttemptId,
        });
      },
    );
    context.mocks.api(connectorAccountsContract.connection, ({ respond }) => {
      return authorized
        ? respond(200, account)
        : respond(404, {
            error: { code: "NOT_FOUND", message: "Not connected" },
          });
    });
    await setupPage({ context, path: "/connectors" });
    const connect = await waitFor(() => {
      return getConnectorAction("button", "Connect Stripe");
    });
    click(connect);
    if (existing) {
      const chooser = await screen.findByRole("dialog", { name: "Stripe" });
      click(getConnectorAction("button", "Connect", chooser));
    }
    await waitFor(() => {
      expect(popup.location.href).toBe(authorizationUrl);
    });
    await dismissProgress(
      screen.getByRole("dialog", { name: existing ? "Stripe" : PROGRESS }),
      "Close",
    );
    expect(screen.queryByRole("dialog", { name: PROGRESS })).toBeNull();
    expect(getConnectorAction("button", "Manage Axiom accounts")).toBeEnabled();
    click(getConnectorAction("button", "Manage Axiom access"));
    const axiom = await screen.findByRole("dialog", {
      name: "Manage Axiom access",
    });
    expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(1);

    authorized = true;
    completedAttempts.set(oauthAttemptId, account.id);
    context.mocks.data.connectors([
      ...existingAccounts,
      { ...account, slug: "stripe" },
    ]);
    popup.close();
    expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(1);
    expect(axiom).toBeVisible();
    expect(
      screen.queryByRole("dialog", { name: "Name your Stripe account" }),
    ).toBeNull();

    click(within(axiom).getByLabelText("Close"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  },
);

test("Show progress for a custom connection after dismissing the previous attempt", async () => {
  mockOAuthCompletions(context);
  const connector = customConnector({
    authMode: "oauth",
    oauthConfig: customOAuthConfig(),
    fields: [],
    missingRequiredFields: ["oauth"],
  });
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: [connector] });
  });
  const authorizationUrl = "https://oauth.test/custom/authorize";
  context.mocks.api(customConnectorOAuth2Contract.start, ({ respond }) => {
    return respond(200, {
      result: "authorization",
      authorizationUrl,
      oauthAttemptId: crypto.randomUUID(),
    });
  });
  const firstPopup = authorizationWindow();
  await setupPage({ context, path: "/connectors?tab=custom" });
  const connect = await waitFor(() => {
    return getConnectorAction("button", `Connect ${connector.displayName}`);
  });
  click(connect);
  const progress = await expectProgressDialog();
  await waitFor(() => {
    expect(firstPopup.location.href).toBe(authorizationUrl);
  });
  await dismissProgress(progress, "Close");
  expect(firstPopup.closed).toBeTruthy();
  await waitFor(() => {
    expect(connect).toBeEnabled();
  });
  const nextPopup = authorizationWindow();
  click(connect);
  await expectProgressDialog();
  await waitFor(() => {
    expect(nextPopup.location.href).toBe(authorizationUrl);
  });
  nextPopup.close();
  await waitFor(() => {
    expect(connect).toBeEnabled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

test.each([
  { kind: "http", dismiss: null },
  { kind: "mcp", dismiss: null },
  { kind: "automatic", dismiss: null },
  { kind: "http", dismiss: "Close" },
  { kind: "http", dismiss: "Escape" },
  { kind: "http", dismiss: "backdrop" },
  { kind: "automatic", dismiss: "details" },
] as const)(
  "Keep custom $kind progress until naming is ready and respect dismissal ($dismiss)",
  async ({ kind, dismiss }) => {
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
    const progress = await expectProgressDialog();
    expect(connect).toBeDisabled();
    await waitFor(() => {
      return expect(popup.location.href).toBe(start.authorizationUrl);
    });
    if (dismiss && dismiss !== "details") {
      await dismissProgress(progress, dismiss);
      if (dismiss !== "backdrop") {
        await expectCancelledConnection(popup, connect);
        confirmation.resolve();
        details.resolve();
        return;
      }
    }
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
    if (dismiss === "details") {
      await closeCompletedConnection(progress, connector.displayName, () => {
        return details.resolve();
      });
      return;
    }
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

test("Cancelled custom OAuth cannot cover or replace a new connector draft", async () => {
  let connector = customConnector({
    authMode: "oauth",
    oauthConfig: customOAuthConfig(),
    fields: [],
    missingRequiredFields: ["oauth"],
  });
  const account = connectedAccount({
    kind: "custom",
    customConnectorId: connector.id,
  });
  const completedAttempts = mockOAuthCompletions(context);
  const oauthAttemptId = crypto.randomUUID();
  let authorized = false;
  context.mocks.data.org({ id: "org_1", name: "Test Org", role: "admin" });
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
  context.mocks.api(connectorAccountsContract.connection, ({ respond }) => {
    return authorized
      ? respond(200, account)
      : respond(404, {
          error: { code: "NOT_FOUND", message: "Not connected" },
        });
  });
  const popup = authorizationWindow();
  const authorizationUrl = "https://oauth.test/custom/authorize";
  context.mocks.api(customConnectorOAuth2Contract.start, ({ respond }) => {
    return respond(200, {
      result: "authorization",
      authorizationUrl,
      oauthAttemptId,
      connectionId: account.id,
    });
  });
  await setupPage({ context, path: "/connectors?tab=custom" });
  const connect = await waitFor(() => {
    return getConnectorAction("button", `Connect ${connector.displayName}`);
  });
  click(connect);
  const progress = await expectProgressDialog();
  await waitFor(() => {
    expect(popup.location.href).toBe(authorizationUrl);
  });
  await dismissProgress(progress, "Close");
  click(getConnectorAction("button", "New connector"));
  const draft = await screen.findByRole("dialog", {
    name: "New custom connector",
  });
  await fill(within(draft).getByLabelText("Display name"), "Another API");

  authorized = true;
  completedAttempts.set(oauthAttemptId, account.id);
  connector = {
    ...connector,
    connected: true,
    connectedAccountId: account.id,
    missingRequiredFields: [],
  };
  popup.close();
  expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(1);
  expect(within(draft).getByLabelText("Display name")).toHaveValue(
    "Another API",
  );
  expect(
    screen.queryByRole("dialog", {
      name: `Name your ${connector.displayName} account`,
    }),
  ).toBeNull();

  click(getConnectorAction("button", "Cancel", draft));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

test.each([
  { custom: false, blocked: "start" },
  { custom: false, blocked: "completion" },
  { custom: true, blocked: "start" },
  { custom: true, blocked: "completion" },
] as const)(
  "Close a pending $blocked request and retry without stale cleanup (custom: $custom)",
  async ({ custom, blocked }) => {
    const oldAttempt = crypto.randomUUID();
    const nextAttempt = crypto.randomUUID();
    const oldConnection = crypto.randomUUID();
    const blockedRequest = context.mocks.deferred<void>();
    const releaseOldRequest = context.mocks.deferred<void>();
    const oldResponse = context.mocks.deferred<void>();
    const authorizationUrl = "https://oauth.test/authorize";
    let starts = 0;
    const nextStart = async () => {
      const attemptId = starts++ === 0 ? oldAttempt : nextAttempt;
      if (attemptId === oldAttempt && blocked === "start") {
        blockedRequest.resolve();
        await releaseOldRequest.promise;
        oldResponse.resolve();
      }
      return attemptId;
    };
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
    const connector = customConnector({
      authMode: "oauth",
      oauthConfig: customOAuthConfig(),
      fields: [],
      missingRequiredFields: ["oauth"],
    });
    context.mocks.api(customConnectorsContract.list, ({ respond }) => {
      return respond(200, { connectors: [connector] });
    });
    context.mocks.api(
      builtinConnectorOauthStartContract.start,
      async ({ respond }) => {
        return respond(200, {
          authorizationUrl,
          oauthAttemptId: await nextStart(),
        });
      },
    );
    context.mocks.api(
      customConnectorOAuth2Contract.start,
      async ({ respond }) => {
        return respond(200, {
          result: "authorization",
          authorizationUrl,
          oauthAttemptId: await nextStart(),
        });
      },
    );
    context.mocks.api(
      connectorAccountsContract.oauthCompletion,
      async ({ params, respond }) => {
        if (params.attemptId === oldAttempt && blocked === "completion") {
          blockedRequest.resolve();
          await releaseOldRequest.promise;
          oldResponse.resolve();
          return respond(200, { connectionId: oldConnection });
        }
        return respond(404, {
          error: { code: "NOT_FOUND", message: "OAuth completion not found" },
        });
      },
    );
    const firstPopup = authorizationWindow();
    await setupPage({
      context,
      path: custom ? "/connectors?tab=custom" : "/connectors?keywords=stripe",
    });
    const connect = await waitFor(() => {
      return getConnectorAction(
        "button",
        `Connect ${custom ? connector.displayName : "Stripe"}`,
      );
    });
    click(connect);
    const firstDialog = await expectProgressDialog();
    if (blocked === "completion" && custom) {
      await expectAuthorizationPage(firstPopup, authorizationUrl);
      firstPopup.close();
    }
    await blockedRequest.promise;
    await dismissProgress(firstDialog, "Close");
    await waitFor(() => {
      expect(connect).toBeEnabled();
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(firstPopup.closed).toBeTruthy();

    const secondPopup = authorizationWindow();
    click(connect);
    const nextDialog = await expectProgressDialog();
    await expectAuthorizationPage(secondPopup, authorizationUrl);
    releaseOldRequest.resolve();
    await oldResponse.promise;
    expect(secondPopup.closed).toBeFalsy();
    expect(nextDialog).toBeVisible();
    expect(connect).toBeDisabled();
    expect(screen.queryByRole("dialog", { name: /^Name your/ })).toBeNull();
    await dismissProgress(nextDialog, "Close");
    await waitFor(() => {
      expect(connect).toBeEnabled();
    });
    expect(secondPopup.closed).toBeTruthy();
  },
);
