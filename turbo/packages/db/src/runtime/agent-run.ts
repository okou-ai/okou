import { pgTable } from "drizzle-orm/pg-core";
import { agentRunColumns } from "../columns/agent-run";

/** Application mapping. Shares the physical schema column factory; omits DDL declarations. */
export const agentRuns = pgTable("agent_runs", agentRunColumns());
