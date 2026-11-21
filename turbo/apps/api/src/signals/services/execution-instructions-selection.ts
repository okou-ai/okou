import { and, eq, sql } from "drizzle-orm";
import { instructions } from "@okouai/db/schema/instructions";
import { SINGLE_AGENT_SEED_INSTRUCTIONS_BUNDLE } from "@okouai/core/seed-instructions";

export interface ExecutionPackageScope {
  readonly orgId: string;
  readonly userId: string;
}

export function memberInstructionsSelectionSql(
  scope: Pick<ExecutionPackageScope, "orgId" | "userId">,
) {
  return sql`COALESCE(
    (SELECT ${instructions.bundle} FROM ${instructions}
      WHERE ${and(eq(instructions.orgId, scope.orgId), eq(instructions.userId, scope.userId))}),
    ${JSON.stringify(SINGLE_AGENT_SEED_INSTRUCTIONS_BUNDLE)}::jsonb
  )`;
}
