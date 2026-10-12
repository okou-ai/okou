import { pgTable } from "drizzle-orm/pg-core";
import { agentSessionColumns } from "../columns/agent-session";
import { resolveAgentConversationId } from "../schema/agent-run-reference";

// The physical column/default remain until this API is deployed, preceding SQL
// consumers drain and rollback excludes them. Contraction is tracked in #39310.
export const agentSessions = pgTable(
  "agent_sessions",
  agentSessionColumns(resolveAgentConversationId),
);
