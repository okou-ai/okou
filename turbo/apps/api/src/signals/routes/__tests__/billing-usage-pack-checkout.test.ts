import { randomUUID } from "node:crypto";
import {
  billingStatusContract,
  billingUsagePackCatalogContract,
  billingUsagePackCheckoutContract,
} from "@okouai/api-contracts/contracts/billing";
import { describe, expect, it } from "vitest";

import { apiTestEnvironment } from "../../../__tests__/test-environment";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow, now } from "../../../lib/time";
import { billingCheckoutRoutes } from "../billing-checkout";
import { billingStatusRoutes } from "../billing-status";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

const APP_ORIGIN = new URL(apiTestEnvironment.APP_URL).origin;
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const PLAN_PRO = apiTestEnvironment.OKOU_PRICE_USAGE_PACK_PLAN_PRO;
const PLAN_TEAM = apiTestEnvironment.OKOU_PRICE_USAGE_PACK_PLAN_TEAM;
const PACK_PRICE = {
  20: apiTestEnvironment.OKOU_PRICE_USAGE_PACK_20,
  50: apiTestEnvironment.OKOU_PRICE_USAGE_PACK_50,
  100: apiTestEnvironment.OKOU_PRICE_USAGE_PACK_100,
  200: apiTestEnvironment.OKOU_PRICE_USAGE_PACK_200,
} as const;
const PACK_BONUS = { 20: 400, 50: 2600, 100: 8700, 200: 22_200 } as const;
const SAVED_CARD = "pm_usage_pack_saved_card";
const redirects = Object.freeze({
  successUrl: `${APP_ORIGIN}/billing?usage=success`,
  cancelUrl: `${APP_ORIGIN}/billing?usage=canceled`,
});

type PackUsd = 0 | 20 | 50 | 100 | 200;

/** Stripe serves the configured usage pack Prices with their bonus metadata. */
function stripeUsagePackCatalog(): void {
  context.mocks.stripe.prices.retrieve.mockImplementation((id: unknown) => {
    const entry = Object.entries(PACK_PRICE).find(([, priceId]) => {
      return priceId === id;
    });
    if (!entry) {
      return Promise.resolve({
        id,
        active: true,
        currency: "usd",
        type: "recurring",
        unit_amount: 2000,
        recurring: { interval: "month", interval_count: 1 },
        product: "prod_usage_pack_plan",
      });
    }
    const usd = Number(entry[0]) as keyof typeof PACK_BONUS;
    return Promise.resolve({
      id,
      active: true,
      currency: "usd",
      type: "recurring",
      recurring: { interval: "month", interval_count: 1 },
      unit_amount: usd * 100,
      tax_behavior: "exclusive",
      product: {
        id: `prod_usage_${usd}`,
        name: `Usage ${usd}`,
        metadata: { bonusCredits: String(PACK_BONUS[usd]) },
      },
    });
  });
}

function setup(
  options: {
    readonly otherMembers?: number;
    readonly invitations?: readonly string[];
  } = {},
) {
  const admin = {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  };
  const others = Array.from({ length: options.otherMembers ?? 0 }, () => {
    return `user_${randomUUID()}`;
  });
  const members = [admin.userId, ...others];
  createRouteMocks(context).clerk.session(admin.userId, admin.orgId);
  context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
    id: admin.orgId,
    slug: `usage-${admin.orgId.slice(-8)}`,
    name: "Usage Pack Org",
    createdBy: admin.userId,
    createdAt: now(),
  });
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockImplementation(
    (params: unknown) => {
      const { offset = 0, limit = 100 } = params as {
        offset?: number;
        limit?: number;
      };
      return Promise.resolve({
        data: members.slice(offset, offset + limit).map((userId) => {
          return {
            role: userId === admin.userId ? "org:admin" : "org:member",
            publicUserData: { userId },
            createdAt: now(),
          };
        }),
        totalCount: members.length,
      });
    },
  );
  context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
    {
      data: (options.invitations ?? []).map((id) => {
        return {
          id,
          emailAddress: `${id}@example.com`,
          role: "org:member",
          status: "pending",
          createdAt: now(),
        };
      }),
      totalCount: options.invitations?.length ?? 0,
    },
  );
  stripeUsagePackCatalog();
  const customerId = `cus_${randomUUID().slice(0, 8)}`;
  context.mocks.stripe.customers.create.mockResolvedValue({ id: customerId });

  const appFor = setupApp({
    context,
    routes: [...billingCheckoutRoutes, ...billingStatusRoutes],
  });
  return {
    admin,
    members,
    customerId,
    checkout: appFor(billingUsagePackCheckoutContract),
    catalog: appFor(billingUsagePackCatalogContract),
    status: appFor(billingStatusContract),
  };
}

