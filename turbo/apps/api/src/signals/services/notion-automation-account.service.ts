import {
  notionChildPageCreatedEventConfigSchema,
  notionDatabaseItemCreatedEventConfigSchema,
  notionPageContentUpdatedEventConfigSchema,
} from "@okouai/api-contracts/contracts/workflows";
import { notionWorkflowPendingEvents } from "@okouai/db/schema/notion-event";
import type { WorkflowAutomationEventConfig } from "@okouai/db/schema/workflow";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { and, eq, inArray } from "drizzle-orm";

import { nowDate } from "../../lib/time";

const NOTION_EVENT_TYPES = [
  "notion-child-page-created",
  "notion-database-item-created",
  "notion-page-content-updated",
] as const;

export const NOTION_ACCOUNT_CHANGED_SKIP_REASON =
  "Notion account selection changed before the event was processed";
const NOTION_ACCOUNT_RECONNECTED_SKIP_REASON =
  "Notion account identity changed before the event was processed";
export function notionConfigWithConnectorId(
  eventType: string | null,
  eventConfig: unknown,
  connectorId: string,
): WorkflowAutomationEventConfig | null {
  if (eventType === "notion-child-page-created") {
    const config =
      notionChildPageCreatedEventConfigSchema.safeParse(eventConfig);
    return config.success ? { ...config.data, connectorId } : null;
  }
  if (eventType === "notion-database-item-created") {
    const config =
      notionDatabaseItemCreatedEventConfigSchema.safeParse(eventConfig);
    return config.success ? { ...config.data, connectorId } : null;
  }
  if (eventType === "notion-page-content-updated") {
    const config =
      notionPageContentUpdatedEventConfigSchema.safeParse(eventConfig);
    return config.success ? { ...config.data, connectorId } : null;
  }
  return null;
}

export function notionConfigConnectorId(
  eventType: string | null,
  eventConfig: unknown,
): string | null {
  if (eventType === "notion-child-page-created") {
    const config =
      notionChildPageCreatedEventConfigSchema.safeParse(eventConfig);
    return config.success ? config.data.connectorId : null;
  }
  if (eventType === "notion-database-item-created") {
    const config =
      notionDatabaseItemCreatedEventConfigSchema.safeParse(eventConfig);
    return config.success ? config.data.connectorId : null;
  }
  if (eventType === "notion-page-content-updated") {
    const config =
      notionPageContentUpdatedEventConfigSchema.safeParse(eventConfig);
    return config.success ? config.data.connectorId : null;
  }
  return null;
}

export function notionPendingEventsSkipWrite(
  condition: ReturnType<typeof eq>,
  reason: string,
) {
  const currentTime = nowDate();
  return {
    table: notionWorkflowPendingEvents,
    values: {
      status: "skipped" as const,
      skipReason: reason,
      processedAt: currentTime,
      updatedAt: currentTime,
    },
    where: and(
      condition,
      inArray(notionWorkflowPendingEvents.status, ["pending", "running"]),
    ),
  };
}

export function notionPendingEventsReconnectScope(connectorId: string) {
  return {
    condition: eq(notionWorkflowPendingEvents.connectorId, connectorId),
    reason: NOTION_ACCOUNT_RECONNECTED_SKIP_REASON,
  };
}

export function notionAutomationProjectionColumns() {
  return {
    id: workflowAutomations.id,
    workflowId: workflowAutomations.workflowId,
    eventType: workflowAutomations.eventType,
    eventConfig: workflowAutomations.eventConfig,
    eventConnectorId: workflowAutomations.eventConnectorId,
  };
}

export function notionAutomationProjectionCondition(args: {
  readonly orgId: string;
  readonly userId: string;
}) {
  return and(
    eq(workflowAutomations.orgId, args.orgId),
    eq(workflowAutomations.ownerUserId, args.userId),
    eq(workflowAutomations.kind, "event"),
    inArray(workflowAutomations.eventType, [...NOTION_EVENT_TYPES]),
  );
}

export function notionAutomationProjectionValues(
  automation: Pick<
    typeof workflowAutomations.$inferSelect,
    "eventType" | "eventConfig" | "eventConnectorId"
  >,
  eventConnectorId: string | null,
) {
  if (
    automation.eventConnectorId === eventConnectorId &&
    (eventConnectorId === null ||
      notionConfigConnectorId(automation.eventType, automation.eventConfig) ===
        eventConnectorId)
  ) {
    return null;
  }
  const eventConfig =
    eventConnectorId === null
      ? automation.eventConfig
      : notionConfigWithConnectorId(
          automation.eventType,
          automation.eventConfig,
          eventConnectorId,
        );
  return {
    eventConnectorId,
    ...(eventConfig === null ? {} : { eventConfig }),
  };
}
