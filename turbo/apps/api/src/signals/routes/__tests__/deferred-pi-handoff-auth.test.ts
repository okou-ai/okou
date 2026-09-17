import { randomUUID } from "node:crypto";

import { runnersJobClaimContract } from "@okouai/api-contracts/contracts/runners";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { generateOkouToken, generateSandboxToken } from "../../auth/tokens";
import { resolveSandboxAuthForRun } from "../agent-webhook-auth";
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

    expect(resolveSandboxAuthForRun(runId, `Bearer ${ordinary}`)).toStrictEqual(
      {
        ok: false,
        reason: "invalid_token",
      },
    );
    await accept(readHandoff(runId, ordinary), [401]);
  });

  it("accepts the exact run-scoped Sandbox claim with its Pi lease fence", () => {
    const runId = randomUUID();
    const sandbox = generateSandboxToken("user-1", runId, "org-1", {
      ownerEpoch: 7,
      generation: 3,
    });

    expect(resolveSandboxAuthForRun(runId, `Bearer ${sandbox}`)).toStrictEqual({
      ok: true,
      auth: {
        userId: "user-1",
        runId,
        orgId: "org-1",
        piSandbox: { ownerEpoch: 7, generation: 3 },
      },
    });
  });

  it("rejects a valid Sandbox claim for another run", async () => {
    const runId = randomUUID();
    const sandbox = generateSandboxToken("user-1", randomUUID(), "org-1", {
      ownerEpoch: 7,
      generation: 3,
    });

    expect(resolveSandboxAuthForRun(runId, `Bearer ${sandbox}`)).toStrictEqual({
      ok: false,
      reason: "run_id_mismatch",
    });
    await accept(readHandoff(runId, sandbox), [401]);
  });
});
