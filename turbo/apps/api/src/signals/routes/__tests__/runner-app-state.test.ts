import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { runnerAppStateContract } from "@okouai/api-contracts/contracts/computer-use";
import { mockEnv } from "../../../lib/env";
import { setupApp } from "../../../__tests__/test-helpers";
import { testContext } from "../../../__tests__/test-context";
import { runnerAppStateRoutes } from "../runner-app-state";

const context = testContext();
test("requires official Runner authentication and a current direct command", async () => {
  mockEnv("OFFICIAL_RUNNER_SECRET", "c".repeat(64));
  const client = setupApp({ context, routes: runnerAppStateRoutes })(
    runnerAppStateContract,
  );
  const request = {
    params: { runId: randomUUID(), commandId: randomUUID() },
    body: { runnerId: randomUUID(), heartbeatGeneration: 1 },
  };
  const unauthenticated = await client.check({
    ...request,
    headers: { authorization: "Bearer unused" },
  });
  expect(unauthenticated.status).toBe(401);
  const noGrant = await client.check({
    ...request,
    headers: { authorization: `Bearer vm0_official_${"c".repeat(64)}` },
  });
  expect(noGrant.status).toBe(404);
});
