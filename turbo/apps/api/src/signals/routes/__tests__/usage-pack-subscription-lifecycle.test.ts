import { setupApp } from "../../../__tests__/test-helpers";
import { randomUUID } from "node:crypto";
import { now } from "../../../lib/time";
import { createRouteMocks } from "./helpers/route-test";
import {
  billingStatusContract,
  billingUsagePackCheckoutContract,
  billingUsagePackCreditsContract,
  billingUsagePackManagementContract,
} from "@okouai/api-contracts/contracts/billing";
import {
  webhookClerkContract,
  webhookStripeContract,
} from "@okouai/api-contracts/contracts/webhooks";
import { describe, expect, it } from "vitest";

import { apiTestEnvironment } from "../../../__tests__/test-environment";
import { testContext, accept } from "../../../__tests__/test-context";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { billingCheckoutRoutes } from "../billing-checkout";
import { billingStatusRoutes } from "../billing-status";
import { billingUsagePackCreditsRoutes } from "../billing-usage-pack-credits";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { webhooksStripeRoutes } from "../webhooks-stripe";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { purchaseUsagePacks } from "./helpers/public-usage-pack-checkout";

const context = testContext();

const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const PLAN_PRICE = "price_public_usage_plan";
const PACK_20 = "price_public_usage_20";
const PRO_PRICE = apiTestEnvironment.OKOU_PRICE_PRO;
const TEAM_PRICE = apiTestEnvironment.OKOU_PRICE_TEAM;
const DAY = 86_400;

type InvoiceEvent = Awaited<ReturnType<typeof purchaseUsagePacks>>;
type InvoiceLine = InvoiceEvent["data"]["object"]["lines"]["data"][number];

