import { createStore } from "ccstate";

import { renewGmailWatchScope$ } from "../signals/services/gmail-automation-event.service";
import { renewGoogleCalendarWatchScope$ } from "../signals/services/google-calendar-automation-event.service";
import { renewGoogleFormsWatchScope$ } from "../signals/services/google-forms-automation-event.service";
import { renewGoogleMeetSubscriptionScope$ } from "../signals/services/google-meet-automation-event.service";

interface GoogleRenewalOwner {
  readonly orgId: string;
  readonly userId: string;
}

// These are finite, test-owned invocations of the real renewal workers. They
// replace test HTTP transport without running a global cron over other tests.
export async function renewGmailWatchForTest(
  emailAddress: string,
  topicName: string,
  signal: AbortSignal,
) {
  return await createStore().set(
    renewGmailWatchScope$,
    emailAddress,
    topicName,
    signal,
  );
}

export async function renewGoogleCalendarWatchForTest(
  owner: GoogleRenewalOwner,
  signal: AbortSignal,
) {
  return await createStore().set(renewGoogleCalendarWatchScope$, owner, signal);
}

export async function renewGoogleFormsWatchForTest(
  owner: GoogleRenewalOwner,
  signal: AbortSignal,
) {
  return await createStore().set(renewGoogleFormsWatchScope$, owner, signal);
}

export async function renewGoogleMeetSubscriptionForTest(
  owner: GoogleRenewalOwner,
  signal: AbortSignal,
) {
  return await createStore().set(
    renewGoogleMeetSubscriptionScope$,
    owner,
    signal,
  );
}
