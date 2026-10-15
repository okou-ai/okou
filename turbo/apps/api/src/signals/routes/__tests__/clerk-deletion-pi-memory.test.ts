import { runnersCancellationContract } from "@okouai/api-contracts/contracts/runners";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { runnerCancellationRoutes } from "../runner-cancellation";
import { createPiMemoryMaintenanceFixture } from "./helpers/pi-memory-maintenance-fixture";

const context = testContext();
const {
  webhooks,
  cronHeaders,
  prepareSources,
  prepareMaintenance,
  publication,
  preparePublication,
  publish,
  completeMaintenance,
  maintenanceCompletion,
  observeMemory,
  expectBlocked,
} = createPiMemoryMaintenanceFixture(context);

type Deletion = "user.deleted" | "organization.deleted";
type Sources = Awaited<ReturnType<typeof prepareSources>>;
type Maintenance = Awaited<ReturnType<typeof prepareMaintenance>>;

async function deleteOwner(type: Deletion, owner: Sources["actor"]) {
  webhooks.configureClerkWebhookSecret();
  webhooks.verifyNextClerkWebhook({
    type,
    data: { id: type === "user.deleted" ? owner.userId : owner.orgId },
  });
  await webhooks.requestClerkWebhook("{}", {}, [200]);
  await flushWaitUntilForTest();
}

async function cancellation(
  run: Pick<Maintenance, "runId" | "headers" | "runnerGroup">,
  source: Sources,
) {
  const response = await accept(
    setupApp({ context, routes: runnerCancellationRoutes })(
      runnersCancellationContract,
    ).get({
      params: { runId: run.runId },
      headers: run.headers,
      query: { runnerGroup: run.runnerGroup, ...source.runnerIdentity },
    }),
    [200],
  );
  return response.body;
}

async function extract(source: Sources, succeeded: number) {
  const response = await accept(
    source.stage1.extract({ headers: cronHeaders() }),
    [200],
  );
  expect(response.body).toMatchObject({
    success: true,
    succeeded,
    terminalFailure: 0,
    retryableFailure: 0,
  });
}

async function dispatch(source: Sources) {
  const response = await accept(
    source.stage2.consolidate({ headers: cronHeaders() }),
    [200],
  );
  expect(response.body).toMatchObject({ claimed: 1, failed: 0, stale: 0 });
}

