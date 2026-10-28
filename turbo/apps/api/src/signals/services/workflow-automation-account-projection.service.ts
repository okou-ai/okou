import type { ConnectorAccountTarget } from "@okouai/api-contracts/contracts/connector-accounts";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { and, eq, inArray, not, sql, type SQL } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { notionWorkflowPendingEvents } from "@okouai/db/schema/notion-event";

import {
  gmailAutomationProjectionColumns,
  gmailAutomationProjectionConfig,
  gmailAutomationProjectionCondition,
} from "./gmail-automation-account.service";
import {
  googleCalendarAutomationProjectionColumns,
  googleCalendarAutomationProjectionCondition,
} from "./google-calendar-automation-account.service";
import {
  googleMeetAutomationProjectionColumns,
  googleMeetAutomationProjectionCondition,
} from "./google-meet-automation-account.service";
import {
  notionAutomationProjectionColumns,
  notionAutomationProjectionCondition,
  notionAutomationProjectionValues,
} from "./notion-automation-account.service";

export type ProjectedAutomation =
  | Pick<
      typeof workflowAutomations.$inferSelect,
      "id" | "workflowId" | "eventConnectorId" | "eventType" | "eventConfig"
    >
  | Pick<
      typeof workflowAutomations.$inferSelect,
      "id" | "workflowId" | "eventConnectorId"
    >;

export interface PreparedDefaultAccountProjection {
  readonly id: string;
  readonly connector_id: string | null;
  readonly replace_config: boolean;
  readonly event_config: typeof workflowAutomations.$inferSelect.eventConfig;
}

export function workflowAutomationOwnerProjectionReadPlan(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly target: ConnectorAccountTarget;
}) {
  if (args.target.kind !== "builtin") {
    return null;
  }
  switch (args.target.connectorSlug) {
    case "gmail": {
      return {
        connectorSlug: "gmail" as const,
        columns: gmailAutomationProjectionColumns(),
        where: gmailAutomationProjectionCondition(args),
      };
    }
    case "google-calendar": {
      return {
        connectorSlug: "google-calendar" as const,
        columns: googleCalendarAutomationProjectionColumns(),
        where: googleCalendarAutomationProjectionCondition(args),
      };
    }
    case "google-meet": {
      return {
        connectorSlug: "google-meet" as const,
        columns: googleMeetAutomationProjectionColumns(),
        where: googleMeetAutomationProjectionCondition(args),
      };
    }
    case "notion": {
      return {
        connectorSlug: "notion" as const,
        columns: notionAutomationProjectionColumns(),
        where: notionAutomationProjectionCondition(args),
      };
    }
    default: {
      return null;
    }
  }
}

/** Pure write descriptors; the publication owner executes every write together. */
export function preparedDefaultAccountProjectionPlan(
  rows: readonly PreparedDefaultAccountProjection[],
  defaultExists: SQL,
) {
  const source = sql`jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
    AS default_projection_input(id uuid, connector_id uuid, replace_config boolean, event_config jsonb)`;
  const identity = eq(workflowAutomations.id, sql`default_projection_input.id`);
  return {
    configured: {
      from: source,
      values: {
        eventConnectorId: sql`default_projection_input.connector_id`,
        eventConfig: sql`default_projection_input.event_config`,
      },
      where: and(
        identity,
        sql`default_projection_input.replace_config`,
        defaultExists,
      ),
    },
    selected: {
      from: source,
      values: { eventConnectorId: sql`default_projection_input.connector_id` },
      where: and(
        identity,
        not(sql`default_projection_input.replace_config`),
        defaultExists,
      ),
    },
    pendingEvents: inArray(
      notionWorkflowPendingEvents.automationId,
      new QueryBuilder()
        .select({
          id: sql`default_projection_input.id`.mapWith(workflowAutomations.id),
        })
        .from(source),
    ),
  };
}

export function workflowAutomationProjectionValues(
  automation: ProjectedAutomation,
  eventConnectorId: string | null,
  connectorSlug: string,
) {
  if ("eventType" in automation && connectorSlug === "notion") {
    return notionAutomationProjectionValues(automation, eventConnectorId);
  }
  if (automation.eventConnectorId === eventConnectorId) {
    return null;
  }
  if ("eventType" in automation) {
    const eventConfig = gmailAutomationProjectionConfig(automation);
    return { eventConnectorId, eventConfig };
  }
  return { eventConnectorId };
}
