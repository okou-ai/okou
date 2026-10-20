import {
  AGENT_EXECUTION_TIMEOUT_SECONDS,
  RUNNER_CANCELLATION_RECOVERY_GRACE_MS,
} from "@okouai/api-contracts/contracts/runners";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { mockNow, now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createPiMemoryMaintenanceFixture } from "./helpers/pi-memory-maintenance-fixture";

const context = testContext();
const {
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

describe("Pi maintenance recovery", () => {
  it("rejects a successful launch-base output without publication proof", async () => {
    const run = await prepareMaintenance();
    await webhooks.requestAgentComplete(
      {
        runId: run.runId,
        exitCode: 0,
        completion: {
          cliAgentType: "pi",
          cliAgentSessionId: run.runId,
          cliAgentSessionHistoryDisposition: "native_only",
          artifactSnapshots: [
            {
              name: run.memory.name,
              mountPath: run.memory.mountPath,
              version: run.maintenance.claimedBaseVersionId,
            },
          ],
        },
      },
      run.headers,
      [400],
    );
    expect((await runs.readRun(run.actor, run.runId)).status).toBe("running");
  });

  it("retries a still-owned nonzero maintenance completion through the operator", async () => {
    const run = await prepareMaintenance();
    await webhooks.requestAgentComplete(
      {
        runId: run.runId,
        exitCode: 1,
        error: "Provider failed before publication",
      },
      run.headers,
      [200],
    );
    await flushWaitUntilForTest();
    const waiting = await accept(
      run.stage2.consolidate({ headers: cronHeaders() }),
      [200],
    );
    expect(waiting.body).toMatchObject({ claimed: 0, noWork: 1 });
    // The genuine Runner's late first recovery output fixes the failed Run's
    // result. Terminal status without this output must not admit another Run.
    mockNow(now() + 61 * 60 * 1000);
    await expectBlocked(run);
    await completeMaintenance(
      run,
      run.maintenance.claimedBaseVersionId,
      false,
      1,
    );
    const retry = await accept(
      run.stage2.consolidate({ headers: cronHeaders() }),
      [200],
    );
    expect(retry.body).toMatchObject({ claimed: 1, failed: 0 });
    const next = await run.claimMaintenance();
    expect(next.runId).not.toBe(run.runId);
    expect(next.maintenance.claimedBaseVersionId).toBe(
      run.maintenance.claimedBaseVersionId,
    );
    await webhooks.requestAgentStoragePrepare(
      publication(run),
      run.headers,
      [404],
    );
    const published = await publish(
      next,
      "Memory recovered after a genuine failed attempt.\n",
    );
    await completeMaintenance(next, published.versionId);
    expect(
      (
        await observeMemory(
          run,
          "Memory recovered after a genuine failed attempt.\n",
        )
      ).memory.versionId,
    ).toBe(published.versionId);
  });

  it.each(["failed", "cancelled"])(
    "keeps a published %s Run's first recovery output and later exact replay",
    async (status) => {
      const run = await prepareMaintenance();
      const first = await publish(run, "Accepted before terminal fallback.\n");
      if (status === "failed") {
        await webhooks.requestAgentComplete(
          {
            runId: run.runId,
            exitCode: 1,
            error: "Runner fallback without outputs",
          },
          run.headers,
          [200],
        );
      } else {
        await runs.requestCancelRun(run.actor, run.runId, [200]);
      }
      await flushWaitUntilForTest();
      expect((await runs.readRun(run.actor, run.runId)).status).toBe(status);
      await publishOrdinaryMemory(
        run,
        "New owned memory while recovery is pending.\n",
      );
      await expectBlocked(run);
      const recovered = await completeMaintenance(
        run,
        run.maintenance.claimedBaseVersionId,
        false,
        1,
      );
      const original = await runs.readRun(run.actor, run.runId);
      expect(original).toMatchObject({
        status,
        result: { storageOutputs: [{ version: first.versionId }] },
      });
      const dispatched = await accept(
        run.stage2.consolidate({ headers: cronHeaders() }),
        [200],
      );
      expect(dispatched.body).toMatchObject({ claimed: 1, failed: 0 });
      const next = await run.claimMaintenance();
      const latest = await publish(next, "New maintenance after recovery.\n");
      await completeMaintenance(next, latest.versionId);
      await webhooks.requestAgentComplete(recovered.body, run.headers, [200]);
      await webhooks.requestAgentComplete(
        {
          ...recovered.body,
          completion: {
            ...recovered.body.completion,
            artifactSnapshots: [
              {
                name: run.memory.name,
                mountPath: run.memory.mountPath,
                version: latest.versionId,
              },
            ],
          },
        },
        run.headers,
        [400],
      );
      const observations = await Promise.allSettled([
        expect(runs.readRun(run.actor, run.runId)).resolves.toStrictEqual(
          original,
        ),
        observeMemory(run, "New maintenance after recovery.\n").then(
          ({ memory }) => {
            expect(memory.versionId).toBe(latest.versionId);
          },
        ),
      ]);
      for (const observation of observations) {
        if (observation.status === "rejected") {
          throw observation.reason;
        }
      }
    },
  );

  it.each([124, 137])(
    "retains accepted output across an authenticated Runner exit %s report",
    async (exitCode) => {
      const run = await prepareMaintenance();
      const first = await publish(
        run,
        "Accepted before the Runner failure report.\n",
      );
      await publishOrdinaryMemory(
        run,
        "Queued memory behind the execution lifetime.\n",
        1,
      );
      // This is the existing two-hour execution budget plus the supervisor's
      // 90-second finalization allowance and ten-second terminal wait. Passing
      // the budget alone neither reports termination nor admits another Run.
      mockNow(
        now() +
          AGENT_EXECUTION_TIMEOUT_SECONDS * 1000 +
          RUNNER_CANCELLATION_RECOVERY_GRACE_MS +
          10_000,
      );
      await expectBlocked(run);
      await webhooks.requestAgentComplete(
        {
          runId: run.runId,
          exitCode,
          error:
            exitCode === 124
              ? "Runner reports its execution timeout"
              : "Runner reports a killed agent process",
          ...(exitCode === 124
            ? { failureReason: "execution_timeout" as const }
            : {}),
        },
        run.headers,
        [200],
      );
      await flushWaitUntilForTest();
      expect((await runs.readRun(run.actor, run.runId)).status).toBe("failed");
      await expectBlocked(run);
      const recovered = await completeMaintenance(
        run,
        run.maintenance.claimedBaseVersionId,
        false,
        exitCode,
      );
      expect(
        (await runs.readRun(run.actor, run.runId)).result?.storageOutputs,
      ).toContainEqual(expect.objectContaining({ version: first.versionId }));
      const admitted = await accept(
        run.stage2.consolidate({ headers: cronHeaders() }),
        [200],
      );
      expect(admitted.body).toMatchObject({ claimed: 1, failed: 0 });
      const next = await run.claimMaintenance();
      const latest = await publish(
        next,
        "Memory after the Runner recovery output.\n",
      );
      await completeMaintenance(next, latest.versionId);
      await webhooks.requestAgentComplete(recovered.body, run.headers, [200]);
      expect(
        (await observeMemory(run, "Memory after the Runner recovery output.\n"))
          .memory.versionId,
      ).toBe(latest.versionId);
    },
  );

  it("keeps a nonzero launch-base output without publication proof failed", async () => {
    const run = await prepareMaintenance();
    await completeMaintenance(
      run,
      run.maintenance.claimedBaseVersionId,
      false,
      1,
    );
    expect((await runs.readRun(run.actor, run.runId)).status).toBe("failed");
  });
});
