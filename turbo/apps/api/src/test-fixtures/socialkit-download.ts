/**
 * Historical JSONB fixture: current download endpoints cannot write the old
 * request/provider/artifact shapes without storage policy or media metadata. Only remove those additive
 * fields from an API-created job; tests observe recovery through the real API.
 */
import { socialKitDownloadJobs } from "@okouai/db/schema/socialkit-download-job";
import { createStore } from "ccstate";
import { eq, sql } from "drizzle-orm";

import { writeDb$ } from "../signals/external/db";

export async function restoreLegacyDownloadMetadataFixture(
  downloadId: string,
): Promise<void> {
  const rows = await createStore()
    .set(writeDb$)
    .update(socialKitDownloadJobs)
    .set({
      request: sql`${socialKitDownloadJobs.request} - 'privateArtifacts'`,
      providerResult: sql`${socialKitDownloadJobs.providerResult} - 'quality' - 'format'`,
      artifact: sql`${socialKitDownloadJobs.artifact} - 'format'`,
    })
    .where(eq(socialKitDownloadJobs.id, downloadId))
    .returning({ id: socialKitDownloadJobs.id });
  if (rows.length !== 1) {
    throw new Error("Expected one historical SocialKit download job");
  }
}
