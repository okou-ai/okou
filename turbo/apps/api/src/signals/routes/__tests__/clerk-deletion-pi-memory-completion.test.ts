import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { flushWaitUntilForTest } from "../../context/wait-until";
import {
  createClerkDeletionPiMemoryFixture,
  type Deletion,
} from "./helpers/clerk-deletion-pi-memory-fixture";

const context = testContext();
const {
  prepareMaintenance,
  preparePublication,
  deleteOwner,
  maintenanceCompletion,
  webhooks,
  cancellation,
  extract,
  expectBlocked,
} = createClerkDeletionPiMemoryFixture(context);

describe("Clerk deletion preserves terminal Pi memory completion", () => {
  it.each<Deletion>(["user.deleted", "organization.deleted"])(
    "%s keeps cancelled completion idempotent without accepting late publication",
    async (type) => {
      const run = await prepareMaintenance();
      const prepared = await preparePublication(run, "Uncommitted memory.\n");
      await deleteOwner(type, run.actor);
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
      // Failure completion carries no final output and cannot recover these bytes.
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
      await expect(cancellation(run, run)).resolves.toMatchObject({
        state: "present",
        mode: "hard",
      });
      await webhooks.requestAgentStorageCommit(prepared, run.headers, [404]);
      await extract(run, 0);
      await expectBlocked(run);
      await deleteOwner(type, run.actor);
      await expectBlocked(run);
    },
  );
});
