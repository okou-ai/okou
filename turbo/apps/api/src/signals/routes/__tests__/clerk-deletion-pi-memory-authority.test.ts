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
  const survivorCases = activeCases.filter(({ type, peerScope }) => {
    return type === "user.deleted"
      ? peerScope !== "same-user-other-org"
      : peerScope !== "same-org";
  });

  async function activeOwners(peerScope: (typeof scopes)[number]) {
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
    return { first, active, target: first.sourceActor.actor };
  }

  it.each(activeCases)(
    "$type revokes active uploads with $peerScope isolation",
    async ({ type, peerScope }) => {
      const { first, active, target } = await activeOwners(peerScope);
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
        }
      }
    },
  );

  it.each(survivorCases)(
    "$type preserves active publication with $peerScope isolation",
    async ({ type, peerScope }) => {
      const survivor = await prepareMaintenance({
        independentOwner: true,
        peerScope,
      });
      const target = [
        survivor.sourceActor.actor,
        survivor.peerActor?.actor,
      ].find((actor) => {
        return (
          actor &&
          (type === "user.deleted"
            ? actor.userId !== survivor.actor.userId
            : actor.orgId !== survivor.actor.orgId)
        );
      });
      if (!target) {
        throw new Error("Expected a genuinely independent deletion target");
      }
      await deleteOwner(type, target);
      await expect(cancellation(survivor, survivor)).resolves.toMatchObject({
        state: "present",
        mode: null,
      });
      // A surviving user, not a resurrected deleted identity, observes HEAD.
      const content = `Surviving ${survivor.runId}.\n`;
      const output = await publish(survivor, content);
      await completeMaintenance(survivor, output.versionId);
      expect((await observeMemory(survivor, content)).memory.versionId).toBe(
        output.versionId,
      );
    },
  );

  it.each(activeCases)(
    "$type consumes active selections with $peerScope isolation",
    async ({ type, peerScope }) => {
      const { first, active, target } = await activeOwners(peerScope);
      await deleteOwner(type, target);
      for (const run of active) {
        const stopped =
          type === "user.deleted"
            ? run.actor.userId === target.userId
            : run.actor.orgId === target.orgId;
        if (!stopped) {
          // Finish a changed-byte result before asserting no work. Its ordinary
          // Runner readback is the independent publication contract above.
          const output = await publish(run, `Surviving ${run.runId}.\n`);
          expect(output.versionId).not.toBe(run.memory.versionId);
          await completeMaintenance(run, output.versionId);
        }
      }
      await extract(first, 0);
      await expectBlocked(first);
      await deleteOwner(type, target);
      await expectBlocked(first);
    },
  );
});
