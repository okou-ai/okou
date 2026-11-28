import { randomUUID } from "node:crypto";

import {
  billingConcurrencyCheckoutContract,
  billingRestoreContract,
  billingStatusContract,
  billingUsagePackCreditsContract,
  billingUsagePackManagementContract,
  billingUsagePackCheckoutContract,
  billingUsagePackMigrationContract,
} from "@okouai/api-contracts/contracts/billing";
import {
  orgInviteContract,
  orgMembersContract,
} from "@okouai/api-contracts/contracts/org-member-routes";
import {
  webhookClerkContract,
  webhookStripeContract,
} from "@okouai/api-contracts/contracts/webhooks";
import { describe, expect, it } from "vitest";
import {
  array,
  number,
  object,
  record,
  string,
  unknown,
  type infer as zInfer,
} from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { env, mockEnv, mockOptionalEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { billingCheckoutRoutes } from "../billing-checkout";
import { billingConcurrencyCheckoutRoutes } from "../billing-concurrency-checkout";
import { billingRestoreRoutes } from "../billing-restore";
import { billingStatusRoutes } from "../billing-status";
import { billingUsagePackCreditsRoutes } from "../billing-usage-pack-credits";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { orgInviteRoutes } from "../org-invite";
import { orgMembersRoutes } from "../org-members";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { webhooksStripeRoutes } from "../webhooks-stripe";
import { createBddApi } from "./helpers/api-bdd";
import { purchaseUsagePacks } from "./helpers/public-usage-pack-checkout";
import { postSubscriptionInvoicePaid } from "./helpers/stripe-billing-webhook";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

const billingCheckoutApp = setupApp({
  context,
  routes: billingCheckoutRoutes,
});
const managementClient = billingCheckoutApp(billingUsagePackManagementContract);
const migrationClient = billingCheckoutApp(billingUsagePackMigrationContract);
const statusClient = setupApp({ context, routes: billingStatusRoutes })(
  billingStatusContract,
);
const creditsClient = setupApp({
  context,
  routes: billingUsagePackCreditsRoutes,
})(billingUsagePackCreditsContract);
const stripeWebhookClient = setupApp({
  context,
  routes: webhooksStripeRoutes,
})(webhookStripeContract);
const clerkWebhookClient = setupApp({ context, routes: webhooksClerkRoutes })(
  webhookClerkContract,
);
const inviteClient = setupApp({ context, routes: orgInviteRoutes })(
  orgInviteContract,
);

interface Admin {
  readonly userId: string;
  readonly orgId: string;
}

function admin(): Admin {
  mockEnv("ENV", "development");
  return { userId: `user_${randomUUID()}`, orgId: `org_${randomUUID()}` };
}

function signIn(actor: Admin) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    "org:admin",
  );
}

/** Clerk answers membership reads per workspace, as the real directory does. */
function clerkMembers(...admins: readonly Admin[]) {
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockImplementation(
    (args: unknown) => {
      const orgId =
        typeof args === "object" &&
        args !== null &&
        "organizationId" in args &&
        typeof args.organizationId === "string"
          ? args.organizationId
          : "";
      return Promise.resolve({
        data: admins
          .filter((candidate) => {
            return candidate.orgId === orgId;
          })
          .map((candidate) => {
            return {
              role: "org:admin",
              publicUserData: { userId: candidate.userId },
              createdAt: now(),
            };
          }),
      });
    },
  );
}

async function readManagement(actor: Admin) {
  signIn(actor);
  const read = await accept(managementClient.get({ headers }), [200]);
  return read.body;
}

async function readStatus(actor: Admin) {
  signIn(actor);
  const read = await accept(statusClient.get({ headers }), [200]);
  return read.body;
}

type PaidEvent = Awaited<ReturnType<typeof purchaseUsagePacks>>;
type PaidInvoice = PaidEvent["data"]["object"];

const CONCURRENCY_PRICE = "price_usage_pack_concurrency";

interface PlanState {
  readonly event: PaidEvent;
  readonly tier: "pro" | "team";
  readonly packs: readonly {
    readonly price: string;
    readonly quantity: number;
  }[];
  readonly concurrency?: number;
  readonly start: number;
  readonly end: number;
  readonly schedule?: string;
  readonly discounts?: readonly string[];
}

const PRICE_20 = "price_public_usage_20";
const PRICE_50 = "price_public_usage_50";
const PRICE_100 = "price_public_usage_100";
const PRICE_200 = "price_public_usage_200";

function planPrice(tier: "pro" | "team") {
  return tier === "team"
    ? "price_public_usage_plan_team"
    : "price_public_usage_plan";
}

/** Stripe's view of the Plan subscription created by the paid checkout. */
function planSubscription(state: PlanState) {
  const invoice = state.event.data.object;
  const period = {
    current_period_start: state.start,
    current_period_end: state.end,
  };
  return {
    id: invoice.parent.subscription_details.subscription,
    customer: invoice.customer,
    status: "active",
    cancel_at: null,
    cancel_at_period_end: false,
    schedule: state.schedule ?? null,
    discounts: state.discounts ?? [],
    trial_end: null,
    metadata: invoice.metadata,
    items: {
      data: [
        {
          id: "si_plan",
          price: {
            id: planPrice(state.tier),
            recurring: { interval: "month", interval_count: 1 },
          },
          quantity: 1,
          ...period,
        },
        ...state.packs.map((pack) => {
          return {
            id: `si_${pack.price}`,
            price: { id: pack.price },
            ...period,
            quantity: pack.quantity,
          };
        }),
        ...(state.concurrency
          ? [
              {
                id: "si_concurrency",
                price: { id: CONCURRENCY_PRICE },
                quantity: state.concurrency,
                ...period,
              },
            ]
          : []),
      ],
    },
  };
}

function invoicePaid(
  event: PaidEvent,
  lines: PaidInvoice["lines"]["data"],
  amountPaid: number,
  invoiceId = `in_${randomUUID()}`,
) {
  return {
    ...event,
    id: `evt_${randomUUID()}`,
    data: {
      object: {
        ...event.data.object,
        id: invoiceId,
        amount_paid: amountPaid,
        lines: { has_more: false, data: lines },
      },
    },
  };
}

function invoiceLine(
  price: string,
  quantity: number,
  amount: number,
  period: { readonly start: number; readonly end: number },
  proration: boolean,
) {
  return {
    id: `il_${randomUUID()}`,
    amount,
    subtotal: amount,
    discount_amounts: [],
    quantity,
    price: { id: price },
    period,
    parent: {
      type: "subscription_item_details",
      subscription_item_details: { proration },
    },
  };
}

async function deliverStripe(
  event: Readonly<Record<string, unknown>> & { readonly id: string },
) {
  context.mocks.stripe.webhooks.constructEventAsync.mockReturnValueOnce(event);
  await accept(
    stripeWebhookClient.post({
      body: JSON.stringify(event),
      extraHeaders: { "stripe-signature": "t=1,v1=usage-pack-subscriptions" },
    }),
    [200],
  );
}

/** Stripe also knows the configured concurrency Price next to the pack catalog. */
function stripeConcurrencyPrice() {
  mockEnv("OKOU_PRICE_CONCURRENCY", CONCURRENCY_PRICE);
  const catalog = context.mocks.stripe.prices.retrieve.getMockImplementation();
  context.mocks.stripe.prices.retrieve.mockImplementation((id: unknown) => {
    if (id !== CONCURRENCY_PRICE) {
      if (!catalog) {
        throw new Error(`Unexpected price ${String(id)}`);
      }
      return catalog(id);
    }
    return Promise.resolve({
      id,
      active: true,
      currency: "usd",
      type: "recurring",
      recurring: { interval: "month", interval_count: 1 },
      unit_amount: 5000,
      tax_behavior: "exclusive",
      product: { id: "prod_concurrency", name: "Concurrency", metadata: {} },
    });
  });
}

function periodOf(event: PaidEvent) {
  const line = event.data.object.lines.data[0];
  if (!line) {
    throw new Error("Expected a paid usage pack line");
  }
  return line.period;
}

async function ownCreditGrants(actor: Admin) {
  signIn(actor);
  const read = await accept(creditsClient.get({ headers }), [200]);
  return read.body.creditGrants;
}

async function memberCreditGrants(owner: Admin, memberId: string) {
  signIn(owner);
  const read = await accept(creditsClient.get({ headers }), [200]);
  return read.body.memberCredits?.find((entry) => {
    return entry.memberId === memberId;
  })?.creditGrants;
}

function invite() {
  return inviteClient;
}

describe("member invitations", () => {
  it("billing-usage-pack-subscriptions-035 invites a member to a Limited Free workspace without a Checkout session", async () => {
    const owner = bdd.user();
    await bdd.bootstrapLimitedFreeOnboarding(owner);
    context.mocks.clerk.organizations.createOrganizationInvitation.mockResolvedValue(
      { id: `orginv_${randomUUID()}` },
    );
    createRouteMocks(context).clerk.session(owner.userId, owner.orgId);

    const invited = await accept(
      invite().invite({
        headers,
        body: { email: "limited-free-1@example.test", role: "member" },
      }),
      [200],
    );

    expect(invited.body.message).toContain("limited-free-1@example.test");
    expect(
      context.mocks.stripe.checkout.sessions.create,
    ).not.toHaveBeenCalled();
  });

  it("billing-usage-pack-subscriptions-040 sends a Clerk member invitation from a managed Pro usage pack workspace", async () => {
    const owner = admin();
    await purchaseUsagePacks(context, owner, [
      { userId: owner.userId, usd: 20 },
    ]);
    context.mocks.clerk.organizations.createOrganizationInvitation.mockResolvedValue(
      { id: `orginv_${randomUUID()}` },
    );
    signIn(owner);

    const invited = await accept(
      invite().invite({
        headers,
        body: { email: "paid@example.test", role: "member" },
      }),
      [200],
    );

    expect(invited.body.message).toContain("paid@example.test");
    expect(
      context.mocks.clerk.organizations.createOrganizationInvitation,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: owner.orgId,
        emailAddress: "paid@example.test",
        role: "org:member",
      }),
    );
  });
});

describe("usage pack subscription management", () => {
  it("billing-usage-pack-subscriptions-011 keeps each workspace's allocations isolated across alternating reads", async () => {
    const proAdmin = admin();
    const teamAdmin = admin();
    await purchaseUsagePacks(context, proAdmin, [
      { userId: proAdmin.userId, usd: 20 },
    ]);
    await purchaseUsagePacks(
      context,
      teamAdmin,
      [{ userId: teamAdmin.userId, usd: 50 }],
      { tier: "team" },
    );
    clerkMembers(proAdmin, teamAdmin);

    const expectOwn = async (
      actor: Admin,
      tier: "pro" | "team",
      usagePackUsd: number,
    ) => {
      const read = await readManagement(actor);
      expect(read.tier).toBe(tier);
      expect(read.allocations).toStrictEqual([
        expect.objectContaining({
          memberId: actor.userId,
          usagePackUsd,
          pendingChange: null,
        }),
      ]);
    };
    await expectOwn(proAdmin, "pro", 20);
    await expectOwn(teamAdmin, "team", 50);
    await expectOwn(proAdmin, "pro", 20);
  });
});

describe("concurrency on the usage pack Plan subscription", () => {
  it("billing-usage-pack-subscriptions-013 lists prorated concurrency on the Plan subscription without new purchased credits", async () => {
    const owner = admin();
    const paid = await purchaseUsagePacks(
      context,
      owner,
      [{ userId: owner.userId, usd: 20 }],
      { tier: "team" },
    );
    stripeConcurrencyPrice();
    const period = periodOf(paid);
    const grantsBefore = await ownCreditGrants(owner);
    expect(grantsBefore).toHaveLength(2);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      planSubscription({
        event: paid,
        tier: "team",
        packs: [{ price: "price_public_usage_20", quantity: 1 }],
        concurrency: 10,
        start: period.start,
        end: period.end,
      }),
    );

    await deliverStripe(
      invoicePaid(
        paid,
        [invoiceLine(CONCURRENCY_PRICE, 10, 25_000, period, true)],
        25_000,
      ),
    );

    const status = await readStatus(owner);
    expect(status.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({
        id: paid.data.object.parent.subscription_details.subscription,
        quantity: 10,
        currentPeriodEnd: new Date(period.end * 1000).toISOString(),
      }),
    ]);
    await expect(ownCreditGrants(owner)).resolves.toStrictEqual(grantsBefore);
  });
});

