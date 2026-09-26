import { createStore } from "ccstate";

import { testContext } from "../../../__tests__/test-context";
import {
  readAgentLifecycleCountsFixture,
  readUsageEventRunIdFixture,
  setAgentRunStatusFixture,
} from "../../../test-fixtures/agent-deletion";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import {
  insertUsageEvent$,
  materializeHourlyUsage$,
  readUsageStorageCounts$,
} from "./helpers/usage-state";

const context = testContext();
const store = createStore();
const bdd = createBddApi(context);
const api = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);

function orgIdOf(actor: ApiTestUser): string {
  if (!actor.orgId) {
    throw new Error("Expected an org-scoped actor");
  }
  return actor.orgId;
}

async function createAgent(
  actor: ApiTestUser,
  displayName: string,
): Promise<{ readonly agentId: string }> {
  bdd.acceptAgentStorageWrites();
  return await bdd.createAgent(actor, { displayName });
}

async function prepareRunCreation(
  ...actors: readonly ApiTestUser[]
): Promise<void> {
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  api.configureRunnerGroup();
  for (const actor of actors) {
    await api.grantProEntitlement(actor);
    await api.ensureOrgModelProvider(actor);
  }
}

async function expectActiveCheckpointRejected(
  actor: ApiTestUser,
  runId: string,
): Promise<void> {
  const response = await webhooks.requestAgentCheckpoint(
    {
      runId,
      cliAgentType: "claude-code",
      cliAgentSessionId: `agent-delete-${runId}`,
      cliAgentSessionHistoryDisposition: "unavailable",
    },
    { authorization: `Bearer ${api.sandboxTokenForRun(actor, runId)}` },
    [400],
  );
  expect(response.status).toBe(400);
  expect(JSON.stringify(response.body)).toContain(
    "[CHECKPOINT_RUN_NOT_SETTLED]",
  );
}

