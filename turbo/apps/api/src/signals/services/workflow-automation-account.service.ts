import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { connectors } from "@okouai/db/schema/connector";
import { workflowUserAutomationThreads } from "@okouai/db/schema/workflow";
import { and, eq, sql } from "drizzle-orm";

import type { ReadonlyDb } from "../external/db";

export async function resolveWorkflowAutomationConnectorId(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly workflowId: string;
    readonly connectorSlug: ConnectorSlug;
  },
): Promise<string | null> {
  const [selection] = await db
    .select({ connectorId: chatThreadConnectorSelections.connectorId })
    .from(workflowUserAutomationThreads)
    .innerJoin(
      chatThreadConnectorSelections,
      and(
        eq(
          chatThreadConnectorSelections.chatThreadId,
          workflowUserAutomationThreads.chatThreadId,
        ),
        eq(chatThreadConnectorSelections.connectorSlug, args.connectorSlug),
      ),
    )
    .where(
      and(
        eq(workflowUserAutomationThreads.orgId, args.orgId),
        eq(workflowUserAutomationThreads.userId, args.userId),
        eq(workflowUserAutomationThreads.workflowId, args.workflowId),
      ),
    )
    .limit(1);
  if (selection) {
    return selection.connectorId;
  }

  const [defaultAccount] = await db
    .select({ connectorId: connectors.id })
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
        eq(connectors.connectorSlug, args.connectorSlug),
        eq(connectors.isDefault, true),
      ),
    )
    .limit(1);
  return defaultAccount?.connectorId ?? null;
}

export function workflowAutomationConnectorSelectionSql(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly workflowId: string;
  readonly connectorSlug: string;
}) {
  return sql`WITH selected AS (
    SELECT ${chatThreadConnectorSelections.connectorId} AS connector_id
    FROM ${workflowUserAutomationThreads}
    JOIN ${chatThreadConnectorSelections}
      ON ${chatThreadConnectorSelections.chatThreadId} = ${workflowUserAutomationThreads.chatThreadId}
      AND ${chatThreadConnectorSelections.connectorSlug} = ${args.connectorSlug}
    WHERE ${workflowUserAutomationThreads.orgId} = ${args.orgId}
      AND ${workflowUserAutomationThreads.userId} = ${args.userId}
      AND ${workflowUserAutomationThreads.workflowId} = ${args.workflowId}
    LIMIT 1
  ) SELECT CASE WHEN EXISTS(SELECT 1 FROM selected)
    THEN (SELECT connector_id FROM selected)
    ELSE (SELECT ${connectors.id} FROM ${connectors}
      WHERE ${connectors.orgId} = ${args.orgId} AND ${connectors.userId} = ${args.userId}
        AND ${connectors.connectorSlug} = ${args.connectorSlug} AND ${connectors.isDefault}
      LIMIT 1) END AS "connectorId"`;
}