describe("usage pack renewal", () => {
  it("billing-usage-pack-subscriptions-014 grants one renewal period and lists renewed concurrency once", async () => {
    const owner = admin();
    const paid = await purchaseUsagePacks(
      context,
      owner,
      [{ userId: owner.userId, usd: 20 }],
      { tier: "team" },
    );
    stripeConcurrencyPrice();
    const previous = periodOf(paid);
    const renewal = { start: previous.end, end: previous.end + 30 * 86_400 };
    mockNow((renewal.start + 60) * 1000);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      planSubscription({
        event: paid,
        tier: "team",
        packs: [{ price: "price_public_usage_20", quantity: 1 }],
        concurrency: 6,
        start: renewal.start,
        end: renewal.end,
      }),
    );
    const renewed = invoicePaid(
      paid,
      [
        invoiceLine("price_public_usage_20", 1, 2000, renewal, false),
        invoiceLine(CONCURRENCY_PRICE, 6, 30_000, renewal, false),
      ],
      32_000,
    );
    const renewalEnd = new Date(renewal.end * 1000).toISOString();

    await deliverStripe(renewed);

    const grants = await ownCreditGrants(owner);
    expect(
      grants.map((grant) => {
        return {
          grantType: grant.grantType,
          amount: grant.amount,
          remaining: grant.remaining,
          expiresAt: grant.expiresAt,
        };
      }),
    ).toStrictEqual(
      expect.arrayContaining([
        {
          grantType: "purchased",
          amount: 20_000,
          remaining: 20_000,
          expiresAt: renewalEnd,
        },
        {
          grantType: "bonus",
          amount: 400,
          remaining: 400,
          expiresAt: renewalEnd,
        },
      ]),
    );
    expect(grants).toHaveLength(2);
    const status = await readStatus(owner);
    expect(status.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({ quantity: 6, currentPeriodEnd: renewalEnd }),
    ]);
    const management = await readManagement(owner);
    expect(management.allocations).toStrictEqual([
      expect.objectContaining({
        memberId: owner.userId,
        usagePackUsd: 20,
        currentPeriodEnd: renewalEnd,
        pendingChange: null,
      }),
    ]);

    await deliverStripe(renewed);

    await expect(ownCreditGrants(owner)).resolves.toStrictEqual(grants);
    const replayed = await readStatus(owner);
    expect(replayed.concurrencySubscriptions).toStrictEqual(
      status.concurrencySubscriptions,
    );
  });
});

/** The parts of a Stripe invoice preview request these cases inspect. */
const previewParamsSchema = object({
  preview_mode: string().optional(),
  discounts: unknown().optional(),
  subscription: string().optional(),
  subscription_details: object({
    items: unknown().optional(),
    proration_date: number().optional(),
  }).optional(),
});
type PreviewParams = zInfer<typeof previewParamsSchema>;

async function previewMemberChange(
  source: 20 | 50,
  target: 20 | 50,
): Promise<{
  readonly owner: Admin;
  readonly response: unknown;
  readonly previews: PreviewParams[];
}> {
  const owner = admin();
  const memberId = `user_${randomUUID()}`;
  const paid = await purchaseUsagePacks(context, owner, [
    { userId: owner.userId, usd: source },
    { userId: memberId, usd: source },
  ]);
  const period = periodOf(paid);
  const scheduleId = `sub_sched_${randomUUID()}`;
  const sourcePrice = source === 20 ? PRICE_20 : PRICE_50;
  context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
    planSubscription({
      event: paid,
      tier: "pro",
      packs: [{ price: sourcePrice, quantity: 2 }],
      start: period.start,
      end: period.end,
      schedule: scheduleId,
      discounts: ["di_usage_pack_discount"],
    }),
  );
  const phaseItems = [
    { price: planPrice("pro"), quantity: 1 },
    { price: sourcePrice, quantity: 2 },
  ];
  context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue({
    id: scheduleId,
    end_behavior: "release",
    current_phase: { start_date: period.start, end_date: period.end },
    phases: [
      {
        start_date: period.start,
        end_date: period.end,
        items: phaseItems,
        discounts: [{ discount: "di_usage_pack_discount" }],
      },
      {
        start_date: period.end,
        end_date: period.end + 30 * 86_400,
        items: phaseItems,
        discounts: [{ discount: "di_usage_pack_discount" }],
      },
    ],
  });
  const previews: PreviewParams[] = [];
  context.mocks.stripe.invoices.createPreview.mockImplementation(
    (input: unknown) => {
      const params = previewParamsSchema.parse(input);
      previews.push(params);
      return Promise.resolve({
        currency: "usd",
        amount_due: params.preview_mode === "recurring" ? 8000 : 1500,
      });
    },
  );
  signIn(owner);

  const response = await accept(
    setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackManagementContract,
    ).previewChange({
      headers,
      body: { memberId, targetUsagePackUsd: target },
    }),
    [200],
  );
  return { owner, response: response.body, previews };
}

function expectNoStripeMutation() {
  expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
  expect(
    context.mocks.stripe.subscriptionSchedules.release,
  ).not.toHaveBeenCalled();
  expect(
    context.mocks.stripe.subscriptionSchedules.update,
  ).not.toHaveBeenCalled();
}

describe("member usage pack change previews", () => {
  it("billing-usage-pack-subscriptions-015 previews a scheduled member upgrade against the discounted recurring schedule", async () => {
    const { response, previews } = await previewMemberChange(20, 50);

    expect(response).toMatchObject({
      kind: "upgrade",
      sourceUsagePackUsd: 20,
      targetUsagePackUsd: 50,
      immediateAmountCents: 1500,
      nextRecurringAmountCents: 8000,
      currency: "usd",
    });
    const recurring = previews.filter((params) => {
      return params.preview_mode === "recurring";
    });
    expect(recurring).toStrictEqual([
      expect.objectContaining({
        discounts: [{ discount: "di_usage_pack_discount" }],
        subscription_details: {
          items: expect.arrayContaining([
            { price: planPrice("pro"), quantity: 1 },
            { price: PRICE_20, quantity: 1 },
            { price: PRICE_50, quantity: 1 },
          ]),
        },
      }),
    ]);
    expect(recurring[0]?.subscription_details?.items).toHaveLength(3);
    expectNoStripeMutation();
  });

  it("billing-usage-pack-subscriptions-016 previews a scheduled member downgrade without an immediate charge", async () => {
    const { response, previews } = await previewMemberChange(50, 20);

    expect(response).toMatchObject({
      kind: "downgrade",
      sourceUsagePackUsd: 50,
      targetUsagePackUsd: 20,
      immediateAmountCents: 0,
      nextRecurringAmountCents: 8000,
      currency: "usd",
    });
    expect(previews).toStrictEqual([
      expect.objectContaining({
        preview_mode: "recurring",
        discounts: [{ discount: "di_usage_pack_discount" }],
        subscription_details: {
          items: expect.arrayContaining([
            { price: planPrice("pro"), quantity: 1 },
            { price: PRICE_50, quantity: 1 },
            { price: PRICE_20, quantity: 1 },
          ]),
        },
      }),
    ]);
    expect(previews[0]?.subscription_details?.items).toHaveLength(3);
    expectNoStripeMutation();
  });
});

const schedulePhasesSchema = object({
  phases: array(
    object({
      start_date: number(),
      end_date: number().optional(),
      items: array(unknown()),
    }),
  ),
});
type SchedulePhase = zInfer<typeof schedulePhasesSchema>["phases"][number];

