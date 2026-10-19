import { http, HttpResponse } from "msw";
import { expect, test } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createPublicTeamsDispatchFixture } from "./helpers/public-teams-dispatch-fixture";

const context = testContext();

test("selects the onboarded default agent for a public Teams personal message", async () => {
  const owner = createPublicTeamsDispatchFixture(context);
  await owner.run(async () => {
    const runs = createRunsApi(context);
    runs.configureRunnerGroup();
    const fixture = await owner.create({
      withDefaultAgent: true,
      isolatePg: true,
    });
    server.use(
      http.post(
        `https://login.microsoftonline.com/${fixture.installation.teamsTenantId}/oauth2/v2.0/token`,
        () => {
          return HttpResponse.json({
            access_token: "teams-graph-token",
            token_type: "Bearer",
            expires_in: 3600,
          });
        },
      ),
      http.get(
        "https://graph.microsoft.com/v1.0/users/:userId/teamwork/installedApps",
        () => {
          return HttpResponse.json({ value: [] });
        },
      ),
    );

    const prompt = "Summarize the Teams compose selection for this message";
    await owner.dispatch(fixture, prompt);
    const reads = createRunReadsApi(context);
    const listed = await reads.requestListLogs(
      fixture.actor,
      { limit: 50 },
      [200],
    );
    expect(fixture.defaultAgentId).toStrictEqual(expect.any(String));
    expect(listed.body.data).toHaveLength(1);
    const run = listed.body.data[0];
    if (!run) {
      throw new Error("Expected the public Teams message to launch a Run");
    }
    expect(run).toMatchObject({
      agentId: fixture.defaultAgentId,
      prompt,
      triggerSource: "teams",
      status: "pending",
      startedAt: null,
    });

    await runs.requestCancelRun(fixture.actor, run.id, [200]);
    await flushWaitUntilForTest();
    const cancelled = await reads.requestReadLogById(
      fixture.actor,
      run.id,
      [200],
    );
    expect(cancelled.body).toMatchObject({
      id: run.id,
      agentId: fixture.defaultAgentId,
      prompt,
      status: "cancelled",
      startedAt: null,
    });
  });
});
