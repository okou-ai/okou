import {
  notionChildPageCreatedEventConfigSchema,
  notionDatabaseItemCreatedEventConfigSchema,
  notionPageContentUpdatedEventConfigSchema,
} from "@okouai/api-contracts/contracts/workflows";
import { notionWorkflowPendingEvents } from "@okouai/db/schema/notion-event";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "../../lib/db-types";
import { nowDate } from "../../lib/time";

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
function notionConfigMatchesPendingEvent(
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
  readonly chatThreadId: string;
  readonly eventType: string | null;
  readonly eventConfig: unknown;
  readonly currentTime: Date;
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

/** Admit one prepared page event only for its still-current source and receipt. */
export async function persistNotionWorkflowSource(
  tx: Tx,
  args: {
    readonly chatThreadId: string;
    readonly automationId: string;
    readonly source: NotionQueueSource;
  },
  signal: AbortSignal,
): Promise<void> {
  const { source } = args;
  const connectorId = source.pending.connectorId;
  if (connectorId === null) {
    throw new NotionAutomationSourceChangedError();
  }
  const [automation] = await tx
    .select({
      eventType: workflowAutomations.eventType,
      eventConfig: workflowAutomations.eventConfig,
    })
    .from(workflowAutomations)
    .where(
      and(
        eq(workflowAutomations.id, source.automationId),
        eq(workflowAutomations.enabled, true),
        eq(workflowAutomations.eventConnectorId, connectorId),
      ),
    )
    .limit(1);
  if (
    !automation ||
    !notionConfigMatchesPendingEvent(
      automation.eventType,
      automation.eventConfig,
      source.pending,
    )
  ) {
    throw new NotionAutomationSourceChangedError();
  }
  const currentTime = nowDate();
  const [processed] = await tx
    .update(notionWorkflowPendingEvents)
    .set({
      status: "processed",
      pageTitle: source.pageTitle,
      pageUrl: source.pageUrl,
      parentTitle: source.parentTitle,
      parentUrl: source.parentUrl,
      processedAt: currentTime,
      updatedAt: currentTime,
    })
    .where(
      and(
        eq(notionWorkflowPendingEvents.id, source.pending.id),
        eq(notionWorkflowPendingEvents.automationId, source.automationId),
        eq(notionWorkflowPendingEvents.connectorId, connectorId),
        eq(notionWorkflowPendingEvents.status, "running"),
      ),
    )
    .returning({ id: notionWorkflowPendingEvents.id });
  if (!processed) {
    throw new NotionAutomationSourceChangedError();
  }
  if (
    (
      await tx.execute(
        notionQueueAdmissionSql({
          source,
          connectorId,
          chatThreadId: args.chatThreadId,
          eventType: automation.eventType,
          eventConfig: automation.eventConfig,
          currentTime,
        }),
      )
    ).rowCount === 0
  ) {
    throw new NotionAutomationSourceChangedError();
  }
  signal.throwIfAborted();
}
