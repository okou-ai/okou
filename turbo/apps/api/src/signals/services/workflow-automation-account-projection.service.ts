import type { ConnectorAccountTarget } from "@okouai/api-contracts/contracts/connector-accounts";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { eq } from "drizzle-orm";

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
import { reprojectStripeInvoicePaidAutomationsForOwner } from "./stripe-invoice-paid-workflow-automation.service";
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

function workflowAutomationProjectionValues(
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
    case "stripe": {
      await reprojectStripeInvoicePaidAutomationsForOwner(db, args, signal);
      return;
    }
  }
  return connectorSlug satisfies never;
}
