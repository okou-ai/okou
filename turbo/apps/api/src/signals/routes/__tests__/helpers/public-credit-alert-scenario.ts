import { chargePublicDataUsage } from "./public-data-charge";
import { randomBytes, randomUUID } from "node:crypto";
import { expect, vi } from "vitest";
import { z } from "zod";
import { Webhook } from "svix";
import {
  billingAutoRechargeContract,
  billingStatusContract,
  billingUsagePackCheckoutContract,
  billingUsagePackCreditsContract,
} from "@okouai/api-contracts/contracts/billing";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { createApp } from "../../../../app-factory";
import { mockOptionalEnv } from "../../../../lib/env";
import { mockNow, now } from "../../../../lib/time";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import {
  mockStripeClient,
  type StripeCheckoutSession,
  type StripeCreditNote,
  type StripeCustomer,
  type StripeInvoice,
  type StripePaymentMethod,
  type StripePrice,
  type StripeSubscription,
} from "../../../external/stripe-client";
import { billingAutoRechargeRoutes } from "../../billing-auto-recharge";
import { billingCheckoutRoutes } from "../../billing-checkout";
import { billingStatusRoutes } from "../../billing-status";
import { billingUsagePackCreditsRoutes } from "../../billing-usage-pack-credits";
import { webhooksClerkRoutes } from "../../webhooks-clerk";
import { webhooksStripeRoutes } from "../../webhooks-stripe";
import { createBddApi, type ApiTestUser } from "./api-bdd";
import { createRunsApi } from "./api-bdd-runs";
import { ClerkTransportTestError } from "./clerk-transport-error";
import { createFixtureOperationOwner } from "./fixture-operation-owner";
import { mockClerkUsers } from "./clerk-users";
import { createRouteMocks } from "./route-test";

type FixtureStripePrice = StripePrice & { readonly unit_amount: number };
type FixtureStripeCheckoutSession = StripeCheckoutSession & {
  readonly amount_total: number;
  readonly amount_subtotal: number;
};
type FixtureStripeInvoice = StripeInvoice & { readonly subtotal: number };

const metadataSchema = z.record(z.string(), z.string());
const checkoutSchema = z.object({
  mode: z.literal("subscription"),
  customer: z.string(),
  line_items: z.array(
    z.object({ price: z.string(), quantity: z.number().int().positive() }),
  ),
  metadata: metadataSchema,
  subscription_data: z.object({ metadata: metadataSchema }),
});
const createInvoiceSchema = z.object({
  customer: z.string(),
  default_payment_method: z.string(),
  auto_advance: z.literal(false),
  metadata: metadataSchema,
});
const itemSchema = z.object({
  invoice: z.string(),
  customer: z.string(),
  amount: z.number().int().positive(),
  currency: z.literal("usd"),
  description: z.string(),
});
const idSchema = z.string().min(1);
function required<T>(values: ReadonlyMap<string, T>, input: unknown): T {
  const id = idSchema.parse(input);
  const value = values.get(id);
  if (!value) {
    throw new Error(`Unknown case-owned provider identity ${id}`);
  }
  return value;
}
function membership(actor: ApiTestUser, role: "org:admin" | "org:member") {
  return {
    id: `membership_${actor.userId}`,
    createdAt: now(),
    role,
    organization: { id: actor.orgId },
    publicUserData: { userId: actor.userId },
  };
}

