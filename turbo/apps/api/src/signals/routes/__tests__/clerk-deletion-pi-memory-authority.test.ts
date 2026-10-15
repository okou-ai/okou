import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { createClerkDeletionPiMemoryFixture } from "./helpers/clerk-deletion-pi-memory-fixture";

const context = testContext();
const {
  prepareMaintenance,
  dispatch,
  preparePublication,
  deleteOwner,
  cancellation,
  webhooks,
  publish,
  completeMaintenance,
  observeMemory,
  extract,
  expectBlocked,
} = createClerkDeletionPiMemoryFixture(context);

describe("Clerk deletion revokes active Pi memory authority", () => {
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
      const pending = await Promise.all(
        active.map(async (run) => {
          const stopped =
            type === "user.deleted"
              ? run.actor.userId === target.userId
              : run.actor.orgId === target.orgId;
          // Rejected versions have real uploaded bytes before authority is lost.
          const prepared = stopped
            ? await preparePublication(run, `Uncommitted ${run.runId}.\n`)
            : null;
          return { run, stopped, prepared };
        }),
      );
      await deleteOwner(type, target);
      for (const { run, stopped, prepared } of pending) {
        await expect(cancellation(run, first)).resolves.toMatchObject({
          state: "present",
          mode: stopped ? "hard" : null,
        });
        if (stopped) {
          if (!prepared) {
            throw new Error(
              "Expected the Runner's pre-deletion upload receipt",
            );
          }
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
});
