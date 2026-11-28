import { randomUUID } from "node:crypto";
import { connectedConnectorsContract } from "@okouai/api-contracts/contracts/connected-connectors";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import {
  customConnectorOAuth2Contract,
  customConnectorsContract,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { http, HttpResponse } from "msw";
import { expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { connectedConnectorsRoutes } from "../connected-connectors";
import { connectorAccountRoutes } from "../connector-accounts";
import { connectorCatalogRoutes } from "../connector-catalog";
import { customConnectorsRoutes } from "../custom-connectors";
import { customConnectorOAuth2Routes } from "../custom-connectors-oauth2";
import type { ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockAutomaticMcpOAuthProvider,
} from "./helpers/api-bdd-connectors";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const connectors = createConnectorBddApi(context);
const directoryApi = setupApp({
  context,
  routes: connectedConnectorsRoutes,
})(connectedConnectorsContract);
const customApi = setupApp({
  context,
  routes: customConnectorsRoutes,
})(customConnectorsContract);
const customOAuthApi = setupApp({
  context,
  routes: customConnectorOAuth2Routes,
})(customConnectorOAuth2Contract);
const accountsApi = setupApp({
  context,
  routes: connectorAccountRoutes,
})(connectorAccountsContract);
const AUTH_HEADERS = Object.freeze({ authorization: "Bearer clerk-session" });
const DAY_MS = 24 * 60 * 60 * 1000;
const STRIPE_CLI_AUTH_URL = "https://dashboard.stripe.com/stripecli/auth";
const STRIPE_CLI_BROWSER_URL =
  "https://dashboard.stripe.com/stripecli/confirm_auth?t=tok_bdd";
const STRIPE_CLI_POLL_URL =
  "https://dashboard.stripe.com/stripecli/auth/sess_bdd";

function makeUser(): ApiTestUser {
  const userId = `user_${randomUUID()}`;
  return {
    userId,
    orgId: `org_${randomUUID()}`,
    orgRole: "org:admin",
    email: `${userId}@example.test`,
  };
}

function mockUniqueStripeCliAuth(): void {
  server.use(
    http.post(STRIPE_CLI_AUTH_URL, () => {
      return HttpResponse.json({
        browser_url: STRIPE_CLI_BROWSER_URL,
        poll_url: STRIPE_CLI_POLL_URL,
        verification_code: "STRIPE-CLI",
      });
    }),
    http.get(STRIPE_CLI_POLL_URL, () => {
      return HttpResponse.json({
        redeemed: true,
        account_id: `acct_${randomUUID()}`,
        account_display_name: "BDD Stripe",
        livemode_key_secret: "rk_live_api456",
        livemode_key_publishable: "pk_live_api456",
        testmode_key_secret: "rk_test_api123",
        testmode_key_publishable: "pk_test_api123",
      });
    }),
  );
}

function readDirectory(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(actor.userId, actor.orgId);
  return accept(directoryApi.list({ headers: AUTH_HEADERS }), [200]);
}

async function pollStripeSession(
  actor: ApiTestUser,
  sessionId: string,
  sessionToken: string,
) {
  const polled = await connectors.requestDeviceAuthPoll(
    actor,
    "stripe",
    sessionId,
    sessionToken,
    [200],
  );
  if (polled.status !== 200 || polled.body.status !== "complete") {
    throw new Error("Expected the Stripe authorization to complete");
  }
  return { id: polled.body.connectionId };
}

async function connectStripeAccount(
  actor: ApiTestUser,
  at: number,
  displayName?: string,
) {
  mockNow(at);
  const started = await connectors.startDeviceAuth(
    actor,
    "stripe",
    "cli",
    { mode: "live" },
    displayName === undefined
      ? { intent: "add" }
      : { intent: "add", displayName },
  );
  mockNow(at + 2000);
  return pollStripeSession(actor, started.sessionId, started.sessionToken);
}

/** A saved default Stripe live account issued 91 days ago, now expired. */
async function givenStaleStripeDefault() {
  const actor = makeUser();
  const today = now();
  mockUniqueStripeCliAuth();
  const stale = await connectStripeAccount(actor, today - 91 * DAY_MS);
  mockNow(today);
  return { actor, today, stale };
}

/** The stale Stripe default plus Work and Personal connected today. */
async function givenThreeStripeAccounts() {
  const { actor, today, stale } = await givenStaleStripeDefault();
  const work = await connectStripeAccount(actor, today, "Work");
  const personal = await connectStripeAccount(actor, today + 5000, "Personal");
  mockNow(today + 10_000);
  return { actor, stale, work, personal };
}

test("connected-connectors-accounts-001 (1/4) lists Stripe in the directory while the default must reconnect", async () => {
  const { actor } = await givenStaleStripeDefault();

  const directory = await readDirectory(actor);

  expect(directory.body).toStrictEqual({
    builtinConnectors: [expect.objectContaining({ slug: "stripe" })],
    customConnectors: [],
  });
});

test("connected-connectors-accounts-001 (2/4) reports two fresh accounts beside the reconnect-required default", async () => {
  const { actor, stale, work, personal } = await givenThreeStripeAccounts();

  const accounts = await connectors.listBuiltinConnectorAccounts(
    actor,
    "stripe",
  );
  expect(accounts).toHaveLength(3);
  const byId = new Map(
    accounts.map((account) => {
      return [account.id, account];
    }),
  );
  expect(byId.get(stale.id)).toMatchObject({
    isDefault: true,
    connectionStatus: "reconnect-required",
  });
  expect(byId.get(work.id)).toMatchObject({
    isDefault: false,
    connectionStatus: "connected",
  });
  expect(byId.get(personal.id)).toMatchObject({
    isDefault: false,
    connectionStatus: "connected",
  });
});

test("connected-connectors-accounts-001 (3/4) shows the Stripe catalog detail with the three accounts saved", async () => {
  const { actor } = await givenThreeStripeAccounts();

  createRouteMocks(context).clerk.session(actor.userId, actor.orgId);
  const detail = await accept(
    setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    ).get({ headers: AUTH_HEADERS, params: { connectorSlug: "stripe" } }),
    [200],
  );
  expect(detail.body.connector).toMatchObject({ slug: "stripe" });
});

test("connected-connectors-accounts-001 (4/4) empties the directory after all three accounts are deleted", async () => {
  const { actor, stale, work, personal } = await givenThreeStripeAccounts();

  await Promise.all([
    connectors.deleteBuiltinConnectorAccount(actor, "stripe", stale.id),
    connectors.deleteBuiltinConnectorAccount(actor, "stripe", work.id),
    connectors.deleteBuiltinConnectorAccount(actor, "stripe", personal.id),
  ]);

  const directory = await readDirectory(actor);
  expect(directory.body).toStrictEqual({
    builtinConnectors: [],
    customConnectors: [],
  });
});

async function startCustomAccountOAuth(
  actor: ApiTestUser,
  connectorId: string,
  displayName?: string,
) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  const started = await accept(
    customOAuthApi.start({
      headers: AUTH_HEADERS,
      params: { id: connectorId },
      body: {
        account:
          displayName === undefined
            ? { intent: "add" }
            : { intent: "add", displayName },
      },
    }),
    [200],
  );
  if (started.body.result !== "authorization") {
    throw new Error("Expected custom OAuth authorization URL");
  }
  const state = new URL(started.body.authorizationUrl).searchParams.get(
    "state",
  );
  if (!state) {
    throw new Error("Expected OAuth state");
  }
  return state;
}

