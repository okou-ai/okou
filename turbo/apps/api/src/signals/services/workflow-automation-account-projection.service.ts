import type { ConnectorAccountTarget } from "@okouai/api-contracts/contracts/connector-accounts";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { eq } from "drizzle-orm";

import type { Db } from "../external/db";
import { reprojectGmailAutomationsForOwner } from "./gmail-automation-account.service";
import {
  googleCalendarAutomationProjectionColumns,
  googleCalendarAutomationProjectionCondition,
} from "./google-calendar-automation-account.service";
import { googleFormsAccountProjectionStatement } from "./google-forms-automation-account.service";
import { reprojectGoogleMeetAutomationsForOwner } from "./google-meet-automation-account.service";
import { reprojectNotionAutomationsForOwner } from "./notion-automation-account.service";
import { reprojectStripeInvoicePaidAutomationsForOwner } from "./stripe-invoice-paid-workflow-automation.service";
import { isWorkflowAutomationAccountConnectorSlug } from "./workflow-automation-account-classification.service";
import {
  workflowAutomationDefaultAccountReadPlan,
  workflowAutomationSelectedAccountReadPlan,
} from "./workflow-automation-account.service";

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
  switch (args.target.connectorSlug) {
    case "gmail": {
      await reprojectGmailAutomationsForOwner(db, args);
      signal.throwIfAborted();
      return;
    }
    case "google-calendar": {
      const calendarProjectionDb = db;
      const calendarProjectionArgs = args;
      await (async () => {
        const automations = await calendarProjectionDb
          .select(googleCalendarAutomationProjectionColumns())
          .from(workflowAutomations)
          .where(
            googleCalendarAutomationProjectionCondition(calendarProjectionArgs),
          );

        for (const automation of automations) {
          const workflowScope = {
            ...calendarProjectionArgs,
            workflowId: automation.workflowId,
          };
          const eventConnectorId = await (async () => {
            const accountScope = {
              ...workflowScope,
              connectorSlug: "google-calendar" as const,
            };
            return await (async () => {
              const selected =
                workflowAutomationSelectedAccountReadPlan(accountScope);
              const [selection] = await calendarProjectionDb
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
              const [defaultAccount] = await calendarProjectionDb
                .select(fallback.columns)
                .from(fallback.from)
                .where(fallback.where)
                .limit(fallback.limit);
              return defaultAccount?.connectorId ?? null;
            })();
          })();
          if (automation.eventConnectorId === eventConnectorId) {
            continue;
          }
          await calendarProjectionDb
            .update(workflowAutomations)
            .set({ eventConnectorId })
            .where(eq(workflowAutomations.id, automation.id));
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
    case "google-meet": {
      await reprojectGoogleMeetAutomationsForOwner(db, args);
      signal.throwIfAborted();
      return;
    }
    case "notion": {
      await reprojectNotionAutomationsForOwner(db, args);
      signal.throwIfAborted();
      return;
    }
    case "stripe": {
      await reprojectStripeInvoicePaidAutomationsForOwner(db, args, signal);
      return;
    }
  }
  return args.target.connectorSlug satisfies never;
}
