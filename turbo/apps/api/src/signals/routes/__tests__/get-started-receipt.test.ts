import { getStartedReceiptContract } from "@okouai/api-contracts/contracts/get-started-receipt";
import { getStartedContract } from "@okouai/api-contracts/contracts/get-started";
import { randomUUID } from "node:crypto";
import { beforeEach, expect, test } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow } from "../../../lib/time";
import { getStartedRoutes } from "../get-started";
import { getStartedReceiptRoutes } from "../get-started-receipt";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const secret = "reward-receipt-dedicated-service-test-key-123456789";
const exportSecret = "reward-history-export-only-test-key-123456789";
const routes = Object.freeze([...getStartedRoutes, ...getStartedReceiptRoutes]);

beforeEach(() => {
  mockEnv("MARKETING_REWARDS_RECEIPT_SECRET", secret);
  mockEnv("MARKETING_REWARDS_EXPORT_SECRET", exportSecret);
});

test("requires the receipt capability before revealing whether a claim exists", async () => {
  const client = setupApp({ context, routes })(getStartedReceiptContract);
  const params = { claimId: randomUUID() };
  for (const credential of [
    "clerk-session",
    "test-cron-secret",
    exportSecret,
  ]) {
    const response = await client.get({
      params,
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
  const missing = await client.get({
    params,
    headers: { authorization: `Bearer ${secret}` },
  });
  expect(missing.status).toBe(404);
  expect(missing.headers.get("cache-control")).toBe("no-store");
  mockEnv("MARKETING_REWARDS_RECEIPT_SECRET", undefined);
  const disabled = await client.get({
    params,
    headers: { authorization: `Bearer ${secret}` },
  });
  expect(disabled.status).toBe(503);
  expect(disabled.headers.get("cache-control")).toBe("no-store");
});

test("reads the original award across organizations and after expiry without renewing it", async () => {
  const app = setupApp({ context, routes });
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  mocks.clerk.session(userId, orgId);
  mockNow(new Date("2026-09-15T12:00:00.123Z"));
  const checkin = await accept(
    app(getStartedContract).checkin({
      headers: { authorization: "Bearer clerk-session" },
    }),
    [200],
  );
  const client = app(getStartedReceiptContract);
  const request = {
    params: { claimId: checkin.body.id },
    headers: { authorization: `Bearer ${secret}` },
  };
  const first = await accept(client.get(request), [200]);
  expect(first.headers.get("cache-control")).toBe("no-store");
  expect(first.body).toStrictEqual({
    version: 1,
    environment: "development",
    receipt: {
      id: checkin.body.id,
      orgId,
      actorUserId: userId,
      beneficiaryUserId: userId,
      questKey: "checkin",
      sourceKey: "2026-09-15",
      rewardKey: `checkin:${userId}:2026-09-15`,
      rewardSlot: null,
      rewardTarget: "user",
      rewardAmount: 100,
      status: "granted",
      memberCreditGrantId: expect.any(String),
      orgCreditRecordId: null,
      grantedAt: "2026-09-15T12:00:00.123Z",
      expiresAt: "2026-09-22T12:00:00.123Z",
      createdAt: expect.any(String),
      updatedAt: "2026-09-15T12:00:00.123Z",
    },
  });
  mocks.clerk.session(userId, `org_${randomUUID()}`);
  const sameDay = await accept(
    app(getStartedContract).checkin({
      headers: { authorization: "Bearer clerk-session" },
    }),
    [200],
  );
  expect(sameDay.body).toStrictEqual(checkin.body);
  mockNow(new Date("2026-09-23T12:00:00.123Z"));
  const expired = await accept(client.get(request), [200]);
  expect(expired.body).toStrictEqual(first.body);
});
