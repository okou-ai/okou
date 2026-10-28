import { connectors } from "@okouai/db/schema/connector";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { notionWorkflowPendingEvents } from "@okouai/db/schema/notion-event";
import { googleFormsAutomationCursors } from "@okouai/db/schema/google-forms-event";
import { and, count, eq, inArray, sql, type SQL } from "drizzle-orm";
import { PgDialect, QueryBuilder } from "drizzle-orm/pg-core";
import {
  pgTextDecoder,
  nullableDriverValueDecoder,
} from "../../lib/db-structured-result";
import { workflowAutomationConnectorSelectionSql } from "../services/workflow-automation-account.service";
import { googleFormsAccountProjectionUpdate } from "../services/google-forms-automation-account.service";
import type { WorkflowAutomationAccountConnectorSlug } from "../services/workflow-automation-account-classification.service";
import {
  copyAccountReadPlan,
  copyProjectionValues,
  copyNotionInvalidationValues,
  type WorkflowCopyPublicationArgs,
} from "./workflow-copy-publication-plans";
import { copyUpdateSql } from "./workflow-copy-write-sql";

type ProjectionRow = Parameters<typeof copyProjectionValues>[0] & {
  readonly observedXmin: string;
};
export interface CopyAccountSnapshot {
  readonly slug: WorkflowAutomationAccountConnectorSlug;
  readonly connectorId: string | null;
  readonly rows: readonly ProjectionRow[];
}

export function copiedAccountSelection(
  args: WorkflowCopyPublicationArgs,
  slug: WorkflowAutomationAccountConnectorSlug,
) {
  return {
    source: sql`(${workflowAutomationConnectorSelectionSql({ ...args, workflowId: args.targetWorkflowId, connectorSlug: slug })}) AS copy_account_selection`,
    columns: {
      connectorId: sql`copy_account_selection."connectorId"`.mapWith(
        nullableDriverValueDecoder(connectors.id),
      ),
    },
  };
}

function projectionChanges(snapshot: CopyAccountSnapshot) {
  return snapshot.rows.flatMap((row) => {
    const values = copyProjectionValues(row, snapshot.slug);
    if (!values) {
      return [];
    }
    return [
      {
        id: row.automation.id,
        xmin: row.observedXmin,
        connector_id: values.eventConnectorId,
        replace_config: "eventConfig" in values,
        event_config: "eventConfig" in values ? values.eventConfig : null,
      },
    ];
  });
}

/** The prepared projection cohort is checked against the publication snapshot. */
export function copyAccountReadClauses(
  args: WorkflowCopyPublicationArgs,
  snapshots: readonly CopyAccountSnapshot[],
) {
  const clauses: SQL[] = [];
  const checks: SQL[] = [];
  for (const [index, snapshot] of snapshots.entries()) {
    const name = sql.identifier("copy_account_" + index);
    const selection = copiedAccountSelection(args, snapshot.slug);
    clauses.push(
      sql`${name} AS MATERIALIZED (SELECT "connectorId" AS id FROM ${selection.source})`,
    );
    checks.push(
      sql`(SELECT id FROM ${name}) IS NOT DISTINCT FROM ${snapshot.connectorId}::uuid`,
    );
    if (snapshot.slug === "google-forms") {
      continue;
    }
    const plan = copyAccountReadPlan(args, snapshot.slug);
    const cohort = sql.identifier("copy_projection_cohort_" + index);
    const read = new QueryBuilder()
      .select({
        id: plan.source.id,
        xmin: sql`${plan.source.observedXmin}`
          .mapWith(pgTextDecoder)
          .as("xmin"),
        connector_id: sql`${plan.source.connectorId}`
          .mapWith(nullableDriverValueDecoder(connectors.id))
          .as("connector_id"),
      })
      .from(plan.source);
    clauses.push(sql`${cohort} AS MATERIALIZED (${read})`);
    const expected = snapshot.rows.map((row) => {
      return {
        id: row.automation.id,
        xmin: row.observedXmin,
        connector_id: row.connectorId,
      };
    });
    checks.push(sql`(SELECT ${count()} FROM ${cohort}) = ${expected.length}
      AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(${JSON.stringify(expected)}::jsonb) AS expected(id uuid, xmin text, connector_id uuid)
        WHERE NOT EXISTS (SELECT 1 FROM ${cohort} AS actual WHERE actual.id = expected.id
          AND actual.xmin = expected.xmin AND actual.connector_id IS NOT DISTINCT FROM expected.connector_id))`);
  }
  return { clauses, checks };
}

