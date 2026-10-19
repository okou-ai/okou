import { command } from "ccstate";
import { and, eq, or } from "drizzle-orm";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { agents } from "@okouai/db/schema/agent";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { db$ } from "../external/db";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";

export interface ProactiveSuggestionsOwner {
  readonly orgId: string;
  readonly userId: string;
}

export const loadProactiveSuggestionsEligibility$ = command(
  async (
    { get, set },
    owner: ProactiveSuggestionsOwner,
    signal: AbortSignal,
  ) => {
    const [features, [preference], [agent]] = await Promise.all([
      set(loadUserFeatureSwitchContext$, owner.orgId, owner.userId, signal),
      get(db$)
        .select({ enabled: orgMembersMetadata.proactiveSuggestionsEnabled })
        .from(orgMembersMetadata)
        .where(
          and(
            eq(orgMembersMetadata.orgId, owner.orgId),
            eq(orgMembersMetadata.userId, owner.userId),
          ),
        )
        .limit(1),
      get(db$)
        .select({ id: agents.id })
        .from(orgMetadata)
        .innerJoin(
          agents,
          and(
            eq(agents.id, orgMetadata.defaultAgentId),
            eq(agents.orgId, orgMetadata.orgId),
          ),
        )
        .where(
          and(
            eq(orgMetadata.orgId, owner.orgId),
            or(eq(agents.visibility, "public"), eq(agents.owner, owner.userId)),
          ),
        )
        .limit(1),
    ]);
    signal.throwIfAborted();
    return {
      available: isFeatureEnabled(FeatureSwitchKey.AgentSuggestion, features),
      enabled: preference?.enabled ?? false,
      agentId: agent?.id ?? null,
    };
  },
);