function packs(
  ...selections: readonly (readonly [string, PackUsd])[]
): { memberId: string; usagePackUsd: PackUsd }[] {
  return selections.map(([memberId, usagePackUsd]) => {
    return { memberId, usagePackUsd };
  });
}

/** The customer has a saved default card on Stripe. */
function savedCard(customerId: string, orgId: string): void {
  context.mocks.stripe.customers.retrieve.mockResolvedValue({
    id: customerId,
    metadata: { orgId },
    invoice_settings: { default_payment_method: SAVED_CARD },
    default_source: null,
  });
}

/** Stripe quotes the same amount for both preview modes unless given per mode. */
function stripeQuote(next: number, recurring: number = next): void {
  context.mocks.stripe.invoices.createPreview.mockImplementation(
    (params: unknown) => {
      const mode = (params as { preview_mode?: string }).preview_mode;
      const amount = mode === "recurring" ? recurring : next;
      return Promise.resolve({
        amount_due: amount,
        total: amount,
        subtotal: amount,
        currency: "usd",
        lines: { data: [], has_more: false },
      });
    },
  );
}

function previewTokenOf(body: unknown): string {
  if (
    typeof body !== "object" ||
    body === null ||
    !("previewToken" in body) ||
    typeof body.previewToken !== "string"
  ) {
    throw new Error("Expected a usage pack purchase preview");
  }
  return body.previewToken;
}

interface TrackedSession {
  id: string;
  url: string;
  status: "open" | "expired";
  params: unknown;
}

/** Stripe Checkout Sessions that can be read back and expired. */
function trackedCheckoutSessions(): TrackedSession[] {
  const sessions: TrackedSession[] = [];
  context.mocks.stripe.checkout.sessions.create.mockImplementation(
    (params: unknown) => {
      const id = `cs_${randomUUID()}`;
      const session: TrackedSession = {
        id,
        url: `https://checkout.stripe.test/${id}`,
        status: "open",
        params,
      };
      sessions.push(session);
      return Promise.resolve({ id, url: session.url, status: "open" });
    },
  );
  context.mocks.stripe.checkout.sessions.retrieve.mockImplementation(
    (id: unknown) => {
      const session = sessions.find((candidate) => {
        return candidate.id === id;
      });
      if (!session) {
        return Promise.reject(new Error(`Unknown session ${String(id)}`));
      }
      const { params } = session;
      const metadata = (params as { metadata?: unknown }).metadata;
      return Promise.resolve({
        id: session.id,
        url: session.status === "open" ? session.url : null,
        status: session.status,
        mode: "subscription",
        customer: (params as { customer?: unknown }).customer,
        metadata,
        subscription: null,
      });
    },
  );
  context.mocks.stripe.checkout.sessions.expire.mockImplementation(
    (id: unknown) => {
      const session = sessions.find((candidate) => {
        return candidate.id === id;
      });
      if (session) {
        session.status = "expired";
      }
      return Promise.resolve({ id, status: "expired" });
    },
  );
  return sessions;
}