describe("member usage pack change confirmation", () => {
  it("billing-usage-pack-subscriptions-034 pays a member upgrade in app with the saved card and grants it at once", async () => {
    const plan = await proPlanWithMemberPack("2035-01-05T00:00:00.000Z");
    mockNow(Date.parse("2035-01-20T00:00:00.000Z"));
    const withCard = {
      ...plan.subscription,
      default_payment_method: "pm_saved_card",
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(withCard);
    stripePrices(1500, 5000, PRICE_50);
    const preview = await accept(
      plan.management().previewChange({
        headers,
        body: {
          memberId: plan.memberId,
          targetUsagePackUsd: 50,
          supportsInAppPreview: true,
          returnUrl: `${env("APP_URL")}/billing`,
        },
      }),
      [200],
    );
    const token = preview.body.paymentMethodPreviewToken;
    if (!token) {
      throw new Error("Expected a payment-method preview token");
    }
    const prorationDate = Math.floor(
      Date.parse(preview.body.prorationDate) / 1000,
    );
    const upgraded = planSubscription({
      event: plan.paid,
      tier: "pro",
      packs: [{ price: PRICE_50, quantity: 1 }],
      start: plan.period.start,
      end: plan.period.end,
    });
    const paidInvoice = {
      ...invoicePaid(
        plan.paid,
        [
          invoiceLine(
            PRICE_20,
            1,
            -1000,
            { start: prorationDate, end: plan.period.end },
            true,
          ),
          invoiceLine(
            PRICE_50,
            1,
            2500,
            { start: prorationDate, end: plan.period.end },
            true,
          ),
        ],
        1500,
      ).data.object,
      status: "paid",
    };
    context.mocks.stripe.subscriptions.update
      .mockResolvedValueOnce(withCard)
      .mockImplementationOnce(() => {
        // Once Stripe applies the change, reads return the upgraded items.
        context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(upgraded);
        return Promise.resolve({ ...upgraded, latest_invoice: paidInvoice });
      });

    const confirmed = await accept(
      plan.management().confirmChange({
        headers,
        params: { changeId: preview.body.changeId },
        body: { paymentMethodPreviewToken: token },
      }),
      [200],
    );

    expect(confirmed.body).toMatchObject({ status: "completed" });
    expect(context.mocks.stripe.subscriptions.update.mock.calls).toStrictEqual([
      [plan.subscription.id, { default_payment_method: "pm_saved_card" }],
      [
        plan.subscription.id,
        expect.objectContaining({
          payment_behavior: "pending_if_incomplete",
          proration_behavior: "always_invoice",
          proration_date: prorationDate,
        }),
        {
          idempotencyKey: `usage-pack-change:${preview.body.changeId}:apply`,
        },
      ],
    ]);
    const read = await readManagement(plan.owner);
    expect(read.allocations).toStrictEqual([
      expect.objectContaining({
        memberId: plan.memberId,
        usagePackUsd: 50,
        pendingChange: null,
      }),
    ]);
    await expect(
      memberCreditGrants(plan.owner, plan.memberId),
    ).resolves.toHaveLength(4);
  });

  async function scheduledMemberDowngrades() {
    mockNow(Date.parse("2035-03-01T00:00:00.000Z"));
    const owner = admin();
    const members = [`user_${randomUUID()}`, `user_${randomUUID()}`];
    const paid = await purchaseUsagePacks(
      context,
      owner,
      members.map((userId) => {
        return { userId, usd: 50 as const };
      }),
    );
    const period = periodOf(paid);
    const midPeriod = Math.floor(Date.parse("2035-03-16T00:00:00.000Z") / 1000);
    mockNow(midPeriod * 1000);
    const scheduleId = `sub_sched_${randomUUID()}`;
    const subscription = planSubscription({
      event: paid,
      tier: "pro",
      packs: [{ price: PRICE_50, quantity: 2 }],
      start: period.start,
      end: period.end,
    });
    const schedule: {
      readonly id: string;
      readonly end_behavior: string;
      readonly current_phase: { start_date: number; end_date: number };
      phases: SchedulePhase[];
    } = {
      id: scheduleId,
      end_behavior: "release",
      current_phase: { start_date: midPeriod, end_date: period.end },
      phases: [
        {
          start_date: midPeriod,
          end_date: period.end,
          items: [
            { price: planPrice("pro"), quantity: 1 },
            { price: PRICE_50, quantity: 2 },
          ],
        },
      ],
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(subscription);
    context.mocks.stripe.subscriptionSchedules.create.mockImplementation(() => {
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
        ...subscription,
        schedule: scheduleId,
      });
      return Promise.resolve(schedule);
    });
    context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue(
      schedule,
    );
    context.mocks.stripe.subscriptionSchedules.update.mockImplementation(
      (_id: unknown, input: unknown) => {
        const params = schedulePhasesSchema.parse(input);
        schedule.phases = params.phases.map((phase) => {
          return {
            ...phase,
            end_date: phase.end_date ?? phase.start_date + 30 * 86_400,
          };
        });
        return Promise.resolve(schedule);
      },
    );
    stripePrices(0, 6000, PRICE_20);
    const changeIds: string[] = [];
    const statuses: string[] = [];
    for (const memberId of members) {
      signIn(owner);
      const preview = await accept(
        managementClient.previewChange({
          headers,
          body: { memberId, targetUsagePackUsd: 20 },
        }),
        [200],
      );
      changeIds.push(preview.body.changeId);
      signIn(owner);
      const confirmed = await accept(
        managementClient.confirmChange({
          headers,
          params: { changeId: preview.body.changeId },
          body: {},
        }),
        [200],
      );
      statuses.push(confirmed.body.status);
    }
    return { owner, members, paid, period, changeIds, statuses };
  }

  async function membersCreditGrants(owner: Admin, members: readonly string[]) {
    signIn(owner);
    const read = await accept(creditsClient.get({ headers }), [200]);
    return (read.body.memberCredits ?? [])
      .filter((entry) => {
        return members.includes(entry.memberId);
      })
      .flatMap((entry) => {
        return entry.creditGrants;
      });
  }

  it("billing-usage-pack-subscriptions-036 (1/3) schedules both member downgrades into one mid-period Stripe schedule", async () => {
    const { owner, members, period, changeIds, statuses } =
      await scheduledMemberDowngrades();

    expect(statuses).toStrictEqual(["scheduled", "scheduled"]);
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        phases: expect.arrayContaining([
          expect.objectContaining({
            start_date: period.end,
            items: expect.arrayContaining([
              expect.objectContaining({ price: PRICE_20, quantity: 1 }),
              expect.objectContaining({ price: PRICE_50, quantity: 1 }),
            ]),
          }),
        ]),
      }),
      {
        idempotencyKey: `usage-pack-change:${changeIds[0]}:schedule-update`,
      },
    );
    expect(
      context.mocks.stripe.subscriptionSchedules.update,
    ).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        phases: [
          expect.objectContaining({ end_date: period.end }),
          expect.objectContaining({
            start_date: period.end,
            items: expect.arrayContaining([
              expect.objectContaining({ price: PRICE_20, quantity: 2 }),
            ]),
          }),
        ],
      }),
      {
        idempotencyKey: `usage-pack-change:${changeIds[1]}:schedule-update`,
      },
    );
    const [read, grants] = await Promise.all([
      readManagement(owner),
      membersCreditGrants(owner, members),
    ]);
    for (const memberId of members) {
      expect(
        read.allocations.find((allocation) => {
          return allocation.memberId === memberId;
        }),
      ).toMatchObject({ usagePackUsd: 50, pendingChange: expect.anything() });
    }
    expect(grants).toHaveLength(4);
  });

  it("billing-usage-pack-subscriptions-036 (2/3) applies both scheduled downgrades at the period boundary", async () => {
    const { owner, members, paid, period } = await scheduledMemberDowngrades();
    mockNow((period.end + 60) * 1000);
    const renewed = planSubscription({
      event: paid,
      tier: "pro",
      packs: [{ price: PRICE_20, quantity: 2 }],
      start: period.end,
      end: period.end + 30 * 86_400,
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(renewed);

    await deliverStripe({
      id: `evt_${randomUUID()}`,
      type: "customer.subscription.updated",
      created: period.end + 60,
      data: { object: renewed },
    });

    const read = await readManagement(owner);
    expect(
      read.allocations
        .map((allocation) => {
          return [
            allocation.memberId,
            allocation.usagePackUsd,
            allocation.pendingChange,
          ];
        })
        .sort(),
    ).toStrictEqual(
      members
        .map((memberId) => {
          return [memberId, 20, null];
        })
        .sort(),
    );
  });

  it("billing-usage-pack-subscriptions-036 (3/3) leaves management and credit grants unchanged on replayed boundary update", async () => {
    const { owner, members, paid, period } = await scheduledMemberDowngrades();
    mockNow((period.end + 60) * 1000);
    const renewed = planSubscription({
      event: paid,
      tier: "pro",
      packs: [{ price: PRICE_20, quantity: 2 }],
      start: period.end,
      end: period.end + 30 * 86_400,
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(renewed);
    const boundary = {
      id: `evt_${randomUUID()}`,
      type: "customer.subscription.updated",
      created: period.end + 60,
      data: { object: renewed },
    };

    await deliverStripe(boundary);
    await deliverStripe({ ...boundary, id: `evt_${randomUUID()}` });

    const [readAfter, grantsAfter] = await Promise.all([
      readManagement(owner),
      membersCreditGrants(owner, members),
    ]);
    expect(
      readAfter.allocations
        .map((allocation) => {
          return [
            allocation.memberId,
            allocation.usagePackUsd,
            allocation.pendingChange,
          ];
        })
        .sort(),
    ).toStrictEqual(
      members
        .map((memberId) => {
          return [memberId, 20, null];
        })
        .sort(),
    );
    expect(grantsAfter).toStrictEqual([]);
  });

  it("billing-usage-pack-subscriptions-020 refuses a downgrade when the Plan now ends before it takes effect", async () => {
    const owner = admin();
    const memberId = `user_${randomUUID()}`;
    const paid = await purchaseUsagePacks(
      context,
      owner,
      [{ userId: memberId, usd: 50 }],
      { tier: "team" },
    );
    const period = periodOf(paid);
    const subscription = planSubscription({
      event: paid,
      tier: "team",
      packs: [{ price: PRICE_50, quantity: 1 }],
      start: period.start,
      end: period.end,
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(subscription);
    context.mocks.stripe.invoices.createPreview.mockResolvedValue({
      currency: "usd",
      amount_due: 2000,
    });
    signIn(owner);
    const management = setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackManagementContract,
    );
    const preview = await accept(
      management.previewChange({
        headers,
        body: { memberId, targetUsagePackUsd: 20 },
      }),
      [200],
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      ...subscription,
      cancel_at_period_end: true,
      cancel_at: period.end,
    });

    signIn(owner);
    const confirmed = await accept(
      management.confirmChange({
        headers,
        params: { changeId: preview.body.changeId },
        body: {},
      }),
      [409],
    );

    expect(confirmed.body.error.message).toBe(
      "Your Plan is scheduled to end before this usage pack change can take effect. Restore your Plan first, then try again.",
    );
    const read = await readManagement(owner);
    expect(read.allocations).toStrictEqual([
      expect.objectContaining({
        memberId,
        usagePackUsd: 50,
        pendingChange: null,
      }),
    ]);
  });
});

const invitationPreviewParamsSchema = object({
  subscription_details: object({
    items: array(unknown()),
    proration_date: number(),
  }),
});
type InvitationPreviewParams = zInfer<typeof invitationPreviewParamsSchema>;

type PreviewLine = (prorationDate: number, periodEnd: number) => unknown;

/** A mid-period Pro workspace whose single $20 pack belongs to the admin. */
async function midPeriodProWorkspace(
  previewLines: readonly PreviewLine[],
  tier: "pro" | "team" = "pro",
) {
  const midPeriod = Date.parse("2035-05-15T00:00:00.000Z");
  mockNow(midPeriod - 15 * 86_400_000);
  const owner = admin();
  const paid = await purchaseUsagePacks(
    context,
    owner,
    [{ userId: owner.userId, usd: 20 }],
    { tier },
  );
  const period = periodOf(paid);
  mockNow(midPeriod);
  const subscription = planSubscription({
    event: paid,
    tier,
    packs: [{ price: PRICE_20, quantity: 1 }],
    start: period.start,
    end: period.end,
  });
  context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(subscription);
  const previews: InvitationPreviewParams[] = [];
  context.mocks.stripe.invoices.createPreview.mockImplementation(
    (input: unknown) => {
      const params = invitationPreviewParamsSchema.parse(input);
      previews.push(params);
      const prorationDate = params.subscription_details.proration_date;
      return Promise.resolve({
        id: `upcoming_${randomUUID()}`,
        currency: "usd",
        automatic_tax: { enabled: false },
        lines: {
          has_more: false,
          data: previewLines.map((line) => {
            return line(prorationDate, period.end);
          }),
        },
      });
    },
  );
  return { owner, paid, period, previews, subscription };
}

function packPreviewLine(
  amount: number,
  proration: boolean,
  taxes: readonly unknown[] = [],
): PreviewLine {
  return (prorationDate, periodEnd) => {
    return {
      id: `il_${randomUUID()}`,
      amount,
      subtotal: amount,
      discount_amounts: [],
      taxes,
      quantity: 1,
      price: { id: PRICE_20 },
      period: proration
        ? { start: prorationDate, end: periodEnd }
        : { start: periodEnd, end: periodEnd + 30 * 86_400 },
      parent: {
        type: "subscription_item_details",
        subscription_item_details: { proration },
      },
    };
  };
}

async function previewInvitation(owner: Admin, email: string) {
  signIn(owner);
  const preview = await accept(
    invite().previewPurchase({
      headers,
      body: { email, role: "member", usagePackUsd: 20 },
    }),
    [200],
  );
  return preview.body;
}

describe("paid invitation previews", () => {
  it("billing-usage-pack-subscriptions-044 quotes a taxed prorated invitation pack and reuses the identical preview", async () => {
    const { owner, period, previews } = await midPeriodProWorkspace([
      packPreviewLine(1000, true, [
        {
          amount: 100,
          tax_behavior: "exclusive",
          tax_rate_details: { tax_rate: "txr_usage_pack" },
        },
      ]),
    ]);

    const first = await previewInvitation(owner, "invitee@example.test");

    expect(first).toStrictEqual({
      purchaseId: expect.any(String),
      usagePackUsd: 20,
      immediateAmountCents: 1100,
      currency: "usd",
      purchasedCredits: 10_000,
      bonusCredits: 200,
      totalCredits: 10_200,
      currentPeriodEnd: new Date(period.end * 1000).toISOString(),
      expiresAt: expect.any(String),
    });
    await expect(
      previewInvitation(owner, "invitee@example.test"),
    ).resolves.toStrictEqual(first);
    expect(previews).toHaveLength(1);
  });

  it("billing-usage-pack-subscriptions-048 quotes only the proration lines when the invitation raises the pack quantity", async () => {
    const { owner, period, previews } = await midPeriodProWorkspace([
      packPreviewLine(4000, false),
      packPreviewLine(-2000, true),
      packPreviewLine(4000, true),
    ]);

    const preview = await previewInvitation(owner, "second@example.test");

    expect(previews).toHaveLength(1);
    expect(previews[0]?.subscription_details.items).toStrictEqual([
      { id: `si_${PRICE_20}`, quantity: 2 },
    ]);
    expect(preview).toStrictEqual({
      purchaseId: expect.any(String),
      usagePackUsd: 20,
      immediateAmountCents: 2000,
      currency: "usd",
      purchasedCredits: 10_000,
      bonusCredits: 200,
      totalCredits: 10_200,
      currentPeriodEnd: new Date(period.end * 1000).toISOString(),
      expiresAt: expect.any(String),
    });
  });
});

const LEGACY_PRO_PRICE = "price_test_pro";

/** The usage pack catalog the migration quotes against. */
function usagePackCatalog() {
  mockOptionalEnv("STRIPE_SECRET_KEY", "sk_usage_pack_migration");
  mockEnv("OKOU_PRICE_USAGE_PACK_PLAN_PRO", "price_public_usage_plan");
  mockEnv("OKOU_PRICE_USAGE_PACK_PLAN_TEAM", "price_public_usage_plan_team");
  mockEnv("OKOU_PRICE_USAGE_PACK_20", PRICE_20);
  mockEnv("OKOU_PRICE_USAGE_PACK_50", PRICE_50);
  mockEnv("OKOU_PRICE_USAGE_PACK_100", "price_public_usage_100");
  mockEnv("OKOU_PRICE_USAGE_PACK_200", "price_public_usage_200");
  const bonus: Record<number, number> = {
    20: 400,
    50: 2600,
    100: 8700,
    200: 22_200,
  };
  context.mocks.stripe.prices.retrieve.mockImplementation((id: unknown) => {
    const plan = { pro: 2000, team: 20_000 } as const;
    const planTier =
      id === planPrice("pro")
        ? "pro"
        : id === planPrice("team")
          ? "team"
          : null;
    if (planTier) {
      return Promise.resolve({
        id,
        active: true,
        currency: "usd",
        type: "recurring",
        recurring: { interval: "month", interval_count: 1 },
        unit_amount: plan[planTier],
        tax_behavior: "exclusive",
        product: { id: `prod_${planTier}`, name: planTier, metadata: {} },
      });
    }
    const usd = [20, 50, 100, 200].find((value) => {
      return id === `price_public_usage_${value}`;
    });
    if (usd === undefined) {
      throw new Error(`Unexpected price ${String(id)}`);
    }
    return Promise.resolve({
      id,
      active: true,
      currency: "usd",
      type: "recurring",
      recurring: { interval: "month", interval_count: 1 },
      unit_amount: usd * 100,
      tax_behavior: "exclusive",
      product: {
        id: `prod_${usd}`,
        name: `Usage ${usd}`,
        metadata: { bonusCredits: String(bonus[usd]) },
        tax_code: "txcd_10000000",
      },
    });
  });
}

/** A workspace that bought the legacy Pro Plan before usage packs existed. */
async function legacyProWorkspace() {
  const owner = admin();
  const customerId = `cus_${randomUUID()}`;
  const subscriptionId = `sub_${randomUUID()}`;
  const periodEnd = Math.floor(now() / 1000) + 20 * 86_400;
  await postSubscriptionInvoicePaid(context.signal, {
    orgId: owner.orgId,
    userId: owner.userId,
    tier: "pro",
    customerId,
    subscriptionId,
    currentPeriodEnd: new Date(periodEnd * 1000),
  });
  usagePackCatalog();
  clerkMembers(owner);
  context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
    { data: [] },
  );
  const subscription = {
    id: subscriptionId,
    customer: customerId,
    status: "active",
    cancel_at: null,
    cancel_at_period_end: false,
    schedule: null,
    trial_end: null,
    metadata: {},
    items: {
      data: [
        {
          id: "si_legacy_plan",
          price: {
            id: LEGACY_PRO_PRICE,
            recurring: { interval: "month", interval_count: 1 },
          },
          quantity: 1,
          current_period_start: periodEnd - 30 * 86_400,
          current_period_end: periodEnd,
        },
      ],
    },
  };
  context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(subscription);
  context.mocks.stripe.invoices.createPreview.mockResolvedValue({
    currency: "usd",
    amount_due: 2000,
    lines: { has_more: false, data: [] },
  });
  const migration = () => {
    signIn(owner);
    return setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackMigrationContract,
    );
  };
  const preview = async (targetTier: "pro" | "team" = "pro") => {
    const previewed = await accept(
      migration().preview({
        headers,
        body: {
          targetTier,
          memberUsagePacks: [{ memberId: owner.userId, usagePackUsd: 20 }],
        },
      }),
      [200],
    );
    return previewed.body;
  };
  const confirm = async (migrationId: string) => {
    const scheduleId = `sub_sched_${randomUUID()}`;
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValue({
      id: scheduleId,
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: scheduleId,
    });
    const confirmed = await accept(
      migration().confirm({ headers, params: { migrationId }, body: {} }),
      [200],
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      ...subscription,
      schedule: scheduleId,
    });
    return { body: confirmed.body, scheduleId };
  };
  return { owner, subscription, migration, preview, confirm };
}

