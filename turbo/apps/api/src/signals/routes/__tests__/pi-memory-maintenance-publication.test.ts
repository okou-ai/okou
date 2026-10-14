import { createHash } from "node:crypto";
import { cronCleanupSandboxesContract } from "@okouai/api-contracts/contracts/cron";
import {
  AGENT_EXECUTION_TIMEOUT_SECONDS,
  CANCELLATION_RECOVERY_STALE_AFTER_MS,
} from "@okouai/api-contracts/contracts/runners";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow, now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { cronCleanupSandboxesRoutes } from "../cron-cleanup-sandboxes";
import { expectCanonicalStorageManifest } from "./helpers/api-bdd-runs";
import { createPiMemoryMaintenanceFixture } from "./helpers/pi-memory-maintenance-fixture";

const context = testContext();
const {
  chat,
  runs,
  webhooks,
  cronHeaders,
  prepareMaintenance,
  publication,
  publish,
  completeMaintenance,
  observeMemory,
  publishOrdinaryMemory,
  expectBlocked,
} = createPiMemoryMaintenanceFixture(context);

async function cleanupMaintenance() {
  return await accept(
    setupApp({ context, routes: cronCleanupSandboxesRoutes })(
      cronCleanupSandboxesContract,
    ).cleanup({ headers: cronHeaders() }),
    [200],
  );
}

describe("Pi maintenance cleanup and active publication", () => {
  it.each(["published", "no-diff"])(
    "retains an active %s result while an independent owner progresses",
    async (outcome) => {
      const run = await prepareMaintenance({ independentOwner: true });
      const first = await publish(
        run,
        outcome === "published" ? "First serial memory.\n" : undefined,
      );
      expect((await runs.readRun(run.actor, run.runId)).status).toBe("running");
      await publishOrdinaryMemory(run, "Queued owned update.\n", 1);
      const independentAdmission = await accept(
        run.stage2.consolidate({ headers: cronHeaders() }),
        [200],
      );
      expect(independentAdmission.body).toMatchObject({
        claimed: 1,
        failed: 0,
      });
      const independent = await run.claimMaintenance(1);
      expect(independent.actor.userId).not.toBe(run.actor.userId);
      expect(independent.memory.storageId).not.toBe(run.memory.storageId);
      const independentOutput = await publish(
        independent,
        "Independent owner's memory.\n",
      );
      await completeMaintenance(independent, independentOutput.versionId);
      await expectBlocked(run);
      await webhooks.requestAgentHeartbeat(
        { runId: run.runId },
        run.headers,
        [200],
      );
      await cleanupMaintenance();
      expect((await runs.readRun(run.actor, run.runId)).status).toBe("running");
      const prepared = await webhooks.requestAgentStoragePrepare(
        first,
        run.headers,
        [200],
      );
      expect(prepared.body).toMatchObject({
        versionId: first.versionId,
        existing: true,
      });
      const replay = await webhooks.requestAgentStorageCommit(
        first,
        run.headers,
        [200],
      );
      expect(replay.body).toMatchObject({
        versionId: first.versionId,
        deduplicated: true,
      });
      await completeMaintenance(
        run,
        run.maintenance.claimedBaseVersionId,
        true,
      );
      await expect(runs.readRun(run.actor, run.runId)).resolves.toMatchObject({
        status: "completed",
        result: { storageOutputs: [{ version: first.versionId }] },
      });
    },
  );

  it("closes a published Run's output authority only after the real heartbeat timeout transition", async () => {
    const run = await prepareMaintenance();
    const first = await publish(run, "Accepted before heartbeat silence.\n");
    await publishOrdinaryMemory(
      run,
      "Owned memory queued behind the silent Run.\n",
      1,
    );
    await expectBlocked(run);
    await webhooks.requestAgentHeartbeat(
      { runId: run.runId },
      run.headers,
      [200],
    );
    mockNow(now() + 2 * 60 * 1000 + 1000);
    await cleanupMaintenance();
    expect((await runs.readRun(run.actor, run.runId)).status).toBe("timeout");
    const dispatched = await accept(
      run.stage2.consolidate({ headers: cronHeaders() }),
      [200],
    );
    expect(dispatched.body).toMatchObject({ claimed: 1, failed: 0 });
    const next = await run.claimMaintenance();
    const latest = await publish(next, "Memory after authoritative timeout.\n");
    await completeMaintenance(next, latest.versionId);
    const late = await completeMaintenance(run, first.versionId);
    expect(late.response.body).toMatchObject({ status: "failed" });
    expect(
      (await observeMemory(run, "Memory after authoritative timeout.\n")).memory
        .versionId,
    ).toBe(latest.versionId);
  });

  it.each(["failed", "cancelled"])(
    "waits for actual deletion of an unrecovered %s Run",
    async (status) => {
      const run = await prepareMaintenance();
      const first = await publish(
        run,
        "Accepted before unrecovered terminal failure.\n",
      );
      if (status === "cancelled") {
        await runs.requestCancelRun(run.actor, run.runId, [200]);
      }
      await webhooks.requestAgentComplete(
        {
          runId: run.runId,
          exitCode: 1,
          error: "Runner fallback has no recovery output",
        },
        run.headers,
        [200],
      );
      await flushWaitUntilForTest();
      expect((await runs.readRun(run.actor, run.runId)).status).toBe(status);
      const ordinary = await publishOrdinaryMemory(
        run,
        "Queued owned memory survives terminal cleanup.\n",
      );
      await expectBlocked(run);
      // Use the existing private usage/cleanup lifetime; time alone still cannot
      // admit B. Only the authenticated cleanup's actual Run deletion closes A.
      mockNow(
        now() +
          AGENT_EXECUTION_TIMEOUT_SECONDS * 1000 +
          CANCELLATION_RECOVERY_STALE_AFTER_MS +
          1000,
      );
      await expectBlocked(run);
      await cleanupMaintenance();
      await runs.requestReadRun(run.actor, run.runId, [404]);
      await webhooks.requestAgentComplete(
        { runId: run.runId, exitCode: 1 },
        run.headers,
        [404],
      );
      await webhooks.requestAgentStorageCommit(first, run.headers, [404]);
      const admitted = await accept(
        run.stage2.consolidate({ headers: cronHeaders() }),
        [200],
      );
      expect(admitted.body).toMatchObject({ claimed: 1, failed: 0 });
      const next = await run.claimMaintenance();
      expect(next.maintenance.claimedBaseVersionId).toBe(ordinary.versionId);
      const latest = await publish(
        next,
        "Maintenance after actual terminal deletion.\n",
      );
      await completeMaintenance(next, latest.versionId);
      expect(
        (
          await observeMemory(
            run,
            "Maintenance after actual terminal deletion.\n",
          )
        ).memory.versionId,
      ).toBe(latest.versionId);
    },
  );
});

