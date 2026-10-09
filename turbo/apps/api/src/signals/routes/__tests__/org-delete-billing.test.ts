import { createPublicSlackOrgApi } from "./helpers/slack-public-install";
import { integrationsSlackContract } from "@okouai/api-contracts/contracts/integrations-slack";
import { integrationsSlackRoutes } from "../integrations-slack";
import { randomUUID } from "node:crypto";

import { orgDeleteContract } from "@okouai/api-contracts/contracts/org-routes";
import type StripeSDK from "stripe";
import { afterEach, expect, onTestFinished, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { clearMockNow, mockNow } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import {
  mockStripeClient,
  type StripeCreditNote,
  type StripeInvoice,
  type StripeInvoiceLine,
  type StripeSubscription,
} from "../../external/stripe-client";
import { orgDeleteRoutes } from "../org-delete";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createRouteMocks } from "./helpers/route-test";
import {
  createBillingWebhookFixture,
  generatedStripeCustomerId,
  postConcurrencyEntitlementsInvoicePaid,
  postOneTimePurchaseCompleted,
  postSubscriptionInvoicePaid,
  TEST_PRICE_CONCURRENCY,
  type BillingWebhookFixture,
} from "./helpers/stripe-billing-webhook";

const context = testContext();
const slackOrgs = createPublicSlackOrgApi(context);
const mocks = createRouteMocks(context);

interface OrgDeleteBillingFixture extends BillingWebhookFixture {
  readonly customerId: string;
}

function createOrgDeleteBillingFixture(): OrgDeleteBillingFixture {
  return {
    ...createBillingWebhookFixture(),
    customerId: generatedStripeCustomerId(),
  };
}

async function seedPlanSubscription(
  fixture: OrgDeleteBillingFixture,
  subscriptionId: string,
  periodEndTimestamp = 1_900_000_000,
): Promise<void> {
  await postSubscriptionInvoicePaid(context.signal, {
    ...fixture,
    tier: "pro",
    subscriptionId,
    currentPeriodEnd: new Date(periodEndTimestamp * 1000),
  });
}

afterEach(() => {
  clearMockNow();
});

function subscription(
  id: string,
  customerId: string,
  args?: {
    readonly status?: string;
    readonly metadata?: Record<string, string>;
  },
): StripeSubscription {
  return {
    id,
    customer: customerId,
    status: args?.status ?? "active",
    metadata: args?.metadata ?? {},
    cancel_at_period_end: false,
    latest_invoice: null,
    items: { data: [] },
  };
}

function subscriptionLine(
  amount: number,
  start: number,
  end: number,
  exclusiveTax = 0,
): StripeInvoiceLine {
  return {
    id: `il_${randomUUID().slice(0, 8)}`,
    amount,
    taxes:
      exclusiveTax > 0
        ? [{ amount: exclusiveTax, tax_behavior: "exclusive" }]
        : [],
    period: { start, end },
    parent: {
      type: "subscription_item_details",
      subscription_item_details: { proration: false },
    },
  };
}

function oneTimeLine(
  amount: number,
  start: number,
  end: number,
): StripeInvoiceLine {
  return {
    id: `il_once_${randomUUID().slice(0, 8)}`,
    amount,
    period: { start, end },
    parent: {
      type: "invoice_item_details",
      invoice_item_details: { proration: false },
    },
  };
}

function paidInvoice(
  id: string,
  customerId: string,
  subscriptionId: string,
  lines: readonly StripeInvoiceLine[],
  hasMoreLines = false,
): StripeInvoice {
  const amount = lines.reduce((total, line) => {
    return total + line.amount;
  }, 0);
  return {
    id,
    customer: customerId,
    metadata: {},
    amount_due: amount,
    amount_paid: amount,
    currency: "usd",
    status: "paid",
    paid: true,
    lines: { data: lines, has_more: hasMoreLines },
    parent: {
      subscription_details: {
        subscription: subscriptionId,
        metadata: {},
      },
    },
  };
}

function creditNote(
  id: string,
  amount: number,
  metadata?: Record<string, string>,
  refundStatus = "succeeded",
): StripeCreditNote {
  return {
    id,
    status: "issued",
    metadata,
    pre_payment_amount: 0,
    post_payment_amount: amount,
    refunds: [
      {
        amount_refunded: amount,
        refund: {
          id: `re_${id}`,
          status: refundStatus,
          amount,
          payment_intent: null,
          metadata: {},
        },
      },
    ],
  };
}

