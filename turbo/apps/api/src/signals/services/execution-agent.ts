import { agents } from "@okouai/db/schema/agent";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";
import { and, asc, desc, eq, or, sql, type SQLWrapper } from "drizzle-orm";
import { nullableDriverValueDecoder } from "../../lib/db-structured-result";
import { DEFAULT_AGENT_NAME } from "./default-agent-profile";

const executor = alias(agents, "execution_agent");

/** Member-owned execution configuration takes precedence over the shared bootstrap profile. */
function executionAgentQuery(
  orgId: string | SQLWrapper,
  userId?: string | SQLWrapper,
) {
  const owned = userId === undefined ? undefined : eq(executor.owner, userId);
  const shared = and(
    eq(executor.visibility, "public"),
    eq(executor.name, DEFAULT_AGENT_NAME),
  );
  return new QueryBuilder()
    .select({ id: executor.id })
    .from(executor)
    .where(and(eq(executor.orgId, orgId), or(owned, shared)))
    .orderBy(
      ...(owned ? [desc(owned)] : []),
      asc(executor.createdAt),
      asc(executor.id),
    )
    .limit(1);
}

export function executionAgentId(
  orgId: string | SQLWrapper,
  userId?: string | SQLWrapper,
) {
  return sql`(${executionAgentQuery(orgId, userId)})`.mapWith(
    nullableDriverValueDecoder(agents.id),
  );
}

export function selectedExecutionAgent(orgId: string, userId: string) {
  return executionAgentQuery(orgId, userId).as("selected_execution_agent");
}
