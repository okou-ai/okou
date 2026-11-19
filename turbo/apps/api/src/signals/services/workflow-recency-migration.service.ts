import { orgMembersMetadata } from "@okouai/db/runtime/org-members-metadata";
import { command } from "ccstate";
import { sql } from "drizzle-orm";
import { writeDb$ } from "../external/db";

/** The route supplies only authorized, unique ordinary workflow IDs, newest first. */
export const migrateWorkflowRecency$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly workflowIds: readonly string[];
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (args.workflowIds.length === 0) {
      return false;
    }
    const recentWorkflows = args.workflowIds.map((workflowId, index) => {
      return {
        workflowId,
        // Legacy IDs have no usage dates. Epoch microseconds are relative-order
        // markers only; every real accepted input timestamp outranks this import.
        lastUsedAt: `1970-01-01T00:00:00.${String(10 - index).padStart(6, "0")}Z`,
      };
    });
    const written = await set(writeDb$)
      .insert(orgMembersMetadata)
      .values({ orgId: args.orgId, userId: args.userId, recentWorkflows })
      .onConflictDoUpdate({
        target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
        set: { recentWorkflows },
        // The conflict winner, not a pre-read snapshot, decides whether to import.
        // Concurrent imports and accepted sends must never replace nonempty history.
        setWhere: sql`${orgMembersMetadata.recentWorkflows} = '[]'::jsonb`,
      })
      .returning({ userId: orgMembersMetadata.userId });
    signal.throwIfAborted();
    return written.length > 0;
  },
);
