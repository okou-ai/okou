import { pgTable } from "drizzle-orm/pg-core";
import { agentRunColumns } from "../columns/agent-run";

/** Application mapping. Omits migration-only compatibility storage and DDL declarations. */
export const agentRuns = pgTable("agent_runs", agentRunColumns());
