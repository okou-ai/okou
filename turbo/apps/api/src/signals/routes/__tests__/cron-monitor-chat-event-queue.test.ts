import { cronMonitorChatEventQueueContract } from "@okouai/api-contracts/contracts/cron";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { cronMonitorChatEventQueueRoutes } from "../cron-monitor-chat-event-queue";

const context = testContext();

describe("cron monitor chat event queue", () => {
  it("requires the cron secret", async () => {
    mockEnv("CRON_SECRET", "test-cron-secret");
    const response = await accept(
      setupApp({ context, routes: cronMonitorChatEventQueueRoutes })(
        cronMonitorChatEventQueueContract,
      ).monitor({ headers: {} }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { code: "UNAUTHORIZED", message: "Invalid cron secret" },
    });
  });
});
