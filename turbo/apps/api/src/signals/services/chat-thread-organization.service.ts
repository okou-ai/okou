import { agents } from "@okouai/db/schema/agent";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { and, eq, exists, type SQL } from "drizzle-orm";

import { QueryBuilder } from "drizzle-orm/pg-core";

/** Restrict the current chat_threads row to an agent in the requested org. */
export function chatThreadOrganizationCondition(orgId: string): SQL {
  return chatThreadOrganizationPredicate(orgId);
}

export function chatThreadOrganizationPredicate(orgId: string): SQL {
  return exists(
    new QueryBuilder()
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, chatThreads.agentId), eq(agents.orgId, orgId))),
  );
}