function mockOrgDeletion(fixture: OrgDeleteBillingFixture): void {
  mockStripeClient(context.mocks.stripe as unknown as StripeSDK);
  mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
  context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
    id: fixture.orgId,
  });
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    { data: [] },
  );
  context.mocks.clerk.organizations.deleteOrganization.mockResolvedValue({});
  context.mocks.stripe.subscriptions.update.mockResolvedValue({});
  context.mocks.stripe.subscriptions.cancel.mockResolvedValue({});
  context.mocks.stripe.creditNotes.list.mockResolvedValue({
    data: [],
    has_more: false,
  });
}

async function requestOrgDeletion() {
  const client = setupApp({ context, routes: orgDeleteRoutes })(
    orgDeleteContract,
  );
  return await client.delete({
    headers: { authorization: "Bearer clerk-session" },
    body: { confirm: "confirm" },
  });
}

test("immediately cancels and proportionally refunds every org subscription source", async () => {
  const deletionTimestamp = 1_800_000_000;
  const periodStart = deletionTimestamp - 800;
  const periodEnd = deletionTimestamp + 200;
  const ids = {
    plan: "sub_delete_plan",
    usagePack: "sub_delete_usage_pack",
    concurrency: "sub_delete_concurrency",
  };
  const fixture = createOrgDeleteBillingFixture();
  await seedPlanSubscription(fixture, ids.plan, periodEnd);
  context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce({
    id: ids.concurrency,
    customer: fixture.customerId,
    status: "active",
    metadata: { purpose: "concurrency_subscription" },
    cancel_at_period_end: false,
    items: {
      data: [
        {
          price: { id: TEST_PRICE_CONCURRENCY },
          quantity: 1,
          current_period_end: periodEnd,
        },
      ],
    },
  });
  await postConcurrencyEntitlementsInvoicePaid(context.signal, {
    ...fixture,
    subscriptionId: ids.concurrency,
    lines: [
      {
        slots: 1,
        startsAt: new Date(periodStart * 1000),
        expiresAt: new Date(periodEnd * 1000),
      },
    ],
    subscriptionStatus: "active",
  });
  mockNow(deletionTimestamp * 1000);
  mockOrgDeletion(fixture);

  context.mocks.stripe.subscriptions.list
    .mockResolvedValueOnce({
      data: [
        subscription(ids.plan, fixture.customerId),
        subscription(ids.usagePack, fixture.customerId),
      ],
      has_more: true,
    })
    .mockResolvedValueOnce({
      data: [
        subscription(
          `sub_archived_allowance_${randomUUID()}`,
          fixture.customerId,
          {
            metadata: { purpose: "usage_allowance" },
          },
        ),
      ],
      has_more: false,
    });
  context.mocks.stripe.subscriptions.retrieve.mockResolvedValueOnce(
    subscription(ids.concurrency, fixture.customerId),
  );
  for (const [index, subscriptionId] of Object.values(ids).entries()) {
    context.mocks.stripe.invoices.list.mockResolvedValueOnce({
      data: [
        paidInvoice(`in_delete_${index}`, fixture.customerId, subscriptionId, [
          subscriptionLine(1000, periodStart, periodEnd),
        ]),
      ],
      has_more: false,
    });
  }
  context.mocks.stripe.creditNotes.preview.mockResolvedValue(
    creditNote("preview_delete", 200),
  );
  context.mocks.stripe.creditNotes.create.mockResolvedValue(
    creditNote("cn_delete", 200),
  );

  const response = await accept(requestOrgDeletion(), [200]);

  expect(response.body).toStrictEqual({ message: "Organization deleted" });
  expect(context.mocks.stripe.subscriptions.list).toHaveBeenNthCalledWith(2, {
    customer: fixture.customerId,
    status: "all",
    limit: 100,
    starting_after: ids.usagePack,
  });
  expect(context.mocks.stripe.subscriptions.cancel).toHaveBeenCalledTimes(3);
  for (const subscriptionId of Object.values(ids)) {
    expect(context.mocks.stripe.subscriptions.cancel).toHaveBeenCalledWith(
      subscriptionId,
      { invoice_now: false, prorate: false },
      {
        idempotencyKey: `org-delete:${fixture.orgId}:${subscriptionId}:cancel`,
      },
    );
  }
  expect(context.mocks.stripe.creditNotes.create).toHaveBeenCalledTimes(3);
  expect(
    context.mocks.stripe.creditNotes.create.mock.calls.map((call) => {
      return call[0];
    }),
  ).toStrictEqual(
    expect.arrayContaining(
      Object.values(ids).map((subscriptionId, index) => {
        return expect.objectContaining({
          invoice: `in_delete_${index}`,
          amount: 200,
          refund_amount: 200,
          metadata: {
            purpose: "org_deletion_prorated_refund",
            orgId: fixture.orgId,
            subscriptionId,
            deletionAt: String(deletionTimestamp),
          },
        });
      }),
    ),
  );
  const lastRefundCall =
    context.mocks.stripe.creditNotes.create.mock.invocationCallOrder.at(-1);
  const deleteCall =
    context.mocks.clerk.organizations.deleteOrganization.mock
      .invocationCallOrder[0];
  if (lastRefundCall === undefined || deleteCall === undefined) {
    throw new Error("Expected refund and organization deletion calls");
  }
  expect(lastRefundCall).toBeLessThan(deleteCall);
});

