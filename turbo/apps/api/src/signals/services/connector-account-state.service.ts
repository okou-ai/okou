import { gmailWatchStates } from "@okouai/db/schema/gmail-event";
import { googleCalendarWatchStates } from "@okouai/db/schema/google-calendar-event";
import { googleFormsWatchStates } from "@okouai/db/schema/google-forms-event";
import { googleWorkspaceEventSubscriptionStates } from "@okouai/db/schema/google-workspace-event";
import { and, eq } from "drizzle-orm";

import { nowDate } from "../../lib/time";

export function connectorAccountEmailWrite(
  connectorId: string,
  emailAddress: string,
) {
  return {
    table: gmailWatchStates,
    values: { emailAddress, updatedAt: nowDate() },
    where: eq(gmailWatchStates.connectorId, connectorId),
  };
}

export function connectorAccountRewatchWrite(
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
export const connectorAccountPrincipalWatchTables = [
  gmailWatchStates,
  googleCalendarWatchStates,
  googleFormsWatchStates,
  googleWorkspaceEventSubscriptionStates,
] as const;