function isoAt(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function workspace() {
  const admin: ApiTestUser = {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
    orgRole: "org:admin",
    email: `admin-${randomUUID()}@example.test`,
  };
  const orgId = admin.orgId ?? "";
  mockOptionalEnv("STRIPE_WEBHOOK_SECRET", "whsec_usage_pack_lifecycle");
  const appFor = setupApp({
    context,
    routes: [
      ...billingStatusRoutes,
      ...billingUsagePackCreditsRoutes,
      ...webhooksStripeRoutes,
    ],
  });
  const status = appFor(billingStatusContract);
  const credits = appFor(billingUsagePackCreditsContract);
  const webhook = appFor(webhookStripeContract);

  function signIn() {
    createRouteMocks(context).clerk.session(admin.userId, orgId, "org:admin");
  }

  async function readStatus() {
    signIn();
    return (await accept(status.get({ headers }), [200])).body;
  }

  async function readCredits() {
    signIn();
    return (await accept(credits.get({ headers }), [200])).body;
  }

  /** The admin checks out a Pro usage-pack plan; Stripe has not paid it yet. */
  async function checkout(usd: 20 | 50 = 20) {
    return await purchaseUsagePacks(
      context,
      { userId: admin.userId, orgId },
      [{ userId: admin.userId, usd }],
      { deliveries: 0 },
    );
  }

  async function deliver(event: Readonly<Record<string, unknown>>) {
    context.mocks.stripe.webhooks.constructEventAsync.mockReturnValueOnce(
      event,
    );
    await accept(
      webhook.post({
        body: JSON.stringify(event),
        extraHeaders: { "stripe-signature": "t=1,v1=usage-pack-lifecycle" },
      }),
      [200],
    );
  }

  /** What Stripe reports for the usage-pack subscription of `invoice`. */
  function stripeSubscription(
    invoice: InvoiceEvent,
    period: { readonly start: number; readonly end: number },
    overrides: Readonly<Record<string, unknown>> = {},
  ) {
    const object = invoice.data.object;
    const subscription = {
      id: object.parent.subscription_details.subscription,
      customer: object.customer,
      status: "active",
      cancel_at: null,
      cancel_at_period_end: false,
      schedule: null,
      trial_end: null,
      metadata: object.metadata,
      items: {
        data: [
          {
            price: { id: PLAN_PRICE },
            quantity: 1,
            current_period_start: period.start,
            current_period_end: period.end,
          },
          ...object.lines.data.map((line) => {
            return {
              price: { id: line.price.id },
              quantity: line.quantity,
              current_period_start: period.start,
              current_period_end: period.end,
            };
          }),
        ],
      },
      ...overrides,
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(subscription);
    return subscription;
  }

  return {
    admin,
    orgId,
    readStatus,
    readCredits,
    checkout,
    deliver,
    stripeSubscription,
  };
}

interface LedgerSubscription {
  readonly id: string;
  readonly customer: string;
  readonly created: number;
  readonly status: string;
  readonly [key: string]: unknown;
}

function stringField(value: unknown, field: string): string | undefined {
  if (typeof value !== "object" || value === null || !(field in value)) {
    return undefined;
  }
  const candidate: unknown = Reflect.get(value, field);
  return typeof candidate === "string" ? candidate : undefined;
}

/** Stripe's view of the organization's subscriptions, invoices and refunds. */
function stripeLedger(customerId: string, orgId: string) {
  const subscriptions = new Map<string, LedgerSubscription>();
  const paidInvoices = new Map<string, { id: string; paidAt: number }[]>();
  const creditNotes: { invoice: string; metadata: unknown }[] = [];
  context.mocks.stripe.customers.retrieve.mockResolvedValue({
    id: customerId,
    metadata: { orgId },
  });
  context.mocks.stripe.subscriptions.retrieve.mockImplementation(
    (id: unknown) => {
      return Promise.resolve(subscriptions.get(String(id)));
    },
  );
  const usagePackPrices =
    context.mocks.stripe.prices.retrieve.getMockImplementation();
  context.mocks.stripe.prices.retrieve.mockImplementation((id: unknown) => {
    if (!String(id).startsWith("price_public_usage_")) {
      return Promise.resolve({
        id,
        active: true,
        currency: "usd",
        type: "recurring",
        unit_amount: id === TEAM_PRICE ? 20_000 : 2000,
        recurring: { interval: "month", interval_count: 1 },
        product: `prod_${String(id)}`,
      });
    }
    if (!usagePackPrices) {
      throw new Error("Stripe prices are not configured");
    }
    return usagePackPrices(id);
  });
  context.mocks.stripe.subscriptions.list.mockImplementation(
    (params: unknown) => {
      const customer = stringField(params, "customer") ?? customerId;
      return Promise.resolve({
        data: [...subscriptions.values()].filter((subscription) => {
          return subscription.customer === customer;
        }),
        has_more: false,
      });
    },
  );
  context.mocks.stripe.subscriptions.cancel.mockImplementation(
    (id: unknown) => {
      const current = subscriptions.get(String(id));
      if (!current) {
        throw new Error(`Unknown subscription ${String(id)}`);
      }
      const canceled = { ...current, status: "canceled" };
      subscriptions.set(current.id, canceled);
      return Promise.resolve(canceled);
    },
  );
  context.mocks.stripe.invoices.list.mockImplementation((params: unknown) => {
    const subscription = stringField(params, "subscription") ?? "";
    return Promise.resolve({
      data: (paidInvoices.get(subscription) ?? []).map((invoice) => {
        return {
          id: invoice.id,
          status: "paid",
          status_transitions: { paid_at: invoice.paidAt },
        };
      }),
      has_more: false,
    });
  });
  context.mocks.stripe.creditNotes.list.mockImplementation(
    (params: unknown) => {
      const invoice = stringField(params, "invoice");
      return Promise.resolve({
        data: creditNotes.filter((note) => {
          return note.invoice === invoice;
        }),
        has_more: false,
      });
    },
  );
  context.mocks.stripe.creditNotes.create.mockImplementation(
    (params: unknown) => {
      const note = {
        id: `cn_${randomUUID()}`,
        invoice: stringField(params, "invoice") ?? "",
        metadata:
          typeof params === "object" && params !== null && "metadata" in params
            ? params.metadata
            : {},
      };
      creditNotes.push(note);
      return Promise.resolve(note);
    },
  );

  /** A subscription Stripe created at `created` (seconds). */
  function subscription(
    id: string,
    created: number,
    priceId: string,
    extra: Readonly<Record<string, unknown>> = {},
  ): LedgerSubscription {
    const start = created;
    const end = start + 30 * DAY;
    const record: LedgerSubscription = {
      id,
      customer: customerId,
      created,
      status: "active",
      cancel_at: null,
      cancel_at_period_end: false,
      schedule: null,
      trial_end: null,
      metadata: {},
      items: {
        data: [
          {
            price: { id: priceId },
            quantity: 1,
            current_period_start: start,
            current_period_end: end,
          },
        ],
      },
      ...extra,
    };
    subscriptions.set(id, record);
    return record;
  }

  /** Stripe pays the first invoice of `subscriptionId` at `paidAt`. */
  function pay(subscriptionId: string, invoiceId: string, paidAt: number) {
    paidInvoices.set(subscriptionId, [{ id: invoiceId, paidAt }]);
  }

  return { subscription, pay };
}

/** The first paid invoice of a legacy Plan subscription. */
function planInvoice(
  customerId: string,
  subscriptionId: string,
  priceId: string,
  paidAt: number,
) {
  const end = paidAt + 30 * DAY;
  const invoiceId = `in_${randomUUID()}`;
  return {
    invoiceId,
    event: {
      id: `evt_${randomUUID()}`,
      type: "invoice.paid",
      created: paidAt,
      data: {
        object: {
          id: invoiceId,
          customer: customerId,
          metadata: {},
          billing_reason: "subscription_create",
          status: "paid",
          amount_paid: 2000,
          status_transitions: { paid_at: paidAt },
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
                id: `il_${randomUUID()}`,
                price: { id: priceId },
                quantity: 1,
                parent: { type: "subscription_item_details" },
                period: { start: paidAt, end },
              },
            ],
          },
        },
      },
    },
  };
}

