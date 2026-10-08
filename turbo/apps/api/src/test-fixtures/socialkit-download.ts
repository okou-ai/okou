import { socialKitDownloadJobs } from "@okouai/db/schema/socialkit-download-job";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

import { writeDb$ } from "../signals/external/db";

/** Teardown only, after owned operations and public organization cleanup join. */
export async function deleteSocialKitDownloadJobsForOwner(owner: {
  readonly orgId: string;
  readonly userId: string;
}): Promise<void> {
  await createStore()
    .set(writeDb$)
    .delete(socialKitDownloadJobs)
    .where(
      and(
        eq(socialKitDownloadJobs.orgId, owner.orgId),
        eq(socialKitDownloadJobs.userId, owner.userId),
      ),
    );
}
