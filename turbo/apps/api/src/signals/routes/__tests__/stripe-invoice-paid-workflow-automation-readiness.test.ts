import { randomUUID } from "node:crypto";

import type { BuiltinConnectorResponse } from "@okouai/api-contracts/contracts/connector-schemas";
import type { ConnectorAccountMutationIntent } from "@okouai/api-contracts/contracts/connector-accounts";
import {
  testStripeInvoicePaidFixtureContract,
  type TestStripeInvoicePaidFixtureState,
} from "@okouai/api-contracts/contracts/test-stripe-invoice-paid-readiness";
import { workflowAutomationsContract } from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import type { ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockStripeCliDashboardAuth,
  mockStripeConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { createRouteMocks } from "./helpers/route-test";
import { testStripeInvoicePaidReadinessRoutes } from "../test-stripe-invoice-paid-readiness";
import { workflowAutomationsRoutes } from "../workflow-automations";

const context = testContext();
const connectors = createConnectorBddApi(context);
const workflows = createWorkflowsBddApi(context);
const mocks = createRouteMocks(context);

const STRIPE_ACCOUNT_ID = "acct_live_workflow";

interface StripeAutomationScenario {
  readonly actor: ApiTestUser;
  readonly orgId: string;
  readonly workflowId: string;
}

interface StripeOAuthOptions {
  readonly account?: ConnectorAccountMutationIntent;
  readonly accountId?: string;
  readonly accessToken?: string;
  readonly code?: string;
  readonly livemode?: boolean;
}

interface ConnectedStripeOAuth {
  readonly code: string;
  readonly connector: BuiltinConnectorResponse;
  readonly provider: ReturnType<typeof mockStripeConnectorOAuth>;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" } as const;
}

function authenticate(scenario: StripeAutomationScenario): void {
  mocks.clerk.session(
    scenario.actor.userId,
    scenario.orgId,
    scenario.actor.orgRole ?? "org:member",
  );
}

function automationsClient() {
  return setupApp({ context, routes: workflowAutomationsRoutes })(
    workflowAutomationsContract,
  );
}

function createStripeAutomationRequest(
  scenario: StripeAutomationScenario,
  enabled = false,
) {
  authenticate(scenario);
  return automationsClient().create({
    headers: authHeaders(),
    params: { workflowId: scenario.workflowId },
    body: {
      kind: "event",
      eventType: "stripe-invoice-paid",
      eventConfig: {
        provider: "stripe",
        event: "invoice_paid",
        billingReasons: ["subscription_cycle"],
      },
      enabled,
    },
  });
}

function enableStripeAutomationRequest(
  scenario: StripeAutomationScenario,
  automationId: string,
) {
  authenticate(scenario);
  return automationsClient().enable({
    headers: authHeaders(),
    params: { id: automationId },
    body: undefined,
  });
}

async function setStripeFeature(
  scenario: StripeAutomationScenario,
  enabled: boolean,
): Promise<void> {
  await connectors.updateFeatureSwitches(scenario.actor, {
    [FeatureSwitchKey.StripeInvoicePaidWorkflowAutomations]: enabled,
  });
}

async function setupScenario(
  options: { readonly featureEnabled?: boolean } = {},
): Promise<StripeAutomationScenario> {
  const { actor } = await workflows.setupWorkflowOrg();
  if (!actor.orgId) {
    throw new Error("Expected an organization-scoped workflow owner");
  }
  const { agentId } = await workflows.createAgent(actor, {
    displayName: "Stripe Automation Agent",
  });
  const workflowId = await workflows.createWorkflow(actor, {
    agentId,
    name: `stripe-invoice-paid-${randomUUID()}`,
  });
  const scenario = { actor, orgId: actor.orgId, workflowId };
  if (options.featureEnabled !== false) {
    await setStripeFeature(scenario, true);
  }
  return scenario;
}

async function connectStripeOAuth(
  actor: ApiTestUser,
  options: StripeOAuthOptions = {},
): Promise<ConnectedStripeOAuth> {
  const provider = mockStripeConnectorOAuth({
    ...(options.accountId === undefined
      ? {}
      : { accountId: options.accountId }),
    ...(options.accessToken === undefined
      ? {}
      : { accessToken: options.accessToken }),
    ...(options.livemode === undefined ? {} : { livemode: options.livemode }),
  });
  const started = await connectors.startOauth(
    actor,
    "stripe",
    "oauth",
    undefined,
    options.account,
  );
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected Stripe OAuth state");
  }
  const code = options.code ?? `stripe-oauth-${randomUUID()}`;
  await connectors.completeOauthCallback("stripe", { code, state });
  const connector = await connectors.readConnectorBySlug(actor, "stripe");
  return { code, connector, provider };
}

