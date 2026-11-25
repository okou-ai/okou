import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import type { ConnectorAccountConnection } from "@okouai/api-contracts/contracts/connector-accounts";
import {
  connectorCatalogContract,
  type PublicConnectorCatalogStatusItem,
} from "@okouai/api-contracts/contracts/connector-catalog";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import {
  builtinConnectorOauthStartContract,
  builtinConnectorOpenIdStartContract,
} from "@okouai/api-contracts/contracts/connectors";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  mockOAuthCompletions,
  mockSavedConnectorAccounts,
  publicStatusItem,
} from "./connector-page-test-helpers.ts";

const context = testContext();
const AGENT_ID = "c0000000-0000-4000-a000-000000000d01";
const THREAD_ID = "b0000000-0000-4000-a000-000000000d01";
const CALLBACK_PROMPT = "Gmail is ready. Summarize my unread mail.";

type GrantKind =
  PublicConnectorCatalogStatusItem["authMethods"][number]["grantKind"];

function catalogItem(
  connectorSlug: ConnectorSlug,
  label: string,
  grantKind: GrantKind,
): PublicConnectorCatalogStatusItem {
  const methodId = grantKind === "openid-auth" ? "openid" : "oauth";
  return publicStatusItem({
    connectorSlug,
    label,
    singleAuthCodeAuthMethodId: grantKind === "auth-code" ? methodId : null,
    authMethods: [
      {
        id: methodId,
        label: grantKind === "openid-auth" ? "OpenID" : "OAuth",
        grantKind,
        description: null,
        supportsRefresh: grantKind === "auth-code",
        manualFields: [],
        startOptions: [],
      },
    ],
  });
}

function connectedAccount(
  connectorSlug: ConnectorSlug,
  id: string,
  authMethod: string,
): ConnectorAccountConnection {
  return {
    id,
    target: { kind: "builtin", connectorSlug },
    authMethod,
    displayName: `${connectorSlug} account`,
    isDefault: true,
    externalId: `${connectorSlug}-member`,
    externalUsername: "member",
    externalEmail: "member@example.test",
    oauthScopes: [],
    connectionStatus: "connected",
    scopeMismatch: false,
    missingRequiredFields: [],
    configuredFieldKeys: [],
    reconnectReason: null,
    tokenExpiresAt: null,
    createdAt: "2026-11-20T07:00:00.000Z",
    updatedAt: "2026-11-20T07:00:00.000Z",
  };
}

/** The member's accounts for one connector; a completed connection adds one. */
function mockConnector(
  item: PublicConnectorCatalogStatusItem,
  initial: readonly ConnectorAccountConnection[] = [],
): { accounts: ConnectorAccountConnection[] } {
  const server = { accounts: [...initial] };
  context.mocks.api(connectorCatalogContract.get, ({ params, respond }) => {
    return params.connectorSlug === item.slug
      ? respond(200, { connector: item })
      : respond(404, {
          error: { code: "NOT_FOUND", message: "Connector not found" },
        });
  });
  mockSavedConnectorAccounts(context, () => {
    return server.accounts;
  });
  return server;
}

function mockContinuation(): { prompt?: string; text?: string } {
  const continuation: { prompt?: string; text?: string } = {};
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    continuation.prompt = body.prompt;
    const text = body.userMessage?.parts.find((part) => {
      return part.type === "text";
    });
    continuation.text = text?.type === "text" ? text.text : undefined;
    return respond(201, { threadId: THREAD_ID });
  });
  return continuation;
}

function authorizationPath(connectorSlug: string): string {
  const query = new URLSearchParams({
    agentId: AGENT_ID,
    threadId: THREAD_ID,
    callbackPrompt: CALLBACK_PROMPT,
  });
  return `/connectors/${connectorSlug}/authorize?${query.toString()}`;
}

