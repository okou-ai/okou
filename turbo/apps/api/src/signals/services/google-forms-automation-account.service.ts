import { googleFormsAutomationCursors } from "@okouai/db/schema/google-forms-event";
import {
  workflowAutomations,
  workflowUserAutomationThreads,
} from "@okouai/db/schema/workflow";
import { connectors } from "@okouai/db/schema/connector";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { sql } from "drizzle-orm";

import type { ReadonlyDb } from "../external/db";
import { resolveWorkflowAutomationConnectorId } from "./workflow-automation-account.service";

export async function resolveGoogleFormsAutomationConnectorId(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly workflowId: string;
  },
): Promise<string | null> {
  return await resolveWorkflowAutomationConnectorId(db, {
    ...args,
    connectorSlug: "google-forms",
  });
}

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
    WITH desired AS (
      SELECT ${workflowAutomations.id} AS id,
        CASE WHEN ${chatThreadConnectorSelections.connectorSlug} IS NOT NULL
          THEN ${chatThreadConnectorSelections.connectorId}
          ELSE ${connectors.id} END AS connector_id
      FROM ${workflowAutomations}
      LEFT JOIN ${workflowUserAutomationThreads}
        ON ${workflowUserAutomationThreads.orgId} = ${workflowAutomations.orgId}
        AND ${workflowUserAutomationThreads.userId} = ${workflowAutomations.ownerUserId}
        AND ${workflowUserAutomationThreads.workflowId} = ${workflowAutomations.workflowId}
      LEFT JOIN ${chatThreadConnectorSelections}
        ON ${chatThreadConnectorSelections.chatThreadId} = ${workflowUserAutomationThreads.chatThreadId}
        AND ${chatThreadConnectorSelections.connectorSlug} = 'google-forms'
      LEFT JOIN ${connectors}
        ON ${connectors.orgId} = ${args.orgId}
        AND ${connectors.userId} = ${args.userId}
        AND ${connectors.connectorSlug} = 'google-forms'
        AND ${connectors.isDefault}
      WHERE ${workflowAutomations.orgId} = ${args.orgId}
        AND ${workflowAutomations.ownerUserId} = ${args.userId}
        AND ${workflowAutomations.kind} = 'event'
        AND ${workflowAutomations.eventType} = 'google-forms-response-submitted'
    ), changed AS (
      UPDATE ${workflowAutomations}
      SET event_connector_id = desired.connector_id,
        event_config = CASE WHEN desired.connector_id IS NOT NULL
          AND ${workflowAutomations.eventConfig} ->> 'connectorId' IS DISTINCT FROM desired.connector_id::text
          THEN jsonb_set(${workflowAutomations.eventConfig}, '{connectorId}', to_jsonb(desired.connector_id::text))
          ELSE ${workflowAutomations.eventConfig} END
      FROM desired
      WHERE ${workflowAutomations.id} = desired.id
        AND ${workflowAutomations.kind} = 'event'
        AND ${workflowAutomations.eventType} = 'google-forms-response-submitted'
        AND (${workflowAutomations.eventConnectorId} IS DISTINCT FROM desired.connector_id
          OR (desired.connector_id IS NOT NULL
            AND ${workflowAutomations.eventConfig} ->> 'connectorId' IS DISTINCT FROM desired.connector_id::text))
      RETURNING ${workflowAutomations.id}
    )
    DELETE FROM ${googleFormsAutomationCursors}
    WHERE ${googleFormsAutomationCursors.automationId} IN (SELECT id FROM changed)
  `;
}
