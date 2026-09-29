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
import { and, eq } from "drizzle-orm";
import { parseRawRows } from "../../lib/db-raw-rows";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { builtinConnectorStateLockStatement } from "./auth-state-lock.service";
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
      await tx.execute(
        builtinConnectorStateLockStatement({
          orgId: source.orgId,
          userId: source.userId,
          connectorSlug: "notion",
        }),
      );
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
        .for("update")
        .limit(1);
      const [pending] = await tx
        .select({ id: notionWorkflowPendingEvents.id })
        .from(notionWorkflowPendingEvents)
        .where(
          and(
            eq(notionWorkflowPendingEvents.id, source.pending.id),
            eq(notionWorkflowPendingEvents.automationId, source.automationId),
            eq(notionWorkflowPendingEvents.connectorId, connectorId),
            eq(notionWorkflowPendingEvents.status, "running"),
          ),
        )
        .for("update")
        .limit(1);
      if (
        !automation ||
        !pending ||
        !notionConfigMatchesPendingEvent(
          automation.eventType,
          automation.eventConfig,
          source.pending,
        )
      ) {
        throw new NotionAutomationSourceChangedError();
      }
      const currentTime = nowDate();
      await tx
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
        .where(eq(notionWorkflowPendingEvents.id, source.pending.id));
      await tx
        .insert(queuedChatThreads)
        .values({
          chatThreadId: input.event.chatThreadId,
          orgId: source.orgId,
          queuedAt: currentTime,
        })
        .onConflictDoUpdate({
          target: queuedChatThreads.chatThreadId,
          set: { claimId: null, claimExpiresAt: null },
        });
      signal.throwIfAborted();
      return event.id;
    });
  },
);
