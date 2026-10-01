import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";

const context = testContext();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runContextSnapshotForRun(runId: string): Record<string, unknown> {
  for (const [dataset, events] of context.mocks.axiom.ingest.mock.calls) {
    if (dataset !== "run-context" || !Array.isArray(events)) {
      continue;
    }
    const snapshot = events.find((event) => {
      return isRecord(event) && event.runId === runId;
    });
    if (isRecord(snapshot)) {
      return snapshot;
    }
  }
  throw new Error(`Expected a run-context snapshot for ${runId}`);
}

describe("runner environment ownership", () => {
  it("separates trusted platform environment from untrusted entries", async () => {
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const runnerGroup = runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor, { model: "claude-fable-5-1" });
    const agent = await bdd.createAgent(actor, {
      displayName: "Environment ownership agent",
      visibility: "private",
    });
    const run = await runs.createThreadRun(actor, {
      agentId: agent.agentId,
      prompt: "exercise environment ownership",
    });
    await runs.heartbeatRunner(runnerGroup);
    const claim = await runs.claimRunnerJob(run.runId);

    // Platform-owned values reach the Runner only as trusted platform
    // environment, never as Agent environment entries.
    expect(claim.platformEnvironment).toMatchObject({
      CLI_PKG_URL: expect.any(String),
      OKOU_TOKEN: expect.any(String),
      OKOU_AGENT_ID: agent.agentId,
    });
    for (const key of Object.keys(claim.platformEnvironment)) {
      expect(claim.environment).not.toHaveProperty(key);
    }

    // The run snapshot names its secret references but never holds the issued
    // token value.
    const snapshot = runContextSnapshotForRun(run.runId);
    expect(JSON.stringify(snapshot)).not.toContain(
      claim.platformEnvironment.OKOU_TOKEN,
    );

    await runs.requestCancelRun(actor, run.runId, [200]);
  });
});
