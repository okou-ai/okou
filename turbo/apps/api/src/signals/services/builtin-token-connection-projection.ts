import { connectors } from "@okouai/db/schema/connector";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { notionWorkflowPendingEvents } from "@okouai/db/schema/notion-event";
import {
  and,
  count,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  notExists,
  sql,
  type SQL,
} from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { nowDate } from "../../lib/time";
import {
  gmailAutomationProjectionConfig,
  gmailAutomationResolvedLabelInvalidationWrite,
} from "./gmail-automation-account.service";
import { googleFormsAccountProjectionUpdate } from "./google-forms-automation-account.service";
import { googleFormsAutomationCursors } from "@okouai/db/schema/google-forms-event";
import { workflowUserAutomationThreads } from "@okouai/db/schema/workflow";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import {
  notionConfigConnectorId,
  notionConfigWithConnectorId,
  notionPendingEventsReconnectScope,
  notionPendingEventsSkipWrite,
  NOTION_ACCOUNT_CHANGED_SKIP_REASON,
} from "./notion-automation-account.service";
import {
  workflowAutomationOwnerProjectionReadPlan,
  type ProjectedAutomation,
} from "./workflow-automation-account-projection.service";

export interface TokenAutomationProjection {
  readonly automation: ProjectedAutomation;
  readonly revision: string;
}

export interface TokenProjectionPublication {
  readonly orgId: string;
  readonly userId: string;
  readonly connectorSlug: string;
  readonly previousId: string | null;
  readonly principalChanged: boolean;
  readonly projections: readonly TokenAutomationProjection[];
}

const accepted = exists(sql`(SELECT 1 FROM token_connection)`);

function tokenDefaultAccount(args: TokenProjectionPublication): SQL {
  return sql`COALESCE(
    (SELECT id FROM token_connection WHERE (payload->>'isDefault')::boolean),
    (SELECT ${connectors.id} FROM ${connectors}
      WHERE ${and(eq(connectors.orgId, args.orgId), eq(connectors.userId, args.userId), eq(connectors.connectorSlug, args.connectorSlug), eq(connectors.isDefault, true))}
        AND ${connectors.id} IS DISTINCT FROM (SELECT id FROM token_connection)
      LIMIT 1))`;
}

function tokenProjectionInput(
  args: TokenProjectionPublication,
  input: TokenAutomationProjection,
) {
  const { automation } = input;
  const source = "eventType" in automation ? automation : null;
  const notion = args.connectorSlug === "notion" && source !== null;
  const config =
    source === null
      ? null
      : notion
        ? notionConfigWithConnectorId(
            source.eventType,
            source.eventConfig,
            "00000000-0000-4000-8000-000000000000",
          )
        : gmailAutomationProjectionConfig(source);
  return {
    id: automation.id,
    workflow_id: automation.workflowId,
    revision: input.revision,
    previous_connector_id: automation.eventConnectorId,
    config,
    configured_connector_id: notion
      ? notionConfigConnectorId(source.eventType, source.eventConfig)
      : null,
    invalidate_gmail:
      args.principalChanged &&
      automation.eventConnectorId === args.previousId &&
      source?.eventType === "gmail-label-applied",
  };
}

function tokenProjectionConfig(
  args: TokenProjectionPublication,
): SQL | undefined {
  if (args.connectorSlug === "notion") {
    return sql`CASE WHEN ${isNotNull(sql`desired.connector_id`)} AND ${isNotNull(sql`desired.config`)}
      THEN jsonb_set(desired.config, '{connectorId}', to_jsonb(desired.connector_id::text))
      ELSE ${workflowAutomations.eventConfig} END`;
  }
  if (args.connectorSlug === "gmail") {
    return sql`CASE WHEN desired.previous_connector_id IS DISTINCT FROM desired.connector_id THEN desired.config
      WHEN desired.invalidate_gmail THEN ${workflowAutomations.eventConfig} - 'resolvedLabelId'
      ELSE ${workflowAutomations.eventConfig} END`;
  }
  return undefined;
}

function tokenProjectionPublication(args: TokenProjectionPublication): SQL[] {
  const input = JSON.stringify(
    args.projections.map((projection) => {
      return tokenProjectionInput(args, projection);
    }),
  );
  const config = tokenProjectionConfig(args);
  const statement = new PgDialect().buildUpdateQuery({
    table: workflowAutomations,
    set: {
      eventConnectorId: sql`desired.connector_id`,
      ...(config === undefined ? {} : { eventConfig: config }),
    },
    from: sql`token_projection_changes AS desired`,
    joins: [],
    where: and(
      eq(workflowAutomations.id, sql`desired.id`),
      accepted,
      eq(sql`${workflowAutomations}.xmin::text`, sql`desired.revision`),
    ),
    returning: [{ path: ["id"], field: workflowAutomations.id }],
  });
  return [
    sql`token_projection_default AS MATERIALIZED (SELECT ${tokenDefaultAccount(args)} AS id)`,
    sql`token_projection_input AS MATERIALIZED (
      SELECT source.*, CASE WHEN ${isNotNull(chatThreadConnectorSelections.connectorSlug)}
        THEN ${chatThreadConnectorSelections.connectorId} ELSE fallback.id END AS connector_id
      FROM jsonb_to_recordset(${input}::jsonb) AS source(id uuid, workflow_id uuid, revision text, previous_connector_id uuid,
        config jsonb, configured_connector_id uuid, invalidate_gmail boolean)
      CROSS JOIN token_projection_default AS fallback
      LEFT JOIN ${workflowUserAutomationThreads} ON ${eq(workflowUserAutomationThreads.orgId, args.orgId)}
        AND ${eq(workflowUserAutomationThreads.userId, args.userId)}
        AND ${eq(workflowUserAutomationThreads.workflowId, sql`source.workflow_id`)}
      LEFT JOIN ${chatThreadConnectorSelections} ON ${eq(chatThreadConnectorSelections.chatThreadId, workflowUserAutomationThreads.chatThreadId)}
        AND ${eq(chatThreadConnectorSelections.connectorSlug, args.connectorSlug)})`,
    sql`token_projection_changes AS MATERIALIZED (SELECT * FROM token_projection_input
      WHERE previous_connector_id IS DISTINCT FROM connector_id OR invalidate_gmail
        OR (${args.connectorSlug === "notion"} AND ${isNotNull(sql`connector_id`)} AND configured_connector_id IS DISTINCT FROM connector_id))`,
    sql`token_projected_automations AS (${statement})`,
  ];
}

