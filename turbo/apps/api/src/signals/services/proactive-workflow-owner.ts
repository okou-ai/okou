import { executionAgentId } from "./execution-agent";
import { and, eq, exists, or, type SQL } from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";
import { orgMembersMetadata } from "@okouai/db/runtime/org-members-metadata";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { agents } from "@okouai/db/schema/agent";
import type { ProactiveWorkflowOwner } from "./proactive-workflows-eligibility.service";

export function proactiveWorkflowOwnerPreferenceQuery(
  owner: ProactiveWorkflowOwner,
  agentId: string,
  options?: {
    readonly prerequisite?: SQL;
    readonly requirePreference?: boolean;
  },
) {
  const preference = alias(orgMembersMetadata, "proactive_owner_preference");
  const organization = alias(orgMetadata, "proactive_owner_org");
  const agent = alias(agents, "proactive_owner_agent");
  return new QueryBuilder()
    .select({
      memberUserId: preference.userId,
      suggestionsEnabled: preference.proactiveSuggestionsEnabled,
    })
    .from(preference)
    .innerJoin(organization, eq(organization.orgId, preference.orgId))
    .innerJoin(
      agent,
      and(
        eq(agent.id, executionAgentId(organization.orgId, owner.userId)),
        eq(agent.orgId, organization.orgId),
      ),
    )
    .where(
      and(
        eq(preference.orgId, owner.orgId),
        eq(preference.userId, owner.userId),
        eq(agent.id, agentId),
        or(eq(agent.visibility, "public"), eq(agent.owner, owner.userId)),
        options?.prerequisite,
        options?.requirePreference
          ? eq(preference.proactiveSuggestionsEnabled, true)
          : undefined,
      ),
    );
}

/** Acquire saved preference and Agent authority together in the owning statement. */
export function proactiveWorkflowOwnerEnabledSql(
  owner: ProactiveWorkflowOwner,
  agentId: string,
) {
  return exists(
    proactiveWorkflowOwnerPreferenceQuery(owner, agentId, {
      requirePreference: true,
    }),
  );
}
