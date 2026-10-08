import { cronProjectChatEventSearchContract } from "@okouai/api-contracts/contracts/cron";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { cronProjectChatEventSearchRoutes } from "../cron-project-chat-event-search";

const context = testContext();
const CRON_SECRET = "durable-chat-search-projection-secret";

function cronClient() {
  mockEnv("CRON_SECRET", CRON_SECRET);
  return setupApp({
    context,
    routes: cronProjectChatEventSearchRoutes,
  })(cronProjectChatEventSearchContract);
}

describe("GET /api/cron/project-chat-event-search", () => {
  it("requires the cron secret", async () => {
    const response = await accept(cronClient().project({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: { code: "UNAUTHORIZED", message: "Invalid cron secret" },
    });
  });
});