describe("legacy subscription migration", () => {
  it("billing-usage-pack-subscriptions-004 hides a scheduled migration once Stripe reports the source canceled", async () => {
    const legacy = await legacyProWorkspace();
    const previewed = await legacy.preview();
    const { scheduleId } = await legacy.confirm(previewed.migrationId);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      ...legacy.subscription,
      schedule: scheduleId,
      status: "canceled",
    });

    await accept(legacy.migration().get({ headers }), [404]);
    const retried = await accept(
      legacy.migration().confirm({
        headers,
        params: { migrationId: previewed.migrationId },
        body: {},
      }),
      [409],
    );
    await accept(legacy.migration().get({ headers }), [404]);

    expect(retried.body.error.code).toBe("CONFLICT");
  });

  it("billing-usage-pack-subscriptions-007 makes the workspace eligible again after Stripe cancels the migration schedule", async () => {
    const legacy = await legacyProWorkspace();
    const previewed = await legacy.preview();
    const { scheduleId } = await legacy.confirm(previewed.migrationId);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      legacy.subscription,
    );

    await deliverStripe({
      id: `evt_${randomUUID()}`,
      type: "subscription_schedule.canceled",
      created: Math.floor(now() / 1000),
      data: {
        object: {
          id: scheduleId,
          object: "subscription_schedule",
          status: "canceled",
          subscription: legacy.subscription.id,
          customer: legacy.subscription.customer,
          metadata: {},
        },
      },
    });

    const read = await accept(legacy.migration().get({ headers }), [200]);
    expect(read.body).toMatchObject({ status: "eligible", migrationId: null });
    const again = await legacy.preview();
    expect(again.migrationId).not.toBe(previewed.migrationId);
  });

  it("billing-usage-pack-subscriptions-002 drops a previewed migration when Stripe deletes the legacy Plan and lets the admin buy a Team Plan", async () => {
    const legacy = await legacyProWorkspace();
    stripeConcurrencyPrice();
    const previewed = await legacy.preview("team");
    const canceled = { ...legacy.subscription, status: "canceled" };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(canceled);
    const deletion = {
      id: `evt_${randomUUID()}`,
      type: "customer.subscription.deleted",
      created: Math.floor(now() / 1000),
      data: { object: canceled },
    };
    await deliverStripe(deletion);

    await expect(readStatus(legacy.owner)).resolves.toMatchObject({
      tier: "limited-free-1",
      hasSubscription: false,
    });
    await accept(legacy.migration().get({ headers }), [404]);
    await accept(
      legacy.migration().confirm({
        headers,
        params: { migrationId: previewed.migrationId },
        body: {},
      }),
      [409],
    );

    const checkoutSchema = object({
      customer: string().optional(),
      metadata: object({ usagePackSubscriptionId: string() }).catchall(
        string(),
      ),
    });
    let checkout: zInfer<typeof checkoutSchema> | undefined;
    const sessionId = `cs_${randomUUID()}`;
    context.mocks.stripe.checkout.sessions.create.mockImplementationOnce(
      (input: unknown) => {
        checkout = checkoutSchema.parse(input);
        return Promise.resolve({
          id: sessionId,
          url: `https://checkout.stripe.test/${sessionId}`,
        });
      },
    );
    signIn(legacy.owner);
    const origin = new URL(env("APP_URL")).origin;
    const bought = await accept(
      setupApp({ context, routes: billingCheckoutRoutes })(
        billingUsagePackCheckoutContract,
      ).create({
        headers,
        body: {
          tier: "team",
          memberUsagePacks: [
            { memberId: legacy.owner.userId, usagePackUsd: 20 },
          ],
          successUrl: `${origin}/billing`,
          cancelUrl: `${origin}/billing`,
        },
      }),
      [200],
    );
    expect(bought.body).toStrictEqual({
      url: `https://checkout.stripe.test/${sessionId}`,
    });

    if (!checkout) {
      throw new Error("Stripe checkout did not receive allocation metadata");
    }
    const customer = checkout.customer ?? legacy.subscription.customer;
    const subscriptionId = `sub_${randomUUID()}`;
    const start = Math.floor(now() / 1000);
    const period = { start, end: start + 30 * 86_400 };
    const purchase: PaidEvent = {
      id: `evt_${randomUUID()}`,
      type: "invoice.paid",
      created: start,
      data: {
        object: {
          id: `in_${randomUUID()}`,
          customer,
          metadata: checkout.metadata,
          status: "paid",
          paid: true,
          paid_out_of_band: false,
          currency: "usd",
          amount_paid: 2000,
          parent: {
            subscription_details: {
              subscription: subscriptionId,
              metadata: checkout.metadata,
            },
          },
          lines: {
            has_more: false,
            data: [invoiceLine(PRICE_20, 1, 2000, period, false)],
          },
        },
      },
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      planSubscription({
        event: purchase,
        tier: "team",
        packs: [{ price: PRICE_20, quantity: 1 }],
        start: period.start,
        end: period.end,
      }),
    );
    await deliverStripe(purchase);

    await expect(readStatus(legacy.owner)).resolves.toMatchObject({
      tier: "team",
      status: "active",
      showUsagePack: true,
      currentPeriodEnd: new Date(period.end * 1000).toISOString(),
    });
    const management = await readManagement(legacy.owner);
    expect(management.allocations).toStrictEqual([
      expect.objectContaining({
        memberId: legacy.owner.userId,
        usagePackUsd: 20,
      }),
    ]);
    const grants = await ownCreditGrants(legacy.owner);
    expect(
      grants
        .map((grant) => {
          return `${grant.grantType}:${grant.amount}`;
        })
        .sort(),
    ).toStrictEqual(["bonus:400", "purchased:20000"]);

    await deliverStripe({ ...deletion });

    await expect(readStatus(legacy.owner)).resolves.toMatchObject({
      tier: "team",
      status: "active",
    });
    await expect(ownCreditGrants(legacy.owner)).resolves.toStrictEqual(grants);
    await accept(legacy.migration().get({ headers }), [404]);
  });

  it("billing-usage-pack-subscriptions-001 schedules only the previewed configuration when a member joins after the preview", async () => {
    const legacy = await legacyProWorkspace();
    const statusBefore = await readStatus(legacy.owner);
    const creditsBefore = await ownCreditGrants(legacy.owner);
    const previewed = await legacy.preview();
    const joined = {
      userId: `user_${randomUUID()}`,
      orgId: legacy.owner.orgId,
    };
    clerkMembers(legacy.owner, joined);

    const { body } = await legacy.confirm(previewed.migrationId);

    expect(body.status).toBe("scheduled");
    const read = await accept(legacy.migration().get({ headers }), [200]);
    expect(read.body).toMatchObject({
      status: "scheduled",
      migrationId: previewed.migrationId,
      configuration: {
        memberUsagePacks: [{ memberId: legacy.owner.userId, usagePackUsd: 20 }],
      },
    });
    const statusAfter = await readStatus(legacy.owner);
    expect({
      tier: statusAfter.tier,
      credits: statusAfter.credits,
      creditGrants: statusAfter.creditGrants,
    }).toStrictEqual({
      tier: statusBefore.tier,
      credits: statusBefore.credits,
      creditGrants: statusBefore.creditGrants,
    });
    await expect(ownCreditGrants(legacy.owner)).resolves.toStrictEqual(
      creditsBefore,
    );
  });

  async function legacyTeamMigrationWithPendingInvite(
    invoiceAmountCents: 20_000 | 0,
  ) {
    const owner = admin();
    const customerId = `cus_${randomUUID()}`;
    const subscriptionId = `sub_${randomUUID()}`;
    const invitationId = `orginv_${randomUUID()}`;
    const inviteeEmail = "pending-migration@example.test";
    const periodEnd = Math.floor(now() / 1000) + 20 * 86_400;
    const nextPeriodEnd = periodEnd + 30 * 86_400;
    await postSubscriptionInvoicePaid(context.signal, {
      orgId: owner.orgId,
      userId: owner.userId,
      tier: "team",
      customerId,
      subscriptionId,
      currentPeriodEnd: new Date(periodEnd * 1000),
    });
    usagePackCatalog();
    clerkMembers(owner);
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      {
        data: [
          {
            id: invitationId,
            emailAddress: inviteeEmail,
            role: "org:member",
            status: "pending",
            createdAt: now(),
          },
        ],
        totalCount: 1,
      },
    );
    const legacySub = {
      id: subscriptionId,
      customer: customerId,
      status: "active",
      cancel_at: null,
      cancel_at_period_end: false,
      schedule: null,
      discounts: [],
      trial_end: null,
      metadata: {},
      items: {
        data: [
          {
            id: "si_legacy_team",
            price: {
              id: "price_test_team",
              recurring: { interval: "month", interval_count: 1 },
            },
            quantity: 1,
            current_period_start: periodEnd - 30 * 86_400,
            current_period_end: periodEnd,
          },
        ],
      },
    };
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(legacySub);
    context.mocks.stripe.invoices.createPreview.mockResolvedValue({
      currency: "usd",
      amount_due: 20_000,
      lines: {
        has_more: false,
        data: [
          {
            id: `il_prev_plan_${randomUUID()}`,
            amount: 16_000,
            subtotal: 16_000,
            discount_amounts: [],
            taxes: [],
            quantity: 1,
            pricing: { price_details: { price: planPrice("team") } },
            period: { start: periodEnd, end: nextPeriodEnd },
            parent: {
              type: "subscription_item_details",
              subscription_item_details: { proration: false },
            },
          },
          {
            id: `il_prev_pack_${randomUUID()}`,
            amount: 4000,
            subtotal: 4000,
            discount_amounts: [],
            taxes: [],
            quantity: 2,
            pricing: { price_details: { price: PRICE_20 } },
            period: { start: periodEnd, end: nextPeriodEnd },
            parent: {
              type: "subscription_item_details",
              subscription_item_details: { proration: false },
            },
          },
        ],
      },
    });
    signIn(owner);
    const previewed = await accept(
      migrationClient.preview({
        headers,
        body: {
          targetTier: "team",
          memberUsagePacks: [
            { memberId: owner.userId, usagePackUsd: 20 },
            { memberId: invitationId, usagePackUsd: 20 },
          ],
        },
      }),
      [200],
    );
    const scheduleId = `sub_sched_${randomUUID()}`;
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValue({
      id: scheduleId,
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: scheduleId,
    });
    signIn(owner);
    const confirmed = await accept(
      migrationClient.confirm({
        headers,
        params: { migrationId: previewed.body.migrationId },
        body: {},
      }),
      [200],
    );

    const paymentIntentId = `pi_${randomUUID()}`;
    const migrationInvoiceId = `in_mig_${randomUUID()}`;
    let subscriptionMetadata: Record<string, string> = {};
    const buildMigratedSubscription = (
      latestInvoiceId: string | null,
      attachedSchedule: string | null = null,
    ) => {
      return {
        id: subscriptionId,
        customer: customerId,
        status: "active",
        cancel_at: null,
        cancel_at_period_end: false,
        schedule: attachedSchedule,
        discounts: [],
        trial_end: null,
        metadata: subscriptionMetadata,
        latest_invoice: latestInvoiceId,
        items: {
          data: [
            {
              id: "si_plan",
              price: {
                id: planPrice("team"),
                recurring: { interval: "month", interval_count: 1 },
              },
              quantity: 1,
              current_period_start: periodEnd,
              current_period_end: nextPeriodEnd,
            },
            {
              id: `si_${PRICE_20}`,
              price: {
                id: PRICE_20,
                recurring: { interval: "month", interval_count: 1 },
              },
              quantity: 2,
              current_period_start: periodEnd,
              current_period_end: nextPeriodEnd,
            },
          ],
        },
      };
    };
    const migrationInvoice = {
      id: migrationInvoiceId,
      customer: customerId,
      currency: "usd",
      status: "paid",
      paid: true,
      paid_out_of_band: false,
      amount_due: invoiceAmountCents,
      amount_paid: invoiceAmountCents,
      hosted_invoice_url: null,
      metadata: {},
      status_transitions: { paid_at: periodEnd + 60 },
      parent: {
        subscription_details: {
          subscription: subscriptionId,
          metadata: {},
        },
      },
      payments: {
        data:
          invoiceAmountCents > 0
            ? [
                {
                  status: "paid",
                  amount_paid: invoiceAmountCents,
                  payment: {
                    type: "payment_intent",
                    payment_intent: paymentIntentId,
                  },
                },
              ]
            : [],
      },
      lines: {
        has_more: false,
        data: [
          {
            id: `il_mig_plan_${randomUUID()}`,
            amount: 16_000,
            subtotal: 16_000,
            discount_amounts: [],
            quantity: 1,
            price: { id: planPrice("team") },
            pricing: { price_details: { price: planPrice("team") } },
            period: { start: periodEnd, end: nextPeriodEnd },
            parent: {
              type: "subscription_item_details",
              subscription_item_details: { proration: false },
            },
          },
          {
            id: `il_mig_pack_${randomUUID()}`,
            amount: 4000,
            subtotal: 4000,
            discount_amounts: [],
            quantity: 2,
            price: { id: PRICE_20 },
            pricing: { price_details: { price: PRICE_20 } },
            period: { start: periodEnd, end: nextPeriodEnd },
            parent: {
              type: "subscription_item_details",
              subscription_item_details: { proration: false },
            },
          },
        ],
      },
    };

    function startScheduledPhase(latestInvoiceId: string | null) {
      mockNow((periodEnd + 60) * 1000);
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
        buildMigratedSubscription(latestInvoiceId),
      );
      context.mocks.stripe.subscriptions.update.mockImplementation(
        (_id: unknown, input: unknown) => {
          if (
            typeof input === "object" &&
            input !== null &&
            "metadata" in input &&
            typeof input.metadata === "object" &&
            input.metadata !== null
          ) {
            subscriptionMetadata = {
              ...subscriptionMetadata,
              ...(input.metadata as Record<string, string>),
            };
          }
          const updated = buildMigratedSubscription(latestInvoiceId);
          context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
            updated,
          );
          return Promise.resolve(updated);
        },
      );
      context.mocks.stripe.invoices.retrieve.mockResolvedValue(
        migrationInvoice,
      );
    }

    async function deliverMigrationInvoice() {
      await deliverStripe({
        id: `evt_${randomUUID()}`,
        type: "invoice.paid",
        created: periodEnd + 60,
        data: { object: migrationInvoice },
      });
    }

    function mockRevokeSchedule() {
      const revokeScheduleId = `sub_sched_rev_${randomUUID()}`;
      const revokeSchedule: {
        readonly id: string;
        readonly end_behavior: string;
        readonly current_phase: { start_date: number; end_date: number };
        phases: SchedulePhase[];
      } = {
        id: revokeScheduleId,
        end_behavior: "release",
        current_phase: { start_date: periodEnd, end_date: nextPeriodEnd },
        phases: [
          {
            start_date: periodEnd,
            end_date: nextPeriodEnd,
            items: [
              { price: planPrice("team"), quantity: 1 },
              { price: PRICE_20, quantity: 2 },
            ],
          },
        ],
      };
      context.mocks.clerk.organizations.revokeOrganizationInvitation.mockResolvedValue(
        {},
      );
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
        buildMigratedSubscription(migrationInvoiceId, revokeScheduleId),
      );
      context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue(
        revokeSchedule,
      );
      context.mocks.stripe.subscriptionSchedules.update.mockImplementation(
        (_id: unknown, input: unknown) => {
          const params = schedulePhasesSchema.parse(input);
          revokeSchedule.phases = params.phases.map((phase) => {
            return {
              ...phase,
              end_date: phase.end_date ?? phase.start_date + 30 * 86_400,
            };
          });
          return Promise.resolve(revokeSchedule);
        },
      );
      return revokeSchedule;
    }

    return {
      owner,
      customerId,
      subscriptionId,
      invitationId,
      scheduleId,
      periodEnd,
      migrationId: previewed.body.migrationId,
      confirmedStatus: confirmed.body.status,
      paymentIntentId,
      migrationInvoiceId,
      startScheduledPhase,
      deliverMigrationInvoice,
      mockRevokeSchedule,
    };
  }

  it("billing-usage-pack-subscriptions-009 (1/2) schedules legacy Team migration and materializes the admin's $20 pack on paid invoice", async () => {
    const mig = await legacyTeamMigrationWithPendingInvite(20_000);
    expect(mig.confirmedStatus).toBe("scheduled");

    mig.startScheduledPhase(mig.migrationInvoiceId);
    await mig.deliverMigrationInvoice();

    const read = await readManagement(mig.owner);
    expect(read.allocations).toContainEqual(
      expect.objectContaining({
        memberId: mig.owner.userId,
        usagePackUsd: 20,
      }),
    );
  });

  it("billing-usage-pack-subscriptions-009 (2/2) refunds only the pending invitation's $20 share of a migration payment on revoke", async () => {
    const mig = await legacyTeamMigrationWithPendingInvite(20_000);
    mig.startScheduledPhase(mig.migrationInvoiceId);
    await mig.deliverMigrationInvoice();

    const revokeSchedule = mig.mockRevokeSchedule();
    context.mocks.stripe.refunds.create.mockResolvedValue({
      id: `re_${randomUUID()}`,
      status: "succeeded",
      amount: 2000,
      payment_intent: mig.paymentIntentId,
    });

    signIn(mig.owner);
    const revoked = await accept(
      invite().revoke({ headers, body: { invitationId: mig.invitationId } }),
      [200],
    );

    expect(revoked.status).toBe(200);
    expect(context.mocks.stripe.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_intent: mig.paymentIntentId,
        amount: 2000,
      }),
      expect.anything(),
    );
    expect(revokeSchedule.phases.at(-1)?.items).toContainEqual(
      expect.objectContaining({ price: PRICE_20, quantity: 1 }),
    );
  });

  it("billing-usage-pack-subscriptions-010 (1/3) keeps a zero-amount Team migration scheduled after schedule completion while awaiting the invoice", async () => {
    const mig = await legacyTeamMigrationWithPendingInvite(0);
    expect(mig.confirmedStatus).toBe("scheduled");

    mig.startScheduledPhase(null);
    await deliverStripe({
      id: `evt_${randomUUID()}`,
      type: "subscription_schedule.completed",
      created: mig.periodEnd + 60,
      data: {
        object: {
          id: mig.scheduleId,
          object: "subscription_schedule",
          status: "completed",
          subscription: mig.subscriptionId,
          customer: mig.customerId,
          metadata: {},
        },
      },
    });

    signIn(mig.owner);
    const read = await accept(migrationClient.get({ headers }), [200]);
    expect(read.body).toMatchObject({
      status: "scheduled",
      migrationId: mig.migrationId,
    });
  });

  it("billing-usage-pack-subscriptions-010 (2/3) fulfills a zero-amount Team migration invoice once across replayed deliveries", async () => {
    const mig = await legacyTeamMigrationWithPendingInvite(0);
    mig.startScheduledPhase(mig.migrationInvoiceId);

    await mig.deliverMigrationInvoice();
    const [managementFirst, grantsFirst] = await Promise.all([
      readManagement(mig.owner),
      ownCreditGrants(mig.owner),
    ]);
    expect(managementFirst.allocations).toContainEqual(
      expect.objectContaining({
        memberId: mig.owner.userId,
        usagePackUsd: 20,
      }),
    );

    await mig.deliverMigrationInvoice();
    const [managementSecond, grantsSecond] = await Promise.all([
      readManagement(mig.owner),
      ownCreditGrants(mig.owner),
    ]);
    expect(managementSecond).toStrictEqual(managementFirst);
    expect(grantsSecond).toStrictEqual(grantsFirst);
  });

  it("billing-usage-pack-subscriptions-010 (3/3) revokes a zero-amount migration invitation without creating a Stripe refund", async () => {
    const mig = await legacyTeamMigrationWithPendingInvite(0);
    mig.startScheduledPhase(mig.migrationInvoiceId);
    await mig.deliverMigrationInvoice();

    const revokeSchedule = mig.mockRevokeSchedule();
    context.mocks.stripe.refunds.create.mockClear();

    signIn(mig.owner);
    const revoked = await accept(
      invite().revoke({ headers, body: { invitationId: mig.invitationId } }),
      [200],
    );

    expect(revoked.body).toStrictEqual({
      message: "Invitation revoked and refund initiated",
    });
    const after = await readManagement(mig.owner);
    expect(after.allocations).toHaveLength(1);
    expect(context.mocks.stripe.refunds.create).not.toHaveBeenCalled();
    expect(revokeSchedule.phases.at(-1)?.items).toContainEqual(
      expect.objectContaining({ price: PRICE_20, quantity: 1 }),
    );
  });
});

