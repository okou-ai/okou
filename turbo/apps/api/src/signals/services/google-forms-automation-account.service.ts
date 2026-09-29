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

/** Invalidate a changed business source before preparing its new watch interval. */
export function googleFormsAccountProjectionStatement(args: {
  readonly orgId: string;
  readonly userId: string;
}) {
  return sql`
    WITH candidates AS MATERIALIZED (
      SELECT ${workflowAutomations.id} AS id,
        ${workflowAutomations.enabled} AS enabled,
        ${workflowAutomations.eventConnectorId} AS connector_id,
        ${workflowAutomations.eventConfig} AS event_config,
        CASE WHEN ${chatThreadConnectorSelections.connectorSlug} IS NOT NULL
          THEN ${chatThreadConnectorSelections.connectorId}
          ELSE ${connectors.id} END AS desired_connector_id
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
      ORDER BY ${workflowAutomations.id}
      FOR UPDATE OF ${workflowAutomations}
    ), projection AS (
      SELECT id,
        CASE WHEN enabled AND (
          connector_id IS NULL OR desired_connector_id IS NULL
          OR event_config ->> 'connectorId' IS DISTINCT FROM desired_connector_id::text
          OR connector_id IS DISTINCT FROM desired_connector_id
        ) THEN NULL::uuid ELSE desired_connector_id END AS connector_id,
        CASE WHEN desired_connector_id IS NOT NULL
          AND event_config ->> 'connectorId' IS DISTINCT FROM desired_connector_id::text
          THEN jsonb_set(event_config, '{connectorId}', to_jsonb(desired_connector_id::text))
          ELSE event_config END AS event_config
      FROM candidates
    ), changed AS (
      UPDATE ${workflowAutomations}
      SET event_connector_id = projection.connector_id, event_config = projection.event_config
      FROM projection
      WHERE ${workflowAutomations.id} = projection.id
        AND (${workflowAutomations.eventConnectorId} IS DISTINCT FROM projection.connector_id
          OR ${workflowAutomations.eventConfig} IS DISTINCT FROM projection.event_config)
      RETURNING ${workflowAutomations.id}
    )
    DELETE FROM ${googleFormsAutomationCursors}
    WHERE ${googleFormsAutomationCursors.automationId} IN (SELECT id FROM changed)
  `;
}
