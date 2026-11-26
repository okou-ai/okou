import { randomUUID } from "node:crypto";
import { billingUsagePackCreditsContract } from "@okouai/api-contracts/contracts/billing";
import { friendReferralsContract } from "@okouai/api-contracts/contracts/friend-referrals";
import { webhookStripeContract } from "@okouai/api-contracts/contracts/webhooks";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";
import { array, object, unknown } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { billingUsagePackCreditsRoutes } from "../billing-usage-pack-credits";
import { friendReferralRoutes } from "../friend-referrals";
import { webhooksStripeRoutes } from "../webhooks-stripe";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { purchaseUsagePacks } from "./helpers/public-usage-pack-checkout";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

interface Person {
  readonly userId: string;
  readonly orgId: string;
}

function person(): Person {
  return { userId: `user_${randomUUID()}`, orgId: `org_${randomUUID()}` };
}

/** Clerk reports when each account was created. */
function clerkAccounts(createdAt: ReadonlyMap<string, number>) {
  context.mocks.clerk.users.getUser.mockImplementation((id: unknown) => {
    const userId = String(id);
    return Promise.resolve({
      id: userId,
      banned: false,
      createdAt: createdAt.get(userId),
    });
  });
}

function referrals() {
  return setupApp({ context, routes: friendReferralRoutes })(
    friendReferralsContract,
  );
}

async function readLink(actor: Person) {
  createRouteMocks(context).clerk.session(actor.userId, actor.orgId);
  const response = await accept(referrals().link({ headers }), [200]);
  return response.body;
}

async function visit(code: string) {
  const response = await accept(referrals().visit({ body: { code } }), [200]);
  return response.body.token;
}

async function register(actor: Person, token: string) {
  createRouteMocks(context).clerk.session(actor.userId, actor.orgId);
  const response = await accept(
    referrals().register({ headers, body: { token } }),
    [200],
  );
  return response.body;
}

async function readCredits(actor: Person) {
  createRouteMocks(context).clerk.session(actor.userId, actor.orgId);
  const response = await accept(
    setupApp({ context, routes: billingUsagePackCreditsRoutes })(
      billingUsagePackCreditsContract,
    ).get({ headers }),
    [200],
  );
  return response.body;
}

/** Both people are real Clerk members of their own workspaces. */
async function joinOwnWorkspaces(...actors: readonly Person[]) {
  const store = createStore();
  for (const actor of actors) {
    await store.set(
      seedOrgMembership$,
      { orgId: actor.orgId, userId: actor.userId, role: "admin" },
      context.signal,
    );
  }
}

const stripeSubscriptionSchema = object({
  items: object({ data: array(object({}).catchall(unknown())) }),
}).catchall(unknown());

/** Stripe advances the subscription to its next billing period. */
async function renewStripeSubscription(
  subscriptionId: string,
  period: { readonly start: number; readonly end: number },
  latestInvoice: unknown,
) {
  const current = stripeSubscriptionSchema.parse(
    await context.mocks.stripe.subscriptions.retrieve(subscriptionId),
  );
  context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
    ...current,
    latest_invoice: latestInvoice,
    items: {
      data: current.items.data.map((item) => {
        return {
          ...item,
          current_period_start: period.start,
          current_period_end: period.end,
        };
      }),
    },
  });
}

/** Stripe delivers the same verified event `times` times concurrently. */
async function deliverStripeEvent(event: { readonly id: string }, times = 1) {
  for (let index = 0; index < times; index++) {
    context.mocks.stripe.webhooks.constructEventAsync.mockReturnValueOnce(
      event,
    );
  }
  await Promise.all(
    Array.from({ length: times }, () => {
      return accept(
        setupApp({ context, routes: webhooksStripeRoutes })(
          webhookStripeContract,
        ).post({
          body: JSON.stringify(event),
          extraHeaders: { "stripe-signature": "t=1,v1=friend-referral" },
        }),
        [200],
      );
    }),
  );
}

/**
 * Given of friend-referrals-002: an invitee registered through the referrer's
 * link on 2026-01-31 and completed a Pro checkout with a $20 usage pack, with
 * no paid-invoice webhook delivered yet.
 */
async function referredPackPurchase() {
  const { referrer, invitee } = await referredInvitee(
    new Date("2026-01-31T09:59:59Z"),
  );
  await joinOwnWorkspaces(referrer, invitee);
  const paid = await purchaseUsagePacks(
    context,
    invitee,
    [{ userId: invitee.userId, usd: 20 }],
    { completeCheckout: true, deliveries: 0 },
  );
  return { referrer, invitee, paid };
}

/** Stripe renews the subscription and delivers the renewal invoice. */
async function deliverRenewal(
  paid: Awaited<ReturnType<typeof purchaseUsagePacks>>,
) {
  const invoice = paid.data.object;
  const start = invoice.lines.data[0]?.period.end ?? 0;
  const period = { start, end: start + 30 * 86_400 };
  const renewal = {
    ...invoice,
    id: `in_${randomUUID()}`,
    billing_reason: "subscription_cycle",
    lines: {
      has_more: false,
      data: invoice.lines.data.map((line) => {
        return { ...line, id: `il_${randomUUID()}`, period };
      }),
    },
  };
  await renewStripeSubscription(
    invoice.parent.subscription_details.subscription,
    period,
    renewal,
  );
  const renewalPaid = {
    ...paid,
    id: `evt_${randomUUID()}`,
    data: { object: renewal },
  };
  await deliverStripeEvent(renewalPaid);
}

