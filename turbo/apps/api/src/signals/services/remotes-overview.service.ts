import { orgMembersMetadata } from "@okouai/db/runtime/org-members-metadata";
import { computed, type Computed } from "ccstate";
import { and, eq } from "drizzle-orm";

import { db$ } from "../external/db";

/** Read only the member preference needed by the remotes overview. */
export function remotesOverviewPreference(
  owner$: Computed<{ readonly orgId: string; readonly userId: string }>,
) {
  return computed(async (get): Promise<boolean> => {
    const owner = get(owner$);
    const [member] = await get(db$)
      .select({
        cloudBrowserEnabledByDefault:
          orgMembersMetadata.cloudBrowserEnabledByDefault,
      })
      .from(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, owner.orgId),
          eq(orgMembersMetadata.userId, owner.userId),
        ),
      )
      .limit(1);
    // Match standalone thread creation for members without a preference row.
    return member?.cloudBrowserEnabledByDefault ?? true;
  });
}
