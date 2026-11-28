import { randomUUID } from "node:crypto";
import { integrationsSlackContract } from "@okouai/api-contracts/contracts/integrations-slack";
import { orgDeleteContract } from "@okouai/api-contracts/contracts/org-routes";
import { expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { integrationsSlackRoutes } from "../integrations-slack";
import { orgDeleteRoutes } from "../org-delete";
import { createBddApi } from "./helpers/api-bdd";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createRouteMocks } from "./helpers/route-test";
import { createPublicSlackOrgApi } from "./helpers/slack-public-install";
import {
  postConcurrencyEntitlementsInvoicePaid,
  postOneTimePurchaseCompleted,
  postSubscriptionInvoicePaid,
} from "./helpers/stripe-billing-webhook";

const context = testContext();
const bdd = createBddApi(context);

const DAY_SECONDS = 86_400;
const PERIOD_SECONDS = 100 * DAY_SECONDS;
// Keeps each proration just above its whole-cent value while the request runs.
const SLACK_SECONDS = 3600;
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function stripeId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 12)}`;
}

function nowSeconds(): number {
  return Math.floor(now() / 1000);
}

/** A billing period of 100 days with `remainingPercent` of it left at deletion. */
function billingPeriod(remainingPercent: number) {
  const end =
    nowSeconds() + (remainingPercent * PERIOD_SECONDS) / 100 + SLACK_SECONDS;
  return { start: end - PERIOD_SECONDS, end };
}

function livePrice(id = stripeId("price")) {
  return {
    id,
    product: { id: stripeId("prod"), object: "product", metadata: {} },
  };
}

function stripeSubscription(args: {
  readonly id?: string;
  readonly customer: string;
  readonly status?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly price?: ReturnType<typeof livePrice>;
}) {
  return {
    id: args.id ?? stripeId("sub"),
    customer: args.customer,
    status: args.status ?? "active",
    metadata: args.metadata ?? {},
    items: {
      data: [{ id: stripeId("si"), price: args.price ?? livePrice() }],
    },
  };
}

interface InvoiceLineInput {
  readonly amount: number;
  readonly period: { readonly start: number; readonly end: number };
  readonly type?: "subscription_item_details" | "invoice_item_details";
  readonly price?: ReturnType<typeof livePrice>;
  readonly taxes?: readonly {
    readonly amount: number;
    readonly tax_behavior: "exclusive" | "inclusive";
  }[];
  readonly discount_amounts?: readonly { readonly amount: number }[];
}

function invoiceLine(line: InvoiceLineInput) {
  return {
    id: stripeId("il"),
    amount: line.amount,
    metadata: {},
    parent: { type: line.type ?? "subscription_item_details" },
    period: line.period,
    price: line.price ?? livePrice(),
    taxes: line.taxes ?? [],
    discount_amounts: line.discount_amounts ?? [],
  };
}

function paidInvoice(
  lines: readonly InvoiceLineInput[],
  metadata: Readonly<Record<string, string>> = {},
) {
  return {
    id: stripeId("in"),
    status: "paid",
    amount_due: lines.reduce((total, line) => {
      return (
        total +
        line.amount -
        (line.discount_amounts ?? []).reduce((sum, discount) => {
          return sum + discount.amount;
        }, 0)
      );
    }, 0),
    metadata,
    parent: { subscription_details: { metadata: {} } },
    lines: { has_more: false, data: lines.map(invoiceLine) },
  };
}

type StripeInvoiceDouble = ReturnType<typeof paidInvoice>;

/** Stripe answers the deletion-time lookups and issues fully refunded credit notes. */
function stripeAtDeletion(args: {
  readonly subscriptionPages: readonly (readonly ReturnType<
    typeof stripeSubscription
  >[])[];
  readonly invoices?: Readonly<
    Record<string, readonly StripeInvoiceDouble[] | undefined>
  >;
}) {
  const stripe = context.mocks.stripe;
  for (const [index, page] of args.subscriptionPages.entries()) {
    stripe.subscriptions.list.mockResolvedValueOnce({
      data: page,
      has_more: index < args.subscriptionPages.length - 1,
    });
  }
  stripe.subscriptions.update.mockImplementation((id) => {
    return Promise.resolve({ id });
  });
  stripe.subscriptions.cancel.mockImplementation((id) => {
    return Promise.resolve({ id, status: "canceled" });
  });
  stripe.invoices.list.mockImplementation((params) => {
    const subscription =
      typeof params === "object" && params !== null && "subscription" in params
        ? String(params.subscription)
        : "";
    return Promise.resolve({
      data: args.invoices?.[subscription] ?? [],
      has_more: false,
    });
  });
  stripe.creditNotes.list.mockResolvedValue({ data: [], has_more: false });
  stripe.creditNotes.preview.mockImplementation((params) => {
    const amount =
      typeof params === "object" && params !== null && "amount" in params
        ? Number(params.amount)
        : 0;
    return Promise.resolve({
      pre_payment_amount: 0,
      post_payment_amount: amount,
    });
  });
  stripe.creditNotes.create.mockImplementation((params) => {
    const amount =
      typeof params === "object" && params !== null && "amount" in params
        ? Number(params.amount)
        : 0;
    return Promise.resolve({
      id: stripeId("cn"),
      status: "issued",
      post_payment_amount: amount,
      refunds: [
        {
          amount_refunded: amount,
          refund: { id: stripeId("re"), status: "succeeded" },
        },
      ],
    });
  });
}

/** A signed-in admin whose organization is ready to be deleted. */
async function adminWorkspace() {
  const admin = bdd.user();
  await bdd.bootstrapLimitedFreeOnboarding(admin);
  const orgId = admin.orgId;
  if (!orgId) {
    throw new Error("Expected an organization");
  }
  const webhooks = createWebhookCallbackApi(context);
  webhooks.configureStripeBillingEnv();
  const clerk = context.mocks.clerk.organizations;
  clerk.getOrganization.mockResolvedValue({ id: orgId, name: "Deleted Org" });
  clerk.getOrganizationMembershipList.mockResolvedValue({
    data: [{ publicUserData: { userId: admin.userId }, role: "org:admin" }],
    totalCount: 1,
  });
  clerk.deleteOrganization.mockResolvedValue({ id: orgId, deleted: true });
  const client = setupApp({ context, routes: orgDeleteRoutes })(
    orgDeleteContract,
  );

  /** The workspace subscribes to Pro; Stripe records the customer and subscription. */
  async function subscribePlan() {
    const customerId = stripeId("cus");
    const subscription = stripeSubscription({
      customer: customerId,
      price: livePrice("price_bdd_pro"),
    });
    context.mocks.stripe.customers.retrieve.mockResolvedValue({
      id: customerId,
      metadata: { orgId },
    });
    for (const type of [
      "customer.subscription.created",
      "customer.subscription.updated",
    ]) {
      await webhooks.postStripeEvent(
        {
          id: stripeId("evt"),
          type,
          created: nowSeconds(),
          data: {
            object: {
              ...subscription,
              cancel_at_period_end: false,
              cancel_at: null,
              schedule: null,
              trial_end: null,
            },
          },
        },
        [200],
      );
    }
    await flushWaitUntilForTest();
    return { customerId, subscription };
  }

  async function deleteOrg(statuses: readonly (200 | 500)[] = [200]) {
    createRouteMocks(context).clerk.session(admin.userId, orgId);
    return await accept(
      client.delete({ headers, body: { confirm: "confirm" } }),
      statuses,
    );
  }

  return { admin, orgId, subscribePlan, deleteOrg };
}

test("org-delete-billing-012 deletes an organization without billing references and no Stripe calls", async () => {
  const workspace = await adminWorkspace();

  const response = await workspace.deleteOrg();

  expect(response.body).toStrictEqual({ message: "Organization deleted" });
  const stripe = context.mocks.stripe;
  expect(stripe.subscriptions.list).not.toHaveBeenCalled();
  expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
  expect(stripe.creditNotes.create).not.toHaveBeenCalled();
});

test("org-delete-billing-013 does not refund a one-time credit purchase", async () => {
  const workspace = await adminWorkspace();
  await expect(
    postOneTimePurchaseCompleted(context.signal, {
      orgId: workspace.orgId,
      credits: 100_000,
    }),
  ).resolves.toBeTruthy();

  const response = await workspace.deleteOrg();

  expect(response.body).toStrictEqual({ message: "Organization deleted" });
  const stripe = context.mocks.stripe;
  expect(stripe.subscriptions.list).not.toHaveBeenCalled();
  expect(stripe.invoices.list).not.toHaveBeenCalled();
  expect(stripe.creditNotes.create).not.toHaveBeenCalled();
});

test("org-delete-billing-014 cancels trial and unpaid subscriptions without a refund", async () => {
  const workspace = await adminWorkspace();
  const { customerId, subscription } = await workspace.subscribePlan();
  const trialing = stripeSubscription({
    id: subscription.id,
    customer: customerId,
    status: "trialing",
  });
  const unpaid = stripeSubscription({ customer: customerId, status: "unpaid" });
  stripeAtDeletion({ subscriptionPages: [[trialing, unpaid]] });

  await workspace.deleteOrg();

  const stripe = context.mocks.stripe;
  expect(
    stripe.subscriptions.cancel.mock.calls.map((call) => {
      return call[0];
    }),
  ).toStrictEqual([trialing.id, unpaid.id]);
  expect(stripe.creditNotes.preview).not.toHaveBeenCalled();
  expect(stripe.creditNotes.create).not.toHaveBeenCalled();
});

test("org-delete-billing-015 cancels a fully discounted subscription without a refund", async () => {
  const workspace = await adminWorkspace();
  const { subscription } = await workspace.subscribePlan();
  stripeAtDeletion({
    subscriptionPages: [[subscription]],
    invoices: {
      [subscription.id]: [
        paidInvoice([
          {
            amount: 1000,
            period: billingPeriod(50),
            discount_amounts: [{ amount: 1000 }],
          },
        ]),
      ],
    },
  });

  await workspace.deleteOrg();

  const stripe = context.mocks.stripe;
  expect(stripe.subscriptions.cancel).toHaveBeenCalledOnce();
  expect(stripe.subscriptions.cancel).toHaveBeenCalledWith(
    subscription.id,
    expect.anything(),
    expect.anything(),
  );
  expect(stripe.creditNotes.preview).not.toHaveBeenCalled();
  expect(stripe.creditNotes.create).not.toHaveBeenCalled();
  expect(
    context.mocks.clerk.organizations.deleteOrganization,
  ).toHaveBeenCalledOnce();
});

test("org-delete-billing-016 nets the upgrade credit and excludes one-time items from the refund", async () => {
  const workspace = await adminWorkspace();
  const { subscription } = await workspace.subscribePlan();
  const period = billingPeriod(40);
  const upgradePeriod = {
    start: period.start + 0.2 * PERIOD_SECONDS,
    end: period.end,
  };
  const original = paidInvoice([
    {
      amount: 1000,
      period,
      taxes: [{ amount: 100, tax_behavior: "exclusive" }],
    },
    { amount: 2000, period, type: "invoice_item_details" },
  ]);
  const upgrade = paidInvoice([
    { amount: -600, period: upgradePeriod },
    { amount: 1200, period: upgradePeriod },
  ]);
  stripeAtDeletion({
    subscriptionPages: [[subscription]],
    invoices: { [subscription.id]: [original, upgrade] },
  });

  await workspace.deleteOrg();

  expect(
    context.mocks.stripe.creditNotes.preview.mock.calls.map((call) => {
      return call[0];
    }),
  ).toMatchObject([
    { invoice: original.id, amount: 440 },
    { invoice: upgrade.id, amount: 300 },
  ]);
});

test("org-delete-billing-017 nets a separate downgrade credit before refunding unused time", async () => {
  const workspace = await adminWorkspace();
  const { subscription } = await workspace.subscribePlan();
  const period = billingPeriod(25);
  const downgradePeriod = {
    start: period.start + 0.5 * PERIOD_SECONDS,
    end: period.end,
  };
  const original = paidInvoice([{ amount: 2000, period }]);
  const downgrade = paidInvoice([
    { amount: -1000, period: downgradePeriod },
    { amount: 500, period: downgradePeriod },
  ]);
  stripeAtDeletion({
    subscriptionPages: [[subscription]],
    invoices: { [subscription.id]: [original, downgrade] },
  });

  await workspace.deleteOrg();

  const stripe = context.mocks.stripe;
  expect(
    stripe.creditNotes.preview.mock.calls.map((call) => {
      return call[0];
    }),
  ).toMatchObject([{ invoice: original.id, amount: 250 }]);
  expect(stripe.creditNotes.preview).toHaveBeenCalledOnce();
  expect(stripe.creditNotes.create).toHaveBeenCalledOnce();
});

test("org-delete-billing-002 cancels only the live Plan beside an archive-only allowance subscription", async () => {
  const workspace = await adminWorkspace();
  const { customerId, subscription } = await workspace.subscribePlan();
  const allowancePrice = livePrice();
  const archive = stripeSubscription({
    customer: customerId,
    metadata: { allowancePriceId: allowancePrice.id },
    price: allowancePrice,
  });
  stripeAtDeletion({
    subscriptionPages: [[subscription, archive]],
    invoices: {
      [subscription.id]: [
        paidInvoice([{ amount: 1000, period: billingPeriod(20) }]),
      ],
    },
  });

  const response = await workspace.deleteOrg();

  expect(response.body).toStrictEqual({ message: "Organization deleted" });
  const stripe = context.mocks.stripe;
  expect(stripe.subscriptions.cancel.mock.calls).toStrictEqual([
    [
      subscription.id,
      { invoice_now: false, prorate: false },
      {
        idempotencyKey: `org-delete:${workspace.orgId}:${subscription.id}:cancel`,
      },
    ],
  ]);
  expect(
    stripe.subscriptions.update.mock.calls.filter((call) => {
      return call[0] === archive.id;
    }),
  ).toStrictEqual([]);
  expect(stripe.creditNotes.create).toHaveBeenCalledOnce();
});

test("org-delete-billing-005 refunds only the ordinary paid portion across paginated invoice lines", async () => {
  const workspace = await adminWorkspace();
  const { subscription } = await workspace.subscribePlan();
  const period = billingPeriod(20);
  const allowancePrice = livePrice();
  const invoice = {
    ...paidInvoice([], { allowancePriceId: allowancePrice.id }),
    lines: { has_more: true, data: [] },
  };
  stripeAtDeletion({
    subscriptionPages: [[subscription]],
    invoices: { [subscription.id]: [invoice] },
  });
  const ordinary = invoiceLine({ amount: 1000, period });
  context.mocks.stripe.invoices.listLineItems
    .mockResolvedValueOnce({ data: [ordinary], has_more: true })
    .mockResolvedValueOnce({
      data: [invoiceLine({ amount: 2000, period, price: allowancePrice })],
      has_more: false,
    });

  await workspace.deleteOrg();

  const stripe = context.mocks.stripe;
  expect(stripe.invoices.listLineItems.mock.calls).toStrictEqual([
    [invoice.id, { limit: 100 }],
    [invoice.id, { limit: 100, starting_after: ordinary.id }],
  ]);
  expect(stripe.creditNotes.create.mock.calls).toStrictEqual([
    [
      expect.objectContaining({
        invoice: invoice.id,
        amount: 200,
        refund_amount: 200,
      }),
      { idempotencyKey: expect.stringContaining(invoice.id) },
    ],
  ]);
});

test("org-delete-billing-001 cancels and proportionally refunds every live organization subscription", async () => {
  const workspace = await adminWorkspace();
  const customerId = stripeId("cus");
  const planId = stripeId("sub");
  const concurrencyId = stripeId("sub");
  await postSubscriptionInvoicePaid(context.signal, {
    orgId: workspace.orgId,
    userId: workspace.admin.userId,
    tier: "pro",
    customerId,
    subscriptionId: planId,
    currentPeriodEnd: new Date((nowSeconds() + 20 * DAY_SECONDS) * 1000),
  });
  await postConcurrencyEntitlementsInvoicePaid(context.signal, {
    orgId: workspace.orgId,
    userId: workspace.admin.userId,
    customerId,
    subscriptionId: concurrencyId,
    lines: [
      {
        slots: 1,
        startsAt: new Date(now()),
        expiresAt: new Date(now() + 20 * DAY_SECONDS * 1000),
      },
    ],
  });
  await flushWaitUntilForTest();
  const plan = stripeSubscription({ id: planId, customer: customerId });
  const usagePack = stripeSubscription({ customer: customerId });
  const archived = stripeSubscription({
    customer: customerId,
    metadata: { purpose: "usage_allowance" },
  });
  const concurrency = stripeSubscription({
    id: concurrencyId,
    customer: customerId,
    metadata: { purpose: "concurrency_subscription" },
    price: livePrice("price_test_concurrency"),
  });
  context.mocks.stripe.subscriptions.retrieve.mockImplementation((id) => {
    return Promise.resolve(id === concurrencyId ? concurrency : null);
  });
  const invoices = Object.fromEntries(
    [plan, usagePack, archived, concurrency].map((subscription) => {
      return [
        subscription.id,
        [paidInvoice([{ amount: 1000, period: billingPeriod(20) }])],
      ];
    }),
  );
  stripeAtDeletion({
    subscriptionPages: [[plan, usagePack], [archived]],
    invoices,
  });

  const response = await workspace.deleteOrg();

  expect(response.body).toStrictEqual({ message: "Organization deleted" });
  const stripe = context.mocks.stripe;
  expect(stripe.subscriptions.list.mock.calls[1]?.[0]).toMatchObject({
    starting_after: usagePack.id,
  });
  const live = [plan, usagePack, concurrency];
  expect(stripe.subscriptions.cancel.mock.calls).toHaveLength(3);
  expect(stripe.subscriptions.cancel.mock.calls).toStrictEqual(
    expect.arrayContaining(
      live.map((subscription) => {
        return [
          subscription.id,
          { invoice_now: false, prorate: false },
          {
            idempotencyKey: `org-delete:${workspace.orgId}:${subscription.id}:cancel`,
          },
        ];
      }),
    ),
  );
  expect(stripe.creditNotes.create.mock.calls).toHaveLength(3);
  expect(
    stripe.creditNotes.create.mock.calls.map((call) => {
      return call[0];
    }),
  ).toStrictEqual(
    expect.arrayContaining(
      live.map((subscription) => {
        return expect.objectContaining({
          invoice: invoices[subscription.id]?.[0]?.id,
          amount: 200,
          refund_amount: 200,
          metadata: {
            purpose: "org_deletion_prorated_refund",
            orgId: workspace.orgId,
            subscriptionId: subscription.id,
            deletionAt: expect.stringMatching(/^\d+$/),
          },
        });
      }),
    ),
  );
  const lastRefund = Math.max(
    ...stripe.creditNotes.create.mock.invocationCallOrder,
  );
  const [clerkDeletion] =
    context.mocks.clerk.organizations.deleteOrganization.mock
      .invocationCallOrder;
  expect(lastRefund).toBeLessThan(clerkDeletion ?? 0);
});

/** The org-deletion marker production wrote to the subscription metadata. */
function deletionMarker(params: unknown): Record<string, string> {
  if (
    typeof params !== "object" ||
    params === null ||
    !("metadata" in params) ||
    typeof params.metadata !== "object" ||
    params.metadata === null
  ) {
    throw new Error("Expected the subscription to carry the deletion marker");
  }
  return Object.fromEntries(
    Object.entries(params.metadata).map(([key, value]) => {
      return [key, String(value)];
    }),
  );
}

test("org-delete-billing-018 reuses a prior deletion marker and issued credit note on retry", async () => {
  const workspace = await adminWorkspace();
  const { customerId, subscription } = await workspace.subscribePlan();
  const deletionAt = String(nowSeconds());
  const marked = stripeSubscription({
    id: subscription.id,
    customer: customerId,
    status: "canceled",
    metadata: {
      vm0_org_delete_org_id: workspace.orgId,
      vm0_org_delete_at: deletionAt,
    },
  });
  const historical = stripeSubscription({
    customer: customerId,
    status: "canceled",
  });
  const invoice = paidInvoice([{ amount: 1000, period: billingPeriod(50) }]);
  stripeAtDeletion({
    subscriptionPages: [[marked, historical]],
    invoices: { [marked.id]: [invoice] },
  });
  const stripe = context.mocks.stripe;
  stripe.creditNotes.list.mockResolvedValue({
    data: [
      {
        id: stripeId("cn"),
        status: "issued",
        post_payment_amount: 500,
        metadata: {
          purpose: "org_deletion_prorated_refund",
          orgId: workspace.orgId,
          subscriptionId: marked.id,
          deletionAt,
        },
        refunds: [
          {
            amount_refunded: 500,
            refund: { id: stripeId("re"), status: "succeeded" },
          },
        ],
      },
    ],
    has_more: false,
  });

  const response = await workspace.deleteOrg();

  expect(response.body).toStrictEqual({ message: "Organization deleted" });
  expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
  expect(stripe.invoices.list.mock.calls).toStrictEqual([
    [{ subscription: marked.id, status: "paid", limit: 100 }],
  ]);
  expect(stripe.creditNotes.preview).not.toHaveBeenCalled();
  expect(stripe.creditNotes.create).not.toHaveBeenCalled();
  expect(
    context.mocks.clerk.organizations.deleteOrganization,
  ).toHaveBeenCalledWith(workspace.orgId);
});

test("org-delete-billing-022 retries a failed Clerk-deletion refund on redelivery with the same idempotency key", async () => {
  const workspace = await adminWorkspace();
  const { customerId, subscription } = await workspace.subscribePlan();
  const invoice = {
    ...paidInvoice([{ amount: 1000, period: billingPeriod(50) }]),
    id: "in_delete_clerk",
  };
  stripeAtDeletion({
    subscriptionPages: [[subscription]],
    invoices: { [subscription.id]: [invoice] },
  });
  const stripe = context.mocks.stripe;
  stripe.creditNotes.create.mockRejectedValueOnce(
    Object.assign(new Error("Stripe is temporarily unavailable"), {
      type: "StripeAPIError",
      statusCode: 503,
    }),
  );
  const webhooks = createWebhookCallbackApi(context);
  webhooks.configureClerkWebhookSecret();
  const deliverOrganizationDeleted = async (
    statuses: readonly (200 | 503)[],
  ) => {
    webhooks.verifyNextClerkWebhook({
      type: "organization.deleted",
      data: { id: workspace.orgId, object: "organization", deleted: true },
    });
    return await webhooks.requestClerkWebhook("{}", {}, statuses);
  };

  const first = await deliverOrganizationDeleted([503]);

  expect(first.body).toStrictEqual({
    error: "Organization billing cleanup failed",
  });
  expect(stripe.subscriptions.cancel).toHaveBeenCalledOnce();
  expect(stripe.creditNotes.create).toHaveBeenCalledOnce();
  await expect(
    createRunsApi(context).readBillingStatus(workspace.admin),
  ).resolves.toMatchObject({ hasSubscription: true });

  // Stripe now reports the subscription cancelled with the marker written on it.
  const metadata = deletionMarker(
    stripe.subscriptions.update.mock.calls.find((call) => {
      return call[0] === subscription.id;
    })?.[1],
  );
  stripe.subscriptions.list.mockResolvedValueOnce({
    data: [
      stripeSubscription({
        id: subscription.id,
        customer: customerId,
        status: "canceled",
        metadata,
      }),
    ],
    has_more: false,
  });

  const redelivery = await deliverOrganizationDeleted([200]);

  expect(redelivery.status).toBe(200);
  expect(stripe.subscriptions.cancel).toHaveBeenCalledOnce();
  expect(stripe.creditNotes.create.mock.calls[1]).toStrictEqual([
    expect.objectContaining({
      invoice: "in_delete_clerk",
      amount: 500,
      refund_amount: 500,
    }),
    {
      idempotencyKey: `org-delete-refund:${workspace.orgId}:${subscription.id}:in_delete_clerk:${metadata.vm0_org_delete_at ?? "missing"}`,
    },
  ]);
});

test("org-delete-billing-019 keeps the organization when its proportional refund fails", async () => {
  const workspace = await adminWorkspace();
  const [slack, { subscription }] = await Promise.all([
    createPublicSlackOrgApi(context).installOrg({
      withConnection: true,
      actor: workspace.admin,
    }),
    workspace.subscribePlan(),
    bdd.updateUserTimezone(workspace.admin, "Asia/Shanghai"),
    bdd.updateUserLocale(workspace.admin, "en-US"),
  ]);
  stripeAtDeletion({
    subscriptionPages: [[subscription]],
    invoices: {
      [subscription.id]: [
        paidInvoice([{ amount: 1000, period: billingPeriod(50) }]),
      ],
    },
  });
  const stripe = context.mocks.stripe;
  stripe.creditNotes.create.mockRejectedValueOnce(
    Object.assign(new Error("Stripe is temporarily unavailable"), {
      type: "StripeAPIError",
      statusCode: 503,
    }),
  );

  const response = await workspace.deleteOrg([500]);

  expect(response.status).toBe(500);
  expect(stripe.subscriptions.cancel).toHaveBeenCalledOnce();
  expect(
    context.mocks.clerk.organizations.deleteOrganization,
  ).not.toHaveBeenCalled();
  createRouteMocks(context).clerk.session(
    workspace.admin.userId,
    workspace.orgId,
  );
  const slackApi = setupApp({ context, routes: integrationsSlackRoutes })(
    integrationsSlackContract,
  );
  const [preferences, status] = await Promise.all([
    createMiscRoutesApi(context).readPreferences(workspace.admin),
    accept(slackApi.getStatus({ headers }), [200]),
  ]);
  expect(preferences.body).toMatchObject({
    timezone: "Asia/Shanghai",
    locale: "en-US",
  });
  expect(status.body).toMatchObject({
    isInstalled: true,
    isConnected: true,
    workspaceName: slack.slackWorkspaceName,
  });
});