describe("Pi maintenance publication ownership", () => {
  it.each(["the same organization", "another organization"])(
    "rejects foreign claims, foreign memory and altered launch evidence from %s",
    async (scope) => {
      const run = await prepareMaintenance();
      const peer = await chat.entitledChatActor(
        scope === "the same organization" ? { orgId: run.actor.orgId } : {},
      );
      const ordinary = await chat.sendChatRun(peer.actor, {
        agentId: peer.agentId,
        prompt: "Own another user's memory",
        model: "claude-fable-5-1",
      });
      const claimed = await chat.claimChatRun(peer.runnerGroup, ordinary.runId);
      const foreignMemory = expectCanonicalStorageManifest(
        claimed.claim.storageManifest,
      )?.storageMounts.find((mount) => {
        return mount.name === "memory";
      });
      if (!foreignMemory) {
        throw new Error("Expected the peer's actual memory mount");
      }
      expect(foreignMemory.storageId).not.toBe(run.memory.storageId);
      await runs.requestReadRun(peer.actor, run.runId, [404]);
      const body = publication(run);
      for (const request of [
        webhooks.requestAgentStoragePrepare,
        webhooks.requestAgentStorageCommit,
      ]) {
        await request(body, claimed.sandboxHeaders, [401]);
        await request(
          { ...body, storageId: foreignMemory.storageId },
          run.headers,
          [404],
        );
        await request(
          {
            ...body,
            maintenanceAttestation: {
              ...body.maintenanceAttestation,
              claimedRevision: body.maintenanceAttestation.claimedRevision + 1,
            },
          },
          run.headers,
          [404],
        );
        await request(
          {
            ...body,
            maintenanceAttestation: {
              ...body.maintenanceAttestation,
              selectionDigest: createHash("sha256")
                .update("foreign selection")
                .digest("hex"),
            },
          },
          run.headers,
          [404],
        );
      }
      await webhooks.requestAgentComplete(
        { runId: run.runId, exitCode: 1 },
        claimed.sandboxHeaders,
        [401],
      );
      const published = await publish(run);
      await webhooks.requestAgentComplete(
        {
          runId: run.runId,
          exitCode: 0,
          completion: {
            cliAgentType: "pi",
            cliAgentSessionId: ordinary.runId,
            cliAgentSessionHistoryDisposition: "unavailable",
            artifactSnapshots: [
              {
                name: run.memory.name,
                mountPath: run.memory.mountPath,
                version: published.versionId,
              },
            ],
          },
        },
        run.headers,
        [400],
      );
      await completeMaintenance(run, published.versionId);
      await webhooks.requestAgentComplete(
        {
          runId: ordinary.runId,
          exitCode: 1,
          error: "Peer ownership check complete",
        },
        claimed.sandboxHeaders,
        [200],
      );
      expect((await observeMemory(run)).memory.versionId).toBe(
        published.versionId,
      );
    },
  );
});