test.each(["bound price", "expanded Product", "unexpanded Product"])(
  "does not cancel an archive-only subscription identified by %s on the live Plan customer",
  async (source) => {
    const deletionTimestamp = 1_800_000_000;
    const fixture = createOrgDeleteBillingFixture();
    const planId = `sub_live_delete_${randomUUID()}`;
    const archiveId = `sub_archive_delete_${randomUUID()}`;
    await seedPlanSubscription(fixture, planId, deletionTimestamp + 200);
    mockNow(deletionTimestamp * 1000);
    mockOrgDeletion(fixture);
    const product = {
      id: "prod_delete_archive",
      name: "Archived Allowance",
      metadata: { purpose: "usage_allowance" },
    };
    const archived = {
      ...subscription(archiveId, fixture.customerId, {
        metadata:
          source === "bound price"
            ? { allowancePriceId: "price_delete_archive" }
            : {},
      }),
      items: {
        data: [
          {
            id: "si_delete_archive",
            quantity: 1,
            current_period_start: deletionTimestamp - 800,
            current_period_end: deletionTimestamp + 200,
            price: {
              id: "price_delete_archive",
              active: true,
              type: "recurring" as const,
              unit_amount: 2000,
              recurring: { interval: "month" as const, interval_count: 1 },
              product: source === "expanded Product" ? product : product.id,
            },
          },
        ],
      },
    };
    context.mocks.stripe.products.retrieve.mockImplementation((id) => {
      return Promise.resolve({
        id,
        name: "Billing product",
        metadata: id === product.id ? product.metadata : {},
      });
    });
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [subscription(planId, fixture.customerId), archived],
      has_more: false,
    });
    context.mocks.stripe.invoices.list.mockResolvedValue({
      data: [
        paidInvoice("in_live_delete_only", fixture.customerId, planId, [
          subscriptionLine(
            1000,
            deletionTimestamp - 800,
            deletionTimestamp + 200,
          ),
        ]),
      ],
      has_more: false,
    });
    context.mocks.stripe.creditNotes.preview.mockResolvedValue(
      creditNote("preview_live_only", 200),
    );
    context.mocks.stripe.creditNotes.create.mockResolvedValue(
      creditNote("cn_live_only", 200),
    );
    const response = await accept(requestOrgDeletion(), [200]);
    expect(response.body).toStrictEqual({ message: "Organization deleted" });
    expect(context.mocks.stripe.subscriptions.cancel).toHaveBeenCalledOnce();
    expect(context.mocks.stripe.subscriptions.cancel).toHaveBeenCalledWith(
      planId,
      { invoice_now: false, prorate: false },
      { idempotencyKey: `org-delete:${fixture.orgId}:${planId}:cancel` },
    );
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalledWith(
      archiveId,
      expect.anything(),
      expect.anything(),
    );
    expect(context.mocks.stripe.creditNotes.create).toHaveBeenCalledOnce();
  },
);

