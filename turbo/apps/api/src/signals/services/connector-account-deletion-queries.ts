import { connectors } from "@okouai/db/schema/connector";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { asc, eq, sql } from "drizzle-orm";
import { PgDialect, QueryBuilder } from "drizzle-orm/pg-core";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";

import { builtinDeletionReadPlan } from "./connector-account-resolution.service";
import {
  connectorAccountOwnerCondition,
  connectorAccountById,
  connectorAccountSibling,
  type ConnectorAccountDeletionScope,
} from "./connector-account-lifecycle.service";
import {
  builtinConnectorAccountDeletionReadPlan,
  builtinConnectorTokenRevokeReadPlan,
  prepareBuiltinConnectorAccountDeletionRevoke,
} from "./builtin-connector-credential-access.service";
import type { ConnectorRuntimeSelection } from "./connector-catalog-runtime.service";
import {
  workflowAutomationOwnerProjectionReadPlan,
  workflowAutomationProjectionValues,
  type ProjectedAutomation,
} from "./workflow-automation-account-projection.service";
import {
  workflowAutomationSelectedAccountReadPlan,
  workflowAutomationDefaultAccountReadPlan,
} from "./workflow-automation-account.service";
import {
  notionPendingEventsSkipWrite,
  notionPendingEventsReconnectScope,
  notionAutomationPendingEventsScope,
} from "./notion-automation-account.service";

export interface BuiltinConnectorDeletionContext {
  readonly request: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorSlug: string;
    readonly sourceId: string;
  };
  readonly snapshot: ConnectorRuntimeSelection | null;
  readonly featureSwitchContext: FeatureSwitchContext | null;
}

export function deletionScope(
  context: BuiltinConnectorDeletionContext,
  connectionId: string,
): ConnectorAccountDeletionScope {
  const { request } = context;
  return {
    orgId: request.orgId,
    userId: request.userId,
    target: { kind: "builtin", connectorSlug: request.connectorSlug },
    connectionId,
  };
}

export function deletionResolutionQueries(
  args: Parameters<typeof builtinDeletionReadPlan>[0],
) {
  const read = builtinDeletionReadPlan(args);
  return {
    read,
    exact: read.exactWhere
      ? new QueryBuilder()
          .select(read.columns)
          .from(connectors)
          .where(read.exactWhere)
          .as("deletion_exact")
      : null,
    default: read.defaultWhere
      ? new QueryBuilder()
          .select(read.columns)
          .from(connectors)
          .where(read.defaultWhere)
          .as("deletion_default")
      : null,
  };
}

export function deletionAccountQuery(scope: ConnectorAccountDeletionScope) {
  const owner = connectorAccountOwnerCondition(scope);
  return new QueryBuilder()
    .select({ isDefault: connectors.isDefault })
    .from(connectors)
    .where(connectorAccountById(owner, scope.connectionId))
    .limit(1)
    .as("deletion_account");
}

export function deletionSiblingQuery(scope: ConnectorAccountDeletionScope) {
  const owner = connectorAccountOwnerCondition(scope);
  return new QueryBuilder()
    .select({ id: connectors.id })
    .from(connectors)
    .where(connectorAccountSibling(owner, scope.connectionId))
    .orderBy(asc(connectors.createdAt), asc(connectors.id))
    .limit(1)
    .as("deletion_sibling");
}

export function deletionDefaultWrite(connectionId: string, isDefault: boolean) {
  return new PgDialect().buildUpdateQuery({
    table: connectors,
    set: {
      isDefault: sql.param(isDefault, connectors.isDefault),
      updatedAt: sql`clock_timestamp()`,
    },
    where: eq(connectors.id, connectionId),
    joins: [],
  });
}

export function deletionSelectionsWrite(connectionId: string) {
  return new PgDialect().buildDeleteQuery({
    table: chatThreadConnectorSelections,
    where: eq(chatThreadConnectorSelections.connectorId, connectionId),
  });
}

