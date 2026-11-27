import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { orgMembersMetadata } from "@okouai/db/runtime/org-members-metadata";
import { db$ } from "../external/db";

export interface ProactiveScheduleOwner {
  readonly orgId: string;
  readonly userId: string;
}

export const loadProactivePreferences$ = command(
  async ({ get }, owner: ProactiveScheduleOwner, signal: AbortSignal) => {
    const [preference] = await get(db$)
      .select({
        suggestionsEnabled: orgMembersMetadata.proactiveSuggestionsEnabled,
        timezone: orgMembersMetadata.timezone,
      })
      .from(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, owner.orgId),
          eq(orgMembersMetadata.userId, owner.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    const suggestionsEnabled = preference?.suggestionsEnabled ?? false;
    const timezone = preference?.timezone ?? null;
    return {
      suggestions: suggestionsEnabled,
      timezone,
    };
  },
);
