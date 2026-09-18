import { mockOAuthCompletions } from "./connector-page-test-helpers.ts";
import {
  builtinConnectorManualGrantContract,
  builtinConnectorNoAuthGrantContract,
  builtinConnectorOpenIdStartContract,
  builtinConnectorOauthStartContract,
} from "@okouai/api-contracts/contracts/connectors";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import {
  connectorCatalogContract,
  type PublicConnectorCatalogStatusItem,
} from "@okouai/api-contracts/contracts/connector-catalog";
import { userBuiltinConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import type { BuiltinConnectorResponse } from "@okouai/api-contracts/contracts/connector-schemas";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const AGENT_ID = "00000000-0000-0000-0000-000000000001";

function publicStatusItem(args: {
  readonly connectorSlug: ConnectorSlug;
  readonly label: string;
  readonly description?: string;
  readonly category?: string;
  readonly authMethods: PublicConnectorCatalogStatusItem["authMethods"];
  readonly connection?: PublicConnectorCatalogStatusItem["connection"];
  readonly connected?: boolean;
  readonly singleAuthCodeAuthMethodId?: string | null;
}): PublicConnectorCatalogStatusItem {
  const connected = args.connected ?? false;
  return {
    slug: args.connectorSlug,
    label: args.label,
    description: args.description ?? `${args.label} public description`,
    icon: {
      url: `https://icons.example.test/${args.connectorSlug}.svg`,
      invertInDarkMode: false,
    },
    category: args.category ?? "data-automation-infrastructure",
    generation: [],
    tags: [],
    authMethods: args.authMethods,
    permissionSummary: {
      hasPermissions: false,
      permissionCount: 0,
      hasCategories: false,
      hasDefaultPolicyOverrides: false,
    },
    connection: args.connection ?? null,
    connected,
    connectionStatus: connected ? "connected" : "not-connected",
    scopeMismatch: false,
    authMethodSupportsRefresh: false,
    tokenExpiresAt: null,
    singleAuthCodeAuthMethodId: args.singleAuthCodeAuthMethodId ?? null,
    connectNotice: null,
  };
}

function mockPublicConnectorStatus(
  connectors: readonly PublicConnectorCatalogStatusItem[],
): void {
  context.mocks.api(connectorCatalogContract.status, ({ respond }) => {
    return respond(200, { connectors: [...connectors] });
  });
}

function connectorResponse(
  connectorSlug: ConnectorSlug,
): BuiltinConnectorResponse {
  return {
    id: crypto.randomUUID(),
    slug: connectorSlug,
    authMethod: "oauth",
    externalId: null,
    externalUsername: null,
    externalEmail: null,
    oauthScopes: ["repo", "read:user"],
    connectionStatus: "connected",
    reconnectReason: null,
    tokenExpiresAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function mockConnectedConnector(connectorSlug: ConnectorSlug): void {
  context.mocks.data.connectors([connectorResponse(connectorSlug)]);
}

function getButtonByText(text: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((element) => {
    return element.textContent?.trim() === text;
  });
  if (!button) {
    throw new Error(`Button not found: ${text}`);
  }
  return button;
}

function mockConnectorOauthStart(): { readonly authWindow: Window } {
  mockOAuthCompletions(context);
  const authWindow = context.mocks.browser.authWindow();
  Object.defineProperty(authWindow, "location", {
    value: { href: "" },
    configurable: true,
  });

  context.mocks.api(
    builtinConnectorOauthStartContract.start,
    ({ body, params, respond }) => {
      expect(body).toStrictEqual({
        account: { intent: "add" },
        authMethod: "oauth",
        agentId: AGENT_ID,
        authorizeAgent: true,
        callbackTarget: "app",
      });
      return respond(200, {
        authorizationUrl: `https://oauth.test/${params.connectorSlug}/authorize`,
        oauthAttemptId: crypto.randomUUID(),
      });
    },
  );
  context.mocks.browser.open(authWindow);
  return { authWindow };
}

function mockConnectorOpenIdStart(args: {
  readonly oauthAttemptId: string;
  readonly onStart: () => void;
}): {
  readonly authWindow: Window;
} {
  const authWindow = context.mocks.browser.authWindow();
  authWindow.closed = false;
  Object.defineProperty(authWindow, "location", {
    value: { href: "" },
    configurable: true,
  });

  context.mocks.api(
    builtinConnectorOpenIdStartContract.start,
    ({ body, params, respond }) => {
      expect(body).toStrictEqual({
        account: { intent: "add" },
        authMethod: "openid",
        agentId: AGENT_ID,
        authorizeAgent: true,
      });
      args?.onStart?.();
      return respond(200, {
        authorizationUrl: `https://openid.test/${params.connectorSlug}/authorize`,
        oauthAttemptId: args.oauthAttemptId,
      });
    },
  );
  context.mocks.api(builtinConnectorOauthStartContract.start, ({ never }) => {
    return never();
  });
  context.mocks.browser.open(authWindow);
  return { authWindow };
}

test("Authorize an agent to use an already connected connector", async () => {
  mockConnectedConnector("gmail");
  let authorized = false;
  context.mocks.api(userBuiltinConnectorsContract.get, ({ respond }) => {
    return respond(200, {
      enabledConnectorSlugs: authorized ? ["gmail"] : [],
    });
  });
  context.mocks.api(
    userBuiltinConnectorsContract.update,
    ({ body, respond }) => {
      expect(body).toStrictEqual({
        enabledConnectorSlugs: ["gmail"],
        operation: "add",
      });
      authorized = true;
      return respond(200, { enabledConnectorSlugs: ["gmail"] });
    },
  );
  const threadId = "00000000-0000-4000-a000-000000000101";
  const callbackPrompt = "Re-check Gmail, then continue";
  let continuationPrompt: string | null = null;
  let continuationUserMessage: unknown;
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    if ("prompt" in body) {
      continuationPrompt = body.prompt ?? null;
      continuationUserMessage = body.userMessage;
    }
    return respond(201, {
      runId: "00000000-0000-4000-a000-000000000201",
      threadId,
    });
  });

  await setupPage({
    context,
    path: `/connectors/gmail/authorize?agentId=${AGENT_ID}&threadId=${threadId}&callbackPrompt=${encodeURIComponent(callbackPrompt)}`,
  });

  await waitFor(() => {
    expect(screen.getByText("Authorize Okou")).toBeInTheDocument();
  });

  click(screen.getByText("Authorize Okou"));

  await waitFor(() => {
    expect(screen.getByText("Gmail authorized")).toBeInTheDocument();
    expect(screen.getByText("Authorized")).toBeInTheDocument();
    expect(continuationPrompt).toBe(callbackPrompt);
    expect(continuationUserMessage).toStrictEqual({
      version: 1,
      parts: [{ type: "text", text: callbackPrompt }],
    });
  });
});

test("Wait for refreshed authorization state instead of updating optimistically", async () => {
  mockConnectedConnector("gmail");
  const releaseUpdate = context.mocks.deferred<void>();
  context.mocks.api(userBuiltinConnectorsContract.get, ({ respond }) => {
    return respond(200, { enabledConnectorSlugs: [] });
  });
  context.mocks.api(
    userBuiltinConnectorsContract.update,
    async ({ body, respond }) => {
      expect(body).toStrictEqual({
        enabledConnectorSlugs: ["gmail"],
        operation: "add",
      });
      await releaseUpdate.promise;
      return respond(200, { enabledConnectorSlugs: ["gmail"] });
    },
  );

  await setupPage({
    context,
    path: `/connectors/gmail/authorize?agentId=${AGENT_ID}`,
  });

  click(await screen.findByText("Authorize Okou"));

  await waitFor(() => {
    expect(screen.queryByText("Authorize Okou")).not.toBeInTheDocument();
    expect(screen.queryByText("Gmail authorized")).not.toBeInTheDocument();
  });

  releaseUpdate.resolve();

  await waitFor(() => {
    expect(screen.getByText("Authorize Okou")).toBeInTheDocument();
    expect(screen.queryByText("Gmail authorized")).not.toBeInTheDocument();
    expect(screen.queryByText("Authorized")).not.toBeInTheDocument();
  });
});

test("Recover from an agent authorization lookup failure", async () => {
  mockConnectedConnector("gmail");
  context.mocks.api(userBuiltinConnectorsContract.get, ({ respond }) => {
    return respond(404, {
      error: { message: "Agent not found", code: "NOT_FOUND" },
    });
  });

  await setupPage({
    context,
    path: `/connectors/gmail/authorize?agentId=${AGENT_ID}`,
  });

  await waitFor(() => {
    expect(screen.getByText("Okou needs Gmail to proceed")).toBeInTheDocument();
    expect(screen.getByText("Authorize Okou")).toBeInTheDocument();
  });
});

test("Connect a manual-token connector while authorizing an agent", async () => {
  mockPublicConnectorStatus([
    publicStatusItem({
      connectorSlug: "axiom",
      label: "Public Axiom",
      authMethods: [
        {
          id: "api-token",
          label: "Public API Token",
          description: null,
          grantKind: "manual",
          manualFields: [
            {
              id: "apiToken",
              label: "Public API token",
              required: true,
              placeholder: "public-xaat",
              inputType: "password",
            },
          ],
          startOptions: [],
        },
      ],
    }),
  ]);
  let submittedValues: Record<string, string> | null = null;
  let authorized = false;
  context.mocks.api(userBuiltinConnectorsContract.get, ({ respond }) => {
    return respond(200, {
      enabledConnectorSlugs: authorized ? ["axiom"] : [],
    });
  });
  context.mocks.api(
    builtinConnectorManualGrantContract.connect,
    ({ body, params, respond }) => {
      expect(params.connectorSlug).toBe("axiom");
      expect(body.agentId).toBe(AGENT_ID);
      expect(body.authorizeAgent).toBeTruthy();
      submittedValues = body.values;
      authorized = true;
      return respond(200, {
        id: crypto.randomUUID(),
        slug: "axiom",
        authMethod: body.authMethod,
        externalId: null,
        externalUsername: null,
        externalEmail: null,
        oauthScopes: null,
        connectionStatus: "connected",
        reconnectReason: null,
        tokenExpiresAt: null,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });
    },
  );

  await setupPage({
    context,
    path: `/connectors/axiom/authorize?agentId=${AGENT_ID}`,
  });

  await waitFor(() => {
    expect(
      screen.getByText("Okou needs Public Axiom to proceed"),
    ).toBeInTheDocument();
  });

  click(getButtonByText("Authorize Okou"));

  const axiomDialog = await screen.findByRole("dialog", {
    name: "Public Axiom",
  });
  await fill(
    within(axiomDialog).getByPlaceholderText("public-xaat"),
    "xaat-directed-authorize",
  );
  click(getButtonByText("Save"));

  await waitFor(() => {
    expect(submittedValues).toStrictEqual({
      apiToken: "xaat-directed-authorize",
    });
    expect(screen.getByText("Public Axiom authorized")).toBeInTheDocument();
    expect(screen.getByText("Authorized")).toBeInTheDocument();
  });
});

test("Connect and authorize an agent through OpenID", async () => {
  context.mocks.data.connectors([]);
  const completedAttempts = mockOAuthCompletions(context);
  const oauthAttemptId = crypto.randomUUID();
  const connectionId = crypto.randomUUID();
  let authorized = false;
  const { authWindow } = mockConnectorOpenIdStart({
    oauthAttemptId,
    onStart: () => {
      authorized = true;
      completedAttempts.set(oauthAttemptId, connectionId);
      context.mocks.data.connectors([
        {
          id: connectionId,
          slug: "steam",
          authMethod: "openid",
          externalId: null,
          externalUsername: null,
          externalEmail: null,
          oauthScopes: null,
          connectionStatus: "connected",
          reconnectReason: null,
          tokenExpiresAt: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:01Z",
        },
      ]);
    },
  });
  context.mocks.api(userBuiltinConnectorsContract.get, ({ respond }) => {
    return respond(200, {
      enabledConnectorSlugs: authorized ? ["steam"] : [],
    });
  });
  mockPublicConnectorStatus([
    publicStatusItem({
      connectorSlug: "steam",
      label: "Steam",
      authMethods: [
        {
          id: "openid",
          label: "Steam OpenID",
          description: null,
          grantKind: "openid-auth",
          manualFields: [],
          startOptions: [],
        },
      ],
    }),
  ]);

  await setupPage({
    context,
    path: `/connectors/steam/authorize?agentId=${AGENT_ID}`,
  });

  await screen.findByText("Okou needs Steam to proceed");
  click(getButtonByText("Authorize Okou"));

  await waitFor(() => {
    expect(authWindow.location.href).toBe(
      "https://openid.test/steam/authorize",
    );
  });
  expect(
    screen.queryByRole("dialog", { name: "Steam" }),
  ).not.toBeInTheDocument();
  await waitFor(() => {
    expect(screen.getByText("Steam authorized")).toBeInTheDocument();
    expect(screen.getByText("Authorized")).toBeInTheDocument();
  });
});

test("Connect and authorize an agent to use a no-auth connector", async () => {
  let connectCalls = 0;
  let authorized = false;
  context.mocks.api(
    builtinConnectorNoAuthGrantContract.connect,
    ({ body, params, respond }) => {
      connectCalls += 1;
      expect(params.connectorSlug).toBe("stripe");
      expect(body).toStrictEqual({
        account: { intent: "add" },
        authMethod: "api",
        agentId: AGENT_ID,
        authorizeAgent: true,
      });
      authorized = true;
      return respond(200, {
        id: crypto.randomUUID(),
        slug: "stripe",
        authMethod: body.authMethod,
        externalId: null,
        externalUsername: null,
        externalEmail: null,
        oauthScopes: null,
        connectionStatus: "connected",
        reconnectReason: null,
        tokenExpiresAt: null,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });
    },
  );
  context.mocks.api(userBuiltinConnectorsContract.get, ({ respond }) => {
    return respond(200, {
      enabledConnectorSlugs: authorized ? ["stripe"] : [],
    });
  });
  mockPublicConnectorStatus([
    publicStatusItem({
      connectorSlug: "stripe",
      label: "Public Stripe",
      authMethods: [
        {
          id: "api",
          label: "Public catalog",
          description: null,
          grantKind: "none",
          manualFields: [],
          startOptions: [],
        },
      ],
    }),
  ]);

  await setupPage({
    context,
    path: `/connectors/stripe/authorize?agentId=${AGENT_ID}`,
  });

  await screen.findByText("Okou needs Public Stripe to proceed");
  click(getButtonByText("Authorize Okou"));

  await waitFor(() => {
    expect(connectCalls).toBe(1);
    expect(screen.getByText("Public Stripe authorized")).toBeInTheDocument();
    expect(screen.getByText("Authorized")).toBeInTheDocument();
  });
  expect(
    screen.queryByRole("dialog", { name: "Public Stripe" }),
  ).not.toBeInTheDocument();
});

test("Leave an agent unauthorized when OAuth is cancelled", async () => {
  const { authWindow } = mockConnectorOauthStart();
  let updateCalls = 0;
  context.mocks.api(userBuiltinConnectorsContract.get, ({ respond }) => {
    return respond(200, { enabledConnectorSlugs: [] });
  });
  context.mocks.api(
    userBuiltinConnectorsContract.update,
    ({ body, respond }) => {
      updateCalls += 1;
      const enabledConnectorSlugs =
        body.operation === "remove" ? [] : body.enabledConnectorSlugs;
      return respond(200, {
        enabledConnectorSlugs,
      });
    },
  );

  await setupPage({
    context,
    path: `/connectors/github/authorize?agentId=${AGENT_ID}`,
  });

  await screen.findByText("Okou needs GitHub to proceed");
  click(getButtonByText("Authorize Okou"));

  await waitFor(() => {
    expect(authWindow.location.href).toBe(
      "https://oauth.test/github/authorize",
    );
  });
  await expect(screen.findByText("Connecting...")).resolves.toBeVisible();
  const progress = screen.getByRole("dialog", {
    name: "Connecting your account",
  });

  click(within(progress).getByText("Cancel"));
  expect(authWindow.closed).toBeTruthy();

  await screen.findByText("Authorize Okou");
  expect(updateCalls).toBe(0);
  expect(screen.queryByText("GitHub authorized")).not.toBeInTheDocument();
});