// Extraction/consolidation are explicitly in-scope production operator system
// boundaries: real CRON_SECRET auth, case-owned DB, ordinary chat/native history.
// Deletion uses verified Clerk ingress; subsequent observations never revive a
// deleted session. No private candidates, leases, or mixed-source rows are seeded.
describe("Clerk deletion stops Pi memory work without erasing publication", () => {
  it.each<Deletion>(["user.deleted", "organization.deleted"])(
    "%s consumes an unextracted day while an independent owner's extraction still publishes",
    async (type) => {
      const source = await prepareSources({
        independentOwner: true,
        peerScope: "foreign",
      });
      await deleteOwner(type, source.actor);
      await extract(source, 1);
      await dispatch(source);
      const independent = await source.claimMaintenance();
      expect(independent.actor.userId).toBe(source.peerActor?.actor.userId);
      expect(independent.actor.orgId).toBe(source.peerActor?.actor.orgId);
      expect(independent.maintenance.selected).toContainEqual(
        expect.objectContaining({ sourceRunId: source.peerSource?.runId }),
      );
      expect(independent.maintenance.selected).not.toContainEqual(
        expect.objectContaining({ sourceRunId: source.source.runId }),
      );
      const output = await publish(
        independent,
        "Independent extraction survived.\n",
      );
      await completeMaintenance(independent, output.versionId);
      expect(
        (
          await observeMemory(
            { ...source, ...independent },
            "Independent extraction survived.\n",
          )
        ).memory.versionId,
      ).toBe(output.versionId);
      await extract(source, 0);
      await expectBlocked({ ...source, ...independent });
      // A replay is still only a one-shot stop, not a permanent input fence.
      await deleteOwner(type, source.actor);
      await extract(source, 0);
      await expectBlocked({ ...source, ...independent });
    },
  );

  const scopes = ["same-org", "same-user-other-org", "foreign"] as const;
  const activeCases = (
    ["user.deleted", "organization.deleted"] as const
  ).flatMap((type) => {
    return scopes.map((peerScope) => {
      return { type, peerScope };
    });
  });

  it.each(activeCases)(
    "$type removes active maintenance authority with $peerScope isolation",
    async ({ type, peerScope }) => {
      const first = await prepareMaintenance({
        independentOwner: true,
        peerScope,
      });
      await dispatch(first);
      const second = await first.claimMaintenance(1);
      expect(second.runId).not.toBe(first.runId);
      const active = [first, second];
      expect(
        active.flatMap((run) => {
          return run.maintenance.selected.map((selected) => {
            return selected.sourceRunId;
          });
        }),
      ).toStrictEqual(
        expect.arrayContaining([first.source.runId, first.peerSource?.runId]),
      );
      expect(second.memory.storageId).not.toBe(first.memory.storageId);
      const target = first.sourceActor.actor;
      const pending = [];
      for (const run of active) {
        // Upload through the granted URLs BEFORE stopping, so late commit must
        // reject lost authority, not merely fail because bytes were never sent.
        pending.push(
          await preparePublication(run, `Uncommitted ${run.runId}.\n`),
        );
      }
      await deleteOwner(type, target);
      for (const [index, run] of active.entries()) {
        const stopped =
          type === "user.deleted"
            ? run.actor.userId === target.userId
            : run.actor.orgId === target.orgId;
        await expect(cancellation(run, first)).resolves.toMatchObject({
          state: "present",
          mode: stopped ? "hard" : null,
        });
        const prepared = pending[index];
        if (!prepared) {
          throw new Error("Expected the Runner's pre-deletion upload receipt");
        }
        if (stopped) {
          await webhooks.requestAgentStoragePrepare(
            prepared,
            run.headers,
            [404],
          );
          await webhooks.requestAgentStorageCommit(
            prepared,
            run.headers,
            [404],
          );
          const lateSuccess = maintenanceCompletion(run, prepared.versionId);
          const rejected = await Promise.all([
            webhooks.requestAgentComplete(lateSuccess, run.headers, [400]),
            webhooks.requestAgentComplete(lateSuccess, run.headers, [400]),
          ]);
          for (const response of rejected) {
            expect(response.body).toStrictEqual({
              error: {
                code: "BAD_REQUEST",
                message:
                  "[PI_MAINTENANCE_OUTPUT_INVALID] Private output lacks exact publication or recovery evidence",
              },
            });
          }
          // A hard-cancelled Runner can report failure without claiming any
          // final output. Neither uploaded bytes nor a cancelled lease prove
          // publication; do not pretend its uncommitted version was recovered.
          const cancelled = {
            runId: run.runId,
            exitCode: 1,
            error: "Runner stopped after owner deletion",
          };
          const [completed, repeated] = await Promise.all([
            webhooks.requestAgentComplete(cancelled, run.headers, [200]),
            webhooks.requestAgentComplete(cancelled, run.headers, [200]),
          ]);
          expect(completed.body).toMatchObject({
            success: true,
            status: "failed",
          });
          expect(repeated.body).toStrictEqual(completed.body);
          await flushWaitUntilForTest();
          const stillRejected = await webhooks.requestAgentComplete(
            lateSuccess,
            run.headers,
            [400],
          );
          expect(stillRejected.body).toStrictEqual(rejected[0]?.body);
          await expect(cancellation(run, first)).resolves.toMatchObject({
            state: "present",
            mode: "hard",
          });
          await webhooks.requestAgentStorageCommit(
            prepared,
            run.headers,
            [404],
          );
        } else {
          // A surviving user, not a resurrected deleted identity, observes HEAD.
          const output = await publish(run, `Surviving ${run.runId}.\n`);
          await completeMaintenance(run, output.versionId);
          expect(
            (
              await observeMemory(
                { ...first, ...run },
                `Surviving ${run.runId}.\n`,
              )
            ).memory.versionId,
          ).toBe(output.versionId);
        }
      }
      await extract(first, 0);
      await expectBlocked(first);
      await deleteOwner(type, target);
      await expectBlocked(first);
    },
  );

  const retainedCases = (
    ["user.deleted", "organization.deleted"] as const
  ).flatMap((type) => {
    return (["published", "no-diff"] as const).map((outcome) => {
      return { type, outcome };
    });
  });

  it.each(retainedCases)(
    "$type retains a committed $outcome receipt and original Runner replay",
    async ({ type, outcome }) => {
      const run = await prepareMaintenance();
      const content =
        outcome === "published"
          ? "Committed memory survives deletion.\n"
          : undefined;
      const committed = await publish(run, content);
      const observation = await observeMemory(run, content, 1);
      expect(observation.memory.versionId).toBe(committed.versionId);
      const archiveUrl = observation.memory.archiveUrl;
      // This grant was delivered to a genuine Runner BEFORE deletion. Reusing
      // it observes retained bytes without authenticating the deleted user.
      let before: Uint8Array | undefined;
      if (content !== undefined) {
        if (!archiveUrl) {
          throw new Error("Expected the committed memory download grant");
        }
        const response = await fetch(archiveUrl);
        expect(response.status).toBe(200);
        before = new Uint8Array(await response.arrayBuffer());
      }
      await deleteOwner(type, run.actor);
      await expect(cancellation(run, run)).resolves.toMatchObject({
        mode: "hard",
        state: "present",
      });
      const replay = await webhooks.requestAgentStorageCommit(
        committed,
        run.headers,
        [200],
      );
      expect(replay.body).toMatchObject({
        success: true,
        versionId: committed.versionId,
        fileCount: committed.files.length,
        deduplicated: true,
      });
      const late = await completeMaintenance(run, committed.versionId, true);
      expect(late.response.body).toMatchObject({
        success: true,
        status: "failed",
      });
      const afterCompletion = await webhooks.requestAgentStorageCommit(
        committed,
        run.headers,
        [200],
      );
      expect(afterCompletion.body).toStrictEqual(replay.body);
      const replacement = publication(run, "Unauthorized late replacement.\n");
      await webhooks.requestAgentStoragePrepare(
        replacement,
        run.headers,
        [404],
      );
      await webhooks.requestAgentStorageCommit(replacement, run.headers, [404]);
      if (archiveUrl && before) {
        const response = await fetch(archiveUrl);
        expect(response.status).toBe(200);
        expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(
          before,
        );
      }
      await extract(run, 0);
      await expectBlocked(run);
      // Run history remains readable by its original Runner credential even
      // after both the late completion and receipt replay.
      await expect(cancellation(run, run)).resolves.toMatchObject({
        mode: "hard",
        state: "present",
      });
    },
  );
});
