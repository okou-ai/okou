import { createHash } from "node:crypto";
import { onTestFinished } from "vitest";
import { webhookCompleteContract } from "@okouai/api-contracts/contracts/webhooks";
import { setupApp } from "../../../__tests__/test-helpers";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";

import { flushWaitUntilForTest } from "../../context/wait-until";
import { testContext } from "../../../__tests__/test-context";
import {
  holdAgentRunDeletionFixture,
  readHistoryBlobReferenceCountFixture,
} from "../../../test-fixtures/run-deletion";
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
  runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor);
  await runs.ensureOrgModelProvider(actor);
  const targetAgentId =
    agentId ??
    (await bdd.createAgent(actor, { displayName: "History deletion" })).agentId;
  const run = await runs.createRun(actor, {
    agentId: targetAgentId,
    prompt: "retain history",
    modelProvider: "anthropic-api-key",
  });
  const hash = createHash("sha256")
    .update(`bdd session history ${run.runId}`)
    .digest("hex");
  const headers = {
    authorization: `Bearer ${runs.sandboxTokenForRun(actor, run.runId)}`,
  };
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
  // Ledger observation is a narrow infrastructure exception. Creation, actual
  // deletion, permissions and durable lifecycle reads all use production APIs.
  await expect(readHistoryBlobReferenceCountFixture(hash)).resolves.toBe(1);
  return { ...run, agentId: targetAgentId, hash, headers, checkpoint };
}

test("releases history on Agent deletion and does not release twice on retry", async () => {
  const actor = bdd.user();
  const run = await checkpointedRun(actor);
  await bdd.requestDeleteAgent(actor, run.agentId, [204]);
  await runs.requestReadRun(actor, run.runId, [404]);
  await expect(readHistoryBlobReferenceCountFixture(run.hash)).resolves.toBe(0);
  await bdd.requestDeleteAgent(actor, run.agentId, [404]);
  await expect(readHistoryBlobReferenceCountFixture(run.hash)).resolves.toBe(0);
});

test.each(["user", "organization"] as const)(
  "releases history through a verified Clerk %s webhook",
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
    await runs.requestReadRun(actor, run.runId, [404]);
    await expect(readHistoryBlobReferenceCountFixture(run.hash)).resolves.toBe(
      0,
    );
  },
);

test.each(["checkpoint", "combined-completion"] as const)(
  "serializes a %s retry behind accounted Run deletion",
  async (writer) => {
    const actor = bdd.user();
    const run = await checkpointedRun(actor);
    // Only the transaction pause is injected; the competing Runner write goes
    // through its production route and must revalidate the now-deleted Run.
    const held = await holdAgentRunDeletionFixture({
      runId: run.runId,
      signal: context.signal,
    });
    onTestFinished(async () => {
      held.release();
      await held.done;
    });
    const response =
      writer === "checkpoint"
        ? webhooks.requestAgentCheckpoint(
            { runId: run.runId, ...run.checkpoint },
            run.headers,
            [404],
          )
        : setupApp({ context, routes: webhooksAgentCompleteRoutes })(
            webhookCompleteContract,
          ).complete({
            body: {
              runId: run.runId,
              exitCode: 0,
              checkpoint: run.checkpoint,
            },
            headers: run.headers,
          });
    await expect.poll(held.blockedWaiterCount).toBeGreaterThan(0);
    held.release();
    await held.done;
    await expect(response).resolves.toMatchObject({
      status: writer === "checkpoint" ? 404 : 200,
    });
    await runs.requestReadRun(actor, run.runId, [404]);
    await expect(readHistoryBlobReferenceCountFixture(run.hash)).resolves.toBe(
      0,
    );
  },
);
