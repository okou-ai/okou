import { billingUsagePackCreditsContract } from "@okouai/api-contracts/contracts/billing";
import { billingUsagePackCreditsRoutes } from "../billing-usage-pack-credits";
import { randomUUID } from "node:crypto";
import { getStartedContract } from "@okouai/api-contracts/contracts/get-started";
import { marketingRewardSettlementContract } from "@okouai/api-contracts/contracts/marketing-reward-settlement";
import { http, HttpResponse } from "msw";
import { expect, test } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { marketingRewardCheckinEventSchema } from "../../../lib/marketing-reward-events";
import { mockNow } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { server } from "../../../mocks/server";
import { getStartedRoutes } from "../get-started";
import { marketingRewardSettlementRoutes } from "../marketing-reward-settlement";
import {
  campaignRequest,
  marketingRewardConsumer,
} from "./helpers/marketing-reward-consumer";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const settlementSecret = "financial-routing-test-1234567890123456789012345";
const campaignSecret = "campaign-routing-test-12345678901234567890123456";
const origin = "https://marketing-consumer.example.test";

function intentFor(
  source: ReturnType<typeof marketingRewardCheckinEventSchema.parse>,
) {
  const day = source.occurredAt.slice(0, 10);
  return campaignRequest({
    version: 1,
    environment: source.environment,
    policy: "get-started-v1",
    sourceEventId: source.id,
    questKey: "checkin",
    sourceKey: day,
    rewardKey: `checkin:${source.userId}:${day}`,
    orgId: source.orgId,
    actorUserId: source.userId,
    beneficiaryUserId: source.userId,
    rewardTarget: "user",
    rewardAmount: 100,
    completedAt: source.occurredAt,
  });
}

function financialClient() {
  mockEnv("MARKETING_REWARDS_SETTLEMENT_SECRET", settlementSecret);
  return setupApp({ context, routes: marketingRewardSettlementRoutes })(
    marketingRewardSettlementContract,
  );
}

test("forwards authenticated campaign status and recovers a check-in from the ledger after a lost Marketing response", async () => {
  const api = setupApp({ context, routes: getStartedRoutes })(
    getStartedContract,
  );
  mockNow(new Date("2026-11-17T08:00:00.000Z"));
  marketingRewardConsumer();
  const selected = {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
  };
  const status = {
    serverNow: "2026-11-17T08:00:00.000Z",
    nextResetAt: "2026-11-18T00:00:00.000Z",
    claimedToday: false,
    checkinStreak: 0,
    quests: [],
    recentGrants: [],
  };
  mocks.clerk.session(selected.userId, selected.orgId);
  expect((await api.status({ headers })).status).toBe(503);
  expect((await api.checkin({ headers })).status).toBe(503);
  mockEnv("MARKETING_REWARDS_CAMPAIGN_SECRET", campaignSecret);
  const financial = financialClient();
  server.use(
    http.post(
      `${origin}/api/internal/marketing/get-started/status`,
      async ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          `Bearer ${campaignSecret}`,
        );
        await expect(request.json()).resolves.toStrictEqual({
          ...selected,
          admin: true,
        });
        return HttpResponse.json({ ...status, claimedToday: false });
      },
    ),
    http.post(
      `${origin}/api/internal/marketing/get-started/check-in`,
      async ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          `Bearer ${campaignSecret}`,
        );
        const source = marketingRewardCheckinEventSchema.parse(
          await request.json(),
        );
        expect(source).toMatchObject(selected);
        await accept(
          financial.settle({
            body: intentFor(source),
            headers: { authorization: `Bearer ${settlementSecret}` },
          }),
          [200],
        );
        return HttpResponse.error();
      },
    ),
  );
  expect(
    (await accept(api.status({ headers }), [200])).body.claimedToday,
  ).toBeFalsy();
  const granted = await accept(api.checkin({ headers }), [200]);
  expect(granted.body).toMatchObject({
    status: "granted",
    rewardAmount: 100,
    grantedAt: "2026-11-17T08:00:00.000Z",
    expiresAt: "2026-11-24T08:00:00.000Z",
  });
  mocks.clerk.session(selected.userId, `org_${randomUUID()}`);
  mockNow(new Date("2026-11-17T08:01:00.000Z"));
  expect((await accept(api.checkin({ headers }), [200])).body).toStrictEqual(
    granted.body,
  );
});

test("a Marketing acknowledgement cannot fabricate money and a retained pending request can be funded later exactly once", async () => {
  const api = setupApp({ context, routes: getStartedRoutes })(
    getStartedContract,
  );
  const consumer = marketingRewardConsumer();
  const actor = {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
  };
  mocks.clerk.session(actor.userId, actor.orgId);
  mockNow(new Date("2026-11-17T09:00:00.000Z"));
  mockEnv("MARKETING_REWARDS_CAMPAIGN_SECRET", campaignSecret);
  server.use(
    http.post(`${origin}/api/internal/marketing/get-started/check-in`, () => {
      return HttpResponse.json({ status: "granted", rewardAmount: 100 });
    }),
  );
  const pending = await accept(api.checkin({ headers }), [202]);
  expect(pending.body.status).toBe("pending");
  expect(
    (
      await accept(
        setupApp({ context, routes: billingUsagePackCreditsRoutes })(
          billingUsagePackCreditsContract,
        ).get({ headers }),
        [200],
      )
    ).body.bonusCredits,
  ).toBe(0);
  await flushWaitUntilForTest();
  const source = consumer.received.find((event) => {
    return event.type === "checkin.requested";
  });
  if (!source || source.type !== "checkin.requested") {
    throw new Error("Expected retained authenticated check-in");
  }
  expect(source.id).toBe(pending.body.requestId);
  expect(source).toMatchObject(actor);
  const financial = financialClient();
  await accept(
    financial.settle({
      body: intentFor(source),
      headers: { authorization: `Bearer ${settlementSecret}` },
    }),
    [200],
  );
  const granted = await accept(api.checkin({ headers }), [200]);
  expect(granted.body.status).toBe("granted");
  expect((await accept(api.checkin({ headers }), [200])).body).toStrictEqual(
    granted.body,
  );
  expect(
    (
      await accept(
        setupApp({ context, routes: billingUsagePackCreditsRoutes })(
          billingUsagePackCreditsContract,
        ).get({ headers }),
        [200],
      )
    ).body.bonusCredits,
  ).toBe(100);
});
