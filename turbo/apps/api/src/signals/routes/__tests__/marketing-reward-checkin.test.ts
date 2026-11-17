import { getStartedContract } from "@okouai/api-contracts/contracts/get-started";
import { marketingRewardSettlementContract } from "@okouai/api-contracts/contracts/marketing-reward-settlement";
import { billingUsagePackCreditsContract } from "@okouai/api-contracts/contracts/billing";
import { randomUUID } from "node:crypto";
import { http, HttpResponse } from "msw";
import { expect, test } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { billingUsagePackCreditsRoutes } from "../billing-usage-pack-credits";
import { getStartedRoutes } from "../get-started";
import { marketingRewardSettlementRoutes } from "../marketing-reward-settlement";
import { createRouteMocks } from "./helpers/route-test";
import {
  campaignRequest,
  marketingRewardConsumer,
} from "./helpers/marketing-reward-consumer";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

test("records only authenticated explicit check-ins and retains the first day snapshot across concurrent clicks and organization switches", async () => {
  await setupApp({ context, routes: getStartedRoutes, isolatePg: true });
  const client = setupApp({ context, routes: getStartedRoutes })(
    getStartedContract,
  );
  const consumer = marketingRewardConsumer(context);
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  mocks.clerk.session(userId, orgId);
  mockNow(new Date("2026-11-16T23:59:59.123Z"));
  expect(
    (await accept(client.status({ headers }), [200])).body.claimedToday,
  ).toBeFalsy();
  expect((await client.checkin({ headers: {} })).status).toBe(401);
  await consumer.deliver();
  expect(consumer.received).toStrictEqual([]);

  const responses = await Promise.all(
    Array.from({ length: 5 }, () => {
      return accept(client.checkin({ headers }), [200]);
    }),
  );
  const first = responses[0];
  if (!first) {
    throw new Error("Expected a confirmed check-in");
  }
  expect(
    responses.every((response) => {
      return response.body.id === first.body.id;
    }),
  ).toBeTruthy();
  await consumer.deliver();
  expect(consumer.received).toStrictEqual([
    {
      version: 5,
      id: expect.any(String),
      environment: "development",
      type: "checkin.requested",
      occurredAt: "2026-11-16T23:59:59.123Z",
      orgId,
      userId,
    },
  ]);

  mocks.clerk.session(userId, `org_${randomUUID()}`);
  mockNow(new Date("2026-11-16T23:59:59.999Z"));
  expect((await accept(client.checkin({ headers }), [200])).body).toStrictEqual(
    first.body,
  );
  await consumer.deliver();
  expect(consumer.received).toHaveLength(1);
});

test("recovers the original check-in day and financial receipt after a lost source acknowledgement, UTC rollover and expiry", async () => {
  await setupApp({ context, routes: getStartedRoutes, isolatePg: true });
  const client = setupApp({ context, routes: getStartedRoutes })(
    getStartedContract,
  );
  const consumer = marketingRewardConsumer(context);
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  mocks.clerk.session(userId, orgId);
  mockNow(new Date("2026-11-16T23:59:59.123Z"));
  const first = (await accept(client.checkin({ headers }), [200])).body;
  server.use(
    http.post(
      "https://marketing-consumer.example.test/api/internal/marketing/get-started/events",
      () => {
        return HttpResponse.json(
          { error: "Receipt unavailable" },
          { status: 503 },
        );
      },
      { once: true },
    ),
  );
  await consumer.deliver();
  mockNow(new Date("2026-11-17T00:00:00.000Z"));
  mocks.clerk.session(userId, `org_${randomUUID()}`);
  const second = (await accept(client.checkin({ headers }), [200])).body;
  expect(second.id).not.toBe(first.id);
  await consumer.deliver();
  expect(consumer.received).toHaveLength(2);
  const fact = consumer.received.find((event) => {
    return event.occurredAt === "2026-11-16T23:59:59.123Z";
  });
  if (!fact || fact.type !== "checkin.requested") {
    throw new Error("Expected original check-in proof");
  }
  expect(fact.orgId).toBe(orgId);
  const intent = campaignRequest({
    version: 1,
    environment: fact.environment,
    policy: "get-started-v1",
    sourceEventId: fact.id,
    questKey: "checkin",
    sourceKey: "2026-11-16",
    rewardKey: `checkin:${userId}:2026-11-16`,
    orgId: fact.orgId,
    actorUserId: fact.userId,
    beneficiaryUserId: fact.userId,
    rewardTarget: "user",
    rewardAmount: 100,
    completedAt: fact.occurredAt,
  });
  const secret = "checkin-financial-service-1234567890123456789012345";
  mockEnv("MARKETING_REWARDS_SETTLEMENT_SECRET", secret);
  const financial = setupApp({
    context,
    routes: marketingRewardSettlementRoutes,
  })(marketingRewardSettlementContract);
  const financialHeaders = { authorization: `Bearer ${secret}` };
  const original = (
    await accept(
      financial.lookup({ body: intent, headers: financialHeaders }),
      [200],
    )
  ).body;
  expect(original.receipt).toMatchObject({
    id: first.id,
    orgId,
    sourceKey: "2026-11-16",
    grantedAt: first.grantedAt,
    expiresAt: first.expiresAt,
  });
  expect(
    (
      await financial.settle({
        body: campaignRequest({
          ...intent,
          sourceKey: "2026-11-17",
          rewardKey: `checkin:${userId}:2026-11-17`,
        }),
        headers: financialHeaders,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await financial.settle({
        body: campaignRequest({ ...intent, sourceEventId: randomUUID() }),
        headers: financialHeaders,
      })
    ).status,
  ).toBe(404);
  mockNow(new Date("2026-11-24T00:00:00.000Z"));
  const recovered = await Promise.all(
    Array.from({ length: 4 }, () => {
      return accept(
        financial.settle({ body: intent, headers: financialHeaders }),
        [200],
      );
    }),
  );
  expect(
    recovered.every((response) => {
      return JSON.stringify(response.body) === JSON.stringify(original);
    }),
  ).toBeTruthy();
  mocks.clerk.session(userId, orgId);
  const credits = (
    await accept(
      setupApp({ context, routes: billingUsagePackCreditsRoutes })(
        billingUsagePackCreditsContract,
      ).get({ headers }),
      [200],
    )
  ).body;
  expect(credits.bonusCredits).toBe(0);
});
