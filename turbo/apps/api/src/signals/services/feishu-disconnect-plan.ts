import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";
import type { FeishuPlatform } from "@okouai/core/feishu-platform";
import { connectors } from "@okouai/db/schema/connector";
import { secrets } from "@okouai/db/schema/secret";
import { variables } from "@okouai/db/schema/variable";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { and, eq, inArray, sql } from "drizzle-orm";

export function feishuDisconnectCleanupPlan(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly customConnectorId: string;
  readonly memberConnectorId: string;
}) {
  const id = args.memberConnectorId;
  return {
    columns: { id: connectors.id },
    account: and(
      eq(connectors.customConnectorId, args.customConnectorId),
      eq(connectors.id, id),
      eq(connectors.userId, args.userId),
      eq(connectors.orgId, args.orgId),
    ),
    secret: eq(secrets.connectorId, id),
    variable: eq(variables.connectorId, id),
    connector: eq(connectors.id, id),
    selection: inArray(chatThreadConnectorSelections.connectorId, [id]),
    cursorColumns: { id: workflowAutomations.id },
    cursor: and(
      eq(workflowAutomations.eventType, "google-forms-response-submitted"),
      sql`${workflowAutomations.eventConfig} ->> 'connectorId' = ANY(${sql.param([id])}::text[])`,
    ),
    defer: sql`SET CONSTRAINTS fk_chat_thread_connector_selections_connector_slug, fk_chat_thread_connector_selections_custom_connector DEFERRED`,
    immediate: sql`SET CONSTRAINTS fk_chat_thread_connector_selections_connector_slug, fk_chat_thread_connector_selections_custom_connector IMMEDIATE`,
  };
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
