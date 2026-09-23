import { backgroundJobs } from "@okouai/db/schema/background-job";
import { and, eq } from "drizzle-orm";

import { db } from "../lib/db";

const kind = "clerk-user-deletion";

export async function clerkUserDeletionJobFixture(userId: string) {
  const [job] = await db()
    .select({
      id: backgroundJobs.id,
      status: backgroundJobs.status,
      failureCount: backgroundJobs.failureCount,
      checkpoint: backgroundJobs.checkpoint,
    })
    .from(backgroundJobs)
    .where(
      and(eq(backgroundJobs.kind, kind), eq(backgroundJobs.userId, userId)),
    );
  return job;
}

/** Advance only this test's failed job past its retry delay. */
export async function readyClerkUserDeletionJobFixture(
  userId: string,
): Promise<void> {
  const updated = await db()
    .update(backgroundJobs)
    .set({ availableAt: new Date(0) })
    .where(
      and(
        eq(backgroundJobs.kind, kind),
        eq(backgroundJobs.userId, userId),
        eq(backgroundJobs.status, "pending"),
      ),
    )
    .returning({ id: backgroundJobs.id });
  if (updated.length !== 1) {
    throw new Error("Expected one pending Clerk user deletion job");
  }
}