test.each([
  "invoice price binding",
  "parent price binding",
  "Product metadata",
  "archived invoice header",
  "archived parent header",
  "shared archived concurrency header",
])(
  "refunds only ordinary paid portions across paginated %s identities",
  async (source) => {
    const deletionTimestamp = 1_800_000_000;
    const fixture = createOrgDeleteBillingFixture();
    const subscriptionId = `sub_mixed_delete_${randomUUID()}`;
    await seedPlanSubscription(
      fixture,
      subscriptionId,
      deletionTimestamp + 200,
    );
    mockNow(deletionTimestamp * 1000);
    mockOrgDeletion(fixture);
    const product = {
      id: "prod_refund_archive",
      name: "Archived Allowance",
      metadata: { purpose: "usage_allowance" },
    };
    const ordinary = {
      ...subscriptionLine(
        1000,
        deletionTimestamp - 800,
        deletionTimestamp + 200,
      ),
      price: {
        id:
          source === "shared archived concurrency header"
            ? TEST_PRICE_CONCURRENCY
            : "price_test_pro",
      },
    };
    const archived = {
      ...subscriptionLine(
        2000,
        deletionTimestamp - 800,
        deletionTimestamp + 200,
      ),
      price: {
        id: "price_refund_archive",
        ...(source === "Product metadata" ? { product } : {}),
      },
    };
    const invoice = {
      ...paidInvoice(
        "in_mixed_delete_archive",
        fixture.customerId,
        subscriptionId,
        [ordinary],
        true,
      ),
      metadata:
        source === "invoice price binding"
          ? { allowancePriceId: archived.price.id }
          : source === "archived invoice header" ||
              source === "shared archived concurrency header"
            ? { purpose: "usage_allowance" }
            : {},
      parent: {
        subscription_details: {
          subscription: subscriptionId,
          metadata:
            source === "parent price binding"
              ? { allowancePriceId: archived.price.id }
              : source === "archived parent header"
                ? { purpose: "usage_allowance" }
                : {},
        },
      },
    };
    const headerOnly =
      source === "archived invoice header" ||
      source === "archived parent header";
    context.mocks.stripe.subscriptions.list.mockResolvedValue({
      data: [subscription(subscriptionId, fixture.customerId)],
      has_more: false,
    });
    context.mocks.stripe.invoices.list.mockResolvedValue({
      data: headerOnly
        ? [
            paidInvoice(
              "in_live_delete_portion",
              fixture.customerId,
              subscriptionId,
              [ordinary],
            ),
            invoice,
          ]
        : [invoice],
      has_more: false,
    });
    context.mocks.stripe.invoices.listLineItems
      .mockResolvedValueOnce({ data: [ordinary], has_more: true })
      .mockResolvedValueOnce({ data: [archived], has_more: false });
    context.mocks.stripe.creditNotes.preview.mockResolvedValue(
      creditNote("preview_mixed_archive", 200),
    );
    context.mocks.stripe.creditNotes.create.mockResolvedValue(
      creditNote("cn_mixed_archive", 200),
    );
    await accept(requestOrgDeletion(), [200]);
    expect(context.mocks.stripe.invoices.listLineItems).toHaveBeenCalledTimes(
      2,
    );
    expect(context.mocks.stripe.creditNotes.create).toHaveBeenCalledOnce();
    expect(context.mocks.stripe.creditNotes.create).toHaveBeenCalledWith(
      expect.objectContaining({
        invoice: headerOnly ? "in_live_delete_portion" : invoice.id,
        amount: 200,
        refund_amount: 200,
      }),
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
  },
);

test("refunds every paginated invoice line", async () => {
  const deletionTimestamp = 1_800_000_000;
  const periodStart = deletionTimestamp - 500;
  const periodEnd = deletionTimestamp + 500;
  const subscriptionId = "sub_delete_paginated_lines";
  const fixture = createOrgDeleteBillingFixture();
  const firstLine = subscriptionLine(600, periodStart, periodEnd);
  const secondLine = subscriptionLine(400, periodStart, periodEnd);
  if (!firstLine.id) {
    throw new Error("Expected invoice line ID");
  }
  await seedPlanSubscription(fixture, subscriptionId, periodEnd);
  mockNow(deletionTimestamp * 1000);
  mockOrgDeletion(fixture);
  context.mocks.stripe.subscriptions.list.mockResolvedValue({
    data: [subscription(subscriptionId, fixture.customerId)],
    has_more: false,
  });
  context.mocks.stripe.invoices.list.mockResolvedValue({
    data: [
      paidInvoice(
        "in_delete_paginated_lines",
        fixture.customerId,
        subscriptionId,
        [firstLine],
        true,
      ),
    ],
    has_more: false,
  });
  context.mocks.stripe.invoices.listLineItems
    .mockResolvedValueOnce({ data: [firstLine], has_more: true })
    .mockResolvedValueOnce({ data: [secondLine], has_more: false });
  context.mocks.stripe.creditNotes.preview.mockResolvedValue(
    creditNote("preview_paginated_lines", 500),
  );
  context.mocks.stripe.creditNotes.create.mockResolvedValue(
    creditNote("cn_paginated_lines", 500),
  );

  await accept(requestOrgDeletion(), [200]);

  expect(context.mocks.stripe.invoices.listLineItems).toHaveBeenNthCalledWith(
    1,
    "in_delete_paginated_lines",
    { limit: 100 },
  );
  expect(context.mocks.stripe.invoices.listLineItems).toHaveBeenNthCalledWith(
    2,
    "in_delete_paginated_lines",
    { limit: 100, starting_after: firstLine.id },
  );
  expect(context.mocks.stripe.creditNotes.preview).toHaveBeenCalledWith(
    expect.objectContaining({
      invoice: "in_delete_paginated_lines",
      amount: 500,
    }),
  );
});

test("deletes an org without Stripe calls when it has no billing references", async () => {
  const fixture = createOrgDeleteBillingFixture();
  mockOrgDeletion(fixture);

  const response = await accept(requestOrgDeletion(), [200]);

  expect(response.body).toStrictEqual({ message: "Organization deleted" });
  expect(context.mocks.stripe.subscriptions.list).not.toHaveBeenCalled();
  expect(context.mocks.stripe.subscriptions.cancel).not.toHaveBeenCalled();
  expect(context.mocks.stripe.creditNotes.create).not.toHaveBeenCalled();
});

test("does not refund non-subscription purchases for an org customer", async () => {
  const fixture = createOrgDeleteBillingFixture();
  await postOneTimePurchaseCompleted(context.signal, {
    orgId: fixture.orgId,
    credits: 100_000,
  });
  mockOrgDeletion(fixture);

  const response = await accept(requestOrgDeletion(), [200]);

  expect(response.body).toStrictEqual({ message: "Organization deleted" });
  expect(context.mocks.stripe.subscriptions.list).not.toHaveBeenCalled();
  expect(context.mocks.stripe.invoices.list).not.toHaveBeenCalled();
  expect(context.mocks.stripe.creditNotes.create).not.toHaveBeenCalled();
});

test("cancels trials and unpaid subscriptions without inventing a refund", async () => {
  const trialId = "sub_delete_trial";
  const unpaidId = "sub_delete_unpaid";
  const fixture = createOrgDeleteBillingFixture();
  await seedPlanSubscription(fixture, trialId);
  mockOrgDeletion(fixture);
  context.mocks.stripe.subscriptions.list.mockResolvedValue({
    data: [
      subscription(trialId, fixture.customerId, { status: "trialing" }),
      subscription(unpaidId, fixture.customerId, { status: "unpaid" }),
    ],
    has_more: false,
  });
  context.mocks.stripe.invoices.list.mockResolvedValue({
    data: [],
    has_more: false,
  });

  await accept(requestOrgDeletion(), [200]);

  expect(context.mocks.stripe.subscriptions.cancel).toHaveBeenCalledTimes(2);
  expect(context.mocks.stripe.creditNotes.preview).not.toHaveBeenCalled();
  expect(context.mocks.stripe.creditNotes.create).not.toHaveBeenCalled();
});

test("cancels fully discounted subscriptions without inventing a refund", async () => {
  const deletionTimestamp = 1_800_000_000;
  const periodStart = deletionTimestamp - 500;
  const periodEnd = deletionTimestamp + 500;
  const subscriptionId = "sub_delete_fully_discounted";
  const fixture = createOrgDeleteBillingFixture();
  await seedPlanSubscription(fixture, subscriptionId, periodEnd);
  mockNow(deletionTimestamp * 1000);
  mockOrgDeletion(fixture);
  context.mocks.stripe.subscriptions.list.mockResolvedValue({
    data: [subscription(subscriptionId, fixture.customerId)],
    has_more: false,
  });
  const invoiceLine = {
    ...subscriptionLine(1000, periodStart, periodEnd),
    discount_amounts: [{ amount: 1000 }],
  };
  context.mocks.stripe.invoices.list.mockResolvedValue({
    data: [
      {
        ...paidInvoice(
          "in_delete_fully_discounted",
          fixture.customerId,
          subscriptionId,
          [invoiceLine],
        ),
        amount_due: 0,
      },
    ],
    has_more: false,
  });

  await accept(requestOrgDeletion(), [200]);

  expect(context.mocks.stripe.subscriptions.cancel).toHaveBeenCalledOnce();
  expect(context.mocks.stripe.creditNotes.preview).not.toHaveBeenCalled();
  expect(context.mocks.stripe.creditNotes.create).not.toHaveBeenCalled();
  expect(
    context.mocks.clerk.organizations.deleteOrganization,
  ).toHaveBeenCalledOnce();
});

test("nets upgrade credits and excludes one-time invoice items from proration", async () => {
  const deletionTimestamp = 1_800_000_000;
  const originalStart = deletionTimestamp - 600;
  const periodEnd = deletionTimestamp + 400;
  const upgradeStart = deletionTimestamp - 400;
  const subscriptionId = "sub_delete_upgraded";
  const fixture = createOrgDeleteBillingFixture();
  await seedPlanSubscription(fixture, subscriptionId, periodEnd);
  mockNow(deletionTimestamp * 1000);
  mockOrgDeletion(fixture);
  context.mocks.stripe.subscriptions.list.mockResolvedValue({
    data: [subscription(subscriptionId, fixture.customerId)],
    has_more: false,
  });
  context.mocks.stripe.invoices.list.mockResolvedValue({
    data: [
      paidInvoice("in_delete_original", fixture.customerId, subscriptionId, [
        subscriptionLine(1000, originalStart, periodEnd, 100),
        oneTimeLine(2000, originalStart, periodEnd),
      ]),
      paidInvoice("in_delete_upgrade", fixture.customerId, subscriptionId, [
        subscriptionLine(-600, upgradeStart, periodEnd),
        subscriptionLine(1200, upgradeStart, periodEnd),
      ]),
    ],
    has_more: false,
  });
  context.mocks.stripe.creditNotes.preview
    .mockResolvedValueOnce(creditNote("preview_original", 440))
    .mockResolvedValueOnce(creditNote("preview_upgrade", 300));
  context.mocks.stripe.creditNotes.create
    .mockResolvedValueOnce(creditNote("cn_original", 440))
    .mockResolvedValueOnce(creditNote("cn_upgrade", 300));

  await accept(requestOrgDeletion(), [200]);

  expect(context.mocks.stripe.creditNotes.preview).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({ invoice: "in_delete_original", amount: 440 }),
  );
  expect(context.mocks.stripe.creditNotes.preview).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ invoice: "in_delete_upgrade", amount: 300 }),
  );
});

