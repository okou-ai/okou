import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { orgMembersMetadata } from "@okouai/db/runtime/org-members-metadata";
import { db$ } from "../external/db";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";

export interface ProactiveWorkflowOwner {
  readonly orgId: string;
  readonly userId: string;
}

export const loadProactivePreferences$ = command(
  async ({ get, set }, owner: ProactiveWorkflowOwner, signal: AbortSignal) => {
    const [features, [preference]] = await Promise.all([
      set(loadUserFeatureSwitchContext$, owner.orgId, owner.userId, signal),
      get(db$)
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
        .limit(1),
    ]);
    signal.throwIfAborted();
    const suggestionsAvailable = isFeatureEnabled(
      FeatureSwitchKey.AgentSuggestion,
      features,
    );
    const suggestionsEnabled = preference?.suggestionsEnabled ?? false;
    const timezone = preference?.timezone ?? null;
    return {
      suggestions: {
        available: suggestionsAvailable,
        enabled: suggestionsEnabled,
        active: suggestionsAvailable && suggestionsEnabled,
      },
      learning: {
        available: suggestionsAvailable,
        enabled: suggestionsEnabled,
        active: suggestionsAvailable && suggestionsEnabled && timezone !== null,
      },
      timezone,
    };
  },
);
