import { privateHostedDeployments } from "@okouai/db/schema/hosted-site";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { nowDate } from "../lib/time";
import { writeDb$ } from "../signals/external/db";

/**
 * Completion contract from bc9b869293fd86c5d91f8104adc81f93ad4e94f4.
 * Before dependency indexing, completing a private deployment only wrote
 * status/readyAt; the manifest from prepare stayed unchanged. No current API
 * can create that historical ready-without-index state.
 */
export async function completeHostedSiteWithoutDependencyIndex(args: {
  readonly id: string;
  readonly userId: string;
  readonly orgId: string;
}): Promise<void> {
  await createStore()
    .set(writeDb$)
    .update(privateHostedDeployments)
    .set({ status: "ready", readyAt: nowDate() })
    .where(
      and(
        eq(privateHostedDeployments.id, args.id),
        eq(privateHostedDeployments.userId, args.userId),
        eq(privateHostedDeployments.orgId, args.orgId),
      ),
    );
}