/** A Pro Plan whose only pack ($20) belongs to a member, bought at the period start. */
async function proPlanWithMemberPack(
  periodStart: string,
  tier: "pro" | "team" = "pro",
  packOwner: "member" | "admin" = "member",
) {
  mockNow(Date.parse(periodStart));
  const owner = admin();
  const memberId = `user_${randomUUID()}`;
  const paid = await purchaseUsagePacks(
    context,
    owner,
    [{ userId: packOwner === "admin" ? owner.userId : memberId, usd: 20 }],
    { tier },
  );
  usagePackCatalog();
  stripeConcurrencyPrice();
  const period = periodOf(paid);
  const subscription = planSubscription({
    event: paid,
    tier,
    packs: [{ price: PRICE_20, quantity: 1 }],
    start: period.start,
    end: period.end,
  });
  context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(subscription);
  const management = () => {
    signIn(owner);
    return setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackManagementContract,
    );
  };
  return { owner, memberId, paid, period, subscription, management };
}

/** Stripe prices the change: one prorated line now, a recurring total later. */
function stripePrices(
  immediate: number,
  recurring: number,
  immediatePrice: string,
) {
  const previews: PreviewParams[] = [];
  context.mocks.stripe.invoices.createPreview.mockImplementation(
    (input: unknown) => {
      const params = previewParamsSchema.parse(input);
      previews.push(params);
      const prorationDate = params.subscription_details?.proration_date;
      return Promise.resolve({
        id: `upcoming_${randomUUID()}`,
        currency: "usd",
        amount_due: params.preview_mode === "recurring" ? recurring : immediate,
        lines: {
          has_more: false,
          data:
            params.preview_mode === "recurring" || prorationDate === undefined
              ? []
              : [
                  {
                    id: `il_${randomUUID()}`,
                    amount: immediate,
                    taxes: [],
                    pricing: { price_details: { price: immediatePrice } },
                    period: { start: prorationDate, end: prorationDate + 1 },
                    parent: {
                      type: "subscription_item_details",
                      subscription_item_details: { proration: true },
                    },
                  },
                ],
        },
      });
    },
  );
  return previews;
}

/** A Team Plan bought through Checkout where one person holds a $100 pack. */
async function teamPlanWithHundredPack(holder: "member" | "admin") {
  mockNow(Date.parse("2035-03-01T00:00:00.000Z"));
  const owner = admin();
  const member =
    holder === "admin"
      ? owner
      : { userId: `user_${randomUUID()}`, orgId: owner.orgId };
  usagePackCatalog();
  stripeConcurrencyPrice();
  mockOptionalEnv("STRIPE_WEBHOOK_SECRET", `whsec_${randomUUID()}`);
  clerkMembers(...new Set([owner, member]));
  context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
    id: owner.orgId,
    name: "Hundred pack team",
    slug: `team-${randomUUID()}`,
    createdBy: owner.userId,
    createdAt: now(),
  });
  context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
    { data: [] },
  );
  const customer = `cus_${randomUUID()}`;
  context.mocks.stripe.customers.create.mockResolvedValueOnce({ id: customer });
  const checkoutSchema = object({
    metadata: object({ usagePackSubscriptionId: string() }).catchall(string()),
  });
  let metadata: zInfer<typeof checkoutSchema>["metadata"] | undefined;
  const sessionId = `cs_${randomUUID()}`;
  context.mocks.stripe.checkout.sessions.create.mockImplementationOnce(
    (input: unknown) => {
      metadata = checkoutSchema.parse(input).metadata;
      return Promise.resolve({
        id: sessionId,
        url: `https://checkout.stripe.test/${sessionId}`,
      });
    },
  );
  signIn(owner);
  const origin = new URL(env("APP_URL")).origin;
  await accept(
    setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackCheckoutContract,
    ).create({
      headers,
      body: {
        tier: "team",
        memberUsagePacks:
          holder === "admin"
            ? [{ memberId: owner.userId, usagePackUsd: 100 }]
            : [
                { memberId: owner.userId, usagePackUsd: 0 },
                { memberId: member.userId, usagePackUsd: 100 },
              ],
        successUrl: `${origin}/billing`,
        cancelUrl: `${origin}/billing`,
      },
    }),
    [200],
  );
  if (!metadata) {
    throw new Error("Stripe checkout did not receive allocation metadata");
  }
  const start = Math.floor(now() / 1000);
  const period = { start, end: start + 30 * 86_400 };
  const paid: PaidEvent = {
    id: `evt_${randomUUID()}`,
    type: "invoice.paid",
    created: start,
    data: {
      object: {
        id: `in_${randomUUID()}`,
        customer,
        metadata,
        status: "paid",
        paid: true,
        paid_out_of_band: false,
        currency: "usd",
        amount_paid: 10_000,
        parent: {
          subscription_details: {
            subscription: `sub_${randomUUID()}`,
            metadata,
          },
        },
        lines: {
          has_more: false,
          data: [invoiceLine(PRICE_100, 1, 10_000, period, false)],
        },
      },
    },
  };
  const subscription = {
    ...planSubscription({
      event: paid,
      tier: "team",
      packs: [{ price: PRICE_100, quantity: 1 }],
      start: period.start,
      end: period.end,
    }),
    default_payment_method: "pm_team_card",
  };
  context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(subscription);
  await deliverStripe(paid);
  const management = () => {
    signIn(owner);
    return setupApp({ context, routes: billingCheckoutRoutes })(
      billingUsagePackManagementContract,
    );
  };
  return {
    owner,
    memberId: member.userId,
    paid,
    period,
    subscription,
    management,
  };
}

