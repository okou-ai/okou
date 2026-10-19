import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import {
  createClerkDeletionPiMemoryFixture,
  type Deletion,
} from "./helpers/clerk-deletion-pi-memory-fixture";

const context = testContext();
// Billing is outside this source-isolation contract; use normal onboarding.
const {
  publish,
  completeMaintenance,
  observeMemory,
  prepareSources,
  cronHeaders,
  extract,
  expectBlocked,
  deleteOwner,
  extractIndependentOwnerAfterDeletion,
} = createClerkDeletionPiMemoryFixture(context, "limited-free");

// Extraction/consolidation use real CRON_SECRET auth and case-owned DB.
// Sources come from ordinary chat/native history; deletion uses Clerk ingress.
describe("Clerk deletion consumes Pi memory sources", () => {
  it.each<Deletion>(["user.deleted", "organization.deleted"])(
    "%s consumes an unextracted day and keeps deletion replay blocked",
    async (type) => {
      const source = await prepareSources();
      await deleteOwner(type, source.actor);
      const extracted = await accept(
        source.stage1.extract({ headers: cronHeaders() }),
        [200],
      );
      expect(extracted.body).toMatchObject({
        success: true,
        succeeded: 0,
        terminalFailure: 0,
        retryableFailure: 0,
      });
      await expectBlocked(source);
      await deleteOwner(type, source.actor);
      await extract(source, 0);
      await expectBlocked(source);
    },
  );

  it.each<Deletion>(["user.deleted", "organization.deleted"])(
    "%s preserves publication from an independent owner's extraction",
    async (type) => {
      const { source, independent } =
        await extractIndependentOwnerAfterDeletion(type);
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
    },
  );
});
