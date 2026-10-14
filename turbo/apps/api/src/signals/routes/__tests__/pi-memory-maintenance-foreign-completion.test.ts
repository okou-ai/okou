import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { createPiMemoryMaintenanceFixture } from "./helpers/pi-memory-maintenance-fixture";

const context = testContext();
const {
  chat,
  runs,
  webhooks,
  createChatActor,
  prepareMaintenance,
  publish,
  completeMaintenance,
} = createPiMemoryMaintenanceFixture(context);

describe("Genuine Pi maintenance publication results", () => {
  it("rejects a foreign claim and read after private completion", async () => {
    const run = await prepareMaintenance();
    const first = await publish(run);
    const completed = await completeMaintenance(run, first.versionId);
    const firstResult = await runs.readRun(run.actor, run.runId);
    expect(firstResult).toMatchObject({
      status: "completed",
      result: { storageOutputs: [{ version: first.versionId }] },
    });
    const peer = await createChatActor(
      run.runnerGroup,
      run.actor.orgId,
      "claude-fable-5-1",
    );
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
  });
});