/** Given of 038: the admin's $100 pack is scheduled to drop to $20 in a Stripe schedule. */
async function scheduledHundredPackDowngrade() {
  const plan = await teamPlanWithHundredPack("admin");
  const midPeriod = Math.floor(Date.parse("2035-03-16T00:00:00.000Z") / 1000);
  mockNow(midPeriod * 1000);
  const scheduleId = `sub_sched_${randomUUID()}`;
  const schedule: {
    readonly id: string;
    readonly end_behavior: string;
    readonly current_phase: { start_date: number; end_date: number };
    phases: SchedulePhase[];
  } = {
    id: scheduleId,
    end_behavior: "release",
    current_phase: { start_date: midPeriod, end_date: plan.period.end },
    phases: [
      {
        start_date: midPeriod,
        end_date: plan.period.end,
        items: [
          { price: planPrice("team"), quantity: 1 },
          { price: PRICE_100, quantity: 1 },
        ],
      },
    ],
  };
  const scheduled = { ...plan.subscription, schedule: scheduleId };
  context.mocks.stripe.subscriptionSchedules.create.mockImplementation(() => {
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(scheduled);
    return Promise.resolve(schedule);
  });
  context.mocks.stripe.subscriptionSchedules.retrieve.mockResolvedValue(
    schedule,
  );
  context.mocks.stripe.subscriptionSchedules.update.mockImplementation(
    (_id: unknown, input: unknown) => {
      const params = schedulePhasesSchema.parse(input);
      schedule.phases = params.phases.map((phase) => {
        return {
          ...phase,
          end_date: phase.end_date ?? phase.start_date + 30 * 86_400,
        };
      });
      return Promise.resolve(schedule);
    },
  );
  stripePrices(0, 22_000, PRICE_20);
  const preview = await accept(
    plan.management().previewChange({
      headers,
      body: { memberId: plan.owner.userId, targetUsagePackUsd: 20 },
    }),
    [200],
  );
  const confirmed = await accept(
    plan.management().confirmChange({
      headers,
      params: { changeId: preview.body.changeId },
      body: {},
    }),
    [200],
  );
  if (confirmed.body.status !== "scheduled") {
    throw new Error("Expected the $20 downgrade to be scheduled");
  }
  return { ...plan, scheduleId, scheduled };
}

describe("existing subscription changes", () => {
  it("billing-usage-pack-subscriptions-022 previews a mid-period pack upgrade with prorated credits and a fresh change each time", async () => {
    const plan = await proPlanWithMemberPack("2035-01-01T00:00:00.000Z");
    mockNow(Date.parse("2035-01-16T00:00:00.000Z"));
    const previews = stripePrices(1500, 5000, PRICE_50);
    const body = {
      targetTier: "pro" as const,
      memberUsagePacks: [
        { memberId: plan.owner.userId, usagePackUsd: 0 as const },
        { memberId: plan.memberId, usagePackUsd: 50 as const },
      ],
    };

    const first = await accept(
      plan.management().previewSubscriptionChange({ headers, body }),
      [200],
    );
    expect(first.body.immediateCreditGrant).toStrictEqual({
      purchasedCredits: 15_000,
      bonusCredits: 1100,
      totalCredits: 16_100,
      expiresAt: new Date(plan.period.end * 1000).toISOString(),
    });
    const read = await readManagement(plan.owner);
    expect(
      read.allocations.find((allocation) => {
        return allocation.memberId === plan.memberId;
      })?.pendingChange,
    ).toBeNull();
    const second = await accept(
      plan.management().previewSubscriptionChange({ headers, body }),
      [200],
    );

    expect(second.body.changeId).not.toBe(first.body.changeId);
    expect(previews).toHaveLength(4);
  });

  it("billing-usage-pack-subscriptions-023 applies a paid Team Plan upgrade in place and keeps the member's pack", async () => {
    const plan = await proPlanWithMemberPack("2035-01-01T00:00:00.000Z");
    mockNow(Date.parse("2035-01-16T00:00:00.000Z"));
    const previews = stripePrices(8000, 18_000, planPrice("team"));
    const grantsBefore = await memberCreditGrants(plan.owner, plan.memberId);
    expect(grantsBefore).toHaveLength(2);
    const memberUsagePacks = [
      { memberId: plan.owner.userId, usagePackUsd: 0 as const },
      { memberId: plan.memberId, usagePackUsd: 20 as const },
    ];

    const preview = await accept(
      plan.management().previewSubscriptionChange({
        headers,
        body: { targetTier: "team", memberUsagePacks },
      }),
      [200],
    );
    expect(preview.body).toMatchObject({
      sourceTier: "pro",
      targetTier: "team",
      immediateAmountCents: 8000,
      nextRecurringAmountCents: 18_000,
      currency: "usd",
    });
    expect(previews).toHaveLength(2);
    for (const params of previews) {
      expect(params.subscription).toBe(plan.subscription.id);
      expect(params.subscription_details?.items).toStrictEqual([
        expect.objectContaining({ id: "si_plan", price: planPrice("team") }),
      ]);
    }

    const invoiceId = `in_${randomUUID()}`;
    const teamSubscription = planSubscription({
      event: plan.paid,
      tier: "team",
      packs: [{ price: PRICE_20, quantity: 1 }],
      start: plan.period.start,
      end: plan.period.end,
    });
    context.mocks.stripe.subscriptions.update.mockResolvedValue({
      ...teamSubscription,
      latest_invoice: {
        id: invoiceId,
        status: "paid",
        hosted_invoice_url: null,
      },
    });
    const checkoutSessions =
      context.mocks.stripe.checkout.sessions.create.mock.calls.length;
    const confirmed = await accept(
      plan.management().confirmSubscriptionChange({
        headers,
        body: { changeId: preview.body.changeId },
      }),
      [200],
    );

    expect(confirmed.body).toStrictEqual({
      status: "processing",
      effectiveAt: preview.body.prorationDate,
      hostedInvoiceUrl: null,
    });
    const prorationDate = Math.floor(
      Date.parse(preview.body.prorationDate) / 1000,
    );
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledTimes(1);
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      plan.subscription.id,
      expect.objectContaining({
        items: [
          expect.objectContaining({ id: "si_plan", price: planPrice("team") }),
        ],
        payment_behavior: "pending_if_incomplete",
        proration_behavior: "always_invoice",
        proration_date: prorationDate,
      }),
      { idempotencyKey: expect.any(String) },
    );
    expect(
      context.mocks.stripe.checkout.sessions.create.mock.calls,
    ).toHaveLength(checkoutSessions);

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      teamSubscription,
    );
    await deliverStripe(
      invoicePaid(
        plan.paid,
        [
          invoiceLine(
            planPrice("team"),
            1,
            8000,
            { start: prorationDate, end: plan.period.end },
            true,
          ),
        ],
        8000,
        invoiceId,
      ),
    );

    await expect(readStatus(plan.owner)).resolves.toMatchObject({
      tier: "team",
    });
    const read = await readManagement(plan.owner);
    expect(read.tier).toBe("team");
    expect(read.allocations).toStrictEqual([
      expect.objectContaining({
        memberId: plan.memberId,
        usagePackUsd: 20,
        pendingChange: null,
      }),
    ]);
    await expect(
      memberCreditGrants(plan.owner, plan.memberId),
    ).resolves.toStrictEqual(grantsBefore);
  });

  async function pendingTeamUpgrade() {
    const plan = await proPlanWithMemberPack("2035-01-01T00:00:00.000Z");
    mockNow(Date.parse("2035-01-16T00:00:00.000Z"));
    stripePrices(8000, 18_000, planPrice("team"));
    signIn(plan.owner);
    const preview = await accept(
      managementClient.previewSubscriptionChange({
        headers,
        body: {
          targetTier: "team",
          memberUsagePacks: [
            { memberId: plan.owner.userId, usagePackUsd: 0 },
            { memberId: plan.memberId, usagePackUsd: 20 },
          ],
        },
      }),
      [200],
    );
    const invoiceId = `in_${randomUUID()}`;
    const pending = {
      ...plan.subscription,
      pending_update: {
        expires_at: plan.period.end - 86_400,
        subscription_items: [
          { id: "si_plan", price: { id: planPrice("team") } },
        ],
      },
    };
    context.mocks.stripe.subscriptions.update.mockResolvedValue({
      ...pending,
      latest_invoice: {
        id: invoiceId,
        status: "open",
        hosted_invoice_url: `https://invoice.stripe.test/${invoiceId}`,
      },
    });
    signIn(plan.owner);
    const confirmed = await accept(
      managementClient.confirmSubscriptionChange({
        headers,
        body: { changeId: preview.body.changeId },
      }),
      [200],
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(pending);
    await deliverStripe({
      id: `evt_${randomUUID()}`,
      type: "customer.subscription.updated",
      created: Math.floor(now() / 1000),
      data: { object: pending },
    });
    return {
      plan,
      preview: preview.body,
      confirmed: confirmed.body,
      invoiceId,
    };
  }

  it("billing-usage-pack-subscriptions-024 (1/3) keeps Pro while the confirmed Team upgrade awaits payment", async () => {
    const pending = await pendingTeamUpgrade();

    expect(pending.confirmed).toStrictEqual({
      status: "pending_payment",
      effectiveAt: pending.preview.prorationDate,
      hostedInvoiceUrl: `https://invoice.stripe.test/${pending.invoiceId}`,
    });
    await expect(readStatus(pending.plan.owner)).resolves.toMatchObject({
      tier: "pro",
    });
  });

  it("billing-usage-pack-subscriptions-024 (2/3) activates Team once across concurrent paid upgrade invoices", async () => {
    const { plan, preview, invoiceId } = await pendingTeamUpgrade();
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      planSubscription({
        event: plan.paid,
        tier: "team",
        packs: [{ price: PRICE_20, quantity: 1 }],
        start: plan.period.start,
        end: plan.period.end,
      }),
    );
    const prorationDate = Math.floor(Date.parse(preview.prorationDate) / 1000);
    const paidUpgrade = invoicePaid(
      plan.paid,
      [
        invoiceLine(
          planPrice("team"),
          1,
          8000,
          { start: prorationDate, end: plan.period.end },
          true,
        ),
      ],
      8000,
      invoiceId,
    );

    await Promise.all([deliverStripe(paidUpgrade), deliverStripe(paidUpgrade)]);

    const [status, read, grants] = await Promise.all([
      readStatus(plan.owner),
      readManagement(plan.owner),
      memberCreditGrants(plan.owner, plan.memberId),
    ]);
    expect(status).toMatchObject({ tier: "team" });
    expect(read.allocations).toStrictEqual([
      expect.objectContaining({
        memberId: plan.memberId,
        usagePackUsd: 20,
        pendingChange: null,
      }),
    ]);
    const periodEndIso = new Date(plan.period.end * 1000).toISOString();
    expect(grants).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          grantType: "purchased",
          amount: 20_000,
          remaining: 20_000,
          expiresAt: periodEndIso,
        }),
        expect.objectContaining({
          grantType: "bonus",
          amount: 400,
          remaining: 400,
          expiresAt: periodEndIso,
        }),
      ]),
    );
    expect(grants).toHaveLength(2);
  });

  it("billing-usage-pack-subscriptions-024 (3/3) preserves Team tier, pack allocation and grants on repeated paid invoice delivery", async () => {
    const { plan, preview, invoiceId } = await pendingTeamUpgrade();
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      planSubscription({
        event: plan.paid,
        tier: "team",
        packs: [{ price: PRICE_20, quantity: 1 }],
        start: plan.period.start,
        end: plan.period.end,
      }),
    );
    const prorationDate = Math.floor(Date.parse(preview.prorationDate) / 1000);
    const paidUpgrade = invoicePaid(
      plan.paid,
      [
        invoiceLine(
          planPrice("team"),
          1,
          8000,
          { start: prorationDate, end: plan.period.end },
          true,
        ),
      ],
      8000,
      invoiceId,
    );

    await deliverStripe(paidUpgrade);
    await deliverStripe(paidUpgrade);

    const [status, read, grants] = await Promise.all([
      readStatus(plan.owner),
      readManagement(plan.owner),
      memberCreditGrants(plan.owner, plan.memberId),
    ]);
    expect(status).toMatchObject({ tier: "team" });
    expect(read.allocations).toStrictEqual([
      expect.objectContaining({
        memberId: plan.memberId,
        usagePackUsd: 20,
        pendingChange: null,
      }),
    ]);
    const periodEndIso = new Date(plan.period.end * 1000).toISOString();
    expect(grants).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          grantType: "purchased",
          amount: 20_000,
          remaining: 20_000,
          expiresAt: periodEndIso,
        }),
        expect.objectContaining({
          grantType: "bonus",
          amount: 400,
          remaining: 400,
          expiresAt: periodEndIso,
        }),
      ]),
    );
    expect(grants).toHaveLength(2);
  });

  it("billing-usage-pack-subscriptions-027 clears the scheduled package change when the admin restores the Plan", async () => {
    const plan = await teamPlanWithHundredPack("member");
    stripePrices(0, 4000, planPrice("pro"));
    const downgrade = await accept(
      plan.management().previewSubscriptionChange({
        headers,
        body: {
          targetTier: "pro",
          memberUsagePacks: [
            { memberId: plan.owner.userId, usagePackUsd: 0 },
            { memberId: plan.memberId, usagePackUsd: 20 },
          ],
        },
      }),
      [200],
    );
    const scheduleId = `sub_sched_${randomUUID()}`;
    context.mocks.stripe.subscriptionSchedules.create.mockResolvedValue({
      id: scheduleId,
    });
    context.mocks.stripe.subscriptionSchedules.update.mockResolvedValue({
      id: scheduleId,
    });
    const scheduled = await accept(
      plan.management().confirmSubscriptionChange({
        headers,
        body: { changeId: downgrade.body.changeId },
      }),
      [200],
    );
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      ...plan.subscription,
      schedule: scheduleId,
    });
    expect(scheduled.body).toMatchObject({ status: "scheduled" });
    await expect(readStatus(plan.owner)).resolves.toMatchObject({
      scheduledChange: { targetTier: "pro" },
    });
    context.mocks.stripe.subscriptionSchedules.release.mockImplementation(
      () => {
        context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
          plan.subscription,
        );
        return Promise.resolve({ id: scheduleId });
      },
    );

    signIn(plan.owner);
    const restored = await accept(
      setupApp({ context, routes: billingRestoreRoutes })(
        billingRestoreContract,
      ).create({ headers, body: {} }),
      [200],
    );
    stripePrices(18_000, 40_000, PRICE_200);

    expect(restored.body).toStrictEqual({ status: "restored" });
    expect(
      context.mocks.stripe.subscriptionSchedules.release,
    ).toHaveBeenCalledWith(scheduleId);
    await expect(readStatus(plan.owner)).resolves.toMatchObject({
      scheduledChange: null,
      cancelAtPeriodEnd: false,
    });
    const read = await readManagement(plan.owner);
    expect(read.allocations).toStrictEqual([
      expect.objectContaining({
        memberId: plan.memberId,
        usagePackUsd: 100,
        pendingChange: null,
      }),
    ]);
    await accept(
      plan.management().previewSubscriptionChange({
        headers,
        body: {
          targetTier: "team",
          memberUsagePacks: [
            { memberId: plan.owner.userId, usagePackUsd: 0 },
            { memberId: plan.memberId, usagePackUsd: 200 },
          ],
        },
      }),
      [200],
    );
  });

  it("billing-usage-pack-subscriptions-038 adds concurrency to the Plan schedule without replacing the scheduled pack downgrade", async () => {
    const plan = await scheduledHundredPackDowngrade();
    const subscriptionId = plan.subscription.id;
    const invoiceId = `in_${randomUUID()}`;
    context.mocks.stripe.invoices.createPreview.mockImplementation(
      (input: unknown) => {
        const prorationDate =
          previewParamsSchema.parse(input).subscription_details?.proration_date;
        const amount = prorationDate === undefined ? 30_000 : 15_000;
        return Promise.resolve({
          id: `upcoming_${randomUUID()}`,
          currency: "usd",
          amount_due: amount,
          lines: {
            has_more: false,
            data: [
              {
                id: `il_${randomUUID()}`,
                amount,
                taxes: [],
                pricing: { price_details: { price: CONCURRENCY_PRICE } },
                period: {
                  start: prorationDate ?? plan.period.end,
                  end: plan.period.end + 30 * 86_400,
                },
                parent: {
                  type: "subscription_item_details",
                  subscription_item_details: {
                    proration: prorationDate !== undefined,
                  },
                },
              },
            ],
          },
        });
      },
    );
    const scheduleUpdates =
      context.mocks.stripe.subscriptionSchedules.update.mock.calls.length;
    const updateSchedule =
      context.mocks.stripe.subscriptionSchedules.update.getMockImplementation();
    if (!updateSchedule) {
      throw new Error("Expected the Stripe schedule fake from the Given");
    }
    context.mocks.stripe.subscriptionSchedules.update.mockImplementation(
      (...args: unknown[]) => {
        // Stripe invoices the prorated concurrency as a new draft invoice.
        context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
          ...plan.scheduled,
          latest_invoice: { id: invoiceId, status: "draft", paid: false },
        });
        return updateSchedule(...args);
      },
    );
    context.mocks.stripe.invoices.finalizeInvoice.mockResolvedValue({
      id: invoiceId,
      status: "open",
      paid: false,
    });
    context.mocks.stripe.invoices.pay.mockResolvedValue({
      id: invoiceId,
      status: "paid",
      paid: true,
    });
    signIn(plan.owner);
    const concurrency = setupApp({
      context,
      routes: billingConcurrencyCheckoutRoutes,
    })(billingConcurrencyCheckoutContract);
    const origin = new URL(env("APP_URL")).origin;

    const preview = await accept(
      concurrency.preview({ headers, body: { quantity: 3 } }),
      [200],
    );
    const bought = await accept(
      concurrency.create({
        headers,
        body: {
          quantity: 3,
          successUrl: `${origin}/billing?concurrency=success`,
          cancelUrl: `${origin}/billing`,
        },
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
    expect(bought.body).toStrictEqual({
      url: `${origin}/billing?concurrency=success`,
    });
    expect(context.mocks.stripe.invoices.createPreview).toHaveBeenCalledWith(
      expect.objectContaining({ schedule: plan.scheduleId }),
    );
    const concurrencyScheduleUpdates =
      context.mocks.stripe.subscriptionSchedules.update.mock.calls.slice(
        scheduleUpdates,
      );
    expect(concurrencyScheduleUpdates).toStrictEqual([
      [
        plan.scheduleId,
        expect.objectContaining({
          proration_behavior: "always_invoice",
          phases: [
            expect.objectContaining({
              items: expect.arrayContaining([
                expect.objectContaining({ price: PRICE_100, quantity: 1 }),
                expect.objectContaining({
                  price: CONCURRENCY_PRICE,
                  quantity: 3,
                }),
              ]),
            }),
            expect.objectContaining({
              items: expect.arrayContaining([
                expect.objectContaining({ price: PRICE_20, quantity: 1 }),
                expect.objectContaining({
                  price: CONCURRENCY_PRICE,
                  quantity: 3,
                }),
              ]),
            }),
          ],
        }),
        {
          idempotencyKey: expect.stringMatching(
            /^concurrency-change:sub_[\w-]+:[\w-]+:schedule-update$/,
          ),
        },
      ],
    ]);
    expect(concurrencyScheduleUpdates[0]?.[2]).toStrictEqual({
      idempotencyKey: expect.stringContaining(
        `concurrency-change:${subscriptionId}:`,
      ),
    });
    expect(
      context.mocks.stripe.subscriptionSchedules.release,
    ).not.toHaveBeenCalled();
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(context.mocks.stripe.invoices.finalizeInvoice).toHaveBeenCalledWith(
      invoiceId,
      {},
      {
        idempotencyKey: `concurrency-change:${subscriptionId}:${invoiceId}:finalize`,
      },
    );
    expect(context.mocks.stripe.invoices.pay).toHaveBeenCalledWith(
      invoiceId,
      {},
      {
        idempotencyKey: `concurrency-change:${subscriptionId}:${invoiceId}:pay`,
      },
    );

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      planSubscription({
        event: plan.paid,
        tier: "team",
        packs: [{ price: PRICE_100, quantity: 1 }],
        concurrency: 3,
        start: plan.period.start,
        end: plan.period.end,
        schedule: plan.scheduleId,
      }),
    );
    await deliverStripe(
      invoicePaid(
        plan.paid,
        [invoiceLine(CONCURRENCY_PRICE, 3, 15_000, plan.period, true)],
        15_000,
        invoiceId,
      ),
    );
    const status = await readStatus(plan.owner);
    expect(status.concurrencySubscriptions).toStrictEqual([
      expect.objectContaining({ id: subscriptionId, quantity: 3 }),
    ]);
  });
});