/** The admin checks out $20 packs for themselves and a pending invitation. */
async function checkoutWithInvitation(admin: {
  userId: string;
  orgId: string;
}) {
  mockEnv("OKOU_PRICE_USAGE_PACK_PLAN_PRO", PLAN_PRICE);
  mockEnv("OKOU_PRICE_USAGE_PACK_20", PACK_20);
  createRouteMocks(context).clerk.session(
    admin.userId,
    admin.orgId,
    "org:admin",
  );
  const invitationId = `orginv_${randomUUID()}`;
  context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
    id: admin.orgId,
    name: "Usage pack lifecycle",
    slug: `lifecycle-${randomUUID()}`,
    createdBy: admin.userId,
    createdAt: now(),
  });
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: [
        {
          role: "org:admin",
          publicUserData: { userId: admin.userId },
          createdAt: now(),
        },
      ],
    },
  );
  context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
    {
      data: [
        {
          id: invitationId,
          emailAddress: `invitee-${randomUUID()}@example.test`,
          role: "org:member",
          status: "pending",
          createdAt: now(),
        },
      ],
    },
  );
  const customerId = `cus_${randomUUID()}`;
  const sessionId = `cs_${randomUUID()}`;
  const subscriptionId = `sub_${randomUUID()}`;
  context.mocks.stripe.customers.create.mockResolvedValueOnce({
    id: customerId,
  });
  let metadata: Readonly<Record<string, unknown>> = {};
  context.mocks.stripe.checkout.sessions.create.mockImplementationOnce(
    (input: unknown) => {
      if (typeof input === "object" && input !== null && "metadata" in input) {
        const candidate: unknown = input.metadata;
        metadata =
          typeof candidate === "object" && candidate !== null
            ? { ...candidate }
            : {};
      }
      return Promise.resolve({
        id: sessionId,
        url: `https://checkout.stripe.test/${sessionId}`,
      });
    },
  );
  context.mocks.stripe.prices.retrieve.mockImplementation((id: unknown) => {
    return Promise.resolve({
      id,
      active: true,
      currency: "usd",
      type: "recurring",
      recurring: { interval: "month", interval_count: 1 },
      unit_amount: 2000,
      tax_behavior: "exclusive",
      product: {
        id: "prod_20",
        name: "Usage 20",
        metadata: { bonusCredits: "400" },
        tax_code: "txcd_10000000",
      },
    });
  });
  const origin = new URL(apiTestEnvironment.APP_URL).origin;
  await accept(
    setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackCheckoutContract,
    ).create({
      headers,
      body: {
        tier: "pro",
        memberUsagePacks: [
          { memberId: admin.userId, usagePackUsd: 20 },
          { memberId: invitationId, usagePackUsd: 20 },
        ],
        successUrl: `${origin}/billing`,
        cancelUrl: `${origin}/billing`,
      },
    }),
    [200],
  );
  const start = Math.floor(now() / 1000);
  const end = start + 30 * DAY;
  const subscription = {
    id: subscriptionId,
    customer: customerId,
    status: "active",
    cancel_at: null,
    cancel_at_period_end: false,
    schedule: null,
    trial_end: null,
    metadata,
    items: {
      data: [
        {
          price: { id: PLAN_PRICE },
          quantity: 1,
          current_period_start: start,
          current_period_end: end,
        },
        {
          price: { id: PACK_20 },
          quantity: 2,
          current_period_start: start,
          current_period_end: end,
        },
      ],
    },
  };
  context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(subscription);
  const session = {
    id: sessionId,
    object: "checkout.session",
    mode: "subscription",
    status: "complete",
    payment_status: "paid",
    customer: customerId,
    subscription: subscriptionId,
    metadata,
  };
  context.mocks.stripe.checkout.sessions.retrieve.mockResolvedValue(session);
  const invoice = {
    id: `in_${randomUUID()}`,
    customer: customerId,
    metadata,
    billing_reason: "subscription_create",
    status: "paid",
    paid: true,
    paid_out_of_band: false,
    currency: "usd",
    amount_paid: 4000,
    parent: {
      subscription_details: { subscription: subscriptionId, metadata },
    },
    lines: {
      has_more: false,
      data: [
        {
          id: `il_${randomUUID()}`,
          amount: 4000,
          subtotal: 4000,
          discount_amounts: [],
          quantity: 2,
          price: { id: PACK_20 },
          period: { start, end },
          parent: {
            type: "subscription_item_details",
            subscription_item_details: { proration: false },
          },
        },
      ],
    },
  };
  return { session, subscription, invoice, period: { start, end } };
}

