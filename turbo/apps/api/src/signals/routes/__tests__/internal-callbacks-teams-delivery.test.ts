import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createPublicTeamsDispatchFixture } from "./helpers/public-teams-dispatch-fixture";

const context = testContext();

describe("Teams completion delivery", () => {
  it("does not retry a failed Teams delivery when completion is replayed", async () => {
    const fixtures = createPublicTeamsDispatchFixture(context);
    const runs = createRunsApi(context);
    const reads = createRunReadsApi(context);
    const webhooks = createWebhookCallbackApi(context);
    await fixtures.run(async () => {
      const teams = await fixtures.create({
        withDefaultAgent: true,
        paidNative: true,
      });
      await fixtures.dispatch(teams, "complete while Teams is unavailable");
      const listed = await reads.requestListLogs(
        teams.actor,
        { limit: 10 },
        [200],
      );
      const run = listed.body.data.find((row) => {
        return row.prompt === "complete while Teams is unavailable";
      });
      if (!run) {
        throw new Error("Expected the dispatched Teams Run");
      }
      await runs.heartbeatRunner("vm0/test");
      const claim = await runs.claimRunnerJob(run.id);
      let deliveryAttempts = 0;
      server.use(
        http.post(
          `${teams.installation.serviceUrl}v3/conversations/:conversationId/activities/:activityId`,
          () => {
            deliveryAttempts++;
            return new HttpResponse("Teams unavailable", { status: 500 });
          },
        ),
      );
      const complete = {
        runId: run.id,
        exitCode: 0,
        completion: {
          cliAgentType: "claude-code",
          cliAgentSessionId: `settlement-${run.id}`,
          cliAgentSessionHistoryDisposition: "native_only" as const,
        },
      };
      const sandboxHeaders = { authorization: `Bearer ${claim.sandboxToken}` };
      await webhooks.requestAgentComplete(complete, sandboxHeaders, [200]);
      await flushWaitUntilForTest();
      expect((await runs.readRun(teams.actor, run.id)).status).toBe(
        "completed",
      );
      expect(deliveryAttempts).toBe(1);
      await webhooks.requestAgentComplete(complete, sandboxHeaders, [200]);
      await flushWaitUntilForTest();
      expect(deliveryAttempts).toBe(1);
    });
  });
});
