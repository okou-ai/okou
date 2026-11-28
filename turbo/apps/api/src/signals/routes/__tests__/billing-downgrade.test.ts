import { setupApp } from "../../../__tests__/test-helpers";
import { randomUUID } from "node:crypto";
import { now } from "../../../lib/time";
import { createRouteMocks } from "./helpers/route-test";
import {
  billingConcurrencySubscriptionContract,
  billingDowngradeContract,
  billingRestoreContract,
  billingStatusContract,
} from "@okouai/api-contracts/contracts/billing";
import { webhookStripeContract } from "@okouai/api-contracts/contracts/webhooks";
import { describe, expect, it } from "vitest";

import { apiTestEnvironment } from "../../../__tests__/test-environment";
import { testContext, accept } from "../../../__tests__/test-context";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { billingConcurrencySubscriptionRoutes } from "../billing-concurrency-subscriptions";
import { billingDowngradeRoutes } from "../billing-downgrade";
import { billingRestoreRoutes } from "../billing-restore";
import { billingStatusRoutes } from "../billing-status";
import { webhooksStripeRoutes } from "../webhooks-stripe";

const context = testContext();

const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const PRO_PRICE = apiTestEnvironment.OKOU_PRICE_PRO;
const TEAM_PRICE = apiTestEnvironment.OKOU_PRICE_TEAM;
const CONCURRENCY_PRICE = apiTestEnvironment.OKOU_PRICE_CONCURRENCY;
const USAGE_PACK_PLAN_PRO = apiTestEnvironment.OKOU_PRICE_USAGE_PACK_PLAN_PRO;
const USAGE_PACK_PLAN_TEAM = apiTestEnvironment.OKOU_PRICE_USAGE_PACK_PLAN_TEAM;
const USAGE_PACK_50 = apiTestEnvironment.OKOU_PRICE_USAGE_PACK_50;
const DAY = 86_400;
const MONTHLY = { interval: "month", interval_count: 1 } as const;

interface StripeItem {
  readonly price: string;
  readonly quantity?: number;
}

interface Subscription {
  readonly customerId: string;
  readonly subscriptionId: string;
  readonly start: number;
  readonly end: number;
}