async function finishCustomAccountOAuth(state: string, issuer: string) {
  const completed = await accept(
    customOAuthApi.callback({
      query: {
        state,
        code: `code-${randomUUID()}`,
        iss: issuer,
        responseMode: "json",
      },
    }),
    [200],
  );
  if (completed.body.status !== "success") {
    throw new Error("Expected the automatic OAuth connection to succeed");
  }
}

async function listCustomAccounts(actor: ApiTestUser, connectorId: string) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  const response = await accept(
    accountsApi.connections({
      headers: AUTH_HEADERS,
      query: { kind: "custom", customConnectorId: connectorId },
    }),
    [200],
  );
  return response.body.connections;
}

async function deleteCustomAccount(
  actor: ApiTestUser,
  connectorId: string,
  connectionId: string,
) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  await accept(
    accountsApi.delete({
      headers: AUTH_HEADERS,
      params: { connectionId },
      body: { target: { kind: "custom", customConnectorId: connectorId } },
    }),
    [200],
  );
}

async function createAutomaticCustomConnector(today: number) {
  const actor = makeUser();
  const provider = mockAutomaticMcpOAuthProvider(context, {
    registration: "dcr",
    authentication: "oauth",
    endpoint: `https://automatic-mcp-${randomUUID()}.example.test/server`,
    initialExpiresIn: 60,
    omitRefreshToken: true,
  });
  mockNow(today - 2 * 60 * 1000);
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  const created = await accept(
    customApi.create({
      headers: AUTH_HEADERS,
      body: {
        kind: "mcp",
        displayName: "Automatic directory",
        endpoint: provider.endpoint,
        transport: "streamable-http",
        authMode: "automatic",
        fields: [],
        headerInjections: [],
        queryInjections: [],
      },
    }),
    [201],
  );
  return { actor, provider, connectorId: created.body.id };
}

