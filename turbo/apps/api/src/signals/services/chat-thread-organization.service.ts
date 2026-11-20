import { agents } from "@okouai/db/schema/agent";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { eq, sql, type SQL } from "drizzle-orm";

import { QueryBuilder } from "drizzle-orm/pg-core";

/** Restrict the current chat_threads row to the requested workspace. */
export function chatThreadOrganizationCondition(orgId: string): SQL {
  return chatThreadOrganizationPredicate(orgId);
}

export function chatThreadOrganizationPredicate(orgId: string): SQL {
  // A serving or rollback API from before the expansion can omit org_id.
  const legacyOrganization = new QueryBuilder()
    .select({ orgId: agents.orgId })
    .from(agents)
    .where(eq(agents.id, chatThreads.agentId));
  return sql`COALESCE(${chatThreads.orgId}, (${legacyOrganization})) = ${orgId}`;
}
