import { randomUUID } from "node:crypto";

import { chatThreadConnectorSelectionContract } from "@okouai/api-contracts/contracts/chat-threads";
import {
  connectorAccountsContract,
  type ConnectorAccountConnection,
} from "@okouai/api-contracts/contracts/connector-accounts";
import type { ConnectorResponse } from "@okouai/api-contracts/contracts/connector-schemas";
import {
  testStripeAutomationEventFixtureContract,
  type TestStripeAutomationEventFixtureAction,
} from "@okouai/api-contracts/contracts/test-stripe-automation-events";
import { testWorkflowAutomationExecutionContract } from "@okouai/api-contracts/contracts/test-workflow-automation-execution";
import { workflowAutomationsContract } from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockOptionalEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { mockStripeWebhookEventConstructor } from "../../external/stripe-client";
import { flushWaitUntilForTest } from "../../context/wait-until";
import type { ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockStripeConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { chatEventDisplayText } from "./helpers/chat-event";
import { setConnectorAccountState } from "./helpers/connector-credential-storage-state";
import { createRouteMocks } from "./helpers/route-test";
import { testStripeAutomationEventRoutes } from "../test-stripe-automation-events";
import { testWorkflowAutomationExecutionRoutes } from "../test-workflow-automation-execution";
import { chatThreadRoutes } from "../chat-threads";
import { connectorAccountRoutes } from "../connector-accounts";
import { webhooksStripeAutomationEventsRoutes } from "../webhooks-stripe-automation-events";
import { workflowAutomationsRoutes } from "../workflow-automations";

const context = testContext();
const connectors = createConnectorBddApi(context);
const runs = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);
const workflows = createWorkflowsBddApi(context);
const mocks = createRouteMocks(context);

const AUTOMATION_WEBHOOK_SECRET = "whsec_stripe_automation_events";
const STRIPE_ACCOUNT_ID = "acct_stripe_workflow_live";
const EXECUTED_EXECUTION = {
  success: true,
  executed: 1,
  skipped: 0,
} as const;
const NO_EXECUTION = {
  success: true,
  executed: 0,
  skipped: 0,
} as const;
const TERMINALLY_SKIPPED_EXECUTION = {
  success: true,
  executed: 0,
  skipped: 1,
} as const;

