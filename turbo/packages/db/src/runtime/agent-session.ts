import { pgTable } from "drizzle-orm/pg-core";
import { agentSessionColumns } from "../columns/agent-session";
import { resolveAgentConversationId } from "../schema/agent-run-reference";

export const agentSessions = pgTable(
  "agent_sessions",
  agentSessionColumns(resolveAgentConversationId),
);