test("nets a separate downgrade credit before refunding unused time", async () => {
  const deletionTimestamp = 1_800_000_000;
  const periodStart = deletionTimestamp - 750;
  const periodEnd = deletionTimestamp + 250;
  const downgradeStart = deletionTimestamp - 250;
  const subscriptionId = "sub_delete_downgraded";
  const fixture = createOrgDeleteBillingFixture();
  await seedPlanSubscription(fixture, subscriptionId, periodEnd);
  mockNow(deletionTimestamp * 1000);
  mockOrgDeletion(fixture);
  context.mocks.stripe.subscriptions.list.mockResolvedValue({
    data: [subscription(subscriptionId, fixture.customerId)],
    has_more: false,
  });
  context.mocks.stripe.invoices.list.mockResolvedValue({
    data: [
      paidInvoice("in_delete_original", fixture.customerId, subscriptionId, [
        subscriptionLine(2000, periodStart, periodEnd),
      ]),
      paidInvoice("in_delete_downgrade", fixture.customerId, subscriptionId, [
        subscriptionLine(-1000, downgradeStart, periodEnd),
        subscriptionLine(500, downgradeStart, periodEnd),
      ]),
    ],
    has_more: false,
  });
  context.mocks.stripe.creditNotes.preview.mockResolvedValue(
    creditNote("preview_downgrade", 250),
  );
  context.mocks.stripe.creditNotes.create.mockResolvedValue(
    creditNote("cn_downgrade", 250),
  );

  await accept(requestOrgDeletion(), [200]);

  expect(context.mocks.stripe.creditNotes.preview).toHaveBeenCalledOnce();
  expect(context.mocks.stripe.creditNotes.preview).toHaveBeenCalledWith(
    expect.objectContaining({ invoice: "in_delete_original", amount: 250 }),
  );
  expect(context.mocks.stripe.creditNotes.create).toHaveBeenCalledOnce();
});

