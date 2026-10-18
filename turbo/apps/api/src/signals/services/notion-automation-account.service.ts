import {
  notionChildPageCreatedEventConfigSchema,
  notionDatabaseItemCreatedEventConfigSchema,
  notionPageContentUpdatedEventConfigSchema,
} from "@okouai/api-contracts/contracts/workflows";
import { notionWorkflowPendingEvents } from "@okouai/db/schema/notion-event";
import type { WorkflowAutomationEventConfig } from "@okouai/db/schema/workflow";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { and, eq, inArray } from "drizzle-orm";

import type { Db } from "../external/db";
import { nowDate } from "../../lib/time";
import {
  workflowAutomationDefaultAccountReadPlan,
  workflowAutomationSelectedAccountReadPlan,
} from "./workflow-automation-account.service";

const NOTION_EVENT_TYPES = [
  "notion-child-page-created",
  "notion-database-item-created",
  "notion-page-content-updated",
] as const;

const NOTION_ACCOUNT_CHANGED_SKIP_REASON =
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
    const workflowScope = {
      ...args,
      workflowId: automation.workflowId,
    };
    const eventConnectorId = await (async () => {
      const accountScope = {
        ...workflowScope,
        connectorSlug: "notion" as const,
      };
      return await (async () => {
        const selected =
          workflowAutomationSelectedAccountReadPlan(accountScope);
        const [selection] = await db
          .select(selected.columns)
          .from(selected.from)
          .innerJoin(selected.join.table, selected.join.on)
          .where(selected.where)
          .limit(selected.limit);
        if (selection) {
          return selection.connectorId;
        }
        const fallback = workflowAutomationDefaultAccountReadPlan(accountScope);
        const [defaultAccount] = await db
          .select(fallback.columns)
          .from(fallback.from)
          .where(fallback.where)
          .limit(fallback.limit);
        return defaultAccount?.connectorId ?? null;
      })();
    })();
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
    const pendingEventDb = db;
    const pendingEventCondition = eq(
      notionWorkflowPendingEvents.automationId,
      automation.id,
    );
    const pendingEventReason = NOTION_ACCOUNT_CHANGED_SKIP_REASON;
    await (async () => {
      const write = notionPendingEventsSkipWrite(
        pendingEventCondition,
        pendingEventReason,
      );
      await pendingEventDb
        .update(write.table)
        .set(write.values)
        .where(write.where);
    })();
  }
}
