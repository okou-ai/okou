import { randomUUID } from "node:crypto";
import { usageRecordContract } from "@okouai/api-contracts/contracts/usage-record";
import { expect, test } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { usageRecordRoutes } from "../usage-record";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const app = setupApp({ context, routes: usageRecordRoutes });
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

test("usage-record-003 returns an empty null period for a free user's billing period", async () => {
  createRouteMocks(context).clerk.session(
    `user_${randomUUID()}`,
    `org_${randomUUID()}`,
  );

  const response = await accept(
    app(usageRecordContract).get({
      headers,
      query: { range: "billingPeriod", tz: "UTC" },
    }),
    [200],
  );

  expect(response.body).toStrictEqual({
    period: null,
    rows: [],
    totalCredits: 0,
    pagination: { page: 1, pageSize: 20, total: 0 },
  });
});

test("usage-record-002 refuses team usage records for an organization admin", async () => {
  createRouteMocks(context).clerk.session(
    `user_${randomUUID()}`,
    `org_${randomUUID()}`,
    "org:admin",
  );

  const response = await accept(
    app(usageRecordContract).get({
      headers,
      query: { scope: "team", range: "7d", tz: "UTC" },
    }),
    [403],
  );

  expect(response.body.error).toStrictEqual({
    code: "FORBIDDEN",
    message: "Team usage records are aggregated by member",
  });
});
