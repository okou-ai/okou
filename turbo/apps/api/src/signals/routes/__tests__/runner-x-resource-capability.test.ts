import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";

const context = testContext();

describe("runner X resource capability", () => {
  it.each([undefined, "2099-01-01"])(
    "resolves the current capability at claim time: %s",
    async (startDate) => {
      mockEnv(
        "X_RESOURCE_BILLING_START_DATE",
        startDate === undefined ? "2099-01-01" : undefined,
      );
      const bdd = createBddApi(context);
      const runs = createRunsApi(context);
      const actor = bdd.user();
      bdd.acceptAgentStorageWrites();
      runs.acceptStorageDownloads();
      runs.acceptTelemetryIngest();
      const runnerGroup = runs.configureRunnerGroup();
      await runs.grantProEntitlement(actor);
      await runs.ensureOrgModelProvider(actor);
      const agentName = `x-resource-capability-${randomUUID().slice(0, 8)}`;
      const agent = await runs.createDirectAgent(actor, {
        version: "1",
        agents: {
          [agentName]: {
            framework: "claude-code",
            environment: { ANTHROPIC_API_KEY: "bdd-inline-key" },
          },
        },
      });
      const run = await runs.createDirectRun(actor, {
        agentId: agent.agentId,
        prompt:
          "claim a previously queued run with the current resource capability",
        modelProviderType: "anthropic-api-key",
      });
      mockEnv("X_RESOURCE_BILLING_START_DATE", startDate);
      await runs.heartbeatRunner(runnerGroup);
      const claim = await runs.claimRunnerJob(run.runId);
      if (startDate === undefined) {
        expect(claim).not.toHaveProperty("xResourceBilling");
      } else {
        expect(claim.xResourceBilling).toStrictEqual({
          protocol: "x-resource-v1",
          startDate,
        });
      }
      await runs.requestCancelRun(actor, run.runId, [200]);
    },
  );
});
