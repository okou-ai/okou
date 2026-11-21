import { flushWaitUntilForTest } from "../../context/wait-until";
import { testContext } from "../../../__tests__/test-context";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();
const bdd = createBddApi(context);
const runs = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);

async function completedRun(actor: ApiTestUser, agentId?: string) {
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  const runnerGroup = await runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor);
  await runs.ensurePersonalSubscriptionModel(actor, {
    model: "claude-fable-5-1",
  });
  const targetAgentId =
    agentId ??
    (await bdd.createAgent(actor, { displayName: "History deletion" })).agentId;
  const run = await runs.createThreadRun(actor, {
    agentId: targetAgentId,
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
  return { ...run, agentId: targetAgentId, headers, completion };
}

test("retains the member’s completed Run after a rejected legacy Agent deletion", async () => {
  const actor = bdd.user();
  const run = await completedRun(actor);
  await bdd.expectAgentDeleteUnavailable(actor, run.agentId);
  await expect(runs.readRun(actor, run.runId)).resolves.toMatchObject({
    runId: run.runId,
    status: "completed",
  });
  await bdd.expectAgentDeleteUnavailable(actor, run.agentId);
});

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

test("a rejected Agent deletion preserves another Agent's completed Run and callback", async () => {
  const actor = bdd.user();
  const target = await completedRun(actor);
  const survivor = await completedRun(actor);
  await bdd.expectAgentDeleteUnavailable(actor, target.agentId);
  await expect(runs.readRun(actor, survivor.runId)).resolves.toMatchObject({
    runId: survivor.runId,
    status: "completed",
  });
  await webhooks.requestAgentComplete(
    { runId: survivor.runId, exitCode: 0, completion: survivor.completion },
    survivor.headers,
    [200],
  );
  await bdd.expectAgentDeleteUnavailable(actor, survivor.agentId);
});
