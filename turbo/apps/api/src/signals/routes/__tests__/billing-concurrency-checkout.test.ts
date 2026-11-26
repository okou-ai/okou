import { randomUUID } from "node:crypto";

import {
  billingConcurrencyCheckoutContract,
  billingConcurrencySubscriptionContract,
  billingDowngradeContract,
  billingStatusContract,
} from "@okouai/api-contracts/contracts/billing";
import { webhookStripeContract } from "@okouai/api-contracts/contracts/webhooks";
import Stripe from "stripe";
import { describe, expect, it } from "vitest";

import { apiTestEnvironment } from "../../../__tests__/test-environment";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { billingConcurrencyCheckoutRoutes } from "../billing-concurrency-checkout";
import { billingConcurrencySubscriptionRoutes } from "../billing-concurrency-subscriptions";
import { billingDowngradeRoutes } from "../billing-downgrade";
import { billingStatusRoutes } from "../billing-status";
import { webhooksStripeRoutes } from "../webhooks-stripe";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

const APP_ORIGIN = new URL(apiTestEnvironment.APP_URL).origin;
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const PRO_PRICE = apiTestEnvironment.OKOU_PRICE_PRO;
const TEAM_PRICE = apiTestEnvironment.OKOU_PRICE_TEAM;
const CONCURRENCY_PRICE = apiTestEnvironment.OKOU_PRICE_CONCURRENCY;
const ALLOWANCE_PRICE = "price_archived_usage_allowance";
const DAY_SECONDS = 86_400;
const MONTHLY_RECURRING = Object.freeze({
  interval: "month" as const,
  interval_count: 1,
});
const REDIRECTS = Object.freeze({
  successUrl: `${APP_ORIGIN}/billing?concurrency=success`,
  cancelUrl: `${APP_ORIGIN}/billing?concurrency=canceled`,
});
const RETURN_URL = `${APP_ORIGIN}/settings/billing`;
const PLAN_ENDING_REDUCE_MESSAGE =
  "Restore your Plan before reducing concurrency while a Plan downgrade or cancellation is scheduled.";
const PLAN_ENDING_CANCEL_MESSAGE =
  "Restore your Plan before canceling concurrency while a Plan downgrade or cancellation is scheduled.";

const app = setupApp({
  context,
  routes: [
    ...billingConcurrencyCheckoutRoutes,
    ...billingConcurrencySubscriptionRoutes,
    ...billingDowngradeRoutes,
    ...billingStatusRoutes,
    ...webhooksStripeRoutes,
  ],
});
const concurrencyCheckout = app(billingConcurrencyCheckoutContract);
const concurrencySub = app(billingConcurrencySubscriptionContract);
const billingDowngrade = app(billingDowngradeContract);
const billingStatus = app(billingStatusContract);
const stripeWebhook = app(webhookStripeContract);

interface OrgActor {
  readonly orgId: string;
  readonly userId: string;
}

interface PlanFixture extends OrgActor {
  readonly customerId: string;
  readonly subscriptionId: string;
  readonly periodStart: number;
  readonly periodEnd: number;
}

interface StandaloneConcurrencyFixture extends PlanFixture {
  readonly concurrencySubscriptionId: string;
  readonly concurrencyStart: number;
  readonly concurrencyEnd: number;
}

function newActor(): OrgActor {
  return {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  };
}

function signIn(
  actor: OrgActor,
  role: "org:admin" | "org:member" = "org:admin",
): void {
  createRouteMocks(context).clerk.session(actor.userId, actor.orgId, role);
}

function configureBillingEnv(): void {
  mockEnv("OKOU_PRICE_PRO", PRO_PRICE);
  mockEnv("OKOU_PRICE_TEAM", TEAM_PRICE);
  mockEnv("OKOU_PRICE_CONCURRENCY", CONCURRENCY_PRICE);
  mockOptionalEnv("STRIPE_SECRET_KEY", apiTestEnvironment.STRIPE_SECRET_KEY);
  mockOptionalEnv("STRIPE_WEBHOOK_SECRET", "whsec_concurrency_checkout_test");
}

function mockClerkOrg(actor: OrgActor): void {
  context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
    id: actor.orgId,
    slug: `conc-${actor.orgId.slice(-8)}`,
    name: "Concurrency Test Org",
    createdBy: actor.userId,
    createdAt: now(),
  });
}

async function readStatus() {
  return (await accept(billingStatus.get({ headers }), [200])).body;
}

async function deliverStripeEvent(
  event: Readonly<Record<string, unknown>>,
): Promise<void> {
  configureBillingEnv();
  const stripeEvent = {
    id: `evt_${randomUUID()}`,
    created: Math.floor(now() / 1000),
    ...event,
  };
  context.mocks.stripe.webhooks.constructEventAsync.mockReturnValueOnce(
    stripeEvent,
  );
  await accept(
    stripeWebhook.post({
      body: JSON.stringify(stripeEvent),
      extraHeaders: { "stripe-signature": "t=1,v1=concurrency-checkout" },
    }),
    [200],
  );
}

function planItem(
  priceId: string,
  periodStart: number,
  periodEnd: number,
  id = "si_plan",
) {
  return {
    id,
    quantity: 1,
    price: { id: priceId, recurring: MONTHLY_RECURRING },
    current_period_start: periodStart,
    current_period_end: periodEnd,
  };
}

function concurrencyItem(
  quantity: number,
  periodStart: number,
  periodEnd: number,
  id = "si_concurrency",
) {
  return {
    id,
    quantity,
    price: { id: CONCURRENCY_PRICE, recurring: MONTHLY_RECURRING },
    current_period_start: periodStart,
    current_period_end: periodEnd,
  };
}

function prorationLine(args: {
  readonly amount: number;
  readonly prorationTimestamp: number;
  readonly periodEnd: number;
  readonly priceId?: string;
  readonly proration?: boolean;
}) {
  return {
    id: `il_${randomUUID().slice(0, 8)}`,
    amount: args.amount,
    pricing: {
      price_details: { price: args.priceId ?? CONCURRENCY_PRICE },
    },
    price: { id: args.priceId ?? CONCURRENCY_PRICE },
    parent: {
      subscription_item_details: { proration: args.proration ?? true },
    },
    period: {
      start: args.prorationTimestamp,
      end: args.periodEnd,
    },
    taxes: [],
  };
}

function recurringLine(args: {
  readonly amount: number;
  readonly periodStart: number;
  readonly periodEnd: number;
  readonly priceId?: string;
}) {
  return {
    id: `il_${randomUUID().slice(0, 8)}`,
    amount: args.amount,
    pricing: {
      price_details: { price: args.priceId ?? CONCURRENCY_PRICE },
    },
    price: { id: args.priceId ?? CONCURRENCY_PRICE },
    parent: { subscription_item_details: { proration: false } },
    period: {
      start: args.periodStart,
      end: args.periodEnd,
    },
    taxes: [],
  };
}

function previewInvoice(args: {
  readonly id?: string;
  readonly lines: readonly Record<string, unknown>[];
  readonly hasMore?: boolean;
}) {
  return {
    id: args.id ?? `in_preview_${randomUUID().slice(0, 8)}`,
    currency: "usd",
    lines: {
      has_more: args.hasMore ?? false,
      data: args.lines,
    },
  };
}

async function seedPlanWorkspace(args: {
  readonly tier: "pro" | "team";
  readonly periodEnd?: Date;
  readonly cancelAtPeriodEnd?: boolean;
  readonly cancelAt?: number | null;
}): Promise<PlanFixture> {
  configureBillingEnv();
  const actor = newActor();
  mockClerkOrg(actor);
  const customerId = `cus_${randomUUID().slice(0, 8)}`;
  const subscriptionId = `sub_${randomUUID().slice(0, 8)}`;
  const periodEnd = Math.floor(
    (args.periodEnd ?? new Date("2099-05-20T00:00:00.000Z")).getTime() / 1000,
  );
  const periodStart = periodEnd - 30 * DAY_SECONDS;
  const priceId = args.tier === "team" ? TEAM_PRICE : PRO_PRICE;
  const cancelAt =
    args.cancelAt !== undefined
      ? args.cancelAt
      : args.cancelAtPeriodEnd
        ? periodEnd
        : null;

  context.mocks.stripe.customers.retrieve.mockResolvedValue({
    id: customerId,
    metadata: { orgId: actor.orgId },
  });
  context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
    id: subscriptionId,
    status: "active",
    customer: customerId,
    cancel_at_period_end: args.cancelAtPeriodEnd ?? false,
    cancel_at: cancelAt,
    schedule: null,
    trial_end: null,
    metadata: {},
    items: {
      data: [planItem(priceId, periodStart, periodEnd)],
    },
  });

  await deliverStripeEvent({
    type: "invoice.paid",
    data: {
      object: {
        id: `in_plan_${randomUUID().slice(0, 8)}`,
        customer: customerId,
        metadata: {},
        subtotal: 0,
        parent: {
          subscription_details: {
            subscription: subscriptionId,
            metadata: {},
          },
        },
        lines: {
          has_more: false,
          data: [
            {
              id: `il_plan_${randomUUID().slice(0, 8)}`,
              price: { id: priceId },
              quantity: 1,
              parent: { type: "subscription_item_details" },
              period: { start: periodStart, end: periodEnd },
            },
          ],
        },
      },
    },
  });
  signIn(actor);
  return { ...actor, customerId, subscriptionId, periodStart, periodEnd };
}

async function attachSharedConcurrency(args: {
  readonly plan: PlanFixture;
  readonly slots: number;
  readonly concurrencyStart?: number;
  readonly concurrencyEnd?: number;
  readonly cancelAtPeriodEnd?: boolean;
  readonly cancelAt?: number | null;
}): Promise<{
  readonly concurrencyStart: number;
  readonly concurrencyEnd: number;
}> {
  const concurrencyEnd = args.concurrencyEnd ?? args.plan.periodEnd;
  const concurrencyStart =
    args.concurrencyStart ?? concurrencyEnd - 30 * DAY_SECONDS;
  const cancelAt =
    args.cancelAt !== undefined
      ? args.cancelAt
      : args.cancelAtPeriodEnd
        ? args.plan.periodEnd
        : null;

  context.mocks.stripe.customers.retrieve.mockResolvedValue({
    id: args.plan.customerId,
    metadata: { orgId: args.plan.orgId },
  });
  context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
    id: args.plan.subscriptionId,
    customer: args.plan.customerId,
    status: "active",
    cancel_at_period_end: args.cancelAtPeriodEnd ?? false,
    cancel_at: cancelAt,
    schedule: null,
    trial_end: null,
    metadata: {},
    items: {
      data: [
        planItem(TEAM_PRICE, args.plan.periodStart, args.plan.periodEnd),
        concurrencyItem(args.slots, concurrencyStart, concurrencyEnd),
      ],
    },
  });

  await deliverStripeEvent({
    type: "invoice.paid",
    data: {
      object: {
        id: `in_shared_conc_${randomUUID().slice(0, 8)}`,
        customer: args.plan.customerId,
        metadata: {},
        subtotal: 0,
        parent: {
          subscription_details: {
            subscription: args.plan.subscriptionId,
            metadata: {},
          },
        },
        lines: {
          has_more: false,
          data: [
            {
              id: `il_shared_conc_${randomUUID().slice(0, 8)}`,
              price: { id: CONCURRENCY_PRICE },
              quantity: args.slots,
              parent: { type: "subscription_item_details" },
              period: { start: concurrencyStart, end: concurrencyEnd },
            },
          ],
        },
      },
    },
  });
  return { concurrencyStart, concurrencyEnd };
}

