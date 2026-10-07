import { randomUUID } from "node:crypto";

import { usageRecordContract } from "@okouai/api-contracts/contracts/usage-record";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { clearMockNow } from "../../../lib/time";
import { usageRecordRoutes } from "../usage-record";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function apiClient() {
  return setupApp({ context, routes: usageRecordRoutes })(usageRecordContract);
}

describe("GET /api/usage/record", () => {
  afterEach(() => {
    clearMockNow();
  });

  it("returns 401 when not authenticated", async () => {
    const response = await accept(
      apiClient().get({ query: {}, headers: {} }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 400 for invalid timezone values", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const response = await accept(
      apiClient().get({
        query: { tz: "Not/A/Timezone" },
        headers: authHeaders(),
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Invalid timezone: Not/A/Timezone",
        code: "BAD_REQUEST",
      },
    });
  });

  it("returns 403 when team usage records are requested", async () => {
    mocks.clerk.session(
      `user_${randomUUID()}`,
      `org_${randomUUID()}`,
      "org:admin",
    );

    const response = await accept(
      apiClient().get({
        query: { scope: "team", range: "7d", tz: "UTC" },
        headers: authHeaders(),
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Team usage records are aggregated by member",
        code: "FORBIDDEN",
      },
    });
  });

  it("returns an empty null-period response for free billing period usage", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const response = await accept(
      apiClient().get({
        query: { range: "billingPeriod", tz: "UTC" },
        headers: authHeaders(),
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
});
