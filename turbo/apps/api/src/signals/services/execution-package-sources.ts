import { BUILT_IN_SKILLS } from "@okouai/core/built-in-skills";
import { SINGLE_AGENT_SEED_INSTRUCTIONS_BUNDLE } from "@okouai/core/seed-instructions";
import { instructions } from "@okouai/db/schema/instructions";
import { workflows } from "@okouai/db/schema/workflow";
import { computed } from "ccstate";
import { and, eq, isNull, notInArray, or, sql } from "drizzle-orm";
import { array, object, string, unknown, uuid, type infer as Infer } from "zod";
import { parseRawRows } from "../../lib/db-raw-rows";
import { now } from "../../lib/time";
import { rawSqlReadDb$ } from "../external/db";
import { settle } from "../utils";

export interface ExecutionPackageScope {
  readonly orgId: string;
  readonly userId: string;
}

function memberInstructionsSelectionSql(scope: ExecutionPackageScope) {
  return sql`COALESCE(
    (SELECT ${instructions.bundle} FROM ${instructions}
      WHERE ${and(eq(instructions.orgId, scope.orgId), eq(instructions.userId, scope.userId))}),
    ${JSON.stringify(SINGLE_AGENT_SEED_INSTRUCTIONS_BUNDLE)}::jsonb
  )`;
}

export const executionPackageSourcesSchema = object({
  memberInstructions: unknown(),
  workflows: array(
    object({ id: uuid(), name: string(), contentBundle: unknown() }),
  ),
});
export type ExecutionPackageSources = Infer<
  typeof executionPackageSourcesSchema
>;

const packageSourcesRowSchema = object({
  packages: executionPackageSourcesSchema,
});

/** Prompt and Automation preparation use the same member package projection. */
export function executionPackageSourcesSql(scope: ExecutionPackageScope) {
  return sql`(
    WITH selected_workflows AS (
      SELECT DISTINCT ON (${workflows.name}) ${workflows.id} AS id,
        ${workflows.name} AS name, ${workflows.contentBundle} AS "contentBundle"
      FROM ${workflows}
      WHERE ${and(
        eq(workflows.orgId, scope.orgId),
        isNull(workflows.officialDefinitionName),
        or(
          eq(workflows.visibility, "public"),
          eq(workflows.ownerUserId, scope.userId),
        ),
        notInArray(workflows.name, [...BUILT_IN_SKILLS]),
      )}
      ORDER BY ${workflows.name},
        (${workflows.visibility} = 'private' AND ${workflows.ownerUserId} = ${scope.userId}) DESC,
        ${workflows.createdAt}, ${workflows.id}
    )
    SELECT jsonb_build_object(
      'memberInstructions', ${memberInstructionsSelectionSql(scope)},
      'workflows', (SELECT COALESCE(jsonb_agg(to_jsonb(selected_workflows) ORDER BY name), '[]'::jsonb)
        FROM selected_workflows)
    )
  )`;
}

export function createExecutionPackageSources(scope: ExecutionPackageScope) {
  return computed(async (get) => {
    const db = get(rawSqlReadDb$);
    const statement = sql`SELECT ${executionPackageSourcesSql(scope)} AS packages`;
    const startedAt = performance.now();
    const result = await settle(
      (async () => {
        const [row] = parseRawRows(
          packageSourcesRowSchema,
          await db.execute(statement),
        );
        return row?.packages ?? null;
      })(),
    );
    return {
      result,
      durationMs: performance.now() - startedAt,
      finishedAt: now(),
    };
  });
}
