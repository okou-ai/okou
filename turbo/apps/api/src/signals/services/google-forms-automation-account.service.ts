import { googleFormsAutomationCursors } from "@okouai/db/schema/google-forms-event";
import { workflowUserAutomationThreads } from "@okouai/db/schema/workflow";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { connectors } from "@okouai/db/schema/connector";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { ne, sql, type SQL } from "drizzle-orm";

/**
 * Publish the selected business source and discard an incompatible cursor.
 * No row locks: the desired account is read from the statement snapshot and
 * the conditional UPDATE computes the new config from the current target row,
 * so a concurrent config edit is preserved and a concurrent reprojection
 * leaves nothing to change.
 */
export function googleFormsAccountProjectionStatement(args: {
  readonly orgId: string;
  readonly userId: string;
}) {
  return sql`
    WITH changed AS (${googleFormsAccountProjectionUpdate(args)})
    DELETE FROM ${googleFormsAutomationCursors}
    WHERE ${googleFormsAutomationCursors.automationId} IN (SELECT id FROM changed)
  `;
}

/** A default-changing statement supplies its returned account, not the old snapshot. */
export function googleFormsAccountProjectionUpdate(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly defaultConnectorId?: SQL;
  readonly excludedChatThreadId?: string;
  readonly selectedThread?: {
    readonly chatThreadId: string;
    readonly connectorId: string;
  };
  readonly publicationCondition?: SQL;
}) {
  const defaultConnectorId = args.defaultConnectorId ?? sql`${connectors.id}`;
  const selectionCondition =
    args.excludedChatThreadId === undefined
      ? sql.empty()
      : sql`AND ${ne(chatThreadConnectorSelections.chatThreadId, args.excludedChatThreadId)}`;
  const snapshotConnectorId = sql`CASE WHEN ${chatThreadConnectorSelections.connectorSlug} IS NOT NULL
    THEN ${chatThreadConnectorSelections.connectorId}
    ELSE ${defaultConnectorId} END`;
  const selectedConnectorId =
    args.selectedThread === undefined
      ? snapshotConnectorId
      : sql`CASE WHEN ${workflowUserAutomationThreads.chatThreadId} = ${args.selectedThread.chatThreadId}
        THEN ${args.selectedThread.connectorId}::uuid ELSE ${snapshotConnectorId} END`;
  const publicationCondition =
    args.publicationCondition === undefined
      ? sql.empty()
      : sql`AND ${args.publicationCondition}`;
  return sql`
      UPDATE ${workflowAutomations}
      SET event_connector_id = desired.connector_id,
        event_config = CASE WHEN desired.connector_id IS NOT NULL
          AND ${workflowAutomations.eventConfig} ->> 'connectorId' IS DISTINCT FROM desired.connector_id::text
          THEN jsonb_set(${workflowAutomations.eventConfig}, '{connectorId}', to_jsonb(desired.connector_id::text))
          ELSE ${workflowAutomations.eventConfig} END
      FROM (
      SELECT ${workflowAutomations.id} AS id,
        ${selectedConnectorId} AS connector_id
      FROM ${workflowAutomations}
      LEFT JOIN ${workflowUserAutomationThreads}
        ON ${workflowUserAutomationThreads.orgId} = ${workflowAutomations.orgId}
        AND ${workflowUserAutomationThreads.userId} = ${workflowAutomations.ownerUserId}
        AND ${workflowUserAutomationThreads.workflowId} = ${workflowAutomations.workflowId}
      LEFT JOIN ${chatThreadConnectorSelections}
        ON ${chatThreadConnectorSelections.chatThreadId} = ${workflowUserAutomationThreads.chatThreadId}
        AND ${chatThreadConnectorSelections.connectorSlug} = 'google-forms'
        ${selectionCondition}
      LEFT JOIN ${connectors}
        ON ${connectors.orgId} = ${args.orgId}
        AND ${connectors.userId} = ${args.userId}
        AND ${connectors.connectorSlug} = 'google-forms'
        AND ${connectors.isDefault}
      WHERE ${workflowAutomations.orgId} = ${args.orgId}
        AND ${workflowAutomations.ownerUserId} = ${args.userId}
        AND ${workflowAutomations.kind} = 'event'
        AND ${workflowAutomations.eventType} = 'google-forms-response-submitted'
      ) AS desired
      WHERE ${workflowAutomations.id} = desired.id
        ${publicationCondition}
        AND ${workflowAutomations.kind} = 'event'
        AND ${workflowAutomations.eventType} = 'google-forms-response-submitted'
        AND (${workflowAutomations.eventConnectorId} IS DISTINCT FROM desired.connector_id
          OR (desired.connector_id IS NOT NULL
            AND ${workflowAutomations.eventConfig} ->> 'connectorId' IS DISTINCT FROM desired.connector_id::text))
      RETURNING ${workflowAutomations.id}
  `;
}
