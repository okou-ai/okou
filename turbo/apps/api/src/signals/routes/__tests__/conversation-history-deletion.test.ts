import { createHash } from "node:crypto";

import { flushWaitUntilForTest } from "../../context/wait-until";
import { testContext } from "../../../__tests__/test-context";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();
const bdd = createBddApi(context);
const runs = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);

async function checkpointedRun(actor: ApiTestUser, agentId?: string) {
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  const runnerGroup = runs.configureRunnerGroup();
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
  const hash = createHash("sha256")
    .update(`bdd session history ${run.runId}`)
    .digest("hex");
  await runs.heartbeatRunner(runnerGroup);
  const claim = await runs.claimRunnerJob(run.runId);
  const headers = { authorization: `Bearer ${claim.sandboxToken}` };
  const checkpoint = {
    cliAgentType: "claude-code" as const,
    cliAgentSessionId: run.runId,
    cliAgentSessionHistoryHash: hash,
  };
  await webhooks.requestAgentComplete(
    { runId: run.runId, exitCode: 0, checkpoint },
    headers,
    [200],
  );
  await expect(runs.readRun(actor, run.runId)).resolves.toMatchObject({
    status: "completed",
  });
  return { ...run, agentId: targetAgentId, hash, headers, checkpoint };
}

test("deletes a completed Run with its Agent and rejects repeated deletion", async () => {
  const actor = bdd.user();
  const run = await checkpointedRun(actor);
  await bdd.requestDeleteAgent(actor, run.agentId, [204]);
  const deleted = await runs.requestReadRun(actor, run.runId, [404]);
  expect(deleted.body).toMatchObject({ error: { code: "NOT_FOUND" } });
  await bdd.requestDeleteAgent(actor, run.agentId, [404]);
});

test.each(["user", "organization"] as const)(
  "rejects a completed Runner callback after a verified Clerk %s deletion",
  async (kind) => {
    const actor = bdd.user();
    const run = await checkpointedRun(actor);
    webhooks.configureClerkWebhookSecret();
    webhooks.verifyNextClerkWebhook({
      type: kind === "user" ? "user.deleted" : "organization.deleted",
      data: { id: kind === "user" ? actor.userId : actor.orgId },
    });
    await webhooks.requestClerkWebhook("{}", {}, [200]);
    await flushWaitUntilForTest();
    const late = await webhooks.requestAgentComplete(
      { runId: run.runId, exitCode: 0, checkpoint: run.checkpoint },
      run.headers,
      [404],
    );
    expect(late.body).toMatchObject({
      error: { code: "NOT_FOUND", message: "Agent run not found" },
    });
  },
);
