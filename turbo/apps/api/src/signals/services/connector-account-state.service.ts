import { gmailWatchStates } from "@okouai/db/schema/gmail-event";
import { googleCalendarWatchStates } from "@okouai/db/schema/google-calendar-event";
import { googleFormsWatchStates } from "@okouai/db/schema/google-forms-event";
import { googleWorkspaceEventSubscriptionStates } from "@okouai/db/schema/google-workspace-event";
import { and, eq } from "drizzle-orm";

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

export function connectorAccountEmailWhere(
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
