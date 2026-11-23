import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { connectors } from "@okouai/db/schema/connector";
import { feishuOrgConnections } from "@okouai/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";
import { googleFormsAutomationCursors } from "@okouai/db/schema/google-forms-event";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { secrets } from "@okouai/db/schema/secret";
import { and, count, eq, exists, gte, inArray, or, sql } from "drizzle-orm";
import type { FeishuPlatform } from "@okouai/core/feishu-platform";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { literal } from "zod";
import { zodDriverValueDecoder } from "../../lib/db-structured-result";

interface FeishuCommandDisconnectArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly installationId: string;
  readonly memberId: string;
  readonly memberConnectorId: string;
  readonly feishuOpenId: string;
}

function commandDisconnectAccountPlan(args: FeishuCommandDisconnectArgs) {
  const query = new QueryBuilder();
  const eligible = query.$with("eligible_command_disconnect_account").as(
    query
      .select({
        id: connectors.id,
        customConnectorId: connectors.customConnectorId,
        authMethod: connectors.authMethod,
        storageVersion: connectors.storageVersion,
        externalId: connectors.externalId,
      })
      .from(connectors)
      .innerJoin(
        feishuOrgInstallations,
        and(
          eq(feishuOrgInstallations.id, args.installationId),
          eq(feishuOrgInstallations.orgId, args.orgId),
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
          eq(connectors.id, args.memberConnectorId),
          eq(connectors.orgId, args.orgId),
          eq(connectors.userId, args.userId),
          eq(connectors.authMethod, "oauth"),
          eq(connectors.needsReconnect, false),
          eq(connectors.externalId, args.feishuOpenId),
        ),
      ),
  );
  const condition = and(
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
  return { eligible, condition };
}

/** Keep the message command's exact-member unlink separate from HTTP disconnect. */
export function feishuCommandDisconnectSql(args: FeishuCommandDisconnectArgs) {
  const query = new QueryBuilder();
  const { eligible, condition } = commandDisconnectAccountPlan(args);
  const removed = query.$with("removed_command_disconnect_member", {
    id: feishuOrgConnections.id,
  }).as(sql`DELETE FROM ${feishuOrgConnections}
    WHERE ${eq(feishuOrgConnections.id, args.memberId)} RETURNING id`);
  // Unlink first: the account FK must not update the member being deleted.
  const unlinkFinished = gte(query.select({ total: count() }).from(removed), 0);
  const deleted = query
    .$with("deleted_command_disconnect_account", {
      id: connectors.id,
    })
    .as(
      sql`DELETE FROM ${connectors} WHERE ${and(condition, unlinkFinished)} RETURNING id`,
    );
  const accountIds = query.select({ id: deleted.id }).from(deleted);
  const cleared = query.$with("cleared_command_disconnect_selections", {
    id: chatThreadConnectorSelections.connectorId,
  }).as(sql`DELETE FROM ${chatThreadConnectorSelections}
    WHERE ${inArray(chatThreadConnectorSelections.connectorId, accountIds)} RETURNING connector_id`);
  const cursorCondition = inArray(
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
  const discarded = query
    .$with("discarded_command_disconnect_cursors", {
      id: googleFormsAutomationCursors.automationId,
    })
    .as(
      sql`DELETE FROM ${googleFormsAutomationCursors} WHERE ${cursorCondition} RETURNING automation_id`,
    );
  const accountsComplete = or(
    eq(query.select({ total: count() }).from(removed), 0),
    eq(
      query.select({ total: count() }).from(deleted),
      query.select({ total: count() }).from(eligible),
    ),
  );
  return query
    .with(eligible, removed, deleted, cleared, discarded)
    .select({
      // A changed account must roll back the preceding unlink, not publish success.
      complete: sql`1 / CASE WHEN ${and(
        accountsComplete,
        gte(query.select({ total: count() }).from(cleared), 0),
        gte(query.select({ total: count() }).from(discarded), 0),
      )} THEN 1 ELSE 0 END`
        .mapWith(zodDriverValueDecoder(literal(1)))
        .as("complete"),
    })
    .from(
      query
        .select({ total: count() })
        .from(removed)
        .as("command_disconnect_completion"),
    )
    .getSQL();
}

export interface FeishuDisconnectArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly installationId: string;
  readonly platform?: FeishuPlatform;
}
export function feishuDisconnectInstallationFilter(args: FeishuDisconnectArgs) {
  return and(
    eq(feishuOrgInstallations.orgId, args.orgId),
    eq(feishuOrgInstallations.platform, args.platform ?? "feishu"),
    eq(feishuOrgInstallations.id, args.installationId),
  );
}
