import { cronRetainChatEventsContract } from "@okouai/api-contracts/contracts/cron";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { cronRetainChatEventsRoutes } from "../cron-retain-chat-events";

const context = testContext();
const CRON_SECRET = "test-chat-event-retention-secret";

function cronClient() {
  return setupApp({ context, routes: cronRetainChatEventsRoutes })(
    cronRetainChatEventsContract,
  );
}

describe("chat event retention cron", () => {
  beforeEach(() => {
    mockEnv("CRON_SECRET", CRON_SECRET);
  });

  it("requires the cron secret", async () => {
    const response = await accept(cronClient().retain({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: { code: "UNAUTHORIZED", message: "Invalid cron secret" },
    });
  });
});