async function applyCorruptFixture(
  connectorId: string,
  state: TestStripeInvoicePaidFixtureState,
): Promise<void> {
  const response = await accept(
    setupApp({
      context,
      routes: testStripeInvoicePaidReadinessRoutes,
    })(testStripeInvoicePaidFixtureContract).apply({
      body: { connector_id: connectorId, state },
    }),
    [200],
  );
  expect(response.body).toStrictEqual({ ok: true });
}

describe("Stripe invoice-paid workflow automation readiness", () => {
  it("gates creation before connector readiness while the feature is off", async () => {
    const scenario = await setupScenario({ featureEnabled: false });

    const rejected = await accept(
      createStripeAutomationRequest(scenario),
      [400],
    );

    expect(rejected.body.error.message).toBe(
      "Stripe invoice-paid workflow automations are not enabled",
    );
  });

  it("requires an exact owner Stripe connection", async () => {
    const scenario = await setupScenario();

    const rejected = await accept(
      createStripeAutomationRequest(scenario),
      [400],
    );

    expect(rejected.body.error.message).toContain("Connect Stripe with OAuth");
  });

  it("rejects a public api-token connection with OAuth guidance", async () => {
    const scenario = await setupScenario();
    const connected = await connectors.connectManualGrant(
      scenario.actor,
      "stripe",
      "api-token",
      { apiKey: "sk_test_stripe_workflow" },
    );
    expect(connected.authMethod).toBe("api-token");

    const rejected = await accept(
      createStripeAutomationRequest(scenario),
      [400],
    );

    expect(rejected.body.error.message).toMatch(/require OAuth/u);
  });

  it("rejects a public Stripe CLI connection with OAuth guidance", async () => {
    const scenario = await setupScenario();
    mockStripeCliDashboardAuth();
    const session = await connectors.startDeviceAuth(
      scenario.actor,
      "stripe",
      "cli",
      { mode: "live" },
    );
    mockNow(now() + 2000);
    const polled = await connectors.pollDeviceAuth(
      scenario.actor,
      "stripe",
      session.sessionId,
      session.sessionToken,
    );
    clearMockNow();
    if (polled.status !== "complete") {
      throw new Error(
        `Expected complete Stripe CLI auth, got ${polled.status}`,
      );
    }
    expect(polled.connector.authMethod).toBe("cli");

    const rejected = await accept(
      createStripeAutomationRequest(scenario),
      [400],
    );

    expect(rejected.body.error.message).toMatch(/require OAuth/u);
  });

  it("persists a storage-v3 Live Marketplace OAuth binding and supports the full lifecycle", async () => {
    const scenario = await setupScenario();
    const connected = await connectStripeOAuth(scenario.actor, {
      accessToken: "stripe-live-storage-v3-token",
      code: "stripe-live-storage-v3-code",
    });
    expect(connected.connector).toMatchObject({
      slug: "stripe",
      authMethod: "oauth",
      externalId: STRIPE_ACCOUNT_ID,
      connectionStatus: "connected",
    });
    expect(connected.provider.tokenBodies).toHaveLength(1);
    expect(connected.provider.tokenBodies[0]?.get("client_secret")).toBeNull();
    expect(connected.provider.tokenAuthorizationHeaders).toStrictEqual([
      `Basic ${btoa("sk_test_marketplace_secret:")}`,
    ]);
    expect(connected.provider.tokenBodies[0]?.get("code")).toBe(connected.code);
    expect(connected.provider.accountAuthorizationHeaders).toStrictEqual([
      "Bearer stripe-live-storage-v3-token",
    ]);

    const listedConnectors = await connectors.listBuiltinConnectors(
      scenario.actor,
    );
    expect(listedConnectors.connectorProvidedBindings).toContainEqual(
      expect.objectContaining({
        connectorSlug: "stripe",
        authMethod: "oauth",
        namespace: "secrets",
        name: "STRIPE_TOKEN",
        source: {
          kind: "connector-secret",
          name: "STRIPE_ACCESS_TOKEN",
        },
      }),
    );
    expect(
      listedConnectors.connectorProvidedBindings.some((binding) => {
        return binding.name === "STRIPE_LIVEMODE";
      }),
    ).toBeFalsy();

    const created = await accept(
      createStripeAutomationRequest(scenario),
      [201],
    );
    expect(created.body).toMatchObject({
      enabled: false,
      kind: "event",
      eventType: "stripe-invoice-paid",
      eventConfig: {
        provider: "stripe",
        event: "invoice_paid",
        billingReasons: ["subscription_cycle"],
        connectorId: connected.connector.id,
        stripeAccountId: STRIPE_ACCOUNT_ID,
        mode: "live",
      },
    });
    expect(JSON.stringify(created.body)).not.toContain(
      "stripe-live-storage-v3-token",
    );

    authenticate(scenario);
    const listed = await accept(
      automationsClient().list({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
      }),
      [200],
    );
    expect(listed.body).toContainEqual(
      expect.objectContaining({ id: created.body.id }),
    );
    authenticate(scenario);
    await expect(
      accept(
        automationsClient().get({
          headers: authHeaders(),
          params: { id: created.body.id },
        }),
        [200],
      ),
    ).resolves.toMatchObject({ body: { id: created.body.id } });

    const enabled = await accept(
      enableStripeAutomationRequest(scenario, created.body.id),
      [200],
    );
    expect(enabled.body.enabled).toBeTruthy();

    await setStripeFeature(scenario, false);
    authenticate(scenario);
    const listedWhileOff = await accept(
      automationsClient().list({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
      }),
      [200],
    );
    expect(listedWhileOff.body).toContainEqual(
      expect.objectContaining({ id: created.body.id }),
    );
    authenticate(scenario);
    await expect(
      accept(
        automationsClient().get({
          headers: authHeaders(),
          params: { id: created.body.id },
        }),
        [200],
      ),
    ).resolves.toMatchObject({ body: { id: created.body.id } });
    authenticate(scenario);
    const disabled = await accept(
      automationsClient().disable({
        headers: authHeaders(),
        params: { id: created.body.id },
        body: undefined,
      }),
      [200],
    );
    expect(disabled.body.enabled).toBeFalsy();
    const enableRejected = await accept(
      enableStripeAutomationRequest(scenario, created.body.id),
      [400],
    );
    expect(enableRejected.body.error.message).toContain("not enabled");
    authenticate(scenario);
    await accept(
      automationsClient().delete({
        headers: authHeaders(),
        params: { id: created.body.id },
        body: undefined,
      }),
      [204],
    );
  });

  it("rejects a fresh public Test-mode OAuth connection", async () => {
    const scenario = await setupScenario();
    const connected = await connectStripeOAuth(scenario.actor, {
      livemode: false,
    });
    expect(connected.connector.authMethod).toBe("oauth");

    const rejected = await accept(
      createStripeAutomationRequest(scenario),
      [400],
    );

    expect(rejected.body.error.message).toMatch(/require Live mode/u);
  });

  it("does not select same-account connections from another user or organization", async () => {
    const scenario = await setupScenario();
    const otherUser = workflows.user({
      userId: `user_other_${randomUUID()}`,
      orgId: scenario.orgId,
      orgRole: "org:member",
    });
    const otherOrg = workflows.user({
      userId: `user_other_org_${randomUUID()}`,
      orgId: `org_other_${randomUUID()}`,
      orgRole: "org:member",
    });
    await connectStripeOAuth(otherUser, { accountId: STRIPE_ACCOUNT_ID });
    await connectStripeOAuth(otherOrg, { accountId: STRIPE_ACCOUNT_ID });

    const rejected = await accept(
      createStripeAutomationRequest(scenario),
      [400],
    );

    expect(rejected.body.error.message).toContain("Connect Stripe with OAuth");
  });

  it("re-enables after a same-account Live OAuth reconnect", async () => {
    const scenario = await setupScenario();
    const initial = await connectStripeOAuth(scenario.actor);
    const created = await accept(
      createStripeAutomationRequest(scenario),
      [201],
    );
    const reconnected = await connectStripeOAuth(scenario.actor, {
      account: {
        intent: "reconnect",
        connectionId: initial.connector.id,
      },
      accountId: STRIPE_ACCOUNT_ID,
      livemode: true,
      code: "stripe-same-account-reconnect",
    });
    expect(reconnected.connector.id).toBe(initial.connector.id);

    const enabled = await accept(
      enableStripeAutomationRequest(scenario, created.body.id),
      [200],
    );
    expect(enabled.body.enabled).toBeTruthy();
  });

  it("reprojects after a Live OAuth external account change", async () => {
    const scenario = await setupScenario();
    const initial = await connectStripeOAuth(scenario.actor);
    const created = await accept(
      createStripeAutomationRequest(scenario),
      [201],
    );
    const reconnected = await connectStripeOAuth(scenario.actor, {
      accountId: "acct_different_workflow",
      livemode: true,
    });
    const accounts = await connectors.listBuiltinConnectorAccounts(
      scenario.actor,
      "stripe",
    );
    const replacement = accounts.find((account) => {
      return account.externalId === "acct_different_workflow";
    });
    if (!replacement) {
      throw new Error("Expected the replacement Stripe account");
    }
    expect(reconnected.connector.id).toBe(initial.connector.id);
    await connectors.deleteBuiltinConnectorAccount(
      scenario.actor,
      "stripe",
      initial.connector.id,
    );

    const enabled = await accept(
      enableStripeAutomationRequest(scenario, created.body.id),
      [200],
    );
    expect(enabled.body).toMatchObject({
      enabled: true,
      eventConfig: {
        connectorId: replacement.id,
        stripeAccountId: "acct_different_workflow",
        mode: "live",
      },
    });
  });

  it("fails closed after a Test-mode public OAuth reconnect", async () => {
    const scenario = await setupScenario();
    const initial = await connectStripeOAuth(scenario.actor);
    const created = await accept(
      createStripeAutomationRequest(scenario),
      [201],
    );
    const reconnected = await connectStripeOAuth(scenario.actor, {
      account: {
        intent: "reconnect",
        connectionId: initial.connector.id,
      },
      accountId: STRIPE_ACCOUNT_ID,
      livemode: false,
    });
    expect(reconnected.connector.id).toBe(initial.connector.id);

    const rejected = await accept(
      enableStripeAutomationRequest(scenario, created.body.id),
      [400],
    );
    expect(rejected.body.error.message).toMatch(/require Live mode/u);
  });

  it("reprojects after connector deletion and recreation", async () => {
    const scenario = await setupScenario();
    const initial = await connectStripeOAuth(scenario.actor);
    const created = await accept(
      createStripeAutomationRequest(scenario),
      [201],
    );
    await connectors.deleteDefaultBuiltinConnectorAccount(
      scenario.actor,
      "stripe",
    );
    const replacement = await connectStripeOAuth(scenario.actor, {
      accountId: STRIPE_ACCOUNT_ID,
      code: "stripe-recreated-connection",
    });
    expect(replacement.connector.id).not.toBe(initial.connector.id);

    const enabled = await accept(
      enableStripeAutomationRequest(scenario, created.body.id),
      [200],
    );
    expect(enabled.body).toMatchObject({
      enabled: true,
      eventConfig: {
        connectorId: replacement.connector.id,
        stripeAccountId: STRIPE_ACCOUNT_ID,
        mode: "live",
      },
    });
  });

  it("returns an explicit immutable error from the update route", async () => {
    const scenario = await setupScenario();
    await connectStripeOAuth(scenario.actor);
    const created = await accept(
      createStripeAutomationRequest(scenario),
      [201],
    );
    authenticate(scenario);

    const rejected = await accept(
      automationsClient().update({
        headers: authHeaders(),
        params: { id: created.body.id },
        body: {
          eventConfig: { provider: "gmail", event: "new_message" },
        },
      }),
      [400],
    );

    expect(rejected.body.error.message).toBe(
      "Stripe invoice-paid event automations cannot be updated",
    );
  });

  it.each([
    "storage-incompatible",
    "needs-reconnect",
    "missing-external-id",
    "blank-external-id",
    "missing-livemode",
    "malformed-livemode",
  ] as const)("fails closed through create for %s state", async (state) => {
    const scenario = await setupScenario();
    const connected = await connectStripeOAuth(scenario.actor);

    // The public OAuth API constructs the valid baseline. This fixture changes
    // only a state that no production connector endpoint can create.
    await applyCorruptFixture(connected.connector.id, state);
    const rejected = await accept(
      createStripeAutomationRequest(scenario),
      [400],
    );

    expect(rejected.body.error.message).toContain(
      "Reconnect Stripe with OAuth",
    );
  });
});
