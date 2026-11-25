import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { connectors } from "@okouai/db/schema/connector";
import { workflowUserAutomationThreads } from "@okouai/db/schema/workflow";
import { chatThreadConnectorAccessOverrides } from "@okouai/db/schema/chat-thread-connector-access";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";

import { command } from "ccstate";
import { and, asc, desc, eq, exists, sql, type SQL } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { object, uuid } from "zod";

import { parseRawRows } from "../../lib/db-raw-rows";
import { rawSqlReadDb$ } from "../external/db";
import {
  connectorAccountAllowedSql,
  memberConnectorAccountAccessEnabledSql,
} from "./member-connector-account-access";

interface WorkflowAutomationAccountScope {
  readonly orgId: string;
  readonly userId: string;
  readonly workflowId: string;
  readonly connectorSlug: ConnectorSlug;
}

export const readWorkflowAutomationConnectorAccount$ = command(
  async (
    { get },
    args: WorkflowAutomationAccountScope,
    signal?: AbortSignal,
  ): Promise<string | null> => {
    const db = get(rawSqlReadDb$);
    const [selection] = parseRawRows(
      object({ connectorId: uuid().nullable() }),
      await db.execute(
        workflowAutomationConnectorSelectionSql({
          ...args,
          workflowId: sql`${args.workflowId}`,
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

export function workflowAutomationConnectorAfterDefaultChangeSql(
  args: WorkflowAutomationAccountScope,
  connectionId: string,
) {
  const nextDefault = sql`${connectionId}::uuid`;
  const saved = new QueryBuilder()
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
  return sql`SELECT CASE WHEN ${memberConnectorAccountAccessEnabledSql(args)}
    THEN (${workflowAutomationConnectorSelectionSql({
      ...args,
      workflowId: sql`${args.workflowId}`,
      nextDefault,
    })})
    ELSE coalesce((${saved}), ${nextDefault}) END AS "connectorId"`;
}

interface WorkflowAutomationConnectorQueryScope {
  readonly orgId: string | SQL;
  readonly userId: string | SQL;
  readonly workflowId: SQL;
  readonly connectorSlug: string;
  readonly nextDefault?: SQL;
}

function eligibleWorkflowAutomationAccounts(
  args: WorkflowAutomationConnectorQueryScope,
  boundConnectorId?: SQL,
) {
  return new QueryBuilder()
    .select({ connectorId: connectors.id })
    .from(connectors)
    .leftJoin(
      workflowUserAutomationThreads,
      and(
        eq(workflowUserAutomationThreads.orgId, args.orgId),
        eq(workflowUserAutomationThreads.userId, args.userId),
        eq(workflowUserAutomationThreads.workflowId, args.workflowId),
      ),
    )
    .leftJoin(
      chatThreadConnectorAccessOverrides,
      and(
        eq(
          chatThreadConnectorAccessOverrides.chatThreadId,
          workflowUserAutomationThreads.chatThreadId,
        ),
        eq(chatThreadConnectorAccessOverrides.connectorId, connectors.id),
      ),
    )
    .where(
      and(
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
        eq(connectors.connectorSlug, args.connectorSlug),
        connectorAccountAllowedSql(args),
        boundConnectorId === undefined
          ? undefined
          : eq(connectors.id, boundConnectorId),
      ),
    );
}

/** Correlate eligibility to an automation row, preserving any eligible binding. */
export function workflowAutomationBoundConnectorEligibleSql(
  connectorSlug: ConnectorSlug,
) {
  return exists(
    eligibleWorkflowAutomationAccounts(
      {
        orgId: sql`${workflowAutomations.orgId}`,
        userId: sql`${workflowAutomations.ownerUserId}`,
        workflowId: sql`${workflowAutomations.workflowId}`,
        connectorSlug,
      },
      sql`${workflowAutomations.eventConnectorId}`,
    ),
  );
}

export function workflowAutomationConnectorSelectionSql(
  args: WorkflowAutomationConnectorQueryScope,
) {
  const defaultOrder =
    args.nextDefault === undefined
      ? desc(connectors.isDefault)
      : sql`(${eq(connectors.id, args.nextDefault)}) DESC NULLS LAST`;
  const selected = eligibleWorkflowAutomationAccounts(args)
    .leftJoin(
      chatThreadConnectorSelections,
      and(
        eq(
          chatThreadConnectorSelections.chatThreadId,
          workflowUserAutomationThreads.chatThreadId,
        ),
        eq(chatThreadConnectorSelections.connectorSlug, args.connectorSlug),
      ),
    )
    .orderBy(
      sql`(${eq(connectors.id, chatThreadConnectorSelections.connectorId)}) DESC NULLS LAST`,
      defaultOrder,
      asc(connectors.createdAt),
      asc(connectors.id),
    )
    .limit(1);
  return sql`SELECT ${selected} AS "connectorId"`;
}
