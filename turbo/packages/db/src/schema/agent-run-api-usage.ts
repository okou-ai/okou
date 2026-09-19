import { sql } from "drizzle-orm";
import {
  check,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import type { AgentRunApiUsageProjection } from "../jsonb-contracts/agent-run-api-usage";
import { agentRuns } from "./agent-run-session-conversation";

export const agentRunApiUsage = pgTable(
  "agent_run_api_usage",
  {
    runId: uuid("run_id")
      .primaryKey()
      .references(
        () => {
          return agentRuns.id;
        },
        { onDelete: "cascade" },
      ),
    revision: integer("revision").notNull(),
    projection: jsonb("projection")
      .$type<AgentRunApiUsageProjection>()
      .notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (t) => {
    return [
      check("agent_run_api_usage_revision_check", sql`${t.revision} >= 1`),
      check(
        "agent_run_api_usage_projection_check",
        sql`jsonb_typeof(${t.projection}) = 'object' AND ${t.projection}->'schemaVersion' = '1'::jsonb AND jsonb_typeof(${t.projection}->'attempts') = 'array' AND jsonb_array_length(${t.projection}->'attempts') <= 8`,
      ),
      check(
        "agent_run_api_usage_size_check",
        sql`octet_length(${t.projection}::text) <= 32768`,
      ),
    ];
  },
);