describe("member removal", () => {
  it("billing-usage-pack-subscriptions-039 refunds the removed member's only pack and ends the Plan at period end", async () => {
    const plan = await proPlanWithMemberPack("2035-04-05T00:00:00.000Z");
    mockNow(Date.parse("2035-04-20T00:00:00.000Z"));
    const email = "removed-member@example.test";
    clerkMembers(plan.owner, {
      userId: plan.memberId,
      orgId: plan.owner.orgId,
    });
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [{ id: plan.memberId }],
      totalCount: 1,
    });
    context.mocks.clerk.organizations.deleteOrganizationMembership.mockResolvedValue(
      {},
    );
    const canceling = { ...plan.subscription, cancel_at_period_end: true };
    context.mocks.stripe.subscriptions.update.mockImplementation(() => {
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(canceling);
      return Promise.resolve(canceling);
    });
    const paymentIntentId = `pi_${randomUUID()}`;
    const refundId = `re_${randomUUID()}`;
    context.mocks.stripe.creditNotes.preview.mockResolvedValue({
      pre_payment_amount: 0,
      post_payment_amount: 2000,
    });
    context.mocks.stripe.invoices.retrieve.mockResolvedValue({
      ...plan.paid.data.object,
      payments: {
        data: [
          {
            status: "paid",
            amount_paid: 2000,
            payment: {
              type: "payment_intent",
              payment_intent: paymentIntentId,
            },
          },
        ],
      },
    });
    context.mocks.stripe.refunds.create.mockResolvedValue({
      id: refundId,
      status: "succeeded",
      amount: 2000,
      payment_intent: paymentIntentId,
    });
    context.mocks.stripe.creditNotes.create.mockResolvedValue({
      id: `cn_${randomUUID()}`,
      status: "issued",
      post_payment_amount: 2000,
      refunds: [{ refund: refundId, amount_refunded: 2000 }],
    });
    signIn(plan.owner);

    await accept(
      setupApp({ context, routes: orgMembersRoutes })(
        orgMembersContract,
      ).removeMember({ headers, body: { email } }),
      [200],
    );
    await flushWaitUntilForTest();

    expect(context.mocks.stripe.subscriptions.update.mock.calls).toStrictEqual([
      [plan.subscription.id, { cancel_at_period_end: true }],
    ]);
    expect(
      context.mocks.stripe.subscriptionSchedules.create,
    ).not.toHaveBeenCalled();
    const remaining = await memberCreditGrants(plan.owner, plan.memberId);
    expect(remaining ?? []).toStrictEqual([]);
    expect(context.mocks.stripe.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_intent: paymentIntentId,
        amount: 2000,
      }),
      {
        idempotencyKey: expect.stringMatching(
          /^usage-pack-credit-refund:.+:1:refund$/u,
        ),
      },
    );
    expect(context.mocks.stripe.creditNotes.create).toHaveBeenCalledWith(
      expect.objectContaining({
        refunds: [expect.objectContaining({ refund: refundId })],
        lines: [expect.objectContaining({ amount: 2000 })],
      }),
      {
        idempotencyKey: expect.stringMatching(
          /^usage-pack-credit-refund:.+:1:credit-note$/u,
        ),
      },
    );
    await expect(readStatus(plan.owner)).resolves.toMatchObject({
      cancelAtPeriodEnd: true,
    });
  });
});

