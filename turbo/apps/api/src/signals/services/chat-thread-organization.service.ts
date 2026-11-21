import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { eq, sql, type SQL, type Column, type SQLWrapper } from "drizzle-orm";

export function chatThreadOrganizationCondition(orgId: string): SQL {
  return chatThreadOrganizationPredicate(orgId);
}

export function chatThreadOrganizationPredicate(orgId: string): SQL {
  return eq(chatThreads.orgId, orgId);
}

/** Read-only presentation field for clients released before member-owned threads. */
export function legacyThreadAgentId(stored: SQLWrapper, orgId: Column) {
  return sql`coalesce(${stored}, (select ${orgMetadata.defaultAgentId} from ${orgMetadata} where ${orgMetadata.orgId} = ${orgId.table}.${sql.identifier(orgId.name)}))`.mapWith(
    orgMetadata.defaultAgentId,
  );
}
