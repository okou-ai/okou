import { randomUUID } from "node:crypto";
import { chatThreadConnectorSelectionContract } from "@okouai/api-contracts/contracts/chat-threads";
import {
  connectorAccountsContract,
  type ConnectorAccountConnection,
} from "@okouai/api-contracts/contracts/connector-accounts";
import type { BuiltinConnectorResponse } from "@okouai/api-contracts/contracts/connector-schemas";
import { workflowAutomationsContract } from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { beforeEach, describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockOptionalEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { mockStripeWebhookEventConstructor } from "../../external/stripe-client";
import type { ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockGitHubConnectorOAuth,
  mockStripeConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { createRouteMocks } from "./helpers/route-test";
import { webhooksStripeAutomationEventsRoutes } from "../webhooks-stripe-automation-events";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { chatThreadRoutes } from "../chat-threads";
import { connectorAccountRoutes } from "../connector-accounts";

const context = testContext();
const connectors = createConnectorBddApi(context);
const runs = createRunsApi(context);
const workflows = createWorkflowsBddApi(context);
const mocks = createRouteMocks(context);

const AUTOMATION_WEBHOOK_SECRET = "whsec_stripe_automation_events";
const STRIPE_ACCOUNT_ID = "acct_stripe_workflow_live";

interface Scenario {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly workflowId: string;
  readonly automationId: string;
  readonly chatThreadId: string;
  readonly connector: BuiltinConnectorResponse;
  readonly runnerGroup: string;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" } as const;
}

function automationsClient() {
  return setupApp({ context, routes: workflowAutomationsRoutes })(
    workflowAutomationsContract,
  );
}

async function connectStripeOAuth(
  actor: ApiTestUser,
  accountId: string,
  livemode = true,
): Promise<BuiltinConnectorResponse> {
  mockStripeConnectorOAuth({ accountId, livemode });
  const started = await connectors.startOauth(actor, "stripe", "oauth");
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected Stripe OAuth state");
  }
  await connectors.completeOauthCallback("stripe", {
    code: `stripe-workflow-${randomUUID()}`,
    state,
  });
  return await connectors.readConnectorBySlug(actor, "stripe");
}

async function setupScenario(
  options: {
    readonly accountId?: string;
    readonly billingReasons?: readonly (
      "manual" | "subscription_cycle" | "subscription_create"
    )[];
  } = {},
): Promise<Scenario> {
  const runnerGroup = runs.configureRunnerGroup();
  const { actor } = await workflows.setupWorkflowOrg();
  if (!actor.orgId) {
    throw new Error("Expected an organization-scoped workflow owner");
  }
  // Fable keeps Stripe workflow runs on the claimable native Runner route.
  await runs.ensurePersonalSubscriptionModel(actor, {
    model: "claude-fable-5-1",
  });
  const { agentId } = await workflows.createAgent(actor, {
    displayName: "Stripe Automation Event Agent",
  });
  const workflowId = await workflows.createWorkflow(actor, {
    agentId,
    name: `stripe-automation-events-${randomUUID()}`,
  });
  await connectors.updateFeatureSwitches(actor, {
    [FeatureSwitchKey.StripeInvoicePaidWorkflowAutomations]: true,
  });
  const connector = await connectStripeOAuth(
    actor,
    options.accountId ?? STRIPE_ACCOUNT_ID,
  );
  mocks.clerk.session(actor.userId, actor.orgId);
  const created = await accept(
    automationsClient().create({
      headers: authHeaders(),
      params: { workflowId },
      body: {
        kind: "event",
        eventType: "stripe-invoice-paid",
        eventConfig: {
          provider: "stripe",
          event: "invoice_paid",
          ...(options.billingReasons === undefined
            ? {}
            : { billingReasons: [...options.billingReasons] }),
        },
        enabled: true,
      },
    }),
    [201],
  );
  if (
    created.body.kind !== "event" ||
    created.body.eventType !== "stripe-invoice-paid" ||
    !created.body.chatThreadId
  ) {
    throw new Error("Expected a thread-bound Stripe event automation");
  }
  return {
    actor,
    agentId,
    workflowId,
    automationId: created.body.id,
    chatThreadId: created.body.chatThreadId,
    connector,
    runnerGroup,
  };
}

function invoicePaidEvent(
  options: {
    readonly accountId?: string;
    readonly billingReason?: string | null;
    readonly eventId?: string;
    readonly invoiceId?: string;
    readonly invoiceFields?: Readonly<Record<string, unknown>>;
    readonly livemode?: boolean;
  } = {},
) {
  return {
    id: options.eventId ?? `evt_${randomUUID()}`,
    type: "invoice.paid",
    account: options.accountId ?? STRIPE_ACCOUNT_ID,
    livemode: options.livemode ?? true,
    created: Math.floor(now() / 1000),
    data: {
      object: {
        id: options.invoiceId ?? `in_${randomUUID()}`,
        object: "invoice",
        status: "paid",
        billing_reason: options.billingReason ?? "subscription_cycle",
        amount_paid: 4200,
        amount_due: 4200,
        currency: "usd",
        collection_method: "charge_automatically",
        hosted_invoice_url: "https://invoice.stripe.example/hosted",
        invoice_pdf: "https://invoice.stripe.example/invoice.pdf",
        metadata: { source: "workflow-test" },
        customer: {
          id: "cus_workflow",
          name: "Workflow Customer",
          email: "customer@example.test",
        },
        subscription: "sub_workflow",
        payment_intent: "pi_workflow",
        parent: {
          type: "subscription_details",
          subscription_details: {
            subscription: "sub_current_workflow",
            metadata: { source: "current-parent" },
          },
        },
        payments: {
          data: [
            {
              id: "inpay_workflow",
              payment: {
                type: "payment_intent",
                payment_intent: "pi_current_workflow",
              },
            },
          ],
        },
        lines: {
          data: [
            {
              id: "il_workflow",
              object: "line_item",
              description: "Workflow subscription",
              quantity: 1,
              amount: 4200,
              currency: "usd",
              metadata: { plan: "workflow" },
              period: { start: 1_786_060_800, end: 1_788_739_200 },
              price: {
                id: "price_workflow",
                product: "prod_workflow",
                currency: "usd",
                unit_amount: 4200,
                recurring: { interval: "month" },
              },
            },
          ],
          has_more: true,
          total_count: 2,
        },
        ...options.invoiceFields,
      },
    },
  };
}

async function postStripeAutomationEvent(
  event: object,
  expectedStatus = 200,
): Promise<Response> {
  context.mocks.stripe.webhooks.constructEvent.mockReturnValueOnce(event);
  const body = JSON.stringify(event);
  const response = await createApp({
    signal: context.signal,
    routes: webhooksStripeAutomationEventsRoutes,
  }).request("/api/webhooks/stripe-automation-events", {
    method: "POST",
    body,
    headers: { "stripe-signature": "t=1,v1=stripe-automation" },
  });
  expect(response.status).toBe(expectedStatus);
  return response;
}

async function setAutomationEnabled(
  scenario: Scenario,
  enabled: boolean,
): Promise<void> {
  mocks.clerk.session(scenario.actor.userId, scenario.actor.orgId);
  const response = await accept(
    enabled
      ? automationsClient().enable({
          headers: authHeaders(),
          params: { id: scenario.automationId },
          body: undefined,
        })
      : automationsClient().disable({
          headers: authHeaders(),
          params: { id: scenario.automationId },
          body: undefined,
        }),
    [200],
  );
  expect(response.body.enabled).toBe(enabled);
}

async function readStripeAutomation(scenario: Scenario) {
  mocks.clerk.session(scenario.actor.userId, scenario.actor.orgId);
  const summary = await workflows.readAutomation(scenario.automationId);
  if (summary.kind !== "event" || summary.eventType !== "stripe-invoice-paid") {
    throw new Error("Expected a Stripe invoice-paid automation summary");
  }
  return summary;
}

function chatThreadConnectorSelectionsClient() {
  return setupApp({ context, routes: chatThreadRoutes })(
    chatThreadConnectorSelectionContract,
  );
}

function connectorAccountsClient() {
  return setupApp({ context, routes: connectorAccountRoutes })(
    connectorAccountsContract,
  );
}

async function addStripeOAuthAccount(
  actor: ApiTestUser,
  displayName: string,
  accountId: string,
): Promise<ConnectorAccountConnection> {
  mockStripeConnectorOAuth({ accountId, livemode: true });
  const started = await connectors.startOauth(
    actor,
    "stripe",
    "oauth",
    undefined,
    { intent: "add", displayName },
  );
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected Stripe OAuth state");
  }
  await connectors.completeOauthCallback("stripe", {
    code: `stripe-workflow-${randomUUID()}`,
    state,
  });
  mocks.clerk.session(actor.userId, actor.orgId);
  const accounts = await accept(
    connectorAccountsClient().connections({
      headers: authHeaders(),
      query: { kind: "builtin", connectorSlug: "stripe", limit: 100 },
    }),
    [200],
  );
  const account = accounts.body.connections.find((connection) => {
    return connection.displayName === displayName;
  });
  if (!account) {
    throw new Error(`Expected Stripe account ${displayName}`);
  }
  return account;
}

