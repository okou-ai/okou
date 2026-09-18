import { randomUUID } from "node:crypto";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

const context = testContext();

describe("runner X resource capability", () => {
  it.each([undefined, false, true])(
    "advertises observations regardless of the deduplication switch: %s",
    async (enabled) => {
      const bdd = createBddApi(context);
      const runs = createRunsApi(context);
      const actor = bdd.user();
      if (enabled !== undefined) {
        if (!actor.orgId) {
          throw new Error("X resource test requires an organization");
        }
        await updateFeatureSwitchesForUser(
          context,
          { ...actor, orgId: actor.orgId },
          {
            [FeatureSwitchKey.XResourceDeduplication]: enabled,
          },
        );
      }
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
      await runs.heartbeatRunner(runnerGroup);
      const claim = await runs.claimRunnerJob(run.runId);
      expect(claim.xResourceBilling).toStrictEqual({
        protocol: "x-resource-v1",
        startDate: "1970-01-01",
      });
      await runs.requestCancelRun(actor, run.runId, [200]);
    },
  );
});