test("reuses a prior deletion marker and issued credit note on retry", async () => {
  const deletionTimestamp = 1_800_000_000;
  const periodStart = deletionTimestamp - 600;
  const periodEnd = deletionTimestamp + 400;
  const subscriptionId = "sub_delete_retry";
  const historicalSubscriptionId = "sub_delete_historical";
  const fixture = createOrgDeleteBillingFixture();
  await seedPlanSubscription(fixture, subscriptionId, periodEnd);
  mockOrgDeletion(fixture);
  const metadata = {
    purpose: "org_deletion_prorated_refund",
    orgId: fixture.orgId,
    subscriptionId,
    deletionAt: String(deletionTimestamp),
  };
  context.mocks.stripe.subscriptions.list.mockResolvedValue({
    data: [
      subscription(historicalSubscriptionId, fixture.customerId, {
        status: "canceled",
      }),
      subscription(subscriptionId, fixture.customerId, {
        status: "canceled",
        metadata: {
          vm0_org_delete_org_id: fixture.orgId,
          vm0_org_delete_at: String(deletionTimestamp),
        },
      }),
    ],
    has_more: false,
  });
  context.mocks.stripe.invoices.list.mockResolvedValue({
    data: [
      paidInvoice("in_delete_retry", fixture.customerId, subscriptionId, [
        subscriptionLine(1000, periodStart, periodEnd),
      ]),
    ],
    has_more: false,
  });
  context.mocks.stripe.creditNotes.list.mockResolvedValue({
    data: [creditNote("cn_delete_retry", 400, metadata)],
    has_more: false,
  });

  await accept(requestOrgDeletion(), [200]);

  expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
  expect(context.mocks.stripe.subscriptions.cancel).not.toHaveBeenCalled();
  expect(context.mocks.stripe.invoices.list).toHaveBeenCalledOnce();
  expect(context.mocks.stripe.invoices.list).toHaveBeenCalledWith({
    subscription: subscriptionId,
    status: "paid",
    limit: 100,
  });
  expect(context.mocks.stripe.creditNotes.preview).not.toHaveBeenCalled();
  expect(context.mocks.stripe.creditNotes.create).not.toHaveBeenCalled();
  expect(
    context.mocks.clerk.organizations.deleteOrganization,
  ).toHaveBeenCalledWith(fixture.orgId);
});

