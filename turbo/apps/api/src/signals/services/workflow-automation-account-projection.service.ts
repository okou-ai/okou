import type { ConnectorAccountTarget } from "@okouai/api-contracts/contracts/connector-accounts";

import type { Db } from "../external/db";
import { reprojectGmailAutomationsForOwner } from "./gmail-automation-account.service";
import { reprojectGoogleCalendarAutomationsForOwner } from "./google-calendar-automation-account.service";
import { googleFormsAccountProjectionStatement } from "./google-forms-automation-account.service";
import { reprojectGoogleMeetAutomationsForOwner } from "./google-meet-automation-account.service";
import { reprojectNotionAutomationsForOwner } from "./notion-automation-account.service";
import { reprojectStripeInvoicePaidAutomationsForOwner } from "./stripe-invoice-paid-workflow-automation.service";
import { isWorkflowAutomationAccountConnectorSlug } from "./workflow-automation-account-classification.service";

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
      await reprojectGoogleCalendarAutomationsForOwner(db, args);
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
