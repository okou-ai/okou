import { randomUUID } from "node:crypto";

import {
  billingConcurrencySubscriptionContract,
  billingDowngradeContract,
  billingRestoreContract,
  billingStatusContract,
} from "@okouai/api-contracts/contracts/billing";
import { createStore } from "ccstate";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import {
  deleteInvoicesOrg$,
  seedInvoicesOrg$,
  type InvoicesOrgFixture,
} from "./helpers/billing-invoices";
import { createFixtureTracker, createRouteMocks } from "./helpers/route-test";
import {
  postConcurrencyEntitlementsInvoicePaid,
  TEST_PRICE_CONCURRENCY,
} from "./helpers/stripe-billing-webhook";
import { billingConcurrencySubscriptionRoutes } from "../billing-concurrency-subscriptions";
import { billingDowngradeRoutes } from "../billing-downgrade";
import { billingRestoreRoutes } from "../billing-restore";
import { billingStatusRoutes } from "../billing-status";

const context = testContext();
const store = createStore();
const mocks = createRouteMocks(context);

const TEST_PRICE_PRO = "price_test_pro";
const TEST_PRICE_TEAM = "price_test_team";
const TEST_PRICE_CUSTOM = "price_test_custom";
const TEST_USAGE_PACK_PLAN_PRO = "price_test_usage_pack_plan_pro";
const TEST_USAGE_PACK_PLAN_TEAM = "price_test_usage_pack_plan_team";
const TEST_USAGE_PACK_50 = "price_test_usage_pack_50";

async function readBillingStatus() {
  return await accept(
    setupApp({ context, routes: billingStatusRoutes })(
      billingStatusContract,
    ).get({
      headers: { authorization: "Bearer clerk-session" },
    }),
    [200],
  );
}

