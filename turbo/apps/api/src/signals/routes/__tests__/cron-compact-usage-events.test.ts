import { cronCompactUsageEventsContract } from "@okouai/api-contracts/contracts/cron";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { cronCompactUsageEventsRoutes } from "../cron-compact-usage-events";

const context = testContext();
const CRON_SECRET = "test-compact-usage-events-secret";

function cronClient() {
  return setupApp({ context, routes: cronCompactUsageEventsRoutes })(
    cronCompactUsageEventsContract,
  );
}

describe("usage event compaction cron", () => {
  beforeEach(() => {
    mockEnv("CRON_SECRET", CRON_SECRET);
  });

  it("requires the cron secret", async () => {
    const response = await accept(cronClient().compact({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: { code: "UNAUTHORIZED", message: "Invalid cron secret" },
    });
  });

  it("rejects the wrong cron secret", async () => {
    const response = await accept(
      cronClient().compact({
        headers: { authorization: "Bearer wrong-cron-secret" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { code: "UNAUTHORIZED", message: "Invalid cron secret" },
    });
  });
});
