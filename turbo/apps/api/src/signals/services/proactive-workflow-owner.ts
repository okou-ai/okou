import { and, eq, exists } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { orgMembersMetadata } from "@okouai/db/runtime/org-members-metadata";
import type { ProactiveWorkflowOwner } from "./proactive-workflows-eligibility.service";

/** Check the member’s saved choice in the statement admitting the schedule. */
export function proactiveWorkflowOwnerEnabledSql(
  owner: ProactiveWorkflowOwner,
) {
  return exists(
    new QueryBuilder()
      .select({ userId: orgMembersMetadata.userId })
      .from(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, owner.orgId),
          eq(orgMembersMetadata.userId, owner.userId),
          eq(orgMembersMetadata.proactiveSuggestionsEnabled, true),
        ),
      ),
  );
}
