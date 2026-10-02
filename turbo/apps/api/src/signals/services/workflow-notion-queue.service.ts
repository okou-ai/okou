import {
  notionChildPageCreatedEventConfigSchema,
  notionDatabaseItemCreatedEventConfigSchema,
  notionPageContentUpdatedEventConfigSchema,
} from "@okouai/api-contracts/contracts/workflows";
import { notionWorkflowPendingEvents } from "@okouai/db/schema/notion-event";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { and, eq, sql } from "drizzle-orm";

export interface NotionQueueSource {
  readonly automationId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly pending: Pick<
    typeof notionWorkflowPendingEvents.$inferSelect,
    "id" | "connectorId" | "eventFamily" | "scopeType" | "scopeId"
  >;
  readonly pageTitle: string | null;
  readonly pageUrl: string | null;
  readonly parentTitle: string | null;
  readonly parentUrl: string;
}

export class NotionAutomationSourceChangedError extends Error {
  constructor() {
    super("Notion automation source changed before durable queue admission");
    this.name = "NotionAutomationSourceChangedError";
  }
}
export function notionConfigMatchesPendingEvent(
  eventType: string | null,
  eventConfig: unknown,
  pending: NotionQueueSource["pending"],
): boolean {
  if (eventType === "notion-child-page-created") {
    const config =
      notionChildPageCreatedEventConfigSchema.safeParse(eventConfig);
    return (
      config.success &&
      pending.eventFamily === "new_child_page" &&
      pending.scopeType === "page" &&
      config.data.connectorId === pending.connectorId &&
      config.data.parentPage.id === pending.scopeId
    );
  }
  if (eventType === "notion-database-item-created") {
    const config =
      notionDatabaseItemCreatedEventConfigSchema.safeParse(eventConfig);
    return (
      config.success &&
      pending.eventFamily === "new_database_item" &&
      pending.scopeType === "data_source" &&
      config.data.connectorId === pending.connectorId &&
      config.data.dataSource.id === pending.scopeId
    );
  }
  if (eventType === "notion-page-content-updated") {
    const config =
      notionPageContentUpdatedEventConfigSchema.safeParse(eventConfig);
    return (
      config.success &&
      pending.eventFamily === "page_content_updated" &&
      (config.data.scope.type === "page" ? "page" : "data_source") ===
        pending.scopeType &&
      (config.data.scope.type === "page"
        ? config.data.scope.page.id
        : config.data.scope.dataSource.id) === pending.scopeId &&
      config.data.connectorId === pending.connectorId
    );
  }
  return false;
}

/** Queue admission gated by the consumer still having the matched config. */
function notionQueueAdmissionSql(args: {
  readonly source: NotionQueueSource;
  readonly connectorId: string;
  readonly eventType: string | null;
  readonly eventConfig: unknown;
}) {
  return sql`SELECT 1 WHERE EXISTS (
      SELECT 1 FROM ${workflowAutomations}
      WHERE ${and(
        eq(workflowAutomations.id, args.source.automationId),
        eq(workflowAutomations.enabled, true),
        eq(workflowAutomations.eventConnectorId, args.connectorId),
        sql`${workflowAutomations.eventType} IS NOT DISTINCT FROM ${args.eventType}`,
        sql`${workflowAutomations.eventConfig} IS NOT DISTINCT FROM ${JSON.stringify(args.eventConfig ?? null)}::jsonb`,
      )}
    )`;
}

/** CAS receipt publication is gated by the exact prepared consumer config. */
export function notionQueueReceiptSql(args: {
  readonly source: NotionQueueSource;
  readonly connectorId: string;
  readonly eventType: string | null;
  readonly eventConfig: unknown;
  readonly currentTime: Date;
}) {
  const timestamp = args.currentTime.toISOString();
  return sql`UPDATE ${notionWorkflowPendingEvents}
    SET status = 'processed', page_title = ${args.source.pageTitle}, page_url = ${args.source.pageUrl},
      parent_title = ${args.source.parentTitle}, parent_url = ${args.source.parentUrl},
      processed_at = ${timestamp}::timestamp, updated_at = ${timestamp}::timestamp
    WHERE ${and(
      eq(notionWorkflowPendingEvents.id, args.source.pending.id),
      eq(notionWorkflowPendingEvents.automationId, args.source.automationId),
      eq(notionWorkflowPendingEvents.connectorId, args.connectorId),
      eq(notionWorkflowPendingEvents.status, "running"),
    )} AND EXISTS (${notionQueueAdmissionSql(args)}) RETURNING id`;
}
