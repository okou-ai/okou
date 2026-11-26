import { randomUUID } from "node:crypto";
import { getStartedContract } from "@okouai/api-contracts/contracts/get-started";
import { expect, test } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { getStartedRoutes } from "../get-started";
import { marketingCheckinCampaign } from "./helpers/marketing-reward-consumer";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const getStarted = setupApp({ context, routes: getStartedRoutes })(
  getStartedContract,
);

test("marketing-reward-checkin-001 records one first-day check-in snapshot across concurrent clicks and workspace switches", async () => {
  mockEnv("ENV", "development");
  const consumer = marketingCheckinCampaign(context);
  const userId = `user_${randomUUID()}`;
  const firstOrgId = `org_${randomUUID()}`;
  const checkedInAt = new Date("2026-09-20T23:59:58.250Z");
  mockNow(checkedInAt);

  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: false,
  });
  const anonymous = await getStarted.checkin({ headers: {} });
  await flushWaitUntilForTest();
  expect(anonymous.status).toBe(401);
  expect(consumer.received).toStrictEqual([]);

  createRouteMocks(context).clerk.session(userId, firstOrgId, "org:member");
  const clicks = await Promise.all(
    Array.from({ length: 5 }, () => {
      return accept(getStarted.checkin({ headers }), [200]);
    }),
  );
  createRouteMocks(context).clerk.session(
    userId,
    `org_${randomUUID()}`,
    "org:member",
  );
  const switched = await accept(getStarted.checkin({ headers }), [200]);
  await flushWaitUntilForTest();

  const receipts = clicks.map((click) => {
    return click.body;
  });
  expect(
    new Set(
      receipts.map((receipt) => {
        return receipt.id;
      }),
    ).size,
  ).toBe(1);
  expect(switched.body).toStrictEqual(receipts[0]);
  expect(consumer.received).toStrictEqual([
    {
      version: 5,
      id: expect.any(String),
      environment: "development",
      type: "checkin.requested",
      occurredAt: checkedInAt.toISOString(),
      orgId: firstOrgId,
      userId,
    },
  ]);
});