/** Construct at the write site so both captured timestamps keep their owner. */
function deletionNotionEventsWrite(scope: {
  readonly condition: Parameters<typeof notionPendingEventsSkipWrite>[0];
  readonly reason: string;
}) {
  const write = notionPendingEventsSkipWrite(scope.condition, scope.reason);
  return new PgDialect().buildUpdateQuery({
    table: write.table,
    set: {
      status: sql.param(write.values.status, write.table.status),
      skipReason: sql.param(write.values.skipReason, write.table.skipReason),
      processedAt: sql.param(write.values.processedAt, write.table.processedAt),
      updatedAt: sql.param(write.values.updatedAt, write.table.updatedAt),
    },
    where: write.where,
    joins: [],
  });
}

export function reconnectNotionWrite(connectionId: string) {
  return deletionNotionEventsWrite(
    notionPendingEventsReconnectScope(connectionId),
  );
}

export function projectionNotionWrite(automationId: string) {
  return deletionNotionEventsWrite(
    notionAutomationPendingEventsScope(automationId),
  );
}

export function deletionProjectionQuery(
  args: Parameters<typeof workflowAutomationOwnerProjectionReadPlan>[0],
) {
  const read = workflowAutomationOwnerProjectionReadPlan(args);
  return read === null
    ? null
    : {
        connectorSlug: read.connectorSlug,
        query: new QueryBuilder()
          .select(read.columns)
          .from(workflowAutomations)
          .where(read.where)
          .as("deletion_automations"),
      };
}

function selectedAccountQuery(
  args: Parameters<typeof workflowAutomationSelectedAccountReadPlan>[0],
) {
  const read = workflowAutomationSelectedAccountReadPlan(args);
  return new QueryBuilder()
    .select(read.columns)
    .from(read.from)
    .innerJoin(read.join.table, read.join.on)
    .where(read.where)
    .limit(read.limit)
    .as("deletion_selected_account");
}

function defaultAccountQuery(
  args: Parameters<typeof workflowAutomationDefaultAccountReadPlan>[0],
) {
  const read = workflowAutomationDefaultAccountReadPlan(args);
  return new QueryBuilder()
    .select(read.columns)
    .from(read.from)
    .where(read.where)
    .limit(read.limit)
    .as("deletion_default_account");
}

export function deletionAccountLookups(
  scope: ConnectorAccountDeletionScope,
  projection: { readonly connectorSlug: string },
  automation: ProjectedAutomation,
) {
  const args = {
    ...scope,
    workflowId: automation.workflowId,
    connectorSlug: projection.connectorSlug,
  };
  return {
    selected: selectedAccountQuery(args),
    default: defaultAccountQuery(args),
  };
}

export function deletionProjectionWrite(
  automation: ProjectedAutomation,
  account: { readonly connectorId: string | null } | undefined,
  projection: { readonly connectorSlug: string },
) {
  const values = workflowAutomationProjectionValues(
    automation,
    account?.connectorId ?? null,
    projection.connectorSlug,
  );
  if (values === null) {
    return null;
  }
  return new PgDialect().buildUpdateQuery({
    table: workflowAutomations,
    set: {
      eventConnectorId: sql.param(
        values.eventConnectorId,
        workflowAutomations.eventConnectorId,
      ),
      ...("eventConfig" in values
        ? {
            eventConfig: sql.param(
              values.eventConfig,
              workflowAutomations.eventConfig,
            ),
          }
        : {}),
    },
    where: eq(workflowAutomations.id, automation.id),
    joins: [],
  });
}

export function deletionTokenRevokePreparation(
  context: BuiltinConnectorDeletionContext,
  existing: Parameters<
    typeof prepareBuiltinConnectorAccountDeletionRevoke
  >[0]["existing"],
) {
  return prepareBuiltinConnectorAccountDeletionRevoke({
    ...context.request,
    snapshot: context.snapshot,
    featureSwitchContext: context.featureSwitchContext,
    existing,
  });
}

export function deletionCredentialQuery(connectionId: string) {
  const read = builtinConnectorAccountDeletionReadPlan(connectionId);
  return new QueryBuilder()
    .select(read.columns)
    .from(read.from)
    .where(read.where)
    .limit(read.limit)
    .as("deletion_credential");
}

export function deletionRevokeQuery(
  read: Extract<
    ReturnType<typeof builtinConnectorTokenRevokeReadPlan>,
    { readonly kind: "read" }
  >,
) {
  return new QueryBuilder()
    .select(read.columns)
    .from(read.from)
    .where(read.where)
    .as("deletion_revoke");
}
