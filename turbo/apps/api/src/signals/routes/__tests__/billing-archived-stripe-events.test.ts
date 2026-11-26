import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();
const bdd = createBddApi(context);

const RETIRED_PRICE = "price_bdd_atom_grant";
const DAY_SECONDS = 86_400;

type StripeObject = Readonly<Record<string, unknown>>;

function stripeId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 12)}`;
}

function nowSeconds(): number {
  return Math.floor(now() / 1000);
}

/** A workspace whose admin holds an active paid Pro Plan through Stripe. */
async function proWorkspace() {
  const admin = bdd.user();
  await bdd.bootstrapLimitedFreeOnboarding(admin);
  const webhooks = createWebhookCallbackApi(context);
  webhooks.configureStripeBillingEnv();
  const runs = createRunsApi(context);
  const customerId = stripeId("cus");
  const subscriptionId = stripeId("sub");
  context.mocks.stripe.customers.retrieve.mockResolvedValue({
    id: customerId,
    metadata: { orgId: admin.orgId },
  });

  async function deliver(
    type: string,
    object: StripeObject,
    status: 200 | 500 = 200,
  ) {
    const response = await webhooks.postStripeEvent(
      {
        id: stripeId("evt"),
        type,
        created: nowSeconds(),
        data: { object },
      },
      [status],
    );
    await flushWaitUntilForTest();
    return response.status;
  }

  const planSubscription = {
    id: subscriptionId,
    customer: customerId,
    status: "active",
    metadata: {},
    cancel_at_period_end: false,
    cancel_at: null,
    schedule: null,
    trial_end: null,
    items: { data: [{ price: { id: "price_bdd_pro" } }] },
  };
  await deliver("customer.subscription.created", planSubscription);
  await deliver("customer.subscription.updated", planSubscription);

  const readStatus = async () => {
    return await runs.readBillingStatus(admin);
  };
  const before = await readStatus();
  expect(before).toMatchObject({ tier: "pro", status: "active" });

  const stripe = context.mocks.stripe;
  const subscriptionCalls = () => {
    return {
      retrieve: stripe.subscriptions.retrieve.mock.calls.length,
      update: stripe.subscriptions.update.mock.calls.length,
      cancel: stripe.subscriptions.cancel.mock.calls.length,
    };
  };

  return {
    admin,
    customerId,
    subscriptionId,
    before,
    deliver,
    readStatus,
    subscriptionCalls,
  };
}

type ProWorkspace = Awaited<ReturnType<typeof proWorkspace>>;

function creditPurchaseMetadata(orgId: string | null) {
  return {
    type: "credit_purchase",
    orgId: orgId ?? "",
    creditsAmount: "900000",
    creditsExpiresAt: new Date(now() + 90 * DAY_SECONDS * 1000).toISOString(),
  };
}

/** A zero-amount invoice for one retired subscription line. */
function retiredSubscriptionInvoice(
  workspace: ProWorkspace,
  metadata: Readonly<Record<string, string>>,
  subscriptionMetadata: Readonly<Record<string, string>>,
) {
  const start = nowSeconds();
  return {
    id: stripeId("in"),
    customer: workspace.customerId,
    subtotal: 0,
    metadata: {
      ...creditPurchaseMetadata(workspace.admin.orgId),
      ...metadata,
    },
    parent: {
      subscription_details: {
        subscription: workspace.subscriptionId,
        metadata: subscriptionMetadata,
      },
    },
    lines: {
      has_more: false,
      data: [
        {
          id: stripeId("il"),
          price: { id: RETIRED_PRICE },
          quantity: 1,
          parent: { type: "subscription_item_details" },
          period: { start, end: start + 30 * DAY_SECONDS },
        },
      ],
    },
  };
}

async function replayTwice(
  workspace: ProWorkspace,
  invoice: StripeObject,
  status: 200 | 500 = 200,
) {
  const calls = workspace.subscriptionCalls();
  const deliveries = [
    await workspace.deliver("invoice.paid", invoice, status),
    await workspace.deliver("invoice.paid", invoice, status),
  ];
  const after = workspace.subscriptionCalls();
  return {
    deliveries,
    billing: await workspace.readStatus(),
    subscriptionCalls: {
      retrieve: after.retrieve - calls.retrieve,
      update: after.update - calls.update,
      cancel: after.cancel - calls.cancel,
    },
  };
}

/** Both deliveries answer `status`; billing and the Stripe subscription stay untouched. */
function unchangedReplay(workspace: ProWorkspace, status: 200 | 500 = 200) {
  return {
    deliveries: [status, status],
    billing: workspace.before,
    subscriptionCalls: { retrieve: 0, update: 0, cancel: 0 },
  };
}

/** The workspace's own subscription, carrying an archived purpose and a Plan price. */
function archivedPurposeSubscription(
  workspace: ProWorkspace,
  status: "active" | "canceled",
) {
  const start = nowSeconds();
  return {
    id: workspace.subscriptionId,
    customer: workspace.customerId,
    status,
    metadata: { purpose: "usage_allowance" },
    cancel_at_period_end: false,
    cancel_at: null,
    schedule: null,
    trial_end: null,
    items: {
      data: [
        {
          id: stripeId("si"),
          price: { id: "price_bdd_team" },
          quantity: 1,
          current_period_start: start,
          current_period_end: start + 30 * DAY_SECONDS,
        },
      ],
    },
  };
}

/** A zero-amount invoice-item invoice with one line and no subscription parent. */
function invoiceItemInvoice(
  workspace: ProWorkspace,
  line: Readonly<Record<string, unknown>>,
) {
  const start = nowSeconds();
  return {
    id: stripeId("in"),
    customer: workspace.customerId,
    subtotal: 0,
    metadata: creditPurchaseMetadata(workspace.admin.orgId),
    parent: null,
    lines: {
      has_more: false,
      data: [
        {
          id: stripeId("il"),
          quantity: 1,
          parent: { type: "invoice_item_details" },
          period: { start, end: start + 30 * DAY_SECONDS },
          ...line,
        },
      ],
    },
  };
}

function archivedProduct() {
  return {
    id: stripeId("prod"),
    object: "product",
    metadata: { purpose: "usage_allowance" },
  };
}

function stripeError(
  message: string,
  fields: Readonly<Record<string, unknown>>,
) {
  return Object.assign(new Error(message), fields);
}

interface MixedInvoiceOptions {
  readonly invoiceMetadata?: Readonly<Record<string, string>>;
  readonly retiredLineMetadata?: Readonly<Record<string, string>>;
  readonly retiredPriceLookup?: () => Promise<unknown>;
}

/**
 * The Plan subscription carries a retired item ending in 7 days plus Pro and
 * concurrency items ending in 45 days; its zero-amount invoice bills all three.
 */
function mixedPlanInvoice(
  workspace: ProWorkspace,
  options: MixedInvoiceOptions,
) {
  const start = nowSeconds();
  const retiredEnd = start + 7 * DAY_SECONDS;
  const planEnd = start + 45 * DAY_SECONDS;
  const items = [
    { price: RETIRED_PRICE, quantity: 1, end: retiredEnd },
    { price: "price_bdd_pro", quantity: 1, end: planEnd },
    { price: "price_bdd_concurrency", quantity: 3, end: planEnd },
  ];
  const subscription = {
    id: workspace.subscriptionId,
    customer: workspace.customerId,
    status: "active",
    metadata: {},
    cancel_at_period_end: false,
    cancel_at: null,
    schedule: null,
    trial_end: null,
    items: {
      data: items.map((item) => {
        return {
          id: stripeId("si"),
          price: { id: item.price },
          quantity: item.quantity,
          current_period_start: start,
          current_period_end: item.end,
        };
      }),
    },
  };
  context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(subscription);
  context.mocks.stripe.prices.retrieve.mockImplementation((priceId) => {
    if (priceId === RETIRED_PRICE && options.retiredPriceLookup) {
      return options.retiredPriceLookup();
    }
    return Promise.resolve({
      id: priceId,
      product: { id: stripeId("prod"), object: "product", metadata: {} },
    });
  });
  const invoice = {
    id: stripeId("in"),
    customer: workspace.customerId,
    subtotal: 900_000,
    amount_paid: 0,
    metadata: options.invoiceMetadata ?? {},
    parent: {
      subscription_details: {
        subscription: workspace.subscriptionId,
        metadata: {},
      },
    },
    lines: {
      has_more: false,
      data: items.map((item) => {
        return {
          id: stripeId("il"),
          price: { id: item.price },
          quantity: item.quantity,
          metadata:
            item.price === RETIRED_PRICE
              ? (options.retiredLineMetadata ?? {})
              : {},
          parent: { type: "subscription_item_details" },
          period: { start, end: item.end },
        };
      }),
    },
  };
  return {
    invoice,
    subscription,
    planEnd: new Date(planEnd * 1000).toISOString(),
  };
}

/** Delivers the mixed invoice twice, then marks the Plan to cancel at period end. */
async function deliverMixedInvoiceThenCancel(options: MixedInvoiceOptions) {
  const workspace = await proWorkspace();
  const mixed = mixedPlanInvoice(workspace, options);
  const deliveries = [
    await workspace.deliver("invoice.paid", mixed.invoice),
    await workspace.deliver("invoice.paid", mixed.invoice),
  ];
  const granted = await workspace.readStatus();
  const cancelDelivery = await workspace.deliver(
    "customer.subscription.updated",
    { ...mixed.subscription, cancel_at_period_end: true },
  );
  const cancelling = await workspace.readStatus();
  return {
    planEnd: mixed.planEnd,
    subscriptionId: workspace.subscriptionId,
    observed: {
      deliveries,
      creditsAdded: granted.credits - workspace.before.credits,
      tier: granted.tier,
      currentPeriodEnd: granted.currentPeriodEnd,
      concurrencySubscriptions: granted.concurrencySubscriptions.map((item) => {
        return { id: item.id, quantity: item.quantity };
      }),
      cancelDelivery,
      periodEndAfterCancel: cancelling.currentPeriodEnd,
      creditsAddedByCancel: cancelling.credits - granted.credits,
    },
  };
}

/** Only the Pro Plan grant and the 3-slot concurrency item survive the mixed invoice. */
function planAndConcurrencyOnly(outcome: {
  readonly planEnd: string;
  readonly subscriptionId: string;
}) {
  return {
    deliveries: [200, 200],
    creditsAdded: 20_000,
    tier: "pro",
    currentPeriodEnd: outcome.planEnd,
    concurrencySubscriptions: [{ id: outcome.subscriptionId, quantity: 3 }],
    cancelDelivery: 200,
    periodEndAfterCancel: outcome.planEnd,
    creditsAddedByCancel: 0,
  };
}

async function deliverArchivedSubscriptionEvent(
  type:
    | "customer.subscription.created"
    | "customer.subscription.updated"
    | "customer.subscription.deleted",
  status: "active" | "canceled",
) {
  const workspace = await proWorkspace();
  const retrieve = context.mocks.stripe.subscriptions.retrieve;
  const retrieved = retrieve.mock.calls.length;
  const delivery = await workspace.deliver(
    type,
    archivedPurposeSubscription(workspace, status),
  );
  return {
    before: workspace.before,
    observed: {
      delivery,
      billing: await workspace.readStatus(),
      subscriptionRetrievals: retrieve.mock.calls.length - retrieved,
    },
  };
}

describe("Stripe billing purpose isolation", () => {
  it("billing-archived-stripe-events-001 keeps the paid Plan when an invoice with an archived invoice purpose is replayed", async () => {
    const workspace = await proWorkspace();

    await expect(
      replayTwice(
        workspace,
        retiredSubscriptionInvoice(
          workspace,
          { purpose: "usage_allowance" },
          {},
        ),
      ),
    ).resolves.toStrictEqual(unchangedReplay(workspace));
  });

  it("billing-archived-stripe-events-002 keeps the paid Plan when an invoice with an archived subscription purpose is replayed", async () => {
    const workspace = await proWorkspace();

    await expect(
      replayTwice(
        workspace,
        retiredSubscriptionInvoice(
          workspace,
          {},
          { purpose: "usage_allowance" },
        ),
      ),
    ).resolves.toStrictEqual(unchangedReplay(workspace));
  });

  it("billing-archived-stripe-events-003 keeps the paid Plan when an invoice with an archived source is replayed", async () => {
    const workspace = await proWorkspace();

    await expect(
      replayTwice(
        workspace,
        retiredSubscriptionInvoice(
          workspace,
          { source: "atom_usage_allowance" },
          {},
        ),
      ),
    ).resolves.toStrictEqual(unchangedReplay(workspace));
  });

  it("billing-archived-stripe-events-004 keeps the paid Plan when an invoice with the Custom purpose is replayed", async () => {
    const workspace = await proWorkspace();

    await expect(
      replayTwice(
        workspace,
        retiredSubscriptionInvoice(
          workspace,
          { purpose: "custom_plan_subscription" },
          {},
        ),
      ),
    ).resolves.toStrictEqual(unchangedReplay(workspace));
  });

  it("billing-archived-stripe-events-008 keeps the paid Plan when an archived-purpose subscription is created with a Plan price", async () => {
    const outcome = await deliverArchivedSubscriptionEvent(
      "customer.subscription.created",
      "active",
    );

    expect(outcome.observed).toStrictEqual({
      delivery: 200,
      billing: outcome.before,
      subscriptionRetrievals: 0,
    });
  });

  it("billing-archived-stripe-events-009 keeps the paid Plan when an archived-purpose subscription is updated with a Plan price", async () => {
    const outcome = await deliverArchivedSubscriptionEvent(
      "customer.subscription.updated",
      "active",
    );

    expect(outcome.observed).toStrictEqual({
      delivery: 200,
      billing: outcome.before,
      subscriptionRetrievals: 0,
    });
  });

  it("billing-archived-stripe-events-010 keeps the paid Plan when an archived-purpose subscription is deleted with a Plan price", async () => {
    const outcome = await deliverArchivedSubscriptionEvent(
      "customer.subscription.deleted",
      "canceled",
    );

    expect(outcome.observed).toStrictEqual({
      delivery: 200,
      billing: outcome.before,
      subscriptionRetrievals: 0,
    });
  });

  it("billing-archived-stripe-events-011 ignores an archived-Product line on the retired price embedded inline", async () => {
    const workspace = await proWorkspace();

    await expect(
      replayTwice(
        workspace,
        invoiceItemInvoice(workspace, {
          price: { id: RETIRED_PRICE, product: archivedProduct() },
        }),
      ),
    ).resolves.toStrictEqual(unchangedReplay(workspace));
  });

  it("billing-archived-stripe-events-014 ignores an archived-Product line on the retired price identified through pricing details", async () => {
    const workspace = await proWorkspace();
    const product = archivedProduct();
    context.mocks.stripe.products.retrieve.mockResolvedValue(product);

    await expect(
      replayTwice(
        workspace,
        invoiceItemInvoice(workspace, {
          price: null,
          pricing: {
            price_details: { price: RETIRED_PRICE, product: product.id },
          },
        }),
      ),
    ).resolves.toStrictEqual(unchangedReplay(workspace));

    expect(context.mocks.stripe.products.retrieve).toHaveBeenCalledWith(
      product.id,
    );
  });

  it("billing-archived-stripe-events-015 ignores a line on the retired price whose embedded Product is deleted", async () => {
    const workspace = await proWorkspace();

    await expect(
      replayTwice(
        workspace,
        invoiceItemInvoice(workspace, {
          price: {
            id: RETIRED_PRICE,
            product: { id: stripeId("prod"), object: "product", deleted: true },
          },
        }),
      ),
    ).resolves.toStrictEqual(unchangedReplay(workspace));
  });

  it("billing-archived-stripe-events-017 ignores a line on the retired price that Stripe no longer has", async () => {
    const workspace = await proWorkspace();
    context.mocks.stripe.prices.retrieve.mockRejectedValue(
      stripeError(`No such price: '${RETIRED_PRICE}'`, {
        type: "StripeInvalidRequestError",
        code: "resource_missing",
        statusCode: 404,
      }),
    );

    await expect(
      replayTwice(
        workspace,
        invoiceItemInvoice(workspace, { price: { id: RETIRED_PRICE } }),
      ),
    ).resolves.toStrictEqual(unchangedReplay(workspace));
  });

  it("billing-archived-stripe-events-019 rejects both deliveries while the retired price cannot be read", async () => {
    const workspace = await proWorkspace();
    context.mocks.stripe.prices.retrieve.mockRejectedValue(
      stripeError("Stripe is temporarily unavailable", {
        type: "StripeAPIError",
        statusCode: 503,
      }),
    );

    await expect(
      replayTwice(
        workspace,
        invoiceItemInvoice(workspace, { price: { id: RETIRED_PRICE } }),
        500,
      ),
    ).resolves.toStrictEqual(unchangedReplay(workspace, 500));
  });

  it("billing-archived-stripe-events-021 ignores an archived-Product line on the team price embedded inline", async () => {
    const workspace = await proWorkspace();

    await expect(
      replayTwice(
        workspace,
        invoiceItemInvoice(workspace, {
          price: { id: "price_bdd_team", product: archivedProduct() },
        }),
      ),
    ).resolves.toStrictEqual(unchangedReplay(workspace));
  });

  it("billing-archived-stripe-events-031 grants only Plan and concurrency benefits when the retired line metadata is archived", async () => {
    const outcome = await deliverMixedInvoiceThenCancel({
      retiredLineMetadata: { purpose: "usage_allowance" },
    });

    expect(outcome.observed).toStrictEqual(planAndConcurrencyOnly(outcome));
  });

  it("billing-archived-stripe-events-032 grants only Plan and concurrency benefits when the invoice binds the retired allowance price", async () => {
    const outcome = await deliverMixedInvoiceThenCancel({
      invoiceMetadata: { allowancePriceId: RETIRED_PRICE },
    });

    expect(outcome.observed).toStrictEqual(planAndConcurrencyOnly(outcome));
  });

  it("billing-archived-stripe-events-033 grants only Plan and concurrency benefits when the retired price is unmarked", async () => {
    const outcome = await deliverMixedInvoiceThenCancel({});

    expect(outcome.observed).toStrictEqual(planAndConcurrencyOnly(outcome));
  });

  it("billing-archived-stripe-events-035 grants only Plan and concurrency benefits when Stripe no longer has the retired price", async () => {
    const outcome = await deliverMixedInvoiceThenCancel({
      retiredPriceLookup: () => {
        return Promise.reject(
          stripeError(`No such price: '${RETIRED_PRICE}'`, {
            type: "StripeInvalidRequestError",
            code: "resource_missing",
            statusCode: 404,
          }),
        );
      },
    });

    expect(outcome.observed).toStrictEqual(planAndConcurrencyOnly(outcome));
  });

  it("billing-archived-stripe-events-037 rejects the mixed invoice while the retired price cannot be read", async () => {
    const workspace = await proWorkspace();
    const mixed = mixedPlanInvoice(workspace, {
      retiredPriceLookup: () => {
        return Promise.reject(
          stripeError("Stripe is temporarily unavailable", {
            type: "StripeAPIError",
            statusCode: 503,
          }),
        );
      },
    });

    await expect(
      workspace.deliver("invoice.paid", mixed.invoice, 500),
    ).resolves.toBe(500);

    await expect(workspace.readStatus()).resolves.toStrictEqual(
      workspace.before,
    );
  });

  it("billing-archived-stripe-events-038 grants only Plan and concurrency benefits from a credit-purchase header bound to the retired price", async () => {
    const outcome = await deliverMixedInvoiceThenCancel({
      invoiceMetadata: {
        allowancePriceId: RETIRED_PRICE,
        type: "credit_purchase",
      },
    });

    expect(outcome.observed).toStrictEqual(planAndConcurrencyOnly(outcome));
  });

  it("billing-archived-stripe-events-039 grants only Plan and concurrency benefits from an auto-recharge header bound to the retired price", async () => {
    const outcome = await deliverMixedInvoiceThenCancel({
      invoiceMetadata: {
        allowancePriceId: RETIRED_PRICE,
        type: "auto_recharge",
        creditsAmount: "900000",
      },
    });

    expect(outcome.observed).toStrictEqual(planAndConcurrencyOnly(outcome));
  });
});
