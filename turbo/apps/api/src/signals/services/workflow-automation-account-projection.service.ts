import type { ConnectorAccountTarget } from "@okouai/api-contracts/contracts/connector-accounts";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { and, eq, inArray, not, sql, type SQL } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { notionWorkflowPendingEvents } from "@okouai/db/schema/notion-event";

import type { Db } from "../external/db";
import {
  gmailAutomationProjectionColumns,
  gmailAutomationProjectionConfig,
  gmailAutomationProjectionCondition,
} from "./gmail-automation-account.service";
import {
  googleCalendarAutomationProjectionColumns,
  googleCalendarAutomationProjectionCondition,
} from "./google-calendar-automation-account.service";
import { googleFormsAccountProjectionStatement } from "./google-forms-automation-account.service";
import {
  googleMeetAutomationProjectionColumns,
  googleMeetAutomationProjectionCondition,
} from "./google-meet-automation-account.service";
import {
  notionAutomationProjectionColumns,
  notionAutomationProjectionCondition,
  notionAutomationPendingEventsScope,
  notionAutomationProjectionValues,
  notionPendingEventsSkipWrite,
} from "./notion-automation-account.service";
import { isWorkflowAutomationAccountConnectorSlug } from "./workflow-automation-account-classification.service";
import {
  workflowAutomationDefaultAccountReadPlan,
  workflowAutomationSelectedAccountReadPlan,
} from "./workflow-automation-account.service";

type ProjectedAutomation =
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

export async function reprojectWorkflowAutomationsForOwner(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly target: ConnectorAccountTarget;
  },
  signal: AbortSignal,
): Promise<void> {
  if (
    args.target.kind !== "builtin" ||
    !isWorkflowAutomationAccountConnectorSlug(args.target.connectorSlug)
  ) {
    return;
  }
  const connectorSlug = args.target.connectorSlug;
  switch (connectorSlug) {
    case "gmail":
    case "google-calendar":
    case "google-meet":
    case "notion": {
      const projectionDb = db;
      const projectionArgs = args;
      await (async () => {
        const automations: ProjectedAutomation[] =
          connectorSlug === "gmail" || connectorSlug === "notion"
            ? await projectionDb
                .select(
                  connectorSlug === "gmail"
                    ? gmailAutomationProjectionColumns()
                    : notionAutomationProjectionColumns(),
                )
                .from(workflowAutomations)
                .where(
                  connectorSlug === "gmail"
                    ? gmailAutomationProjectionCondition(projectionArgs)
                    : notionAutomationProjectionCondition(projectionArgs),
                )
            : await projectionDb
                .select(
                  connectorSlug === "google-calendar"
                    ? googleCalendarAutomationProjectionColumns()
                    : googleMeetAutomationProjectionColumns(),
                )
                .from(workflowAutomations)
                .where(
                  connectorSlug === "google-calendar"
                    ? googleCalendarAutomationProjectionCondition(
                        projectionArgs,
                      )
                    : googleMeetAutomationProjectionCondition(projectionArgs),
                );

        for (const automation of automations) {
          const workflowScope = {
            ...projectionArgs,
            workflowId: automation.workflowId,
          };
          const eventConnectorId = await (async () => {
            const accountScope = {
              ...workflowScope,
              connectorSlug,
            };
            return await (async () => {
              const selected =
                workflowAutomationSelectedAccountReadPlan(accountScope);
              const [selection] = await projectionDb
                .select(selected.columns)
                .from(selected.from)
                .innerJoin(selected.join.table, selected.join.on)
                .where(selected.where)
                .limit(selected.limit);
              if (selection) {
                return selection.connectorId;
              }
              const fallback =
                workflowAutomationDefaultAccountReadPlan(accountScope);
              const [defaultAccount] = await projectionDb
                .select(fallback.columns)
                .from(fallback.from)
                .where(fallback.where)
                .limit(fallback.limit);
              return defaultAccount?.connectorId ?? null;
            })();
          })();
          const values = workflowAutomationProjectionValues(
            automation,
            eventConnectorId,
            connectorSlug,
          );
          if (values === null) {
            continue;
          }
          await projectionDb
            .update(workflowAutomations)
            .set(values)
            .where(eq(workflowAutomations.id, automation.id));
          if (connectorSlug === "notion") {
            const pendingEventDb = projectionDb;
            const scope = notionAutomationPendingEventsScope(automation.id);
            await (async () => {
              const write = notionPendingEventsSkipWrite(
                scope.condition,
                scope.reason,
              );
              await pendingEventDb
                .update(write.table)
                .set(write.values)
                .where(write.where);
            })();
          }
        }
      })();
      signal.throwIfAborted();
      return;
    }
    case "google-forms": {
      await db.execute(googleFormsAccountProjectionStatement(args));
      signal.throwIfAborted();
      return;
    }
  }
  return connectorSlug satisfies never;
}