async function seedStandaloneConcurrencyWorkspace(args: {
  readonly slots: number;
  readonly periodEnd?: Date;
}): Promise<StandaloneConcurrencyFixture> {
  const plan = await seedPlanWorkspace({
    tier: "team",
    periodEnd: args.periodEnd,
  });
  const concurrencySubscriptionId = `sub_conc_${randomUUID().slice(0, 8)}`;
  const concurrencyEnd = plan.periodEnd;
  const concurrencyStart = concurrencyEnd - 30 * DAY_SECONDS;

  context.mocks.stripe.customers.retrieve.mockResolvedValue({
    id: plan.customerId,
    metadata: { orgId: plan.orgId },
  });
  context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
    id: concurrencySubscriptionId,
    customer: plan.customerId,
    status: "active",
    cancel_at_period_end: false,
    cancel_at: null,
    schedule: null,
    trial_end: null,
    metadata: { purpose: "concurrency_subscription" },
    items: {
      data: [concurrencyItem(args.slots, concurrencyStart, concurrencyEnd)],
    },
  });

  await deliverStripeEvent({
    type: "invoice.paid",
    data: {
      object: {
        id: `in_standalone_${randomUUID().slice(0, 8)}`,
        customer: plan.customerId,
        metadata: { purpose: "concurrency_subscription" },
        subtotal: 0,
        parent: {
          subscription_details: {
            subscription: concurrencySubscriptionId,
            metadata: { purpose: "concurrency_subscription" },
          },
        },
        lines: {
          has_more: false,
          data: [
            {
              id: `il_standalone_${randomUUID().slice(0, 8)}`,
              price: { id: CONCURRENCY_PRICE },
              quantity: args.slots,
              parent: { type: "subscription_item_details" },
              period: { start: concurrencyStart, end: concurrencyEnd },
            },
          ],
        },
      },
    },
  });
  return {
    ...plan,
    concurrencySubscriptionId,
    concurrencyStart,
    concurrencyEnd,
  };
}

function clearStripeMocks(): void {
  const stripe = context.mocks.stripe;
  stripe.checkout.sessions.create.mockClear();
  stripe.billingPortal.sessions.create.mockClear();
  stripe.subscriptions.retrieve.mockClear();
  stripe.subscriptions.update.mockClear();
  stripe.subscriptionSchedules.create.mockClear();
  stripe.subscriptionSchedules.retrieve.mockClear();
  stripe.subscriptionSchedules.update.mockClear();
  stripe.subscriptionSchedules.release.mockClear();
  stripe.invoices.createPreview.mockClear();
  stripe.invoices.listLineItems.mockClear();
  stripe.invoices.finalizeInvoice.mockClear();
  stripe.invoices.pay.mockClear();
  stripe.invoices.retrieve.mockClear();
}

function extractIdempotencyKey(options: unknown): string | undefined {
  if (
    typeof options !== "object" ||
    options === null ||
    !("idempotencyKey" in options)
  ) {
    return undefined;
  }
  return typeof options.idempotencyKey === "string"
    ? options.idempotencyKey
    : undefined;
}

function respondDynamically<T>(produce: () => T): () => Promise<T> {
  return () => {
    return Promise.resolve(produce());
  };
}