test("does not delete the org when its proportional refund fails", async () => {
  const deletionTimestamp = 1_800_000_000;
  const periodStart = deletionTimestamp - 500;
  const periodEnd = deletionTimestamp + 500;
  const subscriptionId = "sub_delete_refund_failure";
  const fixture = createOrgDeleteBillingFixture();
  const actor: ApiTestUser = {
    userId: fixture.userId,
    orgId: fixture.orgId,
    orgRole: "org:admin",
    email: "org-delete-refund-failure@example.test",
  };
  const misc = createMiscRoutesApi(context);

  mockNow(deletionTimestamp * 1000);
  await seedPlanSubscription(fixture, subscriptionId, periodEnd);
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [
      {
        role: "org:admin",
        organization: { id: fixture.orgId },
        publicUserData: { userId: fixture.userId },
      },
    ],
  });
  await misc.updatePreferences(
    actor,
    { timezone: "Asia/Shanghai", locale: "en-US" },
    [200],
  );
  const slackFixture = await slackOrgs.installOrg({
    actor,
    withConnection: true,
  });
  onTestFinished(() =>
    {return slackOrgs.uninstallWorkspace(slackFixture.slackWorkspaceId)},
  );
  mockOrgDeletion(fixture);
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    { data: [{ publicUserData: { userId: fixture.userId } }] },
  );
  context.mocks.stripe.subscriptions.list.mockResolvedValue({
    data: [subscription(subscriptionId, fixture.customerId)],
    has_more: false,
  });
  context.mocks.stripe.invoices.list.mockResolvedValue({
    data: [
      paidInvoice("in_delete_failure", fixture.customerId, subscriptionId, [
        subscriptionLine(1000, periodStart, periodEnd),
      ]),
    ],
    has_more: false,
  });
  context.mocks.stripe.creditNotes.preview.mockResolvedValue(
    creditNote("preview_failure", 500),
  );
  context.mocks.stripe.creditNotes.create.mockRejectedValue(
    new Error("Stripe refund unavailable"),
  );

  const response = await requestOrgDeletion();

  expect(response.status).toBe(500);
  expect(context.mocks.stripe.subscriptions.cancel).toHaveBeenCalledOnce();
  expect(
    context.mocks.clerk.organizations.deleteOrganization,
  ).not.toHaveBeenCalled();
  const preservedPreferences = await misc.readPreferences(actor);
  expect(preservedPreferences.body).toMatchObject({
    timezone: "Asia/Shanghai",
    locale: "en-US",
  });
  mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
  const slackStatus = await accept(
    setupApp({ context, routes: integrationsSlackRoutes })(
      integrationsSlackContract,
    ).getStatus({ headers: { authorization: "Bearer clerk-session" } }),
    [200],
  );
  expect(slackStatus.body).toMatchObject({
    isInstalled: true,
    isConnected: true,
    workspaceName: slackFixture.slackWorkspaceName,
  });
});

test("fails closed when a Stripe page has no continuation cursor", async () => {
  const subscriptionId = "sub_delete_incomplete_page";
  const fixture = createOrgDeleteBillingFixture();
  await seedPlanSubscription(fixture, subscriptionId);
  mockOrgDeletion(fixture);
  context.mocks.stripe.subscriptions.list.mockResolvedValue({
    data: [],
    has_more: true,
  });

  const response = await requestOrgDeletion();

  expect(response.status).toBe(500);
  expect(context.mocks.stripe.subscriptions.cancel).not.toHaveBeenCalled();
  expect(
    context.mocks.clerk.organizations.deleteOrganization,
  ).not.toHaveBeenCalled();
});