function periodOf(invoice: InvoiceEvent) {
  const line = invoice.data.object.lines.data[0];
  if (!line) {
    throw new Error("expected an invoice line");
  }
  return line.period;
}

describe("usage pack subscription Stripe lifecycle", () => {
  it("usage-pack-subscription-lifecycle-005 shows usage packs after buying the new Pro plan", async () => {
    const ws = workspace();
    const invoice = await ws.checkout();

    await ws.deliver(invoice);

    await expect(ws.readStatus()).resolves.toMatchObject({
      tier: "pro",
      showUsagePack: true,
    });
  });

  it("usage-pack-subscription-lifecycle-003 floors prorated purchased and bonus credits independently", async () => {
    const ws = workspace();
    const invoice = await ws.checkout(50);
    const period = periodOf(invoice);
    const prorated: InvoiceEvent = {
      ...invoice,
      data: {
        object: {
          ...invoice.data.object,
          amount_paid: 1667,
          lines: {
            ...invoice.data.object.lines,
            data: invoice.data.object.lines.data.map((line): InvoiceLine => {
              return {
                ...line,
                amount: 1667,
                subtotal: 1667,
                parent: {
                  type: "subscription_item_details",
                  subscription_item_details: { proration: true },
                },
              };
            }),
          },
        },
      },
    };

    await ws.deliver(prorated);

    const body = await ws.readCredits();
    const grants = [
      expect.objectContaining({
        grantType: "bonus",
        amount: 866,
        remaining: 866,
        expiresAt: isoAt(period.end),
      }),
      expect.objectContaining({
        grantType: "purchased",
        amount: 16_670,
        remaining: 16_670,
        expiresAt: isoAt(period.end),
      }),
    ];
    expect(body).toMatchObject({
      purchasedCredits: 16_670,
      bonusCredits: 866,
      totalCredits: 17_536,
      hasUsagePack: true,
    });
    expect(body.creditGrants).toHaveLength(2);
    expect(body.creditGrants).toStrictEqual(expect.arrayContaining(grants));
    expect(body.memberCredits).toHaveLength(1);
    expect(body.memberCredits?.[0]).toMatchObject({
      memberId: ws.admin.userId,
      purchasedCredits: 16_670,
      bonusCredits: 866,
      totalCredits: 17_536,
    });
    expect(body.memberCredits?.[0]?.creditGrants).toStrictEqual(
      expect.arrayContaining(grants),
    );
  });

  it("usage-pack-subscription-lifecycle-009 keeps paid grants through cancellation and deletion", async () => {
    const ws = workspace();
    const invoice = await ws.checkout();
    await ws.deliver(invoice);
    const period = periodOf(invoice);
    const scheduled = ws.stripeSubscription(invoice, period, {
      cancel_at_period_end: true,
      cancel_at: period.end,
    });

    await ws.deliver({
      id: `evt_${randomUUID()}`,
      type: "customer.subscription.updated",
      created: period.start + 60,
      data: { object: scheduled },
    });

    await expect(ws.readStatus()).resolves.toMatchObject({
      tier: "pro",
      cancelAtPeriodEnd: true,
    });
    await expect(ws.readCredits()).resolves.toMatchObject({
      creditGrants: [expect.anything(), expect.anything()],
    });

    const deleted = ws.stripeSubscription(invoice, period, {
      status: "canceled",
      cancel_at_period_end: true,
      cancel_at: period.end,
    });
    await ws.deliver({
      id: `evt_${randomUUID()}`,
      type: "customer.subscription.deleted",
      created: period.start + 120,
      data: { object: deleted },
    });

    await expect(ws.readStatus()).resolves.toMatchObject({
      tier: "limited-free-1",
      hasSubscription: false,
      showUsagePack: false,
    });
    await expect(ws.readCredits()).resolves.toMatchObject({
      purchasedCredits: 20_000,
      bonusCredits: 400,
      creditGrants: [expect.anything(), expect.anything()],
    });
  });

  it("usage-pack-subscription-lifecycle-002 grants the renewal period once", async () => {
    const ws = workspace();
    const purchase = await checkoutWithInvitation({
      userId: ws.admin.userId,
      orgId: ws.orgId,
    });
    const event = (type: string, object: unknown) => {
      return {
        id: `evt_${randomUUID()}`,
        type,
        created: purchase.period.start,
        data: { object },
      };
    };
    await ws.deliver(event("checkout.session.completed", purchase.session));
    await ws.deliver(
      event("customer.subscription.created", purchase.subscription),
    );
    await ws.deliver(event("invoice.paid", purchase.invoice));
    const next = {
      start: purchase.period.end,
      end: purchase.period.end + 30 * DAY,
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      ...purchase.subscription,
      items: {
        data: purchase.subscription.items.data.map((item) => {
          return {
            ...item,
            current_period_start: next.start,
            current_period_end: next.end,
          };
        }),
      },
    });

    await ws.deliver(
      event("invoice.paid", {
        ...purchase.invoice,
        id: `in_${randomUUID()}`,
        billing_reason: "subscription_cycle",
        lines: {
          ...purchase.invoice.lines,
          data: purchase.invoice.lines.data.map((line) => {
            return { ...line, id: `il_${randomUUID()}`, period: next };
          }),
        },
      }),
    );

    const body = await ws.readCredits();
    expect(body.creditGrants).toHaveLength(4);
    expect(
      body.creditGrants.filter((grant) => {
        return grant.expiresAt === isoAt(next.end);
      }),
    ).toHaveLength(2);
  });

  it("usage-pack-subscription-lifecycle-011 keeps personal onboarding credits through the first purchase", async () => {
    const ws = workspace();
    const api = createBddApi(context);
    const invoice = await ws.checkout();
    await api.provisionWorkspace(ws.admin);
    await api.completeOnboarding(ws.admin);
    await expect(ws.readStatus()).resolves.toMatchObject({
      tier: "limited-free-1",
      credits: 0,
      creditGrants: [],
    });
    await expect(ws.readCredits()).resolves.toMatchObject({
      totalCredits: 1000,
      bonusCredits: 1000,
      purchasedCredits: 0,
      hasUsagePack: false,
    });

    await ws.deliver(invoice);

    await expect(ws.readStatus()).resolves.toMatchObject({
      tier: "pro",
      credits: 0,
    });
    const paid = await ws.readCredits();
    expect(paid).toMatchObject({
      totalCredits: 21_400,
      purchasedCredits: 20_000,
      bonusCredits: 1400,
      hasUsagePack: true,
    });
    expect(paid.creditGrants).toHaveLength(3);
    expect(paid.creditGrants).toContainEqual(
      expect.objectContaining({ grantType: "bonus", amount: 1000 }),
    );

    await ws.deliver({ ...invoice, id: `evt_${randomUUID()}` });

    await expect(ws.readCredits()).resolves.toStrictEqual(paid);
  });
  it("usage-pack-subscription-lifecycle-021 keeps the first paid Plan of duplicate initial purchases", async () => {
    const ws = workspace();
    const customerId = `cus_${randomUUID()}`;
    const ledger = stripeLedger(customerId, ws.orgId);
    const t = Math.floor(now() / 1000);
    const pro = ledger.subscription(`sub_${randomUUID()}`, t - 300, PRO_PRICE);
    const team = ledger.subscription(
      `sub_${randomUUID()}`,
      t - 200,
      TEAM_PRICE,
    );
    const proInvoice = planInvoice(customerId, pro.id, PRO_PRICE, t - 100);
    const teamInvoice = planInvoice(customerId, team.id, TEAM_PRICE, t - 50);
    ledger.pay(pro.id, proInvoice.invoiceId, t - 100);
    ledger.pay(team.id, teamInvoice.invoiceId, t - 50);

    await ws.deliver(proInvoice.event);
    await ws.deliver(teamInvoice.event);
    await ws.deliver({ ...teamInvoice.event, id: `evt_${randomUUID()}` });
    await ws.deliver({ ...proInvoice.event, id: `evt_${randomUUID()}` });

    const status = await ws.readStatus();
    expect(status.tier).toBe("pro");
    expect(status.creditGrants).toHaveLength(1);
    expect(context.mocks.stripe.creditNotes.create).toHaveBeenCalledTimes(1);
    expect(context.mocks.stripe.creditNotes.create).toHaveBeenCalledWith(
      expect.objectContaining({
        invoice: teamInvoice.invoiceId,
        reason: "duplicate",
      }),
      expect.anything(),
    );
    expect(context.mocks.stripe.subscriptions.cancel).toHaveBeenCalledTimes(1);
  });

  it("usage-pack-subscription-lifecycle-018 grants the Plan once and refunds the later usage pack payment once", async () => {
    const ws = workspace();
    const usageInvoice = await ws.checkout();
    const usage = usageInvoice.data.object;
    const customerId = usage.customer;
    const t = Math.floor(now() / 1000);
    const usageSubscriptionId = usage.parent.subscription_details.subscription;
    const usageSubscription = ws.stripeSubscription(
      usageInvoice,
      periodOf(usageInvoice),
    );
    const ledger = stripeLedger(customerId, ws.orgId);
    const plan = ledger.subscription(`sub_${randomUUID()}`, t - 300, PRO_PRICE);
    ledger.subscription(usageSubscriptionId, t - 200, PLAN_PRICE, {
      ...usageSubscription,
      created: t - 200,
    });
    const planPaid = planInvoice(customerId, plan.id, PRO_PRICE, t - 100);
    ledger.pay(plan.id, planPaid.invoiceId, t - 100);
    ledger.pay(usageSubscriptionId, usage.id, t - 50);
    const usagePaid = {
      ...usageInvoice,
      data: {
        object: {
          ...usage,
          billing_reason: "subscription_create",
          status_transitions: { paid_at: t - 50 },
        },
      },
    };

    await ws.deliver(planPaid.event);
    await ws.deliver(usagePaid);
    await ws.deliver({ ...usagePaid, id: `evt_${randomUUID()}` });
    await ws.deliver({ ...planPaid.event, id: `evt_${randomUUID()}` });

    const status = await ws.readStatus();
    expect(status.tier).toBe("pro");
    expect(status.creditGrants).toHaveLength(1);
    await expect(ws.readCredits()).resolves.toMatchObject({
      creditGrants: [],
    });
    expect(context.mocks.stripe.creditNotes.create).toHaveBeenCalledTimes(1);
    expect(context.mocks.stripe.creditNotes.create).toHaveBeenCalledWith(
      expect.objectContaining({ invoice: usage.id, reason: "duplicate" }),
      { idempotencyKey: `duplicate-subscription:${usage.id}:refund` },
    );
    expect(context.mocks.stripe.subscriptions.cancel).toHaveBeenCalledTimes(1);
    expect(context.mocks.stripe.subscriptions.cancel).toHaveBeenCalledWith(
      usageSubscriptionId,
      { invoice_now: false, prorate: false },
      {
        idempotencyKey: `duplicate-subscription:${usageSubscriptionId}:cancel`,
      },
    );
  });

  it("usage-pack-subscription-lifecycle-024 upgrades a paid Plan created earlier without refunding it", async () => {
    const ws = workspace();
    const usageInvoice = await ws.checkout();
    const customerId = usageInvoice.data.object.customer;
    const ledger = stripeLedger(customerId, ws.orgId);
    const t = Math.floor(now() / 1000);
    const pro = ledger.subscription(`sub_${randomUUID()}`, t - 600, PRO_PRICE);
    const proPaid = planInvoice(customerId, pro.id, PRO_PRICE, t - 500);
    ledger.pay(pro.id, proPaid.invoiceId, t - 500);
    const team = ledger.subscription(
      `sub_${randomUUID()}`,
      t - 440,
      TEAM_PRICE,
    );
    const teamPaid = planInvoice(customerId, team.id, TEAM_PRICE, t - 400);
    ledger.pay(team.id, teamPaid.invoiceId, t - 400);

    await ws.deliver(proPaid.event);
    await ws.deliver(teamPaid.event);
    await ws.deliver({ ...teamPaid.event, id: `evt_${randomUUID()}` });

    await expect(ws.readStatus()).resolves.toMatchObject({ tier: "team" });
    expect(context.mocks.stripe.creditNotes.create).not.toHaveBeenCalled();
  });
  it("usage-pack-subscription-lifecycle-004 grants a fully discounted pack and revokes it without a refund", async () => {
    const ws = workspace();
    const invoice = await ws.checkout();
    const subscription = ws.stripeSubscription(invoice, periodOf(invoice));
    await ws.deliver({
      id: `evt_${randomUUID()}`,
      type: "customer.subscription.created",
      created: periodOf(invoice).start,
      data: { object: subscription },
    });
    // Stripe lists the full discount on each line of the zero-paid invoice.
    const discounted = {
      ...invoice,
      data: {
        object: {
          ...invoice.data.object,
          amount_paid: 0,
          lines: {
            ...invoice.data.object.lines,
            data: invoice.data.object.lines.data.map((line) => {
              return {
                ...line,
                discount_amounts: [
                  { amount: line.amount, discount: "di_full_discount" },
                ],
              };
            }),
          },
        },
      },
    };

    await ws.deliver(discounted);

    await expect(ws.readCredits()).resolves.toMatchObject({
      purchasedCredits: 20_000,
      bonusCredits: 400,
    });

    const remaining = `user_${randomUUID()}`;
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            role: "org:admin",
            publicUserData: { userId: remaining },
            createdAt: now(),
          },
        ],
      },
    );
    context.mocks.clerk.verifyWebhook.mockResolvedValue({
      type: "organizationMembership.deleted",
      data: {
        organization: { id: ws.orgId },
        public_user_data: { user_id: ws.admin.userId },
      },
    });
    await accept(
      setupApp({ context, routes: webhooksClerkRoutes })(
        webhookClerkContract,
      ).post({
        body: JSON.stringify({ type: "organizationMembership.deleted" }),
        extraHeaders: {
          "svix-id": `msg_${randomUUID()}`,
          "svix-timestamp": String(Math.floor(now() / 1000)),
          "svix-signature": "v1,signed-by-clerk",
        },
      }),
      [200],
    );
    await flushWaitUntilForTest();

    expect(context.mocks.stripe.refunds.create).not.toHaveBeenCalled();
    expect(context.mocks.stripe.creditNotes.create).not.toHaveBeenCalled();
    createRouteMocks(context).clerk.session(remaining, ws.orgId, "org:admin");
    const seen = await accept(
      setupApp({ context, routes: billingUsagePackCreditsRoutes })(
        billingUsagePackCreditsContract,
      ).get({ headers }),
      [200],
    );
    expect(
      (seen.body.memberCredits ?? []).flatMap((member) => {
        return member.creditGrants;
      }),
    ).toStrictEqual([]);
  });
  it("usage-pack-subscription-lifecycle-001 grants the initial payment once despite repeated deliveries", async () => {
    const ws = workspace();
    const purchase = await checkoutWithInvitation({
      userId: ws.admin.userId,
      orgId: ws.orgId,
    });
    const event = (type: string, object: unknown) => {
      return {
        id: `evt_${randomUUID()}`,
        type,
        created: purchase.period.start,
        data: { object },
      };
    };

    await ws.deliver(event("checkout.session.completed", purchase.session));
    await ws.deliver(event("checkout.session.completed", purchase.session));
    await ws.deliver(
      event("customer.subscription.created", purchase.subscription),
    );
    await expect(ws.readCredits()).resolves.toMatchObject({
      creditGrants: [],
    });
    await expect(ws.readStatus()).resolves.toMatchObject({
      tier: "limited-free-1",
      hasSubscription: true,
    });

    const paid = event("invoice.paid", purchase.invoice);
    await ws.deliver(paid);
    await ws.deliver(paid);

    const credits = await ws.readCredits();
    const expiresAt = isoAt(purchase.period.end);
    expect(credits.creditGrants).toHaveLength(2);
    expect(credits.creditGrants).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ grantType: "bonus", amount: 400, expiresAt }),
        expect.objectContaining({
          grantType: "purchased",
          amount: 20_000,
          expiresAt,
        }),
      ]),
    );
    createRouteMocks(context).clerk.session(
      ws.admin.userId,
      ws.orgId,
      "org:admin",
    );
    const management = await accept(
      setupApp({ context, routes: billingCheckoutRoutes })(
        billingUsagePackManagementContract,
      ).get({ headers }),
      [200],
    );
    expect(
      management.body.allocations.filter((allocation) => {
        return allocation.memberId === ws.admin.userId;
      }),
    ).toStrictEqual([expect.objectContaining({ usagePackUsd: 20 })]);
    await expect(ws.readStatus()).resolves.toMatchObject({
      tier: "pro",
      credits: 0,
    });
  });
});