export async function createPublicCreditAlertScenario(context: TestContext) {
  mockNow(now());
  const bdd = createBddApi(context);
  const admin = bdd.user();
  const member = bdd.user({ orgId: admin.orgId, orgRole: "org:member" });
  if (!admin.orgId) {
    throw new Error("Expected a case-owned workspace");
  }
  const orgId = admin.orgId;
  const customers = new Map<string, StripeCustomer>();
  const sessions = new Map<string, FixtureStripeCheckoutSession>();
  const carts = new Map<string, z.infer<typeof checkoutSchema>>();
  const subscriptions = new Map<string, StripeSubscription>();
  const invoices = new Map<string, FixtureStripeInvoice>();
  const cards = new Map<string, StripePaymentMethod>();
  const creditNotes = new Map<string, StripeCreditNote>();
  const noteInvoices = new Map<string, string>();
  let rechargeInvoiceId: string | undefined;
  const stripeSecret = `whsec_${randomUUID()}`;
  const clerkSecret = `whsec_${randomBytes(32).toString("base64")}`;

  // Register before onboarding, token issuance, Checkout or any ordinary write.
  const owner = createFixtureOperationOwner(async () => {
    await flushWaitUntilForTest();
    context.mocks.s3.send.mockResolvedValue({
      Contents: [],
      IsTruncated: false,
    });
    const clerkSdk = await vi.importActual<
      typeof import("@clerk/backend/webhooks")
    >("@clerk/backend/webhooks");
    mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", clerkSecret);
    context.mocks.clerk.verifyWebhook.mockImplementation((request, options) => {
      if (!(request instanceof Request)) {
        throw new Error("Expected the actual Clerk request");
      }
      const configuration = z
        .object({ signingSecret: z.string() })
        .parse(options);
      return clerkSdk.verifyWebhook(request, configuration);
    });
    const body = JSON.stringify({
      object: "event",
      type: "organization.deleted",
      data: { id: orgId },
    });
    const id = `msg_${randomUUID()}`;
    const timestamp = new Date(now());
    const response = await createApp({
      signal: context.signal,
      routes: webhooksClerkRoutes,
    }).request("/api/webhooks/clerk", {
      method: "POST",
      body,
      headers: {
        "svix-id": id,
        "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
        "svix-signature": new Webhook(clerkSecret).sign(id, timestamp, body),
      },
    });
    await expect(response.text()).resolves.toBe("OK");
    expect(response.status).toBe(200);
    await flushWaitUntilForTest();
  });
  const { default: ActualStripe } =
    await vi.importActual<typeof import("stripe")>("stripe");
  const verifier = new ActualStripe("sk_test_credit_alert_signing_only");
  mockStripeClient(context.mocks.stripe);
  mockOptionalEnv("STRIPE_WEBHOOK_SECRET", stripeSecret);
  context.mocks.stripe.webhooks.constructEventAsync.mockImplementation(
    (body, signature, secret) => {
      return verifier.webhooks.constructEvent(
        z.string().parse(body),
        z.string().parse(signature),
        z.string().parse(secret),
      );
    },
  );

  // Unchanged fixed provider catalog vectors from billing-checkout-fixture's
  // catalog-only method. No custom price, bonus, grant or business-row seed.
  const catalog = new Map<string, FixtureStripePrice>();
  for (const [usd, bonus] of [
    [20, 400],
    [50, 2600],
    [100, 8700],
    [200, 22_200],
  ] as const) {
    const id = `price_test_usage_pack_${usd}`;
    catalog.set(id, {
      id,
      active: true,
      currency: "usd",
      type: "recurring",
      unit_amount: usd * 100,
      recurring: { interval: "month", interval_count: 1 },
      tax_behavior: "exclusive",
      product: {
        id: `prod_${usd}`,
        name: `$${usd} usage pack`,
        metadata: { bonusCredits: String(bonus) },
        tax_code: "txcd_10000000",
      },
    });
  }
  const planPriceId = "price_test_usage_pack_plan_pro";
  catalog.set(planPriceId, {
    id: planPriceId,
    active: true,
    currency: "usd",
    type: "recurring",
    unit_amount: 0,
    recurring: { interval: "month", interval_count: 1 },
    product: {
      id: `prod_${planPriceId}`,
      name: "Pro usage pack plan",
      metadata: {},
    },
  });
  context.mocks.stripe.prices.retrieve.mockImplementation(async (id) => {
    return await Promise.resolve(required(catalog, id));
  });
  context.mocks.stripe.customers.create.mockImplementation(async (input) => {
    const { metadata } = z.object({ metadata: metadataSchema }).parse(input);
    if (metadata.orgId !== orgId) {
      throw new Error("Customer creation escaped the workspace");
    }
    const customer: StripeCustomer = {
      id: `cus_${randomUUID()}`,
      metadata,
      invoice_settings: { default_payment_method: null },
    };
    customers.set(customer.id, customer);
    return await Promise.resolve(customer);
  });
  context.mocks.stripe.customers.retrieve.mockImplementation(async (id) => {
    return await Promise.resolve(required(customers, id));
  });
  context.mocks.stripe.paymentMethods.retrieve.mockImplementation(
    async (id) => {
      return await Promise.resolve(required(cards, id));
    },
  );
  context.mocks.stripe.paymentMethods.list.mockImplementation(async (input) => {
    const { customer } = z
      .object({ customer: z.string(), type: z.literal("card") })
      .parse(input);
    required(customers, customer);
    return await Promise.resolve({
      data: [...cards.values()].filter((card) => {
        return card.customer === customer;
      }),
      has_more: false,
    });
  });
  context.mocks.stripe.checkout.sessions.create.mockImplementation(
    async (input) => {
      const cart = checkoutSchema.parse(input);
      required(customers, cart.customer);
      if (
        cart.metadata.orgId !== orgId ||
        JSON.stringify(cart.metadata) !==
          JSON.stringify(cart.subscription_data.metadata)
      ) {
        throw new Error("Checkout routing metadata lost its correlation");
      }
      const amount = cart.line_items.reduce((sum, line) => {
        return sum + required(catalog, line.price).unit_amount * line.quantity;
      }, 0);
      const session: FixtureStripeCheckoutSession = {
        id: `cs_${randomUUID()}`,
        url: `https://checkout.stripe.com/c/pay/${randomUUID()}`,
        customer: cart.customer,
        mode: cart.mode,
        metadata: cart.metadata,
        subscription: null,
        status: "open",
        payment_status: "unpaid",
        currency: "usd",
        amount_subtotal: amount,
        amount_total: amount,
      };
      sessions.set(session.id, session);
      carts.set(session.id, cart);
      return await Promise.resolve(session);
    },
  );
  context.mocks.stripe.checkout.sessions.retrieve.mockImplementation(
    async (id) => {
      return await Promise.resolve(required(sessions, id));
    },
  );
  context.mocks.stripe.subscriptions.retrieve.mockImplementation(async (id) => {
    return await Promise.resolve(required(subscriptions, id));
  });
  context.mocks.stripe.subscriptions.list.mockImplementation(async (input) => {
    const { customer, status } = z
      .object({ customer: z.string(), status: z.string().optional() })
      .parse(input);
    required(customers, customer);
    return await Promise.resolve({
      data: [...subscriptions.values()].filter((subscription) => {
        return (
          subscription.customer === customer &&
          (!status || status === "all" || subscription.status === status)
        );
      }),
      has_more: false,
    });
  });
  context.mocks.stripe.subscriptions.update.mockImplementation(
    async (id, input) => {
      const subscription = required(subscriptions, id);
      const { metadata } = z.object({ metadata: metadataSchema }).parse(input);
      const updated = {
        ...subscription,
        metadata: { ...subscription.metadata, ...metadata },
      };
      subscriptions.set(subscription.id, updated);
      return await Promise.resolve(updated);
    },
  );
  context.mocks.stripe.subscriptions.cancel.mockImplementation(async (id) => {
    const subscription = required(subscriptions, id);
    const canceled = { ...subscription, status: "canceled" };
    subscriptions.set(subscription.id, canceled);
    return await Promise.resolve(canceled);
  });
  context.mocks.stripe.invoices.create.mockImplementation(async (input) => {
    const request = createInvoiceSchema.parse(input);
    required(customers, request.customer);
    const card = required(cards, request.default_payment_method);
    if (
      card.customer !== request.customer ||
      request.metadata.orgId !== orgId
    ) {
      throw new Error("Recharge lost customer/card/workspace correlation");
    }
    const invoice: FixtureStripeInvoice = {
      id: `in_${randomUUID()}`,
      customer: request.customer,
      metadata: request.metadata,
      amount_due: 0,
      amount_paid: 0,
      subtotal: 0,
      currency: "usd",
      status: "draft",
      paid: false,
      parent: null,
      lines: { data: [], has_more: false },
    };
    invoices.set(invoice.id, invoice);
    rechargeInvoiceId = invoice.id;
    return await Promise.resolve(invoice);
  });
  context.mocks.stripe.invoiceItems.create.mockImplementation(async (input) => {
    const item = itemSchema.parse(input);
    const invoice = required(invoices, item.invoice);
    if (invoice.status !== "draft" || invoice.customer !== item.customer) {
      throw new Error("Invoice item lost draft/customer correlation");
    }
    const line = {
      id: `il_${randomUUID()}`,
      amount: item.amount,
      subtotal: item.amount,
      period: {
        start: Math.floor(now() / 1000),
        end: Math.floor(now() / 1000),
      },
      parent: {
        type: "invoice_item_details" as const,
        invoice_item_details: { proration: false },
      },
    };
    invoices.set(invoice.id, {
      ...invoice,
      amount_due: invoice.amount_due + item.amount,
      subtotal: invoice.subtotal + item.amount,
      lines: { data: [...invoice.lines.data, line], has_more: false },
    });
    return await Promise.resolve({ id: line.id, ...item });
  });
  context.mocks.stripe.invoices.finalizeInvoice.mockImplementation(
    async (id) => {
      const invoice = required(invoices, id);
      if (invoice.status !== "draft" || invoice.amount_due <= 0) {
        throw new Error("Cannot finalize an unfunded provider invoice");
      }
      const finalized = { ...invoice, status: "open" as const };
      invoices.set(invoice.id, finalized);
      return await Promise.resolve(finalized);
    },
  );
  context.mocks.stripe.invoices.pay.mockImplementation(async (id) => {
    const invoice = required(invoices, id);
    if (invoice.status !== "open") {
      throw new Error("Cannot pay a non-open provider invoice");
    }
    const paid: FixtureStripeInvoice = {
      ...invoice,
      amount_paid: invoice.amount_due,
      status: "paid",
      paid: true,
      status_transitions: { paid_at: Math.floor(now() / 1000) },
    };
    invoices.set(invoice.id, paid);
    return await Promise.resolve(paid);
  });
  context.mocks.stripe.invoices.retrieve.mockImplementation(async (id) => {
    return await Promise.resolve(required(invoices, id));
  });
  context.mocks.stripe.invoices.list.mockImplementation(async (input) => {
    const { subscription, customer, status } = z
      .object({
        subscription: z.string().optional(),
        customer: z.string().optional(),
        status: z.string().optional(),
      })
      .parse(input);
    return await Promise.resolve({
      data: [...invoices.values()].filter((invoice) => {
        return (
          (!subscription ||
            invoice.parent?.subscription_details?.subscription ===
              subscription) &&
          (!customer || invoice.customer === customer) &&
          (!status || invoice.status === status)
        );
      }),
      has_more: false,
    });
  });
  context.mocks.stripe.invoices.listLineItems.mockImplementation(async (id) => {
    return await Promise.resolve(required(invoices, id).lines);
  });
  const refundSchema = z.object({
    invoice: z.string(),
    amount: z.number().int().positive(),
    metadata: metadataSchema,
  });
  context.mocks.stripe.creditNotes.list.mockImplementation(async (input) => {
    const { invoice } = z.object({ invoice: z.string() }).parse(input);
    required(invoices, invoice);
    return await Promise.resolve({
      data: [...creditNotes.values()].filter((note) => {
        return noteInvoices.get(note.id) === invoice;
      }),
      has_more: false,
    });
  });
  context.mocks.stripe.creditNotes.preview.mockImplementation(async (input) => {
    const request = refundSchema.parse(input);
    const invoice = required(invoices, request.invoice);
    if (invoice.status !== "paid" || request.amount > invoice.amount_paid) {
      throw new Error("Refund exceeds its captured payment");
    }
    return await Promise.resolve({
      pre_payment_amount: 0,
      post_payment_amount: request.amount,
    });
  });
  context.mocks.stripe.creditNotes.create.mockImplementation(async (input) => {
    const request = refundSchema
      .extend({ refund_amount: z.number().int().positive() })
      .parse(input);
    const invoice = required(invoices, request.invoice);
    if (
      invoice.status !== "paid" ||
      request.amount > invoice.amount_paid ||
      request.refund_amount !== request.amount
    ) {
      throw new Error("Credit note lost payment/refund correlation");
    }
    const note: StripeCreditNote = {
      id: `cn_${randomUUID()}`,
      status: "issued",
      metadata: request.metadata,
      pre_payment_amount: 0,
      post_payment_amount: request.amount,
      refunds: [
        {
          amount_refunded: request.amount,
          refund: {
            id: `re_${randomUUID()}`,
            status: "succeeded",
            failure_reason: null,
            amount: request.amount,
            payment_intent:
              invoice.payments?.data[0]?.payment.payment_intent ?? null,
            metadata: request.metadata,
          },
        },
      ],
    };
    creditNotes.set(note.id, note);
    noteInvoices.set(note.id, invoice.id);
    return await Promise.resolve(note);
  });

  async function postStripeEvent(type: string, object: object) {
    const body = JSON.stringify({
      id: `evt_${randomUUID()}`,
      object: "event",
      type,
      created: Math.floor(now() / 1000),
      data: { object },
    });
    const response = await createApp({
      routes: webhooksStripeRoutes,
      signal: context.signal,
    }).request("/api/webhooks/stripe", {
      method: "POST",
      body,
      headers: {
        "stripe-signature": verifier.webhooks.generateTestHeaderString({
          payload: body,
          secret: stripeSecret,
        }),
      },
    });
    await expect(response.text()).resolves.toBe("OK");
    expect(response.status).toBe(200);
    await flushWaitUntilForTest();
  }

  async function completeCheckout(url: string) {
    const session = [...sessions.values()].find((candidate) => {
      return candidate.url === url;
    });
    if (!session || session.status !== "open") {
      throw new Error("Expected the Checkout returned by the public purchase");
    }
    const cart = required(carts, session.id);
    const customer = required(customers, cart.customer);
    // Checkout's external card collection creates an attached card and the
    // subscription's default. No application payment-method row is injected.
    const card: StripePaymentMethod = {
      id: `pm_${randomUUID()}`,
      customer: customer.id,
      type: "card",
    };
    cards.set(card.id, card);
    const subscriptionId = `sub_${randomUUID()}`;
    const start = Math.floor(now() / 1000);
    const recurring = required(catalog, cart.metadata.priceId).recurring;
    if (!recurring || recurring.interval !== "month") {
      throw new Error("Expected the captured Checkout's monthly catalog price");
    }
    const periodEnd = new Date(start * 1000);
    const anchorDay = periodEnd.getUTCDate();
    periodEnd.setUTCDate(1);
    periodEnd.setUTCMonth(periodEnd.getUTCMonth() + recurring.interval_count);
    const lastDay = new Date(
      Date.UTC(periodEnd.getUTCFullYear(), periodEnd.getUTCMonth() + 1, 0),
    ).getUTCDate();
    periodEnd.setUTCDate(Math.min(anchorDay, lastDay));
    const end = Math.floor(periodEnd.getTime() / 1000);
    const items = cart.line_items.map((item) => {
      return {
        id: `si_${randomUUID()}`,
        price: required(catalog, item.price),
        quantity: item.quantity,
        current_period_start: start,
        current_period_end: end,
      };
    });
    const paymentIntent = `pi_${randomUUID()}`;
    const invoice: FixtureStripeInvoice = {
      id: `in_${randomUUID()}`,
      customer: customer.id,
      metadata: {},
      currency: "usd",
      amount_due: session.amount_total,
      amount_paid: session.amount_total,
      subtotal: session.amount_subtotal,
      status: "paid",
      paid: true,
      payments: {
        data: [
          {
            status: "paid",
            amount_paid: session.amount_total,
            payment: { type: "payment_intent", payment_intent: paymentIntent },
          },
        ],
      },
      status_transitions: { paid_at: start },
      parent: {
        subscription_details: {
          subscription: subscriptionId,
          metadata: cart.subscription_data.metadata,
        },
      },
      lines: {
        has_more: false,
        data: items.map((item) => {
          return {
            id: `il_${randomUUID()}`,
            amount: item.price.unit_amount * item.quantity,
            subtotal: item.price.unit_amount * item.quantity,
            quantity: item.quantity,
            pricing: {
              price_details: {
                price: item.price.id,
                product:
                  typeof item.price.product === "string"
                    ? item.price.product
                    : item.price.product.id,
              },
            },
            period: { start, end },
            parent: {
              type: "subscription_item_details",
              subscription_item_details: { proration: false },
            },
          };
        }),
      },
    };
    const subscription: StripeSubscription = {
      id: subscriptionId,
      customer: customer.id,
      created: start,
      status: "active",
      metadata: cart.subscription_data.metadata,
      cancel_at_period_end: false,
      default_payment_method: card.id,
      latest_invoice: invoice.id,
      items: { data: items },
    };
    invoices.set(invoice.id, invoice);
    subscriptions.set(subscription.id, subscription);
    const completed: FixtureStripeCheckoutSession = {
      ...session,
      status: "complete",
      payment_status: "paid",
      subscription: subscription.id,
      invoice: invoice.id,
    };
    sessions.set(session.id, completed);
    await postStripeEvent("checkout.session.completed", {
      object: "checkout.session",
      ...completed,
    });
    await postStripeEvent("invoice.paid", { object: "invoice", ...invoice });
  }

  const config = setupApp({ context, routes: billingAutoRechargeRoutes })(
    billingAutoRechargeContract,
  );
  const status = setupApp({ context, routes: billingStatusRoutes })(
    billingStatusContract,
  );
  const credits = setupApp({ context, routes: billingUsagePackCreditsRoutes })(
    billingUsagePackCreditsContract,
  );
  const checkout = setupApp({ context, routes: billingCheckoutRoutes })(
    billingUsagePackCheckoutContract,
  );
  bdd.acceptAgentStorageWrites();
  await owner.run(async () => {
    await bdd.completeOnboarding(admin);
    const initialized = await bdd.readOnboardingStatus(admin);
    expect(initialized).toMatchObject({
      hasOrg: true,
      isAdmin: true,
      hasDefaultAgent: true,
    });
    expect(initialized.defaultAgentId).toBeTruthy();
    await flushWaitUntilForTest();
  });
  const runs = createRunsApi(context);
  const adminToken = await owner.run(() => {
    return runs.createCliToken(admin);
  });
  const memberToken = await owner.run(() => {
    return runs.createCliToken(member);
  });
  const adminHeaders = { authorization: `Bearer ${adminToken.token}` };
  const memberHeaders = { authorization: `Bearer ${memberToken.token}` };
  // Preserve the independently verified, pre-existing Clerk session as a
  // billing reader. That auth path does not write the membership cache.
  createRouteMocks(context).clerk.session(admin.userId, orgId, "org:admin");
  mockClerkUsers(
    context,
    [admin, member].map((actor) => {
      return {
        id: actor.userId,
        emailAddresses: [
          { id: `email_${actor.userId}`, emailAddress: actor.email },
        ],
        primaryEmailAddressId: `email_${actor.userId}`,
        firstName: "C",
        lastName: "Fixture",
      };
    }),
  );
  context.mocks.clerk.users.getOrganizationMembershipList.mockImplementation(
    async (input) => {
      const { userId } = z.object({ userId: z.string() }).parse(input);
      const actors: {
        readonly actor: ApiTestUser;
        readonly role: "org:admin" | "org:member";
      }[] = [
        { actor: admin, role: "org:admin" },
        { actor: member, role: "org:member" },
      ];
      const actor = actors.find((candidate) => {
        return candidate.actor.userId === userId;
      });
      if (!actor) {
        throw new Error("Unknown case-owned Clerk user");
      }
      return await Promise.resolve({
        data: [membership(actor.actor, actor.role)],
        totalCount: 1,
      });
    },
  );
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: [membership(admin, "org:admin"), membership(member, "org:member")],
      totalCount: 2,
    },
  );
  context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
    { data: [], totalCount: 0 },
  );
  await owner.run(async () => {
    const purchase = await accept(
      checkout.create({
        headers: adminHeaders,
        body: {
          tier: "pro",
          memberUsagePacks: [
            { memberId: admin.userId, usagePackUsd: 20 },
            { memberId: member.userId, usagePackUsd: 0 },
          ],
          supportsInAppPreview: false,
          successUrl: "http://localhost:3002/?paid=1",
          cancelUrl: "http://localhost:3002/?cancel=1",
        },
      }),
      [200],
    );
    if (!("url" in purchase.body)) {
      throw new Error("Expected hosted Checkout");
    }
    await completeCheckout(purchase.body.url);
    expect(
      (await accept(status.get({ headers: adminHeaders }), [200])).body,
    ).toMatchObject({ tier: "pro", status: "active", credits: 0 });
    const enabled = await accept(
      config.update({
        headers: adminHeaders,
        body: { enabled: true, threshold: 1000, amount: 5005 },
      }),
      [200],
    );
    expect(enabled.body).toMatchObject({ enabled: true });
    if (!rechargeInvoiceId) {
      throw new Error("The public recharge did not create its invoice");
    }
    const recharge = required(invoices, rechargeInvoiceId);
    if (recharge.status !== "paid") {
      throw new Error("Recharge payment has not settled");
    }
    // The credited quantity comes from the app's captured request metadata,
    // not from converting the 600-cent paid invoice into 6000 credits.
    expect(recharge.metadata).toMatchObject({
      type: "auto_recharge",
      orgId,
      creditsAmount: "5005",
    });
    expect(recharge.amount_paid).toBe(600);
    await postStripeEvent("invoice.paid", { object: "invoice", ...recharge });
    await accept(
      config.update({ headers: adminHeaders, body: { enabled: false } }),
      [200],
    );
    expect(
      (await accept(config.get({ headers: adminHeaders }), [200])).body,
    ).toMatchObject({ enabled: false });
    expect(
      (await accept(status.get({ headers: adminHeaders }), [200])).body.credits,
    ).toBe(5005);
    expect(
      (await accept(credits.get({ headers: memberHeaders }), [200])).body,
    ).toMatchObject({ totalCredits: 0, purchasedCredits: 0, bonusCredits: 0 });
    expect(
      (
        await accept(
          config.update({ headers: memberHeaders, body: { enabled: false } }),
          [403],
        )
      ).status,
    ).toBe(403);
    await flushWaitUntilForTest();
  });
  return {
    async debitWithMemberships(mode: "paginated" | "empty") {
      if (mode === "empty") {
        context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
          { data: [], totalCount: 0 },
        );
      } else {
        const firstPage = [
          membership(member, "org:admin"),
          ...Array.from({ length: 99 }, () => {
            return membership(
              bdd.user({ orgId, orgRole: "org:member" }),
              "org:member",
            );
          }),
        ];
        context.mocks.clerk.organizations.getOrganizationMembershipList.mockImplementation(
          async (input) => {
            const { organizationId, offset } = z
              .object({
                organizationId: z.literal(orgId),
                offset: z.number().int(),
                limit: z.literal(100),
              })
              .parse(input);
            if (organizationId !== orgId || (offset !== 0 && offset !== 100)) {
              throw new Error("Unexpected case-owned Clerk page");
            }
            return await Promise.resolve({
              data:
                offset === 0 ? firstPage : [membership(member, "org:member")],
              totalCount: 101,
            });
          },
        );
      }
      await owner.run(async () => {
        await chargePublicDataUsage(context, member, 5);
        await flushWaitUntilForTest();
        // This existing session reader cannot upsert or bootstrap the asserted
        // CLI cache state, including when the provider's membership page is empty.
        expect(
          (
            await accept(
              status.get({
                headers: { authorization: "Bearer clerk-session" },
              }),
              [200],
            )
          ).body.credits,
        ).toBe(5000);
      });
      context.mocks.clerk.users.getOrganizationMembershipList.mockRejectedValue(
        new ClerkTransportTestError(),
      );
      // The current contract client rejects an undeclared 503. Observe the
      // same production PUT as raw HTTP; do not change its contract or handler.
      async function authority(headers: { readonly authorization: string }) {
        return await owner.run(async () => {
          return await createApp({
            signal: context.signal,
            routes: billingAutoRechargeRoutes,
          }).request("/api/billing/auto-recharge", {
            method: "PUT",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ enabled: false }),
          });
        });
      }
      return {
        async adminAuthority() {
          return await authority(adminHeaders);
        },
        async memberAuthority() {
          return await authority(memberHeaders);
        },
      };
    },
  };
}
