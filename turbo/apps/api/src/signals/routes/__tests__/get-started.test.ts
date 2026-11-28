import { randomUUID } from "node:crypto";
import { billingUsagePackCreditsContract } from "@okouai/api-contracts/contracts/billing";
import { getStartedContract } from "@okouai/api-contracts/contracts/get-started";
import { expect, test } from "vitest";
import { setupApp } from "../../../__tests__/test-helpers";
import { accept, testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { mockNow } from "../../../lib/time";
import { billingUsagePackCreditsRoutes } from "../billing-usage-pack-credits";
import { getStartedRoutes } from "../get-started";
import { marketingCheckinCampaign } from "./helpers/marketing-reward-consumer";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const app = setupApp({
  context,
  routes: [...getStartedRoutes, ...billingUsagePackCreditsRoutes],
});

function signIn(
  userId: string,
  orgId: string,
  role: "org:admin" | "org:member",
) {
  createRouteMocks(context).clerk.session(userId, orgId, role);
}

async function checkIn() {
  return (await accept(app(getStartedContract).checkin({ headers }), [200]))
    .body;
}

async function credits() {
  return (
    await accept(app(billingUsagePackCreditsContract).get({ headers }), [200])
  ).body;
}

test("get-started-003 shows a personal check-in bonus without a Usage Pack until it expires", async () => {
  mockEnv("ENV", "development");
  marketingCheckinCampaign(context);
  signIn(`user_${randomUUID()}`, `org_${randomUUID()}`, "org:member");
  mockNow(new Date("2026-09-15T06:30:00.500Z"));
  await checkIn();

  const fresh = await credits();
  expect(fresh).toMatchObject({
    hasUsagePack: false,
    purchasedCredits: 0,
    bonusCredits: 100,
    totalCredits: 100,
  });

  mockNow(new Date("2026-09-22T06:30:00.499Z"));
  const beforeExpiry = await credits();
  expect(beforeExpiry.bonusCredits).toBe(100);

  mockNow(new Date("2026-09-22T06:30:00.500Z"));
  const expired = await credits();
  expect(expired.bonusCredits).toBe(0);
  expect(expired.totalCredits).toBe(0);
  expect(expired.creditGrants).toStrictEqual([]);
});

test("get-started-001 grants one check-in award across concurrent requests and workspaces", async () => {
  mockEnv("ENV", "development");
  marketingCheckinCampaign(context);
  const userId = `user_${randomUUID()}`;
  signIn(userId, `org_${randomUUID()}`, "org:admin");
  mockNow(new Date("2026-09-15T23:59:59.123Z"));

  const awards = await Promise.all([
    checkIn(),
    checkIn(),
    checkIn(),
    checkIn(),
    checkIn(),
  ]);
  const award = awards[0];
  if (!award) {
    throw new Error("Expected a check-in award");
  }
  expect(award).toMatchObject({
    status: "granted",
    rewardAmount: 100,
    rewardTarget: "user",
    grantedAt: "2026-09-15T23:59:59.123Z",
    expiresAt: "2026-09-22T23:59:59.123Z",
  });
  for (const other of awards) {
    expect(other).toStrictEqual(award);
  }

  const balance = await credits();
  expect(balance.bonusCredits).toBe(100);
  expect(balance.creditGrants).toHaveLength(1);
  expect(balance.creditGrants[0]).toMatchObject({
    grantType: "bonus",
    amount: 100,
    remaining: 100,
    expiresAt: "2026-09-22T23:59:59.123Z",
  });

  signIn(userId, `org_${randomUUID()}`, "org:admin");
  await expect(checkIn()).resolves.toStrictEqual(award);

  mockNow(new Date("2026-09-16T00:00:00Z"));
  const nextDay = await checkIn();
  expect(nextDay.id).not.toBe(award.id);
});
