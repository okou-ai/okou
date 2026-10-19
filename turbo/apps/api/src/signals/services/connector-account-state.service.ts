import { gmailWatchStates } from "@okouai/db/schema/gmail-event";
import { googleCalendarWatchStates } from "@okouai/db/schema/google-calendar-event";
import { googleFormsWatchStates } from "@okouai/db/schema/google-forms-event";
import { googleWorkspaceEventSubscriptionStates } from "@okouai/db/schema/google-workspace-event";
import { mailDrafts } from "@okouai/db/schema/mail-draft";
import { and, eq } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { nowDate } from "../../lib/time";
import { gmailAutomationResolvedLabelInvalidationWrite } from "./gmail-automation-account.service";
import {
  notionPendingEventsReconnectScope,
  notionPendingEventsSkipWrite,
} from "./notion-automation-account.service";

/**
 * Reconciles account-bound state while keeping the logical connector row and
 * durable product configuration intact.
 */
export async function reconcileConnectorAccountState(
  db: Tx,
  args: {
    readonly connectorId: string;
    readonly previousPrincipalId: string | null;
    readonly nextPrincipalId: string;
    readonly previousEmail: string | null;
    readonly nextEmail: string | null;
  },
  signal: AbortSignal,
): Promise<void> {
  if (args.previousPrincipalId === args.nextPrincipalId) {
    if (args.nextEmail !== null && args.previousEmail !== args.nextEmail) {
      await db
        .update(gmailWatchStates)
        .set({ emailAddress: args.nextEmail, updatedAt: nowDate() })
        .where(eq(gmailWatchStates.connectorId, args.connectorId));
      signal.throwIfAborted();
      if (args.previousEmail !== null) {
        await db
          .update(googleCalendarWatchStates)
          .set({ needsRewatch: true, updatedAt: nowDate() })
          .where(
            and(
              eq(googleCalendarWatchStates.connectorId, args.connectorId),
              eq(googleCalendarWatchStates.calendarId, args.previousEmail),
            ),
          );
        signal.throwIfAborted();
      }
    }
    return;
  }

  const labelDb = db;
  const labelConnectorId = args.connectorId;
  await (async () => {
    const write =
      gmailAutomationResolvedLabelInvalidationWrite(labelConnectorId);
    await labelDb.update(write.table).set(write.values).where(write.where);
  })();
  signal.throwIfAborted();
  const pendingEventDb = db;
  const invalidatedConnectorId = args.connectorId;
  await (async () => {
    const scope = notionPendingEventsReconnectScope(invalidatedConnectorId);
    await (async () => {
      const write = notionPendingEventsSkipWrite(scope.condition, scope.reason);
      await pendingEventDb
        .update(write.table)
        .set(write.values)
        .where(write.where);
    })();
  })();
  signal.throwIfAborted();
  await db
    .delete(gmailWatchStates)
    .where(eq(gmailWatchStates.connectorId, args.connectorId));
  signal.throwIfAborted();
  await db
    .delete(googleCalendarWatchStates)
    .where(eq(googleCalendarWatchStates.connectorId, args.connectorId));
  signal.throwIfAborted();
  await db
    .delete(googleFormsWatchStates)
    .where(eq(googleFormsWatchStates.connectorId, args.connectorId));
  signal.throwIfAborted();
  await db
    .delete(googleWorkspaceEventSubscriptionStates)
    .where(
      eq(googleWorkspaceEventSubscriptionStates.connectorId, args.connectorId),
    );
  signal.throwIfAborted();
  await db
    .update(mailDrafts)
    .set({ connectorId: null })
    .where(eq(mailDrafts.connectorId, args.connectorId));
  signal.throwIfAborted();
}