/**
 * An automatic streamable-HTTP MCP connector whose default grant was issued
 * two minutes ago with a 60-second lifetime and no refresh token.
 */
async function givenExpiredCustomDefault() {
  const today = now();
  const { actor, provider, connectorId } =
    await createAutomaticCustomConnector(today);
  const defaultState = await startCustomAccountOAuth(actor, connectorId);
  await finishCustomAccountOAuth(defaultState, provider.issuer);
  mockNow(today);
  return { actor, provider, connectorId };
}

/** The expired default plus Work and Personal connected now. */
async function givenThreeCustomAccounts() {
  const today = now();
  const { actor, provider, connectorId } =
    await createAutomaticCustomConnector(today);
  const defaultState = await startCustomAccountOAuth(actor, connectorId);
  const [, workState, personalState] = await Promise.all([
    finishCustomAccountOAuth(defaultState, provider.issuer),
    startCustomAccountOAuth(actor, connectorId, "Work"),
    startCustomAccountOAuth(actor, connectorId, "Personal"),
  ]);
  mockNow(today);
  await Promise.all([
    finishCustomAccountOAuth(workState, provider.issuer),
    finishCustomAccountOAuth(personalState, provider.issuer),
  ]);
  return { actor, connectorId };
}

test("connected-connectors-accounts-002 (1/4) lists only the custom connector while its default must reconnect", async () => {
  const { actor, connectorId } = await givenExpiredCustomDefault();

  const directory = await readDirectory(actor);

  expect(directory.body).toStrictEqual({
    builtinConnectors: [],
    customConnectors: [expect.objectContaining({ id: connectorId })],
  });
});

test("connected-connectors-accounts-002 (2/4) reports three saved accounts with two connected", async () => {
  const { actor, connectorId } = await givenThreeCustomAccounts();

  const accounts = await listCustomAccounts(actor, connectorId);

  expect(accounts).toHaveLength(3);
  expect(
    accounts.filter((account) => {
      return account.connectionStatus === "connected";
    }),
  ).toHaveLength(2);
});

test("connected-connectors-accounts-002 (3/4) keeps the exact custom connector in the definitions list", async () => {
  const { actor, connectorId } = await givenThreeCustomAccounts();

  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  const definitions = await accept(
    customApi.list({ headers: AUTH_HEADERS }),
    [200],
  );

  expect(
    definitions.body.connectors.map((definition) => {
      return definition.id;
    }),
  ).toContain(connectorId);
});

test("connected-connectors-accounts-002 (4/4) empties the directory after all three accounts are deleted", async () => {
  const { actor, connectorId } = await givenThreeCustomAccounts();
  const accounts = await listCustomAccounts(actor, connectorId);
  expect(accounts).toHaveLength(3);

  const nonDefault = accounts.filter((account) => {
    return !account.isDefault;
  });
  const currentDefault = accounts.find((account) => {
    return account.isDefault;
  });
  await Promise.all(
    nonDefault.map((account) => {
      return deleteCustomAccount(actor, connectorId, account.id);
    }),
  );
  if (currentDefault) {
    await deleteCustomAccount(actor, connectorId, currentDefault.id);
  }

  const directory = await readDirectory(actor);
  expect(directory.body).toStrictEqual({
    builtinConnectors: [],
    customConnectors: [],
  });
});
