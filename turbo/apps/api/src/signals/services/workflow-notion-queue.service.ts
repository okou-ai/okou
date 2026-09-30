import {
  notionChildPageCreatedEventConfigSchema,
  notionDatabaseItemCreatedEventConfigSchema,
  notionPageContentUpdatedEventConfigSchema,
} from "@okouai/api-contracts/contracts/workflows";
import { chatAutomationContext } from "@okouai/db/schema/chat-automation-context";
import { notionWorkflowPendingEvents } from "@okouai/db/schema/notion-event";
import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { parseRawRows } from "../../lib/db-raw-rows";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import {
  appendCanonicalChatEventsSql,
  chatEventAppendResultSchema,
} from "./chat-event-append.service";
import type { PreparedWorkflowAutomationQueueInput } from "./workflow-chat-event-queue.service";

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
  const timestamp = sql`${args.currentTime.toISOString()}::timestamp`;
  return sql`INSERT INTO ${queuedChatThreads} (chat_thread_id, org_id, queued_at)
    SELECT ${args.chatThreadId}::uuid, ${args.source.orgId}, ${timestamp}
    WHERE EXISTS (
      SELECT 1 FROM ${workflowAutomations}
      WHERE ${and(
        eq(workflowAutomations.id, args.source.automationId),
        eq(workflowAutomations.enabled, true),
        eq(workflowAutomations.eventConnectorId, args.connectorId),
        sql`${workflowAutomations.eventType} IS NOT DISTINCT FROM ${args.eventType}`,
        sql`${workflowAutomations.eventConfig} IS NOT DISTINCT FROM ${JSON.stringify(args.eventConfig ?? null)}::jsonb`,
      )}
    )
    ON CONFLICT (chat_thread_id) DO UPDATE SET claim_id = NULL, claim_expires_at = NULL`;
}

/** Admit one prepared page event only for its still-current source and receipt. */
export const enqueueNotionWorkflowInput$ = command(
  async (
    { set },
    args: {
      readonly input: PreparedWorkflowAutomationQueueInput;
      readonly source: NotionQueueSource;
    },
    signal: AbortSignal,
  ): Promise<string | null> => {
    const db = set(writeDb$);
    const { input, source } = args;
    const connectorId = source.pending.connectorId;
    if (connectorId === null) {
      throw new NotionAutomationSourceChangedError();
    }
    return await db.transaction(async (tx) => {
      await tx
        .insert(chatAutomationContext)
        .values(input.context)
        .onConflictDoNothing();
      const [event] = parseRawRows(
        chatEventAppendResultSchema,
        await tx.execute(
          appendCanonicalChatEventsSql([input.event], input.conflict),
        ),
      );
      if (!event) {
        if (input.conflict === "none") {
          throw new Error("Workflow queue event insert returned no row");
        }
        return null;
      }
      // No source rows are locked. The consumer config is matched in memory,
      // the receipt moves running -> processed by compare-and-set, and the
      // queue record is admitted only while the consumer still has the same
      // enabled config. Any zero-row step rolls the admission back. A
      // disable racing these statements may still admit one event, which
      // dispatch re-checks.
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
              chatThreadId: input.event.chatThreadId,
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
      return event.id;
    });
  },
);
