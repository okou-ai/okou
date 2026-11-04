import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { connectors } from "@okouai/db/schema/connector";
import { workflowUserAutomationThreads } from "@okouai/db/schema/workflow";
import { chatThreadConnectorAccessOverrides } from "@okouai/db/schema/chat-thread-connector-access";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command } from "ccstate";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { object, uuid } from "zod";

import { parseRawRows } from "../../lib/db-raw-rows";
import { rawSqlReadDb$ } from "../external/db";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";

interface WorkflowAutomationAccountScope {
  readonly orgId: string;
  readonly userId: string;
  readonly workflowId: string;
  readonly connectorSlug: ConnectorSlug;
}

export const loadWorkflowAutomationAccountMode$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly userId: string },
    signal?: AbortSignal,
  ) => {
    return isFeatureEnabled(
      FeatureSwitchKey.ConnectorChatAccountAccess,
      await set(loadUserFeatureSwitchContext$, args.orgId, args.userId, signal),
    );
  },
);

export const readWorkflowAutomationConnectorAccount$ = command(
  async (
    { get, set },
    args: WorkflowAutomationAccountScope,
    signal?: AbortSignal,
  ): Promise<string | null> => {
    const chatAccountAccess = await set(
      loadWorkflowAutomationAccountMode$,
      args,
      signal,
    );
    const db = get(rawSqlReadDb$);
    const [selection] = parseRawRows(
      object({ connectorId: uuid().nullable() }),
      await db.execute(
        workflowAutomationConnectorSelectionSql({
          ...args,
          workflowId: sql`${args.workflowId}`,
          chatAccountAccess,
        }),
      ),
    );
    signal?.throwIfAborted();
    if (!selection) {
      throw new Error("Workflow automation account resolution returned no row");
    }
    return selection.connectorId;
  },
);

export function workflowAutomationSelectedAccountReadPlan(
  args: WorkflowAutomationAccountScope,
) {
  return {
    columns: { connectorId: chatThreadConnectorSelections.connectorId },
    from: workflowUserAutomationThreads,
    join: {
      table: chatThreadConnectorSelections,
      on: and(
        eq(
          chatThreadConnectorSelections.chatThreadId,
          workflowUserAutomationThreads.chatThreadId,
        ),
        eq(chatThreadConnectorSelections.connectorSlug, args.connectorSlug),
      ),
    },
    where: and(
      eq(workflowUserAutomationThreads.orgId, args.orgId),
      eq(workflowUserAutomationThreads.userId, args.userId),
      eq(workflowUserAutomationThreads.workflowId, args.workflowId),
    ),
    limit: 1,
  };
}

export function workflowAutomationDefaultAccountReadPlan(
  args: WorkflowAutomationAccountScope,
) {
  return {
    columns: { connectorId: connectors.id },
    from: connectors,
    where: and(
      eq(connectors.orgId, args.orgId),
      eq(connectors.userId, args.userId),
      eq(connectors.connectorSlug, args.connectorSlug),
      eq(connectors.isDefault, true),
    ),
    limit: 1,
  };
}

export function workflowAutomationConnectorSelectionSql(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly workflowId: SQL;
  readonly connectorSlug: string;
  readonly chatAccountAccess?: boolean;
}) {
  if (args.chatAccountAccess) {
    return sql`SELECT (
      SELECT ${connectors.id}
      FROM ${connectors}
      LEFT JOIN ${workflowUserAutomationThreads}
        ON ${workflowUserAutomationThreads.orgId} = ${args.orgId}
        AND ${workflowUserAutomationThreads.userId} = ${args.userId}
        AND ${workflowUserAutomationThreads.workflowId} = ${args.workflowId}
      LEFT JOIN ${chatThreadConnectorSelections}
        ON ${chatThreadConnectorSelections.chatThreadId} = ${workflowUserAutomationThreads.chatThreadId}
        AND ${chatThreadConnectorSelections.connectorSlug} = ${args.connectorSlug}
      LEFT JOIN ${chatThreadConnectorAccessOverrides}
        ON ${chatThreadConnectorAccessOverrides.chatThreadId} = ${workflowUserAutomationThreads.chatThreadId}
        AND ${chatThreadConnectorAccessOverrides.connectorId} = ${connectors.id}
      WHERE ${connectors.orgId} = ${args.orgId} AND ${connectors.userId} = ${args.userId}
        AND ${connectors.connectorSlug} = ${args.connectorSlug}
        AND coalesce(${chatThreadConnectorAccessOverrides.enabled}, ${connectors.defaultEnabledForChats})
      ORDER BY (${connectors.id} = ${chatThreadConnectorSelections.connectorId}) DESC NULLS LAST,
        ${connectors.isDefault} DESC, ${connectors.createdAt}, ${connectors.id}
      LIMIT 1
    ) AS "connectorId"`;
  }
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
