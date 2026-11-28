import { randomUUID } from "node:crypto";
import { billingUsagePackCreditsContract } from "@okouai/api-contracts/contracts/billing";
import { getStartedContract } from "@okouai/api-contracts/contracts/get-started";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow } from "../../../lib/time";
import { billingUsagePackCreditsRoutes } from "../billing-usage-pack-credits";
import { getStartedRoutes } from "../get-started";
import { marketingCheckinCampaign } from "./helpers/marketing-reward-consumer";
import { purchaseUsagePacks } from "./helpers/public-usage-pack-checkout";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function workspace() {
  mockEnv("ENV", "development");
  return {
    orgId: `org_${randomUUID()}`,
    adminId: `user_${randomUUID()}`,
    memberId: `user_${randomUUID()}`,
    otherId: `user_${randomUUID()}`,
  };
}

async function readCredits(
  userId: string,
  orgId: string,
  role: "org:admin" | "org:member",
) {
  createRouteMocks(context).clerk.session(userId, orgId, role);
  const response = await accept(
    setupApp({ context, routes: billingUsagePackCreditsRoutes })(
      billingUsagePackCreditsContract,
    ).get({ headers }),
    [200],
  );
  return response.body;
}

/** The member checks in through Get Started; the external campaign grants the bonus. */
async function checkIn(userId: string, orgId: string) {
  marketingCheckinCampaign(context);
  createRouteMocks(context).clerk.session(userId, orgId, "org:member");
  await accept(
    setupApp({ context, routes: getStartedRoutes })(getStartedContract).checkin(
      {
        headers,
      },
    ),
    [200],
  );
}

describe("GET /api/billing/usage-pack-credits", () => {
  it("billing-usage-pack-credits-003 returns a check-in bonus to a member without a usage pack", async () => {
    const ws = workspace();
    mockNow(new Date("2026-08-10T00:00:00Z"));
    await checkIn(ws.memberId, ws.orgId);

    const body = await readCredits(ws.memberId, ws.orgId, "org:member");

    expect(body).toMatchObject({
      totalCredits: 100,
      purchasedCredits: 0,
      bonusCredits: 100,
      hasUsagePack: false,
    });
    expect(body.creditGrants).toHaveLength(1);
    expect(body.creditGrants[0]).toMatchObject({
      grantType: "bonus",
      amount: 100,
      remaining: 100,
      expiresAt: "2026-08-17T00:00:00.000Z",
    });
  });

  it("billing-usage-pack-credits-004 returns only the member's own active purchased and bonus credits", async () => {
    const ws = workspace();
    mockNow(new Date("2026-08-02T00:00:00Z"));
    await checkIn(ws.memberId, ws.orgId);
    mockNow(new Date("2026-08-10T00:00:00Z"));
    await purchaseUsagePacks(context, { userId: ws.adminId, orgId: ws.orgId }, [
      { userId: ws.memberId, usd: 20 },
      { userId: ws.otherId, usd: 50 },
    ]);

    const body = await readCredits(ws.memberId, ws.orgId, "org:member");

    expect(body).toMatchObject({
      totalCredits: 20_400,
      purchasedCredits: 20_000,
      bonusCredits: 400,
      hasUsagePack: true,
    });
    // Both grants expire together, so the API does not define their order.
    const grants = body.creditGrants.map((grant) => {
      return [grant.grantType, grant.amount, grant.remaining, grant.expiresAt];
    });
    expect(grants).toHaveLength(2);
    expect(grants).toStrictEqual(
      expect.arrayContaining([
        ["purchased", 20_000, 20_000, "2026-09-09T00:00:00.000Z"],
        ["bonus", 400, 400, "2026-09-09T00:00:00.000Z"],
      ]),
    );
    expect(body.memberCredits).toBeUndefined();
  });

  it("billing-usage-pack-credits-005 shows an admin every member's active usage pack balance", async () => {
    const ws = workspace();
    mockNow(new Date("2026-08-10T00:00:00Z"));
    await purchaseUsagePacks(context, { userId: ws.adminId, orgId: ws.orgId }, [
      { userId: ws.adminId, usd: 20 },
      { userId: ws.otherId, usd: 50 },
    ]);

    const body = await readCredits(ws.adminId, ws.orgId, "org:admin");

    expect(body.hasUsagePack).toBeTruthy();
    const members = body.memberCredits ?? [];
    expect(members).toHaveLength(2);
    const admin = members.find((m) => {
      return m.memberId === ws.adminId;
    });
    const other = members.find((m) => {
      return m.memberId === ws.otherId;
    });
    expect(admin).toMatchObject({
      totalCredits: 20_400,
      purchasedCredits: 20_000,
      bonusCredits: 400,
    });
    expect(admin?.creditGrants).toHaveLength(2);
    expect(other).toMatchObject({
      totalCredits: 52_600,
      purchasedCredits: 50_000,
      bonusCredits: 2600,
    });
    expect(other?.creditGrants).toHaveLength(2);
  });
});