describe("DELETE /api/agents/:id lifecycle cleanup", () => {
  it("deletes the exact canonical lifecycle while retaining billing and unrelated Runs", async () => {
    const actor = bdd.user();
    await prepareRunCreation(actor);
    const target = await createAgent(actor, "Deletion Target");
    const survivor = await createAgent(actor, "Independent Survivor");
    const targetRun = await api.createRun(actor, {
      agentId: target.agentId,
      prompt: "retain target billing history",
      modelProvider: "anthropic-api-key",
    });
    await api.requestCancelRun(actor, targetRun.runId, [200]);
    const survivorRun = await api.createRun(actor, {
      agentId: survivor.agentId,
      prompt: "retain unrelated lifecycle",
      modelProvider: "anthropic-api-key",
    });
    const usageEventId = await store.set(
      insertUsageEvent$,
      {
        orgId: orgIdOf(actor),
        userId: actor.userId,
        runId: targetRun.runId,
        status: "pending",
        creditsCharged: 2,
      },
      context.signal,
    );

    const response = await bdd.requestDeleteAgent(actor, target.agentId, [204]);

    expect(response.body).toBeUndefined();
    await expect(
      bdd.requestReadAgent(actor, target.agentId, [404]),
    ).resolves.toMatchObject({ status: 404 });
    await expect(
      readAgentLifecycleCountsFixture(target.agentId),
    ).resolves.toStrictEqual({ agents: 0, sessions: 0, runs: 0 });
    await expect(
      api.requestReadRun(actor, targetRun.runId, [404]),
    ).resolves.toMatchObject({ status: 404 });
    await expect(bdd.readAgent(actor, survivor.agentId)).resolves.toMatchObject(
      { agentId: survivor.agentId },
    );
    const survivorRunRead = await api.readRun(actor, survivorRun.runId);
    expect(survivorRunRead).toMatchObject({
      runId: survivorRun.runId,
      status: "pending",
    });
    await expectActiveCheckpointRejected(actor, survivorRun.runId);
    await expect(readUsageEventRunIdFixture(usageEventId)).resolves.toBeNull();
    await api.requestCancelRun(actor, survivorRun.runId, [200]);
  });

  it("detects an active target Run through its canonical Session", async () => {
    const actor = bdd.user();
    await prepareRunCreation(actor);
    const target = await createAgent(actor, "Active Session Target");
    const targetRun = await api.createRun(actor, {
      agentId: target.agentId,
      prompt: "block target deletion",
      modelProvider: "anthropic-api-key",
    });
    const response = await bdd.requestDeleteAgent(actor, target.agentId, [409]);

    expect(response.body).toStrictEqual({
      error: {
        message: "Cannot delete agent: agent is currently running",
        code: "CONFLICT",
      },
    });
    const targetRunRead = await api.readRun(actor, targetRun.runId);
    expect(targetRunRead).toMatchObject({
      runId: targetRun.runId,
      status: "pending",
    });
    await expect(bdd.readAgent(actor, target.agentId)).resolves.toMatchObject({
      agentId: target.agentId,
    });
    await api.requestCancelRun(actor, targetRun.runId, [200]);
  });

  it("cascades queued and terminal target Runs while preserving unrelated cross-org lifecycle and billing", async () => {
    const targetOwner = bdd.user();
    const survivorOwner = bdd.user();
    await prepareRunCreation(targetOwner, survivorOwner);
    const survivor = await createAgent(
      survivorOwner,
      "Cross Org Agent Survivor",
    );
    const target = await createAgent(targetOwner, "Terminal Cleanup Target");
    const survivorRun = await api.createRun(survivorOwner, {
      agentId: survivor.agentId,
      prompt: "survive another org deletion",
      modelProvider: "anthropic-api-key",
    });
    const terminalRun = await api.createRun(targetOwner, {
      agentId: target.agentId,
      prompt: "terminal target Run",
      modelProvider: "anthropic-api-key",
    });
    const queuedRun = await api.createRun(targetOwner, {
      agentId: target.agentId,
      prompt: "queued target Run",
      modelProvider: "anthropic-api-key",
    });
    await api.requestCancelRun(targetOwner, terminalRun.runId, [200]);
    await flushWaitUntilForTest();
    await setAgentRunStatusFixture(queuedRun.runId, "queued");
    const orgId = orgIdOf(targetOwner);
    const pendingUsageId = await store.set(
      insertUsageEvent$,
      {
        orgId,
        userId: targetOwner.userId,
        runId: terminalRun.runId,
        status: "pending",
        creditsCharged: 3,
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        orgId,
        userId: targetOwner.userId,
        runId: terminalRun.runId,
        status: "processed",
        creditsCharged: 5,
      },
      context.signal,
    );
    await expect(
      store.set(
        materializeHourlyUsage$,
        { orgId, userId: targetOwner.userId, runId: terminalRun.runId },
        context.signal,
      ),
    ).resolves.toBe(1);
    await expect(
      store.set(
        readUsageStorageCounts$,
        { scope: "organization", id: orgId },
        context.signal,
      ),
    ).resolves.toStrictEqual({ raw: 1, hourly: 1 });

    await bdd.deleteAgent(targetOwner, target.agentId);

    await expect(
      bdd.requestReadAgent(targetOwner, target.agentId, [404]),
    ).resolves.toMatchObject({ status: 404 });
    await expect(
      api.requestReadRun(targetOwner, terminalRun.runId, [404]),
    ).resolves.toMatchObject({ status: 404 });
    await expect(
      api.requestReadRun(targetOwner, queuedRun.runId, [404]),
    ).resolves.toMatchObject({ status: 404 });
    await expect(
      readAgentLifecycleCountsFixture(target.agentId),
    ).resolves.toStrictEqual({ agents: 0, sessions: 0, runs: 0 });
    await expect(
      bdd.readAgent(survivorOwner, survivor.agentId),
    ).resolves.toMatchObject({ agentId: survivor.agentId });
    const survivorRunRead = await api.readRun(survivorOwner, survivorRun.runId);
    expect(survivorRunRead).toMatchObject({
      runId: survivorRun.runId,
      status: "pending",
    });
    await expectActiveCheckpointRejected(survivorOwner, survivorRun.runId);
    await expect(
      readUsageEventRunIdFixture(pendingUsageId),
    ).resolves.toBeNull();
    await expect(
      store.set(
        readUsageStorageCounts$,
        { scope: "organization", id: orgId },
        context.signal,
      ),
    ).resolves.toStrictEqual({ raw: 1, hourly: 1 });
    await api.requestCancelRun(survivorOwner, survivorRun.runId, [200]);
  });
});