/** The provider window the connection opens, and where it navigated. */
function providerWindow() {
  const authWindow = context.mocks.browser.authWindow();
  authWindow.closed = false;
  const location = { href: "" };
  Object.defineProperty(authWindow, "location", {
    value: location,
    configurable: true,
  });
  context.mocks.browser.open(authWindow);
  return { window: authWindow, location };
}

function button(name: string): HTMLElement | undefined {
  return queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
}

async function findEnabledButton(name: string): Promise<HTMLElement> {
  return await waitFor(() => {
    const found = button(name);
    expect(found).toBeEnabled();
    return found as HTMLElement;
  });
}

async function openAuthorization(connectorSlug: string): Promise<void> {
  await setupPage({ context, path: authorizationPath(connectorSlug) });
}

test("Authorize an agent to use an already connected connector", async () => {
  mockConnector(catalogItem("gmail", "Gmail", "auth-code"), [
    connectedAccount("gmail", "e0000000-0000-4000-a000-000000000d01", "oauth"),
  ]);
  const continuation = mockContinuation();
  await openAuthorization("gmail");
  await expect(
    screen.findByText("Gmail connected"),
  ).resolves.toBeInTheDocument();

  click(await findEnabledButton("Continue"));

  await waitFor(() => {
    expect(button("Continue")).toBeUndefined();
  });
  expect(continuation).toStrictEqual({
    prompt: CALLBACK_PROMPT,
    text: CALLBACK_PROMPT,
  });
  expect(screen.getByText("Gmail connected")).toBeInTheDocument();
});

test("Connect and authorize an agent through OpenID", async () => {
  const server = mockConnector(catalogItem("steam", "Steam", "openid-auth"));
  const completions = mockOAuthCompletions(context);
  // The originating chat can continue once the connection settles.
  mockContinuation();
  const attempt = { id: "a0000000-0000-4000-a000-000000000d04" };
  context.mocks.api(
    builtinConnectorOpenIdStartContract.start,
    ({ respond }) => {
      return respond(200, {
        authorizationUrl: "https://steamcommunity.test/openid/login",
        oauthAttemptId: attempt.id,
      });
    },
  );
  const provider = providerWindow();
  await openAuthorization("steam");
  await expect(
    screen.findByText("Okou needs Steam to proceed"),
  ).resolves.toBeInTheDocument();

  click(await findEnabledButton("Connect"));

  await waitFor(() => {
    expect(provider.location.href).toBe(
      "https://steamcommunity.test/openid/login",
    );
  });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

  // Steam returns from OpenID and the API saves the member's account.
  const connectionId = "e0000000-0000-4000-a000-000000000d04";
  server.accounts.push(connectedAccount("steam", connectionId, "openid"));
  completions.set(attempt.id, connectionId);
  context.mocks.ably.trigger("connector:changed", { connectorSlug: "steam" });

  await expect(
    screen.findByText("Steam connected"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("Leave an agent unauthorized when OAuth progress is closed", async () => {
  mockConnector(catalogItem("github", "GitHub", "auth-code"));
  mockOAuthCompletions(context);
  const continuation = mockContinuation();
  context.mocks.api(builtinConnectorOauthStartContract.start, ({ respond }) => {
    return respond(200, {
      authorizationUrl: "https://github.test/login/oauth/authorize",
      oauthAttemptId: "a0000000-0000-4000-a000-000000000d06",
    });
  });
  const provider = providerWindow();
  await openAuthorization("github");
  click(await findEnabledButton("Connect"));
  await waitFor(() => {
    expect(provider.location.href).toBe(
      "https://github.test/login/oauth/authorize",
    );
  });

  // The member closes GitHub before approving access.
  provider.window.closed = true;

  await findEnabledButton("Connect");
  expect(screen.getByText("Okou needs GitHub to proceed")).toBeInTheDocument();
  expect(screen.queryByText("GitHub connected")).not.toBeInTheDocument();
  expect(continuation.prompt).toBeUndefined();
});