describe("POST /api/billing/concurrency-checkout", () => {
  it("billing-concurrency-checkout-030 rejects in-app concurrency changes from non-admin members", async () => {
    const plan = await seedPlanWorkspace({ tier: "team" });
    clearStripeMocks();
    signIn(plan, "org:member");

    const response = await accept(
      concurrencySub.previewChange({
        headers,
        params: { subscriptionId: `sub_${randomUUID().slice(0, 8)}` },
        body: { quantity: 2 },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Only org admins can manage concurrency subscriptions",
        code: "FORBIDDEN",
      },
    });
    expect(context.mocks.stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it("billing-concurrency-checkout-035 rejects concurrency checkout for Pro workspaces", async () => {
    await seedPlanWorkspace({ tier: "pro" });
    clearStripeMocks();

    const response = await accept(
      concurrencyCheckout.create({
        headers,
        body: { quantity: 1, ...REDIRECTS },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Additional concurrency is only available for Team workspaces",
        code: "BAD_REQUEST",
      },
    });
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
  });

  it("billing-concurrency-checkout-048 returns 404 when canceling a concurrency subscription outside the org", async () => {
    await seedPlanWorkspace({ tier: "team" });
    clearStripeMocks();

    const response = await accept(
      concurrencySub.cancel({
        headers,
        params: { subscriptionId: `sub_other_${randomUUID().slice(0, 8)}` },
        body: {},
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it("billing-concurrency-checkout-013 activates concurrency on the Plan subscription without renewing Plan credits", async () => {
    const plan = await seedPlanWorkspace({
      tier: "team",
      periodEnd: new Date("2099-05-20T00:00:00.000Z"),
    });
    const initialCredits = (await readStatus()).credits;
    await attachSharedConcurrency({
      plan,
      slots: 3,
      concurrencyEnd: Math.floor(Date.parse("2099-05-20T00:00:00.000Z") / 1000),
    });

    const status = await readStatus();

    expect(status.credits).toBe(initialCredits);
    expect(status.hasSubscription).toBeTruthy();
    expect(status.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({
        id: plan.subscriptionId,
        quantity: 3,
        currentPeriodEnd: "2099-05-20T00:00:00.000Z",
      }),
    ]);
  });

  it("billing-concurrency-checkout-014 updates Plan and concurrency state from one shared subscription event", async () => {
    const plan = await seedPlanWorkspace({
      tier: "team",
      periodEnd: new Date("2099-05-20T00:00:00.000Z"),
    });
    await attachSharedConcurrency({ plan, slots: 3 });

    const updatedSubscription = {
      id: plan.subscriptionId,
      customer: plan.customerId,
      status: "past_due",
      cancel_at_period_end: true,
      cancel_at: plan.periodEnd,
      schedule: null,
      trial_end: null,
      metadata: {},
      items: {
        data: [
          planItem(TEAM_PRICE, plan.periodStart, plan.periodEnd),
          concurrencyItem(3, plan.periodStart, plan.periodEnd),
        ],
      },
    };
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: plan.customerId,
      metadata: { orgId: plan.orgId },
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      updatedSubscription,
    );
    await deliverStripeEvent({
      type: "customer.subscription.updated",
      data: {
        object: updatedSubscription,
      },
    });

    const status = await readStatus();

    expect(status).toMatchObject({
      subscriptionStatus: "past_due",
      cancelAtPeriodEnd: true,
    });
    expect(status.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({
        id: plan.subscriptionId,
        quantity: 3,
        cancelAtPeriodEnd: false,
      }),
    ]);
  });

  it("billing-concurrency-checkout-020 ends Plan and concurrency state when the shared subscription is deleted", async () => {
    const plan = await seedPlanWorkspace({
      tier: "team",
      periodEnd: new Date("2099-05-20T00:00:00.000Z"),
    });
    await attachSharedConcurrency({ plan, slots: 3 });

    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: plan.customerId,
      metadata: { orgId: plan.orgId },
    });
    await deliverStripeEvent({
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: plan.subscriptionId,
          customer: plan.customerId,
          status: "canceled",
          metadata: {},
          items: {
            data: [
              planItem(TEAM_PRICE, plan.periodStart, plan.periodEnd),
              concurrencyItem(3, plan.periodStart, plan.periodEnd),
            ],
          },
        },
      },
    });

    const status = await readStatus();

    expect(status).toMatchObject({
      tier: "limited-free-1",
      hasSubscription: false,
      concurrencySubscriptions: [],
    });
  });

  it("billing-concurrency-checkout-044 does not mark shared concurrency as restorable when the Plan cancels", async () => {
    const plan = await seedPlanWorkspace({ tier: "team" });
    await attachSharedConcurrency({ plan, slots: 2 });

    const cancelingSubscription = {
      id: plan.subscriptionId,
      customer: plan.customerId,
      status: "active",
      cancel_at_period_end: true,
      cancel_at: plan.periodEnd,
      schedule: null,
      trial_end: null,
      metadata: {},
      items: {
        data: [
          planItem(TEAM_PRICE, plan.periodStart, plan.periodEnd),
          concurrencyItem(2, plan.periodStart, plan.periodEnd),
        ],
      },
    };
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: plan.customerId,
      metadata: { orgId: plan.orgId },
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      cancelingSubscription,
    );
    await deliverStripeEvent({
      type: "customer.subscription.updated",
      data: {
        object: cancelingSubscription,
      },
    });

    const status = await readStatus();

    expect(status.cancelAtPeriodEnd).toBeTruthy();
    expect(status.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({
        id: plan.subscriptionId,
        cancelAtPeriodEnd: false,
        canReduce: true,
      }),
    ]);
  });

  it("billing-concurrency-checkout-031 requires restoring a canceling concurrency subscription before adding slots", async () => {
    const fixture = await seedStandaloneConcurrencyWorkspace({ slots: 2 });
    const standaloneSub = {
      id: fixture.concurrencySubscriptionId,
      customer: fixture.customerId,
      status: "active",
      cancel_at_period_end: false,
      cancel_at: null,
      schedule: null,
      metadata: { purpose: "concurrency_subscription" },
      items: {
        data: [
          concurrencyItem(2, fixture.concurrencyStart, fixture.concurrencyEnd),
        ],
      },
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      standaloneSub,
    );
    context.mocks.stripe.subscriptions.update.mockResolvedValue({
      ...standaloneSub,
      cancel_at_period_end: true,
    });
    await accept(
      concurrencySub.cancel({
        headers,
        params: { subscriptionId: fixture.concurrencySubscriptionId },
        body: {},
      }),
      [200],
    );
    clearStripeMocks();

    const response = await accept(
      concurrencyCheckout.create({
        headers,
        body: { quantity: 1, ...REDIRECTS },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message:
          "Restore the existing concurrency subscription before buying more slots",
        code: "BAD_REQUEST",
      },
    });
    expect(context.mocks.stripe.subscriptions.retrieve).not.toHaveBeenCalled();
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it("billing-concurrency-checkout-040 restores an active concurrency subscription renewal", async () => {
    const fixture = await seedStandaloneConcurrencyWorkspace({
      slots: 2,
      periodEnd: new Date("2099-05-20T00:00:00.000Z"),
    });
    const standaloneSub = {
      id: fixture.concurrencySubscriptionId,
      customer: fixture.customerId,
      status: "active",
      cancel_at_period_end: false,
      cancel_at: null,
      schedule: null,
      metadata: { purpose: "concurrency_subscription" },
      items: {
        data: [
          concurrencyItem(2, fixture.concurrencyStart, fixture.concurrencyEnd),
        ],
      },
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      standaloneSub,
    );
    context.mocks.stripe.subscriptions.update.mockResolvedValue({
      ...standaloneSub,
      cancel_at_period_end: true,
    });
    await accept(
      concurrencySub.cancel({
        headers,
        params: { subscriptionId: fixture.concurrencySubscriptionId },
        body: {},
      }),
      [200],
    );
    clearStripeMocks();
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      ...standaloneSub,
      cancel_at_period_end: true,
    });
    context.mocks.stripe.subscriptions.update.mockResolvedValue(standaloneSub);

    const restored = await accept(
      concurrencySub.restore({
        headers,
        params: { subscriptionId: fixture.concurrencySubscriptionId },
        body: {},
      }),
      [200],
    );

    expect(restored.body).toStrictEqual({ success: true });
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      fixture.concurrencySubscriptionId,
      { cancel_at_period_end: false },
    );
    const status = await readStatus();
    expect(status.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({
        id: fixture.concurrencySubscriptionId,
        cancelAtPeriodEnd: false,
      }),
    ]);
  });

  it("billing-concurrency-checkout-021 previews and confirms a concurrency change without Portal", async () => {
    const fixedNow = Date.parse("2026-06-01T00:00:00.000Z");
    mockNow(fixedNow);
    const prorationTimestamp = Math.floor(fixedNow / 1000);
    const fixture = await seedStandaloneConcurrencyWorkspace({ slots: 2 });
    const hostedInvoiceUrl = `https://invoice.stripe.test/i/${randomUUID()}`;
    const standaloneSub = {
      id: fixture.concurrencySubscriptionId,
      customer: fixture.customerId,
      status: "active",
      cancel_at_period_end: false,
      cancel_at: null,
      schedule: null,
      default_payment_method: null,
      default_source: null,
      metadata: { purpose: "concurrency_subscription" },
      items: {
        data: [
          concurrencyItem(
            2,
            fixture.concurrencyStart,
            fixture.concurrencyEnd,
            "si_conc_standalone",
          ),
        ],
      },
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      standaloneSub,
    );
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: fixture.customerId,
      invoice_settings: { default_payment_method: "pm_saved_card" },
      default_source: null,
    });
    context.mocks.stripe.invoices.createPreview.mockImplementation(
      (params: unknown) => {
        const mode =
          typeof params === "object" &&
          params !== null &&
          "preview_mode" in params
            ? params.preview_mode
            : undefined;
        if (mode === "next") {
          return Promise.resolve(
            previewInvoice({
              lines: [
                prorationLine({
                  amount: 15_000,
                  prorationTimestamp,
                  periodEnd: fixture.concurrencyEnd,
                }),
                prorationLine({
                  amount: 2000,
                  prorationTimestamp,
                  periodEnd: fixture.concurrencyEnd,
                  priceId: TEAM_PRICE,
                  proration: false,
                }),
              ],
            }),
          );
        }
        return Promise.resolve(
          previewInvoice({
            lines: [
              recurringLine({
                amount: 40_000,
                periodStart: fixture.concurrencyEnd,
                periodEnd: fixture.concurrencyEnd + 30 * DAY_SECONDS,
              }),
            ],
          }),
        );
      },
    );
    clearStripeMocks();

    const preview = await accept(
      concurrencySub.previewChange({
        headers,
        params: { subscriptionId: fixture.concurrencySubscriptionId },
        body: {
          quantity: 4,
          supportsInAppPreview: true,
          returnUrl: RETURN_URL,
        },
      }),
      [200],
    );

    expect(preview.body).toStrictEqual({
      currentQuantity: 2,
      targetQuantity: 4,
      immediateAmountCents: 15_000,
      nextRecurringAmountCents: 40_000,
      currency: "usd",
      paymentMethodPreviewToken: expect.any(String),
    });
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        subscription: fixture.concurrencySubscriptionId,
        preview_mode: "next",
        subscription_details: expect.objectContaining({
          items: [{ id: "si_conc_standalone", quantity: 4 }],
          proration_behavior: "always_invoice",
        }),
      }),
    );
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        subscription: fixture.concurrencySubscriptionId,
        preview_mode: "recurring",
        subscription_details: expect.objectContaining({
          items: [{ id: "si_conc_standalone", quantity: 4 }],
          proration_behavior: "none",
        }),
      }),
    );

    const token = preview.body.paymentMethodPreviewToken;
    if (!token) {
      throw new Error("Expected paymentMethodPreviewToken in preview");
    }
    context.mocks.stripe.subscriptions.update.mockResolvedValue({
      ...standaloneSub,
      default_payment_method: "pm_saved_card",
      pending_update: {
        subscription_items: [
          concurrencyItem(
            4,
            fixture.concurrencyStart,
            fixture.concurrencyEnd,
            "si_conc_standalone",
          ),
        ],
      },
      latest_invoice: {
        id: `in_open_${randomUUID().slice(0, 8)}`,
        status: "open",
        hosted_invoice_url: hostedInvoiceUrl,
      },
    });

    const confirmed = await accept(
      concurrencySub.confirmChange({
        headers,
        params: { subscriptionId: fixture.concurrencySubscriptionId },
        body: { quantity: 4, paymentMethodPreviewToken: token },
      }),
      [200],
    );

    expect(confirmed.body).toStrictEqual({
      status: "pending_payment",
      hostedInvoiceUrl,
    });
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenNthCalledWith(
      1,
      fixture.concurrencySubscriptionId,
      { default_payment_method: "pm_saved_card" },
    );
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenNthCalledWith(
      2,
      fixture.concurrencySubscriptionId,
      expect.objectContaining({
        items: [{ id: "si_conc_standalone", quantity: 4 }],
        payment_behavior: "pending_if_incomplete",
        proration_behavior: "always_invoice",
      }),
    );
    expect(
      context.mocks.stripe.billingPortal.sessions.create,
    ).not.toHaveBeenCalled();
    const status = await readStatus();
    expect(status.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({
        id: fixture.concurrencySubscriptionId,
        quantity: 2,
      }),
    ]);
  });

  it("billing-concurrency-checkout-022 returns the pending invoice when confirming a matching pending update", async () => {
    const fixture = await seedStandaloneConcurrencyWorkspace({ slots: 2 });
    const hostedInvoiceUrl = `https://invoice.stripe.test/i/${randomUUID()}`;
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: fixture.concurrencySubscriptionId,
      customer: fixture.customerId,
      status: "active",
      cancel_at_period_end: false,
      cancel_at: null,
      schedule: null,
      metadata: { purpose: "concurrency_subscription" },
      items: {
        data: [
          concurrencyItem(2, fixture.concurrencyStart, fixture.concurrencyEnd),
        ],
      },
      pending_update: {
        subscription_items: [
          concurrencyItem(4, fixture.concurrencyStart, fixture.concurrencyEnd),
        ],
      },
      latest_invoice: {
        id: `in_pending_${randomUUID().slice(0, 8)}`,
        status: "open",
        hosted_invoice_url: hostedInvoiceUrl,
      },
    });
    clearStripeMocks();

    const confirmed = await accept(
      concurrencySub.confirmChange({
        headers,
        params: { subscriptionId: fixture.concurrencySubscriptionId },
        body: { quantity: 4 },
      }),
      [200],
    );

    expect(confirmed.body).toStrictEqual({
      status: "pending_payment",
      hostedInvoiceUrl,
    });
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).not.toHaveBeenCalled();
    const status = await readStatus();
    expect(status.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({
        id: fixture.concurrencySubscriptionId,
        quantity: 2,
      }),
    ]);
  });

  it("billing-concurrency-checkout-023 previews and schedules a concurrency reduction at the next billing date", async () => {
    const fixture = await seedStandaloneConcurrencyWorkspace({ slots: 5 });
    const effectiveAt = new Date(fixture.concurrencyEnd * 1000).toISOString();
    const scheduleId = `sub_sched_${randomUUID().slice(0, 8)}`;
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: fixture.concurrencySubscriptionId,
      customer: fixture.customerId,
      status: "active",
      cancel_at_period_end: false,
      cancel_at: null,
      schedule: null,
      discounts: [],
      metadata: { purpose: "concurrency_subscription" },
      items: {
        data: [
          concurrencyItem(
            5,
            fixture.concurrencyStart,
            fixture.concurrencyEnd,
            "si_conc_5",
          ),
        ],
      },
    });
    context.mocks.stripe.invoices.createPreview.mockResolvedValue(
      previewInvoice({
        lines: [
          recurringLine({
            amount: 30_000,
            periodStart: fixture.concurrencyEnd,
            periodEnd: fixture.concurrencyEnd + 30 * DAY_SECONDS,
          }),
        ],
      }),
    );
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValue({
      id: scheduleId,
      subscription: fixture.concurrencySubscriptionId,
      end_behavior: "release",
      current_phase: {
        start_date: fixture.concurrencyStart,
        end_date: fixture.concurrencyEnd,
      },
      phases: [
        {
          start_date: fixture.concurrencyStart,
          end_date: fixture.concurrencyEnd,
          items: [{ price: CONCURRENCY_PRICE, quantity: 5 }],
        },
      ],
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: scheduleId,
    });
    clearStripeMocks();

    const preview = await accept(
      concurrencySub.previewChange({
        headers,
        params: { subscriptionId: fixture.concurrencySubscriptionId },
        body: { quantity: 3 },
      }),
      [200],
    );

    expect(preview.body).toStrictEqual({
      currentQuantity: 5,
      targetQuantity: 3,
      immediateAmountCents: 0,
      nextRecurringAmountCents: 30_000,
      currency: "usd",
      effectiveAt,
    });
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
      subscription: fixture.concurrencySubscriptionId,
      preview_mode: "recurring",
      subscription_details: {
        items: [{ id: "si_conc_5", quantity: 3 }],
        proration_behavior: "none",
      },
    });
    expect(
      context.mocks.stripe.invoices.createPreview,
    ).not.toHaveBeenCalledWith(
      expect.objectContaining({ preview_mode: "next" }),
    );

    const confirmed = await accept(
      concurrencySub.confirmChange({
        headers,
        params: { subscriptionId: fixture.concurrencySubscriptionId },
        body: { quantity: 3 },
      }),
      [200],
    );

    expect(confirmed.body).toStrictEqual({
      status: "completed",
      hostedInvoiceUrl: null,
      effectiveAt,
    });
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(
      scheduleId,
      {
        end_behavior: "release",
        proration_behavior: "none",
        phases: [
          {
            start_date: fixture.concurrencyStart,
            end_date: fixture.concurrencyEnd,
            items: [{ price: CONCURRENCY_PRICE, quantity: 5 }],
            proration_behavior: "none",
          },
          {
            start_date: fixture.concurrencyEnd,
            duration: MONTHLY_RECURRING,
            items: [{ price: CONCURRENCY_PRICE, quantity: 3 }],
            proration_behavior: "none",
          },
        ],
      },
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(
          /^concurrency-change:.*:schedule-update$/,
        ),
      }),
    );
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it("billing-concurrency-checkout-028 replaces an existing scheduled concurrency reduction", async () => {
    const fixture = await seedStandaloneConcurrencyWorkspace({ slots: 5 });
    const effectiveAt = new Date(fixture.concurrencyEnd * 1000).toISOString();
    const scheduleId = `sub_sched_${randomUUID().slice(0, 8)}`;
    let attachedScheduleId: string | null = null;
    let scheduledNextQuantity = 5;

    const currentSubscription = () => {
      return {
        id: fixture.concurrencySubscriptionId,
        customer: fixture.customerId,
        status: "active",
        cancel_at_period_end: false,
        cancel_at: null,
        schedule: attachedScheduleId,
        discounts: [],
        metadata: { purpose: "concurrency_subscription" },
        items: {
          data: [
            concurrencyItem(
              5,
              fixture.concurrencyStart,
              fixture.concurrencyEnd,
              "si_conc_5",
            ),
          ],
        },
      };
    };
    const currentSchedule = () => {
      return {
        id: scheduleId,
        subscription: fixture.concurrencySubscriptionId,
        end_behavior: "release",
        current_phase: {
          start_date: fixture.concurrencyStart,
          end_date: fixture.concurrencyEnd,
        },
        phases: [
          {
            start_date: fixture.concurrencyStart,
            end_date: fixture.concurrencyEnd,
            items: [{ price: CONCURRENCY_PRICE, quantity: 5 }],
          },
          {
            start_date: fixture.concurrencyEnd,
            end_date: fixture.concurrencyEnd + 30 * DAY_SECONDS,
            items: [
              { price: CONCURRENCY_PRICE, quantity: scheduledNextQuantity },
            ],
          },
        ],
      };
    };

    context.mocks.stripe.subscriptions.retrieve.mockImplementation(
      respondDynamically(currentSubscription),
    );
    context.mocks.stripe.subscriptionSchedules.create.mockImplementation(() => {
      attachedScheduleId = scheduleId;
      return Promise.resolve(currentSchedule());
    });
    context.mocks.stripe.subscriptionSchedules.retrieve.mockImplementation(
      respondDynamically(currentSchedule),
    );
    context.mocks.stripe.subscriptionSchedules.update.mockImplementation(
      (_id: unknown, params: unknown) => {
        if (
          typeof params === "object" &&
          params !== null &&
          "phases" in params &&
          Array.isArray(params.phases)
        ) {
          const secondPhase: unknown = params.phases[1];
          if (
            typeof secondPhase === "object" &&
            secondPhase !== null &&
            "items" in secondPhase &&
            Array.isArray(secondPhase.items)
          ) {
            const firstItem: unknown = secondPhase.items[0];
            if (
              typeof firstItem === "object" &&
              firstItem !== null &&
              "quantity" in firstItem &&
              typeof firstItem.quantity === "number"
            ) {
              scheduledNextQuantity = firstItem.quantity;
            }
          }
        }
        return Promise.resolve(currentSchedule());
      },
    );
    context.mocks.stripe.invoices.createPreview.mockResolvedValueOnce(
      previewInvoice({
        lines: [
          recurringLine({
            amount: 30_000,
            periodStart: fixture.concurrencyEnd,
            periodEnd: fixture.concurrencyEnd + 30 * DAY_SECONDS,
          }),
        ],
      }),
    );

    await accept(
      concurrencySub.previewChange({
        headers,
        params: { subscriptionId: fixture.concurrencySubscriptionId },
        body: { quantity: 3 },
      }),
      [200],
    );
    await accept(
      concurrencySub.confirmChange({
        headers,
        params: { subscriptionId: fixture.concurrencySubscriptionId },
        body: { quantity: 3 },
      }),
      [200],
    );

    const statusAfterFirst = await readStatus();
    expect(statusAfterFirst.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({
        id: fixture.concurrencySubscriptionId,
        quantity: 5,
        scheduledQuantity: 3,
        scheduledChangeAt: effectiveAt,
      }),
    ]);

    clearStripeMocks();
    context.mocks.stripe.invoices.createPreview.mockResolvedValueOnce(
      previewInvoice({
        lines: [
          recurringLine({
            amount: 20_000,
            periodStart: fixture.concurrencyEnd,
            periodEnd: fixture.concurrencyEnd + 30 * DAY_SECONDS,
          }),
        ],
      }),
    );

    const replacementPreview = await accept(
      concurrencySub.previewChange({
        headers,
        params: { subscriptionId: fixture.concurrencySubscriptionId },
        body: { quantity: 2 },
      }),
      [200],
    );
    const firstReplace = await accept(
      concurrencySub.confirmChange({
        headers,
        params: { subscriptionId: fixture.concurrencySubscriptionId },
        body: { quantity: 2 },
      }),
      [200],
    );
    const retryReplace = await accept(
      concurrencySub.confirmChange({
        headers,
        params: { subscriptionId: fixture.concurrencySubscriptionId },
        body: { quantity: 2 },
      }),
      [200],
    );

    expect(replacementPreview.body).toStrictEqual({
      currentQuantity: 5,
      targetQuantity: 2,
      immediateAmountCents: 0,
      nextRecurringAmountCents: 20_000,
      currency: "usd",
      effectiveAt,
    });
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
      schedule: scheduleId,
      preview_mode: "next",
      schedule_details: {
        end_behavior: "release",
        proration_behavior: "none",
        phases: [
          {
            start_date: fixture.concurrencyStart,
            end_date: fixture.concurrencyEnd,
            items: [{ price: CONCURRENCY_PRICE, quantity: 5 }],
            proration_behavior: "none",
          },
          {
            start_date: fixture.concurrencyEnd,
            duration: MONTHLY_RECURRING,
            items: [{ price: CONCURRENCY_PRICE, quantity: 2 }],
            proration_behavior: "none",
          },
        ],
      },
    });
    expect(firstReplace.body).toStrictEqual({
      status: "completed",
      hostedInvoiceUrl: null,
      effectiveAt,
    });
    expect(retryReplace.body).toStrictEqual({
      status: "completed",
      hostedInvoiceUrl: null,
      effectiveAt,
    });
    expect(
      context.mocks.stripe.subscriptionSchedules.create,
    ).not.toHaveBeenCalled();
    const updateCalls =
      context.mocks.stripe.subscriptionSchedules.update.mock.calls;
    const firstKey = extractIdempotencyKey(updateCalls.at(-2)?.[2]);
    const retryKey = extractIdempotencyKey(updateCalls.at(-1)?.[2]);
    expect(firstKey).toMatch(/^concurrency-change:.*:schedule-update$/);
    expect(retryKey).toMatch(/^concurrency-change:.*:schedule-update$/);
    expect(retryKey).not.toBe(firstKey);

    const statusAfterReplace = await readStatus();
    expect(statusAfterReplace.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({
        id: fixture.concurrencySubscriptionId,
        quantity: 5,
        scheduledQuantity: 2,
        scheduledChangeAt: effectiveAt,
      }),
    ]);
  });

  it("billing-concurrency-checkout-029 releases a scheduled reduction before applying an increase", async () => {
    const fixedNow = Date.parse("2026-06-01T00:00:00.000Z");
    mockNow(fixedNow);
    const prorationTimestamp = Math.floor(fixedNow / 1000);
    const fixture = await seedStandaloneConcurrencyWorkspace({ slots: 10 });
    const scheduleId = `sub_sched_${randomUUID().slice(0, 8)}`;
    let attachedScheduleId: string | null = null;

    const currentSubscription = () => {
      return {
        id: fixture.concurrencySubscriptionId,
        customer: fixture.customerId,
        status: "active",
        cancel_at_period_end: false,
        cancel_at: null,
        schedule: attachedScheduleId,
        discounts: [],
        metadata: { purpose: "concurrency_subscription" },
        items: {
          data: [
            concurrencyItem(
              10,
              fixture.concurrencyStart,
              fixture.concurrencyEnd,
              "si_conc_10",
            ),
          ],
        },
      };
    };
    const currentSchedule = {
      id: scheduleId,
      subscription: fixture.concurrencySubscriptionId,
      end_behavior: "release",
      current_phase: {
        start_date: fixture.concurrencyStart,
        end_date: fixture.concurrencyEnd,
      },
      phases: [
        {
          start_date: fixture.concurrencyStart,
          end_date: fixture.concurrencyEnd,
          items: [{ price: CONCURRENCY_PRICE, quantity: 10 }],
        },
        {
          start_date: fixture.concurrencyEnd,
          end_date: fixture.concurrencyEnd + 30 * DAY_SECONDS,
          items: [{ price: CONCURRENCY_PRICE, quantity: 2 }],
        },
      ],
    };

    context.mocks.stripe.subscriptions.retrieve.mockImplementation(
      respondDynamically(currentSubscription),
    );
    context.mocks.stripe.subscriptionSchedules.create.mockImplementation(() => {
      attachedScheduleId = scheduleId;
      return Promise.resolve(currentSchedule);
    });
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue(
      currentSchedule,
    );
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue(
      currentSchedule,
    );
    context.mocks.stripe.subscriptionSchedules.release.mockImplementation(
      () => {
        attachedScheduleId = null;
        return Promise.resolve({ id: scheduleId });
      },
    );
    context.mocks.stripe.invoices.createPreview.mockResolvedValueOnce(
      previewInvoice({
        lines: [
          recurringLine({
            amount: 20_000,
            periodStart: fixture.concurrencyEnd,
            periodEnd: fixture.concurrencyEnd + 30 * DAY_SECONDS,
          }),
        ],
      }),
    );

    await accept(
      concurrencySub.previewChange({
        headers,
        params: { subscriptionId: fixture.concurrencySubscriptionId },
        body: { quantity: 2 },
      }),
      [200],
    );
    await accept(
      concurrencySub.confirmChange({
        headers,
        params: { subscriptionId: fixture.concurrencySubscriptionId },
        body: { quantity: 2 },
      }),
      [200],
    );

    const statusAfterReduction = await readStatus();
    expect(statusAfterReduction.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({
        id: fixture.concurrencySubscriptionId,
        quantity: 10,
        scheduledQuantity: 2,
      }),
    ]);

    clearStripeMocks();
    context.mocks.stripe.invoices.createPreview.mockImplementation(
      (params: unknown) => {
        const isSchedulePreview =
          typeof params === "object" && params !== null && "schedule" in params;
        if (!isSchedulePreview) {
          return Promise.resolve(
            previewInvoice({
              lines: [
                prorationLine({
                  amount: 100_000,
                  prorationTimestamp,
                  periodEnd: fixture.concurrencyEnd,
                }),
              ],
            }),
          );
        }
        const scheduleDetails =
          "schedule_details" in params ? params.schedule_details : undefined;
        let secondQuantity = 10;
        if (
          typeof scheduleDetails === "object" &&
          scheduleDetails !== null &&
          "phases" in scheduleDetails &&
          Array.isArray(scheduleDetails.phases)
        ) {
          const secondPhase: unknown = scheduleDetails.phases[1];
          if (
            typeof secondPhase === "object" &&
            secondPhase !== null &&
            "items" in secondPhase &&
            Array.isArray(secondPhase.items)
          ) {
            const firstItem: unknown = secondPhase.items[0];
            if (
              typeof firstItem === "object" &&
              firstItem !== null &&
              "quantity" in firstItem &&
              typeof firstItem.quantity === "number"
            ) {
              secondQuantity = firstItem.quantity;
            }
          }
        }
        return Promise.resolve(
          previewInvoice({
            lines: [
              recurringLine({
                amount: secondQuantity * 10_000,
                periodStart: fixture.concurrencyEnd,
                periodEnd: fixture.concurrencyEnd + 30 * DAY_SECONDS,
              }),
            ],
          }),
        );
      },
    );
    context.mocks.stripe.subscriptions.update.mockResolvedValue({
      ...currentSubscription(),
      schedule: null,
      latest_invoice: {
        id: `in_paid_${randomUUID().slice(0, 8)}`,
        status: "paid",
        hosted_invoice_url: null,
      },
    });

    const preview10 = await accept(
      concurrencySub.previewChange({
        headers,
        params: { subscriptionId: fixture.concurrencySubscriptionId },
        body: { quantity: 10 },
      }),
      [200],
    );
    const preview20 = await accept(
      concurrencySub.previewChange({
        headers,
        params: { subscriptionId: fixture.concurrencySubscriptionId },
        body: { quantity: 20 },
      }),
      [200],
    );
    const confirmed20 = await accept(
      concurrencySub.confirmChange({
        headers,
        params: { subscriptionId: fixture.concurrencySubscriptionId },
        body: { quantity: 20 },
      }),
      [200],
    );

    expect(preview10.body).toStrictEqual({
      currentQuantity: 10,
      targetQuantity: 10,
      immediateAmountCents: 0,
      nextRecurringAmountCents: 100_000,
      currency: "usd",
    });
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
      schedule: scheduleId,
      preview_mode: "next",
      schedule_details: {
        end_behavior: "release",
        proration_behavior: "none",
        phases: [
          {
            start_date: fixture.concurrencyStart,
            end_date: fixture.concurrencyEnd,
            items: [{ price: CONCURRENCY_PRICE, quantity: 10 }],
            proration_behavior: "none",
          },
          {
            start_date: fixture.concurrencyEnd,
            duration: MONTHLY_RECURRING,
            items: [{ price: CONCURRENCY_PRICE, quantity: 10 }],
            proration_behavior: "none",
          },
        ],
      },
    });
    expect(preview20.body).toStrictEqual({
      currentQuantity: 10,
      targetQuantity: 20,
      immediateAmountCents: 100_000,
      nextRecurringAmountCents: 200_000,
      currency: "usd",
    });
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
      schedule: scheduleId,
      preview_mode: "next",
      schedule_details: {
        end_behavior: "release",
        proration_behavior: "none",
        phases: [
          {
            start_date: fixture.concurrencyStart,
            end_date: fixture.concurrencyEnd,
            items: [{ price: CONCURRENCY_PRICE, quantity: 10 }],
            proration_behavior: "none",
          },
          {
            start_date: fixture.concurrencyEnd,
            duration: MONTHLY_RECURRING,
            items: [{ price: CONCURRENCY_PRICE, quantity: 20 }],
            proration_behavior: "none",
          },
        ],
      },
    });
    expect(confirmed20.body).toStrictEqual({
      status: "processing",
      hostedInvoiceUrl: null,
    });
    expect(
      context.mocks.stripe.subscriptionSchedules.release,
    ).toHaveBeenCalledWith(scheduleId, { preserve_cancel_date: true });
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      fixture.concurrencySubscriptionId,
      expect.objectContaining({
        items: [{ id: "si_conc_10", quantity: 20 }],
        payment_behavior: "pending_if_incomplete",
        proration_behavior: "always_invoice",
      }),
    );
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).not.toHaveBeenCalled();

    const statusAfterIncrease = await readStatus();
    expect(statusAfterIncrease.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({
        id: fixture.concurrencySubscriptionId,
        quantity: 10,
      }),
    ]);
    expect(
      "scheduledQuantity" in
        (statusAfterIncrease.concurrencySubscriptions[0] ?? {}),
    ).toBeFalsy();
  });

  it("billing-concurrency-checkout-003 previews a first concurrency purchase on the Plan subscription", async () => {
    const fixedNow = Date.parse("2026-06-01T00:00:00.000Z");
    mockNow(fixedNow);
    const prorationTimestamp = Math.floor(fixedNow / 1000);
    const plan = await seedPlanWorkspace({ tier: "team" });
    const recurringInvoiceId = `in_rec_${randomUUID().slice(0, 8)}`;

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: plan.subscriptionId,
      customer: plan.customerId,
      status: "active",
      cancel_at_period_end: false,
      cancel_at: null,
      schedule: null,
      metadata: {},
      items: {
        data: [planItem(TEAM_PRICE, plan.periodStart, plan.periodEnd)],
      },
    });
    context.mocks.stripe.invoices.createPreview.mockImplementation(
      (params: unknown) => {
        const mode =
          typeof params === "object" &&
          params !== null &&
          "preview_mode" in params
            ? params.preview_mode
            : undefined;
        if (mode === "next") {
          return Promise.resolve(
            previewInvoice({
              lines: [
                prorationLine({
                  amount: 5500,
                  prorationTimestamp,
                  periodEnd: plan.periodEnd,
                }),
              ],
            }),
          );
        }
        return Promise.resolve(
          previewInvoice({
            id: recurringInvoiceId,
            hasMore: true,
            lines: [
              recurringLine({
                amount: 10_000,
                periodStart: plan.periodEnd,
                periodEnd: plan.periodEnd + 30 * DAY_SECONDS,
                priceId: TEAM_PRICE,
              }),
            ],
          }),
        );
      },
    );
    context.mocks.stripe.invoices.listLineItems.mockResolvedValue({
      has_more: false,
      data: [
        recurringLine({
          amount: 10_000,
          periodStart: plan.periodEnd,
          periodEnd: plan.periodEnd + 30 * DAY_SECONDS,
          priceId: TEAM_PRICE,
        }),
        recurringLine({
          amount: 30_000,
          periodStart: plan.periodEnd,
          periodEnd: plan.periodEnd + 30 * DAY_SECONDS,
        }),
      ],
    });
    clearStripeMocks();

    const preview = await accept(
      concurrencyCheckout.preview({ headers, body: { quantity: 3 } }),
      [200],
    );

    expect(preview.body).toStrictEqual({
      currentQuantity: 0,
      targetQuantity: 3,
      immediateAmountCents: 5500,
      nextRecurringAmountCents: 30_000,
      currency: "usd",
    });
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
      subscription: plan.subscriptionId,
      preview_mode: "next",
      subscription_details: {
        items: [{ price: CONCURRENCY_PRICE, quantity: 3 }],
        proration_behavior: "always_invoice",
        proration_date: prorationTimestamp,
      },
    });
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
      subscription: plan.subscriptionId,
      preview_mode: "recurring",
      subscription_details: {
        items: [{ price: CONCURRENCY_PRICE, quantity: 3 }],
        proration_behavior: "none",
      },
    });
    expect(context.mocks.stripe.invoices.listLineItems).toHaveBeenCalledWith(
      recurringInvoiceId,
      { limit: 100 },
    );
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.subscriptionSchedules.release,
    ).not.toHaveBeenCalled();
  });

  it("billing-concurrency-checkout-005 allows concurrency to expire with a Team subscription canceling at period end", async () => {
    const fixedNow = Date.parse("2026-06-01T00:00:00.000Z");
    mockNow(fixedNow);
    const prorationTimestamp = Math.floor(fixedNow / 1000);
    const plan = await seedPlanWorkspace({
      tier: "team",
      cancelAtPeriodEnd: true,
    });
    const cancelingSub = {
      id: plan.subscriptionId,
      customer: plan.customerId,
      status: "active",
      cancel_at_period_end: true,
      cancel_at: null,
      schedule: null,
      metadata: {},
      items: {
        data: [planItem(TEAM_PRICE, plan.periodStart, plan.periodEnd)],
      },
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(cancelingSub);
    context.mocks.stripe.invoices.createPreview.mockImplementation(
      (params: unknown) => {
        const mode =
          typeof params === "object" &&
          params !== null &&
          "preview_mode" in params
            ? params.preview_mode
            : undefined;
        if (mode === "recurring") {
          return Promise.reject(
            new Stripe.errors.StripeInvalidRequestError({
              type: "invalid_request_error",
              message: "Cannot preview recurring invoice for canceling sub",
            }),
          );
        }
        return Promise.resolve(
          previewInvoice({
            lines: [
              prorationLine({
                amount: 15_000,
                prorationTimestamp,
                periodEnd: plan.periodEnd,
              }),
            ],
          }),
        );
      },
    );
    context.mocks.stripe.subscriptions.update.mockResolvedValue({
      ...cancelingSub,
      latest_invoice: {
        id: `in_paid_${randomUUID().slice(0, 8)}`,
        status: "paid",
        hosted_invoice_url: null,
      },
    });
    clearStripeMocks();

    const preview = await accept(
      concurrencyCheckout.preview({ headers, body: { quantity: 3 } }),
      [200],
    );
    const purchase = await accept(
      concurrencyCheckout.create({
        headers,
        body: { quantity: 3, ...REDIRECTS },
      }),
      [200],
    );

    expect(preview.body).toStrictEqual({
      currentQuantity: 0,
      targetQuantity: 3,
      immediateAmountCents: 15_000,
      nextRecurringAmountCents: 0,
      currency: "usd",
    });
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
      subscription: plan.subscriptionId,
      preview_mode: "next",
      subscription_details: {
        cancel_at_period_end: false,
        items: [{ price: CONCURRENCY_PRICE, quantity: 3 }],
        proration_behavior: "always_invoice",
        proration_date: prorationTimestamp,
      },
    });
    expect(
      context.mocks.stripe.invoices.createPreview,
    ).not.toHaveBeenCalledWith(
      expect.objectContaining({ preview_mode: "recurring" }),
    );
    expect(purchase.body).toStrictEqual({ url: REDIRECTS.successUrl });
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      plan.subscriptionId,
      expect.objectContaining({
        items: [{ price: CONCURRENCY_PRICE, quantity: 3 }],
        payment_behavior: "pending_if_incomplete",
        proration_behavior: "always_invoice",
      }),
    );
    expect(
      context.mocks.stripe.subscriptionSchedules.create,
    ).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).not.toHaveBeenCalled();
  });

  it("billing-concurrency-checkout-006 previews and applies a concurrency increase without restoring the ending Plan", async () => {
    const fixedNow = Date.parse("2026-06-01T00:00:00.000Z");
    mockNow(fixedNow);
    const prorationTimestamp = Math.floor(fixedNow / 1000);
    const plan = await seedPlanWorkspace({ tier: "team" });
    await attachSharedConcurrency({
      plan,
      slots: 5,
      cancelAt: plan.periodEnd,
    });
    const endingSub = {
      id: plan.subscriptionId,
      customer: plan.customerId,
      status: "active",
      cancel_at_period_end: false,
      cancel_at: plan.periodEnd,
      schedule: null,
      metadata: {},
      items: {
        data: [
          planItem(TEAM_PRICE, plan.periodStart, plan.periodEnd),
          concurrencyItem(5, plan.periodStart, plan.periodEnd, "si_conc_5"),
        ],
      },
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(endingSub);
    context.mocks.stripe.invoices.createPreview.mockImplementation(
      (params: unknown) => {
        if (
          typeof params !== "object" ||
          params === null ||
          !("preview_mode" in params) ||
          params.preview_mode !== "next"
        ) {
          return Promise.reject(
            new Stripe.errors.StripeInvalidRequestError({
              type: "invalid_request_error",
              message: "Cannot preview recurring invoice for ending sub",
            }),
          );
        }
        const details =
          "subscription_details" in params
            ? params.subscription_details
            : undefined;
        const clearedCancelAt =
          typeof details === "object" &&
          details !== null &&
          "cancel_at" in details &&
          details.cancel_at === "";
        if (!clearedCancelAt) {
          return Promise.reject(
            new Stripe.errors.StripeInvalidRequestError({
              type: "invalid_request_error",
              message: "Subscription cancel_at must be cleared to preview",
            }),
          );
        }
        return Promise.resolve(
          previewInvoice({
            lines: [
              prorationLine({
                amount: 12_000,
                prorationTimestamp,
                periodEnd: plan.periodEnd,
              }),
            ],
          }),
        );
      },
    );
    context.mocks.stripe.subscriptions.update.mockResolvedValue({
      ...endingSub,
      latest_invoice: {
        id: `in_paid_${randomUUID().slice(0, 8)}`,
        status: "paid",
        hosted_invoice_url: null,
      },
    });
    clearStripeMocks();

    const preview = await accept(
      concurrencySub.previewChange({
        headers,
        params: { subscriptionId: plan.subscriptionId },
        body: { quantity: 7 },
      }),
      [200],
    );
    const confirmed = await accept(
      concurrencySub.confirmChange({
        headers,
        params: { subscriptionId: plan.subscriptionId },
        body: { quantity: 7 },
      }),
      [200],
    );

    expect(preview.body).toStrictEqual({
      currentQuantity: 5,
      targetQuantity: 7,
      immediateAmountCents: 12_000,
      nextRecurringAmountCents: 0,
      currency: "usd",
    });
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
      subscription: plan.subscriptionId,
      preview_mode: "next",
      subscription_details: {
        cancel_at: "",
        items: [{ id: "si_conc_5", quantity: 7 }],
        proration_behavior: "always_invoice",
        proration_date: prorationTimestamp,
      },
    });
    expect(
      context.mocks.stripe.invoices.createPreview,
    ).not.toHaveBeenCalledWith(
      expect.objectContaining({ preview_mode: "recurring" }),
    );
    expect(confirmed.body).toStrictEqual({
      status: "processing",
      hostedInvoiceUrl: null,
    });
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      plan.subscriptionId,
      expect.objectContaining({
        items: [{ id: "si_conc_5", quantity: 7 }],
        payment_behavior: "pending_if_incomplete",
        proration_behavior: "always_invoice",
      }),
    );
    const updatePayload: unknown =
      context.mocks.stripe.subscriptions.update.mock.calls[0]?.[1];
    expect(updatePayload).not.toHaveProperty("cancel_at");
    expect(updatePayload).not.toHaveProperty("cancel_at_period_end");
    expect(
      context.mocks.stripe.subscriptionSchedules.create,
    ).not.toHaveBeenCalled();
  });

  it("billing-concurrency-checkout-007 rejects deferred concurrency changes that cannot precede the Plan end", async () => {
    const plan = await seedPlanWorkspace({
      tier: "team",
      cancelAtPeriodEnd: true,
    });
    await attachSharedConcurrency({
      plan,
      slots: 5,
      cancelAtPeriodEnd: true,
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: plan.subscriptionId,
      customer: plan.customerId,
      status: "active",
      cancel_at_period_end: true,
      cancel_at: plan.periodEnd,
      schedule: null,
      metadata: {},
      items: {
        data: [
          planItem(TEAM_PRICE, plan.periodStart, plan.periodEnd),
          concurrencyItem(5, plan.periodStart, plan.periodEnd),
        ],
      },
    });
    clearStripeMocks();

    const preview = await accept(
      concurrencySub.previewChange({
        headers,
        params: { subscriptionId: plan.subscriptionId },
        body: { quantity: 3 },
      }),
      [409],
    );
    const confirm = await accept(
      concurrencySub.confirmChange({
        headers,
        params: { subscriptionId: plan.subscriptionId },
        body: { quantity: 3 },
      }),
      [409],
    );
    const cancel = await accept(
      concurrencySub.cancel({
        headers,
        params: { subscriptionId: plan.subscriptionId },
        body: {},
      }),
      [409],
    );

    expect(preview.body).toStrictEqual({
      error: { message: PLAN_ENDING_REDUCE_MESSAGE, code: "CONFLICT" },
    });
    expect(confirm.body).toStrictEqual({
      error: { message: PLAN_ENDING_REDUCE_MESSAGE, code: "CONFLICT" },
    });
    expect(cancel.body).toStrictEqual({
      error: { message: PLAN_ENDING_CANCEL_MESSAGE, code: "CONFLICT" },
    });
    expect(context.mocks.stripe.invoices.createPreview).not.toHaveBeenCalled();
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.subscriptionSchedules.create,
    ).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).not.toHaveBeenCalled();
  });

  it("billing-concurrency-checkout-001 preserves unrelated archived items, discounts and phase metadata when adding concurrency", async () => {
    const fixedNow = Date.parse("2026-06-01T00:00:00.000Z");
    mockNow(fixedNow);
    const prorationTimestamp = Math.floor(fixedNow / 1000);
    const plan = await seedPlanWorkspace({ tier: "team" });
    const scheduleId = `sub_sched_${randomUUID().slice(0, 8)}`;
    const afterAllowanceEnd = plan.periodEnd + 30 * DAY_SECONDS;
    const previousInvoiceId = `in_prev_${randomUUID().slice(0, 8)}`;
    const newInvoiceId = `in_conc_${randomUUID().slice(0, 8)}`;
    const hostedInvoiceUrl = `https://invoice.stripe.test/i/${newInvoiceId}`;
    let scheduleUpdated = false;

    const attachedSchedule = {
      id: scheduleId,
      subscription: plan.subscriptionId,
      end_behavior: "cancel",
      current_phase: {
        start_date: plan.periodStart,
        end_date: plan.periodEnd,
      },
      phases: [
        {
          start_date: plan.periodStart,
          end_date: plan.periodEnd,
          currency: "usd",
          items: [
            { price: TEAM_PRICE, quantity: 1 },
            {
              price: ALLOWANCE_PRICE,
              quantity: 1,
              metadata: { allowanceKind: "archived" },
            },
          ],
          discounts: [{ discount: "di_existing" }, { coupon: "coupon_promo" }],
          metadata: { phaseRole: "allowance" },
          proration_behavior: "none",
        },
        {
          start_date: plan.periodEnd,
          end_date: afterAllowanceEnd,
          currency: "usd",
          items: [{ price: TEAM_PRICE, quantity: 1 }],
          proration_behavior: "none",
        },
      ],
    };

    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: plan.customerId,
      invoice_settings: { default_payment_method: null },
      default_source: null,
    });
    context.mocks.stripe.paymentMethods.list.mockResolvedValue({ data: [] });
    context.mocks.stripe.subscriptions.retrieve.mockImplementation(
      respondDynamically(() => {
        return {
          id: plan.subscriptionId,
          customer: plan.customerId,
          status: "active",
          cancel_at_period_end: false,
          cancel_at: null,
          schedule: scheduleId,
          default_payment_method: null,
          default_source: null,
          metadata: {},
          latest_invoice: scheduleUpdated
            ? {
                id: newInvoiceId,
                status: "draft",
                paid: false,
                hosted_invoice_url: null,
              }
            : {
                id: previousInvoiceId,
                status: "paid",
                paid: true,
                hosted_invoice_url: null,
              },
          items: {
            data: [planItem(TEAM_PRICE, plan.periodStart, plan.periodEnd)],
          },
        };
      }),
    );
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue(
      attachedSchedule,
    );
    context.mocks.stripe.subscriptionSchedules.update.mockImplementation(() => {
      scheduleUpdated = true;
      return Promise.resolve(attachedSchedule);
    });
    context.mocks.stripe.invoices.createPreview.mockImplementation(
      (params: unknown) => {
        const isSchedulePreview =
          typeof params === "object" && params !== null && "schedule" in params;
        if (isSchedulePreview) {
          return Promise.resolve(
            previewInvoice({
              lines: [
                recurringLine({
                  amount: 30_000,
                  periodStart: plan.periodEnd,
                  periodEnd: afterAllowanceEnd,
                }),
              ],
            }),
          );
        }
        return Promise.resolve(
          previewInvoice({
            lines: [
              prorationLine({
                amount: 15_000,
                prorationTimestamp,
                periodEnd: plan.periodEnd,
              }),
            ],
          }),
        );
      },
    );
    context.mocks.stripe.invoices.finalizeInvoice.mockResolvedValue({
      id: newInvoiceId,
      status: "open",
      paid: false,
      hosted_invoice_url: hostedInvoiceUrl,
    });
    context.mocks.stripe.invoices.pay.mockRejectedValue(
      new Stripe.errors.StripeCardError({
        type: "card_error",
        code: "card_declined",
        message: "No payment method on file",
      }),
    );
    context.mocks.stripe.invoices.retrieve.mockResolvedValue({
      id: newInvoiceId,
      status: "open",
      paid: false,
      hosted_invoice_url: hostedInvoiceUrl,
    });
    clearStripeMocks();

    const preview = await accept(
      concurrencyCheckout.preview({
        headers,
        body: {
          quantity: 3,
          supportsInAppPreview: true,
          returnUrl: RETURN_URL,
        },
      }),
      [200],
    );
    const purchase = await accept(
      concurrencyCheckout.create({
        headers,
        body: { quantity: 3, ...REDIRECTS },
      }),
      [200],
    );

    expect(preview.body).toStrictEqual({
      currentQuantity: 0,
      targetQuantity: 3,
      immediateAmountCents: 15_000,
      nextRecurringAmountCents: 30_000,
      currency: "usd",
    });
    expect(purchase.body).toStrictEqual({ url: hostedInvoiceUrl });
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();

    const expectedPhases = [
      {
        start_date: plan.periodStart,
        end_date: plan.periodEnd,
        currency: "usd",
        items: [
          { price: TEAM_PRICE, quantity: 1 },
          {
            price: ALLOWANCE_PRICE,
            quantity: 1,
            metadata: { allowanceKind: "archived" },
          },
          { price: CONCURRENCY_PRICE, quantity: 3 },
        ],
        discounts: [{ discount: "di_existing" }, { coupon: "coupon_promo" }],
        metadata: { phaseRole: "allowance" },
        proration_behavior: "none",
      },
      {
        start_date: plan.periodEnd,
        end_date: afterAllowanceEnd,
        currency: "usd",
        items: [
          { price: TEAM_PRICE, quantity: 1 },
          { price: CONCURRENCY_PRICE, quantity: 3 },
        ],
        proration_behavior: "none",
      },
    ];
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
      schedule: scheduleId,
      preview_mode: "next",
      schedule_details: {
        end_behavior: "cancel",
        proration_behavior: "none",
        phases: expectedPhases,
      },
    });
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(
      scheduleId,
      {
        end_behavior: "cancel",
        proration_behavior: "always_invoice",
        phases: expectedPhases,
      },
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(
          /^concurrency-change:.*:schedule-update$/,
        ),
      }),
    );
    expect(
      context.mocks.stripe.subscriptionSchedules.release,
    ).not.toHaveBeenCalled();
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(context.mocks.stripe.invoices.finalizeInvoice).toHaveBeenCalledWith(
      newInvoiceId,
      {},
      {
        idempotencyKey: `concurrency-change:${plan.subscriptionId}:${newInvoiceId}:finalize`,
      },
    );
    expect(context.mocks.stripe.invoices.pay).toHaveBeenCalledWith(
      newInvoiceId,
      {},
      {
        idempotencyKey: `concurrency-change:${plan.subscriptionId}:${newInvoiceId}:pay`,
      },
    );
  });

  it("billing-concurrency-checkout-027 allows concurrency increases but blocks reductions during a Team to Pro downgrade", async () => {
    const fixedNow = Date.parse("2026-06-01T00:00:00.000Z");
    mockNow(fixedNow);
    const prorationTimestamp = Math.floor(fixedNow / 1000);
    const plan = await seedPlanWorkspace({ tier: "team" });
    await attachSharedConcurrency({ plan, slots: 5 });
    const scheduleId = `sub_sched_${randomUUID().slice(0, 8)}`;
    const nextPhaseEnd = plan.periodEnd + 30 * DAY_SECONDS;
    let attachedScheduleId: string | null = null;

    const currentSubscription = () => {
      return {
        id: plan.subscriptionId,
        customer: plan.customerId,
        status: "active",
        cancel_at_period_end: false,
        cancel_at: null,
        schedule: attachedScheduleId,
        default_payment_method: "pm_team_card",
        default_source: null,
        discounts: [],
        metadata: {},
        items: {
          data: [
            planItem(TEAM_PRICE, plan.periodStart, plan.periodEnd),
            concurrencyItem(5, plan.periodStart, plan.periodEnd, "si_conc_5"),
          ],
        },
      };
    };
    const downgradeSchedule = {
      id: scheduleId,
      subscription: plan.subscriptionId,
      end_behavior: "release",
      current_phase: {
        start_date: plan.periodStart,
        end_date: plan.periodEnd,
      },
      phases: [
        {
          start_date: plan.periodStart,
          end_date: plan.periodEnd,
          items: [
            { price: TEAM_PRICE, quantity: 1 },
            { price: CONCURRENCY_PRICE, quantity: 5 },
          ],
        },
        {
          start_date: plan.periodEnd,
          end_date: nextPhaseEnd,
          items: [
            { price: PRO_PRICE, quantity: 1 },
            { price: CONCURRENCY_PRICE, quantity: 5 },
          ],
        },
      ],
    };

    context.mocks.stripe.subscriptions.retrieve.mockImplementation(
      respondDynamically(currentSubscription),
    );
    context.mocks.stripe.subscriptionSchedules.create.mockImplementation(() => {
      attachedScheduleId = scheduleId;
      return Promise.resolve(downgradeSchedule);
    });
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue(
      downgradeSchedule,
    );
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue(
      downgradeSchedule,
    );

    await accept(
      billingDowngrade.create({ headers, body: { targetTier: "pro" } }),
      [200],
    );
    clearStripeMocks();

    context.mocks.stripe.invoices.createPreview.mockImplementation(
      (params: unknown) => {
        const isSchedulePreview =
          typeof params === "object" && params !== null && "schedule" in params;
        if (isSchedulePreview) {
          return Promise.resolve(
            previewInvoice({
              lines: [
                recurringLine({
                  amount: 2000,
                  periodStart: plan.periodEnd,
                  periodEnd: nextPhaseEnd,
                  priceId: PRO_PRICE,
                }),
              ],
            }),
          );
        }
        return Promise.resolve(
          previewInvoice({
            lines: [
              prorationLine({
                amount: 10_000,
                prorationTimestamp,
                periodEnd: plan.periodEnd,
              }),
            ],
          }),
        );
      },
    );

    const increasePreview = await accept(
      concurrencySub.previewChange({
        headers,
        params: { subscriptionId: plan.subscriptionId },
        body: { quantity: 6 },
      }),
      [200],
    );
    const reductionPreview = await accept(
      concurrencySub.previewChange({
        headers,
        params: { subscriptionId: plan.subscriptionId },
        body: { quantity: 3 },
      }),
      [409],
    );
    const cancelResponse = await accept(
      concurrencySub.cancel({
        headers,
        params: { subscriptionId: plan.subscriptionId },
        body: {},
      }),
      [409],
    );
    const confirmIncrease = await accept(
      concurrencySub.confirmChange({
        headers,
        params: { subscriptionId: plan.subscriptionId },
        body: { quantity: 6 },
      }),
      [200],
    );

    expect(increasePreview.body).toStrictEqual({
      currentQuantity: 5,
      targetQuantity: 6,
      immediateAmountCents: 10_000,
      nextRecurringAmountCents: 0,
      currency: "usd",
    });
    expect(reductionPreview.body).toStrictEqual({
      error: { message: PLAN_ENDING_REDUCE_MESSAGE, code: "CONFLICT" },
    });
    expect(cancelResponse.body).toStrictEqual({
      error: { message: PLAN_ENDING_CANCEL_MESSAGE, code: "CONFLICT" },
    });
    expect(confirmIncrease.body).toStrictEqual({
      status: "processing",
      hostedInvoiceUrl: null,
    });
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        subscription: plan.subscriptionId,
        preview_mode: "next",
      }),
    );
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        schedule: scheduleId,
        preview_mode: "next",
      }),
    );
    expect(
      context.mocks.stripe.subscriptionSchedules.retrieve,
    ).toHaveBeenCalledWith(scheduleId);
    expect(
      context.mocks.stripe.subscriptionSchedules.release,
    ).not.toHaveBeenCalled();
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(
      scheduleId,
      {
        end_behavior: "release",
        proration_behavior: "always_invoice",
        phases: [
          {
            start_date: plan.periodStart,
            end_date: plan.periodEnd,
            items: [
              { price: TEAM_PRICE, quantity: 1 },
              { price: CONCURRENCY_PRICE, quantity: 6 },
            ],
            proration_behavior: "none",
          },
          {
            start_date: plan.periodEnd,
            end_date: nextPhaseEnd,
            items: [{ price: PRO_PRICE, quantity: 1 }],
            proration_behavior: "none",
          },
        ],
      },
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(
          /^concurrency-change:.*:schedule-update$/,
        ),
      }),
    );
  });

  it("billing-concurrency-checkout-041 restores a scheduled shared concurrency reduction", async () => {
    const plan = await seedPlanWorkspace({ tier: "team" });
    await attachSharedConcurrency({ plan, slots: 5 });
    const scheduleId = `sub_sched_${randomUUID().slice(0, 8)}`;
    let attachedScheduleId: string | null = null;

    const currentSubscription = () => {
      return {
        id: plan.subscriptionId,
        customer: plan.customerId,
        status: "active",
        cancel_at_period_end: false,
        cancel_at: null,
        schedule: attachedScheduleId,
        discounts: [],
        metadata: {},
        items: {
          data: [
            planItem(TEAM_PRICE, plan.periodStart, plan.periodEnd),
            concurrencyItem(5, plan.periodStart, plan.periodEnd, "si_conc_5"),
          ],
        },
      };
    };
    const reductionSchedule = {
      id: scheduleId,
      subscription: plan.subscriptionId,
      end_behavior: "release",
      current_phase: {
        start_date: plan.periodStart,
        end_date: plan.periodEnd,
      },
      phases: [
        {
          start_date: plan.periodStart,
          end_date: plan.periodEnd,
          items: [
            { price: TEAM_PRICE, quantity: 1 },
            { price: CONCURRENCY_PRICE, quantity: 5 },
          ],
        },
        {
          start_date: plan.periodEnd,
          end_date: plan.periodEnd + 30 * DAY_SECONDS,
          items: [
            { price: TEAM_PRICE, quantity: 1 },
            { price: CONCURRENCY_PRICE, quantity: 3 },
          ],
        },
      ],
    };

    context.mocks.stripe.subscriptions.retrieve.mockImplementation(
      respondDynamically(currentSubscription),
    );
    context.mocks.stripe.subscriptionSchedules.create.mockImplementation(() => {
      attachedScheduleId = scheduleId;
      return Promise.resolve(reductionSchedule);
    });
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue(
      reductionSchedule,
    );
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue(
      reductionSchedule,
    );
    context.mocks.stripe.subscriptionSchedules.release.mockResolvedValue({
      id: scheduleId,
    });

    await accept(
      concurrencySub.confirmChange({
        headers,
        params: { subscriptionId: plan.subscriptionId },
        body: { quantity: 3 },
      }),
      [200],
    );
    const statusBeforeRestore = await readStatus();
    expect(statusBeforeRestore.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({
        id: plan.subscriptionId,
        scheduledQuantity: 3,
      }),
    ]);
    clearStripeMocks();

    const restored = await accept(
      concurrencySub.restore({
        headers,
        params: { subscriptionId: plan.subscriptionId },
        body: {},
      }),
      [200],
    );

    expect(restored.body).toStrictEqual({ success: true });
    expect(
      context.mocks.stripe.subscriptionSchedules.release,
    ).toHaveBeenCalledWith(scheduleId, { preserve_cancel_date: true });

    const statusAfterRestore = await readStatus();
    expect(statusAfterRestore.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({
        id: plan.subscriptionId,
        cancelAtPeriodEnd: false,
      }),
    ]);
    expect(
      "scheduledQuantity" in
        (statusAfterRestore.concurrencySubscriptions[0] ?? {}),
    ).toBeFalsy();
  });

  it("billing-concurrency-checkout-042 restores a concurrency reduction without removing the Plan cancellation", async () => {
    const planEndDate = new Date("2099-06-20T00:00:00.000Z");
    const plan = await seedPlanWorkspace({
      tier: "team",
      periodEnd: planEndDate,
    });
    const concurrencyEnd = plan.periodEnd - 30 * DAY_SECONDS;
    const concurrencyStart = concurrencyEnd - 30 * DAY_SECONDS;
    await attachSharedConcurrency({
      plan,
      slots: 5,
      concurrencyStart,
      concurrencyEnd,
    });
    const scheduleId = `sub_sched_${randomUUID().slice(0, 8)}`;

    const cancelSchedule = {
      id: scheduleId,
      subscription: plan.subscriptionId,
      end_behavior: "cancel",
      current_phase: {
        start_date: concurrencyStart,
        end_date: concurrencyEnd,
      },
      phases: [
        {
          start_date: concurrencyStart,
          end_date: concurrencyEnd,
          items: [
            { price: TEAM_PRICE, quantity: 1 },
            { price: CONCURRENCY_PRICE, quantity: 5 },
          ],
          proration_behavior: "none",
        },
        {
          start_date: concurrencyEnd,
          end_date: plan.periodEnd,
          items: [
            { price: TEAM_PRICE, quantity: 1 },
            { price: CONCURRENCY_PRICE, quantity: 3 },
          ],
          proration_behavior: "none",
        },
      ],
    };

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: plan.subscriptionId,
      customer: plan.customerId,
      status: "active",
      cancel_at_period_end: false,
      cancel_at: null,
      schedule: scheduleId,
      discounts: [],
      metadata: {},
      items: {
        data: [
          planItem(TEAM_PRICE, concurrencyStart, plan.periodEnd),
          concurrencyItem(5, concurrencyStart, concurrencyEnd, "si_conc_5"),
        ],
      },
    });
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue(
      cancelSchedule,
    );
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue(
      cancelSchedule,
    );

    await accept(
      concurrencySub.confirmChange({
        headers,
        params: { subscriptionId: plan.subscriptionId },
        body: { quantity: 3 },
      }),
      [200],
    );
    clearStripeMocks();

    const restored = await accept(
      concurrencySub.restore({
        headers,
        params: { subscriptionId: plan.subscriptionId },
        body: {},
      }),
      [200],
    );

    expect(restored.body).toStrictEqual({ success: true });
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(
      scheduleId,
      {
        end_behavior: "cancel",
        proration_behavior: "none",
        phases: [
          {
            start_date: concurrencyStart,
            end_date: concurrencyEnd,
            items: [
              { price: TEAM_PRICE, quantity: 1 },
              { price: CONCURRENCY_PRICE, quantity: 5 },
            ],
            proration_behavior: "none",
          },
          {
            start_date: concurrencyEnd,
            end_date: plan.periodEnd,
            items: [
              { price: TEAM_PRICE, quantity: 1 },
              { price: CONCURRENCY_PRICE, quantity: 5 },
            ],
            proration_behavior: "none",
          },
        ],
      },
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(
          /^concurrency-change:.*:schedule-update$/,
        ),
      }),
    );
    expect(
      context.mocks.stripe.subscriptionSchedules.release,
    ).not.toHaveBeenCalled();

    const status = await readStatus();
    expect(status.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({
        id: plan.subscriptionId,
        quantity: 5,
      }),
    ]);
    expect(
      "scheduledQuantity" in (status.concurrencySubscriptions[0] ?? {}),
    ).toBeFalsy();
  });

  it("billing-concurrency-checkout-046 cancels and restores a shared concurrency item without blocking later changes", async () => {
    const plan = await seedPlanWorkspace({ tier: "team" });
    await attachSharedConcurrency({ plan, slots: 2 });
    const scheduleId = `sub_sched_${randomUUID().slice(0, 8)}`;
    const effectiveAt = new Date(plan.periodEnd * 1000).toISOString();
    let attachedScheduleId: string | null = null;

    const currentSubscription = () => {
      return {
        id: plan.subscriptionId,
        customer: plan.customerId,
        status: "active",
        cancel_at_period_end: false,
        cancel_at: null,
        schedule: attachedScheduleId,
        trial_end: null,
        discounts: [],
        metadata: {},
        items: {
          data: [
            planItem(TEAM_PRICE, plan.periodStart, plan.periodEnd),
            concurrencyItem(2, plan.periodStart, plan.periodEnd, "si_conc_2"),
          ],
        },
      };
    };
    const cancelingSchedule = {
      id: scheduleId,
      subscription: plan.subscriptionId,
      end_behavior: "release",
      current_phase: {
        start_date: plan.periodStart,
        end_date: plan.periodEnd,
      },
      phases: [
        {
          start_date: plan.periodStart,
          end_date: plan.periodEnd,
          items: [
            { price: TEAM_PRICE, quantity: 1 },
            { price: CONCURRENCY_PRICE, quantity: 2 },
          ],
        },
        {
          start_date: plan.periodEnd,
          end_date: plan.periodEnd + 30 * DAY_SECONDS,
          items: [{ price: TEAM_PRICE, quantity: 1 }],
        },
      ],
    };

    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: plan.customerId,
      metadata: { orgId: plan.orgId },
    });
    context.mocks.stripe.subscriptions.retrieve.mockImplementation(
      respondDynamically(currentSubscription),
    );
    context.mocks.stripe.subscriptionSchedules.create.mockImplementation(() => {
      attachedScheduleId = scheduleId;
      return Promise.resolve(cancelingSchedule);
    });
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue(
      cancelingSchedule,
    );
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue(
      cancelingSchedule,
    );
    context.mocks.stripe.subscriptionSchedules.release.mockImplementation(
      () => {
        attachedScheduleId = null;
        return Promise.resolve({ id: scheduleId });
      },
    );
    context.mocks.stripe.invoices.createPreview.mockResolvedValue(
      previewInvoice({
        lines: [
          recurringLine({
            amount: 10_000,
            periodStart: plan.periodEnd,
            periodEnd: plan.periodEnd + 30 * DAY_SECONDS,
          }),
        ],
      }),
    );
    clearStripeMocks();

    const canceled = await accept(
      concurrencySub.cancel({
        headers,
        params: { subscriptionId: plan.subscriptionId },
        body: {},
      }),
      [200],
    );
    expect(canceled.body).toStrictEqual({
      success: true,
      currentPeriodEnd: effectiveAt,
    });
    expect(
      context.mocks.stripe.subscriptionSchedules.create,
    ).toHaveBeenCalledWith(
      { from_subscription: plan.subscriptionId },
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(
          /^concurrency-change:.*:schedule-create$/,
        ),
      }),
    );
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(
      scheduleId,
      {
        end_behavior: "release",
        proration_behavior: "none",
        phases: [
          {
            start_date: plan.periodStart,
            end_date: plan.periodEnd,
            items: [
              { price: TEAM_PRICE, quantity: 1 },
              { price: CONCURRENCY_PRICE, quantity: 2 },
            ],
            proration_behavior: "none",
          },
          {
            start_date: plan.periodEnd,
            duration: MONTHLY_RECURRING,
            items: [{ price: TEAM_PRICE, quantity: 1 }],
            proration_behavior: "none",
          },
        ],
      },
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(
          /^concurrency-change:.*:schedule-update$/,
        ),
      }),
    );
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();

    const statusAfterCancel = await readStatus();
    expect(statusAfterCancel.cancelAtPeriodEnd).toBeFalsy();
    expect(statusAfterCancel.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({
        id: plan.subscriptionId,
        cancelAtPeriodEnd: true,
      }),
    ]);

    context.mocks.stripe.subscriptionSchedules.update.mockClear();
    await deliverStripeEvent({
      type: "customer.subscription.updated",
      data: { object: currentSubscription() },
    });

    const statusAfterWebhook = await readStatus();
    expect(statusAfterWebhook.cancelAtPeriodEnd).toBeFalsy();
    expect(statusAfterWebhook.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({
        id: plan.subscriptionId,
        cancelAtPeriodEnd: true,
      }),
    ]);

    const restored = await accept(
      concurrencySub.restore({
        headers,
        params: { subscriptionId: plan.subscriptionId },
        body: {},
      }),
      [200],
    );
    expect(restored.body).toStrictEqual({ success: true });
    expect(
      context.mocks.stripe.subscriptionSchedules.release,
    ).toHaveBeenCalledWith(scheduleId, { preserve_cancel_date: true });
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).not.toHaveBeenCalled();
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();

    const statusAfterRestore = await readStatus();
    expect(statusAfterRestore.cancelAtPeriodEnd).toBeFalsy();
    expect(statusAfterRestore.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({
        id: plan.subscriptionId,
        cancelAtPeriodEnd: false,
      }),
    ]);

    const laterPreview = await accept(
      concurrencySub.previewChange({
        headers,
        params: { subscriptionId: plan.subscriptionId },
        body: { quantity: 1 },
      }),
      [200],
    );
    expect(laterPreview.body).toStrictEqual({
      currentQuantity: 2,
      targetQuantity: 1,
      immediateAmountCents: 0,
      nextRecurringAmountCents: 10_000,
      currency: "usd",
      effectiveAt,
    });
  });

  it("billing-concurrency-checkout-009 adds concurrency to an attached Team cancellation schedule", async () => {
    const fixedNow = Date.parse("2026-06-01T00:00:00.000Z");
    mockNow(fixedNow);
    const prorationTimestamp = Math.floor(fixedNow / 1000);
    const plan = await seedPlanWorkspace({
      tier: "team",
      periodEnd: new Date("2099-05-20T00:00:00.000Z"),
    });
    const scheduleId = `sub_sched_${randomUUID().slice(0, 8)}`;
    const attachedSubscription = {
      id: plan.subscriptionId,
      customer: plan.customerId,
      status: "active",
      cancel_at_period_end: false,
      cancel_at: null,
      schedule: scheduleId,
      trial_end: null,
      metadata: {},
      latest_invoice: {
        id: `in_prev_${randomUUID().slice(0, 8)}`,
        status: "paid",
        paid: true,
        hosted_invoice_url: null,
      },
      items: {
        data: [planItem(TEAM_PRICE, plan.periodStart, plan.periodEnd)],
      },
    };
    const cancelSchedule = {
      id: scheduleId,
      subscription: plan.subscriptionId,
      end_behavior: "cancel",
      current_phase: {
        start_date: plan.periodStart,
        end_date: plan.periodEnd,
      },
      phases: [
        {
          start_date: plan.periodStart,
          end_date: plan.periodEnd,
          items: [{ price: TEAM_PRICE, quantity: 1 }],
        },
      ],
    };

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      attachedSubscription,
    );
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue(
      cancelSchedule,
    );
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue(
      cancelSchedule,
    );
    context.mocks.stripe.invoices.createPreview.mockImplementation(
      (params: unknown) => {
        if (
          typeof params === "object" &&
          params !== null &&
          "schedule" in params
        ) {
          return Promise.reject(
            new Stripe.errors.StripeInvalidRequestError({
              type: "invalid_request_error",
              code: "invoice_upcoming_none",
              message: "No upcoming invoices for schedule",
            }),
          );
        }
        return Promise.resolve(
          previewInvoice({
            lines: [
              prorationLine({
                amount: 15_000,
                prorationTimestamp,
                periodEnd: plan.periodEnd,
              }),
            ],
          }),
        );
      },
    );
    clearStripeMocks();

    const preview = await accept(
      concurrencyCheckout.preview({
        headers,
        body: { quantity: 3 },
      }),
      [200],
    );

    expect(preview.body).toStrictEqual({
      currentQuantity: 0,
      targetQuantity: 3,
      immediateAmountCents: 15_000,
      nextRecurringAmountCents: 0,
      currency: "usd",
    });

    const purchase = await accept(
      concurrencyCheckout.create({
        headers,
        body: { quantity: 3, ...REDIRECTS },
      }),
      [200],
    );

    expect(purchase.body).toStrictEqual({
      url: REDIRECTS.successUrl,
    });
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
      subscription: plan.subscriptionId,
      preview_mode: "next",
      subscription_details: {
        items: [{ price: CONCURRENCY_PRICE, quantity: 3 }],
        proration_behavior: "always_invoice",
        proration_date: prorationTimestamp,
      },
    });
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith({
      schedule: scheduleId,
      preview_mode: "next",
      schedule_details: {
        end_behavior: "cancel",
        proration_behavior: "none",
        phases: [
          {
            start_date: plan.periodStart,
            end_date: plan.periodEnd,
            items: [
              { price: TEAM_PRICE, quantity: 1 },
              { price: CONCURRENCY_PRICE, quantity: 3 },
            ],
            proration_behavior: "none",
          },
        ],
      },
    });
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(
      scheduleId,
      {
        end_behavior: "cancel",
        proration_behavior: "always_invoice",
        phases: [
          {
            start_date: plan.periodStart,
            end_date: plan.periodEnd,
            items: [
              { price: TEAM_PRICE, quantity: 1 },
              { price: CONCURRENCY_PRICE, quantity: 3 },
            ],
            proration_behavior: "none",
          },
        ],
      },
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(
          /^concurrency-change:.*:schedule-update$/,
        ),
      }),
    );
    expect(
      context.mocks.stripe.subscriptionSchedules.release,
    ).not.toHaveBeenCalled();
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it("billing-concurrency-checkout-010 rejects a concurrency purchase while the Plan has a scheduled change", async () => {
    const plan = await seedPlanWorkspace({
      tier: "team",
      periodEnd: new Date("2099-05-20T00:00:00.000Z"),
    });
    const scheduleId = `sub_sched_${randomUUID().slice(0, 8)}`;
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: plan.subscriptionId,
      customer: plan.customerId,
      status: "active",
      cancel_at_period_end: false,
      cancel_at: null,
      schedule: scheduleId,
      trial_end: null,
      metadata: {},
      items: {
        data: [planItem(TEAM_PRICE, plan.periodStart, plan.periodEnd)],
      },
    });
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue({
      id: scheduleId,
      subscription: plan.subscriptionId,
      end_behavior: "release",
      current_phase: {
        start_date: plan.periodStart,
        end_date: plan.periodEnd,
      },
      phases: [
        {
          start_date: plan.periodStart,
          end_date: plan.periodEnd,
          items: [{ price: TEAM_PRICE, quantity: 1 }],
        },
        {
          start_date: plan.periodEnd,
          end_date: plan.periodEnd + 30 * DAY_SECONDS,
          items: [{ price: PRO_PRICE, quantity: 1 }],
        },
      ],
    });
    clearStripeMocks();

    const preview = await accept(
      concurrencyCheckout.preview({
        headers,
        body: { quantity: 3 },
      }),
      [409],
    );
    const purchase = await accept(
      concurrencyCheckout.create({
        headers,
        body: { quantity: 3, ...REDIRECTS },
      }),
      [409],
    );

    const expectedError = {
      error: {
        code: "CONFLICT",
        message: "Complete the pending concurrency update before adding slots",
      },
    };
    expect(preview.body).toStrictEqual(expectedError);
    expect(purchase.body).toStrictEqual(expectedError);
    expect(
      context.mocks.stripe.subscriptionSchedules.retrieve,
    ).toHaveBeenCalledWith(scheduleId);
    expect(context.mocks.stripe.invoices.createPreview).not.toHaveBeenCalled();
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).not.toHaveBeenCalled();
  });
});
