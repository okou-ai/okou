import { randomUUID } from "node:crypto";

import {
  billingStatusContract,
  billingUsagePackCreditsContract,
} from "@okouai/api-contracts/contracts/billing";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { billingStatusRoutes } from "../billing-status";
import { billingUsagePackCreditsRoutes } from "../billing-usage-pack-credits";
import { mockNow } from "../../../lib/time";
import { deliverOrganizationCreated } from "./helpers/api-bdd-webhooks";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function clients() {
  const app = setupApp({
    context,
    routes: [...billingStatusRoutes, ...billingUsagePackCreditsRoutes],
  });
  return {
    billing: app(billingStatusContract),
    usagePack: app(billingUsagePackCreditsContract),
  };
}

async function expectSingleOnboardingGrant(
  api: ReturnType<typeof clients>,
): Promise<void> {
  const billing = await accept(api.billing.get({ headers }), [200]);
  expect(billing.body.credits).toBe(0);
  expect(billing.body.creditGrants).toStrictEqual([]);
  const usagePack = await accept(api.usagePack.get({ headers }), [200]);
  expect(usagePack.body).toMatchObject({
    totalCredits: 1000,
    purchasedCredits: 0,
    bonusCredits: 1000,
    hasUsagePack: false,
  });
  expect(usagePack.body.creditGrants).toStrictEqual([
    expect.objectContaining({
      grantType: "bonus",
      amount: 1000,
      remaining: 1000,
    }),
  ]);
}

describe("workspace creation credit grants", () => {
  it("keeps the onboarding bonus personal to the workspace creator", async () => {
    const creator = createBddApi(context).user();
    if (!creator.orgId) {
      throw new Error("Expected a workspace creator");
    }
    mocks.clerk.session(creator.userId, creator.orgId, "org:admin");
    const api = clients();
    await deliverOrganizationCreated(context, creator);
    await expectSingleOnboardingGrant(api);
    const creatorCredits = await accept(api.usagePack.get({ headers }), [200]);
    expect(creatorCredits.body.memberCredits).toStrictEqual([
      expect.objectContaining({
        memberId: creator.userId,
        totalCredits: 1000,
        bonusCredits: 1000,
      }),
    ]);

    mocks.clerk.session(`user_${randomUUID()}`, creator.orgId, "org:member");
    const memberCredits = await accept(api.usagePack.get({ headers }), [200]);
    expect(memberCredits.body).toMatchObject({
      totalCredits: 0,
      purchasedCredits: 0,
      bonusCredits: 0,
      creditGrants: [],
    });
    expect(memberCredits.body.memberCredits).toBeUndefined();
    mocks.clerk.session(creator.userId, creator.orgId, "org:admin");
    const unchanged = await accept(api.usagePack.get({ headers }), [200]);
    expect(unchanged.body).toStrictEqual(creatorCredits.body);
  });

  it("expires the personal onboarding grant after 30 days without restarting on replay", async () => {
    const grantedAt = new Date("2027-01-01T12:34:56.789Z");
    const expiresAt = new Date("2027-01-31T12:34:56.789Z");
    mockNow(grantedAt);
    const creator = createBddApi(context).user();
    mocks.clerk.session(creator.userId, creator.orgId, "org:admin");
    const api = clients();
    await deliverOrganizationCreated(context, creator);
    await expectSingleOnboardingGrant(api);
    const granted = await accept(api.usagePack.get({ headers }), [200]);
    expect(granted.body.creditGrants).toStrictEqual([
      expect.objectContaining({
        grantType: "bonus",
        amount: 1000,
        remaining: 1000,
        expiresAt: expiresAt.toISOString(),
      }),
    ]);

    mockNow(expiresAt.getTime() - 1);
    await deliverOrganizationCreated(context, creator);
    const beforeExpiry = await accept(api.usagePack.get({ headers }), [200]);
    expect(beforeExpiry.body).toStrictEqual(granted.body);
    mockNow(expiresAt);
    await deliverOrganizationCreated(context, creator);
    const expired = await accept(api.usagePack.get({ headers }), [200]);
    expect(expired.body).toMatchObject({
      totalCredits: 0,
      bonusCredits: 0,
      creditGrants: [],
    });
    const billing = await accept(api.billing.get({ headers }), [200]);
    expect(billing.body.credits).toBe(0);
    expect(billing.body.creditGrants).toStrictEqual([]);
  });

  it("issues one personal bonus across repeated organization creation events", async () => {
    const creator = createBddApi(context).user();
    if (!creator.orgId) {
      throw new Error("Expected a workspace creator");
    }
    mocks.clerk.session(creator.userId, creator.orgId, "org:admin");
    await deliverOrganizationCreated(context, creator);
    const api = clients();
    await expectSingleOnboardingGrant(api);
    const initial = await accept(api.usagePack.get({ headers }), [200]);

    await deliverOrganizationCreated(context, creator);
    await expectSingleOnboardingGrant(api);
    const replayed = await accept(api.usagePack.get({ headers }), [200]);
    expect(replayed.body).toStrictEqual(initial.body);
  });

  it.each(["pro", "team"] as const)(
    "preserves a %s purchase racing bootstrap",
    async (tier) => {
      const actor = createBddApi(context).user();
      if (!actor.orgId) {
        throw new Error("Expected a paid workspace");
      }
      mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
      const api = clients();
      await Promise.all([
        deliverOrganizationCreated(context, actor),
        createRunsApi(context).grantProEntitlement(actor, { tier }),
      ]);
      const billing = await accept(api.billing.get({ headers }), [200]);
      expect(billing.body.tier).toBe(tier);
    },
  );
  it.each(["pro", "team"] as const)(
    "does not grant limited-free credits to an already %s workspace",
    async (tier) => {
      const actor = createBddApi(context).user();
      if (!actor.orgId) {
        throw new Error("Expected a paid workspace");
      }
      await createRunsApi(context).grantProEntitlement(actor, { tier });
      mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
      const api = clients();
      await deliverOrganizationCreated(context, actor);
      const billing = await accept(api.billing.get({ headers }), [200]);
      expect(billing.body.tier).toBe(tier);
      const credits = await accept(api.usagePack.get({ headers }), [200]);
      expect(credits.body.totalCredits).toBe(0);
      expect(credits.body.creditGrants).toStrictEqual([]);
    },
  );
});
