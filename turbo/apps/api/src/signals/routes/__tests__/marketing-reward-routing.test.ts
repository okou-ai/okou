import { randomUUID } from "node:crypto";
import { billingUsagePackCreditsContract } from "@okouai/api-contracts/contracts/billing";
import { getStartedContract } from "@okouai/api-contracts/contracts/get-started";
import { http, HttpResponse } from "msw";
import { expect, test } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import {
  marketingRewardCheckinEventSchema,
  type MarketingRewardSourceEvent,
} from "../../../lib/marketing-reward-events";
import { mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { billingUsagePackCreditsRoutes } from "../billing-usage-pack-credits";
import { getStartedRoutes } from "../get-started";
import {
  marketingRewardConsumer,
  settleMarketingRequest,
} from "./helpers/marketing-reward-consumer";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

test("marketing-reward-routing-002 a Marketing acknowledgement cannot fabricate money and a retained pending request can be funded later exactly once", async () => {
  mockEnv("ENV", "development");
  const consumer = marketingRewardConsumer();
  mockEnv(
    "MARKETING_REWARDS_CAMPAIGN_SECRET",
    "campaign-acknowledgement-1234567890123456789012",
  );
  const requests: MarketingRewardSourceEvent[] = [];
  server.use(
    http.post(
      "https://marketing-consumer.example.test/api/internal/marketing/get-started/check-in",
      async ({ request }) => {
        requests.push(
          marketingRewardCheckinEventSchema.parse(await request.json()),
        );
        // The campaign claims a grant that no authenticated settlement funded.
        return HttpResponse.json({
          id: randomUUID(),
          questKey: "checkin",
          status: "granted",
          rewardAmount: 100,
          rewardTarget: "user",
        });
      },
    ),
  );
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  const checkedInAt = new Date("2026-09-21T10:00:00.000Z");
  mockNow(checkedInAt);
  createRouteMocks(context).clerk.session(userId, orgId, "org:member");
  const getStarted = setupApp({ context, routes: getStartedRoutes })(
    getStartedContract,
  );
  const credits = setupApp({ context, routes: billingUsagePackCreditsRoutes })(
    billingUsagePackCreditsContract,
  );

  const pending = await accept(getStarted.checkin({ headers }), [202]);
  await flushWaitUntilForTest();
  const unfunded = await accept(credits.get({ headers }), [200]);

  expect(pending.body.status).toBe("pending");
  expect(requests).toHaveLength(1);
  const [source] = requests;
  if (source?.type !== "checkin.requested") {
    throw new Error("expected a retained check-in request");
  }
  expect(pending.body.requestId).toBe(source.id);
  expect(source).toMatchObject({ orgId, userId });
  expect(consumer.received).toStrictEqual([source]);
  expect(unfunded.body.bonusCredits).toBe(0);

  await settleMarketingRequest(context, {
    version: 1,
    environment: source.environment,
    policy: "get-started-v1",
    sourceEventId: source.id,
    questKey: "checkin",
    sourceKey: "2026-09-21",
    rewardKey: `checkin:${userId}:2026-09-21`,
    orgId,
    actorUserId: userId,
    beneficiaryUserId: userId,
    rewardTarget: "user",
    rewardAmount: 100,
    completedAt: source.occurredAt,
  });
  const funded = await accept(getStarted.checkin({ headers }), [200]);
  const replay = await accept(getStarted.checkin({ headers }), [200]);
  const settled = await accept(credits.get({ headers }), [200]);

  expect(funded.body).toMatchObject({ questKey: "checkin", status: "granted" });
  expect(replay.body).toStrictEqual(funded.body);
  expect(settled.body.bonusCredits).toBe(100);
});
