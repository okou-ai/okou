import { and, eq, or, sql } from "drizzle-orm";
import { instructions } from "@okouai/db/schema/instructions";
import { agents } from "@okouai/db/schema/agent";
import { SINGLE_AGENT_SEED_INSTRUCTIONS_BUNDLE } from "@okouai/core/seed-instructions";

export interface ExecutionPackageScope {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
}

export function agentInstructionsSelectionSql(scope: ExecutionPackageScope) {
  return sql`selected_agent AS (
    SELECT ${agents.instructionsBundle} AS "agentInstructions",
      COALESCE(${instructions.bundle},
        ${JSON.stringify(SINGLE_AGENT_SEED_INSTRUCTIONS_BUNDLE)}::jsonb) AS "memberInstructions"
    FROM ${agents}
    LEFT JOIN ${instructions}
      ON ${and(eq(instructions.orgId, scope.orgId), eq(instructions.userId, scope.userId))}
    WHERE ${and(
      eq(agents.id, scope.agentId),
      eq(agents.orgId, scope.orgId),
      or(eq(agents.visibility, "public"), eq(agents.owner, scope.userId)),
    )}
  )`;
}