export function copyAccountWriteClauses(
  args: WorkflowCopyPublicationArgs,
  snapshots: readonly CopyAccountSnapshot[],
  eligible: SQL,
) {
  const clauses: SQL[] = [];
  const checks: SQL[] = [];
  let previous: string | undefined;
  for (const [index, snapshot] of snapshots.entries()) {
    const name = sql.identifier("copy_projected_" + index);
    const ordered =
      previous === undefined
        ? eligible
        : sql`${eligible} AND (SELECT ${count()} FROM ${sql.identifier(previous)}) >= 0`;
    if (snapshot.slug === "google-forms") {
      clauses.push(
        sql`${name} AS (${googleFormsAccountProjectionUpdate({ ...args, publicationCondition: ordered })})`,
      );
      clauses.push(
        sql`${sql.identifier("copy_cursors_discarded_" + index)} AS (${new PgDialect().buildDeleteQuery(
          {
            table: googleFormsAutomationCursors,
            where: inArray(
              googleFormsAutomationCursors.automationId,
              sql`(SELECT id FROM ${name})`,
            ),
            returning: [
              {
                path: ["id"],
                field: googleFormsAutomationCursors.automationId,
              },
            ],
          },
        )})`,
      );
      previous = "copy_cursors_discarded_" + index;
      checks.push(
        sql`(SELECT ${count()} FROM ${sql.identifier(previous)}) >= 0`,
      );
      continue;
    }
    const changes = projectionChanges(snapshot);
    const write = new PgDialect().buildUpdateQuery({
      table: workflowAutomations,
      set: {
        eventConnectorId: sql`expected.connector_id`,
        eventConfig: sql`CASE WHEN expected.replace_config THEN expected.event_config ELSE ${workflowAutomations.eventConfig} END`,
      },
      from: sql`jsonb_to_recordset(${JSON.stringify(changes)}::jsonb) AS expected(id uuid, xmin text, connector_id uuid, replace_config boolean, event_config jsonb)`,
      joins: [],
      where: and(
        ordered,
        eq(workflowAutomations.id, sql`expected.id`),
        eq(sql`${workflowAutomations}.xmin::text`, sql`expected.xmin`),
      ),
      returning: [{ path: ["id"], field: workflowAutomations.id }],
    });
    clauses.push(sql`${name} AS (${write})`);
    checks.push(sql`(SELECT ${count()} FROM ${name}) = ${changes.length}`);
    previous = "copy_projected_" + index;
    if (snapshot.slug === "notion") {
      const invalidation = copyNotionInvalidationValues();
      clauses.push(
        sql`${sql.identifier("copy_notion_invalidated_" + index)} AS (${copyUpdateSql(
          notionWorkflowPendingEvents,
          invalidation,
          and(
            inArray(
              notionWorkflowPendingEvents.automationId,
              sql`(SELECT id FROM ${name})`,
            ),
            inArray(notionWorkflowPendingEvents.status, ["pending", "running"]),
          ),
          notionWorkflowPendingEvents.id,
        )})`,
      );
      previous = "copy_notion_invalidated_" + index;
      checks.push(
        sql`(SELECT ${count()} FROM ${sql.identifier(previous)}) >= 0`,
      );
    }
  }
  return { clauses, checks };
}
