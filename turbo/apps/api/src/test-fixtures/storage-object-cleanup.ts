import { randomUUID } from "node:crypto";

import { exportJobs } from "@okouai/db/schema/export-job";

import { db } from "../lib/db";
import { nowDate } from "../lib/time";

/** The current export endpoint cannot create a completed legacy one-call job.
 * This test-owned historical pointer exercises deletion without running an
 * unrelated full export or reaching into its tables from the route test. */
export async function seedLegacyExportCleanupReferenceFixture(
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly s3Key: string;
  },
  signal: AbortSignal,
): Promise<void> {
  await db()
    .insert(exportJobs)
    .values({
      id: randomUUID(),
      userId: args.userId,
      orgId: args.orgId,
      status: "completed",
      s3Key: args.s3Key,
      completedAt: nowDate(),
      expiresAt: new Date(nowDate().getTime() + 24 * 60 * 60_000),
    });
  signal.throwIfAborted();
}