interface Scenario {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly workflowId: string;
  readonly automationId: string;
  readonly chatThreadId: string;
  readonly connector: ConnectorResponse;
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

function workflowAutomationExecutionClient() {
  return setupApp({
    context,
    routes: testWorkflowAutomationExecutionRoutes,
  })(testWorkflowAutomationExecutionContract);
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

async function connectStripeOAuth(
  actor: ApiTestUser,
  accountId: string,
  livemode = true,
): Promise<ConnectorResponse> {
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

async function reconnectStripeOAuthAccount(
  actor: ApiTestUser,
  connectorId: string,
  accountId: string,
  livemode: boolean,
): Promise<void> {
  mockStripeConnectorOAuth({ accountId, livemode });
  const started = await connectors.startOauth(
    actor,
    "stripe",
    "oauth",
    undefined,
    { intent: "reconnect", connectionId: connectorId },
  );
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected Stripe OAuth reconnect state");
  }
  await connectors.completeOauthCallback("stripe", {
    code: `stripe-workflow-reconnect-${randomUUID()}`,
    state,
  });
}

async function setupScenario(
  options: {
    readonly accountId?: string;
    readonly billingReasons?: readonly (
      | "manual"
      | "subscription_cycle"
      | "subscription_create"
    )[];
  } = {},
): Promise<Scenario> {
  const runnerGroup = runs.configureRunnerGroup();
  const { actor } = await workflows.setupWorkflowOrg();
  if (!actor.orgId) {
    throw new Error("Expected an organization-scoped workflow owner");
  }
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

async function executeAutomation(scenario: Scenario) {
  return await accept(
    workflowAutomationExecutionClient().execute({
      body: { automation_id: scenario.automationId },
    }),
    [200],
  );
}

async function applyDeliveryFixture(
  scenario: Scenario,
  action: TestStripeAutomationEventFixtureAction,
): Promise<void> {
  const response = await accept(
    setupApp({ context, routes: testStripeAutomationEventRoutes })(
      testStripeAutomationEventFixtureContract,
    ).apply({
      body: { automation_id: scenario.automationId, action },
    }),
    [200],
  );
  expect(response.body).toStrictEqual({ ok: true });
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

async function automationInputEvents(scenario: Scenario) {
  mocks.clerk.session(scenario.actor.userId, scenario.actor.orgId);
  const events = await workflows.readThreadEvents(scenario.chatThreadId);
  return events.filter((event) => {
    return event.eventType === "input.automation";
  });
}

function eventContextFromPrompt(prompt: string): Record<string, unknown> {
  const marker = ["Event data:\n", "# This run's event\n"].find((candidate) => {
    return prompt.includes(candidate);
  });
  if (!marker) {
    throw new Error("Expected Stripe event context in runner prompt");
  }
  const markerIndex = prompt.indexOf(marker);
  return z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(prompt.slice(markerIndex + marker.length)));
}

async function claimScenarioRun(scenario: Scenario, stripeEventId?: string) {
  mocks.clerk.session(scenario.actor.userId, scenario.actor.orgId);
  const events = await workflows.readThreadEvents(scenario.chatThreadId);
  for (const event of events) {
    if (!event.runId) {
      continue;
    }
    const claim = await runs.claimRunnerJob(event.runId);
    const automationPrompt = `${claim.prompt}\n${claim.appendSystemPrompt ?? ""}`;
    if (
      stripeEventId === undefined ||
      automationPrompt.includes(stripeEventId)
    ) {
      return claim;
    }
  }
  throw new Error("Expected a Stripe workflow run");
}

async function claimUnseenScenarioRun(
  scenario: Scenario,
  seenRunIds: Set<string>,
) {
  mocks.clerk.session(scenario.actor.userId, scenario.actor.orgId);
  const events = await workflows.readThreadEvents(scenario.chatThreadId);
  const runId = events
    .flatMap((event) => {
      return event.runId && !seenRunIds.has(event.runId) ? [event.runId] : [];
    })
    .at(0);
  if (!runId) {
    throw new Error("Expected an unseen Stripe workflow run");
  }
  seenRunIds.add(runId);
  return await runs.claimRunnerJob(runId);
}

async function completeScenarioRun(claim: {
  readonly runId: string;
  readonly sandboxToken: string;
}): Promise<void> {
  await webhooks.requestAgentComplete(
    { runId: claim.runId, exitCode: 0 },
    { authorization: `Bearer ${claim.sandboxToken}` },
    [200],
  );
  await flushWaitUntilForTest();
}

async function readStripeAutomation(scenario: Scenario) {
  mocks.clerk.session(scenario.actor.userId, scenario.actor.orgId);
  const summary = await workflows.readAutomation(scenario.automationId);
  if (summary.kind !== "event" || summary.eventType !== "stripe-invoice-paid") {
    throw new Error("Expected a Stripe invoice-paid automation summary");
  }
  return summary;
}

async function setupPendingLifecycleDelivery(label: string): Promise<{
  readonly accountId: string;
  readonly scenario: Scenario;
}> {
  const accountId = `acct_stripe_lifecycle_${label}_${randomUUID()}`;
  const scenario = await setupScenario({ accountId });
  await postStripeAutomationEvent(invoicePaidEvent({ accountId }));
  return { accountId, scenario };
}

async function executeLifecycleDelivery(scenario: Scenario) {
  const execution = await executeAutomation(scenario);
  const inputEvents = await automationInputEvents(scenario);
  return { execution: execution.body, inputEvents };
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

  it.each(["normalized input", "delivery health"] as const)(
    "deduplicates a Live Stripe snapshot while projecting %s",
    async (projection) => {
      const receivedAt = Date.parse("2026-08-07T08:00:00.000Z");
      mockNow(receivedAt);
      const scenario = await setupScenario({
        billingReasons: ["subscription_cycle"],
      });
      if (projection === "delivery health") {
        expect((await readStripeAutomation(scenario)).health).toStrictEqual({
          lastMatchingEventReceivedAt: null,
          lastDeliveryStatus: null,
          lastDeliveryStatusAt: null,
          warning: null,
        });
      }

      const event = invoicePaidEvent({
        eventId: "evt_workflow_once",
        invoiceId: "in_workflow_once",
      });

      await Promise.all([
        postStripeAutomationEvent(event),
        postStripeAutomationEvent(event),
      ]);

      if (projection === "delivery health") {
        expect((await readStripeAutomation(scenario)).health).toStrictEqual({
          lastMatchingEventReceivedAt: "2026-08-07T08:00:00.000Z",
          lastDeliveryStatus: "pending",
          lastDeliveryStatusAt: "2026-08-07T08:00:00.000Z",
          warning: null,
        });
      }

      const executionResults = await Promise.all([
        executeAutomation(scenario),
        executeAutomation(scenario),
      ]);
      expect(
        executionResults
          .map((result) => {
            return result.body;
          })
          .sort((left, right) => {
            return left.executed - right.executed;
          }),
      ).toStrictEqual([NO_EXECUTION, EXECUTED_EXECUTION]);
      if (projection === "delivery health") {
        expect((await readStripeAutomation(scenario)).health).toMatchObject({
          lastDeliveryStatus: "delivered",
          warning: null,
        });
        mocks.clerk.session(scenario.actor.userId, scenario.actor.orgId);
        const threadAutomations = await accept(
          automationsClient().listForChatThread({
            headers: authHeaders(),
            params: { threadId: scenario.chatThreadId },
          }),
          [200],
        );
        expect(threadAutomations.body).toContainEqual(
          expect.objectContaining({
            id: scenario.automationId,
            health: expect.objectContaining({
              lastDeliveryStatus: "delivered",
              warning: null,
            }),
          }),
        );

        return;
      }

      mocks.clerk.session(scenario.actor.userId, scenario.actor.orgId);
      const events = await workflows.readThreadEvents(scenario.chatThreadId);
      const inputs = events.filter((eventRow) => {
        return eventRow.eventType === "input.automation";
      });
      expect(inputs).toHaveLength(1);
      const input = inputs[0];
      if (!input) {
        throw new Error("Expected one Stripe automation input event");
      }
      expect(chatEventDisplayText(input)).toBe(
        'Stripe invoice "in_workflow_once" was paid.',
      );
      expect(context.mocks.stripe.invoices.list).not.toHaveBeenCalled();
    },
  );

  it("uses the exact Stripe source without persisting a thread override", async () => {
    const scenario = await setupScenario();
    await connectors.updateFeatureSwitches(scenario.actor, {});
    await runs.enableAgentConnectors(scenario.actor, scenario.agentId, [
      "stripe",
    ]);
    const eventId = "evt_thread_connector_source";
    await postStripeAutomationEvent(invoicePaidEvent({ eventId }));
    expect((await executeAutomation(scenario)).body).toStrictEqual(
      EXECUTED_EXECUTION,
    );
    const claim = await claimScenarioRun(scenario, eventId);
    expect(
      Object.values(claim.secretConnectorMetadataMap ?? {}),
    ).toContainEqual(
      expect.objectContaining({ sourceId: scenario.connector.id }),
    );

    mocks.clerk.session(scenario.actor.userId, scenario.actor.orgId);
    const selections = await accept(
      chatThreadConnectorSelectionsClient().get({
        headers: authHeaders(),
        params: { id: scenario.chatThreadId },
      }),
      [200],
    );
    expect(selections.body.selections).toStrictEqual([]);
    expect(context.mocks.ably.publish).not.toHaveBeenCalledWith(
      `chatThreadDetailChanged:${scenario.chatThreadId}`,
      null,
    );
  });

  it("creates against the thread account and repairs after its Live reconnect", async () => {
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
    const recreatedScenario = { ...scenario, automationId: created.body.id };

    await reconnectStripeOAuthAccount(
      scenario.actor,
      threadAccount.id,
      threadAccountId,
      false,
    );
    await postStripeAutomationEvent(
      invoicePaidEvent({
        accountId: originalAccountId,
        eventId: "evt_thread_creation_default_fallback",
      }),
    );
    await postStripeAutomationEvent(
      invoicePaidEvent({
        accountId: threadAccountId,
        eventId: "evt_thread_creation_non_live",
      }),
    );
    expect((await executeAutomation(recreatedScenario)).body).toStrictEqual(
      NO_EXECUTION,
    );

    await reconnectStripeOAuthAccount(
      scenario.actor,
      threadAccount.id,
      threadAccountId,
      true,
    );
    const repairedEventId = "evt_thread_creation_repaired";
    await postStripeAutomationEvent(
      invoicePaidEvent({
        accountId: threadAccountId,
        eventId: repairedEventId,
      }),
    );
    expect((await executeAutomation(recreatedScenario)).body).toStrictEqual(
      EXECUTED_EXECUTION,
    );
    const claim = await claimScenarioRun(recreatedScenario, repairedEventId);
    expect(
      Object.values(claim.secretConnectorMetadataMap ?? {}),
    ).toContainEqual(expect.objectContaining({ sourceId: threadAccount.id }));
    const selections = await accept(
      chatThreadConnectorSelectionsClient().get({
        headers: authHeaders(),
        params: { id: scenario.chatThreadId },
      }),
      [200],
    );
    expect(selections.body.selections).toStrictEqual([
      {
        connectionId: threadAccount.id,
        target: { kind: "builtin", connectorSlug: "stripe" },
      },
    ]);
  });

  it("repairs a null legacy account projection before webhook ingress", async () => {
    const scenario = await setupScenario();
    await applyDeliveryFixture(scenario, "clear-automation-account-projection");

    await postStripeAutomationEvent(
      invoicePaidEvent({ eventId: "evt_legacy_projection_ingress" }),
    );

    expect((await executeAutomation(scenario)).body).toStrictEqual(
      EXECUTED_EXECUTION,
    );
  });

  it("repairs a null legacy account projection before delivery", async () => {
    const scenario = await setupScenario();
    await postStripeAutomationEvent(
      invoicePaidEvent({ eventId: "evt_legacy_projection_delivery" }),
    );
    await applyDeliveryFixture(scenario, "clear-automation-account-projection");

    expect((await executeAutomation(scenario)).body).toStrictEqual(
      EXECUTED_EXECUTION,
    );
  });

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

    await postStripeAutomationEvent(
      invoicePaidEvent({
        accountId: threadAccountId,
        eventId: "evt_cleared_thread_source",
      }),
    );
    expect((await executeAutomation(scenario)).body).toStrictEqual(
      NO_EXECUTION,
    );

    await postStripeAutomationEvent(
      invoicePaidEvent({
        accountId: defaultAccountId,
        eventId: "evt_cleared_default_source",
      }),
    );
    expect((await executeAutomation(scenario)).body).toStrictEqual(
      EXECUTED_EXECUTION,
    );
  });

  it("source-gates ingress before preserving run connector fallback order", async () => {
    const originalAccountId = `acct_stripe_original_${randomUUID()}`;
    const threadAccountId = `acct_stripe_thread_${randomUUID()}`;
    const defaultAccountId = `acct_stripe_default_${randomUUID()}`;
    const scenario = await setupScenario({ accountId: originalAccountId });
    const seenRunIds = new Set<string>();
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
      "Thread account",
      threadAccountId,
    );
    const defaultAccount = await addStripeOAuthAccount(
      scenario.actor,
      "Default account",
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
    const configuredSelections = await accept(
      chatThreadConnectorSelectionsClient().get({
        headers: authHeaders(),
        params: { id: scenario.chatThreadId },
      }),
      [200],
    );
    expect(configuredSelections.body.selections).toStrictEqual([
      {
        connectionId: threadAccount.id,
        target: { kind: "builtin", connectorSlug: "stripe" },
      },
    ]);
    const configuredAccounts = await accept(
      connectorAccountsClient().connections({
        headers: authHeaders(),
        query: { kind: "builtin", connectorSlug: "stripe", limit: 100 },
      }),
      [200],
    );
    expect(
      configuredAccounts.body.connections.map((connection) => {
        return {
          id: connection.id,
          status: connection.connectionStatus,
        };
      }),
    ).toStrictEqual(
      expect.arrayContaining([
        { id: scenario.connector.id, status: "connected" },
        { id: threadAccount.id, status: "connected" },
        { id: defaultAccount.id, status: "connected" },
      ]),
    );

    const oldSourceEventId = "evt_connector_projection_old_source";
    await postStripeAutomationEvent(
      invoicePaidEvent({
        accountId: originalAccountId,
        eventId: oldSourceEventId,
      }),
    );
    expect((await executeAutomation(scenario)).body).toStrictEqual(
      NO_EXECUTION,
    );

    const threadEventId = "evt_connector_projection_thread";
    await postStripeAutomationEvent(
      invoicePaidEvent({ accountId: threadAccountId, eventId: threadEventId }),
    );
    expect((await executeAutomation(scenario)).body).toStrictEqual(
      EXECUTED_EXECUTION,
    );
    const threadClaim = await claimUnseenScenarioRun(scenario, seenRunIds);
    expect(
      Object.values(threadClaim.secretConnectorMetadataMap ?? {}),
    ).toContainEqual(expect.objectContaining({ sourceId: threadAccount.id }));

    const defaultFallbackEventId = "evt_connector_projection_default";
    await postStripeAutomationEvent(
      invoicePaidEvent({
        accountId: threadAccountId,
        eventId: defaultFallbackEventId,
      }),
    );
    expect((await executeAutomation(scenario)).body).toStrictEqual(
      EXECUTED_EXECUTION,
    );
    await setConnectorAccountState(context, {
      orgId,
      userId: scenario.actor.userId,
      connectorId: threadAccount.id,
      needsReconnect: true,
      storageVersion: 1,
    });
    await completeScenarioRun(threadClaim);
    const defaultClaim = await claimUnseenScenarioRun(scenario, seenRunIds);
    expect(
      Object.values(defaultClaim.secretConnectorMetadataMap ?? {}),
    ).toContainEqual(expect.objectContaining({ sourceId: defaultAccount.id }));

    await setConnectorAccountState(context, {
      orgId,
      userId: scenario.actor.userId,
      connectorId: threadAccount.id,
      needsReconnect: false,
      storageVersion: 3,
    });
    const unavailableEventId = "evt_connector_projection_unavailable";
    await postStripeAutomationEvent(
      invoicePaidEvent({
        accountId: threadAccountId,
        eventId: unavailableEventId,
      }),
    );
    expect((await executeAutomation(scenario)).body).toStrictEqual(
      EXECUTED_EXECUTION,
    );
    await Promise.all([
      setConnectorAccountState(context, {
        orgId,
        userId: scenario.actor.userId,
        connectorId: threadAccount.id,
        needsReconnect: true,
        storageVersion: 1,
      }),
      setConnectorAccountState(context, {
        orgId,
        userId: scenario.actor.userId,
        connectorId: defaultAccount.id,
        needsReconnect: true,
        storageVersion: 1,
      }),
    ]);
    await completeScenarioRun(defaultClaim);
    const unavailableClaim = await claimUnseenScenarioRun(scenario, seenRunIds);
    const unavailableMetadata = Object.values(
      unavailableClaim.secretConnectorMetadataMap ?? {},
    );
    expect(unavailableMetadata).not.toContainEqual(
      expect.objectContaining({ sourceId: threadAccount.id }),
    );
    expect(unavailableMetadata).not.toContainEqual(
      expect.objectContaining({ sourceId: defaultAccount.id }),
    );
    await completeScenarioRun(unavailableClaim);
  });

  it("falls back when a queued event's Stripe source is deleted", async () => {
    const scenario = await setupScenario();
    await connectors.updateFeatureSwitches(scenario.actor, {});
    await runs.enableAgentConnectors(scenario.actor, scenario.agentId, [
      "stripe",
    ]);
    await runs.heartbeatRunner(scenario.runnerGroup);

    const firstEventId = "evt_thread_connector_source_active";
    await postStripeAutomationEvent(
      invoicePaidEvent({ eventId: firstEventId }),
    );
    expect((await executeAutomation(scenario)).body).toStrictEqual(
      EXECUTED_EXECUTION,
    );
    const firstClaim = await claimScenarioRun(scenario, firstEventId);

    const queuedEventId = "evt_thread_connector_source_queued";
    await postStripeAutomationEvent(
      invoicePaidEvent({ eventId: queuedEventId }),
    );
    expect((await executeAutomation(scenario)).body).toStrictEqual(
      EXECUTED_EXECUTION,
    );

    await connectors.deleteDefaultBuiltinConnectorAccount(
      scenario.actor,
      "stripe",
    );
    const replacement = await connectStripeOAuth(
      scenario.actor,
      STRIPE_ACCOUNT_ID,
    );
    expect(replacement.id).not.toBe(scenario.connector.id);

    await runs.requestCancelRun(scenario.actor, firstClaim.runId, [200]);
    await webhooks.requestAgentComplete(
      {
        runId: firstClaim.runId,
        exitCode: 1,
        error: "Run cancelled",
      },
      { authorization: `Bearer ${firstClaim.sandboxToken}` },
      [200],
    );
    await flushWaitUntilForTest();

    mocks.clerk.session(scenario.actor.userId, scenario.actor.orgId);
    const queuedRunId = (
      await workflows.readThreadEvents(scenario.chatThreadId)
    )
      .flatMap((event) => {
        return event.runId && event.runId !== firstClaim.runId
          ? [event.runId]
          : [];
      })
      .at(0);
    if (!queuedRunId) {
      throw new Error("Expected the queued Stripe event to start a run");
    }
    const queuedClaim = await runs.claimRunnerJob(queuedRunId);
    expect(
      `${queuedClaim.prompt}\n${queuedClaim.appendSystemPrompt ?? ""}`,
    ).toContain(queuedEventId);
    expect(
      Object.values(queuedClaim.secretConnectorMetadataMap ?? {}),
    ).toContainEqual(expect.objectContaining({ sourceId: replacement.id }));
  });

  it("queues every embedded line and current relationship identities without Stripe enrichment", async () => {
    const current = await setupScenario({
      accountId: "acct_stripe_current_snapshot",
    });
    await runs.heartbeatRunner(current.runnerGroup);
    const invoiceListCalls =
      context.mocks.stripe.invoices.list.mock.calls.length;
    const subscriptionRetrieveCalls =
      context.mocks.stripe.subscriptions.retrieve.mock.calls.length;
    const paymentMethodRetrieveCalls =
      context.mocks.stripe.paymentMethods.retrieve.mock.calls.length;
    const embeddedLines = Array.from({ length: 31 }, (_, index) => {
      return {
        id: `il_current_${index}`,
        object: "line_item",
        description: `Current line ${index}`,
        quantity: index + 1,
        amount: 100 + index,
        currency: "usd",
        metadata: { line: String(index) },
        period: { start: 1_786_060_800, end: 1_788_739_200 },
        pricing: {
          type: "price_details",
          price_details: {
            price: `price_current_${index}`,
            product: `prod_current_${index}`,
          },
          unit_amount_decimal: `${100 + index}.00`,
        },
      };
    });

    await postStripeAutomationEvent(
      invoicePaidEvent({
        accountId: "acct_stripe_current_snapshot",
        eventId: "evt_current_snapshot",
        invoiceFields: {
          subscription: undefined,
          payment_intent: undefined,
          parent: {
            type: "subscription_details",
            subscription_details: {
              subscription: "sub_current_snapshot",
              metadata: { source: "current" },
            },
          },
          payments: {
            data: [
              {
                id: "inpay_current_pi",
                payment: {
                  type: "payment_intent",
                  payment_intent: "pi_current_snapshot",
                },
              },
              {
                id: "inpay_current_charge",
                payment: { type: "charge", charge: "ch_current_snapshot" },
              },
              {
                id: "inpay_current_record",
                payment: {
                  type: "payment_record",
                  payment_record: "pr_current_snapshot",
                },
              },
            ],
          },
          lines: {
            data: embeddedLines,
            has_more: true,
            total_count: 45,
          },
        },
      }),
    );
    expect((await executeAutomation(current)).body.executed).toBe(1);

    const currentClaim = await claimScenarioRun(current);
    expect(currentClaim.prompt).toContain(
      "normalized, signed Stripe webhook snapshot",
    );
    const currentContext = eventContextFromPrompt(currentClaim.prompt);
    expect(currentContext).toMatchObject({
      event: { id: "evt_current_snapshot", livemode: true },
      invoice: {
        lines: {
          data: expect.arrayContaining([
            expect.objectContaining({
              id: "il_current_0",
              metadata: { line: "0" },
              pricing: {
                type: "price_details",
                priceId: "price_current_0",
                productId: "prod_current_0",
                unitAmountDecimal: "100.00",
              },
            }),
            expect.objectContaining({ id: "il_current_30" }),
          ]),
          hasMore: true,
          totalCount: 45,
        },
      },
      relationships: {
        subscriptionId: "sub_current_snapshot",
        paymentIntentId: null,
        paymentIds: [
          "inpay_current_pi",
          "inpay_current_charge",
          "inpay_current_record",
        ],
        paymentIntentIds: ["pi_current_snapshot"],
        chargeIds: ["ch_current_snapshot"],
        paymentRecordIds: ["pr_current_snapshot"],
      },
    });
    const currentEvent = z
      .object({
        invoice: z.object({
          lines: z.object({ data: z.array(z.unknown()) }),
        }),
      })
      .parse(currentContext);
    expect(currentEvent.invoice.lines.data).toHaveLength(31);

    expect(context.mocks.stripe.invoices.list).toHaveBeenCalledTimes(
      invoiceListCalls,
    );
    expect(context.mocks.stripe.subscriptions.retrieve).toHaveBeenCalledTimes(
      subscriptionRetrieveCalls,
    );
    expect(context.mocks.stripe.paymentMethods.retrieve).toHaveBeenCalledTimes(
      paymentMethodRetrieveCalls,
    );
  });

  it("queues legacy relationship identities without Stripe enrichment", async () => {
    const legacy = await setupScenario({
      accountId: "acct_stripe_legacy_snapshot",
    });
    await runs.heartbeatRunner(legacy.runnerGroup);
    const invoiceListCalls =
      context.mocks.stripe.invoices.list.mock.calls.length;
    const subscriptionRetrieveCalls =
      context.mocks.stripe.subscriptions.retrieve.mock.calls.length;
    const paymentMethodRetrieveCalls =
      context.mocks.stripe.paymentMethods.retrieve.mock.calls.length;

    await postStripeAutomationEvent(
      invoicePaidEvent({
        accountId: "acct_stripe_legacy_snapshot",
        eventId: "evt_legacy_snapshot",
        invoiceFields: {
          parent: undefined,
          subscription: "sub_legacy_snapshot",
          payment_intent: "pi_legacy_snapshot",
          payments: {
            data: [
              {
                payment: "pay_legacy_snapshot",
                payment_intent: "pi_legacy_relationship",
              },
            ],
          },
        },
      }),
    );
    expect((await executeAutomation(legacy)).body.executed).toBe(1);

    const legacyClaim = await claimScenarioRun(legacy);
    expect(eventContextFromPrompt(legacyClaim.prompt)).toMatchObject({
      relationships: {
        subscriptionId: "sub_legacy_snapshot",
        paymentIntentId: "pi_legacy_snapshot",
        paymentIds: ["pay_legacy_snapshot"],
        paymentIntentIds: ["pi_legacy_relationship"],
      },
    });
    expect(context.mocks.stripe.invoices.list).toHaveBeenCalledTimes(
      invoiceListCalls,
    );
    expect(context.mocks.stripe.subscriptions.retrieve).toHaveBeenCalledTimes(
      subscriptionRetrieveCalls,
    );
    expect(context.mocks.stripe.paymentMethods.retrieve).toHaveBeenCalledTimes(
      paymentMethodRetrieveCalls,
    );
  });

  it("rolls back the complete two-tenant fan-out and succeeds on Stripe retry", async () => {
    const firstReceipt = Date.parse("2026-08-07T08:30:00.000Z");
    mockNow(firstReceipt);
    const first = await setupScenario();
    const second = await setupScenario();
    expect(first.actor.orgId).not.toBe(second.actor.orgId);
    expect(first.actor.userId).not.toBe(second.actor.userId);
    await postStripeAutomationEvent(
      invoicePaidEvent({ eventId: "evt_cross_tenant_seed" }),
    );
    expect((await executeAutomation(first)).body).toStrictEqual(
      EXECUTED_EXECUTION,
    );
    expect((await executeAutomation(second)).body).toStrictEqual(
      EXECUTED_EXECUTION,
    );
    await expect(automationInputEvents(first)).resolves.toHaveLength(1);
    await expect(automationInputEvents(second)).resolves.toHaveLength(1);

    await applyDeliveryFixture(second, "fail-next-ingress-for-automation");
    mockNow(firstReceipt + 60_000);
    const retryEvent = invoicePaidEvent({
      eventId: "evt_cross_tenant_retry",
    });
    await postStripeAutomationEvent(retryEvent, 500);
    expect(
      (await readStripeAutomation(first)).health.lastMatchingEventReceivedAt,
    ).toBe("2026-08-07T08:30:00.000Z");
    expect(
      (await readStripeAutomation(second)).health.lastMatchingEventReceivedAt,
    ).toBe("2026-08-07T08:30:00.000Z");

    await applyDeliveryFixture(second, "clear-forced-failures");
    await postStripeAutomationEvent(retryEvent);
    expect((await executeAutomation(first)).body).toStrictEqual(
      EXECUTED_EXECUTION,
    );
    expect((await executeAutomation(second)).body).toStrictEqual(
      EXECUTED_EXECUTION,
    );
    await expect(automationInputEvents(first)).resolves.toHaveLength(2);
    await expect(automationInputEvents(second)).resolves.toHaveLength(2);
  });

  it("retries a queue-admission failure without admitting a second source event", async () => {
    const scenario = await setupScenario();
    await postStripeAutomationEvent(
      invoicePaidEvent({ eventId: "evt_queue_admission_retry" }),
    );
    await applyDeliveryFixture(
      scenario,
      "fail-next-queue-admission-for-automation",
    );

    expect((await executeAutomation(scenario)).body).toStrictEqual(
      TERMINALLY_SKIPPED_EXECUTION,
    );
    await expect(automationInputEvents(scenario)).resolves.toHaveLength(0);
    expect((await readStripeAutomation(scenario)).health).toMatchObject({
      lastDeliveryStatus: "pending",
      warning: null,
    });

    await applyDeliveryFixture(scenario, "clear-forced-failures");
    await applyDeliveryFixture(scenario, "make-latest-due");
    expect((await executeAutomation(scenario)).body).toStrictEqual(
      EXECUTED_EXECUTION,
    );
    await expect(automationInputEvents(scenario)).resolves.toHaveLength(1);
    expect((await readStripeAutomation(scenario)).health).toMatchObject({
      lastDeliveryStatus: "delivered",
      warning: null,
    });
  });

  it("keeps newer pending health when an older delivery finishes first", async () => {
    const firstReceipt = Date.parse("2026-08-07T09:00:00.000Z");
    mockNow(firstReceipt);
    const scenario = await setupScenario();
    await postStripeAutomationEvent(
      invoicePaidEvent({ eventId: "evt_health_older" }),
    );
    mockNow(firstReceipt + 60_000);
    await postStripeAutomationEvent(
      invoicePaidEvent({ eventId: "evt_health_newer" }),
    );
    await applyDeliveryFixture(scenario, "hold-latest-claim");

    expect((await executeAutomation(scenario)).body).toStrictEqual(
      EXECUTED_EXECUTION,
    );
    await expect(automationInputEvents(scenario)).resolves.toHaveLength(1);
    expect((await readStripeAutomation(scenario)).health).toStrictEqual({
      lastMatchingEventReceivedAt: "2026-08-07T09:01:00.000Z",
      lastDeliveryStatus: "pending",
      lastDeliveryStatusAt: "2026-08-07T09:01:00.000Z",
      warning: null,
    });

    mockNow(firstReceipt + 420_000);
    expect((await executeAutomation(scenario)).body).toStrictEqual(
      EXECUTED_EXECUTION,
    );
    await expect(automationInputEvents(scenario)).resolves.toHaveLength(2);
    expect((await readStripeAutomation(scenario)).health).toMatchObject({
      lastDeliveryStatus: "delivered",
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

  it("updates receipt health across filters and delivers unknown billing reasons to unfiltered automations", async () => {
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
    expect((await executeAutomation(unfiltered)).body.executed).toBe(1);
    const unknownClaim = await claimScenarioRun(
      unfiltered,
      "evt_unknown_billing_reason",
    );
    expect(eventContextFromPrompt(unknownClaim.prompt)).toMatchObject({
      invoice: { billingReason: "future_reason" },
    });
  });

  it("skips a pending delivery when the owner flag turns off", async () => {
    const scenario = await setupScenario();
    await postStripeAutomationEvent(
      invoicePaidEvent({
        eventId: "evt_owner_flag_turns_off",
        billingReason: "subscription_cycle",
      }),
    );
    expect((await readStripeAutomation(scenario)).health).toMatchObject({
      lastDeliveryStatus: "pending",
      warning: null,
    });

    await connectors.updateFeatureSwitches(scenario.actor, {
      [FeatureSwitchKey.StripeInvoicePaidWorkflowAutomations]: false,
    });
    expect((await executeAutomation(scenario)).body).toStrictEqual(
      TERMINALLY_SKIPPED_EXECUTION,
    );
    expect((await readStripeAutomation(scenario)).health).toMatchObject({
      lastDeliveryStatus: "skipped",
      warning: null,
    });
  });

  describe("terminally skips persisted deliveries after public lifecycle binding changes", () => {
    it("when the automation is disabled", async () => {
      const { scenario } = await setupPendingLifecycleDelivery("disabled");
      await setAutomationEnabled(scenario, false);
      const result = await executeLifecycleDelivery(scenario);
      expect(result.execution).toStrictEqual(TERMINALLY_SKIPPED_EXECUTION);
      expect((await readStripeAutomation(scenario)).health).toMatchObject({
        lastDeliveryStatus: "skipped",
        warning: null,
      });
      expect(result.inputEvents).toHaveLength(0);
    });

    it("when the automation is deleted", async () => {
      const { scenario } = await setupPendingLifecycleDelivery("deleted");
      await deleteAutomation(scenario);
      const result = await executeLifecycleDelivery(scenario);
      expect(result.execution).toStrictEqual(TERMINALLY_SKIPPED_EXECUTION);
      expect(result.inputEvents).toHaveLength(0);
    });

    it("when the thread account selection changes", async () => {
      const { scenario } =
        await setupPendingLifecycleDelivery("thread_selection");
      const orgId = scenario.actor.orgId;
      if (!orgId) {
        throw new Error("Expected an organization-scoped workflow owner");
      }
      await connectors.updateFeatureSwitches(scenario.actor, {});
      await runs.enableAgentConnectors(scenario.actor, scenario.agentId, [
        "stripe",
      ]);
      const replacementAccount = await addStripeOAuthAccount(
        scenario.actor,
        "Replacement thread account",
        `acct_stripe_thread_replacement_${randomUUID()}`,
      );
      mocks.clerk.session(scenario.actor.userId, orgId);
      await accept(
        chatThreadConnectorSelectionsClient().update({
          headers: authHeaders(),
          params: { id: scenario.chatThreadId },
          body: {
            connectionId: replacementAccount.id,
            target: { kind: "builtin", connectorSlug: "stripe" },
          },
        }),
        [200],
      );

      const result = await executeLifecycleDelivery(scenario);
      expect(result.execution).toStrictEqual(TERMINALLY_SKIPPED_EXECUTION);
      expect(result.inputEvents).toHaveLength(0);
    });

    it("when the connection changes from live mode to test mode", async () => {
      const { accountId, scenario } =
        await setupPendingLifecycleDelivery("test_mode");
      await reconnectStripeOAuthAccount(
        scenario.actor,
        scenario.connector.id,
        accountId,
        false,
      );
      const result = await executeLifecycleDelivery(scenario);
      expect(result.execution).toStrictEqual(TERMINALLY_SKIPPED_EXECUTION);
      expect((await readStripeAutomation(scenario)).health).toMatchObject({
        lastDeliveryStatus: "skipped",
        warning: null,
      });
      expect(result.inputEvents).toHaveLength(0);
    });

    it("when the connector is deleted", async () => {
      const { scenario } =
        await setupPendingLifecycleDelivery("deleted_connector");
      await connectors.deleteDefaultBuiltinConnectorAccount(
        scenario.actor,
        "stripe",
      );
      const result = await executeLifecycleDelivery(scenario);
      expect(result.execution).toStrictEqual(TERMINALLY_SKIPPED_EXECUTION);
      expect((await readStripeAutomation(scenario)).health).toMatchObject({
        lastDeliveryStatus: "skipped",
        warning: null,
      });
      expect(result.inputEvents).toHaveLength(0);
    });
  });

  it("marks only the exact deauthorized account for reconnect and terminally skips its pending delivery", async () => {
    const affected = await setupScenario({ accountId: STRIPE_ACCOUNT_ID });
    const unaffected = await setupScenario({
      accountId: "acct_stripe_workflow_other",
    });
    await postStripeAutomationEvent(
      invoicePaidEvent({ eventId: "evt_before_deauthorization" }),
    );
    const deauthorization = {
      id: "evt_deauthorized",
      type: "account.application.deauthorized",
      account: STRIPE_ACCOUNT_ID,
      livemode: true,
      created: Math.floor(now() / 1000),
      data: { object: {} },
    };
    await postStripeAutomationEvent(deauthorization);
    await postStripeAutomationEvent(deauthorization);

    const affectedConnector = await connectors.readConnectorBySlug(
      affected.actor,
      "stripe",
    );
    expect(affectedConnector.connectionStatus).toBe("reconnect-required");
    expect(affectedConnector.reconnectReason).toBe(
      "authorization_expired_or_revoked",
    );
    await expect(
      connectors.readConnectorBySlug(unaffected.actor, "stripe"),
    ).resolves.toMatchObject({ connectionStatus: "connected" });
    await expect(readStripeAutomation(affected)).resolves.toMatchObject({
      id: affected.automationId,
      enabled: true,
    });

    expect((await executeAutomation(affected)).body).toStrictEqual(
      TERMINALLY_SKIPPED_EXECUTION,
    );
    expect((await readStripeAutomation(affected)).health).toMatchObject({
      lastDeliveryStatus: "skipped",
    });
  });

  it("recovers an expired claim and exposes a failed warning after the 72-hour retry window", async () => {
    const startedAt = Date.parse("2026-08-07T10:00:00.000Z");
    mockNow(startedAt);
    const recoverable = await setupScenario();
    await postStripeAutomationEvent(
      invoicePaidEvent({ eventId: "evt_recoverable_claim" }),
    );
    await applyDeliveryFixture(recoverable, "hold-latest-claim");
    expect((await executeAutomation(recoverable)).body).toStrictEqual(
      NO_EXECUTION,
    );
    expect((await readStripeAutomation(recoverable)).health).toMatchObject({
      lastDeliveryStatus: "pending",
    });

    mockNow(startedAt + 360_000);
    expect((await executeAutomation(recoverable)).body).toStrictEqual(
      EXECUTED_EXECUTION,
    );
    expect((await readStripeAutomation(recoverable)).health).toMatchObject({
      lastDeliveryStatus: "delivered",
    });

    const exhausted = await setupScenario({
      accountId: "acct_stripe_workflow_retry",
    });
    await postStripeAutomationEvent(
      invoicePaidEvent({
        accountId: "acct_stripe_workflow_retry",
        eventId: "evt_retry_cutoff",
      }),
    );
    await applyDeliveryFixture(exhausted, "corrupt-latest-snapshot");
    expect((await executeAutomation(exhausted)).body).toStrictEqual(
      TERMINALLY_SKIPPED_EXECUTION,
    );
    expect((await readStripeAutomation(exhausted)).health).toMatchObject({
      lastDeliveryStatus: "pending",
      warning: null,
    });

    mockNow(startedAt + 390_000);
    expect((await executeAutomation(exhausted)).body).toStrictEqual(
      NO_EXECUTION,
    );
    mockNow(startedAt + 420_000);
    expect((await executeAutomation(exhausted)).body).toStrictEqual(
      TERMINALLY_SKIPPED_EXECUTION,
    );
    mockNow(startedAt + 480_000);
    expect((await executeAutomation(exhausted)).body).toStrictEqual(
      NO_EXECUTION,
    );
    mockNow(startedAt + 540_000);
    expect((await executeAutomation(exhausted)).body).toStrictEqual(
      TERMINALLY_SKIPPED_EXECUTION,
    );

    await applyDeliveryFixture(exhausted, "expire-latest-retry-window");
    expect((await executeAutomation(exhausted)).body).toStrictEqual(
      TERMINALLY_SKIPPED_EXECUTION,
    );
    expect((await readStripeAutomation(exhausted)).health).toMatchObject({
      lastDeliveryStatus: "failed",
      warning: "delivery_failed",
    });
  });
});
