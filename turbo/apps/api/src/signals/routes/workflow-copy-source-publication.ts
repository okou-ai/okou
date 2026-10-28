import { agents } from "@okouai/db/schema/agent";
import { officialWorkflowCatalogState } from "@okouai/db/schema/official-workflow-catalog";
import {
  workflows,
  workflowWebhookAutomations,
} from "@okouai/db/schema/workflow";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import {
  and,
  asc,
  count,
  eq,
  exists,
  inArray,
  sql,
  type SQL,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { pgTextDecoder } from "../../lib/db-structured-result";
import { copyRevisionQuery } from "./workflow-copy-source";
import type { WorkflowCopyPublicationArgs } from "./workflow-copy-publication-plans";

function after(name: string): SQL {
  return sql`(SELECT ${count()} FROM ${sql.identifier(name)}) >= 0`;
}

function copySourceLocks(args: WorkflowCopyPublicationArgs): SQL[] {
  const definitionName = args.sourceWorkflow.officialDefinitionName;
  const official = definitionName !== null;
  const query = new QueryBuilder();
  const catalog = official
    ? query
        .select({
          release_id: sql`${officialWorkflowCatalogState.acceptedReleaseId}`
            .mapWith(officialWorkflowCatalogState.acceptedReleaseId)
            .as("release_id"),
        })
        .from(officialWorkflowCatalogState)
        .where(eq(officialWorkflowCatalogState.authority, "official"))
        .for("share")
    : sql`SELECT NULL::text AS release_id`;
  const parents = query
    .select({
      id: agents.id,
      xmin: sql`${agents}.xmin::text`.mapWith(pgTextDecoder).as("xmin"),
    })
    .from(agents)
    .where(
      and(
        eq(agents.orgId, args.orgId),
        inArray(agents.id, [args.sourceWorkflow.agentId, args.targetAgentId]),
        after("copy_catalog_locked"),
      ),
    )
    .orderBy(asc(agents.id))
    .for("share");
  const source = query
    .select({
      id: workflows.id,
      xmin: sql`${workflows}.xmin::text`.mapWith(pgTextDecoder).as("xmin"),
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.id, args.sourceWorkflow.id),
        eq(workflows.orgId, args.orgId),
        eq(sql`${workflows}.xmin::text`, args.source.observation.workflowXmin),
        official ? eq(workflows.ownerUserId, args.userId) : undefined,
        definitionName === null
          ? undefined
          : eq(workflows.officialDefinitionName, definitionName),
        official
          ? eq(workflows.officialInstallationState, "installed")
          : undefined,
        after("copy_parents_locked"),
      ),
    )
    .for("update");
  const automations = query
    .select({
      id: workflowAutomations.id,
      xmin: sql`${workflowAutomations}.xmin::text`
        .mapWith(pgTextDecoder)
        .as("xmin"),
    })
    .from(workflowAutomations)
    .where(
      and(
        eq(workflowAutomations.orgId, args.orgId),
        eq(workflowAutomations.ownerUserId, args.userId),
        eq(workflowAutomations.workflowId, args.sourceWorkflow.id),
        after("copy_source_locked"),
      ),
    )
    .orderBy(
      asc(
        official
          ? workflowAutomations.officialBlueprintKey
          : workflowAutomations.id,
      ),
    )
    .for("update");
  const hooks = query
    .select({
      automation_id: workflowWebhookAutomations.automationId,
      encrypted_secret: workflowWebhookAutomations.encryptedSecret,
      secret_last_four: workflowWebhookAutomations.secretLastFour,
    })
    .from(workflowWebhookAutomations)
    .where(
      and(
        inArray(
          workflowWebhookAutomations.automationId,
          query.select({
            id: sql`copy_expected_automation.id`.mapWith(
              workflowAutomations.id,
            ),
          })
            .from(sql`jsonb_to_recordset(${JSON.stringify(args.source.observation.automations)}::jsonb)
              AS copy_expected_automation(id uuid, xmin text)`),
        ),
        after("copy_automations_locked"),
      ),
    )
    .orderBy(asc(workflowWebhookAutomations.automationId))
    .for("share");
  return [
    sql`copy_catalog_locked AS MATERIALIZED (${catalog})`,
    sql`copy_parents_locked AS MATERIALIZED (${parents})`,
    sql`copy_source_locked AS MATERIALIZED (${source})`,
    sql`copy_automations_locked AS MATERIALIZED (${automations})`,
    sql`copy_hooks_locked AS MATERIALIZED (${hooks})`,
  ];
}

function versionSetMatches(
  name: string,
  expected: readonly { readonly id: string; readonly xmin: string }[],
): SQL {
  return sql`(SELECT ${count()} FROM ${sql.identifier(name)}) = ${expected.length}
    AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(${JSON.stringify(expected)}::jsonb) AS expected(id uuid, xmin text)
      WHERE NOT EXISTS (SELECT 1 FROM ${sql.identifier(name)} AS actual WHERE actual.id = expected.id AND actual.xmin = expected.xmin))`;
}

/** Lock-returned xmin detects permission/source changes even after a row wait. */
export function copySourcePublicationClauses(
  args: WorkflowCopyPublicationArgs,
) {
  const observed = args.source.observation;
  const hooks = args.source.webhooks.map((row) => {
    return {
      automation_id: row.automationId,
      encrypted_secret: row.encryptedSecret,
      secret_last_four: row.secretLastFour,
    };
  });
  const definitionName = args.sourceWorkflow.officialDefinitionName;
  let revisionExists = sql`true`;
  if (definitionName !== null) {
    const revision = args.source.revision;
    if (revision === null) {
      throw new Error("Official copy revision observation is missing");
    }
    const read = copyRevisionQuery({ name: definitionName, revision });
    revisionExists = exists(
      new QueryBuilder()
        .select({ definitionName: read.definitionName })
        .from(read),
    );
  }
  const parentCount = new Set([args.sourceWorkflow.agentId, args.targetAgentId])
    .size;
  const valid = sql`${revisionExists} AND (SELECT ${count()} FROM copy_source_locked) = 1
    AND ${observed.parents.length === parentCount}
    AND (${versionSetMatches("copy_parents_locked", observed.parents)})
    AND (${versionSetMatches("copy_automations_locked", observed.automations)})
    AND (SELECT release_id FROM copy_catalog_locked) IS NOT DISTINCT FROM ${observed.acceptedReleaseId}
    AND (SELECT ${count()} FROM copy_hooks_locked) = ${hooks.length}
    AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(${JSON.stringify(hooks)}::jsonb)
      AS expected(automation_id uuid, encrypted_secret text, secret_last_four text)
      WHERE NOT EXISTS (SELECT 1 FROM copy_hooks_locked AS actual
        WHERE actual.automation_id = expected.automation_id AND actual.encrypted_secret = expected.encrypted_secret
          AND actual.secret_last_four = expected.secret_last_four))`;
  return [
    ...copySourceLocks(args),
    sql`copy_source_valid AS MATERIALIZED (SELECT true AS valid WHERE ${valid})`,
  ];
}
