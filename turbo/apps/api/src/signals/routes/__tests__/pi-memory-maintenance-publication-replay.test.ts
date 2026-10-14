import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { mockNow, now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createPiMemoryMaintenanceFixture } from "./helpers/pi-memory-maintenance-fixture";

const context = testContext();
const {
  chat,
  runs,
  webhooks,
  cronHeaders,
  prepareMaintenance,
  publish,
  completeMaintenance,
  observeMemory,
  publishOrdinaryMemory,
} = createPiMemoryMaintenanceFixture(context);

describe("Genuine Pi maintenance publication results", () => {
  it("publishes and replays a maintenance result before private completion", async () => {
    const run = await prepareMaintenance();
    const body = await publish(run, "Prefer focused public API tests.\n");
    const replay = await webhooks.requestAgentStorageCommit(
      body,
      run.headers,
      [200],
    );
    expect(replay.body).toMatchObject({
      versionId: body.versionId,
      deduplicated: true,
    });
  });

  it("replays a maintenance result after private completion", async () => {
    const run = await prepareMaintenance();
    const body = await publish(run, "Prefer focused public API tests.\n");
    await completeMaintenance(run, body.versionId);
    const replay = await webhooks.requestAgentStorageCommit(
      body,
      run.headers,
      [200],
    );
    expect(replay.body).toMatchObject({
      versionId: body.versionId,
      deduplicated: true,
    });
    expect(
      (await observeMemory(run, "Prefer focused public API tests.\n")).memory,
    ).toMatchObject({
      storageId: body.storageId,
      versionId: body.versionId,
      archiveUrl: expect.any(String),
    });
    const settled = await accept(
      run.stage2.consolidate({ headers: cronHeaders() }),
      [200],
    );
    expect(settled.body).toMatchObject({ claimed: 0, noWork: 1 });
  });

  it("replays a completed maintenance Run after a later maintenance replaces the latest Job result", async () => {
    const run = await prepareMaintenance();
    const first = await publish(run, "First maintenance memory.\n");
    const completed = await completeMaintenance(run, first.versionId, true);
    const firstResult = await runs.readRun(run.actor, run.runId);
    expect(firstResult).toMatchObject({
      status: "completed",
      result: { storageOutputs: [{ version: first.versionId }] },
    });
    const recoveryReplay = {
      ...completed.body,
      completion: {
        ...completed.body.completion,
        artifactSnapshots: [
          {
            name: run.memory.name,
            mountPath: run.memory.mountPath,
            version: run.maintenance.claimedBaseVersionId,
          },
        ],
      },
    };
    await webhooks.requestAgentComplete(recoveryReplay, run.headers, [200]);

    // An ordinary owned HEAD change queues reconciliation immediately, within
    // the first claim's real three-hour credential lifetime and without waiting
    // for the six-hour successful-maintenance cooldown.
    const ordinary = await publishOrdinaryMemory(
      run,
      "Ordinary changed memory.\n",
    );
    const dispatched = await accept(
      run.stage2.consolidate({ headers: cronHeaders() }),
      [200],
    );
    expect(dispatched.body).toMatchObject({ claimed: 1, failed: 0, stale: 0 });
    const next = await run.claimMaintenance();
    expect(next.runId).not.toBe(run.runId);
    expect(next.maintenance.claimedRevision).toBeGreaterThan(
      run.maintenance.claimedRevision,
    );
    expect(next.maintenance.claimedBaseVersionId).toBe(ordinary.versionId);
    const latest = await publish(next, "Later maintenance memory.\n");
    await completeMaintenance(next, latest.versionId, true);
    const latestResult = await runs.readRun(run.actor, next.runId);
    expect(latestResult).toMatchObject({
      status: "completed",
      result: { storageOutputs: [{ version: latest.versionId }] },
    });

    const replay = await webhooks.requestAgentComplete(
      completed.body,
      run.headers,
      [200],
    );
    expect(replay.body).toStrictEqual(completed.response.body);
    const recovered = await webhooks.requestAgentComplete(
      recoveryReplay,
      run.headers,
      [200],
    );
    expect(recovered.body).toStrictEqual(completed.response.body);
    await flushWaitUntilForTest();
    for (const completion of [
      { ...completed.body.completion, cliAgentSessionId: next.runId },
      { ...completed.body.completion, cliAgentType: "claude-code" },
      {
        ...completed.body.completion,
        cliAgentSessionHistoryDisposition: "discarded_oversized" as const,
      },
      {
        ...completed.body.completion,
        artifactSnapshots: [
          {
            name: run.memory.name,
            mountPath: run.memory.mountPath,
            version: latest.versionId,
          },
        ],
      },
      { ...completed.body.completion, artifactSnapshots: [] },
      {
        ...completed.body.completion,
        artifactSnapshots: [
          ...completed.body.completion.artifactSnapshots,
          ...completed.body.completion.artifactSnapshots,
        ],
      },
    ]) {
      await webhooks.requestAgentComplete(
        { ...completed.body, completion },
        run.headers,
        [400],
      );
    }
    await webhooks.requestAgentComplete(completed.body, next.headers, [401]);
    const peer = await chat.entitledChatActor({ orgId: run.actor.orgId });
    const foreign = await chat.sendChatRun(peer.actor, {
      agentId: peer.agentId,
      prompt: "Own a foreign Run",
      model: "claude-fable-5-1",
    });
    const foreignClaim = await chat.claimChatRun(
      peer.runnerGroup,
      foreign.runId,
    );
    await webhooks.requestAgentComplete(
      completed.body,
      foreignClaim.sandboxHeaders,
      [401],
    );
    await runs.requestReadRun(peer.actor, run.runId, [404]);
    await webhooks.requestAgentComplete(
      {
        runId: foreign.runId,
        exitCode: 1,
        error: "Foreign replay check complete",
      },
      foreignClaim.sandboxHeaders,
      [200],
    );
    await expect(runs.readRun(run.actor, run.runId)).resolves.toStrictEqual(
      firstResult,
    );
    await expect(runs.readRun(run.actor, next.runId)).resolves.toStrictEqual(
      latestResult,
    );
    expect(
      (await observeMemory(run, "Later maintenance memory.\n")).memory
        .versionId,
    ).toBe(latest.versionId);
    const settled = await accept(
      run.stage2.consolidate({ headers: cronHeaders() }),
      [200],
    );
    expect(settled.body).toMatchObject({ claimed: 0, noWork: 1 });
    // Advancing the same case clock expires the original genuine credential.
    mockNow(now() + 3 * 60 * 60 * 1000 + 1000);
    await webhooks.requestAgentComplete(completed.body, run.headers, [401]);
  });

  it("replays a no-diff result without restoring an older memory head", async () => {
    const run = await prepareMaintenance();
    const body = await publish(run);
    await webhooks.requestAgentStorageCommit(body, run.headers, [200]);
    await completeMaintenance(run, body.versionId);
    expect((await observeMemory(run)).memory.versionId).toBe(body.versionId);
    const newer = await publishOrdinaryMemory(run, "Newer ordinary memory.\n");
    const replay = await webhooks.requestAgentStorageCommit(
      body,
      run.headers,
      [200],
    );
    expect(replay.body).toMatchObject({
      versionId: body.versionId,
      deduplicated: true,
    });
    expect(newer.versionId).not.toBe(body.versionId);
    expect(
      (await observeMemory(run, "Newer ordinary memory.\n")).memory.versionId,
    ).toBe(newer.versionId);
  });
});