/** A referrer shares a link; the invitee opens it and registers a new account. */
async function referredInvitee(at: Date) {
  const referrer = person();
  const invitee = person();
  mockNow(at);
  clerkAccounts(new Map([[invitee.userId, at.getTime() + 1000]]));
  const { code } = await readLink(referrer);
  const token = await visit(code);
  mockNow(new Date(at.getTime() + 2000));
  await expect(register(invitee, token)).resolves.toStrictEqual({
    status: "registered",
  });
  return { referrer, invitee };
}

describe("friend referrals", () => {
  it("friend-referrals-001 reuses links and attributes only the first eligible registration", async () => {
    const at = new Date("2026-01-31T10:00:00Z");
    mockNow(at);
    const first = person();
    const second = person();
    const invitee = person();
    const oldAccount = person();
    const lateInvitee = person();
    clerkAccounts(
      new Map([
        [invitee.userId, at.getTime() + 1000],
        [lateInvitee.userId, at.getTime() + 1000],
        [first.userId, at.getTime() + 1000],
        [oldAccount.userId, new Date("2025-12-15T00:00:00Z").getTime()],
      ]),
    );

    const firstLink = await readLink(first);
    const repeated = await Promise.all([
      readLink(first),
      readLink(first),
      readLink(first),
      readLink(first),
    ]);
    const secondLink = await readLink(second);
    expect(firstLink.code).toMatch(/^[a-z0-9]{6}$/u);
    expect(
      repeated.map((link) => {
        return link.code;
      }),
    ).toStrictEqual([
      firstLink.code,
      firstLink.code,
      firstLink.code,
      firstLink.code,
    ]);
    expect(secondLink.code).not.toBe(firstLink.code);
    const [firstToken, secondToken] = await Promise.all([
      visit(firstLink.code),
      visit(secondLink.code),
    ]);
    const [linkId, , mac] = firstToken.split(".");
    const backdated = `${linkId}.${new Date("2020-01-01T00:00:00Z").getTime()}.${mac}`;

    mockNow(new Date(at.getTime() + 2000));
    await expect(register(invitee, firstToken)).resolves.toStrictEqual({
      status: "registered",
    });
    await expect(register(invitee, secondToken)).resolves.toStrictEqual({
      status: "registered",
    });
    await expect(register(first, firstToken)).resolves.toStrictEqual({
      status: "ineligible",
    });
    await expect(register(oldAccount, firstToken)).resolves.toStrictEqual({
      status: "ineligible",
    });
    await expect(register(lateInvitee, backdated)).resolves.toStrictEqual({
      status: "ineligible",
    });

    await expect(readLink(first)).resolves.toMatchObject({
      code: firstLink.code,
      registeredCount: 1,
      rewardedCount: 0,
      earnedCredits: 0,
    });
    await expect(readLink(second)).resolves.toMatchObject({
      code: secondLink.code,
      registeredCount: 0,
      rewardedCount: 0,
    });
  });

  it("friend-referrals-004 a zero-dollar usage pack invoice does not reward the referrer", async () => {
    const { referrer, invitee } = await referredInvitee(
      new Date("2026-01-31T10:00:00Z"),
    );

    await purchaseUsagePacks(
      context,
      invitee,
      [{ userId: invitee.userId, usd: 20 }],
      { amountPaid: 0 },
    );

    await expect(readLink(referrer)).resolves.toMatchObject({
      registeredCount: 1,
      rewardedCount: 0,
      earnedCredits: 0,
    });
  });

  it("friend-referrals-002 (1/3) a paid usage pack rewards the referrer once across concurrent deliveries", async () => {
    const { referrer, invitee, paid } = await referredPackPurchase();

    await expect(readCredits(invitee)).resolves.toMatchObject({
      purchasedCredits: 20_000,
    });
    await expect(readLink(referrer)).resolves.toMatchObject({
      rewardedCount: 0,
      earnedCredits: 0,
    });

    await deliverStripeEvent(paid, 3);
    await expect(readLink(referrer)).resolves.toMatchObject({
      registeredCount: 1,
      rewardedCount: 1,
      earnedCredits: 20_000,
    });
  });

  it("friend-referrals-002 (2/3) a renewal credits the invitee but keeps one referrer bonus grant", async () => {
    const { referrer, invitee, paid } = await referredPackPurchase();
    await deliverStripeEvent(paid);

    await deliverRenewal(paid);

    await expect(readCredits(invitee)).resolves.toMatchObject({
      purchasedCredits: 40_000,
    });
    const referrerCredits = await readCredits(referrer);
    expect(referrerCredits).toMatchObject({ bonusCredits: 20_000 });
    expect(
      referrerCredits.creditGrants.map((grant) => {
        return {
          grantType: grant.grantType,
          amount: grant.amount,
          remaining: grant.remaining,
          expiresAt: grant.expiresAt,
        };
      }),
    ).toStrictEqual([
      {
        grantType: "bonus",
        amount: 20_000,
        remaining: 20_000,
        expiresAt: "2026-02-28T10:00:01.000Z",
      },
    ]);
    await expect(readLink(referrer)).resolves.toMatchObject({
      rewardedCount: 1,
      earnedCredits: 20_000,
    });
  });

  it("friend-referrals-002 (3/3) the referrer bonus expires at the calendar-month boundary", async () => {
    const { referrer, paid } = await referredPackPurchase();
    await deliverStripeEvent(paid);
    await deliverRenewal(paid);

    mockNow(new Date("2026-02-28T10:00:01.001Z"));

    await expect(readCredits(referrer)).resolves.toMatchObject({
      bonusCredits: 0,
    });
  });
});