function isoAt(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

interface SchedulePhase {
  readonly start_date?: number;
  readonly end_date?: number;
  readonly items: readonly {
    readonly price: string;
    readonly quantity?: number;
  }[];
  readonly [key: string]: unknown;
}

function phasesOf(params: unknown): readonly SchedulePhase[] | undefined {
  if (typeof params !== "object" || params === null || !("phases" in params)) {
    return undefined;
  }
  const phases: unknown = params.phases;
  if (!Array.isArray(phases)) {
    return undefined;
  }
  return phases.map((phase: unknown): SchedulePhase => {
    if (typeof phase !== "object" || phase === null) {
      throw new Error("Stripe schedule phase must be an object");
    }
    const items: unknown = "items" in phase ? phase.items : [];
    return {
      ...phase,
      items: Array.isArray(items)
        ? items.map((item: unknown) => {
            const price =
              typeof item === "object" && item !== null && "price" in item
                ? String(item.price)
                : "";
            const quantity =
              typeof item === "object" &&
              item !== null &&
              "quantity" in item &&
              typeof item.quantity === "number"
                ? item.quantity
                : undefined;
            return quantity === undefined ? { price } : { price, quantity };
          })
        : [],
    };
  });
}

/** Stripe's Team subscription with a concurrency item and its schedule. */
function stripeTeamWithConcurrency(args: {
  readonly subscriptionId: string;
  readonly customerId: string;
  readonly start: number;
  readonly planEnd: number;
  readonly concurrencyEnd: number;
}) {
  let scheduleId: string | null = null;
  let phases: readonly SchedulePhase[] = [];
  const concurrencySlots = 5;
  const subscription = () => {
    return {
      id: args.subscriptionId,
      object: "subscription",
      status: "active",
      customer: args.customerId,
      cancel_at_period_end: false,
      cancel_at: null,
      schedule: scheduleId,
      trial_end: null,
      default_payment_method: "pm_downgrade_card",
      discounts: [],
      metadata: {},
      items: {
        data: [
          {
            id: "si_team",
            quantity: 1,
            price: { id: TEAM_PRICE, recurring: MONTHLY },
            current_period_start: args.start,
            current_period_end: args.planEnd,
          },
          {
            id: "si_concurrency",
            quantity: concurrencySlots,
            price: { id: CONCURRENCY_PRICE, recurring: MONTHLY },
            current_period_start: args.start,
            current_period_end: args.concurrencyEnd,
          },
        ],
      },
    };
  };
  const schedule = () => {
    const at = Math.floor(now() / 1000);
    const current =
      phases.find((phase) => {
        return (
          (phase.start_date ?? 0) <= at && at < (phase.end_date ?? Infinity)
        );
      }) ?? phases[0];
    return {
      id: scheduleId,
      object: "subscription_schedule",
      subscription: args.subscriptionId,
      status: "active",
      end_behavior: "release",
      current_phase: current
        ? { start_date: current.start_date, end_date: current.end_date }
        : null,
      phases: phases.map((phase) => {
        return {
          ...phase,
          items: phase.items.map((item) => {
            return { price: item.price, quantity: item.quantity ?? 1 };
          }),
        };
      }),
    };
  };
  const mocks = context.mocks.stripe;
  const ownSubscription = (id: unknown) => {
    if (id !== args.subscriptionId) {
      throw new Error(`Unknown Stripe subscription ${String(id)}`);
    }
    return Promise.resolve(subscription());
  };
  mocks.subscriptions.retrieve.mockImplementation(ownSubscription);
  mocks.subscriptions.update.mockImplementation(ownSubscription);
  mocks.subscriptionSchedules.create.mockImplementation(() => {
    scheduleId = `sub_sched_${randomUUID().slice(0, 8)}`;
    phases = [
      {
        start_date: args.start,
        end_date: args.concurrencyEnd,
        items: [
          { price: TEAM_PRICE, quantity: 1 },
          { price: CONCURRENCY_PRICE, quantity: concurrencySlots },
        ],
      },
    ];
    return Promise.resolve(schedule());
  });
  mocks.subscriptionSchedules.retrieve.mockImplementation((id: unknown) => {
    if (id !== scheduleId) {
      throw new Error(`Unknown Stripe schedule ${String(id)}`);
    }
    return Promise.resolve(schedule());
  });
  mocks.subscriptionSchedules.update.mockImplementation(
    (_id: unknown, params: unknown) => {
      phases = phasesOf(params) ?? phases;
      return Promise.resolve(schedule());
    },
  );
  mocks.subscriptionSchedules.release.mockImplementation(() => {
    const released = { ...schedule(), status: "released" };
    scheduleId = null;
    phases = [];
    return Promise.resolve(released);
  });
  return {
    get scheduleId() {
      return scheduleId;
    },
    get phases() {
      return phases;
    },
  };
}

function setup(role: "org:admin" | "org:member" = "org:admin") {
  const admin = {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  };
  createRouteMocks(context).clerk.session(admin.userId, admin.orgId, role);
  mockOptionalEnv("STRIPE_WEBHOOK_SECRET", "whsec_billing_downgrade");
  context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
    id: admin.orgId,
    slug: `downgrade-${admin.orgId.slice(-8)}`,
    name: "Billing Downgrade Org",
    createdBy: admin.userId,
    createdAt: now(),
  });
  const appFor = setupApp({
    context,
    routes: [
      ...billingDowngradeRoutes,
      ...billingConcurrencySubscriptionRoutes,
      ...billingRestoreRoutes,
      ...billingStatusRoutes,
      ...webhooksStripeRoutes,
    ],
  });
  const downgradeApi = appFor(billingDowngradeContract);
  const webhook = appFor(webhookStripeContract);
  const status = appFor(billingStatusContract);

  async function readStatus() {
    return (await accept(status.get({ headers }), [200])).body;
  }

  async function downgrade(
    targetTier: "pro" | "limited-free-1",
    extra: { returnUrl?: string; origin?: string } = {},
  ) {
    const response = await accept(
      downgradeApi.create({
        headers,
        body: {
          targetTier,
          ...(extra.returnUrl ? { returnUrl: extra.returnUrl } : {}),
        },
        ...(extra.origin ? { extraHeaders: { origin: extra.origin } } : {}),
      }),
      [200],
    );
    return response.body;
  }

  /** Stripe delivers the paid invoice of an active plan subscription. */
  async function subscribe(priceId: string): Promise<Subscription> {
    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    const subscriptionId = `sub_${randomUUID().slice(0, 8)}`;
    const end = Math.floor(now() / 1000) + 30 * DAY;
    const start = end - 30 * DAY;
    context.mocks.stripe.customers.retrieve.mockResolvedValueOnce({
      id: customerId,
      metadata: { orgId: admin.orgId },
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: subscriptionId,
      status: "active",
      customer: customerId,
      cancel_at_period_end: false,
      cancel_at: null,
      schedule: null,
      trial_end: null,
      metadata: {},
      items: {
        data: [
          {
            price: { id: priceId },
            current_period_start: start,
            current_period_end: end,
          },
        ],
      },
    });
    const event = {
      id: `evt_${randomUUID()}`,
      created: Math.floor(now() / 1000),
      type: "invoice.paid",
      data: {
        object: {
          id: `in_${randomUUID().slice(0, 8)}`,
          customer: customerId,
          metadata: {},
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
                id: `il_${randomUUID().slice(0, 8)}`,
                price: { id: priceId },
                quantity: 1,
                parent: { type: "subscription_item_details" },
                period: { start, end },
              },
            ],
          },
        },
      },
    };
    context.mocks.stripe.webhooks.constructEventAsync.mockReturnValueOnce(
      event,
    );
    await accept(
      webhook.post({
        body: JSON.stringify(event),
        extraHeaders: { "stripe-signature": "t=1,v1=billing-downgrade" },
      }),
      [200],
    );
    return { customerId, subscriptionId, start, end };
  }

  /** What Stripe reports for the subscription from now on. */
  function stripeReports(
    subscription: Subscription,
    items: readonly StripeItem[],
    options: {
      readonly end?: number;
      readonly schedule?: string | null;
      readonly cancelAt?: number | null;
      readonly discounts?: readonly string[];
      readonly defaultPaymentMethod?: string | null;
    } = {},
  ) {
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: subscription.subscriptionId,
      status: "active",
      customer: subscription.customerId,
      cancel_at_period_end: false,
      cancel_at: options.cancelAt ?? null,
      schedule: options.schedule ?? null,
      default_payment_method:
        options.defaultPaymentMethod === undefined
          ? "pm_downgrade_card"
          : options.defaultPaymentMethod,
      default_source: null,
      discounts: options.discounts ?? [],
      metadata: {},
      items: {
        data: items.map((item) => {
          return {
            id: `si_${randomUUID().slice(0, 8)}`,
            quantity: item.quantity ?? 1,
            price: { id: item.price, recurring: MONTHLY },
            current_period_start: subscription.start,
            current_period_end: options.end ?? subscription.end,
          };
        }),
      },
    });
  }

  /** Stripe delivers a paid Team invoice that also buys 5 concurrency slots. */
  async function subscribeTeamWithConcurrency(concurrencyDays: number) {
    const customerId = `cus_${randomUUID().slice(0, 8)}`;
    const subscriptionId = `sub_${randomUUID().slice(0, 8)}`;
    const start = Math.floor(now() / 1000) - DAY;
    const planEnd = start + 30 * DAY;
    const concurrencyEnd = start + concurrencyDays * DAY;
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      metadata: { orgId: admin.orgId },
      invoice_settings: { default_payment_method: "pm_downgrade_card" },
    });
    const stripe = stripeTeamWithConcurrency({
      subscriptionId,
      customerId,
      start,
      planEnd,
      concurrencyEnd,
    });
    const line = (
      priceId: string,
      quantity: number,
      end: number,
    ): Readonly<Record<string, unknown>> => {
      return {
        id: `il_${randomUUID().slice(0, 8)}`,
        price: { id: priceId },
        quantity,
        parent: { type: "subscription_item_details" },
        period: { start, end },
      };
    };
    const event = {
      id: `evt_${randomUUID()}`,
      created: start,
      type: "invoice.paid",
      data: {
        object: {
          id: `in_${randomUUID().slice(0, 8)}`,
          customer: customerId,
          metadata: {},
          parent: {
            subscription_details: {
              subscription: subscriptionId,
              metadata: {},
            },
          },
          lines: {
            has_more: false,
            data: [
              line(TEAM_PRICE, 1, planEnd),
              line(CONCURRENCY_PRICE, 5, concurrencyEnd),
            ],
          },
        },
      },
    };
    context.mocks.stripe.webhooks.constructEventAsync.mockReturnValueOnce(
      event,
    );
    await accept(
      webhook.post({
        body: JSON.stringify(event),
        extraHeaders: { "stripe-signature": "t=1,v1=billing-downgrade" },
      }),
      [200],
    );
    return { stripe, subscriptionId, start, planEnd, concurrencyEnd };
  }

  return {
    admin,
    downgrade,
    readStatus,
    subscribe,
    subscribeTeamWithConcurrency,
    stripeReports,
    downgradeApi,
    concurrency: appFor(billingConcurrencySubscriptionContract),
    restore: appFor(billingRestoreContract),
  };
}

