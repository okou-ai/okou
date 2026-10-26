import { sql } from "drizzle-orm";
import type { ProactiveWorkflowKind } from "@okouai/api-contracts/contracts/proactive";
import type { ProactiveWorkflowOwner } from "./proactive-workflows-eligibility.service";

/** Saved intent and current Agent access are rechecked by the owning SQL write. */
export function proactiveWorkflowOwnerEnabledSql(
  owner: ProactiveWorkflowOwner,
  agentId: string,
  kind: ProactiveWorkflowKind,
  requirePreference = true,
) {
  const preference = {
    jobs: sql`preference.proactive_action_enabled = true`,
    suggestions: sql`preference.proactive_suggestions_enabled = true`,
    learning: sql`preference.proactive_learning_enabled = true`,
    planning: sql`preference.proactive_action_enabled = true`,
  }[kind];
  return sql`EXISTS (
    SELECT 1 FROM org_members_metadata AS preference
    JOIN org_metadata AS organization ON organization.org_id = preference.org_id
    JOIN agents AS primary_agent ON primary_agent.id = organization.default_agent_id AND primary_agent.org_id = organization.org_id
    WHERE preference.org_id = ${owner.orgId} AND preference.user_id = ${owner.userId}
      AND ${requirePreference ? preference : sql`true`} AND primary_agent.id = ${agentId}::uuid
      AND (primary_agent.visibility = 'public' OR primary_agent.owner = ${owner.userId})
  )`;
}