describe("member additions", () => {
  it("billing-usage-pack-subscriptions-025 adds a paid pack for a newly joined member through a pending update", async () => {
    const plan = await proPlanWithMemberPack(
      "2035-01-01T00:00:00.000Z",
      "pro",
      "admin",
    );
    const joined = { userId: plan.memberId, orgId: plan.owner.orgId };
    clerkMembers(plan.owner, joined);
    mockNow(Date.parse("2035-01-16T00:00:00.000Z"));
    stripePrices(2500, 7000, PRICE_50);

    const before = await readManagement(plan.owner);
    expect(before.supportsMemberAdditions).toBeTruthy();
    const preview = await accept(
      plan.management().previewSubscriptionChange({
        headers,
        body: {
          targetTier: "pro",
          memberUsagePacks: [
            { memberId: plan.owner.userId, usagePackUsd: 20 },
            { memberId: plan.memberId, usagePackUsd: 50 },
          ],
        },
      }),
      [200],
    );
    expect(preview.body).toMatchObject({
      immediateAmountCents: 2500,
      nextRecurringAmountCents: 7000,
      immediateCreditGrant: {
        purchasedCredits: 25_000,
        bonusCredits: 1300,
        totalCredits: 26_300,
        expiresAt: new Date(plan.period.end * 1000).toISOString(),
      },
    });
    const invoiceId = `in_${randomUUID()}`;
    context.mocks.stripe.subscriptions.update.mockResolvedValue({
      ...plan.subscription,
      pending_update: {
        expires_at: plan.period.end - 86_400,
        subscription_items: [{ price: { id: PRICE_50 }, quantity: 1 }],
      },
      latest_invoice: {
        id: invoiceId,
        status: "open",
        hosted_invoice_url: `https://invoice.stripe.test/${invoiceId}`,
      },
    });

    const confirmed = await accept(
      plan.management().confirmSubscriptionChange({
        headers,
        body: { changeId: preview.body.changeId },
      }),
      [200],
    );

    expect(confirmed.body).toMatchObject({ status: "pending_payment" });
    const prorationDate = Math.floor(
      Date.parse(preview.body.prorationDate) / 1000,
    );
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledWith(
      plan.subscription.id,
      expect.objectContaining({
        items: expect.arrayContaining([{ price: PRICE_50, quantity: 1 }]),
        payment_behavior: "pending_if_incomplete",
        proration_behavior: "always_invoice",
        proration_date: prorationDate,
      }),
      {
        idempotencyKey: `usage-pack-subscription-change:${preview.body.changeId}:apply`,
      },
    );

    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(
      planSubscription({
        event: plan.paid,
        tier: "pro",
        packs: [
          { price: PRICE_20, quantity: 1 },
          { price: PRICE_50, quantity: 1 },
        ],
        start: plan.period.start,
        end: plan.period.end,
      }),
    );
    await deliverStripe(
      invoicePaid(
        plan.paid,
        [
          invoiceLine(
            PRICE_50,
            1,
            2500,
            { start: prorationDate, end: plan.period.end },
            true,
          ),
        ],
        2500,
        invoiceId,
      ),
    );

    const after = await readManagement(plan.owner);
    expect(
      after.allocations
        .map((allocation) => {
          return [allocation.memberId, allocation.usagePackUsd];
        })
        .sort(),
    ).toStrictEqual(
      [
        [plan.owner.userId, 20],
        [plan.memberId, 50],
      ].sort(),
    );
    const grants = await memberCreditGrants(plan.owner, plan.memberId);
    expect(
      grants?.map((grant) => {
        return [grant.grantType, grant.amount];
      }),
    ).toStrictEqual(
      expect.arrayContaining([
        ["purchased", 25_000],
        ["bonus", 1300],
      ]),
    );
  });
});

const invoiceMetadataSchema = object({
  metadata: record(string(), string()).optional(),
});

/** Stripe creates, finalizes and pays the invitation invoice on the saved card. */
function stripeInvitationInvoice(customer: string) {
  const invoiceId = `in_${randomUUID()}`;
  // Stripe echoes the metadata the API wrote when it created the invoice.
  const metadata: Record<string, string> = {};
  const invoice = (status: string) => {
    return { id: invoiceId, status, currency: "usd", customer, metadata };
  };
  context.mocks.stripe.invoices.create.mockImplementation((input: unknown) => {
    Object.assign(metadata, invoiceMetadataSchema.parse(input).metadata);
    return Promise.resolve(invoice("draft"));
  });
  context.mocks.stripe.invoiceItems.create.mockResolvedValue({
    id: `ii_${randomUUID()}`,
  });
  context.mocks.stripe.invoices.finalizeInvoice.mockResolvedValue(
    invoice("open"),
  );
  context.mocks.stripe.invoices.pay.mockResolvedValue(invoice("paid"));
  const paymentIntentId = `pi_${randomUUID()}`;
  context.mocks.stripe.invoices.retrieve.mockResolvedValue({
    ...invoice("paid"),
    amount_due: 1000,
    amount_paid: 1000,
    payments: {
      data: [
        {
          status: "paid",
          amount_paid: 1000,
          payment: { type: "payment_intent", payment_intent: paymentIntentId },
        },
      ],
    },
  });
  return { invoiceId, paymentIntentId };
}

function paymentSucceeded(
  paymentIntentId: string,
  customer: string,
  purchaseId: string,
) {
  return {
    id: `evt_${randomUUID()}`,
    type: "payment_intent.succeeded",
    created: Math.floor(now() / 1000),
    data: {
      object: {
        id: paymentIntentId,
        object: "payment_intent",
        status: "succeeded",
        amount_received: 1000,
        currency: "usd",
        customer,
        metadata: {
          purpose: "usage_pack_invitation_purchase",
          usagePackInvitationPurchaseId: purchaseId,
        },
      },
    },
  };
}

async function deliverClerk(type: string, data: Record<string, unknown>) {
  context.mocks.clerk.verifyWebhook.mockResolvedValue({ type, data });
  await accept(
    clerkWebhookClient.post({
      body: JSON.stringify({ type, data }),
      extraHeaders: {
        "svix-id": `msg_${randomUUID()}`,
        "svix-timestamp": String(Math.floor(now() / 1000)),
        "svix-signature": "v1,signed-by-clerk",
      },
    }),
    [200],
  );
}

async function creditsView(owner: Admin) {
  signIn(owner);
  const read = await accept(creditsClient.get({ headers }), [200]);
  return read.body;
}

describe("paid invitation purchases", () => {
  it("billing-usage-pack-subscriptions-052 grants a paid invitation pack once on acceptance and adds it to Stripe once", async () => {
    const { owner, paid, period, subscription } = await midPeriodProWorkspace(
      [packPreviewLine(1000, true)],
      "team",
    );
    const email = "accepted-invite@example.test";
    const invitationId = `orginv_${randomUUID()}`;
    const preview = await previewInvitation(owner, email);
    context.mocks.clerk.organizations.createOrganizationInvitation.mockResolvedValue(
      { id: invitationId, emailAddress: email, status: "pending" },
    );
    const before = await creditsView(owner);
    const payment = paymentSucceeded(
      `pi_${randomUUID()}`,
      subscription.customer,
      preview.purchaseId,
    );

    await Promise.all([deliverStripe(payment), deliverStripe(payment)]);
    await flushWaitUntilForTest();

    await expect(creditsView(owner)).resolves.toStrictEqual(before);
    expect(
      context.mocks.clerk.organizations.createOrganizationInvitation,
    ).toHaveBeenCalledTimes(1);
    expect(context.mocks.stripe.subscriptions.update).not.toHaveBeenCalled();

    const invitedUserId = `user_${randomUUID()}`;
    clerkMembers(owner, { userId: invitedUserId, orgId: owner.orgId });
    context.mocks.stripe.subscriptions.update.mockImplementation(() => {
      const added = planSubscription({
        event: paid,
        tier: "team",
        packs: [{ price: PRICE_20, quantity: 2 }],
        start: period.start,
        end: period.end,
      });
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue(added);
      return Promise.resolve(added);
    });
    const accepted = {
      id: invitationId,
      object: "organization_invitation",
      organization_id: owner.orgId,
      user_id: invitedUserId,
      email_address: email,
      status: "accepted",
      updated_at: now(),
      private_metadata: { usagePackInvitationPurchaseId: preview.purchaseId },
    };
    await Promise.all([
      deliverClerk("organizationInvitation.accepted", accepted),
      deliverClerk("organizationInvitation.accepted", accepted),
    ]);
    await flushWaitUntilForTest();

    const after = await creditsView(owner);
    expect(
      after.memberCredits?.filter((entry) => {
        return entry.memberId === invitedUserId;
      }),
    ).toStrictEqual([
      expect.objectContaining({
        purchasedCredits: preview.purchasedCredits,
        bonusCredits: preview.bonusCredits,
        totalCredits: preview.totalCredits,
      }),
    ]);
    expect(after).toMatchObject({
      hasUsagePack: true,
      purchasedCredits: 20_000,
      bonusCredits: 400,
      totalCredits: 20_400,
    });
    await deliverClerk("organizationInvitation.accepted", accepted);
    await flushWaitUntilForTest();

    await expect(creditsView(owner)).resolves.toStrictEqual(after);
    expect(context.mocks.stripe.subscriptions.update).toHaveBeenCalledTimes(1);
  });

  it("billing-usage-pack-subscriptions-057 refunds a revoked paid invitation once and checks the pending refund only after the reconciliation window", async () => {
    const { owner, subscription } = await midPeriodProWorkspace([
      packPreviewLine(1000, true),
    ]);
    const email = "revoked-invite@example.test";
    const invitationId = `orginv_${randomUUID()}`;
    const preview = await previewInvitation(owner, email);
    context.mocks.clerk.organizations.createOrganizationInvitation.mockResolvedValue(
      { id: invitationId, emailAddress: email, status: "pending" },
    );
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      {
        data: [{ id: invitationId, emailAddress: email, status: "pending" }],
        totalCount: 1,
      },
    );
    const paymentIntentId = `pi_${randomUUID()}`;
    await deliverStripe({
      id: `evt_${randomUUID()}`,
      type: "payment_intent.succeeded",
      created: Math.floor(now() / 1000),
      data: {
        object: {
          id: paymentIntentId,
          object: "payment_intent",
          status: "succeeded",
          amount_received: 1000,
          currency: "usd",
          customer: subscription.customer,
          metadata: {
            purpose: "usage_pack_invitation_purchase",
            usagePackInvitationPurchaseId: preview.purchaseId,
          },
        },
      },
    });
    await flushWaitUntilForTest();
    const managementBefore = await readManagement(owner);
    const grantsBefore = await ownCreditGrants(owner);
    const refundId = `re_${randomUUID()}`;
    context.mocks.stripe.refunds.create.mockResolvedValue({
      id: refundId,
      status: "pending",
      amount: 1000,
      payment_intent: paymentIntentId,
    });
    const revoke = async () => {
      signIn(owner);
      const revoked = await accept(
        invite().revoke({ headers, body: { invitationId } }),
        [200],
      );
      return revoked.body.message;
    };

    const first = await revoke();
    mockNow(Date.parse("2035-05-15T00:05:01.000Z"));
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      { data: [], totalCount: 0 },
    );
    context.mocks.stripe.refunds.retrieve.mockResolvedValue({
      id: refundId,
      status: "succeeded",
      amount: 1000,
      payment_intent: paymentIntentId,
    });
    const second = await revoke();
    await revoke();

    expect([first, second]).toStrictEqual([
      "Invitation revoked and refund initiated",
      "Invitation revoked and refund initiated",
    ]);
    await expect(ownCreditGrants(owner)).resolves.toStrictEqual(grantsBefore);
    await expect(readManagement(owner)).resolves.toStrictEqual(
      managementBefore,
    );
    expect(context.mocks.stripe.refunds.create).toHaveBeenCalledTimes(1);
    expect(context.mocks.stripe.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_intent: paymentIntentId,
        amount: 1000,
      }),
      {
        idempotencyKey: `usage-pack-invitation:${preview.purchaseId}:refund:1`,
      },
    );
    expect(context.mocks.stripe.refunds.retrieve).toHaveBeenCalledTimes(1);
  });

  it("billing-usage-pack-subscriptions-051 charges the saved card for a previewed invitation and sends it with the purchase ID", async () => {
    const { owner, period, subscription } = await midPeriodProWorkspace([
      packPreviewLine(1000, true),
    ]);
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      ...subscription,
      default_payment_method: "pm_saved_card",
    });
    stripeInvitationInvoice(subscription.customer);
    context.mocks.clerk.organizations.createOrganizationInvitation.mockResolvedValue(
      { id: `orginv_${randomUUID()}` },
    );
    signIn(owner);

    const preview = await accept(
      invite().previewPurchase({
        headers,
        body: {
          email: "paid-invite@example.test",
          role: "member",
          usagePackUsd: 20,
          supportsInAppPreview: true,
          returnUrl: `${env("APP_URL")}/members`,
        },
      }),
      [200],
    );
    expect(preview.body).toStrictEqual({
      purchaseId: expect.any(String),
      usagePackUsd: 20,
      immediateAmountCents: 1000,
      currency: "usd",
      purchasedCredits: 10_000,
      bonusCredits: 200,
      totalCredits: 10_200,
      currentPeriodEnd: new Date(period.end * 1000).toISOString(),
      expiresAt: expect.any(String),
      paymentMethodPreviewToken: expect.stringMatching(/.+/u),
    });
    expect(context.mocks.stripe.invoices.create).not.toHaveBeenCalled();
    expect(
      context.mocks.clerk.organizations.createOrganizationInvitation,
    ).not.toHaveBeenCalled();

    signIn(owner);
    const confirmed = await accept(
      invite().confirmPurchase({
        headers,
        params: { purchaseId: preview.body.purchaseId },
        body: {
          paymentMethodPreviewToken: preview.body.paymentMethodPreviewToken,
        },
      }),
      [200],
    );

    expect(confirmed.body).toStrictEqual({
      message: "Invitation purchased and sent",
    });
    expect(context.mocks.stripe.invoices.create).toHaveBeenCalledTimes(1);
    expect(context.mocks.stripe.invoices.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: subscription.customer,
        default_payment_method: "pm_saved_card",
        metadata: expect.objectContaining({
          purpose: "usage_pack_invitation_purchase",
          usagePackInvitationPurchaseId: preview.body.purchaseId,
        }),
      }),
      expect.anything(),
    );
    expect(
      context.mocks.clerk.organizations.createOrganizationInvitation,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: owner.orgId,
        emailAddress: "paid-invite@example.test",
        role: "org:member",
        privateMetadata: expect.objectContaining({
          usagePackInvitationPurchaseId: preview.body.purchaseId,
        }),
      }),
    );
  });
});
