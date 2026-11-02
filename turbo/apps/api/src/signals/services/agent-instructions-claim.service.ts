import { and, eq, or, sql, type SQL } from "drizzle-orm";
import { agents } from "@okouai/db/schema/agent";

/** Select the authorized current reference in the same snapshot as the claim. */
export function agentInstructionsClaimSelectionSql(): SQL {
  return sql`selected_agent AS MATERIALIZED (
    SELECT ${agents.instructionsBundle} AS "instructionsBundle"
    FROM ${agents} CROSS JOIN locked_run
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
