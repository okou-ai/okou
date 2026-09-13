import { randomUUID } from "node:crypto";

import {
  testBillingReconciliationStateContract,
  type BillingReconciliationFixtureKind,
  type TestBillingReconciliationStateActionBody,
  type TestBillingReconciliationStateActionResponse,
} from "@okouai/api-contracts/contracts/test-billing-reconciliation-state";
import type StripeSDK from "stripe";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { mockStripeClient } from "../../external/stripe-client";
import { testBillingReconciliationStateRoutes } from "../test-billing-reconciliation-state";

const context = testContext();
const TEST_PRICE_PRO = "price_test_pro";
const TEST_PRICE_TEAM = "price_test_team";
const TEST_PRICE_USAGE_PACK_PRO = "price_test_usage_pack_plan_pro";
const TEST_PRICE_USAGE_PACK_TEAM = "price_test_usage_pack_plan_team";
const TEST_PRICE_USAGE_PACK_20 = "price_usage_pack_usage-pack-subscription";
const TEST_PRICE_CUSTOM = "price_test_custom";
const TEST_PRICE_ATOM_GRANT = "price_test_atom_grant";
const TEST_PRICE_PROMO = "price_test_promo";
const TEST_PROMO_COUPON = "coupon_test_promo";

type FixtureMode = NonNullable<
  Extract<
    TestBillingReconciliationStateActionBody,
    { readonly action: "seed" }
  >["mode"]
>;
type TestPlanTier = "pro" | "team" | "custom";

const TEST_PLAN_CASES = [
  {
    label: "legacy Pro",
    tier: "pro",
    priceId: TEST_PRICE_PRO,
    credits: 20_000,
  },
  {
    label: "legacy Team",
    tier: "team",
    priceId: TEST_PRICE_TEAM,
    credits: 120_000,
  },
  {
    label: "usage-pack Pro",
    tier: "pro",
    priceId: TEST_PRICE_USAGE_PACK_PRO,
    credits: 0,
  },
  {
    label: "usage-pack Team",
    tier: "team",
    priceId: TEST_PRICE_USAGE_PACK_TEAM,
    credits: 0,
  },
  {
    label: "Custom",
    tier: "custom",
    priceId: TEST_PRICE_CUSTOM,
    credits: 0,
  },
] as const satisfies readonly {
  readonly label: string;
  readonly tier: TestPlanTier;
  readonly priceId: string;
  readonly credits: number;
}[];

const INITIAL_STATUSES: readonly (readonly [
  BillingReconciliationFixtureKind,
  string,
])[] = [
  ["plan-subscription", "past_due"],
  ["atom-grant", "atom_grant"],
  ["concurrency", "past_due"],
  ["usage-allowance", "past_due"],
  ["usage-pack-subscription", "checkout_pending"],
  ["usage-pack-subscription-change", "previewed"],
  ["usage-pack-allocation-change", "previewed"],
  ["usage-pack-refund", "pending"],
  ["usage-pack-migration", "previewed"],
  ["usage-pack-invitation", "checkout_pending"],
];

const RECONCILED_STATUSES: readonly (readonly [
  BillingReconciliationFixtureKind,
  string,
])[] = [
  ["plan-subscription", "canceled"],
  ["atom-grant", "expired"],
  ["concurrency", "canceled"],
  ["usage-allowance", "canceled"],
  ["usage-pack-subscription", "checkout_expired"],
  ["usage-pack-subscription-change", "failed"],
  ["usage-pack-allocation-change", "failed"],
  ["usage-pack-refund", "succeeded"],
  ["usage-pack-migration", "failed"],
  ["usage-pack-invitation", "failed"],
];

function apiClient() {
  return setupApp({
    context,
    routes: testBillingReconciliationStateRoutes,
  })(testBillingReconciliationStateContract);
}

async function stateAction(
  body: TestBillingReconciliationStateActionBody,
): Promise<TestBillingReconciliationStateActionResponse> {
  const response = await accept(apiClient().action({ body }), [200]);
  return response.body;
}

