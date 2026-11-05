import { and, eq, or, sql, type SQL } from "drizzle-orm";
import { instructions } from "@okouai/db/schema/instructions";
import { agents } from "@okouai/db/schema/agent";

/** Select the authorized current reference in the same snapshot as the claim. */
export function agentInstructionsClaimSelectionSql(): SQL {
  return sql`selected_agent AS MATERIALIZED (
    SELECT CASE WHEN locked_job."executionContext"->'featureFlags'->'singleAgent' = 'true'::jsonb
      THEN ${instructions.bundle} ELSE ${agents.instructionsBundle} END AS "instructionsBundle"
    FROM ${agents} CROSS JOIN locked_run CROSS JOIN locked_job
    LEFT JOIN ${instructions} ON ${and(eq(instructions.orgId, sql`locked_run."orgId"`), eq(instructions.userId, sql`locked_run."userId"`))}
    WHERE ${and(
      eq(agents.id, sql`locked_run."agentId"`),
      eq(agents.orgId, sql`locked_run."orgId"`),
      or(
        eq(agents.visibility, "public"),
        eq(agents.owner, sql`locked_run."userId"`),
      ),
    )}
  )`;
}