async function deleteAutomation(scenario: Scenario): Promise<void> {
  mocks.clerk.session(scenario.actor.userId, scenario.actor.orgId);
  await accept(
    automationsClient().delete({
      headers: authHeaders(),
      params: { id: scenario.automationId },
      body: undefined,
    }),
    [204],
  );
}

beforeEach(() => {
  mockStripeWebhookEventConstructor((rawBody, signature, secret) => {
    return context.mocks.stripe.webhooks.constructEvent(
      rawBody,
      signature,
      secret,
    );
  });
  mockOptionalEnv(
    "STRIPE_AUTOMATION_WEBHOOK_SECRET",
    AUTOMATION_WEBHOOK_SECRET,
  );
});

describe("Stripe automation event webhook", () => {
  it("reprojects to the default account when the thread selection is cleared", async () => {
    const originalAccountId = `acct_stripe_clear_original_${randomUUID()}`;
    const threadAccountId = `acct_stripe_clear_thread_${randomUUID()}`;
    const defaultAccountId = `acct_stripe_clear_default_${randomUUID()}`;
    const scenario = await setupScenario({ accountId: originalAccountId });
    const orgId = scenario.actor.orgId;
    if (!orgId) {
      throw new Error("Expected an organization-scoped workflow owner");
    }
    await connectors.updateFeatureSwitches(scenario.actor, {});
    await runs.enableAgentConnectors(scenario.actor, scenario.agentId, [
      "stripe",
    ]);
    const threadAccount = await addStripeOAuthAccount(
      scenario.actor,
      "Cleared thread account",
      threadAccountId,
    );
    const defaultAccount = await addStripeOAuthAccount(
      scenario.actor,
      "Cleared default account",
      defaultAccountId,
    );
    mocks.clerk.session(scenario.actor.userId, orgId);
    await accept(
      connectorAccountsClient().setDefault({
        headers: authHeaders(),
        params: { connectionId: defaultAccount.id },
        body: { target: { kind: "builtin", connectorSlug: "stripe" } },
      }),
      [200],
    );
    await accept(
      chatThreadConnectorSelectionsClient().update({
        headers: authHeaders(),
        params: { id: scenario.chatThreadId },
        body: {
          connectionId: threadAccount.id,
          target: { kind: "builtin", connectorSlug: "stripe" },
        },
      }),
      [200],
    );
    await accept(
      chatThreadConnectorSelectionsClient().clear({
        headers: authHeaders(),
        params: { id: scenario.chatThreadId },
        body: { kind: "builtin", connectorSlug: "stripe" },
      }),
      [204],
    );

    await expect(readStripeAutomation(scenario)).resolves.toMatchObject({
      eventConfig: {
        connectorId: defaultAccount.id,
        stripeAccountId: defaultAccountId,
        mode: "live",
      },
    });
  });

  it("creates a Stripe automation against the selected thread account", async () => {
    const originalAccountId = `acct_stripe_create_original_${randomUUID()}`;
    const threadAccountId = `acct_stripe_create_thread_${randomUUID()}`;
    const scenario = await setupScenario({ accountId: originalAccountId });
    const orgId = scenario.actor.orgId;
    if (!orgId) {
      throw new Error("Expected an organization-scoped workflow owner");
    }
    await connectors.updateFeatureSwitches(scenario.actor, {});
    await runs.enableAgentConnectors(scenario.actor, scenario.agentId, [
      "stripe",
    ]);
    const threadAccount = await addStripeOAuthAccount(
      scenario.actor,
      "Creation thread account",
      threadAccountId,
    );
    mocks.clerk.session(scenario.actor.userId, orgId);
    await accept(
      chatThreadConnectorSelectionsClient().update({
        headers: authHeaders(),
        params: { id: scenario.chatThreadId },
        body: {
          connectionId: threadAccount.id,
          target: { kind: "builtin", connectorSlug: "stripe" },
        },
      }),
      [200],
    );
    await deleteAutomation(scenario);

    mocks.clerk.session(scenario.actor.userId, orgId);
    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId: scenario.workflowId },
        body: {
          kind: "event",
          eventType: "stripe-invoice-paid",
          eventConfig: { provider: "stripe", event: "invoice_paid" },
          enabled: true,
        },
      }),
      [201],
    );
    expect(created.body).toMatchObject({
      chatThreadId: scenario.chatThreadId,
      eventConfig: {
        connectorId: threadAccount.id,
        stripeAccountId: threadAccountId,
        mode: "live",
      },
    });
  });

  it("keeps the existing billing webhook operational without the automation secret", async () => {
    mockOptionalEnv("STRIPE_AUTOMATION_WEBHOOK_SECRET", undefined);
    const actor = workflows.user();
    const billing = { actor, ...(await runs.grantProEntitlement(actor)) };
    expect(billing).toMatchObject({
      actor: { orgId: expect.any(String) },
      customerId: expect.any(String),
      subscriptionId: expect.any(String),
      invoiceId: expect.any(String),
    });
  });

  it("uses the dedicated secret and classifies boundary failures", async () => {
    mockOptionalEnv("STRIPE_WEBHOOK_SECRET", "whsec_billing_unchanged");
    mockOptionalEnv("STRIPE_AUTOMATION_WEBHOOK_SECRET", undefined);
    const unconfigured = await createApp({
      signal: context.signal,
      routes: webhooksStripeAutomationEventsRoutes,
    }).request("/api/webhooks/stripe-automation-events", {
      method: "POST",
      body: "{}",
    });
    expect(unconfigured.status).toBe(503);

    mockOptionalEnv(
      "STRIPE_AUTOMATION_WEBHOOK_SECRET",
      AUTOMATION_WEBHOOK_SECRET,
    );
    const unsigned = await createApp({
      signal: context.signal,
      routes: webhooksStripeAutomationEventsRoutes,
    }).request("/api/webhooks/stripe-automation-events", {
      method: "POST",
      body: "{}",
    });
    expect(unsigned.status).toBe(401);

    context.mocks.stripe.webhooks.constructEvent.mockImplementationOnce(() => {
      throw new Error("invalid signature");
    });
    const invalidSignature = await createApp({
      signal: context.signal,
      routes: webhooksStripeAutomationEventsRoutes,
    }).request("/api/webhooks/stripe-automation-events", {
      method: "POST",
      body: "{}",
      headers: { "stripe-signature": "invalid" },
    });
    expect(invalidSignature.status).toBe(401);

    await postStripeAutomationEvent(
      { type: "invoice.paid", livemode: true },
      400,
    );
    await postStripeAutomationEvent(
      {
        ...invoicePaidEvent({ eventId: "evt_missing_account" }),
        account: undefined,
      },
      400,
    );
    await postStripeAutomationEvent(
      invoicePaidEvent({ eventId: "evt_test_mode", livemode: false }),
      200,
    );
    await postStripeAutomationEvent({ type: "customer.created" }, 200);
    const unmapped = invoicePaidEvent({ eventId: "evt_unmapped_live" });
    await postStripeAutomationEvent(unmapped, 200);

    expect(
      context.mocks.stripe.webhooks.constructEvent,
    ).toHaveBeenLastCalledWith(
      JSON.stringify(unmapped),
      "t=1,v1=stripe-automation",
      AUTOMATION_WEBHOOK_SECRET,
    );
  });

  it("accepts concurrent Live Stripe snapshots and exposes pending delivery health", async () => {
    const receivedAt = Date.parse("2026-08-07T08:00:00.000Z");
    mockNow(receivedAt);
    const scenario = await setupScenario({
      billingReasons: ["subscription_cycle"],
    });
    expect((await readStripeAutomation(scenario)).health).toStrictEqual({
      lastMatchingEventReceivedAt: null,
      lastDeliveryStatus: null,
      lastDeliveryStatusAt: null,
      warning: null,
    });

    const event = invoicePaidEvent({
      eventId: "evt_workflow_once",
      invoiceId: "in_workflow_once",
    });

    await Promise.all([
      postStripeAutomationEvent(event),
      postStripeAutomationEvent(event),
    ]);

    expect((await readStripeAutomation(scenario)).health).toStrictEqual({
      lastMatchingEventReceivedAt: "2026-08-07T08:00:00.000Z",
      lastDeliveryStatus: "pending",
      lastDeliveryStatusAt: "2026-08-07T08:00:00.000Z",
      warning: null,
    });
  });

  it("ignores receipts for disabled automations", async () => {
    const disabledAtReceipt = await setupScenario({
      accountId: "acct_stripe_disabled_at_receipt",
    });
    await setAutomationEnabled(disabledAtReceipt, false);
    await postStripeAutomationEvent(
      invoicePaidEvent({
        accountId: "acct_stripe_disabled_at_receipt",
        eventId: "evt_disabled_at_receipt",
      }),
    );
    expect(
      (await readStripeAutomation(disabledAtReceipt)).health,
    ).toMatchObject({
      lastMatchingEventReceivedAt: null,
      lastDeliveryStatus: null,
    });
  });

  it("ignores receipts when the owner feature flag is off", async () => {
    const featureOffAtReceipt = await setupScenario({
      accountId: "acct_stripe_feature_off_at_receipt",
    });
    await connectors.updateFeatureSwitches(featureOffAtReceipt.actor, {
      [FeatureSwitchKey.StripeInvoicePaidWorkflowAutomations]: false,
    });
    await postStripeAutomationEvent(
      invoicePaidEvent({
        accountId: "acct_stripe_feature_off_at_receipt",
        eventId: "evt_feature_off_at_receipt",
      }),
    );
    expect(
      (await readStripeAutomation(featureOffAtReceipt)).health,
    ).toMatchObject({
      lastMatchingEventReceivedAt: null,
      lastDeliveryStatus: null,
    });
  });

  it("updates receipt health across filters for unknown billing reasons", async () => {
    const accountId = `acct_stripe_unknown_${randomUUID()}`;
    const filtered = await setupScenario({
      accountId,
      billingReasons: ["manual"],
    });
    const unfiltered = await setupScenario({ accountId });
    const unknownReasonEvent = invoicePaidEvent({
      accountId,
      eventId: "evt_unknown_billing_reason",
      billingReason: "future_reason",
    });

    await postStripeAutomationEvent(unknownReasonEvent);

    expect((await readStripeAutomation(filtered)).health).toMatchObject({
      lastMatchingEventReceivedAt: expect.any(String),
      lastDeliveryStatus: null,
    });
    expect((await readStripeAutomation(unfiltered)).health).toMatchObject({
      lastMatchingEventReceivedAt: expect.any(String),
      lastDeliveryStatus: "pending",
    });
  });

  it("validates deauthorization before dropping test events and leaves connections unchanged for rejected or ignored events", async () => {
    const accountId = `acct_stripe_boundary_${randomUUID()}`;
    const { actor } = await workflows.setupWorkflowOrg();
    const connected = await connectStripeOAuth(actor, accountId);
    const event = {
      id: `evt_${randomUUID()}`,
      type: "account.application.deauthorized",
      account: accountId,
      livemode: true,
      created: Math.floor(now() / 1000),
      data: { object: {} },
    };

    for (const malformed of [
      { ...event, type: undefined },
      { ...event, id: undefined },
      { ...event, created: -1 },
      { ...event, livemode: undefined },
      { ...event, data: undefined },
      { ...event, account: undefined },
      { ...event, livemode: false, data: undefined },
      { ...event, livemode: false, account: "" },
    ]) {
      const rejected = await postStripeAutomationEvent(malformed, 400);
      await expect(rejected.json()).resolves.toStrictEqual({
        error: "Invalid supported Stripe automation event",
      });
    }
    // The base test-mode schema permits no account; live validation does not.
    for (const ignored of [
      { ...event, livemode: false },
      { ...event, livemode: false, account: undefined },
      { type: "customer.created", account: accountId },
    ]) {
      const dropped = await postStripeAutomationEvent(ignored);
      await expect(dropped.text()).resolves.toBe("OK");
    }
    await expect(
      connectors.readConnectorBySlug(actor, "stripe"),
    ).resolves.toStrictEqual(connected);
  });

  it("marks all matching OAuth connections across owners, preserves other connections, and accepts repeated deauthorization", async () => {
    const accountId = `acct_stripe_deauthorized_${randomUUID()}`;
    const affected = await setupScenario({ accountId });
    const sharedOwner = await setupScenario({ accountId });
    const unaffected = await setupScenario({
      accountId: `acct_stripe_other_${randomUUID()}`,
    });
    const additionalAccount = await addStripeOAuthAccount(
      affected.actor,
      "Shared Stripe account",
      accountId,
    );
    const apiToken = await connectors.connectManualGrant(
      affected.actor,
      "stripe",
      "api-token",
      { apiKey: "sk_test_stripe_deauthorization" },
    );
    mockGitHubConnectorOAuth();
    const githubStart = await connectors.startOauth(
      unaffected.actor,
      "github",
      "oauth",
    );
    const githubState = new URL(githubStart.authorizationUrl).searchParams.get(
      "state",
    );
    if (!githubState) {
      throw new Error("Expected GitHub OAuth state");
    }
    await connectors.completeOauthCallback("github", {
      code: `github-deauthorization-${randomUUID()}`,
      state: githubState,
    });
    const github = await connectors.readConnectorBySlug(
      unaffected.actor,
      "github",
    );
    await postStripeAutomationEvent(
      invoicePaidEvent({ accountId, eventId: `evt_${randomUUID()}` }),
    );
    const deauthorization = {
      id: `evt_${randomUUID()}`,
      type: "account.application.deauthorized",
      account: accountId,
      livemode: true,
      created: Math.floor(now() / 1000),
      data: { object: {} },
    };
    const firstReceivedAt = Date.parse("2026-10-08T11:00:00.000Z");
    mockNow(firstReceivedAt);
    await postStripeAutomationEvent(deauthorization);
    for (const owner of [affected, sharedOwner]) {
      await expect(
        connectors.readConnectorBySlug(owner.actor, "stripe"),
      ).resolves.toMatchObject({
        connectionStatus: "reconnect-required",
        reconnectReason: "authorization_expired_or_revoked",
        updatedAt: new Date(firstReceivedAt).toISOString(),
      });
    }

    const repeatedAt = firstReceivedAt + 60_000;
    mockNow(repeatedAt);
    await postStripeAutomationEvent(deauthorization);
    for (const owner of [affected, sharedOwner]) {
      await expect(
        connectors.readConnectorBySlug(owner.actor, "stripe"),
      ).resolves.toMatchObject({
        connectionStatus: "reconnect-required",
        reconnectReason: "authorization_expired_or_revoked",
        updatedAt: new Date(repeatedAt).toISOString(),
      });
      await expect(readStripeAutomation(owner)).resolves.toMatchObject({
        id: owner.automationId,
        enabled: true,
      });
    }
    const accounts = await connectors.listBuiltinConnectorAccounts(
      affected.actor,
      "stripe",
    );
    expect(accounts).toContainEqual(
      expect.objectContaining({
        id: additionalAccount.id,
        connectionStatus: "reconnect-required",
        reconnectReason: "authorization_expired_or_revoked",
        updatedAt: new Date(repeatedAt).toISOString(),
      }),
    );
    expect(accounts).toContainEqual(
      expect.objectContaining({
        id: apiToken.id,
        authMethod: "api-token",
        connectionStatus: "connected",
        updatedAt: apiToken.updatedAt,
      }),
    );
    await expect(
      connectors.readConnectorBySlug(unaffected.actor, "stripe"),
    ).resolves.toStrictEqual(unaffected.connector);
    await expect(
      connectors.readConnectorBySlug(unaffected.actor, "github"),
    ).resolves.toStrictEqual(github);
  });
});
