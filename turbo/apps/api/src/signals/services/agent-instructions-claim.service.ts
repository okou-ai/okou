import { and, eq, or, sql, type SQL } from "drizzle-orm";
import { instructions } from "@okouai/db/schema/instructions";
import { agents } from "@okouai/db/schema/agent";
import { SINGLE_AGENT_SEED_INSTRUCTIONS_BUNDLE } from "@okouai/core/seed-instructions";

/**
 * Select the authorized current reference in the same snapshot as the claim.
 * Members without a saved row use the default until their first save.
 */
export function agentInstructionsClaimSelectionSql(): SQL {
  return agentInstructionsSelectionSql(
    sql`(SELECT "executionContext"->'featureFlags'->'singleAgent' = 'true'::jsonb FROM locked_job)`,
  );
}

/** Select the same authorized source from a captured live admission receipt. */
export function agentInstructionsSelectionSql(singleAgent: SQL): SQL {
  return sql`selected_agent AS MATERIALIZED (
    SELECT CASE WHEN ${singleAgent}
      THEN COALESCE(${instructions.bundle}, ${JSON.stringify(SINGLE_AGENT_SEED_INSTRUCTIONS_BUNDLE)}::jsonb)
      ELSE ${agents.instructionsBundle} END AS "instructionsBundle"
    FROM ${agents} CROSS JOIN locked_run
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
