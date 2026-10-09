import { randomUUID } from "node:crypto";

import { billingUsagePackCreditsContract } from "@okouai/api-contracts/contracts/billing";
import { getStartedContract } from "@okouai/api-contracts/contracts/get-started";
import { getStartedRoutes } from "../get-started";
import { purchaseUsagePacks } from "./helpers/public-usage-pack-checkout";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow } from "../../../lib/time";
import { billingUsagePackCreditsRoutes } from "../billing-usage-pack-credits";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);

interface UsagePackCreditsFixture {
  readonly orgId: string;
  readonly userId: string;
}

function fixture(): UsagePackCreditsFixture {
  return {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  };
}

function authenticate(
  actor: UsagePackCreditsFixture,
  role: "org:admin" | "org:member" = "org:member",
): void {
  mocks.clerk.session(actor.userId, actor.orgId, role);
}

function creditsClient() {
  return setupApp({ context, routes: billingUsagePackCreditsRoutes })(
    billingUsagePackCreditsContract,
  );
}

async function checkIn(actor: UsagePackCreditsFixture): Promise<void> {
  authenticate(actor);
  await accept(
    setupApp({ context, routes: getStartedRoutes })(getStartedContract).checkin(
      { headers: { authorization: "Bearer clerk-session" } },
    ),
    [200],
  );
}

describe("GET /api/billing/usage-pack-credits", () => {
  it("reports when the organization has no active usage pack", async () => {
    mockEnv("ENV", "development");
    const actor = fixture();
    authenticate(actor);

    const response = await accept(
      creditsClient().get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      totalCredits: 0,
      purchasedCredits: 0,
      bonusCredits: 0,
      creditGrants: [],
      hasUsagePack: false,
    });
  });

  it("reports no usage pack for a member without an active allocation", async () => {
    mockEnv("ENV", "development");
    const actor = fixture();
    await purchaseUsagePacks(context, actor, [
      { userId: `user_${randomUUID()}`, usd: 20 },
    ]);
    authenticate(actor);

    const response = await accept(
      creditsClient().get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      totalCredits: 0,
      purchasedCredits: 0,
      bonusCredits: 0,
      creditGrants: [],
      hasUsagePack: false,
    });
  });

  it("returns a check-in bonus without a usage pack allocation", async () => {
    mockEnv("ENV", "development");
    mockNow(new Date("2026-08-10T00:00:00.000Z"));
    const actor = fixture();

    await checkIn(actor);
    authenticate(actor);

    const response = await accept(
      creditsClient().get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      totalCredits: 100,
      purchasedCredits: 0,
      bonusCredits: 100,
      hasUsagePack: false,
      creditGrants: [
        expect.objectContaining({
          grantType: "bonus",
          amount: 100,
          remaining: 100,
          createdAt: expect.any(String),
          expiresAt: "2026-08-17T00:00:00.000Z",
        }),
      ],
    });
  });

  it("returns only the current member's active purchased and bonus credits", async () => {
    mockEnv("ENV", "development");
    mockNow(new Date("2026-08-10T00:00:00.000Z"));
    const actor = fixture();
    mockNow(new Date("2026-08-02T00:00:00.000Z"));
    await checkIn(actor);
    mockNow(new Date("2026-08-10T00:00:00.000Z"));
    await purchaseUsagePacks(context, actor, [
      { userId: actor.userId, usd: 20 },
      { userId: `user_${randomUUID()}`, usd: 50 },
    ]);
    authenticate(actor);

    const response = await accept(
      creditsClient().get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      totalCredits: 20_400,
      purchasedCredits: 20_000,
      bonusCredits: 400,
      hasUsagePack: true,
      creditGrants: expect.arrayContaining([
        expect.objectContaining({
          grantType: "purchased",
          amount: 20_000,
          remaining: 20_000,
          createdAt: expect.any(String),
          expiresAt: "2026-09-09T00:00:00.000Z",
        }),
        expect.objectContaining({
          grantType: "bonus",
          amount: 400,
          remaining: 400,
          createdAt: expect.any(String),
          expiresAt: "2026-09-09T00:00:00.000Z",
        }),
      ]),
    });
    expect(response.body.creditGrants).toHaveLength(2);
  });

  it("returns every member's active usage pack balance to an admin", async () => {
    mockEnv("ENV", "development");
    mockNow(new Date("2026-08-10T00:00:00.000Z"));
    const actor = fixture();
    const otherUserId = `user_${randomUUID()}`;
    await purchaseUsagePacks(context, actor, [
      { userId: actor.userId, usd: 20 },
      { userId: otherUserId, usd: 50 },
    ]);
    authenticate(actor, "org:admin");

    const response = await accept(
      creditsClient().get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.memberCredits).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memberId: actor.userId,
          totalCredits: 20_400,
          purchasedCredits: 20_000,
          bonusCredits: 400,
          creditGrants: expect.arrayContaining([
            expect.objectContaining({
              grantType: "purchased",
              remaining: 20_000,
            }),
            expect.objectContaining({ grantType: "bonus", remaining: 400 }),
          ]),
        }),
        expect.objectContaining({
          memberId: otherUserId,
          totalCredits: 52_600,
          purchasedCredits: 50_000,
          bonusCredits: 2600,
          creditGrants: expect.arrayContaining([
            expect.objectContaining({
              grantType: "purchased",
              remaining: 50_000,
            }),
            expect.objectContaining({
              grantType: "bonus",
              remaining: 2600,
            }),
          ]),
        }),
      ]),
    );
    expect(response.body.memberCredits).toHaveLength(2);
    expect(
      response.body.memberCredits?.map((member) => {
        return member.creditGrants.length;
      }),
    ).toStrictEqual([2, 2]);
    expect(response.body.hasUsagePack).toBeTruthy();
  });
});