function tokenProjectionCohortChecks(args: TokenProjectionPublication): SQL[] {
  const plan = workflowAutomationOwnerProjectionReadPlan({
    ...args,
    target: { kind: "builtin", connectorSlug: args.connectorSlug },
  });
  if (plan === null) {
    return [];
  }
  return [
    notExists(sql`(SELECT 1 FROM ${workflowAutomations} WHERE ${plan.where}
      AND ${notExists(sql`(SELECT 1 FROM token_projection_input WHERE ${eq(workflowAutomations.id, sql`token_projection_input.id`)})`)})`),
    notExists(sql`(SELECT 1 FROM token_projection_input AS expected
      LEFT JOIN ${workflowAutomations} ON ${eq(workflowAutomations.id, sql`expected.id`)}
      WHERE ${isNull(workflowAutomations.id)} OR ${workflowAutomations}.xmin::text IS DISTINCT FROM expected.revision)`),
  ];
}

function principalGmailCleanup(args: TokenProjectionPublication): SQL[] {
  if (!args.principalChanged || args.previousId === null) {
    return [];
  }
  const write = gmailAutomationResolvedLabelInvalidationWrite(args.previousId);
  const statement = new PgDialect().buildUpdateQuery({
    table: write.table,
    set: write.values,
    joins: [],
    where: and(
      write.where,
      accepted,
      notExists(
        sql`(SELECT 1 FROM token_projection_input WHERE ${eq(workflowAutomations.id, sql`token_projection_input.id`)})`,
      ),
    ),
  });
  return [sql`token_other_gmail_cleanup AS (${statement} RETURNING id)`];
}

/** Reconnection precedes selection invalidation, including its reason and clock. */
function tokenNotionCleanup(args: TokenProjectionPublication): SQL {
  const at = nowDate();
  const reconnection =
    args.principalChanged && args.previousId !== null
      ? notionPendingEventsReconnectScope(args.previousId)
      : null;
  const reconnects =
    reconnection === null ? sql`false` : reconnection.condition;
  const projected =
    args.connectorSlug === "notion"
      ? inArray(
          notionWorkflowPendingEvents.automationId,
          sql`(SELECT id FROM token_projected_automations)`,
        )
      : sql`false`;
  const reason =
    reconnection === null
      ? sql`${NOTION_ACCOUNT_CHANGED_SKIP_REASON}`
      : sql`CASE WHEN ${reconnects} THEN ${reconnection.reason} ELSE ${NOTION_ACCOUNT_CHANGED_SKIP_REASON} END`;
  const write = notionPendingEventsSkipWrite(
    sql`(${reconnects} OR ${projected})`,
    NOTION_ACCOUNT_CHANGED_SKIP_REASON,
  );
  const statement = new PgDialect().buildUpdateQuery({
    table: write.table,
    set: {
      status: sql.param(write.values.status, write.table.status),
      skipReason: reason,
      processedAt: sql.param(at, write.table.processedAt),
      updatedAt: sql.param(at, write.table.updatedAt),
    },
    joins: [],
    where: and(write.where, accepted),
  });
  return sql`token_notion_cleanup AS (${statement} RETURNING id)`;
}

/** Existing source rows are validated once; each automation is written at most once. */
export function tokenConnectionProjectionClauses(
  args: TokenProjectionPublication,
) {
  const clauses = tokenProjectionPublication(args);
  const checks = [
    sql`(SELECT ${count()} FROM token_projected_automations) = (SELECT ${count()} FROM token_projection_changes)`,
    ...tokenProjectionCohortChecks(args),
  ];
  clauses.push(...principalGmailCleanup(args));
  clauses.push(tokenNotionCleanup(args));
  if (args.connectorSlug === "google-forms") {
    const discarded = new PgDialect().buildDeleteQuery({
      table: googleFormsAutomationCursors,
      where: inArray(
        googleFormsAutomationCursors.automationId,
        sql`(SELECT id FROM token_forms_projection)`,
      ),
      returning: [
        { path: ["id"], field: googleFormsAutomationCursors.automationId },
      ],
    });
    clauses.push(
      sql`token_forms_projection AS (${googleFormsAccountProjectionUpdate({ ...args, defaultConnectorId: tokenDefaultAccount(args), publicationCondition: accepted })})`,
    );
    clauses.push(sql`token_forms_cursors AS (${discarded})`);
  }
  return { clauses, checks };
}
