import { randomUUID } from "node:crypto";

import { billingUsagePackCreditsContract } from "@okouai/api-contracts/contracts/billing";
import { voiceIoQuotaContract } from "@okouai/api-contracts/contracts/voice-io-quota";
import { workflowAutomationsContract } from "@okouai/api-contracts/contracts/workflows";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { billingUsagePackCreditsRoutes } from "../billing-usage-pack-credits";
import { voiceIoQuotaRoutes } from "../voice-io-quota";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  createWebhookCallbackApi,
  deliverOrganizationCreated,
} from "./helpers/api-bdd-webhooks";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { createRouteMocks } from "./helpers/route-test";

const DAY_SECONDS = 86_400;
const DAY_MS = DAY_SECONDS * 1000;
const ATOM_GRANT_PRICE = "price_bdd_atom_grant";

function stripeId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 12)}`;
}

function nowSeconds(): number {
  return Math.floor(now() / 1000);
}

function addOneMonthIso(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  date.setMonth(date.getMonth() + 1);
  return date.toISOString();
}

function stripeEvent(
  type: string,
  object: Readonly<Record<string, unknown>>,
  previousAttributes?: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    id: stripeId("evt"),
    type,
    created: nowSeconds(),
    data: {
      object,
      ...(previousAttributes === undefined
        ? {}
        : { previous_attributes: previousAttributes }),
    },
  };
}

function subscriptionInvoiceObject(args: {
  readonly id?: string;
  readonly customerId: string;
  readonly subscriptionId: string;
  readonly priceId: string | null;
  readonly periodStart: number;
  readonly periodEnd: number;
  readonly subscriptionMetadata?: Readonly<Record<string, string>>;
}): Readonly<Record<string, unknown>> {
  return {
    id: args.id ?? stripeId("in"),
    customer: args.customerId,
    metadata: {},
    subtotal: 0,
    parent: {
      subscription_details: {
        subscription: args.subscriptionId,
        metadata: args.subscriptionMetadata ?? {},
      },
    },
    lines: {
      has_more: false,
      data:
        args.priceId === null
          ? []
          : [
              {
                id: stripeId("il"),
                price: { id: args.priceId },
                quantity: 1,
                parent: { type: "subscription_item_details" },
                period: { start: args.periodStart, end: args.periodEnd },
              },
            ],
    },
  };
}

function stripeSubscriptionObject(args: {
  readonly id: string;
  readonly customerId: string;
  readonly priceId: string;
  readonly status?: string;
  readonly periodStart: number;
  readonly periodEnd: number;
  readonly trialEnd?: number | null;
  readonly cancelAtPeriodEnd?: boolean;
  readonly cancelAt?: number | null;
  readonly scheduleId?: string | null;
  readonly quantity?: number;
  readonly metadata?: Readonly<Record<string, string>>;
}): Readonly<Record<string, unknown>> {
  return {
    id: args.id,
    object: "subscription",
    status: args.status ?? "active",
    customer: args.customerId,
    cancel_at_period_end: args.cancelAtPeriodEnd ?? false,
    cancel_at: args.cancelAt ?? null,
    schedule: args.scheduleId ?? null,
    trial_end: args.trialEnd ?? null,
    metadata: args.metadata ?? {},
    items: {
      data: [
        {
          id: stripeId("si"),
          price: { id: args.priceId },
          quantity: args.quantity ?? 1,
          current_period_start: args.periodStart,
          current_period_end: args.periodEnd,
        },
      ],
    },
  };
}

describe("webhooks-callbacks.bdd", () => {
  const context = testContext();
  const bdd = createBddApi(context);
  const webhooks = createWebhookCallbackApi(context);
  const billing = createBillingMediaApi(context);
  const runs = createRunsApi(context);
  const workflows = createWorkflowsBddApi(context);
  const routeMocks = createRouteMocks(context);

  async function readUsagePackCredits(actor: ApiTestUser) {
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const client = setupApp({ context, routes: billingUsagePackCreditsRoutes })(
      billingUsagePackCreditsContract,
    );
    const response = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    return response.body;
  }

  async function readVoiceQuota(actor: ApiTestUser) {
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const client = setupApp({ context, routes: voiceIoQuotaRoutes })(
      voiceIoQuotaContract,
    );
    const response = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    return response.body;
  }

  async function createLoopAndWebhookAutomations(
    actor: ApiTestUser,
    workflowId: string,
  ): Promise<{ readonly loopId: string; readonly webhookId: string }> {
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const client = setupApp({ context, routes: workflowAutomationsRoutes })(
      workflowAutomationsContract,
    );
    const headers = { authorization: "Bearer clerk-session" };
    const loopCreated = await accept(
      client.create({
        headers,
        params: { workflowId },
        body: {
          kind: "schedule",
          schedule: { type: "loop", intervalSeconds: 3600 },
        },
      }),
      [201],
    );
    const webhookCreated = await accept(
      client.create({
        headers,
        params: { workflowId },
        body: { kind: "event", eventType: "webhook-received" },
      }),
      [201],
    );
    return { loopId: loopCreated.body.id, webhookId: webhookCreated.body.id };
  }

  async function readAutomationAs(actor: ApiTestUser, automationId: string) {
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const client = setupApp({ context, routes: workflowAutomationsRoutes })(
      workflowAutomationsContract,
    );
    const response = await accept(
      client.get({
        headers: { authorization: "Bearer clerk-session" },
        params: { id: automationId },
      }),
      [200],
    );
    return response.body;
  }

  it("webhooks-callbacks.bdd-002 rejects Stripe requests with missing or invalid signatures", async () => {
    webhooks.configureStripeBillingEnv();

    const missing = await webhooks.requestStripeWebhook("{}", {}, [401]);
    expect(missing.body).toStrictEqual({
      error: "Missing stripe-signature header",
    });

    webhooks.rejectNextStripeWebhookSignature();
    const invalid = await webhooks.requestStripeWebhook(
      "{}",
      { "stripe-signature": "t=1,v1=invalid" },
      [401],
    );
    expect(invalid.body).toStrictEqual({ error: "Invalid webhook signature" });

    webhooks.acceptNextStripeWebhookEvent(
      stripeEvent("charge.succeeded", { id: stripeId("ch") }),
    );
    const signed = await webhooks.requestStripeWebhook(
      "{}",
      { "stripe-signature": "t=1,v1=valid" },
      [200],
    );
    expect(signed.body).toBe("OK");
  });

  it("webhooks-callbacks.bdd-004 rejects Clerk requests when webhook verification is missing or invalid", async () => {
    webhooks.configureClerkWebhookSecret();

    webhooks.rejectNextClerkWebhookVerification();
    const noHeaders = await webhooks.requestClerkWebhook("{}", {}, [401]);
    expect(noHeaders.body).toStrictEqual({
      error: "Invalid webhook signature",
    });

    webhooks.rejectNextClerkWebhookVerification();
    const badSig = await webhooks.requestClerkWebhook(
      "{}",
      {
        "svix-id": "msg_bad",
        "svix-timestamp": String(nowSeconds()),
        "svix-signature": "v1,invalid",
      },
      [401],
    );
    expect(badSig.body).toStrictEqual({ error: "Invalid webhook signature" });
  });

  it("webhooks-callbacks.bdd-007 keeps Clerk membership creation from duplicating bootstrap state", async () => {
    const admin = bdd.user({ orgRole: "org:admin" });
    const orgId = admin.orgId;
    if (!orgId) {
      throw new Error("Expected admin orgId");
    }

    await deliverOrganizationCreated(context, admin);

    const personalBefore = await readUsagePackCredits(admin);
    expect(personalBefore.bonusCredits).toBe(1000);
    expect(personalBefore.creditGrants).toHaveLength(1);

    webhooks.configureClerkWebhookSecret();
    webhooks.verifyNextClerkWebhook({
      type: "organizationMembership.created",
      data: {
        organization: { id: orgId },
        public_user_data: { user_id: admin.userId },
        created_at: now(),
      },
    });
    const delivered = await webhooks.requestClerkWebhook("{}", {}, [200]);
    expect(delivered.body).toBe("OK");
    await flushWaitUntilForTest();

    const status = await billing.readBillingStatus(admin);
    expect(status).toMatchObject({
      tier: "limited-free-1",
      credits: 0,
      creditGrants: [],
      onboardingPaymentPending: false,
    });

    const personalAfter = await readUsagePackCredits(admin);
    expect(personalAfter).toStrictEqual(personalBefore);

    const onboarding = await bdd.readOnboardingStatus(admin);
    expect(onboarding).toMatchObject({
      needsOnboarding: true,
      onboardingComplete: false,
      isAdmin: true,
      hasOrg: true,
    });
  });

  it("webhooks-callbacks.bdd-008 rejects GitHub requests with missing headers or invalid signatures", async () => {
    webhooks.configureGithubWebhookSecret();

    const missing = await webhooks.requestGithubWebhook("{}", {}, [401]);
    expect(missing.body).toStrictEqual({
      error: "Missing GitHub webhook headers",
    });

    const badSig = await webhooks.requestGithubWebhook(
      "{}",
      {
        "x-github-delivery": "delivery-bad",
        "x-github-event": "ping",
        "x-hub-signature-256": "sha256=deadbeef",
      },
      [401],
    );
    expect(badSig.body).toStrictEqual({ error: "Invalid signature" });

    const pingBody = JSON.stringify({ zen: "Keep it logically awesome." });
    const ping = await webhooks.requestGithubWebhook(
      pingBody,
      webhooks.signedGithubWebhookHeaders(pingBody, "ping"),
      [200],
    );
    expect(ping.body).toStrictEqual({ message: "pong" });

    const forkBody = JSON.stringify({ action: "forked" });
    const fork = await webhooks.requestGithubWebhook(
      forkBody,
      webhooks.signedGithubWebhookHeaders(forkBody, "fork"),
      [200],
    );
    expect(fork.body).toBe("OK");
  });

  it("webhooks-callbacks.bdd-037 uses each successful card payment as the customer default", async () => {
    webhooks.configureStripeBillingEnv();
    const customerId = stripeId("cus");
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      metadata: {},
    });
    const updates: unknown[] = [];
    context.mocks.stripe.customers.update.mockImplementation(
      (id: unknown, payload: unknown) => {
        updates.push({ id, payload });
        return Promise.resolve({ id });
      },
    );

    context.mocks.stripe.paymentMethods.retrieve.mockResolvedValueOnce({
      id: "pm_bdd_card",
      type: "card",
      customer: customerId,
    });
    const cardRes = await webhooks.postStripeEvent(
      stripeEvent("payment_intent.succeeded", {
        id: stripeId("pi"),
        customer: customerId,
        payment_method: "pm_bdd_card",
        metadata: {},
      }),
      [200],
    );
    expect(cardRes.status).toBe(200);
    expect(updates).toStrictEqual([
      {
        id: customerId,
        payload: {
          invoice_settings: { default_payment_method: "pm_bdd_card" },
        },
      },
    ]);

    context.mocks.stripe.paymentMethods.retrieve.mockResolvedValueOnce({
      id: "pm_bdd_bank",
      type: "us_bank_account",
      customer: customerId,
    });
    const bankRes = await webhooks.postStripeEvent(
      stripeEvent("payment_intent.succeeded", {
        id: stripeId("pi"),
        customer: customerId,
        payment_method: "pm_bdd_bank",
        metadata: {},
      }),
      [200],
    );
    expect(bankRes.status).toBe(200);
    expect(updates).toStrictEqual([
      {
        id: customerId,
        payload: {
          invoice_settings: { default_payment_method: "pm_bdd_card" },
        },
      },
    ]);
  });

  it("webhooks-callbacks.bdd-038 keeps the normal credit window for a non-Atom early cancellation", async () => {
    const startMs = Date.parse("2026-06-01T12:00:00.000Z");
    mockNow(startMs);
    const startSec = Math.floor(startMs / 1000);
    const periodEndUnix = startSec + 30 * DAY_SECONDS;
    const cancelAtUnix = startSec + 7 * DAY_SECONDS;
    const member = bdd.user({ orgRole: "org:admin" });

    webhooks.configureStripeBillingEnv();
    await runs.grantProEntitlement(member, {
      periodEndUnix,
      cancelAtUnix,
    });

    const status = await billing.readBillingStatus(member);
    expect(status.tier).toBe("pro");
    expect(status.currentPeriodEnd).toBe(
      new Date(cancelAtUnix * 1000).toISOString(),
    );
    expect(status.creditGrants).toStrictEqual([
      expect.objectContaining({
        source: "subscription_renewal",
        amount: 20_000,
        expiresAt: addOneMonthIso(periodEndUnix),
      }),
    ]);
  });

  it("webhooks-callbacks.bdd-039 (1/2) ignores entitlement redelivery, moves period on stale invoices, and grants renewals", async () => {
    const startMs = Date.parse("2026-06-01T12:00:00.000Z");
    mockNow(startMs);
    const startSec = Math.floor(startMs / 1000);
    const member = bdd.user({ orgRole: "org:admin" });

    webhooks.configureStripeBillingEnv();
    const { customerId, subscriptionId, invoiceId } =
      await runs.grantProEntitlement(member, {
        periodEndUnix: startSec + 30 * DAY_SECONDS,
      });

    const mockSub = (periodEnd: number) => {
      context.mocks.stripe.customers.retrieve.mockResolvedValue({
        id: customerId,
        metadata: { orgId: member.orgId },
      });
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
        stripeSubscriptionObject({
          id: subscriptionId,
          customerId,
          priceId: "price_bdd_pro",
          periodStart: periodEnd - 30 * DAY_SECONDS,
          periodEnd,
        }),
      );
    };

    mockSub(startSec + 30 * DAY_SECONDS);
    await webhooks.postStripeEvent(
      stripeEvent(
        "invoice.paid",
        subscriptionInvoiceObject({
          id: invoiceId,
          customerId,
          subscriptionId,
          priceId: "price_bdd_pro",
          periodStart: startSec,
          periodEnd: startSec + 30 * DAY_SECONDS,
        }),
      ),
      [200],
    );
    const afterRedelivery = await billing.readBillingStatus(member);
    expect(afterRedelivery.credits).toBe(20_000);
    expect(afterRedelivery.creditGrants).toHaveLength(1);

    const stalePeriodEnd = startSec - 60 * DAY_SECONDS;
    const staleInvoiceId = stripeId("in_stale");
    mockSub(stalePeriodEnd);
    const staleEvent = stripeEvent(
      "invoice.paid",
      subscriptionInvoiceObject({
        id: staleInvoiceId,
        customerId,
        subscriptionId,
        priceId: "price_bdd_pro",
        periodStart: stalePeriodEnd - 30 * DAY_SECONDS,
        periodEnd: stalePeriodEnd,
      }),
    );
    await webhooks.postStripeEvent(staleEvent, [200]);
    const afterStale = await billing.readBillingStatus(member);
    expect(afterStale.credits).toBe(20_000);
    expect(afterStale.creditGrants).toHaveLength(1);
    expect(afterStale.currentPeriodEnd).toBe(
      new Date(stalePeriodEnd * 1000).toISOString(),
    );

    const renewalPeriodEnd = startSec + 60 * DAY_SECONDS;
    mockSub(renewalPeriodEnd);
    await webhooks.postStripeEvent(
      stripeEvent(
        "invoice.paid",
        subscriptionInvoiceObject({
          customerId,
          subscriptionId,
          priceId: "price_bdd_pro",
          periodStart: startSec + 30 * DAY_SECONDS,
          periodEnd: renewalPeriodEnd,
        }),
      ),
      [200],
    );
    const afterRenewal = await billing.readBillingStatus(member);
    expect(afterRenewal.credits).toBe(40_000);
    expect(afterRenewal.creditGrants).toHaveLength(2);
  });

  it("webhooks-callbacks.bdd-039 (2/2) deduplicates concurrent renewal invoices and ignores stale redeliveries and plan-less invoices", async () => {
    const startMs = Date.parse("2026-06-01T12:00:00.000Z");
    mockNow(startMs);
    const startSec = Math.floor(startMs / 1000);
    const member = bdd.user({ orgRole: "org:admin" });

    webhooks.configureStripeBillingEnv();
    const { customerId, subscriptionId } = await runs.grantProEntitlement(
      member,
      { periodEndUnix: startSec + 30 * DAY_SECONDS },
    );

    const mockSub = (periodEnd: number) => {
      context.mocks.stripe.customers.retrieve.mockResolvedValue({
        id: customerId,
        metadata: { orgId: member.orgId },
      });
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
        stripeSubscriptionObject({
          id: subscriptionId,
          customerId,
          priceId: "price_bdd_pro",
          periodStart: periodEnd - 30 * DAY_SECONDS,
          periodEnd,
        }),
      );
    };

    const stalePeriodEnd = startSec - 60 * DAY_SECONDS;
    const staleEvent = stripeEvent(
      "invoice.paid",
      subscriptionInvoiceObject({
        id: stripeId("in_stale"),
        customerId,
        subscriptionId,
        priceId: "price_bdd_pro",
        periodStart: stalePeriodEnd - 30 * DAY_SECONDS,
        periodEnd: stalePeriodEnd,
      }),
    );
    mockSub(stalePeriodEnd);
    await webhooks.postStripeEvent(staleEvent, [200]);

    const renewalPeriodEnd = startSec + 60 * DAY_SECONDS;
    mockSub(renewalPeriodEnd);
    await webhooks.postStripeEvent(
      stripeEvent(
        "invoice.paid",
        subscriptionInvoiceObject({
          customerId,
          subscriptionId,
          priceId: "price_bdd_pro",
          periodStart: startSec + 30 * DAY_SECONDS,
          periodEnd: renewalPeriodEnd,
        }),
      ),
      [200],
    );

    const dupEvent = stripeEvent(
      "invoice.paid",
      subscriptionInvoiceObject({
        id: stripeId("in_dup"),
        customerId,
        subscriptionId,
        priceId: "price_bdd_pro",
        periodStart: startSec + 60 * DAY_SECONDS,
        periodEnd: startSec + 90 * DAY_SECONDS,
      }),
    );
    mockSub(startSec + 90 * DAY_SECONDS);
    await Promise.all([
      webhooks.postStripeEvent(dupEvent, [200]),
      webhooks.postStripeEvent(dupEvent, [200]),
    ]);
    const afterConcurrent = await billing.readBillingStatus(member);
    expect(afterConcurrent.credits).toBe(60_000);
    expect(afterConcurrent.creditGrants).toHaveLength(3);

    mockSub(stalePeriodEnd);
    await webhooks.postStripeEvent(staleEvent, [200]);
    mockSub(startSec + 90 * DAY_SECONDS);
    await webhooks.postStripeEvent(
      stripeEvent(
        "invoice.paid",
        subscriptionInvoiceObject({
          customerId,
          subscriptionId,
          priceId: null,
          periodStart: startSec + 60 * DAY_SECONDS,
          periodEnd: startSec + 90 * DAY_SECONDS,
        }),
      ),
      [200],
    );
    const finalStatus = await billing.readBillingStatus(member);
    expect(finalStatus.credits).toBe(60_000);
  });

  it("webhooks-callbacks.bdd-040 atomically accumulates distinct auto-recharge invoices", async () => {
    const member = bdd.user({ orgRole: "org:admin" });
    const orgId = member.orgId;
    if (!orgId) {
      throw new Error("Expected member orgId");
    }

    webhooks.configureStripeBillingEnv();
    await runs.grantProEntitlement(member);

    const autoEvent = (invoiceId: string) => {
      return stripeEvent("invoice.paid", {
        id: invoiceId,
        customer: null,
        subtotal: 0,
        metadata: {
          type: "auto_recharge",
          orgId,
          creditsAmount: "5000",
        },
        parent: null,
        lines: { has_more: false, data: [] },
      });
    };

    const invoiceA = stripeId("in_auto_a");
    const invoiceB = stripeId("in_auto_b");
    await Promise.all([
      webhooks.postStripeEvent(autoEvent(invoiceA), [200]),
      webhooks.postStripeEvent(autoEvent(invoiceA), [200]),
      webhooks.postStripeEvent(autoEvent(invoiceB), [200]),
    ]);

    const status = await billing.readBillingStatus(member);
    expect(status.credits).toBe(30_000);
    const autoGrants = status.creditGrants.filter((grant) => {
      return grant.source === "auto_recharge";
    });
    expect(autoGrants).toHaveLength(2);
    for (const grant of autoGrants) {
      expect(grant).toMatchObject({ amount: 5000, remaining: 5000 });
      expect(new Date(grant.expiresAt).getUTCFullYear()).toBeGreaterThanOrEqual(
        2999,
      );
    }
  });

  it("webhooks-callbacks.bdd-041 (1/2) grants, refreshes, and clamps trial credits across trial invoices and updates", async () => {
    const startMs = Date.parse("2026-06-01T12:00:00.000Z");
    mockNow(startMs);
    const startSec = Math.floor(startMs / 1000);
    const member = bdd.user({ orgRole: "org:admin" });
    await bdd.completeOnboarding(member);
    webhooks.configureStripeBillingEnv();

    const customerId = stripeId("cus");
    const subscriptionId = stripeId("sub");
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      metadata: { orgId: member.orgId },
    });

    const trial1End = startSec + 7 * DAY_SECONDS;
    const period1End = startSec + 30 * DAY_SECONDS;
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      stripeSubscriptionObject({
        id: subscriptionId,
        customerId,
        priceId: "price_bdd_pro",
        status: "trialing",
        periodStart: startSec,
        periodEnd: period1End,
        trialEnd: trial1End,
      }),
    );
    await webhooks.postStripeEvent(
      stripeEvent(
        "invoice.paid",
        subscriptionInvoiceObject({
          customerId,
          subscriptionId,
          priceId: "price_bdd_pro",
          periodStart: startSec,
          periodEnd: period1End,
        }),
      ),
      [200],
    );
    const afterFirst = await billing.readBillingStatus(member);
    expect(afterFirst).toMatchObject({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "trialing",
      currentPeriodEnd: new Date(period1End * 1000).toISOString(),
    });
    expect(afterFirst.creditExpiry.nextExpiryDate).toBe(
      new Date(trial1End * 1000).toISOString(),
    );

    const trial2End = startSec + 14 * DAY_SECONDS;
    const period2End = startSec + 60 * DAY_SECONDS;
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      stripeSubscriptionObject({
        id: subscriptionId,
        customerId,
        priceId: "price_bdd_pro",
        status: "trialing",
        periodStart: startSec,
        periodEnd: period2End,
        trialEnd: trial2End,
      }),
    );
    await webhooks.postStripeEvent(
      stripeEvent(
        "invoice.paid",
        subscriptionInvoiceObject({
          customerId,
          subscriptionId,
          priceId: "price_bdd_pro",
          periodStart: startSec,
          periodEnd: period2End,
        }),
      ),
      [200],
    );
    const afterSecond = await billing.readBillingStatus(member);
    expect(afterSecond.credits).toBe(20_000);
    expect(afterSecond.creditGrants).toHaveLength(1);
    expect(afterSecond.currentPeriodEnd).toBe(
      new Date(period2End * 1000).toISOString(),
    );
    expect(afterSecond.creditExpiry.nextExpiryDate).toBe(
      new Date(trial2End * 1000).toISOString(),
    );

    const shortenedTrialEnd = startSec + 10 * DAY_SECONDS;
    const shortenedSub = stripeSubscriptionObject({
      id: subscriptionId,
      customerId,
      priceId: "price_bdd_pro",
      status: "trialing",
      periodStart: startSec,
      periodEnd: shortenedTrialEnd,
      trialEnd: shortenedTrialEnd,
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(shortenedSub);
    const shortenEvent = stripeEvent(
      "customer.subscription.updated",
      shortenedSub,
      { trial_end: trial2End },
    );
    await webhooks.postStripeEvent(shortenEvent, [200]);
    const afterShorten = await billing.readBillingStatus(member);
    const shortenedIso = new Date(shortenedTrialEnd * 1000).toISOString();
    expect(afterShorten.currentPeriodEnd).toBe(shortenedIso);
    expect(afterShorten.creditExpiry.nextExpiryDate).toBe(shortenedIso);

    const overlapResults = await Promise.all([
      webhooks.postStripeEvent(shortenEvent, [200, 500]),
      webhooks.postStripeEvent(shortenEvent, [200, 500]),
    ]);
    expect(
      overlapResults.some((result) => {
        return result.status === 200;
      }),
    ).toBeTruthy();
    if (
      overlapResults.some((result) => {
        return result.status === 500;
      })
    ) {
      await webhooks.postStripeEvent(shortenEvent, [200]);
    }
    const afterOverlap = await billing.readBillingStatus(member);
    expect(afterOverlap).toMatchObject({
      credits: 20_000,
      subscriptionStatus: "trialing",
      currentPeriodEnd: shortenedIso,
    });
    expect(afterOverlap.creditGrants).toHaveLength(1);
    expect(afterOverlap.creditExpiry.nextExpiryDate).toBe(shortenedIso);
  });

  it("webhooks-callbacks.bdd-041 (2/2) preserves trial credits on checkout and drops expired trial-extension invoices", async () => {
    const startMs = Date.parse("2026-06-01T12:00:00.000Z");
    mockNow(startMs);
    const startSec = Math.floor(startMs / 1000);
    const member = bdd.user({ orgRole: "org:admin" });
    await bdd.completeOnboarding(member);
    webhooks.configureStripeBillingEnv();

    const customerId = stripeId("cus");
    const subscriptionId = stripeId("sub");
    const trialEnd = startSec + 10 * DAY_SECONDS;
    const trialSub = stripeSubscriptionObject({
      id: subscriptionId,
      customerId,
      priceId: "price_bdd_pro",
      status: "trialing",
      periodStart: startSec,
      periodEnd: trialEnd,
      trialEnd,
    });
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      metadata: { orgId: member.orgId },
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(trialSub);

    await webhooks.postStripeEvent(
      stripeEvent(
        "invoice.paid",
        subscriptionInvoiceObject({
          customerId,
          subscriptionId,
          priceId: "price_bdd_pro",
          periodStart: startSec,
          periodEnd: trialEnd,
        }),
      ),
      [200],
    );

    await webhooks.postStripeEvent(
      stripeEvent("checkout.session.completed", {
        id: stripeId("cs"),
        mode: "subscription",
        payment_status: "no_payment_required",
        customer: customerId,
        subscription: subscriptionId,
        metadata: { orgId: member.orgId },
      }),
      [200],
    );
    const afterCheckout = await billing.readBillingStatus(member);
    expect(afterCheckout.credits).toBe(20_000);

    mockNow((trialEnd + 60) * 1000);
    const extensionInvoice = stripeEvent(
      "invoice.paid",
      subscriptionInvoiceObject({
        id: stripeId("in_ext"),
        customerId,
        subscriptionId,
        priceId: "price_bdd_pro",
        periodStart: startSec,
        periodEnd: trialEnd,
      }),
    );
    await webhooks.postStripeEvent(extensionInvoice, [200]);
    const afterExpired1 = await billing.readBillingStatus(member);
    expect(afterExpired1).toMatchObject({
      credits: 0,
      creditGrants: [],
      subscriptionStatus: "trialing",
    });

    await webhooks.postStripeEvent(extensionInvoice, [200]);
    const afterExpired2 = await billing.readBillingStatus(member);
    expect(afterExpired2.credits).toBe(0);
  });

  it("webhooks-callbacks.bdd-045 keeps a newer purchase when the previous invoice is redelivered", async () => {
    const startMs = Date.parse("2026-06-01T12:00:00.000Z");
    mockNow(startMs);
    const startSec = Math.floor(startMs / 1000);
    const member = bdd.user({ orgRole: "org:admin" });
    webhooks.configureStripeBillingEnv();

    const { customerId, subscriptionId: originalSubId } =
      await runs.grantProEntitlement(member, {
        periodEndUnix: startSec + 30 * DAY_SECONDS,
      });

    const teamSubId = stripeId("sub_team");
    const teamInvoiceId = stripeId("in_team");
    const teamSub = stripeSubscriptionObject({
      id: teamSubId,
      customerId,
      priceId: "price_bdd_team",
      status: "active",
      periodStart: startSec,
      periodEnd: startSec + 30 * DAY_SECONDS,
    });
    const teamInvoiceEvent = stripeEvent(
      "invoice.paid",
      subscriptionInvoiceObject({
        id: teamInvoiceId,
        customerId,
        subscriptionId: teamSubId,
        priceId: "price_bdd_team",
        periodStart: startSec,
        periodEnd: startSec + 30 * DAY_SECONDS,
      }),
    );
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      metadata: { orgId: member.orgId },
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(teamSub);
    await webhooks.postStripeEvent(teamInvoiceEvent, [200]);
    expect((await billing.readBillingStatus(member)).credits).toBe(140_000);

    await webhooks.postStripeEvent(
      stripeEvent("customer.subscription.deleted", {
        ...teamSub,
        status: "canceled",
      }),
      [200],
    );

    const newerProSubId = stripeId("sub_pro_new");
    const newerProSub = stripeSubscriptionObject({
      id: newerProSubId,
      customerId,
      priceId: "price_bdd_pro",
      status: "active",
      periodStart: startSec,
      periodEnd: startSec + 30 * DAY_SECONDS,
    });
    context.mocks.stripe.subscriptions.retrieve.mockImplementation(
      (id: unknown) => {
        if (id === teamSubId) {
          return Promise.resolve({ ...teamSub, status: "canceled" });
        }
        return Promise.resolve(newerProSub);
      },
    );
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [newerProSub],
      has_more: false,
    });
    await webhooks.postStripeEvent(
      stripeEvent("checkout.session.completed", {
        id: stripeId("cs_new_pro"),
        mode: "subscription",
        payment_status: "paid",
        customer: customerId,
        subscription: newerProSubId,
        metadata: { orgId: member.orgId },
      }),
      [200],
    );

    const beforeRedelivery = await billing.readBillingStatus(member);
    const canceledIds: string[] = [];
    context.mocks.stripe.subscriptions.cancel.mockImplementation(
      (id: unknown) => {
        if (typeof id === "string") {
          canceledIds.push(id);
        }
        return Promise.resolve({ id, status: "canceled" });
      },
    );

    await webhooks.postStripeEvent(teamInvoiceEvent, [200]);
    for (const canceledId of canceledIds) {
      if (canceledId === originalSubId || canceledId === teamSubId) {
        await webhooks.postStripeEvent(
          stripeEvent("customer.subscription.deleted", {
            id: canceledId,
            customer: customerId,
            status: "canceled",
            metadata: {},
            items: { data: [{ price: { id: "price_bdd_team" } }] },
          }),
          [200],
        );
      }
    }

    const afterRedelivery = await billing.readBillingStatus(member);
    expect(afterRedelivery).toMatchObject({
      tier: beforeRedelivery.tier,
      credits: beforeRedelivery.credits,
      hasSubscription: true,
      subscriptionStatus: "active",
      creditGrants: beforeRedelivery.creditGrants,
    });
  });

  it("webhooks-callbacks.bdd-047 keeps Stripe quantity across prorations and stale events", async () => {
    const startMs = Date.parse("2026-06-01T12:00:00.000Z");
    mockNow(startMs);
    const startSec = Math.floor(startMs / 1000);
    const periodEnd = startSec + 30 * DAY_SECONDS;
    const member = bdd.user({ orgRole: "org:admin" });
    webhooks.configureStripeBillingEnv();

    const { customerId } = await runs.grantProEntitlement(member, {
      periodEndUnix: periodEnd,
    });
    const concSubId = stripeId("sub_conc");

    const concSub = (quantity: number, status = "active") => {
      return stripeSubscriptionObject({
        id: concSubId,
        customerId,
        priceId: "price_bdd_concurrency",
        status,
        periodStart: startSec,
        periodEnd,
        quantity,
        metadata: { purpose: "concurrency_subscription" },
      });
    };

    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      metadata: { orgId: member.orgId },
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(concSub(10));
    await webhooks.postStripeEvent(
      stripeEvent("invoice.paid", {
        id: stripeId("in_conc_10"),
        customer: customerId,
        metadata: { purpose: "concurrency_subscription" },
        subtotal: 0,
        parent: {
          subscription_details: {
            subscription: concSubId,
            metadata: { purpose: "concurrency_subscription" },
          },
        },
        lines: {
          has_more: false,
          data: [
            {
              id: stripeId("il"),
              price: { id: "price_bdd_concurrency" },
              quantity: 10,
              amount: 1000,
              parent: { type: "subscription_item_details" },
              period: { start: startSec, end: periodEnd },
            },
          ],
        },
      }),
      [200],
    );
    expect(
      (await billing.readBillingStatus(member)).concurrencySubscriptions,
    ).toMatchObject([{ id: concSubId, quantity: 10 }]);

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(concSub(2));
    await webhooks.postStripeEvent(
      stripeEvent("customer.subscription.updated", concSub(2)),
      [200],
    );
    await webhooks.postStripeEvent(
      stripeEvent("invoice.paid", {
        id: stripeId("in_conc_prorate"),
        customer: customerId,
        metadata: { purpose: "concurrency_subscription" },
        subtotal: 0,
        parent: {
          subscription_details: {
            subscription: concSubId,
            metadata: { purpose: "concurrency_subscription" },
          },
        },
        lines: {
          has_more: false,
          data: [
            {
              id: stripeId("il_credit"),
              price: { id: "price_bdd_concurrency" },
              quantity: 10,
              amount: -800,
              parent: { type: "subscription_item_details" },
              period: { start: startSec, end: periodEnd },
            },
            {
              id: stripeId("il_charge"),
              price: { id: "price_bdd_concurrency" },
              quantity: 2,
              amount: 200,
              parent: { type: "subscription_item_details" },
              period: { start: startSec, end: periodEnd },
            },
          ],
        },
      }),
      [200],
    );
    expect(
      (await billing.readBillingStatus(member)).concurrencySubscriptions,
    ).toMatchObject([{ id: concSubId, quantity: 2 }]);

    await webhooks.postStripeEvent(
      stripeEvent("customer.subscription.updated", concSub(10)),
      [200],
    );
    await webhooks.postStripeEvent(
      stripeEvent("customer.subscription.updated", concSub(10)),
      [200],
    );
    expect(
      (await billing.readBillingStatus(member)).concurrencySubscriptions,
    ).toMatchObject([{ id: concSubId, quantity: 2 }]);

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      concSub(0, "canceled"),
    );
    await webhooks.postStripeEvent(
      stripeEvent("customer.subscription.deleted", concSub(2, "canceled")),
      [200],
    );
  });

  it("webhooks-callbacks.bdd-049 binds checkout and dashboard subscriptions to orgs without double-binding", async () => {
    const startMs = Date.parse("2026-06-01T12:00:00.000Z");
    mockNow(startMs);
    const startSec = Math.floor(startMs / 1000);
    const periodEnd = startSec + 30 * DAY_SECONDS;
    const member = bdd.user({ orgRole: "org:admin" });
    const lateMember = bdd.user({ orgRole: "org:admin" });
    await bdd.completeOnboarding(member);
    webhooks.configureStripeBillingEnv();

    const customerId = stripeId("cus_primary");
    const subId = stripeId("sub_primary");
    const checkoutSubId = stripeId("sub_checkout");
    const otherSubId = stripeId("sub_other");
    const unknownCustomerId = stripeId("cus_unknown");
    const conflictingCustomerId = stripeId("cus_conflict");
    const lateCustomerId = stripeId("cus_late");
    const lateSubId = stripeId("sub_late");

    context.mocks.stripe.customers.retrieve.mockImplementation(
      (id: unknown) => {
        if (id === customerId || id === conflictingCustomerId) {
          return Promise.resolve({ id, metadata: { orgId: member.orgId } });
        }
        if (id === lateCustomerId) {
          return Promise.resolve({ id, metadata: { orgId: lateMember.orgId } });
        }
        return Promise.resolve({ id, metadata: {} });
      },
    );
    context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
      id: lateMember.orgId,
      slug: "late-org",
      name: "Late Org",
      createdBy: lateMember.userId,
    });

    const dashSub = stripeSubscriptionObject({
      id: subId,
      customerId,
      priceId: "price_bdd_pro",
      status: "active",
      periodStart: startSec,
      periodEnd,
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(dashSub);
    await webhooks.postStripeEvent(
      stripeEvent("customer.subscription.created", dashSub),
      [200],
    );
    const afterDash = await billing.readBillingStatus(member);
    expect(afterDash).toMatchObject({
      hasSubscription: true,
      subscriptionStatus: "active",
      tier: "limited-free-1",
      currentPeriodEnd: null,
    });

    await webhooks.postStripeEvent(
      stripeEvent(
        "customer.subscription.created",
        stripeSubscriptionObject({
          id: stripeId("sub_incomplete"),
          customerId,
          priceId: "price_bdd_pro",
          status: "incomplete",
          periodStart: startSec,
          periodEnd,
        }),
      ),
      [200],
    );
    await expect(billing.readBillingStatus(member)).resolves.toMatchObject({
      subscriptionStatus: "active",
      tier: "limited-free-1",
    });

    const checkoutSub = stripeSubscriptionObject({
      id: checkoutSubId,
      customerId,
      priceId: "price_bdd_pro",
      status: "active",
      periodStart: startSec,
      periodEnd,
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(checkoutSub);
    const checkoutEvent = stripeEvent("checkout.session.completed", {
      id: stripeId("cs_sub"),
      mode: "subscription",
      payment_status: "paid",
      customer: customerId,
      subscription: checkoutSubId,
      metadata: { orgId: member.orgId },
    });
    await webhooks.postStripeEvent(checkoutEvent, [200]);
    await webhooks.postStripeEvent(checkoutEvent, [200]);
    expect((await billing.readBillingStatus(member)).subscriptionStatus).toBe(
      "active",
    );

    await webhooks.postStripeEvent(
      stripeEvent(
        "invoice.paid",
        subscriptionInvoiceObject({
          customerId,
          subscriptionId: checkoutSubId,
          priceId: "price_bdd_pro",
          periodStart: startSec,
          periodEnd,
        }),
      ),
      [200],
    );
    await expect(billing.readBillingStatus(member)).resolves.toMatchObject({
      tier: "pro",
      credits: 20_000,
    });

    const otherSub = stripeSubscriptionObject({
      id: otherSubId,
      customerId,
      priceId: "price_bdd_pro",
      status: "active",
      periodStart: startSec,
      periodEnd,
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(otherSub);
    await webhooks.postStripeEvent(
      stripeEvent("checkout.session.completed", {
        id: stripeId("cs_same_tier"),
        mode: "subscription",
        payment_status: "paid",
        customer: customerId,
        subscription: otherSubId,
        metadata: { orgId: member.orgId },
      }),
      [200],
    );
    await webhooks.postStripeEvent(
      stripeEvent(
        "customer.subscription.created",
        stripeSubscriptionObject({
          id: stripeId("sub_unk"),
          customerId: unknownCustomerId,
          priceId: "price_bdd_pro",
          status: "active",
          periodStart: startSec,
          periodEnd,
        }),
      ),
      [200],
    );
    await webhooks.postStripeEvent(
      stripeEvent(
        "customer.subscription.created",
        stripeSubscriptionObject({
          id: stripeId("sub_conf"),
          customerId: conflictingCustomerId,
          priceId: "price_bdd_pro",
          status: "active",
          periodStart: startSec,
          periodEnd,
        }),
      ),
      [200],
    );
    await expect(billing.readBillingStatus(member)).resolves.toMatchObject({
      tier: "pro",
      subscriptionStatus: "active",
      credits: 20_000,
    });

    const lateSub = stripeSubscriptionObject({
      id: lateSubId,
      customerId: lateCustomerId,
      priceId: "price_bdd_pro",
      status: "active",
      periodStart: startSec,
      periodEnd,
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(lateSub);
    await webhooks.postStripeEvent(
      stripeEvent(
        "invoice.paid",
        subscriptionInvoiceObject({
          customerId: lateCustomerId,
          subscriptionId: lateSubId,
          priceId: "price_bdd_pro",
          periodStart: startSec,
          periodEnd,
        }),
      ),
      [200],
    );
    await expect(billing.readBillingStatus(lateMember)).resolves.toMatchObject({
      tier: "pro",
      credits: 20_000,
      hasSubscription: true,
    });
  });

  it("webhooks-callbacks.bdd-050 grants purchased custom credit amounts", async () => {
    const startMs = Date.parse("2026-06-01T12:00:00.000Z");
    mockNow(startMs);
    const member = bdd.user({ orgRole: "org:admin" });
    const orgId = member.orgId;
    if (!orgId) {
      throw new Error("Expected member orgId");
    }

    await bdd.completeOnboarding(member);
    webhooks.configureStripeBillingEnv();
    const baseline = (await billing.readBillingStatus(member)).credits;

    const campaignSessionId = stripeId("cs_zero");
    await webhooks.postStripeEvent(
      stripeEvent("checkout.session.completed", {
        id: campaignSessionId,
        mode: "payment",
        payment_status: "unpaid",
        invoice: null,
        subscription: null,
        customer: null,
        amount_subtotal: 0,
        amount_total: 0,
        metadata: {
          purpose: "one_time_purchase",
          orgId,
          campaignKey: "ZERO100",
        },
      }),
      [200],
    );
    expect((await billing.readBillingStatus(member)).credits).toBe(baseline);

    await webhooks.postStripeEvent(
      stripeEvent("checkout.session.async_payment_succeeded", {
        id: campaignSessionId,
        mode: "payment",
        payment_status: "paid",
        invoice: null,
        subscription: null,
        customer: null,
        amount_subtotal: 0,
        amount_total: 0,
        metadata: {
          purpose: "one_time_purchase",
          orgId,
          campaignKey: "ZERO100",
        },
      }),
      [200],
    );
    const afterAsync = await billing.readBillingStatus(member);
    expect(afterAsync.credits).toBe(baseline + 100_000);
    expect(afterAsync.creditGrants).toContainEqual(
      expect.objectContaining({
        source: "one_time_purchase",
        amount: 100_000,
      }),
    );

    const expiry45Iso = new Date(startMs + 45 * DAY_MS).toISOString();
    await webhooks.postStripeEvent(
      stripeEvent("checkout.session.completed", {
        id: stripeId("cs_legacy_credit"),
        mode: "payment",
        payment_status: "paid",
        invoice: null,
        subscription: null,
        customer: null,
        amount_total: 10_000,
        metadata: {
          purpose: "credit_purchase",
          orgId,
          creditsAmountMode: "amount_total",
          creditsExpiresAt: expiry45Iso,
        },
      }),
      [200],
    );
    const afterLegacy = await billing.readBillingStatus(member);
    expect(afterLegacy.credits).toBe(baseline + 200_000);
    expect(afterLegacy.creditGrants).toContainEqual(
      expect.objectContaining({
        source: "credit_purchase",
        amount: 100_000,
        expiresAt: expiry45Iso,
      }),
    );

    const creditInvoiceId = stripeId("in_credit_sub");
    const expiry90Iso = new Date(startMs + 90 * DAY_MS).toISOString();
    await webhooks.postStripeEvent(
      stripeEvent("checkout.session.completed", {
        id: stripeId("cs_inv_credit"),
        mode: "payment",
        payment_status: "paid",
        invoice: creditInvoiceId,
        subscription: null,
        customer: null,
        amount_subtotal: 10_000,
        metadata: {
          purpose: "credit_purchase",
          orgId,
          creditsAmountMode: "amount_subtotal",
          creditsExpiresAt: expiry90Iso,
        },
      }),
      [200],
    );
    expect((await billing.readBillingStatus(member)).credits).toBe(
      baseline + 200_000,
    );

    await webhooks.postStripeEvent(
      stripeEvent("invoice.paid", {
        id: creditInvoiceId,
        customer: null,
        subtotal: 10_000,
        metadata: {
          purpose: "credit_purchase",
          orgId,
          creditsExpiresAt: expiry90Iso,
        },
        parent: null,
        lines: { has_more: false, data: [] },
      }),
      [200],
    );
    const afterInvoice = await billing.readBillingStatus(member);
    expect(afterInvoice.credits).toBe(baseline + 300_000);
    expect(afterInvoice.creditGrants).toContainEqual(
      expect.objectContaining({
        source: "credit_purchase",
        amount: 100_000,
        expiresAt: expiry90Iso,
      }),
    );
  });

  it("webhooks-callbacks.bdd-054 preserves org data when a deleted user leaves an uncached Clerk member", async () => {
    webhooks.configureClerkWebhookSecret();
    webhooks.configureStripeBillingEnv();
    const admin = bdd.user({ orgRole: "org:admin" });
    const peer = bdd.user({ orgId: admin.orgId, orgRole: "org:member" });
    const orgId = admin.orgId;
    if (!orgId) {
      throw new Error("Expected admin orgId");
    }

    await runs.grantProEntitlement(admin);
    const clerkDeletes: unknown[] = [];
    const stripeMutations: unknown[] = [];
    context.mocks.clerk.organizations.deleteOrganization.mockImplementation(
      (id: unknown) => {
        clerkDeletes.push(id);
        return Promise.resolve({});
      },
    );
    context.mocks.stripe.subscriptions.update.mockImplementation(
      (id: unknown) => {
        stripeMutations.push(id);
        return Promise.resolve({});
      },
    );
    context.mocks.stripe.subscriptions.cancel.mockImplementation(
      (id: unknown) => {
        stripeMutations.push(id);
        return Promise.resolve({});
      },
    );
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [],
    });
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            role: "org:member",
            organization: { id: orgId },
            publicUserData: { userId: peer.userId },
          },
        ],
      },
    );

    webhooks.verifyNextClerkWebhook({
      type: "user.deleted",
      data: { id: admin.userId },
    });
    const deleted = await webhooks.requestClerkWebhook("{}", {}, [200]);
    expect(deleted.body).toBe("OK");
    await flushWaitUntilForTest();

    expect(clerkDeletes).toStrictEqual([]);
    expect(stripeMutations).toStrictEqual([]);
    await expect(billing.readBillingStatus(peer)).resolves.toMatchObject({
      tier: "pro",
      hasSubscription: true,
      subscriptionStatus: "active",
    });
  });

  it("webhooks-callbacks.bdd-056 (1/2) disarms the deleted user's automations while leaving another admin's automations enabled", async () => {
    webhooks.configureClerkWebhookSecret();
    webhooks.configureStripeBillingEnv();
    bdd.acceptStorageWrites();

    const org1Admin = bdd.user({ orgRole: "org:admin" });
    const sharedUserOrg1 = bdd.user({
      orgId: org1Admin.orgId,
      orgRole: "org:admin",
    });
    await runs.grantProEntitlement(org1Admin, { tier: "team" });

    const wfOther = await workflows.createWorkflow(org1Admin, {
      name: `other-${randomUUID().slice(0, 6)}`,
      instruction: "Other user workflow",
    });
    const wfShared1 = await workflows.createWorkflow(sharedUserOrg1, {
      name: `shared1-${randomUUID().slice(0, 6)}`,
      instruction: "Shared org1 workflow",
    });
    const otherAutos = await createLoopAndWebhookAutomations(
      org1Admin,
      wfOther,
    );
    const shared1Autos = await createLoopAndWebhookAutomations(
      sharedUserOrg1,
      wfShared1,
    );

    const otherLoopBefore = await readAutomationAs(
      org1Admin,
      otherAutos.loopId,
    );
    const s1LoopBefore = await readAutomationAs(org1Admin, shared1Autos.loopId);

    const clerkDeletes: unknown[] = [];
    context.mocks.clerk.organizations.deleteOrganization.mockImplementation(
      (id: unknown) => {
        clerkDeletes.push(id);
        return Promise.resolve({});
      },
    );
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            role: "org:admin",
            organization: { id: org1Admin.orgId },
            publicUserData: { userId: org1Admin.userId },
          },
        ],
      },
    );

    webhooks.verifyNextClerkWebhook({
      type: "user.deleted",
      data: { id: sharedUserOrg1.userId },
    });
    await webhooks.requestClerkWebhook("{}", {}, [200]);
    await flushWaitUntilForTest();

    expect(clerkDeletes).toStrictEqual([]);
    await expect(
      readAutomationAs(org1Admin, otherAutos.loopId),
    ).resolves.toMatchObject({
      id: otherLoopBefore.id,
      enabled: true,
      scheduleSummary: otherLoopBefore.scheduleSummary,
    });
    await expect(
      readAutomationAs(org1Admin, otherAutos.webhookId),
    ).resolves.toMatchObject({
      id: otherAutos.webhookId,
      enabled: true,
      eventType: "webhook-received",
    });
    await expect(
      readAutomationAs(org1Admin, shared1Autos.loopId),
    ).resolves.toMatchObject({
      id: s1LoopBefore.id,
      enabled: false,
      scheduleSummary: s1LoopBefore.scheduleSummary,
    });
    await expect(
      readAutomationAs(org1Admin, shared1Autos.webhookId),
    ).resolves.toMatchObject({
      id: shared1Autos.webhookId,
      enabled: false,
      eventType: "webhook-received",
    });
  });

  it("webhooks-callbacks.bdd-056 (2/2) disarms the deleted user's automations in a second workspace without deleting organizations", async () => {
    webhooks.configureClerkWebhookSecret();
    webhooks.configureStripeBillingEnv();
    bdd.acceptStorageWrites();

    const sharedUserOrg2 = bdd.user({ orgRole: "org:admin" });
    const peerOrg2 = bdd.user({
      orgId: sharedUserOrg2.orgId,
      orgRole: "org:admin",
    });
    await runs.grantProEntitlement(sharedUserOrg2, { tier: "team" });

    const wfShared2 = await workflows.createWorkflow(sharedUserOrg2, {
      name: `shared2-${randomUUID().slice(0, 6)}`,
      instruction: "Shared org2 workflow",
    });
    const shared2Autos = await createLoopAndWebhookAutomations(
      sharedUserOrg2,
      wfShared2,
    );
    const s2LoopBefore = await readAutomationAs(
      sharedUserOrg2,
      shared2Autos.loopId,
    );

    const clerkDeletes: unknown[] = [];
    context.mocks.clerk.organizations.deleteOrganization.mockImplementation(
      (id: unknown) => {
        clerkDeletes.push(id);
        return Promise.resolve({});
      },
    );
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            role: "org:admin",
            organization: { id: sharedUserOrg2.orgId },
            publicUserData: { userId: peerOrg2.userId },
          },
        ],
      },
    );

    webhooks.verifyNextClerkWebhook({
      type: "user.deleted",
      data: { id: sharedUserOrg2.userId },
    });
    await webhooks.requestClerkWebhook("{}", {}, [200]);
    await flushWaitUntilForTest();

    expect(clerkDeletes).toStrictEqual([]);
    await expect(
      readAutomationAs(peerOrg2, shared2Autos.loopId),
    ).resolves.toMatchObject({
      id: s2LoopBefore.id,
      enabled: false,
      scheduleSummary: s2LoopBefore.scheduleSummary,
    });
    await expect(
      readAutomationAs(peerOrg2, shared2Autos.webhookId),
    ).resolves.toMatchObject({
      id: shared2Autos.webhookId,
      enabled: false,
      eventType: "webhook-received",
    });
  });

  it("webhooks-callbacks.bdd-062 grants and renews Atom invoice-backed Team entitlements", async () => {
    const startMs = Date.parse("2026-06-01T12:00:00.000Z");
    mockNow(startMs);
    const startSec = Math.floor(startMs / 1000);
    const member = bdd.user({ orgRole: "org:admin" });
    const orgId = member.orgId;
    if (!orgId) {
      throw new Error("Expected member orgId");
    }

    await bdd.completeOnboarding(member);
    webhooks.configureStripeBillingEnv();
    mockEnv("ATOM_GRANT_PRICE", ATOM_GRANT_PRICE);
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [],
      has_more: false,
    });

    const end7Sec = startSec + 7 * DAY_SECONDS;
    const end7Iso = new Date(end7Sec * 1000).toISOString();
    await webhooks.postStripeEvent(
      stripeEvent("invoice.paid", {
        id: stripeId("in_atom_team_1"),
        customer: null,
        subtotal: 0,
        metadata: {
          purpose: "atom_grant",
          orgId,
          tier: "team",
          duration: "7d",
          atomGrantExpiresAt: end7Iso,
        },
        parent: null,
        lines: {
          has_more: false,
          data: [
            {
              id: stripeId("il"),
              price: { id: ATOM_GRANT_PRICE },
              quantity: 1,
              period: { start: startSec, end: end7Sec },
            },
          ],
        },
      }),
      [200],
    );

    const afterFirst = await billing.readBillingStatus(member);
    expect(afterFirst).toMatchObject({
      tier: "team",
      credits: 120_000,
      hasSubscription: false,
      currentPeriodEnd: end7Iso,
      canBuyConcurrency: true,
      canBuyCredits: true,
      workflowWebhookAutomationAllowed: true,
    });
    expect(afterFirst.creditGrants).toStrictEqual([
      expect.objectContaining({
        source: "subscription_renewal",
        amount: 120_000,
        expiresAt: end7Iso,
      }),
    ]);
    await expect(readVoiceQuota(member)).resolves.toMatchObject({
      allowed: true,
      limit: null,
    });

    const end14Sec = startSec + 14 * DAY_SECONDS;
    const end14Iso = new Date(end14Sec * 1000).toISOString();
    await webhooks.postStripeEvent(
      stripeEvent("invoice.paid", {
        id: stripeId("in_atom_team_2"),
        customer: null,
        subtotal: 0,
        metadata: {
          purpose: "atom_grant",
          orgId,
          tier: "team",
          duration: "14d",
          atomGrantExpiresAt: end14Iso,
        },
        parent: null,
        lines: {
          has_more: false,
          data: [
            {
              id: stripeId("il"),
              price: { id: ATOM_GRANT_PRICE },
              quantity: 1,
              period: { start: startSec, end: end14Sec },
            },
          ],
        },
      }),
      [200],
    );

    const afterRenewal = await billing.readBillingStatus(member);
    expect(afterRenewal).toMatchObject({
      tier: "team",
      credits: 240_000,
      hasSubscription: false,
      currentPeriodEnd: end14Iso,
      canBuyConcurrency: true,
    });
    expect(
      afterRenewal.creditGrants.map((grant) => {
        return { amount: grant.amount, expiresAt: grant.expiresAt };
      }),
    ).toStrictEqual(
      expect.arrayContaining([
        { amount: 120_000, expiresAt: end7Iso },
        { amount: 120_000, expiresAt: end14Iso },
      ]),
    );
  });

  it("webhooks-callbacks.bdd-063 expires Atom day-grant subscription credits at the Atom grant end", async () => {
    const startMs = Date.parse("2026-06-01T12:00:00.000Z");
    mockNow(startMs);
    const startSec = Math.floor(startMs / 1000);
    const periodEndUnix = startSec + 30 * DAY_SECONDS;
    const grantEndUnix = startSec + 7 * DAY_SECONDS;
    const grantEndIso = new Date(grantEndUnix * 1000).toISOString();
    const member = bdd.user({ orgRole: "org:admin" });

    webhooks.configureStripeBillingEnv();
    await runs.grantProEntitlement(member, {
      periodEndUnix,
      cancelAtUnix: grantEndUnix,
      subscriptionMetadata: {
        source: "atom_entitlement",
        duration: "7d",
        atomGrantExpiresAt: grantEndIso,
      },
    });

    const status = await billing.readBillingStatus(member);
    expect(status.tier).toBe("pro");
    expect(status.currentPeriodEnd).toBe(grantEndIso);
    expect(status.creditGrants).toStrictEqual([
      expect.objectContaining({
        source: "subscription_renewal",
        amount: 20_000,
        expiresAt: grantEndIso,
      }),
    ]);
  });

  it("webhooks-callbacks.bdd-066 grants Atom organization credits once and rejects an untrusted grant price", async () => {
    const startMs = Date.parse("2026-06-01T12:00:00.000Z");
    mockNow(startMs);
    const startSec = Math.floor(startMs / 1000);
    const member = bdd.user({ orgRole: "org:admin" });
    const orgId = member.orgId;
    if (!orgId) {
      throw new Error("Expected member orgId");
    }

    await bdd.completeOnboarding(member);
    webhooks.configureStripeBillingEnv();
    mockEnv("ATOM_GRANT_PRICE", ATOM_GRANT_PRICE);
    const baseline = (await billing.readBillingStatus(member)).credits;

    const expiry90Iso = new Date(startMs + 90 * DAY_MS).toISOString();
    await webhooks.postStripeEvent(
      stripeEvent("invoice.paid", {
        id: stripeId("in_atom_credits"),
        customer: null,
        subtotal: 0,
        metadata: {
          purpose: "atom_grant",
          grantType: "credits",
          orgId,
          creditsAmount: "2500",
          creditsExpiresAt: expiry90Iso,
        },
        parent: null,
        lines: {
          has_more: false,
          data: [
            {
              id: stripeId("il"),
              price: { id: ATOM_GRANT_PRICE },
              quantity: 1,
              period: { start: startSec, end: startSec + 90 * DAY_SECONDS },
            },
          ],
        },
      }),
      [200],
    );
    const afterTrusted = await billing.readBillingStatus(member);
    expect(afterTrusted.credits).toBe(baseline + 2500);
    expect(afterTrusted.creditGrants).toContainEqual(
      expect.objectContaining({
        source: "credit_purchase",
        amount: 2500,
        expiresAt: expiry90Iso,
      }),
    );

    await webhooks.postStripeEvent(
      stripeEvent("invoice.paid", {
        id: stripeId("in_atom_untrusted"),
        customer: null,
        subtotal: 0,
        metadata: {
          purpose: "atom_grant",
          grantType: "credits",
          orgId,
          creditsAmount: "9000",
          creditsExpiresAt: expiry90Iso,
        },
        parent: null,
        lines: {
          has_more: false,
          data: [
            {
              id: stripeId("il"),
              price: { id: "price_untrusted_other" },
              quantity: 1,
              period: { start: startSec, end: startSec + 90 * DAY_SECONDS },
            },
          ],
        },
      }),
      [200],
    );
    expect((await billing.readBillingStatus(member)).credits).toBe(
      baseline + 2500,
    );
  });

  it("webhooks-callbacks.bdd-067 delivers member credits once without changing a purchased Pro plan", async () => {
    const startMs = Date.parse("2026-06-01T12:00:00.000Z");
    mockNow(startMs);
    const startSec = Math.floor(startMs / 1000);
    const member = bdd.user({ orgRole: "org:admin" });
    const orgId = member.orgId;
    if (!orgId) {
      throw new Error("Expected member orgId");
    }

    webhooks.configureStripeBillingEnv();
    mockEnv("ATOM_GRANT_PRICE", ATOM_GRANT_PRICE);
    const { customerId } = await runs.grantProEntitlement(member);
    const before = await billing.readBillingStatus(member);

    const end7Sec = startSec + 7 * DAY_SECONDS;
    const end7Iso = new Date(end7Sec * 1000).toISOString();
    const memberGrantEvent = stripeEvent("invoice.paid", {
      id: stripeId("in_atom_member"),
      customer: customerId,
      subtotal: 0,
      metadata: {
        purpose: "atom_grant",
        grantType: "usage_pack_credits",
        source: "atom_usage_pack_credits",
        orgId,
        userId: member.userId,
        creditsAmount: "6000",
        creditsExpiresAt: end7Iso,
      },
      parent: null,
      lines: {
        has_more: false,
        data: [
          {
            id: stripeId("il"),
            price: { id: ATOM_GRANT_PRICE },
            quantity: 1,
            period: { start: startSec, end: end7Sec },
          },
        ],
      },
    });

    await webhooks.postStripeEvent(memberGrantEvent, [200]);
    await webhooks.postStripeEvent(memberGrantEvent, [200]);

    const usagePackCredits = await readUsagePackCredits(member);
    expect(usagePackCredits).toMatchObject({
      bonusCredits: 6000,
      purchasedCredits: 0,
    });
    expect(usagePackCredits.creditGrants).toStrictEqual([
      expect.objectContaining({
        grantType: "bonus",
        amount: 6000,
        remaining: 6000,
        expiresAt: end7Iso,
      }),
    ]);
    await expect(billing.readBillingStatus(member)).resolves.toStrictEqual(
      before,
    );
  });

  it("webhooks-callbacks.bdd-068 publishes pro plan and member credits exactly once", async () => {
    const startMs = Date.parse("2026-06-01T12:00:00.000Z");
    mockNow(startMs);
    const startSec = Math.floor(startMs / 1000);
    const member = bdd.user({ orgRole: "org:admin" });
    const orgId = member.orgId;
    if (!orgId) {
      throw new Error("Expected member orgId");
    }

    await bdd.completeOnboarding(member);
    webhooks.configureStripeBillingEnv();
    mockEnv("ATOM_GRANT_PRICE", ATOM_GRANT_PRICE);
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [],
      has_more: false,
    });

    const end7Sec = startSec + 7 * DAY_SECONDS;
    const end7Iso = new Date(end7Sec * 1000).toISOString();
    const redeemEvent = stripeEvent("invoice.paid", {
      id: stripeId("in_atom_redeem"),
      customer: stripeId("cus_atom"),
      subtotal: 0,
      metadata: {
        purpose: "atom_grant",
        source: "atom_redeem_code",
        planVersion: "usagePack",
        orgId,
        userId: member.userId,
        tier: "pro",
        duration: "7d",
        atomGrantExpiresAt: end7Iso,
        creditsAmount: "20000",
        creditsExpiresAt: end7Iso,
      },
      parent: null,
      lines: {
        has_more: false,
        data: [
          {
            id: stripeId("il"),
            price: { id: ATOM_GRANT_PRICE },
            quantity: 1,
            period: { start: startSec, end: end7Sec },
          },
        ],
      },
    });

    await webhooks.postStripeEvent(redeemEvent, [200]);
    await webhooks.postStripeEvent(redeemEvent, [200]);

    const status = await billing.readBillingStatus(member);
    expect(status).toMatchObject({
      tier: "pro",
      credits: 0,
      hasSubscription: false,
      subscriptionStatus: "atom_grant",
      currentPeriodEnd: end7Iso,
      showUsagePack: true,
    });

    const usagePackCredits = await readUsagePackCredits(member);
    expect(usagePackCredits.bonusCredits).toBe(20_000);
    expect(usagePackCredits.creditGrants).toStrictEqual([
      expect.objectContaining({
        amount: 20_000,
        remaining: 20_000,
        expiresAt: end7Iso,
      }),
    ]);
  });
});
