import { randomUUID } from "node:crypto";
import { beforeEach, expect, test } from "vitest";
import { friendReferralsContract } from "@okouai/api-contracts/contracts/friend-referrals";
import { billingUsagePackCreditsContract } from "@okouai/api-contracts/contracts/billing";
import { webhookStripeContract } from "@okouai/api-contracts/contracts/webhooks";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { friendReferralRoutes } from "../friend-referrals";
import { billingUsagePackCreditsRoutes } from "../billing-usage-pack-credits";
import { webhooksStripeRoutes } from "../webhooks-stripe";
import { createRouteMocks } from "./helpers/route-test";
import { purchaseUsagePacks } from "./helpers/public-usage-pack-checkout";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const STAFF_ORG_ID = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";
const VISIT_AT = "2026-01-31T10:00:00.000Z";
const REGISTERED_AT = "2026-01-31T10:00:01.000Z";
const client = () => {
  return setupApp({ context, routes: friendReferralRoutes })(
    friendReferralsContract,
  );
};

beforeEach(() => {
  mockNow(new Date(VISIT_AT));
});

async function referralLink(userId: string, orgId = STAFF_ORG_ID) {
  mocks.clerk.session(userId, orgId);
  return (await accept(client().link({ headers }), [200])).body;
}

async function visit(code: string) {
  return (await accept(client().visit({ body: { code } }), [200])).body.token;
}

async function register(
  userId: string,
  token: string,
  createdAt = new Date(REGISTERED_AT),
) {
  mockNow(new Date(REGISTERED_AT));
  mocks.clerk.session(userId, null);
  context.mocks.clerk.users.getUser.mockResolvedValue({
    id: userId,
    createdAt: createdAt.getTime(),
    banned: false,
  });
  return (await accept(client().register({ headers, body: { token } }), [200]))
    .body;
}

test("links are reusable and registration attribution is immutable, without rewarding existing accounts or self-referrals", async () => {
  const referrer = `user_${randomUUID()}`;
  const original = await referralLink(referrer);
  const links = await Promise.all(
    Array.from({ length: 4 }, () => {
      return referralLink(referrer);
    }),
  );
  expect(
    links.map((link) => {
      return link.code;
    }),
  ).toStrictEqual(Array(4).fill(original.code));
  const firstToken = await visit(original.code);
  const otherReferrer = `user_${randomUUID()}`;
  const other = await referralLink(otherReferrer);
  const otherToken = await visit(other.code);
  const invitee = `user_${randomUUID()}`;
  expect(await register(invitee, firstToken)).toStrictEqual({
    status: "registered",
  });
  expect(await register(invitee, otherToken)).toStrictEqual({
    status: "registered",
  });
  expect(await register(referrer, firstToken)).toStrictEqual({
    status: "ineligible",
  });
  expect(
    await register(
      `user_${randomUUID()}`,
      firstToken,
      new Date("2025-12-01T00:00:00Z"),
    ),
  ).toStrictEqual({ status: "ineligible" });
  expect(
    await register(
      `user_${randomUUID()}`,
      firstToken.replace(/\.[0-9]{13}\./u, ".1577836800000."),
    ),
  ).toStrictEqual({ status: "ineligible" });
  expect(await referralLink(referrer)).toMatchObject({
    registeredCount: 1,
    rewardedCount: 0,
    earnedCredits: 0,
  });
  expect(await referralLink(otherReferrer)).toMatchObject({
    registeredCount: 0,
    rewardedCount: 0,
  });
});

test.each(["pro", "team"] as const)(
  "a paid %s usage pack grants $20 once across concurrent deliveries and renewals, with calendar-month expiry",
  async (tier) => {
    const referrer = `user_${randomUUID()}`;
    const invitee = {
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
    };
    const link = await referralLink(referrer);
    await register(invitee.userId, await visit(link.code));
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [
        {
          id: `orgmem_${randomUUID()}`,
          role: "org:admin",
          createdAt: Date.parse(VISIT_AT),
          organization: {
            id: STAFF_ORG_ID,
            name: "Referral workspace",
            slug: null,
            imageUrl: "",
            hasImage: false,
            createdAt: Date.parse(VISIT_AT),
          },
        },
      ],
      totalCount: 1,
    });
    const event = await purchaseUsagePacks(
      context,
      invitee,
      [{ userId: invitee.userId, usd: 20 }],
      { deliveries: 3, tier },
    );
    expect(await referralLink(referrer)).toMatchObject({
      registeredCount: 1,
      rewardedCount: 1,
      earnedCredits: 20_000,
    });

    // A separate invoice on the same subscription is another real payment,
    // rather than another copy of the same Stripe event.
    const renewal = {
      ...event,
      id: `evt_${randomUUID()}`,
      data: { object: { ...event.data.object, id: `in_${randomUUID()}` } },
    };
    context.mocks.stripe.webhooks.constructEventAsync.mockReturnValueOnce(
      renewal,
    );
    await accept(
      setupApp({ context, routes: webhooksStripeRoutes })(
        webhookStripeContract,
      ).post({
        body: JSON.stringify(renewal),
        extraHeaders: { "stripe-signature": "t=1,v1=referral-renewal" },
      }),
      [200],
    );
    mocks.clerk.session(invitee.userId, invitee.orgId);
    const purchased = await accept(
      setupApp({ context, routes: billingUsagePackCreditsRoutes })(
        billingUsagePackCreditsContract,
      ).get({ headers }),
      [200],
    );
    expect(purchased.body.purchasedCredits).toBe(40_000);
    mocks.clerk.session(referrer, STAFF_ORG_ID);
    const balance = (
      await accept(
        setupApp({ context, routes: billingUsagePackCreditsRoutes })(
          billingUsagePackCreditsContract,
        ).get({ headers }),
        [200],
      )
    ).body;
    expect(balance.bonusCredits).toBe(20_000);
    expect(balance.creditGrants).toStrictEqual([
      expect.objectContaining({
        grantType: "bonus",
        amount: 20_000,
        remaining: 20_000,
        expiresAt: "2026-02-28T10:00:01.000Z",
      }),
    ]);
    expect(await referralLink(referrer)).toMatchObject({
      rewardedCount: 1,
      earnedCredits: 20_000,
    });
    mockNow(new Date("2026-02-28T10:00:01.001Z"));
    const expired = await accept(
      setupApp({ context, routes: billingUsagePackCreditsRoutes })(
        billingUsagePackCreditsContract,
      ).get({ headers }),
      [200],
    );
    expect(expired.body.bonusCredits).toBe(0);
  },
);

test("a zero-dollar usage-pack invoice does not reward its referrer", async () => {
  const referrer = `user_${randomUUID()}`;
  const invitee = {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
  };
  const link = await referralLink(referrer);
  await register(invitee.userId, await visit(link.code));
  await purchaseUsagePacks(
    context,
    invitee,
    [{ userId: invitee.userId, usd: 20 }],
    { amountPaid: 0 },
  );
  expect(await referralLink(referrer)).toMatchObject({
    registeredCount: 1,
    rewardedCount: 0,
    earnedCredits: 0,
  });
});

test("the referral rollout denies non-staff link creation", async () => {
  mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
  expect((await client().link({ headers })).status).toBe(403);
});
