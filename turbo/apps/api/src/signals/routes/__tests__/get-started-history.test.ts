import { getStartedHistoryContract } from "@okouai/api-contracts/contracts/get-started-history";
import { getStartedContract } from "@okouai/api-contracts/contracts/get-started";
import { randomUUID } from "node:crypto";
import { beforeEach, expect, test } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow } from "../../../lib/time";
import { getStartedRoutes } from "../get-started";
import { getStartedHistoryRoutes } from "../get-started-history";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const secret = "history-export-dedicated-test-key-123456789";
const routes = Object.freeze([...getStartedRoutes, ...getStartedHistoryRoutes]);

beforeEach(() => {
  mockEnv("MARKETING_REWARDS_EXPORT_SECRET", secret);
});

test("only the dedicated service credential can export history, and absent configuration fails closed", async () => {
  const client = setupApp({ context, routes })(getStartedHistoryContract);
  for (const authorization of [
    "Bearer clerk-session",
    "Bearer test-cron-secret",
    "Bearer wrong",
  ]) {
    expect(
      (await client.export({ headers: { authorization }, query: {} })).status,
    ).toBe(401);
  }
  mockEnv("MARKETING_REWARDS_EXPORT_SECRET", undefined);
  expect(
    (
      await client.export({
        headers: { authorization: `Bearer ${secret}` },
        query: {},
      })
    ).status,
  ).toBe(503);
});

test("pages original cross-org redemption identities and financial timestamps without changing rewards", async () => {
  const app = setupApp({ context, routes });
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  mocks.clerk.session(userId, orgId);
  mockNow(new Date("2026-09-15T23:59:59.123Z"));
  const first = await accept(
    app(getStartedContract).checkin({
      headers: { authorization: "Bearer clerk-session" },
    }),
    [200],
  );
  mockNow(new Date("2026-09-16T00:00:00.001Z"));
  const secondOrg = `org_${randomUUID()}`;
  mocks.clerk.session(userId, secondOrg);
  const second = await accept(
    app(getStartedContract).checkin({
      headers: { authorization: "Bearer clerk-session" },
    }),
    [200],
  );
  const history = app(getStartedHistoryContract);
  const headers = { authorization: `Bearer ${secret}` };
  const page = await accept(
    history.export({ headers, query: { limit: 100 } }),
    [200],
  );
  expect(page.body).toMatchObject({ version: 1, environment: "development" });
  const records = [...page.body.records];
  let cursor = page.body.nextCursor;
  for (let pageIndex = 0; cursor && pageIndex < 1000; pageIndex += 1) {
    const next = await accept(
      history.export({ headers, query: { limit: 100, after: cursor } }),
      [200],
    );
    if (next.body.nextCursor && next.body.nextCursor <= cursor) {
      throw new Error("History export cursor did not advance");
    }
    records.push(...next.body.records);
    cursor = next.body.nextCursor;
  }
  if (cursor) {
    throw new Error("History fixture scan exceeded its page budget");
  }
  expect(
    records
      .filter((row) => {
        return row.actorUserId === userId;
      })
      .map((row) => {
        return row.id;
      })
      .sort(),
  ).toStrictEqual([first.body.id, second.body.id].sort());
  expect(
    records.find((row) => {
      return row.id === first.body.id;
    }),
  ).toMatchObject({
    orgId,
    actorUserId: userId,
    beneficiaryUserId: userId,
    sourceKey: "2026-09-15",
    rewardKey: `checkin:${userId}:2026-09-15`,
    status: "granted",
    rewardAmount: 100,
    rewardTarget: "user",
    grantedAt: "2026-09-15T23:59:59.123Z",
    expiresAt: "2026-09-22T23:59:59.123Z",
    memberCreditGrantId: expect.any(String),
    orgCreditRecordId: null,
  });
  const unchanged = await accept(
    app(getStartedContract).checkin({
      headers: { authorization: "Bearer clerk-session" },
    }),
    [200],
  );
  expect(unchanged.body).toStrictEqual(second.body);
  const status = await accept(
    app(getStartedContract).status({
      headers: { authorization: "Bearer clerk-session" },
    }),
    [200],
  );
  expect(status.body).toMatchObject({ checkinStreak: 2, claimedToday: true });
  expect(
    status.body.quests.find((row) => {
      return row.key === "checkin";
    }),
  ).toMatchObject({ claimedCount: 2, earnedCredits: 200 });
});
