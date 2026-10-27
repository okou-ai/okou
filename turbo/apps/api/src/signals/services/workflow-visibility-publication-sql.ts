import { agents } from "@okouai/db/schema/agent";
import {
  storagePublicationGenerations,
  storagePublicationTokens,
} from "@okouai/db/schema/storage-publication-fence";
import { workflows } from "@okouai/db/schema/workflow";
import {
  and,
  count,
  eq,
  exists,
  isNull,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { PgDialect, QueryBuilder } from "drizzle-orm/pg-core";
import {
  generationScopeCondition,
  lockPublicationScopeSql,
  publicationGenerationValues,
  publicationKeyCondition,
  workflowPublicationKey,
} from "./storage-publication-fence.service";

export interface WorkflowVisibilityPublicationArgs {
  readonly workflow: Pick<
    typeof workflows.$inferSelect,
    | "id"
    | "orgId"
    | "agentId"
    | "ownerUserId"
    | "name"
    | "officialDefinitionName"
    | "visibility"
  >;
  readonly updatedByUserId: string;
  readonly visibility: "public" | "private";
}

export const workflowVisibilityGenerationChanged =
  "__TX0046_V1_GENERATION_CHANGED__";
type GenerationScope = ReturnType<typeof publicationGenerationValues>[number];

function workflowCondition(args: WorkflowVisibilityPublicationArgs) {
  const workflow = args.workflow;
  return and(
    eq(workflows.id, workflow.id),
    eq(workflows.orgId, workflow.orgId),
    eq(workflows.agentId, workflow.agentId),
    eq(workflows.ownerUserId, workflow.ownerUserId),
    eq(workflows.visibility, workflow.visibility),
    isNull(workflows.officialDefinitionName),
  );
}

function scopeCondition(scope: GenerationScope): SQL {
  return sql`org_id = ${scope.orgId} AND agent_id = ${scope.agentId}::uuid AND subject = ${scope.subject}`;
}

function fenceScope(scope: GenerationScope) {
  return {
    orgId: scope.orgId,
    agentId: scope.agentId,
    userId: scope.subject === "@agent" ? undefined : scope.subject,
  };
}

function initialGenerationSql(scopes: readonly GenerationScope[]): SQL {
  return sql`INSERT INTO ${storagePublicationGenerations} (org_id, agent_id, subject)
    SELECT scope.org_id, scope.agent_id::uuid, scope.subject
    FROM visibility_workflow CROSS JOIN (VALUES ${sql.join(
      scopes.map((scope) => {
        return sql`(${scope.orgId}, ${scope.agentId}, ${scope.subject})`;
      }),
      sql`, `,
    )}) AS scope(org_id, agent_id, subject)
    ON CONFLICT (org_id, agent_id, subject) DO NOTHING
    RETURNING org_id, agent_id, subject, generation`;
}

function scopePublicationClauses(
  scope: GenerationScope,
  index: number,
  key: string,
  at: Date,
  previous?: string,
) {
  const lockName = "visibility_generation_locked_" + index;
  const retireName = "visibility_tokens_retired_" + index;
  const after = previous
    ? sql`AND (SELECT ${count()} FROM ${sql.identifier(previous)}) >= 0`
    : sql.empty();
  const lock = sql`${sql.identifier(lockName)} AS (
    ${lockPublicationScopeSql(fenceScope(scope), at)}
      AND EXISTS (SELECT 1 FROM visibility_changed)
      AND ${storagePublicationGenerations.generation} = (
        SELECT generation FROM visibility_generation_before WHERE ${scopeCondition(scope)}
      ) ${after}
    RETURNING generation
  )`;
  const retire = sql`${sql.identifier(retireName)} AS (
    DELETE FROM ${storagePublicationTokens}
    WHERE ${publicationKeyCondition(fenceScope(scope), key)}
      AND (EXISTS (SELECT 1 FROM visibility_generation_before WHERE ${scopeCondition(scope)})
        OR EXISTS (SELECT 1 FROM visibility_generation_created WHERE ${scopeCondition(scope)}))
      AND EXISTS (SELECT 1 FROM visibility_changed)
      AND (SELECT ${count()} FROM ${sql.identifier(lockName)}) >= 0
    RETURNING org_id
  )`;
  return {
    clauses: [lock, retire],
    retireName,
    qualified: sql`EXISTS (SELECT 1 FROM visibility_generation_created WHERE ${scopeCondition(scope)})
      OR EXISTS (SELECT 1 FROM ${sql.identifier(lockName)})`,
  };
}

/** Existing generation writes reject a reservation invisible to this snapshot. */
export function workflowVisibilityPublicationSql(
  args: WorkflowVisibilityPublicationArgs,
  at: Date,
): SQL {
  const { workflow } = args;
  const query = new QueryBuilder();
  const agent = query
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(eq(agents.id, workflow.agentId), eq(agents.orgId, workflow.orgId)),
    )
    .for("key share")
    .limit(1)
    .getSQL();
  const retained = query
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(
        workflowCondition(args),
        exists(sql`(SELECT 1 FROM visibility_agent)`),
      ),
    )
    .for("update")
    .limit(1)
    .getSQL();
  const scopes = publicationGenerationValues([
    { orgId: workflow.orgId, agentId: workflow.agentId },
    {
      orgId: workflow.orgId,
      agentId: workflow.agentId,
      userId: workflow.ownerUserId,
    },
  ]);
  const before = query
    .select()
    .from(storagePublicationGenerations)
    .where(
      and(
        or(
          ...scopes.map((scope) => {
            return generationScopeCondition(fenceScope(scope));
          }),
        ),
        exists(sql`(SELECT 1 FROM visibility_workflow)`),
      ),
    )
    .getSQL();
  const key = workflowPublicationKey(workflow.id);
  const currentScope = {
    orgId: workflow.orgId,
    agentId: workflow.agentId,
    userId: workflow.visibility === "public" ? undefined : workflow.ownerUserId,
  };
  const pending = sql`SELECT 1 FROM ${storagePublicationTokens}
    WHERE ${publicationKeyCondition(currentScope, key)}
      AND EXISTS (
        SELECT 1 FROM (
          SELECT org_id, agent_id, subject FROM visibility_generation_before
          UNION ALL SELECT org_id, agent_id, subject FROM visibility_generation_created
        ) AS scope WHERE scope.org_id = ${storagePublicationTokens.orgId}
          AND scope.agent_id = ${storagePublicationTokens.agentId}
          AND scope.subject = ${storagePublicationTokens.subject}
      )`;
  const changed = new PgDialect().buildUpdateQuery({
    table: workflows,
    set: {
      visibility: sql.param(args.visibility, workflows.visibility),
      updatedBy: sql.param(args.updatedByUserId, workflows.updatedBy),
      updatedAt: sql.param(at, workflows.updatedAt),
    },
    joins: [],
    where: and(
      workflowCondition(args),
      exists(sql`(SELECT 1 FROM visibility_workflow)`),
      notExists(sql`(${pending})`),
    ),
    returning: [{ path: ["id"], field: workflows.id }],
  });
  const clauses: SQL[] = [];
  const qualifications: SQL[] = [];
  let previous: string | undefined;
  for (const [index, scope] of scopes.entries()) {
    const publication = scopePublicationClauses(
      scope,
      index,
      key,
      at,
      previous,
    );
    clauses.push(...publication.clauses);
    qualifications.push(sql`(${publication.qualified})`);
    previous = publication.retireName;
  }
  return sql`WITH visibility_agent AS (${agent}),
    visibility_workflow AS (${retained}),
    visibility_generation_before AS MATERIALIZED (${before}),
    visibility_generation_created AS (${initialGenerationSql(scopes)}),
    visibility_changed AS (${changed}),
    ${sql.join(clauses, sql`,\n`)}
    SELECT EXISTS (SELECT 1 FROM visibility_changed) AS changed,
      (CASE WHEN EXISTS (SELECT 1 FROM visibility_changed)
        AND NOT (${sql.join(qualifications, sql` AND `)})
        THEN ${workflowVisibilityGenerationChanged} ELSE '0' END)::integer AS guard`;
}
