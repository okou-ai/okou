import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { connectors } from "@okouai/db/schema/connector";
import { feishuOrgConnections } from "@okouai/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";
import { googleFormsAutomationCursors } from "@okouai/db/schema/google-forms-event";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { secrets } from "@okouai/db/schema/secret";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { and, count, eq, exists, gte, inArray, or, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";

import {
  feishuDisconnectInstallationFilter,
  type FeishuDisconnectArgs,
} from "./feishu-disconnect-plan";

/** Unlink first so account deletion cannot also update the same member via its FK. */
function feishuMemberDeletionPlan(args: FeishuDisconnectArgs) {
  const query = new QueryBuilder();
  const installations = query
    .select({ id: feishuOrgInstallations.id })
    .from(feishuOrgInstallations)
    .where(feishuDisconnectInstallationFilter(args));
  const memberCondition = and(
    inArray(feishuOrgConnections.installationId, installations),
    eq(feishuOrgConnections.userId, args.userId),
  );
  const observed = query.$with("observed_feishu_members").as(
    query
      .select({
        id: feishuOrgConnections.id,
        connectorId: feishuOrgConnections.connectorId,
        feishuOpenId: feishuOrgConnections.feishuOpenId,
      })
      .from(feishuOrgConnections)
      .where(memberCondition),
  );
  const retainedMember = exists(
    query
      .select({ id: observed.id })
      .from(observed)
      .where(
        and(
          eq(feishuOrgConnections.id, observed.id),
          eq(feishuOrgConnections.feishuOpenId, observed.feishuOpenId),
          sql`${feishuOrgConnections.connectorId} IS NOT DISTINCT FROM ${observed.connectorId}`,
        ),
      ),
  );
  const removed = query.$with("removed_feishu_members", {
    id: feishuOrgConnections.id,
    connectorId: feishuOrgConnections.connectorId,
    feishuOpenId: feishuOrgConnections.feishuOpenId,
  })
    .as(sql`DELETE FROM ${feishuOrgConnections} WHERE ${and(memberCondition, retainedMember)}
    RETURNING id, connector_id, feishu_open_id`);
  return { observed, removed };
}

function feishuAccountDeletionPlan(
  args: FeishuDisconnectArgs,
  { observed, removed }: ReturnType<typeof feishuMemberDeletionPlan>,
) {
  const query = new QueryBuilder();
  // Multiple member rows are unlinked, but never choose an arbitrary account.
  const singleMember = eq(query.select({ total: count() }).from(observed), 1);
  const eligible = query.$with("eligible_feishu_account").as(
    query
      .select({
        id: connectors.id,
        customConnectorId: connectors.customConnectorId,
        authMethod: connectors.authMethod,
        storageVersion: connectors.storageVersion,
        externalId: connectors.externalId,
      })
      .from(connectors)
      .innerJoin(removed, eq(connectors.id, removed.connectorId))
      .innerJoin(observed, eq(removed.id, observed.id))
      .innerJoin(
        feishuOrgInstallations,
        and(
          feishuDisconnectInstallationFilter(args),
          eq(
            connectors.customConnectorId,
            feishuOrgInstallations.customConnectorId,
          ),
        ),
      )
      .innerJoin(
        orgCustomConnectors,
        and(
          eq(connectors.customConnectorId, orgCustomConnectors.id),
          eq(connectors.orgId, orgCustomConnectors.orgId),
          eq(connectors.authMethod, orgCustomConnectors.authMode),
          eq(connectors.storageVersion, orgCustomConnectors.storageVersion),
        ),
      )
      .innerJoin(
        secrets,
        and(
          eq(secrets.connectorId, connectors.id),
          eq(secrets.name, "access_token"),
        ),
      )
      .where(
        and(
          singleMember,
          eq(connectors.orgId, args.orgId),
          eq(connectors.userId, args.userId),
          eq(connectors.authMethod, "oauth"),
          eq(connectors.needsReconnect, false),
          eq(connectors.externalId, removed.feishuOpenId),
        ),
      ),
  );
  const accountCondition = and(
    eq(connectors.orgId, args.orgId),
    eq(connectors.userId, args.userId),
    eq(connectors.needsReconnect, false),
    exists(
      query
        .select({ id: eligible.id })
        .from(eligible)
        .where(
          and(
            eq(connectors.id, eligible.id),
            eq(connectors.customConnectorId, eligible.customConnectorId),
            eq(connectors.authMethod, eligible.authMethod),
            eq(connectors.storageVersion, eligible.storageVersion),
            eq(connectors.externalId, eligible.externalId),
          ),
        ),
    ),
  );
  // Existing owner FKs cascade credentials and OAuth bindings. NO ACTION thread
  // references are removed in this same statement, before constraint checking.
  const deleted = query
    .$with("deleted_feishu_accounts", { id: connectors.id })
    .as(sql`DELETE FROM ${connectors} WHERE ${accountCondition} RETURNING id`);
  return { eligible, deleted };
}

/** Publish the exact member unlink and all dependent local cleanup together. */
export function feishuDisconnectPublicationSql(args: FeishuDisconnectArgs) {
  const query = new QueryBuilder();
  const members = feishuMemberDeletionPlan(args);
  const { observed, removed } = members;
  const { eligible, deleted } = feishuAccountDeletionPlan(args, members);
  const selections = inArray(
    chatThreadConnectorSelections.connectorId,
    query.select({ id: deleted.id }).from(deleted),
  );
  const cleared = query.$with("cleared_feishu_selections", {
    id: chatThreadConnectorSelections.connectorId,
  }).as(sql`DELETE FROM ${chatThreadConnectorSelections} WHERE ${selections}
    RETURNING connector_id`);
  const cursors = inArray(
    googleFormsAutomationCursors.automationId,
    query
      .select({ id: workflowAutomations.id })
      .from(workflowAutomations)
      .where(
        and(
          eq(workflowAutomations.eventType, "google-forms-response-submitted"),
          inArray(
            sql`${workflowAutomations.eventConfig}->>'connectorId'`,
            query
              .select({ id: sql`${deleted.id}::text`.mapWith(connectors.id) })
              .from(deleted),
          ),
        ),
      ),
  );
  const discarded = query.$with("discarded_feishu_cursors", {
    id: googleFormsAutomationCursors.automationId,
  }).as(sql`DELETE FROM ${googleFormsAutomationCursors} WHERE ${cursors}
    RETURNING automation_id`);
  const membersUnchanged = or(
    eq(query.select({ total: count() }).from(removed), 0),
    eq(
      query.select({ total: count() }).from(removed),
      query.select({ total: count() }).from(observed),
    ),
  );
  const accountsComplete = eq(
    query.select({ total: count() }).from(deleted),
    query.select({ total: count() }).from(eligible),
  );
  return query
    .with(observed, removed, eligible, deleted, cleared, discarded)
    .select({ id: removed.id })
    .from(removed)
    .where(
      and(
        // A waiter may lose an observed member/account identity. Roll back all
        // earlier unlinking rather than report a partially disconnected user.
        eq(
          sql`1 / CASE WHEN ${and(membersUnchanged, accountsComplete)} THEN 1 ELSE 0 END`,
          1,
        ),
        gte(query.select({ total: count() }).from(cleared), 0),
        gte(query.select({ total: count() }).from(discarded), 0),
      ),
    )
    .getSQL();
}
