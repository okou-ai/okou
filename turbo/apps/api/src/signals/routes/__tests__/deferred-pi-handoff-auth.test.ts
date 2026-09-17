import { randomUUID } from "node:crypto";

import { runnersJobClaimContract } from "@okouai/api-contracts/contracts/runners";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { generateOkouToken, generateSandboxToken } from "../../auth/tokens";
import { runnersRoutes } from "../runners";

const context = testContext();

function readHandoff(runId: string, token: string) {
  return setupApp({ context, routes: runnersRoutes })(
    runnersJobClaimContract,
  ).handoff({
    params: { id: runId, offset: "0" },
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("deferred Pi handoff credential selection", () => {
  it("distinguishes an ordinary agent token from the Sandbox control scope", async () => {
    const runId = randomUUID();
    const ordinary = generateOkouToken("user-1", runId, "org-1");

    const response = await accept(readHandoff(runId, ordinary), [401]);
    expect(response.status).toBe(401);
  });

  it("accepts the exact run-scoped Sandbox claim at the HTTP auth boundary", async () => {
    const runId = randomUUID();
    const sandbox = generateSandboxToken("user-1", runId, "org-1", {
      ownerEpoch: 7,
      generation: 3,
    });

    // The run is intentionally absent. A 404 proves the Sandbox claim passed
    // route authentication; invalid credentials return 401 before lookup.
    const response = await accept(readHandoff(runId, sandbox), [404]);
    expect(response.status).toBe(404);
  });

  it("rejects a valid Sandbox claim for another run", async () => {
    const runId = randomUUID();
    const sandbox = generateSandboxToken("user-1", randomUUID(), "org-1", {
      ownerEpoch: 7,
      generation: 3,
    });

    const response = await accept(readHandoff(runId, sandbox), [401]);
    expect(response.status).toBe(401);
  });
});