describe("POST /api/billing/downgrade", () => {
  it("billing-downgrade-003 refuses a non-admin member", async () => {
    const { downgradeApi } = setup("org:member");

    const response = await accept(
      downgradeApi.create({
        headers,
        body: { targetTier: "limited-free-1" },
      }),
      [403],
    );

    expect(response.body.error).toStrictEqual({
      message: "Only org admins can manage billing",
      code: "FORBIDDEN",
    });
  });

  it("billing-downgrade-005 refuses a downgrade to the same tier", async () => {
    const { subscribe, downgradeApi } = setup();
    await subscribe(PRO_PRICE);

    const response = await accept(
      downgradeApi.create({ headers, body: { targetTier: "pro" } }),
      [400],
    );

    expect(response.body.error).toStrictEqual({
      message:
        "Cannot downgrade from pro to pro: target tier is same or higher",
      code: "BAD_REQUEST",
    });
  });

  it("billing-downgrade-015 keeps an existing Stripe cancel_at", async () => {
    const { subscribe, stripeReports, downgrade, readStatus } = setup();
    const subscription = await subscribe(PRO_PRICE);
    const cancelAt = subscription.end + 10 * DAY;
    stripeReports(subscription, [{ price: PRO_PRICE }], { cancelAt });

    await expect(downgrade("limited-free-1")).resolves.toStrictEqual({
      success: true,
      effectiveDate: isoAt(cancelAt),
    });
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).not.toHaveBeenCalled();
    await expect(readStatus()).resolves.toMatchObject({
      cancelAtPeriodEnd: true,
      currentPeriodEnd: isoAt(cancelAt),
      scheduledChange: {
        type: "cancel",
        targetTier: "limited-free-1",
        effectiveDate: isoAt(cancelAt),
      },
    });
  });

  it("billing-downgrade-014 keeps fixed-term Team access until its stored end", async () => {
    const { subscribe, stripeReports, downgrade, readStatus } = setup();
    const subscription = await subscribe(TEAM_PRICE);
    const finalEnd = subscription.end;
    stripeReports(subscription, [{ price: TEAM_PRICE }], {
      end: finalEnd - 10 * DAY,
    });

    await expect(downgrade("limited-free-1")).resolves.toStrictEqual({
      success: true,
      effectiveDate: isoAt(finalEnd),
    });
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      subscription.subscriptionId,
      { cancel_at: finalEnd },
    );
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).not.toHaveBeenCalled();
    await expect(readStatus()).resolves.toMatchObject({
      cancelAtPeriodEnd: true,
      currentPeriodEnd: isoAt(finalEnd),
      scheduledChange: {
        type: "cancel",
        targetTier: "limited-free-1",
        effectiveDate: isoAt(finalEnd),
      },
    });
  });

  it("billing-downgrade-006 schedules Team to Pro and ends concurrency at the period end", async () => {
    const { subscribe, stripeReports, downgrade, readStatus } = setup();
    const subscription = await subscribe(TEAM_PRICE);
    const scheduleId = `sub_sched_${randomUUID().slice(0, 8)}`;
    stripeReports(
      subscription,
      [{ price: TEAM_PRICE }, { price: CONCURRENCY_PRICE, quantity: 4 }],
      { discounts: ["di_team_discount"] },
    );
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValueOnce({
      id: scheduleId,
      current_phase: {
        start_date: subscription.start,
        end_date: subscription.end,
      },
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValueOnce({
      id: scheduleId,
    });

    await expect(downgrade("pro")).resolves.toStrictEqual({
      success: true,
      effectiveDate: isoAt(subscription.end),
    });
    expect(
      context.mocks.stripe.subscriptionSchedules.create,
    ).toHaveBeenCalledWith({ from_subscription: subscription.subscriptionId });
    const discounts = [{ discount: "di_team_discount" }];
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(scheduleId, {
      end_behavior: "release",
      proration_behavior: "none",
      phases: [
        {
          start_date: subscription.start,
          end_date: subscription.end,
          items: [
            { price: TEAM_PRICE, quantity: 1 },
            { price: CONCURRENCY_PRICE, quantity: 4 },
          ],
          proration_behavior: "none",
          discounts,
        },
        {
          start_date: subscription.end,
          duration: MONTHLY,
          items: [{ price: PRO_PRICE, quantity: 1 }],
          proration_behavior: "none",
          discounts,
        },
      ],
    });
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    await expect(readStatus()).resolves.toMatchObject({
      cancelAtPeriodEnd: false,
      currentPeriodEnd: isoAt(subscription.end),
      scheduledChange: {
        type: "downgrade",
        targetTier: "pro",
        effectiveDate: isoAt(subscription.end),
      },
    });
  });

  it("billing-downgrade-008 keeps usage packs when scheduling Team to Pro", async () => {
    mockEnv("OKOU_PRICE_USAGE_PACK_PLAN_PRO", USAGE_PACK_PLAN_PRO);
    mockEnv("OKOU_PRICE_USAGE_PACK_PLAN_TEAM", USAGE_PACK_PLAN_TEAM);
    const { subscribe, stripeReports, downgrade } = setup();
    const subscription = await subscribe(USAGE_PACK_PLAN_TEAM);
    const scheduleId = `sub_sched_${randomUUID().slice(0, 8)}`;
    stripeReports(subscription, [
      { price: USAGE_PACK_50, quantity: 2 },
      { price: USAGE_PACK_PLAN_TEAM },
    ]);
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValueOnce({
      id: scheduleId,
      current_phase: {
        start_date: subscription.start,
        end_date: subscription.end,
      },
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValueOnce({
      id: scheduleId,
    });

    await expect(downgrade("pro")).resolves.toStrictEqual({
      success: true,
      effectiveDate: isoAt(subscription.end),
    });
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(scheduleId, {
      end_behavior: "release",
      proration_behavior: "none",
      phases: [
        {
          start_date: subscription.start,
          end_date: subscription.end,
          items: [
            { price: USAGE_PACK_50, quantity: 2 },
            { price: USAGE_PACK_PLAN_TEAM, quantity: 1 },
          ],
          proration_behavior: "none",
        },
        {
          start_date: subscription.end,
          duration: MONTHLY,
          items: [
            { price: USAGE_PACK_50, quantity: 2 },
            { price: USAGE_PACK_PLAN_PRO, quantity: 1 },
          ],
          proration_behavior: "none",
        },
      ],
    });
  });

  it("billing-downgrade-017 replaces a pending Team to Pro schedule with cancellation", async () => {
    const { subscribe, stripeReports, downgrade, readStatus } = setup();
    const subscription = await subscribe(TEAM_PRICE);
    const scheduleId = `sub_sched_${randomUUID().slice(0, 8)}`;
    const discounts = ["di_team_discount"];
    stripeReports(subscription, [{ price: TEAM_PRICE }], { discounts });
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValueOnce({
      id: scheduleId,
      current_phase: {
        start_date: subscription.start,
        end_date: subscription.end,
      },
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: scheduleId,
    });
    await downgrade("pro");
    context.mocks.stripe.subscriptionSchedules.update.mockClear();
    stripeReports(subscription, [{ price: TEAM_PRICE }], {
      discounts,
      schedule: scheduleId,
    });

    await expect(downgrade("limited-free-1")).resolves.toStrictEqual({
      success: true,
      effectiveDate: isoAt(subscription.end),
    });
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(scheduleId, {
      end_behavior: "cancel",
      proration_behavior: "none",
      phases: [
        {
          start_date: subscription.start,
          end_date: subscription.end,
          items: [{ price: TEAM_PRICE, quantity: 1 }],
          proration_behavior: "none",
          discounts: [{ discount: "di_team_discount" }],
        },
      ],
    });
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    await expect(readStatus()).resolves.toMatchObject({
      cancelAtPeriodEnd: true,
      scheduledChange: {
        type: "cancel",
        targetTier: "limited-free-1",
        effectiveDate: isoAt(subscription.end),
      },
    });
  });

  it("billing-downgrade-011 sends Team to Pro through a setup Checkout when no payment method exists", async () => {
    const appUrl = "https://app.okou.ai";
    mockEnv("APP_URL", appUrl);
    const { admin, subscribe, stripeReports, downgrade } = setup();
    const subscription = await subscribe(TEAM_PRICE);
    stripeReports(subscription, [{ price: TEAM_PRICE }], {
      defaultPaymentMethod: null,
    });
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: subscription.customerId,
      metadata: { orgId: admin.orgId },
      default_source: null,
      invoice_settings: { default_payment_method: null },
    });
    const checkoutUrl = `https://checkout.stripe.test/setup_${randomUUID()}`;
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      id: `cs_setup_${randomUUID()}`,
      url: checkoutUrl,
    });
    const returnUrl = `${appUrl}/settings?settings=billing`;

    await expect(downgrade("pro", { origin: appUrl })).resolves.toStrictEqual({
      status: "payment_method_required",
      checkoutUrl,
    });
    await expect(
      downgrade("pro", { origin: appUrl, returnUrl }),
    ).resolves.toStrictEqual({
      status: "payment_method_required",
      checkoutUrl,
    });

    const metadata = {
      purpose: "billing_downgrade",
      orgId: admin.orgId,
      subscriptionId: subscription.subscriptionId,
      targetTier: "pro",
    };
    const calls = context.mocks.stripe.checkout.sessions.create.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[0]).toStrictEqual({
      mode: "setup",
      customer: subscription.customerId,
      currency: "usd",
      success_url: appUrl,
      cancel_url: appUrl,
      metadata,
      setup_intent_data: { metadata },
    });
    expect(calls[1]?.[0]).toMatchObject({
      success_url: returnUrl,
      cancel_url: returnUrl,
    });
    expect(
      context.mocks.stripe.subscriptionSchedules.create,
    ).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).not.toHaveBeenCalled();
  });
  it("billing-downgrade-010 restores a pre-boundary concurrency change and the Team plan independently", async () => {
    const {
      subscribeTeamWithConcurrency,
      downgrade,
      readStatus,
      concurrency,
      restore,
    } = setup();
    const team = await subscribeTeamWithConcurrency(20);
    const params = { subscriptionId: team.subscriptionId };
    await accept(
      concurrency.confirmChange({ headers, params, body: { quantity: 3 } }),
      [200],
    );
    const scheduleId = team.stripe.scheduleId;

    await expect(downgrade("pro")).resolves.toStrictEqual({
      success: true,
      effectiveDate: isoAt(team.planEnd),
    });
    expect(
      team.stripe.phases.map((phase) => {
        return {
          start: phase.start_date,
          end: phase.end_date,
          items: phase.items,
        };
      }),
    ).toStrictEqual([
      {
        start: team.start,
        end: team.concurrencyEnd,
        items: [
          { price: TEAM_PRICE, quantity: 1 },
          { price: CONCURRENCY_PRICE, quantity: 5 },
        ],
      },
      {
        start: team.concurrencyEnd,
        end: team.planEnd,
        items: [
          { price: TEAM_PRICE, quantity: 1 },
          { price: CONCURRENCY_PRICE, quantity: 3 },
        ],
      },
      {
        start: team.planEnd,
        end: undefined,
        items: [{ price: PRO_PRICE, quantity: 1 }],
      },
    ]);
    await expect(readStatus()).resolves.toMatchObject({
      scheduledChange: { type: "downgrade", targetTier: "pro" },
      concurrencySubscriptions: [
        expect.objectContaining({ scheduledQuantity: 3 }),
      ],
    });

    await expect(
      accept(concurrency.restore({ headers, params, body: {} }), [200]),
    ).resolves.toMatchObject({ body: { success: true } });
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenLastCalledWith(
      scheduleId,
      expect.anything(),
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
    const beforePlanEnd = team.stripe.phases.filter((phase) => {
      return (phase.start_date ?? 0) < team.planEnd;
    });
    expect(beforePlanEnd.length).toBeGreaterThan(0);
    for (const phase of beforePlanEnd) {
      expect(phase.items).toContainEqual({
        price: CONCURRENCY_PRICE,
        quantity: 5,
      });
    }
    expect(beforePlanEnd.at(-1)?.end_date).toBe(team.planEnd);
    expect(team.stripe.phases.at(-1)?.items).toStrictEqual([
      { price: PRO_PRICE, quantity: 1 },
    ]);
    const restoredConcurrency = await readStatus();
    expect(restoredConcurrency.scheduledChange).toMatchObject({
      type: "downgrade",
      targetTier: "pro",
    });
    expect(
      restoredConcurrency.concurrencySubscriptions[0]?.scheduledQuantity ??
        null,
    ).toBeNull();

    await expect(
      accept(restore.create({ headers, body: {} }), [200]),
    ).resolves.toMatchObject({ body: { status: "restored" } });
    expect(
      context.mocks.stripe.subscriptionSchedules.release,
    ).toHaveBeenCalledWith(scheduleId);
    const restored = await readStatus();
    expect(restored.scheduledChange).toBeNull();
    expect(restored.concurrencySubscriptions[0]).toMatchObject({ quantity: 5 });
    expect(
      restored.concurrencySubscriptions[0]?.scheduledQuantity ?? null,
    ).toBeNull();
  });
});
