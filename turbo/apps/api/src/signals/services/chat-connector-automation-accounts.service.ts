import { command } from "ccstate";

import { bestEffort } from "../utils";
import type { ConnectorAccessOwner } from "./connector-access-owner";
import {
  reconcileGmailWatchesForUser$,
  repairGmailAutomationProjections$,
} from "./gmail-automation-watch.service";
import {
  reconcileGoogleCalendarWatchesForUser$,
  repairGoogleCalendarAutomationProjections$,
} from "./google-calendar-automation-watch.service";
import {
  reconcileGoogleFormsWatchesForUser$,
  reprojectGoogleFormsAutomationOwnership$,
} from "./google-forms-automation-watch.service";
import {
  reconcileGoogleMeetSubscriptionsForUser$,
  repairGoogleMeetAutomationAccountProjectionsForOwner$,
} from "./google-meet-automation-watch.service";
import { repairNotionAutomationAccountProjectionsForOwner$ } from "./notion-automation-event.service";

/** Persist listener accounts before attempting best-effort provider watch changes. */
export const synchronizeChatConnectorAutomationAccounts$ = command(
  async (
    { set },
    owner: ConnectorAccessOwner,
    signal: AbortSignal,
  ): Promise<void> => {
    if (owner.target.kind !== "builtin") {
      return;
    }
    const scope = { orgId: owner.orgId, userId: owner.userId };
    switch (owner.target.connectorSlug) {
      case "gmail": {
        await set(repairGmailAutomationProjections$, scope, signal);
        await bestEffort(
          set(reconcileGmailWatchesForUser$, scope, signal),
          signal,
        );
        return;
      }
      case "google-calendar": {
        await set(repairGoogleCalendarAutomationProjections$, scope);
        signal.throwIfAborted();
        await bestEffort(
          set(reconcileGoogleCalendarWatchesForUser$, scope, signal),
          signal,
        );
        return;
      }
      case "google-forms": {
        await set(reprojectGoogleFormsAutomationOwnership$, scope, signal);
        await bestEffort(
          set(reconcileGoogleFormsWatchesForUser$, scope, signal),
          signal,
        );
        return;
      }
      case "google-meet": {
        await set(
          repairGoogleMeetAutomationAccountProjectionsForOwner$,
          scope,
          signal,
        );
        await bestEffort(
          set(reconcileGoogleMeetSubscriptionsForUser$, scope, signal),
          signal,
        );
        return;
      }
      case "notion": {
        await set(
          repairNotionAutomationAccountProjectionsForOwner$,
          scope,
          signal,
        );
        return;
      }
    }
  },
);
