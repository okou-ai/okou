import {
  notionChildPageCreatedEventConfigSchema,
  notionDatabaseItemCreatedEventConfigSchema,
  notionPageContentUpdatedEventConfigSchema,
} from "@okouai/api-contracts/contracts/workflows";
import { notionWorkflowPendingEvents } from "@okouai/db/schema/notion-event";
import {
  workflowAutomations,
  type WorkflowAutomationEventConfig,
} from "@okouai/db/schema/workflow";
import { and, eq, inArray } from "drizzle-orm";

import type { Db, ReadonlyDb } from "../external/db";
import { nowDate } from "../../lib/time";
import { resolveWorkflowAutomationConnectorId } from "./workflow-automation-account.service";

const NOTION_EVENT_TYPES = [
  "notion-child-page-created",
  "notion-database-item-created",
  "notion-page-content-updated",
] as const;

const NOTION_ACCOUNT_CHANGED_SKIP_REASON =
  "Notion account selection changed before the event was processed";
const NOTION_ACCOUNT_RECONNECTED_SKIP_REASON =
  "Notion account identity changed before the event was processed";
export async function resolveNotionAutomationConnectorId(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly workflowId: string;
  },
): Promise<string | null> {
  return await resolveWorkflowAutomationConnectorId(db, {
    ...args,
    connectorSlug: "notion",
  });
}

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

async function skipActivePendingEvents(
  db: Db,
  condition: ReturnType<typeof eq>,
  reason: string,
): Promise<void> {
  const currentTime = nowDate();
  await db
    .update(notionWorkflowPendingEvents)
    .set({
      status: "skipped",
      skipReason: reason,
      processedAt: currentTime,
      updatedAt: currentTime,
    })
    .where(
      and(
        condition,
        inArray(notionWorkflowPendingEvents.status, ["pending", "running"]),
      ),
    );
}

export async function invalidateNotionPendingEventsForConnector(
  db: Db,
  connectorId: string,
): Promise<void> {
  await skipActivePendingEvents(
    db,
    eq(notionWorkflowPendingEvents.connectorId, connectorId),
    NOTION_ACCOUNT_RECONNECTED_SKIP_REASON,
  );
}

export async function reprojectNotionAutomationsForOwner(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
  },
): Promise<void> {
  const automations = await db
    .select({
      id: workflowAutomations.id,
      workflowId: workflowAutomations.workflowId,
      eventType: workflowAutomations.eventType,
      eventConfig: workflowAutomations.eventConfig,
      eventConnectorId: workflowAutomations.eventConnectorId,
    })
    .from(workflowAutomations)
    .where(
      and(
        eq(workflowAutomations.orgId, args.orgId),
        eq(workflowAutomations.ownerUserId, args.userId),
        eq(workflowAutomations.kind, "event"),
        inArray(workflowAutomations.eventType, [...NOTION_EVENT_TYPES]),
      ),
    );

  for (const automation of automations) {
    const eventConnectorId = await resolveNotionAutomationConnectorId(db, {
      ...args,
      workflowId: automation.workflowId,
    });
    if (
      automation.eventConnectorId === eventConnectorId &&
      (eventConnectorId === null ||
        notionConfigConnectorId(
          automation.eventType,
          automation.eventConfig,
        ) === eventConnectorId)
    ) {
      continue;
    }
    const eventConfig =
      eventConnectorId === null
        ? automation.eventConfig
        : notionConfigWithConnectorId(
            automation.eventType,
            automation.eventConfig,
            eventConnectorId,
          );
    await db
      .update(workflowAutomations)
      .set({
        eventConnectorId,
        ...(eventConfig === null ? {} : { eventConfig }),
      })
      .where(eq(workflowAutomations.id, automation.id));
    await skipActivePendingEvents(
      db,
      eq(notionWorkflowPendingEvents.automationId, automation.id),
      NOTION_ACCOUNT_CHANGED_SKIP_REASON,
    );
  }
}
