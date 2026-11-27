import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE } from "../../../__tests__/test-timeouts";
import { mockOptionalEnv } from "../../../lib/env";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { publicRunOwner } from "./helpers/public-run-owner";

describe("Runner dispatch permissions", () => {
  const context = testContext();

  it(
    "runners-unavailable-execution-001 delivers authorized connector permissions to its bound process",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const fixture = createChatEventsFixture(context);
      const bdd = createBddApi(context);
      const runs = createRunsApi(context);
      const actor = bdd.user();
      const owner = publicRunOwner(context, actor);

      fixture.chatCallbacks.acceptChatObjectStorage();
      fixture.api.acceptStorageDownloads();
      fixture.api.acceptTelemetryIngest();
      mockOptionalEnv("OPENROUTER_API_KEY", undefined);
      fixture.chatCallbacks.disableVapid();

      const runnerIdentity = {
        runnerId: randomUUID(),
        heartbeatGeneration: 7,
      };
      await fixture.api.configureRunnerGroup({ runnerIdentity });

      await owner.run(async () => {
        await bdd.bootstrapLimitedFreeOnboarding(actor);
        await fixture.api.ensurePersonalSubscriptionModel(actor);
        await fixture.connectors.requestManualGrant(
          actor,
          "figma",
          "api-token",
          { accessToken: "figd_bdd_manual_token" },
          { statuses: [200] },
        );
      });

      const run = await owner.run(() => {
        return fixture.sendChatRun(actor, {
          prompt: "Inspect Figma connector dispatch permissions",
          model: "claude-fable-5-1",
        });
      });
      const execution = await owner.executionInput(run.runId);
      const sandboxHeaders = {
        authorization: `Bearer ${execution.sandboxToken}`,
      };
      const dispatched = runs.dispatchedRun(run.runId);

      expect(execution.networkPolicies?.figma).toMatchObject({
        allow: ["file_content:read"],
        ask: [],
        deny: [],
        unknownPolicy: "allow",
      });

      const runnerLookup = await runs.requestRunRunner(actor, run.runId, [200]);
      expect(runnerLookup.status).toBe(200);
      if (runnerLookup.status !== 200) {
        throw new Error("Expected HTTP 200 Runner lookup");
      }
      expect(runnerLookup.body.runnerId).toBe(dispatched.runnerId);
      expect(runnerLookup.body.runnerHeartbeatGeneration).toBe(
        dispatched.heartbeatGeneration,
      );
      expect(runnerLookup.body.runnerId).toBe(runnerIdentity.runnerId);
      expect(runnerLookup.body.runnerHeartbeatGeneration).toBe(
        runnerIdentity.heartbeatGeneration,
      );

      await owner.run(() => {
        return fixture.completeChatRunOk(run.runId, sandboxHeaders, {
          cliAgentType: "claude-code",
        });
      });

      await expect(
        fixture.api.readRun(actor, run.runId),
      ).resolves.toMatchObject({
        status: "completed",
      });
    },
  );
});