async function seedState(marker: string, mode?: FixtureMode) {
  const response = await stateAction({ action: "seed", marker, mode });
  if (response.action !== "seeded") {
    throw new Error("Billing reconciliation state was not seeded");
  }
  return response.fixtures;
}

function paidPlanSubscriptionSnapshot(args: {
  readonly priceId: string;
  readonly orgId: string;
  readonly customerId: string;
  readonly subscriptionId: string;
}) {
  const periodEnd = Math.floor(now() / 1000) + 30 * 86_400;
  const periodStart = periodEnd - 30 * 86_400;
  const invoice = {
    id: `in_${randomUUID()}`,
    customer: args.customerId,
    metadata: {},
    amount_due: 0,
    currency: "usd",
    status: "paid" as const,
    paid: true,
    subtotal: 0,
    parent: {
      subscription_details: {
        subscription: args.subscriptionId,
        metadata: { orgId: args.orgId },
      },
    },
    lines: {
      has_more: false,
      data: [
        {
          id: `il_${randomUUID()}`,
          amount: 0,
          price: { id: args.priceId },
          quantity: 1,
          parent: { type: "subscription_item_details" as const },
          period: { start: periodStart, end: periodEnd },
        },
      ],
    },
  };
  return {
    id: args.subscriptionId,
    customer: args.customerId,
    status: "active",
    metadata: { orgId: args.orgId },
    trial_end: null,
    cancel_at: null,
    cancel_at_period_end: false,
    schedule: null,
    latest_invoice: invoice,
    items: {
      data: [
        {
          id: `si_${randomUUID()}`,
          price: { id: args.priceId },
          quantity: 1,
          current_period_start: periodStart,
          current_period_end: periodEnd,
        },
      ],
    },
  };
}

function paidAtomPlanInvoice(orgId: string) {
  const periodEnd = Math.floor(now() / 1000) + 30 * 86_400;
  return {
    id: `in_${randomUUID()}`,
    customer: `cus_${orgId}`,
    metadata: {
      purpose: "atom_grant",
      type: "atom_grant",
      orgId,
      tier: "team",
      duration: "forever",
      planVersion: "usagePack",
    },
    amount_due: 0,
    currency: "usd",
    status: "paid",
    paid: true,
    subtotal: 0,
    parent: null,
    lines: {
      has_more: false,
      data: [
        {
          id: `il_${randomUUID()}`,
          amount: 0,
          price: { id: TEST_PRICE_ATOM_GRANT },
          quantity: 1,
          parent: null,
          period: { start: periodEnd - 30 * 86_400, end: periodEnd },
        },
      ],
    },
  };
}

async function readState(marker: string) {
  const response = await stateAction({ action: "read", marker });
  if (response.action !== "read") {
    throw new Error("Billing reconciliation state was not read");
  }
  return response.candidates;
}

async function readCreditExpiration(
  marker: string,
  stripeInvoiceId: string,
): Promise<string | null> {
  const response = await stateAction({ action: "read", marker });
  if (response.action !== "read") {
    throw new Error("Billing reconciliation state was not read");
  }
  return (
    response.creditExpirations.find((expiration) => {
      return expiration.stripeInvoiceId === stripeInvoiceId;
    })?.expiresAt ?? null
  );
}

function seededFixture(
  fixtures: Awaited<ReturnType<typeof seedState>>,
  kind: BillingReconciliationFixtureKind,
) {
  const fixture = fixtures.find((candidate) => {
    return candidate.kind === kind;
  });
  if (!fixture) {
    throw new Error(`Missing seeded billing reconciliation fixture ${kind}`);
  }
  return fixture;
}

function statuses(
  candidates: Awaited<ReturnType<typeof readState>>,
): readonly (readonly [BillingReconciliationFixtureKind, string])[] {
  return candidates.map((candidate) => {
    return [candidate.kind, candidate.status] as const;
  });
}