test("does not delete the org before its Stripe refund succeeds", async () => {
  const deletionTimestamp = 1_800_000_000;
  const periodStart = deletionTimestamp - 500;
  const periodEnd = deletionTimestamp + 500;
  const subscriptionId = "sub_delete_refund_pending";
  const fixture = createOrgDeleteBillingFixture();
  await seedPlanSubscription(fixture, subscriptionId, periodEnd);
  mockNow(deletionTimestamp * 1000);
  mockOrgDeletion(fixture);
  context.mocks.stripe.subscriptions.list.mockResolvedValue({
    data: [subscription(subscriptionId, fixture.customerId)],
    has_more: false,
  });
  context.mocks.stripe.invoices.list.mockResolvedValue({
    data: [
      paidInvoice("in_delete_pending", fixture.customerId, subscriptionId, [
        subscriptionLine(1000, periodStart, periodEnd),
      ]),
    ],
    has_more: false,
  });
  context.mocks.stripe.creditNotes.preview.mockResolvedValue(
    creditNote("preview_pending", 500),
  );
  context.mocks.stripe.creditNotes.create.mockResolvedValue(
    creditNote("cn_pending", 500, undefined, "pending"),
  );

  const response = await requestOrgDeletion();

  expect(response.status).toBe(500);
  expect(
    context.mocks.clerk.organizations.deleteOrganization,
  ).not.toHaveBeenCalled();
});

test("retries refunds on redelivery before cleaning a Clerk-deleted org", async () => {
  const deletionTimestamp = 1_800_000_000;
  const periodStart = deletionTimestamp - 500;
  const periodEnd = deletionTimestamp + 500;
  const subscriptionId = "sub_delete_clerk_webhook";
  const fixture = createOrgDeleteBillingFixture();
  const actor: ApiTestUser = {
    userId: fixture.userId,
    orgId: fixture.orgId,
    orgRole: "org:admin",
    email: "org-delete-clerk@example.test",
  };
  mockNow(deletionTimestamp * 1000);
  await seedPlanSubscription(fixture, subscriptionId, periodEnd);
  mockStripeClient(context.mocks.stripe as unknown as StripeSDK);
  mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

  context.mocks.stripe.subscriptions.list
    .mockResolvedValueOnce({
      data: [subscription(subscriptionId, fixture.customerId)],
      has_more: false,
    })
    .mockResolvedValueOnce({
      data: [
        subscription(subscriptionId, fixture.customerId, {
          status: "canceled",
          metadata: {
            vm0_org_delete_org_id: fixture.orgId,
            vm0_org_delete_at: String(deletionTimestamp),
          },
        }),
      ],
      has_more: false,
    });
  context.mocks.stripe.subscriptions.update.mockResolvedValue({});
  context.mocks.stripe.subscriptions.cancel.mockResolvedValue({});
  context.mocks.stripe.invoices.list.mockResolvedValue({
    data: [
      paidInvoice("in_delete_clerk", fixture.customerId, subscriptionId, [
        subscriptionLine(1000, periodStart, periodEnd),
      ]),
    ],
    has_more: false,
  });
  context.mocks.stripe.creditNotes.preview.mockResolvedValue(
    creditNote("preview_delete_clerk", 500),
  );
  context.mocks.stripe.creditNotes.create
    .mockRejectedValueOnce(new Error("Stripe refund unavailable"))
    .mockResolvedValueOnce(creditNote("cn_delete_clerk", 500));

  const webhooks = createWebhookCallbackApi(context);
  webhooks.configureClerkWebhookSecret();
  webhooks.verifyNextClerkWebhook({
    type: "organization.deleted",
    data: { id: fixture.orgId },
  });
  const firstDelivery = await webhooks.requestClerkWebhook("{}", {}, [503]);

  expect(firstDelivery.body).toStrictEqual({
    error: "Organization billing cleanup failed",
  });

  expect(context.mocks.stripe.subscriptions.cancel).toHaveBeenCalledOnce();
  expect(context.mocks.stripe.creditNotes.create).toHaveBeenCalledOnce();
  expect(
    (await createBillingMediaApi(context).readBillingStatus(actor))
      .hasSubscription,
  ).toBeTruthy();

  webhooks.verifyNextClerkWebhook({
    type: "organization.deleted",
    data: { id: fixture.orgId },
  });
  const redelivery = await webhooks.requestClerkWebhook("{}", {}, [200]);
  expect(redelivery.body).toBe("OK");
  await flushWaitUntilForTest();

  expect(context.mocks.stripe.subscriptions.cancel).toHaveBeenCalledOnce();
  expect(context.mocks.stripe.creditNotes.create).toHaveBeenCalledTimes(2);
  expect(context.mocks.stripe.creditNotes.create).toHaveBeenLastCalledWith(
    expect.objectContaining({
      invoice: "in_delete_clerk",
      amount: 500,
      refund_amount: 500,
    }),
    expect.objectContaining({
      idempotencyKey: `org-delete-refund:${fixture.orgId}:${subscriptionId}:in_delete_clerk:${deletionTimestamp}`,
    }),
  );
  expect(
    (await createBillingMediaApi(context).readBillingStatus(actor))
      .hasSubscription,
  ).toBeFalsy();
});
