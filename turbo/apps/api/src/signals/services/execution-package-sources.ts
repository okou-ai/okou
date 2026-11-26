import { BUILT_IN_SKILLS } from "@okouai/core/built-in-skills";
import { resolveSkillRef } from "@okouai/core/github-url";
import { SINGLE_AGENT_SEED_INSTRUCTIONS_BUNDLE } from "@okouai/core/seed-instructions";
import { builtInSkills } from "@okouai/db/schema/built-in-skill";
import { instructions } from "@okouai/db/schema/instructions";
import { workflows } from "@okouai/db/schema/workflow";
import { computed } from "ccstate";
import { and, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import { array, object, string, unknown, uuid, type infer as Infer } from "zod";
import { parseRawRows } from "../../lib/db-raw-rows";
import { now } from "../../lib/time";
import { rawSqlReadDb$ } from "../external/db";
import { settle } from "../utils";
import {
  cachedContentBundleUrlSchema,
  contentBundleUrlCacheContext$,
  prefetchedContentBundleUrlsSql,
  type PrefetchedContentBundleUrls,
} from "./content-bundle-presigned-url-cache";

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
  seedSkills: array(object({ url: string(), contentBundle: unknown() })),
  workflows: array(
    object({ id: uuid(), name: string(), contentBundle: unknown() }),
  ),
});
export type ExecutionPackageSources = Infer<
  typeof executionPackageSourcesSchema
>;

const packageSourcesRowSchema = object({
  packages: executionPackageSourcesSchema,
  bundleHashes: array(string()),
  cachedBundleUrls: array(cachedContentBundleUrlSchema),
});

export interface ExecutionPackageObservation {
  readonly sources: ExecutionPackageSources;
  readonly prefetchedUrls: PrefetchedContentBundleUrls | null;
}

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
      'seedSkills', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'url', ${builtInSkills.url}, 'contentBundle', ${builtInSkills.contentBundle}
      )), '[]'::jsonb)
        FROM ${builtInSkills}
        WHERE ${inArray(builtInSkills.url, BUILT_IN_SKILLS.map(resolveSkillRef))}),
      'workflows', (SELECT COALESCE(jsonb_agg(to_jsonb(selected_workflows) ORDER BY name), '[]'::jsonb)
        FROM selected_workflows)
    )
  )`;
}

export function createExecutionPackageSources(scope: ExecutionPackageScope) {
  return computed(async (get) => {
    const db = get(rawSqlReadDb$);
    const cache = get(contentBundleUrlCacheContext$);
    const statement = sql`
      WITH package_sources AS MATERIALIZED (
        SELECT ${executionPackageSourcesSql(scope)} AS packages
      ), bundle_hashes AS (
        SELECT packages->'memberInstructions'->>'sha256' AS sha256
        FROM package_sources
        UNION
        SELECT workflow->'contentBundle'->>'sha256' AS sha256
        FROM package_sources, jsonb_array_elements(packages->'workflows') AS workflow
        UNION
        SELECT skill->'contentBundle'->>'sha256' AS sha256
        FROM package_sources, jsonb_array_elements(packages->'seedSkills') AS skill
      ), covered_hashes AS (
        SELECT sha256 FROM bundle_hashes WHERE sha256 ~ '^[a-f0-9]{64}$'
      )
      SELECT packages,
        ARRAY(SELECT sha256 FROM covered_hashes) AS "bundleHashes",
        ${prefetchedContentBundleUrlsSql(cache, sql`SELECT sha256 FROM covered_hashes`)} AS "cachedBundleUrls"
      FROM package_sources`;
    const startedAt = performance.now();
    const result = await settle(
      (async (): Promise<ExecutionPackageObservation> => {
        const [row] = parseRawRows(
          packageSourcesRowSchema,
          await db.execute(statement),
        );
        if (!row) {
          throw new Error("Execution package query returned no row");
        }
        return {
          sources: row.packages,
          prefetchedUrls: {
            hashes: row.bundleHashes,
            rows: row.cachedBundleUrls,
          },
        };
      })(),
    );
    return {
      result,
      durationMs: performance.now() - startedAt,
      finishedAt: now(),
    };
  });
}
