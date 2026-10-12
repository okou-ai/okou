import { randomBytes, randomUUID } from "node:crypto";

import { runnerWssTicketsContract } from "@okouai/api-contracts/contracts/runner-wss-tickets";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { runnerWssTicketRoutes } from "../runner-wss-tickets";
import { createRouteMocks } from "./helpers/route-test";

describe("WSS ticket authorization-store outage", () => {
  const officialHeaders = {
    authorization:
      "Bearer vm0_official_abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  };
  const context = testContext();
  const mocks = createRouteMocks(context);

  it("fails closed on bootstrap and consume without database authority", async () => {
    // Isolated test module: its first DB access is deliberately unavailable.
    mockEnv("DATABASE_URL", "postgresql://postgres@127.0.0.1:1/unavailable");
    mockEnv("DB_POOL_CONNECT_TIMEOUT_MS", 200);
    const runId = randomUUID();
    const runnerId = randomUUID();
    mocks.clerk.session("user_wss_outage", "org_wss_outage");
    const client = setupApp({
      context,
      routes: runnerWssTicketRoutes,
      rethrowErrors: true,
    })(runnerWssTicketsContract);

    await expect(
      client.bootstrap({
        params: { runId },
        headers: { authorization: "Bearer clerk-session" },
        body: undefined,
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
    await expect(
      client.consume({
        headers: officialHeaders,
        body: {
          runId,
          runnerId,
          origin: "wss://runner.example.com:443",
          ticket: randomBytes(32).toString("base64url"),
        },
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });
});
