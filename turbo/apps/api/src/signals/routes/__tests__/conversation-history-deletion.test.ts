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

async function completedRun(
  actor: ApiTestUser,
  agentId?: string,
  retainHistory = true,
) {
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
  const completion = {
    cliAgentType: "claude-code" as const,
    cliAgentSessionId: run.runId,
    ...(retainHistory
      ? { cliAgentSessionHistoryHash: hash }
      : { cliAgentSessionHistoryDisposition: "unavailable" as const }),
  };
  await webhooks.requestAgentComplete(
    { runId: run.runId, exitCode: 0, completion },
    headers,
    [200],
  );
  await expect(runs.readRun(actor, run.runId)).resolves.toMatchObject({
    status: "completed",
  });
  return { ...run, agentId: targetAgentId, hash, headers, completion };
}

test.each([true, false])(
  "deletes a completed Run (retained history=%s) with its Agent",
  async (retainHistory) => {
    const actor = bdd.user();
    const run = await completedRun(actor, undefined, retainHistory);
    await bdd.requestDeleteAgent(actor, run.agentId, [204]);
    const deleted = await runs.requestReadRun(actor, run.runId, [404]);
    expect(deleted.body).toMatchObject({ error: { code: "NOT_FOUND" } });
    await bdd.requestDeleteAgent(actor, run.agentId, [404]);
  },
);

test.each(["user", "organization"] as const)(
  "rejects a completed Runner callback after a verified Clerk %s deletion",
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
    const late = await webhooks.requestAgentComplete(
      { runId: run.runId, exitCode: 0, completion: run.completion },
      run.headers,
      [404],
    );
    expect(late.body).toMatchObject({
      error: { code: "NOT_FOUND", message: "Agent run not found" },
    });
  },
);

test("agent deletion preserves another Agent's completed Run and callback", async () => {
  const actor = bdd.user();
  const target = await completedRun(actor);
  const survivor = await completedRun(actor);
  await bdd.requestDeleteAgent(actor, target.agentId, [204]);
  await expect(runs.readRun(actor, survivor.runId)).resolves.toMatchObject({
    runId: survivor.runId,
    status: "completed",
  });
  await webhooks.requestAgentComplete(
    { runId: survivor.runId, exitCode: 0, completion: survivor.completion },
    survivor.headers,
    [200],
  );
  await bdd.requestDeleteAgent(actor, survivor.agentId, [204]);
});
