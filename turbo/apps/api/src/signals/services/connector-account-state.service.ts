import { gmailWatchStates } from "@okouai/db/schema/gmail-event";
import { googleCalendarWatchStates } from "@okouai/db/schema/google-calendar-event";
import { googleFormsWatchStates } from "@okouai/db/schema/google-forms-event";
import { googleWorkspaceEventSubscriptionStates } from "@okouai/db/schema/google-workspace-event";
import { mailDrafts } from "@okouai/db/schema/mail-draft";
import { and, eq } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { gmailAutomationResolvedLabelInvalidationWrite } from "./gmail-automation-account.service";
import {
  notionPendingEventsReconnectScope,
  notionPendingEventsSkipWrite,
} from "./notion-automation-account.service";

function connectorAccountEmailWrite(connectorId: string, emailAddress: string) {
  return {
    table: gmailWatchStates,
    values: { emailAddress, updatedAt: nowDate() },
    where: eq(gmailWatchStates.connectorId, connectorId),
  };
}

function connectorAccountRewatchWrite(
  connectorId: string,
  previousEmail: string,
) {
  return {
    table: googleCalendarWatchStates,
    values: { needsRewatch: true, updatedAt: nowDate() },
    where: connectorAccountEmailWhere(connectorId, previousEmail),
  };
}

export function connectorAccountReconciliationIdentity(
  previous: {
    readonly id: string;
    readonly externalId: string | null;
    readonly externalEmail: string | null;
  },
  next: { readonly id: string; readonly email: string | null },
) {
  return {
    connectorId: previous.id,
    previousPrincipalId: previous.externalId,
    nextPrincipalId: next.id,
    previousEmail: previous.externalEmail,
    nextEmail: next.email,
  };
}

function connectorAccountEmailWhere(
  connectorId: string,
  previousEmail: string,
) {
  return and(
    eq(googleCalendarWatchStates.connectorId, connectorId),
    eq(googleCalendarWatchStates.calendarId, previousEmail),
  );
}

// Keep principal-change cleanup sequential in this order at the write owner.
const connectorAccountPrincipalWatchTables = [
  gmailWatchStates,
  googleCalendarWatchStates,
  googleFormsWatchStates,
  googleWorkspaceEventSubscriptionStates,
] as const;

export function* connectorAccountReconciliationWrites(
  ref: ReturnType<typeof connectorAccountReconciliationIdentity>,
) {
  if (ref.previousPrincipalId === ref.nextPrincipalId) {
    if (ref.nextEmail !== null && ref.previousEmail !== ref.nextEmail) {
      yield {
        kind: "email" as const,
        ...connectorAccountEmailWrite(ref.connectorId, ref.nextEmail),
      };
      if (ref.previousEmail !== null) {
        yield {
          kind: "rewatch" as const,
          ...connectorAccountRewatchWrite(ref.connectorId, ref.previousEmail),
        };
      }
    }
    return;
  }
  yield {
    kind: "gmail" as const,
    ...gmailAutomationResolvedLabelInvalidationWrite(ref.connectorId),
  };
  const scope = notionPendingEventsReconnectScope(ref.connectorId);
  yield {
    kind: "notion" as const,
    ...notionPendingEventsSkipWrite(scope.condition, scope.reason),
  };
  for (const table of connectorAccountPrincipalWatchTables) {
    yield {
      kind: "delete" as const,
      table,
      where: eq(table.connectorId, ref.connectorId),
    };
  }
  yield {
    kind: "drafts" as const,
    table: mailDrafts,
    values: { connectorId: null },
    where: eq(mailDrafts.connectorId, ref.connectorId),
  };
}
