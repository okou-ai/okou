import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { createClerkDeletionPiMemoryFixture } from "./helpers/clerk-deletion-pi-memory-fixture";

const context = testContext();
const {
  prepareMaintenance,
  publish,
  observeMemory,
  deleteOwner,
  cancellation,
  webhooks,
  completeMaintenance,
  publication,
  extract,
  expectBlocked,
} = createClerkDeletionPiMemoryFixture(context);

describe("Clerk deletion retains committed Pi memory publication", () => {
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