describe("POST /api/billing/usage-pack-checkout", () => {
  it("billing-usage-pack-checkout-001 shows the Stripe-validated usage pack catalog", async () => {
    const { catalog } = setup();

    const response = await accept(catalog.get({ headers }), [200]);

    expect(response.body).toStrictEqual({
      supportsFreeMembers: true,
      usagePacks: [
        {
          usagePackUsd: 20,
          priceUsd: 20,
          purchasedCredits: 20_000,
          bonusCredits: 400,
          totalCredits: 20_400,
        },
        {
          usagePackUsd: 50,
          priceUsd: 50,
          purchasedCredits: 50_000,
          bonusCredits: 2600,
          totalCredits: 52_600,
        },
        {
          usagePackUsd: 100,
          priceUsd: 100,
          purchasedCredits: 100_000,
          bonusCredits: 8700,
          totalCredits: 108_700,
        },
        {
          usagePackUsd: 200,
          priceUsd: 200,
          purchasedCredits: 200_000,
          bonusCredits: 22_200,
          totalCredits: 222_200,
        },
      ],
    });
  });

  it("billing-usage-pack-checkout-002 refuses a Pro checkout where no member gets a paid pack", async () => {
    const { admin, checkout } = setup();

    const response = await accept(
      checkout.create({
        headers,
        body: {
          tier: "pro",
          memberUsagePacks: packs([admin.userId, 0]),
          ...redirects,
        },
      }),
      [400],
    );

    expect(response.body.error).toMatchObject({
      message: "At least one member must have a paid usage pack",
      code: "BAD_REQUEST",
    });
  });

  it("billing-usage-pack-checkout-004 checks out Pro charging only the member with a paid pack", async () => {
    const { admin, members, checkout } = setup({ otherMembers: 1 });
    trackedCheckoutSessions();

    await accept(
      checkout.create({
        headers,
        body: {
          tier: "pro",
          memberUsagePacks: packs([admin.userId, 20], [members[1] ?? "", 0]),
          ...redirects,
        },
      }),
      [200],
    );

    const params = context.mocks.stripe.checkout.sessions.create.mock
      .calls[0]?.[0] as { metadata: Record<string, string> };
    expect(params).toMatchObject({
      line_items: [
        { price: PLAN_PRO, quantity: 1 },
        { price: PACK_PRICE[20], quantity: 1 },
      ],
    });
    expect(params.metadata.usagePackSubscriptionId).toStrictEqual(
      expect.any(String),
    );
  });

  it("billing-usage-pack-checkout-006 checks out Team for 101 members and a pending invitation", async () => {
    const invitationId = `orginv_${randomUUID()}`;
    const { admin, members, customerId, checkout } = setup({
      otherMembers: 100,
      invitations: [invitationId],
    });
    const sessions = trackedCheckoutSessions();
    const sizes: readonly PackUsd[] = [20, 50, 100, 200];
    const memberUsagePacks = [
      ...members.map((memberId, index) => {
        return { memberId, usagePackUsd: sizes[index] ?? (20 as PackUsd) };
      }),
      { memberId: invitationId, usagePackUsd: 20 as PackUsd },
    ];

    const response = await accept(
      checkout.create({
        headers,
        body: { tier: "team", memberUsagePacks, ...redirects },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ url: sessions[0]?.url });
    const [params, requestOptions] =
      context.mocks.stripe.checkout.sessions.create.mock.calls[0] ?? [];
    const snapshotId = (params as { metadata: Record<string, string> }).metadata
      .usagePackSubscriptionId;
    const metadata = {
      orgId: admin.orgId,
      tier: "team",
      priceId: PLAN_TEAM,
      purpose: "usage_pack_subscription",
      usagePackSubscriptionId: snapshotId,
    };
    expect(params).toStrictEqual({
      mode: "subscription",
      customer: customerId,
      line_items: [
        { price: PLAN_TEAM, quantity: 1 },
        { price: PACK_PRICE[20], quantity: 99 },
        { price: PACK_PRICE[50], quantity: 1 },
        { price: PACK_PRICE[100], quantity: 1 },
        { price: PACK_PRICE[200], quantity: 1 },
      ],
      allow_promotion_codes: true,
      success_url: redirects.successUrl,
      cancel_url: redirects.cancelUrl,
      metadata,
      subscription_data: { metadata },
    });
    expect(requestOptions).toStrictEqual({
      idempotencyKey: `usage-pack-checkout:${snapshotId}`,
    });
    const membershipReads =
      context.mocks.clerk.organizations.getOrganizationMembershipList.mock.calls.map(
        (call) => {
          return call[0];
        },
      );
    expect(membershipReads).toContainEqual(
      expect.objectContaining({ limit: 100, offset: 0 }),
    );
    expect(membershipReads).toContainEqual(
      expect.objectContaining({ limit: 100, offset: 100 }),
    );
  });

  it("billing-usage-pack-checkout-007 separates the immediate charge from the recurring amount", async () => {
    const { admin, customerId, checkout } = setup();
    savedCard(customerId, admin.orgId);
    stripeQuote(2000, 4000);
    const subscriptionId = `sub_${randomUUID().slice(0, 8)}`;
    const start = Math.floor(now() / 1000);
    const period = { start, end: start + 30 * 86_400 };
    context.mocks.stripe.subscriptions.create.mockImplementation(
      (params: unknown) => {
        const { metadata } = params as { metadata: Record<string, string> };
        const invoice = {
          id: `in_${subscriptionId}`,
          status: "paid",
          customer: customerId,
          amount_due: 2000,
          amount_paid: 2000,
          paid: true,
          paid_out_of_band: false,
          total: 2000,
          subtotal: 2000,
          currency: "usd",
          hosted_invoice_url: null,
          metadata,
          parent: {
            subscription_details: { subscription: subscriptionId, metadata },
          },
          lines: {
            has_more: false,
            data: [
              {
                id: `il_${subscriptionId}`,
                amount: 2000,
                subtotal: 2000,
                discount_amounts: [],
                quantity: 1,
                price: { id: PACK_PRICE[20] },
                period,
                parent: {
                  type: "subscription_item_details",
                  subscription_item_details: { proration: false },
                },
              },
            ],
          },
        };
        const subscription = {
          id: subscriptionId,
          customer: customerId,
          status: "active",
          cancel_at: null,
          cancel_at_period_end: false,
          schedule: null,
          trial_end: null,
          default_payment_method: SAVED_CARD,
          metadata,
          latest_invoice: invoice,
          items: {
            data: [
              {
                price: { id: PLAN_PRO },
                quantity: 1,
                current_period_start: period.start,
                current_period_end: period.end,
              },
              {
                price: { id: PACK_PRICE[20] },
                quantity: 1,
                current_period_start: period.start,
                current_period_end: period.end,
              },
            ],
          },
        };
        context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
          subscription,
        );
        return Promise.resolve(subscription);
      },
    );

    const preview = await accept(
      checkout.create({
        headers,
        body: {
          tier: "pro",
          supportsInAppPreview: true,
          memberUsagePacks: packs([admin.userId, 20]),
          ...redirects,
        },
      }),
      [200],
    );
    const confirmed = await accept(
      checkout.confirm({
        headers,
        body: { previewToken: previewTokenOf(preview.body) },
      }),
      [200],
    );

    expect(preview.body).toStrictEqual({
      status: "preview",
      purchaseType: "usage_pack",
      tier: "pro",
      immediateAmountCents: 2000,
      nextRecurringAmountCents: 4000,
      currency: "usd",
      expiresAt: expect.any(String),
      previewToken: expect.any(String),
    });
    const modes = context.mocks.stripe.invoices.createPreview.mock.calls.map(
      (call) => {
        return (call[0] as { preview_mode: string }).preview_mode;
      },
    );
    expect(modes).toContain("next");
    expect(modes).toContain("recurring");
    expect(confirmed.body).toStrictEqual({
      status: "completed",
      hostedInvoiceUrl: null,
    });
  });

  it("billing-usage-pack-checkout-012 keeps one payable Checkout across concurrent different selections", async () => {
    const { admin, checkout, status } = setup();
    const sessions = trackedCheckoutSessions();
    const before = (await accept(status.get({ headers }), [200])).body;
    const request = (usd: PackUsd) => {
      return checkout.create({
        headers,
        body: {
          tier: "pro",
          memberUsagePacks: packs([admin.userId, usd]),
          ...redirects,
        },
      });
    };

    const concurrent = await Promise.all([
      accept(request(20), [200, 409]),
      accept(request(50), [200, 409]),
    ]);

    expect(
      concurrent.some((response) => {
        return response.status === 200;
      }),
    ).toBeTruthy();
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(sessions.length).toBeLessThanOrEqual(2);
    for (const session of sessions) {
      expect(session.params).toMatchObject({
        metadata: { usagePackSubscriptionId: expect.any(String) },
        line_items: [
          { price: PLAN_PRO, quantity: 1 },
          {
            price: expect.stringMatching(
              new RegExp(`^(${PACK_PRICE[20]}|${PACK_PRICE[50]})$`),
            ),
            quantity: 1,
          },
        ],
      });
    }
    expect(
      sessions.filter((session) => {
        return session.status === "open";
      }),
    ).toHaveLength(1);

    const replacement = await accept(request(100), [200]);

    expect(replacement.body).toStrictEqual({
      url: expect.stringMatching(/^https:\/\/checkout\.stripe\.test\//),
    });
    expect(
      sessions.filter((session) => {
        return session.status === "open";
      }),
    ).toHaveLength(1);
    const after = (await accept(status.get({ headers }), [200])).body;
    expect({ tier: after.tier, credits: after.credits }).toStrictEqual({
      tier: before.tier,
      credits: before.credits,
    });
  });

  it("billing-usage-pack-checkout-013 renews the expiry of a reused purchase preview", async () => {
    const start = Date.parse("2035-05-15T00:00:00.000Z");
    mockNow(start);
    const { admin, customerId, checkout } = setup();
    savedCard(customerId, admin.orgId);
    stripeQuote(4000);
    const body = {
      tier: "pro" as const,
      supportsInAppPreview: true,
      memberUsagePacks: packs([admin.userId, 20]),
      ...redirects,
    };

    const first = await accept(checkout.create({ headers, body }), [200]);
    mockNow(start + 14 * 60_000);
    const reused = await accept(checkout.create({ headers, body }), [200]);

    expect(first.body).toMatchObject({
      expiresAt: new Date(start + 15 * 60_000).toISOString(),
    });
    expect(reused.body).toMatchObject({
      expiresAt: new Date(start + 29 * 60_000).toISOString(),
    });
  });

  it("billing-usage-pack-checkout-014 rejects a preview after a replacement preview retires it", async () => {
    const { admin, customerId, checkout } = setup();
    savedCard(customerId, admin.orgId);
    stripeQuote(4000);
    const preview = (usd: PackUsd) => {
      return accept(
        checkout.create({
          headers,
          body: {
            tier: "pro",
            supportsInAppPreview: true,
            memberUsagePacks: packs([admin.userId, usd]),
            ...redirects,
          },
        }),
        [200],
      );
    };

    const first = await preview(20);
    await preview(50);
    const confirmed = await accept(
      checkout.confirm({
        headers,
        body: { previewToken: previewTokenOf(first.body) },
      }),
      [409],
    );

    expect(confirmed.body.error).toMatchObject({
      message: "Usage pack purchase preview is no longer valid",
      code: "CONFLICT",
    });
    expect(context.mocks.stripe.subscriptions.create).not.toHaveBeenCalled();
  });

  it("billing-usage-pack-checkout-016 retires a preview whose quote changed and allows a fresh preview", async () => {
    const { admin, customerId, checkout } = setup();
    savedCard(customerId, admin.orgId);
    stripeQuote(4000);
    const body = {
      tier: "pro" as const,
      supportsInAppPreview: true,
      memberUsagePacks: packs([admin.userId, 20]),
      ...redirects,
    };
    const first = await accept(checkout.create({ headers, body }), [200]);
    const previewToken = previewTokenOf(first.body);
    stripeQuote(4100);

    const confirmed = await accept(
      checkout.confirm({ headers, body: { previewToken } }),
      [409],
    );
    const replay = await accept(
      checkout.confirm({ headers, body: { previewToken } }),
      [409],
    );
    stripeQuote(4000);
    const fresh = await accept(checkout.create({ headers, body }), [200]);

    const invalid = {
      message: "Usage pack purchase preview is no longer valid",
      code: "CONFLICT",
    };
    expect(confirmed.body.error).toMatchObject(invalid);
    expect(replay.body.error).toMatchObject(invalid);
    expect(fresh.body).toMatchObject({
      status: "preview",
      immediateAmountCents: 4000,
      nextRecurringAmountCents: 4000,
      currency: "usd",
    });
    expect(previewTokenOf(fresh.body)).not.toBe(previewToken);
    expect(context.mocks.stripe.subscriptions.create).not.toHaveBeenCalled();
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
  });

  it("billing-usage-pack-checkout-019 tries the saved card and hands back the open invoice", async () => {
    const { admin, customerId, checkout } = setup();
    savedCard(customerId, admin.orgId);
    stripeQuote(4000);
    const subscriptionId = `sub_${randomUUID().slice(0, 8)}`;
    const hostedInvoiceUrl = `https://invoice.stripe.test/${subscriptionId}`;
    const openInvoice = {
      id: `in_${subscriptionId}`,
      status: "open",
      customer: customerId,
      amount_due: 4000,
      amount_paid: 0,
      currency: "usd",
      hosted_invoice_url: hostedInvoiceUrl,
      metadata: {},
      lines: { data: [], has_more: false },
    };
    context.mocks.stripe.subscriptions.create.mockImplementation(
      (params: unknown) => {
        const { metadata } = params as { metadata: Record<string, string> };
        return Promise.resolve({
          id: subscriptionId,
          customer: customerId,
          status: "incomplete",
          cancel_at: null,
          cancel_at_period_end: false,
          schedule: null,
          trial_end: null,
          default_payment_method: SAVED_CARD,
          metadata,
          latest_invoice: openInvoice,
          items: {
            data: [
              { price: { id: PLAN_PRO }, quantity: 1 },
              { price: { id: PACK_PRICE[20] }, quantity: 1 },
            ],
          },
        });
      },
    );
    context.mocks.stripe.invoices.pay.mockRejectedValue(
      Object.assign(new Error("Payment requires authentication"), {
        type: "StripeCardError",
        code: "invoice_payment_intent_requires_action",
      }),
    );
    context.mocks.stripe.invoices.retrieve.mockResolvedValue(openInvoice);

    const preview = await accept(
      checkout.create({
        headers,
        body: {
          tier: "pro",
          supportsInAppPreview: true,
          memberUsagePacks: packs([admin.userId, 20]),
          ...redirects,
        },
      }),
      [200],
    );
    const confirmed = await accept(
      checkout.confirm({
        headers,
        body: { previewToken: previewTokenOf(preview.body) },
      }),
      [200],
    );

    expect(confirmed.body).toStrictEqual({
      status: "pending_payment",
      hostedInvoiceUrl,
    });
    expect(context.mocks.stripe.invoices.pay).toHaveBeenCalledWith(
      openInvoice.id,
      {},
      {
        idempotencyKey: expect.stringContaining(
          "billing-operation:usage-pack:",
        ),
      },
    );
  });

  it("billing-usage-pack-checkout-022 reuses one open Checkout when previews lose their saved card", async () => {
    const { admin, customerId, checkout } = setup();
    const withCard = {
      id: customerId,
      metadata: { orgId: admin.orgId },
      invoice_settings: { default_payment_method: SAVED_CARD },
      default_source: null,
    };
    context.mocks.stripe.customers.retrieve
      .mockResolvedValueOnce(withCard)
      .mockResolvedValueOnce(withCard)
      .mockResolvedValue({
        ...withCard,
        invoice_settings: { default_payment_method: null },
      });
    stripeQuote(4000);
    trackedCheckoutSessions();
    const memberUsagePacks = packs([admin.userId, 20]);
    const firstBody = {
      tier: "pro" as const,
      supportsInAppPreview: true,
      memberUsagePacks,
      ...redirects,
    };
    const secondBody = {
      ...firstBody,
      successUrl: `${APP_ORIGIN}/billing?usage=success-again`,
      cancelUrl: `${APP_ORIGIN}/billing?usage=canceled-again`,
    };

    const first = await accept(
      checkout.create({ headers, body: firstBody }),
      [200],
    );
    const second = await accept(
      checkout.create({ headers, body: secondBody }),
      [200],
    );
    const firstSubmit = await accept(
      checkout.create({
        headers,
        body: { ...firstBody, previewToken: previewTokenOf(first.body) },
      }),
      [200],
    );
    const secondSubmit = await accept(
      checkout.create({
        headers,
        body: { ...secondBody, previewToken: previewTokenOf(second.body) },
      }),
      [200],
    );
    const repeated = await accept(
      checkout.create({
        headers,
        body: { tier: "pro", memberUsagePacks, ...redirects },
      }),
      [200],
    );

    expect(firstSubmit.body).toStrictEqual({
      status: "checkout_required",
      checkoutUrl: expect.stringMatching(/^https:\/\/checkout\.stripe\.test\//),
    });
    const checkoutUrl = (firstSubmit.body as { checkoutUrl: string })
      .checkoutUrl;
    expect(secondSubmit.body).toStrictEqual({
      status: "checkout_required",
      checkoutUrl,
    });
    expect(repeated.body).toStrictEqual({ url: checkoutUrl });
    expect(context.mocks.stripe.checkout.sessions.create).toHaveBeenCalledTimes(
      1,
    );
    expect(
      context.mocks.stripe.checkout.sessions.retrieve,
    ).toHaveBeenCalledTimes(2);
  });

  it("billing-usage-pack-checkout-024 rejects a member selection that misses a current member", async () => {
    const { admin, checkout } = setup({ otherMembers: 1 });

    const response = await accept(
      checkout.create({
        headers,
        body: {
          tier: "pro",
          memberUsagePacks: packs([admin.userId, 20]),
          ...redirects,
        },
      }),
      [400],
    );

    expect(response.body.error).toMatchObject({
      message: "Organization members changed; refresh billing and try again",
      code: "BAD_REQUEST",
    });
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
  });
});