describe("POST /api/billing/downgrade", () => {
  const track = createFixtureTracker<InvoicesOrgFixture>((fixture) => {
    return store.set(deleteInvoicesOrg$, fixture, context.signal);
  });

  beforeEach(() => {
    mockEnv("OKOU_PRICE_PRO", TEST_PRICE_PRO);
    mockEnv("OKOU_PRICE_TEAM", TEST_PRICE_TEAM);
  });

  it("returns 503 when STRIPE_SECRET_KEY is not configured", async () => {
    mockOptionalEnv("STRIPE_SECRET_KEY", undefined);

    const client = setupApp({ context, routes: billingDowngradeRoutes })(
      billingDowngradeContract,
    );
    const response = await accept(
      client.create({
        body: { targetTier: "limited-free-1" },
        headers: {},
      }),
      [503],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Billing not configured",
        code: "PROVIDER_UNAVAILABLE",
      },
    });
  });

  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context, routes: billingDowngradeRoutes })(
      billingDowngradeContract,
    );
    const response = await accept(
      client.create({
        body: { targetTier: "limited-free-1" },
        headers: {},
      }),
      [401],
    );

    expect(response.status).toBe(401);
  });

  it("returns 403 for non-admin org member", async () => {
    const fixture = await track(
      store.set(seedInvoicesOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const client = setupApp({ context, routes: billingDowngradeRoutes })(
      billingDowngradeContract,
    );
    const response = await accept(
      client.create({
        body: { targetTier: "limited-free-1" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Only org admins can manage billing",
        code: "FORBIDDEN",
      },
    });
  });

  it("returns 400 for invalid targetTier", async () => {
    const fixture = await track(
      store.set(seedInvoicesOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context, routes: billingDowngradeRoutes })(
      billingDowngradeContract,
    );
    const response = await client.create({
      body: { targetTier: "team" as "pro" },
      headers: { authorization: "Bearer clerk-session" },
    });

    expect(response.status).toBe(400);
  });

  it("returns 409 when org has no subscription", async () => {
    const fixture = await track(
      store.set(seedInvoicesOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context, routes: billingDowngradeRoutes })(
      billingDowngradeContract,
    );
    const response = await accept(
      client.create({
        body: { targetTier: "limited-free-1" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [409],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Org has no active subscription",
        code: "CONFLICT",
      },
    });
  });

  it("returns 400 when target tier is same or higher", async () => {
    const subId = `sub-same-${randomUUID().slice(0, 8)}`;
    const fixture = await track(
      store.set(
        seedInvoicesOrg$,
        {
          stripeSubscriptionId: subId,
          subscriptionStatus: "active",
          tier: "pro",
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context, routes: billingDowngradeRoutes })(
      billingDowngradeContract,
    );
    const response = await accept(
      client.create({
        body: { targetTier: "pro" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message:
          "Cannot downgrade from pro to pro: target tier is same or higher",
        code: "BAD_REQUEST",
      },
    });
  });

  it("schedules team to pro and ends concurrency at period end", async () => {
    const subId = `sub-team-pro-${randomUUID().slice(0, 8)}`;
    const periodStart = 1_782_809_751;
    const periodEnd = 1_785_401_751;
    const scheduleId = `sched-team-pro-${randomUUID().slice(0, 8)}`;
    const discountId = `di-team-pro-${randomUUID().slice(0, 8)}`;
    const fixture = await track(
      store.set(
        seedInvoicesOrg$,
        {
          stripeSubscriptionId: subId,
          subscriptionStatus: "active",
          tier: "team",
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: subId,
      default_payment_method: "pm_card",
      discounts: [discountId],
      items: {
        data: [
          {
            id: "si_item_1",
            current_period_start: periodStart,
            current_period_end: periodEnd,
            quantity: 1,
            price: {
              id: TEST_PRICE_TEAM,
              recurring: { interval: "month", interval_count: 1 },
            },
          },
          {
            id: "si_concurrency",
            current_period_start: periodStart,
            current_period_end: periodEnd,
            quantity: 4,
            price: {
              id: TEST_PRICE_CONCURRENCY,
              recurring: { interval: "month", interval_count: 1 },
            },
          },
        ],
      },
    });
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValue({
      id: scheduleId,
      current_phase: {
        start_date: periodStart,
        end_date: periodEnd,
      },
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: scheduleId,
    });

    const client = setupApp({ context, routes: billingDowngradeRoutes })(
      billingDowngradeContract,
    );
    const response = await accept(
      client.create({
        body: { targetTier: "pro" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      success: true,
      effectiveDate: new Date(periodEnd * 1000).toISOString(),
    });
    expect(
      context.mocks.stripe.subscriptionSchedules.create,
    ).toHaveBeenCalledWith({
      from_subscription: subId,
    });
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(scheduleId, {
      end_behavior: "release",
      proration_behavior: "none",
      phases: [
        {
          start_date: periodStart,
          end_date: periodEnd,
          items: [
            { price: TEST_PRICE_TEAM, quantity: 1 },
            { price: TEST_PRICE_CONCURRENCY, quantity: 4 },
          ],
          proration_behavior: "none",
          discounts: [{ discount: discountId }],
        },
        {
          start_date: periodEnd,
          duration: { interval: "month", interval_count: 1 },
          items: [{ price: TEST_PRICE_PRO, quantity: 1 }],
          proration_behavior: "none",
          discounts: [{ discount: discountId }],
        },
      ],
    });
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();

    const status = await readBillingStatus();
    const effectiveDate = new Date(periodEnd * 1000).toISOString();
    expect(status.body.cancelAtPeriodEnd).toBeFalsy();
    expect(status.body.currentPeriodEnd).toBe(effectiveDate);
    expect(status.body.scheduledChange).toStrictEqual({
      type: "downgrade",
      targetTier: "pro",
      effectiveDate,
    });
  });

  it("preserves usage packs when scheduling team to pro", async () => {
    mockEnv("OKOU_PRICE_USAGE_PACK_PLAN_PRO", TEST_USAGE_PACK_PLAN_PRO);
    mockEnv("OKOU_PRICE_USAGE_PACK_PLAN_TEAM", TEST_USAGE_PACK_PLAN_TEAM);
    context.mocks.stripe.subscriptions.list.mockResolvedValue({ data: [] });

    const subId = `sub-usage-pack-team-pro-${randomUUID().slice(0, 8)}`;
    const periodStart = 1_782_809_751;
    const periodEnd = 1_785_401_751;
    const scheduleId = `sched-usage-pack-${randomUUID().slice(0, 8)}`;
    const fixture = await track(
      store.set(
        seedInvoicesOrg$,
        {
          stripeSubscriptionId: subId,
          subscriptionStatus: "active",
          tier: "team",
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: subId,
      default_payment_method: "pm_card",
      items: {
        data: [
          {
            id: "si_usage_pack_50",
            quantity: 2,
            price: { id: TEST_USAGE_PACK_50 },
          },
          {
            id: "si_usage_pack_plan_team",
            current_period_start: periodStart,
            current_period_end: periodEnd,
            quantity: 1,
            price: {
              id: TEST_USAGE_PACK_PLAN_TEAM,
              recurring: { interval: "month", interval_count: 1 },
            },
          },
        ],
      },
    });
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValue({
      id: scheduleId,
      current_phase: {
        start_date: periodStart,
        end_date: periodEnd,
      },
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: scheduleId,
    });

    const client = setupApp({ context, routes: billingDowngradeRoutes })(
      billingDowngradeContract,
    );
    const response = await accept(
      client.create({
        body: { targetTier: "pro" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      success: true,
      effectiveDate: new Date(periodEnd * 1000).toISOString(),
    });
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(scheduleId, {
      end_behavior: "release",
      proration_behavior: "none",
      phases: [
        {
          start_date: periodStart,
          end_date: periodEnd,
          items: [
            { price: TEST_USAGE_PACK_50, quantity: 2 },
            { price: TEST_USAGE_PACK_PLAN_TEAM, quantity: 1 },
          ],
          proration_behavior: "none",
        },
        {
          start_date: periodEnd,
          duration: { interval: "month", interval_count: 1 },
          items: [
            { price: TEST_USAGE_PACK_50, quantity: 2 },
            { price: TEST_USAGE_PACK_PLAN_PRO, quantity: 1 },
          ],
          proration_behavior: "none",
        },
      ],
    });
  });

  it("reuses an existing Stripe schedule when scheduling team to pro", async () => {
    const subId = `sub-team-existing-schedule-${randomUUID().slice(0, 8)}`;
    const periodStart = 1_782_809_751;
    const periodEnd = 1_785_401_751;
    const scheduleId = `sched-existing-${randomUUID().slice(0, 8)}`;
    const fixture = await track(
      store.set(
        seedInvoicesOrg$,
        {
          stripeSubscriptionId: subId,
          subscriptionStatus: "active",
          tier: "team",
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: subId,
      schedule: scheduleId,
      default_payment_method: "pm_card",
      items: {
        data: [
          {
            id: "si_item_1",
            current_period_start: periodStart,
            current_period_end: periodEnd,
            quantity: 1,
            price: {
              id: TEST_PRICE_TEAM,
              recurring: { interval: "month", interval_count: 1 },
            },
          },
        ],
      },
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: scheduleId,
    });

    const client = setupApp({ context, routes: billingDowngradeRoutes })(
      billingDowngradeContract,
    );
    const response = await accept(
      client.create({
        body: { targetTier: "pro" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      success: true,
      effectiveDate: new Date(periodEnd * 1000).toISOString(),
    });
    expect(
      context.mocks.stripe.subscriptionSchedules.create,
    ).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(scheduleId, {
      end_behavior: "release",
      proration_behavior: "none",
      phases: [
        {
          start_date: periodStart,
          end_date: periodEnd,
          items: [{ price: TEST_PRICE_TEAM, quantity: 1 }],
          proration_behavior: "none",
        },
        {
          start_date: periodEnd,
          duration: { interval: "month", interval_count: 1 },
          items: [{ price: TEST_PRICE_PRO, quantity: 1 }],
          proration_behavior: "none",
        },
      ],
    });

    const status = await readBillingStatus();
    expect(status.body.scheduledChange).toStrictEqual({
      type: "downgrade",
      targetTier: "pro",
      effectiveDate: new Date(periodEnd * 1000).toISOString(),
    });
  });

  it("restores a pre-boundary concurrency change and the Team plan independently", async () => {
    const subId = `sub-team-concurrency-pro-${randomUUID().slice(0, 8)}`;
    const customerId = `cus-team-concurrency-pro-${randomUUID().slice(0, 8)}`;
    const scheduleId = `sched-concurrency-pro-${randomUUID().slice(0, 8)}`;
    const periodStart = Math.floor((now() - 86_400 * 1000) / 1000);
    const concurrencyPeriodEnd = Math.floor(
      (now() + 30 * 86_400 * 1000) / 1000,
    );
    const planPeriodEnd = concurrencyPeriodEnd + 30 * 86_400;
    const futureEnd = planPeriodEnd + 30 * 86_400;
    const concurrencyPeriodEndDate = new Date(concurrencyPeriodEnd * 1000);
    const planPeriodEndDate = new Date(planPeriodEnd * 1000);
    const fixture = await track(
      store.set(
        seedInvoicesOrg$,
        {
          stripeCustomerId: customerId,
          stripeSubscriptionId: subId,
          subscriptionStatus: "active",
          tier: "team",
          currentPeriodEnd: planPeriodEndDate,
        },
        context.signal,
      ),
    );
    await postConcurrencyEntitlementsInvoicePaid(context.signal, {
      orgId: fixture.orgId,
      userId: fixture.userId,
      customerId,
      subscriptionId: subId,
      lines: [
        {
          slots: 5,
          startsAt: new Date(periodStart * 1000),
          expiresAt: concurrencyPeriodEndDate,
        },
      ],
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const subscription = {
      id: subId,
      customer: customerId,
      schedule: null,
      pending_update: null,
      default_payment_method: "pm_card",
      discounts: [],
      items: {
        data: [
          {
            id: "si_item_team",
            current_period_start: periodStart,
            current_period_end: planPeriodEnd,
            quantity: 1,
            price: {
              id: TEST_PRICE_TEAM,
              recurring: { interval: "month", interval_count: 1 },
            },
          },
          {
            id: "si_item_concurrency",
            current_period_start: periodStart,
            current_period_end: concurrencyPeriodEnd,
            quantity: 5,
            price: {
              id: TEST_PRICE_CONCURRENCY,
              recurring: { interval: "month", interval_count: 1 },
            },
          },
        ],
      },
    };
    context.mocks.stripe.subscriptions.retrieve.mockReset();
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce(
      subscription,
    );
    context.mocks.stripe.subscriptionSchedules.create.mockReset();
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValueOnce({
      id: scheduleId,
    });
    context.mocks.stripe.subscriptionSchedules.update.mockReset();
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: scheduleId,
    });

    await accept(
      setupApp({
        context,
        routes: billingConcurrencySubscriptionRoutes,
      })(billingConcurrencySubscriptionContract).confirmChange({
        params: { subscriptionId: subId },
        body: { quantity: 3 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
      ...subscription,
      schedule: scheduleId,
    });
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValueOnce({
      id: scheduleId,
      end_behavior: "release",
      current_phase: {
        start_date: periodStart,
        end_date: concurrencyPeriodEnd,
      },
      phases: [
        {
          start_date: periodStart,
          end_date: concurrencyPeriodEnd,
          items: [
            { price: TEST_PRICE_TEAM, quantity: 1 },
            { price: TEST_PRICE_CONCURRENCY, quantity: 5 },
          ],
          proration_behavior: "none",
        },
        {
          start_date: concurrencyPeriodEnd,
          end_date: planPeriodEnd,
          items: [
            { price: TEST_PRICE_TEAM, quantity: 1 },
            { price: TEST_PRICE_CONCURRENCY, quantity: 3 },
          ],
          proration_behavior: "none",
        },
        {
          start_date: planPeriodEnd,
          end_date: futureEnd,
          items: [
            { price: TEST_PRICE_TEAM, quantity: 1 },
            { price: TEST_PRICE_CONCURRENCY, quantity: 3 },
          ],
          proration_behavior: "none",
        },
      ],
    });
    context.mocks.stripe.subscriptionSchedules.update.mockClear();

    const response = await accept(
      setupApp({ context, routes: billingDowngradeRoutes })(
        billingDowngradeContract,
      ).create({
        body: { targetTier: "pro" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      success: true,
      effectiveDate: planPeriodEndDate.toISOString(),
    });
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(scheduleId, {
      end_behavior: "release",
      proration_behavior: "none",
      phases: [
        {
          start_date: periodStart,
          end_date: concurrencyPeriodEnd,
          items: [
            { price: TEST_PRICE_TEAM, quantity: 1 },
            { price: TEST_PRICE_CONCURRENCY, quantity: 5 },
          ],
          proration_behavior: "none",
        },
        {
          start_date: concurrencyPeriodEnd,
          end_date: planPeriodEnd,
          items: [
            { price: TEST_PRICE_TEAM, quantity: 1 },
            { price: TEST_PRICE_CONCURRENCY, quantity: 3 },
          ],
          proration_behavior: "none",
        },
        {
          start_date: planPeriodEnd,
          end_date: futureEnd,
          items: [{ price: TEST_PRICE_PRO, quantity: 1 }],
          proration_behavior: "none",
        },
      ],
    });
    const status = await readBillingStatus();
    expect(status.body.scheduledChange).toStrictEqual({
      type: "downgrade",
      targetTier: "pro",
      effectiveDate: planPeriodEndDate.toISOString(),
    });
    expect(status.body.concurrencySubscriptions[0]?.scheduledQuantity).toBe(3);

    const attachedSubscription = { ...subscription, schedule: scheduleId };
    context.mocks.stripe.subscriptions.retrieve
      .mockResolvedValueOnce(attachedSubscription)
      .mockResolvedValueOnce({
        ...attachedSubscription,
        latest_invoice: null,
      });
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValueOnce({
      id: scheduleId,
      end_behavior: "release",
      current_phase: {
        start_date: periodStart,
        end_date: concurrencyPeriodEnd,
      },
      phases: [
        {
          start_date: periodStart,
          end_date: concurrencyPeriodEnd,
          items: [
            { price: TEST_PRICE_TEAM, quantity: 1 },
            { price: TEST_PRICE_CONCURRENCY, quantity: 5 },
          ],
          proration_behavior: "none",
        },
        {
          start_date: concurrencyPeriodEnd,
          end_date: planPeriodEnd,
          items: [
            { price: TEST_PRICE_TEAM, quantity: 1 },
            { price: TEST_PRICE_CONCURRENCY, quantity: 3 },
          ],
          proration_behavior: "none",
        },
        {
          start_date: planPeriodEnd,
          end_date: futureEnd,
          items: [{ price: TEST_PRICE_PRO, quantity: 1 }],
          proration_behavior: "none",
        },
      ],
    });
    context.mocks.stripe.subscriptionSchedules.update.mockClear();

    const concurrencyRestored = await accept(
      setupApp({
        context,
        routes: billingConcurrencySubscriptionRoutes,
      })(billingConcurrencySubscriptionContract).restore({
        params: { subscriptionId: subId },
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(concurrencyRestored.body).toStrictEqual({ success: true });
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(
      scheduleId,
      {
        end_behavior: "release",
        proration_behavior: "none",
        phases: [
          {
            start_date: periodStart,
            end_date: concurrencyPeriodEnd,
            items: [
              { price: TEST_PRICE_TEAM, quantity: 1 },
              { price: TEST_PRICE_CONCURRENCY, quantity: 5 },
            ],
            proration_behavior: "none",
          },
          {
            start_date: concurrencyPeriodEnd,
            end_date: planPeriodEnd,
            items: [
              { price: TEST_PRICE_TEAM, quantity: 1 },
              { price: TEST_PRICE_CONCURRENCY, quantity: 5 },
            ],
            proration_behavior: "none",
          },
          {
            start_date: planPeriodEnd,
            end_date: futureEnd,
            items: [{ price: TEST_PRICE_PRO, quantity: 1 }],
            proration_behavior: "none",
          },
        ],
      },
      { idempotencyKey: expect.any(String) },
    );
    const concurrencyRestoredStatus = await readBillingStatus();
    expect(concurrencyRestoredStatus.body.scheduledChange).toStrictEqual({
      type: "downgrade",
      targetTier: "pro",
      effectiveDate: planPeriodEndDate.toISOString(),
    });
    expect(
      concurrencyRestoredStatus.body.concurrencySubscriptions[0]
        ?.scheduledQuantity,
    ).toBeUndefined();

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce(
      attachedSubscription,
    );
    context.mocks.stripe.subscriptionSchedules.release.mockClear();
    context.mocks.stripe.subscriptionSchedules.release.mockResolvedValueOnce({
      id: scheduleId,
    });

    const restored = await accept(
      setupApp({ context, routes: billingRestoreRoutes })(
        billingRestoreContract,
      ).create({
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(restored.body).toStrictEqual({ status: "restored" });
    expect(
      context.mocks.stripe.subscriptionSchedules.release,
    ).toHaveBeenCalledWith(scheduleId);
    const restoredStatus = await readBillingStatus();
    expect(restoredStatus.body.scheduledChange).toBeNull();
    expect(restoredStatus.body.concurrencySubscriptions[0]?.quantity).toBe(5);
    expect(
      restoredStatus.body.concurrencySubscriptions[0]?.scheduledQuantity,
    ).toBeUndefined();
  });

  it("returns branded setup checkout URLs when team to pro needs a payment method", async () => {
    const subId = `sub-team-pro-no-card-${randomUUID().slice(0, 8)}`;
    const customerId = `cus-team-pro-${randomUUID().slice(0, 8)}`;
    const periodStart = 1_782_809_751;
    const periodEnd = 1_785_401_751;
    const checkoutUrl = "https://checkout.stripe.com/setup/downgrade";
    const okouFallbackReturnUrl = "https://app.okou.ai";
    const explicitReturnUrl = "https://app.okou.ai/settings?settings=billing";
    const fixture = await track(
      store.set(
        seedInvoicesOrg$,
        {
          stripeCustomerId: customerId,
          stripeSubscriptionId: subId,
          subscriptionStatus: "active",
          tier: "team",
        },
        context.signal,
      ),
    );
    mockEnv("APP_URL", "https://app.okou.ai");
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: subId,
      customer: customerId,
      default_payment_method: null,
      default_source: null,
      discounts: [],
      items: {
        data: [
          {
            id: "si_item_1",
            current_period_start: periodStart,
            current_period_end: periodEnd,
            quantity: 1,
            price: {
              id: TEST_PRICE_TEAM,
              recurring: { interval: "month", interval_count: 1 },
            },
          },
        ],
      },
    });
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      invoice_settings: { default_payment_method: null },
      default_source: null,
    });
    context.mocks.stripe.checkout.sessions.create.mockResolvedValue({
      id: "cs_setup_downgrade",
      url: checkoutUrl,
    });

    const client = setupApp({ context, routes: billingDowngradeRoutes })(
      billingDowngradeContract,
    );
    const response = await accept(
      client.create({
        body: { targetTier: "pro" },
        headers: { authorization: "Bearer clerk-session" },
        extraHeaders: { origin: "https://app.okou.ai" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      status: "payment_method_required",
      checkoutUrl,
    });
    expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith({
      mode: "setup",
      customer: customerId,
      currency: "usd",
      success_url: okouFallbackReturnUrl,
      cancel_url: okouFallbackReturnUrl,
      metadata: {
        purpose: "billing_downgrade",
        orgId: fixture.orgId,
        subscriptionId: subId,
        targetTier: "pro",
      },
      setup_intent_data: {
        metadata: {
          purpose: "billing_downgrade",
          orgId: fixture.orgId,
          subscriptionId: subId,
          targetTier: "pro",
        },
      },
    });
    context.mocks.stripe.checkout.sessions.create.mockClear();
    const explicitResponse = await accept(
      client.create({
        body: { targetTier: "pro", returnUrl: explicitReturnUrl },
        headers: { authorization: "Bearer clerk-session" },
        extraHeaders: { origin: "https://app.okou.ai" },
      }),
      [200],
    );
    expect(explicitResponse.body).toStrictEqual(response.body);
    expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        success_url: explicitReturnUrl,
        cancel_url: explicitReturnUrl,
      }),
    );
    expect(
      context.mocks.stripe.subscriptionSchedules.create,
    ).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).not.toHaveBeenCalled();
  });

  it("downgrades team to limited-free-1 via cancel at period end", async () => {
    const subId = `sub-team-suspend-${randomUUID().slice(0, 8)}`;
    const periodEnd = new Date(now() + 30 * 86_400 * 1000);
    const fixture = await track(
      store.set(
        seedInvoicesOrg$,
        {
          stripeSubscriptionId: subId,
          subscriptionStatus: "active",
          tier: "team",
          currentPeriodEnd: periodEnd,
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const periodStartUnix = Math.floor((now() - 86_400 * 1000) / 1000);
    const periodEndUnix = Math.floor(periodEnd.getTime() / 1000);
    const expectedEffectiveDate = new Date(periodEndUnix * 1000).toISOString();
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: subId,
      schedule: null,
      items: {
        data: [
          {
            id: "si_item_team",
            current_period_start: periodStartUnix,
            current_period_end: periodEndUnix,
            quantity: 1,
            price: {
              id: TEST_PRICE_TEAM,
              recurring: { interval: "month", interval_count: 1 },
            },
          },
        ],
      },
    });
    context.mocks.stripe.subscriptions.update.mockResolvedValue({ id: subId });

    const client = setupApp({ context, routes: billingDowngradeRoutes })(
      billingDowngradeContract,
    );
    const response = await accept(
      client.create({
        body: { targetTier: "limited-free-1" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      success: true,
      effectiveDate: expectedEffectiveDate,
    });
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      subId,
      { cancel_at_period_end: true },
    );
  });

  it("does not delay Team cancellation for a pending concurrency reduction", async () => {
    const subId = `sub-team-concurrency-${randomUUID().slice(0, 8)}`;
    const customerId = `cus-team-concurrency-${randomUUID().slice(0, 8)}`;
    const scheduleId = `sched-concurrency-${randomUUID().slice(0, 8)}`;
    const periodStart = Math.floor((now() - 86_400 * 1000) / 1000);
    const periodEnd = Math.floor((now() + 30 * 86_400 * 1000) / 1000);
    const futureEnd = periodEnd + 30 * 86_400;
    const currentPeriodEnd = new Date(periodEnd * 1000);
    const allowanceCancelAt = currentPeriodEnd.toISOString();
    const fixture = await track(
      store.set(
        seedInvoicesOrg$,
        {
          stripeCustomerId: customerId,
          stripeSubscriptionId: subId,
          subscriptionStatus: "active",
          tier: "team",
          currentPeriodEnd,
        },
        context.signal,
      ),
    );
    await postConcurrencyEntitlementsInvoicePaid(context.signal, {
      orgId: fixture.orgId,
      userId: fixture.userId,
      customerId,
      subscriptionId: subId,
      lines: [
        {
          slots: 5,
          startsAt: new Date(periodStart * 1000),
          expiresAt: currentPeriodEnd,
        },
      ],
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const subscription = {
      id: subId,
      schedule: null,
      pending_update: null,
      metadata: {
        allowanceStatus: "canceled",
        allowanceCancelAt,
      },
      items: {
        data: [
          {
            id: "si_item_team",
            current_period_start: periodStart,
            current_period_end: periodEnd,
            quantity: 1,
            price: {
              id: TEST_PRICE_TEAM,
              recurring: { interval: "month", interval_count: 1 },
            },
          },
          {
            id: "si_item_concurrency",
            current_period_start: periodStart,
            current_period_end: periodEnd,
            quantity: 5,
            price: {
              id: TEST_PRICE_CONCURRENCY,
              recurring: { interval: "month", interval_count: 1 },
            },
          },
        ],
      },
    };
    context.mocks.stripe.subscriptions.retrieve.mockReset();
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce(
      subscription,
    );
    context.mocks.stripe.subscriptionSchedules.create.mockReset();
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValueOnce({
      id: scheduleId,
    });
    context.mocks.stripe.subscriptionSchedules.update.mockReset();
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: scheduleId,
    });

    await accept(
      setupApp({
        context,
        routes: billingConcurrencySubscriptionRoutes,
      })(billingConcurrencySubscriptionContract).confirmChange({
        params: { subscriptionId: subId },
        body: { quantity: 3 },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(
      (await readBillingStatus()).body.concurrencySubscriptions[0]
        ?.scheduledQuantity,
    ).toBe(3);

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
      ...subscription,
      schedule: scheduleId,
    });
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValueOnce({
      id: scheduleId,
      end_behavior: "release",
      current_phase: { start_date: periodStart, end_date: periodEnd },
      phases: [
        {
          start_date: periodStart,
          end_date: periodEnd,
          metadata: { allowanceStatus: "active" },
          items: [
            { price: TEST_PRICE_TEAM, quantity: 1 },
            { price: TEST_PRICE_CONCURRENCY, quantity: 5 },
          ],
          proration_behavior: "none",
        },
        {
          start_date: periodEnd,
          end_date: futureEnd,
          metadata: { allowanceStatus: "active" },
          items: [
            { price: TEST_PRICE_TEAM, quantity: 1 },
            { price: TEST_PRICE_CONCURRENCY, quantity: 3 },
          ],
          proration_behavior: "none",
        },
      ],
    });
    context.mocks.stripe.subscriptionSchedules.update.mockClear();

    const response = await accept(
      setupApp({ context, routes: billingDowngradeRoutes })(
        billingDowngradeContract,
      ).create({
        body: { targetTier: "limited-free-1" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      success: true,
      effectiveDate: currentPeriodEnd.toISOString(),
    });
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(scheduleId, {
      end_behavior: "cancel",
      proration_behavior: "none",
      phases: [
        {
          start_date: periodStart,
          end_date: periodEnd,
          items: [
            { price: TEST_PRICE_TEAM, quantity: 1 },
            { price: TEST_PRICE_CONCURRENCY, quantity: 5 },
          ],
          metadata: {
            allowanceStatus: "canceled",
            allowanceCancelAt,
          },
          proration_behavior: "none",
        },
      ],
    });
    const status = await readBillingStatus();
    expect(status.body.currentPeriodEnd).toBe(currentPeriodEnd.toISOString());
    expect(
      status.body.concurrencySubscriptions[0]?.scheduledQuantity,
    ).toBeUndefined();
    expect(
      status.body.concurrencySubscriptions[0]?.cancelAtPeriodEnd,
    ).toBeFalsy();
  });

  it("cancels a product-backed Custom Plan at period end", async () => {
    const subId = `sub-custom-cancel-${randomUUID().slice(0, 8)}`;
    const periodEnd = new Date(now() + 30 * 86_400 * 1000);
    const fixture = await track(
      store.set(
        seedInvoicesOrg$,
        {
          stripeSubscriptionId: subId,
          subscriptionStatus: "active",
          tier: "custom",
          currentPeriodEnd: periodEnd,
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    mockEnv("OKOU_PRICE_CUSTOM", TEST_PRICE_CUSTOM);

    const periodStartUnix = Math.floor((now() - 86_400 * 1000) / 1000);
    const periodEndUnix = Math.floor(periodEnd.getTime() / 1000);
    const expectedEffectiveDate = new Date(periodEndUnix * 1000).toISOString();
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: subId,
      schedule: null,
      cancel_at: null,
      items: {
        data: [
          {
            id: "si_item_custom",
            current_period_start: periodStartUnix,
            current_period_end: periodEndUnix,
            quantity: 1,
            price: {
              id: TEST_PRICE_CUSTOM,
              recurring: { interval: "month", interval_count: 1 },
            },
          },
        ],
      },
    });
    context.mocks.stripe.subscriptions.update.mockResolvedValue({ id: subId });

    const response = await accept(
      setupApp({ context, routes: billingDowngradeRoutes })(
        billingDowngradeContract,
      ).create({
        body: { targetTier: "limited-free-1" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      success: true,
      effectiveDate: expectedEffectiveDate,
    });
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      subId,
      { cancel_at_period_end: true },
    );
  });

  it("preserves fixed-term team access when cancelling to limited-free-1", async () => {
    const subId = `sub-team-fixed-term-${randomUUID().slice(0, 8)}`;
    const periodStart = 1_782_809_751;
    const periodEnd = 1_785_401_751;
    const finalEnd = 1_790_587_151;
    const finalEndDate = new Date(finalEnd * 1000);
    const fixture = await track(
      store.set(
        seedInvoicesOrg$,
        {
          stripeSubscriptionId: subId,
          subscriptionStatus: "active",
          tier: "team",
          currentPeriodEnd: finalEndDate,
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: subId,
      schedule: null,
      items: {
        data: [
          {
            id: "si_item_team",
            current_period_start: periodStart,
            current_period_end: periodEnd,
            quantity: 1,
            price: {
              id: TEST_PRICE_TEAM,
              recurring: { interval: "month", interval_count: 1 },
            },
          },
        ],
      },
    });
    context.mocks.stripe.subscriptions.update.mockResolvedValue({ id: subId });

    const client = setupApp({ context, routes: billingDowngradeRoutes })(
      billingDowngradeContract,
    );
    const response = await accept(
      client.create({
        body: { targetTier: "limited-free-1" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      success: true,
      effectiveDate: finalEndDate.toISOString(),
    });
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      subId,
      {
        cancel_at: finalEnd,
      },
    );
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).not.toHaveBeenCalled();

    const status = await readBillingStatus();
    expect(status.body.cancelAtPeriodEnd).toBeTruthy();
    expect(status.body.currentPeriodEnd).toBe(finalEndDate.toISOString());
    expect(status.body.scheduledChange).toStrictEqual({
      type: "cancel",
      targetTier: "limited-free-1",
      effectiveDate: finalEndDate.toISOString(),
    });
  });

  it("does not overwrite an existing subscription cancel_at", async () => {
    const subId = `sub-pro-fixed-cancel-${randomUUID().slice(0, 8)}`;
    const periodStart = 1_782_809_751;
    const periodEnd = 1_785_401_751;
    const cancelAt = 1_790_587_151;
    const cancelAtDate = new Date(cancelAt * 1000);
    const fixture = await track(
      store.set(
        seedInvoicesOrg$,
        {
          stripeSubscriptionId: subId,
          subscriptionStatus: "active",
          tier: "pro",
          currentPeriodEnd: new Date(periodEnd * 1000),
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: subId,
      cancel_at: cancelAt,
      schedule: null,
      items: {
        data: [
          {
            id: "si_item_pro",
            current_period_start: periodStart,
            current_period_end: periodEnd,
            quantity: 1,
            price: {
              id: TEST_PRICE_PRO,
              recurring: { interval: "month", interval_count: 1 },
            },
          },
        ],
      },
    });

    const client = setupApp({ context, routes: billingDowngradeRoutes })(
      billingDowngradeContract,
    );
    const response = await accept(
      client.create({
        body: { targetTier: "limited-free-1" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      success: true,
      effectiveDate: cancelAtDate.toISOString(),
    });
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).not.toHaveBeenCalled();

    const status = await readBillingStatus();
    expect(status.body.cancelAtPeriodEnd).toBeTruthy();
    expect(status.body.currentPeriodEnd).toBe(cancelAtDate.toISOString());
    expect(status.body.scheduledChange).toStrictEqual({
      type: "cancel",
      targetTier: "limited-free-1",
      effectiveDate: cancelAtDate.toISOString(),
    });
  });

  it("preserves external schedule phases when cancelling at schedule end", async () => {
    const subId = `sub-pro-external-schedule-${randomUUID().slice(0, 8)}`;
    const scheduleId = `sched-external-${randomUUID().slice(0, 8)}`;
    const periodStart = 1_782_809_751;
    const periodEnd = 1_785_401_751;
    const finalEnd = 1_790_587_151;
    const finalEndDate = new Date(finalEnd * 1000);
    const fixture = await track(
      store.set(
        seedInvoicesOrg$,
        {
          stripeSubscriptionId: subId,
          subscriptionStatus: "active",
          tier: "pro",
          currentPeriodEnd: new Date(periodEnd * 1000),
          pendingSubscriptionScheduleId: scheduleId,
          pendingSubscriptionTargetTier: "pro",
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: subId,
      schedule: scheduleId,
      items: {
        data: [
          {
            id: "si_item_pro",
            current_period_start: periodStart,
            current_period_end: periodEnd,
            quantity: 1,
            price: {
              id: TEST_PRICE_PRO,
              recurring: { interval: "month", interval_count: 1 },
            },
          },
        ],
      },
    });
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue({
      id: scheduleId,
      current_phase: { start_date: periodStart, end_date: finalEnd },
      phases: [
        { start_date: periodStart, end_date: periodEnd },
        { start_date: periodEnd, end_date: finalEnd },
      ],
      end_behavior: "release",
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: scheduleId,
    });

    const client = setupApp({ context, routes: billingDowngradeRoutes })(
      billingDowngradeContract,
    );
    const response = await accept(
      client.create({
        body: { targetTier: "limited-free-1" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      success: true,
      effectiveDate: finalEndDate.toISOString(),
    });
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(scheduleId, {
      end_behavior: "cancel",
      proration_behavior: "none",
    });
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();

    const status = await readBillingStatus();
    expect(status.body.cancelAtPeriodEnd).toBeTruthy();
    expect(status.body.currentPeriodEnd).toBe(finalEndDate.toISOString());
    expect(status.body.scheduledChange).toStrictEqual({
      type: "cancel",
      targetTier: "limited-free-1",
      effectiveDate: finalEndDate.toISOString(),
    });
  });

  it("replaces a pending team to pro schedule with cancellation at period end", async () => {
    const subId = `sub-team-schedule-suspend-${randomUUID().slice(0, 8)}`;
    const scheduleId = `sched-team-suspend-${randomUUID().slice(0, 8)}`;
    const discountId = `di-team-suspend-${randomUUID().slice(0, 8)}`;
    const periodStart = 1_782_809_751;
    const periodEnd = 1_785_401_751;
    const currentPeriodEnd = new Date(periodEnd * 1000);
    const fixture = await track(
      store.set(
        seedInvoicesOrg$,
        {
          stripeSubscriptionId: subId,
          subscriptionStatus: "active",
          tier: "team",
          currentPeriodEnd,
          pendingSubscriptionScheduleId: scheduleId,
          pendingSubscriptionTargetTier: "pro",
          pendingSubscriptionChangeAt: currentPeriodEnd,
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: subId,
      schedule: scheduleId,
      discounts: [discountId],
      items: {
        data: [
          {
            id: "si_item_team",
            current_period_start: periodStart,
            current_period_end: periodEnd,
            quantity: 1,
            price: {
              id: TEST_PRICE_TEAM,
              recurring: { interval: "month", interval_count: 1 },
            },
          },
        ],
      },
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: scheduleId,
    });

    const client = setupApp({ context, routes: billingDowngradeRoutes })(
      billingDowngradeContract,
    );
    const response = await accept(
      client.create({
        body: { targetTier: "limited-free-1" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      success: true,
      effectiveDate: currentPeriodEnd.toISOString(),
    });
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(scheduleId, {
      end_behavior: "cancel",
      proration_behavior: "none",
      phases: [
        {
          start_date: periodStart,
          end_date: periodEnd,
          items: [{ price: TEST_PRICE_TEAM, quantity: 1 }],
          proration_behavior: "none",
          discounts: [{ discount: discountId }],
        },
      ],
    });
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();

    const status = await readBillingStatus();
    expect(status.body.cancelAtPeriodEnd).toBeTruthy();
    expect(status.body.scheduledChange).toStrictEqual({
      type: "cancel",
      targetTier: "limited-free-1",
      effectiveDate: currentPeriodEnd.toISOString(),
    });
  });
});
