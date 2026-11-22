import { flushWaitUntilForTest } from "../../context/wait-until";
import { testContext } from "../../../__tests__/test-context";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();
const bdd = createBddApi(context);
const runs = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);

async function completedRun(actor: ApiTestUser) {
  bdd.acceptStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  const runnerGroup = await runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor);
  await runs.ensurePersonalSubscriptionModel(actor, {
    model: "claude-fable-5-1",
  });
  const run = await runs.createThreadRun(actor, {
    prompt: "retain history",
  });
  await runs.heartbeatRunner(runnerGroup);
  const execution = await runs.executionInput(run.runId);
  const headers = { authorization: `Bearer ${execution.sandboxToken}` };
  const completion = {
    cliAgentType: "claude-code" as const,
    cliAgentSessionId: run.runId,
    cliAgentSessionHistoryDisposition: "native_only" as const,
  };
  await webhooks.requestAgentComplete(
    { runId: run.runId, exitCode: 0, completion },
    headers,
    [200],
  );
  await expect(runs.readRun(actor, run.runId)).resolves.toMatchObject({
    status: "completed",
  });
  return { ...run, headers, completion };
}

test.each(["user", "organization"] as const)(
  "preserves completed Run history and callback replay after Clerk %s deletion",
  async (kind) => {
    const actor = bdd.user();
    const run = await completedRun(actor);
    webhooks.configureClerkWebhookSecret();
    webhooks.verifyNextClerkWebhook({
      type: kind === "user" ? "user.deleted" : "organization.deleted",
      data: { id: kind === "user" ? actor.userId : actor.orgId },
    });
    await webhooks.requestClerkWebhook("{}", {}, [200]);
    await flushWaitUntilForTest();
    const replay = await webhooks.requestAgentComplete(
      { runId: run.runId, exitCode: 0, completion: run.completion },
      run.headers,
      [200],
    );
    expect(replay.status).toBe(200);
  },
);
