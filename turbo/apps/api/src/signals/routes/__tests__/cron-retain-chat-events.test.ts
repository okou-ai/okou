import { cronRetainChatEventsContract } from "@okouai/api-contracts/contracts/cron";
import { expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { cronRetainChatEventsRoutes } from "../cron-retain-chat-events";

const context = testContext();

test("requires the cron secret", async () => {
  mockEnv("CRON_SECRET", "test-chat-event-retention-secret");
  const response = await accept(
    setupApp({ context, routes: cronRetainChatEventsRoutes })(
      cronRetainChatEventsContract,
    ).retain({ headers: {} }),
    [401],
  );
  expect(response.body).toStrictEqual({
    error: { code: "UNAUTHORIZED", message: "Invalid cron secret" },
  });
});