describe("billing entitlement reconciliation", () => {
  it("reconciles every selected candidate class without touching an eligible sentinel", async () => {
    mockStripeClient(context.mocks.stripe as unknown as StripeSDK);
    context.mocks.stripe.subscriptions.retrieve.mockImplementation(
      (subscriptionId) => {
        return Promise.resolve({
          id: subscriptionId,
          status: "canceled",
          cancel_at: null,
          cancel_at_period_end: false,
          metadata: {},
          items: { data: [] },
        });
      },
    );
    context.mocks.stripe.checkout.sessions.retrieve.mockImplementation(
      (checkoutSessionId) => {
        return Promise.resolve({
          id: checkoutSessionId,
          status: "expired",
          subscription: null,
        });
      },
    );
    context.mocks.stripe.refunds.create.mockResolvedValue({
      id: `re_${randomUUID()}`,
      status: "succeeded",
    });

    const selectedMarker = randomUUID();
    const sentinelMarker = randomUUID();
    onTestFinished(async () => {
      await stateAction({ action: "cleanup", marker: selectedMarker });
      await stateAction({ action: "cleanup", marker: sentinelMarker });
    });
    const selectedFixtures = await seedState(selectedMarker);
    await seedState(sentinelMarker);

    expect(statuses(await readState(selectedMarker))).toStrictEqual(
      INITIAL_STATUSES,
    );
    const sentinelBefore = await readState(sentinelMarker);
    expect(statuses(sentinelBefore)).toStrictEqual(INITIAL_STATUSES);

    const response = await accept(
      apiClient().reconcile({
        body: {
          orgIds: selectedFixtures.map((fixture) => {
            return fixture.orgId;
          }),
        },
      }),
      [200],
    );
    expect(response.body).toStrictEqual({ success: true, downgraded: 2 });

    const selected = await readState(selectedMarker);
    expect(statuses(selected)).toStrictEqual(RECONCILED_STATUSES);
    expect(selected[0]).toStrictEqual({
      kind: "plan-subscription",
      orgId: seededFixture(selectedFixtures, "plan-subscription").orgId,
      status: "canceled",
      tier: "limited-free-1",
      credits: 0,
      stripeSubscriptionId: null,
    });
    expect(selected[1]).toStrictEqual({
      kind: "atom-grant",
      orgId: seededFixture(selectedFixtures, "atom-grant").orgId,
      status: "expired",
      tier: "limited-free-1",
      credits: 0,
      stripeSubscriptionId: null,
    });

    await expect(readState(sentinelMarker)).resolves.toStrictEqual(
      sentinelBefore,
    );
  });

  it("keeps a removed shared usage allowance canceled on reconciliation retry", async () => {
    mockStripeClient(context.mocks.stripe as unknown as StripeSDK);
    const marker = randomUUID();
    onTestFinished(async () => {
      await stateAction({ action: "cleanup", marker });
    });
    const fixtures = await seedState(marker);
    const allowance = seededFixture(fixtures, "usage-allowance");
    const futurePeriodEnd = Math.floor(now() / 1000) + 30 * 86_400;
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: allowance.stripeSubscriptionId,
      status: "active",
      cancel_at: null,
      cancel_at_period_end: false,
      metadata: { allowanceStatus: "canceled" },
      items: {
        data: [
          {
            price: { id: "price_shared_custom_plan" },
            current_period_end: futurePeriodEnd,
          },
        ],
      },
    });

    const response = await accept(
      apiClient().reconcile({ body: { orgIds: [allowance.orgId] } }),
      [200],
    );
    expect(response.body).toStrictEqual({ success: true, downgraded: 0 });

    const candidate = (await readState(marker)).find((row) => {
      return row.kind === "usage-allowance";
    });
    expect(candidate).toStrictEqual({
      kind: "usage-allowance",
      orgId: allowance.orgId,
      status: "canceled",
      tier: null,
      credits: null,
      stripeSubscriptionId: allowance.stripeSubscriptionId,
    });
  });

  it("recovers canceled or missing Stripe subscriptions after missed webhooks", async () => {
    mockStripeClient(context.mocks.stripe as unknown as StripeSDK);
    const marker = randomUUID();
    onTestFinished(async () => {
      await stateAction({ action: "cleanup", marker });
    });
    const fixtures = await seedState(marker, "active");
    const selectedKinds = [
      "plan-subscription",
      "concurrency",
      "usage-allowance",
      "usage-pack-subscription",
    ] as const;
    const selected = selectedKinds.map((kind) => {
      return seededFixture(fixtures, kind);
    });
    const [plan, concurrency, allowance, usagePack] = selected;
    if (!plan || !concurrency || !allowance || !usagePack) {
      throw new Error("Expected all active subscription fixtures");
    }
    context.mocks.stripe.subscriptions.retrieve.mockImplementation(
      (subscriptionId) => {
        if (subscriptionId === plan.stripeSubscriptionId) {
          return Promise.reject(
            Object.assign(new Error("Subscription not found"), {
              code: "resource_missing",
            }),
          );
        }
        return Promise.resolve({
          id: subscriptionId,
          status: "canceled",
          cancel_at: null,
          cancel_at_period_end: false,
          metadata: {},
          items: { data: [] },
        });
      },
    );

    const response = await accept(
      apiClient().reconcile({
        body: {
          orgIds: selected.map((fixture) => {
            return fixture.orgId;
          }),
        },
      }),
      [200],
    );
    expect(response.body).toStrictEqual({ success: true, downgraded: 1 });

    const reconciled = await readState(marker);
    expect(
      selectedKinds.map((kind) => {
        return reconciled.find((candidate) => {
          return candidate.kind === kind;
        });
      }),
    ).toStrictEqual([
      {
        kind: "plan-subscription",
        orgId: plan.orgId,
        status: "canceled",
        tier: "limited-free-1",
        credits: 0,
        stripeSubscriptionId: null,
      },
      {
        kind: "concurrency",
        orgId: concurrency.orgId,
        status: "canceled",
        tier: null,
        credits: null,
        stripeSubscriptionId: concurrency.stripeSubscriptionId,
      },
      {
        kind: "usage-allowance",
        orgId: allowance.orgId,
        status: "canceled",
        tier: null,
        credits: null,
        stripeSubscriptionId: allowance.stripeSubscriptionId,
      },
      {
        kind: "usage-pack-subscription",
        orgId: usagePack.orgId,
        status: "canceled",
        tier: null,
        credits: null,
        stripeSubscriptionId: usagePack.stripeSubscriptionId,
      },
    ]);
  });

  it.each(TEST_PLAN_CASES)(
    "discovers an unbound $label subscription and replays its paid invoice",
    async ({ tier, priceId, credits }) => {
      mockStripeClient(context.mocks.stripe as unknown as StripeSDK);
      mockEnv("OKOU_PRICE_PRO", TEST_PRICE_PRO);
      mockEnv("OKOU_PRICE_TEAM", TEST_PRICE_TEAM);
      mockEnv("OKOU_PRICE_USAGE_PACK_PLAN_PRO", TEST_PRICE_USAGE_PACK_PRO);
      mockEnv("OKOU_PRICE_USAGE_PACK_PLAN_TEAM", TEST_PRICE_USAGE_PACK_TEAM);
      mockEnv("OKOU_PRICE_CUSTOM", TEST_PRICE_CUSTOM);
      const marker = randomUUID();
      onTestFinished(async () => {
        await stateAction({ action: "cleanup", marker });
      });
      const fixtures = await seedState(marker, "unbound");
      const plan = seededFixture(fixtures, "plan-subscription");
      if (!plan.stripeSubscriptionId) {
        throw new Error("Plan fixture requires its expected subscription ID");
      }
      const customerId = `cus_${plan.orgId}`;
      const subscription = paidPlanSubscriptionSnapshot({
        priceId,
        orgId: plan.orgId,
        customerId,
        subscriptionId: plan.stripeSubscriptionId,
      });
      context.mocks.stripe.subscriptions.list.mockResolvedValue({
        data: [subscription],
        has_more: false,
      });
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
        subscription,
      );

      const response = await accept(
        apiClient().reconcile({ body: { orgIds: [plan.orgId] } }),
        [200],
      );
      expect(response.body).toStrictEqual({ success: true, downgraded: 0 });

      const reconciled = (await readState(marker)).find((candidate) => {
        return candidate.kind === "plan-subscription";
      });
      expect(reconciled).toStrictEqual({
        kind: "plan-subscription",
        orgId: plan.orgId,
        status: "active",
        tier,
        credits,
        stripeSubscriptionId: plan.stripeSubscriptionId,
      });
    },
  );

  it("deactivates usage packs removed from a shared Custom subscription", async () => {
    mockStripeClient(context.mocks.stripe as unknown as StripeSDK);
    mockEnv(
      "OKOU_PRICE_USAGE_PACK_PLAN_PRO",
      "price_plan_usage-pack-subscription",
    );
    mockEnv("OKOU_PRICE_USAGE_PACK_20", TEST_PRICE_USAGE_PACK_20);
    mockEnv("OKOU_PRICE_CUSTOM", TEST_PRICE_CUSTOM);
    const marker = randomUUID();
    onTestFinished(async () => {
      await stateAction({ action: "cleanup", marker });
    });
    const fixtures = await seedState(marker, "active");
    const usagePack = seededFixture(fixtures, "usage-pack-subscription");
    if (!usagePack.stripeSubscriptionId) {
      throw new Error("Usage pack fixture requires a subscription ID");
    }
    const customerId = `cus_usage-pack-subscription_${usagePack.orgId}`;
    const periodEnd = Math.floor(now() / 1000) + 30 * 86_400;
    const subscription = {
      id: usagePack.stripeSubscriptionId,
      customer: customerId,
      status: "active",
      metadata: { orgId: usagePack.orgId },
      trial_end: null,
      cancel_at: null,
      cancel_at_period_end: false,
      schedule: null,
      latest_invoice: null,
      items: {
        data: [
          {
            id: `si_${randomUUID()}`,
            price: { id: TEST_PRICE_CUSTOM },
            quantity: 1,
            current_period_start: periodEnd - 30 * 86_400,
            current_period_end: periodEnd,
          },
        ],
      },
    };
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      metadata: { orgId: usagePack.orgId },
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(subscription);

    const response = await accept(
      apiClient().reconcile({ body: { orgIds: [usagePack.orgId] } }),
      [200],
    );
    expect(response.body).toStrictEqual({ success: true, downgraded: 0 });

    const reconciled = (await readState(marker)).find((candidate) => {
      return candidate.kind === "usage-pack-subscription";
    });
    expect(reconciled).toStrictEqual({
      kind: "usage-pack-subscription",
      orgId: usagePack.orgId,
      status: "canceled",
      tier: null,
      credits: null,
      stripeSubscriptionId: usagePack.stripeSubscriptionId,
    });
  });

  it("continues after individual Stripe subscription failures", async () => {
    mockStripeClient(context.mocks.stripe as unknown as StripeSDK);
    mockEnv("OKOU_PRICE_PRO", TEST_PRICE_PRO);
    const retrievalMarker = randomUUID();
    const projectionMarker = randomUUID();
    const canceledMarker = randomUUID();
    onTestFinished(async () => {
      await stateAction({ action: "cleanup", marker: retrievalMarker });
      await stateAction({ action: "cleanup", marker: projectionMarker });
      await stateAction({ action: "cleanup", marker: canceledMarker });
    });
    const retrievalPlan = seededFixture(
      await seedState(retrievalMarker, "stale"),
      "plan-subscription",
    );
    const projectionPlan = seededFixture(
      await seedState(projectionMarker, "active"),
      "plan-subscription",
    );
    const canceledPlan = seededFixture(
      await seedState(canceledMarker, "active"),
      "plan-subscription",
    );
    if (
      !retrievalPlan.stripeSubscriptionId ||
      !projectionPlan.stripeSubscriptionId ||
      !canceledPlan.stripeSubscriptionId
    ) {
      throw new Error("Plan fixtures require subscription IDs");
    }
    const projectionSnapshot = {
      ...paidPlanSubscriptionSnapshot({
        priceId: TEST_PRICE_PRO,
        orgId: projectionPlan.orgId,
        customerId: `cus_${projectionPlan.orgId}`,
        subscriptionId: projectionPlan.stripeSubscriptionId,
      }),
      schedule: "sub_sched_transient_failure",
      latest_invoice: null,
    };
    context.mocks.stripe.subscriptions.retrieve.mockImplementation(
      (subscriptionId) => {
        if (subscriptionId === retrievalPlan.stripeSubscriptionId) {
          return Promise.reject(new Error("temporary subscription failure"));
        }
        if (subscriptionId === projectionPlan.stripeSubscriptionId) {
          return Promise.resolve(projectionSnapshot);
        }
        if (subscriptionId === canceledPlan.stripeSubscriptionId) {
          return Promise.resolve({
            id: subscriptionId,
            status: "canceled",
            cancel_at: null,
            cancel_at_period_end: false,
            metadata: {},
            items: { data: [] },
          });
        }
        return Promise.reject(
          new Error(`Unexpected subscription ${subscriptionId}`),
        );
      },
    );
    context.mocks.stripe.subscriptionSchedules.retrieve.mockRejectedValue(
      new Error("temporary schedule failure"),
    );
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: `cus_${projectionPlan.orgId}`,
      metadata: { orgId: projectionPlan.orgId },
    });

    const response = await accept(
      apiClient().reconcile({
        body: {
          orgIds: [
            retrievalPlan.orgId,
            projectionPlan.orgId,
            canceledPlan.orgId,
          ],
        },
      }),
      [200],
    );
    expect(response.body).toStrictEqual({ success: true, downgraded: 1 });

    await expect(readState(retrievalMarker)).resolves.toContainEqual({
      kind: "plan-subscription",
      orgId: retrievalPlan.orgId,
      status: "past_due",
      tier: "pro",
      credits: 0,
      stripeSubscriptionId: retrievalPlan.stripeSubscriptionId,
    });
    await expect(readState(projectionMarker)).resolves.toContainEqual({
      kind: "plan-subscription",
      orgId: projectionPlan.orgId,
      status: "active",
      tier: "pro",
      credits: 0,
      stripeSubscriptionId: projectionPlan.stripeSubscriptionId,
    });
    await expect(readState(canceledMarker)).resolves.toContainEqual({
      kind: "plan-subscription",
      orgId: canceledPlan.orgId,
      status: "canceled",
      tier: "limited-free-1",
      credits: 0,
      stripeSubscriptionId: null,
    });
  });

  it("expires an Atom grant", async () => {
    mockStripeClient(context.mocks.stripe as unknown as StripeSDK);
    const marker = randomUUID();
    onTestFinished(async () => {
      await stateAction({ action: "cleanup", marker });
    });
    const atom = seededFixture(await seedState(marker), "atom-grant");

    const response = await accept(
      apiClient().reconcile({ body: { orgIds: [atom.orgId] } }),
      [200],
    );

    expect(response.body).toStrictEqual({ success: true, downgraded: 1 });
    await expect(readState(marker)).resolves.toContainEqual({
      kind: "atom-grant",
      orgId: atom.orgId,
      status: "expired",
      tier: "limited-free-1",
      credits: 0,
      stripeSubscriptionId: null,
    });
  });

  it("idempotently replays an undelivered Atom usage-pack plan invoice", async () => {
    mockStripeClient(context.mocks.stripe as unknown as StripeSDK);
    mockEnv("ATOM_GRANT_PRICE", TEST_PRICE_ATOM_GRANT);
    const marker = randomUUID();
    onTestFinished(async () => {
      await stateAction({ action: "cleanup", marker });
    });
    const fixtures = await seedState(marker, "unbound");
    const atom = seededFixture(fixtures, "atom-grant");
    const invoice = paidAtomPlanInvoice(atom.orgId);
    const eventId = `evt_${randomUUID()}`;
    context.mocks.stripe.events.list.mockResolvedValue({
      data: [
        {
          id: eventId,
          type: "invoice.paid",
          created: Math.floor(now() / 1000),
          data: { object: invoice },
        },
      ],
      has_more: false,
    });
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [],
      has_more: false,
    });

    for (let replay = 0; replay < 2; replay += 1) {
      const response = await accept(
        apiClient().reconcile({
          body: {
            orgIds: [atom.orgId],
            replayUndeliveredPaidInvoices: true,
          },
        }),
        [200],
      );
      expect(response.body).toStrictEqual({ success: true, downgraded: 0 });
    }
    expect(context.mocks.stripe.events.list).toHaveBeenCalledWith({
      delivery_success: false,
      type: "invoice.paid",
      limit: 100,
    });

    const reconciled = (await readState(marker)).find((candidate) => {
      return candidate.kind === "atom-grant";
    });
    expect(reconciled).toStrictEqual({
      kind: "atom-grant",
      orgId: atom.orgId,
      status: "atom_grant",
      tier: "team",
      credits: 0,
      stripeSubscriptionId: null,
    });
  });

  it("continues with the next paid invoice after a failed invoice replay", async () => {
    mockStripeClient(context.mocks.stripe as unknown as StripeSDK);
    mockEnv("OKOU_PRICE_PRO", TEST_PRICE_PRO);
    mockEnv("ATOM_GRANT_PRICE", TEST_PRICE_ATOM_GRANT);
    const marker = randomUUID();
    onTestFinished(async () => {
      await stateAction({ action: "cleanup", marker });
    });
    const fixtures = await seedState(marker, "unbound");
    const plan = seededFixture(fixtures, "plan-subscription");
    const atom = seededFixture(fixtures, "atom-grant");
    if (!plan.stripeSubscriptionId) {
      throw new Error("Plan fixture requires its expected subscription ID");
    }
    const failedInvoice = paidPlanSubscriptionSnapshot({
      priceId: TEST_PRICE_PRO,
      orgId: plan.orgId,
      customerId: `cus_${plan.orgId}`,
      subscriptionId: plan.stripeSubscriptionId,
    }).latest_invoice;
    const failedEventId = `evt_${randomUUID()}`;
    const failure = new Error("temporary Stripe subscription failure");
    context.mocks.stripe.subscriptions.retrieve.mockRejectedValue(failure);
    context.mocks.stripe.events.list.mockResolvedValue({
      data: [
        {
          id: failedEventId,
          type: "invoice.paid",
          created: Math.floor(now() / 1000) - 1,
          data: { object: failedInvoice },
        },
        {
          id: `evt_${randomUUID()}`,
          type: "invoice.paid",
          created: Math.floor(now() / 1000),
          data: { object: paidAtomPlanInvoice(atom.orgId) },
        },
      ],
      has_more: false,
    });

    const response = await accept(
      apiClient().reconcile({
        body: {
          orgIds: [plan.orgId, atom.orgId],
          replayUndeliveredPaidInvoices: true,
        },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ success: true, downgraded: 0 });
    await expect(readState(marker)).resolves.toContainEqual({
      kind: "plan-subscription",
      orgId: plan.orgId,
      status: "missing",
      tier: "limited-free-1",
      credits: 0,
      stripeSubscriptionId: null,
    });
    await expect(readState(marker)).resolves.toContainEqual({
      kind: "atom-grant",
      orgId: atom.orgId,
      status: "atom_grant",
      tier: "team",
      credits: 0,
      stripeSubscriptionId: null,
    });
  });

  it("leaves another preview's paid invoice untouched", async () => {
    mockStripeClient(context.mocks.stripe as unknown as StripeSDK);
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [],
      has_more: false,
    });
    mockEnv("ENV", "preview");
    mockOptionalEnv("OKOU_PREVIEW_JOB_REF", `pr-${randomUUID()}`);
    mockOptionalEnv("USE_MOCK_CLAUDE", "true");
    mockOptionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET", randomUUID());
    const marker = randomUUID();
    onTestFinished(async () => {
      await stateAction({ action: "cleanup", marker });
    });
    const atom = seededFixture(
      await seedState(marker, "unbound"),
      "atom-grant",
    );
    const before = await readState(marker);
    const invoice = paidAtomPlanInvoice(atom.orgId);
    context.mocks.stripe.events.list.mockResolvedValue({
      data: [
        {
          id: `evt_${randomUUID()}`,
          type: "invoice.paid",
          created: Math.floor(now() / 1000),
          data: {
            object: {
              ...invoice,
              metadata: {
                ...invoice.metadata,
                vm0_environment: "preview",
                job_ref: `pr-${randomUUID()}`,
              },
            },
          },
        },
      ],
      has_more: false,
    });

    const response = await accept(
      apiClient().reconcile({
        body: {
          orgIds: [atom.orgId],
          replayUndeliveredPaidInvoices: true,
        },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ success: true, downgraded: 0 });
    await expect(readState(marker)).resolves.toStrictEqual(before);
  });

  it("idempotently replays an undelivered paid one-time campaign Checkout", async () => {
    mockStripeClient(context.mocks.stripe as unknown as StripeSDK);
    mockEnv(
      "OKOU_ONE_TIME_CAMPAIGN",
      JSON.stringify({
        ZERO100: {
          priceId: TEST_PRICE_PROMO,
          couponId: TEST_PROMO_COUPON,
        },
      }),
    );
    const marker = randomUUID();
    onTestFinished(async () => {
      await stateAction({ action: "cleanup", marker });
    });
    const fixtures = await seedState(marker, "unbound");
    const promo = seededFixture(fixtures, "atom-grant");
    const session = {
      id: `cs_${randomUUID()}`,
      status: "complete",
      mode: "payment",
      invoice: null,
      subscription: null,
      customer: `cus_${promo.orgId}`,
      payment_intent: `pi_${randomUUID()}`,
      metadata: {
        purpose: "one_time_purchase",
        orgId: promo.orgId,
        campaignKey: "ZERO100",
      },
      amount_subtotal: 0,
      amount_total: 0,
      payment_status: "paid",
      currency: "usd",
    };
    const eventId = `evt_${randomUUID()}`;
    const paidAtSeconds = Math.floor(now() / 1000) - 2 * 86_400;
    context.mocks.stripe.events.list.mockImplementation((params) => {
      const type = (params as { readonly type?: string }).type;
      return Promise.resolve(
        type === "checkout.session.completed"
          ? {
              data: [
                {
                  id: eventId,
                  type,
                  created: paidAtSeconds,
                  data: { object: session },
                },
              ],
              has_more: false,
            }
          : { data: [], has_more: false },
      );
    });

    for (let replay = 0; replay < 2; replay += 1) {
      const response = await accept(
        apiClient().reconcile({
          body: {
            orgIds: [promo.orgId],
            replayUndeliveredPaidCheckouts: true,
          },
        }),
        [200],
      );
      expect(response.body).toStrictEqual({ success: true, downgraded: 0 });
    }
    expect(context.mocks.stripe.events.list).toHaveBeenCalledWith({
      delivery_success: false,
      type: "checkout.session.completed",
      limit: 100,
    });

    const reconciled = (await readState(marker)).find((candidate) => {
      return candidate.kind === "atom-grant";
    });
    expect(reconciled).toStrictEqual({
      kind: "atom-grant",
      orgId: promo.orgId,
      status: "missing",
      tier: "limited-free-1",
      credits: 100_000,
      stripeSubscriptionId: null,
    });
    await expect(readCreditExpiration(marker, session.id)).resolves.toBe(
      new Date((paidAtSeconds + 30 * 86_400) * 1000).toISOString(),
    );
  });
});
